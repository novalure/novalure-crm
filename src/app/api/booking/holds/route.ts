import { createBookingHold } from "@/lib/booking/service";
import { bookingAuth, bookingBody, bookingFailure, bookingJson, bookingKind, bookingProvider, bookingString } from "../_http";
export async function POST(request: Request) {
  const auth = await bookingAuth(request, true); if (!auth.ok) return auth.response;
  try {
    const body = await bookingBody(request);
    const booking = await createBookingHold(auth.session, { provider: bookingProvider(body), kind: bookingKind(body), startsAt: bookingString(body, "startsAt", 64), title: bookingString(body, "title", 200), idempotencyKey: bookingString(body, "idempotencyKey", 128) });
    return bookingJson({ booking }, 201);
  } catch (error) { return bookingFailure(error); }
}
