import { CrmCommandError } from "@/lib/crm-command";
/** Enforces the real streamed size before multipart parsing, including absent or false Content-Length. */
export async function readCustomerRequestBody(request:Request,maxBytes:number){
 const declared=request.headers.get("content-length");if(declared!==null&&(!/^\d+$/.test(declared)||Number(declared)>maxBytes))throw new CrmCommandError("REQUEST_TOO_LARGE","Anfrage ist zu groß.",413);
 if(!request.body)throw new CrmCommandError("INVALID_REQUEST","Anfrage fehlt.");const reader=request.body.getReader(),chunks:Uint8Array[]=[];let size=0;
 try{for(;;){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>maxBytes){await reader.cancel().catch(()=>undefined);throw new CrmCommandError("REQUEST_TOO_LARGE","Anfrage ist zu groß.",413);}chunks.push(part.value);}}finally{reader.releaseLock();}
 return Buffer.concat(chunks,size);
}
