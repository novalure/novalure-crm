import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  ProviderFailClosedRunnerError,
  assertEvidenceIsRedacted,
  compareDatabaseSnapshots,
  executeProviderFailClosedPreview,
  parseProviderFailClosedInput,
  providerFailClosedCapabilityPath,
  providerFailClosedDatabaseTables,
  providerFailClosedScenarios,
} from "./lib/provider-fail-closed-preview.mjs";
import { writeProviderFailClosedEvidence } from "./provider-fail-closed-preview.mjs";

const commitSha = "a".repeat(40);
const gitRef = "codex/go-live-remediation-20260822";
const branchId = "br-lucky-heart-alrm9dlw";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const userId = "22222222-2222-4222-8222-222222222222";
const previewOrigin = "https://candidate-preview-novalure.vercel.app";
const deploymentId = "dpl_ProviderPreviewContract1";

function input(overrides = {}) {
  return parseProviderFailClosedInput(JSON.stringify({
    expectedDeploymentId: deploymentId,
    expectedGitRef: gitRef,
    expectedGitSha: commitSha,
    previewOrigin,
    sessionCookie: `novalure_session=${"s".repeat(48)}`,
    verifyDatabaseWrites: false,
    workspaceKey: "A",
    ...overrides,
  }));
}

function environment(overrides = {}) {
  return {
    NOVALURE_QA_BRANCH_ID: branchId,
    NOVALURE_QA_TENANT_A_RESET_ACTOR_USER_ID: userId,
    NOVALURE_QA_TENANT_A_WORKSPACE_ID: workspaceId,
    ...overrides,
  };
}

function jsonResponse(body, status = 200, headers = {}) {
  return Response.json(body, { headers, status });
}

function createFetchFixture(overrides = {}) {
  const calls = [];
  let shareRootCalls = 0;
  const fetchImpl = async (value, init = {}) => {
    const url = new URL(value);
    const headers = new Headers(init.headers ?? {});
    const cookieNames = (headers.get("cookie") ?? "")
      .split(";")
      .map((pair) => pair.trim().split("=", 1)[0])
      .filter(Boolean)
      .sort();
    calls.push({
      cookieNames,
      csrf: headers.has("x-novalure-csrf-token"),
      hasCookie: headers.has("cookie"),
      method: init.method ?? "GET",
      origin: url.origin,
      path: url.pathname,
      queryKeys: [...url.searchParams.keys()].sort(),
      requestedCsrfMethod: url.searchParams.get("method"),
      requestedCsrfPath: url.searchParams.get("path"),
    });
    if (overrides.share && url.origin === "https://vercel.com") {
      const responseHeaders = new Headers({ location: `${previewOrigin}/?_vercel_share=${url.searchParams.get("_vercel_share")}` });
      responseHeaders.append("set-cookie", "_vercel_landing=landing.access.value; Path=/; Secure; HttpOnly");
      return new Response(null, { headers: responseHeaders, status: 302 });
    }
    if (overrides.share && url.pathname === "/") {
      shareRootCalls += 1;
      if (url.searchParams.has("_vercel_share")) {
        const responseHeaders = new Headers({ location: "/" });
        responseHeaders.append("set-cookie", "_vercel_jwt=preview.access.value; Path=/; Secure; HttpOnly");
        responseHeaders.append("set-cookie", "novalure_session=must-not-bootstrap; Path=/; Secure; HttpOnly");
        return new Response(null, { headers: responseHeaders, status: 302 });
      }
      if (shareRootCalls === 2) {
        return new Response("preview", { headers: { "content-type": "text/html; charset=utf-8" }, status: 200 });
      }
      return new Response(overrides.shareFinalStatus === 302 ? null : "preview", {
        headers: {
          "content-type": overrides.shareFinalType ?? "text/html; charset=utf-8",
          ...(overrides.shareFinalStatus === 302 ? { location: "/" } : {}),
        },
        status: overrides.shareFinalStatus ?? 200,
      });
    }
    if (url.pathname === "/api/auth/session") {
      return jsonResponse({
        authenticated: true,
        source: "cookie",
        user: { id: userId, productRole: "platform_admin", role: "owner" },
        workspace: { id: workspaceId },
      });
    }
    if (url.pathname === providerFailClosedCapabilityPath) {
      return jsonResponse({
        atomicRegistration: true,
        databaseBranchId: branchId,
        deploymentId: overrides.deploymentId ?? deploymentId,
        deploymentHost: overrides.deploymentHost ?? new URL(previewOrigin).hostname,
        gitBranch: overrides.gitBranch ?? gitRef,
        gitSha: overrides.gitSha ?? commitSha,
        version: 2,
      });
    }
    if (url.pathname === "/api/auth/csrf") {
      return jsonResponse({ csrfToken: "c".repeat(48) });
    }
    return jsonResponse({ code: overrides.launchCode ?? "LAUNCH_SCOPE_OFF" }, overrides.status ?? 503);
  };
  return { calls, fetchImpl };
}

test("action input is exact-origin, final-SHA, branch-bound and stdin-shaped", () => {
  const parsed = input();
  assert.equal(parsed.previewOrigin, previewOrigin);
  assert.equal(parsed.expectedGitSha, commitSha);
  assert.equal(parsed.expectedGitRef, gitRef);
  assert.equal(parsed.expectedDeploymentId, deploymentId);
  assert.equal(parsed.verifyDatabaseWrites, false);
  for (const override of [
    { previewOrigin: "https://www.novalure-crm.app" },
    { previewOrigin: `${previewOrigin}/path` },
    { expectedGitSha: "short" },
    { expectedGitRef: "main" },
    { expectedDeploymentId: "preview-not-a-deployment" },
    { sessionCookie: "novalure_session=short" },
    { unexpected: "value" },
  ]) {
    assert.throws(() => input(override), ProviderFailClosedRunnerError);
  }
  assert.throws(
    () => input({ shareUrl: `${previewOrigin}/?_vercel_share=short` }),
    (error) => error.code === "SHARE_ACCESS_INVALID",
  );
});

test("scenario matrix covers public reset, every authenticated invite/reset route, calendar and both OAuth providers", () => {
  assert.equal(providerFailClosedScenarios.length, 13);
  assert.deepEqual(providerFailClosedScenarios.map((scenario) => scenario.id), [
    "public.password-reset-request",
    "settings.invitation-email",
    "settings.invitation-email-resend",
    "settings.password-reset-email",
    "customer-access.invitation-email",
    "calendar.google-mutation",
    "calendar.microsoft-mutation",
    "oauth.google.start",
    "oauth.google.callback",
    "oauth.google.disconnect",
    "oauth.microsoft.start",
    "oauth.microsoft.callback",
    "oauth.microsoft.disconnect",
  ]);
});

test("database postconditions retain full before/after fingerprints and detect same-count mutations", () => {
  const snapshot = (fingerprintValue) => ({
    reasonCode: null,
    snapshot: Object.fromEntries(providerFailClosedDatabaseTables.map((table) => [table, {
      count: 2,
      fingerprint: `sha256:${fingerprintValue.repeat(64)}`,
    }])),
    status: "CAPTURED",
  });
  const unchanged = compareDatabaseSnapshots(snapshot("a"), snapshot("a"));
  assert.equal(unchanged.status, "PASS");
  assert.equal(Object.values(unchanged.tables).every((table) =>
    table.beforeFingerprint === table.afterFingerprint
      && /^sha256:[a-f0-9]{64}$/u.test(table.beforeFingerprint)), true);

  const changed = compareDatabaseSnapshots(snapshot("a"), snapshot("b"));
  assert.equal(changed.status, "FAIL");
  assert.equal(changed.reasonCode, "DATABASE_WRITE_OBSERVED");
  assert.equal(Object.values(changed.tables).every((table) => table.beforeCount === table.afterCount), true);
  assert.equal(Object.values(changed.tables).every((table) => table.unchanged === false), true);
});

test("runtime runner requires 503 LAUNCH_SCOPE_OFF with method/path-bound CSRF and emits redacted BLOCKED evidence", async () => {
  const fixture = createFetchFixture();
  const evidence = await executeProviderFailClosedPreview({
    env: environment(),
    fetchImpl: fixture.fetchImpl,
    input: input(),
    requireLocalIdentity: false,
  });
  assert.equal(evidence.httpTechnicalStatus, "PASS");
  assert.equal(evidence.releaseGateStatus, "BLOCKED");
  assert.equal(evidence.databaseWritePostcondition.status, "UNPROVEN");
  assert.equal(evidence.providerSideEffectPostcondition.independentProviderLogs, "UNPROVEN");
  assert.equal(evidence.cleanup.databaseCleanup, "UNPROVEN");
  assert.equal(evidence.cleanup.status, "PARTIAL");
  assert.equal(evidence.requests.length, 15);
  assert.equal(evidence.requests.slice(2).every((row) => row.status === 503 && row.code === "LAUNCH_SCOPE_OFF"), true);
  assert.equal(assertEvidenceIsRedacted(evidence), true);

  const targetCalls = fixture.calls.filter((call) => providerFailClosedScenarios.some((scenario) => new URL(scenario.path, previewOrigin).pathname === call.path));
  const publicReset = targetCalls.find((call) => call.path === "/api/auth/password-reset/request");
  assert.equal(publicReset.hasCookie, false);
  assert.equal(publicReset.csrf, false);
  const csrfCalls = fixture.calls.filter((call) => call.path === "/api/auth/csrf");
  assert.equal(csrfCalls.length, 8);
  assert.equal(csrfCalls.every((call) => call.requestedCsrfMethod === "POST" && call.requestedCsrfPath?.startsWith("/api/")), true);
  for (const call of targetCalls.filter((candidate) => candidate.method === "POST" && candidate.path !== "/api/auth/password-reset/request")) {
    assert.equal(call.hasCookie, true);
    assert.equal(call.csrf, true);
  }
  assert.equal(fixture.calls.every((call) => call.origin === previewOrigin), true);
});

test("runtime identity drift and non-503 launch responses fail closed without response-body leakage", async () => {
  const shaDrift = createFetchFixture({ gitSha: "b".repeat(40) });
  await assert.rejects(
    executeProviderFailClosedPreview({ env: environment(), fetchImpl: shaDrift.fetchImpl, input: input(), requireLocalIdentity: false }),
    (error) => error.code === "PREVIEW_RUNTIME_IDENTITY_MISMATCH",
  );
  const hostDrift = createFetchFixture({ deploymentHost: "other-preview-novalure.vercel.app" });
  await assert.rejects(
    executeProviderFailClosedPreview({ env: environment(), fetchImpl: hostDrift.fetchImpl, input: input(), requireLocalIdentity: false }),
    (error) => error.code === "PREVIEW_RUNTIME_IDENTITY_MISMATCH",
  );
  const deploymentDrift = createFetchFixture({ deploymentId: "dpl_WrongProviderPreview2" });
  await assert.rejects(
    executeProviderFailClosedPreview({ env: environment(), fetchImpl: deploymentDrift.fetchImpl, input: input(), requireLocalIdentity: false }),
    (error) => error.code === "PREVIEW_RUNTIME_IDENTITY_MISMATCH",
  );
  const launchDrift = createFetchFixture({ launchCode: "unexpected-private-body", status: 200 });
  await assert.rejects(
    executeProviderFailClosedPreview({ env: environment(), fetchImpl: launchDrift.fetchImpl, input: input(), requireLocalIdentity: false }),
    (error) => {
      assert.equal(error.code, "FAIL_CLOSED_HTTP_CONTRACT_FAILED");
      assert.doesNotMatch(error.message, /unexpected-private-body/u);
      return true;
    },
  );
});

test("share access persists only secure Vercel cookies and requires a final 2xx HTML landing", async () => {
  const shareToken = "share_access_token_1234567890";
  const shareUrl = `${previewOrigin}/?_vercel_share=${shareToken}`;
  const fixture = createFetchFixture({ share: true });
  await executeProviderFailClosedPreview({
    env: environment(),
    fetchImpl: fixture.fetchImpl,
    input: input({ shareUrl }),
    requireLocalIdentity: false,
  });
  const sessionCall = fixture.calls.find((call) => call.path === "/api/auth/session");
  assert.deepEqual(sessionCall.cookieNames, ["_vercel_jwt", "novalure_session"]);
  const publicResetCall = fixture.calls.find((call) => call.path === "/api/auth/password-reset/request");
  assert.deepEqual(publicResetCall.cookieNames, ["_vercel_jwt"]);

  const vercelLandingFixture = createFetchFixture({ share: true });
  await executeProviderFailClosedPreview({
    env: environment(),
    fetchImpl: vercelLandingFixture.fetchImpl,
    input: input({ shareUrl: `https://vercel.com/share/candidate?_vercel_share=${shareToken}` }),
    requireLocalIdentity: false,
  });
  const firstPreviewShareCall = vercelLandingFixture.calls.find((call) => call.origin === previewOrigin && call.queryKeys.includes("_vercel_share"));
  assert.deepEqual(firstPreviewShareCall.cookieNames, []);

  for (const invalid of [
    { share: true, shareFinalStatus: 302 },
    { share: true, shareFinalType: "application/json" },
  ]) {
    const invalidFixture = createFetchFixture(invalid);
    await assert.rejects(
      executeProviderFailClosedPreview({
        env: environment(),
        fetchImpl: invalidFixture.fetchImpl,
        input: input({ shareUrl }),
        requireLocalIdentity: false,
      }),
      (error) => error.code === "SHARE_ACCESS_FAILED",
    );
  }
});

test("evidence rejects URLs, cookies, tokens and email addresses and persists with a matching sidecar", async () => {
  for (const unsafe of [
    { value: previewOrigin },
    { value: "novalure_session=secret-value" },
    { value: "https://candidate.example.test/?_vercel_share=secret-value" },
    { value: "person@example.test" },
  ]) {
    assert.throws(() => assertEvidenceIsRedacted(unsafe), (error) => error.code === "EVIDENCE_REDACTION_FAILED");
  }

  const directory = await mkdtemp(path.join(tmpdir(), "provider-fail-closed-evidence-"));
  try {
    const evidence = { httpTechnicalStatus: "PASS", releaseGateStatus: "BLOCKED", schemaVersion: 1 };
    const written = await writeProviderFailClosedEvidence(evidence, directory);
    const sidecar = await readFile(written.sidecarPath, "utf8");
    assert.match(sidecar, new RegExp(`^${written.digest}  provider-fail-closed-evidence\\.json\\n$`, "u"));
    await assert.rejects(
      writeProviderFailClosedEvidence({ ...evidence, httpTechnicalStatus: "FAIL" }, directory),
      (error) => error?.code === "EEXIST",
    );
    assert.equal(JSON.parse(await readFile(written.finalPath, "utf8")).httpTechnicalStatus, "PASS");
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("route ordering keeps launch gates before provider and database side effects", async () => {
  const read = (relativePath) => readFile(new URL(`../${relativePath}`, import.meta.url), "utf8");
  const publicReset = await read("src/app/api/auth/password-reset/request/route.ts");
  const settings = await read("src/app/api/settings/access/users/route.ts");
  const customerAccess = await read("src/app/api/crm/customer-access/route.ts");
  const google = await read("src/app/api/calendar/google/route.ts");
  const microsoft = await read("src/app/api/calendar/microsoft/route.ts");
  const oauthStart = await read("src/app/api/meetings/oauth/[provider]/start/route.ts");
  const oauthCallback = await read("src/app/api/meetings/oauth/[provider]/callback/route.ts");
  const oauthDisconnect = await read("src/app/api/meetings/oauth/[provider]/disconnect/route.ts");
  const capability = await read("src/app/api/admin/qa-batch-capability/route.ts");
  const runtimeIdentity = await read("src/lib/qa-runtime-identity.ts");

  const handler = (source, marker) => source.slice(source.indexOf(marker));
  const precedes = (source, gate, effects) => {
    const gateIndex = source.indexOf(gate);
    assert.ok(gateIndex >= 0, `Missing gate ${gate}`);
    for (const effect of effects) assert.ok(gateIndex < source.indexOf(effect), `${gate} must precede ${effect}`);
  };
  precedes(handler(publicReset, "export async function POST"), "evaluateLaunchScope", ["validateCsrfRequestContext", "requestPasswordReset({"]);
  precedes(handler(settings, "export async function POST"), "const launchScope", ["resendWorkspaceInvitation({", "triggerWorkspacePasswordReset({", "inviteSettingsWorkspaceUser({"]);
  precedes(handler(customerAccess, "export async function PATCH"), "evaluateLaunchScope", ["inviteWorkspaceUser({"]);
  precedes(handler(google, "export async function POST"), "evaluateLaunchScope", ["readJson(request)", "syncGoogleCalendarEvent({", "insertCalendarSyncEvent({"]);
  precedes(handler(microsoft, "export async function POST"), "evaluateLaunchScope", ["readJson(request)", "syncMicrosoftCalendarEvent({", "insertCalendarSyncEvent({", "upsertProviderConnection({"]);
  precedes(handler(oauthStart, "export async function GET"), "evaluateLaunchScope", ["createOAuthState({", "getOAuthAuthorizationUrl({"]);
  precedes(handler(oauthCallback, "export async function GET"), "evaluateLaunchScope", ["consumeOAuthState({", "exchangeOAuthCode({", "upsertCalendarOAuthConnection({"]);
  precedes(handler(oauthDisconnect, "export async function POST"), "evaluateLaunchScope", ["disconnectCalendarOAuthConnection({"]);
  assert.match(runtimeIdentity, /current_setting\('neon\.branch_id', true\) as "databaseBranchId"/u);
  assert.match(runtimeIdentity, /current_setting\('neon\.project_id', true\) as "databaseProjectId"/u);
  assert.match(capability, /deploymentHost: config\.deploymentHost/u);
  assert.match(capability, /gitBranch: config\.gitBranch/u);
  assert.match(capability, /databaseBranchId: capability\.databaseIdentity\.databaseBranchId/u);
  assert.match(capability, /isQaRuntimeDatabaseIdentityReady\(capability\.databaseIdentity\)/u);
});

test("CLI source accepts no URL, cookie or token arguments and keeps release BLOCKED non-zero", async () => {
  const source = await readFile(new URL("./provider-fail-closed-preview.mjs", import.meta.url), "utf8");
  assert.match(source, /new Set\(\["--execute", "--help", "-h", "--input-stdin"\]\)/u);
  assert.doesNotMatch(source, /--(?:base-url|share-url|session-cookie|token|password)/u);
  assert.match(source, /releaseGateStatus === "BLOCKED" \? 2 : 0/u);
});

test("failed CLI input writes only redacted BLOCKED evidence and never echoes action-time values", async () => {
  const directory = await mkdtemp(path.join(process.cwd(), "artifacts", "qa", "provider-fail-closed-cli-test-"));
  const script = fileURLToPath(new URL("./provider-fail-closed-preview.mjs", import.meta.url));
  const secretMarker = "do-not-echo-share-or-session-value";
  try {
    const result = spawnSync(process.execPath, [script, "--execute", "--input-stdin"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, NOVALURE_QA_PROVIDER_EVIDENCE_DIR: directory },
      input: JSON.stringify({
        previewOrigin: `https://${secretMarker}.vercel.app`,
        sessionCookie: `novalure_session=${secretMarker}`,
        unexpected: secretMarker,
      }),
      timeout: 30_000,
    });
    assert.equal(result.status, 1);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, new RegExp(secretMarker, "u"));
    const evidence = JSON.parse(await readFile(path.join(directory, "provider-fail-closed-evidence.json"), "utf8"));
    assert.equal(evidence.releaseGateStatus, "BLOCKED");
    assert.equal(evidence.httpTechnicalStatus, "FAIL");
    assert.equal(evidence.databaseWritePostcondition.status, "UNPROVEN");
    assert.equal(evidence.providerSideEffectPostcondition.independentProviderLogs, "UNPROVEN");
    assert.equal(assertEvidenceIsRedacted(evidence), true);
    assert.doesNotMatch(JSON.stringify(evidence), new RegExp(secretMarker, "u"));
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});
