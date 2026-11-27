import "server-only";
import { createHash } from "node:crypto";
import type { AppSession } from "@/lib/auth/session";
import { assertCrmUuid, assertProjectGrant, CrmCommandError, type TenantTransaction } from "@/lib/crm-command";
import { defaultCrmNotificationPreferences, parseCrmNotificationPreferences, type CrmNotification, type CrmNotificationCategory, type CrmNotificationPreferences, type CrmNotificationsState } from "@/lib/crm-notifications";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
type Row = Omit<CrmNotification, "read">;
async function preferences(tx: TenantTransaction, session: AppSession) {
  const saved = await tx.queryOne<{ preferences: unknown; revision: number; requestId: string; requestHash: string }>(`select preferences,revision,last_request_id as "requestId",last_request_hash as "requestHash" from crm_notification_preferences where workspace_id=$1::uuid and user_id=$2::uuid`, [session.workspaceId, session.userId]);
  return { preferences: saved ? parseCrmNotificationPreferences(saved.preferences) : defaultCrmNotificationPreferences(), revision: saved?.revision ?? 0, requestId: saved?.requestId, requestHash: saved?.requestHash };
}
export async function saveCrmNotificationPreferences(tx: TenantTransaction, session: AppSession, value: unknown, expectedRevision: number, requestId: string) {
  assertCrmUuid(requestId);
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new CrmCommandError("INVALID_REVISION", "Einstellungsversion fehlt");
  let parsed: CrmNotificationPreferences;
  try { parsed = parseCrmNotificationPreferences(value); } catch { throw new CrmCommandError("INVALID_PREFERENCES", "Hinweisarten und Zeitzone prüfen"); }
  await tx.query(`select pg_advisory_xact_lock(hashtextextended($1,0))`, [`notification-preferences:${session.workspaceId}:${session.userId}`]);
  const current = await preferences(tx, session), requestHash = hash({ parsed, expectedRevision });
  if (current.requestId === requestId) {
    if (current.requestHash !== requestHash) throw new CrmCommandError("REQUEST_CONFLICT", "Vorgangskennung mit anderem Inhalt", 409);
    return { preferences: current.preferences, revision: current.revision, replayed: true };
  }
  if (current.revision !== expectedRevision) throw new CrmCommandError("PREFERENCES_CHANGED", "Einstellungen wurden geändert. Bitte neu laden.", 409);
  const saved = await tx.queryOne<{ revision: number }>(`insert into crm_notification_preferences(workspace_id,user_id,preferences,last_request_id,last_request_hash) values($1::uuid,$2::uuid,$3::jsonb,$4::uuid,$5) on conflict(workspace_id,user_id) do update set preferences=excluded.preferences,revision=crm_notification_preferences.revision+1,last_request_id=excluded.last_request_id,last_request_hash=excluded.last_request_hash,updated_at=now() returning revision`, [session.workspaceId, session.userId, JSON.stringify(parsed), requestId, requestHash]);
  if (!saved) throw new CrmCommandError("SAVE_UNCONFIRMED", "Einstellungen nicht bestätigt", 503);
  return { preferences: parsed, revision: saved.revision, replayed: false };
}
export async function loadCrmNotifications(tx: TenantTransaction, session: AppSession, projectId: string | null = null): Promise<CrmNotificationsState> {
  if (projectId) { assertCrmUuid(projectId); await assertProjectGrant(tx, session, projectId, false); }
  const saved = await preferences(tx, session);
  const optional = await tx.queryOne<{ expose: boolean; automation: boolean; publication: boolean; email: boolean }>(`select
    coalesce(has_table_privilege(current_user,to_regclass('public.web_expose_outbox'),'SELECT'),false) and coalesce(has_table_privilege(current_user,to_regclass('public.web_expose_sessions'),'SELECT'),false) and coalesce(has_table_privilege(current_user,to_regclass('public.web_expose_links'),'SELECT'),false) as expose,
    coalesce(has_table_privilege(current_user,to_regclass('public.crm_automation_enrollments'),'SELECT'),false) as automation,
    coalesce(has_table_privilege(current_user,to_regclass('public.property_export_jobs'),'SELECT'),false) as publication,
    to_regclass('public.crm_notification_email_settings') is not null as email`);
  const features: Record<CrmNotificationCategory, boolean> = { new_lead: true, task_due: true, reservation_deadline: true, expose_opened: optional?.expose === true, automation_issue: optional?.automation === true, publication_issue: optional?.publication === true };
  const params = [session.workspaceId, projectId, session.userId];
  const sourceQueries: Promise<Row[]>[] = [];
  const unreadQuery = (sql: string) => tx.query<Row>(`select source.* from (${sql.replace(/\s+limit 50$/, "")}) source where not exists(select 1 from crm_notification_reads receipt where receipt.workspace_id=$1::uuid and receipt.user_id=$3::uuid and receipt.notification_key=source.key) limit 50`, params);
  if (saved.preferences.categories.new_lead) sourceQueries.push(unreadQuery(`select 'new_lead:'||l.id::text as key,'new_lead' as category,coalesce(nullif(c.name,''),'Neue Anfrage') as title,'Neue Anfrage zur Bearbeitung' as detail,l.received_at::text as "occurredAt",l.project_id::text as "projectId",l.id::text as "sourceId",'lead' as "sourceType" from leads l left join contacts c on c.id=l.contact_id and c.workspace_id=l.workspace_id where l.workspace_id=$1::uuid and ($2::uuid is null or l.project_id=$2::uuid) and (l.assigned_to_user_id=$3::uuid or crm_workspace_manager($1::uuid)) and l.status='Neu' and l.received_at>now()-interval '7 days' and (l.metadata #>> '{websiteSales,syntheticTest}') is distinct from 'true' and coalesce(l.metadata#>>'{onboardingExample,synthetic}','false')<>'true' order by l.received_at desc,l.id limit 50`));
  if (saved.preferences.categories.task_due) sourceQueries.push(unreadQuery(`select 'task_due:'||id::text||':'||(extract(epoch from due_at)::bigint)::text as key,'task_due' as category,title,'Aufgabe ist fällig oder wird innerhalb von 24 Stunden fällig' as detail,due_at::text as "occurredAt",project_id::text as "projectId",id::text as "sourceId",'task' as "sourceType" from tasks where workspace_id=$1::uuid and ($2::uuid is null or project_id=$2::uuid) and (owner_user_id=$3::uuid or crm_workspace_manager($1::uuid)) and status='open' and coalesce(metadata#>>'{onboardingExample,synthetic}','false')<>'true' and due_at<=now()+interval '24 hours' order by due_at,id limit 50`));
  if (saved.preferences.categories.reservation_deadline) sourceQueries.push(unreadQuery(`select 'reservation_deadline:'||r.id::text||':'||(extract(epoch from r.expires_at)::bigint)::text as key,'reservation_deadline' as category,'Einheit '||u.unit_number as title,case when r.status='hold' then 'Vormerkungsfrist prüfen' else 'Reservierungsfrist prüfen' end as detail,r.expires_at::text as "occurredAt",r.project_id::text as "projectId",r.id::text as "sourceId",'reservation' as "sourceType" from property_reservations r join property_units u on u.id=r.unit_id and u.workspace_id=r.workspace_id left join leads l on l.id=r.buyer_lead_id and l.workspace_id=r.workspace_id where r.workspace_id=$1::uuid and ($2::uuid is null or r.project_id=$2::uuid) and (l.assigned_to_user_id=$3::uuid or crm_workspace_manager($1::uuid)) and coalesce(u.metadata#>>'{onboardingExample,synthetic}','false')<>'true' and r.status in ('hold','reserved') and r.expires_at<=now()+interval '48 hours' order by r.expires_at,r.id limit 50`));
  if (features.expose_opened && saved.preferences.categories.expose_opened) sourceQueries.push(unreadQuery(`select 'expose_opened:'||o.id::text as key,'expose_opened' as category,coalesce(nullif(c.name,''),'Exposé') as title,'Exposé geöffnet · Zuordnung zum vorgesehenen Empfänger, keine Identitätsbestätigung' as detail,o.occurred_at::text as "occurredAt",o.project_id::text as "projectId",o.lead_id::text as "sourceId",'lead' as "sourceType" from web_expose_outbox o join web_expose_sessions s on s.id=(o.payload->>'exposeSessionId')::uuid and s.workspace_id=o.workspace_id join web_expose_links link on link.id=s.link_id and link.workspace_id=o.workspace_id join leads l on l.id=o.lead_id and l.workspace_id=o.workspace_id left join contacts c on c.id=l.contact_id and c.workspace_id=l.workspace_id where o.workspace_id=$1::uuid and ($2::uuid is null or o.project_id=$2::uuid) and (l.assigned_to_user_id=$3::uuid or crm_workspace_manager($1::uuid)) and o.event_type='expose_opened' and s.withdrawn_at is null and link.revoked_at is null and o.occurred_at>now()-interval '7 days' order by o.occurred_at desc limit 50`));
  if (features.automation_issue && saved.preferences.categories.automation_issue) sourceQueries.push(unreadQuery(`select 'automation_issue:'||e.id::text||':'||(extract(epoch from e.updated_at)::bigint)::text as key,'automation_issue' as category,'Automation benötigt Prüfung' as title,coalesce(e.stop_reason,e.status) as detail,e.updated_at::text as "occurredAt",e.project_id::text as "projectId",e.automation_id::text as "sourceId",'automation' as "sourceType" from crm_automation_enrollments e join leads l on l.id=e.lead_id and l.workspace_id=e.workspace_id where e.workspace_id=$1::uuid and ($2::uuid is null or e.project_id=$2::uuid) and (l.assigned_to_user_id=$3::uuid or crm_workspace_manager($1::uuid)) and e.status in ('blocked','failed','review') order by e.updated_at desc limit 50`));
  if (features.publication_issue && saved.preferences.categories.publication_issue) sourceQueries.push(unreadQuery(`select 'publication_issue:'||j.id::text||':'||(extract(epoch from j.updated_at)::bigint)::text as key,'publication_issue' as category,coalesce(nullif(j.portal,''),'Portalexport') as title,coalesce(j.last_error_message,j.error,j.status) as detail,j.updated_at::text as "occurredAt",j.project_id::text as "projectId",j.property_id::text as "sourceId",'property' as "sourceType" from property_export_jobs j where j.workspace_id=$1::uuid and ($2::uuid is null or j.project_id=$2::uuid) and crm_workspace_manager($1::uuid) and j.status in ('failed','dead_letter','blocked') order by j.updated_at desc limit 50`));
  const all = (await Promise.all(sourceQueries)).flat();
  const reads = await tx.query<{ key: string }>(`select notification_key as key from crm_notification_reads where workspace_id=$1::uuid and user_id=$2::uuid and notification_key=any($3::text[])`, [session.workspaceId, session.userId, all.map((item) => item.key)]);
  const readKeys = new Set(reads.map((row) => row.key));
  const items = all.sort((a, b) => Number(a.category !== "task_due" && a.category !== "reservation_deadline") - Number(b.category !== "task_due" && b.category !== "reservation_deadline") || Date.parse(b.occurredAt) - Date.parse(a.occurredAt) || a.key.localeCompare(b.key)).slice(0, 100).map((item) => ({ ...item, detail: item.detail?.slice(0, 1000) ?? "", read: readKeys.has(item.key) }));
  const digests = await tx.query<{ id: string; createdAt: string; count: number; status: "prepared" }>(`select id,created_at::text as "createdAt",jsonb_array_length(notification_keys)::int as count,status from crm_notification_digests where workspace_id=$1::uuid and user_id=$2::uuid and project_id is not distinct from $3::uuid order by created_at desc limit 10`, [session.workspaceId, session.userId, projectId]);
  return { preferences: saved.preferences, revision: saved.revision, features, items, unread: items.filter((item) => !item.read).length, limit: 100, digests, delivery: { inApp: true, email: optional?.email ? "separate_opt_in" : "not_connected" } };
}
export async function markCrmNotificationsRead(tx: TenantTransaction, session: AppSession, keys: unknown, projectId: string | null) {
  if (!Array.isArray(keys) || !keys.length || keys.length > 100 || keys.some((key) => typeof key !== "string" || key.length > 180)) throw new CrmCommandError("INVALID_KEYS", "Hinweisliste ungültig");
  const state = await loadCrmNotifications(tx, session, projectId), allowed = new Set(state.items.map((item) => item.key));
  const prior = await tx.query<{ key: string }>(`select notification_key as key from crm_notification_reads where workspace_id=$1::uuid and user_id=$2::uuid and notification_key=any($3::text[])`, [session.workspaceId, session.userId, keys]);
  prior.forEach((row) => allowed.add(row.key));
  if (keys.some((key) => !allowed.has(key))) throw new CrmCommandError("NOTIFICATION_CHANGED", "Hinweise sind nicht mehr verfügbar. Bitte neu laden.", 409);
  await tx.query(`insert into crm_notification_reads(workspace_id,user_id,notification_key) select $1::uuid,$2::uuid,key from unnest($3::text[]) key on conflict do nothing`, [session.workspaceId, session.userId, keys]);
  return { read: keys.length };
}
export async function prepareCrmNotificationDigest(tx: TenantTransaction, session: AppSession, projectId: string | null, requestId: string) {
  assertCrmUuid(requestId);
  if (projectId) await assertProjectGrant(tx, session, projectId, false);
  await tx.query(`select pg_advisory_xact_lock(hashtextextended($1,0))`, [`notification-digest:${session.workspaceId}:${session.userId}`]);
  const previous = await tx.queryOne<{ id: string; projectId: string | null }>(`select id,project_id::text as "projectId" from crm_notification_digests where workspace_id=$1::uuid and user_id=$2::uuid and request_id=$3::uuid`, [session.workspaceId, session.userId, requestId]);
  if (previous) { if (previous.projectId !== projectId) throw new CrmCommandError("REQUEST_CONFLICT", "Vorgangskennung mit anderem Projekt", 409); return { id: previous.id, created: false, replayed: true, delivery: "not_connected" }; }
  const state = await loadCrmNotifications(tx, session, projectId);
  const previousKeys = await tx.query<{ key: string }>(`select distinct jsonb_array_elements_text(notification_keys) as key from crm_notification_digests where workspace_id=$1::uuid and user_id=$2::uuid`, [session.workspaceId, session.userId]);
  const used = new Set(previousKeys.map((row) => row.key)), keys = state.items.filter((item) => !item.read && !used.has(item.key)).map((item) => item.key).sort();
  if (!keys.length) return { created: false, reason: "no_changes", delivery: "not_connected" };
  const saved = await tx.queryOne<{ id: string }>(`insert into crm_notification_digests(workspace_id,user_id,project_id,request_id,fingerprint,notification_keys) values($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,$6::jsonb) returning id`, [session.workspaceId, session.userId, projectId, requestId, hash(keys), JSON.stringify(keys)]);
  if (!saved) throw new CrmCommandError("SAVE_UNCONFIRMED", "Zusammenfassung nicht bestätigt", 503);
  return { id: saved.id, created: true, count: keys.length, delivery: "not_connected" };
}
