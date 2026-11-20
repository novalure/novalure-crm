import { resolveWorkspaceScopedSession } from "@/lib/auth/session";
import { websiteStudioQaRender } from "@/lib/db/website-sales-studio-repositories";
import { websiteStudioNotFound,websiteStudioRenderedResponse } from "@/lib/website-sales-studio-http";
export const runtime="nodejs";
export async function GET(request:Request,context:{params:Promise<{artifactId:string;path:string}>}){const auth=await resolveWorkspaceScopedSession(request,{permission:"crm:read"});if(!auth.ok)return websiteStudioNotFound();try{const p=await context.params;const artifact=await websiteStudioQaRender(auth.session,null,p.artifactId);return websiteStudioRenderedResponse(artifact,p.path);}catch{return websiteStudioNotFound();}}
