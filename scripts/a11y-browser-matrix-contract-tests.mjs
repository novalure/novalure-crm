import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  classifyA11yBrowserRequest,
  createA11yBrowserContextOptions,
} from "./lib/a11y-browser-context.mjs";
import {
  attestMfaVerificationChallenge,
  attestPreviewRuntimeIdentity,
  attestQaBrowserSession,
  parseStrictCliArgs,
  requirePreviewRuntimeIdentityExpectation,
  requireQaBrowserCredentials,
} from "./lib/preview-runtime-identity.mjs";

const source = await readFile(new URL("./a11y-browser-matrix.mjs", import.meta.url), "utf8");
const identitySource = await readFile(new URL("./lib/preview-runtime-identity.mjs", import.meta.url), "utf8");
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
  assert.match(source, /"\/datadeletion"/u);
  assert.ok(acceptanceMatrix.scope.public.includes("data-deletion-alias"));
  for (const input of ["expected-deployment-id", "expected-git-branch", "expected-database-branch-id", "expected-sha"]) {
    assert.match(source, new RegExp(input, "u"));
  }
});

test("A11y CLI rejects unknown, duplicate and malformed arguments", () => {
  const options = {
    booleanNames: ["read-only"],
    valueNames: ["base-url", "expected-host"],
  };
  assert.deepEqual(
    [...parseStrictCliArgs(["--read-only", "--base-url", "https://candidate.vercel.app"], options)],
    [["read-only", "1"], ["base-url", "https://candidate.vercel.app"]],
  );
  assert.throws(() => parseStrictCliArgs(["--unknown", "value"], options), /Unknown CLI argument/u);
  assert.throws(() => parseStrictCliArgs(["--read-only", "--read-only"], options), /Duplicate CLI argument/u);
  assert.throws(() => parseStrictCliArgs(["--base-url", "first", "--base-url", "second"], options), /Duplicate CLI argument/u);
  assert.throws(() => parseStrictCliArgs(["positional"], options), /malformed argument/u);
  assert.throws(() => parseStrictCliArgs(["--base-url"], options), /Missing value/u);
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
  assert.equal(options.serviceWorkers, "block");
  assert.doesNotMatch(
    source,
    /NOVALURE_QA_VERCEL_BYPASS_TOKEN|x-vercel-protection-bypass|x-vercel-set-bypass-cookie/u,
  );
  assert.match(source, /primePreviewAccess\(context, shareUrl, base\)/u);
});

test("read-only network guard blocks form, funnel and arbitrary writes while allowing only exact auth writes", () => {
  const previewOrigin = "https://candidate.vercel.app";
  for (const pathname of [
    "/api/forms/submission-proof",
    "/api/forms/submissions",
    "/api/funnels/funnel-id/submission-proof",
    "/api/funnels/funnel-id/submissions",
    "/api/funnels/funnel-id/visits",
    "/api/crm/arbitrary-write",
  ]) {
    assert.equal(classifyA11yBrowserRequest({
      allowAuthWrites: true,
      method: "POST",
      previewOrigin,
      requestUrl: `${previewOrigin}${pathname}`,
    }).allowed, false, pathname);
  }
  for (const pathname of ["/api/auth/login", "/api/auth/logout?lang=en", "/api/auth/session"]) {
    const url = new URL(pathname, previewOrigin).href;
    assert.equal(classifyA11yBrowserRequest({
      allowAuthWrites: true,
      method: "POST",
      previewOrigin,
      requestUrl: url,
    }).category, "EXPECTED_AUTH_WRITE");
    assert.equal(classifyA11yBrowserRequest({
      allowAuthWrites: false,
      method: "POST",
      previewOrigin,
      requestUrl: url,
    }).allowed, false);
  }
  assert.equal(classifyA11yBrowserRequest({
    allowAuthWrites: true,
    method: "POST",
    previewOrigin,
    requestUrl: "https://example.com/api/auth/login",
  }).allowed, false);
  for (const method of ["GET", "HEAD", "OPTIONS"]) {
    assert.equal(classifyA11yBrowserRequest({
      allowAuthWrites: false,
      method,
      previewOrigin,
      requestUrl: `${previewOrigin}/anything`,
    }).allowed, true);
  }
});

test("static and read-only dynamic public coverage always runs before any isolated fixture login", () => {
  assert.ok(source.indexOf("await runPublicMatrix();") < source.indexOf("await runPublicFixtureMatrix();"));
  assert.ok(source.indexOf("await runPublicFixtureMatrix();") < source.indexOf("await runMfaMatrix();"));
  assert.ok(source.indexOf("await runMfaMatrix();") < source.indexOf("await runAuthenticatedMatrix();"));
  assert.match(identitySource, /NOVALURE_QA_PREVIEW_EMAIL/u);
  assert.match(identitySource, /NOVALURE_QA_PREVIEW_PASSWORD/u);
  assert.match(identitySource, /\^codextest_/u);
  assert.match(source, /blocker: "qa_fixture_credentials_unavailable"/u);
  assert.match(identitySource, /session\?\.workspace\?\.id\?\.toLowerCase\(\), credentials\.workspaceId/u);
  assert.match(identitySource, /setupState\?\.\[credentials\.fixtureMarkerKey\]/u);
  assert.match(identitySource, /session\?\.user\?\.role, credentials\.role/u);
  assert.match(identitySource, /session\?\.user\?\.productRole, credentials\.productRole/u);
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
  assert.match(identitySource, /NOVALURE_QA_PREVIEW_TOTP_SECRET/u);
  assert.match(identitySource, /createHmac\("sha1"/u);
  assert.match(source, /#login-mfa-code/u);
  assert.match(source, /qa_mfa_challenge_unavailable/u);
  assert.match(source, /qa_mfa_totp_unavailable/u);
  assert.match(source, /qa_mfa_verification_failed/u);
  assert.match(source, /qa_mfa_verification_challenge_required/u);
  assert.doesNotMatch(source, /recoveryCodesSaved\.check/u);
  assert.match(source, /await verifyQaFixtureSession/u);
});

test("MFA attestation accepts only verification and rejects enrollment or workspace selection", () => {
  assert.equal(attestMfaVerificationChallenge({
    hasCodeInput: true,
    hasEnrollmentControl: false,
    hasWorkspaceSelectionControl: false,
    step: "mfa_verification",
  }), "mfa_verification");
  assert.throws(() => attestMfaVerificationChallenge({
    hasCodeInput: true,
    hasEnrollmentControl: true,
    hasWorkspaceSelectionControl: false,
    step: "mfa_enrollment",
  }), /MFA enrollment is prohibited/u);
  assert.throws(() => attestMfaVerificationChallenge({
    hasCodeInput: false,
    hasEnrollmentControl: false,
    hasWorkspaceSelectionControl: true,
    step: "workspace_selection",
  }), /Workspace selection is not an MFA verification challenge/u);
});

test("action-time public fixtures stay read-only while real submit states require signed manual evidence", () => {
  for (const variable of [
    "NOVALURE_QA_A11Y_PUBLIC_FORM_URL",
    "NOVALURE_QA_A11Y_PUBLIC_FUNNEL_URL",
    "NOVALURE_QA_A11Y_PASSWORD_RESET_RESULT_URL",
  ]) assert.match(source, new RegExp(variable, "u"));
  assert.match(source, /fixture-input-stdin/u);
  assert.match(source, /Public-form fixture must use the canonical Preview form route/u);
  assert.match(source, /Public-funnel fixture must use the canonical Preview funnel route/u);
  assert.match(source, /Password-reset result fixture must use an approved result route/u);
  assert.match(source, /--read-only is mandatory/u);
  assert.match(source, /blockedOrNotRun/u);
  assert.match(source, /notRun: results\.filter/u);
  assert.doesNotMatch(source, /scenario\.kind === "submit"|read_only_public_write_prohibited|createNotRunResult/u);
  assert.doesNotMatch(source, /submitPublicFormFixture|submitPublicFunnelFixture|\/api\/forms\/submissions/u);
  assert.match(source, /blocker: "action_time_fixture_unavailable"/u);
  assert.match(source, /outcome: "BLOCKED"/u);
  assert.deepEqual(acceptanceMatrix.scope.publicFixtureFlows, [
    "public-form-page", "public-form-submit-result", "public-funnel-page",
    "public-funnel-submit-result", "password-reset-result",
  ]);
  assert.equal(acceptanceMatrix.releaseRule.publicSubmitStatesRequireSignedManualEvidence, true);
  assert.match(
    acceptanceMatrix.automatedChecks.find((check) => check.id === "required-fixture-flow-coverage").requirement,
    /separately bound public-runtime E2E.*required signed manual/u,
  );
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
  assert.match(source, /const automatedTechnicalPassed =[\s\S]*!publicOnlyDiagnostic[\s\S]*runtimeIdentityAttestationComplete[\s\S]*publicFixtureCoverageComplete[\s\S]*authFixtureCoverageComplete/u);
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
  assert.equal(acceptanceMatrix.releaseRule.publicSubmitStatesRequireSignedManualEvidence, true);
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
  assert.match(source, /startedAt/u);
  assert.match(source, /endedAt/u);
  assert.match(source, /sessionLogoutFailures/u);
  assert.match(source, /a11y-browser-matrix\.json\.sha256/u);
  assert.match(source, /LOGIN_CHALLENGE_MFA_VERIFICATION_AUDIT_AND_SESSION_WRITES_EXPECTED/u);
  assert.match(source, /publicAndCrmBusinessData: readOnlyMode && unsafeHttpWriteGuardComplete/u);
  assert.match(source, /HTTP_WRITE_GUARD_ENFORCED/u);
  assert.match(source, /unsafe_http_write_attempted/u);
  assert.match(source, /blockedAttemptCount: blockedUnsafeHttpWrites\.length/u);
  assert.match(source, /guardedContextCount === expectedGuardedContextCount/u);
  assert.match(source, /expectedGuardedContextCount,/u);
  assert.match(source, /serviceWorkersBlocked: true/u);
  assert.doesNotMatch(source.slice(source.indexOf("const evidence =")), /requestUrl|pathname|url:/u);
  assert.match(source, /mfaEnrollment: "PROHIBITED"/u);
  assert.doesNotMatch(source, /readOnly: readOnlyMode/u);
});

test("shared authenticated identity guard rejects every candidate identity mismatch", () => {
  const expected = requirePreviewRuntimeIdentityExpectation({
    databaseBranchId: "br-lucky-heart-alrm9dlw",
    deploymentHost: "candidate.vercel.app",
    deploymentId: "dpl_12345678901234567890",
    gitBranch: "codex/go-live-remediation-20260822",
    gitSha: "a".repeat(40),
  });
  const payload = {
    atomicRegistration: true,
    databaseBranchId: expected.databaseBranchId,
    deploymentHost: expected.deploymentHost,
    deploymentId: expected.deploymentId,
    gitBranch: expected.gitBranch,
    gitSha: expected.gitSha,
    version: 2,
  };
  assert.deepEqual(attestPreviewRuntimeIdentity({ expected, payload, status: 200 }), {
    databaseBranchId: expected.databaseBranchId,
    deploymentId: expected.deploymentId,
    gitBranch: expected.gitBranch,
    gitSha: expected.gitSha,
    host: expected.deploymentHost,
  });
  for (const field of ["databaseBranchId", "deploymentHost", "deploymentId", "gitBranch", "gitSha"]) {
    assert.throws(
      () => attestPreviewRuntimeIdentity({ expected, payload: { ...payload, [field]: "mismatch" }, status: 200 }),
      /does not match/u,
    );
  }
  assert.throws(() => attestPreviewRuntimeIdentity({ expected, payload, status: 403 }), /HTTP 200/u);
});

test("shared QA session guard requires exact workspace, marker, role and product role", () => {
  const credentials = requireQaBrowserCredentials({
    NOVALURE_QA_PREVIEW_EMAIL: "codextest_reset@example.test",
    NOVALURE_QA_PREVIEW_FIXTURE_MARKER: "go-live-two-tenant-v1",
    NOVALURE_QA_PREVIEW_FIXTURE_MARKER_KEY: "qaFixture",
    NOVALURE_QA_PREVIEW_PASSWORD: "x".repeat(24),
    NOVALURE_QA_PREVIEW_PRODUCT_ROLE: "platform_admin",
    NOVALURE_QA_PREVIEW_ROLE: "owner",
    NOVALURE_QA_PREVIEW_TOTP_SECRET: "JBSWY3DPEHPK3PXP",
    NOVALURE_QA_PREVIEW_WORKSPACE_ID: "11111111-1111-4111-8111-111111111111",
  }, { requireTotp: true });
  const session = {
    authenticated: true,
    user: { email: credentials.email, productRole: "platform_admin", role: "owner" },
    workspace: { id: credentials.workspaceId, setupState: { qaFixture: credentials.fixtureMarker } },
  };
  assert.equal(attestQaBrowserSession(session, credentials).workspaceId, credentials.workspaceId);
  assert.throws(
    () => attestQaBrowserSession({ ...session, workspace: { ...session.workspace, id: "22222222-2222-4222-8222-222222222222" } }, credentials),
    /workspace does not match/u,
  );
});

test("acceptance prose binds generic codextest identity to the exact QA workspace marker", () => {
  const requirement = acceptanceMatrix.fixtureRequirements.find((item) => item.id === "isolated-auth-fixture")?.requirement ?? "";
  assert.match(requirement, /codextest_ email prefix/u);
  assert.match(requirement, /NOVALURE_QA_PREVIEW_FIXTURE_MARKER_KEY=qaFixture/u);
  assert.match(requirement, /NOVALURE_QA_PREVIEW_FIXTURE_MARKER=go-live-two-tenant-v1/u);
  assert.doesNotMatch(requirement, /codextest_preview_|CODEXTEST_PREVIEW_/u);
});
