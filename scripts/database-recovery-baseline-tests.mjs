#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  historicalExcludedRecoveryMigrationsV1,
  historicalRecoveryMigrationPlanV1,
  recoveryMigrationPlan,
  recoveryMigrationPlanContract,
} from "./lib/recovery-migration-plan.mjs";

const baselinePath = new URL(
  "../docs/audit/2026-08-23/database-recovery-baseline.json",
  import.meta.url,
);
const runbookPath = new URL(
  "../docs/audit/2026-08-23/database-recovery-runbook.md",
  import.meta.url,
);
const evidenceManifestPath = new URL(
  "../docs/audit/2026-08-23/database-recovery-evidence-manifest.json",
  import.meta.url,
);
const rollbackEvidencePath = new URL(
  "../docs/audit/2026-08-23/database-recovery-rollback-evidence.json",
  import.meta.url,
);
const [baselineSource, runbook, evidenceManifest, rollbackEvidence] = await Promise.all([
  readFile(baselinePath, "utf8"),
  readFile(runbookPath, "utf8"),
  readFile(evidenceManifestPath, "utf8").then(JSON.parse),
  readFile(rollbackEvidencePath, "utf8").then(JSON.parse),
]);
const baseline = JSON.parse(baselineSource);

test("Recovery baseline records an unchanged Production and an exact restore comparison", () => {
  assert.equal(baseline.schemaVersion, 2);
  assert.equal(baseline.status, "CURRENT_SHA_REHEARSAL_AND_RESET_PASS");
  assert.equal(baseline.candidateCommit, evidenceManifest.candidateCommit);
  assert.match(baseline.candidateCommit, /^[a-f0-9]{40}$/u);
  assert.equal(baseline.migrationRehearsal.candidateCommit, baseline.candidateCommit);
  assert.equal(baseline.rollbackDrill.candidateCommit, baseline.candidateCommit);
  assert.equal(baseline.productionMutationPerformed, false);
  assert.equal(baseline.comparison.comparisonResult, "PASS");
  assert.equal(baseline.comparison.rowCountMismatchCount, 0);
  assert.equal(Object.keys(baseline.comparison.rowCounts).length, 19);
  assert.match(baseline.comparison.schemaSha256, /^[a-f0-9]{64}$/u);
  assert.match(baseline.comparison.migrationLedgerSha256, /^[a-f0-9]{64}$/u);
  assert.equal(baseline.snapshot.historyRetentionSeconds, 21_600);
  assert.equal(
    baseline.snapshot.historyRetentionAssessment,
    "LAUNCH_RISK_REQUIRES_OPERATIONS_ACCEPTANCE",
  );
});

test("Historical baseline stays truthful while the current Recovery plan covers the full chain", () => {
  const historicalPlan = baseline.migrationRehearsal.plannedOrder;
  assert.deepEqual(historicalPlan, historicalRecoveryMigrationPlanV1);
  assert.ok(!historicalPlan.includes("061_validate_and_activate_tenant_rls_pilot"));
  assert.ok(
    baseline.migrationRehearsal.manualCutovers.includes("078_company_profile_approval_integrity"),
  );
  assert.deepEqual(
    baseline.migrationRehearsal.explicitlyExcluded,
    historicalExcludedRecoveryMigrationsV1,
  );
  assert.equal(recoveryMigrationPlan.length, 22);
  assert.equal(recoveryMigrationPlan.at(-1), "061_validate_and_activate_tenant_rls_pilot");
  assert.ok(
    recoveryMigrationPlan.indexOf("060_tenant_rls_pilot_prepare")
      < recoveryMigrationPlan.indexOf("062_private_media_contract_cutover"),
  );
  assert.ok(
    recoveryMigrationPlan.indexOf("082_content_library_privacy")
      < recoveryMigrationPlan.indexOf("084_media_deletion_lifecycle"),
  );
  assert.equal(recoveryMigrationPlanContract, "FULL_PRODUCTION_CHAIN_057_084_RLS_LAST_V2");
  assert.match(runbook, /MIGRATION_TARGET=recovery/u);
  assert.match(runbook, /historische 14er/u);
  assert.match(runbook, /061.*letzte/u);
  assert.match(runbook, /--connection-stdin/u);
});

test("Current candidate rehearsal and reset evidence are explicit and bounded", () => {
  const selectedPass = evidenceManifest.evidence.find((entry) => entry.role === "SELECTED_PASS");
  const failedAttempts = evidenceManifest.evidence.filter(
    (entry) => entry.role === "EXCLUDED_FAILED_ATTEMPT",
  );
  assert.equal(baseline.migrationRehearsal.status, "PASS");
  assert.equal(baseline.migrationRehearsal.selectedEvidencePath, selectedPass.path);
  assert.equal(baseline.migrationRehearsal.selectedEvidenceSha256, selectedPass.sha256);
  assert.equal(baseline.migrationRehearsal.excludedFailedAttemptCount, failedAttempts.length);
  assert.equal(baseline.rollbackDrill.status, "PASS");
  assert.equal(
    baseline.rollbackDrill.preservedMigratedBranchId,
    rollbackEvidence.rehearsal.preservedMigratedBranchId,
  );
  assert.equal(
    baseline.rollbackDrill.resetRecoveryBranchId,
    rollbackEvidence.reset.resetRecoveryBranchId,
  );
  assert.equal(
    baseline.rollbackDrill.dataFingerprintSha256,
    evidenceManifest.rollback.dataFingerprintSha256,
  );
  assert.equal(baseline.rollbackDrill.migrationCount, evidenceManifest.rollback.migrationLedgerCount);
  assert.equal(
    baseline.rollbackDrill.migrationMaxVersion,
    evidenceManifest.rollback.migrationLedgerMaxVersion,
  );
  assert.equal(baseline.rollbackDrill.rowTableCount, evidenceManifest.rollback.tableCount);
  assert.equal(baseline.rollbackDrill.rowCountMismatchCount, 0);
  assert.equal(baseline.rollbackDrill.comparisonResult, "PASS");
  assert.equal(baseline.rollbackDrill.productionMutationPerformed, false);
  assert.equal(
    baseline.rollbackDrill.schemaDiffApi.status,
    "UNAVAILABLE_HTTP_413_TOOL_LIMIT",
  );
  assert.equal(baseline.rollbackDrill.schemaDiffApi.countedAsPassEvidence, false);
  assert.match(runbook, /`status=FAIL`/u);
  assert.match(runbook, /`passEligible=false`/u);
  assert.match(runbook, /HTTP 413/u);
  assert.match(runbook, /kein Schema-Diff-PASS/u);
  assert.match(runbook, /PENDING_SIGNATURE/u);
});

test("Recovery evidence contains no connection URL or common secret material", () => {
  const combined = `${baselineSource}\n${runbook}`;
  for (const forbidden of [
    /postgres(?:ql)?:\/\//iu,
    /_vercel_share=/iu,
    /(?:password|passwd)\s*[:=]\s*\S+/iu,
    /(?:token|secret)\s*[:=]\s*[A-Za-z0-9_-]{12,}/iu,
    /vercel_blob_rw_/iu,
  ]) {
    assert.doesNotMatch(combined, forbidden);
  }
});
