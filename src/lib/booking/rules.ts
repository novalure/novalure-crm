import { BookingError, type BookingRules, type BusyInterval } from "./types";
export const defaultBookingRules: BookingRules = {
  durationMinutes: 30, preparationMinutes: 0, followupMinutes: 0, timeZone: "Europe/Vienna",
  minNoticeMinutes: 120, maxAdvanceDays: 60, gridMinutes: 15, maxPerDay: null,
  cancelNoticeMinutes: 120, rescheduleNoticeMinutes: 120, location: "",
  workingHours: [1,2,3,4,5].map(day => ({ day, start: "09:00", end: "17:00" })), breaks: [], absences: [],
  travel: { policy: "deferred", required: false },
};
const ruleFields = new Set(Object.keys(defaultBookingRules));
const finiteInteger = (v: unknown, min: number, max: number) => typeof v === "number" && Number.isSafeInteger(v) && v >= min && v <= max;
const minute = (v: string) => Number(v.slice(0,2)) * 60 + Number(v.slice(3));
export function validateBookingRules(value: Partial<BookingRules>): Partial<BookingRules> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(k => !ruleFields.has(k))) throw new BookingError("INVALID_RULES");
  for (const key of ["durationMinutes","preparationMinutes","followupMinutes","minNoticeMinutes","gridMinutes","cancelNoticeMinutes","rescheduleNoticeMinutes"] as const) {
    if (value[key] !== undefined && !finiteInteger(value[key], key === "durationMinutes" || key === "gridMinutes" ? 1 : 0, key.includes("Notice") ? 43_200 : 1_440)) throw new BookingError("INVALID_RULES");
  }
  if (value.maxAdvanceDays !== undefined && !finiteInteger(value.maxAdvanceDays,1,366)) throw new BookingError("INVALID_RULES");
  if (value.maxPerDay !== undefined && value.maxPerDay !== null && !finiteInteger(value.maxPerDay,1,100)) throw new BookingError("INVALID_RULES");
  if (value.timeZone !== undefined) { if (typeof value.timeZone !== "string" || value.timeZone.length > 100) throw new BookingError("INVALID_TIME_ZONE"); try { new Intl.DateTimeFormat("en",{timeZone:value.timeZone}).format(); } catch { throw new BookingError("INVALID_TIME_ZONE"); } }
  if (value.location !== undefined && (typeof value.location !== "string" || value.location.length > 500)) throw new BookingError("INVALID_RULES");
  for (const field of ["workingHours","breaks"] as const) if (value[field] !== undefined) {
    const slots = value[field];
    if (!Array.isArray(slots) || slots.length > 35 || slots.some(x => !x || !finiteInteger(x.day,0,6) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(x.start) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(x.end) || minute(x.end) <= minute(x.start))) throw new BookingError("INVALID_RULES");
  }
  if (value.absences !== undefined && (!Array.isArray(value.absences) || value.absences.length > 200 || value.absences.some(x => !validInstant(x?.startsAt) || !validInstant(x?.endsAt) || Date.parse(x.endsAt) <= Date.parse(x.startsAt)))) throw new BookingError("INVALID_RULES");
  if (value.travel !== undefined && (value.travel?.policy !== "deferred" || typeof value.travel.required !== "boolean")) throw new BookingError("INVALID_RULES");
  return value;
}
export function validInstant(value: unknown): value is string { return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value)); }
export function localParts(instant: number, timeZone: string) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA",{timeZone,year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).formatToParts(instant).map(x => [x.type,x.value]));
  const date = `${p.year}-${p.month}-${p.day}`;
  return { date, minute: Number(p.hour)*60+Number(p.minute), day: new Date(`${date}T12:00:00Z`).getUTCDay() };
}
export function overlaps(a: BusyInterval,b: BusyInterval) { return Date.parse(a.startsAt) < Date.parse(b.endsAt) && Date.parse(b.startsAt) < Date.parse(a.endsAt); }
export function bookingWindow(startsAt: string,rules: BookingRules) {
  if (!validInstant(startsAt)) throw new BookingError("INVALID_START");
  const t = Date.parse(startsAt);
  return { startsAt: new Date(t).toISOString(), endsAt: new Date(t+rules.durationMinutes*60_000).toISOString(), blockedStartsAt: new Date(t-rules.preparationMinutes*60_000).toISOString(), blockedEndsAt: new Date(t+(rules.durationMinutes+rules.followupMinutes)*60_000).toISOString() };
}
export function isSlotAllowed(startsAt: string,rules: BookingRules,busy: BusyInterval[],now = Date.now()) {
  const w = bookingWindow(startsAt,rules), t=Date.parse(startsAt);
  if (t < now+rules.minNoticeMinutes*60_000 || t > now+rules.maxAdvanceDays*86_400_000 || t%60_000 !== 0) return false;
  const start=localParts(t,rules.timeZone), from=localParts(Date.parse(w.blockedStartsAt),rules.timeZone), to=localParts(Date.parse(w.blockedEndsAt),rules.timeZone);
  if (start.minute%rules.gridMinutes !== 0 || from.date!==to.date || !rules.workingHours.some(h => h.day===from.day && from.minute>=minute(h.start) && to.minute<=minute(h.end))) return false;
  if (rules.breaks.some(h => h.day===from.day && from.minute<minute(h.end) && to.minute>minute(h.start))) return false;
  const interval={startsAt:w.blockedStartsAt,endsAt:w.blockedEndsAt};
  return ![...busy,...rules.absences].some(x=>overlaps(interval,x));
}
export function enumerateSlots(date: string,rules: BookingRules,busy: BusyInterval[],now=Date.now()) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || new Date(`${date}T12:00:00Z`).toISOString().slice(0,10)!==date) throw new BookingError("INVALID_DATE");
  const middle=Date.parse(`${date}T00:00:00Z`), result:Array<{startsAt:string;endsAt:string}>=[];
  // Enumerate actual instants: gaps never exist; both autumn offsets remain distinct.
  for(let t=middle-14*3_600_000;t<middle+38*3_600_000;t+=60_000) {
    const startsAt=new Date(t).toISOString();
    if(localParts(t,rules.timeZone).date===date && isSlotAllowed(startsAt,rules,busy,now)) result.push({startsAt,endsAt:bookingWindow(startsAt,rules).endsAt});
  }
  return result;
}
