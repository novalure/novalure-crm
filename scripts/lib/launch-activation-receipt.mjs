import {
  assertExactObjectKeys,
  canonicalJson,
  requireIsoTimestamp,
  requireSha256,
  sha256,
  verifyExternalGateReceipt,
} from "./external-gate-receipts-runtime.mjs";
import {
  launchScopeActivationEnvironmentKeys,
  launchScopeDecisionSha256,
  launchScopePolicySha256,
  launchScopePolicyVersion,
  launchScopeProductionActivationContract,
  launchScopeProductionFlagsEnvironment,
  launchScopeProductionMinimumActivationGeneration,
  resolveLaunchScopeProductionActivation,
} from "../../src/lib/launch-scope.ts";
import { productionCutoverStatus } from "./production-cutover-receipt-runtime.mjs";

export const launchActivationReceiptRecordType =
  "NOVALURE_LAUNCH_ACTIVATION_RECEIPT";
export const launchActivationReceiptRole = "launch-activation-attestor";
export const launchActivationMaximumLeaseMs = 30 * 60 * 1_000;
export const launchActivationMaximumIssuanceLeadMs = 15 * 60 * 1_000;
export const launchActivationClockSkewMs = 60 * 1_000;

const commitPattern = /^[a-f0-9]{40}$/u;
const deploymentIdPattern = /^dpl_[A-Za-z0-9]{20,80}$/u;
const hostPattern = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/u;
const projectIdPattern = /^prj_[A-Za-z0-9]{12,80}$/u;

function invariant(condition, code) {
  if (!condition) throw new Error(code);
}

function validateExpectedLaunchActivation(expected) {
  assertExactObjectKeys(expected, [
    "candidateCommit",
    "activationExpiresAt",
    "activationGeneration",
    "activationNotBefore",
    "deploymentHost",
    "deploymentId",
    "documentBundleSha256",
    "finalAttestationSha256",
    "flagsEnvironment",
    "flagsRevisionFloor",
    "productionDeploymentId",
    "productionDeploymentHost",
    "productionCutoverDbaReceiptSha256",
    "productionCutoverEvidenceSha256",
    "productionCutoverPlatformOperationsReceiptSha256",
    "productionCutoverReleaseObserverReceiptSha256",
    "productionHost",
    "projectId",
    "releaseGateMatrixSha256",
  ], "LAUNCH_ACTIVATION_EXPECTED");
  const notBefore = Date.parse(requireIsoTimestamp(
    expected.activationNotBefore,
    "LAUNCH_ACTIVATION_EXPECTED_NOT_BEFORE_INVALID",
  ));
  const expiresAt = Date.parse(requireIsoTimestamp(
    expected.activationExpiresAt,
    "LAUNCH_ACTIVATION_EXPECTED_EXPIRES_AT_INVALID",
  ));
  invariant(
    expiresAt > notBefore && expiresAt - notBefore <= launchActivationMaximumLeaseMs,
    "LAUNCH_ACTIVATION_EXPECTED_LEASE_WINDOW_INVALID",
  );
  invariant(
    Number.isSafeInteger(expected.activationGeneration)
      && expected.activationGeneration >= launchScopeProductionMinimumActivationGeneration,
    "LAUNCH_ACTIVATION_EXPECTED_GENERATION_INVALID",
  );
  invariant(
    expected.flagsEnvironment === launchScopeProductionFlagsEnvironment,
    "LAUNCH_ACTIVATION_EXPECTED_FLAGS_ENVIRONMENT_INVALID",
  );
  invariant(
    Number.isSafeInteger(expected.flagsRevisionFloor)
      && expected.flagsRevisionFloor >= 0,
    "LAUNCH_ACTIVATION_EXPECTED_FLAGS_REVISION_FLOOR_INVALID",
  );
  invariant(commitPattern.test(expected.candidateCommit ?? ""), "LAUNCH_ACTIVATION_EXPECTED_CANDIDATE_INVALID");
  invariant(hostPattern.test(expected.deploymentHost ?? ""), "LAUNCH_ACTIVATION_EXPECTED_DEPLOYMENT_HOST_INVALID");
  invariant(deploymentIdPattern.test(expected.deploymentId ?? ""), "LAUNCH_ACTIVATION_EXPECTED_DEPLOYMENT_INVALID");
  invariant(
    deploymentIdPattern.test(expected.productionDeploymentId ?? ""),
    "LAUNCH_ACTIVATION_EXPECTED_PRODUCTION_DEPLOYMENT_INVALID",
  );
  invariant(hostPattern.test(expected.productionDeploymentHost ?? ""), "LAUNCH_ACTIVATION_EXPECTED_PRODUCTION_DEPLOYMENT_HOST_INVALID");
  invariant(hostPattern.test(expected.productionHost ?? ""), "LAUNCH_ACTIVATION_EXPECTED_HOST_INVALID");
  invariant(projectIdPattern.test(expected.projectId ?? ""), "LAUNCH_ACTIVATION_EXPECTED_PROJECT_INVALID");
  requireSha256(expected.documentBundleSha256, "LAUNCH_ACTIVATION_EXPECTED_BUNDLE_DIGEST_INVALID");
  requireSha256(expected.finalAttestationSha256, "LAUNCH_ACTIVATION_EXPECTED_ATTESTATION_DIGEST_INVALID");
  requireSha256(expected.releaseGateMatrixSha256, "LAUNCH_ACTIVATION_EXPECTED_MATRIX_DIGEST_INVALID");
  requireSha256(expected.productionCutoverEvidenceSha256, "LAUNCH_ACTIVATION_EXPECTED_PRODUCTION_CUTOVER_EVIDENCE_DIGEST_INVALID");
  requireSha256(expected.productionCutoverDbaReceiptSha256, "LAUNCH_ACTIVATION_EXPECTED_PRODUCTION_CUTOVER_DBA_RECEIPT_DIGEST_INVALID");
  requireSha256(expected.productionCutoverPlatformOperationsReceiptSha256, "LAUNCH_ACTIVATION_EXPECTED_PRODUCTION_CUTOVER_PLATFORM_RECEIPT_DIGEST_INVALID");
  requireSha256(expected.productionCutoverReleaseObserverReceiptSha256, "LAUNCH_ACTIVATION_EXPECTED_PRODUCTION_CUTOVER_OBSERVER_RECEIPT_DIGEST_INVALID");
  return expected;
}

export function expectedLaunchActivationPayload(expected) {
  validateExpectedLaunchActivation(expected);
  return Object.freeze({
    activationDecision: "GO",
    activationExpiresAt: expected.activationExpiresAt,
    activationGeneration: expected.activationGeneration,
    activationNotBefore: expected.activationNotBefore,
    candidateCommit: expected.candidateCommit,
    deploymentHost: expected.deploymentHost,
    deploymentId: expected.deploymentId,
    documentBundleSha256: expected.documentBundleSha256,
    finalAttestationSha256: expected.finalAttestationSha256,
    flagsEnvironment: expected.flagsEnvironment,
    flagsRevisionFloor: expected.flagsRevisionFloor,
    launchScopeDecisionSha256,
    launchScopePolicySha256,
    launchScopePolicyVersion,
    productionCutoverDbaReceiptSha256: expected.productionCutoverDbaReceiptSha256,
    productionCutoverEvidenceSha256: expected.productionCutoverEvidenceSha256,
    productionCutoverPlatformOperationsReceiptSha256:
      expected.productionCutoverPlatformOperationsReceiptSha256,
    productionCutoverReleaseObserverReceiptSha256:
      expected.productionCutoverReleaseObserverReceiptSha256,
    productionDeploymentId: expected.productionDeploymentId,
    productionDeploymentHost: expected.productionDeploymentHost,
    productionHost: expected.productionHost,
    projectId: expected.projectId,
    releaseGateMatrixSha256: expected.releaseGateMatrixSha256,
  });
}

function validateReceiptPayload(payload, expected) {
  assertExactObjectKeys(payload, [
    "activationDecision",
    "activationExpiresAt",
    "activationGeneration",
    "activationNotBefore",
    "candidateCommit",
    "deploymentHost",
    "deploymentId",
    "documentBundleSha256",
    "finalAttestationSha256",
    "flagsEnvironment",
    "flagsRevisionFloor",
    "launchScopeDecisionSha256",
    "launchScopePolicySha256",
    "launchScopePolicyVersion",
    "productionCutoverDbaReceiptSha256",
    "productionCutoverEvidenceSha256",
    "productionCutoverPlatformOperationsReceiptSha256",
    "productionCutoverReleaseObserverReceiptSha256",
    "productionDeploymentId",
    "productionDeploymentHost",
    "productionHost",
    "projectId",
    "releaseGateMatrixSha256",
  ], "LAUNCH_ACTIVATION_PAYLOAD");
  const canonicalExpected = expectedLaunchActivationPayload(expected);
  invariant(
    canonicalJson(payload) === canonicalJson(canonicalExpected),
    "LAUNCH_ACTIVATION_PAYLOAD_BINDING_MISMATCH",
  );
  return payload;
}

function validateProductionCutoverVerification(verification, expected) {
  assertExactObjectKeys(verification, [
    "candidateCommit",
    "evidenceSha256",
    "productionDeploymentHost",
    "productionDeploymentId",
    "receiptSha256ByRole",
    "status",
  ], "LAUNCH_ACTIVATION_PRODUCTION_CUTOVER_VERIFICATION");
  assertExactObjectKeys(verification.receiptSha256ByRole, [
    "dba",
    "platformOperations",
    "releaseObserver",
  ], "LAUNCH_ACTIVATION_PRODUCTION_CUTOVER_RECEIPTS");
  invariant(verification.status === productionCutoverStatus, "LAUNCH_ACTIVATION_PRODUCTION_CUTOVER_NOT_READY");
  invariant(verification.candidateCommit === expected.candidateCommit, "LAUNCH_ACTIVATION_PRODUCTION_CUTOVER_CANDIDATE_MISMATCH");
  invariant(verification.productionDeploymentId === expected.productionDeploymentId, "LAUNCH_ACTIVATION_PRODUCTION_CUTOVER_DEPLOYMENT_MISMATCH");
  invariant(
    verification.productionDeploymentHost === expected.productionDeploymentHost,
    "LAUNCH_ACTIVATION_PRODUCTION_CUTOVER_HOST_MISMATCH",
  );
  invariant(verification.evidenceSha256 === expected.productionCutoverEvidenceSha256, "LAUNCH_ACTIVATION_PRODUCTION_CUTOVER_EVIDENCE_MISMATCH");
  invariant(verification.receiptSha256ByRole.dba === expected.productionCutoverDbaReceiptSha256, "LAUNCH_ACTIVATION_PRODUCTION_CUTOVER_DBA_RECEIPT_MISMATCH");
  invariant(
    verification.receiptSha256ByRole.platformOperations
      === expected.productionCutoverPlatformOperationsReceiptSha256,
    "LAUNCH_ACTIVATION_PRODUCTION_CUTOVER_PLATFORM_RECEIPT_MISMATCH",
  );
  invariant(
    verification.receiptSha256ByRole.releaseObserver
      === expected.productionCutoverReleaseObserverReceiptSha256,
    "LAUNCH_ACTIVATION_PRODUCTION_CUTOVER_OBSERVER_RECEIPT_MISMATCH",
  );
  return verification;
}

function buildLaunchActivationRuntimeEnvironment({
  expected,
  receipt,
  trustContext,
}) {
  validateExpectedLaunchActivation(expected);
  validateReceiptPayload(receipt.payload, expected);
  const receiptSha256 = sha256(canonicalJson(receipt));
  const values = {
    activationExpiresAt: expected.activationExpiresAt,
    activationGeneration: String(expected.activationGeneration),
    activationNotBefore: expected.activationNotBefore,
    candidateCommit: expected.candidateCommit,
    contract: launchScopeProductionActivationContract,
    decision: "GO",
    decisionSha256: launchScopeDecisionSha256,
    evidenceDeploymentHost: expected.deploymentHost,
    evidenceDeploymentId: expected.deploymentId,
    documentBundleSha256: expected.documentBundleSha256,
    finalAttestationSha256: expected.finalAttestationSha256,
    flagsEnvironment: expected.flagsEnvironment,
    flagsRevisionFloor: String(expected.flagsRevisionFloor),
    policySha256: launchScopePolicySha256,
    policyVersion: launchScopePolicyVersion,
    productionDeploymentId: expected.productionDeploymentId,
    productionDeploymentHost: expected.productionDeploymentHost,
    productionHost: expected.productionHost,
    projectId: expected.projectId,
    receiptSha256,
    releaseGateMatrixSha256: expected.releaseGateMatrixSha256,
    trustAnchorSha256: trustContext.expectedSha256,
  };
  return Object.freeze(Object.fromEntries(
    Object.entries(launchScopeActivationEnvironmentKeys)
      .map(([field, environmentName]) => [environmentName, values[field]]),
  ));
}

/**
 * Verify the detached Ed25519 signature against an independently loaded trust
 * anchor and then prove that the emitted runtime binding is accepted by the
 * exact same client-safe resolver used by Production guards.
 */
export function verifyLaunchActivationReceipt({
  expected,
  nowEpochMs = Date.now(),
  productionCutoverVerification,
  receipt,
  trustContext,
}) {
  validateExpectedLaunchActivation(expected);
  invariant(
    Number.isSafeInteger(nowEpochMs) && nowEpochMs > 0,
    "LAUNCH_ACTIVATION_VERIFICATION_CLOCK_INVALID",
  );
  const activationNotBefore = Date.parse(expected.activationNotBefore);
  const activationExpiresAt = Date.parse(expected.activationExpiresAt);
  invariant(
    nowEpochMs >= activationNotBefore && nowEpochMs < activationExpiresAt,
    "LAUNCH_ACTIVATION_LEASE_INACTIVE",
  );
  validateProductionCutoverVerification(productionCutoverVerification, expected);
  invariant(
    sha256(canonicalJson(trustContext?.anchor)) === trustContext?.expectedSha256,
    "LAUNCH_ACTIVATION_TRUST_ANCHOR_DIGEST_MISMATCH",
  );
  verifyExternalGateReceipt({
    expectedRecordType: launchActivationReceiptRecordType,
    expectedRole: launchActivationReceiptRole,
    receipt,
    trustContext,
  });
  const receiptSignedAt = Date.parse(receipt.signedAt);
  invariant(
    receiptSignedAt >= activationNotBefore - launchActivationMaximumIssuanceLeadMs
      && receiptSignedAt <= activationNotBefore + launchActivationClockSkewMs,
    "LAUNCH_ACTIVATION_RECEIPT_SIGNING_WINDOW_INVALID",
  );
  validateReceiptPayload(receipt.payload, expected);
  const runtimeEnvironment = buildLaunchActivationRuntimeEnvironment({
    expected,
    receipt,
    trustContext,
  });
  const activation = resolveLaunchScopeProductionActivation({
    ...runtimeEnvironment,
    VERCEL: "1",
    VERCEL_ENV: "production",
    VERCEL_GIT_COMMIT_SHA: expected.candidateCommit,
    VERCEL_DEPLOYMENT_ID: expected.productionDeploymentId,
    VERCEL_PROJECT_ID: expected.projectId,
    VERCEL_PROJECT_PRODUCTION_URL: expected.productionHost,
    VERCEL_URL: expected.productionDeploymentHost,
  });
  invariant(activation.active, "LAUNCH_ACTIVATION_RUNTIME_BINDING_REJECTED");
  return Object.freeze({
    activation,
    productionCutoverVerification,
    receiptSha256: runtimeEnvironment[
      launchScopeActivationEnvironmentKeys.receiptSha256
    ],
    runtimeEnvironment,
    signatureReference: receipt.signatureReference,
    status: "VERIFIED",
  });
}
