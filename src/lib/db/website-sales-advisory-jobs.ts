import 'server-only';
import { randomUUID, createHash } from 'node:crypto';
import { getRolePermissions, isAppRole } from '../auth/permissions';
import { getProductRoleCapabilities, isProductRole } from '../product-model';
import type { AppSession } from '../auth/session';
import type { TenantPool, TenantTransaction } from './tenant-client';
import { withWebsiteSalesMachineAuthority } from '../website-sales-machine-authority';
import { advisoryDigest, validateAdvisoryAdvice, extractAdvisoryTranscriptAssertions, validateAdvisoryRoleplayTurn } from '../website-sales-advisory-domain';
import type { AdvisoryRecord, AdvisoryReference } from '../website-sales-advisory-types';
import { advisoryFail as fail, advisoryParams as params, advisoryIso as iso, advisoryNow as now, advisoryState, advisoryAction, advisoryAggregate, advisoryAdvance, advisoryPersist, advisoryIdentity as identity, advisoryOwner, type AdvisoryScope as Scope, type AdvisoryJson as Json } from './website-sales-advisory-storage';
import { advisoryKnowledge } from './website-sales-advisory-derivations';
import { advisoryVerifiedDemo } from './website-sales-advisory-sources';
import { advisoryReferenceSchema } from '../website-sales-advisory-types';
import { advisoryBoundRecord } from './website-sales-advisory-storage';
import { advisoryGroundedFacts } from './website-sales-advisory-facts';

export type AdvisoryJobKind = 'ADVICE' | 'TRANSCRIPT_ANALYSIS' | 'ROLEPLAY' | 'VIDEO';
export type AdvisoryExecutionBinding = Scope & { workspaceId: string; actorId: string; workloadId: string; grantId: string; allowedKinds: readonly AdvisoryJobKind[]; expiresAt: number; authorityReference: string };
export type WebsiteSalesAdvisoryExecutor = Readonly<{ kind: 'SCOPED_ADVISORY_EXECUTOR' }>;
export type FrozenAdvisoryJob = { id: string; identity: ReturnType<typeof identity>; workflowId: string; kind: AdvisoryJobKind; version: number; status: 'READY' | 'CLAIMED' | 'SUCCEEDED' | 'UNKNOWN' | 'FAILED' | 'CANCELLED';
 recordRef: AdvisoryReference; frozenContext: Json; contextDigest: string; sourceRefs: AdvisoryReference[]; leaseToken: string | null; leaseExpiresAt: string | null; providerReference: string | null; resultDigest: string | null; updatedAt: string };
export type NormalizedAdvisoryVideo = { bytes: Uint8Array; mediaType: 'video/webm'; sha256: string; durationSeconds: number; width: number; height: number; captureProof: Json };
type Installed = { pool: TenantPool; assertCurrent: () => Promise<AdvisoryExecutionBinding> };
const executors = new WeakMap<object, Installed>();
const authority = (b: AdvisoryExecutionBinding) => ({ actorId: b.actorId, workloadId: b.workloadId, grantId: b.grantId, authorityReference: b.authorityReference });
export function createWebsiteSalesAdvisoryExecutor(options: Installed): WebsiteSalesAdvisoryExecutor {
 if (!options.pool || typeof options.assertCurrent !== 'function') fail('ADVISORY_EXECUTOR_CONFIGURATION_REQUIRED', 503);
 const cap = Object.freeze({ kind: 'SCOPED_ADVISORY_EXECUTOR' as const }); executors.set(cap, options); return cap;
}
function binding(value: AdvisoryExecutionBinding) {
 if (!value || ![value.workspaceId, value.actorId, value.workloadId, value.grantId, value.projectId, value.companyId, value.locationId, value.workflowId].every(id => /^[a-f0-9-]{36}$/i.test(id)) || !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= Date.now() || !value.authorityReference || value.authorityReference.length > 200 || !value.allowedKinds.length || value.allowedKinds.some(k => !['ADVICE', 'TRANSCRIPT_ANALYSIS', 'ROLEPLAY', 'VIDEO'].includes(k))) fail('ADVISORY_EXECUTOR_AUTHORITY_REQUIRED', 403);
 return Object.freeze({ ...value, allowedKinds: Object.freeze([...value.allowedKinds]) });
}
async function transact<T>(cap: WebsiteSalesAdvisoryExecutor, run: (tx: TenantTransaction, bound: AdvisoryExecutionBinding, session: AppSession) => Promise<T>): Promise<T> {
 const installed = executors.get(cap); if (!installed) fail('ADVISORY_EXECUTOR_AUTHORITY_REQUIRED', 403);
 const before = binding(await installed.assertCurrent()), client = await installed.pool.connect();
 try {
  await client.query('begin'); await client.query('set local statement_timeout=15000'); await client.query('set local lock_timeout=5000');
  const role = await client.query<{ ok: boolean }>(`select not r.rolsuper and not r.rolbypassrls and not r.rolcreatedb and not r.rolcreaterole and not r.rolreplication and pg_has_role(r.oid,'novalure_website_sales_advisory_executor','USAGE') and not pg_has_role(r.oid,'novalure_tenant_app','USAGE') as ok from pg_roles r where r.rolname=current_user`);
  if (!role.rows[0]?.ok) fail('ADVISORY_EXECUTOR_DATABASE_ROLE_REQUIRED', 403);
  await client.query("select set_config('app.tenant_id',$1,true),set_config('app.actor_id',$2,true),set_config('app.advisory_workload_id',$3,true),set_config('app.advisory_grant_id',$4,true),set_config('app.advisory_project_id',$5,true),set_config('app.advisory_company_id',$6,true),set_config('app.advisory_location_id',$7,true),set_config('app.advisory_workflow_id',$8,true)", [before.workspaceId, before.actorId, before.workloadId, before.grantId, before.projectId, before.companyId, before.locationId, before.workflowId]);
  const tx: TenantTransaction = { execute: async (sql, p) => { await client.query(sql, p ? [...p] : undefined); }, query: async <Row>(sql: string, p?: readonly unknown[]) => (await client.query(sql, p ? [...p] : undefined)).rows as Row[], queryOne: async <Row>(sql: string, p?: readonly unknown[]) => ((await client.query(sql, p ? [...p] : undefined)).rows[0] ?? null) as Row | null };
  await tx.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [`website-sales-operations:${before.workspaceId}:${before.projectId}`]);
  const grant = await tx.queryOne<{ actor_user_id: string; workspace_id: string; project_id: string; company_id: string; location_id: string; scopes: string[]; department_id: 'SALES'; agent_id: string; task_id: string; authority_reference: string }>('select * from crm_lock_website_sales_machine_grant($1,$2)', [before.workloadId, before.grantId]);
  if (!grant || grant.actor_user_id !== before.actorId || grant.workspace_id !== before.workspaceId || grant.project_id !== before.projectId || grant.company_id !== before.companyId || grant.location_id !== before.locationId || grant.authority_reference !== before.authorityReference || !grant.scopes.includes('crm.website-sales.advisory.read') || !grant.scopes.includes('crm.website-sales.advisory.process-job')) fail('ADVISORY_EXECUTOR_GRANT_REVOKED', 403);
  const member = await tx.queryOne<{ role: string; productRole: string; email: string; name: string; workspaceName: string; authIdentityId: string }>(`select u.role,u.product_role as "productRole",u.email,u.name,w.name as "workspaceName",u.auth_identity_id as "authIdentityId" from workspace_users u join workspaces w on w.id=u.workspace_id where u.workspace_id=$1 and u.id=$2 and u.status='active'`, [before.workspaceId, before.actorId]);
  if (!member || !isAppRole(member.role) || !isProductRole(member.productRole)) fail('ADVISORY_EXECUTOR_MEMBER_REQUIRED', 403);
  // This is a DB-attested worker, never a manufactured cookie or a claim of live OIDC issuance.
  const session: AppSession = { authenticated: true, source: 'database', workspaceId: before.workspaceId, userId: before.actorId, workspaceName: member.workspaceName, name: member.name, email: member.email, role: member.role, productRole: member.productRole, permissions: getRolePermissions(member.role), productPermissions: getProductRoleCapabilities(member.productRole), authIdentityId: member.authIdentityId,
   serviceIdentity: { identityId: 'EVELYN_WEBSITE_SALES_INTERNAL_IDENTITY', role: 'Evelyn.Service', consumer: 'EVELYN', environment: 'production', jtiHash: advisoryDigest(authority(before)) } };
  deepFreeze(session);
  const result = await withWebsiteSalesMachineAuthority({ workspaceId: before.workspaceId, actorId: before.actorId, identityId: session.serviceIdentity!.identityId, workloadId: before.workloadId, grantId: before.grantId, departmentId: 'SALES', agentId: grant.agent_id, taskId: grant.task_id, scope: before, target: 'autonomy', operation: 'process-job', mode: 'execute', scopes: grant.scopes }, () => run(tx, before, session));
  if (!await tx.queryOne('select id from crm_lock_website_sales_machine_grant($1,$2)', [before.workloadId, before.grantId]) || advisoryDigest(before) !== advisoryDigest(binding(await installed.assertCurrent()))) fail('ADVISORY_EXECUTOR_AUTHORITY_CHANGED', 403);
  await client.query('commit'); return result;
 } catch (error) { try { await client.query('rollback'); } catch {} throw error; } finally { client.release(); }
}
type JobRow = { id: string; kind: AdvisoryJobKind; version: number; status: FrozenAdvisoryJob['status']; recordId: string; recordVersion: number; recordDigest: string; frozenContext: Json; contextDigest: string; sourceRefs: AdvisoryReference[]; leaseToken: string | null; leaseExpiresAt: string | null; providerReference: string | null; resultDigest: string | null; updatedAt: string; executionAuthority: Json | null; commandId: string; workflowVersion: number; evidenceDigest: string };
const columns = `j.id,j.kind,j.version,j.status,r.entity_id as "recordId",r.version as "recordVersion",r.record_digest as "recordDigest",j.frozen_context as "frozenContext",j.context_digest as "contextDigest",j.source_refs as "sourceRefs",j.lease_token as "leaseToken",j.lease_expires_at as "leaseExpiresAt",j.provider_reference as "providerReference",j.result_digest as "resultDigest",j.updated_at as "updatedAt",j.execution_authority as "executionAuthority",j.command_id as "commandId",j.workflow_version as "workflowVersion",j.evidence_digest as "evidenceDigest"`;
async function job(tx: TenantTransaction, b: AdvisoryExecutionBinding, id: string) {
 const row = await tx.queryOne<JobRow>(`select ${columns} from crm_website_sales_advisory_jobs j join crm_website_sales_advisory_records r on r.workspace_id=j.workspace_id and r.id=j.record_id where j.workspace_id=$1 and j.project_id=$2 and j.company_id=$3 and j.location_id=$4 and j.workflow_id=$5 and j.id=$6 for update of j`, [...params(b, b), id]);
 if (!row || !b.allowedKinds.includes(row.kind) || advisoryDigest(row.frozenContext) !== row.contextDigest) fail('ADVISORY_EXECUTOR_JOB_DENIED', 403);
 return { ...row, version: Number(row.version), workflowVersion: Number(row.workflowVersion), recordVersion: Number(row.recordVersion) };
}
function deepFreeze<T>(value:T):T{if(value&&typeof value==='object'){Object.values(value).forEach(deepFreeze);Object.freeze(value);}return value;}
function frozen(row: JobRow, b: AdvisoryExecutionBinding): FrozenAdvisoryJob { return deepFreeze({ id: row.id, identity: identity(b, b), workflowId: b.workflowId, kind: row.kind, version: row.version, status: row.status, recordRef: { id: row.recordId, version: row.recordVersion, digest: row.recordDigest }, frozenContext: row.frozenContext, contextDigest: row.contextDigest, sourceRefs: row.sourceRefs, leaseToken: row.leaseToken, leaseExpiresAt: row.leaseExpiresAt ? iso(row.leaseExpiresAt) : null, providerReference: row.providerReference, resultDigest: row.resultDigest, updatedAt: iso(row.updatedAt) }); }
async function currentJob(tx: TenantTransaction, b: AdvisoryExecutionBinding, s: AppSession, row: JobRow) {
 const state = await advisoryState(tx, s, b); advisoryAction(state);
 if (row.evidenceDigest !== state.row.evidenceDigest || row.workflowVersion > state.row.version) fail('ADVISORY_JOB_SOURCE_CHANGED');
 if(row.kind==='ADVICE'){const fresh=(await advisoryGroundedFacts(tx,s,b)).filter(fact=>(row.frozenContext.facts as Array<{id:string}>).some(original=>original.id===fact.id));if(advisoryDigest(fresh)!==advisoryDigest(row.frozenContext.facts))fail('ADVISORY_JOB_FACTS_CHANGED');}
 if (!await tx.queryOne<{ ok: boolean }>('select crm_website_sales_advisory_record_current(j.record_id,0) as ok from crm_website_sales_advisory_jobs j where j.workspace_id=$1 and j.id=$2', [b.workspaceId, row.id]).then(value => value?.ok)) fail('ADVISORY_JOB_SOURCE_CHANGED');
}
export async function enqueueAdvisoryJob(tx: TenantTransaction, s: AppSession, b: Scope, stored: { rowId: string; record: AdvisoryRecord }, commandId: string, kind: AdvisoryJobKind, roleplayRequest?:Json) {
 const state = await advisoryState(tx, s, b), id = randomUUID();
 const context: Json = { context: { identity: identity(s, b), workflowId: b.workflowId, workflowVersion: state.row.version }, record: stored.record,
  ...(kind === 'ADVICE' ? { request: stored.record.payload, facts: (await advisoryGroundedFacts(tx, s, b)).filter(fact => (stored.record.payload.factRefs as AdvisoryReference[]).some(ref => advisoryDigest(ref) === advisoryDigest(fact.evidenceRef))) } : kind === 'TRANSCRIPT_ANALYSIS' ? { transcript: stored.record } : {}) };
 if (await tx.queryOne("select id from crm_website_sales_advisory_jobs where workspace_id=$1 and project_id=$2 and company_id=$3 and location_id=$4 and workflow_id=$5 and kind=$6 and status in('CLAIMED','UNKNOWN') limit 1", [...params(s,b),kind])) fail('ADVISORY_UNRESOLVED_JOB_REQUIRES_REVIEW');
 if(kind==='VIDEO'){ const storyboard=await advisoryBoundRecord(tx,s,b,advisoryReferenceSchema.parse(stored.record.payload.recordRef),['VIDEO_STORYBOARD']); if(storyboard.record.payload.status!=='READY')fail('ADVISORY_READY_STORYBOARD_REQUIRED');context.storyboard=storyboard.record; }
 if(kind==='ROLEPLAY'){ const request=roleplayRequest;if(!request)fail('ADVISORY_ROLEPLAY_REQUEST_REQUIRED');const k=await advisoryKnowledge(tx,s,b,advisoryReferenceSchema.parse(request.knowledgeRef));Object.assign(context,{request,...k});if(request.previousRoleplayRef)context.previousRoleplay=(await advisoryBoundRecord(tx,s,b,advisoryReferenceSchema.parse(request.previousRoleplayRef),['ROLEPLAY'])).record; }
 await tx.execute('insert into crm_website_sales_advisory_jobs(id,workspace_id,project_id,company_id,location_id,workflow_id,kind,record_id,frozen_context,context_digest,source_refs,workflow_version,evidence_digest,created_by,command_id)values($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11::jsonb,$12,$13,$14,$15)', [id, ...params(s, b), kind, stored.rowId, JSON.stringify(context), advisoryDigest(context), JSON.stringify(stored.record.parentRefs), state.row.version, state.row.evidenceDigest, s.userId, commandId]); return id;
}
export async function cancelAdvisoryJob(tx: TenantTransaction, s: AppSession, b: Scope, input: Json) {
 await advisoryOwner(tx, s); const row = await tx.queryOne<{ status: string; version: number; lease: string | null }>('select status,version,lease_expires_at as lease from crm_website_sales_advisory_jobs where workspace_id=$1 and project_id=$2 and company_id=$3 and location_id=$4 and workflow_id=$5 and id=$6 for update', [...params(s, b), input.jobId]);
 if (!row || Number(row.version) !== input.expectedJobVersion || row.status === 'CLAIMED' && row.lease && Date.parse(iso(row.lease)) > Date.now() || ['SUCCEEDED', 'CANCELLED'].includes(row.status)) fail('ADVISORY_JOB_VERSION_CONFLICT');
 await tx.execute("update crm_website_sales_advisory_jobs set status='CANCELLED',version=version+1,lease_token=null,lease_expires_at=null,error_code='ADVISORY_OWNER_ABANDONED_UNRESOLVED_JOB',updated_at=clock_timestamp() where workspace_id=$1 and id=$2", [s.workspaceId, input.jobId]);
}
export async function readWebsiteSalesAdvisoryJob(cap: WebsiteSalesAdvisoryExecutor, id: string) { return transact(cap, async (tx, b) => frozen(await job(tx, b, id), b)); }
export async function listDueWebsiteSalesAdvisoryJobs(cap: WebsiteSalesAdvisoryExecutor, limit = 20) {
 if (!Number.isInteger(limit) || limit < 1 || limit > 50) fail('ADVISORY_JOB_LIMIT_INVALID', 400);
 return transact(cap, async (tx, b) => { const rows = await tx.query<{ id: string }>(`select id from crm_website_sales_advisory_jobs where workspace_id=$1 and project_id=$2 and company_id=$3 and location_id=$4 and workflow_id=$5 and kind=any($6::text[]) and status in('READY','CLAIMED','UNKNOWN') order by case status when 'READY' then 0 when 'UNKNOWN' then 1 else 2 end,created_at,id limit $7`, [...params(b, b), b.allowedKinds, limit]); return Promise.all(rows.map(async row => frozen(await job(tx, b, row.id), b))); });
}
async function event(tx: TenantTransaction, b: AdvisoryExecutionBinding, row: JobRow, status: string, resultDigest: string | null = null) {
 await tx.execute('insert into crm_website_sales_advisory_job_events(id,workspace_id,job_id,version,from_status,to_status,execution_authority,result_digest) values($1,$2,$3,$4,$5,$6,$7::jsonb,$8)', [randomUUID(), b.workspaceId, row.id, row.version + 1, row.status, status, JSON.stringify(authority(b)), resultDigest]);
}
export async function claimWebsiteSalesAdvisoryJob(cap: WebsiteSalesAdvisoryExecutor, id: string) {
 return transact(cap, async (tx, b, s) => {
  const row = await job(tx, b, id);
  if (row.status === 'CLAIMED' && row.leaseExpiresAt && Date.parse(iso(row.leaseExpiresAt)) <= Date.now()) { await event(tx, b, row, 'UNKNOWN'); await tx.execute("update crm_website_sales_advisory_jobs set status='UNKNOWN',version=version+1,lease_token=null,lease_expires_at=null,error_code='ADVISORY_OUTCOME_UNKNOWN',updated_at=clock_timestamp() where workspace_id=$1 and id=$2", [b.workspaceId, id]); return null; }
  if (row.status !== 'READY') return null; await currentJob(tx, b, s, row);
  await event(tx, b, row, 'CLAIMED'); await tx.execute("update crm_website_sales_advisory_jobs set status='CLAIMED',version=version+1,lease_token=$3,lease_expires_at=clock_timestamp()+interval '5 minutes',execution_authority=$4::jsonb,updated_at=clock_timestamp() where workspace_id=$1 and id=$2", [b.workspaceId, id, randomUUID(), JSON.stringify(authority(b))]); return frozen(await job(tx, b, id), b);
 });
}
/** The returned actor comes only from a current saved grant/member. No cookie or caller role is synthesized. */
export async function withWebsiteSalesAdvisoryExecutorActor<T>(cap: WebsiteSalesAdvisoryExecutor, jobId: string, run: (ports: { session: AppSession; job: FrozenAdvisoryJob; isCurrent: () => Promise<boolean> }) => Promise<T>) {
 const admitted = await transact(cap, async (tx, b, session) => { const row = await job(tx, b, jobId); await currentJob(tx, b, session, row); if (row.status !== 'CLAIMED' || !row.leaseExpiresAt || Date.parse(iso(row.leaseExpiresAt)) <= Date.now() || advisoryDigest(row.executionAuthority) !== advisoryDigest(authority(b))) fail('ADVISORY_LEASE_CONFLICT'); return { session, job: frozen(row, b), binding:b, machine:await tx.queryOne<{agent_id:string;task_id:string;scopes:string[]}>('select agent_id,task_id,scopes from crm_lock_website_sales_machine_grant($1,$2)',[b.workloadId,b.grantId]) }; });
 const isCurrent = () => transact(cap, async (tx, b, s) => { const row = await job(tx, b, jobId); await currentJob(tx, b, s, row); return row.status === 'CLAIMED' && row.leaseToken === admitted.job.leaseToken && !!row.leaseExpiresAt && Date.parse(iso(row.leaseExpiresAt)) > Date.now() && advisoryDigest(row.executionAuthority) === advisoryDigest(authority(b)); });
 return withWebsiteSalesMachineAuthority({workspaceId:admitted.binding.workspaceId,actorId:admitted.binding.actorId,identityId:admitted.session.serviceIdentity!.identityId,workloadId:admitted.binding.workloadId,grantId:admitted.binding.grantId,departmentId:'SALES',agentId:admitted.machine!.agent_id,taskId:admitted.machine!.task_id,scope:admitted.binding,target:'autonomy',operation:'process-job',mode:'execute',scopes:admitted.machine!.scopes},()=>run({ session:admitted.session,job:admitted.job,isCurrent }));
}

export type AdvisoryJobCompletion = { jobId: string; leaseToken: string; contextDigest: string; result: unknown; providerReference?: string; video?: NormalizedAdvisoryVideo };
export async function completeWebsiteSalesAdvisoryJob(cap: WebsiteSalesAdvisoryExecutor, input: AdvisoryJobCompletion) {
 return transact(cap, async (tx, b, s) => {
  const row = await job(tx, b, input.jobId); await currentJob(tx, b, s, row);
  if (row.status !== 'CLAIMED' || row.leaseToken !== input.leaseToken || row.contextDigest !== input.contextDigest || !row.leaseExpiresAt || Date.parse(iso(row.leaseExpiresAt)) <= Date.now() || advisoryDigest(row.executionAuthority) !== advisoryDigest(authority(b))) fail('ADVISORY_LEASE_CONFLICT');
  const state=await advisoryState(tx,s,b);const context = {...row.frozenContext.context as object,workflowVersion:state.row.version} as Parameters<typeof validateAdvisoryAdvice>[1];
  const result = row.kind === 'ADVICE' ? validateAdvisoryAdvice({ request: row.frozenContext.request as Parameters<typeof validateAdvisoryAdvice>[0]['request'], facts: row.frozenContext.facts as Parameters<typeof validateAdvisoryAdvice>[0]['facts'], candidate: input.result as Parameters<typeof validateAdvisoryAdvice>[0]['candidate'] }, context, now())
   : row.kind === 'TRANSCRIPT_ANALYSIS' ? extractAdvisoryTranscriptAssertions({ transcript: row.frozenContext.transcript as AdvisoryRecord, candidates: (Array.isArray(input.result) ? input.result : (input.result as Json)?.assertions) as Parameters<typeof extractAdvisoryTranscriptAssertions>[0]['candidates'] }, context, now()) : row.kind==='ROLEPLAY' ? validateAdvisoryRoleplayTurn({request:row.frozenContext.request as Parameters<typeof validateAdvisoryRoleplayTurn>[0]['request'],knowledge:row.frozenContext.knowledge as AdvisoryRecord,approval:row.frozenContext.approval as AdvisoryRecord,...(row.frozenContext.previousRoleplay?{previousRoleplay:row.frozenContext.previousRoleplay as AdvisoryRecord}:{}),customerReply:String((input.result as Json)?.customerReply??'')},context,now()) : null;
  let resultDigest: string, resultRowId: string | null = null;
  if (row.kind === 'VIDEO') {
   const video = input.video; if (!video || video.mediaType !== 'video/webm' || video.bytes.byteLength > 25000000 || video.bytes.byteLength < 5 || Buffer.from(video.bytes).subarray(0, 4).toString('hex') !== '1a45dfa3' || video.sha256 !== createHash('sha256').update(video.bytes).digest('hex') || !Number.isFinite(video.durationSeconds) || video.durationSeconds <= 0 || video.durationSeconds > 180 || !Number.isInteger(video.width) || !Number.isInteger(video.height)) fail('ADVISORY_VIDEO_BYTES_INVALID', 400);
   const approval = row.frozenContext.record as AdvisoryRecord, storyboard = await tx.queryOne<{ id: string; payload: Json; validUntil: string }>('select id,payload,valid_until as "validUntil" from crm_website_sales_advisory_records where workspace_id=$1 and workflow_id=$2 and entity_id=$3 and version=$4 and record_digest=$5 and kind=$6', [b.workspaceId, b.workflowId, (approval.payload.recordRef as AdvisoryReference).id, (approval.payload.recordRef as AdvisoryReference).version, (approval.payload.recordRef as AdvisoryReference).digest, 'VIDEO_STORYBOARD']);
   if (!storyboard || storyboard.payload.status !== 'READY' || advisoryDigest(video.captureProof.storyboardRef) !== advisoryDigest(approval.payload.recordRef)) fail('ADVISORY_VIDEO_STORYBOARD_CHANGED');
   const story=storyboard.payload.value as Json,demo=await advisoryVerifiedDemo(tx,s,b,advisoryReferenceSchema.parse(story.demoRef));
   const documentSha256=createHash('sha256').update(demo.artifact.content.html,'utf8').digest('hex');
   const manifestDigest=demo.artifact.content.assetManifestDigest;const captions=(story.shots as Json[]).map(shot=>shot.narration).join('\n');
   if(advisoryDigest(video.captureProof.demoRef)!==advisoryDigest(story.demoRef)||video.captureProof.sourceBindingDigest!==story.sourceBindingDigest||video.captureProof.documentSha256!==documentSha256||video.captureProof.assetManifestDigest!==manifestDigest||video.captureProof.qaCertificateId!==demo.certificate.payload.certificateId||video.captureProof.qaSourceRevision!==demo.certificate.payload.sourceRevision||video.captureProof.renderer!=='PLAYWRIGHT_SEALED_DEMO_V1'||video.captureProof.narration!=='CAPTIONS_ONLY'||video.captureProof.captionText!==captions||!Number.isSafeInteger(video.captureProof.networkRequests)||Number(video.captureProof.networkRequests)<1||Number(video.captureProof.networkRequests)>100)fail('ADVISORY_CAPTURE_PROOF_INVALID');
   const assetId = randomUUID(); await tx.execute('insert into crm_website_sales_advisory_video_assets(id,workspace_id,project_id,company_id,location_id,workflow_id,job_id,storyboard_record_id,mime,bytes_bytea,byte_sha256,duration_seconds,width,height,capture_proof,created_by,execution_authority,valid_until)values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16,$17::jsonb,$18)', [assetId, ...params(b, b), row.id, storyboard.id, video.mediaType, Buffer.from(video.bytes), video.sha256, video.durationSeconds, video.width, video.height, JSON.stringify(video.captureProof), b.actorId, JSON.stringify(authority(b)), storyboard.validUntil]); resultDigest = video.sha256;
  } else {
   const aggregate = await advisoryAdvance(tx, s, b, await advisoryAggregate(tx, s, b, true), row.commandId), state = await advisoryState(tx, s, b, true);
   const stored = await advisoryPersist(tx, s, b, aggregate, state.row.version, state.row.evidenceDigest, row.kind === 'ADVICE' ? 'ADVICE' : row.kind==='ROLEPLAY'?'ROLEPLAY':'TRANSCRIPT_ASSERTIONS', result as unknown as Json, row.commandId, { parentRefs: [row.frozenContext.record as AdvisoryRecord].map(record => ({ id: record.id, version: record.version, digest: record.digest })), confidence: 'MODEL_DRAFT', bindings: { jobId: row.id, executionAuthority: authority(b) } }); resultRowId = stored.rowId; resultDigest = stored.record.digest;
  }
  const status = result && result.status !== 'READY' ? 'FAILED' : 'SUCCEEDED'; await event(tx, b, row, status, resultDigest);
  await tx.execute('update crm_website_sales_advisory_jobs set status=$3,version=version+1,lease_token=null,lease_expires_at=null,result_record_id=$4,provider_reference=$5,result_digest=$6,error_code=$7,updated_at=clock_timestamp() where workspace_id=$1 and id=$2', [b.workspaceId, row.id, status, resultRowId, input.providerReference?.slice(0, 250) ?? null, resultDigest, status === 'FAILED' ? 'ADVISORY_GENERATED_OUTPUT_REJECTED' : null]); return frozen(await job(tx, b, row.id), b);
 });
}
export async function markWebsiteSalesAdvisoryJobUnknown(cap: WebsiteSalesAdvisoryExecutor, input: { jobId: string; leaseToken: string; contextDigest: string; errorCode: string }) {
 return transact(cap, async (tx, b) => { const row = await job(tx, b, input.jobId); if (row.status !== 'CLAIMED' || row.leaseToken !== input.leaseToken || row.contextDigest !== input.contextDigest || advisoryDigest(row.executionAuthority) !== advisoryDigest(authority(b))) fail('ADVISORY_LEASE_CONFLICT'); await event(tx, b, row, 'UNKNOWN'); await tx.execute("update crm_website_sales_advisory_jobs set status='UNKNOWN',version=version+1,lease_token=null,lease_expires_at=null,error_code=$3,updated_at=clock_timestamp() where workspace_id=$1 and id=$2", [b.workspaceId, row.id, /^[A-Z][A-Z0-9_]{0,99}$/.test(input.errorCode) ? input.errorCode : 'ADVISORY_OUTCOME_UNKNOWN']); return frozen(await job(tx, b, row.id), b); });
}

/** Protected full render source for a bounded host-side capture, never a public projection. */
export async function readWebsiteSalesAdvisoryDemo(cap:WebsiteSalesAdvisoryExecutor,jobId:string){return transact(cap,async(tx,b,s)=>{const row=await job(tx,b,jobId);await currentJob(tx,b,s,row);if(row.kind!=='VIDEO'||row.status!=='CLAIMED')fail('ADVISORY_VIDEO_JOB_REQUIRED');const storyboard=row.frozenContext.storyboard as AdvisoryRecord;return advisoryVerifiedDemo(tx,s,b,advisoryReferenceSchema.parse((storyboard.payload.value as Json)?.demoRef));});}
