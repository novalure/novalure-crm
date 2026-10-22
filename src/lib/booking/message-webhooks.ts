import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { withTenantTransaction, type TenantTransactionOptions } from "@/lib/db/tenant-client";
import { bookingMessageScopes } from "./message-runtime";
import { BookingError } from "./types";

export type BookingEmailProviderEvent = { eventId: string; messageId: string; jobId?: string; type: "email.sent" | "email.delivered" | "email.bounced" | "email.complained" | "email.failed" | "email.suppressed"; occurredAt: string };
export function verifyBookingMailWebhook(body: string, headers: Headers, secret = process.env.RESEND_WEBHOOK_SECRET || "", now = Date.now()): BookingEmailProviderEvent | null {
  if (body.length > 65_536 || !secret.startsWith("whsec_")) throw new BookingError("MAIL_WEBHOOK_UNAUTHORIZED", 401);
  const id = headers.get("svix-id") || "", timestamp = headers.get("svix-timestamp") || "", signatures = headers.get("svix-signature") || "";
  if (!/^[A-Za-z0-9_-]{1,150}$/.test(id) || !/^\d{10,12}$/.test(timestamp) || Math.abs(now - Number(timestamp) * 1000) > 5 * 60_000 || signatures.length > 4096) throw new BookingError("MAIL_WEBHOOK_UNAUTHORIZED", 401);
  const encodedKey = secret.slice(6);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encodedKey) || encodedKey.length > 512 || encodedKey.length % 4 === 1) throw new BookingError("MAIL_WEBHOOK_UNAUTHORIZED", 401);
  const key = Buffer.from(encodedKey, "base64"), canonicalKey = key.toString("base64");
  if (key.length < 32 || encodedKey !== canonicalKey && encodedKey !== canonicalKey.replace(/=+$/, "")) throw new BookingError("MAIL_WEBHOOK_UNAUTHORIZED", 401);
  const expected = createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest();
  const authenticated = signatures.split(/\s+/).some(part => {
    const [version, encoded, extra] = part.split(",");
    if (version !== "v1" || !encoded || extra) return false;
    const received = Buffer.from(encoded, "base64");
    return received.length === expected.length && timingSafeEqual(received, expected);
  });
  if (!authenticated) throw new BookingError("MAIL_WEBHOOK_UNAUTHORIZED", 401);
  let data: { type?: unknown; created_at?: unknown; data?: { email_id?: unknown; tags?: unknown } };
  try { data = JSON.parse(body) as typeof data; } catch { throw new BookingError("INVALID_MAIL_EVENT"); }
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new BookingError("INVALID_MAIL_EVENT");
  if (!["email.sent", "email.delivered", "email.bounced", "email.complained", "email.failed", "email.suppressed"].includes(String(data.type))) return null;
  if (typeof data.data?.email_id !== "string" || data.data.email_id.length > 150 || !/^[A-Za-z0-9_-]+$/.test(data.data.email_id) || typeof data.created_at !== "string" || !Number.isFinite(Date.parse(data.created_at)) || Date.parse(data.created_at) > now + 5 * 60_000) throw new BookingError("INVALID_MAIL_EVENT");
  const tags = data.data.tags;
  const jobId = Array.isArray(tags) ? tags.find(tag => tag && typeof tag === "object" && tag.name === "booking_job_id")?.value
    : tags && typeof tags === "object" ? (tags as Record<string, unknown>).booking_job_id : undefined;
  if (jobId !== undefined && (typeof jobId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(jobId))) throw new BookingError("INVALID_MAIL_EVENT");
  return { eventId: id, messageId: data.data.email_id, ...(jobId ? { jobId } : {}), type: data.type as BookingEmailProviderEvent["type"], occurredAt: data.created_at };
}
export function nextBookingMailDeliveryStatus(current: string, event: BookingEmailProviderEvent["type"]): string {
  if (["cancelled", "skipped"].includes(current)) return current;
  if (event === "email.sent") return ["sending", "uncertain", "accepted"].includes(current) ? "accepted" : current;
  if (event === "email.delivered") return current === "failed" ? current : "delivered";
  return "failed";
}
export async function recordBookingMailProviderEvent(event: BookingEmailProviderEvent, options: TenantTransactionOptions = {}) {
  const scopes = await bookingMessageScopes(options);
  for (const scope of scopes) {
    const matched = await withTenantTransaction(scope, async tx => {
      await tx.query(`select pg_advisory_xact_lock(hashtextextended($1,0))`, [`booking:${scope.workspaceId}:${scope.actorId}`]);
      const row = await tx.queryOne<{ id: string; bookingId: string; bookingVersion: number; status: string; eventIds: string[]; lastEventAt: string | null }>(
        `select id,booking_id as "bookingId",booking_version as "bookingVersion",status,event_ids as "eventIds",last_event_at as "lastEventAt" from booking_message_jobs
          where (provider_message_id=$1 or ($2::uuid is not null and id=$2::uuid and provider_message_id is null and status in ('sending','uncertain') and first_attempt_at<=$3::timestamptz+interval '5 seconds'))
          order by (provider_message_id=$1) desc nulls last limit 1 for update`, [event.messageId, event.jobId ?? null, event.occurredAt]);
      if (!row) return false;
      if (event.jobId && event.jobId !== row.id) return false;
      if (row.eventIds.includes(event.eventId) || row.lastEventAt && Date.parse(row.lastEventAt) > Date.parse(event.occurredAt) || row.eventIds.length >= 64) return true;
      const status = nextBookingMailDeliveryStatus(row.status, event.type);
      await tx.execute(`update booking_message_jobs set status=$2,provider_message_id=coalesce(provider_message_id,$6),last_event_at=$3::timestamptz,event_ids=array_append(event_ids,$4),last_error=case when $2='failed' then $5 else null end,updated_at=now() where id=$1::uuid`, [row.id, status, event.occurredAt, event.eventId, event.type, event.messageId]);
      if (status === "failed") await tx.execute(`update booking_reservations set notification_status='failed' where id=$1::uuid and message_version=$2`, [row.bookingId, row.bookingVersion]);
      if (status === "accepted" || status === "delivered") await tx.execute(`update booking_reservations set notification_status='sent' where id=$1::uuid and message_version=$2`, [row.bookingId, row.bookingVersion]);
      return true;
    }, options);
    if (matched) return;
  }
}
