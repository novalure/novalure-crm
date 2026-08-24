#!/usr/bin/env node

import { createHash } from "node:crypto";
import { lstat, open, realpath, rm } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  buildPerformanceTechnicalEvidenceSha256,
  finalPerformanceBudgetPolicy,
  finalPreviewGateBindings,
  observedFinalPreviewGateStatus,
} from "./final-preview-release-attestation-contract.mjs";
import {
  accessibilityApprovalRoles,
  accessibilityRequiredManualCheckIds,
  validateAccessibilityApprovalReceipts,
} from "./lib/accessibility-manual-acceptance-receipt.mjs";
import { a11yFixtureLifecycleFileName } from "./lib/a11y-fixture-lifecycle-evidence.mjs";
import {
  assertExactObjectKeys,
  canonicalJson,
  isPlainObject,
  loadExternalGateTrustContext,
  validateExternalGateRuntimeBinding,
} from "./lib/external-gate-receipts.mjs";
import {
  performanceBudgetApprovalRoles,
  performanceManualAcceptanceRole,
  performanceManualGateIds,
  performanceRumAcceptanceRole,
  validatePerformanceBudgetApprovalReceipt,
  validatePerformanceManualAcceptanceReceipt,
  validatePerformanceRumAcceptanceReceipt,
} from "./lib/performance-acceptance-receipts.mjs";

const maximumStdinBytes = 64 * 1024;
const maximumJsonBytes = 16 * 1024 * 1024;
const maximumSidecarBytes = 4 * 1024;
const maximumTrustAnchorBytes = 64 * 1024;
const sha256Pattern = /^[a-f0-9]{64}$/u;
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const accessibilityInputKeys = Object.freeze([
  "approvalReceiptPaths",
  "expectedSourceSha256",
  "expectedTrustAnchorSha256",
  "kind",
  "lifecyclePath",
  "lifecycleSidecarPath",
  "manualEvidencePaths",
  "matrixPath",
  "outputDirectory",
  "runtime",
  "schemaVersion",
  "sourcePath",
  "sourceSidecarPath",
  "trustAnchorPath",
]);

const performanceInputKeys = Object.freeze([
  "budgetApprovalReceiptPaths",
  "expectedSourceSha256",
  "expectedTrustAnchorSha256",
  "kind",
  "manualReceiptPath",
  "outputDirectory",
  "rumReceiptPath",
  "runtime",
  "schemaVersion",
  "sourcePath",
  "sourceSidecarPath",
  "trustAnchorPath",
]);

export class FinalPreviewEvidenceFreezeError extends Error {
  constructor(code, options = undefined) {
    super(code, options);
    this.code = code;
    this.name = "FinalPreviewEvidenceFreezeError";
  }
}

function fail(code, options = undefined) {
  throw new FinalPreviewEvidenceFreezeError(code, options);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
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
  let canonicalPath;
  try {
    canonicalPath = await realpath(absolutePath);
  } catch (error) {
    fail(`${code}_UNAVAILABLE`, { cause: error });
  }
  if (normalizedPathKey(canonicalPath) !== normalizedPathKey(absolutePath)) {
    fail(`${code}_NOT_BOUNDED_REGULAR_FILE`);
  }
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
    if (error instanceof FinalPreviewEvidenceFreezeError) throw error;
    fail(`${code}_READ_FAILED`, { cause: error });
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function readBoundedJson(filePath, code) {
  const source = await readBoundedRegularBytes(filePath, code, maximumJsonBytes);
  let document;
  try {
    document = JSON.parse(source.bytes.toString("utf8"));
  } catch (error) {
    fail(`${code}_JSON_INVALID`, { cause: error });
  }
  if (!isPlainObject(document)) fail(`${code}_OBJECT_REQUIRED`);
  return Object.freeze({ ...source, document });
}

function parseSidecar(source, expectedFileName, code) {
  const match = source.match(/^([a-f0-9]{64})  ([^\r\n]+)(?:\r?\n)?$/u);
  if (!match) fail(`${code}_FORMAT_INVALID`);
  if (match[2] !== expectedFileName) fail(`${code}_FILENAME_MISMATCH`);
  return match[1];
}

async function readPinnedSource(input) {
  if (!sha256Pattern.test(input.expectedSourceSha256 ?? "")) {
    fail("FINAL_PREVIEW_EVIDENCE_SOURCE_EXPECTED_DIGEST_INVALID");
  }
  const source = await readBoundedRegularBytes(
    input.sourcePath,
    "FINAL_PREVIEW_EVIDENCE_SOURCE",
    maximumJsonBytes,
  );
  const sidecar = await readBoundedRegularBytes(
    input.sourceSidecarPath,
    "FINAL_PREVIEW_EVIDENCE_SOURCE_SIDECAR",
    maximumSidecarBytes,
  );
  const actualDigest = sha256(source.bytes);
  if (actualDigest !== input.expectedSourceSha256) {
    fail("FINAL_PREVIEW_EVIDENCE_SOURCE_DIGEST_MISMATCH");
  }
  const sidecarDigest = parseSidecar(
    sidecar.bytes.toString("utf8"),
    path.basename(source.absolutePath),
    "FINAL_PREVIEW_EVIDENCE_SOURCE_SIDECAR",
  );
  if (sidecarDigest !== actualDigest) {
    fail("FINAL_PREVIEW_EVIDENCE_SOURCE_SIDECAR_DIGEST_MISMATCH");
  }
  let document;
  try {
    document = JSON.parse(source.bytes.toString("utf8"));
  } catch (error) {
    fail("FINAL_PREVIEW_EVIDENCE_SOURCE_JSON_INVALID", { cause: error });
  }
  if (!isPlainObject(document)) fail("FINAL_PREVIEW_EVIDENCE_SOURCE_OBJECT_REQUIRED");
  return document;
}

async function readPinnedAuxiliaryJson(filePath, sidecarPath, expectedFileName, code) {
  const [source, sidecar] = await Promise.all([
    readBoundedRegularBytes(filePath, code, maximumJsonBytes),
    readBoundedRegularBytes(sidecarPath, `${code}_SIDECAR`, maximumSidecarBytes),
  ]);
  if (path.basename(source.absolutePath) !== expectedFileName) fail(`${code}_FILENAME_MISMATCH`);
  const actualDigest = sha256(source.bytes);
  const sidecarDigest = parseSidecar(
    sidecar.bytes.toString("utf8"),
    expectedFileName,
    `${code}_SIDECAR`,
  );
  if (actualDigest !== sidecarDigest) fail(`${code}_SIDECAR_DIGEST_MISMATCH`);
  let document;
  try {
    document = JSON.parse(source.bytes.toString("utf8"));
  } catch (error) {
    fail(`${code}_JSON_INVALID`, { cause: error });
  }
  if (!isPlainObject(document)) fail(`${code}_OBJECT_REQUIRED`);
  return Object.freeze({ digest: actualDigest, document });
}

function validateRuntime(runtime, kind) {
  const keys = [
    "branch",
    "candidateCommit",
    "databaseBranchId",
    "deploymentHost",
    "deploymentId",
  ];
  if (kind === "accessibility") keys.push("databaseProjectId");
  assertExactObjectKeys(runtime, keys, "FINAL_PREVIEW_EVIDENCE_RUNTIME");
  if (
    kind === "accessibility"
    && !/^[-A-Za-z0-9]{8,80}$/u.test(runtime.databaseProjectId ?? "")
  ) {
    fail("FINAL_PREVIEW_EVIDENCE_DATABASE_PROJECT_INVALID");
  }
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

function assertDistinctInputPaths(input, paths) {
  const keys = paths.map((value) => normalizedPathKey(requireAbsolutePath(value, "FINAL_PREVIEW_EVIDENCE_INPUT")));
  if (new Set(keys).size !== keys.length) fail("FINAL_PREVIEW_EVIDENCE_INPUT_PATH_REUSED");
  requireAbsolutePath(input.outputDirectory, "FINAL_PREVIEW_EVIDENCE_OUTPUT_DIRECTORY");
}

function automatedA11yProjection(source, automatedSourceSha256) {
  return {
    automatedSourceSha256,
    automatedSubsetPassed: source.automatedSubsetPassed,
    automatedTechnicalPassed: source.automatedTechnicalPassed,
    browser: source.browser,
    cleanup: source.cleanup,
    coverage: source.coverage,
    endedAt: source.endedAt,
    evidenceDigest: source.evidenceDigest,
    executionBlocker: source.executionBlocker,
    executionScope: source.executionScope,
    expectedSha: source.expectedSha,
    generatedAt: source.generatedAt,
    matrix: source.matrix,
    mode: source.mode,
    productionMutationPerformed: source.productionMutationPerformed,
    releaseSurfaceManifestVerified: source.releaseSurfaceManifestVerified,
    results: source.results,
    runtimeIdentity: source.runtimeIdentity,
    schemaVersion: source.schemaVersion,
    startedAt: source.startedAt,
    targetHost: source.targetHost,
    unsafeHttpWriteGuard: source.unsafeHttpWriteGuard,
    wcagStandard: source.wcagStandard,
  };
}

function bindingFor(id) {
  const binding = finalPreviewGateBindings.find((entry) => entry.id === id);
  if (!binding) fail("FINAL_PREVIEW_EVIDENCE_GATE_BINDING_MISSING");
  return binding;
}

async function freezeAccessibility(input, source, runtime, receiptRuntime, trustContext) {
  if (
    !Array.isArray(input.manualEvidencePaths)
    || input.manualEvidencePaths.length !== accessibilityRequiredManualCheckIds.length
  ) fail("FINAL_PREVIEW_EVIDENCE_ACCESSIBILITY_MANUAL_PATHS_INVALID");
  assertExactObjectKeys(
    input.approvalReceiptPaths,
    accessibilityApprovalRoles.map((entry) => entry.receiptRole),
    "FINAL_PREVIEW_EVIDENCE_ACCESSIBILITY_APPROVAL_RECEIPT_PATHS",
  );
  const approvalReceiptPaths = accessibilityApprovalRoles.map(
    (entry) => input.approvalReceiptPaths[entry.receiptRole],
  );
  assertDistinctInputPaths(input, [
    input.sourcePath,
    input.sourceSidecarPath,
    ...input.manualEvidencePaths,
    input.lifecyclePath,
    input.lifecycleSidecarPath,
    input.matrixPath,
    ...approvalReceiptPaths,
    input.trustAnchorPath,
  ]);
  const [
    individualEvidenceEntries,
    lifecycleEntry,
    matrixEntry,
    approvalReceiptEntries,
  ] = await Promise.all([
    Promise.all(input.manualEvidencePaths.map((filePath, index) => readBoundedJson(
      filePath,
      `FINAL_PREVIEW_EVIDENCE_ACCESSIBILITY_MANUAL_${index + 1}`,
    ))),
    readPinnedAuxiliaryJson(
      input.lifecyclePath,
      input.lifecycleSidecarPath,
      a11yFixtureLifecycleFileName,
      "FINAL_PREVIEW_EVIDENCE_ACCESSIBILITY_LIFECYCLE",
    ),
    readBoundedJson(input.matrixPath, "FINAL_PREVIEW_EVIDENCE_ACCESSIBILITY_MATRIX"),
    Promise.all(approvalReceiptPaths.map((filePath, index) => readBoundedJson(
      filePath,
      `FINAL_PREVIEW_EVIDENCE_ACCESSIBILITY_APPROVAL_${index + 1}`,
    ))),
  ]);
  const individualEvidence = individualEvidenceEntries.map((entry) => entry.document);
  const matrix = matrixEntry.document;
  const approvalReceipts = Object.fromEntries(accessibilityApprovalRoles.map((entry, index) => [
    entry.receiptRole,
    approvalReceiptEntries[index].document,
  ]));
  const automatedEvidence = automatedA11yProjection(source, input.expectedSourceSha256);
  const verified = validateAccessibilityApprovalReceipts({
    approvalReceipts,
    automatedEvidence,
    databaseProjectId: input.runtime.databaseProjectId,
    expectedAutomatedEvidence: automatedEvidence,
    fixtureLifecycle: lifecycleEntry.document,
    fixtureLifecycleSha256: lifecycleEntry.digest,
    individualEvidence,
    matrix,
    runtime: receiptRuntime,
    trustContext,
  });
  const frozen = {
    ...source,
    automatedSourceSha256: input.expectedSourceSha256,
    acceptance: {
      contractComplete: true,
      manualAcceptancePassed: true,
      manualCheckCount: verified.manualCheckCount,
      manualPassCount: verified.manualCheckCount,
      matrixSigned: true,
      signatureCount: verified.signatureCount,
      signaturesComplete: true,
      status: "SIGNED",
    },
    manualAcceptance: {
      approvalReceipts,
      automatedEvidence,
      databaseProjectId: input.runtime.databaseProjectId,
      fixtureLifecycle: lifecycleEntry.document,
      fixtureLifecycleSha256: lifecycleEntry.digest,
      individualEvidence,
      matrix,
    },
    releasePassed: true,
  };
  if (
    observedFinalPreviewGateStatus(
      bindingFor("accessibility-browser"),
      frozen,
      runtime,
      { trustContext },
    ) !== "PASS"
  ) fail("FINAL_PREVIEW_EVIDENCE_ACCESSIBILITY_NOT_PASS");
  return Object.freeze({ document: frozen, fileName: "accessibility-browser.json" });
}

async function freezePerformance(input, source, runtime, receiptRuntime, trustContext) {
  if (
    !Array.isArray(input.budgetApprovalReceiptPaths)
    || input.budgetApprovalReceiptPaths.length !== performanceBudgetApprovalRoles.length
  ) fail("FINAL_PREVIEW_EVIDENCE_PERFORMANCE_BUDGET_APPROVAL_PATHS_INVALID");
  assertDistinctInputPaths(input, [
    input.sourcePath,
    input.sourceSidecarPath,
    ...input.budgetApprovalReceiptPaths,
    input.manualReceiptPath,
    input.rumReceiptPath,
    input.trustAnchorPath,
  ]);
  const [budgetApprovalEntries, manualReceiptEntry, rumReceiptEntry] = await Promise.all([
    Promise.all(input.budgetApprovalReceiptPaths.map((filePath, index) => readBoundedJson(
      filePath,
      `FINAL_PREVIEW_EVIDENCE_PERFORMANCE_BUDGET_APPROVAL_${index + 1}`,
    ))),
    readBoundedJson(input.manualReceiptPath, "FINAL_PREVIEW_EVIDENCE_PERFORMANCE_MANUAL_RECEIPT"),
    readBoundedJson(input.rumReceiptPath, "FINAL_PREVIEW_EVIDENCE_PERFORMANCE_RUM_RECEIPT"),
  ]);
  const technicalEvidenceSha256 = buildPerformanceTechnicalEvidenceSha256(source);
  const budgetApprovalReceipts = {};
  for (const [index, expected] of performanceBudgetApprovalRoles.entries()) {
    const receipt = budgetApprovalEntries[index].document;
    validatePerformanceBudgetApprovalReceipt({
      approvalRole: expected.approvalRole,
      budgetPolicy: finalPerformanceBudgetPolicy,
      receipt,
      runtime: receiptRuntime,
      trustContext,
    });
    budgetApprovalReceipts[expected.approvalRole] = receipt;
  }
  validatePerformanceManualAcceptanceReceipt({
    budgetPolicy: finalPerformanceBudgetPolicy,
    receipt: manualReceiptEntry.document,
    runtime: receiptRuntime,
    technicalEvidenceSha256,
    trustContext,
  });
  validatePerformanceRumAcceptanceReceipt({
    budgetPolicy: finalPerformanceBudgetPolicy,
    receipt: rumReceiptEntry.document,
    runtime: receiptRuntime,
    technicalEvidenceSha256,
    trustContext,
  });
  const frozen = {
    ...source,
    budgetApprovalStatus: "SIGNED",
    budgetApprovalReceipts,
    manualAcceptanceReceipt: manualReceiptEntry.document,
    manualAndRumGatesComplete: true,
    manualGates: Object.fromEntries(performanceManualGateIds.map((id) => [id, "PASS"])),
    realUserMonitoring: { status: "PASS" },
    realUserMonitoringReceipt: rumReceiptEntry.document,
    releasePassed: true,
    signaturesPresent: true,
    technicalEvidenceSha256,
  };
  if (
    observedFinalPreviewGateStatus(
      bindingFor("performance"),
      frozen,
      runtime,
      { trustContext },
    ) !== "PASS"
  ) fail("FINAL_PREVIEW_EVIDENCE_PERFORMANCE_NOT_PASS");
  return Object.freeze({ document: frozen, fileName: "performance.json" });
}

function assertNoSecretMaterial(source) {
  const forbidden = [
    /postgres(?:ql)?:\/\/[^\s"'<>]+/iu,
    /(?:\?|&)_vercel_share=/iu,
    /vercel_blob_rw_/iu,
    /novalure_session=/iu,
    /-----BEGIN (?:ENCRYPTED )?PRIVATE KEY-----/iu,
    /"(?:accessToken|authorization|clientSecret|connectionString|cookie|databaseUrl|password|privateKey|refreshToken|secret|sessionCookie|shareToken|shareUrl|token|totpSecret)"\s*:\s*"(?!<redacted>"|REDACTED")[^"\r\n]+"/iu,
  ];
  if (forbidden.some((pattern) => pattern.test(source))) {
    fail("FINAL_PREVIEW_EVIDENCE_SECRET_PATTERN_DETECTED");
  }
}

async function requireSafeOutputDirectory(directory) {
  const absolutePath = requireAbsolutePath(directory, "FINAL_PREVIEW_EVIDENCE_OUTPUT_DIRECTORY");
  let state;
  try {
    state = await lstat(absolutePath);
  } catch (error) {
    fail("FINAL_PREVIEW_EVIDENCE_OUTPUT_DIRECTORY_UNAVAILABLE", { cause: error });
  }
  if (!state.isDirectory() || state.isSymbolicLink()) {
    fail("FINAL_PREVIEW_EVIDENCE_OUTPUT_DIRECTORY_INVALID");
  }
  const actualPath = await realpath(absolutePath);
  if (normalizedPathKey(actualPath) !== normalizedPathKey(absolutePath)) {
    fail("FINAL_PREVIEW_EVIDENCE_OUTPUT_DIRECTORY_SYMLINKED");
  }
  return Object.freeze({ absolutePath, dev: state.dev, ino: state.ino });
}

async function assertStableOutputPath(directory, filePath, openedState) {
  const [directoryState, directoryRealPath, fileState] = await Promise.all([
    lstat(directory.absolutePath),
    realpath(directory.absolutePath),
    lstat(filePath),
  ]);
  if (
    !directoryState.isDirectory()
    || directoryState.isSymbolicLink()
    || directoryState.dev !== directory.dev
    || directoryState.ino !== directory.ino
    || normalizedPathKey(directoryRealPath) !== normalizedPathKey(directory.absolutePath)
    || !fileState.isFile()
    || fileState.isSymbolicLink()
    || fileState.nlink !== 1
    || !sameFilesystemIdentity(openedState, fileState)
  ) fail("FINAL_PREVIEW_EVIDENCE_OUTPUT_CHANGED_DURING_WRITE");
}

async function removeCreatedOutputIfUnchanged(directory, filePath, openedState) {
  if (!openedState) return;
  try {
    await assertStableOutputPath(directory, filePath, openedState);
    await rm(filePath);
  } catch {
    // A swapped path is intentionally left untouched; deleting it could remove
    // an attacker-controlled replacement rather than this process's inode.
  }
}

async function writeExclusiveEvidence({ document, fileName }, outputDirectory) {
  const directory = await requireSafeOutputDirectory(outputDirectory);
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
    if (
      artifactOpenedState.size !== artifactVerification.length
      || sidecarOpenedState.size !== sidecarVerification.length
      || sha256(artifactVerification) !== digest
      || sidecarVerification.toString("utf8") !== sidecar
    ) fail("FINAL_PREVIEW_EVIDENCE_OUTPUT_VERIFICATION_FAILED");
    await Promise.all([
      assertStableOutputPath(directory, artifactPath, artifactOpenedState),
      assertStableOutputPath(directory, sidecarPath, sidecarOpenedState),
    ]);
    completed = true;
    return Object.freeze({ digest, fileName, sidecarFileName: `${fileName}.sha256` });
  } catch (error) {
    if (error?.code === "EEXIST") {
      fail("FINAL_PREVIEW_EVIDENCE_OUTPUT_EXISTS", { cause: error });
    }
    if (error instanceof FinalPreviewEvidenceFreezeError) throw error;
    fail("FINAL_PREVIEW_EVIDENCE_WRITE_FAILED", { cause: error });
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
    if (length > maximumStdinBytes) fail("FINAL_PREVIEW_EVIDENCE_STDIN_TOO_LARGE");
    chunks.push(bytes);
  }
  if (length === 0) fail("FINAL_PREVIEW_EVIDENCE_STDIN_REQUIRED");
  return Buffer.concat(chunks).toString("utf8");
}

function parseInput(source) {
  let input;
  try {
    input = JSON.parse(source);
  } catch (error) {
    fail("FINAL_PREVIEW_EVIDENCE_STDIN_JSON_INVALID", { cause: error });
  }
  if (!isPlainObject(input)) fail("FINAL_PREVIEW_EVIDENCE_INPUT_OBJECT_REQUIRED");
  if (input.schemaVersion !== 1) fail("FINAL_PREVIEW_EVIDENCE_INPUT_SCHEMA_INVALID");
  if (input.kind === "accessibility") {
    assertExactObjectKeys(input, accessibilityInputKeys, "FINAL_PREVIEW_EVIDENCE_ACCESSIBILITY_INPUT");
  } else if (input.kind === "performance") {
    assertExactObjectKeys(input, performanceInputKeys, "FINAL_PREVIEW_EVIDENCE_PERFORMANCE_INPUT");
  } else {
    fail("FINAL_PREVIEW_EVIDENCE_KIND_INVALID");
  }
  if (!sha256Pattern.test(input.expectedTrustAnchorSha256 ?? "")) {
    fail("FINAL_PREVIEW_EVIDENCE_TRUST_ANCHOR_DIGEST_INVALID");
  }
  return input;
}

export async function finalPreviewEvidenceFreezeMain({
  argv = process.argv.slice(2),
  inputStream = process.stdin,
  outputStream = process.stdout,
} = {}) {
  if (!Array.isArray(argv) || argv.length !== 0) {
    fail("FINAL_PREVIEW_EVIDENCE_ARGUMENTS_PROHIBITED");
  }
  const input = parseInput(await readBoundedStdin(inputStream));
  const receiptRuntime = validateRuntime(input.runtime, input.kind);
  const source = await readPinnedSource(input);
  const requiredRoles = input.kind === "accessibility"
    ? accessibilityApprovalRoles.map((entry) => entry.receiptRole)
    : [
      ...performanceBudgetApprovalRoles.map((entry) => entry.receiptRole),
      performanceManualAcceptanceRole,
      performanceRumAcceptanceRole,
    ];
  const trustAnchorPath = requireAbsolutePath(
    input.trustAnchorPath,
    "FINAL_PREVIEW_EVIDENCE_TRUST_ANCHOR",
  );
  const trustAnchorSource = await readBoundedRegularBytes(
    trustAnchorPath,
    "FINAL_PREVIEW_EVIDENCE_TRUST_ANCHOR",
    maximumTrustAnchorBytes,
  );
  if (sha256(trustAnchorSource.bytes) !== input.expectedTrustAnchorSha256) {
    fail("FINAL_PREVIEW_EVIDENCE_TRUST_ANCHOR_DIGEST_MISMATCH");
  }
  const trustContext = await loadExternalGateTrustContext({
    anchorPath: trustAnchorPath,
    expectedSha256: input.expectedTrustAnchorSha256,
    repositoryRoot,
    requiredRoles,
  });
  const frozen = input.kind === "accessibility"
    ? await freezeAccessibility(input, source, input.runtime, receiptRuntime, trustContext)
    : await freezePerformance(input, source, input.runtime, receiptRuntime, trustContext);
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
  finalPreviewEvidenceFreezeMain().catch((error) => {
    process.stderr.write(`${JSON.stringify({
      errorCode: error instanceof Error ? error.message : "FINAL_PREVIEW_EVIDENCE_FREEZE_FAILED",
      ok: false,
    })}\n`);
    process.exitCode = 1;
  });
}
