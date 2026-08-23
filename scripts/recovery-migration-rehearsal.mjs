#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import process from "node:process";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { readMigrationDatabaseUrlFromStdin } from "./db-migrate.mjs";

const maximumChildOutputBytes = 2 * 1_024 * 1_024;
const manualCutovers = new Set([
  "057_bot_webhook_legacy_index_cutover",
  "060_tenant_rls_pilot_prepare",
  "068_qa_batch_reset_safety",
  "074_validate_launch_tenant_relation_guards",
  "078_company_profile_approval_integrity",
  "079_public_funnel_visit_role_boundary",
]);

export const recoveryMigrationPlan = Object.freeze([
  "057_bot_webhook_legacy_index_cutover",
  "060_tenant_rls_pilot_prepare",
  "068_qa_batch_reset_safety",
  "069_property_unit_idempotency",
  "070_funnel_submission_idempotency_recovery",
  "071_forms_owner_tenant_guard",
  "072_form_submission_atomicity",
  "073_launch_tenant_relation_guards",
  "074_validate_launch_tenant_relation_guards",
  "075_public_funnel_visit_truth",
  "076_bot_webhook_durable_processing",
  "077_schema_ledger_runtime_projection",
  "078_company_profile_approval_integrity",
  "079_public_funnel_visit_role_boundary",
]);

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

async function migrationChecksum(version) {
  const content = await readFile(join("migrations", `${version}.sql`));
  return createHash("sha256").update(content).digest("hex");
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
    migration061Executed: false,
    productionMutationPerformed: false,
    records,
    schemaVersion: 1,
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
        await runMigrationCommand({
          args: ["up", `--only=${version}`, `--plan-token-file=${tokenPath}`, ...manualArgs],
          databaseUrl,
          redact,
        });
        record.up = "PASS";
      } catch {
        record.up = record.dryRun === "PASS" ? "FAIL" : "NOT_RUN";
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
