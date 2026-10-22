import "server-only";
import type { WebsiteForm } from "@/lib/form-types";
import { attachFormBookingRelation } from "./channels";
import { BookingError } from "./types";

type FormBookingProof = { publicId: string; bookingId: string; token: string };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Keep visitor proof in request memory; only the verified booking ID may persist. */
export function prepareFormBookingFields(form: Pick<WebsiteForm, "fields">, formData: FormData): FormBookingProof[] {
  const proofs: FormBookingProof[] = [];
  for (const field of form.fields.filter(field => field.type === "booking")) {
    const idKey = `booking_${field.id}_id`, tokenKey = `booking_${field.id}_token`;
    const bookingId = formData.get(idKey), token = formData.get(tokenKey);
    formData.delete(tokenKey); formData.delete(idKey); formData.delete(field.crmField || field.id);
    if (!bookingId && !token && !(field.bookingRequired ?? field.required)) continue;
    if (!field.bookingPublicId || typeof bookingId !== "string" || !uuid.test(bookingId) || typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token)) {
      throw new BookingError("FORM_BOOKING_CONFIRMATION_REQUIRED", 422);
    }
    proofs.push({ publicId: field.bookingPublicId, bookingId, token });
    formData.set(field.crmField || field.id, bookingId);
  }
  return proofs;
}

/** Called before the surrounding public form transaction commits. */
export async function attachFormBookingFields(proofs: FormBookingProof[], input: {
  workspaceId: string; formId: string; ids?: { submissionId?: string | null; leadId?: string | null; contactId?: string | null };
}) {
  if (!proofs.length) return;
  if (!input.ids?.submissionId) throw new BookingError("FORM_BOOKING_RELATION_REQUIRED", 409);
  for (const proof of proofs) await attachFormBookingRelation(proof.token, proof.bookingId, {
    publicId: proof.publicId, workspaceId: input.workspaceId, formId: input.formId, submissionId: input.ids.submissionId,
    ...(input.ids.leadId ? { leadId: input.ids.leadId } : {}), ...(input.ids.contactId ? { contactId: input.ids.contactId } : {}),
  });
}
