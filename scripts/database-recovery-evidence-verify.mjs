#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { basename, dirname, relative, resolve, sep } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadExternalRecoveryTrustAnchor } from "./database-recovery-live-evidence.mjs";
import { verifyDatabaseRecoveryLiveEvidence } from "./lib/database-recovery-live-evidence.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifestRelativePath =
  "docs/audit/2026-08-23/database-recovery-evidence-manifest.json";
const maximumManifestBytes = 2 * 1_024 * 1_024;
const maximumEvidenceBytes = 16 * 1_024 * 1_024;
const maximumSidecarBytes = 512;
const safeRepositoryPathPattern = /^(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/u;

export const expectedRecoveryMigrationPlan = Object.freeze([
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

export const expectedExcludedMigrations = Object.freeze([
  "061_validate_and_activate_tenant_rls_pilot",
  "062_private_media_contract_cutover",
  "065_notification_guard_search_path_hardening",
]);

function invariant(condition, code) {
  if (!condition) throw new Error(code);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sameArray(actual, expected) {
  return Array.isArray(actual)
    && actual.length === expected.length
    && actual.every((value, index) => value === expected[index]);
}

function assertSafeRepositoryRelativePath(relativePath) {
  invariant(
    typeof relativePath === "string"
      && relativePath.length > 0
      && relativePath.length <= 1_024
      && !relativePath.includes("\\")
      && safeRepositoryPathPattern.test(relativePath)
      && !relativePath.split("/").some((segment) => segment === "." || segment === "..")
      && !/^[a-z][a-z0-9+.-]*:/iu.test(relativePath),
    "RECOVERY_EVIDENCE_PATH_INVALID",
  );
  return relativePath;
}

function pathIsWithin(root, target) {
  const targetRelative = relative(root, target);
  return targetRelative !== ""
    && targetRelative !== ".."
    && !targetRelative.startsWith(`..${sep}`);
}

function sameResolvedPath(left, right) {
  const normalize = (value) => {
    const normalized = resolve(value).replace(/^\\\\\?\\/u, "");
    return process.platform === "win32" ? normalized.toLowerCase() : normalized;
  };
  return normalize(left) === normalize(right);
}

async function assertNoRecoveryPathReparse({ root, target }) {
  const resolvedRoot = resolve(root);
  const resolvedTarget = resolve(target);
  invariant(
    sameResolvedPath(resolvedRoot, resolvedTarget)
      || pathIsWithin(resolvedRoot, resolvedTarget),
    "RECOVERY_EVIDENCE_PATH_ESCAPED_REPOSITORY",
  );

  const rootStat = await lstat(resolvedRoot);
  invariant(
    rootStat.isDirectory() && !rootStat.isSymbolicLink(),
    "RECOVERY_EVIDENCE_REPOSITORY_ROOT_REPARSE",
  );
  const realRoot = await realpath(resolvedRoot);
  invariant(
    sameResolvedPath(realRoot, resolvedRoot),
    "RECOVERY_EVIDENCE_REPOSITORY_ROOT_REPARSE",
  );

  const pathSegments = relative(resolvedRoot, resolvedTarget).split(sep).filter(Boolean);
  let current = resolvedRoot;
  for (const [index, segment] of pathSegments.entries()) {
    current = resolve(current, segment);
    const component = await lstat(current);
    invariant(
      !component.isSymbolicLink(),
      "RECOVERY_EVIDENCE_PATH_COMPONENT_REPARSE",
    );
    if (index < pathSegments.length - 1) {
      invariant(component.isDirectory(), "RECOVERY_EVIDENCE_PATH_COMPONENT_NOT_DIRECTORY");
    }
    const realComponent = await realpath(current);
    invariant(
      sameResolvedPath(realComponent, current),
      "RECOVERY_EVIDENCE_PATH_COMPONENT_REPARSE",
    );
  }
}

function resolveRepositoryFile(relativePath, root = repositoryRoot) {
  assertSafeRepositoryRelativePath(relativePath);
  const target = resolve(root, relativePath);
  const targetRelative = relative(root, target);
  invariant(
    targetRelative !== ""
      && targetRelative !== ".."
      && !targetRelative.startsWith(`..${sep}`),
    "RECOVERY_EVIDENCE_PATH_ESCAPED_REPOSITORY",
  );
  return target;
}

function sameFileIdentity(left, right) {
  return left.size === right.size
    && (left.dev === undefined || right.dev === undefined || left.dev === right.dev)
    && (left.ino === undefined || right.ino === undefined || left.ino === right.ino);
}

export async function readBoundedRegularRecoveryFile({
  absolutePath,
  maximumBytes = maximumEvidenceBytes,
  repositoryRoot: root = repositoryRoot,
}) {
  invariant(Number.isSafeInteger(maximumBytes) && maximumBytes > 0, "RECOVERY_FILE_BOUND_INVALID");
  const resolvedRoot = resolve(root);
  const resolvedPath = resolve(absolutePath);
  invariant(pathIsWithin(resolvedRoot, resolvedPath), "RECOVERY_EVIDENCE_PATH_ESCAPED_REPOSITORY");
  await assertNoRecoveryPathReparse({ root: resolvedRoot, target: resolvedPath });
  const before = await lstat(resolvedPath);
  invariant(
    before.isFile()
      && !before.isSymbolicLink()
      && before.nlink === 1
      && before.size > 0
      && before.size <= maximumBytes,
    "RECOVERY_EVIDENCE_FILE_NOT_BOUNDED_REGULAR",
  );
  const [realRoot, realTarget] = await Promise.all([realpath(resolvedRoot), realpath(resolvedPath)]);
  invariant(pathIsWithin(realRoot, realTarget), "RECOVERY_EVIDENCE_REALPATH_ESCAPED_REPOSITORY");
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  let handle;
  try {
    handle = await open(resolvedPath, fsConstants.O_RDONLY | noFollow);
    const opened = await handle.stat();
    invariant(
      opened.isFile()
        && opened.nlink === 1
        && opened.size > 0
        && opened.size <= maximumBytes
        && sameFileIdentity(before, opened),
      "RECOVERY_EVIDENCE_FILE_CHANGED_DURING_OPEN",
    );
    const source = await handle.readFile();
    invariant(source.byteLength === opened.size, "RECOVERY_EVIDENCE_FILE_TRUNCATED_DURING_READ");
    await assertNoRecoveryPathReparse({ root: resolvedRoot, target: resolvedPath });
    const after = await lstat(resolvedPath);
    invariant(
      after.isFile()
        && !after.isSymbolicLink()
        && after.nlink === 1
        && sameFileIdentity(opened, after),
      "RECOVERY_EVIDENCE_FILE_CHANGED_DURING_READ",
    );
    return source;
  } finally {
    await handle?.close();
  }
}

function gitResult(args, { encoding = null, maximumBytes = maximumEvidenceBytes, root }) {
  return spawnSync("git", args, {
    cwd: root,
    encoding,
    maxBuffer: maximumBytes,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function gitOutput(args, { encoding = null, maximumBytes = maximumEvidenceBytes, root }) {
  const result = gitResult(args, { encoding, maximumBytes, root });
  invariant(result.status === 0, "RECOVERY_EVIDENCE_GIT_READ_FAILED");
  return encoding ? result.stdout.trim() : result.stdout;
}

function requireGitCommit(root, commit, code) {
  const result = gitResult(
    ["rev-parse", "--verify", `${commit}^{commit}`],
    { encoding: "utf8", maximumBytes: 256, root },
  );
  invariant(result.status === 0 && result.stdout.trim() === commit, code);
}

function resolveHeadCommit(root) {
  const head = gitOutput(
    ["rev-parse", "--verify", "HEAD^{commit}"],
    { encoding: "utf8", maximumBytes: 256, root },
  );
  invariant(/^[a-f0-9]{40}$/u.test(head), "RECOVERY_EVIDENCE_HEAD_INVALID");
  return head;
}

function matchesCommittedBytesOrCrlfCheckout(worktreeSource, committedSource) {
  if (worktreeSource.equals(committedSource)) return true;
  // Git may materialize an LF-only tracked text blob as CRLF when core.autocrlf
  // is enabled. Accept only that byte-for-byte expansion, while continuing to
  // return and hash the immutable committed blob below.
  if (committedSource.includes(0x0d)) return false;

  let worktreeIndex = 0;
  let committedIndex = 0;
  let expandedLineEnding = false;
  while (
    worktreeIndex < worktreeSource.byteLength
      && committedIndex < committedSource.byteLength
  ) {
    if (worktreeSource[worktreeIndex] === committedSource[committedIndex]) {
      worktreeIndex += 1;
      committedIndex += 1;
      continue;
    }
    if (
      worktreeSource[worktreeIndex] === 0x0d
        && worktreeSource[worktreeIndex + 1] === 0x0a
        && committedSource[committedIndex] === 0x0a
    ) {
      expandedLineEnding = true;
      worktreeIndex += 2;
      committedIndex += 1;
      continue;
    }
    return false;
  }
  return expandedLineEnding
    && worktreeIndex === worktreeSource.byteLength
    && committedIndex === committedSource.byteLength;
}

async function requireEvidenceCheckoutBinding({ evidenceCommit, root }) {
  await assertNoRecoveryPathReparse({ root, target: root });
  requireGitCommit(root, evidenceCommit, "RECOVERY_EVIDENCE_COMMIT_NOT_FOUND");
  const head = gitOutput(
    ["rev-parse", "--verify", "HEAD^{commit}"],
    { encoding: "utf8", maximumBytes: 256, root },
  );
  invariant(head === evidenceCommit, "RECOVERY_EVIDENCE_HEAD_MISMATCH");
  const status = gitOutput(
    ["status", "--porcelain=v1", "--untracked-files=all"],
    { encoding: "utf8", maximumBytes: maximumEvidenceBytes, root },
  );
  invariant(status === "", "RECOVERY_EVIDENCE_WORKTREE_DIRTY");
}

async function requireFinalRepositoryProvenanceBinding({
  evidenceCommit,
  repositoryProvenance,
  root,
}) {
  invariant(
    repositoryProvenance
      && typeof repositoryProvenance === "object"
      && repositoryProvenance.status === "PASS"
      && repositoryProvenance.evidenceCommit === evidenceCommit
      && /^[a-f0-9]{40}$/u.test(repositoryProvenance.head),
    "RECOVERY_FINAL_REPOSITORY_PROVENANCE_INVALID",
  );
  await assertNoRecoveryPathReparse({ root, target: root });
  requireGitCommit(root, evidenceCommit, "RECOVERY_EVIDENCE_COMMIT_NOT_FOUND");
  requireGitCommit(
    root,
    repositoryProvenance.head,
    "RECOVERY_FINAL_REPOSITORY_HEAD_NOT_FOUND",
  );
  const head = gitOutput(
    ["rev-parse", "--verify", "HEAD^{commit}"],
    { encoding: "utf8", maximumBytes: 256, root },
  );
  invariant(head === repositoryProvenance.head, "RECOVERY_FINAL_REPOSITORY_HEAD_MISMATCH");
  const status = gitOutput(
    ["status", "--porcelain=v1", "--untracked-files=all"],
    { encoding: "utf8", maximumBytes: maximumEvidenceBytes, root },
  );
  invariant(status === "", "RECOVERY_FINAL_REPOSITORY_WORKTREE_DIRTY");
  const ancestry = gitResult(
    ["merge-base", "--is-ancestor", evidenceCommit, repositoryProvenance.head],
    { encoding: "utf8", maximumBytes: 256, root },
  );
  invariant(
    ancestry.status === 0,
    ancestry.status === 1
      ? "RECOVERY_FINAL_EVIDENCE_COMMIT_NOT_ANCESTOR"
      : "RECOVERY_EVIDENCE_GIT_READ_FAILED",
  );
}

function requireCandidateAncestry({ candidateCommit, evidenceCommit, root }) {
  requireGitCommit(root, candidateCommit, "RECOVERY_CANDIDATE_COMMIT_NOT_FOUND");
  const ancestry = gitResult(
    ["merge-base", "--is-ancestor", candidateCommit, evidenceCommit],
    { encoding: "utf8", maximumBytes: 256, root },
  );
  invariant(
    ancestry.status === 0,
    ancestry.status === 1
      ? "RECOVERY_CANDIDATE_NOT_ANCESTOR_OF_EVIDENCE"
      : "RECOVERY_EVIDENCE_GIT_READ_FAILED",
  );
}

export async function readCommittedRegularRecoveryFile({
  evidenceCommit,
  maximumBytes = maximumEvidenceBytes,
  relativePath,
  repositoryRoot: root = repositoryRoot,
  requireWorktreeMatch = true,
}) {
  invariant(/^[a-f0-9]{40}$/u.test(evidenceCommit), "RECOVERY_EVIDENCE_COMMIT_INVALID");
  assertSafeRepositoryRelativePath(relativePath);
  const treeLine = gitOutput(
    ["ls-tree", evidenceCommit, "--", relativePath],
    { encoding: "utf8", maximumBytes: 4_096, root },
  );
  const match = treeLine.match(/^(100644|100755) blob ([a-f0-9]{40,64})\t(.+)$/u);
  invariant(match && match[3] === relativePath, "RECOVERY_EVIDENCE_COMMITTED_FILE_NOT_REGULAR");
  const blobSize = Number(gitOutput(
    ["cat-file", "-s", match[2]],
    { encoding: "utf8", maximumBytes: 128, root },
  ));
  invariant(
    Number.isSafeInteger(blobSize) && blobSize > 0 && blobSize <= maximumBytes,
    "RECOVERY_EVIDENCE_COMMITTED_FILE_BOUND_INVALID",
  );
  const source = gitOutput(
    ["cat-file", "blob", match[2]],
    { maximumBytes, root },
  );
  invariant(source.byteLength === blobSize, "RECOVERY_EVIDENCE_COMMITTED_FILE_SIZE_MISMATCH");
  if (requireWorktreeMatch) {
    const worktreeSource = await readBoundedRegularRecoveryFile({
      absolutePath: resolveRepositoryFile(relativePath, root),
      maximumBytes,
      repositoryRoot: root,
    });
    invariant(
      matchesCommittedBytesOrCrlfCheckout(worktreeSource, source),
      "RECOVERY_EVIDENCE_CURRENT_WORKTREE_DRIFT",
    );
  }
  return source;
}

async function readRecoveryArtifact(relativePath, {
  evidenceCommit = null,
  maximumBytes = maximumEvidenceBytes,
  requireWorktreeMatch = true,
  root = repositoryRoot,
} = {}) {
  assertSafeRepositoryRelativePath(relativePath);
  if (evidenceCommit) {
    return readCommittedRegularRecoveryFile({
      evidenceCommit,
      maximumBytes,
      relativePath,
      repositoryRoot: root,
      requireWorktreeMatch,
    });
  }
  return readBoundedRegularRecoveryFile({
    absolutePath: resolveRepositoryFile(relativePath, root),
    maximumBytes,
    repositoryRoot: root,
  });
}

function parseSidecar(source, expectedFileName) {
  const match = String(source).trim().match(/^([a-f0-9]{64})  ([^\r\n]+)$/u);
  invariant(match, "RECOVERY_EVIDENCE_SIDECAR_INVALID");
  invariant(match[2] === expectedFileName, "RECOVERY_EVIDENCE_SIDECAR_FILENAME_MISMATCH");
  return match[1];
}

async function readHashedJson(entry, options = {}) {
  invariant(entry && typeof entry === "object", "RECOVERY_EVIDENCE_ENTRY_INVALID");
  invariant(/^[a-f0-9]{64}$/u.test(entry.sha256), "RECOVERY_EVIDENCE_DIGEST_INVALID");
  const path = resolveRepositoryFile(entry.path, options.root);
  const [source, sidecar] = await Promise.all([
    readRecoveryArtifact(entry.path, { ...options, maximumBytes: maximumEvidenceBytes }),
    readRecoveryArtifact(entry.sidecarPath, { ...options, maximumBytes: maximumSidecarBytes }),
  ]);
  const actualDigest = sha256(source);
  invariant(actualDigest === entry.sha256, "RECOVERY_EVIDENCE_MANIFEST_DIGEST_MISMATCH");
  invariant(
    parseSidecar(sidecar.toString("utf8"), basename(path)) === actualDigest,
    "RECOVERY_EVIDENCE_SIDECAR_DIGEST_MISMATCH",
  );
  return {
    digest: actualDigest,
    inventory: Object.freeze([
      Object.freeze({
        byteLength: source.byteLength,
        kind: "JSON",
        path: entry.path,
        sha256: actualDigest,
      }),
      Object.freeze({
        byteLength: sidecar.byteLength,
        kind: "SHA256_SIDECAR",
        path: entry.sidecarPath,
        sha256: sha256(sidecar),
      }),
    ]),
    json: JSON.parse(source.toString("utf8")),
    source,
  };
}

function validateLedger(ledger) {
  invariant(ledger && typeof ledger === "object", "RECOVERY_LEDGER_INVALID");
  invariant(ledger.count === 19, "RECOVERY_LEDGER_COUNT_MISMATCH");
  invariant(
    ledger.maxVersion === "067_app_role_runtime_grants",
    "RECOVERY_LEDGER_MAX_VERSION_MISMATCH",
  );
}

export function buildRecoveryDataFingerprint({ migrationLedger, rowCounts }) {
  validateLedger(migrationLedger);
  invariant(rowCounts && typeof rowCounts === "object", "RECOVERY_ROW_COUNTS_INVALID");
  const entries = Object.entries(rowCounts).sort(([left], [right]) => left.localeCompare(right));
  invariant(entries.length === 19, "RECOVERY_ROW_TABLE_COUNT_MISMATCH");
  for (const [table, count] of entries) {
    invariant(/^[a-z][a-z0-9_]*$/u.test(table), "RECOVERY_ROW_TABLE_NAME_INVALID");
    invariant(Number.isSafeInteger(count) && count >= 0, "RECOVERY_ROW_COUNT_INVALID");
  }
  const canonical = JSON.stringify({
    migrationLedger: {
      count: migrationLedger.count,
      maxVersion: migrationLedger.maxVersion,
    },
    rowCounts: Object.fromEntries(entries),
  });
  return sha256(canonical);
}

function validateFingerprint(subject, expectedDigest) {
  invariant(subject && typeof subject === "object", "RECOVERY_FINGERPRINT_SUBJECT_INVALID");
  const digest = buildRecoveryDataFingerprint(subject);
  invariant(subject.dataFingerprintSha256 === digest, "RECOVERY_DATA_FINGERPRINT_INVALID");
  invariant(digest === expectedDigest, "RECOVERY_DATA_FINGERPRINT_MISMATCH");
  return digest;
}

function scanForSecretMaterial(sources) {
  const combined = sources.map((source) => source.toString("utf8")).join("\n");
  for (const forbidden of [
    /postgres(?:ql)?:\/\/[^\s"'<>]+/iu,
    /_vercel_share=/iu,
    /vercel_blob_rw_/iu,
    /(?:^|[^a-z0-9])(?:sk|pk)_(?:live|test)_[a-z0-9_-]{12,}/imu,
    /(?:^|[^a-z0-9])(?:github_pat_|gh[pousr]_)[a-z0-9_]{12,}/imu,
    /(?:^|[^a-z0-9])(?:napi_|vercel_|xox[baprs]-)[a-z0-9_-]{12,}/imu,
    /(?:^|[^A-Z0-9])AKIA[A-Z0-9]{16}(?:$|[^A-Z0-9])/mu,
    /(?:password|passwd)\s*[:=]\s*[^\s,}]+/iu,
  ]) {
    invariant(!forbidden.test(combined), "RECOVERY_EVIDENCE_SECRET_PATTERN_DETECTED");
  }
}

function validateRehearsalEvidence(evidence, manifest) {
  invariant(evidence.status === "PASS", "RECOVERY_REHEARSAL_SELECTED_EVIDENCE_NOT_PASS");
  invariant(
    evidence.candidateCommit === manifest.candidateCommit,
    "RECOVERY_REHEARSAL_CANDIDATE_MISMATCH",
  );
  invariant(
    evidence.branchId === manifest.rollback.resetRecoveryBranchId,
    "RECOVERY_REHEARSAL_BRANCH_MISMATCH",
  );
  invariant(evidence.environment === "RECOVERY_BRANCH_ONLY", "RECOVERY_REHEARSAL_SCOPE_INVALID");
  invariant(evidence.productionMutationPerformed === false, "RECOVERY_PRODUCTION_MUTATION_RECORDED");
  invariant(evidence.migration061Executed === false, "RECOVERY_MIGRATION_061_RECORDED");
  invariant(
    sameArray(evidence.records?.map((record) => record.version), expectedRecoveryMigrationPlan),
    "RECOVERY_REHEARSAL_PLAN_MISMATCH",
  );
  invariant(
    evidence.records.every(
      (record) => record.dryRun === "PASS"
        && record.up === "PASS"
        && /^[a-f0-9]{64}$/u.test(record.checksum),
    ),
    "RECOVERY_REHEARSAL_RECORD_NOT_PASS",
  );
}

function validateRollbackEvidence(evidence, manifest) {
  invariant(evidence.status === "PASS", "RECOVERY_ROLLBACK_EVIDENCE_NOT_PASS");
  invariant(
    evidence.candidateCommit === manifest.candidateCommit,
    "RECOVERY_ROLLBACK_CANDIDATE_MISMATCH",
  );
  invariant(evidence.productionMutationPerformed === false, "RECOVERY_ROLLBACK_PRODUCTION_MUTATION");
  invariant(
    evidence.productionAliasOrEnvironmentChanged === false,
    "RECOVERY_ROLLBACK_PRODUCTION_ENVIRONMENT_CHANGED",
  );
  invariant(
    sameArray(evidence.explicitlyExcludedMigrations, expectedExcludedMigrations),
    "RECOVERY_ROLLBACK_EXCLUSION_MISMATCH",
  );
  const selectedPass = manifest.evidence.find((entry) => entry.role === "SELECTED_PASS");
  invariant(
    evidence.rehearsal.selectedEvidencePath === selectedPass?.path
      && evidence.rehearsal.selectedEvidenceSha256 === selectedPass?.sha256,
    "RECOVERY_ROLLBACK_REHEARSAL_SOURCE_MISMATCH",
  );
  invariant(
    evidence.rehearsal.preservedMigratedBranchId === manifest.rollback.preservedMigratedBranchId,
    "RECOVERY_PRESERVED_BRANCH_MISMATCH",
  );
  invariant(
    evidence.reset.resetRecoveryBranchId === manifest.rollback.resetRecoveryBranchId,
    "RECOVERY_RESET_BRANCH_MISMATCH",
  );
  invariant(
    evidence.rehearsal.preservedMigratedBranchId !== evidence.reset.resetRecoveryBranchId,
    "RECOVERY_ROLLBACK_BRANCHES_NOT_SEPARATE",
  );
  invariant(
    sameArray(evidence.rehearsal.appliedMigrations, expectedRecoveryMigrationPlan),
    "RECOVERY_ROLLBACK_PLAN_MISMATCH",
  );
  invariant(evidence.reset.comparisonResult === "PASS", "RECOVERY_RESET_COMPARISON_NOT_PASS");
  invariant(evidence.reset.rowCountMismatchCount === 0, "RECOVERY_RESET_ROW_COUNT_MISMATCH");
  const productionDigest = validateFingerprint(
    evidence.reset.productionFingerprint,
    manifest.rollback.dataFingerprintSha256,
  );
  const resetDigest = validateFingerprint(
    evidence.reset.recoveryFingerprint,
    manifest.rollback.dataFingerprintSha256,
  );
  invariant(productionDigest === resetDigest, "RECOVERY_RESET_FINGERPRINTS_DIFFER");
  invariant(
    evidence.schemaDiffApi.status === manifest.schemaDiffApi.status
      && evidence.schemaDiffApi.countedAsPassEvidence
        === manifest.schemaDiffApi.countedAsPassEvidence
      && (evidence.schemaDiffApi.diffSha256 ?? null)
        === (manifest.schemaDiffApi.diffSha256 ?? null),
    "RECOVERY_ROLLBACK_SCHEMA_DIFF_MISMATCH",
  );
}

async function verifyRecoveryEvidenceInternal({
  evidenceCommit = null,
  expectedCandidateCommit = null,
  finalRepositoryProvenance = null,
  repositoryRoot: root = repositoryRoot,
  trustAnchor = null,
} = {}) {
  invariant(
    expectedCandidateCommit === null || /^[a-f0-9]{40}$/u.test(expectedCandidateCommit),
    "RECOVERY_EXPECTED_CANDIDATE_INVALID",
  );
  invariant(
    evidenceCommit === null || /^[a-f0-9]{40}$/u.test(evidenceCommit),
    "RECOVERY_EVIDENCE_COMMIT_INVALID",
  );
  invariant(
    finalRepositoryProvenance === null || evidenceCommit !== null,
    "RECOVERY_FINAL_EVIDENCE_COMMIT_REQUIRED",
  );
  const requireWorktreeMatch = finalRepositoryProvenance === null;
  if (evidenceCommit !== null) {
    if (finalRepositoryProvenance === null) {
      await requireEvidenceCheckoutBinding({ evidenceCommit, root });
    } else {
      await requireFinalRepositoryProvenanceBinding({
        evidenceCommit,
        repositoryProvenance: finalRepositoryProvenance,
        root,
      });
    }
  }
  // Historical/PENDING verification is still bound to tracked bytes. Reading
  // HEAD also avoids hashing a platform-specific CRLF checkout representation.
  const artifactCommit = evidenceCommit ?? resolveHeadCommit(root);
  const manifestPath = resolveRepositoryFile(manifestRelativePath, root);
  const [manifestSource, manifestSidecar] = await Promise.all([
    readRecoveryArtifact(manifestRelativePath, {
      evidenceCommit: artifactCommit,
      maximumBytes: maximumManifestBytes,
      requireWorktreeMatch,
      root,
    }),
    readRecoveryArtifact(`${manifestRelativePath}.sha256`, {
      evidenceCommit: artifactCommit,
      maximumBytes: maximumSidecarBytes,
      requireWorktreeMatch,
      root,
    }),
  ]);
  const manifestDigest = sha256(manifestSource);
  invariant(
    parseSidecar(manifestSidecar.toString("utf8"), basename(manifestPath)) === manifestDigest,
    "RECOVERY_MANIFEST_SIDECAR_DIGEST_MISMATCH",
  );
  const manifest = JSON.parse(manifestSource.toString("utf8"));
  invariant(
    manifest.schemaVersion === 1 || manifest.schemaVersion === 2,
    "RECOVERY_MANIFEST_SCHEMA_UNSUPPORTED",
  );
  if (manifest.schemaVersion === 2) {
    invariant(evidenceCommit !== null, "RECOVERY_FINAL_EVIDENCE_COMMIT_REQUIRED");
    invariant(
      expectedCandidateCommit !== null,
      "RECOVERY_FINAL_EXPECTED_CANDIDATE_REQUIRED",
    );
  }
  invariant(
    (manifest.schemaVersion === 1 && manifest.status === "CURRENT_SHA_REHEARSAL_AND_RESET_PASS")
      || (manifest.schemaVersion === 2
        && ["CURRENT_SHA_REHEARSAL_AND_RESET_PASS", "RECOVERY_BLOCKED_UNPROVEN"].includes(manifest.status)),
    "RECOVERY_MANIFEST_STATUS_INVALID",
  );
  invariant(/^[a-f0-9]{40}$/u.test(manifest.candidateCommit), "RECOVERY_CANDIDATE_INVALID");
  invariant(
    expectedCandidateCommit === null || manifest.candidateCommit === expectedCandidateCommit,
    "RECOVERY_EXPECTED_CANDIDATE_MISMATCH",
  );
  if (evidenceCommit !== null) {
    requireCandidateAncestry({
      candidateCommit: manifest.candidateCommit,
      evidenceCommit,
      root,
    });
  }
  invariant(manifest.productionMutationPerformed === false, "RECOVERY_MANIFEST_PRODUCTION_MUTATION");
  invariant(
    sameArray(manifest.explicitlyExcludedMigrations, expectedExcludedMigrations),
    "RECOVERY_MANIFEST_EXCLUSION_MISMATCH",
  );
  const schemaDiffUnavailable =
    manifest.schemaDiffApi.status === "UNAVAILABLE_HTTP_413_TOOL_LIMIT"
      && manifest.schemaDiffApi.countedAsPassEvidence === false
      && (manifest.schemaVersion === 1 || manifest.schemaDiffApi.diffSha256 === null);
  const schemaDiffPass =
    manifest.schemaVersion === 2
      && manifest.schemaDiffApi.status === "PASS_EMPTY"
      && manifest.schemaDiffApi.countedAsPassEvidence === true
      && manifest.schemaDiffApi.diffSha256 === sha256("");
  invariant(schemaDiffUnavailable || schemaDiffPass, "RECOVERY_MANIFEST_SCHEMA_DIFF_MISREPRESENTED");
  invariant(manifest.rollback.tableCount === 19, "RECOVERY_MANIFEST_TABLE_COUNT_INVALID");
  invariant(manifest.rollback.migrationLedgerCount === 19, "RECOVERY_MANIFEST_LEDGER_COUNT_INVALID");
  invariant(
    manifest.rollback.migrationLedgerMaxVersion === "067_app_role_runtime_grants",
    "RECOVERY_MANIFEST_LEDGER_MAX_INVALID",
  );
  invariant(manifest.rollback.rowCountMismatchCount === 0, "RECOVERY_MANIFEST_ROW_MISMATCH");

  invariant(Array.isArray(manifest.evidence), "RECOVERY_EVIDENCE_LIST_INVALID");
  const selectedEntries = manifest.evidence.filter((entry) => entry.role === "SELECTED_PASS");
  const failedEntries = manifest.evidence.filter((entry) => entry.role === "EXCLUDED_FAILED_ATTEMPT");
  const rollbackEntries = manifest.evidence.filter((entry) => entry.role === "ROLLBACK_RESET_PASS");
  const liveEntries = manifest.evidence.filter(
    (entry) => entry.role === "FINAL_LIVE_COLLECTOR_PASS",
  );
  invariant(selectedEntries.length === 1, "RECOVERY_SELECTED_PASS_CARDINALITY_INVALID");
  invariant(selectedEntries[0].passEligible === true, "RECOVERY_SELECTED_PASS_NOT_ELIGIBLE");
  invariant(rollbackEntries.length === 1, "RECOVERY_ROLLBACK_CARDINALITY_INVALID");
  invariant(
    liveEntries.length === (manifest.schemaVersion === 2 ? 1 : 0),
    "RECOVERY_LIVE_COLLECTOR_CARDINALITY_INVALID",
  );
  if (liveEntries.length === 1) {
    invariant(
      typeof liveEntries[0].passEligible === "boolean",
      "RECOVERY_LIVE_COLLECTOR_ELIGIBILITY_INVALID",
    );
  }
  invariant(
    selectedEntries.length + failedEntries.length + rollbackEntries.length + liveEntries.length
      === manifest.evidence.length,
    "RECOVERY_EVIDENCE_ROLE_INVALID",
  );

  const sources = [manifestSource];
  const inventory = [
    Object.freeze({
      byteLength: manifestSource.byteLength,
      kind: "JSON",
      path: manifestRelativePath,
      role: "RECOVERY_MANIFEST",
      sha256: manifestDigest,
    }),
    Object.freeze({
      byteLength: manifestSidecar.byteLength,
      kind: "SHA256_SIDECAR",
      path: `${manifestRelativePath}.sha256`,
      role: "RECOVERY_MANIFEST_SIDECAR",
      sha256: sha256(manifestSidecar),
    }),
  ];
  const artifactReadOptions = {
    evidenceCommit: artifactCommit,
    requireWorktreeMatch,
    root,
  };
  const selected = await readHashedJson(selectedEntries[0], artifactReadOptions);
  inventory.push(...selected.inventory.map((entry) => Object.freeze({
    ...entry,
    role: "SELECTED_PASS",
  })));
  sources.push(selected.source);
  validateRehearsalEvidence(selected.json, manifest);

  for (const entry of failedEntries) {
    invariant(entry.passEligible === false, "RECOVERY_FAILED_ATTEMPT_NOT_EXCLUDED");
    const failed = await readHashedJson(entry, artifactReadOptions);
    inventory.push(...failed.inventory.map((item) => Object.freeze({
      ...item,
      role: "EXCLUDED_FAILED_ATTEMPT",
    })));
    sources.push(failed.source);
    invariant(failed.json.status === "FAIL", "RECOVERY_EXCLUDED_ATTEMPT_NOT_FAIL");
    invariant(
      failed.json.candidateCommit === manifest.candidateCommit,
      "RECOVERY_FAILED_ATTEMPT_CANDIDATE_MISMATCH",
    );
  }

  const rollback = await readHashedJson(rollbackEntries[0], artifactReadOptions);
  inventory.push(...rollback.inventory.map((entry) => Object.freeze({
    ...entry,
    role: "ROLLBACK_RESET_PASS",
  })));
  sources.push(rollback.source);
  validateRollbackEvidence(rollback.json, manifest);
  let liveTechnicalStatus = "HISTORICAL_ONLY";
  let liveAttestationVerified = false;
  if (liveEntries.length === 1) {
    const live = await readHashedJson(liveEntries[0], artifactReadOptions);
    inventory.push(...live.inventory.map((entry) => Object.freeze({
      ...entry,
      role: "FINAL_LIVE_COLLECTOR_PASS",
    })));
    sources.push(live.source);
    const liveVerification = verifyDatabaseRecoveryLiveEvidence({
      evidence: live.json,
      expectedCandidateCommit: manifest.candidateCommit,
      trustAnchor,
    });
    liveTechnicalStatus = liveVerification.status;
    liveAttestationVerified = live.json.provenance?.status === "VERIFIED"
      && live.json.provenance.externalAttestation?.algorithm === "Ed25519";
    invariant(
      liveEntries[0].passEligible === live.json.passEligible,
      "RECOVERY_LIVE_PASS_ELIGIBILITY_MISMATCH",
    );
    if (liveVerification.status === "PASS") {
      invariant(
        liveAttestationVerified,
        "RECOVERY_LIVE_PASS_REQUIRES_VERIFIED_ATTESTATION",
      );
      invariant(live.json.passEligible === true, "RECOVERY_LIVE_PASS_NOT_ELIGIBLE");
      invariant(
        manifest.status === "CURRENT_SHA_REHEARSAL_AND_RESET_PASS",
        "RECOVERY_MANIFEST_PASS_STATUS_MISMATCH",
      );
      invariant(schemaDiffPass, "RECOVERY_LIVE_PASS_REQUIRES_EMPTY_SCHEMA_DIFF");
    } else {
      invariant(liveVerification.status === "BLOCKED", "RECOVERY_LIVE_STATUS_INVALID");
      invariant(live.json.passEligible === false, "RECOVERY_LIVE_BLOCKED_MARKED_ELIGIBLE");
      invariant(
        manifest.status === "RECOVERY_BLOCKED_UNPROVEN",
        "RECOVERY_MANIFEST_BLOCKED_STATUS_MISMATCH",
      );
    }
    invariant(
      live.json.branches.preservedMigratedBranchId === manifest.rollback.preservedMigratedBranchId,
      "RECOVERY_LIVE_PRESERVED_BRANCH_MISMATCH",
    );
    invariant(
      live.json.branches.recoveryBranchId === manifest.rollback.resetRecoveryBranchId,
      "RECOVERY_LIVE_RESET_BRANCH_MISMATCH",
    );
    invariant(
      live.json.schemaDiff.status === manifest.schemaDiffApi.status
        && live.json.schemaDiff.countedAsPassEvidence
          === manifest.schemaDiffApi.countedAsPassEvidence
        && live.json.schemaDiff.diffSha256 === (manifest.schemaDiffApi.diffSha256 ?? null),
      "RECOVERY_LIVE_SCHEMA_DIFF_MISMATCH",
    );
  }
  scanForSecretMaterial(sources);

  const verifiedSignatureStatus = liveAttestationVerified
    ? "VERIFIED"
    : "PENDING_SIGNATURE";
  invariant(
    manifest.signatureStatus === verifiedSignatureStatus,
    "RECOVERY_SIGNATURE_STATUS_INVALID",
  );

  invariant(
    new Set(inventory.map((entry) => entry.path)).size === inventory.length,
    "RECOVERY_EVIDENCE_INVENTORY_PATH_DUPLICATE",
  );
  const historicalOnly = manifest.schemaVersion === 1;
  const technicalPassEligible = !historicalOnly
    && evidenceCommit !== null
    && liveTechnicalStatus === "PASS"
    && manifest.status === "CURRENT_SHA_REHEARSAL_AND_RESET_PASS"
    && schemaDiffPass;
  const releasePassEligible = technicalPassEligible
    && liveAttestationVerified
    && verifiedSignatureStatus === "VERIFIED";

  return Object.freeze({
    candidateCommit: manifest.candidateCommit,
    declaredManifestStatus: manifest.status,
    evidenceCommit,
    excludedFailedAttempts: failedEntries.length,
    historicalOnly,
    inventory: Object.freeze(inventory),
    manifestDigest,
    liveEvidenceCount: liveEntries.length,
    liveTechnicalStatus,
    migrationCount: expectedRecoveryMigrationPlan.length,
    ok: true,
    passEligible: releasePassEligible,
    productionMutationPerformed: false,
    resetRecoveryBranchId: manifest.rollback.resetRecoveryBranchId,
    signatureStatus: verifiedSignatureStatus,
    status: releasePassEligible ? "PASS" : "BLOCKED",
    technicalPassEligible,
  });
}

export async function verifyRecoveryEvidence(options = {}) {
  return verifyRecoveryEvidenceInternal(options);
}

export async function verifyRecoveryEvidenceForFinalAttestation({
  evidenceCommit,
  expectedCandidateCommit,
  repositoryProvenance,
  repositoryRoot: root = repositoryRoot,
  trustAnchor = null,
} = {}) {
  return verifyRecoveryEvidenceInternal({
    evidenceCommit,
    expectedCandidateCommit,
    finalRepositoryProvenance: repositoryProvenance,
    repositoryRoot: root,
    trustAnchor,
  });
}

export async function collectRecoveryEvidenceInventory(options = {}) {
  const verified = await verifyRecoveryEvidence(options);
  return Object.freeze({
    candidateCommit: verified.candidateCommit,
    evidenceCommit: verified.evidenceCommit,
    historicalOnly: verified.historicalOnly,
    inventory: verified.inventory,
    liveTechnicalStatus: verified.liveTechnicalStatus,
    passEligible: verified.passEligible,
    signatureStatus: verified.signatureStatus,
    status: verified.status,
    technicalPassEligible: verified.technicalPassEligible,
  });
}

function parseVerifierArgs(argv) {
  const values = new Map();
  for (const argument of argv) {
    if (argument === "--require-go") {
      invariant(!values.has("require-go"), "RECOVERY_EVIDENCE_ARGUMENT_DUPLICATE");
      values.set("require-go", "1");
      continue;
    }
    const match = argument.match(
      /^--(evidence-commit|expected-candidate|trusted-observer-public-key)=(.+)$/u,
    );
    invariant(match, "RECOVERY_EVIDENCE_ARGUMENT_INVALID");
    invariant(!values.has(match[1]), "RECOVERY_EVIDENCE_ARGUMENT_DUPLICATE");
    values.set(match[1], match[2].trim());
  }
  return values;
}

export function assertRecoveryGoResult(result, { expectedEvidenceCommit } = {}) {
  invariant(result?.status === "PASS", "RECOVERY_GO_STATUS_NOT_PASS");
  invariant(result.passEligible === true, "RECOVERY_GO_NOT_PASS_ELIGIBLE");
  invariant(result.signatureStatus === "VERIFIED", "RECOVERY_GO_SIGNATURE_NOT_VERIFIED");
  invariant(
    /^[a-f0-9]{40}$/u.test(expectedEvidenceCommit ?? "")
      && result.evidenceCommit === expectedEvidenceCommit,
    "RECOVERY_GO_EVIDENCE_COMMIT_MISMATCH",
  );
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = parseVerifierArgs(process.argv.slice(2));
    if (args.has("require-go")) {
      invariant(args.has("evidence-commit"), "RECOVERY_GO_EVIDENCE_COMMIT_REQUIRED");
      invariant(args.has("expected-candidate"), "RECOVERY_GO_EXPECTED_CANDIDATE_REQUIRED");
      invariant(
        args.has("trusted-observer-public-key"),
        "RECOVERY_GO_TRUSTED_OBSERVER_KEY_REQUIRED",
      );
    }
    const trustAnchor = args.has("trusted-observer-public-key")
      ? await loadExternalRecoveryTrustAnchor({
        publicKeyPath: args.get("trusted-observer-public-key"),
        repositoryRoot,
      })
      : null;
    const result = await verifyRecoveryEvidence({
      evidenceCommit: args.get("evidence-commit") ?? null,
      expectedCandidateCommit: args.get("expected-candidate") ?? null,
      trustAnchor,
    });
    if (args.has("require-go")) {
      assertRecoveryGoResult(result, {
        expectedEvidenceCommit: args.get("evidence-commit"),
      });
    }
    console.log(JSON.stringify(result));
    if (!result.passEligible) process.exitCode = 2;
  } catch (error) {
    console.error(JSON.stringify({
      errorCode: error instanceof Error ? error.message : "RECOVERY_EVIDENCE_VERIFY_FAILED",
      ok: false,
    }));
    process.exitCode = 1;
  }
}
