import "server-only";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { getTrustedAppOrigin } from "@/lib/auth/app-origin";
import type { AppSession } from "@/lib/auth/session";
import type { TenantTransactionOptions } from "@/lib/db/tenant-client";
import { readBooking, withBookingTransaction } from "./repository";
import { BookingError, type BookingRecord } from "./types";
import { bookingMessageActivation, isBookingMessageRuntime } from "./message-runtime";

export type BookingActionPayload = { workspaceId: string; organizerId: string; bookingId: string; version: number; purpose: "cancel" | "reschedule"; recipientHash: string; expiresAt: number };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function actionSecret() {
  const secret = process.env.NOVALURE_SESSION_SECRET?.trim() || "";
  if (secret.length < 32) throw new BookingError("BOOKING_ACTION_SIGNING_UNAVAILABLE", 503);
  return secret;
}
function signature(value: string, purpose: string) { return createHmac("sha256", actionSecret()).update(`novalure-booking-${purpose}-v1\0${value}`).digest("base64url"); }
function equal(a: string, b: string) { const left = Buffer.from(a), right = Buffer.from(b); return left.length === right.length && timingSafeEqual(left, right); }
const recipientHash = (email: string) => createHash("sha256").update(email.trim().toLowerCase()).digest("hex");
export function createBookingActionToken(payload: BookingActionPayload) {
  const data = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${data}.${signature(data, "customer-action")}`;
}
export function verifyBookingActionToken(token: string, now = Date.now()): BookingActionPayload {
  if (typeof token !== "string" || token.length > 2000) throw new BookingError("BOOKING_ACTION_INVALID", 403);
  const [data, mac, extra] = token.split(".");
  if (!data || !mac || extra || !/^[A-Za-z0-9_-]+$/.test(data) || !equal(mac, signature(data, "customer-action"))) throw new BookingError("BOOKING_ACTION_INVALID", 403);
  let payload: BookingActionPayload;
  try { payload = JSON.parse(Buffer.from(data, "base64url").toString("utf8")) as BookingActionPayload; }
  catch { throw new BookingError("BOOKING_ACTION_INVALID", 403); }
  if (!payload || !uuid.test(payload.workspaceId) || !uuid.test(payload.organizerId) || !uuid.test(payload.bookingId) || !Number.isSafeInteger(payload.version) || payload.version < 0 || !["cancel", "reschedule"].includes(payload.purpose) || !/^[a-f0-9]{64}$/.test(payload.recipientHash) || !Number.isSafeInteger(payload.expiresAt) || payload.expiresAt <= now || payload.expiresAt > now + 7 * 86_400_000) throw new BookingError("BOOKING_ACTION_INVALID", 403);
  return payload;
}
export function createBookingActionLinks(row: BookingRecord, now = Date.now()) {
  if (!row.recipientEmail || row.state === "cancelled") return { rescheduleUrl: "", cancelUrl: "" };
  const expiresAt = Math.min(Date.parse(row.startsAt), now + 7 * 86_400_000);
  if (expiresAt <= now) return { rescheduleUrl: "", cancelUrl: "" };
  const common = { workspaceId: row.workspaceId, organizerId: row.organizerId, bookingId: row.id, version: row.messageVersion ?? 0, recipientHash: recipientHash(row.recipientEmail), expiresAt };
  const origin = getTrustedAppOrigin();
  return {
    rescheduleUrl: `${origin}/booking/manage/${createBookingActionToken({ ...common, purpose: "reschedule" })}`,
    cancelUrl: `${origin}/booking/manage/${createBookingActionToken({ ...common, purpose: "cancel" })}`,
  };
}
export function bookingActionFormNonce(token: string) { return signature(token, "customer-action-form"); }
export function verifyBookingActionForm(request: Request, token: string, nonce: unknown) {
  const origin = new URL(getTrustedAppOrigin()).origin;
  if (request.headers.get("origin") !== origin || typeof nonce !== "string" || !equal(nonce, bookingActionFormNonce(token))) throw new BookingError("BOOKING_ACTION_CONFIRMATION_REQUIRED", 403);
}
/** Bearer authority is narrow and signed; service still revalidates active membership and module. */
export async function readBookingAction(token: string, options: TenantTransactionOptions = {}) {
  if (!isBookingMessageRuntime()) throw new BookingError("BOOKING_MAIL_NOT_ENABLED", 403);
  const payload = verifyBookingActionToken(token);
  const session: AppSession = { authenticated: true, userId: payload.organizerId, workspaceId: payload.workspaceId, workspaceName: "", email: "", name: "", role: "agent", permissions: [], productRole: "team_member", productPermissions: [], source: "database" };
  const row = await withBookingTransaction(session, async (tx, fresh) => {
    const current = await readBooking(tx, fresh, payload.bookingId);
    if (!current.recipientEmail || !equal(recipientHash(current.recipientEmail), payload.recipientHash) || (current.messageVersion ?? 0) !== payload.version || current.state !== "confirmed") throw new BookingError("BOOKING_ACTION_STALE", 409);
    if (!await bookingMessageActivation(tx, fresh, current)) throw new BookingError("BOOKING_ACTION_STALE", 409);
    return current;
  }, options);
  return { payload, session, row };
}
export function bookingActionIdempotencyKey(token: string, startsAt = "") {
  const digest = createHash("sha256").update(`booking-customer-action\0${token}\0${startsAt}`).digest("hex");
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}
