import { constants as fsConstants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  realpath,
} from "node:fs/promises";
import path from "node:path";

import {
  blobLegacyMigrationRole,
  summarizeLegacyBlobObjectInventory,
  validateLegacyBlobMigrationProof,
} from "./blob-legacy-migration-receipt.mjs";
import {
  assertExactObjectKeys,
  canonicalJson,
  loadExternalGateTrustContext,
  requireIsoTimestamp,
  requireSha256,
  sha256,
  validateExternalGateRuntimeBinding,
} from "./external-gate-receipts.mjs";
import {
  legacyBlobAssetKey,
  legacyBlobTargetFingerprint,
} from "./legacy-blob-cutover.mjs";

const maximumJournalBytes = 8 * 1024 * 1024;
const maximumProofBytes = 16 * 1024 * 1024;
const maximumReceiptBytes = 256 * 1024;
const maximumSidecarBytes = 512;
const maximumObjects = 1_000;
const maximumDraftAgeMilliseconds = 30 * 60 * 1_000;
const deniedReadStatuses = new Set([401, 403, 404, 410]);
const storeFingerprintPattern = /^sha256:[a-f0-9]{20,64}$/u;
const journalAllowedKeys = new Set([
  "assetKey",
  "at",
  "deleteNotBefore",
  "destinationStoreFingerprint",
  "errorClass",
  "errorCode",
  "mode",
  "runId",
  "sha256",
  "sizeBytes",
  "sourceRetained",
  "sourceStoreFingerprint",
  "status",
  "targetFingerprint",
  "version",
]);

export class LegacyBlobCutoverEvidenceError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.code = code;
  }
}

function fail(code, message, cause) {
  throw new LegacyBlobCutoverEvidenceError(code, message, cause ? { cause } : undefined);
}

function invariant(condition, code, message = code) {
  if (!condition) fail(code, message);
}

function samePath(left, right) {
  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

function isOutsideDirectory(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}

async function readBoundedRegularFile(filePath, {
  code,
  maximumBytes,
  mustBeOutsideRepository = false,
  repositoryRoot = process.cwd(),
  requiredParent = null,
} = {}) {
  invariant(typeof filePath === "string" && path.isAbsolute(filePath), `${code}_ABSOLUTE_PATH_REQUIRED`);
  const resolved = path.resolve(filePath);
  let state;
  try {
    state = await lstat(resolved);
  } catch (error) {
    fail(`${code}_UNREADABLE`, `${code} could not be read.`, error);
  }
  invariant(
    state.isFile()
      && !state.isSymbolicLink()
      && state.nlink === 1
      && state.size > 0
      && state.size <= maximumBytes,
    `${code}_NOT_BOUNDED_REGULAR_FILE`,
  );
  const [realFile, realRepository] = await Promise.all([
    realpath(resolved),
    realpath(path.resolve(repositoryRoot)),
  ]);
  invariant(samePath(realFile, resolved), `${code}_SYMLINK_PATH_REJECTED`);
  if (mustBeOutsideRepository) {
    invariant(isOutsideDirectory(realRepository, realFile), `${code}_MUST_BE_OUTSIDE_REPOSITORY`);
  }
  if (requiredParent !== null) {
    const realParent = await realpath(path.resolve(requiredParent));
    invariant(!isOutsideDirectory(realParent, realFile), `${code}_PATH_ESCAPE_REJECTED`);
  }

  let handle;
  try {
    handle = await open(realFile, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat();
    invariant(
      opened.isFile()
        && opened.nlink === 1
        && opened.size === state.size
        && opened.size > 0
        && opened.size <= maximumBytes
        && (state.dev === undefined || opened.dev === state.dev)
        && (state.ino === undefined || opened.ino === state.ino),
      `${code}_CHANGED_DURING_OPEN`,
    );
    const bytes = await handle.readFile();
    invariant(bytes.byteLength === opened.size, `${code}_SIZE_MISMATCH`);
    return Object.freeze({ bytes, path: realFile });
  } catch (error) {
    if (error instanceof LegacyBlobCutoverEvidenceError) throw error;
    fail(`${code}_UNREADABLE`, `${code} could not be opened safely.`, error);
  } finally {
    await handle?.close();
  }
}

function parseSidecar(source, expectedFileName, code) {
  const match = source.toString("utf8").trim().match(/^([a-f0-9]{64})  ([^\r\n]+)$/u);
  invariant(match && match[2] === expectedFileName, `${code}_INVALID`);
  return match[1];
}

async function readExternalHashedJson({
  code,
  expectedSha256,
  filePath,
  maximumBytes,
  repositoryRoot = process.cwd(),
}) {
  requireSha256(expectedSha256, `${code}_EXPECTED_DIGEST_INVALID`);
  const sidecarPath = `${filePath}.sha256`;
  const [document, sidecar] = await Promise.all([
    readBoundedRegularFile(filePath, {
      code,
      maximumBytes,
      mustBeOutsideRepository: true,
      repositoryRoot,
    }),
    readBoundedRegularFile(sidecarPath, {
      code: `${code}_SIDECAR`,
      maximumBytes: maximumSidecarBytes,
      mustBeOutsideRepository: true,
      repositoryRoot,
    }),
  ]);
  const digest = sha256(document.bytes);
  invariant(digest === expectedSha256, `${code}_EXPECTED_DIGEST_MISMATCH`);
  invariant(
    parseSidecar(sidecar.bytes, path.basename(document.path), `${code}_SIDECAR`) === digest,
    `${code}_SIDECAR_DIGEST_MISMATCH`,
  );
  let value;
  try {
    value = JSON.parse(document.bytes.toString("utf8"));
  } catch (error) {
    fail(`${code}_JSON_INVALID`, `${code} is not valid JSON.`, error);
  }
  return Object.freeze({ digest, value });
}

function assertJournalRecord(record) {
  invariant(record && typeof record === "object" && !Array.isArray(record), "BLOB_EVIDENCE_JOURNAL_RECORD_INVALID");
  invariant(
    Object.keys(record).every((key) => journalAllowedKeys.has(key)),
    "BLOB_EVIDENCE_JOURNAL_FIELD_REJECTED",
  );
  invariant(
    !/(?:https?:\/\/|postgres(?:ql)?:\/\/|vercel_blob_rw_|[?&](?:token|signature)=)/iu.test(JSON.stringify(record)),
    "BLOB_EVIDENCE_JOURNAL_SECRET_REJECTED",
  );
  return record;
}

export function parseLegacyBlobCutoverJournal(source) {
  const bytes = Buffer.isBuffer(source) ? source : Buffer.from(source ?? "");
  invariant(bytes.byteLength > 0 && bytes.byteLength <= maximumJournalBytes, "BLOB_EVIDENCE_JOURNAL_SIZE_INVALID");
  const records = [];
  for (const line of bytes.toString("utf8").split(/\r?\n/u)) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch (error) {
      fail("BLOB_EVIDENCE_JOURNAL_JSON_INVALID", "The cutover journal contains invalid JSON.", error);
    }
    records.push(assertJournalRecord(record));
  }
  invariant(records.length > 0 && records.length <= 50_000, "BLOB_EVIDENCE_JOURNAL_RECORD_COUNT_INVALID");
  return Object.freeze(records);
}

export async function readLegacyBlobCutoverJournalFile({
  journalPath,
  journalRoot,
  repositoryRoot = process.cwd(),
}) {
  const source = await readBoundedRegularFile(path.resolve(journalPath), {
    code: "BLOB_EVIDENCE_JOURNAL",
    maximumBytes: maximumJournalBytes,
    repositoryRoot,
    requiredParent: journalRoot,
  });
  return Object.freeze({
    journalSha256: sha256(source.bytes),
    records: parseLegacyBlobCutoverJournal(source.bytes),
    source: source.bytes,
  });
}

function validateCutoverJournal(records, cutoverConfig, targetFingerprint) {
  invariant(cutoverConfig?.previewTarget === "isolated-preview", "BLOB_EVIDENCE_PREVIEW_TARGET_REQUIRED");
  invariant(storeFingerprintPattern.test(cutoverConfig.sourceStoreFingerprint ?? ""), "BLOB_EVIDENCE_SOURCE_STORE_INVALID");
  invariant(storeFingerprintPattern.test(cutoverConfig.destinationStoreFingerprint ?? ""), "BLOB_EVIDENCE_TARGET_STORE_INVALID");
  invariant(
    cutoverConfig.sourceStoreFingerprint !== cutoverConfig.destinationStoreFingerprint,
    "BLOB_EVIDENCE_STORES_IDENTICAL",
  );
  const migrations = new Map();
  const finalized = new Map();
  for (const record of records) {
    invariant(record.version === 1 && record.runId === cutoverConfig.runId, "BLOB_EVIDENCE_JOURNAL_RUN_MISMATCH");
    invariant(
      record.sourceStoreFingerprint === cutoverConfig.sourceStoreFingerprint
        && record.destinationStoreFingerprint === cutoverConfig.destinationStoreFingerprint
        && record.targetFingerprint === targetFingerprint,
      "BLOB_EVIDENCE_JOURNAL_TARGET_MISMATCH",
    );
    requireIsoTimestamp(record.at, "BLOB_EVIDENCE_JOURNAL_TIME_INVALID");
    if (record.status === "migration-complete") {
      invariant(!migrations.has(record.assetKey), "BLOB_EVIDENCE_MIGRATION_DUPLICATED");
      requireSha256(record.assetKey, "BLOB_EVIDENCE_ASSET_KEY_INVALID");
      requireSha256(record.sha256, "BLOB_EVIDENCE_CONTENT_DIGEST_INVALID");
      invariant(
        Number.isSafeInteger(record.sizeBytes)
          && record.sizeBytes > 0
          && record.sizeBytes <= cutoverConfig.maximumBlobBytes
          && record.sourceRetained === true,
        "BLOB_EVIDENCE_MIGRATION_PROOF_INVALID",
      );
      requireIsoTimestamp(record.deleteNotBefore, "BLOB_EVIDENCE_DELETE_TIME_INVALID");
      migrations.set(record.assetKey, record);
    }
    if (["finalize-complete", "finalize-already-complete"].includes(record.status)) {
      invariant(!finalized.has(record.assetKey), "BLOB_EVIDENCE_FINALIZE_DUPLICATED");
      requireSha256(record.assetKey, "BLOB_EVIDENCE_ASSET_KEY_INVALID");
      requireSha256(record.sha256, "BLOB_EVIDENCE_CONTENT_DIGEST_INVALID");
      finalized.set(record.assetKey, record);
    }
  }
  invariant(
    migrations.size > 0 && migrations.size <= maximumObjects && finalized.size === migrations.size,
    "BLOB_EVIDENCE_FINALIZED_INVENTORY_INVALID",
  );
  for (const [assetKey, migration] of migrations) {
    const final = finalized.get(assetKey);
    invariant(
      final
        && final.sha256 === migration.sha256
        && final.sizeBytes === migration.sizeBytes
        && Date.parse(final.at) >= Date.parse(migration.deleteNotBefore),
      "BLOB_EVIDENCE_FINALIZE_PROOF_MISMATCH",
    );
  }
  return migrations;
}

function normalizePrivateAsset(asset, maximumBlobBytes) {
  const normalized = {
    id: String(asset?.id ?? ""),
    isPublic: asset?.isPublic === true,
    mimeType: String(asset?.mimeType ?? "application/octet-stream"),
    relativePath: String(asset?.relativePath ?? "").replaceAll("\\", "/"),
    sizeBytes: Number(asset?.sizeBytes),
    storageAccess: String(asset?.storageAccess ?? ""),
    storageProvider: String(asset?.storageProvider ?? ""),
    workspaceId: String(asset?.workspaceId ?? ""),
  };
  invariant(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(normalized.id)
      && normalized.workspaceId.length > 0
      && normalized.workspaceId.length <= 200,
    "BLOB_EVIDENCE_DATABASE_ASSET_IDENTITY_INVALID",
  );
  invariant(
    normalized.relativePath.length > 0
      && path.posix.normalize(normalized.relativePath) === normalized.relativePath
      && !normalized.relativePath.startsWith("/")
      && !normalized.relativePath.startsWith("../")
      && !normalized.relativePath.includes("/../")
      && !normalized.relativePath.includes("\0"),
    "BLOB_EVIDENCE_DATABASE_PATH_INVALID",
  );
  invariant(
    Number.isSafeInteger(normalized.sizeBytes)
      && normalized.sizeBytes > 0
      && normalized.sizeBytes <= maximumBlobBytes
      && normalized.isPublic === false
      && normalized.storageAccess === "private"
      && normalized.storageProvider === "vercel-blob",
    "BLOB_EVIDENCE_DATABASE_STATE_INVALID",
  );
  return Object.freeze(normalized);
}

function normalizeBlobRead(result, expectedPath, maximumBlobBytes) {
  invariant(result && typeof result === "object", "BLOB_EVIDENCE_TARGET_OBJECT_MISSING");
  const body = Buffer.isBuffer(result.body) ? result.body : Buffer.from(result.body ?? []);
  const sizeBytes = Number(result.sizeBytes);
  invariant(
    result.pathname === expectedPath
      && Number.isSafeInteger(sizeBytes)
      && sizeBytes > 0
      && sizeBytes <= maximumBlobBytes
      && body.byteLength === sizeBytes,
    "BLOB_EVIDENCE_TARGET_OBJECT_INVALID",
  );
  return Object.freeze({ body, sizeBytes });
}

function objectPathSha256(storeFingerprint, relativePath) {
  return sha256(canonicalJson({ relativePath, storeFingerprint }));
}

function databaseRowSha256(asset) {
  return sha256(canonicalJson({
    id: asset.id,
    isPublic: asset.isPublic,
    relativePath: asset.relativePath,
    sizeBytes: asset.sizeBytes,
    storageAccess: asset.storageAccess,
    storageProvider: asset.storageProvider,
    workspaceId: asset.workspaceId,
  }));
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function assertFinalProofShape(proof) {
  assertExactObjectKeys(proof, [
    "candidateCommit",
    "evidence",
    "evidenceDigest",
    "legacyObjectCountAfter",
    "legacyObjectCountBefore",
    "migratedObjectCount",
    "migrationReceipt",
    "productionMutationPerformed",
    "reasonCode",
    "status",
    "storeFingerprint",
  ], "BLOB_EVIDENCE_FINAL_PROOF");
}

export async function collectLegacyBlobCutoverProof({
  blob,
  clock = () => new Date(),
  cutoverConfig,
  database,
  expectedDraftEvidenceDigest = null,
  journal,
  migrationReceipt = null,
  observedAt = null,
  runtime,
  trustContext = null,
}) {
  invariant(blob && database && cutoverConfig, "BLOB_EVIDENCE_RUNTIME_ADAPTER_REQUIRED");
  validateExternalGateRuntimeBinding(runtime, runtime);
  invariant(runtime.productionMutationPerformed === false, "BLOB_EVIDENCE_PRODUCTION_MUTATION");
  invariant(
    journal && Buffer.isBuffer(journal.source),
    "BLOB_EVIDENCE_JOURNAL_SOURCE_REQUIRED",
  );
  const journalSha256 = requireSha256(
    journal.journalSha256,
    "BLOB_EVIDENCE_JOURNAL_DIGEST_INVALID",
  );
  invariant(
    sha256(journal.source) === journalSha256,
    "BLOB_EVIDENCE_JOURNAL_DIGEST_MISMATCH",
  );
  const journalRecords = parseLegacyBlobCutoverJournal(journal.source);
  const databaseIdentity = await database.verifyPreviewTarget();
  invariant(
    databaseIdentity?.branchId === runtime.databaseBranchId,
    "BLOB_EVIDENCE_DATABASE_BRANCH_MISMATCH",
  );
  const targetFingerprint = legacyBlobTargetFingerprint(databaseIdentity, cutoverConfig);
  const migrations = validateCutoverJournal(journalRecords, cutoverConfig, targetFingerprint);

  const remainingLegacyRows = await database.listLegacyAssets(maximumObjects + 1);
  invariant(Array.isArray(remainingLegacyRows) && remainingLegacyRows.length === 0, "BLOB_EVIDENCE_LEGACY_DATABASE_ROWS_REMAIN");
  const privateRows = await database.listPrivateAssets([...migrations.keys()], maximumObjects + 1);
  invariant(Array.isArray(privateRows) && privateRows.length === migrations.size, "BLOB_EVIDENCE_PRIVATE_ROW_COUNT_MISMATCH");
  const assets = privateRows
    .map((asset) => normalizePrivateAsset(asset, cutoverConfig.maximumBlobBytes))
    .sort((left, right) => legacyBlobAssetKey(left).localeCompare(legacyBlobAssetKey(right)));
  const assetKeys = assets.map(legacyBlobAssetKey);
  invariant(new Set(assetKeys).size === assets.length, "BLOB_EVIDENCE_PRIVATE_ASSET_DUPLICATED");
  invariant(assetKeys.every((assetKey) => migrations.has(assetKey)), "BLOB_EVIDENCE_PRIVATE_ASSET_INVENTORY_MISMATCH");

  const listedSourceObjects = await blob.listSourceObjects(maximumObjects + 1);
  invariant(Array.isArray(listedSourceObjects), "BLOB_EVIDENCE_SOURCE_LIST_INVALID");
  invariant(listedSourceObjects.length === 0, "BLOB_EVIDENCE_SOURCE_STORE_NOT_EMPTY");

  const sourceObjects = [];
  const targetObjects = [];
  const references = [];
  const rollbackArtifacts = [];
  for (const asset of assets) {
    const assetKeySha256 = legacyBlobAssetKey(asset);
    const migration = migrations.get(assetKeySha256);
    const [sourceRead, publicRead, targetRead] = await Promise.all([
      blob.readSource(asset.relativePath, cutoverConfig.maximumBlobBytes),
      blob.readSourcePublic(asset.relativePath),
      blob.readDestination(asset.relativePath, cutoverConfig.maximumBlobBytes),
    ]);
    invariant(sourceRead === null, "BLOB_EVIDENCE_SOURCE_AUTHENTICATED_READ_NOT_DENIED");
    invariant(
      Number.isSafeInteger(publicRead?.status) && deniedReadStatuses.has(publicRead.status),
      "BLOB_EVIDENCE_SOURCE_PUBLIC_READ_NOT_DENIED",
    );
    const target = normalizeBlobRead(targetRead, asset.relativePath, cutoverConfig.maximumBlobBytes);
    const targetContentSha256 = sha256(target.body);
    invariant(
      target.sizeBytes === migration.sizeBytes
        && asset.sizeBytes === migration.sizeBytes
        && targetContentSha256 === migration.sha256,
      "BLOB_EVIDENCE_TARGET_CONTENT_DRIFT",
    );
    const sourceObjectPathSha256 = objectPathSha256(
      cutoverConfig.sourceStoreFingerprint,
      asset.relativePath,
    );
    const targetObjectPathSha256 = objectPathSha256(
      cutoverConfig.destinationStoreFingerprint,
      asset.relativePath,
    );
    sourceObjects.push({
      assetKeySha256,
      contentSha256: migration.sha256,
      objectPathSha256: sourceObjectPathSha256,
      sizeBytes: migration.sizeBytes,
    });
    targetObjects.push({
      assetKeySha256,
      contentSha256: targetContentSha256,
      objectPathSha256: targetObjectPathSha256,
      sizeBytes: target.sizeBytes,
    });
    references.push({
      assetKeySha256,
      databaseRowSha256: databaseRowSha256(asset),
      targetObjectPathSha256,
    });
    rollbackArtifacts.push({
      assetKeySha256,
      contentSha256: migration.sha256,
      sizeBytes: migration.sizeBytes,
      sourceObjectPathSha256,
      targetObjectPathSha256,
    });
  }
  const sourceSummary = summarizeLegacyBlobObjectInventory(sourceObjects);
  const targetSummary = summarizeLegacyBlobObjectInventory(targetObjects);
  const effectiveObservedAt = observedAt ?? clock().toISOString();
  requireIsoTimestamp(effectiveObservedAt, "BLOB_EVIDENCE_OBSERVED_AT_INVALID");
  const now = clock();
  invariant(now instanceof Date && Number.isFinite(now.getTime()), "BLOB_EVIDENCE_CLOCK_INVALID");
  if (migrationReceipt !== null) {
    const age = now.getTime() - Date.parse(effectiveObservedAt);
    invariant(age >= 0 && age <= maximumDraftAgeMilliseconds, "BLOB_EVIDENCE_DRAFT_EXPIRED");
  }
  const evidence = {
    candidateCommit: runtime.candidateCommit,
    deploymentId: runtime.deploymentId,
    journalSha256,
    observedAt: effectiveObservedAt,
    oldStorePostcondition: {
      authenticatedReadDenied: true,
      listedObjectCount: 0,
      publicReadDenied: true,
    },
    recordType: "NOVALURE_PREVIEW_BLOB_LEGACY_MIGRATION_EVIDENCE",
    referenceCutover: {
      allReferencesTargetStore: true,
      referenceInventorySha256: sha256(canonicalJson(references)),
      references,
      rewrittenReferenceCount: references.length,
    },
    rollback: {
      artifactSha256: sha256(canonicalJson(rollbackArtifacts)),
      artifacts: rollbackArtifacts,
      status: "VERIFIED",
    },
    schemaVersion: 2,
    sourceInventory: {
      ...sourceSummary,
      objects: sourceObjects,
      storeFingerprint: cutoverConfig.sourceStoreFingerprint,
    },
    sourceStoreFingerprint: cutoverConfig.sourceStoreFingerprint,
    targetDatabaseBranchId: runtime.databaseBranchId,
    targetInventory: {
      ...targetSummary,
      objects: targetObjects,
      storeFingerprint: cutoverConfig.destinationStoreFingerprint,
    },
    targetStoreFingerprint: cutoverConfig.destinationStoreFingerprint,
  };
  const evidenceDigest = sha256(canonicalJson(evidence));
  if (expectedDraftEvidenceDigest !== null) {
    invariant(
      evidenceDigest === expectedDraftEvidenceDigest,
      "BLOB_EVIDENCE_DRAFT_RECHECK_MISMATCH",
    );
  }
  const complete = migrationReceipt !== null;
  const proof = {
    candidateCommit: runtime.candidateCommit,
    evidence,
    evidenceDigest,
    legacyObjectCountAfter: 0,
    legacyObjectCountBefore: sourceObjects.length,
    migratedObjectCount: targetObjects.length,
    migrationReceipt,
    productionMutationPerformed: false,
    reasonCode: complete ? null : "EXTERNAL_BLOB_MIGRATION_RECEIPT_REQUIRED",
    status: complete ? "VERIFIED" : "PENDING_EXTERNAL_RECEIPT",
    storeFingerprint: cutoverConfig.destinationStoreFingerprint,
  };
  assertFinalProofShape(proof);
  if (complete) {
    validateLegacyBlobMigrationProof({
      expectedCandidateCommit: runtime.candidateCommit,
      expectedDatabaseBranchId: runtime.databaseBranchId,
      expectedDeploymentId: runtime.deploymentId,
      expectedRuntime: runtime,
      expectedTargetStoreFingerprint: cutoverConfig.destinationStoreFingerprint,
      proof,
      requireReceipt: true,
      trustContext,
    });
  }
  return deepFreeze(proof);
}

export async function loadExternalBlobMigrationReceipt({
  expectedReceiptSha256,
  receiptPath,
  repositoryRoot = process.cwd(),
}) {
  const loaded = await readExternalHashedJson({
    code: "BLOB_EVIDENCE_RECEIPT",
    expectedSha256: expectedReceiptSha256,
    filePath: receiptPath,
    maximumBytes: maximumReceiptBytes,
    repositoryRoot,
  });
  return deepFreeze(loaded.value);
}

export async function loadExternalLegacyBlobDraft({
  draftPath,
  expectedDraftSha256,
  repositoryRoot = process.cwd(),
}) {
  const loaded = await readExternalHashedJson({
    code: "BLOB_EVIDENCE_DRAFT",
    expectedSha256: expectedDraftSha256,
    filePath: draftPath,
    maximumBytes: maximumProofBytes,
    repositoryRoot,
  });
  assertFinalProofShape(loaded.value);
  invariant(
    loaded.value.status === "PENDING_EXTERNAL_RECEIPT"
      && loaded.value.reasonCode === "EXTERNAL_BLOB_MIGRATION_RECEIPT_REQUIRED"
      && loaded.value.migrationReceipt === null
      && loaded.value.evidenceDigest === sha256(canonicalJson(loaded.value.evidence)),
    "BLOB_EVIDENCE_DRAFT_INVALID",
  );
  return deepFreeze(loaded.value);
}

export async function loadVerifiedLegacyBlobMigrationProof({
  expectedProofSha256,
  expectedTrustAnchorSha256,
  proofPath,
  repositoryRoot = process.cwd(),
  runtime,
  targetStoreFingerprint,
  trustAnchorPath,
}) {
  const [loaded, trustContext] = await Promise.all([
    readExternalHashedJson({
      code: "BLOB_EVIDENCE_PROOF",
      expectedSha256: expectedProofSha256,
      filePath: proofPath,
      maximumBytes: maximumProofBytes,
      repositoryRoot,
    }),
    loadExternalGateTrustContext({
      anchorPath: trustAnchorPath,
      expectedSha256: expectedTrustAnchorSha256,
      repositoryRoot,
      requiredRoles: [blobLegacyMigrationRole],
    }),
  ]);
  const proof = loaded.value;
  assertFinalProofShape(proof);
  invariant(proof.reasonCode === null, "BLOB_EVIDENCE_PROOF_REASON_PRESENT");
  validateLegacyBlobMigrationProof({
    expectedCandidateCommit: runtime.candidateCommit,
    expectedDatabaseBranchId: runtime.databaseBranchId,
    expectedDeploymentId: runtime.deploymentId,
    expectedRuntime: runtime,
    expectedTargetStoreFingerprint: targetStoreFingerprint,
    proof,
    requireReceipt: true,
    trustContext,
  });
  return deepFreeze(proof);
}

async function resolveSafeExternalOutput(outputPath, repositoryRoot) {
  invariant(typeof outputPath === "string" && path.isAbsolute(outputPath), "BLOB_EVIDENCE_OUTPUT_ABSOLUTE_PATH_REQUIRED");
  const resolved = path.resolve(outputPath);
  const parent = path.dirname(resolved);
  const [realParent, realRepository] = await Promise.all([
    realpath(parent),
    realpath(path.resolve(repositoryRoot)),
  ]);
  invariant(samePath(realParent, parent), "BLOB_EVIDENCE_OUTPUT_PARENT_SYMLINK_REJECTED");
  invariant(isOutsideDirectory(realRepository, realParent), "BLOB_EVIDENCE_OUTPUT_MUST_BE_OUTSIDE_REPOSITORY");
  return path.join(realParent, path.basename(resolved));
}

export async function writeExternalLegacyBlobProof({
  outputPath,
  proof,
  repositoryRoot = process.cwd(),
}) {
  assertFinalProofShape(proof);
  const target = await resolveSafeExternalOutput(outputPath, repositoryRoot);
  const source = Buffer.from(canonicalJson(proof), "utf8");
  invariant(source.byteLength > 0 && source.byteLength <= maximumProofBytes, "BLOB_EVIDENCE_OUTPUT_SIZE_INVALID");
  const digest = sha256(source);
  const sidecar = Buffer.from(`${digest}  ${path.basename(target)}\n`, "utf8");
  let documentHandle;
  let sidecarHandle;
  try {
    documentHandle = await open(
      target,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0),
      0o400,
    );
    await documentHandle.writeFile(source);
    sidecarHandle = await open(
      `${target}.sha256`,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0),
      0o400,
    );
    await sidecarHandle.writeFile(sidecar);
  } catch (error) {
    fail("BLOB_EVIDENCE_OUTPUT_WRITE_FAILED", "The external proof output could not be created immutably.", error);
  } finally {
    await Promise.all([documentHandle?.close(), sidecarHandle?.close()]);
  }
  return Object.freeze({ digest, path: target, sidecarPath: `${target}.sha256` });
}

export async function loadBlobMigrationTrustContext({
  expectedTrustAnchorSha256,
  repositoryRoot = process.cwd(),
  trustAnchorPath,
}) {
  return loadExternalGateTrustContext({
    anchorPath: trustAnchorPath,
    expectedSha256: expectedTrustAnchorSha256,
    repositoryRoot,
    requiredRoles: [blobLegacyMigrationRole],
  });
}

export async function ensureExternalOutputDirectory(directoryPath, repositoryRoot = process.cwd()) {
  invariant(typeof directoryPath === "string" && path.isAbsolute(directoryPath), "BLOB_EVIDENCE_OUTPUT_DIRECTORY_ABSOLUTE_REQUIRED");
  const repository = await realpath(path.resolve(repositoryRoot));
  const resolved = path.resolve(directoryPath);
  invariant(isOutsideDirectory(repository, resolved), "BLOB_EVIDENCE_OUTPUT_DIRECTORY_MUST_BE_EXTERNAL");
  await mkdir(resolved, { recursive: false, mode: 0o700 });
  return resolved;
}
