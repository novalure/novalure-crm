import { resolveWorkspaceScopedSession } from "@/lib/auth/session";
import { crmCommandErrorResponse, CrmCommandError } from "@/lib/crm-command";
import { readBoundedCrmJson } from "@/lib/crm-request-body";
import { loadPropertySalesWorkspace, runPropertySalesCommand, type PropertySalesCommand } from "@/lib/db/property-sales-repositories";
export async function GET(request:Request){
 const auth=await resolveWorkspaceScopedSession(request,{permission:"crm:read"});
 if(!auth.ok)return auth.response;
 try{return Response.json({data:await loadPropertySalesWorkspace(auth.session,new URL(request.url).searchParams.get("projectId")??""),source:"database"})}
 catch(error){return crmCommandErrorResponse(error)}
}
export async function POST(request:Request){
 const auth=await resolveWorkspaceScopedSession(request,{permission:"crm:write",capability:"reservations:write"});
 if(!auth.ok)return auth.response;
 let body:PropertySalesCommand;
 try{
  const raw=await readBoundedCrmJson(request);
  if(!raw||typeof raw!=="object"||Array.isArray(raw))throw new CrmCommandError("INVALID_REQUEST","JSON object required",400);
  body=raw as PropertySalesCommand;
 } catch(error) {
  if(error instanceof CrmCommandError)return crmCommandErrorResponse(error);
  return Response.json({error:"VALIDATION_ERROR",message:"Invalid JSON"},{status:400});
 }
 try{return Response.json(await runPropertySalesCommand(auth.session,body))}
 catch(error){return crmCommandErrorResponse(error,body.correlationId)}
}
