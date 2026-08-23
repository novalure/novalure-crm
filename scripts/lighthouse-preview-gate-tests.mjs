import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [source, rawBudgets] = await Promise.all([
  readFile(new URL("./lighthouse-preview-gate.mjs", import.meta.url), "utf8"),
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
  assert.doesNotMatch(source, /runner\.report|finalDisplayedUrl:/u);
  const evidenceSection = source.slice(source.indexOf("const evidence ="));
  assert.doesNotMatch(evidenceSection, /shareUrl|bypass|finalDisplayedUrl|requestedUrl/u);
  assert.doesNotMatch(evidenceSection, /qaCredentials|NOVALURE_QA_PREVIEW_(?:EMAIL|PASSWORD)/u);
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
