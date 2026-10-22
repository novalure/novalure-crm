import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { createBookingProviderWithAccess, BookingProviderError } from "../src/lib/booking/providers";
import { BookingError, type BookingProviderName, type ProviderWrite } from "../src/lib/booking/types";
import { withTenantTransaction, type TenantPool } from "../src/lib/db/tenant-client";
import { startDesignCIntegrationDatabase } from "./lib/design-c-integration-fixture.mjs";

function gate() {
  let entered!: () => void, release!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const waiting = new Promise<void>(resolve => { release = resolve; });
  return { ready, release, async wait() { entered(); await waiting; } };
}

test("provider mutation boundary rechecks live activation and server authorization after owned-event reads", { timeout: 240_000 }, async t => {
  const savedEnv = { ...process.env }, originalFetch = globalThis.fetch;
  const db = await startDesignCIntegrationDatabase();
  try {
    const client = await db.admin.connect();
    try {
      await client.query("begin");
      for (const filename of ["108_universal_booking.sql", "109_booking_setup_communications.sql", "111_booking_public_channels.sql", "112_booking_production_activation.sql"]) {
        const sql = await readFile(`migrations/${filename}`, "utf8"); await client.query(sql);
        await client.query("insert into novalure_schema_migrations(version,name,checksum) values($1,$2,$3)", [filename.slice(0, -4), filename, createHash("sha256").update(sql.replace(/\r\n/g, "\n")).digest("hex")]);
      }
      await client.query("commit");
    } catch (error) { await client.query("rollback"); throw error; } finally { client.release(); }
    const scope = { workspaceId: randomUUID(), actorId: randomUUID() }, cohort = randomUUID(), publicationId = randomUUID();
    const origin = "https://www.novalure-crm.app", activatedAt = new Date(Date.now() - 60_000).toISOString();
    Object.assign(process.env, { NODE_ENV: "test", VERCEL_ENV: "production", BOOKING_ENGINE_ENABLED: "1", BOOKING_PRODUCTION_ENABLED: "1",
      BOOKING_PRODUCTION_ACTIVATION_ID: cohort, BOOKING_PRODUCTION_ACTIVATED_AT: activatedAt, NOVALURE_APP_ORIGIN: origin,
      GOOGLE_CLIENT_ID: "local-fixture", GOOGLE_CLIENT_SECRET: "local-fixture-no-secret", BOOKING_GOOGLE_OAUTH_STATUS: "internal",
      MICROSOFT_CLIENT_ID: "local-fixture", MICROSOFT_CLIENT_SECRET: "local-fixture-no-secret", BOOKING_MICROSOFT_ACCOUNT_TYPE: "organizations_and_personal", BOOKING_MICROSOFT_AUTHORITY: "common" });
    delete process.env.BOOKING_TEST_BINDINGS_JSON; delete process.env.BOOKING_MAIL_TEST_BINDINGS_JSON;
    await db.admin.query("insert into workspaces(id,name,operating_model,customer_type,is_qa) values($1,'Local boundary fixture','self_service_customer','general_company',false)", [scope.workspaceId]);
    await db.admin.query("insert into workspace_users(id,workspace_id,name,email,password_hash,role,product_role,status) values($1,$2,'Local boundary organizer',$3,'local-unusable-fixture-hash','owner','customer_owner','active')", [scope.actorId, scope.workspaceId, `${scope.actorId}@boundary-fixture.novalure.eu`]);
    await db.admin.query("insert into workspace_module_settings(workspace_id,module_key,enabled) values($1,'calendar',true)", [scope.workspaceId]);
    await db.admin.query("insert into booking_publications(id,workspace_id,owner_id,public_id,enabled,config) values($1,$2,$3,$4,true,'{}')", [publicationId, scope.workspaceId, scope.actorId, `bk-${randomUUID()}`]);
    const pool = { pool: db.pool as unknown as TenantPool };
    const accesses = new Map<BookingProviderName, Parameters<typeof createBookingProviderWithAccess>[1]>();
    for (const provider of ["google", "microsoft"] as const) {
      const connectionId = randomUUID(), calendarId = randomUUID(), accountId = randomUUID();
      const calendar = { id: calendarId, name: "Local customer calendar", canRead: true, canWrite: true, protectedReadOnly: false, teamsSupported: provider === "microsoft", meetSupported: provider === "google" };
      const scopes = [provider === "google" ? "https://www.googleapis.com/auth/calendar.events" : "https://graph.microsoft.com/Calendars.ReadWrite"];
      await db.admin.query(`insert into booking_calendar_connections(id,workspace_id,user_id,provider,status,account_id,account_label,encrypted_tokens,scopes,calendars,write_calendar_id)
        values($1,$2,$3,$4,'connected',$5,'Local boundary account','b1.local-nonfunctional-fixture',$6,$7,$8)`, [connectionId, scope.workspaceId, scope.actorId, provider, accountId, scopes, JSON.stringify([calendar]), calendarId]);
      await db.admin.query("select booking_admin_activate_production($1,$2,$3,$4,$5,$6,$7,$8,array['booking'],$9,'internal','Local boundary race fixture')", [cohort, scope.workspaceId, scope.actorId, provider, connectionId, accountId, calendarId, origin, activatedAt]);
      accesses.set(provider, { connectionId, userId: scope.actorId, provider, accountId, accountLabel: "Local boundary account", accessToken: "local-nonfunctional-provider-token", calendarId, calendar, calendars: [calendar], conflictCalendarIds: [], revision: 1 });
    }
    const input: ProviderWrite & { eventId: string; etag: string } = { bookingId: randomUUID(), operationId: randomUUID(), eventId: "local-owned-event", etag: '"one"',
      title: "Local boundary fixture", kind: "phone", location: "", startsAt: "2027-01-12T10:00:00.000Z", endsAt: "2027-01-12T10:30:00.000Z", timeZone: "UTC" };
    const body = (provider: BookingProviderName) => ({ id: input.eventId, ...(provider === "google" ? { etag: input.etag, status: "confirmed",
      extendedProperties: { private: { novalureBooking: `${scope.workspaceId}:${input.bookingId}` } } } : { "@odata.etag": input.etag, isCancelled: false,
      singleValueExtendedProperties: [{ id: "String {f0c6c55b-2cda-4365-b7d6-b5d2cd8c6d75} Name NovalureBooking", value: `${scope.workspaceId}:${input.bookingId}` }] }),
      start: { dateTime: input.startsAt, timeZone: "UTC" }, end: { dateTime: input.endsAt, timeZone: "UTC" } });
    const beforeWrite = () => withTenantTransaction(scope, async tx => {
      await tx.query("select pg_advisory_xact_lock_shared(hashtextextended($1,0))", [`booking-workspace:${scope.workspaceId}`]);
      const row = await tx.queryOne<{ enabled: boolean }>("select enabled from booking_publications where id=$1 and workspace_id=$2 for share", [publicationId, scope.workspaceId]);
      if (!row?.enabled) throw new BookingError("BOOKING_SESSION_INVALID", 401);
    }, pool);
    for (const provider of ["google", "microsoft"] as const) for (const action of ["update", "delete"] as const) for (const revoke of ["activation", "publication"] as const) {
      await t.test(`${provider} ${action}: ${revoke} revoked during owned-event GET prevents mutation`, async () => {
        await db.admin.query("update booking_production_activations set status='active' where activation_id=$1", [cohort]);
        await db.admin.query("update booking_publications set enabled=true where id=$1", [publicationId]);
        const owned = gate(); let reads = 0, mutations = 0;
        globalThis.fetch = async (_url, init = {}) => {
          if ((init.method ?? "GET") === "GET") { reads++; await owned.wait(); return Response.json(body(provider)); }
          mutations++; return Response.json(body(provider));
        };
        const adapter = createBookingProviderWithAccess(scope, accesses.get(provider)!, { ...pool, beforeWrite });
        const pending = action === "update" ? adapter.update(input) : adapter.delete(input);
        await owned.ready;
        if (revoke === "activation") await db.admin.query("update booking_production_activations set status='revoked' where activation_id=$1 and provider=$2", [cohort, provider]);
        else await db.admin.query("update booking_publications set enabled=false where id=$1", [publicationId]);
        owned.release();
        await assert.rejects(pending, (error: unknown) => error instanceof BookingProviderError && error.outcome === "rejected" &&
          error.code === (revoke === "activation" ? "BOOKING_PRODUCTION_ACTIVATION_REQUIRED" : "BOOKING_SESSION_INVALID"));
        assert.equal(reads, 1); assert.equal(mutations, 0);
      });
    }
    await t.test("a mutation already sent returns its known result after a late revocation", async () => {
      await db.admin.query("update booking_production_activations set status='active' where activation_id=$1", [cohort]);
      await db.admin.query("update booking_publications set enabled=true where id=$1", [publicationId]);
      const response = gate(); let mutations = 0;
      globalThis.fetch = async (_url, init = {}) => { assert.equal(init.method, "POST"); mutations++; await response.wait(); return Response.json(body("google")); };
      const adapter = createBookingProviderWithAccess(scope, accesses.get("google")!, { ...pool, beforeWrite });
      const pending = adapter.create(input); await response.ready;
      await db.admin.query("update booking_production_activations set status='revoked' where activation_id=$1", [cohort]);
      await db.admin.query("update booking_publications set enabled=false where id=$1", [publicationId]);
      response.release(); const result = await pending;
      assert.equal(result.eventId, input.eventId); assert.equal(mutations, 1);
    });
  } finally { globalThis.fetch = originalFetch; process.env = savedEnv; await db.stop(); }
});
