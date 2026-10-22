import "server-only";
import { randomUUID } from "node:crypto";
import type { AppSession } from "@/lib/auth/session";
import { assertCrmUuid, crmPayloadDigest, type TenantTransactionOptions, type TenantTransaction } from "@/lib/crm-command";
import type { TenantScope } from "@/lib/db/tenant-client";
import { getBookingCalendarAccess } from "./connections";
import { BookingProviderError, createBookingProvider } from "./providers";
import { BookingError, type BookingKind, type BookingProvider, type BookingProviderFactory, type BookingProviderName, type BookingRecord, type BookingRules, type ProviderEvent, type ProviderWrite } from "./types";
import { bookingWindow, enumerateSlots, isSlotAllowed, localParts, overlaps, validateBookingRules, validInstant } from "./rules";
import { bookingAudit, bookingColumns, bookingResourceLock, expireBookingHolds, internalBusy, readBooking, readRules, readTravelBookings, withBookingTransaction } from "./repository";
import { readBookingSetup } from "./configuration";
import { createGoogleMapsRouter } from "./maps";
import { createBookingTravelChecker, travelAppointments, TravelCheckError, type DrivingRouter, type TravelProof } from "./travel";
import { normalizeBookingRecipient, syncBookingMessages } from "./messages";
import { resolveBookingPropertyLocation } from "./property-locations";
export type BookingServiceOptions = TenantTransactionOptions & {
  providerFactory?: BookingProviderFactory; now?:()=>number;
  connectionResolver?:(scope:TenantScope,provider:BookingProviderName)=>Promise<{connectionId:string;calendarId:string;revision:number}>;
  drivingRouter?:DrivingRouter;
};
const clock=(options:BookingServiceOptions)=>options.now?.()??Date.now();
const scope=(session:AppSession)=>({workspaceId:session.workspaceId,actorId:session.userId});
const kinds:BookingKind[]=["phone","teams","meet","office","onsite"];
function validateChoice(provider:BookingProviderName,kind:BookingKind) {
  if(!["microsoft","google"].includes(provider)||!kinds.includes(kind)||(kind==="teams"&&provider!=="microsoft")||(kind==="meet"&&provider!=="google"))throw new BookingError("INVALID_BOOKING_TYPE");
}
function sameSnapshot(current:BookingRecord,snapshot:BookingRecord) { return current.operationId===snapshot.operationId&&current.revision===snapshot.revision&&current.state===snapshot.state; }
function title(value:string) { if(typeof value!=="string"||value.trim().length<1||value.length>200)throw new BookingError("INVALID_TITLE");return value.trim(); }
function assertRuntime(options:BookingServiceOptions) {
  if(process.env.VERCEL_ENV==="production"||process.env.NODE_ENV==="production"&&process.env.VERCEL_ENV!=="preview")throw new BookingError("BOOKING_PREVIEW_ONLY",403);
  if(process.env.BOOKING_ENGINE_ENABLED!=="1" && !(process.env.NODE_ENV==="test"&&options.providerFactory))throw new BookingError("BOOKING_NOT_ENABLED",403);
}
async function connection(session:AppSession,provider:BookingProviderName,options:BookingServiceOptions) {
  assertRuntime(options);
  if(options.connectionResolver)return options.connectionResolver(scope(session),provider);
  return getBookingCalendarAccess(scope(session),provider);
}
async function adapter(session:AppSession,provider:BookingProviderName,options:BookingServiceOptions) {
  assertRuntime(options);return (options.providerFactory??createBookingProvider)(scope(session),provider);
}
async function verifyConnection(tx:TenantTransaction,session:AppSession,c:{connectionId:string;calendarId:string;revision:number}) {
  const current=await tx.queryOne<{ok:boolean}>(`select status='connected' and revision=$4 and write_calendar_id=$5 as ok from booking_calendar_connections where id=$1::uuid and workspace_id=$2::uuid and user_id=$3::uuid for share`,[c.connectionId,session.workspaceId,session.userId,c.revision,c.calendarId]);
  if(!current?.ok)throw new BookingProviderError("connection_changed","rejected");
}
async function verifyCurrentBinding(session:AppSession,row:BookingRecord,options:BookingServiceOptions) {
  return withBookingTransaction(session,async(tx,fresh)=>{
    await verifyConnection(tx,fresh,{connectionId:row.connectionId,calendarId:row.calendarId,revision:row.connectionRevision});
    const rules=row.operationTarget?.rules??row.rules;
    if(row.operationKind!=="cancel"&&rules.propertyId) {
      const property=await resolveBookingPropertyLocation(tx,fresh,rules.propertyId);
      if(property.address!==rules.location)throw new BookingProviderError("PROPERTY_LOCATION_CHANGED","rejected");
    }
  },options);
}
function assertKindCapability(c:Awaited<ReturnType<typeof connection>>,kind:BookingKind) {
  if("calendar" in c) {
    const calendar=c.calendar as {teamsSupported:boolean;meetSupported:boolean};
    if(kind==="teams"&&!calendar.teamsSupported||kind==="meet"&&!calendar.meetSupported)throw new BookingError("VIDEO_UNSUPPORTED",409);
  }
}
function matchingConnection(row:BookingRecord,c:{connectionId:string;calendarId:string;revision:number}) {
  if(row.connectionId!==c.connectionId||row.calendarId!==c.calendarId||row.connectionRevision!==c.revision)throw new BookingError("CONNECTION_CHANGED",409);
}
export type BookingLocationInput={location?:string;locationConfirmed?:boolean;propertyId?:string|null};
function candidateRules(rules:BookingRules,input:BookingLocationInput):BookingRules {
  if(input.location!==undefined&&(typeof input.location!=="string"||input.location.length>500||/[\u0000-\u001f\u007f]/.test(input.location)))throw new BookingError("INVALID_LOCATION");
  if(input.locationConfirmed!==undefined&&typeof input.locationConfirmed!=="boolean")throw new BookingError("INVALID_LOCATION");
  if(input.propertyId!==undefined&&input.propertyId!==null)assertCrmUuid(input.propertyId,"propertyId");
  return {...rules,...(input.location!==undefined?{location:input.location.trim(),locationConfirmed:input.locationConfirmed===true}:input.locationConfirmed!==undefined?{locationConfirmed:input.locationConfirmed}:{}),...(input.propertyId!==undefined?{propertyId:input.propertyId}:{})};
}
async function effectiveRules(tx:TenantTransaction,session:AppSession,kind:BookingKind,input:BookingLocationInput={}):Promise<BookingRules> {
  const setup=await readBookingSetup(tx,session,kind);
  const rules=candidateRules({...setup.rules,...(setup.travel.enabled?{travel:{...setup.travel,policy:"google_maps" as const,required:true}}:{})},input);
  if(rules.propertyId) {
    if(kind!=="onsite")throw new BookingError("INVALID_PROPERTY");
    const property=await resolveBookingPropertyLocation(tx,session,rules.propertyId);
    rules.location=property.address;
  }
  return rules;
}
const hasTravel=(rules:BookingRules)=>rules.travel.policy==="google_maps"&&rules.travel.enabled;
function onsiteLocationReady(kind:BookingKind,rules:BookingRules) {
  return kind!=="onsite"||!!rules.location.trim()&&(rules.locationConfirmed===true||rules.travel.policy==="google_maps"&&rules.travel.locations.some(location=>location.confirmed&&location.address.trim()===rules.location.trim()));
}
const travelDigest=(rows:BookingRecord[])=>crmPayloadDigest(rows.map(row=>[row.id,row.revision,row.startsAt,row.endsAt,row.blockedStartsAt,row.blockedEndsAt,row.rules]));
function externalWindow(startsAt:string,rules:BookingRules,excludeEventId?:string) {
  const window=bookingWindow(startsAt,rules);
  return hasTravel(rules)?{startsAt:new Date(Date.parse(startsAt)-36*3_600_000).toISOString(),endsAt:new Date(Date.parse(window.endsAt)+36*3_600_000).toISOString(),excludeEventId,includeLocations:true}:{startsAt:window.blockedStartsAt,endsAt:window.blockedEndsAt,excludeEventId};
}
function travelFailure(error:unknown):never {throw error instanceof TravelCheckError?new BookingError(error.code,409):error;}
async function evaluateTravel(session:AppSession,kind:BookingKind,startsAt:string,rules:BookingRules,provider:BookingProvider,options:BookingServiceOptions,exclude?:BookingRecord,providedExternal?:Awaited<ReturnType<BookingProvider["listBusy"]>>) {
  const bookings=hasTravel(rules)?await withBookingTransaction(session,(tx,fresh)=>readTravelBookings(tx,fresh,exclude?.id??null),options):[];
  const external=providedExternal??await provider.listBusy(externalWindow(startsAt,rules,exclude?.providerEventId??undefined));
  if(!isSlotAllowed(startsAt,rules,[...external,...bookings.map(row=>({startsAt:row.blockedStartsAt,endsAt:row.blockedEndsAt}))],clock(options)))throw new BookingError("SLOT_UNAVAILABLE",409);
  const checker=createBookingTravelChecker(options.drivingRouter??createGoogleMapsRouter({now:()=>clock(options)}),clock(options));
  try{await checker({startsAt,kind,rules,appointments:rules.travel.policy==="google_maps"?travelAppointments(bookings,external,rules.travel):[]});}catch(error){travelFailure(error);}
  return {external,bookings,digest:travelDigest(bookings)};
}
async function verifyTravelContext(tx:TenantTransaction,session:AppSession,rules:BookingRules,digest:string,excludeId:string|null=null) {
  if(hasTravel(rules)&&travelDigest(await readTravelBookings(tx,session,excludeId))!==digest)throw new BookingError("TRAVEL_CONTEXT_CHANGED",409);
}
export async function getBookingSettings(session:AppSession,options:BookingServiceOptions={}) {
  return withBookingTransaction(session,async(tx,fresh)=>({defaults:await readRules(tx,fresh,"*",true),employeeDefaults:await readRules(tx,fresh,"*"),overrides:await tx.query<{kind:string;rules:Partial<BookingRules>;userId:string|null;revision:number}>(`select kind,rules,user_id as "userId",revision::int from booking_rule_sets where workspace_id=$1::uuid and (user_id is null or user_id=$2::uuid)`,[fresh.workspaceId,fresh.userId])}),options);
}
export async function saveBookingRules(session:AppSession,input:{kind?:BookingKind|null;rules:Partial<BookingRules>;workspaceDefault?:boolean},options:BookingServiceOptions={}) {
  if(input.kind!==undefined&&input.kind!==null&&!kinds.includes(input.kind))throw new BookingError("INVALID_BOOKING_TYPE");
  const rules=validateBookingRules(input.rules);
  return withBookingTransaction(session,async(tx,fresh)=>{
    if(input.workspaceDefault&&!fresh.productPermissions.includes("workspace:admin"))throw new BookingError("BOOKING_FORBIDDEN",403);
    if(input.workspaceDefault)await tx.query(`select pg_advisory_xact_lock(hashtextextended($1,0))`,[`booking-workspace:${fresh.workspaceId}`]);
    await bookingResourceLock(tx,fresh);
    const row=await tx.queryOne<{id:string}>(`insert into booking_rule_sets(workspace_id,user_id,kind,rules) values($1::uuid,$2::uuid,$3,$4::jsonb) on conflict(workspace_id,user_id,kind) do update set rules=booking_rule_sets.rules||excluded.rules,revision=booking_rule_sets.revision+1,updated_at=now() returning id`,[fresh.workspaceId,input.workspaceDefault?null:fresh.userId,input.kind??"*",JSON.stringify(rules)]);
    await bookingAudit(tx,fresh,"booking.rules_updated",row!.id,{kind:input.kind??"*",workspaceDefault:!!input.workspaceDefault});
    return {rules:await readRules(tx,fresh,input.kind??"phone")};
  },options);
}
export async function getBookingAvailability(session:AppSession,input:{provider:BookingProviderName;kind:BookingKind;date:string;excludeBookingId?:string}&BookingLocationInput,options:BookingServiceOptions={}) {
  validateChoice(input.provider,input.kind);
  // Authorization is checked before credentials or provider transport.
  if(input.excludeBookingId)assertCrmUuid(input.excludeBookingId);
  const local=await withBookingTransaction(session,async(tx,fresh)=>{
    await bookingResourceLock(tx,fresh);await expireBookingHolds(tx,fresh,clock(options));
    const excluded=input.excludeBookingId?await readBooking(tx,fresh,input.excludeBookingId):null;
    if(excluded&&(excluded.provider!==input.provider||excluded.kind!==input.kind||excluded.state!=="confirmed"))throw new BookingError("BOOKING_NOT_CONFIRMED",409);
    const rules=await effectiveRules(tx,fresh,input.kind,input);return {rules,excluded,busy:await internalBusy(tx,fresh,input.excludeBookingId??null),bookings:hasTravel(rules)?await readTravelBookings(tx,fresh,input.excludeBookingId??null):[]};
  },options);
  if(!onsiteLocationReady(input.kind,local.rules))return {slots:[],rules:local.rules,travelUnavailable:true,travelIssues:["ADDRESS_CONFIRMATION_REQUIRED"],requestFallback:true};
  const middle=Date.parse(`${input.date}T00:00:00Z`);if(!Number.isFinite(middle))throw new BookingError("INVALID_DATE");
  const access=await connection(session,input.provider,options);assertKindCapability(access,input.kind);
  const provider=await adapter(session,input.provider,options);
  const busy=await provider.listBusy({startsAt:new Date(middle-2*86_400_000).toISOString(),endsAt:new Date(middle+3*86_400_000).toISOString(),includeLocations:hasTravel(local.rules),excludeEventId:local.excluded?.providerEventId??undefined});
  let slots:Array<{startsAt:string;endsAt:string;travel?:TravelProof}>=enumerateSlots(input.date,local.rules,[...local.busy,...busy],clock(options));
  if(local.rules.maxPerDay!==null){const count=await withBookingTransaction(session,async(tx,fresh)=>tx.queryOne<{count:number}>(`select count(*)::int as count from booking_reservations where workspace_id=$1::uuid and organizer_id=$2::uuid and state in ('held','processing','confirmed','uncertain','conflict') and (state<>'conflict' or provider_event_id is not null) and (starts_at at time zone $3)::date=$4::date and ($5::uuid is null or id<>$5::uuid)`,[fresh.workspaceId,fresh.userId,local.rules.timeZone,input.date,input.excludeBookingId??null]),options);if((count?.count??0)>=local.rules.maxPerDay)slots=[];}
  const travelIssues=new Set<string>();
  if(hasTravel(local.rules)||input.kind==="onsite"&&local.rules.travel.required) {
    const checker=createBookingTravelChecker(options.drivingRouter??createGoogleMapsRouter({now:()=>clock(options)}),clock(options));
    const appointments=local.rules.travel.policy==="google_maps"?travelAppointments(local.bookings,busy,local.rules.travel):[];
    const checked:typeof slots=[];
    for(const slot of slots)try{const proof=await checker({startsAt:slot.startsAt,kind:input.kind,rules:local.rules,appointments});checked.push({...slot,...(proof?{travel:proof}:{})});}catch(error){travelIssues.add(error instanceof TravelCheckError?error.code:"MAPS_UNAVAILABLE");}
    slots=checked;
  }
  return {slots,rules:local.rules,travelUnavailable:travelIssues.size>0,travelIssues:[...travelIssues],requestFallback:travelIssues.size>0};
}
export async function createBookingHold(session:AppSession,input:{provider:BookingProviderName;kind:BookingKind;startsAt:string;title:string;idempotencyKey:string;recipientEmail?:string;recipientName?:string;communicationLanguage?:"de"|"en"}&BookingLocationInput,options:BookingServiceOptions={}) {
  validateChoice(input.provider,input.kind);assertCrmUuid(input.idempotencyKey,"idempotencyKey");const heading=title(input.title),requestHash=crmPayloadDigest({...input,title:heading});
  const recipient=normalizeBookingRecipient(input);
  // Replays are served even if the provider connection was subsequently revoked.
  const existing=await withBookingTransaction(session,(tx,fresh)=>tx.queryOne<BookingRecord>(`select ${bookingColumns} from booking_reservations where workspace_id=$1::uuid and organizer_id=$2::uuid and idempotency_key=$3::uuid`,[fresh.workspaceId,fresh.userId,input.idempotencyKey]),options);
  if(existing){if(existing.requestHash!==requestHash)throw new BookingError("IDEMPOTENCY_CONFLICT",409);return existing;}
  const c=await connection(session,input.provider,options);assertKindCapability(c,input.kind);const provider=await adapter(session,input.provider,options);
  const rules=await withBookingTransaction(session,(tx,fresh)=>effectiveRules(tx,fresh,input.kind,input),options),window=bookingWindow(input.startsAt,rules);
  if(!onsiteLocationReady(input.kind,rules))throw new BookingError("ADDRESS_CONFIRMATION_REQUIRED",409);
  const evaluation=await evaluateTravel(session,input.kind,input.startsAt,rules,provider,options),external=evaluation.external;
  return withBookingTransaction(session,async(tx,fresh)=>{
    await bookingResourceLock(tx,fresh);await expireBookingHolds(tx,fresh,clock(options));
    const replay=await tx.queryOne<BookingRecord>(`select ${bookingColumns} from booking_reservations where workspace_id=$1::uuid and organizer_id=$2::uuid and idempotency_key=$3::uuid`,[fresh.workspaceId,fresh.userId,input.idempotencyKey]);
    if(replay){if(replay.requestHash!==requestHash)throw new BookingError("IDEMPOTENCY_CONFLICT",409);return replay;}
    await verifyConnection(tx,fresh,c);
    const currentRules=await effectiveRules(tx,fresh,input.kind,input);if(crmPayloadDigest(rules)!==crmPayloadDigest(currentRules))throw new BookingError("RULES_CHANGED",409);
    await verifyTravelContext(tx,fresh,rules,evaluation.digest);
    if(!isSlotAllowed(window.startsAt,rules,[...await internalBusy(tx,fresh),...external],clock(options)))throw new BookingError("SLOT_UNAVAILABLE",409);
    if(rules.maxPerDay!==null){const count=await tx.queryOne<{count:number}>(`select count(*)::int as count from booking_reservations where workspace_id=$1::uuid and organizer_id=$2::uuid and state in ('held','processing','confirmed','uncertain','conflict') and (state<>'conflict' or provider_event_id is not null) and (starts_at at time zone $3)::date=$4::date`,[fresh.workspaceId,fresh.userId,rules.timeZone,localParts(Date.parse(window.startsAt),rules.timeZone).date]);if((count?.count??0)>=rules.maxPerDay)throw new BookingError("DAILY_LIMIT",409);}
    const id=randomUUID();await tx.execute(`insert into booking_reservations(id,workspace_id,organizer_id,provider,kind,connection_id,connection_revision,calendar_id,title,starts_at,ends_at,blocked_starts_at,blocked_ends_at,state,expires_at,rules,request_hash,idempotency_key,recipient_email,recipient_name,communication_language) values($1::uuid,$2::uuid,$3::uuid,$4,$5,$6::uuid,$7,$8,$9,$10::timestamptz,$11::timestamptz,$12::timestamptz,$13::timestamptz,'held',to_timestamp($14::double precision/1000),$15::jsonb,$16,$17::uuid,$18,$19,$20)`,[id,fresh.workspaceId,fresh.userId,input.provider,input.kind,c.connectionId,c.revision,c.calendarId,heading,window.startsAt,window.endsAt,window.blockedStartsAt,window.blockedEndsAt,clock(options)+5*60_000,JSON.stringify(rules),requestHash,input.idempotencyKey,recipient.recipientEmail,recipient.recipientName,recipient.communicationLanguage]);
    await bookingAudit(tx,fresh,"booking.held",id,{provider:input.provider});return readBooking(tx,fresh,id);
  },options);
}
async function finish(session:AppSession,row:BookingRecord,event:ProviderEvent|null,options:BookingServiceOptions,cancelled=false) {
  return withBookingTransaction(session,async(tx,fresh)=>{
    await bookingResourceLock(tx,fresh);const current=await readBooking(tx,fresh,row.id);
    if(!sameSnapshot(current,row))return current;
    const finalRules=row.operationTarget?.rules??row.rules;
    const target=cancelled?null:event?{startsAt:event.startsAt,endsAt:event.endsAt,blockedStartsAt:new Date(Date.parse(event.startsAt)-finalRules.preparationMinutes*60_000).toISOString(),blockedEndsAt:new Date(Date.parse(event.endsAt)+finalRules.followupMinutes*60_000).toISOString()}:row.operationTarget;
    const conflict=!cancelled&&target?(await internalBusy(tx,fresh,row.id)).some(x=>overlaps(x,{startsAt:target.blockedStartsAt,endsAt:target.blockedEndsAt})):false;
    await tx.execute(`update booking_reservations set state=$3,provider_event_id=coalesce($4,provider_event_id),provider_etag=$5,video_url=$6,video_status=$7,starts_at=coalesce($8::timestamptz,starts_at),ends_at=coalesce($9::timestamptz,ends_at),blocked_starts_at=coalesce($10::timestamptz,blocked_starts_at),blocked_ends_at=coalesce($11::timestamptz,blocked_ends_at),rules=$12::jsonb,operation_target=null,revision=revision+1,updated_at=now() where id=$1::uuid and workspace_id=$2::uuid`,[row.id,fresh.workspaceId,cancelled?"cancelled":conflict?"conflict":"confirmed",event?.eventId??null,event?.etag??null,event?.onlineMeetingUrl??null,event?.videoStatus??"none",target?.startsAt??null,target?.endsAt??null,target?.blockedStartsAt??null,target?.blockedEndsAt??null,JSON.stringify(finalRules)]);
    if(row.operationId)await tx.execute(`update booking_operations set state='succeeded',updated_at=now() where id=$1::uuid and workspace_id=$2::uuid and state<>'rejected'`,[row.operationId,fresh.workspaceId]);
    await tx.query(`select booking_sync_crm($1::uuid)`,[row.id]);
    const after=await readBooking(tx,fresh,row.id);await syncBookingMessages(tx,fresh,current,after,clock(options));
    await bookingAudit(tx,fresh,cancelled?"booking.cancelled":"booking.confirmed",row.id,{operationId:row.operationId,videoStatus:event?.videoStatus??"none"});return readBooking(tx,fresh,row.id);
  },options);
}
async function uncertain(session:AppSession,row:BookingRecord,options:BookingServiceOptions) {
  return withBookingTransaction(session,async(tx,fresh)=>{
    await bookingResourceLock(tx,fresh);const current=await readBooking(tx,fresh,row.id);if(!sameSnapshot(current,row))return current;
    await tx.execute(`update booking_reservations set state='uncertain',revision=revision+1,updated_at=now() where id=$1::uuid and workspace_id=$2::uuid and operation_id=$3::uuid`,[row.id,fresh.workspaceId,row.operationId]);
    await tx.execute(`update booking_operations set state='uncertain',error_code='PROVIDER_OUTCOME_UNKNOWN',updated_at=now() where id=$1::uuid and workspace_id=$2::uuid`,[row.operationId,fresh.workspaceId]);await bookingAudit(tx,fresh,"booking.provider_outcome_unknown",row.id,{operationId:row.operationId});return readBooking(tx,fresh,row.id);
  },options);
}
async function providerFailure(session:AppSession,row:BookingRecord,error:unknown,options:BookingServiceOptions) {
  if(!(error instanceof BookingProviderError)||error.outcome!=="rejected")return uncertain(session,row,options);
  return withBookingTransaction(session,async(tx,fresh)=>{
    await bookingResourceLock(tx,fresh);const current=await readBooking(tx,fresh,row.id);if(!sameSnapshot(current,row))return current;
    const original={blockedStartsAt:new Date(Date.parse(row.startsAt)-row.rules.preparationMinutes*60_000).toISOString(),blockedEndsAt:new Date(Date.parse(row.endsAt)+row.rules.followupMinutes*60_000).toISOString()};
    await tx.execute(`update booking_reservations set state=$3,operation_target=null,blocked_starts_at=$4::timestamptz,blocked_ends_at=$5::timestamptz,revision=revision+1,updated_at=now() where id=$1::uuid and workspace_id=$2::uuid and operation_id=$6::uuid`,[row.id,fresh.workspaceId,row.operationKind==="create"?"expired":"confirmed",original.blockedStartsAt,original.blockedEndsAt,row.operationId]);
    await tx.execute(`update booking_operations set state='rejected',error_code=$2,updated_at=now() where id=$1::uuid`,[row.operationId,error.code]);
    await bookingAudit(tx,fresh,"booking.provider_rejected",row.id,{operationId:row.operationId,errorCode:error.code});return readBooking(tx,fresh,row.id);
  },options);
}
function providerWrite(row:BookingRecord):ProviderWrite { const rules=row.operationTarget?.rules??row.rules;return {operationId:row.operationId!,bookingId:row.id,title:row.title,startsAt:row.operationTarget?.startsAt??row.startsAt,endsAt:row.operationTarget?.endsAt??row.endsAt,timeZone:rules.timeZone,kind:row.kind,location:rules.location}; }
export async function confirmBooking(session:AppSession,id:string,options:BookingServiceOptions={}) {
  assertCrmUuid(id);const pre=await withBookingTransaction(session,async(tx,fresh)=>{await expireBookingHolds(tx,fresh,clock(options));return readBooking(tx,fresh,id);},options);
  if(pre.state!=="held")return pre;
  const c=await connection(session,pre.provider,options);matchingConnection(pre,c);const provider=await adapter(session,pre.provider,options);
  const travel=hasTravel(pre.rules)?await evaluateTravel(session,pre.kind,pre.startsAt,pre.rules,provider,options,pre):null;
  const claimed=await withBookingTransaction(session,async(tx,fresh)=>{
    await bookingResourceLock(tx,fresh);await expireBookingHolds(tx,fresh,clock(options));const row=await readBooking(tx,fresh,id);
    if(row.state!=="held")return {row,claimed:false};
    await verifyConnection(tx,fresh,c);
    const current=await effectiveRules(tx,fresh,row.kind,{location:row.rules.location,locationConfirmed:row.rules.locationConfirmed??false,propertyId:row.rules.propertyId??null});
    if(row.rules.propertyId&&current.location!==row.rules.location)throw new BookingError("PROPERTY_LOCATION_CHANGED",409);
    if(crmPayloadDigest(current)!==crmPayloadDigest(row.rules))throw new BookingError("RULES_CHANGED",409);
    if(travel)await verifyTravelContext(tx,fresh,row.rules,travel.digest,id);
    if(!isSlotAllowed(row.startsAt,row.rules,await internalBusy(tx,fresh,id),clock(options)))throw new BookingError("SLOT_UNAVAILABLE",409);
    const operationId=randomUUID();await tx.execute(`insert into booking_operations(id,workspace_id,booking_id,organizer_id,kind,idempotency_key,request_hash,state) values($1::uuid,$2::uuid,$3::uuid,$4::uuid,'create',$3::uuid,$5,'processing')`,[operationId,fresh.workspaceId,id,fresh.userId,row.requestHash]);
    await tx.execute(`update booking_reservations set state='processing',operation_id=$2::uuid,operation_kind='create',revision=revision+1,updated_at=now() where id=$1::uuid`,[id,operationId]);await bookingAudit(tx,fresh,"booking.confirm_started",id,{operationId});return {row:await readBooking(tx,fresh,id),claimed:true};
  },options);
  if(!claimed.claimed)return claimed.row;
  // Fresh availability immediately before the provider write; no provider write occurs if blocked.
  let external;
  try{external=await provider.listBusy(externalWindow(claimed.row.startsAt,claimed.row.rules));}catch(error){return providerFailure(session,claimed.row,error,options);}
  if(external.some(x=>overlaps(x,{startsAt:claimed.row.blockedStartsAt,endsAt:claimed.row.blockedEndsAt}))){return withBookingTransaction(session,async(tx,fresh)=>{await bookingResourceLock(tx,fresh);const current=await readBooking(tx,fresh,id);if(!sameSnapshot(current,claimed.row))return current;await tx.execute(`update booking_reservations set state='conflict',revision=revision+1 where id=$1::uuid`,[id]);await tx.execute(`update booking_operations set state='rejected',error_code='SLOT_UNAVAILABLE' where id=$1::uuid`,[claimed.row.operationId]);await bookingAudit(tx,fresh,"booking.conflict",id);return readBooking(tx,fresh,id);},options);}
  if(hasTravel(claimed.row.rules))try {
    const freshTravel=await evaluateTravel(session,claimed.row.kind,claimed.row.startsAt,claimed.row.rules,provider,options,claimed.row,external);
    await withBookingTransaction(session,async(tx,fresh)=>{await bookingResourceLock(tx,fresh);await verifyTravelContext(tx,fresh,claimed.row.rules,freshTravel.digest,id);},options);
  }catch(error){return providerFailure(session,claimed.row,error instanceof BookingError?new BookingProviderError(error.code,"rejected"):error,options);}
  try{await verifyCurrentBinding(session,claimed.row,options);return await finish(session,claimed.row,await provider.create(providerWrite(claimed.row)),options);}catch(error){return providerFailure(session,claimed.row,error,options);}
}
export async function getBookingStatus(session:AppSession,id:string,options:BookingServiceOptions={}) {
  assertCrmUuid(id);const row=await withBookingTransaction(session,async(tx,fresh)=>{await expireBookingHolds(tx,fresh,clock(options));return readBooking(tx,fresh,id);},options);
  if(!["confirmed","uncertain","processing","conflict"].includes(row.state)||!row.operationId)return row;
  const c=await connection(session,row.provider,options);matchingConnection(row,c);const provider=await adapter(session,row.provider,options);
  let event:ProviderEvent|null;try{event=await provider.lookup({operationId:row.operationId,bookingId:row.id,eventId:row.providerEventId??undefined});}catch{return row;}
  if(!event) {
    if(row.providerEventId)return finish(session,row,null,options,true);
    return row; // An absent/unproven create never authorizes another create.
  }
  if(event.cancelled)return finish(session,row,event,options,true);
  if(row.operationKind==="cancel"&&row.state!=="confirmed")return row;
  if(row.operationKind==="reschedule"&&row.operationTarget && (Date.parse(event.startsAt)!==Date.parse(row.operationTarget.startsAt)||Date.parse(event.endsAt)!==Date.parse(row.operationTarget.endsAt)))return row;
  if(row.state==="processing"||row.state==="uncertain")return finish(session,row,event,options);
  const reconciled=row;
  if(Date.parse(event.startsAt)!==Date.parse(reconciled.startsAt)||Date.parse(event.endsAt)!==Date.parse(reconciled.endsAt)||event.etag!==reconciled.providerEtag||event.onlineMeetingUrl!==reconciled.videoUrl||event.videoStatus!==reconciled.videoStatus) {
    return withBookingTransaction(session,async(tx,fresh)=>{
      await bookingResourceLock(tx,fresh);const current=await readBooking(tx,fresh,id);if(!sameSnapshot(current,reconciled))return current;
      const blockedStart=new Date(Date.parse(event!.startsAt)-row.rules.preparationMinutes*60_000).toISOString(),blockedEnd=new Date(Date.parse(event!.endsAt)+row.rules.followupMinutes*60_000).toISOString();
      const conflict=(await internalBusy(tx,fresh,id)).some(x=>overlaps(x,{startsAt:blockedStart,endsAt:blockedEnd}));
      await tx.execute(`update booking_reservations set starts_at=$2::timestamptz,ends_at=$3::timestamptz,blocked_starts_at=$4::timestamptz,blocked_ends_at=$5::timestamptz,state=$6,provider_etag=$7,video_url=$8,video_status=$9,revision=revision+1,updated_at=now() where id=$1::uuid`,[id,event!.startsAt,event!.endsAt,blockedStart,blockedEnd,conflict?"conflict":"confirmed",event!.etag,event!.onlineMeetingUrl,event!.videoStatus]);await tx.query(`select booking_sync_crm($1::uuid)`,[id]);await syncBookingMessages(tx,fresh,current,await readBooking(tx,fresh,id),clock(options));await bookingAudit(tx,fresh,"booking.external_change",id,{conflict});return readBooking(tx,fresh,id);
    },options);
  }
  return reconciled;
}
async function mutate(session:AppSession,id:string,input:{startsAt?:string;idempotencyKey:string;expectedMessageVersion?:number}&BookingLocationInput,kind:"reschedule"|"cancel",options:BookingServiceOptions) {
  assertCrmUuid(id);assertCrmUuid(input.idempotencyKey,"idempotencyKey");
  if(input.expectedMessageVersion!==undefined&&(!Number.isSafeInteger(input.expectedMessageVersion)||input.expectedMessageVersion<0))throw new BookingError("BOOKING_ACTION_STALE",409);
  const requestHash=crmPayloadDigest({bookingId:id,kind,...input});
  const snapshot=await withBookingTransaction(session,async(tx,fresh)=>{
    const row=await readBooking(tx,fresh,id);
    if(input.expectedMessageVersion!==undefined&&row.messageVersion!==input.expectedMessageVersion)throw new BookingError("BOOKING_ACTION_STALE",409);
    const replay=await tx.queryOne<{requestHash:string}>(`select request_hash as "requestHash" from booking_operations where workspace_id=$1::uuid and organizer_id=$2::uuid and idempotency_key=$3::uuid`,[fresh.workspaceId,fresh.userId,input.idempotencyKey]);
    if(replay&&replay.requestHash!==requestHash)throw new BookingError("IDEMPOTENCY_CONFLICT",409);
    if(replay)return {row,replayed:true,rules:row.rules};
    const current=kind==="reschedule"?await effectiveRules(tx,fresh,row.kind,{location:input.location??row.rules.location,locationConfirmed:input.locationConfirmed??row.rules.locationConfirmed,propertyId:input.propertyId===undefined?row.rules.propertyId??null:input.propertyId}):row.rules;
    if(kind==="reschedule"&&row.rules.propertyId&&current.propertyId===row.rules.propertyId&&current.location!==row.rules.location)throw new BookingError("PROPERTY_LOCATION_CHANGED",409);
    const rules={...row.rules,travel:current.travel,location:current.location,locationConfirmed:current.locationConfirmed,propertyId:current.propertyId};
    if(kind==="reschedule"&&!onsiteLocationReady(row.kind,rules))throw new BookingError("ADDRESS_CONFIRMATION_REQUIRED",409);
    return {row,replayed:!!replay,rules};
  },options);
  const pre=snapshot.row;if(snapshot.replayed)return pre;
  const c=await connection(session,pre.provider,options);matchingConnection(pre,c);const provider=await adapter(session,pre.provider,options);
  const target=kind==="reschedule"?{...bookingWindow(input.startsAt!,snapshot.rules),rules:snapshot.rules}:null;
  const evaluation=target?await evaluateTravel(session,pre.kind,target.startsAt,snapshot.rules,provider,options,pre):null;
  const external=evaluation?.external??[];
  const claimed=await withBookingTransaction(session,async(tx,fresh)=>{
    await bookingResourceLock(tx,fresh);await expireBookingHolds(tx,fresh,clock(options));const row=await readBooking(tx,fresh,id);
    if(input.expectedMessageVersion!==undefined&&row.messageVersion!==input.expectedMessageVersion)throw new BookingError("BOOKING_ACTION_STALE",409);
    const replay=await tx.queryOne<{requestHash:string}>(`select request_hash as "requestHash" from booking_operations where workspace_id=$1::uuid and organizer_id=$2::uuid and idempotency_key=$3::uuid`,[fresh.workspaceId,fresh.userId,input.idempotencyKey]);
    if(replay){if(replay.requestHash!==requestHash)throw new BookingError("IDEMPOTENCY_CONFLICT",409);return {row,claimed:false};}
    if(row.state!=="confirmed"||!row.providerEventId)throw new BookingError("BOOKING_NOT_CONFIRMED",409);
    if(row.revision!==pre.revision)throw new BookingError("BOOKING_CHANGED",409);
    await verifyConnection(tx,fresh,c);
    const notice=kind==="cancel"?row.rules.cancelNoticeMinutes:row.rules.rescheduleNoticeMinutes;
    if(Date.parse(row.startsAt)-clock(options)<notice*60_000)throw new BookingError("CHANGE_DEADLINE",409);
    if(target) {
      const current=await effectiveRules(tx,fresh,row.kind,{location:target.rules.location,locationConfirmed:target.rules.locationConfirmed,propertyId:target.rules.propertyId??null});
      if(target.rules.propertyId&&current.location!==target.rules.location)throw new BookingError("PROPERTY_LOCATION_CHANGED",409);
      if(crmPayloadDigest(current.travel)!==crmPayloadDigest(target.rules.travel))throw new BookingError("RULES_CHANGED",409);
      await verifyTravelContext(tx,fresh,target.rules,evaluation!.digest,id);
      if(!isSlotAllowed(target.startsAt,target.rules,[...external,...await internalBusy(tx,fresh,id)],clock(options)))throw new BookingError("SLOT_UNAVAILABLE",409);
    }
    if(target&&row.rules.maxPerDay!==null){const count=await tx.queryOne<{count:number}>(`select count(*)::int as count from booking_reservations where workspace_id=$1::uuid and organizer_id=$2::uuid and id<>$3::uuid and state in ('held','processing','confirmed','uncertain','conflict') and (state<>'conflict' or provider_event_id is not null) and (starts_at at time zone $4)::date=$5::date`,[fresh.workspaceId,fresh.userId,id,row.rules.timeZone,localParts(Date.parse(target.startsAt),row.rules.timeZone).date]);if((count?.count??0)>=row.rules.maxPerDay)throw new BookingError("DAILY_LIMIT",409);}
    const operationId=randomUUID();await tx.execute(`insert into booking_operations(id,workspace_id,booking_id,organizer_id,kind,idempotency_key,request_hash,state) values($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,$6::uuid,$7,'processing')`,[operationId,fresh.workspaceId,id,fresh.userId,kind,input.idempotencyKey,requestHash]);
    await tx.execute(`update booking_reservations set state='processing',operation_id=$2::uuid,operation_kind=$3,operation_target=$4::jsonb,blocked_starts_at=least(blocked_starts_at,coalesce($5::timestamptz,blocked_starts_at)),blocked_ends_at=greatest(blocked_ends_at,coalesce($6::timestamptz,blocked_ends_at)),revision=revision+1,updated_at=now() where id=$1::uuid`,[id,operationId,kind,JSON.stringify(target),target?.blockedStartsAt??null,target?.blockedEndsAt??null]);await bookingAudit(tx,fresh,`booking.${kind}_started`,id,{operationId});return {row:await readBooking(tx,fresh,id),claimed:true};
  },options);
  if(!claimed.claimed)return claimed.row;
  if(kind==="reschedule"&&target)try {
    const freshEvaluation=await evaluateTravel(session,claimed.row.kind,target.startsAt,target.rules,provider,options,claimed.row);
    await withBookingTransaction(session,async(tx,fresh)=>{await bookingResourceLock(tx,fresh);await verifyTravelContext(tx,fresh,target.rules,freshEvaluation.digest,id);},options);
  }catch(error){return providerFailure(session,claimed.row,error instanceof BookingError?new BookingProviderError(error.code,"rejected"):error,options);}
  try{await verifyCurrentBinding(session,claimed.row,options);if(kind==="cancel"){await provider.delete({bookingId:id,operationId:claimed.row.operationId!,eventId:claimed.row.providerEventId!,etag:claimed.row.providerEtag});return finish(session,claimed.row,null,options,true);}return finish(session,claimed.row,await provider.update({...providerWrite(claimed.row),eventId:claimed.row.providerEventId!,etag:claimed.row.providerEtag}),options);}catch(error){return providerFailure(session,claimed.row,error,options);}
}
export const rescheduleBooking=(session:AppSession,id:string,input:{startsAt:string;idempotencyKey:string;expectedMessageVersion?:number}&BookingLocationInput,options:BookingServiceOptions={})=>mutate(session,id,input,"reschedule",options);
export const cancelBooking=(session:AppSession,id:string,input:{idempotencyKey:string;expectedMessageVersion?:number},options:BookingServiceOptions={})=>mutate(session,id,input,"cancel",options);
export async function listBookingRecords(session:AppSession,options:BookingServiceOptions={}) {return withBookingTransaction(session,async(tx,fresh)=>{await expireBookingHolds(tx,fresh,clock(options));return tx.query<BookingRecord>(`select ${bookingColumns} from booking_reservations where workspace_id=$1::uuid and organizer_id=$2::uuid order by created_at desc limit 30`,[fresh.workspaceId,fresh.userId]);},options);}
export async function captureBookingRequest(session:AppSession,input:{kind:BookingKind;title:string;requestedStartsAt:string;provider:BookingProviderName;contactNote?:string;idempotencyKey:string},options:BookingServiceOptions={}) {
  validateChoice(input.provider,input.kind);assertCrmUuid(input.idempotencyKey);const heading=title(input.title);if(!validInstant(input.requestedStartsAt))throw new BookingError("INVALID_START");
  return withBookingTransaction(session,async(tx,fresh)=>{await tx.query(`select booking_capture_request($1::uuid,$2::uuid,$3,$4::timestamptz,$5,$6,$7)`,[input.idempotencyKey,fresh.workspaceId,heading,input.requestedStartsAt,input.kind,input.provider,input.contactNote??""]);await bookingAudit(tx,fresh,"booking.request_captured",input.idempotencyKey,{providerCreated:false});return {id:input.idempotencyKey,state:"requested",providerCreated:false};},options);
}
