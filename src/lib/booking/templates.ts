import type { BookingKind } from "./types";

export type BookingEmailLanguage = "de" | "en";
export type EmailTemplateKind = "confirmation" | "reminder" | "reschedule" | "cancellation";
export type BookingEmailTemplate = {
  subject: string; body: string; onlineBody: string; phoneBody: string; onsiteBody: string;
  logoUrl: string; signature: string;
};
export type BookingReminderRule = { id: string; minutesBefore: number; template: EmailTemplateKind; enabled: boolean };
export type BookingCommunicationSettings = {
  enabled: boolean; companyName: string; replyTo: string; preparationNote: string;
  templates: Record<BookingEmailLanguage, Record<EmailTemplateKind, BookingEmailTemplate>>;
  reminders: BookingReminderRule[];
};
export const bookingEmailPlaceholders = ["customerName", "firstName", "companyName", "employeeName", "bookingType", "date", "time", "timeZone", "duration", "location", "videoUrl", "preparationNote", "rescheduleUrl", "cancelUrl"] as const;
export type BookingEmailPlaceholder = typeof bookingEmailPlaceholders[number];
export type BookingEmailValues = Partial<Record<BookingEmailPlaceholder, string>>;
const kinds: EmailTemplateKind[] = ["confirmation", "reminder", "reschedule", "cancellation"];
const allowed = new Set<string>(bookingEmailPlaceholders);
const tokenPattern = /\{\{\s*([A-Za-z][A-Za-z0-9]*)\s*\}\}/g;

export class BookingTemplateError extends Error {
  constructor(public code: string) { super(code); this.name = "BookingTemplateError"; }
}
function baseTemplate(language: BookingEmailLanguage, kind: EmailTemplateKind): BookingEmailTemplate {
  const de = language === "de";
  const headings = de
    ? { confirmation: "Ihr Termin ist bestätigt", reminder: "Erinnerung an Ihren Termin", reschedule: "Ihr Termin wurde geändert", cancellation: "Ihr Termin wurde abgesagt" }
    : { confirmation: "Your appointment is confirmed", reminder: "Your appointment reminder", reschedule: "Your appointment has changed", cancellation: "Your appointment is cancelled" };
  return {
    subject: `${headings[kind]}: {{bookingType}}`,
    body: de
      ? `Hallo {{firstName}},\n\n${headings[kind]}.\n{{date}}, {{time}} ({{timeZone}})\nDauer: {{duration}} Minuten\nMitarbeiter: {{employeeName}}\n\n{{preparationNote}}${kind === "cancellation" ? "" : "\n\nUmbuchen: {{rescheduleUrl}}\nAbsagen: {{cancelUrl}}"}`
      : `Hello {{firstName}},\n\n${headings[kind]}.\n{{date}}, {{time}} ({{timeZone}})\nDuration: {{duration}} minutes\nEmployee: {{employeeName}}\n\n{{preparationNote}}${kind === "cancellation" ? "" : "\n\nReschedule: {{rescheduleUrl}}\nCancel: {{cancelUrl}}"}`,
    onlineBody: kind === "cancellation" ? "" : de ? "Online teilnehmen: {{videoUrl}}" : "Join online: {{videoUrl}}",
    phoneBody: kind === "cancellation" ? "" : de ? "Der Termin findet telefonisch statt." : "This appointment takes place by phone.",
    onsiteBody: kind === "cancellation" ? "" : de ? "Treffpunkt: {{location}}" : "Meeting location: {{location}}",
    logoUrl: "", signature: de ? "Freundliche Grüße\n{{companyName}}" : "Kind regards\n{{companyName}}",
  };
}
export const defaultBookingCommunication: BookingCommunicationSettings = {
  enabled: false, companyName: "", replyTo: "", preparationNote: "",
  templates: {
    de: Object.fromEntries(kinds.map(kind => [kind, baseTemplate("de", kind)])) as Record<EmailTemplateKind, BookingEmailTemplate>,
    en: Object.fromEntries(kinds.map(kind => [kind, baseTemplate("en", kind)])) as Record<EmailTemplateKind, BookingEmailTemplate>,
  },
  reminders: [
    { id: "one-day", minutesBefore: 1440, template: "reminder", enabled: true },
    { id: "two-hours", minutesBefore: 120, template: "reminder", enabled: true },
  ],
};
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new BookingTemplateError("INVALID_COMMUNICATION_SETTINGS");
  return value as Record<string, unknown>;
}
function text(value: unknown, max: number, required = false): string {
  if (typeof value !== "string" || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value) || required && !value.trim()) throw new BookingTemplateError("INVALID_TEMPLATE_TEXT");
  return value.trim();
}
export function validateBookingEmailTemplate(value: unknown): BookingEmailTemplate {
  const row = object(value);
  if (Object.keys(row).some(key => !["subject", "body", "onlineBody", "phoneBody", "onsiteBody", "logoUrl", "signature"].includes(key))) throw new BookingTemplateError("INVALID_TEMPLATE_FIELD");
  const result: BookingEmailTemplate = {
    subject: text(row.subject, 200, true), body: text(row.body, 10000, true),
    onlineBody: text(row.onlineBody, 3000), phoneBody: text(row.phoneBody, 3000), onsiteBody: text(row.onsiteBody, 3000),
    logoUrl: text(row.logoUrl, 2000), signature: text(row.signature, 3000),
  };
  if (/\r|\n/.test(result.subject)) throw new BookingTemplateError("INVALID_TEMPLATE_SUBJECT");
  for (const field of [result.subject, result.body, result.onlineBody, result.phoneBody, result.onsiteBody, result.signature]) {
    if (/<\s*\/?\s*[a-z!]|javascript\s*:|data\s*:/i.test(field)) throw new BookingTemplateError("TEMPLATE_MARKUP_NOT_ALLOWED");
    const rest = field.replace(tokenPattern, (_token, name: string) => {
      if (!allowed.has(name)) throw new BookingTemplateError("TEMPLATE_PLACEHOLDER_NOT_ALLOWED");
      return "";
    });
    if (/[{}]/.test(rest)) throw new BookingTemplateError("TEMPLATE_PLACEHOLDER_NOT_ALLOWED");
  }
  if (result.logoUrl) {
    if (/[{}]/.test(result.logoUrl)) throw new BookingTemplateError("INVALID_LOGO_URL");
    let url: URL;
    try { url = new URL(result.logoUrl); } catch { throw new BookingTemplateError("INVALID_LOGO_URL"); }
    if (url.protocol !== "https:" || url.username || url.password) throw new BookingTemplateError("INVALID_LOGO_URL");
  }
  return result;
}
export function validateBookingCommunication(value: unknown): BookingCommunicationSettings {
  const row = object(value), templateRows = object(row.templates);
  if (Object.keys(row).some(key => !["enabled", "companyName", "replyTo", "preparationNote", "templates", "reminders"].includes(key)) || Object.keys(templateRows).some(key => !["de", "en"].includes(key))) throw new BookingTemplateError("INVALID_COMMUNICATION_FIELD");
  if (typeof row.enabled !== "boolean") throw new BookingTemplateError("INVALID_COMMUNICATION_SETTINGS");
  const companyName = text(row.companyName, 200), replyTo = text(row.replyTo, 254), preparationNote = text(row.preparationNote, 3000);
  if (replyTo && !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(replyTo)) throw new BookingTemplateError("INVALID_REPLY_TO");
  const templates = {} as BookingCommunicationSettings["templates"];
  for (const language of ["de", "en"] as const) {
    const langRows = object(templateRows[language]);
    if (Object.keys(langRows).some(key => !kinds.includes(key as EmailTemplateKind))) throw new BookingTemplateError("INVALID_TEMPLATE_KIND");
    templates[language] = Object.fromEntries(kinds.map(kind => [kind, validateBookingEmailTemplate(langRows[kind])])) as Record<EmailTemplateKind, BookingEmailTemplate>;
  }
  if (!Array.isArray(row.reminders) || row.reminders.length > 10) throw new BookingTemplateError("INVALID_REMINDERS");
  const ids = new Set<string>();
  const reminders = row.reminders.map(value => {
    const r = object(value), id = text(r.id, 80, true);
    if (Object.keys(r).some(key => !["id", "minutesBefore", "template", "enabled"].includes(key))) throw new BookingTemplateError("INVALID_REMINDERS");
    if (!/^[a-zA-Z0-9_-]+$/.test(id) || ids.has(id) || !Number.isInteger(r.minutesBefore) || Number(r.minutesBefore) < 1 || Number(r.minutesBefore) > 60 * 24 * 30 || !kinds.includes(r.template as EmailTemplateKind) || typeof r.enabled !== "boolean") throw new BookingTemplateError("INVALID_REMINDERS");
    ids.add(id);
    return { id, minutesBefore: Number(r.minutesBefore), template: r.template as EmailTemplateKind, enabled: r.enabled };
  });
  return { enabled: row.enabled, companyName, replyTo, preparationNote, templates, reminders };
}
export function escapeBookingEmailHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}
export function renderBookingEmail(input: {
  template: BookingEmailTemplate; language: BookingEmailLanguage; bookingKind: BookingKind; values: BookingEmailValues;
}): { subject: string; text: string; html: string } {
  const template = validateBookingEmailTemplate(input.template);
  const fill = (source: string) => source.replace(tokenPattern, (_token, key: BookingEmailPlaceholder) => {
    const value = input.values[key];
    if (typeof value !== "string" || value.length > 4000 || !value.trim() && !["preparationNote", "companyName"].includes(key)) throw new BookingTemplateError(`TEMPLATE_VALUE_MISSING:${key}`);
    return value;
  });
  const subject = fill(template.subject);
  if (/\r|\n/.test(subject)) throw new BookingTemplateError("INVALID_TEMPLATE_SUBJECT");
  const block = ["teams", "meet"].includes(input.bookingKind) ? template.onlineBody : input.bookingKind === "phone" ? template.phoneBody : template.onsiteBody;
  const body = [fill(template.body), fill(block), fill(template.signature)].filter(Boolean).join("\n\n");
  if (/\{\{|\}\}/.test(body + subject)) throw new BookingTemplateError("UNRESOLVED_TEMPLATE_PLACEHOLDER");
  const paragraphs = body.split(/\n{2,}/).map(p => `<p>${escapeBookingEmailHtml(p).replaceAll("\n", "<br />")}</p>`).join("");
  const logo = template.logoUrl ? `<img src="${escapeBookingEmailHtml(template.logoUrl)}" alt="${escapeBookingEmailHtml(input.values.companyName || (input.language === "de" ? "Firmenlogo" : "Company logo"))}" width="160" style="max-width:160px;height:auto" />` : "";
  const html = `<!doctype html><html lang="${input.language}"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width" /><title>${escapeBookingEmailHtml(subject)}</title></head><body style="font-family:Arial,sans-serif;color:#172033;background:#f5f7fb;margin:0;padding:24px"><main style="max-width:620px;margin:auto;background:white;padding:28px">${logo}<h1 style="font-size:22px">${escapeBookingEmailHtml(subject)}</h1>${paragraphs}</main></body></html>`;
  return { subject, text: body, html };
}
