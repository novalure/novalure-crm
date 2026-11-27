import {readResendWebhookBody,resendWebhookConfigured,verifyResendWebhook,ResendWebhookError} from '@/lib/resend-webhooks';
import {recordVerifiedResendEvent} from '@/lib/db/resend-webhook-repository';
const headers={'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'};
export async function POST(request:Request){
 try{
  if(!resendWebhookConfigured())throw new ResendWebhookError(503,'webhook_not_configured');
  const raw=await readResendWebhookBody(request),event=verifyResendWebhook(raw,request.headers);
  if(!event)return Response.json({accepted:true,status:'ignored'},{headers});
  const result=await recordVerifiedResendEvent(event);if(!result)throw new ResendWebhookError(503,'temporarily_unavailable');if(result.status==='conflict')throw new ResendWebhookError(409,'event_conflict');
  return Response.json({accepted:true,status:result.status},{headers});
 }catch(error){return Response.json({error:error instanceof ResendWebhookError?error.code:'temporarily_unavailable'},{status:error instanceof ResendWebhookError?error.status:503,headers});}
}
