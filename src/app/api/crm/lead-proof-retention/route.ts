import {resolveWorkspaceScopedSession} from '@/lib/auth/session';
import {assertCrmFields,assertCrmUuid,crmCommandErrorResponse,crmRequestMetadata,CrmCommandError,executeCrmCommand,withCrmRead} from '@/lib/crm-command';
import {assertProofRetentionManager,getLeadProofRetention,purgeLeadProofFile,saveLeadProofRetentionPolicy,setLeadProofRetentionHold} from '@/lib/lead-proof-retention-repository';
import {readCustomerRequestBody} from '@/lib/lead-customer-request-http';
export const runtime='nodejs';
export async function GET(request:Request){const auth=await resolveWorkspaceScopedSession(request,{permission:'crm:read'});if(!auth.ok)return auth.response;try{return Response.json(await getLeadProofRetention(auth.session,assertCrmUuid(new URL(request.url).searchParams.get('leadId'))),{headers:{'Cache-Control':'private, no-store'}});}catch(error){return crmCommandErrorResponse(error);}}
export async function POST(request:Request){
 const auth=await resolveWorkspaceScopedSession(request,{permission:'crm:write',capability:'pipeline:write'});if(!auth.ok)return auth.response;let correlationId:string|undefined;
 try{
  if(auth.session.serviceIdentity)throw new CrmCommandError('PERSONAL_SESSION_REQUIRED','Eine persönliche Verwaltungsanmeldung ist erforderlich.',403);
  const input:unknown=JSON.parse((await readCustomerRequestBody(request,6000)).toString('utf8'));if(!input||typeof input!=='object'||Array.isArray(input))throw new CrmCommandError('INVALID_REQUEST','Ungültige Anfrage.');const body=input as Record<string,unknown>;
  assertCrmFields(body,['operation','leadId','proofId','enabled','graceDays','reason','expectedVersion','delegate','active','idempotencyKey','correlationId']);const leadId=assertCrmUuid(body.leadId),metadata=crmRequestMetadata(request,body);correlationId=metadata.correlationId;
  if(body.operation==='purge')return Response.json({...await purgeLeadProofFile(auth.session,{leadId,proofId:assertCrmUuid(body.proofId)},metadata),persisted:true},{headers:{'Cache-Control':'private, no-store'}});
  if(!['policy','hold'].includes(String(body.operation)))throw new CrmCommandError('INVALID_OPERATION','Unbekannte Aktion.');
  const projectId=await withCrmRead(auth.session,async(tx,fresh)=>String((await assertProofRetentionManager(tx,fresh,leadId)).project_id));
  const result=await executeCrmCommand<{id:string}>(auth.session,{operation:`lead_proof.retention.${body.operation}`,projectId,resourceId:leadId,capability:'pipeline:write',payload:body,...metadata},(tx,context)=>body.operation==='policy'?saveLeadProofRetentionPolicy(tx,context.session,{leadId,enabled:body.enabled as boolean,graceDays:body.graceDays as number,reason:body.reason as string,expectedVersion:body.expectedVersion as number,delegate:body.delegate as boolean}):setLeadProofRetentionHold(tx,context.session,{leadId,proofId:assertCrmUuid(body.proofId),active:body.active as boolean,reason:body.reason as string,expectedVersion:body.expectedVersion as number}));
  return Response.json({...result,persisted:true},{headers:{'Cache-Control':'private, no-store'}});
 }catch(error){return crmCommandErrorResponse(error instanceof SyntaxError?new CrmCommandError('INVALID_JSON','Ungültige Anfrage.'):error,correlationId);}
}
