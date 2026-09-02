#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  unlinkSync,
} from "node:fs";
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import process from "node:process";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { Pool } from "@neondatabase/serverless";
import {
  assertRepositoryCommitted,
  createMigrationPlanToken,
  readMigrationDatabaseUrlFromStdin,
} from "./db-migrate.mjs";
import {
  assertConnectedDatabaseTarget,
  assertDatabaseTarget,
} from "./lib/infra-targets.mjs";
import {
  recoveryManualCutoverMigrations,
  recoveryMigrationPlan,
  recoveryMigrationPlanContract,
} from "./lib/recovery-migration-plan.mjs";
import {
  tenantCutoverMigrationPath,
  tenantCutoverMigrationVersion,
  tenantCutoverRoleProvisioningSql,
} from "./lib/tenant-cutover-role-provisioning.mjs";

const maximumChildOutputBytes = 2 * 1_024 * 1_024;
const manualCutovers = new Set(recoveryManualCutoverMigrations);
const migrationClientTimeoutMs = 960_000;
const recoveryMigrationLockKey = 941041;

export { recoveryMigrationPlan } from "./lib/recovery-migration-plan.mjs";

function parseArgs(argv) {
  const values = new Map();
  for (const argument of argv) {
    if (argument === "--execute") {
      values.set("execute", "1");
      continue;
    }
    const match = argument.match(/^--(confirm-branch|evidence-dir)=(.+)$/u);
    if (!match) throw new Error("Unexpected Recovery rehearsal argument.");
    values.set(match[1], match[2].trim());
  }
  if (!values.has("execute")) throw new Error("Recovery rehearsal requires --execute.");
  return values;
}

function requireRecoveryBoundary(args, env) {
  if (env.MIGRATION_TARGET !== "recovery") {
    throw new Error("Recovery rehearsal requires MIGRATION_TARGET=recovery.");
  }
  const branchId = String(env.NOVALURE_RECOVERY_BRANCH_ID ?? "").trim();
  const productionBranchId = String(env.NOVALURE_PRODUCTION_BRANCH_ID ?? "").trim();
  if (!/^br-[A-Za-z0-9-]{8,128}$/u.test(branchId) || branchId === productionBranchId) {
    throw new Error("Recovery branch boundary is invalid.");
  }
  if (args.get("confirm-branch") !== branchId) {
    throw new Error("Recovery branch confirmation does not match the declared target.");
  }
  return branchId;
}

function requireEvidenceDirectory(value) {
  if (!value || !isAbsolute(value)) {
    throw new Error("--evidence-dir must be an absolute path outside the candidate worktree.");
  }
  const evidenceDirectory = resolve(value);
  const worktreeRelative = relative(process.cwd(), evidenceDirectory);
  if (
    worktreeRelative === "" ||
    (worktreeRelative !== ".." && !worktreeRelative.startsWith(`..${sep}`))
  ) {
    throw new Error("Recovery evidence must be written outside the candidate worktree.");
  }
  return evidenceDirectory;
}

function gitOutput(args) {
  const result = spawnSync("git", args, {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) throw new Error("Git candidate verification failed.");
  return result.stdout.trim();
}

function requireCleanCandidate() {
  if (gitOutput(["status", "--porcelain=v1", "--untracked-files=all"])) {
    throw new Error("Recovery rehearsal requires a clean candidate worktree.");
  }
  return gitOutput(["rev-parse", "HEAD"]);
}

function createRedactor(databaseUrl) {
  const userInfo = databaseUrl.match(/^[a-z]+:\/\/([^@]+)@/iu)?.[1] ?? "";
  return (value) => String(value ?? "")
    .replaceAll(databaseUrl, "[REDACTED_DATABASE_URL]")
    .replace(/postgres(?:ql)?:\/\/[^\s"'<>]+/giu, "[REDACTED_DATABASE_URL]")
    .replaceAll(userInfo, userInfo ? "[REDACTED_DATABASE_IDENTITY]" : "");
}

async function runMigrationCommand({ args, databaseUrl, redact }) {
  return new Promise((resolvePromise, rejectPromise) => {
    const childEnvironment = { ...process.env };
    delete childEnvironment.MIGRATION_DATABASE_URL;
    const child = spawn(process.execPath, ["scripts/db-migrate.mjs", ...args, "--connection-stdin"], {
      cwd: process.cwd(),
      env: childEnvironment,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const output = [];
    let outputBytes = 0;
    const collect = (chunk) => {
      outputBytes += chunk.byteLength;
      if (outputBytes > maximumChildOutputBytes) {
        child.kill();
        return;
      }
      output.push(Buffer.from(chunk));
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.once("error", () => rejectPromise(new Error("Recovery migration child process failed to start.")));
    child.once("close", (code) => {
      const sanitizedOutput = redact(Buffer.concat(output).toString("utf8")).trim();
      if (sanitizedOutput) console.log(sanitizedOutput);
      if (outputBytes > maximumChildOutputBytes) {
        rejectPromise(new Error("Recovery migration child output exceeded the safety limit."));
      } else if (code !== 0) {
        rejectPromise(new Error("Recovery migration child process failed; inspect the redacted output."));
      } else {
        resolvePromise();
      }
    });
    child.stdin.end(`${databaseUrl}\n`);
  });
}

function normalizeMigrationContent(content) {
  return String(content).replace(/\r\n/gu, "\n");
}

export function recoveryMigrationChecksum(content) {
  return createHash("sha256").update(normalizeMigrationContent(content)).digest("hex");
}

function requireCandidateCommit(candidateCommit) {
  if (!/^[a-f0-9]{40}$/u.test(candidateCommit)) {
    throw new Error("Recovery candidate commit must be an exact lowercase Git SHA-1.");
  }
  return candidateCommit;
}

function readCommittedMigration(candidateCommit, version) {
  requireCandidateCommit(candidateCommit);
  if (!recoveryMigrationPlan.includes(version)) {
    throw new Error("Recovery migration is outside the reviewed rehearsal plan.");
  }
  const path = `migrations/${version}.sql`;
  const result = spawnSync("git", ["show", `${candidateCommit}:${path}`], {
    cwd: process.cwd(),
    encoding: "utf8",
    maxBuffer: 16 * 1_024 * 1_024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(`Committed Recovery migration is unavailable: ${version}.`);
  }
  const content = normalizeMigrationContent(result.stdout);
  return Object.freeze({
    checksum: recoveryMigrationChecksum(content),
    content,
    file: `${version}.sql`,
    manualCutover: manualCutovers.has(version),
    name: version.replace(/^\d{3}_/u, ""),
    number: Number(version.slice(0, 3)),
    path,
    rollback: false,
    version,
  });
}

function readCommittedRecoveryPlan(candidateCommit) {
  return recoveryMigrationPlan.map((version) => readCommittedMigration(candidateCommit, version));
}

function requireExternalPlanTokenPath(path) {
  if (!path || !isAbsolute(path)) {
    throw new Error("Recovery plan token path must be absolute and outside the repository.");
  }
  const normalized = resolve(path);
  const repositoryRelative = relative(process.cwd(), normalized);
  if (
    repositoryRelative === "" ||
    (repositoryRelative !== ".." && !repositoryRelative.startsWith(`..${sep}`))
  ) {
    throw new Error("Recovery plan token path must be outside the repository.");
  }
  return normalized;
}

function consumeRecoveryPlanToken(path, expectedToken) {
  if (!/^[a-f0-9]{64}$/u.test(expectedToken)) {
    throw new Error("Expected Recovery plan token is invalid.");
  }
  const targetPath = requireExternalPlanTokenPath(path);
  const pathStat = lstatSync(targetPath);
  if (!pathStat.isFile() || pathStat.size < 64 || pathStat.size > 128) {
    throw new Error("Recovery plan token must be a small regular file.");
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
      throw new Error("Recovery plan token changed before verification.");
    }
    const buffer = Buffer.alloc(129);
    const bytesRead = readSync(descriptor, buffer, 0, buffer.length, 0);
    if (bytesRead > 128) {
      throw new Error("Recovery plan token exceeds the safety limit.");
    }
    suppliedToken = buffer.subarray(0, bytesRead).toString("utf8").trim();
  } finally {
    closeSync(descriptor);
  }
  if (
    !/^[a-f0-9]{64}$/u.test(suppliedToken) ||
    !timingSafeEqual(Buffer.from(suppliedToken, "hex"), Buffer.from(expectedToken, "hex"))
  ) {
    throw new Error("Recovery plan token does not match commit, target, ledger, or plan.");
  }
  unlinkSync(targetPath);
}

async function readRecoveryLedger(client) {
  const result = await client.query({
    query_timeout: 15_000,
    text: `
      select version, name, checksum, applied_at as "appliedAt"
      from public.novalure_schema_migrations
      order by version asc
    `,
  });
  return result.rows.map((row) => ({
    appliedAt: row.appliedAt,
    checksum: row.checksum,
    name: row.name,
    number: Number(String(row.version).slice(0, 3)),
    version: row.version,
  }));
}

function assertRecoveryCutoverLedger({ cutoverMigration, ledgerRows, previousMigrations }) {
  if (
    cutoverMigration.version !== tenantCutoverMigrationVersion ||
    cutoverMigration.path !== tenantCutoverMigrationPath
  ) {
    throw new Error("Recovery tenant cutover migration identity is invalid.");
  }
  if (ledgerRows.some((row) => String(row.version).slice(0, 3) === "061")) {
    throw new Error("Recovery tenant cutover migration is already present or collides in the ledger.");
  }
  for (const migration of previousMigrations) {
    const matches = ledgerRows.filter((row) => row.version === migration.version);
    if (matches.length !== 1 || matches[0].checksum !== migration.checksum) {
      throw new Error(
        `Recovery ledger is missing the exact committed predecessor ${migration.version}.`,
      );
    }
  }
}

export async function applyTenantCutoverMigrationTransaction({
  candidateCommit,
  client,
  migration,
  prepareCutover = async () => undefined,
}) {
  requireCandidateCommit(candidateCommit);
  if (
    !client || typeof client.query !== "function" ||
    migration?.version !== tenantCutoverMigrationVersion ||
    migration?.path !== tenantCutoverMigrationPath ||
    !/^[a-f0-9]{64}$/u.test(migration?.checksum ?? "") ||
    typeof migration?.content !== "string" ||
    typeof migration?.name !== "string" ||
    typeof prepareCutover !== "function"
  ) {
    throw new Error("Recovery tenant cutover transaction input is invalid.");
  }

  await client.query("begin");
  try {
    await client.query("set local search_path = public");
    await client.query("set local lock_timeout = '5s'");
    await client.query("set local statement_timeout = '14min'");
    await client.query("set local transaction_timeout = '15min'");
    await prepareCutover();
    await client.query({
      query_timeout: migrationClientTimeoutMs,
      text: tenantCutoverRoleProvisioningSql(candidateCommit),
    });
    await client.query({
      query_timeout: migrationClientTimeoutMs,
      text: migration.content,
    });
    await client.query(
      `
        insert into public.novalure_schema_migrations (version, name, checksum)
        values ($1, $2, $3)
      `,
      [migration.version, migration.name, migration.checksum],
    );
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  }
}

async function applyRecoveryTenantCutover({
  branchId,
  candidateCommit,
  databaseUrl,
  tokenPath,
}) {
  requireCandidateCommit(candidateCommit);
  if (assertRepositoryCommitted() !== candidateCommit) {
    throw new Error("Recovery candidate changed before the tenant cutover apply.");
  }
  assertDatabaseTarget({
    connectionMode: "direct",
    databaseUrl,
    purpose: "Recovery tenant cutover",
    target: "recovery",
  });
  const committedPlan = readCommittedRecoveryPlan(candidateCommit);
  const cutoverMigration = committedPlan.at(-1);
  const previousMigrations = committedPlan.slice(0, -1);
  const pool = new Pool({
    connectionString: databaseUrl,
    connectionTimeoutMillis: 10_000,
    idle_in_transaction_session_timeout: 960_000,
    query_timeout: migrationClientTimeoutMs,
  });
  const client = await pool.connect();
  let hasLock = false;

  try {
    const connectedTarget = await assertConnectedDatabaseTarget({
      client,
      connectionMode: "direct",
      minimumServerVersionNum: 170000,
      purpose: "Recovery tenant cutover",
      target: "recovery",
    });
    if (connectedTarget.branchId !== branchId) {
      throw new Error("Connected Recovery branch differs from the confirmed rehearsal branch.");
    }
    const lock = await client.query({
      query_timeout: 15_000,
      text: 'select pg_try_advisory_lock($1) as "acquired"',
      values: [recoveryMigrationLockKey],
    });
    if (lock.rows[0]?.acquired !== true) {
      throw new Error("Another schema migration holds the Recovery advisory lock.");
    }
    hasLock = true;

    await applyTenantCutoverMigrationTransaction({
      candidateCommit,
      client,
      migration: cutoverMigration,
      prepareCutover: async () => {
        if (assertRepositoryCommitted() !== candidateCommit) {
          throw new Error("Recovery candidate changed before role provisioning.");
        }
        const ledgerRows = await readRecoveryLedger(client);
        assertRecoveryCutoverLedger({ cutoverMigration, ledgerRows, previousMigrations });
        const expectedToken = createMigrationPlanToken({
          connectedTarget,
          headCommit: candidateCommit,
          ledgerRows,
          plan: [cutoverMigration],
        });
        consumeRecoveryPlanToken(tokenPath, expectedToken);
      },
    });
  } finally {
    if (hasLock) {
      await client.query({
        query_timeout: 15_000,
        text: "select pg_advisory_unlock($1)",
        values: [recoveryMigrationLockKey],
      }).catch(() => undefined);
    }
    client.release();
    await pool.end();
  }
}

async function migrationChecksum(version) {
  const content = await readFile(join("migrations", `${version}.sql`), "utf8");
  return recoveryMigrationChecksum(content);
}

async function removeOwnedTemporaryDirectory(directory) {
  const root = resolve(tmpdir());
  const target = resolve(directory);
  const targetRelative = relative(root, target);
  if (!targetRelative || targetRelative.startsWith(`..${sep}`) || targetRelative === "..") {
    throw new Error("Temporary Recovery directory escaped the operating-system temp root.");
  }
  await rm(target, { force: true, recursive: true });
}

async function writeEvidence({ branchId, candidateCommit, evidenceDirectory, records, startedAt, status }) {
  const generatedAt = new Date().toISOString();
  const evidence = {
    branchId,
    candidateCommit,
    environment: "RECOVERY_BRANCH_ONLY",
    finishedAt: generatedAt,
    migration061Executed: records.some(
      (record) => record.version === "061_validate_and_activate_tenant_rls_pilot"
        && record.up === "PASS",
    ),
    migration061FinalPlanPosition:
      recoveryMigrationPlan.at(-1) === "061_validate_and_activate_tenant_rls_pilot",
    migration061RoleProvisioning: records.some(
      (record) => record.version === tenantCutoverMigrationVersion
        && record.roleProvisioning === "PASS",
    ),
    migrationPlanContract: recoveryMigrationPlanContract,
    productionMutationPerformed: false,
    records,
    schemaVersion: 2,
    startedAt,
    status,
    tool: "scripts/recovery-migration-rehearsal.mjs",
  };
  const serialized = `${JSON.stringify(evidence, null, 2)}\n`;
  const digest = createHash("sha256").update(serialized).digest("hex");
  const stamp = generatedAt.replace(/[:.]/gu, "-");
  const fileName = `database-recovery-rehearsal-${stamp}.json`;
  await mkdir(evidenceDirectory, { recursive: true });
  await writeFile(join(evidenceDirectory, fileName), serialized, { encoding: "utf8", flag: "wx" });
  await writeFile(
    join(evidenceDirectory, `${fileName}.sha256`),
    `${digest}  ${fileName}\n`,
    { encoding: "utf8", flag: "wx" },
  );
  console.log(JSON.stringify({ evidenceDigest: digest, evidenceFile: fileName, status }));
}

export async function recoveryMigrationRehearsalMain(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const branchId = requireRecoveryBoundary(args, process.env);
  const evidenceDirectory = requireEvidenceDirectory(args.get("evidence-dir"));
  const candidateCommit = requireCleanCandidate();
  const databaseUrl = await readMigrationDatabaseUrlFromStdin();
  const redact = createRedactor(databaseUrl);
  const startedAt = new Date().toISOString();
  const tokenDirectory = await mkdtemp(join(tmpdir(), "novalure-recovery-rehearsal-"));
  const records = [];
  let status = "PASS";

  try {
    for (const version of recoveryMigrationPlan) {
      const record = {
        checksum: await migrationChecksum(version),
        dryRun: "NOT_RUN",
        finishedAt: null,
        roleProvisioning:
          version === tenantCutoverMigrationVersion ? "NOT_RUN" : "NOT_APPLICABLE",
        startedAt: new Date().toISOString(),
        up: "NOT_RUN",
        version,
      };
      records.push(record);
      const tokenPath = join(tokenDirectory, `${version}.plan-token`);
      const manualArgs = manualCutovers.has(version) ? ["--allow-manual-cutover"] : [];
      try {
        await runMigrationCommand({
          args: ["dry-run", `--only=${version}`, `--plan-token-file=${tokenPath}`, ...manualArgs],
          databaseUrl,
          redact,
        });
        record.dryRun = "PASS";
        if (version === tenantCutoverMigrationVersion) {
          await applyRecoveryTenantCutover({
            branchId,
            candidateCommit,
            databaseUrl,
            tokenPath,
          });
          record.roleProvisioning = "PASS";
        } else {
          await runMigrationCommand({
            args: ["up", `--only=${version}`, `--plan-token-file=${tokenPath}`, ...manualArgs],
            databaseUrl,
            redact,
          });
        }
        record.up = "PASS";
      } catch {
        record.up = record.dryRun === "PASS" ? "FAIL" : "NOT_RUN";
        if (
          version === tenantCutoverMigrationVersion &&
          record.dryRun === "PASS" &&
          record.roleProvisioning !== "PASS"
        ) {
          record.roleProvisioning = "FAIL";
        }
        status = "FAIL";
        throw new Error(`Recovery migration rehearsal stopped at ${version}.`);
      } finally {
        record.finishedAt = new Date().toISOString();
        await unlink(tokenPath).catch(() => undefined);
      }
    }
  } catch (error) {
    await writeEvidence({
      branchId,
      candidateCommit,
      evidenceDirectory,
      records,
      startedAt,
      status,
    });
    throw error;
  } finally {
    await removeOwnedTemporaryDirectory(tokenDirectory);
  }

  await writeEvidence({
    branchId,
    candidateCommit,
    evidenceDirectory,
    records,
    startedAt,
    status,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await recoveryMigrationRehearsalMain();
  } catch {
    console.error(JSON.stringify({ errorCode: "RECOVERY_REHEARSAL_FAILED", ok: false }));
    process.exitCode = 1;
  }
}
