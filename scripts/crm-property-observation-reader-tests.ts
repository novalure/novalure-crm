import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import pg from "pg";
import { PROPERTY_READER_AUDIENCE, verifyPropertyReaderIdentity, type VerifiedPropertyIdentity } from "../src/lib/crm-property-observation-auth";
import { handlePropertyObservation } from "../src/lib/crm-property-observation-handler";
import { readPropertyObservationFromAuthorizedContext, type PropertyObservationRead } from "../src/lib/crm-property-observation-reader";
import { propertyObservationPool, withPropertyObservationTransaction } from "../src/lib/crm-property-observation-pool";
import { closeLocalTestPool } from "../src/lib/db/local-test-transport";
import type { TenantPool } from "../src/lib/db/tenant-client";
import { startLocalSalesDb, applySalesSchema } from "./lib/local-sales-db.mjs";

let db: Awaited<ReturnType<typeof startLocalSalesDb>>; let reader: pg.Pool; let otherReader: pg.Pool;
let schemaPreconditionsChecked = false;
const workspaceId = randomUUID(), actorId = randomUUID(), projectId = randomUUID(), unitId = randomUUID(), grantId = randomUUID();
const foreignWorkspaceId = randomUUID(), foreignActorId = randomUUID(), foreignProjectId = randomUUID(), foreignUnitId = randomUUID();
const privateUnitId = randomUUID(), privateGrantId = randomUUID();
const readerLogin = `property_qa_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
const otherLogin = `property_qa_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
const token = `eyJ${"a".repeat(20)}.${"b".repeat(24)}.${"c".repeat(24)}`;
const originalEnv = Object.fromEntries(["NOVALURE_BUILD_GIT_SHA", "NOVALURE_BUILD_DEPLOYMENT_ID", "NODE_ENV", "VERCEL_ENV", "CRM_PROPERTY_READER_ENABLED", "CRM_PROPERTY_READER_ISSUER", "CRM_PROPERTY_READER_SUBJECT", "CRM_PROPERTY_READER_OWNER_ID", "CRM_PROPERTY_READER_PROJECT_ID"].map(key => [key, process.env[key]]));
const verifier = (jti = randomUUID()): NonNullable<Parameters<typeof verifyPropertyReaderIdentity>[1]> => async () => {
  const now = Math.floor(Date.now() / 1000);
  return { payload: { iss: process.env.CRM_PROPERTY_READER_ISSUER, sub: process.env.CRM_PROPERTY_READER_SUBJECT, aud: PROPERTY_READER_AUDIENCE,
    owner_id: process.env.CRM_PROPERTY_READER_OWNER_ID, project_id: process.env.CRM_PROPERTY_READER_PROJECT_ID,
    environment: "production", iat: now - 5, nbf: now - 5, exp: now + 3600, jti },
    protectedHeader: { alg: "RS256", typ: "JWT", kid: "synthetic-key" } } as Awaited<ReturnType<NonNullable<Parameters<typeof verifyPropertyReaderIdentity>[1]>>>;
};
const identity = () => verifyPropertyReaderIdentity(token, verifier());
const request = { workspaceId, projectId, unitId, fields: ["priceCents", "areaSqm", "status", "balconyAreaSqm"] as const };
const pool = () => reader as unknown as TenantPool;
const read = async (selected: PropertyObservationRead = request, selectedPool = pool(), id?: VerifiedPropertyIdentity) => readPropertyObservationFromAuthorizedContext(id ?? await identity(), selected, selectedPool);
const invoke = (body: unknown, options: { headers?: Record<string,string>; selectedPool?: TenantPool; testVerifier?: ReturnType<typeof verifier> } = {}) => handlePropertyObservation(
  new Request("https://crm.example.invalid/api/integrations/evelyn/property/observation", { method: "POST", headers: options.headers ?? { authorization: `Bearer ${token}` }, body: JSON.stringify(body) }),
  { pool: options.selectedPool ?? pool(), testVerifier: options.testVerifier ?? verifier() },
);
const sqlArguments = (identityValue: VerifiedPropertyIdentity, selectedUnit = unitId, fields: readonly string[] = request.fields) => [workspaceId,actorId,projectId,selectedUnit,identityValue.issuer,identityValue.subject,identityValue.audience,identityValue.ownerId,identityValue.workloadProjectId,identityValue.environment,fields,identityValue.jtiHash,new Date(identityValue.expiresAt * 1000).toISOString()];
const observeSql = "select public.crm_property_observe_unit($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,$6,$7,$8,$9,$10,$11::text[],$12,$13::timestamptz) as result";

before(async () => {
  Object.assign(process.env, { NODE_ENV: "test", VERCEL_ENV: "production", CRM_PROPERTY_READER_ENABLED: "1", CRM_PROPERTY_READER_ISSUER: "https://issuer.example.invalid/team", CRM_PROPERTY_READER_SUBJECT: "property-reader", CRM_PROPERTY_READER_OWNER_ID: "team-test", CRM_PROPERTY_READER_PROJECT_ID: "project-test", NOVALURE_BUILD_GIT_SHA: "a".repeat(40), NOVALURE_BUILD_DEPLOYMENT_ID: "dpl_Test" });
  // This helper intentionally skips some migrations and pgvector. Exercising
  // later compatible migrations is useful, but is not a full live-schema test.
  db = await startLocalSalesDb(); await applySalesSchema(db, { maxMigrationNumber: 188 });
  await db.admin.query(`create role novalure_property_reader nologin inherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls`);
  for (const login of [readerLogin,otherLogin]) {
    await db.admin.query(`create role ${login} login inherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls`);
    await db.admin.query(`grant novalure_property_reader to ${login}`);
    await db.admin.query(`grant usage on schema public to ${login}`);
  }
  const stagedMigration = await readFile("migrations/staged/property_observation_grants_candidate.sql", "utf8");
  // Transactional DDL simulates a predecessor or an incompatible replacement
  // on this disposable database only. A failed candidate must install nothing.
  const schemaTest = await db.admin.connect();
  try {
    for (const incompatible of [
      "alter table public.property_units rename column balcony_area_sqm to qa_missing_balcony_area_sqm",
      "alter table public.property_units rename column balcony_area_sqm to qa_original_balcony_area_sqm; alter table public.property_units add column balcony_area_sqm text",
    ]) {
      await schemaTest.query("begin");
      try {
        await schemaTest.query(incompatible);
        await assert.rejects(schemaTest.query(stagedMigration), /Property detail schema 186 is required/);
      } finally { await schemaTest.query("rollback"); }
      assert.equal((await schemaTest.query("select to_regclass('public.crm_property_observation_grants') as created")).rows[0].created, null);
    }
    schemaPreconditionsChecked = true;
  } finally { schemaTest.release(); }
  await db.admin.query(stagedMigration);
  reader = new pg.Pool({ host: "127.0.0.1", port: db.port, user: readerLogin, database: "postgres", max: 6 });
  otherReader = new pg.Pool({ host: "127.0.0.1", port: db.port, user: otherLogin, database: "postgres", max: 2 });
  await db.admin.query("insert into workspaces(id,name,operating_model,setup_state) values($1,'SYNTHETIC','managed_by_novalure','{}'),($2,'FOREIGN SYNTHETIC','managed_by_novalure','{}')", [workspaceId,foreignWorkspaceId]);
  await db.admin.query("insert into workspace_users(id,workspace_id,name,email,role,product_role,status) values($1,$2,'SYNTHETIC','synthetic@example.invalid','agent','project_sales_member','active'),($3,$4,'FOREIGN','foreign@example.invalid','agent','project_sales_member','active')", [actorId,workspaceId,foreignActorId,foreignWorkspaceId]);
  await db.admin.query("insert into projects(id,workspace_id,name,type) values($1,$2,'SYNTHETIC: Project','SYNTHETIC: Test'),($3,$4,'FOREIGN: Project','SYNTHETIC: Test')", [projectId,workspaceId,foreignProjectId,foreignWorkspaceId]);
  await db.admin.query("insert into project_pipeline_permissions(workspace_id,project_id,user_id,can_read,can_edit_deals) values($1,$2,$3,true,false)", [workspaceId,projectId,actorId]);
  await db.admin.query("insert into property_units(id,workspace_id,project_id,unit_number,price_cents,area_sqm,rooms,status,data_classification,data_purpose) values($1,$2,$3,'SYNTHETIC A',0,75.5,3,'available','CUSTOMER_TENANT','crm_sales'),($4,$5,$6,'SYNTHETIC B',555,80,2,'sold','CUSTOMER_TENANT','crm_sales'),($7,$2,$3,'SYNTHETIC PRIVATE',777,80,2,'sold','PRIVATE_FRANZ','crm_sales')", [unitId,workspaceId,projectId,foreignUnitId,foreignWorkspaceId,foreignProjectId,privateUnitId]);
  const id = await identity();
  for (const [gid,uid] of [[grantId,unitId],[privateGrantId,privateUnitId]]) await db.admin.query("insert into crm_property_observation_grants(id,workspace_id,actor_id,project_id,unit_id,database_login,issuer,subject,audience,owner_id,workload_project_id,environment,purpose,allowed_fields,valid_from,expires_at) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'production','property_read',$12,now()-interval '1 minute',now()+interval '1 hour')", [gid,workspaceId,actorId,projectId,uid,readerLogin,id.issuer,id.subject,id.audience,id.ownerId,id.workloadProjectId,[...request.fields]]);
});

after(async () => {
  for (const [key,value] of Object.entries(originalEnv)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  if (reader) await reader.end(); if (otherReader) await otherReader.end();
  await closeLocalTestPool(); if (db) await db.stop();
});

test("dedicated role performs an exact-scope, non-authoritative read", async () => {
  const result = (await read()).observation;
  assert.equal(result.actorId, actorId); assert.equal(result.authority, "NOT_ESTABLISHED"); assert.equal(result.sourceApproval, "NOT_EXPOSED");
  assert.deepEqual(result.fields, [
    { field: "priceCents", value: 0, valueState: "PRESENT" }, { field: "areaSqm", value: 75.5, valueState: "PRESENT" },
    { field: "status", value: "available", valueState: "PRESENT" }, { field: "balconyAreaSqm", value: null, valueState: "EXPLICIT_UNKNOWN" },
  ]);
});

test("candidate rejects a pre-186 or incompatible detail schema before installation", () => {
  assert.equal(schemaPreconditionsChecked, true);
});

test("detail reads preserve null and zero and require every selected field grant", async () => {
  const detailFields = ["balconyAreaSqm", "terraceAreaSqm", "gardenAreaSqm", "undergroundParkingCount", "carportCount", "outdoorParkingCount"] as const;
  await db.admin.query("update property_units set balcony_area_sqm=0,terrace_area_sqm=19.25,garden_area_sqm=null,underground_parking_count=0,carport_count=2,outdoor_parking_count=null,version=version+1,updated_at=clock_timestamp() where id=$1", [unitId]);
  try {
    await assert.rejects(read({ ...request, fields: detailFields }), /accessible/i);
    for (const deniedField of detailFields) {
      await db.admin.query("update crm_property_observation_grants set allowed_fields=$2 where id=$1", [grantId, detailFields.filter(field => field !== deniedField)]);
      await assert.rejects(read({ ...request, fields: [deniedField] }), /accessible/i);
    }
    await db.admin.query("update crm_property_observation_grants set allowed_fields=$2 where id=$1", [grantId, [...detailFields]]);
    const observed = (await read({ ...request, fields: detailFields })).observation;
    assert.deepEqual(observed.fields, [
      { field: "balconyAreaSqm", value: 0, valueState: "PRESENT" },
      { field: "terraceAreaSqm", value: 19.25, valueState: "PRESENT" },
      { field: "gardenAreaSqm", value: null, valueState: "EXPLICIT_UNKNOWN" },
      { field: "undergroundParkingCount", value: 0, valueState: "PRESENT" },
      { field: "carportCount", value: 2, valueState: "PRESENT" },
      { field: "outdoorParkingCount", value: null, valueState: "EXPLICIT_UNKNOWN" },
    ]);
    assert.equal(observed.authority, "NOT_ESTABLISHED");
    assert.equal(observed.sourceApproval, "NOT_EXPOSED");
    assert.deepEqual((await read({ ...request, fields: ["gardenAreaSqm"] })).observation.fields,
      [{ field: "gardenAreaSqm", value: null, valueState: "EXPLICIT_UNKNOWN" }]);
    await assert.rejects(read({ ...request, fields: ["gardenAreaSqm", "priceCents"] }), /accessible/i);
  } finally {
    await db.admin.query("update crm_property_observation_grants set allowed_fields=$2 where id=$1", [grantId, [...request.fields]]);
    await db.admin.query("update property_units set balcony_area_sqm=null,terrace_area_sqm=null,garden_area_sqm=null,underground_parking_count=null,carport_count=null,outdoor_parking_count=null,version=version+1,updated_at=clock_timestamp() where id=$1", [unitId]);
  }
});

test("HTTP is default closed and needs verified workload and exact persisted grant", async () => {
  process.env.CRM_PROPERTY_READER_ENABLED = "0";
  try { assert.equal((await invoke(request)).status, 401); } finally { process.env.CRM_PROPERTY_READER_ENABLED = "1"; }
  assert.equal((await invoke(request, { headers: {} })).status, 401);
  assert.equal((await invoke(request, { headers: { authorization: `Bearer ${token}`, cookie: "fake=forged" } })).status, 403);
  assert.equal((await invoke(request, { headers: { authorization: `Bearer ${token}`, origin: "https://other.invalid" } })).status, 403);
  assert.equal((await invoke({ ...request, unitId: foreignUnitId })).status, 403);
  assert.equal((await invoke({ ...request, actorId })).status, 400);
  assert.equal((await invoke({ ...request, fields: ["rooms"] })).status, 403);
  assert.equal((await invoke({ ...request, fields: ["status", "status"] })).status, 400);
  assert.equal((await invoke({ ...request, extra: "x".repeat(4096) })).status, 400);
  await db.admin.query("update crm_property_observation_grants set revoked_at=now() where id=$1", [grantId]);
  try { assert.equal((await invoke(request)).status, 403); } finally { await db.admin.query("update crm_property_observation_grants set revoked_at=null where id=$1", [grantId]); }
  const result = await invoke(request); assert.equal(result.status, 200); assert.equal(result.headers.get("cache-control"), "no-store");
});

test("one token cannot be replayed, even across parallel requests", async () => {
  const fixed = verifier(randomUUID());
  const results = await Promise.all([invoke(request, { testVerifier: fixed }),invoke(request, { testVerifier: fixed })]);
  assert.deepEqual(results.map(result => result.status).sort(), [200,403]);
  assert.equal((await invoke(request, { testVerifier: fixed })).status, 403);
});

test("scope, field, classification, login and subject isolation hold", async () => {
  await assert.rejects(read({ ...request, unitId: foreignUnitId }), /accessible/i);
  await assert.rejects(read({ ...request, projectId: foreignProjectId, unitId: foreignUnitId }), /accessible/i);
  await assert.rejects(read({ ...request, fields: ["rooms"] }), /accessible/i);
  await assert.rejects(read({ ...request, unitId: privateUnitId }), /accessible/i);
  await assert.rejects(read(request, otherReader as unknown as TenantPool), /accessible/i);
  const checked = await identity();
  await assert.rejects(read(request, pool(), { ...checked, subject: "forged" }), /denied/i);
});

test("a later mutation cannot expand the initially authorized field selection", async () => {
  const mutable = { workspaceId,projectId,unitId,fields: ["status"] as ("status" | "rooms")[] };
  const id = await identity(); const pending = read(mutable, pool(), id); mutable.fields.push("rooms");
  assert.deepEqual((await pending).observation.fields.map(field => field.field), ["status"]);
});

test("revocation, stop, expiration, suspended actor and removed project access deny reads", async () => {
  for (const [change,undo] of [
    ["update crm_property_observation_grants set revoked_at=now() where id=$1", "update crm_property_observation_grants set revoked_at=null where id=$1"],
    ["update crm_property_observation_grants set kill_switch_active=true where id=$1", "update crm_property_observation_grants set kill_switch_active=false where id=$1"],
    ["update crm_property_observation_grants set expires_at=now()-interval '1 second',valid_from=now()-interval '1 hour' where id=$1", "update crm_property_observation_grants set expires_at=now()+interval '1 hour' where id=$1"],
  ]) { await db.admin.query(change,[grantId]); try { await assert.rejects(read(), /accessible/i); } finally { await db.admin.query(undo,[grantId]); } }
  await db.admin.query("update workspace_users set status='suspended' where id=$1", [actorId]);
  try { await assert.rejects(read(), /accessible/i); } finally { await db.admin.query("update workspace_users set status='active' where id=$1", [actorId]); }
  await db.admin.query("update project_pipeline_permissions set can_read=false where workspace_id=$1 and project_id=$2 and user_id=$3", [workspaceId,projectId,actorId]);
  try { await assert.rejects(read(), /accessible/i); } finally { await db.admin.query("update project_pipeline_permissions set can_read=true where workspace_id=$1 and project_id=$2 and user_id=$3", [workspaceId,projectId,actorId]); }
});

test("dedicated reader cannot directly access tables and shared tenant role cannot invoke property functions", async () => {
  await assert.rejects(reader.query("select * from property_units"), /permission denied/i);
  await assert.rejects(reader.query("update property_units set price_cents=1"), /permission denied/i);
  await assert.rejects(reader.query("select * from contacts"), /permission denied/i);
  await assert.rejects(reader.query("select * from crm_property_observation_grants"), /permission denied/i);
  await assert.rejects(reader.query("select * from crm_property_observation_audit"), /permission denied/i);
  const id = await identity();
  await assert.rejects(db.pool.query(observeSql,sqlArguments(id)), /permission denied/i);
  const audit = await db.admin.query("select outcome from crm_property_observation_audit where grant_id=$1", [grantId]);
  assert.ok(audit.rows.length > 0); assert.ok(audit.rows.every((row: { outcome: string }) => row.outcome === "GRANT_ALLOWED"));
  await assert.rejects(db.admin.query("delete from crm_property_observation_audit where grant_id=$1", [grantId]), /immutable/i);
});

test("role guard rejects shared tenant role, column grants, view access and inherited ownership", async () => {
  await assert.rejects(withPropertyObservationTransaction(db.pool as unknown as TenantPool, async () => true), /ROLE_UNSAFE/);
  await db.admin.query(`grant select(unit_number) on property_units to ${readerLogin}`);
  try { await assert.rejects(read(), /ROLE_UNSAFE/); } finally { await db.admin.query(`revoke select(unit_number) on property_units from ${readerLogin}`); }
  await db.admin.query("create view public.property_reader_test_view as select 1 as n");
  await db.admin.query(`grant select on public.property_reader_test_view to ${readerLogin}`);
  try { await assert.rejects(read(), /ROLE_UNSAFE/); } finally { await db.admin.query(`revoke select on public.property_reader_test_view from ${readerLogin}`); await db.admin.query("drop view public.property_reader_test_view"); }
  const owner = `property_owner_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  await db.admin.query(`create role ${owner} nologin`); await db.admin.query(`create table public.property_reader_owner_test(id int)`);
  await db.admin.query(`alter table public.property_reader_owner_test owner to ${owner}`); await db.admin.query(`grant ${owner} to ${readerLogin}`);
  try { await assert.rejects(read(), /ROLE_UNSAFE/); } finally { await db.admin.query(`revoke ${owner} from ${readerLogin}`); await db.admin.query("drop table public.property_reader_owner_test"); await db.admin.query(`drop role ${owner}`); }
  const schemaOwner = `property_owner_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  await db.admin.query(`create role ${schemaOwner} nologin`); await db.admin.query(`create schema property_owner_schema authorization ${schemaOwner}`);
  await db.admin.query(`grant ${schemaOwner} to ${readerLogin} with inherit false, set true`);
  try { await assert.rejects(read(), /ROLE_UNSAFE/); } finally { await db.admin.query(`revoke ${schemaOwner} from ${readerLogin}`); await db.admin.query("drop schema property_owner_schema"); await db.admin.query(`drop role ${schemaOwner}`); }
  const functionOwner = `property_owner_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  await db.admin.query(`create role ${functionOwner} nologin`); await db.admin.query("create function public.property_reader_owner_function() returns integer language sql security definer as 'select 1'");
  await db.admin.query("revoke all on function public.property_reader_owner_function() from public"); await db.admin.query(`alter function public.property_reader_owner_function() owner to ${functionOwner}`);
  await db.admin.query(`grant ${functionOwner} to ${readerLogin} with inherit false, set true`);
  try { await assert.rejects(read(), /ROLE_UNSAFE/); } finally { await db.admin.query(`revoke ${functionOwner} from ${readerLogin}`); await db.admin.query("drop function public.property_reader_owner_function()"); await db.admin.query(`drop role ${functionOwner}`); }
  await db.admin.query("create function public.property_reader_unsafe_test() returns integer language sql security definer as 'select 1'");
  try { await assert.rejects(read(), /ROLE_UNSAFE/); } finally { await db.admin.query("drop function public.property_reader_unsafe_test()"); }
  await db.admin.query("create schema property_reader_other_schema"); await db.admin.query("create table property_reader_other_schema.secret_test(id int)");
  await db.admin.query(`grant usage on schema property_reader_other_schema to ${readerLogin}`); await db.admin.query(`grant select on property_reader_other_schema.secret_test to ${readerLogin}`);
  try { await assert.rejects(read(), /ROLE_UNSAFE/); } finally { await db.admin.query(`revoke select on property_reader_other_schema.secret_test from ${readerLogin}`); await db.admin.query(`revoke usage on schema property_reader_other_schema from ${readerLogin}`); await db.admin.query("drop table property_reader_other_schema.secret_test"); await db.admin.query("drop schema property_reader_other_schema"); }
});

test("normal host pool remains fail closed until target binding is implemented", async () => {
  await assert.rejects(propertyObservationPool(), /TARGET_BINDING_REQUIRED/);
});

test("grant expiring while a real query is blocked cannot yield a result", async () => {
  await db.admin.query("update crm_property_observation_grants set expires_at=clock_timestamp()+interval '2 seconds',valid_from=clock_timestamp()-interval '1 minute' where id=$1", [grantId]);
  let release!: () => void, entered!: () => void; const paused = new Promise<void>(resolve => { release = resolve; }); const ready = new Promise<void>(resolve => { entered = resolve; });
  const delayed: TenantPool = { connect: async () => {
    const client = await reader.connect(); const original = client.query.bind(client);
    return new Proxy(client, { get(target,key) { if (key === "query") return async (...args: unknown[]) => { const result = await (original as (...values: unknown[]) => Promise<unknown>)(...args); if (typeof args[0] === "string" && args[0].startsWith("select public.crm_property_observe_unit(")) { entered(); await paused; } return result; }; const value = Reflect.get(target,key,target); return typeof value === "function" ? value.bind(target) : value; } }) as unknown as Awaited<ReturnType<TenantPool["connect"]>>;
  } };
  try {
    const pending = read(request, delayed); await ready; await new Promise(resolve => setTimeout(resolve, 2200)); release();
    await assert.rejects(pending, /expired/i);
  } finally { release(); await db.admin.query("update crm_property_observation_grants set expires_at=now()+interval '1 hour' where id=$1", [grantId]); }
});

test("grant expiring during asynchronous COMMIT does not yield an HTTP result", async () => {
  await db.admin.query("update crm_property_observation_grants set expires_at=clock_timestamp()+interval '2 seconds',valid_from=clock_timestamp()-interval '1 minute' where id=$1", [grantId]);
  let release!: () => void, entered!: () => void; const paused = new Promise<void>(resolve => { release = resolve; }); const ready = new Promise<void>(resolve => { entered = resolve; });
  const delayed: TenantPool = { connect: async () => {
    const client = await reader.connect(); const original = client.query.bind(client);
    return new Proxy(client, { get(target,key) { if (key === "query") return async (...args: unknown[]) => { if (typeof args[0] === "string" && args[0].trim().toLowerCase() === "commit") { entered(); await paused; } return (original as (...values: unknown[]) => Promise<unknown>)(...args); }; const value = Reflect.get(target,key,target); return typeof value === "function" ? value.bind(target) : value; } }) as unknown as Awaited<ReturnType<TenantPool["connect"]>>;
  } };
  try {
    const pending = invoke(request, { selectedPool: delayed }); await ready; await new Promise(resolve => setTimeout(resolve, 2200)); release();
    const response = await pending; assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { code: "CRM_NOT_ACCESSIBLE" });
  } finally { release(); await db.admin.query("update crm_property_observation_grants set expires_at=now()+interval '1 hour' where id=$1", [grantId]); }
});

test("membership changes serialize behind an active property transaction", async () => {
  const id = await identity(); let release!: () => void, entered!: () => void;
  const paused = new Promise<void>(resolve => { release = resolve; }); const ready = new Promise<void>(resolve => { entered = resolve; });
  const reading = withPropertyObservationTransaction(pool(), async client => { const result = await client.query<{ result: unknown }>(observeSql, sqlArguments(id)); assert.ok(result.rows[0]?.result); entered(); await paused; });
  await ready; const revoker = await db.admin.connect(); const pid = (await revoker.query("select pg_backend_pid() as pid")).rows[0].pid;
  const revocation = revoker.query("update workspace_users set status='suspended' where id=$1", [actorId]);
  try {
    let blocked = false; for (let attempt=0; attempt<50 && !blocked; attempt++) { blocked = (await db.admin.query("select cardinality(pg_blocking_pids($1)) > 0 as blocked", [pid])).rows[0].blocked === true; if (!blocked) await new Promise(resolve => setTimeout(resolve,20)); }
    assert.equal(blocked,true);
  } finally { release(); await reading; await revocation; revoker.release(); }
  try { await assert.rejects(read(), /accessible/i); } finally { await db.admin.query("update workspace_users set status='active' where id=$1", [actorId]); }
});

test("grant revocation serializes behind an active property transaction", async () => {
  const id = await identity(); let release!: () => void, entered!: () => void;
  const paused = new Promise<void>(resolve => { release = resolve; }); const ready = new Promise<void>(resolve => { entered = resolve; });
  const reading = withPropertyObservationTransaction(pool(), async client => { const result = await client.query<{ result: unknown }>(observeSql, sqlArguments(id)); assert.ok(result.rows[0]?.result); entered(); await paused; });
  await ready; const revoker = await db.admin.connect(); const pid = (await revoker.query("select pg_backend_pid() as pid")).rows[0].pid;
  const revocation = revoker.query("update crm_property_observation_grants set revoked_at=now() where id=$1", [grantId]);
  try {
    let blocked = false; for (let attempt=0; attempt<50 && !blocked; attempt++) { blocked = (await db.admin.query("select cardinality(pg_blocking_pids($1)) > 0 as blocked", [pid])).rows[0].blocked === true; if (!blocked) await new Promise(resolve => setTimeout(resolve,20)); }
    assert.equal(blocked,true);
  } finally { release(); await reading; await revocation; revoker.release(); }
  try { await assert.rejects(read(), /accessible/i); } finally { await db.admin.query("update crm_property_observation_grants set revoked_at=null where id=$1", [grantId]); }
});
