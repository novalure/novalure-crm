import { CrmCommandError,crmCommandErrorResponse } from "@/lib/crm-command";
import { submitPublicCustomerRequest } from "@/lib/lead-customer-request-repository";
import { readCustomerRequestBody } from "@/lib/lead-customer-request-http";
import { getTrustedAppOrigin } from "@/lib/auth/app-origin";
import { isWebExposeOriginAllowed } from "@/lib/web-expose-http";
export const runtime="nodejs";
export async function POST(request:Request,context:{params:Promise<{token:string}>}){
 try{
  if(!isWebExposeOriginAllowed(request,getTrustedAppOrigin()))throw new CrmCommandError("INVALID_ORIGIN","Anfrage ist nicht zulässig.",403);
  let payload:unknown,file:File|undefined;
  if((request.headers.get("content-type")??"").startsWith("multipart/form-data")){
   const bytes=await readCustomerRequestBody(request,Math.floor(4.25*1024*1024)),form=await new Response(bytes,{headers:{"Content-Type":request.headers.get("content-type")!}}).formData();payload=JSON.parse(String(form.get("payload")));const part=form.get("file");if(part instanceof File)file=part;
  }else{const bytes=await readCustomerRequestBody(request,20000);payload=JSON.parse(bytes.toString("utf8"));}
  const output=await submitPublicCustomerRequest((await context.params).token,request.headers.get("Idempotency-Key")??"",payload,file);
  return Response.json({accepted:output.accepted,reference:output.reference},{headers:{"Cache-Control":"private, no-store","Referrer-Policy":"no-referrer"}});
 }catch(error){return crmCommandErrorResponse(error instanceof CrmCommandError?error:new CrmCommandError("INVALID_SUBMISSION","Bitte Eingaben und Dateityp prüfen. PDF, JPG oder PNG bis 4 MB verwenden."));}
}
