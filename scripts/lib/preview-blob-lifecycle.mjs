import { createHash, createHmac } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { validateLegacyBlobMigrationProof } from "./blob-legacy-migration-receipt.mjs";
import { previewPrivateBlobStoreFingerprint } from "./blob-store-fingerprints.mjs";

const mutatingMethods = new Set(["DELETE", "PATCH", "POST", "PUT"]);
const redirectStatuses = new Set([302, 303, 307, 308]);
const allowedChallengeDiagnostics = new Set(["mfa_enrollment", "mfa_verification", "workspace_selection"]);
const allowedLoginErrorDiagnostics = new Set([
  "database_unavailable",
  "invalid_credentials",
  "invalid_mfa",
  "login_not_configured",
]);
const executionConfirmation = "RUN_PRIVATE_PREVIEW_BLOB_LIFECYCLE";
const evidenceRoot = path.join("artifacts", "qa", "preview-blob-lifecycle");
const shaPattern = /^[a-f0-9]{40}$/u;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const branchPattern = /^codex\/[A-Za-z0-9._/-]{1,220}$/u;
const deploymentIdPattern = /^dpl_[A-Za-z0-9]{20,80}$/u;
const runIdPattern = /^GOLIVEBLOBHTTP_[A-Za-z0-9_-]{8,80}$/u;
const vercelShareLandingOrigin = "https://vercel.com";
const vercelCookieNamePattern = /^_vercel_[A-Za-z0-9_-]{1,64}$/u;
const vercelCookieValuePattern = /^[A-Za-z0-9._~-]{1,4096}$/u;
const maximumShareRedirects = 5;
const forbiddenEvidenceKey = /(?:authorization|cookie|credential|email|password|secret|share|token|totp)/iu;
const forbiddenEvidenceValue = /(?:bearer\s+|postgres(?:ql)?:\/\/|vercel_blob_rw_|[?&](?:_vercel_share|signature|token)=|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/iu;

// A fixed, complete, one-pixel PNG. Its bytes are intentionally public test data.
export const previewBlobMagicBytes = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

export class PreviewBlobLifecycleError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.code = code;
  }
}

function fail(code, message, cause) {
  throw new PreviewBlobLifecycleError(code, message, cause ? { cause } : undefined);
}

function clean(value) {
  return typeof value === "string" ? value.trim().replace(/^['"]|['"]$/gu, "") : "";
}

function required(env, key) {
  const value = clean(env?.[key]);
  if (!value) fail("CONFIGURATION_MISSING", `${key} is required.`);
  return value;
}

function defineSecret(target, key, value) {
  Object.defineProperty(target, key, {
    configurable: false,
    enumerable: false,
    value,
    writable: false,
  });
}

function blobStoreIdFromToken(token) {
  const segments = token.split("_");
  if (segments.length < 5 || segments[0] !== "vercel" || segments[1] !== "blob" || segments[2] !== "rw" || !segments[3]) {
    fail("BLOB_INSPECTOR_TOKEN_INVALID", "The optional private Preview Blob credential is invalid.");
  }
  return segments[3];
}

function resolveIndependentBlobConfig(env) {
  const credential = clean(env.NOVALURE_PREVIEW_PRIVATE_BLOB_READ_WRITE_TOKEN);
  if (!credential) return null;
  const storeId = required(env, "NOVALURE_PREVIEW_PRIVATE_BLOB_STORE_ID").replace(/^store_/u, "");
  const productionStoreIds = [
    required(env, "NOVALURE_PRIVATE_BLOB_STORE_ID"),
    required(env, "NOVALURE_PUBLIC_BLOB_STORE_ID"),
  ].map((value) => value.replace(/^store_/u, ""));
  if (
    !/^[A-Za-z0-9-]{6,128}$/u.test(storeId) ||
    blobStoreIdFromToken(credential) !== storeId ||
    productionStoreIds.includes(storeId)
  ) {
    fail("BLOB_INSPECTOR_TARGET_REJECTED", "The optional Blob inspector is not bound to the isolated private Preview store.");
  }
  const inspectorConfig = {
    storeFingerprint: previewPrivateBlobStoreFingerprint(storeId),
  };
  defineSecret(inspectorConfig, "credential", credential);
  return Object.freeze(inspectorConfig);
}

export function fingerprint(label, value, length = 20) {
  return `sha256:${createHash("sha256").update(`${label}\0${value}`).digest("hex").slice(0, length)}`;
}

function parseExactOrigin(value, label) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail("ORIGIN_INVALID", `${label} must be a valid origin.`);
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash ||
    value !== parsed.origin
  ) {
    fail("ORIGIN_INVALID", `${label} must be an exact credential-free HTTPS origin without a trailing slash.`);
  }
  return parsed;
}

function resolveEvidenceDirectory(projectRoot, runId) {
  const root = path.resolve(projectRoot, evidenceRoot);
  const target = path.join(root, runId.toLowerCase());
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    fail("EVIDENCE_PATH_REJECTED", "Evidence must use a run-specific directory below artifacts/qa/preview-blob-lifecycle.");
  }
  return target;
}

export function resolvePreviewBlobLifecycleConfig({ env = process.env, execute = false, projectRoot = process.cwd() } = {}) {
  const base = parseExactOrigin(required(env, "NOVALURE_QA_BASE_URL"), "NOVALURE_QA_BASE_URL");
  const production = parseExactOrigin(required(env, "NOVALURE_PRODUCTION_ORIGIN"), "NOVALURE_PRODUCTION_ORIGIN");
  const expectedHost = required(env, "NOVALURE_QA_EXPECTED_HOST").toLowerCase();
  if (base.hostname.toLowerCase() !== expectedHost) {
    fail("PREVIEW_HOST_MISMATCH", "The Preview origin does not match NOVALURE_QA_EXPECTED_HOST.");
  }
  if (!expectedHost.endsWith(".vercel.app")) {
    fail("PREVIEW_HOST_REQUIRED", "The lifecycle target must be an exact Vercel Preview host.");
  }
  if (base.origin === production.origin || base.hostname.toLowerCase() === production.hostname.toLowerCase()) {
    fail("PRODUCTION_ORIGIN_REJECTED", "The lifecycle target must not match Production.");
  }

  const expectedGitSha = required(env, "NOVALURE_QA_EXPECTED_GIT_SHA").toLowerCase();
  if (!shaPattern.test(expectedGitSha)) {
    fail("GIT_SHA_INVALID", "NOVALURE_QA_EXPECTED_GIT_SHA must be a full lowercase Git SHA.");
  }
  const expectedGitBranch = required(env, "NOVALURE_QA_EXPECTED_GIT_BRANCH");
  const activeGitBranch = clean(env.VERCEL_GIT_COMMIT_REF) || required(env, "NOVALURE_QA_ACTIVE_GIT_BRANCH");
  if (!branchPattern.test(expectedGitBranch) || activeGitBranch !== expectedGitBranch) {
    fail("PREVIEW_BRANCH_MISMATCH", "The declared active branch must exactly match the codex Preview branch.");
  }

  const deploymentId = required(env, "NOVALURE_QA_DEPLOYMENT_ID");
  if (!deploymentIdPattern.test(deploymentId)) {
    fail("DEPLOYMENT_ID_INVALID", "NOVALURE_QA_DEPLOYMENT_ID is invalid.");
  }
  const runId = required(env, "NOVALURE_QA_BLOB_RUN_ID");
  if (!runIdPattern.test(runId)) {
    fail("RUN_ID_INVALID", "NOVALURE_QA_BLOB_RUN_ID is invalid.");
  }
  const expectedDatabaseBranchId = required(env, "NOVALURE_QA_BRANCH_ID");
  if (!/^br-[A-Za-z0-9-]{8,128}$/u.test(expectedDatabaseBranchId)) {
    fail("DATABASE_BRANCH_ID_INVALID", "NOVALURE_QA_BRANCH_ID is invalid.");
  }
  const independentBlob = resolveIndependentBlobConfig(env);

  const actor = {
    email: required(env, "NOVALURE_QA_RESET_ADMIN_EMAIL").toLowerCase(),
    password: clean(env.NOVALURE_QA_RESET_ADMIN_PASSWORD) || required(env, "NOVALURE_QA_PASSWORD"),
    totpSecret: required(env, "NOVALURE_QA_RESET_ADMIN_TOTP_SECRET"),
    userId: required(env, "NOVALURE_QA_TENANT_A_RESET_ACTOR_USER_ID").toLowerCase(),
    workspaceId: required(env, "NOVALURE_QA_TENANT_A_WORKSPACE_ID").toLowerCase(),
  };
  if (!uuidPattern.test(actor.userId) || !uuidPattern.test(actor.workspaceId)) {
    fail("ACTOR_SCOPE_INVALID", "The QA actor scope must contain valid UUIDs.");
  }
  if (!/^[^\s@]+@[^\s@]+$/u.test(actor.email) || actor.password.length < 16 || actor.totpSecret.length < 16) {
    fail("ACTOR_CREDENTIALS_INVALID", "The isolated QA actor credentials are incomplete.");
  }
  const crossTenantActor = {
    email: required(env, "NOVALURE_QA_TENANT_B_OWNER_EMAIL").toLowerCase(),
    password: clean(env.NOVALURE_QA_TENANT_B_OWNER_PASSWORD) || required(env, "NOVALURE_QA_PASSWORD"),
    totpSecret: required(env, "NOVALURE_QA_TENANT_B_OWNER_TOTP_SECRET"),
    userId: required(env, "NOVALURE_QA_TENANT_B_OWNER_USER_ID").toLowerCase(),
    workspaceId: required(env, "NOVALURE_QA_TENANT_B_WORKSPACE_ID").toLowerCase(),
  };
  if (
    !uuidPattern.test(crossTenantActor.userId) ||
    !uuidPattern.test(crossTenantActor.workspaceId) ||
    crossTenantActor.userId === actor.userId ||
    crossTenantActor.workspaceId === actor.workspaceId
  ) {
    fail("CROSS_TENANT_ACTOR_SCOPE_INVALID", "The Tenant-B QA actor must have a distinct valid user and workspace scope.");
  }
  if (
    !/^[^\s@]+@[^\s@]+$/u.test(crossTenantActor.email) ||
    crossTenantActor.email === actor.email ||
    crossTenantActor.password.length < 16 ||
    crossTenantActor.totpSecret.length < 16
  ) {
    fail("CROSS_TENANT_ACTOR_CREDENTIALS_INVALID", "The Tenant-B QA actor credentials are incomplete or not distinct.");
  }
  if (execute && clean(env.NOVALURE_QA_BLOB_LIFECYCLE_CONFIRM) !== executionConfirmation) {
    fail("EXECUTION_CONFIRMATION_REQUIRED", "The exact private Preview Blob lifecycle confirmation is required.");
  }

  const config = {
    deploymentId,
    evidenceDirectory: resolveEvidenceDirectory(projectRoot, runId),
    expectedGitBranch,
    expectedGitSha,
    expectedHost,
    runId,
  };
  defineSecret(config, "expectedDatabaseBranchId", expectedDatabaseBranchId);
  defineSecret(config, "independentBlob", independentBlob);
  defineSecret(config, "actor", Object.freeze(actor));
  defineSecret(config, "baseOrigin", base.origin);
  defineSecret(config, "crossTenantActor", Object.freeze(crossTenantActor));
  return Object.freeze(config);
}

export function validateShareUrl(value, expectedOrigin) {
  const candidate = clean(value);
  if (!candidate) return null;
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    fail("SHARE_URL_INVALID", "The Preview share URL is invalid.");
  }
  if (
    (parsed.origin !== expectedOrigin && parsed.origin !== vercelShareLandingOrigin) ||
    (parsed.origin === expectedOrigin && parsed.pathname !== "/") ||
    (parsed.origin === vercelShareLandingOrigin && (
      parsed.pathname.length > 1_024 ||
      parsed.pathname.startsWith("//") ||
      /[\\\u0000-\u001f\u007f]/u.test(parsed.pathname)
    )) ||
    parsed.hash ||
    parsed.username ||
    parsed.password ||
    [...parsed.searchParams.keys()].length !== 1 ||
    !parsed.searchParams.has("_vercel_share") ||
    !/^[A-Za-z0-9_-]{20,512}$/u.test(parsed.searchParams.get("_vercel_share") ?? "")
  ) {
    fail("SHARE_URL_INVALID", "The share URL must contain only a valid token for the exact Preview origin.");
  }
  return parsed;
}

export async function createVercelPrivateBlobInspector(config) {
  if (!config.independentBlob) return null;
  const { BlobNotFoundError, head, list } = await import("@vercel/blob");
  const credential = config.independentBlob.credential;

  function assertPrefix(prefix) {
    if (!/^[0-9a-f-]{36}\/qa-private-lifecycle\/$/iu.test(prefix)) {
      fail("BLOB_INSPECTOR_PREFIX_REJECTED", "The independent Blob prefix is outside the exact QA lifecycle scope.");
    }
  }

  return Object.freeze({
    async headPath(pathname) {
      try {
        const result = await head(pathname, {
          abortSignal: AbortSignal.timeout(15_000),
          token: credential,
        });
        if (result.pathname !== pathname) {
          fail("BLOB_INSPECTOR_HEAD_MISMATCH", "Independent Blob head returned a different object.");
        }
        return { contentType: result.contentType, pathname: result.pathname, size: Number(result.size) };
      } catch (error) {
        if (error instanceof BlobNotFoundError) return null;
        if (error instanceof PreviewBlobLifecycleError) throw error;
        fail("BLOB_INSPECTOR_HEAD_FAILED", "Independent Blob head failed.", error);
      }
    },
    async listPrefix(prefix) {
      assertPrefix(prefix);
      const blobs = [];
      let cursor;
      for (let page = 0; page < 10; page += 1) {
        let result;
        try {
          result = await list({
            cursor,
            limit: 1_000,
            prefix,
            token: credential,
          });
        } catch (error) {
          fail("BLOB_INSPECTOR_LIST_FAILED", "Independent Blob listing failed.", error);
        }
        for (const blob of result.blobs ?? []) {
          if (typeof blob.pathname !== "string" || !blob.pathname.startsWith(prefix)) {
            fail("BLOB_INSPECTOR_LIST_SCOPE_MISMATCH", "Independent Blob listing returned an out-of-prefix object.");
          }
          blobs.push({ contentType: blob.contentType, pathname: blob.pathname, size: Number(blob.size) });
        }
        if (!result.hasMore) return blobs;
        if (!result.cursor || result.cursor === cursor) {
          fail("BLOB_INSPECTOR_CURSOR_INVALID", "Independent Blob listing pagination failed closed.");
        }
        cursor = result.cursor;
      }
      fail("BLOB_INSPECTOR_PAGE_LIMIT", "Independent Blob listing exceeded its bounded page limit.");
    },
  });
}

function splitSetCookie(header) {
  if (!header) return [];
  return header.split(/,(?=[^;,]+=)/gu);
}

function decodeBase32(value) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const normalized = value.toUpperCase().replace(/=+$/gu, "").replace(/[\s-]/gu, "");
  let bits = 0;
  let buffer = 0;
  const decoded = [];
  for (const character of normalized) {
    const index = alphabet.indexOf(character);
    if (index < 0) return null;
    buffer = (buffer << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      decoded.push((buffer >>> bits) & 255);
    }
  }
  return Buffer.from(decoded);
}

function createTotpCode(secret, now = Date.now()) {
  const decoded = decodeBase32(secret);
  if (!decoded) return null;
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(now / 30_000)));
  const digest = createHmac("sha1", decoded).update(counter).digest();
  const offset = digest[digest.length - 1] & 15;
  const binary =
    ((digest[offset] & 127) << 24) |
    ((digest[offset + 1] & 255) << 16) |
    ((digest[offset + 2] & 255) << 8) |
    (digest[offset + 3] & 255);
  return String(binary % 1_000_000).padStart(6, "0");
}

function routeLabel(pathname) {
  if (["/", "/api/auth/csrf", "/api/auth/login", "/api/auth/logout", "/api/auth/session", "/api/admin/qa-batch-capability", "/api/media"].includes(pathname)) {
    return pathname;
  }
  if (/^\/api\/media\/files\/[0-9a-f-]{36}$/iu.test(pathname)) return "/api/media/files/:asset";
  if (/^\/api\/media\/[0-9a-f-]{36}$/iu.test(pathname)) return "/api/media/:asset";
  fail("HTTP_PATH_REJECTED", "The lifecycle runner attempted a non-allowlisted HTTP path.");
}

function responseIsJson(response) {
  return (response.headers.get("content-type") ?? "").toLowerCase().includes("application/json");
}

export function createPreviewBlobHttpClient(config, { fetchImpl = globalThis.fetch, requestLog = [] } = {}) {
  if (typeof fetchImpl !== "function") fail("FETCH_UNAVAILABLE", "A fetch implementation is required.");
  const cookies = new Map();
  const origin = config.baseOrigin;

  function record(method, pathname, status) {
    requestLog.push({ method, route: routeLabel(pathname), status });
  }

  function storeCookies(headers) {
    const values = typeof headers.getSetCookie === "function"
      ? headers.getSetCookie()
      : splitSetCookie(headers.get("set-cookie"));
    for (const value of values) {
      const [cookie] = value.split(";");
      const separator = cookie.indexOf("=");
      if (separator < 1) continue;
      const name = cookie.slice(0, separator).trim();
      const cookieValue = cookie.slice(separator + 1).trim();
      if (cookieValue) cookies.set(name, cookieValue);
      else cookies.delete(name);
    }
  }

  function storeSecureVercelCookies(headers, targetCookies = cookies) {
    const values = typeof headers.getSetCookie === "function"
      ? headers.getSetCookie()
      : splitSetCookie(headers.get("set-cookie"));
    for (const value of values) {
      const parts = value.split(";").map((part) => part.trim());
      const separator = parts[0].indexOf("=");
      if (separator < 1) continue;
      const name = parts[0].slice(0, separator).trim();
      if (!vercelCookieNamePattern.test(name)) continue;
      if (!parts.slice(1).some((attribute) => attribute.toLowerCase() === "secure")) {
        fail("SHARE_COOKIE_INSECURE", "A Vercel Preview access cookie was not Secure.");
      }
      const cookieValue = parts[0].slice(separator + 1).trim();
      const expired = parts.slice(1).some((attribute) => /^max-age=0$/iu.test(attribute));
      if (!cookieValue || expired) {
        targetCookies.delete(name);
      } else if (!vercelCookieValuePattern.test(cookieValue)) {
        fail("SHARE_COOKIE_INVALID", "A Vercel Preview access cookie was invalid.");
      } else {
        targetCookies.set(name, cookieValue);
      }
    }
  }

  function retainOnlyVercelCookies() {
    for (const name of cookies.keys()) {
      if (!vercelCookieNamePattern.test(name)) cookies.delete(name);
    }
  }

  function cookieHeader(sourceCookies = cookies) {
    return [...sourceCookies.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
  }

  async function discardBody(response) {
    if (!response.body) return;
    try {
      await response.body.cancel();
    } catch {
      // Body disposal is best-effort and never changes target verification.
    }
  }

  async function fetchCsrf(method, pathname) {
    const url = new URL("/api/auth/csrf", origin);
    url.searchParams.set("method", method);
    url.searchParams.set("path", pathname);
    const response = await fetchImpl(url, {
      headers: {
        accept: "application/json",
        cookie: cookieHeader(),
        origin,
        "sec-fetch-site": "same-origin",
      },
      method: "GET",
      redirect: "manual",
    });
    storeCookies(response.headers);
    record("GET", url.pathname, response.status);
    const payload = responseIsJson(response) ? await response.json().catch(() => null) : null;
    if (!response.ok || typeof payload?.csrfToken !== "string" || payload.csrfToken.length < 20) {
      fail("CSRF_PREFLIGHT_FAILED", "The path- and method-bound CSRF preflight failed.");
    }
    return payload.csrfToken;
  }

  async function request(requestPath, options = {}) {
    const url = new URL(requestPath, origin);
    if (url.origin !== origin) fail("CROSS_ORIGIN_REQUEST_REJECTED", "The lifecycle runner rejected a cross-origin request.");
    routeLabel(url.pathname);
    const method = String(options.method ?? "GET").toUpperCase();
    const headers = new Headers(options.headers ?? {});
    if (cookies.size) headers.set("cookie", cookieHeader());
    if (mutatingMethods.has(method) && cookies.has("novalure_session")) {
      headers.set("origin", origin);
      headers.set("sec-fetch-site", "same-origin");
      headers.set("x-novalure-csrf-token", await fetchCsrf(method, url.pathname));
    }
    const response = await fetchImpl(url, {
      body: options.body,
      headers,
      method,
      redirect: "manual",
    });
    storeCookies(response.headers);
    record(method, url.pathname, response.status);
    let bytes = null;
    let json = null;
    if (options.responseKind === "bytes") {
      bytes = Buffer.from(await response.arrayBuffer());
    } else if (options.responseKind === "discard") {
      await discardBody(response);
    } else if (responseIsJson(response)) {
      json = await response.json().catch(() => null);
    } else {
      await discardBody(response);
    }
    return { bytes, json, response };
  }

  async function bootstrapShareAccess(shareUrl) {
    if (shareUrl) {
      const expectedShareCredential = shareUrl.searchParams.get("_vercel_share");
      const cookiesByOrigin = new Map([[origin, cookies]]);
      let currentUrl = shareUrl;
      let reachedPreviewOrigin = currentUrl.origin === origin;
      let completed = false;
      for (let redirectCount = 0; redirectCount <= maximumShareRedirects; redirectCount += 1) {
        const originCookies = cookiesByOrigin.get(currentUrl.origin) ?? new Map();
        cookiesByOrigin.set(currentUrl.origin, originCookies);
        const headers = new Headers({ accept: "text/html,application/xhtml+xml" });
        if (originCookies.size) headers.set("cookie", cookieHeader(originCookies));
        const response = await fetchImpl(currentUrl, { headers, method: "GET", redirect: "manual" });
        storeSecureVercelCookies(response.headers, originCookies);
        requestLog.push({
          method: "GET",
          route: currentUrl.origin === origin ? "/" : "/vercel-access-landing",
          status: response.status,
        });
        if (redirectStatuses.has(response.status)) {
          if (redirectCount === maximumShareRedirects) {
            fail("SHARE_REDIRECT_LIMIT", "Preview share access exceeded its bounded redirect limit.");
          }
          const location = response.headers.get("location");
          let target;
          try {
            target = location ? new URL(location, currentUrl) : null;
          } catch {
            target = null;
          }
          if (
            !target ||
            target.protocol !== "https:" ||
            target.username ||
            target.password ||
            target.hash ||
            (target.origin !== origin && target.origin !== vercelShareLandingOrigin) ||
            (reachedPreviewOrigin && target.origin !== origin) ||
            (target.origin === origin && target.pathname !== "/") ||
            (target.origin === vercelShareLandingOrigin && (
              target.pathname.length > 1_024 ||
              target.pathname.startsWith("//") ||
              /[\\\u0000-\u001f\u007f]/u.test(target.pathname)
            ))
          ) {
            fail("SHARE_REDIRECT_REJECTED", "Preview share access redirected outside the exact bounded target.");
          }
          const query = [...target.searchParams.entries()];
          if (
            query.length > 0 &&
            (query.length !== 1 || query[0][0] !== "_vercel_share" || query[0][1] !== expectedShareCredential)
          ) {
            fail("SHARE_REDIRECT_REJECTED", "Preview share access changed its credential binding.");
          }
          reachedPreviewOrigin ||= target.origin === origin;
          currentUrl = target;
          await discardBody(response);
          continue;
        }
        if (
          currentUrl.origin !== origin ||
          response.status !== 200 ||
          !(response.headers.get("content-type") ?? "").includes("text/html")
        ) {
          fail("SHARE_ACCESS_FAILED", "Preview share access did not finish on the exact application origin.");
        }
        await discardBody(response);
        completed = true;
        break;
      }
      if (!completed) fail("SHARE_ACCESS_FAILED", "Preview share access did not complete.");
      if (![...cookies.keys()].some((name) => vercelCookieNamePattern.test(name))) {
        fail("SHARE_COOKIE_MISSING", "Preview share access did not establish a secure Vercel cookie.");
      }
    }
    const landing = await request("/", { responseKind: "discard" });
    retainOnlyVercelCookies();
    if (landing.response.status !== 200 || !(landing.response.headers.get("content-type") ?? "").includes("text/html")) {
      fail("PREVIEW_LANDING_FAILED", "The exact Preview origin did not return the application landing page.");
    }
  }

  async function login(actor) {
    const loginBody = new URLSearchParams({ email: actor.email, password: actor.password, returnTo: "/" });
    let result = await request("/api/auth/login", {
      body: loginBody,
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin,
        "sec-fetch-site": "same-origin",
      },
      method: "POST",
    });
    if (!redirectStatuses.has(result.response.status)) {
      fail("LOGIN_FAILED", "The isolated QA login did not redirect.");
    }
    for (let index = 0; !cookies.has("novalure_session") && index < 3; index += 1) {
      const location = result.response.headers.get("location") ?? "/login";
      const challengeUrl = new URL(location, origin);
      if (challengeUrl.origin !== origin) fail("LOGIN_REDIRECT_REJECTED", "The QA login left the exact Preview origin.");
      const challengeKind = challengeUrl.searchParams.get("step");
      if (challengeKind === "mfa_enrollment") {
        fail("MFA_ENROLLMENT_REQUIRED", "The QA actor must be pre-enrolled for MFA.");
      }
      if (!new Set(["workspace_selection", "mfa_verification"]).has(challengeKind ?? "")) {
        const errorKind = challengeUrl.searchParams.get("error");
        const safeChallenge = challengeKind === null
          ? "none"
          : allowedChallengeDiagnostics.has(challengeKind) ? challengeKind : "unknown";
        const safeError = errorKind === null
          ? "none"
          : allowedLoginErrorDiagnostics.has(errorKind) ? errorKind : "unknown";
        fail("LOGIN_CHALLENGE_REJECTED", `Unexpected safe login challenge class (${safeChallenge}/${safeError}).`);
      }
      const challengeBody = new URLSearchParams({ flow: "challenge", returnTo: "/" });
      if (challengeKind === "workspace_selection") {
        challengeBody.set("workspaceUserId", actor.userId);
      } else {
        const code = createTotpCode(actor.totpSecret);
        if (!code) fail("MFA_CODE_UNAVAILABLE", "A QA MFA code could not be generated.");
        challengeBody.set("code", code);
      }
      result = await request("/api/auth/login", {
        body: challengeBody,
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin,
          "sec-fetch-site": "same-origin",
        },
        method: "POST",
      });
      if (!redirectStatuses.has(result.response.status)) {
        fail("LOGIN_CHALLENGE_FAILED", "The isolated QA login challenge did not redirect.");
      }
    }
    if (!cookies.has("novalure_session")) fail("SESSION_COOKIE_MISSING", "The isolated QA login did not create a session.");
    const session = await request("/api/auth/session");
    if (
      session.response.status !== 200 ||
      session.json?.workspace?.id !== actor.workspaceId ||
      session.json?.user?.id !== actor.userId
    ) {
      fail("SESSION_SCOPE_MISMATCH", "The QA session does not match the declared actor and workspace.");
    }
    return session.json;
  }

  async function logout() {
    if (!cookies.has("novalure_session")) return 204;
    const result = await request("/api/auth/logout", { method: "POST" });
    if (result.response.status !== 303) fail("LOGOUT_FAILED", "The QA logout did not complete.");
    return result.response.status;
  }

  return Object.freeze({ bootstrapShareAccess, login, logout, request });
}

function markerIdentity(config) {
  const marker = createHash("sha256")
    .update(`preview-private-blob-lifecycle:v1\0${config.runId}\0${config.expectedGitSha}`)
    .digest("hex")
    .slice(0, 20);
  return Object.freeze({
    fileName: `qa-private-${marker}.png`,
    folder: "qa-private-lifecycle",
    marker,
    name: `QA private Blob ${marker}`,
  });
}

function isCreatedPrivateAsset(asset, identity) {
  return Boolean(
    asset &&
    uuidPattern.test(String(asset.id ?? "")) &&
    asset.name === identity.name &&
    asset.originalName === identity.fileName &&
    asset.folder === identity.folder &&
    asset.mimeType === "image/png" &&
    asset.sizeBytes === previewBlobMagicBytes.byteLength &&
    asset.accessClass === "private" &&
    asset.isPublic === false &&
    asset.hasActivePublicShare === false &&
    asset.publicUrl === null &&
    asset.url === `/api/media/files/${asset.id}`
  );
}

function markerMatches(assets, identity) {
  return assets.filter((asset) =>
    asset?.name === identity.name ||
    asset?.originalName === identity.fileName,
  );
}

function aggregateRequests(requestLog) {
  const counts = new Map();
  for (const request of requestLog) {
    const key = `${request.method}\0${request.route}\0${request.status}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([key, count]) => {
      const [method, route, status] = key.split("\0");
      return { count, method, route, status: Number(status) };
    })
    .sort((left, right) => `${left.method} ${left.route} ${left.status}`.localeCompare(`${right.method} ${right.route} ${right.status}`));
}

function normalizeLegacyMigrationProof(config, proof) {
  if (!proof) {
    return Object.freeze({
      candidateCommit: config.expectedGitSha,
      evidenceDigest: null,
      legacyObjectCountAfter: null,
      legacyObjectCountBefore: null,
      migratedObjectCount: null,
      migrationReceipt: null,
      productionMutationPerformed: false,
      reasonCode: "SEPARATE_LEGACY_CUTOVER_EVIDENCE_REQUIRED",
      status: "UNPROVEN",
      storeFingerprint: config.independentBlob?.storeFingerprint ?? null,
    });
  }
  try {
    validateLegacyBlobMigrationProof({
      expectedCandidateCommit: config.expectedGitSha,
      expectedDatabaseBranchId: config.expectedDatabaseBranchId,
      expectedDeploymentId: config.deploymentId,
      expectedTargetStoreFingerprint: config.independentBlob?.storeFingerprint,
      proof,
    });
  } catch {
    fail("LEGACY_MIGRATION_PROOF_INVALID", "Legacy Blob migration proof is not bound to the exact candidate and isolated Preview store.");
  }
  return Object.freeze({
    candidateCommit: proof.candidateCommit,
    evidence: proof.evidence,
    evidenceDigest: proof.evidenceDigest,
    legacyObjectCountAfter: proof.legacyObjectCountAfter,
    legacyObjectCountBefore: proof.legacyObjectCountBefore,
    migratedObjectCount: proof.migratedObjectCount,
    migrationReceipt: proof.migrationReceipt ?? null,
    productionMutationPerformed: false,
    reasonCode: null,
    status: "VERIFIED",
    storeFingerprint: proof.storeFingerprint,
  });
}

function createEvidence(config, independentInspectorAvailable, legacyMigrationProof) {
  return {
    actor: {
      crossTenantUserFingerprint: fingerprint("preview-blob-cross-user:v1", config.crossTenantActor.userId),
      crossTenantWorkspaceFingerprint: fingerprint("preview-blob-cross-workspace:v1", config.crossTenantActor.workspaceId),
      userFingerprint: fingerprint("preview-blob-user:v1", config.actor.userId),
      workspaceFingerprint: fingerprint("preview-blob-workspace:v1", config.actor.workspaceId),
    },
    checks: [],
    cleanup: {
      attempted: false,
      deleted: false,
      resetFallbackUsed: false,
      state: "not-started",
      verifiedAbsent: false,
    },
    completedAt: null,
    deployment: {
      branch: config.expectedGitBranch,
      databaseBranchId: config.expectedDatabaseBranchId,
      databaseBranchFingerprint: fingerprint("preview-blob-database-branch:v1", config.expectedDatabaseBranchId),
      deploymentHost: config.expectedHost,
      deploymentId: config.deploymentId,
      gitSha: config.expectedGitSha,
      hostFingerprint: fingerprint("preview-blob-host:v1", config.expectedHost),
      originFingerprint: fingerprint("preview-blob-origin:v1", config.baseOrigin),
    },
    failureCode: null,
    independentStoreProof: {
      afterDeleteCount: null,
      afterUploadCount: null,
      beforeCount: null,
      headVerified: false,
      newObjectCount: null,
      objectAbsentAfterDelete: false,
      reasonCode: independentInspectorAvailable ? null : "LOCAL_PRIVATE_STORE_INSPECTOR_UNAVAILABLE",
      status: independentInspectorAvailable ? "PENDING" : "UNPROVEN",
      storeFingerprint: config.independentBlob?.storeFingerprint ?? null,
    },
    legacyObjectMigrationProof: legacyMigrationProof,
    lifecycle: {
      accessClass: null,
      assetFingerprint: null,
      contentFingerprint: fingerprint("preview-blob-content:v1", previewBlobMagicBytes),
      listMatchesAfterDelete: null,
      listMatchesAfterUpload: null,
      listMatchesBefore: null,
      markerFingerprint: null,
      readHeadersVerified: false,
      readbackBytesVerified: false,
      sizeBytes: previewBlobMagicBytes.byteLength,
      unauthenticatedReadDenied: false,
      crossTenantReadDenied: false,
    },
    productionMutationPerformed: false,
    requests: [],
    releaseGatePassed: false,
    runFingerprint: fingerprint("preview-blob-run:v1", config.runId),
    schema: "novalure.qa.preview-blob-lifecycle.v1",
    startedAt: new Date().toISOString(),
    status: "RUNNING",
    technicalStatus: "RUNNING",
  };
}

function addCheck(evidence, id, condition, failureCode) {
  evidence.checks.push({ id, status: condition ? "PASS" : "FAIL" });
  if (!condition) fail(failureCode, `Lifecycle check failed: ${id}.`);
}

function controlledError(error) {
  if (error instanceof PreviewBlobLifecycleError) return error;
  return new PreviewBlobLifecycleError("UNEXPECTED_FAILURE", "The lifecycle runner stopped on an unexpected failure.", { cause: error });
}

async function listAssets(client) {
  const result = await client.request("/api/media");
  if (result.response.status !== 200 || !Array.isArray(result.json?.assets)) {
    fail("MEDIA_LIST_FAILED", "The authenticated media list could not be verified.");
  }
  return result.json.assets;
}

async function deleteExactPrivateAsset(client, asset, identity) {
  if (!isCreatedPrivateAsset(asset, identity)) {
    fail("CLEANUP_SCOPE_REJECTED", "Cleanup refused an asset outside the exact private marker scope.");
  }
  const result = await client.request(`/api/media/${asset.id}`, { method: "DELETE" });
  if (result.response.status !== 200 || result.json?.deleted?.id !== asset.id) {
    fail("MEDIA_DELETE_FAILED", "The exact private test asset was not deleted.");
  }
}

async function reconcileAndCleanup(client, identity, knownAsset) {
  const assets = await listAssets(client);
  const matches = markerMatches(assets, identity);
  if (matches.length === 0) return { deleted: false, state: "already-absent", verifiedAbsent: true };
  if (matches.length !== 1) fail("CLEANUP_AMBIGUOUS", "Cleanup found an ambiguous marker set and performed no deletion.");
  const asset = matches[0];
  if (knownAsset?.id && asset.id !== knownAsset.id) {
    fail("CLEANUP_IDENTITY_MISMATCH", "Cleanup found a different asset for the run marker.");
  }
  await deleteExactPrivateAsset(client, asset, identity);
  const afterDelete = await listAssets(client);
  if (markerMatches(afterDelete, identity).length !== 0) {
    fail("CLEANUP_VERIFICATION_FAILED", "The private test marker remained after deletion.");
  }
  const missing = await client.request(`/api/media/files/${asset.id}`);
  if (missing.response.status !== 404) {
    fail("CLEANUP_404_FAILED", "The deleted private test asset did not return 404.");
  }
  return { deleted: true, state: "deleted-and-absent", verifiedAbsent: true };
}

export async function runPreviewBlobLifecycle(
  config,
  { blobInspector = null, fetchImpl = globalThis.fetch, legacyMigrationProof = null, shareUrl = null } = {},
) {
  const verifiedLegacyMigrationProof = normalizeLegacyMigrationProof(config, legacyMigrationProof);
  const evidence = createEvidence(config, Boolean(blobInspector), verifiedLegacyMigrationProof);
  const identity = markerIdentity(config);
  evidence.lifecycle.markerFingerprint = fingerprint("preview-blob-marker:v1", identity.marker);
  const requestLog = [];
  const client = createPreviewBlobHttpClient(config, { fetchImpl, requestLog });
  const publicClient = createPreviewBlobHttpClient(config, { fetchImpl, requestLog });
  const crossTenantClient = createPreviewBlobHttpClient(config, { fetchImpl, requestLog });
  let authenticated = false;
  let crossTenantAuthenticated = false;
  let uploadAttempted = false;
  let createdAsset = null;
  let independentObjectPath = null;
  let independentBaselinePaths = null;
  let failure = null;
  const independentPrefix = `${config.actor.workspaceId}/qa-private-lifecycle/`;
  try {
    await client.bootstrapShareAccess(shareUrl);
    await client.login(config.actor);
    authenticated = true;
    addCheck(evidence, "auth.session_exact_scope", true, "SESSION_SCOPE_MISMATCH");

    const capability = await client.request("/api/admin/qa-batch-capability");
    addCheck(
      evidence,
      "deployment.capability_available",
      capability.response.status === 200 && capability.json?.atomicRegistration === true,
      "CAPABILITY_UNAVAILABLE",
    );
    addCheck(
      evidence,
      "deployment.origin_host_exact",
      capability.json?.deploymentHost === config.expectedHost,
      "DEPLOYMENT_HOST_MISMATCH",
    );
    addCheck(
      evidence,
      "deployment.id_exact",
      capability.json?.deploymentId === config.deploymentId,
      "DEPLOYMENT_ID_MISMATCH",
    );
    addCheck(
      evidence,
      "deployment.database_branch_exact",
      capability.json?.databaseBranchId === config.expectedDatabaseBranchId,
      "DATABASE_BRANCH_MISMATCH",
    );
    addCheck(
      evidence,
      "deployment.git_sha_exact",
      capability.json?.gitSha === config.expectedGitSha,
      "DEPLOYMENT_SHA_MISMATCH",
    );
    addCheck(
      evidence,
      "deployment.git_branch_exact",
      capability.json?.gitBranch === config.expectedGitBranch,
      "DEPLOYMENT_BRANCH_MISMATCH",
    );

    const before = await listAssets(client);
    const beforeMatches = markerMatches(before, identity);
    evidence.lifecycle.listMatchesBefore = beforeMatches.length;
    addCheck(evidence, "list.marker_absent_before", beforeMatches.length === 0, "MARKER_ALREADY_EXISTS");
    if (blobInspector) {
      const independentBefore = await blobInspector.listPrefix(independentPrefix);
      if (!Array.isArray(independentBefore)) fail("BLOB_INSPECTOR_LIST_INVALID", "Independent Blob listing returned an invalid result.");
      independentBaselinePaths = new Set(independentBefore.map((blob) => blob.pathname));
      if (independentBaselinePaths.size !== independentBefore.length) {
        fail("BLOB_INSPECTOR_LIST_DUPLICATE", "Independent Blob listing returned duplicate objects.");
      }
      evidence.independentStoreProof.beforeCount = independentBefore.length;
    }

    const form = new FormData();
    form.set("alt", identity.name);
    form.set("file", new File([previewBlobMagicBytes], identity.fileName, { type: "image/png" }));
    form.set("folder", identity.folder);
    form.set("name", identity.name);
    uploadAttempted = true;
    const upload = await client.request("/api/media", { body: form, method: "POST" });
    createdAsset = upload.json?.asset ?? null;
    addCheck(evidence, "upload.http_created", upload.response.status === 201, "MEDIA_UPLOAD_FAILED");
    addCheck(evidence, "upload.private_contract", isCreatedPrivateAsset(createdAsset, identity), "PRIVATE_ASSET_CONTRACT_FAILED");
    evidence.lifecycle.accessClass = createdAsset.accessClass;
    evidence.lifecycle.assetFingerprint = fingerprint("preview-blob-asset:v1", createdAsset.id);

    const afterUpload = await listAssets(client);
    const afterUploadMatches = markerMatches(afterUpload, identity);
    evidence.lifecycle.listMatchesAfterUpload = afterUploadMatches.length;
    addCheck(
      evidence,
      "list.private_asset_once",
      afterUploadMatches.length === 1 && isCreatedPrivateAsset(afterUploadMatches[0], identity) && afterUploadMatches[0].id === createdAsset.id,
      "MEDIA_LIST_CONTRACT_FAILED",
    );
    if (blobInspector) {
      const independentAfterUpload = await blobInspector.listPrefix(independentPrefix);
      if (!Array.isArray(independentAfterUpload)) fail("BLOB_INSPECTOR_LIST_INVALID", "Independent Blob listing returned an invalid result.");
      const newObjects = independentAfterUpload.filter((blob) => !independentBaselinePaths.has(blob.pathname));
      evidence.independentStoreProof.afterUploadCount = independentAfterUpload.length;
      evidence.independentStoreProof.newObjectCount = newObjects.length;
      addCheck(evidence, "store.list_one_new_private_object", newObjects.length === 1, "BLOB_INSPECTOR_DELTA_MISMATCH");
      independentObjectPath = newObjects[0].pathname;
      const objectHead = await blobInspector.headPath(independentObjectPath);
      const headVerified =
        objectHead?.pathname === independentObjectPath &&
        objectHead?.size === previewBlobMagicBytes.byteLength &&
        objectHead?.contentType === "image/png";
      evidence.independentStoreProof.headVerified = headVerified;
      addCheck(evidence, "store.head_private_object_exact", headVerified, "BLOB_INSPECTOR_HEAD_CONTRACT_FAILED");
    }

    await publicClient.bootstrapShareAccess(shareUrl);
    const anonymousRead = await publicClient.request(`/api/media/files/${createdAsset.id}`);
    const anonymousDenied =
      [401, 404].includes(anonymousRead.response.status) &&
      !(anonymousRead.response.headers.get("content-type") ?? "").startsWith("image/") &&
      !anonymousRead.response.headers.has("content-disposition");
    evidence.lifecycle.unauthenticatedReadDenied = anonymousDenied;
    addCheck(evidence, "read.unauthenticated_denied_without_leak", anonymousDenied, "UNAUTHENTICATED_READ_LEAK");

    await crossTenantClient.bootstrapShareAccess(shareUrl);
    await crossTenantClient.login(config.crossTenantActor);
    crossTenantAuthenticated = true;
    const crossTenantRead = await crossTenantClient.request(`/api/media/files/${createdAsset.id}`);
    const crossTenantDenied =
      [403, 404].includes(crossTenantRead.response.status) &&
      !(crossTenantRead.response.headers.get("content-type") ?? "").startsWith("image/") &&
      !crossTenantRead.response.headers.has("content-disposition");
    evidence.lifecycle.crossTenantReadDenied = crossTenantDenied;
    addCheck(evidence, "read.cross_tenant_denied_without_leak", crossTenantDenied, "CROSS_TENANT_READ_LEAK");
    const crossTenantAssets = await listAssets(crossTenantClient);
    addCheck(
      evidence,
      "list.cross_tenant_marker_absent",
      markerMatches(crossTenantAssets, identity).length === 0,
      "CROSS_TENANT_LIST_LEAK",
    );

    const readback = await client.request(`/api/media/files/${createdAsset.id}`, { responseKind: "bytes" });
    const byteMatch = readback.response.status === 200 && Buffer.compare(readback.bytes, previewBlobMagicBytes) === 0;
    const headersMatch =
      readback.response.headers.get("content-type") === "image/png" &&
      readback.response.headers.get("content-length") === String(previewBlobMagicBytes.byteLength) &&
      readback.response.headers.get("cache-control") === "private, no-store" &&
      readback.response.headers.get("cross-origin-resource-policy") === "same-origin" &&
      readback.response.headers.get("x-content-type-options") === "nosniff" &&
      (readback.response.headers.get("content-disposition") ?? "").startsWith("inline;");
    evidence.lifecycle.readbackBytesVerified = byteMatch;
    evidence.lifecycle.readHeadersVerified = headersMatch;
    addCheck(evidence, "read.private_bytes_exact", byteMatch, "PRIVATE_READBACK_MISMATCH");
    addCheck(evidence, "read.private_headers_exact", headersMatch, "PRIVATE_READBACK_HEADERS_MISMATCH");

    await deleteExactPrivateAsset(client, createdAsset, identity);
    evidence.cleanup.attempted = true;
    evidence.cleanup.deleted = true;
    const afterDelete = await listAssets(client);
    const afterDeleteMatches = markerMatches(afterDelete, identity);
    evidence.lifecycle.listMatchesAfterDelete = afterDeleteMatches.length;
    addCheck(evidence, "delete.list_null_rest", afterDeleteMatches.length === 0, "MEDIA_DELETE_LIST_REST_FAILED");
    const missing = await client.request(`/api/media/files/${createdAsset.id}`);
    addCheck(evidence, "delete.read_returns_404", missing.response.status === 404, "MEDIA_DELETE_404_FAILED");
    if (blobInspector) {
      const independentAfterDelete = await blobInspector.listPrefix(independentPrefix);
      const objectHeadAfterDelete = independentObjectPath
        ? await blobInspector.headPath(independentObjectPath)
        : null;
      const objectAbsent =
        independentObjectPath !== null &&
        !independentAfterDelete.some((blob) => blob.pathname === independentObjectPath) &&
        objectHeadAfterDelete === null;
      evidence.independentStoreProof.afterDeleteCount = independentAfterDelete.length;
      evidence.independentStoreProof.objectAbsentAfterDelete = objectAbsent;
      evidence.independentStoreProof.reasonCode = objectAbsent ? null : "OBJECT_REMAINS_AFTER_DELETE";
      evidence.independentStoreProof.status = objectAbsent ? "VERIFIED" : "FAILED";
      addCheck(evidence, "store.list_and_head_absent_after_delete", objectAbsent, "BLOB_INSPECTOR_DELETE_REST_FAILED");
    }
    evidence.cleanup.state = "deleted-and-absent";
    evidence.cleanup.verifiedAbsent = true;
  } catch (error) {
    failure = controlledError(error);
  } finally {
    if (authenticated && uploadAttempted && !evidence.cleanup.verifiedAbsent) {
      evidence.cleanup.attempted = true;
      try {
        const cleanup = await reconcileAndCleanup(client, identity, createdAsset);
        evidence.cleanup.deleted ||= cleanup.deleted;
        evidence.cleanup.state = cleanup.state;
        evidence.cleanup.verifiedAbsent = cleanup.verifiedAbsent;
      } catch (cleanupError) {
        const controlledCleanupError = controlledError(cleanupError);
        evidence.cleanup.state = controlledCleanupError.code === "CLEANUP_SCOPE_REJECTED"
          ? "scope-rejected-no-mutation"
          : "cleanup-failed";
        failure = failure
          ? new PreviewBlobLifecycleError("LIFECYCLE_AND_CLEANUP_FAILED", "The lifecycle and its exact cleanup both failed.", {
              cause: new AggregateError([failure, controlledCleanupError]),
            })
          : controlledCleanupError;
      }
    } else if (!uploadAttempted) {
      if (evidence.lifecycle.listMatchesBefore === 0) {
        evidence.cleanup.state = "no-upload-attempted";
        evidence.cleanup.verifiedAbsent = true;
      } else if ((evidence.lifecycle.listMatchesBefore ?? 0) > 0) {
        evidence.cleanup.state = "existing-marker-unresolved";
        evidence.cleanup.verifiedAbsent = false;
      } else {
        evidence.cleanup.state = "no-upload-attempted-absence-unproven";
        evidence.cleanup.verifiedAbsent = false;
      }
    }
    if (crossTenantAuthenticated) {
      try {
        await crossTenantClient.logout();
      } catch (logoutError) {
        failure ??= controlledError(logoutError);
      }
    }
    if (authenticated) {
      try {
        await client.logout();
      } catch (logoutError) {
        failure ??= controlledError(logoutError);
      }
    }
  }

  evidence.completedAt = new Date().toISOString();
  evidence.failureCode = failure?.code ?? null;
  evidence.requests = aggregateRequests(requestLog);
  evidence.technicalStatus = failure || !evidence.cleanup.verifiedAbsent
    ? "FAIL"
    : evidence.independentStoreProof.status === "VERIFIED" ? "PASS" : "BLOCKED";
  evidence.releaseGatePassed =
    evidence.technicalStatus === "PASS" &&
    evidence.legacyObjectMigrationProof.status === "VERIFIED";
  evidence.status = failure || !evidence.cleanup.verifiedAbsent
    ? "FAIL"
    : evidence.releaseGatePassed ? "PASS" : "BLOCKED";
  assertEvidenceSafe(evidence);
  return Object.freeze({ evidence, error: failure });
}

export function assertEvidenceSafe(value, currentPath = "evidence") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertEvidenceSafe(item, `${currentPath}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") {
    if (typeof value === "string" && forbiddenEvidenceValue.test(value)) {
      fail("EVIDENCE_REDACTION_FAILED", `Sensitive-looking evidence value rejected at ${currentPath}.`);
    }
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (forbiddenEvidenceKey.test(key)) {
      fail("EVIDENCE_REDACTION_FAILED", `Secret-shaped evidence key rejected at ${currentPath}.${key}.`);
    }
    assertEvidenceSafe(child, `${currentPath}.${key}`);
  }
}

export function canonicalJson(value) {
  const normalize = (input) => {
    if (Array.isArray(input)) return input.map(normalize);
    if (!input || typeof input !== "object") return input;
    return Object.fromEntries(Object.keys(input).sort().map((key) => [key, normalize(input[key])]));
  };
  return `${JSON.stringify(normalize(value), null, 2)}\n`;
}

export async function writePreviewBlobLifecycleEvidence(config, evidence) {
  assertEvidenceSafe(evidence);
  const serialized = canonicalJson(evidence);
  const digest = createHash("sha256").update(serialized).digest("hex");
  const evidenceName = "preview-blob-lifecycle.json";
  const digestName = "preview-blob-lifecycle.sha256";
  await mkdir(config.evidenceDirectory, { mode: 0o700, recursive: true });
  await writeFile(path.join(config.evidenceDirectory, evidenceName), serialized, { encoding: "utf8", flag: "wx", mode: 0o600 });
  await writeFile(
    path.join(config.evidenceDirectory, digestName),
    `${digest}  ${evidenceName}\n`,
    { encoding: "utf8", flag: "wx", mode: 0o600 },
  );
  return Object.freeze({ digest, directory: config.evidenceDirectory });
}

export const previewBlobLifecycleExecutionConfirmation = executionConfirmation;
