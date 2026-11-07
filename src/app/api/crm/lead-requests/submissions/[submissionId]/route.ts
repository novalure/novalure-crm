import { resolveWorkspaceScopedSession } from "@/lib/auth/session";
import { crmCommandErrorResponse } from "@/lib/crm-command";
import { getCustomerRequestSubmissionUpload } from "@/lib/lead-customer-request-repository";
import { readCustomerRequestUpload } from "@/lib/lead-customer-request-storage";
import { safeMediaContentDisposition } from "@/lib/media-security";
export const runtime="nodejs";
export async function GET(request:Request,context:{params:Promise<{submissionId:string}>}){
 const auth=await resolveWorkspaceScopedSession(request,{permission:"crm:read"});if(!auth.ok)return auth.response;
 try{const upload=await getCustomerRequestSubmissionUpload(auth.session,(await context.params).submissionId),bytes=await readCustomerRequestUpload(upload);
  return new Response(Buffer.from(bytes),{headers:{"Cache-Control":"private, no-store","Content-Type":upload.mime,"Content-Length":String(bytes.length),"Content-Disposition":safeMediaContentDisposition(upload.name,upload.mime).replace(/^inline;/,"attachment;"),"Content-Security-Policy":"sandbox; default-src 'none'","X-Content-Type-Options":"nosniff","Cross-Origin-Resource-Policy":"same-origin","Referrer-Policy":"no-referrer"}});
 }catch(error){return crmCommandErrorResponse(error);}
}
