import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createA11yBrowserContextOptions } from "./lib/a11y-browser-context.mjs";

const source = await readFile(new URL("./a11y-browser-matrix.mjs", import.meta.url), "utf8");
const acceptanceMatrix = JSON.parse(await readFile(
  new URL("../docs/audit/2026-08-23/accessibility-acceptance-matrix.json", import.meta.url),
  "utf8",
));
const releaseSurfaceManifest = JSON.parse(await readFile(
  new URL("../docs/audit/2026-08-23/release-surface-manifest.json", import.meta.url),
  "utf8",
));

test("browser matrix is exact-host Preview-only and refuses embedded credentials or tokens", () => {
  assert.match(source, /parsed\.hostname === expectedHost/u);
  assert.match(source, /Base URL must not contain query parameters or share tokens/u);
  assert.match(source, /Production alias is forbidden/u);
  assert.match(source, /Production project alias is forbidden/u);
  assert.match(source, /endsWith\("\.vercel\.app"\)/u);
  assert.match(source, /Only the Vercel share parameter is allowed/u);
  assert.match(source, /Action-time QA fixture must target the exact Preview origin/u);
  assert.match(source, /Action-time QA fixture must not contain a fragment/u);
  assert.match(source, /blocker: "deployment_protection"/u);
});

test("cross-origin subrequests can never inherit a direct Vercel bypass header", () => {
  const options = createA11yBrowserContextOptions({
    height: 844,
    isMobile: true,
    width: 390,
  });
  const inheritedHeaders = new Headers(options.extraHTTPHeaders);
  const crossOriginSubrequest = new URL("https://third-party.example.invalid/pixel");

  assert.equal(crossOriginSubrequest.origin, "https://third-party.example.invalid");
  assert.equal(inheritedHeaders.has("x-vercel-protection-bypass"), false);
  assert.equal(inheritedHeaders.has("x-vercel-set-bypass-cookie"), false);
  assert.equal("extraHTTPHeaders" in options, false);
  assert.doesNotMatch(
    source,
    /NOVALURE_QA_VERCEL_BYPASS_TOKEN|x-vercel-protection-bypass|x-vercel-set-bypass-cookie/u,
  );
  assert.match(source, /primePreviewAccess\(context, shareUrl, base\)/u);
});

test("static and dynamic public coverage always runs before any isolated fixture login", () => {
  assert.ok(source.indexOf("await runPublicMatrix();") < source.indexOf("await runPublicFixtureMatrix();"));
  assert.ok(source.indexOf("await runPublicFixtureMatrix();") < source.indexOf("await runMfaMatrix();"));
  assert.ok(source.indexOf("await runMfaMatrix();") < source.indexOf("await runAuthenticatedMatrix();"));
  assert.match(source, /NOVALURE_QA_PREVIEW_EMAIL/u);
  assert.match(source, /NOVALURE_QA_PREVIEW_PASSWORD/u);
  assert.match(source, /\^codextest_preview_/u);
  assert.match(source, /blocker: "qa_fixture_credentials_unavailable"/u);
  assert.match(source, /session\?\.workspace\?\.setupState\?\.previewFixture === true/u);
  assert.match(source, /session\?\.workspace\?\.setupState\?\.qaPrefix === "CODEXTEST_PREVIEW_"/u);
  assert.match(source, /session\?\.user\?\.role === "agent"/u);
  assert.match(source, /session\?\.user\?\.productRole === "team_member"/u);
});

test("authenticated matrix uses only fixed SPA hashes and covers all critical authenticated surfaces", () => {
  for (const [id, hash] of [
    ["dashboard", "dashboard"], ["contacts", "contacts"], ["pipelines", "pipelines"],
    ["tasks", "tasks"], ["meetings", "meetings"], ["forms", "forms"],
    ["funnels", "funnels"], ["settings", "settings"], ["invitation", "customer-access"],
  ]) {
    assert.ok(acceptanceMatrix.scope.authenticated.includes(id));
    assert.match(source, new RegExp(`hash: "${hash}", id: "${id}"`, "u"));
  }
  assert.match(source, /url\.hash = surface\.hash/u);
  assert.match(source, /Authenticated route is not in the fixed release matrix/u);
  assert.match(source, /expectedHash: surfaceDefinition\.hash/u);
  assert.match(source, /confirmAuthenticatedSurface/u);
  assert.match(source, /\[data-crm-nav-item\]\[aria-current="page"\]/u);
  assert.match(source, /authenticated_surface_unavailable/u);
  assert.match(source, /\[data-crm-shell\]/u);
});

test("MFA is a required cookie-bound isolated fixture challenge with optional redacted TOTP completion", () => {
  assert.deepEqual(acceptanceMatrix.scope.authChallenges, ["mfa-verification"]);
  assert.match(source, /NOVALURE_QA_PREVIEW_TOTP_SECRET/u);
  assert.match(source, /createHmac\("sha1"/u);
  assert.match(source, /#login-mfa-code/u);
  assert.match(source, /qa_mfa_challenge_unavailable/u);
  assert.match(source, /qa_mfa_totp_unavailable/u);
  assert.match(source, /qa_mfa_verification_failed/u);
  assert.match(source, /await verifyQaFixtureSession/u);
});

test("action-time public fixtures are bounded, host-locked, executable and never silently omitted", () => {
  for (const variable of [
    "NOVALURE_QA_A11Y_PUBLIC_FORM_URL",
    "NOVALURE_QA_A11Y_PUBLIC_FUNNEL_URL",
    "NOVALURE_QA_A11Y_PASSWORD_RESET_RESULT_URL",
  ]) assert.match(source, new RegExp(variable, "u"));
  assert.match(source, /--fixture-input-stdin/u);
  assert.match(source, /Public-form fixture must use the canonical Preview form route/u);
  assert.match(source, /Public-funnel fixture must use the canonical Preview funnel route/u);
  assert.match(source, /Password-reset result fixture must use an approved result route/u);
  assert.match(source, /submitPublicFormFixture/u);
  assert.match(source, /submitPublicFunnelFixture/u);
  assert.match(source, /blocker: "action_time_fixture_unavailable"/u);
  assert.match(source, /outcome: "BLOCKED"/u);
  assert.deepEqual(acceptanceMatrix.scope.publicFixtureFlows, [
    "public-form-page", "public-form-submit-result", "public-funnel-page",
    "public-funnel-submit-result", "password-reset-result",
  ]);
  assert.ok(acceptanceMatrix.scope.public.includes("reset-password-invalid-result"));
  assert.deepEqual(acceptanceMatrix.fixtureRequirements.map((requirement) => requirement.id), [
    "isolated-auth-fixture", "public-action-time-fixtures", "release-surface-manifest-contract",
  ]);
  assert.ok(acceptanceMatrix.fixtureRequirements.every((requirement) =>
    requirement.required === true && requirement.owner === null && requirement.signature === null));
});

test("release-surface manifest is the route source of truth for the expanded matrix", () => {
  for (const route of ["/forms/[slug]/[formSlug]", "/login", "/login/reset-password", "/preview/[funnelId]"]) {
    assert.ok(releaseSurfaceManifest.pages.includes(route));
  }
  for (const entry of ["customerAccess", "forms", "funnels", "settings"]) {
    assert.ok(releaseSurfaceManifest.navigationEntries.includes(entry));
  }
  assert.match(source, /validateReleaseSurfaceManifest/u);
  assert.match(source, /releaseSurfaceManifestVerified/u);
});

test("browser matrix covers DE/EN, desktop, mobile, reduced motion and selected reflow", () => {
  assert.match(source, /const languages = \["de", "en"\]/u);
  for (const profile of ["desktop", "mobile", "zoom-200-reflow", "zoom-400-reflow"]) {
    assert.match(source, new RegExp(profile, "u"));
  }
  assert.match(source, /const authenticatedProfiles/u);
  assert.match(source, /const publicFixtureProfiles/u);
  assert.match(source, /const mfaProfiles/u);
  assert.equal(createA11yBrowserContextOptions({ height: 900, width: 1440 }).reducedMotion, "reduce");
  assert.match(source, /horizontalOverflow/u);
  assert.match(source, /page\.keyboard\.press\("Tab"\)/u);
});

test("Axe gate uses WCAG 2.2 AA and fails runtime, Critical, Serious and unresolved equivalents", () => {
  assert.match(source, /"wcag22aa"/u);
  assert.match(source, /item\.impact === "serious" \|\| item\.impact === "critical"/u);
  assert.match(source, /unresolvedSeriousOrCritical\.length === 0/u);
  assert.match(source, /seriousOrCritical\.length === 0/u);
  assert.match(source, /browserErrorCount === 0/u);
  assert.match(source, /consoleErrorCount === 0/u);
  assert.match(source, /status >= 200 && status < 400/u);
});

test("public-only remains diagnostic and technical pass requires every static and fixture coverage class", () => {
  assert.match(source, /const publicOnlyDiagnostic = args\.has\("public-only"\)/u);
  assert.match(source, /authenticatedCoverageComplete = !publicOnlyDiagnostic/u);
  assert.match(source, /authFixtureCoverageComplete = !publicOnlyDiagnostic/u);
  assert.match(source, /const automatedTechnicalPassed =[\s\S]*!publicOnlyDiagnostic[\s\S]*publicFixtureCoverageComplete[\s\S]*authFixtureCoverageComplete/u);
  assert.match(source, /mode: publicOnlyDiagnostic \? "PUBLIC_ONLY_DIAGNOSTIC" : "RELEASE_GATE"/u);
  assert.match(source, /if \(!releasePassed\) process\.exitCode = 1/u);
  assert.equal(acceptanceMatrix.releaseRule.publicOnlyDiagnosticCanRelease, false);
  assert.equal(acceptanceMatrix.releaseRule.blockedRowsFailRelease, true);
});

test("release pass additionally requires signed manual acceptance and complete signatures", () => {
  assert.match(source, /acceptance\.acceptanceContractComplete/u);
  assert.match(source, /acceptance\.matrixSigned/u);
  assert.match(source, /acceptance\.manualAcceptancePassed/u);
  assert.match(source, /acceptance\.signaturesComplete/u);
  assert.equal(acceptanceMatrix.status, "PENDING_SIGNATURE");
  assert.ok(acceptanceMatrix.automatedChecks.length >= 6);
  assert.ok(acceptanceMatrix.automatedChecks.some((check) =>
    check.id === "required-fixture-flow-coverage" && check.required === true));
  assert.equal(acceptanceMatrix.releaseRule.authChallengeCoverageRequired, true);
  assert.equal(acceptanceMatrix.releaseRule.dynamicFixtureCoverageRequired, true);
  assert.ok(acceptanceMatrix.manualChecks.length >= 8);
  assert.ok(acceptanceMatrix.manualChecks.every((check) => check.required && check.status === "PENDING"));
  assert.ok(acceptanceMatrix.approvals.length >= 3);
  assert.ok(acceptanceMatrix.approvals.every((approval) =>
    approval.owner === null && approval.signature === null &&
    approval.signedAt === null && approval.status === "PENDING"));
});

test("acceptance matrix explicitly covers required manual WCAG 2.2 AA scenarios", () => {
  const ids = new Set(acceptanceMatrix.manualChecks.map((check) => check.id));
  for (const id of [
    "screenreader-navigation-and-announcements", "dialog-focus-trap-and-return",
    "form-errors-and-instructions", "complete-keyboard-operation",
    "zoom-reflow-and-text-spacing", "mobile-orientation-and-targets",
    "mfa-reset-and-invitation-flow", "public-form-and-funnel-submit-flow",
  ]) assert.ok(ids.has(id), `Missing manual acceptance row: ${id}`);
  assert.deepEqual(acceptanceMatrix.scope.languages, ["de", "en"]);
});

test("evidence contains no QA credentials, action-time URLs, tokens, raw logs, customer text or selectors", () => {
  const evidenceSection = source.slice(source.indexOf("const evidence ="));
  assert.doesNotMatch(
    evidenceSection,
    /NOVALURE_QA_|actionTimeFixtures|publicFormUrl|publicFunnelUrl|passwordResetResultUrl|shareUrl|baseOrigin|bypassToken|credentials|message\.text|textContent|innerText|\.target/u,
  );
  assert.match(source, /nodes: item\.nodes\.length/u);
  assert.match(source, /consoleErrorCount/u);
  assert.match(source, /browserErrorCount/u);
  assert.match(source, /evidenceDigest/u);
  assert.match(source, /targetHost: base\.hostname/u);
});
