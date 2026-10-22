import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { assertBookingActivation, listProductionBookingBindings } from "../src/lib/booking/activation";
import { bookingOAuthReadiness, bookingProductionOrigin, bookingRuntimeMode } from "../src/lib/booking/runtime";
import { createBookingProviderWithAccess } from "../src/lib/booking/providers";
import type { TenantPool } from "../src/lib/db/tenant-client";
import { withTenantTransaction } from "../src/lib/db/tenant-client";
import { startDesignCIntegrationDatabase } from "./lib/design-c-integration-fixture.mjs";

const activationId = randomUUID();
const cutoff = new Date(Date.now() - 120_000).toISOString();
const productionEnv = (): NodeJS.ProcessEnv => ({ NODE_ENV: "production", VERCEL_ENV: "production", BOOKING_ENGINE_ENABLED: "1",
  BOOKING_PRODUCTION_ENABLED: "1", BOOKING_PRODUCTION_ACTIVATION_ID: activationId, BOOKING_PRODUCTION_ACTIVATED_AT: cutoff,
  NOVALURE_APP_ORIGIN: "https://www.novalure-crm.app", GOOGLE_CLIENT_ID: "local-fixture-client", GOOGLE_CLIENT_SECRET: "local-fixture-secret",
  BOOKING_GOOGLE_OAUTH_STATUS: "internal" });
const code = (expected: string) => (error: unknown) => (error as { code?: string }).code === expected;

test("production runtime requires the explicit cohort, cutoff and configured HTTPS authority; no host fallback", () => {
  assert.equal(bookingRuntimeMode(productionEnv()), "production");
  for (const name of ["BOOKING_ENGINE_ENABLED", "BOOKING_PRODUCTION_ENABLED", "BOOKING_PRODUCTION_ACTIVATION_ID", "BOOKING_PRODUCTION_ACTIVATED_AT", "NOVALURE_APP_ORIGIN"]) {
    const env = productionEnv(); delete env[name]; env.NEXT_PUBLIC_APP_URL = "https://www.novalure-crm.app"; env.VERCEL_PROJECT_PRODUCTION_URL = "www.novalure-crm.app";
    assert.equal(bookingRuntimeMode(env), "disabled", name);
  }
  for (const origin of ["http://www.novalure-crm.app", "https://www.novalure-crm.app/path", "https://user:secret@www.novalure-crm.app", "https://localhost", "https://127.0.0.1", "https://booking.example.invalid", "https://www.novalure-crm.app?x=1"]) {
    assert.equal(bookingProductionOrigin({ NODE_ENV: "test", NOVALURE_APP_ORIGIN: origin }), null);
  }
  assert.equal(bookingRuntimeMode({ ...productionEnv(), BOOKING_PRODUCTION_ACTIVATED_AT: new Date(Date.now() + 60_000).toISOString() }), "disabled");
  assert.equal(bookingRuntimeMode({ ...productionEnv(), VERCEL_ENV: "preview" }), "disabled");
  assert.equal(bookingRuntimeMode({ ...productionEnv(), VERCEL_ENV: undefined }), "disabled");
});

test("production rejects presence of either QA binding variable, including an empty value", () => {
  for (const name of ["BOOKING_TEST_BINDINGS_JSON", "BOOKING_MAIL_TEST_BINDINGS_JSON"]) {
    for (const value of ["", "[]", "{}"] ) assert.equal(bookingRuntimeMode({ ...productionEnv(), [name]: value }), "disabled");
  }
  assert.equal(bookingRuntimeMode({ NODE_ENV: "test", VERCEL_ENV: "preview", BOOKING_ENGINE_ENABLED: "1", BOOKING_TEST_BINDINGS_JSON: "[]" }), "preview");
  assert.equal(bookingRuntimeMode({ NODE_ENV: "test", BOOKING_ENGINE_ENABLED: "1" }), "preview");
});

test("OAuth readiness never equates credentials or Google test users with external customer approval", () => {
  const google = productionEnv();
  assert.equal(bookingOAuthReadiness("google", google).externalCustomerReady, false);
  assert.equal(bookingOAuthReadiness("google", { ...google, BOOKING_GOOGLE_OAUTH_STATUS: "testing", BOOKING_GOOGLE_EXTERNAL_OAUTH_VERIFIED: "1" }).externalCustomerReady, false);
  assert.equal(bookingOAuthReadiness("google", { ...google, BOOKING_GOOGLE_OAUTH_STATUS: "production" }).externalCustomerReady, false);
  assert.equal(bookingOAuthReadiness("google", { ...google, BOOKING_GOOGLE_OAUTH_STATUS: "production", BOOKING_GOOGLE_EXTERNAL_OAUTH_VERIFIED: "1" }).externalCustomerReady, true);
  const microsoft: NodeJS.ProcessEnv = { NODE_ENV: "test", MICROSOFT_CLIENT_ID: "fixture-client", MICROSOFT_CLIENT_SECRET: "fixture-secret", BOOKING_MICROSOFT_EXTERNAL_OAUTH_VERIFIED: "1" };
  for (const [accountType, authority] of [["organizations", "organizations"], ["organizations_and_personal", "common"], ["personal", "consumers"]]) {
    assert.equal(bookingOAuthReadiness("microsoft", { ...microsoft, BOOKING_MICROSOFT_ACCOUNT_TYPE: accountType, BOOKING_MICROSOFT_AUTHORITY: authority }).externalCustomerReady, true);
  }
  assert.equal(bookingOAuthReadiness("microsoft", microsoft).externalCustomerReady, false);
  assert.equal(bookingOAuthReadiness("microsoft", { ...microsoft, BOOKING_MICROSOFT_ACCOUNT_TYPE: "organizations", BOOKING_MICROSOFT_AUTHORITY: "common" }).authorityCompatible, false);
  assert.equal(bookingOAuthReadiness("microsoft", { ...microsoft, BOOKING_MICROSOFT_ACCOUNT_TYPE: "single_tenant", BOOKING_MICROSOFT_AUTHORITY: randomUUID() }).externalCustomerReady, false);
});

test("unactivated production blocks every direct provider operation before transport", async () => {
  const originalEnv = { ...process.env }, originalFetch = globalThis.fetch;
  let calls = 0;
  try {
    Object.assign(process.env, productionEnv(), { BOOKING_PRODUCTION_ENABLED: "0" });
    globalThis.fetch = async () => { calls++; throw new Error("Unexpected transport"); };
    const scope = { workspaceId: randomUUID(), actorId: randomUUID() };
    const calendar = { id: "fixture-calendar", name: "Fixture calendar", canRead: true, canWrite: true, protectedReadOnly: false, teamsSupported: false, meetSupported: true };
    const provider = createBookingProviderWithAccess(scope, { connectionId: randomUUID(), userId: scope.actorId, provider: "google", accessToken: "local-fixture-no-provider-token",
      calendarId: calendar.id, conflictCalendarIds: [], calendar, calendars: [calendar], accountId: "fixture-account", accountLabel: "Fixture", revision: 1 });
    const write = { bookingId: randomUUID(), operationId: randomUUID(), title: "Local fixture", startsAt: "2027-01-12T10:00:00Z", endsAt: "2027-01-12T10:30:00Z", timeZone: "UTC", kind: "phone" as const, location: "" };
    await assert.rejects(provider.listBusy(write), code("BOOKING_NOT_ENABLED"));
    await assert.rejects(provider.lookup(write), code("BOOKING_NOT_ENABLED"));
    await assert.rejects(provider.create(write), code("BOOKING_NOT_ENABLED"));
    await assert.rejects(provider.update({ ...write, eventId: "fixture-event", etag: null }), code("BOOKING_NOT_ENABLED"));
    await assert.rejects(provider.delete({ ...write, eventId: "fixture-event", etag: null }), code("BOOKING_NOT_ENABLED"));
    assert.equal(calls, 0);
  } finally { process.env = originalEnv; globalThis.fetch = originalFetch; }
});

test("production registry uses real isolated PostgreSQL roles and current bindings; no provider calls", { timeout: 240_000 }, async t => {
  const db = await startDesignCIntegrationDatabase();
  try {
    const client = await db.admin.connect();
    try {
      await client.query("begin");
      for (const filename of ["108_universal_booking.sql", "109_booking_setup_communications.sql", "112_booking_production_activation.sql"]) {
        const sql = await readFile(`migrations/${filename}`, "utf8"); await client.query(sql);
        await client.query("insert into novalure_schema_migrations(version,name,checksum) values($1,$2,$3)", [filename.replace(/\.sql$/, ""), filename, createHash("sha256").update(sql.replace(/\r\n/g, "\n")).digest("hex")]);
      }
      await client.query("commit");
    } catch (error) { await client.query("rollback"); throw error; } finally { client.release(); }
    const env = productionEnv(), options = { pool: db.pool as unknown as TenantPool, env };
    const seed = async () => {
      const scope = { workspaceId: randomUUID(), actorId: randomUUID() };
      const binding = { provider: "google" as const, connectionId: randomUUID(), accountId: randomUUID(), calendarId: randomUUID() };
      const calendar = { id: binding.calendarId, name: "Customer appointments", canRead: true, canWrite: true, protectedReadOnly: false, teamsSupported: false, meetSupported: true };
      await db.admin.query("insert into workspaces(id,name,operating_model,customer_type) values($1,'Activation fixture','self_service_customer','general_company')", [scope.workspaceId]);
      await db.admin.query("insert into workspace_users(id,workspace_id,name,email,password_hash,role,product_role,status) values($1,$2,'Fixture owner',$3,'local-fixture-unusable-hash','owner','customer_owner','active')", [scope.actorId, scope.workspaceId, `${scope.actorId}@booking-fixture.novalure.eu`]);
      await db.admin.query("insert into workspace_module_settings(workspace_id,module_key,enabled) values($1,'calendar',true)", [scope.workspaceId]);
      await db.admin.query(`insert into booking_calendar_connections(id,workspace_id,user_id,provider,status,account_id,account_label,encrypted_tokens,scopes,calendars,write_calendar_id)
        values($1,$2,$3,'google','connected',$4,'Fixture account','b1.local-fixture-no-credentials',array['https://www.googleapis.com/auth/calendar.events'],$5,$6)`, [binding.connectionId, scope.workspaceId, scope.actorId, binding.accountId, JSON.stringify([calendar]), binding.calendarId]);
      return { scope, binding, calendar };
    };
    const a = await seed(), b = await seed();
    const activate = async (identity = a, capabilities = ["booking", "messages"], audience = "internal", activatedAt = cutoff) => {
      return (await db.admin.query(`select booking_admin_activate_production($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'Local isolated role-boundary fixture') as id`,
        [activationId, identity.scope.workspaceId, identity.scope.actorId, identity.binding.provider, identity.binding.connectionId, identity.binding.accountId, identity.binding.calendarId,
          env.NOVALURE_APP_ORIGIN, capabilities, activatedAt, audience])).rows[0].id as string;
    };
    await t.test("an empty registry grants nothing; the runtime cannot self-activate or write registry rows", async () => {
      await assert.rejects(assertBookingActivation(a.scope, a.binding, options), code("BOOKING_PRODUCTION_ACTIVATION_REQUIRED"));
      await assert.rejects(withTenantTransaction(a.scope, tx => tx.query("select booking_admin_activate_production($1,$2,$3,'google',$4,$5,$6,$7,array['booking'],now(),'internal','Self approval')", [activationId, a.scope.workspaceId, a.scope.actorId, a.binding.connectionId, a.binding.accountId, a.binding.calendarId, env.NOVALURE_APP_ORIGIN]), options), code("42501"));
      await assert.rejects(withTenantTransaction(a.scope, tx => tx.execute("update booking_production_activations set status='active'"), options), code("42501"));
    });
    await activate(a); await activate(b, ["booking"]);
    await t.test("one release cohort supports multiple exact tenants and capability-bounded scheduler enumeration", async () => {
      const row = await assertBookingActivation(a.scope, a.binding, options); assert.equal(row?.workspaceId, a.scope.workspaceId); assert.equal(row?.accountId, a.binding.accountId);
      assert.equal((await listProductionBookingBindings(options)).length, 2);
      assert.equal((await listProductionBookingBindings({ ...options, capability: "messages" })).length, 1);
      assert.equal((await listProductionBookingBindings({ ...options, limit: 1 })).length, 1);
      await assert.rejects(listProductionBookingBindings({ ...options, limit: 1001 }), code("INVALID_ACTIVATION_LIMIT"));
      await assert.rejects(assertBookingActivation(b.scope, b.binding, { ...options, capability: "messages" }), code("BOOKING_PRODUCTION_ACTIVATION_REQUIRED"));
    });
    await t.test("foreign actor, account, calendar, connection, cohort and origin never match", async () => {
      for (const binding of [{ ...a.binding, accountId: randomUUID() }, { ...a.binding, calendarId: randomUUID() }, { ...a.binding, connectionId: randomUUID() }])
        await assert.rejects(assertBookingActivation(a.scope, binding, options), code("BOOKING_PRODUCTION_ACTIVATION_REQUIRED"));
      await assert.rejects(assertBookingActivation(b.scope, a.binding, options), code("BOOKING_PRODUCTION_ACTIVATION_REQUIRED"));
      await assert.rejects(assertBookingActivation(a.scope, a.binding, { ...options, env: { ...env, BOOKING_PRODUCTION_ACTIVATION_ID: randomUUID() } }), code("BOOKING_PRODUCTION_ACTIVATION_REQUIRED"));
      await assert.rejects(assertBookingActivation(a.scope, a.binding, { ...options, env: { ...env, NOVALURE_APP_ORIGIN: "https://different.novalure-crm.app" } }), code("BOOKING_PRODUCTION_ACTIVATION_REQUIRED"));
    });
    await t.test("token refresh and a metadata revision preserve approval; disconnect or resource changes deny it", async () => {
      await db.admin.query("update booking_calendar_connections set encrypted_tokens='b1.rotated-local-fixture',revision=revision+1 where id=$1", [a.binding.connectionId]);
      assert.ok(await assertBookingActivation(a.scope, a.binding, options));
      for (const [column, value, restore] of [["status", "disconnected", "connected"], ["account_id", "different-account", a.binding.accountId], ["write_calendar_id", "different-calendar", a.binding.calendarId]]) {
        await db.admin.query(`update booking_calendar_connections set ${column}=$2 where id=$1`, [a.binding.connectionId, value]);
        await assert.rejects(assertBookingActivation(a.scope, a.binding, options), code("BOOKING_PRODUCTION_ACTIVATION_REQUIRED"));
        await db.admin.query(`update booking_calendar_connections set ${column}=$2 where id=$1`, [a.binding.connectionId, restore]);
      }
    });
    await t.test("current selected calendar permissions, scope and conflict reads are rechecked", async () => {
      for (const calendar of [{ ...a.calendar, canWrite: false }, { ...a.calendar, canRead: false }, { ...a.calendar, protectedReadOnly: true }, { ...a.calendar, name: "Sekretariat Grasl Immobilien" }]) {
        await db.admin.query("update booking_calendar_connections set calendars=$2 where id=$1", [a.binding.connectionId, JSON.stringify([calendar])]);
        await assert.rejects(assertBookingActivation(a.scope, a.binding, options), code("BOOKING_PRODUCTION_ACTIVATION_REQUIRED"));
      }
      await db.admin.query("update booking_calendar_connections set calendars=$2,conflict_calendar_ids=array['missing-readable-conflict'] where id=$1", [a.binding.connectionId, JSON.stringify([a.calendar])]);
      await assert.rejects(assertBookingActivation(a.scope, a.binding, options), code("BOOKING_PRODUCTION_ACTIVATION_REQUIRED"));
      await db.admin.query("update booking_calendar_connections set conflict_calendar_ids='{}',scopes='{}' where id=$1", [a.binding.connectionId]);
      await assert.rejects(assertBookingActivation(a.scope, a.binding, options), code("BOOKING_PRODUCTION_ACTIVATION_REQUIRED"));
      await db.admin.query("update booking_calendar_connections set scopes=array['https://www.googleapis.com/auth/calendar.events'] where id=$1", [a.binding.connectionId]);
    });
    await t.test("QA workspace, synthetic identity and revoked module/member cannot be activated or reused", async () => {
      await db.admin.query("update workspaces set is_qa=true where id=$1", [a.scope.workspaceId]);
      await assert.rejects(activate(a), code("42501"));
      await assert.rejects(assertBookingActivation(a.scope, a.binding, options), code("BOOKING_PRODUCTION_ACTIVATION_REQUIRED"));
      await db.admin.query("update workspaces set is_qa=false where id=$1", [a.scope.workspaceId]);
      await db.admin.query("update workspace_users set name='SYNTHETIC fixture owner' where id=$1", [a.scope.actorId]);
      await assert.rejects(activate(a), code("42501"));
      await db.admin.query("update workspace_users set name='Fixture owner',status='invited' where id=$1", [a.scope.actorId]);
      await assert.rejects(assertBookingActivation(a.scope, a.binding, options), code("BOOKING_PRODUCTION_ACTIVATION_REQUIRED"));
      await db.admin.query("update workspace_users set status='active' where id=$1", [a.scope.actorId]);
      await db.admin.query("update workspace_module_settings set enabled=false where workspace_id=$1 and module_key='calendar'", [a.scope.workspaceId]);
      await assert.rejects(assertBookingActivation(a.scope, a.binding, options), code("BOOKING_PRODUCTION_ACTIVATION_REQUIRED"));
      await db.admin.query("update workspace_module_settings set enabled=true where workspace_id=$1 and module_key='calendar'", [a.scope.workspaceId]);
    });
    await t.test("cutoff preserves milliseconds and owner revocation is durable", async () => {
      const rowCutoff = new Date(Date.now() - 60_000); rowCutoff.setUTCMilliseconds(987);
      const id = await activate(a, ["booking", "messages"], "internal", rowCutoff.toISOString());
      const activation = await assertBookingActivation(a.scope, a.binding, options); assert.equal(activation?.activatedAt, rowCutoff.toISOString());
      await db.admin.query("select booking_admin_revoke_production($1,'Explicit fixture revocation')", [id]);
      await assert.rejects(assertBookingActivation(a.scope, a.binding, options), code("BOOKING_PRODUCTION_ACTIVATION_REQUIRED"));
      assert.equal((await listProductionBookingBindings({ ...options, capability: "messages" })).length, 0);
      await activate(a);
    });
    await t.test("external-customer rows require separately verified provider readiness", async () => {
      await activate(a, ["booking"], "external_customers");
      await assert.rejects(assertBookingActivation(a.scope, a.binding, options), code("BOOKING_OAUTH_CONFIGURATION_REQUIRED"));
      assert.equal((await listProductionBookingBindings(options)).length, 1);
      const verified = { ...options, env: { ...env, BOOKING_GOOGLE_OAUTH_STATUS: "production", BOOKING_GOOGLE_EXTERNAL_OAUTH_VERIFIED: "1" } };
      assert.ok(await assertBookingActivation(a.scope, a.binding, verified));
      await assert.rejects(assertBookingActivation(a.scope, a.binding, { ...options, env: { ...env, BOOKING_GOOGLE_OAUTH_STATUS: undefined } }), code("BOOKING_OAUTH_CONFIGURATION_REQUIRED"));
    });
    await t.test("preview assertion does not query production schema or grant a production binding", async () => {
      let calls = 0;
      const tx = { query: async () => { calls++; return []; }, queryOne: async () => { calls++; return null; }, execute: async () => { calls++; } };
      assert.equal(await assertBookingActivation(a.scope, a.binding, { env: { NODE_ENV: "test", VERCEL_ENV: "preview", BOOKING_ENGINE_ENABLED: "1" }, tx }), null);
      assert.equal(calls, 0);
    });
  } finally { await db.stop(); }
});
