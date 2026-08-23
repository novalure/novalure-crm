import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { crmTables } from "../src/lib/db/schema.ts";
import {
  assertQaResetExecutionAuthorized,
  assertQaResetWorkspaceAllowlisted,
  canAdministerQaReset,
  parseQaResetRequest,
  qaResetCascadeOwnedTables,
  qaResetConfirmation,
  qaResetDatabaseTables,
  qaResetRetainedTables,
  resolveQaResetWorkspaceAllowlist,
} from "../src/lib/qa-reset-contract.ts";

const workspaceA = "11111111-1111-4111-8111-111111111111";
const workspaceB = "22222222-2222-4222-8222-222222222222";
const productionWorkspace = "33333333-3333-4333-8333-333333333333";
const batchId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const actorId = "77777777-7777-4777-8777-777777777777";
const syntacticallyValidPlanDigest = "0".repeat(64);
const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("@/")) {
      return {
        shortCircuit: true,
        url: pathToFileURL(path.resolve(repositoryRoot, "src", `${specifier.slice(2)}.ts`)).href,
      };
    }
    return nextResolve(specifier, context);
  },
});

const qaResetRepository = import("../src/lib/db/qa-reset-repository.ts");
const qaBatchRegistrationRepository = import("../src/lib/db/qa-batch-registration-repository.ts");

const platformAdmin = {
  permissions: ["settings:manage"],
  productPermissions: ["novalure:internal", "settings:manage"],
  productRole: "platform_admin",
  role: "owner",
  source: "cookie",
};

function fakeTransaction(handler) {
  const calls = [];
  const invoke = async (kind, sql, params = []) => {
    calls.push({ kind, params, sql });
    return handler({ kind, params, sql, calls });
  };
  return {
    calls,
    transaction: {
      execute: (sql, params) => invoke("execute", sql, params),
      query: async (sql, params) => (await invoke("query", sql, params)) ?? [],
      queryOne: async (sql, params) => (await invoke("queryOne", sql, params)) ?? null,
    },
  };
}

function repositoryFixture(overrides = {}) {
  const targetId = overrides.targetId ?? "44444444-4444-4444-8444-444444444444";
  return fakeTransaction(({ sql }) => {
    if (/from workspaces where/i.test(sql)) {
      return { id: workspaceA, isQa: overrides.isQa ?? true };
    }
    if (/from qa_batches/i.test(sql)) {
      return overrides.batchMissing
        ? null
        : { batchMarker: "QA-TEST-20260822-1200-reset01", id: batchId, workspaceId: workspaceA };
    }
    if (/from qa_reset_audit_events/i.test(sql)) {
      return overrides.executedAudit
        ? { id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" }
        : null;
    }
    if (/from qa_batch_objects/i.test(sql)) {
      return overrides.ledgerRows ?? [{ resourceId: targetId, resourceScope: "database", resourceType: "tasks" }];
    }
    if (/from pg_constraint constraint_record/i.test(sql)) return overrides.foreignKeys ?? [];
    if (/insert into qa_reset_audit_events/i.test(sql)) {
      return { id: "55555555-5555-4555-8555-555555555555" };
    }
    if (/select target\.id::text as id\s+from "tasks" target/i.test(sql)) {
      return overrides.missingTarget ? [] : [{ id: targetId }];
    }
    if (/delete from "tasks" target/i.test(sql)) return [{ id: targetId }];
    if (/select target\.id::text as id\s+from "contacts" target/i.test(sql)) {
      return [{ id: targetId }];
    }
    if (/select target\.id::text as id\s+from "property_units" target/i.test(sql)) {
      return [{ id: targetId }];
    }
    if (/select target\.id::text as id\s+from "property_buildings" target/i.test(sql)) {
      return [{ id: targetId }];
    }
    if (/from "leads" child/i.test(sql)) {
      return overrides.leadRows ?? [{ id: "66666666-6666-4666-8666-666666666666" }];
    }
    if (/from "property_unit_idempotency" child/i.test(sql)) {
      return [{ id: "88888888-8888-4888-8888-888888888888" }];
    }
    if (/from "property_building_idempotency" child/i.test(sql)) {
      return [{ id: "99999999-9999-4999-8999-999999999999" }];
    }
    return [];
  });
}

function deferred() {
  let resolve;
  const promise = new Promise((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function withTimeout(promise, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out`)), 1_000)),
  ]);
}

function raceRepositoryFixture() {
  const state = { executed: false, ledgerRows: [], owner: null, queue: [], targetIds: new Set() };
  const transactions = new Map();

  function releaseFence(name) {
    if (state.owner !== name) return;
    state.owner = null;
    const next = state.queue.shift();
    if (next) {
      state.owner = next.name;
      next.resolve();
    }
  }

  function transaction(name, hooks = {}) {
    const calls = [];
    const tx = {
      calls,
      pendingExecuted: false,
      transaction: {
        async execute(sql, params = []) {
          calls.push({ kind: "execute", params, sql });
          if (!/pg_advisory_xact_lock/i.test(sql)) return;
          if (state.owner === null) {
            state.owner = name;
            return;
          }
          await new Promise((resolve) => state.queue.push({ name, resolve }));
        },
        async query(sql, params = []) {
          calls.push({ kind: "query", params, sql });
          if (/from qa_batch_objects/i.test(sql)) return [...state.ledgerRows];
          if (/from pg_constraint constraint_record/i.test(sql)) return [];
          if (/select target\.id::text as id\s+from "tasks" target/i.test(sql)) {
            return [...state.targetIds].map((id) => ({ id }));
          }
          if (/delete from "tasks" target/i.test(sql)) {
            return [...state.targetIds].map((id) => ({ id }));
          }
          return [];
        },
        async queryOne(sql, params = []) {
          calls.push({ kind: "queryOne", params, sql });
          if (/from workspaces where/i.test(sql)) {
            hooks.workspaceReached?.resolve();
            if (hooks.releaseWorkspace) await hooks.releaseWorkspace.promise;
            return { id: workspaceA, isQa: true };
          }
          if (/from qa_batches batch/i.test(sql)) return { id: batchId };
          if (/from qa_batches/i.test(sql)) {
            return { batchMarker: "QA-TEST-20260822-1200-reset01", id: batchId, workspaceId: workspaceA };
          }
          if (/from qa_reset_audit_events/i.test(sql)) {
            return state.executed ? { id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" } : null;
          }
          if (/insert into qa_reset_audit_events/i.test(sql)) {
            if (params[3] === "execute" && params[4] === "executed") tx.pendingExecuted = true;
            return { id: "55555555-5555-4555-8555-555555555555" };
          }
          return null;
        },
      },
    };
    transactions.set(name, tx);
    return tx;
  }

  async function run(name, tx, callback) {
    try {
      const result = await callback(tx.transaction);
      if (tx.pendingExecuted) state.executed = true;
      return result;
    } finally {
      releaseFence(name);
    }
  }

  return { run, state, transaction, transactions };
}

async function createDryRunPlan(overrides = {}) {
  const { runQaBatchResetInTransaction } = await qaResetRepository;
  const fixture = repositoryFixture(overrides);
  const result = await runQaBatchResetInTransaction(fixture.transaction, {
    actorId,
    allowlistedWorkspaceIds: new Set([workspaceA, workspaceB]),
    batchId,
    mode: "dry_run",
    workspaceId: workspaceA,
  });
  return result.plan;
}

test("QA reset request is dry-run by default and rejects mass assignment", () => {
  const request = parseQaResetRequest({ batchId, workspaceId: workspaceA });
  assert.equal(request.mode, "dry_run");
  assert.equal(request.confirmation, null);
  assert.equal(request.expectedPlanDigest, null);
  assert.throws(
    () => parseQaResetRequest({ batchId, workspaceId: workspaceA, deleteAll: true }),
    /Unsupported QA reset field/,
  );
  assert.throws(() => parseQaResetRequest({ batchId: "all", workspaceId: workspaceA }), /Invalid QA batch id/);
  assert.throws(() => parseQaResetRequest({ batchId, mode: "force", workspaceId: workspaceA }), /dry_run or execute/);
  assert.throws(
    () => parseQaResetRequest({ batchId, expectedPlanDigest: "not-a-sha256", workspaceId: workspaceA }),
    /SHA-256 hex digest/,
  );
});

test("server allowlist requires two QA tenants and cannot overlap production", () => {
  assert.throws(
    () => resolveQaResetWorkspaceAllowlist({ NOVALURE_QA_RESET_WORKSPACE_IDS: workspaceA }),
    /At least two isolated QA workspaces/,
  );
  assert.throws(
    () => resolveQaResetWorkspaceAllowlist({
      NOVALURE_QA_RESET_WORKSPACE_IDS: `${workspaceA},${workspaceB}`,
    }),
    /NOVALURE_PRODUCTION_WORKSPACE_IDS is required/,
  );
  assert.throws(
    () => resolveQaResetWorkspaceAllowlist({
      NOVALURE_PRODUCTION_WORKSPACE_IDS: "  ",
      NOVALURE_QA_RESET_WORKSPACE_IDS: `${workspaceA},${workspaceB}`,
    }),
    /NOVALURE_PRODUCTION_WORKSPACE_IDS is required/,
  );
  assert.throws(
    () => resolveQaResetWorkspaceAllowlist({
      NOVALURE_PRODUCTION_WORKSPACE_IDS: workspaceB,
      NOVALURE_QA_RESET_WORKSPACE_IDS: `${workspaceA},${workspaceB}`,
    }),
    /both QA and production allowlists/,
  );

  const allowlist = resolveQaResetWorkspaceAllowlist({
    NOVALURE_PRODUCTION_WORKSPACE_IDS: productionWorkspace,
    NOVALURE_QA_RESET_WORKSPACE_IDS: `${workspaceA},${workspaceB}`,
  });
  assert.equal(allowlist.size, 2);
  assert.doesNotThrow(() => assertQaResetWorkspaceAllowlisted(workspaceA, allowlist));
  assert.throws(() => assertQaResetWorkspaceAllowlisted(productionWorkspace, allowlist), /not allowlisted/);
});

test("only persisted platform-owner sessions with both capabilities can administer reset", () => {
  assert.equal(canAdministerQaReset(platformAdmin), true);
  for (const override of [
    { source: "headers" },
    { source: "demo" },
    { source: "database" },
    { role: "admin" },
    { productRole: "novalureAdmin" },
    { permissions: [] },
    { productPermissions: ["settings:manage"] },
    { productPermissions: ["novalure:internal"] },
  ]) {
    assert.equal(canAdministerQaReset({ ...platformAdmin, ...override }), false);
  }
});

test("execute needs an explicit server gate and workspace+batch-bound confirmation", () => {
  const request = parseQaResetRequest({
    batchId,
    confirmation: qaResetConfirmation({ batchId, workspaceId: workspaceA }),
    expectedPlanDigest: "A".repeat(64),
    mode: "execute",
    workspaceId: workspaceA,
  });
  assert.equal(request.expectedPlanDigest, "a".repeat(64));
  assert.throws(() => assertQaResetExecutionAuthorized(request, {}), /execution is disabled/);
  assert.throws(
    () => assertQaResetExecutionAuthorized({ ...request, confirmation: `RESET QA BATCH ${workspaceA} ${workspaceB}` }, {
      NOVALURE_QA_RESET_EXECUTION_ENABLED: "true",
    }),
    /does not match/,
  );
  assert.throws(
    () => assertQaResetExecutionAuthorized({ ...request, expectedPlanDigest: null }, {
      NOVALURE_QA_RESET_EXECUTION_ENABLED: "true",
    }),
    /requires the exact plan digest/,
  );
  assert.doesNotThrow(() => assertQaResetExecutionAuthorized(request, {
    NOVALURE_QA_RESET_EXECUTION_ENABLED: "true",
  }));
});

test("repository fail-closes execute without a valid expected plan digest before opening the reset graph", async () => {
  const { runQaBatchResetInTransaction } = await qaResetRepository;
  for (const [expectedPlanDigest, code] of [
    [null, "plan_digest_required"],
    ["not-a-sha256", "plan_digest_invalid"],
  ]) {
    const fixture = repositoryFixture();
    await assert.rejects(
      () => runQaBatchResetInTransaction(fixture.transaction, {
        actorId,
        allowlistedWorkspaceIds: new Set([workspaceA, workspaceB]),
        batchId,
        expectedPlanDigest,
        mode: "execute",
        workspaceId: workspaceA,
      }),
      (error) => error?.code === code,
    );
    assert.deepEqual(fixture.calls, []);
  }
});

test("repository rejects a non-QA workspace before reading a batch or deleting", async () => {
  const { runQaBatchResetInTransaction } = await qaResetRepository;
  const fixture = repositoryFixture({ isQa: false });
  await assert.rejects(
    () => runQaBatchResetInTransaction(fixture.transaction, {
      actorId: "77777777-7777-4777-8777-777777777777",
      allowlistedWorkspaceIds: new Set([workspaceA, workspaceB]),
      batchId,
      mode: "dry_run",
      workspaceId: workspaceA,
    }),
    (error) => error?.code === "workspace_not_qa",
  );
  assert.equal(fixture.calls.some((call) => /from qa_batches/i.test(call.sql)), false);
  assert.equal(fixture.calls.some((call) => /delete from/i.test(call.sql)), false);
});

test("missing or foreign ledger targets block the whole transaction and are audited", async () => {
  const { runQaBatchResetInTransaction } = await qaResetRepository;
  const expectedPlan = await createDryRunPlan({ missingTarget: true });
  const fixture = repositoryFixture({ missingTarget: true });
  const result = await runQaBatchResetInTransaction(fixture.transaction, {
    actorId: "77777777-7777-4777-8777-777777777777",
    allowlistedWorkspaceIds: new Set([workspaceA, workspaceB]),
    batchId,
    expectedPlanDigest: expectedPlan.digest,
    mode: "execute",
    workspaceId: workspaceA,
  });
  assert.equal(result.outcome, "blocked");
  assert.equal(result.plan.blockers.some((blocker) => blocker.code === "registered_target_missing_or_foreign"), true);
  assert.equal(fixture.calls.some((call) => /delete from "tasks"/i.test(call.sql)), false);
  assert.equal(fixture.calls.some((call) => /insert into qa_reset_audit_events/i.test(call.sql)), true);
});

test("an executed batch is sealed before ledger planning or deletion", async () => {
  const { runQaBatchResetInTransaction } = await qaResetRepository;
  const fixture = repositoryFixture({ executedAudit: true });
  await assert.rejects(
    () => runQaBatchResetInTransaction(fixture.transaction, {
      actorId: "77777777-7777-4777-8777-777777777777",
      allowlistedWorkspaceIds: new Set([workspaceA, workspaceB]),
      batchId,
      expectedPlanDigest: syntacticallyValidPlanDigest,
      mode: "execute",
      workspaceId: workspaceA,
    }),
    (error) => error?.code === "batch_already_executed",
  );
  const fenceIndex = fixture.calls.findIndex((call) => /pg_advisory_xact_lock/i.test(call.sql));
  const workspaceIndex = fixture.calls.findIndex((call) => /from workspaces where/i.test(call.sql));
  const batchIndex = fixture.calls.findIndex((call) => /from qa_batches/i.test(call.sql));
  const auditIndex = fixture.calls.findIndex((call) => /from qa_reset_audit_events/i.test(call.sql));
  assert.ok(
    fenceIndex >= 0 &&
    fenceIndex < workspaceIndex &&
    workspaceIndex < batchIndex &&
    batchIndex < auditIndex,
  );
  assert.equal(fixture.calls.some((call) => /from qa_batch_objects/i.test(call.sql)), false);
  assert.equal(fixture.calls.some((call) => /delete from/i.test(call.sql)), false);
});

test("mutation-first then reset serializes without deadlock and seals the batch", async () => {
  const { assertQaBatchForMutation } = await qaBatchRegistrationRepository;
  const { runQaBatchResetInTransaction } = await qaResetRepository;
  const fixture = raceRepositoryFixture();
  const expectedPlan = await createDryRunPlan({ ledgerRows: [] });
  const mutationReady = deferred();
  const releaseMutation = deferred();
  const mutationTx = fixture.transaction("mutation-first");
  const mutation = fixture.run("mutation-first", mutationTx, async (transaction) => {
    await assertQaBatchForMutation(transaction, { batchId, workspaceId: workspaceA });
    mutationReady.resolve();
    await releaseMutation.promise;
  });
  await withTimeout(mutationReady.promise, "mutation-first acquire");

  const resetTx = fixture.transaction("reset-second");
  const reset = fixture.run("reset-second", resetTx, (transaction) => runQaBatchResetInTransaction(transaction, {
    actorId: "77777777-7777-4777-8777-777777777777",
    allowlistedWorkspaceIds: new Set([workspaceA, workspaceB]),
    batchId,
    expectedPlanDigest: expectedPlan.digest,
    mode: "execute",
    workspaceId: workspaceA,
  }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(resetTx.calls.length, 1);
  assert.match(resetTx.calls[0].sql, /pg_advisory_xact_lock/);

  releaseMutation.resolve();
  await withTimeout(mutation, "mutation-first completion");
  const result = await withTimeout(reset, "reset-second completion");
  assert.equal(result.outcome, "executed");
  assert.equal(fixture.state.executed, true);

  const lateTx = fixture.transaction("mutation-after-reset");
  await assert.rejects(
    () => withTimeout(fixture.run("mutation-after-reset", lateTx, (transaction) =>
      assertQaBatchForMutation(transaction, { batchId, workspaceId: workspaceA })), "late mutation"),
    (error) => error?.code === "QA_BATCH_SEALED",
  );
});

test("a registration that wins the batch fence after dry-run invalidates execute atomically", async () => {
  const { assertQaBatchForMutation } = await qaBatchRegistrationRepository;
  const { runQaBatchResetInTransaction } = await qaResetRepository;
  const expectedPlan = await createDryRunPlan({ ledgerRows: [] });
  const fixture = raceRepositoryFixture();
  const mutationReady = deferred();
  const releaseMutation = deferred();
  const targetId = "44444444-4444-4444-8444-444444444444";
  const mutationTx = fixture.transaction("registration-first");
  const mutation = fixture.run("registration-first", mutationTx, async (transaction) => {
    await assertQaBatchForMutation(transaction, { batchId, workspaceId: workspaceA });
    fixture.state.ledgerRows.push({ resourceId: targetId, resourceScope: "database", resourceType: "tasks" });
    fixture.state.targetIds.add(targetId);
    mutationReady.resolve();
    await releaseMutation.promise;
  });
  await withTimeout(mutationReady.promise, "registration-first acquire");

  const resetTx = fixture.transaction("stale-reset-second");
  const reset = fixture.run("stale-reset-second", resetTx, (transaction) =>
    runQaBatchResetInTransaction(transaction, {
      actorId,
      allowlistedWorkspaceIds: new Set([workspaceA, workspaceB]),
      batchId,
      expectedPlanDigest: expectedPlan.digest,
      mode: "execute",
      workspaceId: workspaceA,
    }));
  const resetOutcome = reset.then(
    (result) => ({ error: null, result }),
    (error) => ({ error, result: null }),
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(resetTx.calls.length, 1);
  assert.match(resetTx.calls[0].sql, /pg_advisory_xact_lock/);

  releaseMutation.resolve();
  await withTimeout(mutation, "registration-first completion");
  const outcome = await withTimeout(resetOutcome, "stale reset completion");
  assert.equal(outcome.result, null);
  assert.equal(outcome.error?.code, "plan_digest_mismatch");
  assert.equal(fixture.state.executed, false);
  assert.equal(resetTx.calls.some((call) => /delete from/i.test(call.sql)), false);
  assert.equal(resetTx.calls.some((call) => /insert into qa_reset_audit_events/i.test(call.sql)), false);
});

test("reset-first then mutation serializes without deadlock and rejects the waiter as sealed", async () => {
  const { assertQaBatchForMutation } = await qaBatchRegistrationRepository;
  const { runQaBatchResetInTransaction } = await qaResetRepository;
  const fixture = raceRepositoryFixture();
  const expectedPlan = await createDryRunPlan({ ledgerRows: [] });
  const workspaceReached = deferred();
  const releaseWorkspace = deferred();
  const resetTx = fixture.transaction("reset-first", { releaseWorkspace, workspaceReached });
  const reset = fixture.run("reset-first", resetTx, (transaction) => runQaBatchResetInTransaction(transaction, {
    actorId: "77777777-7777-4777-8777-777777777777",
    allowlistedWorkspaceIds: new Set([workspaceA, workspaceB]),
    batchId,
    expectedPlanDigest: expectedPlan.digest,
    mode: "execute",
    workspaceId: workspaceA,
  }));
  await withTimeout(workspaceReached.promise, "reset-first workspace lock");
  assert.match(resetTx.calls[0].sql, /pg_advisory_xact_lock/);
  assert.match(resetTx.calls[1].sql, /from workspaces where/);

  const mutationTx = fixture.transaction("mutation-second");
  const mutation = fixture.run("mutation-second", mutationTx, (transaction) =>
    assertQaBatchForMutation(transaction, { batchId, workspaceId: workspaceA }));
  const mutationOutcome = mutation.then(
    () => ({ error: null, ok: true }),
    (error) => ({ error, ok: false }),
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(mutationTx.calls.length, 1);
  assert.match(mutationTx.calls[0].sql, /pg_advisory_xact_lock/);

  releaseWorkspace.resolve();
  const result = await withTimeout(reset, "reset-first completion");
  assert.equal(result.outcome, "executed");
  const outcome = await withTimeout(mutationOutcome, "mutation-second completion");
  assert.equal(outcome.ok, false);
  assert.equal(outcome.error?.code, "QA_BATCH_SEALED");
});

test("an unregistered FK child is treated as a foreign-batch graph violation", async () => {
  const { runQaBatchResetInTransaction } = await qaResetRepository;
  const targetId = "44444444-4444-4444-8444-444444444444";
  const overrides = {
    foreignKeys: [{
      childColumns: ["contact_id"],
      childTable: "leads",
      constraintName: "leads_contact_id_fkey",
      deleteAction: "n",
      parentColumns: ["id"],
      parentTable: "contacts",
    }],
    ledgerRows: [{ resourceId: targetId, resourceScope: "database", resourceType: "contacts" }],
    targetId,
  };
  const expectedPlan = await createDryRunPlan(overrides);
  const fixture = repositoryFixture(overrides);
  const result = await runQaBatchResetInTransaction(fixture.transaction, {
    actorId: "77777777-7777-4777-8777-777777777777",
    allowlistedWorkspaceIds: new Set([workspaceA, workspaceB]),
    batchId,
    expectedPlanDigest: expectedPlan.digest,
    mode: "execute",
    workspaceId: workspaceA,
  });
  assert.equal(result.outcome, "blocked");
  assert.equal(
    result.plan.blockers.some((blocker) => blocker.code === "foreign_batch_or_unregistered_dependency"),
    true,
  );
  assert.equal(fixture.calls.some((call) => /delete from/i.test(call.sql)), false);
});

test("Unit idempotency rows are modeled as cascade-owned reset children", async () => {
  const { runQaBatchResetInTransaction } = await qaResetRepository;
  const targetId = "44444444-4444-4444-8444-444444444444";
  const fixture = repositoryFixture({
    foreignKeys: [{
      childColumns: ["workspace_id", "project_id", "unit_id"],
      childTable: "property_unit_idempotency",
      constraintName: "property_unit_idempotency_unit_fk",
      deleteAction: "c",
      parentColumns: ["workspace_id", "project_id", "id"],
      parentTable: "property_units",
    }],
    ledgerRows: [{ resourceId: targetId, resourceScope: "database", resourceType: "property_units" }],
    targetId,
  });
  const result = await runQaBatchResetInTransaction(fixture.transaction, {
    actorId: "77777777-7777-4777-8777-777777777777",
    allowlistedWorkspaceIds: new Set([workspaceA, workspaceB]),
    batchId,
    mode: "dry_run",
    workspaceId: workspaceA,
  });
  assert.equal(result.outcome, "dry_run");
  assert.deepEqual(result.plan.blockers, []);
  assert.equal(result.plan.deletionOrder.includes("property_units"), true);
  const referenceCheck = fixture.calls.find((call) => /from "property_unit_idempotency" child/i.test(call.sql));
  assert.ok(referenceCheck);
  assert.match(referenceCheck.sql, /join "property_units" parent_target/);
  assert.match(referenceCheck.sql, /child\."workspace_id" = parent_target\."workspace_id"/);
  assert.match(referenceCheck.sql, /child\."project_id" = parent_target\."project_id"/);
  assert.match(referenceCheck.sql, /child\."unit_id" = parent_target\."id"/);
  assert.match(referenceCheck.sql, /parent_target\.workspace_id::text = \$2::text/);
});

test("Building idempotency rows are modeled as cascade-owned reset children", async () => {
  const { runQaBatchResetInTransaction } = await qaResetRepository;
  const targetId = "44444444-4444-4444-8444-444444444444";
  const fixture = repositoryFixture({
    foreignKeys: [{
      childColumns: ["workspace_id", "project_id", "building_id"],
      childTable: "property_building_idempotency",
      constraintName: "property_building_idempotency_building_fk",
      deleteAction: "c",
      parentColumns: ["workspace_id", "project_id", "id"],
      parentTable: "property_buildings",
    }],
    ledgerRows: [{ resourceId: targetId, resourceScope: "database", resourceType: "property_buildings" }],
    targetId,
  });
  const result = await runQaBatchResetInTransaction(fixture.transaction, {
    actorId: "77777777-7777-4777-8777-777777777777",
    allowlistedWorkspaceIds: new Set([workspaceA, workspaceB]),
    batchId,
    mode: "dry_run",
    workspaceId: workspaceA,
  });
  assert.equal(result.outcome, "dry_run");
  assert.deepEqual(result.plan.blockers, []);
  assert.equal(result.plan.deletionOrder.includes("property_buildings"), true);
});

test("server plan digest is canonical for ledger order and changes for any exact-target change", async () => {
  const taskId = "44444444-4444-4444-8444-444444444444";
  const task = { resourceId: taskId, resourceScope: "database", resourceType: "tasks" };
  const contact = { resourceId: taskId, resourceScope: "database", resourceType: "contacts" };
  const first = await createDryRunPlan({ ledgerRows: [task, contact], targetId: taskId });
  const reordered = await createDryRunPlan({ ledgerRows: [contact, task], targetId: taskId });
  const reduced = await createDryRunPlan({ ledgerRows: [task], targetId: taskId });

  assert.match(first.digest, /^[0-9a-f]{64}$/);
  assert.equal(first.digest, reordered.digest);
  assert.notEqual(first.digest, reduced.digest);
});

test("execute rejects a stale dry-run digest when a valid target is registered between calls", async () => {
  const { runQaBatchResetInTransaction } = await qaResetRepository;
  const taskId = "44444444-4444-4444-8444-444444444444";
  const stalePlan = await createDryRunPlan({
    ledgerRows: [{ resourceId: taskId, resourceScope: "database", resourceType: "tasks" }],
    targetId: taskId,
  });
  const fixture = repositoryFixture({
    ledgerRows: [
      { resourceId: taskId, resourceScope: "database", resourceType: "tasks" },
      { resourceId: taskId, resourceScope: "database", resourceType: "contacts" },
    ],
    targetId: taskId,
  });

  await assert.rejects(
    () => runQaBatchResetInTransaction(fixture.transaction, {
      actorId,
      allowlistedWorkspaceIds: new Set([workspaceA, workspaceB]),
      batchId,
      expectedPlanDigest: stalePlan.digest,
      mode: "execute",
      workspaceId: workspaceA,
    }),
    (error) => error?.code === "plan_digest_mismatch",
  );
  assert.equal(fixture.calls.some((call) => /for update of target/i.test(call.sql)), true);
  assert.equal(fixture.calls.some((call) => /delete from/i.test(call.sql)), false);
  assert.equal(fixture.calls.some((call) => /insert into qa_reset_audit_events/i.test(call.sql)), false);
});

test("dry-run and execute use the same deterministic exact-target plan", async () => {
  const { runQaBatchResetInTransaction } = await qaResetRepository;
  const input = {
    actorId: "77777777-7777-4777-8777-777777777777",
    allowlistedWorkspaceIds: new Set([workspaceA, workspaceB]),
    batchId,
    workspaceId: workspaceA,
  };
  const dryFixture = repositoryFixture();
  const dryRun = await runQaBatchResetInTransaction(dryFixture.transaction, { ...input, mode: "dry_run" });
  const executeFixture = repositoryFixture();
  const execution = await runQaBatchResetInTransaction(executeFixture.transaction, {
    ...input,
    expectedPlanDigest: dryRun.plan.digest,
    mode: "execute",
  });

  assert.equal(dryRun.outcome, "dry_run");
  assert.equal(execution.outcome, "executed");
  assert.equal(dryRun.plan.digest, execution.plan.digest);
  assert.deepEqual(dryRun.plan.targets, execution.plan.targets);
  assert.deepEqual(dryRun.plan.targetCounts, execution.plan.targetCounts);
  assert.equal(dryFixture.calls.some((call) => /delete from/i.test(call.sql)), false);
  assert.equal(executeFixture.calls.some((call) => /delete from "tasks"/i.test(call.sql)), true);
  assert.deepEqual(execution.deletedCounts, { tasks: 1 });

  const dryTargetChecks = dryFixture.calls.filter((call) =>
    /select target\.id::text as id\s+from "tasks" target/i.test(call.sql));
  const executeTargetChecks = executeFixture.calls.filter((call) =>
    /select target\.id::text as id\s+from "tasks" target/i.test(call.sql));
  assert.equal(dryTargetChecks.length, 1);
  assert.doesNotMatch(dryTargetChecks[0].sql, /for update of target/i);
  assert.equal(executeTargetChecks.length, 2);
  assert.doesNotMatch(executeTargetChecks[0].sql, /for update of target/i);
  assert.match(executeTargetChecks[1].sql, /order by target\.id\s+for update of target/i);
});

test("execute rechecks FK closure while target locks are held immediately before delete", async () => {
  const { runQaBatchResetInTransaction } = await qaResetRepository;
  const targetId = "44444444-4444-4444-8444-444444444444";
  const unregisteredLeadId = "66666666-6666-4666-8666-666666666666";
  const foreignKey = {
    childColumns: ["contact_id"],
    childTable: "leads",
    constraintName: "leads_contact_id_fkey",
    deleteAction: "n",
    parentColumns: ["id"],
    parentTable: "contacts",
  };
  const expectedPlan = await createDryRunPlan({
    foreignKeys: [foreignKey],
    leadRows: [{ id: unregisteredLeadId }],
    ledgerRows: [{ resourceId: targetId, resourceScope: "database", resourceType: "contacts" }],
    targetId,
  });
  let closureChecks = 0;
  const fixture = fakeTransaction(({ sql }) => {
    if (/from workspaces where/i.test(sql)) return { id: workspaceA, isQa: true };
    if (/from qa_batches/i.test(sql)) {
      return { batchMarker: "QA-TEST-20260822-1200-reset01", id: batchId, workspaceId: workspaceA };
    }
    if (/from qa_reset_audit_events/i.test(sql)) return null;
    if (/from qa_batch_objects/i.test(sql)) {
      return [{ resourceId: targetId, resourceScope: "database", resourceType: "contacts" }];
    }
    if (/from pg_constraint constraint_record/i.test(sql)) {
      return [foreignKey];
    }
    if (/select target\.id::text as id\s+from "contacts" target/i.test(sql)) return [{ id: targetId }];
    if (/from "leads" child/i.test(sql)) {
      closureChecks += 1;
      return closureChecks === 1 ? [] : [{ id: unregisteredLeadId }];
    }
    if (/insert into qa_reset_audit_events/i.test(sql)) {
      return { id: "55555555-5555-4555-8555-555555555555" };
    }
    return [];
  });

  const result = await runQaBatchResetInTransaction(fixture.transaction, {
    actorId: "77777777-7777-4777-8777-777777777777",
    allowlistedWorkspaceIds: new Set([workspaceA, workspaceB]),
    batchId,
    expectedPlanDigest: expectedPlan.digest,
    mode: "execute",
    workspaceId: workspaceA,
  });

  assert.equal(result.outcome, "blocked");
  assert.equal(closureChecks, 2);
  assert.equal(
    result.plan.blockers.some((blocker) => blocker.code === "foreign_batch_or_unregistered_dependency"),
    true,
  );
  assert.equal(fixture.calls.some((call) => /delete from/i.test(call.sql)), false);

  const targetChecks = fixture.calls.filter((call) =>
    /select target\.id::text as id\s+from "contacts" target/i.test(call.sql));
  const closureCheckIndexes = fixture.calls
    .map((call, index) => (/from "leads" child/i.test(call.sql) ? index : -1))
    .filter((index) => index >= 0);
  const auditIndex = fixture.calls.findIndex((call) => /insert into qa_reset_audit_events/i.test(call.sql));
  assert.equal(targetChecks.length, 2);
  assert.doesNotMatch(targetChecks[0].sql, /for update of target/i);
  assert.match(targetChecks[1].sql, /for update of target/i);
  assert.equal(closureCheckIndexes.length, 2);
  assert.ok(closureCheckIndexes[1] < auditIndex);
});

test("the locked closure recheck is the final database read before exact-target deletion", async () => {
  const { runQaBatchResetInTransaction } = await qaResetRepository;
  const targetId = "44444444-4444-4444-8444-444444444444";
  const foreignKey = {
    childColumns: ["contact_id"],
    childTable: "leads",
    constraintName: "leads_contact_id_fkey",
    deleteAction: "n",
    parentColumns: ["id"],
    parentTable: "contacts",
  };
  const expectedPlan = await createDryRunPlan({
    foreignKeys: [foreignKey],
    leadRows: [],
    ledgerRows: [{ resourceId: targetId, resourceScope: "database", resourceType: "contacts" }],
    targetId,
  });
  const fixture = fakeTransaction(({ sql }) => {
    if (/from workspaces where/i.test(sql)) return { id: workspaceA, isQa: true };
    if (/from qa_batches/i.test(sql)) {
      return { batchMarker: "QA-TEST-20260822-1200-reset01", id: batchId, workspaceId: workspaceA };
    }
    if (/from qa_reset_audit_events/i.test(sql)) return null;
    if (/from qa_batch_objects/i.test(sql)) {
      return [{ resourceId: targetId, resourceScope: "database", resourceType: "contacts" }];
    }
    if (/from pg_constraint constraint_record/i.test(sql)) {
      return [foreignKey];
    }
    if (/select target\.id::text as id\s+from "contacts" target/i.test(sql)) return [{ id: targetId }];
    if (/from "leads" child/i.test(sql)) return [];
    if (/delete from "contacts" target/i.test(sql)) return [{ id: targetId }];
    if (/insert into qa_reset_audit_events/i.test(sql)) {
      return { id: "55555555-5555-4555-8555-555555555555" };
    }
    return [];
  });

  const result = await runQaBatchResetInTransaction(fixture.transaction, {
    actorId: "77777777-7777-4777-8777-777777777777",
    allowlistedWorkspaceIds: new Set([workspaceA, workspaceB]),
    batchId,
    expectedPlanDigest: expectedPlan.digest,
    mode: "execute",
    workspaceId: workspaceA,
  });

  assert.equal(result.outcome, "executed");
  const closureCheckIndexes = fixture.calls
    .map((call, index) => (/from "leads" child/i.test(call.sql) ? index : -1))
    .filter((index) => index >= 0);
  const deleteIndex = fixture.calls.findIndex((call) => /delete from "contacts" target/i.test(call.sql));
  const lockedTargetIndex = fixture.calls.findIndex((call) =>
    /select target\.id::text as id\s+from "contacts" target[\s\S]*for update of target/i.test(call.sql));
  assert.equal(closureCheckIndexes.length, 2);
  assert.ok(lockedTargetIndex < closureCheckIndexes[1]);
  assert.equal(deleteIndex, closureCheckIndexes[1] + 1);
});

test("blob/provider ledger targets block database execution until adapters exist", async () => {
  const { runQaBatchResetInTransaction } = await qaResetRepository;
  const overrides = {
    ledgerRows: [{ resourceId: "qa/blob/object-1", resourceScope: "blob", resourceType: "vercel-blob" }],
  };
  const expectedPlan = await createDryRunPlan(overrides);
  const fixture = repositoryFixture(overrides);
  const result = await runQaBatchResetInTransaction(fixture.transaction, {
    actorId: "77777777-7777-4777-8777-777777777777",
    allowlistedWorkspaceIds: new Set([workspaceA, workspaceB]),
    batchId,
    expectedPlanDigest: expectedPlan.digest,
    mode: "execute",
    workspaceId: workspaceA,
  });
  assert.equal(result.outcome, "blocked");
  assert.equal(result.plan.blockers.some((blocker) => blocker.code === "external_cleanup_adapter_required"), true);
  assert.equal(fixture.calls.some((call) => /delete from/i.test(call.sql)), false);
});

test("every declared CRM table is exactly resettable or explicitly retained", () => {
  const resettable = new Set(qaResetDatabaseTables);
  const cascadeOwned = new Set(qaResetCascadeOwnedTables);
  const retained = new Set(qaResetRetainedTables);
  const missing = crmTables.filter(
    (table) => !resettable.has(table) && !cascadeOwned.has(table) && !retained.has(table),
  );
  const overlap = crmTables.filter(
    (table) =>
      Number(resettable.has(table)) + Number(cascadeOwned.has(table)) + Number(retained.has(table)) > 1,
  );
  assert.deepEqual(missing, []);
  assert.deepEqual(overlap, []);
  assert.equal(cascadeOwned.has("property_building_idempotency"), true);
  assert.equal(cascadeOwned.has("property_unit_idempotency"), true);
  assert.equal(resettable.has("property_building_idempotency"), false);
  assert.equal(resettable.has("property_unit_idempotency"), false);
  assert.equal(resettable.has("workspaces"), false);
  assert.equal(resettable.has("workspace_users"), false);
  assert.equal(resettable.has("audit_logs"), false);
  assert.equal(retained.has("analytics_events"), true);
  assert.equal(retained.has("auth_audit_events"), true);
});

test("route requires session, CSRF, exact platform role and capability before repository", async () => {
  const route = await read("src/app/api/admin/qa-reset/route.ts");
  assert.match(route, /getRequestSession\(request\)/);
  assert.match(route, /enforceCsrfForSession\(request, session\)/);
  assert.match(route, /canAdministerQaReset\(session\)/);
  assert.match(route, /resolveQaResetWorkspaceAllowlist\(\)/);
  assert.match(route, /error\.code === "production_denylist_not_configured"/);
  assert.match(route, /assertQaResetExecutionAuthorized\(parsedRequest\)/);
  assert.match(route, /expectedPlanDigest: parsedRequest\.expectedPlanDigest/);
  assert.match(route, /error\.code === "plan_digest_mismatch"/);
  assert.match(route, /recordBlockedAttempt/);
  assert.match(route, /Cache-Control["']:\s*["']private, no-store/);
  assert.ok(route.indexOf("enforceCsrfForSession") < route.indexOf("runQaBatchReset({"));
  assert.doesNotMatch(route, /export async function (?:GET|DELETE|PATCH|PUT)/);
});

test("repository locks QA roots, scopes exact ledger ids and checks FK closure", async () => {
  const repository = await read("src/lib/db/qa-reset-repository.ts");
  assert.match(repository, /is_qa as "isQa" from workspaces where id = \$1::uuid for update/);
  assert.match(repository, /where id = \$1::uuid\s+and workspace_id = \$2::uuid\s+`/);
  assert.doesNotMatch(repository, /from qa_batches[\s\S]{0,180}for (?:key )?share/);
  assert.match(repository, /lockQaBatchFence\(transaction, input\.batchId\)/);
  assert.match(repository, /hasExecutedQaBatchAudit\(transaction, input\)/);
  assert.match(repository, /from qa_batch_objects/);
  assert.match(repository, /from pg_constraint constraint_record/);
  assert.match(repository, /foreign_batch_or_unregistered_dependency/);
  assert.match(repository, /registered_target_missing_or_foreign/);
  assert.match(repository, /external_cleanup_adapter_required/);
  assert.match(repository, /provider_side_effect_reconciliation_required/);
  assert.match(repository, /target\.workspace_id::text = \$2::text/);
  assert.match(repository, /const targetLock = options\.lockTarget \? "for update of target" : ""/);
  assert.match(repository, /planDigestDomain = "novalure\.qa-reset-plan\.v1"/);
  assert.match(repository, /assertExpectedPlanDigest\(input\.expectedPlanDigest, plan\.digest\)/);
  assert.match(repository, /timingSafeEqual\(expected, actual\)/);
  assert.match(repository, /writeResetAudit/);
  assert.match(repository, /withTenantTransaction/);
  assert.doesNotMatch(repository, /delete from\s+(?:workspaces|workspace_users)/i);
});

test("two-tenant harness binds execute and deletion evidence to the preceding dry-run digest", async () => {
  const harness = await read("scripts/qa-two-tenant-e2e.mjs");
  const resetTenantSource = harness.slice(
    harness.indexOf("async function resetTenant"),
    harness.indexOf("async function writeEvidence"),
  );
  assert.match(resetTenantSource, /expectedPlanDigest: planDigest/);
  assert.match(resetTenantSource, /execute\.json\?\.plan\?\.digest === planDigest/);
  assert.match(resetTenantSource, /canonicalJson\(execute\.json\?\.deletedCounts \?\? \{\}\) === canonicalJson\(expectedDeletedCounts\)/);
  assert.ok(resetTenantSource.indexOf('mode: "dry_run"') < resetTenantSource.indexOf("expectedPlanDigest: planDigest"));
});

test("migration is fail-closed and all QA ledgers are append-only", async () => {
  const migration = await read("migrations/068_qa_batch_reset_safety.sql");
  assert.match(migration, /add column if not exists is_qa boolean not null default false/);
  assert.match(migration, /create table if not exists qa_batches/);
  assert.match(migration, /create table if not exists qa_batch_objects/);
  assert.match(migration, /create table if not exists qa_reset_audit_events/);
  assert.match(migration, /unique \(resource_scope, resource_type, resource_id\)/);
  assert.match(migration, /qa_batches_require_qa_workspace/);
  for (const trigger of [
    "qa_batches_append_only_guard",
    "qa_batch_objects_append_only_guard",
    "qa_reset_audit_append_only_guard",
  ]) {
    assert.match(migration, new RegExp(trigger));
  }
  assert.match(migration, /drop constraint if exists audit_logs_project_id_fkey/);
  assert.match(migration, /drop constraint if exists audit_logs_workspace_deal_fk/);
  assert.match(migration, /enable row level security/);
  assert.match(migration, /force row level security/);
  assert.doesNotMatch(migration, /security definer/i);
  assert.doesNotMatch(migration, /delete from\s+(?:workspaces|workspace_users)/i);
});

test("Inventory idempotency migration is reset-compatible and DB-enforced", async () => {
  const migration = await read("migrations/069_property_unit_idempotency.sql");
  assert.match(migration, /id uuid primary key default gen_random_uuid\(\)/);
  assert.match(migration, /unique \(workspace_id, idempotency_key\)/);
  assert.match(
    migration,
    /foreign key \(workspace_id, project_id, unit_id\)[\s\S]*references property_units\(workspace_id, project_id, id\)[\s\S]*on delete cascade/,
  );
  assert.match(migration, /create table if not exists property_building_idempotency/);
  assert.match(
    migration,
    /foreign key \(workspace_id, project_id, building_id\)[\s\S]*references property_buildings\(workspace_id, project_id, id\)[\s\S]*on delete cascade/,
  );
  assert.match(migration, /request_hash text not null/);
  assert.match(migration, /response jsonb not null/);
});

test("legacy direct workspace cleanup is hard-disabled without opening a database", () => {
  const result = spawnSync(process.execPath, ["scripts/qa-livegang-reset.mjs", "--reset"], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Legacy QA Livegang reset is disabled by DB-01/);
  assert.doesNotMatch(result.stderr, /Deleted QA workspace/);
});
