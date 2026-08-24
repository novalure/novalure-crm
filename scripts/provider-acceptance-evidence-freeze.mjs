#!/usr/bin/env node

import { lstat, open, realpath, rm } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  finalPreviewGateBindings,
  observedFinalPreviewGateStatus,
} from "./final-preview-release-attestation-contract.mjs";
import {
  assertExactObjectKeys,
  canonicalJson,
  isPlainObject,
  loadExternalGateTrustContext,
  requireIsoTimestamp,
  sha256,
  validateExternalGateRuntimeBinding,
} from "./lib/external-gate-receipts.mjs";
import {
  providerExpectedDatabaseTables,
  providerExpectedRequestIds,
} from "./lib/final-preview-gate-inventories.mjs";
import {
  buildProviderAcceptanceReceiptBundleSha256,
  providerAcceptanceRoles,
  providerFinalCleanupRole,
  requiredProviderAcceptances,
  validateProviderAcceptanceReceipts,
  validateProviderFinalCleanupReceipt,
} from "./lib/provider-acceptance-receipts.mjs";
import {
  assertEvidenceIsRedacted,
  providerFailClosedScenarios,
} from "./lib/provider-fail-closed-preview.mjs";

const sha256Pattern = /^[a-f0-9]{64}$/u;
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fingerprintPattern = /^sha256:[a-f0-9]{16}$/u;
const fullFingerprintPattern = /^sha256:[a-f0-9]{64}$/u;

export const providerAcceptanceFreezeLimits = Object.freeze({
  jsonBytes: 2 * 1024 * 1024,
  receiptBytes: 256 * 1024,
  sidecarBytes: 4 * 1024,
  stdinBytes: 64 * 1024,
});

const inputKeys = Object.freeze([
  "cleanupReceiptPath",
  "expectedSourceSha256",
  "expectedTrustAnchorSha256",
  "kind",
  "outputDirectory",
  "receiptPaths",
  "runtime",
  "schemaVersion",
  "sourcePath",
  "sourceSidecarPath",
  "trustAnchorPath",
]);

const sourceKeys = Object.freeze([
  "candidate",
  "cleanup",
  "completedAt",
  "databaseWritePostcondition",
  "httpTechnicalStatus",
  "productionMutationPerformed",
  "providerSideEffectPostcondition",
  "releaseGateStatus",
  "requests",
  "schemaVersion",
  "startedAt",
]);

export class ProviderAcceptanceEvidenceFreezeError extends Error {
  constructor(code, options = undefined) {
    super(code, options);
    this.code = code;
    this.name = "ProviderAcceptanceEvidenceFreezeError";
  }
}

function fail(code, options = undefined) {
  throw new ProviderAcceptanceEvidenceFreezeError(code, options);
}

function invariant(condition, code) {
  if (!condition) fail(code);
}

function normalizedPathKey(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function requireAbsolutePath(value, code) {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > 4_096
    || value.includes("\0")
    || !path.isAbsolute(value)
  ) fail(`${code}_ABSOLUTE_PATH_REQUIRED`);
  return path.resolve(value);
}

function sameFilesystemIdentity(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.nlink === right.nlink;
}

async function readBoundedRegularBytes(filePath, code, maximumBytes) {
  const absolutePath = requireAbsolutePath(filePath, code);
  let before;
  try {
    before = await lstat(absolutePath);
  } catch (error) {
    fail(`${code}_UNAVAILABLE`, { cause: error });
  }
  if (
    !before.isFile()
    || before.isSymbolicLink()
    || before.nlink !== 1
    || before.size <= 0
    || before.size > maximumBytes
  ) fail(`${code}_NOT_BOUNDED_REGULAR_FILE`);
  let actualPath;
  try {
    actualPath = await realpath(absolutePath);
  } catch (error) {
    fail(`${code}_REALPATH_FAILED`, { cause: error });
  }
  if (normalizedPathKey(actualPath) !== normalizedPathKey(absolutePath)) {
    fail(`${code}_SYMLINKED_PATH_REJECTED`);
  }

  let handle;
  try {
    handle = await open(absolutePath, "r");
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || !sameFilesystemIdentity(before, opened)) {
      fail(`${code}_CHANGED_DURING_OPEN`);
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (
      bytes.length <= 0
      || bytes.length > maximumBytes
      || !sameFilesystemIdentity(opened, after)
      || opened.mtimeMs !== after.mtimeMs
    ) fail(`${code}_CHANGED_DURING_READ`);
    return Object.freeze({ absolutePath, bytes });
  } catch (error) {
    if (error instanceof ProviderAcceptanceEvidenceFreezeError) throw error;
    fail(`${code}_READ_FAILED`, { cause: error });
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function readBoundedJson(filePath, code, maximumBytes) {
  const source = await readBoundedRegularBytes(filePath, code, maximumBytes);
  let document;
  try {
    document = JSON.parse(source.bytes.toString("utf8"));
  } catch (error) {
    fail(`${code}_JSON_INVALID`, { cause: error });
  }
  if (!isPlainObject(document)) fail(`${code}_OBJECT_REQUIRED`);
  return Object.freeze({ ...source, document });
}

function parseSidecar(source, expectedFileName) {
  const match = source.match(/^([a-f0-9]{64})  ([^\r\n]+)(?:\r?\n)?$/u);
  if (!match) fail("PROVIDER_ACCEPTANCE_SOURCE_SIDECAR_FORMAT_INVALID");
  if (match[2] !== expectedFileName) fail("PROVIDER_ACCEPTANCE_SOURCE_SIDECAR_FILENAME_MISMATCH");
  return match[1];
}

async function readPinnedSource(input) {
  if (!sha256Pattern.test(input.expectedSourceSha256 ?? "")) {
    fail("PROVIDER_ACCEPTANCE_SOURCE_EXPECTED_DIGEST_INVALID");
  }
  const source = await readBoundedRegularBytes(
    input.sourcePath,
    "PROVIDER_ACCEPTANCE_SOURCE",
    providerAcceptanceFreezeLimits.jsonBytes,
  );
  const sidecar = await readBoundedRegularBytes(
    input.sourceSidecarPath,
    "PROVIDER_ACCEPTANCE_SOURCE_SIDECAR",
    providerAcceptanceFreezeLimits.sidecarBytes,
  );
  const actualDigest = sha256(source.bytes);
  if (actualDigest !== input.expectedSourceSha256) {
    fail("PROVIDER_ACCEPTANCE_SOURCE_DIGEST_MISMATCH");
  }
  const sidecarDigest = parseSidecar(
    sidecar.bytes.toString("utf8"),
    path.basename(source.absolutePath),
  );
  if (sidecarDigest !== actualDigest) {
    fail("PROVIDER_ACCEPTANCE_SOURCE_SIDECAR_DIGEST_MISMATCH");
  }
  let document;
  try {
    document = JSON.parse(source.bytes.toString("utf8"));
  } catch (error) {
    fail("PROVIDER_ACCEPTANCE_SOURCE_JSON_INVALID", { cause: error });
  }
  if (!isPlainObject(document)) fail("PROVIDER_ACCEPTANCE_SOURCE_OBJECT_REQUIRED");
  return Object.freeze({ digest: actualDigest, document });
}

function validateRuntime(runtime) {
  assertExactObjectKeys(runtime, [
    "branch",
    "candidateCommit",
    "databaseBranchId",
    "deploymentHost",
    "deploymentId",
  ], "PROVIDER_ACCEPTANCE_FREEZE_RUNTIME");
  const receiptRuntime = {
    candidateCommit: runtime.candidateCommit,
    databaseBranchId: runtime.databaseBranchId,
    deploymentHost: runtime.deploymentHost,
    deploymentId: runtime.deploymentId,
    gitBranch: runtime.branch,
    productionMutationPerformed: false,
  };
  validateExternalGateRuntimeBinding(receiptRuntime, receiptRuntime);
  return receiptRuntime;
}

function assertExactInventory(actual, expected, code) {
  invariant(Array.isArray(actual) && actual.length === expected.length, `${code}_COUNT_INVALID`);
  invariant(new Set(actual).size === actual.length, `${code}_DUPLICATED`);
  invariant(actual.every((value, index) => value === expected[index]), `${code}_ORDER_INVALID`);
}

function validateRawCandidate(candidate, runtime) {
  assertExactObjectKeys(candidate, [
    "commitSha",
    "databaseBranchFingerprint",
    "databaseBranchId",
    "deploymentHost",
    "deploymentId",
    "gitRef",
    "previewOriginFingerprint",
  ], "PROVIDER_ACCEPTANCE_SOURCE_CANDIDATE");
  invariant(candidate.commitSha === runtime.candidateCommit, "PROVIDER_ACCEPTANCE_SOURCE_COMMIT_MISMATCH");
  invariant(candidate.databaseBranchId === runtime.databaseBranchId, "PROVIDER_ACCEPTANCE_SOURCE_DATABASE_BRANCH_MISMATCH");
  invariant(candidate.deploymentHost === runtime.deploymentHost, "PROVIDER_ACCEPTANCE_SOURCE_HOST_MISMATCH");
  invariant(candidate.deploymentId === runtime.deploymentId, "PROVIDER_ACCEPTANCE_SOURCE_DEPLOYMENT_MISMATCH");
  invariant(candidate.gitRef === runtime.branch, "PROVIDER_ACCEPTANCE_SOURCE_BRANCH_MISMATCH");
  invariant(fingerprintPattern.test(candidate.databaseBranchFingerprint ?? ""), "PROVIDER_ACCEPTANCE_SOURCE_DATABASE_FINGERPRINT_INVALID");
  invariant(fingerprintPattern.test(candidate.previewOriginFingerprint ?? ""), "PROVIDER_ACCEPTANCE_SOURCE_ORIGIN_FINGERPRINT_INVALID");
}

function validateRawRequests(requests) {
  invariant(Array.isArray(requests), "PROVIDER_ACCEPTANCE_SOURCE_REQUESTS_REQUIRED");
  assertExactInventory(
    requests.map((entry) => entry?.id),
    providerExpectedRequestIds,
    "PROVIDER_ACCEPTANCE_SOURCE_REQUEST_INVENTORY",
  );
  const scenarios = new Map(providerFailClosedScenarios.map((entry) => [entry.id, entry]));
  for (const request of requests) {
    assertExactObjectKeys(request, ["code", "csrf", "id", "method", "status"], "PROVIDER_ACCEPTANCE_SOURCE_REQUEST");
    if (request.id === "identity.session" || request.id === "identity.runtime") {
      invariant(request.method === "GET" && request.csrf === "not-applicable", "PROVIDER_ACCEPTANCE_SOURCE_IDENTITY_REQUEST_INVALID");
      invariant(
        request.status === 200
          && request.code === (request.id === "identity.session" ? "SESSION_SCOPE_MATCH" : "RUNTIME_IDENTITY_MATCH"),
        "PROVIDER_ACCEPTANCE_SOURCE_IDENTITY_RESULT_INVALID",
      );
      continue;
    }
    const scenario = scenarios.get(request.id);
    invariant(Boolean(scenario), "PROVIDER_ACCEPTANCE_SOURCE_SCENARIO_UNKNOWN");
    invariant(request.method === scenario.method && request.csrf === scenario.csrf, "PROVIDER_ACCEPTANCE_SOURCE_SCENARIO_REQUEST_INVALID");
    invariant(request.status === 503 && request.code === "LAUNCH_SCOPE_OFF", "PROVIDER_ACCEPTANCE_SOURCE_SCENARIO_RESULT_INVALID");
  }
}

function validateUnchangedDatabase(database) {
  assertExactObjectKeys(database, ["reasonCode", "status", "tables"], "PROVIDER_ACCEPTANCE_SOURCE_DATABASE");
  invariant(database.status === "PASS" && database.reasonCode === null, "PROVIDER_ACCEPTANCE_SOURCE_DATABASE_NOT_PASS");
  invariant(isPlainObject(database.tables), "PROVIDER_ACCEPTANCE_SOURCE_DATABASE_TABLES_REQUIRED");
  const names = Object.keys(database.tables).sort();
  const expectedNames = [...providerExpectedDatabaseTables].sort();
  invariant(
    names.length === expectedNames.length
      && names.every((name, index) => name === expectedNames[index]),
    "PROVIDER_ACCEPTANCE_SOURCE_DATABASE_TABLE_INVENTORY_INVALID",
  );
  for (const table of Object.values(database.tables)) {
    assertExactObjectKeys(table, [
      "afterCount",
      "afterFingerprint",
      "beforeCount",
      "beforeFingerprint",
      "unchanged",
    ], "PROVIDER_ACCEPTANCE_SOURCE_DATABASE_TABLE");
    invariant(
      Number.isSafeInteger(table.beforeCount)
        && table.beforeCount >= 0
        && table.beforeCount === table.afterCount
        && table.unchanged === true
        && fullFingerprintPattern.test(table.beforeFingerprint ?? "")
        && table.beforeFingerprint === table.afterFingerprint,
      "PROVIDER_ACCEPTANCE_SOURCE_DATABASE_DRIFT",
    );
  }
  return sha256(canonicalJson(database));
}

function validateRawCollector(source, runtime) {
  assertExactObjectKeys(source, sourceKeys, "PROVIDER_ACCEPTANCE_SOURCE_COLLECTOR");
  invariant(source.schemaVersion === 1, "PROVIDER_ACCEPTANCE_SOURCE_SCHEMA_INVALID");
  invariant(source.productionMutationPerformed === false, "PROVIDER_ACCEPTANCE_SOURCE_PRODUCTION_MUTATION");
  invariant(source.httpTechnicalStatus === "PASS", "PROVIDER_ACCEPTANCE_SOURCE_HTTP_NOT_PASS");
  invariant(source.releaseGateStatus === "BLOCKED", "PROVIDER_ACCEPTANCE_SOURCE_MUST_REMAIN_BLOCKED");
  requireIsoTimestamp(source.startedAt, "PROVIDER_ACCEPTANCE_SOURCE_STARTED_AT_INVALID");
  requireIsoTimestamp(source.completedAt, "PROVIDER_ACCEPTANCE_SOURCE_COMPLETED_AT_INVALID");
  invariant(Date.parse(source.completedAt) >= Date.parse(source.startedAt), "PROVIDER_ACCEPTANCE_SOURCE_TIME_ORDER_INVALID");
  validateRawCandidate(source.candidate, runtime);
  validateRawRequests(source.requests);
  const databasePostconditionSha256 = validateUnchangedDatabase(source.databaseWritePostcondition);
  assertExactObjectKeys(source.providerSideEffectPostcondition, [
    "codeOrderAndHttpGate",
    "independentProviderLogs",
    "reasonCode",
  ], "PROVIDER_ACCEPTANCE_SOURCE_PROVIDER_POSTCONDITION");
  invariant(
    source.providerSideEffectPostcondition.codeOrderAndHttpGate === "PASS"
      && source.providerSideEffectPostcondition.independentProviderLogs === "UNPROVEN"
      && source.providerSideEffectPostcondition.reasonCode === "INDEPENDENT_PROVIDER_LOGS_NOT_COLLECTED",
    "PROVIDER_ACCEPTANCE_SOURCE_PROVIDER_POSTCONDITION_INVALID",
  );
  assertExactObjectKeys(source.cleanup, [
    "databaseCleanup",
    "externalSessionCreatedByRunner",
    "inMemoryCookieJar",
    "status",
  ], "PROVIDER_ACCEPTANCE_SOURCE_CLEANUP");
  invariant(
    source.cleanup.databaseCleanup === "NOT_REQUIRED"
      && source.cleanup.externalSessionCreatedByRunner === false
      && source.cleanup.inMemoryCookieJar === "CLEARED_IN_FINALLY"
      && source.cleanup.status === "COMPLETE",
    "PROVIDER_ACCEPTANCE_SOURCE_CLEANUP_INVALID",
  );
  assertEvidenceIsRedacted(source);
  return databasePostconditionSha256;
}

function assertDistinctInputPaths(input) {
  const values = [
    input.cleanupReceiptPath,
    input.sourcePath,
    input.sourceSidecarPath,
    ...input.receiptPaths,
    input.trustAnchorPath,
  ];
  const keys = values.map((value) => normalizedPathKey(requireAbsolutePath(value, "PROVIDER_ACCEPTANCE_INPUT")));
  invariant(new Set(keys).size === keys.length, "PROVIDER_ACCEPTANCE_INPUT_PATH_REUSED");
  requireAbsolutePath(input.outputDirectory, "PROVIDER_ACCEPTANCE_OUTPUT_DIRECTORY");
}

async function readReceipts(receiptPaths) {
  const entries = await Promise.all(receiptPaths.map((filePath, index) => readBoundedJson(
    filePath,
    `PROVIDER_ACCEPTANCE_RECEIPT_${index + 1}`,
    providerAcceptanceFreezeLimits.receiptBytes,
  )));
  return entries.map((entry) => entry.document);
}

function sortedReceipts(receipts) {
  const order = new Map(Object.keys(requiredProviderAcceptances).map((id, index) => [id, index]));
  return [...receipts].sort((left, right) => {
    const leftIndex = order.get(left?.payload?.acceptanceId) ?? Number.MAX_SAFE_INTEGER;
    const rightIndex = order.get(right?.payload?.acceptanceId) ?? Number.MAX_SAFE_INTEGER;
    return leftIndex - rightIndex;
  });
}

function assembleProviderEvidence({
  cleanupReceipt,
  databasePostconditionSha256,
  receipts,
  runtime,
  source,
  sourceSha256,
  trustContext,
}) {
  const orderedReceipts = sortedReceipts(receipts);
  const sourceCollectorSha256 = sha256(canonicalJson(source));
  validateProviderAcceptanceReceipts({
    databasePostcondition: source.databaseWritePostcondition,
    receipts: orderedReceipts,
    runtime,
    sourceArtifactSha256: sourceSha256,
    sourceCollectorSha256,
    sourceCompletedAt: source.completedAt,
    trustContext,
  });
  const acceptanceCompletedAt = orderedReceipts
    .map((receipt) => receipt.signedAt)
    .sort()
    .at(-1);
  requireIsoTimestamp(acceptanceCompletedAt, "PROVIDER_ACCEPTANCE_ASSEMBLY_COMPLETED_AT_INVALID");
  validateProviderFinalCleanupReceipt({
    receipt: cleanupReceipt,
    receipts: orderedReceipts,
    runtime,
    sourceArtifactSha256: sourceSha256,
    sourceCollectorSha256,
    trustContext,
  });
  const frozen = {
    ...source,
    collectionMode: "LIVE_PROVIDER_ACCEPTANCE",
    completedAt: cleanupReceipt.signedAt,
    providerAcceptanceAssembly: {
      acceptanceIds: orderedReceipts.map((receipt) => receipt.payload.acceptanceId),
      acceptanceCompletedAt,
      acceptanceReceiptBundleSha256: buildProviderAcceptanceReceiptBundleSha256(orderedReceipts),
      databasePostconditionSha256,
      evidenceManifest: orderedReceipts.map((receipt) => ({
        acceptanceArtifactSha256: receipt.payload.artifactSha256,
        acceptanceId: receipt.payload.acceptanceId,
        cleanupEvidenceSha256: receipt.payload.postAcceptance.cleanupEvidenceSha256,
        databaseEvidenceSha256: receipt.payload.postAcceptance.databaseEvidenceSha256,
        providerAccountFingerprint: receipt.payload.providerIdentity.providerAccountFingerprint,
        providerLogArtifactSha256: receipt.payload.providerIdentity.providerLogArtifactSha256,
        qaTargetFingerprint: receipt.payload.qaTargetFingerprint,
        receiptId: receipt.receiptId,
        receiptRole: receipt.role,
      })),
      receiptPayloadSha256: orderedReceipts.map((receipt) => receipt.payloadSha256),
      finalCleanupReceiptPayloadSha256: cleanupReceipt.payloadSha256,
      sourceArtifactSha256: sourceSha256,
      sourceCollectorSha256,
      sourceCompletedAt: source.completedAt,
      sourceIndependentProviderLogs: "UNPROVEN",
      sourceReleaseGateStatus: "BLOCKED",
    },
    providerAcceptanceReceipts: orderedReceipts,
    providerFinalCleanupReceipt: cleanupReceipt,
    providerSideEffectPostcondition: {
      codeOrderAndHttpGate: "PASS",
      independentProviderLogs: "PASS",
      reasonCode: null,
    },
    releaseGateStatus: "PASS",
  };
  invariant(
    sha256(canonicalJson(frozen.databaseWritePostcondition)) === databasePostconditionSha256,
    "PROVIDER_ACCEPTANCE_DATABASE_POSTCONDITION_CHANGED",
  );
  const gate = finalPreviewGateBindings.find((entry) => entry.id === "provider-boundaries");
  invariant(Boolean(gate), "PROVIDER_ACCEPTANCE_FINAL_GATE_BINDING_MISSING");
  invariant(
    observedFinalPreviewGateStatus(gate, frozen, {
      branch: runtime.gitBranch,
      candidateCommit: runtime.candidateCommit,
      databaseBranchId: runtime.databaseBranchId,
      deploymentHost: runtime.deploymentHost,
      deploymentId: runtime.deploymentId,
    }, { trustContext }) === "PASS",
    "PROVIDER_ACCEPTANCE_FINAL_GATE_NOT_PASS",
  );
  return frozen;
}

function assertNoSecretMaterial(source) {
  const forbidden = [
    /postgres(?:ql)?:\/\/[^\s"'<>]+/iu,
    /(?:\?|&)_vercel_share=/iu,
    /vercel_blob_rw_/iu,
    /novalure_session=/iu,
    /\bre_[A-Za-z0-9_-]{16,}\b/u,
    /\bAIza[A-Za-z0-9_-]{30,}\b/u,
    /\bya29\.[A-Za-z0-9._-]{16,}\b/u,
    /-----BEGIN (?:ENCRYPTED )?PRIVATE KEY-----/iu,
    /"(?:accessToken|authorization|clientSecret|connectionString|cookie|databaseUrl|password|privateKey|refreshToken|secret|sessionCookie|shareToken|shareUrl|token|totpSecret)"\s*:\s*"(?!<redacted>"|REDACTED")[^"\r\n]+"/iu,
  ];
  if (forbidden.some((pattern) => pattern.test(source))) {
    fail("PROVIDER_ACCEPTANCE_OUTPUT_SECRET_PATTERN_DETECTED");
  }
}

async function requireSafeOutputDirectory(directory) {
  const absolutePath = requireAbsolutePath(directory, "PROVIDER_ACCEPTANCE_OUTPUT_DIRECTORY");
  let state;
  try {
    state = await lstat(absolutePath);
  } catch (error) {
    fail("PROVIDER_ACCEPTANCE_OUTPUT_DIRECTORY_UNAVAILABLE", { cause: error });
  }
  if (!state.isDirectory() || state.isSymbolicLink()) {
    fail("PROVIDER_ACCEPTANCE_OUTPUT_DIRECTORY_INVALID");
  }
  const actualPath = await realpath(absolutePath);
  if (normalizedPathKey(actualPath) !== normalizedPathKey(absolutePath)) {
    fail("PROVIDER_ACCEPTANCE_OUTPUT_DIRECTORY_SYMLINKED");
  }
  return Object.freeze({ absolutePath, dev: state.dev, ino: state.ino });
}

async function assertStableOutputPath(directory, filePath, openedState) {
  const [directoryState, directoryRealPath, fileState] = await Promise.all([
    lstat(directory.absolutePath),
    realpath(directory.absolutePath),
    lstat(filePath),
  ]);
  invariant(
    directoryState.isDirectory()
      && !directoryState.isSymbolicLink()
      && directoryState.dev === directory.dev
      && directoryState.ino === directory.ino
      && normalizedPathKey(directoryRealPath) === normalizedPathKey(directory.absolutePath)
      && fileState.isFile()
      && !fileState.isSymbolicLink()
      && fileState.nlink === 1
      && sameFilesystemIdentity(openedState, fileState),
    "PROVIDER_ACCEPTANCE_OUTPUT_CHANGED_DURING_WRITE",
  );
}

async function removeCreatedOutputIfUnchanged(directory, filePath, openedState) {
  if (!openedState) return;
  try {
    await assertStableOutputPath(directory, filePath, openedState);
    await rm(filePath);
  } catch {
    // Never delete a path after its directory or inode identity changed.
  }
}

async function writeExclusiveEvidence(document, outputDirectory) {
  const directory = await requireSafeOutputDirectory(outputDirectory);
  const fileName = "provider-boundaries.json";
  const artifactPath = path.join(directory.absolutePath, fileName);
  const sidecarPath = `${artifactPath}.sha256`;
  const serialized = canonicalJson(document);
  assertNoSecretMaterial(serialized);
  const digest = sha256(serialized);
  let artifactHandle;
  let sidecarHandle;
  let artifactCreated = false;
  let sidecarCreated = false;
  let artifactOpenedState;
  let sidecarOpenedState;
  let completed = false;
  try {
    artifactHandle = await open(artifactPath, "wx+", 0o600);
    artifactCreated = true;
    artifactOpenedState = await artifactHandle.stat();
    sidecarHandle = await open(sidecarPath, "wx+", 0o600);
    sidecarCreated = true;
    sidecarOpenedState = await sidecarHandle.stat();
    await artifactHandle.writeFile(serialized, "utf8");
    const sidecar = `${digest}  ${fileName}\n`;
    await sidecarHandle.writeFile(sidecar, "utf8");
    await Promise.all([artifactHandle.sync(), sidecarHandle.sync()]);
    [artifactOpenedState, sidecarOpenedState] = await Promise.all([
      artifactHandle.stat(),
      sidecarHandle.stat(),
    ]);
    const artifactVerification = Buffer.alloc(Buffer.byteLength(serialized));
    const sidecarVerification = Buffer.alloc(Buffer.byteLength(sidecar));
    await Promise.all([
      artifactHandle.read(artifactVerification, 0, artifactVerification.length, 0),
      sidecarHandle.read(sidecarVerification, 0, sidecarVerification.length, 0),
    ]);
    invariant(
      artifactOpenedState.size === artifactVerification.length
        && sidecarOpenedState.size === sidecarVerification.length
        && sha256(artifactVerification) === digest
        && sidecarVerification.toString("utf8") === sidecar,
      "PROVIDER_ACCEPTANCE_OUTPUT_VERIFICATION_FAILED",
    );
    await Promise.all([
      assertStableOutputPath(directory, artifactPath, artifactOpenedState),
      assertStableOutputPath(directory, sidecarPath, sidecarOpenedState),
    ]);
    completed = true;
    return Object.freeze({
      artifactPath,
      digest,
      fileName,
      sidecarFileName: `${fileName}.sha256`,
      sidecarPath,
    });
  } catch (error) {
    if (error?.code === "EEXIST") {
      fail("PROVIDER_ACCEPTANCE_OUTPUT_EXISTS", { cause: error });
    }
    if (error instanceof ProviderAcceptanceEvidenceFreezeError) throw error;
    fail("PROVIDER_ACCEPTANCE_OUTPUT_WRITE_FAILED", { cause: error });
  } finally {
    await Promise.all([
      artifactHandle?.close().catch(() => undefined),
      sidecarHandle?.close().catch(() => undefined),
    ]);
    if (!completed) {
      await Promise.all([
        artifactCreated
          ? removeCreatedOutputIfUnchanged(directory, artifactPath, artifactOpenedState)
          : undefined,
        sidecarCreated
          ? removeCreatedOutputIfUnchanged(directory, sidecarPath, sidecarOpenedState)
          : undefined,
      ]);
    }
  }
}

async function readBoundedStdin(stream = process.stdin) {
  const chunks = [];
  let length = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += bytes.length;
    if (length > providerAcceptanceFreezeLimits.stdinBytes) {
      fail("PROVIDER_ACCEPTANCE_STDIN_TOO_LARGE");
    }
    chunks.push(bytes);
  }
  if (length === 0) fail("PROVIDER_ACCEPTANCE_STDIN_REQUIRED");
  return Buffer.concat(chunks).toString("utf8");
}

function parseInput(source) {
  let input;
  try {
    input = JSON.parse(source);
  } catch (error) {
    fail("PROVIDER_ACCEPTANCE_STDIN_JSON_INVALID", { cause: error });
  }
  if (!isPlainObject(input)) fail("PROVIDER_ACCEPTANCE_INPUT_OBJECT_REQUIRED");
  assertExactObjectKeys(input, inputKeys, "PROVIDER_ACCEPTANCE_INPUT");
  if (input.schemaVersion !== 1 || input.kind !== "provider-acceptance") {
    fail("PROVIDER_ACCEPTANCE_INPUT_SCHEMA_INVALID");
  }
  if (!sha256Pattern.test(input.expectedTrustAnchorSha256 ?? "")) {
    fail("PROVIDER_ACCEPTANCE_TRUST_ANCHOR_DIGEST_INVALID");
  }
  if (!Array.isArray(input.receiptPaths) || input.receiptPaths.length !== Object.keys(requiredProviderAcceptances).length) {
    fail("PROVIDER_ACCEPTANCE_RECEIPT_PATHS_INVALID");
  }
  assertDistinctInputPaths(input);
  return input;
}

export async function providerAcceptanceEvidenceFreezeMain({
  inputStream = process.stdin,
  outputStream = process.stdout,
} = {}) {
  const input = parseInput(await readBoundedStdin(inputStream));
  const receiptRuntime = validateRuntime(input.runtime);
  const source = await readPinnedSource(input);
  const databasePostconditionSha256 = validateRawCollector(source.document, input.runtime);
  const trustContext = await loadExternalGateTrustContext({
    anchorPath: requireAbsolutePath(input.trustAnchorPath, "PROVIDER_ACCEPTANCE_TRUST_ANCHOR"),
    expectedSha256: input.expectedTrustAnchorSha256,
    repositoryRoot,
    requiredRoles: [...providerAcceptanceRoles, providerFinalCleanupRole],
  });
  const [receipts, cleanupReceiptEntry] = await Promise.all([
    readReceipts(input.receiptPaths),
    readBoundedJson(
      input.cleanupReceiptPath,
      "PROVIDER_ACCEPTANCE_FINAL_CLEANUP_RECEIPT",
      providerAcceptanceFreezeLimits.receiptBytes,
    ),
  ]);
  const frozen = assembleProviderEvidence({
    cleanupReceipt: cleanupReceiptEntry.document,
    databasePostconditionSha256,
    receipts,
    runtime: receiptRuntime,
    source: source.document,
    sourceSha256: source.digest,
    trustContext,
  });
  const written = await writeExclusiveEvidence(frozen, input.outputDirectory);
  outputStream.write(`${JSON.stringify({
    digest: written.digest,
    fileName: written.fileName,
    kind: input.kind,
    sidecarFileName: written.sidecarFileName,
    status: "PASS",
  })}\n`);
  return written;
}

const directEntrypoint = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
  : false;

if (directEntrypoint) {
  providerAcceptanceEvidenceFreezeMain().catch((error) => {
    const safeErrorCode = error instanceof ProviderAcceptanceEvidenceFreezeError
      || /^[A-Z][A-Z0-9_]{2,160}$/u.test(error instanceof Error ? error.message : "")
      ? error.message
      : "PROVIDER_ACCEPTANCE_EVIDENCE_FREEZE_FAILED";
    process.stderr.write(`${JSON.stringify({
      errorCode: safeErrorCode,
      ok: false,
    })}\n`);
    process.exitCode = 1;
  });
}
