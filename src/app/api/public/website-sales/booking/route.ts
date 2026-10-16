import { createHmac, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { readStudioCalendarPolicy } from "@/lib/integrations/studio-microsoft-calendar";
import { StudioBookingFailure, studioBook, studioBookingAvailability,
  studioBookingStatus } from "@/lib/studio-sales-booking";

const version = "website-sales-booking-v1";
const headers = { "cache-control": "private, no-store" };

function reply(status: number, body: Record<string, unknown>) {
  return NextResponse.json(body, { status, headers });
}

function verifyStudioBookingSignature(input: {
  body: string; secret?: string; signature: string | null; timestamp: string | null;
}, now = Date.now()) {
  const secret = input.secret?.trim() ?? "";
  const timestamp = input.timestamp ?? "";
  const seconds = Number(timestamp);
  if (Buffer.byteLength(secret, "utf8") < 32 || !/^[0-9]{10,11}$/.test(timestamp) ||
      !Number.isInteger(seconds) || Math.abs(Math.floor(now / 1_000) - seconds) > 300 ||
      !input.signature || input.signature.length > 128) return false;
  const expected = Buffer.from(createHmac("sha256", secret)
    .update(`${version}.${timestamp}.${input.body}`, "utf8").digest("base64url"));
  const supplied = Buffer.from(input.signature);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

export async function POST(request: Request) {
  if (!request.headers.get("content-type")?.includes("application/json")) {
    return reply(415, { status: "failed", code: "unsupported_content_type" });
  }
  const size = Number(request.headers.get("content-length") ?? "0");
  if (!Number.isSafeInteger(size) || size > 4_000) return reply(413, { status: "failed", code: "too_large" });
  const rawBody = await request.text();
  if (Buffer.byteLength(rawBody, "utf8") > 4_000 || !verifyStudioBookingSignature({
    body: rawBody, secret: process.env.NOVALURE_STUDIO_INGESTION_SECRET,
    signature: request.headers.get("x-novalure-signature"),
    timestamp: request.headers.get("x-novalure-timestamp"),
  })) return reply(401, { status: "failed", code: "unauthorized" });
  const policy = readStudioCalendarPolicy();
  if (!policy) return reply(503, { status: "request_only", code: "booking_configuration_unavailable" });
  let body: Record<string, unknown>;
  try { body = JSON.parse(rawBody) as Record<string, unknown>; }
  catch { return reply(400, { status: "failed", code: "invalid_json" }); }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return reply(400, { status: "failed", code: "invalid_json" });
  }
  try {
    if (body.operation === "availability") {
      if ((body.kind !== "phone" && body.kind !== "teams") || typeof body.visitorTimeZone !== "string") {
        throw new StudioBookingFailure("invalid_booking_request");
      }
      const result = await studioBookingAvailability(policy,
        { kind: body.kind, visitorTimeZone: body.visitorTimeZone });
      return reply(200, { ...result, mode: "real_integration" });
    }
    if (body.operation === "book") {
      const result = await studioBook(policy, body.booking);
      return reply(result.status === "processing" ? 409 : 200, { ...result, mode: "real_integration" });
    }
    if (body.operation === "status") {
      if (typeof body.idempotencyKey !== "string" || typeof body.crmReference !== "string") {
        throw new StudioBookingFailure("invalid_booking_request");
      }
      const result = await studioBookingStatus(policy,
        { idempotencyKey: body.idempotencyKey, crmReference: body.crmReference });
      return reply(result.status === "not_found" ? 404 : 200, { ...result, mode: "real_integration" });
    }
    return reply(400, { status: "failed", code: "invalid_operation" });
  } catch (error) {
    const code = error instanceof StudioBookingFailure ? error.code
      : error instanceof Error && /^[a-z_]+$/.test(error.message) ? error.message : "booking_unavailable";
    const status = code === "slot_taken" || code === "slot_unavailable" || code === "conflict" ? 409
      : code === "invalid_booking_request" ? 400 : 503;
    console.error("studio_sales_booking_failed", { code });
    return reply(status, { status: status === 503 ? "request_only" : "failed", code });
  }
}
