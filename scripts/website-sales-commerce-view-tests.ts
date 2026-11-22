import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { assessWebsiteSalesCommerceSources, commerceSourceFactDigest } from '../src/lib/website-sales-commerce-domain';
import { commerceContractStatus, commerceNewestInvoice, commerceSubscriptionSource } from '../src/lib/website-sales-commerce-view';
import { websiteSalesCommerceSourceEventSchema, type WebsiteSalesCommerceRead, type WebsiteSalesCommerceSourceEvent } from '../src/lib/website-sales-commerce-types';

// These are presentation unit fixtures, not authenticated provider acceptance evidence.
const hash = 'a'.repeat(64), otherHash = 'b'.repeat(64), time = '2026-11-22T10:00:00.000Z';
const sourceReference = { reference: 'synthetic-unit-source', digest: hash, observedAt: time, validUntil: '2027-11-22T10:00:00.000Z' };
function fixture() {
  const identity = { workspaceId: randomUUID(), projectId: randomUUID(), companyId: randomUUID(), locationId: randomUUID() }, workflowId = randomUUID();
  const ref = () => ({ id: randomUUID(), version: 1, digest: hash });
  const contractRef = ref(), policyRef = ref(), templateRef = ref(), offerRef = ref();
  const financial = { currency: 'EUR' as const, netMinor: 10000, taxMinor: 0, grossMinor: 10000, taxReference: sourceReference, termsDigest: hash };
  const paymentTerms = { installments: [{ installmentId: randomUUID(), label: 'Synthetic balance', percentageBps: 10000, dueOffsetDays: 14, anchor: 'DELIVERY_ACCEPTED' as const, kind: 'BALANCE' as const }] };
  const record = { identity, workflowId, workflowVersion: 2, createdBy: randomUUID(), createdAt: time, validUntil: sourceReference.validUntil, revokedAt: null };
  const contract: WebsiteSalesCommerceRead['contracts'][number] = { ...record, ...contractRef, payload: { offerRef, policyRef, templateRef, title: 'Synthetic unit contract', body: 'Synthetic unit body only', documentSha256: otherHash, recipientEmail: 'synthetic@example.invalid', recipientDigest: hash, financial, standardTerms: true, status: 'DRAFT', paymentTerms, signatureSourceEventId: null, deliverySourceEventId: null } };
  const policy: NonNullable<WebsiteSalesCommerceRead['policy']> = { ...record, ...policyRef, payload: { title: 'Synthetic unit policy', standardTermsReference: sourceReference, standardTermsDigest: hash, signatureAssurance: 'PROVIDER_ATTESTED', maxInstallments: 1, accountingEntityReference: 'synthetic', accountingSourceReference: sourceReference, accountingProfile: { issuerLegalName: 'Synthetic unit issuer', issuerAddress: 'Synthetic address', taxIdentifier: null, currency: 'EUR', taxRateBps: 0, rounding: 'HALF_UP', sourceReference }, offerRef, financialSnapshot: financial, paymentTerms, validUntil: sourceReference.validUntil } };
  const data: WebsiteSalesCommerceRead = { contractVersion: 'website-sales-commerce-v1', source: 'database', identity, workflowId, version: 1, workflowVersion: 2, canWrite: false, canApproveFacts: false, canApproveContract: false, canContact: false, actionEligibility: [], eligibleDeliveryTasks: [], sourceConnections: [], offerChoices: [], templates: [], policy, policies: [policy], offers: [], contracts: [contract], approvals: [], deliveryAcceptances: [], invoiceRequests: [], invoices: [], payments: [], subscriptions: [], outbox: [], sourceEvents: [], sourceAssessment: { status: 'READY', activeEventIds: [], invalidatedEventIds: [], reasons: [], complete: true }, blockers: [] };
  const signature = (status: 'SIGNED' | 'VOIDED' | 'PENDING', version = 1) => websiteSalesCommerceSourceEventSchema.parse({ contractVersion: 'website-sales-commerce-source-v1', eventId: randomUUID(), identity, workflowId,
    source: { system: 'SIGNATURE_PROVIDER', provider: 'synthetic-unit-only', accountReference: 'unit', resourceType: 'submission', resourceId: '42', version, digest: hash }, occurredAt: time, retrievedAt: time, verificationReceiptReference: 'synthetic-unit-receipt', confidence: 'PROVIDER_VERIFIED', supersedesEventId: null, kind: 'SIGNATURE', payload: { contractRef, documentSha256: otherHash, envelopeId: 'unit-envelope', status, assurance: 'PROVIDER_ATTESTED', signatoryReference: 'unit-signatory', signedAt: status === 'SIGNED' ? time : null, providerSignedDocumentDigests: [hash], auditProofReferences: [sourceReference] } });
  return { identity, workflowId, contract, policy, data, signature, contractRef, record };
}

function assess(f: ReturnType<typeof fixture>) {
  f.data.sourceAssessment = assessWebsiteSalesCommerceSources({ identity: f.identity, workflowId: f.workflowId, events: f.data.sourceEvents }, time);
}
function contractStatus(f: ReturnType<typeof fixture>) { assess(f); return commerceContractStatus(f.data, f.contract, Date.parse(time)); }
function subscriptionSource(f: ReturnType<typeof fixture>, subscription: WebsiteSalesCommerceRead['subscriptions'][number]) { assess(f); return commerceSubscriptionSource(f.data, subscription); }
function viewInvoice(f: ReturnType<typeof fixture>, extra: WebsiteSalesCommerceSourceEvent[] = []) { f.data.sourceEvents = [...f.data.invoices, ...extra]; assess(f); return commerceNewestInvoice(f.data); }

test('immutable draft status is presented as signed only with matching provider document, audit and assurance proof', () => {
  const f = fixture(); f.data.sourceEvents = [f.signature('SIGNED')];
  assert.equal(contractStatus(f), 'SIGNED');
  assert.equal(f.contract.payload.status, 'DRAFT');
  const immutableAudit = f.signature('SIGNED'); if (immutableAudit.kind !== 'SIGNATURE') throw Error(); delete immutableAudit.payload.auditProofReferences; immutableAudit.payload.providerAuditProofDigests = [hash]; f.data.sourceEvents = [immutableAudit]; assert.equal(contractStatus(f), 'SIGNED');
  const wrongDocument = f.signature('SIGNED'); assert.equal(wrongDocument.kind, 'SIGNATURE'); if (wrongDocument.kind !== 'SIGNATURE') throw Error();
  wrongDocument.payload.documentSha256 = hash; f.data.sourceEvents = [wrongDocument]; assert.equal(contractStatus(f), 'DRAFT');
  const wrongAuthority = f.signature('SIGNED'); wrongAuthority.source.system = 'ACCOUNTING'; f.data.sourceEvents = [wrongAuthority]; assert.equal(contractStatus(f), 'DRAFT');
  const manual = f.signature('SIGNED'); manual.confidence = 'OPERATOR_RECORDED'; f.data.sourceEvents = [manual]; assert.equal(contractStatus(f), 'DRAFT');
  f.data.sourceEvents = [f.signature('SIGNED')]; f.policy.payload.signatureAssurance = 'ADVANCED'; assert.equal(contractStatus(f), 'SIGNATURE_PENDING');
});

test('a newer voided or pending signature never falls back to the older signed event', () => {
  const f = fixture(); f.data.sourceEvents = [f.signature('SIGNED', 1), f.signature('VOIDED', 2)];
  assert.equal(contractStatus(f), 'VOIDED');
  f.data.sourceEvents.reverse(); assert.equal(contractStatus(f), 'VOIDED');
  f.data.sourceEvents = [f.signature('SIGNED', 1), f.signature('PENDING', 2)]; assert.equal(contractStatus(f), 'SIGNATURE_PENDING');
  const rebound = f.signature('SIGNED', 3); if (rebound.kind !== 'SIGNATURE') throw Error(); rebound.payload.documentSha256 = hash; f.data.sourceEvents = [f.signature('SIGNED', 1), rebound]; assert.equal(contractStatus(f), 'DRAFT');
  f.data.sourceEvents = []; f.contract.payload.status = 'SIGNED'; assert.equal(contractStatus(f), 'SIGNATURE_PENDING');
});

test('subscription presentation retains original start and uses the latest authoritative period instead of manual proposed status', () => {
  const f = fixture(), terms = { contractRef: f.contractRef, planKey: 'MANAGED' as const, originalServiceStartAt: '2025-10-01T00:00:00.000Z', periodStartAt: '2026-10-01T00:00:00.000Z', periodEndAt: '2027-10-01T00:00:00.000Z', renewalAt: null, cancellationEffectiveAt: null, currency: 'EUR' as const, termsDigest: hash, sourceReference, status: 'PENDING_SOURCE' as const, canonicalSourceEventId: null };
  const subscription: WebsiteSalesCommerceRead['subscriptions'][number] = { ...f.record, id: randomUUID(), version: 1, digest: hash, payload: terms };
  const base = f.signature('PENDING');
  const active = websiteSalesCommerceSourceEventSchema.parse({ ...base, kind: 'SUBSCRIPTION', source: { ...base.source, system: 'SERVICE_AUTHORITY', resourceType: 'subscription' }, payload: { ...terms, status: 'ACTIVE' } });
  f.data.sourceEvents = [active]; assert.equal(subscriptionSource(f, subscription)?.payload.status, 'ACTIVE');
  assert.equal(subscription.payload.status, 'PENDING_SOURCE'); assert.equal(subscriptionSource(f, subscription)?.payload.originalServiceStartAt, terms.originalServiceStartAt);
  const cancelled = websiteSalesCommerceSourceEventSchema.parse({ ...active, eventId: randomUUID(), source: { ...active.source, version: 2 }, payload: { ...terms, status: 'CANCELLED' } });
  f.data.sourceEvents.push(cancelled); assert.equal(subscriptionSource(f, subscription)?.payload.status, 'CANCELLED');
  const reset = websiteSalesCommerceSourceEventSchema.parse({ ...cancelled, eventId: randomUUID(), source: { ...cancelled.source, version: 3 }, payload: { ...terms, originalServiceStartAt: time, status: 'ACTIVE' } });
  f.data.sourceEvents = [active, cancelled, reset]; assert.equal(subscriptionSource(f, subscription), null);
});

test('the invoice overview displays a later void without choosing the old issued version', () => {
  const f = fixture(), base = f.signature('PENDING'), invoiceId = randomUUID();
  const invoice = (status: 'ISSUED' | 'VOIDED', version: number): WebsiteSalesCommerceSourceEvent => websiteSalesCommerceSourceEventSchema.parse({ ...base, eventId: randomUUID(), kind: 'INVOICE', source: { ...base.source, system: 'ACCOUNTING', resourceType: 'invoice', resourceId: invoiceId, version }, payload: { invoiceRequestId: randomUUID(), contractRef: f.contractRef, financial: f.contract.payload.financial, installments: [{ installmentId: randomUUID(), label: 'Balance', amountMinor: 10000, dueAt: time, kind: 'BALANCE' }], status, invoiceNumber: 'UNIT-ONLY-1' } });
  f.data.invoices = [invoice('ISSUED', 1), invoice('VOIDED', 2)];
  assert.equal(viewInvoice(f)?.payload.status, 'VOIDED');
  f.data.invoices.reverse(); assert.equal(viewInvoice(f)?.payload.status, 'VOIDED');
});

test('server-assessed reversals remove positive invoice and signature presentation without browser crypto rules', () => {
  const f = fixture(), signed = f.signature('SIGNED');
  const reversal = (target: WebsiteSalesCommerceSourceEvent) => websiteSalesCommerceSourceEventSchema.parse({ ...target, eventId: randomUUID(), kind: 'REVERSAL',
    source: { ...target.source, resourceType: 'reversal', resourceId: randomUUID() }, payload: { reversesEventId: target.eventId, reversedEventDigest: commerceSourceFactDigest(target), reason: 'Synthetic source reversal' } });
  f.data.sourceEvents = [signed, reversal(signed)]; assert.equal(contractStatus(f), 'UNKNOWN');
  assert(f.data.sourceAssessment.invalidatedEventIds.includes(signed.eventId));
  const issued = websiteSalesCommerceSourceEventSchema.parse({ ...signed, eventId: randomUUID(), kind: 'INVOICE', source: { ...signed.source, system: 'ACCOUNTING', resourceType: 'invoice' }, payload: { invoiceRequestId: randomUUID(), contractRef: f.contractRef, financial: f.contract.payload.financial, installments: [{ installmentId: randomUUID(), label: 'Balance', amountMinor: 10000, dueAt: time, kind: 'BALANCE' }], status: 'ISSUED', invoiceNumber: 'SYNTHETIC-REVERSED' } });
  f.data.invoices = [issued]; assert.equal(viewInvoice(f, [reversal(issued)]), null);
});

test('an archived or unavailable signature source is not shown as legally void or as a current signature', () => {
  const f = fixture(), archived = f.signature('SIGNED', 2); if (archived.kind !== 'SIGNATURE') throw Error();
  archived.payload.providerArchivedAt = time; f.data.sourceEvents = [f.signature('SIGNED', 1), archived];
  assert.equal(contractStatus(f), 'SOURCE_UNAVAILABLE');
  archived.payload.status = 'SOURCE_UNAVAILABLE'; assert.equal(contractStatus(f), 'SOURCE_UNAVAILABLE');
  f.data.sourceEvents = [f.signature('SIGNED')]; assess(f);
  f.data.sourceAssessment = { ...f.data.sourceAssessment, status: 'NEEDS_RECONCILIATION', complete: false, reasons: ['COMMERCE_FINANCIAL_HISTORY_LIMITED'] };
  assert.equal(commerceContractStatus(f.data, f.contract, Date.parse(time)), 'UNKNOWN');
});
