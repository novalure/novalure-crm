import 'server-only';
import { projectVerifiedWebsiteSalesClosing } from './website-sales-commerce-closing';
import { randomUUID } from 'node:crypto';
import { commerceDigest, commerceSourceFactDigest, resolveWebsiteSalesCommerceSignature, reconcileWebsiteSalesCommerceSources } from '../website-sales-commerce-domain';
import { commerceContractDraftSchema, commerceInvoiceRequestSchema, commerceSubscriptionTermsSchema, type WebsiteSalesCommerceSourceEvent as Event } from '../website-sales-commerce-types';
import { commerceFail as fail, commerceParams as params, commerceRows, commerceAggregate, commerceAdvance, commercePersist, commerceExactRecord } from './website-sales-commerce-storage';
import { consumeVerifiedCommerceSource, withWebsiteSalesCommerceSourceExecutor, lockedWebsiteSalesCommerceJob, type VerifiedCommerceSource, type WebsiteSalesCommerceExecutor } from './website-sales-commerce-outbox';

function semantic(e: Event) { return commerceDigest({ source: e.source, kind: e.kind, payload: e.payload, occurredAt: e.occurredAt, supersedesEventId: e.supersedesEventId, confidence: e.confidence }); }
function sameRef(a: unknown, b: unknown) { return commerceDigest(a) === commerceDigest(b); }
/** Only a separately privileged executor and an opaque, host-verified proof can enter this sink.
 * Historical verified facts do not gain permission to dispatch a fresh external effect. */
export async function ingestVerifiedWebsiteSalesCommerceSource(cap: WebsiteSalesCommerceExecutor, proof: VerifiedCommerceSource) {
 const { event: e, jobId } = consumeVerifiedCommerceSource(proof);
 return withWebsiteSalesCommerceSourceExecutor(cap, async (tx, b) => {
  const job = await lockedWebsiteSalesCommerceJob(tx, b, jobId);
  if (commerceDigest(e.identity) !== commerceDigest(job.identity) || e.workflowId !== job.workflowId || e.confidence !== 'PROVIDER_VERIFIED') fail('COMMERCE_SOURCE_SCOPE_DENIED', 403);
  if (Date.parse(e.occurredAt) > Date.now() || Date.parse(e.retrievedAt) > Date.now() || Date.parse(e.retrievedAt) < Date.parse(e.occurredAt)) fail('COMMERCE_SOURCE_TIME_INVALID', 400);
  const history = (await tx.query<{ payload: Event }>(`select payload from crm_website_sales_commerce_sources where workspace_id=$1 and project_id=$2 and company_id=$3 and location_id=$4 and workflow_id=$5 order by received_at,id limit 1001`, params(b, b))).map(r => r.payload);
  if (history.length > 1000) fail('COMMERCE_FINANCIAL_HISTORY_LIMITED');
  const existing = history.find(p => p.eventId === e.eventId || p.source.system === e.source.system && p.source.provider === e.source.provider && p.source.accountReference === e.source.accountReference && p.source.resourceType === e.source.resourceType && p.source.resourceId === e.source.resourceId && p.source.version === e.source.version);
  if (existing) { if (semantic(existing) !== semantic(e)) fail('COMMERCE_SOURCE_EVENT_CONFLICT');if(existing.kind==='PROVIDER_DELIVERY'&&existing.payload.status==='COMPLAINED')await tx.query('select crm_website_sales_commerce_suppress_complaint($1,$2,$3)',[existing.eventId,b.workloadId,b.grantId]);if(existing.kind==='SIGNATURE')await projectVerifiedWebsiteSalesClosing(tx,b,job,existing,history); return { status: 'DUPLICATE' as const, sourceEventId: existing.eventId }; }
  if(['PROVIDER_DELIVERY','SIGNATURE'].includes(e.kind)&&!job.firstAttemptAt)fail('COMMERCE_SOURCE_NO_AUTHORIZED_ATTEMPT',403);
  const ref = job.payload.documentRef as { id: string; version: number; digest: string };
  const rows = await commerceRows(tx, b, b);
  const kind=job.kind==='ACCOUNTING_INVOICE_REQUEST'?'INVOICE_REQUEST':['SIGNATURE_REQUEST','CONTRACT_SEND'].includes(job.kind)?'CONTRACT':null;const document=kind?await commerceExactRecord(tx,b,b,ref,kind):rows.find(r=>r.entityId===ref.id&&r.version===ref.version&&r.digest===ref.digest);
  const contract = document?.kind === 'CONTRACT' ? commerceContractDraftSchema.parse(document.payload) : null;
  const currentSignature = async (contractRef: typeof ref, body: ReturnType<typeof commerceContractDraftSchema.parse>) => { const pol=await commerceExactRecord(tx,b,b,body.policyRef,'POLICY'); const result=resolveWebsiteSalesCommerceSignature({identity:e.identity,workflowId:e.workflowId,events:history,contractRef,documentSha256:body.documentSha256,requiredAssurance:pol.payload.signatureAssurance as 'PROVIDER_ATTESTED'|'ADVANCED'|'QUALIFIED'},new Date().toISOString()); if(result.status!=='READY'||!result.value)fail(result.reasons[0]??'COMMERCE_CURRENT_SIGNATURE_REQUIRED'); return result.value; };
  const financial = reconcileWebsiteSalesCommerceSources({ identity: e.identity, workflowId: e.workflowId, events: [...history, e] }, new Date().toISOString());
  if (financial.status === 'BLOCKED') fail(financial.reasons[0] ?? 'COMMERCE_FINANCIAL_SOURCE_INVALID');
  switch (e.kind) {
   case 'PROVIDER_DELIVERY': {
    if (!['OFFER_SEND', 'CONTRACT_SEND'].includes(job.kind) || e.source.system !== 'DELIVERY_PROVIDER' || e.payload.outboxId !== job.id || !sameRef(e.payload.documentRef, ref) || e.payload.documentSha256 !== job.payload.documentSha256 || e.payload.recipientDigest !== job.payload.recipientDigest || job.providerReference && job.providerReference !== e.payload.providerMessageId) fail('COMMERCE_DELIVERY_SOURCE_BINDING_DENIED', 403);
    break;
   }
   case 'SIGNATURE': {
    if (job.kind !== 'SIGNATURE_REQUEST' || !contract || e.source.system !== 'SIGNATURE_PROVIDER' || !sameRef(e.payload.contractRef, ref) || e.payload.documentSha256 !== contract.documentSha256 || job.providerReference && job.providerReference !== e.payload.envelopeId) fail('COMMERCE_SIGNATURE_SOURCE_BINDING_DENIED', 403);
    if(e.payload.status==='SIGNED'&&(!e.payload.providerSignedDocumentDigests?.length||!e.payload.providerAuditProofDigests?.length||e.payload.signatoryReference!==`recipient:${commerceDigest(contract.recipientEmail.toLowerCase())}`))fail('COMMERCE_SIGNED_DOCUMENT_PROOF_REQUIRED',403);
    if (e.payload.status === 'SIGNED' && (!e.payload.signedAt || Date.parse(e.payload.signedAt) > Date.now())) fail('COMMERCE_SIGNATURE_SOURCE_INVALID');
    const policy=await commerceExactRecord(tx,b,b,contract.policyRef,'POLICY');
    const rank = { EMAIL_ACCESS: 0, PROVIDER_ATTESTED: 1, ADVANCED: 2, QUALIFIED: 3 };
    if(e.payload.status==='SIGNED'&&rank[e.payload.assurance]<rank[policy.payload.signatureAssurance as keyof typeof rank]) fail('COMMERCE_SIGNATURE_ASSURANCE_REQUIRED');
    break;
   }
   case 'DELIVERY_ACCEPTANCE': {
    if (!contract || !sameRef(e.payload.contractRef, ref) || !['SERVICE_AUTHORITY', 'CRM'].includes(e.source.system)) fail('COMMERCE_ACCEPTANCE_SOURCE_BINDING_DENIED', 403);
    await currentSignature(ref,contract);
    const task = await tx.queryOne(`select t.id from crm_website_sales_handoffs h join tasks t on t.workspace_id=h.workspace_id and t.id=h.task_id where h.workspace_id=$1 and h.project_id=$2 and h.company_id=$3 and h.location_id=$4 and h.workflow_id=$5 and t.id=$6 and t.version=$7 and t.status='done'`, [...params(b, b), e.payload.canonicalDeliveryTaskId, e.payload.expectedDeliveryTaskVersion]);
    const offer = await tx.queryOne<{ scope: string }>(`select r.content->>'scope' as scope from crm_offers o join crm_offer_revisions r on r.workspace_id=o.workspace_id and r.offer_id=o.id and r.revision=$5 where o.workspace_id=$1 and o.project_id=$2 and o.organization_id=$3 and o.id=$4`, [b.workspaceId, b.projectId, b.companyId, contract.offerRef.id, contract.offerRef.version]);
    if (!task || !offer || commerceDigest(offer.scope) !== e.payload.scopeDigest || Date.parse(e.payload.acceptedAt) > Date.now()) fail('COMMERCE_CANONICAL_DELIVERY_REQUIRED');
    break;
   }
   case 'INVOICE': {
    if (job.kind !== 'ACCOUNTING_INVOICE_REQUEST' || !document || document.kind !== 'INVOICE_REQUEST' || e.source.system !== 'ACCOUNTING') fail('COMMERCE_INVOICE_SOURCE_BINDING_DENIED', 403);
    const request = commerceInvoiceRequestSchema.parse(document.payload);
    if (e.payload.customerReference!==request.customerReference||e.payload.invoiceRequestId !== document.entityId || !sameRef(e.payload.contractRef, request.contractRef) || !sameRef(e.payload.financial, request.financial) || !sameRef(e.payload.installments, request.installments) || e.source.accountReference !== request.accountingEntityReference) fail('COMMERCE_ACCOUNTING_REQUEST_MISMATCH');
    break;
   }
   case 'PAYMENT': case 'REFUND': {
    if (!['ACCOUNTING', 'PAYMENT_PROVIDER'].includes(e.source.system)) fail('COMMERCE_PAYMENT_SOURCE_REQUIRED', 403);
    for (const allocation of e.payload.allocations) if (!history.some(p => p.kind === 'INVOICE' && p.eventId === allocation.invoiceSourceEventId && p.confidence === 'PROVIDER_VERIFIED')) fail('COMMERCE_CANONICAL_INVOICE_SOURCE_REQUIRED');
    if (e.kind === 'REFUND' && !history.some(p => p.kind === 'PAYMENT' && p.eventId === e.payload.paymentSourceEventId && p.payload.status === 'SETTLED')) fail('COMMERCE_CANONICAL_PAYMENT_SOURCE_REQUIRED');
    break;
   }
   case 'CREDIT_NOTE': if (e.source.system !== 'ACCOUNTING' || !history.some(p => p.kind === 'INVOICE' && p.eventId === e.payload.invoiceSourceEventId)) fail('COMMERCE_CANONICAL_INVOICE_SOURCE_REQUIRED'); break;
   case 'REVERSAL': if (!history.some(p => p.eventId === e.payload.reversesEventId&&commerceSourceFactDigest(p)===e.payload.reversedEventDigest)) fail('COMMERCE_CANONICAL_REVERSAL_SOURCE_REQUIRED'); break;
   case 'SUBSCRIPTION': {
    if(!contract||!sameRef(e.payload.contractRef,ref))fail('COMMERCE_CARE_SOURCE_JOB_BINDING_DENIED');
    if (!['SERVICE_AUTHORITY', 'ACCOUNTING'].includes(e.source.system)) fail('COMMERCE_AUTHORITATIVE_SUBSCRIPTION_REQUIRED', 403);
    const terms = rows.find(r => r.kind === 'SUBSCRIPTION_TERMS' && sameRef(r.payload.contractRef, e.payload.contractRef) && r.payload.termsDigest === e.payload.termsDigest && r.payload.planKey === e.payload.planKey && r.payload.originalServiceStartAt === e.payload.originalServiceStartAt);
    if (!terms) fail('COMMERCE_SIGNED_SUBSCRIPTION_TERMS_REQUIRED');
    const care=await tx.queryOne<{payload:{planKey:string;renewal:{serviceStartAt:string}|null}}>(`select p.payload from crm_website_sales_enablement_records link join crm_website_sales_enablement_records p on p.workspace_id=link.workspace_id and p.project_id=link.project_id and p.company_id=link.company_id and p.location_id=link.location_id and p.workflow_id=link.workflow_id and p.entity_id=(link.payload->>'careProposalId')::uuid and p.kind='CARE_PROPOSAL' join crm_offers o on o.workspace_id=link.workspace_id and o.id=(link.payload->>'offerId')::uuid where link.workspace_id=$1 and link.project_id=$2 and link.company_id=$3 and link.location_id=$4 and link.workflow_id=$5 and link.kind='CARE_OFFER' and o.id=(select (payload->'offerRef'->>'id')::uuid from crm_website_sales_commerce_records where workspace_id=$1 and entity_id=$6 and version=$7 and kind='CONTRACT') and o.status='ACCEPTED' order by p.version desc limit 1`,[...params(b,b),e.payload.contractRef.id,e.payload.contractRef.version]);
    if(!care||care.payload.planKey!==e.payload.planKey)fail('COMMERCE_CANONICAL_CARE_CONTRACT_REQUIRED'); const contractRow=rows.find(r=>r.kind==='CONTRACT'&&sameRef({id:r.entityId,version:r.version,digest:r.digest},e.payload.contractRef));if(!contractRow)fail('COMMERCE_CONTRACT_REQUIRED');const body=commerceContractDraftSchema.parse(contractRow.payload);if(!body.contractTerm||e.payload.originalServiceStartAt!==(care.payload.renewal?.serviceStartAt??body.contractTerm.startAt))fail('COMMERCE_ORIGINAL_SERVICE_START_CHANGED');if(e.payload.status==='ACTIVE')await currentSignature(e.payload.contractRef,body);
    break;
   }
  }
  const entityRef = e.kind === 'PROVIDER_DELIVERY' ? e.payload.documentRef : e.kind === 'SIGNATURE' || e.kind === 'DELIVERY_ACCEPTANCE' || e.kind === 'INVOICE' || e.kind === 'SUBSCRIPTION' ? e.payload.contractRef : ref;
  await tx.execute(`insert into crm_website_sales_commerce_sources(id,workspace_id,project_id,company_id,location_id,workflow_id,job_id,provider,account_reference,event_id,kind,event_digest,entity_id,entity_version,document_digest,payload,occurred_at,received_by_actor_id,verification_workload_id,verification_grant_id,verification_authority_reference)values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17,$18,$19,$20,$21)`, [e.eventId, ...params(b, b), job.id, e.source.provider, e.source.accountReference, e.eventId, e.kind, semantic(e), entityRef.id, entityRef.version, entityRef.digest, JSON.stringify(e), e.occurredAt,b.actorId,b.workloadId,b.grantId,b.authorityReference]);
  if(e.kind==='PROVIDER_DELIVERY'&&e.payload.status==='COMPLAINED')await tx.query('select crm_website_sales_commerce_suppress_complaint($1,$2,$3)',[e.eventId,b.workloadId,b.grantId]);
  // Provider acceptance and delivery remain separate facts. Exact late proof can resolve UNKNOWN.
  if (e.kind === 'PROVIDER_DELIVERY' || e.kind === 'SIGNATURE' || e.kind === 'INVOICE') {
   const reference = e.kind === 'PROVIDER_DELIVERY' ? e.payload.providerMessageId : e.kind === 'SIGNATURE' ? e.payload.envelopeId : e.source.resourceId;
   if (job.status !== 'ACCEPTED') await tx.execute("update crm_website_sales_commerce_jobs set status='ACCEPTED',version=version+1,lease_token=null,lease_expires_at=null,provider_reference=$2,error_code=null,updated_at=clock_timestamp() where id=$1", [job.id, reference]);
  }
  if (e.kind === 'PROVIDER_DELIVERY' && e.payload.documentKind === 'OFFER' && e.payload.status === 'DELIVERED') {
   await tx.execute("update crm_offer_deliveries set status='PROVIDER_DELIVERED',receipt_reference=$4,attested_by=null,attested_at=$5 where workspace_id=$1 and offer_id=$2 and revision=$3 and content_digest=$6 and status in('QUEUED','UNKNOWN')", [b.workspaceId, job.offerId, job.offerRevision, e.eventId, e.occurredAt, ref.digest]);
   await tx.execute("update crm_offers set status='SENT',version=version+1,updated_at=clock_timestamp() where workspace_id=$1 and id=$2 and revision=$3 and status='QUEUED'", [b.workspaceId, job.offerId, job.offerRevision]);
  }
  if(e.kind==='SIGNATURE')await projectVerifiedWebsiteSalesClosing(tx,b,job,e,[...history,e]);
  if(e.kind==='PROVIDER_DELIVERY'&&e.payload.documentKind==='OFFER'&&e.payload.status==='DELIVERED'){
   const candidates=await tx.query<{event:Extract<Event,{kind:'SIGNATURE'}>;payload:Record<string,unknown>;firstAttemptAt:string|null}>(`select sig.payload as event,j.payload,j.first_attempt_at as "firstAttemptAt" from crm_website_sales_commerce_sources sig join crm_website_sales_commerce_jobs j on j.workspace_id=sig.workspace_id and j.id=sig.job_id and j.kind='SIGNATURE_REQUEST' join crm_website_sales_commerce_records c on c.workspace_id=sig.workspace_id and c.project_id=sig.project_id and c.company_id=sig.company_id and c.location_id=sig.location_id and c.workflow_id=sig.workflow_id and c.kind='CONTRACT' and c.entity_id=(sig.payload->'payload'->'contractRef'->>'id')::uuid and c.version=(sig.payload->'payload'->'contractRef'->>'version')::integer and c.record_digest=sig.payload->'payload'->'contractRef'->>'digest' where sig.workspace_id=$1 and sig.project_id=$2 and sig.company_id=$3 and sig.location_id=$4 and sig.workflow_id=$5 and sig.kind='SIGNATURE' and sig.payload->'payload'->>'status'='SIGNED' and c.payload->'offerRef'=$6::jsonb order by sig.received_at desc limit 25`,[...params(b,b),JSON.stringify(e.payload.documentRef)]);
   for(const signed of candidates)await projectVerifiedWebsiteSalesClosing(tx,b,{kind:'SIGNATURE_REQUEST',identity:job.identity,payload:signed.payload,firstAttemptAt:signed.firstAttemptAt},signed.event,[...history,e]);
  }
  const actor = { workspaceId: b.workspaceId, userId: b.actorId }, workflow = await tx.queryOne<{ version: number }>('select version from crm_website_sales_workflows where workspace_id=$1 and id=$2', [b.workspaceId, b.workflowId]); if (!workflow) fail('COMMERCE_WORKFLOW_SCOPE_DENIED', 403);
  const aggregate = await commerceAggregate(tx, b, b, true), next = await commerceAdvance(tx, actor, b, aggregate, null);
  if (e.kind === 'DELIVERY_ACCEPTANCE') await commercePersist(tx, actor, b, next, Number(workflow.version), 'DELIVERY_ACCEPTANCE', e.payload, null, undefined, 'VERIFIED_CUSTOMER');
  if (e.kind === 'SUBSCRIPTION') {
   const prior = rows.find(r => r.kind === 'SUBSCRIPTION_TERMS' && sameRef(r.payload.contractRef, e.payload.contractRef) && r.payload.termsDigest === e.payload.termsDigest);
   await commercePersist(tx, actor, b, next, Number(workflow.version), 'SUBSCRIPTION_TERMS', commerceSubscriptionTermsSchema.parse({ ...e.payload, canonicalSourceEventId: e.eventId }), null, prior?.entityId, 'VERIFIED_PROVIDER');
  }
  if ((e.kind === 'PAYMENT' || e.kind === 'REFUND') && e.payload.status === 'SETTLED') for (const allocation of e.payload.allocations) {
   if (!allocation.amountMinor) continue;
   const invoice = history.find(p => p.eventId === allocation.invoiceSourceEventId); if (!invoice || invoice.kind !== 'INVOICE') fail('COMMERCE_CANONICAL_INVOICE_SOURCE_REQUIRED');
   const invoiceRecord = rows.find(r => r.kind === 'INVOICE_REQUEST' && r.entityId === invoice.payload.invoiceRequestId); if (!invoiceRecord) fail('COMMERCE_CANONICAL_INVOICE_REQUEST_REQUIRED');
   await tx.execute('insert into crm_website_sales_commerce_allocations(id,workspace_id,project_id,company_id,location_id,workflow_id,source_id,invoice_id,invoice_version,installment_id,kind,amount_minor,currency)values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)', [randomUUID(), ...params(b, b), e.eventId, invoiceRecord.entityId, invoiceRecord.version, allocation.installmentId, e.kind, allocation.amountMinor, e.payload.currency]);
  }
  if(e.kind==='REVERSAL'){const originals=await tx.query<{id:string;invoiceId:string;invoiceVersion:number;installmentId:string;amount:string;currency:string}>(`select id,invoice_id as "invoiceId",invoice_version as "invoiceVersion",installment_id as "installmentId",amount_minor as amount,currency from crm_website_sales_commerce_allocations where workspace_id=$1 and source_id=$2`,[b.workspaceId,e.payload.reversesEventId]);for(const row of originals)await tx.execute(`insert into crm_website_sales_commerce_allocations(id,workspace_id,project_id,company_id,location_id,workflow_id,source_id,invoice_id,invoice_version,installment_id,kind,amount_minor,currency,reverses_id)values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'REVERSAL',$11,$12,$13)`,[randomUUID(),...params(b,b),e.eventId,row.invoiceId,Number(row.invoiceVersion),row.installmentId,row.amount,row.currency,row.id]);}
  return { status: 'RECORDED' as const, sourceEventId: e.eventId, version: next.version, financialAssessment: financial.status };
 });
}
