import { createHash } from "node:crypto";
import { getLegacyBookingReplacement } from "@/lib/booking/legacy-routing";
import { queryOne, queryRows, withPublicSubmissionTransaction } from "@/lib/db/client";
import { websiteSalesActorId, websiteSalesWorkspaceId } from "@/lib/website-sales-ingestion";
import {
  createStudioMicrosoftEvent, findStudioMicrosoftEvent, listStudioMicrosoftBusy,
  type StudioCalendarEvent, type StudioCalendarPolicy,
} from "@/lib/integrations/studio-microsoft-calendar";

type BookingKind = "phone" | "teams";
type BookingRow = {
  id: string; crmReference: string; requestHash: string; status: string; kind: BookingKind;
  organizerId: string; calendarId: string; policyApprovalId: string;
  providerTransactionId: string; startsAt: string | Date; endsAt: string | Date;
  providerEventId: string | null; teamsUrl: string | null; invitationTriggered: boolean;
};
type Slot = { start: string; end: string };
type Busy = Slot;
export type StudioBookingRequest = {
  confirmed: true; idempotencyKey: string; crmReference: string; kind: BookingKind;
  visitorTimeZone: string; start: string; name: string; email: string; phone: string; reason: string;
};

export class StudioBookingFailure extends Error {
  constructor(readonly code: string) { super(code); }
}

function sha(value: string) { return createHash("sha256").update(value).digest("hex"); }
function dateIso(value: string | Date) { return new Date(value).toISOString(); }
function zoneValid(value: string) {
  try { return Boolean(new Intl.DateTimeFormat("en", { timeZone: value }).resolvedOptions().timeZone); }
  catch { return false; }
}
function partsAt(instant: Date, zone: string) {
  return Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
    timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(instant).map(({ type, value }) => [type, value]));
}
function slotToUtc(dateKey: string, minutes: number, zone: string) {
  const [year, month, day] = dateKey.split("-").map(Number);
  const naive = Date.UTC(year, month - 1, day, Math.floor(minutes / 60), minutes % 60);
  const offsets = new Set([-86_400_000, 0, 86_400_000].map((delta) => {
    const instant = new Date(naive + delta);
    const parts = partsAt(instant, zone);
    return Math.round((Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day),
      Number(parts.hour), Number(parts.minute)) - instant.getTime()) / 60_000);
  }));
  const matches = [...offsets].map((offset) => new Date(naive - offset * 60_000))
    .filter((instant) => {
      const parts = partsAt(instant, zone);
      return `${parts.year}-${parts.month}-${parts.day}` === dateKey &&
        Number(parts.hour) * 60 + Number(parts.minute) === minutes;
    });
  return matches.length === 1 ? matches[0].toISOString() : null;
}
function overlaps(start: number, end: number, busy: Busy, bufferMinutes: number) {
  return start < Date.parse(busy.end) + bufferMinutes * 60_000 &&
    end > Date.parse(busy.start) - bufferMinutes * 60_000;
}

export function availableStudioSlots(policy: StudioCalendarPolicy, busy: Busy[], now = new Date()): Slot[] {
  const slots: Slot[] = [];
  const local = partsAt(now, policy.timeZone);
  const first = `${local.year}-${local.month}-${local.day}`;
  for (let day = 0; day < policy.horizonDays; day += 1) {
    const date = new Date(`${first}T12:00:00Z`);
    date.setUTCDate(date.getUTCDate() + day);
    const key = date.toISOString().slice(0, 10);
    const windows = policy.hours[String(date.getUTCDay())] ?? [];
    for (const window of windows) {
      for (let minute = window.start; minute + policy.durationMinutes <= window.end;
        minute += policy.intervalMinutes) {
        const start = slotToUtc(key, minute, policy.timeZone);
        if (!start) continue;
        const startMs = Date.parse(start);
        const endMs = startMs + policy.durationMinutes * 60_000;
        if (startMs < now.getTime() + policy.minNoticeMinutes * 60_000 ||
            busy.some((item) => overlaps(startMs, endMs, item, policy.bufferMinutes))) continue;
        slots.push({ start, end: new Date(endMs).toISOString() });
      }
    }
  }
  return slots.slice(0, 80);
}

async function inStudioTransaction<T>(callback: () => Promise<T>) {
  return withPublicSubmissionTransaction({ actorId: websiteSalesActorId,
    workspaceId: websiteSalesWorkspaceId }, callback);
}

async function activeSlots(excludeHash?: string): Promise<Busy[]> {
  return inStudioTransaction(async () => {
    const rows = await queryRows<{ startsAt: Date; endsAt: Date }>(
      `select starts_at as "startsAt", ends_at as "endsAt" from studio_sales_bookings
       where workspace_id=$1::uuid and status in ('processing','uncertain','booked','needs_attention')
         and ($2::text is null or idempotency_hash <> $2)`,
      [websiteSalesWorkspaceId, excludeHash ?? null],
    );
    return rows.map((row) => ({ start: dateIso(row.startsAt), end: dateIso(row.endsAt) }));
  });
}

export async function studioBookingAvailability(policy: StudioCalendarPolicy, input: {
  kind: BookingKind; visitorTimeZone: string;
}, now = new Date(), excludeHash?: string) {
  const replacement = await getLegacyBookingReplacement(websiteSalesWorkspaceId);
  if (replacement && replacement.publicId === process.env.STUDIO_BOOKING_PUBLIC_ID) throw new StudioBookingFailure("booking_channel_moved");
  if (!["phone", "teams"].includes(input.kind) || !zoneValid(input.visitorTimeZone)) {
    throw new StudioBookingFailure("invalid_booking_request");
  }
  const until = new Date(now.getTime() + (policy.horizonDays + 2) * 86_400_000);
  const [calendarBusy, reservations] = await Promise.all([
    listStudioMicrosoftBusy(policy, now.toISOString(), until.toISOString()), activeSlots(excludeHash),
  ]);
  return { kind: input.kind, visitorTimeZone: input.visitorTimeZone,
    organizerTimeZone: policy.timeZone, durationMinutes: policy.durationMinutes,
    slots: availableStudioSlots(policy, [...calendarBusy, ...reservations], now) };
}

function validatedBooking(input: unknown): StudioBookingRequest {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new StudioBookingFailure("invalid_booking_request");
  const body = input as Partial<StudioBookingRequest>;
  if (body.confirmed !== true || !/^[A-Za-z0-9_-]{16,128}$/.test(body.idempotencyKey ?? "") ||
      !/^NL-[A-F0-9]{8}$/.test(body.crmReference ?? "") ||
      (body.kind !== "phone" && body.kind !== "teams") ||
      !body.visitorTimeZone || !zoneValid(body.visitorTimeZone) ||
      !body.start || !Number.isFinite(Date.parse(body.start)) ||
      !body.name?.trim() || body.name.length > 120 ||
      !body.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email) || body.email.length > 254 ||
      !body.reason?.trim() || body.reason.length > 500 ||
      (body.kind === "phone" && !body.phone?.trim()) || (body.phone?.length ?? 0) > 40) {
    throw new StudioBookingFailure("invalid_booking_request");
  }
  return { confirmed: true, idempotencyKey: body.idempotencyKey!, crmReference: body.crmReference!,
    kind: body.kind, visitorTimeZone: body.visitorTimeZone, start: new Date(body.start).toISOString(),
    name: body.name.trim(), email: body.email.trim().toLowerCase(), phone: body.phone?.trim() ?? "",
    reason: body.reason.trim() };
}

function publicReceipt(row: BookingRow) {
  const status = row.status === "booked" ? "booked" : row.status === "needs_attention" ? "uncertain" : row.status;
  return { status, crmReference: row.crmReference, kind: row.kind, start: dateIso(row.startsAt),
    end: dateIso(row.endsAt), eventId: row.providerEventId, teamsUrl: row.status === "booked" ? row.teamsUrl : null,
    provider: "microsoft-365", invitationTriggered: row.invitationTriggered,
    invitationReceived: false, crmLinkStatus: row.status === "booked" ? "linked" : "pending" };
}

async function readBooking(keyHash: string, reference: string) {
  return inStudioTransaction(() => queryOne<BookingRow>(
    `select id, crm_reference as "crmReference", request_hash as "requestHash", status, kind,
       organizer_id as "organizerId", calendar_id as "calendarId", policy_approval_id as "policyApprovalId",
       provider_transaction_id as "providerTransactionId", starts_at as "startsAt", ends_at as "endsAt",
       provider_event_id as "providerEventId", teams_url as "teamsUrl",
       invitation_triggered as "invitationTriggered"
     from studio_sales_bookings where workspace_id=$1::uuid and idempotency_hash=$2 and crm_reference=$3`,
    [websiteSalesWorkspaceId, keyHash, reference],
  ));
}

async function finishBooking(keyHash: string, event: StudioCalendarEvent, kind: BookingKind) {
  return inStudioTransaction(() => queryOne<BookingRow>(
    `update studio_sales_bookings set status=$3, provider_event_id=$4, teams_url=$5,
       invitation_triggered=$6, error_code=$7, updated_at=now()
     where workspace_id=$1::uuid and idempotency_hash=$2 and status in ('processing','uncertain','needs_attention')
     returning id, crm_reference as "crmReference", request_hash as "requestHash", status, kind,
       organizer_id as "organizerId", calendar_id as "calendarId", policy_approval_id as "policyApprovalId",
       provider_transaction_id as "providerTransactionId", starts_at as "startsAt", ends_at as "endsAt",
       provider_event_id as "providerEventId", teams_url as "teamsUrl",
       invitation_triggered as "invitationTriggered"`,
    [websiteSalesWorkspaceId, keyHash, kind === "teams" && !event.teamsUrl ? "needs_attention" : "booked",
      event.eventId, kind === "teams" ? event.teamsUrl : null, event.invitationTriggered,
      kind === "teams" && !event.teamsUrl ? "teams_link_missing" : null],
  ));
}

async function markBooking(keyHash: string, status: "rejected" | "uncertain", code: string) {
  return inStudioTransaction(() => queryOne<{ id: string }>(
    `update studio_sales_bookings set status=$3, error_code=$4, updated_at=now()
     where workspace_id=$1::uuid and idempotency_hash=$2 and status='processing' returning id`,
    [websiteSalesWorkspaceId, keyHash, status, code],
  ));
}

export async function studioBookingStatus(policy: StudioCalendarPolicy, input: {
  idempotencyKey: string; crmReference: string;
}) {
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(input.idempotencyKey) ||
      !/^NL-[A-F0-9]{8}$/.test(input.crmReference)) throw new StudioBookingFailure("invalid_booking_request");
  const keyHash = sha(`studio-booking-v1:${input.idempotencyKey}`);
  const row = await readBooking(keyHash, input.crmReference);
  if (!row) return { status: "not_found" };
  if (row.status !== "uncertain" && row.status !== "processing" && row.status !== "needs_attention") return publicReceipt(row);
  if (row.organizerId !== policy.organizerId || row.calendarId !== policy.calendarId ||
      row.policyApprovalId !== policy.approvalId) return { ...publicReceipt(row), status: "uncertain" };
  let found: StudioCalendarEvent | null;
  try {
    found = await findStudioMicrosoftEvent(policy, { start: new Date(Date.parse(dateIso(row.startsAt)) - 60_000).toISOString(),
      end: new Date(Date.parse(dateIso(row.endsAt)) + 60_000).toISOString(),
      transactionId: row.providerTransactionId });
  } catch { return { ...publicReceipt(row), status: "uncertain" }; }
  if (!found) return { ...publicReceipt(row), status: "uncertain" };
  const finished = await finishBooking(keyHash, found, row.kind);
  return finished ? publicReceipt(finished) : { ...publicReceipt(row), status: "uncertain" };
}

export async function studioBook(policy: StudioCalendarPolicy, raw: unknown) {
  const replacement = await getLegacyBookingReplacement(websiteSalesWorkspaceId);
  if (replacement && replacement.publicId === process.env.STUDIO_BOOKING_PUBLIC_ID) throw new StudioBookingFailure("booking_channel_moved");
  const input = validatedBooking(raw);
  if (policy.qaRecipients?.length && !policy.qaRecipients.includes(input.email)) {
    throw new StudioBookingFailure("qa_recipient_not_approved");
  }
  const keyHash = sha(`studio-booking-v1:${input.idempotencyKey}`);
  const requestHash = sha(JSON.stringify({ reference: input.crmReference, kind: input.kind,
    visitorTimeZone: input.visitorTimeZone, start: input.start, name: input.name,
    email: input.email, phone: input.phone, reason: input.reason }));
  const end = new Date(Date.parse(input.start) + policy.durationMinutes * 60_000).toISOString();
  const claim = await inStudioTransaction(async () => {
    await queryRows("select pg_advisory_xact_lock(hashtext('studio-sales-bookings'))", []);
    const previous = await readBookingInTransaction(keyHash);
    if (previous) return { state: previous.requestHash === requestHash ? "replay" : "conflict", row: previous };
    const handoff = await queryOne<{ leadId: string; contactEmail: string }>(
      `select lead_id as "leadId", contact_email as "contactEmail" from studio_sales_handoffs
       where workspace_id=$1::uuid and reference=$2 and status='accepted'`,
      [websiteSalesWorkspaceId, input.crmReference],
    );
    if (!handoff || handoff.contactEmail !== input.email) return { state: "lead_unavailable" };
    const collision = await queryOne<{ id: string }>(
      `select id from studio_sales_bookings where workspace_id=$1::uuid
         and status in ('processing','uncertain','booked','needs_attention')
         and starts_at < $3::timestamptz and ends_at > $2::timestamptz limit 1`,
      [websiteSalesWorkspaceId,
        new Date(Date.parse(input.start) - policy.bufferMinutes * 60_000).toISOString(),
        new Date(Date.parse(end) + policy.bufferMinutes * 60_000).toISOString()],
    );
    if (collision) return { state: "slot_taken" };
    const row = await queryOne<BookingRow>(
      `insert into studio_sales_bookings
         (workspace_id, crm_reference, lead_id, idempotency_hash, request_hash, status, kind,
          organizer_id, calendar_id, policy_approval_id,
          visitor_time_zone, starts_at, ends_at, contact_name, contact_email, contact_phone, reason)
       values ($1::uuid,$2,$3::uuid,$4,$5,'processing',$6,$7,$8,$9,$10,$11::timestamptz,$12::timestamptz,$13,$14,$15,$16)
       returning id, crm_reference as "crmReference", request_hash as "requestHash", status, kind,
         organizer_id as "organizerId", calendar_id as "calendarId", policy_approval_id as "policyApprovalId",
         provider_transaction_id as "providerTransactionId", starts_at as "startsAt", ends_at as "endsAt",
         provider_event_id as "providerEventId", teams_url as "teamsUrl",
         invitation_triggered as "invitationTriggered"`,
      [websiteSalesWorkspaceId, input.crmReference, handoff.leadId, keyHash, requestHash,
        input.kind, policy.organizerId, policy.calendarId, policy.approvalId,
        input.visitorTimeZone, input.start, end, input.name, input.email, input.phone, input.reason],
    );
    if (!row) throw new StudioBookingFailure("booking_store_unavailable");
    return { state: "claimed", row };
  });
  if (claim.state === "conflict" || claim.state === "slot_taken" || claim.state === "lead_unavailable") {
    throw new StudioBookingFailure(claim.state);
  }
  if (!claim.row) throw new StudioBookingFailure("booking_store_unavailable");
  if (claim.state === "replay") {
    if (claim.row.status === "booked" || claim.row.status === "rejected") return publicReceipt(claim.row);
    return studioBookingStatus(policy, input);
  }
  let fresh;
  try { fresh = await studioBookingAvailability(policy,
    { kind: input.kind, visitorTimeZone: input.visitorTimeZone }, new Date(), keyHash); }
  catch (error) {
    await markBooking(keyHash, "rejected", error instanceof Error ? error.message : "calendar_availability_unavailable");
    throw error;
  }
  if (!fresh.slots.some((slot) => slot.start === input.start)) {
    await markBooking(keyHash, "rejected", "slot_unavailable");
    throw new StudioBookingFailure("slot_unavailable");
  }
  try {
    const event = await createStudioMicrosoftEvent(policy, { ...input,
      transactionId: claim.row.providerTransactionId, end });
    const finished = await finishBooking(keyHash, event, input.kind);
    return finished ? publicReceipt(finished) : { status: "uncertain" };
  } catch (error) {
    const code = error instanceof Error ? error.message : "calendar_create_uncertain";
    await markBooking(keyHash, code === "calendar_permission_denied" || code === "calendar_auth_unavailable"
      ? "rejected" : "uncertain", code).catch(() => null);
    return { status: code === "calendar_permission_denied" || code === "calendar_auth_unavailable"
      ? "request_only" : "uncertain" };
  }
}

async function readBookingInTransaction(keyHash: string) {
  return queryOne<BookingRow>(
    `select id, crm_reference as "crmReference", request_hash as "requestHash", status, kind,
       organizer_id as "organizerId", calendar_id as "calendarId", policy_approval_id as "policyApprovalId",
       provider_transaction_id as "providerTransactionId", starts_at as "startsAt", ends_at as "endsAt",
       provider_event_id as "providerEventId", teams_url as "teamsUrl",
       invitation_triggered as "invitationTriggered"
     from studio_sales_bookings where workspace_id=$1::uuid and idempotency_hash=$2`,
    [websiteSalesWorkspaceId, keyHash],
  );
}
