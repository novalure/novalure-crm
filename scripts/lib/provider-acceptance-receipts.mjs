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

export const providerAcceptanceRole = "provider-acceptance-attestor";
export const providerAcceptanceRecordType = "NOVALURE_PROVIDER_ACCEPTANCE_RECEIPT";

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
  }),
  "workspace-invitation-email": Object.freeze({
    outcomes: Object.freeze([
      "delivery-observed",
      "invitation-accepted",
      "membership-observed",
      "replay-rejected",
    ]),
    providers: Object.freeze(["RESEND"]),
  }),
  "invitation-resend-email": Object.freeze({
    outcomes: Object.freeze([
      "delivery-observed",
      "new-link-consumed",
      "prior-link-rejected",
      "replay-rejected",
    ]),
    providers: Object.freeze(["RESEND"]),
  }),
  "customer-access-invitation-email": Object.freeze({
    outcomes: Object.freeze([
      "access-activated",
      "delivery-observed",
      "link-consumed",
      "replay-rejected",
    ]),
    providers: Object.freeze(["RESEND"]),
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
  trustContext,
}) {
  invariant(Array.isArray(receipts), "PROVIDER_ACCEPTANCE_RECEIPTS_REQUIRED");
  invariant(isPlainObject(databasePostcondition), "PROVIDER_ACCEPTANCE_DATABASE_POSTCONDITION_REQUIRED");
  const databasePostconditionSha256 = sha256(canonicalJson(databasePostcondition));
  const requiredIds = Object.keys(requiredProviderAcceptances);
  assertExactInventory(receipts.map((receipt) => receipt?.payload?.acceptanceId), requiredIds, "PROVIDER_ACCEPTANCE_INVENTORY");
  const receiptIds = new Set();
  for (const receipt of receipts) {
    verifyExternalGateReceipt({
      expectedRecordType: providerAcceptanceRecordType,
      expectedRole: providerAcceptanceRole,
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
      "qaTargetFingerprint",
      "runtime",
    ], "PROVIDER_ACCEPTANCE_PAYLOAD");
    const contract = requiredProviderAcceptances[payload.acceptanceId];
    invariant(isPlainObject(contract), "PROVIDER_ACCEPTANCE_ID_INVALID");
    validateExternalGateRuntimeBinding(payload.runtime, runtime);
    validateProviderIdentity(payload.providerIdentity, contract.providers);
    validateObservationWindow(payload.observationWindow);
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
      /^sha256:[a-f0-9]{64}$/u.test(payload.qaTargetFingerprint ?? ""),
      "PROVIDER_ACCEPTANCE_QA_TARGET_INVALID",
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
