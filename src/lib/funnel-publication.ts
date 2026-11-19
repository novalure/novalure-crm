import type { FunnelBlueprint, FunnelField } from "@/lib/funnel-schema";

export function funnelFormFields(blueprint: FunnelBlueprint): FunnelField[] {
  return blueprint.pages.flatMap(page => page.sections.flatMap(section => section.rows.flatMap(row => row.columns.flatMap(column => column.elements.flatMap(element => element.type === "form" ? element.fields ?? [] : [])))));
}

export function runFunnelPreflight(blueprint: FunnelBlueprint) {
  const fields = funnelFormFields(blueprint), blockers: string[] = [];
  if (!fields.length) blockers.push("contact_form_missing");
  if (!fields.some(field => field.type === "consent" && field.required && field.crmField === "privacy_consent")) blockers.push("privacy_consent_missing");
  if (!fields.some(field => ["email", "phone"].includes(field.type) && field.required)) blockers.push("contact_channel_required");
  if (fields.some(field => field.required && !field.label.trim())) blockers.push("required_field_label_missing");
  if (!blueprint.crmHandover.createLeadInboxEntry) blockers.push("lead_inbox_required");
  if (blueprint.crmHandover.createAppointment) blockers.push("appointment_not_supported");
  if (!["leadInbox", "pipeline"].includes(blueprint.crmHandover.destination)) blockers.push("handover_requires_booking_or_newsletter_flow");
  return { ok: !blockers.length, blockers };
}

export function funnelPublicationBlockerText(code: string, language: string) {
  const labels: Record<string, [string, string]> = {
    contact_form_missing: ["Kontaktformular ergänzen.", "Add a contact form."],
    privacy_consent_missing: ["Verpflichtenden Datenschutzhinweis im Formular ergänzen.", "Add the required privacy acknowledgement."],
    contact_channel_required: ["E-Mail oder Telefon als Pflichtfeld festlegen.", "Require an email address or phone number."],
    required_field_label_missing: ["Alle Pflichtfelder verständlich beschriften.", "Label all required fields."],
    lead_inbox_required: ["Übergabe an die Lead-Zentrale einschalten.", "Enable handover to the lead inbox."],
    appointment_not_supported: ["Die unmittelbare Terminbuchung ist hier noch nicht verbunden. Als nächsten Schritt einen Buchungslink verwenden.", "Immediate booking is not connected here. Use a booking link as the next step."],
    handover_requires_booking_or_newsletter_flow: ["Lead-Zentrale oder Vertriebspipeline als Übergabe wählen. Buchung und Newsletter benötigen ihren eigenen geprüften Ablauf.", "Choose lead inbox or sales pipeline. Bookings and newsletters require their own reviewed flow."],
  };
  return labels[code]?.[language === "de" ? 0 : 1] ?? (language === "de" ? "Funnel vor Veröffentlichung prüfen." : "Review the funnel before publishing.");
}
