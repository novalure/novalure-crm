import { bookingAuth, bookingBody, bookingFailure, bookingJson, bookingString, bookingUuid } from "../../_http";
import { queueBookingTestMessage } from "@/lib/booking/messages";
import { BookingError } from "@/lib/booking/types";
import { BookingTemplateError, validateBookingEmailTemplate, type EmailTemplateKind } from "@/lib/booking/templates";
export async function POST(request: Request) {
  const auth = await bookingAuth(request, true); if (!auth.ok) return auth.response;
  try {
    const body = await bookingBody(request, 32768);
    if (!["confirmation", "reminder", "reschedule", "cancellation"].includes(String(body.kind)) || body.language !== undefined && body.language !== "de" && body.language !== "en") throw new BookingError("INVALID_TEMPLATE_SELECTION");
    return bookingJson(await queueBookingTestMessage(auth.session, { bookingId: bookingUuid(bookingString(body, "bookingId", 64)), kind: body.kind as EmailTemplateKind,
      ...(body.language ? { language: body.language as "de" | "en" } : {}), ...(body.template ? { template: validateBookingEmailTemplate(body.template) } : {}) }), 202);
  } catch (error) { return bookingFailure(error instanceof BookingTemplateError ? new BookingError(error.code) : error); }
}
