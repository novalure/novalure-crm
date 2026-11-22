import { configuredCommerceSource } from '@/lib/website-sales-commerce-host';
import { readCommerceSourceBody, verifyCommerceSourceRequest, CommerceSourceError } from '@/lib/website-sales-commerce-source';
import { verifyWebsiteSalesCommerceSource } from '@/lib/db/website-sales-commerce-outbox';
import { ingestVerifiedWebsiteSalesCommerceSource } from '@/lib/db/website-sales-commerce-sources';

const headers = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
export const runtime = 'nodejs';
export const maxDuration = 30;
export async function POST(request: Request) {
  try {
    const configured = configuredCommerceSource(request.headers.get('x-sales-source-id') ?? ''), raw = await readCommerceSourceBody(request);
    const proof = await verifyWebsiteSalesCommerceSource(raw, async () =>
      verifyCommerceSourceRequest(raw, request.headers, configured.connection, configured.key));
    const result = await ingestVerifiedWebsiteSalesCommerceSource(configured.executor, proof);
    return Response.json({ contractVersion: 'website-sales-commerce-source-receipt-v1', ...result }, { headers });
  } catch (error) {
    return Response.json({ error: error instanceof CommerceSourceError ? error.code : 'COMMERCE_SOURCE_UNAVAILABLE' },
      { status: error instanceof CommerceSourceError ? error.status : 503, headers });
  }
}
