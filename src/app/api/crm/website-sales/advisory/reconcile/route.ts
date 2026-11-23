import { resolveWorkspaceScopedSession } from '@/lib/auth/session';
import { reconcileWebsiteSalesAdvisoryCommand } from '@/lib/db/website-sales-advisory-repositories';
import { websiteSalesAdvisoryBody, websiteSalesAdvisoryError } from '@/lib/website-sales-advisory-http';
export async function POST(request: Request) {
 try {
  const auth = await resolveWorkspaceScopedSession(request, { permission: 'crm:write', capability: 'pipeline:write' }); if (!auth.ok) return auth.response;
  const input = await websiteSalesAdvisoryBody(request);
  return Response.json(await reconcileWebsiteSalesAdvisoryCommand(auth.session, input), { headers: { 'Cache-Control': 'private, no-store' } });
 } catch (error) { return websiteSalesAdvisoryError(error); }
}
