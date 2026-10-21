import "server-only";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { withTenantTransaction, type TenantScope, type TenantTransaction } from "@/lib/db/tenant-client";
import { createSignedOAuthState, parseSignedOAuthState, hashOAuthState, encryptOAuthStateSecret,
  decryptOAuthStateSecret, type CalendarOAuthProvider } from "@/lib/integrations/calendar-oauth-state";

export type BookingProvider = CalendarOAuthProvider;
export type BookingCalendar = { id: string; name: string; canWrite: boolean; canRead: boolean;
  teamsSupported: boolean; meetSupported: boolean; protectedReadOnly: boolean };
type Tokens = { accessToken: string; refreshToken?: string };
type ConnectionRow = { id: string; userId: string; provider: BookingProvider; status: string;
  accountId: string | null; accountLabel: string | null; encryptedTokens: string | null;
  expiresAt: string | Date | null; scopes: string[]; calendars: BookingCalendar[];
  writeCalendarId: string | null; conflictCalendarIds: string[]; errorCode: string | null; revision: string | number };
export type BookingConnection = Omit<ConnectionRow, "encryptedTokens" | "revision" | "expiresAt"> & {
  connected: boolean; revision: number; expiresAt: string | null };
export class BookingConnectionError extends Error {
  constructor(public readonly code: string, public readonly status = 409) { super(code); }
}
function calendarWriterConflict(error: unknown): never {
  if (error && typeof error === "object" && "code" in error && error.code === "23505")
    throw new BookingConnectionError("calendar_writer_already_assigned");
  throw error;
}
export function bookingMicrosoftAuthority() {
  const authority = process.env.BOOKING_MICROSOFT_AUTHORITY?.trim() || "common";
  if (!["common","organizations","consumers"].includes(authority) &&
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(authority))
    throw new BookingConnectionError("calendar_oauth_authority_invalid",503);
  return authority;
}
const columns = `id,user_id as "userId",provider,status,account_id as "accountId",account_label as "accountLabel",
 encrypted_tokens as "encryptedTokens",expires_at as "expiresAt",scopes,calendars,write_calendar_id as "writeCalendarId",
 conflict_calendar_ids as "conflictCalendarIds",error_code as "errorCode",revision`;
function encryptionKey() {
  const value = process.env.OAUTH_TOKEN_ENCRYPTION_KEY?.trim();
  if (!value || Buffer.byteLength(value) < 32) throw new BookingConnectionError("calendar_encryption_unavailable", 503);
  return createHash("sha256").update(value).digest();
}
function tokenContext(scope: TenantScope, provider: BookingProvider) {
  return Buffer.from(`booking:v1:${scope.workspaceId}:${scope.actorId}:${provider}`);
}
export function encryptBookingTokens(scope: TenantScope, provider: BookingProvider, tokens: Tokens) {
  const iv = randomBytes(12); const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  cipher.setAAD(tokenContext(scope, provider));
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(tokens)), cipher.final()]);
  return ["b1",iv.toString("base64url"),cipher.getAuthTag().toString("base64url"),encrypted.toString("base64url")].join(".");
}
export function decryptBookingTokens(scope: TenantScope, provider: BookingProvider, value: string): Tokens {
  try {
    const [version,iv,tag,body,...extra] = value.split(".");
    if (version !== "b1" || !iv || !tag || !body || extra.length) throw new Error("invalid");
    const decipher = createDecipheriv("aes-256-gcm",encryptionKey(),Buffer.from(iv,"base64url"));
    decipher.setAAD(tokenContext(scope,provider)); decipher.setAuthTag(Buffer.from(tag,"base64url"));
    const parsed = JSON.parse(Buffer.concat([decipher.update(Buffer.from(body,"base64url")),decipher.final()]).toString("utf8")) as Tokens;
    if (!parsed.accessToken || typeof parsed.accessToken !== "string" ||
      (parsed.refreshToken !== undefined && typeof parsed.refreshToken !== "string")) throw new Error("invalid");
    return parsed;
  } catch { throw new BookingConnectionError("calendar_credentials_unavailable",503); }
}
function metadata(row: ConnectionRow): BookingConnection {
  return { id: row.id,userId: row.userId,provider: row.provider,status: row.status,
    accountId:row.accountId,accountLabel:row.accountLabel,connected:row.status === "connected",
    expiresAt:row.expiresAt ? new Date(row.expiresAt).toISOString() : null,scopes:row.scopes,
    calendars:row.calendars,writeCalendarId:row.writeCalendarId,conflictCalendarIds:row.conflictCalendarIds,
    errorCode:row.errorCode,revision:Number(row.revision) };
}
async function selectConnection(tx: TenantTransaction, scope: TenantScope, provider: BookingProvider, lock = false) {
  return tx.queryOne<ConnectionRow>(`select ${columns} from booking_calendar_connections
    where workspace_id=$1 and user_id=$2 and provider=$3${lock ? " for update" : ""}`,
  [scope.workspaceId,scope.actorId,provider]);
}
async function bindingLock(tx: TenantTransaction, scope: TenantScope) {
  // Same key/order as bookingResourceLock, serializing selection and hold creation.
  await tx.query("select pg_advisory_xact_lock(hashtextextended($1,0))",[`booking:${scope.workspaceId}:${scope.actorId}`]);
}
async function assertBindingChangeAllowed(tx: TenantTransaction, scope: TenantScope, previous: ConnectionRow | null,
  accountId: string | null, calendarId: string | null) {
  if (!previous || (previous.accountId === accountId && previous.writeCalendarId === calendarId)) return;
  const active = await tx.queryOne<{active:boolean}>(`select exists(select 1 from booking_reservations
    where workspace_id=$1 and organizer_id=$2 and connection_id=$3 and (
      state in ('processing','uncertain') or (state='held' and expires_at>now()) or
      (blocked_ends_at>now() and (state='confirmed' or
        (state='conflict' and provider_event_id is not null))))) as active`,
  [scope.workspaceId,scope.actorId,previous.id]);
  if (active?.active) throw new BookingConnectionError("calendar_binding_in_use");
}
async function audit(tx: TenantTransaction, scope: TenantScope, id: string, action: string, provider: BookingProvider) {
  await tx.execute(`insert into audit_logs(workspace_id,actor_user_id,action,entity_type,entity_id,after)
    values($1,$2,$3,'booking_calendar_connection',$4,$5::jsonb)`,
  [scope.workspaceId,scope.actorId,action,id,JSON.stringify({provider})]);
}
export async function getBookingConnection(scope: TenantScope, provider: BookingProvider) {
  return withTenantTransaction(scope,async tx => {
    const row = await selectConnection(tx,scope,provider); return row ? metadata(row) : null;
  });
}
export async function listBookingConnections(scope: TenantScope) {
  return withTenantTransaction(scope,async tx => {
    const rows = await tx.query<ConnectionRow>(`select ${columns} from booking_calendar_connections
      where workspace_id=$1 and user_id=$2 order by provider`,[scope.workspaceId,scope.actorId]);
    return rows.map(metadata);
  });
}
export function isProtectedBookingCalendar(name: string) {
  const normalized = name.normalize("NFKC").toLocaleLowerCase("de").replace(/\s+/g," ").trim();
  return normalized.includes("sekretariat") && normalized.includes("grasl") && normalized.includes("immobilien");
}
function preserveReadOnlyCalendars(previous: BookingCalendar[], calendars: BookingCalendar[]) {
  const protectedIds = new Set(previous.filter(calendar => calendar.protectedReadOnly).map(calendar => calendar.id));
  return calendars.map(calendar => protectedIds.has(calendar.id)
    ? {...calendar,protectedReadOnly:true,canWrite:false,teamsSupported:false,meetSupported:false} : calendar);
}
async function jsonRequest(url: string | URL, accessToken: string) {
  let response: Response;
  try { response = await fetch(url,{headers:{Authorization:`Bearer ${accessToken}`},signal:AbortSignal.timeout(12_000),redirect:"error",cache:"no-store"}); }
  catch { throw new BookingConnectionError("calendar_provider_unavailable",503); }
  if (!response.ok) throw new BookingConnectionError(response.status === 401 || response.status === 403
    ? "calendar_reauth_required" : "calendar_provider_unavailable",response.status === 401 || response.status === 403 ? 409 : 503);
  try { return await response.json() as Record<string,unknown>; }
  catch { throw new BookingConnectionError("calendar_response_invalid",503); }
}
function hasWriteScope(provider: BookingProvider, scopes: string[]) {
  return provider === "google" ? scopes.some(s => s === "https://www.googleapis.com/auth/calendar" ||
    s === "https://www.googleapis.com/auth/calendar.events") :
    scopes.some(s => s.toLowerCase().replace("https://graph.microsoft.com/","") === "calendars.readwrite");
}
export async function discoverBookingCalendars(provider: BookingProvider, accessToken: string, scopes: string[]): Promise<BookingCalendar[]> {
  const root = provider === "google" ? "https://www.googleapis.com/calendar/v3/users/me/calendarList" :
    "https://graph.microsoft.com/v1.0/me/calendars";
  let next: string | null = root; const calendars: BookingCalendar[] = [];
  for (let page=0;next && page<20;page++) {
    const url = new URL(next);
    if (url.origin !== new URL(root).origin || url.pathname !== new URL(root).pathname)
      throw new BookingConnectionError("calendar_response_invalid",503);
    const data = await jsonRequest(url,accessToken);
    const entries = provider === "google" ? data.items : data.value;
    if (!Array.isArray(entries)) throw new BookingConnectionError("calendar_response_invalid",503);
    for (const raw of entries) {
      if (!raw || typeof raw !== "object") throw new BookingConnectionError("calendar_response_invalid",503);
      const item = raw as Record<string,unknown>;
      if (typeof item.id !== "string" || !item.id || item.id.length>2048) throw new BookingConnectionError("calendar_response_invalid",503);
      const name = String(provider === "google" ? item.summary ?? item.id : item.name ?? item.id).slice(0,500);
      const protectedReadOnly = isProtectedBookingCalendar(name);
      const canRead = provider === "google" ? ["owner","writer","reader","freeBusyReader"].includes(String(item.accessRole)) : true;
      const canWrite = hasWriteScope(provider,scopes) && !protectedReadOnly &&
        (provider === "google" ? ["owner","writer"].includes(String(item.accessRole)) : item.canEdit === true);
      const conference = item.conferenceProperties as { allowedConferenceSolutionTypes?: unknown } | undefined;
      calendars.push({id:item.id,name,canRead,canWrite,protectedReadOnly,
        teamsSupported:canWrite && provider === "microsoft" && Array.isArray(item.allowedOnlineMeetingProviders) && item.allowedOnlineMeetingProviders.includes("teamsForBusiness"),
        meetSupported:canWrite && provider === "google" && Array.isArray(conference?.allowedConferenceSolutionTypes) && conference.allowedConferenceSolutionTypes.includes("hangoutsMeet")});
    }
    if (provider === "google") {
      if (data.nextPageToken !== undefined && typeof data.nextPageToken !== "string") throw new BookingConnectionError("calendar_response_invalid",503);
      const cursor = data.nextPageToken as string | undefined;
      next = cursor ? `${root}?pageToken=${encodeURIComponent(cursor)}` : null;
    } else {
      if (data["@odata.nextLink"] !== undefined && typeof data["@odata.nextLink"] !== "string") throw new BookingConnectionError("calendar_response_invalid",503);
      next = data["@odata.nextLink"] as string ?? null;
    }
  }
  if (next) throw new BookingConnectionError("calendar_response_truncated",503);
  return calendars;
}
export async function saveBookingOAuthConnection(scope: TenantScope, provider: BookingProvider, token: {
  access_token?: string; refresh_token?: string; expires_in?: number; scope?: string;
}) {
  if (!token.access_token || !token.scope) throw new BookingConnectionError("calendar_oauth_scope_missing",409);
  const scopes = token.scope.split(/\s+/).filter(Boolean);
  const profile = await jsonRequest(provider === "google" ? "https://www.googleapis.com/oauth2/v3/userinfo" :
    "https://graph.microsoft.com/v1.0/me?$select=id,mail,userPrincipalName,displayName",token.access_token);
  const accountId = provider === "google" ? profile.sub : profile.id;
  const accountLabel = provider === "google" ? profile.email : profile.mail ?? profile.userPrincipalName;
  if (typeof accountId !== "string" || !accountId || typeof accountLabel !== "string" || !accountLabel)
    throw new BookingConnectionError("calendar_account_unverified",409);
  const calendars = await discoverBookingCalendars(provider,token.access_token,scopes);
  return withTenantTransaction(scope,async tx => {
    await bindingLock(tx,scope);
    const previous = await selectConnection(tx,scope,provider,true);
    // A reconnect to another provider account must never inherit its tokens or calendar choice.
    const sameAccount = previous?.accountId === accountId;
    const previousTokens = sameAccount && previous?.encryptedTokens ? decryptBookingTokens(scope,provider,previous.encryptedTokens) : null;
    const encrypted = encryptBookingTokens(scope,provider,{accessToken:token.access_token!,
      refreshToken:token.refresh_token ?? previousTokens?.refreshToken});
    const safeCalendars = preserveReadOnlyCalendars(previous?.calendars ?? [],calendars);
    // Temporary permission loss must not replace an existing booking's binding.
    // Actual access checks still reject unavailable writer/conflict calendars.
    const writeId = sameAccount ? previous!.writeCalendarId : null;
    const conflicts = sameAccount ? previous!.conflictCalendarIds : [];
    await assertBindingChangeAllowed(tx,scope,previous,accountId,writeId);
    const expiresAt = new Date(Date.now()+Math.max(1,Math.min(86400,token.expires_in ?? 3600))*1000).toISOString();
    const row = await tx.queryOne<ConnectionRow>(`insert into booking_calendar_connections
      (workspace_id,user_id,provider,status,account_id,account_label,encrypted_tokens,expires_at,scopes,calendars,write_calendar_id,conflict_calendar_ids)
      values($1,$2,$3,'connected',$4,$5,$6,$7,$8,$9::jsonb,$10,$11)
      on conflict(workspace_id,user_id,provider) do update set status='connected',account_id=excluded.account_id,
      account_label=excluded.account_label,encrypted_tokens=excluded.encrypted_tokens,expires_at=excluded.expires_at,
      scopes=excluded.scopes,calendars=excluded.calendars,write_calendar_id=excluded.write_calendar_id,
      conflict_calendar_ids=excluded.conflict_calendar_ids,error_code=null,
      revision=booking_calendar_connections.revision+case when booking_calendar_connections.account_id is distinct from excluded.account_id
        or booking_calendar_connections.write_calendar_id is distinct from excluded.write_calendar_id then 1 else 0 end,updated_at=now()
      returning ${columns}`,[scope.workspaceId,scope.actorId,provider,accountId,accountLabel,encrypted,expiresAt,scopes,JSON.stringify(safeCalendars),writeId,conflicts]);
    if (!row) throw new BookingConnectionError("calendar_save_failed",503);
    await audit(tx,scope,row.id,"booking.calendar.connected",provider); return metadata(row);
  }).catch(calendarWriterConflict);
}
async function refreshToken(provider: BookingProvider, refreshToken: string) {
  const clientId = process.env[provider === "google" ? "GOOGLE_CLIENT_ID" : "MICROSOFT_CLIENT_ID"]?.trim();
  const clientSecret = process.env[provider === "google" ? "GOOGLE_CLIENT_SECRET" : "MICROSOFT_CLIENT_SECRET"]?.trim();
  if (!clientId || !clientSecret) throw new BookingConnectionError("calendar_oauth_unavailable",503);
  const tenant = provider === "microsoft" ? encodeURIComponent(bookingMicrosoftAuthority()) : "";
  let response: Response;
  try { response = await fetch(provider === "google" ? "https://oauth2.googleapis.com/token" :
    `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,{method:"POST",signal:AbortSignal.timeout(12_000),redirect:"error",cache:"no-store",
    headers:{"Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams({client_id:clientId,
      client_secret:clientSecret,grant_type:"refresh_token",refresh_token:refreshToken})}); }
  catch { throw new BookingConnectionError("calendar_provider_unavailable",503); }
  if (!response.ok) throw new BookingConnectionError(response.status === 400 || response.status === 401
    ? "calendar_reauth_required" : "calendar_provider_unavailable",response.status === 400 || response.status === 401 ? 409 : 503);
  const data = await response.json() as {access_token?: string;refresh_token?: string;expires_in?: number;scope?: string};
  if (!data.access_token) throw new BookingConnectionError("calendar_response_invalid",503);
  return data;
}
async function usableToken(scope: TenantScope, provider: BookingProvider) {
  const result = await withTenantTransaction(scope,async tx => {
    // Serialize rotation and disconnect so a stale refresh cannot reconnect a revoked row.
    const row = await selectConnection(tx,scope,provider,true);
    if (!row || row.status !== "connected" || !row.encryptedTokens) throw new BookingConnectionError("calendar_not_connected");
    const tokens = decryptBookingTokens(scope,provider,row.encryptedTokens);
    if (row.expiresAt && new Date(row.expiresAt).getTime()>Date.now()+60_000) return {row,accessToken:tokens.accessToken};
    try {
      if (!tokens.refreshToken) throw new BookingConnectionError("calendar_reauth_required");
      const fresh = await refreshToken(provider,tokens.refreshToken);
      const encrypted = encryptBookingTokens(scope,provider,{accessToken:fresh.access_token!,refreshToken:fresh.refresh_token ?? tokens.refreshToken});
      const updated = await tx.queryOne<ConnectionRow>(`update booking_calendar_connections set encrypted_tokens=$4,
        expires_at=$5,scopes=$6,error_code=null,updated_at=now()
        where workspace_id=$1 and user_id=$2 and provider=$3 returning ${columns}`,
      [scope.workspaceId,scope.actorId,provider,encrypted,new Date(Date.now()+Math.max(1,Math.min(86400,fresh.expires_in ?? 3600))*1000).toISOString(),
        fresh.scope ? fresh.scope.split(/\s+/).filter(Boolean) : row.scopes]);
      if (!updated) throw new BookingConnectionError("calendar_save_failed",503);
      await audit(tx,scope,row.id,"booking.calendar.refreshed",provider); return {row:updated,accessToken:fresh.access_token!};
    } catch (error) {
      if (!(error instanceof BookingConnectionError) || error.code !== "calendar_reauth_required") throw error;
      await tx.execute(`update booking_calendar_connections set status='reauth_required',error_code='calendar_reauth_required',
        updated_at=now() where workspace_id=$1 and user_id=$2 and provider=$3`,[scope.workspaceId,scope.actorId,provider]);
      await audit(tx,scope,row.id,"booking.calendar.reauth_required",provider); return {reauth:true as const};
    }
  });
  if ("reauth" in result) throw new BookingConnectionError("calendar_reauth_required");
  return result;
}
export async function invalidateBookingConnection(scope: TenantScope, provider: BookingProvider, expectedRevision?: number, expectedAccessToken?: string) {
  await withTenantTransaction(scope,async tx => {
    const row = await selectConnection(tx,scope,provider,true); if (!row) return;
    if (row.status !== "connected" || (expectedRevision !== undefined && Number(row.revision) !== expectedRevision)) return;
    if (expectedAccessToken !== undefined && (!row.encryptedTokens ||
      decryptBookingTokens(scope,provider,row.encryptedTokens).accessToken !== expectedAccessToken)) return;
    await tx.execute(`update booking_calendar_connections set status='reauth_required',error_code='calendar_reauth_required',
      updated_at=now() where workspace_id=$1 and user_id=$2 and provider=$3`,[scope.workspaceId,scope.actorId,provider]);
    await audit(tx,scope,row.id,"booking.calendar.reauth_required",provider);
  });
}
export async function refreshBookingCalendars(scope: TenantScope, provider: BookingProvider) {
  const {row,accessToken} = await usableToken(scope,provider);
  let calendars: BookingCalendar[];
  try { calendars = preserveReadOnlyCalendars(row.calendars,await discoverBookingCalendars(provider,accessToken,row.scopes)); }
  catch (error) { if (error instanceof BookingConnectionError && error.code === "calendar_reauth_required") await invalidateBookingConnection(scope,provider,Number(row.revision),accessToken); throw error; }
  const updated = await withTenantTransaction(scope,tx => tx.queryOne<ConnectionRow>(`update booking_calendar_connections
    set calendars=$5::jsonb,updated_at=now() where workspace_id=$1 and user_id=$2 and provider=$3 and revision=$4
    and status='connected' returning ${columns}`,[scope.workspaceId,scope.actorId,provider,row.revision,JSON.stringify(calendars)]));
  if (!updated) throw new BookingConnectionError("calendar_connection_changed");
  return {connection:metadata(updated),accessToken};
}
export async function selectBookingCalendars(scope: TenantScope, provider: BookingProvider, input: {writeCalendarId:string;conflictCalendarIds:string[]}) {
  if (!input || typeof input.writeCalendarId !== "string" || input.writeCalendarId.length>2048 ||
    !Array.isArray(input.conflictCalendarIds) || input.conflictCalendarIds.length>25 ||
    input.conflictCalendarIds.some(id => typeof id !== "string" || id.length>2048)) throw new BookingConnectionError("calendar_selection_invalid",400);
  const {connection} = await refreshBookingCalendars(scope,provider);
  const writer = connection.calendars.find(c => c.id === input.writeCalendarId);
  if (!writer?.canWrite || writer.protectedReadOnly || isProtectedBookingCalendar(writer.name)) throw new BookingConnectionError("calendar_write_forbidden",403);
  const conflicts = [...new Set(input.conflictCalendarIds)];
  if (conflicts.some(id => !connection.calendars.some(c => c.id === id && c.canRead))) throw new BookingConnectionError("calendar_conflict_forbidden",403);
  return withTenantTransaction(scope,async tx => {
    await bindingLock(tx,scope);
    const previous = await selectConnection(tx,scope,provider,true);
    if (!previous || Number(previous.revision) !== connection.revision || previous.status !== "connected")
      throw new BookingConnectionError("calendar_connection_changed");
    await assertBindingChangeAllowed(tx,scope,previous,previous.accountId,input.writeCalendarId);
    const row = await tx.queryOne<ConnectionRow>(`update booking_calendar_connections set write_calendar_id=$5,
      conflict_calendar_ids=$6,revision=revision+case when write_calendar_id is distinct from $5 then 1 else 0 end,
      updated_at=now() where workspace_id=$1 and user_id=$2 and provider=$3
      and revision=$4 and status='connected' returning ${columns}`,
    [scope.workspaceId,scope.actorId,provider,connection.revision,input.writeCalendarId,conflicts]);
    if (!row) throw new BookingConnectionError("calendar_connection_changed");
    await audit(tx,scope,row.id,"booking.calendar.selected",provider); return metadata(row);
  }).catch(calendarWriterConflict);
}
export async function getBookingCalendarAccess(scope: TenantScope, provider: BookingProvider) {
  const {connection,accessToken} = await refreshBookingCalendars(scope,provider);
  const calendar = connection.calendars.find(c => c.id === connection.writeCalendarId);
  if (!calendar?.canWrite || calendar.protectedReadOnly || isProtectedBookingCalendar(calendar.name)) throw new BookingConnectionError("calendar_write_unavailable");
  if (connection.conflictCalendarIds.some(id => !connection.calendars.some(c => c.id === id && c.canRead)))
    throw new BookingConnectionError("calendar_conflict_unavailable");
  return {connectionId:connection.id,userId:connection.userId,provider,accessToken,calendarId:calendar.id,
    conflictCalendarIds:connection.conflictCalendarIds,calendar,calendars:connection.calendars,
    accountId:connection.accountId,accountLabel:connection.accountLabel,revision:connection.revision};
}
export async function disconnectBookingConnection(scope: TenantScope, provider: BookingProvider) {
  return withTenantTransaction(scope,async tx => {
    await bindingLock(tx,scope);
    const row = await tx.queryOne<{id:string}>(`update booking_calendar_connections set status='disconnected',
      encrypted_tokens=null,expires_at=null,error_code=null,updated_at=now()
      where workspace_id=$1 and user_id=$2 and provider=$3 returning id`,
    [scope.workspaceId,scope.actorId,provider]);
    if (row) await audit(tx,scope,row.id,"booking.calendar.disconnected",provider);
    return {ok:true};
  });
}
export async function createBookingOAuthState(scope: TenantScope, provider: BookingProvider) {
  const signed = createSignedOAuthState({provider,returnTo:"/booking",userId:scope.actorId,workspaceId:scope.workspaceId});
  await withTenantTransaction(scope,tx => tx.execute(`insert into booking_oauth_authorization_states
    (state_hash,nonce_hash,provider,workspace_id,user_id,return_to,code_verifier_encrypted,expires_at)
    values($1,$2,$3,$4,$5,'/booking',$6,to_timestamp($7))`,[hashOAuthState(signed.state),hashOAuthState(signed.nonce),provider,
      scope.workspaceId,scope.actorId,encryptOAuthStateSecret(signed.codeVerifier),signed.expiresAt]));
  return {state:signed.state,codeChallenge:signed.codeChallenge};
}
export async function consumeBookingOAuthState(scope: TenantScope, provider: BookingProvider, value: string | null) {
  const parsed = parseSignedOAuthState(value,provider);
  if (!parsed || !value || parsed.returnTo !== "/booking" || parsed.userId !== scope.actorId || parsed.workspaceId !== scope.workspaceId) return null;
  const row = await withTenantTransaction(scope,tx => tx.queryOne<{encrypted:string}>(`update booking_oauth_authorization_states
    set consumed_at=now() where state_hash=$1 and nonce_hash=$2 and provider=$3 and workspace_id=$4 and user_id=$5
    and return_to='/booking' and consumed_at is null and expires_at>now() returning code_verifier_encrypted as encrypted`,
  [hashOAuthState(value),hashOAuthState(parsed.nonce),provider,scope.workspaceId,scope.actorId]));
  return row ? {codeVerifier:decryptOAuthStateSecret(row.encrypted),returnTo:"/booking",userId:scope.actorId,workspaceId:scope.workspaceId} : null;
}
