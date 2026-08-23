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

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) throw new Error(`Unexpected argument: ${argument}`);
    if (
      argument === "--public-only" ||
      argument === "--share-url-stdin" ||
      argument === "--require-bundle-baseline"
    ) {
      values.set(argument.slice(2), "1");
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${argument}`);
    values.set(argument.slice(2), value);
    index += 1;
  }
  return values;
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
  assert.deepEqual([...parsed.searchParams.keys()], ["_vercel_share"], "Only the Vercel share parameter is allowed.");
  assert.match(parsed.searchParams.get("_vercel_share") ?? "", /^[a-zA-Z0-9_-]{20,512}$/u, "Share token is invalid.");
  return parsed;
}

function resolveQaCredentials(env, publicOnly) {
  if (publicOnly) return null;
  const email = env.NOVALURE_QA_PREVIEW_EMAIL?.trim().toLowerCase() ?? "";
  const password = env.NOVALURE_QA_PREVIEW_PASSWORD ?? "";
  assert.match(
    email,
    /^codextest_preview_[a-z0-9._+-]+@[a-z0-9.-]+$/u,
    "Authenticated Lighthouse requires the isolated codextest_preview_ QA fixture.",
  );
  assert.ok(password.length >= 16, "Authenticated Lighthouse requires the isolated QA fixture password.");
  return Object.freeze({ email, password });
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

async function bootstrapQaAuthentication(chromePort, base, credentials) {
  const browser = await connect({ browserURL: `http://127.0.0.1:${chromePort}` });
  try {
    const page = await browser.newPage();
    try {
      const loginUrl = new URL("/login", base);
      loginUrl.searchParams.set("lang", "en");
      loginUrl.searchParams.set("returnTo", "/#dashboard");
      await page.goto(loginUrl.href, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await page.waitForSelector("#login-email", { timeout: 15_000 });
      await page.type("#login-email", credentials.email);
      await page.type("#login-password", credentials.password);
      await Promise.all([
        page.waitForNavigation({ timeout: 30_000, waitUntil: "domcontentloaded" }).catch(() => null),
        page.click('form[action="/api/auth/login"] button[type="submit"]'),
      ]);
      await page.waitForSelector("[data-crm-nav]", { timeout: 30_000 });
      const finalUrl = new URL(page.url());
      assert.equal(finalUrl.origin, base.origin, "QA authentication left the exact Preview origin.");
      assert.notEqual(finalUrl.pathname, "/login", "QA authentication did not establish an app session.");
    } catch (error) {
      throw new Error("Isolated QA authentication failed before Lighthouse execution.", { cause: error });
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

function resultKey(result) {
  return [result.surface, result.route, result.language, result.profile, result.temperature].join("|");
}

const args = parseArgs(process.argv.slice(2));
const baseUrl = args.get("base-url") ?? process.env.NOVALURE_QA_BASE_URL ?? "";
const expectedHost = args.get("expected-host") ?? process.env.NOVALURE_QA_EXPECTED_HOST ?? "";
assert.ok(baseUrl, "--base-url is required.");
assert.ok(expectedHost, "--expected-host is required.");
const base = requirePreviewTarget(baseUrl, expectedHost);
const shareUrl = validateShareUrl(args.has("share-url-stdin") ? await readShareUrlFromStdin() : "", base);
const publicOnly = args.has("public-only");
const qaCredentials = resolveQaCredentials(process.env, publicOnly);
const expectedSha = (args.get("expected-sha") ?? "").trim();
if (expectedSha) assert.match(expectedSha, /^[a-f0-9]{40}$/u, "--expected-sha must be a full Git SHA.");
const outputDirectory = path.resolve(args.get("output-dir") ?? path.join("artifacts", "qa", "lighthouse-preview-gate"));
const budgetPath = path.resolve(args.get("budget-file") ?? path.join("docs", "audit", "2026-08-23", "performance-budgets.json"));
const budgets = JSON.parse(await readFile(budgetPath, "utf8"));
assert.equal(budgets.schemaVersion, 1);
assert.ok(["PENDING_SIGNATURE", "SIGNED"].includes(budgets.status));
const baselinePath = args.get("baseline-evidence");
const baseline = baselinePath ? JSON.parse(await readFile(path.resolve(baselinePath), "utf8")) : null;
const baselineBytes = new Map((baseline?.results ?? []).map((item) => [resultKey(item), item.metrics?.totalByteWeight ?? null]));

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
          const finalOriginMatches = new URL(lhr.finalDisplayedUrl).origin === base.origin;
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
          if (scores.performance < budget.performanceScoreMin) budgetFailures.push("performance_score");
          if (scores.accessibility < budget.accessibilityScoreMin) budgetFailures.push("accessibility_score");
          if (scores.bestPractices < budget.bestPracticesScoreMin) budgetFailures.push("best_practices_score");
          if (metrics.largestContentfulPaint === null || metrics.largestContentfulPaint > budget.largestContentfulPaintMaxMs) budgetFailures.push("largest_contentful_paint");
          if (metrics.cumulativeLayoutShift === null || metrics.cumulativeLayoutShift > budget.cumulativeLayoutShiftMax) budgetFailures.push("cumulative_layout_shift");
          if (metrics.totalBlockingTime === null || metrics.totalBlockingTime > budget.totalBlockingTimeMaxMs) budgetFailures.push("total_blocking_time");
          if (bundleRegressionPercent !== null && bundleRegressionPercent > budgets.bundle.maxRegressionPercent) budgetFailures.push("bundle_regression");
          if (args.has("require-bundle-baseline") && bundleRegressionPercent === null) budgetFailures.push("bundle_baseline_missing");

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
    await bootstrapQaAuthentication(chrome.port, base, qaCredentials);
    await runSurface("authenticated", authenticatedRoutes);
  }
} catch (error) {
  runError = error;
} finally {
  try {
    await settleRunWithCleanup(runError, cleanupBrowserRuntime);
  } finally {
    removeTerminationHandlers();
  }
}

const technicalPassed = results.every((item) => item.passed);
const authenticatedCoverageComplete =
  !publicOnly &&
  results.filter((item) => item.surface === "authenticated").length ===
    authenticatedRoutes.length * languages.length * profiles.length * temperatures.length;
const signaturesPresent = budgets.status === "SIGNED" && Object.values(budgets.requiredSignatures).every(Boolean);
const evidence = {
  authenticatedCoverageComplete,
  baseOrigin: base.origin,
  budgetApprovalStatus: budgets.status,
  evidenceDigest: null,
  expectedSha: expectedSha || null,
  generatedAt: new Date().toISOString(),
  releasePassed: technicalPassed && authenticatedCoverageComplete && signaturesPresent,
  results,
  schemaVersion: 1,
  signaturesPresent,
  technicalPassed,
  tool: { lighthouse: "13.4.1" },
};
const canonical = `${JSON.stringify(evidence, null, 2)}\n`;
evidence.evidenceDigest = sha256(canonical);
await mkdir(outputDirectory, { recursive: true });
await writeFile(path.join(outputDirectory, "lighthouse-preview-gate.json"), `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
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
