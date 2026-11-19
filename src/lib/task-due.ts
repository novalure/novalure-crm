import type { Task } from "@/lib/crm-types";

export type TaskDueState = { group: "overdue" | "today" | "upcoming" | "undated"; dueAt: Date | null; dateKey: string | null; dateOnly: boolean; dueToday: boolean; overdue: boolean };
const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string) {
  let current = formatters.get(timeZone);
  if (!current) {
    current = new Intl.DateTimeFormat("en-GB", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
    if (formatters.size > 30) formatters.clear();
    formatters.set(timeZone, current);
  }
  return current;
}
function localParts(date: Date, timeZone: string) {
  const parts = Object.fromEntries(formatter(timeZone).formatToParts(date).map(part => [part.type, part.value]));
  return { dateKey: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}:${parts.second}` };
}
function validDateKey(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
function shiftedDateKey(dateKey: string, days: number) {
  const date = new Date(`${dateKey}T00:00:00Z`); date.setUTCDate(date.getUTCDate() + days); return date.toISOString().slice(0, 10);
}

/** Explicit local-time conversion; DST gaps fail instead of silently moving an appointment. */
export function taskLocalDateTimeToInstant(value: string, timeZone: string): Date | null {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  if (!match || !validDateKey(match[1]) || Number(match[2]) > 23 || Number(match[3]) > 59 || Number(match[4] ?? 0) > 59) return null;
  const expectedTime = `${match[2]}:${match[3]}:${match[4] ?? "00"}`;
  const nominal = Date.parse(`${match[1]}T${expectedTime}Z`);
  try {
    const offsets = new Set([-86400000, 0, 86400000].map(delta => {
      const point = nominal + delta, parts = localParts(new Date(point), timeZone);
      return Date.parse(`${parts.dateKey}T${parts.time}Z`) - point;
    }));
    const matches = [...offsets].map(offset => new Date(nominal - offset)).filter(date => {
      const parts = localParts(date, timeZone); return parts.dateKey === match[1] && parts.time === expectedTime;
    }).sort((a, b) => a.getTime() - b.getTime());
    // Repeated wall-clock times use the first occurrence consistently.
    return matches[0] ?? null;
  } catch { return null; }
}

/** A date-only task is due at the end of that date in the chosen timezone. */
export function taskDueState(value: string, now: Date = new Date(), timeZone = "Europe/Vienna"): TaskDueState {
  const unknown: TaskDueState = { group: "undated", dueAt: null, dateKey: null, dateOnly: false, dueToday: false, overdue: false };
  if (!Number.isFinite(now.getTime())) return unknown;
  let today: string;
  try { today = localParts(now, timeZone).dateKey; } catch { return unknown; }
  let raw = value.trim();
  const relative = /^(heute|today|morgen|tomorrow)(?:[, ]+(\d{1,2}):(\d{2}))?$/i.exec(raw);
  if (relative) {
    const date = shiftedDateKey(today, /morgen|tomorrow/i.test(relative[1]) ? 1 : 0);
    raw = relative[2] ? `${date}T${relative[2].padStart(2, "0")}:${relative[3]}` : date;
  }
  const dateOnly = validDateKey(raw);
  let dueAt: Date | null = null;
  if (dateOnly) {
    const nextMidnight = taskLocalDateTimeToInstant(`${shiftedDateKey(raw, 1)}T00:00`, timeZone);
    if (nextMidnight) dueAt = new Date(nextMidnight.getTime() - 1);
  } else if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(raw)) dueAt = taskLocalDateTimeToInstant(raw, timeZone);
  else {
    const absolute = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(?:Z|[+-](\d{2}):(\d{2}))$/i.exec(raw);
    if (absolute && validDateKey(absolute[1]) && Number(absolute[2]) <= 23 && Number(absolute[3]) <= 59 && Number(absolute[4] ?? 0) <= 59 && Number(absolute[5] ?? 0) <= 23 && Number(absolute[6] ?? 0) <= 59) {
      const date = new Date(raw); if (Number.isFinite(date.getTime())) dueAt = date;
    }
  }
  if (!dueAt) return unknown;
  const dateKey = dateOnly ? raw : localParts(dueAt, timeZone).dateKey;
  const dueToday = dateKey === today, overdue = dueAt.getTime() < now.getTime();
  return { dueAt, dateKey, dateOnly, dueToday, overdue, group: overdue ? "overdue" : dueToday ? "today" : "upcoming" };
}

export function formatTaskDue(value: string, language: "de" | "en", timeZone = "Europe/Vienna", now = new Date()) {
  if (!value.trim()) return language === "de" ? "Ohne Fälligkeit" : "No due date";
  const state = taskDueState(value, now, timeZone);
  if (!state.dueAt) return language === "de" ? "Ohne gültige Fälligkeit" : "No valid due date";
  return new Intl.DateTimeFormat(language === "de" ? "de-DE" : "en-IE", { dateStyle: "medium", ...(state.dateOnly ? {} : { timeStyle: "short" as const }), timeZone }).format(state.dueAt);
}

export function taskInstantToLocalInput(instant: Date, timeZone = "Europe/Vienna") {
  if (!Number.isFinite(instant.getTime())) return "";
  try { const parts = localParts(instant, timeZone); return `${parts.dateKey}T${parts.time.slice(0, 5)}`; } catch { return ""; }
}

export function defaultTaskDueInput(now = new Date(), timeZone = "Europe/Vienna") {
  try { return `${shiftedDateKey(localParts(now, timeZone).dateKey, 1)}T09:00`; } catch { return ""; }
}

export function compareTaskDue(a: Pick<Task, "id" | "due" | "priority">, b: Pick<Task, "id" | "due" | "priority">, now = new Date(), timeZone = "Europe/Vienna") {
  const left = taskDueState(a.due, now, timeZone).dueAt?.getTime() ?? Number.POSITIVE_INFINITY;
  const right = taskDueState(b.due, now, timeZone).dueAt?.getTime() ?? Number.POSITIVE_INFINITY;
  if (left !== right) return left < right ? -1 : 1;
  const rank = { Hoch: 0, Mittel: 1, Normal: 2 };
  return rank[a.priority] - rank[b.priority] || a.id.localeCompare(b.id);
}

export function nextOpenTaskForLead(tasks: readonly Task[], lead: { id: string; workspaceId: string; projectId: string }, now = new Date(), timeZone = "Europe/Vienna") {
  return tasks.filter(task => task.status === "open" && task.leadId === lead.id && task.workspaceId === lead.workspaceId && task.projectId === lead.projectId)
    .sort((a, b) => compareTaskDue(a, b, now, timeZone))[0] ?? null;
}

/** A newer server revision always supersedes an older optimistic display copy. */
export function mergeConfirmedTasks(server:readonly Task[],confirmed:readonly Task[]):Task[]{
  const key=(task:Task)=>`${task.workspaceId}:${task.id}`,records=new Map(server.map(task=>[key(task),task]));
  for(const task of confirmed){const current=records.get(key(task));if(!current||Number(task.version??0)>Number(current.version??0))records.set(key(task),task);}
  return [...records.values()];
}
