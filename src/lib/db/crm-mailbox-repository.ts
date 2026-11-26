import "server-only";
import { createHmac, randomUUID } from "node:crypto";
import type { AppSession } from "@/lib/auth/session";
import { assertCrmUuid, assertProjectGrant, crmPayloadDigest, CrmCommandError, executeCrmCommand, withCrmRead, type TenantTransaction, type TenantTransactionOptions } from "@/lib/crm-command";
import { hasMailboxReadScope, hasVerifiedMicrosoftMailboxScopes, mailboxConnectionPresentation, microsoftMailboxBindingReady, mailboxAddress, mailboxCursor, mailboxText, type MailboxImportedMessage, type MailboxProvider } from "@/lib/crm-mailbox";
import { assertOAuthStateSecretConfigured, createSignedOAuthState, decryptOAuthStateSecret, encryptOAuthStateSecret, hashOAuthState, parseSignedOAuthState } from "@/lib/integrations/calendar-oauth-state";
import { decryptSecret, encryptSecret } from "@/lib/integrations/secret-box";
import { exchangeMailboxToken, fetchMailboxAccountIdentity, fetchMailboxPage, mailboxAuthorizationUrl, mailboxOAuthConfigured, verifiedExternalMailboxMode, type MailboxTransport } from "@/lib/integrations/mailbox-provider";
import { recordSourceAutomationEvent } from "@/lib/automation/source-events";
import { microsoftMailboxClientAuthFields } from "@/lib/integrations/microsoft-client-auth";
import { microsoftMailboxClientId } from "@/lib/integrations/microsoft-client-auth-config";
import { MicrosoftIdentityError, verifyMicrosoftMailboxIdentity, type MicrosoftVerifiedIdentity } from "@/lib/integrations/microsoft-oidc-identity";
import { hasPersonalMailboxReviewSession } from "@/lib/db/mailbox-personal-review-access";
import { currentTenantTransaction } from "./transaction-context";
import { assertMailboxLeaseAfterLock } from "./crm-mailbox-lease-wall-clock";
import { mailboxHostConfigurationUnavailable } from "../crm-mailbox-sync";
import { assertProductionMailboxDatabase } from "./mailbox-production-target";
const returnTo = "/?mailbox=connected";
const verifiedReturnTo = "/?mailbox=connected&verified_identity=v1";
type Connection = { format?: string; tenantId?: string | null; subject?: string | null; accountId?: string | null; id: string; provider: MailboxProvider; accountLabel: string | null; status: string; scopes: string[]; access: string | null; refresh: string | null; expiresAt: string | null; revision: number; nextCursor: string | null };
const connectionSelect = `id,provider,account_label as "accountLabel",status,granted_scopes as scopes,access_token_encrypted as access,refresh_token_encrypted as refresh,expires_at::text as "expiresAt",revision,next_cursor as "nextCursor"`;
function actor(session: AppSession) { if (session.serviceIdentity || session.productRole === "external_partner") throw new CrmCommandError("FORBIDDEN", "Persönliche CRM-Anmeldung für das eigene Postfach erforderlich", 403); }
// The caller still has to use withCrmRead to lock and revalidate the session.
// Keeping this in the stored digest avoids exposing the session identifier in
// the provider-facing state or changing the shared calendar state format.
function verifiedMailboxStateHash(session: AppSession, state: string) {
  if (!hasPersonalMailboxReviewSession(session)) throw new CrmCommandError("MAIL_PERSONAL_SESSION_REQUIRED", "Persönliche CRM-Anmeldung für das Postfach erforderlich", 403);
  return createHmac("sha256", assertOAuthStateSecretConfigured())
    .update("crm-mailbox-oauth-session-v1\0")
    .update(JSON.stringify([state, session.workspaceId, session.userId, session.authIdentityId, session.authSessionId]))
    .digest("hex");
}
export function protectMailboxToken(session: AppSession, provider: MailboxProvider, token: string | null, accountLabel: string | null) { return token ? encryptSecret(JSON.stringify({ purpose: "crm-mailbox", workspaceId: session.workspaceId, userId: session.userId, provider, accountLabel, token })) : null; }
export function unprotectMailboxToken(session: AppSession, provider: MailboxProvider, value: string | null, accountLabel: string | null) {
  const raw = decryptSecret(value); if (!raw) return null;
  try { const parsed = JSON.parse(raw); if (parsed.purpose !== "crm-mailbox" || parsed.workspaceId !== session.workspaceId || parsed.userId !== session.userId || parsed.provider !== provider || parsed.accountLabel !== accountLabel || typeof parsed.token !== "string") throw new Error("context"); return parsed.token as string; } catch { throw new CrmCommandError("MAIL_TOKEN_CONTEXT", "Postfach erneut persönlich verbinden", 409); }
}
const protect = protectMailboxToken, unprotect = unprotectMailboxToken;
export async function loadCrmMailbox(tx: TenantTransaction, session: AppSession, messageId: string | null = null, page: { before?: string | null; decisionsBefore?: string | null } = {}) {
  actor(session);
  const rows = await tx.query<{ id:string; provider:MailboxProvider; accountLabel:string|null; status:string; scopes:unknown; verifiedMicrosoft:boolean; hasSubject:boolean; hasAccountId:boolean; checkPending:boolean }>(`select c.id,c.provider,c.account_label as "accountLabel",c.status,c.granted_scopes as scopes,c.expires_at as "expiresAt",c.last_synced_at as "lastSyncedAt",c.last_error as "lastError",c.next_cursor is not null as "hasOlder",c.revision,(to_jsonb(c)->>'provider_tenant_id') is not null as "verifiedMicrosoft",nullif(to_jsonb(c)->>'provider_subject','') is not null as "hasSubject",nullif(to_jsonb(c)->>'provider_account_id','') is not null as "hasAccountId",(c.sync_lease_until is not null or exists(select 1 from crm_mailbox_sync_runs r where r.connection_id=c.id and r.workspace_id=c.workspace_id and r.user_id=c.user_id and r.status='running')) as "checkPending" from crm_mailbox_connections c where c.workspace_id=$1::uuid and c.user_id=$2::uuid order by c.provider`, [session.workspaceId, session.userId]);
  let microsoftMode:boolean|null = null;
  if (rows.some(row => row.provider === "microsoft")) { try { microsoftMode = verifiedExternalMailboxMode(); } catch { /* A missing or contradictory configuration is not a verified connection. */ } }
  const connections = rows.map(row => ({ ...row, presentation: mailboxConnectionPresentation({ ...row, microsoftBindingReady: microsoftMailboxBindingReady(microsoftMode,row.verifiedMicrosoft,row.hasSubject,row.hasAccountId) }) }));
  let pageKey: { time:string; id:string } | null = null;
  if(page.before){try{const raw=JSON.parse(Buffer.from(page.before,'base64url').toString('utf8'));assertCrmUuid(raw.id);if(!Number.isFinite(Date.parse(raw.time)))throw new Error();pageKey=raw;}catch{throw new CrmCommandError('INVALID_CURSOR','Postfachseite prüfen');}}
  const messages = await tx.query<{id:string;receivedAt:string;preview:string}>(`select m.id,m.connection_id as "connectionId",m.subject,coalesce(to_jsonb(m)->>'source_status','in_inbox') as "sourceStatus",m.from_label as "fromLabel",m.from_address as "fromAddress",m.received_at as "receivedAt",left(m.body_text,200) as preview,m.body_truncated as "bodyTruncated",jsonb_array_length(m.attachments)::int as "attachmentCount",l.id as "linkId" from crm_mailbox_messages m left join crm_mailbox_links l on l.message_id=m.id and l.workspace_id=m.workspace_id and l.user_id=m.user_id where m.workspace_id=$1::uuid and m.user_id=$2::uuid and m.deleted_at is null and($3::timestamptz is null or(m.received_at,m.id)<($3::timestamptz,$4::uuid)) order by m.received_at desc,m.id desc limit 51`, [session.workspaceId, session.userId,pageKey?.time??null,pageKey?.id??null]);
  let detail: Record<string, unknown> | null = null;
  if (messageId) { assertCrmUuid(messageId); detail = await tx.queryOne(`select m.id,m.revision,m.subject,coalesce(to_jsonb(m)->>'source_status','in_inbox') as "sourceStatus",m.from_label as "fromLabel",m.from_address as "fromAddress",m.to_addresses as "toAddresses",m.received_at as "receivedAt",m.body_text as "bodyText",m.body_truncated as "bodyTruncated",m.attachments,l.id as "linkId",l.project_id as "projectId",l.lead_id as "leadId",l.confirmed_reply as "confirmedReply",l.review_reason as "reviewReason" from crm_mailbox_messages m left join crm_mailbox_links l on l.message_id=m.id and l.workspace_id=m.workspace_id and l.user_id=m.user_id where m.id=$1::uuid and m.workspace_id=$2::uuid and m.user_id=$3::uuid and m.deleted_at is null`, [messageId, session.workspaceId, session.userId]); if (!detail) throw new CrmCommandError("NOT_FOUND", "Persönliche Nachricht nicht verfügbar", 404); }
  const leads = session.permissions.includes("crm:write") ? await tx.query<{ id: string; projectId: string; contactId: string; label: string }>(`select l.id,l.project_id as "projectId",l.contact_id as "contactId",coalesce(nullif(c.name,''),'Anfrage ohne Namen')||' · '||p.name||' · '||coalesce(nullif(left(l.intent,80),''),l.source)||' · '||to_char(l.received_at,'YYYY-MM-DD HH24:MI') as label from leads l join contacts c on c.id=l.contact_id and c.workspace_id=l.workspace_id and c.project_id=l.project_id join projects p on p.id=l.project_id and p.workspace_id=l.workspace_id where l.workspace_id=$1::uuid and l.project_id is not null order by l.created_at desc limit 200`, [session.workspaceId]) : [];
  const runs = await tx.query(`select id,request_id as "requestId",connection_id as "connectionId",status,imported_count as "importedCount",last_error as "lastError",started_at as "startedAt",finished_at as "finishedAt" from crm_mailbox_sync_runs where workspace_id=$1::uuid and user_id=$2::uuid order by started_at desc limit 10`, [session.workspaceId, session.userId]);
  const auto = await (await import('./crm-mailbox-sync-repository')).loadMailboxAutoState(tx,session,page.decisionsBefore);
  const privateLinks=auto.ready?await tx.query<{messageId:string;status:string;label:string}>(`select d.message_id as "messageId",d.status,c.name as label from crm_mailbox_private_decisions d join leads l on l.workspace_id=d.workspace_id and l.project_id=d.project_id and l.id=d.lead_id join contacts c on c.workspace_id=l.workspace_id and c.project_id=l.project_id and c.id=l.contact_id where d.workspace_id=$1::uuid and d.user_id=$2::uuid and d.status in('suggested','filed') and d.message_id=any($3::uuid[])`,[session.workspaceId,session.userId,messages.map(row=>row.id)]):[];
  const shown=messages.slice(0,50).map(row=>({...row,privateLead:privateLinks.find(link=>link.messageId===row.id)??null})),last=shown.at(-1),nextPage=messages.length>50&&last?Buffer.from(JSON.stringify({time:last.receivedAt,id:last.id})).toString('base64url'):null;
  return { connections, messages:shown,nextPage,auto, detail, leads, runs, providers: ["google", "microsoft"].map((provider) => ({ provider, configured: mailboxOAuthConfigured(provider as MailboxProvider) })), canAssign: session.permissions.includes("crm:write"), canSuppress: false, attachmentsStored: false, sent: false };
}
export async function beginCrmMailboxOAuth(tx: TenantTransaction, session: AppSession, provider: MailboxProvider, requestUrl: string) {
  actor(session); if (!mailboxOAuthConfigured(provider)) throw new CrmCommandError("MAIL_NOT_CONFIGURED", "Postfach-OAuth ist noch nicht eingerichtet", 409);
  const verified = provider === "microsoft" && verifiedExternalMailboxMode();
  if (verified && !hasPersonalMailboxReviewSession(session)) throw new CrmCommandError("MAIL_PERSONAL_SESSION_REQUIRED", "Persönliche CRM-Anmeldung für das Postfach erforderlich", 403);
  await assertProductionMailboxDatabase(tx, provider);
  if (verified) { const ready = await tx.queryOne<{ ready: boolean }>(`select count(*)=3 as ready from information_schema.columns where table_name='crm_mailbox_connections' and column_name=any($1::text[])`, [["provider_tenant_id", "provider_subject", "provider_account_id"]]); if (!ready?.ready) throw new CrmCommandError("MAIL_IDENTITY_MIGRATION_REQUIRED", "Die sichere Postfach-Identität ist noch nicht verfügbar", 409); }
  const signed = createSignedOAuthState({ provider, userId: session.userId, workspaceId: session.workspaceId, returnTo: verified ? verifiedReturnTo : returnTo });
  await tx.query(`delete from crm_mailbox_oauth_states where workspace_id=$1::uuid and user_id=$2::uuid and expires_at<now()-interval '1 day'`, [session.workspaceId, session.userId]);
  await tx.query(`insert into crm_mailbox_oauth_states(state_hash,workspace_id,user_id,provider,nonce_hash,verifier_encrypted,expires_at) values($1,$2::uuid,$3::uuid,$4,$5,$6,to_timestamp($7))`, [verified ? verifiedMailboxStateHash(session, signed.state) : hashOAuthState(signed.state), session.workspaceId, session.userId, provider, hashOAuthState(signed.nonce), encryptOAuthStateSecret(signed.codeVerifier), signed.expiresAt]);
  return { authorizationUrl: mailboxAuthorizationUrl({ provider, requestUrl, state: signed.state, codeChallenge: signed.codeChallenge, ...(verified ? { verifiedExternalNonce: signed.nonce } : {}) }) };
}
export async function consumeCrmMailboxOAuth(tx: TenantTransaction, session: AppSession, provider: MailboxProvider, state: string) {
  actor(session); const parsed = parseSignedOAuthState(state, provider);
  const verified = provider === "microsoft" && verifiedExternalMailboxMode();
  const expectedReturnTo = verified ? verifiedReturnTo : returnTo;
  if (!parsed || parsed.userId !== session.userId || parsed.workspaceId !== session.workspaceId || parsed.returnTo !== expectedReturnTo) throw new CrmCommandError("MAIL_OAUTH_STATE", "Postfach-Verbindung erneut starten", 409);
  await assertProductionMailboxDatabase(tx, provider);
  const params = [verified ? verifiedMailboxStateHash(session, state) : hashOAuthState(state), hashOAuthState(parsed.nonce), session.workspaceId, session.userId, provider];
  if (verified) {
    // The row lock must finish before checking the wall clock. Evaluating
    // now() in the locking statement can use a transaction timestamp from
    // before a wait, and clock_timestamp() in its WHERE may also run before
    // the wait. The held lock prevents another consumer changing this row
    // between this read and the conditional update below.
    const locked = await tx.queryOne<{ stateHash: string }>(`select state_hash as "stateHash" from crm_mailbox_oauth_states where state_hash=$1 and nonce_hash=$2 and workspace_id=$3::uuid and user_id=$4::uuid and provider=$5 and consumed_at is null for update`, params);
    if (!locked) throw new CrmCommandError("MAIL_OAUTH_STATE", "Postfach-Verbindung abgelaufen oder bereits verwendet", 409);
  }
  const row = await tx.queryOne<{ verifier: string }>(verified
    ? `update crm_mailbox_oauth_states set consumed_at=clock_timestamp() where state_hash=$1 and nonce_hash=$2 and workspace_id=$3::uuid and user_id=$4::uuid and provider=$5 and consumed_at is null and expires_at>clock_timestamp() and to_timestamp($6::double precision)>clock_timestamp() returning verifier_encrypted as verifier`
    : `update crm_mailbox_oauth_states set consumed_at=now() where state_hash=$1 and nonce_hash=$2 and workspace_id=$3::uuid and user_id=$4::uuid and provider=$5 and consumed_at is null and expires_at>now() returning verifier_encrypted as verifier`, verified ? [...params, parsed.exp] : params);
  if (!row) throw new CrmCommandError("MAIL_OAUTH_STATE", "Postfach-Verbindung abgelaufen oder bereits verwendet", 409); return { codeVerifier: decryptOAuthStateSecret(row.verifier), verifiedNonce: parsed.returnTo === verifiedReturnTo ? parsed.nonce : null };
}
export async function saveCrmMailboxConnection(tx: TenantTransaction, session: AppSession, provider: MailboxProvider, tokens: { accessToken: string; refreshToken: string | null; scopes: string[]; expiresAt: string }, accountLabel: string, verified?: MicrosoftVerifiedIdentity) {
  actor(session); if (!hasMailboxReadScope(provider, tokens.scopes)) throw new CrmCommandError("MAIL_SCOPE_REQUIRED", "Kalenderrechte reichen nicht aus. Postfach-Lesezugriff ausdrücklich erlauben.", 409);
  if (mailboxAddress(accountLabel) !== accountLabel) throw new CrmCommandError("MAIL_ACCOUNT_REQUIRED", "Das vom Anbieter bestätigte Postfachkonto fehlt", 409);
  if (provider === "microsoft" && verifiedExternalMailboxMode() !== Boolean(verified)) throw new CrmCommandError("MAIL_REAUTH_REQUIRED", "Postfachidentität muss erneut sicher verbunden werden", 409);
  if (provider === "microsoft" && verified && !hasVerifiedMicrosoftMailboxScopes(tokens.scopes)) throw new CrmCommandError("MAIL_SCOPE_REQUIRED", "Nur Postfach-Lesezugriff ist für diese Verbindung zulässig.", 409);
  if (verified && !hasPersonalMailboxReviewSession(session)) throw new CrmCommandError("MAIL_PERSONAL_SESSION_REQUIRED", "Persönliche CRM-Anmeldung für das Postfach erforderlich", 403);
  await assertProductionMailboxDatabase(tx, provider);
  const identitySchema = provider === "microsoft" ? await tx.queryOne<{ ready: boolean }>(`select count(*)=2 as ready from information_schema.columns where table_name='crm_mailbox_connections' and column_name=any($1::text[])`, [["provider_tenant_id", "provider_subject"]]) : null;
  if (verified && (!identitySchema?.ready || provider !== "microsoft")) throw new CrmCommandError("MAIL_IDENTITY_MIGRATION_REQUIRED", "Sichere Postfachidentität nicht verfügbar", 409);
  const extraColumns = verified ? ",provider_tenant_id,provider_subject,provider_account_id" : "";
  const extraValues = verified ? ",$9::uuid,$10,$11" : "";
  const conflictGuard = verified ? " where crm_mailbox_connections.provider_tenant_id=excluded.provider_tenant_id and crm_mailbox_connections.provider_subject=excluded.provider_subject and crm_mailbox_connections.provider_account_id=excluded.provider_account_id" : identitySchema?.ready ? " where crm_mailbox_connections.provider_tenant_id is null and crm_mailbox_connections.provider_subject is null" : "";
  const row = await tx.queryOne<{ id: string; revision: number }>(`insert into crm_mailbox_connections(workspace_id,user_id,provider,account_label,status,granted_scopes,access_token_encrypted,refresh_token_encrypted,expires_at${extraColumns}) values($1::uuid,$2::uuid,$3,$4,'connected',$5::jsonb,$6,$7,$8${extraValues}) on conflict(workspace_id,user_id,provider,account_label) do update set account_label=excluded.account_label,status='connected',granted_scopes=excluded.granted_scopes,access_token_encrypted=excluded.access_token_encrypted,refresh_token_encrypted=excluded.refresh_token_encrypted,expires_at=excluded.expires_at,revision=crm_mailbox_connections.revision+1,next_cursor=null,last_error=null,sync_lease_id=null,sync_lease_until=null,updated_at=now()${conflictGuard} returning id,revision`, [session.workspaceId, session.userId, provider, accountLabel, JSON.stringify(tokens.scopes), protect(session, provider, tokens.accessToken, accountLabel), protect(session, provider, tokens.refreshToken, accountLabel), tokens.expiresAt, ...(verified ? [verified.tenantId, verified.subject, verified.objectId] : [])]);
  if (!row) throw new CrmCommandError("MAIL_SAVE_UNCONFIRMED", "Persönliche Postfachverbindung nicht bestätigt", 503); return row;
}
export async function finishCrmMailboxOAuth(session: AppSession, provider: MailboxProvider, state: string, code: string, requestUrl: string, options?: TenantTransactionOptions, transport?: MailboxTransport, microsoftAuth = microsoftMailboxClientAuthFields, verifyIdentity = verifyMicrosoftMailboxIdentity) {
  const consumed = await withCrmRead(session, (tx, fresh) => consumeCrmMailboxOAuth(tx, fresh, provider, state), options);
  const tokens = await exchangeMailboxToken({ provider, code, codeVerifier: consumed.codeVerifier, requestUrl, ...(consumed.verifiedNonce ? { verifiedMicrosoftAuthority: "common" } : {}) }, transport, microsoftAuth);
  // Revalidation cannot cancel an external request after its lock ends.
  const revalidatePersonalSession = () => withCrmRead(session, async (tx, fresh) => {
    actor(fresh);
    if (!hasPersonalMailboxReviewSession(fresh) || !verifiedExternalMailboxMode()) throw new CrmCommandError("MAIL_PERSONAL_SESSION_REQUIRED", "Persönliche CRM-Anmeldung für das Postfach erforderlich", 403);
    await assertProductionMailboxDatabase(tx, provider);
  }, options);
  // Recheck after each earlier network boundary before starting the next one.
  if (consumed.verifiedNonce) await revalidatePersonalSession();
  const verified = consumed.verifiedNonce ? await verifyIdentity({ flow: "authorization", idToken: tokens.idToken || "", clientId: microsoftMailboxClientId(), expectedNonce: consumed.verifiedNonce }) : undefined;
  if (consumed.verifiedNonce) {
    if (!verified) throw new CrmCommandError("MAIL_REAUTH_REQUIRED", "Postfachidentität konnte nicht bestätigt werden", 409);
    await revalidatePersonalSession();
  }
  const identity = await fetchMailboxAccountIdentity(provider, tokens.accessToken, transport);
  if (verified && identity.accountId.toLowerCase() !== verified.objectId.toLowerCase()) throw new CrmCommandError("MAIL_ACCOUNT_CHANGED", "Bestätigtes Microsoft-Konto stimmt nicht überein", 409);
  return withCrmRead(session, async (tx, fresh) => {
    await assertProductionMailboxDatabase(tx, provider);
    const schema = await tx.queryOne<{ ready: boolean }>(`select exists(select 1 from information_schema.columns where table_name='crm_mailbox_connections' and column_name='provider_account_id') as ready`);
    const verifiedSchema = provider === "microsoft" ? await tx.queryOne<{ ready: boolean }>(`select count(*)=2 as ready from information_schema.columns where table_name='crm_mailbox_connections' and column_name=any($1::text[])`, [["provider_tenant_id", "provider_subject"]]) : null;
    if (verified && !verifiedSchema?.ready) throw new CrmCommandError("MAIL_IDENTITY_MIGRATION_REQUIRED", "Sichere Postfachidentität nicht verfügbar", 409);
    if (schema?.ready) {
      const prior = await tx.queryOne<{ id: string; label: string; accountId: string | null; tenantId?: string | null; subject?: string | null }>(`select id,account_label as label,provider_account_id as "accountId"${verifiedSchema?.ready ? ',provider_tenant_id::text as "tenantId",provider_subject as subject' : ''} from crm_mailbox_connections where workspace_id=$1::uuid and user_id=$2::uuid and provider=$3 and(account_label=$4 or provider_account_id=$5) for update`, [fresh.workspaceId,fresh.userId,provider,identity.label,identity.accountId]);
      if (prior && (prior.accountId && prior.accountId !== identity.accountId || prior.label !== identity.label)) throw new CrmCommandError("MAIL_ACCOUNT_CHANGED", "Das Anbieterkonto oder seine Adresse hat sich geändert. Bestehende Privatkopien werden nicht einem anderen Konto zugewiesen.", 409);
      if (prior && (verified ? prior.tenantId !== verified.tenantId || prior.subject !== verified.subject : Boolean(prior.tenantId))) throw new CrmCommandError("MAIL_ACCOUNT_CHANGED", "Eine bestehende oder anders bestätigte Postfachidentität darf nicht überschrieben werden.", 409);
    }
    const saved = await saveCrmMailboxConnection(tx, fresh, provider, tokens, identity.label, verified);
    if (schema?.ready) { await tx.query(`update crm_mailbox_connections set provider_account_id=$2,revision=revision+1 where id=$1::uuid`, [saved.id,identity.accountId]); await tx.query(`update crm_mailbox_auto_settings set enabled=false,status='disabled',revision=revision+1,updated_at=now() where connection_id=$1::uuid`,[saved.id]); }
    return saved;
  }, options);
}
export async function disconnectCrmMailbox(tx: TenantTransaction, session: AppSession, id: string) {
  actor(session); assertCrmUuid(id); const row = await tx.queryOne(`update crm_mailbox_connections set status='disconnected',access_token_encrypted=null,refresh_token_encrypted=null,next_cursor=null,sync_lease_id=null,sync_lease_until=null,revision=revision+1,updated_at=now() where id=$1::uuid and workspace_id=$2::uuid and user_id=$3::uuid returning id,status`, [id, session.workspaceId, session.userId]);
  if (!row) throw new CrmCommandError("NOT_FOUND", "Eigenes Postfach nicht verfügbar", 404); return row;
}
export async function syncCrmMailbox(session: AppSession, input: { connectionId: string; requestId: string; mode: "latest" | "older" }, options?: TenantTransactionOptions, transport?: MailboxTransport, verifyIdentity = verifyMicrosoftMailboxIdentity, microsoftAuth = microsoftMailboxClientAuthFields) {
  assertCrmUuid(input.connectionId); assertCrmUuid(input.requestId); if (!["latest", "older"].includes(input.mode)) throw new CrmCommandError("INVALID_MODE", "Abrufmodus prüfen");
  if (currentTenantTransaction()) throw new CrmCommandError("MAIL_SYNC_NESTED_TRANSACTION", "Postfachabgleich benötigt eigene kurze Transaktionen", 409);
  const hash = crmPayloadDigest(input), leaseId = randomUUID();
  const claim = await withCrmRead(session, async (tx, fresh) => {
    actor(fresh); const c = await tx.queryOne<Connection>(`select ${connectionSelect},coalesce(to_jsonb(crm_mailbox_connections)->>'provider_id_format','legacy') as format,to_jsonb(crm_mailbox_connections)->>'provider_tenant_id' as "tenantId",to_jsonb(crm_mailbox_connections)->>'provider_subject' as subject,to_jsonb(crm_mailbox_connections)->>'provider_account_id' as "accountId" from crm_mailbox_connections where id=$1::uuid and workspace_id=$2::uuid and user_id=$3::uuid for update`, [input.connectionId, fresh.workspaceId, fresh.userId]);
    if (!c || c.status !== "connected" || !hasMailboxReadScope(c.provider, c.scopes)) throw new CrmCommandError("MAIL_SCOPE_REQUIRED", "Postfach erneut mit ausdrücklich erlaubtem Mail-Lesezugriff verbinden", 409);
    if (c.provider === "microsoft") { const mode = verifiedExternalMailboxMode(); if (mode !== Boolean(c.tenantId) || c.tenantId && (!c.subject || !c.accountId)) throw new CrmCommandError("MAIL_REAUTH_REQUIRED", "Postfachidentität muss erneut sicher verbunden werden", 409); if (mode && !hasVerifiedMicrosoftMailboxScopes(c.scopes)) throw new CrmCommandError("MAIL_SCOPE_REQUIRED", "Nur Postfach-Lesezugriff ist für diese Verbindung zulässig.", 409); }
    await assertProductionMailboxDatabase(tx, c.provider);
    const prior = await tx.queryOne<{ id: string; status: string; hash: string; importedCount: number }>(`select id,status,request_hash as hash,imported_count as "importedCount" from crm_mailbox_sync_runs where workspace_id=$1::uuid and user_id=$2::uuid and request_id=$3::uuid for update`, [fresh.workspaceId, fresh.userId, input.requestId]);
    if (prior && prior.hash !== hash) throw new CrmCommandError("IDEMPOTENCY_CONFLICT", "Abrufkennung gehört zu einem anderen Vorgang", 409);
    if (prior?.status === "succeeded") return { completed: true as const, result: { id: prior.id, status: prior.status, importedCount: prior.importedCount, replayed: true } };
    // The locking read may have waited. Evaluate expiry only after the row lock
    // is held; PostgreSQL now() is fixed at transaction start.
    const currentLease = await tx.queryOne<{ busy: boolean }>(`select coalesce(sync_lease_until>clock_timestamp(),false) as busy from crm_mailbox_connections where id=$1::uuid and workspace_id=$2::uuid and user_id=$3::uuid and status='connected' and revision=$4`, [c.id, fresh.workspaceId, fresh.userId, c.revision]);
    if (!currentLease) throw new CrmCommandError("MAIL_CONNECTION_CHANGED", "Postfachverbindung oder Abrufberechtigung hat sich geändert", 409);
    if (currentLease.busy) throw new CrmCommandError("MAIL_SYNC_BUSY", "Dieses Postfach wird gerade abgerufen. Gleich erneut prüfen.", 409);
    if (input.mode === "older" && !c.nextCursor) throw new CrmCommandError("NO_OLDER_PAGE", "Keine weitere ältere Seite verfügbar", 409);
    const id = prior?.id ?? randomUUID();
    await tx.query(`insert into crm_mailbox_sync_runs(id,workspace_id,user_id,connection_id,request_id,request_hash,status,lease_id) values($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6,'running',$7::uuid) on conflict(workspace_id,user_id,request_id) do update set status='running',lease_id=excluded.lease_id,last_error=null,finished_at=null`, [id, fresh.workspaceId, fresh.userId, c.id, input.requestId, hash, leaseId]);
    const leased = await tx.queryOne<{ revision: number }>(`update crm_mailbox_connections set sync_lease_id=$2::uuid,sync_lease_until=clock_timestamp()+interval '2 minutes',revision=revision+1 where id=$1::uuid and workspace_id=$3::uuid and user_id=$4::uuid and status='connected' and revision=$5 and (sync_lease_until is null or sync_lease_until<=clock_timestamp()) returning revision`, [c.id, leaseId, fresh.workspaceId, fresh.userId, c.revision]);
    if (!leased || leased.revision !== c.revision + 1) throw new CrmCommandError("MAIL_CONNECTION_CHANGED", "Postfachverbindung oder Abrufberechtigung hat sich geändert", 409);
    return { completed: false as const, id, connection: { ...c, revision: leased.revision }, actor: fresh };
  }, options);
  if (claim.completed) return claim.result;
  try {
    const c = claim.connection;
    // The claim transaction can be delayed before or during COMMIT. Recheck
    // the row lock, current actor, lease and identity before provider I/O.
    await withCrmRead(session, async (tx, fresh) => {
      actor(fresh);
      await assertProductionMailboxDatabase(tx, c.provider);
      const active = await tx.queryOne<{ tenantId: string | null; subject: string | null; accountId: string | null }>(`select to_jsonb(crm_mailbox_connections)->>'provider_tenant_id' as "tenantId",to_jsonb(crm_mailbox_connections)->>'provider_subject' as subject,to_jsonb(crm_mailbox_connections)->>'provider_account_id' as "accountId" from crm_mailbox_connections where id=$1::uuid and workspace_id=$2::uuid and user_id=$3::uuid and status='connected' and revision=$4 and sync_lease_id=$5::uuid and sync_lease_until>clock_timestamp() for update`, [c.id, fresh.workspaceId, fresh.userId, c.revision, leaseId]);
      if (!active || c.provider === "microsoft" && (verifiedExternalMailboxMode() !== Boolean(active.tenantId) || active.tenantId !== (c.tenantId ?? null) || active.subject !== (c.subject ?? null) || active.accountId !== (c.accountId ?? null))) throw new CrmCommandError("MAIL_CONNECTION_CHANGED", "Postfachidentität oder Abrufberechtigung hat sich geändert", 409);
      await assertMailboxLeaseAfterLock(tx, { id: c.id, workspaceId: fresh.workspaceId, userId: fresh.userId, revision: c.revision, lease: leaseId });
    }, options);
    let accessToken = unprotect(claim.actor, c.provider, c.access, c.accountLabel); let renewed: Awaited<ReturnType<typeof exchangeMailboxToken>> | null = null;
    const expectedIdentity = c.tenantId && c.accountId && c.subject ? { tenantId: c.tenantId, objectId: c.accountId, subject: c.subject } : null;
    if (!c.expiresAt || Date.parse(c.expiresAt) <= Date.now() + 60000) {
      const refresh = unprotect(claim.actor, c.provider, c.refresh, c.accountLabel); if (!refresh) throw new CrmCommandError("MAIL_REAUTH_REQUIRED", "Postfach erneut verbinden", 409);
      renewed = await exchangeMailboxToken({ provider: c.provider, refreshToken: refresh, priorScopes: c.scopes, ...(expectedIdentity ? { verifiedMicrosoftAuthority: expectedIdentity.tenantId } : {}) }, transport, microsoftAuth);
      if (expectedIdentity) { try { await verifyIdentity({ flow: "refresh", idToken: renewed.idToken || "", clientId: microsoftMailboxClientId(), expectedIdentity }); } catch (error) { const unavailable = error instanceof MicrosoftIdentityError && error.code === "MICROSOFT_IDENTITY_UNAVAILABLE"; throw new CrmCommandError(unavailable ? "MAIL_PROVIDER_UNAVAILABLE" : "MAIL_REAUTH_REQUIRED", "Postfachidentität konnte nicht bestätigt werden", unavailable ? 503 : 409); } }
      accessToken = renewed.accessToken;
    }
    if (!accessToken) throw new CrmCommandError("MAIL_REAUTH_REQUIRED", "Postfach erneut verbinden", 409);
    if (expectedIdentity) { const account = await fetchMailboxAccountIdentity(c.provider, accessToken, transport); if (account.accountId.toLowerCase() !== expectedIdentity.objectId.toLowerCase() || account.label !== c.accountLabel) throw new CrmCommandError("MAIL_ACCOUNT_CHANGED", "Postfachidentität stimmt nicht mehr überein", 409); }
    // A later page fetch can fail after Microsoft has issued a replacement
    // refresh token. Persist it first only for the externally verified flow,
    // after checking the account and revalidating the live lease and binding.
    // Legacy connections retain their existing behavior until they have an
    // equally strong identity boundary.
    if (renewed && c.provider === "microsoft" && expectedIdentity) {
      if (!renewed.refreshToken?.trim()) throw new CrmCommandError("MAIL_PROVIDER_UNAVAILABLE", "Postfach-Erneuerung konnte nicht bestätigt werden", 503);
      c.revision = await withCrmRead(session, async (tx, fresh) => {
        actor(fresh);
        await assertProductionMailboxDatabase(tx, c.provider);
        const active = await tx.queryOne<{ tenantId: string | null; subject: string | null; accountId: string | null }>(`select to_jsonb(crm_mailbox_connections)->>'provider_tenant_id' as "tenantId",to_jsonb(crm_mailbox_connections)->>'provider_subject' as subject,to_jsonb(crm_mailbox_connections)->>'provider_account_id' as "accountId" from crm_mailbox_connections where id=$1::uuid and workspace_id=$2::uuid and user_id=$3::uuid and status='connected' and revision=$4 and sync_lease_id=$5::uuid and sync_lease_until>clock_timestamp() for update`, [c.id, fresh.workspaceId, fresh.userId, c.revision, leaseId]);
        if (!active || !verifiedExternalMailboxMode() || active.tenantId !== c.tenantId || active.subject !== c.subject || active.accountId !== c.accountId) throw new CrmCommandError("MAIL_CONNECTION_CHANGED", "Postfachidentität oder Abrufberechtigung hat sich geändert", 409);
        // SELECT FOR UPDATE can wait past lease expiry. PostgreSQL's now() is
        // fixed at transaction start, so recheck wall-clock expiry in the
        // guarded UPDATE after the row lock is held and require a returned row.
        const updated = await tx.queryOne<{ revision: number }>(`update crm_mailbox_connections set revision=revision+1,access_token_encrypted=$6,refresh_token_encrypted=$7,granted_scopes=$8::jsonb,expires_at=$9::timestamptz,updated_at=now() where id=$1::uuid and workspace_id=$2::uuid and user_id=$3::uuid and status='connected' and revision=$4 and sync_lease_id=$5::uuid and sync_lease_until>clock_timestamp() returning revision`, [c.id, fresh.workspaceId, fresh.userId, c.revision, leaseId, protect(fresh, c.provider, renewed!.accessToken, c.accountLabel), protect(fresh, c.provider, renewed!.refreshToken, c.accountLabel), JSON.stringify(renewed!.scopes), renewed!.expiresAt]);
        if (!updated || updated.revision !== c.revision + 1) throw new CrmCommandError("MAIL_CONNECTION_CHANGED", "Postfachidentität oder Abrufberechtigung hat sich geändert", 409);
        return updated.revision;
      }, options);
    }
    const page = await fetchMailboxPage({ provider: c.provider, accessToken, grantedScopes: renewed?.scopes ?? c.scopes, cursor: input.mode === "older" ? c.nextCursor : null, immutableIds: c.format === "immutable" }, transport);
    return await withCrmRead(session, async (tx, fresh) => {
      await assertProductionMailboxDatabase(tx, c.provider);
      actor(fresh); const active = await tx.queryOne<{ tenantId: string | null; subject: string | null; accountId: string | null }>(`select to_jsonb(crm_mailbox_connections)->>'provider_tenant_id' as "tenantId",to_jsonb(crm_mailbox_connections)->>'provider_subject' as subject,to_jsonb(crm_mailbox_connections)->>'provider_account_id' as "accountId" from crm_mailbox_connections where id=$1::uuid and workspace_id=$2::uuid and user_id=$3::uuid and status='connected' and revision=$4 and sync_lease_id=$5::uuid and sync_lease_until>clock_timestamp() for update`, [c.id, fresh.workspaceId, fresh.userId, c.revision, leaseId]);
      if (!active) throw new CrmCommandError("MAIL_CONNECTION_CHANGED", "Verbindung geändert. Verspätete Nachrichten wurden nicht übernommen.", 409);
      if (c.provider === "microsoft" && (verifiedExternalMailboxMode() !== Boolean(active.tenantId) || active.tenantId !== (c.tenantId ?? null) || active.subject !== (c.subject ?? null) || active.accountId !== (c.accountId ?? null))) throw new CrmCommandError("MAIL_CONNECTION_CHANGED", "Postfachidentität hat sich geändert", 409);
      let count = 0; for (const message of page.messages) count += await persistMailboxMessage(tx, fresh, c.id, message);
      if(c.format==='immutable')await tx.query(`update crm_mailbox_messages set provider_id_format='immutable' where connection_id=$1::uuid and provider_id=any($2::text[])`,[c.id,page.messages.map(message=>message.providerId)]);
      const completed = await tx.queryOne<{ revision: number }>(`update crm_mailbox_connections set next_cursor=$2,last_synced_at=now(),last_error=null,sync_lease_id=null,sync_lease_until=null,revision=revision+1,access_token_encrypted=coalesce($3,access_token_encrypted),refresh_token_encrypted=coalesce($4,refresh_token_encrypted),granted_scopes=coalesce($5::jsonb,granted_scopes),expires_at=coalesce($6::timestamptz,expires_at),updated_at=now() where id=$1::uuid and workspace_id=$7::uuid and user_id=$8::uuid and status='connected' and revision=$9 and sync_lease_id=$10::uuid and sync_lease_until>clock_timestamp() returning revision`, [c.id, mailboxCursor(c.provider, page.nextCursor, page.verifiedInboxId), renewed ? protect(fresh, c.provider, renewed.accessToken, c.accountLabel) : null, renewed ? protect(fresh, c.provider, renewed.refreshToken, c.accountLabel) : null, renewed ? JSON.stringify(renewed.scopes) : null, renewed?.expiresAt ?? null, fresh.workspaceId, fresh.userId, c.revision, leaseId]);
      if (!completed || completed.revision !== c.revision + 1) throw new CrmCommandError("MAIL_CONNECTION_CHANGED", "Postfachidentität oder Abrufberechtigung hat sich geändert", 409);
      await tx.query(`update crm_mailbox_sync_runs set status='succeeded',imported_count=$3,finished_at=now(),last_error=null where id=$1::uuid and lease_id=$2::uuid`, [claim.id, leaseId, count]);
      return { id: claim.id, status: "succeeded", importedCount: count, replayed: false };
    }, options);
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" && /^[A-Z_]{3,80}$/.test(error.code) ? error.code : "MAIL_SYNC_FAILED";
    const hostConfigurationUnavailable = mailboxHostConfigurationUnavailable(code);
    const needsReauthorization = !hostConfigurationUnavailable && /SCOPE|AUTH|TOKEN_CONTEXT/.test(code);
    await withCrmRead(session, async (tx, fresh) => {
      await assertProductionMailboxDatabase(tx, claim.connection.provider);
      await tx.query(`update crm_mailbox_sync_runs set status='failed',last_error=$3,finished_at=now() where id=$1::uuid and lease_id=$2::uuid`, [claim.id, leaseId, code]);
      await tx.query(`update crm_mailbox_connections set last_error=$3,sync_lease_id=null,sync_lease_until=null,revision=revision+1,status=case when $4 then 'reauthorization_required' else status end,access_token_encrypted=case when $4 then null else access_token_encrypted end,refresh_token_encrypted=case when $4 then null else refresh_token_encrypted end where id=$1::uuid and sync_lease_id=$2::uuid`, [input.connectionId, leaseId, code, needsReauthorization]);
      return fresh.userId;
    }, options).catch(() => undefined);
    if (error instanceof CrmCommandError) throw error;
    throw new CrmCommandError(code, needsReauthorization && (code.includes("SCOPE") || code.includes("AUTH")) ? "Postfach-Lesezugriff erneut persönlich erlauben" : "Postfachabruf nicht bestätigt. Verlauf prüfen und denselben Vorgang erneut versuchen.", needsReauthorization || /CONNECTION_CHANGED/.test(code) ? 409 : 503);
  }
}
async function persistMailboxMessage(tx: TenantTransaction, session: AppSession, connectionId: string, message: MailboxImportedMessage) {
  const saved = await tx.queryOne(`insert into crm_mailbox_messages(workspace_id,user_id,connection_id,provider_id,thread_id,internet_message_id,subject,from_label,from_address,to_addresses,received_at,body_text,body_truncated,attachments,content_hash) values($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13,$14::jsonb,$15) on conflict(connection_id,provider_id) do nothing returning id`, [session.workspaceId, session.userId, connectionId, message.providerId, message.threadId, message.internetMessageId, message.subject, message.fromLabel, message.fromAddress, JSON.stringify(message.toAddresses), message.receivedAt, message.bodyText, message.bodyTruncated, JSON.stringify(message.attachments), crmPayloadDigest(message)]);
  return saved ? 1 : 0;
}
export async function eraseCrmMailboxCopy(tx: TenantTransaction, session: AppSession, id: string) {
  actor(session); assertCrmUuid(id); const row = await tx.queryOne(`update crm_mailbox_messages set subject='',from_label='',from_address=null,to_addresses='[]',thread_id=null,internet_message_id=null,body_text='',attachments='[]',deleted_at=coalesce(deleted_at,now()),revision=revision+1 where id=$1::uuid and workspace_id=$2::uuid and user_id=$3::uuid returning id`, [id, session.workspaceId, session.userId]);
  if (!row) throw new CrmCommandError("NOT_FOUND", "Eigene importierte Kopie nicht verfügbar", 404); return row;
}
export async function associateCrmMailboxMessage(session: AppSession, input: Record<string, unknown>, metadata: { idempotencyKey: string; correlationId: string }, options?: TenantTransactionOptions) {
  const messageId = assertCrmUuid(input.messageId), projectId = assertCrmUuid(input.projectId), leadId = assertCrmUuid(input.leadId);
  return executeCrmCommand(session, { ...metadata, operation: "mailbox.associate_reviewed_message", projectId, resourceId: messageId, capability: "workspace:operate", payload: input }, async (tx, context) => {
    actor(context.session); await assertProjectGrant(tx, context.session, projectId, true);
    if (input.reviewed !== true || typeof input.confirmedReply !== "boolean" || typeof input.reason !== "string" || input.reason.trim().length < 10 || input.reason.length > 1000) throw new CrmCommandError("MAIL_REVIEW_REQUIRED", "Zuordnung ausdrücklich prüfen und begründen", 409);
    const message = await tx.queryOne(`select id from crm_mailbox_messages where id=$1::uuid and workspace_id=$2::uuid and user_id=$3::uuid and deleted_at is null for update`, [messageId, context.workspaceId, context.actorId]);
    const lead = await tx.queryOne<{ contactId: string }>(`select l.contact_id as "contactId" from leads l join contacts c on c.id=l.contact_id and c.workspace_id=l.workspace_id and c.project_id=l.project_id where l.id=$1::uuid and l.project_id=$2::uuid and l.workspace_id=$3::uuid for key share of l,c`, [leadId, projectId, context.workspaceId]);
    if (!message || !lead) throw new CrmCommandError("MAIL_TARGET_UNAVAILABLE", "Eigene Nachricht und aktuelle berechtigte Anfrage erforderlich", 403);
    const prior = await tx.queryOne<{ id: string }>(`select id from crm_mailbox_links where message_id=$1::uuid and workspace_id=$2::uuid and user_id=$3::uuid`, [messageId, context.workspaceId, context.actorId]);
    if (prior) throw new CrmCommandError("MAIL_ALREADY_ASSOCIATED", "Nachricht wurde bereits manuell zugeordnet", 409);
    const link = await tx.queryOne<{ id: string }>(`insert into crm_mailbox_links(workspace_id,user_id,message_id,project_id,lead_id,contact_id,review_reason,confirmed_reply) values($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6::uuid,$7,$8) returning id`, [context.workspaceId, context.actorId, messageId, projectId, leadId, lead.contactId, mailboxText(input.reason, 1000), input.confirmedReply]);
    if (!link) throw new CrmCommandError("SAVE_UNCONFIRMED", "Zuordnung nicht bestätigt", 503);
    await tx.query(`insert into contact_timeline_items(workspace_id,project_id,contact_id,channel,title,detail,outcome,metadata) values($1::uuid,$2::uuid,$3::uuid,'email','E-Mail manuell zugeordnet',$4,'info',$5::jsonb)`, [context.workspaceId, projectId, lead.contactId, mailboxText(input.reason, 1000), JSON.stringify({ source: "mailbox_manual_review", linkId: link.id, senderIdentityVerified: false, confirmedReply: input.confirmedReply })]);
    if (input.confirmedReply) await recordSourceAutomationEvent(context.session, { projectId, leadId, eventId: `mailbox-confirmed-reply:${link.id}`, trigger: "reply_received" });
    return { id: link.id, contactId: lead.contactId, leadId, confirmedReply: input.confirmedReply, senderIdentityVerified: false };
  }, options);
}
