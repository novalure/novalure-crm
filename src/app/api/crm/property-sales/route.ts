import { resolveWorkspaceScopedSession } from "@/lib/auth/session";
import { crmCommandErrorResponse } from "@/lib/crm-command";
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
 try{body=await request.json();if(!body||typeof body!=="object"||Array.isArray(body))throw new Error("Invalid JSON")}
 catch{return Response.json({error:"VALIDATION_ERROR",message:"Invalid JSON"},{status:400})}
 try{return Response.json(await runPropertySalesCommand(auth.session,body))}
 catch(error){return crmCommandErrorResponse(error,body.correlationId)}
}
