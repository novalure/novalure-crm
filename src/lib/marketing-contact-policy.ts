export type MarketingContactRules = { enabled: boolean; timezone: string; days: number[]; startMinute: number; endMinute: number; excludedDates: string[]; minHours: number };
export type MarketingContactPolicy = { revision: number; rules: MarketingContactRules; updatedAt: string | null };
export const defaultMarketingContactRules: MarketingContactRules = { enabled: false, timezone: "Europe/Vienna", days: [1, 2, 3, 4, 5], startMinute: 480, endMinute: 1140, excludedDates: [], minHours: 24 };
export function normalizeMarketingContactRules(value: unknown): MarketingContactRules {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Versandregeln fehlen.");
  const x = value as Record<string, unknown>;
  if (Object.keys(x).some(key => !["enabled", "timezone", "days", "startMinute", "endMinute", "excludedDates", "minHours"].includes(key))) throw new Error("Versandregeln enthalten unbekannte Felder.");
  if (typeof x.enabled !== "boolean" || typeof x.timezone !== "string" || x.timezone.length > 80) throw new Error("Aktivierung oder Zeitzone ist ungültig.");
  try { new Intl.DateTimeFormat("en", { timeZone: x.timezone }).format(); } catch { throw new Error("Zeitzone ist ungültig."); }
  if (!Array.isArray(x.days) || !x.days.length || x.days.length > 7 || x.days.some(day => !Number.isInteger(day) || day < 0 || day > 6) || new Set(x.days).size !== x.days.length) throw new Error("Mindestens einen eindeutigen Wochentag auswählen.");
  if (typeof x.startMinute !== "number" || typeof x.endMinute !== "number" || !Number.isInteger(x.startMinute) || !Number.isInteger(x.endMinute) || x.startMinute < 0 || x.endMinute > 1440 || x.startMinute >= x.endMinute || x.startMinute % 15 || x.endMinute % 15) throw new Error("Versandzeitfenster muss im Viertelstundenraster innerhalb eines Tages liegen.");
  if (typeof x.minHours !== "number" || !Number.isInteger(x.minHours) || x.minHours < 0 || x.minHours > 720) throw new Error("Mindestabstand muss zwischen 0 und 720 Stunden liegen.");
  if (!Array.isArray(x.excludedDates) || x.excludedDates.length > 128 || x.excludedDates.some(date => typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date)) throw new Error("Ausnahmetage müssen gültige Datumswerte sein; höchstens 128 Tage.");
  return { enabled: x.enabled, timezone: x.timezone, days: [...x.days].sort(), startMinute: x.startMinute, endMinute: x.endMinute, minHours: x.minHours, excludedDates: [...new Set(x.excludedDates)].sort() };
}
/** Explicit local dates, including manually supplied holidays. No inferred national holiday calendar. */
export function nextMarketingContactTime(value: Date, rules: MarketingContactRules): Date {
  if (!Number.isFinite(value.getTime())) throw new Error("Versandzeitpunkt ist ungültig.");
  if (!rules.enabled) return new Date(value);
  const format = new Intl.DateTimeFormat("en-GB", { timeZone: rules.timezone, weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const weekdays: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const excluded = new Set(rules.excludedDates);
  let candidate = new Date(value);
  for (let attempt = 0; attempt < 366 * 96; attempt++) {
    const parts = Object.fromEntries(format.formatToParts(candidate).map(part => [part.type, part.value]));
    const minute = Number(parts.hour) * 60 + Number(parts.minute);
    if (rules.days.includes(weekdays[parts.weekday]) && minute >= rules.startMinute && minute < rules.endMinute && !excluded.has(`${parts.year}-${parts.month}-${parts.day}`)) return candidate;
    candidate = new Date(Math.floor(candidate.getTime() / 900000) * 900000 + 900000);
  }
  throw new Error("Innerhalb eines Jahres ist kein zulässiges Versandzeitfenster erreichbar.");
}
