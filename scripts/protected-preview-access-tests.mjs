#!/usr/bin/env node

import assert from "node:assert/strict";
import test from "node:test";
import {
  applyVercelAutomationBypass,
  bindVercelAutomationBypass,
  hasVercelAutomationBypass,
  validateVercelAutomationBypassUrl,
} from "./lib/vercel-preview-access.mjs";
import {
  bootstrapPreviewShareCookies,
  createHttpClient,
  evaluateQaActiveSessionPreflight,
  qaBusinessActorUserIds,
  verifyPreviewRuntimeIdentity,
} from "./qa-two-tenant-e2e.mjs";
import {
  bootstrapPublicRuntimeShareAccess,
  createPublicRuntimeCookieJar,
  parsePublicRuntimeActionInput,
  requestExact,
} from "./lib/public-runtime-preview-e2e.mjs";
import {
  QA_CLEANUP_CONFIRMATION,
  QA_WRITE_CONFIRMATION,
} from "./lib/qa-two-tenant-matrix.mjs";
import { validateProtectedPreviewWorkflowContract } from "./qa-protected-preview-workflow-contract.mjs";
import {
  decodeProtectedPublicInput,
  stageProtectedPublicEvidence,
  validateProtectedPublicWorkflowInput,
} from "./qa-protected-public-action-runner.mjs";

const previewOrigin = "https://novalure-r7pvmo5xd-novalure.vercel.app";
const productionOrigin = "https://www.novalure-crm.app";
const productionVercelOrigin = "https://novalure-crm-novalure.vercel.app";
const bypassHeader = "x-vercel-protection-bypass";
const bypassToken = `qa_${"B".repeat(40)}`;
const bypassUrl = `${previewOrigin}/?${bypassHeader}=${bypassToken}`;

function htmlResponse(status = 200, headers = {}) {
  return new Response("<!doctype html><title>Preview</title>", {
    headers: { "content-type": "text/html; charset=utf-8", ...headers },
    status,
  });
}

function captureSyncFailure(callback) {
  try {
    callback();
  } catch (error) {
    return error;
  }
  assert.fail("Expected operation to fail closed.");
}

async function captureAsyncFailure(callback) {
  try {
    await callback();
  } catch (error) {
    return error;
  }
  assert.fail("Expected operation to fail closed.");
}

function assertTokenRedacted(value) {
  assert.doesNotMatch(String(value), new RegExp(bypassToken, "u"));
}

function publicRuntimeAction(overrides = {}) {
  return {
    actorUserId: "11111111-1111-4111-8111-111111111111",
    batchId: "33333333-3333-4333-8333-333333333333",
    batchMarker: "QA-TEST-PROTECTED-PREVIEW-A-20260824",
    crossTenantActorUserId: "22222222-2222-4222-8222-222222222222",
    crossTenantBatchId: "44444444-4444-4444-8444-444444444444",
    crossTenantBatchMarker: "QA-TEST-PROTECTED-PREVIEW-B-20260824",
    crossTenantSessionCookie: `novalure_session=qa_${"c".repeat(43)}`,
    crossTenantWorkspaceId: "66666666-6666-4666-8666-666666666666",
    databaseUrl: `postgresql://novalure_app:qa-${"p".repeat(32)}@ep-preview-pooler.eu-central-1.aws.neon.tech/neondb?sslmode=require`,
    expectedDeploymentId: "dpl_JDkiRpiKMhQbaGFH9cQRaWqMyH6q",
    expectedGitRef: "codex/go-live-remediation-20260822",
    expectedGitSha: "8f2564d7e1314acde607469e572a152bd4537c2f",
    expectedNeonBranchId: "br-lucky-heart-alrm9dlw",
    expectedNeonProjectId: "weathered-term-98273025",
    previewOrigin,
    productionDatabaseHost: "ep-production-pooler.eu-central-1.aws.neon.tech",
    productionOrigin,
    sessionCookie: `novalure_session=qa_${"s".repeat(43)}`,
    shareUrl: bypassUrl,
    workspaceId: "55555555-5555-4555-8555-555555555555",
    ...overrides,
  };
}

function uuid(value) {
  return `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
}

function protectedWorkflowEnvironment(overrides = {}) {
  const candidateSha = "8f2564d7e1314acde607469e572a152bd4537c2f";
  const trustedHarnessSha = "c".repeat(40);
  const env = {
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_REF: "refs/heads/main",
    GITHUB_REPOSITORY: "novalure/novalure-crm",
    GITHUB_SHA: trustedHarnessSha,
    GITHUB_WORKFLOW_REF: "novalure/novalure-crm/.github/workflows/exact-protected-preview-qa.yml@refs/heads/main",
    NOVALURE_PRODUCTION_BRANCH_ID: "br-production-main-1234",
    NOVALURE_PRODUCTION_DATABASE_HOST: "prod-pooler.example.neon.tech",
    NOVALURE_PRODUCTION_ORIGIN: productionOrigin,
    NOVALURE_PRODUCTION_PROJECT_ID: "production-project-1234",
    NOVALURE_QA_BASE_URL: previewOrigin,
    NOVALURE_QA_BRANCH_ID: "br-lucky-heart-alrm9dlw",
    NOVALURE_QA_DATABASE_HOST: "qa-pooler.example.neon.tech",
    NOVALURE_QA_DATABASE_NAME: "neondb",
    NOVALURE_QA_DATABASE_ROLE: "novalure_app",
    NOVALURE_QA_DATABASE_URL: `postgresql://novalure_app:qa-${"p".repeat(32)}@qa-pooler.example.neon.tech/neondb?sslmode=require`,
    NOVALURE_QA_E2E_CLEANUP_CONFIRM: QA_CLEANUP_CONFIRMATION,
    NOVALURE_QA_E2E_WRITE_CONFIRM: QA_WRITE_CONFIRMATION,
    NOVALURE_QA_EXPECTED_DEPLOYMENT_ID: "dpl_JDkiRpiKMhQbaGFH9cQRaWqMyH6q",
    NOVALURE_QA_EXPECTED_GIT_BRANCH: "codex/go-live-remediation-20260822",
    NOVALURE_QA_EXPECTED_GIT_SHA: candidateSha,
    NOVALURE_QA_PASSWORD: `qa_${"p".repeat(32)}`,
    NOVALURE_QA_PROJECT_ID: "weathered-term-98273025",
    NOVALURE_QA_RESET_ADMIN_EMAIL: "qa-reset@example.test",
    NOVALURE_QA_RESET_ADMIN_TOTP_SECRET: "JBSWY3DPEHPK3PXP",
    NOVALURE_QA_RUN_PREFIX: "GOLIVETEST_20260824_BYPASS01",
    NOVALURE_QA_VERCEL_SHARE_URL: bypassUrl,
    NOVALURE_WORKFLOW_CANDIDATE_BRANCH: "codex/go-live-remediation-20260822",
    NOVALURE_WORKFLOW_CANDIDATE_SHA: candidateSha,
    NOVALURE_WORKFLOW_CONFIRMATION: "RUN_EXACT_PROTECTED_PREVIEW_QA",
    NOVALURE_WORKFLOW_DEPLOYMENT_ID: "dpl_JDkiRpiKMhQbaGFH9cQRaWqMyH6q",
    NOVALURE_WORKFLOW_ENVIRONMENT: "go-live-preview",
    NOVALURE_WORKFLOW_NEON_BRANCH_ID: "br-lucky-heart-alrm9dlw",
    NOVALURE_WORKFLOW_NEON_PROJECT_ID: "weathered-term-98273025",
    NOVALURE_WORKFLOW_PREVIEW_HOST: new URL(previewOrigin).hostname,
    NOVALURE_WORKFLOW_PREVIEW_ORIGIN: previewOrigin,
    NOVALURE_WORKFLOW_PUBLIC_BATCH_POLICY: "fresh-deployment-bound-single-use-v1",
    NOVALURE_WORKFLOW_TRUSTED_HARNESS_SHA: trustedHarnessSha,
    NOVALURE_WORKFLOW_TRUSTED_HARNESS_SHA_INPUT: trustedHarnessSha,
  };
  let nextId = 1;
  for (const key of ["A", "B"]) {
    const prefix = `NOVALURE_QA_TENANT_${key}`;
    env[`${prefix}_WORKSPACE_ID`] = uuid(nextId++);
    env[`${prefix}_PROJECT_ID`] = uuid(nextId++);
    env[`${prefix}_BATCH_ID`] = uuid(nextId++);
    env[`${prefix}_BATCH_MARKER`] = `QA-TEST-20260824-120${key === "A" ? "1" : "2"}-bypass${key.toLowerCase()}1`;
    env[`${prefix}_PUBLIC_PATH`] = `/forms/qa-${key.toLowerCase()}`;
    env[`${prefix}_RESET_ACTOR_USER_ID`] = uuid(nextId++);
    for (const actor of ["OWNER", "ADMIN", "MEMBER", "CUSTOMER"]) {
      env[`${prefix}_${actor}_EMAIL`] = `qa-${key.toLowerCase()}-${actor.toLowerCase()}@example.test`;
      env[`${prefix}_${actor}_TOTP_SECRET`] = "JBSWY3DPEHPK3PXP";
      env[`${prefix}_${actor}_USER_ID`] = uuid(nextId++);
    }
  }
  return { ...env, ...overrides };
}

function sessionPreflight(overrides = {}) {
  return evaluateQaActiveSessionPreflight({
    businessActorActiveSessionCount: 0,
    resetActorActiveSessionCount: 1,
    workflowTrust: { schema: "novalure.qa.protected-workflow-trust.v1" },
    ...overrides,
  });
}

test("two-tenant preflight derives the business-session scope without the reset actor", () => {
  const tenant = {
    actors: {
      owner: { userId: uuid(101) },
      admin: { userId: uuid(102) },
      member: { userId: uuid(103) },
      customer: { userId: uuid(104) },
    },
    resetActorUserId: uuid(105),
  };
  const scopedActorIds = qaBusinessActorUserIds(tenant);
  assert.deepEqual(scopedActorIds, [uuid(101), uuid(102), uuid(103), uuid(104)]);
  assert.equal(scopedActorIds.includes(tenant.resetActorUserId), false);
});

test("protected two-tenant preflight accepts zero business sessions and exactly one reset session", () => {
  assert.deepEqual(sessionPreflight(), {
    businessActorsClean: true,
    expectedResetActorActiveSessionCount: 1,
    ok: true,
    resetActorClean: true,
  });
});

test("protected two-tenant preflight rejects an active business-actor session", () => {
  const result = sessionPreflight({ businessActorActiveSessionCount: 1 });
  assert.equal(result.businessActorsClean, false);
  assert.equal(result.resetActorClean, true);
  assert.equal(result.ok, false);
});

test("protected two-tenant preflight rejects missing or duplicate reset-actor sessions", () => {
  for (const resetActorActiveSessionCount of [0, 2]) {
    const result = sessionPreflight({ resetActorActiveSessionCount });
    assert.equal(result.businessActorsClean, true);
    assert.equal(result.resetActorClean, false);
    assert.equal(result.ok, false);
  }
});

test("standalone two-tenant preflight requires zero reset-actor sessions", () => {
  const clean = sessionPreflight({ resetActorActiveSessionCount: 0, workflowTrust: null });
  assert.equal(clean.expectedResetActorActiveSessionCount, 0);
  assert.equal(clean.resetActorClean, true);
  assert.equal(clean.ok, true);

  const stale = sessionPreflight({ workflowTrust: null });
  assert.equal(stale.expectedResetActorActiveSessionCount, 0);
  assert.equal(stale.resetActorClean, false);
  assert.equal(stale.ok, false);
});

test("automation bypass accepts only the exact Preview host, root and single query", () => {
  const receipt = validateVercelAutomationBypassUrl(bypassUrl, previewOrigin);
  assert.deepEqual(receipt, {
    mode: "AUTOMATION_BYPASS",
    origin: previewOrigin,
    requestUrl: `${previewOrigin}/`,
  });
  assert.equal(Object.isFrozen(receipt), true);
  assertTokenRedacted(JSON.stringify(receipt));

  const target = {};
  const bindingReceipt = bindVercelAutomationBypass(target, bypassUrl, previewOrigin);
  assert.equal(hasVercelAutomationBypass(target), true);
  assert.deepEqual(bindingReceipt, receipt);
  assertTokenRedacted(JSON.stringify(bindingReceipt));

  const headers = new Headers({ accept: "text/html" });
  assert.equal(applyVercelAutomationBypass(target, `${previewOrigin}/api/health`, headers), true);
  assert.equal(headers.get(bypassHeader), bypassToken);

  const unboundHeaders = new Headers();
  assert.equal(applyVercelAutomationBypass({}, `${previewOrigin}/`, unboundHeaders), false);
  assert.equal(unboundHeaders.has(bypassHeader), false);

  const crossOriginHeaders = new Headers();
  const crossOriginError = captureSyncFailure(
    () => applyVercelAutomationBypass(target, `${productionOrigin}/api/health`, crossOriginHeaders),
  );
  assert.equal(crossOriginHeaders.has(bypassHeader), false);
  assertTokenRedacted(crossOriginError.message);
});

test("automation bypass rejects production, origin drift and ambiguous URL shapes without disclosing the token", () => {
  const invalidCases = [
    { label: "canonical production", origin: productionOrigin, url: `${productionOrigin}/?${bypassHeader}=${bypassToken}` },
    { label: "production Vercel alias", origin: productionVercelOrigin, url: `${productionVercelOrigin}/?${bypassHeader}=${bypassToken}` },
    { label: "wrong host", origin: previewOrigin, url: `https://other-preview.vercel.app/?${bypassHeader}=${bypassToken}` },
    { label: "explicit default port", origin: previewOrigin, url: `${previewOrigin.replace(".app", ".app:443")}/?${bypassHeader}=${bypassToken}` },
    { label: "non-default port", origin: previewOrigin, url: `${previewOrigin.replace(".app", ".app:8443")}/?${bypassHeader}=${bypassToken}` },
    { label: "non-root path", origin: previewOrigin, url: `${previewOrigin}/login?${bypassHeader}=${bypassToken}` },
    { label: "userinfo", origin: previewOrigin, url: `${previewOrigin.replace("https://", "https://qa-user:qa-pass@")}/?${bypassHeader}=${bypassToken}` },
    { label: "fragment", origin: previewOrigin, url: `${bypassUrl}#fragment` },
    { label: "duplicate bypass key", origin: previewOrigin, url: `${bypassUrl}&${bypassHeader}=${bypassToken}` },
    { label: "additional key", origin: previewOrigin, url: `${bypassUrl}&next=%2F` },
    { label: "Share parameter", origin: previewOrigin, url: `${previewOrigin}/?_vercel_share=${bypassToken}` },
  ];

  for (const entry of invalidCases) {
    const error = captureSyncFailure(() => validateVercelAutomationBypassUrl(entry.url, entry.origin));
    assert.match(error.message, /automation access is invalid/u, entry.label);
    assertTokenRedacted(error.message);
  }
});

test("protected workflow contract accepts only the exact automation-bypass form", () => {
  const valid = protectedWorkflowEnvironment();
  const receipt = validateProtectedPreviewWorkflowContract(valid);
  assert.equal(receipt.candidateSha, valid.NOVALURE_QA_EXPECTED_GIT_SHA);
  assert.equal(receipt.deploymentId, valid.NOVALURE_QA_EXPECTED_DEPLOYMENT_ID);
  assertTokenRedacted(JSON.stringify(receipt));

  for (const shareUrl of [
    `${previewOrigin}/?_vercel_share=${bypassToken}`,
    `https://other-preview.vercel.app/?${bypassHeader}=${bypassToken}`,
  ]) {
    const error = captureSyncFailure(() => validateProtectedPreviewWorkflowContract({
      ...valid,
      NOVALURE_QA_VERCEL_SHARE_URL: shareUrl,
    }));
    assertTokenRedacted(error.message);
  }
});

test("protected Public input and workflow require deployment-bound automation access", () => {
  const encoded = Buffer.from(JSON.stringify(publicRuntimeAction()), "utf8").toString("base64");
  const decoded = decodeProtectedPublicInput(encoded);
  const expected = validateProtectedPublicWorkflowInput(decoded, protectedWorkflowEnvironment());
  assert.equal(expected.candidateSha, decoded.expectedGitSha);
  assert.equal(expected.deploymentId, decoded.expectedDeploymentId);
  assertTokenRedacted(JSON.stringify(expected));

  const missingAccessError = captureSyncFailure(() => decodeProtectedPublicInput(
    Buffer.from(JSON.stringify(publicRuntimeAction({ shareUrl: "" })), "utf8").toString("base64"),
  ));
  assert.equal(missingAccessError.message, "SHARE_ACCESS_REQUIRED");

  const unboundWorkflowError = captureSyncFailure(() => validateProtectedPublicWorkflowInput(
    { ...decoded, shareUrl: null },
    protectedWorkflowEnvironment(),
  ));
  assert.equal(unboundWorkflowError.message, "PROTECTED_PUBLIC_AUTOMATION_ACCESS_REQUIRED");
  assertTokenRedacted(unboundWorkflowError.message);
});

test("protected Public evidence rejects a STANDARD access result before staging", async () => {
  const error = await captureAsyncFailure(() => stageProtectedPublicEvidence(
    { previewAccess: "STANDARD" },
    {},
    { runnerTemp: process.cwd() },
  ));
  assert.equal(error.message, "PROTECTED_PUBLIC_AUTOMATION_ACCESS_EVIDENCE_INVALID");
});

test("two-tenant bootstrap sends the bypass only as a header on a query-free direct HTML request", async () => {
  const bootstrapRequests = [];
  const previewAccess = await bootstrapPreviewShareCookies(previewOrigin, bypassUrl, async (url, init) => {
    bootstrapRequests.push({ init, url: url.toString() });
    return htmlResponse();
  });

  assert.equal(bootstrapRequests.length, 1);
  assert.equal(bootstrapRequests[0].url, `${previewOrigin}/`);
  assert.equal(new URL(bootstrapRequests[0].url).search, "");
  assert.equal(new Headers(bootstrapRequests[0].init.headers).get(bypassHeader), bypassToken);
  assert.equal(hasVercelAutomationBypass(previewAccess), true);

  const evidence = { requests: [] };
  const followUpRequests = [];
  const client = createHttpClient(
    { baseUrl: previewOrigin },
    {},
    { batchId: "33333333-3333-4333-8333-333333333333" },
    evidence,
    previewAccess,
    async (url, init) => {
      followUpRequests.push({ init, url: url.toString() });
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "content-type": "application/json" },
        status: 200,
      });
    },
  );
  const result = await client.request("/api/health?probe=protected-preview");
  assert.equal(result.response.status, 200);

  assert.equal(followUpRequests.length, 1);
  assert.equal(new Headers(followUpRequests[0].init.headers).get(bypassHeader), bypassToken);
  assert.equal(new URL(followUpRequests[0].url).searchParams.has(bypassHeader), false);
  assertTokenRedacted(JSON.stringify(evidence));
});

test("two-tenant automation bootstrap fails closed on redirects, network errors and non-HTML responses", async () => {
  const cases = [
    {
      label: "redirect",
      fetchImpl: async () => new Response(null, { headers: { location: `${previewOrigin}/login` }, status: 302 }),
    },
    {
      label: "network",
      fetchImpl: async () => { throw new TypeError("simulated network failure"); },
    },
    {
      label: "non-HTML",
      fetchImpl: async () => new Response("{}", { headers: { "content-type": "application/json" }, status: 200 }),
    },
  ];

  for (const entry of cases) {
    const error = await captureAsyncFailure(
      () => bootstrapPreviewShareCookies(previewOrigin, bypassUrl, entry.fetchImpl),
    );
    assertTokenRedacted(error?.message ?? error);
    assert.notEqual(error, undefined, entry.label);
  }
});

test("two-tenant CSRF and anonymous runtime requests retain the exact-origin bypass header", async () => {
  const previewAccess = await bootstrapPreviewShareCookies(
    previewOrigin,
    bypassUrl,
    async () => htmlResponse(),
  );
  previewAccess.set("novalure_session", `qa_${"s".repeat(43)}`);
  const requests = [];
  const client = createHttpClient(
    { baseUrl: previewOrigin },
    {},
    { batchId: "33333333-3333-4333-8333-333333333333" },
    { requests: [] },
    previewAccess,
    async (url, init) => {
      requests.push({ headers: new Headers(init.headers), url: url.toString() });
      if (url.pathname === "/api/auth/csrf") {
        assert.equal(init.redirect, "manual");
        return new Response(JSON.stringify({ csrfToken: `csrf_${"x".repeat(32)}` }), {
          headers: { "content-type": "application/json" },
          status: 200,
        });
      }
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "content-type": "application/json" },
        status: 200,
      });
    },
  );
  await client.request("/api/mutation", { json: { ok: true }, method: "POST" });
  assert.equal(requests.length, 2);
  assert.equal(requests[0].headers.get(bypassHeader), bypassToken);
  assert.equal(requests[1].headers.get(bypassHeader), bypassToken);
  assert.equal(requests.every((request) => !new URL(request.url).searchParams.has(bypassHeader)), true);

  const anonymousRequests = [];
  const anonymousError = await captureAsyncFailure(() => verifyPreviewRuntimeIdentity(
    {
      baseUrl: previewOrigin,
      database: {},
      expectedDeploymentId: `dpl_${"D".repeat(24)}`,
      expectedGitBranch: "codex/go-live-remediation-20260822",
      expectedGitSha: "8f2564d7e1314acde607469e572a152bd4537c2f",
    },
    { requests: [], results: [] },
    previewAccess,
    async (url, init) => {
      anonymousRequests.push({ headers: new Headers(init.headers), url: url.toString() });
      return new Response("{}", { headers: { "content-type": "application/json" }, status: 503 });
    },
  ));
  assert.equal(anonymousRequests.length, 1);
  assert.equal(anonymousRequests[0].headers.get(bypassHeader), bypassToken);
  assert.equal(new URL(anonymousRequests[0].url).searchParams.has(bypassHeader), false);
  assertTokenRedacted(anonymousError.message);
});

test("public runtime parser and bootstrap keep the bypass secret non-enumerable and use a direct header", async () => {
  const input = parsePublicRuntimeActionInput(JSON.stringify(publicRuntimeAction()));
  assert.equal(input.shareUrl, bypassUrl);
  assert.equal(Object.keys(input).includes("shareUrl"), false);
  assertTokenRedacted(JSON.stringify(input));

  const jar = createPublicRuntimeCookieJar(input.sessionCookie);
  const bootstrapRequests = [];
  const access = await bootstrapPublicRuntimeShareAccess(input, jar, async (url, init) => {
    bootstrapRequests.push({ init, url: url.toString() });
    return htmlResponse();
  });

  assert.equal(bootstrapRequests.length, 1);
  assert.equal(bootstrapRequests[0].url, `${previewOrigin}/`);
  assert.equal(new URL(bootstrapRequests[0].url).search, "");
  assert.equal(new Headers(bootstrapRequests[0].init.headers).get(bypassHeader), bypassToken);
  assert.equal(hasVercelAutomationBypass(jar), true);
  assertTokenRedacted(JSON.stringify(access));

  const followUpRequests = [];
  const response = await requestExact(input, jar, async (url, init) => {
    followUpRequests.push({ init, url: url.toString() });
    return new Response(JSON.stringify({ ok: true }), {
      headers: { "content-type": "application/json" },
      status: 200,
    });
  }, "/api/health?probe=public-runtime");
  assert.equal(response.response.status, 200);
  assert.equal(followUpRequests.length, 1);
  assert.equal(new Headers(followUpRequests[0].init.headers).get(bypassHeader), bypassToken);
  assert.equal(new URL(followUpRequests[0].url).searchParams.has(bypassHeader), false);
});

test("public runtime automation bootstrap fails closed on redirects, network errors and non-HTML responses", async () => {
  const cases = [
    {
      label: "redirect",
      fetchImpl: async () => new Response(null, { headers: { location: `${previewOrigin}/login` }, status: 302 }),
    },
    {
      label: "network",
      fetchImpl: async () => { throw new TypeError("simulated network failure"); },
    },
    {
      label: "non-HTML",
      fetchImpl: async () => new Response("{}", { headers: { "content-type": "application/json" }, status: 200 }),
    },
  ];

  for (const entry of cases) {
    const input = parsePublicRuntimeActionInput(JSON.stringify(publicRuntimeAction()));
    const jar = createPublicRuntimeCookieJar(input.sessionCookie);
    const error = await captureAsyncFailure(
      () => bootstrapPublicRuntimeShareAccess(input, jar, entry.fetchImpl),
    );
    assertTokenRedacted(error?.message ?? error);
    assert.notEqual(error, undefined, entry.label);
  }
});
