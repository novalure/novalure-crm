import 'server-only';
import { randomUUID } from 'node:crypto';
import type { AppSession } from '../auth/session';
import type { TenantTransaction } from '../crm-command';
import { websiteSalesResourceAuthority, websiteSalesResourceReadScopes } from '../website-sales-machine-authority';
import type { AdvisoryRecord, AdvisoryReference, WebsiteSalesAdvisoryCommand as Command } from '../website-sales-advisory-types';
import { advisoryPayloadSchemas, advisoryReferenceSchema, advisoryCohortMemberSchema } from '../website-sales-advisory-types';
import { calculateAdvisoryValueCase, planAdvisoryDiscovery, prepareAdvisoryBuyerPacket, assessAdvisoryCoaching, prepareAdvisoryRoleplay, prepareAdvisoryVideoStoryboard, assignAdvisoryExperiment, forecastAdvisoryCohort, advisoryDigest, advisoryReference, verifyAdvisoryPeerRecord, type AdvisoryContext } from '../website-sales-advisory-domain';
import { advisoryCanonicalParent, type AdvisoryCanonicalParent } from './website-sales-advisory-sources';
import { advisoryGroundedFacts } from './website-sales-advisory-facts';
import { advisoryFail as fail, advisoryNow as now, advisoryIso as iso, advisoryState, advisoryBoundRecord, advisoryRows, advisoryRecord, advisoryColumns, advisoryIdentity as identity, advisoryParams as params, type AdvisoryRow, type AdvisoryJson as Json, type AdvisoryScope as Scope } from './website-sales-advisory-storage';

export type AdvisoryDerived = { kind: AdvisoryRecord['kind']; payload: Json; parentRefs: AdvisoryReference[]; bindings?: Json };
export async function advisoryKnowledge(tx: TenantTransaction, s: AppSession, b: Scope, ref: AdvisoryReference) {
 const knowledge = await advisoryBoundRecord(tx, s, b, ref, ['KNOWLEDGE']);
 const approvals = await advisoryRows(tx, s, b, 'KNOWLEDGE_APPROVAL'), approval = approvals.find(row => advisoryDigest(row.payload.recordRef) === advisoryDigest(ref) && Date.parse(iso(row.validUntil)) > Date.now());
 if (!approval) fail('ADVISORY_KNOWLEDGE_APPROVAL_REQUIRED');
 return { knowledge: knowledge.record, approval: advisoryRecord(approval, s, b) };
}
export async function advisoryPeerPolicy(tx: TenantTransaction, s: AppSession, b: Scope, ref: AdvisoryReference, kind: string) {
 const verified = websiteSalesResourceReadScopes(s, b.projectId);
 const row = await tx.queryOne<AdvisoryRow & { companyId: string; locationId: string; workflowId: string }>(`select ${advisoryColumns},company_id as "companyId",location_id as "locationId",workflow_id as "workflowId" from crm_website_sales_advisory_records where workspace_id=$1 and project_id=$2 and entity_id=$3 and kind=$4 ${verified ? 'and exists(select 1 from jsonb_to_recordset($5::jsonb) as p("companyId" uuid,"locationId" uuid) where p."companyId"=company_id and p."locationId"=location_id)' : ''} order by version desc limit 1`, [s.workspaceId, b.projectId, ref.id, kind, ...(verified ? [JSON.stringify(verified)] : [])]);
 if (!row || Number(row.version) !== ref.version || row.digest !== ref.digest) fail('ADVISORY_CURRENT_POLICY_REQUIRED');
 const anchor = { projectId: b.projectId, companyId: row.companyId, locationId: row.locationId, workflowId: row.workflowId }; websiteSalesResourceAuthority(s, anchor);
 const anchorState = await advisoryState(tx, s, anchor);
 const record = advisoryRecord({ ...row, version: Number(row.version), workflowVersion: Number(row.workflowVersion) }, s, anchor);
 return { row, record, anchor, anchorState };
}
export async function advisoryAuthorizedContext(tx: TenantTransaction, s: AppSession, b: Scope, members: { identity: ReturnType<typeof identity>; workflowId: string }[]): Promise<AdvisoryContext> {
 const own = await advisoryState(tx, s, b), authorizedResources: NonNullable<AdvisoryContext['authorizedResources']>[number][] = [];
 for (const member of members) {
  if (member.identity.workspaceId !== s.workspaceId || member.identity.projectId !== b.projectId) fail('ADVISORY_COHORT_SCOPE_DENIED', 403);
  const scope = { projectId: b.projectId, companyId: member.identity.companyId, locationId: member.identity.locationId, workflowId: member.workflowId }; websiteSalesResourceAuthority(s, scope);
  const actual = await advisoryState(tx, s, scope); authorizedResources.push({ identity: identity(s, scope), workflowId: scope.workflowId, workflowVersion: actual.row.version });
 }
 return { identity: identity(s, b), workflowId: b.workflowId, workflowVersion: own.row.version, authorizedResources };
}
export async function advisoryObservations(tx: TenantTransaction, s: AppSession, b: Scope, members: Json[], horizonDays: number, originKind: 'FORECAST_ASSIGNMENT' | 'EXPERIMENT_ASSIGNMENT' = 'FORECAST_ASSIGNMENT') {
 const observations: Json[] = [];
 for (const member of members) {
  const ident = member.identity as ReturnType<typeof identity>, scope = { projectId: b.projectId, companyId: ident.companyId, locationId: ident.locationId, workflowId: String(member.workflowId) };
  websiteSalesResourceAuthority(s, scope); const state = await advisoryState(tx, s, scope);
  const history = await tx.query<{ id: string; category: string; createdAt: string }>(`select h.id,ps.category,h.changed_at as "createdAt" from deal_stage_history h join projects p on p.workspace_id=h.workspace_id and p.id=h.project_id join crm_pipeline_stages ps on ps.workspace_id=p.workspace_id and ps.project_id=p.id and ps.pipeline_id=p.default_pipeline_id and ps.name=h.to_stage where h.workspace_id=$1 and h.project_id=$2 and h.deal_id=$3 and h.changed_at>=$4::timestamptz order by h.changed_at,h.id limit 501`, [s.workspaceId, b.projectId, state.row.dealId, member.assignedAt]);
  const exposure = await tx.queryOne<{ digest: string; sourceDigest: string; availableAt: string }>(`select r.payload#>>'{value,treatmentRef,digest}' as digest,a.assignment_digest as "sourceDigest",r.created_at as "availableAt" from crm_website_sales_advisory_assignments a join crm_website_sales_advisory_records r on r.workspace_id=a.workspace_id and r.workflow_id=a.workflow_id and r.kind='EXPERIMENT_ASSIGNMENT' and r.canonical_bindings->>'assignmentId'=a.id::text where a.workspace_id=$1 and a.project_id=$2 and a.company_id=$3 and a.location_id=$4 and a.workflow_id=$5 and a.assigned_at<=$6::timestamptz and ${originKind === 'FORECAST_ASSIGNMENT' ? 'a.assignment_digest=$7 and r.created_at<=$6::timestamptz' : "r.payload#>>'{value,cohortSourceDigest}'=$7 and a.assigned_at=$6::timestamptz"} order by a.assigned_at desc,a.id desc limit 1`, [...params(s, scope), member.assignedAt, member.sourceDigest]);
  const end = Date.parse(String(member.assignedAt)) + horizonDays * 86400000, won = history.find(row => row.category === 'won' && Date.parse(iso(row.createdAt)) <= end), lost = history.find(row => row.category === 'lost' && Date.parse(iso(row.createdAt)) <= end);
  const selected = won ?? lost, mature = Date.now() >= end;
  observations.push({ identity: ident, workflowId: scope.workflowId, assignedAt: member.assignedAt, horizonDays, segmentKey: 'ALL', treatmentDigest: exposure?.digest ?? advisoryDigest('ADVISORY_METHOD_EXPOSURE_UNKNOWN'),
   outcome: won ? 'WON' : mature && lost ? 'NOT_WON' : mature ? 'UNKNOWN' : 'PENDING', outcomeAt: selected ? iso(selected.createdAt) : null,
   availableAt: selected ? iso(selected.createdAt) : now(), coverage: selected && exposure && history.length <= 500 ? 'COMPLETE' : 'INCOMPLETE', cohortSourceDigest: member.sourceDigest, sourceDigest: advisoryDigest({ history:history.map(h=>({...h,createdAt:iso(h.createdAt)})), exposure:exposure?{...exposure,availableAt:iso(exposure.availableAt)}:null, workflowId: scope.workflowId }) });
 }
 return observations;
}
export async function deriveWebsiteSalesAdvisory(tx: TenantTransaction, s: AppSession, c: Command, p: Json, commandId: string): Promise<AdvisoryDerived> {
 const state = await advisoryState(tx, s, c), ctx: AdvisoryContext = { identity: identity(s, c), workflowId: c.workflowId, workflowVersion: state.row.version }, ref = (value: unknown) => advisoryReferenceSchema.parse(value);
 const row = async (value: unknown, kinds?: string[]) => (await advisoryBoundRecord(tx, s, c, ref(value), kinds)).record;
 const finish = (kind: AdvisoryRecord['kind'], payload: unknown, parentRefs: AdvisoryReference[], bindings?: Json) => ({ kind, payload: payload as Json, parentRefs, bindings });
 switch (c.operation) {
  case 'prepare_value_case': { const basis = await row(p.basisRef, ['VALUE_BASIS']); await advisoryCanonicalParent(tx, s, c, ref(basis.payload.offerRef), 'OFFER'); return finish('VALUE_CASE', calculateAdvisoryValueCase(basis, ctx, now()), [advisoryReference(basis), ref(basis.payload.offerRef)]); }
  case 'prepare_discovery': { const brief = await advisoryCanonicalParent(tx, s, c, ref(p.briefRef), 'BRIEF'), answers = await Promise.all((p.answerRefs as unknown[]).map(value => row(value, ['DISCOVERY_ANSWER']))); return finish('DISCOVERY_PLAN', planAdvisoryDiscovery({ brief, answers }, ctx, now()), [brief.reference, ...answers.map(advisoryReference)]); }
  case 'prepare_buyer_packet': {
   const parsed = advisoryPayloadSchemas.prepare_buyer_packet.parse(p), parents: AdvisoryCanonicalParent[] = [await advisoryCanonicalParent(tx, s, c, parsed.briefRef, 'BRIEF')];
   if (parsed.closePlanRef) parents.push(await advisoryCanonicalParent(tx, s, c, parsed.closePlanRef, 'CLOSE_PLAN'));
   for (const demo of parsed.demoRefs) parents.push(await advisoryCanonicalParent(tx, s, c, demo, 'DEMO'));
   if (parsed.valueCaseRef) await row(parsed.valueCaseRef, ['VALUE_CASE']);
   return finish('BUYER_PACKET', prepareAdvisoryBuyerPacket({ input: parsed, parents, facts: await advisoryGroundedFacts(tx, s, c) }, ctx, now()), [...parents.map(parent => parent.reference), ...(parsed.valueCaseRef ? [parsed.valueCaseRef] : [])]);
  }
  case 'prepare_advice': {
   let parsed = advisoryPayloadSchemas.prepare_advice.parse(p);let facts=await advisoryGroundedFacts(tx,s,c);let packetRef:AdvisoryReference|null=null;
   if(parsed.buyerQuestionId){const q=await tx.queryOne<{question:string;packetId:string;packetVersion:number;packetDigest:string;grantId:string}>('select * from crm_website_sales_advisory_questions($1,$2,$3,$4,$5) where id=$6',[...params(s,c),parsed.buyerQuestionId]);if(!q)fail('ADVISORY_BUYER_QUESTION_REQUIRED');packetRef={id:q.packetId,version:Number(q.packetVersion),digest:q.packetDigest};const packet=await row(packetRef,['BUYER_PACKET']);if(!await tx.queryOne(`select g.id from crm_website_sales_advisory_buyer_grants g where g.workspace_id=$1 and g.project_id=$2 and g.company_id=$3 and g.location_id=$4 and g.workflow_id=$5 and g.id=$6 and g.expires_at>clock_timestamp() and not exists(select 1 from crm_website_sales_advisory_buyer_revocations v where v.workspace_id=g.workspace_id and v.grant_id=g.id)`,[...params(s,c),q.grantId]))fail('ADVISORY_BUYER_GRANT_REVOKED');const refs=(packet.payload.value as Json).demoRefs as AdvisoryReference[];facts=facts.filter(f=>f.category==='DEMO_FEATURE'&&refs.some(r=>advisoryDigest(r)===advisoryDigest(f.evidenceRef)));parsed={...parsed,question:q.question,knowledgeRefs:[],artifactRefs:refs};}

   if (parsed.factRefs.some(source => !facts.some(fact => advisoryDigest(fact.evidenceRef) === advisoryDigest(source)))) fail('ADVISORY_CURRENT_FACT_REQUIRED');
   for (const knowledge of parsed.knowledgeRefs) await advisoryKnowledge(tx, s, c, knowledge);
   for (const artifact of parsed.artifactRefs) await advisoryCanonicalParent(tx, s, c, artifact, 'DEMO');
   return finish('ADVICE_REQUEST', parsed, [...parsed.factRefs, ...parsed.artifactRefs, ...parsed.knowledgeRefs,...(packetRef?[packetRef]:[])], { groundedFactsDigest: advisoryDigest(facts.filter(fact => parsed.factRefs.some(ref => advisoryDigest(ref) === advisoryDigest(fact.evidenceRef)))) });
  }
  case 'assess_coaching': { const transcript = await row(p.transcriptRef, ['TRANSCRIPT']), knowledge = await advisoryKnowledge(tx, s, c, ref(p.knowledgeRef)); return finish('COACHING', assessAdvisoryCoaching({ transcript, ...knowledge }, ctx, now()), [advisoryReference(transcript), advisoryReference(knowledge.knowledge), advisoryReference(knowledge.approval)]); }
  case 'prepare_roleplay': { if(p.sellerReply){const parsed=advisoryPayloadSchemas.prepare_roleplay.parse(p),previous=await row(parsed.previousRoleplayRef,['ROLEPLAY']),knowledge=await advisoryKnowledge(tx,s,c,parsed.knowledgeRef);return finish('ROLEPLAY',prepareAdvisoryRoleplay({...knowledge,scenarioId:parsed.scenarioId},ctx,now()),[advisoryReference(previous),advisoryReference(knowledge.knowledge),advisoryReference(knowledge.approval)],{roleplayRequest:parsed});} const knowledge = await advisoryKnowledge(tx, s, c, ref(p.knowledgeRef)); return finish('ROLEPLAY', prepareAdvisoryRoleplay({ ...knowledge, scenarioId: String(p.scenarioId) }, ctx, now()), [advisoryReference(knowledge.knowledge), advisoryReference(knowledge.approval)]); }
  case 'prepare_video_storyboard': { const parsed = advisoryPayloadSchemas.prepare_video_storyboard.parse(p), demo = await advisoryCanonicalParent(tx, s, c, parsed.demoRef, 'DEMO'), packet = parsed.packetRef ? await row(parsed.packetRef, ['BUYER_PACKET']) : null, assets = await Promise.all(parsed.assetRefs.map(ref => advisoryCanonicalParent(tx, s, c, ref, 'ASSET'))); return finish('VIDEO_STORYBOARD', prepareAdvisoryVideoStoryboard({ input: parsed, demo, packet, assets, facts: await advisoryGroundedFacts(tx, s, c) }, ctx, now()), [demo.reference, ...assets.map(a => a.reference), ...(packet ? [advisoryReference(packet)] : [])]); }
  case 'assign_experiment': {
   const plan = await advisoryPeerPolicy(tx, s, c, ref(p.experimentRef), 'EXPERIMENT_PLAN'), cohort = advisoryCohortMemberSchema.array().parse(plan.record.payload.cohort), context = await advisoryAuthorizedContext(tx, s, c, [...cohort, { identity: plan.record.identity, workflowId: plan.record.workflowId }]);
   verifyAdvisoryPeerRecord(plan.record, context, now());
   const member=cohort.find(m=>m.workflowId===c.workflowId&&m.identity.companyId===c.companyId&&m.identity.locationId===c.locationId);if(!member||member.workflowVersion!==state.row.version||member.sourceDigest!==state.row.evidenceDigest)fail('ADVISORY_COHORT_VERSION_CONFLICT');
   const deal=await tx.queryOne<{category:string}>(`select ps.category from deals d join projects p on p.workspace_id=d.workspace_id and p.id=d.project_id join crm_pipeline_stages ps on ps.workspace_id=d.workspace_id and ps.project_id=d.project_id and ps.pipeline_id=p.default_pipeline_id and ps.name=d.stage where d.workspace_id=$1 and d.project_id=$2 and d.organization_id=$3 and d.id=$4 for share of d`,[s.workspaceId,c.projectId,c.companyId,state.row.dealId]);if(!deal||['won','lost','disqualified','unknown'].includes(deal.category))fail('ADVISORY_PROSPECTIVE_OPEN_COHORT_REQUIRED');
   if (await tx.queryOne(`select id from crm_website_sales_advisory_records where workspace_id=$1 and project_id=$2 and kind='EXPERIMENT_STOP' and payload#>>'{experimentRef,id}'=$3`, [s.workspaceId, c.projectId, plan.record.id])) fail('ADVISORY_EXPERIMENT_STOPPED');
   const prior = await tx.queryOne<{ variant: string }>('select variant_id as variant from crm_website_sales_advisory_assignments where workspace_id=$1 and experiment_record_id=$2 and company_id=$3', [s.workspaceId, plan.row.rowId, c.companyId]); if (prior) fail('ADVISORY_EXPERIMENT_ALREADY_ASSIGNED');
   const history=await tx.query<AdvisoryRow & {companyId:string;locationId:string;workflowId:string}>(`select ${advisoryColumns},r.company_id as "companyId",r.location_id as "locationId",r.workflow_id as "workflowId" from crm_website_sales_advisory_records r where r.workspace_id=$1 and r.project_id=$2 and r.kind='EXPERIMENT_ASSIGNMENT' and r.payload#>>'{value,planRef,id}'=$3 order by r.created_at,r.id limit 51`,[s.workspaceId,c.projectId,plan.record.id]);if(history.length>50)fail('ADVISORY_ASSIGNMENT_HISTORY_INCOMPLETE');const assignments=history.map(r=>advisoryRecord({...r,version:Number(r.version),workflowVersion:Number(r.workflowVersion)},s,{...c,companyId:r.companyId,locationId:r.locationId,workflowId:r.workflowId}));
   const assigned = assignAdvisoryExperiment({ plan: plan.record, seed: String(plan.row.bindings.assignmentSeed),assignments }, context, now()); if (assigned.status !== 'READY' || !assigned.value) fail(assigned.reasons[0] ?? 'ADVISORY_ASSIGNMENT_DENIED');
   const assignedId = randomUUID(); await tx.execute('insert into crm_website_sales_advisory_assignments(id,workspace_id,project_id,company_id,location_id,workflow_id,experiment_record_id,variant_id,assignment_digest,origin_digest,workflow_version,evidence_digest,assigned_by,command_id,assigned_at)values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)', [assignedId, ...params(s, c), plan.row.rowId, assigned.value.arm, advisoryDigest(assigned.value), advisoryDigest({ identity: identity(s, c), workflowId: c.workflowId, assignedAt: assigned.value.assignedAt }), state.row.version, state.row.evidenceDigest, s.userId, commandId, assigned.value.assignedAt]);
   return finish('EXPERIMENT_ASSIGNMENT', assigned, [advisoryReference(plan.record)], { assignmentId: assignedId });
  }
  case 'prepare_forecast': {
   const policy = await advisoryPeerPolicy(tx, s, c, ref(p.policyRef), 'FORECAST_POLICY'), cohort = advisoryCohortMemberSchema.array().parse(policy.record.payload.cohort), context = await advisoryAuthorizedContext(tx, s, c, [...cohort, { identity: policy.record.identity, workflowId: policy.record.workflowId }]);
   const observations = await advisoryObservations(tx, s, c, cohort, Number(policy.record.payload.horizonDays));
   return finish('FORECAST', forecastAdvisoryCohort({ policy: policy.record, observations }, context, now()), [advisoryReference(policy.record)], { observationsDigest: advisoryDigest(observations), originCohortDigest: advisoryDigest(cohort) });
  }
 }
 fail('ADVISORY_OPERATION_NOT_SUPPORTED', 400);
}
