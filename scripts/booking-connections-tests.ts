import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { decryptBookingTokens, discoverBookingCalendars, encryptBookingTokens, isProtectedBookingCalendar,
  bookingMicrosoftAuthority, BookingConnectionError, saveBookingOAuthConnection, selectBookingCalendars,
  getBookingConnection, getBookingCalendarAccess, invalidateBookingConnection, disconnectBookingConnection } from "../src/lib/booking/connections";
import { getOAuthAuthorizationUrl } from "../src/lib/integrations/calendar-connections";
import { closeLocalTestPool } from "../src/lib/db/local-test-transport";
import { startDesignCIntegrationDatabase } from "./lib/design-c-integration-fixture.mjs";
import type { AppSession } from "../src/lib/auth/session";
import { getRolePermissions } from "../src/lib/auth/permissions";
import { getProductRoleCapabilities } from "../src/lib/product-model";
import type { BookingProvider, ProviderEvent } from "../src/lib/booking/types";
import { cancelBooking, confirmBooking, createBookingHold, getBookingStatus, saveBookingRules } from "../src/lib/booking/service";

const scope = {workspaceId:"11111111-1111-4111-8111-111111111111",actorId:"22222222-2222-4222-8222-222222222222"};
const microsoftScopes = ["https://graph.microsoft.com/Calendars.ReadWrite"];
const googleScopes = ["https://www.googleapis.com/auth/calendar"];

test("calendar credentials cannot be moved between tenants, employees or providers",() => {
  const previous = process.env.OAUTH_TOKEN_ENCRYPTION_KEY;
  process.env.OAUTH_TOKEN_ENCRYPTION_KEY = "synthetic-booking-encryption-key-32-bytes-only";
  try {
    const tokens = {accessToken:"synthetic-access",refreshToken:"synthetic-refresh"};
    const encrypted = encryptBookingTokens(scope,"google",tokens);
    assert.doesNotMatch(encrypted,/synthetic-/);
    assert.deepEqual(decryptBookingTokens(scope,"google",encrypted),tokens);
    assert.throws(() => decryptBookingTokens({...scope,workspaceId:"33333333-3333-4333-8333-333333333333"},"google",encrypted));
    assert.throws(() => decryptBookingTokens({...scope,actorId:"44444444-4444-4444-8444-444444444444"},"google",encrypted));
    assert.throws(() => decryptBookingTokens(scope,"microsoft",encrypted));
    const parts = encrypted.split("."); parts[3] = (parts[3][0] === "A" ? "B" : "A")+parts[3].slice(1);
    assert.throws(() => decryptBookingTokens(scope,"google",parts.join(".")));
    delete process.env.OAUTH_TOKEN_ENCRYPTION_KEY;
    assert.throws(() => encryptBookingTokens(scope,"google",tokens),/calendar_encryption_unavailable/);
  } finally { if (previous === undefined) delete process.env.OAUTH_TOKEN_ENCRYPTION_KEY; else process.env.OAUTH_TOKEN_ENCRYPTION_KEY=previous; }
});

test("Microsoft video support needs both granted write scope and actual calendar capability",async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => Response.json({value:[
    {id:"business",name:"Business",canEdit:true,allowedOnlineMeetingProviders:["teamsForBusiness"]},
    {id:"personal",name:"Private Outlook",canEdit:true,allowedOnlineMeetingProviders:["skypeForConsumer"]},
    {id:"read-only",name:"Read only",canEdit:false,allowedOnlineMeetingProviders:["teamsForBusiness"]},
    {id:"grasl",name:"Sekretariat Grasl Immobilien",canEdit:true,allowedOnlineMeetingProviders:["teamsForBusiness"]},
  ]});
  try {
    const calendars = await discoverBookingCalendars("microsoft","synthetic",microsoftScopes);
    assert.equal(calendars[0].teamsSupported,true);
    assert.equal(calendars[1].teamsSupported,false);
    assert.equal(calendars[2].canWrite,false);
    assert.equal(calendars[3].canWrite,false); assert.equal(calendars[3].canRead,true); assert.equal(calendars[3].protectedReadOnly,true);
    assert.equal((await discoverBookingCalendars("microsoft","synthetic",["Calendars.Read"]))[0].teamsSupported,false);
  } finally { globalThis.fetch=original; }
});

test("Google Meet needs provider conference capability and actual calendar write role",async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => Response.json({items:[
    {id:"meet",summary:"Video",accessRole:"owner",conferenceProperties:{allowedConferenceSolutionTypes:["hangoutsMeet"]}},
    {id:"no-meet",summary:"Other",accessRole:"writer"},
    {id:"reader",summary:"Reader",accessRole:"reader",conferenceProperties:{allowedConferenceSolutionTypes:["hangoutsMeet"]}},
    {id:"freebusy",summary:"Conflicts",accessRole:"freeBusyReader"},
  ]});
  try {
    const calendars = await discoverBookingCalendars("google","synthetic",googleScopes);
    assert.equal(calendars[0].meetSupported,true); assert.equal(calendars[1].meetSupported,false);
    assert.equal(calendars[2].meetSupported,false); assert.equal(calendars[3].canRead,true); assert.equal(calendars[3].canWrite,false);
    assert.equal((await discoverBookingCalendars("google","synthetic",["https://www.googleapis.com/auth/calendar.readonly"]))[0].canWrite,false);
  } finally { globalThis.fetch=original; }
});

test("calendar discovery rejects missing pages, revoked access and untrusted pagination links",async () => {
  const original = globalThis.fetch; let calls=0;
  try {
    globalThis.fetch = async () => {calls++;return Response.json({value:[],"@odata.nextLink":"https://attacker.invalid/calendar"});};
    await assert.rejects(discoverBookingCalendars("microsoft","synthetic",microsoftScopes),/calendar_response_invalid/);
    assert.equal(calls,1);
    globalThis.fetch = async () => new Response("Denied",{status:403});
    await assert.rejects(discoverBookingCalendars("google","synthetic",googleScopes),(error:unknown) =>
      error instanceof BookingConnectionError && error.code === "calendar_reauth_required");
    globalThis.fetch = async () => Response.json({});
    await assert.rejects(discoverBookingCalendars("google","synthetic",googleScopes),/calendar_response_invalid/);
    globalThis.fetch = async () => Response.json({items:[],nextPageToken:"still-more"});
    await assert.rejects(discoverBookingCalendars("google","synthetic",googleScopes),/calendar_response_truncated/);
  } finally { globalThis.fetch=original; }
});

test("protected secretariat calendar remains read only with case and whitespace variations",() => {
  assert.equal(isProtectedBookingCalendar("  SEKRETARIAT   Grasl\nImmobilien "),true);
  assert.equal(isProtectedBookingCalendar("Other calendar"),false);
});

test("booking OAuth keeps protected preview callback and external-account authority distinct from legacy app-only configuration",() => {
  const oldClient = process.env.MICROSOFT_CLIENT_ID;
  const oldTenant = process.env.MICROSOFT_TENANT_ID;
  const oldAppUrl = process.env.NEXT_PUBLIC_APP_URL;
  const oldAuthority = process.env.BOOKING_MICROSOFT_AUTHORITY;
  process.env.MICROSOFT_CLIENT_ID = "synthetic-client";
  process.env.MICROSOFT_TENANT_ID = "legacy-single-tenant";
  process.env.NEXT_PUBLIC_APP_URL = "https://production.example.invalid";
  delete process.env.BOOKING_MICROSOFT_AUTHORITY;
  try {
    const preview = "https://protected-preview.example.invalid";
    const input = {provider:"microsoft" as const,state:"synthetic-state",codeChallenge:"synthetic-pkce",requestUrl:preview};
    const booking = new URL(getOAuthAuthorizationUrl({...input,trustedOrigin:preview,microsoftAuthority:bookingMicrosoftAuthority()}));
    assert.equal(booking.pathname,"/common/oauth2/v2.0/authorize");
    assert.equal(booking.searchParams.get("redirect_uri"),`${preview}/api/meetings/oauth/microsoft/callback`);
    const legacy = new URL(getOAuthAuthorizationUrl(input));
    assert.equal(legacy.pathname,"/legacy-single-tenant/oauth2/v2.0/authorize");
    assert.equal(legacy.searchParams.get("redirect_uri"),"https://production.example.invalid/api/meetings/oauth/microsoft/callback");
    process.env.BOOKING_MICROSOFT_AUTHORITY = "../../unexpected";
    assert.throws(() => bookingMicrosoftAuthority(),/calendar_oauth_authority_invalid/);
  } finally {
    for (const [name,value] of [["MICROSOFT_CLIENT_ID",oldClient],["MICROSOFT_TENANT_ID",oldTenant],
      ["NEXT_PUBLIC_APP_URL",oldAppUrl],["BOOKING_MICROSOFT_AUTHORITY",oldAuthority]]) {
      if (value === undefined) delete process.env[name!]; else process.env[name!]=value;
    }
  }
});

test("real PostgreSQL connection lifecycle preserves existing booking bindings across harmless saves, refresh and reauthentication",{timeout:180_000},async () => {
  const db = await startDesignCIntegrationDatabase();
  const originalFetch = globalThis.fetch;
  const originalEnv = {...process.env};
  const actor = {workspaceId:randomUUID(),actorId:randomUUID()};
  let accountId = "synthetic-google-account";
  let refreshes = 0;
  try {
    const client = await db.admin.connect();
    try {
      await client.query("begin");
      for (const name of ["108_universal_booking.sql", "109_booking_setup_communications.sql"]) {
        await client.query(await readFile(`migrations/${name}`, "utf8"));
      }
      await client.query("commit");
    }
    catch(error) { await client.query("rollback");throw error; }
    finally {client.release();}
    await db.admin.query("insert into workspaces(id,name,operating_model,customer_type) values($1,'SYNTHETIC connection lifecycle','self_service_customer','property_developer')",[actor.workspaceId]);
    await db.admin.query("insert into workspace_users(id,workspace_id,name,email,role,product_role,status) values($1,$2,'SYNTHETIC owner','synthetic-connection@example.invalid','owner','customer_owner','active')",[actor.actorId,actor.workspaceId]);
    await db.admin.query("insert into workspace_module_settings(workspace_id,module_key,enabled) values($1,'calendar',true)",[actor.workspaceId]);
    Object.assign(process.env,{NODE_ENV:"test",CRM_LOCAL_TEST_DATABASE:"1"});
    process.env.DATABASE_URL=`postgresql://${db.role}@127.0.0.1:${db.port}/neondb`;
    process.env.OAUTH_TOKEN_ENCRYPTION_KEY="synthetic-connection-lifecycle-encryption-key";
    process.env.GOOGLE_CLIENT_ID="synthetic-google-client";process.env.GOOGLE_CLIENT_SECRET="synthetic-google-secret";
    for (const name of ["VERCEL","VERCEL_ENV","VERCEL_URL"]) delete process.env[name];
    globalThis.fetch = async input => {
      const url = new URL(String(input));
      if (url.pathname === "/oauth2/v3/userinfo") return Response.json({sub:accountId,email:"synthetic-connection@example.invalid"});
      if (url.hostname === "oauth2.googleapis.com") {refreshes++;return Response.json({access_token:"synthetic-refreshed-token",expires_in:3600,scope:googleScopes.join(" ")});}
      if (url.pathname.endsWith("/calendarList")) return Response.json({items:[
        {id:"writer-a",summary:"Writer A",accessRole:"owner"},
        {id:"writer-b",summary:"Writer B",accessRole:"writer"},
        {id:"conflicts",summary:"Conflicts",accessRole:"reader"},
      ]});
      throw new Error(`Unexpected synthetic endpoint: ${url.pathname}`);
    };
    const token = {access_token:"synthetic-original-token",refresh_token:"synthetic-refresh",expires_in:3600,scope:googleScopes.join(" ")};
    const initial = await saveBookingOAuthConnection(actor,"google",token);
    const selected = await selectBookingCalendars(actor,"google",{writeCalendarId:"writer-a",conflictCalendarIds:[]});
    assert.equal(selected.revision,initial.revision+1);
    const same = await selectBookingCalendars(actor,"google",{writeCalendarId:"writer-a",conflictCalendarIds:[]});
    assert.equal(same.revision,selected.revision);
    const extraConflicts = await selectBookingCalendars(actor,"google",{writeCalendarId:"writer-a",conflictCalendarIds:["conflicts"]});
    assert.equal(extraConflicts.revision,selected.revision);
    assert.deepEqual(extraConflicts.conflictCalendarIds,["conflicts"]);
    const reconnected = await saveBookingOAuthConnection(actor,"google",token);
    assert.equal(reconnected.revision,selected.revision);assert.equal(reconnected.writeCalendarId,"writer-a");
    await db.admin.query("update booking_calendar_connections set expires_at=now()-interval '2 minutes' where workspace_id=$1",[actor.workspaceId]);
    const access = await getBookingCalendarAccess(actor,"google");
    assert.equal(access.revision,selected.revision);assert.equal(access.accessToken,"synthetic-refreshed-token");assert.equal(refreshes,1);
    await invalidateBookingConnection(actor,"google",selected.revision,"synthetic-original-token");
    assert.equal((await getBookingConnection(actor,"google"))?.status,"connected");
    await invalidateBookingConnection(actor,"google",selected.revision,access.accessToken);
    const unavailable = await getBookingConnection(actor,"google");
    assert.equal(unavailable?.status,"reauth_required");assert.equal(unavailable?.revision,selected.revision);
    assert.equal((await saveBookingOAuthConnection(actor,"google",token)).revision,selected.revision);
    const bookingSession:AppSession={authenticated:true,source:"database",workspaceId:actor.workspaceId,userId:actor.actorId,
      workspaceName:"SYNTHETIC connection lifecycle",name:"SYNTHETIC owner",email:"synthetic-connection@example.invalid",
      role:"owner",productRole:"customer_owner",permissions:getRolePermissions("owner"),
      productPermissions:getProductRoleCapabilities("customer_owner"),workspaceCustomerType:"property_developer",
      workspaceOperatingModel:"self_service_customer"};
    const events = new Map<string,ProviderEvent>();
    const simulated:BookingProvider={
      async listBusy(){return [];},
      async create(input){const event:ProviderEvent={eventId:`synthetic-${input.bookingId}`,etag:'"synthetic"',startsAt:input.startsAt,
        endsAt:input.endsAt,onlineMeetingUrl:null,videoStatus:"none",cancelled:false};events.set(input.bookingId,event);return event;},
      async lookup(input){return events.get(input.bookingId) ?? null;},
      async update(){throw new Error("unused simulated update");},
      async delete(input){events.set(input.bookingId,{...events.get(input.bookingId)!,cancelled:true});},
    };
    const serviceOptions={providerFactory:async()=>simulated};
    process.env.BOOKING_ENGINE_ENABLED="1";
    await saveBookingRules(bookingSession,{rules:{minNoticeMinutes:0,cancelNoticeMinutes:0,rescheduleNoticeMinutes:0,
      workingHours:[0,1,2,3,4,5,6].map(day=>({day,start:"00:00",end:"23:59"}))}},serviceOptions);
    const startsAt=new Date(Date.now()+2*86_400_000);startsAt.setUTCHours(12,0,0,0);
    const held=await createBookingHold(bookingSession,{provider:"google",kind:"phone",startsAt:startsAt.toISOString(),title:"SYNTHETIC reconnect lifecycle",idempotencyKey:randomUUID()},serviceOptions);
    const bindingInUse=(error:unknown)=>error instanceof BookingConnectionError && error.code==="calendar_binding_in_use";
    await assert.rejects(selectBookingCalendars(actor,"google",{writeCalendarId:"writer-b",conflictCalendarIds:[]}),bindingInUse);
    assert.equal((await confirmBooking(bookingSession,held.id,serviceOptions)).state,"confirmed");
    await assert.rejects(selectBookingCalendars(actor,"google",{writeCalendarId:"writer-b",conflictCalendarIds:[]}),bindingInUse);
    accountId="synthetic-disallowed-account";
    await assert.rejects(saveBookingOAuthConnection(actor,"google",token),bindingInUse);
    accountId="synthetic-google-account";
    await invalidateBookingConnection(actor,"google",selected.revision,token.access_token);
    await assert.rejects(getBookingStatus(bookingSession,held.id,serviceOptions));
    assert.equal((await saveBookingOAuthConnection(actor,"google",token)).revision,selected.revision);
    assert.equal((await getBookingStatus(bookingSession,held.id,serviceOptions)).state,"confirmed");
    await disconnectBookingConnection(actor,"google");
    const disconnected=await getBookingConnection(actor,"google");
    assert.equal(disconnected?.writeCalendarId,"writer-a");assert.equal(disconnected?.revision,selected.revision);
    assert.deepEqual(disconnected?.conflictCalendarIds,["conflicts"]);
    assert.equal((await db.admin.query("select encrypted_tokens from booking_calendar_connections where id=$1",[selected.id])).rows[0].encrypted_tokens,null);
    await assert.rejects(getBookingStatus(bookingSession,held.id,serviceOptions));
    assert.equal((await saveBookingOAuthConnection(actor,"google",token)).revision,selected.revision);
    assert.equal((await getBookingStatus(bookingSession,held.id,serviceOptions)).state,"confirmed");
    assert.equal((await cancelBooking(bookingSession,held.id,{idempotencyKey:randomUUID()},serviceOptions)).state,"cancelled");
    const otherWriter = await selectBookingCalendars(actor,"google",{writeCalendarId:"writer-b",conflictCalendarIds:["conflicts"]});
    assert.equal(otherWriter.revision,selected.revision+1);
    const otherActor = {workspaceId:randomUUID(),actorId:randomUUID()};
    await db.admin.query("insert into workspaces(id,name,operating_model,customer_type) values($1,'SYNTHETIC second connection tenant','self_service_customer','property_developer')",[otherActor.workspaceId]);
    await db.admin.query("insert into workspace_users(id,workspace_id,name,email,role,product_role,status) values($1,$2,'SYNTHETIC second owner','synthetic-second@example.invalid','owner','customer_owner','active')",[otherActor.actorId,otherActor.workspaceId]);
    await db.admin.query("insert into workspace_module_settings(workspace_id,module_key,enabled) values($1,'calendar',true)",[otherActor.workspaceId]);
    await saveBookingOAuthConnection(otherActor,"google",token);
    await disconnectBookingConnection(actor,"google");
    const assigned = (error:unknown) => error instanceof BookingConnectionError && error.code === "calendar_writer_already_assigned" && error.status === 409;
    // Same physical provider account is one person even with a different selected calendar.
    await assert.rejects(selectBookingCalendars(otherActor,"google",{writeCalendarId:"writer-a",conflictCalendarIds:[]}),assigned);
    assert.equal((await getBookingConnection(otherActor,"google"))?.writeCalendarId,null);
    accountId="synthetic-third-account";
    await saveBookingOAuthConnection(otherActor,"google",token);
    // A shared physical write calendar is also one resource across different accounts/tenants.
    await assert.rejects(selectBookingCalendars(otherActor,"google",{writeCalendarId:"writer-b",conflictCalendarIds:[]}),assigned);
    assert.equal((await getBookingConnection(otherActor,"google"))?.writeCalendarId,null);
    accountId="synthetic-google-account";
    assert.equal((await saveBookingOAuthConnection(actor,"google",token)).revision,otherWriter.revision);
    accountId="synthetic-other-account";
    const otherAccount = await saveBookingOAuthConnection(actor,"google",token);
    assert.equal(otherAccount.revision,otherWriter.revision+1);assert.equal(otherAccount.writeCalendarId,null);
    await disconnectBookingConnection(actor,"google");
    assert.equal((await getBookingConnection(actor,"google"))?.revision,otherAccount.revision);
  } finally {
    globalThis.fetch=originalFetch;
    await closeLocalTestPool();
    process.env=originalEnv;
    await db.stop();
  }
});
