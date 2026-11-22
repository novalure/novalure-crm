import 'server-only';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { commerceMailPayloadSchema, readCommerceProviderJson, type CommerceProviderOutcome } from './website-sales-commerce-provider';

const sha256 = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const id = z.number().int().positive().safe();
const signaturePayload = commerceMailPayloadSchema.extend({ signatureMode: z.literal('CANONICAL_HTML'),
  requiredAssurance: z.enum(['PROVIDER_ATTESTED', 'ADVANCED', 'QUALIFIED']), acceptUntil: z.iso.datetime({ offset: true }) });
export type CommerceSignatureJob = { id: string; payload: unknown };
export type CommerceSignatureConfiguration = { apiKey: string; htmlCapabilityApproved: boolean; transport?: typeof fetch };
const api = 'https://api.docuseal.com';
const assetHosts = new Set(['docuseal.com', 'www.docuseal.com']);
const submitterSchema = z.object({ id, submission_id: id.optional(), email: z.email(), external_id: z.string(),
  metadata: z.object({ commerce_job_id: z.uuid(), document_sha256: z.hash('sha256'), html_sha256: z.hash('sha256') }),
  status: z.string(), role: z.string(), completed_at: z.string().nullable().optional(),
});
const submissionSchema = z.object({ id, status: z.string(), submitters: z.array(submitterSchema).length(1),
  updated_at: z.string().optional(), completed_at: z.string().nullable().optional(),
  archived_at: z.string().nullable().optional(),
  expire_at: z.string().nullable().optional(),
  audit_log_url: z.string().nullable().optional(), documents: z.array(z.object({ name: z.string(), url: z.string() })).max(4).optional(),
});

function escapeText(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;').replaceAll('{', '&#123;').replaceAll('}', '&#125;');
}
/** The whole approved body is static HTML text. Only the customer's signature field is editable.
 * No mutable remote template, remote images, script, payment field or auto-sign option is accepted.
 * https://www.docuseal.com/guides/create-pdf-document-fillable-form-with-html-api
 */
export function commerceSignatureHtml(raw: unknown): { html: string; htmlSha256: string } {
  const payload = signaturePayload.parse(raw);
  if (sha256(payload.text) !== payload.documentSha256) throw new Error('COMMERCE_SIGNATURE_DOCUMENT_CHANGED');
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeText(payload.subject)}</title><style>body{font:11pt Helvetica,Arial,sans-serif;line-height:1.5;margin:24pt;color:#111}h1{font-size:16pt}article{white-space:pre-wrap;overflow-wrap:anywhere}.signature{break-inside:avoid;margin-top:28pt}</style></head><body><h1>${escapeText(payload.subject)}</h1><article>${escapeText(payload.text)}</article><section class="signature"><p>Customer signature</p><signature-field name="Customer signature" role="Customer" required="true" style="width:240px;height:100px;display:inline-block"></signature-field></section></body></html>`;
  return { html, htmlSha256: sha256(html) };
}
function matches(raw: z.infer<typeof submissionSchema>, job: CommerceSignatureJob): boolean {
  const payload = signaturePayload.parse(job.payload), rendered = commerceSignatureHtml(payload), party = raw.submitters[0]!;
  return party.email.toLowerCase() === payload.recipientEmail.toLowerCase() && party.external_id === job.id && party.role === 'Customer'
    && party.metadata.commerce_job_id === job.id && party.metadata.document_sha256 === payload.documentSha256
    && party.metadata.html_sha256 === rendered.htmlSha256 && Boolean(raw.expire_at)
    && Date.parse(raw.expire_at!) === Date.parse(payload.acceptUntil);
}

/** One first attempt only. A lost result is reconciled by reads; this provider's create API has no assumed idempotency guarantee. */
export async function requestCommerceSignature(job: CommerceSignatureJob, configuration: CommerceSignatureConfiguration): Promise<CommerceProviderOutcome> {
  z.uuid().parse(job.id); const payload = signaturePayload.parse(job.payload), rendered = commerceSignatureHtml(payload);
  if (!configuration.apiKey.trim() || !configuration.htmlCapabilityApproved)
    return { outcome: 'REJECTED', errorCode: 'COMMERCE_SIGNATURE_PROVIDER_NOT_CONFIGURED' };
  if (payload.requiredAssurance !== 'PROVIDER_ATTESTED')
    return { outcome: 'REJECTED', errorCode: 'COMMERCE_SIGNATURE_ASSURANCE_UNSUPPORTED' };
  if (Date.parse(payload.acceptUntil) <= Date.now()) return { outcome: 'REJECTED', errorCode: 'COMMERCE_SIGNATURE_ACCEPTANCE_EXPIRED' };
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await (configuration.transport ?? fetch)(api + '/submissions/html', { method: 'POST', redirect: 'error', signal: controller.signal,
      headers: { 'X-Auth-Token': configuration.apiKey, 'Content-Type': 'application/json' }, body: JSON.stringify({
        name: payload.subject, send_email: true, send_sms: false, expire_at: payload.acceptUntil,
        documents: [{ name: `contract-${payload.documentRef.id}-v${payload.documentRef.version}`, html: rendered.html, size: 'A4' }],
        submitters: [{ role: 'Customer', email: payload.recipientEmail, external_id: job.id, require_email_2fa: true,
          metadata: { commerce_job_id: job.id, document_sha256: payload.documentSha256, html_sha256: rendered.htmlSha256 } }],
      }),
    });
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      return response.status >= 500 || [408, 409].includes(response.status)
        ? { outcome: 'UNKNOWN', errorCode: 'COMMERCE_SIGNATURE_ACCEPTANCE_UNKNOWN' }
        : { outcome: 'REJECTED', errorCode: 'COMMERCE_SIGNATURE_PROVIDER_REJECTED' };
    }
    const data = submissionSchema.parse(await readCommerceProviderJson(response, controller.signal));
    if (!matches(data, job)) return { outcome: 'UNKNOWN', errorCode: 'COMMERCE_SIGNATURE_RESPONSE_BINDING_UNKNOWN' };
    return { outcome: 'ACCEPTED', providerReference: String(data.id), receiptDigest: sha256(JSON.stringify(data)) };
  } catch { return { outcome: 'UNKNOWN', errorCode: 'COMMERCE_SIGNATURE_ACCEPTANCE_UNKNOWN' }; }
  finally { clearTimeout(timer); }
}

async function pdfDigest(value: string, configuration: CommerceSignatureConfiguration, signal: AbortSignal): Promise<string> {
  const url = new URL(value);
  if (url.protocol !== 'https:' || !assetHosts.has(url.hostname) || url.username || url.password || url.port || !url.pathname.startsWith('/file/'))
    throw new Error('COMMERCE_SIGNATURE_ASSET_ORIGIN_DENIED');
  // Provider file URLs carry their own bounded access capability. API credentials are never forwarded to a file host.
  const response = await (configuration.transport ?? fetch)(url, { method: 'GET', redirect: 'error', signal });
  if (!response.ok) { void response.body?.cancel().catch(() => undefined); throw new Error('COMMERCE_SIGNATURE_ASSET_UNAVAILABLE'); }
  const reader = response.body?.getReader(); if (!reader) throw new Error('COMMERCE_SIGNATURE_ASSET_EMPTY');
  const hash = createHash('sha256'); let size = 0; let prefix = Buffer.alloc(0);
  const abort = () => { void reader.cancel().catch(() => undefined); }; signal.addEventListener('abort', abort, { once: true });
  try {
    for (;;) {
      if (signal.aborted) throw new Error('COMMERCE_SIGNATURE_DEADLINE');
      const next = await reader.read(); if (next.done) break; size += next.value.byteLength;
      if (size > 8_388_608) throw new Error('COMMERCE_SIGNATURE_ASSET_TOO_LARGE');
      if (prefix.length < 5) prefix = Buffer.concat([prefix, next.value]).subarray(0, 5);
      hash.update(next.value);
    }
    if (signal.aborted || size < 5 || prefix.toString('ascii') !== '%PDF-') throw new Error('COMMERCE_SIGNATURE_ASSET_INVALID');
    return hash.digest('hex');
  } finally { signal.removeEventListener('abort', abort); void reader.cancel().catch(() => undefined); reader.releaseLock(); }
}

export type CommerceSignatureObservation = {
  providerReference: string; status: 'PENDING' | 'SIGNED' | 'DECLINED' | 'EXPIRED' | 'SOURCE_UNAVAILABLE'; providerArchivedAt: string | null;
  occurredAt: string; sourceVersion: number; receiptDigest: string; assurance: 'PROVIDER_ATTESTED';
  signedDocumentDigests: string[]; auditProofDigests: string[];
};
async function observeSubmission(raw: unknown, job: CommerceSignatureJob, configuration: CommerceSignatureConfiguration, signal: AbortSignal): Promise<CommerceSignatureObservation | null> {
  const data = submissionSchema.parse(raw); if (!matches(data, job)) return null;
  const party = data.submitters[0]!, archivedAt = data.archived_at ?? null;
  const status = archivedAt ? 'SOURCE_UNAVAILABLE' : data.status === 'completed' && party.status === 'completed' ? 'SIGNED'
    : data.status === 'declined' ? 'DECLINED' : data.status === 'expired' ? 'EXPIRED'
      : ['pending', 'sent', 'awaiting', 'opened'].includes(data.status) ? 'PENDING' : null;
  if (!status) return null;
  const time = status === 'SOURCE_UNAVAILABLE' ? archivedAt : status === 'SIGNED' ? data.completed_at ?? party.completed_at : data.updated_at;
  if (!time || !Number.isFinite(Date.parse(time)) || Date.parse(time) > Date.now() + 300_000) return null;
  const signedDocumentDigests: string[] = [], auditProofDigests: string[] = [];
  if (status === 'SIGNED') {
    if (!data.documents?.length || !data.audit_log_url) return null;
    for (const document of data.documents) signedDocumentDigests.push(await pdfDigest(document.url, configuration, signal));
    auditProofDigests.push(await pdfDigest(data.audit_log_url, configuration, signal));
  }
  const sourceVersion = Math.max(Date.parse(data.updated_at ?? time), archivedAt ? Date.parse(archivedAt) : 0);
  if (!Number.isSafeInteger(sourceVersion) || sourceVersion <= 0) return null;
  // File URLs can rotate; the fact binds fetched document bytes and actor/metadata instead of a temporary URL.
  const semantic = { id: data.id, status, archivedAt, updatedAt: sourceVersion, completedAt: data.completed_at ?? party.completed_at ?? null,
    party: { id: party.id, email: party.email, externalId: party.external_id, role: party.role, metadata: party.metadata }, signedDocumentDigests, auditProofDigests };
  return { providerReference: String(data.id), status, providerArchivedAt: archivedAt, occurredAt: new Date(time).toISOString(), sourceVersion, assurance: 'PROVIDER_ATTESTED',
    receiptDigest: sha256(JSON.stringify(semantic)), signedDocumentDigests, auditProofDigests };
}

/** Reads only; unsigned webhook bodies never become signature evidence. */
export async function retrieveCommerceSignature(job: CommerceSignatureJob, providerReference: string | null, configuration: CommerceSignatureConfiguration): Promise<CommerceSignatureObservation | null> {
  if (!configuration.apiKey.trim() || !configuration.htmlCapabilityApproved || signaturePayload.parse(job.payload).requiredAssurance !== 'PROVIDER_ATTESTED') return null;
  if (providerReference !== null && !/^[1-9][0-9]{0,14}$/.test(providerReference)) return null;
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const endpoint = providerReference ? `/submissions/${providerReference}` : `/submissions?limit=100&q=${encodeURIComponent(signaturePayload.parse(job.payload).recipientEmail)}`;
    const response = await (configuration.transport ?? fetch)(api + endpoint, { method: 'GET', redirect: 'error', signal: controller.signal,
      headers: { 'X-Auth-Token': configuration.apiKey } });
    if (!response.ok) { void response.body?.cancel().catch(() => undefined); return null; }
    const raw = await readCommerceProviderJson(response, controller.signal, 1_000_000);
    if (providerReference) {
      const data = submissionSchema.parse(raw); if (String(data.id) !== providerReference) return null;
      return await observeSubmission(data, job, configuration, controller.signal);
    }
    const page = z.object({ data: z.array(z.unknown()).max(100) }).parse(raw), candidates = page.data.flatMap(row => {
      const parsed = submissionSchema.safeParse(row); return parsed.success && matches(parsed.data, job) ? [parsed.data] : [];
    });
    // No result is not proof of non-execution; multiple matches are also unresolved. Neither condition permits another POST.
    if (candidates.length !== 1) return null;
    const selected = candidates[0]!;
    const detail = await (configuration.transport ?? fetch)(api + `/submissions/${selected.id}`, { method: 'GET', redirect: 'error', signal: controller.signal,
      headers: { 'X-Auth-Token': configuration.apiKey } });
    if (!detail.ok) { void detail.body?.cancel().catch(() => undefined); return null; }
    const detailData = submissionSchema.parse(await readCommerceProviderJson(detail, controller.signal, 1_000_000));
    if (detailData.id !== selected.id) return null;
    return await observeSubmission(detailData, job, configuration, controller.signal);
  } catch { return null; } finally { clearTimeout(timer); }
}
