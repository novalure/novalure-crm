import {
  assertExactObjectKeys,
  canonicalJson,
  requireIsoTimestamp,
  requireSha256,
  sha256,
  validateExternalGateRuntimeBinding,
} from "./external-gate-receipts.mjs";

export const a11yFixtureLifecycleRecordType =
  "NOVALURE_A11Y_PREVIEW_FIXTURE_LIFECYCLE_EVIDENCE";
export const a11yFixtureLifecycleFileName = "a11y-fixture-lifecycle.json";
export const a11yFixtureLifecycleSidecarFileName = `${a11yFixtureLifecycleFileName}.sha256`;
export const a11yBrowserEvidenceFileName = "a11y-browser-matrix.json";
export const a11yBrowserEvidenceSidecarFileName = `${a11yBrowserEvidenceFileName}.sha256`;
export const a11yRetainedTableNames = Object.freeze([
  "analytics_events",
  "audit_logs",
  "csrf_token_consumptions",
  "public_submission_idempotency",
  "public_submission_rate_limits",
  "qa_batch_objects",
  "qa_reset_audit_events",
]);

function invariant(condition, code) {
  if (!condition) throw new Error(code);
}

function requireCount(value, code) {
  invariant(Number.isSafeInteger(value) && value >= 0, code);
  return value;
}

function validateInventory(inventory, code) {
  assertExactObjectKeys(inventory, ["digest", "rowCount"], code);
  requireSha256(inventory.digest, `${code}_DIGEST_INVALID`);
  requireCount(inventory.rowCount, `${code}_ROW_COUNT_INVALID`);
}

function validateRetainedInventory(inventory, code) {
  assertExactObjectKeys(inventory, ["digest", "rowCount", "tables"], code);
  requireSha256(inventory.digest, `${code}_DIGEST_INVALID`);
  requireCount(inventory.rowCount, `${code}_ROW_COUNT_INVALID`);
  assertExactObjectKeys(inventory.tables, a11yRetainedTableNames, `${code}_TABLES`);
  let total = 0;
  for (const name of a11yRetainedTableNames) {
    assertExactObjectKeys(inventory.tables[name], ["digest", "rowCount"], `${code}_TABLE`);
    requireSha256(inventory.tables[name].digest, `${code}_TABLE_DIGEST_INVALID`);
    total += requireCount(inventory.tables[name].rowCount, `${code}_TABLE_ROW_COUNT_INVALID`);
  }
  invariant(total === inventory.rowCount, `${code}_ROW_COUNT_MISMATCH`);
}

function validateCleanupScope(scope, code) {
  assertExactObjectKeys(scope, [
    "auditCount",
    "batchFingerprint",
    "createdObjectCount",
    "deletedObjectCount",
    "executedCount",
    "ledgerCount",
    "liveCascadeCount",
    "liveRegisteredCount",
    "unexpectedLedgerCount",
  ], code);
  invariant(/^sha256:[a-f0-9]{64}$/u.test(scope.batchFingerprint ?? ""), `${code}_BATCH_INVALID`);
  for (const field of [
    "auditCount",
    "createdObjectCount",
    "deletedObjectCount",
    "executedCount",
    "ledgerCount",
    "liveCascadeCount",
    "liveRegisteredCount",
    "unexpectedLedgerCount",
  ]) requireCount(scope[field], `${code}_${field.toUpperCase()}_INVALID`);
  invariant(
    scope.auditCount >= 1
      && scope.executedCount === 1
      && scope.createdObjectCount === scope.deletedObjectCount
      && scope.createdObjectCount === scope.ledgerCount
      && scope.liveCascadeCount === 0
      && scope.liveRegisteredCount === 0
      && scope.unexpectedLedgerCount === 0,
    `${code}_NOT_RECONCILED`,
  );
}

export function validateA11yFixtureLifecycleEvidence({
  browserEvidenceSha256,
  document,
  expectedRuntime,
  lifecycleSha256,
}) {
  requireSha256(browserEvidenceSha256, "A11Y_FIXTURE_LIFECYCLE_BROWSER_DIGEST_INVALID");
  requireSha256(lifecycleSha256, "A11Y_FIXTURE_LIFECYCLE_DIGEST_INVALID");
  invariant(
    lifecycleSha256 === sha256(canonicalJson(document)),
    "A11Y_FIXTURE_LIFECYCLE_DIGEST_MISMATCH",
  );
  assertExactObjectKeys(document, [
    "browserEvidence",
    "candidateCommit",
    "cleanup",
    "completedAt",
    "database",
    "deploymentHost",
    "deploymentId",
    "gitBranch",
    "neonBranchId",
    "neonProjectId",
    "productionMutationPerformed",
    "recordType",
    "runId",
    "schemaVersion",
    "status",
  ], "A11Y_FIXTURE_LIFECYCLE");
  invariant(
    document.schemaVersion === 1
      && document.recordType === a11yFixtureLifecycleRecordType
      && document.status === "PASS"
      && document.productionMutationPerformed === false,
    "A11Y_FIXTURE_LIFECYCLE_STATUS_INVALID",
  );
  requireIsoTimestamp(document.completedAt, "A11Y_FIXTURE_LIFECYCLE_TIME_INVALID");
  invariant(
    /^a11y-run-[a-f0-9-]{36}$/u.test(document.runId ?? ""),
    "A11Y_FIXTURE_LIFECYCLE_RUN_ID_INVALID",
  );
  const runtimeBinding = {
    candidateCommit: document.candidateCommit,
    databaseBranchId: document.neonBranchId,
    deploymentHost: document.deploymentHost,
    deploymentId: document.deploymentId,
    gitBranch: document.gitBranch,
    productionMutationPerformed: document.productionMutationPerformed,
  };
  validateExternalGateRuntimeBinding(runtimeBinding, {
    candidateCommit: expectedRuntime.candidateCommit,
    databaseBranchId: expectedRuntime.databaseBranchId,
    deploymentHost: expectedRuntime.deploymentHost,
    deploymentId: expectedRuntime.deploymentId,
    gitBranch: expectedRuntime.gitBranch,
    productionMutationPerformed: expectedRuntime.productionMutationPerformed,
  });
  invariant(
    /^[-A-Za-z0-9]{8,80}$/u.test(expectedRuntime.databaseProjectId ?? "")
      && document.neonProjectId === expectedRuntime.databaseProjectId,
    "A11Y_FIXTURE_LIFECYCLE_DATABASE_PROJECT_MISMATCH",
  );
  assertExactObjectKeys(document.browserEvidence, [
    "fileName",
    "sha256",
    "sidecarFileName",
    "sidecarSha256",
    "sizeBytes",
  ], "A11Y_FIXTURE_LIFECYCLE_BROWSER_EVIDENCE");
  invariant(
    document.browserEvidence.fileName === a11yBrowserEvidenceFileName
      && document.browserEvidence.sidecarFileName === a11yBrowserEvidenceSidecarFileName
      && document.browserEvidence.sha256 === browserEvidenceSha256,
    "A11Y_FIXTURE_LIFECYCLE_BROWSER_EVIDENCE_MISMATCH",
  );
  requireSha256(
    document.browserEvidence.sidecarSha256,
    "A11Y_FIXTURE_LIFECYCLE_BROWSER_SIDECAR_DIGEST_INVALID",
  );
  requireCount(
    document.browserEvidence.sizeBytes,
    "A11Y_FIXTURE_LIFECYCLE_BROWSER_SIZE_INVALID",
  );
  invariant(document.browserEvidence.sizeBytes > 0, "A11Y_FIXTURE_LIFECYCLE_BROWSER_SIZE_INVALID");

  assertExactObjectKeys(document.cleanup, [
    "crossTenant",
    "primary",
    "remainingBatchObjectCount",
    "residualLiveObjectCount",
    "status",
  ], "A11Y_FIXTURE_LIFECYCLE_CLEANUP");
  invariant(
    document.cleanup.status === "PASS"
      && document.cleanup.remainingBatchObjectCount === 0
      && document.cleanup.residualLiveObjectCount === 0,
    "A11Y_FIXTURE_LIFECYCLE_CLEANUP_NOT_PASS",
  );
  validateCleanupScope(document.cleanup.primary, "A11Y_FIXTURE_LIFECYCLE_PRIMARY");
  validateCleanupScope(document.cleanup.crossTenant, "A11Y_FIXTURE_LIFECYCLE_CROSS_TENANT");
  invariant(
    document.cleanup.primary.batchFingerprint !== document.cleanup.crossTenant.batchFingerprint,
    "A11Y_FIXTURE_LIFECYCLE_BATCHES_NOT_DISTINCT",
  );

  assertExactObjectKeys(document.database, [
    "operationalAfter",
    "operationalBefore",
    "retainedAfter",
    "retainedBefore",
    "targetDigest",
  ], "A11Y_FIXTURE_LIFECYCLE_DATABASE");
  invariant(/^sha256:[a-f0-9]{64}$/u.test(document.database.targetDigest ?? ""),
    "A11Y_FIXTURE_LIFECYCLE_DATABASE_TARGET_INVALID");
  validateInventory(document.database.operationalBefore, "A11Y_FIXTURE_LIFECYCLE_OPERATIONAL_BEFORE");
  validateInventory(document.database.operationalAfter, "A11Y_FIXTURE_LIFECYCLE_OPERATIONAL_AFTER");
  invariant(
    document.database.operationalAfter.digest === document.database.operationalBefore.digest
      && document.database.operationalAfter.rowCount === document.database.operationalBefore.rowCount,
    "A11Y_FIXTURE_LIFECYCLE_OPERATIONAL_NOT_RESTORED",
  );
  validateRetainedInventory(document.database.retainedBefore, "A11Y_FIXTURE_LIFECYCLE_RETAINED_BEFORE");
  validateRetainedInventory(document.database.retainedAfter, "A11Y_FIXTURE_LIFECYCLE_RETAINED_AFTER");
  for (const name of a11yRetainedTableNames) {
    invariant(
      document.database.retainedAfter.tables[name].rowCount
        >= document.database.retainedBefore.tables[name].rowCount,
      "A11Y_FIXTURE_LIFECYCLE_RETAINED_TABLE_DECREASED",
    );
  }
  return Object.freeze({
    browserEvidenceSha256,
    lifecycleSha256,
    status: "VERIFIED",
  });
}
