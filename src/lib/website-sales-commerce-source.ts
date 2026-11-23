import 'server-only';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { commerceIdentitySchema, websiteSalesCommerceSourceEventSchema } from './website-sales-commerce-types';

export const commerceSourceConnectionSchema = z.strictObject({
  connectionId: z.uuid(), enabled: z.boolean(), provider: z.string().min(1).max(100), accountReference: z.string().min(1).max(200),
  identity: commerceIdentitySchema, workflowId: z.uuid(), validUntil: z.iso.datetime({ offset: true }),
  allowedSystems: z.array(z.enum(['CRM', 'ACCOUNTING', 'PAYMENT_PROVIDER', 'SIGNATURE_PROVIDER', 'DELIVERY_PROVIDER', 'SERVICE_AUTHORITY'])).min(1).max(6),
  allowedKinds: z.array(z.enum(['PROVIDER_DELIVERY', 'SIGNATURE', 'DELIVERY_ACCEPTANCE', 'INVOICE', 'PAYMENT', 'REFUND', 'CREDIT_NOTE', 'REVERSAL', 'SUBSCRIPTION'])).min(1).max(9),
});
export type CommerceSourceConnection = z.infer<typeof commerceSourceConnectionSchema>;
export class CommerceSourceError extends Error {
  constructor(readonly status: 400 | 401 | 403 | 413 | 503, readonly code: string) { super(code); }
}
const identityKeys = ['workspaceId', 'projectId', 'companyId', 'locationId'] as const;
const rawDigest = (raw: string) => createHash('sha256').update(raw, 'utf8').digest('hex');

/** Read-only pull authorization is a separate HMAC domain from source-fact ingestion. */
export function verifyCommerceSourcePull(request: Request, rawConnection: CommerceSourceConnection, secret: Uint8Array, now = Date.now()) {
  const connection = commerceSourceConnectionSchema.parse(rawConnection), url = new URL(request.url);
  const timestamp = request.headers.get('x-sales-timestamp') ?? '', signature = request.headers.get('x-sales-signature') ?? '';
  if (!connection.enabled || Date.parse(connection.validUntil) <= now || secret.byteLength < 32 || secret.byteLength > 128)
    throw new CommerceSourceError(503, 'COMMERCE_SOURCE_NOT_CONFIGURED');
  const jobId = url.searchParams.get('jobId');
  if (request.method !== 'GET' || !z.uuid().safeParse(jobId).success || [...url.searchParams.keys()].length !== 1
    || request.headers.get('x-sales-source-id') !== connection.connectionId || !/^\d{10,12}$/.test(timestamp)
    || Math.abs(now - Number(timestamp) * 1000) > 300_000 || !/^v1\.[A-Za-z0-9_-]{43}$/.test(signature))
    throw new CommerceSourceError(401, 'COMMERCE_SOURCE_UNAUTHORIZED');
  const expected = createHmac('sha256', secret).update(`website-sales-commerce-pull-v1.${connection.connectionId}.${timestamp}.GET.${url.pathname}${url.search}`).digest();
  const actual = Buffer.from(signature.slice(3), 'base64url');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new CommerceSourceError(401, 'COMMERCE_SOURCE_UNAUTHORIZED');
  return jobId!;
}

/** A source connector is a separately registered authority for one account/resource and listed event kinds.
 * HMAC authenticates its original bytes; it is not independent bank or legal verification.
 * Operator-entered records are deliberately excluded from this authenticated provider-fact path.
 */
export function verifyCommerceSourceRequest(raw: string, headers: Headers, rawConnection: CommerceSourceConnection,
  secret: Uint8Array, now = Date.now()) {
  const connection = commerceSourceConnectionSchema.parse(rawConnection);
  if (!connection.enabled || Date.parse(connection.validUntil) <= now || secret.byteLength < 32 || secret.byteLength > 128)
    throw new CommerceSourceError(503, 'COMMERCE_SOURCE_NOT_CONFIGURED');
  if (Buffer.byteLength(raw, 'utf8') > 131_072) throw new CommerceSourceError(413, 'COMMERCE_SOURCE_TOO_LARGE');
  const eventId = headers.get('x-sales-event-id') ?? '', timestamp = headers.get('x-sales-timestamp') ?? '', signature = headers.get('x-sales-signature') ?? '';
  if (!z.uuid().safeParse(eventId).success || headers.get('x-sales-source-id') !== connection.connectionId || !/^\d{10,12}$/.test(timestamp)
    || !Number.isSafeInteger(now) || Math.abs(now - Number(timestamp) * 1000) > 300_000 || !/^v1\.[A-Za-z0-9_-]{43}$/.test(signature))
    throw new CommerceSourceError(401, 'COMMERCE_SOURCE_UNAUTHORIZED');
  const expected = createHmac('sha256', secret).update(`website-sales-commerce-source-v1.${connection.connectionId}.${eventId}.${timestamp}.${raw}`, 'utf8').digest();
  const received = Buffer.from(signature.slice(3), 'base64url');
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) throw new CommerceSourceError(401, 'COMMERCE_SOURCE_UNAUTHORIZED');
  let input: unknown; try { input = JSON.parse(raw); } catch { throw new CommerceSourceError(400, 'COMMERCE_SOURCE_INVALID'); }
  const parsed = z.strictObject({ contractVersion: z.literal('website-sales-commerce-source-request-v1'), jobId: z.uuid(), event: websiteSalesCommerceSourceEventSchema }).safeParse(input);
  if (!parsed.success) throw new CommerceSourceError(400, 'COMMERCE_SOURCE_INVALID');
  const { event, jobId } = parsed.data;
  if (event.eventId !== eventId || event.workflowId !== connection.workflowId || identityKeys.some(key => event.identity[key] !== connection.identity[key])
    || event.source.provider !== connection.provider || event.source.accountReference !== connection.accountReference
    || !(connection.allowedSystems as readonly string[]).includes(event.source.system) || !(connection.allowedKinds as readonly string[]).includes(event.kind)
    || event.confidence !== 'PROVIDER_VERIFIED' || Date.parse(event.occurredAt) > now + 300_000)
    throw new CommerceSourceError(403, 'COMMERCE_SOURCE_SCOPE_DENIED');
  return { jobId, event: websiteSalesCommerceSourceEventSchema.parse({ ...event,
    // Retrieval time and proof reference are host facts, never caller assertions.
    retrievedAt: new Date(now).toISOString(), verificationReceiptReference: `connector:${connection.connectionId}:${rawDigest(raw)}`,
  }) };
}

export async function readCommerceSourceBody(request: Request) {
  if (Number(request.headers.get('content-length')) > 131_072) throw new CommerceSourceError(413, 'COMMERCE_SOURCE_TOO_LARGE');
  const reader = request.body?.getReader(); if (!reader) throw new CommerceSourceError(400, 'COMMERCE_SOURCE_INVALID');
  const chunks: Uint8Array[] = []; let size = 0; let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new CommerceSourceError(400, 'COMMERCE_SOURCE_DEADLINE')), 5000); });
  try {
    for (;;) { const part = await Promise.race([reader.read(), deadline]); if (part.done) break; size += part.value.byteLength;
      if (size > 131_072) throw new CommerceSourceError(413, 'COMMERCE_SOURCE_TOO_LARGE'); chunks.push(part.value); }
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  } catch (error) { void reader.cancel().catch(() => undefined); throw error instanceof CommerceSourceError ? error : new CommerceSourceError(400, 'COMMERCE_SOURCE_INVALID'); }
  finally { clearTimeout(timer); reader.releaseLock(); }
}
