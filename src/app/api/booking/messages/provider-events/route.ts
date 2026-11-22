import { recordBookingMailProviderEvent, verifyBookingMailWebhook } from "@/lib/booking/message-webhooks";
import { isBookingMessageRuntime } from "@/lib/booking/messages";
import { BookingError } from "@/lib/booking/types";
import { readResendWebhookBody, verifyResendWebhook, ResendWebhookError } from "@/lib/resend-webhooks";
import { recordConfiguredCommerceResendEvent } from "@/lib/website-sales-commerce-host";
export async function POST(request: Request) {
  try {
    const raw = await readResendWebhookBody(request);
    // Untrusted tags select the verifier only; they never grant access or create evidence.
    let commerce = false;
    try {
      const tags = JSON.parse(raw)?.data?.tags;
      commerce = Array.isArray(tags) ? tags.some(tag => tag?.name === 'novalure_kind' && tag?.value === 'sales_commerce')
        : tags?.novalure_kind === 'sales_commerce';
    } catch { /* The existing booking verifier reports malformed payloads. */ }
    if (commerce) {
      const verified = verifyResendWebhook(raw, request.headers);
      if (verified?.reference?.kind !== 'sales_commerce') throw new ResendWebhookError(400, 'invalid_payload');
      const result = await recordConfiguredCommerceResendEvent(verified);
      return Response.json({ ok: true, ...result }, { headers: { "cache-control": "no-store" } });
    }
    if (!isBookingMessageRuntime()) throw new BookingError("BOOKING_MAIL_NOT_ENABLED", 403);
    const event = verifyBookingMailWebhook(raw, request.headers);
    if (event) await recordBookingMailProviderEvent(event);
    return Response.json({ ok: true }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof BookingError || error instanceof ResendWebhookError ? error.code : "MAIL_EVENT_UNAVAILABLE" }, { status: error instanceof BookingError || error instanceof ResendWebhookError ? error.status : 503, headers: { "cache-control": "no-store" } });
  }
}
