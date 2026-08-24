#!/usr/bin/env node

import assert from "node:assert/strict";
import {
  createHash,
  generateKeyPairSync,
  sign as signDetached,
} from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildPerformanceTechnicalEvidenceSha256,
  finalPerformanceBudgetPolicy,
  finalPreviewGateBindings,
  observedFinalPreviewGateStatus,
} from "./final-preview-release-attestation-contract.mjs";
import {
  a11yExpectedResultKeys,
  performanceExpectedResultKeys,
} from "./lib/final-preview-gate-inventories.mjs";
import {
  accessibilityApprovalRoles,
  accessibilityManualEvidenceRecordType,
  accessibilityManualObservationIdsByCheck,
  accessibilityRequiredManualCheckIds,
} from "./lib/accessibility-manual-acceptance-receipt.mjs";
import {
  a11yFixtureLifecycleFileName,
  a11yFixtureLifecycleRecordType,
  a11yRetainedTableNames,
} from "./lib/a11y-fixture-lifecycle-evidence.mjs";
import {
  buildExternalGateReceiptSigningPayload,
  canonicalJson,
  sha256 as gateSha256,
} from "./lib/external-gate-receipts.mjs";
import {
  performanceBudgetApprovalRecordType,
  performanceBudgetApprovalRoles,
  performanceManualAcceptanceRecordType,
  performanceManualAcceptanceRole,
  performanceManualGateIds,
  performanceRumAcceptanceRecordType,
  performanceRumAcceptanceRole,
} from "./lib/performance-acceptance-receipts.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const assemblerPath = path.join(repositoryRoot, "scripts", "final-preview-evidence-freeze.mjs");
const trustAnchorId = "ta_novalure_freeze_test_20260823";
const receiptRoles = [
  ...accessibilityApprovalRoles.map((entry) => entry.receiptRole),
  ...performanceBudgetApprovalRoles.map((entry) => entry.receiptRole),
  performanceManualAcceptanceRole,
  performanceRumAcceptanceRole,
];
const signingKeys = Object.fromEntries(receiptRoles.map((role) => {
  const pair = generateKeyPairSync("ed25519");
  return [role, {
    keyId: `key_${role}_freeze_test`,
    privateKey: pair.privateKey,
    publicKeyPem: pair.publicKey.export({ format: "pem", type: "spki" }),
    signerSubject: `subject:novalure:${role}:freeze-test`,
  }];
}));
const trustAnchor = {
  keys: receiptRoles.map((role) => ({
    algorithm: "Ed25519",
    keyId: signingKeys[role].keyId,
    publicKeyPem: signingKeys[role].publicKeyPem,
    role,
    signerSubject: signingKeys[role].signerSubject,
    status: "ACTIVE",
  })),
  recordType: "NOVALURE_RELEASE_APPROVAL_TRUST_ANCHOR",
  schemaVersion: 1,
  trustAnchorId,
};
const trustAnchorSource = `${JSON.stringify(trustAnchor, null, 2)}\n`;
const trustAnchorSha256 = createHash("sha256").update(trustAnchorSource).digest("hex");
const trustContext = Object.freeze({ anchor: trustAnchor, expectedSha256: trustAnchorSha256 });

function runtime() {
  return {
    branch: "codex/go-live-remediation-20260822",
    candidateCommit: "a".repeat(40),
    databaseBranchId: "br-lucky-heart-alrm9dlw",
    databaseProjectId: "weathered-term-98273025",
    deploymentHost: "candidate-preview-novalure.vercel.app",
    deploymentId: "dpl_12345678901234567890",
  };
}

function receiptRuntime(value) {
  return {
    candidateCommit: value.candidateCommit,
    databaseBranchId: value.databaseBranchId,
    deploymentHost: value.deploymentHost,
    deploymentId: value.deploymentId,
    gitBranch: value.branch,
    productionMutationPerformed: false,
  };
}

function exactRuntimeIdentity(value) {
  return {
    databaseBranchId: value.databaseBranchId,
    deploymentHost: value.deploymentHost,
    deploymentId: value.deploymentId,
    gitBranch: value.branch,
    gitSha: value.candidateCommit,
  };
}

function externalReceipt(role, recordType, payload, signedAt = "2026-08-25T21:00:00.000Z") {
  const key = signingKeys[role];
  const payloadSha256 = gateSha256(canonicalJson(payload));
  const receipt = {
    detachedSignature: null,
    keyId: key.keyId,
    payload,
    payloadSha256,
    receiptId: `grc_${createHash("sha256").update(`${role}\0${recordType}\0${payloadSha256}`).digest("hex").slice(0, 32)}`,
    recordType,
    role,
    schemaVersion: 1,
    signatureAlgorithm: "Ed25519",
    signatureReference: `urn:novalure:gate-receipt:v1:${trustAnchorId}:${key.keyId}:${role}:${recordType}:${payloadSha256}`,
    signedAt,
    signerSubject: key.signerSubject,
    trustAnchorId,
    trustAnchorSha256,
  };
  receipt.detachedSignature = signDetached(
    null,
    Buffer.from(buildExternalGateReceiptSigningPayload(receipt), "utf8"),
    key.privateKey,
  ).toString("base64");
  return receipt;
}

async function writeJson(filePath, document) {
  await writeFile(filePath, `${JSON.stringify(document, null, 2)}\n`, { flag: "wx" });
  return filePath;
}

async function writePinnedJson(directory, fileName, document) {
  const sourcePath = path.join(directory, fileName);
  const source = `${JSON.stringify(document, null, 2)}\n`;
  const digest = createHash("sha256").update(source).digest("hex");
  const sidecarPath = `${sourcePath}.sha256`;
  await writeFile(sourcePath, source, { flag: "wx" });
  await writeFile(sidecarPath, `${digest}  ${fileName}\n`, { flag: "wx" });
  return { digest, sidecarPath, sourcePath };
}

function runAssembler(input, argv = []) {
  return spawnSync(process.execPath, [assemblerPath, ...argv], {
    cwd: repositoryRoot,
    encoding: "utf8",
    input: JSON.stringify(input),
  });
}

function gateBinding(id) {
  return finalPreviewGateBindings.find((binding) => binding.id === id);
}

function a11yRawSource(value) {
  const count = (surface) => a11yExpectedResultKeys.filter((key) => key.startsWith(`${surface}|`)).length;
  const results = a11yExpectedResultKeys.map((key) => {
    const [surface, route, language, profile] = key.split("|");
    return {
      audit: { violations: [] },
      blocker: null,
      browserErrorCount: 0,
      consoleErrorCount: 0,
      durationMs: 10,
      keyboardFocus: { focused: true },
      language,
      outcome: "PASS",
      passed: true,
      profile,
      route,
      status: 200,
      surface,
    };
  });
  return {
    acceptance: {
      contractComplete: true,
      manualAcceptancePassed: false,
      manualCheckCount: accessibilityRequiredManualCheckIds.length,
      manualPassCount: 0,
      matrixSigned: false,
      signatureCount: 0,
      signaturesComplete: false,
      status: "PENDING_SIGNATURE",
    },
    automatedSubsetPassed: true,
    automatedTechnicalPassed: true,
    browser: "chromium",
    cleanup: {
      browserClosed: true,
      complete: true,
      sessionLogoutAttempts: 1,
      sessionLogoutFailures: 0,
      sessionLogouts: 1,
      sessionsAlreadyAbsent: 0,
    },
    coverage: {
      authenticated: { complete: true, expected: count("authenticated"), observed: count("authenticated") },
      authenticatedFixture: { complete: true, expected: count("auth-fixture"), observed: count("auth-fixture") },
      public: { complete: true, expected: count("public"), observed: count("public") },
      publicFixture: { complete: true, expected: count("public-fixture"), observed: count("public-fixture") },
    },
    endedAt: "2026-08-25T19:30:00.000Z",
    evidenceDigest: "1".repeat(64),
    executionBlocker: null,
    executionScope: {
      authSideEffects: "LOGIN_CHALLENGE_MFA_VERIFICATION_AUDIT_AND_SESSION_WRITES_EXPECTED",
      mfaEnrollment: "PROHIBITED",
      publicAndCrmBusinessData: "HTTP_WRITE_GUARD_ENFORCED",
      sessionCleanupRequired: true,
    },
    expectedSha: value.candidateCommit,
    generatedAt: "2026-08-25T19:30:00.000Z",
    matrix: {
      blocked: 0,
      blockedOrNotRun: 0,
      failed: 0,
      notRun: 0,
      passed: results.length,
      total: results.length,
    },
    mode: "RELEASE_GATE",
    productionMutationPerformed: false,
    releasePassed: false,
    releaseSurfaceManifestVerified: true,
    results,
    runtimeIdentity: {
      attestationComplete: true,
      attestationCount: 8,
      expected: exactRuntimeIdentity(value),
      expectedAttestationCount: 8,
    },
    schemaVersion: 4,
    startedAt: "2026-08-25T19:00:00.000Z",
    targetHost: value.deploymentHost,
    unsafeHttpWriteGuard: {
      allowedAuthWrites: ["POST /api/auth/login", "POST /api/auth/logout", "POST /api/auth/session"],
      blockedAttemptCount: 0,
      blockedByMethod: {},
      blockedBySurface: {},
      complete: true,
      expectedGuardedContextCount: 20,
      guardedContextCount: 20,
      serviceWorkersBlocked: true,
    },
    wcagStandard: "WCAG 2.2 AA automated subset plus signed manual acceptance",
  };
}

function automatedA11yProjection(source, automatedSourceSha256) {
  return {
    automatedSourceSha256,
    automatedSubsetPassed: source.automatedSubsetPassed,
    automatedTechnicalPassed: source.automatedTechnicalPassed,
    browser: source.browser,
    cleanup: source.cleanup,
    coverage: source.coverage,
    endedAt: source.endedAt,
    evidenceDigest: source.evidenceDigest,
    executionBlocker: source.executionBlocker,
    executionScope: source.executionScope,
    expectedSha: source.expectedSha,
    generatedAt: source.generatedAt,
    matrix: source.matrix,
    mode: source.mode,
    productionMutationPerformed: source.productionMutationPerformed,
    releaseSurfaceManifestVerified: source.releaseSurfaceManifestVerified,
    results: source.results,
    runtimeIdentity: source.runtimeIdentity,
    schemaVersion: source.schemaVersion,
    startedAt: source.startedAt,
    targetHost: source.targetHost,
    unsafeHttpWriteGuard: source.unsafeHttpWriteGuard,
    wcagStandard: source.wcagStandard,
  };
}

function performanceRawSource(value) {
  const expected = exactRuntimeIdentity(value);
  return {
    authenticatedCoverageComplete: true,
    baseOrigin: `https://${value.deploymentHost}`,
    baselineProvenance: {
      candidate: { gitSha: "b".repeat(40) },
      lighthouseVersion: "13.4.1",
    },
    budgetApprovalStatus: "PENDING_SIGNATURE",
    budgetPolicySha256: gateSha256(canonicalJson(finalPerformanceBudgetPolicy)),
    cleanup: { browserProfileRemoved: true, complete: true, qaSessionLogout: "LOGGED_OUT" },
    endedAt: "2026-08-25T19:30:00.000Z",
    evidenceDigest: "2".repeat(64),
    executionBlocker: null,
    executionScope: {
      authSideEffects: "LOGIN_CHALLENGE_MFA_VERIFICATION_AUDIT_AND_SESSION_WRITES_EXPECTED",
      mfaEnrollment: "PROHIBITED",
      mutationCapablePublicFixtures: "EXCLUDED_FROM_LIGHTHOUSE_SCOPE",
      networkMethodEnforcement: "NOT_AVAILABLE_IN_LIGHTHOUSE_RUN",
      publicAndCrmBusinessData: "NO_RUNNER_ISSUED_MUTATION_ATTESTATION_ONLY",
      sessionCleanupRequired: true,
    },
    expectedSha: value.candidateCommit,
    generatedAt: "2026-08-25T19:30:00.000Z",
    manualAndRumGatesComplete: false,
    manualGates: {
      mobileAssistiveTechnology: "PENDING",
      screenReader: "PENDING",
      zoomAndReflow: "PENDING",
    },
    productionMutationPerformed: false,
    publicCoverageComplete: true,
    realUserMonitoring: { reason: "External signed RUM evidence is required.", status: "BLOCKED" },
    releasePassed: false,
    results: performanceExpectedResultKeys.map((key) => {
      const [surface, route, language, profile, temperature] = key.split("|");
      return {
        budgetFailures: [],
        bundleRegressionPercent: 0,
        language,
        metrics: {
          cumulativeLayoutShift: 0.01,
          interactionToNextPaint: null,
          largestContentfulPaint: 1_000,
          totalBlockingTime: 50,
          totalByteWeight: 200_000,
        },
        passed: true,
        profile,
        route,
        scores: { accessibility: 1, bestPractices: 1, performance: 1 },
        surface,
        temperature,
      };
    }),
    runtimeIdentity: {
      attested: true,
      expected,
      observed: {
        databaseBranchId: expected.databaseBranchId,
        deploymentId: expected.deploymentId,
        gitBranch: expected.gitBranch,
        gitSha: expected.gitSha,
        host: expected.deploymentHost,
      },
    },
    schemaVersion: 2,
    sessionAttestation: { status: "PASS" },
    signaturesPresent: false,
    startedAt: "2026-08-25T19:00:00.000Z",
    technicalPassed: true,
    tool: { lighthouse: "13.4.1" },
  };
}

async function commonFixtureRoot(t) {
  const root = await mkdtemp(path.join(tmpdir(), "novalure-evidence-freeze-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const inputDirectory = path.join(root, "inputs");
  const outputDirectory = path.join(root, "output");
  await Promise.all([mkdir(inputDirectory), mkdir(outputDirectory)]);
  const trustAnchorPath = path.join(root, "external-trust-anchor.json");
  await writeFile(trustAnchorPath, trustAnchorSource, { flag: "wx", mode: 0o400 });
  return { inputDirectory, outputDirectory, root, trustAnchorPath };
}

function lifecycleRetainedInventory(phase) {
  const tables = Object.fromEntries(a11yRetainedTableNames.map((name) => [
    name,
    {
      digest: gateSha256(`${name}-${phase}`),
      rowCount: phase === "before" ? 1 : 2,
    },
  ]));
  return {
    digest: gateSha256(canonicalJson(tables)),
    rowCount: Object.values(tables).reduce((sum, table) => sum + table.rowCount, 0),
    tables,
  };
}

function lifecycleEvidence(value, browserEvidenceSha256) {
  const cleanupScope = (label, count) => ({
    auditCount: 1,
    batchFingerprint: `sha256:${gateSha256(`${label}-batch`)}`,
    createdObjectCount: count,
    deletedObjectCount: count,
    executedCount: 1,
    ledgerCount: count,
    liveCascadeCount: 0,
    liveRegisteredCount: 0,
    unexpectedLedgerCount: 0,
  });
  return {
    browserEvidence: {
      fileName: "a11y-browser-matrix.json",
      sha256: browserEvidenceSha256,
      sidecarFileName: "a11y-browser-matrix.json.sha256",
      sidecarSha256: gateSha256("a11y-browser-sidecar"),
      sizeBytes: 4_096,
    },
    candidateCommit: value.candidateCommit,
    cleanup: {
      crossTenant: cleanupScope("cross-tenant", 0),
      primary: cleanupScope("primary", 3),
      remainingBatchObjectCount: 0,
      residualLiveObjectCount: 0,
      status: "PASS",
    },
    completedAt: "2026-08-25T20:30:00.000Z",
    database: {
      operationalAfter: { digest: "7".repeat(64), rowCount: 10 },
      operationalBefore: { digest: "7".repeat(64), rowCount: 10 },
      retainedAfter: lifecycleRetainedInventory("after"),
      retainedBefore: lifecycleRetainedInventory("before"),
      targetDigest: `sha256:${gateSha256("a11y-preview-database-target")}`,
    },
    deploymentHost: value.deploymentHost,
    deploymentId: value.deploymentId,
    gitBranch: value.branch,
    neonBranchId: value.databaseBranchId,
    neonProjectId: value.databaseProjectId,
    productionMutationPerformed: false,
    recordType: a11yFixtureLifecycleRecordType,
    runId: "a11y-run-12345678-1234-4123-8123-123456789012",
    schemaVersion: 1,
    status: "PASS",
  };
}

async function writePinnedCanonicalJson(directory, fileName, document) {
  const sourcePath = path.join(directory, fileName);
  const source = canonicalJson(document);
  const digest = gateSha256(source);
  const sidecarPath = `${sourcePath}.sha256`;
  await writeFile(sourcePath, source, { flag: "wx" });
  await writeFile(sidecarPath, `${digest}  ${fileName}\n`, { flag: "wx" });
  return { digest, sidecarPath, sourcePath };
}

async function accessibilityFixture(t) {
  const fixture = await commonFixtureRoot(t);
  const value = runtime();
  const source = a11yRawSource(value);
  const pinned = await writePinnedJson(fixture.inputDirectory, "a11y-browser-matrix.json", source);
  const individualEvidence = accessibilityRequiredManualCheckIds.map((checkId, index) => ({
    checkId,
    contexts: checkId === "public-form-and-funnel-submit-flow"
      ? ["public-form", "public-funnel"]
      : [`context ${index + 1} desktop mobile assistive technology`],
    languages: ["de", "en"],
    observations: accessibilityManualObservationIdsByCheck[checkId].map((id, observationIndex) => ({
      evidenceSha256: gateSha256(`${checkId}-${observationIndex}`),
      id,
      status: "PASS",
    })),
    recordType: accessibilityManualEvidenceRecordType,
    result: "PASS",
    runtime: receiptRuntime(value),
    schemaVersion: 1,
    testedAt: `2026-08-25T20:${String(index).padStart(2, "0")}:00.000Z`,
    testerSubject: "subject:novalure:accessibility-tester:freeze-test",
  }));
  const manualCheckDigests = individualEvidence.map((document) => ({
    id: document.checkId,
    sha256: gateSha256(canonicalJson(document)),
  }));
  const matrix = {
    approvals: accessibilityApprovalRoles.map((entry) => ({
      owner: null,
      role: entry.approvalRole,
      signature: null,
      signedAt: null,
      status: "READY_FOR_EXTERNAL_SIGNATURE",
    })),
    manualChecks: manualCheckDigests.map((entry) => ({
      evidence: {
        documentSha256: entry.sha256,
        recordType: accessibilityManualEvidenceRecordType,
        schemaVersion: 1,
      },
      id: entry.id,
      required: true,
      status: "PASS",
    })),
    schemaVersion: 2,
    standard: "WCAG 2.2 Level AA",
    status: "READY_FOR_EXTERNAL_SIGNATURE",
  };
  const automatedEvidence = automatedA11yProjection(source, pinned.digest);
  const fixtureLifecycle = lifecycleEvidence(value, pinned.digest);
  const lifecyclePinned = await writePinnedCanonicalJson(
    fixture.inputDirectory,
    a11yFixtureLifecycleFileName,
    fixtureLifecycle,
  );
  const approvalReceiptPaths = {};
  for (const expected of accessibilityApprovalRoles) {
    const receipt = externalReceipt(
      expected.receiptRole,
      expected.recordType,
      {
        approval: "APPROVED",
        approvalRole: expected.approvalRole,
        automatedEvidenceSha256: gateSha256(canonicalJson(automatedEvidence)),
        databaseProjectId: value.databaseProjectId,
        fixtureLifecycleSha256: lifecyclePinned.digest,
        individualEvidenceBundleSha256: gateSha256(canonicalJson(manualCheckDigests)),
        manualCheckDigests,
        matrixSha256: gateSha256(canonicalJson(matrix)),
        runtime: receiptRuntime(value),
      },
    );
    approvalReceiptPaths[expected.receiptRole] = await writeJson(
      path.join(fixture.inputDirectory, `${expected.receiptRole}-receipt.json`),
      receipt,
    );
  }
  const manualEvidencePaths = [];
  for (let index = 0; index < individualEvidence.length; index += 1) {
    manualEvidencePaths.push(await writeJson(
      path.join(fixture.inputDirectory, `a11y-manual-${index + 1}.json`),
      individualEvidence[index],
    ));
  }
  const matrixPath = await writeJson(path.join(fixture.inputDirectory, "a11y-matrix.json"), matrix);
  return {
    ...fixture,
    input: {
      approvalReceiptPaths,
      expectedSourceSha256: pinned.digest,
      expectedTrustAnchorSha256: trustAnchorSha256,
      kind: "accessibility",
      lifecyclePath: lifecyclePinned.sourcePath,
      lifecycleSidecarPath: lifecyclePinned.sidecarPath,
      manualEvidencePaths,
      matrixPath,
      outputDirectory: fixture.outputDirectory,
      runtime: value,
      schemaVersion: 1,
      sourcePath: pinned.sourcePath,
      sourceSidecarPath: pinned.sidecarPath,
      trustAnchorPath: fixture.trustAnchorPath,
    },
  };
}

async function performanceFixture(t) {
  const fixture = await commonFixtureRoot(t);
  const value = runtime();
  const performanceRuntime = { ...value };
  delete performanceRuntime.databaseProjectId;
  const source = performanceRawSource(value);
  const pinned = await writePinnedJson(fixture.inputDirectory, "lighthouse-preview-gate.json", source);
  const technicalEvidenceSha256 = buildPerformanceTechnicalEvidenceSha256(source);
  const budgetApprovalReceiptPaths = [];
  for (const expected of performanceBudgetApprovalRoles) {
    budgetApprovalReceiptPaths.push(await writeJson(
      path.join(fixture.inputDirectory, `performance-budget-${expected.approvalRole}-receipt.json`),
      externalReceipt(
        expected.receiptRole,
        performanceBudgetApprovalRecordType,
        {
          approval: "APPROVED",
          approvalRole: expected.approvalRole,
          budgetPolicySha256: gateSha256(canonicalJson(finalPerformanceBudgetPolicy)),
          runtime: receiptRuntime(value),
        },
      ),
    ));
  }
  const manualReceipt = externalReceipt(
    performanceManualAcceptanceRole,
    performanceManualAcceptanceRecordType,
    {
      artifactSha256: technicalEvidenceSha256,
      budgetPolicySha256: gateSha256(canonicalJson(finalPerformanceBudgetPolicy)),
      manualGates: performanceManualGateIds.map((id, index) => ({
        evidenceSha256: String((index % 8) + 1).repeat(64),
        id,
        status: "PASS",
      })),
      observationWindow: {
        completedAt: "2026-08-25T20:30:00.000Z",
        startedAt: "2026-08-25T20:00:00.000Z",
      },
      runtime: receiptRuntime(value),
    },
  );
  const rumReceipt = externalReceipt(
    performanceRumAcceptanceRole,
    performanceRumAcceptanceRecordType,
    {
      artifactSha256: technicalEvidenceSha256,
      budgetPolicySha256: gateSha256(canonicalJson(finalPerformanceBudgetPolicy)),
      metrics: {
        cumulativeLayoutShiftP75: 0.02,
        interactionToNextPaintP75Ms: 100,
        largestContentfulPaintP75Ms: 1_500,
      },
      observationWindow: {
        completedAt: "2026-08-25T20:30:00.000Z",
        startedAt: "2026-08-24T20:30:00.000Z",
      },
      providerIdentity: {
        datasetFingerprint: `sha256:${"e".repeat(64)}`,
        projectFingerprint: `sha256:${"f".repeat(64)}`,
        providerName: "VERCEL_SPEED_INSIGHTS",
      },
      runtime: receiptRuntime(value),
      sampleCount: 250,
    },
  );
  const manualReceiptPath = await writeJson(
    path.join(fixture.inputDirectory, "performance-manual-receipt.json"),
    manualReceipt,
  );
  const rumReceiptPath = await writeJson(
    path.join(fixture.inputDirectory, "performance-rum-receipt.json"),
    rumReceipt,
  );
  return {
    ...fixture,
    input: {
      budgetApprovalReceiptPaths,
      expectedSourceSha256: pinned.digest,
      expectedTrustAnchorSha256: trustAnchorSha256,
      kind: "performance",
      manualReceiptPath,
      outputDirectory: fixture.outputDirectory,
      rumReceiptPath,
      runtime: performanceRuntime,
      schemaVersion: 1,
      sourcePath: pinned.sourcePath,
      sourceSidecarPath: pinned.sidecarPath,
      trustAnchorPath: fixture.trustAnchorPath,
    },
  };
}

test("accessibility freeze projects technical evidence and verifies all eight signed manual checks", async (t) => {
  const fixture = await accessibilityFixture(t);
  const result = runAssembler(fixture.input);
  assert.equal(result.status, 0, result.stderr);
  const outputPath = path.join(fixture.outputDirectory, "accessibility-browser.json");
  const output = JSON.parse(await readFile(outputPath, "utf8"));
  assert.equal(output.manualAcceptance.individualEvidence.length, 8);
  assert.equal(output.acceptance.manualPassCount, 8);
  assert.equal(output.acceptance.signatureCount, 3);
  assert.deepEqual(
    Object.keys(output.manualAcceptance.approvalReceipts).sort(),
    accessibilityApprovalRoles.map((entry) => entry.receiptRole).sort(),
  );
  assert.equal(
    output.manualAcceptance.fixtureLifecycle.browserEvidence.sha256,
    fixture.input.expectedSourceSha256,
  );
  assert.equal(output.releasePassed, true);
  assert.equal(
    observedFinalPreviewGateStatus(
      gateBinding("accessibility-browser"),
      output,
      fixture.input.runtime,
      { trustContext },
    ),
    "PASS",
  );
  const bytes = await readFile(outputPath);
  assert.equal(
    await readFile(`${outputPath}.sha256`, "utf8"),
    `${createHash("sha256").update(bytes).digest("hex")}  accessibility-browser.json\n`,
  );
});

test("accessibility freeze rejects missing, role-swapped or incomplete approval inventories", async (t) => {
  const missing = await accessibilityFixture(t);
  delete missing.input.approvalReceiptPaths[accessibilityApprovalRoles[2].receiptRole];
  let result = runAssembler(missing.input);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /ACCESSIBILITY_APPROVAL_RECEIPT_PATHS_KEYS_INVALID/u);

  const swapped = await accessibilityFixture(t);
  [
    swapped.input.approvalReceiptPaths[accessibilityApprovalRoles[0].receiptRole],
    swapped.input.approvalReceiptPaths[accessibilityApprovalRoles[1].receiptRole],
  ] = [
    swapped.input.approvalReceiptPaths[accessibilityApprovalRoles[1].receiptRole],
    swapped.input.approvalReceiptPaths[accessibilityApprovalRoles[0].receiptRole],
  ];
  result = runAssembler(swapped.input);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /EXTERNAL_GATE_RECEIPT_(?:TYPE|ROLE)_MISMATCH/u);
});

test("accessibility freeze rejects a green browser artifact without post-cleanup lifecycle evidence", async (t) => {
  const fixture = await accessibilityFixture(t);
  fixture.input.lifecyclePath = path.join(fixture.inputDirectory, "missing-lifecycle.json");
  fixture.input.lifecycleSidecarPath = `${fixture.input.lifecyclePath}.sha256`;
  const result = runAssembler(fixture.input);
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /FINAL_PREVIEW_EVIDENCE_ACCESSIBILITY_LIFECYCLE(?:_SIDECAR)?_UNAVAILABLE/u,
  );
  await assert.rejects(
    readFile(path.join(fixture.outputDirectory, "accessibility-browser.json")),
    { code: "ENOENT" },
  );
});

test("accessibility freeze rejects incomplete public submit observations before signature projection", async (t) => {
  const fixture = await accessibilityFixture(t);
  const lastPath = fixture.input.manualEvidencePaths.at(-1);
  const document = JSON.parse(await readFile(lastPath, "utf8"));
  document.observations.pop();
  const incompletePath = path.join(fixture.inputDirectory, "a11y-manual-submit-incomplete.json");
  await writeJson(incompletePath, document);
  fixture.input.manualEvidencePaths[fixture.input.manualEvidencePaths.length - 1] = incompletePath;
  const result = runAssembler(fixture.input);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /ACCESSIBILITY_MANUAL_OBSERVATION_INVENTORY_INVALID/u);
});

test("performance freeze derives PASS only from receipts bound to the exact technical evidence", async (t) => {
  const fixture = await performanceFixture(t);
  const result = runAssembler(fixture.input);
  assert.equal(result.status, 0, result.stderr);
  const outputPath = path.join(fixture.outputDirectory, "performance.json");
  const output = JSON.parse(await readFile(outputPath, "utf8"));
  assert.equal(output.budgetApprovalStatus, "SIGNED");
  assert.deepEqual(
    Object.keys(output.budgetApprovalReceipts),
    performanceBudgetApprovalRoles.map((entry) => entry.approvalRole).sort(),
  );
  assert.equal(output.signaturesPresent, true);
  assert.equal(output.technicalEvidenceSha256, buildPerformanceTechnicalEvidenceSha256(output));
  assert.deepEqual(output.manualGates, {
    mobileAssistiveTechnology: "PASS",
    screenReader: "PASS",
    zoomAndReflow: "PASS",
  });
  assert.equal(
    observedFinalPreviewGateStatus(
      gateBinding("performance"),
      output,
      fixture.input.runtime,
      { trustContext },
    ),
    "PASS",
  );
});

test("performance freeze rejects a missing or role-swapped budget approval", async (t) => {
  const missing = await performanceFixture(t);
  missing.input.budgetApprovalReceiptPaths.pop();
  let result = runAssembler(missing.input);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /FINAL_PREVIEW_EVIDENCE_PERFORMANCE_BUDGET_APPROVAL_PATHS_INVALID/u);

  const swapped = await performanceFixture(t);
  swapped.input.outputDirectory = path.join(swapped.root, "role-swapped-output");
  await mkdir(swapped.input.outputDirectory);
  [swapped.input.budgetApprovalReceiptPaths[0], swapped.input.budgetApprovalReceiptPaths[1]] = [
    swapped.input.budgetApprovalReceiptPaths[1],
    swapped.input.budgetApprovalReceiptPaths[0],
  ];
  result = runAssembler(swapped.input);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /EXTERNAL_GATE_RECEIPT_ROLE_MISMATCH/u);
});

test("freeze rejects an independently wrong source digest before parsing evidence", async (t) => {
  const fixture = await accessibilityFixture(t);
  fixture.input.outputDirectory = path.join(fixture.root, "wrong-digest-output");
  await mkdir(fixture.input.outputDirectory);
  fixture.input.expectedSourceSha256 = "0".repeat(64);
  const result = runAssembler(fixture.input);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /FINAL_PREVIEW_EVIDENCE_SOURCE_DIGEST_MISMATCH/u);
});

test("freeze rejects a source sidecar whose digest is not the pinned source digest", async (t) => {
  const fixture = await performanceFixture(t);
  const falseSidecarPath = path.join(fixture.inputDirectory, "false-source.sha256");
  await writeFile(
    falseSidecarPath,
    `${"0".repeat(64)}  ${path.basename(fixture.input.sourcePath)}\n`,
    { flag: "wx" },
  );
  fixture.input.sourceSidecarPath = falseSidecarPath;
  const result = runAssembler(fixture.input);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /FINAL_PREVIEW_EVIDENCE_SOURCE_SIDECAR_DIGEST_MISMATCH/u);
});

test("freeze rejects signed-receipt tampering and writes no PASS artifact", async (t) => {
  const fixture = await performanceFixture(t);
  const receipt = JSON.parse(await readFile(fixture.input.rumReceiptPath, "utf8"));
  receipt.payload.sampleCount += 1;
  const tamperedPath = path.join(fixture.inputDirectory, "tampered-rum-receipt.json");
  await writeJson(tamperedPath, receipt);
  fixture.input.rumReceiptPath = tamperedPath;
  const result = runAssembler(fixture.input);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /EXTERNAL_GATE_RECEIPT_PAYLOAD_DIGEST_MISMATCH/u);
  await assert.rejects(readFile(path.join(fixture.outputDirectory, "performance.json")), { code: "ENOENT" });
});

test("freeze rejects a wrong external trust-anchor raw digest", async (t) => {
  const fixture = await accessibilityFixture(t);
  fixture.input.expectedTrustAnchorSha256 = "f".repeat(64);
  const result = runAssembler(fixture.input);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /FINAL_PREVIEW_EVIDENCE_TRUST_ANCHOR_DIGEST_MISMATCH/u);
});

test("freeze accepts no artifact input through CLI arguments", async (t) => {
  const fixture = await performanceFixture(t);
  const result = runAssembler(fixture.input, ["--source", fixture.input.sourcePath]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /FINAL_PREVIEW_EVIDENCE_ARGUMENTS_PROHIBITED/u);
});

test("freeze rejects symlinked evidence inputs", async (t) => {
  const fixture = await accessibilityFixture(t);
  const symlinkPath = path.join(fixture.inputDirectory, "manual-symlink.json");
  let linkedInputPath = symlinkPath;
  try {
    await symlink(fixture.input.manualEvidencePaths[0], symlinkPath, "file");
  } catch (error) {
    if (["EPERM", "EACCES", "UNKNOWN"].includes(error?.code)) {
      const junctionPath = path.join(fixture.root, "input-junction");
      try {
        await symlink(fixture.inputDirectory, junctionPath, "junction");
      } catch (junctionError) {
        if (["EPERM", "EACCES", "UNKNOWN"].includes(junctionError?.code)) {
          t.skip("This platform does not permit creating a symlink or junction for the contract test.");
          return;
        }
        throw junctionError;
      }
      linkedInputPath = path.join(
        junctionPath,
        path.basename(fixture.input.manualEvidencePaths[0]),
      );
    } else {
      throw error;
    }
  }
  fixture.input.manualEvidencePaths[0] = linkedInputPath;
  const result = runAssembler(fixture.input);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /NOT_BOUNDED_REGULAR_FILE/u);
});

test("freeze uses exclusive outputs and preserves an already frozen artifact", async (t) => {
  const fixture = await performanceFixture(t);
  const first = runAssembler(fixture.input);
  assert.equal(first.status, 0, first.stderr);
  const outputPath = path.join(fixture.outputDirectory, "performance.json");
  const sidecarPath = `${outputPath}.sha256`;
  const [before, sidecarBefore] = await Promise.all([readFile(outputPath), readFile(sidecarPath)]);
  const second = runAssembler(fixture.input);
  assert.equal(second.status, 1);
  assert.match(second.stderr, /FINAL_PREVIEW_EVIDENCE_OUTPUT_EXISTS/u);
  const [after, sidecarAfter] = await Promise.all([readFile(outputPath), readFile(sidecarPath)]);
  assert.deepEqual(after, before);
  assert.deepEqual(sidecarAfter, sidecarBefore);
});
