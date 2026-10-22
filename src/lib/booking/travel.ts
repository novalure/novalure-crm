import type { BookingKind, BookingRecord, BookingRules, BusyInterval } from "./types";
import type { BookingTravelSettings } from "./setup-types";
import { bookingWindow, localParts, overlaps } from "./rules";

export class TravelCheckError extends Error {
  constructor(public code: string) { super(code); this.name = "TravelCheckError"; }
}
export type DrivingRouter = (input: { origin: string; destination: string; departureTime: string }) => Promise<{ minutes: number }>;
export type TravelAppointment = BusyInterval & { blockedStartsAt: string; blockedEndsAt: string; location: string | null; bookingId?: string };
export type TravelProof = { inboundMinutes: number; outboundMinutes: number; bufferMinutes: number; attribution: "Google Maps" };
type CalendarGeometry = { span: { startsAt: number; endsAt: number }; blocked: BusyInterval[] };
const minute = (v: string) => Number(v.slice(0, 2)) * 60 + Number(v.slice(3));
const normalizedAddress = (v: string) => v.trim().replace(/\s+/g, " ").toLocaleLowerCase("en");
const iso = (ms: number) => new Date(ms).toISOString();
export function selectedTravelLocation(settings: BookingTravelSettings, id: string | null) {
  const location = settings.locations.find(entry => entry.id === id && entry.confirmed);
  return location?.address.trim() || null;
}
export function bookingTravelLocation(kind: BookingKind, rules: BookingRules, settings: BookingTravelSettings): string | null {
  if (kind === "onsite") return rules.locationConfirmed || settings.locations.some(entry => entry.confirmed && normalizedAddress(entry.address) === normalizedAddress(rules.location)) ? rules.location.trim() || null : null;
  if (kind === "office") return selectedTravelLocation(settings, settings.startLocationId);
  return selectedTravelLocation(settings, settings.onlineLocationId);
}
export function travelAppointments(bookings: BookingRecord[], external: BusyInterval[], settings: BookingTravelSettings): TravelAppointment[] {
  const own = bookings.map(row => {
    const providerEvent = external.find(event => row.providerEventId && event.eventId === row.providerEventId && (!event.calendarId || event.calendarId === row.calendarId));
    let location = bookingTravelLocation(row.kind, row.rules, row.rules.travel.policy === "google_maps" ? row.rules.travel : settings);
    // A changed/removed onsite address in the real calendar invalidates the stored place.
    // Online participation still follows the employee's explicit physical-location rule.
    if (row.kind === "onsite" && providerEvent && (!providerEvent.location || !location || normalizedAddress(providerEvent.location) !== normalizedAddress(location))) location = null;
    const unsettled = ["processing", "uncertain", "conflict"].includes(row.state);
    if (unsettled) location = null;
    const startsAt = providerEvent && !unsettled ? providerEvent.startsAt : row.startsAt;
    const endsAt = providerEvent && !unsettled ? providerEvent.endsAt : row.endsAt;
    const blockedStartsAt = providerEvent && !unsettled ? iso(Date.parse(startsAt) - row.rules.preparationMinutes * 60_000) : row.blockedStartsAt;
    const blockedEndsAt = providerEvent && !unsettled ? iso(Date.parse(endsAt) + row.rules.followupMinutes * 60_000) : row.blockedEndsAt;
    return { startsAt, endsAt, blockedStartsAt, blockedEndsAt,
      bookingId: row.id, eventId: row.providerEventId ?? undefined, calendarId: row.calendarId, location };
  });
  const others = external.filter(event => !own.some(row => row.eventId && row.eventId === event.eventId && (!event.calendarId || event.calendarId === row.calendarId)))
    .map(event => ({ ...event, blockedStartsAt: event.startsAt, blockedEndsAt: event.endsAt, location: event.location?.trim() || null }));
  return [...own, ...others].sort((a, b) => Date.parse(a.blockedStartsAt) - Date.parse(b.blockedStartsAt));
}
/** Resolve wall-clock boundaries by actual instants, including DST gaps/overlaps. */
function workingSpan(startsAt: string, rules: BookingRules) {
  const w = bookingWindow(startsAt, rules), from = localParts(Date.parse(w.blockedStartsAt), rules.timeZone), to = localParts(Date.parse(w.blockedEndsAt), rules.timeZone);
  const hours = rules.workingHours.find(value => value.day === from.day && minute(value.start) <= from.minute && minute(value.end) >= to.minute);
  if (!hours || from.date !== to.date) throw new TravelCheckError("TRAVEL_OUTSIDE_HOURS");
  const middle = Date.parse(`${from.date}T00:00:00Z`), actual: Array<{ instant: number; value: number }> = [];
  for (let t = middle - 14 * 3_600_000; t <= middle + 38 * 3_600_000; t += 60_000) {
    const local = localParts(t, rules.timeZone);
    if (local.date === from.date && local.minute >= minute(hours.start) && local.minute <= minute(hours.end)) actual.push({ instant: t, value: local.minute });
  }
  if (!actual.length) throw new TravelCheckError("TRAVEL_OUTSIDE_HOURS");
  return { startsAt: actual[0].instant, endsAt: actual[actual.length - 1].instant };
}
function blockedPeriods(startsAt: string, rules: BookingRules): BusyInterval[] {
  const day = localParts(Date.parse(startsAt), rules.timeZone), middle = Date.parse(`${day.date}T00:00:00Z`);
  const breaks: BusyInterval[] = [];
  // Convert actual minute intervals: a break covers both autumn occurrences.
  let open: number | null = null;
  for (let t = middle - 14 * 3_600_000; t <= middle + 38 * 3_600_000; t += 60_000) {
    const local = localParts(t, rules.timeZone), blocked = local.date === day.date && rules.breaks.some(value => value.day === local.day && local.minute >= minute(value.start) && local.minute < minute(value.end));
    if (blocked && open === null) open = t;
    if (!blocked && open !== null) { breaks.push({ startsAt: iso(open), endsAt: iso(t) }); open = null; }
  }
  return [...breaks, ...rules.absences];
}

/** Calendar/rule filtering precedes this check. Only addresses and departure times leave the service. */
export async function checkBookingTravel(input: {
  startsAt: string; kind: BookingKind; rules: BookingRules; appointments: TravelAppointment[]; router: DrivingRouter;
  now?: number; calendarCache?: Map<string, CalendarGeometry>;
}): Promise<TravelProof | null> {
  const { rules } = input;
  if (rules.travel.policy !== "google_maps" || !rules.travel.enabled) {
    if (input.kind === "onsite" && rules.travel.required) throw new TravelCheckError("TRAVEL_CHECK_REQUIRED");
    return null;
  }
  const settings = rules.travel, window = bookingWindow(input.startsAt, rules), date = localParts(Date.parse(input.startsAt), rules.timeZone).date;
  const location = bookingTravelLocation(input.kind, rules, settings), office = selectedTravelLocation(settings, settings.startLocationId);
  if (!location || !office) throw new TravelCheckError(input.kind === "onsite" ? "ADDRESS_CONFIRMATION_REQUIRED" : "TRAVEL_LOCATION_REQUIRED");
  const sameDay = input.appointments.filter(event => localParts(Date.parse(event.endsAt) - 1, rules.timeZone).date >= date && localParts(Date.parse(event.startsAt), rules.timeZone).date <= date);
  if (sameDay.some(event => overlaps({ startsAt: event.blockedStartsAt, endsAt: event.blockedEndsAt }, { startsAt: window.blockedStartsAt, endsAt: window.blockedEndsAt }))) throw new TravelCheckError("SLOT_UNAVAILABLE");
  const previous = sameDay.filter(event => Date.parse(event.blockedEndsAt) <= Date.parse(window.blockedStartsAt)).sort((a, b) => Date.parse(b.blockedEndsAt) - Date.parse(a.blockedEndsAt))[0];
  const next = sameDay.filter(event => Date.parse(event.blockedStartsAt) >= Date.parse(window.blockedEndsAt)).sort((a, b) => Date.parse(a.blockedStartsAt) - Date.parse(b.blockedStartsAt))[0];
  if (previous && !previous.location || next && !next.location ||
    previous && sameDay.some(event => event.blockedEndsAt === previous.blockedEndsAt && (!event.location || normalizedAddress(event.location) !== normalizedAddress(previous.location!))) ||
    next && sameDay.some(event => event.blockedStartsAt === next.blockedStartsAt && (!event.location || normalizedAddress(event.location) !== normalizedAddress(next.location!)))) throw new TravelCheckError("PREVIOUS_OR_NEXT_LOCATION_UNKNOWN");
  const local = localParts(Date.parse(window.blockedStartsAt), rules.timeZone);
  const hours = rules.workingHours.find(value => value.day === local.day && minute(value.start) <= local.minute && minute(value.end) >= local.minute);
  const geometryKey = JSON.stringify([date, rules.timeZone, hours, rules.breaks, rules.absences]);
  let geometry = input.calendarCache?.get(geometryKey);
  if (!geometry) { geometry = { span: workingSpan(input.startsAt, rules), blocked: blockedPeriods(input.startsAt, rules) }; input.calendarCache?.set(geometryKey, geometry); }
  const { span } = geometry, blocked = [...geometry.blocked, ...sameDay.map(event => ({ startsAt: event.blockedStartsAt, endsAt: event.blockedEndsAt }))];
  let bufferCount = 0;
  const drive = async (origin: string, destination: string, earliest: number, latest: number) => {
    if (normalizedAddress(origin) === normalizedAddress(destination)) return { arrival: earliest, minutes: 0 };
    // A departure captured a few milliseconds ago would already be invalid for DRIVE.
    const earliestFutureMinute = input.now === undefined ? -Infinity : (Math.floor(input.now / 60_000) + 1) * 60_000;
    let departure = Math.max(earliest, span.startsAt, earliestFutureMinute);
    for (let attempt = 0; attempt <= blocked.length + 1; attempt++) {
      if (departure >= latest || departure >= span.endsAt) throw new TravelCheckError("TRAVEL_TIME_UNAVAILABLE");
      const route = await input.router({ origin, destination, departureTime: iso(departure) });
      if (!Number.isSafeInteger(route.minutes) || route.minutes <= 0) throw new TravelCheckError("ROUTE_UNAVAILABLE");
      if (settings.maxDriveMinutes !== null && route.minutes > settings.maxDriveMinutes) throw new TravelCheckError("MAX_DRIVE_EXCEEDED");
      const arrival = departure + (route.minutes + settings.additionalBufferMinutes) * 60_000;
      if (arrival > latest || arrival > span.endsAt) throw new TravelCheckError("TRAVEL_TIME_UNAVAILABLE");
      const obstruction = blocked.filter(event => overlaps({ startsAt: iso(departure), endsAt: iso(arrival) }, event)).sort((a, b) => Date.parse(a.endsAt) - Date.parse(b.endsAt))[0];
      if (!obstruction) { bufferCount++; return { arrival, minutes: route.minutes }; }
      departure = Date.parse(obstruction.endsAt);
    }
    throw new TravelCheckError("TRAVEL_TIME_UNAVAILABLE");
  };
  const path = async (points: string[], departure: number, deadline: number) => {
    let minutes = 0, arrival = departure;
    for (let index = 1; index < points.length; index++) { const leg = await drive(points[index - 1], points[index], arrival, deadline); arrival = leg.arrival; minutes += leg.minutes; }
    return minutes;
  };
  const inboundOrigin = previous?.location ?? office;
  const inboundPoints = settings.directTravel ? [inboundOrigin, location] : [inboundOrigin, office, location];
  const inboundMinutes = await path(inboundPoints, previous ? Date.parse(previous.blockedEndsAt) : span.startsAt, Date.parse(window.blockedStartsAt));
  if (settings.maxDriveMinutes !== null && inboundMinutes > settings.maxDriveMinutes) throw new TravelCheckError("MAX_DRIVE_EXCEEDED");
  let outboundMinutes = 0;
  if (next) {
    const points = settings.directTravel ? [location, next.location!] : [location, office, next.location!];
    outboundMinutes = await path(points, Date.parse(window.blockedEndsAt), Date.parse(next.blockedStartsAt));
  } else if (settings.returnToEndLocation) {
    const end = selectedTravelLocation(settings, settings.endLocationId);
    if (!end) throw new TravelCheckError("TRAVEL_LOCATION_REQUIRED");
    outboundMinutes = await path([location, end], Date.parse(window.blockedEndsAt), span.endsAt);
  }
  return { inboundMinutes, outboundMinutes, bufferMinutes: bufferCount * settings.additionalBufferMinutes, attribution: "Google Maps" };
}

export function createBookingTravelChecker(router: DrivingRouter, now?: number) {
  const calendarCache = new Map<string, CalendarGeometry>();
  return (input: Omit<Parameters<typeof checkBookingTravel>[0], "router" | "now" | "calendarCache">) => checkBookingTravel({ ...input, router, now, calendarCache });
}
