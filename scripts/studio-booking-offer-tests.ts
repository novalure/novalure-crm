import assert from "node:assert/strict";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { startDesignCIntegrationDatabase } from "./lib/design-c-integration-fixture.mjs";
import { getRolePermissions } from "../src/lib/auth/permissions";
import { getProductRoleCapabilities } from "../src/lib/product-model";
import type { AppSession } from "../src/lib/auth/session";
import type { TenantPool } from "../src/lib/db/tenant-client";
import type { BookingProvider, ProviderEvent } from "../src/lib/booking/types";
import type { PublicBookingRecord } from "../src/lib/booking/publication-types";
import { getBookingPublication, getPublicBookingPublication, saveBookingPublication, lookupBookingPublication, prepareBookingPublication } from "../src/lib/booking/publication";
import { issueTrustedBookingChannelSession, startBookingChannelSession, dispatchBookingChannelAction, type BookingChannelOptions } from "../src/lib/booking/channels";
import { dispatchTrustedBookingTool } from "../src/lib/booking/channel-http";
import { handleStudioBookingChannelRequest, studioPublicationForOperation } from "../src/lib/booking/studio-channel";
import { saveBookingRules, bookingAvailabilityStartDate } from "../src/lib/booking/service";
import { defaultBookingRules } from "../src/lib/booking/rules";
import { saveBookingSetup } from "../src/lib/booking/configuration";
import { websiteSalesWorkspaceId } from "../src/lib/website-sales-ingestion";

test("Studio offers only Teams/phone while signed legacy management and another tenant's Meet remain authorized", { timeout: 180_000 }, async t => {
  const db = await startDesignCIntegrationDatabase(), prior = { ...process.env };
  try {
    for (const name of ["108_universal_booking.sql", "109_booking_setup_communications.sql", "111_booking_public_channels.sql"]) {
      const c = await db.admin.connect();
      try { await c.query("begin"); await c.query(await readFile(`migrations/${name}`, "utf8")); await c.query("commit"); }
      catch (e) { await c.query("rollback"); throw e; } finally { c.release(); }
    }
    Object.assign(process.env, { NODE_ENV: "test", DATABASE_URL: `postgresql://${db.role}@127.0.0.1:${db.port}/neondb`, BOOKING_ENGINE_ENABLED: "1", NOVALURE_APP_ORIGIN: "https://crm.example.test", NOVALURE_AUTH_RATE_LIMIT_SECRET: "synthetic-studio-offer-rate-secret-12345678901234567890" });
    for (const key of ["VERCEL_ENV", "VERCEL", "BOOKING_PRODUCTION_ENABLED"]) delete process.env[key];
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    const tracedPool = { async connect() { const client = await db.pool.connect(); return new Proxy(client, { get(target, key) {
      if (key === "query") return (sql: string, params: unknown[] = []) => { queries.push({ sql, params }); return target.query(sql, params); };
      const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
    } }); } } as unknown as TenantPool;
    const pool = { pool: tracedPool };
    async function owner(workspaceId: string, existing = false) {
      const userId = randomUUID(), googleId = randomUUID(), microsoftId = randomUUID(), productRole = existing ? "novalureAdmin" as const : "customer_owner" as const;
      if (!existing) await db.admin.query("insert into workspaces(id,name,operating_model,customer_type) values($1,'SYNTHETIC offer','self_service_customer','general_company')", [workspaceId]);
      await db.admin.query("insert into workspace_users(id,workspace_id,name,email,role,product_role,status) values($1,$2,'SYNTHETIC publisher',$3,'owner',$4,'active')", [userId, workspaceId, `${userId}@example.invalid`, productRole]);
      await db.admin.query("insert into workspace_module_settings(workspace_id,module_key,enabled) values($1,'calendar',true) on conflict(workspace_id,module_key) do update set enabled=true", [workspaceId]);
      for (const [provider, id] of [["google", googleId], ["microsoft", microsoftId]]) await db.admin.query(`insert into booking_calendar_connections(id,workspace_id,user_id,provider,status,account_id,write_calendar_id,calendars) values($1,$2,$3,$4,'connected',$5,$6,$7::jsonb)`, [id, workspaceId, userId, provider, `synthetic-${provider}-${userId}`, `synthetic-calendar-${provider}-${userId}`, JSON.stringify([{ id: `synthetic-calendar-${provider}-${userId}`, name: "PRIVATE fixture", canWrite: true, canRead: true, teamsSupported: provider === "microsoft", meetSupported: provider === "google", protectedReadOnly: false }])]);
      const session: AppSession = { authenticated: true, source: "database", workspaceId, userId, workspaceName: "SYNTHETIC", name: "SYNTHETIC", email: `${userId}@example.invalid`, role: "owner", productRole, permissions: getRolePermissions("owner"), productPermissions: getProductRoleCapabilities(productRole) };
      await saveBookingRules(session, { rules: { timeZone: "UTC", minNoticeMinutes: 0, cancelNoticeMinutes: 0, rescheduleNoticeMinutes: 0, preparationMinutes: 0, followupMinutes: 0, maxAdvanceDays: 366, workingHours: [0, 1, 2, 3, 4, 5, 6].map(day => ({ day, start: "09:00", end: "17:00" })) } }, pool);
      await saveBookingSetup(session, { scope: "company", kind: "*", section: "communication", value: { enabled: false } }, pool);
      const draft = await getBookingPublication(session, pool), assignments = (["meet", "office", "phone", "onsite", "teams"] as const).map(kind => ({ id: randomUUID(), kind, organizerId: userId, provider: kind === "teams" ? "microsoft" as const : "google" as const, ...(kind === "office" ? { publicLocation: "SYNTHETIC office" } : {}) }));
      // Keep public-office publication readiness outside this test; only assigned kinds matter here.
      const publication = { ...draft.publication, enabled: true, language: "en" as const, channels: { ...draft.publication.channels, link: true, chat: true }, assignments: assignments.filter(a => a.kind !== "office"), allowedOrigins: ["https://site.example.test"] };
      await saveBookingPublication(session, { publication: { ...publication, enabled: false }, expectedRevision: 0 }, pool);
      await saveBookingPublication(session, { publication, expectedRevision: 1 }, pool);
      return { session, publication, googleId, microsoftId };
    }
    const a = await owner(websiteSalesWorkspaceId, true), b = await owner(randomUUID()), events = new Map<string, ProviderEvent>();
    let providerCalls = 0, creates = 0;
    const provider: BookingProvider = {
      async listBusy() { providerCalls++; return []; },
      async create(input) { providerCalls++; creates++; const e: ProviderEvent = { eventId: `synthetic-${input.bookingId}`, etag: '"one"', startsAt: input.startsAt, endsAt: input.endsAt, onlineMeetingUrl: "https://meet.google.com/abc-defg-hij", videoStatus: "ready", cancelled: false }; events.set(input.bookingId, e); return e; },
      async lookup(input) { providerCalls++; return events.get(input.bookingId) ?? null; },
      async update(input) { providerCalls++; const e = { ...events.get(input.bookingId)!, startsAt: input.startsAt, endsAt: input.endsAt }; events.set(input.bookingId, e); return e; },
      async delete(input) { providerCalls++; events.set(input.bookingId, { ...events.get(input.bookingId)!, cancelled: true }); },
    };
    const options = { ...pool, providerFactory: async () => provider, connectionResolver: async (_scope: unknown, kind: string) => ({ connectionId: kind === "microsoft" ? a.microsoftId : a.googleId, calendarId: `synthetic-calendar-${kind}-${a.session.userId}`, revision: 1 }) };
    const operationId = randomUUID(), leadId = randomUUID(), contactId = randomUUID(), submissionId = randomUUID(), snapshot = JSON.stringify({ schemaVersion: "studio-enquiry-snapshot-v1", syntheticTest: true }), payloadHash = createHash("sha256").update(snapshot).digest("hex"), reference = "NL-FACE1234";
    await db.admin.query("insert into contacts(id,workspace_id,project_id,name,role,email) values($1,$2,'f7d83c6b-d08d-4d73-b822-1f1c0b4733d2','SYNTHETIC offer','Website Sales','synthetic@example.invalid')", [contactId, websiteSalesWorkspaceId]);
    await db.admin.query("insert into leads(id,workspace_id,project_id,contact_id,type) values($1,$2,'f7d83c6b-d08d-4d73-b822-1f1c0b4733d2',$3,'Website Sales')", [leadId, websiteSalesWorkspaceId, contactId]);
    await db.admin.query("insert into form_submissions(id,workspace_id,project_id,form_id,contact_id,lead_id) values($1,$2,'f7d83c6b-d08d-4d73-b822-1f1c0b4733d2','0f98b9fd-d300-4a34-a14c-54a1a61b2415',$3,$4)", [submissionId, websiteSalesWorkspaceId, contactId, leadId]);
    await db.admin.query("insert into studio_enquiry_transfers(operation_id,workspace_id,revision,payload_hash,snapshot_text,targets,state,reference,lead_id,submission_id,accepted_at) values($1,$2,1,$3,$4,'[]'::jsonb,'accepted',$5,$6,$7,now())", [operationId, websiteSalesWorkspaceId, payloadHash, snapshot, reference, leadId, submissionId]);
    const enquiry = { operationId, revision: 1, payloadHash, crmReference: reference }, relation = { source: "studio_handoff" as const, sourceId: operationId, leadId, contactId }, secret = "synthetic-studio-offer-hmac-secret-12345678901234567890";
    const request = () => new Request("https://crm.example.test/api/public/booking", { method: "POST", headers: { origin: "https://site.example.test" } });
    const signed = async (operation: string, payload: Record<string, unknown>, override: BookingChannelOptions = {}) => { const raw = JSON.stringify({ version: "booking-tools-v1", enquiry, operation, payload, clientIp: "192.0.2.10" }), timestamp = String(Math.floor(Date.now() / 1000)), signature = createHmac("sha256", secret).update(`booking-tools-v1.${timestamp}.${raw}`).digest("base64url"); return handleStudioBookingChannelRequest(new Request("https://crm.example.test/api/integrations/booking/studio", { method: "POST", headers: { "content-type": "application/json", "x-novalure-booking-version": "booking-tools-v1", "x-novalure-timestamp": timestamp, "x-novalure-signature": signature }, body: raw }), { ...options, ...override, env: { NODE_ENV: "test", STUDIO_BOOKING_PUBLIC_ID: a.publication.publicId, STUDIO_ENQUIRY_SIGNING_SECRET: secret } }); };
    const full = await getPublicBookingPublication(a.publication.publicId, "chat", pool), meetId = full.types.find(x => x.kind === "meet")!.id;
    await t.test("publication and issued session expose exactly Teams then phone without mutating the universal publication", async () => {
      const offered = await signed("publication", {}); assert.equal(offered.status, 200); assert.deepEqual((await offered.json()).publication.types.map((x: { kind: string }) => x.kind), ["teams", "phone"]);
      const session = await signed("session", { typeId: full.types.find(x => x.kind === "teams")!.id }); assert.equal(session.status, 200); assert.deepEqual((await session.json()).publication.types.map((x: { kind: string }) => x.kind), ["teams", "phone"]);
      assert(full.types.some(x => x.kind === "meet")); assert.equal(studioPublicationForOperation(full, "cancel"), full); assert.equal(studioPublicationForOperation(full, "status"), full);
      const office = { ...full, types: [...full.types, { ...full.types[0], id: randomUUID(), kind: "office" as const }] }; assert.deepEqual(studioPublicationForOperation(office, "session").types.map(x => x.kind), ["teams", "phone"]);
    });
    const legacy = await issueTrustedBookingChannelSession(request(), { publicId: a.publication.publicId, typeId: meetId, channel: "chat", language: "en", workspaceId: websiteSalesWorkspaceId, bindingId: operationId, relation }, options);
    const date = new Date(Date.now() + 3 * 86400000); date.setUTCHours(10, 0, 0, 0); const startsAt = date.toISOString();
    await t.test("one session request reuses presentation, prepares only two kinds, and reads availability once", async () => {
      const typeId = full.types.find(x => x.kind === "teams")!.id, before = providerCalls;
      queries.length = 0;
      const response = await signed("session", { typeId, initialDate: startsAt.slice(0, 10) }); assert.equal(response.status, 200);
      const result = await response.json(); assert.equal(result.initialAvailability.typeId, typeId); assert.equal(result.initialAvailability.date, startsAt.slice(0, 10)); assert(result.initialAvailability.slots.length > 0);
      const lookups = queries.filter(q => q.sql === "select booking_publication_lookup($1) as publication");
      const setups = queries.filter(q => q.sql.startsWith('select user_id as "userId",kind,travel,communication'));
      assert.equal(lookups.length, 2, "one initial read plus the retained transactional revision read");
      assert.deepEqual(setups.map(q => q.params[2]).sort(), ["phone", "teams", "teams"], "two presentation reads and fresh selected-kind availability rules");
      assert.equal(providerCalls, before + 1); assert.equal(creates, 0);
      queries.length = 0;
      const reuse = await signed("availability", { token: result.token, date: startsAt.slice(0, 10), findNext: true }); assert.equal(reuse.status, 200); assert.equal((await reuse.json()).date, startsAt.slice(0, 10));
      assert.equal(queries.filter(q => q.sql.startsWith('select user_id as "userId",kind,travel,communication')).length, 1, "existing session needs only its current effective rules");
    });
    await t.test("a read failure preserves the granted session and never creates an appointment", async () => {
      const before = creates, response = await signed("session", { typeId: full.types.find(x => x.kind === "teams")!.id, initialDate: startsAt.slice(0, 10) }, { providerFactory: async () => ({ ...provider, async listBusy() { throw new Error("SYNTHETIC_READ_FAILURE"); } }) });
      assert.equal(response.status, 200); const result = await response.json(); assert.match(result.token, /^[A-Za-z0-9_-]{43}$/); assert.equal(result.initialAvailability, undefined); assert.equal(result.initialAvailabilityError.code, "BOOKING_CHANNEL_UNAVAILABLE"); assert.equal(creates, before);
      const recovered = await signed("availability", { token: result.token, date: startsAt.slice(0, 10) }); assert.equal(recovered.status, 200);
      for (const payload of [{ initialDate: "2026-02-30" }, { findNext: true }, { initialDate: startsAt.slice(0, 10), findNext: "true" }]) assert.equal((await signed("session", { typeId: full.types[0].id, ...payload })).status, 400);
    });
    await t.test("manipulated type IDs and legacy Meet tokens cannot open a new Studio booking or availability", async () => {
      for (const type of full.types.filter(x => !["teams", "phone"].includes(x.kind))) { const response = await signed("session", { typeId: type.id }); assert.equal(response.status, 403); }
      const before = providerCalls;
      for (const [operation, payload] of [["availability", { token: legacy.token, date: startsAt.slice(0, 10) }], ["hold", { token: legacy.token, startsAt, recipientEmail: "synthetic@example.invalid", recipientName: "SYNTHETIC", idempotencyKey: randomUUID() }], ["confirm", { token: legacy.token, bookingId: randomUUID(), consent: true, summary: {} }]] as const) { const response = await signed(operation, payload); assert.equal(response.status, 403); }
      assert.equal(providerCalls, before); assert.equal(creates, 0);
    });
    await t.test("a pre-existing authorized Meet booking retains signed status/cancel and tenant isolation", async () => {
      const authority = { publicId: a.publication.publicId, workspaceId: websiteSalesWorkspaceId, bindingId: operationId, relation, typeIds: full.types.map(x => x.id) };
      const held = await dispatchTrustedBookingTool(request(), "chat", authority, { operation: "hold", token: legacy.token, startsAt, recipientEmail: "synthetic@example.invalid", recipientName: "SYNTHETIC", idempotencyKey: randomUUID() }, options) as { booking: PublicBookingRecord };
      const summary = { startsAt: held.booking.startsAt, timeZone: held.booking.timeZone, kind: held.booking.kind, location: held.booking.location };
      await dispatchTrustedBookingTool(request(), "chat", authority, { operation: "confirm", token: legacy.token, bookingId: held.booking.id, consent: true, summary }, options); assert.equal(creates, 1);
      const status = await signed("status", { token: legacy.token, bookingId: held.booking.id }); assert.equal(status.status, 200); assert.equal((await status.json()).booking.kind, "meet");
      const cancelled = await signed("cancel", { token: legacy.token, bookingId: held.booking.id, idempotencyKey: randomUUID(), consent: true, summary }); assert.equal(cancelled.status, 200); assert.equal((await cancelled.json()).booking.state, "cancelled"); assert.equal(creates, 1);
      const other = await startBookingChannelSession(request(), { publicId: b.publication.publicId, typeId: b.publication.assignments.find(x => x.kind === "meet")!.id, channel: "link", language: "en" }, options);
      const otherOptions = { ...options, connectionResolver: async () => ({ connectionId: b.googleId, calendarId: `synthetic-calendar-google-${b.session.userId}`, revision: 1 }) };
      const available = await dispatchBookingChannelAction(other.token, "availability", { date: startsAt.slice(0, 10) }, request(), otherOptions); assert("slots" in available);
      const cross = await signed("status", { token: other.token, bookingId: held.booking.id }); assert.equal(cross.status, 403);
    });
    await t.test("prepared presentation cannot bypass a changed publication, wrong scope, expiry or disabled organizer", async () => {
      const stored = await lookupBookingPublication(a.publication.publicId, pool), prepared = await prepareBookingPublication(stored, "chat", pool, ["teams", "phone"]), typeId = full.types.find(x => x.kind === "teams")!.id;
      const input = { publicId: a.publication.publicId, typeId, channel: "chat" as const, language: "en" as const, workspaceId: websiteSalesWorkspaceId, bindingId: operationId, relation };
      await assert.rejects(issueTrustedBookingChannelSession(request(), { ...input, workspaceId: b.session.workspaceId }, { ...options, preparedPublication: prepared }), /BOOKING_CHANNEL_FORBIDDEN/);
      await db.admin.query("update booking_publications set revision=revision+1 where id=$1", [stored.id]);
      try { await assert.rejects(issueTrustedBookingChannelSession(request(), input, { ...options, preparedPublication: prepared }), /BOOKING_PUBLICATION_CHANGED/); }
      finally { await db.admin.query("update booking_publications set revision=$2 where id=$1", [stored.id, stored.revision]); }
      const issued = await signed("session", { typeId }); const visitor = (await issued.json()).token;
      await db.admin.query("update booking_channel_sessions set expires_at=now()-interval '1 minute' where token_hash=encode(sha256($1::bytea),'hex')", [visitor]);
      assert.equal((await signed("availability", { token: visitor, date: startsAt.slice(0, 10) })).status, 401);
      const active = await signed("session", { typeId }); const activeToken = (await active.json()).token, before = providerCalls;
      await db.admin.query("update workspace_users set status='suspended' where id=$1", [a.session.userId]);
      try { const denied = await signed("availability", { token: activeToken, date: startsAt.slice(0, 10) }); assert(denied.status >= 400); assert.equal(providerCalls, before); }
      finally { await db.admin.query("update workspace_users set status='active' where id=$1", [a.session.userId]); }
    });
  } finally { process.env = prior; await db.stop(); }
});

test("initial date projection honors Dublin workdays, notice, DST and exact explicit dates", () => {
  const rules = { ...defaultBookingRules, timeZone: "Europe/Dublin", minNoticeMinutes: 120 };
  const sunday = Date.parse("2026-10-25T08:00:00Z");
  assert.equal(bookingAvailabilityStartDate("2026-10-25", rules, sunday, true), "2026-10-26");
  assert.equal(bookingAvailabilityStartDate("2026-10-25", rules, sunday), "2026-10-25");
  assert.equal(bookingAvailabilityStartDate("2026-10-30", rules, Date.parse("2026-10-30T16:00:00Z"), true), "2026-11-02");
  assert.equal(bookingAvailabilityStartDate("2027-03-28", rules, Date.parse("2027-03-28T08:00:00Z"), true), "2027-03-29");
  assert.throws(() => bookingAvailabilityStartDate("2026-02-30", rules, sunday, true), /INVALID_DATE/);
});
