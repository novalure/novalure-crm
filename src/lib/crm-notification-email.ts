import { crmNotificationCategories, crmNotificationLabels, type CrmNotificationCategory } from "./crm-notifications";
export type CrmNotificationEmailPreferences = { version: 1; enabled: boolean; frequency: "daily" | "weekly"; hour: number; timeZone: string; language: "de" | "en" | "es"; projectId: string | null };
export type CrmNotificationEmailStatus = "queued" | "dispatching" | "accepted" | "failed" | "uncertain" | "suppressed";
export type CrmNotificationEmailState = { preferences: CrmNotificationEmailPreferences; revision: number; recipient: string | null; identityReady: boolean; nextRunAt: string | null; readiness: { ready: boolean; reason: string }; jobs: { id: string; status: CrmNotificationEmailStatus; count: number; createdAt: string; acceptedAt: string | null; error: string | null; revision: number; retryAllowed: boolean }[] };
export type CrmNotificationEmailCounts = Partial<Record<CrmNotificationCategory, number>>;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function defaultCrmNotificationEmailPreferences(): CrmNotificationEmailPreferences { return { version: 1, enabled: false, frequency: "daily", hour: 8, timeZone: "Europe/Vienna", language: "de", projectId: null }; }
export function parseCrmNotificationEmailPreferences(value: unknown): CrmNotificationEmailPreferences {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Digest-Einstellungen fehlen");
  const v = value as Record<string, unknown>;
  if (Object.keys(v).sort().join() !== "enabled,frequency,hour,language,projectId,timeZone,version" || v.version !== 1 || typeof v.enabled !== "boolean" || !["daily", "weekly"].includes(String(v.frequency)) || !Number.isInteger(v.hour) || Number(v.hour) < 0 || Number(v.hour) > 23 || !["de", "en", "es"].includes(String(v.language)) || typeof v.timeZone !== "string" || v.timeZone.length > 80 || (v.projectId !== null && (typeof v.projectId !== "string" || !uuid.test(v.projectId)))) throw new Error("Digest-Auswahl, Stunde und Projekt prüfen");
  try { new Intl.DateTimeFormat("en", { timeZone: v.timeZone }).format(); } catch { throw new Error("Zeitzone prüfen"); }
  return v as CrmNotificationEmailPreferences;
}
/** The next actual local clock hour. A skipped DST hour skips that day's run. Weekly = Monday. */
export function nextCrmNotificationEmailAt(preferences: CrmNotificationEmailPreferences, after: Date): string {
  const format = new Intl.DateTimeFormat("en-GB", { timeZone: preferences.timeZone, hour: "2-digit", minute: "2-digit", weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hourCycle: "h23" });
  const now = Object.fromEntries(format.formatToParts(after).map(part => [part.type, part.value]));
  const day = (parts: Record<string, string>) => `${parts.year}-${parts.month}-${parts.day}`;
  const start = Math.floor(after.getTime() / 900000) * 900000 + 900000;
  for (let tick = start; tick <= start + 9 * 86400000; tick += 900000) {
    const parts = Object.fromEntries(format.formatToParts(tick).map(part => [part.type, part.value]));
    if (Number(parts.hour) === preferences.hour && parts.minute === "00" && (day(parts) !== day(now) || Number(now.hour) < preferences.hour) && (preferences.frequency === "daily" || parts.weekday === "Mon")) return new Date(tick).toISOString();
  }
  throw new Error("Nächster Digest-Termin nicht auflösbar");
}
function escapeHtml(value: string) { return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;"); }
/** Count-only content: customer names, free text, attachments and tracking links never leave the CRM. */
export function renderCrmNotificationEmail(counts: CrmNotificationEmailCounts, language: "de" | "en" | "es", appUrl: string) {
  const url = new URL(appUrl); if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error("Vertrauenswürdige HTTPS-CRM-Adresse erforderlich");
  const total = Object.values(counts).reduce((sum, count) => sum + (count ?? 0), 0);
  if (!total || total > 100 || Object.keys(counts).some(key => !(crmNotificationCategories as readonly string[]).includes(key)) || Object.values(counts).some(count => !Number.isSafeInteger(count) || Number(count) < 1 || Number(count) > 100)) throw new Error("Leere oder ungültige Digest-Anzahl");
  const de = language === "de", es = language === "es", labels = crmNotificationLabels[de ? "de" : "en"];
  const spanish: Record<CrmNotificationCategory, string> = { new_lead: "Nuevas consultas", task_due: "Tareas pendientes", reservation_deadline: "Plazos de reserva", expose_opened: "Aperturas del dosier", automation_issue: "Automatizaciones por revisar", publication_issue: "Errores de exportación" };
  const subject = de ? `Novalure: ${total} neue Hinweise` : es ? `Novalure: ${total} avisos nuevos` : `Novalure: ${total} new notifications`;
  const rows = crmNotificationCategories.filter(category => counts[category]).map(category => `<li>${escapeHtml(es ? spanish[category] : labels[category])}: ${counts[category]}</li>`).join("");
  const intro = de ? "Seit Ihrer letzten E-Mail-Zusammenfassung gibt es neue ungelesene Hinweise. Details sehen Sie nach der Anmeldung im CRM." : es ? "Hay avisos nuevos sin leer desde su último resumen. Consulte los detalles tras iniciar sesión en el CRM." : "There are new unread notifications since your last email summary. Sign in to the CRM to see the details.";
  const footer = de ? "Sie haben diese persönliche Zusammenfassung in Ihren Hinweis-Einstellungen aktiviert. Sie können sie dort jederzeit ausschalten. Der Stand kann sich inzwischen geändert haben." : es ? "Ha activado este resumen personal en sus preferencias de avisos. Puede desactivarlo allí. La información puede haber cambiado." : "You enabled this personal summary in notification preferences. You can turn it off there at any time. The current state may have changed.";
  return { subject, html: `<!doctype html><html lang="${language}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(subject)}</title></head><body style="font:16px/1.6 Arial,sans-serif;color:#1c1917;background:#fafaf9;padding:24px"><main style="max-width:600px;margin:auto;background:white;padding:24px"><h1 style="font-size:24px">${escapeHtml(subject)}</h1><p>${intro}</p><ul>${rows}</ul><p><a href="${escapeHtml(url.href)}" style="display:inline-block;padding:12px 18px;background:#1c1917;color:white">${de ? "CRM öffnen" : es ? "Abrir CRM" : "Open CRM"}</a></p><p style="font-size:13px;color:#57534e">${footer}</p></main></body></html>` };
}
