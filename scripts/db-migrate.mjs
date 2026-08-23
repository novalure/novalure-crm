#!/usr/bin/env node
import { createHash, timingSafeEqual } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { Pool } from "@neondatabase/serverless";
import {
  assertConnectedDatabaseTarget,
  assertDatabaseTarget,
} from "./lib/infra-targets.mjs";

const targetEnvFiles = Object.freeze({
  prod: ".env.production.local",
  test: ".env.local",
});

const baselineVersion = "041_schema_ledger_baseline";
const baselineNumber = 41;
const ledgerTable = "public.novalure_schema_migrations";
const lockKey = 941041;
const guardQueryTimeoutMs = 15_000;
const migrationClientTimeoutMs = 960_000;
const manualCutoverVersions = new Set([
  "057_bot_webhook_legacy_index_cutover",
  "060_tenant_rls_pilot_prepare",
  "061_validate_and_activate_tenant_rls_pilot",
  "062_private_media_contract_cutover",
  "065_notification_guard_search_path_hardening",
  "068_qa_batch_reset_safety",
  "074_validate_launch_tenant_relation_guards",
]);
const migrationDependencies = new Map([
  ["052_validate_property_inventory_tenant_guards", "049_property_inventory_tenant_guards"],
  ["057_bot_webhook_legacy_index_cutover", "048_bot_webhook_integrity"],
  ["061_validate_and_activate_tenant_rls_pilot", "060_tenant_rls_pilot_prepare"],
  ["062_private_media_contract_cutover", "051_private_media_access"],
  ["064_notification_provider_and_lead_assignee_integrity", "050_durable_job_leasing"],
  ["065_notification_guard_search_path_hardening", "064_notification_provider_and_lead_assignee_integrity"],
  ["066_oauth_state_workspace_user_guard", "053_oauth_state_integrity"],
  ["068_qa_batch_reset_safety", "060_tenant_rls_pilot_prepare"],
  ["069_property_unit_idempotency", "049_property_inventory_tenant_guards"],
  ["070_funnel_submission_idempotency_recovery", "055_public_submission_abuse_guards"],
  ["071_forms_owner_tenant_guard", "066_oauth_state_workspace_user_guard"],
  ["072_form_submission_atomicity", [
    "070_funnel_submission_idempotency_recovery",
    "071_forms_owner_tenant_guard",
  ]],
  ["073_launch_tenant_relation_guards", "072_form_submission_atomicity"],
  ["074_validate_launch_tenant_relation_guards", "073_launch_tenant_relation_guards"],
  ["075_public_funnel_visit_truth", [
    "074_validate_launch_tenant_relation_guards",
    "060_tenant_rls_pilot_prepare",
  ]],
  ["076_bot_webhook_durable_processing", [
    "075_public_funnel_visit_truth",
    "057_bot_webhook_legacy_index_cutover",
  ]],
  ["077_schema_ledger_runtime_projection", "076_bot_webhook_durable_processing"],
]);
const validCommands = new Set(["status", "dry-run", "up"]);

function requiredMigrationVersions(version) {
  const required = migrationDependencies.get(version);
  if (!required) return [];
  return Array.isArray(required) ? required : [required];
}

function fail(message) {
  console.error(`[ERROR] ${message}`);
  process.exit(1);
}

function loadEnvFile(path) {
  if (!existsSync(path)) return;

  for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const index = line.indexOf("=");
    const key = line.slice(0, index).trim();
    let value = line.slice(index + 1).trim();
    value = value.replace(/^['"]|['"]$/g, "");
    if (!process.env[key]) process.env[key] = value;
  }
}

function cleanDatabaseUrl(value) {
  if (!value) return "";

  const trimmed = value.trim().replace(/^['"]|['"]$/g, "");
  const prefixedUrl = trimmed.match(/^[A-Z0-9_]+=((?:postgres|postgresql):\/\/.+)$/i);

  return prefixedUrl?.[1] ?? trimmed;
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const command = args.find((arg) => !arg.startsWith("--"));
  const onlyArg = args.find((arg) => arg.startsWith("--only="));
  const planTokenFileArg = args.find((arg) => arg.startsWith("--plan-token-file="));
  const allowManualCutover = args.includes("--allow-manual-cutover");

  if (!command || !validCommands.has(command)) {
    fail(`Command required: ${[...validCommands].join("|")}`);
  }

  if (allowManualCutover && !onlyArg) {
    fail("--allow-manual-cutover requires one explicit --only=<version>");
  }
  if (command === "up" && !planTokenFileArg) {
    fail("up requires --plan-token-file=<absolute path> produced by a prior dry-run");
  }
  if (command === "status" && planTokenFileArg) {
    fail("--plan-token-file is valid only for dry-run or up");
  }

  return {
    allowManualCutover,
    command,
    only: onlyArg ? onlyArg.slice("--only=".length).trim() : "",
    planTokenFile: planTokenFileArg
      ? planTokenFileArg.slice("--plan-token-file=".length).trim()
      : "",
  };
}

function resolvePlanTokenFile(path) {
  if (!path || !isAbsolute(path)) {
    throw new Error("Migration plan token file must use an absolute path outside the repository.");
  }
  const normalized = resolve(path);
  const repositoryRelative = relative(process.cwd(), normalized);
  if (
    repositoryRelative === "" ||
    (repositoryRelative !== ".." && !repositoryRelative.startsWith(`..${sep}`))
  ) {
    throw new Error("Migration plan token file must be outside the repository.");
  }
  return normalized;
}

function resolveTarget() {
  const targetName = process.env.MIGRATION_TARGET;
  if (!targetName || !(targetName in targetEnvFiles)) {
    fail("MIGRATION_TARGET must be explicitly set to 'test' or 'prod'");
  }

  loadEnvFile(join(process.cwd(), targetEnvFiles[targetName]));

  const databaseUrl =
    cleanDatabaseUrl(process.env.MIGRATION_DATABASE_URL);

  if (!databaseUrl) fail("MIGRATION_DATABASE_URL is missing");

  let verifiedTarget;
  try {
    verifiedTarget = assertDatabaseTarget({
      connectionMode: "direct",
      databaseUrl,
      purpose: "schema migration",
      target: targetName,
    });
  } catch (error) {
    fail(error instanceof Error ? error.message : "Database target verification failed");
  }

  const hostFingerprint = createHash("sha256")
    .update(verifiedTarget.host)
    .digest("hex")
    .slice(0, 16);
  console.log(`Active DB host fingerprint: sha256:${hostFingerprint}`);
  console.log(`Active target: ${targetName}`);
  console.log("Active project identity verified");

  return { databaseUrl, name: targetName };
}

function normalizeSqlContent(content) {
  return content.replace(/\r\n/g, "\n");
}

function checksum(content) {
  return createHash("sha256").update(normalizeSqlContent(content)).digest("hex");
}

function assertMigrationFileTracked(gitPath) {
  try {
    execFileSync("git", ["ls-files", "--error-unmatch", gitPath], { stdio: "ignore" });
  } catch {
    fail(`Refusing migration file that is not tracked by git: ${gitPath}`);
  }
}

function readGitObjectHash(cwd, revision) {
  return execFileSync("git", ["rev-parse", revision], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

export function assertMigrationCommitted({ cwd = process.cwd(), migration }) {
  let headHash;
  try {
    headHash = readGitObjectHash(cwd, `HEAD:${migration.path}`);
  } catch {
    throw new Error(`Refusing migration that is not committed in HEAD: ${migration.path}`);
  }

  let indexHash;
  try {
    indexHash = readGitObjectHash(cwd, `:${migration.path}`);
  } catch {
    throw new Error(`Refusing migration missing from the git index: ${migration.path}`);
  }

  const worktreeHash = execFileSync("git", ["hash-object", migration.path], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
  const headContent = execFileSync("git", ["show", `HEAD:${migration.path}`], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const headChecksum = checksum(headContent);

  if (indexHash !== headHash || worktreeHash !== headHash || headChecksum !== migration.checksum) {
    throw new Error(
      `Refusing migration with staged, worktree, or checksum drift from HEAD: ${migration.path}`,
    );
  }
}

export function assertMigrationPlanCommitted({ cwd = process.cwd(), plan }) {
  for (const migration of plan) assertMigrationCommitted({ cwd, migration });
}

export function assertRepositoryCommitted({ cwd = process.cwd() } = {}) {
  const status = execFileSync(
    "git",
    ["status", "--porcelain=v1", "--untracked-files=all"],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
  );
  if (status.trim()) {
    throw new Error("Refusing migration from a dirty repository; use a reviewed clean commit.");
  }
  return readGitObjectHash(cwd, "HEAD");
}

export async function applyCommittedMigrationPlan({ apply, cwd = process.cwd(), plan }) {
  assertMigrationPlanCommitted({ cwd, plan });
  for (const migration of plan) await apply(migration);
}

export function createMigrationPlanToken({ connectedTarget, headCommit, ledgerRows, plan }) {
  const payload = {
    connectedTarget: {
      branchId: connectedTarget.branchId,
      databaseName: connectedTarget.databaseName,
      projectId: connectedTarget.projectId,
      roleName: connectedTarget.roleName,
      serverVersionNum: connectedTarget.serverVersionNum,
      target: connectedTarget.target,
    },
    format: "novalure-migration-plan-v1",
    headCommit,
    ledger: ledgerRows
      .map((row) => ({ checksum: row.checksum ?? null, version: row.version }))
      .sort((left, right) => left.version.localeCompare(right.version)),
    plan: plan.map((migration) => ({
      checksum: migration.checksum,
      version: migration.version,
    })),
  };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function writeMigrationPlanToken(path, token) {
  const targetPath = resolvePlanTokenFile(path);
  writeFileSync(targetPath, `${token}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
}

function consumeMigrationPlanToken(path, expectedToken) {
  const targetPath = resolvePlanTokenFile(path);
  const pathStat = lstatSync(targetPath);
  if (!pathStat.isFile() || pathStat.size < 64 || pathStat.size > 128) {
    throw new Error("Migration plan token path must be a small regular file.");
  }
  const descriptor = openSync(
    targetPath,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
  );
  let suppliedToken = "";
  try {
    const descriptorStat = fstatSync(descriptor);
    if (
      !descriptorStat.isFile() ||
      descriptorStat.dev !== pathStat.dev ||
      descriptorStat.ino !== pathStat.ino ||
      descriptorStat.size < 64 ||
      descriptorStat.size > 128
    ) {
      throw new Error("Migration plan token file changed before it could be verified.");
    }
    const buffer = Buffer.alloc(129);
    const bytesRead = readSync(descriptor, buffer, 0, buffer.length, 0);
    if (bytesRead > 128) {
      throw new Error("Migration plan token file is larger than allowed.");
    }
    suppliedToken = buffer.subarray(0, bytesRead).toString("utf8").trim();
  } finally {
    closeSync(descriptor);
  }
  if (!/^[a-f0-9]{64}$/.test(suppliedToken)) {
    throw new Error("Migration plan token is missing or malformed.");
  }
  if (!timingSafeEqual(Buffer.from(suppliedToken, "hex"), Buffer.from(expectedToken, "hex"))) {
    throw new Error("Migration plan token does not match the current commit, target, ledger, or plan.");
  }
}

function readMigrations() {
  const migrationsDir = join(process.cwd(), "migrations");

  return readdirSync(migrationsDir)
    .filter((file) => file.endsWith(".sql"))
    .map((file) => {
      const match = file.match(/^(\d{3})_(.+)\.sql$/);
      if (!match) fail(`Invalid migration filename: ${file}`);

      const version = file.replace(/\.sql$/, "");
      const content = readFileSync(join(migrationsDir, file), "utf8");
      const gitPath = `migrations/${file}`;
      assertMigrationFileTracked(gitPath);

      return {
        content,
        checksum: checksum(content),
        file,
        manualCutover: manualCutoverVersions.has(version),
        name: match[2],
        number: Number(match[1]),
        path: gitPath,
        rollback: version.endsWith("_rollback"),
        version,
      };
    })
    .sort((left, right) => left.number - right.number || left.file.localeCompare(right.file));
}

async function ledgerExists(client) {
  const result = await client.query({
    query_timeout: guardQueryTimeoutMs,
    text: `
    select to_regclass($1) as "tableName"
  `,
    values: [ledgerTable],
  });
  return Boolean(result.rows[0]?.tableName);
}

async function readLedger(client) {
  if (!(await ledgerExists(client))) return { exists: false, rows: [] };

  const result = await client.query({
    query_timeout: guardQueryTimeoutMs,
    text: `
    select version, name, checksum, applied_at as "appliedAt"
    from public.novalure_schema_migrations
    order by version asc
  `,
  });

  return {
    exists: true,
    rows: result.rows.map((row) => ({
      appliedAt: row.appliedAt,
      checksum: row.checksum,
      name: row.name,
      number: Number(String(row.version).slice(0, 3)),
      version: row.version,
    })),
  };
}

export function resolveMigrationLedgerState({ ledgerRows, migrations }) {
  const runnable = migrations.filter((migration) => !migration.rollback);
  const migrationsByNumber = new Map();
  const appliedVersions = new Set();
  const checksummedVersions = new Set();
  const aliases = [];

  for (const migration of runnable) {
    if (!migrationsByNumber.has(migration.number)) migrationsByNumber.set(migration.number, []);
    migrationsByNumber.get(migration.number).push(migration);

    const canonicalRows = ledgerRows.filter((row) => row.version === migration.version);
    if (canonicalRows.length > 1) {
      throw new Error(`Ambiguous canonical ledger rows for ${migration.version}`);
    }

    const canonicalRow = canonicalRows[0];
    if (!canonicalRow) continue;
    if (canonicalRow.checksum && canonicalRow.checksum !== migration.checksum) {
      throw new Error(
        `Checksum mismatch for ${migration.version}: ledger ${canonicalRow.checksum}, file ${migration.checksum}`,
      );
    }
    appliedVersions.add(migration.version);
    if (canonicalRow.checksum === migration.checksum) checksummedVersions.add(migration.version);
  }

  for (const [number, candidates] of migrationsByNumber) {
    const aliasVersion = String(number).padStart(3, "0");
    const numericAliasRows = ledgerRows.filter(
      (row) => /^\d{3}$/.test(String(row.version)) && row.version === aliasVersion,
    );
    if (!numericAliasRows.length) continue;
    if (numericAliasRows.length !== 1) {
      throw new Error(
        `Ambiguous legacy numeric alias ${aliasVersion}: expected exactly one ledger row, found ${numericAliasRows.length}`,
      );
    }

    const parallelCanonicalRows = ledgerRows.filter((row) =>
      candidates.some((migration) => migration.version === row.version),
    );
    if (parallelCanonicalRows.length) {
      throw new Error(
        `Refusing parallel canonical and legacy alias rows for ${aliasVersion}: ${parallelCanonicalRows.map((row) => row.version).join(", ")}`,
      );
    }

    const sameNumberRows = ledgerRows.filter((row) => row.number === number);
    if (sameNumberRows.length !== 1) {
      throw new Error(
        `Ambiguous ledger number ${aliasVersion}: legacy alias exists alongside ${sameNumberRows.filter((row) => row.version !== aliasVersion).map((row) => row.version).join(", ") || "another ledger row"}`,
      );
    }

    const aliasRow = numericAliasRows[0];
    if (!aliasRow.checksum) {
      throw new Error(`Missing checksum for legacy numeric alias ${aliasVersion}`);
    }

    const checksumMatches = candidates.filter(
      (migration) => migration.checksum === aliasRow.checksum,
    );
    if (!checksumMatches.length) {
      throw new Error(
        `Checksum mismatch for legacy numeric alias ${aliasVersion}: ledger ${aliasRow.checksum} does not match a local migration with that number`,
      );
    }
    if (checksumMatches.length !== 1) {
      throw new Error(
        `Ambiguous checksum for legacy numeric alias ${aliasVersion}: matches ${checksumMatches.map((migration) => migration.version).join(", ")}`,
      );
    }

    const migration = checksumMatches[0];
    appliedVersions.add(migration.version);
    checksummedVersions.add(migration.version);
    aliases.push({
      aliasVersion,
      checksum: aliasRow.checksum,
      migrationVersion: migration.version,
    });
  }

  for (const [version] of migrationDependencies) {
    for (const requiredVersion of requiredMigrationVersions(version)) {
      if (!appliedVersions.has(version) || checksummedVersions.has(requiredVersion)) continue;
      throw new Error(
        `Invalid migration ledger: ${version} is applied without required predecessor ${requiredVersion} carrying its exact checksum`,
      );
    }
  }

  return { aliases, appliedVersions, checksummedVersions };
}

function checkedMigrationLedgerState(args) {
  try {
    return resolveMigrationLedgerState(args);
  } catch (error) {
    fail(error instanceof Error ? error.message : "Migration ledger verification failed");
  }
}

function numberCollisions(ledgerRows, migrations, aliases) {
  const migrationsByNumber = new Map();
  const verifiedAliasVersions = new Set(aliases.map((alias) => alias.aliasVersion));
  for (const migration of migrations) {
    if (migration.rollback) continue;
    if (!migrationsByNumber.has(migration.number)) migrationsByNumber.set(migration.number, []);
    migrationsByNumber.get(migration.number).push(migration.version);
  }

  return ledgerRows.flatMap((row) => {
    const codeVersions = migrationsByNumber.get(row.number) ?? [];
    if (
      !codeVersions.length ||
      codeVersions.includes(row.version) ||
      verifiedAliasVersions.has(row.version)
    ) return [];
    return [{ ledger: row.version, number: row.number, codeVersions }];
  });
}

export function createMigrationPlan({ allowManualCutover, ledgerRows, migrations, only }) {
  const { appliedVersions, checksummedVersions } = resolveMigrationLedgerState({ ledgerRows, migrations });
  const hasBaseline = appliedVersions.has(baselineVersion);
  const runnable = migrations.filter((migration) => !migration.rollback);

  if (only) {
    const migration = runnable.find((candidate) => candidate.version === only || candidate.file === only);
    if (!migration) throw new Error(`--only migration not found: ${only}`);
    if (hasBaseline && migration.number < baselineNumber) return [];
    if (migration.manualCutover && !allowManualCutover) {
      throw new Error(
        `Refusing manual cutover migration ${migration.version}: repeat with both --only and --allow-manual-cutover after its documented gates pass`,
      );
    }
    const missingRequiredMigrations = requiredMigrationVersions(migration.version)
      .filter((requiredMigration) => !checksummedVersions.has(requiredMigration));
    if (missingRequiredMigrations.length) {
      throw new Error(
        `Refusing migration ${migration.version}: required predecessor ${missingRequiredMigrations.join(", ")} is not checksummed in the ledger`,
      );
    }
    return appliedVersions.has(migration.version) ? [] : [migration];
  }

  const plan = runnable.filter((migration) => {
    if (migration.manualCutover) return false;
    if (appliedVersions.has(migration.version)) return false;
    if (hasBaseline && migration.number < baselineNumber) return false;
    if (!hasBaseline && migration.number < baselineNumber) return false;
    return true;
  });

  const availableVersions = new Set(checksummedVersions);
  for (const migration of plan) {
    const missingRequiredMigrations = requiredMigrationVersions(migration.version)
      .filter((requiredMigration) => !availableVersions.has(requiredMigration));
    if (missingRequiredMigrations.length) {
      throw new Error(
        `Refusing migration ${migration.version}: required predecessor ${missingRequiredMigrations.join(", ")} is neither checksummed in the ledger nor ordered earlier in this plan`,
      );
    }
    availableVersions.add(migration.version);
  }

  return plan;
}

function plannedMigrations(args) {
  try {
    return createMigrationPlan(args);
  } catch (error) {
    fail(error instanceof Error ? error.message : "Migration plan verification failed");
  }
}

export function validateMigrationPlan({ ledgerRows, migrations, plan }) {
  resolveMigrationLedgerState({ ledgerRows, migrations });

  for (const migration of plan) {
    const conflictingRows = ledgerRows.filter(
      (row) => row.number === migration.number && row.version !== migration.version,
    );
    if (conflictingRows.length) {
      throw new Error(
        `Refusing migration ${migration.version}: number ${String(migration.number).padStart(3, "0")} already exists in ledger as ${conflictingRows.map((row) => row.version).join(", ")}`,
      );
    }
  }
}

function assertChecksumSafety(args) {
  try {
    validateMigrationPlan(args);
  } catch (error) {
    fail(error instanceof Error ? error.message : "Migration checksum verification failed");
  }
}

function printStatus({ ledger, migrations, plan }) {
  const { aliases, appliedVersions } = checkedMigrationLedgerState({
    ledgerRows: ledger.rows,
    migrations,
  });
  const hasBaseline = appliedVersions.has(baselineVersion);
  const collisions = numberCollisions(ledger.rows, migrations, aliases);
  const legacyWithoutChecksum = ledger.rows.filter((row) => !row.checksum);

  console.log(`Ledger table: ${ledger.exists ? "present" : "missing"}`);
  console.log(`Baseline ${baselineVersion}: ${hasBaseline ? "present" : "missing"}`);
  console.log(`Migration files: ${migrations.length}`);
  console.log(`Ledger rows: ${ledger.rows.length}`);
  console.log(`Legacy ledger rows without checksum: ${legacyWithoutChecksum.length}`);

  console.log("Verified legacy numeric aliases:");
  if (!aliases.length) {
    console.log("  - none");
  } else {
    for (const alias of aliases) {
      console.log(`  - ${alias.aliasVersion} -> ${alias.migrationVersion} ${alias.checksum}`);
    }
  }

  if (collisions.length) {
    console.log("Number collisions / ledger-only legacy rows:");
    for (const collision of collisions) {
      console.log(
        `  - ${String(collision.number).padStart(3, "0")}: ledger=${collision.ledger}; code=${collision.codeVersions.join(", ")}`,
      );
    }
  }

  if (legacyWithoutChecksum.length) {
    console.log("Legacy rows without checksum, tolerated but not treated as verified file checksums:");
    for (const row of legacyWithoutChecksum) {
      console.log(`  - ${row.version}`);
    }
  }

  console.log("Planned migrations:");
  if (!plan.length) {
    console.log("  - none");
  } else {
    for (const migration of plan) {
      console.log(`  - ${migration.version} ${migration.checksum} ${migration.path}`);
    }
  }

  const pendingManualCutovers = migrations.filter(
    (migration) => migration.manualCutover && !appliedVersions.has(migration.version),
  );
  console.log("Pending manual cutover migrations (never included automatically):");
  if (!pendingManualCutovers.length) {
    console.log("  - none");
  } else {
    for (const migration of pendingManualCutovers) {
      console.log(`  - ${migration.version} ${migration.checksum} ${migration.path}`);
    }
  }

  if (hasBaseline) {
    const covered = migrations.filter(
      (migration) =>
        !migration.rollback &&
        migration.number < baselineNumber &&
        !appliedVersions.has(migration.version),
    ).length;
    console.log(`Historical migrations covered by baseline, not ledgered individually: ${covered}`);
  }
}

async function applyMigration(client, migration) {
  console.log(`Applying ${migration.path}`);
  await client.query("begin");
  try {
    await client.query("set local search_path = public");
    await client.query({ query_timeout: migrationClientTimeoutMs, text: migration.content });
    await client.query(
      `
      insert into public.novalure_schema_migrations (version, name, checksum)
      values ($1, $2, $3)
    `,
      [migration.version, migration.name, migration.checksum],
    );
    await client.query("commit");
    console.log(`Applied ${migration.path}`);
  } catch (error) {
    await client.query("rollback");
    throw error;
  }
}

async function main() {
  const { allowManualCutover, command, only, planTokenFile } = parseArgs(process.argv);
  const target = resolveTarget();
  const migrations = readMigrations();
  let headCommit = readGitObjectHash(process.cwd(), "HEAD");
  if (command === "dry-run" || command === "up") {
    headCommit = assertRepositoryCommitted();
    assertMigrationPlanCommitted({
      plan: migrations.filter((migration) => !migration.rollback),
    });
  }
  const pool = new Pool({
    connectionString: target.databaseUrl,
    connectionTimeoutMillis: 10_000,
    idle_in_transaction_session_timeout: 60_000,
    query_timeout: migrationClientTimeoutMs,
  });
  const client = await pool.connect();

  try {
    const connectedTarget = await assertConnectedDatabaseTarget({
      client,
      connectionMode: "direct",
      minimumServerVersionNum: 170000,
      purpose: "schema migration",
      target: target.name,
    });
    console.log("Connected database fingerprint verified");
    await client.query({
      query_timeout: guardQueryTimeoutMs,
      text: "set search_path = public",
    });
    const searchPath = await client.query({
      query_timeout: guardQueryTimeoutMs,
      text: `select
         current_setting('search_path') as "searchPath",
         current_schema() as "currentSchema"`,
    });
    if (
      searchPath.rows[0]?.searchPath !== "public" ||
      searchPath.rows[0]?.currentSchema !== "public"
    ) {
      throw new Error("Schema migration search_path verification failed.");
    }

    let hasLock = false;
    if (command === "up") {
      await client.query({ query_timeout: guardQueryTimeoutMs, text: "set lock_timeout = '5s'" });
      await client.query({ query_timeout: guardQueryTimeoutMs, text: "set statement_timeout = '14min'" });
      await client.query({ query_timeout: guardQueryTimeoutMs, text: "set transaction_timeout = '15min'" });
      const lock = await client.query({
        query_timeout: guardQueryTimeoutMs,
        text: 'select pg_try_advisory_lock($1) as "acquired"',
        values: [lockKey],
      });
      if (lock.rows[0]?.acquired !== true) {
        throw new Error("Another schema migration holds the advisory lock; no change was made.");
      }
      hasLock = true;
    }

    const ledger = await readLedger(client);
    const plan = plannedMigrations({ allowManualCutover, ledgerRows: ledger.rows, migrations, only });
    assertChecksumSafety({ ledgerRows: ledger.rows, migrations, plan });
    const planToken = createMigrationPlanToken({
      connectedTarget,
      headCommit,
      ledgerRows: ledger.rows,
      plan,
    });

    try {
      if (command === "status" || command === "dry-run") {
        printStatus({ ledger, migrations, plan });
        if (command === "dry-run") {
          if (planTokenFile) writeMigrationPlanToken(planTokenFile, planToken);
          console.log(`Migration plan token: sha256:${planToken}`);
          console.log("Dry run only: no migration executed.");
        }
        process.exitCode = 0;
      } else {
        consumeMigrationPlanToken(planTokenFile, planToken);
        if (!plan.length) {
          console.log("No pending migrations.");
        } else {
          await applyCommittedMigrationPlan({
            apply: (migration) => applyMigration(client, migration),
            plan,
          });
        }

        const nextLedger = await readLedger(client);
        const nextPlan = plannedMigrations({ ledgerRows: nextLedger.rows, migrations, only: "" });
        printStatus({ ledger: nextLedger, migrations, plan: nextPlan });
      }
    } finally {
      if (hasLock) {
        await client.query({
          query_timeout: guardQueryTimeoutMs,
          text: "select pg_advisory_unlock($1)",
          values: [lockKey],
        });
      }
    }
  } finally {
    client.release();
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
