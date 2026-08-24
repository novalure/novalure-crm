#!/usr/bin/env node

import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import {
  buildDatabaseRecoveryLiveEvidence,
  buildRecoveryObservationStatement,
  buildTableContentFingerprint,
  canonicalJson,
  intentionalUnvalidatedPilotConstraints,
  sha256,
  verifyDatabaseRecoveryLiveEvidence,
} from "./lib/database-recovery-live-evidence.mjs";
import {
  recoveryBaselineMigrationPlan,
  recoveryDatabaseQueryPack,
  recoveryEvidenceTableNames,
  recoveryExpectedDatabaseName,
  recoveryExpectedMigrationRoleName,
  recoveryExpectedProductionBranchId,
  recoveryExpectedProjectId,
  recoveryQueryPackSha256,
  recoveryQueryPackVersion,
  recoveryTableQuerySpecs,
  recoveryTransformationTableNames,
} from "./lib/database-recovery-query-pack.mjs";
import {
  collectCommittedMigrationPlan,
  loadExternalRecoveryTrustAnchor,
  writeImmutableRecoveryEvidence,
} from "./database-recovery-live-evidence.mjs";
import { recoveryMigrationPlan } from "./recovery-migration-rehearsal.mjs";

const candidateCommit = "a".repeat(40);
const projectId = recoveryExpectedProjectId;
const productionBranchId = recoveryExpectedProductionBranchId;
const recoveryBranchId = "br-recovery-child-123456";
const preservedMigratedBranchId = "br-preserved-state-123456";
const endpointIds = Object.freeze({
  preserved: "ep-preserved-123456",
  production: "ep-production-123456",
  recovery: "ep-recovery-123456",
});
const endpointHosts = Object.freeze({
  preserved: sha256("preserved-host"),
  production: sha256("production-host"),
  recovery: sha256("recovery-host"),
});
const snapshotNames = Object.freeze([
  "baselineProduction",
  "baselineRecovery",
  "migratedRecovery",
  "postResetProduction",
  "postResetRecovery",
  "preservedMigrated",
]);
const snapshotObservedAt = Object.freeze({
  baselineProduction: "2026-08-23T18:00:00.000Z",
  baselineRecovery: "2026-08-23T18:00:35.000Z",
  migratedRecovery: "2026-08-23T18:08:00.000Z",
  postResetProduction: "2026-08-23T18:08:31.000Z",
  postResetRecovery: "2026-08-23T18:10:30.000Z",
  preservedMigrated: "2026-08-23T18:08:30.000Z",
});
const observerIdentity = "novalure:external-recovery-observer:test-v1";
const observerKeyId = "novalure:recovery-observer-key:test-v1";
const observerKeyPair = generateKeyPairSync("ed25519");
const observerPublicKeySha256 = sha256(
  observerKeyPair.publicKey.export({ format: "der", type: "spki" }),
);
const trustAnchor = Object.freeze({
  expectedKeyId: observerKeyId,
  expectedPublicKeySha256: observerPublicKeySha256,
  expectedSignerIdentity: observerIdentity,
  publicKey: observerKeyPair.publicKey,
});
const trustEnvironment = Object.freeze({
  NOVALURE_RECOVERY_OBSERVER_IDENTITY: observerIdentity,
  NOVALURE_RECOVERY_OBSERVER_KEY_ID: observerKeyId,
  NOVALURE_RECOVERY_OBSERVER_PUBLIC_KEY_SHA256: observerPublicKeySha256,
});

function digest(label) {
  return sha256(label);
}

function migrationPlan() {
  return recoveryMigrationPlan.map((version) => ({ checksum: digest(version), version }));
}

function tableFingerprints(phase = "baseline") {
  return Object.fromEntries(recoveryTableQuerySpecs.map((spec, index) => {
    if (spec.policy === "CREATED_EMPTY") {
      if (phase === "migrated") {
        return [spec.name, {
          contentSha256: sha256(""),
          projectionId: spec.projectionId,
          queryPackSha256: recoveryQueryPackSha256,
          rowCount: 0,
          state: "PRESENT",
        }];
      }
      return [spec.name, {
        contentSha256: null,
        projectionId: spec.projectionId,
        queryPackSha256: recoveryQueryPackSha256,
        rowCount: null,
        state: "ABSENT",
      }];
    }
    const suffix = phase === "post-reset-production" ? phase : "baseline";
    return [spec.name, {
      contentSha256: digest(`${spec.name}-${suffix}`),
      projectionId: spec.projectionId,
      queryPackSha256: recoveryQueryPackSha256,
      rowCount: index,
      state: "PRESENT",
    }];
  }));
}

function catalogEntry(kind, name) {
  return {
    definitionSha256: digest(`${kind}:${name}`),
    identity: name,
    kind,
    name,
    schema: "public",
  };
}

function baselineCatalog() {
  return [catalogEntry("table", "workspaces")];
}

function migratedCatalog() {
  return [
    ...baselineCatalog(),
    catalogEntry("index", "bot_channel_webhooks_account_event_uidx"),
    catalogEntry("constraint", "company_profiles_approval_integrity_check"),
    catalogEntry("view", "novalure_schema_migration_checksums"),
    catalogEntry("table", "public_funnel_visit_events"),
  ];
}

function grantEntry(objectType, objectName, grantee, privilege, grantable = false) {
  return { grantable, grantee, objectName, objectType, privilege };
}

function migratedGrants() {
  return [
    grantEntry("table", "public.public_funnel_visit_events", "novalure_app", "DELETE"),
    grantEntry("table", "public.public_funnel_visit_events", "novalure_app", "INSERT"),
    grantEntry("table", "public.public_funnel_visit_events", "novalure_app", "SELECT"),
    grantEntry("view", "public.novalure_schema_migration_checksums", "novalure_app", "SELECT"),
  ];
}

function locks() {
  return {
    idleInTransactionCount: 0,
    migrationAdvisoryLockCount: 0,
    schemaBlockingLockCount: 0,
    unexpectedTargetSessionCount: 0,
  };
}

function identity({ branchId, endpointHostSha256, endpointId, snapshotName }) {
  return {
    branchId,
    databaseName: recoveryExpectedDatabaseName,
    endpointHostSha256,
    endpointId,
    observedAt: snapshotObservedAt[snapshotName],
    projectId,
    queryPackSha256: recoveryQueryPackSha256,
    queryPackVersion: recoveryQueryPackVersion,
    roleName: recoveryExpectedMigrationRoleName,
    serverVersionNum: 170006,
    snapshotReceiptSha256: digest(`snapshot:${snapshotName}`),
    transactionIsolation: "repeatable read",
    transactionReadOnly: true,
  };
}

function snapshot({
  branchId,
  catalogInventory = baselineCatalog(),
  endpointHostSha256,
  endpointId,
  grantInventory = [],
  ledger = recoveryBaselineMigrationPlan,
  snapshotName,
  tables = tableFingerprints(),
}) {
  return {
    catalogInventory: structuredClone(catalogInventory),
    grantInventory: structuredClone(grantInventory),
    identity: identity({ branchId, endpointHostSha256, endpointId, snapshotName }),
    ledger: structuredClone(ledger),
    locks: locks(),
    tables: structuredClone(tables),
  };
}

function transformationReceipts({ baselineTables, migratedTables }) {
  return Object.fromEntries(recoveryTransformationTableNames.map((table) => {
    const expected = digest(`transform:${table}`);
    const spec = recoveryTableQuerySpecs.find((entry) => entry.name === table);
    return [table, {
      actualAfterSha256: expected,
      afterRowCount: migratedTables[table].rowCount,
      beforeRowCount: baselineTables[table].rowCount,
      expectedAfterSha256: expected,
      preservedAfterSha256: expected,
      preservedRowCount: migratedTables[table].rowCount,
      projectionId: `${spec.projectionId}:transform`,
      queryPackSha256: recoveryQueryPackSha256,
    }];
  }));
}

function receiptId(label) {
  return `rcpt_${digest(label)}`;
}

function operationReceipt({
  action,
  completedAt,
  endpointHostSha256,
  endpointId,
  operationId,
  parentBranchId,
  sourceTimestamp,
  startedAt,
  targetBranchId,
}) {
  return {
    action,
    completedAt,
    endpointHostSha256,
    endpointId,
    endpointType: "read_write_direct",
    operationId,
    operationStatus: "FINISHED",
    parentBranchId,
    projectId,
    rawReceiptSha256: digest(`raw:${action}`),
    receiptId: receiptId(action),
    requestId: `req_${digest(`request:${action}`).slice(0, 32)}`,
    sourceTimestamp,
    startedAt,
    targetBranchId,
  };
}

function verifiedProvenance(input, normalizedEvidence) {
  const receipts = {
    preserveCreate: operationReceipt({
      action: "CREATE_PRESERVED_BRANCH",
      completedAt: input.timings.preserveReadyAt,
      endpointHostSha256: endpointHosts.preserved,
      endpointId: endpointIds.preserved,
      operationId: "op_preserve_123456",
      parentBranchId: recoveryBranchId,
      sourceTimestamp: input.timings.migrationFinishedAt,
      startedAt: input.timings.preserveStartedAt,
      targetBranchId: preservedMigratedBranchId,
    }),
    productionBranch: {
      action: "READ_PRODUCTION_BRANCH",
      branchId: productionBranchId,
      endpointHostSha256: endpointHosts.production,
      endpointId: endpointIds.production,
      endpointType: "read_write_direct",
      observedAt: input.timings.productionSnapshotAt,
      parentBranchId: null,
      projectId,
      rawReceiptSha256: digest("raw:production"),
      receiptId: receiptId("production"),
      requestId: `req_${digest("request:production").slice(0, 32)}`,
    },
    recoveryCreate: operationReceipt({
      action: "CREATE_RECOVERY_BRANCH",
      completedAt: input.timings.branchReadyAt,
      endpointHostSha256: endpointHosts.recovery,
      endpointId: endpointIds.recovery,
      operationId: "op_create_12345678",
      parentBranchId: productionBranchId,
      sourceTimestamp: input.timings.productionSnapshotAt,
      startedAt: input.timings.branchCreateStartedAt,
      targetBranchId: recoveryBranchId,
    }),
    recoveryReset: operationReceipt({
      action: "RESET_RECOVERY_BRANCH",
      completedAt: input.timings.resetReadyAt,
      endpointHostSha256: endpointHosts.recovery,
      endpointId: endpointIds.recovery,
      operationId: "op_reset_12345678",
      parentBranchId: productionBranchId,
      sourceTimestamp: input.timings.resetSourceProductionAt,
      startedAt: input.timings.resetStartedAt,
      targetBranchId: recoveryBranchId,
    }),
  };
  const observationBundle = {
    assertions: normalizedEvidence.assertions,
    migrationTransformations: normalizedEvidence.migrationTransformations,
    schemaDiff: normalizedEvidence.schemaDiff,
    snapshots: normalizedEvidence.snapshots,
  };
  const controlPlane = {
      receiptBundleSha256: sha256(canonicalJson(receipts)),
      receipts,
      sourceTool: "NEON_CONTROL_PLANE_MCP",
      status: "VERIFIED",
  };
  const queryExecution = {
      executedAt: "2026-08-23T18:11:30.000Z",
      observationBundleSha256: sha256(canonicalJson(observationBundle)),
      queryPackSha256: recoveryQueryPackSha256,
      queryPackVersion: recoveryQueryPackVersion,
      requestId: `req_${digest("request:query-execution").slice(0, 32)}`,
      snapshotReceipts: Object.fromEntries(snapshotNames.map((name) => [
        name,
        input.snapshots[name].identity.snapshotReceiptSha256,
      ])),
      sourceTool: "NEON_SQL_READ_ONLY",
      status: "VERIFIED",
      transactionIsolation: "repeatable read",
      transactionReadOnly: true,
  };
  const statement = buildRecoveryObservationStatement({
    branches: input.branches,
    candidateCommit: input.candidateCommit,
    controlPlane,
    databaseName: input.databaseName,
    observationWindow: {
      endedAt: "2026-08-23T18:11:30.000Z",
      startedAt: "2026-08-23T18:00:00.000Z",
    },
    observer: {
      identity: observerIdentity,
      keyId: observerKeyId,
      publicKeySha256: observerPublicKeySha256,
    },
    projectId: input.projectId,
    queryExecution,
    schemaDiff: input.schemaDiff,
  });
  return {
    controlPlane,
    externalAttestation: {
      algorithm: "Ed25519",
      signatureBase64: sign(
        null,
        Buffer.from(canonicalJson(statement), "utf8"),
        observerKeyPair.privateKey,
      ).toString("base64"),
      statement,
    },
    queryExecution,
    queryPackSha256: recoveryQueryPackSha256,
    queryPackVersion: recoveryQueryPackVersion,
    status: "VERIFIED",
  };
}

function fixture({ candidate = candidateCommit } = {}) {
  const baseline = structuredClone(recoveryBaselineMigrationPlan);
  const plan = migrationPlan();
  const migratedLedger = [...baseline, ...plan];
  const baselineTables = tableFingerprints();
  const migratedTables = tableFingerprints("migrated");
  const laterProductionTables = tableFingerprints("post-reset-production");
  const migrated = snapshot({
    branchId: recoveryBranchId,
    catalogInventory: migratedCatalog(),
    endpointHostSha256: endpointHosts.recovery,
    endpointId: endpointIds.recovery,
    grantInventory: migratedGrants(),
    ledger: migratedLedger,
    snapshotName: "migratedRecovery",
    tables: migratedTables,
  });
  const input = {
    action: "FINAL_RECOVERY_READ_ONLY_EVIDENCE",
    assertions: {
      catalog: {
        companyApprovalConstraintPresent: true,
        companyApprovalConstraintValidated: true,
        intentionalUnvalidatedConstraints: [...intentionalUnvalidatedPilotConstraints],
        legacyWebhookIndexPresent: false,
        migrationChecksumProjectionPresent: true,
        pilotRlsEnabled: false,
        providerWebhookIndexPresent: true,
        publicFunnelVisitEventsPresent: true,
        unexpectedUnvalidatedConstraintCount: 0,
      },
      companyProfileApproval: {
        constraintPresent: true,
        constraintValidated: true,
        invalidApprovedCount: 0,
        staleApprovalMetadataCount: 0,
      },
    },
    branches: { preservedMigratedBranchId, productionBranchId, recoveryBranchId },
    candidateCommit: candidate,
    databaseName: recoveryExpectedDatabaseName,
    environment: "RECOVERY_BRANCH_ONLY",
    migrationTransformations: transformationReceipts({ baselineTables, migratedTables }),
    productionAliasOrEnvironmentChanged: false,
    productionMutationPerformed: false,
    projectId,
    provenance: {
      controlPlane: null,
      externalAttestation: null,
      queryExecution: null,
      queryPackSha256: recoveryQueryPackSha256,
      queryPackVersion: recoveryQueryPackVersion,
      status: "UNVERIFIED",
    },
    schemaDiff: {
      baseBranchId: productionBranchId,
      countedAsPassEvidence: true,
      diffSha256: sha256(""),
      observedAt: "2026-08-23T18:11:00.000Z",
      rawReceiptSha256: digest("schema-diff"),
      requestId: `req_${digest("request:schema-diff").slice(0, 32)}`,
      sourceTool: "NEON_SCHEMA_DIFF",
      status: "PASS_EMPTY",
      targetBranchId: recoveryBranchId,
    },
    schemaVersion: 2,
    snapshots: {
      baselineProduction: snapshot({
        branchId: productionBranchId,
        endpointHostSha256: endpointHosts.production,
        endpointId: endpointIds.production,
        ledger: baseline,
        snapshotName: "baselineProduction",
        tables: baselineTables,
      }),
      baselineRecovery: snapshot({
        branchId: recoveryBranchId,
        endpointHostSha256: endpointHosts.recovery,
        endpointId: endpointIds.recovery,
        ledger: baseline,
        snapshotName: "baselineRecovery",
        tables: baselineTables,
      }),
      migratedRecovery: migrated,
      postResetProduction: snapshot({
        branchId: productionBranchId,
        endpointHostSha256: endpointHosts.production,
        endpointId: endpointIds.production,
        ledger: baseline,
        snapshotName: "postResetProduction",
        tables: laterProductionTables,
      }),
      postResetRecovery: snapshot({
        branchId: recoveryBranchId,
        endpointHostSha256: endpointHosts.recovery,
        endpointId: endpointIds.recovery,
        ledger: baseline,
        snapshotName: "postResetRecovery",
        tables: laterProductionTables,
      }),
      preservedMigrated: snapshot({
        branchId: preservedMigratedBranchId,
        catalogInventory: migratedCatalog(),
        endpointHostSha256: endpointHosts.preserved,
        endpointId: endpointIds.preserved,
        grantInventory: migratedGrants(),
        ledger: migratedLedger,
        snapshotName: "preservedMigrated",
        tables: migratedTables,
      }),
    },
    timings: {
      branchCreateStartedAt: "2026-08-23T18:00:01.000Z",
      branchReadyAt: "2026-08-23T18:00:35.000Z",
      migrationFinishedAt: "2026-08-23T18:08:00.000Z",
      migrationStartedAt: "2026-08-23T18:01:00.000Z",
      postResetSnapshotAt: "2026-08-23T18:10:30.000Z",
      preserveReadyAt: "2026-08-23T18:08:30.000Z",
      preserveStartedAt: "2026-08-23T18:08:01.000Z",
      productionSnapshotAt: "2026-08-23T18:00:00.000Z",
      resetReadyAt: "2026-08-23T18:10:00.000Z",
      resetSourceProductionAt: "2026-08-23T18:08:31.000Z",
      resetStartedAt: "2026-08-23T18:09:10.000Z",
    },
  };
  return { input, plan };
}

function build({ candidate = candidateCommit, schemaDiffUnavailable = false, verified = true } = {}) {
  const { input, plan } = fixture({ candidate });
  if (schemaDiffUnavailable) {
    input.schemaDiff.countedAsPassEvidence = false;
    input.schemaDiff.diffSha256 = null;
    input.schemaDiff.status = "UNAVAILABLE_HTTP_413_TOOL_LIMIT";
  }
  const blocked = buildDatabaseRecoveryLiveEvidence({
    expectedCandidateCommit: candidate,
    generatedAt: "2026-08-23T18:12:00.000Z",
    input,
    migrationPlan: plan,
  });
  if (!verified) return blocked;
  input.provenance = verifiedProvenance(input, blocked);
  return buildDatabaseRecoveryLiveEvidence({
    expectedCandidateCommit: candidate,
    generatedAt: "2026-08-23T18:12:00.000Z",
    input,
    migrationPlan: plan,
    trustAnchor,
  });
}

function signedFixture({ candidate = candidateCommit } = {}) {
  const value = fixture({ candidate });
  const blocked = buildDatabaseRecoveryLiveEvidence({
    expectedCandidateCommit: candidate,
    generatedAt: "2026-08-23T18:12:00.000Z",
    input: value.input,
    migrationPlan: value.plan,
  });
  value.input.provenance = verifiedProvenance(value.input, blocked);
  return value;
}

export function buildSignedRecoveryLiveEvidenceFixture({
  expectedCandidateCommit = candidateCommit,
} = {}) {
  return Object.freeze({
    evidence: build({ candidate: expectedCandidateCommit }),
    expectedCandidateCommit,
    publicKeyPem: observerKeyPair.publicKey.export({ format: "pem", type: "spki" }),
    trustAnchor,
    trustEnvironment,
  });
}

const isDirectTestModule = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectTestModule) {

test("Unverified Neon provenance is BLOCKED and never pass-eligible", () => {
  const evidence = build({ verified: false });
  assert.equal(evidence.status, "BLOCKED");
  assert.equal(evidence.passEligible, false);
  assert.equal(evidence.verificationStatus, "UNPROVEN");
  assert.deepEqual(evidence.blockers, ["NEON_PROVENANCE_UNVERIFIED"]);
  assert.equal(
    verifyDatabaseRecoveryLiveEvidence({
      evidence,
      expectedCandidateCommit: candidateCommit,
    }).status,
    "BLOCKED",
  );
});

test("Verified receipts, exact query pack, migration delta and reset equality produce PASS", () => {
  const evidence = build();
  assert.equal(evidence.status, "PASS");
  assert.equal(evidence.passEligible, true);
  assert.equal(evidence.provenance.controlPlane.status, "VERIFIED");
  assert.equal(evidence.queryPack.sha256, recoveryQueryPackSha256);
  assert.equal(evidence.baselineMigrationPlan.length, 19);
  assert.equal(evidence.migrationPlan.length, 14);
  assert.equal(evidence.timings.observedPreserveReadySeconds, 29);
  assert.equal(
    verifyDatabaseRecoveryLiveEvidence({
      evidence,
      expectedCandidateCommit: candidateCommit,
      trustAnchor,
    }).status,
    "PASS",
  );
});

test("Self-asserted VERIFIED receipts cannot pass without the out-of-repo trust anchor", () => {
  const { input, plan } = signedFixture();
  assert.throws(
    () => buildDatabaseRecoveryLiveEvidence({
      expectedCandidateCommit: candidateCommit,
      generatedAt: "2026-08-23T18:12:00.000Z",
      input,
      migrationPlan: plan,
    }),
    /RECOVERY_EXTERNAL_TRUST_ANCHOR_REQUIRED/u,
  );
  const signedEvidence = build();
  assert.throws(
    () => verifyDatabaseRecoveryLiveEvidence({
      evidence: signedEvidence,
      expectedCandidateCommit: candidateCommit,
    }),
    /RECOVERY_EXTERNAL_TRUST_ANCHOR_REQUIRED/u,
  );
});

test("Wrong observer key, detached-signature tampering and receipt tampering fail closed", () => {
  const wrongKeyPair = generateKeyPairSync("ed25519");
  const wrongKeyDigest = sha256(wrongKeyPair.publicKey.export({ format: "der", type: "spki" }));
  const wrongTrust = {
    ...trustAnchor,
    expectedPublicKeySha256: wrongKeyDigest,
    publicKey: wrongKeyPair.publicKey,
  };
  const wrongKeyFixture = signedFixture();
  wrongKeyFixture.input.provenance.externalAttestation.statement.observer.publicKeySha256 =
    wrongKeyDigest;
  assert.throws(
    () => buildDatabaseRecoveryLiveEvidence({
      expectedCandidateCommit: candidateCommit,
      generatedAt: "2026-08-23T18:12:00.000Z",
      input: wrongKeyFixture.input,
      migrationPlan: wrongKeyFixture.plan,
      trustAnchor: wrongTrust,
    }),
    /RECOVERY_EXTERNAL_OBSERVER_(?:STATEMENT_MISMATCH|SIGNATURE_VERIFICATION_FAILED)/u,
  );

  const signatureFixture = signedFixture();
  const originalSignature = signatureFixture.input.provenance.externalAttestation.signatureBase64;
  signatureFixture.input.provenance.externalAttestation.signatureBase64 =
    `${originalSignature[0] === "A" ? "B" : "A"}${originalSignature.slice(1)}`;
  assert.throws(
    () => buildDatabaseRecoveryLiveEvidence({
      expectedCandidateCommit: candidateCommit,
      generatedAt: "2026-08-23T18:12:00.000Z",
      input: signatureFixture.input,
      migrationPlan: signatureFixture.plan,
      trustAnchor,
    }),
    /RECOVERY_EXTERNAL_OBSERVER_SIGNATURE_VERIFICATION_FAILED/u,
  );

  const receiptFixture = signedFixture();
  receiptFixture.input.provenance.controlPlane.receipts.productionBranch.rawReceiptSha256 =
    digest("attacker-controlled-raw-receipt");
  receiptFixture.input.provenance.controlPlane.receiptBundleSha256 = sha256(
    canonicalJson(receiptFixture.input.provenance.controlPlane.receipts),
  );
  assert.throws(
    () => buildDatabaseRecoveryLiveEvidence({
      expectedCandidateCommit: candidateCommit,
      generatedAt: "2026-08-23T18:12:00.000Z",
      input: receiptFixture.input,
      migrationPlan: receiptFixture.plan,
      trustAnchor,
    }),
    /RECOVERY_EXTERNAL_OBSERVER_STATEMENT_MISMATCH/u,
  );

  const identityFixture = signedFixture();
  identityFixture.input.provenance.externalAttestation.statement.observer.identity =
    "novalure:untrusted-recovery-observer:test-v1";
  assert.throws(
    () => buildDatabaseRecoveryLiveEvidence({
      expectedCandidateCommit: candidateCommit,
      generatedAt: "2026-08-23T18:12:00.000Z",
      input: identityFixture.input,
      migrationPlan: identityFixture.plan,
      trustAnchor,
    }),
    /RECOVERY_EXTERNAL_OBSERVER_IDENTITY_MISMATCH/u,
  );

  const windowFixture = signedFixture();
  windowFixture.input.provenance.externalAttestation.statement.observationWindow.startedAt =
    "2026-08-23T18:00:01.000Z";
  assert.throws(
    () => buildDatabaseRecoveryLiveEvidence({
      expectedCandidateCommit: candidateCommit,
      generatedAt: "2026-08-23T18:12:00.000Z",
      input: windowFixture.input,
      migrationPlan: windowFixture.plan,
      trustAnchor,
    }),
    /RECOVERY_EXTERNAL_OBSERVATION_WINDOW_INCOMPLETE/u,
  );

  const staleFixture = signedFixture();
  assert.throws(
    () => buildDatabaseRecoveryLiveEvidence({
      expectedCandidateCommit: candidateCommit,
      generatedAt: "2026-08-23T20:00:00.000Z",
      input: staleFixture.input,
      migrationPlan: staleFixture.plan,
      trustAnchor,
    }),
    /RECOVERY_EXTERNAL_OBSERVATION_STALE_AT_FINALIZATION/u,
  );
});

test("Trust-anchor loader rejects URLs and symlinks and accepts one bounded regular key file", async (t) => {
  await assert.rejects(
    loadExternalRecoveryTrustAnchor({
      environment: trustEnvironment,
      publicKeyPath: "https://example.invalid/recovery-observer.pem",
      repositoryRoot: process.cwd(),
    }),
    /RECOVERY_EXTERNAL_TRUST_PUBLIC_KEY_PATH_REQUIRED/u,
  );
  const root = await mkdtemp(join(tmpdir(), "novalure-recovery-trust-anchor-test-"));
  try {
    const target = join(root, "observer.pem");
    const link = join(root, "observer-link.pem");
    await writeFile(
      target,
      observerKeyPair.publicKey.export({ format: "pem", type: "spki" }),
      { flag: "wx", mode: 0o600 },
    );
    const loaded = await loadExternalRecoveryTrustAnchor({
      environment: trustEnvironment,
      publicKeyPath: target,
      repositoryRoot: process.cwd(),
    });
    assert.equal(loaded.expectedPublicKeySha256, observerPublicKeySha256);
    try {
      await symlink(target, link, "file");
    } catch (error) {
      if (error?.code === "EPERM") {
        t.diagnostic("Windows denied symlink creation; regular-file path was still verified.");
      } else {
        throw error;
      }
    }
    if (await readFile(link).then(() => true, () => false)) {
      await assert.rejects(
        loadExternalRecoveryTrustAnchor({
          environment: trustEnvironment,
          publicKeyPath: link,
          repositoryRoot: process.cwd(),
        }),
        /RECOVERY_EXTERNAL_TRUST_PUBLIC_KEY_(?:FILE_INVALID|PATH_REPARSE)/u,
      );
    }

    const realDirectory = join(root, "real-key-directory");
    const junctionDirectory = join(root, "junction-key-directory");
    await mkdir(realDirectory);
    await writeFile(
      join(realDirectory, "observer.pem"),
      observerKeyPair.publicKey.export({ format: "pem", type: "spki" }),
      { flag: "wx", mode: 0o600 },
    );
    await symlink(
      realDirectory,
      junctionDirectory,
      process.platform === "win32" ? "junction" : "dir",
    );
    await assert.rejects(
      loadExternalRecoveryTrustAnchor({
        environment: trustEnvironment,
        publicKeyPath: join(junctionDirectory, "observer.pem"),
        repositoryRoot: process.cwd(),
      }),
      /RECOVERY_EXTERNAL_TRUST_PUBLIC_KEY_PATH_REPARSE/u,
    );
  } finally {
    const resolvedRoot = root.toLowerCase();
    assert.ok(resolvedRoot.startsWith(tmpdir().toLowerCase()));
    await rm(root, { force: true, recursive: true });
  }
});

test("Schema diff HTTP 413 remains BLOCKED even with verified Neon receipts", () => {
  const evidence = build({ schemaDiffUnavailable: true });
  assert.equal(evidence.status, "BLOCKED");
  assert.equal(evidence.passEligible, false);
  assert.deepEqual(evidence.blockers, ["SCHEMA_DIFF_UNAVAILABLE"]);
});

test("Schema diff receipt must be observed after the final reset snapshot", () => {
  const { input, plan } = fixture();
  input.schemaDiff.observedAt = "2026-08-23T18:10:29.999Z";
  assert.throws(
    () => buildDatabaseRecoveryLiveEvidence({
      expectedCandidateCommit: candidateCommit,
      input,
      migrationPlan: plan,
    }),
    /RECOVERY_SCHEMA_DIFF_BEFORE_POST_RESET_SNAPSHOT/u,
  );
});

test("Expected live Production sessions are recorded while recovery-target sessions fail closed", () => {
  const liveFixture = fixture();
  liveFixture.input.snapshots.baselineProduction.locks.unexpectedTargetSessionCount = 8;
  liveFixture.input.snapshots.postResetProduction.locks.unexpectedTargetSessionCount = 11;
  assert.equal(
    buildDatabaseRecoveryLiveEvidence({
      expectedCandidateCommit: candidateCommit,
      input: liveFixture.input,
      migrationPlan: liveFixture.plan,
    }).status,
    "BLOCKED",
  );

  const targetFixture = fixture();
  targetFixture.input.snapshots.baselineRecovery.locks.unexpectedTargetSessionCount = 1;
  assert.throws(
    () => buildDatabaseRecoveryLiveEvidence({
      expectedCandidateCommit: candidateCommit,
      input: targetFixture.input,
      migrationPlan: targetFixture.plan,
    }),
    /RECOVERY_BASELINERECOVERY_LOCKS_unexpectedTargetSessionCount_NOT_ZERO/u,
  );
});

test("Receipt lineage, endpoint drift and observation tampering fail closed", () => {
  const { input, plan } = fixture();
  const blocked = buildDatabaseRecoveryLiveEvidence({
    expectedCandidateCommit: candidateCommit,
    generatedAt: "2026-08-23T18:12:00.000Z",
    input,
    migrationPlan: plan,
  });
  input.provenance = verifiedProvenance(input, blocked);
  input.provenance.controlPlane.receipts.recoveryCreate.parentBranchId = preservedMigratedBranchId;
  input.provenance.controlPlane.receiptBundleSha256 = sha256(
    canonicalJson(input.provenance.controlPlane.receipts),
  );
  assert.throws(
    () => buildDatabaseRecoveryLiveEvidence({ expectedCandidateCommit: candidateCommit, input, migrationPlan: plan }),
    /RECOVERY_CONTROL_PLANE_CREATE_PARENT_MISMATCH/u,
  );

  const tampered = structuredClone(build());
  tampered.provenance.queryExecution.observationBundleSha256 = "f".repeat(64);
  assert.throws(
    () => verifyDatabaseRecoveryLiveEvidence({ evidence: tampered, expectedCandidateCommit: candidateCommit }),
    /RECOVERY_QUERY_EXECUTION_OBSERVATION_BUNDLE_INVALID/u,
  );

  const timestampFixture = fixture();
  timestampFixture.input.snapshots.postResetProduction.identity.observedAt =
    timestampFixture.input.timings.postResetSnapshotAt;
  assert.throws(
    () => buildDatabaseRecoveryLiveEvidence({
      expectedCandidateCommit: candidateCommit,
      input: timestampFixture.input,
      migrationPlan: timestampFixture.plan,
    }),
    /RECOVERY_POSTRESETPRODUCTION_OBSERVED_AT_MISMATCH/u,
  );
});

test("Exact baseline ledger rejects same-count replacement versions and checksums", () => {
  const { input, plan } = fixture();
  for (const name of ["baselineProduction", "baselineRecovery", "postResetProduction", "postResetRecovery"]) {
    input.snapshots[name].ledger[0] = {
      checksum: digest("replacement"),
      version: "040_replacement",
    };
  }
  assert.throws(
    () => buildDatabaseRecoveryLiveEvidence({ expectedCandidateCommit: candidateCommit, input, migrationPlan: plan }),
    /RECOVERY_BASELINE_LEDGER_EXACT_MISMATCH/u,
  );
});

test("Every migration-touched table is query-pack bound and transforms prevent row loss", () => {
  assert.ok(recoveryEvidenceTableNames.includes("bot_channel_webhooks"));
  assert.ok(recoveryEvidenceTableNames.includes("company_profiles"));
  assert.ok(recoveryEvidenceTableNames.includes("qa_batches"));
  assert.ok(recoveryTableQuerySpecs.every((spec) => spec.sql.startsWith("select ")));
  assert.match(recoveryDatabaseQueryPack.identitySql, /transaction_read_only/u);
  assert.match(recoveryDatabaseQueryPack.transformationQueries.bot_channel_webhooks.expectedSql, /digest\(external_message_id/u);
  assert.match(recoveryDatabaseQueryPack.transformationQueries.company_profiles.expectedSql, /needs_review/u);

  const { input, plan } = fixture();
  input.migrationTransformations.bot_channel_webhooks.afterRowCount += 1;
  assert.throws(
    () => buildDatabaseRecoveryLiveEvidence({ expectedCandidateCommit: candidateCommit, input, migrationPlan: plan }),
    /RECOVERY_TRANSFORMATION_bot_channel_webhooks_MIGRATED_COUNT_MISMATCH/u,
  );
});

test("Every query-pack statement is fixed read-only SQL and the collector has no network client", async () => {
  const statements = [
    ...Object.values(recoveryDatabaseQueryPack.assertionQueries),
    recoveryDatabaseQueryPack.catalogSql,
    recoveryDatabaseQueryPack.grantSql,
    recoveryDatabaseQueryPack.identitySql,
    recoveryDatabaseQueryPack.ledgerSql,
    recoveryDatabaseQueryPack.locksSql,
    ...recoveryDatabaseQueryPack.tableQueries.flatMap((spec) => [spec.presenceSql, spec.sql]),
    ...Object.values(recoveryDatabaseQueryPack.transformationQueries)
      .flatMap(({ actualSql, expectedSql }) => [actualSql, expectedSql]),
  ];
  assert.ok(statements.length > recoveryEvidenceTableNames.length * 2);
  for (const statement of statements) {
    assert.match(statement.trim(), /^(?:select|with)\b/iu);
    assert.doesNotMatch(
      statement,
      /\b(?:alter|call|create|delete|do|drop|grant|insert|revoke|truncate|update)\b/iu,
    );
  }
  const collectorSources = await Promise.all([
    readFile("scripts/database-recovery-live-evidence.mjs", "utf8"),
    readFile("scripts/lib/database-recovery-live-evidence.mjs", "utf8"),
  ]);
  for (const source of collectorSources) {
    assert.doesNotMatch(source, /\bfetch\s*\(/u);
    assert.doesNotMatch(source, /@neondatabase|postgres(?:ql)?:\/\//iu);
    assert.doesNotMatch(source, /\b(?:curl|Invoke-WebRequest|wget)\b/iu);
  }
});

test("Query pack baseline checksums match the committed migration bytes", async () => {
  for (const migration of recoveryBaselineMigrationPlan) {
    const source = (await readFile(`migrations/${migration.version}.sql`, "utf8")).replace(/\r\n/gu, "\n");
    assert.equal(sha256(source), migration.checksum, migration.version);
  }
  assert.match(recoveryQueryPackSha256, /^[a-f0-9]{64}$/u);
});

test("Table content fingerprint is deterministic and row-order independent", () => {
  const left = buildTableContentFingerprint([{ id: 2, value: "b" }, { id: 1, value: "a" }]);
  const right = buildTableContentFingerprint([{ value: "a", id: 1 }, { value: "b", id: 2 }]);
  assert.deepEqual(left, right);
  assert.equal(left.rowCount, 2);
});

test("Committed target migration collector binds exact tracked SQL bytes", async () => {
  const plan = await collectCommittedMigrationPlan();
  assert.deepEqual(plan.map((migration) => migration.version), recoveryMigrationPlan);
  assert.equal(
    plan.find((migration) => migration.version === "079_public_funnel_visit_role_boundary")?.checksum,
    "f6503eeeee9e83f838519fb30dfc4d663d479e85e24b5d116cde5d64cc499432",
  );
});

test("Candidate relabelling, transform drift and token-shaped input fail closed", () => {
  const candidateFixture = fixture();
  candidateFixture.input.candidateCommit = "b".repeat(40);
  assert.throws(
    () => buildDatabaseRecoveryLiveEvidence({
      expectedCandidateCommit: candidateCommit,
      input: candidateFixture.input,
      migrationPlan: candidateFixture.plan,
    }),
    /RECOVERY_INPUT_CANDIDATE_MISMATCH/u,
  );

  const transformFixture = fixture();
  transformFixture.input.migrationTransformations.company_profiles.actualAfterSha256 = digest("wrong");
  assert.throws(
    () => buildDatabaseRecoveryLiveEvidence({
      expectedCandidateCommit: candidateCommit,
      input: transformFixture.input,
      migrationPlan: transformFixture.plan,
    }),
    /RECOVERY_TRANSFORMATION_company_profiles_RESULT_MISMATCH/u,
  );

  const secretFixture = fixture();
  secretFixture.input.snapshots.baselineProduction.catalogInventory[0].identity =
    ["sk", "live", "abcdefghijklmnopqrstuvwxyz"].join("_");
  assert.throws(
    () => buildDatabaseRecoveryLiveEvidence({
      expectedCandidateCommit: candidateCommit,
      input: secretFixture.input,
      migrationPlan: secretFixture.plan,
    }),
    /RECOVERY_EVIDENCE_SECRET_PATTERN_DETECTED/u,
  );

  for (const token of [
    ["re", "1234567890abcdefghijklmnop"].join("_"),
    ["napi", "1234567890abcdefghijklmnop"].join("_"), // gitleaks:allow -- synthetic secret-pattern rejection fixture
    ["pat-na1", "1234567890abcdefghijklmnop"].join("-"),
    ["ya29", "1234567890abcdefghijklmnop"].join("."),
    ["AI", "za", "1234567890abcdefghijklmnopqrstuv"].join(""),
    ["S", "K", "0123456789abcdef0123456789abcdef"].join(""),
  ]) {
    const tokenFixture = fixture();
    tokenFixture.input.snapshots.baselineProduction.catalogInventory[0].identity = token;
    assert.throws(
      () => buildDatabaseRecoveryLiveEvidence({
        expectedCandidateCommit: candidateCommit,
        input: tokenFixture.input,
        migrationPlan: tokenFixture.plan,
      }),
      /RECOVERY_EVIDENCE_SECRET_PATTERN_DETECTED/u,
      token,
    );
  }
});

test("Immutable writer creates canonical evidence and one matching SHA sidecar", async () => {
  const root = await mkdtemp(join(tmpdir(), "novalure-recovery-live-evidence-test-"));
  try {
    const evidence = build({ verified: false });
    const written = await writeImmutableRecoveryEvidence({ directory: root, evidence });
    const [source, sidecar] = await Promise.all([
      readFile(join(root, written.fileName), "utf8"),
      readFile(join(root, `${written.fileName}.sha256`), "utf8"),
    ]);
    assert.equal(source, canonicalJson(evidence));
    assert.equal(written.digest, sha256(source));
    assert.equal(sidecar, `${written.digest}  ${written.fileName}\n`);
    await assert.rejects(
      writeImmutableRecoveryEvidence({ directory: root, evidence }),
      /EEXIST/u,
    );
  } finally {
    const resolvedRoot = root.toLowerCase();
    assert.ok(resolvedRoot.startsWith(tmpdir().toLowerCase()));
    await rm(root, { force: true, recursive: true });
  }
});
}
