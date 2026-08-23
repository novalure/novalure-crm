import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createMemoryCutoverJournal,
  LegacyBlobCutoverError,
  resolvePreviewCutoverConfig,
  runLegacyBlobCutover,
} from "./lib/legacy-blob-cutover.mjs";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const sourceBody = Buffer.from("isolated-preview-legacy-blob-proof", "utf8");
const legacyAsset = Object.freeze({
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  isPublic: false,
  mimeType: "application/pdf",
  relativePath: `${workspaceId}/legacy-proof.pdf`,
  sizeBytes: sourceBody.byteLength,
  storageAccess: "legacy-public",
  storageProvider: "vercel-blob",
  workspaceId,
});

function makeConfig(overrides = {}) {
  return Object.freeze({
    confirmation: "",
    deleteDelayMs: 24 * 60 * 60 * 1_000,
    destinationStoreFingerprint: "sha256:destination-preview",
    execute: true,
    limit: 100,
    maximumBlobBytes: 1_024 * 1_024,
    mode: "migrate",
    notBefore: null,
    runId: "GOLIVEBLOB_TEST_20260823",
    sourceStoreFingerprint: "sha256:source-preview",
    ...overrides,
  });
}

function makeDatabase(overrides = {}) {
  const calls = {
    cas: 0,
    listLegacy: 0,
    listPrivate: 0,
    lock: 0,
    unlock: 0,
    verify: 0,
  };
  const database = {
    async acquireCutoverLock() {
      calls.lock += 1;
    },
    async compareAndSwapLegacyAsset() {
      calls.cas += 1;
      return { updated: true };
    },
    async listLegacyAssets() {
      calls.listLegacy += 1;
      return [structuredClone(legacyAsset)];
    },
    async listPrivateAssets() {
      calls.listPrivate += 1;
      return [{ ...structuredClone(legacyAsset), storageAccess: "private" }];
    },
    async releaseCutoverLock() {
      calls.unlock += 1;
    },
    async verifyPreviewTarget() {
      calls.verify += 1;
      return {
        branchId: "br-isolated-preview",
        databaseName: "novalure_preview",
        projectId: "project-isolated-preview",
        roleName: "preview_app",
      };
    },
    ...overrides,
  };
  return { calls, database };
}

function makeBlob(overrides = {}) {
  const destination = new Map();
  const source = new Map([[legacyAsset.relativePath, Buffer.from(sourceBody)]]);
  const calls = {
    deleteDestination: 0,
    deleteSource: 0,
    putDestination: 0,
    readDestination: 0,
    readSource: 0,
  };
  const blob = {
    async deleteDestination(pathname) {
      calls.deleteDestination += 1;
      destination.delete(pathname);
    },
    async deleteSource(pathname) {
      calls.deleteSource += 1;
      source.delete(pathname);
    },
    async putDestination(pathname, body) {
      calls.putDestination += 1;
      destination.set(pathname, Buffer.from(body));
      return { pathname };
    },
    async readDestination(pathname) {
      calls.readDestination += 1;
      const body = destination.get(pathname);
      return body
        ? { body: Buffer.from(body), contentType: legacyAsset.mimeType, pathname, sizeBytes: body.byteLength }
        : null;
    },
    async readSource(pathname) {
      calls.readSource += 1;
      const body = source.get(pathname);
      return body
        ? { body: Buffer.from(body), contentType: legacyAsset.mimeType, pathname, sizeBytes: body.byteLength }
        : null;
    },
    ...overrides,
  };
  return { blob, calls, destination, source };
}

function testBlobToken(storeId, suffix) {
  return ["vercel", "blob", "rw", storeId, `test-${suffix}`].join("_");
}

function makePreviewEnv(overrides = {}) {
  return {
    NOVALURE_LEGACY_BLOB_CUTOVER_TARGET: "isolated-preview",
    NOVALURE_LEGACY_BLOB_RUN_ID: "GOLIVEBLOB_CONFIG_20260823",
    NOVALURE_PREVIEW_PRIVATE_BLOB_READ_WRITE_TOKEN: testBlobToken("private123", "destination"),
    NOVALURE_PREVIEW_PRIVATE_BLOB_STORE_ID: "private123",
    NOVALURE_PREVIEW_PUBLIC_BLOB_READ_WRITE_TOKEN: testBlobToken("public123", "source"),
    NOVALURE_PREVIEW_PUBLIC_BLOB_STORE_ID: "public123",
    NOVALURE_PRODUCTION_DATABASE_HOST: "ep-production-pooler.eu-central-1.aws.neon.tech",
    NOVALURE_PRIVATE_BLOB_STORE_ID: "production-private",
    NOVALURE_PUBLIC_BLOB_STORE_ID: "production-public",
    NOVALURE_QA_ACTIVE_GIT_BRANCH: "codex/go-live-remediation-20260822",
    NOVALURE_QA_DATABASE_HOST: "ep-preview-pooler.eu-central-1.aws.neon.tech",
    NOVALURE_QA_DATABASE_URL: [
      "postgresql:/",
      "/preview_role:test-only@",
      "ep-preview-pooler.eu-central-1.aws.neon.tech/preview_main?sslmode=require",
    ].join(""),
    NOVALURE_QA_EXPECTED_GIT_BRANCH: "codex/go-live-remediation-20260822",
    VERCEL_ENV: "preview",
    ...overrides,
  };
}

async function expectCutoverCode(promise, expectedCode) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof LegacyBlobCutoverError);
    assert.equal(error.code, expectedCode);
    return true;
  });
}

test("dry-run inventories only legacy-public rows and performs no Blob or database mutation", async () => {
  const { calls: databaseCalls, database } = makeDatabase({
    async compareAndSwapLegacyAsset() {
      assert.fail("dry-run must not execute CAS");
    },
  });
  const { blob, calls: blobCalls } = makeBlob({
    async readSource() {
      assert.fail("dry-run must not read Blob content");
    },
  });
  const journal = createMemoryCutoverJournal();
  const result = await runLegacyBlobCutover({
    blob,
    config: makeConfig({ execute: false, mode: "migrate" }),
    database,
    journal,
  });

  assert.equal(result.dryRun, true);
  assert.equal(result.planned, 1);
  assert.equal(databaseCalls.listLegacy, 1);
  assert.equal(databaseCalls.lock, 0);
  assert.deepEqual(blobCalls, {
    deleteDestination: 0,
    deleteSource: 0,
    putDestination: 0,
    readDestination: 0,
    readSource: 0,
  });
  assert.deepEqual(journal.snapshot().map((record) => record.status), ["planned"]);
});

test("configuration rejects identical source and destination tokens by constant-time fingerprint", () => {
  const token = testBlobToken("public123", "same");
  assert.throws(
    () =>
      resolvePreviewCutoverConfig({
        env: makePreviewEnv({
          NOVALURE_PREVIEW_PRIVATE_BLOB_READ_WRITE_TOKEN: token,
          NOVALURE_PREVIEW_PUBLIC_BLOB_READ_WRITE_TOKEN: token,
        }),
      }),
    (error) => error instanceof LegacyBlobCutoverError && error.code === "BLOB_TOKENS_IDENTICAL",
  );
});

test("configuration rejects Production runtime, branch drift, shared stores, and Production store targets", () => {
  const scenarios = [
    [makePreviewEnv({ VERCEL_ENV: "production" }), "PREVIEW_TARGET_REQUIRED"],
    [makePreviewEnv({ NOVALURE_QA_ACTIVE_GIT_BRANCH: "main" }), "PREVIEW_BRANCH_MISMATCH"],
    [
      makePreviewEnv({
        NOVALURE_PREVIEW_PRIVATE_BLOB_READ_WRITE_TOKEN: testBlobToken("public123", "destination"),
        NOVALURE_PREVIEW_PRIVATE_BLOB_STORE_ID: "public123",
      }),
      "BLOB_STORES_IDENTICAL",
    ],
    [makePreviewEnv({ NOVALURE_PRIVATE_BLOB_STORE_ID: "private123" }), "PRODUCTION_BLOB_TARGET_REJECTED"],
  ];
  for (const [env, expectedCode] of scenarios) {
    assert.throws(
      () => resolvePreviewCutoverConfig({ env }),
      (error) => error instanceof LegacyBlobCutoverError && error.code === expectedCode,
    );
  }
});

test("connected Preview target failure occurs before inventory or Blob access", async () => {
  const { blob, calls: blobCalls } = makeBlob();
  const { database, calls } = makeDatabase({
    async verifyPreviewTarget() {
      calls.verify += 1;
      throw new LegacyBlobCutoverError("QA_DATABASE_TARGET_MISMATCH", "wrong target");
    },
  });
  await expectCutoverCode(
    runLegacyBlobCutover({ blob, config: makeConfig(), database, journal: createMemoryCutoverJournal() }),
    "QA_DATABASE_TARGET_MISMATCH",
  );
  assert.equal(calls.listLegacy, 0);
  assert.equal(blobCalls.readSource, 0);
});

test("source Get failure is journaled without Put, CAS, rollback, or source deletion", async () => {
  const { calls: databaseCalls, database } = makeDatabase();
  const { blob, calls } = makeBlob({
    async readSource() {
      calls.readSource += 1;
      throw new Error("sensitive source failure");
    },
  });
  const journal = createMemoryCutoverJournal();
  await expectCutoverCode(runLegacyBlobCutover({ blob, config: makeConfig(), database, journal }), "SOURCE_READ_FAILED");
  assert.equal(calls.putDestination, 0);
  assert.equal(calls.deleteDestination, 0);
  assert.equal(calls.deleteSource, 0);
  assert.equal(databaseCalls.cas, 0);
  assert.equal(journal.snapshot().at(-1).errorCode, "SOURCE_READ_FAILED");
});

test("private Put failure is journaled and never deletes the retained source", async () => {
  const { calls: databaseCalls, database } = makeDatabase();
  const { blob, calls } = makeBlob({
    async putDestination() {
      calls.putDestination += 1;
      throw new Error("put failed with https://forbidden.invalid/?token=secret");
    },
  });
  const journal = createMemoryCutoverJournal();
  await expectCutoverCode(
    runLegacyBlobCutover({ blob, config: makeConfig(), database, journal }),
    "DESTINATION_PUT_FAILED",
  );
  assert.equal(databaseCalls.cas, 0);
  assert.equal(calls.deleteDestination, 0);
  assert.equal(calls.deleteSource, 0);
  const serialized = JSON.stringify(journal.snapshot());
  assert.doesNotMatch(serialized, /https?:\/\/|token=|secret/iu);
});

test("destination Get failure rolls back only the private copy and preserves source metadata", async () => {
  const { calls: databaseCalls, database } = makeDatabase();
  const { blob, calls } = makeBlob({
    async readDestination() {
      calls.readDestination += 1;
      throw new Error("destination unavailable");
    },
  });
  const journal = createMemoryCutoverJournal();
  await expectCutoverCode(
    runLegacyBlobCutover({ blob, config: makeConfig(), database, journal }),
    "DESTINATION_READ_FAILED",
  );
  assert.equal(databaseCalls.cas, 0);
  assert.equal(calls.deleteDestination, 1);
  assert.equal(calls.deleteSource, 0);
  assert.deepEqual(journal.snapshot().slice(-3).map((record) => record.status), [
    "rollback-attempted",
    "rollback-complete",
    "migration-failed",
  ]);
});

test("hash or byte verification mismatch blocks CAS and rolls back the private copy", async () => {
  const { calls: databaseCalls, database } = makeDatabase();
  const { blob, calls } = makeBlob({
    async readDestination() {
      calls.readDestination += 1;
      const body = Buffer.from("corrupted-readback", "utf8");
      return { body, contentType: legacyAsset.mimeType, pathname: legacyAsset.relativePath, sizeBytes: body.byteLength };
    },
  });
  const journal = createMemoryCutoverJournal();
  await expectCutoverCode(
    runLegacyBlobCutover({ blob, config: makeConfig(), database, journal }),
    "DESTINATION_VERIFY_FAILED",
  );
  assert.equal(databaseCalls.cas, 0);
  assert.equal(calls.deleteDestination, 1);
  assert.equal(calls.deleteSource, 0);
});

test("CAS exception and CAS miss both roll back destination and retain the legacy source", async () => {
  for (const scenario of ["throw", "miss"]) {
    const { calls: databaseCalls, database } = makeDatabase({
      async compareAndSwapLegacyAsset() {
        databaseCalls.cas += 1;
        if (scenario === "throw") throw new Error("cas unavailable");
        return { alreadyApplied: false, updated: false };
      },
    });
    const { blob, calls } = makeBlob();
    const journal = createMemoryCutoverJournal();
    await expectCutoverCode(
      runLegacyBlobCutover({ blob, config: makeConfig(), database, journal }),
      scenario === "throw" ? "DATABASE_CAS_FAILED" : "DATABASE_CAS_MISS",
    );
    assert.equal(databaseCalls.cas, 1);
    assert.equal(calls.deleteDestination, 1);
    assert.equal(calls.deleteSource, 0);
  }
});

test("rollback failure is explicit and does not attempt destructive source compensation", async () => {
  const { database } = makeDatabase({
    async compareAndSwapLegacyAsset() {
      throw new Error("cas failed");
    },
  });
  const { blob, calls } = makeBlob({
    async deleteDestination() {
      calls.deleteDestination += 1;
      throw new Error("rollback failed");
    },
  });
  const journal = createMemoryCutoverJournal();
  await expectCutoverCode(
    runLegacyBlobCutover({ blob, config: makeConfig(), database, journal }),
    "DESTINATION_ROLLBACK_FAILED",
  );
  assert.equal(calls.deleteSource, 0);
  assert.equal(journal.snapshot().at(-1).status, "migration-failed-rollback-incomplete");
});

test("indeterminate CAS preserves the verified destination for journal-driven reconciliation", async () => {
  const { database } = makeDatabase({
    async compareAndSwapLegacyAsset() {
      throw new LegacyBlobCutoverError(
        "DATABASE_CAS_INDETERMINATE",
        "the database outcome is unknown",
      );
    },
  });
  const { blob, calls, destination } = makeBlob();
  const journal = createMemoryCutoverJournal();
  await expectCutoverCode(
    runLegacyBlobCutover({ blob, config: makeConfig(), database, journal }),
    "DATABASE_CAS_INDETERMINATE",
  );
  assert.equal(calls.deleteDestination, 0);
  assert.equal(calls.deleteSource, 0);
  assert.equal(destination.has(legacyAsset.relativePath), true);
  const record = journal.snapshot().at(-1);
  assert.equal(record.status, "migration-reconciliation-required");
  assert.match(record.sha256, /^[0-9a-f]{64}$/u);
});

test("successful migrate is resumable and idempotent, with no source delete in either pass", async () => {
  const { calls: databaseCalls, database } = makeDatabase();
  const { blob, calls } = makeBlob();
  const journal = createMemoryCutoverJournal();
  const first = await runLegacyBlobCutover({ blob, config: makeConfig(), database, journal });
  const firstCounts = structuredClone(calls);
  const second = await runLegacyBlobCutover({ blob, config: makeConfig(), database, journal });

  assert.equal(first.migrated, 1);
  assert.equal(second.alreadyComplete, 1);
  assert.equal(second.migrated, 0);
  assert.equal(databaseCalls.cas, 1);
  assert.deepEqual(calls, firstCounts);
  assert.equal(calls.deleteSource, 0);
  const completed = journal.snapshot().filter((record) => record.status === "migration-complete");
  assert.equal(completed.length, 1);
  assert.equal(completed[0].sourceRetained, true);
  assert.match(completed[0].sha256, /^[0-9a-f]{64}$/u);
});

test("resume reconciles a committed CAS when the process stopped before its completion journal", async () => {
  const firstDatabase = makeDatabase().database;
  const { blob, calls } = makeBlob();
  const completeJournal = createMemoryCutoverJournal();
  await runLegacyBlobCutover({ blob, config: makeConfig(), database: firstDatabase, journal: completeJournal });

  const interruptedRecords = completeJournal
    .snapshot()
    .filter((record) => record.status !== "migration-complete");
  assert.equal(interruptedRecords.at(-1).status, "destination-verified");
  const recoveryJournal = createMemoryCutoverJournal(interruptedRecords);
  const { database: recoveryDatabase } = makeDatabase();
  recoveryDatabase.listLegacyAssets = async () => [];
  recoveryDatabase.listPrivateAssets = async () => [
    { ...structuredClone(legacyAsset), storageAccess: "private" },
  ];
  recoveryDatabase.compareAndSwapLegacyAsset = async () => {
    assert.fail("recovery of a committed CAS must not issue another CAS");
  };

  const result = await runLegacyBlobCutover({
    blob,
    config: makeConfig(),
    database: recoveryDatabase,
    journal: recoveryJournal,
  });
  assert.equal(result.recovered, 1);
  assert.equal(result.migrated, 0);
  assert.equal(calls.deleteSource, 0);
  assert.equal(recoveryJournal.snapshot().at(-1).status, "migration-complete");
});

test("non-legacy rows are rejected defensively before any Blob call", async () => {
  const { calls, database } = makeDatabase({
    async listLegacyAssets() {
      calls.listLegacy += 1;
      return [{ ...structuredClone(legacyAsset), storageAccess: "private" }];
    },
  });
  const { blob, calls: blobCalls } = makeBlob();
  await expectCutoverCode(
    runLegacyBlobCutover({ blob, config: makeConfig(), database, journal: createMemoryCutoverJournal() }),
    "ASSET_SCOPE_REJECTED",
  );
  assert.equal(blobCalls.readSource, 0);
});

test("source deletion is possible only in delayed finalize with exact action confirmation", async () => {
  const migrationTime = new Date("2026-08-23T00:00:00.000Z");
  const finalizeTime = new Date("2026-08-25T00:00:00.000Z");
  const { database } = makeDatabase();
  const { blob, calls, source } = makeBlob();
  const journal = createMemoryCutoverJournal();
  await runLegacyBlobCutover({
    blob,
    clock: () => migrationTime,
    config: makeConfig(),
    database,
    journal,
  });

  const finalizePlan = await runLegacyBlobCutover({
    blob,
    clock: () => finalizeTime,
    config: makeConfig({ execute: false, mode: "finalize" }),
    database,
    journal,
  });
  assert.equal(finalizePlan.candidates, 1);
  assert.match(finalizePlan.confirmationRequired, /^FINALIZE_LEGACY_SOURCE_DELETE:GOLIVEBLOB_/u);
  assert.equal(calls.deleteSource, 0);

  await expectCutoverCode(
    runLegacyBlobCutover({
      blob,
      clock: () => finalizeTime,
      config: makeConfig({
        confirmation: "wrong-confirmation",
        execute: true,
        mode: "finalize",
        notBefore: finalizePlan.notBefore,
      }),
      database,
      journal,
    }),
    "FINALIZE_CONFIRMATION_REQUIRED",
  );
  assert.equal(calls.deleteSource, 0);

  const result = await runLegacyBlobCutover({
    blob,
    clock: () => finalizeTime,
    config: makeConfig({
      confirmation: finalizePlan.confirmationRequired,
      execute: true,
      mode: "finalize",
      notBefore: finalizePlan.notBefore,
    }),
    database,
    journal,
  });
  assert.equal(result.finalized, 1);
  assert.equal(calls.deleteSource, 1);
  assert.equal(source.has(legacyAsset.relativePath), false);
});
