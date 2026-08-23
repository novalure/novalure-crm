#!/usr/bin/env node

import path from "node:path";
import process from "node:process";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import {
  createVercelPrivateBlobInspector,
  fingerprint,
  PreviewBlobLifecycleError,
  resolvePreviewBlobLifecycleConfig,
  runPreviewBlobLifecycle,
  validateShareUrl,
  writePreviewBlobLifecycleEvidence,
} from "./lib/preview-blob-lifecycle.mjs";
import { loadVerifiedLegacyBlobMigrationProof } from "./lib/legacy-blob-cutover-evidence.mjs";

function usage() {
  console.log([
    "Private Preview Blob lifecycle runner",
    "",
    "  --validate-config    Validate the exact Preview target without network access.",
    "  --execute            Upload, read, list and delete one private marked QA asset.",
    "  --share-url-stdin    Read one same-origin Vercel share URL from standard input.",
    "",
    "Credentials and external proof paths belong in a protected local env file. Share URLs belong only on standard input.",
  ].join("\n"));
}

function parseArgs(argv) {
  const allowed = new Set(["--execute", "--help", "--share-url-stdin", "--validate-config", "-h"]);
  for (const argument of argv) {
    if (!allowed.has(argument)) throw new PreviewBlobLifecycleError("ARGUMENT_REJECTED", "An unsupported argument was rejected.");
  }
  if (argv.includes("--execute") && argv.includes("--validate-config")) {
    throw new PreviewBlobLifecycleError("MODE_INVALID", "Choose execute or validate-config, not both.");
  }
  if (argv.includes("--help") || argv.includes("-h")) return { mode: "help", shareUrlStdin: false };
  return {
    mode: argv.includes("--execute") ? "execute" : "validate-config",
    shareUrlStdin: argv.includes("--share-url-stdin"),
  };
}

async function readSingleSecretLine() {
  const lines = createInterface({ crlfDelay: Number.POSITIVE_INFINITY, input: process.stdin });
  let value = "";
  let count = 0;
  for await (const line of lines) {
    count += 1;
    if (count > 1 || line.length > 2_048) {
      lines.close();
      throw new PreviewBlobLifecycleError("STDIN_SECRET_REJECTED", "Standard input must contain exactly one bounded line.");
    }
    value = line;
  }
  return value.trim();
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const args = parseArgs(argv);
  if (args.mode === "help") {
    usage();
    return;
  }
  const config = resolvePreviewBlobLifecycleConfig({ env, execute: args.mode === "execute" });
  console.log(
    `Preview Blob target valid: origin=${fingerprint("preview-blob-origin:v1", config.baseOrigin)}; ` +
    `branch=${fingerprint("preview-blob-branch:v1", config.expectedGitBranch)}; sha=${config.expectedGitSha}.`,
  );
  if (args.mode === "validate-config") return;

  const proofInputs = {
    expectedProofSha256: env.NOVALURE_LEGACY_BLOB_PROOF_SHA256,
    expectedTrustAnchorSha256: env.NOVALURE_RELEASE_APPROVAL_TRUST_ANCHOR_SHA256,
    proofPath: env.NOVALURE_LEGACY_BLOB_PROOF_PATH,
    trustAnchorPath: env.NOVALURE_RELEASE_APPROVAL_TRUST_ANCHOR_PATH,
  };
  if (Object.values(proofInputs).some((value) => typeof value !== "string" || value.trim().length === 0)) {
    throw new PreviewBlobLifecycleError(
      "LEGACY_MIGRATION_PROOF_REQUIRED",
      "The externally signed, hashed Legacy Blob migration proof and trust anchor are required before lifecycle execution.",
    );
  }
  let legacyMigrationProof;
  try {
    legacyMigrationProof = await loadVerifiedLegacyBlobMigrationProof({
      ...proofInputs,
      repositoryRoot: process.cwd(),
      runtime: {
        candidateCommit: config.expectedGitSha,
        databaseBranchId: config.expectedDatabaseBranchId,
        deploymentHost: config.expectedHost,
        deploymentId: config.deploymentId,
        gitBranch: config.expectedGitBranch,
        productionMutationPerformed: false,
      },
      targetStoreFingerprint: config.independentBlob?.storeFingerprint,
    });
  } catch (error) {
    throw new PreviewBlobLifecycleError(
      error instanceof Error && typeof error.code === "string" ? error.code : "LEGACY_MIGRATION_PROOF_INVALID",
      "The external Legacy Blob migration proof failed closed.",
      { cause: error },
    );
  }

  const shareInput = args.shareUrlStdin ? await readSingleSecretLine() : "";
  const shareUrl = validateShareUrl(shareInput, config.baseOrigin);
  const blobInspector = await createVercelPrivateBlobInspector(config);
  const result = await runPreviewBlobLifecycle(config, { blobInspector, legacyMigrationProof, shareUrl });
  const written = await writePreviewBlobLifecycleEvidence(config, result.evidence);
  console.log(`Preview Blob evidence written: ${written.directory}`);
  console.log(`Preview Blob evidence digest: sha256:${written.digest}`);
  console.log(`Preview Blob lifecycle status: ${result.evidence.status}.`);
  if (result.error) throw result.error;
  if (result.evidence.status === "BLOCKED") {
    throw new PreviewBlobLifecycleError(
      "INDEPENDENT_STORE_PROOF_UNPROVEN",
      "Independent private Preview Blob list/head proof is unavailable.",
    );
  }
}

const directEntrypoint = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
  : false;

if (directEntrypoint) {
  main().catch((error) => {
    const code = error instanceof PreviewBlobLifecycleError ? error.code : "UNEXPECTED_FAILURE";
    console.error(`Preview Blob lifecycle failed: ${code}.`);
    process.exitCode = 1;
  });
}
