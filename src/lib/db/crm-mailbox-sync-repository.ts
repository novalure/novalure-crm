import "server-only";
import { randomUUID } from "node:crypto";
import type { AppSession } from "../auth/session";
import { assertCrmUuid, CrmCommandError, crmPayloadDigest, withCrmRead, type TenantTransaction, type TenantTransactionOptions } from "../crm-command";
import { hasMailboxReadScope, hasVerifiedMicrosoftMailboxScopes, type MailboxImportedMessage, type MailboxProvider } from "../crm-mailbox";
import { assertMicrosoftMailboxCheckpoint, assertMicrosoftReadyCheckpoint, assertMicrosoftRecovery, MailboxCheckpointReviewRequired, contactBackfillCheckpoint, emptyMailboxCheckpoint, mailboxCursorResetAllowed, mailboxSyncCurrent, mailboxSyncFailureStatus, mailboxSyncPosition, microsoftCheckpointUsesContinuation, microsoftContactBackfillCheckpoint, microsoftRecoveryReplay, queueMicrosoftMailboxDecision, type MailboxMetadata, type MailboxSyncCheckpoint, type MailboxSyncDecision } from "../crm-mailbox-sync";
import { exchangeMailboxToken, fetchMailboxAccountIdentity, MailboxProviderError, verifiedExternalMailboxMode, type MailboxTransport } from "../integrations/mailbox-provider";
import { assertProductionMailboxDatabase } from "./mailbox-production-target";
import { fetchMailboxInboxId, fetchMailboxKnownContent, fetchMailboxMetadata, fetchMailboxSyncPage, translateMailboxLegacyIds } from "../integrations/mailbox-sync-provider";
import { protectMailboxToken, unprotectMailboxToken } from "./crm-mailbox-repository";
import { MicrosoftIdentityError, sameMicrosoftMailboxGuid, verifyMicrosoftMailboxIdentity } from "../integrations/microsoft-oidc-identity";
import { microsoftClientAuthFields } from "../integrations/microsoft-client-auth";
import { microsoftMailboxClientId } from "../integrations/microsoft-client-auth-config";
import { assessMailboxObjectionReview } from "../mailbox-objection-review";
import { hasPersonalMailboxReviewSession } from "./mailbox-personal-review-access";
import { assertMailboxLeaseAfterLock } from "./crm-mailbox-lease-wall-clock";
import { currentTenantTransaction } from "./transaction-context";
type Options = TenantTransactionOptions & { transport?: MailboxTransport; maxPages?: number; budgetMs?: number; ignoreDue?: boolean; verifyIdentity?: typeof verifyMicrosoftMailboxIdentity; microsoftAuth?: typeof microsoftClientAuthFields };
type Claim = { id: string; provider: MailboxProvider; tenantId: string | null; subject: string | null; label: string; accountId: string | null; format: string; access: string; refresh: string | null; scopes: string[]; expiresAt: string; revision: number; policyRevision: number; identityId: string; autoFile: boolean; contactReview: boolean; backfillReplaying: boolean; checkpoint: MailboxSyncCheckpoint; lease: string; failures: number };
type CursorRecovery = { phase:'baseline'|'verify'|'replay'; ceilingId:string|null; lastId:string|null; baseline:MailboxSyncCheckpoint|null };
function requireMicrosoftBinding(provider: MailboxProvider, tenantId: string | null, subject: string | null, accountId: string | null) {
 if(provider==='microsoft' && (verifiedExternalMailboxMode() !== Boolean(tenantId) || tenantId && (!subject || !accountId))) throw new CrmCommandError('MAIL_REAUTH_REQUIRED','Postfachidentität muss erneut sicher verbunden werden',409);
}
const personal = (session: AppSession) => { if (session.serviceIdentity || session.productRole === "external_partner") throw new CrmCommandError("FORBIDDEN", "Eigenes persönliches Postfach erforderlich", 403); };
export async function mailboxSyncSchemaReady(tx: TenantTransaction) { const row = await tx.queryOne<{ ready: boolean }>(`select to_regclass('public.crm_mailbox_auto_settings') is not null as ready`); return row?.ready === true; }
export async function saveMailboxAutoSettings(tx: TenantTransaction, session: AppSession, input: { connectionId: string; enabled: boolean; autoFile: boolean; contactReview?: boolean; expectedRevision: number }) {
  personal(session); assertCrmUuid(input.connectionId);
  if (!await mailboxSyncSchemaReady(tx)) throw new CrmCommandError("MAIL_SYNC_MIGRATION_REQUIRED", "Die Datenbank für den automatischen Eingang ist noch nicht aktualisiert", 409);
  if (typeof input.enabled !== "boolean" || typeof input.autoFile !== "boolean" || input.contactReview !== undefined && typeof input.contactReview !== "boolean" || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) throw new CrmCommandError("INVALID_INPUT", "Persönliche Eingangseinstellungen prüfen");
  const connection = await tx.queryOne<{ id: string; connected: boolean; provider: MailboxProvider; tenantId: string | null; subject: string | null; accountId: string | null; scopes:string[] }>(`select id,provider,granted_scopes as scopes,to_jsonb(crm_mailbox_connections)->>'provider_tenant_id' as "tenantId",to_jsonb(crm_mailbox_connections)->>'provider_subject' as subject,to_jsonb(crm_mailbox_connections)->>'provider_account_id' as "accountId",status='connected' as connected from crm_mailbox_connections where id=$1::uuid and workspace_id=$2::uuid and user_id=$3::uuid for update`, [input.connectionId,session.workspaceId,session.userId]);
  const identity = await tx.queryOne<{ id: string }>(`select auth_identity_id as id from crm_lock_active_member($1::uuid,$2::uuid)`,[session.workspaceId,session.userId]);
  if (!connection || !identity?.id || input.enabled && !connection.connected) throw new CrmCommandError("MAIL_PERSONAL_CONSENT_REQUIRED", "Ein aktives persönlich verbundenes Konto ist erforderlich", 409);
  if (input.enabled) {
    requireMicrosoftBinding(connection.provider, connection.tenantId, connection.subject, connection.accountId);
    if (connection.provider === "microsoft" && connection.tenantId && !hasVerifiedMicrosoftMailboxScopes(connection.scopes)) {
      throw new CrmCommandError("MAIL_SCOPE_REQUIRED", "Nur Postfach-Lesezugriff ist für diese Verbindung zulässig.", 409);
    }
    await assertProductionMailboxDatabase(tx, connection.provider);
  }
  const feature = await tx.queryOne<{ready:boolean}>(`select to_regprocedure('public.crm_mailbox_contact_review_guard_ready()') is not null as ready`);
  if (input.contactReview === true && !feature?.ready) throw new CrmCommandError("MAIL_CONTACT_REVIEW_MIGRATION_REQUIRED", "Kontaktprüfung benötigt eine Datenbankaktualisierung", 409);
  const prior = await tx.queryOne<{ revision: number; contactReview: boolean }>(`select revision,coalesce((to_jsonb(s)->>'contact_review_enabled')::boolean,false) as "contactReview" from crm_mailbox_auto_settings s where connection_id=$1::uuid for update`,[input.connectionId]);
  if ((prior?.revision ?? 0) !== input.expectedRevision) throw new CrmCommandError("VERSION_CONFLICT", "Einstellungen wurden geändert. Ansicht neu laden.", 409);
  const saved = await tx.queryOne(`insert into crm_mailbox_auto_settings(workspace_id,user_id,connection_id,identity_id,enabled,auto_file,status) values($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,$6,$7) on conflict(workspace_id,user_id,connection_id) do update set identity_id=excluded.identity_id,enabled=excluded.enabled,auto_file=excluded.auto_file,status=case when excluded.enabled then 'catching_up' else 'disabled' end,next_run_at=now(),revision=crm_mailbox_auto_settings.revision+1,updated_at=now() returning revision,enabled,auto_file as "autoFile",status`,[session.workspaceId,session.userId,input.connectionId,identity.id,input.enabled,input.autoFile,input.enabled?'not_initialized':'disabled']);
  if (feature?.ready) {
    const contactReview = input.contactReview ?? prior?.contactReview ?? false;
    // A previously checked inbox needs one complete rescan after contact opt-in;
    // never discard an in-flight delta page. Complete that page first below.
    const newlyEnabled = contactReview && !prior?.contactReview;
    await tx.query(`update crm_mailbox_auto_settings set contact_review_enabled=$2,contact_review_backfill_pending=case when not $2 then false when $3 then exists(select 1 from crm_mailbox_auto_checkpoints where connection_id=$1::uuid and folder='inbox') else contact_review_backfill_pending end,revision=revision+1,updated_at=now() where connection_id=$1::uuid`,[input.connectionId,contactReview,newlyEnabled]);
  }
  // An opt-out takes the same row lock as every page commit and invalidates in-flight claims.
  await tx.query(`update crm_mailbox_connections set sync_lease_id=null,sync_lease_until=null,revision=revision+1 where id=$1::uuid`,[input.connectionId]);
  return feature?.ready ? await tx.queryOne(`select revision,enabled,auto_file as "autoFile",contact_review_enabled as "contactReview",status from crm_mailbox_auto_settings where connection_id=$1::uuid`,[input.connectionId]) : saved;
}
export async function loadMailboxAutoState(tx: TenantTransaction, session: AppSession, before?: string | null) {
  if (!await mailboxSyncSchemaReady(tx)) return { ready:false,contactReviewReady:false,settings:[],decisions:[],moreDecisions:null };
  const contactFeature=await tx.queryOne<{ready:boolean}>(`select to_regprocedure('public.crm_mailbox_contact_review_guard_ready()') is not null as ready`);
  let key: { time: string; id: string } | null = null;
  if (before) { try { const raw=JSON.parse(Buffer.from(before,"base64url").toString("utf8")); assertCrmUuid(raw.id); if (!Number.isFinite(Date.parse(raw.time))) throw new Error(); key=raw; } catch { throw new CrmCommandError("INVALID_CURSOR","Prüflistenseite prüfen"); } }
  const settings = await tx.query(`select connection_id as "connectionId",enabled,auto_file as "autoFile",coalesce((to_jsonb(s)->>'contact_review_enabled')::boolean,false) as "contactReview",revision,status,last_success_at as "lastSuccessAt",next_run_at as "nextRunAt",last_error as "lastError" from crm_mailbox_auto_settings s where workspace_id=$1::uuid and user_id=$2::uuid`,[session.workspaceId,session.userId]);
  const decisions=await tx.query<{id:string;updatedAt:string;status:string;reason:string;projectId:string|null;contactId:string|null;contactName:string|null}>(`select d.id,d.connection_id as "connectionId",d.message_id as "messageId",d.status,case when d.reason='exact_address_unique_contact_unverified_sender' and c.id is null then 'contact_match_no_longer_unique' else d.reason end as reason,d.subject,d.updated_at::text as "updatedAt",case when l.id is not null then d.lead_id end as "leadId",case when l.id is not null or c.id is not null then d.project_id end as "projectId",case when c.id is not null then c.id end as "contactId",case when c.id is not null then c.name end as "contactName",d.rule_version as "ruleVersion" from crm_mailbox_private_decisions d left join leads l on l.workspace_id=d.workspace_id and l.project_id=d.project_id and l.id=d.lead_id left join crm_mailbox_messages m on m.workspace_id=d.workspace_id and m.user_id=d.user_id and m.id=d.message_id and m.deleted_at is null left join contacts c on c.workspace_id=d.workspace_id and c.project_id=d.project_id and c.id=d.contact_id and c.archived_at is null and m.from_address=lower(btrim(c.email)) and crm_project_access(c.workspace_id,c.project_id,false) and crm_classification_allowed(c.workspace_id,c.data_classification,c.data_purpose) and exists(select 1 from projects cp where cp.workspace_id=c.workspace_id and cp.id=c.project_id and crm_classification_allowed(cp.workspace_id,cp.data_classification,cp.data_purpose)) and (select count(*) from contacts u where u.workspace_id=c.workspace_id and u.archived_at is null and lower(btrim(u.email))=lower(btrim(c.email)) and crm_classification_allowed(u.workspace_id,u.data_classification,u.data_purpose) and ((u.project_id is not null and crm_project_access(u.workspace_id,u.project_id,false) and exists(select 1 from projects up where up.workspace_id=u.workspace_id and up.id=u.project_id and crm_classification_allowed(up.workspace_id,up.data_classification,up.data_purpose))) or (u.project_id is null and u.owner_user_id=nullif(current_setting('app.actor_id',true),'')::uuid)))=1 where d.workspace_id=$1::uuid and d.user_id=$2::uuid and d.status in('suggested','review','quarantined') and($3::timestamptz is null or(d.updated_at,d.id)<($3::timestamptz,$4::uuid)) order by d.updated_at desc,d.id desc limit 51`,[session.workspaceId,session.userId,key?.time??null,key?.id??null]);
  let hostScopes:Record<string,unknown>[]=[];try{const value=JSON.parse(process.env.NOVALURE_MAILBOX_SYNC_SCOPES||'[]');if(Array.isArray(value))hostScopes=value;}catch{}
  const shown=decisions.slice(0,50),last=shown.at(-1);return {ready:true,contactReviewReady:contactFeature?.ready===true,settings,hostConnectionIds:hostScopes.filter(scope=>scope.workspaceId===session.workspaceId&&scope.actorId===session.userId).map(scope=>scope.connectionId),decisions:shown,moreDecisions:decisions.length>50&&last?Buffer.from(JSON.stringify({time:last.updatedAt,id:last.id})).toString('base64url'):null};
}
/** Private, unverified contact suggestions; never an asserted campaign reply. */
export async function loadContactMailboxReview(tx: TenantTransaction, session: AppSession, contactId: string) {
  personal(session); assertCrmUuid(contactId);
  const contact = await tx.queryOne<{ projectId: string | null }>(`select project_id as "projectId" from contacts where workspace_id=$1::uuid and id=$2::uuid and archived_at is null`, [session.workspaceId,contactId]);
  if (!contact) throw new CrmCommandError("NOT_FOUND", "Berechtigter Kontakt nicht verfügbar", 404);
  if (!contact.projectId) {
    // This is a private, read-only address hint from copies already imported
    // by this mailbox owner. It neither proves the sender nor records a reply
    // or an objection. The route calls this inside withCrmRead, which locks and
    // revalidates the personal session and workspace membership.
    if (!hasPersonalMailboxReviewSession(session)) throw new CrmCommandError("PERSONAL_SESSION_REQUIRED", "Für persönliche Postfachhinweise bitte anmelden.", 401);
    const active = currentTenantTransaction();
    if (!active || active.transaction !== tx || active.scope.workspaceId !== session.workspaceId || active.scope.actorId !== session.userId) throw new CrmCommandError("TENANT_MISMATCH", "Persönlicher Arbeitsbereich erforderlich", 403);
    // Hold the currently authorized contact through the private lookup. A
    // concurrent archive, owner transfer, classification or address change
    // must not race a stale hint from the earlier contact read.
    const locked = await tx.queryOne<{id:string}>(`select c.id from contacts c where c.workspace_id=$1::uuid and c.id=$2::uuid and c.project_id is null and c.archived_at is null and crm_classification_allowed(c.workspace_id,c.data_classification,c.data_purpose) and (crm_workspace_manager(c.workspace_id) or c.owner_user_id=$3::uuid) for share of c`,[session.workspaceId,contactId,session.userId]);
    if (!locked) throw new CrmCommandError("NOT_FOUND", "Berechtigter Kontakt nicht verfügbar", 404);
    // Match within one statement so the contact's currently visible address
    // and the returned private copies come from the same SQL snapshot. This
    // intentionally does not consult or disclose other contacts with the same
    // address and does not assume an inbox copy is a current provider state.
    const items = await tx.query<{id:string;subject:string;receivedAt:string}>(`select m.id,m.subject,m.received_at::text as "receivedAt" from contacts c join crm_mailbox_messages m on m.workspace_id=c.workspace_id and m.user_id=$2::uuid and lower(btrim(m.from_address))=lower(btrim(c.email)) where c.workspace_id=$1::uuid and c.id=$3::uuid and c.project_id is null and c.archived_at is null and c.email is not null and btrim(c.email)<>'' and m.deleted_at is null and crm_classification_allowed(c.workspace_id,c.data_classification,c.data_purpose) and (crm_workspace_manager(c.workspace_id) or c.owner_user_id=$2::uuid) order by m.received_at desc,m.id desc limit 11`,[session.workspaceId,session.userId,contactId]);
    return { available: true, source: "personal_imported_address_match" as const, items: items.slice(0,10), hasMore: items.length > 10, canBlock: false };
  }
  const ready = await tx.queryOne<{ready:boolean}>(`select to_regprocedure('public.crm_mailbox_contact_review_guard_ready()') is not null as ready`);
  if (!ready?.ready) return { available: false, items: [] };
  const items = await tx.query<{ id: string; subject: string; receivedAt: string }>(`select m.id,m.subject,m.received_at::text as "receivedAt" from crm_mailbox_private_decisions d join crm_mailbox_messages m on m.workspace_id=d.workspace_id and m.user_id=d.user_id and m.id=d.message_id join contacts c on c.workspace_id=d.workspace_id and c.project_id=d.project_id and c.id=d.contact_id join projects p on p.workspace_id=c.workspace_id and p.id=c.project_id where d.workspace_id=$1::uuid and d.user_id=$2::uuid and d.contact_id=$3::uuid and d.project_id=$4::uuid and d.lead_id is null and d.status='review' and d.reason='exact_address_unique_contact_unverified_sender' and m.deleted_at is null and c.archived_at is null and lower(btrim(c.email))=m.from_address and crm_project_access(c.workspace_id,c.project_id,false) and crm_classification_allowed(c.workspace_id,c.data_classification,c.data_purpose) and crm_classification_allowed(p.workspace_id,p.data_classification,p.data_purpose) and (select count(*) from contacts u where u.workspace_id=c.workspace_id and u.archived_at is null and lower(btrim(u.email))=lower(btrim(c.email)) and crm_classification_allowed(u.workspace_id,u.data_classification,u.data_purpose) and ((u.project_id is not null and crm_project_access(u.workspace_id,u.project_id,false) and exists(select 1 from projects up where up.workspace_id=u.workspace_id and up.id=u.project_id and crm_classification_allowed(up.workspace_id,up.data_classification,up.data_purpose))) or (u.project_id is null and u.owner_user_id=nullif(current_setting('app.actor_id',true),'')::uuid)))=1 order by m.received_at desc,m.id desc limit 10`, [session.workspaceId,session.userId,contactId,contact.projectId]);
  return { available: true, items };
}
export async function actOnMailboxPrivateDecision(tx:TenantTransaction,session:AppSession,input:{decisionId:string;action:'file_private'|'retry_private'}){
 personal(session);const id=assertCrmUuid(input.decisionId);const row=await tx.queryOne<{connectionId:string;providerId:string;status:string;projectId:string|null;leadId:string|null}>(`select connection_id as "connectionId",provider_id as "providerId",status,project_id as "projectId",lead_id as "leadId" from crm_mailbox_private_decisions where id=$1::uuid and workspace_id=$2::uuid and user_id=$3::uuid for update`,[id,session.workspaceId,session.userId]);if(!row)throw new CrmCommandError('NOT_FOUND','Eigener Prüfbeleg nicht verfügbar',404);
 if(input.action==='file_private'){
  const target=row.leadId?await tx.queryOne(`select id from leads where workspace_id=$1::uuid and project_id=$2::uuid and id=$3::uuid`,[session.workspaceId,row.projectId,row.leadId]):null;if(!target||!['suggested','filed'].includes(row.status))throw new CrmCommandError('MAIL_TARGET_UNAVAILABLE','Aktuelle eindeutige private Zuordnung erforderlich',409);
  await tx.query(`update crm_mailbox_private_decisions set status='filed',reason='personally_confirmed_private_filing',updated_at=now() where id=$1::uuid`,[id]);return {id,status:'filed',shared:false};
 }
 const c=await tx.queryOne<{busy:boolean;provider:MailboxProvider}>(`select provider,sync_lease_until>now() as busy from crm_mailbox_connections where id=$1::uuid and status='connected' for update`,[row.connectionId]);if(!c||c.busy)throw new CrmCommandError('MAIL_SYNC_BUSY','Verbindung wird gerade abgeglichen oder benötigt erneute Zustimmung',409);
 const checkpoint=await tx.queryOne<{checkpoint:MailboxSyncCheckpoint}>(`select checkpoint from crm_mailbox_auto_checkpoints where connection_id=$1::uuid and folder='inbox' for update`,[row.connectionId]);let state=checkpoint?.checkpoint??emptyMailboxCheckpoint();
 if(c.provider==='microsoft'){
  try{state=queueMicrosoftMailboxDecision(state,row.providerId);}catch(error){if(error instanceof MailboxCheckpointReviewRequired){await tx.query(`update crm_mailbox_auto_settings set enabled=false,status='review',last_error='MAIL_CHECKPOINT_REVIEW_REQUIRED',revision=revision+1,updated_at=now() where connection_id=$1::uuid`,[row.connectionId]);return {id,status:'checkpoint_review',shared:false};}throw error;}
 }else if(!state.queued.some(change=>change.id===row.providerId)){if(!state.afterQueue)state.afterQueue={phase:state.phase,bootstrapCursor:state.bootstrapCursor,anchor:state.anchor,historyCheckpoint:state.historyCheckpoint,pendingCursor:state.pendingCursor,deltaCheckpoint:state.deltaCheckpoint};state.queued.unshift({id:row.providerId});}
 await tx.query(`insert into crm_mailbox_auto_checkpoints(workspace_id,user_id,connection_id,checkpoint) values($1::uuid,$2::uuid,$3::uuid,$4::jsonb) on conflict(workspace_id,user_id,connection_id,folder) do update set checkpoint=excluded.checkpoint,updated_at=now()`,[session.workspaceId,session.userId,row.connectionId,JSON.stringify(state)]);await tx.query(`update crm_mailbox_auto_settings set next_run_at=now(),status='catching_up',revision=revision+1,updated_at=now() where connection_id=$1::uuid`,[row.connectionId]);return {id,status:'queued',shared:false};
}
type Lead = { leadId: string; projectId: string; contactId: string };
async function decide(tx: TenantTransaction, session: AppSession, claim: Claim, meta: MailboxMetadata): Promise<MailboxSyncDecision> {
  const result=(status:MailboxSyncDecision['status'],reason:string,lead?:Lead,automatic=false):MailboxSyncDecision=>({status,reason,leadId:lead?.leadId??null,projectId:lead?.projectId??null,contactId:lead?.contactId??null,automatic});
  const prior=await tx.queryOne<{deleted:boolean; leadId:string|null;projectId:string|null;contactId:string|null}>(`select m.deleted_at is not null as deleted,coalesce(l.lead_id,d.lead_id) as "leadId",coalesce(l.project_id,d.project_id) as "projectId",coalesce(l.contact_id,d.contact_id) as "contactId" from crm_mailbox_messages m left join crm_mailbox_links l on l.workspace_id=m.workspace_id and l.user_id=m.user_id and l.message_id=m.id left join crm_mailbox_private_decisions d on d.workspace_id=m.workspace_id and d.user_id=m.user_id and d.message_id=m.id and d.status='filed' where m.connection_id=$1::uuid and m.provider_id=$2`,[claim.id,meta.providerId]);
  if(prior?.deleted)return result('ignored','locally_erased');
  if(prior?.leadId){const current=await tx.queryOne<Lead>(`select id as "leadId",project_id as "projectId",contact_id as "contactId" from leads where workspace_id=$1::uuid and id=$2::uuid and project_id=$3::uuid`,[session.workspaceId,prior.leadId,prior.projectId]);return current?result('known','existing_personal_association_preserved',current,true):result('review','lead_permission_changed');}
  const candidates=meta.fromAddress?await tx.query<Lead>(`select l.id as "leadId",l.project_id as "projectId",l.contact_id as "contactId" from leads l join contacts c on c.workspace_id=l.workspace_id and c.project_id=l.project_id and c.id=l.contact_id where l.workspace_id=$1::uuid and lower(btrim(c.email))=$2 and l.project_id is not null and l.status not in('Verloren','Abgeschlossen','Archiviert') limit 3`,[session.workspaceId,meta.fromAddress]):[];
  const thread=meta.threadId?await tx.query<Lead & {fromAddress:string|null;toAddresses:string[];internetMessageId:string|null}>(`select distinct l.lead_id as "leadId",l.project_id as "projectId",l.contact_id as "contactId",m.from_address as "fromAddress",m.to_addresses as "toAddresses",m.internet_message_id as "internetMessageId" from crm_mailbox_messages m join crm_mailbox_links l on l.workspace_id=m.workspace_id and l.user_id=m.user_id and l.message_id=m.id join leads lead on lead.workspace_id=l.workspace_id and lead.project_id=l.project_id and lead.id=l.lead_id where m.connection_id=$1::uuid and m.thread_id=$2 and m.deleted_at is null limit 21`,[claim.id,meta.threadId]):[];
  if(thread.length>20)return result('review','thread_requires_extended_review');
  const threadLeads=[...new Set(thread.map(row=>row.leadId))],refs=[...(meta.inReplyTo?[meta.inReplyTo]:[]),...meta.references];
  const refLeads=refs.length?await tx.query<{leadId:string}>(`select distinct l.lead_id as "leadId" from crm_mailbox_messages m join crm_mailbox_links l on l.workspace_id=m.workspace_id and l.user_id=m.user_id and l.message_id=m.id join leads lead on lead.workspace_id=l.workspace_id and lead.project_id=l.project_id and lead.id=l.lead_id where m.connection_id=$1::uuid and m.internet_message_id=any($2::text[]) and m.deleted_at is null limit 3`,[claim.id,refs]):[];
  if(candidates.length>1||threadLeads.length>1)return result('review','multiple_authorized_leads');
  // Contact-only suggestions require the dedicated guard migration. The exact
  // address is a hint, never proof of sender identity or a campaign reply.
  const contactSchema=await tx.queryOne<{ready:boolean}>(`select to_regprocedure('public.crm_mailbox_contact_review_guard_ready()') is not null as ready`);
  const contacts=claim.contactReview&&contactSchema?.ready&&meta.fromAddress?await tx.query<{contactId:string;projectId:string|null}>(`select c.id as "contactId",c.project_id as "projectId" from contacts c where c.workspace_id=$1::uuid and c.archived_at is null and lower(btrim(c.email))=$2 and crm_classification_allowed(c.workspace_id,c.data_classification,c.data_purpose) and (c.project_id is null or exists(select 1 from projects p where p.workspace_id=c.workspace_id and p.id=c.project_id and crm_classification_allowed(p.workspace_id,p.data_classification,p.data_purpose))) and (crm_project_access(c.workspace_id,c.project_id,false) or (c.project_id is null and c.owner_user_id=nullif(current_setting('app.actor_id',true),'')::uuid)) limit 3`,[session.workspaceId,meta.fromAddress]):[];
  if(contacts.length>1)return result('review','multiple_authorized_contacts');
  const target=thread[0]||candidates[0];if(refLeads.some(row=>row.leadId!==target?.leadId)||thread[0]&&candidates[0]&&thread[0].leadId!==candidates[0].leadId)return result('review','contradictory_thread_or_reply_headers');
  if(thread.length){const known=new Set(thread.flatMap(row=>[...(row.fromAddress?[row.fromAddress]:[]),...row.toAddresses]));if(meta.participants.some(address=>!known.has(address))||!meta.fromAddress||!known.has(meta.fromAddress))return result('review','new_thread_participant');return result('known','reviewed_thread_same_participants',thread[0],claim.autoFile);}
  if(candidates.length===1)return result('known','exact_address_unique_lead_unverified_sender',candidates[0],claim.autoFile);
  if(contacts.length===1&&contacts[0].projectId)return {status:'known',reason:'exact_address_unique_contact_unverified_sender',leadId:null,projectId:contacts[0].projectId,contactId:contacts[0].contactId,automatic:false};
  return result('ignored','unknown_sender_no_content_import');
}
async function verify(tx:TenantTransaction,session:AppSession,claim:Claim){
 await assertProductionMailboxDatabase(tx, claim.provider);
  const row=await tx.queryOne<{tenantId:string|null;subject:string|null;accountId:string|null}>(`select to_jsonb(c)->>'provider_tenant_id' as "tenantId",to_jsonb(c)->>'provider_subject' as subject,c.provider_account_id as "accountId" from crm_mailbox_connections c join crm_mailbox_auto_settings s on s.connection_id=c.id and s.workspace_id=c.workspace_id and s.user_id=c.user_id join workspace_users u on u.workspace_id=s.workspace_id and u.id=s.user_id where c.id=$1::uuid and c.workspace_id=$2::uuid and c.user_id=$3::uuid and c.status='connected' and c.revision=$4 and c.sync_lease_id=$5::uuid and c.sync_lease_until>clock_timestamp() and s.enabled and s.revision=$6 and s.identity_id=$7::uuid and u.auth_identity_id=s.identity_id and u.status='active' and crm_mailbox_delegated_identity(c.workspace_id,c.user_id)=s.identity_id for update of c,s`,[claim.id,session.workspaceId,session.userId,claim.revision,claim.lease,claim.policyRevision,claim.identityId]);
  if(!row)throw new CrmCommandError('MAIL_CONNECTION_CHANGED','Persönliche Freigabe oder Verbindung geändert. Verspäteter Import wurde verworfen.',409);
  requireMicrosoftBinding(claim.provider,row.tenantId,row.subject,row.accountId);if(row.tenantId!==claim.tenantId||row.subject!==claim.subject||row.accountId!==claim.accountId)throw new CrmCommandError('MAIL_CONNECTION_CHANGED','Postfachidentität hat sich geändert',409);
  await assertMailboxLeaseAfterLock(tx,{id:claim.id,workspaceId:session.workspaceId,userId:session.userId,revision:claim.revision,lease:claim.lease});
}
// Guard state changes before and after the work while the connection and
// policy rows are locked. Publish claim changes only after COMMIT succeeds;
// failed/uncertain commits must not advance the caller's in-memory version.
async function withFencedWrite<T>(session:AppSession,claim:Claim,options:Options,work:(tx:TenantTransaction,fresh:AppSession,staged:Claim)=>Promise<T>):Promise<T>{
 if(currentTenantTransaction())throw new CrmCommandError('MAIL_SYNC_NESTED_TRANSACTION','Postfachabgleich benötigt eigene kurze Transaktionen',409);
 const staged=structuredClone(claim);
 const result=await withCrmRead(session,async(tx,fresh)=>{await verify(tx,fresh,staged);const value=await work(tx,fresh,staged);await verify(tx,fresh,staged);return value;},options);
 Object.assign(claim,staged);return result;
}
async function decisionRecord(tx:TenantTransaction,session:AppSession,claim:Claim,id:string,status:string,reason:string,meta?:MailboxMetadata,decision?:MailboxSyncDecision,messageId?:string){
  await tx.query(`insert into crm_mailbox_private_decisions(workspace_id,user_id,connection_id,provider_id,message_id,project_id,lead_id,contact_id,status,reason,subject,metadata) values($1::uuid,$2::uuid,$3::uuid,$4,$5::uuid,$6::uuid,$7::uuid,$8::uuid,$9,$10,$11,$12::jsonb) on conflict(connection_id,provider_id) do update set message_id=coalesce(excluded.message_id,crm_mailbox_private_decisions.message_id),project_id=excluded.project_id,lead_id=excluded.lead_id,contact_id=excluded.contact_id,status=excluded.status,reason=excluded.reason,subject=excluded.subject,metadata=excluded.metadata,updated_at=now()`,[session.workspaceId,session.userId,claim.id,id,messageId??null,decision?.projectId??null,decision?.leadId??null,decision?.contactId??null,status,reason,status==='ignored'?'':meta?.subject??'',JSON.stringify(meta&&status!=='ignored'?{inReplyTo:meta.inReplyTo,references:meta.references,participants:meta.participants,senderIdentityVerified:false}:{} )]);
}
async function saveContent(tx:TenantTransaction,session:AppSession,claim:Claim,message:MailboxImportedMessage,meta:MailboxMetadata){
 const row=await tx.queryOne<{id:string}>(`insert into crm_mailbox_messages(workspace_id,user_id,connection_id,provider_id,provider_id_format,thread_id,internet_message_id,subject,from_label,from_address,to_addresses,received_at,body_text,body_truncated,attachments,content_hash,reply_headers) values($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14,$15::jsonb,$16,$17::jsonb) on conflict(connection_id,provider_id) do update set thread_id=excluded.thread_id,internet_message_id=excluded.internet_message_id,subject=excluded.subject,from_label=excluded.from_label,from_address=excluded.from_address,to_addresses=excluded.to_addresses,received_at=excluded.received_at,body_text=excluded.body_text,body_truncated=excluded.body_truncated,attachments=excluded.attachments,content_hash=excluded.content_hash,reply_headers=excluded.reply_headers,source_status='in_inbox',revision=crm_mailbox_messages.revision+1 where crm_mailbox_messages.deleted_at is null returning id`,[session.workspaceId,session.userId,claim.id,message.providerId,claim.provider==='microsoft'?'immutable':'legacy',message.threadId,message.internetMessageId,message.subject,message.fromLabel,message.fromAddress,JSON.stringify(message.toAddresses),message.receivedAt,message.bodyText,message.bodyTruncated,JSON.stringify(message.attachments),crmPayloadDigest(message),JSON.stringify({inReplyTo:meta.inReplyTo,references:meta.references})]);return row?.id;
}
export async function runPersonalMailboxSync(session:AppSession,connectionId:string,options:Options={}){
 personal(session);assertCrmUuid(connectionId);if(currentTenantTransaction())throw new CrmCommandError('MAIL_SYNC_NESTED_TRANSACTION','Postfachabgleich benötigt eigene kurze Transaktionen',409);const lease=randomUUID(),started=Date.now(),maxPages=Math.max(1,Math.min(5,options.maxPages??5)),budget=Math.max(1000,Math.min(30000,options.budgetMs??30000));
 const claim=await withCrmRead(session,async(tx,fresh)=>{
  if(!await mailboxSyncSchemaReady(tx))throw new CrmCommandError('MAIL_SYNC_MIGRATION_REQUIRED','Automatischer Eingang benötigt Datenbankaktualisierung',409);
  const c=await tx.queryOne<Omit<Claim,'checkpoint'|'lease'> & {busy:boolean;due:boolean;enabled:boolean}>(`select c.id,c.provider,to_jsonb(c)->>'provider_tenant_id' as "tenantId",to_jsonb(c)->>'provider_subject' as subject,c.account_label as label,c.provider_account_id as "accountId",c.provider_id_format as format,c.access_token_encrypted as access,c.refresh_token_encrypted as refresh,c.granted_scopes as scopes,c.expires_at::text as "expiresAt",c.revision,s.revision as "policyRevision",s.identity_id as "identityId",s.auto_file as "autoFile",coalesce((to_jsonb(s)->>'contact_review_enabled')::boolean,false) as "contactReview",coalesce((to_jsonb(s)->>'contact_review_backfill_replaying')::boolean,false) as "backfillReplaying",s.failure_count as failures,s.enabled,s.next_run_at<=now() as due,c.sync_lease_until>now() as busy from crm_mailbox_connections c join crm_mailbox_auto_settings s on s.connection_id=c.id and s.workspace_id=c.workspace_id and s.user_id=c.user_id join workspace_users u on u.workspace_id=s.workspace_id and u.id=s.user_id where c.id=$1::uuid and c.workspace_id=$2::uuid and c.user_id=$3::uuid and c.status='connected' and s.identity_id=u.auth_identity_id and u.status='active' for update of c,s`,[connectionId,fresh.workspaceId,fresh.userId]);
  if(!c?.enabled||!c.due&&!options.ignoreDue)return null;if(c.busy)return null;requireMicrosoftBinding(c.provider,c.tenantId,c.subject,c.accountId);if(!hasMailboxReadScope(c.provider,c.scopes)||c.provider==='microsoft'&&c.tenantId&&!hasVerifiedMicrosoftMailboxScopes(c.scopes)||fresh.authIdentityId!==c.identityId)throw new CrmCommandError('MAIL_PERSONAL_CONSENT_REQUIRED','Aktuelle persönliche Identitätsbindung und Mail-Leserecht erforderlich',403);
  await assertProductionMailboxDatabase(tx, c.provider);
  const checkpoint=await tx.queryOne<{checkpoint:MailboxSyncCheckpoint}>(`select checkpoint from crm_mailbox_auto_checkpoints where connection_id=$1::uuid and folder='inbox'`,[connectionId]);
  const leased=await tx.queryOne<{revision:number}>(`update crm_mailbox_connections c set sync_lease_id=$2::uuid,sync_lease_until=clock_timestamp()+interval '2 minutes',revision=revision+1 where c.id=$1::uuid and c.workspace_id=$3::uuid and c.user_id=$4::uuid and c.status='connected' and c.revision=$5 and (c.sync_lease_until is null or c.sync_lease_until<=clock_timestamp()) and exists(select 1 from crm_mailbox_auto_settings s join workspace_users u on u.workspace_id=s.workspace_id and u.id=s.user_id where s.connection_id=c.id and s.workspace_id=c.workspace_id and s.user_id=c.user_id and s.enabled and s.revision=$6 and s.identity_id=$7::uuid and (s.next_run_at<=clock_timestamp() or $8::boolean) and u.status='active' and u.auth_identity_id=s.identity_id and crm_mailbox_delegated_identity(c.workspace_id,c.user_id)=s.identity_id) returning c.revision`,[connectionId,lease,fresh.workspaceId,fresh.userId,c.revision,c.policyRevision,c.identityId,Boolean(options.ignoreDue)]);
  if(!leased||leased.revision!==c.revision+1)throw new CrmCommandError('MAIL_CONNECTION_CHANGED','Persönliche Freigabe oder Verbindung geändert. Postfach erneut prüfen.',409);
  return {...c,revision:leased.revision,checkpoint:checkpoint?.checkpoint??emptyMailboxCheckpoint(),lease};
 },options);
 if(!claim)return {status:'quiet',imported:0};
 let count=0,pages=0,renewed:Awaited<ReturnType<typeof exchangeMailboxToken>>|null=null,inboxId:string|undefined,microsoftDeltaExpired=false;
 try{
  if(claim.provider==='microsoft')assertMicrosoftMailboxCheckpoint(claim.checkpoint);
  // Do not start provider I/O based only on an earlier transaction snapshot.
  // Revocation can still race after this check because network I/O must not
  // hold the user's database locks open.
  await withCrmRead(session,async(tx,fresh)=>verify(tx,fresh,claim),options);
  let token=unprotectMailboxToken(session,claim.provider,claim.access,claim.label);
  const expectedIdentity=claim.tenantId&&claim.accountId&&claim.subject?{tenantId:claim.tenantId,objectId:claim.accountId,subject:claim.subject}:null;
  const expiresAt=Date.parse(claim.expiresAt);
  if(!token||!Number.isFinite(expiresAt)||expiresAt<=Date.now()+60000){const refresh=unprotectMailboxToken(session,claim.provider,claim.refresh,claim.label);if(!refresh)throw new MailboxProviderError('MAIL_REAUTH_REQUIRED');renewed=await exchangeMailboxToken({provider:claim.provider,refreshToken:refresh,priorScopes:claim.scopes,...(expectedIdentity?{verifiedMicrosoftAuthority:expectedIdentity.tenantId}:{})},options.transport,options.microsoftAuth);if(expectedIdentity){try{await(options.verifyIdentity??verifyMicrosoftMailboxIdentity)({flow:'refresh',idToken:renewed.idToken||'',clientId:microsoftMailboxClientId(),expectedIdentity});}catch(error){throw new MailboxProviderError(error instanceof MicrosoftIdentityError&&error.code==='MICROSOFT_IDENTITY_UNAVAILABLE'?'MAIL_PROVIDER_UNAVAILABLE':'MAIL_REAUTH_REQUIRED');}}token=renewed.accessToken;}
  const identity=await fetchMailboxAccountIdentity(claim.provider,token,options.transport);
  const accountMatches=expectedIdentity?sameMicrosoftMailboxGuid(identity.accountId,expectedIdentity.objectId):!claim.accountId||identity.accountId===claim.accountId;
  if(identity.label!==claim.label||!accountMatches)throw new MailboxProviderError('MAIL_ACCOUNT_CHANGED');
  const storedAccountId=expectedIdentity?.objectId??identity.accountId;
  await withFencedWrite(session,claim,options,async(tx,fresh,claim)=>{await tx.query(`update crm_mailbox_connections set provider_account_id=$2,revision=revision+1,access_token_encrypted=coalesce($3,access_token_encrypted),refresh_token_encrypted=coalesce($4,refresh_token_encrypted),expires_at=coalesce($5::timestamptz,expires_at),granted_scopes=coalesce($6::jsonb,granted_scopes) where id=$1::uuid`,[claim.id,storedAccountId,renewed?protectMailboxToken(fresh,claim.provider,renewed.accessToken,claim.label):null,renewed?protectMailboxToken(fresh,claim.provider,renewed.refreshToken,claim.label):null,renewed?.expiresAt??null,renewed?JSON.stringify(renewed.scopes):null]);claim.accountId=storedAccountId;claim.revision++;});
  if(claim.provider==='microsoft'&&claim.format!=='immutable'){
   const legacy=await withCrmRead(session,async(tx,fresh)=>{await verify(tx,fresh,claim);return tx.query<{id:string;providerId:string}>(`select id,provider_id as "providerId" from crm_mailbox_messages where connection_id=$1::uuid and provider_id_format='legacy' order by id limit 20`,[claim.id]);},options);
   const aliases=legacy.length?await translateMailboxLegacyIds(token,legacy.map(row=>row.providerId),options.transport):[];
   const done=await withFencedWrite(session,claim,options,async(tx,fresh,claim)=>{for(const alias of aliases){const old=legacy.find(row=>row.providerId===alias.oldId)!;await tx.query(`insert into crm_mailbox_id_aliases(workspace_id,user_id,connection_id,old_id,immutable_id,message_id) values($1::uuid,$2::uuid,$3::uuid,$4,$5,$6::uuid) on conflict do nothing`,[fresh.workspaceId,fresh.userId,claim.id,alias.oldId,alias.newId,old.id]);await tx.query(`update crm_mailbox_messages set provider_id=$2,provider_id_format='immutable',revision=revision+1 where id=$1::uuid`,[old.id,alias.newId]);}
    const remaining=await tx.queryOne(`select id from crm_mailbox_messages where connection_id=$1::uuid and provider_id_format='legacy' limit 1`,[claim.id]);if(!remaining){await tx.query(`update crm_mailbox_connections set provider_id_format='immutable',revision=revision+1 where id=$1::uuid`,[claim.id]);claim.revision++;claim.format='immutable';}return !remaining;});
   if(!done){await finish(session,claim,'identity_migration',null,options);return {status:'identity_migration',imported:0};}
  }
  inboxId=claim.provider==='microsoft'?await fetchMailboxInboxId(token,options.transport):undefined;
  if(claim.provider==='microsoft')assertMicrosoftMailboxCheckpoint(claim.checkpoint,inboxId);
  const auxiliary=await withCrmRead(session,async(tx,fresh)=>{
   await verify(tx,fresh,claim);
   const available=await tx.queryOne<{ready:boolean}>(`select to_regclass('public.crm_mailbox_cursor_recovery') is not null as ready`);
   const recovery=available?.ready?await tx.queryOne<CursorRecovery>(`select phase,ceiling_id as "ceilingId",last_id as "lastId",baseline_checkpoint as baseline from crm_mailbox_cursor_recovery where connection_id=$1::uuid`,[claim.id]):null;
   const policy=claim.provider==='microsoft'?await tx.queryOne<{resume:MailboxSyncCheckpoint|null}>(`select to_jsonb(s)->'contact_review_backfill_resume' as resume from crm_mailbox_auto_settings s where connection_id=$1::uuid`,[claim.id]):null;
   return {recovery,resume:policy?.resume??null};
  },options);
  const recovery=auxiliary.recovery;
  if(claim.provider==='microsoft'){assertMicrosoftRecovery(recovery,inboxId);if(auxiliary.resume!==null)assertMicrosoftReadyCheckpoint(auxiliary.resume,inboxId);}
  if(recovery?.phase==='verify'){
   const batch=await withCrmRead(session,async(tx,fresh)=>{await verify(tx,fresh,claim);return tx.query<{id:string;providerId:string}>(`select id,provider_id as "providerId" from crm_mailbox_messages where connection_id=$1::uuid and deleted_at is null and $2::uuid is not null and id<=$2::uuid and ($3::uuid is null or id>$3::uuid) order by id limit 5`,[claim.id,recovery.ceilingId,recovery.lastId]);},options);
   if(batch.length){
    const outcomes:Outcome[]=[];let lastId:string|null=null;
    for(const item of batch){if(Date.now()-started>=budget)break;await withCrmRead(session,async(tx,fresh)=>verify(tx,fresh,claim),options);const meta=await fetchMailboxMetadata(claim.provider,token,item.providerId,options.transport,inboxId);outcomes.push({id:item.providerId,source:!meta?'source_missing':meta.inInbox?'in_inbox':'left_inbox'});lastId=item.id;}
    if(lastId)await checkpointCommit(session,claim,claim.checkpoint,outcomes,options,lastId);
   }else{
    if(!recovery.baseline)throw new CrmCommandError('MAIL_RECOVERY_INVALID','Postfachabgleich benötigt persönliche Prüfung',409);
    const replay=claim.provider==='microsoft'?microsoftRecoveryReplay(claim.checkpoint,recovery.baseline,inboxId):{...recovery.baseline,queued:claim.checkpoint.queued,afterQueue:claim.checkpoint.queued.length?mailboxSyncPosition(recovery.baseline):null};
    await withFencedWrite(session,claim,options,async(tx,_fresh,claim)=>{await tx.query(`update crm_mailbox_auto_checkpoints set checkpoint=$2::jsonb,updated_at=now() where connection_id=$1::uuid and folder='inbox'`,[claim.id,JSON.stringify(replay)]);await tx.query(`update crm_mailbox_cursor_recovery set phase='replay',updated_at=now() where connection_id=$1::uuid and phase='verify'`,[claim.id]);});
   }
   const status=await finish(session,claim,'catching_up',null,options);return {status,imported:0,pages:0};
  }
  let state=claim.checkpoint,freshMicrosoftFinalCursor:string|null=null;
  while(pages<maxPages&&Date.now()-started<budget){
   if(!state.queued.length){let page:Awaited<ReturnType<typeof fetchMailboxSyncPage>>;const usedMicrosoftCursor=claim.provider==='microsoft'&&microsoftCheckpointUsesContinuation(state,inboxId);try{page=await fetchMailboxSyncPage(claim.provider,token,state,options.transport,inboxId);}catch(error){if(usedMicrosoftCursor&&error instanceof MailboxProviderError&&error.status===410)microsoftDeltaExpired=true;throw error;}state={...state,queued:page.changes,afterQueue:page.after};if(!page.changes.length)state={...page.after,queued:[],afterQueue:null};await checkpointCommit(session,claim,state,[],options);if(claim.provider==='microsoft'&&page.after.phase==='ready')freshMicrosoftFinalCursor=page.after.deltaCheckpoint;pages++;if(!state.queued.length&&state.phase==='ready')break;if(!state.queued.length)continue;}
   const changes=state.queued.slice(0,5),outcomes:Outcome[]=[];
   let handled=0;for(const change of changes){
    if(Date.now()-started>=budget)break;handled++;
    // Delta removal is a source hint, not a CRM deletion. A message may already
    // have returned to Inbox by the time this page is handled; verify its current
    // folder instead of letting delivery order undo a later known association.
    try{const meta=await fetchMailboxMetadata(claim.provider,token,change.id,options.transport,inboxId);if(!meta){outcomes.push({id:change.id,source:'source_missing'});continue;}if(!meta.inInbox){outcomes.push({id:change.id,source:'left_inbox'});continue;}
     const decision=await withCrmRead(session,async(tx,fresh)=>{await verify(tx,fresh,claim);return decide(tx,fresh,claim,meta);},options);
     const content=decision.status==='known'?await fetchMailboxKnownContent(claim.provider,token,meta.providerId,options.transport,inboxId):undefined;
     if(content&&content.providerId!==meta.providerId)throw new MailboxProviderError('MAIL_MESSAGE_ID_CHANGED');outcomes.push({id:meta.providerId,meta,decision,content});
    }catch(error){if(error instanceof CrmCommandError||error instanceof MailboxProviderError&&(/AUTH|RATE_LIMIT|UNAVAILABLE|REAUTH|SCOPE/.test(error.code)||['MAIL_INVALID_FOLDER_ID','MAIL_INVALID_GMAIL_LABEL_IDS','MAIL_GMAIL_DETAIL_CHANGED','MAIL_MICROSOFT_DETAIL_CHANGED'].includes(error.code)||claim.provider==='google'&&['MAIL_INVALID_RESPONSE','MAIL_RESPONSE_TOO_LARGE','MAIL_CHECKPOINT_EXPIRED'].includes(error.code)))throw error;outcomes.push({id:change.id,quarantine:error instanceof MailboxProviderError?error.code:'MAIL_INVALID_MESSAGE'});}
   }
   const rest=state.queued.slice(handled);state=rest.length?{...state,queued:rest}: {...state.afterQueue!,queued:[],afterQueue:null};count+=await checkpointCommit(session,claim,state,outcomes,options);if(rest.length)pages++;if(!state.queued.length&&state.phase==='ready')break;
  }
  const current=mailboxSyncCurrent(claim.provider,state,freshMicrosoftFinalCursor);
  if(current&&recovery?.phase==='baseline'){
   await withFencedWrite(session,claim,options,async(tx,_fresh,claim)=>{await tx.query(`update crm_mailbox_cursor_recovery set phase='verify',baseline_checkpoint=$2::jsonb,updated_at=now() where connection_id=$1::uuid and phase='baseline'`,[claim.id,JSON.stringify(state)]);});
   const status=await finish(session,claim,'catching_up',null,options);return {status,imported:count,pages};
  }
  if(current&&recovery?.phase==='replay')await withFencedWrite(session,claim,options,async(tx,_fresh,claim)=>{await tx.query(`delete from crm_mailbox_cursor_recovery where connection_id=$1::uuid and phase='replay'`,[claim.id]);});
  const backfill=current?await withFencedWrite(session,claim,options,async(tx,_fresh,claim)=>{
   const policy=await tx.queryOne<{pending:boolean;resume:MailboxSyncCheckpoint|null}>(`select coalesce((to_jsonb(s)->>'contact_review_backfill_pending')::boolean,false) as pending,to_jsonb(s)->'contact_review_backfill_resume' as resume from crm_mailbox_auto_settings s where connection_id=$1::uuid`,[claim.id]);
   const next=claim.provider==='microsoft'?microsoftContactBackfillCheckpoint(state,claim.contactReview&&policy?.pending===true,policy?.resume??null,inboxId):contactBackfillCheckpoint(state,claim.contactReview&&policy?.pending===true,policy?.resume??null);
   if(!next){if(claim.backfillReplaying){await tx.query(`update crm_mailbox_auto_settings set contact_review_backfill_replaying=false,revision=revision+1,updated_at=now() where connection_id=$1::uuid`,[claim.id]);claim.policyRevision++;}return false;}
   await tx.query(`update crm_mailbox_auto_checkpoints set checkpoint=$2::jsonb,updated_at=now() where connection_id=$1::uuid and folder='inbox'`,[claim.id,JSON.stringify(next.checkpoint)]);
   await tx.query(`update crm_mailbox_auto_settings set contact_review_backfill_pending=$2,contact_review_backfill_resume=$3::jsonb,contact_review_backfill_replaying=$4,revision=revision+1,updated_at=now() where connection_id=$1::uuid`,[claim.id,next.pending,next.resume?JSON.stringify(next.resume):null,policy?.resume!=null]);claim.policyRevision++;return true;
  }):false;
  const status=await finish(session,claim,current&&!backfill?'current':'catching_up',null,options);return {status,imported:count,pages};
 }catch(error){const code=error instanceof CrmCommandError||error instanceof MailboxProviderError?error.code:'MAIL_SYNC_FAILED';
  if(error instanceof MailboxCheckpointReviewRequired){await finish(session,claim,'review','MAIL_CHECKPOINT_REVIEW_REQUIRED',options,undefined,true);return {status:'review',imported:count,pages};}
  if(error instanceof MailboxProviderError&&mailboxCursorResetAllowed(claim.provider,error.status,microsoftDeltaExpired)){
   let startedRecovery:boolean;try{startedRecovery=await startCursorRecovery(session,claim,options,inboxId);}catch(recoveryError){if(recoveryError instanceof MailboxCheckpointReviewRequired){await finish(session,claim,'review','MAIL_CHECKPOINT_REVIEW_REQUIRED',options,undefined,true);return {status:'review',imported:count,pages};}throw recoveryError;}
   if(!startedRecovery){await finish(session,claim,'review','MAIL_BACKFILL_DELTA_EXPIRED',options);return {status:'review',imported:count};}
   await finish(session,claim,'catching_up','MAIL_CHECKPOINT_RESET',options);return {status:'catching_up',imported:count};}
  await finish(session,claim,mailboxSyncFailureStatus(code),code,options,error instanceof MailboxProviderError?error.retryAfterSeconds:undefined).catch(()=>undefined);throw error;
 }
}
type Outcome={id:string;source?:'in_inbox'|'left_inbox'|'source_missing';quarantine?:string;meta?:MailboxMetadata;decision?:MailboxSyncDecision;content?:MailboxImportedMessage};
async function startCursorRecovery(session:AppSession,claim:Claim,options:Options,inboxId?:string){return withFencedWrite(session,claim,options,async(tx,fresh,claim)=>{
 const available=await tx.queryOne<{ready:boolean}>(`select to_regclass('public.crm_mailbox_cursor_recovery') is not null as ready`);if(!available?.ready)return false;
 if(claim.provider==='microsoft'){
  if(!inboxId)throw new MailboxCheckpointReviewRequired();
  const current=await tx.queryOne<{checkpoint:MailboxSyncCheckpoint}>(`select checkpoint from crm_mailbox_auto_checkpoints where connection_id=$1::uuid and folder='inbox' for update`,[claim.id]);
  const policy=await tx.queryOne<{resume:MailboxSyncCheckpoint|null}>(`select to_jsonb(s)->'contact_review_backfill_resume' as resume from crm_mailbox_auto_settings s where connection_id=$1::uuid`,[claim.id]);
  const recovery=await tx.queryOne<CursorRecovery>(`select phase,ceiling_id as "ceilingId",last_id as "lastId",baseline_checkpoint as baseline from crm_mailbox_cursor_recovery where connection_id=$1::uuid for update`,[claim.id]);
  assertMicrosoftMailboxCheckpoint(current?.checkpoint??claim.checkpoint,inboxId);if(policy?.resume!=null)assertMicrosoftReadyCheckpoint(policy.resume,inboxId);assertMicrosoftRecovery(recovery,inboxId);
 }
 const ceiling=await tx.queryOne<{id:string}>(`select id from crm_mailbox_messages where connection_id=$1::uuid and deleted_at is null order by id desc limit 1`,[claim.id]);
 await tx.query(`insert into crm_mailbox_cursor_recovery(workspace_id,user_id,connection_id,phase,ceiling_id) values($1::uuid,$2::uuid,$3::uuid,'baseline',$4::uuid) on conflict(workspace_id,user_id,connection_id) do update set phase='baseline',ceiling_id=excluded.ceiling_id,last_id=null,baseline_checkpoint=null,updated_at=now()`,[fresh.workspaceId,fresh.userId,claim.id,ceiling?.id??null]);
 await tx.query(`insert into crm_mailbox_auto_checkpoints(workspace_id,user_id,connection_id,checkpoint) values($1::uuid,$2::uuid,$3::uuid,$4::jsonb) on conflict(workspace_id,user_id,connection_id,folder) do update set checkpoint=excluded.checkpoint,updated_at=now()`,[fresh.workspaceId,fresh.userId,claim.id,JSON.stringify(emptyMailboxCheckpoint())]);
 await tx.query(`update crm_mailbox_auto_settings set contact_review_backfill_resume=null,contact_review_backfill_replaying=false,status='catching_up',last_error='MAIL_CHECKPOINT_RESET',revision=revision+1,updated_at=now() where connection_id=$1::uuid`,[claim.id]);claim.policyRevision++;claim.backfillReplaying=false;return true;
});}
async function checkpointCommit(session:AppSession,claim:Claim,state:MailboxSyncCheckpoint,outcomes:Outcome[],options:Options,recoveryLastId?:string){return withFencedWrite(session,claim,options,async(tx,fresh,claim)=>{let count=0;
 for(const outcome of outcomes){if(outcome.source){
   const updated=await tx.queryOne(`update crm_mailbox_messages set source_status=$3,revision=revision+1 where connection_id=$1::uuid and provider_id=$2 and deleted_at is null returning id`,[claim.id,outcome.id,outcome.source]);
   if(recoveryLastId&&!updated)continue;
   if(outcome.source==='in_inbox')continue;
   // Filing and triage are personal CRM work, independent of the provider folder.
   // Retain a currently readable original relationship, never manufacture a new
   // one from a removal. Revoked relationships are cleared from this projection.
   const retained=await tx.queryOne<{id:string}>(`select d.id from crm_mailbox_private_decisions d where d.connection_id=$1::uuid and d.provider_id=$2 and ((d.status in('suggested','filed') and exists(select 1 from leads l where l.workspace_id=d.workspace_id and l.project_id=d.project_id and l.id=d.lead_id and l.contact_id=d.contact_id)) or (d.status='review' and d.lead_id is null and d.reason='exact_address_unique_contact_unverified_sender' and exists(select 1 from contacts c join projects p on p.workspace_id=c.workspace_id and p.id=c.project_id join crm_mailbox_messages m on m.workspace_id=d.workspace_id and m.user_id=d.user_id and m.id=d.message_id where c.workspace_id=d.workspace_id and c.project_id=d.project_id and c.id=d.contact_id and c.archived_at is null and m.deleted_at is null and m.from_address=lower(btrim(c.email)) and crm_project_access(c.workspace_id,c.project_id,false) and crm_classification_allowed(c.workspace_id,c.data_classification,c.data_purpose) and crm_classification_allowed(p.workspace_id,p.data_classification,p.data_purpose) and (select count(*) from contacts u where u.workspace_id=c.workspace_id and u.archived_at is null and lower(btrim(u.email))=lower(btrim(c.email)) and crm_classification_allowed(u.workspace_id,u.data_classification,u.data_purpose) and ((u.project_id is not null and crm_project_access(u.workspace_id,u.project_id,false) and exists(select 1 from projects up where up.workspace_id=u.workspace_id and up.id=u.project_id and crm_classification_allowed(up.workspace_id,up.data_classification,up.data_purpose))) or (u.project_id is null and u.owner_user_id=nullif(current_setting('app.actor_id',true),'')::uuid)))=1)))`,[claim.id,outcome.id]);
   if(retained)await tx.query(`update crm_mailbox_private_decisions set updated_at=now() where id=$1::uuid`,[retained.id]);
   else await decisionRecord(tx,fresh,claim,outcome.id,outcome.source,outcome.source);
   continue;
  }
  if(outcome.quarantine){await decisionRecord(tx,fresh,claim,outcome.id,'quarantined',outcome.quarantine);continue;}
  const decision=await decide(tx,fresh,claim,outcome.meta!);let messageId:string|undefined;
  // Re-evaluate current lead rights/participants after provider I/O, within the same page transaction.
  if(outcome.content&&decision.status==='known'&&decision.leadId===outcome.decision?.leadId&&decision.contactId===outcome.decision?.contactId&&decision.projectId===outcome.decision?.projectId){
   const review=assessMailboxObjectionReview({metadata:outcome.meta!,decision,message:outcome.content});
   if(review.state==='unavailable')throw new CrmCommandError('MAIL_REVIEW_SOURCE_CHANGED','Die persönliche Nachricht muss erneut im Postfach geprüft werden.',409);
   messageId=await saveContent(tx,fresh,claim,outcome.content,outcome.meta!);if(messageId)count++;
  }
  await decisionRecord(tx,fresh,claim,outcome.id,messageId?(decision.leadId?(decision.automatic?'filed':'suggested'):'review'):decision.status==='ignored'?'ignored':'review',decision.reason,outcome.meta,decision.status==='known'&&messageId?decision:undefined,messageId);
 }
 await tx.query(`insert into crm_mailbox_auto_checkpoints(workspace_id,user_id,connection_id,checkpoint) values($1::uuid,$2::uuid,$3::uuid,$4::jsonb) on conflict(workspace_id,user_id,connection_id,folder) do update set checkpoint=excluded.checkpoint,updated_at=now()`,[fresh.workspaceId,fresh.userId,claim.id,JSON.stringify(state)]);
 if(recoveryLastId){const advanced=await tx.queryOne(`update crm_mailbox_cursor_recovery set last_id=$2::uuid,updated_at=now() where connection_id=$1::uuid and phase='verify' returning connection_id`,[claim.id,recoveryLastId]);if(!advanced)throw new CrmCommandError('MAIL_CONNECTION_CHANGED','Postfachabgleich wurde geändert',409);}return count;
});}
async function finish(session:AppSession,claim:Claim,status:string,error:string|null,options:Options,retryAfter?:number,pauseForReview=false){return withCrmRead(session,async(tx,fresh)=>{await verify(tx,fresh,claim);
 const review=await tx.queryOne(`select id from crm_mailbox_private_decisions where connection_id=$1::uuid and status='quarantined' limit 1`,[claim.id]);const actual=status==='current'&&review?'review':status,failed=status==='delayed';
 const policy=await tx.queryOne<{revision:number}>(`update crm_mailbox_auto_settings set status=$2,last_error=$3,next_run_at=now()+make_interval(secs=>$4),last_success_at=case when $5 then now() else last_success_at end,failure_count=case when $6 then failure_count+1 else 0 end,enabled=case when $7 then false else enabled end,revision=revision+1,updated_at=now() where connection_id=$1::uuid and workspace_id=$8::uuid and user_id=$9::uuid and revision=$10 and identity_id=$11::uuid and enabled returning revision`,[claim.id,actual,error,retryAfter??(failed?Math.min(3600,120*2**Math.min(claim.failures,5)):status==='catching_up'||status==='identity_migration'?10:120),status==='current',failed,pauseForReview,fresh.workspaceId,fresh.userId,claim.policyRevision,claim.identityId]);
 if(!policy||policy.revision!==claim.policyRevision+1)throw new CrmCommandError('MAIL_CONNECTION_CHANGED','Persönliche Freigabe oder Verbindung geändert. Verspäteter Import wurde verworfen.',409);
 await tx.query(`delete from crm_mailbox_private_decisions where connection_id=$1::uuid and status='ignored' and updated_at<now()-interval '30 days'`,[claim.id]);
 // The last business statement fences the entire transaction. The row locks
 // serialize cooperating successors until COMMIT/ROLLBACK; an exact wall-clock
 // guarantee through the COMMIT protocol itself is not possible here.
 const completed=await tx.queryOne<{revision:number}>(`update crm_mailbox_connections c set sync_lease_id=null,sync_lease_until=null,last_synced_at=case when $2 then now() else last_synced_at end,last_error=$3,status=case when $4 then 'reauthorization_required' else status end,access_token_encrypted=case when $4 then null else access_token_encrypted end,refresh_token_encrypted=case when $4 then null else refresh_token_encrypted end,revision=revision+1 where c.id=$1::uuid and c.workspace_id=$5::uuid and c.user_id=$6::uuid and c.status='connected' and c.revision=$7 and c.sync_lease_id=$8::uuid and c.sync_lease_until>clock_timestamp() and exists(select 1 from crm_mailbox_auto_settings s join workspace_users u on u.workspace_id=s.workspace_id and u.id=s.user_id where s.connection_id=c.id and s.workspace_id=c.workspace_id and s.user_id=c.user_id and s.revision=$9 and s.identity_id=$10::uuid and s.enabled=(not $11::boolean) and u.status='active' and u.auth_identity_id=s.identity_id and crm_mailbox_delegated_identity(c.workspace_id,c.user_id)=s.identity_id) returning c.revision`,[claim.id,status==='current',error,status==='reauthorization_required',fresh.workspaceId,fresh.userId,claim.revision,claim.lease,policy.revision,claim.identityId,pauseForReview]);
 if(!completed||completed.revision!==claim.revision+1)throw new CrmCommandError('MAIL_CONNECTION_CHANGED','Persönliche Freigabe oder Verbindung geändert. Verspäteter Import wurde verworfen.',409);return actual;
},options);}
