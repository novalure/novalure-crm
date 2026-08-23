import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { canonicalJson } from "./lib/public-runtime-preview-e2e.mjs";
import {
  publicRuntimeArtifactFiles,
  publicRuntimeProofObservations,
} from "./lib/public-runtime-protected-receipt.mjs";
import {
  stageProtectedPublicEvidence,
  validateProtectedPublicWorkflowInput,
} from "./qa-protected-public-action-runner.mjs";

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

const expected = Object.freeze({
  candidateBranch: "codex/go-live-remediation-20260822",
  candidateSha: "a".repeat(40),
  databaseBranchId: "br-lucky-heart-alrm9dlw",
  deploymentHost: "candidate-preview-novalure.vercel.app",
  deploymentId: "dpl_12345678901234567890",
  qaBatchId: "11111111-1111-4111-8111-111111111111",
});

test("protected Public workflow binds two preprovisioned batches to its single-use policy", () => {
  const input = {
    batchId: expected.qaBatchId,
    crossTenantBatchId: "22222222-2222-4222-8222-222222222222",
    expectedDeploymentId: expected.deploymentId,
    expectedGitRef: expected.candidateBranch,
    expectedGitSha: expected.candidateSha,
    expectedNeonBranchId: expected.databaseBranchId,
    expectedNeonProjectId: "weathered-term-98273025",
    previewOrigin: `https://${expected.deploymentHost}`,
  };
  const environment = {
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_REF: "refs/heads/main",
    GITHUB_REPOSITORY: "novalure/novalure-crm",
    GITHUB_SHA: "b".repeat(40),
    GITHUB_WORKFLOW_REF: "novalure/novalure-crm/.github/workflows/livegang-e2e.yml@refs/heads/main",
    NOVALURE_WORKFLOW_CANDIDATE_BRANCH: expected.candidateBranch,
    NOVALURE_WORKFLOW_CANDIDATE_SHA: expected.candidateSha,
    NOVALURE_WORKFLOW_DEPLOYMENT_ID: expected.deploymentId,
    NOVALURE_WORKFLOW_ENVIRONMENT: "go-live-preview",
    NOVALURE_WORKFLOW_NEON_BRANCH_ID: expected.databaseBranchId,
    NOVALURE_WORKFLOW_NEON_PROJECT_ID: input.expectedNeonProjectId,
    NOVALURE_WORKFLOW_PREVIEW_HOST: expected.deploymentHost,
    NOVALURE_WORKFLOW_PREVIEW_ORIGIN: input.previewOrigin,
    NOVALURE_WORKFLOW_PUBLIC_BATCH_POLICY: "fresh-deployment-bound-single-use-v1",
    NOVALURE_WORKFLOW_TRUSTED_HARNESS_SHA: "b".repeat(40),
  };
  assert.deepEqual(validateProtectedPublicWorkflowInput(input, environment), {
    candidateBranch: expected.candidateBranch,
    candidateSha: expected.candidateSha,
    crossTenantQaBatchId: input.crossTenantBatchId,
    databaseBranchId: expected.databaseBranchId,
    deploymentHost: expected.deploymentHost,
    deploymentId: expected.deploymentId,
    qaBatchId: expected.qaBatchId,
  });
  assert.throws(
    () => validateProtectedPublicWorkflowInput(input, {
      ...environment,
      NOVALURE_WORKFLOW_PUBLIC_BATCH_POLICY: "reuse-allowed",
    }),
    /PROTECTED_PUBLIC_BATCH_POLICY_INVALID/u,
  );
});

function proofPayload(id, observationIds, proofIndex, cleanupInventorySha256) {
  const longProof = id.endsWith("long-proof-refresh");
  const liveSubmission = id.endsWith("live-submission");
  const observations = observationIds.map((observationId, index) => ({
    id: observationId,
    observedAt: new Date(Date.UTC(
      2026,
      7,
      25,
      20,
      proofIndex * 20 + (longProof ? [0, 15, 16, 17][index] : index),
      0,
    )).toISOString(),
    responseSha256: String(index + 1).repeat(64),
    status: observationId === "old-proof-rejected"
      ? 400
      : observationId === "old-token-rejected"
        ? 401
        : 200,
  }));
  return {
    candidateCommit: expected.candidateSha,
    cleanupInventorySha256,
    databaseInventorySha256: "9".repeat(64),
    deploymentId: expected.deploymentId,
    id,
    observations,
    qaBatchId: expected.qaBatchId,
    semanticEvidence: longProof
      ? {
          idempotencyKeyAfterSha256: "a".repeat(64),
          idempotencyKeyBeforeSha256: "a".repeat(64),
          minimumElapsedSeconds: 900,
          oldProofRejectionCode: "submission_proof_expired",
        }
      : liveSubmission
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
  };
}

function completeEvidence() {
  const cleanup = {
    createdObjectCount: 12,
    databaseCleanup: "VERIFIED_ZERO",
    deletedObjectCount: 12,
    exactPrePostContentFingerprintMatch: true,
    inventoryAfterSha256: "7".repeat(64),
    inventoryBeforeSha256: "7".repeat(64),
    qaBatchId: expected.qaBatchId,
    remainingObjectCount: 0,
    status: "PASS",
  };
  const cleanupInventorySha256 = digest(canonicalJson(cleanup));
  const proofs = Object.entries(publicRuntimeProofObservations).map(([id, observations], index) => {
    const payload = proofPayload(id, observations, index, cleanupInventorySha256);
    return {
      artifactFile: `${id}.json`,
      artifactSha256: digest(canonicalJson(payload)),
      ...payload,
    };
  });
  return {
    blockedProofs: [],
    candidate: {
      deploymentHost: expected.deploymentHost,
      deploymentId: expected.deploymentId,
      gitBranch: expected.candidateBranch,
      gitSha: expected.candidateSha,
      neonBranchId: expected.databaseBranchId,
    },
    cleanup,
    databaseAttestation: {
      freshBatch: true,
      isQa: true,
      qaBatchId: expected.qaBatchId,
      status: "PASS",
    },
    httpReadOnlyStatus: "PASS",
    mutationGate: { reasonCode: null, status: "PASS" },
    productionMutationPerformed: false,
    proofs,
    releaseGateStatus: "PASS",
    schemaVersion: 1,
  };
}

test("separate Public producer stages exactly six bound single-link evidence files", async () => {
  const runnerTemp = await mkdtemp(path.join(os.tmpdir(), "novalure-protected-public-test-"));
  try {
    const evidence = completeEvidence();
    const staged = await stageProtectedPublicEvidence(evidence, expected, { runnerTemp });
    assert.deepEqual([...staged.names], [...publicRuntimeArtifactFiles]);
    const actual = [];
    for (const name of publicRuntimeArtifactFiles) {
      const filePath = path.join(staged.root, name);
      const state = await stat(filePath);
      assert.equal(state.isFile(), true);
      assert.equal(state.nlink, 1);
      actual.push(name);
      if (name !== "public-form-funnel-cleanup.json") {
        const proof = evidence.proofs.find((entry) => entry.artifactFile === name);
        assert.equal(digest(await readFile(filePath)), proof.artifactSha256);
      }
    }
    assert.deepEqual(actual, [...publicRuntimeArtifactFiles]);
  } finally {
    await rm(runnerTemp, { force: true, recursive: true });
  }
});

test("Public producer rejects wrong inventory and batch, proof, cleanup or token drift", async (t) => {
  const runnerTemp = await mkdtemp(path.join(os.tmpdir(), "novalure-protected-public-negative-"));
  try {
    await t.test("wrong six-file inventory", async () => {
      const evidence = completeEvidence();
      evidence.proofs.pop();
      await assert.rejects(
        stageProtectedPublicEvidence(evidence, expected, { runnerTemp }),
        /PROTECTED_PUBLIC_PROOF_INVENTORY_INVALID/u,
      );
    });
    await t.test("QA batch drift", async () => {
      const evidence = completeEvidence();
      evidence.proofs[0].qaBatchId = "22222222-2222-4222-8222-222222222222";
      await assert.rejects(
        stageProtectedPublicEvidence(evidence, expected, { runnerTemp }),
        /PROTECTED_PUBLIC_PROOF_BINDING_INVALID/u,
      );
    });
    await t.test("long-proof duration drift", async () => {
      const evidence = completeEvidence();
      const proof = evidence.proofs.find((entry) => entry.id === "public-form-long-proof-refresh");
      proof.observations[1].observedAt = new Date(
        Date.parse(proof.observations[0].observedAt) + 60_000,
      ).toISOString();
      await assert.rejects(
        stageProtectedPublicEvidence(evidence, expected, { runnerTemp }),
        /PROTECTED_PUBLIC_LONG_PROOF_INVALID/u,
      );
    });
    await t.test("cleanup drift", async () => {
      const evidence = completeEvidence();
      evidence.cleanup.remainingObjectCount = 1;
      await assert.rejects(
        stageProtectedPublicEvidence(evidence, expected, { runnerTemp }),
        /PROTECTED_PUBLIC_CLEANUP_INVALID/u,
      );
    });
    await t.test("token rotation drift", async () => {
      const evidence = completeEvidence();
      const proof = evidence.proofs.find((entry) => entry.id === "funnel-publish-token-rotation");
      proof.semanticEvidence.newTokenSha256 = proof.semanticEvidence.oldTokenSha256;
      await assert.rejects(
        stageProtectedPublicEvidence(evidence, expected, { runnerTemp }),
        /PROTECTED_PUBLIC_TOKEN_ROTATION_INVALID/u,
      );
    });
  } finally {
    await rm(runnerTemp, { force: true, recursive: true });
  }
});
