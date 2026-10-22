import { cancelBooking, confirmBooking, rescheduleBooking } from "@/lib/booking/service";
import { BookingError } from "@/lib/booking/types";
import { bookingAuth, bookingBody, bookingFailure, bookingJson, bookingLocation, bookingString, bookingUuid } from "../../../_http";
export async function POST(request: Request, context: { params: Promise<{ bookingId: string; action: string }> }) {
  const auth = await bookingAuth(request, true); if (!auth.ok) return auth.response;
  try {
    const { bookingId, action } = await context.params;
    bookingUuid(bookingId);
    const body = await bookingBody(request);
    if (action === "confirm") return bookingJson({ booking: await confirmBooking(auth.session, bookingId) });
    const idempotencyKey = bookingString(body, "idempotencyKey", 128);
    if (action === "cancel") return bookingJson({ booking: await cancelBooking(auth.session, bookingId, { idempotencyKey }) });
    if (action === "reschedule") return bookingJson({ booking: await rescheduleBooking(auth.session, bookingId, { startsAt: bookingString(body, "startsAt", 64), idempotencyKey, ...bookingLocation(body) }) });
    throw new BookingError("unknown_booking_action", 404);
  } catch (error) { return bookingFailure(error); }
}
