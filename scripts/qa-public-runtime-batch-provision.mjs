#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { neon } from "@neondatabase/serverless";

const confirmation = "PROVISION_PUBLIC_RUNTIME_PREVIEW_BATCH";
const exactKeys = Object.freeze([
  "actorUserId",
  "batchMarker",
  "confirmation",
  "databaseUrl",
  "expectedDeploymentId",
  "expectedGitRef",
  "expectedGitSha",
  "expectedNeonBranchId",
  "expectedNeonProjectId",
  "productionDatabaseHost",
  "schemaVersion",
  "workspaceId",
]);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function invariant(condition, code) {
  if (!condition) throw new Error(code);
}

async function readBoundedStdin(maximumBytes = 16 * 1024) {
  let source = "";
  for await (const chunk of process.stdin) {
    source += chunk;
    invariant(Buffer.byteLength(source, "utf8") <= maximumBytes, "PUBLIC_BATCH_INPUT_TOO_LARGE");
  }
  return source;
}

export function parsePublicRuntimeBatchProvisionInput(source) {
  let value;
  try {
    value = JSON.parse(source);
  } catch {
    throw new Error("PUBLIC_BATCH_INPUT_INVALID");
  }
  invariant(value && typeof value === "object" && !Array.isArray(value), "PUBLIC_BATCH_INPUT_INVALID");
  const actual = Object.keys(value).sort();
  invariant(
    actual.length === exactKeys.length && actual.every((key, index) => key === [...exactKeys].sort()[index]),
    "PUBLIC_BATCH_INPUT_KEYS_INVALID",
  );
  const normalized = Object.fromEntries(exactKeys.map((key) => [key, typeof value[key] === "string" ? value[key].trim() : value[key]]));
  invariant(normalized.schemaVersion === 1 && normalized.confirmation === confirmation, "PUBLIC_BATCH_CONFIRMATION_INVALID");
  invariant(uuidPattern.test(normalized.actorUserId) && uuidPattern.test(normalized.workspaceId), "PUBLIC_BATCH_SCOPE_INVALID");
  invariant(/^[a-f0-9]{40}$/u.test(normalized.expectedGitSha), "PUBLIC_BATCH_CANDIDATE_INVALID");
  invariant(/^codex\/[A-Za-z0-9._/-]{1,220}$/u.test(normalized.expectedGitRef), "PUBLIC_BATCH_CANDIDATE_INVALID");
  invariant(/^dpl_[A-Za-z0-9]{20,80}$/u.test(normalized.expectedDeploymentId), "PUBLIC_BATCH_DEPLOYMENT_INVALID");
  invariant(/^br-[A-Za-z0-9-]{8,128}$/u.test(normalized.expectedNeonBranchId), "PUBLIC_BATCH_DATABASE_TARGET_INVALID");
  invariant(/^[-A-Za-z0-9]{8,80}$/u.test(normalized.expectedNeonProjectId), "PUBLIC_BATCH_DATABASE_TARGET_INVALID");
  invariant(
    /^QA-TEST-[0-9]{8}-[0-9]{4}-[A-Za-z0-9][A-Za-z0-9_-]{5,31}$/u.test(normalized.batchMarker),
    "PUBLIC_BATCH_MARKER_INVALID",
  );
  invariant(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/u.test(normalized.productionDatabaseHost), "PUBLIC_BATCH_PRODUCTION_HOST_INVALID");
  let database;
  try {
    database = new URL(normalized.databaseUrl);
  } catch {
    throw new Error("PUBLIC_BATCH_DATABASE_URL_INVALID");
  }
  invariant(
    new Set(["postgres:", "postgresql:"]).has(database.protocol)
      && database.username === "novalure_app"
      && database.password
      && database.hostname.endsWith(".neon.tech")
      && database.hostname.toLowerCase() !== normalized.productionDatabaseHost.toLowerCase()
      && database.pathname === "/neondb"
      && database.searchParams.get("sslmode") === "require",
    "PUBLIC_BATCH_DATABASE_URL_INVALID",
  );
  return Object.freeze({ ...normalized, databaseUrl: database.toString() });
}

export function requireLocalCandidate(
  input,
  { cwd = process.cwd(), spawn = spawnSync } = {},
) {
  for (const [args, expected] of [
    [["rev-parse", "HEAD"], input.expectedGitSha],
    [["branch", "--show-current"], input.expectedGitRef],
  ]) {
    const result = spawn("git", args, { cwd, encoding: "utf8", windowsHide: true });
    invariant(result.status === 0 && result.stdout.trim() === expected, "PUBLIC_BATCH_LOCAL_CANDIDATE_MISMATCH");
  }
  const dirty = spawn("git", ["status", "--short"], { cwd, encoding: "utf8", windowsHide: true });
  invariant(dirty.status === 0 && !dirty.stdout.trim(), "PUBLIC_BATCH_LOCAL_CANDIDATE_MISMATCH");
}

export async function provisionPublicRuntimeBatch(
  input,
  { batchIdFactory = randomUUID, sqlFactory = neon } = {},
) {
  const batchId = batchIdFactory();
  invariant(uuidPattern.test(batchId), "PUBLIC_BATCH_ID_INVALID");
  const sql = sqlFactory(input.databaseUrl);
  let results;
  try {
    results = await sql.transaction((transaction) => [
      transaction`
        select
          set_config('app.tenant_id', ${input.workspaceId}, true) as "tenantId",
          set_config('app.actor_id', ${input.actorUserId}, true) as "actorId"
      `,
      transaction`
        insert into qa_batches (
          id,
          workspace_id,
          batch_marker,
          created_by_user_id,
          metadata
        )
        select
          ${batchId}::uuid,
          workspace.id,
          ${input.batchMarker},
          actor.id,
          ${JSON.stringify({
            candidate: input.expectedGitSha,
            deploymentId: input.expectedDeploymentId,
            purpose: "public-runtime-preview",
            version: 1,
          })}::jsonb
        from workspaces workspace
        inner join workspace_users actor
          on actor.workspace_id = workspace.id
         and actor.id = ${input.actorUserId}::uuid
         and actor.status = 'active'
        where workspace.id = ${input.workspaceId}::uuid
          and workspace.is_qa = true
          and current_setting('neon.project_id', true) = ${input.expectedNeonProjectId}
          and current_setting('neon.branch_id', true) = ${input.expectedNeonBranchId}
          and current_database() = 'neondb'
          and current_user = 'novalure_app'
          and not exists (
            select 1
            from qa_batches existing
            where existing.workspace_id = workspace.id
              and existing.metadata->>'purpose' = 'public-runtime-preview'
              and existing.metadata->>'deploymentId' = ${input.expectedDeploymentId}
              and not exists (
                select 1 from qa_reset_audit_events audit
                where audit.workspace_id = existing.workspace_id
                  and audit.batch_id = existing.id
                  and audit.outcome = 'executed'
              )
          )
        returning id, batch_marker as "batchMarker", workspace_id as "workspaceId"
      `,
    ], { isolationLevel: "Serializable" });
  } catch (error) {
    throw new Error("PUBLIC_BATCH_PROVISION_FAILED", { cause: error });
  }
  const row = results?.[1]?.[0];
  invariant(
    row?.id === batchId && row.batchMarker === input.batchMarker && row.workspaceId === input.workspaceId,
    "PUBLIC_BATCH_NOT_FRESH_OR_TARGET_BOUND",
  );
  return Object.freeze({
    batchId,
    batchMarker: input.batchMarker,
    deploymentId: input.expectedDeploymentId,
    workspaceId: input.workspaceId,
  });
}

export async function main(argv = process.argv.slice(2)) {
  invariant(argv.length === 2 && argv[0] === "--execute" && argv[1] === "--input-stdin", "PUBLIC_BATCH_ARGUMENT_INVALID");
  const input = parsePublicRuntimeBatchProvisionInput(await readBoundedStdin());
  requireLocalCandidate(input);
  const result = await provisionPublicRuntimeBatch(input);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`[qa-public-runtime-batch] status=FAIL code=${error instanceof Error ? error.message : "UNEXPECTED_FAILURE"}\n`);
    process.exitCode = 1;
  });
}
