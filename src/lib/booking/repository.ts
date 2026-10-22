import type { AppSession } from "@/lib/auth/session";
import { withCrmRead, type TenantTransaction, type TenantTransactionOptions } from "@/lib/crm-command";
import { hasProductCapability } from "@/lib/product-model";
import { BookingError, type BookingKind, type BookingRecord, type BookingRules } from "./types";
import { defaultBookingRules } from "./rules";
import { currentTenantTransaction } from "@/lib/db/transaction-context";
export const bookingColumns = `id,workspace_id as "workspaceId",organizer_id as "organizerId",provider,kind,title,to_char(starts_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "startsAt",to_char(ends_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "endsAt",to_char(blocked_starts_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "blockedStartsAt",to_char(blocked_ends_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "blockedEndsAt",state,to_char(expires_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "expiresAt",rules,calendar_id as "calendarId",connection_id as "connectionId",connection_revision::int as "connectionRevision",provider_event_id as "providerEventId",provider_etag as "providerEtag",video_url as "videoUrl",video_status as "videoStatus",operation_id as "operationId",operation_kind as "operationKind",operation_target as "operationTarget",notification_status as "notificationStatus",revision::int,request_hash as "requestHash",recipient_email as "recipientEmail",recipient_name as "recipientName",communication_language as "communicationLanguage",message_version::int as "messageVersion",message_snapshot as "messageSnapshot"`;
export function withBookingTransaction<T>(session:AppSession, callback:(tx:TenantTransaction,fresh:AppSession)=>Promise<T>,options:TenantTransactionOptions={}) {
  if(currentTenantTransaction())throw new BookingError("BOOKING_TRANSACTION_BOUNDARY_REQUIRED",409);
  return withCrmRead(session,async(tx,fresh)=>{
    if(fresh.serviceIdentity || !fresh.permissions.includes("crm:write") || !hasProductCapability(fresh.productRole,"calendar:manage")) throw new BookingError("BOOKING_FORBIDDEN",403);
    const allowed=await tx.queryOne<{allowed:boolean}>(`select booking_actor_allowed($1::uuid,$2::uuid) as allowed`,[fresh.workspaceId,fresh.userId]);
    if(!allowed?.allowed) throw new BookingError("BOOKING_MODULE_REQUIRED",403);
    return callback(tx,fresh);
  },options);
}
export async function bookingResourceLock(tx:TenantTransaction,session:AppSession) {
  await tx.query(`select pg_advisory_xact_lock_shared(hashtextextended($1,0))`,[`booking-workspace:${session.workspaceId}`]);
  await tx.query(`select pg_advisory_xact_lock(hashtextextended($1,0))`,[`booking:${session.workspaceId}:${session.userId}`]);
}
export async function expireBookingHolds(tx:TenantTransaction,session:AppSession,now:number) {
  await tx.execute(`update booking_reservations set state='expired',revision=revision+1,updated_at=now() where workspace_id=$1::uuid and organizer_id=$2::uuid and state='held' and expires_at<=to_timestamp($3::double precision/1000)`,[session.workspaceId,session.userId,now]);
}
export async function readBooking(tx:TenantTransaction,session:AppSession,id:string) {
  const row=await tx.queryOne<BookingRecord>(`select ${bookingColumns} from booking_reservations where id=$1::uuid and workspace_id=$2::uuid and organizer_id=$3::uuid`,[id,session.workspaceId,session.userId]);
  if(!row)throw new BookingError("BOOKING_NOT_FOUND",404); return row;
}
export async function readRules(tx:TenantTransaction,session:AppSession,kind:BookingKind | "*", workspaceOnly=false) {
  const rows=await tx.query<{userId:string|null;kind:string;rules:Partial<BookingRules>}>(`select user_id as "userId",kind,rules from booking_rule_sets where workspace_id=$1::uuid and (user_id is null or (user_id=$2::uuid and not $4::boolean)) and kind in ('*',$3) order by (user_id is not null)::int,(kind<>'*')::int`,[session.workspaceId,session.userId,kind,workspaceOnly]);
  const company=rows.filter(row=>!row.userId).reduce<BookingRules>((rules,row)=>({...rules,...row.rules}),{...defaultBookingRules});
  if(workspaceOnly)return company;
  const masks=await tx.query<{kind:string;fields:string[]}>(`select kind,company_resets->'rules' as fields from booking_setup_sets where workspace_id=$1::uuid and user_id=$2::uuid and kind in ('*',$3)`,[session.workspaceId,session.userId,kind]);
  let effective={...company};
  for(const layer of new Set(["*",kind])) {
    for(const field of masks.find(row=>row.kind===layer)?.fields??[]) if(Object.hasOwn(defaultBookingRules,field)) effective={...effective,[field]:company[field as keyof BookingRules]};
    effective={...effective,...rows.find(row=>row.userId===session.userId&&row.kind===layer)?.rules};
  }
  return effective;
}
export async function readTravelBookings(tx:TenantTransaction,session:AppSession,excludeId:string|null=null) {
  return tx.query<BookingRecord>(`select ${bookingColumns} from booking_reservations where workspace_id=$1::uuid and organizer_id=$2::uuid
    and state in ('held','processing','confirmed','uncertain','conflict') and (state<>'conflict' or provider_event_id is not null)
    and ($3::uuid is null or id<>$3::uuid) order by id`,[session.workspaceId,session.userId,excludeId]);
}
export async function internalBusy(tx:TenantTransaction,session:AppSession,excludeId:string|null=null) {
  return tx.query<{startsAt:string;endsAt:string}>(`select to_char(blocked_starts_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "startsAt",to_char(blocked_ends_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "endsAt" from booking_reservations where workspace_id=$1::uuid and organizer_id=$2::uuid and state in ('held','processing','confirmed','uncertain','conflict') and (state<>'conflict' or provider_event_id is not null) and ($3::uuid is null or id<>$3::uuid)`,[session.workspaceId,session.userId,excludeId]);
}
export async function bookingAudit(tx:TenantTransaction,session:AppSession,action:string,id:string,details:Record<string,unknown>={}) {
  await tx.execute(`insert into audit_logs(workspace_id,actor_user_id,action,entity_type,entity_id,after) values($1::uuid,$2::uuid,$3,'universal_booking',$4::uuid,$5::jsonb)`,[session.workspaceId,session.userId,action,id,JSON.stringify(details)]);
}
