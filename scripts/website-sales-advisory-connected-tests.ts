import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { Pool } from 'pg';
import { getRolePermissions } from '../src/lib/auth/permissions';
import type { AppSession } from '../src/lib/auth/session';
import { getProductRoleCapabilities } from '../src/lib/product-model';
import type { TenantPool } from '../src/lib/db/tenant-client';
import { CRM_MACHINE_AUDIENCE, CRM_MACHINE_ENVIRONMENT, CRM_MACHINE_ISSUER, CRM_MACHINE_OWNER_ID, CRM_MACHINE_PROJECT_ID,
  CRM_MACHINE_SUBJECT, CRM_MACHINE_WORKSPACE_ID, type CrmMachineAuthOptions } from '../src/lib/crm-machine-auth';
import type { WebsiteSalesAdvisoryCommand, WebsiteSalesAdvisoryRead } from '../src/lib/website-sales-advisory-types';
import { applySalesSchema, startLocalSalesDb } from './lib/local-sales-db.mjs';

type Scope = { tenantId: string; projectId: string; crmWorkspaceId: string; crmProjectId: string; companyId: string; locationId: string };
type Identity = { workloadId: string; grantId: string; departmentId: 'SALES'; agentId: string; taskId: string };
type Result = { persisted: true; commandId: string; correlationId: string; data: Record<string, unknown> };
type Machine = { invoke(target: 'autonomy', operation: 'execute' | 'read' | 'reconcile', request: Record<string, unknown>): Promise<Record<string, unknown>> };
type Runtime = { enqueue(target: 'autonomy', command: Record<string, unknown>): Promise<{ id: string }>; run(id: string): Promise<Result>;
  status(id: string): Promise<{ status: string } | null>; originalCommand(id: string): Promise<Record<string, unknown> | null> };
type QueryClient = { query(sql: string, params?: readonly unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }> };
type ExternalRuntime = { WebsiteSalesCommandCipher: new (key: string, keys: Map<string, Uint8Array>) => object;
  WebsiteSalesMachineTransport: new (options: { origin: string; workspaceId: string; environment: 'local'; identity: Identity; getWorkloadToken(): Promise<string>; getDelegationPrivateKey(): Promise<string> }) => Machine;
  WebsiteSalesRuntime: new (options: { scope: Scope; store: object; cipher: object; machine: Machine; environment: 'local' }) => Runtime };
type ExternalStore = { PostgresWebsiteSalesExecutionStore: new (transactions: { run<T>(scope: Scope, callback: (client: QueryClient) => Promise<T>): Promise<T> }) => object };
type Options = { pool: TenantPool };
type AdvisoryRepo = { executeWebsiteSalesAdvisoryCommand(session: AppSession, command: WebsiteSalesAdvisoryCommand, options: Options): Promise<{ data: Record<string, unknown> }>;
  readWebsiteSalesAdvisory(session: AppSession, scope: Record<string, unknown>, options: Options): Promise<WebsiteSalesAdvisoryRead> };

// Explicit cross-repository acceptance, outside generic unit CI. Missing real sources fail; never skip.
const runtimeSource = process.env.EVELYN_WEBSITE_SALES_RUNTIME_SOURCE;
if (!runtimeSource || !path.isAbsolute(runtimeSource) || path.basename(runtimeSource) !== 'website-sales-runtime.ts') throw Error('EVELYN_WEBSITE_SALES_RUNTIME_SOURCE must name the absolute real Evelyn runtime');
const crmRoot = process.env.CRM_WEBSITE_SALES_ADVISORY_SOURCE_ROOT ?? process.cwd();
if (!path.isAbsolute(crmRoot)) throw Error('CRM_WEBSITE_SALES_ADVISORY_SOURCE_ROOT must be absolute');
const evelynRoot = path.resolve(path.dirname(runtimeSource), '../..');
const unknownOutcome = (error: unknown) => !!error && typeof error === 'object' && 'outcome' in error && error.outcome === 'UNKNOWN';

test('actual advisory pair: real Evelyn journal → Ed25519 → loopback CRM handler → isolated PostgreSQL', { timeout: 240000 }, async t => {
  const load = (file: string) => import(pathToFileURL(path.join(crmRoot, file)).href);
  const external = await import(pathToFileURL(runtimeSource).href) as ExternalRuntime;
  const storage = await import(pathToFileURL(path.join(path.dirname(runtimeSource), 'website-sales-execution-store.ts')).href) as ExternalStore;
  const machineModule = await load('src/lib/website-sales-machine.ts') as typeof import('../src/lib/website-sales-machine');
  const registration = await load('src/lib/website-sales-machine-registration.ts') as { registerWebsiteSalesMachineAccess(client: unknown, input: Record<string, unknown>): Promise<unknown> };
  const ireland = await load('src/lib/db/website-sales-ireland-repositories.ts') as typeof import('../src/lib/db/website-sales-ireland-repositories');
  const advisory = await load('src/lib/db/website-sales-advisory-repositories.ts') as AdvisoryRepo;
  const types = await load('src/lib/website-sales-advisory-types.ts') as typeof import('../src/lib/website-sales-advisory-types');
  const crmRevision = execFileSync('git', ['-C', crmRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const evelynRevision = execFileSync('git', ['-C', evelynRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const sourceFiles = ['src/lib/website-sales-machine.ts', 'src/lib/website-sales-advisory-types.ts', 'src/lib/website-sales-advisory-domain.ts',
    ...['repositories', 'storage', 'sources', 'derivations', 'facts', 'read', 'buyer', 'jobs'].map(part => `src/lib/db/website-sales-advisory-${part}.ts`), 'migrations/210_website_sales_advisory.sql'];
  const sourceHashes = await Promise.all(sourceFiles.map(async file => ({ file, sha256: createHash('sha256').update(await readFile(path.join(crmRoot, file))).digest('hex') })));
  const sourceDirty = execFileSync('git', ['-C', crmRoot, 'status', '--porcelain', '--', ...sourceFiles], { encoding: 'utf8' }).trim().length > 0;
  t.diagnostic(JSON.stringify({ crmRevision, evelynRevision, crmSourceState: sourceDirty ? 'WORKTREE_NOT_IMMUTABLE' : 'COMMITTED_SOURCE', crmSourceHashes: sourceHashes, runtimeSha256: createHash('sha256').update(await readFile(runtimeSource)).digest('hex'),
    assurance: 'SYNTHETIC_OIDC_VERIFIER_REAL_ED25519_HTTP_POSTGRES', installerAssurance: 'DISPOSABLE_SUPERUSER_BOOTSTRAP_NOT_NATIVE_INSTALLER_TEST', productionTls: false, providerCalls: 0 }));
  const db = await startLocalSalesDb(); let server: Server | undefined, executionPool: Pool | undefined;
  const ids = { actor: randomUUID(), reader: randomUUID(), owner: randomUUID(), authSession: randomUUID(), project: randomUUID(), company: randomUUID(), contact: randomUUID(),
    pipeline: randomUUID(), workload: randomUUID(), grant: randomUUID(), readGrant: randomUUID(), effectGrant: randomUUID(), task: randomUUID() };
  const options = { pool: db.pool as unknown as TenantPool }, pair = generateKeyPairSync('ed25519'), key = randomBytes(32), deploymentId = randomUUID(), agentId = 'evelyn.sales.advisory-connected';
  const oidc = (): CrmMachineAuthOptions => {
    const seconds = Math.floor(Date.now() / 1000);
    return { env: { NODE_ENV: 'production', VERCEL_ENV: 'production', CRM_MACHINE_AUTH_ENABLED: '1' }, verifier: async () => ({
      payload: { iss: CRM_MACHINE_ISSUER, aud: CRM_MACHINE_AUDIENCE, sub: CRM_MACHINE_SUBJECT, project_id: CRM_MACHINE_PROJECT_ID, owner_id: CRM_MACHINE_OWNER_ID,
        environment: CRM_MACHINE_ENVIRONMENT, iat: seconds - 5, nbf: seconds - 5, exp: seconds + 3600, jti: randomUUID() },
      protectedHeader: { alg: 'RS256', typ: 'JWT', kid: 'synthetic-advisory-local-verifier' },
    }) } as CrmMachineAuthOptions;
  };
  try {
    await applySalesSchema(db, { maxMigrationNumber: 90 });
    for (const file of ['170_crm_personal_mailbox.sql', '202_website_sales_ireland.sql', '203_website_sales_machine.sql', '204_website_sales_studio.sql', '205_website_sales_lifecycle.sql', '206_website_sales_operations.sql', '207_website_sales_conversations.sql', '208_website_sales_enablement.sql', '209_website_sales_commerce.sql', '210_website_sales_advisory.sql']) await db.admin.query(await readFile(path.join(crmRoot, 'migrations', file), 'utf8'));
    await db.admin.query("insert into workspaces(id,name,operating_model,customer_type,setup_state) values($1,'SYNTHETIC Advisory pair','novalure_internal','novalure_internal',$2::jsonb) on conflict(id) do update set setup_state=excluded.setup_state", [CRM_MACHINE_WORKSPACE_ID, JSON.stringify({ salesApprovalUserId: ids.owner })]);
    for (const [userId, role, email] of [[ids.actor, 'agent', 'synthetic-advisory-actor@example.invalid'], [ids.reader, 'agent', 'synthetic-advisory-reader@example.invalid'], [ids.owner, 'owner', 'synthetic-advisory-owner@example.invalid']]) await db.admin.query("insert into workspace_users(id,workspace_id,name,email,role,product_role,status) values($1,$2,'SYNTHETIC Advisory account',$3,$4,'novalure_operator','active')", [userId, CRM_MACHINE_WORKSPACE_ID, email, role]);
    const authIdentityId = String((await db.admin.query('select auth_identity_id from workspace_users where id=$1', [ids.owner])).rows[0].auth_identity_id);
    await db.admin.query("update auth_identities set credential_state='active' where id=$1", [authIdentityId]);
    await db.admin.query("insert into auth_sessions(id,token_hash,auth_identity_id,workspace_user_id,workspace_id,mfa_verified_at,expires_at) values($1,$2,$3,$4,$5,clock_timestamp(),clock_timestamp()+interval '1 hour')", [ids.authSession, createHash('sha256').update(randomUUID()).digest('hex'), authIdentityId, ids.owner, CRM_MACHINE_WORKSPACE_ID]);
    await db.admin.query("insert into projects(id,workspace_id,name,type,division) values($1,$2,'SYNTHETIC Advisory project','Website','WEB_DESIGN')", [ids.project, CRM_MACHINE_WORKSPACE_ID]);
    for (const actor of [ids.actor, ids.reader]) await db.admin.query('insert into project_pipeline_permissions(workspace_id,project_id,user_id,can_read,can_edit_deals) values($1,$2,$3,true,$4)', [CRM_MACHINE_WORKSPACE_ID, ids.project, actor, actor === ids.actor]);
    await db.admin.query("insert into crm_pipelines(id,workspace_id,project_id,key,name,purpose,is_default) values($1,$2,$3,'advisory-connected','SYNTHETIC Advisory pipeline','novalure_internal',true)", [ids.pipeline, CRM_MACHINE_WORKSPACE_ID, ids.project]);
    await db.admin.query("insert into crm_pipeline_stages(pipeline_id,workspace_id,project_id,key,name,position,category) values($1,$2,$3,'qualify','Qualifizieren',0,'work')", [ids.pipeline, CRM_MACHINE_WORKSPACE_ID, ids.project]);
    await db.admin.query('update projects set default_pipeline_id=$2 where id=$1', [ids.project, ids.pipeline]);
    await db.admin.query("insert into organizations(id,workspace_id,project_id,name,type,division) values($1,$2,$3,'SYNTHETIC Advisory company','Unternehmen','WEB_DESIGN')", [ids.company, CRM_MACHINE_WORKSPACE_ID, ids.project]);
    await db.admin.query("insert into contacts(id,workspace_id,project_id,organization_id,name,role,email,consent_label) values($1,$2,$3,$4,'SYNTHETIC Advisory contact','Ansprechpartner','synthetic-advisory@example.invalid','Opt-in')", [ids.contact, CRM_MACHINE_WORKSPACE_ID, ids.project, ids.company]);
    const owner: AppSession = { authenticated: true, source: 'database', userId: ids.owner, workspaceId: CRM_MACHINE_WORKSPACE_ID, workspaceName: 'SYNTHETIC Advisory pair', name: 'SYNTHETIC Owner', email: 'synthetic-advisory-owner@example.invalid', role: 'owner', productRole: 'novalure_operator', permissions: getRolePermissions('owner'), productPermissions: getProductRoleCapabilities('novalure_operator'), authSessionId: ids.authSession, authIdentityId, sessionCreatedAt: new Date() };
    const common = { projectId: ids.project, companyId: ids.company };
    const registered = await ireland.runWebsiteSalesIrelandCommand(owner, { contractVersion: ireland.websiteSalesIrelandContract, operation: 'register_location', ...common, idempotencyKey: randomUUID(), correlationId: randomUUID(), payload: { countryCode: 'IE', address: 'Synthetic Advisory 1, Dublin, Ireland', sourceUrl: 'https://example.invalid/advisory', sourceReference: 'SYNTHETIC fixture only' } }, options);
    const locationId = registered.data.location.id, identity = { workspaceId: CRM_MACHINE_WORKSPACE_ID, ...common, locationId };
    const observed = await ireland.runWebsiteSalesIrelandCommand(owner, { contractVersion: ireland.websiteSalesIrelandContract, operation: 'observe', ...common, locationId, locationVersion: 1, idempotencyKey: randomUUID(), correlationId: randomUUID(), payload: { prospect: { identity, country: 'IRELAND', identityStatus: 'VERIFIED', domain: null, path: 'NO_WEBSITE', ownWebsiteSearch: 'NONE_FOUND', obstacle: null, platformUrl: null, bookingRoute: 'UNKNOWN', need: 'EVIDENCED', evidence: ['IDENTITY', 'OWN_WEBSITE_SEARCH', 'BUSINESS_NEED'].map(kind => ({ identity, kind, evidenceId: kind.toLowerCase(), sourceUrl: `https://example.invalid/advisory/${kind}`, observedAt: new Date(Date.now() - 60000).toISOString(), validUntil: new Date(Date.now() + 86400000).toISOString(), finding: 'SYNTHETIC local evidence', validityCondition: 'SYNTHETIC controlled fixture', confidence: 0.9 })) } } }, options);
    const qualified = await ireland.runWebsiteSalesIrelandCommand(owner, { contractVersion: ireland.websiteSalesIrelandContract, operation: 'qualify', ...common, locationId, expectedVersion: observed.data.workflow!.version, idempotencyKey: randomUUID(), correlationId: randomUUID(), payload: { contactId: ids.contact, opportunitySummary: 'SYNTHETIC Advisory pair', nextAction: 'SYNTHETIC internal analysis', expectedEvidenceDigest: observed.data.workflow!.evidenceDigest } }, options);
    const validUntil = new Date(Date.now() + 3600000).toISOString();
    const prepared = await ireland.runWebsiteSalesIrelandCommand(owner, { contractVersion: ireland.websiteSalesIrelandContract, operation: 'prepare_offer', ...common, locationId, expectedVersion: qualified.data.workflow!.version, idempotencyKey: randomUUID(), correlationId: randomUUID(), payload: { content: { subject: 'SYNTHETIC Advisory offer', recipientName: 'SYNTHETIC Advisory contact', recipientEmail: 'synthetic-advisory@example.invalid', scope: 'SYNTHETIC information website', paymentPlan: 'SYNTHETIC', discounts: 'None', specialTerms: 'None', riskComplianceNotes: 'SYNTHETIC local fixture; no real delivery', terms: 'SYNTHETIC terms', validUntil, currency: 'EUR', taxBasis: 'NET', items: [{ description: 'SYNTHETIC website', quantity: 1, unitNetCents: 10000 }] }, expectedEvidenceDigest: qualified.data.workflow!.evidenceDigest } }, options);
    const workflowId = prepared.data.workflow!.id, bound = { ...common, locationId, workflowId };
    await db.admin.query('create role advisory_connected_registrar nologin nosuperuser nocreatedb nocreaterole noreplication nobypassrls');
    for (const table of ['crm_website_sales_machine_workloads', 'crm_website_sales_machine_grants']) { await db.admin.query(`alter table ${table} owner to advisory_connected_registrar`); await db.admin.query(`create policy advisory_connected_registrar_owner on ${table} for all to advisory_connected_registrar using(true) with check(true)`); }
    await db.admin.query('grant usage on schema public to advisory_connected_registrar; grant execute on function crm_lock_website_sales_machine_grant(uuid,uuid) to advisory_connected_registrar');
    const registrar = await db.admin.connect();
    try { await registrar.query('set role advisory_connected_registrar'); for (const grantId of [ids.grant, ids.readGrant, ids.effectGrant]) await registration.registerWebsiteSalesMachineAccess(registrar, { workloadId: ids.workload, workloadActorId: ids.actor, grantId, actorId: grantId === ids.readGrant ? ids.reader : ids.actor, ...common, locationId, departmentId: 'SALES', agentId, taskId: ids.task, scopes: [...(grantId === ids.effectGrant ? [] : ['crm.website-sales.advisory.read']), ...(grantId === ids.readGrant ? [] : ['crm.website-sales.advisory.prepare-value-case', 'crm.website-sales.advisory.reconcile'])], publicKey: pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url'), authorityReference: 'SYNTHETIC local advisory acceptance', expiresAt: null }); }
    finally { await registrar.query('reset role'); registrar.release(); }
    for (const role of ['evelyn_prod_owner', 'evelyn_prod_migration', 'evelyn_prod_recovery']) await db.admin.query(`create role ${role} nologin nosuperuser nocreatedb nocreaterole noreplication nobypassrls`);
    await db.admin.query('alter role evelyn_prod_recovery noinherit; create role evelyn_prod_runtime login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls');
    await db.admin.query("do $$ begin if not exists(select 1 from pg_roles where rolname='neon_superuser') then create role neon_superuser nologin nosuperuser nocreatedb nocreaterole noreplication nobypassrls;end if;end $$");
    await db.admin.query('grant create on database postgres to evelyn_prod_owner; grant evelyn_prod_owner to evelyn_prod_migration; grant evelyn_prod_migration to qa_admin');
    for (const file of ['migrations/production/001_foundation.sql', 'migrations/sales/001_website_sales_execution.sql', 'migrations/sales/002_website_sales_operations_target.sql']) await db.admin.query(await readFile(path.join(evelynRoot, file), 'utf8'));
    const scope: Scope = { tenantId: randomUUID(), projectId: randomUUID(), crmWorkspaceId: CRM_MACHINE_WORKSPACE_ID, crmProjectId: ids.project, companyId: ids.company, locationId };
    assert.notEqual(scope.tenantId, scope.crmWorkspaceId); assert.notEqual(scope.projectId, scope.crmProjectId);
    await db.admin.query("insert into evelyn_prod.runtime_scope(runtime_role,tenant_id,project_id,deployment_id,synthetic) values('evelyn_prod_runtime',$1,$2,$3,true)", [scope.tenantId, scope.projectId, deploymentId]);
    await db.admin.query("insert into evelyn_prod.website_sales_runtime_bindings(binding_id,runtime_role,tenant_id,project_id,crm_workspace_id,crm_project_id,company_id,location_id,deployment_id,authority_reference,enabled,expires_at) values($1,'evelyn_prod_runtime',$2,$3,$4,$5,$6,$7,$8,'SYNTHETIC Advisory pair',true,clock_timestamp()+interval '10 minutes')", [randomUUID(), scope.tenantId, scope.projectId, scope.crmWorkspaceId, scope.crmProjectId, scope.companyId, scope.locationId, deploymentId]);
    executionPool = new Pool({ host: '127.0.0.1', port: db.port, user: 'evelyn_prod_runtime', database: 'postgres', max: 4 });
    const transactions = { async run<T>(selected: Scope, callback: (client: QueryClient) => Promise<T>) { const client = await executionPool!.connect(); try { await client.query('begin'); await client.query('set local search_path=pg_catalog,evelyn_prod'); await client.query("select set_config('evelyn.tenant_id',$1,true),set_config('evelyn.project_id',$2,true)", [selected.tenantId, selected.projectId]); const value = await callback(client as unknown as QueryClient); await client.query('commit'); return value; } catch (error) { await client.query('rollback'); throw error; } finally { client.release(); } } };
    let origin = '', loseNext = false, corrupt: 'receipt' | 'record' | 'cohort' | null = null; const calls: string[] = [], serverErrors: string[] = [];
    server = createServer((incoming, outgoing) => { void (async () => { try {
      if (incoming.method !== 'POST' || incoming.url !== machineModule.websiteSalesMachinePath) { outgoing.writeHead(404).end(); return; }
      const chunks: Buffer[] = []; let size = 0; for await (const chunk of incoming) { const bytes = Buffer.from(chunk); size += bytes.byteLength; if (size > 131072) { outgoing.writeHead(413).end(); return; } chunks.push(bytes); }
      const body = Buffer.concat(chunks), envelope = JSON.parse(body.toString('utf8')) as { operation: string }; calls.push(envelope.operation);
      const headers = new Headers(); for (const [name, value] of Object.entries(incoming.headers)) if (typeof value === 'string') headers.set(name, value);
      const response = await machineModule.handleWebsiteSalesMachine(new Request(origin + machineModule.websiteSalesMachinePath, { method: 'POST', headers, body }), { ...options, machineAuth: oidc() });
      const raw = await response.text(); if (loseNext && envelope.operation === 'execute' && response.ok) { loseNext = false; outgoing.destroy(); return; }
      const projected = JSON.parse(raw) as { receipt?: { data: { identity: { companyId: string } } }; currentData?: { records: { identity: { companyId: string } }[]; choices: { cohortCandidates: unknown[] } } };
      if (corrupt && response.ok && envelope.operation === 'reconcile') {
        if (corrupt === 'receipt') projected.receipt!.data.identity.companyId = randomUUID();
        else if (corrupt === 'record') projected.currentData!.records[0]!.identity.companyId = randomUUID();
        else projected.currentData!.choices.cohortCandidates.push({ label: 'SYNTHETIC ungranted peer', member: { identity: { ...identity, companyId: randomUUID(), locationId: randomUUID() }, workflowId: randomUUID(), workflowVersion: 1, assignedAt: new Date().toISOString(), sourceDigest: 'b'.repeat(64) }, grantId: randomUUID() });
        corrupt = null;
      }
      outgoing.writeHead(response.status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); outgoing.end(JSON.stringify(projected));
    } catch (error) { serverErrors.push(error instanceof Error ? error.name : 'UNKNOWN'); outgoing.writeHead(503).end(); } })(); });
    await new Promise<void>((resolve, reject) => { server!.once('error', reject); server!.listen(0, '127.0.0.1', resolve); });
    const address = server.address(); assert(address && typeof address !== 'string'); origin = `http://127.0.0.1:${address.port}`;
    const freshMachine = (grantId = ids.grant) => new external.WebsiteSalesMachineTransport({ origin, workspaceId: scope.crmWorkspaceId, environment: 'local', identity: { workloadId: ids.workload, grantId, departmentId: 'SALES', agentId, taskId: ids.task }, getWorkloadToken: async () => `eyJ${'a'.repeat(20)}.${'b'.repeat(24)}.${'c'.repeat(24)}`, getDelegationPrivateKey: async () => pair.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString() });
    const freshRuntime = (grantId = ids.grant) => new external.WebsiteSalesRuntime({ scope, store: new storage.PostgresWebsiteSalesExecutionStore(transactions), cipher: new external.WebsiteSalesCommandCipher('advisory-connected-v1', new Map([['advisory-connected-v1', key]])), machine: freshMachine(grantId), environment: 'local' });
    const freshRead = async (grantId = ids.grant) => { const result = await freshMachine(grantId).invoke('autonomy', 'read', { ...bound, view: 'advisory', correlationId: randomUUID() }); return types.validateWebsiteSalesAdvisoryRead(result.data, identity, workflowId); };
    const command = (view: WebsiteSalesAdvisoryRead, operation: WebsiteSalesAdvisoryCommand['operation'], payload: Record<string, unknown>): WebsiteSalesAdvisoryCommand => ({ contractVersion: 'website-sales-advisory-v1', operation, ...bound, expectedVersion: view.version, expectedWorkflowVersion: view.workflowVersion, payload, idempotencyKey: randomUUID(), correlationId: randomUUID() });
    const counts = async () => (await db.admin.query('select (select count(*)::int from crm_website_sales_advisory_records) as records,(select count(*)::int from crm_website_sales_advisory_jobs) as jobs,(select count(*)::int from crm_offer_deliveries) as deliveries')).rows[0];
    let view = await advisory.readWebsiteSalesAdvisory(owner, bound, options); const offer = view.choices.offers[0]; assert(offer);
    const sourceRef = { id: randomUUID(), reference: 'operator-recorded:SYNTHETIC scenario assumptions', digest: 'a'.repeat(64), basis: 'OPERATOR_RECORDED', observedAt: new Date(Date.now() - 60000).toISOString(), validUntil };
    const basis = command(view, 'record_value_basis', { title: 'SYNTHETIC non-guaranteed value scenario', offerRef: offer.ref, currency: 'EUR', amountBasis: 'NET', horizonMonths: 3, oneTimeCostMinor: 10000, monthlyCostMinor: 0, scenarios: [{ name: 'BASE', monthlyBenefitMinor: 1000, startsAtMonth: 1, assumption: 'SYNTHETIC owner-recorded hypothetical benefit, not a forecast.', sourceReferences: [sourceRef] }], sourceReferences: [sourceRef], validUntil });
    await advisory.executeWebsiteSalesAdvisoryCommand(owner, basis, options); view = await freshRead();
    const basisRow = view.records.find(row => row.kind === 'VALUE_BASIS'); assert(basisRow);
    const draft = command(view, 'prepare_value_case', { basisRef: { id: basisRow.id, version: basisRow.version, digest: basisRow.digest } });
    await t.test('read-only grant views exact current scope and cannot execute effects or owner facts', async () => {
      const read = await freshRead(ids.readGrant); assert.equal(read.canWrite, false); assert.equal(read.canApproveFacts, false); assert.equal(read.canContact, false);
      await assert.rejects(freshMachine(ids.effectGrant).invoke('autonomy', 'read', { ...bound, view: 'advisory', correlationId: randomUUID() }), /SALES_HTTP_403/);
      for (const field of ['projectId', 'companyId', 'locationId', 'workflowId']) await assert.rejects(freshMachine().invoke('autonomy', 'read', { ...bound, [field]: randomUUID(), view: 'advisory', correlationId: randomUUID() }), /SALES_HTTP_(403|404)/);
      const before = await counts(); await assert.rejects(freshMachine(ids.readGrant).invoke('autonomy', 'execute', draft), /SALES_HTTP_403/); assert.deepEqual(await counts(), before);
      await assert.rejects(freshRuntime().enqueue('autonomy', basis), /SALES_ADVISORY_OWNER_ACTION_DENIED/);
    });
    await t.test('aggregate and workflow CAS independently reject without new records, jobs or delivery', async () => {
      const before = await counts(); for (const change of [{ expectedVersion: draft.expectedVersion - 1 }, { expectedWorkflowVersion: draft.expectedWorkflowVersion - 1 }]) { const runtime = freshRuntime(), row = await runtime.enqueue('autonomy', { ...draft, ...change, idempotencyKey: randomUUID(), correlationId: randomUUID() }); await assert.rejects(runtime.run(row.id), /SALES_HTTP_409/); assert.deepEqual(await counts(), before); }
    });
    let recordId = '', originalReceiptId = '';
    await t.test('actual committed draft with lost ACK cold-reconciles the exact original once', async () => {
      const runtime = freshRuntime(), row = await runtime.enqueue('autonomy', draft); recordId = row.id; loseNext = true;
      await assert.rejects(runtime.run(row.id), unknownOutcome); assert.equal(loseNext, false); assert.equal((await runtime.status(row.id))?.status, 'UNKNOWN');
      const committed = await counts(); assert.equal(committed.records, 2); assert.equal(committed.jobs, 0); assert.equal(committed.deliveries, 0);
      assert.deepEqual(await freshRuntime().originalCommand(row.id), draft);
      const recovered = await freshRuntime().run(row.id); originalReceiptId = recovered.commandId; assert.equal(recovered.persisted, true); assert.equal(recovered.correlationId, draft.correlationId); assert.equal((await freshRuntime().status(row.id))?.status, 'COMMITTED'); assert.deepEqual(await counts(), committed);
      assert.equal((await freshRuntime().run(row.id)).commandId, originalReceiptId); assert.deepEqual(await counts(), committed); assert.deepEqual(calls.slice(-3), ['execute', 'reconcile', 'reconcile']);
      const actual = (await db.admin.query("select payload from crm_website_sales_advisory_records where kind='VALUE_CASE'")).rows[0].payload; assert.equal(actual.status, 'READY'); assert.equal(actual.value.roiGuaranteed, false); assert.equal(actual.externalEffectAllowed, false);
    });
    await t.test('same idempotency key with a changed original cannot allocate another result', async () => {
      const before = await counts(); const changed = { ...draft, payload: { basisRef: { id: basisRow.id, version: basisRow.version + 1, digest: basisRow.digest } } };
      await assert.rejects(freshRuntime().enqueue('autonomy', changed)); await assert.rejects(freshMachine().invoke('autonomy', 'execute', { ...draft, payload: { basisRef: { id: basisRow.id, version: basisRow.version + 1, digest: basisRow.digest } } }), /SALES_HTTP_409/); assert.deepEqual(await counts(), before);
    });
    await t.test('foreign receipt, nested record and ungranted cohort are withheld even after a real commit', async () => {
      const before = await counts(); for (const kind of ['receipt', 'record', 'cohort'] as const) { corrupt = kind; await assert.rejects(freshRuntime().run(recordId), unknownOutcome); assert.equal(corrupt, null); assert.deepEqual(await counts(), before); }
      assert.equal((await freshRuntime().run(recordId)).commandId, originalReceiptId);
    });
    await t.test('read-only and revoked grants cannot disclose committed effect receipts or cached business data', async () => {
      await assert.rejects(freshMachine(ids.readGrant).invoke('autonomy', 'reconcile', draft), /SALES_HTTP_403/);
      await db.admin.query('update crm_website_sales_machine_grants set revoked_at=clock_timestamp() where id=$1', [ids.grant]);
      await assert.rejects(freshRead(), /SALES_HTTP_403/); await assert.rejects(freshRuntime().run(recordId), /SALES_HTTP_403/);
      assert.equal((await counts()).deliveries, 0); assert.deepEqual(serverErrors, []);
    });
    const finalHashes = await Promise.all(sourceFiles.map(async file => ({ file, sha256: createHash('sha256').update(await readFile(path.join(crmRoot, file))).digest('hex') })));
    const stableSource = JSON.stringify(finalHashes) === JSON.stringify(sourceHashes);
    t.diagnostic(JSON.stringify({ crmSourceStableDuringRun: stableSource, immutableSourceClaimed: !sourceDirty }));
    if (!sourceDirty) assert.equal(stableSource, true, 'Committed CRM source changed during acceptance');
  } finally {
    if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())); }
    await executionPool?.end(); await db.stop();
  }
});
