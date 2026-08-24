import { spawnSync } from "node:child_process";
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

export const productionCutoverSchemaVersion = 1;
export const productionCutoverRecordType =
  "NOVALURE_PRODUCTION_CUTOVER_EVIDENCE";
export const productionCutoverReceiptRecordType =
  "NOVALURE_PRODUCTION_CUTOVER_RECEIPT";
export const productionCutoverStatus = "PRE_ACTIVATION_READY";
export const productionCutoverExpectedVercelProjectId =
  "prj_R32Okl6AHijTohvuKmryuTLjWMsk";
export const productionCutoverExpectedProductionHost =
  "www.novalure-crm.app";
export const productionCutoverDeploymentCommand = "vercel --prod --skip-domain";
export const productionCutoverMaximumFutureSkewMs = 60 * 1000;
export const productionCutoverMaximumReadinessAgeMs = 30 * 60 * 1000;
export const productionCutoverReceiptRoles = Object.freeze({
  dba: "production-cutover-dba",
  platformOperations: "production-cutover-platform-operations",
  releaseObserver: "production-cutover-release-observer",
});

export const productionCutoverMigrations = Object.freeze([
  ["057_bot_webhook_legacy_index_cutover", "migrations/057_bot_webhook_legacy_index_cutover.sql"],
  ["060_tenant_rls_pilot_prepare", "migrations/060_tenant_rls_pilot_prepare.sql"],
  ["061_validate_and_activate_tenant_rls_pilot", "migrations/061_validate_and_activate_tenant_rls_pilot.sql"],
  ["062_private_media_contract_cutover", "migrations/062_private_media_contract_cutover.sql"],
  ["065_notification_guard_search_path_hardening", "migrations/065_notification_guard_search_path_hardening.sql"],
  ["068_qa_batch_reset_safety", "migrations/068_qa_batch_reset_safety.sql"],
  ["069_property_unit_idempotency", "migrations/069_property_unit_idempotency.sql"],
  ["070_funnel_submission_idempotency_recovery", "migrations/070_funnel_submission_idempotency_recovery.sql"],
  ["071_forms_owner_tenant_guard", "migrations/071_forms_owner_tenant_guard.sql"],
  ["072_form_submission_atomicity", "migrations/072_form_submission_atomicity.sql"],
  ["073_launch_tenant_relation_guards", "migrations/073_launch_tenant_relation_guards.sql"],
  ["074_validate_launch_tenant_relation_guards", "migrations/074_validate_launch_tenant_relation_guards.sql"],
  ["075_public_funnel_visit_truth", "migrations/075_public_funnel_visit_truth.sql"],
  ["076_bot_webhook_durable_processing", "migrations/076_bot_webhook_durable_processing.sql"],
  ["077_schema_ledger_runtime_projection", "migrations/077_schema_ledger_runtime_projection.sql"],
  ["078_company_profile_approval_integrity", "migrations/078_company_profile_approval_integrity.sql"],
  ["079_public_funnel_visit_role_boundary", "migrations/079_public_funnel_visit_role_boundary.sql"],
].map(([version, path]) => Object.freeze({ path, version })));

export const productionCutoverExplicitCutoverVersions = Object.freeze([
  "061_validate_and_activate_tenant_rls_pilot",
  "062_private_media_contract_cutover",
  "065_notification_guard_search_path_hardening",
]);

export const productionCutoverPostLedgerQuery =
  "select version, checksum from public.novalure_schema_migrations where version = any($1::text[]) order by version";
export const productionCutoverPostLedgerQuerySha256 = sha256(
  `${productionCutoverPostLedgerQuery}\n`,
);

const maximumDocumentBytes = 512 * 1024;
const commitPattern = /^[a-f0-9]{40}$/u;
const deploymentIdPattern = /^dpl_[A-Za-z0-9]{20,80}$/u;
const vercelHostPattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.vercel\.app$/u;
const neonBranchPattern = /^br-[A-Za-z0-9-]{8,128}$/u;
const snapshotFingerprintPattern = /^[a-f0-9]{64}$/u;
const strictUtcTimestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const candidateBlobDigestCache = new Map();

function invariant(condition, code) {
  if (!condition) throw new Error(code);
}

function timestamp(value, code) {
  invariant(
    typeof value === "string" && strictUtcTimestampPattern.test(value),
    code,
  );
  return Date.parse(requireIsoTimestamp(value, code));
}

function verificationClock(nowEpochMs) {
  invariant(
    Number.isSafeInteger(nowEpochMs) && nowEpochMs >= 0,
    "PRODUCTION_CUTOVER_NOW_EPOCH_MS_INVALID",
  );
  return nowEpochMs;
}

function assertLaunchReadinessFreshness(startedAt, completedAt, nowEpochMs) {
  invariant(
    completedAt <= nowEpochMs + productionCutoverMaximumFutureSkewMs,
    "PRODUCTION_CUTOVER_COMPLETED_AT_IN_FUTURE",
  );
  invariant(
    completedAt >= nowEpochMs - productionCutoverMaximumReadinessAgeMs,
    "PRODUCTION_CUTOVER_EVIDENCE_STALE",
  );
  invariant(
    startedAt >= nowEpochMs - productionCutoverMaximumReadinessAgeMs,
    "PRODUCTION_CUTOVER_STARTED_AT_STALE",
  );
}

function within(value, minimum, maximum, code) {
  const observed = timestamp(value, `${code}_INVALID`);
  invariant(observed >= minimum && observed <= maximum, `${code}_ORDER_INVALID`);
  return observed;
}

function normalizedPath(value) {
  return process.platform === "win32" ? value.toLowerCase() : value;
}

function outsideDirectory(parent, candidate) {
  const pathFromParent = relative(parent, candidate);
  return pathFromParent === ".."
    || pathFromParent.startsWith(`..${sep}`)
    || isAbsolute(pathFromParent);
}

function runGit(repositoryRoot, args, { encoding = "utf8" } = {}) {
  const result = spawnSync("git", args, {
    cwd: repositoryRoot,
    encoding,
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
  });
  invariant(result.status === 0, "PRODUCTION_CUTOVER_CANDIDATE_GIT_READ_FAILED");
  return result.stdout;
}

function candidateBlobSha256(repositoryRoot, candidateCommit, path) {
  const cacheKey = `${normalizedPath(resolve(repositoryRoot))}\u0000${candidateCommit}\u0000${path}`;
  if (candidateBlobDigestCache.has(cacheKey)) {
    return candidateBlobDigestCache.get(cacheKey);
  }
  const treeLine = runGit(repositoryRoot, ["ls-tree", candidateCommit, "--", path]).trim();
  invariant(
    /^100644 blob [a-f0-9]{40,64}\t[^\r\n]+$/u.test(treeLine)
      && treeLine.endsWith(`\t${path}`),
    "PRODUCTION_CUTOVER_CANDIDATE_MIGRATION_NOT_REGULAR_BLOB",
  );
  const source = runGit(repositoryRoot, ["show", `${candidateCommit}:${path}`], {
    encoding: null,
  });
  invariant(Buffer.isBuffer(source) && source.length > 0, "PRODUCTION_CUTOVER_CANDIDATE_MIGRATION_EMPTY");
  const digest = sha256(source);
  candidateBlobDigestCache.set(cacheKey, digest);
  return digest;
}

function assertTarget(target, expectedTarget = null) {
  assertExactObjectKeys(target, [
    "databaseName",
    "neonBranchId",
    "neonProjectId",
    "productionHost",
    "stagedDeploymentHost",
    "stagedDeploymentId",
    "vercelProjectId",
  ], "PRODUCTION_CUTOVER_TARGET");
  invariant(target.vercelProjectId === productionCutoverExpectedVercelProjectId, "PRODUCTION_CUTOVER_VERCEL_PROJECT_MISMATCH");
  invariant(target.productionHost === productionCutoverExpectedProductionHost, "PRODUCTION_CUTOVER_PRODUCTION_HOST_MISMATCH");
  invariant(target.neonProjectId === recoveryExpectedProjectId, "PRODUCTION_CUTOVER_NEON_PROJECT_MISMATCH");
  invariant(target.neonBranchId === recoveryExpectedProductionBranchId, "PRODUCTION_CUTOVER_NEON_BRANCH_MISMATCH");
  invariant(target.databaseName === recoveryExpectedDatabaseName, "PRODUCTION_CUTOVER_DATABASE_MISMATCH");
  invariant(deploymentIdPattern.test(target.stagedDeploymentId ?? ""), "PRODUCTION_CUTOVER_STAGED_DEPLOYMENT_ID_INVALID");
  invariant(vercelHostPattern.test(target.stagedDeploymentHost ?? ""), "PRODUCTION_CUTOVER_STAGED_DEPLOYMENT_HOST_INVALID");
  if (expectedTarget !== null) {
    for (const key of ["stagedDeploymentHost", "stagedDeploymentId"]) {
      invariant(target[key] === expectedTarget[key], `PRODUCTION_CUTOVER_EXPECTED_${key.toUpperCase()}_MISMATCH`);
    }
  }
}

function assertSmoke(smoke, {
  code,
  deploymentHost,
  deploymentId,
  maximum,
  minimum,
  result,
}) {
  assertExactObjectKeys(smoke, [
    "activationState",
    "checkedAt",
    "deploymentHost",
    "deploymentId",
    "evidenceSha256",
    "result",
  ], code);
  invariant(smoke.activationState === "SAFE_CLOSED", `${code}_ACTIVATION_NOT_SAFE_CLOSED`);
  invariant(smoke.result === result, `${code}_RESULT_INVALID`);
  invariant(smoke.deploymentHost === deploymentHost, `${code}_HOST_MISMATCH`);
  invariant(smoke.deploymentId === deploymentId, `${code}_DEPLOYMENT_MISMATCH`);
  requireSha256(smoke.evidenceSha256, `${code}_EVIDENCE_INVALID`);
  return within(smoke.checkedAt, minimum, maximum, `${code}_CHECKED_AT`);
}

function assertDeployment(deployment, target, startedAt, completedAt, expectedTarget) {
  assertExactObjectKeys(deployment, [
    "aliasPromotion",
    "deploymentCommand",
    "domainAssignedDuringStaging",
    "postPromotionSmoke",
    "prePromotionSmoke",
    "rollback",
    "stagedAt",
    "stagingEvidenceSha256",
  ], "PRODUCTION_CUTOVER_DEPLOYMENT");
  invariant(deployment.deploymentCommand === productionCutoverDeploymentCommand, "PRODUCTION_CUTOVER_SKIP_DOMAIN_COMMAND_REQUIRED");
  invariant(deployment.domainAssignedDuringStaging === false, "PRODUCTION_CUTOVER_DOMAIN_ASSIGNED_DURING_STAGING");
  requireSha256(deployment.stagingEvidenceSha256, "PRODUCTION_CUTOVER_STAGING_EVIDENCE_INVALID");
  const stagedAt = within(deployment.stagedAt, startedAt, completedAt, "PRODUCTION_CUTOVER_STAGED_AT");

  assertExactObjectKeys(deployment.rollback, [
    "deploymentHost",
    "deploymentId",
    "evidenceSha256",
    "status",
    "verifiedAt",
  ], "PRODUCTION_CUTOVER_ROLLBACK");
  invariant(deployment.rollback.status === "READY", "PRODUCTION_CUTOVER_ROLLBACK_NOT_READY");
  invariant(deployment.rollback.deploymentId !== target.stagedDeploymentId, "PRODUCTION_CUTOVER_ROLLBACK_EQUALS_STAGED");
  invariant(deploymentIdPattern.test(deployment.rollback.deploymentId ?? ""), "PRODUCTION_CUTOVER_ROLLBACK_DEPLOYMENT_INVALID");
  invariant(vercelHostPattern.test(deployment.rollback.deploymentHost ?? ""), "PRODUCTION_CUTOVER_ROLLBACK_HOST_INVALID");
  if (expectedTarget !== null) {
    invariant(deployment.rollback.deploymentId === expectedTarget.rollbackDeploymentId, "PRODUCTION_CUTOVER_EXPECTED_ROLLBACK_DEPLOYMENT_MISMATCH");
    invariant(deployment.rollback.deploymentHost === expectedTarget.rollbackDeploymentHost, "PRODUCTION_CUTOVER_EXPECTED_ROLLBACK_HOST_MISMATCH");
  }
  requireSha256(deployment.rollback.evidenceSha256, "PRODUCTION_CUTOVER_ROLLBACK_EVIDENCE_INVALID");
  within(deployment.rollback.verifiedAt, startedAt, completedAt, "PRODUCTION_CUTOVER_ROLLBACK_VERIFIED_AT");

  const prePromotionAt = assertSmoke(deployment.prePromotionSmoke, {
    code: "PRODUCTION_CUTOVER_PRE_PROMOTION_SMOKE",
    deploymentHost: target.stagedDeploymentHost,
    deploymentId: target.stagedDeploymentId,
    maximum: completedAt,
    minimum: stagedAt,
    result: "PASS",
  });
  assertExactObjectKeys(deployment.aliasPromotion, [
    "alias",
    "evidenceSha256",
    "previousDeploymentId",
    "promotedAt",
    "result",
    "sourceDeploymentId",
  ], "PRODUCTION_CUTOVER_ALIAS_PROMOTION");
  invariant(deployment.aliasPromotion.alias === productionCutoverExpectedProductionHost, "PRODUCTION_CUTOVER_ALIAS_MISMATCH");
  invariant(deployment.aliasPromotion.sourceDeploymentId === target.stagedDeploymentId, "PRODUCTION_CUTOVER_ALIAS_SOURCE_MISMATCH");
  invariant(deployment.aliasPromotion.previousDeploymentId === deployment.rollback.deploymentId, "PRODUCTION_CUTOVER_ALIAS_PREVIOUS_MISMATCH");
  invariant(deployment.aliasPromotion.result === "PROMOTED_EXACT", "PRODUCTION_CUTOVER_ALIAS_RESULT_INVALID");
  requireSha256(deployment.aliasPromotion.evidenceSha256, "PRODUCTION_CUTOVER_ALIAS_EVIDENCE_INVALID");
  const promotedAt = within(deployment.aliasPromotion.promotedAt, prePromotionAt, completedAt, "PRODUCTION_CUTOVER_ALIAS_PROMOTED_AT");
  assertSmoke(deployment.postPromotionSmoke, {
    code: "PRODUCTION_CUTOVER_POST_PROMOTION_SMOKE",
    deploymentHost: productionCutoverExpectedProductionHost,
    deploymentId: target.stagedDeploymentId,
    maximum: completedAt,
    minimum: promotedAt,
    result: "PASS_SAFE_CLOSED",
  });
}

function assertDatabase(database, candidateCommit, repositoryRoot, startedAt, completedAt) {
  assertExactObjectKeys(database, [
    "backup",
    "migrations",
    "postLedger",
    "restoreDrill",
  ], "PRODUCTION_CUTOVER_DATABASE");
  assertExactObjectKeys(database.backup, [
    "capturedAt",
    "evidenceSha256",
    "pitrEnabled",
    "pitrWindowEvidenceSha256",
    "snapshotFingerprintSha256",
    "status",
  ], "PRODUCTION_CUTOVER_BACKUP");
  invariant(database.backup.status === "PASS", "PRODUCTION_CUTOVER_BACKUP_NOT_PASS");
  invariant(database.backup.pitrEnabled === true, "PRODUCTION_CUTOVER_PITR_NOT_ENABLED");
  requireSha256(database.backup.evidenceSha256, "PRODUCTION_CUTOVER_BACKUP_EVIDENCE_INVALID");
  requireSha256(database.backup.pitrWindowEvidenceSha256, "PRODUCTION_CUTOVER_PITR_EVIDENCE_INVALID");
  invariant(snapshotFingerprintPattern.test(database.backup.snapshotFingerprintSha256 ?? ""), "PRODUCTION_CUTOVER_SNAPSHOT_FINGERPRINT_INVALID");
  const backupAt = within(database.backup.capturedAt, startedAt, completedAt, "PRODUCTION_CUTOVER_BACKUP_CAPTURED_AT");

  assertExactObjectKeys(database.restoreDrill, [
    "completedAt",
    "databaseName",
    "evidenceSha256",
    "neonBranchId",
    "neonProjectId",
    "productionMutationPerformed",
    "reconciliationSha256",
    "restoredDataFingerprintSha256",
    "sourceDataFingerprintSha256",
    "sourceSnapshotFingerprintSha256",
    "startedAt",
    "status",
  ], "PRODUCTION_CUTOVER_RESTORE_DRILL");
  const restore = database.restoreDrill;
  invariant(restore.status === "PASS", "PRODUCTION_CUTOVER_RESTORE_NOT_PASS");
  invariant(restore.productionMutationPerformed === false, "PRODUCTION_CUTOVER_RESTORE_MUTATED_PRODUCTION");
  invariant(restore.neonProjectId === recoveryExpectedProjectId, "PRODUCTION_CUTOVER_RESTORE_PROJECT_MISMATCH");
  invariant(neonBranchPattern.test(restore.neonBranchId ?? "") && restore.neonBranchId !== recoveryExpectedProductionBranchId, "PRODUCTION_CUTOVER_RESTORE_NOT_INDEPENDENT");
  invariant(restore.databaseName === recoveryExpectedDatabaseName, "PRODUCTION_CUTOVER_RESTORE_DATABASE_MISMATCH");
  invariant(restore.sourceSnapshotFingerprintSha256 === database.backup.snapshotFingerprintSha256, "PRODUCTION_CUTOVER_RESTORE_SNAPSHOT_MISMATCH");
  requireSha256(restore.evidenceSha256, "PRODUCTION_CUTOVER_RESTORE_EVIDENCE_INVALID");
  requireSha256(restore.reconciliationSha256, "PRODUCTION_CUTOVER_RESTORE_RECONCILIATION_INVALID");
  requireSha256(restore.sourceDataFingerprintSha256, "PRODUCTION_CUTOVER_RESTORE_SOURCE_DATA_INVALID");
  invariant(restore.restoredDataFingerprintSha256 === restore.sourceDataFingerprintSha256, "PRODUCTION_CUTOVER_RESTORE_DATA_MISMATCH");
  const restoreStartedAt = within(restore.startedAt, backupAt, completedAt, "PRODUCTION_CUTOVER_RESTORE_STARTED_AT");
  const restoreCompletedAt = within(restore.completedAt, restoreStartedAt, completedAt, "PRODUCTION_CUTOVER_RESTORE_COMPLETED_AT");

  invariant(Array.isArray(database.migrations), "PRODUCTION_CUTOVER_MIGRATIONS_REQUIRED");
  invariant(database.migrations.length === productionCutoverMigrations.length, "PRODUCTION_CUTOVER_MIGRATION_INVENTORY_INVALID");
  let lastAppliedAt = restoreCompletedAt;
  const explicitCutovers = new Set(productionCutoverExplicitCutoverVersions);
  for (let index = 0; index < productionCutoverMigrations.length; index += 1) {
    const expected = productionCutoverMigrations[index];
    const migration = database.migrations[index];
    assertExactObjectKeys(migration, [
      "appliedAt",
      "candidateBlobSha256",
      "cutoverDecision",
      "cutoverEvidenceSha256",
      "path",
      "postconditionEvidenceSha256",
      "status",
      "version",
    ], "PRODUCTION_CUTOVER_MIGRATION");
    invariant(migration.version === expected.version && migration.path === expected.path, "PRODUCTION_CUTOVER_MIGRATION_ORDER_OR_IDENTITY_INVALID");
    invariant(migration.status === "APPLIED_PASS", "PRODUCTION_CUTOVER_MIGRATION_NOT_APPLIED_PASS");
    invariant(
      migration.cutoverDecision === (explicitCutovers.has(migration.version)
        ? "EXPLICIT_APPLIED_PASS_CUTOVER"
        : "CONTROLLED_APPLIED_PASS"),
      "PRODUCTION_CUTOVER_MIGRATION_DECISION_INVALID",
    );
    requireSha256(migration.cutoverEvidenceSha256, "PRODUCTION_CUTOVER_MIGRATION_CUTOVER_EVIDENCE_INVALID");
    requireSha256(migration.postconditionEvidenceSha256, "PRODUCTION_CUTOVER_MIGRATION_POSTCONDITION_INVALID");
    const expectedBlobSha256 = candidateBlobSha256(repositoryRoot, candidateCommit, expected.path);
    invariant(migration.candidateBlobSha256 === expectedBlobSha256, "PRODUCTION_CUTOVER_MIGRATION_CANDIDATE_CHECKSUM_MISMATCH");
    lastAppliedAt = within(migration.appliedAt, lastAppliedAt, completedAt, "PRODUCTION_CUTOVER_MIGRATION_APPLIED_AT");
  }

  assertExactObjectKeys(database.postLedger, [
    "capturedAt",
    "entries",
    "entriesSha256",
    "evidenceSha256",
    "querySha256",
    "status",
  ], "PRODUCTION_CUTOVER_POST_LEDGER");
  invariant(database.postLedger.status === "PASS", "PRODUCTION_CUTOVER_POST_LEDGER_NOT_PASS");
  invariant(database.postLedger.querySha256 === productionCutoverPostLedgerQuerySha256, "PRODUCTION_CUTOVER_POST_LEDGER_QUERY_MISMATCH");
  requireSha256(database.postLedger.evidenceSha256, "PRODUCTION_CUTOVER_POST_LEDGER_EVIDENCE_INVALID");
  invariant(Array.isArray(database.postLedger.entries) && database.postLedger.entries.length === productionCutoverMigrations.length, "PRODUCTION_CUTOVER_POST_LEDGER_ENTRIES_INVALID");
  const expectedLedger = database.migrations.map(({ candidateBlobSha256, version }) => ({
    checksum: candidateBlobSha256,
    version,
  }));
  invariant(canonicalJson(database.postLedger.entries) === canonicalJson(expectedLedger), "PRODUCTION_CUTOVER_POST_LEDGER_MISMATCH");
  invariant(database.postLedger.entriesSha256 === sha256(canonicalJson(expectedLedger)), "PRODUCTION_CUTOVER_POST_LEDGER_DIGEST_MISMATCH");
  return within(database.postLedger.capturedAt, lastAppliedAt, completedAt, "PRODUCTION_CUTOVER_POST_LEDGER_CAPTURED_AT");
}

function assertStorage(storage, startedAt, completedAt) {
  assertExactObjectKeys(storage, [
    "legacyMigration",
    "previewStoreFingerprintSha256",
    "productionStoreFingerprintSha256",
  ], "PRODUCTION_CUTOVER_STORAGE");
  requireSha256(storage.previewStoreFingerprintSha256, "PRODUCTION_CUTOVER_PREVIEW_BLOB_FINGERPRINT_INVALID");
  requireSha256(storage.productionStoreFingerprintSha256, "PRODUCTION_CUTOVER_PRODUCTION_BLOB_FINGERPRINT_INVALID");
  invariant(storage.previewStoreFingerprintSha256 !== storage.productionStoreFingerprintSha256, "PRODUCTION_CUTOVER_BLOB_STORES_NOT_DISTINCT");
  assertExactObjectKeys(storage.legacyMigration, [
    "completedAt",
    "evidenceSha256",
    "migratedObjectCount",
    "postInventorySha256",
    "postLegacyResidualObjectCount",
    "postProductionObjectCount",
    "sourceInventorySha256",
    "sourceLegacyObjectCount",
    "startedAt",
    "status",
  ], "PRODUCTION_CUTOVER_LEGACY_BLOB_MIGRATION");
  const migration = storage.legacyMigration;
  invariant(migration.status === "PASS", "PRODUCTION_CUTOVER_LEGACY_BLOB_MIGRATION_NOT_PASS");
  for (const key of ["evidenceSha256", "postInventorySha256", "sourceInventorySha256"]) {
    requireSha256(migration[key], `PRODUCTION_CUTOVER_LEGACY_BLOB_${key.toUpperCase()}_INVALID`);
  }
  for (const key of ["migratedObjectCount", "postLegacyResidualObjectCount", "postProductionObjectCount", "sourceLegacyObjectCount"]) {
    invariant(Number.isSafeInteger(migration[key]) && migration[key] >= 0, "PRODUCTION_CUTOVER_LEGACY_BLOB_COUNT_INVALID");
  }
  invariant(migration.migratedObjectCount === migration.sourceLegacyObjectCount, "PRODUCTION_CUTOVER_LEGACY_BLOB_MIGRATED_COUNT_MISMATCH");
  invariant(migration.postLegacyResidualObjectCount === 0, "PRODUCTION_CUTOVER_LEGACY_BLOB_RESIDUAL_NOT_ZERO");
  invariant(migration.postProductionObjectCount >= migration.migratedObjectCount, "PRODUCTION_CUTOVER_LEGACY_BLOB_POST_INVENTORY_INVALID");
  const migrationStartedAt = within(migration.startedAt, startedAt, completedAt, "PRODUCTION_CUTOVER_LEGACY_BLOB_STARTED_AT");
  return within(migration.completedAt, migrationStartedAt, completedAt, "PRODUCTION_CUTOVER_LEGACY_BLOB_COMPLETED_AT");
}

function assertMonitoring(monitoring, startedAt, completedAt) {
  assertExactObjectKeys(monitoring, [
    "alertDeliveryEvidenceSha256",
    "armedAt",
    "errorIngestionEvidenceSha256",
    "readinessCheckedAt",
    "scope",
    "status",
    "syntheticAlarmEvidenceSha256",
  ], "PRODUCTION_CUTOVER_MONITORING");
  invariant(monitoring.scope === productionCutoverStatus, "PRODUCTION_CUTOVER_MONITORING_SCOPE_INVALID");
  invariant(monitoring.status === "PASS", "PRODUCTION_CUTOVER_MONITORING_NOT_PASS");
  for (const key of ["alertDeliveryEvidenceSha256", "errorIngestionEvidenceSha256", "syntheticAlarmEvidenceSha256"]) {
    requireSha256(monitoring[key], `PRODUCTION_CUTOVER_MONITORING_${key.toUpperCase()}_INVALID`);
  }
  const armedAt = within(monitoring.armedAt, startedAt, completedAt, "PRODUCTION_CUTOVER_MONITORING_ARMED_AT");
  return within(monitoring.readinessCheckedAt, armedAt, completedAt, "PRODUCTION_CUTOVER_MONITORING_CHECKED_AT");
}

export function buildProductionCutoverEvidenceSha256(document) {
  const unsignedEvidence = Object.fromEntries(
    Object.entries(document).filter(([key]) => key !== "receipts"),
  );
  return sha256(canonicalJson(unsignedEvidence));
}

function expectedReceiptPayload(document, evidenceSha256) {
  return {
    candidateCommit: document.candidateCommit,
    completedAt: document.completedAt,
    databaseName: document.target.databaseName,
    evidenceSha256,
    neonBranchId: document.target.neonBranchId,
    neonProjectId: document.target.neonProjectId,
    stagedDeploymentId: document.target.stagedDeploymentId,
    status: productionCutoverStatus,
    vercelProjectId: document.target.vercelProjectId,
  };
}

function assertReceipts(document, trustContext, completedAt, evidenceSha256, nowEpochMs) {
  assertExactObjectKeys(document.receipts, Object.keys(productionCutoverReceiptRoles), "PRODUCTION_CUTOVER_RECEIPTS");
  assertExternalGateRoleIndependence(
    trustContext,
    Object.values(productionCutoverReceiptRoles),
  );
  const expectedPayload = expectedReceiptPayload(document, evidenceSha256);
  const receiptIds = new Set();
  const signatureReferences = new Set();
  const receiptSha256ByRole = {};
  for (const [key, role] of Object.entries(productionCutoverReceiptRoles)) {
    const receipt = document.receipts[key];
    verifyExternalGateReceipt({
      expectedRecordType: productionCutoverReceiptRecordType,
      expectedRole: role,
      receipt,
      trustContext,
    });
    invariant(canonicalJson(receipt.payload) === canonicalJson(expectedPayload), "PRODUCTION_CUTOVER_RECEIPT_PAYLOAD_MISMATCH");
    const signedAt = timestamp(receipt.signedAt, "PRODUCTION_CUTOVER_RECEIPT_SIGNED_AT_INVALID");
    invariant(signedAt >= completedAt, "PRODUCTION_CUTOVER_RECEIPT_PREDATES_COMPLETION");
    invariant(
      signedAt <= nowEpochMs + productionCutoverMaximumFutureSkewMs,
      "PRODUCTION_CUTOVER_RECEIPT_SIGNED_AT_IN_FUTURE",
    );
    invariant(
      signedAt >= nowEpochMs - productionCutoverMaximumReadinessAgeMs,
      "PRODUCTION_CUTOVER_RECEIPT_STALE",
    );
    invariant(!receiptIds.has(receipt.receiptId), "PRODUCTION_CUTOVER_RECEIPT_ID_REUSED");
    invariant(!signatureReferences.has(receipt.signatureReference), "PRODUCTION_CUTOVER_RECEIPT_SIGNATURE_REUSED");
    receiptIds.add(receipt.receiptId);
    signatureReferences.add(receipt.signatureReference);
    receiptSha256ByRole[key] = sha256(canonicalJson(receipt));
  }
  return Object.freeze(receiptSha256ByRole);
}

/**
 * Runtime-safe trust-chain verification. This deliberately performs no Git or
 * provider access: the three independent signers attest the canonical complete
 * document digest only after the offline verifier has checked every underlying
 * Candidate blob and operational postcondition.
 */
export function verifyProductionCutoverReceiptBundle({
  document,
  expectedCandidateCommit,
  expectedTarget = null,
  nowEpochMs = Date.now(),
  trustContext,
}) {
  const verifiedAt = verificationClock(nowEpochMs);
  invariant(commitPattern.test(expectedCandidateCommit ?? ""), "PRODUCTION_CUTOVER_EXPECTED_CANDIDATE_INVALID");
  assertExactObjectKeys(document, [
    "candidateCommit",
    "completedAt",
    "database",
    "deployment",
    "monitoring",
    "receipts",
    "recordType",
    "schemaVersion",
    "startedAt",
    "status",
    "storage",
    "target",
  ], "PRODUCTION_CUTOVER_DOCUMENT");
  invariant(document.schemaVersion === productionCutoverSchemaVersion, "PRODUCTION_CUTOVER_SCHEMA_INVALID");
  invariant(document.recordType === productionCutoverRecordType, "PRODUCTION_CUTOVER_RECORD_TYPE_INVALID");
  invariant(document.status === productionCutoverStatus, "PRODUCTION_CUTOVER_STATUS_INVALID");
  invariant(document.candidateCommit === expectedCandidateCommit, "PRODUCTION_CUTOVER_CANDIDATE_MISMATCH");
  const startedAt = timestamp(document.startedAt, "PRODUCTION_CUTOVER_STARTED_AT_INVALID");
  const completedAt = timestamp(document.completedAt, "PRODUCTION_CUTOVER_COMPLETED_AT_INVALID");
  invariant(completedAt >= startedAt, "PRODUCTION_CUTOVER_TIME_ORDER_INVALID");
  assertLaunchReadinessFreshness(startedAt, completedAt, verifiedAt);
  assertTarget(document.target, expectedTarget);
  if (expectedTarget !== null) {
    invariant(
      document.deployment?.rollback?.deploymentId === expectedTarget.rollbackDeploymentId,
      "PRODUCTION_CUTOVER_EXPECTED_ROLLBACK_DEPLOYMENT_MISMATCH",
    );
    invariant(
      document.deployment?.rollback?.deploymentHost === expectedTarget.rollbackDeploymentHost,
      "PRODUCTION_CUTOVER_EXPECTED_ROLLBACK_HOST_MISMATCH",
    );
  }
  const evidenceSha256 = buildProductionCutoverEvidenceSha256(document);
  const receiptSha256ByRole = assertReceipts(
    document,
    trustContext,
    completedAt,
    evidenceSha256,
    verifiedAt,
  );
  return Object.freeze({
    candidateCommit: document.candidateCommit,
    evidenceSha256,
    productionDeploymentHost: document.target.stagedDeploymentHost,
    productionDeploymentId: document.target.stagedDeploymentId,
    receiptSha256ByRole,
    status: productionCutoverStatus,
  });
}

export function verifyProductionCutoverEvidence({
  document,
  expectedCandidateCommit,
  expectedTarget = null,
  nowEpochMs = Date.now(),
  repositoryRoot,
  trustContext,
}) {
  const verifiedAt = verificationClock(nowEpochMs);
  invariant(commitPattern.test(expectedCandidateCommit ?? ""), "PRODUCTION_CUTOVER_EXPECTED_CANDIDATE_INVALID");
  invariant(typeof repositoryRoot === "string" && isAbsolute(repositoryRoot), "PRODUCTION_CUTOVER_REPOSITORY_ROOT_REQUIRED");
  assertExactObjectKeys(document, [
    "candidateCommit",
    "completedAt",
    "database",
    "deployment",
    "monitoring",
    "receipts",
    "recordType",
    "schemaVersion",
    "startedAt",
    "status",
    "storage",
    "target",
  ], "PRODUCTION_CUTOVER_DOCUMENT");
  invariant(document.schemaVersion === productionCutoverSchemaVersion, "PRODUCTION_CUTOVER_SCHEMA_INVALID");
  invariant(document.recordType === productionCutoverRecordType, "PRODUCTION_CUTOVER_RECORD_TYPE_INVALID");
  invariant(document.status === productionCutoverStatus, "PRODUCTION_CUTOVER_STATUS_INVALID");
  invariant(document.candidateCommit === expectedCandidateCommit, "PRODUCTION_CUTOVER_CANDIDATE_MISMATCH");
  const startedAt = timestamp(document.startedAt, "PRODUCTION_CUTOVER_STARTED_AT_INVALID");
  const completedAt = timestamp(document.completedAt, "PRODUCTION_CUTOVER_COMPLETED_AT_INVALID");
  invariant(completedAt >= startedAt, "PRODUCTION_CUTOVER_TIME_ORDER_INVALID");
  assertLaunchReadinessFreshness(startedAt, completedAt, verifiedAt);
  assertTarget(document.target, expectedTarget);
  const ledgerCapturedAt = assertDatabase(document.database, document.candidateCommit, repositoryRoot, startedAt, completedAt);
  const blobCompletedAt = assertStorage(document.storage, startedAt, completedAt);
  const monitoringCheckedAt = assertMonitoring(document.monitoring, startedAt, completedAt);
  assertDeployment(document.deployment, document.target, Math.max(startedAt, ledgerCapturedAt, blobCompletedAt, monitoringCheckedAt), completedAt, expectedTarget);
  return verifyProductionCutoverReceiptBundle({
    document,
    expectedCandidateCommit,
    expectedTarget,
    nowEpochMs: verifiedAt,
    trustContext,
  });
}

export async function loadCanonicalProductionCutoverDocument({
  documentPath,
  repositoryRoot,
}) {
  invariant(typeof documentPath === "string" && isAbsolute(documentPath), "PRODUCTION_CUTOVER_DOCUMENT_ABSOLUTE_PATH_REQUIRED");
  invariant(typeof repositoryRoot === "string" && isAbsolute(repositoryRoot), "PRODUCTION_CUTOVER_REPOSITORY_ROOT_REQUIRED");
  const resolvedDocument = resolve(documentPath);
  const initial = await lstat(resolvedDocument);
  invariant(
    initial.isFile()
      && !initial.isSymbolicLink()
      && initial.nlink === 1
      && initial.size > 0
      && initial.size <= maximumDocumentBytes,
    "PRODUCTION_CUTOVER_DOCUMENT_NOT_BOUNDED_REGULAR_FILE",
  );
  const [realDocument, realRepository] = await Promise.all([
    realpath(resolvedDocument),
    realpath(resolve(repositoryRoot)),
  ]);
  invariant(normalizedPath(realDocument) === normalizedPath(resolvedDocument), "PRODUCTION_CUTOVER_DOCUMENT_NOT_BOUNDED_REGULAR_FILE");
  invariant(outsideDirectory(realRepository, realDocument), "PRODUCTION_CUTOVER_DOCUMENT_MUST_BE_OUTSIDE_REPOSITORY");
  let handle;
  let source;
  try {
    handle = await open(realDocument, "r");
    const opened = await handle.stat();
    invariant(
      opened.isFile()
        && opened.nlink === 1
        && opened.dev === initial.dev
        && opened.ino === initial.ino
        && opened.size === initial.size
        && opened.mtimeMs === initial.mtimeMs,
      "PRODUCTION_CUTOVER_DOCUMENT_CHANGED_DURING_OPEN",
    );
    source = await handle.readFile();
    const after = await handle.stat();
    invariant(
      after.dev === opened.dev
        && after.ino === opened.ino
        && after.size === opened.size
        && after.nlink === opened.nlink
        && after.mtimeMs === opened.mtimeMs
        && source.length === opened.size,
      "PRODUCTION_CUTOVER_DOCUMENT_CHANGED_DURING_READ",
    );
  } finally {
    await handle?.close().catch(() => undefined);
  }
  let document;
  try {
    document = JSON.parse(source.toString("utf8"));
  } catch {
    invariant(false, "PRODUCTION_CUTOVER_DOCUMENT_JSON_INVALID");
  }
  invariant(source.toString("utf8") === canonicalJson(document), "PRODUCTION_CUTOVER_DOCUMENT_NOT_CANONICAL");
  return document;
}
