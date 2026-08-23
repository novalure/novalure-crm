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

export const accessibilityManualAcceptanceRole = "accessibility-owner";
export const accessibilityManualAcceptanceRecordType =
  "NOVALURE_ACCESSIBILITY_MANUAL_ACCEPTANCE_RECEIPT";
export const accessibilityManualEvidenceRecordType =
  "NOVALURE_ACCESSIBILITY_MANUAL_CHECK_EVIDENCE";

export const accessibilityRequiredManualCheckIds = Object.freeze([
  "screenreader-navigation-and-announcements",
  "dialog-focus-trap-and-return",
  "form-errors-and-instructions",
  "complete-keyboard-operation",
  "zoom-reflow-and-text-spacing",
  "mobile-orientation-and-targets",
  "mfa-reset-and-invitation-flow",
  "public-form-and-funnel-submit-flow",
]);

function invariant(condition, code) {
  if (!condition) throw new Error(code);
}

function assertExactInventory(actual, expected, code) {
  invariant(Array.isArray(actual), `${code}_ARRAY_REQUIRED`);
  invariant(
    actual.length === expected.length
      && actual.every((value, index) => value === expected[index]),
    `${code}_INVALID`,
  );
}

function normalizeMatrix(matrix, individualEvidenceById) {
  invariant(isPlainObject(matrix), "ACCESSIBILITY_MATRIX_REQUIRED");
  invariant(matrix.schemaVersion === 2, "ACCESSIBILITY_MATRIX_SCHEMA_INVALID");
  invariant(matrix.standard === "WCAG 2.2 Level AA", "ACCESSIBILITY_MATRIX_STANDARD_INVALID");
  invariant(matrix.status === "SIGNED", "ACCESSIBILITY_MATRIX_NOT_SIGNED");
  invariant(Array.isArray(matrix.manualChecks), "ACCESSIBILITY_MATRIX_MANUAL_CHECKS_REQUIRED");
  assertExactInventory(
    matrix.manualChecks.map((check) => check?.id),
    accessibilityRequiredManualCheckIds,
    "ACCESSIBILITY_MATRIX_MANUAL_CHECK_INVENTORY",
  );
  for (const check of matrix.manualChecks) {
    invariant(check.required === true, "ACCESSIBILITY_MATRIX_MANUAL_CHECK_NOT_REQUIRED");
    invariant(check.status === "PASS", "ACCESSIBILITY_MATRIX_MANUAL_CHECK_NOT_PASS");
    assertExactObjectKeys(check.evidence, [
      "documentSha256",
      "recordType",
      "schemaVersion",
    ], "ACCESSIBILITY_MATRIX_MANUAL_EVIDENCE_BINDING");
    invariant(
      check.evidence.recordType === accessibilityManualEvidenceRecordType
        && check.evidence.schemaVersion === 1,
      "ACCESSIBILITY_MATRIX_MANUAL_EVIDENCE_TYPE_INVALID",
    );
    invariant(
      check.evidence.documentSha256 === individualEvidenceById.get(check.id)?.sha256,
      "ACCESSIBILITY_MATRIX_MANUAL_EVIDENCE_DIGEST_MISMATCH",
    );
  }
  return matrix;
}

function validateIndividualEvidence(document, expectedRuntime) {
  assertExactObjectKeys(document, [
    "checkId",
    "contexts",
    "languages",
    "observations",
    "recordType",
    "result",
    "runtime",
    "schemaVersion",
    "testedAt",
    "testerSubject",
  ], "ACCESSIBILITY_MANUAL_EVIDENCE");
  invariant(document.schemaVersion === 1, "ACCESSIBILITY_MANUAL_EVIDENCE_SCHEMA_INVALID");
  invariant(
    document.recordType === accessibilityManualEvidenceRecordType,
    "ACCESSIBILITY_MANUAL_EVIDENCE_TYPE_INVALID",
  );
  invariant(
    accessibilityRequiredManualCheckIds.includes(document.checkId),
    "ACCESSIBILITY_MANUAL_EVIDENCE_CHECK_INVALID",
  );
  invariant(document.result === "PASS", "ACCESSIBILITY_MANUAL_EVIDENCE_NOT_PASS");
  validateExternalGateRuntimeBinding(document.runtime, expectedRuntime);
  requireIsoTimestamp(document.testedAt, "ACCESSIBILITY_MANUAL_EVIDENCE_TIME_INVALID");
  requireSafeText(document.testerSubject, "ACCESSIBILITY_MANUAL_EVIDENCE_TESTER_INVALID", {
    maximumLength: 240,
    pattern: /^subject:[A-Za-z0-9][A-Za-z0-9._:@/-]{7,240}$/u,
  });
  invariant(
    Array.isArray(document.contexts)
      && document.contexts.length > 0
      && document.contexts.length <= 24
      && document.contexts.every((context) => {
        try {
          requireSafeText(context, "ACCESSIBILITY_MANUAL_EVIDENCE_CONTEXT_INVALID", { maximumLength: 160 });
          return true;
        } catch {
          return false;
        }
      }),
    "ACCESSIBILITY_MANUAL_EVIDENCE_CONTEXTS_INVALID",
  );
  assertExactInventory(document.languages, ["de", "en"], "ACCESSIBILITY_MANUAL_EVIDENCE_LANGUAGES");
  invariant(
    Array.isArray(document.observations)
      && document.observations.length > 0
      && document.observations.length <= 200,
    "ACCESSIBILITY_MANUAL_EVIDENCE_OBSERVATIONS_INVALID",
  );
  const observationIds = new Set();
  for (const observation of document.observations) {
    assertExactObjectKeys(observation, [
      "evidenceSha256",
      "id",
      "status",
    ], "ACCESSIBILITY_MANUAL_OBSERVATION");
    requireSafeText(observation.id, "ACCESSIBILITY_MANUAL_OBSERVATION_ID_INVALID", {
      maximumLength: 120,
      pattern: /^[a-z0-9][a-z0-9._-]{2,119}$/u,
    });
    invariant(!observationIds.has(observation.id), "ACCESSIBILITY_MANUAL_OBSERVATION_DUPLICATED");
    observationIds.add(observation.id);
    invariant(observation.status === "PASS", "ACCESSIBILITY_MANUAL_OBSERVATION_NOT_PASS");
    requireSha256(observation.evidenceSha256, "ACCESSIBILITY_MANUAL_OBSERVATION_DIGEST_INVALID");
  }
  return document;
}

function validateAutomatedEvidence(document, expectedRuntime) {
  assertExactObjectKeys(document, [
    "automatedSubsetPassed",
    "automatedTechnicalPassed",
    "coverage",
    "expectedSha",
    "matrix",
    "productionMutationPerformed",
    "releaseSurfaceManifestVerified",
    "results",
    "runtimeIdentity",
    "schemaVersion",
    "targetHost",
    "unsafeHttpWriteGuard",
  ], "ACCESSIBILITY_AUTOMATED_EVIDENCE");
  invariant(document.schemaVersion === 4, "ACCESSIBILITY_AUTOMATED_EVIDENCE_SCHEMA_INVALID");
  invariant(
    document.expectedSha === expectedRuntime.candidateCommit,
    "ACCESSIBILITY_AUTOMATED_EVIDENCE_CANDIDATE_MISMATCH",
  );
  invariant(
    document.targetHost === expectedRuntime.deploymentHost,
    "ACCESSIBILITY_AUTOMATED_EVIDENCE_HOST_MISMATCH",
  );
  invariant(
    document.productionMutationPerformed === false,
    "ACCESSIBILITY_AUTOMATED_EVIDENCE_PRODUCTION_MUTATION",
  );
  invariant(
    document.automatedTechnicalPassed === true,
    "ACCESSIBILITY_AUTOMATED_EVIDENCE_NOT_PASS",
  );
  return document;
}

export function validateAccessibilityManualAcceptanceReceipt({
  automatedEvidence,
  expectedAutomatedEvidence,
  individualEvidence,
  matrix,
  receipt,
  runtime,
  trustContext,
}) {
  validateExternalGateRuntimeBinding(runtime, runtime);
  validateAutomatedEvidence(automatedEvidence, runtime);
  validateAutomatedEvidence(expectedAutomatedEvidence, runtime);
  invariant(
    canonicalJson(automatedEvidence) === canonicalJson(expectedAutomatedEvidence),
    "ACCESSIBILITY_AUTOMATED_EVIDENCE_OUTER_MISMATCH",
  );
  invariant(
    Array.isArray(individualEvidence)
      && individualEvidence.length === accessibilityRequiredManualCheckIds.length,
    "ACCESSIBILITY_MANUAL_EVIDENCE_COUNT_INVALID",
  );
  const evidenceById = new Map();
  for (const document of individualEvidence) {
    validateIndividualEvidence(document, runtime);
    invariant(!evidenceById.has(document.checkId), "ACCESSIBILITY_MANUAL_EVIDENCE_DUPLICATED");
    evidenceById.set(document.checkId, {
      document,
      sha256: sha256(canonicalJson(document)),
    });
  }
  assertExactInventory(
    individualEvidence.map((document) => document.checkId),
    accessibilityRequiredManualCheckIds,
    "ACCESSIBILITY_MANUAL_EVIDENCE_INVENTORY",
  );
  normalizeMatrix(matrix, evidenceById);

  verifyExternalGateReceipt({
    expectedRecordType: accessibilityManualAcceptanceRecordType,
    expectedRole: accessibilityManualAcceptanceRole,
    receipt,
    trustContext,
  });
  assertExactObjectKeys(receipt.payload, [
    "automatedEvidenceSha256",
    "individualEvidenceBundleSha256",
    "manualCheckDigests",
    "matrixSha256",
    "runtime",
  ], "ACCESSIBILITY_MANUAL_ACCEPTANCE_PAYLOAD");
  validateExternalGateRuntimeBinding(receipt.payload.runtime, runtime);
  const manualCheckDigests = accessibilityRequiredManualCheckIds.map((id) => ({
    id,
    sha256: evidenceById.get(id).sha256,
  }));
  invariant(
    receipt.payload.matrixSha256 === sha256(canonicalJson(matrix)),
    "ACCESSIBILITY_MANUAL_ACCEPTANCE_MATRIX_DIGEST_MISMATCH",
  );
  invariant(
    receipt.payload.automatedEvidenceSha256 === sha256(canonicalJson(automatedEvidence)),
    "ACCESSIBILITY_MANUAL_ACCEPTANCE_AUTOMATED_DIGEST_MISMATCH",
  );
  invariant(
    receipt.payload.individualEvidenceBundleSha256 === sha256(canonicalJson(manualCheckDigests)),
    "ACCESSIBILITY_MANUAL_ACCEPTANCE_BUNDLE_DIGEST_MISMATCH",
  );
  invariant(
    canonicalJson(receipt.payload.manualCheckDigests) === canonicalJson(manualCheckDigests),
    "ACCESSIBILITY_MANUAL_ACCEPTANCE_CHECK_DIGESTS_MISMATCH",
  );
  const latestTestAt = Math.max(...individualEvidence.map((entry) => Date.parse(entry.testedAt)));
  invariant(
    Date.parse(receipt.signedAt) >= latestTestAt,
    "ACCESSIBILITY_MANUAL_ACCEPTANCE_SIGNED_BEFORE_TESTS",
  );
  return Object.freeze({
    automatedEvidenceSha256: receipt.payload.automatedEvidenceSha256,
    individualEvidenceBundleSha256: receipt.payload.individualEvidenceBundleSha256,
    manualCheckCount: accessibilityRequiredManualCheckIds.length,
    matrixSha256: receipt.payload.matrixSha256,
    receiptId: receipt.receiptId,
    signerSubject: receipt.signerSubject,
    status: "VERIFIED",
  });
}
