import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  attestLighthouseBaseline,
  createBrowserRuntimeCleanup,
  installTerminationCleanup,
  requirePreviewApplicationLanding,
  requireTrustedShareLanding,
  settleRunWithCleanup,
} from "./lighthouse-preview-runtime.mjs";
import {
  attestMfaVerificationChallenge,
  parseStrictCliArgs,
} from "./lib/preview-runtime-identity.mjs";

const [source, runtimeSource, rawBudgets] = await Promise.all([
  readFile(new URL("./lighthouse-preview-gate.mjs", import.meta.url), "utf8"),
  readFile(new URL("./lighthouse-preview-runtime.mjs", import.meta.url), "utf8"),
  readFile(new URL("../docs/audit/2026-08-23/performance-budgets.json", import.meta.url), "utf8"),
]);
const budgets = JSON.parse(rawBudgets);

function baselineFixture(overrides = {}) {
  const trusted = {
    deploymentHost: "trusted-baseline.vercel.app",
    deploymentId: "dpl_12345678901234567890",
    gitBranch: "codex/go-live-remediation-20260822",
    gitSha: "a".repeat(40),
  };
  const expectedKeys = new Set(["public|/|de|desktop|cold", "authenticated|/#dashboard|en|mobile|warm"]);
  const result = (key, totalByteWeight = 100_000) => {
    const [surface, route, language, profile, temperature] = key.split("|");
    return {
      budgetFailures: [],
      language,
      metrics: { totalByteWeight },
      passed: true,
      profile,
      route,
      surface,
      temperature,
    };
  };
  const evidence = {
    authenticatedCoverageComplete: true,
    baseOrigin: `https://${trusted.deploymentHost}`,
    cleanup: { complete: true },
    expectedSha: trusted.gitSha,
    publicCoverageComplete: true,
    results: [...expectedKeys].map((key) => result(key)),
    runtimeIdentity: {
      attested: true,
      expected: {
        databaseBranchId: "br-trustedbaseline1",
        deploymentHost: trusted.deploymentHost,
        deploymentId: trusted.deploymentId,
        gitBranch: trusted.gitBranch,
        gitSha: trusted.gitSha,
      },
      observed: {
        databaseBranchId: "br-trustedbaseline1",
        deploymentId: trusted.deploymentId,
        gitBranch: trusted.gitBranch,
        gitSha: trusted.gitSha,
        host: trusted.deploymentHost,
      },
    },
    schemaVersion: 2,
    technicalPassed: true,
    tool: { lighthouse: "13.4.1" },
    ...overrides,
  };
  const bytes = Buffer.from(`${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  const digest = createHash("sha256").update(bytes).digest("hex");
  return {
    args: {
      baselineBytes: bytes,
      currentCandidate: {
        deploymentHost: "current-candidate.vercel.app",
        deploymentId: "dpl_ABCDEFGHIJ1234567890",
        gitBranch: trusted.gitBranch,
        gitSha: "b".repeat(40),
      },
      expectedDigest: digest,
      expectedFileName: "lighthouse-preview-gate.json",
      expectedKeys,
      expectedProvenance: trusted,
      lighthouseVersion: "13.4.1",
      sidecarText: `${digest}  lighthouse-preview-gate.json\n`,
    },
    digest,
    evidence,
    expectedKeys,
    result,
    trusted,
  };
}

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
  assert.match(source, /Share URL must not contain credentials/u);
  assert.match(source, /Share URL must not contain a fragment/u);
  assert.match(runtimeSource, /landingOrigin === previewOrigin \|\| landingOrigin === "https:\/\/vercel\.com"/u);
  assert.match(runtimeSource, /Share cookie did not grant access to the exact Preview origin/u);
  assert.doesNotMatch(source, /runner\.report|finalDisplayedUrl:/u);
  const evidenceSection = source.slice(source.indexOf("const evidence ="));
  assert.doesNotMatch(evidenceSection, /shareUrl|bypass|finalDisplayedUrl|requestedUrl/u);
  assert.doesNotMatch(evidenceSection, /qaCredentials|NOVALURE_QA_PREVIEW_(?:EMAIL|PASSWORD)/u);
  for (const input of ["expected-deployment-id", "expected-git-branch", "expected-database-branch-id", "expected-sha"]) {
    assert.match(source, new RegExp(input, "u"));
  }
  assert.match(source, /\/api\/admin\/qa-batch-capability/u);
});

test("Lighthouse CLI rejects unknown, duplicate and malformed arguments", () => {
  const options = {
    booleanNames: ["public-only"],
    valueNames: ["base-url", "baseline-evidence"],
  };
  assert.deepEqual(
    [...parseStrictCliArgs(["--public-only", "--base-url", "https://candidate.vercel.app"], options)],
    [["public-only", "1"], ["base-url", "https://candidate.vercel.app"]],
  );
  assert.throws(() => parseStrictCliArgs(["--unknown", "value"], options), /Unknown CLI argument/u);
  assert.throws(() => parseStrictCliArgs(["--public-only", "--public-only"], options), /Duplicate CLI argument/u);
  assert.throws(
    () => parseStrictCliArgs(["--baseline-evidence", "first", "--baseline-evidence", "second"], options),
    /Duplicate CLI argument/u,
  );
  assert.throws(() => parseStrictCliArgs(["positional"], options), /malformed argument/u);
});

test("Lighthouse runner owns and reliably removes its secret-bearing Chrome profile", () => {
  assert.match(source, /mkdtemp\(path\.join\(tmpdir\(\), "novalure-lighthouse-"\)\)/u);
  assert.match(source, /userDataDir: chromeUserDataDirectory/u);
  assert.match(source, /handleSIGINT: false/u);
  assert.match(source, /killOrphanedBrowsers: \(\) => killAll\(\)/u);
  assert.match(source, /installTerminationCleanup\(cleanupBrowserRuntime\)/u);
  assert.match(source, /await settleRunWithCleanup\(runError, cleanupBrowserRuntime\)/u);
  assert.match(source, /await cleanupBrowserRuntime\(\);[\s\S]*cleanup\.browserProfileRemoved = true/u);
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
  assert.match(source, /requireQaBrowserCredentials/u);
  assert.match(source, /currentTotp\(credentials\.totpSecret\)/u);
  assert.match(source, /#login-mfa-code/u);
  assert.match(source, /attestMfaVerificationChallenge/u);
  assert.doesNotMatch(source, /recoveryCodesSaved\.click/u);
  assert.match(source, /finalUrl\.pathname, "\/"/u);
  assert.match(source, /finalUrl\.hash, "#dashboard"/u);
  assert.match(source, /\[data-crm-shell\]/u);
  assert.match(source, /attestQaBrowserSession/u);
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

test("Lighthouse authentication rejects MFA enrollment and workspace selection", () => {
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

test("authenticated routes are exact-path shell checks and the QA session is revoked before browser cleanup", () => {
  assert.match(source, /requireAuthenticatedCrmLanding\(chrome\.port, base, target\)/u);
  assert.match(source, /finalUrl\.pathname, "\/"/u);
  assert.match(source, /finalUrl\.hash, target\.hash/u);
  assert.match(source, /authenticated_route_mismatch/u);
  assert.match(source, /logoutQaAuthentication\(chrome\.port, base\)/u);
  assert.match(source, /x-novalure-csrf-token/u);
  assert.match(source, /after\.status !== 401/u);
  assert.match(source, /cleanup\.qaSessionLogout/u);
});

test("bundle regression baseline is mandatory and missing rows fail closed", () => {
  assert.match(source, /--baseline-evidence is mandatory/u);
  assert.match(source, /--baseline-sidecar is mandatory/u);
  for (const input of [
    "baseline-expected-digest",
    "baseline-expected-host",
    "baseline-expected-deployment-id",
    "baseline-expected-git-branch",
    "baseline-expected-sha",
  ]) assert.match(source, new RegExp(input, "u"));
  assert.match(source, /attestLighthouseBaseline/u);
  assert.match(source, /if \(bundleRegressionPercent === null\) budgetFailures\.push\("bundle_baseline_missing"\)/u);
  assert.doesNotMatch(source, /require-bundle-baseline/u);
});

test("baseline provenance requires the pinned byte digest, sidecar and exact trusted candidate", () => {
  const fixture = baselineFixture();
  const attested = attestLighthouseBaseline(fixture.args);
  assert.equal(attested.provenance.digest, fixture.digest);
  assert.equal(attested.provenance.gitSha, fixture.trusted.gitSha);
  assert.equal(attested.byteWeights.size, fixture.expectedKeys.size);

  const tamperedBytes = Buffer.from(fixture.args.baselineBytes);
  tamperedBytes[tamperedBytes.length - 2] = tamperedBytes[tamperedBytes.length - 2] === 32 ? 33 : 32;
  assert.throws(
    () => attestLighthouseBaseline({ ...fixture.args, baselineBytes: tamperedBytes }),
    /externally pinned SHA-256/u,
  );
  assert.throws(
    () => attestLighthouseBaseline({ ...fixture.args, sidecarText: `${"c".repeat(64)}  lighthouse-preview-gate.json\n` }),
    /sidecar digest/u,
  );
  assert.throws(
    () => attestLighthouseBaseline({
      ...fixture.args,
      currentCandidate: { ...fixture.args.currentCandidate, gitSha: fixture.trusted.gitSha },
    }),
    /cannot use itself/u,
  );
  for (const field of ["deploymentHost", "deploymentId", "gitBranch", "gitSha"]) {
    const mismatched = field === "deploymentHost"
      ? "other-baseline.vercel.app"
      : field === "deploymentId"
        ? "dpl_ZYXWVUTSRQ0987654321"
        : field === "gitBranch"
          ? "codex/other-baseline"
          : "c".repeat(40);
    assert.throws(
      () => attestLighthouseBaseline({
        ...fixture.args,
        expectedProvenance: { ...fixture.trusted, [field]: mismatched },
      }),
      /mismatch|does not match/u,
    );
  }
});

test("baseline provenance rejects duplicate, missing, extra and digest-tampered inflation rows", () => {
  const fixture = baselineFixture();
  const rebuild = (evidence, expectedDigest = null) => {
    const bytes = Buffer.from(`${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    const digest = createHash("sha256").update(bytes).digest("hex");
    return {
      ...fixture.args,
      baselineBytes: bytes,
      expectedDigest: expectedDigest ?? digest,
      sidecarText: `${digest}  lighthouse-preview-gate.json\n`,
    };
  };

  const duplicate = { ...fixture.evidence, results: [fixture.evidence.results[0], fixture.evidence.results[0]] };
  assert.throws(() => attestLighthouseBaseline(rebuild(duplicate)), /duplicated/u);
  const missing = { ...fixture.evidence, results: fixture.evidence.results.slice(0, 1) };
  assert.throws(() => attestLighthouseBaseline(rebuild(missing)), /count is incomplete/u);
  const extra = {
    ...fixture.evidence,
    results: [...fixture.evidence.results, fixture.result("public|/privacy|de|desktop|cold")],
  };
  assert.throws(() => attestLighthouseBaseline(rebuild(extra)), /count is incomplete/u);

  const inflated = structuredClone(fixture.evidence);
  inflated.results[0].metrics.totalByteWeight = 99_999_999;
  const inflatedBytes = Buffer.from(`${JSON.stringify(inflated, null, 2)}\n`, "utf8");
  const inflatedDigest = createHash("sha256").update(inflatedBytes).digest("hex");
  assert.throws(() => attestLighthouseBaseline({
    ...fixture.args,
    baselineBytes: inflatedBytes,
    sidecarText: `${inflatedDigest}  lighthouse-preview-gate.json\n`,
  }), /externally pinned SHA-256/u);
});

test("manual accessibility and real-user p75 gates remain pending or blocked", () => {
  assert.match(source, /screenReader: "PENDING"/u);
  assert.match(source, /mobileAssistiveTechnology: "PENDING"/u);
  assert.match(source, /zoomAndReflow: "PENDING"/u);
  assert.match(source, /status: "BLOCKED"/u);
  assert.match(source, /No signed p75 RUM observation window/u);
  assert.match(source, /manualAndRumGatesComplete/u);
  assert.match(source, /startedAt/u);
  assert.match(source, /endedAt/u);
  assert.match(source, /lighthouse-preview-gate\.json\.sha256/u);
  assert.match(source, /LOGIN_CHALLENGE_MFA_VERIFICATION_AUDIT_AND_SESSION_WRITES_EXPECTED/u);
  assert.match(source, /mutationCapablePublicFixtures: "EXCLUDED_FROM_LIGHTHOUSE_SCOPE"/u);
  assert.match(source, /networkMethodEnforcement: "NOT_AVAILABLE_IN_LIGHTHOUSE_RUN"/u);
  assert.match(source, /publicAndCrmBusinessData: "NO_RUNNER_ISSUED_MUTATION_ATTESTATION_ONLY"/u);
  assert.doesNotMatch(source, /publicAndCrmBusinessData: "READ_ONLY"/u);
  assert.match(source, /mfaEnrollment: "PROHIBITED"/u);
});

test("unsigned budgets can produce technical evidence but can never produce release PASS", () => {
  assert.match(source, /const signaturesPresent = budgets\.status === "SIGNED"/u);
  assert.match(source, /releasePassed:[\s\S]*technicalPassed[\s\S]*!publicOnly[\s\S]*authenticatedCoverageComplete[\s\S]*signaturesPresent[\s\S]*manualAndRumGatesComplete/u);
  assert.match(source, /!publicOnly[\s\S]*item\.surface === "authenticated"/u);
  assert.match(source, /if \(!evidence\.releasePassed\) process\.exitCode = 1/u);
});
