import { getBookingSettings, saveBookingRules } from "@/lib/booking/service";
import { BookingError, type BookingRules } from "@/lib/booking/types";
import { bookingAuth, bookingBody, bookingFailure, bookingJson, bookingKind } from "../_http";
export async function GET(request: Request) {
  const auth = await bookingAuth(request); if (!auth.ok) return auth.response;
  try { return bookingJson(await getBookingSettings(auth.session)); } catch (error) { return bookingFailure(error); }
}
export async function PUT(request: Request) {
  const auth = await bookingAuth(request, true); if (!auth.ok) return auth.response;
  try {
    const body = await bookingBody(request);
    if (!body.rules || typeof body.rules !== "object" || Array.isArray(body.rules)) throw new BookingError("invalid_rules");
    const kind = body.kind === undefined || body.kind === null ? null : bookingKind(body);
    if (body.workspaceDefault !== undefined && typeof body.workspaceDefault !== "boolean") throw new BookingError("invalid_rules");
    return bookingJson(await saveBookingRules(auth.session, { kind, rules: body.rules as Partial<BookingRules>, workspaceDefault: body.workspaceDefault === true }));
  } catch (error) { return bookingFailure(error); }
}
