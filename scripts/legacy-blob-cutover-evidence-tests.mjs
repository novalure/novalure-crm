import assert from "node:assert/strict";
import {
  generateKeyPairSync,
  sign as signDetached,
} from "node:crypto";
import {
  link,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  blobLegacyMigrationRecordType,
  blobLegacyMigrationRole,
} from "./lib/blob-legacy-migration-receipt.mjs";
import {
  buildExternalGateReceiptSigningPayload,
  canonicalJson,
  sha256,
} from "./lib/external-gate-receipts.mjs";
import {
  collectLegacyBlobCutoverProof,
  LegacyBlobCutoverEvidenceError,
  loadVerifiedLegacyBlobMigrationProof,
  writeExternalLegacyBlobProof,
} from "./lib/legacy-blob-cutover-evidence.mjs";
import {
  legacyBlobAssetKey,
  legacyBlobTargetFingerprint,
} from "./lib/legacy-blob-cutover.mjs";
import {
  previewBlobLifecycleExecutionConfirmation,
  PreviewBlobLifecycleError,
} from "./lib/preview-blob-lifecycle.mjs";
import { main as previewBlobLifecycleMain } from "./preview-blob-lifecycle.mjs";

const candidateCommit = "a".repeat(40);
const gitBranch = "codex/go-live-remediation-20260822";
const databaseBranchId = "br-isolatedpreview123";
const deploymentId = "dpl_1234567890ABCDEFGHIJ";
const deploymentHost = "novalure-blob-proof.vercel.app";
const runId = "GOLIVEBLOB_EVIDENCE_20260823";
const observedAt = "2026-08-23T20:00:00.000Z";
const signedAt = "2026-08-23T20:01:00.000Z";
const sourceStoreFingerprint = `sha256:${"1".repeat(20)}`;
const targetStoreFingerprint = `sha256:${"2".repeat(20)}`;
const content = Buffer.from("isolated-preview-legacy-proof", "utf8");
const workspaceId = "11111111-1111-4111-8111-111111111111";

const runtime = Object.freeze({
  candidateCommit,
  databaseBranchId,
  deploymentHost,
  deploymentId,
  gitBranch,
  productionMutationPerformed: false,
});

const databaseIdentity = Object.freeze({
  branchId: databaseBranchId,
  databaseName: "novalure_preview",
  projectId: "weathered-term-98273025",
  roleName: "preview_app",
});

const privateAsset = Object.freeze({
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  isPublic: false,
  mimeType: "application/pdf",
  relativePath: `${workspaceId}/legacy-proof.pdf`,
  sizeBytes: content.byteLength,
  storageAccess: "private",
  storageProvider: "vercel-blob",
  workspaceId,
});

function makeConfig(overrides = {}) {
  return {
    destinationStoreFingerprint: targetStoreFingerprint,
    maximumBlobBytes: 1024 * 1024,
    previewTarget: "isolated-preview",
    runId,
    sourceStoreFingerprint,
    ...overrides,
  };
}

function makeJournal(config = makeConfig(), overrides = {}) {
  const assetKey = legacyBlobAssetKey(privateAsset);
  const targetFingerprint = legacyBlobTargetFingerprint(databaseIdentity, config);
  const digest = sha256(content);
  const records = [
    {
      assetKey,
      at: "2026-08-22T18:00:00.000Z",
      deleteNotBefore: "2026-08-23T18:00:00.000Z",
      destinationStoreFingerprint: config.destinationStoreFingerprint,
      mode: "migrate",
      runId: config.runId,
      sha256: digest,
      sizeBytes: content.byteLength,
      sourceRetained: true,
      sourceStoreFingerprint: config.sourceStoreFingerprint,
      status: "migration-complete",
      targetFingerprint,
      version: 1,
    },
    {
      assetKey,
      at: observedAt,
      destinationStoreFingerprint: config.destinationStoreFingerprint,
      mode: "finalize",
      runId: config.runId,
      sha256: digest,
      sizeBytes: content.byteLength,
      sourceStoreFingerprint: config.sourceStoreFingerprint,
      status: "finalize-complete",
      targetFingerprint,
      version: 1,
    },
  ];
  const source = Buffer.from(`${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
  return {
    journalSha256: sha256(source),
    source,
    ...overrides,
  };
}

function makeDatabase(overrides = {}) {
  return {
    async listLegacyAssets() {
      return [];
    },
    async listPrivateAssets() {
      return [structuredClone(privateAsset)];
    },
    async verifyPreviewTarget() {
      return structuredClone(databaseIdentity);
    },
    ...overrides,
  };
}

function makeBlob(overrides = {}) {
  return {
    async listSourceObjects() {
      return [];
    },
    async readDestination(pathname) {
      return {
        body: Buffer.from(content),
        pathname,
        sizeBytes: content.byteLength,
      };
    },
    async readSource() {
      return null;
    },
    async readSourcePublic() {
      return { status: 404 };
    },
    ...overrides,
  };
}

async function collectDraft(overrides = {}) {
  const config = overrides.cutoverConfig ?? makeConfig();
  return collectLegacyBlobCutoverProof({
    blob: overrides.blob ?? makeBlob(),
    clock: () => new Date(observedAt),
    cutoverConfig: config,
    database: overrides.database ?? makeDatabase(),
    journal: overrides.journal ?? makeJournal(config),
    observedAt,
    runtime,
  });
}

function makeTrustContext() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const anchor = {
    keys: [{
      algorithm: "Ed25519",
      keyId: "key_blob_migration_ephemeral_20260823",
      publicKeyPem: publicKey.export({ format: "pem", type: "spki" }).toString(),
      role: blobLegacyMigrationRole,
      signerSubject: "subject:qa-blob-migration-attestor",
      status: "ACTIVE",
    }],
    recordType: "NOVALURE_RELEASE_APPROVAL_TRUST_ANCHOR",
    schemaVersion: 1,
    trustAnchorId: "ta_blob_migration_ephemeral_20260823",
  };
  return {
    privateKey,
    trustContext: {
      anchor,
      expectedSha256: sha256(canonicalJson(anchor)),
    },
  };
}

function signReceipt(draft, trustFixture) {
  const payload = {
    evidenceSha256: draft.evidenceDigest,
    journalSha256: draft.evidence.journalSha256,
    referenceInventorySha256: draft.evidence.referenceCutover.referenceInventorySha256,
    rollbackArtifactSha256: draft.evidence.rollback.artifactSha256,
    runtime,
    sourceInventorySha256: draft.evidence.sourceInventory.inventorySha256,
    sourceStoreFingerprint: draft.evidence.sourceStoreFingerprint,
    targetInventorySha256: draft.evidence.targetInventory.inventorySha256,
    targetStoreFingerprint: draft.evidence.targetStoreFingerprint,
  };
  const key = trustFixture.trustContext.anchor.keys[0];
  const receipt = {
    detachedSignature: "",
    keyId: key.keyId,
    payload,
    payloadSha256: sha256(canonicalJson(payload)),
    receiptId: `grc_${"3".repeat(32)}`,
    recordType: blobLegacyMigrationRecordType,
    role: blobLegacyMigrationRole,
    schemaVersion: 1,
    signatureAlgorithm: "Ed25519",
    signatureReference: "",
    signedAt,
    signerSubject: key.signerSubject,
    trustAnchorId: trustFixture.trustContext.anchor.trustAnchorId,
    trustAnchorSha256: trustFixture.trustContext.expectedSha256,
  };
  receipt.signatureReference = [
    "urn:novalure:gate-receipt:v1",
    receipt.trustAnchorId,
    receipt.keyId,
    receipt.role,
    receipt.recordType,
    receipt.payloadSha256,
  ].join(":");
  receipt.detachedSignature = signDetached(
    null,
    Buffer.from(buildExternalGateReceiptSigningPayload(receipt), "utf8"),
    trustFixture.privateKey,
  ).toString("base64");
  return receipt;
}

async function collectFinal({ draft = null, journal = null, receiptMutator = null } = {}) {
  const effectiveDraft = draft ?? await collectDraft();
  const trustFixture = makeTrustContext();
  const receipt = signReceipt(effectiveDraft, trustFixture);
  receiptMutator?.(receipt);
  const proof = await collectLegacyBlobCutoverProof({
    blob: makeBlob(),
    clock: () => new Date("2026-08-23T20:02:00.000Z"),
    cutoverConfig: makeConfig(),
    database: makeDatabase(),
    expectedDraftEvidenceDigest: effectiveDraft.evidenceDigest,
    journal: journal ?? makeJournal(),
    migrationReceipt: receipt,
    observedAt,
    runtime,
    trustContext: trustFixture.trustContext,
  });
  return { proof, receipt, trustFixture };
}

async function writeHashedJson(filePath, value) {
  const source = Buffer.from(canonicalJson(value), "utf8");
  const digest = sha256(source);
  await writeFile(filePath, source, { flag: "wx", mode: 0o400 });
  await writeFile(`${filePath}.sha256`, `${digest}  ${path.basename(filePath)}\n`, {
    flag: "wx",
    mode: 0o400,
  });
  return digest;
}

function previewExecutionEnv() {
  return {
    NOVALURE_PRIVATE_BLOB_STORE_ID: "prodprivate123",
    NOVALURE_PRODUCTION_ORIGIN: "https://www.novalure-crm.app",
    NOVALURE_PREVIEW_PRIVATE_BLOB_READ_WRITE_TOKEN: "vercel_blob_rw_preview123_testcredential",
    NOVALURE_PREVIEW_PRIVATE_BLOB_STORE_ID: "preview123",
    NOVALURE_PUBLIC_BLOB_STORE_ID: "prodpublic123",
    NOVALURE_QA_ACTIVE_GIT_BRANCH: gitBranch,
    NOVALURE_QA_BASE_URL: `https://${deploymentHost}`,
    NOVALURE_QA_BLOB_LIFECYCLE_CONFIRM: previewBlobLifecycleExecutionConfirmation,
    NOVALURE_QA_BLOB_RUN_ID: "GOLIVEBLOBHTTP_TEST_20260823",
    NOVALURE_QA_BRANCH_ID: databaseBranchId,
    NOVALURE_QA_DEPLOYMENT_ID: deploymentId,
    NOVALURE_QA_EXPECTED_GIT_BRANCH: gitBranch,
    NOVALURE_QA_EXPECTED_GIT_SHA: candidateCommit,
    NOVALURE_QA_EXPECTED_HOST: deploymentHost,
    NOVALURE_QA_RESET_ADMIN_EMAIL: "codextest_preview_reset@example.test",
    NOVALURE_QA_RESET_ADMIN_PASSWORD: "qa-test-password-1234567890",
    NOVALURE_QA_RESET_ADMIN_TOTP_SECRET: "JBSWY3DPEHPK3PXP",
    NOVALURE_QA_TENANT_A_RESET_ACTOR_USER_ID: "22222222-2222-4222-8222-222222222222",
    NOVALURE_QA_TENANT_A_WORKSPACE_ID: workspaceId,
    NOVALURE_QA_TENANT_B_OWNER_EMAIL: "codextest_preview_tenant_b_owner@example.test",
    NOVALURE_QA_TENANT_B_OWNER_PASSWORD: "qa-tenant-b-password-1234567890",
    NOVALURE_QA_TENANT_B_OWNER_TOTP_SECRET: "KRSXG5DSNFXGOIDB",
    NOVALURE_QA_TENANT_B_OWNER_USER_ID: "55555555-5555-4555-8555-555555555555",
    NOVALURE_QA_TENANT_B_WORKSPACE_ID: "44444444-4444-4444-8444-444444444444",
  };
}

test("collector reconstructs object-level proof and verifies an external Ed25519 receipt", async () => {
  const draft = await collectDraft();
  assert.equal(draft.status, "PENDING_EXTERNAL_RECEIPT");
  assert.equal(draft.migrationReceipt, null);
  assert.equal(draft.evidence.oldStorePostcondition.listedObjectCount, 0);
  assert.equal(draft.evidence.sourceInventory.objectCount, 1);
  assert.equal(draft.evidence.targetInventory.objectCount, 1);

  const { proof } = await collectFinal({ draft });
  assert.equal(proof.status, "VERIFIED");
  assert.equal(proof.reasonCode, null);
  assert.equal(proof.migratedObjectCount, 1);
  assert.equal(proof.productionMutationPerformed, false);
});

test("lifecycle execute mode fails before network access when the external proof is absent", async () => {
  await assert.rejects(
    () => previewBlobLifecycleMain(["--execute"], previewExecutionEnv()),
    (error) => error instanceof PreviewBlobLifecycleError
      && error.code === "LEGACY_MIGRATION_PROOF_REQUIRED",
  );
});

test("journal bytes are the source of truth and a wrong journal digest is rejected", async () => {
  const journal = makeJournal();
  journal.journalSha256 = sha256("different-journal");
  await assert.rejects(
    () => collectDraft({ journal }),
    (error) => error instanceof LegacyBlobCutoverEvidenceError
      && error.code === "BLOB_EVIDENCE_JOURNAL_DIGEST_MISMATCH",
  );
});

test("store and database drift fail closed", async () => {
  const driftedConfig = makeConfig({ destinationStoreFingerprint: `sha256:${"9".repeat(20)}` });
  await assert.rejects(
    () => collectDraft({ cutoverConfig: driftedConfig, journal: makeJournal() }),
    (error) => error instanceof LegacyBlobCutoverEvidenceError
      && error.code === "BLOB_EVIDENCE_JOURNAL_TARGET_MISMATCH",
  );
  await assert.rejects(
    () => collectDraft({
      database: makeDatabase({
        async verifyPreviewTarget() {
          return { ...databaseIdentity, branchId: "br-driftedpreview123" };
        },
      }),
    }),
    (error) => error instanceof LegacyBlobCutoverEvidenceError
      && error.code === "BLOB_EVIDENCE_DATABASE_BRANCH_MISMATCH",
  );
});

test("same-count and same-size destination content drift is detected", async () => {
  const drifted = Buffer.from(content);
  drifted[0] ^= 1;
  await assert.rejects(
    () => collectDraft({
      blob: makeBlob({
        async readDestination(pathname) {
          return { body: drifted, pathname, sizeBytes: drifted.byteLength };
        },
      }),
    }),
    (error) => error instanceof LegacyBlobCutoverEvidenceError
      && error.code === "BLOB_EVIDENCE_TARGET_CONTENT_DRIFT",
  );
});

test("source-store, public-read and database postconditions are mandatory", async () => {
  const scenarios = [
    [makeBlob({ async listSourceObjects() { return [privateAsset.relativePath]; } }), "BLOB_EVIDENCE_SOURCE_STORE_NOT_EMPTY"],
    [makeBlob({ async readSource() { return { body: content }; } }), "BLOB_EVIDENCE_SOURCE_AUTHENTICATED_READ_NOT_DENIED"],
    [makeBlob({ async readSourcePublic() { return { status: 200 }; } }), "BLOB_EVIDENCE_SOURCE_PUBLIC_READ_NOT_DENIED"],
  ];
  for (const [blob, code] of scenarios) {
    await assert.rejects(
      () => collectDraft({ blob }),
      (error) => error instanceof LegacyBlobCutoverEvidenceError && error.code === code,
    );
  }
  await assert.rejects(
    () => collectDraft({ database: makeDatabase({ async listLegacyAssets() { return [privateAsset]; } }) }),
    (error) => error instanceof LegacyBlobCutoverEvidenceError
      && error.code === "BLOB_EVIDENCE_LEGACY_DATABASE_ROWS_REMAIN",
  );
});

test("unsigned, tampered and replayed receipts never verify", async () => {
  const draft = await collectDraft();
  await assert.rejects(
    () => collectFinal({ draft, receiptMutator(receipt) { receipt.detachedSignature = ""; } }),
    /EXTERNAL_GATE_RECEIPT_SIGNATURE_INVALID/u,
  );
  await assert.rejects(
    () => collectFinal({
      draft,
      receiptMutator(receipt) {
        receipt.payload.targetInventorySha256 = "f".repeat(64);
      },
    }),
    /EXTERNAL_GATE_RECEIPT_PAYLOAD_DIGEST_MISMATCH/u,
  );
  const changedJournal = makeJournal();
  changedJournal.source = Buffer.concat([changedJournal.source, Buffer.from("\n")]);
  changedJournal.journalSha256 = sha256(changedJournal.source);
  await assert.rejects(
    () => collectFinal({ draft, journal: changedJournal }),
    (error) => error instanceof LegacyBlobCutoverEvidenceError
      && error.code === "BLOB_EVIDENCE_DRAFT_RECHECK_MISMATCH",
  );
});

test("positive external proof path verifies and binds candidate, deployment, database and store", async () => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "novalure-blob-proof-positive-"));
  const repositoryRoot = path.join(temporaryRoot, "repository");
  const externalRoot = path.join(temporaryRoot, "external");
  await Promise.all([mkdir(repositoryRoot), mkdir(externalRoot)]);
  try {
    const { proof, trustFixture } = await collectFinal();
    const proofPath = path.join(externalRoot, "legacy-blob-proof.json");
    const anchorPath = path.join(externalRoot, "trust-anchor.json");
    const written = await writeExternalLegacyBlobProof({ outputPath: proofPath, proof, repositoryRoot });
    await writeFile(anchorPath, canonicalJson(trustFixture.trustContext.anchor), { flag: "wx", mode: 0o400 });
    const loaded = await loadVerifiedLegacyBlobMigrationProof({
      expectedProofSha256: written.digest,
      expectedTrustAnchorSha256: trustFixture.trustContext.expectedSha256,
      proofPath,
      repositoryRoot,
      runtime,
      targetStoreFingerprint,
      trustAnchorPath: anchorPath,
    });
    assert.equal(loaded.status, "VERIFIED");
    assert.equal(loaded.evidence.deploymentId, deploymentId);
    assert.equal(loaded.evidence.targetDatabaseBranchId, databaseBranchId);
    assert.equal(loaded.storeFingerprint, targetStoreFingerprint);
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
});

test("external proof loader rejects hardlinks, symlinks and repository path escape", async (t) => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "novalure-blob-proof-path-"));
  const repositoryRoot = path.join(temporaryRoot, "repository");
  const externalRoot = path.join(temporaryRoot, "external");
  await Promise.all([mkdir(repositoryRoot), mkdir(externalRoot)]);
  try {
    const { proof, trustFixture } = await collectFinal();
    const anchorPath = path.join(externalRoot, "trust-anchor.json");
    await writeFile(anchorPath, canonicalJson(trustFixture.trustContext.anchor), { flag: "wx", mode: 0o400 });
    const proofPath = path.join(externalRoot, "proof.json");
    const proofDigest = await writeHashedJson(proofPath, proof);

    const hardlinkPath = path.join(externalRoot, "proof-hardlink.json");
    await link(proofPath, hardlinkPath);
    await writeFile(`${hardlinkPath}.sha256`, `${proofDigest}  ${path.basename(hardlinkPath)}\n`, { flag: "wx" });
    await assert.rejects(
      () => loadVerifiedLegacyBlobMigrationProof({
        expectedProofSha256: proofDigest,
        expectedTrustAnchorSha256: trustFixture.trustContext.expectedSha256,
        proofPath: hardlinkPath,
        repositoryRoot,
        runtime,
        targetStoreFingerprint,
        trustAnchorPath: anchorPath,
      }),
      (error) => error instanceof LegacyBlobCutoverEvidenceError
        && error.code === "BLOB_EVIDENCE_PROOF_NOT_BOUNDED_REGULAR_FILE",
    );

    const separateProofPath = path.join(externalRoot, "proof-separate.json");
    const separateDigest = await writeHashedJson(separateProofPath, proof);
    const symlinkPath = path.join(externalRoot, "proof-symlink.json");
    try {
      await symlink(separateProofPath, symlinkPath, "file");
      await writeFile(`${symlinkPath}.sha256`, `${separateDigest}  ${path.basename(symlinkPath)}\n`, { flag: "wx" });
      await assert.rejects(
        () => loadVerifiedLegacyBlobMigrationProof({
          expectedProofSha256: separateDigest,
          expectedTrustAnchorSha256: trustFixture.trustContext.expectedSha256,
          proofPath: symlinkPath,
          repositoryRoot,
          runtime,
          targetStoreFingerprint,
          trustAnchorPath: anchorPath,
        }),
        (error) => error instanceof LegacyBlobCutoverEvidenceError
          && error.code === "BLOB_EVIDENCE_PROOF_NOT_BOUNDED_REGULAR_FILE",
      );
    } catch (error) {
      if (!["EPERM", "EACCES"].includes(error?.code)) throw error;
      t.diagnostic("Symlink creation is unavailable on this Windows host; hardlink and path-boundary checks still ran.");
    }

    const inRepositoryPath = path.join(repositoryRoot, "proof.json");
    const inRepositoryDigest = await writeHashedJson(inRepositoryPath, proof);
    await assert.rejects(
      () => loadVerifiedLegacyBlobMigrationProof({
        expectedProofSha256: inRepositoryDigest,
        expectedTrustAnchorSha256: trustFixture.trustContext.expectedSha256,
        proofPath: inRepositoryPath,
        repositoryRoot,
        runtime,
        targetStoreFingerprint,
        trustAnchorPath: anchorPath,
      }),
      (error) => error instanceof LegacyBlobCutoverEvidenceError
        && [
          "BLOB_EVIDENCE_PROOF_MUST_BE_OUTSIDE_REPOSITORY",
          "BLOB_EVIDENCE_PROOF_SIDECAR_MUST_BE_OUTSIDE_REPOSITORY",
        ].includes(error.code),
    );
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
});
