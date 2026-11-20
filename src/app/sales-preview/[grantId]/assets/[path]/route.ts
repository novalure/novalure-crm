import { websiteStudioCookieName,websiteStudioPublicPreview } from "@/lib/db/website-sales-studio-repositories";
import { websiteStudioNotFound,websiteStudioRenderedResponse } from "@/lib/website-sales-studio-http";
export const runtime="nodejs";
export async function GET(request:Request,context:{params:Promise<{grantId:string;path:string}>}){try{const {grantId,path}=await context.params;const key=websiteStudioCookieName(grantId);const token=(request.headers.get("cookie")??"").split(";").map(v=>v.trim()).find(v=>v.startsWith(key+"="))?.slice(key.length+1)??"";const preview=await websiteStudioPublicPreview(grantId,token,false);return preview?websiteStudioRenderedResponse(preview.artifact,path):websiteStudioNotFound();}catch{return websiteStudioNotFound();}}
