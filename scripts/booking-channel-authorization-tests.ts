import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import type { AppSession } from "../src/lib/auth/session";
import { getRolePermissions } from "../src/lib/auth/permissions";
import { getProductRoleCapabilities } from "../src/lib/product-model";
import type { TenantPool, TenantTransaction } from "../src/lib/db/tenant-client";
import { BookingError, type BookingProvider, type ProviderEvent } from "../src/lib/booking/types";
import type { DrivingRouter } from "../src/lib/booking/travel";
import { saveBookingSetup } from "../src/lib/booking/configuration";
import { cancelBooking, confirmBooking, createBookingHold, rescheduleBooking, saveBookingRules, type BookingServiceOptions } from "../src/lib/booking/service";
import { startDesignCIntegrationDatabase } from "./lib/design-c-integration-fixture.mjs";

const now = Date.parse("2026-11-09T00:00:00Z");
const at = (time: string) => `2026-11-10T${time}:00.000Z`;
function gate() {
  let entered!: () => void, release!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const waiting = new Promise<void>(resolve => { release = resolve; });
  return { ready, release, async wait() { entered(); await waiting; } };
}

test("server authorization is fresh after forecasts; completed provider effects survive a late revoke", { timeout: 240_000 }, async t => {
  const savedEnv = { ...process.env };
  const db = await startDesignCIntegrationDatabase();
  try {
    Object.assign(process.env, { NODE_ENV: "test", BOOKING_ENGINE_ENABLED: "1" });
    delete process.env.VERCEL_ENV; delete process.env.BOOKING_PRODUCTION_ENABLED;
    const client = await db.admin.connect();
    try {
      await client.query("begin");
      for (const filename of ["108_universal_booking.sql", "109_booking_setup_communications.sql", "111_booking_public_channels.sql"]) {
        const sql = await readFile(`migrations/${filename}`, "utf8"); await client.query(sql);
        await client.query("insert into novalure_schema_migrations(version,name,checksum) values($1,$2,$3)", [filename.slice(0, -4), filename, createHash("sha256").update(sql.replace(/\r\n/g, "\n")).digest("hex")]);
      }
      await client.query("commit");
    } catch (error) { await client.query("rollback"); throw error; } finally { client.release(); }
    const identity = { workspaceId: randomUUID(), userId: randomUUID(), connectionId: randomUUID(), publicationId: randomUUID(), assignmentId: randomUUID() };
    const session: AppSession = { authenticated: true, source: "database", workspaceId: identity.workspaceId, userId: identity.userId,
      workspaceName: "SYNTHETIC authorization fixture", name: "SYNTHETIC owner", email: "authorization@example.invalid", role: "owner", productRole: "customer_owner",
      permissions: getRolePermissions("owner"), productPermissions: getProductRoleCapabilities("customer_owner"), workspaceCustomerType: "general_company", workspaceOperatingModel: "self_service_customer" };
    await db.admin.query("insert into workspaces(id,name,operating_model,customer_type,is_qa) values($1,'SYNTHETIC authorization fixture','self_service_customer','general_company',true)", [identity.workspaceId]);
    await db.admin.query("insert into workspace_users(id,workspace_id,name,email,role,product_role,status) values($1,$2,'SYNTHETIC owner','authorization@example.invalid','owner','customer_owner','active')", [identity.userId, identity.workspaceId]);
    await db.admin.query("insert into workspace_module_settings(workspace_id,module_key,enabled) values($1,'calendar',true)", [identity.workspaceId]);
    await db.admin.query("insert into booking_calendar_connections(id,workspace_id,user_id,provider,status,account_id,write_calendar_id) values($1,$2,$3,'google','connected','fixture-account','fixture-calendar')", [identity.connectionId, identity.workspaceId, identity.userId]);
    await db.admin.query("insert into booking_publications(id,workspace_id,owner_id,public_id,enabled,config) values($1,$2,$3,$4,true,'{}')", [identity.publicationId, identity.workspaceId, identity.userId, `bk-${randomUUID()}`]);
    await db.admin.query("insert into booking_publication_assignments(id,workspace_id,publication_id,organizer_id,kind,provider) values($1,$2,$3,$4,'onsite','google')", [identity.assignmentId, identity.workspaceId, identity.publicationId, identity.userId]);
    let creates = 0, updates = 0, deletes = 0, beforeCreate: (() => Promise<void>) | undefined;
    let router: DrivingRouter = async () => ({ minutes: 15 });
    const events = new Map<string, ProviderEvent>();
    const provider: BookingProvider = {
      async listBusy() { return []; },
      async lookup(input) { return events.get(input.bookingId) ?? null; },
      async create(input) {
        creates++; await beforeCreate?.();
        const event: ProviderEvent = { eventId: `fixture-${input.bookingId}`, etag: "fixture-etag", startsAt: input.startsAt, endsAt: input.endsAt, onlineMeetingUrl: null, videoStatus: "none", cancelled: false };
        events.set(input.bookingId, event); return event;
      },
      async update(input) { updates++; const event = { ...events.get(input.bookingId)!, startsAt: input.startsAt, endsAt: input.endsAt }; events.set(input.bookingId, event); return event; },
      async delete(input) { deletes++; const event = events.get(input.bookingId)!; events.set(input.bookingId, { ...event, cancelled: true }); },
    };
    let checks = 0;
    const authorize = async (tx: TenantTransaction, fresh: AppSession) => {
      checks++; assert.equal(fresh.workspaceId, identity.workspaceId);
      await tx.query("select pg_advisory_xact_lock_shared(hashtextextended($1,0))", [`booking-workspace:${identity.workspaceId}`]);
      const allowed = await tx.queryOne<{ enabled: boolean }>(`select p.enabled and a.enabled as enabled from booking_publications p
        join booking_publication_assignments a on a.publication_id=p.id and a.workspace_id=p.workspace_id
        where p.id=$1 and p.workspace_id=$2 and a.id=$3 and a.organizer_id=$4 for share of p,a`, [identity.publicationId, identity.workspaceId, identity.assignmentId, identity.userId]);
      if (!allowed?.enabled) throw new BookingError("BOOKING_SESSION_INVALID", 401);
    };
    const options: BookingServiceOptions = { pool: db.pool as unknown as TenantPool, now: () => now, providerFactory: async () => provider,
      connectionResolver: async () => ({ connectionId: identity.connectionId, calendarId: "fixture-calendar", revision: 1 }), drivingRouter: input => router(input), authorize };
    await saveBookingRules(session, { rules: { timeZone: "UTC", durationMinutes: 30, preparationMinutes: 0, followupMinutes: 0, minNoticeMinutes: 0, cancelNoticeMinutes: 0, rescheduleNoticeMinutes: 0 } }, options);
    await saveBookingSetup(session, { scope: "employee", kind: "*", section: "travel", value: { enabled: true, startLocationId: "office", endLocationId: "office", onlineLocationId: "office", additionalBufferMinutes: 0, directTravel: true, returnToEndLocation: false, maxDriveMinutes: null,
      locations: [{ id: "office", label: "Fixture office", address: "Fixture office address", confirmed: true }] } }, options);
    const hold = () => createBookingHold(session, { provider: "google", kind: "onsite", startsAt: at("11:00"), title: "SYNTHETIC authorization", idempotencyKey: randomUUID(), location: "Fixture customer address", locationConfirmed: true }, options);
    const setEnabled = async (enabled: boolean) => {
      const admin = await db.admin.connect();
      try { await admin.query("begin"); await admin.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [`booking-workspace:${identity.workspaceId}`]); await admin.query("update booking_publications set enabled=$2 where id=$1", [identity.publicationId, enabled]); await admin.query("commit"); }
      catch (error) { await admin.query("rollback"); throw error; } finally { admin.release(); }
    };
    const reset = async () => { await setEnabled(true); await db.admin.query("update booking_reservations set state='cancelled' where workspace_id=$1", [identity.workspaceId]); events.clear(); beforeCreate = undefined; router = async () => ({ minutes: 15 }); checks = 0; };
    const state = async (id: string) => (await db.admin.query("select state,provider_event_id from booking_reservations where id=$1", [id])).rows[0];

    await t.test("revocation during hold route probing prevents reservation creation", async () => {
      await reset(); const probe = gate(); router = async () => { await probe.wait(); return { minutes: 15 }; };
      const pending = hold(); await probe.ready; await setEnabled(false); probe.release();
      await assert.rejects(pending, (error: unknown) => (error as BookingError).code === "BOOKING_SESSION_INVALID");
      assert.equal((await db.admin.query("select count(*)::int as n from booking_reservations where workspace_id=$1", [identity.workspaceId])).rows[0].n, 0);
      assert.equal(creates, 0); assert.equal(checks, 1);
    });
    await t.test("revocation during initial confirmation forecast prevents operation claim", async () => {
      await reset(); const row = await hold(), probe = gate(); router = async () => { await probe.wait(); return { minutes: 15 }; };
      const pending = confirmBooking(session, row.id, options); await probe.ready; await setEnabled(false); probe.release();
      await assert.rejects(pending, (error: unknown) => (error as BookingError).code === "BOOKING_SESSION_INVALID");
      assert.equal((await state(row.id)).state, "held"); assert.equal(creates, 0);
      assert.equal((await db.admin.query("select count(*)::int as n from booking_operations where booking_id=$1", [row.id])).rows[0].n, 0);
    });
    await t.test("revocation during final forecast is a known rejected write, never an uncertain booking", async () => {
      await reset(); const row = await hold(), probe = gate(); let routes = 0;
      router = async () => { if (++routes === 2) await probe.wait(); return { minutes: 15 }; };
      const pending = confirmBooking(session, row.id, options); await probe.ready; await setEnabled(false); probe.release();
      const result = await pending; assert.equal(result.state, "expired"); assert.equal(creates, 0);
      const operation = (await db.admin.query("select state,error_code from booking_operations where booking_id=$1", [row.id])).rows[0];
      assert.equal(operation.state, "rejected"); assert.equal(operation.error_code, "BOOKING_SESSION_INVALID");
    });
    await t.test("a known provider result is persisted even when the publication is revoked while the request is in flight", async () => {
      await reset(); const row = await hold(), response = gate(); beforeCreate = () => response.wait();
      const pending = confirmBooking(session, row.id, options); await response.ready; await setEnabled(false); response.release();
      const result = await pending; assert.equal(result.state, "confirmed"); assert.equal(result.providerEventId, `fixture-${row.id}`); assert.equal(creates, 1);
      assert.equal((await state(row.id)).state, "confirmed");
      assert.equal((await db.admin.query("select state from booking_operations where booking_id=$1", [row.id])).rows[0].state, "succeeded");
      assert.equal(checks, 3, "hold, confirmation claim and pre-provider guard only; no guard on result persistence");
    });
    await t.test("reschedule and cancellation recheck the same guard before claiming an operation", async () => {
      await reset(); const row = await confirmBooking(session, (await hold()).id, options); await setEnabled(false);
      await assert.rejects(rescheduleBooking(session, row.id, { startsAt: at("13:00"), idempotencyKey: randomUUID() }, options), (error: unknown) => (error as BookingError).code === "BOOKING_SESSION_INVALID");
      await assert.rejects(cancelBooking(session, row.id, { idempotencyKey: randomUUID() }, options), (error: unknown) => (error as BookingError).code === "BOOKING_SESSION_INVALID");
      assert.equal(updates, 0); assert.equal(deletes, 0); assert.equal((await state(row.id)).state, "confirmed");
    });
  } finally { process.env = savedEnv; await db.stop(); }
});
