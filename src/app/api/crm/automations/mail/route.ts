import { resolveWorkspaceScopedSession } from '@/lib/auth/session';
import { assertCrmFields, assertCrmUuid, CrmCommandError, crmCommandErrorResponse, crmRequestMetadata } from '@/lib/crm-command';
import { previewAutomationMail, sendAutomationMail } from '@/lib/automation/mail-repository';

export const maxDuration=60;
export async function GET(request:Request){
 const auth=await resolveWorkspaceScopedSession(request,{permission:'crm:read'});if(!auth.ok)return auth.response;
 try {const query=new URL(request.url).searchParams;return Response.json(await previewAutomationMail(auth.session,{draftId:assertCrmUuid(query.get('draftId')),purpose:query.get('purpose')??'salesFollowUp'}),{headers:{'Cache-Control':'no-store'}});}catch(error){return crmCommandErrorResponse(error);}
}
export async function POST(request:Request){
 const auth=await resolveWorkspaceScopedSession(request,{permission:'crm:write',capability:'pipeline:write'});if(!auth.ok)return auth.response;
 let correlationId:string|undefined;
 try {
  const body=await request.text();if(body.length>6000)throw new CrmCommandError('REQUEST_TOO_LARGE','Der Versandauftrag ist zu groß.',413);
  const value:unknown=JSON.parse(body);if(!value||typeof value!=='object'||Array.isArray(value))throw new CrmCommandError('INVALID_REQUEST','Ein JSON-Objekt ist erforderlich.');
  const input=value as Record<string,unknown>;assertCrmFields(input,['draftId','purpose','approvalDigest','approved','idempotencyKey','correlationId']);
  if(typeof input.purpose!=='string'||typeof input.approvalDigest!=='string'||typeof input.approved!=='boolean')throw new CrmCommandError('INVALID_APPROVAL','Zweck, Freigabedigest und ausdrückliche Entscheidung sind erforderlich.');
  const metadata=crmRequestMetadata(request,input);correlationId=metadata.correlationId;
  const result=await sendAutomationMail(auth.session,{draftId:assertCrmUuid(input.draftId),purpose:input.purpose,approvalDigest:input.approvalDigest,approved:input.approved},metadata);
  return Response.json({...result,correlationId},{headers:{'Cache-Control':'no-store'}});
 }catch(error){return crmCommandErrorResponse(error instanceof SyntaxError?new CrmCommandError('INVALID_JSON','Ungültiges JSON.'):error,correlationId);}
}
