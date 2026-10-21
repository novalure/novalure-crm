import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { qaLivegangUuid, seedQaLivegang } from "./qa-livegang-seed.mjs";
import { qaSeedOwnerUrl, withQaSeedOwner, withQaSeedRuntimeTenant } from "./lib/qa-livegang-seed-bootstrap.mjs";

const runPrefix = "GOLIVETEST_seed_regression";
const host = "ep-synthetic-seed-pooler.c-8.eu-central-1.aws.neon.tech";
const qaTarget = { runPrefix, expectedRole: "novalure_app", expectedDatabase: "neondb", expectedProjectId: "synthetic-qa-project",
  expectedBranchId: "synthetic-qa-branch", expectedHost: host };
const id = (key) => qaLivegangUuid(runPrefix, key);
const workspaces = ["internal", "developer", "broker"].map((key) => id(`workspace:${key}`));
const scope = { workspaceIds: workspaces,
  users: ["platform-admin", "platform-admin:developer", "platform-admin:broker", "assistant", "developer-sales", "broker-sales"].map((key, index) => ({
    id: id(`user:${key}`), workspaceId: workspaces[index < 3 ? index : index - 3],
    email: `qa-${key.startsWith("platform-admin") ? "platform-admin" : key}+${runPrefix.toLowerCase()}@novalure.local`,
  })),
  projects: workspaces.map((workspaceId) => ({ id: id(`project:${workspaceId}`), workspaceId })),
};
function ownerEnvironment() {
  const url = new URL(`postgresql://neondb_owner@${host.replace("-pooler.", ".")}/neondb?sslmode=verify-full`);
  url.password = "synthetic-fixture-only";
  return { MIGRATION_DATABASE_URL: url.toString(), NOVALURE_QA_MIGRATION_DATABASE_HOST: url.hostname,
    NOVALURE_QA_MIGRATION_DATABASE_ROLE: "neondb_owner", NOVALURE_PRODUCTION_DATABASE_HOST: "ep-live-pooler.c-8.eu-central-1.aws.neon.tech",
    NOVALURE_PRODUCTION_MIGRATION_DATABASE_HOST: "ep-live.c-8.eu-central-1.aws.neon.tech" };
}
function ownerPort({ role = "neondb_owner", workspaceRows = [], userRows = [], identityRows = [] } = {}) {
  const events = [], client = new EventEmitter(), pool = new EventEmitter();
  client.query = async (sql) => {
    events.push(sql.trim().split(/\s+/, 2).join(" "));
    if (sql.includes("current_user as role")) return { rows: [{ project: qaTarget.expectedProjectId, branch: qaTarget.expectedBranchId,
      database: qaTarget.expectedDatabase, role, session_role: role }] };
    if (sql.includes("from public.workspaces where")) return { rows: workspaceRows };
    if (sql.includes("from public.workspace_users")) return { rows: userRows };
    if (sql.includes("from public.auth_identities")) return { rows: identityRows };
    return { rows: [] };
  };
  client.release = () => events.push("release");
  pool.connect = async () => client;
  pool.end = async () => { events.push("end"); client.emit("end"); };
  return { pool, events };
}

test("importing the seed neither loads dotenv files nor starts a database operation", () => {
  const source = `import fs from 'node:fs'; const exists=fs.existsSync; fs.existsSync=(file)=>{if(/(?:^|\\/)\\.env(?:\\.|$)/.test(String(file)))throw Error('DOTENV_ON_IMPORT');return exists(file)};
    globalThis.fetch=()=>{throw Error('NETWORK_ON_IMPORT')}; await import(${JSON.stringify(new URL("./qa-livegang-seed.mjs", import.meta.url).href)}); process.stdout.write('IMPORTED');`;
  assert.equal(execFileSync(process.execPath, ["--input-type=module", "--eval", source], { encoding: "utf8", env: { PATH: process.env.PATH } }), "IMPORTED");
});

test("owner transport requires exact separate direct QA target and Production deny hosts", () => {
  const env = ownerEnvironment();
  assert.equal(new URL(qaSeedOwnerUrl(qaTarget, env)).hostname, env.NOVALURE_QA_MIGRATION_DATABASE_HOST);
  for (const delta of [
    { NOVALURE_QA_MIGRATION_DATABASE_ROLE: "novalure_app" },
    { NOVALURE_QA_MIGRATION_DATABASE_HOST: host },
    { NOVALURE_PRODUCTION_MIGRATION_DATABASE_HOST: env.NOVALURE_QA_MIGRATION_DATABASE_HOST },
    { MIGRATION_DATABASE_URL: env.MIGRATION_DATABASE_URL.replace("verify-full", "require") },
    { MIGRATION_DATABASE_URL: env.MIGRATION_DATABASE_URL + "&options=unsafe" },
  ]) assert.throws(() => qaSeedOwnerUrl(qaTarget, { ...env, ...delta }), /QA_SEED_OWNER_TARGET_DENIED/);
  assert.throws(() => qaSeedOwnerUrl(qaTarget, { ...env, MIGRATION_DATABASE_URL: "" }), /QA_SEED_OWNER_URL_INVALID/);
});

test("weak seed passwords fail before every database or owner connection", async () => {
  let calls = 0;
  await assert.rejects(seedQaLivegang({ qaTarget, qaPassword: "short", runtimePool: { query: () => { calls++; } },
    ownerPoolFactory: () => { calls++; } }), /QA_SEED_INPUT_INVALID/);
  assert.equal(calls, 0);
});

test("the fixture owner port rejects an actual runtime identity before provisioning", async () => {
  const port = ownerPort({ role: "novalure_app" }); let entered = false;
  await assert.rejects(withQaSeedOwner({ qaTarget, scope, phase: "identities", ownerPoolFactory: () => port.pool }, () => { entered = true; }), /QA_SEED_OWNER_IDENTITY_DENIED/);
  assert.equal(entered, false); assert.ok(port.events.includes("rollback")); assert.deepEqual(port.events.slice(-2), ["release", "end"]);
});

test("foreign QA markers, memberships and orphaned central identities stop before password upserts", async () => {
  for (const setup of [
    { workspaceRows: [{ id: workspaces[0], is_qa: true, run: "GOLIVETEST_foreign_marker" }] },
    { userRows: [{ id: scope.users[0].id, workspace_id: id("foreign"), email: scope.users[0].email }] },
    { identityRows: [{ id: id("foreign-auth"), normalized_email: scope.users[0].email }] },
  ]) {
    const port = ownerPort(setup); let entered = false;
    await assert.rejects(withQaSeedOwner({ qaTarget, scope, phase: "identities", ownerPoolFactory: () => port.pool }, () => { entered = true; }), /QA_SEED_FOREIGN_/);
    assert.equal(entered, false); assert.ok(port.events.includes("rollback")); assert.equal(port.events.at(-1), "end");
  }
});

test("owner bootstrap closes before returning and rejects business-table writes", async () => {
  const port = ownerPort();
  await withQaSeedOwner({ qaTarget, scope, phase: "identities", ownerPoolFactory: () => port.pool }, async () => {});
  assert.deepEqual(port.events.slice(-3), ["commit", "release", "end"]);
  const denied = ownerPort();
  await assert.rejects(withQaSeedOwner({ qaTarget, scope, phase: "identities", ownerPoolFactory: () => denied.pool },
    (query) => query("insert into projects(id) values($1)", [scope.projects[0].id])), /QA_SEED_OWNER_WRITE_SCOPE_DENIED/);
  assert.ok(denied.events.includes("rollback")); assert.equal(denied.events.at(-1), "end");
});

function runtimePort({ rollbackFails = false } = {}) {
  const client = new EventEmitter(), pool = new EventEmitter(), events = [];
  let connects = 0, closes = 0, poisoned = false;
  client.query = async (sql, params = []) => {
    events.push(sql.trim().split(/\s+/, 2).join(" "));
    if (sql.includes("current_user as role")) return { rows: [{ role: "novalure_app", session_role: "novalure_app",
      database: qaTarget.expectedDatabase, project: qaTarget.expectedProjectId, branch: qaTarget.expectedBranchId }] };
    if (sql.includes("set_config")) return { rows: [{ workspace_id: params[0], actor_id: params[1] }] };
    if (sql === "rollback" && rollbackFails) throw new Error("SYNTHETIC_ROLLBACK_FAILURE");
    return { rows: [] };
  };
  client.release = (destroy) => {
    events.push(destroy ? "destroy" : "release");
    if (destroy) queueMicrotask(() => {
      // A second driver error during asynchronous shutdown must remain handled.
      client.emit("error", new Error("SYNTHETIC_CLOSE_ERROR"));
      client.emit("end");
    });
  };
  pool.connect = async () => { connects++; return client; };
  pool.end = async () => { closes++; events.push("pool.end"); };
  const options = { pool, qaTarget, workspaceId: workspaces[0], actorId: scope.users[0].id,
    isFailed: () => poisoned, onError: () => { poisoned = true; } };
  return { client, pool, events, options, counts: () => ({ connects, closes }) };
}

for (const phase of ["between queries", "before COMMIT"]) {
  test(`an active runtime client error ${phase} poisons the seed without replay or COMMIT`, async () => {
    const port = runtimePort();
    try {
      await assert.rejects(withQaSeedRuntimeTenant(port.options, async (query) => {
        await query("select first_fixture_check");
        port.client.emit("error", new Error("SYNTHETIC_CONNECTION_LOSS"));
        if (phase === "between queries") await query("select forbidden_next_query");
      }), /QA_SEED_RUNTIME_CONNECTION_FAILED/);
      assert.equal(port.events.includes("select forbidden_next_query"), false);
      assert.equal(port.events.includes("commit"), false);
      assert.equal(port.events.includes("rollback"), false); // A dead connection is destroyed, not queried again.
      assert.equal(port.events.at(-1), "destroy");
      assert.equal(port.client.listenerCount("error"), 0);
      await assert.rejects(withQaSeedRuntimeTenant(port.options, async () => {}), /QA_SEED_RUNTIME_CONNECTION_FAILED/);
      assert.equal(port.counts().connects, 1);
    } finally { await port.pool.end(); }
    assert.deepEqual(port.counts(), { connects: 1, closes: 1 });
  });
}

test("a normal runtime SQL failure rolls back, preserves the error and releases the connection", async () => {
  const port = runtimePort(), failure = Object.assign(new Error("SYNTHETIC_SQL_FAILURE"), { code: "42501" });
  try {
    await assert.rejects(withQaSeedRuntimeTenant(port.options, async () => { throw failure; }), (error) => error === failure);
    assert.deepEqual(port.events.slice(-2), ["rollback", "release"]);
    assert.equal(port.events.includes("commit"), false);
    assert.equal(port.client.listenerCount("error"), 0);
    assert.equal(port.client.listenerCount("end"), 0);
  } finally { await port.pool.end(); }
  assert.deepEqual(port.counts(), { connects: 1, closes: 1 });
});

test("an unacknowledged rollback destroys the runtime client while preserving the original failure", async () => {
  const port = runtimePort({ rollbackFails: true }), failure = new Error("SYNTHETIC_ORIGINAL_FAILURE");
  try {
    await assert.rejects(withQaSeedRuntimeTenant(port.options, async () => { throw failure; }), (error) => error === failure);
    assert.deepEqual(port.events.slice(-2), ["rollback", "destroy"]);
    assert.equal(port.events.includes("commit"), false);
    assert.equal(port.counts().connects, 1);
  } finally { await port.pool.end(); }
  assert.deepEqual(port.counts(), { connects: 1, closes: 1 });
});

test("the healthy runtime transaction verifies context and commits once before releasing", async () => {
  const port = runtimePort();
  try {
    const result = await withQaSeedRuntimeTenant(port.options, async (query) => {
      await query("select scoped_fixture_check"); return "complete";
    });
    assert.equal(result, "complete");
    assert.deepEqual(port.events.slice(-3), ["select scoped_fixture_check", "commit", "release"]);
    assert.equal(port.client.listenerCount("error"), 0);
    assert.equal(port.client.listenerCount("end"), 0);
  } finally { await port.pool.end(); }
  assert.deepEqual(port.counts(), { connects: 1, closes: 1 });
});
