import 'server-only';
import type { AppSession } from '../auth/session';
import type { TenantTransaction } from '../crm-command';
import { websiteSalesMachineHasScope } from '../website-sales-machine-authority';
import { advisoryGroundedFactSchema, type AdvisoryGroundedFact, type AdvisoryReference } from '../website-sales-advisory-types';
import { advisoryDigest } from '../website-sales-advisory-domain';
import { advisoryRows, advisoryRecord, advisoryIdentity as identity, advisoryParams as params, advisoryIso as iso, type AdvisoryScope as Scope, type AdvisoryJson as Json } from './website-sales-advisory-storage';
import { advisoryCanonicalParent } from './website-sales-advisory-sources';

const stableId = (value: unknown) => { const h = advisoryDigest(value); return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`; };
export async function advisoryGroundedFacts(tx: TenantTransaction, s: AppSession, b: Scope): Promise<AdvisoryGroundedFact[]> {
 const result: AdvisoryGroundedFact[] = [];
 const add = (ref: AdvisoryReference, text: string, validUntil: string, observedAt: string, category: AdvisoryGroundedFact['category'], approvalRef: AdvisoryReference | null = null) => {
  const sourceReference = { id: ref.id, reference: `crm-current-record:${ref.id}:v${ref.version}`, digest: ref.digest, basis: 'CANONICAL_CRM', observedAt, validUntil };
  const parsed = advisoryGroundedFactSchema.safeParse({ id: stableId([ref, text]), identity: identity(s, b), workflowId: b.workflowId, text: text.slice(0, 2000), sourceReference, evidenceRef: ref, category, visibility: approvalRef ? 'APPROVED_CUSTOMER' : 'INTERNAL', approvalRef });
  if (parsed.success && !result.some(fact => fact.id === parsed.data.id)) result.push(parsed.data);
 };
 const sourceRead=websiteSalesMachineHasScope(s,b,'crm.website-sales.enablement.read');
 const parents = sourceRead?await tx.query<{ id: string; kind: 'BRIEF'; version: number; digest: string }>(`select entity_id as id,kind,version,record_digest as digest from crm_website_sales_enablement_records where workspace_id=$1 and project_id=$2 and company_id=$3 and location_id=$4 and workflow_id=$5 and kind='BRIEF' order by aggregate_version desc limit 1`, params(s, b)):[];
 if (sourceRead) for (const ref of parents) {
  try { const parent = await advisoryCanonicalParent(tx, s, b, { id: ref.id, version: Number(ref.version), digest: ref.digest }, 'BRIEF'); for (const text of [...parent.data.goals as string[], ...parent.data.services as string[]]) add(parent.reference, text, new Date(Math.min(Date.parse(parent.validUntil!), ...(parent.data.sourceReferences as Json[]).map(source => Date.parse(String(source.validUntil))))).toISOString(), String(parent.data.sourceObservedAt), 'INTERNAL_CUSTOMER_FACT'); } catch (error) { if (!(error instanceof Error && 'code' in error && ['ADVISORY_CURRENT_SOURCE_REQUIRED', 'ADVISORY_SOURCE_NOT_CURRENT'].includes(String(error.code)))) throw error; }
 }
 if (websiteSalesMachineHasScope(s, b, 'crm.website-sales.studio.read')) {
  const demo = await tx.queryOne<{ id: string; version: number; digest: string }>(`select id,version,artifact_digest as digest from crm_website_studio_artifacts where workspace_id=$1 and project_id=$2 and company_id=$3 and location_id=$4 and workflow_id=$5 and kind='DEMO' order by version desc limit 1`, params(s, b));
  if (demo) try {
   const parent = await advisoryCanonicalParent(tx, s, b, { id: demo.id, version: Number(demo.version), digest: demo.digest }, 'DEMO'), content = parent.data.content as Json;
   const fields = [content.hero, ...(Array.isArray(content.sections) ? (content.sections as Json[]).map(section => section.body) : [])];
   for (const value of fields) if (value && typeof value === 'object' && typeof (value as Json).text === 'string') add(parent.reference, `Proposed website feature: ${(value as Json).text}`, parent.validUntil!, String(parent.data.sourceObservedAt), 'DEMO_FEATURE');
  } catch (error) { if (!(error instanceof Error && 'code' in error && String(error.code).match(/(?:NOT_CURRENT|CHANGED|NOT_APPROVED|CURRENT_DEMO_REQUIRED|EXPIRED)/))) throw error; }
 }
 const refs = sourceRead?await tx.query<{ id: string; version: number; digest: string; payload: Json; validUntil: string; approvalId: string; approvalVersion: number; approvalDigest: string; approvalUntil: string; createdAt: string }>(`select r.entity_id as id,r.version,r.record_digest as digest,r.payload,r.valid_until as "validUntil",a.entity_id as "approvalId",a.version as "approvalVersion",a.record_digest as "approvalDigest",a.valid_until as "approvalUntil",r.created_at as "createdAt" from (select *,row_number() over(partition by entity_id order by version desc) as n from crm_website_sales_enablement_records where workspace_id=$1 and project_id=$2 and company_id=$3 and location_id=$4 and workflow_id=$5 and kind='REFERENCE') r join lateral(select a.* from crm_website_sales_enablement_records a join workspace_users u on u.workspace_id=a.workspace_id and u.id=a.created_by and u.status='active' and u.role='owner' where a.workspace_id=r.workspace_id and a.workflow_id=r.workflow_id and a.kind='REFERENCE_APPROVAL' and a.payload->>'referenceId'=r.entity_id::text and a.payload->>'referenceDigest'=r.record_digest and a.valid_until>clock_timestamp() order by a.aggregate_version desc limit 1) a on true where r.n=1 and r.payload->>'disclosure'='APPROVED_CUSTOMER_PRESENTATION' and r.valid_until>clock_timestamp() and not exists(select 1 from crm_website_sales_enablement_records v where v.workspace_id=r.workspace_id and v.workflow_id=r.workflow_id and v.kind='REFERENCE_REVOCATION' and v.payload->>'referenceId'=r.entity_id::text and v.aggregate_version>a.aggregate_version) order by r.aggregate_version desc limit 20`, params(s, b)):[];
 if (sourceRead) for (const ref of refs) {
  const claims = ref.payload.claims as Json[], until = new Date(Math.min(Date.parse(iso(ref.validUntil)), Date.parse(iso(ref.approvalUntil)))).toISOString();
  for (const claim of claims) if ((claim.sourceReferences as Json[]).every(source => Date.parse(String(source.observedAt)) <= Date.now() && Date.parse(String(source.validUntil)) > Date.now())) add({ id: ref.id, version: Number(ref.version), digest: ref.digest }, String(claim.text), new Date(Math.min(Date.parse(until), ...(claim.sourceReferences as Json[]).map(source => Date.parse(String(source.validUntil))))).toISOString(), iso(ref.createdAt), 'APPROVED_REFERENCE', { id: ref.approvalId, version: Number(ref.approvalVersion), digest: ref.approvalDigest });
 }
 for (const row of await advisoryRows(tx, s, b, 'KNOWLEDGE')) {
  if (Date.parse(iso(row.validUntil)) <= Date.now()) continue;
  const record = advisoryRecord(row, s, b);const approved=(await advisoryRows(tx,s,b,'KNOWLEDGE_APPROVAL')).some(a=>advisoryDigest(a.payload.recordRef)===advisoryDigest({id:record.id,version:record.version,digest:record.digest})&&Date.parse(iso(a.validUntil))>Date.now());if(!approved)continue; add({ id: record.id, version: record.version, digest: record.digest }, String(record.payload.content), record.validUntil!, record.createdAt, 'INTERNAL_CUSTOMER_FACT');
 }
 return result.slice(0, 100);
}
