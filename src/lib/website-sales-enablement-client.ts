"use client";
import { csrfFetch } from './security/csrf-client';
import { assertSalesWriteBarrier } from './website-sales-write-barrier';
import { websiteSalesEnablementCommandSchema, websiteSalesEnablementContract, type WebsiteSalesEnablementCommand } from './website-sales-enablement-types';
import { websiteSalesEnablementPath, type WebsiteSalesEnablementResourceRead, type WebsiteSalesEnablementProjectRead, type WebsiteSalesEnablementScope } from './website-sales-enablement-api-types';

const prefix='novalure.website-sales-enablement.pending.v1',uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i,sha=/^[a-f0-9]{64}$/;
export type EnablementPending={command:WebsiteSalesEnablementCommand;body:string;state:'IN_FLIGHT'|'UNKNOWN';currentRead:boolean;retryAllowed:boolean;damaged?:true};
const pending=new Map<string,EnablementPending>(),listeners=new Set<()=>void>();
const notify=()=>listeners.forEach(listener=>listener());
export function subscribeEnablementPending(listener:()=>void){listeners.add(listener);return()=>{listeners.delete(listener);};}
const object=(raw:unknown):Record<string,unknown>=>{if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('INVALID_ENABLEMENT_RESPONSE');return raw as Record<string,unknown>;};
function key(workspaceId:string,actorId:string){if(!uuid.test(workspaceId)||!uuid.test(actorId))throw Error('INVALID_ENABLEMENT_SCOPE');return `${prefix}:${actorId}:${workspaceId}`;}
export function enablementPending(workspaceId:string,actorId:string){
 const k=key(workspaceId,actorId),cached=pending.get(k);if(cached)return cached;if(typeof window==='undefined')return undefined;
 try{const raw=window.sessionStorage.getItem(k);if(raw===null)return undefined;if(new TextEncoder().encode(raw).byteLength>260000)throw Error();const saved=object(JSON.parse(raw));if(Object.keys(saved).sort().join(',')!=='actorId,body,workspaceId'||saved.actorId!==actorId||saved.workspaceId!==workspaceId||typeof saved.body!=='string'||new TextEncoder().encode(saved.body).byteLength>120000)throw Error();const command=websiteSalesEnablementCommandSchema.parse(JSON.parse(saved.body));const item:EnablementPending={command,body:saved.body,state:'UNKNOWN',currentRead:false,retryAllowed:false};pending.set(k,item);return item;}
 catch{const item:EnablementPending={command:{} as WebsiteSalesEnablementCommand,body:'',state:'UNKNOWN',currentRead:false,retryAllowed:false,damaged:true};pending.set(k,item);return item;}
}
function clear(workspaceId:string,actorId:string){window.sessionStorage.removeItem(key(workspaceId,actorId));pending.delete(key(workspaceId,actorId));notify();}
export class EnablementBrowserError extends Error{constructor(readonly outcome:'DENIED'|'UNKNOWN',readonly code:string){super(code);}}
async function request(url:string,init:RequestInit){
 const controller=new AbortController(),source=init.signal,abort=()=>controller.abort();source?.addEventListener('abort',abort,{once:true});if(source?.aborted)abort();
 const bounded=new Request(new URL(url,window.location.origin),{...init,signal:controller.signal}),timer=setTimeout(()=>{controller.abort();void bounded.signal.aborted;},20000);
 try{const response=await csrfFetch(bounded),reader=response.body?.getReader();if(!reader)throw Error('EMPTY_RESPONSE');const cancel=()=>{void reader.cancel().catch(()=>undefined);};controller.signal.addEventListener('abort',cancel,{once:true});
  try{const chunks:Uint8Array[]=[],limit=init.method==='GET'||url.includes('/reconcile')?4000000:262144;let size=0;for(;;){if(controller.signal.aborted)throw Error('ABORTED');const next=await reader.read();if(next.done)break;size+=next.value.byteLength;if(size>limit)throw Error('RESPONSE_TOO_LARGE');chunks.push(next.value);}if(controller.signal.aborted)throw Error('ABORTED');const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}return{response,data:object(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)))};}
  finally{controller.signal.removeEventListener('abort',cancel);void reader.cancel().catch(()=>undefined);reader.releaseLock();}
 }finally{clearTimeout(timer);source?.removeEventListener('abort',abort);}
}
function identity(raw:unknown,workspaceId:string,scope:WebsiteSalesEnablementScope){const value=object(raw);if(value.workspaceId!==workspaceId||(['projectId','companyId','locationId'] as const).some(field=>value[field]!==scope[field]))throw Error('ENABLEMENT_SCOPE_MISMATCH');}
function validateRead(raw:unknown,workspaceId:string,scope:WebsiteSalesEnablementScope):WebsiteSalesEnablementResourceRead{
 const data=object(raw);identity(data.identity,workspaceId,scope);
 if(data.contractVersion!==websiteSalesEnablementContract||data.source!=='database'||data.projection!=='RESOURCE'||data.canContact!==false||typeof data.canWrite!=='boolean'||typeof data.canApproveFacts!=='boolean'||!Number.isSafeInteger(data.aggregateVersion)||Number(data.aggregateVersion)<0||!Number.isSafeInteger(data.workflowVersion)||Number(data.workflowVersion)<1)throw Error('INVALID_ENABLEMENT_READ');
 for(const field of ['contacts','tasks','references','referenceReviews','demoProfiles','assets','closureReasons','careBases','careCandidates','dailyPriorities','hygieneCandidates','careOffers'])if(!Array.isArray(data[field])||(data[field] as unknown[]).length>500)throw Error('INVALID_ENABLEMENT_READ');
 for(const rawAsset of data.assets as unknown[]){const asset=object(rawAsset);identity(asset.identity,workspaceId,scope);if('body' in asset||'bytes' in asset||'base64' in asset||!uuid.test(String(asset.assetId))||!sha.test(String(asset.sha256)))throw Error('INVALID_ENABLEMENT_ASSET');}
 return data as unknown as WebsiteSalesEnablementResourceRead;
}
export async function readEnablement(workspaceId:string,scope:WebsiteSalesEnablementScope,signal?:AbortSignal){const{response,data}=await request(`${websiteSalesEnablementPath}?${new URLSearchParams({workspaceId,...scope})}`,{method:'GET',cache:'no-store',credentials:'same-origin',signal});if(!response.ok)throw Error('ENABLEMENT_READ_DENIED');return validateRead(data,workspaceId,scope);}
export async function readEnablementProject(workspaceId:string,projectId:string,cursor:string|null=null,signal?:AbortSignal):Promise<WebsiteSalesEnablementProjectRead>{
 const{response,data}=await request(`${websiteSalesEnablementPath}?${new URLSearchParams({workspaceId,projectId,view:'project',...(cursor?{cursor}:{})})}`,{method:'GET',cache:'no-store',credentials:'same-origin',signal});
 if(!response.ok||data.contractVersion!==websiteSalesEnablementContract||data.source!=='database'||data.workspaceId!==workspaceId||data.projectId!==projectId||data.projection!=='PROJECT'||data.canContact!==false||!Array.isArray(data.dailyPriorities)||data.dailyPriorities.length>25)throw Error('INVALID_ENABLEMENT_PROJECT_READ');return data as unknown as WebsiteSalesEnablementProjectRead;
}
export function markEnablementCurrentRead(workspaceId:string,actorId:string,reference:{idempotencyKey:string;correlationId:string},scope:WebsiteSalesEnablementScope){const item=enablementPending(workspaceId,actorId);if(item&&!item.damaged&&item.state==='UNKNOWN'&&item.command.idempotencyKey===reference.idempotencyKey&&item.command.correlationId===reference.correlationId&&Object.entries(scope).every(([field,id])=>item.command[field as keyof WebsiteSalesEnablementScope]===id)){item.currentRead=true;notify();}}
function receipt(data:Record<string,unknown>,command:WebsiteSalesEnablementCommand,workspaceId:string){
 const effect=object(data.data);identity(effect.identity,workspaceId,command);if(data.contractVersion!==websiteSalesEnablementContract||data.persisted!==true||data.correlationId!==command.correlationId||!uuid.test(String(data.commandId))||!uuid.test(String(data.auditReference))||typeof data.replayed!=='boolean'||effect.canContact!==false||!Number.isSafeInteger(effect.aggregateVersion)||Number(effect.aggregateVersion)<command.expectedVersion||!Number.isSafeInteger(effect.workflowVersion)||Number(effect.workflowVersion)<command.expectedWorkflowVersion||!uuid.test(String(effect.recordId))||!sha.test(String(effect.recordDigest)))throw Error('INVALID_ENABLEMENT_RECEIPT');
 if(command.operation==='upload_asset'&&!uuid.test(String(effect.assetId))||command.operation==='prepare_care_offer'&&(!uuid.test(String(effect.offerId))||!uuid.test(String(effect.dealId))||!Number.isSafeInteger(effect.offerVersion)))throw Error('INVALID_ENABLEMENT_RECEIPT');
}
async function fileMatches(file:File,command:WebsiteSalesEnablementCommand){if(file.size<1||file.size>4194304||file.type!==command.payload.originalMime||file.size!==command.payload.originalSizeBytes)throw new EnablementBrowserError('DENIED','ASSET_ORIGINAL_REQUIRED');const bytes=await file.arrayBuffer(),hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),v=>v.toString(16).padStart(2,'0')).join('');if(hash!==command.payload.originalSha256)throw new EnablementBrowserError('DENIED','ASSET_ORIGINAL_REQUIRED');}
export async function writeEnablement(workspaceId:string,actorId:string,command:WebsiteSalesEnablementCommand,retryOriginal=false,file?:File){
 assertSalesWriteBarrier('enablement',workspaceId,actorId);const k=key(workspaceId,actorId),old=enablementPending(workspaceId,actorId);let item:EnablementPending;
 if(old){if(!retryOriginal||old.damaged||old.state!=='UNKNOWN'||!old.currentRead||!old.retryAllowed||JSON.stringify(command)!==old.body)throw new EnablementBrowserError('UNKNOWN','ENABLEMENT_RECOVERY_REQUIRED');item=old;}
 else{websiteSalesEnablementCommandSchema.parse(command);const body=JSON.stringify(command);if(new TextEncoder().encode(body).byteLength>120000)throw new EnablementBrowserError('DENIED','COMMAND_TOO_LARGE');item={command,body,state:'IN_FLIGHT',currentRead:false,retryAllowed:false};}
 if(command.operation==='upload_asset'){if(!file)throw new EnablementBrowserError('DENIED','ASSET_ORIGINAL_REQUIRED');await fileMatches(file,command);}
 item.state='IN_FLIGHT';item.currentRead=false;item.retryAllowed=false;
 try{window.sessionStorage.setItem(k,JSON.stringify({workspaceId,actorId,body:item.body}));pending.set(k,item);notify();}catch{if(old){item.state='UNKNOWN';pending.set(k,item);notify();}throw new EnablementBrowserError(old?'UNKNOWN':'DENIED','RECOVERY_STORAGE_UNAVAILABLE');}
 try{let body:BodyInit=item.body;const headers:Record<string,string>={'idempotency-key':command.idempotencyKey,'x-correlation-id':command.correlationId};if(file&&command.operation==='upload_asset'){const form=new FormData();form.set('command',item.body);form.set('file',file);body=form;}else headers['content-type']='application/json';
  const{response,data}=await request(`${websiteSalesEnablementPath}${command.operation==='upload_asset'?'/assets':''}?workspaceId=${encodeURIComponent(workspaceId)}`,{method:'POST',body,headers});
  if(!response.ok){if(response.status>=500)throw Error('SERVER_UNKNOWN');if(!old)clear(workspaceId,actorId);throw new EnablementBrowserError(old?'UNKNOWN':'DENIED',String(data.code??'ENABLEMENT_DENIED'));}
  receipt(data,command,workspaceId);clear(workspaceId,actorId);return data;
 }catch(error){if(error instanceof EnablementBrowserError&&error.outcome==='DENIED')throw error;item.state='UNKNOWN';item.currentRead=false;item.retryAllowed=false;pending.set(k,item);notify();throw new EnablementBrowserError('UNKNOWN','ENABLEMENT_OUTCOME_UNKNOWN');}
}
export async function reconcileEnablement(workspaceId:string,actorId:string){const item=enablementPending(workspaceId,actorId);if(!item||item.damaged||!item.currentRead)throw new EnablementBrowserError('UNKNOWN','CURRENT_READ_REQUIRED');
 try{const{response,data}=await request(`${websiteSalesEnablementPath}/reconcile?workspaceId=${encodeURIComponent(workspaceId)}`,{method:'POST',body:item.body,headers:{'content-type':'application/json','idempotency-key':item.command.idempotencyKey,'x-correlation-id':item.command.correlationId}});if(!response.ok||enablementPending(workspaceId,actorId)!==item||data.contractVersion!=='website-sales-enablement-reconcile-v1'||data.originalContractVersion!==websiteSalesEnablementContract||data.correlationId!==item.command.correlationId)throw Error('INVALID_RECONCILE');if(data.status==='COMMITTED'){receipt({...data,contractVersion:websiteSalesEnablementContract,persisted:true},item.command,workspaceId);clear(workspaceId,actorId);return 'COMMITTED' as const;}if(data.status==='NOT_FOUND'){item.retryAllowed=true;notify();return 'NOT_FOUND' as const;}throw Error('INVALID_RECONCILE');}
 catch{throw new EnablementBrowserError('UNKNOWN','ENABLEMENT_RECONCILE_UNKNOWN');}
}
