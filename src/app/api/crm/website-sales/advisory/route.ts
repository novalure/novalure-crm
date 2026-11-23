import { resolveWorkspaceScopedSession } from '@/lib/auth/session';
import { assertCrmUuid, CrmCommandError } from '@/lib/crm-command';
import { executeWebsiteSalesAdvisoryCommand, readWebsiteSalesAdvisory } from '@/lib/db/website-sales-advisory-repositories';
import { websiteSalesAdvisoryBody, websiteSalesAdvisoryError } from '@/lib/website-sales-advisory-http';

export async function GET(request: Request) {
 try {
  const auth = await resolveWorkspaceScopedSession(request, { permission: 'crm:read' }); if (!auth.ok) return auth.response;
  const p = new URL(request.url).searchParams;
  for (const key of p.keys()) if (!['workspaceId', 'projectId', 'companyId', 'locationId', 'workflowId'].includes(key) || p.getAll(key).length !== 1) throw new CrmCommandError('INVALID_QUERY', 'Exact scope required');
  const scope = { projectId: assertCrmUuid(p.get('projectId')), companyId: assertCrmUuid(p.get('companyId')), locationId: assertCrmUuid(p.get('locationId')), workflowId: assertCrmUuid(p.get('workflowId')) };
  return Response.json(await readWebsiteSalesAdvisory(auth.session, scope), { headers: { 'Cache-Control': 'private, no-store' } });
 } catch (error) { return websiteSalesAdvisoryError(error); }
}
export async function POST(request: Request) {
 try {
  const auth = await resolveWorkspaceScopedSession(request, { permission: 'crm:write', capability: 'pipeline:write' }); if (!auth.ok) return auth.response;
  return Response.json(await executeWebsiteSalesAdvisoryCommand(auth.session, await websiteSalesAdvisoryBody(request)), { headers: { 'Cache-Control': 'private, no-store' } });
 } catch (error) { return websiteSalesAdvisoryError(error); }
}
