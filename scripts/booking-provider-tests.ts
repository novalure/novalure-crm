import assert from "node:assert/strict";
import test from "node:test";
import { BookingProviderError, createBookingProviderWithAccess, googleBookingEventId } from "../src/lib/booking/providers";
import type { ProviderWrite } from "../src/lib/booking/types";

const scope = { workspaceId: "10000000-0000-4000-8000-000000000001", actorId: "20000000-0000-4000-8000-000000000001" };
type Access = Parameters<typeof createBookingProviderWithAccess>[1];
function access(provider: "google" | "microsoft"): Access {
  const calendar = { id: "test-calendar", name: "Approved test calendar", canWrite: true, canRead: true, protectedReadOnly: false, teamsSupported: provider === "microsoft", meetSupported: provider === "google" };
  return { connectionId: "30000000-0000-4000-8000-000000000001", userId: scope.actorId, provider, accessToken: "synthetic-provider-token", calendarId: calendar.id, conflictCalendarIds: [], calendar, calendars: [calendar], accountId: "approved-test-account", accountLabel: "hello@novalure.eu", revision: 1 };
}
const write: ProviderWrite = { bookingId: "40000000-0000-4000-8000-000000000001", operationId: "50000000-0000-4000-8000-000000000001", title: "Synthetic appointment", startsAt: "2026-10-26T10:00:00.000Z", endsAt: "2026-10-26T10:30:00.000Z", timeZone: "Europe/Vienna", kind: "meet", location: "" };
function googleEvent(input: Partial<Record<string, unknown>> = {}) {
  return { id: googleBookingEventId(scope, write.operationId), etag: '"etag-1"', start: { dateTime: write.startsAt }, end: { dateTime: write.endsAt }, extendedProperties: { private: { novalureBooking: `${scope.workspaceId}:${write.bookingId}`, novalureOperation: write.operationId } }, ...input };
}
function response(data: unknown, status = 200) { return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } }); }
async function transport(run: (url: URL, init: RequestInit) => Response | Promise<Response>, callback: () => Promise<void>, binding = access("google")) {
  const originalFetch = globalThis.fetch;
  const originals = Object.fromEntries(["BOOKING_ENGINE_ENABLED", "BOOKING_TEST_BINDINGS_JSON", "VERCEL_ENV", "NODE_ENV"].map(key => [key, process.env[key]]));
  Object.assign(process.env, { NODE_ENV: "test", BOOKING_ENGINE_ENABLED: "1", BOOKING_TEST_BINDINGS_JSON: JSON.stringify([{ workspaceId: scope.workspaceId, userId: scope.actorId, provider: binding.provider, accountId: binding.accountId, calendarId: binding.calendarId }]) });
  delete process.env.VERCEL_ENV;
  globalThis.fetch = async (url, init) => run(new URL(String(url)), init || {});
  try { await callback(); }
  finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(originals)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
}

test("Google create uses deterministic base32hex-compatible identity, scoped ownership and honest pending Meet", async () => {
  let calls = 0;
  await transport((url, init) => {
    calls++; assert.equal(init.method, "POST"); assert.equal(url.searchParams.get("conferenceDataVersion"), "1"); assert.equal(url.searchParams.get("sendUpdates"), "none");
    const body = JSON.parse(String(init.body));
    assert.match(body.id, /^[0-9a-v]{5,1024}$/); assert.equal(body.id, googleBookingEventId(scope, write.operationId));
    assert.equal(body.extendedProperties.private.novalureBooking, `${scope.workspaceId}:${write.bookingId}`);
    assert.equal(body.conferenceData.createRequest.requestId, body.id); assert.equal(body.attendees, undefined);
    return response(googleEvent({ conferenceData: { createRequest: { status: { statusCode: "pending" } } } }));
  }, async () => {
    const result = await createBookingProviderWithAccess(scope, access("google")).create(write);
    assert.equal(result.videoStatus, "pending"); assert.equal(result.onlineMeetingUrl, null); assert.equal(calls, 1);
  });
});

test("Google timeout is unknown and reconciles deterministic event id without a second creation", async () => {
  let writes = 0; let reads = 0;
  await transport((url, init) => {
    if (init.method === "POST") { writes++; throw new TypeError("synthetic network timeout after accepting write"); }
    reads++; assert.ok(url.pathname.endsWith(`/${googleBookingEventId(scope, write.operationId)}`));
    return response(googleEvent({ hangoutLink: "https://meet.google.com/test-link" }));
  }, async () => {
    const provider = createBookingProviderWithAccess(scope, access("google"));
    await assert.rejects(provider.create(write), error => error instanceof BookingProviderError && error.outcome === "unknown");
    const event = await provider.lookup(write); assert.equal(event?.videoStatus, "ready"); assert.equal(writes, 1); assert.equal(reads, 1);
  });
});

test("A failed Google conference stays unavailable without fabricating a link", async () => {
  await transport(() => response(googleEvent({ conferenceData: { createRequest: { status: { statusCode: "failure" } } } })), async () => {
    const result = await createBookingProviderWithAccess(scope, access("google")).create(write);
    assert.equal(result.videoStatus, "unavailable"); assert.equal(result.onlineMeetingUrl, null);
  });
});

test("Microsoft create carries transaction identity, ownership and UTC times and returns actual Teams link", async () => {
  const microsoft = access("microsoft");
  await transport((url, init) => {
    assert.equal(url.pathname, "/v1.0/me/calendars/test-calendar/events");
    const body = JSON.parse(String(init.body));
    assert.match(body.transactionId, /^[0-9a-f]{64}$/); assert.equal(body.onlineMeetingProvider, "teamsForBusiness"); assert.equal(body.isOnlineMeeting, true);
    assert.deepEqual(body.start, { dateTime: "2026-10-26T10:00:00.000", timeZone: "UTC" });
    assert.equal(body.singleValueExtendedProperties[0].value, `${scope.workspaceId}:${write.bookingId}`);
    assert.equal(body.singleValueExtendedProperties[1].value, write.operationId); assert.equal(body.attendees, undefined);
    return response({ ...body, id: "ms-event", "@odata.etag": 'W/"change1"', onlineMeeting: { joinUrl: "https://teams.microsoft.com/l/meetup-join/test" } });
  }, async () => {
    const result = await createBookingProviderWithAccess(scope, microsoft).create({ ...write, kind: "teams" });
    assert.equal(result.videoStatus, "ready"); assert.ok(result.onlineMeetingUrl?.startsWith("https://teams.microsoft.com/"));
  }, microsoft);
});

test("Microsoft invitation is sent under current server authority and preserves existing attendees", async () => {
  const microsoft=access("microsoft"), invitation={email:"hello@novalure.eu",name:"Synthetic owner"};
  const original=process.env.BOOKING_MESSAGES_ENABLED;process.env.BOOKING_MESSAGES_ENABLED="1";
  let writes=0,authorizations=0;
  const existing={id:"ms-event","@odata.etag":'W/"v1"',start:{dateTime:write.startsAt},end:{dateTime:write.endsAt},
    singleValueExtendedProperties:[{id:"String {f0c6c55b-2cda-4365-b7d6-b5d2cd8c6d75} Name NovalureBooking",value:`${scope.workspaceId}:${write.bookingId}`}],
    attendees:[{emailAddress:{address:"existing@example.invalid",name:"Existing attendee"},type:"optional",status:{response:"accepted"}}]};
  try{await transport((_url,init)=>{
    if(init.method==="GET")return response(existing);
    writes++;assert.equal(authorizations,writes);const body=JSON.parse(String(init.body));
    assert.equal(body.attendees.at(-1).emailAddress.address,invitation.email);
    if(init.method==="PATCH"){assert.deepEqual(body.attendees[0],{emailAddress:{address:"existing@example.invalid",name:"Existing attendee"},type:"optional"});assert.equal(new Headers(init.headers).get("If-Match"),'W/"v1"');}
    return response({...existing,...body,"@odata.etag":'W/"v2"',onlineMeeting:{joinUrl:"https://teams.microsoft.com/l/meetup-join/test"}});
  },async()=>{
    const provider=createBookingProviderWithAccess(scope,microsoft,{withInvitationWrite:async(effect,send)=>{
      assert.deepEqual(effect,{bookingId:write.bookingId,operationId:write.operationId,...invitation});authorizations++;return send();
    }});
    await provider.create({...write,kind:"teams",invitation});await provider.update({...write,kind:"teams",invitation,eventId:"ms-event",etag:'W/"v1"'});
    assert.equal(writes,2);
  },microsoft);}finally{if(original===undefined)delete process.env.BOOKING_MESSAGES_ENABLED;else process.env.BOOKING_MESSAGES_ENABLED=original;}
});

test("invitation denial is definite before a provider mutation and Google receives no attendee", async () => {
  const microsoft=access("microsoft"), invitation={email:"hello@novalure.eu",name:"Synthetic owner"};
  const original=process.env.BOOKING_MESSAGES_ENABLED;process.env.BOOKING_MESSAGES_ENABLED="1";let calls=0;
  try{await transport(()=>{calls++;return response({});},async()=>{
    await assert.rejects(createBookingProviderWithAccess(scope,microsoft).create({...write,kind:"teams",invitation}),e=>e instanceof BookingProviderError&&e.outcome==="rejected"&&e.code==="booking_invitation_not_authorized");
    const denied=createBookingProviderWithAccess(scope,microsoft,{withInvitationWrite:async()=>{throw new BookingProviderError("BOOKING_INVITATION_CHANGED","rejected");}});
    await assert.rejects(denied.create({...write,kind:"teams",invitation}),e=>e instanceof BookingProviderError&&e.outcome==="rejected");
    process.env.BOOKING_MESSAGES_ENABLED="0";await assert.rejects(denied.create({...write,kind:"teams",invitation}),/booking_invitation_not_authorized/);assert.equal(calls,0);
  },microsoft);
  await transport((_url,init)=>{const body=JSON.parse(String(init.body));assert.equal(body.attendees,undefined);return response(googleEvent());},async()=>{await createBookingProviderWithAccess(scope,access("google")).create({...write,invitation});});
  }finally{if(original===undefined)delete process.env.BOOKING_MESSAGES_ENABLED;else process.env.BOOKING_MESSAGES_ENABLED=original;}
});

test("existing Microsoft attendees cannot bypass message authority on reschedule or cancellation", async()=>{
  const microsoft=access("microsoft"),invitation={email:"hello@novalure.eu",name:"Synthetic owner"};
  const original=process.env.BOOKING_MESSAGES_ENABLED;process.env.BOOKING_MESSAGES_ENABLED="1";let mutations=0;
  const existing={id:"ms-event","@odata.etag":'W/"v1"',start:{dateTime:write.startsAt},end:{dateTime:write.endsAt},
    attendees:[{emailAddress:{address:invitation.email,name:invitation.name},type:"required"}],
    singleValueExtendedProperties:[{id:"String {f0c6c55b-2cda-4365-b7d6-b5d2cd8c6d75} Name NovalureBooking",value:`${scope.workspaceId}:${write.bookingId}`}]};
  try{await transport((_url,init)=>{if(init.method==="GET")return response(existing);mutations++;return new Response(null,{status:204});},async()=>{
    const plain=createBookingProviderWithAccess(scope,microsoft),input={...write,kind:"teams" as const,eventId:"ms-event",etag:'W/"v1"'};
    for(const action of ["update","delete"] as const)await assert.rejects(plain[action](input),e=>e instanceof BookingProviderError&&e.outcome==="rejected"&&e.code==="booking_invitation_not_authorized");
    const denied=createBookingProviderWithAccess(scope,microsoft,{withInvitationWrite:async()=>{throw new BookingProviderError("BOOKING_INVITATION_CHANGED","rejected");}});
    for(const action of ["update","delete"] as const)await assert.rejects(denied[action]({...input,invitation}),e=>e instanceof BookingProviderError&&e.outcome==="rejected");
    process.env.BOOKING_MESSAGES_ENABLED="0";
    for(const action of ["update","delete"] as const)await assert.rejects(denied[action]({...input,invitation}),/booking_invitation_not_authorized/);
    assert.equal(mutations,0);process.env.BOOKING_MESSAGES_ENABLED="1";
    let checked=false;await createBookingProviderWithAccess(scope,microsoft,{withInvitationWrite:async(effect,send)=>{assert.equal(effect.email,invitation.email);checked=true;return send();}}).delete({...input,invitation});
    assert.equal(checked,true);assert.equal(mutations,1);
  },microsoft);}finally{if(original===undefined)delete process.env.BOOKING_MESSAGES_ENABLED;else process.env.BOOKING_MESSAGES_ENABLED=original;}
});

test("Unsupported Teams/Meet capability and protected calendar fail before transport", async () => {
  let calls = 0;
  const microsoft = access("microsoft"); microsoft.calendar.teamsSupported = false;
  await transport(() => { calls++; return response({}); }, async () => {
    await assert.rejects(createBookingProviderWithAccess(scope, microsoft).create({ ...write, kind: "teams" }), /teams_not_supported/);
    const google = access("google"); google.calendar.meetSupported = false;
    await assert.rejects(createBookingProviderWithAccess(scope, google).create(write), /booking_test_binding_missing/);
    microsoft.calendar.protectedReadOnly = true;
    await assert.rejects(createBookingProviderWithAccess(scope, microsoft).create({ ...write, kind: "phone" }), /calendar_read_only/);
    assert.equal(calls, 0);
  }, microsoft);
  const google = access("google"); google.calendar.meetSupported = false;
  await transport(() => { calls++; return response({}); }, async () => {
    await assert.rejects(createBookingProviderWithAccess(scope, google).create(write), /meet_not_supported/); assert.equal(calls, 0);
  });
});

test("Final write gate denies unactivated Production, missing enable and unapproved exact account/calendar", async () => {
  let calls = 0;
  await transport(() => { calls++; return response({}); }, async () => {
    const provider = createBookingProviderWithAccess(scope, access("google"));
    process.env.VERCEL_ENV = "production";
    await assert.rejects(provider.create(write), /BOOKING_NOT_ENABLED/);
    process.env.VERCEL_ENV = "preview"; delete process.env.BOOKING_ENGINE_ENABLED;
    await assert.rejects(provider.create(write), /booking_preview_only/);
    process.env.BOOKING_ENGINE_ENABLED = "1"; process.env.BOOKING_TEST_BINDINGS_JSON = JSON.stringify([{ workspaceId: scope.workspaceId, userId: scope.actorId, provider: "google", accountId: "other-account", calendarId: "test-calendar" }]);
    await assert.rejects(provider.create(write), /booking_test_binding_missing/); assert.equal(calls, 0);
  });
});

test("Google busy expansion handles Vienna DST whole days, exceptions and transparent entries", async () => {
  await transport((url) => {
    assert.equal(url.searchParams.get("singleEvents"), "true"); assert.equal(url.searchParams.get("showDeleted"), "false");
    return response({ timeZone: "Europe/Vienna", items: [
      { id: "all-day", start: { date: "2026-10-25" }, end: { date: "2026-10-26" } },
      { id: "instance-exception", recurringEventId: "series", start: { dateTime: "2026-10-26T13:00:00+01:00" }, end: { dateTime: "2026-10-26T14:00:00+01:00" } },
      { id: "transparent", transparency: "transparent" }, { id: "cancelled-instance", status: "cancelled" },
    ] });
  }, async () => {
    const busy = await createBookingProviderWithAccess(scope, access("google")).listBusy({ startsAt: "2026-10-24T00:00:00Z", endsAt: "2026-10-27T00:00:00Z" });
    assert.equal(busy.length, 2); assert.equal(busy[0].startsAt, "2026-10-24T22:00:00.000Z"); assert.equal(busy[0].endsAt, "2026-10-25T23:00:00.000Z");
    assert.equal(busy[1].startsAt, "2026-10-26T12:00:00.000Z");
  });
});

test("Google read-only conflict calendars use freeBusy without reading event contents", async () => {
  const google = access("google"); google.conflictCalendarIds = ["readonly"];
  google.calendars.push({ ...google.calendar, id: "readonly", canWrite: false, protectedReadOnly: true });
  let freeBusy = 0;
  await transport((url, init) => {
    if (url.pathname.endsWith("/freeBusy")) { freeBusy++; assert.deepEqual(JSON.parse(String(init.body)).items, [{ id: "readonly" }]); return response({ calendars: { readonly: { busy: [{ start: write.startsAt, end: write.endsAt }] } } }); }
    assert.ok(!url.pathname.includes("readonly")); return response({ items: [] });
  }, async () => {
    const busy = await createBookingProviderWithAccess(scope, google).listBusy(write); assert.equal(busy.length, 1); assert.equal(freeBusy, 1);
  });
});

test("Malformed provider busy collections fail closed instead of reporting no conflicts", async () => {
  for (const provider of ["microsoft", "google"] as const) {
    const key = provider === "microsoft" ? "value" : "items";
    for (const payload of [{}, { [key]: null }, { [key]: {} }, { [key]: "invalid" }]) {
      const binding = access(provider);
      await transport(() => response(payload), async () => {
        await assert.rejects(createBookingProviderWithAccess(scope, binding).listBusy(write), /provider_invalid_busy_response/);
      }, binding);
    }
  }
});

test("Malformed continuation or subsequent provider pages cannot truncate availability", async () => {
  for (const provider of ["microsoft", "google"] as const) {
    const key = provider === "microsoft" ? "value" : "items";
    const pageKey = provider === "microsoft" ? "@odata.nextLink" : "nextPageToken";
    for (const next of [null, 7, {}, ""]) {
      const binding = access(provider);
      await transport(() => response({ [key]: [], [pageKey]: next }), async () => {
        await assert.rejects(createBookingProviderWithAccess(scope, binding).listBusy(write), /provider_invalid_page/);
      }, binding);
    }
    let pages = 0; const binding = access(provider);
    await transport(url => {
      if (++pages === 1) return response({ [key]: [], [pageKey]: provider === "microsoft" ? `${url.origin}${url.pathname}?$skiptoken=page2` : "page2" });
      return response({ [key]: null });
    }, async () => {
      await assert.rejects(createBookingProviderWithAccess(scope, binding).listBusy(write), /provider_invalid_busy_response/); assert.equal(pages, 2);
    }, binding);
  }
});

test("Malformed freeBusy errors, ranges and missing calendar cannot claim conflict freedom", async () => {
  const google = access("google"); google.conflictCalendarIds = ["readonly"];
  google.calendars.push({ ...google.calendar, id: "readonly", canWrite: false, protectedReadOnly: true });
  const malformed = [{}, { calendars: {} }, { calendars: { readonly: { busy: null } } }, { calendars: { readonly: { busy: [], errors: {} } } },
    { calendars: { readonly: { busy: [], errors: [{ reason: "forbidden" }] } } },
    { calendars: { readonly: { busy: [{ start: write.endsAt, end: write.startsAt }] } } },
    { calendars: { readonly: { busy: [{ start: write.startsAt }] } } }];
  for (const payload of malformed) await transport(url => response(url.pathname.endsWith("/freeBusy") ? payload : { items: [] }), async () => {
    await assert.rejects(createBookingProviderWithAccess(scope, google).listBusy(write), error => error instanceof BookingProviderError);
  });
});

test("Microsoft calendarView expands recurring instances, follows safe pages and excludes only own selected event", async () => {
  const microsoft = access("microsoft"); let reads = 0;
  await transport((url, init) => {
    reads++; assert.ok(url.pathname.endsWith("/calendarView")); assert.equal(new Headers(init.headers).get("Prefer"), 'outlook.timezone="UTC"');
    if (reads === 1) return response({ value: [{ id: "own", start: { dateTime: "2026-10-26T10:00:00" }, end: { dateTime: "2026-10-26T11:00:00" } }, { showAs: "free" }, { isCancelled: true }], "@odata.nextLink": `${url.origin}${url.pathname}?$skiptoken=page2` });
    return response({ value: [{ id: "recurrence-exception", start: { dateTime: "2026-10-26T12:00:00.0000000" }, end: { dateTime: "2026-10-26T13:00:00.0000000" } }] });
  }, async () => {
    const busy = await createBookingProviderWithAccess(scope, microsoft).listBusy({ ...write, excludeEventId: "own" }); assert.equal(busy.length, 1); assert.equal(busy[0].eventId, "recurrence-exception"); assert.equal(reads, 2);
  }, microsoft);
});

test("Provider-owned lookup denies foreign booking marker and update denies stale etag", async () => {
  let mutations = 0;
  await transport((_url, init) => { if (init.method !== "GET") mutations++; return response(googleEvent({ extendedProperties: { private: { novalureBooking: "foreign:booking" } } })); }, async () => {
    const provider = createBookingProviderWithAccess(scope, access("google"));
    await assert.rejects(provider.update({ ...write, eventId: "foreign-event", etag: '"etag-1"' }), /provider_event_not_owned/);
    await assert.rejects(provider.delete({ ...write, eventId: "foreign-event", etag: '"etag-1"' }), /provider_event_not_owned/);
    assert.equal(mutations, 0);
  });
  await transport((_url, init) => { if (init.method !== "GET") mutations++; return response(googleEvent()); }, async () => {
    await assert.rejects(createBookingProviderWithAccess(scope, access("google")).update({ ...write, eventId: "own-event", etag: '"stale"' }), /provider_event_changed/); assert.equal(mutations, 0);
  });
});

test("Updates/deletes send current If-Match and leave Meet creation request unchanged", async () => {
  let writes = 0;
  await transport((_url, init) => {
    if (init.method === "GET") return response(googleEvent());
    writes++; assert.equal(new Headers(init.headers).get("If-Match"), '"etag-1"');
    if (init.method === "PATCH") { const body = JSON.parse(String(init.body)); assert.equal(body.conferenceData, undefined); return response(googleEvent({ ...body, etag: '"etag-2"' })); }
    assert.equal(init.method, "DELETE"); return new Response(null, { status: 204 });
  }, async () => {
    const provider = createBookingProviderWithAccess(scope, access("google"));
    const event = await provider.update({ ...write, eventId: "own-event", etag: '"etag-1"' }); assert.equal(event.etag, '"etag-2"');
    await provider.delete({ ...write, eventId: "own-event", etag: '"etag-1"' }); assert.equal(writes, 2);
  });
});

test("Untrusted provider pagination never receives the access token", async () => {
  let reads = 0; const microsoft = access("microsoft");
  await transport(() => { reads++; return response({ value: [], "@odata.nextLink": "https://untrusted.invalid/collect" }); }, async () => {
    await assert.rejects(createBookingProviderWithAccess(scope, microsoft).listBusy(write), /provider_invalid_page/); assert.equal(reads, 1);
  }, microsoft);
});

test("A missing previously mapped event reconciles deletion while absent create remains unproven", async () => {
  await transport(() => response({}, 404), async () => {
    const provider = createBookingProviderWithAccess(scope, access("google"));
    const removed = await provider.lookup({ ...write, eventId: "previously-owned-event" });
    assert.equal(removed?.cancelled, true); assert.equal(removed?.eventId, "previously-owned-event");
    assert.equal(await provider.lookup(write), null);
  });
});

test("Successful writes with malformed event times remain unknown for reconciliation", async () => {
  let writes = 0;
  await transport((_url, init) => {
    if (init.method === "GET") return response(googleEvent());
    writes++;
    return response(googleEvent({ start: { dateTime: "invalid-provider-time" } }));
  }, async () => {
    const provider = createBookingProviderWithAccess(scope, access("google"));
    const unknown = (error: unknown) => error instanceof BookingProviderError && error.outcome === "unknown";
    await assert.rejects(provider.create(write), unknown);
    await assert.rejects(provider.update({ ...write, eventId: "own-event", etag: '"etag-1"' }), unknown);
    assert.equal(writes, 2);
    assert.equal((await provider.lookup(write))?.eventId, googleBookingEventId(scope, write.operationId));
    assert.equal(writes, 2);
  });
});

test("Cross-employee access is denied at adapter construction", () => {
  const google = access("google"); google.userId = "other-user";
  assert.throws(() => createBookingProviderWithAccess(scope, google), /connection_actor_mismatch/);
});
