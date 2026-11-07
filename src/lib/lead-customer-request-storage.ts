import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { del, get, put } from "@vercel/blob";
import { getPrivateMediaBlobToken } from "@/lib/media-store";
import { hasExpectedMediaMagicBytes } from "@/lib/media-security";
import type { CustomerRequestUpload } from "./lead-customer-request";
const max = 4 * 1024 * 1024;
const uuid = /^[0-9a-f-]{36}$/i;
function uploadPath(upload: Pick<CustomerRequestUpload, "workspaceId" | "leadId" | "requestId" | "pathname">) {
  const prefix = `${upload.workspaceId}/lead-proof-private-${upload.leadId}/pending-${upload.requestId}-`;
  if (![upload.workspaceId,upload.leadId,upload.requestId].every(v=>uuid.test(v)) || !upload.pathname.startsWith(prefix) || upload.pathname !== path.posix.normalize(upload.pathname) || !/^[a-f0-9-]{36}\.(pdf|jpg|png)$/.test(upload.pathname.slice(prefix.length))) throw new Error("Invalid private request storage reference");
  return upload.pathname;
}
function localPath(upload: Pick<CustomerRequestUpload,"workspaceId"|"leadId"|"requestId"|"pathname">) {
  const root = path.resolve(process.env.NOVALURE_MEDIA_ROOT || path.join(process.cwd(),".data","media"),"uploads"), resolved = path.resolve(root,...uploadPath(upload).split("/"));
  if (!resolved.startsWith(root+path.sep)) throw new Error("Invalid private request path"); return resolved;
}
export async function validateCustomerRequestUpload(file: File) {
  const mime=file.type.toLowerCase(), extension=mime==='application/pdf'?'pdf':mime==='image/jpeg'?'jpg':mime==='image/png'?'png':'';
  if(!extension||file.size<1||file.size>max||!new RegExp(`\\.(?:${extension==='jpg'?'jpe?g':extension})$`,'i').test(file.name))throw new Error('Use a PDF, JPG or PNG file up to 4 MB.');
  const bytes=new Uint8Array(await file.arrayBuffer());if(!hasExpectedMediaMagicBytes(bytes.slice(0,64),mime))throw new Error('The file content does not match its type.');
  return {bytes,mime,extension,name:file.name.slice(0,180),size:bytes.length,hash:createHash('sha256').update(bytes).digest('hex')};
}
export async function storeCustomerRequestUpload(scope: {workspaceId:string;leadId:string;requestId:string},file: File):Promise<CustomerRequestUpload> {
  const {bytes,mime,extension,name,size,hash}=await validateCustomerRequestUpload(file);
  const id=randomUUID(),pathname=`${scope.workspaceId}/lead-proof-private-${scope.leadId}/pending-${scope.requestId}-${id}.${extension}`;
  const upload:CustomerRequestUpload={...scope,id,provider:'local',pathname,name,mime,size,hash};uploadPath(upload);
  const token=getPrivateMediaBlobToken();
  if(token){const stored=await put(pathname,Buffer.from(bytes),{access:'private',contentType:mime,token,addRandomSuffix:false,maximumSizeInBytes:max});if(stored.pathname!==pathname)throw new Error('Unexpected private upload location');upload.provider='vercel-blob';}
  else{if(process.env.VERCEL!==undefined||process.env.NODE_ENV==='production')throw new Error('Private storage is unavailable.');const target=localPath(upload);await mkdir(path.dirname(target),{recursive:true});await writeFile(target,bytes,{flag:'wx'});}
  return upload;
}
export async function readCustomerRequestUpload(upload: CustomerRequestUpload) {
  let bytes:Uint8Array;
  if(upload.provider==='local'){if(process.env.VERCEL!==undefined)throw new Error('Local private storage is unavailable.');bytes=await readFile(localPath(upload));}
  else{const token=getPrivateMediaBlobToken();if(!token)throw new Error('Private storage is unavailable.');const result=await get(uploadPath(upload),{access:'private',token,useCache:false,abortSignal:AbortSignal.timeout(15000)});if(!result||result.statusCode!==200||result.blob.size>max)throw new Error('Private file is unavailable.');bytes=new Uint8Array(await new Response(result.stream).arrayBuffer());}
  if(bytes.length!==upload.size||bytes.length>max||createHash('sha256').update(bytes).digest('hex')!==upload.hash||!hasExpectedMediaMagicBytes(bytes.slice(0,64),upload.mime))throw new Error('Private file failed integrity validation.');return bytes;
}
export async function deleteCustomerRequestUpload(upload: CustomerRequestUpload) {
  if(upload.provider==='local'){if(process.env.VERCEL!==undefined)throw new Error('Local private storage is unavailable.');await rm(localPath(upload),{force:true});}
  else{const token=getPrivateMediaBlobToken();if(!token)throw new Error('Private storage is unavailable.');await del(uploadPath(upload),{token});}
}
