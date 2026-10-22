import { getBookingMessageJobs } from "@/lib/booking/messages";
import { bookingAuth, bookingFailure, bookingJson } from "../_http";
export async function GET(request: Request) {
  const auth = await bookingAuth(request); if (!auth.ok) return auth.response;
  try { return bookingJson({ jobs: await getBookingMessageJobs(auth.session) }); }
  catch (error) { return bookingFailure(error); }
}
