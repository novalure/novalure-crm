import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

const require = createRequire(import.meta.url);

const mediaStoreSource = await readFile(
  new URL("../src/lib/media-store.ts", import.meta.url),
  "utf8",
);

function functionSource(name) {
  const start = mediaStoreSource.indexOf(`function ${name}()`);
  assert.notEqual(start, -1, `${name} must exist`);
  const nextFunction = mediaStoreSource.indexOf("\nfunction ", start + 1);
  return mediaStoreSource.slice(start, nextFunction === -1 ? undefined : nextFunction);
}

function loadMediaStore({ blob = {}, database = {} } = {}) {
  class TestBlobNotFoundError extends Error {}
  const cjsModule = { exports: {} };
  const moduleRequire = (specifier) => {
    if (specifier.startsWith("node:")) return require(specifier);
    if (specifier === "@vercel/blob") {
      return {
        BlobNotFoundError: TestBlobNotFoundError,
        del: blob.del ?? (async () => undefined),
        get: blob.get ?? (async () => null),
        head: blob.head ?? (async () => ({ pathname: "unused" })),
        put: blob.put ?? (async (pathname) => ({ pathname })),
      };
    }
    if (specifier === "@/lib/db/client") {
      return {
        executeQuery: database.executeQuery ?? (async () => undefined),
        hasDatabaseUrl: () => true,
        queryOne: database.queryOne ?? (async () => null),
        queryRows: database.queryRows ?? (async () => []),
      };
    }
    if (specifier === "@/lib/launch-scope") {
      return {
        evaluateLaunchScope: () => process.env.VERCEL_ENV === "production"
          ? { allowed: false, code: "LAUNCH_SCOPE_UNSIGNED" }
          : { allowed: true },
      };
    }
    if (specifier === "@/lib/media-security") {
      return {
        createMediaShareToken: () => "test-share-token",
        hasExpectedMediaMagicBytes: () => true,
        hashMediaShareToken: () => "test-token-hash",
        mediaPublicShareScope: "media:public-read",
      };
    }
    return require(specifier);
  };
  const compiled = ts.transpileModule(mediaStoreSource, {
    compilerOptions: {
      esModuleInterop: true,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: "src/lib/media-store.ts",
  }).outputText;

  vm.runInNewContext(
    compiled,
    {
      AbortSignal,
      AggregateError,
      Blob,
      Buffer,
      Date,
      Error,
      File,
      JSON,
      Map,
      Math,
      Number,
      Object,
      Promise,
      Set,
      URL,
      console,
      exports: cjsModule.exports,
      module: cjsModule,
      process,
      require: moduleRequire,
    },
    { filename: "src/lib/media-store.ts" },
  );

  return { BlobNotFoundError: TestBlobNotFoundError, mediaStore: cjsModule.exports };
}

function blobAsset() {
  const workspaceId = "11111111-1111-4111-8111-111111111111";
  return {
    alt: "QA image",
    createdAt: new Date("2026-08-23T00:00:00.000Z"),
    folder: "media-uploads",
    hasActivePublicShare: false,
    id: "22222222-2222-4222-8222-222222222222",
    isPublic: false,
    mimeType: "image/png",
    name: "qa.png",
    originalName: "qa.png",
    relativePath: `${workspaceId}/media-uploads/qa.png`,
    sizeBytes: 16,
    storageAccess: "private",
    storageProvider: "vercel-blob",
    url: "/api/media/files/22222222-2222-4222-8222-222222222222",
    workspaceId,
  };
}

function restoreEnv(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

test("Vercel Preview private storage cannot fall back to a shared production token", () => {
  const source = functionSource("privateBlobToken");

  assert.match(source, /const environment = process\.env\.VERCEL_ENV[\s\S]*if \(environment === "preview"\)/);
  assert.match(source, /NOVALURE_PREVIEW_PRIVATE_BLOB_READ_WRITE_TOKEN/);
  assert.ok(
    source.indexOf("NOVALURE_PREVIEW_PRIVATE_BLOB_READ_WRITE_TOKEN") <
      source.indexOf("NOVALURE_PRIVATE_BLOB_READ_WRITE_TOKEN"),
  );
  assert.match(
    source,
    /if \(environment === "preview"\)[\s\S]*return process\.env\.NOVALURE_PREVIEW_PRIVATE_BLOB_READ_WRITE_TOKEN\?\.trim\(\) \|\| "";/,
  );
});

test("Vercel Preview public storage cannot fall back to a shared production token", () => {
  const source = functionSource("publicBlobToken");

  assert.match(source, /const environment = process\.env\.VERCEL_ENV[\s\S]*if \(environment === "preview"\)/);
  assert.match(source, /NOVALURE_PREVIEW_PUBLIC_BLOB_READ_WRITE_TOKEN/);
  assert.ok(
    source.indexOf("NOVALURE_PREVIEW_PUBLIC_BLOB_READ_WRITE_TOKEN") <
      source.indexOf("NOVALURE_PUBLIC_BLOB_READ_WRITE_TOKEN"),
  );
  assert.match(
    source,
    /if \(environment === "preview"\)[\s\S]*return process\.env\.NOVALURE_PREVIEW_PUBLIC_BLOB_READ_WRITE_TOKEN\?\.trim\(\) \|\| "";/,
  );
});

test("Production Blob credentials require the exact Production runtime", () => {
  for (const [name, productionToken] of [
    ["privateBlobToken", "NOVALURE_PRIVATE_BLOB_READ_WRITE_TOKEN"],
    ["publicBlobToken", "NOVALURE_PUBLIC_BLOB_READ_WRITE_TOKEN"],
  ]) {
    const source = functionSource(name);
    const productionBranch = source.indexOf('if (environment === "production")');
    assert.ok(productionBranch >= 0, `${name} must have an exact Production branch`);
    assert.ok(
      source.indexOf(productionToken) > productionBranch,
      `${name} must read its Production token only inside the exact Production branch`,
    );
    assert.match(source, /if \(environment === "production"\)[\s\S]*\n  }\n  return "";\n}/);
  }
});

test("Blob deletion keeps metadata when physical deletion fails and deletes metadata only after success", async () => {
  const asset = blobAsset();
  const originalPreviewToken = process.env.NOVALURE_PREVIEW_PRIVATE_BLOB_READ_WRITE_TOKEN;
  const originalVercelEnv = process.env.VERCEL_ENV;
  process.env.VERCEL_ENV = "preview";
  process.env.NOVALURE_PREVIEW_PRIVATE_BLOB_READ_WRITE_TOKEN = "preview-test-token";

  try {
    let databaseDeletes = 0;
    const failed = loadMediaStore({
      blob: { del: async () => { throw new Error("blob unavailable"); } },
      database: {
        executeQuery: async () => { databaseDeletes += 1; },
        queryOne: async () => asset,
      },
    }).mediaStore;

    await assert.rejects(
      () => failed.deleteWorkspaceMedia(asset.id, asset.workspaceId),
      (error) => error?.code === "STORAGE_DELETE_FAILED",
    );
    assert.equal(databaseDeletes, 0, "metadata must remain retryable after Blob failure");

    const events = [];
    const succeeded = loadMediaStore({
      blob: { del: async () => { events.push("blob-delete"); } },
      database: {
        executeQuery: async () => { events.push("metadata-delete"); },
        queryOne: async () => asset,
      },
    }).mediaStore;
    await succeeded.deleteWorkspaceMedia(asset.id, asset.workspaceId);
    assert.deepEqual(events, ["blob-delete", "metadata-delete"]);
  } finally {
    restoreEnv("NOVALURE_PREVIEW_PRIVATE_BLOB_READ_WRITE_TOKEN", originalPreviewToken);
    restoreEnv("VERCEL_ENV", originalVercelEnv);
  }
});

test("Blob existence performs a real metadata lookup and distinguishes not-found from provider failure", async () => {
  const asset = blobAsset();
  const originalPreviewToken = process.env.NOVALURE_PREVIEW_PRIVATE_BLOB_READ_WRITE_TOKEN;
  const originalVercelEnv = process.env.VERCEL_ENV;
  process.env.VERCEL_ENV = "preview";
  process.env.NOVALURE_PREVIEW_PRIVATE_BLOB_READ_WRITE_TOKEN = "preview-test-token";

  try {
    let headCalls = 0;
    const found = loadMediaStore({ blob: { head: async () => { headCalls += 1; return {}; } } }).mediaStore;
    assert.equal(await found.mediaAssetExists(asset), true);
    assert.equal(headCalls, 1);

    const missingRuntime = loadMediaStore({
      blob: {
        head: async () => {
          throw new missingRuntimeState.BlobNotFoundError("missing");
        },
      },
    });
    const missingRuntimeState = missingRuntime;
    assert.equal(await missingRuntime.mediaStore.mediaAssetExists(asset), false);

    const unavailable = loadMediaStore({ blob: { head: async () => { throw new Error("provider unavailable"); } } }).mediaStore;
    await assert.rejects(
      () => unavailable.mediaAssetExists(asset),
      (error) => error?.code === "STORAGE_READ_FAILED",
    );
  } finally {
    restoreEnv("NOVALURE_PREVIEW_PRIVATE_BLOB_READ_WRITE_TOKEN", originalPreviewToken);
    restoreEnv("VERCEL_ENV", originalVercelEnv);
  }
});

test("failed metadata persistence never hides a failed Blob compensation", async () => {
  const originalPreviewToken = process.env.NOVALURE_PREVIEW_PRIVATE_BLOB_READ_WRITE_TOKEN;
  const originalVercelEnv = process.env.VERCEL_ENV;
  process.env.VERCEL_ENV = "preview";
  process.env.NOVALURE_PREVIEW_PRIVATE_BLOB_READ_WRITE_TOKEN = "preview-test-token";

  try {
    let compensationCalls = 0;
    const runtime = loadMediaStore({
      blob: {
        del: async () => { compensationCalls += 1; throw new Error("compensation unavailable"); },
        put: async (pathname) => ({ pathname }),
      },
      database: {
        executeQuery: async () => { throw new Error("metadata unavailable"); },
        queryRows: async () => [],
      },
    }).mediaStore;
    const file = new File([new Uint8Array([137, 80, 78, 71])], "qa.png", { type: "image/png" });

    await assert.rejects(
      () => runtime.saveWorkspaceFile({ file, workspaceId: blobAsset().workspaceId }),
      (error) => error?.code === "STORAGE_COMPENSATION_FAILED" && error?.cause instanceof AggregateError,
    );
    assert.equal(compensationCalls, 1);
  } finally {
    restoreEnv("NOVALURE_PREVIEW_PRIVATE_BLOB_READ_WRITE_TOKEN", originalPreviewToken);
    restoreEnv("VERCEL_ENV", originalVercelEnv);
  }
});
