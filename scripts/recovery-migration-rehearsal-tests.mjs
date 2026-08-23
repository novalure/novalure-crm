#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { recoveryMigrationPlan } from "./recovery-migration-rehearsal.mjs";

const source = await readFile(new URL("./recovery-migration-rehearsal.mjs", import.meta.url), "utf8");

test("Recovery rehearsal uses the exact dependency-safe plan and excludes migration 061", () => {
  assert.deepEqual(recoveryMigrationPlan, [
    "057_bot_webhook_legacy_index_cutover",
    "060_tenant_rls_pilot_prepare",
    "068_qa_batch_reset_safety",
    "069_property_unit_idempotency",
    "070_funnel_submission_idempotency_recovery",
    "071_forms_owner_tenant_guard",
    "072_form_submission_atomicity",
    "073_launch_tenant_relation_guards",
    "074_validate_launch_tenant_relation_guards",
    "075_public_funnel_visit_truth",
    "076_bot_webhook_durable_processing",
    "077_schema_ledger_runtime_projection",
    "078_company_profile_approval_integrity",
    "079_public_funnel_visit_role_boundary",
  ]);
  assert.ok(!recoveryMigrationPlan.some((version) => version.startsWith("061_")));
  assert.match(source, /migration061Executed: false/u);
  assert.match(source, /productionMutationPerformed: false/u);
});

test("Recovery rehearsal streams credentials and binds every apply to a fresh plan token", () => {
  assert.match(source, /readMigrationDatabaseUrlFromStdin/u);
  assert.match(source, /--connection-stdin/u);
  assert.match(source, /child\.stdin\.end\(`\$\{databaseUrl\}\\n`\)/u);
  assert.match(source, /delete childEnvironment\.MIGRATION_DATABASE_URL/u);
  assert.match(source, /dry-run[\s\S]*--plan-token-file/u);
  assert.match(source, /up[\s\S]*--plan-token-file/u);
  assert.match(source, /manualCutovers[\s\S]*078_company_profile_approval_integrity/u);
  assert.match(source, /flag: "wx"/u);
  assert.doesNotMatch(source, /console\.(?:log|error)\([^\n;]*databaseUrl/u);
});

test("Recovery rehearsal has exact target, clean-commit, redaction and temp-delete guards", () => {
  assert.match(source, /MIGRATION_TARGET !== "recovery"/u);
  assert.match(source, /confirm-branch/u);
  assert.match(source, /status", "--porcelain=v1", "--untracked-files=all"/u);
  assert.match(source, /REDACTED_DATABASE_URL/u);
  assert.match(source, /maximumChildOutputBytes/u);
  assert.match(source, /relative\(root, target\)/u);
  assert.match(source, /Recovery evidence must be written outside the candidate worktree/u);
});
