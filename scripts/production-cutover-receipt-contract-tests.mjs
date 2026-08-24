import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync, sign } from "node:crypto";
import {
  linkSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildExternalGateReceiptSigningPayload,
  canonicalJson,
  externalGateTrustAnchorRecordType,
  sha256,
} from "./lib/external-gate-receipts.mjs";
import {
  buildProductionCutoverEvidenceSha256,
  loadCanonicalProductionCutoverDocument,
  productionCutoverDeploymentCommand,
  productionCutoverExpectedProductionHost,
  productionCutoverExpectedVercelProjectId,
  productionCutoverMaximumFutureSkewMs,
  productionCutoverMaximumReadinessAgeMs,
  productionCutoverMigrations,
  productionCutoverPostLedgerQuerySha256,
  productionCutoverReceiptRecordType,
  productionCutoverReceiptRoles,
  productionCutoverRecordType,
  productionCutoverSchemaVersion,
  productionCutoverStatus,
  verifyProductionCutoverEvidence,
  verifyProductionCutoverReceiptBundle,
} from "./lib/production-cutover-receipt.mjs";
import {
  productionCutoverMaximumFutureSkewMs as runtimeMaximumFutureSkewMs,
  productionCutoverMaximumReadinessAgeMs as runtimeMaximumReadinessAgeMs,
  productionCutoverReceiptRoles as runtimeReceiptRoles,
  verifyProductionCutoverReceiptBundle as verifyRuntimeProductionCutoverReceiptBundle,
} from "./lib/production-cutover-receipt-runtime.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const productionCutoverTestCandidateCommit = spawnSync("git", ["rev-parse", "HEAD"], {
  cwd: repositoryRoot,
  encoding: "utf8",
  windowsHide: true,
}).stdout.trim();
export const productionCutoverTestTarget = Object.freeze({
  databaseName: "neondb",
  neonBranchId: "br-snowy-fog-aldx77v8",
  neonProjectId: "misty-cloud-70835427",
  productionHost: productionCutoverExpectedProductionHost,
  stagedDeploymentHost: "novalure-staged-production.vercel.app",
  stagedDeploymentId: "dpl_stagedproductionabcdefghij",
  vercelProjectId: productionCutoverExpectedVercelProjectId,
});
export const productionCutoverTestRollback = Object.freeze({
  rollbackDeploymentHost: "novalure-rollback-production.vercel.app",
  rollbackDeploymentId: "dpl_rollbackproductionabcdefgh",
});
const candidateCommit = productionCutoverTestCandidateCommit;
const target = productionCutoverTestTarget;
const rollback = productionCutoverTestRollback;

function gitBlob(path) {
  const result = spawnSync("git", ["show", `${productionCutoverTestCandidateCommit}:${path}`], {
    cwd: repositoryRoot,
    encoding: null,
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr?.toString());
  return sha256(result.stdout);
}

const candidateMigrationSha256 = new Map(
  productionCutoverMigrations.map(({ path }) => [path, gitBlob(path)]),
);

function keyFixture(role, index) {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privateKey,
    trustKey: {
      algorithm: "Ed25519",
      keyId: `key_production_cutover_${index}_20260824`,
      publicKeyPem: publicKey.export({ format: "pem", type: "spki" }).toString(),
      role,
      signerSubject: `subject:novalure-production-cutover-${index}`,
      status: "ACTIVE",
    },
  };
}

function signReceipt({
  anchor,
  completedAt,
  evidenceSha256,
  key,
  role,
  signedAt,
  trustAnchorSha256,
  index,
}) {
  const payload = {
    candidateCommit,
    completedAt,
    databaseName: target.databaseName,
    evidenceSha256,
    neonBranchId: target.neonBranchId,
    neonProjectId: target.neonProjectId,
    stagedDeploymentId: target.stagedDeploymentId,
    status: productionCutoverStatus,
    vercelProjectId: target.vercelProjectId,
  };
  const payloadSha256 = sha256(canonicalJson(payload));
  const receipt = {
    detachedSignature: "",
    keyId: key.trustKey.keyId,
    payload,
    payloadSha256,
    receiptId: `grc_${String(index).repeat(32)}`,
    recordType: productionCutoverReceiptRecordType,
    role,
    schemaVersion: 1,
    signatureAlgorithm: "Ed25519",
    signatureReference: [
      "urn:novalure:gate-receipt:v1",
      anchor.trustAnchorId,
      key.trustKey.keyId,
      role,
      productionCutoverReceiptRecordType,
      payloadSha256,
    ].join(":"),
    signedAt,
    signerSubject: key.trustKey.signerSubject,
    trustAnchorId: anchor.trustAnchorId,
    trustAnchorSha256,
  };
  receipt.detachedSignature = sign(
    null,
    Buffer.from(buildExternalGateReceiptSigningPayload(receipt), "utf8"),
    key.privateKey,
  ).toString("base64");
  return receipt;
}

export function createProductionCutoverTestFixture({
  additionalTrustKeys = [],
  nowEpochMs = Date.now(),
} = {}) {
  const verificationNowEpochMs = Math.floor(nowEpochMs / 1000) * 1000;
  const startedAtEpochMs = verificationNowEpochMs - (2 * 60 * 1000);
  const at = (offsetMs) => new Date(startedAtEpochMs + offsetMs).toISOString();
  const keys = Object.entries(productionCutoverReceiptRoles).map(([name, role], index) => ({
    name,
    role,
    ...keyFixture(role, index + 1),
  }));
  const anchor = {
    keys: [...keys.map(({ trustKey }) => trustKey), ...additionalTrustKeys],
    recordType: externalGateTrustAnchorRecordType,
    schemaVersion: 1,
    trustAnchorId: "ta_production_cutover_20260824",
  };
  const trustAnchorSha256 = sha256(canonicalJson(anchor));
  const migrations = productionCutoverMigrations.map(({ path, version }, index) => ({
    appliedAt: at((10 + index) * 1000),
    candidateBlobSha256: candidateMigrationSha256.get(path),
    cutoverDecision: [
      "061_validate_and_activate_tenant_rls_pilot",
      "062_private_media_contract_cutover",
      "065_notification_guard_search_path_hardening",
    ].includes(version)
      ? "EXPLICIT_APPLIED_PASS_CUTOVER"
      : "CONTROLLED_APPLIED_PASS",
    cutoverEvidenceSha256: sha256(`cutover:${version}`),
    path,
    postconditionEvidenceSha256: sha256(`postcondition:${version}`),
    status: "APPLIED_PASS",
    version,
  }));
  const ledgerEntries = migrations.map(({ candidateBlobSha256: checksum, version }) => ({
    checksum,
    version,
  }));
  const document = {
    candidateCommit: productionCutoverTestCandidateCommit,
    completedAt: at(40 * 1000),
    database: {
      backup: {
        capturedAt: at(1000),
        evidenceSha256: sha256("backup"),
        pitrEnabled: true,
        pitrWindowEvidenceSha256: sha256("pitr-window"),
        snapshotFingerprintSha256: sha256("snapshot"),
        status: "PASS",
      },
      migrations,
      postLedger: {
        capturedAt: at(27 * 1000),
        entries: ledgerEntries,
        entriesSha256: sha256(canonicalJson(ledgerEntries)),
        evidenceSha256: sha256("post-ledger"),
        querySha256: productionCutoverPostLedgerQuerySha256,
        status: "PASS",
      },
      restoreDrill: {
        completedAt: at(9 * 1000),
        databaseName: "neondb",
        evidenceSha256: sha256("restore"),
        neonBranchId: "br-independent-restore-20260824",
        neonProjectId: "misty-cloud-70835427",
        productionMutationPerformed: false,
        reconciliationSha256: sha256("restore-reconciliation"),
        restoredDataFingerprintSha256: sha256("production-data"),
        sourceDataFingerprintSha256: sha256("production-data"),
        sourceSnapshotFingerprintSha256: sha256("snapshot"),
        startedAt: at(2 * 1000),
        status: "PASS",
      },
    },
    deployment: {
      aliasPromotion: {
        alias: productionCutoverExpectedProductionHost,
        evidenceSha256: sha256("alias-promotion"),
        previousDeploymentId: rollback.rollbackDeploymentId,
        promotedAt: at(37 * 1000),
        result: "PROMOTED_EXACT",
        sourceDeploymentId: target.stagedDeploymentId,
      },
      deploymentCommand: productionCutoverDeploymentCommand,
      domainAssignedDuringStaging: false,
      postPromotionSmoke: {
        activationState: "SAFE_CLOSED",
        checkedAt: at(38 * 1000),
        deploymentHost: productionCutoverExpectedProductionHost,
        deploymentId: target.stagedDeploymentId,
        evidenceSha256: sha256("post-promotion-smoke"),
        result: "PASS_SAFE_CLOSED",
      },
      prePromotionSmoke: {
        activationState: "SAFE_CLOSED",
        checkedAt: at(36 * 1000),
        deploymentHost: target.stagedDeploymentHost,
        deploymentId: target.stagedDeploymentId,
        evidenceSha256: sha256("pre-promotion-smoke"),
        result: "PASS",
      },
      rollback: {
        deploymentHost: rollback.rollbackDeploymentHost,
        deploymentId: rollback.rollbackDeploymentId,
        evidenceSha256: sha256("rollback"),
        status: "READY",
        verifiedAt: at(35 * 1000),
      },
      stagedAt: at(34 * 1000),
      stagingEvidenceSha256: sha256("staging"),
    },
    monitoring: {
      alertDeliveryEvidenceSha256: sha256("alert-delivery"),
      armedAt: at(31 * 1000),
      errorIngestionEvidenceSha256: sha256("error-ingestion"),
      readinessCheckedAt: at(33 * 1000),
      scope: productionCutoverStatus,
      status: "PASS",
      syntheticAlarmEvidenceSha256: sha256("synthetic-alarm"),
    },
    receipts: {},
    recordType: productionCutoverRecordType,
    schemaVersion: productionCutoverSchemaVersion,
    startedAt: at(0),
    status: productionCutoverStatus,
    storage: {
      legacyMigration: {
        completedAt: at(30 * 1000),
        evidenceSha256: sha256("legacy-migration"),
        migratedObjectCount: 12,
        postInventorySha256: sha256("blob-post-inventory"),
        postLegacyResidualObjectCount: 0,
        postProductionObjectCount: 20,
        sourceInventorySha256: sha256("blob-source-inventory"),
        sourceLegacyObjectCount: 12,
        startedAt: at(28 * 1000),
        status: "PASS",
      },
      previewStoreFingerprintSha256: sha256("preview-blob-store"),
      productionStoreFingerprintSha256: sha256("production-blob-store"),
    },
    target: { ...target },
  };
  const evidenceSha256 = buildProductionCutoverEvidenceSha256(document);
  document.receipts = Object.fromEntries(keys.map((key, index) => [
    key.name,
    signReceipt({
      anchor,
      completedAt: document.completedAt,
      evidenceSha256,
      index: index + 1,
      key,
      role: key.role,
      signedAt: at((41 + index) * 1000),
      trustAnchorSha256,
    }),
  ]));
  return {
    document,
    trustContext: { anchor, expectedSha256: trustAnchorSha256 },
    verificationNowEpochMs,
  };
}

function verify(fixture) {
  return verifyProductionCutoverEvidence({
    document: fixture.document,
    expectedCandidateCommit: productionCutoverTestCandidateCommit,
    expectedTarget: {
      ...rollback,
      stagedDeploymentHost: target.stagedDeploymentHost,
      stagedDeploymentId: target.stagedDeploymentId,
    },
    nowEpochMs: fixture.verificationNowEpochMs,
    repositoryRoot,
    trustContext: fixture.trustContext,
  });
}

const createFixture = createProductionCutoverTestFixture;

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
test("three independent Ed25519 roles attest one exact PRE_ACTIVATION_READY evidence digest", () => {
  const fixture = createFixture();
  const result = verify(fixture);
  assert.equal(result.status, productionCutoverStatus);
  assert.equal(result.evidenceSha256, buildProductionCutoverEvidenceSha256(fixture.document));
  assert.deepEqual(Object.keys(result.receiptSha256ByRole).sort(), Object.keys(productionCutoverReceiptRoles).sort());
  assert.equal(new Set(Object.values(result.receiptSha256ByRole)).size, 3);
});

test("runtime receipt-bundle verification rechecks the complete digest without Git access", () => {
  const fixture = createFixture();
  const result = verifyProductionCutoverReceiptBundle({
    document: fixture.document,
    expectedCandidateCommit: candidateCommit,
    expectedTarget: {
      ...rollback,
      stagedDeploymentHost: target.stagedDeploymentHost,
      stagedDeploymentId: target.stagedDeploymentId,
    },
    nowEpochMs: fixture.verificationNowEpochMs,
    trustContext: fixture.trustContext,
  });
  assert.equal(result.evidenceSha256, buildProductionCutoverEvidenceSha256(fixture.document));
  assert.equal(runtimeMaximumFutureSkewMs, productionCutoverMaximumFutureSkewMs);
  assert.equal(runtimeMaximumReadinessAgeMs, productionCutoverMaximumReadinessAgeMs);
  assert.deepEqual(runtimeReceiptRoles, productionCutoverReceiptRoles);
  const runtimeResult = verifyRuntimeProductionCutoverReceiptBundle({
    document: fixture.document,
    expectedCandidateCommit: candidateCommit,
    expectedTarget: {
      ...rollback,
      stagedDeploymentHost: target.stagedDeploymentHost,
      stagedDeploymentId: target.stagedDeploymentId,
    },
    nowEpochMs: fixture.verificationNowEpochMs,
    trustContext: fixture.trustContext,
  });
  assert.deepEqual(runtimeResult, result);
  const runtimeSource = readFileSync(
    new URL("./lib/production-cutover-receipt-runtime.mjs", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(runtimeSource, /node:fs|node:child_process|\bfetch\s*\(/u);
  const tampered = structuredClone(fixture.document);
  tampered.database.migrations[0].candidateBlobSha256 = "f".repeat(64);
  assert.throws(
    () => verifyProductionCutoverReceiptBundle({
      document: tampered,
      expectedCandidateCommit: candidateCommit,
      expectedTarget: {
        ...rollback,
        stagedDeploymentHost: target.stagedDeploymentHost,
        stagedDeploymentId: target.stagedDeploymentId,
      },
      nowEpochMs: fixture.verificationNowEpochMs,
      trustContext: fixture.trustContext,
    }),
    /PRODUCTION_CUTOVER_RECEIPT_PAYLOAD_MISMATCH/u,
  );
});

test("target, candidate checksums, post-ledger and explicit 061/062/065 cutovers fail closed", () => {
  const mutations = [
    ["target", (document) => { document.target.neonProjectId = "weathered-term-98273025"; }, /PRODUCTION_CUTOVER_NEON_PROJECT_MISMATCH/u],
    ["checksum", (document) => { document.database.migrations[0].candidateBlobSha256 = "f".repeat(64); }, /CANDIDATE_CHECKSUM_MISMATCH/u],
    ["post-ledger", (document) => { document.database.postLedger.entries[0].checksum = "e".repeat(64); }, /POST_LEDGER_MISMATCH/u],
    ["explicit cutover", (document) => { document.database.migrations[2].cutoverDecision = "CONTROLLED_APPLIED_PASS"; }, /MIGRATION_DECISION_INVALID/u],
    ["deferred cutover", (document) => { document.database.migrations[3].status = "DEFERRED_PASS"; }, /MIGRATION_NOT_APPLIED_PASS/u],
  ];
  for (const [label, mutate, expectedError] of mutations) {
    const fixture = createFixture();
    mutate(fixture.document);
    assert.throws(() => verify(fixture), expectedError, label);
  }
});

test("PITR, independent restore, Blob distance and zero Legacy residual are mandatory", () => {
  const mutations = [
    [(document) => { document.database.backup.pitrEnabled = false; }, /PITR_NOT_ENABLED/u],
    [(document) => { document.database.restoreDrill.neonBranchId = target.neonBranchId; }, /RESTORE_NOT_INDEPENDENT/u],
    [(document) => { document.database.restoreDrill.restoredDataFingerprintSha256 = sha256("drift"); }, /RESTORE_DATA_MISMATCH/u],
    [(document) => { document.storage.productionStoreFingerprintSha256 = document.storage.previewStoreFingerprintSha256; }, /BLOB_STORES_NOT_DISTINCT/u],
    [(document) => { document.storage.legacyMigration.postLegacyResidualObjectCount = 1; }, /BLOB_RESIDUAL_NOT_ZERO/u],
  ];
  for (const [mutate, expectedError] of mutations) {
    const fixture = createFixture();
    mutate(fixture.document);
    assert.throws(() => verify(fixture), expectedError);
  }
});

test("skip-domain staging, exact alias, safe-closed smoke, rollback and time order are mandatory", () => {
  const mutations = [
    [(document) => { document.deployment.deploymentCommand = "vercel --prod"; }, /SKIP_DOMAIN_COMMAND_REQUIRED/u],
    [(document) => { document.deployment.domainAssignedDuringStaging = true; }, /DOMAIN_ASSIGNED_DURING_STAGING/u],
    [(document) => { document.deployment.aliasPromotion.alias = "other.example.com"; }, /ALIAS_MISMATCH/u],
    [(document) => { document.deployment.postPromotionSmoke.activationState = "ACTIVE"; }, /POST_PROMOTION_SMOKE_ACTIVATION_NOT_SAFE_CLOSED/u],
    [(document) => { document.deployment.rollback.status = "PENDING"; }, /ROLLBACK_NOT_READY/u],
    [(document) => { document.deployment.postPromotionSmoke.checkedAt = "2026-08-24T00:00:36.000Z"; }, /POST_PROMOTION_SMOKE_CHECKED_AT_ORDER_INVALID/u],
  ];
  for (const [mutate, expectedError] of mutations) {
    const fixture = createFixture();
    mutate(fixture.document);
    assert.throws(() => verify(fixture), expectedError);
  }
});

test("launch readiness rejects future, stale and non-strict UTC cutover evidence", () => {
  {
    const fixture = createFixture();
    const started = Date.parse(fixture.document.startedAt);
    assert.doesNotThrow(() => verifyProductionCutoverEvidence({
      document: fixture.document,
      expectedCandidateCommit: candidateCommit,
      expectedTarget: {
        ...rollback,
        stagedDeploymentHost: target.stagedDeploymentHost,
        stagedDeploymentId: target.stagedDeploymentId,
      },
      nowEpochMs: started + productionCutoverMaximumReadinessAgeMs,
      repositoryRoot,
      trustContext: fixture.trustContext,
    }));
    assert.throws(
      () => verifyProductionCutoverEvidence({
        document: fixture.document,
        expectedCandidateCommit: candidateCommit,
        expectedTarget: {
          ...rollback,
          stagedDeploymentHost: target.stagedDeploymentHost,
          stagedDeploymentId: target.stagedDeploymentId,
        },
        nowEpochMs: started + productionCutoverMaximumReadinessAgeMs + 1,
        repositoryRoot,
        trustContext: fixture.trustContext,
      }),
      /PRODUCTION_CUTOVER_STARTED_AT_STALE/u,
    );
  }
  {
    const fixture = createFixture();
    fixture.document.startedAt = new Date(
      fixture.verificationNowEpochMs - productionCutoverMaximumReadinessAgeMs - 1,
    ).toISOString();
    const expectedError = /PRODUCTION_CUTOVER_STARTED_AT_STALE/u;
    assert.throws(() => verifyProductionCutoverReceiptBundle({
      document: fixture.document,
      expectedCandidateCommit: candidateCommit,
      expectedTarget: {
        ...rollback,
        stagedDeploymentHost: target.stagedDeploymentHost,
        stagedDeploymentId: target.stagedDeploymentId,
      },
      nowEpochMs: fixture.verificationNowEpochMs,
      trustContext: fixture.trustContext,
    }), expectedError);
    assert.throws(() => verifyRuntimeProductionCutoverReceiptBundle({
      document: fixture.document,
      expectedCandidateCommit: candidateCommit,
      expectedTarget: {
        ...rollback,
        stagedDeploymentHost: target.stagedDeploymentHost,
        stagedDeploymentId: target.stagedDeploymentId,
      },
      nowEpochMs: fixture.verificationNowEpochMs,
      trustContext: fixture.trustContext,
    }), expectedError);
  }
  {
    const fixture = createFixture();
    const completion = Date.parse(fixture.document.completedAt);
    assert.throws(
      () => verifyProductionCutoverReceiptBundle({
        document: fixture.document,
        expectedCandidateCommit: candidateCommit,
        expectedTarget: {
          ...rollback,
          stagedDeploymentHost: target.stagedDeploymentHost,
          stagedDeploymentId: target.stagedDeploymentId,
        },
        nowEpochMs: completion - productionCutoverMaximumFutureSkewMs - 1,
        trustContext: fixture.trustContext,
      }),
      /PRODUCTION_CUTOVER_COMPLETED_AT_IN_FUTURE/u,
    );
  }
  {
    const fixture = createFixture();
    const completion = Date.parse(fixture.document.completedAt);
    assert.throws(
      () => verifyProductionCutoverReceiptBundle({
        document: fixture.document,
        expectedCandidateCommit: candidateCommit,
        expectedTarget: {
          ...rollback,
          stagedDeploymentHost: target.stagedDeploymentHost,
          stagedDeploymentId: target.stagedDeploymentId,
        },
        nowEpochMs: completion - productionCutoverMaximumFutureSkewMs,
        trustContext: fixture.trustContext,
      }),
      /PRODUCTION_CUTOVER_RECEIPT_SIGNED_AT_IN_FUTURE/u,
    );
  }
  for (const timestampValue of [
    "2026-08-24T00:00:00Z",
    "2026-08-24T00:00:00.000+00:00",
    "2026-02-31T00:00:00.000Z",
  ]) {
    const fixture = createFixture();
    fixture.document.startedAt = timestampValue;
    assert.throws(
      () => verify(fixture),
      /PRODUCTION_CUTOVER_STARTED_AT_INVALID/u,
      timestampValue,
    );
  }
  {
    const fixture = createFixture();
    assert.throws(
      () => verifyProductionCutoverReceiptBundle({
        document: fixture.document,
        expectedCandidateCommit: candidateCommit,
        expectedTarget: {
          ...rollback,
          stagedDeploymentHost: target.stagedDeploymentHost,
          stagedDeploymentId: target.stagedDeploymentId,
        },
        nowEpochMs: Number.NaN,
        trustContext: fixture.trustContext,
      }),
      /PRODUCTION_CUTOVER_NOW_EPOCH_MS_INVALID/u,
    );
  }
});

test("role, signature, signed-time and post-signature tampering fail cryptographically", () => {
  {
    const fixture = createFixture();
    fixture.document.receipts.dba = fixture.document.receipts.platformOperations;
    assert.throws(() => verify(fixture), /EXTERNAL_GATE_RECEIPT_ROLE_MISMATCH/u);
  }
  {
    const fixture = createFixture();
    fixture.document.receipts.releaseObserver.detachedSignature = `${fixture.document.receipts.releaseObserver.detachedSignature.slice(0, -4)}AAAA`;
    assert.throws(() => verify(fixture), /EXTERNAL_GATE_RECEIPT_SIGNATURE/u);
  }
  {
    const fixture = createFixture();
    fixture.document.receipts.dba.signedAt = "2026-08-23T23:59:59.000Z";
    assert.throws(() => verify(fixture), /(?:SIGNATURE_VERIFICATION_FAILED|PREDATES_COMPLETION)/u);
  }
  {
    const fixture = createFixture();
    fixture.document.monitoring.alertDeliveryEvidenceSha256 = sha256("tampered");
    assert.throws(() => verify(fixture), /RECEIPT_PAYLOAD_MISMATCH/u);
  }
});

test("the three cutover roles require independent signer subjects and Ed25519 keys", () => {
  for (const [mutate, expectedError] of [
    [
      (anchor) => { anchor.keys[1].signerSubject = anchor.keys[0].signerSubject; },
      /EXTERNAL_GATE_TRUST_SIGNER_SUBJECT_REUSED/u,
    ],
    [
      (anchor) => { anchor.keys[1].publicKeyPem = anchor.keys[0].publicKeyPem; },
      /EXTERNAL_GATE_TRUST_PUBLIC_KEY_REUSED/u,
    ],
  ]) {
    const fixture = createFixture();
    mutate(fixture.trustContext.anchor);
    fixture.trustContext.expectedSha256 = sha256(canonicalJson(fixture.trustContext.anchor));
    for (const verifier of [
      verifyProductionCutoverReceiptBundle,
      verifyRuntimeProductionCutoverReceiptBundle,
    ]) {
      assert.throws(() => verifier({
        document: fixture.document,
        expectedCandidateCommit: candidateCommit,
        expectedTarget: {
          ...rollback,
          stagedDeploymentHost: target.stagedDeploymentHost,
          stagedDeploymentId: target.stagedDeploymentId,
        },
        nowEpochMs: fixture.verificationNowEpochMs,
        trustContext: fixture.trustContext,
      }), expectedError);
    }
  }
});

test("canonical external document loader rejects repository paths and hardlinks", async () => {
  const fixture = createFixture();
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "novalure-production-cutover-"));
  const documentPath = join(temporaryDirectory, "production-cutover.json");
  const hardlinkPath = join(temporaryDirectory, "production-cutover-hardlink.json");
  try {
    writeFileSync(documentPath, canonicalJson(fixture.document), { encoding: "utf8", flag: "wx" });
    const loaded = await loadCanonicalProductionCutoverDocument({ documentPath, repositoryRoot });
    assert.equal(loaded.status, productionCutoverStatus);
    linkSync(documentPath, hardlinkPath);
    await assert.rejects(
      loadCanonicalProductionCutoverDocument({ documentPath, repositoryRoot }),
      /DOCUMENT_NOT_BOUNDED_REGULAR_FILE/u,
    );
    await assert.rejects(
      loadCanonicalProductionCutoverDocument({
        documentPath: join(repositoryRoot, "package.json"),
        repositoryRoot,
      }),
      /DOCUMENT_MUST_BE_OUTSIDE_REPOSITORY/u,
    );
  } finally {
    rmSync(temporaryDirectory, { force: true, recursive: true });
  }
});

test("standalone verifier is read-only, network-free and accepts the exact external bundle", () => {
  const fixture = createFixture();
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "novalure-production-cutover-cli-"));
  const documentPath = join(temporaryDirectory, "production-cutover.json");
  const anchorPath = join(temporaryDirectory, "trust-anchor.json");
  const verifierPath = join(repositoryRoot, "scripts", "verify-production-cutover-receipt.mjs");
  try {
    writeFileSync(documentPath, canonicalJson(fixture.document), { encoding: "utf8", flag: "wx" });
    writeFileSync(anchorPath, canonicalJson(fixture.trustContext.anchor), { encoding: "utf8", flag: "wx" });
    const result = spawnSync(process.execPath, [
      verifierPath,
      "--candidate", candidateCommit,
      "--document", documentPath,
      "--expected-trust-anchor-sha256", fixture.trustContext.expectedSha256,
      "--rollback-deployment-host", rollback.rollbackDeploymentHost,
      "--rollback-deployment-id", rollback.rollbackDeploymentId,
      "--staged-deployment-host", target.stagedDeploymentHost,
      "--staged-deployment-id", target.stagedDeploymentId,
      "--trust-anchor", anchorPath,
    ], { cwd: join(repositoryRoot, "scripts"), encoding: "utf8", windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).status, productionCutoverStatus);
    const verifierSource = readFileSync(verifierPath, "utf8");
    assert.doesNotMatch(verifierSource, /\bfetch\s*\(|https?:\/\//u);
    assert.doesNotMatch(verifierSource, /\b(?:writeFile|appendFile|rename|unlink|rm)\s*\(/u);
  } finally {
    rmSync(temporaryDirectory, { force: true, recursive: true });
  }
});
}
