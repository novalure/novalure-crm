import {
  assertExactObjectKeys,
  canonicalJson,
  isPlainObject,
  requireIsoTimestamp,
  requireSafeText,
  requireSha256,
  sha256,
  validateExternalGateRuntimeBinding,
  verifyExternalGateReceipt,
} from "./external-gate-receipts.mjs";

export const providerResendDomainOwnerRole = "provider-resend-domain-owner";
export const providerCalendarOwnerRole = "provider-calendar-owner";
export const providerAcceptanceRoles = Object.freeze([
  providerResendDomainOwnerRole,
  providerCalendarOwnerRole,
]);
export const providerAcceptanceRecordType = "NOVALURE_PROVIDER_ACCEPTANCE_RECEIPT";
export const providerFinalCleanupRole = "provider-final-cleanup-attestor";
export const providerFinalCleanupRecordType = "NOVALURE_PROVIDER_FINAL_CLEANUP_RECEIPT";

export const requiredProviderAcceptances = Object.freeze({
  "password-reset-email": Object.freeze({
    outcomes: Object.freeze([
      "delivery-observed",
      "expired-link-rejected",
      "link-consumed",
      "replay-rejected",
      "request-accepted",
    ]),
    providers: Object.freeze(["RESEND"]),
    receiptRole: providerResendDomainOwnerRole,
    targetPurpose: "PASSWORD_RESET_QA",
  }),
  "workspace-invitation-email": Object.freeze({
    outcomes: Object.freeze([
      "delivery-observed",
      "invitation-accepted",
      "membership-observed",
      "replay-rejected",
    ]),
    providers: Object.freeze(["RESEND"]),
    receiptRole: providerResendDomainOwnerRole,
    targetPurpose: "WORKSPACE_INVITATION_QA",
  }),
  "invitation-resend-email": Object.freeze({
    outcomes: Object.freeze([
      "delivery-observed",
      "new-link-consumed",
      "prior-link-rejected",
      "replay-rejected",
    ]),
    providers: Object.freeze(["RESEND"]),
    receiptRole: providerResendDomainOwnerRole,
    targetPurpose: "INVITATION_RESEND_QA",
  }),
  "customer-access-invitation-email": Object.freeze({
    outcomes: Object.freeze([
      "access-activated",
      "delivery-observed",
      "link-consumed",
      "replay-rejected",
    ]),
    providers: Object.freeze(["RESEND"]),
    receiptRole: providerResendDomainOwnerRole,
    targetPurpose: "CUSTOMER_ACCESS_INVITATION_QA",
  }),
  "calendar-google-roundtrip": Object.freeze({
    outcomes: Object.freeze([
      "calendar-create-observed",
      "calendar-delete-observed",
      "calendar-update-observed",
      "oauth-connected",
      "oauth-disconnected",
    ]),
    providers: Object.freeze(["GOOGLE_CALENDAR"]),
    receiptRole: providerCalendarOwnerRole,
    targetPurpose: "GOOGLE_CALENDAR_ROUNDTRIP_QA",
  }),
  "calendar-microsoft-roundtrip": Object.freeze({
    outcomes: Object.freeze([
      "calendar-create-observed",
      "calendar-delete-observed",
      "calendar-update-observed",
      "oauth-connected",
      "oauth-disconnected",
    ]),
    providers: Object.freeze(["MICROSOFT_GRAPH"]),
    receiptRole: providerCalendarOwnerRole,
    targetPurpose: "MICROSOFT_CALENDAR_ROUNDTRIP_QA",
  }),
});

function invariant(condition, code) {
  if (!condition) throw new Error(code);
}

function assertExactInventory(actual, expected, code) {
  invariant(Array.isArray(actual) && actual.length === expected.length, `${code}_COUNT_INVALID`);
  invariant(new Set(actual).size === actual.length, `${code}_DUPLICATED`);
  const sorted = [...actual].sort();
  const expectedSorted = [...expected].sort();
  invariant(sorted.every((value, index) => value === expectedSorted[index]), `${code}_INVALID`);
}

function validateProviderIdentity(identity, expectedProviders) {
  assertExactObjectKeys(identity, [
    "providerAccountFingerprint",
    "providerEnvironment",
    "providerLogArtifactSha256",
    "providerName",
  ], "PROVIDER_ACCEPTANCE_IDENTITY");
  invariant(expectedProviders.includes(identity.providerName), "PROVIDER_ACCEPTANCE_PROVIDER_INVALID");
  invariant(identity.providerEnvironment === "QA_PREVIEW", "PROVIDER_ACCEPTANCE_ENVIRONMENT_INVALID");
  invariant(
    /^sha256:[a-f0-9]{64}$/u.test(identity.providerAccountFingerprint ?? ""),
    "PROVIDER_ACCEPTANCE_ACCOUNT_FINGERPRINT_INVALID",
  );
  requireSha256(identity.providerLogArtifactSha256, "PROVIDER_ACCEPTANCE_LOG_DIGEST_INVALID");
}

function validateObservationWindow(window) {
  assertExactObjectKeys(window, ["completedAt", "startedAt"], "PROVIDER_ACCEPTANCE_WINDOW");
  requireIsoTimestamp(window.startedAt, "PROVIDER_ACCEPTANCE_WINDOW_START_INVALID");
  requireIsoTimestamp(window.completedAt, "PROVIDER_ACCEPTANCE_WINDOW_END_INVALID");
  invariant(
    Date.parse(window.completedAt) >= Date.parse(window.startedAt),
    "PROVIDER_ACCEPTANCE_WINDOW_ORDER_INVALID",
  );
}

export function validateProviderAcceptanceReceipts({
  databasePostcondition,
  receipts,
  runtime,
  sourceArtifactSha256,
  sourceCollectorSha256,
  sourceCompletedAt,
  trustContext,
}) {
  invariant(Array.isArray(receipts), "PROVIDER_ACCEPTANCE_RECEIPTS_REQUIRED");
  invariant(isPlainObject(databasePostcondition), "PROVIDER_ACCEPTANCE_DATABASE_POSTCONDITION_REQUIRED");
  const databasePostconditionSha256 = sha256(canonicalJson(databasePostcondition));
  requireSha256(sourceArtifactSha256, "PROVIDER_ACCEPTANCE_SOURCE_ARTIFACT_DIGEST_INVALID");
  requireSha256(sourceCollectorSha256, "PROVIDER_ACCEPTANCE_SOURCE_COLLECTOR_DIGEST_INVALID");
  requireIsoTimestamp(sourceCompletedAt, "PROVIDER_ACCEPTANCE_SOURCE_COMPLETED_AT_INVALID");
  const requiredIds = Object.keys(requiredProviderAcceptances);
  assertExactInventory(receipts.map((receipt) => receipt?.payload?.acceptanceId), requiredIds, "PROVIDER_ACCEPTANCE_INVENTORY");
  const receiptIds = new Set();
  for (const receipt of receipts) {
    verifyExternalGateReceipt({
      expectedRecordType: providerAcceptanceRecordType,
      expectedRole: requiredProviderAcceptances[receipt?.payload?.acceptanceId]?.receiptRole,
      receipt,
      trustContext,
    });
    invariant(!receiptIds.has(receipt.receiptId), "PROVIDER_ACCEPTANCE_RECEIPT_REUSED");
    receiptIds.add(receipt.receiptId);
    const payload = receipt.payload;
    assertExactObjectKeys(payload, [
      "acceptanceId",
      "artifactSha256",
      "databasePostconditionSha256",
      "observationWindow",
      "observations",
      "providerIdentity",
      "postAcceptance",
      "qaTargetApproval",
      "qaTargetFingerprint",
      "runtime",
      "sourceArtifactSha256",
      "sourceCollectorSha256",
      "sourceCompletedAt",
    ], "PROVIDER_ACCEPTANCE_PAYLOAD");
    const contract = requiredProviderAcceptances[payload.acceptanceId];
    invariant(isPlainObject(contract), "PROVIDER_ACCEPTANCE_ID_INVALID");
    validateExternalGateRuntimeBinding(payload.runtime, runtime);
    validateProviderIdentity(payload.providerIdentity, contract.providers);
    validateObservationWindow(payload.observationWindow);
    invariant(
      payload.sourceCompletedAt === sourceCompletedAt
        && Date.parse(payload.observationWindow.startedAt) >= Date.parse(sourceCompletedAt),
      "PROVIDER_ACCEPTANCE_OBSERVATION_PRECEDES_SOURCE",
    );
    invariant(
      Date.parse(receipt.signedAt) >= Date.parse(payload.observationWindow.completedAt),
      "PROVIDER_ACCEPTANCE_SIGNED_BEFORE_OBSERVATION",
    );
    requireSha256(payload.artifactSha256, "PROVIDER_ACCEPTANCE_ARTIFACT_DIGEST_INVALID");
    requireSha256(payload.databasePostconditionSha256, "PROVIDER_ACCEPTANCE_DATABASE_DIGEST_INVALID");
    invariant(
      payload.databasePostconditionSha256 === databasePostconditionSha256,
      "PROVIDER_ACCEPTANCE_DATABASE_DIGEST_MISMATCH",
    );
    invariant(
      payload.sourceArtifactSha256 === sourceArtifactSha256,
      "PROVIDER_ACCEPTANCE_SOURCE_ARTIFACT_DIGEST_MISMATCH",
    );
    invariant(
      payload.sourceCollectorSha256 === sourceCollectorSha256,
      "PROVIDER_ACCEPTANCE_SOURCE_COLLECTOR_DIGEST_MISMATCH",
    );
    invariant(
      /^sha256:[a-f0-9]{64}$/u.test(payload.qaTargetFingerprint ?? ""),
      "PROVIDER_ACCEPTANCE_QA_TARGET_INVALID",
    );
    assertExactObjectKeys(payload.qaTargetApproval, [
      "approvedAt",
      "purpose",
      "status",
      "targetFingerprint",
    ], "PROVIDER_ACCEPTANCE_QA_TARGET_APPROVAL");
    requireIsoTimestamp(payload.qaTargetApproval.approvedAt, "PROVIDER_ACCEPTANCE_QA_TARGET_APPROVED_AT_INVALID");
    invariant(
      payload.qaTargetApproval.status === "APPROVED"
        && payload.qaTargetApproval.purpose === contract.targetPurpose
        && payload.qaTargetApproval.targetFingerprint === payload.qaTargetFingerprint
        && Date.parse(payload.qaTargetApproval.approvedAt) <= Date.parse(payload.observationWindow.startedAt),
      "PROVIDER_ACCEPTANCE_QA_TARGET_NOT_APPROVED",
    );
    assertExactObjectKeys(payload.postAcceptance, [
      "cleanupEvidenceSha256",
      "completedAt",
      "databaseEvidenceSha256",
      "residualLiveObjectCount",
      "status",
    ], "PROVIDER_ACCEPTANCE_POSTCONDITION");
    requireSha256(payload.postAcceptance.cleanupEvidenceSha256, "PROVIDER_ACCEPTANCE_CLEANUP_EVIDENCE_DIGEST_INVALID");
    requireSha256(payload.postAcceptance.databaseEvidenceSha256, "PROVIDER_ACCEPTANCE_DATABASE_EVIDENCE_DIGEST_INVALID");
    requireIsoTimestamp(payload.postAcceptance.completedAt, "PROVIDER_ACCEPTANCE_POSTCONDITION_TIME_INVALID");
    invariant(
      payload.postAcceptance.status === "PASS"
        && payload.postAcceptance.residualLiveObjectCount === 0
        && Date.parse(payload.postAcceptance.completedAt) >= Date.parse(payload.observationWindow.completedAt)
        && Date.parse(receipt.signedAt) >= Date.parse(payload.postAcceptance.completedAt),
      "PROVIDER_ACCEPTANCE_POSTCONDITION_NOT_PASS",
    );
    invariant(Array.isArray(payload.observations), "PROVIDER_ACCEPTANCE_OBSERVATIONS_REQUIRED");
    assertExactInventory(
      payload.observations.map((observation) => observation?.id),
      contract.outcomes,
      "PROVIDER_ACCEPTANCE_OBSERVATION_INVENTORY",
    );
    for (const observation of payload.observations) {
      assertExactObjectKeys(observation, ["evidenceSha256", "id", "status"], "PROVIDER_ACCEPTANCE_OBSERVATION");
      requireSafeText(observation.id, "PROVIDER_ACCEPTANCE_OBSERVATION_ID_INVALID", {
        maximumLength: 100,
        pattern: /^[a-z][a-z0-9-]{2,99}$/u,
      });
      invariant(observation.status === "PASS", "PROVIDER_ACCEPTANCE_OBSERVATION_NOT_PASS");
      requireSha256(observation.evidenceSha256, "PROVIDER_ACCEPTANCE_OBSERVATION_DIGEST_INVALID");
    }
  }
  return Object.freeze({
    acceptanceCount: receipts.length,
    receiptIds: Object.freeze([...receiptIds]),
    status: "VERIFIED",
  });
}

export function buildProviderAcceptanceReceiptBundleSha256(receipts) {
  invariant(Array.isArray(receipts), "PROVIDER_ACCEPTANCE_RECEIPTS_REQUIRED");
  return sha256(canonicalJson(receipts.map((receipt) => ({
    acceptanceId: receipt?.payload?.acceptanceId,
    payloadSha256: receipt?.payloadSha256,
    receiptId: receipt?.receiptId,
    role: receipt?.role,
    signatureReference: receipt?.signatureReference,
  }))));
}

export function validateProviderFinalCleanupReceipt({
  receipt,
  receipts,
  runtime,
  sourceArtifactSha256,
  sourceCollectorSha256,
  trustContext,
}) {
  verifyExternalGateReceipt({
    expectedRecordType: providerFinalCleanupRecordType,
    expectedRole: providerFinalCleanupRole,
    receipt,
    trustContext,
  });
  assertExactObjectKeys(receipt.payload, [
    "acceptanceReceiptBundleSha256",
    "cleanupWindow",
    "databaseResidualEvidenceSha256",
    "externalProviderSessionCount",
    "providerResidualEvidenceSha256",
    "qaBatchInventorySha256",
    "residualLiveObjectCount",
    "runtime",
    "sourceArtifactSha256",
    "sourceCollectorSha256",
    "status",
  ], "PROVIDER_FINAL_CLEANUP_PAYLOAD");
  validateExternalGateRuntimeBinding(receipt.payload.runtime, runtime);
  requireSha256(sourceArtifactSha256, "PROVIDER_ACCEPTANCE_SOURCE_ARTIFACT_DIGEST_INVALID");
  requireSha256(sourceCollectorSha256, "PROVIDER_ACCEPTANCE_SOURCE_COLLECTOR_DIGEST_INVALID");
  invariant(
    receipt.payload.sourceArtifactSha256 === sourceArtifactSha256
      && receipt.payload.sourceCollectorSha256 === sourceCollectorSha256,
    "PROVIDER_FINAL_CLEANUP_SOURCE_DIGEST_MISMATCH",
  );
  invariant(
    receipt.payload.acceptanceReceiptBundleSha256 === buildProviderAcceptanceReceiptBundleSha256(receipts),
    "PROVIDER_FINAL_CLEANUP_RECEIPT_BUNDLE_MISMATCH",
  );
  validateObservationWindow(receipt.payload.cleanupWindow);
  const latestAcceptanceSignature = receipts.map((entry) => entry.signedAt).sort().at(-1);
  invariant(
    isPlainObject(receipt.payload.cleanupWindow)
      && Date.parse(receipt.payload.cleanupWindow.startedAt) >= Date.parse(latestAcceptanceSignature)
      && Date.parse(receipt.signedAt) >= Date.parse(receipt.payload.cleanupWindow.completedAt),
    "PROVIDER_FINAL_CLEANUP_TIME_ORDER_INVALID",
  );
  requireSha256(receipt.payload.databaseResidualEvidenceSha256, "PROVIDER_FINAL_CLEANUP_DATABASE_DIGEST_INVALID");
  requireSha256(receipt.payload.providerResidualEvidenceSha256, "PROVIDER_FINAL_CLEANUP_PROVIDER_DIGEST_INVALID");
  requireSha256(receipt.payload.qaBatchInventorySha256, "PROVIDER_FINAL_CLEANUP_BATCH_DIGEST_INVALID");
  invariant(
    receipt.payload.status === "PASS"
      && receipt.payload.externalProviderSessionCount === 0
      && receipt.payload.residualLiveObjectCount === 0,
    "PROVIDER_FINAL_CLEANUP_NOT_PASS",
  );
  return Object.freeze({ receiptId: receipt.receiptId, status: "VERIFIED" });
}
