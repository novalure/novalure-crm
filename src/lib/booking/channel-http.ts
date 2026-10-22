import "server-only";
import { CrmCommandError } from "@/lib/crm-command";
import { CrmMachineAuthError } from "@/lib/crm-machine-auth";
import { ExternalIntegrationError } from "@/lib/db/external-integration-gateway";
import { readKnowledgeJson } from "@/lib/knowledge-center/http";
import { KnowledgeCenterError } from "@/lib/knowledge-center/policy";
import { dispatchBookingChannelAction, issueTrustedBookingChannelSession, type BookingChannelAction, type BookingChannelOptions } from "./channels";
import { assertBookingChannelType, verifyMachineBookingAuthority, type BookingChannelAuthority, type BookingMachineOptions } from "./channel-bindings";
import type { PublicBookingRecord } from "./publication-types";
import { BookingError } from "./types";

const headers = { "cache-control": "private, no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff" };
const fields = ["operation", "typeId", "language", "token", "date", "startsAt", "location", "locationConfirmed", "recipientEmail", "recipientName", "idempotencyKey", "bookingId", "consent", "summary"] as const;
const actionFields: Record<string, readonly string[]> = {
  session: ["operation", "typeId", "language"],
  availability: ["operation", "token", "date", "location", "locationConfirmed", "bookingId"],
  hold: ["operation", "token", "startsAt", "recipientEmail", "recipientName", "location", "locationConfirmed", "idempotencyKey"],
  confirm: ["operation", "token", "bookingId", "consent", "summary"],
  status: ["operation", "token", "bookingId", "idempotencyKey"],
  reschedule: ["operation", "token", "bookingId", "startsAt", "idempotencyKey", "consent", "summary"],
  cancel: ["operation", "token", "bookingId", "idempotencyKey", "consent", "summary"],
};

export function bookingChannelJson(body: unknown, status = 200) { return Response.json(body, { status, headers }); }
export function bookingChannelError(error: unknown) {
  const known = error instanceof BookingError || error instanceof CrmCommandError || error instanceof CrmMachineAuthError || error instanceof ExternalIntegrationError || error instanceof KnowledgeCenterError;
  const status = known ? error.status : 503;
  return bookingChannelJson({ code: known ? error.code : "BOOKING_CHANNEL_UNAVAILABLE", status: status >= 500 ? "unknown" : "denied" }, status);
}

export async function readBookingChannelToolBody(request: Request) {
  return readKnowledgeJson(request, fields, 16_384);
}

/** Consent is tied to the stored hold and the exact spoken/displayed summary. */
export function assertBookingChannelSummary(body: Record<string, unknown>, booking: PublicBookingRecord) {
  const summary = body.summary && typeof body.summary === "object" && !Array.isArray(body.summary)
    ? body.summary as Record<string, unknown> : {};
  const startsAt = body.operation === "reschedule" ? body.startsAt : booking.startsAt;
  const location = body.operation === "reschedule" && body.location !== undefined ? body.location : booking.location;
  if (body.consent !== true || Object.keys(summary).some(key => !["startsAt", "timeZone", "kind", "location"].includes(key)) ||
      summary.startsAt !== startsAt || summary.timeZone !== booking.timeZone || summary.kind !== booking.kind || summary.location !== location) {
    throw new BookingError("BOOKING_SUMMARY_CONSENT_REQUIRED", 409);
  }
}

/** Used only after the caller's upstream binding was freshly verified on this request. */
export async function dispatchTrustedBookingTool(request: Request, channel: "chat" | "voice", authority: BookingChannelAuthority,
  body: Record<string, unknown>, options: BookingChannelOptions = {}) {
  const operation = typeof body.operation === "string" ? body.operation : "";
  if (!actionFields[operation] || Object.keys(body).some(key => !actionFields[operation].includes(key))) throw new BookingError("INVALID_BOOKING_CHANNEL_OPERATION");
  if (operation === "session") {
    return issueTrustedBookingChannelSession(request, {
      publicId: authority.publicId, typeId: assertBookingChannelType(authority, body.typeId), channel,
      language: body.language === "de" ? "de" : "en", workspaceId: authority.workspaceId,
      bindingId: authority.bindingId, relation: authority.relation,
    }, options);
  }
  if (typeof body.token !== "string" || body.token.length > 512) throw new BookingError("BOOKING_CHANNEL_UNAUTHORIZED", 401);
  const scoped = { ...options, trustedBinding: { expectedChannel: channel, expectedWorkspaceId: authority.workspaceId,
    expectedPublicId: authority.publicId, expectedBindingId: authority.bindingId, expectedTypeIds: authority.typeIds } };
  const payload = { ...body };
  delete payload.operation; delete payload.token; delete payload.summary;
  if (["confirm", "reschedule", "cancel"].includes(operation)) {
    const status = await dispatchBookingChannelAction(body.token, "status", { bookingId: body.bookingId }, request, scoped);
    if (!("booking" in status) || !status.booking) throw new BookingError("BOOKING_NOT_FOUND", 404);
    assertBookingChannelSummary(body, status.booking as PublicBookingRecord);
    // An interrupted create is reconciled through status. Never issue another creation.
    if (operation === "confirm" && ["processing", "uncertain"].includes((status.booking as PublicBookingRecord).state)) return status;
  }
  return dispatchBookingChannelAction(body.token, operation as BookingChannelAction, payload, request, scoped);
}

export async function handleMachineBookingRequest(request: Request, channel: "chat" | "voice", options: BookingChannelOptions & BookingMachineOptions = {}) {
  try {
    const authority = await verifyMachineBookingAuthority(request, channel, options);
    const body = await readBookingChannelToolBody(request);
    return bookingChannelJson(await dispatchTrustedBookingTool(request, channel, authority, body, options));
  } catch (error) { return bookingChannelError(error); }
}

export const preparedTelephonyBookingIntegration = Object.freeze({
  provider: "vapi", status: "not_connected", contractVersion: "booking-tools-v1",
  requiresIndependentBookingGrant: true, callerNumberAuthorizesChanges: false, outboundActionsEnabled: false,
});
