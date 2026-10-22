import "server-only";
import type { AppSession } from "@/lib/auth/session";
import type { TenantScope, TenantTransaction, TenantTransactionOptions } from "@/lib/db/tenant-client";
import { BookingError, type BookingRecord } from "./types";
import { bookingRuntimeMode } from "./runtime";
import { assertBookingActivation, listProductionBookingBindings } from "./activation";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export type BookingMailBinding = { workspaceId: string; userId: string; recipientEmail: string };
export function isBookingMessageQaRuntime(env: NodeJS.ProcessEnv = process.env) {
  return env.BOOKING_MESSAGES_ENABLED === "1" && env.VERCEL_ENV !== "production" && (env.VERCEL_ENV === "preview" || env.NODE_ENV !== "production");
}
export function isBookingMessageRuntime(env: NodeJS.ProcessEnv = process.env) {
  return isBookingMessageQaRuntime(env) || env.BOOKING_MESSAGES_ENABLED === "1" && bookingRuntimeMode(env) === "production";
}
export function isBookingReminderRuntime(env: NodeJS.ProcessEnv = process.env) {
  return isBookingMessageQaRuntime(env) || env.BOOKING_REMINDERS_ENABLED === "1" && isBookingMessageRuntime(env);
}
export function canRunBookingReminderWhilePaused(env: NodeJS.ProcessEnv = process.env) {
  return bookingRuntimeMode(env) === "production" && isBookingReminderRuntime(env);
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
/** Scope enumeration uses server-controlled activations, never webhook payloads. */
export async function bookingMessageScopes(options: TenantTransactionOptions = {}): Promise<TenantScope[]> {
  const bindings = isBookingMessageQaRuntime() ? bookingMailBindings()
    : isBookingMessageRuntime() ? await listProductionBookingBindings({ ...options, capability: "messages" }) : [];
  return [...new Map(bindings.map(b => [`${b.workspaceId}:${b.userId}`, { workspaceId: b.workspaceId, actorId: b.userId }])).values()];
}
/** Rechecked under the booking lock immediately before every actual send. */
export async function bookingMessageActivation(tx: TenantTransaction, session: Pick<AppSession, "workspaceId" | "userId">, row: BookingRecord): Promise<{ activatedAt: number } | null> {
  if (!isBookingMessageRuntime()) return null;
  const connection = await tx.queryOne<{ accountId: string }>(`select account_id as "accountId" from booking_calendar_connections
    where id=$1::uuid and workspace_id=$2::uuid and user_id=$3::uuid and provider=$4
      and status='connected' and revision=$5 and write_calendar_id=$6 for share`,
  [row.connectionId, session.workspaceId, session.userId, row.provider, row.connectionRevision, row.calendarId]);
  if (!connection) return null;
  if (isBookingMessageQaRuntime()) return { activatedAt: 0 };
  try {
    const activation = await assertBookingActivation({ workspaceId: session.workspaceId, actorId: session.userId },
      { provider: row.provider, connectionId: row.connectionId, accountId: connection.accountId, calendarId: row.calendarId }, { tx, capability: "messages" });
    if (!activation) return null;
    const activatedAt = Date.parse(activation.activatedAt);
    const booking = await tx.queryOne<{ createdAt: string }>(`select created_at as "createdAt" from booking_reservations where id=$1::uuid`, [row.id]);
    return Number.isFinite(activatedAt) && booking && new Date(booking.createdAt).getTime() >= activatedAt ? { activatedAt } : null;
  } catch (error) {
    if (error instanceof BookingError) return null;
    throw error;
  }
}
