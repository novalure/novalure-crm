export const crmActivityKinds = ["note", "call_attempt", "call_connected"] as const;
export type CrmActivityKind = (typeof crmActivityKinds)[number];
export type CrmActivityScope = { contactId?: string; leadId?: string; projectId?: string };
export type CrmActivityInput = CrmActivityScope & { kind: CrmActivityKind; detail: string; title?: string; occurredAt?: string };
export type CrmActivityItem = { id: string; contactId: string; leadId: string | null; projectId: string | null; kind: CrmActivityKind | "inquiry" | "record"; channel: string; title: string; detail: string; outcome: string; occurredAt: string; actorName: string | null; evidence: "manual" | "record" };
export type CrmActivityPage = { workspaceId: string; contactId: string; leadId: string | null; projectId: string | null; items: CrmActivityItem[]; nextCursor: string | null; canRecord: boolean; source: "database" };
export class CrmActivityValidationError extends Error {}

export function parseCrmActivityInput(value: unknown): CrmActivityInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new CrmActivityValidationError("Eine Aktivität ist erforderlich.");
  const input = value as Record<string, unknown>;
  const allowed = ["contactId", "leadId", "projectId", "kind", "detail", "title", "occurredAt", "idempotencyKey", "correlationId"];
  if (Object.keys(input).some(key => !allowed.includes(key))) throw new CrmActivityValidationError("Die Aktivität enthält unbekannte Felder.");
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  for (const field of ["contactId", "leadId", "projectId"] as const) if (input[field] !== undefined && (typeof input[field] !== "string" || !uuid.test(input[field]))) throw new CrmActivityValidationError("Kontakt-, Lead- oder Projektbezug ist ungültig.");
  if (!input.contactId && !input.leadId) throw new CrmActivityValidationError("Kontakt oder Lead ist erforderlich.");
  if (!crmActivityKinds.includes(input.kind as CrmActivityKind)) throw new CrmActivityValidationError("Die Aktivitätsart ist ungültig.");
  if (typeof input.detail !== "string" || !input.detail.trim() || input.detail.trim().length > 1200) throw new CrmActivityValidationError("Der Inhalt muss zwischen 1 und 1.200 Zeichen enthalten.");
  if (input.title !== undefined && (typeof input.title !== "string" || !input.title.trim() || input.title.trim().length > 180)) throw new CrmActivityValidationError("Der Titel darf höchstens 180 Zeichen enthalten.");
  if ([input.title, input.detail].some(text => typeof text === "string" && /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text))) throw new CrmActivityValidationError("Die Aktivität enthält ungültige Steuerzeichen.");
  if (input.occurredAt !== undefined) {
    const match = typeof input.occurredAt === "string" ? /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-](\d{2}):(\d{2}))$/.exec(input.occurredAt) : null;
    const calendarDay = match ? new Date(`${match[1]}T00:00:00Z`) : null;
    if (!match || !calendarDay || !Number.isFinite(calendarDay.getTime()) || calendarDay.toISOString().slice(0, 10) !== match[1] || Number(match[2]) > 23 || Number(match[3]) > 59 || Number(match[4]) > 59 || Number(match[5] ?? 0) > 23 || Number(match[6] ?? 0) > 59 || !Number.isFinite(Date.parse(input.occurredAt as string))) throw new CrmActivityValidationError("Der Zeitpunkt benötigt eine gültige Uhrzeit mit Zeitzone.");
  }
  return { ...(input.contactId ? { contactId: input.contactId as string } : {}), ...(input.leadId ? { leadId: input.leadId as string } : {}), ...(input.projectId ? { projectId: input.projectId as string } : {}), kind: input.kind as CrmActivityKind, detail: input.detail.trim(), ...(input.title ? { title: (input.title as string).trim() } : {}), ...(input.occurredAt ? { occurredAt: input.occurredAt as string } : {}) };
}

export function crmActivityKindLabel(kind: CrmActivityItem["kind"], language: "de" | "en") {
  const labels = { note: ["Notiz", "Note"], call_attempt: ["Kontaktversuch manuell erfasst", "Contact attempt manually logged"], call_connected: ["Telefonat manuell erfasst", "Phone conversation manually logged"], inquiry: ["Anfrage im CRM", "Enquiry in CRM"], record: ["Gespeicherte Aktivität", "Saved activity"] };
  return labels[kind][language === "de" ? 0 : 1];
}
