import { recordBookingMailProviderEvent, verifyBookingMailWebhook } from "@/lib/booking/message-webhooks";
import { isBookingMessageRuntime } from "@/lib/booking/messages";
import { BookingError } from "@/lib/booking/types";
export async function POST(request: Request) {
  try {
    if (!isBookingMessageRuntime()) throw new BookingError("BOOKING_MAIL_NOT_ENABLED", 403);
    const reader = request.body?.getReader();
    if (!reader) throw new BookingError("INVALID_MAIL_EVENT");
    const chunks: Uint8Array[] = []; let length = 0;
    while (true) { const item = await reader.read(); if (item.done) break; length += item.value.byteLength; if (length > 65_536) { await reader.cancel(); throw new BookingError("BODY_TOO_LARGE", 413); } chunks.push(item.value); }
    const event = verifyBookingMailWebhook(Buffer.concat(chunks).toString("utf8"), request.headers);
    if (event) await recordBookingMailProviderEvent(event);
    return Response.json({ ok: true }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof BookingError ? error.code : "MAIL_EVENT_UNAVAILABLE" }, { status: error instanceof BookingError ? error.status : 503, headers: { "cache-control": "no-store" } });
  }
}
