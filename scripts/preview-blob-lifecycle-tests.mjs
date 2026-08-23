import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertEvidenceSafe,
  canonicalJson,
  createPreviewBlobHttpClient,
  previewBlobLifecycleExecutionConfirmation,
  previewBlobMagicBytes,
  PreviewBlobLifecycleError,
  resolvePreviewBlobLifecycleConfig,
  runPreviewBlobLifecycle,
  validateShareUrl,
  writePreviewBlobLifecycleEvidence,
} from "./lib/preview-blob-lifecycle.mjs";
import { summarizeLegacyBlobObjectInventory } from "./lib/blob-legacy-migration-receipt.mjs";

const gitSha = "a".repeat(40);
const gitBranch = "codex/go-live-remediation-20260822";
const deploymentId = "dpl_1234567890ABCDEFGHIJ";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const userId = "22222222-2222-4222-8222-222222222222";
const crossTenantWorkspaceId = "44444444-4444-4444-8444-444444444444";
const crossTenantUserId = "55555555-5555-4555-8555-555555555555";
const baseOrigin = "https://novalure-preview-proof.vercel.app";

function previewEnv(overrides = {}) {
  return {
    NOVALURE_PRODUCTION_ORIGIN: "https://www.novalure-crm.app",
    NOVALURE_PREVIEW_PRIVATE_BLOB_READ_WRITE_TOKEN: "vercel_blob_rw_preview123_testcredential",
    NOVALURE_PREVIEW_PRIVATE_BLOB_STORE_ID: "store_preview123",
    NOVALURE_PRIVATE_BLOB_STORE_ID: "store_prodprivate123",
    NOVALURE_PUBLIC_BLOB_STORE_ID: "store_prodpublic123",
    NOVALURE_QA_ACTIVE_GIT_BRANCH: gitBranch,
    NOVALURE_QA_BASE_URL: baseOrigin,
    NOVALURE_QA_BLOB_LIFECYCLE_CONFIRM: previewBlobLifecycleExecutionConfirmation,
    NOVALURE_QA_BLOB_RUN_ID: "GOLIVEBLOBHTTP_TEST_20260823",
    NOVALURE_QA_BRANCH_ID: "br-isolatedpreview123",
    NOVALURE_QA_DEPLOYMENT_ID: deploymentId,
    NOVALURE_QA_EXPECTED_GIT_BRANCH: gitBranch,
    NOVALURE_QA_EXPECTED_GIT_SHA: gitSha,
    NOVALURE_QA_EXPECTED_HOST: new URL(baseOrigin).hostname,
    NOVALURE_QA_RESET_ADMIN_EMAIL: "codextest_preview_reset@example.test",
    NOVALURE_QA_RESET_ADMIN_PASSWORD: "qa-test-password-1234567890",
    NOVALURE_QA_RESET_ADMIN_TOTP_SECRET: "JBSWY3DPEHPK3PXP",
    NOVALURE_QA_TENANT_A_RESET_ACTOR_USER_ID: userId,
    NOVALURE_QA_TENANT_A_WORKSPACE_ID: workspaceId,
    NOVALURE_QA_TENANT_B_OWNER_EMAIL: "codextest_preview_tenant_b_owner@example.test",
    NOVALURE_QA_TENANT_B_OWNER_PASSWORD: "qa-tenant-b-password-1234567890",
    NOVALURE_QA_TENANT_B_OWNER_TOTP_SECRET: "KRSXG5DSNFXGOIDB",
    NOVALURE_QA_TENANT_B_OWNER_USER_ID: crossTenantUserId,
    NOVALURE_QA_TENANT_B_WORKSPACE_ID: crossTenantWorkspaceId,
    ...overrides,
  };
}

function resolveConfig(overrides = {}, options = {}) {
  return resolvePreviewBlobLifecycleConfig({
    env: previewEnv(overrides),
    execute: options.execute ?? true,
    projectRoot: options.projectRoot ?? process.cwd(),
  });
}

function legacyMigrationProof(config, overrides = {}) {
  const digest = (value) => createHash("sha256").update(value).digest("hex");
  const sourceStoreFingerprint = `sha256:${"2".repeat(20)}`;
  const sourceObjects = [0, 1, 2].map((index) => ({
    assetKeySha256: digest(`asset-${index}`),
    contentSha256: digest(`legacy-content-${index}`),
    objectPathSha256: digest(`legacy/source/${index}`),
    sizeBytes: 90 + (index * 10),
  })).sort((left, right) => left.assetKeySha256.localeCompare(right.assetKeySha256));
  const targetObjects = sourceObjects.map((entry) => ({
    ...entry,
    objectPathSha256: digest(`private/target/${entry.assetKeySha256}`),
  }));
  const sourceSummary = summarizeLegacyBlobObjectInventory(sourceObjects);
  const targetSummary = summarizeLegacyBlobObjectInventory(targetObjects);
  const references = targetObjects.map((entry) => ({
    assetKeySha256: entry.assetKeySha256,
    databaseRowSha256: digest(`database-row/${entry.assetKeySha256}`),
    targetObjectPathSha256: entry.objectPathSha256,
  }));
  const rollbackArtifacts = sourceObjects.map((entry) => {
    const target = targetObjects.find((candidate) => candidate.assetKeySha256 === entry.assetKeySha256);
    return {
      assetKeySha256: entry.assetKeySha256,
      contentSha256: entry.contentSha256,
      sizeBytes: entry.sizeBytes,
      sourceObjectPathSha256: entry.objectPathSha256,
      targetObjectPathSha256: target.objectPathSha256,
    };
  });
  const evidence = {
    candidateCommit: config.expectedGitSha,
    deploymentId: config.deploymentId,
    journalSha256: digest("bounded-legacy-cutover-journal"),
    observedAt: "2026-08-23T20:00:00.000Z",
    oldStorePostcondition: {
      authenticatedReadDenied: true,
      listedObjectCount: 0,
      publicReadDenied: true,
    },
    recordType: "NOVALURE_PREVIEW_BLOB_LEGACY_MIGRATION_EVIDENCE",
    referenceCutover: {
      allReferencesTargetStore: true,
      referenceInventorySha256: digest(canonicalJson(references)),
      references,
      rewrittenReferenceCount: 3,
    },
    rollback: {
      artifactSha256: digest(canonicalJson(rollbackArtifacts)),
      artifacts: rollbackArtifacts,
      status: "VERIFIED",
    },
    schemaVersion: 2,
    sourceInventory: {
      ...sourceSummary,
      objects: sourceObjects,
      storeFingerprint: sourceStoreFingerprint,
    },
    sourceStoreFingerprint,
    targetDatabaseBranchId: config.expectedDatabaseBranchId,
    targetInventory: {
      ...targetSummary,
      objects: targetObjects,
      storeFingerprint: config.independentBlob.storeFingerprint,
    },
    targetStoreFingerprint: config.independentBlob.storeFingerprint,
  };
  return {
    candidateCommit: config.expectedGitSha,
    evidence,
    evidenceDigest: createHash("sha256").update(canonicalJson(evidence)).digest("hex"),
    legacyObjectCountAfter: 0,
    legacyObjectCountBefore: 3,
    migratedObjectCount: 3,
    productionMutationPerformed: false,
    status: "VERIFIED",
    storeFingerprint: config.independentBlob.storeFingerprint,
    ...overrides,
  };
}

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json", ...headers },
    status,
  });
}

function redirect(location = "/", cookie = null) {
  const headers = { location };
  if (cookie) headers["set-cookie"] = cookie;
  return new Response(null, { headers, status: 303 });
}

function expectedMarkerIdentity() {
  const marker = createHash("sha256")
    .update(`preview-private-blob-lifecycle:v1\0${previewEnv().NOVALURE_QA_BLOB_RUN_ID}\0${gitSha}`)
    .digest("hex")
    .slice(0, 20);
  return {
    fileName: `qa-private-${marker}.png`,
    folder: "qa-private-lifecycle",
    name: `QA private Blob ${marker}`,
  };
}

function createLifecycleServer({
  assetAccess = "private",
  capabilityBranch = gitBranch,
  capabilityDatabaseBranch = "br-isolatedpreview123",
  capabilityDeploymentHost = new URL(baseOrigin).hostname,
  capabilityDeploymentId = deploymentId,
  capabilitySha = gitSha,
  preexistingMatchingMarker = false,
} = {}) {
  const calls = [];
  let markerIdentity = preexistingMatchingMarker ? expectedMarkerIdentity() : null;
  let asset = preexistingMatchingMarker
    ? {
        accessClass: "private",
        alt: markerIdentity.name,
        createdAt: "2026-08-22T00:00:00.000Z",
        folder: markerIdentity.folder,
        hasActivePublicShare: false,
        id: "66666666-6666-4666-8666-666666666666",
        isPublic: false,
        mimeType: "image/png",
        name: markerIdentity.name,
        originalName: markerIdentity.fileName,
        publicUrl: null,
        sizeBytes: previewBlobMagicBytes.byteLength,
        url: "/api/media/files/66666666-6666-4666-8666-666666666666",
      }
    : null;
  let csrfBinding = null;
  let deleted = false;

  function sessionKind(headers) {
    const value = headers.get("cookie") ?? "";
    if (value.includes("novalure_session=session-a")) return "a";
    if (value.includes("novalure_session=session-b")) return "b";
    return null;
  }

  async function fetchImpl(input, init = {}) {
    const url = new URL(input);
    const method = String(init.method ?? "GET").toUpperCase();
    const headers = new Headers(init.headers ?? {});
    const request = { method, pathname: url.pathname };
    calls.push(request);

    if (url.pathname === "/" && method === "GET") {
      return new Response("<!doctype html><title>Preview</title>", {
        headers: { "content-type": "text/html; charset=utf-8" },
        status: 200,
      });
    }
    if (url.pathname === "/api/auth/login" && method === "POST") {
      assert.ok(init.body instanceof URLSearchParams);
      const email = init.body.get("email");
      if (email === previewEnv().NOVALURE_QA_RESET_ADMIN_EMAIL) {
        assert.equal(init.body.get("password"), previewEnv().NOVALURE_QA_RESET_ADMIN_PASSWORD);
        return redirect("/", "novalure_session=session-a; Path=/; HttpOnly; Secure");
      }
      assert.equal(email, previewEnv().NOVALURE_QA_TENANT_B_OWNER_EMAIL);
      assert.equal(init.body.get("password"), previewEnv().NOVALURE_QA_TENANT_B_OWNER_PASSWORD);
      return redirect("/", "novalure_session=session-b; Path=/; HttpOnly; Secure");
    }
    if (url.pathname === "/api/auth/session" && method === "GET") {
      return sessionKind(headers) === "b"
        ? json({ user: { id: crossTenantUserId }, workspace: { id: crossTenantWorkspaceId } })
        : json({ user: { id: userId }, workspace: { id: workspaceId } });
    }
    if (url.pathname === "/api/admin/qa-batch-capability" && method === "GET") {
      return json({
        atomicRegistration: true,
        databaseBranchId: capabilityDatabaseBranch,
        deploymentHost: capabilityDeploymentHost,
        deploymentId: capabilityDeploymentId,
        gitBranch: capabilityBranch,
        gitSha: capabilitySha,
        version: 2,
      });
    }
    if (url.pathname === "/api/auth/csrf" && method === "GET") {
      const boundMethod = url.searchParams.get("method");
      const boundPath = url.searchParams.get("path");
      assert.ok(["DELETE", "POST"].includes(boundMethod));
      assert.ok(boundPath === "/api/media" || /^\/api\/media\/[0-9a-f-]{36}$/iu.test(boundPath) || boundPath === "/api/auth/logout");
      csrfBinding = `${boundMethod}\0${boundPath}`;
      return json({ csrfToken: `csrf-${createHash("sha256").update(csrfBinding).digest("hex")}` });
    }
    if (url.pathname === "/api/media" && method === "GET") {
      if (!sessionKind(headers)) return json({ error: "unauthorized" }, 401);
      if (sessionKind(headers) === "b") return json({ assets: [], quota: {} });
      return json({ assets: asset && !deleted ? [asset] : [], quota: {} });
    }
    if (url.pathname === "/api/media" && method === "POST") {
      assert.equal(csrfBinding, "POST\0/api/media");
      const expectedCsrf = `csrf-${createHash("sha256").update(csrfBinding).digest("hex")}`;
      assert.equal(headers.get("x-novalure-csrf-token"), expectedCsrf);
      assert.ok(init.body instanceof FormData);
      assert.equal(init.body.has("public"), false, "the private lifecycle must never request publication");
      const file = init.body.get("file");
      assert.ok(file instanceof File);
      assert.equal(file.type, "image/png");
      assert.equal(Buffer.compare(Buffer.from(await file.arrayBuffer()), previewBlobMagicBytes), 0);
      markerIdentity = {
        fileName: file.name,
        folder: init.body.get("folder"),
        name: init.body.get("name"),
      };
      const id = "33333333-3333-4333-8333-333333333333";
      asset = {
        accessClass: assetAccess,
        alt: init.body.get("alt"),
        createdAt: "2026-08-23T00:00:00.000Z",
        folder: markerIdentity.folder,
        hasActivePublicShare: false,
        id,
        isPublic: false,
        mimeType: "image/png",
        name: markerIdentity.name,
        originalName: markerIdentity.fileName,
        publicUrl: null,
        sizeBytes: previewBlobMagicBytes.byteLength,
        url: `/api/media/files/${id}`,
      };
      return json({ asset, quota: {} }, 201);
    }
    if (/^\/api\/media\/files\/[0-9a-f-]{36}$/iu.test(url.pathname) && method === "GET") {
      if (!sessionKind(headers)) return json({ error: "unauthorized" }, 401);
      if (sessionKind(headers) === "b") return json({ error: "not found" }, 404);
      if (deleted || !asset) return json({ error: "not found" }, 404);
      return new Response(previewBlobMagicBytes, {
        headers: {
          "cache-control": "private, no-store",
          "content-disposition": `inline; filename="${markerIdentity.fileName}"`,
          "content-length": String(previewBlobMagicBytes.byteLength),
          "content-type": "image/png",
          "cross-origin-resource-policy": "same-origin",
          "x-content-type-options": "nosniff",
        },
        status: 200,
      });
    }
    if (/^\/api\/media\/[0-9a-f-]{36}$/iu.test(url.pathname) && method === "DELETE") {
      assert.equal(sessionKind(headers), "a");
      assert.equal(csrfBinding, `DELETE\0${url.pathname}`);
      assert.equal(assetAccess, "private", "a non-private asset must never reach DELETE");
      deleted = true;
      return json({ deleted: { id: asset.id, name: asset.name } });
    }
    if (url.pathname === "/api/auth/logout" && method === "POST") {
      assert.equal(csrfBinding, "POST\0/api/auth/logout");
      return redirect("/login", "novalure_session=; Path=/; Max-Age=0");
    }
    throw new Error(`Unexpected fake request: ${method} ${url.pathname}`);
  }

  return { calls, fetchImpl, state: () => ({ asset, deleted }) };
}

function createBlobInspector(server) {
  const pathname = `${workspaceId}/qa-private-lifecycle/private-proof-object.png`;
  return {
    async headPath(requestedPath) {
      const state = server.state();
      if (requestedPath !== pathname || !state.asset || state.deleted) return null;
      return { contentType: "image/png", pathname, size: previewBlobMagicBytes.byteLength };
    },
    async listPrefix(prefix) {
      assert.equal(prefix, `${workspaceId}/qa-private-lifecycle/`);
      const state = server.state();
      return state.asset && !state.deleted
        ? [{ contentType: "image/png", pathname, size: previewBlobMagicBytes.byteLength }]
        : [];
    },
  };
}

test("config binds one exact Preview origin, SHA, branch and deployment without enumerable credentials", () => {
  const config = resolveConfig();
  assert.equal(config.expectedGitSha, gitSha);
  assert.equal(config.expectedGitBranch, gitBranch);
  assert.equal(config.deploymentId, deploymentId);
  assert.equal(config.baseOrigin, baseOrigin);
  assert.equal(config.actor.workspaceId, workspaceId);
  const serialized = JSON.stringify(config);
  assert.doesNotMatch(serialized, /example\.test|qa-test-password|JBSWY3/u);
  assert.equal(Object.keys(config).includes("actor"), false);
  assert.equal(Object.keys(config).includes("baseOrigin"), false);
});

test("config rejects Production, non-exact origins, branch drift, invalid SHA and missing execution confirmation", () => {
  const scenarios = [
    [{ NOVALURE_QA_BASE_URL: "https://www.novalure-crm.app", NOVALURE_QA_EXPECTED_HOST: "www.novalure-crm.app" }, "PREVIEW_HOST_REQUIRED"],
    [{ NOVALURE_QA_BASE_URL: `${baseOrigin}/` }, "ORIGIN_INVALID"],
    [{ NOVALURE_QA_BASE_URL: `https://user:pass@${new URL(baseOrigin).hostname}` }, "ORIGIN_INVALID"],
    [{ NOVALURE_QA_ACTIVE_GIT_BRANCH: "main" }, "PREVIEW_BRANCH_MISMATCH"],
    [{ NOVALURE_QA_EXPECTED_GIT_BRANCH: "main", NOVALURE_QA_ACTIVE_GIT_BRANCH: "main" }, "PREVIEW_BRANCH_MISMATCH"],
    [{ NOVALURE_QA_EXPECTED_GIT_SHA: "abc123" }, "GIT_SHA_INVALID"],
    [{ NOVALURE_QA_BLOB_LIFECYCLE_CONFIRM: "" }, "EXECUTION_CONFIRMATION_REQUIRED"],
  ];
  for (const [overrides, code] of scenarios) {
    assert.throws(
      () => resolveConfig(overrides),
      (error) => error instanceof PreviewBlobLifecycleError && error.code === code,
    );
  }
});

test("share access accepts only one exact Preview or Vercel-landing stdin-shaped query", () => {
  const valid = `${baseOrigin}/?_vercel_share=abcdefghijklmnopqrstuvwxyz012345`;
  assert.equal(validateShareUrl(valid, baseOrigin)?.href, valid);
  const landing = "https://vercel.com/share/proof?_vercel_share=abcdefghijklmnopqrstuvwxyz012345";
  assert.equal(validateShareUrl(landing, baseOrigin)?.href, landing);
  for (const value of [
    "https://other.vercel.app/?_vercel_share=abcdefghijklmnopqrstuvwxyz012345",
    `${baseOrigin}/path?_vercel_share=abcdefghijklmnopqrstuvwxyz012345`,
    `${baseOrigin}/?_vercel_share=short`,
    `${baseOrigin}/?_vercel_share=abcdefghijklmnopqrstuvwxyz012345&next=/`,
    `${baseOrigin}/?token=abcdefghijklmnopqrstuvwxyz012345`,
  ]) {
    assert.throws(
      () => validateShareUrl(value, baseOrigin),
      (error) => error instanceof PreviewBlobLifecycleError && error.code === "SHARE_URL_INVALID",
    );
  }
});

test("share bootstrap retains only Secure origin-scoped _vercel_ cookies and discards application cookies", async () => {
  const credential = "abcdefghijklmnopqrstuvwxyz012345";
  const shareUrl = validateShareUrl(`https://vercel.com/share/proof?_vercel_share=${credential}`, baseOrigin);
  let observedCookie = null;
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(input);
    const headers = new Headers();
    if (url.origin === "https://vercel.com") {
      headers.append("location", `${baseOrigin}/?_vercel_share=${credential}`);
      headers.append("set-cookie", "_vercel_landing=landing-only; Path=/; Secure; HttpOnly");
      return new Response(null, { headers, status: 302 });
    }
    if (url.searchParams.has("_vercel_share")) {
      headers.append("location", "/");
      headers.append("set-cookie", "_vercel_jwt=preview-only; Path=/; Secure; HttpOnly");
      headers.append("set-cookie", "novalure_session=must-be-discarded; Path=/; Secure; HttpOnly");
      return new Response(null, { headers, status: 302 });
    }
    if (url.pathname === "/") {
      headers.append("content-type", "text/html; charset=utf-8");
      headers.append("set-cookie", "novalure_session=ambient-app-cookie; Path=/; Secure; HttpOnly");
      return new Response("<!doctype html><title>Preview</title>", { headers, status: 200 });
    }
    observedCookie = new Headers(init.headers ?? {}).get("cookie");
    return json({ error: "unauthorized" }, 401);
  };
  const client = createPreviewBlobHttpClient(resolveConfig(), { fetchImpl });
  await client.bootstrapShareAccess(shareUrl);
  await client.request("/api/media/files/33333333-3333-4333-8333-333333333333");
  assert.equal(observedCookie, "_vercel_jwt=preview-only");

  const insecureClient = createPreviewBlobHttpClient(resolveConfig(), {
    fetchImpl: async () => new Response(null, {
      headers: {
        location: "/",
        "set-cookie": "_vercel_jwt=insecure; Path=/; HttpOnly",
      },
      status: 302,
    }),
  });
  await assert.rejects(
    () => insecureClient.bootstrapShareAccess(validateShareUrl(`${baseOrigin}/?_vercel_share=${credential}`, baseOrigin)),
    (error) => error instanceof PreviewBlobLifecycleError && error.code === "SHARE_COOKIE_INSECURE",
  );
});

test("full HTTP lifecycle is a technical PASS but remains release BLOCKED without legacy migration proof", async () => {
  const server = createLifecycleServer();
  const result = await runPreviewBlobLifecycle(resolveConfig(), {
    blobInspector: createBlobInspector(server),
    fetchImpl: server.fetchImpl,
  });
  assert.equal(result.error, null);
  assert.equal(result.evidence.status, "BLOCKED");
  assert.equal(result.evidence.technicalStatus, "PASS");
  assert.equal(result.evidence.cleanup.state, "deleted-and-absent");
  assert.equal(result.evidence.cleanup.verifiedAbsent, true);
  assert.equal(result.evidence.cleanup.resetFallbackUsed, false);
  assert.equal(result.evidence.lifecycle.accessClass, "private");
  assert.equal(result.evidence.lifecycle.readbackBytesVerified, true);
  assert.equal(result.evidence.lifecycle.readHeadersVerified, true);
  assert.equal(result.evidence.lifecycle.unauthenticatedReadDenied, true);
  assert.equal(result.evidence.lifecycle.crossTenantReadDenied, true);
  assert.equal(result.evidence.independentStoreProof.status, "VERIFIED");
  assert.equal(result.evidence.legacyObjectMigrationProof.status, "UNPROVEN");
  assert.equal(result.evidence.releaseGatePassed, false);
  assert.equal(result.evidence.lifecycle.listMatchesBefore, 0);
  assert.equal(result.evidence.lifecycle.listMatchesAfterUpload, 1);
  assert.equal(result.evidence.lifecycle.listMatchesAfterDelete, 0);
  assert.equal(server.state().deleted, true);
  assert.ok(server.calls.some((call) => call.method === "DELETE" && /^\/api\/media\/[0-9a-f-]{36}$/iu.test(call.pathname)));
  const serialized = JSON.stringify(result.evidence);
  assert.doesNotMatch(serialized, /example\.test|qa-test-password|JBSWY3|novalure_session|_vercel_share/u);
  assert.doesNotMatch(serialized, /33333333-3333-4333-8333-333333333333/u);
});

test("release PASS requires a candidate- and Preview-store-bound legacy migration proof", async () => {
  const server = createLifecycleServer();
  const config = resolveConfig();
  const result = await runPreviewBlobLifecycle(config, {
    blobInspector: createBlobInspector(server),
    fetchImpl: server.fetchImpl,
    legacyMigrationProof: legacyMigrationProof(config),
  });
  assert.equal(result.error, null);
  assert.equal(result.evidence.technicalStatus, "PASS");
  assert.equal(result.evidence.legacyObjectMigrationProof.status, "VERIFIED");
  assert.equal(result.evidence.releaseGatePassed, true);
  assert.equal(result.evidence.status, "PASS");

  await assert.rejects(
    runPreviewBlobLifecycle(resolveConfig(), {
      blobInspector: createBlobInspector(createLifecycleServer()),
      legacyMigrationProof: legacyMigrationProof(config, { candidateCommit: "e".repeat(40) }),
    }),
    (error) => error instanceof PreviewBlobLifecycleError && error.code === "LEGACY_MIGRATION_PROOF_INVALID",
  );

  const fabricatedAggregates = legacyMigrationProof(config);
  fabricatedAggregates.evidence.sourceInventory.inventorySha256 = "f".repeat(64);
  fabricatedAggregates.evidenceDigest = createHash("sha256")
    .update(canonicalJson(fabricatedAggregates.evidence)).digest("hex");
  await assert.rejects(
    runPreviewBlobLifecycle(resolveConfig(), {
      blobInspector: createBlobInspector(createLifecycleServer()),
      legacyMigrationProof: fabricatedAggregates,
    }),
    (error) => error instanceof PreviewBlobLifecycleError && error.code === "LEGACY_MIGRATION_PROOF_INVALID",
  );
});

test("missing independent private-store list/head proof is explicitly BLOCKED, never PASS", async () => {
  const server = createLifecycleServer();
  const result = await runPreviewBlobLifecycle(resolveConfig(), { fetchImpl: server.fetchImpl });
  assert.equal(result.error, null);
  assert.equal(result.evidence.status, "BLOCKED");
  assert.equal(result.evidence.independentStoreProof.status, "UNPROVEN");
  assert.equal(result.evidence.independentStoreProof.reasonCode, "LOCAL_PRIVATE_STORE_INSPECTOR_UNAVAILABLE");
  assert.equal(result.evidence.cleanup.verifiedAbsent, true);
});

test("remote host, deployment, database branch, Git branch or SHA drift fails before any upload", async () => {
  for (const options of [
    { capabilityDeploymentHost: "wrong-preview.vercel.app" },
    { capabilityDeploymentId: "dpl_ZYXWVUTSRQPONMLKJIHG" },
    { capabilityBranch: "main" },
    { capabilityDatabaseBranch: "br-wrongpreview123" },
    { capabilitySha: "b".repeat(40) },
  ]) {
    const server = createLifecycleServer(options);
    const result = await runPreviewBlobLifecycle(resolveConfig(), { fetchImpl: server.fetchImpl });
    assert.equal(result.evidence.status, "FAIL");
    assert.equal(server.calls.some((call) => call.method === "POST" && call.pathname === "/api/media"), false);
    assert.equal(result.evidence.cleanup.state, "no-upload-attempted-absence-unproven");
    assert.equal(result.evidence.cleanup.verifiedAbsent, false);
  }
});

test("pre-existing exact marker fails closed without mutation or false absence evidence", async () => {
  const server = createLifecycleServer({ preexistingMatchingMarker: true });
  const result = await runPreviewBlobLifecycle(resolveConfig(), { fetchImpl: server.fetchImpl });
  assert.equal(result.error?.code, "MARKER_ALREADY_EXISTS");
  assert.equal(result.evidence.status, "FAIL");
  assert.equal(result.evidence.lifecycle.listMatchesBefore, 1);
  assert.equal(result.evidence.cleanup.state, "existing-marker-unresolved");
  assert.equal(result.evidence.cleanup.verifiedAbsent, false);
  assert.equal(result.evidence.cleanup.deleted, false);
  assert.equal(server.calls.some((call) => call.method === "POST" && call.pathname === "/api/media"), false);
  assert.equal(server.calls.some((call) => call.method === "DELETE"), false);
  assert.equal(server.state().deleted, false);
});

test("legacy-public or otherwise non-private upload response is never deleted or published", async () => {
  const server = createLifecycleServer({ assetAccess: "legacy-public" });
  const result = await runPreviewBlobLifecycle(resolveConfig(), { fetchImpl: server.fetchImpl });
  assert.equal(result.evidence.status, "FAIL");
  assert.equal(result.evidence.cleanup.state, "scope-rejected-no-mutation");
  assert.equal(result.evidence.cleanup.deleted, false);
  assert.equal(server.calls.some((call) => call.method === "DELETE"), false);
  assert.equal(server.state().deleted, false);
});

test("evidence is redacted, immutable-on-write and paired with a valid sha256 sidecar", async () => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "novalure-preview-blob-test-"));
  try {
    const config = resolveConfig({}, { projectRoot: temporaryRoot });
    const server = createLifecycleServer();
    const result = await runPreviewBlobLifecycle(config, { fetchImpl: server.fetchImpl });
    const written = await writePreviewBlobLifecycleEvidence(config, result.evidence);
    const evidence = await readFile(path.join(written.directory, "preview-blob-lifecycle.json"), "utf8");
    const sidecar = await readFile(path.join(written.directory, "preview-blob-lifecycle.sha256"), "utf8");
    const digest = createHash("sha256").update(evidence).digest("hex");
    assert.equal(sidecar, `${digest}  preview-blob-lifecycle.json\n`);
    await assert.rejects(
      () => writePreviewBlobLifecycleEvidence(config, result.evidence),
      (error) => error?.code === "EEXIST",
    );
    assert.throws(
      () => assertEvidenceSafe({ password: "forbidden" }),
      (error) => error instanceof PreviewBlobLifecycleError && error.code === "EVIDENCE_REDACTION_FAILED",
    );
    assert.throws(
      () => assertEvidenceSafe({ value: "person@example.test" }),
      (error) => error instanceof PreviewBlobLifecycleError && error.code === "EVIDENCE_REDACTION_FAILED",
    );
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
});

test("source and package contracts keep secrets off CLI args and expose runtime branch attestation", async () => {
  const [runner, library, packageSource, capabilityRoute, capabilityRuntime, runtimeIdentity] = await Promise.all([
    readFile(new URL("./preview-blob-lifecycle.mjs", import.meta.url), "utf8"),
    readFile(new URL("./lib/preview-blob-lifecycle.mjs", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../src/app/api/admin/qa-batch-capability/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/lib/qa-batch-runtime.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/lib/qa-runtime-identity.ts", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(runner, /--(?:email|password|token|totp|share-url)=/iu);
  assert.match(runner, /readSingleSecretLine/u);
  assert.match(library, /fetchCsrf\(method, url\.pathname\)/u);
  assert.doesNotMatch(library, /qa-reset|resetTenant|x-vercel-protection-bypass/iu);
  assert.match(packageSource, /node --env-file-if-exists=\.env\.qa-two-tenant\.local scripts\/preview-blob-lifecycle\.mjs --execute --share-url-stdin/u);
  assert.match(capabilityRoute, /gitBranch:\s*config\.gitBranch/u);
  assert.match(capabilityRoute, /deploymentHost:\s*config\.deploymentHost/u);
  assert.match(capabilityRoute, /deploymentId:\s*config\.deploymentId/u);
  assert.match(capabilityRoute, /databaseBranchId:\s*capability\.databaseIdentity\.databaseBranchId/u);
  assert.match(capabilityRoute, /isQaRuntimeDatabaseIdentityReady\(capability\.databaseIdentity\)/u);
  assert.match(capabilityRuntime, /VERCEL_DEPLOYMENT_ID/u);
  assert.match(capabilityRuntime, /VERCEL_GIT_COMMIT_REF/u);
  assert.match(capabilityRuntime, /VERCEL_URL/u);
  assert.match(runtimeIdentity, /current_setting\('neon\.branch_id', true\) as "databaseBranchId"/u);
  assert.match(runtimeIdentity, /current_setting\('neon\.project_id', true\) as "databaseProjectId"/u);
});
