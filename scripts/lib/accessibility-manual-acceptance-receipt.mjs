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
import { validateA11yFixtureLifecycleEvidence } from "./a11y-fixture-lifecycle-evidence.mjs";

export const accessibilityApprovalRoles = Object.freeze([
  Object.freeze({
    approvalRole: "Accessibility owner",
    receiptRole: "accessibility-owner",
    recordType: "NOVALURE_ACCESSIBILITY_OWNER_APPROVAL_RECEIPT",
  }),
  Object.freeze({
    approvalRole: "Product owner",
    receiptRole: "accessibility-product-owner",
    recordType: "NOVALURE_ACCESSIBILITY_PRODUCT_APPROVAL_RECEIPT",
  }),
  Object.freeze({
    approvalRole: "Release owner",
    receiptRole: "accessibility-release-owner",
    recordType: "NOVALURE_ACCESSIBILITY_RELEASE_APPROVAL_RECEIPT",
  }),
]);

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

function frozenInventory(values) {
  return Object.freeze(values);
}

export const accessibilityManualObservationIdsByCheck = Object.freeze({
  "screenreader-navigation-and-announcements": frozenInventory([
    "screenreader.nvda-firefox.de.public",
    "screenreader.nvda-firefox.de.authenticated",
    "screenreader.nvda-firefox.en.public",
    "screenreader.nvda-firefox.en.authenticated",
    "screenreader.voiceover-safari.de.public",
    "screenreader.voiceover-safari.de.authenticated",
    "screenreader.voiceover-safari.en.public",
    "screenreader.voiceover-safari.en.authenticated",
  ]),
  "dialog-focus-trap-and-return": frozenInventory([
    "dialog.authentication.focus-cycle",
    "dialog.contacts.focus-cycle",
    "dialog.pipelines.focus-cycle",
    "dialog.tasks.focus-cycle",
    "dialog.meetings.focus-cycle",
    "dialog.forms.focus-cycle",
    "dialog.funnels.focus-cycle",
    "dialog.settings.focus-cycle",
    "dialog.invitation.focus-cycle",
  ]),
  "form-errors-and-instructions": frozenInventory([
    "form-errors.de.login",
    "form-errors.de.mfa",
    "form-errors.de.password-reset-result",
    "form-errors.de.invitation",
    "form-errors.de.authenticated-form",
    "form-errors.de.authenticated-funnel",
    "form-errors.de.settings",
    "form-errors.de.public-form",
    "form-errors.de.public-funnel",
    "form-errors.en.login",
    "form-errors.en.mfa",
    "form-errors.en.password-reset-result",
    "form-errors.en.invitation",
    "form-errors.en.authenticated-form",
    "form-errors.en.authenticated-funnel",
    "form-errors.en.settings",
    "form-errors.en.public-form",
    "form-errors.en.public-funnel",
  ]),
  "complete-keyboard-operation": frozenInventory([
    "keyboard.dashboard",
    "keyboard.contacts",
    "keyboard.pipelines",
    "keyboard.tasks",
    "keyboard.meetings",
    "keyboard.forms",
    "keyboard.funnels",
    "keyboard.settings",
    "keyboard.invitation-management",
  ]),
  "zoom-reflow-and-text-spacing": frozenInventory([
    "zoom.public.zoom-200",
    "zoom.public.reflow-400",
    "zoom.public.text-spacing",
    "zoom.authenticated.zoom-200",
    "zoom.authenticated.reflow-400",
    "zoom.authenticated.text-spacing",
  ]),
  "mobile-orientation-and-targets": frozenInventory([
    "mobile.public.portrait",
    "mobile.public.landscape",
    "mobile.public.target-size",
    "mobile.authenticated.portrait",
    "mobile.authenticated.landscape",
    "mobile.authenticated.target-size",
  ]),
  "mfa-reset-and-invitation-flow": frozenInventory([
    "auth-flow.de.mfa-completion",
    "auth-flow.de.password-reset-success",
    "auth-flow.de.password-reset-failure",
    "auth-flow.de.invitation-launch-state",
    "auth-flow.de.invitation-validation",
    "auth-flow.de.invitation-result",
    "auth-flow.en.mfa-completion",
    "auth-flow.en.password-reset-success",
    "auth-flow.en.password-reset-failure",
    "auth-flow.en.invitation-launch-state",
    "auth-flow.en.invitation-validation",
    "auth-flow.en.invitation-result",
  ]),
  "public-form-and-funnel-submit-flow": frozenInventory([
    "public-submit.form.de.desktop.validation",
    "public-submit.form.de.desktop.success",
    "public-submit.form.de.mobile.validation",
    "public-submit.form.de.mobile.success",
    "public-submit.form.de.reflow-400.validation",
    "public-submit.form.de.reflow-400.success",
    "public-submit.form.en.desktop.validation",
    "public-submit.form.en.desktop.success",
    "public-submit.form.en.mobile.validation",
    "public-submit.form.en.mobile.success",
    "public-submit.form.en.reflow-400.validation",
    "public-submit.form.en.reflow-400.success",
    "public-submit.funnel.de.desktop.validation",
    "public-submit.funnel.de.desktop.success",
    "public-submit.funnel.de.mobile.validation",
    "public-submit.funnel.de.mobile.success",
    "public-submit.funnel.de.reflow-400.validation",
    "public-submit.funnel.de.reflow-400.success",
    "public-submit.funnel.en.desktop.validation",
    "public-submit.funnel.en.desktop.success",
    "public-submit.funnel.en.mobile.validation",
    "public-submit.funnel.en.mobile.success",
    "public-submit.funnel.en.reflow-400.validation",
    "public-submit.funnel.en.reflow-400.success",
  ]),
});

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
  assertExactObjectKeys(matrix, [
    "approvals",
    "manualChecks",
    "schemaVersion",
    "standard",
    "status",
  ], "ACCESSIBILITY_MATRIX");
  invariant(matrix.schemaVersion === 2, "ACCESSIBILITY_MATRIX_SCHEMA_INVALID");
  invariant(matrix.standard === "WCAG 2.2 Level AA", "ACCESSIBILITY_MATRIX_STANDARD_INVALID");
  invariant(
    matrix.status === "READY_FOR_EXTERNAL_SIGNATURE",
    "ACCESSIBILITY_MATRIX_NOT_READY_FOR_EXTERNAL_SIGNATURE",
  );
  assertExactInventory(
    matrix.approvals?.map((approval) => approval?.role),
    accessibilityApprovalRoles.map((entry) => entry.approvalRole),
    "ACCESSIBILITY_MATRIX_APPROVAL_INVENTORY",
  );
  for (const [index, approval] of matrix.approvals.entries()) {
    assertExactObjectKeys(approval, [
      "owner",
      "role",
      "signature",
      "signedAt",
      "status",
    ], "ACCESSIBILITY_MATRIX_APPROVAL");
    invariant(
      approval.role === accessibilityApprovalRoles[index].approvalRole,
      "ACCESSIBILITY_MATRIX_APPROVAL_ROLE_MISMATCH",
    );
    invariant(
      approval.status === "READY_FOR_EXTERNAL_SIGNATURE"
        && approval.owner === null
        && approval.signature === null
        && approval.signedAt === null,
      "ACCESSIBILITY_MATRIX_APPROVAL_NOT_REFERENCELESS",
    );
  }
  assertExactInventory(
    matrix.manualChecks?.map((check) => check?.id),
    accessibilityRequiredManualCheckIds,
    "ACCESSIBILITY_MATRIX_MANUAL_CHECK_INVENTORY",
  );
  for (const check of matrix.manualChecks) {
    assertExactObjectKeys(check, [
      "evidence",
      "id",
      "required",
      "status",
    ], "ACCESSIBILITY_MATRIX_MANUAL_CHECK");
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
          requireSafeText(context, "ACCESSIBILITY_MANUAL_EVIDENCE_CONTEXT_INVALID", {
            maximumLength: 160,
          });
          return true;
        } catch {
          return false;
        }
      }),
    "ACCESSIBILITY_MANUAL_EVIDENCE_CONTEXTS_INVALID",
  );
  if (document.checkId === "public-form-and-funnel-submit-flow") {
    assertExactInventory(
      document.contexts,
      ["public-form", "public-funnel"],
      "ACCESSIBILITY_PUBLIC_SUBMIT_CONTEXT_INVENTORY",
    );
  }
  assertExactInventory(document.languages, ["de", "en"], "ACCESSIBILITY_MANUAL_EVIDENCE_LANGUAGES");
  const expectedObservationIds = accessibilityManualObservationIdsByCheck[document.checkId];
  assertExactInventory(
    document.observations?.map((observation) => observation?.id),
    expectedObservationIds,
    "ACCESSIBILITY_MANUAL_OBSERVATION_INVENTORY",
  );
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
    invariant(observation.status === "PASS", "ACCESSIBILITY_MANUAL_OBSERVATION_NOT_PASS");
    requireSha256(observation.evidenceSha256, "ACCESSIBILITY_MANUAL_OBSERVATION_DIGEST_INVALID");
  }
  return document;
}

function validateAutomatedEvidence(document, expectedRuntime) {
  assertExactObjectKeys(document, [
    "automatedSourceSha256",
    "automatedSubsetPassed",
    "automatedTechnicalPassed",
    "browser",
    "cleanup",
    "coverage",
    "endedAt",
    "evidenceDigest",
    "executionBlocker",
    "executionScope",
    "expectedSha",
    "generatedAt",
    "matrix",
    "mode",
    "productionMutationPerformed",
    "releaseSurfaceManifestVerified",
    "results",
    "runtimeIdentity",
    "schemaVersion",
    "startedAt",
    "targetHost",
    "unsafeHttpWriteGuard",
    "wcagStandard",
  ], "ACCESSIBILITY_AUTOMATED_EVIDENCE");
  invariant(document.schemaVersion === 4, "ACCESSIBILITY_AUTOMATED_EVIDENCE_SCHEMA_INVALID");
  requireSha256(
    document.automatedSourceSha256,
    "ACCESSIBILITY_AUTOMATED_SOURCE_DIGEST_INVALID",
  );
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
    document.automatedTechnicalPassed === true
      && document.automatedSubsetPassed === true
      && document.mode === "RELEASE_GATE"
      && document.executionBlocker === null
      && document.cleanup?.complete === true,
    "ACCESSIBILITY_AUTOMATED_EVIDENCE_NOT_PASS",
  );
  return document;
}

export function validateAccessibilityApprovalReceipts({
  approvalReceipts,
  automatedEvidence,
  databaseProjectId,
  expectedAutomatedEvidence,
  fixtureLifecycle,
  fixtureLifecycleSha256,
  individualEvidence,
  matrix,
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
  validateA11yFixtureLifecycleEvidence({
    browserEvidenceSha256: automatedEvidence.automatedSourceSha256,
    document: fixtureLifecycle,
    expectedRuntime: { ...runtime, databaseProjectId },
    lifecycleSha256: fixtureLifecycleSha256,
  });
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

  assertExactObjectKeys(
    approvalReceipts,
    accessibilityApprovalRoles.map((entry) => entry.receiptRole),
    "ACCESSIBILITY_APPROVAL_RECEIPTS",
  );
  const manualCheckDigests = accessibilityRequiredManualCheckIds.map((id) => ({
    id,
    sha256: evidenceById.get(id).sha256,
  }));
  const expectedDigests = Object.freeze({
    automatedEvidenceSha256: sha256(canonicalJson(automatedEvidence)),
    individualEvidenceBundleSha256: sha256(canonicalJson(manualCheckDigests)),
    matrixSha256: sha256(canonicalJson(matrix)),
  });
  const latestTestAt = Math.max(...individualEvidence.map((entry) => Date.parse(entry.testedAt)));
  const verifiedApprovals = [];
  for (const expected of accessibilityApprovalRoles) {
    const receipt = approvalReceipts[expected.receiptRole];
    verifyExternalGateReceipt({
      expectedRecordType: expected.recordType,
      expectedRole: expected.receiptRole,
      receipt,
      trustContext,
    });
    assertExactObjectKeys(receipt.payload, [
      "approval",
      "approvalRole",
      "automatedEvidenceSha256",
      "databaseProjectId",
      "fixtureLifecycleSha256",
      "individualEvidenceBundleSha256",
      "manualCheckDigests",
      "matrixSha256",
      "runtime",
    ], "ACCESSIBILITY_APPROVAL_PAYLOAD");
    invariant(receipt.payload.approval === "APPROVED", "ACCESSIBILITY_APPROVAL_NOT_APPROVED");
    invariant(
      receipt.payload.approvalRole === expected.approvalRole,
      "ACCESSIBILITY_APPROVAL_SCOPE_MISMATCH",
    );
    validateExternalGateRuntimeBinding(receipt.payload.runtime, runtime);
    invariant(
      receipt.payload.databaseProjectId === databaseProjectId,
      "ACCESSIBILITY_APPROVAL_DATABASE_PROJECT_MISMATCH",
    );
    invariant(
      receipt.payload.matrixSha256 === expectedDigests.matrixSha256,
      "ACCESSIBILITY_APPROVAL_MATRIX_DIGEST_MISMATCH",
    );
    invariant(
      receipt.payload.automatedEvidenceSha256 === expectedDigests.automatedEvidenceSha256,
      "ACCESSIBILITY_APPROVAL_AUTOMATED_DIGEST_MISMATCH",
    );
    invariant(
      receipt.payload.fixtureLifecycleSha256 === fixtureLifecycleSha256,
      "ACCESSIBILITY_APPROVAL_FIXTURE_LIFECYCLE_DIGEST_MISMATCH",
    );
    invariant(
      receipt.payload.individualEvidenceBundleSha256
        === expectedDigests.individualEvidenceBundleSha256,
      "ACCESSIBILITY_APPROVAL_BUNDLE_DIGEST_MISMATCH",
    );
    invariant(
      canonicalJson(receipt.payload.manualCheckDigests) === canonicalJson(manualCheckDigests),
      "ACCESSIBILITY_APPROVAL_CHECK_DIGESTS_MISMATCH",
    );
    invariant(
      Date.parse(receipt.signedAt) >= latestTestAt,
      "ACCESSIBILITY_APPROVAL_SIGNED_BEFORE_TESTS",
    );
    verifiedApprovals.push(Object.freeze({
      approvalRole: expected.approvalRole,
      receiptId: receipt.receiptId,
      receiptRole: expected.receiptRole,
      signerSubject: receipt.signerSubject,
      status: "VERIFIED",
    }));
  }
  for (const field of ["receiptId", "receiptRole", "signerSubject"]) {
    invariant(
      new Set(verifiedApprovals.map((entry) => entry[field])).size
        === accessibilityApprovalRoles.length,
      "ACCESSIBILITY_APPROVAL_SIGNERS_NOT_DISTINCT",
    );
  }
  return Object.freeze({
    approvals: Object.freeze(verifiedApprovals),
    automatedEvidenceSha256: expectedDigests.automatedEvidenceSha256,
    databaseProjectId,
    individualEvidenceBundleSha256: expectedDigests.individualEvidenceBundleSha256,
    manualCheckCount: accessibilityRequiredManualCheckIds.length,
    matrixSha256: expectedDigests.matrixSha256,
    signatureCount: accessibilityApprovalRoles.length,
    status: "VERIFIED",
  });
}
