import { lstat, open, realpath, unlink } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertExternalGateRoleIndependence,
  canonicalJson,
  loadExternalGateTrustContext,
  sha256,
} from "./lib/external-gate-receipts.mjs";
import {
  launchActivationReceiptRole,
  verifyLaunchActivationReceipt,
} from "./lib/launch-activation-receipt.mjs";
import { encodeLaunchActivationFlagsEnvelope } from "./lib/launch-activation-flags-envelope.mjs";
import {
  loadCanonicalProductionCutoverDocument,
  productionCutoverReceiptRoles,
  verifyProductionCutoverEvidence,
} from "./lib/production-cutover-receipt.mjs";

const maximumReceiptBytes = 64 * 1024;
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function fail(code) {
  throw new Error(code);
}

function parseArguments(argv) {
  const allowed = new Set([
    "activation-expires-at",
    "activation-generation",
    "activation-not-before",
    "candidate",
    "deployment-host",
    "deployment-id",
    "document-bundle-sha256",
    "expected-trust-anchor-sha256",
    "final-attestation-sha256",
    "flags-environment",
    "flags-output",
    "flags-revision-floor",
    "production-deployment-id",
    "production-deployment-host",
    "production-cutover",
    "production-host",
    "project-id",
    "receipt",
    "release-gate-matrix-sha256",
    "rollback-deployment-host",
    "rollback-deployment-id",
    "trust-anchor",
  ]);
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const option = argv[index];
    const value = argv[index + 1];
    if (!option?.startsWith("--") || !value || value.startsWith("--")) {
      fail("LAUNCH_ACTIVATION_ARGUMENT_PAIR_INVALID");
    }
    const key = option.slice(2);
    if (!allowed.has(key) || Object.hasOwn(values, key)) {
      fail("LAUNCH_ACTIVATION_ARGUMENT_INVALID");
    }
    values[key] = value;
  }
  if (Object.keys(values).length !== allowed.size) {
    fail("LAUNCH_ACTIVATION_ARGUMENT_REQUIRED");
  }
  return values;
}

async function loadCanonicalReceipt(receiptPath) {
  if (!isAbsolute(receiptPath)) fail("LAUNCH_ACTIVATION_RECEIPT_ABSOLUTE_PATH_REQUIRED");
  const resolved = resolve(receiptPath);
  const state = await lstat(resolved);
  if (
    !state.isFile()
    || state.isSymbolicLink()
    || state.nlink !== 1
    || state.size <= 0
    || state.size > maximumReceiptBytes
  ) {
    fail("LAUNCH_ACTIVATION_RECEIPT_NOT_BOUNDED_REGULAR_FILE");
  }
  const real = await realpath(resolved);
  const normalized = (value) => process.platform === "win32" ? value.toLowerCase() : value;
  if (normalized(real) !== normalized(resolved)) {
    fail("LAUNCH_ACTIVATION_RECEIPT_NOT_BOUNDED_REGULAR_FILE");
  }
  let handle;
  let source;
  try {
    handle = await open(resolved, "r");
    const opened = await handle.stat();
    if (
      !opened.isFile()
      || opened.nlink !== 1
      || opened.dev !== state.dev
      || opened.ino !== state.ino
      || opened.size !== state.size
    ) fail("LAUNCH_ACTIVATION_RECEIPT_CHANGED_DURING_OPEN");
    source = await handle.readFile();
    const after = await handle.stat();
    if (
      after.dev !== opened.dev
      || after.ino !== opened.ino
      || after.size !== opened.size
      || after.nlink !== opened.nlink
      || after.mtimeMs !== opened.mtimeMs
      || source.length !== opened.size
    ) fail("LAUNCH_ACTIVATION_RECEIPT_CHANGED_DURING_READ");
  } finally {
    await handle?.close().catch(() => undefined);
  }
  let receipt;
  try {
    receipt = JSON.parse(source.toString("utf8"));
  } catch {
    fail("LAUNCH_ACTIVATION_RECEIPT_JSON_INVALID");
  }
  if (source.toString("utf8") !== canonicalJson(receipt)) {
    fail("LAUNCH_ACTIVATION_RECEIPT_NOT_CANONICAL");
  }
  return receipt;
}

function normalizedPath(value) {
  return process.platform === "win32" ? value.toLowerCase() : value;
}

function isPathInside(parent, candidate) {
  const pathFromParent = relative(parent, candidate);
  return pathFromParent === ""
    || (!pathFromParent.startsWith("..") && !isAbsolute(pathFromParent));
}

async function writeExclusiveFlagsActivationFile(outputPath, flagsActivation) {
  if (!isAbsolute(outputPath)) fail("LAUNCH_ACTIVATION_FLAGS_OUTPUT_ABSOLUTE_PATH_REQUIRED");
  const resolved = resolve(outputPath);
  if (isPathInside(repositoryRoot, resolved)) {
    fail("LAUNCH_ACTIVATION_FLAGS_OUTPUT_MUST_BE_OUTSIDE_REPOSITORY");
  }
  const resolvedParent = dirname(resolved);
  const realParent = await realpath(resolvedParent);
  if (normalizedPath(realParent) !== normalizedPath(resolvedParent)) {
    fail("LAUNCH_ACTIVATION_FLAGS_OUTPUT_PARENT_NOT_REAL");
  }
  try {
    await lstat(resolved);
    fail("LAUNCH_ACTIVATION_FLAGS_OUTPUT_ALREADY_EXISTS");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }

  const source = Buffer.from(canonicalJson(flagsActivation), "utf8");
  let created = false;
  let handle;
  try {
    handle = await open(resolved, "wx", 0o600);
    created = true;
    const opened = await handle.stat();
    if (
      !opened.isFile()
      || opened.nlink !== 1
      || opened.size !== 0
      || (opened.mode & 0o077) !== 0
    ) fail("LAUNCH_ACTIVATION_FLAGS_OUTPUT_NOT_PRIVATE_REGULAR_FILE");
    await handle.writeFile(source);
    await handle.sync();
    const written = await handle.stat();
    if (
      written.dev !== opened.dev
      || written.ino !== opened.ino
      || written.nlink !== 1
      || written.size !== source.length
      || (written.mode & 0o077) !== 0
    ) fail("LAUNCH_ACTIVATION_FLAGS_OUTPUT_CHANGED_DURING_WRITE");
  } catch (error) {
    await handle?.close().catch(() => undefined);
    handle = undefined;
    if (created) await unlink(resolved).catch(() => undefined);
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
  return Object.freeze({
    outputSha256: sha256(source),
    outputBytes: source.length,
  });
}

const argumentsMap = parseArguments(process.argv.slice(2));
if (process.platform === "win32") {
  fail("LAUNCH_ACTIVATION_FLAGS_OUTPUT_WINDOWS_PRIVATE_ACL_UNVERIFIED");
}
const trustContext = await loadExternalGateTrustContext({
  anchorPath: argumentsMap["trust-anchor"],
  expectedSha256: argumentsMap["expected-trust-anchor-sha256"],
  repositoryRoot,
  requiredRoles: [
    "launch-activation-attestor",
    ...Object.values(productionCutoverReceiptRoles),
  ],
});
assertExternalGateRoleIndependence(trustContext, [
  launchActivationReceiptRole,
  ...Object.values(productionCutoverReceiptRoles),
]);
const productionCutoverDocument = await loadCanonicalProductionCutoverDocument({
  documentPath: argumentsMap["production-cutover"],
  repositoryRoot,
});
const productionCutoverVerification = verifyProductionCutoverEvidence({
  document: productionCutoverDocument,
  expectedCandidateCommit: argumentsMap.candidate,
  expectedTarget: {
    rollbackDeploymentHost: argumentsMap["rollback-deployment-host"],
    rollbackDeploymentId: argumentsMap["rollback-deployment-id"],
    stagedDeploymentHost: argumentsMap["production-deployment-host"],
    stagedDeploymentId: argumentsMap["production-deployment-id"],
  },
  repositoryRoot,
  trustContext,
});
const receipt = await loadCanonicalReceipt(argumentsMap.receipt);
const activationGeneration = Number(argumentsMap["activation-generation"]);
const flagsRevisionFloor = Number(argumentsMap["flags-revision-floor"]);
if (
  !/^[1-9]\d{0,15}$/u.test(argumentsMap["activation-generation"])
  || !Number.isSafeInteger(activationGeneration)
  || !/^(?:0|[1-9]\d{0,15})$/u.test(argumentsMap["flags-revision-floor"])
  || !Number.isSafeInteger(flagsRevisionFloor)
) fail("LAUNCH_ACTIVATION_NUMERIC_ARGUMENT_INVALID");
const expected = {
  activationExpiresAt: argumentsMap["activation-expires-at"],
  activationGeneration,
  activationNotBefore: argumentsMap["activation-not-before"],
  candidateCommit: argumentsMap.candidate,
  deploymentHost: argumentsMap["deployment-host"],
  deploymentId: argumentsMap["deployment-id"],
  documentBundleSha256: argumentsMap["document-bundle-sha256"],
  finalAttestationSha256: argumentsMap["final-attestation-sha256"],
  flagsEnvironment: argumentsMap["flags-environment"],
  flagsRevisionFloor,
  productionCutoverDbaReceiptSha256:
    productionCutoverVerification.receiptSha256ByRole.dba,
  productionCutoverEvidenceSha256:
    productionCutoverVerification.evidenceSha256,
  productionCutoverPlatformOperationsReceiptSha256:
    productionCutoverVerification.receiptSha256ByRole.platformOperations,
  productionCutoverReleaseObserverReceiptSha256:
    productionCutoverVerification.receiptSha256ByRole.releaseObserver,
  productionDeploymentId: argumentsMap["production-deployment-id"],
  productionDeploymentHost: argumentsMap["production-deployment-host"],
  productionHost: argumentsMap["production-host"],
  projectId: argumentsMap["project-id"],
  releaseGateMatrixSha256: argumentsMap["release-gate-matrix-sha256"],
};
const result = verifyLaunchActivationReceipt({
  expected,
  productionCutoverVerification,
  receipt,
  trustContext,
});
const flagsEnvelope = encodeLaunchActivationFlagsEnvelope({
  expected,
  productionCutoverDocument,
  receipt,
});
const flagsActivation = Object.freeze({
  envelopeSha256: flagsEnvelope.envelopeSha256,
  flagKey: "novalure-production-launch-activation",
  value: flagsEnvelope.value,
  valueBytes: flagsEnvelope.valueBytes,
});
const flagsOutput = await writeExclusiveFlagsActivationFile(
  argumentsMap["flags-output"],
  flagsActivation,
);

process.stdout.write(canonicalJson({
  flagsActivation: {
    envelopeSha256: flagsEnvelope.envelopeSha256,
    flagKey: "novalure-production-launch-activation",
    outputBytes: flagsOutput.outputBytes,
    outputSha256: flagsOutput.outputSha256,
    valueBytes: flagsEnvelope.valueBytes,
  },
  receiptSha256: sha256(canonicalJson(receipt)),
  runtimeEnvironment: result.runtimeEnvironment,
  signatureReference: result.signatureReference,
  status: result.status,
}));
