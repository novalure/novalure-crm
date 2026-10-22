import { listBookingRecords } from "@/lib/booking/service";
import { bookingAuth, bookingFailure, bookingJson } from "../_http";
export async function GET(request: Request) {
  const auth = await bookingAuth(request); if (!auth.ok) return auth.response;
  try { return bookingJson({ bookings: await listBookingRecords(auth.session) }); } catch (error) { return bookingFailure(error); }
}
