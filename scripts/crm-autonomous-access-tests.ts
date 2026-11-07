import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID, sign, type KeyObject } from "node:crypto";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { autonomousAccessContract, autonomousAccessPath, autonomousDelegationDomain, handleAutonomousCrmAccess } from "../src/lib/crm-autonomous-access";
import { autonomousCrmDepartments, registerAutonomousCrmAccess, type AutonomousCrmRegistration } from "../src/lib/crm-autonomous-registration";
import { crmPayloadDigest } from "../src/lib/crm-command";
import { CRM_MACHINE_AUDIENCE, CRM_MACHINE_ENVIRONMENT, CRM_MACHINE_ISSUER, CRM_MACHINE_OWNER_ID,
  CRM_MACHINE_PROJECT_ID, CRM_MACHINE_SUBJECT, CRM_MACHINE_WORKSPACE_ID, type CrmMachineAuthOptions } from "../src/lib/crm-machine-auth";
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

test("OIDC and the existing synthetic identity confer no real authority before separate registration", async () => {
  assert.equal((await call()).status, 403);
  assert.equal((await db.admin.query("select count(*) from crm_autonomous_access_events")).rows[0].count, "0");
});
test("protected noninteractive owner registers durable scope idempotently and runtime cannot self-register", async () => {
  assert.equal((await provision()).status, "REGISTERED");
  assert.equal((await provision()).status, "REGISTERED");
  const c = await db.pool.connect();
  try {
    await assert.rejects(c.query("insert into crm_autonomous_access_grants select * from crm_autonomous_access_grants"), /permission denied/);
    await assert.rejects(c.query("select * from crm_autonomous_workloads"), /permission denied/);
    await assert.rejects(registerAutonomousCrmAccess(c, registration()), /BOOTSTRAP_OWNER_REQUIRED/);
  } finally { c.release(); }
  const owner = await db.admin.connect();
  try {
    await owner.query("set role autonomous_test_installer");
    await assert.rejects(owner.query("update workspace_users set status='suspended' where id=$1", [actorId]), /row-level security/);
    const rows = (await owner.query("select distinct workspace_id from workspace_users")).rows;
    assert.deepEqual(rows.map(row => row.workspace_id), [CRM_MACHINE_WORKSPACE_ID]);
  } finally { await owner.query("reset role"); owner.release(); }
});
test("real internal Task read uses saved department/subagent/task and has a durable successful audit", async () => {
  const result = await call(); assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.departmentId, "IT_CRM"); assert.equal(result.body.agentId, registration().agentId);
  assert.equal(result.body.taskId, missionId); assert.deepEqual(Object.keys(result.body.data as object).sort(), ["priority", "status", "title", "updatedAt", "version"]);
  const event = (await db.admin.query("select * from crm_autonomous_access_events where audit_reference=$1", [result.body.auditReference])).rows[0];
  assert.equal(event.department_id, "IT_CRM"); assert.equal(event.agent_id, registration().agentId); assert.equal(event.task_id, missionId);
});
test("OIDC alone, body actor overrides, another key and tampered or stale delegation are denied", async () => {
  const input = body();
  assert.equal((await call(input, "")).status, 401);
  assert.equal((await call(body({ departmentId: "HR" }))).status, 400);
  assert.equal((await call(input, delegation(input, grantId, generateKeyPairSync("ed25519").privateKey))).status, 401);
  assert.equal((await call(body({ operation: "UpdateTask", expectedVersion: 1, patch: { title: "SYNTHETIC tampered" } }), delegation(input))).status, 401);
  assert.equal((await call(input, delegation(input, grantId, key.privateKey, { expiresAt: Math.floor(Date.now() / 1000) - 1 }))).status, 401);
  assert.equal((await call(input, delegation(input, grantId, key.privateKey, { expiresAt: Math.floor(Date.now() / 1000) + 301 }))).status, 401);
  assert.equal((await call(input, delegation(input), { cookie: "owner=pretended" })).status, 401);
});
test("nonce replay is durable and a fresh signed retry preserves exact write idempotency", async () => {
  const input = body({ operation: "UpdateTask", expectedVersion: 1, patch: { title: "SYNTHETIC delegated task change" } });
  const credential = delegation(input);
  const first = await call(input, credential); assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal((await call(input, credential)).status, 409);
  const retry = await call(input); assert.equal(retry.status, 200, JSON.stringify(retry.body)); assert.equal(retry.body.replayed, true);
  assert.equal((retry.body.data as {version:number}).version, 2);
  const conflict = { ...input, patch: { title: "SYNTHETIC conflicting update" } };
  assert.equal((await call(conflict)).status, 409);
  assert.equal((await db.admin.query("select version from tasks where id=$1", [sourceId])).rows[0].version, "2");
  const audit = (await db.admin.query("select after from audit_logs where id=$1", [first.body.auditReference])).rows[0].after;
  assert.equal(audit.actor.identityId, "EVELYN_CRM_AUTONOMOUS_INTERNAL_IDENTITY");
});
test("parallel writes preserve one effect and stale versions add no successful access event", async () => {
  const input = body({ operation: "UpdateTask", expectedVersion: 2, patch: { title: "SYNTHETIC parallel retry" } });
  const results = await Promise.all([call(input), call(input)]); assert.deepEqual(results.map(r => r.status), [200, 200]);
  assert.deepEqual(results.map(r => r.body.replayed).sort(), [false, true]);
  const count = (await db.admin.query("select count(*) from crm_autonomous_access_events")).rows[0].count;
  assert.equal((await call(body({ operation: "UpdateTask", expectedVersion: 1, patch: { title: "SYNTHETIC stale" } }))).status, 409);
  assert.equal((await db.admin.query("select count(*) from crm_autonomous_access_events")).rows[0].count, count);
});
test("explicit project permission revocation still denies the internal operator", async () => {
  await db.admin.query("update project_pipeline_permissions set can_read=false where project_id=$1 and user_id=$2", [projectId, actorId]);
  try { assert.equal((await call()).status, 403); }
  finally { await db.admin.query("update project_pipeline_permissions set can_read=true where project_id=$1 and user_id=$2", [projectId, actorId]); }
});
test("workload/grant kill, role changes and revoked assignments are checked on every request", async () => {
  for (const [table, id, patch, restore] of [
    ["crm_autonomous_access_grants", grantId, "revoked_at=clock_timestamp()", "revoked_at=null"],
    ["crm_autonomous_workloads", workloadId, "kill_switch_active=true", "kill_switch_active=false"],
    ["workspace_users", actorId, "status='suspended'", "status='active'"],
  ]) {
    await db.admin.query(`update ${table} set ${patch} where id=$1`, [id]);
    try { assert.equal((await call()).status, 403); }
    finally { await db.admin.query(`update ${table} set ${restore} where id=$1`, [id]); }
  }
  await assert.rejects(db.admin.query("update crm_autonomous_access_grants set department_id='HR' where id=$1", [grantId]), /Replace a revoked registration/);
});
test("expiry during nonce, command and resource lock waits denies output/effect without a success audit", async () => {
  for (const mode of ["nonce", "command", "write-row", "read-row"]) {
    const input = mode === "nonce" || mode === "read-row" ? body()
      : body({ operation: "UpdateTask", expectedVersion: 3, patch: { title: "SYNTHETIC must expire before effect" } });
    const nonce = randomUUID(), now = Math.floor(Date.now() / 1000);
    const credential = delegation(input, grantId, key.privateKey, { nonce, issuedAt: now, expiresAt: now + 2 });
    const lock = await db.admin.connect();
    await lock.query("begin");
    try {
      if (mode === "nonce" || mode === "command") {
        const lockId = mode === "nonce" ? `autonomous-access:${grantId}:${nonce}`
          : `crm-command:${CRM_MACHINE_WORKSPACE_ID}:${input.idempotencyKey}`;
        await lock.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [lockId]);
      } else await lock.query("select id from tasks where id=$1 for update", [sourceId]);
      const pending = call(input, credential);
      let waiting = false;
      for (let attempt = 0; attempt < 100 && !waiting; attempt++) {
        waiting = ((await db.admin.query("select 1 from pg_stat_activity where wait_event in ('advisory','transactionid','tuple')")).rowCount ?? 0) > 0;
        if (!waiting) await delay(10);
      }
      assert.equal(waiting, true, `request must actually wait on ${mode}`);
      await delay(Math.max(0, (now + 2) * 1000 - Date.now() + 25));
      await lock.query("commit");
      assert.equal((await pending).status, 401, mode);
      assert.equal((await db.admin.query("select count(*) from crm_autonomous_access_events where nonce=$1", [nonce])).rows[0].count, "0");
      assert.equal((await db.admin.query("select version from tasks where id=$1", [sourceId])).rows[0].version, "3");
    } finally { await lock.query("rollback"); lock.release(); }
  }
});
test("explicit grant expiry stops calls while default registrations remain durable", async () => {
  const limited = registration({ grantId: randomUUID(), expiresAt: new Date(Date.now() + 150).toISOString() });
  await provision(limited); await delay(170);
  const input = body(); assert.equal((await call(input, delegation(input, limited.grantId))).status, 403);
  assert.equal((await call()).status, 200);
});
test("wrong project/private data cannot be read even through a saved grant", async () => {
  for (const id of [foreignTask, privateTask]) {
    const input = registration({ grantId: randomUUID(), sourceId: id }); await provision(input);
    const requestBody = body(); assert.equal((await call(requestBody, delegation(requestBody, input.grantId))).status, 403);
  }
});
test("all sixteen departments use explicit individual assignments and minimized Project reads", async () => {
  for (const departmentId of autonomousCrmDepartments) {
    const input = registration({ grantId: randomUUID(), sourceId: projectId, entity: "Project", scopes: ["crm.projects.read"], departmentId });
    await provision(input); const requestBody = body(); const result = await call(requestBody, delegation(requestBody, input.grantId));
    assert.equal(result.status, 200, JSON.stringify(result.body)); assert.equal(result.body.departmentId, departmentId);
    assert.deepEqual(Object.keys(result.body.data as object).sort(), ["name", "status", "type", "updatedAt"]);
  }
});
test("event attribution is DB bound to the stored grant and append-only", async () => {
  const c = await db.pool.connect();
  try {
    await c.query("begin"); await c.query("select set_config('app.tenant_id',$1,true),set_config('app.actor_id',$2,true)", [CRM_MACHINE_WORKSPACE_ID, actorId]);
    await assert.rejects(c.query(`insert into crm_autonomous_access_events(grant_id,nonce,workspace_id,actor_user_id,department_id,agent_id,task_id,
      project_id,source_id,action,request_hash,oidc_jti_hash,audit_reference,outcome) values($1,$2,$3,$4,'HR',$5,$6,$7,$8,'crm.tasks.read',$9,$9,$10,'SUCCESS')`,
    [grantId, randomUUID(), CRM_MACHINE_WORKSPACE_ID, actorId, registration().agentId, missionId, projectId, sourceId, "a".repeat(64), randomUUID()]), /foreign key/);
    await c.query("rollback");
    await assert.rejects(c.query("update crm_autonomous_access_events set department_id='HR'"), /permission denied/);
  } finally { await c.query("rollback"); c.release(); }
});
