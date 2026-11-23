import type { WebsiteSalesCommerceRead, WebsiteSalesCommerceSourceEvent } from './website-sales-commerce-types';

type Contract = WebsiteSalesCommerceRead['contracts'][number];
type Subscription = WebsiteSalesCommerceRead['subscriptions'][number];
type Source = WebsiteSalesCommerceSourceEvent;
const refKey = (value: { id: string; version: number; digest: string }) => `${value.id}:${value.version}:${value.digest}`;
/** The server resolves crypto-bound supersession and reversals; the browser only presents that assessment. */
function currentEvents(data: WebsiteSalesCommerceRead) {
  if (data.sourceAssessment.status !== 'READY' || !data.sourceAssessment.complete) return [];
  const active = new Set(data.sourceAssessment.activeEventIds);
  return data.sourceEvents.filter(event => active.has(event.eventId));
}

export function commerceContractStatus(data: WebsiteSalesCommerceRead, contract: Contract, now: number): string {
  if (data.sourceAssessment.status !== 'READY' || !data.sourceAssessment.complete) return 'UNKNOWN';
  const sources = currentEvents(data).filter((event): event is Extract<Source, { kind: 'SIGNATURE' }> => event.kind === 'SIGNATURE' && event.source.system === 'SIGNATURE_PROVIDER' && event.confidence === 'PROVIDER_VERIFIED');
  const latest = sources.filter(event => refKey(event.payload.contractRef) === refKey(contract) && event.payload.documentSha256 === contract.payload.documentSha256);
  if (latest.some(event => event.payload.status === 'SOURCE_UNAVAILABLE' || event.payload.providerArchivedAt)) return 'SOURCE_UNAVAILABLE';
  const negative = latest.find(event => ['VOIDED', 'DECLINED', 'EXPIRED'].includes(event.payload.status));
  if (negative) return negative.payload.status;
  const newestTime = latest.length ? Math.max(...latest.map(event => Date.parse(event.occurredAt))) : 0;
  if (new Set(latest.filter(event => Date.parse(event.occurredAt) === newestTime).map(event => event.payload.status)).size > 1) return 'UNKNOWN';
  const signature = latest.toSorted((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt))[0];
  if (!signature) {
    const invalid = new Set(data.sourceAssessment.invalidatedEventIds);
    if (data.sourceEvents.some(event => invalid.has(event.eventId) && event.kind === 'SIGNATURE' && refKey(event.payload.contractRef) === refKey(contract))) return 'UNKNOWN';
    return contract.payload.status === 'SIGNED' ? 'SIGNATURE_PENDING' : contract.payload.status;
  }
  if (signature.payload.status !== 'SIGNED') return signature.payload.status === 'PENDING' ? 'SIGNATURE_PENDING' : signature.payload.status;
  const policy = [...(data.policies ?? []), ...(data.policy ? [data.policy] : [])].find(row => refKey(row) === refKey(contract.payload.policyRef));
  const assurance = { EMAIL_ACCESS: 0, PROVIDER_ATTESTED: 1, ADVANCED: 2, QUALIFIED: 3 };
  if (!policy || assurance[signature.payload.assurance] < assurance[policy.payload.signatureAssurance] ||
    !signature.payload.providerSignedDocumentDigests?.length || !(signature.payload.providerAuditProofDigests?.length || signature.payload.auditProofReferences?.some(proof => Date.parse(proof.observedAt) <= now && Date.parse(proof.validUntil) > now)) || !signature.payload.signedAt || Date.parse(signature.payload.signedAt) > now || Date.parse(signature.payload.signedAt) < Date.parse(contract.createdAt)) return 'SIGNATURE_PENDING';
  return 'SIGNED';
}

export function commerceSubscriptionSource(data: WebsiteSalesCommerceRead, subscription: Subscription) {
  const terms = subscription.payload;
  const sources = currentEvents(data).filter((event): event is Extract<Source, { kind: 'SUBSCRIPTION' }> => event.kind === 'SUBSCRIPTION' && event.confidence === 'PROVIDER_VERIFIED' && ['SERVICE_AUTHORITY', 'ACCOUNTING'].includes(event.source.system));
  const latest = sources.filter(event => refKey(event.payload.contractRef) === refKey(terms.contractRef) && event.payload.termsDigest === terms.termsDigest &&
    event.payload.planKey === terms.planKey && event.payload.originalServiceStartAt === terms.originalServiceStartAt && event.payload.currency === terms.currency);
  if (latest.length > 1 && new Set(latest.map(event => JSON.stringify([event.payload.status, event.payload.periodStartAt, event.payload.periodEndAt, event.payload.cancellationEffectiveAt]))).size > 1) return null;
  return latest.toSorted((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt))[0] ?? null;
}

export function commerceNewestInvoice(data: WebsiteSalesCommerceRead) {
  return currentEvents(data).filter((event): event is Extract<Source, { kind: 'INVOICE' }> => event.kind === 'INVOICE')
    .toSorted((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt))[0] ?? null;
}

/** A zero balance is meaningful only after complete source reconciliation, and covers issued invoices only. */
export function commercePaymentSummary(data: WebsiteSalesCommerceRead): 'UNKNOWN' | 'NO_ISSUED_INVOICES' | 'OUTSTANDING' | 'BALANCED' {
  const assessment = data.financialAssessment;
  if (!assessment || assessment.status !== 'READY' || !assessment.value?.complete) return 'UNKNOWN';
  if (!assessment.value.invoices.length) return 'NO_ISSUED_INVOICES';
  return assessment.value.invoices.every(invoice => invoice.outstandingMinor === 0) ? 'BALANCED' : 'OUTSTANDING';
}
