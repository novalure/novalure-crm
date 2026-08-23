#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const baselinePath = new URL(
  "../docs/audit/2026-08-23/database-recovery-baseline.json",
  import.meta.url,
);
const runbookPath = new URL(
  "../docs/audit/2026-08-23/database-recovery-runbook.md",
  import.meta.url,
);
const baselineSource = await readFile(baselinePath, "utf8");
const baseline = JSON.parse(baselineSource);
const runbook = await readFile(runbookPath, "utf8");

test("Recovery baseline records an unchanged Production and an exact restore comparison", () => {
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

test("Recovery plan includes discovered dependencies and keeps migration 061 separate", () => {
  const plan = baseline.migrationRehearsal.plannedOrder;
  assert.ok(plan.includes("060_tenant_rls_pilot_prepare"));
  assert.ok(plan.includes("068_qa_batch_reset_safety"));
  assert.ok(plan.includes("075_public_funnel_visit_truth"));
  assert.ok(plan.includes("078_company_profile_approval_integrity"));
  assert.ok(plan.includes("079_public_funnel_visit_role_boundary"));
  assert.ok(!plan.includes("061_validate_and_activate_tenant_rls_pilot"));
  assert.ok(
    baseline.migrationRehearsal.manualCutovers.includes("078_company_profile_approval_integrity"),
  );
  assert.deepEqual(
    baseline.migrationRehearsal.explicitlyExcluded,
    ["061_validate_and_activate_tenant_rls_pilot"],
  );
  assert.ok(plan.indexOf("060_tenant_rls_pilot_prepare") < plan.indexOf("068_qa_batch_reset_safety"));
  assert.ok(plan.indexOf("074_validate_launch_tenant_relation_guards") < plan.indexOf("075_public_funnel_visit_truth"));
  assert.match(runbook, /MIGRATION_TARGET=recovery/u);
  assert.match(runbook, /Migration 061 wird niemals/u);
  assert.match(runbook, /--connection-stdin/u);
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
