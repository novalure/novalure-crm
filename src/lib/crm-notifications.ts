export const crmNotificationCategories = ["new_lead", "task_due", "reservation_deadline", "expose_opened", "automation_issue", "publication_issue"] as const;
export type CrmNotificationCategory = typeof crmNotificationCategories[number];
export type CrmNotificationPreferences = { version: 1; timeZone: string; categories: Record<CrmNotificationCategory, boolean> };
export type CrmNotification = { key: string; category: CrmNotificationCategory; title: string; detail: string; occurredAt: string; projectId: string | null; sourceId: string; sourceType: "lead" | "task" | "reservation" | "automation" | "property"; read: boolean };
export type CrmNotificationsState = { preferences: CrmNotificationPreferences; revision: number; features: Record<CrmNotificationCategory, boolean>; items: CrmNotification[]; unread: number; limit: number; digests: { id: string; createdAt: string; count: number; status: "prepared" }[]; delivery: { inApp: true; email: "not_connected" | "separate_opt_in" } };
export function defaultCrmNotificationPreferences(): CrmNotificationPreferences { return { version: 1, timeZone: "UTC", categories: { new_lead: true, task_due: true, reservation_deadline: true, expose_opened: false, automation_issue: true, publication_issue: true } }; }
export function parseCrmNotificationPreferences(value: unknown): CrmNotificationPreferences {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("INVALID_NOTIFICATION_PREFERENCES");
  const p = value as Record<string, unknown>, categories = p.categories as Record<string, unknown>;
  if (p.version !== 1 || Object.keys(p).some((key) => !["version", "timeZone", "categories"].includes(key)) || typeof p.timeZone !== "string" || p.timeZone.length > 80 || !categories || typeof categories !== "object" || Array.isArray(categories) || Object.keys(categories).length !== crmNotificationCategories.length || crmNotificationCategories.some((category) => typeof categories[category] !== "boolean")) throw new Error("INVALID_NOTIFICATION_PREFERENCES");
  try { new Intl.DateTimeFormat("en", { timeZone: p.timeZone }).format(); } catch { throw new Error("INVALID_NOTIFICATION_TIMEZONE"); }
  return { version: 1, timeZone: p.timeZone, categories: Object.fromEntries(crmNotificationCategories.map((category) => [category, categories[category]])) as CrmNotificationPreferences["categories"] };
}
export const crmNotificationLabels = {
  de: { new_lead: "Neue Anfragen", task_due: "Fällige Aufgaben", reservation_deadline: "Reservierungsfristen", expose_opened: "Exposé-Aufrufe", automation_issue: "Automationen mit Prüfbedarf", publication_issue: "Exportfehler" },
  en: { new_lead: "New enquiries", task_due: "Due tasks", reservation_deadline: "Reservation deadlines", expose_opened: "Exposé opens", automation_issue: "Automations needing review", publication_issue: "Export errors" },
} as const;
