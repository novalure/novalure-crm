#!/usr/bin/env node

import { createHash } from "node:crypto";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { Pool } from "@neondatabase/serverless";
import {
  assertConnectedDatabaseTarget,
  assertDatabaseHost,
} from "./lib/infra-targets.mjs";
import {
  assertEvidenceContainsNoSecrets,
  canonicalJson,
  fingerprint,
} from "./lib/qa-two-tenant-matrix.mjs";

export const QA_BATCH_LOCK_ORDER_CONFIRMATION = "RUN_QA_LOCK_AND_ROLLBACK_DRILL";

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const productionOriginHostnames = new Set(["novalure-crm.app", "www.novalure-crm.app"]);
const barrierObservationMs = 200;
const clientDeadlineMs = 6_000;

export const qaBatchLockOrderSql = Object.freeze({
  advisory: `select pg_advisory_xact_lock(hashtextextended('novalure.qa_batch:' || $1::text, 0))`,
  backendIdentity: `select pg_backend_pid() as "backendPid"`,
  begin: "begin",
  mutationWorkspace: `
    select batch.id
    from qa_batches batch
    inner join workspaces workspace on workspace.id = batch.workspace_id
    where batch.id = $1::uuid
      and batch.workspace_id = $2::uuid
      and workspace.is_qa = true
    for share of workspace
  `,
  resetWorkspace: `select id from workspaces where id = $1::uuid and is_qa = true for update`,
  rollback: "rollback",
  setActor: `set local app.actor_id = '${"$1"}'`,
  setLockTimeout: `set local lock_timeout = '1500ms'`,
  setStatementTimeout: `set local statement_timeout = '5000ms'`,
  setTenant: `set local app.tenant_id = '${"$1"}'`,
  workspaceDisable: `update workspaces set is_qa = false where id = $1::uuid and is_qa = true returning id`,
  validateFixture: `
    select
      workspace.id as "workspaceId",
      batch.id as "batchId",
      actor.id as "actorId"
    from workspaces workspace
    inner join qa_batches batch
      on batch.workspace_id = workspace.id
     and batch.id = $2::uuid
    inner join workspace_users actor
      on actor.workspace_id = workspace.id
     and actor.id = $3::uuid
     and actor.status = 'active'
    where workspace.id = $1::uuid
      and workspace.is_qa = true
    for share of workspace, actor
  `,
});

function required(env, name) {
  const value = env[name]?.trim() ?? "";
  if (!value) throw new Error(`${name} is required; the lock drill is fail-closed.`);
  return value;
}

function normalizeDatabaseUrl(value) {
  return value.trim().replace(/^['"]|['"]$/gu, "");
}

function exactOrigin(value, name) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid HTTPS origin.`);
  }
  if (
    url.protocol !== "https:" ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  ) {
    throw new Error(`${name} must contain exactly one HTTPS origin.`);
  }
  return url.origin;
}

function readFlagValue(argv, name) {
  const indexes = argv.reduce((matches, value, index) => value === name ? [...matches, index] : matches, []);
  if (indexes.length !== 1 || indexes[0] === argv.length - 1) {
    throw new Error(`${name} must be provided exactly once with a value.`);
  }
  return argv[indexes[0] + 1];
}

export function parseQaBatchLockOrderArgs(argv) {
  const valueFlags = new Set(["--actor-id", "--batch-id", "--workspace-id"]);
  const booleanFlags = new Set(["--execute", "--help", "--plan", "--validate-config", "-h"]);
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (valueFlags.has(value)) {
      index += 1;
      if (index >= argv.length || argv[index].startsWith("--")) {
        throw new Error(`${value} requires one value.`);
      }
      continue;
    }
    if (!booleanFlags.has(value)) throw new Error(`Unknown lock-drill argument: ${value}`);
  }
  if (argv.includes("--help") || argv.includes("-h")) {
    if (argv.length !== 1) throw new Error("Help cannot be combined with other arguments.");
    return { mode: "help" };
  }
  const modes = ["--plan", "--validate-config", "--execute"].filter((flag) => argv.includes(flag));
  if (modes.length > 1) throw new Error("Choose exactly one lock-drill mode.");
  const mode = modes[0]?.slice(2) ?? "plan";
  if (mode === "plan") {
    if (argv.some((value) => valueFlags.has(value))) {
      throw new Error("Offline plan mode does not accept target identifiers.");
    }
    return { mode };
  }

  const workspaceId = readFlagValue(argv, "--workspace-id").toLowerCase();
  const batchId = readFlagValue(argv, "--batch-id").toLowerCase();
  const actorId = readFlagValue(argv, "--actor-id").toLowerCase();
  for (const [name, value] of Object.entries({ actorId, batchId, workspaceId })) {
    if (!uuidPattern.test(value)) throw new Error(`${name} must be an exact UUID.`);
  }
  return Object.freeze({ actorId, batchId, mode, workspaceId });
}

export function validateQaBatchLockOrderTarget(env, args, options = {}) {
  if (args.mode === "plan" || args.mode === "help") {
    throw new Error("Target validation requires --validate-config or --execute.");
  }
  if (required(env, "VERCEL_ENV") !== "preview") {
    throw new Error("VERCEL_ENV must equal preview; Production and Development targets are rejected.");
  }
  const qaOrigin = exactOrigin(required(env, "NOVALURE_QA_BASE_URL"), "NOVALURE_QA_BASE_URL");
  const productionOrigin = exactOrigin(
    required(env, "NOVALURE_PRODUCTION_ORIGIN"),
    "NOVALURE_PRODUCTION_ORIGIN",
  );
  const qaHostname = new URL(qaOrigin).hostname.toLowerCase();
  if (
    qaOrigin === productionOrigin ||
    productionOriginHostnames.has(qaHostname) ||
    qaHostname === new URL(productionOrigin).hostname.toLowerCase()
  ) {
    throw new Error("QA lock drill rejected the configured Production origin.");
  }

  const databaseUrl = normalizeDatabaseUrl(required(env, "NOVALURE_QA_DATABASE_URL"));
  const declaredRole = required(env, "NOVALURE_QA_DATABASE_ROLE");
  const qaBranchId = required(env, "NOVALURE_QA_BRANCH_ID");
  const productionBranchId = required(env, "NOVALURE_PRODUCTION_BRANCH_ID");
  required(env, "NOVALURE_PRODUCTION_DATABASE_HOST");
  const qaProjectIdentity = env.NOVALURE_QA_PROJECT_ID?.trim() || env.NOVALURE_QA_PROJECT_FINGERPRINT?.trim() || "";
  const productionProjectIdentity = env.NOVALURE_PRODUCTION_PROJECT_ID?.trim()
    || env.NOVALURE_PRODUCTION_PROJECT_FINGERPRINT?.trim()
    || "";
  if (!productionProjectIdentity) {
    throw new Error("A Production project ID or fingerprint deny target is required.");
  }
  if (qaProjectIdentity === productionProjectIdentity || qaBranchId === productionBranchId) {
    throw new Error("QA and Production project/branch identities must be distinct.");
  }
  if (declaredRole !== "novalure_app") {
    throw new Error("NOVALURE_QA_DATABASE_ROLE must be exactly novalure_app for the runtime lock drill.");
  }
  let parsed;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error("NOVALURE_QA_DATABASE_URL must be a valid PostgreSQL URL.");
  }
  if (!/^postgres(?:ql)?:$/u.test(parsed.protocol)) {
    throw new Error("NOVALURE_QA_DATABASE_URL must use PostgreSQL.");
  }
  if (decodeURIComponent(parsed.username) !== "novalure_app") {
    throw new Error("The active QA URL role must be exactly novalure_app.");
  }
  if (parsed.pathname.replace(/^\//u, "") !== required(env, "NOVALURE_QA_DATABASE_NAME")) {
    throw new Error("The active QA URL database does not match NOVALURE_QA_DATABASE_NAME.");
  }
  if (!new Set(["require", "verify-full"]).has(parsed.searchParams.get("sslmode") ?? "")) {
    throw new Error("NOVALURE_QA_DATABASE_URL must enforce sslmode=require or verify-full.");
  }
  const genericDatabaseUrl = env.DATABASE_URL?.trim();
  if (genericDatabaseUrl && normalizeDatabaseUrl(genericDatabaseUrl) !== databaseUrl) {
    throw new Error("DATABASE_URL differs from NOVALURE_QA_DATABASE_URL.");
  }
  assertDatabaseHost({
    connectionMode: "pooled",
    databaseUrl,
    env,
    purpose: "QA batch lock-order drill",
    target: "test",
  });

  const allowlistedWorkspaceIds = new Set(
    required(env, "NOVALURE_QA_RESET_WORKSPACE_IDS")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );
  if (
    [...allowlistedWorkspaceIds].some((value) => !uuidPattern.test(value)) ||
    allowlistedWorkspaceIds.size < 2 ||
    !allowlistedWorkspaceIds.has(args.workspaceId)
  ) {
    throw new Error("Workspace must be one of at least two explicit QA reset allowlist entries.");
  }
  const productionWorkspaceIds = new Set(
    required(env, "NOVALURE_PRODUCTION_WORKSPACE_IDS")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );
  if (
    !productionWorkspaceIds.size ||
    [...productionWorkspaceIds].some((value) => !uuidPattern.test(value))
  ) {
    throw new Error("NOVALURE_PRODUCTION_WORKSPACE_IDS must contain explicit UUID deny targets.");
  }
  if ([...allowlistedWorkspaceIds].some((value) => productionWorkspaceIds.has(value))) {
    throw new Error("QA and Production workspace allowlists must be disjoint.");
  }
  if (productionWorkspaceIds.has(args.workspaceId)) {
    throw new Error("QA lock drill rejected a Production workspace ID.");
  }
  if (
    options.requireExecution &&
    required(env, "NOVALURE_QA_LOCK_ORDER_CONFIRM") !== QA_BATCH_LOCK_ORDER_CONFIRMATION
  ) {
    throw new Error(`NOVALURE_QA_LOCK_ORDER_CONFIRM must equal ${QA_BATCH_LOCK_ORDER_CONFIRMATION}.`);
  }

  return Object.freeze({
    actorId: args.actorId,
    batchId: args.batchId,
    databaseUrl,
    qaOrigin,
    workspaceId: args.workspaceId,
  });
}

function usage() {
  return [
    "Rollback-only QA batch lock-order drill",
    "",
    "  --plan                                              Offline plan (default)",
    "  --validate-config --workspace-id UUID --batch-id UUID --actor-id UUID",
    "  --execute         --workspace-id UUID --batch-id UUID --actor-id UUID",
    "",
    "Execute uses exactly two PostgreSQL sessions; one QA-flag UPDATE is always rolled back.",
  ].join("\n");
}

function plan() {
  return canonicalJson({
    effects: "BEGIN / SET LOCAL / SELECT locks / one QA-flag UPDATE / ROLLBACK only",
    modes: ["mutation-first", "reset-first", "mutation-vs-qa-disable", "qa-disable-vs-mutation"],
    network: false,
    requiredConfirmation: QA_BATCH_LOCK_ORDER_CONFIRMATION,
    schema: "novalure.qa.batch-lock-order-plan.v1",
  });
}

function createDeadline(promise, label) {
  let timeout;
  const deadline = new Promise((_, reject) => {
    timeout = setTimeout(() => reject(new Error(`${label} exceeded the fixed client deadline.`)), clientDeadlineMs);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timeout));
}

async function assertStillWaiting(promise, label) {
  let settled = false;
  void promise.then(
    () => { settled = true; },
    () => { settled = true; },
  );
  await new Promise((resolve) => setTimeout(resolve, barrierObservationMs));
  if (settled) throw new Error(`${label} did not wait behind the batch advisory barrier.`);
}

async function beginScopedSession(client, config) {
  await client.query(qaBatchLockOrderSql.begin);
  await client.query(qaBatchLockOrderSql.setLockTimeout);
  await client.query(qaBatchLockOrderSql.setStatementTimeout);
  await client.query(qaBatchLockOrderSql.setTenant.replace("$1", config.workspaceId));
  await client.query(qaBatchLockOrderSql.setActor.replace("$1", config.actorId));
}

async function rollback(client) {
  await client.query(qaBatchLockOrderSql.rollback);
}

async function rollbackSessions(clients, { bestEffort = false } = {}) {
  const results = await Promise.allSettled(clients.map((client) => rollback(client)));
  const failure = results.find((result) => result.status === "rejected");
  if (failure && !bestEffort) throw failure.reason;
}

export async function verifyPinnedRuntimeSessions({
  config,
  env = process.env,
  firstClient,
  inspectTarget = assertConnectedDatabaseTarget,
  secondClient,
}) {
  try {
    const pinResults = await Promise.allSettled([
      beginScopedSession(firstClient, config),
      beginScopedSession(secondClient, config),
    ]);
    const pinFailure = pinResults.find((result) => result.status === "rejected");
    if (pinFailure) throw pinFailure.reason;
    const [firstTarget, secondTarget, firstBackend, secondBackend] = await Promise.all([
      inspectTarget({ client: firstClient, env, purpose: "QA lock drill session A", target: "test" }),
      inspectTarget({ client: secondClient, env, purpose: "QA lock drill session B", target: "test" }),
      firstClient.query(qaBatchLockOrderSql.backendIdentity),
      secondClient.query(qaBatchLockOrderSql.backendIdentity),
    ]);
    const firstBackendPid = firstBackend.rows[0]?.backendPid;
    const secondBackendPid = secondBackend.rows[0]?.backendPid;
    if (
      firstTarget.roleName !== "novalure_app" ||
      secondTarget.roleName !== "novalure_app" ||
      !Number.isSafeInteger(firstBackendPid) ||
      !Number.isSafeInteger(secondBackendPid) ||
      firstBackendPid <= 0 ||
      secondBackendPid <= 0 ||
      firstBackendPid === secondBackendPid
    ) {
      throw new Error("Lock drill requires two distinct pinned novalure_app PostgreSQL sessions.");
    }
    return Object.freeze({ firstTarget, secondTarget });
  } finally {
    await rollbackSessions([firstClient, secondClient]);
  }
}

async function runBarrierScenario({ firstClient, firstKind, secondClient, secondKind, config }) {
  const firstWorkspaceSql = firstKind === "mutation"
    ? qaBatchLockOrderSql.mutationWorkspace
    : qaBatchLockOrderSql.resetWorkspace;
  const secondWorkspaceSql = secondKind === "mutation"
    ? qaBatchLockOrderSql.mutationWorkspace
    : qaBatchLockOrderSql.resetWorkspace;
  let waiter = null;
  const startedAt = Date.now();
  try {
    await beginScopedSession(firstClient, config);
    await firstClient.query(qaBatchLockOrderSql.advisory, [config.batchId]);
    const firstWorkspaceParams = firstKind === "mutation"
      ? [config.batchId, config.workspaceId]
      : [config.workspaceId];
    const secondWorkspaceParams = secondKind === "mutation"
      ? [config.batchId, config.workspaceId]
      : [config.workspaceId];
    const firstWorkspace = await firstClient.query(firstWorkspaceSql, firstWorkspaceParams);
    if (firstWorkspace.rowCount !== 1) throw new Error(`${firstKind} workspace lock did not resolve exactly one QA row.`);

    await beginScopedSession(secondClient, config);
    waiter = secondClient.query(qaBatchLockOrderSql.advisory, [config.batchId]);
    await assertStillWaiting(waiter, `${secondKind}-second`);
    await rollback(firstClient);
    await createDeadline(waiter, `${secondKind} advisory acquisition`);
    const secondWorkspace = await secondClient.query(secondWorkspaceSql, secondWorkspaceParams);
    if (secondWorkspace.rowCount !== 1) throw new Error(`${secondKind} workspace lock did not resolve exactly one QA row.`);
    await rollback(secondClient);
    return Object.freeze({
      barrierObserved: true,
      durationMs: Date.now() - startedAt,
      order: `${firstKind}-first`,
      status: "pass",
    });
  } finally {
    await rollbackSessions([firstClient], { bestEffort: true });
    if (waiter) await Promise.allSettled([waiter]);
    await rollbackSessions([secondClient], { bestEffort: true });
  }
}

async function runQaFlagRaceScenario({ firstClient, firstKind, secondClient, secondKind, config }) {
  const startedAt = Date.now();
  let waiter = null;
  try {
    await beginScopedSession(firstClient, config);
    if (firstKind === "mutation") {
      await firstClient.query(qaBatchLockOrderSql.advisory, [config.batchId]);
      const mutation = await firstClient.query(qaBatchLockOrderSql.mutationWorkspace, [
        config.batchId,
        config.workspaceId,
      ]);
      if (mutation.rowCount !== 1) throw new Error("mutation workspace lock did not resolve exactly one QA batch row.");
    } else {
      const disabled = await firstClient.query(qaBatchLockOrderSql.workspaceDisable, [config.workspaceId]);
      if (disabled.rowCount !== 1) throw new Error("QA flag race did not resolve exactly one workspace row.");
    }

    await beginScopedSession(secondClient, config);
    if (secondKind === "mutation") {
      await secondClient.query(qaBatchLockOrderSql.advisory, [config.batchId]);
      waiter = secondClient.query(qaBatchLockOrderSql.mutationWorkspace, [
        config.batchId,
        config.workspaceId,
      ]);
    } else {
      waiter = secondClient.query(qaBatchLockOrderSql.workspaceDisable, [config.workspaceId]);
    }
    await assertStillWaiting(waiter, `${secondKind}-second`);
    await rollback(firstClient);
    const secondResult = await createDeadline(waiter, `${secondKind} workspace lock acquisition`);
    if (secondResult.rowCount !== 1) throw new Error(`${secondKind} did not resolve exactly one QA workspace row.`);
    await rollback(secondClient);
    return Object.freeze({
      barrierObserved: true,
      durationMs: Date.now() - startedAt,
      order: `${firstKind}-first`,
      status: "pass",
    });
  } finally {
    await rollbackSessions([firstClient], { bestEffort: true });
    if (waiter) await Promise.allSettled([waiter]);
    await rollbackSessions([secondClient], { bestEffort: true });
  }
}

async function validateFixture(client, config) {
  await beginScopedSession(client, config);
  try {
    const fixture = await client.query(qaBatchLockOrderSql.validateFixture, [
      config.workspaceId,
      config.batchId,
      config.actorId,
    ]);
    if (fixture.rowCount !== 1) {
      throw new Error("Exact QA workspace, batch and active actor fixture was not found.");
    }
  } finally {
    await rollback(client);
  }
}

export async function executeQaBatchLockOrderDrill(config, env = process.env) {
  const pool = new Pool({
    allowExitOnIdle: true,
    connectionString: config.databaseUrl,
    connectionTimeoutMillis: 5_000,
    max: 2,
  });
  let firstClient;
  let secondClient;
  try {
    firstClient = await pool.connect();
    secondClient = await pool.connect();
    const { firstTarget } = await verifyPinnedRuntimeSessions({
      config,
      env,
      firstClient,
      secondClient,
    });
    await validateFixture(firstClient, config);

    const mutationFirst = await runBarrierScenario({
      config,
      firstClient,
      firstKind: "mutation",
      secondClient,
      secondKind: "reset",
    });
    const resetFirst = await runBarrierScenario({
      config,
      firstClient,
      firstKind: "reset",
      secondClient,
      secondKind: "mutation",
    });
    const mutationBeforeQaDisable = await runQaFlagRaceScenario({
      config,
      firstClient,
      firstKind: "mutation",
      secondClient,
      secondKind: "qa-disable",
    });
    const qaDisableBeforeMutation = await runQaFlagRaceScenario({
      config,
      firstClient,
      firstKind: "qa-disable",
      secondClient,
      secondKind: "mutation",
    });
    const targetDigest = createHash("sha256")
      .update([
        firstTarget.projectId,
        firstTarget.branchId,
        firstTarget.databaseName,
        firstTarget.roleName,
      ].join("\0"))
      .digest("hex");
    const evidence = {
      batchFingerprint: fingerprint(config.batchId),
      generatedAt: new Date().toISOString(),
      hostFingerprint: fingerprint(new URL(config.databaseUrl).hostname),
      scenarios: [mutationFirst, resetFirst, mutationBeforeQaDisable, qaDisableBeforeMutation],
      schema: "novalure.qa.batch-lock-order-evidence.v1",
      sessions: { distinct: true, expected: 2 },
      targetFingerprint: `sha256:${targetDigest.slice(0, 16)}`,
      timeouts: { clientMs: clientDeadlineMs, lockMs: 1_500, statementMs: 5_000 },
      workspaceFingerprint: fingerprint(config.workspaceId),
      writes: 0,
    };
    assertEvidenceContainsNoSecrets(evidence);
    return evidence;
  } finally {
    await rollbackSessions([firstClient, secondClient].filter(Boolean), { bestEffort: true });
    firstClient?.release();
    secondClient?.release();
    await pool.end();
  }
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const args = parseQaBatchLockOrderArgs(argv);
  if (args.mode === "help") {
    console.log(usage());
    return;
  }
  if (args.mode === "plan") {
    console.log(plan().trimEnd());
    return;
  }
  const config = validateQaBatchLockOrderTarget(env, args, { requireExecution: args.mode === "execute" });
  if (args.mode === "validate-config") {
    console.log(canonicalJson({
      mode: "validate-config",
      network: false,
      schema: "novalure.qa.batch-lock-order-validation.v1",
      status: "pass",
      targetFingerprint: fingerprint([
        env.NOVALURE_QA_PROJECT_ID ?? env.NOVALURE_QA_PROJECT_FINGERPRINT,
        env.NOVALURE_QA_BRANCH_ID,
        env.NOVALURE_QA_DATABASE_NAME,
        env.NOVALURE_QA_DATABASE_ROLE,
      ].join("\0")),
    }).trimEnd());
    return;
  }
  const evidence = await executeQaBatchLockOrderDrill(config, env);
  console.log(canonicalJson(evidence).trimEnd());
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch {
    console.error("QA batch lock-order drill failed closed; no evidence emitted.");
    process.exitCode = 1;
  }
}
