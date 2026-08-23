#!/usr/bin/env node

import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { Pool } from "@neondatabase/serverless";

import {
  createPreviewDatabaseCutoverAdapter,
  createVercelBlobCutoverAdapter,
} from "./legacy-blob-cutover.mjs";
import {
  collectLegacyBlobCutoverProof,
  LegacyBlobCutoverEvidenceError,
  loadBlobMigrationTrustContext,
  loadExternalBlobMigrationReceipt,
  loadExternalLegacyBlobDraft,
  readLegacyBlobCutoverJournalFile,
  writeExternalLegacyBlobProof,
} from "./lib/legacy-blob-cutover-evidence.mjs";
import {
  resolvePreviewCutoverConfig,
  resolveSafeJournalPath,
} from "./lib/legacy-blob-cutover.mjs";
import { validateExternalGateRuntimeBinding } from "./lib/external-gate-receipts.mjs";

const queryTimeoutMs = 15_000;

function clean(value) {
  return typeof value === "string" ? value.trim().replace(/^['"]|['"]$/gu, "") : "";
}

function required(env, key) {
  const value = clean(env?.[key]);
  if (!value) throw new LegacyBlobCutoverEvidenceError("CONFIGURATION_MISSING", `${key} is required.`);
  return value;
}

function parseMode(argv) {
  if (argv.length !== 1 || !["--draft", "--final"].includes(argv[0])) {
    throw new LegacyBlobCutoverEvidenceError(
      "ARGUMENT_INVALID",
      "Choose exactly one of --draft or --final; paths and digests are accepted only through protected environment values.",
    );
  }
  return argv[0] === "--draft" ? "draft" : "final";
}

export function resolveLegacyBlobEvidenceRuntime(env = process.env) {
  if (required(env, "VERCEL_ENV").toLowerCase() !== "preview") {
    throw new LegacyBlobCutoverEvidenceError("PREVIEW_TARGET_REQUIRED", "Blob evidence collection is Preview-only.");
  }
  const candidateCommit = required(env, "NOVALURE_QA_EXPECTED_GIT_SHA").toLowerCase();
  const activeCommit = (clean(env.VERCEL_GIT_COMMIT_SHA) || required(env, "NOVALURE_QA_ACTIVE_GIT_SHA")).toLowerCase();
  if (!/^[a-f0-9]{40}$/u.test(candidateCommit) || activeCommit !== candidateCommit) {
    throw new LegacyBlobCutoverEvidenceError("PREVIEW_COMMIT_MISMATCH", "The active Preview commit is not the exact candidate.");
  }
  const gitBranch = required(env, "NOVALURE_QA_EXPECTED_GIT_BRANCH");
  const activeBranch = clean(env.VERCEL_GIT_COMMIT_REF) || required(env, "NOVALURE_QA_ACTIVE_GIT_BRANCH");
  if (!gitBranch.startsWith("codex/") || activeBranch !== gitBranch) {
    throw new LegacyBlobCutoverEvidenceError("PREVIEW_BRANCH_MISMATCH", "The active Preview branch is not the exact QA branch.");
  }
  const deploymentHost = required(env, "NOVALURE_QA_EXPECTED_HOST").toLowerCase();
  if (!deploymentHost.endsWith(".vercel.app")) {
    throw new LegacyBlobCutoverEvidenceError("PREVIEW_HOST_REQUIRED", "The evidence target must be an exact Vercel Preview host.");
  }
  let productionHost;
  try {
    productionHost = new URL(required(env, "NOVALURE_PRODUCTION_ORIGIN")).hostname.toLowerCase();
  } catch (error) {
    throw new LegacyBlobCutoverEvidenceError("PRODUCTION_ORIGIN_INVALID", "The Production origin is invalid.", { cause: error });
  }
  if (productionHost === deploymentHost) {
    throw new LegacyBlobCutoverEvidenceError("PRODUCTION_HOST_REJECTED", "The evidence target matches Production.");
  }
  return Object.freeze(validateExternalGateRuntimeBinding({
    candidateCommit,
    databaseBranchId: required(env, "NOVALURE_QA_BRANCH_ID"),
    deploymentHost,
    deploymentId: required(env, "NOVALURE_QA_DEPLOYMENT_ID"),
    gitBranch,
    productionMutationPerformed: false,
  }));
}

export async function legacyBlobCutoverEvidenceMain(
  argv = process.argv.slice(2),
  env = process.env,
  { clock = () => new Date(), projectRoot = process.cwd() } = {},
) {
  const mode = parseMode(argv);
  const runtime = resolveLegacyBlobEvidenceRuntime(env);
  const cutoverConfig = resolvePreviewCutoverConfig({
    args: {
      execute: false,
      mode: "finalize",
      runId: required(env, "NOVALURE_LEGACY_BLOB_RUN_ID"),
    },
    env,
  });
  if (cutoverConfig.destinationStoreFingerprint !== required(env, "NOVALURE_LEGACY_BLOB_TARGET_STORE_FINGERPRINT")) {
    throw new LegacyBlobCutoverEvidenceError(
      "TARGET_STORE_FINGERPRINT_MISMATCH",
      "The out-of-band private Preview store fingerprint does not match the cutover target.",
    );
  }
  const journalPath = resolveSafeJournalPath({
    projectRoot,
    requestedPath: clean(env.NOVALURE_LEGACY_BLOB_JOURNAL_PATH),
    runId: cutoverConfig.runId,
  });
  const journalRoot = path.resolve(projectRoot, "artifacts", "qa", "legacy-blob-cutover");
  const journal = await readLegacyBlobCutoverJournalFile({ journalPath, journalRoot, repositoryRoot: projectRoot });

  let draft = null;
  let migrationReceipt = null;
  let trustContext = null;
  let observedAt = null;
  if (mode === "final") {
    [draft, migrationReceipt, trustContext] = await Promise.all([
      loadExternalLegacyBlobDraft({
        draftPath: required(env, "NOVALURE_LEGACY_BLOB_DRAFT_PATH"),
        expectedDraftSha256: required(env, "NOVALURE_LEGACY_BLOB_DRAFT_SHA256"),
        repositoryRoot: projectRoot,
      }),
      loadExternalBlobMigrationReceipt({
        expectedReceiptSha256: required(env, "NOVALURE_LEGACY_BLOB_RECEIPT_SHA256"),
        receiptPath: required(env, "NOVALURE_LEGACY_BLOB_RECEIPT_PATH"),
        repositoryRoot: projectRoot,
      }),
      loadBlobMigrationTrustContext({
        expectedTrustAnchorSha256: required(env, "NOVALURE_RELEASE_APPROVAL_TRUST_ANCHOR_SHA256"),
        repositoryRoot: projectRoot,
        trustAnchorPath: required(env, "NOVALURE_RELEASE_APPROVAL_TRUST_ANCHOR_PATH"),
      }),
    ]);
    observedAt = draft.evidence.observedAt;
  }

  const pool = new Pool({
    allowExitOnIdle: true,
    connectionString: cutoverConfig.databaseUrl,
    connectionTimeoutMillis: 10_000,
    idle_in_transaction_session_timeout: 60_000,
    max: 1,
    query_timeout: queryTimeoutMs,
  });
  const client = await pool.connect();
  try {
    const proof = await collectLegacyBlobCutoverProof({
      blob: createVercelBlobCutoverAdapter(cutoverConfig),
      clock,
      cutoverConfig,
      database: createPreviewDatabaseCutoverAdapter({ client, config: cutoverConfig, env }),
      expectedDraftEvidenceDigest: draft?.evidenceDigest ?? null,
      journal,
      migrationReceipt,
      observedAt,
      runtime,
      trustContext,
    });
    const output = await writeExternalLegacyBlobProof({
      outputPath: required(env, "NOVALURE_LEGACY_BLOB_EVIDENCE_OUTPUT_PATH"),
      proof,
      repositoryRoot: projectRoot,
    });
    const result = Object.freeze({
      digest: output.digest,
      mode,
      objectCount: proof.migratedObjectCount,
      ok: proof.status === "VERIFIED",
      outputPath: output.path,
      status: proof.status,
    });
    console.log(JSON.stringify(result));
    if (proof.status !== "VERIFIED") process.exitCode = 2;
    return result;
  } finally {
    client.release();
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await legacyBlobCutoverEvidenceMain();
  } catch (error) {
    console.error(JSON.stringify({
      errorCode: error instanceof LegacyBlobCutoverEvidenceError ? error.code : "UNEXPECTED_FAILURE",
      ok: false,
    }));
    process.exitCode = 1;
  }
}
