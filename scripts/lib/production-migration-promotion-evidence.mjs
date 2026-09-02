import { execFileSync } from "node:child_process";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import {
  assertExternalGateRoleIndependence,
  assertExactObjectKeys,
  canonicalJson,
  requireIsoTimestamp,
  requireSha256,
  sha256,
  verifyExternalGateReceipt,
} from "./external-gate-receipts.mjs";
import {
  recoveryExpectedDatabaseName,
  recoveryExpectedProductionBranchId,
  recoveryExpectedProjectId,
} from "./database-recovery-query-pack.mjs";
import {
  recoveryMigrationPlan,
  recoveryMigrationPlanContract,
} from "./recovery-migration-plan.mjs";

export const productionMigrationPromotionEvidenceRecordType =
  "NOVALURE_PRODUCTION_MIGRATION_PROMOTION_EVIDENCE";
export const productionMigrationPromotionReceiptRecordType =
  "NOVALURE_PRODUCTION_MIGRATION_PROMOTION_RECEIPT";
export const productionMigrationPromotionStatus = "VERIFIED_FOR_PRODUCTION";
export const productionMigrationPromotionSchemaVersion = 2;
export const productionMigrationPromotionMaximumAgeMs = 24 * 60 * 60 * 1_000;
export const productionMigrationPromotionMaximumFutureSkewMs = 60 * 1_000;
export const productionMigrationPromotionRoles = Object.freeze({
  preview: "github-actions-attestor",
  recovery: "production-cutover-dba",
});
export const productionMigrationPromotionPreviewTarget = Object.freeze({
  databaseName: "neondb",
  neonBranchId: "br-lucky-heart-alrm9dlw",
  neonProjectId: "weathered-term-98273025",
});
export const productionMigrationPromotionProductionTarget = Object.freeze({
  databaseName: recoveryExpectedDatabaseName,
  neonBranchId: recoveryExpectedProductionBranchId,
  neonProjectId: recoveryExpectedProjectId,
});
export const productionMigrationPromotionPlanContract = recoveryMigrationPlanContract;
export const productionMigrationPromotionMigrations = Object.freeze(
  recoveryMigrationPlan.map((version) => Object.freeze({
  path: `migrations/${version}.sql`,
  version,
  })),
);

// This digest is deliberately code-reviewed state, independent from the CLI evidence bundle.
// Production stays fail-closed until Security replaces this pending marker with an ACTIVE pin.
export const productionMigrationPromotionPinnedTrustAnchor = Object.freeze({
  sha256: null,
  status: "PENDING_SECURITY_OWNER_KEY",
});

const maximumEvidenceBytes = 256 * 1_024;
const commitPattern = /^[a-f0-9]{40}$/u;
const branchPattern = /^br-[A-Za-z0-9-]{8,128}$/u;
const deploymentIdPattern = /^dpl_[A-Za-z0-9]{20,80}$/u;
const deploymentHostPattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.vercel\.app$/u;
const verifiedPromotionEvidenceResults = new WeakSet();

function invariant(condition, code) {
  if (!condition) throw new Error(code);
}

function outsideDirectory(parent, candidate) {
  const pathFromParent = relative(parent, candidate);
  return pathFromParent === ".."
    || pathFromParent.startsWith(`..${sep}`)
    || isAbsolute(pathFromParent);
}

function normalizedPath(value) {
  return process.platform === "win32" ? value.toLowerCase() : value;
}

export function assertProductionMigrationPromotionPinnedTrustAnchor(
  suppliedSha256,
) {
  invariant(
    productionMigrationPromotionPinnedTrustAnchor.status === "ACTIVE",
    "PRODUCTION_PROMOTION_PINNED_TRUST_ANCHOR_PENDING",
  );
  requireSha256(
    productionMigrationPromotionPinnedTrustAnchor.sha256,
    "PRODUCTION_PROMOTION_PINNED_TRUST_ANCHOR_INVALID",
  );
  requireSha256(
    suppliedSha256,
    "PRODUCTION_PROMOTION_SUPPLIED_TRUST_ANCHOR_DIGEST_INVALID",
  );
  invariant(
    suppliedSha256 === productionMigrationPromotionPinnedTrustAnchor.sha256,
    "PRODUCTION_PROMOTION_PINNED_TRUST_ANCHOR_MISMATCH",
  );
  return productionMigrationPromotionPinnedTrustAnchor.sha256;
}

function candidateMigrationInventory(repositoryRoot, candidateCommit) {
  invariant(commitPattern.test(candidateCommit ?? ""), "PRODUCTION_PROMOTION_CANDIDATE_INVALID");
  return productionMigrationPromotionMigrations.map(({ path, version }) => {
    let source;
    try {
      source = execFileSync("git", ["show", `${candidateCommit}:${path}`], {
        cwd: repositoryRoot,
        encoding: "utf8",
        maxBuffer: 8 * 1_024 * 1_024,
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      invariant(false, "PRODUCTION_PROMOTION_CANDIDATE_MIGRATION_MISSING");
    }
    const checksum = sha256(source.replace(/\r\n/gu, "\n"));
    return Object.freeze({ checksum, path, version });
  });
}

function assertMigrationInventory(document, expectedCandidateCommit, repositoryRoot) {
  invariant(Array.isArray(document.migrationInventory), "PRODUCTION_PROMOTION_MIGRATION_INVENTORY_REQUIRED");
  const expected = candidateMigrationInventory(repositoryRoot, expectedCandidateCommit);
  invariant(
    canonicalJson(document.migrationInventory) === canonicalJson(expected),
    "PRODUCTION_PROMOTION_MIGRATION_INVENTORY_MISMATCH",
  );
  return Object.freeze({
    inventory: expected,
    sha256: sha256(canonicalJson(expected)),
  });
}

function assertProductionTarget(target, expectedProductionTarget) {
  assertExactObjectKeys(target, [
    "databaseName",
    "neonBranchId",
    "neonProjectId",
  ], "PRODUCTION_PROMOTION_PRODUCTION_TARGET");
  invariant(
    canonicalJson(target) === canonicalJson(productionMigrationPromotionProductionTarget),
    "PRODUCTION_PROMOTION_PRODUCTION_TARGET_INVALID",
  );
  if (expectedProductionTarget !== null) {
    invariant(
      canonicalJson(target) === canonicalJson(expectedProductionTarget),
      "PRODUCTION_PROMOTION_CONNECTED_TARGET_MISMATCH",
    );
  }
}

function assertPreviewEvidence(preview, migrationInventorySha256) {
  assertExactObjectKeys(preview, [
    "databaseName",
    "deploymentHost",
    "deploymentId",
    "evidenceSha256",
    "migrationInventorySha256",
    "neonBranchId",
    "neonProjectId",
    "productionMutationPerformed",
    "status",
  ], "PRODUCTION_PROMOTION_PREVIEW");
  for (const key of ["databaseName", "neonBranchId", "neonProjectId"]) {
    invariant(
      preview[key] === productionMigrationPromotionPreviewTarget[key],
      `PRODUCTION_PROMOTION_PREVIEW_${key.toUpperCase()}_MISMATCH`,
    );
  }
  invariant(deploymentIdPattern.test(preview.deploymentId ?? ""), "PRODUCTION_PROMOTION_PREVIEW_DEPLOYMENT_INVALID");
  invariant(deploymentHostPattern.test(preview.deploymentHost ?? ""), "PRODUCTION_PROMOTION_PREVIEW_HOST_INVALID");
  requireSha256(preview.evidenceSha256, "PRODUCTION_PROMOTION_PREVIEW_EVIDENCE_DIGEST_INVALID");
  invariant(preview.migrationInventorySha256 === migrationInventorySha256, "PRODUCTION_PROMOTION_PREVIEW_MIGRATION_INVENTORY_MISMATCH");
  invariant(preview.productionMutationPerformed === false, "PRODUCTION_PROMOTION_PREVIEW_PRODUCTION_MUTATION");
  invariant(preview.status === "VERIFIED_PASS", "PRODUCTION_PROMOTION_PREVIEW_NOT_VERIFIED");
}

function assertRecoveryEvidence(recovery, migrationInventorySha256) {
  assertExactObjectKeys(recovery, [
    "databaseName",
    "evidenceSha256",
    "migrationInventorySha256",
    "neonBranchId",
    "neonProjectId",
    "productionMutationPerformed",
    "status",
  ], "PRODUCTION_PROMOTION_RECOVERY");
  invariant(recovery.databaseName === recoveryExpectedDatabaseName, "PRODUCTION_PROMOTION_RECOVERY_DATABASE_MISMATCH");
  invariant(recovery.neonProjectId === recoveryExpectedProjectId, "PRODUCTION_PROMOTION_RECOVERY_PROJECT_MISMATCH");
  invariant(
    branchPattern.test(recovery.neonBranchId ?? "")
      && recovery.neonBranchId !== recoveryExpectedProductionBranchId
      && recovery.neonBranchId !== productionMigrationPromotionPreviewTarget.neonBranchId,
    "PRODUCTION_PROMOTION_RECOVERY_BRANCH_INVALID",
  );
  requireSha256(recovery.evidenceSha256, "PRODUCTION_PROMOTION_RECOVERY_EVIDENCE_DIGEST_INVALID");
  invariant(recovery.migrationInventorySha256 === migrationInventorySha256, "PRODUCTION_PROMOTION_RECOVERY_MIGRATION_INVENTORY_MISMATCH");
  invariant(recovery.productionMutationPerformed === false, "PRODUCTION_PROMOTION_RECOVERY_PRODUCTION_MUTATION");
  invariant(recovery.status === "VERIFIED_PASS", "PRODUCTION_PROMOTION_RECOVERY_NOT_VERIFIED");
}

export function buildProductionMigrationPromotionEvidenceSha256(document) {
  const unsigned = Object.fromEntries(
    Object.entries(document).filter(([key]) => key !== "receipts"),
  );
  return sha256(canonicalJson(unsigned));
}

export function buildProductionMigrationPromotionReceiptPayload(
  document,
  evidenceSha256,
  migrationInventorySha256,
) {
  const result = Object.freeze({
    candidateCommit: document.candidateCommit,
    evidenceSha256,
    migrationPlanContract: document.migrationPlanContract,
    migrationInventorySha256,
    previewEvidenceSha256: document.preview.evidenceSha256,
    previewTargetSha256: sha256(canonicalJson({
      databaseName: document.preview.databaseName,
      deploymentHost: document.preview.deploymentHost,
      deploymentId: document.preview.deploymentId,
      neonBranchId: document.preview.neonBranchId,
      neonProjectId: document.preview.neonProjectId,
    })),
    productionTargetSha256: sha256(canonicalJson(document.productionTarget)),
    recoveryEvidenceSha256: document.recovery.evidenceSha256,
    recoveryTargetSha256: sha256(canonicalJson({
      databaseName: document.recovery.databaseName,
      neonBranchId: document.recovery.neonBranchId,
      neonProjectId: document.recovery.neonProjectId,
    })),
    status: productionMigrationPromotionStatus,
  });
  return result;
}

export function verifyProductionMigrationPromotionEvidence({
  document,
  expectedCandidateCommit,
  expectedMigration,
  expectedProductionTarget = null,
  nowEpochMs = Date.now(),
  repositoryRoot,
  trustContext,
}) {
  invariant(Number.isSafeInteger(nowEpochMs) && nowEpochMs > 0, "PRODUCTION_PROMOTION_CLOCK_INVALID");
  invariant(typeof repositoryRoot === "string" && isAbsolute(repositoryRoot), "PRODUCTION_PROMOTION_REPOSITORY_ROOT_REQUIRED");
  invariant(commitPattern.test(expectedCandidateCommit ?? ""), "PRODUCTION_PROMOTION_EXPECTED_CANDIDATE_INVALID");
  assertExactObjectKeys(document, [
    "candidateCommit",
    "generatedAt",
    "migrationInventory",
    "migrationPlanContract",
    "preview",
    "productionTarget",
    "receipts",
    "recordType",
    "recovery",
    "schemaVersion",
    "status",
  ], "PRODUCTION_PROMOTION_DOCUMENT");
  invariant(document.schemaVersion === productionMigrationPromotionSchemaVersion, "PRODUCTION_PROMOTION_SCHEMA_INVALID");
  invariant(document.recordType === productionMigrationPromotionEvidenceRecordType, "PRODUCTION_PROMOTION_RECORD_TYPE_INVALID");
  invariant(document.status === productionMigrationPromotionStatus, "PRODUCTION_PROMOTION_STATUS_INVALID");
  invariant(
    document.migrationPlanContract === productionMigrationPromotionPlanContract,
    "PRODUCTION_PROMOTION_PLAN_CONTRACT_INVALID",
  );
  invariant(document.candidateCommit === expectedCandidateCommit, "PRODUCTION_PROMOTION_CANDIDATE_MISMATCH");
  const generatedAt = Date.parse(requireIsoTimestamp(document.generatedAt, "PRODUCTION_PROMOTION_GENERATED_AT_INVALID"));
  invariant(generatedAt <= nowEpochMs + productionMigrationPromotionMaximumFutureSkewMs, "PRODUCTION_PROMOTION_GENERATED_AT_IN_FUTURE");
  invariant(generatedAt >= nowEpochMs - productionMigrationPromotionMaximumAgeMs, "PRODUCTION_PROMOTION_EVIDENCE_STALE");
  const migrationInventory = assertMigrationInventory(document, expectedCandidateCommit, repositoryRoot);
  invariant(
    expectedMigration
      && migrationInventory.inventory.some(({ checksum, path, version }) => (
        expectedMigration.checksum === checksum
          && expectedMigration.path === path
          && expectedMigration.version === version
      )),
    "PRODUCTION_PROMOTION_SELECTED_MIGRATION_MISMATCH",
  );
  assertProductionTarget(document.productionTarget, expectedProductionTarget);
  assertPreviewEvidence(document.preview, migrationInventory.sha256);
  assertRecoveryEvidence(document.recovery, migrationInventory.sha256);
  assertExactObjectKeys(document.receipts, Object.keys(productionMigrationPromotionRoles), "PRODUCTION_PROMOTION_RECEIPTS");
  assertExternalGateRoleIndependence(
    trustContext,
    Object.values(productionMigrationPromotionRoles),
  );
  const evidenceSha256 = buildProductionMigrationPromotionEvidenceSha256(document);
  const expectedPayload = buildProductionMigrationPromotionReceiptPayload(
    document,
    evidenceSha256,
    migrationInventory.sha256,
  );
  const receiptIds = new Set();
  const signatureReferences = new Set();
  for (const [name, role] of Object.entries(productionMigrationPromotionRoles)) {
    const receipt = document.receipts[name];
    verifyExternalGateReceipt({
      expectedRecordType: productionMigrationPromotionReceiptRecordType,
      expectedRole: role,
      receipt,
      trustContext,
    });
    invariant(canonicalJson(receipt.payload) === canonicalJson(expectedPayload), "PRODUCTION_PROMOTION_RECEIPT_PAYLOAD_MISMATCH");
    const signedAt = Date.parse(receipt.signedAt);
    invariant(signedAt >= generatedAt, "PRODUCTION_PROMOTION_RECEIPT_PREDATES_EVIDENCE");
    invariant(signedAt <= nowEpochMs + productionMigrationPromotionMaximumFutureSkewMs, "PRODUCTION_PROMOTION_RECEIPT_IN_FUTURE");
    invariant(signedAt >= nowEpochMs - productionMigrationPromotionMaximumAgeMs, "PRODUCTION_PROMOTION_RECEIPT_STALE");
    invariant(!receiptIds.has(receipt.receiptId), "PRODUCTION_PROMOTION_RECEIPT_ID_REUSED");
    invariant(!signatureReferences.has(receipt.signatureReference), "PRODUCTION_PROMOTION_SIGNATURE_REFERENCE_REUSED");
    receiptIds.add(receipt.receiptId);
    signatureReferences.add(receipt.signatureReference);
  }
  const result = Object.freeze({
    candidateCommit: document.candidateCommit,
    documentSha256: sha256(canonicalJson(document)),
    evidenceSha256,
    migrationPlanContract: document.migrationPlanContract,
    migrationInventorySha256: migrationInventory.sha256,
    productionTarget: Object.freeze({ ...document.productionTarget }),
    trustAnchorSha256: trustContext.expectedSha256,
  });
  verifiedPromotionEvidenceResults.add(result);
  return result;
}

export function assertVerifiedProductionMigrationPromotionEvidence(value) {
  invariant(
    value !== null
      && typeof value === "object"
      && verifiedPromotionEvidenceResults.has(value),
    "PRODUCTION_PROMOTION_CRYPTOGRAPHIC_VERIFICATION_REQUIRED",
  );
  return value;
}

export async function loadCanonicalProductionMigrationPromotionEvidence({
  evidencePath,
  repositoryRoot,
}) {
  invariant(typeof evidencePath === "string" && isAbsolute(evidencePath), "PRODUCTION_PROMOTION_EVIDENCE_PATH_ABSOLUTE_REQUIRED");
  invariant(typeof repositoryRoot === "string" && isAbsolute(repositoryRoot), "PRODUCTION_PROMOTION_REPOSITORY_ROOT_REQUIRED");
  const resolvedEvidence = resolve(evidencePath);
  const initial = await lstat(resolvedEvidence);
  invariant(
    initial.isFile()
      && !initial.isSymbolicLink()
      && initial.nlink === 1
      && initial.size > 0
      && initial.size <= maximumEvidenceBytes,
    "PRODUCTION_PROMOTION_EVIDENCE_NOT_BOUNDED_REGULAR_FILE",
  );
  const [realEvidence, realRepository] = await Promise.all([
    realpath(resolvedEvidence),
    realpath(resolve(repositoryRoot)),
  ]);
  invariant(normalizedPath(realEvidence) === normalizedPath(resolvedEvidence), "PRODUCTION_PROMOTION_EVIDENCE_NOT_BOUNDED_REGULAR_FILE");
  invariant(outsideDirectory(realRepository, realEvidence), "PRODUCTION_PROMOTION_EVIDENCE_MUST_BE_OUTSIDE_REPOSITORY");
  let handle;
  let source;
  try {
    handle = await open(realEvidence, "r");
    const opened = await handle.stat();
    invariant(
      opened.isFile()
        && opened.nlink === 1
        && opened.dev === initial.dev
        && opened.ino === initial.ino
        && opened.size === initial.size
        && opened.mtimeMs === initial.mtimeMs,
      "PRODUCTION_PROMOTION_EVIDENCE_CHANGED_DURING_OPEN",
    );
    source = await handle.readFile();
    const after = await handle.stat();
    invariant(
      after.dev === opened.dev
        && after.ino === opened.ino
        && after.nlink === opened.nlink
        && after.size === opened.size
        && after.mtimeMs === opened.mtimeMs
        && source.length === opened.size,
      "PRODUCTION_PROMOTION_EVIDENCE_CHANGED_DURING_READ",
    );
  } finally {
    await handle?.close().catch(() => undefined);
  }
  let document;
  try {
    document = JSON.parse(source.toString("utf8"));
  } catch {
    invariant(false, "PRODUCTION_PROMOTION_EVIDENCE_JSON_INVALID");
  }
  invariant(source.toString("utf8") === canonicalJson(document), "PRODUCTION_PROMOTION_EVIDENCE_NOT_CANONICAL");
  return document;
}
