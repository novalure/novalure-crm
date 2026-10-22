import { getBookingStatus } from "@/lib/booking/service";
import { bookingAuth, bookingFailure, bookingJson, bookingUuid } from "../../_http";
export async function GET(request: Request, context: { params: Promise<{ bookingId: string }> }) {
  const auth = await bookingAuth(request); if (!auth.ok) return auth.response;
  try { return bookingJson({ booking: await getBookingStatus(auth.session, bookingUuid((await context.params).bookingId)) }); } catch (error) { return bookingFailure(error); }
}
