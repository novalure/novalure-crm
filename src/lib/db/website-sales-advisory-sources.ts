import 'server-only';
import type { AppSession } from '../auth/session';
import type { TenantTransaction } from '../crm-command';
import { crmPayloadDigest } from '../crm-command';
import { websiteSalesEnablementSourceAuthority, websiteSalesMachineHasScope, websiteSalesResourceReadScopes } from '../website-sales-machine-authority';
import { assertWebsiteSalesStudioSourceBindings } from './website-sales-studio-source-bindings';
import { verifyWebsiteStudioArtifact, type WebsiteStudioArtifact } from '../website-sales-studio';
import { verifyWebsiteStudioQaCertificate } from '../website-sales-studio-qa';
import { websiteProspectInputSchema } from '../website-prospect';
import { advisoryReferenceSchema, advisoryCohortMemberSchema, type AdvisoryReference, type AdvisorySource } from '../website-sales-advisory-types';
import { advisoryFail as fail, advisoryIdentity as identity, advisoryParams as params, advisoryIso as iso, advisoryState, type AdvisoryScope as Scope, type AdvisoryJson as Json } from './website-sales-advisory-storage';

export type AdvisoryCanonicalParent = { reference: AdvisoryReference; identity: ReturnType<typeof identity>; workflowId: string; workflowVersion: number;
 kind: 'BRIEF' | 'CLOSE_PLAN' | 'DEMO' | 'ASSET' | 'OFFER'; label: string; validUntil: string | null; revokedAt: string | null; data: Json };
export async function advisoryCanonicalOffers(tx: TenantTransaction, s: AppSession, b: Scope) {
 return tx.query<{ id: string; revision: number; digest: string; netMinor: string; status: string; content: Json; version: number; observedAt: string }>(`select o.id,o.version,o.revision,r.content_digest as digest,r.total_net_cents as "netMinor",o.status,r.content,r.created_at as "observedAt" from crm_offers o join crm_offer_revisions r on r.workspace_id=o.workspace_id and r.offer_id=o.id and r.revision=o.revision
 where o.workspace_id=$1 and o.project_id=$2 and o.organization_id=$3 and(o.id=(select offer_draft_id from crm_website_sales_workflows where workspace_id=$1 and location_id=$4 and id=$5) or exists(select 1 from crm_website_sales_enablement_records e where e.workspace_id=o.workspace_id and e.project_id=o.project_id and e.company_id=$3 and e.location_id=$4 and e.workflow_id=$5 and e.kind='CARE_OFFER' and e.payload->>'offerId'=o.id::text)) order by o.created_at desc,o.id limit 20`, params(s, b));
}
export async function advisoryCanonicalParent(tx: TenantTransaction, s: AppSession, b: Scope, ref: AdvisoryReference, kind: AdvisoryCanonicalParent['kind']): Promise<AdvisoryCanonicalParent> {
 const state = await advisoryState(tx, s, b), base = { identity: identity(s, b), workflowId: b.workflowId, workflowVersion: state.row.version, reference: ref, kind, revokedAt: null };
 if (kind === 'OFFER') {
  const row = (await advisoryCanonicalOffers(tx, s, b)).find(row => row.id === ref.id && Number(row.revision) === ref.version && row.digest === ref.digest);
  if (!row || !Number.isSafeInteger(Number(row.netMinor)) || row.content.currency !== 'EUR' || row.content.taxBasis !== 'NET') fail('ADVISORY_CURRENT_OFFER_REQUIRED');
  return { ...base, label: String(row.content.subject).slice(0, 200), validUntil: String(row.content.validUntil), data: { ...row.content, offerRef: ref, totalNetMinor: Number(row.netMinor), netMinor: Number(row.netMinor), status: row.status, canonicalVersion: Number(row.version), sourceObservedAt: iso(row.observedAt) } };
 }
 if (kind === 'BRIEF' || kind === 'CLOSE_PLAN') {
  websiteSalesEnablementSourceAuthority(s, b);
  const row = await tx.queryOne<{ id: string; version: number; digest: string; workflowVersion: number; payload: Json; validUntil: string; createdAt: string }>(`select entity_id as id,version,record_digest as digest,workflow_version as "workflowVersion",payload,valid_until as "validUntil",created_at as "createdAt" from crm_website_sales_enablement_records where workspace_id=$1 and project_id=$2 and company_id=$3 and location_id=$4 and workflow_id=$5 and kind=$6 order by aggregate_version desc limit 1`, [...params(s, b), kind]);
  if (!row || row.id !== ref.id || Number(row.version) !== ref.version || row.digest !== ref.digest || Number(row.workflowVersion) > state.row.version || Date.parse(iso(row.validUntil)) <= Date.now()) fail('ADVISORY_CURRENT_SOURCE_REQUIRED');
  await advisoryValidateSources(tx, s, b, row.payload);
  return { ...base, workflowVersion: Number(row.workflowVersion), label: kind === 'BRIEF' ? 'Current customer brief' : 'Current close plan', validUntil: iso(row.validUntil), data: { ...row.payload, sourceObservedAt: iso(row.createdAt) } };
 }
 if (kind === 'DEMO') {
  if (!websiteSalesMachineHasScope(s, b, 'crm.website-sales.studio.read')) fail('ADVISORY_STUDIO_READ_REQUIRED', 403);
  const row = await tx.queryOne<{ id: string; version: number; digest: string; artifact: WebsiteStudioArtifact; evidenceDigest: string; validUntil: string }>(`select id,version,artifact_digest as digest,artifact,evidence_digest as "evidenceDigest",valid_until as "validUntil" from crm_website_studio_artifacts where workspace_id=$1 and project_id=$2 and company_id=$3 and location_id=$4 and workflow_id=$5 and kind='DEMO' order by version desc limit 1`, params(s, b));
  if (!row || row.id !== ref.id || Number(row.version) !== ref.version || row.digest !== ref.digest || row.evidenceDigest !== state.row.evidenceDigest || Date.parse(iso(row.validUntil)) <= Date.now()) fail('ADVISORY_CURRENT_DEMO_REQUIRED');
  const checked = verifyWebsiteStudioArtifact(row.artifact, websiteProspectInputSchema.parse(state.row.prospect), new Date().toISOString()); await assertWebsiteSalesStudioSourceBindings(tx, s, checked);
  // Binary/HTML bodies never enter advisory transcripts, model context or public packets.
  const content = checked.kind === 'DEMO' ? checked.content.concept.content : {};
  return { ...base, label: 'Current website demo', validUntil: iso(row.validUntil), data: { title: 'Current website demo', evidenceDigest: row.evidenceDigest, content, artifactDigest: row.digest, sourceObservedAt: checked.createdAt } };
 }
 if (kind === 'ASSET') {
  websiteSalesEnablementSourceAuthority(s, b);
  const r = await tx.queryOne<{ id: string; version: number; role: string; title: string; alt: string; mediaType: string; sha256: string; sizeBytes: number; width: number; height: number; rightsReference: string; approvedBy: string; approvedAt: string; validUntil: string }>(`select a.id,a.version,a.role,a.title,a.alt,a.mime as "mediaType",a.byte_sha256 as sha256,octet_length(a.bytes_bytea) as "sizeBytes",a.width,a.height,a.rights_reference as "rightsReference",a.approved_by as "approvedBy",a.approved_at as "approvedAt",a.valid_until as "validUntil" from crm_website_sales_enablement_assets a where a.workspace_id=$1 and a.project_id=$2 and a.company_id=$3 and a.location_id=$4 and a.workflow_id=$5 and a.id=$6 and a.valid_until>clock_timestamp() and not exists(select 1 from crm_website_sales_enablement_records v where v.workspace_id=a.workspace_id and v.workflow_id=a.workflow_id and v.kind='ASSET_REVOCATION' and v.payload->>'assetId'=a.id::text)`, [...params(s, b), ref.id]);
  if (!r) fail('ADVISORY_CURRENT_ASSET_REQUIRED');
  const asset = { assetId: r.id, identity: identity(s, b), version: Number(r.version), role: r.role, title: r.title, alt: r.alt, mediaType: r.mediaType, sha256: r.sha256, sizeBytes: Number(r.sizeBytes), width: r.width, height: r.height, rightsReference: r.rightsReference, rightsBasis: 'OPERATOR_ATTESTED', approvedBy: r.approvedBy, approvedAt: iso(r.approvedAt), validUntil: iso(r.validUntil) };
  if (asset.version !== ref.version || crmPayloadDigest(asset) !== ref.digest) fail('ADVISORY_CURRENT_ASSET_REQUIRED');
  return { ...base, label: asset.title, validUntil: asset.validUntil, data: asset };
 }
 fail('ADVISORY_SOURCE_KIND_NOT_SUPPORTED');
}
export async function advisoryValidateSources(tx: TenantTransaction, s: AppSession, b: Scope, raw: unknown) {
 const visit = async (value: unknown): Promise<void> => {
  if (Array.isArray(value)) { for (const item of value) await visit(item); return; } if (!value || typeof value !== 'object') return;
  const p = value as Json;
  if(typeof p.basis==='string'&&typeof p.observedAt==='string'&&typeof p.validUntil==='string'&&typeof p.digest==='string'){
   const source=p as unknown as AdvisorySource;if(Date.parse(source.observedAt)>Date.now()||Date.parse(source.validUntil)<=Date.now())fail('ADVISORY_SOURCE_NOT_CURRENT');
   if(!['OPERATOR_RECORDED','CUSTOMER_STATEMENT_RECORDED','OPERATOR_ATTESTATION','CUSTOMER_AGREEMENT_RECORDED'].includes(source.basis)){
    if(source.basis==='APPROVED_KNOWLEDGE'){
     if(!await tx.queryOne(`select r.id from crm_website_sales_advisory_records r where r.workspace_id=$1 and r.project_id=$2 and r.company_id=$3 and r.location_id=$4 and r.workflow_id=$5 and r.kind='KNOWLEDGE' and r.entity_id=$6 and r.record_digest=$7 and r.valid_until>clock_timestamp() and exists(select 1 from crm_website_sales_advisory_records a where a.workspace_id=r.workspace_id and a.workflow_id=r.workflow_id and a.kind='KNOWLEDGE_APPROVAL' and a.payload#>>'{recordRef,id}'=r.entity_id::text and a.payload#>>'{recordRef,digest}'=r.record_digest and a.valid_until>clock_timestamp())`,[...params(s,b),source.id,source.digest]))fail('ADVISORY_SOURCE_RESOLVER_REQUIRED',400);
    }else if(source.basis==='CANONICAL_CRM'){
     if(!await tx.queryOne(`select r.id from crm_website_sales_advisory_records r where r.workspace_id=$1 and r.project_id=$2 and r.company_id=$3 and r.location_id=$4 and r.workflow_id=$5 and r.entity_id=$6 and r.record_digest=$7 and r.valid_until>clock_timestamp() union all select r.id from crm_website_sales_enablement_records r where r.workspace_id=$1 and r.project_id=$2 and r.company_id=$3 and r.location_id=$4 and r.workflow_id=$5 and r.entity_id=$6 and r.record_digest=$7 and r.valid_until>clock_timestamp() limit 1`,[...params(s,b),source.id,source.digest]))fail('ADVISORY_SOURCE_RESOLVER_REQUIRED',400);
    }else fail('ADVISORY_SOURCE_RESOLVER_REQUIRED',400);
   }
  }
  for (const item of Object.values(p)) await visit(item);
 };
 await visit(raw);
}
export async function advisoryCohortCandidates(tx: TenantTransaction, s: AppSession, b: Scope) {
 const verified = websiteSalesResourceReadScopes(s, b.projectId), pairs = verified ?? [{ companyId: b.companyId, locationId: b.locationId }];
 const rows = await tx.query<{ companyId: string; locationId: string; workflowId: string; workflowVersion: number; sourceDigest: string; createdAt: string; label: string; category: string; closedAt: string | null; value: string | null }>(`select w.company_id as "companyId",w.location_id as "locationId",w.id as "workflowId",w.version as "workflowVersion",obs.evidence_digest as "sourceDigest",w.created_at as "createdAt",o.name||' · '||l.address as label,coalesce(ps.category,'unknown') as category,d.closed_at as "closedAt",d.value_cents as value from crm_website_sales_workflows w join crm_website_sales_observations obs on obs.workspace_id=w.workspace_id and obs.project_id=w.project_id and obs.company_id=w.company_id and obs.location_id=w.location_id and obs.id=w.observation_id join organizations o on o.workspace_id=w.workspace_id and o.id=w.company_id join crm_company_locations l on l.workspace_id=w.workspace_id and l.id=w.location_id left join deals d on d.workspace_id=w.workspace_id and d.id=w.deal_id left join crm_pipeline_stages ps on ps.workspace_id=d.workspace_id and ps.project_id=w.project_id and ps.name=d.stage and ps.pipeline_id=(select default_pipeline_id from projects where workspace_id=w.workspace_id and id=w.project_id) where w.workspace_id=$1 and w.project_id=$2 ${verified ? 'and exists(select 1 from jsonb_to_recordset($3::jsonb) as p("companyId" uuid,"locationId" uuid) where p."companyId"=w.company_id and p."locationId"=w.location_id)' : ''} order by w.created_at,w.id limit 51`, [s.workspaceId, b.projectId, ...(verified ? [JSON.stringify(pairs)] : [])]);
 return rows.map(row => ({ ...row, identity: { workspaceId: s.workspaceId, projectId: b.projectId, companyId: row.companyId, locationId: row.locationId }, workflowVersion: Number(row.workflowVersion), assignedAt: iso(row.createdAt), label: row.label.slice(0, 200), originDigest: crmPayloadDigest({ workflowId: row.workflowId, assignedAt: iso(row.createdAt), identity: { workspaceId: s.workspaceId, projectId: b.projectId, companyId: row.companyId, locationId: row.locationId } }), sourceDigest: row.sourceDigest, closedAt: row.closedAt ? iso(row.closedAt) : null, valueMinor: row.value === null ? null : Number(row.value) }));
}
export async function advisoryForecastOrigins(tx: TenantTransaction, s: AppSession, b: Scope) {
 const verified = websiteSalesResourceReadScopes(s, b.projectId);
 const rows = await tx.query<{ companyId: string; locationId: string; workflowId: string; workflowVersion: number; sourceDigest: string; createdAt: string; label: string; treatmentRef: unknown }>(`select a.company_id as "companyId",a.location_id as "locationId",a.workflow_id as "workflowId",a.workflow_version as "workflowVersion",a.assignment_digest as "sourceDigest",r.created_at as "createdAt",o.name||' · '||l.address as label,r.payload#>'{value,treatmentRef}' as "treatmentRef" from crm_website_sales_advisory_assignments a join crm_website_sales_advisory_records r on r.workspace_id=a.workspace_id and r.workflow_id=a.workflow_id and r.kind='EXPERIMENT_ASSIGNMENT' and r.canonical_bindings->>'assignmentId'=a.id::text join organizations o on o.workspace_id=a.workspace_id and o.id=a.company_id join crm_company_locations l on l.workspace_id=a.workspace_id and l.id=a.location_id where a.workspace_id=$1 and a.project_id=$2 ${verified ? 'and exists(select 1 from jsonb_to_recordset($3::jsonb) as p("companyId" uuid,"locationId" uuid) where p."companyId"=a.company_id and p."locationId"=a.location_id)' : ''} order by r.created_at,a.id limit 51`, [s.workspaceId, b.projectId, ...(verified ? [JSON.stringify(verified)] : [])]);
 return rows.map(row => ({ label: row.label.slice(0, 200), member: { identity: { workspaceId: s.workspaceId, projectId: b.projectId, companyId: row.companyId, locationId: row.locationId }, workflowId: row.workflowId, workflowVersion: Number(row.workflowVersion), sourceDigest: row.sourceDigest, assignedAt: iso(row.createdAt) }, methodRef: advisoryReferenceSchema.parse(row.treatmentRef) }));
}

/** Exact protected demo and independently signed QA certificate for native host rendering. */
export async function advisoryVerifiedDemo(tx:TenantTransaction,s:AppSession,b:Scope,ref:AdvisoryReference){
 await advisoryCanonicalParent(tx,s,b,ref,'DEMO'); const state=await advisoryState(tx,s,b), prospect=websiteProspectInputSchema.parse(state.row.prospect);
 const row=await tx.queryOne<{artifact:WebsiteStudioArtifact;createdBy:string}>(`select artifact,created_by as "createdBy" from crm_website_studio_artifacts where workspace_id=$1 and project_id=$2 and company_id=$3 and location_id=$4 and workflow_id=$5 and id=$6 and version=$7 and artifact_digest=$8`,[...params(s,b),ref.id,ref.version,ref.digest]);if(!row)fail('ADVISORY_CURRENT_DEMO_REQUIRED');
 const artifact=verifyWebsiteStudioArtifact(row.artifact,prospect,new Date().toISOString());if(artifact.kind!=='DEMO')fail('ADVISORY_DEMO_REQUIRED');
 const candidates=await tx.query<{certificate:unknown}>(`select certificate from crm_website_studio_qa where workspace_id=$1 and project_id=$2 and company_id=$3 and location_id=$4 and workflow_id=$5 and artifact_id=$6 and expires_at>clock_timestamp() order by expires_at desc limit 20`,[...params(s,b),ref.id]);
 for(const candidate of candidates){try{const certificate=verifyWebsiteStudioQaCertificate(candidate.certificate,artifact,b.workflowId,row.createdBy);return {artifact,prospect,certificate,builderId:row.createdBy,workflowId:b.workflowId};}catch{}}
 fail('ADVISORY_CURRENT_INDEPENDENT_QA_REQUIRED');
}

export async function assertAdvisoryPublication(tx:TenantTransaction,s:AppSession,b:Scope,record:import('../website-sales-advisory-types').AdvisoryRecord){
 if(record.payload.status!=='READY')fail('ADVISORY_READY_DRAFT_REQUIRED');
 const row=await tx.queryOne<{id:string;ok:boolean}>(`select id,crm_website_sales_advisory_current_for_actor($1,$2,$3,$4,$5,id) as ok from crm_website_sales_advisory_records where workspace_id=$1 and project_id=$2 and company_id=$3 and location_id=$4 and workflow_id=$5 and entity_id=$6 and version=$7 and record_digest=$8`,[...params(s,b),record.id,record.version,record.digest]);if(!row?.ok)fail('ADVISORY_PUBLICATION_SOURCE_CHANGED');
 const value=record.payload.value as Json;
 const demos=record.kind==='BUYER_PACKET'?value.demoRefs as AdvisoryReference[]:record.kind==='VIDEO_STORYBOARD'?[advisoryReferenceSchema.parse(value.demoRef)]:[];
 for(const demo of demos)await advisoryVerifiedDemo(tx,s,b,demo);
 if(record.kind==='VIDEO_STORYBOARD'){
  const packetRef=advisoryReferenceSchema.parse(value.packetRef);
  const packet=await tx.queryOne<{payload:Json}>(`select payload from crm_website_sales_advisory_records r where workspace_id=$1 and project_id=$2 and company_id=$3 and location_id=$4 and workflow_id=$5 and entity_id=$6 and version=$7 and record_digest=$8 and kind='BUYER_PACKET' and exists(select 1 from crm_website_sales_advisory_records a join workspace_users u on u.workspace_id=a.workspace_id and u.id=a.created_by and u.status='active' and u.role='owner' where a.workspace_id=r.workspace_id and a.workflow_id=r.workflow_id and a.kind='BUYER_PACKET_APPROVAL' and a.payload->'recordRef'=$9::jsonb and a.valid_until>clock_timestamp())`,[...params(s,b),packetRef.id,packetRef.version,packetRef.digest,JSON.stringify(packetRef)]);
  if(!packet||!(packet.payload.value as Json).demoRefs||!((packet.payload.value as Json).demoRefs as AdvisoryReference[]).some(d=>d.digest===String((value.demoRef as Json).digest)))fail('ADVISORY_APPROVED_PACKET_DEMO_REQUIRED');
 }
}

/** Shared experiment metadata is visible only after every frozen resource and the anchor are admitted. */
export async function advisoryExperimentPlans(tx:TenantTransaction,s:AppSession,b:Scope){
 const state=await advisoryState(tx,s,b),allowed=websiteSalesResourceReadScopes(s,b.projectId);
 const scopeWhere=allowed?`and exists(select 1 from jsonb_array_elements($6::jsonb) a where a->>'companyId'=r.company_id::text and a->>'locationId'=r.location_id::text) and not exists(select 1 from jsonb_array_elements(r.payload->'cohort') member where not exists(select 1 from jsonb_array_elements($6::jsonb) a where a->>'companyId'=member#>>'{identity,companyId}' and a->>'locationId'=member#>>'{identity,locationId}'))`:'';
 const selected=`r.workspace_id=$1 and r.project_id=$2 and r.kind='EXPERIMENT_PLAN' and exists(select 1 from jsonb_array_elements(r.payload->'cohort') member where member#>>'{identity,workspaceId}'=$1::text and member#>>'{identity,projectId}'=$2::text and member#>>'{identity,companyId}'=$3::text and member#>>'{identity,locationId}'=$4::text and member->>'workflowId'=$5::text)`;
 const values=[...params(s,b),...(allowed?[JSON.stringify(allowed)]:[])];
 const rows=await tx.query<{rowId:string;id:string;version:number;digest:string;companyId:string;locationId:string;workflowId:string;payload:Json}>(`select r.id as "rowId",r.entity_id as id,r.version,r.record_digest as digest,r.company_id as "companyId",r.location_id as "locationId",r.workflow_id as "workflowId",r.payload from crm_website_sales_advisory_records r where ${selected} ${scopeWhere} and r.valid_until>clock_timestamp() and (r.payload->>'enrollmentEndsAt')::timestamptz>clock_timestamp() and not exists(select 1 from crm_website_sales_advisory_records n where n.workspace_id=r.workspace_id and n.workflow_id=r.workflow_id and n.entity_id=r.entity_id and n.version>r.version) and not exists(select 1 from crm_website_sales_advisory_records stop where stop.workspace_id=r.workspace_id and stop.project_id=r.project_id and stop.kind='EXPERIMENT_STOP' and stop.payload#>>'{experimentRef,id}'=r.entity_id::text) and not exists(select 1 from crm_website_sales_advisory_assignments a where a.workspace_id=r.workspace_id and a.experiment_record_id=r.id and a.company_id=$3::uuid) order by r.created_at desc,r.id limit 51`,values);
 let partial=rows.length>50;
 if(allowed){const denied=await tx.queryOne(`select r.id from crm_website_sales_advisory_records r where ${selected} and not(${scopeWhere.slice(4)}) limit 1`,values);partial ||=!!denied;}
 const plans:Array<{label:string;reference:AdvisoryReference;identity:ReturnType<typeof identity>;workflowId:string;cohort:import('zod').infer<typeof advisoryCohortMemberSchema>[]}> = [];
 for(const r of rows.slice(0,50)){
  try{
   const anchor={projectId:b.projectId,companyId:r.companyId,locationId:r.locationId,workflowId:r.workflowId};await advisoryState(tx,s,anchor);
   const cohort=advisoryCohortMemberSchema.array().parse(r.payload.cohort);
   for(const m of cohort){if(m.identity.workspaceId!==s.workspaceId||m.identity.projectId!==b.projectId)fail('ADVISORY_COHORT_SCOPE_DENIED',403);await advisoryState(tx,s,{projectId:b.projectId,companyId:m.identity.companyId,locationId:m.identity.locationId,workflowId:m.workflowId});}
   const own=cohort.find(m=>m.workflowId===b.workflowId&&m.identity.companyId===b.companyId&&m.identity.locationId===b.locationId);if(!own||own.workflowVersion!==state.row.version||own.sourceDigest!==state.row.evidenceDigest)continue;
   if(!(await tx.queryOne<{ok:boolean}>('select crm_website_sales_advisory_current_for_actor($1,$2,$3,$4,$5,$6) as ok',[...params(s,anchor),r.rowId]))?.ok)continue;
   plans.push({label:String(r.payload.title).slice(0,200),reference:{id:r.id,version:Number(r.version),digest:r.digest},identity:identity(s,anchor),workflowId:r.workflowId,cohort});
  }catch(error){if(error&&typeof error==='object'&&'status'in error&&Number(error.status)>=400&&Number(error.status)<500){partial=true;continue;}throw error;}
 }
 return {plans,partial};
}
