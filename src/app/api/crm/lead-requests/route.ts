import { resolveWorkspaceScopedSession } from "@/lib/auth/session";
import { assertCrmFields,assertCrmUuid,CrmCommandError,crmCommandErrorResponse,crmRequestMetadata,executeCrmCommand,withCrmRead } from "@/lib/crm-command";
import { qualificationLead } from "@/lib/lead-qualification-repository";
import { createCustomerRequest,getCustomerRequestState,purgeCustomerRequestSubmissionFile,revokeCustomerRequest,reviewCustomerRequestSubmission,saveCustomerRequestSettings } from "@/lib/lead-customer-request-repository";
import type { CustomerRequestLanguage,CustomerRequestPurpose } from "@/lib/lead-customer-request";
export const runtime="nodejs";
export async function GET(request:Request){
 const auth=await resolveWorkspaceScopedSession(request,{permission:"crm:read"});if(!auth.ok)return auth.response;
 try{return Response.json(await getCustomerRequestState(auth.session,assertCrmUuid(new URL(request.url).searchParams.get("leadId"))),{headers:{"Cache-Control":"private, no-store"}});}catch(error){return crmCommandErrorResponse(error);}
}
export async function POST(request:Request){
 const auth=await resolveWorkspaceScopedSession(request,{permission:"crm:write",capability:"pipeline:write"});if(!auth.ok)return auth.response;
 let correlationId:string|undefined;
 try{
  const encoded=await request.text();if(encoded.length>20000)throw new CrmCommandError("REQUEST_TOO_LARGE","Anfrage ist zu groß.",413);
  const body=JSON.parse(encoded) as Record<string,unknown>;if(!body||typeof body!=="object"||Array.isArray(body))throw new CrmCommandError("INVALID_REQUEST","Objekt erwartet.");
  assertCrmFields(body,["operation","leadId","purpose","language","days","requestId","submissionId","expectedVersion","accept","reason","controller","privacyUrl","idempotencyKey","correlationId"]);
  if(!["create","revoke","review","settings","purge_file"].includes(String(body.operation)))throw new CrmCommandError("INVALID_OPERATION","Unbekannte Aktion.");
  const leadId=assertCrmUuid(body.leadId),metadata=crmRequestMetadata(request,body);correlationId=metadata.correlationId;
  if(body.operation==='purge_file'){const result=await purgeCustomerRequestSubmissionFile(auth.session,{leadId,submissionId:assertCrmUuid(body.submissionId),reason:body.reason as string},metadata);return Response.json({...result,persisted:true},{headers:{"Cache-Control":"private, no-store"}});}
  const projectId=await withCrmRead(auth.session,async(tx,fresh)=>String((await qualificationLead(tx,fresh,leadId)).project_id));
  const result=await executeCrmCommand(auth.session,{operation:`lead_request.${body.operation}`,resourceId:leadId,projectId,capability:"pipeline:write",...metadata,payload:body},async(tx,context)=>{
   if(body.operation==="settings")return saveCustomerRequestSettings(tx,context.session,{controller:body.controller as string,privacyUrl:body.privacyUrl as string});
   if(body.operation==="create")return createCustomerRequest(tx,context.session,{leadId,purpose:body.purpose as CustomerRequestPurpose,language:body.language as CustomerRequestLanguage,days:body.days as number});
   if(body.operation==="revoke")return revokeCustomerRequest(tx,context.session,leadId,assertCrmUuid(body.requestId));
   if(typeof body.accept!=="boolean"||!Number.isInteger(body.expectedVersion))throw new CrmCommandError("INVALID_REVIEW","Entscheidung und Versionsnummer erforderlich.");
   return reviewCustomerRequestSubmission(tx,context.session,{leadId,submissionId:assertCrmUuid(body.submissionId),expectedVersion:body.expectedVersion as number,accept:body.accept,reason:body.reason as string});
  });return Response.json({...result,persisted:true},{headers:{"Cache-Control":"private, no-store"}});
 }catch(error){return crmCommandErrorResponse(error instanceof SyntaxError?new CrmCommandError("INVALID_JSON","Ungültige Anfrage."):error,correlationId);}
}
