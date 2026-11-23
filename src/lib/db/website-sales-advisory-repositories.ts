import 'server-only';
import { z } from 'zod';
import type { AppSession } from '../auth/session';
import { executeCrmCommand, reconcileCrmCommand, withCrmCommandPreflight, withCrmRead, type TenantTransactionOptions } from '../crm-command';
import { websiteSalesActorAuthority } from '../website-sales-machine-authority';
import { websiteSalesAdvisoryContract, websiteSalesAdvisoryCommandSchema, advisoryPayloadSchemas, websiteSalesAdvisoryOwnerOperations,
 type WebsiteSalesAdvisoryCommand as Command, type AdvisoryRecord } from '../website-sales-advisory-types';
import { advisoryProject, advisoryProjectLock, advisoryState, advisoryAction, advisoryOwner, advisoryAggregate, advisoryAdvance, advisoryPersist, advisoryBoundRecord, advisoryIdentity, advisoryReadAuthority, advisoryFail as fail, advisoryNow, type AdvisoryJson as Json } from './website-sales-advisory-storage';
import { advisoryValidateSources, advisoryCanonicalParent, advisoryCohortCandidates, advisoryForecastOrigins, assertAdvisoryPublication } from './website-sales-advisory-sources';
import { advisoryGroundedFacts } from './website-sales-advisory-facts';
import { advisoryReferenceSchema } from '../website-sales-advisory-types';
import { readAdvisoryProjection } from './website-sales-advisory-read';
import { deriveWebsiteSalesAdvisory, advisoryPeerPolicy, advisoryKnowledge } from './website-sales-advisory-derivations';
import { createAdvisoryBuyerGrant, revokeAdvisoryBuyerGrant } from './website-sales-advisory-buyer';
import { enqueueAdvisoryJob, cancelAdvisoryJob } from './website-sales-advisory-jobs';
import { advisoryDigest, advisoryContentSha256 } from '../website-sales-advisory-domain';
import { randomBytes } from 'node:crypto';

const ownerOps = new Set<string>(websiteSalesAdvisoryOwnerOperations);
const ownerKinds: Record<string, AdvisoryRecord['kind']> = { record_value_basis: 'VALUE_BASIS', record_discovery_answer: 'DISCOVERY_ANSWER', register_transcript: 'TRANSCRIPT', register_knowledge: 'KNOWLEDGE', configure_experiment: 'EXPERIMENT_PLAN', stop_experiment: 'EXPERIMENT_STOP', configure_forecast: 'FORECAST_POLICY', approve_knowledge: 'KNOWLEDGE_APPROVAL', approve_buyer_packet: 'BUYER_PACKET_APPROVAL', approve_video_storyboard: 'VIDEO_APPROVAL', review_advice: 'ADVICE_REVIEW', review_transcript_assertions: 'TRANSCRIPT_REVIEW' };
export function parseWebsiteSalesAdvisoryCommand(raw: unknown) { return websiteSalesAdvisoryCommandSchema.parse(raw); }
export function websiteSalesAdvisoryCommandInput(s: AppSession, raw: Command) {
 const c = parseWebsiteSalesAdvisoryCommand(raw), machine = websiteSalesActorAuthority(s, c, c.operation, 'autonomy');
 if (s.serviceIdentity && ownerOps.has(c.operation)) fail('ADVISORY_OWNER_REQUIRED', 403);
 return { operation: `website_sales.advisory.${c.operation}`, projectId: c.projectId, resourceId: c.locationId, capability: 'pipeline:write' as const,
  idempotencyKey: c.idempotencyKey, correlationId: c.correlationId, payload: { request: raw, machine } };
}
export async function readWebsiteSalesAdvisory(s: AppSession, scope: Command | { projectId: string; companyId: string; locationId: string; workflowId: string }, options: TenantTransactionOptions = {}) {
 websiteSalesActorAuthority(s, scope, 'read', 'autonomy'); advisoryReadAuthority(s, scope);
 return withCrmRead(s, (tx, fresh) => readAdvisoryProjection(tx, fresh, scope), options);
}
export async function executeWebsiteSalesAdvisoryCommand(s: AppSession, raw: Command, options: TenantTransactionOptions = {}) {
 const c = parseWebsiteSalesAdvisoryCommand(raw), command = websiteSalesAdvisoryCommandInput(s, raw);
 return withCrmCommandPreflight(s, command, async (outer, fresh) => {
  await advisoryProject(outer, fresh, c, true); await advisoryProjectLock(outer, fresh, c);
  if (ownerOps.has(c.operation)) await advisoryOwner(outer, fresh);
  const result = await executeCrmCommand(fresh, command, async (tx, context) => {
   const state = await advisoryState(tx, context.session, c, true), previous = await advisoryAggregate(tx, context.session, c, true);
   if ((previous?.version ?? 0) !== c.expectedVersion) fail('ADVISORY_VERSION_CONFLICT');
   if (state.row.version !== c.expectedWorkflowVersion) fail('WORKFLOW_VERSION_CONFLICT');
   const p = advisoryPayloadSchemas[c.operation].parse(Object.fromEntries(Object.entries(c.payload).filter(([key]) => key !== 'resourceGrants'))) as Json;
   if (ownerOps.has(c.operation)) await advisoryValidateSources(tx, context.session, c, p);
   let kind = ownerKinds[c.operation], payload = p, parentRefs: z.infer<typeof import('../website-sales-advisory-types').advisoryReferenceSchema>[] = [], bindings: Json = {};
   if (c.operation === 'record_value_basis') { const parent = await advisoryCanonicalParent(tx, context.session, c, p.offerRef as never, 'OFFER'); parentRefs = [parent.reference]; if (Number(p.oneTimeCostMinor) !== Number(parent.data.totalNetMinor)) fail('ADVISORY_CANONICAL_OFFER_COST_REQUIRED'); }
   if (c.operation === 'record_discovery_answer') parentRefs = [(await advisoryCanonicalParent(tx, context.session, c, p.briefRef as never, 'BRIEF')).reference];
   if (c.operation === 'stop_experiment') parentRefs = [(await advisoryPeerPolicy(tx, context.session, c, p.experimentRef as never, 'EXPERIMENT_PLAN')).record].map(record => ({ id: record.id, version: record.version, digest: record.digest }));
   if (c.operation === 'review_transcript_assertions') {
    const transcript = await advisoryBoundRecord(tx, context.session, c, p.transcriptRef as never, ['TRANSCRIPT']), analysis = await advisoryBoundRecord(tx, context.session, c, p.analysisRef as never, ['TRANSCRIPT_ASSERTIONS']);
    const value = analysis.record.payload.value as Json | null;
    if (analysis.record.payload.status !== 'READY' || !value || advisoryDigest(value.transcriptRef) !== advisoryDigest(p.transcriptRef)) fail('ADVISORY_TRANSCRIPT_ANALYSIS_REQUIRED');
    const actual = value.assertions as Json[], decisions = p.decisions as Json[];
    if (new Set(decisions.map(row => row.assertionId)).size !== decisions.length || decisions.some(row => !actual.some(assertion => assertion.id === row.assertionId))) fail('ADVISORY_ASSERTION_REVIEW_INVALID');
    parentRefs = [transcript.record, analysis.record].map(record => ({ id: record.id, version: record.version, digest: record.digest }));
   }
   if (['approve_knowledge', 'approve_buyer_packet', 'approve_video_storyboard', 'review_advice'].includes(c.operation)) {
    const expectedKind = ({ approve_knowledge: 'KNOWLEDGE', approve_buyer_packet: 'BUYER_PACKET', approve_video_storyboard: 'VIDEO_STORYBOARD', review_advice: 'ADVICE' } as Record<string, string>)[c.operation]!;
    const current = await advisoryBoundRecord(tx, context.session, c, p.recordRef as never, [expectedKind]);
    if (typeof p.validUntil === 'string' && Date.parse(p.validUntil) > Date.parse(current.record.validUntil!)) fail('ADVISORY_APPROVAL_EXPIRY_INVALID');
    if (c.operation !== 'approve_knowledge'){advisoryAction(state);await assertAdvisoryPublication(tx,context.session,c,current.record);}
    if(c.operation==='review_advice'&&p.publishToBuyer){
     const value=current.record.payload.value as Json;if(value.buyerQuestionId!==p.buyerQuestionId)fail('ADVISORY_BUYER_ANSWER_BINDING_REQUIRED');
     const question=await tx.queryOne<{packetId:string;packetVersion:number;packetDigest:string;grantId:string}>('select * from crm_website_sales_advisory_questions($1,$2,$3,$4,$5) where id=$6',[context.workspaceId,c.projectId,c.companyId,c.locationId,c.workflowId,p.buyerQuestionId]);if(!question)fail('ADVISORY_BUYER_QUESTION_REQUIRED');
     const packet=await advisoryBoundRecord(tx,context.session,c,{id:question.packetId,version:Number(question.packetVersion),digest:question.packetDigest},['BUYER_PACKET']);await assertAdvisoryPublication(tx,context.session,c,packet.record);
     if(!await tx.queryOne(`select id from crm_website_sales_advisory_buyer_grants g where workspace_id=$1 and project_id=$2 and company_id=$3 and location_id=$4 and workflow_id=$5 and id=$6 and expires_at>clock_timestamp() and not exists(select 1 from crm_website_sales_advisory_buyer_revocations v where v.workspace_id=g.workspace_id and v.grant_id=g.id)`,[context.workspaceId,c.projectId,c.companyId,c.locationId,c.workflowId,question.grantId]))fail('ADVISORY_BUYER_GRANT_REVOKED');
     const demos=advisoryReferenceSchema.array().parse((packet.record.payload.value as Json).demoRefs),facts=await advisoryGroundedFacts(tx,context.session,c),claims=value.claims as Json[];
     if(!claims.length||claims.some(claim=>!facts.some(f=>f.id===claim.factId&&f.category==='DEMO_FEATURE'&&demos.some(d=>advisoryDigest(d)===advisoryDigest(f.evidenceRef))&&f.text.includes(String(claim.exactQuote))))||value.summary!==claims.map(claim=>claim.exactQuote).join('\n\n')||String(value.summary).length>2000)fail('ADVISORY_BUYER_ANSWER_FACT_DENIED');
    }
    parentRefs = [{ id: current.record.id, version: current.record.version, digest: current.record.digest }];
   }
   if (c.operation === 'configure_experiment' || c.operation === 'configure_forecast') {
    const available = c.operation === 'configure_forecast' ? (await advisoryForecastOrigins(tx, context.session, c)).map(origin => ({ ...origin.member, companyId: origin.member.identity.companyId, locationId: origin.member.identity.locationId, category: 'observed' })) : await advisoryCohortCandidates(tx, context.session, c), requested = p.cohort as Json[];
    const members = requested.map(member => {
     if ((member.identity as Json).workspaceId !== context.workspaceId || (member.identity as Json).projectId !== c.projectId) fail('ADVISORY_COHORT_SCOPE_DENIED', 403);
     const actual = available.find(row => row.workflowId === member.workflowId && row.identity.companyId === (member.identity as Json).companyId && row.identity.locationId === (member.identity as Json).locationId && row.sourceDigest === member.sourceDigest);
     if (!actual) fail('ADVISORY_COHORT_SCOPE_DENIED', 403);
     if (Number(member.workflowVersion) !== actual.workflowVersion || member.sourceDigest !== actual.sourceDigest) fail('ADVISORY_COHORT_VERSION_CONFLICT');
     return { identity: actual.identity, workflowId: actual.workflowId, workflowVersion: actual.workflowVersion, assignedAt: actual.assignedAt, sourceDigest: actual.sourceDigest };
    });
    if (new Set(members.map(member => member.identity.companyId)).size !== members.length) fail('ADVISORY_COHORT_COMPANY_DUPLICATE');
    payload = { ...p, cohort: members };
    if (c.operation === 'configure_experiment') {
     if (advisoryDigest(p.controlRef) === advisoryDigest(p.variantRef)) fail('ADVISORY_EXPERIMENT_DISTINCT_TREATMENTS_REQUIRED');
     const control = await advisoryKnowledge(tx, context.session, c, p.controlRef as never), variant = await advisoryKnowledge(tx, context.session, c, p.variantRef as never);
     parentRefs = [control.knowledge, control.approval, variant.knowledge, variant.approval].map(record => ({ id: record.id, version: record.version, digest: record.digest }));
     if (Date.parse(String(p.enrollmentEndsAt)) <= Date.now() || members.some(member => available.find(candidate => candidate.workflowId === member.workflowId)?.category.match(/^(won|lost|disqualified|unknown)$/i))) fail('ADVISORY_PROSPECTIVE_OPEN_COHORT_REQUIRED');
     const seed = randomBytes(32).toString('hex'); payload = { ...payload, registeredAt: advisoryNow(), assignmentSaltDigest: advisoryContentSha256(seed), eligibilityDigest: advisoryDigest(members) }; bindings = { assignmentSeed: seed };
    }
   }
   const aggregate = await advisoryAdvance(tx, context.session, c, previous, context.commandId);
   let recordId: string | null = null, recordDigest: string | null = null, jobId: string | null = null;
   if (c.operation === 'create_buyer_grant') { advisoryAction(state); const grant=await createAdvisoryBuyerGrant(tx, context.session, c, p, context.commandId);recordId=grant.id;recordDigest=grant.digest; }
   else if (c.operation === 'revoke_buyer_grant') await revokeAdvisoryBuyerGrant(tx, context.session, c, p, context.commandId);
   else if (String(c.operation) === 'cancel_advisory_job') await cancelAdvisoryJob(tx, context.session, c, p);
   else {
    if (!kind) { if (!['prepare_forecast', 'assess_coaching'].includes(c.operation)) advisoryAction(state); const derived = await deriveWebsiteSalesAdvisory(tx, context.session, c, p, context.commandId); kind = derived.kind; payload = derived.payload; parentRefs = derived.parentRefs; bindings = { ...bindings, ...derived.bindings }; }
    const stored = await advisoryPersist(tx, context.session, c, aggregate, state.row.version, state.row.evidenceDigest, kind, payload, context.commandId, { parentRefs, bindings, ...(kind==='EXPERIMENT_PLAN'?{validUntil:new Date(Date.parse(String(payload.enrollmentEndsAt))+Number(payload.outcomeHorizonDays??payload.horizonDays??30)*86400000).toISOString()}:{}), confidence: ownerOps.has(c.operation) ? 'OPERATOR_RECORDED' : 'SERVER_DERIVED' });
    recordId = stored.record.id; recordDigest = stored.record.digest;
    if (['register_transcript', 'prepare_advice', 'approve_video_storyboard'].includes(c.operation)||c.operation==='prepare_roleplay') jobId = await enqueueAdvisoryJob(tx, context.session, c, stored, context.commandId, c.operation === 'register_transcript' ? 'TRANSCRIPT_ANALYSIS' : c.operation === 'prepare_advice' ? 'ADVICE' : c.operation==='prepare_roleplay'?'ROLEPLAY':'VIDEO',c.operation==='prepare_roleplay'?p:undefined);
   }
   return { identity: advisoryIdentity(context.session, c), workflowId: c.workflowId, version: aggregate.version, workflowVersion: state.row.version, recordId, recordDigest, jobId, canContact: false as const };
  }, options);
  // Stored replay skips the callback: revalidate fresh rights and scope independently.
  await advisoryState(outer, fresh, c); if (ownerOps.has(c.operation)) await advisoryOwner(outer, fresh);
  return { ...result, contractVersion: websiteSalesAdvisoryContract, persisted: true as const, correlationId: c.correlationId };
 }, options);
}
export async function reconcileWebsiteSalesAdvisoryCommand(s: AppSession, raw: Command, options: TenantTransactionOptions = {}) {
 const c = parseWebsiteSalesAdvisoryCommand(raw), command = websiteSalesAdvisoryCommandInput(s, raw); advisoryReadAuthority(s, c);
 return withCrmCommandPreflight(s, command, async (tx, fresh) => {
  await advisoryState(tx, fresh, c); if (ownerOps.has(c.operation)) await advisoryOwner(tx, fresh);
  const original = await reconcileCrmCommand(fresh, command, options);
  const envelope = { contractVersion: 'website-sales-advisory-reconcile-v1' as const, correlationId: c.correlationId };
  return original.status === 'NOT_FOUND' ? { ...envelope, status: 'NOT_FOUND' as const } : { ...envelope, status: 'COMMITTED' as const, receipt: { contractVersion: websiteSalesAdvisoryContract, persisted: true as const, commandId: original.commandId, auditReference: original.auditReference, correlationId: c.correlationId, replayed: true, data: original.data }, currentData: await readAdvisoryProjection(tx, fresh, c) };
 }, options);
}
