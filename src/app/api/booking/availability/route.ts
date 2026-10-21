import { getBookingAvailability } from "@/lib/booking/service";
import { bookingAuth, bookingBody, bookingFailure, bookingJson, bookingKind, bookingProvider, bookingString } from "../_http";
export async function POST(request: Request) {
  const auth = await bookingAuth(request, true); if (!auth.ok) return auth.response;
  try {
    const body = await bookingBody(request);
    return bookingJson(await getBookingAvailability(auth.session, { provider: bookingProvider(body), kind: bookingKind(body), date: bookingString(body, "date", 10) }));
  } catch (error) { return bookingFailure(error); }
}
