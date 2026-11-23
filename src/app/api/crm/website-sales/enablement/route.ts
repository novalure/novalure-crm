import { resolveWorkspaceScopedSession } from '@/lib/auth/session';
import { assertCrmUuid, CrmCommandError } from '@/lib/crm-command';
import { readWebsiteSalesEnablement, readWebsiteSalesEnablementProject, executeWebsiteSalesEnablementCommand } from '@/lib/db/website-sales-enablement-repositories';
import { websiteSalesEnablementBody, websiteSalesEnablementError } from '@/lib/website-sales-enablement-http';
import { compactWebsiteSalesOperationsReceipt } from '@/lib/website-sales-operations-receipt';

export async function GET(request: Request) {
 try {
  const auth = await resolveWorkspaceScopedSession(request, { permission: 'crm:read' }); if (!auth.ok) return auth.response;
  const p = new URL(request.url).searchParams, view = p.get('view') ?? 'resource';
  const allowed = view === 'project' ? ['workspaceId', 'view', 'projectId', 'cursor', 'limit'] : ['workspaceId', 'view', 'projectId', 'companyId', 'locationId'];
  if (!['resource', 'project'].includes(view)) throw new CrmCommandError('INVALID_QUERY', 'Unknown enablement view');
  for (const key of p.keys()) if (!allowed.includes(key) || p.getAll(key).length !== 1) throw new CrmCommandError('INVALID_QUERY', 'Exact scope required');
  const projectId = assertCrmUuid(p.get('projectId'));
  const data = view === 'project' ? await readWebsiteSalesEnablementProject(auth.session, projectId, p.get('cursor'), p.has('limit') && /^\d+$/.test(p.get('limit')!) ? Number(p.get('limit')) : p.has('limit') ? 0 : 25)
   : await readWebsiteSalesEnablement(auth.session, { projectId, companyId: assertCrmUuid(p.get('companyId')), locationId: assertCrmUuid(p.get('locationId')) });
  return Response.json(data, { headers: { 'Cache-Control': 'private, no-store' } });
 } catch (error) { return websiteSalesEnablementError(error); }
}
export async function POST(request: Request) {
 try {
  const auth = await resolveWorkspaceScopedSession(request, { permission: 'crm:write', capability: 'pipeline:write' }); if (!auth.ok) return auth.response;
  return Response.json(compactWebsiteSalesOperationsReceipt(await executeWebsiteSalesEnablementCommand(auth.session, await websiteSalesEnablementBody(request))), { headers: { 'Cache-Control': 'private, no-store' } });
 } catch (error) { return websiteSalesEnablementError(error); }
}
