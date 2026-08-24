#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  createA11yBrowserContextOptions,
  installA11yReadOnlyRequestGuard,
} from "./lib/a11y-browser-context.mjs";
import {
  attestMfaVerificationChallenge,
  attestPreviewRuntimeIdentity,
  attestQaBrowserSession,
  currentTotp,
  parseStrictCliArgs,
  requirePreviewRuntimeIdentityExpectation,
  requireQaBrowserCredentials,
} from "./lib/preview-runtime-identity.mjs";

const publicRoutes = [
  "/",
  "/login",
  "/login/forgot-password",
  "/login/reset-password",
  "/imprint",
  "/privacy",
  "/cookies",
  "/terms",
  "/data-deletion",
  "/datadeletion",
  "/meta",
];
const requiredPublicScopeIds = [
  "home",
  "login",
  "forgot-password",
  "reset-password-invalid-result",
  "imprint",
  "privacy",
  "cookies",
  "terms",
  "data-deletion",
  "data-deletion-alias",
  "meta",
];
const authenticatedSurfaces = [
  { hash: "dashboard", id: "dashboard" },
  { hash: "contacts", id: "contacts" },
  { hash: "pipelines", id: "pipelines" },
  { hash: "tasks", id: "tasks" },
  { hash: "meetings", id: "meetings" },
  { hash: "forms", id: "forms" },
  { hash: "funnels", id: "funnels" },
  { hash: "settings", id: "settings" },
  { hash: "customer-access", id: "invitation", requiredSelector: 'input[type="email"]' },
];
const authenticatedSurfaceById = new Map(authenticatedSurfaces.map((surface) => [surface.id, surface]));
const authenticatedRoutes = authenticatedSurfaces.map((surface) => surface.id);
const languages = ["de", "en"];
const requiredAutomatedCheckIds = [
  "axe-wcag-22-aa",
  "language-document-structure",
  "keyboard-entry-focus",
  "zoom-reflow-overflow",
  "browser-runtime-errors",
  "required-fixture-flow-coverage",
];
const requiredManualCheckIds = [
  "screenreader-navigation-and-announcements",
  "dialog-focus-trap-and-return",
  "form-errors-and-instructions",
  "complete-keyboard-operation",
  "zoom-reflow-and-text-spacing",
  "mobile-orientation-and-targets",
  "mfa-reset-and-invitation-flow",
  "public-form-and-funnel-submit-flow",
];
const requiredApprovalRoles = ["Accessibility owner", "Product owner", "Release owner"];
const requiredFixtureRequirementIds = [
  "isolated-auth-fixture",
  "public-action-time-fixtures",
  "release-surface-manifest-contract",
];
const publicProfiles = [
  { height: 900, name: "desktop", routes: publicRoutes, width: 1440 },
  { height: 844, isMobile: true, name: "mobile", routes: publicRoutes, width: 390 },
  { height: 800, name: "zoom-200-reflow", routes: ["/", "/login", "/login/reset-password", "/privacy", "/datadeletion"], width: 640 },
  { height: 800, name: "zoom-400-reflow", routes: ["/", "/login", "/login/reset-password", "/privacy", "/datadeletion"], width: 320 },
];
const authenticatedProfiles = [
  { height: 900, name: "desktop", routes: authenticatedRoutes, width: 1440 },
  { height: 844, isMobile: true, name: "mobile", routes: authenticatedRoutes, width: 390 },
  { height: 800, name: "zoom-200-reflow", routes: ["dashboard", "contacts", "tasks", "forms", "funnels", "settings", "invitation"], width: 640 },
  { height: 800, name: "zoom-400-reflow", routes: ["dashboard", "contacts", "forms", "settings"], width: 320 },
];
const publicFixtureScenarios = [
  { fixture: "publicForm", id: "public-form-page" },
  { fixture: "publicFunnel", id: "public-funnel-page" },
  { fixture: "passwordResetResult", id: "password-reset-result" },
];
const requiredPublicFixtureFlowIds = [
  "public-form-page",
  "public-form-submit-result",
  "public-funnel-page",
  "public-funnel-submit-result",
  "password-reset-result",
];
const publicFixtureProfiles = [
  { height: 900, name: "desktop", routes: publicFixtureScenarios.map((scenario) => scenario.id), width: 1440 },
  { height: 844, isMobile: true, name: "mobile", routes: publicFixtureScenarios.map((scenario) => scenario.id), width: 390 },
  { height: 800, name: "zoom-400-reflow", routes: publicFixtureScenarios.map((scenario) => scenario.id), width: 320 },
];
const mfaProfiles = [
  { height: 900, name: "desktop", routes: ["mfa-verification"], width: 1440 },
  { height: 844, isMobile: true, name: "mobile", routes: ["mfa-verification"], width: 390 },
  { height: 800, name: "zoom-400-reflow", routes: ["mfa-verification"], width: 320 },
];
const actionInputKeys = new Set(["passwordResetResultUrl", "publicFormUrl", "publicFunnelUrl", "shareUrl"]);
const wcagTags = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

function parseArgs(argv) {
  return parseStrictCliArgs(argv, {
    booleanNames: ["fixture-input-stdin", "public-only", "read-only", "share-url-stdin"],
    valueNames: [
      "acceptance-matrix",
      "base-url",
      "browser-executable",
      "expected-database-branch-id",
      "expected-deployment-id",
      "expected-git-branch",
      "expected-host",
      "expected-sha",
      "output-dir",
      "release-surface-manifest",
    ],
  });
}

async function readBoundedStdin(maximumBytes) {
  let value = "";
  for await (const chunk of process.stdin) {
    value += chunk;
    if (Buffer.byteLength(value, "utf8") > maximumBytes) {
      throw new Error("Action-time fixture input is too large.");
    }
  }
  return value.trim();
}

async function readActionInputsFromStdin() {
  const raw = await readBoundedStdin(16_384);
  let parsed;
  try {
    parsed = JSON.parse(raw || "{}");
  } catch {
    throw new Error("Action-time fixture input must be valid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Action-time fixture input must be a JSON object.");
  }
  for (const [key, value] of Object.entries(parsed)) {
    if (!actionInputKeys.has(key) || typeof value !== "string" || value.length > 4_096) {
      throw new Error("Action-time fixture input contains an unsupported key or value.");
    }
  }
  return parsed;
}

function validateShareUrl(value, base) {
  if (!value) return null;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Share URL is invalid.");
  }
  requireSafeFixtureCondition(parsed.origin === base.origin, "Share URL must target the exact Preview origin.");
  requireSafeFixtureCondition(parsed.pathname === "/", "Share URL must target the Preview root.");
  requireSafeFixtureCondition(!parsed.username && !parsed.password, "Share URL must not contain credentials.");
  requireSafeFixtureCondition(!parsed.hash, "Share URL must not contain a fragment.");
  requireSafeFixtureCondition(
    [...parsed.searchParams.keys()].length === 1 && parsed.searchParams.has("_vercel_share"),
    "Only the Vercel share parameter is allowed.",
  );
  requireSafeFixtureCondition(
    /^[a-zA-Z0-9_-]{20,512}$/u.test(parsed.searchParams.get("_vercel_share") ?? ""),
    "Share token is invalid.",
  );
  return parsed;
}

function requireSafeFixtureCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function validateActionTimeUrl(value, base, fixture) {
  if (!value) return null;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Action-time QA fixture URL is invalid.");
  }
  requireSafeFixtureCondition(parsed.origin === base.origin, "Action-time QA fixture must target the exact Preview origin.");
  requireSafeFixtureCondition(!parsed.username && !parsed.password, "Action-time QA fixture must not contain URL credentials.");
  requireSafeFixtureCondition(!parsed.hash, "Action-time QA fixture must not contain a fragment.");
  const queryKeys = [...parsed.searchParams.keys()];
  requireSafeFixtureCondition(new Set(queryKeys).size === queryKeys.length, "Action-time QA fixture query parameters must be unique.");

  if (fixture === "publicForm") {
    requireSafeFixtureCondition(
      /^\/forms\/[a-zA-Z0-9_-]{1,128}\/[a-zA-Z0-9_-]{1,128}$/u.test(parsed.pathname),
      "Public-form fixture must use the canonical Preview form route.",
    );
    requireSafeFixtureCondition(
      queryKeys.every((key) => key === "lang" || key === "utm_source"),
      "Public-form fixture contains an unsupported query parameter.",
    );
  } else if (fixture === "publicFunnel") {
    requireSafeFixtureCondition(
      /^\/preview\/[a-zA-Z0-9_-]{1,128}$/u.test(parsed.pathname),
      "Public-funnel fixture must use the canonical Preview funnel route.",
    );
    requireSafeFixtureCondition(
      queryKeys.every((key) => ["device", "lang", "mode", "token"].includes(key)),
      "Public-funnel fixture contains an unsupported query parameter.",
    );
    requireSafeFixtureCondition(parsed.searchParams.get("mode") === "live", "Public-funnel fixture must use live mode.");
    requireSafeFixtureCondition(
      /^[a-zA-Z0-9_-]{20,512}$/u.test(parsed.searchParams.get("token") ?? ""),
      "Public-funnel fixture must include a bounded publish token.",
    );
    const device = parsed.searchParams.get("device");
    requireSafeFixtureCondition(
      !device || ["desktop", "mobile", "tablet"].includes(device),
      "Public-funnel fixture contains an unsupported device.",
    );
  } else if (fixture === "passwordResetResult") {
    const successResult = parsed.pathname === "/login" && parsed.searchParams.get("reset") === "password_reset";
    const failureResult = parsed.pathname === "/login/reset-password" && [
      "invalid_token",
      "password_mismatch",
      "password_required",
      "password_too_short",
      "reset_unavailable",
    ].includes(parsed.searchParams.get("error") ?? "invalid_token");
    const resultKeys = queryKeys;
    const resultShapeAllowed = successResult
      ? resultKeys.every((key) => key === "lang" || key === "reset") && !parsed.searchParams.has("error")
      : failureResult
        ? resultKeys.every((key) => key === "error" || key === "lang") && !parsed.searchParams.has("reset")
        : false;
    requireSafeFixtureCondition(resultShapeAllowed, "Password-reset result fixture must use an approved result route.");
  } else {
    throw new Error("Unknown action-time QA fixture type.");
  }
  return parsed;
}

function withFixtureLanguage(input, language, profile, fixture) {
  const url = new URL(input.href);
  url.searchParams.set("lang", language);
  if (fixture === "publicFunnel") {
    url.searchParams.set("device", profile.isMobile || profile.width <= 390 ? "mobile" : "desktop");
  }
  return url;
}

function validateReleaseSurfaceManifest(manifest) {
  const pages = new Set(Array.isArray(manifest.pages) ? manifest.pages : []);
  const navigationEntries = new Set(Array.isArray(manifest.navigationEntries) ? manifest.navigationEntries : []);
  const publicRuntimeIds = new Set(
    Array.isArray(manifest.publicFormsAndFunnels)
      ? manifest.publicFormsAndFunnels.map((entry) => entry?.id).filter(Boolean)
      : [],
  );
  for (const page of ["/forms/[slug]/[formSlug]", "/login", "/login/reset-password", "/preview/[funnelId]"]) {
    requireSafeFixtureCondition(pages.has(page), "Release-surface manifest is missing a required accessibility page.");
  }
  for (const entry of ["customerAccess", "forms", "funnels", "settings"]) {
    requireSafeFixtureCondition(navigationEntries.has(entry), "Release-surface manifest is missing a required authenticated surface.");
  }
  for (const id of ["public-form-pages", "public-form-submission", "public-funnel-page-publication", "public-funnel-submission"]) {
    requireSafeFixtureCondition(publicRuntimeIds.has(id), "Release-surface manifest is missing a required public fixture flow.");
  }
  return true;
}

function requirePreviewTarget(baseUrl, expectedHost) {
  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error("Base URL is invalid.");
  }
  requireSafeFixtureCondition(!parsed.username && !parsed.password, "Base URL must not contain credentials.");
  requireSafeFixtureCondition(!parsed.search, "Base URL must not contain query parameters or share tokens.");
  requireSafeFixtureCondition(!parsed.hash, "Base URL must not contain a fragment.");
  requireSafeFixtureCondition(parsed.hostname === expectedHost, "Base URL host must exactly match --expected-host.");
  const local = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost";
  requireSafeFixtureCondition(parsed.protocol === "https:" || (local && parsed.protocol === "http:"), "Target must use HTTPS (or local HTTP).");
  if (!local) {
    requireSafeFixtureCondition(parsed.hostname.endsWith(".vercel.app"), "Browser matrix is restricted to an exact Vercel Preview host.");
    requireSafeFixtureCondition(parsed.hostname !== "novalure-crm.vercel.app", "Production alias is forbidden.");
    requireSafeFixtureCondition(parsed.hostname !== "novalure-crm-novalure.vercel.app", "Production project alias is forbidden.");
  }
  return parsed;
}

async function loadPlaywright() {
  try {
    return await import("playwright");
  } catch (error) {
    const modulePath = process.env.NOVALURE_PLAYWRIGHT_MODULE_PATH?.trim();
    if (!modulePath) {
      throw new Error("Playwright is unavailable. Set NOVALURE_PLAYWRIGHT_MODULE_PATH to an approved bundled runtime.", { cause: error });
    }
    return import(pathToFileURL(path.resolve(modulePath)).href);
  }
}

function safePublicRouteUrl(base, route, language) {
  const url = new URL(route, base);
  url.searchParams.set("lang", language);
  return url;
}

function safeAuthenticatedRouteUrl(base, route, language) {
  const surface = authenticatedSurfaceById.get(route);
  assert.ok(surface, "Authenticated route is not in the fixed release matrix.");
  const url = new URL("/", base);
  url.searchParams.set("lang", language);
  url.hash = surface.hash;
  return url;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function expectedResultCount(profiles) {
  return profiles.reduce((total, profile) => total + profile.routes.length * languages.length, 0);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function evaluateAcceptanceMatrix(matrix) {
  const automatedChecks = Array.isArray(matrix.automatedChecks) ? matrix.automatedChecks : [];
  const manualChecks = Array.isArray(matrix.manualChecks) ? matrix.manualChecks : [];
  const approvals = Array.isArray(matrix.approvals) ? matrix.approvals : [];
  const fixtureRequirements = Array.isArray(matrix.fixtureRequirements) ? matrix.fixtureRequirements : [];
  const publicScope = Array.isArray(matrix.scope?.public) ? matrix.scope.public : [];
  const authenticatedScope = Array.isArray(matrix.scope?.authenticated) ? matrix.scope.authenticated : [];
  const authChallengeScope = Array.isArray(matrix.scope?.authChallenges) ? matrix.scope.authChallenges : [];
  const publicFixtureScope = Array.isArray(matrix.scope?.publicFixtureFlows) ? matrix.scope.publicFixtureFlows : [];
  const languageScope = Array.isArray(matrix.scope?.languages) ? matrix.scope.languages : [];
  const acceptanceContractComplete =
    matrix.standard === "WCAG 2.2 Level AA" &&
    requiredPublicScopeIds.every((route) => publicScope.includes(route)) &&
    authenticatedRoutes.every((route) => authenticatedScope.includes(route)) &&
    authChallengeScope.includes("mfa-verification") &&
    requiredPublicFixtureFlowIds.every((id) => publicFixtureScope.includes(id)) &&
    languages.every((language) => languageScope.includes(language)) &&
    requiredAutomatedCheckIds.every((id) => automatedChecks.some((check) => check.id === id && check.required === true)) &&
    requiredManualCheckIds.every((id) => manualChecks.some((check) => check.id === id && check.required === true)) &&
    requiredFixtureRequirementIds.every((id) => fixtureRequirements.some((requirement) => requirement.id === id && requirement.required === true)) &&
    requiredApprovalRoles.every((role) => approvals.some((approval) => approval.role === role)) &&
    matrix.releaseRule?.automatedTechnicalPassRequired === true &&
    matrix.releaseRule?.authenticatedCoverageRequired === true &&
    matrix.releaseRule?.authChallengeCoverageRequired === true &&
    matrix.releaseRule?.dynamicFixtureCoverageRequired === true &&
    matrix.releaseRule?.blockedRowsFailRelease === true &&
    matrix.releaseRule?.manualChecksMustAllPass === true &&
    matrix.releaseRule?.publicSubmitStatesRequireSignedManualEvidence === true &&
    matrix.releaseRule?.signedApprovalsRequired === true &&
    matrix.releaseRule?.publicOnlyDiagnosticCanRelease === false;
  return {
    acceptanceContractComplete,
    manualAcceptancePassed:
      acceptanceContractComplete &&
      manualChecks.every((check) => check.required === true && check.status === "PASS"),
    manualCheckCount: manualChecks.length,
    manualPassCount: manualChecks.filter((check) => check.status === "PASS").length,
    matrixSigned: matrix.status === "SIGNED",
    signatureCount: approvals.length,
    signaturesComplete:
      acceptanceContractComplete &&
      approvals.every((approval) =>
        approval.status === "SIGNED" &&
        nonEmptyString(approval.owner) &&
        nonEmptyString(approval.signature) &&
        nonEmptyString(approval.signedAt)),
    status: typeof matrix.status === "string" ? matrix.status : "INVALID",
  };
}

async function primePreviewAccess(context, shareUrl, base) {
  if (!shareUrl) return;
  const page = await context.newPage();
  try {
    await page.goto(shareUrl.href, { waitUntil: "domcontentloaded", timeout: 30_000 });
    assert.equal(new URL(page.url()).origin, base.origin, "Share access did not return to the exact Preview origin.");
  } finally {
    await page.close();
  }
}

async function beginQaFixtureLogin(context, base, credentials, language) {
  const page = await context.newPage();
  try {
    const loginUrl = safePublicRouteUrl(base, "/login", language);
    const loginResponse = await page.goto(loginUrl.href, { waitUntil: "domcontentloaded", timeout: 30_000 });
    if (new URL(page.url()).origin !== base.origin) {
      return { blocker: "deployment_protection", challenge: false, ok: false, status: loginResponse?.status() ?? 0 };
    }
    if (new URL(page.url()).pathname !== "/login") {
      return { blocker: "qa_authentication_failed", challenge: false, ok: false, status: loginResponse?.status() ?? 0 };
    }
    const emailInput = page.locator("#login-email");
    const passwordInput = page.locator("#login-password");
    if (await emailInput.count() !== 1 || await passwordInput.count() !== 1) {
      return { blocker: "qa_authentication_failed", challenge: false, ok: false, status: loginResponse?.status() ?? 0 };
    }
    await emailInput.fill(credentials.email);
    await passwordInput.fill(credentials.password);
    await Promise.all([
      page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 30_000 }),
      page.locator('form[action="/api/auth/login"] button[type="submit"]').click(),
    ]);
    const finalUrl = new URL(page.url());
    if (finalUrl.origin !== base.origin) {
      return { blocker: "deployment_protection", challenge: false, ok: false, status: 0 };
    }
    if (finalUrl.pathname === "/login") {
      try {
        attestMfaVerificationChallenge({
          hasCodeInput: await page.locator("#login-mfa-code").count() === 1,
          hasEnrollmentControl: await page.locator('input[name="recoveryCodesSaved"]').count() > 0,
          hasWorkspaceSelectionControl: await page.locator('button[name="workspaceUserId"]').count() > 0,
          step: finalUrl.searchParams.get("step"),
        });
      } catch {
        return { blocker: "qa_mfa_verification_challenge_required", challenge: false, ok: false, status: 0 };
      }
      return {
        blocker: null,
        challenge: true,
        challengeKind: "mfa_verification",
        ok: false,
        status: loginResponse?.status() ?? 0,
      };
    }
    return { blocker: null, challenge: false, ok: true, status: loginResponse?.status() ?? 0 };
  } catch {
    return { blocker: "qa_authentication_failed", challenge: false, ok: false, status: 0 };
  } finally {
    await page.close();
  }
}

async function completeQaMfaChallenge(context, base, credentials, language, challengeKind) {
  if (!credentials.totpSecret) {
    return { blocker: "qa_mfa_totp_unavailable", ok: false, status: 0 };
  }
  const page = await context.newPage();
  try {
    const challengeUrl = safePublicRouteUrl(base, "/login", language);
    challengeUrl.searchParams.set("step", challengeKind);
    const response = await page.goto(challengeUrl.href, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    if (new URL(page.url()).origin !== base.origin) {
      return { blocker: "deployment_protection", ok: false, status: response?.status() ?? 0 };
    }
    const codeInput = page.locator("#login-mfa-code");
    try {
      attestMfaVerificationChallenge({
        hasCodeInput: await codeInput.count() === 1,
        hasEnrollmentControl: await page.locator('input[name="recoveryCodesSaved"]').count() > 0,
        hasWorkspaceSelectionControl: await page.locator('button[name="workspaceUserId"]').count() > 0,
        step: challengeKind,
      });
    } catch {
      return { blocker: "qa_mfa_challenge_unavailable", ok: false, status: response?.status() ?? 0 };
    }
    await codeInput.fill(currentTotp(credentials.totpSecret));
    await Promise.all([
      page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 30_000 }),
      page.locator('form[action="/api/auth/login"] button[type="submit"]').first().click(),
    ]);
    if (new URL(page.url()).origin !== base.origin || new URL(page.url()).pathname === "/login") {
      return { blocker: "qa_mfa_verification_failed", ok: false, status: 0 };
    }
    return { blocker: null, ok: true, status: 200 };
  } catch {
    return { blocker: "qa_mfa_verification_failed", ok: false, status: 0 };
  } finally {
    await page.close();
  }
}

async function verifyQaFixtureSession(context, base, credentials) {
  try {
    const sessionResponse = await context.request.get(new URL("/api/auth/session", base).href, { timeout: 30_000 });
    if (!sessionResponse.ok()) {
      return { blocker: "qa_authentication_failed", ok: false, status: sessionResponse.status() };
    }
    const session = await sessionResponse.json().catch(() => null);
    let sessionAttestation;
    try {
      sessionAttestation = attestQaBrowserSession(session, credentials);
    } catch {
      return { blocker: "qa_authentication_failed", ok: false, status: sessionResponse.status() };
    }
    return { blocker: null, ok: true, sessionAttestation, status: sessionResponse.status() };
  } catch {
    return { blocker: "qa_authentication_failed", ok: false, status: 0 };
  }
}

async function attestQaRuntimeIdentity(context, base, expectedRuntimeIdentity) {
  const response = await context.request.get(new URL("/api/admin/qa-batch-capability", base).href, {
    timeout: 30_000,
  });
  const payload = await response.json().catch(() => null);
  return attestPreviewRuntimeIdentity({ expected: expectedRuntimeIdentity, payload, status: response.status() });
}

async function authenticateQaFixture(context, base, credentials, expectedRuntimeIdentity, language = "de") {
  const login = await beginQaFixtureLogin(context, base, credentials, language);
  if (login.challenge) {
    const mfa = await completeQaMfaChallenge(context, base, credentials, language, login.challengeKind);
    if (!mfa.ok) return mfa;
  } else if (!login.ok) {
    return login;
  }
  const verification = await verifyQaFixtureSession(context, base, credentials);
  if (!verification.ok) return verification;
  try {
    return {
      ...verification,
      runtimeIdentity: await attestQaRuntimeIdentity(context, base, expectedRuntimeIdentity),
    };
  } catch {
    return { blocker: "runtime_identity_mismatch", ok: false, status: 0 };
  }
}

function createBlockedResult({ blocker, language, profile, route, status, surface }) {
  return {
    audit: null,
    blocker,
    browserErrorCount: 0,
    consoleErrorCount: 0,
    durationMs: 0,
    keyboardFocus: null,
    language,
    outcome: "BLOCKED",
    passed: false,
    profile: profile.name,
    route,
    status,
    surface,
  };
}

async function logoutQaSession(context, base) {
  const sessionBefore = await context.request.get(new URL("/api/auth/session", base).href, { timeout: 30_000 });
  if (sessionBefore.status() === 401) return "NO_SESSION";
  assert.equal(sessionBefore.status(), 200, "QA session state could not be checked before logout.");
  const csrfUrl = new URL("/api/auth/csrf", base);
  csrfUrl.searchParams.set("method", "POST");
  csrfUrl.searchParams.set("path", "/api/auth/logout");
  const sameOriginHeaders = { origin: base.origin, referer: base.href, "sec-fetch-site": "same-origin" };
  const csrfResponse = await context.request.get(csrfUrl.href, { headers: sameOriginHeaders, timeout: 30_000 });
  assert.equal(csrfResponse.status(), 200, "QA logout CSRF preflight failed.");
  const csrf = await csrfResponse.json().catch(() => null);
  assert.ok(typeof csrf?.csrfToken === "string", "QA logout CSRF token is unavailable.");
  const logoutUrl = new URL("/api/auth/logout", base);
  logoutUrl.searchParams.set("lang", "en");
  const logoutResponse = await context.request.post(logoutUrl.href, {
    headers: { ...sameOriginHeaders, "x-novalure-csrf-token": csrf.csrfToken },
    maxRedirects: 0,
    timeout: 30_000,
  });
  assert.ok([200, 303].includes(logoutResponse.status()), "QA logout failed.");
  const sessionAfter = await context.request.get(new URL("/api/auth/session", base).href, { timeout: 30_000 });
  assert.equal(sessionAfter.status(), 401, "QA session remained active after logout.");
  return "LOGGED_OUT";
}

async function confirmAuthenticatedSurface(page, expectedHash) {
  await page.locator("[data-crm-shell]").waitFor({ state: "visible", timeout: 15_000 });
  await page.waitForTimeout(300);
  const activeNavigation = page.locator('[data-crm-nav-item][aria-current="page"]').first();
  await activeNavigation.waitFor({ state: "attached", timeout: 15_000 });
  await activeNavigation.evaluate((element) => element.click());
  await page.waitForTimeout(100);
  const finalHash = decodeURIComponent(new URL(page.url()).hash.replace(/^#/, "")).toLowerCase();
  return finalHash === expectedHash;
}

async function auditPage({ axeSource, context, expectedHash, language, profile, requiredSelector, route, surface, url }) {
  const page = await context.newPage();
  let browserErrorCount = 0;
  let consoleErrorCount = 0;
  page.on("pageerror", () => { browserErrorCount += 1; });
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrorCount += 1;
  });

  try {
    const startedAt = performance.now();
    const response = await page.goto(url.href, { waitUntil: "domcontentloaded", timeout: 30_000 });
    const durationMs = Math.round(performance.now() - startedAt);
    const finalUrl = new URL(page.url());
    if (finalUrl.origin !== url.origin) {
      return {
        ...createBlockedResult({ blocker: "deployment_protection", language, profile, route, status: response?.status() ?? 0, surface }),
        browserErrorCount,
        consoleErrorCount,
        durationMs,
      };
    }
    if (surface === "authenticated") {
      const finalHash = decodeURIComponent(finalUrl.hash.replace(/^#/, "")).toLowerCase();
      if (finalUrl.pathname !== "/" || finalHash !== expectedHash) {
        return {
          ...createBlockedResult({ blocker: "unsafe_authenticated_route", language, profile, route, status: response?.status() ?? 0, surface }),
          browserErrorCount,
          consoleErrorCount,
          durationMs,
        };
      }
      if (!await confirmAuthenticatedSurface(page, expectedHash)) {
        return {
          ...createBlockedResult({ blocker: "authenticated_surface_unavailable", language, profile, route, status: response?.status() ?? 0, surface }),
          browserErrorCount,
          consoleErrorCount,
          durationMs: Math.round(performance.now() - startedAt),
        };
      }
    } else {
      await page.locator("main").first().waitFor({ state: "visible", timeout: 15_000 });
    }
    if (requiredSelector) {
      await page.locator(requiredSelector).first().waitFor({ state: "visible", timeout: 15_000 });
    }
    await page.waitForTimeout(150);
    await page.addScriptTag({ content: axeSource });
    const audit = await page.evaluate(async (tags) => {
      const axeResult = await window.axe.run(document, { runOnly: { type: "tag", values: tags } });
      const focusables = document.querySelectorAll(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ).length;
      return {
        document: {
          authenticatedShell: Boolean(document.querySelector("[data-crm-shell]")),
          hasH1: Boolean(document.querySelector("h1")),
          hasMain: Boolean(document.querySelector("main")),
          htmlLanguage: document.documentElement.lang,
          reducedMotion: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
          titlePresent: Boolean(document.title.trim()),
        },
        focusables,
        incomplete: axeResult.incomplete.map((item) => ({ id: item.id, impact: item.impact, nodes: item.nodes.length })),
        layout: {
          clientWidth: document.documentElement.clientWidth,
          horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
          scrollWidth: document.documentElement.scrollWidth,
        },
        passes: axeResult.passes.length,
        violations: axeResult.violations.map((item) => ({
          id: item.id,
          impact: item.impact,
          nodes: item.nodes.length,
        })),
      };
    }, wcagTags);

    await page.keyboard.press("Tab");
    const keyboardFocus = await page.evaluate(() => {
      const element = document.activeElement;
      if (!(element instanceof HTMLElement) || element === document.body) return { focused: false };
      const style = getComputedStyle(element);
      return {
        boxShadowVisible: style.boxShadow !== "none",
        focused: true,
        outlineVisible: style.outlineStyle !== "none" && style.outlineWidth !== "0px",
        tag: element.tagName.toLowerCase(),
      };
    });
    const seriousOrCritical = audit.violations.filter((item) => item.impact === "serious" || item.impact === "critical");
    const unresolvedSeriousOrCritical = audit.incomplete.filter((item) => item.impact === "serious" || item.impact === "critical");
    const status = response?.status() ?? 0;
    const passed =
      status >= 200 && status < 400 &&
      browserErrorCount === 0 &&
      consoleErrorCount === 0 &&
      seriousOrCritical.length === 0 &&
      unresolvedSeriousOrCritical.length === 0 &&
      audit.document.htmlLanguage === language &&
      audit.document.titlePresent &&
      audit.document.hasMain &&
      (surface !== "authenticated" || audit.document.authenticatedShell) &&
      !audit.layout.horizontalOverflow &&
      keyboardFocus.focused;

    return {
      audit: {
        ...audit,
      },
      blocker: null,
      browserErrorCount,
      consoleErrorCount,
      durationMs,
      keyboardFocus,
      language,
      outcome: passed ? "PASS" : "FAIL",
      passed,
      profile: profile.name,
      route,
      status,
      surface,
    };
  } catch {
    return {
      ...createBlockedResult({ blocker: "page_audit_failed", language, profile, route, status: 0, surface }),
      browserErrorCount,
      consoleErrorCount,
    };
  } finally {
    await page.close();
  }
}

const args = parseArgs(process.argv.slice(2));
const startedAt = new Date().toISOString();
const baseUrl = args.get("base-url") ?? process.env.NOVALURE_QA_BASE_URL ?? "";
const expectedHost = args.get("expected-host") ?? process.env.NOVALURE_QA_EXPECTED_HOST ?? "";
assert.ok(baseUrl, "--base-url is required.");
assert.ok(expectedHost, "--expected-host is required.");
const base = requirePreviewTarget(baseUrl, expectedHost);
const readOnlyMode = args.has("read-only");
assert.ok(readOnlyMode, "--read-only is mandatory; the accessibility runner never writes public or CRM business data.");
assert.ok(!(args.has("fixture-input-stdin") && args.has("share-url-stdin")), "Choose only one stdin input mode.");
const stdinActionInputs = args.has("fixture-input-stdin") ? await readActionInputsFromStdin() : {};
const legacyShareUrlInput = args.has("share-url-stdin") ? await readBoundedStdin(2_048) : "";
const shareUrl = validateShareUrl(legacyShareUrlInput || stdinActionInputs.shareUrl || "", base);
const actionTimeFixtures = {
  passwordResetResult: validateActionTimeUrl(
    stdinActionInputs.passwordResetResultUrl || process.env.NOVALURE_QA_A11Y_PASSWORD_RESET_RESULT_URL?.trim() || "",
    base,
    "passwordResetResult",
  ),
  publicForm: validateActionTimeUrl(
    stdinActionInputs.publicFormUrl || process.env.NOVALURE_QA_A11Y_PUBLIC_FORM_URL?.trim() || "",
    base,
    "publicForm",
  ),
  publicFunnel: validateActionTimeUrl(
    stdinActionInputs.publicFunnelUrl || process.env.NOVALURE_QA_A11Y_PUBLIC_FUNNEL_URL?.trim() || "",
    base,
    "publicFunnel",
  ),
};
const publicOnlyDiagnostic = args.has("public-only");
const outputDirectory = path.resolve(args.get("output-dir") ?? path.join("artifacts", "qa", "a11y-browser-matrix"));
const acceptanceMatrixPath = path.resolve(
  args.get("acceptance-matrix") ?? path.join("docs", "audit", "2026-08-23", "accessibility-acceptance-matrix.json"),
);
const acceptanceMatrix = JSON.parse(await readFile(acceptanceMatrixPath, "utf8"));
const acceptance = evaluateAcceptanceMatrix(acceptanceMatrix);
const releaseSurfaceManifestPath = path.resolve(
  args.get("release-surface-manifest") ?? path.join("docs", "audit", "2026-08-23", "release-surface-manifest.json"),
);
const releaseSurfaceManifest = JSON.parse(await readFile(releaseSurfaceManifestPath, "utf8"));
const releaseSurfaceManifestVerified = validateReleaseSurfaceManifest(releaseSurfaceManifest);
const expectedRuntimeIdentity = requirePreviewRuntimeIdentityExpectation({
  databaseBranchId: args.get("expected-database-branch-id") ?? process.env.NOVALURE_QA_BRANCH_ID,
  deploymentHost: expectedHost,
  deploymentId: args.get("expected-deployment-id") ?? process.env.NOVALURE_QA_DEPLOYMENT_ID,
  gitBranch: args.get("expected-git-branch") ?? process.env.NOVALURE_QA_EXPECTED_GIT_BRANCH,
  gitSha: args.get("expected-sha") ?? process.env.NOVALURE_QA_EXPECTED_GIT_SHA,
});

const { chromium } = await loadPlaywright();
const browserExecutable = args.get("browser-executable") ?? process.env.NOVALURE_BROWSER_EXECUTABLE;
const browser = await chromium.launch({ executablePath: browserExecutable || undefined, headless: true });
const axeSource = await readFile(path.resolve("node_modules", "axe-core", "axe.min.js"), "utf8");
const results = [];
const runtimeIdentityAttestations = [];
const cleanup = {
  browserClosed: false,
  sessionLogoutAttempts: 0,
  sessionLogoutFailures: 0,
  sessionLogouts: 0,
  sessionsAlreadyAbsent: 0,
};
const blockedUnsafeHttpWrites = [];
let guardedContextCount = 0;

async function guardContext(context, { allowAuthWrites, surface }) {
  await installA11yReadOnlyRequestGuard(context, {
    allowAuthWrites,
    onBlocked: ({ category, method }) => {
      blockedUnsafeHttpWrites.push({ category, method, surface });
    },
    previewOrigin: base.origin,
  });
  guardedContextCount += 1;
}

async function cleanupQaContext(context) {
  cleanup.sessionLogoutAttempts += 1;
  try {
    const status = await logoutQaSession(context, base);
    if (status === "LOGGED_OUT") cleanup.sessionLogouts += 1;
    if (status === "NO_SESSION") cleanup.sessionsAlreadyAbsent += 1;
  } catch {
    cleanup.sessionLogoutFailures += 1;
  }
}

async function runPublicMatrix() {
  for (const profile of publicProfiles) {
    const context = await browser.newContext(createA11yBrowserContextOptions(profile));
    try {
      await guardContext(context, { allowAuthWrites: false, surface: "public" });
      await primePreviewAccess(context, shareUrl, base);
      for (const route of profile.routes) {
        for (const language of languages) {
          results.push(await auditPage({
            axeSource,
            context,
            language,
            profile,
            route,
            surface: "public",
            url: safePublicRouteUrl(base, route, language),
          }));
        }
      }
    } finally {
      await context.close();
    }
  }
}

async function runPublicFixtureMatrix() {
  for (const profile of publicFixtureProfiles) {
    const context = await browser.newContext(createA11yBrowserContextOptions(profile));
    try {
      await guardContext(context, { allowAuthWrites: false, surface: "public-fixture" });
      await primePreviewAccess(context, shareUrl, base);
      for (const scenario of publicFixtureScenarios) {
        for (const language of languages) {
          const fixtureUrl = actionTimeFixtures[scenario.fixture];
          if (!fixtureUrl) {
            results.push(createBlockedResult({
              blocker: "action_time_fixture_unavailable",
              language,
              profile,
              route: scenario.id,
              status: 0,
              surface: "public-fixture",
            }));
            continue;
          }
          const url = withFixtureLanguage(fixtureUrl, language, profile, scenario.fixture);
          const requiredSelector = scenario.fixture === "publicForm"
            ? 'form[data-novalure-runtime="form"]'
            : scenario.fixture === "publicFunnel"
              ? '[data-funnel-mode="live"]'
              : '[aria-live="polite"]';
          results.push(await auditPage({
            axeSource,
            context,
            language,
            profile,
            requiredSelector,
            route: scenario.id,
            surface: "public-fixture",
            url,
          }));
        }
      }
    } finally {
      await context.close();
    }
  }
}

async function runMfaMatrix() {
  let credentials;
  try {
    credentials = requireQaBrowserCredentials(process.env, { requireTotp: true });
  } catch {
    for (const profile of mfaProfiles) {
      for (const language of languages) {
        results.push(createBlockedResult({
          blocker: "qa_fixture_credentials_unavailable",
          language,
          profile,
          route: "mfa-verification",
          status: 0,
          surface: "auth-fixture",
        }));
      }
    }
    return;
  }
  for (const profile of mfaProfiles) {
    for (const language of languages) {
      const context = await browser.newContext(createA11yBrowserContextOptions(profile));
      try {
        await guardContext(context, { allowAuthWrites: true, surface: "auth-fixture" });
        await primePreviewAccess(context, shareUrl, base);
        const login = await beginQaFixtureLogin(context, base, credentials, language);
        if (!login.challenge) {
          results.push(createBlockedResult({
            blocker: login.ok ? "qa_mfa_challenge_unavailable" : login.blocker,
            language,
            profile,
            route: "mfa-verification",
            status: login.status,
            surface: "auth-fixture",
          }));
          continue;
        }
        const auditResult = await auditPage({
          axeSource,
          context,
          language,
          profile,
          requiredSelector: "#login-mfa-code",
          route: "mfa-verification",
          surface: "auth-fixture",
          url: safePublicRouteUrl(base, "/login", language),
        });
        if (!auditResult.passed) {
          results.push(auditResult);
          continue;
        }
        const completion = await completeQaMfaChallenge(
          context,
          base,
          credentials,
          language,
          login.challengeKind,
        );
        const verification = completion.ok
          ? await verifyQaFixtureSession(context, base, credentials)
          : completion;
        if (!verification.ok) {
          results.push({
            ...auditResult,
            blocker: verification.blocker,
            outcome: "BLOCKED",
            passed: false,
            status: verification.status,
          });
          continue;
        }
        try {
          runtimeIdentityAttestations.push(await attestQaRuntimeIdentity(context, base, expectedRuntimeIdentity));
        } catch {
          results.push({
            ...auditResult,
            blocker: "runtime_identity_mismatch",
            outcome: "BLOCKED",
            passed: false,
            status: 0,
          });
          continue;
        }
        results.push(auditResult);
      } finally {
        await cleanupQaContext(context);
        await context.close();
      }
    }
  }
}

async function runAuthenticatedMatrix() {
  let credentials;
  try {
    credentials = requireQaBrowserCredentials(process.env);
  } catch {
    for (const profile of authenticatedProfiles) {
      for (const route of profile.routes) {
        for (const language of languages) {
          results.push(createBlockedResult({
            blocker: "qa_fixture_credentials_unavailable",
            language,
            profile,
            route,
            status: 0,
            surface: "authenticated",
          }));
        }
      }
    }
    return;
  }
  for (const profile of authenticatedProfiles) {
    const context = await browser.newContext(createA11yBrowserContextOptions(profile));
    try {
      await guardContext(context, { allowAuthWrites: true, surface: "authenticated" });
      await primePreviewAccess(context, shareUrl, base);
      const authentication = await authenticateQaFixture(context, base, credentials, expectedRuntimeIdentity);
      if (!authentication.ok) {
        for (const route of profile.routes) {
          for (const language of languages) {
            results.push(createBlockedResult({
              blocker: authentication.blocker,
              language,
              profile,
              route,
              status: authentication.status,
              surface: "authenticated",
            }));
          }
        }
        continue;
      }
      runtimeIdentityAttestations.push(authentication.runtimeIdentity);
      for (const route of profile.routes) {
        const surfaceDefinition = authenticatedSurfaceById.get(route);
        assert.ok(surfaceDefinition, "Authenticated route is not in the fixed release matrix.");
        for (const language of languages) {
          results.push(await auditPage({
            axeSource,
            context,
            expectedHash: surfaceDefinition.hash,
            language,
            profile,
            requiredSelector: surfaceDefinition.requiredSelector,
            route,
            surface: "authenticated",
            url: safeAuthenticatedRouteUrl(base, route, language),
          }));
        }
      }
    } finally {
      await cleanupQaContext(context);
      await context.close();
    }
  }
}

let executionBlocker = null;
try {
  await runPublicMatrix();
  await runPublicFixtureMatrix();
  if (!publicOnlyDiagnostic) {
    await runMfaMatrix();
    await runAuthenticatedMatrix();
  }
} catch {
  executionBlocker = "browser_matrix_execution_failed";
} finally {
  try {
    await browser.close();
    cleanup.browserClosed = true;
  } catch {
    executionBlocker ??= "browser_cleanup_failed";
  }
}
if (blockedUnsafeHttpWrites.length > 0) executionBlocker ??= "unsafe_http_write_attempted";

const publicResults = results.filter((item) => item.surface === "public");
const publicFixtureResults = results.filter((item) => item.surface === "public-fixture");
const authenticatedResults = results.filter((item) => item.surface === "authenticated");
const authFixtureResults = results.filter((item) => item.surface === "auth-fixture");
const publicExpected = expectedResultCount(publicProfiles);
const publicFixtureExpected = expectedResultCount(publicFixtureProfiles);
const authenticatedExpected = expectedResultCount(authenticatedProfiles);
const authFixtureExpected = expectedResultCount(mfaProfiles);
const publicCoverageComplete = publicResults.length === publicExpected;
const publicFixtureCoverageComplete = publicFixtureResults.length === publicFixtureExpected;
const authenticatedCoverageComplete = !publicOnlyDiagnostic && authenticatedResults.length === authenticatedExpected;
const authFixtureCoverageComplete = !publicOnlyDiagnostic && authFixtureResults.length === authFixtureExpected;
const runtimeIdentityAttestationExpected = publicOnlyDiagnostic ? 0 : mfaProfiles.length * languages.length + authenticatedProfiles.length;
const runtimeIdentityAttestationComplete =
  !publicOnlyDiagnostic &&
  runtimeIdentityAttestations.length === runtimeIdentityAttestationExpected;
const cleanupComplete = cleanup.browserClosed && cleanup.sessionLogoutFailures === 0;
const expectedGuardedContextCount =
  publicProfiles.length +
  publicFixtureProfiles.length +
  (publicOnlyDiagnostic ? 0 : mfaProfiles.length * languages.length + authenticatedProfiles.length);
const unsafeHttpWriteGuardComplete =
  blockedUnsafeHttpWrites.length === 0 &&
  guardedContextCount === expectedGuardedContextCount;
const automatedSubsetPassed = results.length > 0 && results.every((item) => item.passed);
const automatedTechnicalPassed =
  !publicOnlyDiagnostic &&
  executionBlocker === null &&
  cleanupComplete &&
  unsafeHttpWriteGuardComplete &&
  runtimeIdentityAttestationComplete &&
  releaseSurfaceManifestVerified &&
  publicCoverageComplete &&
  publicFixtureCoverageComplete &&
  authenticatedCoverageComplete &&
  authFixtureCoverageComplete &&
  automatedSubsetPassed;
const releasePassed =
  automatedTechnicalPassed &&
  acceptance.acceptanceContractComplete &&
  acceptance.matrixSigned &&
  acceptance.manualAcceptancePassed &&
  acceptance.signaturesComplete;
const endedAt = new Date().toISOString();
const evidence = {
  acceptance: {
    contractComplete: acceptance.acceptanceContractComplete,
    manualAcceptancePassed: acceptance.manualAcceptancePassed,
    manualCheckCount: acceptance.manualCheckCount,
    manualPassCount: acceptance.manualPassCount,
    matrixSigned: acceptance.matrixSigned,
    signatureCount: acceptance.signatureCount,
    signaturesComplete: acceptance.signaturesComplete,
    status: acceptance.status,
  },
  automatedSubsetPassed,
  automatedTechnicalPassed,
  browser: "chromium",
  cleanup: {
    ...cleanup,
    complete: cleanupComplete,
  },
  coverage: {
    authenticated: {
      complete: authenticatedCoverageComplete,
      expected: authenticatedExpected,
      observed: authenticatedResults.length,
    },
    authenticatedFixture: {
      complete: authFixtureCoverageComplete,
      expected: authFixtureExpected,
      observed: authFixtureResults.length,
    },
    public: {
      complete: publicCoverageComplete,
      expected: publicExpected,
      observed: publicResults.length,
    },
    publicFixture: {
      complete: publicFixtureCoverageComplete,
      expected: publicFixtureExpected,
      observed: publicFixtureResults.length,
    },
  },
  endedAt,
  evidenceDigest: null,
  executionBlocker,
  expectedSha: expectedRuntimeIdentity.gitSha,
  generatedAt: endedAt,
  matrix: {
    blocked: results.filter((item) => item.outcome === "BLOCKED").length,
    blockedOrNotRun: results.filter((item) => item.outcome === "BLOCKED" || item.outcome === "NOT_RUN").length,
    failed: results.filter((item) => !item.passed).length,
    notRun: results.filter((item) => item.outcome === "NOT_RUN").length,
    passed: results.filter((item) => item.passed).length,
    total: results.length,
  },
  mode: publicOnlyDiagnostic ? "PUBLIC_ONLY_DIAGNOSTIC" : "RELEASE_GATE",
  productionMutationPerformed: false,
  executionScope: {
    authSideEffects: publicOnlyDiagnostic
      ? "NOT_APPLICABLE"
      : "LOGIN_CHALLENGE_MFA_VERIFICATION_AUDIT_AND_SESSION_WRITES_EXPECTED",
    mfaEnrollment: "PROHIBITED",
    publicAndCrmBusinessData: readOnlyMode && unsafeHttpWriteGuardComplete
      ? "HTTP_WRITE_GUARD_ENFORCED"
      : "BLOCKED_UNSAFE_HTTP_WRITE_ATTEMPT",
    sessionCleanupRequired: !publicOnlyDiagnostic,
  },
  releaseSurfaceManifestVerified,
  releasePassed,
  results,
  runtimeIdentity: {
    attestationComplete: runtimeIdentityAttestationComplete,
    attestationCount: runtimeIdentityAttestations.length,
    expectedAttestationCount: runtimeIdentityAttestationExpected,
    expected: expectedRuntimeIdentity,
  },
  schemaVersion: 4,
  startedAt,
  targetHost: base.hostname,
  unsafeHttpWriteGuard: {
    allowedAuthWrites: [
      "POST /api/auth/login",
      "POST /api/auth/logout",
      "POST /api/auth/session",
    ],
    blockedAttemptCount: blockedUnsafeHttpWrites.length,
    blockedByMethod: Object.fromEntries(
      [...new Set(blockedUnsafeHttpWrites.map((attempt) => attempt.method))]
        .sort()
        .map((method) => [method, blockedUnsafeHttpWrites.filter((attempt) => attempt.method === method).length]),
    ),
    blockedBySurface: Object.fromEntries(
      [...new Set(blockedUnsafeHttpWrites.map((attempt) => attempt.surface))]
        .sort()
        .map((surface) => [surface, blockedUnsafeHttpWrites.filter((attempt) => attempt.surface === surface).length]),
    ),
    complete: unsafeHttpWriteGuardComplete,
    expectedGuardedContextCount,
    guardedContextCount,
    serviceWorkersBlocked: true,
  },
  wcagStandard: "WCAG 2.2 AA automated subset plus signed manual acceptance",
};
const canonical = `${JSON.stringify(evidence, null, 2)}\n`;
evidence.evidenceDigest = sha256(canonical);
await mkdir(outputDirectory, { recursive: true });
const evidenceFileName = "a11y-browser-matrix.json";
const evidenceSidecarFileName = "a11y-browser-matrix.json.sha256";
const serializedEvidence = `${JSON.stringify(evidence, null, 2)}\n`;
await writeFile(path.join(outputDirectory, evidenceFileName), serializedEvidence, {
  encoding: "utf8",
  flag: "wx",
  mode: 0o600,
});
await writeFile(
  path.join(outputDirectory, evidenceSidecarFileName),
  `${sha256(serializedEvidence)}  ${evidenceFileName}\n`,
  { encoding: "utf8", flag: "wx", mode: 0o600 },
);

console.log(JSON.stringify({
  automatedTechnicalPassed: evidence.automatedTechnicalPassed,
  evidenceDigest: evidence.evidenceDigest,
  failed: evidence.matrix.failed,
  mode: evidence.mode,
  outputDirectory,
  passed: evidence.matrix.passed,
  releasePassed: evidence.releasePassed,
  total: evidence.matrix.total,
}));
if (!releasePassed) process.exitCode = 1;
