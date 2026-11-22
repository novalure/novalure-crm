import assert from 'node:assert/strict';
import { createHash, createHmac, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { Pool } from 'pg';
import { PDFDocument } from 'pdf-lib';
import { getRolePermissions } from '../src/lib/auth/permissions';
import type { AppSession } from '../src/lib/auth/session';
import { getProductRoleCapabilities } from '../src/lib/product-model';
import type { TenantPool } from '../src/lib/db/tenant-client';
import { CRM_MACHINE_AUDIENCE, CRM_MACHINE_ENVIRONMENT, CRM_MACHINE_ISSUER, CRM_MACHINE_OWNER_ID, CRM_MACHINE_PROJECT_ID,
  CRM_MACHINE_SUBJECT, CRM_MACHINE_WORKSPACE_ID, type CrmMachineAuthOptions } from '../src/lib/crm-machine-auth';
import { handleWebsiteSalesMachine, websiteSalesMachinePath } from '../src/lib/website-sales-machine';
import { registerWebsiteSalesMachineAccess } from '../src/lib/website-sales-machine-registration';
import { runWebsiteSalesIrelandCommand, websiteSalesIrelandContract } from '../src/lib/db/website-sales-ireland-repositories';
import { executeOfferCommand, getOfferWorkflow } from '../src/lib/db/offer-repositories';
import { executeWebsiteSalesCommerceCommand, readWebsiteSalesCommerce } from '../src/lib/db/website-sales-commerce-repositories';
import { createWebsiteSalesCommerceExecutor, type CommerceExecutionBinding } from '../src/lib/db/website-sales-commerce-outbox';
import { runWebsiteSalesCommerceWorker, recordCommerceResendEvent, reconcileWebsiteSalesCommerceProviderJob } from '../src/lib/website-sales-commerce-worker';
import { verifyResendWebhook } from '../src/lib/resend-webhooks';
import { commerceContentSha256, commerceDigest, commerceRecordReference } from '../src/lib/website-sales-commerce-domain';
import { validateWebsiteSalesCommerceRead } from '../src/lib/website-sales-commerce-read';
import { websiteSalesCommerceContract, type WebsiteSalesCommerceCommand, type WebsiteSalesCommerceRead } from '../src/lib/website-sales-commerce-types';
import { applySalesSchema, startLocalSalesDb } from './lib/local-sales-db.mjs';

type Scope = { tenantId: string; projectId: string; crmWorkspaceId: string; crmProjectId: string; companyId: string; locationId: string };
type Identity = { workloadId: string; grantId: string; departmentId: 'SALES'; agentId: string; taskId: string };
type Result = { contractVersion: string; persisted: true; commandId: string; correlationId: string; data: Record<string, unknown> };
type Runtime = { enqueue(target: 'autonomy', command: Record<string, unknown>): Promise<{ id: string }>; run(id: string): Promise<Result>;
  status(id: string): Promise<{ status: string } | null>; originalCommand(id: string): Promise<Record<string, unknown> | null> };
type Machine = { invoke(target: 'autonomy', operation: 'execute' | 'read' | 'reconcile', request: Record<string, unknown>): Promise<Record<string, unknown>> };
type QueryClient = { query(sql: string, params?: readonly unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }> };
type ExternalRuntime = {
  WebsiteSalesCommandCipher: new (active: string, keys: Map<string, Uint8Array>) => object;
  WebsiteSalesMachineTransport: new (options: { origin: string; workspaceId: string; environment: 'local'; identity: Identity;
    getWorkloadToken: () => Promise<string>; getDelegationPrivateKey: () => Promise<string> }) => Machine;
  WebsiteSalesRuntime: new (options: { scope: Scope; store: object; cipher: object; machine: Machine; environment: 'local' }) => Runtime;
};
type ExternalStore = { PostgresWebsiteSalesExecutionStore: new (transactions: { run<T>(scope: Scope, callback: (client: QueryClient) => Promise<T>): Promise<T> }) => object };
// This cross-repository acceptance is explicit, outside generic unit CI; a missing companion fails rather than skipping.
const source = process.env.EVELYN_WEBSITE_SALES_RUNTIME_SOURCE;
if (!source || !path.isAbsolute(source) || path.basename(source) !== 'website-sales-runtime.ts') throw new Error('EVELYN_WEBSITE_SALES_RUNTIME_SOURCE must name the real absolute Evelyn runtime source');
const evelynRoot = path.resolve(path.dirname(source), '../..');
const unknown = (error: unknown) => !!error && typeof error === 'object' && 'outcome' in error && error.outcome === 'UNKNOWN';

test('actual commerce bridge: Evelyn encrypted runtime → real Ed25519 → loopback HTTP → CRM authority and PostgreSQL', { timeout: 240000 }, async t => {
  const external = await import(pathToFileURL(source).href) as ExternalRuntime;
  const storage = await import(pathToFileURL(path.join(path.dirname(source), 'website-sales-execution-store.ts')).href) as ExternalStore;
  t.diagnostic(`Real runtime SHA256 ${createHash('sha256').update(await readFile(source)).digest('hex')}; synthetic OIDC verifier and local fixtures; actual Ed25519/HTTP/PostgreSQL; no real provider or commercial delivery`);
  const db = await startLocalSalesDb(); let server: Server | undefined, providerServer: Server | undefined, executionPool: Pool | undefined, commercePool: Pool | undefined;
  const ids = { actor: randomUUID(), readActor: randomUUID(), owner: randomUUID(), authSession: randomUUID(), project: randomUUID(), company: randomUUID(), contact: randomUUID(),
    pipeline: randomUUID(), workload: randomUUID(), grant: randomUUID(), readGrant: randomUUID(), effectOnlyGrant: randomUUID(), ingestGrant: randomUUID(), task: randomUUID() };
  const options = { pool: db.pool as unknown as TenantPool }, pair = generateKeyPairSync('ed25519'), commandKey = randomBytes(32), deploymentId = randomUUID();
  const agentId = 'evelyn.sales.commerce-connected';
  const oidc = (): CrmMachineAuthOptions => {
    const seconds = Math.floor(Date.now() / 1000);
    return { env: { NODE_ENV: 'production', VERCEL_ENV: 'production', CRM_MACHINE_AUTH_ENABLED: '1' }, verifier: async () => ({
      payload: { iss: CRM_MACHINE_ISSUER, aud: CRM_MACHINE_AUDIENCE, sub: CRM_MACHINE_SUBJECT, project_id: CRM_MACHINE_PROJECT_ID,
        owner_id: CRM_MACHINE_OWNER_ID, environment: CRM_MACHINE_ENVIRONMENT, iat: seconds - 5, nbf: seconds - 5, exp: seconds + 3600, jti: randomUUID() },
      protectedHeader: { alg: 'RS256', typ: 'JWT', kid: 'synthetic-connected-verifier' },
    }) } as CrmMachineAuthOptions;
  };
  try {
    await applySalesSchema(db, { maxMigrationNumber: 90 });
    for (const file of ['170_crm_personal_mailbox.sql', '202_website_sales_ireland.sql', '203_website_sales_machine.sql', '204_website_sales_studio.sql', '205_website_sales_lifecycle.sql', '206_website_sales_operations.sql', '207_website_sales_conversations.sql', '208_website_sales_enablement.sql', '209_website_sales_commerce.sql']) {
      await db.admin.query('begin');
      try { await db.admin.query(await readFile(`migrations/${file}`, 'utf8')); await db.admin.query('commit'); }
      catch (error) { await db.admin.query('rollback'); throw error; }
    }
    await db.admin.query("insert into workspaces(id,name,operating_model,customer_type,setup_state) values($1,'SYNTHETIC Commerce bridge','novalure_internal','novalure_internal',$2::jsonb) on conflict(id) do update set setup_state=excluded.setup_state", [CRM_MACHINE_WORKSPACE_ID, JSON.stringify({ salesApprovalUserId: ids.owner })]);
    await db.admin.query("insert into workspace_users(id,workspace_id,name,email,role,product_role,status) values($1,$2,'Synthetic registered commerce actor','synthetic-commerce-actor@example.invalid','agent','novalure_operator','active')", [ids.actor, CRM_MACHINE_WORKSPACE_ID]);
    await db.admin.query("insert into workspace_users(id,workspace_id,name,email,role,product_role,status) values($1,$2,'Synthetic read-only commerce actor','synthetic-commerce-reader@example.invalid','agent','novalure_operator','active')", [ids.readActor, CRM_MACHINE_WORKSPACE_ID]);
    const ownerRow = await db.admin.query("insert into workspace_users(id,workspace_id,name,email,role,product_role,status) values($1,$2,'Synthetic configured commerce owner','synthetic-commerce-owner@example.invalid','owner','novalure_operator','active') returning auth_identity_id", [ids.owner, CRM_MACHINE_WORKSPACE_ID]);
    const authIdentityId = String(ownerRow.rows[0].auth_identity_id);
    await db.admin.query("update auth_identities set credential_state='active' where id=$1", [authIdentityId]);
    await db.admin.query("insert into auth_sessions(id,token_hash,auth_identity_id,workspace_user_id,workspace_id,mfa_verified_at,expires_at) values($1,$2,$3,$4,$5,clock_timestamp(),clock_timestamp()+interval '1 hour')", [ids.authSession, createHash('sha256').update(randomUUID()).digest('hex'), authIdentityId, ids.owner, CRM_MACHINE_WORKSPACE_ID]);
    await db.admin.query("insert into projects(id,workspace_id,name,type,division) values($1,$2,'Synthetic Commerce project','Website','WEB_DESIGN')", [ids.project, CRM_MACHINE_WORKSPACE_ID]);
    await db.admin.query('insert into project_pipeline_permissions(workspace_id,project_id,user_id,can_read,can_edit_deals) values($1,$2,$3,true,true)', [CRM_MACHINE_WORKSPACE_ID, ids.project, ids.actor]);
    await db.admin.query('insert into project_pipeline_permissions(workspace_id,project_id,user_id,can_read,can_edit_deals) values($1,$2,$3,true,false)', [CRM_MACHINE_WORKSPACE_ID, ids.project, ids.readActor]);
    await db.admin.query("insert into crm_pipelines(id,workspace_id,project_id,key,name,purpose,is_default) values($1,$2,$3,'commerce-connected','Synthetic Commerce pipeline','novalure_internal',true)", [ids.pipeline, CRM_MACHINE_WORKSPACE_ID, ids.project]);
    await db.admin.query("insert into crm_pipeline_stages(pipeline_id,workspace_id,project_id,key,name,position,category) values($1,$2,$3,'qualify','Qualifizieren',0,'work')", [ids.pipeline, CRM_MACHINE_WORKSPACE_ID, ids.project]);
    await db.admin.query('update projects set default_pipeline_id=$2 where id=$1', [ids.project, ids.pipeline]);
    await db.admin.query("insert into organizations(id,workspace_id,project_id,name,type,division) values($1,$2,$3,'Synthetic Commerce company','Unternehmen','WEB_DESIGN')", [ids.company, CRM_MACHINE_WORKSPACE_ID, ids.project]);
    await db.admin.query("insert into contacts(id,workspace_id,project_id,organization_id,name,role,email,consent_label) values($1,$2,$3,$4,'Synthetic Commerce buyer','Ansprechpartner','synthetic-commerce@example.invalid','Opt-in')", [ids.contact, CRM_MACHINE_WORKSPACE_ID, ids.project, ids.company]);
    const owner: AppSession = { authenticated: true, source: 'database', userId: ids.owner, workspaceId: CRM_MACHINE_WORKSPACE_ID, workspaceName: 'SYNTHETIC Commerce bridge',
      name: 'Synthetic owner', email: 'synthetic-commerce-owner@example.invalid', role: 'owner', productRole: 'novalure_operator', permissions: getRolePermissions('owner'),
      productPermissions: getProductRoleCapabilities('novalure_operator'), authSessionId: ids.authSession, authIdentityId, sessionCreatedAt: new Date() };
    const common = { projectId: ids.project, companyId: ids.company };
    const registered = await runWebsiteSalesIrelandCommand(owner, { contractVersion: websiteSalesIrelandContract, operation: 'register_location', ...common,
      idempotencyKey: randomUUID(), correlationId: randomUUID(), payload: { countryCode: 'IE', address: 'Synthetic Commerce 1, Dublin, Ireland', sourceUrl: 'https://example.invalid/commerce', sourceReference: 'Synthetic fixture only' } }, options);
    const locationId = registered.data.location.id, identity = { workspaceId: CRM_MACHINE_WORKSPACE_ID, ...common, locationId };
    const observed = await runWebsiteSalesIrelandCommand(owner, { contractVersion: websiteSalesIrelandContract, operation: 'observe', ...common, locationId, locationVersion: 1,
      idempotencyKey: randomUUID(), correlationId: randomUUID(), payload: { prospect: { identity, country: 'IRELAND', identityStatus: 'VERIFIED', domain: null, path: 'NO_WEBSITE', ownWebsiteSearch: 'NONE_FOUND', obstacle: null,
        platformUrl: null, bookingRoute: 'UNKNOWN', need: 'EVIDENCED', evidence: ['IDENTITY', 'OWN_WEBSITE_SEARCH', 'BUSINESS_NEED'].map(kind => ({ identity, kind, evidenceId: kind.toLowerCase(), sourceUrl: `https://example.invalid/commerce/${kind}`,
          observedAt: new Date(Date.now() - 60000).toISOString(), validUntil: new Date(Date.now() + 86400000).toISOString(), finding: 'SYNTHETIC evidence only', validityCondition: 'SYNTHETIC controlled fixture', confidence: 0.9 })) } } }, options);
    const qualified = await runWebsiteSalesIrelandCommand(owner, { contractVersion: websiteSalesIrelandContract, operation: 'qualify', ...common, locationId, expectedVersion: observed.data.workflow!.version,
      idempotencyKey: randomUUID(), correlationId: randomUUID(), payload: { contactId: ids.contact, opportunitySummary: 'Synthetic Commerce bridge', nextAction: 'Synthetic internal review', expectedEvidenceDigest: observed.data.workflow!.evidenceDigest } }, options);
    const content = { subject: 'SYNTHETIC website offer', recipientName: 'Synthetic Commerce buyer', recipientEmail: 'synthetic-commerce@example.invalid', scope: 'Synthetic information website', paymentPlan: 'Synthetic deposit', discounts: 'None', specialTerms: 'None', riskComplianceNotes: 'Synthetic local fixture; no real delivery', terms: 'Synthetic terms only',
      validUntil: new Date(Date.now() + 86400000).toISOString(), currency: 'EUR', taxBasis: 'NET', items: [{ description: 'Synthetic website', quantity: 1, unitNetCents: 10000 }] };
    const prepared = await runWebsiteSalesIrelandCommand(owner, { contractVersion: websiteSalesIrelandContract, operation: 'prepare_offer', ...common, locationId, expectedVersion: qualified.data.workflow!.version,
      idempotencyKey: randomUUID(), correlationId: randomUUID(), payload: { content, expectedEvidenceDigest: qualified.data.workflow!.evidenceDigest } }, options);
    const workflowId = prepared.data.workflow!.id, workflowVersion = prepared.data.workflow!.version, dealId = prepared.data.workflow!.dealId!;
    const native = (await getOfferWorkflow(owner, dealId, options)).offer!;
    await executeOfferCommand(owner, { operation: 'approve', projectId: ids.project, dealId, offerId: native.id, expectedVersion: native.version, idempotencyKey: randomUUID(), correlationId: randomUUID(),
      payload: { revision: native.revision, contentDigest: native.contentDigest, expiresAt: new Date(Date.now() + 3600000).toISOString() } }, options);
    // Register exact server-owned scopes with the same no-BYPASS administrative pattern as the existing bridge suite.
    await db.admin.query('create role commerce_connected_registrar nologin nosuperuser nocreatedb nocreaterole noreplication nobypassrls');
    for (const table of ['crm_website_sales_machine_workloads', 'crm_website_sales_machine_grants']) {
      await db.admin.query(`alter table ${table} owner to commerce_connected_registrar`);
      await db.admin.query(`create policy commerce_connected_registrar_owner on ${table} for all to commerce_connected_registrar using(true) with check(true)`);
    }
    await db.admin.query('grant usage on schema public to commerce_connected_registrar; grant execute on function crm_lock_website_sales_machine_grant(uuid,uuid) to commerce_connected_registrar');
    const registrar = await db.admin.connect();
    try {
      await registrar.query('set role commerce_connected_registrar');
      for (const grantId of [ids.grant, ids.readGrant, ids.effectOnlyGrant, ids.ingestGrant]) await registerWebsiteSalesMachineAccess(registrar, { workloadId: ids.workload, workloadActorId: ids.actor, grantId, actorId: grantId === ids.readGrant ? ids.readActor : ids.actor,
        projectId: ids.project, companyId: ids.company, locationId, departmentId: 'SALES', agentId, taskId: ids.task,
        scopes: grantId === ids.ingestGrant ? ['crm.website-sales.commerce.read', 'crm.website-sales.commerce.ingest-source']
          : [...(grantId === ids.effectOnlyGrant ? [] : ['crm.website-sales.commerce.read' as const]), ...(grantId === ids.readGrant ? [] : ['crm.website-sales.commerce.prepare-contract' as const, 'crm.website-sales.commerce.queue-offer-delivery' as const,
            'crm.website-sales.commerce.request-signature' as const, 'crm.website-sales.commerce.prepare-invoice-request' as const, 'crm.website-sales.commerce.reconcile' as const])],
        publicKey: pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url'), authorityReference: 'SYNTHETIC local connected grant', expiresAt: null });
    } finally { await registrar.query('reset role'); registrar.release(); }
    for (const role of ['evelyn_prod_owner', 'evelyn_prod_migration', 'evelyn_prod_recovery']) await db.admin.query(`create role ${role} nologin nosuperuser nocreatedb nocreaterole noreplication nobypassrls`);
    await db.admin.query('alter role evelyn_prod_recovery noinherit; create role evelyn_prod_runtime login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls');
    await db.admin.query("do $$ begin if not exists(select 1 from pg_roles where rolname='neon_superuser') then create role neon_superuser nologin nosuperuser nocreatedb nocreaterole noreplication nobypassrls;end if;end $$");
    await db.admin.query('grant create on database postgres to evelyn_prod_owner; grant evelyn_prod_owner to evelyn_prod_migration; grant evelyn_prod_migration to qa_admin');
    for (const file of ['migrations/production/001_foundation.sql', 'migrations/sales/001_website_sales_execution.sql', 'migrations/sales/002_website_sales_operations_target.sql']) await db.admin.query(await readFile(path.join(evelynRoot, file), 'utf8'));
    const scope: Scope = { tenantId: randomUUID(), projectId: randomUUID(), crmWorkspaceId: CRM_MACHINE_WORKSPACE_ID, crmProjectId: ids.project, companyId: ids.company, locationId };
    assert.notEqual(scope.tenantId, scope.crmWorkspaceId); assert.notEqual(scope.projectId, scope.crmProjectId);
    await db.admin.query("insert into evelyn_prod.runtime_scope(runtime_role,tenant_id,project_id,deployment_id,synthetic) values('evelyn_prod_runtime',$1,$2,$3,true)", [scope.tenantId, scope.projectId, deploymentId]);
    await db.admin.query("insert into evelyn_prod.website_sales_runtime_bindings(binding_id,runtime_role,tenant_id,project_id,crm_workspace_id,crm_project_id,company_id,location_id,deployment_id,authority_reference,enabled,expires_at) values($1,'evelyn_prod_runtime',$2,$3,$4,$5,$6,$7,$8,'SYNTHETIC Commerce bridge',true,clock_timestamp()+interval '10 minutes')", [randomUUID(), scope.tenantId, scope.projectId, scope.crmWorkspaceId, scope.crmProjectId, scope.companyId, scope.locationId, deploymentId]);
    executionPool = new Pool({ host: '127.0.0.1', port: db.port, user: 'evelyn_prod_runtime', database: 'postgres', max: 4 });
    const transactions = { async run<T>(selected: Scope, callback: (client: QueryClient) => Promise<T>): Promise<T> {
      const client = await executionPool!.connect();
      try { await client.query('begin'); await client.query('set local search_path=pg_catalog,evelyn_prod'); await client.query("select set_config('evelyn.tenant_id',$1,true),set_config('evelyn.project_id',$2,true)", [selected.tenantId, selected.projectId]);
        const value = await callback(client as unknown as QueryClient); await client.query('commit'); return value;
      } catch (error) { await client.query('rollback'); throw error; } finally { client.release(); }
    } };
    let origin = '', loseNext = false, corrupt: 'receipt' | 'nested' | null = null; const calls: string[] = [], serverErrors: string[] = [];
    server = createServer((incoming, outgoing) => { void (async () => {
      try {
        if (incoming.method !== 'POST' || incoming.url !== websiteSalesMachinePath) { outgoing.writeHead(404).end(); return; }
        const chunks: Buffer[] = []; let size = 0;
        for await (const chunk of incoming) { const bytes = Buffer.from(chunk); size += bytes.byteLength; if (size > 131072) { outgoing.writeHead(413).end(); return; } chunks.push(bytes); }
        const body = Buffer.concat(chunks), envelope = JSON.parse(body.toString('utf8')) as { target: string; operation: string };
        calls.push(envelope.operation); const headers = new Headers(); for (const [key, value] of Object.entries(incoming.headers)) if (typeof value === 'string') headers.set(key, value);
        const response = await handleWebsiteSalesMachine(new Request(origin + websiteSalesMachinePath, { method: 'POST', headers, body }), { ...options, machineAuth: oidc() });
        const raw = await response.text();
        if (loseNext && envelope.operation === 'execute' && response.ok) { loseNext = false; outgoing.destroy(); return; }
        const projected = JSON.parse(raw) as { receipt?: { data: { identity: { companyId: string } } }; currentData?: { templates: { identity: { companyId: string } }[] } };
        if (corrupt && response.ok && envelope.operation === 'reconcile') {
          if (corrupt === 'receipt') projected.receipt!.data.identity.companyId = randomUUID(); else projected.currentData!.templates[0]!.identity.companyId = randomUUID(); corrupt = null;
        }
        outgoing.writeHead(response.status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); outgoing.end(JSON.stringify(projected));
      } catch (error) { serverErrors.push(error instanceof Error ? error.name : 'UNKNOWN'); outgoing.writeHead(503).end(); }
    })(); });
    await new Promise<void>((resolve, reject) => { server!.once('error', reject); server!.listen(0, '127.0.0.1', resolve); });
    const address = server.address(); assert(address && typeof address !== 'string'); origin = `http://127.0.0.1:${address.port}`;
    const machineIdentity = (grantId: string): Identity => ({ workloadId: ids.workload, grantId, departmentId: 'SALES', agentId, taskId: ids.task });
    const freshMachine = (grantId = ids.grant) => new external.WebsiteSalesMachineTransport({ origin, workspaceId: scope.crmWorkspaceId, environment: 'local', identity: machineIdentity(grantId),
      getWorkloadToken: async () => `eyJ${'a'.repeat(20)}.${'b'.repeat(24)}.${'c'.repeat(24)}`, getDelegationPrivateKey: async () => pair.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString() });
    const freshRuntime = (grantId = ids.grant) => new external.WebsiteSalesRuntime({ scope, store: new storage.PostgresWebsiteSalesExecutionStore(transactions),
      cipher: new external.WebsiteSalesCommandCipher('commerce-connected-v1', new Map([['commerce-connected-v1', commandKey]])), machine: freshMachine(grantId), environment: 'local' });
    const bound = { ...common, locationId, workflowId };
    const freshRead = async (grantId = ids.grant) => { const value = await freshMachine(grantId).invoke('autonomy', 'read', { ...bound, view: 'commerce', correlationId: randomUUID() }); return validateWebsiteSalesCommerceRead(value.data, identity, workflowId); };
    const command = (view: WebsiteSalesCommerceRead, operation: WebsiteSalesCommerceCommand['operation'], payload: Record<string, unknown>): WebsiteSalesCommerceCommand => ({ contractVersion: websiteSalesCommerceContract, ...bound, operation,
      expectedVersion: view.version, expectedWorkflowVersion: view.workflowVersion, payload, idempotencyKey: randomUUID(), correlationId: randomUUID() });
    const counts = async () => (await db.admin.query('select (select count(*)::int from crm_website_sales_commerce_records) as records,(select count(*)::int from crm_website_sales_commerce_jobs) as jobs,(select count(*)::int from crm_offer_deliveries) as deliveries,(select count(*)::int from crm_command_receipts) as receipts')).rows[0];
    const now = Date.now(), sourceRef = { reference: 'operator-recorded:SYNTHETIC policy source', digest: 'a'.repeat(64), observedAt: new Date(now - 60000).toISOString(), validUntil: new Date(now + 3600000).toISOString() };
    let view = await readWebsiteSalesCommerce(owner, bound, options);
    const templateText = 'SYNTHETIC TEMPLATE ONLY: {{CUSTOMER_NAME}}';
    await executeWebsiteSalesCommerceCommand(owner, command(view, 'register_template', { title: 'Synthetic reviewed fixture', jurisdiction: 'SYNTHETIC LOCAL TEST', language: 'en', content: templateText,
      contentSha256: commerceContentSha256(templateText), allowedVariableKeys: ['CUSTOMER_NAME'], legalReviewReference: sourceRef, validUntil: sourceRef.validUntil }), options);
    view = await readWebsiteSalesCommerce(owner, bound, options); const choice = view.offerChoices[0]!; assert(choice);
    await executeWebsiteSalesCommerceCommand(owner, command(view, 'configure_policy', { title: 'Synthetic sourced tax and installment fixture', standardTermsReference: sourceRef, standardTermsDigest: 'a'.repeat(64), signatureAssurance: 'PROVIDER_ATTESTED', maxInstallments: 1,
      accountingEntityReference: 'synthetic-accounting-entity', accountingCustomerReference: 'synthetic-accounting-customer-1', accountingSourceReference: sourceRef, accountingProfile: { issuerLegalName: 'Synthetic issuer', issuerAddress: 'Synthetic street 1', taxIdentifier: null, currency: 'EUR', taxRateBps: 2300, rounding: 'HALF_UP', sourceReference: sourceRef },
      offerRef: choice.offerRef, financialSnapshot: { currency: 'EUR', netMinor: 10000, taxMinor: 2300, grossMinor: 12300, taxReference: sourceRef, termsDigest: 'a'.repeat(64) },
      paymentTerms: { installments: [{ installmentId: randomUUID(), label: 'Synthetic deposit', percentageBps: 10000, dueOffsetDays: 3, anchor: 'CONTRACT_SIGNED', kind: 'DEPOSIT' }] }, validUntil: sourceRef.validUntil }), options);
    view = await freshRead(); const approved = view.offers[0]!; assert(approved?.payload.approvalReference);
    const queue = command(view, 'queue_offer_delivery', { offerRef: approved.payload.offerRef, approvalReference: approved.payload.approvalReference });
    assert.equal(workflowVersion, view.workflowVersion);
    await t.test('explicit signed commerce read is exact-scoped and read-only grants cannot execute or disclose effect receipts', async () => {
      const readonly = await freshRead(ids.readGrant); assert.equal(readonly.canWrite, false); assert.equal(readonly.canApproveFacts, false); assert.equal(readonly.canApproveContract, false); assert.equal(readonly.canContact, false);
      assert.equal(readonly.policy?.payload.accountingProfile.taxRateBps, 2300);
      await assert.rejects(freshMachine(ids.effectOnlyGrant).invoke('autonomy', 'read', { ...bound, view: 'commerce', correlationId: randomUUID() }), /SALES_HTTP_403/);
      for (const key of ['projectId', 'companyId', 'locationId', 'workflowId'] as const) await assert.rejects(freshMachine().invoke('autonomy', 'read', { ...bound, [key]: randomUUID(), view: 'commerce', correlationId: randomUUID() }), /SALES_HTTP_403/);
      const before = await counts(); await assert.rejects(freshMachine(ids.readGrant).invoke('autonomy', 'execute', queue), /SALES_HTTP_403/); assert.deepEqual(await counts(), before);
      await assert.rejects(freshRuntime().enqueue('autonomy', command(view, 'register_template', view.templates[0]!.payload)), /SALES_COMMERCE_OWNER_ACTION_DENIED/);
    });
    await t.test('independent aggregate and workflow CAS reject before canonical delivery or commerce job writes', async () => {
      const before = await counts();
      for (const change of [{ expectedVersion: queue.expectedVersion - 1 }, { expectedWorkflowVersion: queue.expectedWorkflowVersion - 1 }]) {
        const runtime = freshRuntime(), record = await runtime.enqueue('autonomy', { ...queue, ...change, idempotencyKey: randomUUID(), correlationId: randomUUID() });
        await assert.rejects(runtime.run(record.id), /SALES_HTTP_409/); assert.deepEqual(await counts(), before);
      }
    });
    let recovered: Result;
    await t.test('lost committed ACK cold-reconciles one approved canonical queue and one durable outbox job with the same immutable original', async () => {
      const runtime = freshRuntime(), record = await runtime.enqueue('autonomy', queue); loseNext = true;
      await assert.rejects(runtime.run(record.id), unknown); assert.equal(loseNext, false); assert.equal((await runtime.status(record.id))?.status, 'UNKNOWN');
      const committed = await counts(); assert.equal(committed.jobs, 1); assert.equal(committed.deliveries, 1);
      assert.equal((await getOfferWorkflow(owner, dealId, options)).offer?.status, 'QUEUED');
      assert.deepEqual(await freshRuntime().originalCommand(record.id), queue);
      recovered = await freshRuntime().run(record.id); assert.equal(recovered.persisted, true); assert.equal(recovered.contractVersion, websiteSalesCommerceContract); assert.equal(recovered.correlationId, queue.correlationId);
      assert.equal((await freshRuntime().status(record.id))?.status, 'COMMITTED'); assert.deepEqual(await counts(), committed);
      assert.equal((await freshRuntime().run(record.id)).commandId, recovered.commandId); assert.deepEqual(await counts(), committed);
      assert.deepEqual(calls.slice(-3), ['execute', 'reconcile', 'reconcile']);
      const encrypted = (await db.admin.query('select encrypted_request,encrypted_result from evelyn_prod.website_sales_execution where operation_id=$1', [record.id])).rows[0];
      assert(!JSON.stringify(encrypted).includes('SYNTHETIC')); assert(!JSON.stringify(encrypted).includes('synthetic-commerce@example.invalid'));
      await assert.rejects(freshMachine().invoke('autonomy', 'execute', { ...queue, payload: { ...queue.payload, approvalReference: randomUUID() } }), /SALES_HTTP_409/); assert.deepEqual(await counts(), committed);
    });
    await db.admin.query('create role commerce_connected_executor login inherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls');
    await db.admin.query('grant novalure_website_sales_commerce_executor to commerce_connected_executor');
    commercePool = new Pool({ host: '127.0.0.1', port: db.port, user: 'commerce_connected_executor', database: 'postgres', max: 4 });
    const executorBinding: CommerceExecutionBinding = { ...bound, workspaceId: identity.workspaceId, actorId: ids.actor, workloadId: ids.workload, grantId: ids.grant,
      allowedKinds: ['OFFER_SEND', 'CONTRACT_SEND', 'SIGNATURE_REQUEST', 'ACCOUNTING_INVOICE_REQUEST', 'SUBSCRIPTION_CHANGE'], expiresAt: Date.now() + 600000, authorityReference: 'SYNTHETIC loopback worker only' };
    const executor = createWebsiteSalesCommerceExecutor({ pool: commercePool as unknown as TenantPool, assertCurrent: async () => executorBinding });
    const sourceExecutor = createWebsiteSalesCommerceExecutor({ pool: commercePool as unknown as TenantPool, assertCurrent: async () => ({ ...executorBinding, grantId: ids.ingestGrant }) });
    const signedPdf = await PDFDocument.create(); signedPdf.addPage().drawText('SYNTHETIC LOCAL DOCUMENT - NO REAL CUSTOMER SIGNATURE'); const signedPdfBytes = await signedPdf.save();
    const auditPdf = await PDFDocument.create(); auditPdf.addPage().drawText('SYNTHETIC LOCAL PROVIDER AUDIT'); const auditPdfBytes = await auditPdf.save();
    const providerCalls: { path: string; method: string; auth: boolean }[] = [];
    let acceptedMail: Record<string, unknown> | null = null, signatureRequest: Record<string, unknown> | null = null, signatureComplete = false, signatureCompletedAt: string | null = null, badSignatureBinding = false;
    const providerMailId = randomUUID(), providerSignatureId = 12345;
    providerServer = createServer((incoming, outgoing) => { void (async () => {
      const chunks: Buffer[] = []; for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
      providerCalls.push({ path: incoming.url!, method: incoming.method!, auth: !!incoming.headers['x-auth-token'] });
      if (incoming.method === 'POST' && incoming.url === '/emails') { acceptedMail = JSON.parse(Buffer.concat(chunks).toString('utf8')); outgoing.destroy(); return; }
      if (incoming.method === 'GET' && incoming.url === `/emails/${providerMailId}` && acceptedMail) {
        outgoing.writeHead(200, { 'Content-Type': 'application/json' }); outgoing.end(JSON.stringify({ id: providerMailId, to: acceptedMail.to, from: acceptedMail.from, subject: acceptedMail.subject, text: acceptedMail.text, last_event: 'delivered' })); return;
      }
      if (incoming.method === 'POST' && incoming.url === '/submissions/html') signatureRequest = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (incoming.url === '/file/synthetic-signed.pdf' || incoming.url === '/file/synthetic-audit.pdf') {
        outgoing.writeHead(200, { 'Content-Type': 'application/pdf' }); outgoing.end(incoming.url.includes('signed') ? signedPdfBytes : auditPdfBytes); return;
      }
      if ((incoming.method === 'POST' && incoming.url === '/submissions/html' || incoming.method === 'GET' && incoming.url === `/submissions/${providerSignatureId}`) && signatureRequest) {
        const party = (signatureRequest.submitters as { role: string; email: string; external_id: string; metadata: Record<string, unknown> }[])[0]!, timestamp = signatureCompletedAt ?? new Date().toISOString();
        outgoing.writeHead(200, { 'Content-Type': 'application/json' }); outgoing.end(JSON.stringify({ id: providerSignatureId, status: signatureComplete ? 'completed' : 'pending', expire_at: signatureRequest.expire_at,
          updated_at: timestamp, completed_at: signatureComplete ? timestamp : null, archived_at: null,
          submitters: [{ id: 67890, ...party, metadata: { ...party.metadata, ...(badSignatureBinding ? { document_sha256: 'f'.repeat(64) } : {}) }, status: signatureComplete ? 'completed' : 'sent', completed_at: signatureComplete ? timestamp : null }],
          ...(signatureComplete ? { documents: [{ name: 'Synthetic.pdf', url: 'https://docuseal.com/file/synthetic-signed.pdf' }], audit_log_url: 'https://docuseal.com/file/synthetic-audit.pdf' } : {}) })); return;
      }
      outgoing.writeHead(404).end();
    })().catch(() => outgoing.writeHead(500).end()); });
    await new Promise<void>((resolve, reject) => { providerServer!.once('error', reject); providerServer!.listen(0, '127.0.0.1', resolve); });
    const providerAddress = providerServer.address(); assert(providerAddress && typeof providerAddress !== 'string');
    const transport = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input.toString()); assert.equal(url.protocol, 'https:'); assert(['api.resend.com', 'api.docuseal.com', 'docuseal.com'].includes(url.hostname));
      return fetch(`http://127.0.0.1:${providerAddress.port}${url.pathname}${url.search}`, init);
    }) as typeof fetch;
    const worker = { executor, sourceExecutor, accounts: { resend: 'synthetic-resend-account', docuseal: 'synthetic-docuseal-account' },
      mail: { apiKey: 'synthetic-local-key', from: 'hello@novalure.eu', transport }, signature: { apiKey: 'synthetic-local-key', htmlCapabilityApproved: true, transport } };
    await t.test('actual worker loses a provider-accepted mail ACK, then real Svix verification and provider GET recover one source without another send', async () => {
      const first = await runWebsiteSalesCommerceWorker(worker, 1); assert(first.results.some(row => row.status === 'UNKNOWN')); assert(acceptedMail);
      assert.equal(providerCalls.filter(row => row.method === 'POST').length, 1);
      assert.equal((await db.admin.query('select status from crm_website_sales_commerce_jobs where id=$1', [recovered!.data.outboxId])).rows[0].status, 'UNKNOWN');
      await runWebsiteSalesCommerceWorker(worker, 1); assert.equal(providerCalls.filter(row => row.method === 'POST').length, 1, 'UNKNOWN never repeats the provider send');
      const key = randomBytes(32), eventId = `msg_${randomUUID().replaceAll('-', '')}`, stamp = String(Math.floor(Date.now() / 1000));
      const raw = JSON.stringify({ type: 'email.delivered', created_at: new Date().toISOString(), data: { email_id: providerMailId, to: acceptedMail.to, from: acceptedMail.from, tags: acceptedMail.tags } });
      const headers = new Headers({ 'svix-id': eventId, 'svix-timestamp': stamp, 'svix-signature': 'v1,' + createHmac('sha256', key).update(`${eventId}.${stamp}.${raw}`).digest('base64') });
      assert.throws(() => verifyResendWebhook(raw + ' ', headers, { secret: 'whsec_' + key.toString('base64') }), /invalid_signature/);
      const event = verifyResendWebhook(raw, headers, { secret: 'whsec_' + key.toString('base64') }); assert(event); assert.equal(event.reference?.kind, 'sales_commerce');
      const recorded = await recordCommerceResendEvent(worker, event); assert.equal(recorded.status, 'RECORDED');
      assert.equal((await getOfferWorkflow(owner, dealId, options)).offer?.status, 'SENT');
      const count = (await db.admin.query('select count(*)::int n from crm_website_sales_commerce_sources')).rows[0].n;
      await recordCommerceResendEvent(worker, event); assert.equal((await db.admin.query('select count(*)::int n from crm_website_sales_commerce_sources')).rows[0].n, count);
      assert.equal(providerCalls.filter(row => row.method === 'POST').length, 1);
      const current = await freshRead(); assert(current.sourceEvents.some(row => row.kind === 'PROVIDER_DELIVERY' && row.payload.status === 'DELIVERED'));
    });
    let contractReference: ReturnType<typeof commerceRecordReference>, signatureJobId: string;
    await t.test('real Evelyn commerce commands persist the reviewed full contract and a separately fresh-MFA-approved signature request', async () => {
      let current = await freshRead(); const input = command(current, 'prepare_contract', { offerRef: current.offers[0]!.payload.offerRef, templateRef: commerceRecordReference(current.templates[0]!), policyRef: commerceRecordReference(current.policy!) });
      const runtime = freshRuntime(), queued = await runtime.enqueue('autonomy', input); await runtime.run(queued.id);
      current = await readWebsiteSalesCommerce(owner, bound, options); const contract = current.contracts[0]!; assert(contract.payload.body.includes('Net amount: 100.00 EUR')); contractReference = commerceRecordReference(contract);
      await executeWebsiteSalesCommerceCommand(owner, command(current, 'request_contract_approval', { documentRef: contractReference }), options);
      current = await readWebsiteSalesCommerce(owner, bound, options); const approval = current.approvals.find(row => row.documentRef.id === contract.id)!; assert(approval.currentChallenge);
      await executeWebsiteSalesCommerceCommand(owner, command(current, 'approve_contract_step', { approvalId: approval.approvalId, documentRef: contractReference, challengeId: approval.currentChallenge.challengeId, stepNumber: approval.currentChallenge.stepNumber }), options);
      current = await freshRead(); assert.equal(current.approvals.find(row => row.approvalId === approval.approvalId)?.status, 'APPROVED');
      const request = command(current, 'request_signature', { documentRef: contractReference, approvalReference: approval.approvalId });
      const stage = await freshRuntime().enqueue('autonomy', request), result = await freshRuntime().run(stage.id); signatureJobId = String(result.data.outboxId); assert(signatureJobId);
    });
    await t.test('actual DocuSeal adapter fetches synthetic PDF and audit HTTP bytes into the exact scoped private source ledger without autofill or weaker signature claims', async () => {
      await runWebsiteSalesCommerceWorker(worker, 1); assert(signatureRequest);
      assert.equal(signatureRequest.template_id, undefined); assert.equal(providerCalls.filter(row => row.method === 'POST' && row.path === '/submissions/html').length, 1);
      signatureComplete = true; signatureCompletedAt = new Date().toISOString(); badSignatureBinding = true;
      assert.equal((await reconcileWebsiteSalesCommerceProviderJob(worker, signatureJobId!)).status, 'UNKNOWN');
      badSignatureBinding = false; const observed = await reconcileWebsiteSalesCommerceProviderJob(worker, signatureJobId!); assert.equal(observed.status, 'SIGNED');
      const record = (await db.admin.query("select payload from crm_website_sales_commerce_sources where kind='SIGNATURE' and job_id=$1", [signatureJobId!])).rows[0].payload;
      assert.equal(record.payload.contractRef.digest, contractReference!.digest); assert.equal(record.payload.assurance, 'PROVIDER_ATTESTED');
      assert.deepEqual(record.payload.providerSignedDocumentDigests, [createHash('sha256').update(signedPdfBytes).digest('hex')]); assert.deepEqual(record.payload.providerAuditProofDigests, [createHash('sha256').update(auditPdfBytes).digest('hex')]);
      assert(providerCalls.filter(row => row.path.startsWith('/file/')).every(row => !row.auth));
      assert.equal(providerCalls.filter(row => row.method === 'POST' && row.path === '/submissions/html').length, 1);
      const current = await freshRead(); assert(current.sourceAssessment.activeEventIds.includes(record.eventId));
      const sourceCount = (await db.admin.query('select count(*)::int n from crm_website_sales_commerce_sources')).rows[0].n;
      assert.equal((await reconcileWebsiteSalesCommerceProviderJob(worker, signatureJobId!)).status, 'SIGNED');
      assert.equal((await db.admin.query('select count(*)::int n from crm_website_sales_commerce_sources')).rows[0].n, sourceCount, 'A fresh host retrieval does not duplicate the same signed source fact');
    });
    await t.test('foreign acknowledged identity and foreign nested current-data records fail closed after actual server reconciliation', async () => {
      const before = await counts();
      for (const mode of ['receipt', 'nested'] as const) { corrupt = mode; await assert.rejects(freshRuntime().run(queue.idempotencyKey), unknown); assert.equal(corrupt, null); assert.deepEqual(await counts(), before); }
      assert.equal((await freshRuntime().run(queue.idempotencyKey)).commandId, recovered!.commandId); assert.deepEqual(await counts(), before);
    });
    await t.test('fresh capability checks deny read-only effect reconciliation and revoke previously committed cached disclosures', async () => {
      const before = await counts();
      await assert.rejects(freshMachine(ids.readGrant).invoke('autonomy', 'reconcile', queue), /SALES_HTTP_403/);
      await assert.rejects(freshMachine(ids.effectOnlyGrant).invoke('autonomy', 'reconcile', queue), /SALES_HTTP_403/);
      await db.admin.query('update crm_website_sales_machine_grants set revoked_at=clock_timestamp() where id=$1', [ids.grant]);
      await assert.rejects(freshRead(), /SALES_HTTP_403/); await assert.rejects(freshRuntime().run(queue.idempotencyKey), /SALES_HTTP_403/);
      assert.deepEqual(await counts(), before); assert.equal((await freshRuntime().status(queue.idempotencyKey))?.status, 'COMMITTED'); assert.deepEqual(serverErrors, []);
      assert((await db.admin.query('select count(*)::int n from crm_website_sales_commerce_sources')).rows[0].n >= 2, 'Source evidence came only from explicit synthetic loopback provider fixtures');
      assert.equal(commerceDigest(commerceRecordReference(view.templates[0]!)).length, 64);
    });
  } finally {
    if (server?.listening) { const closing = new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve())); server.closeAllConnections(); await closing; }
    if (providerServer?.listening) { const closing = new Promise<void>((resolve, reject) => providerServer!.close(error => error ? reject(error) : resolve())); providerServer.closeAllConnections(); await closing; }
    await commercePool?.end(); await executionPool?.end(); await db.stop();
  }
});
