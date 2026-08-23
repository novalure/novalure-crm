import {
  assertExactObjectKeys,
  canonicalJson,
  requireIsoTimestamp,
  requireSafeText,
  requireSha256,
  sha256,
  validateExternalGateRuntimeBinding,
  verifyExternalGateReceipt,
} from "./external-gate-receipts.mjs";

export const performanceManualAcceptanceRole = "performance-manual-owner";
export const performanceManualAcceptanceRecordType = "NOVALURE_PERFORMANCE_MANUAL_ACCEPTANCE_RECEIPT";
export const performanceRumAcceptanceRole = "performance-rum-attestor";
export const performanceRumAcceptanceRecordType = "NOVALURE_PERFORMANCE_RUM_ACCEPTANCE_RECEIPT";
export const performanceManualGateIds = Object.freeze([
  "mobileAssistiveTechnology",
  "screenReader",
  "zoomAndReflow",
]);

function invariant(condition, code) {
  if (!condition) throw new Error(code);
}

function validateWindow(window, code, { minimumDurationMs = 0 } = {}) {
  assertExactObjectKeys(window, ["completedAt", "startedAt"], `${code}_WINDOW`);
  requireIsoTimestamp(window.startedAt, `${code}_WINDOW_START_INVALID`);
  requireIsoTimestamp(window.completedAt, `${code}_WINDOW_END_INVALID`);
  invariant(
    Date.parse(window.completedAt) - Date.parse(window.startedAt) >= minimumDurationMs,
    `${code}_WINDOW_TOO_SHORT`,
  );
}

function validateSignedAfterWindow(receipt, window, code) {
  invariant(
    Date.parse(receipt.signedAt) >= Date.parse(window.completedAt),
    `${code}_SIGNED_BEFORE_OBSERVATION`,
  );
}

export function validatePerformanceManualAcceptanceReceipt({
  budgetPolicy,
  receipt,
  runtime,
  trustContext,
}) {
  verifyExternalGateReceipt({
    expectedRecordType: performanceManualAcceptanceRecordType,
    expectedRole: performanceManualAcceptanceRole,
    receipt,
    trustContext,
  });
  assertExactObjectKeys(receipt.payload, [
    "artifactSha256",
    "budgetPolicySha256",
    "manualGates",
    "observationWindow",
    "runtime",
  ], "PERFORMANCE_MANUAL_PAYLOAD");
  validateExternalGateRuntimeBinding(receipt.payload.runtime, runtime);
  requireSha256(receipt.payload.artifactSha256, "PERFORMANCE_MANUAL_ARTIFACT_DIGEST_INVALID");
  invariant(
    receipt.payload.budgetPolicySha256 === sha256(canonicalJson(budgetPolicy)),
    "PERFORMANCE_MANUAL_BUDGET_POLICY_MISMATCH",
  );
  validateWindow(receipt.payload.observationWindow, "PERFORMANCE_MANUAL");
  validateSignedAfterWindow(receipt, receipt.payload.observationWindow, "PERFORMANCE_MANUAL");
  invariant(
    Array.isArray(receipt.payload.manualGates)
      && receipt.payload.manualGates.length === performanceManualGateIds.length,
    "PERFORMANCE_MANUAL_GATE_COUNT_INVALID",
  );
  const ids = receipt.payload.manualGates.map((gate) => gate?.id);
  invariant(
    ids.every((id, index) => id === performanceManualGateIds[index]),
    "PERFORMANCE_MANUAL_GATE_INVENTORY_INVALID",
  );
  for (const gate of receipt.payload.manualGates) {
    assertExactObjectKeys(gate, ["evidenceSha256", "id", "status"], "PERFORMANCE_MANUAL_GATE");
    invariant(gate.status === "PASS", "PERFORMANCE_MANUAL_GATE_NOT_PASS");
    requireSha256(gate.evidenceSha256, "PERFORMANCE_MANUAL_GATE_DIGEST_INVALID");
  }
  return Object.freeze({ receiptId: receipt.receiptId, status: "VERIFIED" });
}

export function validatePerformanceRumAcceptanceReceipt({
  budgetPolicy,
  receipt,
  runtime,
  trustContext,
}) {
  verifyExternalGateReceipt({
    expectedRecordType: performanceRumAcceptanceRecordType,
    expectedRole: performanceRumAcceptanceRole,
    receipt,
    trustContext,
  });
  assertExactObjectKeys(receipt.payload, [
    "artifactSha256",
    "budgetPolicySha256",
    "metrics",
    "observationWindow",
    "providerIdentity",
    "runtime",
    "sampleCount",
  ], "PERFORMANCE_RUM_PAYLOAD");
  validateExternalGateRuntimeBinding(receipt.payload.runtime, runtime);
  requireSha256(receipt.payload.artifactSha256, "PERFORMANCE_RUM_ARTIFACT_DIGEST_INVALID");
  invariant(
    receipt.payload.budgetPolicySha256 === sha256(canonicalJson(budgetPolicy)),
    "PERFORMANCE_RUM_BUDGET_POLICY_MISMATCH",
  );
  validateWindow(receipt.payload.observationWindow, "PERFORMANCE_RUM", {
    minimumDurationMs: 24 * 60 * 60 * 1_000,
  });
  validateSignedAfterWindow(receipt, receipt.payload.observationWindow, "PERFORMANCE_RUM");
  invariant(
    Number.isSafeInteger(receipt.payload.sampleCount) && receipt.payload.sampleCount >= 100,
    "PERFORMANCE_RUM_SAMPLE_COUNT_INVALID",
  );
  assertExactObjectKeys(receipt.payload.providerIdentity, [
    "datasetFingerprint",
    "projectFingerprint",
    "providerName",
  ], "PERFORMANCE_RUM_PROVIDER");
  requireSafeText(receipt.payload.providerIdentity.providerName, "PERFORMANCE_RUM_PROVIDER_NAME_INVALID", {
    maximumLength: 80,
    pattern: /^[A-Z][A-Z0-9_-]{2,79}$/u,
  });
  invariant(
    /^sha256:[a-f0-9]{64}$/u.test(receipt.payload.providerIdentity.projectFingerprint ?? "")
      && /^sha256:[a-f0-9]{64}$/u.test(receipt.payload.providerIdentity.datasetFingerprint ?? ""),
    "PERFORMANCE_RUM_PROVIDER_FINGERPRINT_INVALID",
  );
  assertExactObjectKeys(receipt.payload.metrics, [
    "cumulativeLayoutShiftP75",
    "interactionToNextPaintP75Ms",
    "largestContentfulPaintP75Ms",
  ], "PERFORMANCE_RUM_METRICS");
  const metrics = receipt.payload.metrics;
  invariant(
    typeof metrics.largestContentfulPaintP75Ms === "number"
      && Number.isFinite(metrics.largestContentfulPaintP75Ms)
      && metrics.largestContentfulPaintP75Ms > 0
      && metrics.largestContentfulPaintP75Ms <= budgetPolicy.realUserP75.largestContentfulPaintMaxMs
      && typeof metrics.interactionToNextPaintP75Ms === "number"
      && Number.isFinite(metrics.interactionToNextPaintP75Ms)
      && metrics.interactionToNextPaintP75Ms > 0
      && metrics.interactionToNextPaintP75Ms <= budgetPolicy.realUserP75.interactionToNextPaintMaxMs
      && typeof metrics.cumulativeLayoutShiftP75 === "number"
      && Number.isFinite(metrics.cumulativeLayoutShiftP75)
      && metrics.cumulativeLayoutShiftP75 >= 0
      && metrics.cumulativeLayoutShiftP75 <= budgetPolicy.realUserP75.cumulativeLayoutShiftMax,
    "PERFORMANCE_RUM_BUDGET_FAILED",
  );
  return Object.freeze({ receiptId: receipt.receiptId, status: "VERIFIED" });
}
