import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import type { AppSession } from "../src/lib/auth/session";
import { getRolePermissions } from "../src/lib/auth/permissions";
import { getProductRoleCapabilities } from "../src/lib/product-model";
import type { TenantPool } from "../src/lib/db/tenant-client";
import type { BookingProvider, ProviderEvent, ProviderWrite } from "../src/lib/booking/types";
import type { DrivingRouter } from "../src/lib/booking/travel";
import { saveBookingSetup } from "../src/lib/booking/configuration";
import { cancelBooking, confirmBooking, createBookingHold, getBookingAvailability, rescheduleBooking, saveBookingRules } from "../src/lib/booking/service";
import { startDesignCIntegrationDatabase } from "./lib/design-c-integration-fixture.mjs";

Object.assign(process.env, { NODE_ENV: "test" });
const at = (time: string) => `2026-11-10T${time}:00.000Z`;
const now = Date.parse("2026-11-09T00:00:00Z");
const errorCode = (expected: string) => (error: unknown) => (error as { code?: string }).code === expected;
class TravelProvider implements BookingProvider {
  events = new Map<string, ProviderEvent & { location: string }>();
  creates = 0;
  updates = 0;
  deletes = 0;
  reads = 0;
  async listBusy(input: Parameters<BookingProvider["listBusy"]>[0]) {
    this.reads++;
    return [...this.events.values()].filter(event => !event.cancelled && event.eventId !== input.excludeEventId && Date.parse(event.startsAt) < Date.parse(input.endsAt) && Date.parse(event.endsAt) > Date.parse(input.startsAt))
      .map(event => ({ startsAt: event.startsAt, endsAt: event.endsAt, eventId: event.eventId,
        ...(input.includeLocations ? { calendarId: "synthetic-travel-writer", location: event.location } : {}) }));
  }
  async create(input: ProviderWrite) {
    this.creates++;
    const event = { eventId: `synthetic-${input.bookingId}`, etag: `"${this.creates}"`, startsAt: input.startsAt, endsAt: input.endsAt,
      onlineMeetingUrl: null, videoStatus: "none" as const, cancelled: false, location: input.location };
    this.events.set(input.bookingId, event); return event;
  }
  async lookup(input: { bookingId: string }) { return this.events.get(input.bookingId) ?? null; }
  async update(input: ProviderWrite & { eventId: string; etag: string | null }) {
    this.updates++;
    const event = this.events.get(input.bookingId); assert.ok(event);
    const result = { ...event, startsAt: input.startsAt, endsAt: input.endsAt, location: input.location, etag: `"updated-${this.updates}"` };
    this.events.set(input.bookingId, result); return result;
  }
  async delete(input: { bookingId: string }) { this.deletes++; const event = this.events.get(input.bookingId); assert.ok(event); this.events.set(input.bookingId, { ...event, cancelled: true }); }
}
function actor(workspaceId: string, userId: string): AppSession {
  return { authenticated: true, source: "database", workspaceId, userId, workspaceName: "SYNTHETIC travel QA", name: "SYNTHETIC organizer",
    email: `${userId}@example.invalid`, role: "owner", productRole: "customer_owner", permissions: getRolePermissions("owner"),
    productPermissions: getProductRoleCapabilities("customer_owner"), workspaceCustomerType: "general_company", workspaceOperatingModel: "self_service_customer" };
}

test("travel uses real PostgreSQL actor serialization and durable booking state; all provider ports simulated", { timeout: 240_000 }, async t => {
  const db = await startDesignCIntegrationDatabase();
  try {
    const client = await db.admin.connect();
    try {
      await client.query("begin");
      for (const filename of ["108_universal_booking.sql", "109_booking_setup_communications.sql"]) {
        const sql = await readFile(`migrations/${filename}`, "utf8");
        await client.query(sql);
        await client.query("insert into novalure_schema_migrations(version,name,checksum) values($1,$2,$3)", [filename.replace(/\.sql$/, ""), filename, createHash("sha256").update(sql.replace(/\r\n/g, "\n")).digest("hex")]);
      }
      await client.query("commit");
    } catch (error) { await client.query("rollback"); throw error; } finally { client.release(); }
    const tenant = { workspaceId: randomUUID(), userId: randomUUID(), connectionId: randomUUID() };
    await db.admin.query("insert into workspaces(id,name,operating_model,customer_type) values($1,'SYNTHETIC travel QA','self_service_customer','general_company')", [tenant.workspaceId]);
    await db.admin.query("insert into workspace_users(id,workspace_id,name,email,role,product_role,status) values($1,$2,'SYNTHETIC travel owner',$3,'owner','customer_owner','active')", [tenant.userId, tenant.workspaceId, `${tenant.userId}@example.invalid`]);
    await db.admin.query("insert into workspace_module_settings(workspace_id,module_key,enabled) values($1,'calendar',true)", [tenant.workspaceId]);
    await db.admin.query("insert into booking_calendar_connections(id,workspace_id,user_id,provider,status,account_id,write_calendar_id) values($1,$2,$3,'microsoft','connected','synthetic-travel-account','synthetic-travel-writer')", [tenant.connectionId, tenant.workspaceId, tenant.userId]);
    const session = actor(tenant.workspaceId, tenant.userId), provider = new TravelProvider();
    const calls: Array<Parameters<DrivingRouter>[0]> = [];
    let router: DrivingRouter = async input => { calls.push(input); return { minutes: 15 }; };
    const options = { pool: db.pool as unknown as TenantPool, now: () => now,
      providerFactory: async () => provider,
      connectionResolver: async () => ({ connectionId: tenant.connectionId, calendarId: "synthetic-travel-writer", revision: 1 }),
      drivingRouter: (input: Parameters<DrivingRouter>[0]) => router(input) };
    await saveBookingRules(session, { rules: { timeZone: "UTC", durationMinutes: 30, preparationMinutes: 0, followupMinutes: 0, minNoticeMinutes: 0, cancelNoticeMinutes: 0, rescheduleNoticeMinutes: 0 } }, options);
    await saveBookingSetup(session, { scope: "company", kind: "*", section: "travel", value: {
      enabled: true, startLocationId: "office", endLocationId: "office", onlineLocationId: "office", additionalBufferMinutes: 0,
      directTravel: true, returnToEndLocation: false, maxDriveMinutes: null,
      locations: [{ id: "office", label: "Synthetic office", address: "Synthetic office address", confirmed: true }],
    } }, options);
    const hold = (time: string, location = "Synthetic customer A", customOptions = options) => createBookingHold(session,
      { provider: "microsoft", kind: "onsite", startsAt: at(time), title: "SYNTHETIC TRAVEL QA", idempotencyKey: randomUUID(), location, locationConfirmed: true }, customOptions);
    const expireHeld = () => db.admin.query("update booking_reservations set state='expired' where workspace_id=$1 and state='held'", [tenant.workspaceId]);

    await t.test("concurrent distinct holds cannot both commit using the same stale route context", async () => {
      let entered = 0;
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      router = async () => { entered++; if (entered === 2) release(); await gate; return { minutes: 15 }; };
      const results = await Promise.allSettled([hold("11:00"), hold("12:00")]);
      assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
      const rejected = results.find(result => result.status === "rejected"); assert.ok(rejected?.status === "rejected");
      assert.equal(rejected.reason.code, "TRAVEL_CONTEXT_CHANGED");
      assert.equal(provider.creates, 0);
      router = async input => { calls.push(input); return { minutes: 15 }; };
      await expireHeld();
    });

    await t.test("confirmation rechecks the forecast and refuses a now impossible trip without a provider write", async () => {
      const row = await hold("11:00");
      router = async () => ({ minutes: 600 });
      await assert.rejects(confirmBooking(session, row.id, options), errorCode("TRAVEL_TIME_UNAVAILABLE"));
      assert.equal(provider.creates, 0);
      assert.equal((await db.admin.query("select state from booking_reservations where id=$1", [row.id])).rows[0].state, "held");
      router = async input => { calls.push(input); return { minutes: 15 }; };
      await expireHeld();
    });

    await t.test("a new adjacent hold invalidates confirmation's earlier route snapshot", async () => {
      const row = await hold("11:00");
      let entered!: () => void, release!: () => void;
      const ready = new Promise<void>(resolve => { entered = resolve; });
      const gate = new Promise<void>(resolve => { release = resolve; });
      router = async () => { entered(); await gate; return { minutes: 15 }; };
      const confirmation = confirmBooking(session, row.id, options);
      await ready;
      const otherOptions = { ...options, drivingRouter: async () => ({ minutes: 15 }) };
      await hold("13:00", "Synthetic customer B", otherOptions);
      release();
      await assert.rejects(confirmation, errorCode("TRAVEL_CONTEXT_CHANGED"));
      assert.equal(provider.creates, 0);
      router = async input => { calls.push(input); return { minutes: 15 }; };
      await expireHeld();
    });

    await t.test("daily maximum one permits authorized reschedule availability and excludes the same provider event", async () => {
      await saveBookingRules(session, { kind: "onsite", rules: { maxPerDay: 1 } }, options);
      const row = await hold("11:00");
      const confirmed = await confirmBooking(session, row.id, options);
      assert.equal(confirmed.state, "confirmed");
      const again = await confirmBooking(session, row.id, options);
      assert.equal(again.providerEventId, confirmed.providerEventId);
      assert.equal(provider.creates, 1);
      const ordinary = await getBookingAvailability(session, { provider: "microsoft", kind: "onsite", date: "2026-11-10", location: row.rules.location, locationConfirmed: true }, options);
      assert.equal(ordinary.slots.length, 0);
      const own = await getBookingAvailability(session, { provider: "microsoft", kind: "onsite", date: "2026-11-10", location: row.rules.location, locationConfirmed: true, excludeBookingId: row.id }, options);
      assert.ok(own.slots.some(slot => slot.startsAt === at("13:00")));
      const moved = await rescheduleBooking(session, row.id, { startsAt: at("13:00"), idempotencyKey: randomUUID() }, options);
      assert.equal(moved.state, "confirmed");
      assert.equal(moved.providerEventId, confirmed.providerEventId);
      assert.equal(moved.startsAt, at("13:00"));
      assert.equal(provider.updates, 1);
      await cancelBooking(session, row.id, { idempotencyKey: randomUUID() }, options);
      await saveBookingRules(session, { kind: "onsite", rules: { maxPerDay: null } }, options);
    });

    await t.test("cancelling the middle booking makes the next availability recompute the remaining neighbor chain", async () => {
      const a = await hold("10:00", "Synthetic customer A"); await confirmBooking(session, a.id, options);
      const b = await hold("12:00", "Synthetic customer B"); await confirmBooking(session, b.id, options);
      const c = await hold("15:00", "Synthetic customer C"); await confirmBooking(session, c.id, options);
      calls.length = 0;
      await getBookingAvailability(session, { provider: "microsoft", kind: "onsite", date: "2026-11-10", location: "Synthetic customer D", locationConfirmed: true }, options);
      assert.ok(calls.some(input => input.origin === "Synthetic customer B"));
      await cancelBooking(session, b.id, { idempotencyKey: randomUUID() }, options);
      calls.length = 0;
      await getBookingAvailability(session, { provider: "microsoft", kind: "onsite", date: "2026-11-10", location: "Synthetic customer D", locationConfirmed: true }, options);
      assert.ok(!calls.some(input => input.origin === "Synthetic customer B" || input.destination === "Synthetic customer B"));
      assert.ok(calls.some(input => input.origin === "Synthetic customer A" && input.destination === "Synthetic customer D"));
      assert.ok(calls.some(input => input.origin === "Synthetic customer D" && input.destination === "Synthetic customer C"));
      for (const row of [a, c]) await cancelBooking(session, row.id, { idempotencyKey: randomUUID() }, options);
      assert.ok([...provider.events.values()].every(event => event.cancelled));
    });

    await t.test("unconfirmed addresses and foreign booking exclusions make no provider request", async () => {
      const before = provider.reads;
      const result = await getBookingAvailability(session, { provider: "microsoft", kind: "onsite", date: "2026-11-10", location: "Unconfirmed synthetic address", locationConfirmed: false }, options);
      assert.equal(result.requestFallback, true);
      assert.equal(result.slots.length, 0);
      assert.equal(provider.reads, before);
      const foreign = { workspaceId: randomUUID(), userId: randomUUID(), connectionId: randomUUID() };
      await db.admin.query("insert into workspaces(id,name,operating_model,customer_type) values($1,'SYNTHETIC foreign travel QA','self_service_customer','general_company')", [foreign.workspaceId]);
      await db.admin.query("insert into workspace_users(id,workspace_id,name,email,role,product_role,status) values($1,$2,'SYNTHETIC foreign owner',$3,'owner','customer_owner','active')", [foreign.userId, foreign.workspaceId, `${foreign.userId}@example.invalid`]);
      await db.admin.query("insert into workspace_module_settings(workspace_id,module_key,enabled) values($1,'calendar',true)", [foreign.workspaceId]);
      await db.admin.query("insert into booking_calendar_connections(id,workspace_id,user_id,provider,status,account_id,write_calendar_id) values($1,$2,$3,'microsoft','connected','synthetic-foreign-travel-account','synthetic-foreign-travel-writer')", [foreign.connectionId, foreign.workspaceId, foreign.userId]);
      const foreignHeld = await createBookingHold(actor(foreign.workspaceId, foreign.userId), { provider: "microsoft", kind: "phone", startsAt: at("11:00"), title: "SYNTHETIC FOREIGN QA", idempotencyKey: randomUUID() },
        { ...options, connectionResolver: async () => ({ connectionId: foreign.connectionId, calendarId: "synthetic-foreign-travel-writer", revision: 1 }) });
      const beforeExclusion = provider.reads;
      await assert.rejects(getBookingAvailability(session, { provider: "microsoft", kind: "onsite", date: "2026-11-10", excludeBookingId: foreignHeld.id }, options), errorCode("BOOKING_NOT_FOUND"));
      assert.equal(provider.reads, beforeExclusion);
    });
  } finally { await db.stop(); }
});
