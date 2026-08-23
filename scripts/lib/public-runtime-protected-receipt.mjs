import {
  assertExactObjectKeys,
  canonicalJson,
  requireIsoTimestamp,
  requireSha256,
  sha256,
  validateExternalGateRuntimeBinding,
  verifyExternalGateReceipt,
} from "./external-gate-receipts.mjs";

export const publicRuntimeWorkflowRole = "github-actions-attestor";
export const publicRuntimeWorkflowRecordType = "NOVALURE_PUBLIC_RUNTIME_WORKFLOW_RECEIPT";

export const publicRuntimeProofObservations = Object.freeze({
  "public-form-long-proof-refresh": Object.freeze([
    "initial-proof-issued",
    "old-proof-rejected",
    "refresh-issued-after-long-session",
    "refreshed-proof-accepted",
  ]),
  "public-form-live-submission": Object.freeze([
    "crm-link-verified",
    "idempotent-replay-verified",
    "persisted-exactly-once",
    "submission-accepted",
  ]),
  "public-funnel-long-proof-refresh": Object.freeze([
    "initial-revision-proof-issued",
    "old-proof-rejected",
    "refresh-issued-after-long-session",
    "refreshed-revision-proof-accepted",
  ]),
  "public-funnel-live-submission": Object.freeze([
    "crm-link-verified",
    "idempotent-replay-verified",
    "persisted-exactly-once",
    "revision-bound-submission-accepted",
  ]),
  "funnel-publish-token-rotation": Object.freeze([
    "new-token-accepted",
    "old-token-rejected",
    "published-revision-preserved",
    "repository-token-reference-absent",
  ]),
});

const minimumLongSessionSeconds = 15 * 60;
const successStatus = Object.freeze({ maximum: 299, minimum: 200 });
const rejectedStatus = Object.freeze({ maximum: 499, minimum: 400 });
const expiredProofStatus = Object.freeze({ maximum: 400, minimum: 400 });
const publicRuntimeObservationStatuses = Object.freeze({
  "crm-link-verified": successStatus,
  "idempotent-replay-verified": successStatus,
  "initial-proof-issued": successStatus,
  "initial-revision-proof-issued": successStatus,
  "new-token-accepted": successStatus,
  "old-proof-rejected": expiredProofStatus,
  "old-token-rejected": rejectedStatus,
  "persisted-exactly-once": successStatus,
  "published-revision-preserved": successStatus,
  "refresh-issued-after-long-session": successStatus,
  "refreshed-proof-accepted": successStatus,
  "refreshed-revision-proof-accepted": successStatus,
  "repository-token-reference-absent": successStatus,
  "revision-bound-submission-accepted": successStatus,
  "submission-accepted": successStatus,
});

export const publicRuntimeArtifactFiles = Object.freeze([
  "funnel-publish-token-rotation.json",
  "public-form-funnel-cleanup.json",
  "public-form-live-submission.json",
  "public-form-long-proof-refresh.json",
  "public-funnel-live-submission.json",
  "public-funnel-long-proof-refresh.json",
]);

const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;

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

function expectedArtifactFile(proofId) {
  return `${proofId}.json`;
}

function validateArtifactManifest(manifest) {
  assertExactObjectKeys(manifest, [
    "artifactDigest",
    "artifactName",
    "files",
    "recordType",
    "schemaVersion",
  ], "PUBLIC_RUNTIME_ARTIFACT_MANIFEST");
  invariant(manifest.schemaVersion === 1, "PUBLIC_RUNTIME_ARTIFACT_MANIFEST_SCHEMA_INVALID");
  invariant(
    manifest.recordType === "NOVALURE_PUBLIC_RUNTIME_ARTIFACT_MANIFEST",
    "PUBLIC_RUNTIME_ARTIFACT_MANIFEST_TYPE_INVALID",
  );
  invariant(
    /^[A-Za-z0-9][A-Za-z0-9._-]{7,179}$/u.test(manifest.artifactName ?? ""),
    "PUBLIC_RUNTIME_ARTIFACT_NAME_INVALID",
  );
  requireSha256(manifest.artifactDigest, "PUBLIC_RUNTIME_ARTIFACT_DIGEST_INVALID");
  invariant(Array.isArray(manifest.files), "PUBLIC_RUNTIME_ARTIFACT_FILES_REQUIRED");
  assertExactInventory(manifest.files.map((file) => file?.name), publicRuntimeArtifactFiles, "PUBLIC_RUNTIME_ARTIFACT_FILES");
  for (const file of manifest.files) {
    assertExactObjectKeys(file, ["name", "sha256", "sizeBytes"], "PUBLIC_RUNTIME_ARTIFACT_FILE");
    requireSha256(file.sha256, "PUBLIC_RUNTIME_ARTIFACT_FILE_DIGEST_INVALID");
    invariant(
      Number.isSafeInteger(file.sizeBytes) && file.sizeBytes > 0 && file.sizeBytes <= 16 * 1024 * 1024,
      "PUBLIC_RUNTIME_ARTIFACT_FILE_SIZE_INVALID",
    );
  }
  return new Map(manifest.files.map((file) => [file.name, file]));
}

function validateSemanticEvidence(proof) {
  const evidence = proof.semanticEvidence;
  if (proof.id.endsWith("long-proof-refresh")) {
    assertExactObjectKeys(evidence, [
      "idempotencyKeyAfterSha256",
      "idempotencyKeyBeforeSha256",
      "minimumElapsedSeconds",
      "oldProofRejectionCode",
    ], "PUBLIC_RUNTIME_LONG_PROOF_SEMANTICS");
    requireSha256(evidence.idempotencyKeyBeforeSha256, "PUBLIC_RUNTIME_LONG_PROOF_IDEMPOTENCY_DIGEST_INVALID");
    requireSha256(evidence.idempotencyKeyAfterSha256, "PUBLIC_RUNTIME_LONG_PROOF_IDEMPOTENCY_DIGEST_INVALID");
    invariant(
      evidence.idempotencyKeyBeforeSha256 === evidence.idempotencyKeyAfterSha256,
      "PUBLIC_RUNTIME_LONG_PROOF_IDEMPOTENCY_CHANGED",
    );
    invariant(
      Number.isSafeInteger(evidence.minimumElapsedSeconds)
        && evidence.minimumElapsedSeconds >= minimumLongSessionSeconds,
      "PUBLIC_RUNTIME_LONG_PROOF_DURATION_INVALID",
    );
    invariant(
      evidence.oldProofRejectionCode === "submission_proof_expired",
      "PUBLIC_RUNTIME_LONG_PROOF_REJECTION_INVALID",
    );
    return;
  }
  if (proof.id.endsWith("live-submission")) {
    assertExactObjectKeys(evidence, [
      "createdObjectCount",
      "idempotencyKeySha256",
      "idempotentReplayCreatedObjectCount",
      "persistedObjectSha256",
      "replayResponseSha256",
    ], "PUBLIC_RUNTIME_SUBMISSION_SEMANTICS");
    requireSha256(evidence.idempotencyKeySha256, "PUBLIC_RUNTIME_SUBMISSION_IDEMPOTENCY_DIGEST_INVALID");
    requireSha256(evidence.persistedObjectSha256, "PUBLIC_RUNTIME_SUBMISSION_OBJECT_DIGEST_INVALID");
    requireSha256(evidence.replayResponseSha256, "PUBLIC_RUNTIME_SUBMISSION_REPLAY_DIGEST_INVALID");
    invariant(
      evidence.createdObjectCount === 1 && evidence.idempotentReplayCreatedObjectCount === 0,
      "PUBLIC_RUNTIME_SUBMISSION_EXACTLY_ONCE_INVALID",
    );
    return;
  }
  assertExactObjectKeys(evidence, [
    "newTokenSha256",
    "oldTokenRejectionCode",
    "oldTokenSha256",
    "publishedRevisionSha256",
    "repositoryScanSha256",
  ], "PUBLIC_RUNTIME_TOKEN_ROTATION_SEMANTICS");
  for (const key of ["newTokenSha256", "oldTokenSha256", "publishedRevisionSha256", "repositoryScanSha256"]) {
    requireSha256(evidence[key], "PUBLIC_RUNTIME_TOKEN_ROTATION_DIGEST_INVALID");
  }
  invariant(evidence.newTokenSha256 !== evidence.oldTokenSha256, "PUBLIC_RUNTIME_TOKEN_ROTATION_TOKEN_REUSED");
  invariant(
    evidence.oldTokenRejectionCode === "invalid_publish_token",
    "PUBLIC_RUNTIME_TOKEN_ROTATION_REJECTION_INVALID",
  );
}

function validateProof(proof, runtime, qaBatchId, cleanupInventorySha256, artifactFiles) {
  assertExactObjectKeys(proof, [
    "artifactFile",
    "artifactSha256",
    "candidateCommit",
    "cleanupInventorySha256",
    "databaseInventorySha256",
    "deploymentId",
    "id",
    "observations",
    "qaBatchId",
    "semanticEvidence",
    "status",
  ], "PUBLIC_RUNTIME_PROOF");
  const expectedObservations = publicRuntimeProofObservations[proof.id];
  invariant(Array.isArray(expectedObservations), "PUBLIC_RUNTIME_PROOF_ID_INVALID");
  invariant(proof.status === "PASS", "PUBLIC_RUNTIME_PROOF_NOT_PASS");
  invariant(proof.candidateCommit === runtime.candidateCommit, "PUBLIC_RUNTIME_PROOF_CANDIDATE_MISMATCH");
  invariant(proof.deploymentId === runtime.deploymentId, "PUBLIC_RUNTIME_PROOF_DEPLOYMENT_MISMATCH");
  invariant(proof.qaBatchId === qaBatchId, "PUBLIC_RUNTIME_PROOF_QA_BATCH_MISMATCH");
  invariant(proof.artifactFile === expectedArtifactFile(proof.id), "PUBLIC_RUNTIME_PROOF_ARTIFACT_FILE_INVALID");
  requireSha256(proof.artifactSha256, "PUBLIC_RUNTIME_PROOF_ARTIFACT_DIGEST_INVALID");
  invariant(
    artifactFiles.get(proof.artifactFile)?.sha256 === proof.artifactSha256,
    "PUBLIC_RUNTIME_PROOF_ARTIFACT_DIGEST_MISMATCH",
  );
  requireSha256(proof.databaseInventorySha256, "PUBLIC_RUNTIME_PROOF_DATABASE_DIGEST_INVALID");
  requireSha256(proof.cleanupInventorySha256, "PUBLIC_RUNTIME_PROOF_CLEANUP_DIGEST_INVALID");
  invariant(
    proof.cleanupInventorySha256 === cleanupInventorySha256,
    "PUBLIC_RUNTIME_PROOF_CLEANUP_DIGEST_MISMATCH",
  );
  invariant(Array.isArray(proof.observations), "PUBLIC_RUNTIME_PROOF_OBSERVATIONS_REQUIRED");
  assertExactInventory(
    proof.observations.map((observation) => observation?.id),
    expectedObservations,
    "PUBLIC_RUNTIME_PROOF_OBSERVATIONS",
  );
  const observations = new Map(proof.observations.map((observation) => [observation?.id, observation]));
  let previousTime = null;
  for (const observationId of expectedObservations) {
    const observation = observations.get(observationId);
    assertExactObjectKeys(observation, ["id", "observedAt", "responseSha256", "status"], "PUBLIC_RUNTIME_OBSERVATION");
    const statusContract = publicRuntimeObservationStatuses[observation.id];
    invariant(
      statusContract
        && Number.isSafeInteger(observation.status)
        && observation.status >= statusContract.minimum
        && observation.status <= statusContract.maximum,
      "PUBLIC_RUNTIME_OBSERVATION_STATUS_INVALID",
    );
    requireIsoTimestamp(observation.observedAt, "PUBLIC_RUNTIME_OBSERVATION_TIME_INVALID");
    const observedAt = Date.parse(observation.observedAt);
    invariant(previousTime === null || observedAt > previousTime, "PUBLIC_RUNTIME_OBSERVATION_ORDER_INVALID");
    previousTime = observedAt;
    requireSha256(observation.responseSha256, "PUBLIC_RUNTIME_OBSERVATION_RESPONSE_DIGEST_INVALID");
  }
  if (proof.id.endsWith("long-proof-refresh")) {
    const initialObservationId = proof.id.startsWith("public-funnel-")
      ? "initial-revision-proof-issued"
      : "initial-proof-issued";
    const initialObservation = observations.get(initialObservationId);
    const rejectedObservation = observations.get("old-proof-rejected");
    invariant(initialObservation && rejectedObservation, "PUBLIC_RUNTIME_LONG_PROOF_OBSERVATIONS_INVALID");
    const issuedAt = Date.parse(initialObservation.observedAt);
    const rejectedAt = Date.parse(rejectedObservation.observedAt);
    invariant(
      rejectedAt - issuedAt >= minimumLongSessionSeconds * 1_000,
      "PUBLIC_RUNTIME_LONG_PROOF_DURATION_INVALID",
    );
  }
  validateSemanticEvidence(proof);
  return previousTime;
}

export function validatePublicRuntimeProtectedReceipt({
  artifactManifest,
  cleanup,
  proofs,
  receipt,
  runtime,
  trustedHarnessSha,
  trustContext,
}) {
  const artifactFiles = validateArtifactManifest(artifactManifest);
  invariant(Array.isArray(proofs), "PUBLIC_RUNTIME_PROOFS_REQUIRED");
  assertExactInventory(Object.keys(publicRuntimeProofObservations), proofs.map((proof) => proof?.id), "PUBLIC_RUNTIME_PROOF_INVENTORY");
  assertExactObjectKeys(cleanup, [
    "createdObjectCount",
    "databaseCleanup",
    "deletedObjectCount",
    "exactPrePostContentFingerprintMatch",
    "inventoryAfterSha256",
    "inventoryBeforeSha256",
    "qaBatchId",
    "remainingObjectCount",
    "status",
  ], "PUBLIC_RUNTIME_CLEANUP");
  invariant(uuidPattern.test(cleanup.qaBatchId ?? ""), "PUBLIC_RUNTIME_QA_BATCH_INVALID");
  invariant(
    cleanup.status === "PASS"
      && cleanup.databaseCleanup === "VERIFIED_ZERO"
      && cleanup.exactPrePostContentFingerprintMatch === true
      && Number.isSafeInteger(cleanup.createdObjectCount)
      && cleanup.createdObjectCount > 0
      && cleanup.deletedObjectCount === cleanup.createdObjectCount
      && cleanup.remainingObjectCount === 0,
    "PUBLIC_RUNTIME_CLEANUP_NOT_ZERO",
  );
  requireSha256(cleanup.inventoryBeforeSha256, "PUBLIC_RUNTIME_CLEANUP_BEFORE_DIGEST_INVALID");
  requireSha256(cleanup.inventoryAfterSha256, "PUBLIC_RUNTIME_CLEANUP_AFTER_DIGEST_INVALID");
  invariant(
    cleanup.inventoryBeforeSha256 === cleanup.inventoryAfterSha256,
    "PUBLIC_RUNTIME_CLEANUP_INVENTORY_MISMATCH",
  );
  const cleanupInventorySha256 = sha256(canonicalJson(cleanup));
  invariant(
    artifactFiles.get("public-form-funnel-cleanup.json")?.sha256 === cleanupInventorySha256,
    "PUBLIC_RUNTIME_CLEANUP_ARTIFACT_DIGEST_MISMATCH",
  );
  const latestObservationTime = Math.max(...proofs.map((proof) =>
    validateProof(proof, runtime, cleanup.qaBatchId, cleanupInventorySha256, artifactFiles)));

  verifyExternalGateReceipt({
    expectedRecordType: publicRuntimeWorkflowRecordType,
    expectedRole: publicRuntimeWorkflowRole,
    receipt,
    trustContext,
  });
  assertExactObjectKeys(receipt.payload, [
    "artifactDigest",
    "artifactManifestSha256",
    "attestationBundleSha256",
    "cleanupInventorySha256",
    "githubRunId",
    "proofInventorySha256",
    "qaBatchId",
    "runtime",
    "trustedHarnessSha",
    "workflowRef",
    "workflowSha",
  ], "PUBLIC_RUNTIME_WORKFLOW_PAYLOAD");
  validateExternalGateRuntimeBinding(receipt.payload.runtime, runtime);
  invariant(receipt.payload.artifactDigest === artifactManifest.artifactDigest, "PUBLIC_RUNTIME_WORKFLOW_ARTIFACT_MISMATCH");
  invariant(
    receipt.payload.artifactManifestSha256 === sha256(canonicalJson(artifactManifest)),
    "PUBLIC_RUNTIME_WORKFLOW_MANIFEST_DIGEST_MISMATCH",
  );
  invariant(
    receipt.payload.proofInventorySha256 === sha256(canonicalJson(proofs)),
    "PUBLIC_RUNTIME_WORKFLOW_PROOF_DIGEST_MISMATCH",
  );
  invariant(
    receipt.payload.cleanupInventorySha256 === cleanupInventorySha256,
    "PUBLIC_RUNTIME_WORKFLOW_CLEANUP_DIGEST_MISMATCH",
  );
  invariant(receipt.payload.qaBatchId === cleanup.qaBatchId, "PUBLIC_RUNTIME_WORKFLOW_QA_BATCH_MISMATCH");
  requireSha256(receipt.payload.attestationBundleSha256, "PUBLIC_RUNTIME_WORKFLOW_ATTESTATION_DIGEST_INVALID");
  invariant(
    /^[a-f0-9]{40}$/u.test(trustedHarnessSha ?? "")
      && receipt.payload.trustedHarnessSha === trustedHarnessSha,
    "PUBLIC_RUNTIME_WORKFLOW_HARNESS_INVALID",
  );
  invariant(receipt.payload.workflowSha === receipt.payload.trustedHarnessSha, "PUBLIC_RUNTIME_WORKFLOW_SHA_MISMATCH");
  invariant(
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/\.github\/workflows\/livegang-e2e\.yml@refs\/heads\/main$/u
      .test(receipt.payload.workflowRef ?? ""),
    "PUBLIC_RUNTIME_WORKFLOW_REF_INVALID",
  );
  invariant(/^\d{6,20}$/u.test(receipt.payload.githubRunId ?? ""), "PUBLIC_RUNTIME_WORKFLOW_RUN_ID_INVALID");
  invariant(
    Date.parse(receipt.signedAt) >= latestObservationTime,
    "PUBLIC_RUNTIME_WORKFLOW_SIGNED_BEFORE_OBSERVATION",
  );
  return Object.freeze({
    artifactDigest: receipt.payload.artifactDigest,
    qaBatchId: cleanup.qaBatchId,
    receiptId: receipt.receiptId,
    status: "VERIFIED",
  });
}
