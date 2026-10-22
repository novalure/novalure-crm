import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultBookingRules, enumerateSlots } from "../src/lib/booking/rules";
import { createBookingTravelChecker, checkBookingTravel, TravelCheckError, travelAppointments, type DrivingRouter, type TravelAppointment } from "../src/lib/booking/travel";
import { createGoogleMapsRouter } from "../src/lib/booking/maps";
import type { BookingRecord, BookingRules } from "../src/lib/booking/types";
import type { BookingTravelSettings } from "../src/lib/booking/setup-types";

const at = (time: string) => `2026-11-10T${time}:00.000Z`;
const now = Date.parse("2026-11-09T00:00:00Z");
const settings: BookingTravelSettings = {
  enabled: true, startLocationId: "office", endLocationId: "office", onlineLocationId: "office",
  additionalBufferMinutes: 15, directTravel: true, returnToEndLocation: false, maxDriveMinutes: null,
  locations: [{ id: "office", label: "Synthetic office", address: "Synthetic office address", confirmed: true }],
};
const rules = (travel: Partial<BookingTravelSettings> = {}): BookingRules => ({
  ...structuredClone(defaultBookingRules), timeZone: "UTC", minNoticeMinutes: 0, durationMinutes: 45, preparationMinutes: 5, followupMinutes: 10,
  location: "Synthetic customer address", locationConfirmed: true, travel: { ...structuredClone(settings), ...travel, policy: "google_maps", required: true },
});
const appointment = (start: string, end: string, location: string | null, preparation = 0, followup = 0): TravelAppointment => ({
  startsAt: at(start), endsAt: at(end), blockedStartsAt: new Date(Date.parse(at(start)) - preparation * 60_000).toISOString(),
  blockedEndsAt: new Date(Date.parse(at(end)) + followup * 60_000).toISOString(), location,
});
const code = (expected: string) => (error: unknown) => error instanceof TravelCheckError && error.code === expected;

test("travel chain uses actual previous followup, next preparation, and one buffer per journey", async () => {
  const calls: Array<Parameters<DrivingRouter>[0]> = [];
  const router: DrivingRouter = async input => { calls.push(input); return { minutes: input.origin === "Synthetic previous address" ? 20 : 15 }; };
  const proof = await checkBookingTravel({ startsAt: at("11:00"), kind: "onsite", rules: rules(), now, router,
    appointments: [appointment("09:00", "10:00", "Synthetic previous address", 0, 10), appointment("12:30", "13:00", "Synthetic next address", 5)] });
  assert.deepEqual(proof, { inboundMinutes: 20, outboundMinutes: 15, bufferMinutes: 30, attribution: "Google Maps" });
  assert.equal(calls[0].departureTime, at("10:10"));
  assert.equal(calls[1].departureTime, at("11:55"));
  assert.deepEqual(Object.keys(calls[0]).sort(), ["departureTime", "destination", "origin"]);
});

test("added driving buffer changes first offered grid start after calendar filtering", async () => {
  const first = async (buffer: number) => {
    const policy = rules({ additionalBufferMinutes: buffer });
    const checker = createBookingTravelChecker(async () => ({ minutes: 30 }), now);
    for (const slot of enumerateSlots("2026-11-10", policy, [], now)) {
      try { await checker({ startsAt: slot.startsAt, kind: "onsite", rules: policy, appointments: [] }); return slot.startsAt; }
      catch (error) { assert.ok(error instanceof TravelCheckError); }
    }
  };
  assert.equal(await first(0), at("09:45"));
  assert.equal(await first(15), at("10:00"));
});

test("reachable incoming drive does not excuse an impossible onward connection", async () => {
  await assert.rejects(checkBookingTravel({ startsAt: at("11:00"), kind: "onsite", rules: rules(), now,
    router: async () => ({ minutes: 30 }), appointments: [appointment("12:00", "13:00", "Synthetic next address")] }), code("TRAVEL_TIME_UNAVAILABLE"));
});

test("Teams participation at office requires return after onsite but no journey of its own", async () => {
  const calls: Array<Parameters<DrivingRouter>[0]> = [];
  const router: DrivingRouter = async input => { calls.push(input); return { minutes: 40 }; };
  const appointments = [appointment("09:00", "10:00", "Synthetic previous address", 0, 10)];
  await assert.rejects(checkBookingTravel({ startsAt: at("11:00"), kind: "teams", rules: rules(), now, router, appointments }), code("TRAVEL_TIME_UNAVAILABLE"));
  await checkBookingTravel({ startsAt: at("11:15"), kind: "teams", rules: rules(), now, router, appointments });
  assert.equal(calls.length, 2);
  assert.ok(calls.every(input => input.destination === "Synthetic office address"));
});

test("unknown necessary previous location and unconfirmed candidate fail before Maps", async () => {
  let calls = 0;
  const router: DrivingRouter = async () => { calls++; return { minutes: 1 }; };
  await assert.rejects(checkBookingTravel({ startsAt: at("11:00"), kind: "onsite", rules: rules(), now, router,
    appointments: [appointment("09:00", "10:00", null)] }), code("PREVIOUS_OR_NEXT_LOCATION_UNKNOWN"));
  await assert.rejects(checkBookingTravel({ startsAt: at("11:00"), kind: "onsite", rules: { ...rules(), locationConfirmed: false }, now, router, appointments: [] }), code("ADDRESS_CONFIRMATION_REQUIRED"));
  assert.equal(calls, 0);
});

test("simultaneous appointments with different locations do not prove the departure location", async () => {
  await assert.rejects(checkBookingTravel({ startsAt: at("11:00"), kind: "onsite", rules: rules(), now,
    router: async () => ({ minutes: 1 }), appointments: [appointment("09:00", "10:00", "Synthetic A"), appointment("09:30", "10:00", "Synthetic B")] }), code("PREVIOUS_OR_NEXT_LOCATION_UNKNOWN"));
});

test("same-day departure advances to a future minute rather than using an already elapsed request instant", async () => {
  const departures: string[] = [];
  await checkBookingTravel({ startsAt: at("11:00"), kind: "onsite", rules: rules(), now: Date.parse(at("09:15")) + 250,
    router: async input => { departures.push(input.departureTime); return { minutes: 15 }; }, appointments: [] });
  assert.equal(departures[0], at("09:16"));
});

test("route failure blocks affected travel while same-office meeting needs no invented journey", async () => {
  const router: DrivingRouter = async () => { throw new TravelCheckError("MAPS_UNAVAILABLE"); };
  await assert.rejects(checkBookingTravel({ startsAt: at("11:00"), kind: "onsite", rules: rules(), now, router, appointments: [] }), code("MAPS_UNAVAILABLE"));
  assert.deepEqual(await checkBookingTravel({ startsAt: at("11:00"), kind: "office", rules: rules(), now, router, appointments: [] }),
    { inboundMinutes: 0, outboundMinutes: 0, bufferMinutes: 0, attribution: "Google Maps" });
});

test("a break delays actual departure and causes a fresh departure-time route", async () => {
  const calls: string[] = [];
  const policy = rules({ additionalBufferMinutes: 0 });
  policy.breaks = [{ day: 2, start: "12:00", end: "13:00" }];
  await checkBookingTravel({ startsAt: at("13:45"), kind: "onsite", rules: policy, now,
    router: async input => { calls.push(input.departureTime); return { minutes: 30 }; }, appointments: [appointment("11:00", "11:50", "Synthetic previous address")] });
  assert.deepEqual(calls, [at("11:50"), at("13:00")]);
});

test("disabling direct continuation routes via office with a buffer for each actual leg", async () => {
  const calls: Array<Parameters<DrivingRouter>[0]> = [];
  const proof = await checkBookingTravel({ startsAt: at("11:00"), kind: "onsite", rules: rules({ directTravel: false, additionalBufferMinutes: 5 }), now,
    router: async input => { calls.push(input); return { minutes: 10 }; }, appointments: [appointment("09:00", "10:00", "Synthetic previous address")] });
  assert.equal(proof?.inboundMinutes, 20);
  assert.equal(proof?.bufferMinutes, 10);
  assert.equal(calls[0].destination, "Synthetic office address");
  assert.equal(calls[1].origin, "Synthetic office address");
  assert.equal(calls[1].departureTime, at("10:15"));
});

test("required return and maximum driving time both limit late onsite slots", async () => {
  const router: DrivingRouter = async () => ({ minutes: 40 });
  await assert.rejects(checkBookingTravel({ startsAt: at("16:00"), kind: "onsite", rules: rules({ returnToEndLocation: true }), now, router, appointments: [] }), code("TRAVEL_TIME_UNAVAILABLE"));
  await assert.rejects(checkBookingTravel({ startsAt: at("11:00"), kind: "onsite", rules: rules({ maxDriveMinutes: 30 }), now, router, appointments: [] }), code("MAX_DRIVE_EXCEEDED"));
});

test("provider event matching never discards an unrelated conflict-calendar event", () => {
  const booking = { id: "synthetic-own", kind: "onsite", rules: rules(), startsAt: at("09:00"), endsAt: at("10:00"), blockedStartsAt: at("09:00"), blockedEndsAt: at("10:00"), providerEventId: "same-id", calendarId: "writer" } as BookingRecord;
  const result = travelAppointments([booking], [
    { startsAt: at("09:00"), endsAt: at("10:00"), eventId: "same-id", calendarId: "writer", location: booking.rules.location },
    { startsAt: at("10:00"), endsAt: at("10:30"), eventId: "same-id", calendarId: "conflict", location: null },
  ], settings);
  assert.equal(result.length, 2);
  assert.equal(result[0].location, booking.rules.location);
  assert.equal(result[1].location, null);
});

test("changed or removed provider onsite location invalidates the stale CRM place; remote presence rule remains explicit", () => {
  const booking = { id: "synthetic-own", kind: "onsite", rules: rules(), startsAt: at("09:00"), endsAt: at("10:00"), blockedStartsAt: at("09:00"), blockedEndsAt: at("10:00"), providerEventId: "same-id", calendarId: "writer" } as BookingRecord;
  for (const location of [null, "Changed synthetic address"]) {
    const result = travelAppointments([booking], [{ startsAt: at("09:00"), endsAt: at("10:00"), eventId: "same-id", calendarId: "writer", location }], settings);
    assert.equal(result[0].location, null);
  }
  const remote = travelAppointments([{ ...booking, kind: "teams" }], [{ startsAt: at("09:00"), endsAt: at("10:00"), eventId: "same-id", calendarId: "writer", location: null }], settings);
  assert.equal(remote[0].location, "Synthetic office address");
});

test("authorized provider times replace stale confirmed times while unsettled moves retain their union reservation", () => {
  const booking = { id: "synthetic-own", state: "confirmed", kind: "onsite", rules: rules(), startsAt: at("09:00"), endsAt: at("10:00"), blockedStartsAt: at("08:55"), blockedEndsAt: at("10:10"), providerEventId: "same-id", calendarId: "writer" } as BookingRecord;
  const external = [{ startsAt: at("11:00"), endsAt: at("12:00"), eventId: "same-id", calendarId: "writer", location: booking.rules.location }];
  const actual = travelAppointments([booking], external, settings)[0];
  assert.equal(actual.startsAt, at("11:00"));
  assert.equal(actual.blockedStartsAt, at("10:55"));
  assert.equal(actual.blockedEndsAt, at("12:10"));
  const unsettled = travelAppointments([{ ...booking, state: "processing", blockedEndsAt: at("15:00") }], external, settings)[0];
  assert.equal(unsettled.blockedStartsAt, booking.blockedStartsAt);
  assert.equal(unsettled.blockedEndsAt, at("15:00"));
  assert.equal(unsettled.location, null);
});

const validRouteResponse = () => ({ routes: [{ duration: "1201s" }], geocodingResults: {
  origin: { placeId: "synthetic-origin", type: ["street_address"], geocoderStatus: {} },
  destination: { placeId: "synthetic-destination", type: ["premise"] },
} });
const trip = { origin: "Synthetic origin address", destination: "Synthetic destination address", departureTime: at("10:00") };

test("Routes transport sends minimal addresses, explicit traffic-aware departure and request-only dedup", async () => {
  let calls = 0;
  const fetcher = (async (url, init) => {
    calls++;
    assert.equal(url, "https://routes.googleapis.com/directions/v2:computeRoutes");
    assert.equal(init?.redirect, "error");
    assert.equal(init?.cache, "no-store");
    const body = JSON.parse(String(init?.body));
    assert.deepEqual(body, { origin: { address: trip.origin }, destination: { address: trip.destination }, travelMode: "DRIVE", routingPreference: "TRAFFIC_AWARE", departureTime: trip.departureTime });
    return Response.json(validRouteResponse());
  }) as typeof fetch;
  const router = createGoogleMapsRouter({ fetcher, apiKey: "synthetic-key", now: () => now });
  assert.deepEqual(await router(trip), { minutes: 21 });
  await router(trip);
  assert.equal(calls, 1);
  await createGoogleMapsRouter({ fetcher, apiKey: "synthetic-key", now: () => now })(trip);
  assert.equal(calls, 2);
});

test("Maps partial matches, broad places, no route, traffic fallback and provider errors never become zero", async () => {
  const cases: Array<[unknown, number, string]> = [
    [{ ...validRouteResponse(), geocodingResults: { ...validRouteResponse().geocodingResults, origin: { placeId: "synthetic", type: ["street_address"], partialMatch: true } } }, 200, "ADDRESS_AMBIGUOUS"],
    [{ ...validRouteResponse(), geocodingResults: { ...validRouteResponse().geocodingResults, origin: { placeId: "synthetic", type: ["locality"] } } }, 200, "ADDRESS_AMBIGUOUS"],
    [{ ...validRouteResponse(), routes: [] }, 200, "ROUTE_UNAVAILABLE"],
    [{ ...validRouteResponse(), fallbackInfo: { reason: "LATENCY_EXCEEDED" } }, 200, "MAPS_TRAFFIC_UNAVAILABLE"],
    [{}, 403, "MAPS_ACCESS_DENIED"],
  ];
  for (const [body, status, expected] of cases) {
    const router = createGoogleMapsRouter({ apiKey: "synthetic-key", now: () => now, fetcher: (async () => Response.json(body, { status })) as typeof fetch });
    await assert.rejects(router(trip), code(expected));
  }
});
