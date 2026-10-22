import { createBookingHold } from "@/lib/booking/service";
import { bookingAuth, bookingBody, bookingFailure, bookingJson, bookingKind, bookingLocation, bookingProvider, bookingString } from "../_http";
import { normalizeBookingRecipient } from "@/lib/booking/messages";
export async function POST(request: Request) {
  const auth = await bookingAuth(request, true); if (!auth.ok) return auth.response;
  try {
    const body = await bookingBody(request);
    const recipient=normalizeBookingRecipient(body);
    const booking = await createBookingHold(auth.session, { provider: bookingProvider(body), kind: bookingKind(body), startsAt: bookingString(body, "startsAt", 64), title: bookingString(body, "title", 200), idempotencyKey: bookingString(body, "idempotencyKey", 128), ...bookingLocation(body), ...recipient, recipientEmail:recipient.recipientEmail??undefined });
    return bookingJson({ booking }, 201);
  } catch (error) { return bookingFailure(error); }
}
