import { captureBookingRequest } from "@/lib/booking/service";
import { bookingAuth, bookingBody, bookingFailure, bookingJson, bookingKind, bookingProvider, bookingString } from "../_http";
export async function POST(request: Request) {
  const auth = await bookingAuth(request, true); if (!auth.ok) return auth.response;
  try {
    const body = await bookingBody(request);
    return bookingJson({ request: await captureBookingRequest(auth.session, { kind: bookingKind(body), provider: bookingProvider(body), title: bookingString(body, "title", 200), requestedStartsAt: bookingString(body, "requestedStartsAt", 64), idempotencyKey: bookingString(body, "idempotencyKey", 128), ...(body.contactNote === undefined ? {} : { contactNote: bookingString(body, "contactNote", 2000) }) }) }, 201);
  } catch (error) { return bookingFailure(error); }
}
