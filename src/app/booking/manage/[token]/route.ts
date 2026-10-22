import { bookingActionFormNonce, bookingActionIdempotencyKey, readBookingAction, verifyBookingActionForm } from "@/lib/booking/message-actions";
import { escapeBookingEmailHtml } from "@/lib/booking/templates";
import { BookingError } from "@/lib/booking/types";
import { localParts } from "@/lib/booking/rules";

const headers = { "content-type": "text/html; charset=utf-8", "cache-control": "private, no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'" };
function page(language: "de" | "en", title: string, content: string, status = 200) {
  return new Response(`<!doctype html><html lang="${language}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeBookingEmailHtml(title)}</title></head><body style="font-family:Arial,sans-serif;background:#f5f7fb;color:#172033;padding:24px"><main style="max-width:620px;margin:auto;background:white;padding:28px"><h1>${escapeBookingEmailHtml(title)}</h1>${content}</main></body></html>`, { status, headers });
}
function failure(error: unknown) {
  return page("de", "Terminlink nicht verfügbar / Appointment link unavailable", "<p>Dieser Terminlink ist abgelaufen oder derzeit nicht verfügbar. Bitte kontaktieren Sie das Unternehmen.</p><p>This appointment link has expired or is currently unavailable. Please contact the company.</p>", error instanceof BookingError ? error.status : 503);
}
export async function GET(request: Request, context: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await context.params, { payload, row, session } = await readBookingAction(token), language = row.communicationLanguage === "en" ? "en" : "de", de = language === "de";
    const title = payload.purpose === "cancel" ? de ? "Termin absagen" : "Cancel appointment" : de ? "Termin verschieben" : "Reschedule appointment";
    const dateText = new Intl.DateTimeFormat(de ? "de-AT" : "en-GB", { timeZone: row.rules.timeZone, dateStyle: "full", timeStyle: "short" }).format(new Date(row.startsAt));
    const intro = `<p>${escapeBookingEmailHtml(dateText)} (${escapeBookingEmailHtml(row.rules.timeZone)})</p><p>${de ? "Erst die ausdrückliche Bestätigung ändert Ihren Termin." : "Your appointment changes only after explicit confirmation."}</p>`;
    const hidden = `<input type="hidden" name="confirmation" value="${bookingActionFormNonce(token)}">`;
    if (payload.purpose === "cancel") return page(language, title, `${intro}<form method="post">${hidden}<button type="submit">${de ? "Termin verbindlich absagen" : "Confirm cancellation"}</button></form>`);
    const date = new URL(request.url).searchParams.get("date") || localParts(Date.parse(row.startsAt), row.rules.timeZone).date;
    const { getBookingAvailability } = await import("@/lib/booking/service");
    const availability = await getBookingAvailability(session, { provider: row.provider, kind: row.kind, date, excludeBookingId: row.id, location: row.rules.location, locationConfirmed: row.rules.locationConfirmed, propertyId: row.rules.propertyId });
    const choices = availability.slots.slice(0, 100).map(slot => `<option value="${escapeBookingEmailHtml(slot.startsAt)}">${escapeBookingEmailHtml(new Intl.DateTimeFormat(de ? "de-AT" : "en-GB", { timeZone: row.rules.timeZone, timeStyle: "short" }).format(new Date(slot.startsAt)))}</option>`).join("");
    const dateForm = `<form method="get"><label>${de ? "Tag" : "Date"} <input type="date" name="date" value="${escapeBookingEmailHtml(date)}" required></label> <button>${de ? "Freie Zeiten anzeigen" : "Show available times"}</button></form>`;
    return page(language, title, `${intro}${dateForm}${choices ? `<form method="post">${hidden}<p><label>${de ? "Neue Uhrzeit" : "New time"} (${escapeBookingEmailHtml(row.rules.timeZone)}) <select name="startsAt" required>${choices}</select></label></p><button type="submit">${de ? "Umbuchung verbindlich bestätigen" : "Confirm rescheduling"}</button></form>` : `<p>${de ? "Keine buchbare Zeit an diesem Tag. Bitte wählen Sie einen anderen Tag oder kontaktieren Sie das Unternehmen." : "No available time on this date. Please choose another date or contact the company."}</p>`}`);
  } catch (error) { return failure(error); }
}
export async function POST(request: Request, context: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await context.params;
    if (!request.headers.get("content-type")?.startsWith("application/x-www-form-urlencoded")) throw new BookingError("BOOKING_ACTION_CONFIRMATION_REQUIRED", 415);
    const reader = request.body?.getReader();
    if (!reader) throw new BookingError("BOOKING_ACTION_CONFIRMATION_REQUIRED");
    const chunks: Uint8Array[] = []; let bytes = 0;
    while (true) { const next = await reader.read(); if (next.done) break; bytes += next.value.byteLength; if (bytes > 8192) { await reader.cancel(); throw new BookingError("BODY_TOO_LARGE", 413); } chunks.push(next.value); }
    const form = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
    verifyBookingActionForm(request, token, form.get("confirmation"));
    const { payload, row, session } = await readBookingAction(token), language = row.communicationLanguage === "en" ? "en" : "de", de = language === "de";
    const { cancelBooking, rescheduleBooking } = await import("@/lib/booking/service");
    const startsAt = form.get("startsAt") || "";
    const result = payload.purpose === "cancel"
      ? await cancelBooking(session, row.id, { idempotencyKey: bookingActionIdempotencyKey(token), expectedMessageVersion: payload.version })
      : await rescheduleBooking(session, row.id, { startsAt, idempotencyKey: bookingActionIdempotencyKey(token, startsAt), expectedMessageVersion: payload.version });
    const complete = payload.purpose === "cancel" ? result.state === "cancelled" : result.state === "confirmed" && result.startsAt === startsAt;
    return page(language, complete ? de ? "Änderung bestätigt" : "Change confirmed" : de ? "Änderung wird geprüft" : "Change is being checked", `<p>${complete ? de ? "Ihr Kalendertermin wurde aktualisiert." : "Your calendar appointment was updated." : de ? "Der Anbieter hat die Änderung noch nicht bestätigt. Bitte kontaktieren Sie das Unternehmen, statt erneut zu buchen." : "The provider has not confirmed the change yet. Please contact the company instead of creating another booking."}</p>`, complete ? 200 : 202);
  } catch (error) { return failure(error); }
}
