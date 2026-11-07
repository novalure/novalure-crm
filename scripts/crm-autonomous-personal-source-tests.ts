import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID, sign, type KeyObject } from "node:crypto";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import { SignJWT, jwtVerify, type JWTVerifyOptions } from "jose";
import { autonomousAccessContract, autonomousAccessPath, autonomousDelegationDomain, handleAutonomousCrmAccess } from "../src/lib/crm-autonomous-access";
import { registerAutonomousCrmAccess, type AutonomousCrmRegistration } from "../src/lib/crm-autonomous-registration";
import { crmPayloadDigest } from "../src/lib/crm-command";
import { CRM_MACHINE_AUDIENCE, CRM_MACHINE_ENVIRONMENT, CRM_MACHINE_ISSUER, CRM_MACHINE_OWNER_ID,
  CRM_MACHINE_PROJECT_ID, CRM_MACHINE_SUBJECT, CRM_MACHINE_WORKSPACE_ID, type CrmMachineAuthOptions } from "../src/lib/crm-machine-auth";
import { CRM_PERSONAL_SOURCE } from "../src/lib/crm-autonomous-personal-auth";
import type { TenantPool } from "../src/lib/db/tenant-client";
import { closeLocalTestPool } from "../src/lib/db/local-test-transport";
import { applySalesSchema, startLocalSalesDb } from "./lib/local-sales-db.mjs";

let db: Awaited<ReturnType<typeof startLocalSalesDb>>;
const workloadId = randomUUID(), actorId = randomUUID(), projectId = randomUUID(), sourceId = randomUUID(), missionId = randomUUID();
const foreignProject = randomUUID(), foreignTask = randomUUID(), privateTask = randomUUID();
const key = generateKeyPairSync("ed25519");
const grantId = randomUUID();
const bearer = `eyJ${"a".repeat(20)}.${"b".repeat(24)}.${"c".repeat(24)}`;
const identity = () => ({
  payload: { aud: CRM_MACHINE_AUDIENCE, iss: CRM_MACHINE_ISSUER, sub: CRM_MACHINE_SUBJECT,
    project_id: CRM_MACHINE_PROJECT_ID, owner_id: CRM_MACHINE_OWNER_ID, environment: CRM_MACHINE_ENVIRONMENT,
    iat: Math.floor(Date.now() / 1000) - 5, nbf: Math.floor(Date.now() / 1000) - 5,
    exp: Math.floor(Date.now() / 1000) + 3600, jti: randomUUID() },
  protectedHeader: { alg: "RS256", typ: "JWT", kid: "local-test-verifier" },
});
function machineAuth(): CrmMachineAuthOptions {
  const verified = identity();
  return { env: { CRM_MACHINE_AUTH_ENABLED: "1", VERCEL_ENV: "production", NODE_ENV: "production" }, verifier: async () => verified } as CrmMachineAuthOptions;
}
function body(overrides: Record<string, unknown> = {}) {
  return { contractVersion: autonomousAccessContract, operation: "Read", correlationId: randomUUID(),
    idempotencyKey: randomUUID(), expectedVersion: null, patch: {}, ...overrides };
}
function delegation(requestBody: Record<string, unknown>, id: string = grantId, privateKey: KeyObject = key.privateKey, overrides: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(JSON.stringify({ issuedAt: now, expiresAt: now + 60, nonce: randomUUID(),
    requestHash: crmPayloadDigest(requestBody), ...overrides })).toString("base64url");
  const signature = sign(null, Buffer.from(`${autonomousDelegationDomain}.${id}.${payload}`), privateKey).toString("base64url");
  return `v1.${id}.${payload}.${signature}`;
}
async function call(requestBody = body(), credential = delegation(requestBody), headers: Record<string, string> = {}, auth = machineAuth()) {
  const response = await handleAutonomousCrmAccess(new Request(`https://crm.example.invalid${autonomousAccessPath}`, {
    method: "POST", headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json",
      "x-evelyn-delegation": credential, ...headers }, body: JSON.stringify(requestBody),
  }), { pool: db.pool as unknown as TenantPool, machineAuth: auth });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}
function registration(overrides: Partial<AutonomousCrmRegistration> = {}): AutonomousCrmRegistration {
  return { workloadId, workloadActorId: actorId, grantId, actorId, projectId, sourceId, taskId: missionId,
    departmentId: "IT_CRM", agentId: "evelyn.engineering.worker-1", entity: "Task",
    scopes: ["crm.tasks.read", "crm.tasks.write"], publicKey: key.publicKey.export({ format: "der", type: "spki" }).toString("base64url"),
    authorityReference: "SYNTHETIC separate real-internal registration acceptance", expiresAt: null, ...overrides };
}
async function provision(input = registration()) {
  const client = await db.admin.connect();
  try { await client.query("set role autonomous_test_installer"); return await registerAutonomousCrmAccess(client, input); }
  finally { await client.query("reset role"); client.release(); }
}

before(async () => {
  db = await startLocalSalesDb();
  await applySalesSchema(db, { maxMigrationNumber: 90 });
  await db.admin.query("insert into workspaces(id,name,operating_model,customer_type) values($1,'SYNTHETIC internal broker','novalure_internal','novalure_internal') on conflict(id) do update set operating_model='novalure_internal',customer_type='novalure_internal'", [CRM_MACHINE_WORKSPACE_ID]);
  await db.admin.query("insert into workspace_users(id,workspace_id,name,email,role,product_role,status) values($1,$2,'SYNTHETIC service actor','internal-agent@service.invalid','agent','novalure_operator','active')", [actorId, CRM_MACHINE_WORKSPACE_ID]);
  for (const id of [projectId, foreignProject]) await db.admin.query("insert into projects(id,workspace_id,name,type,status) values($1,$2,'SYNTHETIC internal project','Internal','Aktiv')", [id, CRM_MACHINE_WORKSPACE_ID]);
  for (const [id, project, classification] of [[sourceId, projectId, "NOVALURE_INTERNAL"], [foreignTask, foreignProject, "NOVALURE_INTERNAL"], [privateTask, projectId, "PRIVATE_FRANZ"]]) {
    await db.admin.query("insert into tasks(id,workspace_id,project_id,title,data_classification) values($1,$2,$3,'SYNTHETIC internal task',$4)", [id, CRM_MACHINE_WORKSPACE_ID, project, classification]);
  }
  await db.admin.query("insert into project_pipeline_permissions(workspace_id,project_id,user_id,can_read,can_edit_deals) values($1,$2,$3,true,true)", [CRM_MACHINE_WORKSPACE_ID, projectId, actorId]);
  await db.admin.query("create role autonomous_test_installer nologin nosuperuser nocreatedb nocreaterole noreplication nobypassrls");
  await db.admin.query("grant usage,create on schema public to autonomous_test_installer; grant references on projects to autonomous_test_installer; grant execute on function crm_reject_immutable_mutation() to autonomous_test_installer");
  // Exercise the real migration and bootstrap with a distinct owner that has
  // neither superuser nor BYPASSRLS and no personal/session context.
  for (const table of ["workspaces", "workspace_users", "project_pipeline_permissions"]) {
    await db.admin.query(`alter table ${table} owner to autonomous_test_installer; alter table ${table} enable row level security; alter table ${table} force row level security`);
  }
  // The historical fixture leaves these metadata relations unfiltered. This
  // extra FORCE-RLS probe supplies only the usual current tenant/actor view
  // while the new bootstrap owner must use its separate narrow policies.
  await db.admin.query("create policy autonomous_fixture_workspace on workspaces for select to novalure_tenant_app using(id=nullif(current_setting('app.tenant_id',true),'')::uuid)");
  await db.admin.query("create policy autonomous_fixture_member on workspace_users for select to novalure_tenant_app using(workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid and id=nullif(current_setting('app.actor_id',true),'')::uuid)");
  await db.admin.query("create policy autonomous_fixture_project_grant on project_pipeline_permissions for select to novalure_tenant_app using(workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid and user_id=nullif(current_setting('app.actor_id',true),'')::uuid)");
  const client = await db.admin.connect();
  try {
    await client.query("set role autonomous_test_installer");
    await client.query(await readFile("migrations/staged/evelyn_autonomous_access.sql", "utf8"));
  } finally { await client.query("reset role"); client.release(); }
});
after(async () => { await closeLocalTestPool(); if (db) await db.stop(); });

test("native personal JWT and separate registered grant survive staged upgrade without legacy promotion or crossmix", async () => {
  // Existing production registration still works before the additive upgrade.
  await provision();
  assert.equal((await call()).status, 200);
  const installer = await db.admin.connect();
  try {
    await installer.query("set role autonomous_test_installer");
    await installer.query("begin");
    await installer.query(await readFile("migrations/staged/evelyn_autonomous_personal_source.sql", "utf8"));
    await installer.query("commit");
    await assert.rejects(installer.query(`insert into crm_autonomous_workloads(id,identity_id,workspace_id,actor_user_id,issuer,audience,
      project_id,owner_id,subject,environment,custom_environment_id,authority_reference)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'SYNTHETIC crossmix must deny')`,
    [randomUUID(), CRM_PERSONAL_SOURCE.identityId, CRM_MACHINE_WORKSPACE_ID, actorId, CRM_MACHINE_ISSUER, CRM_MACHINE_AUDIENCE,
      CRM_MACHINE_PROJECT_ID, CRM_MACHINE_OWNER_ID, CRM_MACHINE_SUBJECT, CRM_PERSONAL_SOURCE.environment, CRM_PERSONAL_SOURCE.customEnvironmentId]),
    /crm_autonomous_workload_source_bundle/);
  } finally { await installer.query("reset role"); installer.release(); }
  assert.equal((await call()).status, 200, "legacy production route survives the additive upgrade");
  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }), nativeKey = generateKeyPairSync("ed25519");
  const native = registration({ sourceProfile: "FRANZ_PERSONAL", workloadId: randomUUID(), grantId: randomUUID(),
    publicKey: nativeKey.publicKey.export({ format: "der", type: "spki" }).toString("base64url") });
  let verifications = 0;
  const verified: NonNullable<CrmMachineAuthOptions["verifier"]> = async (token, options) => {
    verifications++;
    return jwtVerify(token, rsa.publicKey, options as JWTVerifyOptions) as ReturnType<NonNullable<CrmMachineAuthOptions["verifier"]>>;
  };
  const token = (override: Record<string, unknown> = {}, signer = rsa.privateKey) => {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({ aud: CRM_MACHINE_AUDIENCE, iss: CRM_MACHINE_ISSUER, sub: CRM_PERSONAL_SOURCE.subject,
      project_id: CRM_MACHINE_PROJECT_ID, owner_id: CRM_MACHINE_OWNER_ID, environment: CRM_PERSONAL_SOURCE.environment,
      custom_environment_id: CRM_PERSONAL_SOURCE.customEnvironmentId, iat: now, nbf: now, exp: now + 60, jti: randomUUID(), ...override })
      .setProtectedHeader({ alg: "RS256", typ: "JWT", kid: "synthetic-native-rsa" }).sign(signer);
  };
  const nativeAuth = (enabled = true, global: "1" | "0" | "ABSENT" = "1"): CrmMachineAuthOptions => ({ env: {
    VERCEL_ENV: "production", NODE_ENV: "production", ...(global !== "ABSENT" ? { CRM_MACHINE_AUTH_ENABLED: global } : {}),
    ...(enabled ? { CRM_AUTONOMOUS_PERSONAL_SOURCE_ENABLED: "1" } : {}) }, verifier: verified });
  const nativeCall = async (jwt: string, input = body({ operation: "DescribeAssignment" }), id = native.grantId,
    signer = nativeKey.privateKey, enabled = true, global: "1" | "0" | "ABSENT" = "1") => {
    const response = await handleAutonomousCrmAccess(new Request(`https://crm.example.invalid${autonomousAccessPath}`, {
      method: "POST", headers: { authorization: `Bearer ${jwt}`, "content-type": "application/json", "x-evelyn-delegation": delegation(input, id, signer) },
      body: JSON.stringify(input) }), { pool: db.pool as unknown as TenantPool, machineAuth: nativeAuth(enabled, global) });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  };
  const credential = await token();
  assert.equal((await nativeCall(credential)).status, 403, "OIDC before separate registration is insufficient");
  assert.equal((await provision(native)).status, "REGISTERED");
  assert.equal((await provision(native)).status, "REGISTERED");
  await assert.rejects(provision({ ...native, sourceProfile: "PRODUCTION" }), /WORKLOAD_CONFLICT/);
  assert.notEqual((await nativeCall(credential, undefined, undefined, undefined, false)).status, 200, "native source is disabled by default");
  for (const global of ["0", "ABSENT"] as const) {
    const before = verifications;
    assert.equal((await nativeCall(credential, undefined, undefined, undefined, true, global)).status, 403);
    assert.equal(verifications, before, "global machine STOP denies before any legacy or personal JWT verification");
  }
  const described = await nativeCall(credential); assert.equal(described.status, 200, JSON.stringify(described.body));
  assert.deepEqual((described.body.data as { operations: string[] }).operations, ["Read", "UpdateTask"]);
  assert.equal((await nativeCall(credential, body())).status, 200);
  const update = body({ operation: "UpdateTask", expectedVersion: 1, patch: { title: "SYNTHETIC native title" } });
  const written = await nativeCall(credential, update); assert.equal(written.status, 200, JSON.stringify(written.body));
  const audit = (await db.admin.query("select after from audit_logs where id=$1", [written.body.auditReference])).rows[0].after;
  assert.equal(audit.actor.identityId, CRM_PERSONAL_SOURCE.identityId); assert.equal(audit.actor.environment, "franz-personal");
  assert.equal((await nativeCall(credential, update)).body.replayed, true);
  const eventCount = (await db.admin.query("select count(*) from crm_autonomous_access_events")).rows[0].count;
  for (const override of [{ environment: "production" }, { sub: CRM_MACHINE_SUBJECT }, { custom_environment_id: null },
    { custom_environment_id: "env_other" }, { owner_id: "team_other" }, { project_id: "prj_other" },
    { aud: "other-audience" }, { iat: Math.floor(Date.now() / 1000) - 301 }, { exp: Math.floor(Date.now() / 1000) - 1 }])
    assert.notEqual((await nativeCall(await token(override))).status, 200, JSON.stringify(override));
  assert.notEqual((await nativeCall(await token({}, generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey))).status, 200);
  assert.equal((await nativeCall(credential, body(), grantId, key.privateKey)).status, 403, "native cannot use a production grant/key");
  const prod = await token({ sub: CRM_MACHINE_SUBJECT, environment: CRM_MACHINE_ENVIRONMENT, custom_environment_id: null });
  assert.equal((await nativeCall(prod)).status, 403, "production cannot use the native grant/key");
  assert.equal((await nativeCall(credential, body(), native.grantId, key.privateKey)).status, 401);
  const runtime = await db.pool.connect();
  try {
    const params = [CRM_MACHINE_ISSUER, CRM_MACHINE_AUDIENCE, CRM_MACHINE_PROJECT_ID, CRM_MACHINE_OWNER_ID,
      CRM_PERSONAL_SOURCE.subject, CRM_MACHINE_WORKSPACE_ID, CRM_PERSONAL_SOURCE.environment];
    assert.equal((await runtime.query("select * from crm_authenticate_autonomous_workload($1,$2,$3,$4,$5,$6,$7)", params)).rowCount, 0);
    assert.equal((await runtime.query("select * from crm_authenticate_personal_autonomous_workload($1,$2,$3,$4,$5,$6,$7,$8)", [...params, "env_other"])).rowCount, 0);
    await assert.rejects(runtime.query("select * from crm_autonomous_workloads"), /permission denied/);
  } finally { runtime.release(); }
  await db.admin.query("update crm_autonomous_access_grants set revoked_at=clock_timestamp() where id=$1", [native.grantId]);
  assert.equal((await nativeCall(credential)).status, 403);
  assert.equal((await db.admin.query("select count(*) from crm_autonomous_access_events")).rows[0].count, eventCount);
});

