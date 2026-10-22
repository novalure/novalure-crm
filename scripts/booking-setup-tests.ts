import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import type { AppSession } from "../src/lib/auth/session";
import { getRolePermissions } from "../src/lib/auth/permissions";
import { getProductRoleCapabilities } from "../src/lib/product-model";
import { withTenantTransaction } from "../src/lib/db/tenant-client";
import { closeLocalTestPool } from "../src/lib/db/local-test-transport";
import { getBookingSetup, readBookingSetup, saveBookingSetup, validateBookingSetupMutation, validateBookingTravelSettings } from "../src/lib/booking/configuration";
import { bookingResourceLock, readRules } from "../src/lib/booking/repository";
import { BookingError } from "../src/lib/booking/types";
import { defaultBookingCommunication } from "../src/lib/booking/templates";
import { defaultBookingTravelSettings } from "../src/lib/booking/setup-types";
import { listBookingPropertyLocations, resolveBookingPropertyLocation } from "../src/lib/booking/property-locations";
import { startDesignCIntegrationDatabase } from "./lib/design-c-integration-fixture.mjs";

test("setup validation rejects unknown scope, fields, ambiguous places and executable template content", () => {
  assert.throws(() => validateBookingSetupMutation({ scope: "company", kind: "*", section: "travel", value: {}, workspaceId: randomUUID() }), /INVALID_BOOKING_SETUP/);
  assert.throws(() => validateBookingSetupMutation({ scope: "employee", kind: "*", section: "travel", value: {}, expectedRevision: -1 }), /INVALID_BOOKING_SETUP/);
  assert.throws(() => validateBookingTravelSettings({ ...defaultBookingTravelSettings, enabled: true }), /TRAVEL_LOCATION_REQUIRED/);
  assert.throws(() => validateBookingTravelSettings({ ...defaultBookingTravelSettings, additionalBufferMinutes: 241 }), /INVALID_TRAVEL_SETTINGS/);
  assert.throws(() => validateBookingTravelSettings({ ...defaultBookingTravelSettings, startLocationId: "missing" }), /INVALID_TRAVEL_LOCATION_REFERENCE/);
});

test("real PostgreSQL setup stores four layers, dynamic company resets, protected configuration and forced tenant isolation", { timeout: 180_000 }, async t => {
  const db = await startDesignCIntegrationDatabase();
  const prior = { ...process.env };
  try {
    for (const file of ["108_universal_booking.sql", "109_booking_setup_communications.sql"]) {
      const client = await db.admin.connect();
      try { await client.query("begin"); await client.query(await readFile(`migrations/${file}`, "utf8")); await client.query("commit"); }
      catch (error) { await client.query("rollback"); throw error; }
      finally { client.release(); }
    }
    Object.assign(process.env, { NODE_ENV: "test", CRM_LOCAL_TEST_DATABASE: "1", DATABASE_URL: `postgresql://${db.role}@127.0.0.1:${db.port}/neondb` });
    for (const key of ["VERCEL", "VERCEL_ENV", "VERCEL_URL"]) delete process.env[key];
    async function actor(label: string, workspaceId: string = randomUUID(), employee = false): Promise<AppSession> {
      if (!employee) await db.admin.query("insert into workspaces(id,name,operating_model,customer_type) values($1,$2,'self_service_customer','general_company')", [workspaceId, `SYNTHETIC ${label}`]);
      const userId = randomUUID(), role = employee ? "agent" : "owner", productRole = employee ? "team_member" : "customer_owner";
      await db.admin.query("insert into workspace_users(id,workspace_id,name,email,role,product_role,status) values($1,$2,$3,$4,$5,$6,'active')", [userId, workspaceId, `SYNTHETIC ${label}`, `synthetic-setup-${userId}@example.invalid`, role, productRole]);
      if (!employee) await db.admin.query("insert into workspace_module_settings(workspace_id,module_key,enabled) values($1,'calendar',true)", [workspaceId]);
      return { authenticated: true, source: "database", workspaceId, userId, workspaceName: `SYNTHETIC ${label}`, name: label, email: `synthetic-setup-${userId}@example.invalid`, role, productRole,
        permissions: getRolePermissions(role), productPermissions: getProductRoleCapabilities(productRole), workspaceCustomerType: "general_company", workspaceOperatingModel: "self_service_customer" };
    }
    const owner = await actor("setup owner"), foreign = await actor("foreign setup"), employee = await actor("setup employee", owner.workspaceId, true);
    const save = (scope: "company" | "employee", kind: "*" | "phone" | "onsite", section: "rules" | "travel" | "communication", value: Record<string, unknown>) => saveBookingSetup(owner, { scope, kind, section, value });

    await t.test("company, type, employee and employee/type values are persisted and used by authoritative rules", async () => {
      await save("company", "*", "rules", { durationMinutes: 30, preparationMinutes: 5 });
      await save("company", "phone", "rules", { durationMinutes: 45 });
      await save("employee", "*", "rules", { durationMinutes: 55 });
      const result = await save("employee", "phone", "rules", { durationMinutes: 60 });
      assert.equal(result.effective.phone.rules.durationMinutes, 60);
      assert.equal(result.effectiveDefaults.rules.durationMinutes, 55);
      assert.equal(result.companyBaseDefaults.rules.durationMinutes, 30);
      assert.equal(result.companyDefaults.phone.rules.durationMinutes, 45);
      assert.equal(result.effective.onsite.rules.durationMinutes, 55);
      assert.equal(result.layers.filter(row => Object.hasOwn(row.rules, "durationMinutes")).length, 4);
      assert.equal((await withTenantTransaction({ workspaceId: owner.workspaceId, actorId: owner.userId }, tx => readRules(tx, owner, "*"))).durationMinutes, 55);
      const engineRules = await withTenantTransaction({ workspaceId: owner.workspaceId, actorId: owner.userId }, tx => readBookingSetup(tx, owner, "phone"));
      assert.equal(engineRules.rules.durationMinutes, 60);
      assert.equal((await getBookingSetup(employee)).effective.phone.rules.durationMinutes, 45);
    });

    await t.test("reset inherits current company standards despite employee defaults and follows later company edits", async () => {
      const reset = await saveBookingSetup(owner, { scope: "employee", kind: "phone", section: "rules", fields: ["durationMinutes"] }, {}, true);
      assert.equal(reset.effective.phone.rules.durationMinutes, 45);
      assert.equal(reset.effective.onsite.rules.durationMinutes, 55);
      assert.deepEqual(reset.layers.find(row => row.scope === "employee" && row.kind === "phone")?.companyResets.rules, ["durationMinutes"]);
      await save("company", "phone", "rules", { durationMinutes: 50 });
      assert.equal((await getBookingSetup(owner)).effective.phone.rules.durationMinutes, 50);
      const engine = await withTenantTransaction({ workspaceId: owner.workspaceId, actorId: owner.userId }, tx => readBookingSetup(tx, owner, "phone"));
      assert.equal(engine.rules.durationMinutes, 50);
      await save("employee", "phone", "rules", { durationMinutes: 65 });
      assert.equal((await getBookingSetup(owner)).effective.phone.rules.durationMinutes, 65);
    });

    await t.test("revision conflicts are rejected and travel location settings persist with employee overrides", async () => {
      const snapshot = await getBookingSetup(owner), revision = snapshot.layers.find(row => row.scope === "employee" && row.kind === "phone")!.ruleRevision;
      await assert.rejects(saveBookingSetup(owner, { scope: "employee", kind: "phone", section: "rules", value: { durationMinutes: 70 }, expectedRevision: revision - 1 }), /BOOKING_SETUP_CHANGED/);
      assert.equal((await getBookingSetup(owner)).effective.phone.rules.durationMinutes, 65);
      const locations = [{ id: "office", label: "Synthetic office", address: "Synthetic verified address", confirmed: true }];
      await save("company", "*", "travel", { locations, startLocationId: "office", onlineLocationId: "office", enabled: true, additionalBufferMinutes: 15 });
      await save("employee", "*", "travel", { additionalBufferMinutes: 25 });
      const result = await save("employee", "onsite", "travel", { additionalBufferMinutes: 35 });
      assert.equal(result.effective.onsite.travel.additionalBufferMinutes, 35);
      assert.equal(result.effective.phone.travel.additionalBufferMinutes, 25);
      const reset = await saveBookingSetup(owner, { scope: "employee", kind: "onsite", section: "travel", fields: ["additionalBufferMinutes"] }, {}, true);
      assert.equal(reset.effective.onsite.travel.additionalBufferMinutes, 15);
      await save("company", "*", "travel", { additionalBufferMinutes: 20 });
      assert.equal((await getBookingSetup(owner)).effective.onsite.travel.additionalBufferMinutes, 20);
      assert.equal((await getBookingSetup(foreign)).effective.onsite.travel.enabled, false);
    });

    await t.test("templates and reminders round-trip without introducing hidden overrides or accepting markup", async () => {
      await save("company", "*", "communication", { companyName: "SYNTHETIC COMPANY", replyTo: "synthetic@example.invalid", reminders: [{ id: "flexible", minutesBefore: 90, template: "reminder", enabled: true }] });
      const result = await save("employee", "phone", "communication", { preparationNote: "Bring the prepared documents." });
      assert.equal(result.effective.phone.communication.companyName, "SYNTHETIC COMPANY");
      assert.equal(result.effective.phone.communication.preparationNote, "Bring the prepared documents.");
      assert.equal(result.effective.phone.communication.reminders[0].minutesBefore, 90);
      assert.deepEqual(Object.keys(result.layers.find(row => row.scope === "employee" && row.kind === "phone")!.communication), ["preparationNote"]);
      const invalid = structuredClone(defaultBookingCommunication.templates);
      invalid.de.confirmation.body = "<script>alert(1)</script>";
      await assert.rejects(save("employee", "phone", "communication", { templates: invalid }), error => error instanceof BookingError && error.status === 400 && error.code === "TEMPLATE_MARKUP_NOT_ALLOWED");
    });

    await t.test("database membership overrides forged manager claims and RLS hides other tenants and employee settings", async () => {
      await assert.rejects(saveBookingSetup({ ...employee, role: "owner", productRole: "customer_owner", productPermissions: getProductRoleCapabilities("customer_owner") }, { scope: "company", kind: "*", section: "rules", value: { durationMinutes: 999 } }), /BOOKING_FORBIDDEN/);
      const foreignRows = await withTenantTransaction({ workspaceId: foreign.workspaceId, actorId: foreign.userId }, tx => tx.query("select id from booking_setup_sets where workspace_id=$1::uuid", [owner.workspaceId]));
      assert.equal(foreignRows.length, 0);
      const employeeRows = await withTenantTransaction({ workspaceId: owner.workspaceId, actorId: employee.userId }, tx => tx.query("select id from booking_setup_sets where user_id=$1::uuid", [owner.userId]));
      assert.equal(employeeRows.length, 0);
      const identity = await db.pool.query("select rolsuper,rolbypassrls from pg_roles where rolname=current_user");
      assert.equal(identity.rows[0].rolsuper, false);
      assert.equal(identity.rows[0].rolbypassrls, false);
      const forced = await db.admin.query("select relforcerowsecurity from pg_class where oid='booking_setup_sets'::regclass");
      assert.equal(forced.rows[0].relforcerowsecurity, true);
    });

    await t.test("company defaults wait for another employee's active booking transaction", async () => {
      let release!: () => void, acquired!: () => void;
      const released = new Promise<void>(resolve => { release = resolve; });
      const locked = new Promise<void>(resolve => { acquired = resolve; });
      const bookingTransaction = withTenantTransaction({ workspaceId: employee.workspaceId, actorId: employee.userId }, async tx => {
        await bookingResourceLock(tx, employee);
        acquired();
        await released;
      });
      await locked;
      let completed = false, saveFailure: unknown;
      const companySave = save("company", "*", "rules", { preparationMinutes: 7 }).then(result => {
        completed = true;
        return result;
      }, error => { completed = true; saveFailure = error; return null; });
      let observedWaiting = false;
      try {
        for (let attempt = 0; attempt < 40 && !observedWaiting && !completed; attempt++) {
          const locks = await db.admin.query(`select exists(select 1 from pg_locks where locktype='advisory'
            and database=(select oid from pg_database where datname=current_database()) and mode='ExclusiveLock' and not granted) as waiting`);
          observedWaiting = locks.rows[0].waiting;
          if (!observedWaiting) await new Promise(resolve => setTimeout(resolve, 10));
        }
        assert.equal(completed, false, "Company changes must not pass another organizer's booking lock");
        assert.equal(observedWaiting, true, "The company mutation must wait on the shared workspace resource");
      } finally { release(); }
      await bookingTransaction;
      const result = await companySave;
      if (saveFailure) throw saveFailure;
      assert.equal(result?.companyBaseDefaults.rules.preparationMinutes, 7);
    });

    await t.test("property locations use authorized canonical addresses, reject missing and foreign locations, and bound search output", async () => {
      const projectId = randomUUID(), foreignProjectId = randomUUID(), propertyId = randomUUID(), foreignPropertyId = randomUUID(), missingAddressId = randomUUID();
      await db.admin.query("insert into projects(id,workspace_id,name,type) values($1,$2,'SYNTHETIC location project','Service'),($3,$4,'SYNTHETIC foreign location project','Service')", [projectId, owner.workspaceId, foreignProjectId, foreign.workspaceId]);
      await db.admin.query("insert into workspace_module_settings(workspace_id,module_key,enabled) values($1,'properties',true),($2,'properties',true)", [owner.workspaceId, foreign.workspaceId]);
      const insertListing = (id: string, workspaceId: string, project: string | null, address: string) => db.admin.query(`insert into seller_listings(id,workspace_id,project_id,title,address,postal_code,city,region,object_type,area_sqm,key_info)
        values($1,$2,$3,'SYNTHETIC location listing',$4,'1010','Wien','Wien','Büro',80,'SYNTHETIC PRIVATE DESCRIPTION NOT FOR ROUTING')`, [id, workspaceId, project, address]);
      await insertListing(propertyId, owner.workspaceId, projectId, "  SYNTHETIC   Straße 4  ");
      await insertListing(foreignPropertyId, foreign.workspaceId, foreignProjectId, "SYNTHETIC foreign address");
      await insertListing(missingAddressId, owner.workspaceId, projectId, "");
      const resolve = (id: string, session = owner) => withTenantTransaction({ workspaceId: session.workspaceId, actorId: session.userId }, tx => resolveBookingPropertyLocation(tx, session, id));
      assert.deepEqual(await resolve(propertyId), { propertyId, address: "SYNTHETIC Straße 4, 1010 Wien" });
      await assert.rejects(resolve(foreignPropertyId), error => error instanceof BookingError && error.code === "PROPERTY_LOCATION_NOT_FOUND" && error.status === 404);
      await assert.rejects(resolve(missingAddressId), error => error instanceof BookingError && error.code === "PROPERTY_ADDRESS_REQUIRED" && error.status === 409);
      await assert.rejects(resolve("invalid-property-reference"), error => error instanceof BookingError && error.code === "INVALID_PROPERTY_REFERENCE");

      // An existing foreign project must not turn an own-workspace row into an authorized location.
      const inconsistentId = randomUUID();
      try {
        await insertListing(inconsistentId, owner.workspaceId, foreignProjectId, "SYNTHETIC inconsistent project address");
        await assert.rejects(resolve(inconsistentId), error => error instanceof BookingError && error.code === "PROPERTY_LOCATION_NOT_FOUND" && error.status === 404);
      } catch (error) {
        assert.ok(error && typeof error === "object" && "code" in error && ["23503", "23514"].includes(String(error.code)), "The database must reject inconsistent project ownership or the resolver must hide it");
      }

      await db.admin.query(`insert into seller_listings(workspace_id,title,address,postal_code,city,region,object_type,area_sqm,key_info)
        select $1,'SYNTHETIC bulk location '||n,'SYNTHETIC Straße '||n,'1010','Wien','Wien','Büro',80,'SYNTHETIC PRIVATE DESCRIPTION NOT FOR ROUTING' from generate_series(1,35) n`, [owner.workspaceId]);
      const results = await listBookingPropertyLocations(owner, "SYNTHETIC");
      assert.equal(results.length, 30);
      for (const result of results) {
        assert.deepEqual(Object.keys(result).sort(), ["address", "id", "title"]);
        assert.notEqual(result.id, foreignPropertyId);
        assert.doesNotMatch(JSON.stringify(result), /PRIVATE DESCRIPTION/);
      }
      assert.deepEqual(await listBookingPropertyLocations(owner, "%"), []);
      await assert.rejects(listBookingPropertyLocations(owner, "x".repeat(121)), /INVALID_PROPERTY_SEARCH/);
      await db.admin.query("update workspace_module_settings set enabled=false where workspace_id=$1 and module_key='properties'", [owner.workspaceId]);
      await assert.rejects(resolve(propertyId), error => error instanceof BookingError && error.code === "PROPERTY_MODULE_REQUIRED" && error.status === 403);
      await assert.rejects(listBookingPropertyLocations(owner), error => error instanceof BookingError && error.code === "PROPERTY_MODULE_REQUIRED" && error.status === 403);
    });
  } finally {
    await closeLocalTestPool();
    for (const key of Object.keys(process.env)) if (!(key in prior)) delete process.env[key];
    Object.assign(process.env, prior);
    await db.stop();
  }
});
