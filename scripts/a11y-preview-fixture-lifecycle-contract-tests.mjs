import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  attestA11yRuntimePreflight,
  bindA11yLifecycleBatches,
  buildA11yChildEnvironment,
  collectA11yEvidenceSecretValues,
  executeA11yPreviewFixtureLifecycle,
  inspectA11yCleanupResiduals,
  inspectA11yPreviewTarget,
  parseA11yPreviewFixtureLifecycleInput,
  prepareA11yPublicSurfaces,
  scanA11yEvidenceForSecrets,
  writeA11yFixtureLifecycleEvidence,
} from "./lib/a11y-preview-fixture-lifecycle.mjs";
import {
  canonicalJson,
  createPublicRuntimeCookieJar,
  parsePublicRuntimeActionInput,
} from "./lib/public-runtime-preview-e2e.mjs";
import { a11yRetainedTableNames } from "./lib/a11y-fixture-lifecycle-evidence.mjs";

const candidateSha = "a".repeat(40);
const deploymentId = `dpl_${"D".repeat(24)}`;
const previewOrigin = "https://novalure-a11y-candidate.vercel.app";
const automationBypassToken = `qa_${"S".repeat(40)}`;
const automationBypassUrl = `${previewOrigin}/?x-vercel-protection-bypass=${automationBypassToken}`;
const primaryBatchId = "33333333-3333-4333-8333-333333333333";
const crossTenantBatchId = "44444444-4444-4444-8444-444444444444";
const primaryWorkspaceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const crossTenantWorkspaceId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const primaryActorId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const crossTenantActorId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const publishToken = "T".repeat(43);

function validRawInput(overrides = {}) {
  return {
    confirmation: "RUN_A11Y_PREVIEW_FIXTURE_LIFECYCLE",
    crossTenant: {
      actorUserId: crossTenantActorId,
      batchMarker: "QA-TEST-20260824-1200-a11y02",
      sessionCookie: `novalure_session=${"B".repeat(48)}`,
      workspaceId: crossTenantWorkspaceId,
    },
    databaseUrl: "postgresql://novalure_app:unit-test-placeholder@ep-preview-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require",
    expectedDeploymentId: deploymentId,
    expectedGitRef: "codex/go-live-remediation-20260822",
    expectedGitSha: candidateSha,
    expectedNeonBranchId: "br-preview-a11y-12345678",
    expectedNeonProjectId: "preview-a11y-project-1234",
    previewOrigin,
    primary: {
      actorUserId: primaryActorId,
      batchMarker: "QA-TEST-20260824-1200-a11y01",
      sessionCookie: `novalure_session=${"A".repeat(48)}`,
      workspaceId: primaryWorkspaceId,
    },
    productionDatabaseHost: "ep-production.us-east-2.aws.neon.tech",
    productionNeonBranchId: "br-snowy-fog-aldx77v8",
    productionNeonProjectId: "misty-cloud-70835427",
    productionOrigin: "https://www.novalure-crm.app",
    schemaVersion: 1,
    shareUrl: automationBypassUrl,
    ...overrides,
  };
}

function validInput(overrides = {}) {
  return parseA11yPreviewFixtureLifecycleInput(JSON.stringify(validRawInput(overrides)));
}

function boundPublicInput(input = validInput()) {
  return bindA11yLifecycleBatches(
    input,
    {
      batchId: primaryBatchId,
      batchMarker: input.primary.batchMarker,
      deploymentId,
      workspaceId: primaryWorkspaceId,
    },
    {
      batchId: crossTenantBatchId,
      batchMarker: input.crossTenant.batchMarker,
      deploymentId,
      workspaceId: crossTenantWorkspaceId,
    },
  );
}

function jsonResponse(status, body, headers = {}) {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json", ...headers },
    status,
  });
}

function createHashForTarget(input) {
  return createHash("sha256")
    .update([input.expectedNeonProjectId, input.expectedNeonBranchId, "neondb", "novalure_app"].join("\0"))
    .digest("hex");
}

test("lifecycle input is strict, final-candidate bound and preserves an explicit Production deny identity", () => {
  const input = validInput();
  assert.equal(input.expectedHost, "novalure-a11y-candidate.vercel.app");
  assert.equal(input.productionNeonProjectId, "misty-cloud-70835427");
  assert.equal(input.primary.sessionCookie.startsWith("novalure_session="), true);
  assert.throws(
    () => validInput({ productionNeonProjectId: "preview-a11y-project-1234" }),
    /A11Y_FIXTURE_PRODUCTION_DATABASE_IDENTITY_INVALID/u,
  );
  assert.throws(
    () => validInput({ previewOrigin: "https://www.novalure-crm.app" }),
    /A11Y_FIXTURE_INPUT_SCOPE_INVALID/u,
  );
  assert.throws(
    () => parseA11yPreviewFixtureLifecycleInput(JSON.stringify({ ...validRawInput(), surprise: true })),
    /A11Y_FIXTURE_INPUT_KEYS_INVALID/u,
  );
  assert.throws(
    () => validInput({
      crossTenant: { ...validRawInput().crossTenant, workspaceId: primaryWorkspaceId },
    }),
    /A11Y_FIXTURE_INPUT_SCOPE_INVALID/u,
  );
});

test("share handoff accepts only an automation-bypass URL on the exact Preview origin", () => {
  const input = validInput();
  assert.equal(input.shareUrl, automationBypassUrl);
  assert.throws(
    () => validInput({ shareUrl: `https://vercel.com/some/share?x-vercel-protection-bypass=${automationBypassToken}` }),
    /A11Y_FIXTURE_INPUT_SCOPE_INVALID/u,
  );
});

test("batch binding rejects cross-deployment, reused or cross-workspace batches", () => {
  const input = validInput();
  const bound = boundPublicInput(input);
  assert.equal(bound.batchId, primaryBatchId);
  assert.equal(bound.crossTenantBatchId, crossTenantBatchId);
  assert.throws(
    () => bindA11yLifecycleBatches(
      input,
      { batchId: primaryBatchId, batchMarker: input.primary.batchMarker, deploymentId, workspaceId: primaryWorkspaceId },
      { batchId: primaryBatchId, batchMarker: input.crossTenant.batchMarker, deploymentId, workspaceId: crossTenantWorkspaceId },
    ),
    /A11Y_FIXTURE_BATCH_BINDING_INVALID/u,
  );
  assert.throws(
    () => bindA11yLifecycleBatches(
      input,
      { batchId: primaryBatchId, batchMarker: input.primary.batchMarker, deploymentId: `dpl_${"X".repeat(24)}`, workspaceId: primaryWorkspaceId },
      { batchId: crossTenantBatchId, batchMarker: input.crossTenant.batchMarker, deploymentId, workspaceId: crossTenantWorkspaceId },
    ),
    /A11Y_FIXTURE_BATCH_BINDING_INVALID/u,
  );
});

test("read-only database preflight checks exact Preview target and both isolated platform-admin actors", async () => {
  const input = validInput();
  let scopeIndex = 0;
  const calls = [];
  const sqlFactory = () => ({
    async transaction(callback, options) {
      const scope = scopeIndex === 0 ? input.primary : input.crossTenant;
      scopeIndex += 1;
      const transaction = (strings, ...values) => {
        calls.push({ sql: strings.join("?"), values });
        return { strings, values };
      };
      const queries = callback(transaction);
      assert.equal(queries.length, 3);
      assert.deepEqual(options, { isolationLevel: "RepeatableRead", readOnly: true });
      return [
        [{ actorId: scope.actorUserId, tenantId: scope.workspaceId }],
        [{
          actorId: scope.actorUserId,
          branchId: input.expectedNeonBranchId,
          databaseName: "neondb",
          databaseRole: "novalure_app",
          projectId: input.expectedNeonProjectId,
          tenantId: scope.workspaceId,
        }],
        [{ actorId: scope.actorUserId, isQa: true, productRole: "platform_admin", role: "owner", status: "active" }],
      ];
    },
  });
  const result = await inspectA11yPreviewTarget(input, { sqlFactory });
  assert.equal(result.status, "PASS");
  assert.match(result.databaseTargetDigest, /^sha256:[a-f0-9]{64}$/u);
  assert.equal(scopeIndex, 2);
  assert.equal(calls.some((call) => /delete\s+from/iu.test(call.sql)), false);
});

test("runtime preflight binds public runtime identity and both cookie sessions before provisioning", async () => {
  const input = validInput();
  const jar = createPublicRuntimeCookieJar(input.primary.sessionCookie);
  const calls = [];
  const common = {
    databaseBranchId: input.expectedNeonBranchId,
    databaseLeastPrivilege: true,
    databaseRlsActive: true,
    databaseTargetDigest: `sha256:${createHashForTarget(input)}`,
    deploymentHost: input.expectedHost,
    deploymentId,
    gitBranch: input.expectedGitRef,
    gitSha: candidateSha,
    version: 2,
  };
  const fetchImpl = async (value, init = {}) => {
    const url = new URL(value);
    const cookie = new Headers(init.headers).get("cookie") ?? "";
    calls.push({ cookie, path: url.pathname });
    if (url.pathname === "/api/admin/qa-runtime-identity") return jsonResponse(200, common);
    const primary = cookie.includes("A".repeat(48));
    return jsonResponse(200, {
      ...common,
      atomicRegistration: true,
      batchCapability: null,
      publicRuntimeAtomicSurfaces: {
        blueprint: true,
        formPublicSubmit: true,
        formUpsert: true,
        funnelCreate: true,
        funnelPublicSubmit: true,
        reset: true,
        tokenRotation: true,
      },
      sessionScope: {
        productRole: "platform_admin",
        role: "owner",
        source: "cookie",
        userId: primary ? primaryActorId : crossTenantActorId,
        workspaceId: primary ? primaryWorkspaceId : crossTenantWorkspaceId,
      },
    });
  };
  assert.deepEqual(await attestA11yRuntimePreflight(input, jar, fetchImpl), { status: "PASS" });
  assert.deepEqual(calls.map((call) => call.path), [
    "/api/admin/qa-runtime-identity",
    "/api/admin/qa-batch-capability",
    "/api/admin/qa-batch-capability",
  ]);
  assert.equal(calls[1].cookie.includes("A".repeat(48)), true);
  assert.equal(calls[2].cookie.includes("B".repeat(48)), true);
});

test("surface preparation creates registered active fixtures, verifies cross-tenant 404s and returns only stdin handoff fields", async () => {
  const input = boundPublicInput();
  const jar = createPublicRuntimeCookieJar(input.sessionCookie);
  const observed = [];
  const formId = "55555555-5555-4555-8555-555555555555";
  const funnelId = "66666666-6666-4666-8666-666666666666";
  const fetchImpl = async (urlValue, init = {}) => {
    const url = new URL(urlValue);
    const method = init.method ?? "GET";
    const cookie = new Headers(init.headers).get("cookie") ?? "";
    observed.push({ cookie, headers: new Headers(init.headers), method, path: `${url.pathname}${url.search}` });
    if (url.pathname === "/api/auth/csrf") {
      return jsonResponse(200, { csrfToken: "C".repeat(48) });
    }
    if (url.pathname === "/api/forms" && method === "POST") {
      return jsonResponse(200, {
        form: { id: formId, ownerUserId: primaryActorId, slug: "qa-public-a11y", status: "aktiv" },
        persisted: true,
      }, { ["x-novalure-qa-batch-id"]: primaryBatchId, ["x-novalure-qa-batch-registration"]: "committed" });
    }
    if (url.pathname === "/forms/0123456789abcdef0123456789abcdef/qa-public-a11y") {
      return new Response("<main><form data-novalure-runtime=\"form\"></form></main>", { status: 200 });
    }
    if (url.pathname === "/api/crm/funnels" && method === "POST") {
      return jsonResponse(200, {
        funnel: { id: funnelId, ownerUserId: primaryActorId },
        persisted: true,
      }, { ["x-novalure-qa-batch-id"]: primaryBatchId, ["x-novalure-qa-batch-registration"]: "committed" });
    }
    if (url.pathname === `/api/funnels/${funnelId}/blueprint` && method === "GET") {
      if (cookie.includes("B".repeat(48))) return jsonResponse(404, { error: "Not found" });
      return jsonResponse(200, {
        blueprint: { pages: [], status: "entwurf" },
        blueprintRevision: 0,
      });
    }
    if (url.pathname === `/api/funnels/${funnelId}/blueprint` && method === "PUT") {
      return jsonResponse(200, {
        blueprint: { status: "aktiv" },
        preflight: { ok: true },
      }, { ["x-novalure-qa-batch-id"]: primaryBatchId });
    }
    if (url.pathname === `/api/admin/funnels/${funnelId}/publish-token/cutover` && method === "GET") {
      if (cookie.includes("B".repeat(48))) return jsonResponse(404, { error: "Not found" });
      return jsonResponse(200, { revision: 0 });
    }
    if (url.pathname === `/api/admin/funnels/${funnelId}/publish-token/cutover` && method === "POST") {
      return jsonResponse(200, { publishToken, revision: 1 });
    }
    if (url.pathname === `/preview/${funnelId}`) return new Response("<main data-funnel-mode=\"live\"></main>", { status: 200 });
    if (url.pathname === "/api/forms/resolve" && cookie.includes("B".repeat(48))) {
      return jsonResponse(404, { error: "Not found" });
    }
    return jsonResponse(500, { error: `Unexpected ${method} ${url.pathname}` });
  };

  const handoff = await prepareA11yPublicSurfaces({
    databaseAttestation: {
      attestation: { freshBatch: true },
      projectId: "77777777-7777-4777-8777-777777777777",
      workspacePublicKey: "0123456789abcdef0123456789abcdef",
    },
    fetchImpl,
    input,
    jar,
  });
  assert.deepEqual(Object.keys(handoff).sort(), ["publicFormUrl", "publicFunnelUrl", "shareUrl"]);
  assert.equal(handoff.publicFormUrl, `${previewOrigin}/forms/0123456789abcdef0123456789abcdef/qa-public-a11y`);
  assert.equal(new URL(handoff.publicFunnelUrl).searchParams.get("token"), publishToken);
  assert.equal(observed.filter((call) => call.path.startsWith("/api/auth/csrf?")).length, 4);
  const mutations = observed.filter((call) => ["POST", "PUT"].includes(call.method) && call.path !== "/api/auth/csrf");
  assert.equal(mutations.every((call) => call.headers.get("x-novalure-csrf-token") === "C".repeat(48)), true);
  assert.equal(mutations.every((call) => call.headers.get("x-novalure-qa-batch-id") === primaryBatchId), true);
  assert.equal(observed.some((call) => call.path.includes("novalure-crm.app")), false);
});

function lifecycleStubs({
  a11yFailure = null,
  cleanupFailure = null,
  inventoryDigestDrift = false,
  inventoryRowDrift = false,
  postFailure = null,
  retainedCrossTableDrift = false,
} = {}) {
  const events = [];
  let inventoryCalls = 0;
  let retainedCalls = 0;
  return {
    events,
    options: {
      a11yRunner: async ({ handoff }) => {
        events.push("a11y");
        assert.deepEqual(Object.keys(handoff).sort(), ["publicFormUrl", "publicFunnelUrl", "shareUrl"]);
        if (a11yFailure) throw a11yFailure;
        return {
          browserEvidenceSha256: "8".repeat(64),
          browserEvidenceSizeBytes: 1_024,
          browserSidecarSha256: "9".repeat(64),
          outputDirectory: "artifacts/qa/a11y-test",
          runId: "a11y-run-12345678-1234-4123-8123-123456789012",
        };
      },
      batchRuntimeAttestor: async () => events.push("batch-attest"),
      databaseInspector: async () => {
        events.push("database-attest");
        return { attestation: { freshBatch: true }, projectId: "fixture-project", workspacePublicKey: "0".repeat(32) };
      },
      databaseStoreFactory: () => ({
        async inventory() {
          inventoryCalls += 1;
          events.push(inventoryCalls === 1 ? "inventory-before" : "inventory-after");
          return {
            digest: inventoryCalls === 2 && inventoryDigestDrift ? "2".repeat(64) : "1".repeat(64),
            rowCount: inventoryCalls === 2 && inventoryRowDrift ? 11 : 10,
          };
        },
        async remainingBatchObjectCount() {
          events.push("remaining-batch-count");
          return 0;
        },
        async retainedInventory() {
          retainedCalls += 1;
          events.push(retainedCalls === 1 ? "retained-before" : "retained-after");
          const tables = Object.fromEntries(a11yRetainedTableNames.map((name) => {
            let members = [createHash("sha256").update(`${name}:baseline`).digest("hex")];
            if (retainedCalls === 2) {
              members.push(createHash("sha256").update(`${name}:append`).digest("hex"));
            }
            if (retainedCalls === 2 && retainedCrossTableDrift && name === "audit_logs") {
              members = [createHash("sha256").update(`${name}:replacement`).digest("hex")];
            }
            if (retainedCalls === 2 && retainedCrossTableDrift && name === "analytics_events") {
              members.push(
                createHash("sha256").update(`${name}:extra-1`).digest("hex"),
                createHash("sha256").update(`${name}:extra-2`).digest("hex"),
              );
            }
            members.sort();
            return [name, {
              digest: createHash("sha256").update(canonicalJson(members)).digest("hex"),
              members,
              rowCount: members.length,
            }];
          }));
          const summary = Object.fromEntries(Object.entries(tables).map(([name, table]) => [
            name,
            { digest: table.digest, rowCount: table.rowCount },
          ]));
          return {
            digest: createHash("sha256").update(canonicalJson(summary)).digest("hex"),
            rowCount: Object.values(tables).reduce((sum, table) => sum + table.rowCount, 0),
            tables,
          };
        },
      }),
      fetchImpl: async (value, init = {}) => {
        const url = new URL(value);
        const headers = new Headers(init.headers ?? {});
        assert.equal(url.href, `${previewOrigin}/`);
        assert.equal(headers.get("x-vercel-protection-bypass"), automationBypassToken);
        return new Response("<!doctype html><title>Preview</title>", {
          headers: { "content-type": "text/html; charset=utf-8" },
          status: 200,
        });
      },
      lifecycleEvidenceWriter: async (_outputDirectory, document) => {
        events.push("write-lifecycle-evidence");
        return {
          digest: createHash("sha256").update(canonicalJson(document)).digest("hex"),
        };
      },
      postCleanupInspector: async () => {
        events.push("residual-count");
        if (postFailure) throw postFailure;
        return {
          crossTenant: {
            auditCount: 1,
            executedCount: 1,
            ledgerCount: 0,
            liveCascadeCount: 0,
            liveRegisteredCount: 0,
            unexpectedLedgerCount: 0,
          },
          primary: {
            auditCount: 1,
            executedCount: 1,
            ledgerCount: 3,
            liveCascadeCount: 0,
            liveRegisteredCount: 0,
            unexpectedLedgerCount: 0,
          },
        };
      },
      provisionBatch: async (provisionInput) => {
        const primary = provisionInput.workspaceId === primaryWorkspaceId;
        events.push(primary ? "provision-primary" : "provision-cross");
        return {
          batchId: primary ? primaryBatchId : crossTenantBatchId,
          batchMarker: provisionInput.batchMarker,
          deploymentId,
          workspaceId: provisionInput.workspaceId,
        };
      },
      requireLocalIdentity: false,
      resetBatch: async (_input, _jar, _fetch, resetInput) => {
        const primary = resetInput.workspaceId === primaryWorkspaceId;
        events.push(primary ? "reset-primary" : "reset-cross");
        if (cleanupFailure && primary) throw cleanupFailure;
        return {
          createdObjectCount: primary ? 3 : 0,
          deletedObjectCount: primary ? 3 : 0,
          digest: "e".repeat(64),
        };
      },
      runtimePreflight: async () => events.push("runtime-preflight"),
      surfacePreparer: async () => {
        events.push("prepare-surfaces");
        return {
          publicFormUrl: `${previewOrigin}/forms/public/a11y`,
          publicFunnelUrl: `${previewOrigin}/preview/fixture?mode=live&token=${publishToken}`,
          shareUrl: automationBypassUrl,
        };
      },
      targetInspector: async () => events.push("target-preflight"),
    },
  };
}

test("complete lifecycle provisions both fresh batches, pipes fixtures, then always seals and independently counts both", async () => {
  const fixture = lifecycleStubs();
  const summary = await executeA11yPreviewFixtureLifecycle({
    ...fixture.options,
    input: validInput(),
  });
  assert.equal(summary.status, "PASS");
  assert.equal(summary.productionMutationPerformed, false);
  assert.equal(summary.a11yBrowserEvidenceSha256, "8".repeat(64));
  assert.match(summary.a11yFixtureLifecycleSha256, /^[a-f0-9]{64}$/u);
  assert.equal(JSON.stringify(summary).includes(publishToken), false);
  assert.deepEqual(fixture.events, [
    "target-preflight",
    "runtime-preflight",
    "provision-primary",
    "provision-cross",
    "database-attest",
    "batch-attest",
    "inventory-before",
    "retained-before",
    "prepare-surfaces",
    "a11y",
    "reset-primary",
    "reset-cross",
    "residual-count",
    "inventory-after",
    "remaining-batch-count",
    "retained-after",
    "write-lifecycle-evidence",
  ]);
});

test("A11y failure still resets and reconciles both batches before surfacing failure", async () => {
  const fixture = lifecycleStubs({ a11yFailure: new Error("A11Y_EXPECTED_FAILURE") });
  await assert.rejects(
    executeA11yPreviewFixtureLifecycle({ ...fixture.options, input: validInput() }),
    /A11Y_EXPECTED_FAILURE/u,
  );
  assert.deepEqual(fixture.events.slice(-6), [
    "reset-primary",
    "reset-cross",
    "residual-count",
    "inventory-after",
    "remaining-batch-count",
    "retained-after",
  ]);
});

test("a secondary provisioning failure seals the already-created empty primary batch without starting A11y", async () => {
  const fixture = lifecycleStubs();
  let provisionCalls = 0;
  fixture.options.provisionBatch = async (provisionInput) => {
    provisionCalls += 1;
    if (provisionCalls === 2) throw new Error("SECONDARY_PROVISION_FAILED");
    fixture.events.push("provision-primary");
    return {
      batchId: primaryBatchId,
      batchMarker: provisionInput.batchMarker,
      deploymentId,
      workspaceId: provisionInput.workspaceId,
    };
  };
  fixture.options.resetBatch = async (_input, _jar, _fetch, resetInput) => {
    fixture.events.push("reset-primary");
    assert.equal(resetInput.batchId, primaryBatchId);
    return { createdObjectCount: 0, deletedObjectCount: 0, digest: "e".repeat(64) };
  };
  fixture.options.postCleanupInspector = async (_input, scopes) => {
    fixture.events.push("residual-count");
    assert.deepEqual(scopes.map((scope) => scope.key), ["primary"]);
    return { primary: { ledgerCount: 0 } };
  };
  await assert.rejects(
    executeA11yPreviewFixtureLifecycle({ ...fixture.options, input: validInput() }),
    /SECONDARY_PROVISION_FAILED/u,
  );
  assert.equal(fixture.events.includes("a11y"), false);
  assert.deepEqual(fixture.events.slice(-2), ["reset-primary", "residual-count"]);
});

test("any reset or independent residual failure converts the run to fail-closed emergency cleanup", async () => {
  for (const fixture of [
    lifecycleStubs({ cleanupFailure: new Error("RESET_FAILED") }),
    lifecycleStubs({ postFailure: new Error("RESIDUAL_ROWS_REMAIN") }),
  ]) {
    await assert.rejects(
      executeA11yPreviewFixtureLifecycle({ ...fixture.options, input: validInput() }),
      /A11Y_FIXTURE_EMERGENCY_CLEANUP_FAILED/u,
    );
    assert.equal(fixture.events.includes("reset-cross"), true);
    assert.equal(fixture.events.includes("residual-count"), true);
    assert.equal(fixture.events.includes("write-lifecycle-evidence"), false);
  }
});

test("same-count content drift and an unregistered operational side row both block cleanup PASS", async () => {
  for (const fixture of [
    lifecycleStubs({ inventoryDigestDrift: true }),
    lifecycleStubs({ inventoryDigestDrift: true, inventoryRowDrift: true }),
  ]) {
    await assert.rejects(
      executeA11yPreviewFixtureLifecycle({ ...fixture.options, input: validInput() }),
      /A11Y_FIXTURE_EMERGENCY_CLEANUP_FAILED/u,
    );
    assert.equal(fixture.events.includes("remaining-batch-count"), true);
    assert.equal(fixture.events.includes("retained-after"), true);
  }
});

test("retained append-only reconciliation rejects delete-and-replace membership hidden by growth elsewhere", async () => {
  const fixture = lifecycleStubs({ retainedCrossTableDrift: true });
  await assert.rejects(
    executeA11yPreviewFixtureLifecycle({ ...fixture.options, input: validInput() }),
    /A11Y_FIXTURE_EMERGENCY_CLEANUP_FAILED/u,
  );
  assert.equal(fixture.events.includes("write-lifecycle-evidence"), false);
});

test("A11y child environment is exact-allowlisted and rejects ambient QA, Vercel, provider and database secrets", () => {
  const child = buildA11yChildEnvironment({
    CI: "false",
    DATABASE_URL: "postgresql://must-not-leak",
    NOVALURE_BROWSER_EXECUTABLE: "C:/browser/chrome.exe",
    NOVALURE_PLAYWRIGHT_MODULE_PATH: "C:/runtime/playwright/index.mjs",
    NOVALURE_PROVIDER_SECRET: "provider-secret",
    NOVALURE_QA_PREVIEW_EMAIL: "codextest_a11y@example.test",
    NOVALURE_QA_PREVIEW_FIXTURE_MARKER: "QA-TEST-A11Y",
    NOVALURE_QA_PREVIEW_FIXTURE_MARKER_KEY: "qaPrefix",
    NOVALURE_QA_PREVIEW_PASSWORD: "fixture-password-value",
    NOVALURE_QA_PREVIEW_PRODUCT_ROLE: "platform_admin",
    NOVALURE_QA_PREVIEW_ROLE: "owner",
    NOVALURE_QA_PREVIEW_TOTP_SECRET: "A".repeat(32),
    NOVALURE_QA_PREVIEW_WORKSPACE_ID: primaryWorkspaceId,
    PATH: "C:/safe-bin",
    RESEND_API_KEY: "resend-secret",
    VERCEL_ACCESS_TOKEN: "vercel-secret",
  });
  assert.equal(child.CI, "true");
  assert.equal(child.NOVALURE_QA_PREVIEW_PASSWORD, "fixture-password-value");
  assert.equal(child.NOVALURE_QA_PREVIEW_TOTP_SECRET, "A".repeat(32));
  assert.equal(child.NOVALURE_BROWSER_EXECUTABLE, "C:/browser/chrome.exe");
  assert.equal(child.NOVALURE_PLAYWRIGHT_MODULE_PATH, "C:/runtime/playwright/index.mjs");
  assert.equal(child.DATABASE_URL, undefined);
  assert.equal(child.NOVALURE_PROVIDER_SECRET, undefined);
  assert.equal(child.RESEND_API_KEY, undefined);
  assert.equal(child.VERCEL_ACCESS_TOKEN, undefined);
  assert.deepEqual(Object.keys(child).sort(), [
    "CI",
    "NEXT_TELEMETRY_DISABLED",
    "NOVALURE_BROWSER_EXECUTABLE",
    "NOVALURE_PLAYWRIGHT_MODULE_PATH",
    "NOVALURE_QA_PREVIEW_EMAIL",
    "NOVALURE_QA_PREVIEW_FIXTURE_MARKER",
    "NOVALURE_QA_PREVIEW_FIXTURE_MARKER_KEY",
    "NOVALURE_QA_PREVIEW_PASSWORD",
    "NOVALURE_QA_PREVIEW_PRODUCT_ROLE",
    "NOVALURE_QA_PREVIEW_ROLE",
    "NOVALURE_QA_PREVIEW_TOTP_SECRET",
    "NOVALURE_QA_PREVIEW_WORKSPACE_ID",
    "NO_COLOR",
    "PATH",
  ]);
});

test("optional password-reset result URL is included in the exact A11y evidence secret scan set", async () => {
  const resetResultUrl = `${previewOrigin}/login/reset-password?error=invalid_token&lang=en`;
  const childEnvironment = buildA11yChildEnvironment({
    NOVALURE_QA_A11Y_PASSWORD_RESET_RESULT_URL: resetResultUrl,
  });
  const input = validInput();
  const handoff = {
    publicFormUrl: `${previewOrigin}/forms/public/a11y`,
    publicFunnelUrl: `${previewOrigin}/preview/fixture?mode=live&token=${publishToken}`,
    shareUrl: "",
  };
  const values = collectA11yEvidenceSecretValues({ childEnvironment, handoff, input });
  assert.equal(values.includes(resetResultUrl), true);

  const directory = await mkdtemp(path.join(os.tmpdir(), "novalure-a11y-reset-url-scan-"));
  try {
    await writeFile(
      path.join(directory, "a11y-browser-matrix.json"),
      `${JSON.stringify({ leakedResult: resetResultUrl })}\n`,
      "utf8",
    );
    await writeFile(
      path.join(directory, "a11y-browser-matrix.json.sha256"),
      `${"f".repeat(64)}  a11y-browser-matrix.json\n`,
      "utf8",
    );
    await assert.rejects(
      scanA11yEvidenceForSecrets(directory, values),
      /A11Y_FIXTURE_SECRET_LEAK_DETECTED/u,
    );
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("password, TOTP and login identity are all post-run evidence secrets", async () => {
  const childEnvironment = buildA11yChildEnvironment({
    NOVALURE_QA_PREVIEW_EMAIL: "codextest_a11y@example.test",
    NOVALURE_QA_PREVIEW_PASSWORD: "preview-password-do-not-leak",
    NOVALURE_QA_PREVIEW_TOTP_SECRET: "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP",
  });
  const handoff = {
    publicFormUrl: `${previewOrigin}/forms/public/a11y`,
    publicFunnelUrl: `${previewOrigin}/preview/fixture?mode=live&token=${publishToken}`,
    shareUrl: "",
  };
  const secrets = collectA11yEvidenceSecretValues({
    childEnvironment,
    handoff,
    input: validInput(),
  });
  for (const secret of [
    childEnvironment.NOVALURE_QA_PREVIEW_EMAIL,
    childEnvironment.NOVALURE_QA_PREVIEW_PASSWORD,
    childEnvironment.NOVALURE_QA_PREVIEW_TOTP_SECRET,
  ]) assert.equal(secrets.includes(secret), true);

  const directory = await mkdtemp(path.join(os.tmpdir(), "novalure-a11y-auth-secret-scan-"));
  try {
    const source = `${JSON.stringify({ leak: childEnvironment.NOVALURE_QA_PREVIEW_PASSWORD })}\n`;
    const digest = createHash("sha256").update(source).digest("hex");
    await writeFile(path.join(directory, "a11y-browser-matrix.json"), source, "utf8");
    await writeFile(
      path.join(directory, "a11y-browser-matrix.json.sha256"),
      `${digest}  a11y-browser-matrix.json\n`,
      "utf8",
    );
    await assert.rejects(
      scanA11yEvidenceForSecrets(directory, secrets),
      /A11Y_FIXTURE_SECRET_LEAK_DETECTED/u,
    );
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("preflight failure performs zero provisioning, fixture mutation or cleanup", async () => {
  const fixture = lifecycleStubs();
  fixture.options.targetInspector = async () => {
    fixture.events.push("target-preflight");
    throw new Error("TARGET_MISMATCH");
  };
  await assert.rejects(
    executeA11yPreviewFixtureLifecycle({ ...fixture.options, input: validInput() }),
    /TARGET_MISMATCH/u,
  );
  assert.deepEqual(fixture.events, ["target-preflight"]);
});

test("independent cleanup inspection accepts only sealed batches with no live registered or cascade rows", async () => {
  const input = validInput();
  const scopes = [
    { ...input.primary, batchId: primaryBatchId, key: "primary" },
    { ...input.crossTenant, batchId: crossTenantBatchId, key: "crossTenant" },
  ];
  let index = 0;
  const sqlFactory = () => ({
    async transaction(callback, options) {
      const scope = scopes[index];
      index += 1;
      const transaction = (strings, ...values) => ({ strings, values });
      const queries = callback(transaction);
      assert.equal(queries.length, 3);
      assert.deepEqual(options, { isolationLevel: "RepeatableRead", readOnly: true });
      return [
        [{}],
        [{
          branchId: input.expectedNeonBranchId,
          databaseName: "neondb",
          databaseRole: "novalure_app",
          projectId: input.expectedNeonProjectId,
        }],
        [{
          auditCount: 1,
          candidateSha,
          deploymentId,
          executedCount: 1,
          ledgerCount: scope.key === "primary" ? 3 : 0,
          liveCascadeCount: 0,
          liveRegisteredCount: 0,
          purpose: "public-runtime-preview",
          unexpectedLedgerCount: 0,
        }],
      ];
    },
  });
  const result = await inspectA11yCleanupResiduals(input, scopes, { sqlFactory });
  assert.equal(result.primary.ledgerCount, 3);
  assert.equal(result.crossTenant.executedCount, 1);
});

test("evidence scanner accepts the exact A11y files and rejects any action-time URL or token leak", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "novalure-a11y-secret-scan-"));
  try {
    const source = "{\"status\":\"PASS\"}\n";
    const digest = createHash("sha256").update(source).digest("hex");
    await writeFile(path.join(directory, "a11y-browser-matrix.json"), source, "utf8");
    await writeFile(path.join(directory, "a11y-browser-matrix.json.sha256"), `${digest}  a11y-browser-matrix.json\n`, "utf8");
    const scanned = await scanA11yEvidenceForSecrets(directory, [publishToken]);
    assert.equal(scanned.browserEvidenceSha256, digest);
    assert.equal(scanned.browserEvidenceSizeBytes, Buffer.byteLength(source));
    await writeFile(path.join(directory, "a11y-browser-matrix.json"), `{"leak":"${publishToken}"}\n`, "utf8");
    await assert.rejects(
      scanA11yEvidenceForSecrets(directory, [publishToken]),
      /A11Y_FIXTURE_SECRET_LEAK_DETECTED/u,
    );
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("evidence scanner rejects a stale or wrong browser sidecar", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "novalure-a11y-sidecar-scan-"));
  try {
    await writeFile(path.join(directory, "a11y-browser-matrix.json"), "{\"status\":\"PASS\"}\n", "utf8");
    await writeFile(
      path.join(directory, "a11y-browser-matrix.json.sha256"),
      `${"f".repeat(64)}  a11y-browser-matrix.json\n`,
      "utf8",
    );
    await assert.rejects(
      scanA11yEvidenceForSecrets(directory, []),
      /A11Y_FIXTURE_EVIDENCE_SIDECAR_MISMATCH/u,
    );
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("post-cleanup lifecycle evidence uses exclusive files, exact readback and an immutable sidecar", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "novalure-a11y-lifecycle-writer-"));
  const outputDirectory = path.join(root, "a11y-run-12345678-1234-4123-8123-123456789012");
  await mkdir(outputDirectory);
  try {
    const browserSource = "{\"status\":\"PASS\"}\n";
    const browserDigest = createHash("sha256").update(browserSource).digest("hex");
    await writeFile(path.join(outputDirectory, "a11y-browser-matrix.json"), browserSource, { flag: "wx" });
    await writeFile(
      path.join(outputDirectory, "a11y-browser-matrix.json.sha256"),
      `${browserDigest}  a11y-browser-matrix.json\n`,
      { flag: "wx" },
    );
    const document = { recordType: "UNIT_TEST_LIFECYCLE", status: "PASS" };
    const written = await writeA11yFixtureLifecycleEvidence(outputDirectory, document);
    const source = canonicalJson(document);
    assert.equal(written.digest, createHash("sha256").update(source).digest("hex"));
    assert.equal(await readFile(written.artifactPath, "utf8"), source);
    assert.equal(
      await readFile(written.sidecarPath, "utf8"),
      `${written.digest}  a11y-fixture-lifecycle.json\n`,
    );
    await assert.rejects(
      writeA11yFixtureLifecycleEvidence(outputDirectory, document),
      /A11Y_FIXTURE_EVIDENCE_DIRECTORY_INVALID/u,
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("lifecycle implementation never writes a URL handoff or performs direct SQL deletes", async () => {
  const [library, cli, browser] = await Promise.all([
    readFile("scripts/lib/a11y-preview-fixture-lifecycle.mjs", "utf8"),
    readFile("scripts/qa-a11y-preview-fixture-lifecycle.mjs", "utf8"),
    readFile("scripts/a11y-browser-matrix.mjs", "utf8"),
  ]);
  assert.doesNotMatch(library, /import[^;]*\bwriteFile\b[^;]*from\s+"node:fs\/promises"/u);
  assert.doesNotMatch(library, /delete\s+from/iu);
  assert.equal(library.match(/exactObjectKeys\(raw\.primary/gu)?.length, 1);
  assert.match(library, /stdio:\s*\["pipe",\s*"inherit",\s*"inherit"\]/u);
  assert.match(library, /child\.stdin\.end\(`\$\{JSON\.stringify\(handoff\)\}\\n`\)/u);
  assert.match(library, /const runId = `a11y-run-\$\{randomUUID\(\)\}`/u);
  assert.match(browser, /flag:\s*"wx"/u);
  assert.doesNotMatch(cli, /NOVALURE_QA_A11Y_PUBLIC_(?:FORM|FUNNEL)_URL/u);
});

test("CLI stderr emits only a bounded error code and never echoes malformed stdin secrets", () => {
  const secret = "postgresql://novalure_app:DO_NOT_ECHO@secret.neon.tech/neondb";
  const result = spawnSync(
    process.execPath,
    ["scripts/qa-a11y-preview-fixture-lifecycle.mjs", "--execute", "--input-stdin"],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      input: JSON.stringify({ secret }),
      windowsHide: true,
    },
  );
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /^\[qa-a11y-fixture-lifecycle\] status=FAIL code=A11Y_FIXTURE_INPUT_KEYS_INVALID\r?\n$/u);
  assert.equal(result.stderr.includes(secret), false);
  assert.equal(result.stderr.includes("DO_NOT_ECHO"), false);
});

test("public-runtime action parser remains the canonical secret and tenant boundary", () => {
  const input = boundPublicInput();
  const reparsed = parsePublicRuntimeActionInput(JSON.stringify({
    actorUserId: input.actorUserId,
    batchId: input.batchId,
    batchMarker: input.batchMarker,
    crossTenantActorUserId: input.crossTenantActorUserId,
    crossTenantBatchId: input.crossTenantBatchId,
    crossTenantBatchMarker: input.crossTenantBatchMarker,
    crossTenantSessionCookie: input.crossTenantSessionCookie,
    crossTenantWorkspaceId: input.crossTenantWorkspaceId,
    databaseUrl: input.databaseUrl,
    expectedDeploymentId: input.expectedDeploymentId,
    expectedGitRef: input.expectedGitRef,
    expectedGitSha: input.expectedGitSha,
    expectedNeonBranchId: input.expectedNeonBranchId,
    expectedNeonProjectId: input.expectedNeonProjectId,
    previewOrigin: input.previewOrigin,
    productionDatabaseHost: input.productionDatabaseHost,
    productionOrigin: input.productionOrigin,
    sessionCookie: input.sessionCookie,
    shareUrl: input.shareUrl,
    workspaceId: input.workspaceId,
  }));
  assert.equal(reparsed.targetFingerprint, input.targetFingerprint);
});
