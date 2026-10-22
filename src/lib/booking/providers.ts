import "server-only";
import { createHash } from "node:crypto";
import type { TenantScope } from "@/lib/db/tenant-client";
import { getBookingCalendarAccess, invalidateBookingConnection } from "@/lib/booking/connections";
import { BookingError, type BookingProvider, type BookingProviderName, type BusyInterval, type ProviderEvent, type ProviderWrite } from "@/lib/booking/types";

const graphRoot = "https://graph.microsoft.com/v1.0";
const googleRoot = "https://www.googleapis.com/calendar/v3";
const ownershipProperty = "String {f0c6c55b-2cda-4365-b7d6-b5d2cd8c6d75} Name NovalureBooking";
const operationProperty = "String {f0c6c55b-2cda-4365-b7d6-b5d2cd8c6d75} Name NovalureOperation";
type JsonObject = Record<string, unknown>;
type CalendarAccess = Awaited<ReturnType<typeof getBookingCalendarAccess>>;

/** A write may have reached the provider. Call lookup; never repeat a create blindly. */
export class BookingProviderError extends BookingError {
  constructor(code: string, public outcome: "rejected" | "unknown", public providerStatus: number | null = null) {
    super(code, outcome === "unknown" ? 503 : 409);
  }
}

function object(value: unknown): JsonObject { return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {}; }
function string(value: unknown): string | null { return typeof value === "string" && value ? value : null; }
function array(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function instant(value: unknown): string {
  const raw = string(value);
  if (!raw || !Number.isFinite(Date.parse(raw))) throw new BookingProviderError("provider_invalid_time", "rejected");
  return new Date(raw).toISOString();
}
function busyInterval(startsAt: string, endsAt: string, eventId?: string): BusyInterval {
  if (Date.parse(startsAt) >= Date.parse(endsAt)) throw new BookingProviderError("provider_invalid_interval", "rejected");
  return { startsAt, endsAt, ...(eventId ? { eventId } : {}) };
}
function onlineUrl(value: unknown): string | null {
  const raw = string(value);
  if (!raw) return null;
  try { const parsed = new URL(raw); return parsed.protocol === "https:" && !parsed.username && !parsed.password ? parsed.toString() : null; }
  catch { return null; }
}
function marker(scope: TenantScope, bookingId: string) { return `${scope.workspaceId}:${bookingId}`; }
/** Hexadecimal is a subset of Google's required base32hex event-id alphabet. */
export function googleBookingEventId(scope: TenantScope, operationId: string) {
  return createHash("sha256").update(`${scope.workspaceId}:${scope.actorId}:${operationId}`).digest("hex");
}
function graphTime(value: unknown): string {
  const time = object(value);
  const raw = string(time.dateTime);
  if (!raw) throw new BookingProviderError("provider_invalid_time", "rejected");
  // Every Graph read explicitly requests UTC, including all-day and recurring instances.
  return instant(/[zZ]$|[+-]\d\d:\d\d$/.test(raw) ? raw : `${raw}Z`);
}
function zonedMidnight(date: string, timeZone: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new BookingProviderError("provider_invalid_time", "rejected");
  const target = Date.parse(`${date}T00:00:00Z`);
  let guess = target;
  const formatter = new Intl.DateTimeFormat("en-GB", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
  for (let index = 0; index < 4; index++) {
    const parts = Object.fromEntries(formatter.formatToParts(guess).map(part => [part.type, part.value]));
    const shown = Date.parse(`${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}Z`);
    const next = guess + target - shown;
    if (next === guess) return new Date(guess).toISOString();
    guess = next;
  }
  throw new BookingProviderError("provider_invalid_time", "rejected");
}
function googleTime(value: unknown, calendarTimeZone: string): string {
  const time = object(value);
  if (string(time.dateTime)) return instant(time.dateTime);
  const date = string(time.date);
  if (date) return zonedMidnight(date, string(time.timeZone) || calendarTimeZone);
  throw new BookingProviderError("provider_invalid_time", "rejected");
}

async function request(scope: TenantScope, access: CalendarAccess, url: URL, method = "GET", body?: unknown, etag?: string | null) {
  const expected = access.provider === "microsoft" ? new URL(graphRoot) : new URL(googleRoot);
  if (url.origin !== expected.origin || !url.pathname.startsWith(`${expected.pathname}/`)) throw new BookingProviderError("provider_invalid_page", "rejected");
  const write = method !== "GET";
  let response: Response;
  try {
    response = await fetch(url, { method, headers: {
      Authorization: `Bearer ${access.accessToken}`,
      "Content-Type": "application/json",
      ...(access.provider === "microsoft" ? { Prefer: 'outlook.timezone="UTC"' } : {}),
      ...(etag ? { "If-Match": etag } : {}),
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(12_000), redirect: "error", cache: "no-store" });
  } catch { throw new BookingProviderError("provider_transport_unavailable", write ? "unknown" : "rejected"); }
  if (response.status === 404 || response.status === 410) return { response, data: null };
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) await invalidateBookingConnection(scope, access.provider, access.revision, access.accessToken).catch(() => undefined);
    const code = response.status === 401 || response.status === 403 ? "connection_permission_denied" : response.status === 412 ? "provider_event_changed" : "provider_request_failed";
    throw new BookingProviderError(code, write && (response.status >= 500 || response.status === 408) ? "unknown" : "rejected", response.status);
  }
  if (response.status === 204) return { response, data: {} };
  try { return { response, data: object(await response.json()) }; }
  catch { throw new BookingProviderError("provider_invalid_response", write ? "unknown" : "rejected"); }
}

function assertWrite(access: CalendarAccess, kind?: ProviderWrite["kind"]) {
  if (!access.calendar.canWrite || access.calendar.protectedReadOnly) throw new BookingProviderError("calendar_read_only", "rejected");
  if (kind === "teams" && (access.provider !== "microsoft" || !access.calendar.teamsSupported)) throw new BookingProviderError("teams_not_supported", "rejected");
  if (kind === "meet" && (access.provider !== "google" || !access.calendar.meetSupported)) throw new BookingProviderError("meet_not_supported", "rejected");
}
function assertTestWritePolicy(scope: TenantScope, access: CalendarAccess) {
  const preview = process.env.VERCEL_ENV === "preview";
  const localTest = !process.env.VERCEL_ENV && ["test", "development"].includes(process.env.NODE_ENV || "");
  if (process.env.BOOKING_ENGINE_ENABLED !== "1" || (!preview && !localTest)) throw new BookingProviderError("booking_preview_only", "rejected");
  let bindings: unknown;
  try { bindings = JSON.parse(process.env.BOOKING_TEST_BINDINGS_JSON || "[]"); }
  catch { throw new BookingProviderError("booking_test_binding_missing", "rejected"); }
  const allowed = typeof access.accountId === "string" && Boolean(access.accountId) && array(bindings).some(value => {
    const entry = object(value);
    return entry.workspaceId === scope.workspaceId && entry.userId === scope.actorId && entry.provider === access.provider && entry.accountId === access.accountId && entry.calendarId === access.calendarId;
  });
  if (!allowed) throw new BookingProviderError("booking_test_binding_missing", "rejected");
}
function assertTimes(input: ProviderWrite) {
  if (Date.parse(instant(input.startsAt)) >= Date.parse(instant(input.endsAt))) throw new BookingProviderError("invalid_interval", "rejected");
}
function graphProperties(data: JsonObject) {
  return Object.fromEntries(array(data.singleValueExtendedProperties).map(value => { const property = object(value); return [string(property.id) || "", string(property.value)]; }));
}
function assertOwned(scope: TenantScope, bookingId: string, provider: BookingProviderName, data: JsonObject) {
  const ownMarker = provider === "microsoft" ? graphProperties(data)[ownershipProperty] : object(object(data.extendedProperties).private).novalureBooking;
  if (ownMarker !== marker(scope, bookingId)) throw new BookingProviderError("provider_event_not_owned", "rejected");
}
function eventResult(provider: BookingProviderName, data: JsonObject, fallbackTimeZone = "UTC", requestedVideo = false): ProviderEvent {
  const eventId = string(data.id);
  if (!eventId) throw new BookingProviderError("provider_event_id_missing", "unknown");
  const cancelled = provider === "microsoft" ? data.isCancelled === true : data.status === "cancelled";
  const conference = object(data.conferenceData);
  const createRequest = object(conference.createRequest);
  const conferenceStatus = string(object(createRequest.status).statusCode);
  const link = provider === "microsoft" ? onlineUrl(object(data.onlineMeeting).joinUrl) : onlineUrl(data.hangoutLink) || onlineUrl(object(array(conference.entryPoints).find(value => object(value).entryPointType === "video")).uri);
  const videoExpected = requestedVideo || (provider === "microsoft" ? data.isOnlineMeeting === true : Boolean(data.conferenceData));
  return {
    eventId, etag: string(data["@odata.etag"]) || string(data.etag),
    startsAt: cancelled && !data.start ? "1970-01-01T00:00:00.000Z" : provider === "microsoft" ? graphTime(data.start) : googleTime(data.start, fallbackTimeZone),
    endsAt: cancelled && !data.end ? "1970-01-01T00:00:00.000Z" : provider === "microsoft" ? graphTime(data.end) : googleTime(data.end, fallbackTimeZone),
    onlineMeetingUrl: link, videoStatus: link ? "ready" : conferenceStatus === "failure" ? "unavailable" : videoExpected ? "pending" : "none", cancelled,
  };
}

// A successful write can already exist remotely even if its response is malformed.
// Parsing failures must retain the operation for reconciliation and its resource lock.
function writtenEventResult(provider: BookingProviderName, data: JsonObject, input: ProviderWrite): ProviderEvent {
  try { return eventResult(provider, data, input.timeZone, input.kind === "teams" || input.kind === "meet"); }
  catch { throw new BookingProviderError("provider_write_response_unknown", "unknown"); }
}

function graphEventUrl(access: CalendarAccess, eventId?: string) {
  return new URL(`${graphRoot}/me/calendars/${encodeURIComponent(access.calendarId)}/events${eventId ? `/${encodeURIComponent(eventId)}` : ""}`);
}
function googleEventUrl(access: CalendarAccess, eventId?: string) {
  return new URL(`${googleRoot}/calendars/${encodeURIComponent(access.calendarId)}/events${eventId ? `/${encodeURIComponent(eventId)}` : ""}`);
}
async function graphOwnedEvent(access: CalendarAccess, scope: TenantScope, bookingId: string, eventId: string) {
  const url = graphEventUrl(access, eventId);
  url.searchParams.set("$expand", `singleValueExtendedProperties($filter=id eq '${ownershipProperty}')`);
  const { data } = await request(scope, access, url);
  if (data) assertOwned(scope, bookingId, "microsoft", data);
  return data;
}
async function googleOwnedEvent(access: CalendarAccess, scope: TenantScope, bookingId: string, eventId: string) {
  const { data } = await request(scope, access, googleEventUrl(access, eventId));
  if (data && data.status !== "cancelled") assertOwned(scope, bookingId, "google", data);
  // Deleted Google tombstones can omit private properties: the caller must retain its own event mapping.
  return data;
}

function graphWriteBody(scope: TenantScope, input: ProviderWrite, create: boolean) {
  const body: JsonObject = {
    subject: input.title,
    start: { dateTime: instant(input.startsAt).replace(/Z$/, ""), timeZone: "UTC" },
    end: { dateTime: instant(input.endsAt).replace(/Z$/, ""), timeZone: "UTC" },
    location: { displayName: input.location },
    singleValueExtendedProperties: [{ id: ownershipProperty, value: marker(scope, input.bookingId) }, { id: operationProperty, value: input.operationId }],
  };
  if (create) {
    body.transactionId = createHash("sha256").update(`${scope.workspaceId}:${input.operationId}`).digest("hex");
    if (input.kind === "teams") { body.isOnlineMeeting = true; body.onlineMeetingProvider = "teamsForBusiness"; }
  }
  return body;
}
function googleWriteBody(scope: TenantScope, input: ProviderWrite, create: boolean) {
  return {
    ...(create ? { id: googleBookingEventId(scope, input.operationId) } : {}), summary: input.title,
    start: { dateTime: instant(input.startsAt), timeZone: input.timeZone }, end: { dateTime: instant(input.endsAt), timeZone: input.timeZone }, location: input.location,
    extendedProperties: { private: { novalureBooking: marker(scope, input.bookingId), novalureOperation: input.operationId } },
    ...(create && input.kind === "meet" ? { conferenceData: { createRequest: { requestId: googleBookingEventId(scope, input.operationId), conferenceSolutionKey: { type: "hangoutsMeet" } } } } : {}),
  };
}

/** Each factory invocation obtains only the current actor's explicitly selected connection. */
export async function createBookingProvider(scope: TenantScope, provider: BookingProviderName): Promise<BookingProvider> {
  const access = await getBookingCalendarAccess(scope, provider);
  return createBookingProviderWithAccess(scope, access);
}

/** Also used by isolated transport tests; the application factory always loads persisted scope. */
export function createBookingProviderWithAccess(scope: TenantScope, access: CalendarAccess): BookingProvider {
  if (access.userId !== scope.actorId) throw new BookingProviderError("connection_actor_mismatch", "rejected");
  const provider = access.provider;
  const eventUrl = (eventId?: string) => provider === "microsoft" ? graphEventUrl(access, eventId) : googleEventUrl(access, eventId);
  const ownedEvent = (bookingId: string, eventId: string) => provider === "microsoft" ? graphOwnedEvent(access, scope, bookingId, eventId) : googleOwnedEvent(access, scope, bookingId, eventId);
  return {
    async listBusy(input) {
      const intervals: BusyInterval[] = [];
      for (const calendarId of new Set([access.calendarId, ...access.conflictCalendarIds])) {
        const calendar = access.calendars.find(entry => entry.id === calendarId);
        if (!calendar?.canRead) throw new BookingProviderError("conflict_calendar_unavailable", "rejected");
        if (provider === "google" && calendarId !== access.calendarId) {
          // freeBusyReader grants do not permit reading event details. The provider expands
          // recurring events, exceptions and whole-day entries for this exact calendar.
          const { data } = await request(scope, access, new URL(`${googleRoot}/freeBusy`), "POST", {
            timeMin: instant(input.startsAt), timeMax: instant(input.endsAt), items: [{ id: calendarId }],
          });
          const busyCalendar = object(object(data?.calendars)[calendarId]);
          if (!data || !Array.isArray(busyCalendar.busy) || (busyCalendar.errors !== undefined && (!Array.isArray(busyCalendar.errors) || busyCalendar.errors.length))) throw new BookingProviderError("conflict_calendar_unavailable", "rejected");
          for (const range of busyCalendar.busy) { const entry = object(range); intervals.push({ ...busyInterval(instant(entry.start), instant(entry.end)), ...(input.includeLocations ? { calendarId, location: null } : {}) }); }
          continue;
        }
        const url = provider === "microsoft"
          ? new URL(`${graphRoot}/me/calendars/${encodeURIComponent(calendarId)}/calendarView`)
          : new URL(`${googleRoot}/calendars/${encodeURIComponent(calendarId)}/events`);
        if (provider === "microsoft") {
          url.searchParams.set("startDateTime", instant(input.startsAt)); url.searchParams.set("endDateTime", instant(input.endsAt)); url.searchParams.set("$select", `id,start,end,showAs,isCancelled${input.includeLocations ? ",location" : ""}`); url.searchParams.set("$top", "250");
        } else {
          url.searchParams.set("timeMin", instant(input.startsAt)); url.searchParams.set("timeMax", instant(input.endsAt)); url.searchParams.set("singleEvents", "true"); url.searchParams.set("showDeleted", "false"); url.searchParams.set("maxResults", "2500");
          if (input.includeLocations) url.searchParams.set("fields", "items(id,start,end,status,transparency,location),nextPageToken,timeZone");
        }
        let page: URL | null = url;
        let pages = 0;
        while (page) {
          if (++pages > 50) throw new BookingProviderError("provider_busy_page_limit", "rejected");
          const result = await request(scope, access, page);
          if (!result.data) throw new BookingProviderError("conflict_calendar_unavailable", "rejected");
          const events = provider === "microsoft" ? result.data.value : result.data.items;
          if (!Array.isArray(events)) throw new BookingProviderError("provider_invalid_busy_response", "rejected");
          if (provider === "google" && result.data.timeZone !== undefined && !string(result.data.timeZone)) throw new BookingProviderError("provider_invalid_busy_response", "rejected");
          for (const item of events) {
            const event = object(item); const id = string(event.id);
            if (calendarId === access.calendarId && id === input.excludeEventId) continue;
            if (event.isCancelled === true || event.status === "cancelled" || event.showAs === "free" || event.transparency === "transparent") continue;
            if (provider === "google" && (object(event.start).date || object(event.end).date) && !string(result.data.timeZone)) throw new BookingProviderError("provider_invalid_busy_response", "rejected");
            const startsAt = provider === "microsoft" ? graphTime(event.start) : googleTime(event.start, string(result.data.timeZone) || "UTC");
            const endsAt = provider === "microsoft" ? graphTime(event.end) : googleTime(event.end, string(result.data.timeZone) || "UTC");
            const postal = object(object(event.location).address);
            const graphLocation = [postal.street, postal.postalCode, postal.city, postal.countryOrRegion].filter(value => typeof value === "string" && value.trim()).join(", ");
            const location = provider === "google" ? string(event.location) : graphLocation || string(object(event.location).displayName);
            intervals.push({ ...busyInterval(startsAt, endsAt, id || undefined), ...(input.includeLocations ? { calendarId, location } : {}) });
          }
          const next = provider === "microsoft" ? result.data["@odata.nextLink"] : result.data.nextPageToken;
          if (next !== undefined && !string(next)) throw new BookingProviderError("provider_invalid_page", "rejected");
          if (next === undefined) page = null;
          else if (typeof next !== "string") throw new BookingProviderError("provider_invalid_page", "rejected");
          else if (provider === "microsoft") { const nextUrl = new URL(next); if (nextUrl.origin !== url.origin || nextUrl.pathname !== url.pathname) throw new BookingProviderError("provider_invalid_page", "rejected"); page = nextUrl; }
          else { page = new URL(url); page.searchParams.set("pageToken", next); }
        }
      }
      return intervals;
    },
    async create(input) {
      assertTestWritePolicy(scope, access); assertWrite(access, input.kind); assertTimes(input);
      const url = eventUrl();
      if (provider === "google") { url.searchParams.set("sendUpdates", "none"); if (input.kind === "meet") url.searchParams.set("conferenceDataVersion", "1"); }
      const { data } = await request(scope, access, url, "POST", provider === "microsoft" ? graphWriteBody(scope, input, true) : googleWriteBody(scope, input, true));
      if (!data) throw new BookingProviderError("provider_create_unknown", "unknown");
      return writtenEventResult(provider, data, input);
    },
    async lookup(input) {
      if (input.eventId) {
        const data = await ownedEvent(input.bookingId, input.eventId);
        // Only a previously persisted owned-event mapping may resolve a 404/410 as
        // a deletion. A create without an event mapping remains unproven below.
        return data ? eventResult(provider, data) : { eventId: input.eventId, etag: null, startsAt: "1970-01-01T00:00:00.000Z", endsAt: "1970-01-01T00:00:00.000Z", onlineMeetingUrl: null, videoStatus: "none", cancelled: true };
      }
      if (provider === "google") {
        const data = await ownedEvent(input.bookingId, googleBookingEventId(scope, input.operationId));
        return data ? eventResult(provider, data) : null;
      }
      const url = eventUrl();
      const escaped = input.operationId.replace(/'/g, "''");
      url.searchParams.set("$filter", `singleValueExtendedProperties/Any(ep: ep/id eq '${operationProperty}' and ep/value eq '${escaped}')`);
      url.searchParams.set("$expand", `singleValueExtendedProperties($filter=id eq '${ownershipProperty}')`);
      url.searchParams.set("$top", "2");
      const { data } = await request(scope, access, url);
      if (!data) throw new BookingProviderError("calendar_unavailable", "rejected");
      if (!Array.isArray(data.value)) throw new BookingProviderError("provider_invalid_response", "rejected");
      const rows = data.value;
      if (rows.length > 1 || data["@odata.nextLink"]) throw new BookingProviderError("provider_operation_ambiguous", "unknown");
      if (!rows.length) return null;
      const event = object(rows[0]); assertOwned(scope, input.bookingId, provider, event);
      return eventResult(provider, event);
    },
    async update(input) {
      assertTestWritePolicy(scope, access); assertWrite(access, input.kind); assertTimes(input);
      const existing = await ownedEvent(input.bookingId, input.eventId);
      if (!existing || existing.status === "cancelled" || existing.isCancelled === true) throw new BookingProviderError("provider_event_missing", "rejected");
      const current = eventResult(provider, existing);
      if (!input.etag || !current.etag || input.etag !== current.etag) throw new BookingProviderError("provider_event_changed", "rejected");
      const url = eventUrl(input.eventId); if (provider === "google") { url.searchParams.set("sendUpdates", "none"); url.searchParams.set("conferenceDataVersion", "1"); }
      const { data } = await request(scope, access, url, "PATCH", provider === "microsoft" ? graphWriteBody(scope, input, false) : googleWriteBody(scope, input, false), current.etag);
      if (!data) throw new BookingProviderError("provider_update_unknown", "unknown");
      return writtenEventResult(provider, data, input);
    },
    async delete(input) {
      assertTestWritePolicy(scope, access); assertWrite(access);
      const existing = await ownedEvent(input.bookingId, input.eventId);
      if (!existing || existing.status === "cancelled" || existing.isCancelled === true) return;
      const current = eventResult(provider, existing);
      if (!input.etag || !current.etag || input.etag !== current.etag) throw new BookingProviderError("provider_event_changed", "rejected");
      const url = eventUrl(input.eventId); if (provider === "google") url.searchParams.set("sendUpdates", "none");
      await request(scope, access, url, "DELETE", undefined, current.etag);
    },
  };
}
