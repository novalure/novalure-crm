import assert from "node:assert/strict";
import test from "node:test";
import { BookingProviderError, createBookingProviderWithAccess, googleBookingEventId, type BookingProviderOptions, type StandaloneInvitationEffect } from "../src/lib/booking/providers";
import { BookingError, type BookingInvitation, type BookingProviderName, type ProviderWrite } from "../src/lib/booking/types";

const scope = { workspaceId: "10000000-0000-4000-8000-000000000031", actorId: "20000000-0000-4000-8000-000000000031" };
type Access = Parameters<typeof createBookingProviderWithAccess>[1];
const ownership = "String {f0c6c55b-2cda-4365-b7d6-b5d2cd8c6d75} Name NovalureBooking";
const operation = "String {f0c6c55b-2cda-4365-b7d6-b5d2cd8c6d75} Name NovalureOperation";
const first = { email: "first@example.invalid", name: "Synthetic first" }, second = { email: "second@example.invalid", name: "Synthetic second" };
const write: ProviderWrite = { bookingId: "40000000-0000-4000-8000-000000000031", operationId: "50000000-0000-4000-8000-000000000031", title: "Synthetic standalone", startsAt: "2026-10-25T01:30:00.000Z", endsAt: "2026-10-25T02:00:00.000Z", timeZone: "Europe/Vienna", kind: "office", location: "Synthetic office" };
function access(provider: BookingProviderName): Access {
  const calendar = { id: "synthetic/selected calendar", name: "Synthetic standalone", canWrite: true, canRead: true, protectedReadOnly: false, teamsSupported: provider === "microsoft", meetSupported: provider === "google" };
  return { connectionId: "30000000-0000-4000-8000-000000000031", userId: scope.actorId, provider, accessToken: "synthetic-unused-token", calendarId: calendar.id, conflictCalendarIds: [], calendar, calendars: [calendar], accountId: "synthetic-personal-account", accountLabel: "owner@example.invalid", revision: 7 };
}
function event(provider: BookingProviderName, attendees: BookingInvitation[] = [], extra: Record<string, unknown> = {}) {
  return provider === "microsoft" ? { id: "synthetic-ms-event", "@odata.etag": 'W/"etag-1"', subject: write.title, start: { dateTime: write.startsAt, timeZone: "UTC" }, end: { dateTime: write.endsAt, timeZone: "UTC" }, location: { displayName: write.location }, attendees: attendees.map(({ email, name }) => ({ emailAddress: { address: email, name }, type: "required" })), singleValueExtendedProperties: [{ id: ownership, value: `${scope.workspaceId}:${write.bookingId}` }, { id: operation, value: write.operationId }], ...extra }
    : { id: googleBookingEventId(scope, write.operationId), etag: '"etag-1"', summary: write.title, start: { dateTime: "2026-10-25T02:30:00+01:00", timeZone: write.timeZone }, end: { dateTime: "2026-10-25T03:00:00+01:00", timeZone: write.timeZone }, location: write.location, attendees: attendees.map(({ email, name }) => ({ email, displayName: name })), extendedProperties: { private: { novalureBooking: `${scope.workspaceId}:${write.bookingId}`, novalureOperation: write.operationId } }, ...extra };
}
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
async function transport(provider: BookingProviderName, run: (url: URL, init: RequestInit) => Response | Promise<Response>, callback: () => Promise<void>) {
  const originalFetch = globalThis.fetch, keys = ["NODE_ENV", "VERCEL_ENV", "BOOKING_ENGINE_ENABLED", "BOOKING_PRODUCTION_ENABLED", "BOOKING_TEST_BINDINGS_JSON", "BOOKING_MESSAGES_ENABLED"];
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]])); const binding = access(provider);
  Object.assign(process.env, { NODE_ENV: "test", BOOKING_ENGINE_ENABLED: "1", BOOKING_MESSAGES_ENABLED: "1", BOOKING_TEST_BINDINGS_JSON: JSON.stringify([{ workspaceId: scope.workspaceId, userId: scope.actorId, provider, accountId: binding.accountId, calendarId: binding.calendarId }]) });
  delete process.env.VERCEL_ENV; delete process.env.BOOKING_PRODUCTION_ENABLED;
  // Every request is intercepted in-process; no DNS, provider or production request.
  globalThis.fetch = async (url, init) => run(new URL(String(url)), init || {});
  try { await callback(); } finally { globalThis.fetch = originalFetch; for (const key of keys) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; } }
}
const rejected = (code: string) => (error: unknown) => error instanceof BookingProviderError && error.code === code && error.outcome === "rejected";

for (const provider of ["microsoft", "google"] as const) {
  test(`${provider} standalone readback projects owned title/location/attendees/operation and DST instants in exact calendar`, async () => {
    await transport(provider, (url, init) => {
      assert.equal(init.method, "GET"); assert.ok(url.pathname.includes(encodeURIComponent(access(provider).calendarId)));
      if (provider === "microsoft") { assert.ok(url.searchParams.get("$expand")?.includes(operation)); assert.equal(new Headers(init.headers).get("Prefer"), 'outlook.timezone="UTC"'); }
      return response(event(provider, [first]));
    }, async () => {
      const read = await createBookingProviderWithAccess(scope, access(provider), { withStandaloneWrite: send => send() }).lookup({ ...write, eventId: "synthetic-owned" });
      assert.equal(read?.startsAt, write.startsAt); assert.equal(read?.endsAt, write.endsAt); assert.ok(read?.etag);
      assert.deepEqual(read?.content, { title: write.title, location: write.location, attendees: [first], timeZone: provider === "microsoft" ? "UTC" : write.timeZone, operationId: write.operationId });
    });
  });
  test(`${provider} standalone creation and participant replacement/cancellation authorize union immediately around fetch`, async () => {
    let current = event(provider), authorized = false, writes = 0; const effects: StandaloneInvitationEffect[] = [];
    const options: BookingProviderOptions = { withStandaloneInvitationWrite: async (effect, send) => { effects.push(effect); authorized = true; try { return await send(); } finally { authorized = false; } }, withStandaloneWrite: async send => { assert.fail("Attendee writes must use only their invitation wrapper"); return send(); } };
    await transport(provider, (url, init) => {
      if (init.method === "GET") return response(current);
      writes++; assert.equal(authorized, true);
      if (provider === "google") assert.equal(url.searchParams.get("sendUpdates"), "all");
      if (init.method !== "POST") assert.equal(new Headers(init.headers).get("If-Match"), provider === "microsoft" ? 'W/"etag-1"' : '"etag-1"');
      if (init.method === "DELETE") return new Response(null, { status: 204 });
      const body = JSON.parse(String(init.body));
      assert.equal(body.attendees.length, 1);
      current = { ...current, ...body }; return response(current);
    }, async () => {
      const port = createBookingProviderWithAccess(scope, access(provider), options);
      await port.create({ ...write, standaloneAttendees: [first] });
      await port.update({ ...write, standaloneAttendees: [second], eventId: "synthetic-owned", etag: provider === "microsoft" ? 'W/"etag-1"' : '"etag-1"' });
      await port.delete({ ...write, standaloneAttendees: [], eventId: "synthetic-owned", etag: provider === "microsoft" ? 'W/"etag-1"' : '"etag-1"' });
      assert.equal(writes, 3);
      assert.deepEqual(effects, [{ bookingId: write.bookingId, operationId: write.operationId, attendees: [first], previousAttendees: [] }, { bookingId: write.bookingId, operationId: write.operationId, attendees: [second], previousAttendees: [first] }, { bookingId: write.bookingId, operationId: write.operationId, attendees: [], previousAttendees: [second] }]);
    });
  });
  test(`${provider} removing every guest remains an invitation effect, including an unexpected remote guest`, async () => {
    let writes = 0;
    await transport(provider, (_url, init) => { if (init.method === "GET") return response(event(provider, [first, second])); writes++; return response(event(provider)); }, async () => {
      const options: BookingProviderOptions = { withStandaloneInvitationWrite: async effect => { assert.deepEqual(effect.previousAttendees, [first, second]); assert.deepEqual(effect.attendees, []); throw new BookingProviderError("standalone_recipient_not_registered", "rejected"); } };
      const port = createBookingProviderWithAccess(scope, access(provider), options), input = { ...write, standaloneAttendees: [], eventId: "synthetic-owned", etag: provider === "microsoft" ? 'W/"etag-1"' : '"etag-1"' };
      await assert.rejects(port.update(input), rejected("standalone_recipient_not_registered")); await assert.rejects(port.delete(input), rejected("standalone_recipient_not_registered")); assert.equal(writes, 0);
    });
  });
  test(`${provider} no-guest writes hold only standalone authority and never request guest notifications`, async () => {
    let locked = false, wrappers = 0;
    await transport(provider, (url, init) => {
      if (init.method === "GET") return response(event(provider));
      assert.equal(locked, true); if (provider === "google") assert.equal(url.searchParams.get("sendUpdates"), "none");
      return init.method === "DELETE" ? new Response(null, { status: 204 }) : response(event(provider, [], JSON.parse(String(init.body))));
    }, async () => {
      const port = createBookingProviderWithAccess(scope, access(provider), { withStandaloneWrite: async send => { wrappers++; locked = true; try { return await send(); } finally { locked = false; } }, withStandaloneInvitationWrite: async () => { assert.fail("Empty union cannot use invitation wrapper"); } });
      await port.create({ ...write, standaloneAttendees: [] });
      const input = { ...write, standaloneAttendees: [], eventId: "synthetic-owned", etag: provider === "microsoft" ? 'W/"etag-1"' : '"etag-1"' };
      await port.update(input); await port.delete(input); assert.equal(wrappers, 3);
    });
  });
  test(`${provider} runtime, missing wrapper, malformed/duplicate/over-limit attendee lists fail before mutation`, async () => {
    let mutations = 0;
    await transport(provider, (_url, init) => { if (init.method === "GET") return response(event(provider)); mutations++; return response(event(provider)); }, async () => {
      const port = createBookingProviderWithAccess(scope, access(provider));
      await assert.rejects(port.create({ ...write, standaloneAttendees: [first] }), rejected("standalone_invitation_not_authorized"));
      await assert.rejects(port.create({ ...write, standaloneAttendees: [] }), rejected("standalone_write_not_authorized"));
      for (const attendees of [[{ email: "bad", name: "bad" }], [first, { ...first, email: first.email.toUpperCase() }], Array.from({ length: 11 }, (_, n) => ({ email: `${n}@example.invalid`, name: "Synthetic" })), [{ ...first, optional: true }]]) {
        await assert.rejects(port.create({ ...write, standaloneAttendees: attendees }), rejected("provider_attendees_unverified"));
      }
      await assert.rejects(port.create({ ...write, invitation: first, standaloneAttendees: [first] }), rejected("standalone_invitation_mixed_contract"));
      process.env.BOOKING_MESSAGES_ENABLED = "0";
      await assert.rejects(createBookingProviderWithAccess(scope, access(provider), { withStandaloneInvitationWrite: (_effect, send) => send() }).create({ ...write, standaloneAttendees: [first] }), rejected("standalone_invitation_not_authorized"));
      assert.equal(mutations, 0);
    });
  });
  test(`${provider} foreign ownership, stale ETag and unsupported existing participant roles prevent writes`, async () => {
    let payload = event(provider), mutations = 0;
    await transport(provider, (_url, init) => { if (init.method === "GET") return response(payload); mutations++; return response(payload); }, async () => {
      const port = createBookingProviderWithAccess(scope, access(provider), { withStandaloneWrite: send => send(), withStandaloneInvitationWrite: (_effect, send) => send() });
      const input = { ...write, standaloneAttendees: [], eventId: "synthetic-owned", etag: '"stale"' };
      await assert.rejects(port.update(input), rejected("provider_event_changed"));
      payload = event(provider, [], provider === "microsoft" ? { singleValueExtendedProperties: [{ id: ownership, value: "foreign-workspace:event" }] } : { extendedProperties: { private: { novalureBooking: "foreign-workspace:event" } } });
      await assert.rejects(port.update(input), rejected("provider_event_not_owned"));
      payload = event(provider, [], { attendees: provider === "microsoft" ? [{ emailAddress: { address: first.email }, type: "optional" }] : [{ email: first.email, optional: true }] });
      await assert.rejects(port.update({ ...input, etag: provider === "microsoft" ? 'W/"etag-1"' : '"etag-1"' }), rejected("provider_attendees_unverified"));
      assert.equal(mutations, 0);
    });
  });
}

test("standalone writes recheck actor/calendar authority and classify lost responses as unknown", async () => {
  let calls = 0;
  await transport("google", () => { calls++; throw new Error("Synthetic lost response"); }, async () => {
    assert.throws(() => createBookingProviderWithAccess(scope, { ...access("google"), userId: "other-user" }), rejected("connection_actor_mismatch"));
    await assert.rejects(createBookingProviderWithAccess(scope, { ...access("google"), calendar: { ...access("google").calendar, protectedReadOnly: true } }, { withStandaloneWrite: send => send() }).create({ ...write, standaloneAttendees: [] }), rejected("calendar_read_only"));
    const denied = createBookingProviderWithAccess(scope, access("google"), { withStandaloneWrite: async () => { throw new BookingProviderError("standalone_membership_revoked", "rejected"); } });
    await assert.rejects(denied.create({ ...write, standaloneAttendees: [] }), rejected("standalone_membership_revoked")); assert.equal(calls, 0);
    await assert.rejects(createBookingProviderWithAccess(scope, access("google"), { withStandaloneWrite: send => send() }).create({ ...write, standaloneAttendees: [] }), (error: unknown) => error instanceof BookingProviderError && error.outcome === "unknown"); assert.equal(calls, 1);
  });
});

test("Google unknown-create lookup reads its deterministic operation ID and existing Booking invitation default stays unchanged", async () => {
  let phase = "create";
  await transport("google", (url, init) => {
    if (phase === "create") { assert.equal(init.method, "POST"); assert.equal(url.searchParams.get("sendUpdates"), "none"); assert.equal(JSON.parse(String(init.body)).attendees, undefined); return response(event("google")); }
    assert.equal(init.method, "GET"); assert.ok(url.pathname.endsWith(googleBookingEventId(scope, write.operationId))); return response(event("google"));
  }, async () => {
    const port = createBookingProviderWithAccess(scope, access("google"));
    await port.create({ ...write, invitation: first }); phase = "lookup";
    const found = await port.lookup(write); assert.equal(found?.content?.operationId, write.operationId);
  });
});

test("standalone authority failures before transmission are definite; journal failures afterwards remain unknown", async () => {
  let calls = 0;
  await transport("google", () => { calls++; return response(event("google")); }, async () => {
    for (const attendees of [[], [first]]) {
      const deny = async () => { throw new BookingError("synthetic_authority_revoked", 403); };
      const denied = createBookingProviderWithAccess(scope, access("google"), { withStandaloneWrite: deny, withStandaloneInvitationWrite: deny });
      await assert.rejects(denied.create({ ...write, standaloneAttendees: attendees }), rejected("synthetic_authority_revoked"));
      assert.equal(calls, 0);
    }
    const afterWrite = async (send: () => Promise<Response>) => { await send(); throw new BookingProviderError("synthetic_journal_commit_failed", "rejected"); };
    const uncertain = createBookingProviderWithAccess(scope, access("google"), { withStandaloneWrite: afterWrite, withStandaloneInvitationWrite: (_effect, send) => afterWrite(send) });
    for (const attendees of [[], [first]]) await assert.rejects(uncertain.create({ ...write, standaloneAttendees: attendees }), (error: unknown) => error instanceof BookingProviderError && error.outcome === "unknown");
    assert.equal(calls, 2);
  });
});

test("standalone unknown create reconciles via its owned operation and projected content without another POST", async () => {
  for (const provider of ["microsoft", "google"] as const) {
    let posts = 0, gets = 0;
    await transport(provider, (url, init) => {
      if (init.method === "POST") { posts++; throw new Error("Synthetic lost acknowledgement"); }
      gets++;
      if (provider === "microsoft") { assert.ok(url.searchParams.get("$filter")?.includes(write.operationId)); return response({ value: [event(provider, [first])] }); }
      assert.ok(url.pathname.endsWith(googleBookingEventId(scope, write.operationId))); return response(event(provider, [first]));
    }, async () => {
      const port = createBookingProviderWithAccess(scope, access(provider), { withStandaloneInvitationWrite: (_effect, send) => send() });
      await assert.rejects(port.create({ ...write, standaloneAttendees: [first] }), (error: unknown) => error instanceof BookingProviderError && error.outcome === "unknown");
      const found = await port.lookup(write);
      assert.equal(found?.content?.operationId, write.operationId); assert.deepEqual(found?.content?.attendees, [first]);
      assert.equal(posts, 1); assert.equal(gets, 1);
    });
  }
});
