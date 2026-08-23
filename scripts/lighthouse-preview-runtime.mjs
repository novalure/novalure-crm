import assert from "node:assert/strict";
import { createHash } from "node:crypto";

const deploymentHostPattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.vercel\.app$/u;
const deploymentIdPattern = /^dpl_[A-Za-z0-9]{20,80}$/u;
const gitBranchPattern = /^codex\/[A-Za-z0-9._/-]{1,220}$/u;
const gitShaPattern = /^[a-f0-9]{40}$/u;
const sha256Pattern = /^[a-f0-9]{64}$/u;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function requireBaselineProvenance(provenance) {
  const normalized = {
    deploymentHost: provenance?.deploymentHost?.trim().toLowerCase() ?? "",
    deploymentId: provenance?.deploymentId?.trim() ?? "",
    gitBranch: provenance?.gitBranch?.trim() ?? "",
    gitSha: provenance?.gitSha?.trim().toLowerCase() ?? "",
  };
  assert.match(normalized.deploymentHost, deploymentHostPattern, "Trusted baseline host is invalid.");
  assert.match(normalized.deploymentId, deploymentIdPattern, "Trusted baseline deployment id is invalid.");
  assert.match(normalized.gitBranch, gitBranchPattern, "Trusted baseline Git branch is invalid.");
  assert.match(normalized.gitSha, gitShaPattern, "Trusted baseline Git SHA is invalid.");
  return normalized;
}

export function attestLighthouseBaseline({
  baselineBytes,
  currentCandidate,
  expectedDigest,
  expectedFileName,
  expectedKeys,
  expectedProvenance,
  lighthouseVersion,
  sidecarText,
}) {
  assert.ok(Buffer.isBuffer(baselineBytes), "Baseline evidence must be read as one immutable byte snapshot.");
  assert.match(expectedDigest, sha256Pattern, "Trusted baseline digest must be an exact lowercase SHA-256 value.");
  const actualDigest = sha256(baselineBytes);
  assert.equal(actualDigest, expectedDigest, "Baseline evidence does not match the externally pinned SHA-256 digest.");

  const sidecarMatch = /^([a-f0-9]{64}) {2}([^\r\n]+)\r?\n?$/u.exec(sidecarText);
  assert.ok(sidecarMatch, "Baseline SHA-256 sidecar has an invalid format.");
  assert.equal(sidecarMatch[1], expectedDigest, "Baseline sidecar digest does not match the pinned digest.");
  assert.equal(sidecarMatch[2], expectedFileName, "Baseline sidecar filename does not match the evidence file.");

  const trusted = requireBaselineProvenance(expectedProvenance);
  const current = requireBaselineProvenance(currentCandidate);
  assert.notEqual(trusted.gitSha, current.gitSha, "The candidate cannot use itself as the Lighthouse baseline.");
  assert.notEqual(trusted.deploymentId, current.deploymentId, "The candidate deployment cannot be its own Lighthouse baseline.");
  assert.notEqual(trusted.deploymentHost, current.deploymentHost, "The candidate host cannot be its own Lighthouse baseline.");

  let baseline;
  try {
    baseline = JSON.parse(baselineBytes.toString("utf8"));
  } catch {
    assert.fail("Baseline evidence must be valid JSON.");
  }
  assert.equal(baseline?.schemaVersion, 2, "Baseline evidence schema version is not trusted.");
  assert.equal(baseline?.tool?.lighthouse, lighthouseVersion, "Baseline Lighthouse version does not match the gate.");
  assert.equal(baseline?.expectedSha, trusted.gitSha, "Baseline expected SHA does not match the trusted candidate.");
  assert.equal(baseline?.baseOrigin, `https://${trusted.deploymentHost}`, "Baseline origin does not match the trusted host.");
  assert.equal(baseline?.technicalPassed, true, "Baseline must be a completed technical PASS.");
  assert.equal(baseline?.publicCoverageComplete, true, "Baseline public coverage is incomplete.");
  assert.equal(baseline?.authenticatedCoverageComplete, true, "Baseline authenticated coverage is incomplete.");
  assert.equal(baseline?.cleanup?.complete, true, "Baseline browser/session cleanup is incomplete.");
  assert.equal(baseline?.runtimeIdentity?.attested, true, "Baseline runtime identity was not attested.");

  const expectedIdentity = baseline?.runtimeIdentity?.expected;
  const observedIdentity = baseline?.runtimeIdentity?.observed;
  assert.equal(expectedIdentity?.deploymentHost, trusted.deploymentHost, "Baseline expected host is mismatched.");
  assert.equal(expectedIdentity?.deploymentId, trusted.deploymentId, "Baseline expected deployment id is mismatched.");
  assert.equal(expectedIdentity?.gitBranch, trusted.gitBranch, "Baseline expected Git branch is mismatched.");
  assert.equal(expectedIdentity?.gitSha, trusted.gitSha, "Baseline expected Git SHA is mismatched.");
  assert.equal(observedIdentity?.host, trusted.deploymentHost, "Baseline observed host is mismatched.");
  assert.equal(observedIdentity?.deploymentId, trusted.deploymentId, "Baseline observed deployment id is mismatched.");
  assert.equal(observedIdentity?.gitBranch, trusted.gitBranch, "Baseline observed Git branch is mismatched.");
  assert.equal(observedIdentity?.gitSha, trusted.gitSha, "Baseline observed Git SHA is mismatched.");
  assert.equal(
    observedIdentity?.databaseBranchId,
    expectedIdentity?.databaseBranchId,
    "Baseline observed database branch is mismatched.",
  );
  assert.match(
    observedIdentity?.databaseBranchId ?? "",
    /^br-[A-Za-z0-9-]{8,128}$/u,
    "Baseline database branch id is invalid.",
  );

  assert.ok(expectedKeys instanceof Set && expectedKeys.size > 0, "Expected baseline result keys are unavailable.");
  assert.ok(Array.isArray(baseline?.results), "Baseline results are unavailable.");
  assert.equal(baseline.results.length, expectedKeys.size, "Baseline result count is incomplete or contains extras.");
  const byteWeights = new Map();
  for (const result of baseline.results) {
    const key = [result?.surface, result?.route, result?.language, result?.profile, result?.temperature].join("|");
    assert.ok(expectedKeys.has(key), `Baseline result key is not part of the release matrix: ${key}`);
    assert.ok(!byteWeights.has(key), `Baseline result key is duplicated: ${key}`);
    assert.equal(result?.passed, true, `Baseline row is not a PASS: ${key}`);
    assert.deepEqual(result?.budgetFailures, [], `Baseline row contains budget failures: ${key}`);
    const byteWeight = result?.metrics?.totalByteWeight;
    assert.ok(
      typeof byteWeight === "number" && Number.isFinite(byteWeight) && byteWeight > 0,
      `Baseline byte weight is invalid: ${key}`,
    );
    byteWeights.set(key, byteWeight);
  }
  for (const key of expectedKeys) assert.ok(byteWeights.has(key), `Baseline release-matrix row is missing: ${key}`);

  return Object.freeze({
    byteWeights,
    evidence: baseline,
    provenance: Object.freeze({
      digest: expectedDigest,
      schemaVersion: baseline.schemaVersion,
      ...trusted,
    }),
  });
}

export function requireTrustedShareLanding(pageUrl, previewOrigin) {
  const landingOrigin = new URL(pageUrl).origin;
  assert.ok(
    landingOrigin === previewOrigin || landingOrigin === "https://vercel.com",
    "Share access left the exact Preview/Vercel trust boundary.",
  );
  return landingOrigin;
}

export async function requirePreviewApplicationLanding({ page, previewOrigin, response }) {
  const status = response?.status?.();
  assert.ok(
    Number.isInteger(status) && status >= 200 && status < 400,
    "Share cookie did not return a successful Preview response.",
  );
  assert.equal(
    new URL(page.url()).origin,
    previewOrigin,
    "Share cookie did not grant access to the exact Preview origin.",
  );
  await page.waitForSelector("[data-public-language]", { timeout: 10_000, visible: true });
  assert.equal(
    new URL(page.url()).origin,
    previewOrigin,
    "Preview application marker resolved outside the exact Preview origin.",
  );
}

export function createBrowserRuntimeCleanup({
  getBrowser,
  killOrphanedBrowsers,
  profileDirectory,
  removeDirectory,
}) {
  let cleanupPromise;
  return function cleanupBrowserRuntime() {
    cleanupPromise ??= (async () => {
      const errors = [];
      let browser = null;
      try {
        browser = await getBrowser();
      } catch (error) {
        errors.push(error);
      }
      if (browser) {
        try {
          await browser.kill();
        } catch (error) {
          errors.push(error);
        }
      } else if (killOrphanedBrowsers) {
        try {
          const orphanErrors = await killOrphanedBrowsers();
          if (Array.isArray(orphanErrors)) errors.push(...orphanErrors);
        } catch (error) {
          errors.push(error);
        }
      }
      try {
        await removeDirectory(profileDirectory, {
          force: true,
          maxRetries: 30,
          recursive: true,
          retryDelay: 100,
        });
      } catch (error) {
        errors.push(error);
      }
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) {
        throw new AggregateError(errors, "Chrome shutdown and secret-profile cleanup both failed.");
      }
    })();
    return cleanupPromise;
  };
}

export async function settleRunWithCleanup(primaryError, cleanup) {
  let cleanupError = null;
  try {
    await cleanup();
  } catch (error) {
    cleanupError = error;
  }
  if (primaryError && cleanupError) {
    throw new AggregateError(
      [primaryError, cleanupError],
      "Lighthouse execution and secret-profile cleanup both failed.",
    );
  }
  if (primaryError) throw primaryError;
  if (cleanupError) throw cleanupError;
}

export function installTerminationCleanup(cleanup, {
  logger = console,
  processObject = process,
} = {}) {
  let terminationStarted = false;
  const handlers = new Map();
  for (const [signal, exitCode] of [["SIGINT", 130], ["SIGTERM", 143]]) {
    const handler = () => {
      if (terminationStarted) return;
      terminationStarted = true;
      void cleanup().then(
        () => processObject.exit(exitCode),
        (error) => {
          logger.error("Lighthouse browser cleanup failed during termination.", error);
          processObject.exit(1);
        },
      );
    };
    handlers.set(signal, handler);
    processObject.on(signal, handler);
  }
  return () => {
    for (const [signal, handler] of handlers) processObject.off(signal, handler);
  };
}
