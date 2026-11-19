import { resolveWorkspaceScopedSession } from "@/lib/auth/session";
import { assertCrmUuid, crmCommandErrorResponse, withCrmRead } from "@/lib/crm-command";
import { loadPropertyInquiries } from "@/lib/db/property-inquiry-read-repository";
export async function GET(request:Request){
  const auth=await resolveWorkspaceScopedSession(request,{permission:"crm:read"});if(!auth.ok)return auth.response;
  try{const raw=new URL(request.url).searchParams.get("projectId");const data=await withCrmRead(auth.session,(tx,s)=>loadPropertyInquiries(tx,s,raw?assertCrmUuid(raw):null));return Response.json({data},{headers:{"Cache-Control":"private, no-store",Vary:"Cookie"}});}catch(error){return crmCommandErrorResponse(error);}
}
