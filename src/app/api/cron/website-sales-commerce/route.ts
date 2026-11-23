import { runConfiguredCommerceWorker } from '@/lib/website-sales-commerce-host';
import { CommerceSourceError } from '@/lib/website-sales-commerce-source';
export const runtime = 'nodejs';
export const maxDuration = 60;
export async function GET(request: Request) {
  const headers = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' };
  try { return Response.json(await runConfiguredCommerceWorker(request), { headers }); }
  catch (error) { return Response.json({ error: error instanceof CommerceSourceError ? error.code : 'COMMERCE_WORKER_UNAVAILABLE' },
    { status: error instanceof CommerceSourceError ? error.status : 503, headers }); }
}
