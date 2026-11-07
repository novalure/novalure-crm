import {resolveWorkspaceScopedSession} from '@/lib/auth/session';
import {assertCrmFields,assertCrmUuid,CrmCommandError,crmCommandErrorResponse,crmRequestMetadata} from '@/lib/crm-command';
import {readCrmIntegrations,disconnectCrmCalendar,changeCrmWebsiteStatus,createCrmTrainingIntegration,checkCrmIntegration} from '@/lib/db/crm-integrations-repository';
const headers={'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'};
export async function GET(request:Request){
 const auth=await resolveWorkspaceScopedSession(request,{permission:'crm:read',capability:'settings:manage'});if(!auth.ok)return auth.response;
 try{const projectId=new URL(request.url).searchParams.get('projectId');if(projectId)assertCrmUuid(projectId);return Response.json(await readCrmIntegrations(auth.session,projectId??undefined),{headers});}catch(error){return crmCommandErrorResponse(error);}
}
export async function POST(request:Request){
 const auth=await resolveWorkspaceScopedSession(request,{permission:'crm:write',capability:'settings:manage'});if(!auth.ok)return auth.response;let correlationId:string|undefined;
 try{
  const text=await request.text();if(Buffer.byteLength(text,'utf8')>16000)throw new CrmCommandError('REQUEST_TOO_LARGE','Die Integrationsangaben sind zu groß.',413);const parsed:unknown=JSON.parse(text);if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw new CrmCommandError('INVALID_INPUT','Ein JSON-Objekt ist erforderlich.');
  const input=parsed as Record<string,unknown>,common=['action','idempotencyKey','correlationId'];
  const fields:Record<string,string[]>={disconnect_calendar:['provider'],website_status:['id','status','expectedUpdatedAt'],create_training:['formId','origin'],local_check:['targetType','targetId','origin','capability']};
  if(typeof input.action!=='string'||!Object.hasOwn(fields,input.action))throw new CrmCommandError('INVALID_ACTION','Unbekannte Integrationsaktion.');assertCrmFields(input,[...common,...fields[input.action]]);
  for(const [key,value] of Object.entries(input))if(!common.includes(key)&&typeof value!=='string')throw new CrmCommandError('INVALID_INPUT','Integrationsfelder müssen Textwerte sein.');
  const metadata=crmRequestMetadata(request,input);correlationId=metadata.correlationId;
  const result=input.action==='disconnect_calendar'?await disconnectCrmCalendar(auth.session,{provider:String(input.provider??'')},metadata):input.action==='website_status'?await changeCrmWebsiteStatus(auth.session,{id:assertCrmUuid(input.id),status:String(input.status??''),expectedUpdatedAt:String(input.expectedUpdatedAt??'')},metadata):input.action==='create_training'?await createCrmTrainingIntegration(auth.session,{formId:assertCrmUuid(input.formId),origin:String(input.origin??'')},metadata):await checkCrmIntegration(auth.session,{targetType:String(input.targetType??''),targetId:String(input.targetId??''),origin:input.origin as string|undefined,capability:input.capability as string|undefined},metadata);
  return Response.json({...result,correlationId},{headers});
 }catch(error){return crmCommandErrorResponse(error instanceof SyntaxError?new CrmCommandError('INVALID_JSON','Ungültiges JSON.'):error,correlationId);}
}
