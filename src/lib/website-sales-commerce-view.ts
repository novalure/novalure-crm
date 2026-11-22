import type { WebsiteSalesCommerceRead, WebsiteSalesCommerceSourceEvent } from './website-sales-commerce-types';

type Contract = WebsiteSalesCommerceRead['contracts'][number];
type Subscription = WebsiteSalesCommerceRead['subscriptions'][number];
type Source = WebsiteSalesCommerceSourceEvent;
const refKey = (value: { id: string; version: number; digest: string }) => `${value.id}:${value.version}:${value.digest}`;
const sourceKey = (value: Source) => JSON.stringify([value.source.system, value.source.provider, value.source.accountReference, value.source.resourceType, value.source.resourceId]);

/** Presentation only. Server admission still independently checks every command against fresh canonical sources. */
function newestSources<T extends Source>(rows: T[]): T[] {
  const latest = new Map<string, T>();
  for (const row of rows) {
    const key = sourceKey(row), old = latest.get(key);
    if (!old || row.source.version > old.source.version) latest.set(key, row);
  }
  return [...latest.values()];
}

export function commerceContractStatus(data: WebsiteSalesCommerceRead, contract: Contract, now: number): string {
  const sources = data.sourceEvents.filter((event): event is Extract<Source, { kind: 'SIGNATURE' }> => event.kind === 'SIGNATURE' && event.source.system === 'SIGNATURE_PROVIDER' && event.confidence === 'PROVIDER_VERIFIED');
  const latest = newestSources(sources).filter(event => refKey(event.payload.contractRef) === refKey(contract) && event.payload.documentSha256 === contract.payload.documentSha256);
  if (latest.length > 1 && new Set(latest.map(event => event.payload.status)).size > 1) return 'UNKNOWN';
  const signature = latest.toSorted((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt))[0];
  if (!signature) return contract.payload.status === 'SIGNED' ? 'SIGNATURE_PENDING' : contract.payload.status;
  if (signature.payload.status !== 'SIGNED') return signature.payload.status === 'PENDING' ? 'SIGNATURE_PENDING' : signature.payload.status;
  const policy = [...(data.policies ?? []), ...(data.policy ? [data.policy] : [])].find(row => refKey(row) === refKey(contract.payload.policyRef));
  const assurance = { EMAIL_ACCESS: 0, PROVIDER_ATTESTED: 1, ADVANCED: 2, QUALIFIED: 3 };
  if (!policy || assurance[signature.payload.assurance] < assurance[policy.payload.signatureAssurance] ||
    !signature.payload.providerSignedDocumentDigests?.length || !(signature.payload.providerAuditProofDigests?.length || signature.payload.auditProofReferences?.some(proof => Date.parse(proof.observedAt) <= now && Date.parse(proof.validUntil) > now)) || !signature.payload.signedAt || Date.parse(signature.payload.signedAt) > now || Date.parse(signature.payload.signedAt) < Date.parse(contract.createdAt)) return 'SIGNATURE_PENDING';
  return 'SIGNED';
}

export function commerceSubscriptionSource(data: WebsiteSalesCommerceRead, subscription: Subscription) {
  const terms = subscription.payload;
  const sources = data.sourceEvents.filter((event): event is Extract<Source, { kind: 'SUBSCRIPTION' }> => event.kind === 'SUBSCRIPTION' && event.confidence === 'PROVIDER_VERIFIED' && ['SERVICE_AUTHORITY', 'ACCOUNTING'].includes(event.source.system));
  const latest = newestSources(sources).filter(event => refKey(event.payload.contractRef) === refKey(terms.contractRef) && event.payload.termsDigest === terms.termsDigest &&
    event.payload.planKey === terms.planKey && event.payload.originalServiceStartAt === terms.originalServiceStartAt && event.payload.currency === terms.currency);
  if (latest.length > 1 && new Set(latest.map(event => JSON.stringify([event.payload.status, event.payload.periodStartAt, event.payload.periodEndAt, event.payload.cancellationEffectiveAt]))).size > 1) return null;
  return latest.toSorted((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt))[0] ?? null;
}

export function commerceNewestInvoice(data: WebsiteSalesCommerceRead) {
  return newestSources(data.invoices.filter((event): event is Extract<Source, { kind: 'INVOICE' }> => event.kind === 'INVOICE'))
    .toSorted((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt))[0] ?? null;
}
