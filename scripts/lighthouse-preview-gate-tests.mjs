import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  createBrowserRuntimeCleanup,
  installTerminationCleanup,
  requirePreviewApplicationLanding,
  requireTrustedShareLanding,
  settleRunWithCleanup,
} from "./lighthouse-preview-runtime.mjs";

const [source, runtimeSource, rawBudgets] = await Promise.all([
  readFile(new URL("./lighthouse-preview-gate.mjs", import.meta.url), "utf8"),
  readFile(new URL("./lighthouse-preview-runtime.mjs", import.meta.url), "utf8"),
  readFile(new URL("../docs/audit/2026-08-23/performance-budgets.json", import.meta.url), "utf8"),
]);
const budgets = JSON.parse(rawBudgets);

test("performance budgets match the requested public, authenticated and p75 gates without fabricated signatures", () => {
  assert.equal(budgets.status, "PENDING_SIGNATURE");
  assert.equal(budgets.public.performanceScoreMin, 0.9);
  assert.equal(budgets.authenticated.performanceScoreMin, 0.8);
  assert.equal(budgets.public.accessibilityScoreMin, 0.95);
  assert.equal(budgets.realUserP75.largestContentfulPaintMaxMs, 2500);
  assert.equal(budgets.realUserP75.interactionToNextPaintMaxMs, 200);
  assert.equal(budgets.realUserP75.cumulativeLayoutShiftMax, 0.1);
  assert.deepEqual(budgets.requiredSignatures, { engineering: null, operations: null, product: null });
  assert.match(createHash("sha256").update(rawBudgets).digest("hex"), /^[a-f0-9]{64}$/u);
});

test("Lighthouse runner is exact-host Preview-only and never writes full reports or secret URLs", () => {
  assert.match(source, /Base URL host must exactly match --expected-host/u);
  assert.match(source, /Production alias is forbidden/u);
  assert.match(source, /Only the Vercel share parameter is allowed/u);
  assert.match(runtimeSource, /landingOrigin === previewOrigin \|\| landingOrigin === "https:\/\/vercel\.com"/u);
  assert.match(runtimeSource, /Share cookie did not grant access to the exact Preview origin/u);
  assert.doesNotMatch(source, /runner\.report|finalDisplayedUrl:/u);
  const evidenceSection = source.slice(source.indexOf("const evidence ="));
  assert.doesNotMatch(evidenceSection, /shareUrl|bypass|finalDisplayedUrl|requestedUrl/u);
  assert.doesNotMatch(evidenceSection, /qaCredentials|NOVALURE_QA_PREVIEW_(?:EMAIL|PASSWORD)/u);
});

test("Lighthouse runner owns and reliably removes its secret-bearing Chrome profile", () => {
  assert.match(source, /mkdtemp\(path\.join\(tmpdir\(\), "novalure-lighthouse-"\)\)/u);
  assert.match(source, /userDataDir: chromeUserDataDirectory/u);
  assert.match(source, /handleSIGINT: false/u);
  assert.match(source, /killOrphanedBrowsers: \(\) => killAll\(\)/u);
  assert.match(source, /installTerminationCleanup\(cleanupBrowserRuntime\)/u);
  assert.match(
    source,
    /try \{\s*await settleRunWithCleanup\(runError, cleanupBrowserRuntime\);\s*\} finally \{\s*removeTerminationHandlers\(\);/u,
  );
  assert.match(runtimeSource, /maxRetries: 30,[\s\S]*recursive: true,[\s\S]*retryDelay: 100/u);
});

test("share landing accepts only Vercel or the exact Preview and requires a successful app marker", async () => {
  const previewOrigin = "https://candidate.vercel.app";
  assert.equal(requireTrustedShareLanding(`${previewOrigin}/`, previewOrigin), previewOrigin);
  assert.equal(requireTrustedShareLanding("https://vercel.com/login", previewOrigin), "https://vercel.com");
  assert.throws(
    () => requireTrustedShareLanding("https://example.com/", previewOrigin),
    /trust boundary/u,
  );

  let markerSelector = null;
  const page = {
    url: () => `${previewOrigin}/`,
    waitForSelector: async (selector) => { markerSelector = selector; },
  };
  await requirePreviewApplicationLanding({
    page,
    previewOrigin,
    response: { status: () => 200 },
  });
  assert.equal(markerSelector, "[data-public-language]");

  await assert.rejects(
    requirePreviewApplicationLanding({
      page,
      previewOrigin,
      response: { status: () => 403 },
    }),
    /successful Preview response/u,
  );
  await assert.rejects(
    requirePreviewApplicationLanding({
      page: { ...page, waitForSelector: async () => { throw new Error("marker missing"); } },
      previewOrigin,
      response: { status: () => 200 },
    }),
    /marker missing/u,
  );
});

test("browser cleanup is idempotent and reports kill plus profile-removal failures", async () => {
  let killCount = 0;
  let removeCount = 0;
  const cleanup = createBrowserRuntimeCleanup({
    getBrowser: async () => ({ kill: async () => { killCount += 1; } }),
    killOrphanedBrowsers: async () => { throw new Error("orphan fallback must not run"); },
    profileDirectory: "C:/Temp/secret-profile",
    removeDirectory: async () => { removeCount += 1; },
  });
  await Promise.all([cleanup(), cleanup()]);
  assert.equal(killCount, 1);
  assert.equal(removeCount, 1);

  const failingCleanup = createBrowserRuntimeCleanup({
    getBrowser: async () => ({ kill: async () => { throw new Error("kill failed"); } }),
    killOrphanedBrowsers: async () => [],
    profileDirectory: "C:/Temp/secret-profile",
    removeDirectory: async () => { throw new Error("remove failed"); },
  });
  await assert.rejects(failingCleanup(), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors.map((item) => item.message), ["kill failed", "remove failed"]);
    return true;
  });

  let orphanKillCount = 0;
  const rejectedLaunchCleanup = createBrowserRuntimeCleanup({
    getBrowser: async () => null,
    killOrphanedBrowsers: async () => { orphanKillCount += 1; return []; },
    profileDirectory: "C:/Temp/secret-profile",
    removeDirectory: async () => { removeCount += 1; },
  });
  await rejectedLaunchCleanup();
  assert.equal(orphanKillCount, 1);
});

test("primary failures survive cleanup failures and signal cleanup exits only after removal", async () => {
  await assert.rejects(
    settleRunWithCleanup(new Error("primary failed"), async () => { throw new Error("cleanup failed"); }),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors.map((item) => item.message), ["primary failed", "cleanup failed"]);
      return true;
    },
  );

  const fakeProcess = new EventEmitter();
  const exitCodes = [];
  fakeProcess.exit = (code) => { exitCodes.push(code); };
  let cleanupComplete = false;
  let finishCleanup;
  const cleanupBlocked = new Promise((resolve) => { finishCleanup = resolve; });
  const dispose = installTerminationCleanup(async () => {
    await cleanupBlocked;
    cleanupComplete = true;
  }, {
    logger: { error: () => {} },
    processObject: fakeProcess,
  });
  fakeProcess.emit("SIGINT");
  fakeProcess.emit("SIGINT");
  assert.deepEqual(exitCodes, []);
  finishCleanup();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cleanupComplete, true);
  assert.deepEqual(exitCodes, [130]);
  dispose();
});

test("Lighthouse runner covers public and authenticated cold/warm, mobile/desktop, DE/EN gates", () => {
  assert.match(source, /const languages = \["de", "en"\]/u);
  assert.match(source, /const profiles = \["mobile", "desktop"\]/u);
  assert.match(source, /const temperatures = \["cold", "warm"\]/u);
  assert.match(source, /const authenticatedRoutes = \[/u);
  for (const route of ["#dashboard", "#contacts", "#pipelines", "#tasks", "#meetings"]) {
    assert.match(source, new RegExp(route, "u"));
  }
  assert.match(source, /codextest_preview_/u);
  assert.match(source, /disableStorageReset: true/u);
  assert.match(source, /await runSurface\("public", publicRoutes\)[\s\S]*bootstrapQaAuthentication[\s\S]*await runSurface\("authenticated"/u);
  for (const marker of [
    "performance_score",
    "accessibility_score",
    "best_practices_score",
    "largest_contentful_paint",
    "cumulative_layout_shift",
    "total_blocking_time",
    "bundle_regression",
    "bundle_baseline_missing",
  ]) assert.match(source, new RegExp(marker, "u"));
});

test("unsigned budgets can produce technical evidence but can never produce release PASS", () => {
  assert.match(source, /const signaturesPresent = budgets\.status === "SIGNED"/u);
  assert.match(source, /releasePassed: technicalPassed && authenticatedCoverageComplete && signaturesPresent/u);
  assert.match(source, /!publicOnly[\s\S]*item\.surface === "authenticated"/u);
  assert.match(source, /if \(!evidence\.releasePassed\) process\.exitCode = 1/u);
});
