import 'server-only';
import { randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';
import type { AppSession } from '../auth/session';
import { assertProjectGrant, crmPayloadDigest, CrmCommandError, executeCrmCommand, reconcileCrmCommand, withCrmCommandPreflight, withCrmRead, type TenantTransaction, type TenantTransactionOptions } from '../crm-command';
import { websiteSalesActorAuthority, websiteSalesResourceAuthority, websiteSalesResourceReadScopes, websiteSalesMachineHasScope, websiteSalesEnablementSourceAuthority } from '../website-sales-machine-authority';
import { websiteSalesEnablementContract, websiteSalesEnablementCommandSchema, parseWebsiteSalesEnablementPayload, websiteSalesEnablementOwnerOperations, CANONICAL_WEBSITE_SALES_CATALOG,
 type WebsiteSalesEnablementCommand, type EnablementIdentity, type CanonicalEnablementRecord, type WebsiteClosePlan, type WebsiteCustomerBrief, type WebsiteReferenceCase, type WebsiteReferenceReview, type WebsiteDemoProfile, type WebsiteClosureReason, type WebsiteCareBasis, type WebsiteCareProposal, type WebsiteEnablementAssetMetadata, type CanonicalEnablementTask, type CanonicalEnablementContact, type CanonicalEnablementWorkflow, type WebsiteHygieneCandidate } from '../website-sales-enablement-types';
import type { WebsiteSalesEnablementScope as Scope, WebsiteSalesEnablementResourceRead, WebsiteSalesEnablementProjectRead, WebsiteSalesEnablementEffect, EnablementAlert, EnablementClosureAnalysis } from '../website-sales-enablement-api-types';
import { websiteSalesIrelandState } from './website-sales-ireland-repositories';
import { executeOfferCommand } from './offer-repositories';
import { upsertDealRecord, upsertTaskRecord } from './crm-write-repositories';
import type { Deal } from '../crm-types';
import { assessWebsiteSalesCustomerBrief, assessWebsiteSalesClosePlan, proposeWebsiteSalesCare, prioritizeWebsiteSalesDay, scanWebsiteSalesHygiene, resolveWebsiteSalesDemoProfile, analyzeWebsiteSalesClosures, websiteSalesEnablementRecordDigest } from '../website-sales-enablement';

type Json = Record<string, unknown>;
type State = Awaited<ReturnType<typeof websiteSalesIrelandState>>;
type Aggregate = { id: string; version: number };
type Stored = { id: string; entityId: string; kind: string; version: number; aggregateVersion: number; workflowVersion: number; evidenceDigest: string;
 payload: Json; bindings: Json; digest: string; recordedBy: string; createdAt: string; validUntil: string };
const recordColumns = `id,entity_id as "entityId",kind,version,aggregate_version as "aggregateVersion",workflow_version as "workflowVersion",evidence_digest as "evidenceDigest",payload,canonical_bindings as bindings,record_digest as digest,created_by as "recordedBy",created_at as "createdAt",valid_until as "validUntil"`;
const ids = z.strictObject({ projectId: z.uuid(), companyId: z.uuid(), locationId: z.uuid() });
const sourceKinds = new Set(websiteSalesEnablementOwnerOperations);
const clock = () => new Date().toISOString();
function fail(code: string, status = 409): never { throw new CrmCommandError(code, code, status); }
function object(value: unknown): Json { if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_ENABLEMENT_PAYLOAD', 400); return value as Json; }
function scopeOf(scope: Scope): Scope { return { projectId: scope.projectId, companyId: scope.companyId, locationId: scope.locationId }; }
function identity(session: AppSession, scope: Scope): EnablementIdentity { return { workspaceId: session.workspaceId, ...scopeOf(scope) }; }
function iso(value: string | Date) { return new Date(value).toISOString(); }
async function project(tx: TenantTransaction, session: AppSession, projectId: string, write = false) {
 await assertProjectGrant(tx, session, projectId, write);
 const row = await tx.queryOne(`select p.id from projects p join workspaces w on w.id=p.workspace_id where p.workspace_id=$1 and p.id=$2
  and p.division='WEB_DESIGN' and p.data_classification='NOVALURE_INTERNAL' and p.data_purpose='crm_sales' and w.operating_model='novalure_internal'`, [session.workspaceId, projectId]);
 if (!row) fail('ENABLEMENT_PROJECT_DENIED', 403);
}
async function owner(tx: TenantTransaction, session: AppSession) { if (session.serviceIdentity || !(await tx.queryOne<{ ok: boolean }>('select crm_sales_ops_owner($1) as ok', [session.workspaceId]))?.ok) fail('ENABLEMENT_OWNER_REQUIRED', 403); }
async function state(tx: TenantTransaction, session: AppSession, scope: Scope, lock = false) {
 websiteSalesResourceAuthority(session, scope); await project(tx, session, scope.projectId);
 const s = await websiteSalesIrelandState(tx, session, scope, lock); if (!s.row || !s.current.workflow) fail('WORKFLOW_NOT_FOUND', 404); return s as State & { row: NonNullable<State['row']> };
}
function assertAction(s: State) { const reason = s.current.workflow?.blockedReason; if (reason && reason !== 'REPLY_RECEIVED') fail(reason); if (!s.row?.contactId || !s.row.leadId) fail('QUALIFIED_CONTACT_REQUIRED'); }
async function aggregate(tx: TenantTransaction, session: AppSession, workflowId: string, lock = false) {
 return tx.queryOne<Aggregate>(`select id,version from crm_website_sales_enablement where workspace_id=$1 and workflow_id=$2 ${lock ? 'for update' : ''}`, [session.workspaceId, workflowId]);
}
async function stored(tx: TenantTransaction, session: AppSession, workflowId: string, kind?: string, entityId?: string) {
 return tx.query<Stored>(`select ${recordColumns} from crm_website_sales_enablement_records where workspace_id=$1 and workflow_id=$2
  ${kind ? 'and kind=$3' : ''} ${entityId ? `and entity_id=$${kind ? 4 : 3}` : ''} order by aggregate_version desc limit 250`, [session.workspaceId, workflowId, ...(kind ? [kind] : []), ...(entityId ? [entityId] : [])]);
}
async function latest(tx: TenantTransaction, session: AppSession, workflowId: string, kind: string, entityId?: string) { return (await stored(tx, session, workflowId, kind, entityId))[0] ?? null; }
function record<T>(row: Stored, bound: EnablementIdentity, revokedAt: string | null = null): CanonicalEnablementRecord<T> {
 return { id: row.entityId, identity: bound, version: row.version, workflowVersion: row.workflowVersion, digest: row.digest, recordedBy: row.recordedBy,
  createdAt: iso(row.createdAt), validUntil: iso(row.validUntil), revokedAt, payload: row.payload as T };
}
function current(row: Stored, s: State) { return row.workflowVersion <= s.row!.version && Date.parse(iso(row.validUntil)) > Date.now(); }
function validSources(payload: Json) {
 const visit = (value: unknown) => { if (Array.isArray(value)) { value.forEach(visit); return; } if (!value || typeof value !== 'object') return;
  const item = value as Json; if (Array.isArray(item.sourceReferences)) for (const raw of item.sourceReferences) { const source = object(raw); if (['APPROVED_KNOWLEDGE', 'CANONICAL_CRM_RECORD'].includes(String(source.basis))) fail('ENABLEMENT_SOURCE_RESOLVER_REQUIRED', 400); if (Date.parse(String(source.observedAt)) > Date.now() || Date.parse(String(source.validUntil)) <= Date.now() || Date.parse(String(source.validUntil)) <= Date.parse(String(source.observedAt))) fail('ENABLEMENT_SOURCE_NOT_CURRENT'); }
  Object.values(item).forEach(visit);
 }; visit(payload); if (payload.validUntil !== undefined && Date.parse(String(payload.validUntil)) <= Date.now()) fail('ENABLEMENT_SOURCE_NOT_CURRENT');
}
async function contacts(tx: TenantTransaction, session: AppSession, scope: Scope, s: State): Promise<CanonicalEnablementContact[]> {
 const rows = await tx.query<{ id: string; version: number; name: string; email: string; role: string; active: boolean }>(`select id,version,name,email,role,archived_at is null as active from contacts
  where workspace_id=$1 and project_id=$2 and organization_id=$3 and data_classification='NOVALURE_INTERNAL' ${session.serviceIdentity ? 'and id=$4' : ''} order by id limit 200`, [session.workspaceId, scope.projectId, scope.companyId, ...(session.serviceIdentity ? [s.row!.contactId] : [])]);
 return rows.map(row => ({ contactId: row.id, identity: identity(session, scope), version: Number(row.version), sourceDigest: crmPayloadDigest({ ...row, version: Number(row.version), identity: identity(session, scope) }), displayName: row.name.slice(0, 200), active: row.active }));
}
async function tasks(tx: TenantTransaction, session: AppSession, scope: Scope, s: State): Promise<CanonicalEnablementTask[]> {
 const rows = await tx.query<{ id: string; version: number; title: string; status: string; dueAt: string | null; observedAt: string }>(`select t.id,t.version,t.title,t.status,t.due_at as "dueAt",t.updated_at as "observedAt" from tasks t
  where t.workspace_id=$1 and t.project_id=$2 and (t.metadata->>'websiteSalesWorkflowId'=$3 or exists(select 1 from crm_website_sales_handoffs h where h.workspace_id=t.workspace_id and h.workflow_id=$3::uuid and h.task_id=t.id)) order by t.id limit 200`, [session.workspaceId, scope.projectId, s.row!.id]);
 return rows.map(row => ({ taskId: row.id, identity: identity(session, scope), version: Number(row.version), title: row.title.slice(0, 200), status: ({ open: 'OPEN', in_progress: 'IN_PROGRESS', blocked: 'BLOCKED', done: 'DONE', cancelled: 'CANCELLED' } as const)[row.status as 'open'] ?? 'BLOCKED', dueAt: row.dueAt ? iso(row.dueAt) : null, observedAt: iso(row.observedAt), blockedReason: s.current.workflow!.blockedReason }));
}
async function canonicalWorkflow(tx: TenantTransaction, session: AppSession, scope: Scope, s: State): Promise<CanonicalEnablementWorkflow> {
 const close = await dealBinding(tx, session, scope, s);
 return { workflowId: s.row!.id, identity: identity(session, scope), version: s.row!.version, status: close?.category === 'won' ? 'WON' : close?.category === 'lost' ? 'LOST' : s.row!.status, blockedReason: s.current.workflow!.blockedReason, evidenceDigest: s.row!.evidenceDigest, observedAt: clock() };
}
async function dealBinding(tx: TenantTransaction, session: AppSession, scope: Scope, s: State, lock = false) {
 if (!s.row!.dealId) return null;
 const source = await tx.queryOne<{ dealId: string; version: number; stage: string; category: string; pipelineId: string; stageId: string }>(`select d.id as "dealId",d.version,d.stage,ps.category,ps.pipeline_id as "pipelineId",ps.id as "stageId" from deals d join projects p on p.workspace_id=d.workspace_id and p.id=d.project_id join crm_pipeline_stages ps on ps.workspace_id=p.workspace_id and ps.project_id=p.id and ps.pipeline_id=p.default_pipeline_id and ps.name=d.stage where d.workspace_id=$1 and d.project_id=$2 and d.organization_id=$3 and d.id=$4 ${lock ? 'for share of d' : ''}`, [session.workspaceId, scope.projectId, scope.companyId, s.row!.dealId]);
 if (!source) return null; const body = { identity: identity(session, scope), ...source, version: Number(source.version) }; return { ...body, sourceDigest: crmPayloadDigest(body) };
}
function currentClosureReason(row: Stored, s: State, workflow: CanonicalEnablementWorkflow, actualDeal: Awaited<ReturnType<typeof dealBinding>>) {
 return !!actualDeal && row.bindings.dealSourceDigest === actualDeal.sourceDigest && row.bindings.outcome === workflow.status && ['WON', 'LOST'].includes(workflow.status)
  && row.workflowVersion === workflow.version && current(row, s) && (row.payload.sourceReferences as Json[]).every(source => Date.parse(String(source.observedAt)) <= Date.now() && Date.parse(String(source.validUntil)) > Date.now());
}
export function parseWebsiteSalesEnablementCommand(raw: unknown): WebsiteSalesEnablementCommand { return websiteSalesEnablementCommandSchema.parse(raw); }
export function websiteSalesEnablementCommandInput(session: AppSession, raw: WebsiteSalesEnablementCommand) {
 const c = parseWebsiteSalesEnablementCommand(raw), machine = websiteSalesActorAuthority(session, c, c.operation, 'autonomy');
 if (session.serviceIdentity && sourceKinds.has(c.operation)) fail('ENABLEMENT_OWNER_REQUIRED', 403);
 return { operation: `website_sales.enablement.${c.operation}`, projectId: c.projectId, resourceId: c.locationId, capability: 'pipeline:write' as const,
  idempotencyKey: c.idempotencyKey, correlationId: c.correlationId, payload: { request: raw, machine } };
}
async function persist(tx: TenantTransaction, session: AppSession, c: WebsiteSalesEnablementCommand, s: State, a: Aggregate | null, kind: string, payload: Json, commandId: string, entityId?: string, bindings: Json = {}) {
 const previous = entityId ? await latest(tx, session, s.row!.id, kind, entityId) : ['BRIEF', 'CLOSE_PLAN', 'DEMO_PROFILE'].includes(kind) ? await latest(tx, session, s.row!.id, kind) : null;
 const id = entityId ?? previous?.entityId ?? randomUUID(), version = (previous?.version ?? 0) + 1, createdAt = clock(), validUntil = String(payload.validUntil ?? new Date(Date.now() + 86400000).toISOString());
 const body = { id, identity: identity(session, c), version, workflowVersion: s.row!.version, recordedBy: session.userId, createdAt, validUntil, payload }, digest = websiteSalesEnablementRecordDigest({ ...body, revokedAt: null }), aggregateVersion = (a?.version ?? 0) + 1;
 const aggregateId = a?.id ?? randomUUID();
 if (a) { if (!await tx.queryOne('update crm_website_sales_enablement set version=$4,last_command_id=$5,updated_at=clock_timestamp() where workspace_id=$1 and id=$2 and version=$3 returning id', [session.workspaceId, a.id, a.version, aggregateVersion, commandId])) fail('ENABLEMENT_VERSION_CONFLICT'); }
 else await tx.execute(`insert into crm_website_sales_enablement(id,workspace_id,project_id,company_id,location_id,workflow_id,version,last_command_id,created_by) values($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [aggregateId, session.workspaceId, c.projectId, c.companyId, c.locationId, s.row!.id, aggregateVersion, commandId, session.userId]);
 await tx.execute(`insert into crm_website_sales_enablement_records(id,workspace_id,project_id,company_id,location_id,workflow_id,enablement_id,aggregate_version,entity_id,version,kind,workflow_version,evidence_digest,payload,record_digest,previous_digest,source_confidence,created_by,command_id,created_at,valid_until,canonical_bindings)
  values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15,$16,$17,$18,$19,$20,$21,$22::jsonb)`, [randomUUID(), session.workspaceId, c.projectId, c.companyId, c.locationId, s.row!.id, aggregateId, aggregateVersion, id, version, kind, s.row!.version, s.row!.evidenceDigest, JSON.stringify(payload), digest, previous?.digest ?? null, sourceKinds.has(c.operation) ? 'OPERATOR_RECORDED' : 'SERVER_DERIVED', session.userId, commandId, createdAt, validUntil, JSON.stringify(bindings)]);
 return { identity: identity(session, c), aggregateVersion, workflowVersion: s.row!.version, recordId: id, recordVersion: version, recordDigest: digest, canContact: false as const };
}

async function assets(tx: TenantTransaction, session: AppSession, scope: Scope, workflowId: string, selectedIds?: string[]): Promise<WebsiteEnablementAssetMetadata[]> {
 const rows = await tx.query<{ id: string; version: number; role: 'LOGO' | 'HERO'; title: string; alt: string; mime: 'image/png' | 'image/jpeg' | 'image/webp'; width: number; height: number; sha256: string; sizeBytes: number; rightsReference: string; approvedBy: string; approvedAt: string; validUntil: string; revokedAt: string | null }>(`select a.id,a.version,a.role,a.title,a.alt,a.mime,a.width,a.height,a.byte_sha256 as sha256,octet_length(a.bytes_bytea) as "sizeBytes",a.rights_reference as "rightsReference",a.approved_by as "approvedBy",a.approved_at as "approvedAt",a.valid_until as "validUntil",
  (select max(r.created_at) from crm_website_sales_enablement_records r where r.workspace_id=a.workspace_id and r.workflow_id=a.workflow_id and r.kind='ASSET_REVOCATION' and r.payload->>'assetId'=a.id::text) as "revokedAt"
  from crm_website_sales_enablement_assets a where a.workspace_id=$1 and a.project_id=$2 and a.company_id=$3 and a.location_id=$4 and a.workflow_id=$5 ${selectedIds ? 'and a.id=any($6::uuid[])' : ''} order by a.approved_at desc,a.id limit 25`, [session.workspaceId, scope.projectId, scope.companyId, scope.locationId, workflowId, ...(selectedIds ? [selectedIds] : [])]);
 return rows.map(row => { const base = { assetId: row.id, identity: identity(session, scope), version: row.version, role: row.role, title: row.title, alt: row.alt, mediaType: row.mime, sha256: row.sha256, sizeBytes: row.sizeBytes, width: row.width, height: row.height, rightsReference: row.rightsReference, rightsBasis: 'OPERATOR_ATTESTED' as const, approvedBy: row.approvedBy, approvedAt: iso(row.approvedAt), validUntil: iso(row.validUntil) }; return { ...base, digest: crmPayloadDigest(base), revokedAt: row.revokedAt ? iso(row.revokedAt) : null }; });
}
async function reviews(tx: TenantTransaction, session: AppSession, workflowId: string): Promise<WebsiteReferenceReview[]> {
 const approvals = await stored(tx, session, workflowId, 'REFERENCE_APPROVAL'), revocations = await stored(tx, session, workflowId, 'REFERENCE_REVOCATION');
 return approvals.map(row => { const p = row.payload as unknown as WebsiteReferenceReview, revoke = revocations.find(r => r.payload.referenceId === p.referenceId && r.aggregateVersion > row.aggregateVersion); return { ...p, revokedAt: revoke ? iso(revoke.createdAt) : null }; });
}
function latestEntities(rows: Stored[]) { const found = new Set<string>(); return rows.filter(row => { const key = `${row.kind}:${row.entityId}`; if (found.has(key)) return false; found.add(key); return true; }); }
async function readContacts(tx: TenantTransaction, session: AppSession, scope: Scope, s: State) {
 const selected = await contacts(tx, session, scope, s), verified = websiteSalesResourceReadScopes(session, scope.projectId);
 if (!verified) return selected;
 for (const resource of verified) if (resource.companyId !== scope.companyId || resource.locationId !== scope.locationId) {
  const other = await state(tx, session, resource); selected.push(...await contacts(tx, session, resource, other));
 }
 return selected;
}
async function alerts(tx: TenantTransaction, session: AppSession, scope: Scope, s: State, closePlanAssessment?: { status: string; reasons: string[] } | null): Promise<EnablementAlert[]> {
 const out: EnablementAlert[] = [], bound = identity(session, scope);
 const add = (kind: EnablementAlert['kind'], label: string, canonicalReference: string, version: number, source: unknown) => out.push({ id: crmPayloadDigest({ bound, kind, canonicalReference }), identity: bound, kind, label, canonicalReference, version, sourceDigest: crmPayloadDigest(source) });
 if (s.current.workflow!.blockedReason) add('BLOCKED_OPPORTUNITY', `Opportunity blocked: ${s.current.workflow!.blockedReason}`, `crm:workflow:${s.row!.id}`, s.row!.version, { workflow: s.row!.id, version: s.row!.version, reason: s.current.workflow!.blockedReason });
 if (s.row!.offerDraftId) {
  const offer = await tx.queryOne<{ id: string; version: number; status: string; approvalId: string | null; content: { validUntil: string }; digest: string }>(`select o.id,o.version,o.status,o.approval_id as "approvalId",r.content,r.content_digest as digest from crm_offers o join crm_offer_revisions r on r.workspace_id=o.workspace_id and r.offer_id=o.id and r.revision=o.revision where o.workspace_id=$1 and o.project_id=$2 and o.id=$3`, [session.workspaceId, scope.projectId, s.row!.offerDraftId]);
  if (offer?.status === 'DRAFT') add(Date.parse(offer.content.validUntil) <= Date.now() ? 'STALE_DRAFT' : 'WAITING_DECISION', Date.parse(offer.content.validUntil) <= Date.now() ? 'Stored offer draft has expired' : 'Final offer approval remains required', `crm:offer:${offer.id}`, Number(offer.version), { digest: offer.digest, version: Number(offer.version), validUntil: offer.content.validUntil });
 }
 if (closePlanAssessment?.status === 'BLOCKED') add('CLOSE_PLAN_CHANGED', `Close plan needs review: ${closePlanAssessment.reasons.join(', ')}`, `crm:workflow:${s.row!.id}:close-plan`, s.row!.version, closePlanAssessment);
 return out;
}
async function closureAnalysis(tx: TenantTransaction, session: AppSession, projectId: string): Promise<EnablementClosureAnalysis> {
 const verified = websiteSalesResourceReadScopes(session, projectId);
 const list = await tx.query<Scope & { id: string }>(`select w.id,w.project_id as "projectId",w.company_id as "companyId",w.location_id as "locationId" from crm_website_sales_workflows w join organizations o on o.workspace_id=w.workspace_id and o.id=w.company_id and o.project_id=w.project_id and o.data_classification='NOVALURE_INTERNAL' where w.workspace_id=$1 and w.project_id=$2
  ${verified ? 'and exists(select 1 from jsonb_to_recordset($3::jsonb) x("companyId" uuid,"locationId" uuid) where x."companyId"=w.company_id and x."locationId"=w.location_id)' : ''} order by id limit 501`, [session.workspaceId, projectId, ...(verified ? [JSON.stringify(verified.map(row => ({ companyId: row.companyId, locationId: row.locationId })))] : [])]);
 if (list.length > 500) return { status: 'BLOCKED', reasons: ['COHORT_EXCEEDS_BOUNDED_ANALYSIS_NARROW_SCOPE_REQUIRED'], value: null };
 const cohort = [], offers = new Map<string, { offerKey: string; skuCodes: string[]; originalDenominator: number; won: number; lost: number; unresolved: number }>();
 for (const scope of list) {
  const s = await state(tx, session, scope), workflow = await canonicalWorkflow(tx, session, scope, s), reasons = await latest(tx, session, scope.id, 'CLOSURE_REASON'), profile = await latest(tx, session, scope.id, 'DEMO_PROFILE');
  const actualDeal = await dealBinding(tx, session, scope, s);
  const usable = reasons && currentClosureReason(reasons, s, workflow, actualDeal);
  const profileCurrent = profile && current(profile, s) && (profile.payload.sourceReferences as Json[]).every(source => Date.parse(String(source.observedAt)) <= Date.now() && Date.parse(String(source.validUntil)) > Date.now());
  const industryCode = profileCurrent ? profile!.payload.industryCode : usable ? reasons!.payload.industryCode : null;
  cohort.push({ workflow, cohortAssignmentId: scope.id, industryCode, reason: usable ? record<WebsiteClosureReason>(reasons!, workflow.identity) : null });
  const q = await tx.queryOne<{ quote: { lines: { sku: string }[] }; ruleId: string }>(`select quote,rule_id as "ruleId" from crm_website_sales_ops_quotes where workspace_id=$1 and workflow_id=$2 and status='APPLIED' order by applied_at desc,id desc limit 1`, [session.workspaceId, scope.id]);
  const skuCodes = q ? [...new Set(q.quote.lines.map(line => line.sku))].sort() : [], key = q ? `${q.ruleId}:${skuCodes.join('+')}` : s.row!.offerDraftId ? 'UNCLASSIFIED_CANONICAL_OFFER' : 'NO_CANONICAL_OFFER';
  const group = offers.get(key) ?? { offerKey: key, skuCodes, originalDenominator: 0, won: 0, lost: 0, unresolved: 0 }; group.originalDenominator++; if (workflow.status === 'WON') group.won++; else if (workflow.status === 'LOST') group.lost++; else group.unresolved++; offers.set(key, group);
 }
 const result = analyzeWebsiteSalesClosures({ scope: { workspaceId: session.workspaceId, projectId }, minimumSampleSize: 5, cohort }, clock());
 return { status: result.status, reasons: result.reasons, value: result.value ? { ...result.value, offerSegments: [...offers.values()].map(group => ({ ...group, sampleAssessment: group.won + group.lost < 5 ? 'SMALL_SAMPLE' : 'DESCRIPTIVE_ONLY', winRateBps: group.won + group.lost < 5 ? null : Math.round(group.won * 10000 / (group.won + group.lost)), causalClaim: false })) } : null };
}

/** Approved scoped records only. Raster bodies never enter an ordinary metadata read. */
export async function resolveCurrentEnablementDemoProfile(tx: TenantTransaction, session: AppSession, scope: Scope, binding: { profileId: string; version: number; digest: string }) {
 websiteSalesEnablementSourceAuthority(session, scope);
 const s = await state(tx, session, scope), row = await latest(tx, session, s.row.id, 'DEMO_PROFILE', binding.profileId);
 if (!row || row.version !== binding.version || row.digest !== binding.digest || !current(row, s)) fail('ENABLEMENT_PROFILE_NOT_CURRENT');
 const profile = record<WebsiteDemoProfile>(row, identity(session, scope)); validSources(row.payload);
 const [approved, available] = await Promise.all([reviews(tx, session, s.row.id), assets(tx, session, scope, s.row.id, profile.payload.assetIds)]);
 const references: { record: CanonicalEnablementRecord<WebsiteReferenceCase>; review: WebsiteReferenceReview }[] = [];
 for (const referenceId of profile.payload.referenceCaseIds) {
  const ref = await latest(tx, session, s.row.id, 'REFERENCE', referenceId), review = ref && approved.find(r => r.referenceId === referenceId && r.referenceVersion === ref.version && r.referenceDigest === ref.digest && !r.revokedAt && Date.parse(r.validUntil) > Date.now());
  if (!ref || !review || !current(ref, s) || ref.payload.disclosure !== 'APPROVED_CUSTOMER_PRESENTATION') fail('ENABLEMENT_REFERENCE_NOT_APPROVED');
  validSources(ref.payload); references.push({ record: record<WebsiteReferenceCase>(ref, identity(session, scope)), review });
 }
 const selected: WebsiteEnablementAssetMetadata[] = [], rasterBodies: { assetId: string; base64: string }[] = [];
 for (const assetId of profile.payload.assetIds) {
  const asset = available.find(item => item.assetId === assetId); if (!asset || asset.revokedAt || Date.parse(asset.validUntil) <= Date.now()) fail('ENABLEMENT_ASSET_NOT_APPROVED');
  const bytes = await tx.queryOne<{ bytes: Buffer }>('select bytes_bytea as bytes from crm_website_sales_enablement_assets where workspace_id=$1 and project_id=$2 and company_id=$3 and location_id=$4 and workflow_id=$5 and id=$6', [session.workspaceId, scope.projectId, scope.companyId, scope.locationId, s.row.id, assetId]);
  if (!bytes || createHash('sha256').update(bytes.bytes).digest('hex') !== asset.sha256) fail('ENABLEMENT_ASSET_INTEGRITY'); selected.push(asset); rasterBodies.push({ assetId, base64: bytes.bytes.toString('base64') });
 }
 const checked = resolveWebsiteSalesDemoProfile(profile, references.map(row => row.record), references.map(row => row.review), selected, await context(tx, session, scope, s), clock());
 if (checked.status !== 'READY' || !checked.value) fail(checked.reasons[0] ?? 'ENABLEMENT_PROFILE_NOT_CURRENT');
 return { ...checked.value, rasterBodies };
}

async function read(tx: TenantTransaction, session: AppSession, scope: Scope): Promise<WebsiteSalesEnablementResourceRead> {
 const s = await state(tx, session, scope), a = await aggregate(tx, session, s.row.id), all = await stored(tx, session, s.row.id), rows = latestEntities(all), bound = identity(session, scope), historyLimit = 8;
 for (const kind of ['BRIEF', 'CLOSE_PLAN', 'DEMO_PROFILE']) { const row = await latest(tx, session, s.row.id, kind); if (row && !rows.some(r => r.id === row.id)) rows.unshift(row); }
 const profile = rows.find(r => r.kind === 'DEMO_PROFILE');
 if (profile) for (const id of profile.payload.referenceCaseIds as string[]) { const row = await latest(tx, session, s.row.id, 'REFERENCE', id); if (row && !rows.some(r => r.id === row.id)) rows.unshift(row); }
 const [contactRows, taskRows, workflow, referenceReviews, initialAssets] = await Promise.all([readContacts(tx, session, scope, s), tasks(tx, session, scope, s), canonicalWorkflow(tx, session, scope, s), reviews(tx, session, s.row.id), assets(tx, session, scope, s.row.id)]);
 const assetRows = [...initialAssets];
 if (profile) for (const asset of await assets(tx, session, scope, s.row.id, profile.payload.assetIds as string[])) if (!assetRows.some(row => row.assetId === asset.assetId)) assetRows.push(asset);
 const one = <T,>(kind: string) => { const row = rows.find(r => r.kind === kind); return row ? record<T>(row, bound) : null; }, many = <T,>(kind: string) => rows.filter(r => r.kind === kind).slice(0, kind === 'REFERENCE' ? historyLimit + 5 : historyLimit).map(r => record<T>(r, bound));
 const allowed = await tx.queryOne<{ ok: boolean }>('select crm_project_access($1,$2,true) as ok', [session.workspaceId, scope.projectId]);
 const dailyPriorities = prioritizeWebsiteSalesDay({ scope: { workspaceId: session.workspaceId, projectId: scope.projectId }, resources: [bound], tasks: taskRows }, clock()).value ?? [];
 const ctx = { identity: bound, workflowVersion: s.row.version, workflow, contacts: contactRows.filter(row => crmPayloadDigest(row.identity) === crmPayloadDigest(bound)), tasks: taskRows };
 const brief = one<WebsiteCustomerBrief>('BRIEF'), closePlan = one<WebsiteClosePlan>('CLOSE_PLAN'), references = many<WebsiteReferenceCase>('REFERENCE'), careCandidates = many<WebsiteCareProposal>('CARE_PROPOSAL');
 const briefEvaluation = brief ? assessWebsiteSalesCustomerBrief(brief.payload, ctx, clock()) : null, closeEvaluation = closePlan ? assessWebsiteSalesClosePlan(closePlan.payload, ctx, clock()) : null;
 const careOffers: WebsiteSalesEnablementResourceRead['careOffers'] = [];
 for (const row of rows.filter(r => r.kind === 'CARE_OFFER' && careCandidates.some(c => c.id === r.payload.careProposalId && c.digest === r.payload.careProposalDigest)).slice(0, historyLimit)) {
  const offer = await tx.queryOne<{ id: string; version: number; status: string }>('select id,version,status from crm_offers where workspace_id=$1 and project_id=$2 and id=$3 and deal_id=$4', [session.workspaceId, scope.projectId, row.payload.offerId, row.payload.dealId]);
  if (offer?.status === 'DRAFT') careOffers.push({ careProposalId: String(row.payload.careProposalId), careProposalDigest: String(row.payload.careProposalDigest), dealId: String(row.payload.dealId), offerId: offer.id, offerVersion: offer.version, taskId: null, status: 'DRAFT' });
 }
 const scan = rows.find(r => r.kind === 'HYGIENE_SCAN'), originalCandidates = (scan?.payload.candidates ?? []) as WebsiteHygieneCandidate[], verified = websiteSalesResourceReadScopes(session, scope.projectId);
 const visibleCandidates = originalCandidates.filter(candidate => !verified || candidate.kind === 'ORGANIZATION' ? !verified || candidate.recordIds.every(id => verified.some(r => r.companyId === id)) : candidate.recordIds.every(id => contactRows.some(r => r.contactId === id)));
 const hygieneCandidates: WebsiteHygieneCandidate[] = [];
 for (const candidate of visibleCandidates) { const table = candidate.kind === 'ORGANIZATION' ? 'organizations' : 'contacts'; const current = await tx.query<{ id: string; version: number }>(`select id,version from ${table} where workspace_id=$1 and project_id=$2 and id=any($3::uuid[]) and data_classification='NOVALURE_INTERNAL'`, [session.workspaceId, scope.projectId, candidate.recordIds]); if (candidate.recordIds.every((id, i) => current.some(row => row.id === id && Number(row.version) === candidate.recordVersions[i]))) hygieneCandidates.push(candidate); }
 const hygieneRecords: WebsiteSalesEnablementResourceRead['hygieneRecords'] = [];
 if (!session.serviceIdentity) {
  const organizationIds = [...new Set(hygieneCandidates.filter(row => row.kind === 'ORGANIZATION').flatMap(row => row.recordIds))], contactIds = [...new Set(hygieneCandidates.filter(row => row.kind === 'CONTACT').flatMap(row => row.recordIds))];
  const orgs = await tx.query<{ id: string; name: string; version: number; city: string | null }>(`select id,name,version,city from organizations where workspace_id=$1 and project_id=$2 and id=any($3::uuid[]) and data_classification='NOVALURE_INTERNAL' order by id limit 200`, [session.workspaceId, scope.projectId, organizationIds]);
  hygieneRecords.push(...orgs.map(row => ({ kind: 'ORGANIZATION' as const, id: row.id, name: row.name, companyId: row.id, companyName: row.name, version: Number(row.version), locationLabel: row.city || null })));
  const people = await tx.query<{ id: string; name: string; version: number; companyId: string; companyName: string; city: string | null }>(`select c.id,c.name,c.version,c.organization_id as "companyId",o.name as "companyName",o.city from contacts c join organizations o on o.workspace_id=c.workspace_id and o.project_id=c.project_id and o.id=c.organization_id and o.data_classification='NOVALURE_INTERNAL' where c.workspace_id=$1 and c.project_id=$2 and c.id=any($3::uuid[]) and c.data_classification='NOVALURE_INTERNAL' order by c.id limit 200`, [session.workspaceId, scope.projectId, contactIds]);
  hygieneRecords.push(...people.map(row => ({ kind: 'CONTACT' as const, id: row.id, name: row.name, companyId: row.companyId, companyName: row.companyName, version: Number(row.version), locationLabel: row.city || null })));
 }
 const accepted = await tx.query<{ offerId: string; offerVersion: number; planKey: 'MANAGED' | 'PERFORMANCE' | 'CONVERSION' }>(`select distinct on(o.id) o.id as "offerId",o.version as "offerVersion",p.payload->>'planKey' as "planKey" from crm_offers o
  join crm_website_sales_enablement_records r on r.workspace_id=o.workspace_id and r.project_id=o.project_id and r.company_id=o.organization_id and r.kind='CARE_OFFER' and r.payload->>'offerId'=o.id::text
  join crm_website_sales_enablement_records p on p.workspace_id=r.workspace_id and p.workflow_id=r.workflow_id and p.kind='CARE_PROPOSAL' and p.entity_id=(r.payload->>'careProposalId')::uuid and p.record_digest=r.payload->>'careProposalDigest'
  where r.workspace_id=$1 and r.project_id=$2 and r.company_id=$3 and r.location_id=$4 and r.workflow_id=$5 and o.status='ACCEPTED' and p.payload->>'planKey' in('MANAGED','PERFORMANCE','CONVERSION') order by o.id,r.aggregate_version desc limit 25`, [session.workspaceId, scope.projectId, scope.companyId, scope.locationId, s.row.id]);
 const annotationRows = rows.filter(row => row.kind === 'HYGIENE_ANNOTATION').filter(row => {
  const candidate = row.payload.candidate as unknown as WebsiteHygieneCandidate;
  return !verified || candidate.kind === 'ORGANIZATION' ? !verified || candidate.recordIds.every(id => verified.some(r => r.companyId === id)) : candidate.recordIds.every(id => contactRows.some(r => r.contactId === id));
 }).slice(0, historyLimit);
 const recorders = await tx.query<{ id: string; name: string }>('select id,name from workspace_users where workspace_id=$1 and id=any($2::uuid[])', [session.workspaceId, annotationRows.map(row => row.recordedBy)]);
 const actualDeal = await dealBinding(tx, session, scope, s);
 return { contractVersion: websiteSalesEnablementContract, source: 'database', projection: 'RESOURCE', identity: bound, aggregateVersion: a?.version ?? 0, workflowVersion: s.row.version,
  canWrite: !!allowed?.ok && session.permissions.includes('crm:write') && session.productPermissions.includes('pipeline:write'), canApproveFacts: !session.serviceIdentity && !!(await tx.queryOne<{ ok: boolean }>('select crm_sales_ops_owner($1) as ok', [session.workspaceId]))?.ok, canContact: false,
  workflow, contacts: contactRows, tasks: taskRows, brief, closePlan, references, referenceReviews: referenceReviews.filter((review, index) => references.some(ref => ref.id === review.referenceId && ref.version === review.referenceVersion && ref.digest === review.referenceDigest) && !referenceReviews.slice(0, index).some(old => old.referenceId === review.referenceId)), demoProfiles: many<WebsiteDemoProfile>('DEMO_PROFILE'), assets: assetRows,
  closureReasons: many<WebsiteClosureReason>('CLOSURE_REASON'), careBases: many<WebsiteCareBasis>('CARE_BASIS'), careCandidates, dailyPriorities, careOffers, hygieneCandidates,
  alerts: await alerts(tx, session, scope, s, closeEvaluation), acceptedCareOffers: accepted.map(row => ({ identity: bound, offerId: row.offerId, offerVersion: Number(row.offerVersion), status: 'ACCEPTED', planKey: row.planKey, sourceConfidence: 'CANONICAL_CRM_STATE' })), hygieneRecords,
  hygieneAnnotations: annotationRows.map(row => ({ id: row.entityId, candidateDigest: String(row.payload.candidateDigest), disposition: String(row.payload.disposition), rationale: String(row.payload.rationale), recordedBy: row.recordedBy, recorderDisplayName: recorders.find(actor => actor.id === row.recordedBy)?.name ?? 'Recorded operator', createdAt: iso(row.createdAt), recordedAt: iso(row.createdAt), sourceReferences: row.payload.sourceReferences as unknown as import('../website-sales-enablement-types').EnablementSourceReference[], current: current(row, s) && (row.payload.sourceReferences as Json[]).every(source => Date.parse(String(source.observedAt)) <= Date.now() && Date.parse(String(source.validUntil)) > Date.now()) && hygieneCandidates.some(c => c.candidateDigest === row.payload.candidateDigest) })),
  closureReasonBindings: rows.filter(row => row.kind === 'CLOSURE_REASON' && row.bindings.dealId).slice(0, historyLimit).map(row => ({ recordId: row.entityId, recordDigest: row.digest, dealId: String(row.bindings.dealId), dealVersion: Number(row.bindings.dealVersion), outcome: String(row.bindings.outcome), current: currentClosureReason(row, s, workflow, actualDeal) })),
  briefAssessment: briefEvaluation ? { status: briefEvaluation.status, reasons: briefEvaluation.reasons } : null, closePlanAssessment: closeEvaluation ? { status: closeEvaluation.status, reasons: closeEvaluation.reasons } : null,
  closureAnalysis: await closureAnalysis(tx, session, scope.projectId), coverage: { historyLimitPerKind: historyLimit, historyHasMore: all.length === 250 || rows.some(row => rows.filter(r => r.kind === row.kind).length > historyLimit), hygiene: { projection: verified ? 'EXPLICIT_VERIFIED_RESOURCES' : 'AUTHORIZED_PROJECT_BOUNDED', hasMore: !!scan?.payload.hasMore || visibleCandidates.length !== originalCandidates.length, current: !!scan && current(scan, s) } } };
}
export async function readWebsiteSalesEnablement(session: AppSession, scope: Scope, options: TenantTransactionOptions = {}) {
 websiteSalesActorAuthority(session, scope, 'read', 'autonomy'); websiteSalesEnablementSourceAuthority(session, scope); return withCrmRead(session, (tx, fresh) => read(tx, fresh, ids.parse(scope)), options);
}

export async function readWebsiteSalesEnablementProject(session: AppSession, projectId: string, cursor: string | null = null, limit = 25, options: TenantTransactionOptions = {}): Promise<WebsiteSalesEnablementProjectRead> {
 if (session.serviceIdentity) fail('ENABLEMENT_PROJECT_SESSION_REQUIRED', 403); z.uuid().parse(projectId); if (cursor) z.uuid().parse(cursor); if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) fail('INVALID_QUERY', 400);
 return withCrmRead(session, async (tx, fresh) => {
  await project(tx, fresh, projectId);
  const workflows = await tx.query<{ projectId: string; companyId: string; locationId: string; id: string }>(`select w.id,w.project_id as "projectId",w.company_id as "companyId",w.location_id as "locationId" from crm_website_sales_workflows w join organizations o on o.workspace_id=w.workspace_id and o.project_id=w.project_id and o.id=w.company_id where w.workspace_id=$1 and w.project_id=$2 and o.data_classification='NOVALURE_INTERNAL' and ($3::uuid is null or w.id>$3::uuid) order by w.id limit $4`, [fresh.workspaceId, projectId, cursor, limit + 1]);
  const dailyPriorities: WebsiteSalesEnablementProjectRead['dailyPriorities'] = [], alertRows: EnablementAlert[] = []; let hasMoreTasks = false;
  for (const scope of workflows.slice(0, limit)) {
   const s = await state(tx, fresh, scope), taskRows = await tasks(tx, fresh, scope, s); if (taskRows.length > 20) hasMoreTasks = true;
   dailyPriorities.push(...prioritizeWebsiteSalesDay({ scope: { workspaceId: fresh.workspaceId, projectId }, resources: [identity(fresh, scope)], tasks: taskRows.slice(0, 20) }, clock()).value ?? []);
   const plan = await latest(tx, fresh, s.row.id, 'CLOSE_PLAN'), evaluation = plan ? assessWebsiteSalesClosePlan(plan.payload, await context(tx, fresh, scope, s), clock()) : null;
   alertRows.push(...await alerts(tx, fresh, scope, s, evaluation));
  }
  return { contractVersion: websiteSalesEnablementContract, source: 'database', workspaceId: fresh.workspaceId, projectId, projection: 'PROJECT', dailyPriorities,
   page: { hasMore: workflows.length > limit, cursor: workflows.length > limit ? workflows[limit - 1]!.id : null }, canWrite: fresh.permissions.includes('crm:write') && fresh.productPermissions.includes('pipeline:write') && !!(await tx.queryOne<{ ok: boolean }>('select crm_project_access($1,$2,true) as ok', [fresh.workspaceId, projectId]))?.ok, canContact: false,
   alerts: alertRows, closureAnalysis: await closureAnalysis(tx, fresh, projectId), coverage: { tasksPerWorkflow: 20, hasMoreTasks } };
 }, options);
}

async function context(tx: TenantTransaction, session: AppSession, scope: Scope, s: State) {
 const [contactRows, taskRows, workflow] = await Promise.all([contacts(tx, session, scope, s), tasks(tx, session, scope, s), canonicalWorkflow(tx, session, scope, s)]);
 return { identity: identity(session, scope), workflowVersion: s.row!.version, workflow, contacts: contactRows, tasks: taskRows };
}
async function hygiene(tx: TenantTransaction, session: AppSession, c: Scope, p: Json) {
 const verified = websiteSalesResourceReadScopes(session, c.projectId), requestedOrganizations = (p.organizationIds ?? []) as string[], requestedContacts = (p.contactIds ?? []) as string[];
 // Machine admission is an SQL prefilter, before labels/contacts, aggregates or LIMIT.
 const scopes = verified ? verified.map(row => ({ companyId: row.companyId, locationId: row.locationId })) : null;
 const permitted = scopes ? await tx.query<{ companyId: string; contactId: string | null }>(`select w.company_id as "companyId",w.contact_id as "contactId" from crm_website_sales_workflows w
  where w.workspace_id=$1 and w.project_id=$2 and exists(select 1 from jsonb_to_recordset($3::jsonb) r("companyId" uuid,"locationId" uuid) where r."companyId"=w.company_id and r."locationId"=w.location_id)`, [session.workspaceId, c.projectId, JSON.stringify(scopes)]) : null;
 if (permitted && (requestedOrganizations.some(id => !permitted.some(row => row.companyId === id)) || requestedContacts.some(id => !permitted.some(row => row.contactId === id)))) fail('HYGIENE_RESOURCE_DENIED', 403);
 const organizations = await tx.query<{ id: string; version: number; name: string; domain: string | null }>(`select o.id,o.version,o.name,nullif(o.domain,'') as domain from organizations o where o.workspace_id=$1 and o.project_id=$2 and o.data_classification='NOVALURE_INTERNAL'
  ${scopes ? 'and o.id=any($3::uuid[])' : ''} ${requestedOrganizations.length ? `and o.id=any($${scopes ? 4 : 3}::uuid[])` : ''} order by o.id limit 201`, [session.workspaceId, c.projectId, ...(scopes ? [[...new Set(permitted!.map(row => row.companyId))]] : []), ...(requestedOrganizations.length ? [requestedOrganizations] : [])]);
 const contactRows = await tx.query<{ id: string; version: number; companyId: string; displayName: string; email: string | null }>(`select id,version,organization_id as "companyId",name as "displayName",nullif(email,'') as email from contacts where workspace_id=$1 and project_id=$2 and data_classification='NOVALURE_INTERNAL' and organization_id is not null
  ${scopes ? 'and id=any($3::uuid[])' : ''} ${requestedContacts.length ? `and id=any($${scopes ? 4 : 3}::uuid[])` : ''} order by id limit 501`, [session.workspaceId, c.projectId, ...(scopes ? [permitted!.flatMap(row => row.contactId ? [row.contactId] : [])] : []), ...(requestedContacts.length ? [requestedContacts] : [])]);
 const scope = { workspaceId: session.workspaceId, projectId: c.projectId }, observedAt = clock(), validUntil = new Date(Date.now() + 3600000).toISOString();
 const snapshot = { scope, observedAt, validUntil, organizations: organizations.slice(0, 200).map(row => ({ ...row, version: Number(row.version), scope, registrationId: null, locationIds: scopes ? scopes.filter(s => s.companyId === row.id).map(s => s.locationId) : [] })), contacts: contactRows.slice(0, 500).map(row => ({ ...row, version: Number(row.version), scope })) };
 const evaluation = scanWebsiteSalesHygiene(snapshot, clock());
 if (evaluation.status === 'BLOCKED' || !evaluation.value) fail(evaluation.reasons[0] ?? 'HYGIENE_SOURCE_NOT_CURRENT');
 return { candidates: evaluation.value.slice(0, 50), sourceSnapshot: { organizationIds: snapshot.organizations.map(row => row.id), contactIds: snapshot.contacts.map(row => row.id), digest: crmPayloadDigest(snapshot) }, coverage: scopes ? 'EXPLICIT_VERIFIED_RESOURCES' : 'AUTHORIZED_PROJECT_BOUNDED', hasMore: organizations.length > 200 || contactRows.length > 500 || evaluation.value.length > 50 || evaluation.reasons.includes('HYGIENE_RESULT_LIMIT_NARROW_SCOPE_REQUIRED'), validUntil };
}
async function derive(tx: TenantTransaction, session: AppSession, c: WebsiteSalesEnablementCommand, s: State, p: Json): Promise<{ kind: string; payload: Json; entityId?: string; taskId?: string }> {
 if (c.operation === 'scan_hygiene') return { kind: 'HYGIENE_SCAN', payload: await hygiene(tx, session, c, p) };
 if (c.operation === 'annotate_hygiene') {
  const previous = await latest(tx, session, s.row!.id, 'HYGIENE_SCAN'); if (!previous || !current(previous, s)) fail('CURRENT_HYGIENE_SCAN_REQUIRED');
  const snapshot = object(previous.payload.sourceSnapshot), fresh = await hygiene(tx, session, c, { organizationIds: snapshot.organizationIds, contactIds: snapshot.contactIds });
  const candidate = fresh.candidates.find(row => row.candidateDigest === p.candidateDigest); if (!candidate) fail('HYGIENE_CANDIDATE_CHANGED');
  return { kind: 'HYGIENE_ANNOTATION', payload: { ...p, candidate, autoMergeAllowed: false, realRecordMutationAllowed: false } };
 }
 assertAction(s);
 const ctx = await context(tx, session, c, s);
 if (c.operation === 'propose_care') {
  const basis = await latest(tx, session, s.row!.id, 'CARE_BASIS', String(p.basisId)); if (!basis || basis.digest !== p.basisDigest || !current(basis, s)) fail('CURRENT_CARE_BASIS_REQUIRED');
  await delivery(tx, session, c, s.row!.id, String(basis.payload.canonicalDeliveryTaskId));
  const result = proposeWebsiteSalesCare({ planKey: p.planKey, basis: record<WebsiteCareBasis>(basis, identity(session, c)) }, ctx, clock());
  if (result.status !== 'READY' || !result.value) fail(result.reasons[0] ?? 'CARE_FACTS_REQUIRED');
  let taskId: string | undefined;
  if (result.value.renewal) {
   if (!await tx.queryOne('select id from contacts where workspace_id=$1 and project_id=$2 and organization_id=$3 and id=$4 and archived_at is null for update', [session.workspaceId, c.projectId, c.companyId, s.row!.contactId])) fail('CANONICAL_RECIPIENT_REQUIRED');
   assertAction(await state(tx, session, c, true));
   await acceptedCareOffer(tx, session, c, s.row!.id, result.value.renewal.canonicalAcceptedCareOfferId);
   const key = crmPayloadDigest({ identity: identity(session, c), careOfferId: result.value.renewal.canonicalAcceptedCareOfferId, reviewAt: result.value.renewal.reviewAt, planKey: result.value.planKey });
   const existing = await tx.queryOne<{ id: string }>(`select id from tasks where workspace_id=$1 and project_id=$2 and metadata->>'websiteSalesWorkflowId'=$3 and metadata->>'careRenewalKey'=$4 order by id limit 1`, [session.workspaceId, c.projectId, s.row!.id, key]);
   if (existing) taskId = existing.id;
   else {
    const task = await upsertTaskRecord({ session, task: { projectId: c.projectId, contactId: s.row!.contactId!, leadId: s.row!.leadId!, ownerUserId: session.userId, title: `${result.value.planKey}: review recorded care renewal`, due: result.value.renewal.reviewAt, priority: 'Normal', status: 'open', metadata: { websiteSalesWorkflowId: s.row!.id, companyId: c.companyId, locationId: c.locationId, careRenewalKey: key, careBasisId: basis.entityId, careBasisDigest: basis.digest, careOfferId: result.value.renewal.canonicalAcceptedCareOfferId, sourceConfidence: 'OPERATOR_RECORDED', serviceStartAt: result.value.renewal.serviceStartAt, reviewAt: result.value.renewal.reviewAt, customerCommitmentCreated: false, autoRenewalAllowed: false, outboundEnabled: false } } });
    if (!task.persisted) fail('CARE_REVIEW_TASK_NOT_PERSISTED'); taskId = task.data.id;
   }
  }
  return { kind: 'CARE_PROPOSAL', payload: result.value as unknown as Json, taskId };
 }
 const plan = await latest(tx, session, s.row!.id, 'CLOSE_PLAN', String(p.closePlanId));
 if (!plan || plan.digest !== p.closePlanDigest || !current(plan, s)) fail('CURRENT_CLOSE_PLAN_REQUIRED');
 const evaluated = assessWebsiteSalesClosePlan(plan.payload, ctx, clock()); if (evaluated.status === 'BLOCKED') fail(evaluated.reasons[0] ?? 'CLOSE_PLAN_NOT_CURRENT');
 const next = evaluated.value?.nextStep; if (!next || ['DONE', 'CANCELLED', 'BLOCKED'].includes(next.status)) fail('CURRENT_NEXT_STEP_TASK_REQUIRED');
 // The close plan references a canonical task already. Reuse it rather than creating another task per attempt/key.
 return { kind: 'NEXT_STEP', payload: { taskId: next.taskId, taskVersion: next.version, closePlanId: plan.entityId, closePlanDigest: plan.digest, sourceConfidence: 'OPERATOR_RECORDED', customerCommitmentCreated: false, validUntil: iso(plan.validUntil) } };
}

function childKey(parent: string, operation: string) { const hash = crmPayloadDigest({ parent, operation }); return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`; }
async function delivery(tx: TenantTransaction, session: AppSession, scope: Scope, workflowId: string, taskId: string) {
 const row = await tx.queryOne<{ id: string; version: number; status: string }>(`select t.id,t.version,t.status from tasks t join crm_website_sales_handoffs h on h.workspace_id=t.workspace_id and h.task_id=t.id where h.workspace_id=$1 and h.project_id=$2 and h.company_id=$3 and h.location_id=$4 and h.workflow_id=$5 and t.id=$6 and t.project_id=h.project_id for share of t`, [session.workspaceId, scope.projectId, scope.companyId, scope.locationId, workflowId, taskId]);
 if (!row || row.status !== 'done') fail('COMPLETED_CANONICAL_DELIVERY_TASK_REQUIRED'); return { ...row, version: Number(row.version) };
}
async function acceptedCareOffer(tx: TenantTransaction, session: AppSession, scope: Scope, workflowId: string, offerId: string) {
 const row = await tx.queryOne<{ id: string; version: number; status: string }>(`select o.id,o.version,o.status from crm_offers o where o.workspace_id=$1 and o.project_id=$2 and o.organization_id=$3 and o.id=$4 and o.status='ACCEPTED' and exists(select 1 from crm_website_sales_enablement_records r where r.workspace_id=o.workspace_id and r.project_id=o.project_id and r.company_id=o.organization_id and r.location_id=$5 and r.workflow_id=$6 and r.kind='CARE_OFFER' and r.payload->>'offerId'=o.id::text) for share of o`, [session.workspaceId, scope.projectId, scope.companyId, offerId, scope.locationId, workflowId]);
 if (!row) fail('CANONICAL_ACCEPTED_CARE_OFFER_REQUIRED'); return { ...row, version: Number(row.version) };
}
async function careOffer(tx: TenantTransaction, session: AppSession, c: WebsiteSalesEnablementCommand, s: State, payload: Json, options: TenantTransactionOptions) {
 assertAction(s);
 const proposal = await latest(tx, session, s.row!.id, 'CARE_PROPOSAL', String(payload.careProposalId));
 if (!proposal || proposal.digest !== payload.careProposalDigest || !current(proposal, s)) fail('CURRENT_CARE_PROPOSAL_REQUIRED');
 const p = proposal.payload as unknown as WebsiteCareProposal, basis = await latest(tx, session, s.row!.id, 'CARE_BASIS', p.basisId);
 if (!basis || basis.digest !== p.basisDigest || !current(basis, s)) fail('CURRENT_CARE_BASIS_REQUIRED'); validSources(basis.payload);
 const completed = await delivery(tx, session, c, s.row!.id, p.deliveryTaskId);
 if (p.renewal) await acceptedCareOffer(tx, session, c, s.row!.id, p.renewal.canonicalAcceptedCareOfferId);
 if (completed.version !== p.deliveryTaskVersion || completed.version !== payload.expectedDeliveryTaskVersion) fail('DELIVERY_TASK_VERSION_CONFLICT');
 if (!object(basis.payload).planKeys || !(basis.payload.planKeys as string[]).includes(p.planKey) || p.catalogDigest !== CANONICAL_WEBSITE_SALES_CATALOG.sourceDigest) fail('CARE_CATALOG_OR_BASIS_CHANGED');
 const checked = proposeWebsiteSalesCare({ planKey: p.planKey, basis: record<WebsiteCareBasis>(basis, identity(session, c)) }, await context(tx, session, c, s), clock()); if (checked.status !== 'READY' || !checked.value || crmPayloadDigest(checked.value) !== crmPayloadDigest(p)) fail('CURRENT_CARE_PROPOSAL_REQUIRED');
 const previous = (await stored(tx, session, s.row!.id, 'CARE_OFFER')).find(row => row.payload.careProposalId === proposal.entityId && row.payload.careProposalDigest === proposal.digest);
 if (previous) return previous.payload;
 const buyer = await tx.queryOne<{ id: string; name: string; email: string }>('select id,name,email from contacts where workspace_id=$1 and project_id=$2 and organization_id=$3 and id=$4 and archived_at is null for update', [session.workspaceId, c.projectId, c.companyId, s.row!.contactId]);
 if (!buyer?.email) fail('CANONICAL_RECIPIENT_REQUIRED');
 // A consent change may commit while the contact lock is awaited. Check fresh suppression after that wait.
 assertAction(await state(tx, session, c, true));
 const stage = await tx.queryOne<{ name: string }>(`select s.name from projects p join crm_pipeline_stages s on s.workspace_id=p.workspace_id and s.project_id=p.id and s.pipeline_id=p.default_pipeline_id where p.workspace_id=$1 and p.id=$2 and s.category not in('won','lost','disqualified') order by s.position,s.id limit 1`, [session.workspaceId, c.projectId]);
 if (!stage) fail('PROJECT_PIPELINE_REQUIRED');
 const schedule = checked.value.schedule, first = schedule[0]!;
 const result = await upsertDealRecord({ session, idempotencyKey: childKey(c.idempotencyKey, 'care-deal'), deal: { projectId: c.projectId, organizationId: c.companyId, contactId: buyer.id, leadId: s.row!.leadId!, ownerUserId: session.userId, name: `${s.company.name}: ${p.planKey} care`.slice(0, 240), stage: stage.name as Deal['stage'], value: String(first.netMonthlyMinor / 100), probability: 0, expectedCloseDate: new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10), source: 'Website', nextAction: 'Review care draft; no customer commitment or renewal' } }, options);
 if (!result.persisted) fail('CARE_DEAL_NOT_PERSISTED');
 const terms = schedule.map(row => `Month ${row.fromMonth}${row.throughMonth ? `–${row.throughMonth}` : ' onwards'}: EUR ${(row.netMonthlyMinor / 100).toFixed(2)} net/month`).join('; ');
 const offered = await executeOfferCommand(session, { operation: 'create', projectId: c.projectId, dealId: result.data.id, expectedVersion: result.data.version ?? 1, idempotencyKey: childKey(c.idempotencyKey, 'care-offer'), correlationId: c.correlationId,
  payload: { leadId: s.row!.leadId, content: { subject: `${p.planKey} website care draft`, recipientName: buyer.name, recipientEmail: buyer.email, scope: `${p.planKey} care; operator-recorded need: ${String(basis.payload.need)}. No automatic renewal.`, paymentPlan: terms, discounts: 'None', specialTerms: 'Non-binding draft only. Final owner offer approval and separate contract authority required. No invoice or payment is created.', riskComplianceNotes: 'Basis is operator-recorded and a completed internal delivery task, not independently verified customer acceptance.', terms: 'Subject to final offer approval; no automatic renewal or contract execution.', validUntil: iso(proposal.validUntil), currency: 'EUR', taxBasis: 'NET', items: [{ description: `${p.planKey} monthly care (first scheduled month)`, quantity: 1, unitNetCents: first.netMonthlyMinor }] } } }, options);
 return { careProposalId: proposal.entityId, careProposalDigest: proposal.digest, dealId: result.data.id, offerId: offered.data.id, offerVersion: 1, catalogDigest: p.catalogDigest, deliveryTaskId: completed.id, deliveryTaskVersion: completed.version, validUntil: iso(proposal.validUntil), outboundEnabled: false, invoiceEnabled: false, contractExecutionEnabled: false, autoRenewalAllowed: false };
}

export type NormalizedWebsiteSalesAsset = { bytes: Uint8Array; mime: 'image/png' | 'image/jpeg' | 'image/webp'; width: number; height: number; byteSha256: string; originalSha256: string };
async function uploadAsset(tx: TenantTransaction, session: AppSession, c: WebsiteSalesEnablementCommand, s: State, p: Json, commandId: string, normalized?: NormalizedWebsiteSalesAsset) {
 if (!normalized) fail('ASSET_BYTES_REQUIRED', 400);
 if (normalized.bytes.byteLength < 1 || normalized.bytes.byteLength > 262144 || normalized.originalSha256 !== p.originalSha256 || normalized.byteSha256 !== createHash('sha256').update(normalized.bytes).digest('hex') || !['image/png', 'image/jpeg', 'image/webp'].includes(normalized.mime) || !Number.isSafeInteger(normalized.width) || !Number.isSafeInteger(normalized.height) || normalized.width < 1 || normalized.height < 1 || normalized.width > 4096 || normalized.height > 4096) fail('ASSET_NORMALIZATION_INVALID', 400);
 const assetId = randomUUID();
 await tx.execute(`insert into crm_website_sales_enablement_assets(id,workspace_id,project_id,company_id,location_id,workflow_id,version,role,title,alt,mime,width,height,original_sha256,original_size_bytes,byte_sha256,bytes_bytea,rights_reference,approved_by,valid_until,command_id)
  values($1,$2,$3,$4,$5,$6,1,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`, [assetId, session.workspaceId, c.projectId, c.companyId, c.locationId, s.row!.id, p.role, p.title, p.alt, normalized.mime, normalized.width, normalized.height, p.originalSha256, p.originalSizeBytes, normalized.byteSha256, Buffer.from(normalized.bytes), p.rightsReference, session.userId, p.validUntil, commandId]);
 return { ...p, assetId, byteSha256: normalized.byteSha256, mediaType: normalized.mime, width: normalized.width, height: normalized.height, rightsBasis: 'OPERATOR_ATTESTED' };
}

async function execute(session: AppSession, raw: WebsiteSalesEnablementCommand, options: TenantTransactionOptions, normalized?: NormalizedWebsiteSalesAsset) {
 const c = parseWebsiteSalesEnablementCommand(raw), command = websiteSalesEnablementCommandInput(session, raw);
 return withCrmCommandPreflight(session, command, async (outer, fresh) => {
  await project(outer, fresh, c.projectId, true);
  await outer.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [`website-sales-operations:${fresh.workspaceId}:${c.projectId}`]);
  if (sourceKinds.has(c.operation)) await owner(outer, fresh);
  const result = await executeCrmCommand(fresh, command, async (tx, context): Promise<WebsiteSalesEnablementEffect> => {
   const s = await state(tx, context.session, c, true), a = await aggregate(tx, context.session, s.row.id, true);
   if ((a?.version ?? 0) !== c.expectedVersion) fail('ENABLEMENT_VERSION_CONFLICT'); if (s.row.version !== c.expectedWorkflowVersion) fail('WORKFLOW_VERSION_CONFLICT');
   let p = object(parseWebsiteSalesEnablementPayload(c.operation, c.payload)), kind = '', entityId: string | undefined, derivedTaskId: string | undefined; let bindings: Json = {};
   if (sourceKinds.has(c.operation)) validSources(p);
   switch (c.operation) {
    case 'record_brief': kind = 'BRIEF'; break;
    case 'record_close_plan': {
     const rows = await contacts(tx, context.session, c, s), available = await tasks(tx, context.session, c, s);
     const plan = p as unknown as WebsiteClosePlan;
     for (const contact of plan.contacts) if (!rows.some(row => row.contactId === contact.contactId && row.active)) fail('CLOSE_PLAN_CONTACT_SCOPE_DENIED', 403);
     for (const milestone of plan.milestones) if (!available.some(row => row.taskId === milestone.taskId && row.version === milestone.taskVersion)) fail('CLOSE_PLAN_TASK_VERSION_CONFLICT');
     if (plan.nextStepTaskId && !available.some(row => row.taskId === plan.nextStepTaskId)) fail('CLOSE_PLAN_TASK_SCOPE_DENIED', 403);
     p = { ...p, contacts: plan.contacts.map(contact => { const actual = rows.find(row => row.contactId === contact.contactId)!; return { ...contact, contactVersion: actual.version, sourceDigest: actual.sourceDigest }; }) }; kind = 'CLOSE_PLAN'; break;
    }
    case 'register_reference': kind = 'REFERENCE'; break;
    case 'approve_reference': {
     const ref = await latest(tx, context.session, s.row.id, 'REFERENCE', String(p.referenceId));
     if (!ref || ref.version !== p.referenceVersion || ref.digest !== p.referenceDigest || !current(ref, s) || Date.parse(String(p.validUntil)) > Date.parse(iso(ref.validUntil))) fail('CURRENT_REFERENCE_REQUIRED');
     p = { ...p, approvalId: context.commandId, approvedBy: context.actorId, approvedAt: clock(), revokedAt: null }; kind = 'REFERENCE_APPROVAL'; break;
    }
    case 'revoke_reference': if (!await latest(tx, context.session, s.row.id, 'REFERENCE', String(p.referenceId))) fail('REFERENCE_NOT_FOUND', 404); kind = 'REFERENCE_REVOCATION'; break;
    case 'record_demo_profile': {
     // Validate referenced records before persisting a new immutable profile version.
     const approved = await reviews(tx, context.session, s.row.id), images = await assets(tx, context.session, c, s.row.id);
     for (const id of p.referenceCaseIds as string[]) { const ref = await latest(tx, context.session, s.row.id, 'REFERENCE', id); if (!ref || !current(ref, s) || ref.payload.disclosure !== 'APPROVED_CUSTOMER_PRESENTATION' || !approved.some(r => r.referenceId === id && r.referenceVersion === ref.version && r.referenceDigest === ref.digest && !r.revokedAt && Date.parse(r.validUntil) > Date.now())) fail('ENABLEMENT_REFERENCE_NOT_APPROVED'); }
     for (const id of p.assetIds as string[]) if (!images.some(image => image.assetId === id && !image.revokedAt && Date.parse(image.validUntil) > Date.now())) fail('ENABLEMENT_ASSET_NOT_APPROVED');
     kind = 'DEMO_PROFILE'; break;
    }
    case 'record_closure_reason': {
     const actualDeal = await dealBinding(tx, context.session, c, s, true); if (!actualDeal) fail('CANONICAL_CLOSED_DEAL_REQUIRED');
     const w = await canonicalWorkflow(tx, context.session, c, s); if (!['WON', 'LOST'].includes(w.status)) fail('CANONICAL_CLOSED_DEAL_REQUIRED');
     bindings = { dealId: actualDeal.dealId, dealVersion: actualDeal.version, outcome: w.status, dealSourceDigest: actualDeal.sourceDigest };
     if (p.offerVersion !== null) { const offer = await tx.queryOne<{ version: number }>('select version from crm_offers where workspace_id=$1 and project_id=$2 and id=$3', [fresh.workspaceId, c.projectId, s.row.offerDraftId]); if (!offer || Number(offer.version) !== p.offerVersion) fail('OFFER_VERSION_CONFLICT'); }
     kind = 'CLOSURE_REASON'; break;
    }
    case 'record_care_basis': await delivery(tx, context.session, c, s.row.id, String(p.canonicalDeliveryTaskId)); if (p.renewal) await acceptedCareOffer(tx, context.session, c, s.row.id, String(object(p.renewal).canonicalAcceptedCareOfferId)); kind = 'CARE_BASIS'; break;
    case 'prepare_care_offer': p = await careOffer(tx, context.session, c, s, p, options); kind = 'CARE_OFFER'; break;
    case 'upload_asset': p = await uploadAsset(tx, context.session, c, s, p, context.commandId, normalized); kind = 'ASSET_UPLOAD'; break;
    case 'revoke_asset': if (!(await assets(tx, context.session, c, s.row.id)).some(row => row.assetId === p.assetId)) fail('ASSET_NOT_FOUND', 404); kind = 'ASSET_REVOCATION'; break;
    case 'propose_next_step': case 'propose_care': case 'scan_hygiene': case 'annotate_hygiene': {
     const derived = await derive(tx, context.session, c, s, p); p = derived.payload; kind = derived.kind; entityId = derived.entityId; derivedTaskId = derived.taskId; break;
    }
   }
   const effect = await persist(tx, context.session, c, s, a, kind, p, context.commandId, entityId, bindings);
   return { ...effect, ...(derivedTaskId ? { taskId: derivedTaskId } : typeof p.taskId === 'string' ? { taskId: p.taskId } : {}), ...(typeof p.assetId === 'string' ? { assetId: p.assetId } : {}), ...(typeof p.dealId === 'string' ? { dealId: p.dealId } : {}), ...(typeof p.offerId === 'string' ? { offerId: p.offerId, offerVersion: Number(p.offerVersion) } : {}) };
  }, options);
  // Callback is skipped for stored replay. Refresh current actor/resource rights and current facts separately.
  await state(outer, fresh, c);
  const currentData = websiteSalesMachineHasScope(fresh, c, 'crm.website-sales.enablement.read') ? await read(outer, fresh, c) : undefined;
  return { ...result, contractVersion: websiteSalesEnablementContract, persisted: true as const, correlationId: c.correlationId, ...(currentData ? { currentData } : {}) };
 }, options);
}
export async function executeWebsiteSalesEnablementCommand(session: AppSession, raw: WebsiteSalesEnablementCommand, options: TenantTransactionOptions = {}) { return execute(session, raw, options); }
export async function executeWebsiteSalesAssetUpload(session: AppSession, raw: WebsiteSalesEnablementCommand, normalized: NormalizedWebsiteSalesAsset, options: TenantTransactionOptions = {}) {
 if (raw.operation !== 'upload_asset') fail('INVALID_ASSET_COMMAND', 400); return execute(session, raw, options, normalized);
}
export async function reconcileWebsiteSalesEnablementCommand(session: AppSession, raw: WebsiteSalesEnablementCommand, options: TenantTransactionOptions = {}) {
 const c = parseWebsiteSalesEnablementCommand(raw), command = websiteSalesEnablementCommandInput(session, raw);
 websiteSalesEnablementSourceAuthority(session, c);
 return withCrmCommandPreflight(session, command, async (tx, fresh) => { await state(tx, fresh, c); if (sourceKinds.has(c.operation)) await owner(tx, fresh); const receipt = await reconcileCrmCommand<WebsiteSalesEnablementEffect>(fresh, command, options); return receipt.status === 'COMMITTED' ? { ...receipt, currentData: await read(tx, fresh, c) } : receipt; }, options);
}
