import 'server-only';
import { randomUUID } from 'node:crypto';
import type { AppSession } from '../auth/session';
import { assertProjectGrant, CrmCommandError, type TenantTransaction } from '../crm-command';
import { websiteSalesResourceAuthority, websiteSalesMachineHasScope, websiteSalesResourceReadScopes } from '../website-sales-machine-authority';
import { websiteSalesIrelandState } from './website-sales-ireland-repositories';
import { advisoryRecordDigest, verifyAdvisoryRecord } from '../website-sales-advisory-domain';
import type { AdvisoryIdentity, AdvisoryRecord, AdvisoryReference } from '../website-sales-advisory-types';

export type AdvisoryScope = { projectId: string; companyId: string; locationId: string; workflowId: string };
export type AdvisoryJson = Record<string, unknown>;
export type AdvisoryAggregate = { id: string; version: number };
export type AdvisoryRow = { rowId: string; id: string; kind: AdvisoryRecord['kind']; version: number; aggregateVersion: number; workflowVersion: number;
 evidenceDigest: string; digest: string; payload: AdvisoryJson; bindings: AdvisoryJson; createdBy: string; createdAt: string; validUntil: string };
export const advisoryNow = () => new Date().toISOString();
export const advisoryIso = (value: string | Date) => new Date(value).toISOString();
export function advisoryFail(code: string, status = 409): never { throw new CrmCommandError(code, code, status); }
export const advisoryIdentity = (s: { workspaceId: string }, b: AdvisoryScope): AdvisoryIdentity => ({ workspaceId: s.workspaceId, projectId: b.projectId, companyId: b.companyId, locationId: b.locationId });
export const advisoryParams = (s: { workspaceId: string }, b: AdvisoryScope) => [s.workspaceId, b.projectId, b.companyId, b.locationId, b.workflowId];
export const advisoryColumns = `id as "rowId",entity_id as id,kind,version,aggregate_version as "aggregateVersion",workflow_version as "workflowVersion",evidence_digest as "evidenceDigest",record_digest as digest,payload,canonical_bindings as bindings,created_by as "createdBy",created_at as "createdAt",valid_until as "validUntil"`;
export async function advisoryOwner(tx: TenantTransaction, s: AppSession) {
 if (s.serviceIdentity || !(await tx.queryOne<{ ok: boolean }>('select crm_sales_ops_owner($1) as ok', [s.workspaceId]))?.ok) advisoryFail('ADVISORY_OWNER_REQUIRED', 403);
}
export async function advisoryProject(tx: TenantTransaction, s: AppSession, b: AdvisoryScope, write = false) {
 websiteSalesResourceAuthority(s, b); await assertProjectGrant(tx, s, b.projectId, write);
 if (!await tx.queryOne(`select p.id from projects p join workspaces w on w.id=p.workspace_id where p.workspace_id=$1 and p.id=$2 and p.division='WEB_DESIGN' and p.data_classification='NOVALURE_INTERNAL' and p.data_purpose='crm_sales' and w.operating_model='novalure_internal'`, [s.workspaceId, b.projectId])) advisoryFail('ADVISORY_PROJECT_DENIED', 403);
}
export async function advisoryProjectLock(tx: TenantTransaction, s: AppSession, b: AdvisoryScope) {
 await tx.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [`website-sales-operations:${s.workspaceId}:${b.projectId}`]);
}
export async function advisoryState(tx: TenantTransaction, s: AppSession, b: AdvisoryScope, lock = false) {
 await advisoryProject(tx, s, b);
 const state = await websiteSalesIrelandState(tx, s, b, lock);
 if (!state.row || !state.current.workflow || state.row.id !== b.workflowId) advisoryFail('ADVISORY_WORKFLOW_NOT_FOUND', 404);
 return state as typeof state & { row: NonNullable<typeof state.row>; current: typeof state.current & { workflow: NonNullable<typeof state.current.workflow> } };
}
export function advisoryAction(state: Awaited<ReturnType<typeof advisoryState>>) {
 const reason = state.current.workflow.blockedReason;
 if (reason && reason !== 'REPLY_RECEIVED') advisoryFail(reason);
}
export function advisoryReadAuthority(s: AppSession, b: AdvisoryScope) {
 if (!websiteSalesMachineHasScope(s, b, 'crm.website-sales.advisory.read')) advisoryFail('ADVISORY_READ_SCOPE_REQUIRED', 403);
}
export async function advisoryAggregate(tx: TenantTransaction, s: { workspaceId: string }, b: AdvisoryScope, lock = false) {
 const row = await tx.queryOne<AdvisoryAggregate>(`select id,version from crm_website_sales_advisory where workspace_id=$1 and project_id=$2 and company_id=$3 and location_id=$4 and workflow_id=$5 ${lock ? 'for update' : ''}`, advisoryParams(s, b));
 return row ? { ...row, version: Number(row.version) } : null;
}
export async function advisoryRows(tx: TenantTransaction, s: { workspaceId: string }, b: AdvisoryScope, kind?: string) {
 const allowed='serviceIdentity' in s && s.serviceIdentity ? websiteSalesResourceReadScopes(s as AppSession,b.projectId):null;
 const allowedIdentity=`i->>'workspaceId' is distinct from $1::text or i->>'projectId' is distinct from $2::text or not exists(select 1 from jsonb_array_elements($${kind?7:6}::jsonb) a where a->>'companyId'=i->>'companyId' and a->>'locationId'=i->>'locationId')`;
 const privacy=allowed?`and not exists(select 1 from jsonb_path_query(payload,'$.**.identity') i where ${allowedIdentity}) and not exists(select 1 from jsonb_array_elements(coalesce(canonical_bindings->'parentRefs','[]'::jsonb)) ref join crm_website_sales_advisory_records parent on parent.workspace_id=$1 and parent.project_id=$2 and parent.entity_id=(ref->>'id')::uuid and parent.version=(ref->>'version')::integer and parent.record_digest=ref->>'digest' cross join lateral jsonb_path_query(parent.payload,'$.**.identity') i where ${allowedIdentity})`:'';
 const rows = await tx.query<AdvisoryRow>(`select ${advisoryColumns} from crm_website_sales_advisory_records where workspace_id=$1 and project_id=$2 and company_id=$3 and location_id=$4 and workflow_id=$5 ${kind ? 'and kind=$6' : ''} ${privacy} order by aggregate_version desc limit 201`, [...advisoryParams(s, b), ...(kind ? [kind] : []),...(allowed?[JSON.stringify(allowed)]:[])]);
 return rows.map(r => ({ ...r, version: Number(r.version), workflowVersion: Number(r.workflowVersion), aggregateVersion: Number(r.aggregateVersion) }));
}
export function advisoryRecord(row: AdvisoryRow, s: { workspaceId: string }, b: AdvisoryScope): AdvisoryRecord {
 return { id: row.id, identity: advisoryIdentity(s, b), workflowId: b.workflowId, kind: row.kind, version: row.version, workflowVersion: row.workflowVersion,
  digest: row.digest, createdBy: row.createdBy, createdAt: advisoryIso(row.createdAt), validUntil: advisoryIso(row.validUntil), revokedAt: null,
  parentRefs: row.bindings.parentRefs as AdvisoryReference[] ?? [], payload: row.payload };
}
export async function advisoryBoundRecord(tx: TenantTransaction, s: AppSession, b: AdvisoryScope, ref: AdvisoryReference, kinds?: readonly string[]) {
 const row = await tx.queryOne<AdvisoryRow>(`select ${advisoryColumns} from crm_website_sales_advisory_records where workspace_id=$1 and project_id=$2 and company_id=$3 and location_id=$4 and workflow_id=$5 and entity_id=$6 order by version desc limit 1`, [...advisoryParams(s, b), ref.id]);
 if (!row || Number(row.version) !== ref.version || row.digest !== ref.digest || kinds && !kinds.includes(row.kind)) advisoryFail('ADVISORY_CURRENT_RECORD_REQUIRED');
 const state = await advisoryState(tx, s, b), record = advisoryRecord({ ...row, version: Number(row.version), workflowVersion: Number(row.workflowVersion) }, s, b);
 if (row.evidenceDigest !== state.row.evidenceDigest) advisoryFail('ADVISORY_EVIDENCE_CHANGED');
 verifyAdvisoryRecord(record, { identity: advisoryIdentity(s, b), workflowId: b.workflowId, workflowVersion: state.row.version }, advisoryNow()); return { row, record };
}
export async function advisoryAdvance(tx: TenantTransaction, s: AppSession, b: AdvisoryScope, prior: AdvisoryAggregate | null, commandId: string) {
 const id = prior?.id ?? randomUUID(), version = (prior?.version ?? 0) + 1;
 if (prior) { if (!await tx.queryOne('update crm_website_sales_advisory set version=$4,last_command_id=$5,updated_at=clock_timestamp() where workspace_id=$1 and id=$2 and version=$3 returning id', [s.workspaceId, id, prior.version, version, commandId])) advisoryFail('ADVISORY_VERSION_CONFLICT'); }
 else await tx.execute('insert into crm_website_sales_advisory(id,workspace_id,project_id,company_id,location_id,workflow_id,version,last_command_id,created_by) values($1,$2,$3,$4,$5,$6,$7,$8,$9)', [id, ...advisoryParams(s, b), version, commandId, s.userId]);
 return { id, version };
}
export async function advisoryPersist(tx: TenantTransaction, s: AppSession, b: AdvisoryScope, aggregate: AdvisoryAggregate, workflowVersion: number, evidenceDigest: string,
 kind: AdvisoryRecord['kind'], payload: AdvisoryJson, commandId: string, options: { entityId?: string; parentRefs?: AdvisoryReference[]; validUntil?: string; confidence?: 'OPERATOR_RECORDED' | 'SERVER_DERIVED' | 'MODEL_DRAFT'; bindings?: AdvisoryJson } = {}) {
 const prior = options.entityId ? (await advisoryRows(tx, s, b, kind)).find(r => r.id === options.entityId) : null;
 const validUntil = options.validUntil ?? (typeof payload.validUntil === 'string' ? payload.validUntil : new Date(Date.now() + 86400000).toISOString());
 const record: AdvisoryRecord = { id: options.entityId ?? randomUUID(), identity: advisoryIdentity(s, b), workflowId: b.workflowId, kind, version: (prior?.version ?? 0) + 1,
  workflowVersion, digest: '', createdBy: s.userId, createdAt: advisoryNow(), validUntil, revokedAt: null, parentRefs: options.parentRefs ?? [], payload };
 record.digest = advisoryRecordDigest(record); const rowId = randomUUID();
 await tx.execute(`insert into crm_website_sales_advisory_records(id,workspace_id,project_id,company_id,location_id,workflow_id,advisory_id,aggregate_version,entity_id,version,kind,workflow_version,evidence_digest,payload,canonical_bindings,record_digest,previous_digest,source_confidence,created_by,command_id,created_at,valid_until)
  values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15::jsonb,$16,$17,$18,$19,$20,$21,$22)`, [rowId, ...advisoryParams(s, b), aggregate.id, aggregate.version, record.id, record.version, kind, workflowVersion, evidenceDigest, JSON.stringify(payload), JSON.stringify({ ...options.bindings, parentRefs: record.parentRefs }), record.digest, prior?.digest ?? null, options.confidence ?? 'SERVER_DERIVED', s.userId, commandId, record.createdAt, validUntil]);
 return { rowId, record };
}
