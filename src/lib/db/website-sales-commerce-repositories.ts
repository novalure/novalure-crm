import 'server-only';
import { assertWebsiteSalesCareContractTerm } from './website-sales-commerce-care';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AppSession } from '../auth/session';
import { executeCrmCommand, reconcileCrmCommand, withCrmCommandPreflight, withCrmRead, type TenantTransaction, type TenantTransactionOptions } from '../crm-command';
import { websiteSalesActorAuthority, websiteSalesMachineHasScope } from '../website-sales-machine-authority';
import { websiteSalesCommerceContract, websiteSalesCommerceCommandSchema, websiteSalesCommercePayloadSchemas as schemas, websiteSalesCommerceMachineOperations, websiteSalesCommerceOwnerOperations, commerceReferenceSchema, commerceTemplateSchema, commercePolicySchema, commerceContractDraftSchema, commerceInvoiceRequestSchema, commerceDeliveryAcceptanceSchema, commerceSubscriptionTermsSchema, type WebsiteSalesCommerceCommand as Command, type WebsiteSalesCommerceRead, type CommerceRecord, type CommerceReference }  from '../website-sales-commerce-types';
import { commerceDigest, requiredWebsiteSalesContractApprovalSteps, prepareWebsiteSalesContract, prepareWebsiteSalesInvoiceRequest, proposeWebsiteSalesRenewal, resolveWebsiteSalesCommerceSignature, resolveWebsiteSalesCommerceSubscription, assessWebsiteSalesCommerceSources, reconcileWebsiteSalesCommerceSources } from '../website-sales-commerce-domain';
import { getOfferApprovalReference } from './approval-reference-repositories';
import { executeOfferCommand } from './offer-repositories';
import { commerceFail as fail, commerceIso as iso, commerceIdentity as identity, commerceParams as params, commerceProjectLock, commerceState, commerceAggregate, commerceRows, commerceRecord, commerceBoundRecord, commerceExactRecord, commerceAdvance, commercePersist, commerceReference, type CommerceScope as Scope, type CommerceRow } from './website-sales-commerce-storage';
import { currentWebsiteSalesCommerceApproval } from './website-sales-commerce-guards';
import type { CommerceJobKind } from './website-sales-commerce-outbox';
import { validateWebsiteSalesCommerceRead } from '../website-sales-commerce-read';
import { renderCanonicalWebsiteSalesOffer as offerDocumentText } from '../website-sales-commerce-render';

type Json = Record<string, unknown>;
const now = () => new Date().toISOString();
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function scope(c: { projectId: string; companyId: string; locationId: string | null; workflowId: string }): Scope {
 if (!c.locationId) fail('COMMERCE_LOCATION_REQUIRED', 400);
 return { projectId: c.projectId, companyId: c.companyId, locationId: c.locationId, workflowId: c.workflowId };
}
function obj(value: unknown): Json { if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_COMMERCE_PAYLOAD', 400); return value as Json; }
function referencesCurrent(raw: unknown) {
 const visit = (v: unknown) => { if (Array.isArray(v)) { v.forEach(visit); return; } if (!v || typeof v !== 'object') return;
  const o = v as Json; if (typeof o.observedAt === 'string' && typeof o.validUntil === 'string' && (Date.parse(o.observedAt) > Date.now() || Date.parse(o.validUntil) <= Date.now())) fail('COMMERCE_SOURCE_NOT_CURRENT'); Object.values(o).forEach(visit);
 }; visit(raw);
}
async function owner(tx: TenantTransaction, s: AppSession) { if (s.serviceIdentity || !(await tx.queryOne<{ ok: boolean }>('select crm_sales_ops_owner($1) as ok', [s.workspaceId]))?.ok) fail('COMMERCE_OWNER_REQUIRED', 403); }
async function freshOwner(tx: TenantTransaction, s: AppSession) {
 await owner(tx, s); const configured = await tx.queryOne<{ id: string | null }>('select crm_offer_configured_approver($1) as id', [s.workspaceId]);
 if (configured?.id !== s.userId) fail('COMMERCE_CONFIGURED_OWNER_REQUIRED', 403);
 if (!s.authSessionId || !s.authIdentityId) fail('FRESH_MFA_AUTHENTICATION_REQUIRED', 401);
 const row = await tx.queryOne<{ mfa: string }>(`select mfa_verified_at::text as mfa from auth_sessions where id=$1 and auth_identity_id=$2 and workspace_id=$3 and workspace_user_id=$4 and revoked_at is null and expires_at>clock_timestamp() and mfa_verified_at between clock_timestamp()-interval '15 minutes' and clock_timestamp() for share`, [s.authSessionId, s.authIdentityId, s.workspaceId, s.userId]);
 if (!row) fail('FRESH_MFA_AUTHENTICATION_REQUIRED', 401); return { sessionId: s.authSessionId, identityId: s.authIdentityId, mfa: row.mfa };
}
export function parseWebsiteSalesCommerceCommand(raw: unknown) { return websiteSalesCommerceCommandSchema.parse(raw); }
export function websiteSalesCommerceCommandInput(s: AppSession, raw: Command) {
 const c = parseWebsiteSalesCommerceCommand(raw), bound = scope(c), machine = websiteSalesActorAuthority(s, bound, c.operation, 'autonomy');
 if (s.serviceIdentity && !(websiteSalesCommerceMachineOperations as readonly string[]).includes(c.operation)) fail('COMMERCE_OWNER_REQUIRED', 403);
 return { operation: `website_sales.commerce.${c.operation}`, projectId: c.projectId, resourceId: c.locationId!, capability: 'pipeline:write' as const, idempotencyKey: c.idempotencyKey, correlationId: c.correlationId, payload: { request: raw, machine } };
}
async function canonicalOffers(tx: TenantTransaction, s: AppSession, b: Scope) {
 return tx.query<{ id: string; dealId: string; version: number; revision: number; status: string; approvalReference: string | null; content: Json; contentDigest: string; total: string; createdBy: string; createdAt: string }>(`select o.id,o.deal_id as "dealId",o.version,o.revision,o.status,o.approval_id as "approvalReference",r.content,r.content_digest as "contentDigest",r.total_net_cents as total,o.created_by as "createdBy",o.created_at as "createdAt" from crm_offers o join crm_offer_revisions r on r.workspace_id=o.workspace_id and r.offer_id=o.id and r.revision=o.revision where o.workspace_id=$1 and o.project_id=$2 and o.organization_id=$3 and(o.id=(select offer_draft_id from crm_website_sales_workflows where workspace_id=$1 and id=$5 and location_id=$4) or exists(select 1 from crm_website_sales_enablement_records e where e.workspace_id=o.workspace_id and e.workflow_id=$5 and e.location_id=$4 and e.kind='CARE_OFFER' and e.payload->>'offerId'=o.id::text)) order by o.created_at desc limit 25`, params(s, b));
}
async function offer(tx: TenantTransaction, s: AppSession, b: Scope, ref: CommerceReference) { const row = (await canonicalOffers(tx, s, b)).find(o => o.id === ref.id); if (!row || Number(row.revision) !== ref.version || row.contentDigest !== ref.digest) fail('COMMERCE_CURRENT_OFFER_REQUIRED'); return row; }
async function policy(tx: TenantTransaction, s: AppSession, b: Scope, ref: CommerceReference) { const row = await commerceBoundRecord(tx, s, b, ref, 'POLICY'); referencesCurrent(row.payload); return commerceRecord<z.infer<typeof commercePolicySchema>>(row, s, b); }
async function sourceEvents(tx: TenantTransaction, s: { workspaceId: string }, b: Scope, limit = 1001) { const rows = await tx.query<{ payload: unknown }>(`select payload from crm_website_sales_commerce_sources where workspace_id=$1 and project_id=$2 and company_id=$3 and location_id=$4 and workflow_id=$5 order by received_at desc,id desc limit $6`, [...params(s, b), limit]); if(rows.length>1000)fail('COMMERCE_FINANCIAL_HISTORY_LIMITED');return rows.map(r => r.payload) as WebsiteSalesCommerceRead['sourceEvents']; }
async function deliveryTasks(tx: TenantTransaction, s: AppSession, b: Scope) {
 const rows = await tx.query<{ id: string; version: number; title: string }>(`select t.id,t.version,t.title from crm_website_sales_handoffs h join tasks t on t.workspace_id=h.workspace_id and t.id=h.task_id where h.workspace_id=$1 and h.project_id=$2 and h.company_id=$3 and h.location_id=$4 and h.workflow_id=$5 and t.status='done' order by t.updated_at desc limit 25`, params(s, b));
 return rows.map(r => ({ taskRef: { id: r.id, version: Number(r.version), digest: commerceDigest({ id: r.id, version: Number(r.version), title: r.title, status: 'DONE' }) }, identity: identity(s, b), workflowId: b.workflowId, title: r.title, status: 'DONE' as const }));
}
async function approvals(tx: TenantTransaction, s: AppSession, b: Scope) {
 const rows = await tx.query<{ id: string; documentId: string; documentVersion: number; documentDigest: string; recipientDigest: string; financialDigest: string; requiredSteps: number; expiresAt: string }>(`select id,document_id as "documentId",document_version as "documentVersion",document_digest as "documentDigest",recipient_digest as "recipientDigest",tax_digest as "financialDigest",required_steps as "requiredSteps",expires_at as "expiresAt" from crm_website_sales_commerce_approvals where workspace_id=$1 and project_id=$2 and company_id=$3 and location_id=$4 and workflow_id=$5 order by created_at desc limit 25`, params(s, b));
 const docs = await commerceRows(tx, s, b, 'CONTRACT'), result = [];
 for (const a of rows) {
  const doc = docs.find(r => r.entityId === a.documentId && r.version === Number(a.documentVersion)); if (!doc) continue;
  const steps = await tx.query<{ decision: string }>('select decision from crm_website_sales_commerce_approval_steps where workspace_id=$1 and approval_id=$2', [s.workspaceId, a.id]), completed = steps.filter(v => v.decision === 'APPROVED').length;
  const challenge = s.authSessionId ? await tx.queryOne<{ id: string; stepNumber: 1 | 2; expiresAt: string }>(`select c.id,c.step_number as "stepNumber",c.expires_at as "expiresAt" from crm_website_sales_commerce_challenges c where c.workspace_id=$1 and c.approval_id=$2 and c.actor_id=$3 and c.auth_session_id=$4 and c.expires_at>clock_timestamp() and not exists(select 1 from crm_website_sales_commerce_approval_steps st where st.workspace_id=c.workspace_id and st.challenge_id=c.id) order by c.created_at desc limit 1`, [s.workspaceId, a.id, s.userId, s.authSessionId]) : null;
  result.push({ approvalId: a.id, documentRef: { id: a.documentId, version: Number(a.documentVersion), digest: a.documentDigest }, documentSha256: String(doc.payload.documentSha256), recipientDigest: a.recipientDigest, financialDigest: a.financialDigest, requiredSteps: Number(a.requiredSteps) as 1 | 2, completedSteps: completed, status: steps.some(v => v.decision === 'REVOKED') ? 'REVOKED' as const : Date.parse(iso(a.expiresAt)) <= Date.now() ? 'EXPIRED' as const : completed === Number(a.requiredSteps) ? 'APPROVED' as const : 'PENDING' as const, expiresAt: iso(a.expiresAt), currentChallenge: challenge ? { challengeId: challenge.id, stepNumber: challenge.stepNumber, expiresAt: iso(challenge.expiresAt) } : null });
 } return result;
}
function currentRows(rows: CommerceRow[], kind: string, limit: number) { const seen = new Set<string>(); return rows.filter(r => { if (r.kind !== kind || seen.has(r.entityId)) return false; seen.add(r.entityId); return true; }).slice(0, limit); }

async function read(tx: TenantTransaction, s: AppSession, b: Scope): Promise<WebsiteSalesCommerceRead> {
 if (!websiteSalesMachineHasScope(s, b, 'crm.website-sales.commerce.read')) fail('COMMERCE_READ_SCOPE_REQUIRED', 403);
 const state = await commerceState(tx, s, b), a = await commerceAggregate(tx, s, b), rows = await commerceRows(tx, s, b), owned = !s.serviceIdentity && !!(await tx.queryOne<{ ok: boolean }>('select crm_sales_ops_owner($1) as ok', [s.workspaceId]))?.ok;
 const contractRows=await commerceRows(tx,s,b,'CONTRACT');const contracts = currentRows(contractRows, 'CONTRACT', 4).map(r => commerceRecord<z.infer<typeof commerceContractDraftSchema>>(r, s, b));
 for(const doc of contracts)for(const[kind,ref]of [['TEMPLATE',doc.payload.templateRef],['POLICY',doc.payload.policyRef]]as const)if(!rows.some(r=>r.kind===kind&&r.entityId===ref.id&&r.version===ref.version&&r.digest===ref.digest))rows.push(await commerceExactRecord(tx,s,b,ref,kind));
 const templateRefs = contracts.map(c => c.payload.templateRef), policyRefs = contracts.map(c => c.payload.policyRef);
 const select = (kind: string, refs: CommerceReference[]) => rows.filter(r => r.kind === kind && (currentRows(rows, kind, 4).includes(r) || refs.some(f => f.id === r.entityId && f.version === r.version && f.digest === r.digest))).slice(0, 12);
 const templates = select('TEMPLATE', templateRefs).map(r => commerceRecord<z.infer<typeof commerceTemplateSchema>>(r, s, b)), policies = select('POLICY', policyRefs).map(r => commerceRecord<z.infer<typeof commercePolicySchema>>(r, s, b)), latestPolicy = policies[0] ?? null;
 const nativeOffers = await canonicalOffers(tx, s, b), offers: WebsiteSalesCommerceRead['offers'] = [];
 const offerRows=[...nativeOffers];for(const doc of contracts){const ref=doc.payload.offerRef;if(offerRows.some(o=>o.id===ref.id&&Number(o.revision)===ref.version&&o.contentDigest===ref.digest))continue;const old=await tx.queryOne<(typeof nativeOffers)[number]>(`select o.id,o.deal_id as "dealId",o.version,r.revision,o.status,o.approval_id as "approvalReference",r.content,r.content_digest as "contentDigest",r.total_net_cents as total,o.created_by as "createdBy",o.created_at as "createdAt" from crm_offers o join crm_offer_revisions r on r.workspace_id=o.workspace_id and r.offer_id=o.id where o.workspace_id=$1 and o.project_id=$2 and o.organization_id=$3 and o.id=$6 and r.revision=$7 and r.content_digest=$8 and exists(select 1 from crm_website_sales_workflows w where w.workspace_id=$1 and w.id=$5 and w.location_id=$4 and(w.offer_draft_id=o.id or exists(select 1 from crm_website_sales_enablement_records e where e.workspace_id=$1 and e.workflow_id=w.id and e.kind='CARE_OFFER' and e.payload->>'offerId'=o.id::text)))`,[...params(s,b),ref.id,ref.version,ref.digest]);if(old)offerRows.push(old);}
 for (const o of offerRows) {
  const p = policies.find(p => p.payload.offerRef.id === o.id && p.payload.offerRef.version === Number(o.revision) && p.payload.offerRef.digest === o.contentDigest);
  if (!p || !['DRAFT', 'APPROVED', 'QUEUED', 'SENT', 'ACCEPTED', 'REJECTED', 'CANCELLED'].includes(o.status)) continue;
  const offerRef = { id: o.id, version: Number(o.revision), digest: o.contentDigest };
  offers.push({ id: o.id, identity: identity(s, b), workflowId: b.workflowId, version: Number(o.revision), workflowVersion: state.row.version, digest: o.contentDigest, createdBy: o.createdBy, createdAt: iso(o.createdAt), validUntil: String(o.content.validUntil), revokedAt: null, payload: { offerRef, dealId: o.dealId, status: o.status as 'DRAFT', recipientEmail: String(o.content.recipientEmail), recipientDigest: commerceDigest(String(o.content.recipientEmail).toLowerCase()), scopeDigest: commerceDigest(o.content.scope), financial: p.payload.financialSnapshot, approvalReference: o.approvalReference } });
 }
 const sourceHistory=await sourceEvents(tx,s,b,501);const historyComplete=sourceHistory.length<=500&&Buffer.byteLength(JSON.stringify(sourceHistory))<=800000;const events=historyComplete?sourceHistory:sourceHistory.slice(0,50);const jobs = await tx.query<{ id: string; kind: CommerceJobKind; version: number; entityId: string; entityVersion: number; payload: Json; payloadDigest: string; status: WebsiteSalesCommerceRead['outbox'][number]['status']; providerReference: string | null; updatedAt: string }>(`select id,kind,version,entity_id as "entityId",entity_version as "entityVersion",payload,payload_digest as "payloadDigest",status,provider_reference as "providerReference",updated_at as "updatedAt" from crm_website_sales_commerce_jobs where workspace_id=$1 and project_id=$2 and company_id=$3 and location_id=$4 and workflow_id=$5 order by created_at desc limit 100`, params(s, b));
 const blockers: WebsiteSalesCommerceRead['blockers'] = [];
 if (rows.length >= 250 || !historyComplete) blockers.push({ code: 'COMMERCE_HISTORY_LIMITED', reference: null });
 if (!latestPolicy) blockers.push({ code: 'COMMERCE_ACCOUNTING_POLICY_REQUIRED', reference: null });
 const unknown = jobs.some(j => j.status === 'UNKNOWN' || j.status === 'CLAIMED'); if (unknown) blockers.push({ code: 'COMMERCE_EFFECT_OUTCOME_UNKNOWN', reference: null });
 const canWrite = s.permissions.includes('crm:write') && s.productPermissions.includes('pipeline:write') && (!s.serviceIdentity || websiteSalesCommerceMachineOperations.some(op => websiteSalesMachineHasScope(s, b, 'crm.website-sales.commerce.' + op.replaceAll('_', '-'))));
 const offersChoices = nativeOffers.map(o => ({identity:identity(s,b),workflowId:b.workflowId,offerRef:{id:o.id,version:Number(o.revision),digest:o.contentDigest},dealId:o.dealId,status:o.status,recipientEmail:String(o.content.recipientEmail),recipientDigest:commerceDigest(String(o.content.recipientEmail).toLowerCase()),scopeDigest:commerceDigest(o.content.scope),totalNetMinor:Number(o.total),currency:'EUR' as const,taxBasis:'NET' as const}));
 const hasContract=(ref:unknown)=>contracts.some(c=>commerceDigest(commerceReference(c))===commerceDigest(ref));
 const acceptances=currentRows(rows,'DELIVERY_ACCEPTANCE',12).filter(r=>hasContract(r.payload.contractRef)).map(r=>commerceRecord<z.infer<typeof commerceDeliveryAcceptanceSchema>>(r,s,b));
 let canApproveContract=false;if(owned){try{await freshOwner(tx,s);canApproveContract=true;}catch(error){if(!(error instanceof Error)||!('code' in error))throw error;}}
 const result = { contractVersion: websiteSalesCommerceContract, source: 'database' as const, identity: identity(s, b), workflowId: b.workflowId, version: a?.version ?? 0, workflowVersion: state.row.version, canWrite, canApproveFacts: owned, canApproveContract, canContact: false as const,
  actionEligibility: Object.keys(schemas).map(operation => ({ operation, eligible: canWrite && (!(websiteSalesCommerceOwnerOperations as readonly string[]).includes(operation) || owned) && (!unknown||operation==='revoke_contract_approval'), blockers: !canWrite ? ['COMMERCE_WRITE_DENIED'] : (websiteSalesCommerceOwnerOperations as readonly string[]).includes(operation) && !owned ? ['COMMERCE_OWNER_REQUIRED'] : unknown&&operation!=='revoke_contract_approval' ? ['COMMERCE_EFFECT_OUTCOME_UNKNOWN'] : [] })),
  eligibleDeliveryTasks: await deliveryTasks(tx, s, b), sourceConnections: [], templates, policy: latestPolicy, policies, offers, offerChoices:offersChoices, contracts, approvals: (await approvals(tx, s, b)).filter(a=>hasContract(a.documentRef)),
  deliveryAcceptances: acceptances, invoiceRequests: currentRows(rows, 'INVOICE_REQUEST', 12).filter(r=>hasContract(r.payload.contractRef)&&(!r.payload.deliveryAcceptanceRef||acceptances.some(a=>commerceDigest(commerceReference(a))===commerceDigest(r.payload.deliveryAcceptanceRef)))).map(r => commerceRecord<z.infer<typeof commerceInvoiceRequestSchema>>(r, s, b)),
  invoices: events.filter(e => ['INVOICE','CREDIT_NOTE'].includes(e.kind)).slice(0, 25), payments: events.filter(e => ['PAYMENT', 'REFUND', 'REVERSAL'].includes(e.kind)).slice(0, 50), subscriptions: currentRows(rows, 'SUBSCRIPTION_TERMS', 12).filter(r=>hasContract(r.payload.contractRef)).map(r => commerceRecord<z.infer<typeof commerceSubscriptionTermsSchema>>(r, s, b)),
  outbox: jobs.map(j => ({ id: j.id, identity: identity(s, b), workflowId: b.workflowId, version: Number(j.version), kind: j.kind, documentRef: commerceReferenceSchema.parse(j.payload.documentRef), payloadDigest: j.payloadDigest, status: j.status, providerReference: j.providerReference, updatedAt: iso(j.updatedAt) })), sourceEvents:events,sourceAssessment:assessWebsiteSalesCommerceSources({identity:identity(s,b),workflowId:b.workflowId,events,historyComplete},now()),financialAssessment:reconcileWebsiteSalesCommerceSources({identity:identity(s,b),workflowId:b.workflowId,events,historyComplete},now()),blockers };
 const parsed = validateWebsiteSalesCommerceRead(result,identity(s,b),b.workflowId); if (Buffer.byteLength(JSON.stringify(parsed)) > 3500000) fail('COMMERCE_READ_BOUND_EXCEEDED', 409); return parsed;
}
export async function readWebsiteSalesCommerce(s: AppSession, raw: Omit<Scope, 'locationId'> & { locationId: string | null }, options: TenantTransactionOptions = {}) { const b = scope(raw); websiteSalesActorAuthority(s, b, 'read', 'autonomy'); return withCrmRead(s, (tx, fresh) => read(tx, fresh, b), options); }
async function enqueue(tx: TenantTransaction, s: AppSession, b: Scope, a: { id: string }, kind: CommerceJobKind, entity: { id: string; version: number }, payload: Json, commandId: string, offerId: string | null = null, offerRevision: number | null = null) {
 const exists = await tx.queryOne<{ id: string }>("select id from crm_website_sales_commerce_jobs where workspace_id=$1 and workflow_id=$2 and kind=$3 and entity_id=$4 and entity_version=$5 and status not in('CANCELLED','REJECTED')", [s.workspaceId, b.workflowId, kind, entity.id, entity.version]); if (exists) fail('COMMERCE_EFFECT_ALREADY_QUEUED');
 if (await tx.queryOne("select id from crm_website_sales_commerce_jobs where workspace_id=$1 and workflow_id=$2 and status in('CLAIMED','UNKNOWN')", [s.workspaceId, b.workflowId])) fail('COMMERCE_EFFECT_OUTCOME_UNKNOWN');
 const id = randomUUID(); await tx.execute(`insert into crm_website_sales_commerce_jobs(id,workspace_id,project_id,company_id,location_id,workflow_id,commerce_id,kind,entity_id,entity_version,offer_id,offer_revision,payload,payload_digest,idempotency_key,command_id,created_by)values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15,$16,$17)`, [id, ...params(s, b), a.id, kind, entity.id, entity.version, offerId, offerRevision, JSON.stringify(payload), commerceDigest(payload), id, commandId, s.userId]); return id;
}
function checkedResult<T>(value: { status: string; reasons: string[]; value: T | null }): T { if (value.status !== 'READY' || value.value === null) fail(value.reasons[0] ?? 'COMMERCE_CURRENT_SOURCE_REQUIRED'); return value.value; }

export async function executeWebsiteSalesCommerceCommand(s: AppSession, raw: Command, options: TenantTransactionOptions = {}) {
 const c = parseWebsiteSalesCommerceCommand(raw), b = scope(c), input = websiteSalesCommerceCommandInput(s, c);
 return withCrmCommandPreflight(s, input, async (outer, fresh) => {
  await commerceProjectLock(outer, fresh.workspaceId, b.projectId); await commerceState(outer, fresh, b, true, true);
  const result = await executeCrmCommand(fresh, input, async (tx, context) => {
   const s = context.session, state = await commerceState(tx, s, b, true, true), a = await commerceAggregate(tx, s, b, true);
   if ((a?.version ?? 0) !== c.expectedVersion) fail('COMMERCE_VERSION_CONFLICT'); if (state.row.version !== c.expectedWorkflowVersion) fail('COMMERCE_WORKFLOW_VERSION_CONFLICT');
   if ((websiteSalesCommerceOwnerOperations as readonly string[]).includes(c.operation)) await owner(tx, s);
   const next = await commerceAdvance(tx, s, b, a, context.commandId), ctx = { identity: identity(s, b), workflowId: b.workflowId, workflowVersion: state.row.version };
   let stored: CommerceRecord<unknown> | null = null, outboxId: string | null = null, recordId: string | null = null;
   switch (c.operation) {
    case 'register_template': {
     const p = schemas.register_template.parse(c.payload); referencesCurrent(p);
     if (hash(p.content) !== p.contentSha256 || new Set(p.allowedVariableKeys).size !== p.allowedVariableKeys.length) fail('COMMERCE_TEMPLATE_DIGEST_MISMATCH');
     stored = await commercePersist(tx, s, b, next, state.row.version, 'TEMPLATE', p, context.commandId, undefined, 'OPERATOR_RECORDED'); break;
    }
    case 'configure_policy': {
     const p = schemas.configure_policy.parse(c.payload), o = await offer(tx, s, b, p.offerRef); referencesCurrent(p);
     await assertWebsiteSalesCareContractTerm(tx,s,b,o.id,p);
     if (Number(o.total) !== p.financialSnapshot.netMinor || p.financialSnapshot.currency !== 'EUR') fail('COMMERCE_CANONICAL_FINANCIAL_MISMATCH');
     const tax = (BigInt(p.financialSnapshot.netMinor) * BigInt(p.accountingProfile.taxRateBps) + BigInt(5000)) / BigInt(10000);
     if (tax > BigInt(Number.MAX_SAFE_INTEGER) || Number(tax) !== p.financialSnapshot.taxMinor || p.paymentTerms.installments.length > p.maxInstallments) fail('COMMERCE_SOURCED_TAX_MISMATCH');
     const prior=(await commerceRows(tx,s,b,'POLICY')).find(r=>r.payload.offerRef&&obj(r.payload.offerRef).id===p.offerRef.id);stored = await commercePersist(tx, s, b, next, state.row.version, 'POLICY', p, context.commandId, prior?.entityId, 'OPERATOR_RECORDED'); break;
    }
    case 'prepare_contract': {
     const p = schemas.prepare_contract.parse(c.payload), o = await offer(tx, s, b, p.offerRef), t = await commerceBoundRecord(tx, s, b, p.templateRef, 'TEMPLATE'), pol = await policy(tx, s, b, p.policyRef);
     if(!['APPROVED','SENT','ACCEPTED'].includes(o.status))fail('COMMERCE_APPROVED_OFFER_REQUIRED');if(await tx.queryOne("select id from crm_website_sales_commerce_jobs where workspace_id=$1 and workflow_id=$2 and status in('CLAIMED','UNKNOWN')",[s.workspaceId,b.workflowId]))fail('COMMERCE_EFFECT_OUTCOME_UNKNOWN');
     await assertWebsiteSalesCareContractTerm(tx,s,b,o.id,pol.payload);
     const offerRecord = { id: o.id, identity: identity(s, b), workflowId: b.workflowId, version: Number(o.revision), workflowVersion: state.row.version, digest: o.contentDigest, createdBy: o.createdBy, createdAt: iso(o.createdAt), validUntil: String(o.content.validUntil), revokedAt: null, payload: { offerRef: p.offerRef, dealId: o.dealId, status: o.status as 'SENT', recipientEmail: String(o.content.recipientEmail), recipientDigest: commerceDigest(String(o.content.recipientEmail).toLowerCase()), scopeDigest: commerceDigest(o.content.scope), financial: pol.payload.financialSnapshot, approvalReference: o.approvalReference } };
     const canonicalVariables = { CUSTOMER_NAME: String(o.content.recipientName), CUSTOMER_EMAIL: String(o.content.recipientEmail), SCOPE: String(o.content.scope), PAYMENT_TERMS: String(o.content.paymentPlan), NET_AMOUNT_MINOR: String(o.total), CURRENCY: 'EUR' };
     const variables=Object.fromEntries(Object.entries(canonicalVariables).filter(([key])=>key==='SCOPE'||(t.payload.allowedVariableKeys as string[]).includes(key)));
     const draft = checkedResult(prepareWebsiteSalesContract({ offer: offerRecord, template: commerceRecord(t, s, b), policy: pol, variables }, ctx, now()));
     stored = await commercePersist(tx, s, b, next, state.row.version, 'CONTRACT', obj(draft), context.commandId); break;
    }
    case 'request_contract_approval': {
     const p = schemas.request_contract_approval.parse(c.payload), auth = await freshOwner(tx, s), doc = await commerceBoundRecord(tx, s, b, p.documentRef, 'CONTRACT'), body = commerceContractDraftSchema.parse(doc.payload); referencesCurrent(body.financial);
     const existing = (await approvals(tx, s, b)).find(v => v.documentRef.id === p.documentRef.id && v.documentRef.digest === p.documentRef.digest && v.status === 'PENDING');
     const id = existing?.approvalId ?? randomUUID(), required = requiredWebsiteSalesContractApprovalSteps(body.financial), completed = existing?.completedSteps ?? 0;
     if (!existing) await tx.execute(`insert into crm_website_sales_commerce_approvals(id,workspace_id,project_id,company_id,location_id,workflow_id,document_id,document_version,document_digest,recipient_digest,total_net_minor,tax_digest,required_steps,created_by,expires_at,command_id)values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`, [id, ...params(s, b), doc.entityId, doc.version, doc.digest, body.recipientDigest, body.financial.netMinor, commerceDigest(body.financial), required, s.userId, new Date(Math.min(doc.validUntil ? Date.parse(iso(doc.validUntil)) : Date.now() + 3600000, Date.now() + 3600000)).toISOString(), context.commandId]);
     const step = (completed + 1) as 1 | 2;
     if (step > required) fail('COMMERCE_APPROVAL_ALREADY_COMPLETE');
     if(step===2){const first=await tx.queryOne<{sessionId:string;fresh:boolean}>(`select st.auth_session_id as "sessionId",(select a.mfa_verified_at from auth_sessions a where a.id=$3)>st.created_at as fresh from crm_website_sales_commerce_approval_steps st where st.workspace_id=$1 and st.approval_id=$2 and st.step_number=1 and st.decision='APPROVED'`,[s.workspaceId,id,auth.sessionId]);if(!first||first.sessionId===auth.sessionId||!first.fresh)fail('INDEPENDENT_FRESH_AUTHENTICATION_REQUIRED',401);}
     await tx.execute('insert into crm_website_sales_commerce_challenges(id,workspace_id,approval_id,step_number,actor_id,auth_session_id,auth_identity_id,expires_at)values($1,$2,$3,$4,$5,$6,$7,$8)', [randomUUID(), s.workspaceId, id, step, s.userId, auth.sessionId, auth.identityId, new Date(Date.now() + 300000).toISOString()]); recordId = id; break;
    }
    case 'approve_contract_step': {
     const p = schemas.approve_contract_step.parse(c.payload), auth = await freshOwner(tx, s); await commerceBoundRecord(tx, s, b, p.documentRef, 'CONTRACT');
     const a = await tx.queryOne<{ id: string }>(`select id from crm_website_sales_commerce_approvals where workspace_id=$1 and project_id=$2 and company_id=$3 and location_id=$4 and workflow_id=$5 and id=$6 and document_id=$7 and document_version=$8 and document_digest=$9 and expires_at>clock_timestamp()`, [...params(s, b), p.approvalId, p.documentRef.id, p.documentRef.version, p.documentRef.digest]); if (!a) fail('COMMERCE_CURRENT_APPROVAL_REQUIRED');
     const ch = await tx.queryOne<{ id: string }>(`select id from crm_website_sales_commerce_challenges where workspace_id=$1 and approval_id=$2 and id=$3 and step_number=$4 and actor_id=$5 and auth_session_id=$6 and auth_identity_id=$7 and expires_at>clock_timestamp()`, [s.workspaceId, a.id, p.challengeId, p.stepNumber, s.userId, auth.sessionId, auth.identityId]); if (!ch) fail('COMMERCE_CURRENT_CHALLENGE_REQUIRED');
     const previous = await tx.queryOne<{ digest: string }>("select step_digest as digest from crm_website_sales_commerce_approval_steps where workspace_id=$1 and approval_id=$2 and step_number=1 and decision='APPROVED'", [s.workspaceId, a.id]);
     const body = { approvalId: a.id, documentRef: p.documentRef, challengeId: ch.id, stepNumber: p.stepNumber, actorId: s.userId, auth, previous: p.stepNumber === 2 ? previous?.digest ?? null : null };
     await tx.execute(`insert into crm_website_sales_commerce_approval_steps(id,workspace_id,approval_id,step_number,challenge_id,actor_id,auth_session_id,auth_identity_id,mfa_verified_at,decision,previous_step_digest,step_digest,command_id)values($1,$2,$3,$4,$5,$6,$7,$8,$9,'APPROVED',$10,$11,$12)`, [randomUUID(), s.workspaceId, a.id, p.stepNumber, ch.id, s.userId, auth.sessionId, auth.identityId, auth.mfa, body.previous, commerceDigest(body), context.commandId]); recordId = a.id; break;
    }
    case 'revoke_contract_approval': {
     const p = schemas.revoke_contract_approval.parse(c.payload), auth = await freshOwner(tx, s), a = (await approvals(tx, s, b)).find(v => v.approvalId === p.approvalId && commerceDigest(v.documentRef) === commerceDigest(p.documentRef)); if (!a) fail('COMMERCE_CURRENT_APPROVAL_REQUIRED');

     await tx.execute("update crm_website_sales_commerce_jobs set status='CANCELLED',version=version+1,updated_at=clock_timestamp() where workspace_id=$1 and workflow_id=$2 and entity_id=$3 and status='READY'",[s.workspaceId,b.workflowId,p.documentRef.id]);
     const challenge = randomUUID(); await tx.execute('insert into crm_website_sales_commerce_challenges(id,workspace_id,approval_id,step_number,actor_id,auth_session_id,auth_identity_id,expires_at)values($1,$2,$3,1,$4,$5,$6,$7)', [challenge, s.workspaceId, a.approvalId, s.userId, auth.sessionId, auth.identityId, new Date(Date.now() + 300000).toISOString()]);
     await tx.execute(`insert into crm_website_sales_commerce_approval_steps(id,workspace_id,approval_id,step_number,challenge_id,actor_id,auth_session_id,auth_identity_id,mfa_verified_at,decision,step_digest,command_id)values($1,$2,$3,1,$4,$5,$6,$7,$8,'REVOKED',$9,$10)`, [randomUUID(), s.workspaceId, a.approvalId, challenge, s.userId, auth.sessionId, auth.identityId, auth.mfa, commerceDigest({ approvalId: a.approvalId, reason: p.reason, auth }), context.commandId]); recordId = a.approvalId; break;
    }
    case 'queue_offer_delivery': {
     const p = schemas.queue_offer_delivery.parse(c.payload), o = await offer(tx, s, b, p.offerRef), approval = await getOfferApprovalReference(s, p.approvalReference, options);
     if (approval.status !== 'APPROVED' || approval.scope.resourceId !== o.id || approval.scope.resourceVersion !== Number(o.revision) || approval.scope.contentDigest !== o.contentDigest || o.approvalReference !== p.approvalReference) fail('VALID_APPROVAL_REQUIRED', 403);
     if (o.status !== 'APPROVED') fail('COMMERCE_APPROVED_OFFER_REQUIRED');
     const bytes = createHash('sha256').update(c.idempotencyKey + ':canonical-offer-queue').digest().subarray(0, 16); bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128; const h = bytes.toString('hex'), key = `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
     await executeOfferCommand(s, { operation: 'queue_send', offerId: o.id, projectId: b.projectId, expectedVersion: Number(o.version), idempotencyKey: key, correlationId: c.correlationId, payload: {} }, options);
     const text = offerDocumentText(o.content, o.total);
     outboxId = await enqueue(tx, s, b, next, 'OFFER_SEND', { id: o.id, version: Number(o.revision) }, { documentRef: p.offerRef, documentSha256: hash(text), recipientEmail: o.content.recipientEmail, recipientDigest: commerceDigest(String(o.content.recipientEmail).toLowerCase()), subject: o.content.subject, text, approvalReference: p.approvalReference }, context.commandId, o.id, Number(o.revision)); break;
    }
    case 'queue_contract_delivery': case 'request_signature': {
     const p = schemas[c.operation].parse(c.payload), doc = await commerceBoundRecord(tx, s, b, p.documentRef, 'CONTRACT'), d = commerceContractDraftSchema.parse(doc.payload);
     await currentWebsiteSalesCommerceApproval(tx, s.workspaceId, b, p.approvalReference, p.documentRef);
     const payload: Json = { documentRef: p.documentRef, documentSha256: d.documentSha256, recipientEmail: d.recipientEmail, recipientDigest: d.recipientDigest, subject: d.title, text: d.body, approvalReference: p.approvalReference, ...(c.operation === 'request_signature' ? { signatureMode: 'CANONICAL_HTML',requiredAssurance:(await commerceExactRecord(tx,s,b,d.policyRef,'POLICY')).payload.signatureAssurance,acceptUntil:String((await offer(tx,s,b,d.offerRef)).content.validUntil) } : {}) };
     outboxId = await enqueue(tx, s, b, next, c.operation === 'request_signature' ? 'SIGNATURE_REQUEST' : 'CONTRACT_SEND', { id: doc.entityId, version: doc.version }, payload, context.commandId, d.offerRef.id, d.offerRef.version); break;
    }
    case 'record_delivery_acceptance': {
     const p = schemas.record_delivery_acceptance.parse(c.payload); await commerceBoundRecord(tx, s, b, p.contractRef, 'CONTRACT'); referencesCurrent(p);
     const task = (await deliveryTasks(tx, s, b)).find(t => t.taskRef.id === p.canonicalDeliveryTaskId && t.taskRef.version === p.expectedDeliveryTaskVersion);
     if (!task || Date.parse(p.acceptedAt) > Date.now()) fail('COMMERCE_CANONICAL_DELIVERY_REQUIRED');
     stored = await commercePersist(tx, s, b, next, state.row.version, 'DELIVERY_ACCEPTANCE', p, context.commandId, undefined, 'OPERATOR_RECORDED'); break;
    }
    case 'prepare_invoice_request': {
     const p = schemas.prepare_invoice_request.parse(c.payload), doc = await commerceBoundRecord(tx, s, b, p.contractRef, 'CONTRACT'), pol = await policy(tx, s, b, p.policyRef), events = await sourceEvents(tx, s, b);
     const signature=checkedResult(resolveWebsiteSalesCommerceSignature({identity:identity(s,b),workflowId:b.workflowId,events,contractRef:p.contractRef,documentSha256:String(doc.payload.documentSha256),requiredAssurance:pol.payload.signatureAssurance},now()));
     const accepted = p.deliveryAcceptanceRef ? await commerceBoundRecord(tx, s, b, p.deliveryAcceptanceRef, 'DELIVERY_ACCEPTANCE') : null;
     if (accepted && !events.some(e => e.kind === 'DELIVERY_ACCEPTANCE' && e.confidence === 'PROVIDER_VERIFIED' && commerceDigest(e.payload) === commerceDigest(accepted.payload))) fail('COMMERCE_VERIFIED_CUSTOMER_ACCEPTANCE_REQUIRED');
     const signedPolicy=commerceRecord<z.infer<typeof commercePolicySchema>>(await commerceExactRecord(tx,s,b,commerceContractDraftSchema.parse(doc.payload).policyRef,'POLICY'),s,b);
     const request = checkedResult(prepareWebsiteSalesInvoiceRequest({ contract: commerceRecord(doc, s, b), policy: pol, signedPolicy, signature, deliveryAcceptance: accepted ? commerceRecord(accepted, s, b) : null, stage: p.stage, installmentIds: p.installmentIds, sourceEvents:events }, ctx, now()));
     stored = await commercePersist(tx, s, b, next, state.row.version, 'INVOICE_REQUEST', obj(request), context.commandId);for(const slot of request.installments)await tx.execute('insert into crm_website_sales_commerce_invoice_slots(workspace_id,project_id,company_id,location_id,workflow_id,contract_id,contract_version,installment_id,request_id,request_version)values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[...params(s,b),p.contractRef.id,p.contractRef.version,slot.installmentId,stored.id,stored.version]);
     outboxId = await enqueue(tx, s, b, next, 'ACCOUNTING_INVOICE_REQUEST', { id: stored.id, version: stored.version }, { documentRef: commerceReference(stored), documentSha256: commerceDigest(request), request }, context.commandId); break;
    }
    case 'record_subscription_terms': {
     const p = schemas.record_subscription_terms.parse(c.payload); await commerceBoundRecord(tx, s, b, p.contractRef, 'CONTRACT'); referencesCurrent(p);
     if (Date.parse(p.periodEndAt) <= Date.parse(p.periodStartAt) || Date.parse(p.originalServiceStartAt) > Date.parse(p.periodStartAt)) fail('COMMERCE_SUBSCRIPTION_PERIOD_INVALID');
     stored = await commercePersist(tx, s, b, next, state.row.version, 'SUBSCRIPTION_TERMS', { ...p, status: 'PENDING_SOURCE', canonicalSourceEventId: null }, context.commandId, undefined, 'OPERATOR_RECORDED'); break;
    }
    case 'request_cancellation': {
     const p = schemas.request_cancellation.parse(c.payload), record = await commerceBoundRecord(tx, s, b, p.subscriptionRef, 'SUBSCRIPTION_TERMS'); referencesCurrent(p);
     stored = await commercePersist(tx, s, b, next, state.row.version, 'CANCELLATION_REQUEST', { subscriptionRef: p.subscriptionRef, effectiveAt: p.effectiveAt, sourceReference: p.sourceReference, status: 'REQUESTED', contractRef: record.payload.contractRef }, context.commandId, undefined, 'OPERATOR_RECORDED');
     outboxId = await enqueue(tx, s, b, next, 'SUBSCRIPTION_CHANGE', { id: stored.id, version: stored.version }, { documentRef: commerceReference(stored), subscriptionRef: p.subscriptionRef, change: 'CANCELLATION_REQUESTED', effectiveAt: p.effectiveAt }, context.commandId); break;
    }
    case 'propose_renewal': {
     const p = schemas.propose_renewal.parse(c.payload), sub = await commerceBoundRecord(tx, s, b, p.subscriptionRef, 'SUBSCRIPTION_TERMS'), events = await sourceEvents(tx, s, b);
     const source=checkedResult(resolveWebsiteSalesCommerceSubscription({identity:identity(s,b),workflowId:b.workflowId,events,terms:commerceSubscriptionTermsSchema.parse(sub.payload)},now()));
     const proposal = checkedResult(proposeWebsiteSalesRenewal({ subscription: commerceRecord(sub, s, b), source, reviewAt: now(), sourceEvents:events }, ctx, now()));
     stored = await commercePersist(tx, s, b, next, state.row.version, 'RENEWAL_PROPOSAL', obj(proposal), context.commandId); break;
    }
   }
   return { identity: identity(s, b), workflowId: b.workflowId, version: next.version, workflowVersion: state.row.version, recordId: stored?.id ?? recordId, recordDigest: stored?.digest ?? null, outboxId, canContact: false as const };
  }, options);
  await commerceState(outer, fresh, b); return { ...result, contractVersion: websiteSalesCommerceContract, persisted: true as const, correlationId: c.correlationId };
 }, options);
}

export async function reconcileWebsiteSalesCommerceCommand(s: AppSession, raw: Command, options: TenantTransactionOptions = {}) {
 const c = parseWebsiteSalesCommerceCommand(raw), b = scope(c), input = websiteSalesCommerceCommandInput(s, c);
 if (!websiteSalesMachineHasScope(s, b, 'crm.website-sales.commerce.read')) fail('COMMERCE_READ_SCOPE_REQUIRED', 403);
 return withCrmCommandPreflight(s, input, async (tx, fresh) => {
  await commerceProjectLock(tx, fresh.workspaceId, b.projectId); await commerceState(tx, fresh, b);
  if ((websiteSalesCommerceOwnerOperations as readonly string[]).includes(c.operation)) await owner(tx, fresh);
  const result = await reconcileCrmCommand(fresh, input, options);
  return result.status === 'NOT_FOUND' ? { contractVersion: 'website-sales-commerce-reconcile-v1' as const, status: 'NOT_FOUND' as const, correlationId: c.correlationId }
   : { contractVersion: 'website-sales-commerce-reconcile-v1' as const, status: 'COMMITTED' as const, correlationId: c.correlationId, receipt: { contractVersion: websiteSalesCommerceContract, persisted: true as const, commandId: result.commandId, auditReference: result.auditReference, correlationId: c.correlationId, replayed: true, data: result.data }, currentData: await read(tx, fresh, b) };
 }, options);
}
