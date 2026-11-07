import {resolveWorkspaceScopedSession} from '@/lib/auth/session';
import {crmCommandErrorResponse,crmRequestMetadata} from '@/lib/crm-command';
import {readPersonalMailJson} from '@/lib/crm-mailbox-request';
import {importExactQaMailboxMessage} from '@/lib/db/crm-mailbox-exact-import';
export const runtime='nodejs';
export const maxDuration=60;
export async function POST(request:Request){
 const auth=await resolveWorkspaceScopedSession(request,{permission:'crm:write'});if(!auth.ok)return auth.response;
 try{const input=await readPersonalMailJson(request,10000);return Response.json({...await importExactQaMailboxMessage(auth.session,input,crmRequestMetadata(request,{})),persisted:true,sent:false},{headers:{'Cache-Control':'private, no-store',Vary:'Cookie'}});}catch(error){return crmCommandErrorResponse(error);}
}
