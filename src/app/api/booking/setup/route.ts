import { getBookingSetup, saveBookingSetup, validateBookingSetupMutation } from "@/lib/booking/configuration";
import { BookingError } from "@/lib/booking/types";
import { bookingAuth, bookingBody, bookingFailure, bookingJson } from "../_http";

export async function GET(request: Request) {
  const auth = await bookingAuth(request);
  if (!auth.ok) return auth.response;
  try {
    const requested = new URL(request.url).searchParams.get("workspaceId");
    if (requested && requested !== auth.session.workspaceId) throw new BookingError("calendar_scope_forbidden", 403);
    return bookingJson(await getBookingSetup(auth.session));
  }
  catch (error) { return bookingFailure(error); }
}

async function mutate(request: Request, reset: boolean) {
  const auth = await bookingAuth(request, true);
  if (!auth.ok) return auth.response;
  try {
    const input = validateBookingSetupMutation(await bookingBody(request, 65_536), reset);
    return bookingJson(await saveBookingSetup(auth.session, input, {}, reset));
  } catch (error) { return bookingFailure(error); }
}

export async function PUT(request: Request) { return mutate(request, false); }
export async function DELETE(request: Request) { return mutate(request, true); }
