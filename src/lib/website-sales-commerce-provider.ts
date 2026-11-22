import 'server-only';
import { createHash } from 'node:crypto';
import { z } from 'zod';

const uuid = z.uuid();
const digest = z.hash('sha256');
const text = z.string().min(1).max(120_000).refine(value => !/[\u0000]/.test(value));
const email = z.email().max(254).refine(value => !/[\r\n]/.test(value));
export const commerceMailPayloadSchema = z.strictObject({
  documentRef: z.strictObject({ id: uuid, version: z.number().int().positive().safe(), digest }),
  documentSha256: digest, recipientEmail: email, recipientDigest: digest,
  subject: z.string().trim().min(1).max(200).refine(value => !/[\r\n]/.test(value)),
  text, approvalReference: uuid,
});
export type CommerceMailPayload = z.infer<typeof commerceMailPayloadSchema>;
export type CommerceProviderOutcome =
  | { outcome: 'ACCEPTED'; providerReference: string; receiptDigest: string }
  | { outcome: 'UNKNOWN' | 'REJECTED'; errorCode: string };
export type CommerceMailJob = {
  id: string; kind: 'OFFER_SEND' | 'CONTRACT_SEND'; payload: unknown;
  idempotencyKey: string; firstAttemptAt: string;
};
export type CommerceMailConfiguration = {
  apiKey: string; from: string; replyTo?: string; now?: () => number; transport?: typeof fetch;
};

function fail(code: string): never { throw new Error(code); }
function plainAddress(value: string): string {
  if (/[\r\n]/.test(value) || value.length > 320) fail('COMMERCE_MAIL_SENDER_INVALID');
  return email.parse((value.match(/<([^<>]+)>/)?.[1] ?? value).trim()).toLowerCase();
}
function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}
export async function readCommerceProviderJson(response: Response, signal: AbortSignal, maxBytes = 262_144): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) fail('COMMERCE_PROVIDER_EMPTY_RESPONSE');
  const chunks: Uint8Array[] = []; let length = 0;
  const abort = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    for (;;) {
      if (signal.aborted) fail('COMMERCE_PROVIDER_DEADLINE');
      const part = await reader.read(); if (part.done) break;
      length += part.value.byteLength;
      if (length > maxBytes) fail('COMMERCE_PROVIDER_RESPONSE_TOO_LARGE');
      chunks.push(part.value);
    }
    if (signal.aborted) fail('COMMERCE_PROVIDER_DEADLINE');
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  } finally {
    signal.removeEventListener('abort', abort);
    void reader.cancel().catch(() => undefined); reader.releaseLock();
  }
}

/** Real Resend transport. Only a freshly claimed, policy-checked server outbox job may call it.
 * API acceptance is deliberately not proof of delivery or customer acceptance.
 * https://resend.com/docs/dashboard/emails/idempotency-keys
 */
export async function sendCommerceMail(job: CommerceMailJob, configuration: CommerceMailConfiguration): Promise<CommerceProviderOutcome> {
  const payload = commerceMailPayloadSchema.parse(job.payload);
  uuid.parse(job.id);
  if (createHash('sha256').update(payload.text, 'utf8').digest('hex') !== payload.documentSha256)
    return { outcome: 'REJECTED', errorCode: 'COMMERCE_MAIL_DOCUMENT_CHANGED' };
  if (!['OFFER_SEND', 'CONTRACT_SEND'].includes(job.kind) || !/^sales-commerce:[a-f0-9-]{36}$/.test(job.idempotencyKey)
    || job.idempotencyKey !== `sales-commerce:${job.id}`) fail('COMMERCE_PROVIDER_JOB_INVALID');
  const now = configuration.now?.() ?? Date.now(), started = Date.parse(job.firstAttemptAt);
  // Outside the documented retention window even the original key could cause a second send.
  if (!Number.isFinite(started) || started > now || now - started >= 23 * 60 * 60_000)
    return { outcome: 'UNKNOWN', errorCode: 'COMMERCE_PROVIDER_IDEMPOTENCY_WINDOW_CLOSED' };
  if (!configuration.apiKey.trim() || /[\r\n]/.test(configuration.apiKey))
    return { outcome: 'REJECTED', errorCode: 'COMMERCE_MAIL_NOT_CONFIGURED' };
  const from = plainAddress(configuration.from);
  if (!from.endsWith('@novalure.eu')) return { outcome: 'REJECTED', errorCode: 'COMMERCE_MAIL_SENDER_NOT_APPROVED' };
  if (configuration.replyTo) plainAddress(configuration.replyTo);
  const body = {
    from: configuration.from, to: [payload.recipientEmail], subject: payload.subject, text: payload.text,
    html: `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(payload.subject)}</title></head><body><main><h1>${escapeHtml(payload.subject)}</h1><p style="white-space:pre-wrap">${escapeHtml(payload.text)}</p></main></body></html>`,
    ...(configuration.replyTo ? { reply_to: configuration.replyTo } : {}),
    tags: [{ name: 'novalure_kind', value: 'sales_commerce' }, { name: 'novalure_delivery', value: job.id }],
  };
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await (configuration.transport ?? fetch)('https://api.resend.com/emails', {
      method: 'POST', redirect: 'error', signal: controller.signal,
      headers: { Authorization: `Bearer ${configuration.apiKey}`, 'Content-Type': 'application/json', 'Idempotency-Key': job.idempotencyKey },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      return response.status >= 500 || [408, 409].includes(response.status)
        ? { outcome: 'UNKNOWN', errorCode: 'COMMERCE_MAIL_ACCEPTANCE_UNKNOWN' }
        : { outcome: 'REJECTED', errorCode: response.status === 429 ? 'COMMERCE_MAIL_RATE_LIMITED' : 'COMMERCE_MAIL_PROVIDER_REJECTED' };
    }
    const accepted = z.object({ id: uuid }).parse(await readCommerceProviderJson(response, controller.signal));
    return { outcome: 'ACCEPTED', providerReference: accepted.id,
      receiptDigest: createHash('sha256').update(JSON.stringify({ provider: 'RESEND', jobId: job.id, providerReference: accepted.id })).digest('hex') };
  } catch {
    return { outcome: 'UNKNOWN', errorCode: 'COMMERCE_MAIL_ACCEPTANCE_UNKNOWN' };
  } finally { clearTimeout(timer); }
}

/** Retrieval never sends and only resolves the immutable provider message selected by the outbox. */
export async function retrieveCommerceMail(providerReference: string, configuration: CommerceMailConfiguration): Promise<{
  providerReference: string; recipientEmail: string; from: string; subject: string; textSha256: string;
  status: 'ACCEPTED' | 'DELIVERED' | 'FAILED'; receiptDigest: string;
} | null> {
  uuid.parse(providerReference);
  if (!configuration.apiKey.trim()) return null;
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await (configuration.transport ?? fetch)(`https://api.resend.com/emails/${providerReference}`, {
      method: 'GET', redirect: 'error', signal: controller.signal, headers: { Authorization: `Bearer ${configuration.apiKey}` },
    });
    if (!response.ok) { void response.body?.cancel().catch(() => undefined); return null; }
    const data = z.object({ id: uuid, to: z.array(email).length(1), from: z.string(), subject: z.string().max(200), text,
      last_event: z.string() }).parse(await readCommerceProviderJson(response, controller.signal, 1_000_000));
    if (data.id !== providerReference || plainAddress(data.from) !== plainAddress(configuration.from)) return null;
    const event = data.last_event.replace(/^email\./, '');
    // Opens/clicks can come from scanners. They do not replace a delivery receipt.
    const status = event === 'delivered' ? 'DELIVERED' as const
      : ['bounced', 'complained', 'failed', 'suppressed'].includes(event) ? 'FAILED' as const
        : ['sent', 'queued', 'scheduled', 'delivery_delayed'].includes(event) ? 'ACCEPTED' as const : null;
    if (!status) return null;
    return { providerReference, recipientEmail: data.to[0]!, from: plainAddress(data.from), subject: data.subject,
      textSha256: createHash('sha256').update(data.text, 'utf8').digest('hex'), status,
      receiptDigest: createHash('sha256').update(JSON.stringify(data)).digest('hex') };
  } catch { return null; } finally { clearTimeout(timer); }
}
