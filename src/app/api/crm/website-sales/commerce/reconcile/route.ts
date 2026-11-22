import { resolveWorkspaceScopedSession } from '@/lib/auth/session';
import { reconcileWebsiteSalesCommerceCommand } from '@/lib/db/website-sales-commerce-repositories';
import { websiteSalesCommerceBody, websiteSalesCommerceError } from '@/lib/website-sales-commerce-http';
export async function POST(request: Request) {
 try{const auth=await resolveWorkspaceScopedSession(request,{permission:'crm:write',capability:'pipeline:write'});if(!auth.ok)return auth.response;return Response.json(await reconcileWebsiteSalesCommerceCommand(auth.session,await websiteSalesCommerceBody(request)),{headers:{'Cache-Control':'private, no-store'}});}catch(error){return websiteSalesCommerceError(error);}
}
