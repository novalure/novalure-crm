import assert from 'node:assert/strict';
import { createHash, randomUUID, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import sharp from 'sharp';
import type { AppSession } from '../src/lib/auth/session';
import { getRolePermissions } from '../src/lib/auth/permissions';
import { getProductRoleCapabilities } from '../src/lib/product-model';
import type { TenantPool } from '../src/lib/db/tenant-client';
import { withCrmRead, crmPayloadDigest, type TenantTransaction } from '../src/lib/crm-command';
import { withWebsiteSalesMachineAuthority } from '../src/lib/website-sales-machine-authority';
import { closeLocalTestPool } from '../src/lib/db/local-test-transport';
import { startLocalSalesDb, applySalesSchema } from './lib/local-sales-db.mjs';
import { runWebsiteSalesIrelandCommand, websiteSalesIrelandContract, type WebsiteSalesIrelandCommand } from '../src/lib/db/website-sales-ireland-repositories';
import { executeWebsiteSalesEnablementCommand as execute, readWebsiteSalesEnablement as read, readWebsiteSalesEnablementProject, reconcileWebsiteSalesEnablementCommand as reconcile, resolveCurrentEnablementDemoProfile, executeWebsiteSalesAssetUpload } from '../src/lib/db/website-sales-enablement-repositories';
import { websiteSalesEnablementContract, type WebsiteSalesEnablementCommand as Command } from '../src/lib/website-sales-enablement-types';
import { resolveCurrentWebsiteSalesBrief } from '../src/lib/db/website-sales-enablement-source';
import { CRM_MACHINE_WORKSPACE_ID } from '../src/lib/crm-machine-auth';
import { GET, POST } from '../src/app/api/crm/website-sales/enablement/route';

test('Sales enablement uses actual PostgreSQL, existing CRM records and the protected machine/API boundary', { timeout: 240000 }, async t => {
 const db = await startLocalSalesDb(), envKeys = ['DATABASE_URL', 'CRM_LOCAL_TEST_DATABASE', 'NODE_ENV', 'NOVALURE_SESSION_SECRET', 'NOVALURE_APP_ORIGIN', 'NOVALURE_AUTH_STRICT', 'NOVALURE_AUTH_ENCRYPTION_KEY', 'NOVALURE_AUTH_RATE_LIMIT_SECRET'], beforeEnv = Object.fromEntries(envKeys.map(k => [k, process.env[k]]));
 try {
  await applySalesSchema(db, { maxMigrationNumber: 90 });
  for (const file of ['202_website_sales_ireland.sql', '170_crm_personal_mailbox.sql', '203_website_sales_machine.sql', '204_website_sales_studio.sql', '205_website_sales_lifecycle.sql', '206_website_sales_operations.sql', '207_website_sales_conversations.sql', '208_website_sales_enablement.sql']) await db.admin.query(await readFile(`migrations/${file}`, 'utf8'));
  const ws = CRM_MACHINE_WORKSPACE_ID, actor = randomUUID(), otherWs = randomUUID(), otherActor = randomUUID(), project = randomUUID(), pipeline = randomUUID(), company = randomUUID(), contact = randomUUID(), second = randomUUID(), secondContact = randomUUID();
  await db.admin.query("insert into workspaces(id,name,operating_model,customer_type) values($1,'Isolated enablement','novalure_internal','novalure_internal'),($2,'Foreign tenant','novalure_internal','novalure_internal') on conflict(id) do nothing", [ws, otherWs]);
  await db.admin.query("insert into workspace_users(id,workspace_id,name,email,role,product_role) values($1,$2,'Isolated owner','enablement-owner@example.invalid','owner','novalure_operator'),($3,$4,'Foreign owner','enablement-foreign@example.invalid','owner','novalure_operator')", [actor, ws, otherActor, otherWs]);
  await db.admin.query("insert into projects(id,workspace_id,name,type,division) values($1,$2,'Enablement','Website','WEB_DESIGN')", [project, ws]);
  await db.admin.query("insert into crm_pipelines(id,workspace_id,project_id,key,name,purpose,is_default) values($1,$2,$3,'enablement-test','Existing Website Pipeline','novalure_internal',true)", [pipeline, ws, project]);
  for (const [i, stage] of ['Qualifizieren', 'Gewonnen', 'Verloren'].entries()) await db.admin.query("insert into crm_pipeline_stages(pipeline_id,workspace_id,project_id,key,name,position,category) values($1,$2,$3,$4,$5,$6,$7)", [pipeline, ws, project, i === 0 ? 'qualify' : stage.toLowerCase(), stage, i, i === 1 ? 'won' : i === 2 ? 'lost' : 'work']);
  await db.admin.query('update projects set default_pipeline_id=$2 where id=$1', [project, pipeline]);
  for (const [id, buyer, name] of [[company, contact, 'Canonical Company'], [second, secondContact, 'Other Company']]) {
   await db.admin.query("insert into organizations(id,workspace_id,project_id,name,type,division) values($1,$2,$3,$4,'Unternehmen','WEB_DESIGN')", [id, ws, project, name]);
   await db.admin.query("insert into contacts(id,workspace_id,project_id,organization_id,name,email,role) values($1,$2,$3,$4,'Canonical Buyer',$5,'Ansprechpartner')", [buyer, ws, project, id, `${buyer}@example.invalid`]);
  }
  const session: AppSession = { authenticated: true, source: 'database', workspaceId: ws, userId: actor, workspaceName: 'Isolated enablement', name: 'Isolated owner', email: 'enablement-owner@example.invalid', role: 'owner', productRole: 'novalure_operator', permissions: getRolePermissions('owner'), productPermissions: getProductRoleCapabilities('novalure_operator') }, foreign = { ...session, workspaceId: otherWs, userId: otherActor };
  const opts = { pool: db.pool as unknown as TenantPool }, future = new Date(Date.now() + 86400000).toISOString(), past = new Date(Date.now() - 60000).toISOString();
  const irish = (operation: WebsiteSalesIrelandCommand['operation'], payload: Record<string, unknown>, extra: Partial<WebsiteSalesIrelandCommand> = {}) => runWebsiteSalesIrelandCommand(session, { contractVersion: websiteSalesIrelandContract, operation, projectId: project, companyId: company, idempotencyKey: randomUUID(), correlationId: randomUUID(), payload, ...extra }, opts);
  const registered = await irish('register_location', { countryCode: 'IE', address: '1 Isolated Street, Dublin, Ireland', sourceUrl: 'https://example.invalid/company', sourceReference: 'Synthetic owner-registered location' }), location = registered.data.location.id;
  const scope = { projectId: project, companyId: company, locationId: location }, identity = { workspaceId: ws, ...scope };
  const prospect = { identity, country: 'IRELAND', identityStatus: 'VERIFIED', domain: null, path: 'NO_WEBSITE', ownWebsiteSearch: 'NONE_FOUND', obstacle: null, platformUrl: null, bookingRoute: 'UNKNOWN', need: 'EVIDENCED', evidence: ['IDENTITY', 'OWN_WEBSITE_SEARCH', 'BUSINESS_NEED'].map(kind => ({ evidenceId: kind, identity, kind, sourceUrl: `https://example.invalid/evidence/${kind}`, observedAt: past, validUntil: future, validityCondition: 'Synthetic evidence remains current', finding: 'Synthetic source-bound business need', confidence: 0.9 })) };
  const observed = await irish('observe', { prospect }, { locationId: location, locationVersion: 1 });
  const qualified = await irish('qualify', { contactId: contact, opportunitySummary: 'Synthetic canonical company opportunity', nextAction: 'Review current scope', expectedEvidenceDigest: observed.data.workflow!.evidenceDigest }, { locationId: location, expectedVersion: 1 });
  const wf = qualified.data.workflow!;
  const source = { reference: 'operator-recorded:isolated-customer-notes', digest: 'a'.repeat(64), basis: 'OPERATOR_ATTESTATION', observedAt: past, validUntil: future }, sources = [source];
  const brief = { goals: ['Provide source-bound information'], audience: ['Local buyers'], customerBudget: { status: 'UNKNOWN', amountMinor: null, currency: 'EUR' }, timeframe: { status: 'UNKNOWN', targetDate: null }, services: ['Informational website'], sourceReferences: sources, openQuestions: ['Customer budget not yet recorded'], validUntil: future };
  let version = 0;
  const command = (operation: Command['operation'], payload: Record<string, unknown>, expectedVersion = version): Command => ({ contractVersion: websiteSalesEnablementContract, operation, ...scope, expectedVersion, expectedWorkflowVersion: wf.version, idempotencyKey: randomUUID(), correlationId: randomUUID(), payload });
  const run = async (c: Command) => { const r = await execute(session, c, opts); version = r.data.aggregateVersion; return r; };
  let briefId = '', briefDigest = '', planId = '', planDigest = '', refId = '', refDigest = '', profileId = '', profileDigest = '', assetId = '';

  await t.test('forced tenant RLS and immutable owner-recorded history preserve unknown budget with exact replay/conflict/CAS', async () => {
   assert.equal((await db.admin.query("select count(*)::int n from pg_class where relname in('crm_website_sales_enablement','crm_website_sales_enablement_records','crm_website_sales_enablement_assets') and relrowsecurity and relforcerowsecurity")).rows[0].n, 3);
   const c = command('record_brief', brief), saved = await run(c); briefId = saved.data.recordId; briefDigest = saved.data.recordDigest;
   assert.equal((await run(c)).commandId, saved.commandId); assert.equal((await read(session, scope, opts)).brief!.payload.customerBudget.amountMinor, null);
   await assert.rejects(execute(session, { ...c, payload: { ...brief, goals: ['Changed payload'] } }, opts), { code: 'IDEMPOTENCY_CONFLICT' });
   await assert.rejects(execute(session, command('record_brief', brief, 0), opts), { code: 'ENABLEMENT_VERSION_CONFLICT' });
   await assert.rejects(execute(session, { ...command('record_brief', brief), expectedWorkflowVersion: 1 }, opts), { code: 'WORKFLOW_VERSION_CONFLICT' });
   assert.equal((await db.admin.query('select count(*)::int n from crm_website_sales_enablement_records')).rows[0].n, 1);
   for (const basis of ['APPROVED_KNOWLEDGE', 'CANONICAL_CRM_RECORD']) await assert.rejects(execute(session, command('record_brief', { ...brief, sourceReferences: [{ ...source, basis }] }), opts), { code: 'ENABLEMENT_SOURCE_RESOLVER_REQUIRED' });
   await assert.rejects(withCrmRead(session, tx => tx.execute("update crm_website_sales_enablement_records set payload='{}'::jsonb where workspace_id=$1", [ws]), opts), { code: '42501' });
  });
  await t.test('foreign tenants and unregistered generic service sessions cannot read or assert owner facts', async () => {
   await assert.rejects(read(foreign, scope, opts)); await assert.rejects(execute(foreign, command('record_brief', brief), opts));
   await assert.rejects(read({ ...session, serviceIdentity: { identityId: 'UNREGISTERED', role: 'Evelyn.Service', consumer: 'EVELYN', environment: 'production', jtiHash: 'a'.repeat(64) } }, scope, opts), { code: 'SESSION_REQUIRED' });
   const found = await withCrmRead(foreign, tx => tx.query('select id from crm_website_sales_enablement_records where workspace_id=$1', [ws]), opts); assert.equal(found.length, 0);
  });
  await t.test('canonical contact/task close-plan versions are server bound and next-step reuse is duplicate free', async () => {
   const tasks = (await read(session, scope, opts)).tasks, task = tasks[0]!;
   const saved = await run(command('record_close_plan', { contacts: [{ contactId: contact, roles: ['DECISION_MAKER', 'SIGNATORY'], verificationBasis: 'OPERATOR_RECORDED', sourceReferences: sources }], milestones: [{ taskId: task.taskId, taskVersion: task.version, kind: 'INTERNAL_TARGET', sourceReferences: sources }], nextStepTaskId: task.taskId, sourceReferences: sources, validUntil: future })); planId = saved.data.recordId; planDigest = saved.data.recordDigest;
   const before = (await db.admin.query('select count(*)::int n from tasks')).rows[0].n;
   assert.equal((await run(command('propose_next_step', { closePlanId: planId, closePlanDigest: planDigest }))).data.taskId, task.taskId);
   assert.equal((await run(command('propose_next_step', { closePlanId: planId, closePlanDigest: planDigest }))).data.taskId, task.taskId);
   assert.equal((await db.admin.query('select count(*)::int n from tasks')).rows[0].n, before);
   await db.admin.query("update contacts set name='Changed canonical contact',version=version+1 where id=$1", [contact]);
   await assert.rejects(execute(session, command('propose_next_step', { closePlanId: planId, closePlanDigest: planDigest }), opts), { code: 'CANONICAL_CONTACT_CHANGED' });
  });
  await t.test('brief replacement invalidates the exact prior source and SQL preview binding', async () => {
   await withCrmRead(session, tx => resolveCurrentWebsiteSalesBrief(tx, session, scope, { briefId, version: 1, digest: briefDigest }), opts);
   const originalBrief = (await read(session, scope, opts)).brief!, artifact = { identity, content: { concept: { content: { customerBrief: originalBrief } } } };
   assert.equal((await db.admin.query('select crm_website_sales_demo_profile_current($1::jsonb) as ok', [JSON.stringify(artifact)])).rows[0].ok, true);
   await run(command('record_brief', { ...brief, goals: ['Updated source-bound goal'] }));
   assert.equal((await db.admin.query('select crm_website_sales_demo_profile_current($1::jsonb) as ok', [JSON.stringify(artifact)])).rows[0].ok, false);
   await assert.rejects(withCrmRead(session, tx => resolveCurrentWebsiteSalesBrief(tx, session, scope, { briefId, version: 1, digest: briefDigest }), opts), { code: 'ENABLEMENT_BRIEF_NOT_CURRENT' });
  });
  await t.test('reference and real raster metadata are private and profile rights are exact, current and revocable', async () => {
   const ref = await run(command('register_reference', { title: 'Recorded local reference', industryCode: 'GENERAL', summary: 'Operator-recorded synthetic case', claims: [{ text: 'Synthetic source-backed reference', sourceReferences: sources }], rightsReference: 'Operator-recorded synthetic presentation rights', disclosure: 'APPROVED_CUSTOMER_PRESENTATION', sourceReferences: sources, validUntil: future })); refId = ref.data.recordId; refDigest = ref.data.recordDigest;
   await assert.rejects(execute(session, command('approve_reference', { referenceId: refId, referenceVersion: 1, referenceDigest: 'f'.repeat(64), validUntil: future }), opts), { code: 'CURRENT_REFERENCE_REQUIRED' });
   await run(command('approve_reference', { referenceId: refId, referenceVersion: 1, referenceDigest: refDigest, validUntil: future }));
   const bytes = await sharp({ create: { width: 10, height: 10, channels: 3, background: '#123456' } }).webp().toBuffer(), sha = createHash('sha256').update(bytes).digest('hex');
   const upload = command('upload_asset', { role: 'LOGO', title: 'Synthetic logo', alt: 'Synthetic normalized logo', rightsReference: 'Operator-recorded fixture rights', validUntil: future, originalSha256: sha, originalSizeBytes: bytes.length, originalMime: 'image/webp' });
   const uploaded = await executeWebsiteSalesAssetUpload(session, upload, { bytes, mime: 'image/webp', width: 10, height: 10, byteSha256: sha, originalSha256: sha }, opts); version = uploaded.data.aggregateVersion; assetId = uploaded.data.assetId!;
   const profile = await run(command('record_demo_profile', { industryCode: 'GENERAL', brandPalette: { primary: '#123456', background: '#ffffff', text: '#111111', accent: '#336699' }, referenceCaseIds: [refId], assetIds: [assetId], sourceReferences: sources, validUntil: future })); profileId = profile.data.recordId; profileDigest = profile.data.recordDigest;
   const resolved = await withCrmRead(session, tx => resolveCurrentEnablementDemoProfile(tx, session, scope, { profileId, version: 1, digest: profileDigest }), opts); assert.equal(resolved.rasterBodies[0].base64, bytes.toString('base64'));
   const previewSnapshot = { identity, content: { demoProfile: { profile: resolved.profile, references: resolved.references, assets: resolved.assets } } };
   assert.equal((await db.admin.query('select crm_website_sales_demo_profile_current($1::jsonb) as ok', [JSON.stringify(previewSnapshot)])).rows[0].ok, true);
   const metadata = JSON.stringify(await read(session, scope, opts)); assert.equal(metadata.includes(bytes.toString('base64')), false); assert.equal(metadata.includes('bytes_bytea'), false);
   await run(command('revoke_asset', { assetId, reason: 'Recorded rights withdrawn' }));
   assert.equal((await db.admin.query('select crm_website_sales_demo_profile_current($1::jsonb) as ok', [JSON.stringify(previewSnapshot)])).rows[0].ok, false);
   await assert.rejects(withCrmRead(session, tx => resolveCurrentEnablementDemoProfile(tx, session, scope, { profileId, version: 1, digest: profileDigest }), opts), { code: 'ENABLEMENT_ASSET_NOT_APPROVED' });
  });
  await t.test('closure cannot be asserted from a payload and hygiene never edits canonical contacts or organizations', async () => {
   await assert.rejects(execute(session, command('record_closure_reason', { reasonCode: 'PRICE', explanation: 'Recorded operator reason', sourceReferences: sources, industryCode: 'GENERAL', offerVersion: null, validUntil: future }), opts), { code: 'CANONICAL_CLOSED_DEAL_REQUIRED' });
   const before = await db.admin.query('select id,version,name from contacts order by id');
   await run(command('scan_hygiene', { organizationIds: [company, second], contactIds: [contact, secondContact] }));
   assert.deepEqual((await db.admin.query('select id,version,name from contacts order by id')).rows, before.rows);
   assert.equal((await read(session, scope, opts)).hygieneCandidates.every(row => !row.autoMergeAllowed && !row.realRecordMutationAllowed), true);
  });
  await t.test('protected API reads use a persisted synthetic MFA session, deny unauthenticated and enforce CSRF', async () => {
   const origin = 'http://127.0.0.1:3061', cookie = 'v2.' + randomBytes(32).toString('base64url'), authIdentityId = (await db.admin.query('select auth_identity_id from workspace_users where id=$1', [actor])).rows[0].auth_identity_id;
   Object.assign(process.env, { DATABASE_URL: `postgresql://${db.role}@127.0.0.1:${db.port}/postgres`, CRM_LOCAL_TEST_DATABASE: '1', NODE_ENV: 'test', NOVALURE_SESSION_SECRET: randomBytes(48).toString('base64url'), NOVALURE_APP_ORIGIN: origin, NOVALURE_AUTH_STRICT: '1', NOVALURE_AUTH_ENCRYPTION_KEY: randomBytes(40).toString('hex'), NOVALURE_AUTH_RATE_LIMIT_SECRET: randomBytes(40).toString('hex') });
   await db.admin.query("update auth_identities set credential_state='active' where id=$1", [authIdentityId]);
   await db.admin.query("insert into auth_sessions(id,token_hash,auth_identity_id,workspace_user_id,workspace_id,mfa_verified_at,expires_at) values($1,$2,$3,$4,$5,now(),now()+interval '1 hour')", [randomUUID(), createHash('sha256').update(cookie).digest('hex'), authIdentityId, actor, ws]);
   await db.admin.query(`grant select on auth_identities to ${db.role}`); await db.admin.query(`grant update(last_seen_at) on auth_sessions to ${db.role}`);
   const url = origin + '/api/crm/website-sales/enablement?' + new URLSearchParams(scope), headers = { cookie: 'novalure_session=' + cookie };
   assert.equal((await GET(new Request(url))).status, 401); const result = await GET(new Request(url, { headers })); assert.equal(result.status, 200, await result.clone().text()); assert.equal((await result.json()).identity.companyId, company);
   assert.equal((await POST(new Request(url.split('?')[0], { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(command('record_brief', brief)) }))).status, 403);
   assert.equal((await readWebsiteSalesEnablementProject(session, project, null, 1, opts)).dailyPriorities.every(row => row.identity.workspaceId === ws), true);
  });
  await t.test('fresh exact reconciliation resolves an unknown committed command without repeating the effect', async () => {
   const c = command('record_brief', brief), saved = await run(c), count = (await db.admin.query('select count(*)::int n from crm_website_sales_enablement_records')).rows[0].n;
   const found = await reconcile(session, c, opts); assert.equal(found.status, 'COMMITTED'); if (found.status === 'COMMITTED') assert.equal(found.commandId, saved.commandId);
   assert.equal((await db.admin.query('select count(*)::int n from crm_website_sales_enablement_records')).rows[0].n, count); assert.equal((await reconcile(session, { ...c, idempotencyKey: randomUUID() }, opts)).status, 'NOT_FOUND');
  });
  await t.test('runtime SQL cannot relabel an owner fact as server-derived or impersonate another recorder', async () => {
   const staff = randomUUID(); await db.admin.query("insert into workspace_users(id,workspace_id,name,email,role,product_role)values($1,$2,'Scoped staff','enablement-staff@example.invalid','agent','novalure_sales')", [staff, ws]);
   await db.admin.query('insert into project_pipeline_permissions(workspace_id,project_id,user_id,can_read,can_edit_deals) values($1,$2,$3,true,true)', [ws, project, staff]);
   const employee = { ...session, userId: staff, role: 'agent', productRole: 'novalure_sales', permissions: getRolePermissions('agent'), productPermissions: getProductRoleCapabilities('novalure_sales') } as AppSession;
   await assert.rejects(execute(employee, command('record_brief', brief), opts), { code: 'ENABLEMENT_OWNER_REQUIRED' });
   await assert.rejects(withCrmRead(employee, tx => tx.execute(`insert into crm_website_sales_enablement_records(id,workspace_id,project_id,company_id,location_id,workflow_id,enablement_id,aggregate_version,entity_id,version,kind,workflow_version,evidence_digest,payload,record_digest,source_confidence,created_by,command_id,valid_until)
    select $1,workspace_id,project_id,company_id,location_id,workflow_id,enablement_id,999999,$2,1,'BRIEF',workflow_version,evidence_digest,payload,record_digest,'SERVER_DERIVED',$3,command_id,valid_until from crm_website_sales_enablement_records where workspace_id=$4 limit 1`, [randomUUID(), randomUUID(), staff, ws]), opts), { code: '42501' });
  });
  await t.test('legacy Studio scopes cannot opt into new owner brief/profile sources before any database query', async () => {
   let queries = 0;
   const noQuery = { queryOne: async () => { queries++; throw Error('Unexpected source query'); } } as unknown as TenantTransaction;
   const machine = { ...session, serviceIdentity: { identityId: 'ISOLATED_HOST_AUTHORITY', role: 'Evelyn.Service' as const, consumer: 'EVELYN' as const, environment: 'production' as const, jtiHash: 'a'.repeat(64) } };
   const authority = { workspaceId: ws, actorId: actor, identityId: machine.serviceIdentity.identityId, grantId: randomUUID(), workloadId: randomUUID(), departmentId: 'SALES' as const, agentId: 'evelyn.sales.fixture', taskId: randomUUID(), scope, operation: 'build_demo', mode: 'execute' as const, target: 'studio' as const, scopes: ['crm.website-sales.studio.build-demo'] };
   await assert.rejects(withWebsiteSalesMachineAuthority(authority, () => resolveCurrentEnablementDemoProfile(noQuery, machine, scope, { profileId, version: 1, digest: profileDigest })), { code: 'ENABLEMENT_READ_SCOPE_REQUIRED' });
   await assert.rejects(withWebsiteSalesMachineAuthority(authority, () => resolveCurrentWebsiteSalesBrief(noQuery, machine, scope, { briefId, version: 1, digest: briefDigest })), { code: 'ENABLEMENT_READ_SCOPE_REQUIRED' }); assert.equal(queries, 0);
  });
  await t.test('care prepares one separate canonical DRAFT and preserves the original website offer and final approval gates', async () => {
   const original = await irish('prepare_offer', { expectedEvidenceDigest: wf.evidenceDigest, content: { subject: 'Original Website Draft', recipientName: 'Changed canonical contact', recipientEmail: `${contact}@example.invalid`, scope: 'Website project scope', paymentPlan: 'Separate owner-reviewed payment plan', discounts: 'None', specialTerms: 'Draft only', riskComplianceNotes: 'No external effect', terms: 'Final approval required', validUntil: future, currency: 'EUR', taxBasis: 'NET', items: [{ description: 'Website scope', quantity: 1, unitNetCents: 10000 }] } }, { locationId: location, expectedVersion: wf.version });
   Object.assign(wf, original.data.workflow!);
   const replied = await irish('stop', { reason: 'REPLY_RECEIVED', sourceReference: 'Isolated owner-recorded reply stop fixture' }, { locationId: location, expectedVersion: wf.version }); Object.assign(wf, replied.data.workflow!);
   const authoredBrief = (await read(session, scope, opts)).brief!;
   assert.ok(authoredBrief.workflowVersion < wf.version);
   await withCrmRead(session, tx => resolveCurrentWebsiteSalesBrief(tx, session, scope, { briefId: authoredBrief.id, version: authoredBrief.version, digest: authoredBrief.digest }), opts);
   // Canonical accepted/delivery state below is isolated fixture data, not a claim of real customer delivery.
   await db.admin.query("update crm_offers set status='ACCEPTED',response_reference='Synthetic owner-recorded acceptance fixture',response_actor_id=$2,follow_up_status='STOPPED',version=version+1 where id=$1", [wf.offerDraftId, actor]);
   const beforeOffer = (await db.admin.query('select id,version,revision,status,approval_id from crm_offers where id=$1', [wf.offerDraftId])).rows[0];
   await db.admin.query("update deals set stage='Gewonnen',version=version+1 where id=$1", [wf.dealId]);
   const artifacts: string[] = [];
   for (const kind of ['CONCEPT', 'DEMO']) { const id = randomUUID(), digest = crmPayloadDigest({ id, fixture: 'isolated care boundary', kind }); artifacts.push(id); await db.admin.query(`insert into crm_website_studio_artifacts(id,workspace_id,project_id,company_id,location_id,workflow_id,kind,version,artifact_digest,evidence_digest,artifact,created_by,valid_until) values($1,$2,$3,$4,$5,$6,$7,1,$8,$9,$10::jsonb,$11,$12)`, [id, ws, project, company, location, wf.id, kind, digest, wf.evidenceDigest, JSON.stringify({ kind, version: 1, artifactDigest: digest, evidenceDigest: wf.evidenceDigest, fixture: 'Not a provider, QA or publication attestation' }), actor, future]); }
   const acceptance = randomUUID(), deliveryTask = randomUUID();
   await db.admin.query(`insert into crm_website_sales_customer_acceptances(id,workspace_id,project_id,company_id,location_id,workflow_id,concept_artifact_id,demo_artifact_id,concept_digest,demo_digest,evidence_digest,source_reference,acceptance_digest,scope,version,accepted_by) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$9,$10,'Isolated owner-recorded acceptance fixture',$9,'{}',1,$11)`, [acceptance, ws, project, company, location, wf.id, artifacts[0], artifacts[1], 'b'.repeat(64), wf.evidenceDigest, actor]);
   await db.admin.query("insert into tasks(id,workspace_id,project_id,contact_id,lead_id,owner_user_id,title,status,priority,metadata) values($1,$2,$3,$4,$5,$6,'Canonical PM delivery fixture','done','Normal',$7::jsonb)", [deliveryTask, ws, project, contact, wf.leadId, actor, JSON.stringify({ websiteSalesWorkflowId: wf.id })]);
   await db.admin.query(`insert into crm_website_sales_handoffs(id,workspace_id,project_id,company_id,location_id,workflow_id,customer_acceptance_id,task_id,snapshot,snapshot_digest,created_by) values($1,$2,$3,$4,$5,$6,$7,$8,'{}',$9,$10)`, [randomUUID(), ws, project, company, location, wf.id, acceptance, deliveryTask, 'c'.repeat(64), actor]);
   const basis = await run(command('record_care_basis', { need: 'Operator-recorded ongoing maintenance need', sourceReferences: sources, canonicalDeliveryTaskId: deliveryTask, planKeys: ['MANAGED'], validUntil: future }));
   const candidate = await run(command('propose_care', { planKey: 'MANAGED', basisId: basis.data.recordId, basisDigest: basis.data.recordDigest }));
   const preparedCommand = command('prepare_care_offer', { careProposalId: candidate.data.recordId, careProposalDigest: candidate.data.recordDigest, expectedDeliveryTaskVersion: 1 }), prepared = await run(preparedCommand);
   assert.notEqual(prepared.data.dealId, wf.dealId); assert.notEqual(prepared.data.offerId, wf.offerDraftId);
   assert.deepEqual((await db.admin.query('select id,version,revision,status,approval_id from crm_offers where id=$1', [wf.offerDraftId])).rows[0], beforeOffer);
   const offer = (await db.admin.query('select o.status,o.approval_id,r.total_net_cents,r.content from crm_offers o join crm_offer_revisions r on r.workspace_id=o.workspace_id and r.offer_id=o.id and r.revision=o.revision where o.id=$1', [prepared.data.offerId])).rows[0];
   assert.equal(offer.status, 'DRAFT'); assert.equal(offer.approval_id, null); assert.equal(Number(offer.total_net_cents), 3900); assert.match(offer.content.paymentPlan, /13 onwards: EUR 99\.00/);
   assert.equal((await run(preparedCommand)).data.offerId, prepared.data.offerId); assert.equal((await db.admin.query('select count(*)::int n from crm_offers where deal_id=$1', [prepared.data.dealId])).rows[0].n, 1);
   const reviewAt = new Date().toISOString(), serviceStart = new Date(); serviceStart.setUTCFullYear(serviceStart.getUTCFullYear() - 1); serviceStart.setUTCDate(Math.max(1, serviceStart.getUTCDate() - 1));
   const renewal = { canonicalAcceptedCareOfferId: prepared.data.offerId, serviceStartAt: serviceStart.toISOString(), reviewAt, sourceReferences: sources };
   await assert.rejects(execute(session, command('record_care_basis', { need: 'Recorded renewal review', sourceReferences: sources, canonicalDeliveryTaskId: deliveryTask, planKeys: ['MANAGED'], validUntil: future, renewal }), opts), { code: 'CANONICAL_ACCEPTED_CARE_OFFER_REQUIRED' });
   // This fixture state exercises a canonical accepted-care boundary; no send/accept command or real customer action is performed.
   await db.admin.query("update crm_offers set status='ACCEPTED',response_reference='Synthetic owner-recorded care acceptance fixture',response_actor_id=$2,follow_up_status='STOPPED',version=version+1 where id=$1", [prepared.data.offerId, actor]);
   const renewalBasis = await run(command('record_care_basis', { need: 'Recorded renewal review', sourceReferences: sources, canonicalDeliveryTaskId: deliveryTask, planKeys: ['MANAGED'], validUntil: future, renewal }));
   const renewed = await run(command('propose_care', { planKey: 'MANAGED', basisId: renewalBasis.data.recordId, basisDigest: renewalBasis.data.recordDigest })); assert.ok(renewed.data.taskId);
   const repeat = await run(command('propose_care', { planKey: 'MANAGED', basisId: renewalBasis.data.recordId, basisDigest: renewalBasis.data.recordDigest })); assert.equal(repeat.data.taskId, renewed.data.taskId);
   const selected = (await read(session, scope, opts)).careCandidates.find(row => row.id === renewed.data.recordId)!; assert.equal(selected.payload.schedule[0].netMonthlyMinor, 9900); assert.equal(selected.payload.autoRenewalAllowed, false);
   const renewalOffer = await run(command('prepare_care_offer', { careProposalId: renewed.data.recordId, careProposalDigest: renewed.data.recordDigest, expectedDeliveryTaskVersion: 1 }));
   assert.equal(Number((await db.admin.query('select r.total_net_cents from crm_offers o join crm_offer_revisions r on r.workspace_id=o.workspace_id and r.offer_id=o.id and r.revision=o.revision where o.id=$1', [renewalOffer.data.offerId])).rows[0].total_net_cents), 9900);
   assert.equal((await read(session, scope, opts)).acceptedCareOffers[0].offerId, prepared.data.offerId);
  });
 } finally { await closeLocalTestPool(); for (const key of envKeys) if (beforeEnv[key] === undefined) delete process.env[key]; else process.env[key] = beforeEnv[key]; await db.stop(); }
});
