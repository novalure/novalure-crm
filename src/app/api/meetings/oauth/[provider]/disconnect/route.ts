import {randomUUID} from 'node:crypto';
import {resolveWorkspaceScopedSession} from '@/lib/auth/session';
import {crmCommandErrorResponse,crmRequestMetadata,CrmCommandError} from '@/lib/crm-command';
import {disconnectCrmCalendar} from '@/lib/db/crm-integrations-repository';

/** Compatibility entrypoint: same scoped local disconnect and audit as the integration center. */
export async function POST(request:Request,context:{params:Promise<{provider:string}>}){
 const auth=await resolveWorkspaceScopedSession(request,{permission:'calendar:sync',capability:'calendar:manage'});if(!auth.ok)return auth.response;
 let correlationId:string|undefined;
 try{
  const {provider}=await context.params;if(!['google','microsoft'].includes(provider))throw new CrmCommandError('INVALID_PROVIDER','Kalenderanbieter ist ungültig.');
  const metadata=crmRequestMetadata(request,{idempotencyKey:request.headers.get('Idempotency-Key')??randomUUID(),correlationId:request.headers.get('X-Correlation-Id')??randomUUID()});correlationId=metadata.correlationId;
  const result=await disconnectCrmCalendar(auth.session,{provider},metadata);
  return Response.json({ok:true,provider,reason:null,...result},{headers:{'Cache-Control':'private, no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff'}});
 }catch(error){return crmCommandErrorResponse(error,correlationId);}
}
