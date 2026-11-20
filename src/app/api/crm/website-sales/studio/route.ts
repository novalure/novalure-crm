import { resolveWorkspaceScopedSession } from "@/lib/auth/session";
import { getTrustedAppOrigin } from "@/lib/auth/app-origin";
import { crmCommandErrorResponse, crmRequestMetadata } from "@/lib/crm-command";
import { executeWebsiteSalesStudioCommand, parseWebsiteSalesStudioCommand, readWebsiteSalesStudio, reconcileWebsiteSalesStudioCommand } from "@/lib/db/website-sales-studio-repositories";
import { websiteStudioBody, websiteStudioPrivateHeaders } from "@/lib/website-sales-studio-http";
export const runtime="nodejs";
export async function GET(request:Request){const auth=await resolveWorkspaceScopedSession(request,{permission:"crm:read"});if(!auth.ok)return auth.response;try{const q=new URL(request.url).searchParams;return Response.json(await readWebsiteSalesStudio(auth.session,{projectId:q.get("projectId")??"",companyId:q.get("companyId")??"",locationId:q.get("locationId")??""}),{headers:websiteStudioPrivateHeaders});}catch(error){return crmCommandErrorResponse(error);}}
export async function POST(request:Request){const auth=await resolveWorkspaceScopedSession(request,{permission:"crm:write",capability:"pipeline:write"});if(!auth.ok)return auth.response;let correlationId:string|undefined;try{const raw=await websiteStudioBody(request);const input=parseWebsiteSalesStudioCommand(raw);const meta=crmRequestMetadata(request,input as unknown as Record<string,unknown>);correlationId=meta.correlationId;const cmd={...input,...meta},reconcile=new URL(request.url).searchParams.get("mode")==="reconcile";
 const invitationOrigin=!reconcile&&cmd.operation==="create_preview"?new URL(getTrustedAppOrigin()).origin:undefined;
 const result=reconcile?await reconcileWebsiteSalesStudioCommand(auth.session,cmd):await executeWebsiteSalesStudioCommand(auth.session,cmd);
 // The canonical origin decorates only the one-time invitation, outside stored receipts and audit.
 const response=invitationOrigin&&"invitation" in result&&result.invitation?{...result,invitation:{...result.invitation,origin:invitationOrigin}}:result;
 return Response.json(response,{headers:websiteStudioPrivateHeaders});}catch(error){return crmCommandErrorResponse(error,correlationId);}}
