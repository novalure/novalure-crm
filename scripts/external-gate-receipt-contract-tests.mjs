import assert from "node:assert/strict";
import {
  generateKeyPairSync,
  sign as createDetachedSignature,
} from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { tmpdir } from "node:os";

import {
  accessibilityApprovalRoles,
  accessibilityManualObservationIdsByCheck,
  accessibilityRequiredManualCheckIds,
  validateAccessibilityApprovalReceipts,
} from "./lib/accessibility-manual-acceptance-receipt.mjs";
import {
  a11yFixtureLifecycleRecordType,
  a11yRetainedTableNames,
} from "./lib/a11y-fixture-lifecycle-evidence.mjs";
import {
  companyProfileApprovalRecordType,
  companyProfileSnapshotRecordType,
  validateCompanyProfileApprovalReceipt,
} from "./lib/company-profile-approval-receipt.mjs";
import {
  buildExternalGateReceiptSigningPayload,
  canonicalJson,
  externalGateReceiptRoles,
  externalGateTrustAnchorRecordType,
  loadExternalGateTrustContext,
  sha256,
  validateExternalGateTrustContext,
  verifyExternalGateReceipt,
} from "./lib/external-gate-receipts.mjs";
import {
  canonicalJson as runtimeCanonicalJson,
  externalGateReceiptRoles as runtimeExternalGateReceiptRoles,
  verifyExternalGateReceipt as verifyRuntimeExternalGateReceipt,
} from "./lib/external-gate-receipts-runtime.mjs";
import {
  operationalGateSpecifications,
  validateOperationalGateReceipt,
  validateOperationalGateReceipts,
} from "./lib/operational-gate-receipts.mjs";
import {
  githubArtifactAttestationCliPins,
  protectedWorkflowArtifactManifestRecordType,
  protectedWorkflowEvidenceFiles,
  protectedWorkflowProvenanceRecordType,
  validateProtectedWorkflowArtifactTar,
  validateProtectedWorkflowProvenanceReceipt,
  validateVerifiedGitHubAttestationOutput,
  withIdentityCheckedExecutableCopy,
} from "./lib/protected-workflow-provenance-receipt.mjs";

const runtime = Object.freeze({
  candidateCommit: "a".repeat(40),
  databaseBranchId: "br-lucky-heart-alrm9dlw",
  deploymentHost: "candidate-preview-novalure.vercel.app",
  deploymentId: "dpl_12345678901234567890",
  gitBranch: "codex/go-live-remediation-20260822",
  productionMutationPerformed: false,
});
const databaseProjectId = "weathered-term-98273025";

const keyRoles = [...externalGateReceiptRoles, "product"];
const keys = Object.fromEntries(keyRoles.map((role) => {
  const pair = generateKeyPairSync("ed25519");
  return [role, {
    keyId: `key_${role.replaceAll("-", "_")}_20260823`,
    privateKey: pair.privateKey,
    publicKeyPem: pair.publicKey.export({ format: "pem", type: "spki" }),
    signerSubject: `subject:novalure:${role}:20260823`,
  }];
}));

const anchor = Object.freeze({
  keys: keyRoles.map((role) => Object.freeze({
    algorithm: "Ed25519",
    keyId: keys[role].keyId,
    publicKeyPem: keys[role].publicKeyPem,
    role,
    signerSubject: keys[role].signerSubject,
    status: "ACTIVE",
  })),
  recordType: externalGateTrustAnchorRecordType,
  schemaVersion: 1,
  trustAnchorId: "ta_novalure_gate_receipts_20260823",
});
const anchorSource = canonicalJson(anchor);
const anchorDigest = sha256(anchorSource);
const trustContext = Object.freeze({ anchor, expectedSha256: anchorDigest });

function buildReceipt({
  payload,
  recordType,
  role,
  signedAt = "2026-08-23T22:00:00.000Z",
  signingRole = role,
}) {
  const trustedKey = keys[role];
  const payloadSha256 = sha256(canonicalJson(payload));
  const receipt = {
    detachedSignature: null,
    keyId: trustedKey.keyId,
    payload,
    payloadSha256,
    receiptId: `grc_${sha256(`${recordType}\0${role}\0${payloadSha256}`).slice(0, 32)}`,
    recordType,
    role,
    schemaVersion: 1,
    signatureAlgorithm: "Ed25519",
    signatureReference: [
      "urn:novalure:gate-receipt:v1",
      anchor.trustAnchorId,
      trustedKey.keyId,
      role,
      recordType,
      payloadSha256,
    ].join(":"),
    signedAt,
    signerSubject: trustedKey.signerSubject,
    trustAnchorId: anchor.trustAnchorId,
    trustAnchorSha256: anchorDigest,
  };
  receipt.detachedSignature = createDetachedSignature(
    null,
    Buffer.from(buildExternalGateReceiptSigningPayload(receipt), "utf8"),
    keys[signingRole].privateKey,
  ).toString("base64");
  return receipt;
}

function accessibilityFixture() {
  const individualEvidence = accessibilityRequiredManualCheckIds.map((checkId, index) => ({
    checkId,
    contexts: checkId === "public-form-and-funnel-submit-flow"
      ? ["public-form", "public-funnel"]
      : [`context ${index + 1} desktop mobile assistive technology`],
    languages: ["de", "en"],
    observations: accessibilityManualObservationIdsByCheck[checkId].map((id, observationIndex) => ({
      evidenceSha256: sha256(`accessibility-observation-${index}-${observationIndex}`),
      id,
      status: "PASS",
    })),
    recordType: "NOVALURE_ACCESSIBILITY_MANUAL_CHECK_EVIDENCE",
    result: "PASS",
    runtime: { ...runtime },
    schemaVersion: 1,
    testedAt: `2026-08-23T21:${String(index).padStart(2, "0")}:00.000Z`,
    testerSubject: "subject:novalure:accessibility-tester:20260823",
  }));
  const manualCheckDigests = individualEvidence.map((document) => ({
    id: document.checkId,
    sha256: sha256(canonicalJson(document)),
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
        recordType: "NOVALURE_ACCESSIBILITY_MANUAL_CHECK_EVIDENCE",
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
  const automatedEvidence = {
    automatedSourceSha256: sha256("accessibility-browser-source"),
    automatedSubsetPassed: true,
    automatedTechnicalPassed: true,
    browser: "chromium",
    cleanup: { browserClosed: true, complete: true, sessionLogoutFailures: 0 },
    coverage: { complete: true },
    endedAt: "2026-08-23T21:30:00.000Z",
    evidenceDigest: sha256("accessibility-automated-evidence"),
    executionBlocker: null,
    executionScope: { publicAndCrmBusinessData: "HTTP_WRITE_GUARD_ENFORCED" },
    expectedSha: runtime.candidateCommit,
    generatedAt: "2026-08-23T21:30:00.000Z",
    matrix: { failed: 0, passed: 1 },
    mode: "RELEASE_GATE",
    productionMutationPerformed: false,
    releaseSurfaceManifestVerified: true,
    results: [{ outcome: "PASS" }],
    runtimeIdentity: { attestationComplete: true },
    schemaVersion: 4,
    startedAt: "2026-08-23T20:30:00.000Z",
    targetHost: runtime.deploymentHost,
    unsafeHttpWriteGuard: { complete: true },
    wcagStandard: "WCAG 2.2 AA automated subset plus signed manual acceptance",
  };
  const retainedInventory = (phase) => {
    const tables = Object.fromEntries(a11yRetainedTableNames.map((name) => [name, {
      digest: sha256(`${name}-${phase}`),
      rowCount: phase === "before" ? 1 : 2,
    }]));
    return {
      digest: sha256(canonicalJson(tables)),
      rowCount: Object.values(tables).reduce((sum, table) => sum + table.rowCount, 0),
      tables,
    };
  };
  const cleanupScope = (label, count) => ({
    auditCount: 1,
    batchFingerprint: `sha256:${sha256(`${label}-batch`)}`,
    createdObjectCount: count,
    deletedObjectCount: count,
    executedCount: 1,
    ledgerCount: count,
    liveCascadeCount: 0,
    liveRegisteredCount: 0,
    unexpectedLedgerCount: 0,
  });
  const fixtureLifecycle = {
    browserEvidence: {
      fileName: "a11y-browser-matrix.json",
      sha256: automatedEvidence.automatedSourceSha256,
      sidecarFileName: "a11y-browser-matrix.json.sha256",
      sidecarSha256: sha256("accessibility-browser-sidecar"),
      sizeBytes: 4_096,
    },
    candidateCommit: runtime.candidateCommit,
    cleanup: {
      crossTenant: cleanupScope("cross-tenant", 0),
      primary: cleanupScope("primary", 3),
      remainingBatchObjectCount: 0,
      residualLiveObjectCount: 0,
      status: "PASS",
    },
    completedAt: "2026-08-23T21:30:00.000Z",
    database: {
      operationalAfter: { digest: "7".repeat(64), rowCount: 10 },
      operationalBefore: { digest: "7".repeat(64), rowCount: 10 },
      retainedAfter: retainedInventory("after"),
      retainedBefore: retainedInventory("before"),
      targetDigest: `sha256:${sha256("preview-database-target")}`,
    },
    deploymentHost: runtime.deploymentHost,
    deploymentId: runtime.deploymentId,
    gitBranch: runtime.gitBranch,
    neonBranchId: runtime.databaseBranchId,
    neonProjectId: databaseProjectId,
    productionMutationPerformed: false,
    recordType: a11yFixtureLifecycleRecordType,
    runId: "a11y-run-12345678-1234-4123-8123-123456789012",
    schemaVersion: 1,
    status: "PASS",
  };
  const fixtureLifecycleSha256 = sha256(canonicalJson(fixtureLifecycle));
  const payloadBase = {
    automatedEvidenceSha256: sha256(canonicalJson(automatedEvidence)),
    databaseProjectId,
    fixtureLifecycleSha256,
    individualEvidenceBundleSha256: sha256(canonicalJson(manualCheckDigests)),
    manualCheckDigests,
    matrixSha256: sha256(canonicalJson(matrix)),
    runtime: { ...runtime },
  };
  return {
    automatedEvidence,
    databaseProjectId,
    expectedAutomatedEvidence: structuredClone(automatedEvidence),
    fixtureLifecycle,
    fixtureLifecycleSha256,
    individualEvidence,
    matrix,
    payloadBase,
  };
}

function accessibilityApprovalReceipts(fixture) {
  return Object.fromEntries(accessibilityApprovalRoles.map((expected) => [
    expected.receiptRole,
    buildReceipt({
      payload: {
        approval: "APPROVED",
        approvalRole: expected.approvalRole,
        ...fixture.payloadBase,
      },
      recordType: expected.recordType,
      role: expected.receiptRole,
    }),
  ]));
}

function writeTarText(header, offset, length, value) {
  const encoded = Buffer.from(value, "ascii");
  assert.ok(encoded.length < length);
  encoded.copy(header, offset);
}

function writeTarOctal(header, offset, length, value) {
  const encoded = `${value.toString(8).padStart(length - 1, "0")}\0`;
  assert.equal(encoded.length, length);
  header.write(encoded, offset, length, "ascii");
}

function buildUstarArtifact(entries) {
  const blocks = [];
  for (const entry of [...entries].sort((left, right) => left.name.localeCompare(right.name))) {
    const contents = Buffer.from(entry.contents);
    const header = Buffer.alloc(512);
    writeTarText(header, 0, 100, entry.name);
    writeTarOctal(header, 100, 8, 0o400);
    writeTarOctal(header, 108, 8, 0);
    writeTarOctal(header, 116, 8, 0);
    writeTarOctal(header, 124, 12, contents.length);
    writeTarOctal(header, 136, 12, 0);
    header.fill(0x20, 148, 156);
    header[156] = 0x30;
    header.write("ustar\0", 257, 6, "ascii");
    header.write("00", 263, 2, "ascii");
    writeTarOctal(header, 329, 8, 0);
    writeTarOctal(header, 337, 8, 0);
    const checksum = header.reduce((sum, value) => sum + value, 0);
    header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
    blocks.push(header, contents);
    const remainder = contents.length % 512;
    if (remainder !== 0) blocks.push(Buffer.alloc(512 - remainder));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

function workflowFixture() {
  const artifactEntries = protectedWorkflowEvidenceFiles.map((name, index) => ({
    contents: Buffer.from(`protected-workflow-file-${index}`, "utf8"),
    name,
  }));
  const artifactBytes = buildUstarArtifact(artifactEntries);
  const artifactDigest = sha256(artifactBytes);
  const artifactManifest = {
    artifactDigest,
    artifactName: `exact-preview-two-tenant-${runtime.candidateCommit}.tar`,
    files: artifactEntries.map(({ contents, name }) => ({
      name,
      sha256: sha256(contents),
      sizeBytes: contents.length,
    })),
    recordType: protectedWorkflowArtifactManifestRecordType,
    schemaVersion: 1,
  };
  const repository = "novalure/novalure-crm";
  const workflowRef = `${repository}/.github/workflows/livegang-e2e.yml@refs/heads/main`;
  const workflowSha = "b".repeat(40);
  const workflowUri = `https://github.com/${workflowRef}`;
  const attestationBundle = {
    dsseEnvelope: { payload: "synthetic-contract-fixture" },
    mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json",
  };
  const certificate = {
    buildConfigDigest: workflowSha,
    buildConfigURI: workflowUri,
    buildSignerDigest: workflowSha,
    buildSignerURI: workflowUri,
    buildTrigger: "workflow_dispatch",
    githubWorkflowRef: "refs/heads/main",
    githubWorkflowRepository: repository,
    githubWorkflowSHA: workflowSha,
    githubWorkflowTrigger: "workflow_dispatch",
    issuer: "https://token.actions.githubusercontent.com",
    runInvocationURI: `https://github.com/${repository}/actions/runs/123456789012/attempts/2`,
    runnerEnvironment: "github-hosted",
    sourceRepositoryDigest: workflowSha,
    sourceRepositoryIdentifier: "123456789",
    sourceRepositoryOwnerIdentifier: "987654321",
    sourceRepositoryOwnerURI: "https://github.com/novalure",
    sourceRepositoryRef: "refs/heads/main",
    sourceRepositoryURI: `https://github.com/${repository}`,
    sourceRepositoryVisibilityAtSigning: "private",
    subjectAlternativeName: workflowUri,
  };
  const statement = {
    _type: "https://in-toto.io/Statement/v1",
    predicate: { buildDefinition: { buildType: "https://actions.github.io/buildtypes/workflow/v1" } },
    predicateType: "https://slsa.dev/provenance/v1",
    subject: [{ digest: { sha256: artifactDigest }, name: artifactManifest.artifactName }],
  };
  const verificationOutput = [{
    attestation: { bundle: attestationBundle },
    verificationResult: {
      mediaType: "application/vnd.dev.sigstore.verificationresult+json;version=0.1",
      signature: { certificate },
      statement,
      verifiedIdentity: {
        issuer: { issuer: certificate.issuer },
        subjectAlternativeName: { subjectAlternativeName: certificate.subjectAlternativeName },
      },
      verifiedTimestamps: [{
        timestamp: "2026-08-23T21:30:00.000Z",
        type: "Tlog",
        uri: "https://tlog.github.example/contract-fixture",
      }],
    },
  }];
  const githubCliPlatform = "linux-x64";
  const githubCliSha256 = githubArtifactAttestationCliPins[githubCliPlatform].executableSha256;
  const verifiedClaims = validateVerifiedGitHubAttestationOutput({
    artifactDigest,
    artifactManifestSha256: sha256(canonicalJson(artifactManifest)),
    artifactName: artifactManifest.artifactName,
    attestationBundle,
    attestationBundleSha256: sha256(canonicalJson(attestationBundle)),
    expectedWorkflowRef: workflowRef,
    expectedWorkflowSha: workflowSha,
    githubCliPlatform,
    githubCliSha256,
    sigstoreTrustedRootSha256: sha256("pinned-github-sigstore-trusted-root"),
    verificationOutput,
  });
  const payload = {
    ...verifiedClaims,
    runtime: { ...runtime },
  };
  return {
    artifactBytes,
    artifactDigest,
    artifactManifest,
    attestationBundle,
    payload,
    verificationOutput,
    verifiedClaims,
    workflowRef,
    workflowSha,
  };
}

function operationalPayload(gateId) {
  const specification = operationalGateSpecifications[gateId];
  const window = {
    endedAt: "2026-08-23T21:45:00.000Z",
    startedAt: "2026-08-23T21:15:00.000Z",
  };
  return {
    gateId,
    observations: specification.observationIds.map((id, index) => ({
      evidenceSha256: sha256(`${gateId}-evidence-${index}`),
      id,
      observedAt: `2026-08-23T21:${String(16 + index).padStart(2, "0")}:00.000Z`,
      sourceRecordIdSha256: sha256(`${gateId}-source-${index}`),
      status: "PASS",
    })),
    runtime: { ...runtime },
    source: {
      artifactSha256: sha256(`${gateId}-artifact`),
      provider: specification.provider,
      runAttempt: 1,
      runId: `${gateId.replaceAll("-", "_")}-20260823`,
      runUrlSha256: sha256(`${gateId}-run-url`),
      sourceType: specification.sourceType,
    },
    window,
  };
}

function companyProfileFixture() {
  const profileSnapshot = {
    approval: {
      approvedAt: "2026-08-23T21:40:00.000Z",
      approverSubject: keys["company-profile-approver"].signerSubject,
      status: "APPROVED",
    },
    audit: {
      eventIdSha256: sha256("company-profile-audit-event-id"),
      eventSha256: sha256("company-profile-audit-event"),
      eventType: "COMPANY_PROFILE_APPROVED_LOCKED",
      occurredAt: "2026-08-23T21:40:00.000Z",
      previousVersion: 6,
      profileVersion: 7,
    },
    contentSha256: sha256("approved-company-profile-content"),
    countryCode: "AT",
    locked: true,
    profileIdSha256: sha256("company-profile-id"),
    profileVersion: 7,
    recordType: companyProfileSnapshotRecordType,
    runtime: { ...runtime },
    schemaVersion: 1,
    validation: {
      countryPreflight: "PASS",
      missingRequiredFields: 0,
      requiredFields: "PASS",
    },
    workspaceIdSha256: sha256("company-profile-workspace-id"),
  };
  const payload = {
    approvalStatus: "APPROVED",
    approvedAt: profileSnapshot.approval.approvedAt,
    auditEventSha256: profileSnapshot.audit.eventSha256,
    locked: true,
    profileSnapshotSha256: sha256(canonicalJson(profileSnapshot)),
    profileVersion: profileSnapshot.profileVersion,
    runtime: { ...runtime },
    workspaceIdSha256: profileSnapshot.workspaceIdSha256,
  };
  return { payload, profileSnapshot };
}

test("external trust context accepts a role union and the loader requires an exact out-of-repository digest", async () => {
  assert.deepEqual(runtimeExternalGateReceiptRoles, externalGateReceiptRoles);
  assert.equal(runtimeCanonicalJson(anchor), canonicalJson(anchor));
  const runtimeSource = readFileSync(
    new URL("./lib/external-gate-receipts-runtime.mjs", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(runtimeSource, /node:fs|node:child_process|\bfetch\s*\(/u);
  assert.doesNotThrow(() => validateExternalGateTrustContext(trustContext, {
    requiredRoles: externalGateReceiptRoles,
  }));
  const directory = await mkdtemp(path.join(tmpdir(), "novalure-gate-anchor-"));
  const anchorPath = path.join(directory, "anchor.json");
  await writeFile(anchorPath, anchorSource, "utf8");
  const loaded = await loadExternalGateTrustContext({
    anchorPath,
    expectedSha256: anchorDigest,
    repositoryRoot: process.cwd(),
    requiredRoles: externalGateReceiptRoles,
  });
  assert.equal(loaded.anchor.trustAnchorId, anchor.trustAnchorId);
  await assert.rejects(
    loadExternalGateTrustContext({
      anchorPath,
      expectedSha256: "f".repeat(64),
      repositoryRoot: process.cwd(),
      requiredRoles: ["accessibility-owner"],
    }),
    /EXTERNAL_GATE_TRUST_ANCHOR_DIGEST_MISMATCH/u,
  );
  const nonCanonicalSource = JSON.stringify(anchor);
  const nonCanonicalPath = path.join(directory, "anchor-pretty.json");
  await writeFile(nonCanonicalPath, nonCanonicalSource, "utf8");
  await assert.rejects(
    loadExternalGateTrustContext({
      anchorPath: nonCanonicalPath,
      expectedSha256: sha256(nonCanonicalSource),
      repositoryRoot: process.cwd(),
      requiredRoles: externalGateReceiptRoles,
    }),
    /EXTERNAL_GATE_TRUST_ANCHOR_NOT_CANONICAL/u,
  );
});

test("detached receipts reject self-assertion, wrong keys, sparse content and payload tampering", () => {
  const recordType = "NOVALURE_TEST_EXTERNAL_GATE_RECEIPT";
  const receipt = buildReceipt({
    payload: { result: "PASS" },
    recordType,
    role: "accessibility-owner",
  });
  assert.doesNotThrow(() => verifyExternalGateReceipt({
    expectedRecordType: recordType,
    expectedRole: "accessibility-owner",
    receipt,
    trustContext,
  }));
  assert.doesNotThrow(() => verifyRuntimeExternalGateReceipt({
    expectedRecordType: recordType,
    expectedRole: "accessibility-owner",
    receipt,
    trustContext,
  }));
  assert.throws(() => verifyExternalGateReceipt({
    expectedRecordType: recordType,
    expectedRole: "accessibility-owner",
    receipt,
    trustContext: null,
  }), /EXTERNAL_GATE_TRUST_CONTEXT_REQUIRED/u);

  const wrongKey = buildReceipt({
    payload: { result: "PASS" },
    recordType,
    role: "accessibility-owner",
    signingRole: "github-actions-attestor",
  });
  assert.throws(() => verifyExternalGateReceipt({
    expectedRecordType: recordType,
    expectedRole: "accessibility-owner",
    receipt: wrongKey,
    trustContext,
  }), /EXTERNAL_GATE_RECEIPT_SIGNATURE_VERIFICATION_FAILED/u);

  const impossibleCalendarDate = buildReceipt({
    payload: { result: "PASS" },
    recordType,
    role: "accessibility-owner",
    signedAt: "2026-02-31T00:00:00.000Z",
  });
  assert.throws(() => verifyExternalGateReceipt({
    expectedRecordType: recordType,
    expectedRole: "accessibility-owner",
    receipt: impossibleCalendarDate,
    trustContext,
  }), /EXTERNAL_GATE_RECEIPT_SIGNED_AT_INVALID/u);

  const sparse = structuredClone(receipt);
  delete sparse.payloadSha256;
  assert.throws(() => verifyExternalGateReceipt({
    expectedRecordType: recordType,
    expectedRole: "accessibility-owner",
    receipt: sparse,
    trustContext,
  }), /EXTERNAL_GATE_RECEIPT_KEYS_INVALID/u);

  const tampered = structuredClone(receipt);
  tampered.payload.result = "FAIL";
  assert.throws(() => verifyExternalGateReceipt({
    expectedRecordType: recordType,
    expectedRole: "accessibility-owner",
    receipt: tampered,
    trustContext,
  }), /EXTERNAL_GATE_RECEIPT_PAYLOAD_DIGEST_MISMATCH/u);
});

test("accessibility requires exact manual inventories and three independently signed approvals", () => {
  const expectedPublicSubmitInventory = ["form", "funnel"].flatMap((surface) =>
    ["de", "en"].flatMap((language) =>
      ["desktop", "mobile", "reflow-400"].flatMap((profile) =>
        ["validation", "success"].map(
          (state) => `public-submit.${surface}.${language}.${profile}.${state}`,
        ))));
  assert.deepEqual(
    accessibilityManualObservationIdsByCheck["public-form-and-funnel-submit-flow"],
    expectedPublicSubmitInventory,
  );
  assert.equal(expectedPublicSubmitInventory.length, 24);
  const fixture = accessibilityFixture();
  const approvalReceipts = accessibilityApprovalReceipts(fixture);
  const result = validateAccessibilityApprovalReceipts({
    ...fixture,
    approvalReceipts,
    runtime,
    trustContext,
  });
  assert.equal(result.status, "VERIFIED");
  assert.equal(result.manualCheckCount, accessibilityRequiredManualCheckIds.length);
  assert.equal(result.signatureCount, accessibilityApprovalRoles.length);

  assert.throws(() => validateAccessibilityApprovalReceipts({
    ...fixture,
    approvalReceipts,
    runtime,
    trustContext: null,
  }), /EXTERNAL_GATE_TRUST_CONTEXT_REQUIRED/u);

  const tamperedEvidence = structuredClone(fixture.individualEvidence);
  tamperedEvidence[0].observations[0].evidenceSha256 = "f".repeat(64);
  assert.throws(() => validateAccessibilityApprovalReceipts({
    ...fixture,
    approvalReceipts,
    individualEvidence: tamperedEvidence,
    runtime,
    trustContext,
  }), /ACCESSIBILITY_MATRIX_MANUAL_EVIDENCE_DIGEST_MISMATCH/u);

  const sparsePayload = structuredClone(fixture.payloadBase);
  sparsePayload.manualCheckDigests.pop();
  const firstRole = accessibilityApprovalRoles[0];
  const sparseReceipts = structuredClone(approvalReceipts);
  sparseReceipts[firstRole.receiptRole] = buildReceipt({
    payload: {
      approval: "APPROVED",
      approvalRole: firstRole.approvalRole,
      ...sparsePayload,
    },
    recordType: firstRole.recordType,
    role: firstRole.receiptRole,
  });
  assert.throws(() => validateAccessibilityApprovalReceipts({
    ...fixture,
    approvalReceipts: sparseReceipts,
    runtime,
    trustContext,
  }), /ACCESSIBILITY_APPROVAL_CHECK_DIGESTS_MISMATCH/u);

  const missingRole = structuredClone(approvalReceipts);
  delete missingRole[accessibilityApprovalRoles[2].receiptRole];
  assert.throws(() => validateAccessibilityApprovalReceipts({
    ...fixture,
    approvalReceipts: missingRole,
    runtime,
    trustContext,
  }), /ACCESSIBILITY_APPROVAL_RECEIPTS_KEYS_INVALID/u);

  const swappedRoles = structuredClone(approvalReceipts);
  [
    swappedRoles[accessibilityApprovalRoles[0].receiptRole],
    swappedRoles[accessibilityApprovalRoles[1].receiptRole],
  ] = [
    swappedRoles[accessibilityApprovalRoles[1].receiptRole],
    swappedRoles[accessibilityApprovalRoles[0].receiptRole],
  ];
  assert.throws(() => validateAccessibilityApprovalReceipts({
    ...fixture,
    approvalReceipts: swappedRoles,
    runtime,
    trustContext,
  }), /EXTERNAL_GATE_RECEIPT_(?:TYPE|ROLE)_MISMATCH/u);

  const incompleteSubmit = structuredClone(fixture.individualEvidence);
  incompleteSubmit.at(-1).observations.pop();
  assert.throws(() => validateAccessibilityApprovalReceipts({
    ...fixture,
    approvalReceipts,
    individualEvidence: incompleteSubmit,
    runtime,
    trustContext,
  }), /ACCESSIBILITY_MANUAL_OBSERVATION_INVENTORY_INVALID/u);

  const genericObservation = structuredClone(fixture.individualEvidence);
  genericObservation[1].observations[0].id = "observation.generic-pass";
  assert.throws(() => validateAccessibilityApprovalReceipts({
    ...fixture,
    approvalReceipts,
    individualEvidence: genericObservation,
    runtime,
    trustContext,
  }), /ACCESSIBILITY_MANUAL_OBSERVATION_INVENTORY_INVALID/u);
});

test("the pinned GitHub CLI executes only through an identity-checked private copy", () => {
  const executableBytes = Buffer.from("pinned-cli-contract-fixture", "utf8");
  const expectedSha256 = sha256(executableBytes);
  const trustedRootBytes = Buffer.from('{"trustedRoot":"contract-fixture"}\n', "utf8");
  const trustedRootInput = {
    bytes: trustedRootBytes,
    expectedSha256: sha256(trustedRootBytes),
    key: "trustedRoot",
    maximumBytes: 4 * 1024 * 1024,
    name: "sigstore-trusted-root.jsonl",
  };
  assert.deepEqual(
    withIdentityCheckedExecutableCopy({
      executableBytes,
      expectedSha256,
      inputFiles: [trustedRootInput],
      operation(snapshot) {
        return {
          cli: sha256(readFileSync(snapshot.executablePath)),
          trustedRoot: sha256(readFileSync(snapshot.inputPaths.trustedRoot)),
        };
      },
    }),
    { cli: expectedSha256, trustedRoot: trustedRootInput.expectedSha256 },
  );
  assert.throws(
    () => withIdentityCheckedExecutableCopy({
      executableBytes,
      expectedSha256,
      operation(snapshot) {
        const originalPath = `${snapshot.executablePath}.original`;
        renameSync(snapshot.executablePath, originalPath);
        writeFileSync(snapshot.executablePath, "substituted-cli", { flag: "wx", mode: 0o500 });
      },
    }),
    /PROTECTED_WORKFLOW_GITHUB_CLI_SNAPSHOT_CHANGED/u,
  );
  assert.throws(
    () => withIdentityCheckedExecutableCopy({
      executableBytes,
      expectedSha256,
      inputFiles: [trustedRootInput],
      operation(snapshot) {
        const originalPath = `${snapshot.inputPaths.trustedRoot}.original`;
        renameSync(snapshot.inputPaths.trustedRoot, originalPath);
        writeFileSync(snapshot.inputPaths.trustedRoot, '{"trustedRoot":"substituted"}\n', {
          flag: "wx",
          mode: 0o400,
        });
      },
    }),
    /PROTECTED_WORKFLOW_GITHUB_CLI_SNAPSHOT_INPUT_CHANGED/u,
  );
});

test("protected workflow provenance binds cryptographically verified GitHub claims to the signed receipt", () => {
  const fixture = workflowFixture();
  assert.equal(
    fixture.verificationOutput[0].verificationResult.statement.subject[0].digest.sha256,
    sha256(fixture.artifactBytes),
  );
  assert.deepEqual(
    validateProtectedWorkflowArtifactTar({
      artifactBytes: fixture.artifactBytes,
      artifactManifest: fixture.artifactManifest,
    }),
    {
      artifactDigest: fixture.artifactDigest,
      memberCount: protectedWorkflowEvidenceFiles.length,
      memberNames: [...protectedWorkflowEvidenceFiles].sort((left, right) => left.localeCompare(right)),
      status: "VERIFIED",
    },
  );
  assert.equal(fixture.verifiedClaims.github.runId, "123456789012");
  assert.equal(fixture.verifiedClaims.github.runAttempt, 2);
  const receipt = buildReceipt({
    payload: fixture.payload,
    recordType: protectedWorkflowProvenanceRecordType,
    role: "github-actions-attestor",
  });
  const input = {
    artifactManifest: fixture.artifactManifest,
    expectedArtifactDigest: fixture.artifactDigest,
    expectedRuntime: runtime,
    expectedWorkflowRef: fixture.workflowRef,
    expectedWorkflowSha: fixture.workflowSha,
    receipt,
    trustContext,
  };
  assert.equal(
    validateProtectedWorkflowProvenanceReceipt(input).status,
    "SIGNED_VERIFICATION_RECEIPT",
  );
  assert.throws(
    () => validateProtectedWorkflowProvenanceReceipt({ ...input, trustContext: null }),
    /EXTERNAL_GATE_TRUST_CONTEXT_REQUIRED/u,
  );

  const sparseManifest = structuredClone(fixture.artifactManifest);
  sparseManifest.files.pop();
  assert.throws(
    () => validateProtectedWorkflowProvenanceReceipt({ ...input, artifactManifest: sparseManifest }),
    /PROTECTED_WORKFLOW_ARTIFACT_FILE_COUNT_INVALID/u,
  );

  const memberDigestMismatch = structuredClone(fixture.artifactManifest);
  memberDigestMismatch.files[0].sha256 = sha256("manifest-member-substitution");
  assert.throws(
    () => validateProtectedWorkflowArtifactTar({
      artifactBytes: fixture.artifactBytes,
      artifactManifest: memberDigestMismatch,
    }),
    /PROTECTED_WORKFLOW_ARTIFACT_TAR_MEMBER_DIGEST_MISMATCH/u,
  );

  const memberSizeMismatch = structuredClone(fixture.artifactManifest);
  memberSizeMismatch.files[0].sizeBytes += 1;
  assert.throws(
    () => validateProtectedWorkflowArtifactTar({
      artifactBytes: fixture.artifactBytes,
      artifactManifest: memberSizeMismatch,
    }),
    /PROTECTED_WORKFLOW_ARTIFACT_TAR_MEMBER_SIZE_MISMATCH/u,
  );

  const unexpectedMemberBytes = buildUstarArtifact([
    ...protectedWorkflowEvidenceFiles.map((name, index) => ({
      contents: Buffer.from(`protected-workflow-file-${index}`, "utf8"),
      name,
    })),
    { contents: Buffer.from("not-allowlisted", "utf8"), name: "unexpected-evidence.json" },
  ]);
  const unexpectedMemberManifest = {
    ...structuredClone(fixture.artifactManifest),
    artifactDigest: sha256(unexpectedMemberBytes),
  };
  assert.throws(
    () => validateProtectedWorkflowArtifactTar({
      artifactBytes: unexpectedMemberBytes,
      artifactManifest: unexpectedMemberManifest,
    }),
    /PROTECTED_WORKFLOW_ARTIFACT_TAR_MEMBER_INVENTORY_INVALID/u,
  );

  const localEnvironmentPayload = structuredClone(fixture.payload);
  localEnvironmentPayload.github.issuer = "https://example.invalid/self-asserted";
  const selfAssertedReceipt = buildReceipt({
    payload: localEnvironmentPayload,
    recordType: protectedWorkflowProvenanceRecordType,
    role: "github-actions-attestor",
  });
  assert.throws(
    () => validateProtectedWorkflowProvenanceReceipt({ ...input, receipt: selfAssertedReceipt }),
    /PROTECTED_WORKFLOW_OIDC_ISSUER_INVALID/u,
  );

  const subjectMismatch = structuredClone(fixture.verificationOutput);
  subjectMismatch[0].verificationResult.statement.subject[0].name = "substituted-artifact.tar";
  assert.throws(
    () => validateVerifiedGitHubAttestationOutput({
      artifactDigest: fixture.artifactDigest,
      artifactManifestSha256: sha256(canonicalJson(fixture.artifactManifest)),
      artifactName: fixture.artifactManifest.artifactName,
      attestationBundle: fixture.attestationBundle,
      attestationBundleSha256: fixture.payload.artifact.attestationBundleSha256,
      expectedWorkflowRef: fixture.workflowRef,
      expectedWorkflowSha: fixture.workflowSha,
      githubCliPlatform: fixture.payload.verification.githubCliPlatform,
      githubCliSha256: fixture.payload.verification.githubCliSha256,
      sigstoreTrustedRootSha256: fixture.payload.verification.sigstoreTrustedRootSha256,
      verificationOutput: subjectMismatch,
    }),
    /PROTECTED_WORKFLOW_ATTESTATION_SUBJECT_NAME_MISMATCH/u,
  );

  const digestMismatch = structuredClone(fixture.verificationOutput);
  digestMismatch[0].verificationResult.statement.subject[0].digest.sha256 = "0".repeat(64);
  assert.throws(
    () => validateVerifiedGitHubAttestationOutput({
      artifactDigest: fixture.artifactDigest,
      artifactManifestSha256: sha256(canonicalJson(fixture.artifactManifest)),
      artifactName: fixture.artifactManifest.artifactName,
      attestationBundle: fixture.attestationBundle,
      attestationBundleSha256: fixture.payload.artifact.attestationBundleSha256,
      expectedWorkflowRef: fixture.workflowRef,
      expectedWorkflowSha: fixture.workflowSha,
      githubCliPlatform: fixture.payload.verification.githubCliPlatform,
      githubCliSha256: fixture.payload.verification.githubCliSha256,
      sigstoreTrustedRootSha256: fixture.payload.verification.sigstoreTrustedRootSha256,
      verificationOutput: digestMismatch,
    }),
    /PROTECTED_WORKFLOW_ATTESTATION_SUBJECT_DIGEST_MISMATCH/u,
  );

  const tamperedBundle = structuredClone(fixture.attestationBundle);
  tamperedBundle.dsseEnvelope.payload = "tampered";
  assert.throws(
    () => validateVerifiedGitHubAttestationOutput({
      artifactDigest: fixture.artifactDigest,
      artifactManifestSha256: sha256(canonicalJson(fixture.artifactManifest)),
      artifactName: fixture.artifactManifest.artifactName,
      attestationBundle: tamperedBundle,
      attestationBundleSha256: sha256(canonicalJson(tamperedBundle)),
      expectedWorkflowRef: fixture.workflowRef,
      expectedWorkflowSha: fixture.workflowSha,
      githubCliPlatform: fixture.payload.verification.githubCliPlatform,
      githubCliSha256: fixture.payload.verification.githubCliSha256,
      sigstoreTrustedRootSha256: fixture.payload.verification.sigstoreTrustedRootSha256,
      verificationOutput: fixture.verificationOutput,
    }),
    /PROTECTED_WORKFLOW_VERIFIED_BUNDLE_MISMATCH/u,
  );
});

test("operational receipts require the complete signed source-specific inventory", () => {
  const receipts = {};
  for (const [gateId, specification] of Object.entries(operationalGateSpecifications)) {
    const payload = operationalPayload(gateId);
    receipts[gateId] = buildReceipt({
      payload,
      recordType: specification.recordType,
      role: specification.role,
    });
    assert.equal(validateOperationalGateReceipt({
      expectedRuntime: runtime,
      expectedSource: payload.source,
      gateId,
      receipt: receipts[gateId],
      trustContext,
    }).status, "VERIFIED");
  }
  assert.equal(
    Object.keys(validateOperationalGateReceipts({ expectedRuntime: runtime, receipts, trustContext })).length,
    Object.keys(operationalGateSpecifications).length,
  );

  const sparsePayload = operationalPayload("supply-chain");
  sparsePayload.observations.pop();
  const sparseReceipt = buildReceipt({
    payload: sparsePayload,
    recordType: operationalGateSpecifications["supply-chain"].recordType,
    role: operationalGateSpecifications["supply-chain"].role,
  });
  assert.throws(() => validateOperationalGateReceipt({
    expectedRuntime: runtime,
    gateId: "supply-chain",
    receipt: sparseReceipt,
    trustContext,
  }), /OPERATIONAL_GATE_OBSERVATION_COUNT_INVALID/u);

  const wrongProviderPayload = operationalPayload("observability");
  wrongProviderPayload.source.provider = "self-asserted";
  const wrongProviderReceipt = buildReceipt({
    payload: wrongProviderPayload,
    recordType: operationalGateSpecifications.observability.recordType,
    role: operationalGateSpecifications.observability.role,
  });
  assert.throws(() => validateOperationalGateReceipt({
    expectedRuntime: runtime,
    gateId: "observability",
    receipt: wrongProviderReceipt,
    trustContext,
  }), /OPERATIONAL_GATE_SOURCE_PROVIDER_INVALID/u);
});

test("company profile receipt binds approved locked version, audit and content snapshot", () => {
  const fixture = companyProfileFixture();
  const receipt = buildReceipt({
    payload: fixture.payload,
    recordType: companyProfileApprovalRecordType,
    role: "company-profile-approver",
  });
  const input = {
    profileSnapshot: fixture.profileSnapshot,
    receipt,
    runtime,
    trustContext,
  };
  const result = validateCompanyProfileApprovalReceipt(input);
  assert.equal(result.status, "VERIFIED");
  assert.equal(result.profileVersion, 7);

  assert.throws(
    () => validateCompanyProfileApprovalReceipt({ ...input, trustContext: null }),
    /EXTERNAL_GATE_TRUST_CONTEXT_REQUIRED/u,
  );

  const tampered = structuredClone(fixture.profileSnapshot);
  tampered.contentSha256 = "f".repeat(64);
  assert.throws(
    () => validateCompanyProfileApprovalReceipt({ ...input, profileSnapshot: tampered }),
    /COMPANY_PROFILE_RECEIPT_SNAPSHOT_DIGEST_MISMATCH/u,
  );

  const sparse = structuredClone(fixture.profileSnapshot);
  delete sparse.audit.eventSha256;
  assert.throws(
    () => validateCompanyProfileApprovalReceipt({ ...input, profileSnapshot: sparse }),
    /COMPANY_PROFILE_AUDIT_KEYS_INVALID/u,
  );

  const wrongVersionPayload = structuredClone(fixture.payload);
  wrongVersionPayload.profileVersion = 8;
  const wrongVersionReceipt = buildReceipt({
    payload: wrongVersionPayload,
    recordType: companyProfileApprovalRecordType,
    role: "company-profile-approver",
  });
  assert.throws(() => validateCompanyProfileApprovalReceipt({
    ...input,
    receipt: wrongVersionReceipt,
  }), /COMPANY_PROFILE_RECEIPT_VERSION_MISMATCH/u);
});
