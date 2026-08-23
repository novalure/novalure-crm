#!/usr/bin/env node

import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { validateAccessibilityManualAcceptanceReceipt } from "./lib/accessibility-manual-acceptance-receipt.mjs";
import { validateCompanyProfileApprovalReceipt } from "./lib/company-profile-approval-receipt.mjs";
import { loadExternalGateTrustContext } from "./lib/external-gate-receipts.mjs";
import { validateOperationalGateReceipt } from "./lib/operational-gate-receipts.mjs";
import {
  validateProtectedWorkflowProvenanceReceipt,
  verifyGitHubArtifactAttestation,
} from "./lib/protected-workflow-provenance-receipt.mjs";

const allowedArguments = new Set([
  "--artifact",
  "--artifact-manifest",
  "--attestation-bundle",
  "--automated-evidence",
  "--expected-artifact-digest",
  "--expected-sigstore-trusted-root-sha256",
  "--expected-source",
  "--expected-trust-anchor-sha256",
  "--expected-workflow-ref",
  "--expected-workflow-sha",
  "--github-cli",
  "--individual-evidence",
  "--kind",
  "--matrix",
  "--profile-snapshot",
  "--receipt",
  "--runtime",
  "--sigstore-trusted-root",
  "--trust-anchor",
]);

const maximumInputBytes = 16 * 1024 * 1024;

function fail(code) {
  throw new Error(code);
}

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!allowedArguments.has(name) || typeof value !== "string" || value.startsWith("--")) {
      fail("EXTERNAL_GATE_VERIFY_ARGUMENT_INVALID");
    }
    if (values.has(name)) fail("EXTERNAL_GATE_VERIFY_ARGUMENT_DUPLICATED");
    values.set(name, value);
  }
  return values;
}

function required(args, name) {
  const value = args.get(name);
  if (!value) fail(`EXTERNAL_GATE_VERIFY_${name.slice(2).replaceAll("-", "_").toUpperCase()}_REQUIRED`);
  return value;
}

async function readBoundedJson(filePath, code) {
  const absolutePath = path.resolve(filePath);
  const state = await lstat(absolutePath);
  if (
    !state.isFile()
    || state.isSymbolicLink()
    || state.nlink !== 1
    || state.size <= 0
    || state.size > maximumInputBytes
  ) fail(`${code}_NOT_BOUNDED_REGULAR_FILE`);
  try {
    return JSON.parse(await readFile(absolutePath, "utf8"));
  } catch {
    fail(`${code}_JSON_INVALID`);
  }
}

export async function externalGateReceiptVerifyMain(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const kind = required(args, "--kind");
  const runtime = await readBoundedJson(required(args, "--runtime"), "EXTERNAL_GATE_RUNTIME");
  const receipt = await readBoundedJson(required(args, "--receipt"), "EXTERNAL_GATE_RECEIPT");
  const trustContext = await loadExternalGateTrustContext({
    anchorPath: path.resolve(required(args, "--trust-anchor")),
    expectedSha256: required(args, "--expected-trust-anchor-sha256"),
    repositoryRoot: process.cwd(),
    requiredRoles: [receipt.role],
  });

  let result;
  if (kind === "accessibility") {
    result = validateAccessibilityManualAcceptanceReceipt({
      automatedEvidence: await readBoundedJson(
        required(args, "--automated-evidence"),
        "EXTERNAL_GATE_AUTOMATED_EVIDENCE",
      ),
      individualEvidence: await readBoundedJson(
        required(args, "--individual-evidence"),
        "EXTERNAL_GATE_INDIVIDUAL_EVIDENCE",
      ),
      matrix: await readBoundedJson(required(args, "--matrix"), "EXTERNAL_GATE_MATRIX"),
      receipt,
      runtime,
      trustContext,
    });
  } else if (kind === "protected-workflow") {
    const artifactManifest = await readBoundedJson(
      required(args, "--artifact-manifest"),
      "EXTERNAL_GATE_ARTIFACT_MANIFEST",
    );
    const expectedArtifactDigest = required(args, "--expected-artifact-digest");
    const expectedWorkflowRef = required(args, "--expected-workflow-ref");
    const expectedWorkflowSha = required(args, "--expected-workflow-sha");
    const verifiedAttestation = verifyGitHubArtifactAttestation({
      artifactManifest,
      artifactPath: path.resolve(required(args, "--artifact")),
      attestationBundlePath: path.resolve(required(args, "--attestation-bundle")),
      expectedSigstoreTrustedRootSha256: required(
        args,
        "--expected-sigstore-trusted-root-sha256",
      ),
      expectedWorkflowRef,
      expectedWorkflowSha,
      githubCliPath: path.resolve(required(args, "--github-cli")),
      sigstoreTrustedRootPath: path.resolve(required(args, "--sigstore-trusted-root")),
    });
    result = validateProtectedWorkflowProvenanceReceipt({
      artifactManifest,
      expectedArtifactDigest,
      expectedRuntime: runtime,
      expectedWorkflowRef,
      expectedWorkflowSha,
      receipt,
      trustContext,
      verifiedAttestation,
    });
  } else if (["observability", "runtime-logs", "cleanup", "supply-chain"].includes(kind)) {
    result = validateOperationalGateReceipt({
      expectedRuntime: runtime,
      expectedSource: await readBoundedJson(
        required(args, "--expected-source"),
        "EXTERNAL_GATE_EXPECTED_SOURCE",
      ),
      gateId: kind,
      receipt,
      trustContext,
    });
  } else if (kind === "company-profile") {
    result = validateCompanyProfileApprovalReceipt({
      profileSnapshot: await readBoundedJson(
        required(args, "--profile-snapshot"),
        "EXTERNAL_GATE_PROFILE_SNAPSHOT",
      ),
      receipt,
      runtime,
      trustContext,
    });
  } else {
    fail("EXTERNAL_GATE_VERIFY_KIND_INVALID");
  }

  console.log(JSON.stringify({ kind, ok: true, result }));
  return result;
}

const directEntrypoint = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
  : false;

if (directEntrypoint) {
  externalGateReceiptVerifyMain().catch((error) => {
    console.error(JSON.stringify({
      errorCode: error instanceof Error ? error.message : "EXTERNAL_GATE_VERIFY_FAILED",
      ok: false,
    }));
    process.exitCode = 1;
  });
}
