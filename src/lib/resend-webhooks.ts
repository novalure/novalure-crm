import 'server-only';
import {createHash,createHmac,timingSafeEqual} from 'node:crypto';

export const resendDeliveryTypes=['email.sent','email.delivered','email.delivery_delayed','email.bounced','email.complained','email.failed','email.suppressed'] as const;
export type ResendDeliveryType=typeof resendDeliveryTypes[number];
export type ProviderDeliveryKind='newsletter'|'newsletter_test'|'automation';
export type VerifiedResendEvent={eventId:string;digest:string;type:ResendDeliveryType;occurredAt:string;emailId:string;to:string;from:string;reference:{kind:ProviderDeliveryKind;id:string}|null;bounceType:string|null};
export class ResendWebhookError extends Error{constructor(readonly status:400|401|409|413|503,readonly code:string){super(code);}}
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function signingBytes(secret:string){
 if(!secret.startsWith('whsec_')||!/^whsec_[A-Za-z0-9+/_-]+={0,2}$/.test(secret))throw new ResendWebhookError(503,'webhook_not_configured');
 const encoded=secret.slice(6).replaceAll('-','+').replaceAll('_','/'),bytes=Buffer.from(encoded,'base64');
 if(bytes.length<16||bytes.length>128||bytes.toString('base64').replace(/=+$/,'')!==encoded.replace(/=+$/,''))throw new ResendWebhookError(503,'webhook_not_configured');return bytes;
}
export function resendWebhookConfigured(secret=process.env.RESEND_WEBHOOK_SECRET??''){try{signingBytes(secret);return true;}catch{return false;}}
/** Svix's documented raw-body HMAC protocol; no parsed or reserialized JSON is used for authentication. */
export function verifyResendSignature(raw:string,headers:Headers,secret:string,nowMs=Date.now()){
 const key=signingBytes(secret),id=headers.get('svix-id')??'',timestamp=headers.get('svix-timestamp')??'',signatures=headers.get('svix-signature')??'';
 if(!/^[A-Za-z0-9_-]{8,160}$/.test(id)||!/^\d{9,12}$/.test(timestamp)||signatures.length>2048||Math.abs(nowMs/1000-Number(timestamp))>300)throw new ResendWebhookError(401,'invalid_signature');
 const expected=createHmac('sha256',key).update(`${id}.${timestamp}.${raw}`,'utf8').digest();let matched=false;
 const candidates=signatures.trim().split(/\s+/);if(candidates.length>8)throw new ResendWebhookError(401,'invalid_signature');
 for(const candidate of candidates){if(!/^v1,[A-Za-z0-9+/]{43}=$/.test(candidate))continue;const provided=Buffer.from(candidate.slice(3),'base64');if(provided.length===expected.length&&timingSafeEqual(provided,expected))matched=true;}
 if(!matched)throw new ResendWebhookError(401,'invalid_signature');return id;
}
const object=(value:unknown):Record<string,unknown>=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};
function email(value:unknown,display=false){if(typeof value!=='string'||value.length>512||/[\r\n]/.test(value))return'';const address=(display?(value.match(/<([^<>]+)>/)?.[1]??value):value).trim().toLowerCase();return address.length<=254&&/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(address)?address:'';}
export function parseVerifiedResendEvent(raw:string,eventId:string,nowMs=Date.now()):VerifiedResendEvent|null{
 if(Buffer.byteLength(raw,'utf8')>128000)throw new ResendWebhookError(413,'payload_too_large');let parsed:unknown;try{parsed=JSON.parse(raw);}catch{throw new ResendWebhookError(400,'invalid_payload');}
 const value=object(parsed);if(!(resendDeliveryTypes as readonly unknown[]).includes(value.type))return null;
 const data=object(value.data),to=Array.isArray(data.to)&&data.to.length===1?email(data.to[0]):'',from=email(data.from,true),created=typeof value.created_at==='string'?Date.parse(value.created_at):NaN;
 if(typeof data.email_id!=='string'||!uuid.test(data.email_id)||!to||!from||!Number.isFinite(created)||created<0||created>nowMs+300000)throw new ResendWebhookError(400,'invalid_payload');
 const tags=object(data.tags);let reference:VerifiedResendEvent['reference']=null;
 if(typeof tags.novalure_delivery==='string'&&uuid.test(tags.novalure_delivery)&&['newsletter','newsletter_test','automation'].includes(String(tags.novalure_kind)))reference={id:tags.novalure_delivery,kind:tags.novalure_kind as ProviderDeliveryKind};
 const bounce=object(data.bounce),bounceType=typeof bounce.type==='string'&&['Permanent','Transient','Undetermined'].includes(bounce.type)?bounce.type:null;
 return{eventId,digest:createHash('sha256').update(raw,'utf8').digest('hex'),type:value.type as ResendDeliveryType,occurredAt:new Date(created).toISOString(),emailId:data.email_id.toLowerCase(),to,from,reference,bounceType};
}
export function verifyResendWebhook(raw:string,headers:Headers,options:{secret?:string;nowMs?:number}={}){const now=options.nowMs??Date.now(),id=verifyResendSignature(raw,headers,options.secret??process.env.RESEND_WEBHOOK_SECRET??'',now);return parseVerifiedResendEvent(raw,id,now);}
/** Published Svix verification vector. This never uses the deployed signing secret or writes delivery evidence. */
export function localResendSignatureCheck(){try{return verifyResendSignature('{"event_type":"ping","data":{"success":true}}',new Headers({'svix-id':'msg_loFOjxBNrRLzqYUf','svix-timestamp':'1731705121','svix-signature':'v1,rAvfW3dJ/X/qxhsaXPOyyCGmRKsaKWcsNccKXlIktD0='}),'whsec_plJ3nmyCDGBKInavdOK15jsl',1731705121000)==='msg_loFOjxBNrRLzqYUf';}catch{return false;}}
export async function readResendWebhookBody(request:Request){
 if(Number(request.headers.get('content-length'))>128000)throw new ResendWebhookError(413,'payload_too_large');const reader=request.body?.getReader();if(!reader)throw new ResendWebhookError(400,'invalid_payload');const chunks:Uint8Array[]=[];let size=0,timer:ReturnType<typeof setTimeout>|undefined;
 const deadline=new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new ResendWebhookError(400,'invalid_payload')),5000);});
 try{for(;;){const part=await Promise.race([reader.read(),deadline]);if(part.done)break;size+=part.value.byteLength;if(size>128000)throw new ResendWebhookError(413,'payload_too_large');chunks.push(part.value);}return new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks,size));}
 catch(error){void reader.cancel().catch(()=>undefined);throw error instanceof TypeError?new ResendWebhookError(400,'invalid_payload'):error;}finally{clearTimeout(timer);reader.releaseLock();}
}
