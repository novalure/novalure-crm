import { configuredCommerceSource } from '@/lib/website-sales-commerce-host';
import { verifyCommerceSourcePull, CommerceSourceError } from '@/lib/website-sales-commerce-source';
import { readWebsiteSalesCommerceJob } from '@/lib/db/website-sales-commerce-outbox';

export const runtime = 'nodejs';
export const maxDuration = 30;
const headers = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' };
/** A pull exposes the frozen request only. The accounting/service authority performs its own idempotent
 * action and returns an authenticated actual source fact; reading never issues an invoice or payment.
 */
export async function GET(request: Request) {
  try {
    const { connection, key, executor } = configuredCommerceSource(request.headers.get('x-sales-source-id') ?? '');
    const jobId = verifyCommerceSourcePull(request, connection, key);
    const job = await readWebsiteSalesCommerceJob(executor, jobId);
    const sourceAllowed = job.kind === 'ACCOUNTING_INVOICE_REQUEST' ? connection.allowedKinds.includes('INVOICE') && connection.allowedSystems.includes('ACCOUNTING')
      : job.kind === 'SUBSCRIPTION_CHANGE' && connection.allowedKinds.includes('SUBSCRIPTION') && connection.allowedSystems.includes('SERVICE_AUTHORITY');
    if (!sourceAllowed) throw new CommerceSourceError(403, 'COMMERCE_SOURCE_REQUEST_DENIED');
    if (job.status === 'CANCELLED' || job.status === 'REJECTED') throw new CommerceSourceError(403, 'COMMERCE_SOURCE_REQUEST_WITHDRAWN');
    return Response.json({ contractVersion: 'website-sales-commerce-request-v1', jobId: job.id, identity: job.identity,
      workflowId: job.workflowId, kind: job.kind, requestKey: job.idempotencyKey, payload: job.payload, payloadDigest: job.payloadDigest,
      status: job.status, issuedInvoice: false }, { headers });
  } catch (error) {
    return Response.json({ error: error instanceof CommerceSourceError ? error.code : 'COMMERCE_SOURCE_REQUEST_UNAVAILABLE' },
      { status: error instanceof CommerceSourceError ? error.status : 503, headers });
  }
}
