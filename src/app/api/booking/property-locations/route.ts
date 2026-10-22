import { bookingAuth, bookingFailure, bookingJson } from "../_http";
import { listBookingPropertyLocations } from "@/lib/booking/property-locations";
import { BookingError } from "@/lib/booking/types";

export async function GET(request: Request) {
  const auth = await bookingAuth(request); if (!auth.ok) return auth.response;
  try {
    const params = new URL(request.url).searchParams;
    if (params.has("workspaceId") && params.get("workspaceId") !== auth.session.workspaceId || params.has("userId") && params.get("userId") !== auth.session.userId) throw new BookingError("PROPERTY_LOCATION_FORBIDDEN", 403);
    return bookingJson({ properties: await listBookingPropertyLocations(auth.session, params.get("q") ?? "") });
  } catch (error) { return bookingFailure(error); }
}
