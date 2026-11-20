import { resolveWorkspaceScopedSession } from "@/lib/auth/session";
import { websiteStudioQaRender } from "@/lib/db/website-sales-studio-repositories";
import { websiteStudioNotFound,websiteStudioRenderedResponse } from "@/lib/website-sales-studio-http";
export const runtime="nodejs";
export async function GET(request:Request,context:{params:Promise<{artifactId:string;resource:string}>}){const auth=await resolveWorkspaceScopedSession(request,{permission:"crm:read"});if(!auth.ok)return websiteStudioNotFound();try{const p=await context.params;if(p.resource!=="render")return websiteStudioNotFound();const q=new URL(request.url).searchParams;const artifact=await websiteStudioQaRender(auth.session,{projectId:q.get("projectId")??"",companyId:q.get("companyId")??"",locationId:q.get("locationId")??""},p.artifactId);return websiteStudioRenderedResponse(artifact);}catch{return websiteStudioNotFound();}}
