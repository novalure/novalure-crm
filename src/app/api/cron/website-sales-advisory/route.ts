import { runConfiguredAdvisoryWorker } from '@/lib/website-sales-advisory-host';
import { CrmCommandError } from '@/lib/crm-command';
export const runtime = 'nodejs';
export const maxDuration = 60;
export async function POST(request: Request) {
  const headers = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' };
  try { return Response.json(await runConfiguredAdvisoryWorker(request), { headers }); }
  catch (error) { return Response.json({ error: error instanceof CrmCommandError ? error.code : 'ADVISORY_WORKER_UNAVAILABLE' },
    { status: error instanceof CrmCommandError ? error.status : 503, headers }); }
}
