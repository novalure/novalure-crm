import "server-only";
import { randomUUID } from "node:crypto";
import type { AppSession } from "@/lib/auth/session";
import { assertCrmUuid, assertExpectedVersion, assertProjectGrant, crmPayloadDigest, type TenantTransaction, type TenantTransactionOptions } from "@/lib/crm-command";
import { bookingResourceLock, withBookingTransaction } from "@/lib/booking/repository";
import { getBookingCalendarAccess } from "@/lib/booking/connections";
import { BookingProviderError, createBookingProvider } from "@/lib/booking/providers";
import { BookingError, type BookingProvider, type BookingProviderName, type ProviderEvent } from "@/lib/booking/types";
import { assertBookingRuntime } from "@/lib/booking/runtime";
import { isBookingMessageRuntime } from "@/lib/booking/message-runtime";
import { assertBookingActivation } from "@/lib/booking/activation";
import { bookingRuntimeMode } from "@/lib/booking/runtime";
import type { PersonalCalendarDraft, PersonalCalendarEvent, PersonalCalendarRemoteSnapshot, PersonalCalendarState } from "@/lib/personal-calendar";

type Binding = { connectionId: string; revision: number; accountId: string | null; calendarId: string };
export type PersonalCalendarOptions = TenantTransactionOptions & {
  providerFactory?: (scope: {workspaceId:string;actorId:string}, provider: BookingProviderName) => Promise<BookingProvider>;
  connectionResolver?: (scope: {workspaceId:string;actorId:string}, provider: BookingProviderName) => Promise<Binding>;
  now?: () => number;
};
type Row = { id:string; provider:BookingProviderName; event:PersonalCalendarDraft; version:number; state:PersonalCalendarState;
  connectionId:string; connectionRevision:number; accountId:string; calendarId:string; operationId:string|null;
  providerEventId:string|null; providerEtag:string|null; remoteSnapshot:PersonalCalendarRemoteSnapshot|null; errorCode:string|null };
type Operation = { id:string; eventId:string; action:"create"|"update"|"cancel"|"import_remote"; requestHash:string;
  payload:{event:PersonalCalendarDraft;invitationsConfirmed:boolean}; state:"processing"|"uncertain"|"succeeded"|"rejected";
  leaseOwner:string|null; leaseUntil:string|null; result:PersonalCalendarEvent|null };
const columns = `id,provider,event,version::int,state,connection_id::text as "connectionId",connection_revision::int as "connectionRevision",account_id as "accountId",calendar_id as "calendarId",operation_id::text as "operationId",provider_event_id as "providerEventId",provider_etag as "providerEtag",remote_snapshot as "remoteSnapshot",error_code as "errorCode"`;
const opColumns = `id,event_id::text as "eventId",action,request_hash as "requestHash",payload,state,lease_owner::text as "leaseOwner",lease_until::text as "leaseUntil",result`;
const scope = (s:AppSession) => ({workspaceId:s.workspaceId,actorId:s.userId});
const clock = (o:PersonalCalendarOptions) => o.now?.() ?? Date.now();
function txRun<T>(s:AppSession,work:(tx:TenantTransaction,fresh:AppSession)=>Promise<T>,o:PersonalCalendarOptions) {
  return withBookingTransaction(s,async(tx,fresh)=>{await bookingResourceLock(tx,fresh);return work(tx,fresh);},o);
}
function runtime(o:PersonalCalendarOptions) {
  const test = process.env.NODE_ENV === "test" && !process.env.VERCEL_ENV && process.env.BOOKING_PRODUCTION_ENABLED !== "1";
  if ((o.providerFactory || o.connectionResolver) && !test) throw new BookingError("personal_calendar_test_adapter_forbidden",403);
  if (!test || !o.providerFactory) assertBookingRuntime();
}
function draft(raw:unknown):PersonalCalendarDraft {
  if (!raw || typeof raw!=="object" || Array.isArray(raw)) throw new BookingError("personal_calendar_invalid_event");
  const value=raw as Record<string,unknown>;
  if (Object.keys(value).some(k=>!["title","startsAt","endsAt","timeZone","location","projectId","attendees"].includes(k))) throw new BookingError("personal_calendar_unknown_field");
  const str=(key:string,max:number)=>{const v=value[key];if(typeof v!=="string"||v.length>max||/[\u0000-\u001f\u007f]/.test(v))throw new BookingError(`personal_calendar_invalid_${key}`);return v.trim();};
  const title=str("title",200),startsAt=str("startsAt",40),endsAt=str("endsAt",40),timeZone=str("timeZone",100),location=str("location",500);
  if(!title||![startsAt,endsAt].every(t=>/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{1,3})?)?(?:Z|[+-]\d\d:\d\d)$/.test(t)&&Number.isFinite(Date.parse(t)))||Date.parse(endsAt)<=Date.parse(startsAt))throw new BookingError("personal_calendar_invalid_interval");
  for(const value of [startsAt,endsAt]){const [year,month,day]=value.slice(0,10).split("-").map(Number),d=new Date(Date.UTC(year,month-1,day));if(d.getUTCFullYear()!==year||d.getUTCMonth()!==month-1||d.getUTCDate()!==day)throw new BookingError("personal_calendar_invalid_interval");}
  try{new Intl.DateTimeFormat("en",{timeZone}).format();}catch{throw new BookingError("personal_calendar_invalid_timezone");}
  const projectId=value.projectId==null?null:assertCrmUuid(value.projectId,"projectId");
  if(!Array.isArray(value.attendees)||value.attendees.length>10)throw new BookingError("personal_calendar_invalid_attendees");
  const attendees=value.attendees.map(a=>{if(!a||typeof a!=="object"||Array.isArray(a)||Object.keys(a).some(k=>!["email","name"].includes(k)))throw new BookingError("personal_calendar_invalid_attendees");const {email,name}=a as Record<string,unknown>;if(typeof email!=="string"||email.length>254||!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email)||typeof name!=="string"||name.length>200||/[\u0000-\u001f]/.test(name))throw new BookingError("personal_calendar_invalid_attendees");return{email:email.trim().toLowerCase(),name:name.trim()};});
  if(new Set(attendees.map(a=>a.email)).size!==attendees.length)throw new BookingError("personal_calendar_duplicate_attendee");
  return{title,startsAt:new Date(startsAt).toISOString(),endsAt:new Date(endsAt).toISOString(),timeZone,location,projectId,attendees};
}
function dto(row:Row):PersonalCalendarEvent {
  return{id:row.id,origin:"personal_standalone",provider:row.provider,event:row.event,version:row.version,state:row.state,providerEventId:row.providerEventId,providerEtag:row.providerEtag,remoteSnapshot:row.remoteSnapshot,errorCode:row.errorCode,
    canEdit:row.state==="synced",canCancel:row.state==="synced"||row.state==="failed"&&!row.providerEventId,canImport:row.state==="conflict"&&!!row.remoteSnapshot&&(row.remoteSnapshot.cancelled||!!row.remoteSnapshot.etag)};
}
async function read(tx:TenantTransaction,s:AppSession,id:string) {
  const row=await tx.queryOne<Row>(`select ${columns} from crm_personal_calendar_events where workspace_id=$1 and actor_id=$2 and id=$3 for update`,[s.workspaceId,s.userId,id]);
  if(!row)throw new BookingError("personal_calendar_not_found",404);
  if(row.event.projectId)await assertProjectGrant(tx,s,row.event.projectId,true);
  return row;
}
async function binding(tx:TenantTransaction,s:AppSession,row:Row) {
  const c=await tx.queryOne<{ok:boolean}>(`select status='connected' and revision=$4 and account_id=$5 and write_calendar_id=$6 and provider=$7 as ok from booking_calendar_connections where workspace_id=$1 and user_id=$2 and id=$3 for share`,[s.workspaceId,s.userId,row.connectionId,row.connectionRevision,row.accountId,row.calendarId,row.provider]);
  if(!c?.ok)throw new BookingError("personal_calendar_connection_changed",409);
}
async function audit(tx:TenantTransaction,s:AppSession,row:Row,action:string) {
  await tx.execute(`insert into audit_logs(workspace_id,actor_user_id,action,entity_type,entity_id,after) values($1,$2,$3,'personal_calendar',$4,$5::jsonb)`,[s.workspaceId,s.userId,action,row.id,JSON.stringify({state:row.state,version:row.version,provider:row.provider})]);
}
async function mirror(tx:TenantTransaction,s:AppSession,row:Row) {
  await tx.execute(`update calendar_events set title=$4,starts_at=$5::timestamptz,ends_at=$6::timestamptz,location=$7,status=$8,metadata=metadata||jsonb_build_object('personalCalendarState',$9::text,'externalCommunication',$10::boolean),updated_at=now() where workspace_id=$1 and owner_user_id=$2 and id=$3 and metadata->>'source'='personal_standalone_calendar'`,[s.workspaceId,s.userId,row.id,row.event.title,row.event.startsAt,row.event.endsAt,row.event.location,row.state==="cancelled"?"abgesagt":row.state==="synced"?"geplant":"angefragt",row.state,row.state==="synced"]);
}
function snapshot(remote:ProviderEvent,row:Row,o:PersonalCalendarOptions):PersonalCalendarRemoteSnapshot {
  if(!remote.cancelled&&!remote.content)throw new BookingError("personal_calendar_readback_missing",503);
  // A provider tombstone has no event body. Keep the last known local content
  // for the explicit cancellation review, never expose the transport sentinel.
  return{verifiedAt:new Date(clock(o)).toISOString(),eventId:remote.eventId,etag:remote.etag,cancelled:remote.cancelled,title:remote.content?.title??row.event.title,startsAt:remote.cancelled?row.event.startsAt:remote.startsAt,endsAt:remote.cancelled?row.event.endsAt:remote.endsAt,timeZone:row.event.timeZone,location:remote.content?.location??row.event.location,attendees:remote.content?.attendees??[]};
}
function recipientsEqual(a:PersonalCalendarDraft["attendees"],b:PersonalCalendarDraft["attendees"]) {
  // Providers may resolve a display name. The complete address set determines
  // notification authority; the original full request is still hash-bound.
  return crmPayloadDigest(a.map(x=>x.email.toLowerCase()).sort())===crmPayloadDigest(b.map(x=>x.email.toLowerCase()).sort());
}
async function authorizedWrite(s:AppSession,id:string,op:Operation,lease:string,o:PersonalCalendarOptions,write:()=>Promise<Response>,effect?:{attendees:PersonalCalendarDraft["attendees"];previousAttendees:PersonalCalendarDraft["attendees"]}) {
  return txRun(s,async(tx,fresh)=>{
    const current=await read(tx,fresh,id);await binding(tx,fresh,current);
    const active=await tx.queryOne<Operation>(`select ${opColumns} from crm_personal_calendar_operations where workspace_id=$1 and actor_id=$2 and id=$3 for update`,[fresh.workspaceId,fresh.userId,op.id]);
    if(!active||active.leaseOwner!==lease||active.state!=="processing"||!active.leaseUntil||Date.parse(active.leaseUntil)<=clock(o)||current.operationId!==op.id)throw new BookingError("personal_calendar_operation_changed",409);
    if(effect){
      const desired=op.action==="cancel"?[]:op.payload.event.attendees;
      if(!op.payload.invitationsConfirmed||!isBookingMessageRuntime()||!recipientsEqual(desired,effect.attendees)||!recipientsEqual(current.providerEventId?current.event.attendees:[],effect.previousAttendees))throw new BookingError("personal_calendar_invitation_changed",409);
      // Server-operated exact bindings; never copied from a request or widened
      // from the legacy workspace-primary account or the booking QA address.
      let bindings:unknown=[];
      const raw=process.env.PERSONAL_CALENDAR_INVITATION_BINDINGS_JSON??"[]";
      try{if(raw.length<=32768)bindings=JSON.parse(raw);}catch{ /* Fail closed. */ }
      const allowed=Array.isArray(bindings)&&bindings.length<=100?bindings.flatMap(b=>{
        if(!b||typeof b!=="object"||b.workspaceId!==fresh.workspaceId||b.userId!==fresh.userId||b.connectionId!==current.connectionId||b.accountId!==current.accountId||b.calendarId!==current.calendarId||b.connectionRevision!==current.connectionRevision||!Array.isArray(b.recipientEmails)||b.recipientEmails.length>10)return[];
        return b.recipientEmails.filter((e:unknown):e is string=>typeof e==="string"&&e.length<=254&&/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(e)).map((e:string)=>e.toLowerCase());
      }):[];
      if([...effect.attendees,...effect.previousAttendees].some(a=>!allowed.includes(a.email.toLowerCase())))throw new BookingError("personal_calendar_recipient_not_authorized",403);
      if(bookingRuntimeMode()==="production")await assertBookingActivation(scope(fresh),{provider:current.provider,connectionId:current.connectionId,accountId:current.accountId,calendarId:current.calendarId},{tx,capability:"messages"});
    }
    return write();
  },o);
}
async function provider(s:AppSession,row:Row,o:PersonalCalendarOptions,op?:Operation,lease?:string):Promise<BookingProvider> {
  runtime(o);
  await txRun(s,(tx,fresh)=>binding(tx,fresh,row),o);
  if(o.providerFactory)return o.providerFactory(scope(s),row.provider);
  return createBookingProvider(scope(s),row.provider,{pool:o.pool,statementTimeoutMs:o.statementTimeoutMs,
    beforeWrite:()=>txRun(s,async(tx,fresh)=>{const c=await read(tx,fresh,row.id);await binding(tx,fresh,c);},o),
    withStandaloneWrite:write=>{if(!op||!lease)throw new BookingError("personal_calendar_operation_required",409);return authorizedWrite(s,row.id,op,lease,o,write);},
    withStandaloneInvitationWrite:(effect,write)=>{if(!op||!lease||effect.bookingId!==row.id||effect.operationId!==op.id)throw new BookingError("personal_calendar_operation_required",409);return authorizedWrite(s,row.id,op,lease,o,write,effect);}});
}
export async function listPersonalCalendarEvents(s:AppSession,o:PersonalCalendarOptions={}):Promise<PersonalCalendarEvent[]> {
  return txRun(s,async(tx,fresh)=>(await tx.query<Row>(`select ${columns} from crm_personal_calendar_events where workspace_id=$1 and actor_id=$2 order by created_at desc limit 200`,[fresh.workspaceId,fresh.userId])).map(dto),o);
}
export async function mutatePersonalCalendar(s:AppSession,input:Record<string,unknown>,o:PersonalCalendarOptions={}):Promise<PersonalCalendarEvent> {
  const action=input.action;
  if(!["create","update","cancel","refresh","import_remote"].includes(String(action)))throw new BookingError("personal_calendar_invalid_action");
  const key=assertCrmUuid(input.idempotencyKey,"idempotencyKey");
  if(action==="refresh"||action==="import_remote")return refresh(s,input,o);
  const hash=crmPayloadDigest(input),lease=randomUUID();
  const existing=await txRun(s,async(tx,fresh)=>{
    const op=await tx.queryOne<Operation>(`select ${opColumns} from crm_personal_calendar_operations where workspace_id=$1 and actor_id=$2 and id=$3`,[fresh.workspaceId,fresh.userId,key]);
    if(!op)return null;if(op.requestHash!==hash)throw new BookingError("personal_calendar_idempotency_conflict",409);
    return{op,row:await read(tx,fresh,op.eventId)};
  },o);
  if(existing){
    if(existing.op.state==="succeeded"||existing.op.state==="rejected")return existing.op.result??dto(existing.row);
    try{
      return await refresh(s,{action:"refresh",eventId:existing.row.id,expectedVersion:existing.row.version,idempotencyKey:key},o);
    }catch(error){
      // The original operation may finish between these transactions. Its
      // stale replay version never proves that the provider write did not start.
      if(error instanceof BookingError&&error.code==="personal_calendar_version_conflict")throw new BookingError("personal_calendar_replay_changed",409);
      throw error;
    }
  }
  if(action==="cancel"){
    const discarded=await txRun(s,async(tx,fresh)=>{
      const r=await read(tx,fresh,assertCrmUuid(input.eventId,"eventId"));
      if(r.version!==assertExpectedVersion(input.expectedVersion))throw new BookingError("personal_calendar_version_conflict",409);
      if(r.state!=="failed"||r.providerEventId)return null;
      const previous=await tx.queryOne<{state:string}>(`select state from crm_personal_calendar_operations where workspace_id=$1 and actor_id=$2 and id=$3`,[fresh.workspaceId,fresh.userId,r.operationId]);
      if(previous?.state!=="rejected")throw new BookingError("personal_calendar_reconcile_required",409);
      const updated=(await tx.queryOne<Row>(`update crm_personal_calendar_events set state='cancelled',error_code=null,operation_id=$4,version=version+1 where workspace_id=$1 and actor_id=$2 and id=$3 returning ${columns}`,[fresh.workspaceId,fresh.userId,r.id,key]))!;
      await tx.execute(`insert into crm_personal_calendar_operations(id,workspace_id,actor_id,event_id,action,request_hash,payload,result,state) values($1,$2,$3,$4,'cancel',$5,$6::jsonb,$7::jsonb,'succeeded')`,[key,fresh.workspaceId,fresh.userId,r.id,hash,JSON.stringify({event:r.event,invitationsConfirmed:false}),JSON.stringify(dto(updated))]);
      await mirror(tx,fresh,updated);await audit(tx,fresh,updated,"personal_calendar.local_discarded");return dto(updated);
    },o);
    if(discarded)return discarded;
  }
  runtime(o);
  const proposed=action==="cancel"?null:draft(input.event);
  const providerName=input.provider;
  if(action==="create"&&providerName!=="microsoft"&&providerName!=="google")throw new BookingError("personal_calendar_invalid_provider");
  // Establish fresh authority before loading any credentials/provider metadata.
  await txRun(s,async(tx,fresh)=>{if(proposed?.projectId)await assertProjectGrant(tx,fresh,proposed.projectId,true);},o);
  const selected=action==="create"?await(o.connectionResolver?o.connectionResolver(scope(s),providerName as BookingProviderName):getBookingCalendarAccess(scope(s),providerName as BookingProviderName)):null;
  const staged=await txRun(s,async(tx,fresh)=>{
    if(await tx.queryOne(`select id from crm_personal_calendar_operations where workspace_id=$1 and actor_id=$2 and id=$3`,[fresh.workspaceId,fresh.userId,key]))return null;
    let row:Row;
    if(action==="create"){
      const blocked=await tx.queryOne(`select id from crm_personal_calendar_events where workspace_id=$1 and actor_id=$2 and state in ('processing','uncertain') limit 1`,[fresh.workspaceId,fresh.userId]);
      if(blocked)throw new BookingError("personal_calendar_unresolved_operation",409);
      if(!selected?.accountId)throw new BookingError("personal_calendar_account_unverified",409);
      const id=randomUUID();
      await tx.execute(`insert into calendar_events(id,workspace_id,project_id,owner_user_id,title,starts_at,ends_at,location,status,metadata) values($1,$2,$3,$4,$5,$6::timestamptz,$7::timestamptz,$8,'angefragt',jsonb_build_object('source','personal_standalone_calendar','personalCalendarState','processing','externalCommunication',false))`,[id,fresh.workspaceId,proposed!.projectId,fresh.userId,proposed!.title,proposed!.startsAt,proposed!.endsAt,proposed!.location]);
      row=(await tx.queryOne<Row>(`insert into crm_personal_calendar_events(id,workspace_id,actor_id,project_id,provider,connection_id,connection_revision,account_id,calendar_id,event,state,operation_id) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,'processing',$11) returning ${columns}`,[id,fresh.workspaceId,fresh.userId,proposed!.projectId,providerName,selected.connectionId,selected.revision,selected.accountId,selected.calendarId,JSON.stringify(proposed),key]))!;
    }else{
      row=await read(tx,fresh,assertCrmUuid(input.eventId,"eventId"));
      if(row.version!==assertExpectedVersion(input.expectedVersion))throw new BookingError("personal_calendar_version_conflict",409);
      if(row.state!=="synced")throw new BookingError("personal_calendar_reconcile_required",409);
      if(proposed&&proposed.projectId!==row.event.projectId)throw new BookingError("personal_calendar_project_immutable",409);
      row=(await tx.queryOne<Row>(`update crm_personal_calendar_events set state='processing',operation_id=$4,version=version+1,error_code=null,updated_at=now() where workspace_id=$1 and actor_id=$2 and id=$3 returning ${columns}`,[fresh.workspaceId,fresh.userId,row.id,key]))!;
    }
    await binding(tx,fresh,row);
    const payload={event:proposed??row.event,invitationsConfirmed:input.invitationsConfirmed===true};
    const op=(await tx.queryOne<Operation>(`insert into crm_personal_calendar_operations(id,workspace_id,actor_id,event_id,action,request_hash,payload,state,lease_owner,lease_until) values($1,$2,$3,$4,$5,$6,$7::jsonb,'processing',$8,to_timestamp($9::double precision/1000)) returning ${opColumns}`,[key,fresh.workspaceId,fresh.userId,row.id,action,hash,JSON.stringify(payload),lease,clock(o)+60_000]))!;
    await mirror(tx,fresh,row);await audit(tx,fresh,row,"personal_calendar.requested");return{row,op};
  },o);
  if(!staged)return mutatePersonalCalendar(s,input,o);
  const {row,op}=staged;
  let attempted=false;
  try{
    const port=await provider(s,row,o,op,lease);
    const p=op.payload.event;
    // Even injected offline transports must pass the same fresh journal/recipient boundary.
    await authorizedWrite(s,row.id,op,lease,o,async()=>new Response(null,{status:204}),p.attendees.length||row.event.attendees.length?{attendees:action==="cancel"?[]:p.attendees,previousAttendees:action==="create"?[]:row.event.attendees}:undefined);
    const write={bookingId:row.id,operationId:op.id,title:p.title,startsAt:p.startsAt,endsAt:p.endsAt,timeZone:p.timeZone,location:p.location,kind:"office" as const,standaloneAttendees:p.attendees};
    attempted=true;
    if(action==="cancel")await port.delete({bookingId:row.id,operationId:op.id,eventId:row.providerEventId!,etag:row.providerEtag,standaloneAttendees:[]});
    else if(action==="create")await port.create(write);
    else await port.update({...write,eventId:row.providerEventId!,etag:row.providerEtag});
    const remote=await port.lookup({bookingId:row.id,operationId:op.id,...(row.providerEventId?{eventId:row.providerEventId}:{})});
    if(!remote||action==="cancel"&&!remote.cancelled)throw new BookingProviderError("personal_calendar_outcome_unknown","unknown");
    return await finish(s,row,op,lease,remote,o);
  }catch(error){
    const unknown=error instanceof BookingProviderError?error.outcome==="unknown":attempted;
    const code=error instanceof BookingError?error.code:"personal_calendar_outcome_unknown";
    return txRun(s,async(tx,fresh)=>{
      const current=await read(tx,fresh,row.id);
      const claimed=await tx.queryOne(`update crm_personal_calendar_operations set state=$5,error_code=$6,lease_owner=null,lease_until=null,updated_at=now() where workspace_id=$1 and actor_id=$2 and id=$3 and lease_owner=$4 and state='processing' returning id`,[fresh.workspaceId,fresh.userId,op.id,lease,unknown?"uncertain":"rejected",code]);
      if(claimed&&current.operationId===op.id){const updated=(await tx.queryOne<Row>(`update crm_personal_calendar_events set state=$4,error_code=$5,version=version+1,updated_at=now() where workspace_id=$1 and actor_id=$2 and id=$3 returning ${columns}`,[fresh.workspaceId,fresh.userId,row.id,unknown?"uncertain":"failed",code]))!;if(!unknown)await tx.execute(`update crm_personal_calendar_operations set result=$4::jsonb where workspace_id=$1 and actor_id=$2 and id=$3`,[fresh.workspaceId,fresh.userId,op.id,JSON.stringify(dto(updated))]);await mirror(tx,fresh,updated);await audit(tx,fresh,updated,"personal_calendar.unconfirmed");return dto(updated);}return dto(current);
    },o);
  }
}
async function finish(s:AppSession,row:Row,op:Operation,lease:string,remote:ProviderEvent,o:PersonalCalendarOptions) {
  return txRun(s,async(tx,fresh)=>{
    const current=await read(tx,fresh,row.id);await binding(tx,fresh,current);
    const snap=snapshot(remote,row,o),expected=op.payload.event;
    const matches=op.action==="cancel"?remote.cancelled:!remote.cancelled&&!!remote.etag&&snap.title===expected.title&&snap.location===expected.location&&Date.parse(snap.startsAt)===Date.parse(expected.startsAt)&&Date.parse(snap.endsAt)===Date.parse(expected.endsAt)&&recipientsEqual(snap.attendees,expected.attendees)&&remote.content?.operationId===op.id;
    const claimed=await tx.queryOne(`update crm_personal_calendar_operations set state=$5,lease_owner=null,lease_until=null,updated_at=now() where workspace_id=$1 and actor_id=$2 and id=$3 and lease_owner=$4 and state='processing' and lease_until>to_timestamp($6::double precision/1000) returning id`,[fresh.workspaceId,fresh.userId,op.id,lease,matches?"succeeded":"uncertain",clock(o)]);
    if(!claimed||current.operationId!==op.id)return dto(current);
    const observedOperation=op.action==="cancel"?remote.cancelled:remote.content?.operationId===op.id;
    const updated=(await tx.queryOne<Row>(`update crm_personal_calendar_events set state=$4,event=$5::jsonb,provider_event_id=$6,provider_etag=$7,remote_snapshot=$8::jsonb,error_code=$9,version=version+1,updated_at=now() where workspace_id=$1 and actor_id=$2 and id=$3 returning ${columns}`,[fresh.workspaceId,fresh.userId,row.id,matches?(remote.cancelled?"cancelled":"synced"):observedOperation?"conflict":"uncertain",JSON.stringify(matches?expected:current.event),remote.eventId,remote.etag,JSON.stringify(snap),matches?null:observedOperation?"personal_calendar_remote_changed":"personal_calendar_outcome_unknown"]))!;
    if(matches)await tx.execute(`update crm_personal_calendar_operations set result=$4::jsonb where workspace_id=$1 and actor_id=$2 and id=$3`,[fresh.workspaceId,fresh.userId,op.id,JSON.stringify(dto(updated))]);
    await mirror(tx,fresh,updated);await audit(tx,fresh,updated,"personal_calendar.readback");return dto(updated);
  },o);
}
async function refresh(s:AppSession,input:Record<string,unknown>,o:PersonalCalendarOptions) {
  const id=assertCrmUuid(input.eventId,"eventId");
  if(input.action==="import_remote"){
    const replay=await txRun(s,async(tx,fresh)=>{const op=await tx.queryOne<Operation>(`select ${opColumns} from crm_personal_calendar_operations where workspace_id=$1 and actor_id=$2 and id=$3`,[fresh.workspaceId,fresh.userId,input.idempotencyKey]);if(!op)return null;if(op.action!=="import_remote"||op.eventId!==id||op.requestHash!==crmPayloadDigest(input))throw new BookingError("personal_calendar_idempotency_conflict",409);const row=await read(tx,fresh,id);return op.result??dto(row);},o);
    if(replay)return replay;
  }
  const row=await txRun(s,async(tx,fresh)=>{const r=await read(tx,fresh,id);if(r.version!==assertExpectedVersion(input.expectedVersion))throw new BookingError("personal_calendar_version_conflict",409);await binding(tx,fresh,r);return r;},o);
  if(input.action==="import_remote")return txRun(s,async(tx,fresh)=>{
    const previous=await tx.queryOne<Operation>(`select ${opColumns} from crm_personal_calendar_operations where workspace_id=$1 and actor_id=$2 and id=$3`,[fresh.workspaceId,fresh.userId,input.idempotencyKey]);
    if(previous){if(previous.action!=="import_remote"||previous.eventId!==id||previous.requestHash!==crmPayloadDigest(input))throw new BookingError("personal_calendar_idempotency_conflict",409);return previous.result??dto(await read(tx,fresh,id));}
    const r=await read(tx,fresh,id);await binding(tx,fresh,r);
    if(r.version!==input.expectedVersion||r.state!=="conflict"||!r.remoteSnapshot||(!r.remoteSnapshot.cancelled&&!r.remoteSnapshot.etag)||r.remoteSnapshot.etag!==input.remoteEtag)throw new BookingError("personal_calendar_snapshot_changed",409);
    const event=r.remoteSnapshot.cancelled?r.event:draft({projectId:r.event.projectId,title:r.remoteSnapshot.title,startsAt:r.remoteSnapshot.startsAt,endsAt:r.remoteSnapshot.endsAt,timeZone:r.event.timeZone,location:r.remoteSnapshot.location,attendees:r.remoteSnapshot.attendees});
    const updated=(await tx.queryOne<Row>(`update crm_personal_calendar_events set event=$4::jsonb,state=$6,provider_etag=$5,error_code=null,version=version+1,updated_at=now() where workspace_id=$1 and actor_id=$2 and id=$3 returning ${columns}`,[fresh.workspaceId,fresh.userId,id,JSON.stringify(event),r.remoteSnapshot.etag,r.remoteSnapshot.cancelled?"cancelled":"synced"]))!;
    await tx.execute(`insert into crm_personal_calendar_operations(id,workspace_id,actor_id,event_id,action,request_hash,payload,result,state) values($1,$2,$3,$4,'import_remote',$5,$6::jsonb,$7::jsonb,'succeeded')`,[input.idempotencyKey,fresh.workspaceId,fresh.userId,id,crmPayloadDigest(input),JSON.stringify({event,invitationsConfirmed:false}),JSON.stringify(dto(updated))]);
    await mirror(tx,fresh,updated);await audit(tx,fresh,updated,"personal_calendar.remote_imported");return dto(updated);
  },o);
  runtime(o);
  let op:Operation|null=null,lease:string|undefined;
  if(["processing","uncertain"].includes(row.state)&&row.operationId){
    lease=randomUUID();
    op=await txRun(s,(tx,fresh)=>tx.queryOne<Operation>(`update crm_personal_calendar_operations set state='processing',lease_owner=$4,lease_until=to_timestamp($5::double precision/1000) where workspace_id=$1 and actor_id=$2 and id=$3 and state in ('processing','uncertain') and (lease_owner is null or lease_until<=to_timestamp($6::double precision/1000)) returning ${opColumns}`,[fresh.workspaceId,fresh.userId,row.operationId,lease,clock(o)+60_000,clock(o)]),o);
    if(!op)return dto(row);
  }
  const port=await provider(s,row,o),remote=await port.lookup({bookingId:row.id,operationId:row.operationId??row.id,...(row.providerEventId?{eventId:row.providerEventId}:{})});
  if(op&&lease){if(remote)return finish(s,row,op,lease,remote,o);return txRun(s,async(tx,fresh)=>{const claimed=await tx.queryOne(`update crm_personal_calendar_operations set state='uncertain',lease_owner=null,lease_until=null where workspace_id=$1 and actor_id=$2 and id=$3 and lease_owner=$4 and lease_until>to_timestamp($5::double precision/1000) returning id`,[fresh.workspaceId,fresh.userId,op!.id,lease,clock(o)]);if(!claimed)return dto(await read(tx,fresh,id));const r=(await tx.queryOne<Row>(`update crm_personal_calendar_events set state='uncertain',error_code='personal_calendar_outcome_unknown',version=version+1 where workspace_id=$1 and actor_id=$2 and id=$3 returning ${columns}`,[fresh.workspaceId,fresh.userId,id]))!;await mirror(tx,fresh,r);return dto(r);},o);}
  if(!remote)throw new BookingError("personal_calendar_remote_missing",409);
  const snap=snapshot(remote,row,o);
  return txRun(s,async(tx,fresh)=>{const current=await read(tx,fresh,id);await binding(tx,fresh,current);if(current.version!==row.version)throw new BookingError("personal_calendar_version_conflict",409);
    const changed=remote.cancelled?row.state!=="cancelled":remote.etag!==row.providerEtag;
    const updated=(await tx.queryOne<Row>(`update crm_personal_calendar_events set remote_snapshot=$4::jsonb,state=$5,error_code=$6,version=version+1,updated_at=now() where workspace_id=$1 and actor_id=$2 and id=$3 returning ${columns}`,[fresh.workspaceId,fresh.userId,id,JSON.stringify(snap),changed?"conflict":remote.cancelled?"cancelled":"synced",changed?"personal_calendar_remote_changed":null]))!;await mirror(tx,fresh,updated);await audit(tx,fresh,updated,"personal_calendar.remote_checked");return dto(updated);
  },o);
}
