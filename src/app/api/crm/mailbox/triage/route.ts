import {resolveWorkspaceScopedSession} from '@/lib/auth/session';
import {assertCrmFields,assertCrmUuid,crmCommandErrorResponse,crmRequestMetadata,withCrmRead} from '@/lib/crm-command';
import {readBoundedJsonObject} from '@/lib/external-api-response';
import {loadMailboxTriage,saveMailboxTriage} from '@/lib/db/mailbox-triage-repository';
import type {MailboxTriageStatus} from '@/lib/mailbox-triage';
const headers={'Cache-Control':'private, no-store',Vary:'Cookie'};
export async function GET(request:Request){const auth=await resolveWorkspaceScopedSession(request,{permission:'crm:read'});if(!auth.ok)return auth.response;try{const url=new URL(request.url),id=url.searchParams.get('projectId');return Response.json(await withCrmRead(auth.session,(tx,fresh)=>loadMailboxTriage(tx,fresh,id?assertCrmUuid(id):null,url.searchParams.get('includeDone')==='1')),{headers});}catch(error){return crmCommandErrorResponse(error);}}
export async function POST(request:Request){const auth=await resolveWorkspaceScopedSession(request,{permission:'crm:write'});if(!auth.ok)return auth.response;try{const input=await readBoundedJsonObject(request);assertCrmFields(input,['messageId','status','expectedRevision']);const result=await saveMailboxTriage(auth.session,{messageId:assertCrmUuid(input.messageId),status:input.status as MailboxTriageStatus,expectedRevision:input.expectedRevision as number},crmRequestMetadata(request,input));return Response.json({persisted:true,...result},{headers});}catch(error){return crmCommandErrorResponse(error);}}
