import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

const require = createRequire(import.meta.url);

const mediaStoreSource = (await readFile(
  new URL("../src/lib/media-store.ts", import.meta.url),
  "utf8",
)).replace(/\r\n/g, "\n");
const mediaDeletionMigrationSource = (await readFile(
  new URL("../migrations/084_media_deletion_lifecycle.sql", import.meta.url),
  "utf8",
)).replace(/\r\n/g, "\n");
const migrationRunnerSource = (await readFile(
  new URL("../scripts/db-migrate.mjs", import.meta.url),
  "utf8",
)).replace(/\r\n/g, "\n");

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
    if (specifier === "@/lib/db/tenant-client") {
      return {
        withTenantTransaction: async (_context, callback) => {
          database.onTenantScope?.(_context);
          return callback({
          execute: database.executeQuery ?? (async () => undefined),
          queryOne: async (sql, params) => {
            if (database.transactionQueryOne) return database.transactionQueryOne(sql, params);
            if (/from crm_content_document_versions/i.test(sql)) return null;
            return (database.queryOne ?? (async () => null))(sql, params);
          },
          query: database.queryRows ?? (async () => []),
          });
        },
      };
    }
    if (specifier === "@/lib/broker-flow/access-policy") {
      return { canUseBrokerProjectEditScope: (session) => ["developer_sales", "project_sales_member"].includes(session.productRole) };
    }
    if (specifier === "@/lib/contact-access") {
      return { canViewAllWorkspaceContacts: (session) => session.role === "owner" || session.role === "admin" };
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
    if (specifier === "@/lib/product-model") {
      return { hasProductCapability: (_role, capability) => capability === "settings:manage" && false };
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

function actorSession(overrides = {}) {
  return {
    authenticated: true,
    email: "agent@example.test",
    name: "Agent",
    permissions: ["crm:read", "crm:write"],
    productPermissions: [],
    productRole: "broker_agent",
    role: "member",
    source: "database",
    userId: "33333333-3333-4333-8333-333333333333",
    workspaceId: blobAsset().workspaceId,
    workspaceName: "QA",
    ...overrides,
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

test("media deletion migration keeps row trigger variables inside trigger functions", () => {
  const constraintBlock = mediaDeletionMigrationSource.match(/do \$\$[\s\S]*?end \$\$;/i)?.[0] ?? "";
  const triggerFunction = mediaDeletionMigrationSource.match(
    /create or replace function public\.novalure_require_active_content_media\(\)[\s\S]*?\$\$;/i,
  )?.[0] ?? "";

  assert.ok(constraintBlock, "the idempotent constraint block must exist");
  assert.doesNotMatch(constraintBlock, /\bnew\./i);
  assert.match(triggerFunction, /new\.media_asset_id/i);
  assert.match(triggerFunction, /if new\.media_asset_id is null then[\s\S]*return new;/i);
  assert.match(triggerFunction, /deletion_state = 'active'[\s\S]*for share;/i);
  assert.doesNotMatch(triggerFunction, /for key share;/i);
  assert.match(triggerFunction, /return new;/i);
  assert.match(
    migrationRunnerSource,
    /\["084_media_deletion_lifecycle", \[[\s\S]*"007_bot_omnichannel_agents"[\s\S]*"034_property_department"[\s\S]*"082_content_library_privacy"/,
  );
  assert.match(
    mediaDeletionMigrationSource,
    /create or replace function public\.novalure_require_media_deletion_actor\(\)[\s\S]*actor\.id = new\.deletion_requested_by_user_id[\s\S]*actor\.workspace_id::text = new\.workspace_id/i,
  );
  assert.match(
    mediaDeletionMigrationSource,
    /create trigger media_assets_deletion_actor[\s\S]*before insert or update of created_by_user_id, deletion_state, deletion_requested_by_user_id, workspace_id/i,
  );
  assert.match(mediaDeletionMigrationSource, /creator\.id = new\.created_by_user_id[\s\S]*creator\.workspace_id::text = new\.workspace_id/i);
  assert.match(mediaDeletionMigrationSource, /old\.created_by_user_id is not null[\s\S]*creator attribution is immutable once established/i);
  assert.doesNotMatch(mediaDeletionMigrationSource, /tg_op = 'INSERT'[\s\S]{0,160}created_by_user_id is null/i);
});

test("publication serializes reference rebind and grant revoke before evaluating current ACL", async () => {
  const originalPreviewToken = process.env.NOVALURE_PREVIEW_PRIVATE_BLOB_READ_WRITE_TOKEN;
  const originalVercelEnv = process.env.VERCEL_ENV;
  process.env.VERCEL_ENV = "preview";
  process.env.NOVALURE_PREVIEW_PRIVATE_BLOB_READ_WRITE_TOKEN = "preview-test-token";

  try {
    const statements = [];
    const asset = blobAsset();
    const runtime = loadMediaStore({
      database: {
        transactionQueryOne: async (sql) => {
          statements.push(sql);
          if (/with locked_asset as materialized/i.test(sql)) return { ...asset, authorized: false };
          throw new Error("an unauthorized publication must not reach the share mutation");
        },
      },
    }).mediaStore;

    await assert.rejects(
      () => runtime.publishWorkspaceMedia(asset.id, actorSession()),
      (error) => error?.code === "MEDIA_ACCESS_REQUIRED",
    );
    assert.equal(statements.length, 1);
    assert.match(statements[0], /locked_asset as materialized[\s\S]*for update/i);
    assert.match(statements[0], /locked_property_media_refs as materialized[\s\S]*for share of media/i);
    assert.match(statements[0], /locked_property_document_refs as materialized[\s\S]*for share of document/i);
    assert.match(statements[0], /locked_content_refs as materialized[\s\S]*for share of version, document/i);
    assert.match(statements[0], /locked_project_grants as materialized[\s\S]*for share of project_grant, project_actor/i);
    assert.match(statements[0], /bool_and\(mutable\)/i);
  } finally {
    restoreEnv("NOVALURE_PREVIEW_PRIVATE_BLOB_READ_WRITE_TOKEN", originalPreviewToken);
    restoreEnv("VERCEL_ENV", originalVercelEnv);
  }
});

test("authorized publication and revocation keep the ACL decision and share write in one actor-bound transaction", async () => {
  const originalPreviewToken = process.env.NOVALURE_PREVIEW_PRIVATE_BLOB_READ_WRITE_TOKEN;
  const originalVercelEnv = process.env.VERCEL_ENV;
  process.env.VERCEL_ENV = "preview";
  process.env.NOVALURE_PREVIEW_PRIVATE_BLOB_READ_WRITE_TOKEN = "preview-test-token";

  try {
    const asset = blobAsset();
    const session = actorSession();
    const scopes = [];
    const statements = [];
    const runtime = loadMediaStore({
      database: {
        onTenantScope: (scope) => scopes.push(scope),
        transactionQueryOne: async (sql, params) => {
          statements.push({ params, sql });
          if (/with locked_asset as materialized/i.test(sql)) return { ...asset, authorized: true };
          if (/with published_asset as/i.test(sql)) {
            return {
              ...asset,
              hasActivePublicShare: true,
              isPublic: true,
              publicShareExpiresAt: "2026-09-03T00:00:00.000Z",
              publicShareId: "55555555-5555-4555-8555-555555555555",
            };
          }
          if (/with unpublished_asset as/i.test(sql)) return { ...asset, isPublic: false };
          throw new Error("unexpected statement");
        },
      },
    }).mediaStore;

    const published = await runtime.publishWorkspaceMedia(asset.id, session, { accessMode: "reuse" });
    assert.equal(published?.publicToken, "test-share-token");
    assert.equal(statements[0].params[6], true, "bot reuse must evaluate reusable rather than mutable ACL");
    assert.match(statements[1].sql, /insert into media_asset_shares/i);
    assert.equal(scopes[0].actorId, session.userId);
    assert.equal(scopes[0].workspaceId, session.workspaceId);

    statements.length = 0;
    const revoked = await runtime.revokeWorkspaceMediaPublication(asset.id, session);
    assert.equal(revoked?.isPublic, false);
    assert.match(statements[0].sql, /with locked_asset as materialized/i);
    assert.equal(statements[0].params[6], false, "manual revoke must use the mutation ACL");
    assert.match(statements[1].sql, /update media_asset_shares/i);
    assert.equal(scopes[1].actorId, session.userId);
    assert.equal(scopes[1].workspaceId, session.workspaceId);
  } finally {
    restoreEnv("NOVALURE_PREVIEW_PRIVATE_BLOB_READ_WRITE_TOKEN", originalPreviewToken);
    restoreEnv("VERCEL_ENV", originalVercelEnv);
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
        executeQuery: async (sql) => {
          if (/delete from media_assets/i.test(sql)) databaseDeletes += 1;
        },
        queryOne: async () => asset,
      },
    }).mediaStore;

    await assert.rejects(
      () => failed.deleteWorkspaceMedia(asset.id, asset.workspaceId, "33333333-3333-4333-8333-333333333333"),
      (error) => error?.code === "STORAGE_DELETE_FAILED",
    );
    assert.equal(databaseDeletes, 0, "metadata must remain retryable after Blob failure");

    const events = [];
    const succeeded = loadMediaStore({
      blob: { del: async () => { events.push("blob-delete"); } },
      database: {
        executeQuery: async (sql) => {
          if (/delete from media_assets/i.test(sql)) events.push("metadata-delete");
        },
        queryOne: async () => asset,
      },
    }).mediaStore;
    await succeeded.deleteWorkspaceMedia(
      asset.id,
      asset.workspaceId,
      "33333333-3333-4333-8333-333333333333",
    );
    assert.deepEqual(events, ["blob-delete", "metadata-delete"]);
  } finally {
    restoreEnv("NOVALURE_PREVIEW_PRIVATE_BLOB_READ_WRITE_TOKEN", originalPreviewToken);
    restoreEnv("VERCEL_ENV", originalVercelEnv);
  }
});

test("retrying an already-pending deletion never resurrects missing storage as active", async () => {
  const originalPreviewToken = process.env.NOVALURE_PREVIEW_PRIVATE_BLOB_READ_WRITE_TOKEN;
  const originalVercelEnv = process.env.VERCEL_ENV;
  process.env.VERCEL_ENV = "preview";
  process.env.NOVALURE_PREVIEW_PRIVATE_BLOB_READ_WRITE_TOKEN = "preview-test-token";

  try {
    let activeRestores = 0;
    const pendingAsset = {
      ...blobAsset(),
      deletionRequestedByUserId: "33333333-3333-4333-8333-333333333333",
      deletionState: "pending",
    };
    const runtime = loadMediaStore({
      blob: { del: async () => { throw new Error("transient retry failure"); } },
      database: {
        executeQuery: async (sql) => {
          if (/set deletion_state = 'active'/i.test(sql)) activeRestores += 1;
        },
        queryOne: async () => pendingAsset,
      },
    }).mediaStore;

    await assert.rejects(
      () => runtime.deleteWorkspaceMedia(
        pendingAsset.id,
        pendingAsset.workspaceId,
        "33333333-3333-4333-8333-333333333333",
      ),
      (error) => error?.code === "STORAGE_DELETE_FAILED",
    );
    assert.equal(activeRestores, 0);
  } finally {
    restoreEnv("NOVALURE_PREVIEW_PRIVATE_BLOB_READ_WRITE_TOKEN", originalPreviewToken);
    restoreEnv("VERCEL_ENV", originalVercelEnv);
  }
});

test("pending deletion retry is limited to the original actor or an explicit content manager", async () => {
  const originalPreviewToken = process.env.NOVALURE_PREVIEW_PRIVATE_BLOB_READ_WRITE_TOKEN;
  const originalVercelEnv = process.env.VERCEL_ENV;
  process.env.VERCEL_ENV = "preview";
  process.env.NOVALURE_PREVIEW_PRIVATE_BLOB_READ_WRITE_TOKEN = "preview-test-token";

  try {
    let blobDeletes = 0;
    const pendingAsset = {
      ...blobAsset(),
      deletionRequestedByUserId: "33333333-3333-4333-8333-333333333333",
      deletionState: "pending",
    };
    const runtime = loadMediaStore({
      blob: { del: async () => { blobDeletes += 1; } },
      database: { queryOne: async () => pendingAsset },
    }).mediaStore;

    await assert.rejects(
      () => runtime.deleteWorkspaceMedia(
        pendingAsset.id,
        pendingAsset.workspaceId,
        "44444444-4444-4444-8444-444444444444",
      ),
      (error) => error?.code === "MEDIA_ACCESS_REQUIRED",
    );
    assert.equal(blobDeletes, 0, "an unrelated actor must not reach storage deletion");

    await runtime.deleteWorkspaceMedia(
      pendingAsset.id,
      pendingAsset.workspaceId,
      "44444444-4444-4444-8444-444444444444",
      { canManagePendingDeletion: true },
    );
    assert.equal(blobDeletes, 1, "an explicitly authorised content manager may finish cleanup");
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
      () => runtime.saveWorkspaceFile({
        createdByUserId: "33333333-3333-4333-8333-333333333333",
        file,
        workspaceId: blobAsset().workspaceId,
      }),
      (error) => error?.code === "STORAGE_COMPENSATION_FAILED" && error?.cause instanceof AggregateError,
    );
    assert.equal(compensationCalls, 1);
  } finally {
    restoreEnv("NOVALURE_PREVIEW_PRIVATE_BLOB_READ_WRITE_TOKEN", originalPreviewToken);
    restoreEnv("VERCEL_ENV", originalVercelEnv);
  }
});
