import {
  assertExactObjectKeys,
  requireIsoTimestamp,
  requireSafeText,
  requireSha256,
  validateExternalGateRuntimeBinding,
  verifyExternalGateReceipt,
} from "./external-gate-receipts.mjs";

export const operationalGateSpecifications = Object.freeze({
  observability: Object.freeze({
    observationIds: Object.freeze([
      "alert-delivery",
      "error-ingestion",
      "runtime-alerting",
      "synthetic-alarm",
      "log-drain-delivery",
      "trace-ingestion",
    ]),
    provider: "vercel",
    recordType: "NOVALURE_OBSERVABILITY_OPERATIONAL_RECEIPT",
    role: "observability-owner",
    sourceType: "VERCEL_OBSERVABILITY",
  }),
  "runtime-logs": Object.freeze({
    observationIds: Object.freeze([
      "bounded-window",
      "no-unhandled-errors",
      "request-correlation",
      "target-deployment-only",
      "log-drain-delivery",
      "trace-correlation",
    ]),
    provider: "vercel",
    recordType: "NOVALURE_RUNTIME_LOGS_OPERATIONAL_RECEIPT",
    role: "runtime-logs-owner",
    sourceType: "VERCEL_RUNTIME_LOGS",
  }),
  cleanup: Object.freeze({
    observationIds: Object.freeze([
      "qa-batch-reset",
      "database-postcount-zero",
      "blob-postcount-zero",
      "provider-session-postcount-zero",
      "auth-session-postcount-zero",
      "artifact-disposition",
    ]),
    provider: "novalure",
    recordType: "NOVALURE_CLEANUP_OPERATIONAL_RECEIPT",
    role: "cleanup-owner",
    sourceType: "NOVALURE_QA_CLEANUP",
  }),
  "supply-chain": Object.freeze({
    observationIds: Object.freeze([
      "codeql",
      "dependency-review",
      "npm-audit-production",
      "license-policy",
      "sbom",
      "secret-scan",
      "pinned-actions",
    ]),
    provider: "github",
    recordType: "NOVALURE_SUPPLY_CHAIN_OPERATIONAL_RECEIPT",
    role: "supply-chain-owner",
    sourceType: "GITHUB_ACTIONS",
  }),
});

function invariant(condition, code) {
  if (!condition) throw new Error(code);
}

function validateSource(source, specification, expectedSource) {
  assertExactObjectKeys(source, [
    "artifactSha256",
    "provider",
    "runAttempt",
    "runId",
    "runUrlSha256",
    "sourceType",
  ], "OPERATIONAL_GATE_SOURCE");
  invariant(source.provider === specification.provider, "OPERATIONAL_GATE_SOURCE_PROVIDER_INVALID");
  invariant(source.sourceType === specification.sourceType, "OPERATIONAL_GATE_SOURCE_TYPE_INVALID");
  requireSafeText(source.runId, "OPERATIONAL_GATE_SOURCE_RUN_ID_INVALID", {
    maximumLength: 160,
    pattern: /^[A-Za-z0-9][A-Za-z0-9._:-]{5,159}$/u,
  });
  invariant(
    Number.isSafeInteger(source.runAttempt) && source.runAttempt >= 1 && source.runAttempt <= 1_000,
    "OPERATIONAL_GATE_SOURCE_RUN_ATTEMPT_INVALID",
  );
  requireSha256(source.artifactSha256, "OPERATIONAL_GATE_SOURCE_ARTIFACT_DIGEST_INVALID");
  requireSha256(source.runUrlSha256, "OPERATIONAL_GATE_SOURCE_URL_DIGEST_INVALID");
  if (expectedSource !== null) {
    assertExactObjectKeys(expectedSource, Object.keys(source), "OPERATIONAL_GATE_EXPECTED_SOURCE");
    for (const key of Object.keys(source)) {
      invariant(source[key] === expectedSource[key], `OPERATIONAL_GATE_SOURCE_${key.toUpperCase()}_MISMATCH`);
    }
  }
  return source;
}

function validateWindow(window) {
  assertExactObjectKeys(window, ["endedAt", "startedAt"], "OPERATIONAL_GATE_WINDOW");
  requireIsoTimestamp(window.startedAt, "OPERATIONAL_GATE_WINDOW_START_INVALID");
  requireIsoTimestamp(window.endedAt, "OPERATIONAL_GATE_WINDOW_END_INVALID");
  invariant(Date.parse(window.endedAt) > Date.parse(window.startedAt), "OPERATIONAL_GATE_WINDOW_ORDER_INVALID");
  invariant(
    Date.parse(window.endedAt) - Date.parse(window.startedAt) <= 7 * 24 * 60 * 60 * 1_000,
    "OPERATIONAL_GATE_WINDOW_TOO_LARGE",
  );
  return window;
}

function validateObservations(observations, specification, window) {
  invariant(
    Array.isArray(observations)
      && observations.length === specification.observationIds.length,
    "OPERATIONAL_GATE_OBSERVATION_COUNT_INVALID",
  );
  invariant(
    observations.every((observation, index) => observation?.id === specification.observationIds[index]),
    "OPERATIONAL_GATE_OBSERVATION_INVENTORY_INVALID",
  );
  for (const observation of observations) {
    assertExactObjectKeys(observation, [
      "evidenceSha256",
      "id",
      "observedAt",
      "sourceRecordIdSha256",
      "status",
    ], "OPERATIONAL_GATE_OBSERVATION");
    invariant(observation.status === "PASS", "OPERATIONAL_GATE_OBSERVATION_NOT_PASS");
    requireIsoTimestamp(observation.observedAt, "OPERATIONAL_GATE_OBSERVATION_TIME_INVALID");
    invariant(
      Date.parse(observation.observedAt) >= Date.parse(window.startedAt)
        && Date.parse(observation.observedAt) <= Date.parse(window.endedAt),
      "OPERATIONAL_GATE_OBSERVATION_OUTSIDE_WINDOW",
    );
    requireSha256(observation.evidenceSha256, "OPERATIONAL_GATE_OBSERVATION_DIGEST_INVALID");
    requireSha256(
      observation.sourceRecordIdSha256,
      "OPERATIONAL_GATE_OBSERVATION_SOURCE_ID_DIGEST_INVALID",
    );
  }
  return observations;
}

export function validateOperationalGateReceipt({
  expectedRuntime,
  expectedSource = null,
  gateId,
  receipt,
  trustContext,
}) {
  const specification = operationalGateSpecifications[gateId];
  invariant(specification, "OPERATIONAL_GATE_ID_INVALID");
  validateExternalGateRuntimeBinding(expectedRuntime, expectedRuntime);
  verifyExternalGateReceipt({
    expectedRecordType: specification.recordType,
    expectedRole: specification.role,
    receipt,
    trustContext,
  });
  assertExactObjectKeys(receipt.payload, [
    "gateId",
    "observations",
    "runtime",
    "source",
    "window",
  ], "OPERATIONAL_GATE_PAYLOAD");
  invariant(receipt.payload.gateId === gateId, "OPERATIONAL_GATE_ID_MISMATCH");
  validateExternalGateRuntimeBinding(receipt.payload.runtime, expectedRuntime);
  const window = validateWindow(receipt.payload.window);
  const source = validateSource(receipt.payload.source, specification, expectedSource);
  validateObservations(receipt.payload.observations, specification, window);
  invariant(
    Date.parse(receipt.signedAt) >= Date.parse(window.endedAt),
    "OPERATIONAL_GATE_RECEIPT_SIGNED_BEFORE_WINDOW_END",
  );
  return Object.freeze({
    artifactSha256: source.artifactSha256,
    gateId,
    observationCount: specification.observationIds.length,
    receiptId: receipt.receiptId,
    runAttempt: source.runAttempt,
    runId: source.runId,
    signerSubject: receipt.signerSubject,
    status: "VERIFIED",
    window: Object.freeze({ ...window }),
  });
}

export function validateOperationalGateReceipts({
  expectedRuntime,
  expectedSources = {},
  receipts,
  trustContext,
}) {
  assertExactObjectKeys(
    receipts,
    Object.keys(operationalGateSpecifications),
    "OPERATIONAL_GATE_RECEIPTS",
  );
  const validated = {};
  for (const gateId of Object.keys(operationalGateSpecifications)) {
    validated[gateId] = validateOperationalGateReceipt({
      expectedRuntime,
      expectedSource: expectedSources[gateId] ?? null,
      gateId,
      receipt: receipts[gateId],
      trustContext,
    });
  }
  return Object.freeze(validated);
}
