import {
  assertExternalGateRoleIndependence,
  assertExactObjectKeys,
  canonicalJson,
  requireIsoTimestamp,
  requireSha256,
  sha256,
  verifyExternalGateReceipt,
} from "./external-gate-receipts-runtime.mjs";
import {
  recoveryExpectedDatabaseName,
  recoveryExpectedProductionBranchId,
  recoveryExpectedProjectId,
} from "./database-recovery-query-pack.mjs";

// Cryptographic post-cutover verification only. The offline module performs
// Git, filesystem and operational evidence validation before the three roles
// sign this exact canonical document digest.
export const productionCutoverSchemaVersion = 2;
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
export const productionCutoverActivationFlagKey =
  "novalure-production-launch-activation";
export const productionCutoverActivationFlagsEnvironment = "production";
export const productionCutoverMaximumFutureSkewMs = 60 * 1000;
export const productionCutoverMaximumReadinessAgeMs = 30 * 60 * 1000;
export const productionCutoverMaximumReceiptSigningDelayMs = 5 * 60 * 1000;
export const productionCutoverReceiptRoles = Object.freeze({
  dba: "production-cutover-dba",
  platformOperations: "production-cutover-platform-operations",
  releaseObserver: "production-cutover-release-observer",
});

const commitPattern = /^[a-f0-9]{40}$/u;
const deploymentIdPattern = /^dpl_[A-Za-z0-9]{20,80}$/u;
const vercelHostPattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.vercel\.app$/u;
const strictUtcTimestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

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

function assertRuntimeActivationSequence(document, startedAt, completedAt) {
  const deployment = document.deployment;
  assertExactObjectKeys(deployment, [
    "activationFlagOff",
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
  const stagedAt = timestamp(deployment.stagedAt, "PRODUCTION_CUTOVER_STAGED_AT_INVALID");
  const rollbackVerifiedAt = timestamp(deployment.rollback?.verifiedAt, "PRODUCTION_CUTOVER_ROLLBACK_VERIFIED_AT_INVALID");
  const prePromotionSmokeAt = timestamp(deployment.prePromotionSmoke?.checkedAt, "PRODUCTION_CUTOVER_PRE_PROMOTION_SMOKE_CHECKED_AT_INVALID");
  invariant(stagedAt >= startedAt && stagedAt <= rollbackVerifiedAt, "PRODUCTION_CUTOVER_ROLLBACK_VERIFIED_AT_ORDER_INVALID");
  invariant(rollbackVerifiedAt <= prePromotionSmokeAt, "PRODUCTION_CUTOVER_PRE_PROMOTION_SMOKE_CHECKED_AT_ORDER_INVALID");
  invariant(deployment.rollback?.status === "READY", "PRODUCTION_CUTOVER_ROLLBACK_NOT_READY");
  invariant(deployment.prePromotionSmoke?.activationState === "SAFE_CLOSED", "PRODUCTION_CUTOVER_PRE_PROMOTION_SMOKE_ACTIVATION_NOT_SAFE_CLOSED");
  invariant(deployment.prePromotionSmoke?.result === "PASS", "PRODUCTION_CUTOVER_PRE_PROMOTION_SMOKE_RESULT_INVALID");
  invariant(deployment.prePromotionSmoke?.deploymentId === document.target.stagedDeploymentId, "PRODUCTION_CUTOVER_PRE_PROMOTION_SMOKE_DEPLOYMENT_MISMATCH");
  invariant(deployment.prePromotionSmoke?.deploymentHost === document.target.stagedDeploymentHost, "PRODUCTION_CUTOVER_PRE_PROMOTION_SMOKE_HOST_MISMATCH");
  const flag = deployment.activationFlagOff;
  assertExactObjectKeys(flag, [
    "environment",
    "evidenceSha256",
    "flagKey",
    "observedAt",
    "projectId",
    "readMode",
    "revision",
    "state",
  ], "PRODUCTION_CUTOVER_ACTIVATION_FLAG_OFF");
  invariant(flag.environment === productionCutoverActivationFlagsEnvironment, "PRODUCTION_CUTOVER_ACTIVATION_FLAG_ENVIRONMENT_INVALID");
  invariant(flag.flagKey === productionCutoverActivationFlagKey, "PRODUCTION_CUTOVER_ACTIVATION_FLAG_KEY_INVALID");
  invariant(flag.projectId === productionCutoverExpectedVercelProjectId, "PRODUCTION_CUTOVER_ACTIVATION_FLAG_PROJECT_INVALID");
  invariant(flag.readMode === "REMOTE_NO_STORE", "PRODUCTION_CUTOVER_ACTIVATION_FLAG_READ_MODE_INVALID");
  invariant(Number.isSafeInteger(flag.revision) && flag.revision > 0, "PRODUCTION_CUTOVER_ACTIVATION_FLAG_REVISION_INVALID");
  invariant(flag.state === "OFF", "PRODUCTION_CUTOVER_ACTIVATION_FLAG_NOT_OFF");
  requireSha256(flag.evidenceSha256, "PRODUCTION_CUTOVER_ACTIVATION_FLAG_EVIDENCE_INVALID");
  const flagObservedAt = timestamp(flag.observedAt, "PRODUCTION_CUTOVER_ACTIVATION_FLAG_OBSERVED_AT_INVALID");
  const promotedAt = timestamp(deployment.aliasPromotion?.promotedAt, "PRODUCTION_CUTOVER_ALIAS_PROMOTED_AT_INVALID");
  const safeClosedSmokeAt = timestamp(deployment.postPromotionSmoke?.checkedAt, "PRODUCTION_CUTOVER_POST_PROMOTION_SMOKE_CHECKED_AT_INVALID");
  invariant(prePromotionSmokeAt < flagObservedAt && flagObservedAt < promotedAt, "PRODUCTION_CUTOVER_ACTIVATION_FLAG_OBSERVED_AT_ORDER_INVALID");
  invariant(deployment.aliasPromotion?.alias === productionCutoverExpectedProductionHost, "PRODUCTION_CUTOVER_ALIAS_MISMATCH");
  invariant(deployment.aliasPromotion?.sourceDeploymentId === document.target.stagedDeploymentId, "PRODUCTION_CUTOVER_ALIAS_SOURCE_MISMATCH");
  invariant(deployment.aliasPromotion?.previousDeploymentId === deployment.rollback?.deploymentId, "PRODUCTION_CUTOVER_ALIAS_PREVIOUS_MISMATCH");
  invariant(deployment.aliasPromotion?.result === "PROMOTED_EXACT", "PRODUCTION_CUTOVER_ALIAS_RESULT_INVALID");
  invariant(promotedAt < safeClosedSmokeAt && safeClosedSmokeAt <= completedAt, "PRODUCTION_CUTOVER_POST_PROMOTION_SMOKE_CHECKED_AT_ORDER_INVALID");
  invariant(deployment.postPromotionSmoke?.activationState === "SAFE_CLOSED", "PRODUCTION_CUTOVER_POST_PROMOTION_SMOKE_ACTIVATION_NOT_SAFE_CLOSED");
  invariant(deployment.postPromotionSmoke?.result === "PASS_SAFE_CLOSED", "PRODUCTION_CUTOVER_POST_PROMOTION_SMOKE_RESULT_INVALID");
  invariant(deployment.postPromotionSmoke?.deploymentId === document.target.stagedDeploymentId, "PRODUCTION_CUTOVER_POST_PROMOTION_SMOKE_DEPLOYMENT_MISMATCH");
  invariant(deployment.postPromotionSmoke?.deploymentHost === productionCutoverExpectedProductionHost, "PRODUCTION_CUTOVER_POST_PROMOTION_SMOKE_HOST_MISMATCH");
  return flag.revision;
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
  let latestReceiptSignedAt = completedAt;
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
      signedAt <= completedAt + productionCutoverMaximumReceiptSigningDelayMs,
      "PRODUCTION_CUTOVER_RECEIPT_SIGNING_WINDOW_EXCEEDED",
    );
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
    latestReceiptSignedAt = Math.max(latestReceiptSignedAt, signedAt);
  }
  return Object.freeze({
    latestReceiptSignedAt,
    receiptSha256ByRole: Object.freeze(receiptSha256ByRole),
  });
}

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
  const activationFlagOffRevision = assertRuntimeActivationSequence(
    document,
    startedAt,
    completedAt,
  );
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
  const receiptVerification = assertReceipts(
    document,
    trustContext,
    completedAt,
    evidenceSha256,
    verifiedAt,
  );
  return Object.freeze({
    activationFlagOffRevision,
    candidateCommit: document.candidateCommit,
    completedAt: document.completedAt,
    evidenceSha256,
    latestReceiptSignedAt: new Date(
      receiptVerification.latestReceiptSignedAt,
    ).toISOString(),
    launchReadinessValidUntil: new Date(
      startedAt + productionCutoverMaximumReadinessAgeMs,
    ).toISOString(),
    productionDeploymentHost: document.target.stagedDeploymentHost,
    productionDeploymentId: document.target.stagedDeploymentId,
    receiptSha256ByRole: receiptVerification.receiptSha256ByRole,
    status: productionCutoverStatus,
  });
}
