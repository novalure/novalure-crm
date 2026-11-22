import 'server-only';
import { createHash } from 'node:crypto';
import {
  claimWebsiteSalesCommerceJob, dispatchWebsiteSalesCommerceJob, listDueWebsiteSalesCommerceJobs, readWebsiteSalesCommerceJob,
  readWebsiteSalesCommerceSource,
  markWebsiteSalesCommerceJobChecked,
  verifyWebsiteSalesCommerceSource, type FrozenCommerceJob, type WebsiteSalesCommerceExecutor,
} from './db/website-sales-commerce-outbox';
import { ingestVerifiedWebsiteSalesCommerceSource } from './db/website-sales-commerce-sources';
import { commerceDigest } from './website-sales-commerce-domain';
import { websiteSalesCommerceSourceEventSchema, type WebsiteSalesCommerceSourceEvent } from './website-sales-commerce-types';
import { commerceMailPayloadSchema, sendCommerceMail, retrieveCommerceMail, type CommerceMailConfiguration } from './website-sales-commerce-provider';
import { requestCommerceSignature, retrieveCommerceSignature, type CommerceSignatureConfiguration } from './website-sales-commerce-signature';
import type { VerifiedResendEvent } from './resend-webhooks';

export type CommerceWorkerOptions = {
  executor: WebsiteSalesCommerceExecutor; sourceExecutor: WebsiteSalesCommerceExecutor;
  mail: CommerceMailConfiguration; signature: CommerceSignatureConfiguration;
  accounts: { resend: string; docuseal: string }; now?: () => number;
};
function stableId(value: unknown): string {
  const bytes = createHash('sha256').update(JSON.stringify(value)).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 15) | 64; bytes[8] = (bytes[8]! & 63) | 128;
  const hex = bytes.toString('hex'); return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
async function persistObservation(job: FrozenCommerceJob, options: CommerceWorkerOptions, kind: 'mail' | 'signature') {
  if (kind === 'mail') {
    if (!job.providerReference || !options.accounts.resend) return { status: 'UNKNOWN' as const };
    const payload = commerceMailPayloadSchema.parse(job.payload), observed = await retrieveCommerceMail(job.providerReference, options.mail);
    if (!observed || observed.recipientEmail.toLowerCase() !== payload.recipientEmail.toLowerCase() || observed.subject !== payload.subject
      || observed.textSha256 !== payload.documentSha256) return { status: 'UNKNOWN' as const };
    const now = options.now?.() ?? Date.now(), eventId = stableId([job.id, observed.receiptDigest]);
    const existing = await readWebsiteSalesCommerceSource(options.sourceExecutor, eventId);
    if (existing) return { status: observed.status, sourceEventId: existing.eventId };
    const payloadData = { outboxId: job.id, documentKind: job.kind === 'OFFER_SEND' ? 'OFFER' as const : 'CONTRACT' as const,
      documentRef: payload.documentRef, documentSha256: payload.documentSha256, recipientDigest: payload.recipientDigest,
      providerMessageId: observed.providerReference, status: observed.status };
    const event: WebsiteSalesCommerceSourceEvent = websiteSalesCommerceSourceEventSchema.parse({
      contractVersion: 'website-sales-commerce-source-v1', eventId, identity: job.identity, workflowId: job.workflowId,
      source: { system: 'DELIVERY_PROVIDER', provider: 'RESEND', accountReference: options.accounts.resend, resourceType: 'EMAIL_OBSERVATION',
        resourceId: observed.providerReference, version: now, digest: observed.receiptDigest },
      // Resend's retrieval response supplies state, not its original delivery timestamp: this is an explicitly named host observation.
      occurredAt: new Date(now).toISOString(), retrievedAt: new Date(now).toISOString(),
      verificationReceiptReference: `resend:read:${observed.providerReference}:${observed.receiptDigest}`, confidence: 'PROVIDER_VERIFIED',
      supersedesEventId: null, kind: 'PROVIDER_DELIVERY', payload: payloadData,
    });
    const proof = await verifyWebsiteSalesCommerceSource(event, async () => ({ event, jobId: job.id }));
    const recorded = await ingestVerifiedWebsiteSalesCommerceSource(options.sourceExecutor, proof);
    return { status: observed.status, sourceEventId: recorded.sourceEventId };
  }
  if (!options.accounts.docuseal) return { status: 'UNKNOWN' as const };
  const observed = await retrieveCommerceSignature(job, job.providerReference, options.signature);
  if (!observed) return { status: 'UNKNOWN' as const };
  const now = options.now?.() ?? Date.now(), eventId = stableId([job.id, observed.receiptDigest]);
  const existing = await readWebsiteSalesCommerceSource(options.sourceExecutor, eventId);
  if (existing) return { status: observed.status, sourceEventId: existing.eventId };
  const payload = job.payload as { documentRef: unknown; documentSha256: string; recipientEmail: string };
  const event = websiteSalesCommerceSourceEventSchema.parse({
    contractVersion: 'website-sales-commerce-source-v1', eventId, identity: job.identity, workflowId: job.workflowId,
    source: { system: 'SIGNATURE_PROVIDER', provider: 'DOCUSEAL', accountReference: options.accounts.docuseal, resourceType: 'SIGNATURE_OBSERVATION',
      resourceId: observed.providerReference, version: observed.sourceVersion, digest: observed.receiptDigest },
    occurredAt: observed.occurredAt, retrievedAt: new Date(now).toISOString(),
    verificationReceiptReference: `docuseal:read:${observed.providerReference}:${observed.receiptDigest}`, confidence: 'PROVIDER_VERIFIED', supersedesEventId: null,
    kind: 'SIGNATURE', payload: { contractRef: payload.documentRef, documentSha256: payload.documentSha256, envelopeId: observed.providerReference,
      status: observed.status, assurance: observed.assurance, signatoryReference: `recipient:${commerceDigest(payload.recipientEmail.toLowerCase())}`,
      signedAt: observed.status === 'SIGNED' ? observed.occurredAt : null,
      ...(observed.providerArchivedAt ? { providerArchivedAt: observed.providerArchivedAt } : {}),
      ...(observed.signedDocumentDigests.length ? { providerSignedDocumentDigests: observed.signedDocumentDigests } : {}),
      ...(observed.auditProofDigests.length ? { providerAuditProofDigests: observed.auditProofDigests } : {}),
    },
  });
  const proof = await verifyWebsiteSalesCommerceSource(event, async () => ({ event, jobId: job.id }));
  const recorded = await ingestVerifiedWebsiteSalesCommerceSource(options.sourceExecutor, proof);
  return { status: observed.status, sourceEventId: recorded.sourceEventId };
}

/** Bounded actual executor: a committed claim precedes every POST; fresh locked dispatch fences revocation/consent.
 * UNKNOWN and expired leases only reconcile. Accounting requests are exposed to the authorized accounting connector, never fabricated as issued invoices.
 */
export async function runWebsiteSalesCommerceWorker(options: CommerceWorkerOptions, limit = 5) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 10) throw new Error('COMMERCE_WORKER_LIMIT_INVALID');
  const now = options.now ?? Date.now, started = now(), results: { jobId: string; status: string; code?: string }[] = []; let attempted = 0;
  for (const original of await listDueWebsiteSalesCommerceJobs(options.executor, 50)) {
    if (now() - started >= 35_000 || attempted >= limit) break;
    if (!['OFFER_SEND', 'CONTRACT_SEND', 'SIGNATURE_REQUEST'].includes(original.kind)) {
      results.push({ jobId: original.id, status: 'WAITING_SOURCE', code: original.kind === 'ACCOUNTING_INVOICE_REQUEST'
        ? 'COMMERCE_ACCOUNTING_CONNECTOR_REQUIRED' : 'COMMERCE_AUTHORITATIVE_SERVICE_SOURCE_REQUIRED' }); continue;
    }
    if (original.status === 'READY') {
      if (original.kind === 'SIGNATURE_REQUEST' ? !options.signature.apiKey.trim() || !options.signature.htmlCapabilityApproved || !options.accounts.docuseal.trim()
        : !options.mail.apiKey.trim() || !options.mail.from.trim() || !options.accounts.resend.trim()) {
        results.push({ jobId: original.id, status: 'WAITING_CONFIGURATION', code: 'COMMERCE_PROVIDER_NOT_CONFIGURED' }); continue;
      }
      if (original.kind === 'SIGNATURE_REQUEST' && original.payload.requiredAssurance !== 'PROVIDER_ATTESTED') {
        results.push({ jobId: original.id, status: 'WAITING_CONFIGURATION', code: 'COMMERCE_SIGNATURE_ASSURANCE_UNSUPPORTED' }); continue;
      }
      attempted++;
      const claimed = await claimWebsiteSalesCommerceJob(options.executor, original.id);
      if (!claimed) { results.push({ jobId: original.id, status: 'RECONCILIATION_REQUIRED' }); break; }
      if (!claimed.leaseToken || !claimed.firstAttemptAt) throw new Error('COMMERCE_WORKER_CLAIM_INVALID');
      const dispatched = await dispatchWebsiteSalesCommerceJob(options.executor,
        { jobId: claimed.id, leaseToken: claimed.leaseToken, payloadDigest: claimed.payloadDigest }, async frozen => {
          if (frozen.kind === 'SIGNATURE_REQUEST') return requestCommerceSignature(frozen, options.signature);
          return sendCommerceMail({ id: frozen.id, kind: frozen.kind as 'OFFER_SEND' | 'CONTRACT_SEND', payload: frozen.payload,
            idempotencyKey: `sales-commerce:${frozen.id}`, firstAttemptAt: frozen.firstAttemptAt! }, options.mail);
        });
      results.push({ jobId: claimed.id, status: dispatched.status });
      if (dispatched.status === 'UNKNOWN') break;
    } else {
      attempted++;
      if (original.status === 'CLAIMED') await claimWebsiteSalesCommerceJob(options.executor, original.id); // An expired lease becomes UNKNOWN; a live lease stays owned.
      const fresh = await readWebsiteSalesCommerceJob(options.sourceExecutor, original.id);
      if (fresh.status === 'CLAIMED') { results.push({ jobId: fresh.id, status: 'BUSY' }); continue; }
      let result;
      try { result = await persistObservation(fresh, options, fresh.kind === 'SIGNATURE_REQUEST' ? 'signature' : 'mail'); }
      finally { await markWebsiteSalesCommerceJobChecked(options.sourceExecutor, fresh.id); }
      results.push({ jobId: fresh.id, status: result.status });
      if (result.status === 'UNKNOWN') break;
    }
  }
  return { results, externalEffectsOnlyFromClaimedJobs: true as const };
}

export async function reconcileWebsiteSalesCommerceProviderJob(options: CommerceWorkerOptions, jobId: string) {
  const job = await readWebsiteSalesCommerceJob(options.sourceExecutor, jobId);
  if (!['OFFER_SEND', 'CONTRACT_SEND', 'SIGNATURE_REQUEST'].includes(job.kind)) throw new Error('COMMERCE_PROVIDER_JOB_DENIED');
  try { return await persistObservation(job, options, job.kind === 'SIGNATURE_REQUEST' ? 'signature' : 'mail'); }
  finally { await markWebsiteSalesCommerceJobChecked(options.sourceExecutor, job.id); }
}

/** Only a caller that already verified the original Svix bytes may invoke this host composition.
 * A signed tag is only a lookup hint: an authenticated provider GET must also match the frozen content.
 * This recovers lost send acknowledgements without another POST, including late bounce/complaint facts.
 */
export async function recordCommerceResendEvent(options: CommerceWorkerOptions, observation: VerifiedResendEvent) {
  if (observation.reference?.kind !== 'sales_commerce' || !options.accounts.resend) throw new Error('COMMERCE_DELIVERY_REFERENCE_REQUIRED');
  const job = await readWebsiteSalesCommerceJob(options.sourceExecutor, observation.reference.id);
  if (!['OFFER_SEND', 'CONTRACT_SEND'].includes(job.kind) || !job.firstAttemptAt
    || !['CLAIMED', 'UNKNOWN', 'ACCEPTED'].includes(job.status)
    || Date.parse(observation.occurredAt) < Date.parse(job.firstAttemptAt) - 5000
    || job.providerReference && job.providerReference !== observation.emailId) throw new Error('COMMERCE_DELIVERY_JOB_MISMATCH');
  const payload = commerceMailPayloadSchema.parse(job.payload), actual = await retrieveCommerceMail(observation.emailId, options.mail);
  if (!actual || actual.recipientEmail.toLowerCase() !== payload.recipientEmail.toLowerCase()
    || observation.to !== payload.recipientEmail.toLowerCase() || actual.subject !== payload.subject
    || actual.textSha256 !== payload.documentSha256) throw new Error('COMMERCE_DELIVERY_CONTENT_MISMATCH');
  const status = ({ 'email.sent': 'ACCEPTED', 'email.delivered': 'DELIVERED', 'email.delivery_delayed': 'ACCEPTED',
    'email.bounced': 'BOUNCED', 'email.complained': 'COMPLAINED', 'email.failed': 'FAILED', 'email.suppressed': 'FAILED' } as const)[observation.type];
  const eventId = stableId([job.id, 'resend-svix', observation.eventId]), now = options.now?.() ?? Date.now();
  const digest = commerceDigest({ eventId: observation.eventId, rawDigest: observation.digest, messageId: actual.providerReference,
    documentSha256: actual.textSha256, status, occurredAt: observation.occurredAt });
  const existing = await readWebsiteSalesCommerceSource(options.sourceExecutor, eventId);
  if (existing) {
    if (existing.source.digest !== digest) throw new Error('COMMERCE_DELIVERY_EVENT_CONFLICT');
    return { status: 'REPLAYED' as const, sourceEventId: existing.eventId };
  }
  const event = websiteSalesCommerceSourceEventSchema.parse({ contractVersion: 'website-sales-commerce-source-v1', eventId,
    identity: job.identity, workflowId: job.workflowId,
    source: { system: 'DELIVERY_PROVIDER', provider: 'RESEND', accountReference: options.accounts.resend,
      resourceType: 'EMAIL_PROVIDER_EVENT', resourceId: observation.emailId, version: Date.parse(observation.occurredAt), digest },
    occurredAt: observation.occurredAt, retrievedAt: new Date(now).toISOString(), confidence: 'PROVIDER_VERIFIED',
    verificationReceiptReference: `resend:svix:${observation.eventId}:${observation.digest}`, supersedesEventId: null,
    kind: 'PROVIDER_DELIVERY', payload: { outboxId: job.id, documentKind: job.kind === 'OFFER_SEND' ? 'OFFER' : 'CONTRACT',
      documentRef: payload.documentRef, documentSha256: payload.documentSha256, recipientDigest: payload.recipientDigest,
      providerMessageId: observation.emailId, status } });
  const proof = await verifyWebsiteSalesCommerceSource(event, async () => ({ event, jobId: job.id }));
  const result = await ingestVerifiedWebsiteSalesCommerceSource(options.sourceExecutor, proof);
  return { status: 'RECORDED' as const, sourceEventId: result.sourceEventId };
}
