import { createHash, timingSafeEqual } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import path from "node:path";
import {
  previewLegacyBlobStoreFingerprint,
  previewPrivateBlobStoreFingerprint,
} from "./blob-store-fingerprints.mjs";

const journalVersion = 1;
const minimumDeleteDelayMs = 24 * 60 * 60 * 1_000;
const maximumDeleteDelayMs = 90 * 24 * 60 * 60 * 1_000;
const defaultDeleteDelayMs = 7 * 24 * 60 * 60 * 1_000;
const defaultMaximumBlobBytes = 100 * 1_024 * 1_024;
const allowedJournalKeys = new Set([
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

export class LegacyBlobCutoverError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.code = code;
  }
}

function fail(code, message, cause) {
  return new LegacyBlobCutoverError(code, message, cause ? { cause } : undefined);
}

function clean(value) {
  return typeof value === "string" ? value.trim().replace(/^['"]|['"]$/g, "") : "";
}

function required(env, key) {
  const value = clean(env?.[key]);
  if (!value) throw fail("CONFIGURATION_MISSING", `${key} is required.`);
  return value;
}

function sha256(label, value) {
  return createHash("sha256").update(`${label}\0${value}`).digest("hex");
}

function publicFingerprint(label, value) {
  return `sha256:${sha256(label, value).slice(0, 20)}`;
}

function equalHex(left, right) {
  const leftBuffer = Buffer.from(left, "hex");
  const rightBuffer = Buffer.from(right, "hex");
  return leftBuffer.byteLength === rightBuffer.byteLength && timingSafeEqual(leftBuffer, rightBuffer);
}

function normalizeStoreId(value) {
  return clean(value).replace(/^store_/, "");
}

function storeIdFromReadWriteToken(token) {
  const segments = token.split("_");
  if (
    segments.length < 5 ||
    segments[0] !== "vercel" ||
    segments[1] !== "blob" ||
    segments[2] !== "rw" ||
    !segments[3]
  ) {
    throw fail("BLOB_TOKEN_INVALID", "A configured Blob token is not a Vercel read-write token.");
  }
  return segments[3];
}

function parsePositiveInteger(value, fallback, minimum, maximum, code) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw fail(code, "A numeric cutover limit is outside the allowed range.");
  }
  return parsed;
}

function defineSecret(target, key, value) {
  Object.defineProperty(target, key, {
    configurable: false,
    enumerable: false,
    value,
    writable: false,
  });
}

export function resolvePreviewCutoverConfig({ args = {}, env = process.env } = {}) {
  const runtimeEnvironment = required(env, "VERCEL_ENV").toLowerCase();
  if (runtimeEnvironment !== "preview") {
    throw fail("PREVIEW_TARGET_REQUIRED", "Legacy Blob cutover is restricted to Vercel Preview.");
  }
  if (required(env, "NOVALURE_LEGACY_BLOB_CUTOVER_TARGET") !== "isolated-preview") {
    throw fail("PREVIEW_TARGET_REQUIRED", "The isolated Preview cutover target declaration is invalid.");
  }

  const expectedBranch = required(env, "NOVALURE_QA_EXPECTED_GIT_BRANCH");
  const activeBranch = clean(env.VERCEL_GIT_COMMIT_REF) || required(env, "NOVALURE_QA_ACTIVE_GIT_BRANCH");
  if (activeBranch !== expectedBranch || !expectedBranch.startsWith("codex/")) {
    throw fail("PREVIEW_BRANCH_MISMATCH", "The active Preview branch does not match the declared QA branch.");
  }

  const runId = clean(args.runId) || required(env, "NOVALURE_LEGACY_BLOB_RUN_ID");
  if (!/^GOLIVEBLOB_[A-Za-z0-9_-]{8,80}$/.test(runId)) {
    throw fail("RUN_ID_INVALID", "The cutover run id is invalid.");
  }

  const sourceToken = required(env, "NOVALURE_PREVIEW_PUBLIC_BLOB_READ_WRITE_TOKEN");
  const destinationToken = required(env, "NOVALURE_PREVIEW_PRIVATE_BLOB_READ_WRITE_TOKEN");
  const sourceTokenHash = sha256("legacy-blob-token-equality:v1", sourceToken);
  const destinationTokenHash = sha256("legacy-blob-token-equality:v1", destinationToken);
  if (equalHex(sourceTokenHash, destinationTokenHash)) {
    throw fail("BLOB_TOKENS_IDENTICAL", "Source and destination Blob tokens must be different.");
  }

  const sourceStoreId = normalizeStoreId(required(env, "NOVALURE_PREVIEW_PUBLIC_BLOB_STORE_ID"));
  const destinationStoreId = normalizeStoreId(required(env, "NOVALURE_PREVIEW_PRIVATE_BLOB_STORE_ID"));
  if (!/^[A-Za-z0-9-]{6,128}$/.test(sourceStoreId) || !/^[A-Za-z0-9-]{6,128}$/.test(destinationStoreId)) {
    throw fail("BLOB_STORE_ID_INVALID", "A Preview Blob store id is invalid.");
  }
  if (sourceStoreId === destinationStoreId) {
    throw fail("BLOB_STORES_IDENTICAL", "Source and destination Blob stores must be different.");
  }
  if (
    storeIdFromReadWriteToken(sourceToken) !== sourceStoreId ||
    storeIdFromReadWriteToken(destinationToken) !== destinationStoreId
  ) {
    throw fail("BLOB_TOKEN_TARGET_MISMATCH", "A Blob token does not match its declared Preview store.");
  }

  const productionStoreIds = [
    normalizeStoreId(required(env, "NOVALURE_PUBLIC_BLOB_STORE_ID")),
    normalizeStoreId(required(env, "NOVALURE_PRIVATE_BLOB_STORE_ID")),
  ];
  if (productionStoreIds.some((storeId) => !/^[A-Za-z0-9-]{6,128}$/.test(storeId))) {
    throw fail("BLOB_STORE_ID_INVALID", "A declared Production Blob store id is invalid.");
  }
  if (productionStoreIds.includes(sourceStoreId) || productionStoreIds.includes(destinationStoreId)) {
    throw fail("PRODUCTION_BLOB_TARGET_REJECTED", "A Preview Blob target matches a declared Production store.");
  }

  const databaseUrl = required(env, "NOVALURE_QA_DATABASE_URL");
  let parsedDatabaseUrl;
  try {
    parsedDatabaseUrl = new URL(databaseUrl);
  } catch {
    throw fail("QA_DATABASE_URL_INVALID", "The QA database URL is invalid.");
  }
  if (!/^postgres(?:ql)?:$/.test(parsedDatabaseUrl.protocol)) {
    throw fail("QA_DATABASE_URL_INVALID", "The QA database URL must use PostgreSQL.");
  }
  const expectedQaHost = required(env, "NOVALURE_QA_DATABASE_HOST").toLowerCase();
  if (
    parsedDatabaseUrl.hostname.toLowerCase() !== expectedQaHost ||
    !expectedQaHost.includes("-pooler.")
  ) {
    throw fail("QA_DATABASE_TARGET_MISMATCH", "The QA database host is not the declared pooled Preview target.");
  }
  const productionHost = clean(env.NOVALURE_PRODUCTION_DATABASE_HOST).toLowerCase();
  if (productionHost && productionHost === expectedQaHost) {
    throw fail("PRODUCTION_DATABASE_TARGET_REJECTED", "The Preview database host matches Production.");
  }

  const requestedMode = clean(args.mode || "plan").toLowerCase();
  if (!new Set(["plan", "migrate", "finalize"]).has(requestedMode)) {
    throw fail("MODE_INVALID", "Cutover mode must be plan, migrate, or finalize.");
  }
  const execute = args.execute === true;
  if (requestedMode === "plan" && execute) {
    throw fail("MODE_INVALID", "Plan mode cannot be executed as a mutation.");
  }

  const limit = parsePositiveInteger(args.limit, 100, 1, 1_000, "LIMIT_INVALID");
  const maximumBlobBytes = parsePositiveInteger(
    args.maximumBlobBytes ?? env.NOVALURE_LEGACY_BLOB_MAXIMUM_BYTES,
    defaultMaximumBlobBytes,
    1,
    500 * 1_024 * 1_024,
    "MAXIMUM_BLOB_BYTES_INVALID",
  );
  const deleteDelayHours = parsePositiveInteger(
    args.deleteDelayHours ?? env.NOVALURE_LEGACY_BLOB_DELETE_DELAY_HOURS,
    defaultDeleteDelayMs / (60 * 60 * 1_000),
    minimumDeleteDelayMs / (60 * 60 * 1_000),
    maximumDeleteDelayMs / (60 * 60 * 1_000),
    "DELETE_DELAY_INVALID",
  );
  const notBefore = clean(args.notBefore);
  if (notBefore && !Number.isFinite(Date.parse(notBefore))) {
    throw fail("NOT_BEFORE_INVALID", "The finalize not-before timestamp is invalid.");
  }
  const normalizedNotBefore = notBefore ? new Date(Date.parse(notBefore)).toISOString() : null;

  const config = {
    activeBranchFingerprint: publicFingerprint("legacy-blob-active-branch:v1", activeBranch),
    confirmation: clean(args.confirmation),
    deleteDelayMs: deleteDelayHours * 60 * 60 * 1_000,
    destinationStoreFingerprint: previewPrivateBlobStoreFingerprint(destinationStoreId),
    execute,
    limit,
    maximumBlobBytes,
    mode: requestedMode,
    notBefore: normalizedNotBefore,
    previewTarget: "isolated-preview",
    runId,
    sourceStoreFingerprint: previewLegacyBlobStoreFingerprint(sourceStoreId),
  };
  defineSecret(config, "databaseUrl", databaseUrl);
  defineSecret(config, "destinationStoreId", destinationStoreId);
  defineSecret(config, "destinationToken", destinationToken);
  defineSecret(config, "sourceStoreId", sourceStoreId);
  defineSecret(config, "sourceToken", sourceToken);
  return Object.freeze(config);
}

export function resolveSafeJournalPath({ projectRoot = process.cwd(), requestedPath, runId }) {
  const journalRoot = path.resolve(projectRoot, "artifacts", "qa", "legacy-blob-cutover");
  const target = requestedPath
    ? path.resolve(projectRoot, requestedPath)
    : path.join(journalRoot, `${runId}.jsonl`);
  const relative = path.relative(journalRoot, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative) || !target.endsWith(".jsonl")) {
    throw fail("JOURNAL_PATH_REJECTED", "The journal path must stay inside the cutover artifact directory.");
  }
  return target;
}

function assertJournalRecord(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw fail("JOURNAL_INVALID", "A cutover journal record is invalid.");
  }
  for (const key of Object.keys(record)) {
    if (!allowedJournalKeys.has(key)) {
      throw fail("JOURNAL_REDACTION_FAILED", "A non-redacted field was rejected from the cutover journal.");
    }
  }
  const serialized = JSON.stringify(record);
  if (
    /(?:https?:\/\/|postgres(?:ql)?:\/\/|vercel_blob_rw_|[?&](?:token|signature)=)/iu.test(serialized)
  ) {
    throw fail("JOURNAL_REDACTION_FAILED", "Sensitive content was rejected from the cutover journal.");
  }
}

export function createFileCutoverJournal(filePath) {
  return Object.freeze({
    async append(record) {
      assertJournalRecord(record);
      await mkdir(path.dirname(filePath), { recursive: true });
      const handle = await open(filePath, "a", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
      } finally {
        await handle.close();
      }
    },
    async read() {
      let content;
      try {
        content = await readFile(filePath, "utf8");
      } catch (error) {
        if (error?.code === "ENOENT") return [];
        throw error;
      }
      const records = [];
      for (const line of content.split(/\r?\n/u)) {
        if (!line.trim()) continue;
        let record;
        try {
          record = JSON.parse(line);
        } catch {
          throw fail("JOURNAL_INVALID", "The cutover journal contains invalid JSON.");
        }
        assertJournalRecord(record);
        records.push(record);
      }
      return records;
    },
  });
}

export function createMemoryCutoverJournal(initialRecords = []) {
  const records = structuredClone(initialRecords);
  return Object.freeze({
    async append(record) {
      assertJournalRecord(record);
      records.push(structuredClone(record));
    },
    async read() {
      return structuredClone(records);
    },
    snapshot() {
      return structuredClone(records);
    },
  });
}

function assetKey(asset) {
  return sha256("legacy-blob-asset:v1", `${asset.workspaceId}\0${asset.id}`);
}

export function legacyBlobAssetKey(asset) {
  return assetKey(asset);
}

function sanitizeStorageSegment(value) {
  const sanitized = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 90);
  return sanitized || "media";
}

function assertSafeAsset(asset, maximumBlobBytes, expectedAccess) {
  const id = clean(asset?.id);
  const workspaceId = clean(asset?.workspaceId);
  const relativePath = clean(asset?.relativePath).replace(/\\/g, "/");
  const normalizedPath = path.posix.normalize(relativePath);
  const sizeBytes = Number(asset?.sizeBytes);
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(id) ||
    !workspaceId ||
    workspaceId.length > 200
  ) {
    throw fail("ASSET_IDENTITY_INVALID", "A media asset identity is invalid.");
  }
  if (
    !relativePath ||
    relativePath !== normalizedPath ||
    relativePath.startsWith("/") ||
    relativePath.includes("\0") ||
    relativePath.startsWith("../") ||
    relativePath.includes("/../") ||
    /^[a-z][a-z0-9+.-]*:/iu.test(relativePath) ||
    !relativePath.startsWith(`${sanitizeStorageSegment(workspaceId)}/`)
  ) {
    throw fail("ASSET_PATH_INVALID", "A media asset storage reference is invalid.");
  }
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0 || sizeBytes > maximumBlobBytes) {
    throw fail("ASSET_SIZE_INVALID", "A media asset size is outside the cutover limit.");
  }
  if (asset.storageProvider !== "vercel-blob" || asset.storageAccess !== expectedAccess) {
    throw fail("ASSET_SCOPE_REJECTED", "A media asset is outside the allowed storage-access scope.");
  }
  if (expectedAccess === "legacy-public" && asset.isPublic === true) {
    throw fail("PUBLISHED_ASSET_REJECTED", "An actively published asset cannot enter the private legacy cutover.");
  }
  return Object.freeze({
    id,
    isPublic: Boolean(asset.isPublic),
    mimeType: clean(asset.mimeType) || "application/octet-stream",
    relativePath,
    sizeBytes,
    storageAccess: asset.storageAccess,
    storageProvider: asset.storageProvider,
    workspaceId,
  });
}

function normalizeReadResult(result, errorCode, expectedPath) {
  if (!result) throw fail(errorCode, "A required Blob object was not found.");
  const body = Buffer.isBuffer(result.body) ? result.body : Buffer.from(result.body ?? []);
  const sizeBytes = Number(result.sizeBytes);
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes !== body.byteLength) {
    throw fail("BLOB_READ_SIZE_MISMATCH", "Blob metadata and downloaded bytes do not match.");
  }
  if (clean(result.pathname) !== expectedPath) {
    throw fail("BLOB_READ_PATH_MISMATCH", "Blob readback returned an unexpected pathname.");
  }
  return {
    body,
    contentType: clean(result.contentType) || "application/octet-stream",
    sizeBytes,
  };
}

function contentDigest(body) {
  return createHash("sha256").update(body).digest("hex");
}

function controlledFailure(error) {
  return {
    errorClass: String(error?.constructor?.name || "Error").replace(/[^A-Za-z0-9_$-]/gu, "").slice(0, 80) || "Error",
    errorCode: error instanceof LegacyBlobCutoverError ? error.code : "UNEXPECTED_FAILURE",
  };
}

async function appendEvent(journal, base, values) {
  const record = {
    ...base,
    ...values,
    version: journalVersion,
  };
  assertJournalRecord(record);
  await journal.append(record);
  return record;
}

function validateJournal(records, config, target) {
  for (const record of records) {
    assertJournalRecord(record);
    if (record.version !== journalVersion || record.runId !== config.runId) {
      throw fail("JOURNAL_RUN_MISMATCH", "The cutover journal belongs to a different run or version.");
    }
    if (
      record.sourceStoreFingerprint !== config.sourceStoreFingerprint ||
      record.destinationStoreFingerprint !== config.destinationStoreFingerprint ||
      record.targetFingerprint !== target
    ) {
      throw fail("JOURNAL_TARGET_MISMATCH", "The cutover journal belongs to different Blob targets.");
    }
  }
}

function completedMigrationRecords(records) {
  const completed = new Map();
  for (const record of records) {
    if (record.assetKey && record.status === "migration-complete") completed.set(record.assetKey, record);
  }
  return completed;
}

function incompleteVerifiedRecords(records) {
  const latest = new Map();
  for (const record of records) {
    if (record.assetKey) latest.set(record.assetKey, record);
  }
  return new Map(
    [...latest.entries()].filter(([, record]) =>
      ["destination-verified", "migration-reconciliation-required"].includes(record.status),
    ),
  );
}

function finalizedAssetKeys(records) {
  return new Set(
    records
      .filter((record) => record.assetKey && ["finalize-complete", "finalize-already-complete"].includes(record.status))
      .map((record) => record.assetKey),
  );
}

function targetFingerprint(databaseIdentity, config) {
  const safeIdentity = [
    clean(databaseIdentity?.projectId),
    clean(databaseIdentity?.branchId),
    clean(databaseIdentity?.databaseName),
    clean(databaseIdentity?.roleName),
  ].join("\0");
  if (!safeIdentity.replace(/\0/gu, "")) {
    throw fail("DATABASE_IDENTITY_MISSING", "The connected Preview database identity is unavailable.");
  }
  return publicFingerprint(
    "legacy-blob-target:v1",
    `${safeIdentity}\0${config.sourceStoreFingerprint}\0${config.destinationStoreFingerprint}`,
  );
}

export function legacyBlobTargetFingerprint(databaseIdentity, config) {
  return targetFingerprint(databaseIdentity, config);
}

function eventBase(config, target, now, mode) {
  return {
    at: now.toISOString(),
    destinationStoreFingerprint: config.destinationStoreFingerprint,
    mode,
    runId: config.runId,
    sourceStoreFingerprint: config.sourceStoreFingerprint,
    targetFingerprint: target,
  };
}

async function rollbackDestination({ asset, base, blob, journal }) {
  await appendEvent(journal, base, { assetKey: assetKey(asset), status: "rollback-attempted" });
  try {
    await blob.deleteDestination(asset.relativePath);
    await appendEvent(journal, base, { assetKey: assetKey(asset), status: "rollback-complete" });
    return null;
  } catch (error) {
    const failure = controlledFailure(error);
    await appendEvent(journal, base, {
      assetKey: assetKey(asset),
      ...failure,
      status: "rollback-failed",
    });
    return failure;
  }
}

async function migrateAsset({ asset, base, blob, clock, config, database, journal }) {
  const key = assetKey(asset);
  let destinationWasWritten = false;
  let verifiedProof = null;
  try {
    let source;
    try {
      source = normalizeReadResult(
        await blob.readSource(asset.relativePath, config.maximumBlobBytes),
        "SOURCE_BLOB_NOT_FOUND",
        asset.relativePath,
      );
    } catch (error) {
      if (error instanceof LegacyBlobCutoverError) throw error;
      throw fail("SOURCE_READ_FAILED", "The legacy source Blob read failed.", error);
    }
    if (source.sizeBytes !== asset.sizeBytes) {
      throw fail("SOURCE_METADATA_SIZE_MISMATCH", "Source Blob bytes do not match the database metadata.");
    }
    const sourceHash = contentDigest(source.body);
    verifiedProof = { sha256: sourceHash, sizeBytes: source.sizeBytes };
    await appendEvent(journal, base, {
      assetKey: key,
      sha256: sourceHash,
      sizeBytes: source.sizeBytes,
      status: "source-verified",
    });

    let putResult;
    try {
      putResult = await blob.putDestination(asset.relativePath, source.body, {
        contentType: source.contentType,
        maximumBlobBytes: config.maximumBlobBytes,
      });
      destinationWasWritten = true;
    } catch (error) {
      throw fail("DESTINATION_PUT_FAILED", "The private destination Blob write failed.", error);
    }
    if (clean(putResult?.pathname) !== asset.relativePath) {
      throw fail("DESTINATION_PATH_MISMATCH", "The private destination returned an unexpected pathname.");
    }
    await appendEvent(journal, base, {
      assetKey: key,
      sha256: sourceHash,
      sizeBytes: source.sizeBytes,
      status: "destination-written",
    });

    let destination;
    try {
      destination = normalizeReadResult(
        await blob.readDestination(asset.relativePath, config.maximumBlobBytes),
        "DESTINATION_BLOB_NOT_FOUND",
        asset.relativePath,
      );
    } catch (error) {
      if (error instanceof LegacyBlobCutoverError) throw error;
      throw fail("DESTINATION_READ_FAILED", "The private destination Blob readback failed.", error);
    }
    const destinationHash = contentDigest(destination.body);
    if (destination.sizeBytes !== source.sizeBytes || destinationHash !== sourceHash) {
      throw fail("DESTINATION_VERIFY_FAILED", "Private destination hash or byte size verification failed.");
    }
    await appendEvent(journal, base, {
      assetKey: key,
      sha256: sourceHash,
      sizeBytes: source.sizeBytes,
      status: "destination-verified",
    });

    let casResult;
    try {
      casResult = await database.compareAndSwapLegacyAsset(asset, {
        destinationPath: asset.relativePath,
        sha256: sourceHash,
        sizeBytes: source.sizeBytes,
      });
    } catch (error) {
      if (error instanceof LegacyBlobCutoverError && error.code === "DATABASE_CAS_INDETERMINATE") {
        throw error;
      }
      throw fail("DATABASE_CAS_FAILED", "The media metadata compare-and-swap failed.", error);
    }
    if (!casResult?.updated && !casResult?.alreadyApplied) {
      throw fail("DATABASE_CAS_MISS", "The media metadata changed before compare-and-swap.");
    }

    const completedAt = clock();
    const deleteNotBefore = new Date(completedAt.getTime() + config.deleteDelayMs).toISOString();
    await appendEvent(journal, { ...base, at: completedAt.toISOString() }, {
      assetKey: key,
      deleteNotBefore,
      sha256: sourceHash,
      sizeBytes: source.sizeBytes,
      sourceRetained: true,
      status: "migration-complete",
    });
    return { assetKey: key, status: casResult.alreadyApplied ? "already-applied" : "migrated" };
  } catch (error) {
    const requiresReconciliation =
      error instanceof LegacyBlobCutoverError && error.code === "DATABASE_CAS_INDETERMINATE";
    let rollbackFailure = null;
    if (destinationWasWritten && !requiresReconciliation) {
      rollbackFailure = await rollbackDestination({ asset, base, blob, journal });
    }
    const failure = controlledFailure(error);
    await appendEvent(journal, base, {
      assetKey: key,
      ...failure,
      ...(requiresReconciliation && verifiedProof ? verifiedProof : {}),
      status: requiresReconciliation
        ? "migration-reconciliation-required"
        : rollbackFailure
          ? "migration-failed-rollback-incomplete"
          : "migration-failed",
    });
    if (rollbackFailure) {
      throw fail("DESTINATION_ROLLBACK_FAILED", "Migration failed and destination rollback was incomplete.", error);
    }
    throw error;
  }
}

async function reconcileCommittedMigration({ asset, base, blob, clock, config, journal, proof }) {
  const key = assetKey(asset);
  try {
    const destination = normalizeReadResult(
      await blob.readDestination(asset.relativePath, config.maximumBlobBytes),
      "DESTINATION_BLOB_NOT_FOUND",
      asset.relativePath,
    );
    if (destination.sizeBytes !== proof.sizeBytes || contentDigest(destination.body) !== proof.sha256) {
      throw fail("DESTINATION_VERIFY_FAILED", "The recovered private destination does not match its proof.");
    }
    const completedAt = clock();
    await appendEvent(journal, { ...base, at: completedAt.toISOString() }, {
      assetKey: key,
      deleteNotBefore: new Date(completedAt.getTime() + config.deleteDelayMs).toISOString(),
      sha256: proof.sha256,
      sizeBytes: proof.sizeBytes,
      sourceRetained: true,
      status: "migration-complete",
    });
    return { assetKey: key, status: "recovered" };
  } catch (error) {
    await appendEvent(journal, base, {
      assetKey: key,
      ...controlledFailure(error),
      status: "recovery-failed",
    });
    throw error;
  }
}

function buildFinalizeConfirmationValue({ assetKeys, notBefore, runId, target }) {
  const digest = sha256(
    "legacy-blob-finalize-confirmation:v1",
    `${runId}\0${target}\0${notBefore}\0${[...assetKeys].sort().join("\0")}`,
  ).slice(0, 20);
  return `FINALIZE_LEGACY_SOURCE_DELETE:${runId}:${digest}`;
}

export function buildFinalizeConfirmation(values) {
  return buildFinalizeConfirmationValue(values);
}

async function finalizeAsset({ asset, base, blob, config, journal, migrationRecord }) {
  const key = assetKey(asset);
  try {
    const destination = normalizeReadResult(
      await blob.readDestination(asset.relativePath, config.maximumBlobBytes),
      "DESTINATION_BLOB_NOT_FOUND",
      asset.relativePath,
    );
    if (
      destination.sizeBytes !== migrationRecord.sizeBytes ||
      contentDigest(destination.body) !== migrationRecord.sha256
    ) {
      throw fail("DESTINATION_VERIFY_FAILED", "The private destination no longer matches the migration proof.");
    }

    const sourceResult = await blob.readSource(asset.relativePath, config.maximumBlobBytes);
    if (!sourceResult) {
      await appendEvent(journal, base, {
        assetKey: key,
        sha256: migrationRecord.sha256,
        sizeBytes: migrationRecord.sizeBytes,
        status: "finalize-already-complete",
      });
      return { assetKey: key, status: "already-finalized" };
    }
    const source = normalizeReadResult(sourceResult, "SOURCE_BLOB_NOT_FOUND", asset.relativePath);
    if (source.sizeBytes !== migrationRecord.sizeBytes || contentDigest(source.body) !== migrationRecord.sha256) {
      throw fail("SOURCE_CHANGED_AFTER_MIGRATION", "The retained source no longer matches the migration proof.");
    }

    try {
      await blob.deleteSource(asset.relativePath);
    } catch (error) {
      throw fail("SOURCE_DELETE_FAILED", "The authorized legacy source deletion failed.", error);
    }
    const readAfterDelete = await blob.readSource(asset.relativePath, config.maximumBlobBytes);
    if (readAfterDelete) {
      throw fail("SOURCE_DELETE_VERIFY_FAILED", "The legacy source remains readable after deletion.");
    }
    await appendEvent(journal, base, {
      assetKey: key,
      sha256: migrationRecord.sha256,
      sizeBytes: migrationRecord.sizeBytes,
      status: "finalize-complete",
    });
    return { assetKey: key, status: "finalized" };
  } catch (error) {
    await appendEvent(journal, base, {
      assetKey: key,
      ...controlledFailure(error),
      status: "finalize-failed",
    });
    throw error;
  }
}

export async function runLegacyBlobCutover({
  blob,
  clock = () => new Date(),
  config,
  database,
  journal,
}) {
  if (!config || !database || !journal) {
    throw fail("RUNTIME_ADAPTER_MISSING", "Cutover configuration and adapters are required.");
  }
  const databaseIdentity = await database.verifyPreviewTarget();
  const target = targetFingerprint(databaseIdentity, config);
  const records = await journal.read();
  validateJournal(records, config, target);
  const now = clock();
  const base = eventBase(config, target, now, config.mode);

  if (config.mode === "plan" || config.mode === "migrate") {
    if (config.mode === "plan" || !config.execute) {
      const assets = (await database.listLegacyAssets(config.limit)).map((asset) =>
        assertSafeAsset(asset, config.maximumBlobBytes, "legacy-public"),
      );
      const completed = completedMigrationRecords(records);
      const pending = assets.filter((asset) => !completed.has(assetKey(asset)));
      for (const asset of pending) {
        await appendEvent(journal, base, { assetKey: assetKey(asset), status: "planned" });
      }
      return Object.freeze({
        alreadyComplete: assets.length - pending.length,
        candidates: assets.length,
        dryRun: true,
        mode: config.mode,
        planned: pending.length,
        recoveryCandidates: incompleteVerifiedRecords(records).size,
        runId: config.runId,
        targetFingerprint: target,
      });
    }
    if (!blob) throw fail("RUNTIME_ADAPTER_MISSING", "Blob adapters are required for migration execution.");

    const migratedOutcomes = [];
    const recoveredOutcomes = [];
    let assets = [];
    let pending = [];
    await database.acquireCutoverLock();
    try {
      const lockedRecords = await journal.read();
      validateJournal(lockedRecords, config, target);
      const recoveryProofs = incompleteVerifiedRecords(lockedRecords);
      const recoveryAssets = (
        await database.listPrivateAssets([...recoveryProofs.keys()], config.limit)
      ).map((asset) => assertSafeAsset(asset, config.maximumBlobBytes, "private"));
      for (const asset of recoveryAssets) {
        const proof = recoveryProofs.get(assetKey(asset));
        if (!proof) continue;
        recoveredOutcomes.push(
          await reconcileCommittedMigration({ asset, base, blob, clock, config, journal, proof }),
        );
      }

      const reconciledRecords = await journal.read();
      validateJournal(reconciledRecords, config, target);
      assets = (await database.listLegacyAssets(config.limit)).map((asset) =>
        assertSafeAsset(asset, config.maximumBlobBytes, "legacy-public"),
      );
      const accountedRecoveryKeys = new Set([
        ...recoveryAssets.map(assetKey),
        ...assets.map(assetKey),
      ]);
      const unresolvedRecoveryKeys = [...recoveryProofs.keys()].filter(
        (key) => !accountedRecoveryKeys.has(key),
      );
      if (unresolvedRecoveryKeys.length) {
        for (const key of unresolvedRecoveryKeys) {
          await appendEvent(journal, base, {
            assetKey: key,
            errorClass: "LegacyBlobCutoverError",
            errorCode: "RECOVERY_DATABASE_STATE_MISSING",
            status: "recovery-failed",
          });
        }
        throw fail(
          "RECOVERY_DATABASE_STATE_MISSING",
          "An incomplete migration proof no longer matches legacy or private database state.",
        );
      }
      const completed = completedMigrationRecords(reconciledRecords);
      pending = assets.filter((asset) => !completed.has(assetKey(asset)));
      for (const asset of pending) {
        migratedOutcomes.push(await migrateAsset({ asset, base, blob, clock, config, database, journal }));
      }
    } finally {
      await database.releaseCutoverLock();
    }
    return Object.freeze({
      alreadyComplete: assets.length - pending.length,
      candidates: assets.length,
      dryRun: false,
      migrated: migratedOutcomes.filter((outcome) => outcome.status === "migrated").length,
      mode: config.mode,
      recovered: recoveredOutcomes.length,
      runId: config.runId,
      targetFingerprint: target,
    });
  }

  const completed = completedMigrationRecords(records);
  const finalized = finalizedAssetKeys(records);
  const privateAssets = (await database.listPrivateAssets([...completed.keys()], config.limit)).map((asset) =>
    assertSafeAsset(asset, config.maximumBlobBytes, "private"),
  );
  const candidates = privateAssets.filter((asset) => completed.has(assetKey(asset)) && !finalized.has(assetKey(asset)));
  const requiredNotBefore = candidates.reduce((latest, asset) => {
    const value = completed.get(assetKey(asset))?.deleteNotBefore;
    if (!value || !Number.isFinite(Date.parse(value))) {
      throw fail("FINALIZE_PROOF_INCOMPLETE", "A migration proof has no valid deletion delay.");
    }
    return !latest || Date.parse(value) > Date.parse(latest) ? value : latest;
  }, null);
  const effectiveNotBefore = config.notBefore || requiredNotBefore;
  if (candidates.length && (!effectiveNotBefore || Date.parse(effectiveNotBefore) < Date.parse(requiredNotBefore))) {
    throw fail("NOT_BEFORE_TOO_EARLY", "The requested deletion time precedes the migration retention window.");
  }
  const confirmationRequired = candidates.length
    ? buildFinalizeConfirmationValue({
        assetKeys: candidates.map(assetKey),
        notBefore: effectiveNotBefore,
        runId: config.runId,
        target,
      })
    : null;

  if (!config.execute) {
    for (const asset of candidates) {
      await appendEvent(journal, base, {
        assetKey: assetKey(asset),
        deleteNotBefore: effectiveNotBefore,
        status: "finalize-planned",
      });
    }
    return Object.freeze({
      candidates: candidates.length,
      confirmationRequired,
      dryRun: true,
      mode: config.mode,
      notBefore: effectiveNotBefore,
      runId: config.runId,
      targetFingerprint: target,
    });
  }
  if (!blob) throw fail("RUNTIME_ADAPTER_MISSING", "Blob adapters are required for finalize execution.");
  if (!candidates.length) {
    return Object.freeze({
      candidates: 0,
      dryRun: false,
      finalized: 0,
      mode: config.mode,
      runId: config.runId,
      targetFingerprint: target,
    });
  }
  if (!config.notBefore || config.confirmation !== confirmationRequired) {
    throw fail("FINALIZE_CONFIRMATION_REQUIRED", "Finalize requires the exact action-specific confirmation.");
  }
  if (now.getTime() < Date.parse(effectiveNotBefore)) {
    throw fail("FINALIZE_DELAY_ACTIVE", "The legacy source deletion retention window is still active.");
  }

  const outcomes = [];
  await database.acquireCutoverLock();
  try {
    for (const asset of candidates) {
      outcomes.push(
        await finalizeAsset({
          asset,
          base,
          blob,
          config,
          journal,
          migrationRecord: completed.get(assetKey(asset)),
        }),
      );
    }
  } finally {
    await database.releaseCutoverLock();
  }
  return Object.freeze({
    candidates: candidates.length,
    dryRun: false,
    finalized: outcomes.filter((outcome) => outcome.status === "finalized").length,
    mode: config.mode,
    runId: config.runId,
    targetFingerprint: target,
  });
}
