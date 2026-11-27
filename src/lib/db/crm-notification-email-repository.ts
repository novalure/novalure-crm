import "server-only";
import { randomUUID } from "node:crypto";
import type { AppSession } from "@/lib/auth/session";
import { assertCrmUuid, assertProjectGrant, crmPayloadDigest, CrmCommandError, type TenantTransaction, type TenantTransactionOptions } from "@/lib/crm-command";
import { crmNotificationEmailConfiguration, notificationEmailAddress } from "@/lib/crm-notification-email-configuration";
import { defaultCrmNotificationEmailPreferences, nextCrmNotificationEmailAt, parseCrmNotificationEmailPreferences, renderCrmNotificationEmail, type CrmNotificationEmailCounts, type CrmNotificationEmailPreferences, type CrmNotificationEmailState, type CrmNotificationEmailStatus } from "@/lib/crm-notification-email";
import type { NewsletterDispatch } from "@/lib/newsletter-provider";
import { loadCrmNotifications } from "./crm-notifications-repository";
export type NotificationEmailOptions = TenantTransactionOptions & { env?: NodeJS.ProcessEnv };
type Settings = { preferences: CrmNotificationEmailPreferences; revision: number; identityId: string | null; recipient: string | null; nextRunAt: string | null; requestId: string; hash: string };
type Job = { id: string; projectId: string | null; identityId: string; recipient: string; preferenceRevision: number; keys: string[]; counts: CrmNotificationEmailCounts; payload: Omit<NewsletterDispatch, "idempotencyKey">; status: CrmNotificationEmailStatus; revision: number; leaseToken: string | null; attemptCount: number };
const selectSettings = `preferences,revision,identity_id as "identityId",recipient_email as recipient,next_run_at::text as "nextRunAt",last_request_id as "requestId",last_request_hash as hash`;
const selectJob = `id,project_id as "projectId",identity_id as "identityId",recipient_email as recipient,preference_revision as "preferenceRevision",notification_keys as keys,counts,payload,status,revision,lease_token as "leaseToken",attempt_count as "attemptCount"`;
function personal(session: AppSession) { if (session.serviceIdentity || session.productRole === "external_partner") throw new CrmCommandError("FORBIDDEN", "Persönliche Mitgliedschaft für Zusammenfassungen erforderlich", 403); }
async function identity(tx: TenantTransaction, session: AppSession) { return (await tx.queryOne<{ identity: { identityId: string; email: string } | null }>(`select crm_notification_email_identity($1::uuid,$2::uuid) as identity`, [session.workspaceId, session.userId]))?.identity ?? null; }
async function settings(tx: TenantTransaction, session: AppSession, lock = false) { return tx.queryOne<Settings>(`select ${selectSettings} from crm_notification_email_settings where workspace_id=$1::uuid and user_id=$2::uuid${lock ? " for update" : ""}`, [session.workspaceId, session.userId]); }
export async function loadCrmNotificationEmail(tx: TenantTransaction, session: AppSession, options: NotificationEmailOptions = {}): Promise<CrmNotificationEmailState> {
  personal(session); const saved = await settings(tx, session), person = await identity(tx, session), config = crmNotificationEmailConfiguration({ workspaceId: session.workspaceId, actorId: session.userId }, options.env);
  const jobs = await tx.query<CrmNotificationEmailState["jobs"][number]>(`select id,status,jsonb_array_length(notification_keys)::int as count,created_at::text as "createdAt",accepted_at::text as "acceptedAt",error,revision,(status='failed' and attempt_count<3 and created_at>now()-interval '23 hours') as "retryAllowed" from crm_notification_email_jobs where workspace_id=$1::uuid and user_id=$2::uuid order by created_at desc limit 10`, [session.workspaceId, session.userId]);
  return { preferences: saved ? parseCrmNotificationEmailPreferences(saved.preferences) : defaultCrmNotificationEmailPreferences(), revision: saved?.revision ?? 0, recipient: person?.email ?? null, identityReady: !!person && notificationEmailAddress(person.email), nextRunAt: saved?.nextRunAt ?? null, readiness: { ready: config.ready, reason: config.reason }, jobs };
}
export async function saveCrmNotificationEmail(tx: TenantTransaction, session: AppSession, input: unknown, expectedRevision: unknown, requestId: string) {
  personal(session); assertCrmUuid(requestId);
  if (!Number.isSafeInteger(expectedRevision) || Number(expectedRevision) < 0) throw new CrmCommandError("INVALID_REVISION", "Einstellungsversion fehlt");
  let parsed: CrmNotificationEmailPreferences; try { parsed = parseCrmNotificationEmailPreferences(input); } catch (error) { throw new CrmCommandError("INVALID_DIGEST_PREFERENCES", error instanceof Error ? error.message : "Digest-Einstellungen prüfen"); }
  // Losing a project's rights must never prevent a personal opt-out.
  if (parsed.enabled && parsed.projectId) await assertProjectGrant(tx, session, parsed.projectId, false);
  await tx.query(`select pg_advisory_xact_lock(hashtextextended($1,0))`, [`notification-email:${session.workspaceId}:${session.userId}`]);
  const saved = await settings(tx, session, true), hash = crmPayloadDigest({ parsed, expectedRevision });
  if (saved?.requestId === requestId) { if (saved.hash !== hash) throw new CrmCommandError("IDEMPOTENCY_CONFLICT", "Vorgangskennung gehört zu anderen Einstellungen", 409); return { revision: saved.revision, replayed: true }; }
  if ((saved?.revision ?? 0) !== expectedRevision) throw new CrmCommandError("PREFERENCES_CHANGED", "Digest-Einstellungen wurden geändert. Bitte neu laden.", 409);
  const person = await identity(tx, session);
  if (parsed.enabled && (!person || !notificationEmailAddress(person.email))) throw new CrmCommandError("IDENTITY_REQUIRED", "Aktives eigenes Anmeldekonto mit übereinstimmender Kontoadresse erforderlich", 403);
  const nextAt = parsed.enabled ? nextCrmNotificationEmailAt(parsed, new Date()) : null;
  const row = await tx.queryOne<{ revision: number }>(`insert into crm_notification_email_settings(workspace_id,user_id,identity_id,recipient_email,preferences,next_run_at,last_request_id,last_request_hash) values($1::uuid,$2::uuid,$3::uuid,$4,$5::jsonb,$6::timestamptz,$7::uuid,$8) on conflict(workspace_id,user_id) do update set identity_id=excluded.identity_id,recipient_email=excluded.recipient_email,preferences=excluded.preferences,next_run_at=excluded.next_run_at,last_request_id=excluded.last_request_id,last_request_hash=excluded.last_request_hash,revision=crm_notification_email_settings.revision+1,updated_at=now() returning revision`, [session.workspaceId, session.userId, person?.identityId ?? null, person?.email ?? null, JSON.stringify(parsed), nextAt, requestId, hash]);
  if (!row) throw new CrmCommandError("SAVE_UNCONFIRMED", "Digest-Einstellungen nicht bestätigt", 503);
  // A queued message can be cancelled. An already-started provider request cannot be recalled.
  const cancelled = await tx.query<{ id: string }>(`update crm_notification_email_jobs set status='suppressed',revision=revision+1,error='preferences_changed',updated_at=now() where workspace_id=$1::uuid and user_id=$2::uuid and status='queued' returning id`, [session.workspaceId, session.userId]);
  for (const job of cancelled) await tx.query(`delete from crm_notification_email_coverage where workspace_id=$1::uuid and user_id=$2::uuid and job_id=$3::uuid`, [session.workspaceId, session.userId, job.id]);
  return { revision: row.revision, nextRunAt: nextAt, replayed: false };
}
async function suppress(tx: TenantTransaction, session: AppSession, job: Job, reason: string) {
  await tx.query(`update crm_notification_email_jobs set status='suppressed',revision=revision+1,error=$4,lease_token=null,lease_until=null,updated_at=now() where workspace_id=$1::uuid and user_id=$2::uuid and id=$3::uuid and status in('queued','dispatching')`, [session.workspaceId, session.userId, job.id, reason]);
  await tx.query(`delete from crm_notification_email_coverage where workspace_id=$1::uuid and user_id=$2::uuid and job_id=$3::uuid`, [session.workspaceId, session.userId, job.id]);
}
export async function prepareCrmNotificationEmail(tx: TenantTransaction, session: AppSession, options: NotificationEmailOptions = {}) {
  personal(session); const config = crmNotificationEmailConfiguration({ workspaceId: session.workspaceId, actorId: session.userId }, options.env);
  if (!config.ready) return { prepared: false, reason: config.reason };
  await tx.query(`select pg_advisory_xact_lock(hashtextextended($1,0))`, [`notification-email:${session.workspaceId}:${session.userId}`]);
  // A worker crash after the durable claim is ambiguous, not a reason to submit another email.
  await tx.query(`update crm_notification_email_jobs set status='uncertain',revision=revision+1,lease_token=null,lease_until=null,error='worker_result_unknown',updated_at=now() where workspace_id=$1::uuid and user_id=$2::uuid and status='dispatching' and lease_until<clock_timestamp()`, [session.workspaceId, session.userId]);
  const saved = await settings(tx, session, true); if (!saved || !parseCrmNotificationEmailPreferences(saved.preferences).enabled) return { prepared: false, reason: "disabled" };
  const existing = await tx.queryOne<Job>(`select ${selectJob} from crm_notification_email_jobs where workspace_id=$1::uuid and user_id=$2::uuid and status in('queued','dispatching') order by created_at limit 1`, [session.workspaceId, session.userId]);
  if (existing) return { prepared: false, reason: "existing_job", id: existing.id };
  if (!saved.nextRunAt || Date.parse(saved.nextRunAt) > Date.now()) return { prepared: false, reason: "not_due" };
  const prefs = parseCrmNotificationEmailPreferences(saved.preferences), person = await identity(tx, session);
  if (!person || person.identityId !== saved.identityId || person.email !== saved.recipient) return { prepared: false, reason: "identity_changed" };
  const state = await loadCrmNotifications(tx, session, prefs.projectId);
  const covered = new Set((await tx.query<{ key: string }>(`select notification_key as key from crm_notification_email_coverage where workspace_id=$1::uuid and user_id=$2::uuid and notification_key=any($3::text[])`, [session.workspaceId, session.userId, state.items.map(item => item.key)])).map(row => row.key));
  const items = state.items.filter(item => !item.read && !covered.has(item.key)), keys = items.map(item => item.key).sort(), counts: CrmNotificationEmailCounts = {};
  // Advance an empty check as well; repeated cron ticks stay silent until the next scheduled check.
  await tx.query(`update crm_notification_email_settings set next_run_at=$3::timestamptz,updated_at=now() where workspace_id=$1::uuid and user_id=$2::uuid`, [session.workspaceId, session.userId, nextCrmNotificationEmailAt(prefs, new Date())]);
  if (!keys.length) return { prepared: false, reason: "no_changes" };
  items.forEach(item => { counts[item.category] = (counts[item.category] ?? 0) + 1; });
  const rendered = renderCrmNotificationEmail(counts, prefs.language, config.origin), id = randomUUID(), payload = { to: person.email, from: config.from, ...rendered };
  await tx.query(`insert into crm_notification_email_jobs(id,workspace_id,user_id,project_id,identity_id,recipient_email,preference_revision,notification_keys,counts,payload) values($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6,$7,$8::jsonb,$9::jsonb,$10::jsonb)`, [id, session.workspaceId, session.userId, prefs.projectId, person.identityId, person.email, saved.revision, JSON.stringify(keys), JSON.stringify(counts), JSON.stringify(payload)]);
  await tx.query(`insert into crm_notification_email_coverage(workspace_id,user_id,notification_key,job_id) select $1::uuid,$2::uuid,key,$3::uuid from unnest($4::text[]) key`, [session.workspaceId, session.userId, id, keys]);
  return { prepared: true, id, count: keys.length };
}
export async function claimCrmNotificationEmail(tx: TenantTransaction, session: AppSession, id: string, options: NotificationEmailOptions = {}) {
  personal(session); assertCrmUuid(id);
  const config = crmNotificationEmailConfiguration({ workspaceId: session.workspaceId, actorId: session.userId }, options.env); if (!config.ready) return null;
  const saved = await settings(tx, session, true), job = await tx.queryOne<Job>(`select ${selectJob} from crm_notification_email_jobs where workspace_id=$1::uuid and user_id=$2::uuid and id=$3::uuid for update`, [session.workspaceId, session.userId, id]);
  if (!job || job.status !== "queued") return null;
  const person = await identity(tx, session);
  if (!saved || !saved.preferences.enabled || saved.revision !== job.preferenceRevision || !person || person.identityId !== job.identityId || person.email !== job.recipient || saved.identityId !== person.identityId || saved.recipient !== person.email) { await suppress(tx, session, job, "preferences_or_identity_changed"); return null; }
  let state;
  try { state = await loadCrmNotifications(tx, session, job.projectId); }
  catch (error) { if (error instanceof CrmCommandError && error.status === 403) { await suppress(tx, session, job, "project_access_revoked"); return null; } throw error; }
  const available = new Map(state.items.filter(item => !item.read).map(item => [item.key, item]));
  if (job.keys.some(key => !available.has(key))) { await suppress(tx, session, job, "notifications_changed"); return null; }
  const counts: CrmNotificationEmailCounts = {}; job.keys.forEach(key => { const category = available.get(key)!.category; counts[category] = (counts[category] ?? 0) + 1; });
  const expected = { to: person.email, from: config.from, ...renderCrmNotificationEmail(counts, saved.preferences.language, config.origin) };
  if (crmPayloadDigest(expected) !== crmPayloadDigest(job.payload) || crmPayloadDigest(counts) !== crmPayloadDigest(job.counts)) { await suppress(tx, session, job, "content_or_sender_changed"); return null; }
  const token = randomUUID(); await tx.query(`update crm_notification_email_jobs set status='dispatching',revision=revision+1,attempt_count=attempt_count+1,lease_token=$4::uuid,lease_until=clock_timestamp()+interval '60 seconds',error=null,updated_at=now() where workspace_id=$1::uuid and user_id=$2::uuid and id=$3::uuid`, [session.workspaceId, session.userId, id, token]);
  return { id, token, payload: { ...job.payload, idempotencyKey: `notification-digest/${id}` } };
}
export async function finishCrmNotificationEmail(tx: TenantTransaction, session: AppSession, claim: { id: string; token: string }, result: { status: "accepted" | "failed" | "uncertain"; messageId?: string }) {
  const status = result.status === "accepted" && !result.messageId ? "uncertain" : result.status;
  const saved = await tx.queryOne(`update crm_notification_email_jobs set status=$5,revision=revision+1,lease_token=null,lease_until=null,provider_message_id=$6,accepted_at=case when $5='accepted' then now() else null end,error=case when $5='accepted' then null when $5='failed' then 'provider_rejected' else 'provider_result_unknown' end,updated_at=now() where workspace_id=$1::uuid and user_id=$2::uuid and id=$3::uuid and lease_token=$4::uuid and status='dispatching' returning id`, [session.workspaceId, session.userId, claim.id, claim.token, status, status === "accepted" ? result.messageId!.slice(0, 200) : null]);
  return { saved: !!saved, status };
}
export async function retryCrmNotificationEmail(tx: TenantTransaction, session: AppSession, id: string, expectedRevision: unknown) {
  personal(session); assertCrmUuid(id);
  if (!Number.isSafeInteger(expectedRevision) || Number(expectedRevision) < 1) throw new CrmCommandError("INVALID_REVISION", "Versandversion fehlt");
  const saved = await settings(tx, session, true); if (!saved?.preferences.enabled) throw new CrmCommandError("DIGEST_DISABLED", "Zusammenfassung ist ausgeschaltet", 409);
  const previous = await tx.queryOne<{ revision: number; status: string; attemptCount: number }>(`select revision,status,attempt_count as "attemptCount" from crm_notification_email_jobs where workspace_id=$1::uuid and user_id=$2::uuid and id=$3::uuid for update`, [session.workspaceId, session.userId, id]);
  if (previous?.status === "queued" && previous.attemptCount > 0 && previous.revision === Number(expectedRevision) + 1) return { queued: true, id, replayed: true };
  const job = await tx.queryOne(`update crm_notification_email_jobs set status='queued',revision=revision+1,error=null,updated_at=now() where workspace_id=$1::uuid and user_id=$2::uuid and id=$3::uuid and status='failed' and revision=$4 and attempt_count<3 and created_at>now()-interval '23 hours' and preference_revision=$5 and not exists(select 1 from crm_notification_email_jobs active where active.workspace_id=$1::uuid and active.user_id=$2::uuid and active.status in('queued','dispatching')) returning id`, [session.workspaceId, session.userId, id, expectedRevision, saved.revision]);
  if (!job) throw new CrmCommandError("DIGEST_RETRY_DENIED", "Nur eindeutig abgewiesene, aktuelle Vorgänge sind innerhalb von 23 Stunden bis zu dreimal erneut planbar. Ungeklärte Ergebnisse zuerst beim Anbieter prüfen.", 409);
  return { queued: true, id };
}
