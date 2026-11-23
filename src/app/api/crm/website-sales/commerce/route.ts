import { resolveWorkspaceScopedSession } from '@/lib/auth/session';
import { assertCrmUuid, CrmCommandError } from '@/lib/crm-command';
import { readWebsiteSalesCommerce, executeWebsiteSalesCommerceCommand } from '@/lib/db/website-sales-commerce-repositories';
import { websiteSalesCommerceBody, websiteSalesCommerceError } from '@/lib/website-sales-commerce-http';
export async function GET(request: Request) {
 try {
  const auth=await resolveWorkspaceScopedSession(request,{permission:'crm:read'});if(!auth.ok)return auth.response;
  const query=new URL(request.url).searchParams;
  for(const name of query.keys())if(!['workspaceId','projectId','companyId','locationId','workflowId'].includes(name)||query.getAll(name).length!==1)throw new CrmCommandError('INVALID_QUERY','Exact commerce resource required');
  return Response.json(await readWebsiteSalesCommerce(auth.session,{projectId:assertCrmUuid(query.get('projectId')),companyId:assertCrmUuid(query.get('companyId')),locationId:assertCrmUuid(query.get('locationId')),workflowId:assertCrmUuid(query.get('workflowId'))}),{headers:{'Cache-Control':'private, no-store'}});
 }catch(error){return websiteSalesCommerceError(error);}
}
export async function POST(request: Request) {
 try{const auth=await resolveWorkspaceScopedSession(request,{permission:'crm:write',capability:'pipeline:write'});if(!auth.ok)return auth.response;return Response.json(await executeWebsiteSalesCommerceCommand(auth.session,await websiteSalesCommerceBody(request)),{headers:{'Cache-Control':'private, no-store'}});}catch(error){return websiteSalesCommerceError(error);}
}
