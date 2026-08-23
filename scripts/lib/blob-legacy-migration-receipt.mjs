import {
  assertExactObjectKeys,
  canonicalJson,
  requireIsoTimestamp,
  requireSha256,
  sha256,
  validateExternalGateRuntimeBinding,
  verifyExternalGateReceipt,
} from "./external-gate-receipts.mjs";

export const blobLegacyMigrationRole = "blob-migration-attestor";
export const blobLegacyMigrationRecordType =
  "NOVALURE_PREVIEW_BLOB_LEGACY_MIGRATION_RECEIPT";

const maximumObjects = 1_000;
const maximumObjectBytes = 500 * 1024 * 1024;
const storeFingerprintPattern = /^sha256:[a-f0-9]{20,64}$/u;

function invariant(condition, code) {
  if (!condition) throw new Error(code);
}

function requireStoreFingerprint(value, code) {
  invariant(storeFingerprintPattern.test(value ?? ""), code);
  return value;
}

function canonicalContentInventory(objects) {
  return objects.map((entry) => ({
    assetKeySha256: entry.assetKeySha256,
    contentSha256: entry.contentSha256,
    sizeBytes: entry.sizeBytes,
  }));
}

export function summarizeLegacyBlobObjectInventory(objects) {
  invariant(
    Array.isArray(objects) && objects.length > 0 && objects.length <= maximumObjects,
    "BLOB_LEGACY_OBJECT_INVENTORY_COUNT_INVALID",
  );
  const assetKeys = new Set();
  const paths = new Set();
  let previousAssetKey = null;
  let totalBytes = 0;
  for (const entry of objects) {
    assertExactObjectKeys(entry, [
      "assetKeySha256",
      "contentSha256",
      "objectPathSha256",
      "sizeBytes",
    ], "BLOB_LEGACY_OBJECT");
    requireSha256(entry.assetKeySha256, "BLOB_LEGACY_ASSET_DIGEST_INVALID");
    requireSha256(entry.contentSha256, "BLOB_LEGACY_CONTENT_DIGEST_INVALID");
    requireSha256(entry.objectPathSha256, "BLOB_LEGACY_PATH_DIGEST_INVALID");
    invariant(
      Number.isSafeInteger(entry.sizeBytes)
        && entry.sizeBytes > 0
        && entry.sizeBytes <= maximumObjectBytes,
      "BLOB_LEGACY_OBJECT_SIZE_INVALID",
    );
    invariant(!assetKeys.has(entry.assetKeySha256), "BLOB_LEGACY_ASSET_DUPLICATED");
    invariant(!paths.has(entry.objectPathSha256), "BLOB_LEGACY_PATH_DUPLICATED");
    invariant(
      previousAssetKey === null || entry.assetKeySha256 > previousAssetKey,
      "BLOB_LEGACY_OBJECT_ORDER_INVALID",
    );
    assetKeys.add(entry.assetKeySha256);
    paths.add(entry.objectPathSha256);
    previousAssetKey = entry.assetKeySha256;
    totalBytes += entry.sizeBytes;
    invariant(Number.isSafeInteger(totalBytes), "BLOB_LEGACY_TOTAL_BYTES_INVALID");
  }
  return Object.freeze({
    contentSha256: sha256(canonicalJson(canonicalContentInventory(objects))),
    inventorySha256: sha256(canonicalJson(objects)),
    objectCount: objects.length,
    totalBytes,
  });
}

function validateObjectInventory(inventory, expectedStoreFingerprint, code) {
  assertExactObjectKeys(inventory, [
    "contentSha256",
    "inventorySha256",
    "objectCount",
    "objects",
    "storeFingerprint",
    "totalBytes",
  ], code);
  requireStoreFingerprint(inventory.storeFingerprint, `${code}_STORE_INVALID`);
  invariant(inventory.storeFingerprint === expectedStoreFingerprint, `${code}_STORE_MISMATCH`);
  const summary = summarizeLegacyBlobObjectInventory(inventory.objects);
  invariant(
    inventory.objectCount === summary.objectCount
      && inventory.totalBytes === summary.totalBytes
      && inventory.inventorySha256 === summary.inventorySha256
      && inventory.contentSha256 === summary.contentSha256,
    `${code}_SUMMARY_MISMATCH`,
  );
  return summary;
}

function validateReferenceCutover(referenceCutover, targetObjects) {
  assertExactObjectKeys(referenceCutover, [
    "allReferencesTargetStore",
    "referenceInventorySha256",
    "references",
    "rewrittenReferenceCount",
  ], "BLOB_LEGACY_REFERENCE_CUTOVER");
  invariant(Array.isArray(referenceCutover.references), "BLOB_LEGACY_REFERENCES_REQUIRED");
  invariant(
    referenceCutover.references.length === targetObjects.length,
    "BLOB_LEGACY_REFERENCE_COUNT_INVALID",
  );
  const targetByAsset = new Map(targetObjects.map((entry) => [entry.assetKeySha256, entry]));
  let previousAssetKey = null;
  for (const reference of referenceCutover.references) {
    assertExactObjectKeys(reference, [
      "assetKeySha256",
      "databaseRowSha256",
      "targetObjectPathSha256",
    ], "BLOB_LEGACY_REFERENCE");
    requireSha256(reference.assetKeySha256, "BLOB_LEGACY_REFERENCE_ASSET_INVALID");
    requireSha256(reference.databaseRowSha256, "BLOB_LEGACY_REFERENCE_ROW_INVALID");
    requireSha256(reference.targetObjectPathSha256, "BLOB_LEGACY_REFERENCE_PATH_INVALID");
    invariant(
      previousAssetKey === null || reference.assetKeySha256 > previousAssetKey,
      "BLOB_LEGACY_REFERENCE_ORDER_INVALID",
    );
    invariant(
      targetByAsset.get(reference.assetKeySha256)?.objectPathSha256 === reference.targetObjectPathSha256,
      "BLOB_LEGACY_REFERENCE_TARGET_MISMATCH",
    );
    previousAssetKey = reference.assetKeySha256;
  }
  const referenceInventorySha256 = sha256(canonicalJson(referenceCutover.references));
  invariant(
    referenceCutover.allReferencesTargetStore === true
      && referenceCutover.rewrittenReferenceCount === targetObjects.length
      && referenceCutover.referenceInventorySha256 === referenceInventorySha256,
    "BLOB_LEGACY_REFERENCE_SUMMARY_MISMATCH",
  );
  return referenceInventorySha256;
}

function validateRollback(rollback, sourceObjects, targetObjects) {
  assertExactObjectKeys(rollback, [
    "artifactSha256",
    "artifacts",
    "status",
  ], "BLOB_LEGACY_ROLLBACK");
  invariant(Array.isArray(rollback.artifacts), "BLOB_LEGACY_ROLLBACK_ARTIFACTS_REQUIRED");
  invariant(rollback.artifacts.length === sourceObjects.length, "BLOB_LEGACY_ROLLBACK_COUNT_INVALID");
  const sourceByAsset = new Map(sourceObjects.map((entry) => [entry.assetKeySha256, entry]));
  const targetByAsset = new Map(targetObjects.map((entry) => [entry.assetKeySha256, entry]));
  let previousAssetKey = null;
  for (const artifact of rollback.artifacts) {
    assertExactObjectKeys(artifact, [
      "assetKeySha256",
      "contentSha256",
      "sizeBytes",
      "sourceObjectPathSha256",
      "targetObjectPathSha256",
    ], "BLOB_LEGACY_ROLLBACK_ARTIFACT");
    for (const key of [
      "assetKeySha256",
      "contentSha256",
      "sourceObjectPathSha256",
      "targetObjectPathSha256",
    ]) requireSha256(artifact[key], "BLOB_LEGACY_ROLLBACK_DIGEST_INVALID");
    const source = sourceByAsset.get(artifact.assetKeySha256);
    const target = targetByAsset.get(artifact.assetKeySha256);
    invariant(
      source
        && target
        && artifact.contentSha256 === source.contentSha256
        && artifact.contentSha256 === target.contentSha256
        && artifact.sizeBytes === source.sizeBytes
        && artifact.sizeBytes === target.sizeBytes
        && artifact.sourceObjectPathSha256 === source.objectPathSha256
        && artifact.targetObjectPathSha256 === target.objectPathSha256,
      "BLOB_LEGACY_ROLLBACK_OBJECT_MISMATCH",
    );
    invariant(
      previousAssetKey === null || artifact.assetKeySha256 > previousAssetKey,
      "BLOB_LEGACY_ROLLBACK_ORDER_INVALID",
    );
    previousAssetKey = artifact.assetKeySha256;
  }
  const artifactSha256 = sha256(canonicalJson(rollback.artifacts));
  invariant(
    rollback.status === "VERIFIED" && rollback.artifactSha256 === artifactSha256,
    "BLOB_LEGACY_ROLLBACK_SUMMARY_MISMATCH",
  );
  return artifactSha256;
}

export function validateLegacyBlobMigrationProof({
  expectedCandidateCommit,
  expectedDatabaseBranchId,
  expectedDeploymentId,
  expectedRuntime = null,
  expectedTargetStoreFingerprint,
  proof,
  requireReceipt = false,
  trustContext = null,
}) {
  invariant(proof?.status === "VERIFIED", "BLOB_LEGACY_PROOF_NOT_VERIFIED");
  invariant(proof.productionMutationPerformed === false, "BLOB_LEGACY_PRODUCTION_MUTATION");
  invariant(proof.candidateCommit === expectedCandidateCommit, "BLOB_LEGACY_CANDIDATE_MISMATCH");
  invariant(proof.storeFingerprint === expectedTargetStoreFingerprint, "BLOB_LEGACY_TARGET_STORE_MISMATCH");
  const evidence = proof.evidence;
  assertExactObjectKeys(evidence, [
    "candidateCommit",
    "deploymentId",
    "journalSha256",
    "observedAt",
    "oldStorePostcondition",
    "recordType",
    "referenceCutover",
    "rollback",
    "schemaVersion",
    "sourceInventory",
    "sourceStoreFingerprint",
    "targetDatabaseBranchId",
    "targetInventory",
    "targetStoreFingerprint",
  ], "BLOB_LEGACY_EVIDENCE");
  invariant(
    evidence.schemaVersion === 2
      && evidence.recordType === "NOVALURE_PREVIEW_BLOB_LEGACY_MIGRATION_EVIDENCE"
      && evidence.candidateCommit === expectedCandidateCommit
      && evidence.deploymentId === expectedDeploymentId
      && evidence.targetDatabaseBranchId === expectedDatabaseBranchId,
    "BLOB_LEGACY_EVIDENCE_RUNTIME_MISMATCH",
  );
  requireIsoTimestamp(evidence.observedAt, "BLOB_LEGACY_EVIDENCE_TIME_INVALID");
  requireSha256(evidence.journalSha256, "BLOB_LEGACY_JOURNAL_DIGEST_INVALID");
  requireStoreFingerprint(evidence.sourceStoreFingerprint, "BLOB_LEGACY_SOURCE_STORE_INVALID");
  requireStoreFingerprint(evidence.targetStoreFingerprint, "BLOB_LEGACY_TARGET_STORE_INVALID");
  invariant(
    evidence.sourceStoreFingerprint !== evidence.targetStoreFingerprint
      && evidence.targetStoreFingerprint === expectedTargetStoreFingerprint,
    "BLOB_LEGACY_STORE_BOUNDARY_INVALID",
  );
  const sourceSummary = validateObjectInventory(
    evidence.sourceInventory,
    evidence.sourceStoreFingerprint,
    "BLOB_LEGACY_SOURCE_INVENTORY",
  );
  const targetSummary = validateObjectInventory(
    evidence.targetInventory,
    evidence.targetStoreFingerprint,
    "BLOB_LEGACY_TARGET_INVENTORY",
  );
  invariant(
    sourceSummary.objectCount === targetSummary.objectCount
      && sourceSummary.totalBytes === targetSummary.totalBytes
      && sourceSummary.contentSha256 === targetSummary.contentSha256,
    "BLOB_LEGACY_SOURCE_TARGET_CONTENT_MISMATCH",
  );
  const targetByAsset = new Map(evidence.targetInventory.objects.map((entry) => [entry.assetKeySha256, entry]));
  for (const source of evidence.sourceInventory.objects) {
    const target = targetByAsset.get(source.assetKeySha256);
    invariant(
      target
        && target.contentSha256 === source.contentSha256
        && target.sizeBytes === source.sizeBytes,
      "BLOB_LEGACY_OBJECT_MIGRATION_MISMATCH",
    );
  }
  const referenceInventorySha256 = validateReferenceCutover(
    evidence.referenceCutover,
    evidence.targetInventory.objects,
  );
  const rollbackArtifactSha256 = validateRollback(
    evidence.rollback,
    evidence.sourceInventory.objects,
    evidence.targetInventory.objects,
  );
  assertExactObjectKeys(evidence.oldStorePostcondition, [
    "authenticatedReadDenied",
    "listedObjectCount",
    "publicReadDenied",
  ], "BLOB_LEGACY_OLD_STORE_POSTCONDITION");
  invariant(
    evidence.oldStorePostcondition.listedObjectCount === 0
      && evidence.oldStorePostcondition.authenticatedReadDenied === true
      && evidence.oldStorePostcondition.publicReadDenied === true,
    "BLOB_LEGACY_OLD_STORE_NOT_CLOSED",
  );
  invariant(
    proof.evidenceDigest === sha256(canonicalJson(evidence)),
    "BLOB_LEGACY_EVIDENCE_DIGEST_MISMATCH",
  );
  invariant(
    proof.legacyObjectCountBefore === sourceSummary.objectCount
      && proof.migratedObjectCount === targetSummary.objectCount
      && proof.legacyObjectCountAfter === 0,
    "BLOB_LEGACY_PROOF_COUNTS_INVALID",
  );

  if (requireReceipt) {
    verifyExternalGateReceipt({
      expectedRecordType: blobLegacyMigrationRecordType,
      expectedRole: blobLegacyMigrationRole,
      receipt: proof.migrationReceipt,
      trustContext,
    });
    const payload = proof.migrationReceipt.payload;
    assertExactObjectKeys(payload, [
      "evidenceSha256",
      "journalSha256",
      "referenceInventorySha256",
      "rollbackArtifactSha256",
      "runtime",
      "sourceInventorySha256",
      "sourceStoreFingerprint",
      "targetInventorySha256",
      "targetStoreFingerprint",
    ], "BLOB_LEGACY_MIGRATION_RECEIPT_PAYLOAD");
    validateExternalGateRuntimeBinding(payload.runtime, expectedRuntime);
    for (const key of [
      "evidenceSha256",
      "journalSha256",
      "referenceInventorySha256",
      "rollbackArtifactSha256",
      "sourceInventorySha256",
      "targetInventorySha256",
    ]) requireSha256(payload[key], "BLOB_LEGACY_MIGRATION_RECEIPT_DIGEST_INVALID");
    invariant(
      payload.evidenceSha256 === proof.evidenceDigest
        && payload.journalSha256 === evidence.journalSha256
        && payload.referenceInventorySha256 === referenceInventorySha256
        && payload.rollbackArtifactSha256 === rollbackArtifactSha256
        && payload.sourceInventorySha256 === sourceSummary.inventorySha256
        && payload.targetInventorySha256 === targetSummary.inventorySha256
        && payload.sourceStoreFingerprint === evidence.sourceStoreFingerprint
        && payload.targetStoreFingerprint === evidence.targetStoreFingerprint,
      "BLOB_LEGACY_MIGRATION_RECEIPT_BINDING_MISMATCH",
    );
    invariant(
      Date.parse(proof.migrationReceipt.signedAt) >= Date.parse(evidence.observedAt),
      "BLOB_LEGACY_MIGRATION_RECEIPT_SIGNED_EARLY",
    );
  } else if (proof.migrationReceipt !== undefined && proof.migrationReceipt !== null) {
    invariant(typeof proof.migrationReceipt === "object", "BLOB_LEGACY_MIGRATION_RECEIPT_INVALID");
  }

  return Object.freeze({
    evidenceSha256: proof.evidenceDigest,
    objectCount: sourceSummary.objectCount,
    referenceInventorySha256,
    rollbackArtifactSha256,
    sourceInventorySha256: sourceSummary.inventorySha256,
    status: "VERIFIED",
    targetInventorySha256: targetSummary.inventorySha256,
    totalBytes: sourceSummary.totalBytes,
  });
}
