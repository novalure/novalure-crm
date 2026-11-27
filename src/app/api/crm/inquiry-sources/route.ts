import { resolveWorkspaceScopedSession } from "@/lib/auth/session";
import { assertCrmUuid, crmCommandErrorResponse, CrmCommandError, withCrmRead } from "@/lib/crm-command";
import { loadInquirySources } from "@/lib/db/inquiry-sources-repository";
export async function GET(request:Request){
  const auth=await resolveWorkspaceScopedSession(request,{permission:"crm:read"});if(!auth.ok)return auth.response;
  try{
    const url=new URL(request.url),raw=url.searchParams.get("projectId"),days=Number(url.searchParams.get("days")||30);
    if(days!==30&&days!==90)throw new CrmCommandError("INVALID_PERIOD","Zeitraum ungültig");
    const data=await withCrmRead(auth.session,(tx,s)=>loadInquirySources(tx,s,raw?assertCrmUuid(raw):null,days));
    return Response.json({data},{headers:{"Cache-Control":"private, no-store",Vary:"Cookie"}});
  }catch(error){return crmCommandErrorResponse(error);}
}
