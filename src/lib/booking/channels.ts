import "server-only";
import { randomUUID } from "node:crypto";
import { createOpaqueToken, hashOpaqueToken, protectLowEntropyValue, getTrustedAuthClientIp } from "@/lib/auth/auth-security";
import { hasBoundTenantTransaction, queryRows } from "@/lib/db/client";
import { getTrustedAppOrigin } from "@/lib/auth/app-origin";
import { crmPayloadDigest, type TenantTransaction } from "@/lib/crm-command";
import { BookingError, type BookingKind, type BookingProviderName, type BookingRecord } from "./types";
import { bookingAudit, readBooking, withBookingTransaction } from "./repository";
import { cancelBooking, confirmBooking, createBookingHold, getBookingAvailability, getBookingStatus, rescheduleBooking, type BookingServiceOptions } from "./service";
import { bookingBootstrapRows, lookupBookingPublication, publicBookingPublication, publicationUuid, serverBookingSession, type StoredBookingPublication } from "./publication";
import { readBookingSetup } from "./configuration";
import { bookingChannels, type BookingChannel, type PublicBookingRecord } from "./publication-types";

export type BookingChannelRelation = { source: "studio_handoff" | "external_chat" | "machine" | "form_submission"; sourceId: string; leadId?: string; contactId?: string };
export type TrustedBookingBinding = { expectedChannel: "chat" | "voice" | "form"; expectedWorkspaceId: string; expectedPublicId: string; expectedBindingId: string; expectedTypeIds: string[] };
export type BookingChannelOptions = BookingServiceOptions & { trustedBinding?: TrustedBookingBinding };
type SessionInput = { publicId: string; channel: BookingChannel; typeId: string; language: "de" | "en" };
type ChannelSession = { id:string; workspaceId:string; organizerId:string; publicationId:string; assignmentId:string; channel:BookingChannel; language:"de"|"en"; bindingId:string|null; relation:BookingChannelRelation|Record<string,never>; origin:string; ipHash:string; expiresAt:string; provider:BookingProviderName; kind:BookingKind; publication:StoredBookingPublication };
type ChannelOperation = {id:string; coreKey:string; bookingId:string|null; state:"attempting"|"succeeded"|"unknown"|"rejected"; requestHash:string; errorCode:string|null};
export type BookingChannelAction = "availability"|"hold"|"confirm"|"status"|"reschedule"|"cancel";
const object=(x:unknown):x is Record<string,unknown>=>!!x&&typeof x==="object"&&!Array.isArray(x);
function fields(input:unknown,allowed:string[]):asserts input is Record<string,unknown>{if(!object(input)||Object.keys(input).some(key=>!allowed.includes(key)))throw new BookingError("INVALID_CHANNEL_INPUT");}
function uuid(value:unknown):string{if(typeof value!=="string"||!publicationUuid.test(value))throw new BookingError("INVALID_BOOKING_REFERENCE");return value;}
function bounded(value:unknown,max:number,empty=false):string{if(typeof value!=="string"||value.length>max||!empty&&!value.trim()||/[\u0000-\u001f\u007f]/.test(value))throw new BookingError("INVALID_CHANNEL_INPUT");return value.trim();}
function ipHash(request:Request){return protectLowEntropyValue("booking-channel-ip",getTrustedAuthClientIp(request.headers)??"unavailable");}
function requestOrigin(request:Request):string{const origin=request.headers.get("origin");if(!origin||origin==="null"||origin.length>300)throw new BookingError("BOOKING_ORIGIN_FORBIDDEN",403);try{if(new URL(origin).origin!==origin)throw 0;}catch{throw new BookingError("BOOKING_ORIGIN_FORBIDDEN",403);}return origin;}
export function assertBookingChannelOrigin(request:Request,publication:StoredBookingPublication){const origin=requestOrigin(request);if(origin!==new URL(getTrustedAppOrigin()).origin&&!publication.config.allowedOrigins.includes(origin))throw new BookingError("BOOKING_ORIGIN_FORBIDDEN",403);return origin;}
function validateSessionInput(input:unknown):SessionInput{fields(input,["publicId","channel","typeId","language"]);if(typeof input.publicId!=="string"||!bookingChannels.includes(input.channel as BookingChannel)||!["de","en"].includes(String(input.language)))throw new BookingError("INVALID_CHANNEL_INPUT");return {publicId:input.publicId,channel:input.channel as BookingChannel,typeId:uuid(input.typeId),language:input.language as "de"|"en"};}
function validateRelation(input:BookingChannelRelation|undefined){if(input===undefined)return {};fields(input,["source","sourceId","leadId","contactId"]);if(!["studio_handoff","external_chat","machine","form_submission"].includes(input.source))throw new BookingError("INVALID_CHANNEL_RELATION");bounded(input.sourceId,160);if(input.leadId)uuid(input.leadId);if(input.contactId)uuid(input.contactId);return input;}
async function issue(request:Request,input:SessionInput,options:BookingChannelOptions,trusted?:{workspaceId:string;bindingId:string;relation?:BookingChannelRelation}){
  const stored=await lookupBookingPublication(input.publicId,options),assignment=stored.config.assignments.find(item=>item.id===input.typeId);
  if(!assignment||!stored.config.channels[input.channel])throw new BookingError("PUBLICATION_NOT_FOUND",404);
  if(trusted&&trusted.workspaceId!==stored.workspaceId)throw new BookingError("BOOKING_CHANNEL_FORBIDDEN",403);
  const origin=trusted?(trusted.relation?.source==="external_chat"?requestOrigin(request):`trusted:${input.channel}`):assertBookingChannelOrigin(request,stored),hash=ipHash(request),token=createOpaqueToken(),expiresAt=new Date(Date.now()+30*60_000).toISOString();
  const session=serverBookingSession(stored.workspaceId,assignment.organizerId);
  await withBookingTransaction(session,async(tx)=>{
    const current=await tx.queryOne<{publication:StoredBookingPublication|null}>("select booking_publication_lookup($1) as publication",[input.publicId]);
    if(!current?.publication||current.publication.revision!==stored.revision)throw new BookingError("BOOKING_PUBLICATION_CHANGED",409);
    const budget=await tx.queryOne<{allowed:boolean}>("select booking_channel_reserve_budget($1,$2,'session') as allowed",[stored.id,hash]);if(!budget?.allowed)throw new BookingError("BOOKING_SESSION_LIMIT",429);
    await tx.execute(`insert into booking_channel_sessions(workspace_id,organizer_id,publication_id,assignment_id,publication_revision,token_hash,ip_hash,origin,channel,language,binding_id,relation,expires_at) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::timestamptz)`,[stored.workspaceId,assignment.organizerId,stored.id,assignment.id,stored.revision,hashOpaqueToken(token),hash,origin,input.channel,input.language,trusted?.bindingId??null,JSON.stringify(validateRelation(trusted?.relation)),expiresAt]);
  },options);
  return {token,expiresAt,publication:await publicBookingPublication(stored,input.channel,options)};
}
export async function startBookingChannelSession(request:Request,raw:unknown,options:BookingChannelOptions={}){const input=validateSessionInput(raw);if(input.channel==="chat"||input.channel==="voice")throw new BookingError("TRUSTED_BOOKING_CHANNEL_REQUIRED",403);return issue(request,input,options);}
export async function issueTrustedBookingChannelSession(request:Request,input:SessionInput&{workspaceId:string;bindingId:string;relation?:BookingChannelRelation},options:BookingChannelOptions={}){
  if(!["chat","voice","form"].includes(input.channel))throw new BookingError("TRUSTED_BOOKING_CHANNEL_REQUIRED",403);
  uuid(input.workspaceId);bounded(input.bindingId,200);
  return issue(request,validateSessionInput({publicId:input.publicId,channel:input.channel,typeId:input.typeId,language:input.language}),options,{workspaceId:input.workspaceId,bindingId:input.bindingId,relation:input.relation});
}
async function loadSession(token:string,request:Request|undefined,options:BookingChannelOptions,receipt=false):Promise<ChannelSession>{
  if(typeof token!=="string"||!/^[A-Za-z0-9_-]{43}$/.test(token))throw new BookingError("BOOKING_SESSION_INVALID",401);
  const found=(await bookingBootstrapRows<{session:ChannelSession|null}>("select booking_channel_session_lookup($1) as session",[hashOpaqueToken(token)],options))[0]?.session;
  if(!found)throw new BookingError("BOOKING_SESSION_INVALID",401);
  if(found.bindingId){const expected=options.trustedBinding;if(!expected||expected.expectedWorkspaceId!==found.workspaceId||expected.expectedPublicId!==found.publication.config.publicId||expected.expectedChannel!==found.channel||expected.expectedBindingId!==found.bindingId||!Array.isArray(expected.expectedTypeIds)||!expected.expectedTypeIds.includes(found.assignmentId))throw new BookingError("TRUSTED_BOOKING_CHANNEL_REQUIRED",403);}
  else if(!receipt){if(!request||assertBookingChannelOrigin(request,found.publication)!==found.origin||ipHash(request)!==found.ipHash)throw new BookingError("BOOKING_SESSION_CONTEXT_CHANGED",403);}
  return found;
}
function actor(session:ChannelSession){return serverBookingSession(session.workspaceId,session.organizerId);}
async function sessionGuard(tx:TenantTransaction,session:ChannelSession,count=true){
  const predicate=`id=$1 and workspace_id=$2 and organizer_id=$3 and revoked_at is null and expires_at>now() and request_count<200 and booking_channel_session_lookup(token_hash) is not null`;
  const row=count?await tx.queryOne(`update booking_channel_sessions set request_count=request_count+1 where ${predicate} returning id`,[session.id,session.workspaceId,session.organizerId]):await tx.queryOne(`select id from booking_channel_sessions where ${predicate}`,[session.id,session.workspaceId,session.organizerId]);
  if(!row)throw new BookingError("BOOKING_SESSION_INVALID",401);
}
async function ownBooking(tx:TenantTransaction,session:ChannelSession,id:string){
  const own=await tx.queryOne("select id from booking_channel_operations where session_id=$1 and action='hold' and booking_id=$2 and state='succeeded'",[session.id,id]);if(!own)throw new BookingError("BOOKING_NOT_FOUND",404);
  const row=await readBooking(tx,actor(session),id);if(row.provider!==session.provider||row.kind!==session.kind)throw new BookingError("BOOKING_NOT_FOUND",404);return row;
}
function publicRecord(row:BookingRecord,session:ChannelSession):PublicBookingRecord{return {id:row.id,state:row.state,kind:row.kind,startsAt:row.startsAt,endsAt:row.endsAt,timeZone:row.rules.timeZone,videoUrl:row.videoUrl,videoStatus:row.videoStatus,notificationStatus:row.notificationStatus,location:row.kind==="onsite"?row.rules.location:row.kind==="office"?session.publication.config.assignments.find(item=>item.id===session.assignmentId)?.publicLocation??"":""};}
function location(body:Record<string,unknown>,session:ChannelSession){if(body.location!==undefined&&session.kind!=="onsite")throw new BookingError("INVALID_LOCATION");if(body.locationConfirmed!==undefined&&typeof body.locationConfirmed!=="boolean")throw new BookingError("INVALID_LOCATION");return {...(body.location!==undefined?{location:bounded(body.location,500)}:{}),...(body.locationConfirmed!==undefined?{locationConfirmed:body.locationConfirmed as boolean}:{})};}
async function attachRelation(session:ChannelSession,id:string,options:BookingChannelOptions){await withBookingTransaction(actor(session),async tx=>{await tx.execute("select booking_channel_attach_crm_relation($1,$2)",[session.id,id]);},options);}
async function status(session:ChannelSession,body:Record<string,unknown>,options:BookingChannelOptions){
  fields(body,["bookingId","idempotencyKey"]);if((body.bookingId!==undefined)===(body.idempotencyKey!==undefined))throw new BookingError("INVALID_CHANNEL_INPUT");
  const id=await withBookingTransaction(actor(session),async tx=>{
    await sessionGuard(tx,session);
    if(body.bookingId!==undefined)return (await ownBooking(tx,session,uuid(body.bookingId))).id;
    const op=await tx.queryOne<ChannelOperation>(`select id,core_key as "coreKey",booking_id as "bookingId",state,request_hash as "requestHash",error_code as "errorCode" from booking_channel_operations where session_id=$1 and action='hold' and client_key=$2`,[session.id,uuid(body.idempotencyKey)]);
    if(!op)return null;if(op.bookingId)return op.bookingId;
    const recovered=await tx.queryOne<{id:string}>("select id from booking_reservations where workspace_id=$1 and organizer_id=$2 and idempotency_key=$3",[session.workspaceId,session.organizerId,op.coreKey]);
    if(recovered)await tx.execute("update booking_channel_operations set booking_id=$2,state='succeeded',updated_at=now() where id=$1 and booking_id is null",[op.id,recovered.id]);
    return recovered?.id??null;
  },options);
  if(!id)return {booking:null,pending:true};
  const row=await getBookingStatus(actor(session),id,options);if(row.state==="confirmed")await attachRelation(session,id,options);return {booking:publicRecord(row,session)};
}
async function claim(session:ChannelSession,action:Exclude<BookingChannelAction,"availability"|"status">,body:Record<string,unknown>,options:BookingChannelOptions){
  const clientKey=action==="confirm"?uuid(body.bookingId):uuid(body.idempotencyKey),requestHash=crmPayloadDigest(body);
  return withBookingTransaction(actor(session),async(tx,fresh)=>{
    await tx.query("select pg_advisory_xact_lock(hashtextextended($1,0))",[`booking-channel:${session.id}`]);await sessionGuard(tx,session);
    if(action!=="hold")await ownBooking(tx,session,uuid(body.bookingId));
    const previous=await tx.queryOne<ChannelOperation>(`select id,core_key as "coreKey",booking_id as "bookingId",state,request_hash as "requestHash",error_code as "errorCode" from booking_channel_operations where session_id=$1 and action=$2 and client_key=$3`,[session.id,action,clientKey]);
    if(previous){if(previous.requestHash!==requestHash)throw new BookingError("IDEMPOTENCY_CONFLICT",409);return {operation:previous,claimed:false};}
    if(action==="hold"){
      const budget=await tx.queryOne<{allowed:boolean}>("select booking_channel_reserve_budget($1,$2,'hold') as allowed",[session.publicationId,session.ipHash]);
      const active=await tx.queryOne<{n:number}>(`select count(*)::int as n from booking_channel_operations o left join booking_reservations b on b.id=o.booking_id where o.session_id=$1 and o.action='hold' and (o.state in ('attempting','unknown') or b.state in ('processing','uncertain') or b.state='held' and b.expires_at>now())`,[session.id]);
      const changed=await tx.queryOne("update booking_channel_sessions set hold_count=hold_count+1 where id=$1 and hold_count<6 returning id",[session.id]);
      if(!budget?.allowed||!changed||(active?.n??0)>=2)throw new BookingError("BOOKING_HOLD_LIMIT",429);
    }
    const operation:ChannelOperation={id:randomUUID(),coreKey:randomUUID(),bookingId:action==="hold"?null:uuid(body.bookingId),state:"attempting",requestHash,errorCode:null};
    await tx.execute(`insert into booking_channel_operations(id,workspace_id,organizer_id,session_id,action,client_key,core_key,request_hash,booking_id,state,consent_at) values($1,$2,$3,$4,$5,$6,$7,$8,$9,'attempting',$10::timestamptz)`,[operation.id,session.workspaceId,session.organizerId,session.id,action,clientKey,operation.coreKey,requestHash,operation.bookingId,body.consent===true?new Date().toISOString():null]);
    if(body.consent===true)await bookingAudit(tx,fresh,"booking.channel_consent",operation.bookingId!,{channel:session.channel,sessionId:session.id,action});
    return {operation,claimed:true};
  },options);
}
export async function dispatchBookingChannelAction(token:string,action:BookingChannelAction,raw:unknown,request:Request,options:BookingChannelOptions={}){
  const session=await loadSession(token,request,options);const body=raw;
  const coreOptions:BookingChannelOptions={...options,authorize:async(tx,fresh)=>{
    await tx.query("select pg_advisory_xact_lock_shared(hashtextextended($1,0))",[`booking-workspace:${session.workspaceId}`]);
    const allowed=await tx.queryOne<{allowed:boolean}>("select booking_channel_authorize_session($1) as allowed",[session.id]);
    if(!allowed?.allowed)throw new BookingError("BOOKING_SESSION_INVALID",401);
    await sessionGuard(tx,session,false);
    if(session.kind==="office"&&action!=="cancel"){
      const setup=await readBookingSetup(tx,fresh,"office"),published=session.publication.config.assignments.find(item=>item.id===session.assignmentId)?.publicLocation;
      if(!published||published.trim()!==setup.rules.location.trim())throw new BookingError("PUBLIC_OFFICE_LOCATION_REQUIRED",409);
    }
    if(options.authorize)await options.authorize(tx,fresh);
  }};
  if(action==="availability"){
    fields(body,["date","location","locationConfirmed","bookingId"]);if(typeof body.date!=="string"||!/^\d{4}-\d{2}-\d{2}$/.test(body.date))throw new BookingError("INVALID_DATE");
    const exclude=await withBookingTransaction(actor(session),async tx=>{await sessionGuard(tx,session);return body.bookingId!==undefined?(await ownBooking(tx,session,uuid(body.bookingId))).id:undefined;},options);
    const result=await getBookingAvailability(actor(session),{provider:session.provider,kind:session.kind,date:body.date,...location(body,session),...(exclude?{excludeBookingId:exclude}:{})},options);
    return {slots:result.slots.map(({startsAt,endsAt})=>({startsAt,endsAt})),timeZone:result.rules.timeZone,durationMinutes:result.rules.durationMinutes,requestFallback:result.requestFallback??false,travelIssues:result.travelIssues??[]};
  }
  if(action==="status"){fields(body,["bookingId","idempotencyKey"]);return status(session,body,options);}
  if(!["hold","confirm","reschedule","cancel"].includes(action))throw new BookingError("INVALID_CHANNEL_ACTION");
  fields(body,action==="hold"?["startsAt","recipientEmail","recipientName","location","locationConfirmed","idempotencyKey"]:action==="confirm"?["bookingId","consent"]:action==="reschedule"?["bookingId","startsAt","idempotencyKey","consent"]:["bookingId","idempotencyKey","consent"]);
  if(action!=="hold"&&body.consent!==true)throw new BookingError("BOOKING_CONSENT_REQUIRED");
  if(action==="hold"||action==="reschedule")bounded(body.startsAt,40);
  if(action==="hold"){bounded(body.recipientEmail,254);bounded(body.recipientName,160,true);location(body,session);}
  const {operation,claimed}=await claim(session,action,body,options);
  if(!claimed){if(operation.state==="rejected")throw new BookingError(operation.errorCode??"BOOKING_REJECTED",409);if(operation.bookingId){const result=await status(session,{bookingId:operation.bookingId},options);return operation.state==="succeeded"?result:{...result,pending:true,unknown:true};}return {booking:null,pending:true,unknown:operation.state==="unknown"};}
  try{
    let row:BookingRecord;
    if(action==="hold")row=await createBookingHold(actor(session),{provider:session.provider,kind:session.kind,startsAt:body.startsAt as string,title:session.publication.config.title,idempotencyKey:operation.coreKey,recipientEmail:body.recipientEmail as string,recipientName:body.recipientName as string,communicationLanguage:session.language,...location(body,session)},coreOptions);
    else if(action==="confirm")row=await confirmBooking(actor(session),operation.bookingId!,coreOptions);
    else if(action==="reschedule")row=await rescheduleBooking(actor(session),operation.bookingId!,{startsAt:body.startsAt as string,idempotencyKey:operation.coreKey},coreOptions);
    else row=await cancelBooking(actor(session),operation.bookingId!,{idempotencyKey:operation.coreKey},coreOptions);
    await withBookingTransaction(actor(session),async tx=>{await tx.execute("update booking_channel_operations set booking_id=$2,state='succeeded',updated_at=now() where id=$1 and state='attempting'",[operation.id,row.id]);},options);
    if(row.state==="confirmed")await attachRelation(session,row.id,options);
    return {booking:publicRecord(row,session)};
  }catch(error){
    const known=error instanceof BookingError;
    await withBookingTransaction(actor(session),async tx=>{await tx.execute("update booking_channel_operations set state=$2,error_code=$3,updated_at=now() where id=$1 and state='attempting'",[operation.id,known?"rejected":"unknown",known?error.code:"OUTCOME_UNKNOWN"]);},options);
    if(known)throw error;return {booking:null,pending:true,unknown:true};
  }
}
export async function verifyBookingChannelReceipt(token:string,bookingId:string,expected:{publicId:string;channel:"form";workspaceId:string},options:BookingChannelOptions={}){
  const session=await loadSession(token,undefined,options,true);
  if(session.workspaceId!==expected.workspaceId||session.publication.config.publicId!==expected.publicId||session.channel!==expected.channel)throw new BookingError("BOOKING_RECEIPT_INVALID",403);
  return withBookingTransaction(actor(session),async tx=>{await sessionGuard(tx,session,false);const row=await ownBooking(tx,session,uuid(bookingId));if(row.state!=="confirmed")throw new BookingError("BOOKING_RECEIPT_UNCONFIRMED",409);return {bookingId:row.id,sessionId:session.id,workspaceId:session.workspaceId,publicId:session.publication.config.publicId};},options);
}
export async function attachFormBookingRelation(token:string,bookingId:string,input:{publicId:string;workspaceId:string;formId:string;submissionId:string;leadId?:string;contactId?:string},options:BookingChannelOptions={}){
  uuid(bookingId);uuid(input.workspaceId);uuid(input.formId);uuid(input.submissionId);if(input.leadId)uuid(input.leadId);if(input.contactId)uuid(input.contactId);
  if(hasBoundTenantTransaction()){
    if(typeof token!=="string"||!/^[A-Za-z0-9_-]{43}$/.test(token))throw new BookingError("BOOKING_SESSION_INVALID",401);
    await queryRows("select booking_channel_attach_form_relation($1,$2,$3,$4,$5,$6,$7,$8)",[hashOpaqueToken(token),bookingId,input.formId,input.submissionId,input.leadId??null,input.contactId??null,input.publicId,input.workspaceId]);
    return;
  }
  await verifyBookingChannelReceipt(token,bookingId,{publicId:input.publicId,workspaceId:input.workspaceId,channel:"form"},options);
  const session=await loadSession(token,undefined,options,true);uuid(input.formId);uuid(input.submissionId);if(input.leadId)uuid(input.leadId);if(input.contactId)uuid(input.contactId);
  await withBookingTransaction(actor(session),async tx=>{
    const submission=await tx.queryOne<{leadId:string|null;contactId:string|null}>(`select lead_id as "leadId",contact_id as "contactId" from form_submissions where id=$1 and workspace_id=$2 and form_id=$3`,[input.submissionId,input.workspaceId,input.formId]);
    if(!submission||submission.leadId!==(input.leadId??null)||submission.contactId!==(input.contactId??null))throw new BookingError("BOOKING_RELATION_INVALID",403);
    const relation:BookingChannelRelation={source:"form_submission",sourceId:input.submissionId,...(submission.leadId?{leadId:submission.leadId}:{}),...(submission.contactId?{contactId:submission.contactId}:{})};
    const changed=await tx.queryOne("update booking_channel_sessions set relation=$2::jsonb where id=$1 and (relation='{}'::jsonb or relation=$2::jsonb) returning id",[session.id,JSON.stringify(relation)]);
    if(!changed)throw new BookingError("BOOKING_RELATION_CHANGED",409);
    await tx.execute("select booking_channel_attach_crm_relation($1,$2)",[session.id,bookingId]);
  },options);
}
