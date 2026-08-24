#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { killAll, launch } from "chrome-launcher";
import lighthouse from "lighthouse";
import { connect } from "puppeteer-core";
import {
  attestMfaVerificationChallenge,
  attestPreviewRuntimeIdentity,
  attestQaBrowserSession,
  currentTotp,
  parseStrictCliArgs,
  requirePreviewRuntimeIdentityExpectation,
  requireQaBrowserCredentials,
} from "./lib/preview-runtime-identity.mjs";
import {
  attestLighthouseBaseline,
  createBrowserRuntimeCleanup,
  installTerminationCleanup,
  requirePreviewApplicationLanding,
  requireTrustedShareLanding,
  settleRunWithCleanup,
} from "./lighthouse-preview-runtime.mjs";

const publicRoutes = ["/", "/login", "/privacy"];
const authenticatedRoutes = [
  "/#dashboard",
  "/#contacts",
  "/#pipelines",
  "/#tasks",
  "/#meetings",
];
const languages = ["de", "en"];
const profiles = ["mobile", "desktop"];
const temperatures = ["cold", "warm"];

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

function canonicalJson(value) {
  return `${JSON.stringify(canonicalize(value), null, 2)}\n`;
}

function parseArgs(argv) {
  return parseStrictCliArgs(argv, {
    booleanNames: ["public-only", "share-url-stdin"],
    valueNames: [
      "base-url",
      "baseline-evidence",
      "baseline-expected-deployment-id",
      "baseline-expected-digest",
      "baseline-expected-git-branch",
      "baseline-expected-host",
      "baseline-expected-sha",
      "baseline-sidecar",
      "browser-executable",
      "budget-file",
      "expected-database-branch-id",
      "expected-deployment-id",
      "expected-git-branch",
      "expected-host",
      "expected-sha",
      "output-dir",
    ],
  });
}

function requirePreviewTarget(baseUrl, expectedHost) {
  const parsed = new URL(baseUrl);
  assert.equal(parsed.hostname, expectedHost, "Base URL host must exactly match --expected-host.");
  assert.equal(parsed.username, "", "Base URL must not contain credentials.");
  assert.equal(parsed.password, "", "Base URL must not contain credentials.");
  assert.equal(parsed.search, "", "Base URL must not contain query parameters or share tokens.");
  assert.equal(parsed.hash, "", "Base URL must not contain a fragment.");
  const local = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost";
  assert.ok(parsed.protocol === "https:" || (local && parsed.protocol === "http:"), "Target must use HTTPS (or local HTTP).");
  if (!local) {
    assert.ok(parsed.hostname.endsWith(".vercel.app"), "Lighthouse gate is restricted to an exact Vercel Preview host.");
    assert.notEqual(parsed.hostname, "novalure-crm.vercel.app", "Production alias is forbidden.");
    assert.notEqual(parsed.hostname, "novalure-crm-novalure.vercel.app", "Production project alias is forbidden.");
  }
  return parsed;
}

async function readShareUrlFromStdin() {
  const lines = createInterface({ crlfDelay: Number.POSITIVE_INFINITY, input: process.stdin });
  for await (const line of lines) {
    lines.close();
    if (line.length > 2_048) throw new Error("Share URL input is too large.");
    return line.trim();
  }
  return "";
}

function validateShareUrl(value, base) {
  if (!value) return null;
  const parsed = new URL(value);
  assert.equal(parsed.origin, base.origin, "Share URL must target the exact Preview origin.");
  assert.equal(parsed.pathname, "/", "Share URL must target the Preview root.");
  assert.equal(parsed.username, "", "Share URL must not contain credentials.");
  assert.equal(parsed.password, "", "Share URL must not contain credentials.");
  assert.equal(parsed.hash, "", "Share URL must not contain a fragment.");
  assert.deepEqual([...parsed.searchParams.keys()], ["_vercel_share"], "Only the Vercel share parameter is allowed.");
  assert.match(parsed.searchParams.get("_vercel_share") ?? "", /^[a-zA-Z0-9_-]{20,512}$/u, "Share token is invalid.");
  return parsed;
}

function resolveQaCredentials(env, publicOnly) {
  if (publicOnly) return null;
  return requireQaBrowserCredentials(env, { requireTotp: true });
}

async function bootstrapShareAccess(chromePort, base, shareUrl) {
  if (!shareUrl) return;
  const browser = await connect({ browserURL: `http://127.0.0.1:${chromePort}` });
  try {
    const page = await browser.newPage();
    try {
      let response = await page.goto(shareUrl.href, { waitUntil: "domcontentloaded", timeout: 30_000 });
      const shareLandingOrigin = requireTrustedShareLanding(page.url(), base.origin);
      if (shareLandingOrigin !== base.origin) {
        response = await page.goto(base.href, { waitUntil: "domcontentloaded", timeout: 30_000 });
      }
      await requirePreviewApplicationLanding({ page, previewOrigin: base.origin, response });
    } finally {
      await page.close();
    }
  } finally {
    await browser.disconnect();
  }
}

async function bootstrapQaAuthentication(chromePort, base, credentials, expectedRuntimeIdentity) {
  const browser = await connect({ browserURL: `http://127.0.0.1:${chromePort}` });
  try {
    const page = await browser.newPage();
    try {
      const loginUrl = new URL("/login", base);
      loginUrl.searchParams.set("lang", "en");
      loginUrl.searchParams.set("returnTo", "/#dashboard");
      await page.goto(loginUrl.href, { waitUntil: "domcontentloaded", timeout: 30_000 });
      const loginEntry = new URL(page.url());
      assert.equal(loginEntry.origin, base.origin, "QA login entry left the exact Preview origin.");
      assert.equal(loginEntry.pathname, "/login", "QA login entry did not resolve to the exact login path.");
      await page.waitForSelector("#login-email", { timeout: 15_000 });
      await page.type("#login-email", credentials.email);
      await page.type("#login-password", credentials.password);
      await Promise.all([
        page.waitForNavigation({ timeout: 30_000, waitUntil: "domcontentloaded" }).catch(() => null),
        page.click('form[action="/api/auth/login"] button[type="submit"]'),
      ]);
      let finalUrl = new URL(page.url());
      assert.equal(finalUrl.pathname, "/login", "QA login did not present the required MFA verification challenge.");
      await page.waitForSelector("#login-mfa-code", { timeout: 15_000 });
      attestMfaVerificationChallenge({
        hasCodeInput: Boolean(await page.$("#login-mfa-code")),
        hasEnrollmentControl: Boolean(await page.$('input[name="recoveryCodesSaved"]')),
        hasWorkspaceSelectionControl: Boolean(await page.$('button[name="workspaceUserId"]')),
        step: finalUrl.searchParams.get("step"),
      });
      await page.type("#login-mfa-code", currentTotp(credentials.totpSecret));
      await Promise.all([
        page.waitForNavigation({ timeout: 30_000, waitUntil: "domcontentloaded" }).catch(() => null),
        page.click('form[action="/api/auth/login"] button[type="submit"]'),
      ]);
      finalUrl = new URL(page.url());
      assert.equal(finalUrl.origin, base.origin, "QA authentication left the exact Preview origin.");
      assert.equal(finalUrl.pathname, "/", "QA authentication did not resolve to the exact CRM path.");
      assert.equal(finalUrl.hash, "#dashboard", "QA authentication did not resolve to the exact dashboard hash.");
      await page.waitForSelector("[data-crm-shell]", { timeout: 30_000, visible: true });
      await page.waitForSelector("[data-crm-nav]", { timeout: 30_000, visible: true });

      const sessionResult = await page.evaluate(async () => {
        const response = await fetch("/api/auth/session", { cache: "no-store", credentials: "same-origin" });
        return { payload: await response.json().catch(() => null), status: response.status };
      });
      assert.equal(sessionResult.status, 200, "QA session endpoint did not confirm authentication.");
      const sessionAttestation = attestQaBrowserSession(sessionResult.payload, credentials);
      const runtimeResult = await page.evaluate(async () => {
        const response = await fetch("/api/admin/qa-batch-capability", {
          cache: "no-store",
          credentials: "same-origin",
        });
        return { payload: await response.json().catch(() => null), status: response.status };
      });
      const runtimeIdentity = attestPreviewRuntimeIdentity({
        expected: expectedRuntimeIdentity,
        payload: runtimeResult.payload,
        status: runtimeResult.status,
      });
      return { runtimeIdentity, sessionAttestation };
    } catch (error) {
      throw new Error("Isolated QA authentication failed before Lighthouse execution.", { cause: error });
    } finally {
      await page.close();
    }
  } finally {
    await browser.disconnect();
  }
}

async function logoutQaAuthentication(chromePort, base) {
  const browser = await connect({ browserURL: `http://127.0.0.1:${chromePort}` });
  try {
    const page = await browser.newPage();
    try {
      await page.goto(base.href, { waitUntil: "domcontentloaded", timeout: 30_000 });
      return await page.evaluate(async () => {
        const before = await fetch("/api/auth/session", { cache: "no-store", credentials: "same-origin" });
        if (before.status === 401) return "NO_SESSION";
        if (before.status !== 200) throw new Error("session_state_unavailable");
        const csrfUrl = new URL("/api/auth/csrf", window.location.origin);
        csrfUrl.searchParams.set("method", "POST");
        csrfUrl.searchParams.set("path", "/api/auth/logout");
        const csrfResponse = await fetch(csrfUrl, { cache: "no-store", credentials: "same-origin" });
        const csrf = await csrfResponse.json().catch(() => null);
        if (!csrfResponse.ok || typeof csrf?.csrfToken !== "string") throw new Error("logout_csrf_unavailable");
        const logoutResponse = await fetch("/api/auth/logout?lang=en", {
          credentials: "same-origin",
          headers: { "x-novalure-csrf-token": csrf.csrfToken },
          method: "POST",
          redirect: "follow",
        });
        if (!logoutResponse.ok) throw new Error("logout_failed");
        const after = await fetch("/api/auth/session", { cache: "no-store", credentials: "same-origin" });
        if (after.status !== 401) throw new Error("session_remained_active");
        return "LOGGED_OUT";
      });
    } finally {
      await page.close();
    }
  } finally {
    await browser.disconnect();
  }
}

async function requireAuthenticatedCrmLanding(chromePort, base, target) {
  const browser = await connect({ browserURL: `http://127.0.0.1:${chromePort}` });
  try {
    const page = await browser.newPage();
    try {
      const response = await page.goto(target.href, { waitUntil: "domcontentloaded", timeout: 30_000 });
      assert.ok(response && response.status() >= 200 && response.status() < 400, "Authenticated CRM route did not return success.");
      const finalUrl = new URL(page.url());
      assert.equal(finalUrl.origin, base.origin, "Authenticated CRM route left the exact Preview origin.");
      assert.equal(finalUrl.pathname, "/", "Authenticated CRM route did not resolve to the exact CRM path.");
      assert.equal(finalUrl.hash, target.hash, "Authenticated CRM route did not preserve the exact release hash.");
      await page.waitForSelector("[data-crm-shell]", { timeout: 30_000, visible: true });
    } finally {
      await page.close();
    }
  } finally {
    await browser.disconnect();
  }
}

function score(lhr, category) {
  return Number(lhr.categories[category]?.score ?? 0);
}

function numericAudit(lhr, auditId) {
  const value = lhr.audits[auditId]?.numericValue;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function expectedResultKeys() {
  const keys = new Set();
  for (const [surface, routes] of [["public", publicRoutes], ["authenticated", authenticatedRoutes]]) {
    for (const route of routes) {
      for (const language of languages) {
        for (const profile of profiles) {
          for (const temperature of temperatures) {
            keys.add([surface, route, language, profile, temperature].join("|"));
          }
        }
      }
    }
  }
  return keys;
}

const args = parseArgs(process.argv.slice(2));
const startedAt = new Date().toISOString();
const baseUrl = args.get("base-url") ?? process.env.NOVALURE_QA_BASE_URL ?? "";
const expectedHost = args.get("expected-host") ?? process.env.NOVALURE_QA_EXPECTED_HOST ?? "";
assert.ok(baseUrl, "--base-url is required.");
assert.ok(expectedHost, "--expected-host is required.");
const base = requirePreviewTarget(baseUrl, expectedHost);
const shareUrl = validateShareUrl(args.has("share-url-stdin") ? await readShareUrlFromStdin() : "", base);
const publicOnly = args.has("public-only");
const qaCredentials = resolveQaCredentials(process.env, publicOnly);
const expectedRuntimeIdentity = requirePreviewRuntimeIdentityExpectation({
  databaseBranchId: args.get("expected-database-branch-id") ?? process.env.NOVALURE_QA_BRANCH_ID,
  deploymentHost: expectedHost,
  deploymentId: args.get("expected-deployment-id") ?? process.env.NOVALURE_QA_DEPLOYMENT_ID,
  gitBranch: args.get("expected-git-branch") ?? process.env.NOVALURE_QA_EXPECTED_GIT_BRANCH,
  gitSha: args.get("expected-sha") ?? process.env.NOVALURE_QA_EXPECTED_GIT_SHA,
});
const outputDirectory = path.resolve(args.get("output-dir") ?? path.join("artifacts", "qa", "lighthouse-preview-gate"));
const budgetPath = path.resolve(args.get("budget-file") ?? path.join("docs", "audit", "2026-08-23", "performance-budgets.json"));
const budgets = JSON.parse(await readFile(budgetPath, "utf8"));
assert.equal(budgets.schemaVersion, 1);
assert.ok(["PENDING_SIGNATURE", "SIGNED"].includes(budgets.status));
const baselinePath = args.get("baseline-evidence");
assert.ok(baselinePath, "--baseline-evidence is mandatory for the bundle-regression gate.");
const baselineSidecarPath = args.get("baseline-sidecar");
assert.ok(baselineSidecarPath, "--baseline-sidecar is mandatory for the bundle-regression gate.");
const baselineFilePath = path.resolve(baselinePath);
const baselineFileName = path.basename(baselineFilePath);
const baselineSnapshot = await readFile(baselineFilePath);
const baselineSidecar = await readFile(path.resolve(baselineSidecarPath), "utf8");
const baselineAttestation = attestLighthouseBaseline({
  baselineBytes: baselineSnapshot,
  currentCandidate: {
    deploymentHost: expectedRuntimeIdentity.deploymentHost,
    deploymentId: expectedRuntimeIdentity.deploymentId,
    gitBranch: expectedRuntimeIdentity.gitBranch,
    gitSha: expectedRuntimeIdentity.gitSha,
  },
  expectedDigest: args.get("baseline-expected-digest") ?? "",
  expectedFileName: baselineFileName,
  expectedKeys: expectedResultKeys(),
  expectedProvenance: {
    deploymentHost: args.get("baseline-expected-host"),
    deploymentId: args.get("baseline-expected-deployment-id"),
    gitBranch: args.get("baseline-expected-git-branch"),
    gitSha: args.get("baseline-expected-sha"),
  },
  lighthouseVersion: "13.4.1",
  sidecarText: baselineSidecar,
});
const baselineBytes = baselineAttestation.byteWeights;

const chromePath = args.get("browser-executable") ?? process.env.NOVALURE_BROWSER_EXECUTABLE;
const chromeUserDataDirectory = await mkdtemp(path.join(tmpdir(), "novalure-lighthouse-"));
let chromeLaunchPromise = null;
let chrome = null;
const cleanupBrowserRuntime = createBrowserRuntimeCleanup({
  getBrowser: async () => {
    if (!chromeLaunchPromise) return null;
    try {
      return await chromeLaunchPromise;
    } catch {
      return null;
    }
  },
  killOrphanedBrowsers: () => killAll(),
  profileDirectory: chromeUserDataDirectory,
  removeDirectory: rm,
});
const removeTerminationHandlers = installTerminationCleanup(cleanupBrowserRuntime);
const results = [];
let runError = null;
let executionBlocker = null;
let runtimeIdentity = null;
let sessionAttestation = null;
const cleanup = {
  browserProfileRemoved: false,
  qaSessionLogout: publicOnly ? "NOT_APPLICABLE" : "NOT_RUN",
};

try {
  chromeLaunchPromise = launch({
    chromeFlags: ["--headless=new", "--disable-gpu", "--no-default-browser-check", "--no-first-run"],
    chromePath: chromePath || undefined,
    handleSIGINT: false,
    logLevel: "silent",
    userDataDir: chromeUserDataDirectory,
  });
  chrome = await chromeLaunchPromise;
  await bootstrapShareAccess(chrome.port, base, shareUrl);

  async function runSurface(surface, routes) {
    for (const route of routes) {
    for (const language of languages) {
      const target = new URL(route, base);
      target.searchParams.set("lang", language);
      for (const profile of profiles) {
        for (const temperature of temperatures) {
          if (temperature === "cold") {
            const controlBrowser = await connect({ browserURL: `http://127.0.0.1:${chrome.port}` });
            const pages = await controlBrowser.pages();
            const controlPage = pages[0] ?? await controlBrowser.newPage();
            const session = await controlPage.createCDPSession();
            await session.send("Network.clearBrowserCache");
            await session.detach();
            await controlBrowser.disconnect();
          }

          if (surface === "authenticated") {
            await requireAuthenticatedCrmLanding(chrome.port, base, target);
          }
          const runner = await lighthouse(target.href, {
            disableStorageReset: true,
            logLevel: "error",
            onlyCategories: ["performance", "accessibility", "best-practices"],
            output: "json",
            port: chrome.port,
            preset: profile === "desktop" ? "desktop" : undefined,
          });
          if (!runner) throw new Error("Lighthouse did not return a result.");
          const lhr = runner.lhr;
          const finalDisplayed = new URL(lhr.finalDisplayedUrl);
          const finalOriginMatches = finalDisplayed.origin === base.origin;
          const exactAuthenticatedRoute =
            surface !== "authenticated" ||
            (finalDisplayed.pathname === "/" && finalDisplayed.hash === target.hash);
          const metrics = {
            cumulativeLayoutShift: numericAudit(lhr, "cumulative-layout-shift"),
            interactionToNextPaint: numericAudit(lhr, "interaction-to-next-paint"),
            largestContentfulPaint: numericAudit(lhr, "largest-contentful-paint"),
            totalBlockingTime: numericAudit(lhr, "total-blocking-time"),
            totalByteWeight: numericAudit(lhr, "total-byte-weight"),
          };
          const scores = {
            accessibility: score(lhr, "accessibility"),
            bestPractices: score(lhr, "best-practices"),
            performance: score(lhr, "performance"),
          };
          const baselineByteWeight = baselineBytes.get([surface, route, language, profile, temperature].join("|"));
          const bundleRegressionPercent =
            typeof baselineByteWeight === "number" && baselineByteWeight > 0 && typeof metrics.totalByteWeight === "number"
              ? ((metrics.totalByteWeight - baselineByteWeight) / baselineByteWeight) * 100
              : null;
          const budget = budgets[surface];
          const budgetFailures = [];
          if (!finalOriginMatches) budgetFailures.push("deployment_protection");
          if (!exactAuthenticatedRoute) budgetFailures.push("authenticated_route_mismatch");
          if (scores.performance < budget.performanceScoreMin) budgetFailures.push("performance_score");
          if (scores.accessibility < budget.accessibilityScoreMin) budgetFailures.push("accessibility_score");
          if (scores.bestPractices < budget.bestPracticesScoreMin) budgetFailures.push("best_practices_score");
          if (metrics.largestContentfulPaint === null || metrics.largestContentfulPaint > budget.largestContentfulPaintMaxMs) budgetFailures.push("largest_contentful_paint");
          if (metrics.cumulativeLayoutShift === null || metrics.cumulativeLayoutShift > budget.cumulativeLayoutShiftMax) budgetFailures.push("cumulative_layout_shift");
          if (metrics.totalBlockingTime === null || metrics.totalBlockingTime > budget.totalBlockingTimeMaxMs) budgetFailures.push("total_blocking_time");
          if (bundleRegressionPercent !== null && bundleRegressionPercent > budgets.bundle.maxRegressionPercent) budgetFailures.push("bundle_regression");
          if (bundleRegressionPercent === null) budgetFailures.push("bundle_baseline_missing");

          results.push({
            budgetFailures,
            bundleRegressionPercent,
            language,
            metrics,
            passed: budgetFailures.length === 0,
            profile,
            route,
            scores,
            surface,
            temperature,
          });
        }
      }
    }
  }
  }

  await runSurface("public", publicRoutes);
  if (qaCredentials) {
    try {
      const attestation = await bootstrapQaAuthentication(chrome.port, base, qaCredentials, expectedRuntimeIdentity);
      runtimeIdentity = attestation.runtimeIdentity;
      sessionAttestation = attestation.sessionAttestation;
      await runSurface("authenticated", authenticatedRoutes);
    } finally {
      try {
        cleanup.qaSessionLogout = await logoutQaAuthentication(chrome.port, base);
      } catch {
        cleanup.qaSessionLogout = "FAILED";
      }
    }
  }
} catch (error) {
  runError = error;
  executionBlocker = "lighthouse_execution_failed";
} finally {
  try {
    await settleRunWithCleanup(runError, cleanupBrowserRuntime);
  } catch {
    executionBlocker ??= "lighthouse_or_cleanup_failed";
  } finally {
    try {
      await cleanupBrowserRuntime();
      cleanup.browserProfileRemoved = true;
    } catch {
      executionBlocker ??= "browser_cleanup_failed";
    } finally {
      removeTerminationHandlers();
    }
  }
}

const publicCoverageComplete =
  results.filter((item) => item.surface === "public").length ===
    publicRoutes.length * languages.length * profiles.length * temperatures.length;
const authenticatedCoverageComplete =
  !publicOnly &&
  results.filter((item) => item.surface === "authenticated").length ===
    authenticatedRoutes.length * languages.length * profiles.length * temperatures.length;
const runtimeIdentityAttestationComplete = publicOnly || Boolean(runtimeIdentity && sessionAttestation);
const cleanupComplete =
  cleanup.browserProfileRemoved &&
  (publicOnly || ["LOGGED_OUT", "NO_SESSION"].includes(cleanup.qaSessionLogout));
const technicalPassed =
  executionBlocker === null &&
  publicCoverageComplete &&
  (publicOnly || authenticatedCoverageComplete) &&
  runtimeIdentityAttestationComplete &&
  cleanupComplete &&
  results.length > 0 &&
  results.every((item) => item.passed);
const signaturesPresent = budgets.status === "SIGNED" && Object.values(budgets.requiredSignatures).every(Boolean);
const manualGates = Object.freeze({
  mobileAssistiveTechnology: "PENDING",
  screenReader: "PENDING",
  zoomAndReflow: "PENDING",
});
const realUserMonitoring = Object.freeze({
  reason: "No signed p75 RUM observation window is part of this lab run.",
  status: "BLOCKED",
});
const manualAndRumGatesComplete =
  Object.values(manualGates).every((status) => status === "PASS") &&
  realUserMonitoring.status === "PASS";
const endedAt = new Date().toISOString();
const evidence = {
  authenticatedCoverageComplete,
  baseOrigin: base.origin,
  budgetApprovalStatus: budgets.status,
  budgetPolicySha256: sha256(canonicalJson({
    authenticated: budgets.authenticated,
    bundle: budgets.bundle,
    public: budgets.public,
    realUserP75: budgets.realUserP75,
    requiredApprovalRoles: Object.keys(budgets.requiredSignatures),
    schemaVersion: budgets.schemaVersion,
  })),
  baselineProvenance: baselineAttestation.provenance,
  cleanup: { ...cleanup, complete: cleanupComplete },
  endedAt,
  evidenceDigest: null,
  executionScope: {
    authSideEffects: publicOnly
      ? "NOT_APPLICABLE"
      : "LOGIN_CHALLENGE_MFA_VERIFICATION_AUDIT_AND_SESSION_WRITES_EXPECTED",
    mfaEnrollment: "PROHIBITED",
    mutationCapablePublicFixtures: "EXCLUDED_FROM_LIGHTHOUSE_SCOPE",
    networkMethodEnforcement: "NOT_AVAILABLE_IN_LIGHTHOUSE_RUN",
    publicAndCrmBusinessData: "NO_RUNNER_ISSUED_MUTATION_ATTESTATION_ONLY",
    sessionCleanupRequired: !publicOnly,
  },
  executionBlocker,
  expectedSha: expectedRuntimeIdentity.gitSha,
  generatedAt: endedAt,
  manualAndRumGatesComplete,
  manualGates,
  productionMutationPerformed: false,
  publicCoverageComplete,
  realUserMonitoring,
  releasePassed:
    technicalPassed &&
    !publicOnly &&
    authenticatedCoverageComplete &&
    signaturesPresent &&
    manualAndRumGatesComplete,
  results,
  runtimeIdentity: runtimeIdentity
    ? { attested: true, expected: expectedRuntimeIdentity, observed: runtimeIdentity }
    : { attested: false, expected: expectedRuntimeIdentity, observed: null },
  schemaVersion: 2,
  sessionAttestation,
  signaturesPresent,
  startedAt,
  technicalPassed,
  tool: { lighthouse: "13.4.1" },
};
const canonical = `${JSON.stringify(evidence, null, 2)}\n`;
evidence.evidenceDigest = sha256(canonical);
await mkdir(outputDirectory, { recursive: true });
const evidenceFileName = "lighthouse-preview-gate.json";
const evidenceSidecarFileName = "lighthouse-preview-gate.json.sha256";
const serializedEvidence = `${JSON.stringify(evidence, null, 2)}\n`;
await writeFile(path.join(outputDirectory, evidenceFileName), serializedEvidence, "utf8");
await writeFile(
  path.join(outputDirectory, evidenceSidecarFileName),
  `${sha256(serializedEvidence)}  ${evidenceFileName}\n`,
  "utf8",
);
console.log(JSON.stringify({
  evidenceDigest: evidence.evidenceDigest,
  failed: results.filter((item) => !item.passed).length,
  outputDirectory,
  releasePassed: evidence.releasePassed,
  authenticatedCoverageComplete,
  technicalPassed,
  total: results.length,
}));
if (!evidence.releasePassed) process.exitCode = 1;
