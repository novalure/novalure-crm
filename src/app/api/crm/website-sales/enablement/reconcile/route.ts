import { resolveWorkspaceScopedSession } from '@/lib/auth/session';
import { reconcileWebsiteSalesEnablementCommand } from '@/lib/db/website-sales-enablement-repositories';
import { websiteSalesEnablementBody, websiteSalesEnablementError } from '@/lib/website-sales-enablement-http';
import { websiteSalesEnablementContract } from '@/lib/website-sales-enablement-types';
export async function POST(request: Request) {
 try {
  const auth = await resolveWorkspaceScopedSession(request, { permission: 'crm:write', capability: 'pipeline:write' }); if (!auth.ok) return auth.response;
  const input = await websiteSalesEnablementBody(request), result = await reconcileWebsiteSalesEnablementCommand(auth.session, input);
  return Response.json({ ...result, contractVersion: 'website-sales-enablement-reconcile-v1', originalContractVersion: websiteSalesEnablementContract, correlationId: input.correlationId }, { headers: { 'Cache-Control': 'private, no-store' } });
 } catch (error) { return websiteSalesEnablementError(error); }
}
