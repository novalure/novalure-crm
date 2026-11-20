import { CrmCommandError } from "./crm-command";
import type { WebsiteDemoArtifact } from "./website-sales-studio";
export async function websiteStudioBody(request:Request,limit=120000):Promise<unknown>{
 if(Number(request.headers.get("content-length")??0)>limit)throw new CrmCommandError("PAYLOAD_TOO_LARGE","Request too large",413);
 const reader=request.body?.getReader();if(!reader)throw new CrmCommandError("INVALID_JSON","JSON required",400);
 const chunks:Uint8Array[]=[];let size=0,timedOut=false;const timer=setTimeout(()=>{timedOut=true;void reader.cancel();},10000);
 try{for(;;){const next=await reader.read();if(next.done)break;size+=next.value.byteLength;if(size>limit)throw new CrmCommandError("PAYLOAD_TOO_LARGE","Request too large",413);chunks.push(next.value);}if(timedOut)throw new CrmCommandError("BODY_TIMEOUT","Request body timed out",408);const bytes=new Uint8Array(size);let offset=0;for(const c of chunks){bytes.set(c,offset);offset+=c.byteLength;}return JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes));}
 catch(error){if(error instanceof CrmCommandError)throw error;throw new CrmCommandError("INVALID_JSON","Invalid JSON",400);}
 finally{clearTimeout(timer);void reader.cancel();reader.releaseLock();}
}
export const websiteStudioPrivateHeaders={"Cache-Control":"private, no-store","X-Robots-Tag":"noindex, nofollow, noarchive","Referrer-Policy":"no-referrer","X-Content-Type-Options":"nosniff"};
export function websiteStudioNotFound(){return new Response("Preview unavailable",{status:404,headers:websiteStudioPrivateHeaders});}
export function websiteStudioRenderedResponse(artifact:WebsiteDemoArtifact,path?:string){
 const headers=new Headers(websiteStudioPrivateHeaders);
 headers.set("Content-Security-Policy","default-src 'none'; script-src 'none'; style-src 'self'; img-src 'self'; connect-src 'none'; form-action 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'; sandbox allow-same-origin");
 if(path){const asset=artifact.content.assets.find(a=>a.path===path);if(!asset)return websiteStudioNotFound();headers.set("Content-Type",asset.mediaType+"; charset=utf-8");return new Response(asset.body,{headers});}
 headers.set("Content-Type","text/html; charset=utf-8");return new Response(artifact.content.html,{headers});
}
