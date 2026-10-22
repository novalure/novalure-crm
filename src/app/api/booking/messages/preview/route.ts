import { bookingAuth, bookingBody, bookingFailure, bookingJson } from "../../_http";
import { readBookingSetup } from "@/lib/booking/configuration";
import { withBookingTransaction } from "@/lib/booking/repository";
import { BookingError, type BookingKind } from "@/lib/booking/types";
import { BookingTemplateError, bookingEmailPlaceholders, renderBookingEmail, validateBookingEmailTemplate, type BookingEmailValues, type EmailTemplateKind } from "@/lib/booking/templates";

export async function POST(request: Request) {
  const auth = await bookingAuth(request, true); if (!auth.ok) return auth.response;
  try {
    const body = await bookingBody(request, 32768);
    if (body.language !== "de" && body.language !== "en" || !["confirmation", "reminder", "reschedule", "cancellation"].includes(String(body.kind))) throw new BookingError("INVALID_TEMPLATE_SELECTION");
    const language = body.language, kind = body.kind as EmailTemplateKind, bookingKind = (body.bookingKind ?? "phone") as BookingKind;
    if (!["phone", "teams", "meet", "office", "onsite"].includes(bookingKind)) throw new BookingError("INVALID_BOOKING_TYPE");
    const template = body.template ? validateBookingEmailTemplate(body.template) : (await withBookingTransaction(auth.session, async (tx, fresh) => readBookingSetup(tx, fresh, bookingKind))).communication.templates[language][kind];
    const values: BookingEmailValues = {
      customerName: "Alex Example", firstName: "Alex", companyName: language === "de" ? "Ihr Unternehmen" : "Your company", employeeName: "Sam Example",
      bookingType: language === "de" ? "Beispieltermin" : "Example appointment", date: "24.10.2026", time: "10:00", timeZone: "Europe/Vienna", duration: "45",
      location: language === "de" ? "Bestätigte Beispieladresse" : "Confirmed example address", videoUrl: "https://example.invalid/video-preview",
      preparationNote: "", rescheduleUrl: "https://example.invalid/reschedule-preview", cancelUrl: "https://example.invalid/cancel-preview",
    };
    if (body.values !== undefined) {
      if (!body.values || typeof body.values !== "object" || Array.isArray(body.values)) throw new BookingError("INVALID_TEMPLATE_VALUES");
      for (const [key, value] of Object.entries(body.values)) {
        if (!bookingEmailPlaceholders.includes(key as typeof bookingEmailPlaceholders[number]) || typeof value !== "string" || value.length > 4000) throw new BookingError("INVALID_TEMPLATE_VALUES");
        values[key as keyof BookingEmailValues] = value;
      }
    }
    return bookingJson({ ...renderBookingEmail({ template, language, bookingKind, values }), previewOnly: true });
  } catch (error) { return bookingFailure(error instanceof BookingTemplateError ? new BookingError(error.code) : error); }
}
