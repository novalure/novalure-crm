import { bookingAuth, bookingBody, bookingFailure, bookingJson, bookingString } from "../../_http";
import { getBookingPublication } from "@/lib/booking/publication";
import { checkBookingInstallation } from "@/lib/booking/installation-check";

export async function POST(request: Request) {
  const auth = await bookingAuth(request, true); if (!auth.ok) return auth.response;
  try {
    const body = await bookingBody(request, 4096);
    const saved = await getBookingPublication(auth.session);
    return bookingJson(await checkBookingInstallation({ url: bookingString(body, "url", 2048), publicId: saved.publication.publicId, allowedOrigins: saved.publication.allowedOrigins, embedOrigin: saved.embedOrigin }));
  } catch (error) { return bookingFailure(error); }
}
