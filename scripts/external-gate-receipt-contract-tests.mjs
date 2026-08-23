import assert from "node:assert/strict";
import {
  generateKeyPairSync,
  sign as createDetachedSignature,
} from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { tmpdir } from "node:os";

import {
  accessibilityManualAcceptanceRecordType,
  accessibilityRequiredManualCheckIds,
  validateAccessibilityManualAcceptanceReceipt,
} from "./lib/accessibility-manual-acceptance-receipt.mjs";
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
  operationalGateSpecifications,
  validateOperationalGateReceipt,
  validateOperationalGateReceipts,
} from "./lib/operational-gate-receipts.mjs";
import {
  githubArtifactAttestationCliPins,
  protectedWorkflowArtifactManifestRecordType,
  protectedWorkflowEvidenceFiles,
  protectedWorkflowProvenanceRecordType,
  validateProtectedWorkflowProvenanceReceipt,
  validateVerifiedGitHubAttestationOutput,
} from "./lib/protected-workflow-provenance-receipt.mjs";

const runtime = Object.freeze({
  candidateCommit: "a".repeat(40),
  databaseBranchId: "br-lucky-heart-alrm9dlw",
  deploymentHost: "candidate-preview-novalure.vercel.app",
  deploymentId: "dpl_12345678901234567890",
  gitBranch: "codex/go-live-remediation-20260822",
  productionMutationPerformed: false,
});

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
const anchorSource = `${JSON.stringify(anchor, null, 2)}\n`;
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
    contexts: [`context ${index + 1} desktop mobile assistive technology`],
    languages: ["de", "en"],
    observations: [{
      evidenceSha256: sha256(`accessibility-observation-${index}`),
      id: `observation.${index + 1}`,
      status: "PASS",
    }],
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
    approvals: [{ owner: "plain strings are not trusted", signature: "not-a-security-boundary" }],
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
    status: "SIGNED",
  };
  const automatedEvidence = {
    automatedSubsetPassed: true,
    automatedTechnicalPassed: true,
    coverage: { complete: true },
    expectedSha: runtime.candidateCommit,
    matrix: { failed: 0, passed: 1 },
    productionMutationPerformed: false,
    releaseSurfaceManifestVerified: true,
    results: [{ outcome: "PASS" }],
    runtimeIdentity: { attestationComplete: true },
    schemaVersion: 4,
    targetHost: runtime.deploymentHost,
    unsafeHttpWriteGuard: { complete: true },
  };
  const payload = {
    automatedEvidenceSha256: sha256(canonicalJson(automatedEvidence)),
    individualEvidenceBundleSha256: sha256(canonicalJson(manualCheckDigests)),
    manualCheckDigests,
    matrixSha256: sha256(canonicalJson(matrix)),
    runtime: { ...runtime },
  };
  return {
    automatedEvidence,
    expectedAutomatedEvidence: structuredClone(automatedEvidence),
    individualEvidence,
    matrix,
    payload,
  };
}

function workflowFixture() {
  const artifactDigest = sha256("protected-workflow-artifact");
  const artifactManifest = {
    artifactDigest,
    artifactName: `exact-preview-two-tenant-${runtime.candidateCommit}.tar`,
    files: protectedWorkflowEvidenceFiles.map((name, index) => ({
      name,
      sha256: sha256(`protected-workflow-file-${index}`),
      sizeBytes: 1_024 + index,
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

test("accessibility requires full matrix and individual digests plus an external owner signature", () => {
  const fixture = accessibilityFixture();
  const receipt = buildReceipt({
    payload: fixture.payload,
    recordType: accessibilityManualAcceptanceRecordType,
    role: "accessibility-owner",
  });
  const result = validateAccessibilityManualAcceptanceReceipt({
    ...fixture,
    receipt,
    runtime,
    trustContext,
  });
  assert.equal(result.status, "VERIFIED");
  assert.equal(result.manualCheckCount, accessibilityRequiredManualCheckIds.length);

  assert.throws(() => validateAccessibilityManualAcceptanceReceipt({
    ...fixture,
    receipt,
    runtime,
    trustContext: null,
  }), /EXTERNAL_GATE_TRUST_CONTEXT_REQUIRED/u);

  const tamperedEvidence = structuredClone(fixture.individualEvidence);
  tamperedEvidence[0].observations[0].evidenceSha256 = "f".repeat(64);
  assert.throws(() => validateAccessibilityManualAcceptanceReceipt({
    ...fixture,
    individualEvidence: tamperedEvidence,
    receipt,
    runtime,
    trustContext,
  }), /ACCESSIBILITY_MATRIX_MANUAL_EVIDENCE_DIGEST_MISMATCH/u);

  const sparsePayload = structuredClone(fixture.payload);
  sparsePayload.manualCheckDigests.pop();
  const sparseReceipt = buildReceipt({
    payload: sparsePayload,
    recordType: accessibilityManualAcceptanceRecordType,
    role: "accessibility-owner",
  });
  assert.throws(() => validateAccessibilityManualAcceptanceReceipt({
    ...fixture,
    receipt: sparseReceipt,
    runtime,
    trustContext,
  }), /ACCESSIBILITY_MANUAL_ACCEPTANCE_CHECK_DIGESTS_MISMATCH/u);
});

test("protected workflow provenance binds cryptographically verified GitHub claims to the signed receipt", () => {
  const fixture = workflowFixture();
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
