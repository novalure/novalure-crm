#!/usr/bin/env node

import { createHash, createPublicKey, verify as verifyDetachedSignature } from "node:crypto";
import { spawnSync } from "node:child_process";
import { lstat, open, readFile, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { verifyRecoveryEvidenceForFinalAttestation } from "./database-recovery-evidence-verify.mjs";
import { loadExternalRecoveryTrustAnchor } from "./database-recovery-live-evidence.mjs";
import {
  accessibilityApprovalRoles,
  accessibilityRequiredManualCheckIds,
  validateAccessibilityApprovalReceipts,
} from "./lib/accessibility-manual-acceptance-receipt.mjs";
import { validateCompanyProfileApprovalReceipt } from "./lib/company-profile-approval-receipt.mjs";
import {
  externalGateReceiptRoles,
  validateExternalGateTrustContext,
} from "./lib/external-gate-receipts.mjs";
import {
  a11yExpectedResultKeys,
  performanceExpectedResultKeys,
  previewBlobExpectedCheckIds,
  providerExpectedDatabaseTables,
  providerExpectedRequestIds,
  publicExpectedReadOnlyRequestIds,
  publicRequiredProofIds,
  twoTenantCleanupResourceTypes,
  twoTenantExpectedResultIds,
} from "./lib/final-preview-gate-inventories.mjs";
import {
  performanceBudgetApprovalRoles,
  validatePerformanceBudgetApprovalReceipt,
  validatePerformanceManualAcceptanceReceipt,
  validatePerformanceRumAcceptanceReceipt,
} from "./lib/performance-acceptance-receipts.mjs";
import {
  buildProviderAcceptanceReceiptBundleSha256,
  validateProviderAcceptanceReceipts,
  validateProviderFinalCleanupReceipt,
} from "./lib/provider-acceptance-receipts.mjs";
import { providerFailClosedScenarios } from "./lib/provider-fail-closed-preview.mjs";
import {
  publicRuntimeArtifactFiles,
  validatePublicRuntimeProtectedReceipt,
} from "./lib/public-runtime-protected-receipt.mjs";
import { validateProductionFunnelTokenCutoverEvidence } from "./lib/production-funnel-token-cutover-receipt.mjs";
import { validateOperationalGateReceipt } from "./lib/operational-gate-receipts.mjs";
import {
  protectedWorkflowEvidenceFiles,
  twoTenantParentBaseArtifactFile,
  validateProtectedWorkflowProvenanceReceipt,
  verifyGitHubArtifactAttestation,
} from "./lib/protected-workflow-provenance-receipt.mjs";
import { validateLegacyBlobMigrationProof } from "./lib/blob-legacy-migration-receipt.mjs";
import {
  launchScopeDecisions,
  launchScopePolicy,
  launchScopePolicyVersion,
} from "../src/lib/launch-scope.ts";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const maximumApprovalTrustAnchorBytes = 256 * 1024;
const maximumRepositoryEvidenceBytes = 16 * 1024 * 1024;
const defaultAttestationPath =
  "docs/audit/2026-08-23/final-preview-release-attestation.template.json";

export const finalPreviewDocumentBindings = Object.freeze([
  Object.freeze({
    candidateJsonPointer: "/candidateCommit",
    id: "database-recovery",
    path: "docs/audit/2026-08-23/database-recovery-evidence-manifest.json",
    sidecarPath: "docs/audit/2026-08-23/database-recovery-evidence-manifest.json.sha256",
  }),
  Object.freeze({
    candidateJsonPointer: "/candidateCommit",
    id: "release-surface-manifest",
    path: "docs/audit/2026-08-23/release-surface-manifest.json",
    sidecarPath: "docs/audit/2026-08-23/release-surface-manifest.json.sha256",
  }),
  Object.freeze({
    candidateJsonPointer: "/candidateCommit",
    id: "release-gate-matrix",
    path: "docs/audit/2026-08-23/release-gate-matrix.json",
    sidecarPath: "docs/audit/2026-08-23/release-gate-matrix.json.sha256",
  }),
  Object.freeze({
    candidateJsonPointer: "/candidateCommit",
    id: "legal-content-manifest",
    path: "docs/audit/2026-08-23/legal-content-manifest.json",
    sidecarPath: "docs/audit/2026-08-23/legal-content-manifest.json.sha256",
  }),
  Object.freeze({
    candidateJsonPointer: "/candidateCommit",
    id: "company-profile-approval",
    path: "docs/audit/2026-08-23/company-profile-approval.json",
    sidecarPath: "docs/audit/2026-08-23/company-profile-approval.json.sha256",
  }),
]);

export const finalPreviewGateBindings = Object.freeze([
  Object.freeze({
    candidateJsonPointer: "/candidateCommit",
    fileName: "database-recovery.json",
    id: "database-recovery",
    schemaJsonPointer: "/schemaVersion",
    schemaValue: 2,
    statusJsonPointer: "/status",
  }),
  Object.freeze({
    candidateJsonPointer: "/commit",
    fileName: "two-tenant-rbac-crud.json",
    id: "two-tenant-rbac-crud",
    schemaJsonPointer: "/schema",
    schemaValue: "novalure.qa.two-tenant-e2e.v1",
    statusJsonPointer: "/summary/failed",
  }),
  Object.freeze({
    candidateJsonPointer: "/deployment/gitSha",
    fileName: "preview-blob-lifecycle.json",
    id: "preview-blob-lifecycle",
    schemaJsonPointer: "/schema",
    schemaValue: "novalure.qa.preview-blob-lifecycle.v1",
    statusJsonPointer: "/releaseGatePassed",
  }),
  Object.freeze({
    candidateJsonPointer: "/candidate/commitSha",
    fileName: "provider-boundaries.json",
    id: "provider-boundaries",
    schemaJsonPointer: "/schemaVersion",
    schemaValue: 1,
    statusJsonPointer: "/releaseGateStatus",
  }),
  Object.freeze({
    candidateJsonPointer: "/candidate/gitSha",
    fileName: "public-form-funnel.json",
    id: "public-form-funnel",
    schemaJsonPointer: "/schemaVersion",
    schemaValue: 1,
    statusJsonPointer: "/releaseGateStatus",
  }),
  Object.freeze({
    candidateJsonPointer: "/candidateCommit",
    fileName: "production-funnel-token-cutover.json",
    id: "production-funnel-token-cutover",
    schemaJsonPointer: "/schemaVersion",
    schemaValue: 1,
    statusJsonPointer: "/status",
  }),
  Object.freeze({
    candidateJsonPointer: "/expectedSha",
    fileName: "accessibility-browser.json",
    id: "accessibility-browser",
    schemaJsonPointer: "/schemaVersion",
    schemaValue: 4,
    statusJsonPointer: "/releasePassed",
  }),
  Object.freeze({
    candidateJsonPointer: "/expectedSha",
    fileName: "performance.json",
    id: "performance",
    schemaJsonPointer: "/schemaVersion",
    schemaValue: 2,
    statusJsonPointer: "/releasePassed",
  }),
  ...[
    ["observability", "novalure.release.observability.v1"],
    ["security-supply-chain", "novalure.release.security-supply-chain.v1"],
    ["cleanup-null-rest", "novalure.release.cleanup-null-rest.v1"],
    ["runtime-logs", "novalure.release.runtime-logs.v1"],
  ].map(([id, schemaValue]) => Object.freeze({
    candidateJsonPointer: "/candidateCommit",
    fileName: `${id}.json`,
    id,
    schemaJsonPointer: "/schema",
    schemaValue,
    statusJsonPointer: "/status",
  })),
]);

export const finalPreviewGateIds = Object.freeze(finalPreviewGateBindings.map((binding) => binding.id));

const finalPreviewGateBindingById = new Map(finalPreviewGateBindings.map((binding) => [binding.id, binding]));

const genericGateAssertions = Object.freeze({
  "cleanup-null-rest": Object.freeze(["blob", "database", "externalProviders", "sessions"]),
  observability: Object.freeze(["alertDelivery", "errorIngestion", "runtimeAlerting", "syntheticAlarm"]),
  "runtime-logs": Object.freeze(["boundedWindow", "noUnhandledErrors", "requestCorrelation", "targetDeploymentOnly"]),
  "security-supply-chain": Object.freeze(["dependencyAudit", "licensePolicy", "pinnedActions", "sast", "secretScan"]),
});

export const finalPerformanceBudgetPolicy = Object.freeze({
  authenticated: Object.freeze({
    accessibilityScoreMin: 0.95,
    bestPracticesScoreMin: 0.9,
    cumulativeLayoutShiftMax: 0.1,
    largestContentfulPaintMaxMs: 2_500,
    performanceScoreMin: 0.8,
    totalBlockingTimeMaxMs: 300,
  }),
  bundle: Object.freeze({ maxRegressionPercent: 5 }),
  public: Object.freeze({
    accessibilityScoreMin: 0.95,
    bestPracticesScoreMin: 0.9,
    cumulativeLayoutShiftMax: 0.1,
    largestContentfulPaintMaxMs: 2_500,
    performanceScoreMin: 0.9,
    totalBlockingTimeMaxMs: 200,
  }),
  realUserP75: Object.freeze({
    cumulativeLayoutShiftMax: 0.1,
    interactionToNextPaintMaxMs: 200,
    largestContentfulPaintMaxMs: 2_500,
  }),
  requiredApprovalRoles: Object.freeze(performanceBudgetApprovalRoles.map((entry) => entry.approvalRole)),
  schemaVersion: 1,
});

const attestationStatuses = new Set(["PENDING", "EVIDENCE_FROZEN", "SIGNED"]);
const decisions = new Set(["NO-GO", "CONDITIONAL_GO", "GO"]);
const evidenceStatuses = new Set([
  "PASS",
  "FAIL",
  "BLOCKED",
  "NOT_RUN",
  "PENDING_SIGNATURE",
]);
export const releaseApprovalRoles = Object.freeze([
  "product",
  "engineering",
  "security",
  "operations",
  "legal",
  "privacy",
  "sales-operations",
  "data-compliance",
]);
const signatureRoles = releaseApprovalRoles;
const trustedAnchorRoles = Object.freeze([...releaseApprovalRoles, ...externalGateReceiptRoles]);
const relationshipApprovalRoles = Object.freeze({
  "data-compliance": "dataCompliance",
  engineering: "engineering",
  product: "product",
  "sales-operations": "salesOperations",
});
const requiredApprovalScopesByRole = Object.freeze({
  product: Object.freeze(["FINAL_RELEASE", "PRODUCT", "UNIT_BUYER_DEAL"]),
  engineering: Object.freeze(["ENGINEERING", "FINAL_RELEASE", "UNIT_BUYER_DEAL"]),
  security: Object.freeze(["FINAL_RELEASE", "SECURITY"]),
  operations: Object.freeze(["FINAL_RELEASE", "OPERATIONS"]),
  legal: Object.freeze(["FINAL_RELEASE", "LEGAL_CONTENT"]),
  privacy: Object.freeze(["FINAL_RELEASE", "PRIVACY_CONTENT"]),
  "sales-operations": Object.freeze(["FINAL_RELEASE", "UNIT_BUYER_DEAL"]),
  "data-compliance": Object.freeze(["DATA_COMPLIANCE", "FINAL_RELEASE", "UNIT_BUYER_DEAL"]),
});
const trustAnchorIdPattern = /^ta_[A-Za-z0-9_-]{8,120}$/u;
const approvalKeyIdPattern = /^key_[A-Za-z0-9_-]{8,120}$/u;
const signerSubjectPattern = /^subject:[A-Za-z0-9][A-Za-z0-9._:@/-]{7,240}$/u;
const evidenceRunIdPattern = /^run-\d{8}T\d{6}Z-[a-f0-9]{12}$/u;
const evidenceRunRoot = "docs/audit/2026-08-23/final-evidence/runs";
const requiredLegalPageRoutes = Object.freeze([
  "/cookies",
  "/data-deletion",
  "/imprint",
  "/meta",
  "/privacy",
  "/terms",
  "/unsubscribe",
]);
const requiredLegalLanguages = Object.freeze(["de", "en"]);

function invariant(condition, code) {
  if (!condition) throw new Error(code);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function isPlainObject(value) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]),
  );
}

function canonicalJson(value) {
  return `${JSON.stringify(canonicalize(value), null, 2)}\n`;
}

function assertExactKeys(value, expectedKeys, code) {
  invariant(isPlainObject(value), `${code}_NOT_OBJECT`);
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  invariant(
    actual.length === expected.length
      && actual.every((key, index) => key === expected[index]),
    `${code}_KEYS_INVALID`,
  );
}

function isCommitSha(value) {
  return typeof value === "string" && /^[a-f0-9]{40}$/u.test(value);
}

function isDigest(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function isIsoTimestamp(value) {
  return typeof value === "string"
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value)
    && !Number.isNaN(Date.parse(value));
}

function assertRepositoryRelativePath(value, code) {
  invariant(
    typeof value === "string"
      && value.length > 0
      && !value.includes("\\")
      && !value.startsWith("/")
      && !value.split("/").includes(".."),
    code,
  );
}

async function resolveTrustedRepositoryRegularFileAtRoot(relativePath, rootPath) {
  assertRepositoryRelativePath(relativePath, "FINAL_ATTESTATION_PATH_INVALID");
  const absoluteRoot = resolve(rootPath);
  const target = resolve(absoluteRoot, relativePath);
  const lexicalRelative = relative(absoluteRoot, target);
  invariant(
    lexicalRelative !== ""
      && lexicalRelative !== ".."
      && !lexicalRelative.startsWith(`..${sep}`),
    "FINAL_ATTESTATION_PATH_ESCAPED_REPOSITORY",
  );
  const stats = await lstat(target);
  invariant(stats.isFile() && !stats.isSymbolicLink(), "FINAL_ATTESTATION_REPOSITORY_FILE_NOT_REGULAR");
  const [realRepositoryRoot, realTarget] = await Promise.all([
    realpath(absoluteRoot),
    realpath(target),
  ]);
  const targetRelative = relative(realRepositoryRoot, realTarget);
  invariant(
    targetRelative !== ""
      && targetRelative !== ".."
      && !targetRelative.startsWith(`..${sep}`),
    "FINAL_ATTESTATION_REPOSITORY_FILE_REALPATH_ESCAPED",
  );
  return realTarget;
}

async function resolveTrustedRepositoryRegularFile(relativePath) {
  return resolveTrustedRepositoryRegularFileAtRoot(relativePath, repositoryRoot);
}

function isBoundedSingleLinkRegularFile(stats) {
  return stats.isFile()
    && !stats.isSymbolicLink()
    && stats.nlink === 1
    && Number.isSafeInteger(stats.size)
    && stats.size > 0
    && stats.size <= maximumApprovalTrustAnchorBytes;
}

function sameOpenedFileIdentity(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.nlink === right.nlink
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

async function readExternalTrustAnchorRegularFile(absolutePath) {
  invariant(
    typeof absolutePath === "string" && isAbsolute(absolutePath),
    "FINAL_ATTESTATION_TRUST_ANCHOR_PATH_INVALID",
  );
  const target = resolve(absolutePath);
  const before = await lstat(target);
  invariant(isBoundedSingleLinkRegularFile(before), "FINAL_ATTESTATION_TRUST_ANCHOR_NOT_BOUNDED_SINGLE_LINK_FILE");
  const [realRepositoryRoot, realTargetBefore] = await Promise.all([
    realpath(repositoryRoot),
    realpath(target),
  ]);
  const targetRelative = relative(realRepositoryRoot, realTargetBefore);
  invariant(
    targetRelative === ".." || targetRelative.startsWith(`..${sep}`),
    "FINAL_ATTESTATION_TRUST_ANCHOR_MUST_BE_EXTERNAL",
  );
  let handle;
  try {
    handle = await open(target, "r");
    const opened = await handle.stat();
    invariant(
      isBoundedSingleLinkRegularFile(opened)
        && sameOpenedFileIdentity(before, opened),
      "FINAL_ATTESTATION_TRUST_ANCHOR_CHANGED_BEFORE_OPEN",
    );
    const source = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < source.length) {
      const { bytesRead } = await handle.read(
        source,
        offset,
        source.length - offset,
        offset,
      );
      invariant(bytesRead > 0, "FINAL_ATTESTATION_TRUST_ANCHOR_CHANGED_DURING_READ");
      offset += bytesRead;
    }
    const trailingByte = Buffer.alloc(1);
    const trailingRead = await handle.read(trailingByte, 0, 1, offset);
    invariant(trailingRead.bytesRead === 0, "FINAL_ATTESTATION_TRUST_ANCHOR_CHANGED_DURING_READ");
    const [openedAfterRead, after, realTargetAfter] = await Promise.all([
      handle.stat(),
      lstat(target),
      realpath(target),
    ]);
    invariant(
      isBoundedSingleLinkRegularFile(openedAfterRead)
        && isBoundedSingleLinkRegularFile(after)
        && sameOpenedFileIdentity(opened, openedAfterRead)
        && sameOpenedFileIdentity(opened, after)
        && realTargetAfter === realTargetBefore,
      "FINAL_ATTESTATION_TRUST_ANCHOR_CHANGED_DURING_READ",
    );
    return source;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function runReadOnlyGit(args, { allowFailure = false, cwd = repositoryRoot, encoding = "utf8" } = {}) {
  const result = spawnSync("git", args, {
    cwd,
    encoding,
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
  });
  invariant(result.error === undefined, "FINAL_ATTESTATION_GIT_UNAVAILABLE");
  if (!allowFailure) {
    invariant(result.status === 0, "FINAL_ATTESTATION_GIT_COMMAND_FAILED");
  }
  return result;
}

function gitText(args, options = {}) {
  const result = runReadOnlyGit(args, { ...options, encoding: "utf8" });
  return { ...result, stdout: String(result.stdout ?? "").trim() };
}

function gitRegularBlobOid(commit, repositoryPath, repositoryRootPath) {
  assertRepositoryRelativePath(repositoryPath, "FINAL_ATTESTATION_GIT_PATH_INVALID");
  invariant(isCommitSha(commit), "FINAL_ATTESTATION_GIT_COMMIT_INVALID");
  const result = gitText(["ls-tree", commit, "--", repositoryPath], { cwd: repositoryRootPath });
  const match = result.stdout.match(/^100(?:644|755) blob ([a-f0-9]{40})\t([^\r\n]+)$/u);
  invariant(match && match[2] === repositoryPath, "FINAL_ATTESTATION_GIT_PATH_NOT_REGULAR_BLOB");
  return match[1];
}

function readCommittedGitBlob(commit, repositoryPath, repositoryRootPath) {
  const oid = gitRegularBlobOid(commit, repositoryPath, repositoryRootPath);
  const size = Number(gitText(
    ["cat-file", "-s", oid],
    { cwd: repositoryRootPath },
  ).stdout);
  invariant(
    Number.isSafeInteger(size) && size > 0 && size <= maximumRepositoryEvidenceBytes,
    "FINAL_ATTESTATION_GIT_BLOB_SIZE_INVALID",
  );
  const committed = runReadOnlyGit(
    ["cat-file", "blob", oid],
    { cwd: repositoryRootPath, encoding: null },
  );
  invariant(committed.status === 0, "FINAL_ATTESTATION_GIT_BLOB_READ_FAILED");
  const committedBytes = Buffer.isBuffer(committed.stdout)
    ? committed.stdout
    : Buffer.from(committed.stdout ?? "");
  invariant(committedBytes.byteLength === size, "FINAL_ATTESTATION_GIT_BLOB_SIZE_MISMATCH");
  return committedBytes;
}

function matchesCommittedBytesOrCrlfCheckout(worktreeBytes, committedBytes) {
  if (worktreeBytes.equals(committedBytes)) return true;
  // A checkout may expand an LF-only Git blob to CRLF. No other byte
  // transformation is accepted, and callers continue to hash the Git blob.
  if (committedBytes.includes(0x0d)) return false;

  let worktreeIndex = 0;
  let committedIndex = 0;
  let expandedLineEnding = false;
  while (
    worktreeIndex < worktreeBytes.byteLength
      && committedIndex < committedBytes.byteLength
  ) {
    if (worktreeBytes[worktreeIndex] === committedBytes[committedIndex]) {
      worktreeIndex += 1;
      committedIndex += 1;
      continue;
    }
    if (
      worktreeBytes[worktreeIndex] === 0x0d
        && worktreeBytes[worktreeIndex + 1] === 0x0a
        && committedBytes[committedIndex] === 0x0a
    ) {
      expandedLineEnding = true;
      worktreeIndex += 2;
      committedIndex += 1;
      continue;
    }
    return false;
  }
  return expandedLineEnding
    && worktreeIndex === worktreeBytes.byteLength
    && committedIndex === committedBytes.byteLength;
}

async function assertRepositoryFileMatchesCommit(repositoryPath, commit, repositoryRootPath) {
  const sourcePath = await resolveTrustedRepositoryRegularFileAtRoot(repositoryPath, repositoryRootPath);
  const [workingBytes, committedBytes] = await Promise.all([
    readFile(sourcePath),
    Promise.resolve(readCommittedGitBlob(commit, repositoryPath, repositoryRootPath)),
  ]);
  invariant(
    matchesCommittedBytesOrCrlfCheckout(workingBytes, committedBytes),
    "FINAL_ATTESTATION_GIT_BLOB_WORKTREE_MISMATCH",
  );
}

export async function verifyLegalManifestCandidateSources({
  candidateCommit,
  legalContentManifest,
  repositoryRootPath = repositoryRoot,
}) {
  invariant(isPlainObject(legalContentManifest), "FINAL_ATTESTATION_LEGAL_MANIFEST_REQUIRED");
  invariant(isCommitSha(candidateCommit), "FINAL_ATTESTATION_LEGAL_CANDIDATE_COMMIT_INVALID");
  invariant(
    isPlainObject(legalContentManifest.sharedFacts),
    "FINAL_ATTESTATION_LEGAL_SHARED_FACTS_INVALID",
  );
  const sourceRecords = [
    legalContentManifest.sharedFacts,
    ...[
      ...(Array.isArray(legalContentManifest.pages) ? legalContentManifest.pages : []),
      ...(Array.isArray(legalContentManifest.routeAliases) ? legalContentManifest.routeAliases : []),
      ...(Array.isArray(legalContentManifest.functionalContracts)
        ? legalContentManifest.functionalContracts
        : []),
    ].flatMap((entry) => (Array.isArray(entry?.sourceFiles) ? entry.sourceFiles : [])),
  ];
  const sourcePaths = sourceRecords.map((source) => source?.path);
  invariant(
    sourcePaths.length > 1
      && sourcePaths.every((sourcePath) => typeof sourcePath === "string")
      && new Set(sourcePaths).size === sourcePaths.length,
    "FINAL_ATTESTATION_LEGAL_SOURCE_INVENTORY_INVALID",
  );
  for (const source of sourceRecords) {
    assertExactKeys(source, ["path", "sha256"], "FINAL_ATTESTATION_LEGAL_SOURCE");
    assertRepositoryRelativePath(source.path, "FINAL_ATTESTATION_LEGAL_SOURCE_PATH_INVALID");
    invariant(isDigest(source.sha256), "FINAL_ATTESTATION_LEGAL_SOURCE_DIGEST_INVALID");
    const committedBytes = readCommittedGitBlob(
      candidateCommit,
      source.path,
      repositoryRootPath,
    );
    invariant(
      sha256(committedBytes) === source.sha256,
      "FINAL_ATTESTATION_LEGAL_SOURCE_DIGEST_MISMATCH",
    );
  }
  return Object.freeze({
    candidateCommit,
    sourceCount: sourceRecords.length,
    status: "PASS",
  });
}

export async function verifyFinalPreviewRepositoryProvenance({
  attestation,
  attestationPath,
  repositoryRootPath = repositoryRoot,
}) {
  validateEvidenceProvenance(attestation.evidenceProvenance, false);
  assertRepositoryRelativePath(attestationPath, "FINAL_ATTESTATION_PATH_INVALID");
  invariant(
    attestationPath === `${attestation.evidenceProvenance.runDirectory}/final-preview-release-attestation.json`,
    "FINAL_ATTESTATION_RUN_ATTESTATION_PATH_INVALID",
  );
  const status = gitText(
    ["status", "--porcelain=v1", "--untracked-files=all"],
    { cwd: repositoryRootPath },
  ).stdout;
  invariant(status.length === 0, "FINAL_ATTESTATION_REPOSITORY_NOT_CLEAN");
  const head = gitText(["rev-parse", "--verify", "HEAD"], { cwd: repositoryRootPath }).stdout;
  invariant(isCommitSha(head), "FINAL_ATTESTATION_HEAD_INVALID");
  const candidateCommit = attestation.runtime?.candidateCommit;
  invariant(isCommitSha(candidateCommit), "FINAL_ATTESTATION_CANDIDATE_COMMIT_INVALID");
  const evidenceCommit = attestation.evidenceProvenance.evidenceCommit;
  const candidateAncestry = runReadOnlyGit(
    ["merge-base", "--is-ancestor", candidateCommit, evidenceCommit],
    { allowFailure: true, cwd: repositoryRootPath },
  );
  invariant(candidateAncestry.status === 0, "FINAL_ATTESTATION_CANDIDATE_NOT_EVIDENCE_ANCESTOR");
  const ancestry = runReadOnlyGit(
    ["merge-base", "--is-ancestor", evidenceCommit, head],
    { allowFailure: true, cwd: repositoryRootPath },
  );
  invariant(ancestry.status === 0, "FINAL_ATTESTATION_EVIDENCE_COMMIT_NOT_ANCESTOR");

  const evidenceParents = gitText(
    ["rev-list", "--parents", "-n", "1", evidenceCommit],
    { cwd: repositoryRootPath },
  ).stdout.split(/\s+/u);
  invariant(
    evidenceParents.length === 2 && evidenceParents[1] === candidateCommit,
    "FINAL_ATTESTATION_EVIDENCE_COMMIT_MUST_DIRECTLY_FOLLOW_CANDIDATE",
  );

  const parent = gitText(
    ["rev-parse", "--verify", `${evidenceCommit}^`],
    { allowFailure: true, cwd: repositoryRootPath },
  );
  if (parent.status === 0) {
    const priorRunDirectory = runReadOnlyGit(
      ["cat-file", "-e", `${parent.stdout}:${attestation.evidenceProvenance.runDirectory}`],
      { allowFailure: true, cwd: repositoryRootPath },
    );
    invariant(priorRunDirectory.status !== 0, "FINAL_ATTESTATION_RUN_DIRECTORY_NOT_NEW");
  }

  const evidencePaths = [
    ...attestation.documents.flatMap((entry) => [entry.path, entry.sidecarPath]),
    ...attestation.gateEvidence
      .filter((entry) => entry.status !== "NOT_RUN")
      .flatMap((entry) => [entry.path, entry.sidecarPath]),
  ];
  invariant(new Set(evidencePaths).size === evidencePaths.length, "FINAL_ATTESTATION_PROVENANCE_PATH_REUSED");
  const evidenceChangedPaths = gitText([
    "diff",
    "--name-only",
    "--no-renames",
    candidateCommit,
    evidenceCommit,
    "--",
  ], { cwd: repositoryRootPath }).stdout.split(/\r?\n/u).filter(Boolean);
  invariant(
    evidenceChangedPaths.length === evidencePaths.length
      && new Set(evidenceChangedPaths).size === evidenceChangedPaths.length
      && evidencePaths.every((repositoryPath) => evidenceChangedPaths.includes(repositoryPath)),
    "FINAL_ATTESTATION_EVIDENCE_COMMIT_PATHS_INVALID",
  );
  for (const repositoryPath of evidencePaths) {
    await assertRepositoryFileMatchesCommit(repositoryPath, evidenceCommit, repositoryRootPath);
  }

  const headPaths = [attestationPath];
  if (attestation.status === "SIGNED") {
    for (const role of signatureRoles) {
      headPaths.push(
        attestation.signatures[role].approvalArtifactPath,
        attestation.signatures[role].approvalArtifactSidecarPath,
      );
    }
  }
  invariant(new Set(headPaths).size === headPaths.length, "FINAL_ATTESTATION_HEAD_PATH_REUSED");
  const approvalChangedPaths = gitText([
    "diff",
    "--name-only",
    "--no-renames",
    evidenceCommit,
    head,
    "--",
  ], { cwd: repositoryRootPath }).stdout.split(/\r?\n/u).filter(Boolean);
  invariant(
    approvalChangedPaths.length === headPaths.length
      && new Set(approvalChangedPaths).size === approvalChangedPaths.length
      && headPaths.every((repositoryPath) => approvalChangedPaths.includes(repositoryPath)),
    "FINAL_ATTESTATION_APPROVAL_COMMIT_PATHS_INVALID",
  );
  for (const repositoryPath of headPaths) {
    await assertRepositoryFileMatchesCommit(repositoryPath, head, repositoryRootPath);
  }
  return Object.freeze({ evidenceCommit, head, status: "PASS" });
}

function parseSidecar(source, expectedFileName) {
  const match = String(source).trim().match(/^([a-f0-9]{64})  ([^\r\n]+)$/u);
  invariant(match, "FINAL_ATTESTATION_SIDECAR_INVALID");
  invariant(match[2] === expectedFileName, "FINAL_ATTESTATION_SIDECAR_FILENAME_MISMATCH");
  return match[1];
}

function scanForSecretMaterial(source) {
  for (const forbidden of [
    /postgres(?:ql)?:\/\/[^\s"'<>]+/iu,
    /(?:\?|&)_vercel_share=/iu,
    /vercel_blob_rw_/iu,
    /novalure_session=/iu,
    /-----BEGIN (?:ENCRYPTED )?PRIVATE KEY-----/iu,
    /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/iu,
    /\beyJ[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/u,
    /\b(?:re_|sk_(?:live|test)_|ya29\.)[A-Za-z0-9._~-]{16,}\b/u,
    /"(?:apiKey|apiToken|accessToken|authorization|blobReadWriteToken|clientSecret|connectionString|cookie|databaseUrl|oauthClientSecret|password|passwords|passwd|postgresUrl|privateKey|refreshToken|resendApiKey|secret|sessionCookie|shareToken|shareUrl|token|totpSecret|vercelBypassToken)"\s*:\s*"(?!<redacted>"|REDACTED")[^"\r\n]+"/iu,
  ]) {
    invariant(!forbidden.test(source), "FINAL_ATTESTATION_SECRET_PATTERN_DETECTED");
  }
}

export function readJsonPointer(document, pointer) {
  invariant(
    typeof pointer === "string" && /^\/(?:[A-Za-z][A-Za-z0-9]*)(?:\/(?:[A-Za-z][A-Za-z0-9]*))*$/u.test(pointer),
    "FINAL_ATTESTATION_JSON_POINTER_INVALID",
  );
  return pointer
    .slice(1)
    .split("/")
    .reduce((value, key) => {
      invariant(isPlainObject(value) && Object.hasOwn(value, key), "FINAL_ATTESTATION_JSON_POINTER_MISSING");
      return value[key];
    }, document);
}

export function assertEvidenceCandidateBinding({
  candidateJsonPointer,
  evidenceDocument,
  runtimeCandidateCommit,
}) {
  invariant(isCommitSha(runtimeCandidateCommit), "FINAL_ATTESTATION_RUNTIME_CANDIDATE_INVALID");
  const evidenceCandidate = readJsonPointer(evidenceDocument, candidateJsonPointer);
  invariant(isCommitSha(evidenceCandidate), "FINAL_ATTESTATION_EVIDENCE_CANDIDATE_INVALID");
  invariant(
    evidenceCandidate === runtimeCandidateCommit,
    "FINAL_ATTESTATION_EVIDENCE_CANDIDATE_MISMATCH",
  );
  return evidenceCandidate;
}

function validateApprovalTrustMetadata(value, { isSigned }) {
  assertExactKeys(
    value,
    ["trustAnchorId", "trustAnchorSha256", "verificationMode"],
    "FINAL_ATTESTATION_APPROVAL_TRUST",
  );
  if (!isSigned) {
    invariant(value.trustAnchorId === null, "FINAL_ATTESTATION_UNSIGNED_TRUST_ANCHOR_PRESENT");
    invariant(value.trustAnchorSha256 === null, "FINAL_ATTESTATION_UNSIGNED_TRUST_DIGEST_PRESENT");
    invariant(value.verificationMode === "NOT_RUN", "FINAL_ATTESTATION_UNSIGNED_TRUST_MODE_INVALID");
    return;
  }
  invariant(trustAnchorIdPattern.test(value.trustAnchorId), "FINAL_ATTESTATION_TRUST_ANCHOR_ID_INVALID");
  invariant(isDigest(value.trustAnchorSha256), "FINAL_ATTESTATION_TRUST_ANCHOR_DIGEST_INVALID");
  invariant(
    value.verificationMode === "ED25519_DETACHED",
    "FINAL_ATTESTATION_TRUST_VERIFICATION_MODE_INVALID",
  );
}

export function validateApprovalTrustAnchor(anchor, expectedSha256) {
  assertExactKeys(
    anchor,
    ["keys", "recordType", "schemaVersion", "trustAnchorId"],
    "FINAL_ATTESTATION_TRUST_ANCHOR",
  );
  invariant(anchor.schemaVersion === 1, "FINAL_ATTESTATION_TRUST_ANCHOR_SCHEMA_INVALID");
  invariant(
    anchor.recordType === "NOVALURE_RELEASE_APPROVAL_TRUST_ANCHOR",
    "FINAL_ATTESTATION_TRUST_ANCHOR_TYPE_INVALID",
  );
  invariant(trustAnchorIdPattern.test(anchor.trustAnchorId), "FINAL_ATTESTATION_TRUST_ANCHOR_ID_INVALID");
  invariant(isDigest(expectedSha256), "FINAL_ATTESTATION_EXPECTED_TRUST_ANCHOR_DIGEST_REQUIRED");
  invariant(
    Array.isArray(anchor.keys) && anchor.keys.length === trustedAnchorRoles.length,
    "FINAL_ATTESTATION_TRUST_ANCHOR_KEY_COUNT_INVALID",
  );
  const roles = new Set();
  const keyIds = new Set();
  for (const key of anchor.keys) {
    assertExactKeys(
      key,
      ["algorithm", "keyId", "publicKeyPem", "role", "signerSubject", "status"],
      "FINAL_ATTESTATION_TRUST_ANCHOR_KEY",
    );
    invariant(key.algorithm === "Ed25519", "FINAL_ATTESTATION_TRUST_ANCHOR_ALGORITHM_INVALID");
    invariant(approvalKeyIdPattern.test(key.keyId), "FINAL_ATTESTATION_TRUST_ANCHOR_KEY_ID_INVALID");
    invariant(trustedAnchorRoles.includes(key.role), "FINAL_ATTESTATION_TRUST_ANCHOR_ROLE_INVALID");
    invariant(signerSubjectPattern.test(key.signerSubject), "FINAL_ATTESTATION_TRUST_ANCHOR_SUBJECT_INVALID");
    invariant(key.status === "ACTIVE", "FINAL_ATTESTATION_TRUST_ANCHOR_KEY_INACTIVE");
    invariant(
      typeof key.publicKeyPem === "string"
        && key.publicKeyPem.length <= 1_024
        && /^-----BEGIN PUBLIC KEY-----\r?\n(?:[A-Za-z0-9+/]{1,64}={0,2}\r?\n)+-----END PUBLIC KEY-----\r?\n?$/u.test(key.publicKeyPem),
      "FINAL_ATTESTATION_TRUST_ANCHOR_PUBLIC_KEY_INVALID",
    );
    let publicKey;
    try {
      publicKey = createPublicKey(key.publicKeyPem);
    } catch {
      invariant(false, "FINAL_ATTESTATION_TRUST_ANCHOR_PUBLIC_KEY_INVALID");
    }
    invariant(publicKey.asymmetricKeyType === "ed25519", "FINAL_ATTESTATION_TRUST_ANCHOR_KEY_TYPE_INVALID");
    roles.add(key.role);
    keyIds.add(key.keyId);
  }
  invariant(
    roles.size === trustedAnchorRoles.length
      && trustedAnchorRoles.every((role) => roles.has(role)),
    "FINAL_ATTESTATION_TRUST_ANCHOR_ROLES_INCOMPLETE",
  );
  invariant(keyIds.size === trustedAnchorRoles.length, "FINAL_ATTESTATION_TRUST_ANCHOR_KEY_REUSED");
  validateExternalGateTrustContext({ anchor, expectedSha256 }, { requiredRoles: externalGateReceiptRoles });
  return anchor;
}

function approvalReference({ documentBundleSha256, keyId, role, trustAnchorId }) {
  return `urn:novalure:release-approval:v2:${trustAnchorId}:${keyId}:${role}:${documentBundleSha256}`;
}

export function buildExternalApprovalSigningPayload(value) {
  return canonicalJson({
    acceptedRiskReferences: value.acceptedRiskReferences,
    approvalScopes: value.approvalScopes,
    candidateCommit: value.candidateCommit,
    decision: value.decision,
    deploymentId: value.deploymentId,
    documentBundleSha256: value.documentBundleSha256,
    keyId: value.keyId,
    name: value.name,
    recordType: "NOVALURE_EXTERNAL_RELEASE_APPROVAL",
    role: value.role,
    schemaVersion: 2,
    signatureAlgorithm: value.signatureAlgorithm,
    signatureReference: value.signatureReference,
    signedAt: value.signedAt,
    signerSubject: value.signerSubject,
    trustAnchorId: value.trustAnchorId,
  });
}

function validateSignature(
  signature,
  runtime,
  documentBundleSha256,
  decision,
  role,
  trustContext,
  evidenceProvenance,
) {
  assertExactKeys(signature, [
    "acceptedRiskReferences",
    "approvalScopes",
    "approvalArtifactPath",
    "approvalArtifactSha256",
    "approvalArtifactSidecarPath",
    "candidateCommit",
    "decision",
    "detachedSignature",
    "deploymentId",
    "documentBundleSha256",
    "keyId",
    "name",
    "role",
    "signatureAlgorithm",
    "signatureReference",
    "signerSubject",
    "signedAt",
    "trustAnchorId",
  ], `FINAL_ATTESTATION_SIGNATURE_${role.toUpperCase()}`);
  invariant(typeof signature.name === "string" && signature.name.trim(), "FINAL_ATTESTATION_SIGNATURE_NAME_INVALID");
  invariant(signature.role === role, "FINAL_ATTESTATION_SIGNATURE_ROLE_INVALID");
  invariant(isIsoTimestamp(signature.signedAt), "FINAL_ATTESTATION_SIGNATURE_TIME_INVALID");
  invariant(
    Date.parse(signature.signedAt) >= Date.parse(runtime.completedAt),
    "FINAL_ATTESTATION_SIGNATURE_PREDATES_EVIDENCE",
  );
  invariant(signature.candidateCommit === runtime.candidateCommit, "FINAL_ATTESTATION_SIGNATURE_CANDIDATE_MISMATCH");
  invariant(signature.deploymentId === runtime.deploymentId, "FINAL_ATTESTATION_SIGNATURE_DEPLOYMENT_MISMATCH");
  invariant(signature.decision === decision, "FINAL_ATTESTATION_SIGNATURE_DECISION_MISMATCH");
  invariant(
    signature.documentBundleSha256 === documentBundleSha256,
    "FINAL_ATTESTATION_SIGNATURE_BUNDLE_MISMATCH",
  );
  invariant(
    Array.isArray(signature.acceptedRiskReferences)
      && signature.acceptedRiskReferences.every((entry) => typeof entry === "string" && entry.trim())
      && new Set(signature.acceptedRiskReferences).size === signature.acceptedRiskReferences.length,
    "FINAL_ATTESTATION_SIGNATURE_RISKS_INVALID",
  );
  invariant(
    Array.isArray(signature.approvalScopes)
      && signature.approvalScopes.length === requiredApprovalScopesByRole[role].length
      && signature.approvalScopes.every((scope, index) => scope === requiredApprovalScopesByRole[role][index]),
    "FINAL_ATTESTATION_SIGNATURE_SCOPES_INVALID",
  );
  assertRepositoryRelativePath(signature.approvalArtifactPath, "FINAL_ATTESTATION_SIGNATURE_ARTIFACT_PATH_INVALID");
  assertRepositoryRelativePath(signature.approvalArtifactSidecarPath, "FINAL_ATTESTATION_SIGNATURE_ARTIFACT_SIDECAR_INVALID");
  invariant(
    signature.approvalArtifactPath.endsWith(".json"),
    "FINAL_ATTESTATION_SIGNATURE_ARTIFACT_TYPE_INVALID",
  );
  invariant(
    signature.approvalArtifactSidecarPath === `${signature.approvalArtifactPath}.sha256`,
    "FINAL_ATTESTATION_SIGNATURE_ARTIFACT_SIDECAR_MISMATCH",
  );
  invariant(
    signature.approvalArtifactPath === `${evidenceProvenance.runDirectory}/approvals/${role}.json`,
    "FINAL_ATTESTATION_SIGNATURE_ARTIFACT_RUN_PATH_INVALID",
  );
  invariant(isDigest(signature.approvalArtifactSha256), "FINAL_ATTESTATION_SIGNATURE_ARTIFACT_DIGEST_INVALID");
  invariant(signature.signatureAlgorithm === "Ed25519", "FINAL_ATTESTATION_SIGNATURE_ALGORITHM_INVALID");
  invariant(approvalKeyIdPattern.test(signature.keyId), "FINAL_ATTESTATION_SIGNATURE_KEY_ID_INVALID");
  invariant(signerSubjectPattern.test(signature.signerSubject), "FINAL_ATTESTATION_SIGNATURE_SUBJECT_INVALID");
  invariant(trustAnchorIdPattern.test(signature.trustAnchorId), "FINAL_ATTESTATION_SIGNATURE_TRUST_ANCHOR_INVALID");
  invariant(
    signature.signatureReference === approvalReference({
      documentBundleSha256,
      keyId: signature.keyId,
      role,
      trustAnchorId: signature.trustAnchorId,
    }),
    "FINAL_ATTESTATION_SIGNATURE_REFERENCE_INVALID",
  );
  invariant(isPlainObject(trustContext), "FINAL_ATTESTATION_TRUST_CONTEXT_REQUIRED");
  const { anchor, expectedSha256 } = trustContext;
  validateApprovalTrustAnchor(anchor, expectedSha256);
  invariant(signature.trustAnchorId === anchor.trustAnchorId, "FINAL_ATTESTATION_SIGNATURE_TRUST_ANCHOR_MISMATCH");
  const trustedKey = anchor.keys.find((key) => key.role === role);
  invariant(trustedKey, "FINAL_ATTESTATION_SIGNATURE_TRUSTED_KEY_MISSING");
  invariant(signature.keyId === trustedKey.keyId, "FINAL_ATTESTATION_SIGNATURE_KEY_MISMATCH");
  invariant(signature.signerSubject === trustedKey.signerSubject, "FINAL_ATTESTATION_SIGNATURE_SUBJECT_MISMATCH");
  invariant(
    typeof signature.detachedSignature === "string"
      && /^[A-Za-z0-9+/]{86}==$/u.test(signature.detachedSignature),
    "FINAL_ATTESTATION_SIGNATURE_VALUE_INVALID",
  );
  const signatureBytes = Buffer.from(signature.detachedSignature, "base64");
  invariant(
    signatureBytes.byteLength === 64
      && signatureBytes.toString("base64") === signature.detachedSignature,
    "FINAL_ATTESTATION_SIGNATURE_VALUE_INVALID",
  );
  invariant(
    verifyDetachedSignature(
      null,
      Buffer.from(buildExternalApprovalSigningPayload(signature), "utf8"),
      createPublicKey(trustedKey.publicKeyPem),
      signatureBytes,
    ),
    "FINAL_ATTESTATION_SIGNATURE_CRYPTOGRAPHIC_VERIFICATION_FAILED",
  );
}

function validateRuntime(runtime, isPending) {
  assertExactKeys(runtime, [
    "branch",
    "candidateCommit",
    "completedAt",
    "databaseBranchId",
    "deploymentHost",
    "deploymentId",
    "environment",
    "productionMutationPerformed",
    "shaIdentityStatus",
    "startedAt",
    "trustedHarnessSha",
  ], "FINAL_ATTESTATION_RUNTIME");
  invariant(typeof runtime.branch === "string" && runtime.branch.startsWith("codex/"), "FINAL_ATTESTATION_BRANCH_INVALID");
  invariant(runtime.environment === "PREVIEW", "FINAL_ATTESTATION_ENVIRONMENT_INVALID");
  invariant(runtime.productionMutationPerformed === false, "FINAL_ATTESTATION_PRODUCTION_MUTATION_RECORDED");
  if (isPending) {
    invariant(runtime.candidateCommit === null, "FINAL_ATTESTATION_PENDING_CANDIDATE_PRESENT");
    invariant(runtime.databaseBranchId === null, "FINAL_ATTESTATION_PENDING_DATABASE_BRANCH_PRESENT");
    invariant(runtime.deploymentId === null, "FINAL_ATTESTATION_PENDING_DEPLOYMENT_PRESENT");
    invariant(runtime.deploymentHost === null, "FINAL_ATTESTATION_PENDING_HOST_PRESENT");
    invariant(runtime.trustedHarnessSha === null, "FINAL_ATTESTATION_PENDING_TRUSTED_HARNESS_PRESENT");
    invariant(runtime.shaIdentityStatus === "NOT_RUN", "FINAL_ATTESTATION_PENDING_SHA_STATUS_INVALID");
    invariant(runtime.startedAt === null && runtime.completedAt === null, "FINAL_ATTESTATION_PENDING_TIME_PRESENT");
    return;
  }
  invariant(isCommitSha(runtime.candidateCommit), "FINAL_ATTESTATION_RUNTIME_CANDIDATE_INVALID");
  invariant(isCommitSha(runtime.trustedHarnessSha), "FINAL_ATTESTATION_TRUSTED_HARNESS_INVALID");
  invariant(
    /^br-[A-Za-z0-9-]{8,128}$/u.test(runtime.databaseBranchId),
    "FINAL_ATTESTATION_DATABASE_BRANCH_INVALID",
  );
  invariant(/^dpl_[A-Za-z0-9]{20,80}$/u.test(runtime.deploymentId), "FINAL_ATTESTATION_DEPLOYMENT_ID_INVALID");
  invariant(
    typeof runtime.deploymentHost === "string"
      && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.vercel\.app$/u.test(runtime.deploymentHost),
    "FINAL_ATTESTATION_DEPLOYMENT_HOST_INVALID",
  );
  invariant(runtime.shaIdentityStatus === "PASS", "FINAL_ATTESTATION_SHA_IDENTITY_NOT_PASS");
  invariant(isIsoTimestamp(runtime.startedAt), "FINAL_ATTESTATION_START_TIME_INVALID");
  invariant(isIsoTimestamp(runtime.completedAt), "FINAL_ATTESTATION_END_TIME_INVALID");
  invariant(Date.parse(runtime.completedAt) >= Date.parse(runtime.startedAt), "FINAL_ATTESTATION_TIME_ORDER_INVALID");
}

export function validateEvidenceProvenance(value, isPending) {
  assertExactKeys(
    value,
    ["evidenceCommit", "repositoryState", "runDirectory", "runId"],
    "FINAL_ATTESTATION_EVIDENCE_PROVENANCE",
  );
  if (isPending) {
    invariant(value.evidenceCommit === null, "FINAL_ATTESTATION_PENDING_EVIDENCE_COMMIT_PRESENT");
    invariant(value.repositoryState === "NOT_RUN", "FINAL_ATTESTATION_PENDING_REPOSITORY_STATE_INVALID");
    invariant(value.runDirectory === null, "FINAL_ATTESTATION_PENDING_RUN_DIRECTORY_PRESENT");
    invariant(value.runId === null, "FINAL_ATTESTATION_PENDING_RUN_ID_PRESENT");
    return value;
  }
  invariant(isCommitSha(value.evidenceCommit), "FINAL_ATTESTATION_EVIDENCE_COMMIT_INVALID");
  invariant(value.repositoryState === "CLEAN_TRACKED", "FINAL_ATTESTATION_REPOSITORY_STATE_NOT_CLEAN_TRACKED");
  invariant(evidenceRunIdPattern.test(value.runId), "FINAL_ATTESTATION_RUN_ID_INVALID");
  invariant(
    value.runDirectory === `${evidenceRunRoot}/${value.runId}`,
    "FINAL_ATTESTATION_RUN_DIRECTORY_INVALID",
  );
  return value;
}

function expectedGateEvidencePath(provenance, binding) {
  invariant(isPlainObject(provenance), "FINAL_ATTESTATION_EVIDENCE_PROVENANCE_REQUIRED");
  invariant(typeof binding?.fileName === "string", "FINAL_ATTESTATION_GATE_FILENAME_MISSING");
  return `${provenance.runDirectory}/${binding.fileName}`;
}

function validateDocumentBindings(documents, isPending) {
  invariant(Array.isArray(documents), "FINAL_ATTESTATION_DOCUMENTS_INVALID");
  invariant(documents.length === finalPreviewDocumentBindings.length, "FINAL_ATTESTATION_DOCUMENT_COUNT_INVALID");
  documents.forEach((binding, index) => {
    assertExactKeys(binding, [
      "candidateJsonPointer",
      "id",
      "path",
      "sha256",
      "sidecarPath",
      "verificationStatus",
    ], "FINAL_ATTESTATION_DOCUMENT");
    const expected = finalPreviewDocumentBindings[index];
    invariant(binding.id === expected.id, "FINAL_ATTESTATION_DOCUMENT_ID_INVALID");
    invariant(binding.path === expected.path, "FINAL_ATTESTATION_DOCUMENT_PATH_INVALID");
    invariant(binding.sidecarPath === expected.sidecarPath, "FINAL_ATTESTATION_DOCUMENT_SIDECAR_PATH_INVALID");
    invariant(
      binding.candidateJsonPointer === expected.candidateJsonPointer,
      "FINAL_ATTESTATION_DOCUMENT_CANDIDATE_POINTER_INVALID",
    );
    if (isPending) {
      invariant(binding.sha256 === null, "FINAL_ATTESTATION_PENDING_DOCUMENT_DIGEST_PRESENT");
      invariant(binding.verificationStatus === "NOT_RUN", "FINAL_ATTESTATION_PENDING_DOCUMENT_STATUS_INVALID");
    } else {
      invariant(isDigest(binding.sha256), "FINAL_ATTESTATION_DOCUMENT_DIGEST_INVALID");
      invariant(binding.verificationStatus === "PASS", "FINAL_ATTESTATION_DOCUMENT_NOT_VERIFIED");
    }
  });
}

function validateGateEvidence(gateEvidence, isPending, evidenceProvenance) {
  invariant(Array.isArray(gateEvidence), "FINAL_ATTESTATION_GATE_EVIDENCE_INVALID");
  invariant(gateEvidence.length === finalPreviewGateIds.length, "FINAL_ATTESTATION_GATE_COUNT_INVALID");
  gateEvidence.forEach((entry, index) => {
    assertExactKeys(entry, [
      "candidateJsonPointer",
      "id",
      "path",
      "requiredForGo",
      "sha256",
      "sidecarPath",
      "status",
      "statusJsonPointer",
    ], "FINAL_ATTESTATION_GATE");
    invariant(entry.id === finalPreviewGateIds[index], "FINAL_ATTESTATION_GATE_ID_INVALID");
    const expectedBinding = finalPreviewGateBindings[index];
    invariant(entry.requiredForGo === true, "FINAL_ATTESTATION_GATE_REQUIRED_FLAG_INVALID");
    invariant(evidenceStatuses.has(entry.status), "FINAL_ATTESTATION_GATE_STATUS_INVALID");
    if (isPending || entry.status === "NOT_RUN") {
      invariant(entry.status === "NOT_RUN", "FINAL_ATTESTATION_PENDING_GATE_STATUS_INVALID");
      invariant(
        entry.path === null
          && entry.sidecarPath === null
          && entry.sha256 === null
          && entry.candidateJsonPointer === null
          && entry.statusJsonPointer === null,
        "FINAL_ATTESTATION_NOT_RUN_GATE_CLAIMS_EVIDENCE",
      );
      return;
    }
    assertRepositoryRelativePath(entry.path, "FINAL_ATTESTATION_GATE_PATH_INVALID");
    assertRepositoryRelativePath(entry.sidecarPath, "FINAL_ATTESTATION_GATE_SIDECAR_PATH_INVALID");
    const expectedPath = expectedGateEvidencePath(evidenceProvenance, expectedBinding);
    invariant(entry.path === expectedPath, "FINAL_ATTESTATION_GATE_PATH_MAPPING_INVALID");
    invariant(entry.sidecarPath === `${expectedPath}.sha256`, "FINAL_ATTESTATION_GATE_SIDECAR_MAPPING_INVALID");
    invariant(isDigest(entry.sha256), "FINAL_ATTESTATION_GATE_DIGEST_INVALID");
    invariant(
      entry.candidateJsonPointer === expectedBinding.candidateJsonPointer,
      "FINAL_ATTESTATION_GATE_CANDIDATE_POINTER_INVALID",
    );
    invariant(
      entry.statusJsonPointer === expectedBinding.statusJsonPointer,
      "FINAL_ATTESTATION_GATE_STATUS_POINTER_INVALID",
    );
  });
  const evidencePaths = gateEvidence.filter((entry) => entry.status !== "NOT_RUN").map((entry) => entry.path);
  invariant(new Set(evidencePaths).size === evidencePaths.length, "FINAL_ATTESTATION_GATE_PATH_REUSED");
}

export function validateFinalPreviewReleaseAttestation(attestation, { trustContext = null } = {}) {
  assertExactKeys(attestation, [
    "approvalTrust",
    "decision",
    "documentBundleSha256",
    "documents",
    "evidenceProvenance",
    "gateEvidence",
    "recordType",
    "runtime",
    "schemaPath",
    "schemaVersion",
    "signatures",
    "status",
  ], "FINAL_ATTESTATION");
  invariant(attestation.schemaVersion === 2, "FINAL_ATTESTATION_SCHEMA_UNSUPPORTED");
  invariant(attestation.recordType === "FINAL_PREVIEW_RELEASE_ATTESTATION", "FINAL_ATTESTATION_RECORD_TYPE_INVALID");
  invariant(
    attestation.schemaPath === "docs/audit/2026-08-23/final-preview-release-attestation.schema.json",
    "FINAL_ATTESTATION_SCHEMA_PATH_INVALID",
  );
  invariant(attestationStatuses.has(attestation.status), "FINAL_ATTESTATION_STATUS_INVALID");
  invariant(decisions.has(attestation.decision), "FINAL_ATTESTATION_DECISION_INVALID");
  const isPending = attestation.status === "PENDING";
  validateRuntime(attestation.runtime, isPending);
  validateEvidenceProvenance(attestation.evidenceProvenance, isPending);
  validateDocumentBindings(attestation.documents, isPending);
  validateGateEvidence(attestation.gateEvidence, isPending, attestation.evidenceProvenance);
  assertExactKeys(attestation.signatures, signatureRoles, "FINAL_ATTESTATION_SIGNATURES");
  validateApprovalTrustMetadata(attestation.approvalTrust, {
    isSigned: attestation.status === "SIGNED",
  });

  if (isPending) {
    invariant(attestation.decision === "NO-GO", "FINAL_ATTESTATION_PENDING_DECISION_INVALID");
    invariant(attestation.documentBundleSha256 === null, "FINAL_ATTESTATION_PENDING_BUNDLE_PRESENT");
    invariant(
      signatureRoles.every((role) => attestation.signatures[role] === null),
      "FINAL_ATTESTATION_PENDING_SIGNATURE_PRESENT",
    );
  } else {
    invariant(isDigest(attestation.documentBundleSha256), "FINAL_ATTESTATION_BUNDLE_DIGEST_INVALID");
    if (attestation.status === "EVIDENCE_FROZEN") {
      invariant(
        signatureRoles.every((role) => attestation.signatures[role] === null),
        "FINAL_ATTESTATION_FROZEN_SIGNATURE_PRESENT",
      );
    } else {
      invariant(isPlainObject(trustContext), "FINAL_ATTESTATION_TRUST_CONTEXT_REQUIRED");
      invariant(
        attestation.approvalTrust.trustAnchorId === trustContext.anchor?.trustAnchorId,
        "FINAL_ATTESTATION_TRUST_ANCHOR_ID_MISMATCH",
      );
      invariant(
        attestation.approvalTrust.trustAnchorSha256 === trustContext.expectedSha256,
        "FINAL_ATTESTATION_TRUST_ANCHOR_DIGEST_MISMATCH",
      );
      signatureRoles.forEach((role) => {
        validateSignature(
          attestation.signatures[role],
          attestation.runtime,
          attestation.documentBundleSha256,
          attestation.decision,
          role,
          trustContext,
          attestation.evidenceProvenance,
        );
      });
      const signatureValues = signatureRoles.map((role) => attestation.signatures[role]);
      invariant(
        new Set(signatureValues.map((signature) => signature.approvalArtifactPath)).size === signatureRoles.length,
        "FINAL_ATTESTATION_SIGNATURE_ARTIFACT_REUSED",
      );
      invariant(
        new Set(signatureValues.map((signature) => signature.signatureReference)).size === signatureRoles.length,
        "FINAL_ATTESTATION_SIGNATURE_REFERENCE_REUSED",
      );
    }
    if (attestation.decision === "GO") {
      invariant(attestation.status === "SIGNED", "FINAL_ATTESTATION_GO_NOT_SIGNED");
      invariant(
        attestation.gateEvidence.every((entry) => entry.status === "PASS"),
        "FINAL_ATTESTATION_GO_WITH_NON_PASS_GATE",
      );
    }
  }

  scanForSecretMaterial(JSON.stringify(attestation));
  return attestation;
}

export function buildFinalPreviewDocumentBundleSha256(attestation) {
  assertExactKeys(attestation, [
    "approvalTrust",
    "decision",
    "documentBundleSha256",
    "documents",
    "evidenceProvenance",
    "gateEvidence",
    "recordType",
    "runtime",
    "schemaPath",
    "schemaVersion",
    "signatures",
    "status",
  ], "FINAL_ATTESTATION_BUNDLE_INPUT");
  invariant(attestation.schemaVersion === 2, "FINAL_ATTESTATION_SCHEMA_UNSUPPORTED");
  invariant(attestation.recordType === "FINAL_PREVIEW_RELEASE_ATTESTATION", "FINAL_ATTESTATION_RECORD_TYPE_INVALID");
  invariant(
    attestation.schemaPath === "docs/audit/2026-08-23/final-preview-release-attestation.schema.json",
    "FINAL_ATTESTATION_SCHEMA_PATH_INVALID",
  );
  invariant(attestationStatuses.has(attestation.status), "FINAL_ATTESTATION_STATUS_INVALID");
  invariant(decisions.has(attestation.decision), "FINAL_ATTESTATION_DECISION_INVALID");
  invariant(attestation.status !== "PENDING", "FINAL_ATTESTATION_PENDING_BUNDLE_UNAVAILABLE");
  validateRuntime(attestation.runtime, false);
  validateEvidenceProvenance(attestation.evidenceProvenance, false);
  validateDocumentBindings(attestation.documents, false);
  validateGateEvidence(attestation.gateEvidence, false, attestation.evidenceProvenance);
  assertExactKeys(attestation.signatures, signatureRoles, "FINAL_ATTESTATION_SIGNATURES");
  scanForSecretMaterial(JSON.stringify(attestation));
  return sha256(JSON.stringify(canonicalize({
    approvalTrust: attestation.approvalTrust,
    decision: attestation.decision,
    documents: attestation.documents,
    evidenceProvenance: attestation.evidenceProvenance,
    gateEvidence: attestation.gateEvidence,
    recordType: attestation.recordType,
    runtime: attestation.runtime,
    schemaPath: attestation.schemaPath,
    schemaVersion: attestation.schemaVersion,
  })));
}

export function validateReleaseDocumentCandidateState({
  attestation,
  companyProfileApproval,
  legalContentManifest,
  releaseGateMatrix,
  releaseSurfaceManifest,
  trustContext = null,
}) {
  validateFinalPreviewReleaseAttestation(attestation, { trustContext });
  const releaseDocuments = [releaseSurfaceManifest, releaseGateMatrix, legalContentManifest];
  if (attestation.status === "PENDING") {
    invariant(
      releaseDocuments.every((document) => document?.candidateCommit === null)
        && (companyProfileApproval === undefined || companyProfileApproval?.candidateCommit === null),
      "FINAL_ATTESTATION_PENDING_RELEASE_DOCUMENT_CANDIDATE_PRESENT",
    );
    return Object.freeze({ candidateCommit: null, status: attestation.status });
  }
  invariant(
    isPlainObject(companyProfileApproval),
    "FINAL_ATTESTATION_COMPANY_PROFILE_DOCUMENT_REQUIRED",
  );
  const documents = [...releaseDocuments, companyProfileApproval];
  for (const document of documents) {
    assertEvidenceCandidateBinding({
      candidateJsonPointer: "/candidateCommit",
      evidenceDocument: document,
      runtimeCandidateCommit: attestation.runtime.candidateCommit,
    });
  }
  invariant(
    releaseSurfaceManifest.baselineCommit === releaseGateMatrix.baselineCommit,
    "FINAL_ATTESTATION_RELEASE_BASELINE_MISMATCH",
  );
  if (attestation.decision === "GO") {
    invariant(
      releaseSurfaceManifest.approvalStatus === "SIGNED",
      "FINAL_ATTESTATION_RELEASE_SURFACE_NOT_SIGNED",
    );
    invariant(
      releaseGateMatrix.approvalStatus === "READY_FOR_EXTERNAL_SIGNATURE",
      "FINAL_ATTESTATION_RELEASE_MATRIX_NOT_READY_FOR_SIGNATURE",
    );
    assertExactKeys(
      releaseGateMatrix.signatures,
      signatureRoles,
      "FINAL_ATTESTATION_RELEASE_MATRIX_SIGNATURES",
    );
    invariant(
      signatureRoles.every((role) => releaseGateMatrix.signatures[role] === null),
      "FINAL_ATTESTATION_RELEASE_MATRIX_EMBEDDED_SIGNATURE_FORBIDDEN",
    );
    const desiredByDecision = {
      [launchScopeDecisions.internalOnly]: "INTERNAL",
      [launchScopeDecisions.off]: "OFF",
      [launchScopeDecisions.on]: "ON",
    };
    invariant(
      releaseGateMatrix.launchScopePolicyVersion === launchScopePolicyVersion,
      "FINAL_ATTESTATION_RELEASE_MATRIX_POLICY_VERSION_MISMATCH",
    );
    invariant(
      Array.isArray(releaseGateMatrix.surfaces) && releaseGateMatrix.surfaces.length > 0,
      "FINAL_ATTESTATION_RELEASE_MATRIX_SURFACES_REQUIRED",
    );
    const surfaceIds = releaseGateMatrix.surfaces.map((surface) => surface?.id);
    invariant(
      surfaceIds.every((id) => typeof id === "string" && /^[a-z0-9][a-z0-9.-]+$/u.test(id))
        && new Set(surfaceIds).size === surfaceIds.length,
      "FINAL_ATTESTATION_RELEASE_MATRIX_SURFACE_IDS_INVALID",
    );
    const scopeSurfaces = releaseGateMatrix.surfaces.filter((surface) => surface?.launchScopeKey !== null);
    const scopeKeys = scopeSurfaces.map((surface) => surface?.launchScopeKey);
    const expectedScopeKeys = Object.keys(launchScopePolicy);
    invariant(
      new Set(scopeKeys).size === scopeKeys.length
        && scopeKeys.length === expectedScopeKeys.length
        && expectedScopeKeys.every((key) => scopeKeys.includes(key)),
      "FINAL_ATTESTATION_RELEASE_MATRIX_SCOPE_INVENTORY_INVALID",
    );
    for (const surface of releaseGateMatrix.surfaces) {
      invariant(
        ["ON", "OFF", "INTERNAL"].includes(surface.desiredLaunchStatus),
        "FINAL_ATTESTATION_RELEASE_MATRIX_LAUNCH_STATUS_INVALID",
      );
      if (surface.launchScopeKey === null) {
        invariant(
          typeof surface.launchScopeNotApplicableReason === "string"
            && surface.launchScopeNotApplicableReason.trim().length > 0,
          "FINAL_ATTESTATION_RELEASE_MATRIX_SCOPE_REASON_MISSING",
        );
      } else {
        invariant(
          surface.launchScopeNotApplicableReason === null
            && Object.hasOwn(launchScopePolicy, surface.launchScopeKey)
            && surface.desiredLaunchStatus === desiredByDecision[launchScopePolicy[surface.launchScopeKey].decision],
          "FINAL_ATTESTATION_RELEASE_MATRIX_POLICY_DRIFT",
        );
      }
    }
    invariant(
      Array.isArray(releaseGateMatrix.surfaces)
        && releaseGateMatrix.surfaces.length > 0
        && releaseGateMatrix.surfaces.every((surface) =>
          isPlainObject(surface?.owners)
          && ["technical", "product", "legal"].every((role) =>
            typeof surface.owners[role] === "string"
            && surface.owners[role].trim()
            && surface.owners[role] !== "UNASSIGNED")),
      "FINAL_ATTESTATION_RELEASE_SURFACE_OWNER_UNASSIGNED",
    );
    const relationshipDecision = releaseGateMatrix.specialDecisions?.unitBuyerDealRelationship;
    invariant(
      isPlainObject(relationshipDecision)
        && relationshipDecision.decision === "OFF"
        && relationshipDecision.status === "READY_FOR_EXTERNAL_SIGNATURE"
        && isPlainObject(relationshipDecision.requiredSignatures),
      "FINAL_ATTESTATION_RELATIONSHIP_DECISION_NOT_READY_FOR_SIGNATURE",
    );
    assertExactKeys(
      relationshipDecision.requiredSignatures,
      Object.values(relationshipApprovalRoles),
      "FINAL_ATTESTATION_RELATIONSHIP_SIGNATURES",
    );
    invariant(
      Object.values(relationshipApprovalRoles).every((matrixKey) =>
        relationshipDecision.requiredSignatures[matrixKey] === null),
      "FINAL_ATTESTATION_RELATIONSHIP_EMBEDDED_SIGNATURE_FORBIDDEN",
    );
    invariant(
      Object.keys(relationshipApprovalRoles).every((role) =>
        attestation.signatures[role].approvalScopes.includes("UNIT_BUYER_DEAL")),
      "FINAL_ATTESTATION_RELATIONSHIP_APPROVAL_SCOPE_MISSING",
    );

    const expectedPreviewOrigin = `https://${attestation.runtime.deploymentHost}`;
    invariant(
      legalContentManifest.approvalStatus === "APPROVED",
      "FINAL_ATTESTATION_LEGAL_MANIFEST_NOT_APPROVED",
    );
    invariant(
      legalContentManifest.testedDeployment === attestation.runtime.deploymentId
        || legalContentManifest.testedDeployment === expectedPreviewOrigin,
      "FINAL_ATTESTATION_LEGAL_DEPLOYMENT_MISMATCH",
    );
    invariant(
      Array.isArray(legalContentManifest.pages) && legalContentManifest.pages.length > 0,
      "FINAL_ATTESTATION_LEGAL_PAGES_MISSING",
    );
    invariant(
      legalContentManifest.schemaVersion === 2
        && legalContentManifest.sharedFacts?.path === "src/lib/legal.ts"
        && isDigest(legalContentManifest.sharedFacts?.sha256),
      "FINAL_ATTESTATION_LEGAL_MANIFEST_CONTRACT_INVALID",
    );
    assertExactStringInventory(
      legalContentManifest.pages.map((page) => page?.route),
      requiredLegalPageRoutes,
      "FINAL_ATTESTATION_LEGAL_PAGE_ROUTE_INVENTORY",
    );
    for (const page of legalContentManifest.pages) {
      assertExactStringInventory(
        page.languages,
        requiredLegalLanguages,
        "FINAL_ATTESTATION_LEGAL_LANGUAGE_INVENTORY",
      );
      invariant(
        Array.isArray(page.sourceFiles) && page.sourceFiles.length > 0,
        "FINAL_ATTESTATION_LEGAL_PAGE_SOURCES_MISSING",
      );
      invariant(
        Array.isArray(page.renderedVariants) && page.renderedVariants.length > 0,
        "FINAL_ATTESTATION_LEGAL_VARIANTS_MISSING",
      );
      assertExactStringInventory(
        page.renderedVariants.map((variant) => variant?.language),
        requiredLegalLanguages,
        "FINAL_ATTESTATION_LEGAL_VARIANT_LANGUAGE_INVENTORY",
      );
      for (const variant of page.renderedVariants) {
        invariant(
          variant.path === `${page.route}?lang=${variant.language}`,
          "FINAL_ATTESTATION_LEGAL_VARIANT_PATH_INVALID",
        );
        invariant(variant.renderStatus === "VERIFIED", "FINAL_ATTESTATION_LEGAL_RENDER_NOT_VERIFIED");
        invariant(variant.legalStatus === "APPROVED", "FINAL_ATTESTATION_LEGAL_VARIANT_NOT_APPROVED");
        invariant(
          typeof variant.legalOwner === "string" && variant.legalOwner.trim(),
          "FINAL_ATTESTATION_LEGAL_OWNER_MISSING",
        );
        invariant(isIsoTimestamp(variant.approvedAt), "FINAL_ATTESTATION_LEGAL_APPROVAL_TIME_INVALID");
        invariant(isDigest(variant.renderedContentSha256), "FINAL_ATTESTATION_LEGAL_RENDER_DIGEST_INVALID");
        invariant(
          variant.testedUrl === `${expectedPreviewOrigin}${variant.path}`,
          "FINAL_ATTESTATION_LEGAL_TESTED_URL_MISMATCH",
        );
      }
    }
    assertExactStringInventory(
      legalContentManifest.routeAliases?.map((entry) => entry?.route),
      ["/datadeletion"],
      "FINAL_ATTESTATION_LEGAL_ALIAS_INVENTORY",
    );
    const dataDeletionAlias = legalContentManifest.routeAliases[0];
    invariant(
      dataDeletionAlias.canonicalRoute === "/data-deletion"
        && dataDeletionAlias.technicalStatus === "VERIFIED_ALIAS"
        && Array.isArray(dataDeletionAlias.sourceFiles)
        && dataDeletionAlias.sourceFiles.length > 0,
      "FINAL_ATTESTATION_LEGAL_ALIAS_CONTRACT_INVALID",
    );
    assertExactStringInventory(
      legalContentManifest.functionalContracts?.map((entry) => entry?.id),
      ["unsubscribe-confirm"],
      "FINAL_ATTESTATION_LEGAL_FUNCTIONAL_CONTRACT_INVENTORY",
    );
    const unsubscribeConfirm = legalContentManifest.functionalContracts[0];
    assertExactStringInventory(
      unsubscribeConfirm.methods,
      ["POST"],
      "FINAL_ATTESTATION_LEGAL_FUNCTIONAL_METHOD_INVENTORY",
    );
    invariant(
      unsubscribeConfirm.route === "/unsubscribe/confirm"
        && unsubscribeConfirm.technicalStatus === "VERIFIED_BY_SECURITY_TESTS"
        && Array.isArray(unsubscribeConfirm.sourceFiles)
        && unsubscribeConfirm.sourceFiles.length > 0,
      "FINAL_ATTESTATION_LEGAL_FUNCTIONAL_CONTRACT_INVALID",
    );
    for (const entry of [dataDeletionAlias, unsubscribeConfirm]) {
      invariant(entry.legalStatus === "APPROVED", "FINAL_ATTESTATION_LEGAL_CONTRACT_NOT_APPROVED");
      invariant(
        typeof entry.legalOwner === "string" && entry.legalOwner.trim(),
        "FINAL_ATTESTATION_LEGAL_OWNER_MISSING",
      );
      invariant(isIsoTimestamp(entry.approvedAt), "FINAL_ATTESTATION_LEGAL_APPROVAL_TIME_INVALID");
    }
    assertExactKeys(companyProfileApproval, [
      "approvalReceipt",
      "candidateCommit",
      "deploymentId",
      "productionMutationPerformed",
      "profileSnapshot",
      "recordType",
      "schemaVersion",
    ], "FINAL_ATTESTATION_COMPANY_PROFILE_DOCUMENT");
    invariant(
      companyProfileApproval.schemaVersion === 1
        && companyProfileApproval.recordType === "NOVALURE_COMPANY_PROFILE_APPROVAL_DOCUMENT"
        && companyProfileApproval.candidateCommit === attestation.runtime.candidateCommit
        && companyProfileApproval.deploymentId === attestation.runtime.deploymentId
        && companyProfileApproval.productionMutationPerformed === false,
      "FINAL_ATTESTATION_COMPANY_PROFILE_DOCUMENT_BINDING_INVALID",
    );
    validateCompanyProfileApprovalReceipt({
      profileSnapshot: companyProfileApproval.profileSnapshot,
      receipt: companyProfileApproval.approvalReceipt,
      runtime: {
        candidateCommit: attestation.runtime.candidateCommit,
        databaseBranchId: attestation.runtime.databaseBranchId,
        deploymentHost: attestation.runtime.deploymentHost,
        deploymentId: attestation.runtime.deploymentId,
        gitBranch: attestation.runtime.branch,
        productionMutationPerformed: false,
      },
      trustContext,
    });
  }
  return Object.freeze({
    candidateCommit: attestation.runtime.candidateCommit,
    status: attestation.status,
  });
}

function assertExactStringInventory(values, expected, code) {
  invariant(Array.isArray(values) && values.length === expected.length, `${code}_COUNT_INVALID`);
  invariant(values.every((value) => typeof value === "string"), `${code}_VALUE_INVALID`);
  invariant(new Set(values).size === values.length, `${code}_DUPLICATE`);
  const actualSorted = [...values].sort();
  const expectedSorted = [...expected].sort();
  invariant(
    actualSorted.every((value, index) => value === expectedSorted[index]),
    `${code}_MISMATCH`,
  );
}

function assertGateRuntimeIdentity(identity, runtime, code, { observed = false } = {}) {
  invariant(isPlainObject(identity), `${code}_RUNTIME_IDENTITY_INVALID`);
  const hostKey = observed ? "host" : "deploymentHost";
  invariant(identity.deploymentId === runtime.deploymentId, `${code}_DEPLOYMENT_ID_MISMATCH`);
  invariant(identity[hostKey] === runtime.deploymentHost, `${code}_DEPLOYMENT_HOST_MISMATCH`);
  invariant(identity.gitBranch === runtime.branch, `${code}_GIT_BRANCH_MISMATCH`);
  invariant(identity.gitSha === runtime.candidateCommit, `${code}_GIT_SHA_MISMATCH`);
  invariant(
    identity.databaseBranchId === runtime.databaseBranchId,
    `${code}_DATABASE_BRANCH_MISMATCH`,
  );
}

function assertTwoTenantPass(document, runtime, {
  protectedWorkflowVerification = null,
  trustContext = null,
} = {}) {
  invariant(document.mode === "execute", "FINAL_ATTESTATION_TWO_TENANT_MODE_INVALID");
  invariant(document.productionMutationPerformed === false, "FINAL_ATTESTATION_TWO_TENANT_PRODUCTION_MUTATION");
  assertGateRuntimeIdentity(document.runtime, runtime, "FINAL_ATTESTATION_TWO_TENANT");
  invariant(document.commit === runtime.candidateCommit, "FINAL_ATTESTATION_TWO_TENANT_CANDIDATE_MISMATCH");
  invariant(
    isPlainObject(document.workflowTrust)
      && document.workflowTrust.schema === "novalure.qa.protected-workflow-trust.v1"
      && document.workflowTrust.candidateSha === runtime.candidateCommit
      && document.workflowTrust.trustedHarnessSha === runtime.trustedHarnessSha
      && document.workflowTrust.workflowSha === runtime.trustedHarnessSha
      && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/\.github\/workflows\/livegang-e2e\.yml@refs\/heads\/main$/u
        .test(document.workflowTrust.workflowRef),
    "FINAL_ATTESTATION_TWO_TENANT_TRUSTED_WORKFLOW_RECEIPT_INVALID",
  );
  const twoTenantParentBase = Object.fromEntries(
    Object.entries(document).filter(([key]) =>
      !["protectedWorkflowArtifactManifest", "protectedWorkflowReceipt"].includes(key)),
  );
  const canonicalParentBase = canonicalJson(twoTenantParentBase);
  const parentBaseArtifact = document.protectedWorkflowArtifactManifest?.files?.find(
    (entry) => entry?.name === twoTenantParentBaseArtifactFile,
  );
  invariant(
    parentBaseArtifact?.sha256 === sha256(canonicalParentBase),
    "FINAL_ATTESTATION_TWO_TENANT_PARENT_BASE_DIGEST_MISMATCH",
  );
  invariant(
    parentBaseArtifact.sizeBytes === Buffer.byteLength(canonicalParentBase, "utf8"),
    "FINAL_ATTESTATION_TWO_TENANT_PARENT_BASE_SIZE_MISMATCH",
  );
  const receiptValidationInput = {
    artifactManifest: document.protectedWorkflowArtifactManifest,
    expectedArtifactDigest: document.protectedWorkflowArtifactManifest?.artifactDigest,
    expectedRuntime: {
      candidateCommit: runtime.candidateCommit,
      databaseBranchId: runtime.databaseBranchId,
      deploymentHost: runtime.deploymentHost,
      deploymentId: runtime.deploymentId,
      gitBranch: runtime.branch,
      productionMutationPerformed: false,
    },
    expectedWorkflowRef: document.workflowTrust.workflowRef,
    expectedWorkflowSha: runtime.trustedHarnessSha,
    receipt: document.protectedWorkflowReceipt,
    trustContext,
  };
  validateProtectedWorkflowProvenanceReceipt(receiptValidationInput);
  assertExactKeys(protectedWorkflowVerification, [
    "artifactPath",
    "attestationBundlePath",
    "expectedSigstoreTrustedRootSha256",
    "githubCliPath",
    "sigstoreTrustedRootPath",
  ], "FINAL_ATTESTATION_TWO_TENANT_CRYPTOGRAPHIC_PROVENANCE");
  const verifiedAttestation = verifyGitHubArtifactAttestation({
    artifactManifest: document.protectedWorkflowArtifactManifest,
    artifactPath: protectedWorkflowVerification.artifactPath,
    attestationBundlePath: protectedWorkflowVerification.attestationBundlePath,
    expectedEvidenceFiles: protectedWorkflowEvidenceFiles,
    expectedSigstoreTrustedRootSha256:
      protectedWorkflowVerification.expectedSigstoreTrustedRootSha256,
    expectedWorkflowRef: document.workflowTrust.workflowRef,
    expectedWorkflowSha: runtime.trustedHarnessSha,
    githubCliPath: protectedWorkflowVerification.githubCliPath,
    sigstoreTrustedRootPath: protectedWorkflowVerification.sigstoreTrustedRootPath,
  });
  const provenanceResult = validateProtectedWorkflowProvenanceReceipt({
    ...receiptValidationInput,
    verifiedAttestation,
  });
  invariant(
    provenanceResult.status === "VERIFIED",
    "FINAL_ATTESTATION_TWO_TENANT_CRYPTOGRAPHIC_PROVENANCE_REQUIRED",
  );
  assertExactStringInventory(
    document.results?.map((entry) => entry?.id),
    twoTenantExpectedResultIds,
    "FINAL_ATTESTATION_TWO_TENANT_RESULTS",
  );
  invariant(
    document.results.every((entry) => entry?.status === "pass"),
    "FINAL_ATTESTATION_TWO_TENANT_RESULT_NOT_PASS",
  );
  invariant(
    document.summary?.failed === 0
      && document.summary?.passed === twoTenantExpectedResultIds.length
      && Array.isArray(document.requests)
      && document.summary?.requests === document.requests.length,
    "FINAL_ATTESTATION_TWO_TENANT_SUMMARY_INVALID",
  );
  invariant(Array.isArray(document.cleanup) && document.cleanup.length === 2, "FINAL_ATTESTATION_TWO_TENANT_CLEANUP_COUNT_INVALID");
  assertExactStringInventory(
    document.cleanup.map((entry) => entry?.tenant),
    ["A", "B"],
    "FINAL_ATTESTATION_TWO_TENANT_CLEANUP_TENANTS",
  );
  for (const cleanup of document.cleanup) {
    invariant(isDigest(cleanup.planDigest), "FINAL_ATTESTATION_TWO_TENANT_CLEANUP_PLAN_INVALID");
    invariant(isPlainObject(cleanup.remaining), "FINAL_ATTESTATION_TWO_TENANT_CLEANUP_REMAINING_INVALID");
    assertExactStringInventory(
      Object.keys(cleanup.remaining),
      twoTenantCleanupResourceTypes,
      "FINAL_ATTESTATION_TWO_TENANT_CLEANUP_RESOURCES",
    );
    invariant(
      Object.values(cleanup.remaining).every((count) => count === 0),
      "FINAL_ATTESTATION_TWO_TENANT_CLEANUP_NOT_EMPTY",
    );
  }
  invariant(Array.isArray(document.targets) && document.targets.length === 2, "FINAL_ATTESTATION_TWO_TENANT_TARGET_COUNT_INVALID");
  assertExactStringInventory(
    document.targets.map((entry) => entry?.tenant),
    ["A", "B"],
    "FINAL_ATTESTATION_TWO_TENANT_TARGETS",
  );
  const branchFingerprint = `sha256:${sha256(document.runtime.databaseBranchId).slice(0, 16)}`;
  invariant(
    document.targets.every((entry) => entry?.branch === branchFingerprint),
    "FINAL_ATTESTATION_TWO_TENANT_DATABASE_TARGET_MISMATCH",
  );
}

function assertBlobPass(document, runtime, { trustContext = null } = {}) {
  invariant(document.productionMutationPerformed === false, "FINAL_ATTESTATION_BLOB_PRODUCTION_MUTATION");
  const deployment = document.deployment;
  assertGateRuntimeIdentity({
    databaseBranchId: deployment?.databaseBranchId,
    deploymentHost: deployment?.deploymentHost,
    deploymentId: deployment?.deploymentId,
    gitBranch: deployment?.branch,
    gitSha: deployment?.gitSha,
  }, runtime, "FINAL_ATTESTATION_BLOB");
  assertExactStringInventory(
    document.checks?.map((entry) => entry?.id),
    previewBlobExpectedCheckIds,
    "FINAL_ATTESTATION_BLOB_CHECKS",
  );
  invariant(document.checks.every((entry) => entry?.status === "PASS"), "FINAL_ATTESTATION_BLOB_CHECK_NOT_PASS");
  invariant(
    document.cleanup?.attempted === true
      && document.cleanup?.deleted === true
      && document.cleanup?.state === "deleted-and-absent"
      && document.cleanup?.verifiedAbsent === true,
    "FINAL_ATTESTATION_BLOB_CLEANUP_INVALID",
  );
  const store = document.independentStoreProof;
  invariant(
    store?.status === "VERIFIED"
      && store.reasonCode === null
      && store.headVerified === true
      && store.newObjectCount === 1
      && store.objectAbsentAfterDelete === true
      && Number.isSafeInteger(store.beforeCount)
      && store.afterUploadCount === store.beforeCount + 1
      && store.afterDeleteCount === store.beforeCount,
    "FINAL_ATTESTATION_BLOB_STORE_PROOF_INVALID",
  );
  invariant(
    document.lifecycle?.listMatchesBefore === 0
      && document.lifecycle?.listMatchesAfterUpload === 1
      && document.lifecycle?.listMatchesAfterDelete === 0
      && document.lifecycle?.readbackBytesVerified === true
      && document.lifecycle?.readHeadersVerified === true
      && document.lifecycle?.unauthenticatedReadDenied === true
      && document.lifecycle?.crossTenantReadDenied === true,
    "FINAL_ATTESTATION_BLOB_LIFECYCLE_INVALID",
  );
  const legacy = document.legacyObjectMigrationProof;
  invariant(
    legacy?.status === "VERIFIED"
      && legacy.candidateCommit === runtime.candidateCommit
      && legacy.productionMutationPerformed === false
      && legacy.storeFingerprint === store.storeFingerprint
      && Number.isSafeInteger(legacy.legacyObjectCountBefore)
      && legacy.legacyObjectCountBefore > 0
      && legacy.migratedObjectCount === legacy.legacyObjectCountBefore
      && legacy.legacyObjectCountAfter === 0
      && isPlainObject(legacy.evidence)
      && legacy.evidenceDigest === sha256(canonicalJson(legacy.evidence)),
    "FINAL_ATTESTATION_BLOB_LEGACY_PROOF_INVALID",
  );
  try {
    validateLegacyBlobMigrationProof({
      expectedCandidateCommit: runtime.candidateCommit,
      expectedDatabaseBranchId: runtime.databaseBranchId,
      expectedDeploymentId: runtime.deploymentId,
      expectedRuntime: {
        candidateCommit: runtime.candidateCommit,
        databaseBranchId: runtime.databaseBranchId,
        deploymentHost: runtime.deploymentHost,
        deploymentId: runtime.deploymentId,
        gitBranch: runtime.branch,
        productionMutationPerformed: false,
      },
      expectedTargetStoreFingerprint: store.storeFingerprint,
      proof: legacy,
      requireReceipt: true,
      trustContext,
    });
  } catch (error) {
    invariant(false, error instanceof Error ? error.message : "FINAL_ATTESTATION_BLOB_LEGACY_PROOF_INVALID");
  }
}

function assertProviderPass(document, runtime, { trustContext = null } = {}) {
  invariant(document.productionMutationPerformed === false, "FINAL_ATTESTATION_PROVIDER_PRODUCTION_MUTATION");
  assertGateRuntimeIdentity({
    databaseBranchId: document.candidate?.databaseBranchId,
    deploymentHost: document.candidate?.deploymentHost,
    deploymentId: document.candidate?.deploymentId,
    gitBranch: document.candidate?.gitRef,
    gitSha: document.candidate?.commitSha,
  }, runtime, "FINAL_ATTESTATION_PROVIDER");
  assertExactStringInventory(
    document.requests?.map((entry) => entry?.id),
    providerExpectedRequestIds,
    "FINAL_ATTESTATION_PROVIDER_REQUESTS",
  );
  const scenarioById = new Map(providerFailClosedScenarios.map((entry) => [entry.id, entry]));
  for (const request of document.requests) {
    const identityRequest = request.id === "identity.session" || request.id === "identity.runtime";
    invariant(
      identityRequest
        ? request.status === 200
          && request.method === "GET"
          && request.csrf === "not-applicable"
          && ["SESSION_SCOPE_MATCH", "RUNTIME_IDENTITY_MATCH"].includes(request.code)
        : request.status === 503
          && request.code === "LAUNCH_SCOPE_OFF"
          && request.method === scenarioById.get(request.id)?.method
          && request.csrf === scenarioById.get(request.id)?.csrf,
      "FINAL_ATTESTATION_PROVIDER_REQUEST_RESULT_INVALID",
    );
  }
  const database = document.databaseWritePostcondition;
  invariant(database?.status === "PASS" && database.reasonCode === null, "FINAL_ATTESTATION_PROVIDER_DATABASE_STATUS_INVALID");
  invariant(isPlainObject(database.tables), "FINAL_ATTESTATION_PROVIDER_DATABASE_TABLES_INVALID");
  assertExactStringInventory(
    Object.keys(database.tables),
    providerExpectedDatabaseTables,
    "FINAL_ATTESTATION_PROVIDER_DATABASE_TABLES",
  );
  invariant(
    Object.values(database.tables).every((entry) =>
      entry?.unchanged === true
      && Number.isSafeInteger(entry.beforeCount)
      && entry.beforeCount === entry.afterCount
      && /^sha256:[a-f0-9]{64}$/u.test(entry.beforeFingerprint ?? "")
      && entry.beforeFingerprint === entry.afterFingerprint),
    "FINAL_ATTESTATION_PROVIDER_DATABASE_DRIFT",
  );
  invariant(
    document.providerSideEffectPostcondition?.codeOrderAndHttpGate === "PASS"
      && document.providerSideEffectPostcondition?.independentProviderLogs === "PASS"
      && document.providerSideEffectPostcondition?.reasonCode === null,
    "FINAL_ATTESTATION_PROVIDER_LOG_PROOF_INVALID",
  );
  invariant(
    document.collectionMode === "LIVE_PROVIDER_ACCEPTANCE",
    "FINAL_ATTESTATION_PROVIDER_LIVE_ACCEPTANCE_REQUIRED",
  );
  const assembly = document.providerAcceptanceAssembly;
  assertExactKeys(assembly, [
    "acceptanceIds",
    "acceptanceCompletedAt",
    "acceptanceReceiptBundleSha256",
    "databasePostconditionSha256",
    "evidenceManifest",
    "finalCleanupReceiptPayloadSha256",
    "receiptPayloadSha256",
    "sourceArtifactSha256",
    "sourceCollectorSha256",
    "sourceCompletedAt",
    "sourceIndependentProviderLogs",
    "sourceReleaseGateStatus",
  ], "FINAL_ATTESTATION_PROVIDER_ASSEMBLY");
  invariant(
    isDigest(assembly.sourceArtifactSha256)
      && isDigest(assembly.sourceCollectorSha256)
      && isDigest(assembly.acceptanceReceiptBundleSha256)
      && isDigest(assembly.finalCleanupReceiptPayloadSha256)
      && isIsoTimestamp(assembly.acceptanceCompletedAt)
      && isIsoTimestamp(assembly.sourceCompletedAt)
      && assembly.sourceIndependentProviderLogs === "UNPROVEN"
      && assembly.sourceReleaseGateStatus === "BLOCKED"
      && assembly.databasePostconditionSha256 === sha256(canonicalJson(database)),
    "FINAL_ATTESTATION_PROVIDER_ASSEMBLY_SOURCE_INVALID",
  );
  const rawCollector = { ...document };
  delete rawCollector.collectionMode;
  delete rawCollector.providerAcceptanceAssembly;
  delete rawCollector.providerAcceptanceReceipts;
  delete rawCollector.providerFinalCleanupReceipt;
  rawCollector.completedAt = assembly.sourceCompletedAt;
  rawCollector.providerSideEffectPostcondition = {
    codeOrderAndHttpGate: "PASS",
    independentProviderLogs: "UNPROVEN",
    reasonCode: "INDEPENDENT_PROVIDER_LOGS_NOT_COLLECTED",
  };
  rawCollector.releaseGateStatus = "BLOCKED";
  invariant(
    rawCollector.httpTechnicalStatus === "PASS"
      && rawCollector.productionMutationPerformed === false
      && isIsoTimestamp(rawCollector.startedAt)
      && Date.parse(rawCollector.completedAt) >= Date.parse(rawCollector.startedAt)
      && sha256(canonicalJson(rawCollector)) === assembly.sourceCollectorSha256,
    "FINAL_ATTESTATION_PROVIDER_SOURCE_RECONSTRUCTION_MISMATCH",
  );
  const receiptPayloadSha256 = document.providerAcceptanceReceipts?.map((receipt) => receipt?.payloadSha256);
  const acceptanceIds = document.providerAcceptanceReceipts?.map((receipt) => receipt?.payload?.acceptanceId);
  const evidenceManifest = document.providerAcceptanceReceipts?.map((receipt) => ({
    acceptanceArtifactSha256: receipt?.payload?.artifactSha256,
    acceptanceId: receipt?.payload?.acceptanceId,
    cleanupEvidenceSha256: receipt?.payload?.postAcceptance?.cleanupEvidenceSha256,
    databaseEvidenceSha256: receipt?.payload?.postAcceptance?.databaseEvidenceSha256,
    providerAccountFingerprint: receipt?.payload?.providerIdentity?.providerAccountFingerprint,
    providerLogArtifactSha256: receipt?.payload?.providerIdentity?.providerLogArtifactSha256,
    qaTargetFingerprint: receipt?.payload?.qaTargetFingerprint,
    receiptId: receipt?.receiptId,
    receiptRole: receipt?.role,
  }));
  invariant(
    canonicalJson(assembly.acceptanceIds) === canonicalJson(acceptanceIds)
      && canonicalJson(assembly.receiptPayloadSha256) === canonicalJson(receiptPayloadSha256)
      && canonicalJson(assembly.evidenceManifest) === canonicalJson(evidenceManifest)
      && assembly.acceptanceCompletedAt === [...document.providerAcceptanceReceipts]
        .map((receipt) => receipt.signedAt)
        .sort()
        .at(-1),
    "FINAL_ATTESTATION_PROVIDER_ASSEMBLY_INVENTORY_MISMATCH",
  );
  validateProviderAcceptanceReceipts({
    databasePostcondition: database,
    receipts: document.providerAcceptanceReceipts,
    runtime: {
      candidateCommit: runtime.candidateCommit,
      databaseBranchId: runtime.databaseBranchId,
      deploymentHost: runtime.deploymentHost,
      deploymentId: runtime.deploymentId,
      gitBranch: runtime.branch,
      productionMutationPerformed: false,
    },
    sourceArtifactSha256: assembly.sourceArtifactSha256,
    sourceCollectorSha256: assembly.sourceCollectorSha256,
    sourceCompletedAt: assembly.sourceCompletedAt,
    trustContext,
  });
  invariant(
    assembly.acceptanceReceiptBundleSha256
      === buildProviderAcceptanceReceiptBundleSha256(document.providerAcceptanceReceipts)
      && assembly.finalCleanupReceiptPayloadSha256 === document.providerFinalCleanupReceipt?.payloadSha256
      && document.completedAt === document.providerFinalCleanupReceipt?.signedAt,
    "FINAL_ATTESTATION_PROVIDER_FINAL_CLEANUP_BINDING_MISMATCH",
  );
  validateProviderFinalCleanupReceipt({
    receipt: document.providerFinalCleanupReceipt,
    receipts: document.providerAcceptanceReceipts,
    runtime: {
      candidateCommit: runtime.candidateCommit,
      databaseBranchId: runtime.databaseBranchId,
      deploymentHost: runtime.deploymentHost,
      deploymentId: runtime.deploymentId,
      gitBranch: runtime.branch,
      productionMutationPerformed: false,
    },
    sourceArtifactSha256: assembly.sourceArtifactSha256,
    sourceCollectorSha256: assembly.sourceCollectorSha256,
    trustContext,
  });
  invariant(
    document.cleanup?.databaseCleanup === "NOT_REQUIRED"
      && document.cleanup?.externalSessionCreatedByRunner === false
      && document.cleanup?.inMemoryCookieJar === "CLEARED_IN_FINALLY"
      && document.cleanup?.status === "COMPLETE",
    "FINAL_ATTESTATION_PROVIDER_CLEANUP_INVALID",
  );
}

function assertPublicPass(document, runtime, {
  publicWorkflowVerification = null,
  trustContext = null,
} = {}) {
  invariant(document.productionMutationPerformed === false, "FINAL_ATTESTATION_PUBLIC_PRODUCTION_MUTATION");
  assertGateRuntimeIdentity({
    databaseBranchId: document.candidate?.neonBranchId,
    deploymentHost: document.candidate?.deploymentHost,
    deploymentId: document.candidate?.deploymentId,
    gitBranch: document.candidate?.gitBranch,
    gitSha: document.candidate?.gitSha,
  }, runtime, "FINAL_ATTESTATION_PUBLIC");
  assertExactStringInventory(
    document.requests?.map((entry) => entry?.id),
    publicExpectedReadOnlyRequestIds,
    "FINAL_ATTESTATION_PUBLIC_REQUESTS",
  );
  const expectedStatuses = new Map([
    ["public-form-shell-missing", 404],
    ["public-form-proof-invalid", 400],
    ["public-form-submit-missing", 404],
    ["public-funnel-shell-missing", 404],
    ["public-funnel-proof-invalid", 400],
    ["public-funnel-submit-invalid", 400],
    ["public-funnel-visit-launch-off", 503],
  ]);
  invariant(
    document.requests.every((entry) => entry?.status === expectedStatuses.get(entry.id)),
    "FINAL_ATTESTATION_PUBLIC_REQUEST_RESULT_INVALID",
  );
  assertExactStringInventory(
    document.proofs?.map((entry) => entry?.id),
    publicRequiredProofIds,
    "FINAL_ATTESTATION_PUBLIC_PROOFS",
  );
  invariant(
    document.proofs.every((entry) =>
      entry?.status === "PASS"
      && entry.candidateCommit === runtime.candidateCommit
      && entry.deploymentId === runtime.deploymentId),
    "FINAL_ATTESTATION_PUBLIC_PROOF_INVALID",
  );
  invariant(
    document.databaseAttestation?.status === "PASS"
      && document.databaseAttestation?.freshBatch === true
      && document.databaseAttestation?.isQa === true
      && document.databaseAttestation?.qaBatchId === document.cleanup?.qaBatchId
      && isDigest(document.databaseAttestation?.contentFingerprintDigest),
    "FINAL_ATTESTATION_PUBLIC_DATABASE_INVALID",
  );
  invariant(
    document.cleanup?.databaseCleanup === "VERIFIED_ZERO"
      && document.cleanup?.exactPrePostContentFingerprintMatch === true
      && document.cleanup?.status === "PASS",
    "FINAL_ATTESTATION_PUBLIC_CLEANUP_INVALID",
  );
  invariant(
    document.mutationGate?.status === "PASS"
      && document.mutationGate?.reasonCode === null,
    "FINAL_ATTESTATION_PUBLIC_MUTATION_GATE_INVALID",
  );
  const publicRuntimeParentBase = Object.fromEntries(
    Object.entries(document).filter(([key]) =>
      !["protectedWorkflowArtifactManifest", "protectedWorkflowReceipt"].includes(key)),
  );
  const publicReceiptResult = validatePublicRuntimeProtectedReceipt({
    artifactManifest: document.protectedWorkflowArtifactManifest,
    cleanup: document.cleanup,
    parentBase: publicRuntimeParentBase,
    proofs: document.proofs,
    receipt: document.protectedWorkflowReceipt,
    runtime: {
      candidateCommit: runtime.candidateCommit,
      databaseBranchId: runtime.databaseBranchId,
      deploymentHost: runtime.deploymentHost,
      deploymentId: runtime.deploymentId,
      gitBranch: runtime.branch,
      productionMutationPerformed: false,
    },
    trustedHarnessSha: runtime.trustedHarnessSha,
    trustContext,
  });
  assertExactKeys(publicWorkflowVerification, [
    "artifactPath",
    "attestationBundlePath",
    "expectedSigstoreTrustedRootSha256",
    "githubCliPath",
    "sigstoreTrustedRootPath",
  ], "FINAL_ATTESTATION_PUBLIC_CRYPTOGRAPHIC_PROVENANCE");
  const verifiedAttestation = verifyGitHubArtifactAttestation({
    artifactManifest: document.protectedWorkflowArtifactManifest,
    artifactPath: publicWorkflowVerification.artifactPath,
    attestationBundlePath: publicWorkflowVerification.attestationBundlePath,
    expectedEvidenceFiles: publicRuntimeArtifactFiles,
    expectedManifestRecordType: "NOVALURE_PUBLIC_RUNTIME_ARTIFACT_MANIFEST",
    expectedSigstoreTrustedRootSha256:
      publicWorkflowVerification.expectedSigstoreTrustedRootSha256,
    expectedWorkflowRef: document.protectedWorkflowReceipt.payload.workflowRef,
    expectedWorkflowSha: runtime.trustedHarnessSha,
    githubCliPath: publicWorkflowVerification.githubCliPath,
    sigstoreTrustedRootPath: publicWorkflowVerification.sigstoreTrustedRootPath,
  });
  invariant(
    verifiedAttestation.artifact.artifactDigest === publicReceiptResult.artifactDigest
      && verifiedAttestation.artifact.artifactDigest
        === document.protectedWorkflowReceipt.payload.artifactDigest
      && verifiedAttestation.artifact.attestationBundleSha256
        === document.protectedWorkflowReceipt.payload.attestationBundleSha256
      && verifiedAttestation.github.workflowReference
        === document.protectedWorkflowReceipt.payload.workflowRef
      && verifiedAttestation.github.workflowSha
        === document.protectedWorkflowReceipt.payload.workflowSha
      && verifiedAttestation.github.runId
        === document.protectedWorkflowReceipt.payload.githubRunId,
    "FINAL_ATTESTATION_PUBLIC_CRYPTOGRAPHIC_PROVENANCE_MISMATCH",
  );
}

function assertA11yPass(document, runtime, { trustContext = null } = {}) {
  invariant(document.mode === "RELEASE_GATE", "FINAL_ATTESTATION_A11Y_MODE_INVALID");
  invariant(document.productionMutationPerformed === false, "FINAL_ATTESTATION_A11Y_PRODUCTION_MUTATION");
  invariant(document.executionBlocker === null, "FINAL_ATTESTATION_A11Y_EXECUTION_BLOCKED");
  invariant(document.targetHost === runtime.deploymentHost, "FINAL_ATTESTATION_A11Y_TARGET_HOST_MISMATCH");
  invariant(document.expectedSha === runtime.candidateCommit, "FINAL_ATTESTATION_A11Y_SHA_MISMATCH");
  assertGateRuntimeIdentity(document.runtimeIdentity?.expected, runtime, "FINAL_ATTESTATION_A11Y");
  assertExactStringInventory(
    document.results?.map((entry) => `${entry?.surface}|${entry?.route}|${entry?.language}|${entry?.profile}`),
    a11yExpectedResultKeys,
    "FINAL_ATTESTATION_A11Y_RESULTS",
  );
  invariant(
    document.results.every((entry) =>
      entry?.passed === true
      && entry.outcome === "PASS"
      && entry.blocker === null
      && entry.status >= 200
      && entry.status < 400
      && entry.browserErrorCount === 0
      && entry.consoleErrorCount === 0),
    "FINAL_ATTESTATION_A11Y_RESULT_NOT_PASS",
  );
  const surfaceCounts = Object.fromEntries(
    ["public", "public-fixture", "auth-fixture", "authenticated"].map((surface) => [
      surface,
      a11yExpectedResultKeys.filter((key) => key.startsWith(`${surface}|`)).length,
    ]),
  );
  invariant(
    document.coverage?.public?.complete === true
      && document.coverage.public.expected === surfaceCounts.public
      && document.coverage.public.observed === surfaceCounts.public
      && document.coverage?.publicFixture?.complete === true
      && document.coverage.publicFixture.expected === surfaceCounts["public-fixture"]
      && document.coverage.publicFixture.observed === surfaceCounts["public-fixture"]
      && document.coverage?.authenticatedFixture?.complete === true
      && document.coverage.authenticatedFixture.expected === surfaceCounts["auth-fixture"]
      && document.coverage.authenticatedFixture.observed === surfaceCounts["auth-fixture"]
      && document.coverage?.authenticated?.complete === true
      && document.coverage.authenticated.expected === surfaceCounts.authenticated
      && document.coverage.authenticated.observed === surfaceCounts.authenticated,
    "FINAL_ATTESTATION_A11Y_COVERAGE_INVALID",
  );
  invariant(
    document.matrix?.total === a11yExpectedResultKeys.length
      && document.matrix.passed === a11yExpectedResultKeys.length
      && document.matrix.failed === 0
      && document.matrix.blocked === 0
      && document.matrix.blockedOrNotRun === 0
      && document.matrix.notRun === 0,
    "FINAL_ATTESTATION_A11Y_MATRIX_INVALID",
  );
  invariant(
    document.runtimeIdentity?.attestationComplete === true
      && document.runtimeIdentity.attestationCount === document.runtimeIdentity.expectedAttestationCount
      && document.runtimeIdentity.attestationCount > 0,
    "FINAL_ATTESTATION_A11Y_RUNTIME_ATTESTATION_INVALID",
  );
  invariant(
    document.acceptance?.contractComplete === true
      && document.acceptance?.manualAcceptancePassed === true
      && document.acceptance?.matrixSigned === true
      && document.acceptance?.signaturesComplete === true
      && document.acceptance?.status === "SIGNED"
      && document.acceptance.manualCheckCount === accessibilityRequiredManualCheckIds.length
      && document.acceptance.manualCheckCount === document.acceptance.manualPassCount
      && document.acceptance.signatureCount === accessibilityApprovalRoles.length,
    "FINAL_ATTESTATION_A11Y_ACCEPTANCE_INVALID",
  );
  invariant(
    document.cleanup?.complete === true
      && document.cleanup?.browserClosed === true
      && document.cleanup?.sessionLogoutFailures === 0,
    "FINAL_ATTESTATION_A11Y_CLEANUP_INVALID",
  );
  invariant(
    document.releaseSurfaceManifestVerified === true
      && document.unsafeHttpWriteGuard?.complete === true
      && document.unsafeHttpWriteGuard?.blockedAttemptCount === 0
      && document.automatedSubsetPassed === true,
    "FINAL_ATTESTATION_A11Y_GUARDS_INVALID",
  );
  assertExactKeys(
    document.manualAcceptance,
    [
      "approvalReceipts",
      "automatedEvidence",
      "databaseProjectId",
      "fixtureLifecycle",
      "fixtureLifecycleSha256",
      "individualEvidence",
      "matrix",
    ],
    "FINAL_ATTESTATION_A11Y_MANUAL_ACCEPTANCE",
  );
  validateAccessibilityApprovalReceipts({
    approvalReceipts: document.manualAcceptance.approvalReceipts,
    automatedEvidence: document.manualAcceptance.automatedEvidence,
    databaseProjectId: document.manualAcceptance.databaseProjectId,
    expectedAutomatedEvidence: {
      automatedSourceSha256: document.automatedSourceSha256,
      automatedSubsetPassed: document.automatedSubsetPassed,
      automatedTechnicalPassed: document.automatedTechnicalPassed,
      browser: document.browser,
      cleanup: document.cleanup,
      coverage: document.coverage,
      endedAt: document.endedAt,
      evidenceDigest: document.evidenceDigest,
      executionBlocker: document.executionBlocker,
      executionScope: document.executionScope,
      expectedSha: document.expectedSha,
      generatedAt: document.generatedAt,
      matrix: document.matrix,
      mode: document.mode,
      productionMutationPerformed: document.productionMutationPerformed,
      releaseSurfaceManifestVerified: document.releaseSurfaceManifestVerified,
      results: document.results,
      runtimeIdentity: document.runtimeIdentity,
      schemaVersion: document.schemaVersion,
      startedAt: document.startedAt,
      targetHost: document.targetHost,
      unsafeHttpWriteGuard: document.unsafeHttpWriteGuard,
      wcagStandard: document.wcagStandard,
    },
    fixtureLifecycle: document.manualAcceptance.fixtureLifecycle,
    fixtureLifecycleSha256: document.manualAcceptance.fixtureLifecycleSha256,
    individualEvidence: document.manualAcceptance.individualEvidence,
    matrix: document.manualAcceptance.matrix,
    runtime: {
      candidateCommit: runtime.candidateCommit,
      databaseBranchId: runtime.databaseBranchId,
      deploymentHost: runtime.deploymentHost,
      deploymentId: runtime.deploymentId,
      gitBranch: runtime.branch,
      productionMutationPerformed: false,
    },
    trustContext,
  });
}

export function expectedPerformanceBudgetFailures(entry) {
  invariant(
    isPlainObject(entry) && ["public", "authenticated"].includes(entry.surface),
    "FINAL_ATTESTATION_PERFORMANCE_SURFACE_INVALID",
  );
  const budget = finalPerformanceBudgetPolicy[entry.surface];
  const failures = [];
  const scores = entry.scores;
  const metrics = entry.metrics;
  invariant(isPlainObject(scores), "FINAL_ATTESTATION_PERFORMANCE_SCORES_INVALID");
  invariant(isPlainObject(metrics), "FINAL_ATTESTATION_PERFORMANCE_METRICS_INVALID");
  assertExactKeys(
    scores,
    ["accessibility", "bestPractices", "performance"],
    "FINAL_ATTESTATION_PERFORMANCE_SCORES",
  );
  assertExactKeys(
    metrics,
    [
      "cumulativeLayoutShift",
      "interactionToNextPaint",
      "largestContentfulPaint",
      "totalBlockingTime",
      "totalByteWeight",
    ],
    "FINAL_ATTESTATION_PERFORMANCE_METRICS",
  );
  for (const score of Object.values(scores)) {
    invariant(
      typeof score === "number" && Number.isFinite(score) && score > 0 && score <= 1,
      "FINAL_ATTESTATION_PERFORMANCE_SCORE_INVALID",
    );
  }
  invariant(
    typeof metrics.largestContentfulPaint === "number"
      && Number.isFinite(metrics.largestContentfulPaint)
      && metrics.largestContentfulPaint > 0
      && typeof metrics.cumulativeLayoutShift === "number"
      && Number.isFinite(metrics.cumulativeLayoutShift)
      && metrics.cumulativeLayoutShift >= 0
      && typeof metrics.totalBlockingTime === "number"
      && Number.isFinite(metrics.totalBlockingTime)
      && metrics.totalBlockingTime >= 0
      && (metrics.interactionToNextPaint === null
        || (typeof metrics.interactionToNextPaint === "number"
          && Number.isFinite(metrics.interactionToNextPaint)
          && metrics.interactionToNextPaint >= 0))
      && typeof metrics.totalByteWeight === "number"
      && Number.isFinite(metrics.totalByteWeight)
      && metrics.totalByteWeight > 0,
    "FINAL_ATTESTATION_PERFORMANCE_METRIC_INVALID",
  );
  invariant(
    typeof entry.bundleRegressionPercent === "number"
      && Number.isFinite(entry.bundleRegressionPercent)
      && entry.bundleRegressionPercent >= -100,
    "FINAL_ATTESTATION_PERFORMANCE_BUNDLE_REGRESSION_INVALID",
  );
  if (scores.performance < budget.performanceScoreMin) failures.push("performance_score");
  if (scores.accessibility < budget.accessibilityScoreMin) failures.push("accessibility_score");
  if (scores.bestPractices < budget.bestPracticesScoreMin) failures.push("best_practices_score");
  if (metrics.largestContentfulPaint > budget.largestContentfulPaintMaxMs) failures.push("largest_contentful_paint");
  if (metrics.cumulativeLayoutShift > budget.cumulativeLayoutShiftMax) failures.push("cumulative_layout_shift");
  if (metrics.totalBlockingTime > budget.totalBlockingTimeMaxMs) failures.push("total_blocking_time");
  if (entry.bundleRegressionPercent > finalPerformanceBudgetPolicy.bundle.maxRegressionPercent) {
    failures.push("bundle_regression");
  }
  return failures;
}

export function buildPerformanceTechnicalEvidenceSha256(document) {
  invariant(isPlainObject(document), "FINAL_ATTESTATION_PERFORMANCE_DOCUMENT_INVALID");
  return sha256(canonicalJson({
    authenticatedCoverageComplete: document.authenticatedCoverageComplete,
    baseOrigin: document.baseOrigin,
    baselineProvenance: document.baselineProvenance,
    budgetPolicySha256: document.budgetPolicySha256,
    cleanup: document.cleanup,
    endedAt: document.endedAt,
    evidenceDigest: document.evidenceDigest,
    executionBlocker: document.executionBlocker,
    executionScope: document.executionScope,
    expectedSha: document.expectedSha,
    generatedAt: document.generatedAt,
    productionMutationPerformed: document.productionMutationPerformed,
    publicCoverageComplete: document.publicCoverageComplete,
    results: document.results,
    runtimeIdentity: document.runtimeIdentity,
    schemaVersion: document.schemaVersion,
    sessionAttestation: document.sessionAttestation,
    startedAt: document.startedAt,
    technicalPassed: document.technicalPassed,
    tool: document.tool,
  }));
}

function assertPerformancePass(document, runtime, { trustContext = null } = {}) {
  invariant(document.productionMutationPerformed === false, "FINAL_ATTESTATION_PERFORMANCE_PRODUCTION_MUTATION");
  invariant(document.executionBlocker === null, "FINAL_ATTESTATION_PERFORMANCE_EXECUTION_BLOCKED");
  invariant(document.baseOrigin === `https://${runtime.deploymentHost}`, "FINAL_ATTESTATION_PERFORMANCE_ORIGIN_MISMATCH");
  invariant(document.expectedSha === runtime.candidateCommit, "FINAL_ATTESTATION_PERFORMANCE_SHA_MISMATCH");
  assertGateRuntimeIdentity(document.runtimeIdentity?.expected, runtime, "FINAL_ATTESTATION_PERFORMANCE_EXPECTED");
  assertGateRuntimeIdentity(document.runtimeIdentity?.observed, runtime, "FINAL_ATTESTATION_PERFORMANCE_OBSERVED", { observed: true });
  invariant(document.runtimeIdentity?.attested === true, "FINAL_ATTESTATION_PERFORMANCE_RUNTIME_NOT_ATTESTED");
  invariant(
    document.budgetPolicySha256 === sha256(canonicalJson(finalPerformanceBudgetPolicy)),
    "FINAL_ATTESTATION_PERFORMANCE_BUDGET_POLICY_MISMATCH",
  );
  assertExactStringInventory(
    document.results?.map((entry) =>
      `${entry?.surface}|${entry?.route}|${entry?.language}|${entry?.profile}|${entry?.temperature}`),
    performanceExpectedResultKeys,
    "FINAL_ATTESTATION_PERFORMANCE_RESULTS",
  );
  for (const entry of document.results) {
    invariant(Array.isArray(entry?.budgetFailures), "FINAL_ATTESTATION_PERFORMANCE_BUDGET_FAILURES_INVALID");
    const recomputedFailures = expectedPerformanceBudgetFailures(entry);
    invariant(
      entry.passed === true
        && JSON.stringify(entry.budgetFailures) === JSON.stringify(recomputedFailures)
        && recomputedFailures.length === 0,
      "FINAL_ATTESTATION_PERFORMANCE_RESULT_NOT_PASS",
    );
  }
  invariant(
    document.publicCoverageComplete === true
      && document.authenticatedCoverageComplete === true
      && document.technicalPassed === true
      && document.manualAndRumGatesComplete === true
      && document.signaturesPresent === true
      && document.budgetApprovalStatus === "SIGNED"
      && document.cleanup?.complete === true
      && document.cleanup?.browserProfileRemoved === true
      && ["LOGGED_OUT", "NO_SESSION"].includes(document.cleanup?.qaSessionLogout),
    "FINAL_ATTESTATION_PERFORMANCE_COMPLETION_INVALID",
  );
  assertExactKeys(
    document.manualGates,
    ["mobileAssistiveTechnology", "screenReader", "zoomAndReflow"],
    "FINAL_ATTESTATION_PERFORMANCE_MANUAL_GATES",
  );
  invariant(
    Object.values(document.manualGates).every((status) => status === "PASS")
      && document.realUserMonitoring?.status === "PASS",
    "FINAL_ATTESTATION_PERFORMANCE_MANUAL_OR_RUM_INVALID",
  );
  const technicalEvidenceSha256 = buildPerformanceTechnicalEvidenceSha256(document);
  invariant(
    document.technicalEvidenceSha256 === technicalEvidenceSha256,
    "FINAL_ATTESTATION_PERFORMANCE_TECHNICAL_EVIDENCE_DIGEST_MISMATCH",
  );
  const receiptRuntime = {
    candidateCommit: runtime.candidateCommit,
    databaseBranchId: runtime.databaseBranchId,
    deploymentHost: runtime.deploymentHost,
    deploymentId: runtime.deploymentId,
    gitBranch: runtime.branch,
    productionMutationPerformed: false,
  };
  assertExactKeys(
    document.budgetApprovalReceipts,
    finalPerformanceBudgetPolicy.requiredApprovalRoles,
    "FINAL_ATTESTATION_PERFORMANCE_BUDGET_APPROVAL_RECEIPTS",
  );
  for (const approvalRole of finalPerformanceBudgetPolicy.requiredApprovalRoles) {
    validatePerformanceBudgetApprovalReceipt({
      approvalRole,
      budgetPolicy: finalPerformanceBudgetPolicy,
      receipt: document.budgetApprovalReceipts[approvalRole],
      runtime: receiptRuntime,
      trustContext,
    });
  }
  validatePerformanceManualAcceptanceReceipt({
    budgetPolicy: finalPerformanceBudgetPolicy,
    receipt: document.manualAcceptanceReceipt,
    runtime: receiptRuntime,
    technicalEvidenceSha256,
    trustContext,
  });
  validatePerformanceRumAcceptanceReceipt({
    budgetPolicy: finalPerformanceBudgetPolicy,
    receipt: document.realUserMonitoringReceipt,
    runtime: receiptRuntime,
    technicalEvidenceSha256,
    trustContext,
  });
}

export function observedFinalPreviewGateStatus(binding, document, runtime, {
  protectedWorkflowVerification = null,
  publicWorkflowVerification = null,
  trustContext = null,
} = {}) {
  invariant(
    isPlainObject(runtime)
      && isCommitSha(runtime.candidateCommit)
      && /^br-[A-Za-z0-9-]{8,128}$/u.test(runtime.databaseBranchId)
      && /^dpl_[A-Za-z0-9]{20,80}$/u.test(runtime.deploymentId)
      && typeof runtime.deploymentHost === "string"
      && typeof runtime.branch === "string",
    "FINAL_ATTESTATION_GATE_RUNTIME_INVALID",
  );
  invariant(
    readJsonPointer(document, binding.schemaJsonPointer) === binding.schemaValue,
    "FINAL_ATTESTATION_GATE_SCHEMA_MISMATCH",
  );
  if (binding.id === "database-recovery") {
    if (document.status === "RECOVERY_BLOCKED_UNPROVEN") return "BLOCKED";
    const liveEntries = Array.isArray(document.evidence)
      ? document.evidence.filter((entry) => entry?.role === "FINAL_LIVE_COLLECTOR_PASS")
      : [];
    const schemaDiffPass = document.schemaDiffApi?.status === "PASS_EMPTY"
      && document.schemaDiffApi?.countedAsPassEvidence === true
      && document.schemaDiffApi?.diffSha256 === sha256("");
    return document.schemaVersion === 2
      && document.status === "CURRENT_SHA_REHEARSAL_AND_RESET_PASS"
      && schemaDiffPass
      && liveEntries.length === 1
      && liveEntries[0].passEligible === true
      ? "PASS"
      : "FAIL";
  }
  if (binding.id === "two-tenant-rbac-crud") {
    const cleanupPass = Array.isArray(document.cleanup)
      && document.cleanup.length === 2
      && new Set(document.cleanup.map((entry) => entry?.tenant)).size === 2
      && document.cleanup.every((entry) =>
        entry && isPlainObject(entry.remaining)
        && Object.keys(entry.remaining).length > 0
        && Object.values(entry.remaining).every((count) => count === 0));
    if (document.mode === "execute" && document.summary?.failed === 0 && cleanupPass) {
      assertTwoTenantPass(document, runtime, { protectedWorkflowVerification, trustContext });
      return "PASS";
    }
    return Number(document.summary?.failed) > 0 ? "FAIL" : "BLOCKED";
  }
  if (binding.id === "preview-blob-lifecycle") {
    if (
      document.releaseGatePassed === true
      && document.status === "PASS"
      && document.technicalStatus === "PASS"
      && document.cleanup?.verifiedAbsent === true
      && document.independentStoreProof?.status === "VERIFIED"
      && document.legacyObjectMigrationProof?.status === "VERIFIED"
    ) {
      assertBlobPass(document, runtime, { trustContext });
      return "PASS";
    }
    return document.status === "FAIL" || document.technicalStatus === "FAIL" ? "FAIL" : "BLOCKED";
  }
  if (binding.id === "provider-boundaries") {
    if (
      document.releaseGateStatus === "PASS"
      && document.httpTechnicalStatus === "PASS"
      && document.databaseWritePostcondition?.status === "PASS"
      && document.providerSideEffectPostcondition?.independentProviderLogs === "PASS"
    ) {
      assertProviderPass(document, runtime, { trustContext });
      return "PASS";
    }
    return document.httpTechnicalStatus === "FAIL" || document.databaseWritePostcondition?.status === "FAIL"
      ? "FAIL"
      : "BLOCKED";
  }
  if (binding.id === "public-form-funnel") {
    if (
      document.releaseGateStatus === "PASS"
      && document.httpReadOnlyStatus === "PASS"
      && document.databaseAttestation?.status === "PASS"
      && document.mutationGate?.status === "PASS"
      && Array.isArray(document.blockedProofs)
      && document.blockedProofs.length === 0
    ) {
      assertPublicPass(document, runtime, { publicWorkflowVerification, trustContext });
      return "PASS";
    }
    return document.httpReadOnlyStatus === "FAIL" || document.databaseAttestation?.status === "FAIL"
      ? "FAIL"
      : "BLOCKED";
  }
  if (binding.id === "production-funnel-token-cutover") {
    if (document.status !== "PASS") return document.status === "FAIL" ? "FAIL" : "BLOCKED";
    validateProductionFunnelTokenCutoverEvidence({
      document,
      expectedCandidateCommit: runtime.candidateCommit,
      trustContext,
    });
    return "PASS";
  }
  if (binding.id === "accessibility-browser") {
    if (
      document.releasePassed === true
      && document.automatedTechnicalPassed === true
      && document.acceptance?.manualAcceptancePassed === true
      && document.acceptance?.matrixSigned === true
      && document.acceptance?.signaturesComplete === true
      && document.cleanup?.complete === true
    ) {
      assertA11yPass(document, runtime, { trustContext });
      return "PASS";
    }
    return Number(document.matrix?.failed) > 0 ? "FAIL" : "BLOCKED";
  }
  if (binding.id === "performance") {
    if (
      document.releasePassed === true
      && document.technicalPassed === true
      && document.manualAndRumGatesComplete === true
      && document.signaturesPresent === true
      && document.cleanup?.complete === true
    ) {
      assertPerformancePass(document, runtime, { trustContext });
      return "PASS";
    }
    return document.executionBlocker ? "FAIL" : "BLOCKED";
  }

  const requiredAssertions = genericGateAssertions[binding.id];
  invariant(requiredAssertions, "FINAL_ATTESTATION_GATE_VALIDATOR_MISSING");
  invariant(document.candidateCommit === runtime.candidateCommit, "FINAL_ATTESTATION_GATE_CANDIDATE_MISMATCH");
  invariant(document.databaseBranchId === runtime.databaseBranchId, "FINAL_ATTESTATION_GATE_DATABASE_BRANCH_MISMATCH");
  invariant(document.deploymentId === runtime.deploymentId, "FINAL_ATTESTATION_GATE_DEPLOYMENT_MISMATCH");
  invariant(document.deploymentHost === runtime.deploymentHost, "FINAL_ATTESTATION_GATE_HOST_MISMATCH");
  invariant(document.gitBranch === runtime.branch, "FINAL_ATTESTATION_GATE_BRANCH_MISMATCH");
  invariant(document.productionMutationPerformed === false, "FINAL_ATTESTATION_GATE_PRODUCTION_MUTATION");
  if (document.status !== "PASS") return document.status === "FAIL" ? "FAIL" : "BLOCKED";
  invariant(isPlainObject(document.assertions), "FINAL_ATTESTATION_GATE_ASSERTIONS_INVALID");
  invariant(
    Object.keys(document.assertions).length === requiredAssertions.length
      && requiredAssertions.every((id) => document.assertions[id] === "PASS"),
    "FINAL_ATTESTATION_GATE_ASSERTIONS_INCOMPLETE",
  );
  const operationalGateId = {
    "cleanup-null-rest": "cleanup",
    observability: "observability",
    "runtime-logs": "runtime-logs",
    "security-supply-chain": "supply-chain",
  }[binding.id];
  validateOperationalGateReceipt({
    expectedRuntime: {
      candidateCommit: runtime.candidateCommit,
      databaseBranchId: runtime.databaseBranchId,
      deploymentHost: runtime.deploymentHost,
      deploymentId: runtime.deploymentId,
      gitBranch: runtime.branch,
      productionMutationPerformed: false,
    },
    gateId: operationalGateId,
    receipt: document.operationalReceipt,
    trustContext,
  });
  return "PASS";
}

async function readHashedBinding(binding, runtimeCandidateCommit, {
  evidenceCommit = null,
  expectedGateStatus = null,
  gateDefinition = null,
  protectedWorkflowVerification = null,
  publicWorkflowVerification = null,
  runtime = null,
  trustContext = null,
} = {}) {
  invariant(isCommitSha(evidenceCommit), "FINAL_ATTESTATION_BINDING_EVIDENCE_COMMIT_INVALID");
  const [path] = await Promise.all([
    resolveTrustedRepositoryRegularFile(binding.path),
    resolveTrustedRepositoryRegularFile(binding.sidecarPath),
  ]);
  const [source, sidecar] = await Promise.all([
    Promise.resolve(readCommittedGitBlob(evidenceCommit, binding.path, repositoryRoot)),
    Promise.resolve(readCommittedGitBlob(evidenceCommit, binding.sidecarPath, repositoryRoot)),
  ]);
  const digest = sha256(source);
  invariant(digest === binding.sha256, "FINAL_ATTESTATION_BINDING_DIGEST_MISMATCH");
  invariant(
    parseSidecar(sidecar.toString("utf8"), basename(path)) === digest,
    "FINAL_ATTESTATION_BINDING_SIDECAR_MISMATCH",
  );
  const document = JSON.parse(source.toString("utf8"));
  assertEvidenceCandidateBinding({
    candidateJsonPointer: binding.candidateJsonPointer,
    evidenceDocument: document,
    runtimeCandidateCommit,
  });
  if (expectedGateStatus !== null) {
    invariant(gateDefinition?.id === binding.id, "FINAL_ATTESTATION_GATE_MAPPING_MISSING");
    invariant(
      observedFinalPreviewGateStatus(gateDefinition, document, runtime, {
        protectedWorkflowVerification,
        publicWorkflowVerification,
        trustContext,
      }) === expectedGateStatus,
      "FINAL_ATTESTATION_EVIDENCE_STATUS_MISMATCH",
    );
  }
  scanForSecretMaterial(source.toString("utf8"));
  return document;
}

export function validateExternalApprovalArtifact({
  artifact,
  attestation,
  role,
  signature,
}) {
  assertExactKeys(artifact, [
    "acceptedRiskReferences",
    "approvalScopes",
    "candidateCommit",
    "decision",
    "detachedSignature",
    "deploymentId",
    "documentBundleSha256",
    "keyId",
    "name",
    "recordType",
    "role",
    "schemaVersion",
    "signatureAlgorithm",
    "signatureReference",
    "signerSubject",
    "signedAt",
    "trustAnchorId",
  ], `FINAL_ATTESTATION_APPROVAL_ARTIFACT_${role.toUpperCase()}`);
  invariant(artifact.schemaVersion === 2, "FINAL_ATTESTATION_APPROVAL_ARTIFACT_SCHEMA_INVALID");
  invariant(
    artifact.recordType === "NOVALURE_EXTERNAL_RELEASE_APPROVAL",
    "FINAL_ATTESTATION_APPROVAL_ARTIFACT_TYPE_INVALID",
  );
  for (const key of [
    "candidateCommit",
    "decision",
    "detachedSignature",
    "deploymentId",
    "documentBundleSha256",
    "keyId",
    "name",
    "role",
    "signatureAlgorithm",
    "signatureReference",
    "signerSubject",
    "signedAt",
    "trustAnchorId",
  ]) {
    invariant(
      artifact[key] === signature[key],
      `FINAL_ATTESTATION_APPROVAL_ARTIFACT_${key.toUpperCase()}_MISMATCH`,
    );
  }
  invariant(artifact.role === role, "FINAL_ATTESTATION_APPROVAL_ARTIFACT_ROLE_INVALID");
  invariant(artifact.decision === attestation.decision, "FINAL_ATTESTATION_APPROVAL_ARTIFACT_DECISION_INVALID");
  invariant(
    artifact.documentBundleSha256 === attestation.documentBundleSha256,
    "FINAL_ATTESTATION_APPROVAL_ARTIFACT_BUNDLE_INVALID",
  );
  invariant(
    JSON.stringify(artifact.acceptedRiskReferences) === JSON.stringify(signature.acceptedRiskReferences),
    "FINAL_ATTESTATION_APPROVAL_ARTIFACT_RISKS_MISMATCH",
  );
  invariant(
    JSON.stringify(artifact.approvalScopes) === JSON.stringify(signature.approvalScopes),
    "FINAL_ATTESTATION_APPROVAL_ARTIFACT_SCOPES_MISMATCH",
  );
}

export async function verifyExternalApprovalArtifact({ attestation, role, signature }) {
  const [artifactPath, sidecarPath] = await Promise.all([
    resolveTrustedRepositoryRegularFile(signature.approvalArtifactPath),
    resolveTrustedRepositoryRegularFile(signature.approvalArtifactSidecarPath),
  ]);
  const [source, sidecar] = await Promise.all([
    readFile(artifactPath),
    readFile(sidecarPath, "utf8"),
  ]);
  const digest = sha256(source);
  invariant(
    digest === signature.approvalArtifactSha256,
    "FINAL_ATTESTATION_APPROVAL_ARTIFACT_DIGEST_MISMATCH",
  );
  invariant(
    parseSidecar(sidecar, basename(artifactPath)) === digest,
    "FINAL_ATTESTATION_APPROVAL_ARTIFACT_SIDECAR_MISMATCH",
  );
  scanForSecretMaterial(source.toString("utf8"));
  validateExternalApprovalArtifact({
    artifact: JSON.parse(source.toString("utf8")),
    attestation,
    role,
    signature,
  });
}

export async function readApprovalTrustContext({
  approvalTrustAnchorPath,
  expectedApprovalTrustAnchorSha256,
}) {
  invariant(
    isDigest(expectedApprovalTrustAnchorSha256),
    "FINAL_ATTESTATION_EXPECTED_TRUST_ANCHOR_DIGEST_REQUIRED",
  );
  const source = await readExternalTrustAnchorRegularFile(approvalTrustAnchorPath);
  const digest = sha256(source);
  invariant(
    digest === expectedApprovalTrustAnchorSha256,
    "FINAL_ATTESTATION_TRUST_ANCHOR_DIGEST_MISMATCH",
  );
  scanForSecretMaterial(source.toString("utf8"));
  const anchor = JSON.parse(source.toString("utf8"));
  validateApprovalTrustAnchor(anchor, expectedApprovalTrustAnchorSha256);
  return Object.freeze({ anchor, expectedSha256: expectedApprovalTrustAnchorSha256 });
}

export async function verifyFinalPreviewReleaseAttestation({
  approvalTrustAnchorPath = null,
  attestationPath = defaultAttestationPath,
  expectedApprovalTrustAnchorSha256 = null,
  protectedWorkflowVerification = null,
  publicWorkflowVerification = null,
  recoveryTrustAnchor = null,
  requireGo = false,
} = {}) {
  invariant(typeof requireGo === "boolean", "FINAL_ATTESTATION_REQUIRE_GO_INVALID");
  const source = await readFile(await resolveTrustedRepositoryRegularFile(attestationPath), "utf8");
  const parsedAttestation = JSON.parse(source);
  const gateTrustRequired = Array.isArray(parsedAttestation.gateEvidence)
    && parsedAttestation.gateEvidence.some((gate) =>
      gate?.status === "PASS"
        && [
          "accessibility-browser",
          "cleanup-null-rest",
          "observability",
          "performance",
          "provider-boundaries",
          "public-form-funnel",
          "production-funnel-token-cutover",
          "runtime-logs",
          "security-supply-chain",
          "two-tenant-rbac-crud",
        ].includes(gate.id));
  const trustContext = parsedAttestation.status === "SIGNED" || gateTrustRequired
    ? await readApprovalTrustContext({
      approvalTrustAnchorPath,
      expectedApprovalTrustAnchorSha256,
    })
    : null;
  const attestation = validateFinalPreviewReleaseAttestation(parsedAttestation, { trustContext });
  if (attestation.status === "PENDING") {
    invariant(!requireGo, "FINAL_ATTESTATION_GO_REQUIRED");
    return Object.freeze({
      candidateCommit: null,
      decision: attestation.decision,
      ok: true,
      status: attestation.status,
      verificationStatus: "NOT_RUN",
    });
  }

  const repositoryProvenance = await verifyFinalPreviewRepositoryProvenance({
    attestation,
    attestationPath,
  });

  const documents = new Map();
  for (const binding of attestation.documents) {
    documents.set(
      binding.id,
      await readHashedBinding(binding, attestation.runtime.candidateCommit, {
        evidenceCommit: repositoryProvenance.evidenceCommit,
      }),
    );
  }
  for (const binding of attestation.gateEvidence.filter((entry) => entry.status !== "NOT_RUN")) {
    await readHashedBinding(binding, attestation.runtime.candidateCommit, {
      evidenceCommit: repositoryProvenance.evidenceCommit,
      expectedGateStatus: binding.status,
      gateDefinition: finalPreviewGateBindingById.get(binding.id),
      protectedWorkflowVerification,
      publicWorkflowVerification,
      runtime: attestation.runtime,
      trustContext,
    });
  }
  invariant(
    buildFinalPreviewDocumentBundleSha256(attestation) === attestation.documentBundleSha256,
    "FINAL_ATTESTATION_BUNDLE_DIGEST_MISMATCH",
  );
  validateReleaseDocumentCandidateState({
    attestation,
    companyProfileApproval: documents.get("company-profile-approval"),
    legalContentManifest: documents.get("legal-content-manifest"),
    releaseGateMatrix: documents.get("release-gate-matrix"),
    releaseSurfaceManifest: documents.get("release-surface-manifest"),
    trustContext,
  });
  await verifyLegalManifestCandidateSources({
    candidateCommit: attestation.runtime.candidateCommit,
    legalContentManifest: documents.get("legal-content-manifest"),
  });
  if (attestation.status === "SIGNED") {
    await Promise.all(signatureRoles.map((role) => verifyExternalApprovalArtifact({
      attestation,
      role,
      signature: attestation.signatures[role],
    })));
  }
  const recoveryVerification = await verifyRecoveryEvidenceForFinalAttestation({
    evidenceCommit: attestation.evidenceProvenance.evidenceCommit,
    expectedCandidateCommit: attestation.runtime.candidateCommit,
    repositoryProvenance,
    trustAnchor: recoveryTrustAnchor,
  });
  if (requireGo) {
    invariant(attestation.status === "SIGNED", "FINAL_ATTESTATION_GO_SIGNED_REQUIRED");
    invariant(attestation.decision === "GO", "FINAL_ATTESTATION_GO_DECISION_REQUIRED");
    invariant(
      attestation.gateEvidence.every((entry) => entry.status === "PASS"),
      "FINAL_ATTESTATION_GO_GATE_PASS_REQUIRED",
    );
    invariant(isPlainObject(trustContext), "FINAL_ATTESTATION_GO_TRUST_REQUIRED");
    assertFinalPreviewRecoveryGoResult(recoveryVerification, {
      expectedEvidenceCommit: attestation.evidenceProvenance.evidenceCommit,
    });
  }
  await verifyFinalPreviewRepositoryProvenance({ attestation, attestationPath });

  return Object.freeze({
    candidateCommit: attestation.runtime.candidateCommit,
    decision: attestation.decision,
    deploymentId: attestation.runtime.deploymentId,
    ok: true,
    status: attestation.status,
    verificationStatus: "PASS",
  });
}

export function assertFinalPreviewRecoveryGoResult(
  recoveryVerification,
  { expectedEvidenceCommit } = {},
) {
  invariant(
    isPlainObject(recoveryVerification),
    "FINAL_ATTESTATION_GO_RECOVERY_RESULT_INVALID",
  );
  invariant(
    recoveryVerification.status === "PASS",
    "FINAL_ATTESTATION_GO_RECOVERY_STATUS_NOT_PASS",
  );
  invariant(
    recoveryVerification.passEligible === true,
    "FINAL_ATTESTATION_GO_RECOVERY_NOT_PASS_ELIGIBLE",
  );
  invariant(
    recoveryVerification.signatureStatus === "VERIFIED",
    "FINAL_ATTESTATION_GO_RECOVERY_SIGNATURE_NOT_VERIFIED",
  );
  invariant(
    isCommitSha(expectedEvidenceCommit)
      && recoveryVerification.evidenceCommit === expectedEvidenceCommit,
    "FINAL_ATTESTATION_GO_RECOVERY_EVIDENCE_COMMIT_MISMATCH",
  );
  return recoveryVerification;
}

function parseCliArguments(argv) {
  const options = { attestationPath: defaultAttestationPath, requireGo: false };
  let attestationPathSeen = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--require-go") {
      invariant(!options.requireGo, "FINAL_ATTESTATION_CLI_DUPLICATE_ARGUMENT");
      options.requireGo = true;
      continue;
    }
    if (argument === "--attestation") {
      invariant(
        !attestationPathSeen && typeof argv[index + 1] === "string",
        "FINAL_ATTESTATION_CLI_ARGUMENT_INVALID",
      );
      attestationPathSeen = true;
      options.attestationPath = argv[index + 1];
      index += 1;
      continue;
    }
    invariant(false, "FINAL_ATTESTATION_CLI_ARGUMENT_INVALID");
  }
  return options;
}

function protectedWorkflowVerificationFromEnvironment(environment = process.env) {
  const values = {
    artifactPath: environment.NOVALURE_PROTECTED_WORKFLOW_ARTIFACT_PATH,
    attestationBundlePath: environment.NOVALURE_PROTECTED_WORKFLOW_ATTESTATION_BUNDLE_PATH,
    expectedSigstoreTrustedRootSha256:
      environment.NOVALURE_PROTECTED_WORKFLOW_SIGSTORE_TRUSTED_ROOT_SHA256,
    githubCliPath: environment.NOVALURE_PROTECTED_WORKFLOW_GITHUB_CLI_PATH,
    sigstoreTrustedRootPath:
      environment.NOVALURE_PROTECTED_WORKFLOW_SIGSTORE_TRUSTED_ROOT_PATH,
  };
  const supplied = Object.values(values).filter((value) => typeof value === "string" && value.length > 0);
  if (supplied.length === 0) return null;
  invariant(
    supplied.length === Object.keys(values).length,
    "FINAL_ATTESTATION_PROTECTED_WORKFLOW_VERIFICATION_ENV_INCOMPLETE",
  );
  return Object.freeze(values);
}

function publicWorkflowVerificationFromEnvironment(environment = process.env) {
  const values = {
    artifactPath: environment.NOVALURE_PUBLIC_WORKFLOW_ARTIFACT_PATH,
    attestationBundlePath: environment.NOVALURE_PUBLIC_WORKFLOW_ATTESTATION_BUNDLE_PATH,
    expectedSigstoreTrustedRootSha256:
      environment.NOVALURE_PUBLIC_WORKFLOW_SIGSTORE_TRUSTED_ROOT_SHA256,
    githubCliPath: environment.NOVALURE_PUBLIC_WORKFLOW_GITHUB_CLI_PATH,
    sigstoreTrustedRootPath: environment.NOVALURE_PUBLIC_WORKFLOW_SIGSTORE_TRUSTED_ROOT_PATH,
  };
  const supplied = Object.values(values).filter((value) => typeof value === "string" && value.length > 0);
  if (supplied.length === 0) return null;
  invariant(
    supplied.length === Object.keys(values).length,
    "FINAL_ATTESTATION_PUBLIC_WORKFLOW_VERIFICATION_ENV_INCOMPLETE",
  );
  return Object.freeze(values);
}

async function recoveryTrustAnchorFromEnvironment(environment = process.env) {
  const values = {
    expectedKeyId: environment.NOVALURE_RECOVERY_OBSERVER_KEY_ID,
    expectedPublicKeySha256: environment.NOVALURE_RECOVERY_OBSERVER_PUBLIC_KEY_SHA256,
    expectedSignerIdentity: environment.NOVALURE_RECOVERY_OBSERVER_IDENTITY,
    publicKeyPath: environment.NOVALURE_RECOVERY_OBSERVER_PUBLIC_KEY_PATH,
  };
  const supplied = Object.values(values).filter(
    (value) => typeof value === "string" && value.length > 0,
  );
  if (supplied.length === 0) return null;
  invariant(
    supplied.length === Object.keys(values).length,
    "FINAL_ATTESTATION_RECOVERY_TRUST_ENV_INCOMPLETE",
  );
  return loadExternalRecoveryTrustAnchor({
    environment,
    publicKeyPath: values.publicKeyPath,
    repositoryRoot,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const cli = parseCliArguments(process.argv.slice(2));
    console.log(JSON.stringify(await verifyFinalPreviewReleaseAttestation({
      approvalTrustAnchorPath: process.env.NOVALURE_RELEASE_APPROVAL_TRUST_ANCHOR_PATH ?? null,
      attestationPath: cli.attestationPath,
      expectedApprovalTrustAnchorSha256:
        process.env.NOVALURE_RELEASE_APPROVAL_TRUST_ANCHOR_SHA256 ?? null,
      protectedWorkflowVerification: protectedWorkflowVerificationFromEnvironment(),
      publicWorkflowVerification: publicWorkflowVerificationFromEnvironment(),
      recoveryTrustAnchor: await recoveryTrustAnchorFromEnvironment(),
      requireGo: cli.requireGo,
    })));
  } catch (error) {
    console.error(JSON.stringify({
      errorCode: error instanceof Error ? error.message : "FINAL_ATTESTATION_VERIFY_FAILED",
      ok: false,
    }));
    process.exitCode = 1;
  }
}
