#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign as signDetached } from "node:crypto";
import { spawnSync } from "node:child_process";
import { link, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertEvidenceCandidateBinding,
  assertFinalPreviewRecoveryGoResult,
  buildExternalApprovalSigningPayload,
  buildFinalPreviewDocumentBundleSha256,
  buildPerformanceTechnicalEvidenceSha256,
  finalPreviewDocumentBindings,
  finalPreviewGateBindings,
  finalPreviewGateIds,
  finalPerformanceBudgetPolicy,
  observedFinalPreviewGateStatus,
  readApprovalTrustContext,
  releaseApprovalRoles,
  validateExternalApprovalArtifact,
  validateApprovalTrustAnchor,
  validateFinalPreviewReleaseAttestation,
  validateReleaseDocumentCandidateState,
  verifyExternalApprovalArtifact,
  verifyFinalPreviewReleaseAttestation,
  verifyFinalPreviewRepositoryProvenance,
} from "./final-preview-release-attestation-contract.mjs";
import {
  a11yExpectedResultKeys,
  performanceExpectedResultKeys,
  previewBlobExpectedCheckIds,
  providerExpectedDatabaseTables,
  providerExpectedRequestIds,
  publicExpectedReadOnlyRequestIds,
  twoTenantCleanupResourceTypes,
  twoTenantExpectedResultIds,
} from "./lib/final-preview-gate-inventories.mjs";
import {
  buildExternalGateReceiptSigningPayload,
  canonicalJson as canonicalGateJson,
  externalGateReceiptRoles,
  sha256 as gateSha256,
} from "./lib/external-gate-receipts.mjs";
import {
  accessibilityApprovalRoles,
  accessibilityManualObservationIdsByCheck,
  accessibilityRequiredManualCheckIds,
} from "./lib/accessibility-manual-acceptance-receipt.mjs";
import {
  a11yFixtureLifecycleRecordType,
  a11yRetainedTableNames,
} from "./lib/a11y-fixture-lifecycle-evidence.mjs";
import {
  companyProfileApprovalRecordType,
  companyProfileApprovalRole,
  companyProfileSnapshotRecordType,
} from "./lib/company-profile-approval-receipt.mjs";
import { operationalGateSpecifications } from "./lib/operational-gate-receipts.mjs";
import {
  performanceBudgetApprovalRecordType,
  performanceBudgetApprovalRoles,
  performanceManualAcceptanceRecordType,
  performanceManualAcceptanceRole,
  performanceManualGateIds,
  performanceRumAcceptanceRecordType,
  performanceRumAcceptanceRole,
} from "./lib/performance-acceptance-receipts.mjs";
import {
  buildProviderAcceptanceReceiptBundleSha256,
  providerAcceptanceRecordType,
  providerFinalCleanupRecordType,
  providerFinalCleanupRole,
  requiredProviderAcceptances,
} from "./lib/provider-acceptance-receipts.mjs";
import { providerFailClosedScenarios } from "./lib/provider-fail-closed-preview.mjs";
import {
  publicRuntimeArtifactFiles,
  publicRuntimeParentBaseArtifactFile,
  publicRuntimeProofObservations,
  publicRuntimeWorkflowRecordType,
  publicRuntimeWorkflowRole,
} from "./lib/public-runtime-protected-receipt.mjs";
import {
  githubArtifactAttestationCliPins,
  githubArtifactAttestationCliVersion,
  protectedWorkflowArtifactManifestRecordType,
  protectedWorkflowEvidenceFiles,
  protectedWorkflowProvenanceRecordType,
  protectedWorkflowProvenanceRole,
  twoTenantParentBaseArtifactFile,
} from "./lib/protected-workflow-provenance-receipt.mjs";
import {
  blobLegacyMigrationRecordType,
  blobLegacyMigrationRole,
  summarizeLegacyBlobObjectInventory,
} from "./lib/blob-legacy-migration-receipt.mjs";

const signatureRoles = releaseApprovalRoles;
const trustRoles = [...signatureRoles, ...externalGateReceiptRoles];
const approvalScopesByRole = {
  product: ["FINAL_RELEASE", "PRODUCT", "UNIT_BUYER_DEAL"],
  engineering: ["ENGINEERING", "FINAL_RELEASE", "UNIT_BUYER_DEAL"],
  security: ["FINAL_RELEASE", "SECURITY"],
  operations: ["FINAL_RELEASE", "OPERATIONS"],
  legal: ["FINAL_RELEASE", "LEGAL_CONTENT"],
  privacy: ["FINAL_RELEASE", "PRIVACY_CONTENT"],
  "sales-operations": ["FINAL_RELEASE", "UNIT_BUYER_DEAL"],
  "data-compliance": ["DATA_COMPLIANCE", "FINAL_RELEASE", "UNIT_BUYER_DEAL"],
};
const trustAnchorId = "ta_novalure_release_20260823";
const signingKeys = Object.fromEntries(trustRoles.map((role) => {
  const pair = generateKeyPairSync("ed25519");
  return [role, {
    keyId: `key_${role}_20260823`,
    privateKey: pair.privateKey,
    publicKeyPem: pair.publicKey.export({ format: "pem", type: "spki" }),
    signerSubject: `subject:novalure:${role}:20260823`,
  }];
}));
const trustAnchor = {
  keys: trustRoles.map((role) => ({
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

function gateRuntime(overrides = {}) {
  return {
    branch: "codex/go-live-remediation-20260822",
    candidateCommit: "a".repeat(40),
    databaseBranchId: "br-lucky-heart-alrm9dlw",
    deploymentHost: "candidate-preview-novalure.vercel.app",
    deploymentId: "dpl_12345678901234567890",
    trustedHarnessSha: "b".repeat(40),
    ...overrides,
  };
}

function gateBinding(id) {
  return finalPreviewGateBindings.find((binding) => binding.id === id);
}

function exactRuntimeIdentity(runtime, databaseBranchId = "br-lucky-heart-alrm9dlw") {
  return {
    databaseBranchId,
    deploymentHost: runtime.deploymentHost,
    deploymentId: runtime.deploymentId,
    gitBranch: runtime.branch,
    gitSha: runtime.candidateCommit,
  };
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

function canonicalJson(value) {
  return `${JSON.stringify(canonicalize(value), null, 2)}\n`;
}

function externalGateReceipt(role, recordType, payload, signedAt = "2026-08-25T21:00:00.000Z") {
  const key = signingKeys[role];
  const payloadSha256 = gateSha256(canonicalGateJson(payload));
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

function gateReceiptRuntime(runtime) {
  return {
    candidateCommit: runtime.candidateCommit,
    databaseBranchId: runtime.databaseBranchId,
    deploymentHost: runtime.deploymentHost,
    deploymentId: runtime.deploymentId,
    gitBranch: runtime.branch,
    productionMutationPerformed: false,
  };
}

function completeTwoTenantEvidence(runtime) {
  const identity = exactRuntimeIdentity(runtime);
  const remaining = Object.fromEntries(twoTenantCleanupResourceTypes.map((key) => [key, 0]));
  const artifactDigest = "a".repeat(64);
  const workflowRef = "novalure/novalure-crm/.github/workflows/livegang-e2e.yml@refs/heads/main";
  const workflowUri = `https://github.com/${workflowRef}`;
  const parentBase = {
    cleanup: ["A", "B"].map((tenant) => ({ planDigest: "d".repeat(64), remaining, tenant })),
    commit: runtime.candidateCommit,
    mode: "execute",
    productionMutationPerformed: false,
    requests: [],
    results: twoTenantExpectedResultIds.map((id) => ({ id, status: "pass" })),
    runtime: identity,
    schema: gateBinding("two-tenant-rbac-crud").schemaValue,
    summary: { failed: 0, passed: twoTenantExpectedResultIds.length, requests: 0 },
    targets: ["A", "B"].map((tenant) => ({
      branch: `sha256:${createHash("sha256").update(identity.databaseBranchId).digest("hex").slice(0, 16)}`,
      tenant,
    })),
    workflowTrust: {
      candidateSha: runtime.candidateCommit,
      schema: "novalure.qa.protected-workflow-trust.v1",
      trustedHarnessSha: runtime.trustedHarnessSha,
      workflowRef,
      workflowSha: runtime.trustedHarnessSha,
    },
  };
  const canonicalParentBase = canonicalGateJson(parentBase);
  const protectedWorkflowArtifactManifest = {
    artifactDigest,
    artifactName: `exact-preview-two-tenant-${runtime.candidateCommit}.tar`,
    files: protectedWorkflowEvidenceFiles.map((name, index) => name === twoTenantParentBaseArtifactFile
      ? {
          name,
          sha256: gateSha256(canonicalParentBase),
          sizeBytes: Buffer.byteLength(canonicalParentBase, "utf8"),
        }
      : {
          name,
          sha256: String((index % 8) + 1).repeat(64),
          sizeBytes: 1_000 + index,
        }),
    recordType: protectedWorkflowArtifactManifestRecordType,
    schemaVersion: 1,
  };
  const protectedWorkflowReceipt = externalGateReceipt(
    protectedWorkflowProvenanceRole,
    protectedWorkflowProvenanceRecordType,
    {
      artifact: {
        artifactDigest,
        artifactName: protectedWorkflowArtifactManifest.artifactName,
        attestationBundleSha256: "b".repeat(64),
        manifestSha256: gateSha256(canonicalGateJson(protectedWorkflowArtifactManifest)),
        predicateType: "https://slsa.dev/provenance/v1",
        statementSha256: "c".repeat(64),
      },
      attestedAt: "2026-08-25T20:30:00.000Z",
      github: {
        buildConfigDigest: runtime.trustedHarnessSha,
        buildConfigUri: workflowUri,
        buildSignerDigest: runtime.trustedHarnessSha,
        buildSignerUri: workflowUri,
        buildTrigger: "workflow_dispatch",
        githubWorkflowRef: "refs/heads/main",
        issuer: "https://token.actions.githubusercontent.com",
        repository: "novalure/novalure-crm",
        runAttempt: 1,
        runId: "123456789012",
        runInvocationUri:
          "https://github.com/novalure/novalure-crm/actions/runs/123456789012/attempts/1",
        runnerEnvironment: "github-hosted",
        sourceRepositoryDigest: runtime.trustedHarnessSha,
        sourceRepositoryIdentifier: "123456789",
        sourceRepositoryOwnerIdentifier: "987654321",
        sourceRepositoryOwnerUri: "https://github.com/novalure",
        sourceRepositoryRef: "refs/heads/main",
        sourceRepositoryUri: "https://github.com/novalure/novalure-crm",
        sourceRepositoryVisibilityAtSigning: "private",
        subjectAlternativeName: workflowUri,
        workflowReference: workflowRef,
        workflowSha: runtime.trustedHarnessSha,
        workflowTrigger: "workflow_dispatch",
      },
      runtime: gateReceiptRuntime(runtime),
      verification: {
        certificateSha256: "d".repeat(64),
        githubCliPlatform: "linux-x64",
        githubCliSha256: githubArtifactAttestationCliPins["linux-x64"].executableSha256,
        githubCliVersion: githubArtifactAttestationCliVersion,
        sigstoreTrustedRootSha256: "e".repeat(64),
        verificationResultSha256: "f".repeat(64),
        verifiedTimestampCount: 1,
        verifiedTimestampsSha256: "1".repeat(64),
      },
    },
  );
  return {
    ...parentBase,
    protectedWorkflowArtifactManifest,
    protectedWorkflowReceipt,
  };
}

function completeBlobEvidence(runtime) {
  const storeFingerprint = `sha256:${"1".repeat(20)}`;
  const sourceStoreFingerprint = `sha256:${"2".repeat(20)}`;
  const sourceObjects = [0, 1, 2].map((index) => ({
    assetKeySha256: gateSha256(`asset-${index}`),
    contentSha256: gateSha256(`content-${index}`),
    objectPathSha256: gateSha256(`source-path-${index}`),
    sizeBytes: 90 + (index * 10),
  })).sort((left, right) => left.assetKeySha256.localeCompare(right.assetKeySha256));
  const targetObjects = sourceObjects.map((entry) => ({
    ...entry,
    objectPathSha256: gateSha256(`target-path-${entry.assetKeySha256}`),
  }));
  const sourceSummary = summarizeLegacyBlobObjectInventory(sourceObjects);
  const targetSummary = summarizeLegacyBlobObjectInventory(targetObjects);
  const references = targetObjects.map((entry) => ({
    assetKeySha256: entry.assetKeySha256,
    databaseRowSha256: gateSha256(`database-row-${entry.assetKeySha256}`),
    targetObjectPathSha256: entry.objectPathSha256,
  }));
  const rollbackArtifacts = sourceObjects.map((entry) => {
    const target = targetObjects.find((candidate) => candidate.assetKeySha256 === entry.assetKeySha256);
    return {
      assetKeySha256: entry.assetKeySha256,
      contentSha256: entry.contentSha256,
      sizeBytes: entry.sizeBytes,
      sourceObjectPathSha256: entry.objectPathSha256,
      targetObjectPathSha256: target.objectPathSha256,
    };
  });
  const legacyEvidence = {
    candidateCommit: runtime.candidateCommit,
    deploymentId: runtime.deploymentId,
    journalSha256: gateSha256("legacy-cutover-journal"),
    observedAt: "2026-08-23T20:29:00.000Z",
    oldStorePostcondition: {
      authenticatedReadDenied: true,
      listedObjectCount: 0,
      publicReadDenied: true,
    },
    recordType: "NOVALURE_PREVIEW_BLOB_LEGACY_MIGRATION_EVIDENCE",
    referenceCutover: {
      allReferencesTargetStore: true,
      referenceInventorySha256: gateSha256(canonicalGateJson(references)),
      references,
      rewrittenReferenceCount: 3,
    },
    rollback: {
      artifactSha256: gateSha256(canonicalGateJson(rollbackArtifacts)),
      artifacts: rollbackArtifacts,
      status: "VERIFIED",
    },
    schemaVersion: 2,
    sourceInventory: {
      ...sourceSummary,
      objects: sourceObjects,
      storeFingerprint: sourceStoreFingerprint,
    },
    sourceStoreFingerprint,
    targetDatabaseBranchId: runtime.databaseBranchId,
    targetInventory: {
      ...targetSummary,
      objects: targetObjects,
      storeFingerprint,
    },
    targetStoreFingerprint: storeFingerprint,
  };
  const evidenceDigest = gateSha256(canonicalGateJson(legacyEvidence));
  const migrationReceipt = externalGateReceipt(
    blobLegacyMigrationRole,
    blobLegacyMigrationRecordType,
    {
      evidenceSha256: evidenceDigest,
      journalSha256: legacyEvidence.journalSha256,
      referenceInventorySha256: legacyEvidence.referenceCutover.referenceInventorySha256,
      rollbackArtifactSha256: legacyEvidence.rollback.artifactSha256,
      runtime: gateReceiptRuntime(runtime),
      sourceInventorySha256: legacyEvidence.sourceInventory.inventorySha256,
      sourceStoreFingerprint,
      targetInventorySha256: legacyEvidence.targetInventory.inventorySha256,
      targetStoreFingerprint: storeFingerprint,
    },
  );
  return {
    checks: previewBlobExpectedCheckIds.map((id) => ({ id, status: "PASS" })),
    cleanup: { attempted: true, deleted: true, state: "deleted-and-absent", verifiedAbsent: true },
    deployment: {
      branch: runtime.branch,
      databaseBranchId: "br-lucky-heart-alrm9dlw",
      deploymentHost: runtime.deploymentHost,
      deploymentId: runtime.deploymentId,
      gitSha: runtime.candidateCommit,
    },
    independentStoreProof: {
      afterDeleteCount: 8,
      afterUploadCount: 9,
      beforeCount: 8,
      headVerified: true,
      newObjectCount: 1,
      objectAbsentAfterDelete: true,
      reasonCode: null,
      status: "VERIFIED",
      storeFingerprint,
    },
    legacyObjectMigrationProof: {
      candidateCommit: runtime.candidateCommit,
      evidence: legacyEvidence,
      evidenceDigest,
      legacyObjectCountAfter: 0,
      legacyObjectCountBefore: 3,
      migratedObjectCount: 3,
      migrationReceipt,
      productionMutationPerformed: false,
      status: "VERIFIED",
      storeFingerprint,
    },
    lifecycle: {
      crossTenantReadDenied: true,
      listMatchesAfterDelete: 0,
      listMatchesAfterUpload: 1,
      listMatchesBefore: 0,
      readHeadersVerified: true,
      readbackBytesVerified: true,
      unauthenticatedReadDenied: true,
    },
    productionMutationPerformed: false,
    releaseGatePassed: true,
    schema: gateBinding("preview-blob-lifecycle").schemaValue,
    status: "PASS",
    technicalStatus: "PASS",
  };
}

function completeProviderEvidence(runtime) {
  const receiptRuntime = gateReceiptRuntime(runtime);
  const databaseWritePostcondition = {
    reasonCode: null,
    status: "PASS",
    tables: Object.fromEntries(providerExpectedDatabaseTables.map((table, index) => [table, {
      afterCount: 2,
      afterFingerprint: `sha256:${String((index % 8) + 1).repeat(64)}`,
      beforeCount: 2,
      beforeFingerprint: `sha256:${String((index % 8) + 1).repeat(64)}`,
      unchanged: true,
    }])),
  };
  const databasePostconditionSha256 = gateSha256(canonicalGateJson(databaseWritePostcondition));
  const scenarios = new Map(providerFailClosedScenarios.map((entry) => [entry.id, entry]));
  const rawSource = {
    candidate: {
      commitSha: runtime.candidateCommit,
      databaseBranchFingerprint: `sha256:${"1".repeat(16)}`,
      databaseBranchId: runtime.databaseBranchId,
      deploymentHost: runtime.deploymentHost,
      deploymentId: runtime.deploymentId,
      gitRef: runtime.branch,
      previewOriginFingerprint: `sha256:${"2".repeat(16)}`,
    },
    cleanup: {
      databaseCleanup: "NOT_REQUIRED",
      externalSessionCreatedByRunner: false,
      inMemoryCookieJar: "CLEARED_IN_FINALLY",
      status: "COMPLETE",
    },
    completedAt: "2026-08-25T19:59:00.000Z",
    databaseWritePostcondition,
    httpTechnicalStatus: "PASS",
    productionMutationPerformed: false,
    providerSideEffectPostcondition: {
      codeOrderAndHttpGate: "PASS",
      independentProviderLogs: "UNPROVEN",
      reasonCode: "INDEPENDENT_PROVIDER_LOGS_NOT_COLLECTED",
    },
    releaseGateStatus: "BLOCKED",
    requests: providerExpectedRequestIds.map((id) => {
      const identityRequest = id === "identity.session" || id === "identity.runtime";
      const scenario = scenarios.get(id);
      return {
        code: identityRequest
          ? id === "identity.session" ? "SESSION_SCOPE_MATCH" : "RUNTIME_IDENTITY_MATCH"
          : "LAUNCH_SCOPE_OFF",
        csrf: identityRequest ? "not-applicable" : scenario.csrf,
        id,
        method: identityRequest ? "GET" : scenario.method,
        status: identityRequest ? 200 : 503,
      };
    }),
    schemaVersion: gateBinding("provider-boundaries").schemaValue,
    startedAt: "2026-08-25T19:58:00.000Z",
  };
  const sourceArtifactSha256 = "d".repeat(64);
  const sourceCollectorSha256 = gateSha256(canonicalGateJson(rawSource));
  const providerAcceptanceReceipts = Object.entries(requiredProviderAcceptances).map(([acceptanceId, contract], index) => {
    const providerName = contract.providers[0];
    return externalGateReceipt(contract.receiptRole, providerAcceptanceRecordType, {
      acceptanceId,
      artifactSha256: String((index % 8) + 1).repeat(64),
      databasePostconditionSha256,
      observationWindow: {
        completedAt: "2026-08-25T20:30:00.000Z",
        startedAt: "2026-08-25T20:00:00.000Z",
      },
      observations: contract.outcomes.map((id, observationIndex) => ({
        evidenceSha256: String(((observationIndex + index) % 8) + 1).repeat(64),
        id,
        status: "PASS",
      })),
      providerIdentity: {
        providerAccountFingerprint: `sha256:${"a".repeat(64)}`,
        providerEnvironment: "QA_PREVIEW",
        providerLogArtifactSha256: "b".repeat(64),
        providerName,
      },
      postAcceptance: {
        cleanupEvidenceSha256: String(((index + 3) % 8) + 1).repeat(64),
        completedAt: "2026-08-25T20:31:00.000Z",
        databaseEvidenceSha256: String(((index + 4) % 8) + 1).repeat(64),
        residualLiveObjectCount: 0,
        status: "PASS",
      },
      qaTargetApproval: {
        approvedAt: "2026-08-25T19:59:30.000Z",
        purpose: contract.targetPurpose,
        status: "APPROVED",
        targetFingerprint: `sha256:${"c".repeat(64)}`,
      },
      qaTargetFingerprint: `sha256:${"c".repeat(64)}`,
      runtime: receiptRuntime,
      sourceArtifactSha256,
      sourceCollectorSha256,
      sourceCompletedAt: rawSource.completedAt,
    });
  });
  const evidenceManifest = providerAcceptanceReceipts.map((receipt) => ({
    acceptanceArtifactSha256: receipt.payload.artifactSha256,
    acceptanceId: receipt.payload.acceptanceId,
    cleanupEvidenceSha256: receipt.payload.postAcceptance.cleanupEvidenceSha256,
    databaseEvidenceSha256: receipt.payload.postAcceptance.databaseEvidenceSha256,
    providerAccountFingerprint: receipt.payload.providerIdentity.providerAccountFingerprint,
    providerLogArtifactSha256: receipt.payload.providerIdentity.providerLogArtifactSha256,
    qaTargetFingerprint: receipt.payload.qaTargetFingerprint,
    receiptId: receipt.receiptId,
    receiptRole: receipt.role,
  }));
  const providerFinalCleanupReceipt = externalGateReceipt(
    providerFinalCleanupRole,
    providerFinalCleanupRecordType,
    {
      acceptanceReceiptBundleSha256: buildProviderAcceptanceReceiptBundleSha256(providerAcceptanceReceipts),
      cleanupWindow: {
        completedAt: "2026-08-25T21:01:00.000Z",
        startedAt: "2026-08-25T21:00:00.000Z",
      },
      databaseResidualEvidenceSha256: "5".repeat(64),
      externalProviderSessionCount: 0,
      providerResidualEvidenceSha256: "6".repeat(64),
      qaBatchInventorySha256: "7".repeat(64),
      residualLiveObjectCount: 0,
      runtime: receiptRuntime,
      sourceArtifactSha256,
      sourceCollectorSha256,
      status: "PASS",
    },
    "2026-08-25T21:02:00.000Z",
  );
  return {
    ...rawSource,
    collectionMode: "LIVE_PROVIDER_ACCEPTANCE",
    completedAt: "2026-08-25T21:02:00.000Z",
    providerAcceptanceAssembly: {
      acceptanceIds: providerAcceptanceReceipts.map((receipt) => receipt.payload.acceptanceId),
      acceptanceCompletedAt: "2026-08-25T21:00:00.000Z",
      acceptanceReceiptBundleSha256: buildProviderAcceptanceReceiptBundleSha256(providerAcceptanceReceipts),
      databasePostconditionSha256,
      evidenceManifest,
      receiptPayloadSha256: providerAcceptanceReceipts.map((receipt) => receipt.payloadSha256),
      finalCleanupReceiptPayloadSha256: providerFinalCleanupReceipt.payloadSha256,
      sourceArtifactSha256,
      sourceCollectorSha256,
      sourceCompletedAt: rawSource.completedAt,
      sourceIndependentProviderLogs: "UNPROVEN",
      sourceReleaseGateStatus: "BLOCKED",
    },
    providerSideEffectPostcondition: {
      codeOrderAndHttpGate: "PASS",
      independentProviderLogs: "PASS",
      reasonCode: null,
    },
    providerAcceptanceReceipts,
    providerFinalCleanupReceipt,
    releaseGateStatus: "PASS",
  };
}

function completePublicEvidence(runtime) {
  const statuses = {
    "public-form-proof-invalid": 400,
    "public-form-shell-missing": 404,
    "public-form-submit-missing": 404,
    "public-funnel-proof-invalid": 400,
    "public-funnel-shell-missing": 404,
    "public-funnel-submit-invalid": 400,
    "public-funnel-visit-launch-off": 503,
  };
  const qaBatchId = "11111111-1111-4111-8111-111111111111";
  const cleanup = {
    createdObjectCount: 12,
    databaseCleanup: "VERIFIED_ZERO",
    deletedObjectCount: 12,
    exactPrePostContentFingerprintMatch: true,
    inventoryAfterSha256: "a".repeat(64),
    inventoryBeforeSha256: "a".repeat(64),
    qaBatchId,
    remainingObjectCount: 0,
    status: "PASS",
  };
  const cleanupInventorySha256 = gateSha256(canonicalGateJson(cleanup));
  const artifactFiles = publicRuntimeArtifactFiles.map((name, index) => ({
    name,
    sha256: name === "public-form-funnel-cleanup.json"
      ? cleanupInventorySha256
      : String((index % 8) + 1).repeat(64),
    sizeBytes: 1_000 + index,
  }));
  const protectedWorkflowArtifactManifest = {
    artifactDigest: "d".repeat(64),
    artifactName: "public-runtime-final-preview-evidence",
    files: artifactFiles,
    recordType: "NOVALURE_PUBLIC_RUNTIME_ARTIFACT_MANIFEST",
    schemaVersion: 1,
  };
  const artifactByName = new Map(artifactFiles.map((file) => [file.name, file]));
  const proofs = Object.entries(publicRuntimeProofObservations).map(([id, observationIds], proofIndex) => ({
    artifactFile: `${id}.json`,
    artifactSha256: artifactByName.get(`${id}.json`).sha256,
    candidateCommit: runtime.candidateCommit,
    cleanupInventorySha256,
    databaseInventorySha256: "f".repeat(64),
    deploymentId: runtime.deploymentId,
    id,
    observations: observationIds.map((observationId, index) => {
      const baseMinute = id.endsWith("long-proof-refresh")
        ? proofIndex
        : 30 + (proofIndex * 5);
      const elapsedMinutes = id.endsWith("long-proof-refresh") && index > 0
        ? 14 + index
        : index;
      const observedAt = new Date(Date.UTC(2026, 7, 25, 20, baseMinute + elapsedMinutes, 0)).toISOString();
      return {
      id: observationId,
      observedAt,
      responseSha256: String((index % 8) + 1).repeat(64),
      status: observationId.includes("rejected") ? 400 : 200,
      };
    }),
    qaBatchId,
    semanticEvidence: id.endsWith("long-proof-refresh")
      ? {
          idempotencyKeyAfterSha256: "a".repeat(64),
          idempotencyKeyBeforeSha256: "a".repeat(64),
          minimumElapsedSeconds: 900,
          oldProofRejectionCode: "submission_proof_expired",
        }
      : id.endsWith("live-submission")
        ? {
            createdObjectCount: 1,
            idempotencyKeySha256: "b".repeat(64),
            idempotentReplayCreatedObjectCount: 0,
            persistedObjectSha256: "c".repeat(64),
            replayResponseSha256: "d".repeat(64),
          }
        : {
            newTokenSha256: "e".repeat(64),
            oldTokenRejectionCode: "invalid_publish_token",
            oldTokenSha256: "f".repeat(64),
            publishedRevisionSha256: "a".repeat(64),
            repositoryScanSha256: "b".repeat(64),
          },
    status: "PASS",
  }));
  const parentBase = {
    blockedProofs: [],
    candidate: {
      deploymentHost: runtime.deploymentHost,
      deploymentId: runtime.deploymentId,
      gitBranch: runtime.branch,
      gitSha: runtime.candidateCommit,
      neonBranchId: "br-lucky-heart-alrm9dlw",
    },
    cleanup,
    databaseAttestation: {
      contentFingerprintDigest: "a".repeat(64),
      freshBatch: true,
      isQa: true,
      qaBatchId,
      status: "PASS",
    },
    httpReadOnlyStatus: "PASS",
    mutationGate: { reasonCode: null, status: "PASS" },
    productionMutationPerformed: false,
    proofs,
    releaseGateStatus: "PASS",
    requests: publicExpectedReadOnlyRequestIds.map((id) => ({ id, status: statuses[id] })),
    schemaVersion: gateBinding("public-form-funnel").schemaValue,
  };
  const canonicalParentBase = canonicalGateJson(parentBase);
  const parentBaseArtifact = artifactByName.get(publicRuntimeParentBaseArtifactFile);
  parentBaseArtifact.sha256 = gateSha256(canonicalParentBase);
  parentBaseArtifact.sizeBytes = Buffer.byteLength(canonicalParentBase, "utf8");
  const protectedWorkflowReceipt = externalGateReceipt(publicRuntimeWorkflowRole, publicRuntimeWorkflowRecordType, {
    artifactDigest: protectedWorkflowArtifactManifest.artifactDigest,
    artifactManifestSha256: gateSha256(canonicalGateJson(protectedWorkflowArtifactManifest)),
    attestationBundleSha256: "b".repeat(64),
    cleanupInventorySha256,
    githubRunId: "123456789012",
    proofInventorySha256: gateSha256(canonicalGateJson(proofs)),
    qaBatchId,
    runtime: gateReceiptRuntime(runtime),
    trustedHarnessSha: runtime.trustedHarnessSha,
    workflowRef: "novalure/novalure-crm/.github/workflows/livegang-e2e.yml@refs/heads/main",
    workflowSha: runtime.trustedHarnessSha,
  });
  return {
    ...parentBase,
    protectedWorkflowArtifactManifest,
    protectedWorkflowReceipt,
  };
}

function completeA11yEvidence(runtime) {
  const surfaceCount = (surface) => a11yExpectedResultKeys.filter((key) => key.startsWith(`${surface}|`)).length;
  const receiptRuntime = gateReceiptRuntime(runtime);
  const databaseProjectId = "weathered-term-98273025";
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
    recordType: "NOVALURE_ACCESSIBILITY_MANUAL_CHECK_EVIDENCE",
    result: "PASS",
    runtime: receiptRuntime,
    schemaVersion: 1,
    testedAt: `2026-08-25T20:${String(index).padStart(2, "0")}:00.000Z`,
    testerSubject: "subject:novalure:accessibility-tester:20260825",
  }));
  const manualCheckDigests = individualEvidence.map((entry) => ({
    id: entry.checkId,
    sha256: gateSha256(canonicalGateJson(entry)),
  }));
  const manualMatrix = {
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
  const coverage = {
    authenticated: { complete: true, expected: surfaceCount("authenticated"), observed: surfaceCount("authenticated") },
    authenticatedFixture: { complete: true, expected: surfaceCount("auth-fixture"), observed: surfaceCount("auth-fixture") },
    public: { complete: true, expected: surfaceCount("public"), observed: surfaceCount("public") },
    publicFixture: { complete: true, expected: surfaceCount("public-fixture"), observed: surfaceCount("public-fixture") },
  };
  const resultMatrix = {
    blocked: 0,
    blockedOrNotRun: 0,
    failed: 0,
    notRun: 0,
    passed: a11yExpectedResultKeys.length,
    total: a11yExpectedResultKeys.length,
  };
  const results = a11yExpectedResultKeys.map((key) => {
    const [surface, route, language, profile] = key.split("|");
    return {
      blocker: null,
      browserErrorCount: 0,
      consoleErrorCount: 0,
      language,
      outcome: "PASS",
      passed: true,
      profile,
      route,
      status: 200,
      surface,
    };
  });
  const runtimeIdentity = {
    attestationComplete: true,
    attestationCount: 8,
    expected: exactRuntimeIdentity(runtime),
    expectedAttestationCount: 8,
  };
  const automatedSourceSha256 = gateSha256("a11y-browser-raw-source");
  const cleanup = { browserClosed: true, complete: true, sessionLogoutFailures: 0 };
  const executionScope = {
    authSideEffects: "LOGIN_CHALLENGE_MFA_VERIFICATION_AUDIT_AND_SESSION_WRITES_EXPECTED",
    mfaEnrollment: "PROHIBITED",
    publicAndCrmBusinessData: "HTTP_WRITE_GUARD_ENFORCED",
    sessionCleanupRequired: true,
  };
  const unsafeHttpWriteGuard = { blockedAttemptCount: 0, complete: true };
  const automatedEvidence = {
    automatedSourceSha256,
    automatedSubsetPassed: true,
    automatedTechnicalPassed: true,
    browser: "chromium",
    cleanup: structuredClone(cleanup),
    coverage: structuredClone(coverage),
    endedAt: "2026-08-25T20:30:00.000Z",
    evidenceDigest: gateSha256("a11y-browser-evidence"),
    executionBlocker: null,
    executionScope: structuredClone(executionScope),
    expectedSha: runtime.candidateCommit,
    generatedAt: "2026-08-25T20:30:00.000Z",
    matrix: structuredClone(resultMatrix),
    mode: "RELEASE_GATE",
    productionMutationPerformed: false,
    releaseSurfaceManifestVerified: true,
    results: structuredClone(results),
    runtimeIdentity: structuredClone(runtimeIdentity),
    schemaVersion: 4,
    startedAt: "2026-08-25T19:30:00.000Z",
    targetHost: runtime.deploymentHost,
    unsafeHttpWriteGuard: structuredClone(unsafeHttpWriteGuard),
    wcagStandard: "WCAG 2.2 AA automated subset plus signed manual acceptance",
  };
  const retainedInventory = (phase) => {
    const tables = Object.fromEntries(a11yRetainedTableNames.map((name) => [name, {
      digest: gateSha256(`${name}-${phase}`),
      rowCount: phase === "before" ? 1 : 2,
    }]));
    return {
      digest: gateSha256(canonicalGateJson(tables)),
      rowCount: Object.values(tables).reduce((sum, table) => sum + table.rowCount, 0),
      tables,
    };
  };
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
  const fixtureLifecycle = {
    browserEvidence: {
      fileName: "a11y-browser-matrix.json",
      sha256: automatedSourceSha256,
      sidecarFileName: "a11y-browser-matrix.json.sha256",
      sidecarSha256: gateSha256("a11y-browser-sidecar"),
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
    completedAt: "2026-08-25T20:30:00.000Z",
    database: {
      operationalAfter: { digest: "7".repeat(64), rowCount: 10 },
      operationalBefore: { digest: "7".repeat(64), rowCount: 10 },
      retainedAfter: retainedInventory("after"),
      retainedBefore: retainedInventory("before"),
      targetDigest: `sha256:${gateSha256("preview-database-target")}`,
    },
    deploymentHost: runtime.deploymentHost,
    deploymentId: runtime.deploymentId,
    gitBranch: runtime.branch,
    neonBranchId: runtime.databaseBranchId,
    neonProjectId: databaseProjectId,
    productionMutationPerformed: false,
    recordType: a11yFixtureLifecycleRecordType,
    runId: "a11y-run-12345678-1234-4123-8123-123456789012",
    schemaVersion: 1,
    status: "PASS",
  };
  const fixtureLifecycleSha256 = gateSha256(canonicalGateJson(fixtureLifecycle));
  const approvalReceipts = Object.fromEntries(accessibilityApprovalRoles.map((expected) => [
    expected.receiptRole,
    externalGateReceipt(expected.receiptRole, expected.recordType, {
      approval: "APPROVED",
      approvalRole: expected.approvalRole,
      automatedEvidenceSha256: gateSha256(canonicalGateJson(automatedEvidence)),
      databaseProjectId,
      fixtureLifecycleSha256,
      individualEvidenceBundleSha256: gateSha256(canonicalGateJson(manualCheckDigests)),
      manualCheckDigests,
      matrixSha256: gateSha256(canonicalGateJson(manualMatrix)),
      runtime: receiptRuntime,
    }),
  ]));
  return {
    acceptance: {
      contractComplete: true,
      manualAcceptancePassed: true,
      manualCheckCount: accessibilityRequiredManualCheckIds.length,
      manualPassCount: accessibilityRequiredManualCheckIds.length,
      matrixSigned: true,
      signatureCount: accessibilityApprovalRoles.length,
      signaturesComplete: true,
      status: "SIGNED",
    },
    automatedSourceSha256,
    automatedSubsetPassed: true,
    automatedTechnicalPassed: true,
    browser: "chromium",
    cleanup,
    coverage,
    endedAt: automatedEvidence.endedAt,
    evidenceDigest: automatedEvidence.evidenceDigest,
    executionBlocker: null,
    executionScope,
    expectedSha: runtime.candidateCommit,
    generatedAt: automatedEvidence.generatedAt,
    matrix: resultMatrix,
    manualAcceptance: {
      approvalReceipts,
      automatedEvidence,
      databaseProjectId,
      fixtureLifecycle,
      fixtureLifecycleSha256,
      individualEvidence,
      matrix: manualMatrix,
    },
    mode: "RELEASE_GATE",
    productionMutationPerformed: false,
    releasePassed: true,
    releaseSurfaceManifestVerified: true,
    results,
    runtimeIdentity,
    schemaVersion: gateBinding("accessibility-browser").schemaValue,
    startedAt: automatedEvidence.startedAt,
    targetHost: runtime.deploymentHost,
    unsafeHttpWriteGuard,
    wcagStandard: automatedEvidence.wcagStandard,
  };
}

function completePerformanceEvidence(runtime) {
  const expected = exactRuntimeIdentity(runtime);
  const policySha256 = createHash("sha256").update(canonicalJson(finalPerformanceBudgetPolicy)).digest("hex");
  const receiptRuntime = gateReceiptRuntime(runtime);
  const evidence = {
    authenticatedCoverageComplete: true,
    baseOrigin: `https://${runtime.deploymentHost}`,
    budgetApprovalStatus: "SIGNED",
    budgetApprovalReceipts: Object.fromEntries(performanceBudgetApprovalRoles.map((expected) => [
      expected.approvalRole,
      externalGateReceipt(
        expected.receiptRole,
        performanceBudgetApprovalRecordType,
        {
          approval: "APPROVED",
          approvalRole: expected.approvalRole,
          budgetPolicySha256: policySha256,
          runtime: receiptRuntime,
        },
      ),
    ])),
    budgetPolicySha256: policySha256,
    cleanup: { browserProfileRemoved: true, complete: true, qaSessionLogout: "LOGGED_OUT" },
    executionBlocker: null,
    expectedSha: runtime.candidateCommit,
    manualAndRumGatesComplete: true,
    manualGates: {
      mobileAssistiveTechnology: "PASS",
      screenReader: "PASS",
      zoomAndReflow: "PASS",
    },
    productionMutationPerformed: false,
    publicCoverageComplete: true,
    realUserMonitoring: { status: "PASS" },
    releasePassed: true,
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
    schemaVersion: gateBinding("performance").schemaValue,
    signaturesPresent: true,
    technicalPassed: true,
  };
  evidence.technicalEvidenceSha256 = buildPerformanceTechnicalEvidenceSha256(evidence);
  const manualAcceptanceReceipt = externalGateReceipt(
    performanceManualAcceptanceRole,
    performanceManualAcceptanceRecordType,
    {
      artifactSha256: evidence.technicalEvidenceSha256,
      budgetPolicySha256: policySha256,
      manualGates: performanceManualGateIds.map((id, index) => ({
        evidenceSha256: String((index % 8) + 1).repeat(64),
        id,
        status: "PASS",
      })),
      observationWindow: {
        completedAt: "2026-08-25T20:30:00.000Z",
        startedAt: "2026-08-25T20:00:00.000Z",
      },
      runtime: receiptRuntime,
    },
  );
  const realUserMonitoringReceipt = externalGateReceipt(
    performanceRumAcceptanceRole,
    performanceRumAcceptanceRecordType,
    {
      artifactSha256: evidence.technicalEvidenceSha256,
      budgetPolicySha256: policySha256,
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
      runtime: receiptRuntime,
      sampleCount: 250,
    },
  );
  return { ...evidence, manualAcceptanceReceipt, realUserMonitoringReceipt };
}

function completeCompanyProfileApproval(attestation) {
  const runtime = gateReceiptRuntime({
    ...attestation.runtime,
    branch: attestation.runtime.branch,
  });
  const profileSnapshot = {
    approval: {
      approvedAt: "2026-08-25T20:30:00.000Z",
      approverSubject: signingKeys[companyProfileApprovalRole].signerSubject,
      status: "APPROVED",
    },
    audit: {
      eventIdSha256: "1".repeat(64),
      eventSha256: "2".repeat(64),
      eventType: "COMPANY_PROFILE_APPROVED_LOCKED",
      occurredAt: "2026-08-25T20:30:00.000Z",
      previousVersion: 6,
      profileVersion: 7,
    },
    contentSha256: "3".repeat(64),
    countryCode: "AT",
    locked: true,
    profileIdSha256: "4".repeat(64),
    profileVersion: 7,
    recordType: companyProfileSnapshotRecordType,
    runtime,
    schemaVersion: 1,
    validation: {
      countryPreflight: "PASS",
      missingRequiredFields: 0,
      requiredFields: "PASS",
    },
    workspaceIdSha256: "5".repeat(64),
  };
  const approvalReceipt = externalGateReceipt(
    companyProfileApprovalRole,
    companyProfileApprovalRecordType,
    {
      approvalStatus: "APPROVED",
      approvedAt: profileSnapshot.approval.approvedAt,
      auditEventSha256: profileSnapshot.audit.eventSha256,
      locked: true,
      profileSnapshotSha256: gateSha256(canonicalGateJson(profileSnapshot)),
      profileVersion: profileSnapshot.profileVersion,
      runtime,
      workspaceIdSha256: profileSnapshot.workspaceIdSha256,
    },
  );
  return {
    approvalReceipt,
    candidateCommit: attestation.runtime.candidateCommit,
    deploymentId: attestation.runtime.deploymentId,
    productionMutationPerformed: false,
    profileSnapshot,
    recordType: "NOVALURE_COMPANY_PROFILE_APPROVAL_DOCUMENT",
    schemaVersion: 1,
  };
}

function completeOperationalGateEvidence(bindingId, runtime) {
  const operationalId = {
    "cleanup-null-rest": "cleanup",
    observability: "observability",
    "runtime-logs": "runtime-logs",
    "security-supply-chain": "supply-chain",
  }[bindingId];
  const specification = operationalGateSpecifications[operationalId];
  const assertionIds = {
    "cleanup-null-rest": ["blob", "database", "externalProviders", "sessions"],
    observability: ["alertDelivery", "errorIngestion", "runtimeAlerting", "syntheticAlarm"],
    "runtime-logs": ["boundedWindow", "noUnhandledErrors", "requestCorrelation", "targetDeploymentOnly"],
    "security-supply-chain": ["dependencyAudit", "licensePolicy", "pinnedActions", "sast", "secretScan"],
  }[bindingId];
  const window = {
    endedAt: "2026-08-25T20:45:00.000Z",
    startedAt: "2026-08-25T20:15:00.000Z",
  };
  const operationalReceipt = externalGateReceipt(
    specification.role,
    specification.recordType,
    {
      gateId: operationalId,
      observations: specification.observationIds.map((id, index) => ({
        evidenceSha256: String((index % 8) + 1).repeat(64),
        id,
        observedAt: `2026-08-25T20:${String(16 + index).padStart(2, "0")}:00.000Z`,
        sourceRecordIdSha256: String(((index + 1) % 8) + 1).repeat(64),
        status: "PASS",
      })),
      runtime: gateReceiptRuntime(runtime),
      source: {
        artifactSha256: "a".repeat(64),
        provider: specification.provider,
        runAttempt: 1,
        runId: `${operationalId.replaceAll("-", "_")}-20260825`,
        runUrlSha256: "b".repeat(64),
        sourceType: specification.sourceType,
      },
      window,
    },
  );
  return {
    assertions: Object.fromEntries(assertionIds.map((id) => [id, "PASS"])),
    candidateCommit: runtime.candidateCommit,
    databaseBranchId: runtime.databaseBranchId,
    deploymentHost: runtime.deploymentHost,
    deploymentId: runtime.deploymentId,
    gitBranch: runtime.branch,
    operationalReceipt,
    productionMutationPerformed: false,
    schema: gateBinding(bindingId).schemaValue,
    status: "PASS",
  };
}

function git(root, args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
  return String(result.stdout ?? "").trim();
}

async function createProvenanceRepository({ evidenceCodeDrift = false } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "novalure-attestation-git-"));
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "attestation-tests@novalure.invalid"]);
  git(root, ["config", "user.name", "Novalure Attestation Tests"]);
  await writeFile(path.join(root, "baseline.txt"), "baseline\n", "utf8");
  git(root, ["add", "baseline.txt"]);
  git(root, ["commit", "-q", "-m", "baseline"]);
  const candidateCommit = git(root, ["rev-parse", "HEAD"]);

  const runId = "run-20260823T210000Z-bbbbbbbbbbbb";
  const runDirectory = `docs/audit/2026-08-23/final-evidence/runs/${runId}`;
  const evidencePath = `${runDirectory}/evidence.json`;
  const sidecarPath = `${evidencePath}.sha256`;
  await mkdir(path.join(root, ...runDirectory.split("/")), { recursive: true });
  await writeFile(path.join(root, ...evidencePath.split("/")), "{\"status\":\"PASS\"}\n", "utf8");
  await writeFile(path.join(root, ...sidecarPath.split("/")), `${"a".repeat(64)}  evidence.json\n`, "utf8");
  if (evidenceCodeDrift) {
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, "src", "unexpected-runtime-change.ts"), "export const drift = true;\n", "utf8");
    git(root, ["add", "src/unexpected-runtime-change.ts"]);
  }
  git(root, ["add", runDirectory]);
  git(root, ["commit", "-q", "-m", "freeze evidence"]);
  const evidenceCommit = git(root, ["rev-parse", "HEAD"]);

  const attestationPath = `${runDirectory}/final-preview-release-attestation.json`;
  const attestation = {
    documents: [{ path: evidencePath, sidecarPath }],
    evidenceProvenance: {
      evidenceCommit,
      repositoryState: "CLEAN_TRACKED",
      runDirectory,
      runId,
    },
    gateEvidence: [],
    signatures: {},
    status: "EVIDENCE_FROZEN",
    runtime: { candidateCommit },
  };
  await writeFile(
    path.join(root, ...attestationPath.split("/")),
    `${JSON.stringify(attestation, null, 2)}\n`,
    "utf8",
  );
  git(root, ["add", runDirectory]);
  git(root, ["commit", "-q", "-m", "track attestation"]);
  return { attestation, attestationPath, candidateCommit, evidencePath, root };
}

const [template, schema, releaseSurfaceManifest, releaseGateMatrix, legalContentManifest, verifierSource] =
  await Promise.all([
    readFile(
      "docs/audit/2026-08-23/final-preview-release-attestation.template.json",
      "utf8",
    ).then(JSON.parse),
    readFile(
      "docs/audit/2026-08-23/final-preview-release-attestation.schema.json",
      "utf8",
    ).then(JSON.parse),
    readFile("docs/audit/2026-08-23/release-surface-manifest.json", "utf8").then(JSON.parse),
    readFile("docs/audit/2026-08-23/release-gate-matrix.json", "utf8").then(JSON.parse),
    readFile("docs/audit/2026-08-23/legal-content-manifest.json", "utf8").then(JSON.parse),
    readFile("scripts/final-preview-release-attestation-contract.mjs", "utf8"),
  ]);

function frozenFixture(candidateCommit = "a".repeat(40)) {
  const fixture = structuredClone(template);
  fixture.status = "EVIDENCE_FROZEN";
  fixture.runtime.candidateCommit = candidateCommit;
  fixture.runtime.databaseBranchId = "br-lucky-heart-alrm9dlw";
  fixture.runtime.deploymentId = "dpl_FinalPreviewContract1";
  fixture.runtime.deploymentHost = "novalure-final-preview.vercel.app";
  fixture.runtime.shaIdentityStatus = "PASS";
  fixture.runtime.startedAt = "2026-08-23T20:00:00.000Z";
  fixture.runtime.completedAt = "2026-08-23T20:30:00.000Z";
  fixture.runtime.trustedHarnessSha = "b".repeat(40);
  fixture.evidenceProvenance = {
    evidenceCommit: "c".repeat(40),
    repositoryState: "CLEAN_TRACKED",
    runDirectory: "docs/audit/2026-08-23/final-evidence/runs/run-20260823T200000Z-aaaaaaaaaaaa",
    runId: "run-20260823T200000Z-aaaaaaaaaaaa",
  };
  fixture.documents.forEach((binding, index) => {
    binding.sha256 = String(index + 1).repeat(64);
    binding.verificationStatus = "PASS";
  });
  fixture.documentBundleSha256 = "f".repeat(64);
  return fixture;
}

function bindGate(fixture, index, status = "BLOCKED") {
  const binding = finalPreviewGateBindings[index];
  const evidencePath = `${fixture.evidenceProvenance.runDirectory}/${binding.fileName}`;
  Object.assign(fixture.gateEvidence[index], {
    candidateJsonPointer: binding.candidateJsonPointer,
    path: evidencePath,
    sha256: String((index % 9) + 1).repeat(64),
    sidecarPath: `${evidencePath}.sha256`,
    status,
    statusJsonPointer: binding.statusJsonPointer,
  });
}

function signatureFor(fixture, role, overrides = {}) {
  const key = signingKeys[role];
  const signature = {
    acceptedRiskReferences: [],
    approvalScopes: approvalScopesByRole[role],
    approvalArtifactPath: `${fixture.evidenceProvenance.runDirectory}/approvals/${role}.json`,
    approvalArtifactSha256: "e".repeat(64),
    approvalArtifactSidecarPath: `${fixture.evidenceProvenance.runDirectory}/approvals/${role}.json.sha256`,
    candidateCommit: fixture.runtime.candidateCommit,
    decision: fixture.decision,
    detachedSignature: null,
    deploymentId: fixture.runtime.deploymentId,
    documentBundleSha256: fixture.documentBundleSha256,
    keyId: key.keyId,
    name: `${role} approver`,
    role,
    signatureAlgorithm: "Ed25519",
    signatureReference: `urn:novalure:release-approval:v2:${trustAnchorId}:${key.keyId}:${role}:${fixture.documentBundleSha256}`,
    signerSubject: key.signerSubject,
    signedAt: "2026-08-23T20:31:00.000Z",
    trustAnchorId,
    ...overrides,
  };
  signature.detachedSignature = signDetached(
    null,
    Buffer.from(buildExternalApprovalSigningPayload(signature), "utf8"),
    key.privateKey,
  ).toString("base64");
  return signature;
}

function signedFixture({ allGatesPass = false, decision = "CONDITIONAL_GO", documentDigests = {} } = {}) {
  const fixture = frozenFixture();
  fixture.decision = decision;
  if (allGatesPass) fixture.gateEvidence.forEach((_, index) => bindGate(fixture, index, "PASS"));
  for (const [documentId, digest] of Object.entries(documentDigests)) {
    const binding = fixture.documents.find((entry) => entry.id === documentId);
    assert.ok(binding, `Unknown final document binding: ${documentId}`);
    binding.sha256 = digest;
  }
  fixture.approvalTrust = {
    trustAnchorId,
    trustAnchorSha256,
    verificationMode: "ED25519_DETACHED",
  };
  fixture.documentBundleSha256 = buildFinalPreviewDocumentBundleSha256(fixture);
  fixture.status = "SIGNED";
  for (const role of signatureRoles) {
    fixture.signatures[role] = signatureFor(fixture, role);
  }
  return fixture;
}

function externalApprovalArtifact(signature) {
  return {
    acceptedRiskReferences: signature.acceptedRiskReferences,
    approvalScopes: signature.approvalScopes,
    candidateCommit: signature.candidateCommit,
    decision: signature.decision,
    deploymentId: signature.deploymentId,
    documentBundleSha256: signature.documentBundleSha256,
    detachedSignature: signature.detachedSignature,
    keyId: signature.keyId,
    name: signature.name,
    recordType: "NOVALURE_EXTERNAL_RELEASE_APPROVAL",
    role: signature.role,
    schemaVersion: 2,
    signatureAlgorithm: signature.signatureAlgorithm,
    signatureReference: signature.signatureReference,
    signerSubject: signature.signerSubject,
    signedAt: signature.signedAt,
    trustAnchorId: signature.trustAnchorId,
  };
}

test("final Preview attestation template is explicitly PENDING and claims no execution", async () => {
  const result = await verifyFinalPreviewReleaseAttestation();
  assert.deepEqual(result, {
    candidateCommit: null,
    decision: "NO-GO",
    ok: true,
    status: "PENDING",
    verificationStatus: "NOT_RUN",
  });
  assert.equal(template.runtime.candidateCommit, null);
  assert.equal(template.runtime.deploymentId, null);
  assert.equal(template.documentBundleSha256, null);
  assert.ok(template.documents.every((binding) => binding.verificationStatus === "NOT_RUN"));
  assert.ok(template.gateEvidence.every((entry) => entry.status === "NOT_RUN"));
  assert.ok(Object.values(template.signatures).every((signature) => signature === null));
  await assert.rejects(
    verifyFinalPreviewReleaseAttestation({ requireGo: true }),
    /FINAL_ATTESTATION_GO_REQUIRED/u,
  );
});

test("attestation schema and runtime contract freeze the complete document and gate inventory", () => {
  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.properties.status.enum, ["PENDING", "EVIDENCE_FROZEN", "SIGNED"]);
  assert.equal(schema.properties.documents.minItems, finalPreviewDocumentBindings.length);
  assert.equal(schema.properties.documents.maxItems, finalPreviewDocumentBindings.length);
  assert.equal(schema.properties.gateEvidence.minItems, finalPreviewGateIds.length);
  assert.equal(schema.properties.gateEvidence.maxItems, finalPreviewGateIds.length);
  assert.deepEqual(template.documents.map((binding) => binding.id), finalPreviewDocumentBindings.map((binding) => binding.id));
  assert.deepEqual(template.gateEvidence.map((entry) => entry.id), finalPreviewGateIds);
  assert.equal(new Set(finalPreviewGateBindings.map((binding) => binding.fileName)).size, finalPreviewGateBindings.length);
  assert.ok(schema.$defs.signature.required.includes("approvalArtifactSha256"));
  assert.ok(schema.$defs.signature.required.includes("decision"));
});

test("release and Legal candidate checks derive from the attested runtime SHA", () => {
  const candidateCommit = "b".repeat(40);
  const attestation = frozenFixture(candidateCommit);
  const surfaces = { ...releaseSurfaceManifest, candidateCommit };
  const matrix = { ...releaseGateMatrix, candidateCommit };
  const legal = { ...legalContentManifest, candidateCommit };

  assert.deepEqual(
    validateReleaseDocumentCandidateState({
      attestation,
      companyProfileApproval: { candidateCommit },
      legalContentManifest: legal,
      releaseGateMatrix: matrix,
      releaseSurfaceManifest: surfaces,
    }),
    { candidateCommit, status: "EVIDENCE_FROZEN" },
  );
  assert.match(buildFinalPreviewDocumentBundleSha256(attestation), /^[a-f0-9]{64}$/u);
});

test("an old evidence document cannot be relabelled by changing only the attestation candidate", () => {
  const oldCandidate = "c".repeat(40);
  const newCandidate = "d".repeat(40);
  assert.throws(
    () => assertEvidenceCandidateBinding({
      candidateJsonPointer: "/candidateCommit",
      evidenceDocument: { candidateCommit: oldCandidate },
      runtimeCandidateCommit: newCandidate,
    }),
    /FINAL_ATTESTATION_EVIDENCE_CANDIDATE_MISMATCH/u,
  );

  const attestation = frozenFixture(newCandidate);
  assert.throws(
    () => validateReleaseDocumentCandidateState({
      attestation,
      companyProfileApproval: { candidateCommit: newCandidate },
      legalContentManifest: { ...legalContentManifest, candidateCommit: oldCandidate },
      releaseGateMatrix: { ...releaseGateMatrix, candidateCommit: newCandidate },
      releaseSurfaceManifest: { ...releaseSurfaceManifest, candidateCommit: newCandidate },
    }),
    /FINAL_ATTESTATION_EVIDENCE_CANDIDATE_MISMATCH/u,
  );
});

test("NOT_RUN evidence cannot carry a path, digest or implied PASS", () => {
  const invalid = structuredClone(template);
  invalid.gateEvidence[0].path = "artifacts/qa/old-evidence.json";
  invalid.gateEvidence[0].sha256 = "e".repeat(64);
  assert.throws(
    () => validateFinalPreviewReleaseAttestation(invalid),
    /FINAL_ATTESTATION_NOT_RUN_GATE_CLAIMS_EVIDENCE/u,
  );
});

test("GO cannot be claimed before every gate and real signature are bound", () => {
  const invalid = frozenFixture();
  invalid.decision = "GO";
  assert.throws(
    () => validateFinalPreviewReleaseAttestation(invalid),
    /FINAL_ATTESTATION_GO_NOT_SIGNED/u,
  );
});

test("bundle digest canonically binds decision, runtime, documents and every gate claim", () => {
  const baseline = frozenFixture();
  const baselineDigest = buildFinalPreviewDocumentBundleSha256(baseline);
  const mutations = [
    (fixture) => { fixture.decision = "CONDITIONAL_GO"; },
    (fixture) => { fixture.runtime.completedAt = "2026-08-23T20:31:00.000Z"; },
    (fixture) => { fixture.documents[0].sha256 = "a".repeat(64); },
    (fixture) => { bindGate(fixture, 0, "BLOCKED"); },
  ];
  for (const mutate of mutations) {
    const fixture = frozenFixture();
    mutate(fixture);
    assert.notEqual(buildFinalPreviewDocumentBundleSha256(fixture), baselineDigest);
  }
});

test("each gate is bound to its fixed artifact and candidate/status pointer mapping", () => {
  const valid = frozenFixture();
  bindGate(valid, 1);
  assert.doesNotThrow(() => validateFinalPreviewReleaseAttestation(valid));

  const wrongPath = structuredClone(valid);
  wrongPath.gateEvidence[1].path = `${valid.evidenceProvenance.runDirectory}/${finalPreviewGateBindings[2].fileName}`;
  assert.throws(
    () => validateFinalPreviewReleaseAttestation(wrongPath),
    /FINAL_ATTESTATION_GATE_PATH_MAPPING_INVALID/u,
  );
  const wrongPointer = structuredClone(valid);
  wrongPointer.gateEvidence[1].statusJsonPointer = "/status";
  assert.throws(
    () => validateFinalPreviewReleaseAttestation(wrongPointer),
    /FINAL_ATTESTATION_GATE_STATUS_POINTER_INVALID/u,
  );
});

test("signature slots enforce role, decision, unique external artifact and immutable reference", () => {
  const valid = signedFixture();
  assert.doesNotThrow(() => validateFinalPreviewReleaseAttestation(valid, { trustContext }));

  const wrongRole = structuredClone(valid);
  wrongRole.signatures.product.role = "engineering";
  assert.throws(
    () => validateFinalPreviewReleaseAttestation(wrongRole, { trustContext }),
    /FINAL_ATTESTATION_SIGNATURE_ROLE_INVALID/u,
  );
  const reused = structuredClone(valid);
  reused.signatures.engineering.approvalArtifactPath = reused.signatures.product.approvalArtifactPath;
  reused.signatures.engineering.approvalArtifactSidecarPath = reused.signatures.product.approvalArtifactSidecarPath;
  assert.throws(
    () => validateFinalPreviewReleaseAttestation(reused, { trustContext }),
    /FINAL_ATTESTATION_SIGNATURE_ARTIFACT_RUN_PATH_INVALID/u,
  );
  const staleDecision = structuredClone(valid);
  staleDecision.signatures.security.decision = "NO-GO";
  assert.throws(
    () => validateFinalPreviewReleaseAttestation(staleDecision, { trustContext }),
    /FINAL_ATTESTATION_SIGNATURE_DECISION_MISMATCH/u,
  );
});

test("SIGNED approvals require the out-of-repository Ed25519 trust anchor and reject invented references", () => {
  const valid = signedFixture();
  assert.doesNotThrow(() => validateApprovalTrustAnchor(trustAnchor, trustAnchorSha256));
  assert.throws(
    () => validateFinalPreviewReleaseAttestation(valid),
    /FINAL_ATTESTATION_TRUST_CONTEXT_REQUIRED/u,
  );

  const urlReference = structuredClone(valid);
  urlReference.signatures.product.signatureReference = "https://example.test/self-asserted-approval";
  assert.throws(
    () => validateFinalPreviewReleaseAttestation(urlReference, { trustContext }),
    /FINAL_ATTESTATION_SIGNATURE_REFERENCE_INVALID/u,
  );

  const oldUrn = structuredClone(valid);
  oldUrn.signatures.product.signatureReference = "urn:novalure:release-approval:product:20260823";
  assert.throws(
    () => validateFinalPreviewReleaseAttestation(oldUrn, { trustContext }),
    /FINAL_ATTESTATION_SIGNATURE_REFERENCE_INVALID/u,
  );

  const tampered = structuredClone(valid);
  tampered.signatures.product.detachedSignature = `${tampered.signatures.product.detachedSignature.slice(0, -4)}AAAA`;
  assert.throws(
    () => validateFinalPreviewReleaseAttestation(tampered, { trustContext }),
    /FINAL_ATTESTATION_SIGNATURE_(?:VALUE_INVALID|CRYPTOGRAPHIC_VERIFICATION_FAILED)/u,
  );

  const wrongDigest = structuredClone(valid);
  wrongDigest.approvalTrust.trustAnchorSha256 = "d".repeat(64);
  assert.throws(
    () => validateFinalPreviewReleaseAttestation(wrongDigest, { trustContext }),
    /FINAL_ATTESTATION_TRUST_ANCHOR_DIGEST_MISMATCH/u,
  );
});

test("approval trust-anchor loading pins one bounded external file and rejects hardlink aliases", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "novalure-release-trust-anchor-"));
  try {
    const anchorPath = path.join(directory, "release-trust-anchor.json");
    await writeFile(anchorPath, trustAnchorSource, { encoding: "utf8", flag: "wx" });
    const loaded = await readApprovalTrustContext({
      approvalTrustAnchorPath: anchorPath,
      expectedApprovalTrustAnchorSha256: trustAnchorSha256,
    });
    assert.equal(loaded.anchor.trustAnchorId, trustAnchor.trustAnchorId);
    assert.equal(loaded.expectedSha256, trustAnchorSha256);

    const aliasPath = path.join(directory, "release-trust-anchor-alias.json");
    try {
      await link(anchorPath, aliasPath);
    } catch (error) {
      if (["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) {
        t.diagnostic(`Hardlinks are unavailable (${error.code}).`);
        return;
      }
      throw error;
    }
    await assert.rejects(
      readApprovalTrustContext({
        approvalTrustAnchorPath: aliasPath,
        expectedApprovalTrustAnchorSha256: trustAnchorSha256,
      }),
      /FINAL_ATTESTATION_TRUST_ANCHOR_NOT_BOUNDED_SINGLE_LINK_FILE/u,
    );
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("external approval content and digest are verified fail closed", async () => {
  const attestation = signedFixture();
  const role = "product";
  const directory = await mkdtemp(path.join(process.cwd(), "artifacts", "qa", "final-approval-test-"));
  try {
    const artifactPath = path.join(directory, "product.json");
    const source = `${JSON.stringify(externalApprovalArtifact(attestation.signatures[role]), null, 2)}\n`;
    const digest = createHash("sha256").update(source).digest("hex");
    const relativePath = path.relative(process.cwd(), artifactPath).replaceAll("\\", "/");
    await writeFile(artifactPath, source, { encoding: "utf8", flag: "wx" });
    await writeFile(`${artifactPath}.sha256`, `${digest}  product.json\n`, { encoding: "utf8", flag: "wx" });
    const signature = {
      ...attestation.signatures[role],
      approvalArtifactPath: relativePath,
      approvalArtifactSha256: digest,
      approvalArtifactSidecarPath: `${relativePath}.sha256`,
    };
    validateExternalApprovalArtifact({
      artifact: externalApprovalArtifact(signature),
      attestation,
      role,
      signature,
    });
    await verifyExternalApprovalArtifact({ attestation, role, signature });
    await writeFile(artifactPath, `${source} `, "utf8");
    await assert.rejects(
      verifyExternalApprovalArtifact({ attestation, role, signature }),
      /FINAL_ATTESTATION_APPROVAL_ARTIFACT_DIGEST_MISMATCH/u,
    );
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("approval artifacts and sidecars cannot enter through repository symlinks", async (t) => {
  const attestation = signedFixture();
  const role = "product";
  const externalDirectory = await mkdtemp(path.join(tmpdir(), "novalure-attestation-external-"));
  await mkdir(path.join(process.cwd(), "artifacts", "qa"), { recursive: true });
  const repositoryDirectory = await mkdtemp(path.join(process.cwd(), "artifacts", "qa", "attestation-link-test-"));
  try {
    const source = `${JSON.stringify(externalApprovalArtifact(attestation.signatures[role]), null, 2)}\n`;
    const digest = createHash("sha256").update(source).digest("hex");
    const externalArtifactPath = path.join(externalDirectory, "product.json");
    let linkedArtifactPath = path.join(repositoryDirectory, "product.json");
    let expectedError = /FINAL_ATTESTATION_REPOSITORY_FILE_NOT_REGULAR/u;
    await writeFile(externalArtifactPath, source, "utf8");
    await writeFile(`${externalArtifactPath}.sha256`, `${digest}  product.json\n`, "utf8");
    try {
      await symlink(externalArtifactPath, linkedArtifactPath, "file");
    } catch (error) {
      if (["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) {
        const linkedDirectory = path.join(repositoryDirectory, "external-junction");
        try {
          await symlink(externalDirectory, linkedDirectory, "junction");
        } catch (junctionError) {
          if (["EPERM", "EACCES", "ENOTSUP"].includes(junctionError?.code)) {
            t.skip(`File symlinks and directory junctions are unavailable (${junctionError.code}).`);
            return;
          }
          throw junctionError;
        }
        linkedArtifactPath = path.join(linkedDirectory, "product.json");
        expectedError = /FINAL_ATTESTATION_REPOSITORY_FILE_REALPATH_ESCAPED/u;
      } else {
        throw error;
      }
    }
    if (path.dirname(linkedArtifactPath) === repositoryDirectory) {
      await writeFile(`${linkedArtifactPath}.sha256`, `${digest}  product.json\n`, "utf8");
    }
    const relativePath = path.relative(process.cwd(), linkedArtifactPath).replaceAll("\\", "/");
    const signature = {
      ...attestation.signatures[role],
      approvalArtifactPath: relativePath,
      approvalArtifactSha256: digest,
      approvalArtifactSidecarPath: `${relativePath}.sha256`,
    };
    await assert.rejects(
      verifyExternalApprovalArtifact({ attestation, role, signature }),
      expectedError,
    );
  } finally {
    await rm(repositoryDirectory, { force: true, recursive: true });
    await rm(externalDirectory, { force: true, recursive: true });
  }
});

test("Blob and generic release gates cannot convert incomplete technical evidence into PASS", () => {
  const blobBinding = finalPreviewGateBindings.find((binding) => binding.id === "preview-blob-lifecycle");
  const blob = {
    cleanup: { verifiedAbsent: true },
    deployment: { gitSha: "a".repeat(40) },
    independentStoreProof: { status: "VERIFIED" },
    legacyObjectMigrationProof: { status: "UNPROVEN" },
    releaseGatePassed: false,
    schema: blobBinding.schemaValue,
    status: "BLOCKED",
    technicalStatus: "PASS",
  };
  assert.equal(observedFinalPreviewGateStatus(blobBinding, blob, gateRuntime()), "BLOCKED");
  blob.releaseGatePassed = true;
  blob.status = "PASS";
  blob.legacyObjectMigrationProof.status = "VERIFIED";
  assert.throws(
    () => observedFinalPreviewGateStatus(blobBinding, blob, gateRuntime()),
    /FINAL_ATTESTATION_BLOB_/u,
  );

  const securityBinding = finalPreviewGateBindings.find((binding) => binding.id === "security-supply-chain");
  assert.throws(
    () => observedFinalPreviewGateStatus(securityBinding, {
      assertions: { dependencyAudit: "PASS" },
      candidateCommit: "a".repeat(40),
      databaseBranchId: "br-lucky-heart-alrm9dlw",
      deploymentId: "dpl_12345678901234567890",
      deploymentHost: "candidate-preview-novalure.vercel.app",
      gitBranch: "codex/go-live-remediation-20260822",
      productionMutationPerformed: false,
      schema: securityBinding.schemaValue,
      status: "PASS",
    }, gateRuntime()),
    /FINAL_ATTESTATION_GATE_ASSERTIONS_INCOMPLETE/u,
  );
});

test("Database recovery requires schema-v2 live receipts and a real empty schema diff", () => {
  const binding = finalPreviewGateBindings.find((entry) => entry.id === "database-recovery");
  const document = {
    evidence: [{ passEligible: false, role: "FINAL_LIVE_COLLECTOR_PASS" }],
    schemaDiffApi: {
      countedAsPassEvidence: false,
      diffSha256: null,
      status: "UNAVAILABLE_HTTP_413_TOOL_LIMIT",
    },
    schemaVersion: binding.schemaValue,
    status: "RECOVERY_BLOCKED_UNPROVEN",
  };
  assert.equal(observedFinalPreviewGateStatus(binding, document, gateRuntime()), "BLOCKED");
  document.status = "CURRENT_SHA_REHEARSAL_AND_RESET_PASS";
  assert.equal(observedFinalPreviewGateStatus(binding, document, gateRuntime()), "FAIL");
  document.evidence[0].passEligible = true;
  document.schemaDiffApi = {
    countedAsPassEvidence: true,
    diffSha256: createHash("sha256").update("").digest("hex"),
    status: "PASS_EMPTY",
  };
  assert.equal(observedFinalPreviewGateStatus(binding, document, gateRuntime()), "PASS");
});

test("Final GO requires the exact verified Recovery result from the attested Evidence commit", () => {
  const evidenceCommit = "c".repeat(40);
  const verified = {
    evidenceCommit,
    passEligible: true,
    signatureStatus: "VERIFIED",
    status: "PASS",
  };
  assert.equal(
    assertFinalPreviewRecoveryGoResult(verified, { expectedEvidenceCommit: evidenceCommit }),
    verified,
  );
  for (const [mutation, expectedError] of [
    [{ status: "BLOCKED" }, /FINAL_ATTESTATION_GO_RECOVERY_STATUS_NOT_PASS/u],
    [{ passEligible: false }, /FINAL_ATTESTATION_GO_RECOVERY_NOT_PASS_ELIGIBLE/u],
    [
      { signatureStatus: "PENDING_SIGNATURE" },
      /FINAL_ATTESTATION_GO_RECOVERY_SIGNATURE_NOT_VERIFIED/u,
    ],
    [
      { evidenceCommit: "d".repeat(40) },
      /FINAL_ATTESTATION_GO_RECOVERY_EVIDENCE_COMMIT_MISMATCH/u,
    ],
  ]) {
    assert.throws(
      () => assertFinalPreviewRecoveryGoResult(
        { ...verified, ...mutation },
        { expectedEvidenceCommit: evidenceCommit },
      ),
      expectedError,
    );
  }
  assert.throws(
    () => assertFinalPreviewRecoveryGoResult(null, { expectedEvidenceCommit: evidenceCommit }),
    /FINAL_ATTESTATION_GO_RECOVERY_RESULT_INVALID/u,
  );
});

test("specialized gates require their full fixed inventory and exact runtime deployment identity", async (t) => {
  const runtime = gateRuntime();
  const cases = [
    {
      build: completeBlobEvidence,
      id: "preview-blob-lifecycle",
      makeSparse: (document) => document.checks.pop(),
      wrongDeployment: (document) => { document.deployment.deploymentId = "dpl_Wrong"; },
    },
    {
      build: completeProviderEvidence,
      id: "provider-boundaries",
      makeSparse: (document) => document.requests.pop(),
      wrongDeployment: (document) => { document.candidate.deploymentId = "dpl_Wrong"; },
    },
    {
      build: completeA11yEvidence,
      id: "accessibility-browser",
      makeSparse: (document) => document.results.pop(),
      wrongDeployment: (document) => { document.runtimeIdentity.expected.deploymentId = "dpl_Wrong"; },
    },
    {
      build: completePerformanceEvidence,
      id: "performance",
      makeSparse: (document) => document.results.pop(),
      wrongDeployment: (document) => { document.runtimeIdentity.expected.deploymentId = "dpl_Wrong"; },
    },
  ];

  for (const entry of cases) {
    await t.test(entry.id, () => {
      const binding = gateBinding(entry.id);
      const complete = entry.build(runtime);
      assert.equal(observedFinalPreviewGateStatus(binding, complete, runtime, { trustContext }), "PASS");

      const sparse = structuredClone(complete);
      entry.makeSparse(sparse);
      assert.throws(
        () => observedFinalPreviewGateStatus(binding, sparse, runtime, { trustContext }),
        /_COUNT_INVALID/u,
      );

      const wrongDeployment = structuredClone(complete);
      entry.wrongDeployment(wrongDeployment);
      assert.throws(
        () => observedFinalPreviewGateStatus(binding, wrongDeployment, runtime, { trustContext }),
        /_DEPLOYMENT_ID_MISMATCH/u,
      );
    });
  }
});

test("two-tenant PASS fails closed without the locally verified artifact and Sigstore bundle", () => {
  const runtime = gateRuntime();
  const binding = gateBinding("two-tenant-rbac-crud");
  assert.throws(
    () => observedFinalPreviewGateStatus(
      binding,
      completeTwoTenantEvidence(runtime),
      runtime,
      { trustContext },
    ),
    /FINAL_ATTESTATION_TWO_TENANT_CRYPTOGRAPHIC_PROVENANCE_NOT_OBJECT/u,
  );
});

test("two-tenant final evidence is bound to the referenceless canonical parent artifact", () => {
  const runtime = gateRuntime();
  const binding = gateBinding("two-tenant-rbac-crud");
  const document = completeTwoTenantEvidence(runtime);
  const parentBase = Object.fromEntries(
    Object.entries(document).filter(([key]) =>
      !["protectedWorkflowArtifactManifest", "protectedWorkflowReceipt"].includes(key)),
  );
  const canonicalParentBase = canonicalGateJson(parentBase);
  const parentArtifact = document.protectedWorkflowArtifactManifest.files.find(
    (entry) => entry.name === twoTenantParentBaseArtifactFile,
  );
  assert.equal(Object.hasOwn(parentBase, "protectedWorkflowArtifactManifest"), false);
  assert.equal(Object.hasOwn(parentBase, "protectedWorkflowReceipt"), false);
  assert.equal(parentArtifact.sha256, gateSha256(canonicalParentBase));
  assert.equal(parentArtifact.sizeBytes, Buffer.byteLength(canonicalParentBase, "utf8"));

  document.results[0].status = "fail";
  assert.throws(
    () => observedFinalPreviewGateStatus(binding, document, runtime, { trustContext }),
    /FINAL_ATTESTATION_TWO_TENANT_PARENT_BASE_DIGEST_MISMATCH/u,
  );
});

test("public runtime PASS fails closed without its own locally verified artifact and Sigstore bundle", () => {
  const runtime = gateRuntime();
  const binding = gateBinding("public-form-funnel");
  assert.throws(
    () => observedFinalPreviewGateStatus(
      binding,
      completePublicEvidence(runtime),
      runtime,
      { trustContext },
    ),
    /FINAL_ATTESTATION_PUBLIC_CRYPTOGRAPHIC_PROVENANCE_NOT_OBJECT/u,
  );
});

test("release approvals require every prescribed external role and exact role scopes", () => {
  const missingRole = signedFixture();
  delete missingRole.signatures.privacy;
  assert.throws(
    () => validateFinalPreviewReleaseAttestation(missingRole, { trustContext }),
    /FINAL_ATTESTATION_SIGNATURES_KEYS_INVALID/u,
  );

  const selfDeclaredScope = signedFixture();
  selfDeclaredScope.signatures["sales-operations"].approvalScopes = ["FINAL_RELEASE"];
  assert.throws(
    () => validateFinalPreviewReleaseAttestation(selfDeclaredScope, { trustContext }),
    /FINAL_ATTESTATION_SIGNATURE_SCOPES_INVALID/u,
  );
});

test("provider PASS cannot be relabelled from the fail-closed collector or forged receipts", () => {
  const runtime = gateRuntime();
  const binding = gateBinding("provider-boundaries");
  const relabelledCollector = completeProviderEvidence(runtime);
  delete relabelledCollector.collectionMode;
  delete relabelledCollector.providerAcceptanceReceipts;
  assert.throws(
    () => observedFinalPreviewGateStatus(binding, relabelledCollector, runtime, { trustContext }),
    /FINAL_ATTESTATION_PROVIDER_LIVE_ACCEPTANCE_REQUIRED/u,
  );

  const tamperedProviderReceipt = completeProviderEvidence(runtime);
  tamperedProviderReceipt.providerAcceptanceReceipts[0].payload.providerIdentity.providerName = "SELF_ASSERTED";
  assert.throws(
    () => observedFinalPreviewGateStatus(binding, tamperedProviderReceipt, runtime, { trustContext }),
    /EXTERNAL_GATE_RECEIPT_PAYLOAD_DIGEST_MISMATCH/u,
  );

  const sparseProviderReceipt = completeProviderEvidence(runtime);
  sparseProviderReceipt.providerAcceptanceReceipts.pop();
  assert.throws(
    () => observedFinalPreviewGateStatus(binding, sparseProviderReceipt, runtime, { trustContext }),
    /FINAL_ATTESTATION_PROVIDER_ASSEMBLY_INVENTORY_MISMATCH/u,
  );

  const sameCountContentMutation = completeProviderEvidence(runtime);
  const mutatedTable = Object.values(sameCountContentMutation.databaseWritePostcondition.tables)[0];
  mutatedTable.afterFingerprint = `sha256:${"f".repeat(64)}`;
  assert.throws(
    () => observedFinalPreviewGateStatus(binding, sameCountContentMutation, runtime, { trustContext }),
    /FINAL_ATTESTATION_PROVIDER_DATABASE_DRIFT/u,
  );

  const replayedReceiptsAgainstDifferentSnapshot = completeProviderEvidence(runtime);
  const reboundTable = Object.values(replayedReceiptsAgainstDifferentSnapshot.databaseWritePostcondition.tables)[0];
  reboundTable.beforeFingerprint = `sha256:${"e".repeat(64)}`;
  reboundTable.afterFingerprint = `sha256:${"e".repeat(64)}`;
  assert.throws(
    () => observedFinalPreviewGateStatus(binding, replayedReceiptsAgainstDifferentSnapshot, runtime, { trustContext }),
    /FINAL_ATTESTATION_PROVIDER_ASSEMBLY_SOURCE_INVALID/u,
  );
});

test("public form/funnel PASS requires the exact protected workflow batch, artifact and cleanup", () => {
  const runtime = gateRuntime();
  const binding = gateBinding("public-form-funnel");
  const synthetic = completePublicEvidence(runtime);
  delete synthetic.protectedWorkflowReceipt;
  assert.throws(
    () => observedFinalPreviewGateStatus(binding, synthetic, runtime, { trustContext }),
    /EXTERNAL_GATE_RECEIPT_OBJECT_REQUIRED/u,
  );

  const wrongBatch = completePublicEvidence(runtime);
  wrongBatch.proofs[0].qaBatchId = "22222222-2222-4222-8222-222222222222";
  assert.throws(
    () => observedFinalPreviewGateStatus(binding, wrongBatch, runtime, { trustContext }),
    /PUBLIC_RUNTIME_PROOF_QA_BATCH_MISMATCH/u,
  );

  const incompleteCleanup = completePublicEvidence(runtime);
  incompleteCleanup.cleanup.remainingObjectCount = 1;
  assert.throws(
    () => observedFinalPreviewGateStatus(binding, incompleteCleanup, runtime, { trustContext }),
    /PUBLIC_RUNTIME_CLEANUP_NOT_ZERO/u,
  );

  const replayedSignedReceiptWithForgedCleanup = completePublicEvidence(runtime);
  replayedSignedReceiptWithForgedCleanup.cleanup.inventoryBeforeSha256 = "9".repeat(64);
  replayedSignedReceiptWithForgedCleanup.cleanup.inventoryAfterSha256 = "9".repeat(64);
  assert.throws(
    () => observedFinalPreviewGateStatus(binding, replayedSignedReceiptWithForgedCleanup, runtime, { trustContext }),
    /PUBLIC_RUNTIME_CLEANUP_ARTIFACT_DIGEST_MISMATCH/u,
  );

  const acceptedExpiredProof = completePublicEvidence(runtime);
  acceptedExpiredProof.proofs
    .find((proof) => proof.id === "public-form-long-proof-refresh")
    .observations.find((observation) => observation.id === "old-proof-rejected").status = 200;
  assert.throws(
    () => observedFinalPreviewGateStatus(binding, acceptedExpiredProof, runtime, { trustContext }),
    /PUBLIC_RUNTIME_OBSERVATION_STATUS_INVALID/u,
  );

  const rejectedRefreshedProof = completePublicEvidence(runtime);
  rejectedRefreshedProof.proofs
    .find((proof) => proof.id === "public-funnel-long-proof-refresh")
    .observations.find((observation) => observation.id === "refreshed-revision-proof-accepted").status = 499;
  assert.throws(
    () => observedFinalPreviewGateStatus(binding, rejectedRefreshedProof, runtime, { trustContext }),
    /PUBLIC_RUNTIME_OBSERVATION_STATUS_INVALID/u,
  );

  const shortSession = completePublicEvidence(runtime);
  const shortProof = shortSession.proofs.find((proof) => proof.id === "public-form-long-proof-refresh");
  shortProof.observations.forEach((observation, index) => {
    observation.observedAt = new Date(Date.UTC(2026, 7, 25, 20, 0, index)).toISOString();
  });
  assert.throws(
    () => observedFinalPreviewGateStatus(binding, shortSession, runtime, { trustContext }),
    /PUBLIC_RUNTIME_LONG_PROOF_DURATION_INVALID/u,
  );

  const sameInstant = completePublicEvidence(runtime);
  const sameInstantProof = sameInstant.proofs.find((proof) => proof.id === "public-form-live-submission");
  sameInstantProof.observations[1].observedAt = sameInstantProof.observations[0].observedAt;
  assert.throws(
    () => observedFinalPreviewGateStatus(binding, sameInstant, runtime, { trustContext }),
    /PUBLIC_RUNTIME_OBSERVATION_ORDER_INVALID/u,
  );

  const futureObservations = completePublicEvidence(runtime);
  const futureProof = futureObservations.proofs.find((proof) => proof.id === "funnel-publish-token-rotation");
  futureProof.observations.forEach((observation, index) => {
    observation.observedAt = new Date(Date.UTC(2026, 7, 25, 22, index, 0)).toISOString();
  });
  futureObservations.protectedWorkflowReceipt = externalGateReceipt(
    publicRuntimeWorkflowRole,
    publicRuntimeWorkflowRecordType,
    {
      ...futureObservations.protectedWorkflowReceipt.payload,
      proofInventorySha256: gateSha256(canonicalGateJson(futureObservations.proofs)),
    },
  );
  assert.throws(
    () => observedFinalPreviewGateStatus(binding, futureObservations, runtime, { trustContext }),
    /PUBLIC_RUNTIME_WORKFLOW_SIGNED_BEFORE_OBSERVATION/u,
  );

  const replayCreatedDuplicate = completePublicEvidence(runtime);
  replayCreatedDuplicate.proofs
    .find((proof) => proof.id === "public-form-live-submission")
    .semanticEvidence.idempotentReplayCreatedObjectCount = 1;
  assert.throws(
    () => observedFinalPreviewGateStatus(binding, replayCreatedDuplicate, runtime, { trustContext }),
    /PUBLIC_RUNTIME_SUBMISSION_EXACTLY_ONCE_INVALID/u,
  );

  const tamperedArtifact = completePublicEvidence(runtime);
  tamperedArtifact.protectedWorkflowArtifactManifest.artifactDigest = "0".repeat(64);
  assert.throws(
    () => observedFinalPreviewGateStatus(binding, tamperedArtifact, runtime, { trustContext }),
    /PUBLIC_RUNTIME_WORKFLOW_ARTIFACT_MISMATCH/u,
  );

  const tamperedParentBase = completePublicEvidence(runtime);
  tamperedParentBase.databaseAttestation.contentFingerprintDigest = "b".repeat(64);
  assert.throws(
    () => observedFinalPreviewGateStatus(binding, tamperedParentBase, runtime, { trustContext }),
    /PUBLIC_RUNTIME_PARENT_BASE_DIGEST_MISMATCH/u,
  );
});

test("Blob Legacy PASS recomputes non-empty candidate/store-bound migration evidence", () => {
  const runtime = gateRuntime();
  const binding = gateBinding("preview-blob-lifecycle");
  const zeroMigration = completeBlobEvidence(runtime);
  const proof = zeroMigration.legacyObjectMigrationProof;
  proof.legacyObjectCountBefore = 0;
  proof.migratedObjectCount = 0;
  proof.evidence.sourceInventory.objectCount = 0;
  proof.evidence.targetInventory.objectCount = 0;
  proof.evidenceDigest = createHash("sha256").update(canonicalJson(proof.evidence)).digest("hex");
  assert.throws(
    () => observedFinalPreviewGateStatus(binding, zeroMigration, runtime),
    /FINAL_ATTESTATION_BLOB_LEGACY_PROOF_INVALID/u,
  );

  const contentMismatch = completeBlobEvidence(runtime);
  contentMismatch.legacyObjectMigrationProof.evidence.targetInventory.contentSha256 = "0".repeat(64);
  contentMismatch.legacyObjectMigrationProof.evidenceDigest = createHash("sha256")
    .update(canonicalJson(contentMismatch.legacyObjectMigrationProof.evidence)).digest("hex");
  assert.throws(
    () => observedFinalPreviewGateStatus(binding, contentMismatch, runtime),
    /BLOB_LEGACY_TARGET_INVENTORY_SUMMARY_MISMATCH/u,
  );

  const fabricatedAggregateDigests = completeBlobEvidence(runtime);
  fabricatedAggregateDigests.legacyObjectMigrationProof.evidence.sourceInventory.inventorySha256 = "d".repeat(64);
  fabricatedAggregateDigests.legacyObjectMigrationProof.evidenceDigest = gateSha256(
    canonicalGateJson(fabricatedAggregateDigests.legacyObjectMigrationProof.evidence),
  );
  assert.throws(
    () => observedFinalPreviewGateStatus(binding, fabricatedAggregateDigests, runtime, { trustContext }),
    /BLOB_LEGACY_SOURCE_INVENTORY_SUMMARY_MISMATCH/u,
  );

  const remappedObject = completeBlobEvidence(runtime);
  const targetObject = remappedObject.legacyObjectMigrationProof.evidence.targetInventory.objects[0];
  targetObject.contentSha256 = "e".repeat(64);
  const remappedSummary = summarizeLegacyBlobObjectInventory(
    remappedObject.legacyObjectMigrationProof.evidence.targetInventory.objects,
  );
  Object.assign(remappedObject.legacyObjectMigrationProof.evidence.targetInventory, remappedSummary);
  remappedObject.legacyObjectMigrationProof.evidenceDigest = gateSha256(
    canonicalGateJson(remappedObject.legacyObjectMigrationProof.evidence),
  );
  assert.throws(
    () => observedFinalPreviewGateStatus(binding, remappedObject, runtime, { trustContext }),
    /BLOB_LEGACY_SOURCE_TARGET_CONTENT_MISMATCH/u,
  );

  const fabricatedRollback = completeBlobEvidence(runtime);
  fabricatedRollback.legacyObjectMigrationProof.evidence.rollback.artifactSha256 = "f".repeat(64);
  fabricatedRollback.legacyObjectMigrationProof.evidenceDigest = gateSha256(
    canonicalGateJson(fabricatedRollback.legacyObjectMigrationProof.evidence),
  );
  assert.throws(
    () => observedFinalPreviewGateStatus(binding, fabricatedRollback, runtime, { trustContext }),
    /BLOB_LEGACY_ROLLBACK_SUMMARY_MISMATCH/u,
  );

  const unsignedMigration = completeBlobEvidence(runtime);
  delete unsignedMigration.legacyObjectMigrationProof.migrationReceipt;
  assert.throws(
    () => observedFinalPreviewGateStatus(binding, unsignedMigration, runtime, { trustContext }),
    /EXTERNAL_GATE_RECEIPT_OBJECT_REQUIRED/u,
  );
});

test("performance PASS recomputes budgets and requires independently signed Manual/RUM receipts", () => {
  const runtime = gateRuntime();
  const binding = gateBinding("performance");

  const zeroScore = completePerformanceEvidence(runtime);
  zeroScore.results[0].scores.performance = 0;
  assert.throws(
    () => observedFinalPreviewGateStatus(binding, zeroScore, runtime, { trustContext }),
    /FINAL_ATTESTATION_PERFORMANCE_SCORE_INVALID/u,
  );

  const emptyMetrics = completePerformanceEvidence(runtime);
  emptyMetrics.results[0].metrics = {};
  assert.throws(
    () => observedFinalPreviewGateStatus(binding, emptyMetrics, runtime, { trustContext }),
    /FINAL_ATTESTATION_PERFORMANCE_METRICS_KEYS_INVALID/u,
  );

  const failedBudget = completePerformanceEvidence(runtime);
  failedBudget.results[0].scores.performance = 0.1;
  assert.throws(
    () => observedFinalPreviewGateStatus(binding, failedBudget, runtime, { trustContext }),
    /FINAL_ATTESTATION_PERFORMANCE_RESULT_NOT_PASS/u,
  );

  const replacedTechnicalEvidence = completePerformanceEvidence(runtime);
  replacedTechnicalEvidence.results[0].metrics.totalByteWeight += 1;
  assert.throws(
    () => observedFinalPreviewGateStatus(binding, replacedTechnicalEvidence, runtime, { trustContext }),
    /FINAL_ATTESTATION_PERFORMANCE_TECHNICAL_EVIDENCE_DIGEST_MISMATCH/u,
  );

  const replayedReceipts = completePerformanceEvidence(runtime);
  replayedReceipts.results[0].metrics.totalByteWeight += 1;
  replayedReceipts.technicalEvidenceSha256 = buildPerformanceTechnicalEvidenceSha256(replayedReceipts);
  assert.throws(
    () => observedFinalPreviewGateStatus(binding, replayedReceipts, runtime, { trustContext }),
    /PERFORMANCE_MANUAL_ARTIFACT_DIGEST_MISMATCH/u,
  );

  const tamperedManual = completePerformanceEvidence(runtime);
  tamperedManual.manualAcceptanceReceipt.payload.manualGates[0].evidenceSha256 = "0".repeat(64);
  assert.throws(
    () => observedFinalPreviewGateStatus(binding, tamperedManual, runtime, { trustContext }),
    /EXTERNAL_GATE_RECEIPT_PAYLOAD_DIGEST_MISMATCH/u,
  );

  const sparseRum = completePerformanceEvidence(runtime);
  const rumPayload = structuredClone(sparseRum.realUserMonitoringReceipt.payload);
  rumPayload.sampleCount = 0;
  sparseRum.realUserMonitoringReceipt = externalGateReceipt(
    performanceRumAcceptanceRole,
    performanceRumAcceptanceRecordType,
    rumPayload,
  );
  assert.throws(
    () => observedFinalPreviewGateStatus(binding, sparseRum, runtime, { trustContext }),
    /PERFORMANCE_RUM_SAMPLE_COUNT_INVALID/u,
  );

  const missingBudgetOwner = completePerformanceEvidence(runtime);
  delete missingBudgetOwner.budgetApprovalReceipts.operations;
  assert.throws(
    () => observedFinalPreviewGateStatus(binding, missingBudgetOwner, runtime, { trustContext }),
    /FINAL_ATTESTATION_PERFORMANCE_BUDGET_APPROVAL_RECEIPTS_KEYS_INVALID/u,
  );

  const roleSwappedBudgetOwners = completePerformanceEvidence(runtime);
  [
    roleSwappedBudgetOwners.budgetApprovalReceipts.product,
    roleSwappedBudgetOwners.budgetApprovalReceipts.engineering,
  ] = [
    roleSwappedBudgetOwners.budgetApprovalReceipts.engineering,
    roleSwappedBudgetOwners.budgetApprovalReceipts.product,
  ];
  assert.throws(
    () => observedFinalPreviewGateStatus(binding, roleSwappedBudgetOwners, runtime, { trustContext }),
    /EXTERNAL_GATE_RECEIPT_ROLE_MISMATCH/u,
  );
});

test("two-tenant and accessibility PASS reject local strings without external workflow/manual receipts", () => {
  assert.ok(a11yExpectedResultKeys.every((key) => !key.includes("-submit-result|")));
  assert.ok(accessibilityRequiredManualCheckIds.includes("public-form-and-funnel-submit-flow"));

  const runtime = gateRuntime();
  const twoTenantBinding = gateBinding("two-tenant-rbac-crud");
  const selfDeclaredWorkflow = completeTwoTenantEvidence(runtime);
  delete selfDeclaredWorkflow.protectedWorkflowReceipt;
  assert.throws(
    () => observedFinalPreviewGateStatus(twoTenantBinding, selfDeclaredWorkflow, runtime, { trustContext }),
    /EXTERNAL_GATE_RECEIPT_OBJECT_REQUIRED/u,
  );

  const a11yBinding = gateBinding("accessibility-browser");
  const selfDeclaredManualPass = completeA11yEvidence(runtime);
  delete selfDeclaredManualPass.manualAcceptance.approvalReceipts[
    accessibilityApprovalRoles[2].receiptRole
  ];
  assert.throws(
    () => observedFinalPreviewGateStatus(a11yBinding, selfDeclaredManualPass, runtime, { trustContext }),
    /ACCESSIBILITY_APPROVAL_RECEIPTS_KEYS_INVALID/u,
  );

  const roleSwappedApprovals = completeA11yEvidence(runtime);
  [
    roleSwappedApprovals.manualAcceptance.approvalReceipts[
      accessibilityApprovalRoles[0].receiptRole
    ],
    roleSwappedApprovals.manualAcceptance.approvalReceipts[
      accessibilityApprovalRoles[1].receiptRole
    ],
  ] = [
    roleSwappedApprovals.manualAcceptance.approvalReceipts[
      accessibilityApprovalRoles[1].receiptRole
    ],
    roleSwappedApprovals.manualAcceptance.approvalReceipts[
      accessibilityApprovalRoles[0].receiptRole
    ],
  ];
  assert.throws(
    () => observedFinalPreviewGateStatus(a11yBinding, roleSwappedApprovals, runtime, { trustContext }),
    /EXTERNAL_GATE_RECEIPT_(?:TYPE|ROLE)_MISMATCH/u,
  );

  const tamperedManualMatrix = completeA11yEvidence(runtime);
  tamperedManualMatrix.manualAcceptance.matrix.manualChecks[0].status = "FAIL";
  assert.throws(
    () => observedFinalPreviewGateStatus(a11yBinding, tamperedManualMatrix, runtime, { trustContext }),
    /ACCESSIBILITY_MATRIX_MANUAL_CHECK_NOT_PASS/u,
  );

  const replacedOuterAutomatedMatrix = completeA11yEvidence(runtime);
  replacedOuterAutomatedMatrix.results[0].status = 201;
  assert.throws(
    () => observedFinalPreviewGateStatus(a11yBinding, replacedOuterAutomatedMatrix, runtime, { trustContext }),
    /ACCESSIBILITY_AUTOMATED_EVIDENCE_OUTER_MISMATCH/u,
  );

  const incompleteSubmit = completeA11yEvidence(runtime);
  incompleteSubmit.manualAcceptance.individualEvidence.at(-1).observations.pop();
  assert.throws(
    () => observedFinalPreviewGateStatus(a11yBinding, incompleteSubmit, runtime, { trustContext }),
    /ACCESSIBILITY_MANUAL_OBSERVATION_INVENTORY_INVALID/u,
  );

  const outerRunRelabel = completeA11yEvidence(runtime);
  outerRunRelabel.generatedAt = "2026-08-25T20:31:00.000Z";
  assert.throws(
    () => observedFinalPreviewGateStatus(a11yBinding, outerRunRelabel, runtime, { trustContext }),
    /ACCESSIBILITY_AUTOMATED_EVIDENCE_OUTER_MISMATCH/u,
  );

  const cleanupReceiptTamper = completeA11yEvidence(runtime);
  cleanupReceiptTamper.manualAcceptance.fixtureLifecycle.cleanup.remainingBatchObjectCount = 1;
  assert.throws(
    () => observedFinalPreviewGateStatus(a11yBinding, cleanupReceiptTamper, runtime, { trustContext }),
    /A11Y_FIXTURE_LIFECYCLE_DIGEST_MISMATCH/u,
  );
});

test("operational PASS gates require source-bound signed receipts", () => {
  const runtime = gateRuntime();
  for (const id of ["observability", "security-supply-chain", "cleanup-null-rest", "runtime-logs"]) {
    const binding = gateBinding(id);
    const complete = completeOperationalGateEvidence(id, runtime);
    assert.equal(
      observedFinalPreviewGateStatus(binding, complete, runtime, { trustContext }),
      "PASS",
    );

    const selfDeclared = structuredClone(complete);
    delete selfDeclared.operationalReceipt;
    assert.throws(
      () => observedFinalPreviewGateStatus(binding, selfDeclared, runtime, { trustContext }),
      /EXTERNAL_GATE_RECEIPT_OBJECT_REQUIRED/u,
    );

    const tampered = structuredClone(complete);
    tampered.operationalReceipt.payload.source.artifactSha256 = "0".repeat(64);
    assert.throws(
      () => observedFinalPreviewGateStatus(binding, tampered, runtime, { trustContext }),
      /EXTERNAL_GATE_RECEIPT_PAYLOAD_DIGEST_MISMATCH/u,
    );
  }
});

test("GO requires signed release ownership, the relationship decision and deployment-bound Legal approval", () => {
  const matrix = structuredClone(releaseGateMatrix);
  matrix.candidateCommit = "a".repeat(40);
  matrix.approvalStatus = "READY_FOR_EXTERNAL_SIGNATURE";
  for (const role of signatureRoles) matrix.signatures[role] = null;
  matrix.surfaces = matrix.surfaces.map((surface) => ({
    ...surface,
    owners: { legal: "legal owner", product: "product owner", technical: "technical owner" },
  }));
  matrix.specialDecisions.unitBuyerDealRelationship.status = "READY_FOR_EXTERNAL_SIGNATURE";
  matrix.specialDecisions.unitBuyerDealRelationship.requiredSignatures = {
    dataCompliance: null,
    engineering: null,
    product: null,
    salesOperations: null,
  };
  const matrixSource = canonicalGateJson(matrix);
  const matrixSha256 = gateSha256(matrixSource);
  const attestation = signedFixture({
    allGatesPass: true,
    decision: "GO",
    documentDigests: { "release-gate-matrix": matrixSha256 },
  });
  assert.equal(attestation.runtime.candidateCommit, matrix.candidateCommit);
  assert.equal(
    attestation.documents.find((entry) => entry.id === "release-gate-matrix").sha256,
    matrixSha256,
  );
  assert.ok(signatureRoles.every((role) =>
    attestation.signatures[role].documentBundleSha256 === attestation.documentBundleSha256));
  const surfaces = structuredClone(releaseSurfaceManifest);
  surfaces.candidateCommit = attestation.runtime.candidateCommit;
  surfaces.approvalStatus = "SIGNED";
  const legal = structuredClone(legalContentManifest);
  legal.candidateCommit = attestation.runtime.candidateCommit;
  legal.approvalStatus = "APPROVED";
  legal.testedDeployment = attestation.runtime.deploymentId;
  const previewOrigin = `https://${attestation.runtime.deploymentHost}`;
  legal.pages = legal.pages.map((page) => ({
    ...page,
    renderedVariants: page.renderedVariants.map((variant) => ({
      ...variant,
      approvedAt: "2026-08-23T20:31:00.000Z",
      legalOwner: "legal owner",
      legalStatus: "APPROVED",
      renderedContentSha256: "a".repeat(64),
      renderStatus: "VERIFIED",
      testedUrl: `${previewOrigin}${variant.path}`,
    })),
  }));
  legal.routeAliases = legal.routeAliases.map((entry) => ({
    ...entry,
    approvedAt: "2026-08-23T20:31:00.000Z",
    legalOwner: "legal owner",
    legalStatus: "APPROVED",
  }));
  legal.functionalContracts = legal.functionalContracts.map((entry) => ({
    ...entry,
    approvedAt: "2026-08-23T20:31:00.000Z",
    legalOwner: "legal owner",
    legalStatus: "APPROVED",
  }));
  const companyProfileApproval = completeCompanyProfileApproval(attestation);

  assert.doesNotThrow(() => validateReleaseDocumentCandidateState({
    attestation,
    companyProfileApproval,
    legalContentManifest: legal,
    releaseGateMatrix: matrix,
    releaseSurfaceManifest: surfaces,
    trustContext,
  }));
  const missingPrivacyRoute = structuredClone(legal);
  missingPrivacyRoute.pages = missingPrivacyRoute.pages.filter((page) => page.route !== "/privacy");
  assert.throws(
    () => validateReleaseDocumentCandidateState({
      attestation,
      companyProfileApproval,
      legalContentManifest: missingPrivacyRoute,
      releaseGateMatrix: matrix,
      releaseSurfaceManifest: surfaces,
      trustContext,
    }),
    /FINAL_ATTESTATION_LEGAL_PAGE_ROUTE_INVENTORY_COUNT_INVALID/u,
  );
  const missingEnglishLanguage = structuredClone(legal);
  missingEnglishLanguage.pages[0].languages = ["de"];
  assert.throws(
    () => validateReleaseDocumentCandidateState({
      attestation,
      companyProfileApproval,
      legalContentManifest: missingEnglishLanguage,
      releaseGateMatrix: matrix,
      releaseSurfaceManifest: surfaces,
      trustContext,
    }),
    /FINAL_ATTESTATION_LEGAL_LANGUAGE_INVENTORY_COUNT_INVALID/u,
  );
  const missingEnglishVariant = structuredClone(legal);
  missingEnglishVariant.pages[0].renderedVariants =
    missingEnglishVariant.pages[0].renderedVariants.filter((variant) => variant.language !== "en");
  assert.throws(
    () => validateReleaseDocumentCandidateState({
      attestation,
      companyProfileApproval,
      legalContentManifest: missingEnglishVariant,
      releaseGateMatrix: matrix,
      releaseSurfaceManifest: surfaces,
      trustContext,
    }),
    /FINAL_ATTESTATION_LEGAL_VARIANT_LANGUAGE_INVENTORY_COUNT_INVALID/u,
  );
  const missingLegacyAlias = structuredClone(legal);
  missingLegacyAlias.routeAliases = [];
  assert.throws(
    () => validateReleaseDocumentCandidateState({
      attestation,
      companyProfileApproval,
      legalContentManifest: missingLegacyAlias,
      releaseGateMatrix: matrix,
      releaseSurfaceManifest: surfaces,
      trustContext,
    }),
    /FINAL_ATTESTATION_LEGAL_ALIAS_INVENTORY_COUNT_INVALID/u,
  );
  const missingUnsubscribeConfirm = structuredClone(legal);
  missingUnsubscribeConfirm.functionalContracts = [];
  assert.throws(
    () => validateReleaseDocumentCandidateState({
      attestation,
      companyProfileApproval,
      legalContentManifest: missingUnsubscribeConfirm,
      releaseGateMatrix: matrix,
      releaseSurfaceManifest: surfaces,
      trustContext,
    }),
    /FINAL_ATTESTATION_LEGAL_FUNCTIONAL_CONTRACT_INVENTORY_COUNT_INVALID/u,
  );
  const unsubscribeConfirmWithoutPost = structuredClone(legal);
  unsubscribeConfirmWithoutPost.functionalContracts[0].methods = ["GET"];
  assert.throws(
    () => validateReleaseDocumentCandidateState({
      attestation,
      companyProfileApproval,
      legalContentManifest: unsubscribeConfirmWithoutPost,
      releaseGateMatrix: matrix,
      releaseSurfaceManifest: surfaces,
      trustContext,
    }),
    /FINAL_ATTESTATION_LEGAL_FUNCTIONAL_METHOD_INVENTORY_MISMATCH/u,
  );
  const matrixByteMutation = structuredClone(matrix);
  matrixByteMutation.surfaces[0].function = `${matrixByteMutation.surfaces[0].function} tampered`;
  assert.notEqual(gateSha256(canonicalGateJson(matrixByteMutation)), matrixSha256);
  const malformedLaunchStatus = structuredClone(matrix);
  malformedLaunchStatus.surfaces[0].desiredLaunchStatus = "MAYBE";
  assert.throws(
    () => validateReleaseDocumentCandidateState({
      attestation,
      companyProfileApproval,
      legalContentManifest: legal,
      releaseGateMatrix: malformedLaunchStatus,
      releaseSurfaceManifest: surfaces,
      trustContext,
    }),
    /FINAL_ATTESTATION_RELEASE_MATRIX_LAUNCH_STATUS_INVALID/u,
  );

  const missingScopeDecision = structuredClone(matrix);
  missingScopeDecision.surfaces = missingScopeDecision.surfaces.filter(
    (surface) => surface.launchScopeKey !== "publicFormSubmission",
  );
  assert.throws(
    () => validateReleaseDocumentCandidateState({
      attestation,
      companyProfileApproval,
      legalContentManifest: legal,
      releaseGateMatrix: missingScopeDecision,
      releaseSurfaceManifest: surfaces,
      trustContext,
    }),
    /FINAL_ATTESTATION_RELEASE_MATRIX_SCOPE_INVENTORY_INVALID/u,
  );

  const centralPolicyDrift = structuredClone(matrix);
  centralPolicyDrift.surfaces.find((surface) => surface.launchScopeKey === "publicFormSubmission")
    .desiredLaunchStatus = "OFF";
  assert.throws(
    () => validateReleaseDocumentCandidateState({
      attestation,
      companyProfileApproval,
      legalContentManifest: legal,
      releaseGateMatrix: centralPolicyDrift,
      releaseSurfaceManifest: surfaces,
      trustContext,
    }),
    /FINAL_ATTESTATION_RELEASE_MATRIX_POLICY_DRIFT/u,
  );
  const unsigned = structuredClone(matrix);
  unsigned.approvalStatus = "PENDING_SIGNATURE";
  assert.throws(
    () => validateReleaseDocumentCandidateState({
      attestation,
      companyProfileApproval,
      legalContentManifest: legal,
      releaseGateMatrix: unsigned,
      releaseSurfaceManifest: surfaces,
      trustContext,
    }),
    /FINAL_ATTESTATION_RELEASE_MATRIX_NOT_READY_FOR_SIGNATURE/u,
  );

  const embeddedRelationshipReference = structuredClone(matrix);
  embeddedRelationshipReference.specialDecisions.unitBuyerDealRelationship.requiredSignatures.salesOperations =
    attestation.signatures["sales-operations"].signatureReference;
  assert.throws(
    () => validateReleaseDocumentCandidateState({
      attestation,
      companyProfileApproval,
      legalContentManifest: legal,
      releaseGateMatrix: embeddedRelationshipReference,
      releaseSurfaceManifest: surfaces,
      trustContext,
    }),
    /FINAL_ATTESTATION_RELATIONSHIP_EMBEDDED_SIGNATURE_FORBIDDEN/u,
  );

  const embeddedMatrixReference = structuredClone(matrix);
  embeddedMatrixReference.signatures.product = attestation.signatures.product.signatureReference;
  assert.throws(
    () => validateReleaseDocumentCandidateState({
      attestation,
      companyProfileApproval,
      legalContentManifest: legal,
      releaseGateMatrix: embeddedMatrixReference,
      releaseSurfaceManifest: surfaces,
      trustContext,
    }),
    /FINAL_ATTESTATION_RELEASE_MATRIX_EMBEDDED_SIGNATURE_FORBIDDEN/u,
  );

  const unimplementedRelationshipLaunchOn = structuredClone(matrix);
  unimplementedRelationshipLaunchOn.specialDecisions.unitBuyerDealRelationship.decision = "ON";
  assert.throws(
    () => validateReleaseDocumentCandidateState({
      attestation,
      companyProfileApproval,
      legalContentManifest: legal,
      releaseGateMatrix: unimplementedRelationshipLaunchOn,
      releaseSurfaceManifest: surfaces,
      trustContext,
    }),
    /FINAL_ATTESTATION_RELATIONSHIP_DECISION_NOT_READY_FOR_SIGNATURE/u,
  );

  const unlockedProfile = structuredClone(companyProfileApproval);
  unlockedProfile.profileSnapshot.locked = false;
  assert.throws(
    () => validateReleaseDocumentCandidateState({
      attestation,
      companyProfileApproval: unlockedProfile,
      legalContentManifest: legal,
      releaseGateMatrix: matrix,
      releaseSurfaceManifest: surfaces,
      trustContext,
    }),
    /COMPANY_PROFILE_NOT_LOCKED/u,
  );
});

test("Git provenance rejects dirty, index, untracked, wrong-commit and post-freeze evidence drift", async (t) => {
  await t.test("clean two-phase repository passes", async () => {
    const fixture = await createProvenanceRepository();
    try {
      const result = await verifyFinalPreviewRepositoryProvenance({
        attestation: fixture.attestation,
        attestationPath: fixture.attestationPath,
        repositoryRootPath: fixture.root,
      });
      assert.equal(result.evidenceCommit, fixture.attestation.evidenceProvenance.evidenceCommit);
      assert.equal(result.status, "PASS");
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  for (const [name, mutate] of [
    ["dirty worktree", async (fixture) => {
      await writeFile(path.join(fixture.root, ...fixture.evidencePath.split("/")), "dirty\n", "utf8");
    }],
    ["index drift", async (fixture) => {
      await writeFile(path.join(fixture.root, ...fixture.evidencePath.split("/")), "indexed\n", "utf8");
      git(fixture.root, ["add", fixture.evidencePath]);
    }],
    ["untracked file", async (fixture) => {
      await writeFile(path.join(fixture.root, "untracked.txt"), "untracked\n", "utf8");
    }],
  ]) {
    await t.test(name, async () => {
      const fixture = await createProvenanceRepository();
      try {
        await mutate(fixture);
        await assert.rejects(
          verifyFinalPreviewRepositoryProvenance({
            attestation: fixture.attestation,
            attestationPath: fixture.attestationPath,
            repositoryRootPath: fixture.root,
          }),
          /FINAL_ATTESTATION_REPOSITORY_NOT_CLEAN/u,
        );
      } finally {
        await rm(fixture.root, { force: true, recursive: true });
      }
    });
  }

  await t.test("path absent from evidenceCommit", async () => {
    const fixture = await createProvenanceRepository();
    try {
      const wrong = structuredClone(fixture.attestation);
      wrong.documents[0] = {
        path: "baseline.txt",
        sidecarPath: fixture.attestation.documents[0].sidecarPath,
      };
      await assert.rejects(
        verifyFinalPreviewRepositoryProvenance({
          attestation: wrong,
          attestationPath: fixture.attestationPath,
          repositoryRootPath: fixture.root,
        }),
        /FINAL_ATTESTATION_EVIDENCE_COMMIT_PATHS_INVALID/u,
      );
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  await t.test("clean HEAD cannot replace bytes frozen in evidenceCommit", async () => {
    const fixture = await createProvenanceRepository();
    try {
      await writeFile(path.join(fixture.root, ...fixture.evidencePath.split("/")), "{\"status\":\"REPLACED\"}\n", "utf8");
      git(fixture.root, ["add", fixture.evidencePath]);
      git(fixture.root, ["commit", "-q", "-m", "attempt evidence replacement"]);
      await assert.rejects(
        verifyFinalPreviewRepositoryProvenance({
          attestation: fixture.attestation,
          attestationPath: fixture.attestationPath,
          repositoryRootPath: fixture.root,
        }),
        /FINAL_ATTESTATION_GIT_BLOB_WORKTREE_MISMATCH/u,
      );
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  await t.test("evidence commit cannot smuggle runtime or verifier changes", async () => {
    const fixture = await createProvenanceRepository({ evidenceCodeDrift: true });
    try {
      await assert.rejects(
        verifyFinalPreviewRepositoryProvenance({
          attestation: fixture.attestation,
          attestationPath: fixture.attestationPath,
          repositoryRootPath: fixture.root,
        }),
        /FINAL_ATTESTATION_EVIDENCE_COMMIT_PATHS_INVALID/u,
      );
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  await t.test("approval phase cannot smuggle runtime or verifier changes", async () => {
    const fixture = await createProvenanceRepository();
    try {
      await mkdir(path.join(fixture.root, "scripts"), { recursive: true });
      await writeFile(path.join(fixture.root, "scripts", "unexpected-verifier-change.mjs"), "export const drift = true;\n", "utf8");
      git(fixture.root, ["add", "scripts/unexpected-verifier-change.mjs"]);
      git(fixture.root, ["commit", "-q", "-m", "attempt verifier drift"]);
      await assert.rejects(
        verifyFinalPreviewRepositoryProvenance({
          attestation: fixture.attestation,
          attestationPath: fixture.attestationPath,
          repositoryRootPath: fixture.root,
        }),
        /FINAL_ATTESTATION_APPROVAL_COMMIT_PATHS_INVALID/u,
      );
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });
});

test("attestation verifier remains read-only and network-free", () => {
  assert.doesNotMatch(verifierSource, /\b(?:writeFile|appendFile|unlink|rm|mkdir|mkdtemp)\b/u);
  assert.doesNotMatch(verifierSource, /\b(?:exec|fetch|WebSocket)\b/u);
  assert.match(verifierSource, /spawnSync\("git"/u);
  assert.match(verifierSource, /readFile/u);
  assert.match(verifierSource, /verifyRecoveryEvidenceForFinalAttestation/u);
  assert.match(verifierSource, /trustAnchor: recoveryTrustAnchor/u);
  assert.match(
    verifierSource,
    /expectedEvidenceCommit: attestation\.evidenceProvenance\.evidenceCommit/u,
  );
});
