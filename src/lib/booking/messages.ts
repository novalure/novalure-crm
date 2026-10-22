import "server-only";
import { createHash, randomUUID } from "node:crypto";
import type { AppSession } from "@/lib/auth/session";
import { withTenantTransaction, type TenantScope, type TenantTransaction, type TenantTransactionOptions } from "@/lib/db/tenant-client";
import { sendTransactionalEmail, type TransactionalEmailResult } from "@/lib/integrations/resend";
import { readBookingSetup } from "./configuration";
import { bookingResourceLock, readBooking, withBookingTransaction } from "./repository";
import { BookingError, type BookingRecord } from "./types";
import { createBookingActionLinks } from "./message-actions";
import { BookingTemplateError, renderBookingEmail, type BookingCommunicationSettings, type BookingEmailLanguage, type BookingEmailTemplate, type BookingEmailValues, type EmailTemplateKind } from "./templates";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function normalizeBookingRecipient(input: { recipientEmail?: unknown; recipientName?: unknown; communicationLanguage?: unknown }): { recipientEmail: string | null; recipientName: string; communicationLanguage: "de" | "en" } {
  const recipientEmail = input.recipientEmail === undefined || input.recipientEmail === null || input.recipientEmail === "" ? null : input.recipientEmail;
  if (recipientEmail !== null && (typeof recipientEmail !== "string" || recipientEmail.length > 254 || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(recipientEmail))) throw new BookingError("INVALID_RECIPIENT_EMAIL");
  const recipientName = input.recipientName ?? "";
  if (typeof recipientName !== "string" || recipientName.length > 200 || /[\u0000-\u001f]/.test(recipientName)) throw new BookingError("INVALID_RECIPIENT_NAME");
  const communicationLanguage = input.communicationLanguage ?? "de";
  if (communicationLanguage !== "de" && communicationLanguage !== "en") throw new BookingError("INVALID_COMMUNICATION_LANGUAGE");
  return { recipientEmail: typeof recipientEmail === "string" ? recipientEmail.trim().toLowerCase() : null, recipientName: recipientName.trim(), communicationLanguage };
}
export type BookingMailBinding = { workspaceId: string; userId: string; recipientEmail: string };
export function isBookingMessageQaRuntime(env: NodeJS.ProcessEnv = process.env) {
  return env.BOOKING_MESSAGES_ENABLED === "1" && env.VERCEL_ENV !== "production" && (env.VERCEL_ENV === "preview" || env.NODE_ENV !== "production");
}
export function bookingMailBindings(env: NodeJS.ProcessEnv = process.env): BookingMailBinding[] {
  if (!isBookingMessageQaRuntime(env)) return [];
  const raw = env.BOOKING_MAIL_TEST_BINDINGS_JSON || "[]";
  if (raw.length > 16_384) return [];
  try {
    const rows: unknown = JSON.parse(raw);
    if (!Array.isArray(rows) || rows.length > 20) return [];
    const seen = new Set<string>();
    return rows.flatMap(row => {
      if (!row || typeof row !== "object") return [];
      const { workspaceId, userId, recipientEmail } = row as BookingMailBinding;
      // This QA release is explicitly limited to the owner's approved mailbox.
      if (!uuid.test(workspaceId) || !uuid.test(userId) || recipientEmail !== "hello@novalure.eu") return [];
      const key = `${workspaceId}:${userId}:${recipientEmail}`;
      if (seen.has(key)) return [];
      seen.add(key); return [{ workspaceId, userId, recipientEmail }];
    });
  } catch { return []; }
}
function mailAllowed(session: Pick<AppSession, "workspaceId" | "userId">, recipient: string) {
  return bookingMailBindings().some(b => b.workspaceId === session.workspaceId && b.userId === session.userId && b.recipientEmail === recipient);
}
function scopedSession(scope: TenantScope): AppSession {
  return { authenticated: true, userId: scope.actorId, workspaceId: scope.workspaceId, workspaceName: "", email: "", name: "", role: "agent", permissions: [], productRole: "team_member", productPermissions: [], source: "database" };
}
type MessageSnapshot = { state?: string; startsAt?: string; endsAt?: string; recipientEmail?: string };
type FrozenTemplate = { template: BookingEmailTemplate; companyName: string; preparationNote: string; employeeName: string };
type MessageJob = {
  id: string; workspaceId: string; organizerId: string; bookingId: string; bookingVersion: number;
  kind: "confirmation" | "reminder" | "reschedule" | "cancellation" | "test"; templateKind: EmailTemplateKind;
  language: BookingEmailLanguage; reminderId: string | null; scheduledFor: string; status: string; recipientEmail: string;
  replyTo: string; template: FrozenTemplate; rendered: { subject: string; text: string; html: string } | null;
  providerMessageId: string | null; firstAttemptAt: string | null; nextAttemptAt: string | null; attemptCount: number; leaseOwner: string | null;
};
const jobColumns = `id,workspace_id as "workspaceId",organizer_id as "organizerId",booking_id as "bookingId",booking_version as "bookingVersion",kind,template_kind as "templateKind",language,reminder_id as "reminderId",scheduled_for as "scheduledFor",status,recipient_email as "recipientEmail",reply_to as "replyTo",template,rendered,provider_message_id as "providerMessageId",first_attempt_at as "firstAttemptAt",next_attempt_at as "nextAttemptAt",attempt_count as "attemptCount",lease_owner as "leaseOwner"`;

async function insertMessage(tx: TenantTransaction, session: AppSession, row: BookingRecord, config: BookingCommunicationSettings,
  input: { version: number; kind: MessageJob["kind"]; templateKind: EmailTemplateKind; reminderId?: string; scheduledFor: number; language: BookingEmailLanguage; template?: BookingEmailTemplate }) {
  const employee = await tx.queryOne<{ name: string }>(`select name from workspace_users where workspace_id=$1::uuid and id=$2::uuid`, [session.workspaceId, session.userId]);
  const frozen: FrozenTemplate = { template: input.template ?? config.templates[input.language][input.templateKind], companyName: config.companyName || session.workspaceName,
    preparationNote: config.preparationNote, employeeName: employee?.name || session.name };
  return tx.queryOne<{ id: string }>(`insert into booking_message_jobs(workspace_id,organizer_id,booking_id,booking_version,kind,template_kind,language,reminder_id,scheduled_for,recipient_email,reply_to,template)
    values($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7,$8,to_timestamp($9::double precision/1000),$10,$11,$12::jsonb)
    on conflict(workspace_id,booking_id,booking_version,kind,reminder_id) do nothing returning id`,
  [session.workspaceId, session.userId, row.id, input.version, input.kind, input.templateKind, input.language, input.reminderId ?? null, input.scheduledFor, row.recipientEmail, config.replyTo, JSON.stringify(frozen)]);
}

/** Called from the booking's existing resource-locked finish transaction. */
export async function syncBookingMessages(tx: TenantTransaction, session: AppSession, _before: BookingRecord, after: BookingRecord, nowMs: number): Promise<void> {
  if (!after.recipientEmail || !["confirmed", "cancelled"].includes(after.state)) return;
  const previous = (after.messageSnapshot ?? {}) as MessageSnapshot;
  const unchanged = previous.state === after.state && previous.startsAt === after.startsAt && previous.endsAt === after.endsAt && previous.recipientEmail === after.recipientEmail;
  if (unchanged) return;
  const config = (await readBookingSetup(tx, session, after.kind)).communication;
  const version = (after.messageVersion ?? 0) + 1;
  const snapshot: MessageSnapshot = { state: after.state, startsAt: after.startsAt, endsAt: after.endsAt, recipientEmail: after.recipientEmail };
  await tx.execute(`update booking_message_jobs set status=case when status='sending' then 'uncertain' else 'cancelled' end,last_error='BOOKING_VERSION_CHANGED',updated_at=now()
    where workspace_id=$1::uuid and organizer_id=$2::uuid and booking_id=$3::uuid and status in ('planned','sending')`, [session.workspaceId, session.userId, after.id]);
  await tx.execute(`update booking_reservations set message_version=$4,message_snapshot=$5::jsonb,notification_status=$6 where workspace_id=$1::uuid and organizer_id=$2::uuid and id=$3::uuid`,
    [session.workspaceId, session.userId, after.id, version, JSON.stringify(snapshot), config.enabled ? "pending" : "not_requested"]);
  if (!config.enabled) return;
  const language = after.communicationLanguage === "en" ? "en" : "de";
  const kind: EmailTemplateKind = after.state === "cancelled" ? "cancellation" : previous.state ? "reschedule" : "confirmation";
  await insertMessage(tx, session, after, config, { version, kind, templateKind: kind, language, scheduledFor: nowMs });
  if (after.state === "cancelled") return;
  for (const reminder of config.reminders) {
    if (!reminder.enabled) continue;
    const scheduledFor = Date.parse(after.startsAt) - reminder.minutesBefore * 60_000;
    if (scheduledFor <= nowMs) continue;
    await insertMessage(tx, session, after, config, { version, kind: "reminder", templateKind: reminder.template, reminderId: reminder.id, language, scheduledFor });
  }
}
export function bookingMessageValues(row: BookingRecord, template: FrozenTemplate, nowMs = Date.now()): BookingEmailValues {
  const language = row.communicationLanguage === "en" ? "en" : "de", locale = language === "de" ? "de-AT" : "en-GB";
  const starts = new Date(row.startsAt), firstName = (row.recipientName || "").trim().split(/\s+/)[0] || (language === "de" ? "Termininteressent" : "guest");
  const links = createBookingActionLinks(row, nowMs);
  const names = language === "de" ? { phone: "Telefon", teams: "Teams", meet: "Google Meet", office: "Büro", onsite: "Vor Ort" } : { phone: "Phone", teams: "Teams", meet: "Google Meet", office: "Office", onsite: "On site" };
  return { customerName: row.recipientName || firstName, firstName, companyName: template.companyName, employeeName: template.employeeName,
    bookingType: names[row.kind], date: new Intl.DateTimeFormat(locale, { timeZone: row.rules.timeZone, dateStyle: "full" }).format(starts),
    time: new Intl.DateTimeFormat(locale, { timeZone: row.rules.timeZone, timeStyle: "short" }).format(starts), timeZone: row.rules.timeZone,
    duration: String(Math.round((Date.parse(row.endsAt) - starts.getTime()) / 60_000)), location: row.rules.location, videoUrl: row.videoUrl || "",
    preparationNote: template.preparationNote, rescheduleUrl: links.rescheduleUrl, cancelUrl: links.cancelUrl };
}
export async function queueBookingTestMessage(session: AppSession, input: { bookingId: string; kind: EmailTemplateKind; language?: BookingEmailLanguage; template?: BookingEmailTemplate }, options: TenantTransactionOptions = {}) {
  return withBookingTransaction(session, async (tx, fresh) => {
    await bookingResourceLock(tx, fresh);
    const row = await readBooking(tx, fresh, input.bookingId);
    if (!row.recipientEmail || !mailAllowed(fresh, row.recipientEmail) || !["confirmed", "cancelled"].includes(row.state)) throw new BookingError("MAIL_TEST_RECIPIENT_NOT_ALLOWED", 403);
    const config = (await readBookingSetup(tx, fresh, row.kind)).communication;
    const language = row.communicationLanguage === "en" ? "en" : "de";
    if (input.language && input.language !== language) throw new BookingError("BOOKING_LANGUAGE_MISMATCH");
    const variant = createHash("sha256").update(JSON.stringify(input.template ?? config.templates[language][input.kind])).digest("hex").slice(0, 16);
    const reminderId = `${input.kind}:${language}:${variant}`;
    const result = await insertMessage(tx, fresh, row, config, { version: row.messageVersion ?? 0, kind: "test", templateKind: input.kind,
      reminderId, scheduledFor: Date.now(), language, template: input.template });
    const existing = result ? { id: result.id, status: "planned" } : await tx.queryOne<{ id: string; status: string }>(`select id,status from booking_message_jobs where workspace_id=$1::uuid and booking_id=$2::uuid and booking_version=$3 and kind='test' and reminder_id=$4`, [fresh.workspaceId, row.id, row.messageVersion ?? 0, reminderId]);
    return { jobId: existing!.id, status: existing!.status, recipientEmail: row.recipientEmail };
  }, options);
}

type ProcessOptions = TenantTransactionOptions & { limit?: number; shouldContinue?: () => boolean; now?: () => number; send?: typeof sendTransactionalEmail };
export type BookingMessageProcessResult = { checked: number; accepted: number; failed: number; uncertain: number; skipped: number };
async function markJob(tx: TenantTransaction, id: string, status: string, error: string | null = null) {
  const row = await tx.queryOne<{ bookingId: string; version: number }>(`update booking_message_jobs set status=$2,last_error=$3,lease_owner=null,lease_until=null,updated_at=now() where id=$1::uuid returning booking_id as "bookingId",booking_version as version`, [id, status, error]);
  if (row && status === "failed") await tx.execute(`update booking_reservations set notification_status='failed' where id=$1::uuid and message_version=$2`, [row.bookingId, row.version]);
}
async function currentJobValid(tx: TenantTransaction, session: AppSession, row: BookingRecord, job: MessageJob, now: number) {
  if (!mailAllowed(session, job.recipientEmail) || row.recipientEmail !== job.recipientEmail || (row.messageVersion ?? 0) !== job.bookingVersion || (row.communicationLanguage ?? "de") !== job.language) return false;
  if (job.kind !== "test" && (job.kind === "cancellation" ? row.state !== "cancelled" : row.state !== "confirmed")) return false;
  if (job.kind === "test") return ["confirmed", "cancelled"].includes(row.state);
  const config = (await readBookingSetup(tx, session, row.kind)).communication;
  if (!config.enabled) return false;
  if (job.kind === "reminder") {
    const reminder = config.reminders.find(r => r.id === job.reminderId && r.enabled && r.template === job.templateKind);
    if (!reminder || Math.abs(Date.parse(row.startsAt) - reminder.minutesBefore * 60_000 - Date.parse(job.scheduledFor)) > 1000 || Date.parse(row.startsAt) <= now) return false;
  }
  return true;
}
async function claimJob(scope: TenantScope, jobId: string, options: ProcessOptions): Promise<MessageJob | null> {
  const now = options.now?.() ?? Date.now(), session = scopedSession(scope);
  return withTenantTransaction(scope, async tx => {
    await bookingResourceLock(tx, session);
    const job = await tx.queryOne<MessageJob>(`select ${jobColumns} from booking_message_jobs where id=$1::uuid for update`, [jobId]);
    if (!job || job.status !== "planned" || Date.parse(job.scheduledFor) > now || job.nextAttemptAt && Date.parse(job.nextAttemptAt) > now) return null;
    const row = await readBooking(tx, session, job.bookingId);
    if (!await currentJobValid(tx, session, row, job, now)) { await markJob(tx, job.id, "cancelled", "BOOKING_OR_REMINDER_CHANGED"); return null; }
    if (job.firstAttemptAt && now - Date.parse(job.firstAttemptAt) >= 23 * 60 * 60_000 || job.attemptCount >= 6) { await markJob(tx, job.id, "failed", "MAIL_RETRY_WINDOW_EXPIRED"); return null; }
    if (job.templateKind !== "cancellation" && ["teams", "meet"].includes(row.kind) && (!row.videoUrl || row.videoStatus !== "ready")) {
      if (Date.parse(row.startsAt) <= now) await markJob(tx, job.id, "skipped", "VIDEO_LINK_UNAVAILABLE");
      else await tx.execute(`update booking_message_jobs set next_attempt_at=to_timestamp($2::double precision/1000),last_error='VIDEO_LINK_PENDING' where id=$1::uuid`, [job.id, now + 60_000]);
      return null;
    }
    let rendered = job.rendered;
    if (!rendered) {
      try { rendered = renderBookingEmail({ template: job.template.template, language: job.language, bookingKind: row.kind, values: bookingMessageValues(row, job.template, now) }); }
      catch (error) { if (!(error instanceof BookingTemplateError)) throw error; await markJob(tx, job.id, "failed", error.code); return null; }
    }
    const leaseOwner = randomUUID();
    await tx.execute(`update booking_message_jobs set status='sending',rendered=$2::jsonb,lease_owner=$3,lease_until=to_timestamp($4::double precision/1000),first_attempt_at=coalesce(first_attempt_at,to_timestamp($5::double precision/1000)),last_attempt_at=to_timestamp($5::double precision/1000),attempt_count=attempt_count+1,updated_at=now() where id=$1::uuid`, [job.id, JSON.stringify(rendered), leaseOwner, now + 45_000, now]);
    return { ...job, rendered, leaseOwner };
  }, options);
}
export async function processDueBookingMessages(options: ProcessOptions = {}): Promise<BookingMessageProcessResult> {
  const result: BookingMessageProcessResult = { checked: 0, accepted: 0, failed: 0, uncertain: 0, skipped: 0 };
  if (!isBookingMessageQaRuntime()) return result;
  const bindings = bookingMailBindings(), scopes = [...new Map(bindings.map(b => [`${b.workspaceId}:${b.userId}`, { workspaceId: b.workspaceId, actorId: b.userId }])).values()];
  const max = Math.max(1, Math.min(50, options.limit ?? 25)), now = options.now?.() ?? Date.now();
  for (const scope of scopes) {
    if (options.shouldContinue && !options.shouldContinue()) break;
    const refs = await withTenantTransaction(scope, async tx => {
      // A lost lease has an unknown outcome. Never automatically retry that send.
      await tx.execute(`update booking_message_jobs set status='uncertain',last_error='MAIL_WORKER_LEASE_LOST',lease_owner=null,lease_until=null,updated_at=now() where status='sending' and lease_until<=to_timestamp($1::double precision/1000)`, [now]);
      return tx.query<{ id: string }>(`select id from booking_message_jobs where status='planned' and scheduled_for<=to_timestamp($1::double precision/1000) and (next_attempt_at is null or next_attempt_at<=to_timestamp($1::double precision/1000)) order by scheduled_for,id limit $2`, [now, max - result.checked]);
    }, options);
    for (const ref of refs) {
      if (result.checked >= max || options.shouldContinue && !options.shouldContinue()) break;
      result.checked += 1;
      const claimed = await claimJob(scope, ref.id, options);
      if (!claimed?.rendered) { result.skipped += 1; continue; }
      const session = scopedSession(scope);
      try {
        const outcome = await withTenantTransaction(scope, async tx => {
          // Hold the same resource lock as cancellation/rescheduling through the send.
          // A crash leaves the durable lease uncertain, rather than sending twice.
          await bookingResourceLock(tx, session);
          const row = await readBooking(tx, session, claimed.bookingId);
          const job = await tx.queryOne<MessageJob>(`select ${jobColumns} from booking_message_jobs where id=$1::uuid and status='sending' and lease_owner=$2 for update`, [claimed.id, claimed.leaseOwner]);
          if (!job || !await currentJobValid(tx, session, row, job, options.now?.() ?? Date.now())) { if (job) await markJob(tx, job.id, "cancelled", "BOOKING_OR_REMINDER_CHANGED"); return "skipped" as const; }
          const sent: TransactionalEmailResult = await (options.send ?? sendTransactionalEmail)({ to: job.recipientEmail, ...claimed.rendered!, idempotencyKey: `booking-message-${job.id}`, bookingJobId: job.id, ...(job.replyTo ? { replyTo: job.replyTo } : {}) });
          if (sent.outcome === "accepted") {
            await tx.execute(`update booking_message_jobs set status='accepted',provider_message_id=$2,lease_owner=null,lease_until=null,last_error=null,updated_at=now() where id=$1::uuid`, [job.id, sent.messageId]);
            await tx.execute(`update booking_reservations set notification_status='sent' where id=$1::uuid and message_version=$2`, [row.id, job.bookingVersion]);
            return "accepted" as const;
          }
          if (sent.outcome === "retryable") {
            await tx.execute(`update booking_message_jobs set status='planned',next_attempt_at=to_timestamp($2::double precision/1000),lease_owner=null,lease_until=null,last_error=$3 where id=$1::uuid`, [job.id, (options.now?.() ?? Date.now()) + 60_000, sent.error]);
            return "skipped" as const;
          }
          const status = sent.outcome === "uncertain" ? "uncertain" : "failed";
          await markJob(tx, job.id, status, sent.error);
          await tx.execute(`update booking_reservations set notification_status=$3 where id=$1::uuid and message_version=$2`, [row.id, job.bookingVersion, status === "uncertain" ? "pending" : "failed"]);
          return status;
        }, options);
        result[outcome] += 1;
      } catch {
        // The acceptance transaction itself may have committed or rolled back.
        // The next worker only reconciles its expired lease; it never resends it.
        result.uncertain += 1;
      }
    }
  }
  return result;
}

export async function getBookingMessageJobs(session: AppSession, options: TenantTransactionOptions = {}) {
  return withBookingTransaction(session, (tx, fresh) => tx.query<{ id: string; bookingId: string; kind: string; scheduledFor: string; status: string; providerMessageId: string | null; lastError: string | null }>(
    `select id,booking_id as "bookingId",kind,scheduled_for as "scheduledFor",status,provider_message_id as "providerMessageId",last_error as "lastError" from booking_message_jobs where workspace_id=$1::uuid and organizer_id=$2::uuid order by created_at desc limit 100`, [fresh.workspaceId, fresh.userId]), options);
}
