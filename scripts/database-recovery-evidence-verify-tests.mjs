#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  buildRecoveryDataFingerprint,
  expectedExcludedMigrations,
  expectedRecoveryMigrationPlan,
  verifyRecoveryEvidence,
} from "./database-recovery-evidence-verify.mjs";

const manifestPath = new URL(
  "../docs/audit/2026-08-23/database-recovery-evidence-manifest.json",
  import.meta.url,
);
const rollbackPath = new URL(
  "../docs/audit/2026-08-23/database-recovery-rollback-evidence.json",
  import.meta.url,
);
const verifierPath = new URL("./database-recovery-evidence-verify.mjs", import.meta.url);
const [manifest, rollback, verifierSource] = await Promise.all([
  readFile(manifestPath, "utf8").then(JSON.parse),
  readFile(rollbackPath, "utf8").then(JSON.parse),
  readFile(verifierPath, "utf8"),
]);

test("Recovery evidence verifier accepts only the curated current-SHA PASS", async () => {
  const result = await verifyRecoveryEvidence();
  assert.equal(result.ok, true);
  assert.equal(result.status, "CURRENT_SHA_REHEARSAL_AND_RESET_PASS");
  assert.equal(result.candidateCommit, "2d29252a7252bac9e5367662cf72c22006222067");
  assert.equal(result.migrationCount, 14);
  assert.equal(result.excludedFailedAttempts, 3);
  assert.equal(result.productionMutationPerformed, false);
  assert.match(result.manifestDigest, /^[a-f0-9]{64}$/u);
});

test("Evidence manifest separates the selected PASS from all failed attempts", () => {
  const selected = manifest.evidence.filter((entry) => entry.role === "SELECTED_PASS");
  const failed = manifest.evidence.filter((entry) => entry.role === "EXCLUDED_FAILED_ATTEMPT");
  assert.equal(selected.length, 1);
  assert.equal(selected[0].passEligible, true);
  assert.equal(
    selected[0].sha256,
    "a4483c22b676fab393475af2339764cb027165359eeef5344d574da768dd8310",
  );
  assert.equal(failed.length, 3);
  assert.ok(failed.every((entry) => entry.passEligible === false));
  assert.deepEqual(manifest.explicitlyExcludedMigrations, expectedExcludedMigrations);
  assert.deepEqual(rollback.rehearsal.appliedMigrations, expectedRecoveryMigrationPlan);
});

test("Rollback contract binds distinct preserved/reset branches to equal data fingerprints", () => {
  assert.equal(rollback.rehearsal.preservedMigratedBranchId, "br-empty-tree-alp9d9z1");
  assert.equal(rollback.reset.resetRecoveryBranchId, "br-calm-poetry-al5i1a9c");
  assert.notEqual(
    rollback.rehearsal.preservedMigratedBranchId,
    rollback.reset.resetRecoveryBranchId,
  );
  const productionDigest = buildRecoveryDataFingerprint(rollback.reset.productionFingerprint);
  const recoveryDigest = buildRecoveryDataFingerprint(rollback.reset.recoveryFingerprint);
  assert.equal(productionDigest, recoveryDigest);
  assert.equal(
    productionDigest,
    "c05c3a3d39c67510db92079f593756fcb7551d8f5446c47aa07aa3be4b2e45b8",
  );
  assert.equal(Object.keys(rollback.reset.productionFingerprint.rowCounts).length, 19);
  assert.equal(rollback.reset.productionFingerprint.migrationLedger.count, 19);
  assert.equal(
    rollback.reset.productionFingerprint.migrationLedger.maxVersion,
    "067_app_role_runtime_grants",
  );
  assert.equal(rollback.reset.rowCountMismatchCount, 0);
});

test("Schema diff HTTP 413 remains a non-PASS tool boundary", () => {
  assert.equal(rollback.schemaDiffApi.status, "UNAVAILABLE_HTTP_413_TOOL_LIMIT");
  assert.equal(rollback.schemaDiffApi.countedAsPassEvidence, false);
  assert.equal(manifest.schemaDiffApi.status, "UNAVAILABLE_HTTP_413_TOOL_LIMIT");
  assert.equal(manifest.schemaDiffApi.countedAsPassEvidence, false);
});

test("Evidence verifier is file-only and has no mutation or external-call capability", () => {
  assert.doesNotMatch(verifierSource, /\b(?:writeFile|appendFile|unlink|rm|mkdir|mkdtemp)\b/u);
  assert.doesNotMatch(verifierSource, /\b(?:spawn|exec|fetch|WebSocket|neon)\b/u);
  assert.doesNotMatch(verifierSource, /MIGRATION_DATABASE_URL/u);
  assert.match(verifierSource, /readFile/u);
});

test("Canonical data fingerprint rejects incomplete or malformed rollback captures", () => {
  const incomplete = {
    migrationLedger: rollback.reset.productionFingerprint.migrationLedger,
    rowCounts: { ...rollback.reset.productionFingerprint.rowCounts },
  };
  delete incomplete.rowCounts.workspaces;
  assert.throws(
    () => buildRecoveryDataFingerprint(incomplete),
    /RECOVERY_ROW_TABLE_COUNT_MISMATCH/u,
  );
});
