import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { neon } from "@neondatabase/serverless";

export const providerFailClosedCapabilityPath = "/api/admin/qa-batch-capability";

const allowedInputKeys = new Set([
  "expectedDeploymentId",
  "expectedGitRef",
  "expectedGitSha",
  "previewOrigin",
  "sessionCookie",
  "shareUrl",
  "verifyDatabaseWrites",
  "workspaceKey",
]);
const mutatingMethods = new Set(["DELETE", "PATCH", "POST", "PUT"]);
const productionHosts = new Set([
  "novalure-crm.vercel.app",
  "novalure-crm-novalure.vercel.app",
  "novalure-crm.app",
  "www.novalure-crm.app",
]);
const safeGitRefPattern = /^codex\/[A-Za-z0-9._/-]{1,180}$/u;
const safeGitShaPattern = /^[a-f0-9]{40}$/u;
const safeDeploymentIdPattern = /^dpl_[A-Za-z0-9]{20,80}$/u;
const safeNeonBranchPattern = /^br-[A-Za-z0-9-]{8,128}$/u;
const safeUuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const vercelShareLandingOrigin = "https://vercel.com";

export class ProviderFailClosedRunnerError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
    this.name = "ProviderFailClosedRunnerError";
  }
}

function fail(code) {
  throw new ProviderFailClosedRunnerError(code);
}

function clean(value) {
  return typeof value === "string" ? value.trim() : "";
}

function sha256(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

export function fingerprint(value, length = 16) {
  return `sha256:${sha256(value).slice(0, length)}`;
}

function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, normalize(value[key])]));
}

export function canonicalJson(value) {
  return `${JSON.stringify(normalize(value), null, 2)}\n`;
}

export function assertEvidenceIsRedacted(value) {
  const serialized = canonicalJson(value);
  if (
    /(?:https?|postgres(?:ql)?):\/\//iu.test(serialized)
    || /_vercel_share|novalure_session=|x-vercel-protection-bypass/iu.test(serialized)
    || /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/iu.test(serialized)
  ) {
    fail("EVIDENCE_REDACTION_FAILED");
  }
  return true;
}

function validateOrigin(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail("PREVIEW_ORIGIN_INVALID");
  }
  if (
    parsed.protocol !== "https:"
    || parsed.pathname !== "/"
    || parsed.search
    || parsed.hash
    || parsed.username
    || parsed.password
    || !parsed.hostname.endsWith(".vercel.app")
    || productionHosts.has(parsed.hostname.toLowerCase())
  ) {
    fail("PREVIEW_ORIGIN_INVALID");
  }
  return parsed.origin;
}

function validateShareUrl(value, previewOrigin) {
  if (!value) return null;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail("SHARE_ACCESS_INVALID");
  }
  if (
    (parsed.origin !== previewOrigin && parsed.origin !== vercelShareLandingOrigin)
    || parsed.hash
    || parsed.username
    || parsed.password
    || [...parsed.searchParams.keys()].length !== 1
    || !parsed.searchParams.has("_vercel_share")
    || !/^[A-Za-z0-9_-]{20,512}$/u.test(parsed.searchParams.get("_vercel_share") ?? "")
  ) {
    fail("SHARE_ACCESS_INVALID");
  }
  if (parsed.origin === previewOrigin && parsed.pathname !== "/") fail("SHARE_ACCESS_INVALID");
  if (
    parsed.origin === vercelShareLandingOrigin
    && (
      parsed.pathname.length > 1_024
      || parsed.pathname.startsWith("//")
      || /[\\\u0000-\u001f\u007f]/u.test(parsed.pathname)
    )
  ) {
    fail("SHARE_ACCESS_INVALID");
  }
  return parsed;
}

function validateSessionCookie(value) {
  if (!value || value.length > 4_096 || /[\r\n]/u.test(value)) fail("SESSION_INPUT_INVALID");
  const first = value.split(";", 1)[0]?.trim() ?? "";
  if (!/^novalure_session=[A-Za-z0-9._~-]{20,4096}$/u.test(first)) fail("SESSION_INPUT_INVALID");
  return first;
}

export function parseProviderFailClosedInput(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail("ACTION_INPUT_INVALID");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) fail("ACTION_INPUT_INVALID");
  for (const key of Object.keys(parsed)) {
    if (!allowedInputKeys.has(key)) fail("ACTION_INPUT_INVALID");
  }
  const expectedGitSha = clean(parsed.expectedGitSha).toLowerCase();
  const expectedGitRef = clean(parsed.expectedGitRef);
  const expectedDeploymentId = clean(parsed.expectedDeploymentId);
  if (
    !safeGitShaPattern.test(expectedGitSha)
    || !safeGitRefPattern.test(expectedGitRef)
    || !safeDeploymentIdPattern.test(expectedDeploymentId)
  ) {
    fail("CANDIDATE_IDENTITY_INVALID");
  }
  const workspaceKey = clean(parsed.workspaceKey || "A").toUpperCase();
  if (workspaceKey !== "A" && workspaceKey !== "B") fail("WORKSPACE_KEY_INVALID");
  if (typeof parsed.verifyDatabaseWrites !== "undefined" && typeof parsed.verifyDatabaseWrites !== "boolean") {
    fail("ACTION_INPUT_INVALID");
  }
  const previewOrigin = validateOrigin(clean(parsed.previewOrigin));
  return {
    expectedDeploymentId,
    expectedGitRef,
    expectedGitSha,
    previewOrigin,
    sessionCookie: validateSessionCookie(clean(parsed.sessionCookie)),
    shareUrl: validateShareUrl(clean(parsed.shareUrl), previewOrigin),
    verifyDatabaseWrites: parsed.verifyDatabaseWrites === true,
    workspaceKey,
  };
}

function runGit(args, cwd) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) fail("LOCAL_GIT_IDENTITY_UNAVAILABLE");
  return result.stdout.trim();
}

export function requireLocalCandidateIdentity(input, cwd = process.cwd()) {
  const head = runGit(["rev-parse", "HEAD"], cwd).toLowerCase();
  const gitRef = runGit(["branch", "--show-current"], cwd);
  const trackedStatus = runGit(["status", "--short", "--untracked-files=no"], cwd);
  if (head !== input.expectedGitSha || gitRef !== input.expectedGitRef || trackedStatus) {
    fail("LOCAL_CANDIDATE_MISMATCH");
  }
  return { gitRef, head };
}

function splitSetCookie(header) {
  if (!header) return [];
  return header.split(/,(?=[^;,]+=)/gu);
}

function setCookieValues(headers) {
  return typeof headers.getSetCookie === "function"
    ? headers.getSetCookie()
    : splitSetCookie(headers.get("set-cookie"));
}

export function createCookieJar() {
  const cookies = new Map();
  return {
    addCookiePair(value) {
      const first = clean(value).split(";", 1)[0]?.trim() ?? "";
      const separator = first.indexOf("=");
      if (separator < 1 || /[\r\n]/u.test(first)) fail("COOKIE_INPUT_INVALID");
      const name = first.slice(0, separator).trim();
      const cookieValue = first.slice(separator + 1).trim();
      if (!/^[A-Za-z0-9_-]{1,128}$/u.test(name) || cookieValue.length > 4_096) fail("COOKIE_INPUT_INVALID");
      if (cookieValue) cookies.set(name, cookieValue);
      else cookies.delete(name);
    },
    clear() {
      cookies.clear();
    },
    header() {
      return [...cookies.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
    },
    previewAccessHeader() {
      return [...cookies.entries()]
        .filter(([name]) => /^_vercel_[A-Za-z0-9_-]{1,64}$/u.test(name))
        .map(([name, value]) => `${name}=${value}`)
        .join("; ");
    },
    store(headers) {
      for (const value of setCookieValues(headers)) this.addCookiePair(value);
    },
    storeSecureVercel(headers) {
      for (const value of setCookieValues(headers)) {
        const parts = value.split(";").map((part) => part.trim());
        const first = parts[0] ?? "";
        const separator = first.indexOf("=");
        if (separator < 1) continue;
        const name = first.slice(0, separator).trim();
        if (!/^_vercel_[A-Za-z0-9_-]{1,64}$/u.test(name)) continue;
        if (!parts.slice(1).some((attribute) => attribute.toLowerCase() === "secure")) {
          fail("SHARE_COOKIE_INVALID");
        }
        const valuePart = first.slice(separator + 1).trim();
        if (!/^[A-Za-z0-9._~-]{1,4096}$/u.test(valuePart)) fail("SHARE_COOKIE_INVALID");
        this.addCookiePair(first);
      }
    },
  };
}

async function readJsonResponse(response) {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) return null;
  return response.json().catch(() => null);
}

async function bootstrapShareAccess({ cookieJar, fetchImpl, previewOrigin, shareUrl }) {
  if (!shareUrl) return;
  let next = shareUrl;
  const shareToken = next.searchParams.get("_vercel_share");
  const cookiesByOrigin = new Map([
    [previewOrigin, cookieJar],
    [vercelShareLandingOrigin, createCookieJar()],
  ]);
  let reachedPreview = next.origin === previewOrigin;
  let established = false;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const currentCookies = cookiesByOrigin.get(next.origin);
    if (!currentCookies) fail("SHARE_ACCESS_BOUNDARY_FAILED");
    const response = await fetchImpl(next, {
      headers: { accept: "text/html", cookie: currentCookies.header() },
      redirect: "manual",
    });
    currentCookies.storeSecureVercel(response.headers);
    if (response.status >= 200 && response.status < 300) {
      if (
        next.origin !== previewOrigin
        || !(response.headers.get("content-type") ?? "").toLowerCase().includes("text/html")
      ) {
        fail("SHARE_ACCESS_FAILED");
      }
      established = true;
      break;
    }
    if (response.status < 300 || response.status >= 400) fail("SHARE_ACCESS_FAILED");
    const location = response.headers.get("location");
    if (!location) fail("SHARE_ACCESS_FAILED");
    next = new URL(location, next);
    if (
      (next.origin !== previewOrigin && next.origin !== vercelShareLandingOrigin)
      || (reachedPreview && next.origin !== previewOrigin)
      || (next.origin === previewOrigin && next.pathname !== "/")
      || (next.origin === vercelShareLandingOrigin && (
        next.pathname.length > 1_024
        || next.pathname.startsWith("//")
        || /[\\\u0000-\u001f\u007f]/u.test(next.pathname)
      ))
      || next.hash
      || next.username
      || next.password
    ) {
      fail("SHARE_ACCESS_BOUNDARY_FAILED");
    }
    const queryEntries = [...next.searchParams.entries()];
    if (queryEntries.length > 0 && (
      queryEntries.length !== 1
      || queryEntries[0][0] !== "_vercel_share"
      || queryEntries[0][1] !== shareToken
    )) {
      fail("SHARE_ACCESS_BOUNDARY_FAILED");
    }
    reachedPreview ||= next.origin === previewOrigin;
  }
  if (!established || !cookieJar.header()) fail("SHARE_ACCESS_FAILED");
  const response = await fetchImpl(new URL("/", previewOrigin), {
    headers: { accept: "text/html", cookie: cookieJar.header() },
    redirect: "manual",
  });
  cookieJar.storeSecureVercel(response.headers);
  if (
    response.status < 200
    || response.status >= 300
    || !(response.headers.get("content-type") ?? "").toLowerCase().includes("text/html")
  ) {
    fail("SHARE_ACCESS_FAILED");
  }
}

function expectedFixtureScope(env, workspaceKey) {
  const prefix = `NOVALURE_QA_TENANT_${workspaceKey}`;
  const workspaceId = clean(env[`${prefix}_WORKSPACE_ID`]).toLowerCase();
  const userId = clean(env[`${prefix}_RESET_ACTOR_USER_ID`]).toLowerCase();
  const databaseBranchId = clean(env.NOVALURE_QA_BRANCH_ID);
  if (!safeUuidPattern.test(workspaceId) || !safeUuidPattern.test(userId) || !safeNeonBranchPattern.test(databaseBranchId)) {
    fail("QA_FIXTURE_SCOPE_INVALID");
  }
  return { databaseBranchId, userId, workspaceId };
}

export const providerFailClosedScenarios = Object.freeze([
  Object.freeze({ auth: false, bodyKind: "form", csrf: "same-origin-context", id: "public.password-reset-request", method: "POST", path: "/api/auth/password-reset/request" }),
  Object.freeze({ bodyKind: "invite", csrf: "session-method-path", id: "settings.invitation-email", method: "POST", path: "/api/settings/access/users" }),
  Object.freeze({ bodyKind: "resend", csrf: "session-method-path", id: "settings.invitation-email-resend", method: "POST", path: "/api/settings/access/users" }),
  Object.freeze({ bodyKind: "reset", csrf: "session-method-path", id: "settings.password-reset-email", method: "POST", path: "/api/settings/access/users" }),
  Object.freeze({ bodyKind: "customerInvite", csrf: "session-method-path", id: "customer-access.invitation-email", method: "POST", path: "/api/crm/customer-access" }),
  Object.freeze({ bodyKind: "calendar", csrf: "session-method-path", id: "calendar.google-mutation", method: "POST", path: "/api/calendar/google" }),
  Object.freeze({ bodyKind: "calendar", csrf: "session-method-path", id: "calendar.microsoft-mutation", method: "POST", path: "/api/calendar/microsoft" }),
  ...["google", "microsoft"].flatMap((provider) => [
    Object.freeze({ csrf: "not-applicable", id: `oauth.${provider}.start`, method: "GET", path: `/api/meetings/oauth/${provider}/start?returnTo=%2F%23calendar` }),
    Object.freeze({ csrf: "not-applicable", id: `oauth.${provider}.callback`, method: "GET", path: `/api/meetings/oauth/${provider}/callback` }),
    Object.freeze({ csrf: "session-method-path", id: `oauth.${provider}.disconnect`, method: "POST", path: `/api/meetings/oauth/${provider}/disconnect` }),
  ]),
]);

function scenarioBody(scenario, scope) {
  if (scenario.bodyKind === "form") {
    return { body: new URLSearchParams({ email: "provider-fail-closed@example.test", lang: "en" }), contentType: "application/x-www-form-urlencoded" };
  }
  if (scenario.bodyKind === "invite") {
    return { json: { email: "provider-fail-closed@example.test", name: "Provider Fail Closed", operation: "invite", productRole: "viewer", role: "assistant" } };
  }
  if (scenario.bodyKind === "resend") return { json: { operation: "resend_invitation", userId: scope.userId } };
  if (scenario.bodyKind === "reset") return { json: { operation: "password_reset", userId: scope.userId } };
  if (scenario.bodyKind === "customerInvite") {
    return { json: { email: "provider-fail-closed@example.test", name: "Provider Fail Closed", operation: "invite_user", productRole: "viewer", role: "assistant" } };
  }
  if (scenario.bodyKind === "calendar") {
    return { json: { endsAt: "2030-01-01T11:00:00.000Z", startsAt: "2030-01-01T10:00:00.000Z", subject: "Provider fail-closed probe" } };
  }
  return {};
}

async function issueCsrfToken({ cookieJar, fetchImpl, method, path, previewOrigin }) {
  const csrfUrl = new URL("/api/auth/csrf", previewOrigin);
  csrfUrl.searchParams.set("method", method);
  csrfUrl.searchParams.set("path", path);
  const response = await fetchImpl(csrfUrl, {
    headers: {
      accept: "application/json",
      cookie: cookieJar.header(),
      origin: previewOrigin,
      "sec-fetch-site": "same-origin",
    },
    redirect: "manual",
  });
  cookieJar.store(response.headers);
  const payload = await readJsonResponse(response);
  if (response.status !== 200 || typeof payload?.csrfToken !== "string" || payload.csrfToken.length < 20) {
    fail("CSRF_PREFLIGHT_FAILED");
  }
  return payload.csrfToken;
}

async function requestJson({ cookieJar, fetchImpl, id, path, previewOrigin }) {
  const target = new URL(path, previewOrigin);
  if (target.origin !== previewOrigin) fail("REQUEST_BOUNDARY_FAILED");
  const response = await fetchImpl(target, {
    headers: { accept: "application/json", cookie: cookieJar.header() },
    redirect: "manual",
  });
  cookieJar.store(response.headers);
  return { id, payload: await readJsonResponse(response), response };
}

function validateAuthenticatedSession(result, scope) {
  if (
    result.response.status !== 200
    || result.payload?.authenticated !== true
    || result.payload?.source !== "cookie"
    || clean(result.payload?.workspace?.id).toLowerCase() !== scope.workspaceId
    || clean(result.payload?.user?.id).toLowerCase() !== scope.userId
    || result.payload?.user?.role !== "owner"
    || result.payload?.user?.productRole !== "platform_admin"
  ) {
    fail("QA_SESSION_SCOPE_MISMATCH");
  }
}

function validateRuntimeIdentity(result, input, scope) {
  if (
    result.response.status !== 200
    || result.payload?.atomicRegistration !== true
    || result.payload?.version !== 2
    || result.payload?.deploymentHost !== new URL(input.previewOrigin).hostname
    || result.payload?.deploymentId !== input.expectedDeploymentId
    || result.payload?.gitSha !== input.expectedGitSha
    || result.payload?.gitBranch !== input.expectedGitRef
    || result.payload?.databaseBranchId !== scope.databaseBranchId
  ) {
    fail("PREVIEW_RUNTIME_IDENTITY_MISMATCH");
  }
}

async function executeScenario({ cookieJar, fetchImpl, input, scenario, scope }) {
  const target = new URL(scenario.path, input.previewOrigin);
  if (target.origin !== input.previewOrigin) fail("REQUEST_BOUNDARY_FAILED");
  if (scenario.id.includes(".callback")) {
    target.searchParams.set("state", randomBytes(24).toString("base64url"));
    target.searchParams.set("code", randomBytes(24).toString("base64url"));
  }
  const headers = new Headers({ accept: "application/json" });
  const requestCookies = scenario.auth === false ? cookieJar.previewAccessHeader() : cookieJar.header();
  if (requestCookies) headers.set("cookie", requestCookies);
  if (mutatingMethods.has(scenario.method)) {
    headers.set("origin", input.previewOrigin);
    headers.set("sec-fetch-site", "same-origin");
  }
  if (scenario.csrf === "session-method-path") {
    headers.set("x-novalure-csrf-token", await issueCsrfToken({
      cookieJar,
      fetchImpl,
      method: scenario.method,
      path: target.pathname,
      previewOrigin: input.previewOrigin,
    }));
  }
  const body = scenarioBody(scenario, scope);
  const init = { headers, method: scenario.method, redirect: "manual" };
  if (body.json !== undefined) {
    headers.set("content-type", "application/json");
    init.body = JSON.stringify(body.json);
  } else if (body.body !== undefined) {
    headers.set("content-type", body.contentType);
    init.body = body.body;
  }
  const response = await fetchImpl(target, init);
  cookieJar.store(response.headers);
  const payload = await readJsonResponse(response);
  return {
    code: payload?.code === "LAUNCH_SCOPE_OFF" ? payload.code : "UNEXPECTED",
    csrf: scenario.csrf,
    id: scenario.id,
    method: scenario.method,
    status: response.status,
  };
}

function requireDatabaseEnvironment(env) {
  const names = [
    "NOVALURE_QA_DATABASE_URL",
    "NOVALURE_QA_DATABASE_HOST",
    "NOVALURE_QA_PROJECT_ID",
    "NOVALURE_QA_BRANCH_ID",
    "NOVALURE_QA_DATABASE_NAME",
    "NOVALURE_QA_DATABASE_ROLE",
  ];
  const values = Object.fromEntries(names.map((name) => [name, clean(env[name])]));
  if (names.some((name) => !values[name])) fail("DATABASE_POSTCONDITION_CONFIG_UNAVAILABLE");
  let parsed;
  try {
    parsed = new URL(values.NOVALURE_QA_DATABASE_URL);
  } catch {
    fail("DATABASE_POSTCONDITION_CONFIG_INVALID");
  }
  const productionHost = clean(env.NOVALURE_PRODUCTION_DATABASE_HOST).toLowerCase();
  if (
    !/^postgres(?:ql)?:$/u.test(parsed.protocol)
    || parsed.hostname.toLowerCase() !== values.NOVALURE_QA_DATABASE_HOST.toLowerCase()
    || !parsed.hostname.toLowerCase().includes("-pooler.")
    || parsed.pathname.replace(/^\//u, "") !== values.NOVALURE_QA_DATABASE_NAME
    || decodeURIComponent(parsed.username) !== values.NOVALURE_QA_DATABASE_ROLE
    || (productionHost && parsed.hostname.toLowerCase() === productionHost)
  ) {
    fail("DATABASE_POSTCONDITION_CONFIG_INVALID");
  }
  return { ...values, databaseUrl: values.NOVALURE_QA_DATABASE_URL };
}

export const providerFailClosedDatabaseTables = Object.freeze([
  "workspace_users",
  "auth_password_reset_tokens",
  "newsletter_sends",
  "provider_connections",
  "calendar_sync_events",
  "oauth_authorization_states",
  "audit_logs",
  "auth_audit_events",
]);
const snapshotTables = providerFailClosedDatabaseTables;

async function databaseSnapshot(database, scope) {
  const sql = neon(database.databaseUrl);
  const target = await sql`
    select current_setting('neon.project_id', true) as project_id,
      current_setting('neon.branch_id', true) as branch_id,
      current_database() as database_name,
      current_user as role_name
  `;
  const identity = target[0];
  if (
    identity?.project_id !== database.NOVALURE_QA_PROJECT_ID
    || identity?.branch_id !== database.NOVALURE_QA_BRANCH_ID
    || identity?.database_name !== database.NOVALURE_QA_DATABASE_NAME
    || identity?.role_name !== database.NOVALURE_QA_DATABASE_ROLE
  ) {
    fail("DATABASE_POSTCONDITION_TARGET_MISMATCH");
  }
  const results = await sql.transaction((transaction) => [
    transaction`select set_config('app.tenant_id', ${scope.workspaceId}, true), set_config('app.actor_id', ${scope.userId}, true)`,
    transaction`select id::text, role, product_role, status, updated_at::text from workspace_users where workspace_id = ${scope.workspaceId}::uuid order by id`,
    transaction`select id::text, user_id::text, expires_at::text, used_at::text, created_at::text from auth_password_reset_tokens where workspace_id = ${scope.workspaceId}::uuid order by id`,
    transaction`select id::text, status, provider, updated_at::text from newsletter_sends where workspace_id = ${scope.workspaceId}::uuid order by id`,
    transaction`select id::text, provider, status, expires_at::text, refreshed_at::text, updated_at::text from provider_connections where workspace_id = ${scope.workspaceId}::uuid order by id`,
    transaction`select id::text, provider, status, updated_at::text from calendar_sync_events where workspace_id = ${scope.workspaceId}::uuid order by id`,
    transaction`select id::text, provider, expires_at::text, consumed_at::text, created_at::text from oauth_authorization_states where workspace_id = ${scope.workspaceId}::uuid order by id`,
    transaction`select id::text, action, created_at::text from audit_logs where workspace_id = ${scope.workspaceId}::uuid order by id`,
    transaction`select id::text, event_type, outcome, occurred_at::text from auth_audit_events where workspace_id = ${scope.workspaceId}::uuid order by id`,
  ], { readOnly: true });
  return Object.fromEntries(snapshotTables.map((table, index) => [
    table,
    { count: results[index + 1].length, fingerprint: fingerprint(canonicalJson(results[index + 1]), 64) },
  ]));
}

async function tryDatabaseSnapshot(env, input, scope) {
  if (!input.verifyDatabaseWrites) {
    return { reasonCode: "DATABASE_POSTCONDITION_NOT_REQUESTED", snapshot: null, status: "UNPROVEN" };
  }
  try {
    const database = requireDatabaseEnvironment(env);
    return { reasonCode: null, snapshot: await databaseSnapshot(database, scope), status: "CAPTURED" };
  } catch (error) {
    const code = error instanceof ProviderFailClosedRunnerError
      ? error.code
      : "DATABASE_POSTCONDITION_UNAVAILABLE";
    return { reasonCode: code, snapshot: null, status: "UNPROVEN" };
  }
}

export function compareDatabaseSnapshots(before, after) {
  if (before.status !== "CAPTURED" || after.status !== "CAPTURED") {
    return {
      reasonCode: before.reasonCode ?? after.reasonCode ?? "DATABASE_POSTCONDITION_UNAVAILABLE",
      status: "UNPROVEN",
      tables: {},
    };
  }
  const tables = Object.fromEntries(snapshotTables.map((table) => {
    const left = before.snapshot[table];
    const right = after.snapshot[table];
    return [table, {
      afterCount: right.count,
      afterFingerprint: right.fingerprint,
      beforeCount: left.count,
      beforeFingerprint: left.fingerprint,
      unchanged: left.count === right.count && left.fingerprint === right.fingerprint,
    }];
  }));
  const unchanged = Object.values(tables).every((table) => table.unchanged);
  return {
    reasonCode: unchanged ? null : "DATABASE_WRITE_OBSERVED",
    status: unchanged ? "PASS" : "FAIL",
    tables,
  };
}

export async function executeProviderFailClosedPreview({
  env = process.env,
  fetchImpl = fetch,
  input,
  requireLocalIdentity = true,
  workdir = process.cwd(),
} = {}) {
  const cookieJar = createCookieJar();
  const startedAt = new Date().toISOString();
  const requests = [];
  let scope;
  let databaseBefore = { reasonCode: "DATABASE_POSTCONDITION_NOT_CAPTURED", status: "UNPROVEN" };
  let databaseAfter = databaseBefore;
  try {
    if (requireLocalIdentity) requireLocalCandidateIdentity(input, workdir);
    scope = expectedFixtureScope(env, input.workspaceKey);
    await bootstrapShareAccess({ cookieJar, fetchImpl, previewOrigin: input.previewOrigin, shareUrl: input.shareUrl });
    cookieJar.addCookiePair(input.sessionCookie);

    const session = await requestJson({ cookieJar, fetchImpl, id: "identity.session", path: "/api/auth/session", previewOrigin: input.previewOrigin });
    requests.push({ code: session.response.status === 200 ? "SESSION_SCOPE_MATCH" : "UNEXPECTED", csrf: "not-applicable", id: session.id, method: "GET", status: session.response.status });
    validateAuthenticatedSession(session, scope);
    const capability = await requestJson({ cookieJar, fetchImpl, id: "identity.runtime", path: providerFailClosedCapabilityPath, previewOrigin: input.previewOrigin });
    requests.push({ code: capability.response.status === 200 ? "RUNTIME_IDENTITY_MATCH" : "UNEXPECTED", csrf: "not-applicable", id: capability.id, method: "GET", status: capability.response.status });
    validateRuntimeIdentity(capability, input, scope);

    databaseBefore = await tryDatabaseSnapshot(env, input, scope);
    for (const scenario of providerFailClosedScenarios) {
      const result = await executeScenario({ cookieJar, fetchImpl, input, scenario, scope });
      requests.push(result);
      if (result.status !== 503 || result.code !== "LAUNCH_SCOPE_OFF") fail("FAIL_CLOSED_HTTP_CONTRACT_FAILED");
    }
    databaseAfter = await tryDatabaseSnapshot(env, input, scope);
    const databasePostcondition = compareDatabaseSnapshots(databaseBefore, databaseAfter);
    if (databasePostcondition.status === "FAIL") fail("DATABASE_WRITE_OBSERVED");

    const evidence = {
      candidate: {
        commitSha: input.expectedGitSha,
        databaseBranchId: scope.databaseBranchId,
        databaseBranchFingerprint: fingerprint(scope.databaseBranchId),
        deploymentHost: new URL(input.previewOrigin).hostname,
        deploymentId: input.expectedDeploymentId,
        gitRef: input.expectedGitRef,
        previewOriginFingerprint: fingerprint(input.previewOrigin),
      },
      cleanup: {
        databaseCleanup: databasePostcondition.status === "PASS" ? "NOT_REQUIRED" : "UNPROVEN",
        externalSessionCreatedByRunner: false,
        inMemoryCookieJar: "CLEARED_IN_FINALLY",
        status: databasePostcondition.status === "PASS" ? "COMPLETE" : "PARTIAL",
      },
      completedAt: new Date().toISOString(),
      databaseWritePostcondition: databasePostcondition,
      httpTechnicalStatus: "PASS",
      providerSideEffectPostcondition: {
        codeOrderAndHttpGate: "PASS",
        independentProviderLogs: "UNPROVEN",
        reasonCode: "INDEPENDENT_PROVIDER_LOGS_NOT_COLLECTED",
      },
      productionMutationPerformed: false,
      releaseGateStatus: "BLOCKED",
      requests,
      schemaVersion: 1,
      startedAt,
    };
    assertEvidenceIsRedacted(evidence);
    return evidence;
  } finally {
    cookieJar.clear();
  }
}
