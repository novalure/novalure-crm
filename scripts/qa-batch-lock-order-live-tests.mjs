import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  parseQaBatchLockOrderArgs,
  QA_BATCH_LOCK_ORDER_CONFIRMATION,
  qaBatchLockOrderSql,
  validateQaBatchLockOrderTarget,
  verifyPinnedRuntimeSessions,
} from "./qa-batch-lock-order-live.mjs";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const otherQaWorkspaceId = "22222222-2222-4222-8222-222222222222";
const productionWorkspaceId = "33333333-3333-4333-8333-333333333333";
const batchId = "44444444-4444-4444-8444-444444444444";
const actorId = "55555555-5555-4555-8555-555555555555";

function args(mode = "execute") {
  return parseQaBatchLockOrderArgs([
    `--${mode}`,
    "--workspace-id",
    workspaceId,
    "--batch-id",
    batchId,
    "--actor-id",
    actorId,
  ]);
}

function validEnvironment() {
  return {
    VERCEL_ENV: "preview",
    NOVALURE_PRODUCTION_BRANCH_ID: "br-production",
    NOVALURE_PRODUCTION_DATABASE_HOST: "prod-lock-pooler.eu-central-1.aws.neon.tech",
    NOVALURE_PRODUCTION_ORIGIN: "https://www.novalure-crm.app",
    NOVALURE_PRODUCTION_PROJECT_ID: "production-project",
    NOVALURE_PRODUCTION_WORKSPACE_IDS: productionWorkspaceId,
    NOVALURE_QA_BASE_URL: "https://candidate-lock-order.example.test",
    NOVALURE_QA_BRANCH_ID: "br-qa-lock-order",
    NOVALURE_QA_DATABASE_HOST: "qa-lock-pooler.eu-central-1.aws.neon.tech",
    NOVALURE_QA_DATABASE_NAME: "neondb",
    NOVALURE_QA_DATABASE_ROLE: "novalure_app",
    NOVALURE_QA_DATABASE_URL: "postgresql://novalure_app:test-only@qa-lock-pooler.eu-central-1.aws.neon.tech/neondb?sslmode=require",
    NOVALURE_QA_LOCK_ORDER_CONFIRM: QA_BATCH_LOCK_ORDER_CONFIRMATION,
    NOVALURE_QA_PROJECT_ID: "qa-project-lock-order",
    NOVALURE_QA_RESET_WORKSPACE_IDS: `${workspaceId},${otherQaWorkspaceId}`,
  };
}

test("lock drill defaults to offline plan and requires exact identifiers for validation or execution", () => {
  assert.deepEqual(parseQaBatchLockOrderArgs([]), { mode: "plan" });
  assert.deepEqual(args("validate-config"), {
    actorId,
    batchId,
    mode: "validate-config",
    workspaceId,
  });
  assert.throws(() => parseQaBatchLockOrderArgs(["--execute"]), /--workspace-id must be provided exactly once/u);
  assert.throws(
    () => parseQaBatchLockOrderArgs(["--plan", "--workspace-id", workspaceId]),
    /plan mode does not accept target identifiers/u,
  );
  assert.throws(() => parseQaBatchLockOrderArgs(["--execute", "--unknown"]), /Unknown lock-drill argument/u);
});

test("target guard accepts only explicit isolated Preview runtime fingerprints", () => {
  const env = validEnvironment();
  const config = validateQaBatchLockOrderTarget(env, args(), { requireExecution: true });
  assert.equal(config.workspaceId, workspaceId);
  assert.equal(config.batchId, batchId);
  assert.equal(new URL(config.databaseUrl).username, "novalure_app");

  for (const mutate of [
    (candidate) => { candidate.VERCEL_ENV = "production"; },
    (candidate) => { candidate.NOVALURE_QA_BASE_URL = candidate.NOVALURE_PRODUCTION_ORIGIN; },
    (candidate) => { candidate.NOVALURE_QA_BASE_URL = "https://novalure-crm.app"; },
    (candidate) => { candidate.NOVALURE_QA_DATABASE_HOST = candidate.NOVALURE_PRODUCTION_DATABASE_HOST; },
    (candidate) => { candidate.NOVALURE_QA_PROJECT_ID = candidate.NOVALURE_PRODUCTION_PROJECT_ID; },
    (candidate) => { candidate.NOVALURE_QA_BRANCH_ID = candidate.NOVALURE_PRODUCTION_BRANCH_ID; },
    (candidate) => { candidate.NOVALURE_QA_DATABASE_ROLE = "neondb_owner"; },
    (candidate) => { candidate.NOVALURE_QA_DATABASE_NAME = "wrong_database"; },
    (candidate) => { candidate.NOVALURE_QA_DATABASE_URL = candidate.NOVALURE_QA_DATABASE_URL.replace("sslmode=require", "sslmode=disable"); },
    (candidate) => { candidate.NOVALURE_QA_RESET_WORKSPACE_IDS = otherQaWorkspaceId; },
    (candidate) => { candidate.NOVALURE_PRODUCTION_WORKSPACE_IDS = workspaceId; },
    (candidate) => { delete candidate.NOVALURE_PRODUCTION_DATABASE_HOST; },
    (candidate) => { delete candidate.NOVALURE_PRODUCTION_PROJECT_ID; },
    (candidate) => { delete candidate.NOVALURE_QA_LOCK_ORDER_CONFIRM; },
  ]) {
    const candidate = validEnvironment();
    mutate(candidate);
    assert.throws(
      () => validateQaBatchLockOrderTarget(candidate, args(), { requireExecution: true }),
    );
  }
});

test("declared drill SQL is rollback-only, lock-bounded and mirrors runtime lock orders", () => {
  const allowedStart = /^(?:begin|rollback|set local|select|update workspaces set is_qa = false)\b/iu;
  const forbidden = /\b(?:alter\s|call\s|copy\s|create\s|delete\s+from|drop\s|grant\s|insert\s+into|merge\s+into|refresh\s|revoke\s|truncate\s|update\s+[a-z_][a-z0-9_]*\s+set|vacuum\s)/iu;
  for (const [name, sql] of Object.entries(qaBatchLockOrderSql)) {
    const normalized = sql.trim();
    assert.match(normalized, allowedStart, `${name} must use an allowed read-only statement`);
    if (name === "workspaceDisable") {
      assert.match(normalized, /^update workspaces set is_qa = false where id = \$1::uuid and is_qa = true returning id$/u);
    } else {
      assert.doesNotMatch(normalized, forbidden, `${name} must not mutate`);
    }
    assert.equal(normalized.replace(/;\s*$/u, "").includes(";"), false, `${name} must contain one statement`);
  }
  assert.match(qaBatchLockOrderSql.advisory, /pg_advisory_xact_lock\(hashtextextended\('novalure\.qa_batch:' \|\| \$1::text, 0\)\)/u);
  assert.match(qaBatchLockOrderSql.mutationWorkspace, /inner join workspaces workspace on workspace\.id = batch\.workspace_id/u);
  assert.match(qaBatchLockOrderSql.mutationWorkspace, /is_qa = true\s+for share of workspace\s*$/u);
  assert.doesNotMatch(qaBatchLockOrderSql.mutationWorkspace, /for share of[^\n]*batch/u);
  assert.match(qaBatchLockOrderSql.resetWorkspace, /is_qa = true for update$/u);
  assert.match(qaBatchLockOrderSql.setLockTimeout, /1500ms/u);
  assert.match(qaBatchLockOrderSql.setStatementTimeout, /5000ms/u);
});

test("runtime mutation locks the mutable QA workspace without row-locking the append-only batch", async () => {
  const repository = await readFile(
    new URL("../src/lib/db/qa-batch-registration-repository.ts", import.meta.url),
    "utf8",
  );
  const advisory = repository.indexOf("await lockQaBatchFence(transaction, input.batchId)");
  const workspaceShare = repository.indexOf("for share of workspace", advisory);
  assert.ok(advisory >= 0 && workspaceShare > advisory);
  assert.match(repository, /workspace\.is_qa = true[\s\S]*for share of workspace/u);
  assert.doesNotMatch(repository, /for share of workspace, batch/u);
  assert.doesNotMatch(repository, /for key share/u);
});

function createPinnedSessionClient(backendPid, options = {}) {
  let inTransaction = false;
  const statements = [];
  return {
    get inTransaction() {
      return inTransaction;
    },
    async query(sql) {
      const statement = sql.trim();
      statements.push(statement);
      if (statement === qaBatchLockOrderSql.begin) {
        inTransaction = true;
        if (options.failOnBegin) throw new Error("synthetic begin failure");
        return { rowCount: null, rows: [] };
      }
      if (statement === qaBatchLockOrderSql.rollback) {
        inTransaction = false;
        if (options.failOnRollback) throw new Error("synthetic rollback failure");
        return { rowCount: null, rows: [] };
      }
      if (statement.startsWith("set local ")) {
        assert.equal(inTransaction, true, "SET LOCAL must run in the pinned transaction");
        return { rowCount: null, rows: [] };
      }
      if (statement === qaBatchLockOrderSql.backendIdentity) {
        return { rowCount: 1, rows: [{ backendPid: inTransaction ? backendPid : 9999 }] };
      }
      throw new Error(`unexpected synthetic query: ${statement}`);
    },
    statements,
  };
}

function pinnedSessionConfig() {
  return {
    actorId,
    batchId,
    workspaceId,
  };
}

async function inspectPinnedSyntheticTarget({ client, purpose }) {
  assert.equal(client.inTransaction, true, `${purpose} must inspect a pinned transaction`);
  client.statements.push(`target:${purpose}`);
  return {
    branchId: "br-qa-lock-order",
    databaseName: "neondb",
    projectId: "qa-project-lock-order",
    roleName: "novalure_app",
  };
}

test("pooled runtime identity is checked only while both logical clients are transaction-pinned", async () => {
  const firstClient = createPinnedSessionClient(101);
  const secondClient = createPinnedSessionClient(202);
  const result = await verifyPinnedRuntimeSessions({
    config: pinnedSessionConfig(),
    env: validEnvironment(),
    firstClient,
    inspectTarget: inspectPinnedSyntheticTarget,
    secondClient,
  });

  assert.equal(result.firstTarget.roleName, "novalure_app");
  assert.equal(result.secondTarget.roleName, "novalure_app");
  for (const client of [firstClient, secondClient]) {
    assert.equal(client.statements[0], qaBatchLockOrderSql.begin);
    assert.ok(client.statements.indexOf(qaBatchLockOrderSql.backendIdentity) > 0);
    assert.match(client.statements.at(-1), /^rollback$/u);
    assert.equal(client.inTransaction, false);
    assert.doesNotMatch(client.statements.join("\n"), /update workspaces/u);
  }
});

test("duplicate pinned PID and partial begin failures roll back both clients before scenarios", async () => {
  const duplicateFirst = createPinnedSessionClient(303);
  const duplicateSecond = createPinnedSessionClient(303);
  await assert.rejects(
    verifyPinnedRuntimeSessions({
      config: pinnedSessionConfig(),
      env: validEnvironment(),
      firstClient: duplicateFirst,
      inspectTarget: inspectPinnedSyntheticTarget,
      secondClient: duplicateSecond,
    }),
    /two distinct pinned novalure_app PostgreSQL sessions/u,
  );
  assert.equal(duplicateFirst.inTransaction, false);
  assert.equal(duplicateSecond.inTransaction, false);
  assert.match(duplicateFirst.statements.at(-1), /^rollback$/u);
  assert.match(duplicateSecond.statements.at(-1), /^rollback$/u);

  for (const malformedPid of [undefined, null, 0, -1, 1.5, Number.NaN]) {
    const malformedFirst = createPinnedSessionClient(malformedPid);
    const malformedSecond = createPinnedSessionClient(606);
    await assert.rejects(
      verifyPinnedRuntimeSessions({
        config: { actorId, workspaceId },
        env: {},
        firstClient: malformedFirst,
        inspectTarget: async () => ({ roleName: "novalure_app" }),
        secondClient: malformedSecond,
      }),
      /two distinct pinned novalure_app PostgreSQL sessions/u,
    );
    assert.equal(malformedFirst.inTransaction, false);
    assert.equal(malformedSecond.inTransaction, false);
  }

  const healthyClient = createPinnedSessionClient(404);
  const failingClient = createPinnedSessionClient(505, { failOnBegin: true });
  await assert.rejects(
    verifyPinnedRuntimeSessions({
      config: pinnedSessionConfig(),
      env: validEnvironment(),
      firstClient: healthyClient,
      inspectTarget: inspectPinnedSyntheticTarget,
      secondClient: failingClient,
    }),
    /synthetic begin failure/u,
  );
  assert.equal(healthyClient.inTransaction, false);
  assert.equal(failingClient.inTransaction, false);
  assert.match(healthyClient.statements.at(-1), /^rollback$/u);
  assert.match(failingClient.statements.at(-1), /^rollback$/u);

  const rollbackFailingClient = createPinnedSessionClient(707, { failOnRollback: true });
  const rollbackHealthyClient = createPinnedSessionClient(808);
  await assert.rejects(
    verifyPinnedRuntimeSessions({
      config: { actorId, workspaceId },
      env: {},
      firstClient: rollbackFailingClient,
      inspectTarget: async () => ({ roleName: "novalure_app" }),
      secondClient: rollbackHealthyClient,
    }),
    /synthetic rollback failure/u,
  );
  assert.match(rollbackFailingClient.statements.at(-1), /^rollback$/u);
  assert.match(rollbackHealthyClient.statements.at(-1), /^rollback$/u);
});

test("live implementation requires two sessions and executes both start orders through rollback", async () => {
  const source = await readFile(new URL("./qa-batch-lock-order-live.mjs", import.meta.url), "utf8");
  assert.match(source, /new Pool\(\{[\s\S]*max: 2/u);
  assert.equal((source.match(/await pool\.connect\(\)/gu) ?? []).length, 2);
  assert.match(source, /firstKind: "mutation"[\s\S]*secondKind: "reset"/u);
  assert.match(source, /firstKind: "reset"[\s\S]*secondKind: "mutation"/u);
  assert.match(source, /firstKind: "mutation"[\s\S]*secondKind: "qa-disable"/u);
  assert.match(source, /firstKind: "qa-disable"[\s\S]*secondKind: "mutation"/u);
  assert.match(source, /await assertStillWaiting\(waiter/u);
  assert.match(source, /await rollback\(firstClient\)[\s\S]*await createDeadline\(waiter/u);
  assert.match(source, /inspectTarget\(\{ client: firstClient/u);
  assert.match(source, /inspectTarget\(\{ client: secondClient/u);
  assert.match(source, /verifyPinnedRuntimeSessions\([\s\S]*await validateFixture/u);
  assert.match(source, /beginScopedSession\(firstClient[\s\S]*beginScopedSession\(secondClient/u);
  assert.match(source, /verifyPinnedRuntimeSessions[\s\S]*finally \{[\s\S]*rollbackSessions\(\[firstClient, secondClient\]\)/u);
  assert.equal((source.match(/update workspaces set is_qa = false/gu) ?? []).length, 1);
  assert.doesNotMatch(source, /\.query\(\s*[`'"]\s*(?:insert|delete|merge|truncate|alter|drop|create|grant|revoke|copy)\b/iu);
  assert.match(source, /workspaceDisable[\s\S]*await rollback\(secondClient\)/u);
  assert.match(source, /catch \{[\s\S]*failed closed; no evidence emitted/u);
});

test("default CLI plan is network-free and emits no target or credential value", () => {
  const script = fileURLToPath(new URL("./qa-batch-lock-order-live.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [script], {
    encoding: "utf8",
    env: {
      ...process.env,
      NOVALURE_QA_DATABASE_URL: "postgresql://must-not-appear:must-not-appear@example.invalid/db",
    },
    timeout: 10_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /novalure\.qa\.batch-lock-order-plan\.v1/u);
  assert.match(result.stdout, /"network": false/u);
  assert.doesNotMatch(result.stdout, /postgresql:\/\/|must-not-appear/u);
});

test("CLI failures redact configuration and connection details", () => {
  const script = fileURLToPath(new URL("./qa-batch-lock-order-live.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [
    script,
    "--validate-config",
    "--workspace-id",
    workspaceId,
    "--batch-id",
    batchId,
    "--actor-id",
    actorId,
  ], {
    encoding: "utf8",
    env: {
      ...validEnvironment(),
      VERCEL_ENV: "production",
      NOVALURE_QA_DATABASE_URL: "postgresql://novalure_app:never-print-this@example.invalid/neondb?sslmode=require",
    },
    timeout: 10_000,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /failed closed; no evidence emitted/u);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /never-print-this|postgresql:\/\/|example\.invalid/u);
});
