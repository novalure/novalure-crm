#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { linkSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  applyMigration,
  applyCommittedMigrationPlan,
  assertMigrationCommitted,
  createMigrationPlanToken,
  createMigrationPlan,
  readMigrationDatabaseUrlFromStdin,
  resolveMigrationLedgerState,
  validateProductionMigrationSequence,
  validateMigrationTargetPolicy,
  validateMigrationPlan,
} from "./db-migrate.mjs";
import {
  buildExternalGateReceiptSigningPayload,
  canonicalJson,
  externalGateTrustAnchorRecordType,
  sha256,
} from "./lib/external-gate-receipts.mjs";
import {
  assertProductionMigrationPromotionPinnedTrustAnchor,
  buildProductionMigrationPromotionEvidenceSha256,
  buildProductionMigrationPromotionReceiptPayload,
  loadCanonicalProductionMigrationPromotionEvidence,
  productionMigrationPromotionEvidenceRecordType,
  productionMigrationPromotionMigrations,
  productionMigrationPromotionPinnedTrustAnchor,
  productionMigrationPromotionPlanContract,
  productionMigrationPromotionPreviewTarget,
  productionMigrationPromotionProductionTarget,
  productionMigrationPromotionReceiptRecordType,
  productionMigrationPromotionRoles,
  productionMigrationPromotionSchemaVersion,
  productionMigrationPromotionStatus,
  verifyProductionMigrationPromotionEvidence,
} from "./lib/production-migration-promotion-evidence.mjs";
import {
  recoveryMigrationPlan,
  recoveryMigrationPlanContract,
} from "./lib/recovery-migration-plan.mjs";
import {
  tenantCutoverMigrationVersion,
  tenantCutoverRoleProvisioningSql,
} from "./lib/tenant-cutover-role-provisioning.mjs";

const runner = await readFile(new URL("./db-migrate.mjs", import.meta.url), "utf8");
const workflow = await readFile(
  new URL("../.github/workflows/livegang-e2e.yml", import.meta.url),
  "utf8",
);
const protectedPreviewRunner = await readFile(
  new URL("./qa-protected-preview-action-runner.mjs", import.meta.url),
  "utf8",
);
const [
  webhookExpand,
  webhookCutover,
  mediaExpand,
  mediaContract,
  providerExpand,
  providerCutover,
  unitIdempotencyExpand,
  funnelSubmissionRecovery,
  formsOwnerGuard,
  formSubmissionAtomicity,
] = await Promise.all([
  readFile(new URL("../migrations/048_bot_webhook_integrity.sql", import.meta.url), "utf8"),
  readFile(new URL("../migrations/057_bot_webhook_legacy_index_cutover.sql", import.meta.url), "utf8"),
  readFile(new URL("../migrations/051_private_media_access.sql", import.meta.url), "utf8"),
  readFile(new URL("../migrations/062_private_media_contract_cutover.sql", import.meta.url), "utf8"),
  readFile(
    new URL("../migrations/064_notification_provider_and_lead_assignee_integrity.sql", import.meta.url),
    "utf8",
  ),
  readFile(
    new URL("../migrations/065_notification_guard_search_path_hardening.sql", import.meta.url),
    "utf8",
  ),
  readFile(
    new URL("../migrations/069_property_unit_idempotency.sql", import.meta.url),
    "utf8",
  ),
  readFile(
    new URL("../migrations/070_funnel_submission_idempotency_recovery.sql", import.meta.url),
    "utf8",
  ),
  readFile(
    new URL("../migrations/071_forms_owner_tenant_guard.sql", import.meta.url),
    "utf8",
  ),
  readFile(
    new URL("../migrations/072_form_submission_atomicity.sql", import.meta.url),
    "utf8",
  ),
]);

function migration(version, checksum, overrides = {}) {
  return {
    checksum,
    file: `${version}.sql`,
    manualCutover: false,
    number: Number(version.slice(0, 3)),
    rollback: false,
    version,
    ...overrides,
  };
}

function ledgerRow(version, checksum, appliedAt = null) {
  return {
    ...(appliedAt === null ? {} : { appliedAt }),
    checksum,
    number: Number(version.slice(0, 3)),
    version,
  };
}

function orderedProductionLedgerRows(versions) {
  return versions.map((version, index) => ledgerRow(
    version,
    `sha-${version}`,
    `2026-09-02T12:00:${String(index).padStart(2, "0")}.000000Z`,
  ));
}

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

function promotionMigrationInventory(candidateCommit) {
  return productionMigrationPromotionMigrations.map(({ path, version }) => {
    const source = execFileSync("git", ["show", `${candidateCommit}:${path}`], {
      cwd: repositoryRoot,
      encoding: "utf8",
    });
    return {
      checksum: sha256(source.replace(/\r\n/gu, "\n")),
      path,
      version,
    };
  });
}

function promotionSigner(role, index) {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privateKey,
    trustKey: {
      algorithm: "Ed25519",
      keyId: `key_production_promotion_${index}_20260902`,
      publicKeyPem: publicKey.export({ format: "pem", type: "spki" }).toString(),
      role,
      signerSubject: `subject:novalure-production-promotion-${index}`,
      status: "ACTIVE",
    },
  };
}

function signPromotionReceipt({
  anchor,
  index,
  payload,
  signedAt,
  signer,
  trustAnchorSha256,
}) {
  const payloadSha256 = sha256(canonicalJson(payload));
  const receipt = {
    detachedSignature: "",
    keyId: signer.trustKey.keyId,
    payload,
    payloadSha256,
    receiptId: `grc_${String(index).repeat(32)}`,
    recordType: productionMigrationPromotionReceiptRecordType,
    role: signer.trustKey.role,
    schemaVersion: 1,
    signatureAlgorithm: "Ed25519",
    signatureReference: [
      "urn:novalure:gate-receipt:v1",
      anchor.trustAnchorId,
      signer.trustKey.keyId,
      signer.trustKey.role,
      productionMigrationPromotionReceiptRecordType,
      payloadSha256,
    ].join(":"),
    signedAt,
    signerSubject: signer.trustKey.signerSubject,
    trustAnchorId: anchor.trustAnchorId,
    trustAnchorSha256,
  };
  receipt.detachedSignature = sign(
    null,
    Buffer.from(buildExternalGateReceiptSigningPayload(receipt), "utf8"),
    signer.privateKey,
  ).toString("base64");
  return receipt;
}

function createPromotionEvidenceFixture({
  previewEvidenceSeed = "preview",
  signers: suppliedSigners = null,
} = {}) {
  const candidateCommit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  }).trim();
  const nowEpochMs = Math.floor(Date.now() / 1_000) * 1_000;
  const generatedAt = new Date(nowEpochMs - 60_000).toISOString();
  const signedAt = new Date(nowEpochMs - 59_000).toISOString();
  const migrationInventory = promotionMigrationInventory(candidateCommit);
  const migrationInventorySha256 = sha256(canonicalJson(migrationInventory));
  const signers = suppliedSigners ?? Object.values(productionMigrationPromotionRoles)
    .map((role, index) => promotionSigner(role, index + 1));
  const anchor = {
    keys: signers.map(({ trustKey }) => trustKey),
    recordType: externalGateTrustAnchorRecordType,
    schemaVersion: 1,
    trustAnchorId: "ta_production_promotion_20260902",
  };
  const trustAnchorSha256 = sha256(canonicalJson(anchor));
  const document = {
    candidateCommit,
    generatedAt,
    migrationInventory,
    migrationPlanContract: productionMigrationPromotionPlanContract,
    preview: {
      ...productionMigrationPromotionPreviewTarget,
      deploymentHost: "novalure-promotion-evidence.vercel.app",
      deploymentId: "dpl_promotionevidenceabcdefghij",
      evidenceSha256: sha256(previewEvidenceSeed),
      migrationInventorySha256,
      productionMutationPerformed: false,
      status: "VERIFIED_PASS",
    },
    productionTarget: { ...productionMigrationPromotionProductionTarget },
    receipts: {},
    recordType: productionMigrationPromotionEvidenceRecordType,
    recovery: {
      databaseName: "neondb",
      evidenceSha256: sha256("recovery"),
      migrationInventorySha256,
      neonBranchId: "br-production-promotion-recovery",
      neonProjectId: productionMigrationPromotionProductionTarget.neonProjectId,
      productionMutationPerformed: false,
      status: "VERIFIED_PASS",
    },
    schemaVersion: productionMigrationPromotionSchemaVersion,
    status: productionMigrationPromotionStatus,
  };
  const evidenceSha256 = buildProductionMigrationPromotionEvidenceSha256(document);
  const payload = buildProductionMigrationPromotionReceiptPayload(
    document,
    evidenceSha256,
    migrationInventorySha256,
  );
  document.receipts = Object.fromEntries(
    Object.keys(productionMigrationPromotionRoles).map((name, index) => [
      name,
      signPromotionReceipt({
        anchor,
        index: index + 1,
        payload,
        signedAt,
        signer: signers[index],
        trustAnchorSha256,
      }),
    ]),
  );
  const trustContext = { anchor, expectedSha256: trustAnchorSha256 };
  const expectedMigration = migrationInventory[0];
  const verification = verifyProductionMigrationPromotionEvidence({
    document,
    expectedCandidateCommit: candidateCommit,
    expectedMigration,
    expectedProductionTarget: productionMigrationPromotionProductionTarget,
    nowEpochMs,
    repositoryRoot,
    trustContext,
  });
  return {
    candidateCommit,
    document,
    expectedMigration,
    nowEpochMs,
    signers,
    trustContext,
    verification,
  };
}

function selectedPromotionMigration(expectedMigration) {
  return migration(expectedMigration.version, expectedMigration.checksum, {
    file: expectedMigration.path.slice("migrations/".length),
    manualCutover: true,
    path: expectedMigration.path,
  });
}

function verifyPromotionDocument(fixture, document) {
  return verifyProductionMigrationPromotionEvidence({
    document,
    expectedCandidateCommit: fixture.candidateCommit,
    expectedMigration: fixture.expectedMigration,
    expectedProductionTarget: productionMigrationPromotionProductionTarget,
    nowEpochMs: fixture.nowEpochMs,
    repositoryRoot,
    trustContext: fixture.trustContext,
  });
}

test("Production migration promotion requires a process-branded cryptographic verification", () => {
  const fixture = createPromotionEvidenceFixture();
  const promotedMigration = selectedPromotionMigration(fixture.expectedMigration);

  assert.doesNotThrow(() => validateMigrationTargetPolicy({
    migrations: [promotedMigration],
    only: promotedMigration.version,
    productionPromotionVerification: fixture.verification,
    targetName: "prod",
  }));
  assert.throws(
    () => validateMigrationTargetPolicy({
      migrations: [promotedMigration],
      only: promotedMigration.version,
      targetName: "prod",
    }),
    /without cryptographically verified Preview\/Recovery evidence/,
  );
  assert.throws(
    () => validateMigrationTargetPolicy({
      migrations: [promotedMigration],
      only: promotedMigration.version,
      productionPromotionVerification: { ...fixture.verification },
      targetName: "prod",
    }),
    /PRODUCTION_PROMOTION_CRYPTOGRAPHIC_VERIFICATION_REQUIRED/,
  );
  assert.doesNotThrow(() => validateMigrationTargetPolicy({
    migrations: [promotedMigration],
    only: promotedMigration.version,
    targetName: "test",
  }));
  assert.doesNotThrow(() => validateMigrationTargetPolicy({
    migrations: [promotedMigration],
    only: promotedMigration.version,
    targetName: "recovery",
  }));
  assert.throws(
    () => validateMigrationTargetPolicy({
      migrations: [promotedMigration],
      only: promotedMigration.version,
      productionPromotionVerification: fixture.verification,
      targetName: "test",
    }),
    /valid only for MIGRATION_TARGET=prod/,
  );
  assert.match(runner, /--allow-production-promotion is not an authorization/);

  for (const inventoryItem of fixture.document.migrationInventory) {
    const protectedMigration = selectedPromotionMigration(inventoryItem);
    assert.throws(
      () => validateMigrationTargetPolicy({
        migrations: [protectedMigration],
        only: protectedMigration.version,
        targetName: "prod",
      }),
      /without cryptographically verified Preview\/Recovery evidence/,
    );
    assert.doesNotThrow(() => validateMigrationTargetPolicy({
      migrations: [protectedMigration],
      only: protectedMigration.version,
      productionPromotionVerification: fixture.verification,
      targetName: "prod",
    }));
  }
});

test("Production promotion binds the complete recovery plan and stays blocked on the code pin", () => {
  assert.deepEqual(
    productionMigrationPromotionMigrations.map(({ version }) => version),
    recoveryMigrationPlan,
  );
  assert.equal(productionMigrationPromotionMigrations.length, 22);
  assert.equal(productionMigrationPromotionPlanContract, recoveryMigrationPlanContract);
  assert.equal(
    productionMigrationPromotionMigrations.at(-1)?.version,
    "061_validate_and_activate_tenant_rls_pilot",
  );
  assert.deepEqual(productionMigrationPromotionPinnedTrustAnchor, {
    sha256: null,
    status: "PENDING_SECURITY_OWNER_KEY",
  });
  assert.throws(
    () => assertProductionMigrationPromotionPinnedTrustAnchor("a".repeat(64)),
    /PRODUCTION_PROMOTION_PINNED_TRUST_ANCHOR_PENDING/,
  );
  const trustLoader = runner.indexOf("const trustContext = await loadExternalGateTrustContext({");
  const pinnedGuard = runner.lastIndexOf(
    "assertProductionMigrationPromotionPinnedTrustAnchor(",
    trustLoader,
  );
  assert.ok(pinnedGuard >= 0 && pinnedGuard < trustLoader);
});

test("Production migration sequence is an exact prefix and 061 requires all 21 predecessors", () => {
  const allPredecessors = recoveryMigrationPlan.slice(0, -1);
  assert.doesNotThrow(() => validateProductionMigrationSequence({
    appliedVersions: new Set(allPredecessors),
    ledgerRows: orderedProductionLedgerRows(allPredecessors),
    selectedVersion: "061_validate_and_activate_tenant_rls_pilot",
  }));
  assert.throws(
    () => validateProductionMigrationSequence({
      appliedVersions: new Set(recoveryMigrationPlan.slice(0, 2)),
      ledgerRows: orderedProductionLedgerRows(recoveryMigrationPlan.slice(0, 2)),
      selectedVersion: "061_validate_and_activate_tenant_rls_pilot",
    }),
    /predecessor sequence is incomplete/,
  );
  assert.throws(
    () => validateProductionMigrationSequence({
      appliedVersions: new Set(["060_tenant_rls_pilot_prepare"]),
    }),
    /060_tenant_rls_pilot_prepare is checksummed after missing predecessor 057_bot_webhook_legacy_index_cutover/,
  );

  const completeLedger = orderedProductionLedgerRows(recoveryMigrationPlan);
  assert.doesNotThrow(() => validateProductionMigrationSequence({
    appliedVersions: new Set(recoveryMigrationPlan),
    ledgerRows: completeLedger,
  }));

  const outOfOrderLedger = structuredClone(completeLedger);
  const penultimateAppliedAt = outOfOrderLedger.at(-2).appliedAt;
  outOfOrderLedger.at(-2).appliedAt = outOfOrderLedger.at(-1).appliedAt;
  outOfOrderLedger.at(-1).appliedAt = penultimateAppliedAt;
  assert.throws(
    () => validateProductionMigrationSequence({
      appliedVersions: new Set(recoveryMigrationPlan),
      ledgerRows: outOfOrderLedger,
    }),
    /061_validate_and_activate_tenant_rls_pilot applied_at must be strictly later than 084_media_deletion_lifecycle/,
  );

  const tiedLedger = structuredClone(completeLedger);
  tiedLedger.at(-1).appliedAt = tiedLedger.at(-2).appliedAt;
  assert.throws(
    () => validateProductionMigrationSequence({
      appliedVersions: new Set(recoveryMigrationPlan),
      ledgerRows: tiedLedger,
    }),
    /061_validate_and_activate_tenant_rls_pilot applied_at must be strictly later than 084_media_deletion_lifecycle/,
  );

  assert.match(
    runner,
    /to_char\(\s*applied_at at time zone 'UTC',\s*'YYYY-MM-DD"T"HH24:MI:SS\.US"Z"'\s*\) as "appliedAt"/,
  );

  const productionMigrations = recoveryMigrationPlan.map((version) => migration(
    version,
    `sha-${version}`,
  ));
  assert.deepEqual(createMigrationPlan({
    ledgerRows: [],
    migrations: productionMigrations,
    only: "",
    targetName: "prod",
  }), []);

  const prefixVersions = recoveryMigrationPlan.slice(0, 2);
  const dependencyMigration = migration(
    "048_bot_webhook_integrity",
    "sha-048_bot_webhook_integrity",
  );
  const prefixMigrations = [
    dependencyMigration,
    ...prefixVersions.map((version) => migration(version, `sha-${version}`)),
  ];
  const prefixLedger = [
    ledgerRow(
      dependencyMigration.version,
      dependencyMigration.checksum,
      "2026-09-02T11:59:59.999999Z",
    ),
    ...orderedProductionLedgerRows(prefixVersions),
  ];
  assert.deepEqual(createMigrationPlan({
    ledgerRows: prefixLedger,
    migrations: prefixMigrations,
    only: "",
    targetName: "prod",
  }), []);
  const tiedPrefixLedger = structuredClone(prefixLedger);
  tiedPrefixLedger.at(-1).appliedAt = tiedPrefixLedger.at(-2).appliedAt;
  assert.throws(
    () => createMigrationPlan({
      ledgerRows: tiedPrefixLedger,
      migrations: prefixMigrations,
      only: "",
      targetName: "prod",
    }),
    /060_tenant_rls_pilot_prepare applied_at must be strictly later than 057_bot_webhook_legacy_index_cutover/,
  );
});

test("Production 061 binds its role transition to the candidate in the migration transaction", async () => {
  const candidateCommit = "a".repeat(40);
  const queries = [];
  const client = {
    async query(query, values) {
      queries.push({
        text: typeof query === "string" ? query : query.text,
        values: values ?? null,
      });
      return { rows: [] };
    },
  };
  const cutover = {
    checksum: "b".repeat(64),
    content: "select 'migration-061-body'",
    name: "validate_and_activate_tenant_rls_pilot",
    path: `migrations/${tenantCutoverMigrationVersion}.sql`,
    version: tenantCutoverMigrationVersion,
  };

  await applyMigration(client, cutover, { headCommit: candidateCommit, targetName: "prod" });

  assert.equal(queries[0].text, "begin");
  assert.equal(queries[1].text, "set local search_path = public");
  assert.match(queries[2].text, new RegExp(`comment on role novalure_tenant_app is 'novalure-tenant-cutover:${candidateCommit}'`, "u"));
  assert.match(queries[2].text, /membership\.inherit_option/u);
  assert.match(queries[2].text, /not membership\.set_option/u);
  assert.match(queries[2].text, /not membership\.admin_option/u);
  assert.match(
    queries[2].text,
    /membership\.roleid = app_role_oid[\s\S]*membership\.member = tenant_role_oid/u,
  );
  assert.match(
    queries[2].text,
    /membership\.member = app_role_oid[\s\S]*membership\.roleid <> tenant_role_oid/u,
  );
  assert.match(
    queries[2].text,
    /pg_database database_row[\s\S]*database_row\.datdba in \(app_role_oid, tenant_role_oid\)/u,
  );
  assert.doesNotMatch(queries[2].text, /pg_has_role/u);
  assert.equal(queries[3].text, cutover.content);
  assert.match(queries[4].text, /insert into public\.novalure_schema_migrations/u);
  assert.deepEqual(queries[4].values, [cutover.version, cutover.name, cutover.checksum]);
  assert.equal(queries[5].text, "commit");
  assert.equal(queries.some(({ text }) => text === "rollback"), false);
  const advisoryLock = runner.indexOf("select pg_try_advisory_lock($1)");
  const productionApply = runner.indexOf("apply: (migration) => applyMigration(client, migration, {");
  assert.ok(advisoryLock >= 0 && advisoryLock < productionApply);
  assert.match(
    runner.slice(productionApply, productionApply + 240),
    /headCommit,[\s\S]*targetName: target\.name/u,
  );
  assert.throws(
    () => tenantCutoverRoleProvisioningSql("not-a-commit"),
    /exact candidate commit/u,
  );
});

test("Production 061 rolls role provisioning back when migration SQL fails", async () => {
  const candidateCommit = "c".repeat(40);
  const queries = [];
  const client = {
    async query(query) {
      const text = typeof query === "string" ? query : query.text;
      queries.push(text);
      if (text === "select 'migration-061-failure'") throw new Error("expected migration failure");
      return { rows: [] };
    },
  };
  const cutover = {
    checksum: "d".repeat(64),
    content: "select 'migration-061-failure'",
    name: "validate_and_activate_tenant_rls_pilot",
    path: `migrations/${tenantCutoverMigrationVersion}.sql`,
    version: tenantCutoverMigrationVersion,
  };

  await assert.rejects(
    applyMigration(client, cutover, { headCommit: candidateCommit, targetName: "prod" }),
    /expected migration failure/u,
  );
  assert.match(queries[2], new RegExp(`novalure-tenant-cutover:${candidateCommit}`, "u"));
  assert.equal(queries.at(-1), "rollback");
  assert.equal(queries.includes("commit"), false);
});

test("Production promotion evidence fails closed on candidate, checksum, target, payload, or signature tampering", () => {
  const fixture = createPromotionEvidenceFixture();
  const cases = [
    {
      code: /PRODUCTION_PROMOTION_PLAN_CONTRACT_INVALID/,
      mutate(document) { document.migrationPlanContract = "WRONG_PLAN"; },
    },
    {
      code: /PRODUCTION_PROMOTION_CANDIDATE_MISMATCH/,
      mutate(document) { document.candidateCommit = "f".repeat(40); },
    },
    {
      code: /PRODUCTION_PROMOTION_MIGRATION_INVENTORY_MISMATCH/,
      mutate(document) { document.migrationInventory[0].checksum = "f".repeat(64); },
    },
    {
      code: /PRODUCTION_PROMOTION_PREVIEW_NEONPROJECTID_MISMATCH/,
      mutate(document) { document.preview.neonProjectId = "wrong-preview-project"; },
    },
    {
      code: /PRODUCTION_PROMOTION_RECOVERY_BRANCH_INVALID/,
      mutate(document) {
        document.recovery.neonBranchId = productionMigrationPromotionProductionTarget.neonBranchId;
      },
    },
    {
      code: /PRODUCTION_PROMOTION_RECEIPT_PAYLOAD_MISMATCH/,
      mutate(document) { document.preview.evidenceSha256 = sha256("swapped-preview-evidence"); },
    },
    {
      code: /EXTERNAL_GATE_RECEIPT_SIGNATURE_VERIFICATION_FAILED/,
      mutate(document) {
        const signature = document.receipts.preview.detachedSignature;
        document.receipts.preview.detachedSignature = `${signature[0] === "A" ? "B" : "A"}${signature.slice(1)}`;
      },
    },
  ];

  for (const { code, mutate } of cases) {
    const document = structuredClone(fixture.document);
    mutate(document);
    assert.throws(() => verifyPromotionDocument(fixture, document), code);
  }
});

test("Production promotion digest is part of the migration plan token", () => {
  const first = createPromotionEvidenceFixture({ previewEvidenceSeed: "preview-one" });
  const second = createPromotionEvidenceFixture({
    previewEvidenceSeed: "preview-two",
    signers: first.signers,
  });
  const connectedTarget = {
    branchId: productionMigrationPromotionProductionTarget.neonBranchId,
    databaseName: productionMigrationPromotionProductionTarget.databaseName,
    projectId: productionMigrationPromotionProductionTarget.neonProjectId,
    roleName: "neondb_owner",
    serverVersionNum: 170004,
    target: "prod",
  };
  const base = {
    connectedTarget,
    headCommit: first.candidateCommit,
    ledgerRows: [],
    plan: [selectedPromotionMigration(first.expectedMigration)],
  };
  const firstToken = createMigrationPlanToken({
    ...base,
    productionPromotionVerification: first.verification,
  });
  const secondToken = createMigrationPlanToken({
    ...base,
    productionPromotionVerification: second.verification,
  });

  assert.match(firstToken, /^[a-f0-9]{64}$/);
  assert.equal(first.verification.trustAnchorSha256, second.verification.trustAnchorSha256);
  assert.equal(first.verification.migrationInventorySha256, second.verification.migrationInventorySha256);
  assert.notEqual(first.verification.evidenceSha256, second.verification.evidenceSha256);
  assert.notEqual(firstToken, secondToken, "swapping valid evidence must invalidate the dry-run token");
  assert.throws(
    () => createMigrationPlanToken({
      ...base,
      productionPromotionVerification: { ...first.verification },
    }),
    /PRODUCTION_PROMOTION_CRYPTOGRAPHIC_VERIFICATION_REQUIRED/,
  );
});

test("Production promotion evidence loader accepts only canonical, single-link files outside the repository", async () => {
  const fixture = createPromotionEvidenceFixture();
  const tempDirectory = mkdtempSync(join(tmpdir(), "novalure-production-promotion-"));
  const canonicalPath = join(tempDirectory, "promotion-evidence.json");
  const secondLinkPath = join(tempDirectory, "promotion-evidence-hardlink.json");
  const nonCanonicalPath = join(tempDirectory, "promotion-evidence-noncanonical.json");
  try {
    writeFileSync(canonicalPath, canonicalJson(fixture.document), "utf8");
    assert.deepEqual(
      await loadCanonicalProductionMigrationPromotionEvidence({
        evidencePath: canonicalPath,
        repositoryRoot,
      }),
      fixture.document,
    );

    linkSync(canonicalPath, secondLinkPath);
    await assert.rejects(
      () => loadCanonicalProductionMigrationPromotionEvidence({
        evidencePath: canonicalPath,
        repositoryRoot,
      }),
      /PRODUCTION_PROMOTION_EVIDENCE_NOT_BOUNDED_REGULAR_FILE/,
    );

    writeFileSync(nonCanonicalPath, JSON.stringify(fixture.document), "utf8");
    await assert.rejects(
      () => loadCanonicalProductionMigrationPromotionEvidence({
        evidencePath: nonCanonicalPath,
        repositoryRoot,
      }),
      /PRODUCTION_PROMOTION_EVIDENCE_NOT_CANONICAL/,
    );
  } finally {
    rmSync(tempDirectory, { force: true, recursive: true });
  }
});

test("matching numeric 051/052/053 aliases count their canonical files as applied", () => {
  const migrations = [
    migration("049_property_inventory_tenant_guards", "sha-049"),
    migration("051_private_media_access", "sha-051"),
    migration("052_validate_property_inventory_tenant_guards", "sha-052"),
    migration("053_oauth_state_integrity", "sha-053"),
  ];
  const ledgerRows = [
    ledgerRow("049_property_inventory_tenant_guards", "sha-049"),
    ledgerRow("051", "sha-051"),
    ledgerRow("052", "sha-052"),
    ledgerRow("053", "sha-053"),
  ];

  const state = resolveMigrationLedgerState({ ledgerRows, migrations });
  assert.deepEqual(
    state.aliases.map(({ aliasVersion, migrationVersion }) => ({
      aliasVersion,
      migrationVersion,
    })),
    [
      { aliasVersion: "051", migrationVersion: "051_private_media_access" },
      {
        aliasVersion: "052",
        migrationVersion: "052_validate_property_inventory_tenant_guards",
      },
      { aliasVersion: "053", migrationVersion: "053_oauth_state_integrity" },
    ],
  );
  assert.deepEqual(createMigrationPlan({ ledgerRows, migrations, only: "" }), []);
});

test("numeric aliases fail closed on missing, mismatched, or ambiguous checksums", () => {
  const local = migration("051_private_media_access", "sha-051");

  assert.throws(
    () => resolveMigrationLedgerState({
      ledgerRows: [ledgerRow("051", null)],
      migrations: [local],
    }),
    /Missing checksum for legacy numeric alias 051/,
  );
  assert.throws(
    () => resolveMigrationLedgerState({
      ledgerRows: [ledgerRow("051", "different-sha")],
      migrations: [local],
    }),
    /Checksum mismatch for legacy numeric alias 051/,
  );
  assert.throws(
    () => resolveMigrationLedgerState({
      ledgerRows: [ledgerRow("051", "sha-051")],
      migrations: [
        local,
        migration("051_same_number_and_content", "sha-051"),
      ],
    }),
    /Ambiguous checksum for legacy numeric alias 051/,
  );
});

test("numeric aliases require one unambiguous ledger row and no canonical twin", () => {
  const local = migration("052_validate_property_inventory_tenant_guards", "sha-052");

  assert.throws(
    () => resolveMigrationLedgerState({
      ledgerRows: [ledgerRow("052", "sha-052"), ledgerRow("052", "sha-052")],
      migrations: [local],
    }),
    /expected exactly one ledger row, found 2/,
  );
  assert.throws(
    () => resolveMigrationLedgerState({
      ledgerRows: [
        ledgerRow("052", "sha-052"),
        ledgerRow("052_validate_property_inventory_tenant_guards", "sha-052"),
      ],
      migrations: [local],
    }),
    /Refusing parallel canonical and legacy alias rows for 052/,
  );
  assert.throws(
    () => resolveMigrationLedgerState({
      ledgerRows: [ledgerRow("052", "sha-052"), ledgerRow("052_legacy_name", "sha-052")],
      migrations: [local],
    }),
    /Ambiguous ledger number 052/,
  );
});

test("only exact three-digit aliases are accepted and other number collisions still block", () => {
  const local = migration("051_private_media_access", "sha-051");
  const ledgerRows = [ledgerRow("51", "sha-051")];
  const plan = createMigrationPlan({ ledgerRows, migrations: [local], only: "" });

  assert.deepEqual(plan, [local]);
  assert.throws(
    () => validateMigrationPlan({ ledgerRows, migrations: [local], plan }),
    /number 051 already exists in ledger as 51/,
  );
});

test("canonical checksum drift such as migration 049 cannot be bypassed as an alias", () => {
  const local = migration("049_property_inventory_tenant_guards", "local-sha");

  assert.throws(
    () => createMigrationPlan({
      ledgerRows: [ledgerRow("049_property_inventory_tenant_guards", "ledger-sha")],
      migrations: [local],
      only: "",
    }),
    /Checksum mismatch for 049_property_inventory_tenant_guards/,
  );
});

test("an explicit historical migration is covered by the 041 baseline and cannot rerun", () => {
  const historical = migration("034_property_department", "sha-034");
  const baseline = migration("041_schema_ledger_baseline", "sha-041");
  const ledgerRows = [ledgerRow("041_schema_ledger_baseline", "sha-041")];

  assert.deepEqual(
    createMigrationPlan({
      ledgerRows,
      migrations: [historical, baseline],
      only: "034_property_department",
    }),
    [],
  );
});

test("the checksummed 041 baseline verifies historical dependencies without weakening fail-closed plans", () => {
  const historical = migration("036_company_profiles", "sha-036");
  const baseline = migration("041_schema_ledger_baseline", "sha-041");
  const approvalIntegrity = migration(
    "078_company_profile_approval_integrity",
    "sha-078",
    { manualCutover: true },
  );
  const migrations = [historical, baseline, approvalIntegrity];
  const baselineLedger = [ledgerRow("041_schema_ledger_baseline", "sha-041")];

  assert.deepEqual(
    createMigrationPlan({
      allowManualCutover: true,
      ledgerRows: baselineLedger,
      migrations,
      only: approvalIntegrity.version,
    }),
    [approvalIntegrity],
  );
  assert.doesNotThrow(() => resolveMigrationLedgerState({
    ledgerRows: [...baselineLedger, ledgerRow(approvalIntegrity.version, approvalIntegrity.checksum)],
    migrations,
  }));
  assert.throws(
    () => createMigrationPlan({
      allowManualCutover: true,
      ledgerRows: [],
      migrations,
      only: approvalIntegrity.version,
    }),
    /required predecessor 036_company_profiles/,
  );
  assert.throws(
    () => resolveMigrationLedgerState({
      ledgerRows: [
        ledgerRow("041_schema_ledger_baseline", null),
        ledgerRow(approvalIntegrity.version, approvalIntegrity.checksum),
      ],
      migrations,
    }),
    /required predecessor 036_company_profiles/,
  );
});

test("migration apply accepts only content committed byte-for-byte in HEAD", () => {
  const cwd = mkdtempSync(join(tmpdir(), "novalure-migration-commit-test-"));
  mkdirSync(join(cwd, "migrations"));
  execFileSync("git", ["init", "--quiet"], { cwd });
  execFileSync("git", ["config", "user.name", "Novalure QA"], { cwd });
  execFileSync("git", ["config", "user.email", "qa@example.invalid"], { cwd });

  const path = "migrations/065_example.sql";
  const committedContent = "select 1;\n";
  writeFileSync(join(cwd, path), committedContent);
  execFileSync("git", ["add", path], { cwd });
  execFileSync("git", ["commit", "--quiet", "-m", "baseline"], { cwd });

  const committed = migration("065_example", "unused", { path });
  committed.checksum = createHash("sha256").update(committedContent).digest("hex");
  assert.doesNotThrow(() => assertMigrationCommitted({ cwd, migration: committed }));

  writeFileSync(join(cwd, path), "select 2;\n");
  assert.throws(
    () => assertMigrationCommitted({ cwd, migration: committed }),
    /staged, worktree, or checksum drift/,
  );
  execFileSync("git", ["add", path], { cwd });
  assert.throws(
    () => assertMigrationCommitted({ cwd, migration: committed }),
    /staged, worktree, or checksum drift/,
  );

  const stagedOnlyPath = "migrations/066_staged_only.sql";
  writeFileSync(join(cwd, stagedOnlyPath), "select 3;\n");
  execFileSync("git", ["add", stagedOnlyPath], { cwd });
  const stagedOnly = migration("066_staged_only", "unused", { path: stagedOnlyPath });
  stagedOnly.checksum = createHash("sha256").update("select 3;\n").digest("hex");
  assert.throws(
    () => assertMigrationCommitted({ cwd, migration: stagedOnly }),
    /not committed in HEAD/,
  );
});

test("the entire migration plan is commit-verified before its first write", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "novalure-migration-plan-test-"));
  mkdirSync(join(cwd, "migrations"));
  execFileSync("git", ["init", "--quiet"], { cwd });
  execFileSync("git", ["config", "user.name", "Novalure QA"], { cwd });
  execFileSync("git", ["config", "user.email", "qa@example.invalid"], { cwd });

  const validPath = "migrations/065_valid.sql";
  const invalidPath = "migrations/066_staged_only.sql";
  const validContent = "select 1;\n";
  const invalidContent = "select 2;\n";
  writeFileSync(join(cwd, validPath), validContent);
  execFileSync("git", ["add", validPath], { cwd });
  execFileSync("git", ["commit", "--quiet", "-m", "baseline"], { cwd });
  writeFileSync(join(cwd, invalidPath), invalidContent);
  execFileSync("git", ["add", invalidPath], { cwd });

  const valid = migration("065_valid", createHash("sha256").update(validContent).digest("hex"), {
    path: validPath,
  });
  const invalid = migration(
    "066_staged_only",
    createHash("sha256").update(invalidContent).digest("hex"),
    { path: invalidPath },
  );
  const applied = [];

  await assert.rejects(
    () => applyCommittedMigrationPlan({
      apply: async (item) => applied.push(item.version),
      cwd,
      plan: [valid, invalid],
    }),
    /not committed in HEAD/,
  );
  assert.deepEqual(applied, []);
});

test("migration plan tokens bind commit, connected target, ledger and checksums", () => {
  const input = {
    connectedTarget: {
      branchId: "br-qa-1234",
      databaseName: "neondb",
      projectId: "project-qa-1234",
      roleName: "migration_owner",
      serverVersionNum: 170004,
      target: "test",
    },
    headCommit: "a".repeat(40),
    ledgerRows: [ledgerRow("041_schema_ledger_baseline", "sha-041")],
    plan: [migration("048_bot_webhook_integrity", "sha-048")],
  };
  const token = createMigrationPlanToken(input);

  assert.match(token, /^[a-f0-9]{64}$/);
  assert.equal(createMigrationPlanToken(input), token);
  assert.notEqual(
    createMigrationPlanToken({ ...input, headCommit: "b".repeat(40) }),
    token,
  );
  assert.notEqual(
    createMigrationPlanToken({
      ...input,
      connectedTarget: { ...input.connectedTarget, branchId: "br-other-1234" },
    }),
    token,
  );
  assert.notEqual(
    createMigrationPlanToken({
      ...input,
      connectedTarget: { ...input.connectedTarget, serverVersionNum: 170005 },
    }),
    token,
  );
  assert.notEqual(
    createMigrationPlanToken({
      ...input,
      ledgerRows: [ledgerRow("041_schema_ledger_baseline", "changed")],
    }),
    token,
  );
  assert.notEqual(
    createMigrationPlanToken({
      ...input,
      plan: [migration("048_bot_webhook_integrity", "changed")],
    }),
    token,
  );
});

test("060, 061 and DB-01 migration 068 remain manual even when alias handling is active", () => {
  const migrations = [
    migration("060_tenant_rls_pilot_prepare", "sha-060", { manualCutover: true }),
    migration("061_validate_and_activate_tenant_rls_pilot", "sha-061", {
      manualCutover: true,
    }),
    migration("068_qa_batch_reset_safety", "sha-068", { manualCutover: true }),
  ];

  assert.deepEqual(createMigrationPlan({ ledgerRows: [], migrations, only: "" }), []);
  assert.throws(
    () => createMigrationPlan({
      ledgerRows: [],
      migrations,
      only: "060_tenant_rls_pilot_prepare",
    }),
    /Refusing manual cutover migration 060_tenant_rls_pilot_prepare/,
  );
  assert.deepEqual(
    createMigrationPlan({
      allowManualCutover: true,
      ledgerRows: [],
      migrations,
      only: "060_tenant_rls_pilot_prepare",
    }),
    [migrations[0]],
  );
  assert.throws(
    () => createMigrationPlan({
      allowManualCutover: true,
      ledgerRows: [],
      migrations,
      only: "061_validate_and_activate_tenant_rls_pilot",
    }),
    /required predecessor 060_tenant_rls_pilot_prepare is not checksummed in the ledger/,
  );
  assert.deepEqual(
    createMigrationPlan({
      allowManualCutover: true,
      ledgerRows: [ledgerRow("060_tenant_rls_pilot_prepare", "sha-060")],
      migrations,
      only: "061_validate_and_activate_tenant_rls_pilot",
    }),
    [migrations[1]],
  );
  assert.throws(
    () => createMigrationPlan({
      allowManualCutover: true,
      ledgerRows: [],
      migrations,
      only: "068_qa_batch_reset_safety",
    }),
    /required predecessor 060_tenant_rls_pilot_prepare is not checksummed in the ledger/,
  );
  assert.deepEqual(
    createMigrationPlan({
      allowManualCutover: true,
      ledgerRows: [ledgerRow("060_tenant_rls_pilot_prepare", "sha-060")],
      migrations,
      only: "068_qa_batch_reset_safety",
    }),
    [migrations[2]],
  );
  assert.doesNotThrow(() =>
    resolveMigrationLedgerState({
      ledgerRows: [
        ledgerRow("060_tenant_rls_pilot_prepare", "sha-060"),
        ledgerRow("068_qa_batch_reset_safety", "sha-068"),
      ],
      migrations,
    }),
  );
});

test("062 requires both private-media expand and append-only preparation", () => {
  const migrations = [
    migration("051_private_media_access", "sha-051"),
    migration("060_tenant_rls_pilot_prepare", "sha-060", { manualCutover: true }),
    migration("062_private_media_contract_cutover", "sha-062", { manualCutover: true }),
  ];

  assert.throws(
    () => createMigrationPlan({
      allowManualCutover: true,
      ledgerRows: [ledgerRow("051_private_media_access", "sha-051")],
      migrations,
      only: "062_private_media_contract_cutover",
    }),
    /required predecessor 060_tenant_rls_pilot_prepare is not checksummed in the ledger/,
  );
  assert.throws(
    () => createMigrationPlan({
      allowManualCutover: true,
      ledgerRows: [ledgerRow("060_tenant_rls_pilot_prepare", "sha-060")],
      migrations,
      only: "062_private_media_contract_cutover",
    }),
    /required predecessor 051_private_media_access is not checksummed in the ledger/,
  );
  assert.deepEqual(
    createMigrationPlan({
      allowManualCutover: true,
      ledgerRows: [
        ledgerRow("051_private_media_access", "sha-051"),
        ledgerRow("060_tenant_rls_pilot_prepare", "sha-060"),
      ],
      migrations,
      only: "062_private_media_contract_cutover",
    }),
    [migrations[2]],
  );
});

test("062 opens and restores only its exact audit maintenance boundary inside the runner transaction", () => {
  const ownerGuard = mediaContract.indexOf("audit_owner_name is distinct from current_user");
  const triggerGuard = mediaContract.indexOf("trigger_row.tgenabled = 'O'");
  const noForce = mediaContract.indexOf("alter table public.audit_logs no force row level security");
  const disableGuard = mediaContract.indexOf("alter table public.audit_logs disable trigger audit_logs_append_only_guard");
  const auditScrub = mediaContract.indexOf("update public.audit_logs");
  const enableGuard = mediaContract.indexOf("alter table public.audit_logs enable trigger audit_logs_append_only_guard");
  const restoreForce = mediaContract.indexOf("alter table public.audit_logs force row level security");
  const restorationCheck = mediaContract.indexOf("failed to restore audit_logs protection state");

  assert.ok(ownerGuard >= 0 && ownerGuard < triggerGuard);
  assert.ok(triggerGuard < noForce && noForce < disableGuard);
  assert.ok(disableGuard < auditScrub && auditScrub < enableGuard);
  assert.ok(enableGuard < restoreForce && restoreForce < restorationCheck);
  assert.equal((mediaContract.match(/update public\.audit_logs/giu) ?? []).length, 1);
  assert.equal((mediaContract.match(/trigger_row\.tgenabled = 'O'/giu) ?? []).length, 2);
  assert.match(mediaContract, /where action = 'bot\.document_send\.attach_media_asset'/i);
  assert.match(mediaContract, /trigger_row\.tgfoid = 'public\.reject_audit_logs_mutation\(\)'::regprocedure/i);
  assert.doesNotMatch(mediaContract, /disable trigger all/i);
  assert.doesNotMatch(mediaContract, /disable row level security/i);

  const applyStart = runner.indexOf("async function applyMigration");
  const applyEnd = runner.indexOf("async function main", applyStart);
  const applySource = runner.slice(applyStart, applyEnd);
  assert.match(applySource, /await client\.query\("begin"\)/);
  assert.match(applySource, /await client\.query\(\{ query_timeout: migrationClientTimeoutMs, text: migration\.content \}\)/);
  assert.match(applySource, /await client\.query\("commit"\)/);
  assert.match(applySource, /catch \(error\)[\s\S]*await client\.query\("rollback"\)[\s\S]*throw error/);
});

test("legacy-breaking release contracts are isolated from automatic expand migrations", () => {
  assert.doesNotMatch(webhookExpand, /drop index if exists bot_channel_webhooks_workspace_message_uidx/);
  assert.match(webhookCutover, /drop index if exists bot_channel_webhooks_workspace_message_uidx/);

  assert.doesNotMatch(mediaExpand, /set public_token = null/);
  assert.doesNotMatch(mediaExpand, /set url = '\/api\/media\/files\/' \|\| id::text/);
  assert.doesNotMatch(mediaExpand, /media_assets_public_token_cleartext_check/);
  assert.match(mediaContract, /set public_token = null/);
  assert.match(mediaContract, /media_assets_public_token_cleartext_check/);
  assert.match(mediaContract, /legacy public token has no durable share/);

  assert.doesNotMatch(providerExpand, /create trigger google_notification_job_target_guard/);
  assert.doesNotMatch(providerExpand, /leads_qualifying_requires_assignee_check/);
  assert.match(providerCutover, /create trigger google_notification_job_target_guard/);
  assert.match(providerCutover, /create trigger teams_notification_job_target_guard/);
  assert.match(providerCutover, /leads_qualifying_requires_assignee_check[\s\S]*not valid/i);
});

test("Inventory idempotency migration is additive, DB-enforced and cleanup-compatible", () => {
  assert.match(unitIdempotencyExpand, /create table if not exists property_unit_idempotency/);
  assert.match(unitIdempotencyExpand, /unique \(workspace_id, idempotency_key\)/);
  assert.match(
    unitIdempotencyExpand,
    /foreign key \(workspace_id, project_id, unit_id\)[\s\S]*references property_units\(workspace_id, project_id, id\)[\s\S]*on delete cascade/,
  );
  assert.match(unitIdempotencyExpand, /create table if not exists property_building_idempotency/);
  assert.match(
    unitIdempotencyExpand,
    /foreign key \(workspace_id, project_id, building_id\)[\s\S]*references property_buildings\(workspace_id, project_id, id\)[\s\S]*on delete cascade/,
  );
  assert.match(unitIdempotencyExpand, /request_hash text not null/);
  assert.match(unitIdempotencyExpand, /response jsonb not null/);
  assert.match(unitIdempotencyExpand, /revoke all on table property_unit_idempotency from novalure_tenant_app/);
  assert.match(unitIdempotencyExpand, /revoke all on table property_building_idempotency from novalure_tenant_app/);
  assert.doesNotMatch(
    unitIdempotencyExpand,
    /grant select, insert on table property_unit_idempotency to novalure_tenant_app/,
  );
  assert.doesNotMatch(
    unitIdempotencyExpand,
    /grant select, insert on table property_building_idempotency to novalure_tenant_app/,
  );
  assert.doesNotMatch(unitIdempotencyExpand, /delete from|drop table|drop column/i);
});

test("Form owner migration validates the tenant-qualified relationship without silent repair", () => {
  assert.match(formsOwnerGuard, /foreign key \(workspace_id, owner_user_id\)/);
  assert.match(formsOwnerGuard, /references public\.workspace_users\(workspace_id, id\)/);
  assert.match(formsOwnerGuard, /validate constraint forms_workspace_owner_fk/);
  assert.doesNotMatch(formsOwnerGuard, /update public\.forms|delete from|drop table|drop column/i);
});

test("Funnel submission recovery adds only durable lease and idempotency guards", () => {
  assert.match(funnelSubmissionRecovery, /lease_version bigint not null default 1/);
  assert.match(funnelSubmissionRecovery, /funnel_submissions_workspace_idempotency_key_uidx/);
  assert.match(funnelSubmissionRecovery, /where idempotency_key is not null/);
  assert.doesNotMatch(funnelSubmissionRecovery, /delete from|drop table|drop column/i);
});

test("Form submission atomicity binds semantic replay and every relation to its tenant", () => {
  assert.match(formSubmissionAtomicity, /add column if not exists idempotency_key text/);
  assert.match(formSubmissionAtomicity, /form_submissions_workspace_idempotency_key_uidx/);
  assert.match(formSubmissionAtomicity, /unique index[\s\S]*\(workspace_id, idempotency_key\)/i);
  assert.match(formSubmissionAtomicity, /migration 070_funnel_submission_idempotency_recovery is required/);
  assert.match(formSubmissionAtomicity, /migration 071_forms_owner_tenant_guard is required/);
  assert.match(formSubmissionAtomicity, /or coalesce\(\([\s\S]*idempotency_key is not null[\s\S]*request_hash is not null[\s\S]*claim_lease_version is not null[\s\S]*response_payload is not null[\s\S]*\), false\)/);
  assert.match(formSubmissionAtomicity, /response_payload->>'status' ~ '\^\[1-5\]\[0-9\]\{2\}\$'/);
  for (const relation of ["project", "form", "funnel", "contact", "lead", "deal", "task"]) {
    assert.match(
      formSubmissionAtomicity,
      new RegExp(`form_submissions_workspace_${relation}_fk`),
    );
  }
  assert.doesNotMatch(formSubmissionAtomicity, /delete from|drop table|drop column/i);
});

test("explicit automatic migrations require their checksummed predecessors", () => {
  const migrations = [
    migration("049_property_inventory_tenant_guards", "sha-049"),
    migration("050_durable_job_leasing", "sha-050"),
    migration("052_validate_property_inventory_tenant_guards", "sha-052"),
    migration("053_oauth_state_integrity", "sha-053"),
    migration("055_public_submission_abuse_guards", "sha-055"),
    migration("064_notification_provider_and_lead_assignee_integrity", "sha-064"),
    migration("065_notification_guard_search_path_hardening", "sha-065", {
      manualCutover: true,
    }),
    migration("066_oauth_state_workspace_user_guard", "sha-066"),
    migration("069_property_unit_idempotency", "sha-069"),
    migration("070_funnel_submission_idempotency_recovery", "sha-070"),
    migration("071_forms_owner_tenant_guard", "sha-071"),
    migration("072_form_submission_atomicity", "sha-072"),
    migration("060_tenant_rls_pilot_prepare", "sha-060", { manualCutover: true }),
    migration("073_launch_tenant_relation_guards", "sha-073"),
    migration("074_validate_launch_tenant_relation_guards", "sha-074", { manualCutover: true }),
    migration("075_public_funnel_visit_truth", "sha-075"),
    migration("076_bot_webhook_durable_processing", "sha-076"),
  ];

  assert.throws(
    () => createMigrationPlan({
      ledgerRows: [],
      migrations,
      only: "052_validate_property_inventory_tenant_guards",
    }),
    /required predecessor 049_property_inventory_tenant_guards/,
  );
  assert.throws(
    () => createMigrationPlan({
      ledgerRows: [],
      migrations,
      only: "064_notification_provider_and_lead_assignee_integrity",
    }),
    /required predecessor 050_durable_job_leasing/,
  );
  assert.deepEqual(
    createMigrationPlan({
      ledgerRows: [
        ledgerRow("049_property_inventory_tenant_guards", "sha-049"),
        ledgerRow("050_durable_job_leasing", "sha-050"),
      ],
      migrations,
      only: "052_validate_property_inventory_tenant_guards",
    }),
    [migrations[2]],
  );
  assert.throws(
    () => createMigrationPlan({
      allowManualCutover: true,
      ledgerRows: [ledgerRow("050_durable_job_leasing", "sha-050")],
      migrations,
      only: "065_notification_guard_search_path_hardening",
    }),
    /required predecessor 064_notification_provider_and_lead_assignee_integrity/,
  );
  assert.throws(
    () => createMigrationPlan({
      ledgerRows: [],
      migrations,
      only: "066_oauth_state_workspace_user_guard",
    }),
    /required predecessor 053_oauth_state_integrity/,
  );
  assert.throws(
    () => createMigrationPlan({
      ledgerRows: [],
      migrations,
      only: "069_property_unit_idempotency",
    }),
    /required predecessor 049_property_inventory_tenant_guards/,
  );
  assert.deepEqual(
    createMigrationPlan({
      ledgerRows: [ledgerRow("049_property_inventory_tenant_guards", "sha-049")],
      migrations,
      only: "069_property_unit_idempotency",
    }),
    [migrations[8]],
  );
  assert.throws(
    () => createMigrationPlan({
      ledgerRows: [],
      migrations,
      only: "070_funnel_submission_idempotency_recovery",
    }),
    /required predecessor 055_public_submission_abuse_guards/,
  );
  assert.deepEqual(
    createMigrationPlan({
      ledgerRows: [ledgerRow("055_public_submission_abuse_guards", "sha-055")],
      migrations,
      only: "070_funnel_submission_idempotency_recovery",
    }),
    [migrations[9]],
  );
  assert.throws(
    () => createMigrationPlan({
      ledgerRows: [],
      migrations,
      only: "071_forms_owner_tenant_guard",
    }),
    /required predecessor 066_oauth_state_workspace_user_guard/,
  );
  assert.deepEqual(
    createMigrationPlan({
      ledgerRows: [
        ledgerRow("053_oauth_state_integrity", "sha-053"),
        ledgerRow("066_oauth_state_workspace_user_guard", "sha-066"),
      ],
      migrations,
      only: "071_forms_owner_tenant_guard",
    }),
    [migrations[10]],
  );
  assert.throws(
    () => createMigrationPlan({
      ledgerRows: [
        ledgerRow("053_oauth_state_integrity", "sha-053"),
        ledgerRow("066_oauth_state_workspace_user_guard", "sha-066"),
        ledgerRow("071_forms_owner_tenant_guard", "sha-071"),
      ],
      migrations,
      only: "072_form_submission_atomicity",
    }),
    /required predecessor 070_funnel_submission_idempotency_recovery/,
  );
  assert.throws(
    () => createMigrationPlan({
      ledgerRows: [
        ledgerRow("055_public_submission_abuse_guards", "sha-055"),
        ledgerRow("070_funnel_submission_idempotency_recovery", "sha-070"),
      ],
      migrations,
      only: "072_form_submission_atomicity",
    }),
    /required predecessor 071_forms_owner_tenant_guard/,
  );
  assert.deepEqual(
    createMigrationPlan({
      ledgerRows: [
        ledgerRow("053_oauth_state_integrity", "sha-053"),
        ledgerRow("055_public_submission_abuse_guards", "sha-055"),
        ledgerRow("066_oauth_state_workspace_user_guard", "sha-066"),
        ledgerRow("070_funnel_submission_idempotency_recovery", "sha-070"),
        ledgerRow("071_forms_owner_tenant_guard", "sha-071"),
      ],
      migrations,
      only: "072_form_submission_atomicity",
    }),
    [migrations[11]],
  );
  const launchLedgerWithoutTenantRole = [
    ledgerRow("053_oauth_state_integrity", "sha-053"),
    ledgerRow("055_public_submission_abuse_guards", "sha-055"),
    ledgerRow("066_oauth_state_workspace_user_guard", "sha-066"),
    ledgerRow("070_funnel_submission_idempotency_recovery", "sha-070"),
    ledgerRow("071_forms_owner_tenant_guard", "sha-071"),
    ledgerRow("072_form_submission_atomicity", "sha-072"),
    ledgerRow("073_launch_tenant_relation_guards", "sha-073"),
    ledgerRow("074_validate_launch_tenant_relation_guards", "sha-074"),
  ];
  assert.throws(
    () => createMigrationPlan({
      ledgerRows: launchLedgerWithoutTenantRole,
      migrations,
      only: "075_public_funnel_visit_truth",
    }),
    /required predecessor 060_tenant_rls_pilot_prepare/,
  );
  assert.deepEqual(
    createMigrationPlan({
      ledgerRows: [
        ...launchLedgerWithoutTenantRole,
        ledgerRow("060_tenant_rls_pilot_prepare", "sha-060"),
      ],
      migrations,
      only: "075_public_funnel_visit_truth",
    }),
    [migrations[15]],
  );
  assert.throws(
    () => resolveMigrationLedgerState({
      ledgerRows: [ledgerRow("052_validate_property_inventory_tenant_guards", "sha-052")],
      migrations,
    }),
    /Invalid migration ledger: 052_validate_property_inventory_tenant_guards is applied without required predecessor 049_property_inventory_tenant_guards/,
  );
});

test("automatic migration plans exclude every release cutover phase", () => {
  assert.match(runner, /manualCutoverVersions = new Set\(recoveryManualCutoverMigrations\)/);
  assert.match(
    runner,
    /\["062_private_media_contract_cutover", \[[\s\S]*"051_private_media_access"[\s\S]*"060_tenant_rls_pilot_prepare"/,
  );
  assert.match(
    runner,
    /\["068_qa_batch_reset_safety", "060_tenant_rls_pilot_prepare"\]/,
  );
  assert.match(
    runner,
    /\["075_public_funnel_visit_truth", \[[\s\S]*"074_validate_launch_tenant_relation_guards"[\s\S]*"060_tenant_rls_pilot_prepare"/,
  );
  assert.match(
    runner,
    /\["076_bot_webhook_durable_processing", \[[\s\S]*"075_public_funnel_visit_truth"[\s\S]*"057_bot_webhook_legacy_index_cutover"/,
  );
  assert.match(
    runner,
    /\["077_schema_ledger_runtime_projection", "076_bot_webhook_durable_processing"\]/,
  );
  assert.match(
    runner,
    /\["079_public_funnel_visit_role_boundary", "075_public_funnel_visit_truth"\]/,
  );
  assert.match(runner, /targetName === "prod"[\s\S]*productionPromotionRequiredMigrationVersions\.has\(migration\.version\)/);
});

test("a manual cutover requires a single explicit version and opt-in flag", () => {
  assert.match(runner, /--allow-manual-cutover requires one explicit --only=<version>/);
  assert.match(runner, /\(migration\.manualCutover \|\| productionPlanCutover\) && !allowManualCutover/);
  assert.match(runner, /Refusing manual cutover migration/);
  assert.match(runner, /never included automatically/);
  assert.match(
    runner,
    /const nextPlan = plannedMigrations\(\{\s*allowManualCutover,\s*ledgerRows: nextLedger\.rows,\s*migrations,\s*only,\s*targetName: target\.name,\s*\}\)/,
    "post-apply verification must retain the explicit --only boundary instead of expanding to the automatic plan",
  );
});

test("recovery database URLs use a bounded, redacted stdin-only channel", async () => {
  const databaseUrlFixture = new URL("postgresql://recovery.example.neon.tech/neondb");
  databaseUrlFixture.username = "migration_owner";
  databaseUrlFixture.password = "fixture_not_a_secret";
  const databaseUrl = databaseUrlFixture.href;
  assert.equal(
    await readMigrationDatabaseUrlFromStdin(Readable.from([`${databaseUrl}\n`])),
    databaseUrl,
  );
  await assert.rejects(
    () => readMigrationDatabaseUrlFromStdin(Readable.from(["https://example.invalid/not-postgres\n"])),
    /stdin is invalid/,
  );
  await assert.rejects(
    () => readMigrationDatabaseUrlFromStdin(Readable.from([`${"x".repeat(4_097)}\n`])),
    /stdin is invalid/,
  );
  await assert.rejects(
    () => readMigrationDatabaseUrlFromStdin(Readable.from([])),
    /stdin is missing/,
  );

  assert.match(runner, /recovery:\s*"\.env\.recovery\.local"/);
  assert.match(runner, /--connection-stdin/);
  assert.match(runner, /rawLine\.length > 4_096/);
  assert.match(runner, /Refusing ambiguous migration database URL sources/);
  assert.doesNotMatch(runner, /console\.(?:log|error)\([^\n;]*databaseUrl/);
});

test("protected Preview CI never applies migrations and keeps manual tenant cutovers excluded", () => {
  assert.match(workflow, /node scripts\/qa-protected-preview-action-runner\.mjs/);
  assert.match(protectedPreviewRunner, /\["scripts\/qa-two-tenant-e2e\.mjs", "--validate-config"\]/);
  assert.match(
    protectedPreviewRunner,
    /\["scripts\/qa-two-tenant-e2e\.mjs", "--preflight", "--share-url-stdin"\]/,
  );
  assert.match(
    protectedPreviewRunner,
    /\["scripts\/qa-two-tenant-e2e\.mjs", "--execute", "--share-url-stdin"\]/,
  );
  const protectedPreviewExecution = `${workflow}\n${protectedPreviewRunner}`;
  assert.doesNotMatch(protectedPreviewExecution, /node scripts\/db-migrate\.mjs (?:dry-run|up)/);
  assert.doesNotMatch(protectedPreviewExecution, /qa-livegang-seed/);
  assert.match(runner, /pg_try_advisory_lock/);
  assert.match(runner, /set lock_timeout = '5s'/);
  assert.match(runner, /set statement_timeout = '14min'/);
  assert.match(runner, /set transaction_timeout = '15min'/);
  assert.match(runner, /connectionTimeoutMillis:\s*10_000/);
  assert.match(runner, /migrationClientTimeoutMs = 960_000/);
  assert.match(runner, /idle_in_transaction_session_timeout:\s*60_000/);
  assert.match(runner, /set search_path = public/);
  assert.match(runner, /set local search_path = public/);
  assert.match(runner, /public\.novalure_schema_migrations/);
  assert.match(runner, /O_NOFOLLOW/);
  assert.match(runner, /pathStat\.isFile\(\)/);
  assert.doesNotMatch(runner, /unlinkSync/);
  assert.match(runner, /up requires --plan-token-file/);
  assert.doesNotMatch(protectedPreviewExecution, /--allow-manual-cutover/);
});

test("protected Preview secrets are step-scoped behind install and all third-party actions are SHA pinned", () => {
  const qaJob = workflow.slice(workflow.indexOf("  protected-preview-two-tenant:"));
  const jobEnv = qaJob.match(/\n    env:\n([\s\S]*?)\n    steps:/)?.[1] ?? "";
  assert.doesNotMatch(jobEnv, /secrets\./);
  assert.match(qaJob, /environment: go-live-preview/);
  assert.ok(
    qaJob.indexOf("Install dependencies from lockfile") < qaJob.indexOf("secrets.NOVALURE_QA_TWO_TENANT_ENV_B64"),
    "QA secrets must not be exposed to checkout, setup, or npm lifecycle scripts",
  );

  const actionReferences = [...workflow.matchAll(/uses:\s+([^\s#]+)/g)].map((match) => match[1]);
  assert.ok(actionReferences.length >= 3);
  for (const reference of actionReferences) {
    assert.match(reference, /@[0-9a-f]{40}$/, `${reference} must use a full commit SHA`);
  }
});
