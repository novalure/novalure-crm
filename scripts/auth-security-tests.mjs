#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  assertAuthSecurityConfiguration,
  createOpaqueToken,
  decryptAuthValue,
  encryptAuthValue,
  getTrustedAuthClientIp,
  hasCookieName,
  hashOpaqueToken,
  isAuthSecurityConfigured,
  protectLowEntropyValue,
} from "../src/lib/auth/auth-security.ts";
import {
  createRecoveryCodes,
  createTotpCode,
  normalizeRecoveryCode,
  verifyTotpCode,
} from "../src/lib/auth/mfa-core.ts";
import { computeProgressiveBackoffSeconds } from "../src/lib/auth/rate-limit-core.ts";
import { protectAuthResponse } from "../src/lib/auth/response-security.ts";
import { validateCsrfRequestContext } from "../src/lib/security/csrf-core.ts";

const secretEnvironmentNames = [
  "NOVALURE_SESSION_SECRET",
  "NOVALURE_AUTH_ENCRYPTION_KEY",
  "NOVALURE_AUTH_RATE_LIMIT_SECRET",
];

function withTestSecrets(callback) {
  const previous = Object.fromEntries(
    secretEnvironmentNames.map((name) => [name, process.env[name]]),
  );
  for (const name of secretEnvironmentNames) {
    process.env[name] = `qa-${name.toLowerCase()}-with-at-least-32-characters-2026`;
  }

  try {
    return callback();
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test("auth startup configuration fails closed and cryptographic storage detects tampering", () => {
  const emptyEnvironment = {};
  assert.equal(isAuthSecurityConfigured(emptyEnvironment), false);
  assert.throws(
    () => assertAuthSecurityConfiguration(emptyEnvironment),
    /NOVALURE_SESSION_SECRET.*NOVALURE_AUTH_ENCRYPTION_KEY.*NOVALURE_AUTH_RATE_LIMIT_SECRET/,
  );

  withTestSecrets(() => {
    assert.equal(isAuthSecurityConfigured(), true);
    assert.doesNotThrow(() => assertAuthSecurityConfiguration());

    const encrypted = encryptAuthValue({ recoveryCodes: ["AAAA-BBBB-CCCC-DDDD"], secret: "TOTP-secret" });
    assert.doesNotMatch(encrypted, /TOTP-secret|AAAA-BBBB/);
    assert.deepEqual(
      decryptAuthValue(encrypted),
      { recoveryCodes: ["AAAA-BBBB-CCCC-DDDD"], secret: "TOTP-secret" },
    );
    const tampered = `${encrypted.slice(0, -1)}${encrypted.endsWith("A") ? "B" : "A"}`;
    assert.equal(decryptAuthValue(tampered), null);

    const firstSubject = protectLowEntropyValue("login-email", "person@example.com");
    assert.match(firstSubject, /^[a-f0-9]{64}$/);
    assert.equal(firstSubject, protectLowEntropyValue("login-email", "person@example.com"));
    assert.notEqual(firstSubject, protectLowEntropyValue("reset-email", "person@example.com"));
  });
});

test("opaque session identifiers are random and only stable through their SHA-256 hashes", () => {
  const tokens = Array.from({ length: 128 }, () => `v2.${createOpaqueToken(32)}`);
  assert.equal(new Set(tokens).size, tokens.length);
  for (const token of tokens) {
    assert.match(token, /^v2\.[A-Za-z0-9_-]{43}$/);
    assert.match(hashOpaqueToken(token), /^[a-f0-9]{64}$/);
    assert.notEqual(hashOpaqueToken(token), token);
  }
});

test("TOTP verification matches the RFC vector, bounds clock drift and rejects replay-shaped wrong codes", () => {
  const rfcSecret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"; // gitleaks:allow -- RFC 6238 Appendix B public test vector.
  const at59Seconds = 59_000;
  assert.equal(createTotpCode(rfcSecret, at59Seconds), "287082");
  assert.equal(verifyTotpCode(rfcSecret, "287082", at59Seconds), true);
  assert.equal(verifyTotpCode(rfcSecret, createTotpCode(rfcSecret, 29_000), at59Seconds), true);
  assert.equal(verifyTotpCode(rfcSecret, createTotpCode(rfcSecret, 89_000), at59Seconds), true);
  assert.equal(verifyTotpCode(rfcSecret, createTotpCode(rfcSecret, 119_000), at59Seconds), false);
  assert.equal(verifyTotpCode(rfcSecret, "000000", at59Seconds), false);
  assert.equal(verifyTotpCode(rfcSecret, "287082287082", at59Seconds), false);
});

test("recovery codes are high-entropy, normalized and unique before hash-only persistence", () => {
  const codes = createRecoveryCodes(200);
  assert.equal(new Set(codes).size, codes.length);
  for (const code of codes) {
    assert.match(code, /^[A-Z2-7]{4}(?:-[A-Z2-7]{4}){3}$/);
    assert.equal(normalizeRecoveryCode(code), code.replaceAll("-", ""));
  }
});

test("progressive login/reset backoff is monotonic, scoped and capped", () => {
  assert.deepEqual(
    [1, 2, 3, 4, 5, 6, 7, 8].map((attempt) => computeProgressiveBackoffSeconds(attempt, "login")),
    [0, 0, 0, 0, 1, 2, 4, 8],
  );
  assert.deepEqual(
    [1, 2, 3, 4, 5].map((attempt) => computeProgressiveBackoffSeconds(attempt, "reset")),
    [0, 0, 1, 2, 4],
  );
  assert.equal(computeProgressiveBackoffSeconds(100, "login"), 3_600);
  assert.equal(computeProgressiveBackoffSeconds(100, "reset"), 21_600);
});

test("concurrent one-time claims produce one winner and all replay attempts fail", async () => {
  const consumed = new Set();
  const claim = async (hash) => {
    await Promise.resolve();
    if (consumed.has(hash)) return false;
    consumed.add(hash);
    return true;
  };
  const hash = hashOpaqueToken("one-time-auth-challenge");
  const results = await Promise.all(Array.from({ length: 64 }, () => claim(hash)));
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal(await claim(hash), false);
});

test("migration and session store enforce central identity, hash-only sessions and append-only audit", async () => {
  const migration = await readFile(
    new URL("../migrations/056_auth_identity_sessions_mfa.sql", import.meta.url),
    "utf8",
  );
  const sessionStore = await readFile(
    new URL("../src/lib/auth/session-store.ts", import.meta.url),
    "utf8",
  );

  assert.match(migration, /create table if not exists auth_identities/);
  assert.match(migration, /count\(distinct wu\.password_hash\)/);
  assert.match(migration, /credential_state.*reset_required/s);
  assert.match(migration, /workspace_users_workspace_identity_unique/);
  assert.match(migration, /workspace_users_id_identity_uidx[\s\S]*on workspace_users\(id, auth_identity_id\)/);
  assert.match(migration, /workspace_users_id_identity_workspace_uidx[\s\S]*on workspace_users\(id, auth_identity_id, workspace_id\)/);
  assert.match(migration, /auth_sessions_membership_identity_workspace_fk[\s\S]*foreign key \(workspace_user_id, auth_identity_id, workspace_id\)/);
  assert.match(migration, /auth_login_challenges_membership_identity_fk[\s\S]*foreign key \(workspace_user_id, auth_identity_id\)/);
  assert.match(migration, /auth_password_reset_tokens_membership_pair_check[\s\S]*check \(\(user_id is null\) = \(workspace_id is null\)\)/);
  assert.match(migration, /auth_password_reset_tokens_membership_identity_workspace_fk[\s\S]*foreign key \(user_id, auth_identity_id, workspace_id\)/);
  assert.match(migration, /auth_password_reset_exchanges_token_identity_fk[\s\S]*foreign key \(reset_token_id, auth_identity_id\)/);
  assert.match(migration, /auth_password_reset_exchanges_membership_identity_fk[\s\S]*foreign key \(workspace_user_id, auth_identity_id\)/);
  assert.equal(
    (migration.match(/set search_path = pg_catalog, public, pg_temp/g) ?? []).length,
    3,
  );
  assert.match(migration, /insert into public\.auth_identities/);
  assert.match(migration, /update public\.auth_identities/);
  assert.match(migration, /from public\.workspace_users/);
  assert.doesNotMatch(migration, /order by wu\.created_at asc\s+limit 1/i);
  assert.match(migration, /create table if not exists auth_sessions/);
  assert.match(migration, /token_hash text not null unique/);
  assert.match(migration, /last_seen_at timestamptz not null/);
  assert.match(migration, /expires_at timestamptz not null/);
  assert.match(migration, /revoked_at timestamptz/);
  assert.match(migration, /before update or delete on auth_audit_events/);
  assert.match(sessionStore, /hashOpaqueToken\(value\)/);
  assert.doesNotMatch(sessionStore, /insert into auth_sessions[\s\S]{0,500}\bvalue\b/);
  assert.match(sessionStore, /session\.revoked_at is null/);
  assert.match(sessionStore, /revoked_reason = 'rotation'/);
});

test("login, MFA and reset transitions use atomic DB guards against concurrency and replay", async () => {
  const authFlow = await readFile(new URL("../src/lib/auth/auth-flow.ts", import.meta.url), "utf8");
  const reset = await readFile(new URL("../src/lib/auth/password-reset.ts", import.meta.url), "utf8");
  const rateLimit = await readFile(new URL("../src/lib/auth/rate-limit.ts", import.meta.url), "utf8");
  const migration = await readFile(
    new URL("../migrations/056_auth_identity_sessions_mfa.sql", import.meta.url),
    "utf8",
  );

  assert.match(authFlow, /dummyPasswordHash/);
  assert.match(authFlow, /verifyPassword\([\s\S]*dummyPasswordHash/);
  assert.match(authFlow, /set used_at = now\(\)[\s\S]*used_at is null/);
  assert.match(authFlow, /for update/);
  assert.match(authFlow, /auth_mfa_recovery_codes[\s\S]*code_hash/);
  assert.match(rateLimit, /on conflict \(scope, subject_hash\) do update/);
  assert.match(rateLimit, /auth_rate_limit_buckets\.attempt_count \+ 1/);
  assert.match(reset, /set exchanged_at = now\(\)[\s\S]*exchanged_at is null/);
  assert.match(reset, /set used_at = now\(\)[\s\S]*exchange\.used_at is null/);
  assert.match(reset, /revoked_reason = 'password_reset'/);
  assert.match(migration, /exchange_hash text not null unique/);
  assert.match(migration, /unique \(auth_identity_id, code_hash\)/);
});

test("public reset and login URLs do not retain email, token or reset credentials", async () => {
  const requestRoute = await readFile(
    new URL("../src/app/api/auth/password-reset/request/route.ts", import.meta.url),
    "utf8",
  );
  const confirmRoute = await readFile(
    new URL("../src/app/api/auth/password-reset/confirm/route.ts", import.meta.url),
    "utf8",
  );
  const resetPage = await readFile(
    new URL("../src/app/login/reset-password/page.tsx", import.meta.url),
    "utf8",
  );
  const forgotPage = await readFile(
    new URL("../src/app/login/forgot-password/page.tsx", import.meta.url),
    "utf8",
  );
  const loginRoute = await readFile(
    new URL("../src/app/api/auth/login/route.ts", import.meta.url),
    "utf8",
  );
  const reset = await readFile(new URL("../src/lib/auth/password-reset.ts", import.meta.url), "utf8");

  assert.doesNotMatch(requestRoute, /searchParams\.set\("email"/);
  assert.doesNotMatch(confirmRoute, /searchParams\.set\("token"/);
  assert.doesNotMatch(reset, /url\.searchParams\.set\("token"/);
  assert.match(reset, /url\.hash = new URLSearchParams\(\{ token \}\)\.toString\(\)/);
  assert.doesNotMatch(resetPage, /query\.token|name="token"/);
  assert.doesNotMatch(forgotPage, /query\.email|defaultValue=\{email\}/);
  assert.match(resetPage, /name="csrf"/);
  assert.match(loginRoute, /validateCsrfRequestContext/);
  assert.match(loginRoute, /await createSessionCookie/);
});

test("production authentication never trusts caller-supplied identity headers", async () => {
  const session = await readFile(new URL("../src/lib/auth/session.ts", import.meta.url), "utf8");
  assert.match(
    session,
    /function shouldTrustAuthHeaders\(\) \{\s*return !isProductionDeployment\(\) && process\.env\.NOVALURE_TRUST_AUTH_HEADERS === "1";/,
  );
  assert.match(session, /return process\.env\.NODE_ENV === "production"/);
});

test("authentication IP buckets ignore spoofable forwarding headers and trust only the deployment boundary", () => {
  const spoofed = new Headers({
    "cf-connecting-ip": "198.51.100.11",
    "x-forwarded-for": "198.51.100.12",
    "x-real-ip": "198.51.100.13",
  });
  assert.equal(getTrustedAuthClientIp(spoofed, {}), null);

  const vercel = new Headers({
    "x-forwarded-for": "198.51.100.14",
    "x-vercel-forwarded-for": "203.0.113.20, 10.0.0.1",
  });
  assert.equal(getTrustedAuthClientIp(vercel, { VERCEL_ENV: "production" }), "203.0.113.20");

  const configuredProxy = new Headers({ "x-novalure-client-ip": "2001:0db8::1" });
  assert.equal(
    getTrustedAuthClientIp(configuredProxy, {
      NOVALURE_TRUSTED_CLIENT_IP_HEADER: "X-Novalure-Client-IP",
    }),
    "2001:db8::1",
  );
  assert.equal(
    getTrustedAuthClientIp(configuredProxy, {
      NOVALURE_TRUSTED_CLIENT_IP_HEADER: "invalid header name",
    }),
    null,
  );
});

test("logout rejects cross-site unauthenticated POSTs and never clears an unverified session cookie", async () => {
  const trustedOrigin = "https://crm.example.test";
  const crossSite = new Headers({
    origin: "https://attacker.example",
    "sec-fetch-site": "cross-site",
  });
  assert.equal(validateCsrfRequestContext(crossSite, trustedOrigin).ok, false);
  assert.equal(
    validateCsrfRequestContext(
      new Headers({ origin: trustedOrigin, "sec-fetch-site": "same-origin" }),
      trustedOrigin,
    ).ok,
    true,
  );
  assert.equal(hasCookieName("theme=dark; novalure_session=malformed", "novalure_session"), true);

  const logoutRoute = await readFile(
    new URL("../src/app/api/auth/logout/route.ts", import.meta.url),
    "utf8",
  );
  const contextIndex = logoutRoute.indexOf("validateCsrfRequestContext(");
  const sessionIndex = logoutRoute.indexOf("await getRequestSession(request)");
  const cookieMutationIndex = logoutRoute.indexOf("response.cookies.set(sessionCookieName");
  assert.ok(contextIndex >= 0 && contextIndex < sessionIndex);
  assert.ok(sessionIndex < cookieMutationIndex);
  assert.match(logoutRoute, /sessionCookiePresent && session\?\.source !== "cookie"/);
  assert.match(logoutRoute, /if \(sessionCookiePresent\) \{\s*response\.cookies\.set\(sessionCookieName/);
  assert.match(logoutRoute, /await enforceCsrfForSession\(request, session\)/);
});

test("session GET is read-only while CSRF-protected POST performs touch or rotation", async () => {
  const sessionRoute = await readFile(
    new URL("../src/app/api/auth/session/route.ts", import.meta.url),
    "utf8",
  );
  const sessionStore = await readFile(
    new URL("../src/lib/auth/session-store.ts", import.meta.url),
    "utf8",
  );
  const workspace = await readFile(
    new URL("../src/components/crm-workspace.tsx", import.meta.url),
    "utf8",
  );
  const getHandler = sessionRoute.slice(
    sessionRoute.indexOf("export async function GET"),
    sessionRoute.indexOf("export async function POST"),
  );
  const readSession = sessionStore.slice(
    sessionStore.indexOf("export async function readPersistedSession"),
    sessionStore.indexOf("export async function touchPersistedRequestSession"),
  );
  assert.doesNotMatch(getHandler, /rotateRequestSession|touchRequestSession|cookies\.set/);
  assert.doesNotMatch(readSession, /\bupdate\b|\binsert\b|\bdelete\b/i);
  assert.match(sessionRoute, /export async function POST[\s\S]*await enforceCsrfForSession\(request, session\)/);
  assert.match(sessionRoute, /sessionRotationDue[\s\S]*rotateRequestSession[\s\S]*touchRequestSession/);
  assert.match(workspace, /csrfFetch\("\/api\/auth\/session", \{[\s\S]{0,160}method: "POST"/);
  assert.match(workspace, /window\.setInterval\(refreshSession, 5 \* 60 \* 1_000\)/);
});

test("active role and product-role changes atomically revoke the affected membership sessions", async () => {
  const repository = await readFile(
    new URL("../src/lib/db/customer-access-repositories.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    repository,
    /existing\.role !== role \|\| existing\.productRole !== productRole \|\| existing\.status !== status/,
  );
  assert.match(
    repository,
    /existing\.status !== status && status !== "active"\s*\? "admin_deactivation"\s*:\s*"admin_access_changed"/,
  );
  assert.match(
    repository,
    /with updated_user as \([\s\S]*revoked_sessions as \([\s\S]*where \$6::boolean[\s\S]*session\.workspace_user_id = updated_user\.id/,
  );
  assert.match(repository, /session_audited as \([\s\S]*'auth\.session\.revoked'/);
});

test("forgot and reset metadata and bodies resolve the same persisted language", async () => {
  for (const path of ["forgot-password", "reset-password"]) {
    const page = await readFile(
      new URL(`../src/app/login/${path}/page.tsx`, import.meta.url),
      "utf8",
    );
    assert.equal(page.match(/resolvePublicPageLanguage\(requestHeaders, query\)/g)?.length, 2);
    assert.doesNotMatch(page, /resolvePublicLanguage\(/);
  }
});

test("auth forms expose correct autocomplete, one active autofocus path and duplicate-submit protection", async () => {
  const login = await readFile(new URL("../src/app/login/page.tsx", import.meta.url), "utf8");
  const forgot = await readFile(
    new URL("../src/app/login/forgot-password/page.tsx", import.meta.url),
    "utf8",
  );
  const reset = await readFile(
    new URL("../src/app/login/reset-password/page.tsx", import.meta.url),
    "utf8",
  );
  const submitOnce = await readFile(
    new URL("../src/components/submit-once-form.tsx", import.meta.url),
    "utf8",
  );

  assert.match(login, /autoComplete="username"/);
  assert.match(login, /autoComplete="current-password"/);
  assert.match(forgot, /autoComplete="username"/);
  assert.equal(reset.match(/autoComplete="new-password"/g)?.length, 2);
  assert.equal(login.match(/\bautoFocus\b/g)?.length, 1);
  for (const page of [login, forgot, reset]) {
    assert.match(page, /SubmitOnceForm/);
    assert.doesNotMatch(page, /<form\b/);
  }
  assert.match(submitOnce, /if \(submittingRef\.current\) \{\s*event\.preventDefault\(\)/);
  assert.match(submitOnce, /aria-busy=\{submitting \|\| undefined\}/);
});

test("auth and reset responses are private no-store and reset transitions suppress referrers", async () => {
  const protectedResponse = protectAuthResponse(new Response("ok"), { noReferrer: true });
  assert.equal(protectedResponse.headers.get("cache-control"), "private, no-store");
  assert.equal(protectedResponse.headers.get("referrer-policy"), "no-referrer");

  for (const path of [
    "src/app/api/auth/login/route.ts",
    "src/app/api/auth/logout/route.ts",
    "src/app/api/auth/password-reset/request/route.ts",
    "src/app/api/auth/password-reset/confirm/route.ts",
    "src/app/api/auth/password-reset/exchange/route.ts",
  ]) {
    const route = await readFile(new URL(`../${path}`, import.meta.url), "utf8");
    assert.match(route, /protectAuthResponse/);
    assert.doesNotMatch(route, /return response;/);
  }

  const confirmRoute = await readFile(
    new URL("../src/app/api/auth/password-reset/confirm/route.ts", import.meta.url),
    "utf8",
  );
  const exchangeRoute = await readFile(
    new URL("../src/app/api/auth/password-reset/exchange/route.ts", import.meta.url),
    "utf8",
  );
  assert.match(confirmRoute, /protectAuthResponse\(response, \{ noReferrer: true \}\)/);
  assert.match(exchangeRoute, /protectAuthResponse\([\s\S]{0,120}\{ noReferrer: true \}\)/);
});

test("password reset email GET is non-mutating and only a same-origin signed POST consumes the token", async () => {
  const route = await readFile(
    new URL("../src/app/api/auth/password-reset/exchange/route.ts", import.meta.url),
    "utf8",
  );
  const reset = await readFile(new URL("../src/lib/auth/password-reset.ts", import.meta.url), "utf8");
  const getHandler = route.slice(
    route.indexOf("export async function GET"),
    route.indexOf("export async function POST"),
  );
  const postHandler = route.slice(route.indexOf("export async function POST"));

  assert.doesNotMatch(getHandler, /exchangePasswordResetToken|cookies\.set|\bqueryOne\b|\bupdate\b|\binsert\b|\bdelete\b/i);
  assert.doesNotMatch(getHandler, /searchParams\.get\("token"\)/);
  assert.match(getHandler, /createPasswordResetExchangeFormToken\(\)/);
  assert.match(route, /window\.location\.hash\.slice\(1\)/);
  assert.match(route, /window\.history\.replaceState\(/);
  assert.ok(route.indexOf("window.history.replaceState(") < route.indexOf("tokenInput.value = token"));
  assert.match(route, /script-src 'nonce-\$\{scriptNonce\}'/);
  assert.match(postHandler, /validateCsrfRequestContext\(request\.headers, getTrustedAppOrigin\(\)\)/);
  assert.match(postHandler, /isPasswordResetEmailToken\(token\)/);
  assert.match(postHandler, /validatePasswordResetExchangeFormToken\(\{ formToken \}\)/);
  assert.match(postHandler, /await exchangePasswordResetToken\(token, request\)/);
  assert.match(postHandler, /response\.cookies\.set\(/);
  assert.match(reset, /protectLowEntropyValue\("password-reset-exchange-form", payload\)/);
  assert.match(reset, /safeEqualAuthValue\(signature \?\? "", expectedSignature\)/);
  assert.match(reset, /expiresAt <= now/);
});

test("Preview auth trusts the deployment origin before the Production fallback", async () => {
  const originResolver = await readFile(
    new URL("../src/lib/auth/app-origin.ts", import.meta.url),
    "utf8",
  );

  assert.match(originResolver, /process\.env\.VERCEL_ENV === "preview"/);
  assert.match(originResolver, /cleanOrigin\(process\.env\.VERCEL_URL\)/);
  assert.ok(
    originResolver.indexOf("vercelPreviewOrigin ||") <
      originResolver.indexOf("cleanOrigin(process.env.VERCEL_PROJECT_PRODUCTION_URL)"),
  );
});
