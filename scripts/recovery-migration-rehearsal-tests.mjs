#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  applyTenantCutoverMigrationTransaction,
  recoveryMigrationChecksum,
  recoveryMigrationPlan,
} from "./recovery-migration-rehearsal.mjs";
import {
  recoveryManualCutoverMigrations,
  recoveryMigrationPlanContract,
} from "./lib/recovery-migration-plan.mjs";

const source = await readFile(new URL("./recovery-migration-rehearsal.mjs", import.meta.url), "utf8");
const candidateCommit = "a".repeat(40);

function tenantCutoverMigration(content = "select 'migration-061-body'") {
  return {
    checksum: recoveryMigrationChecksum(content),
    content,
    name: "validate_and_activate_tenant_rls_pilot",
    path: "migrations/061_validate_and_activate_tenant_rls_pilot.sql",
    version: "061_validate_and_activate_tenant_rls_pilot",
  };
}

function recordingClient({ failOnText = null } = {}) {
  const calls = [];
  return {
    calls,
    async query(query, values) {
      const text = typeof query === "string" ? query : query.text;
      calls.push({ text, values: values ?? query.values ?? [] });
      if (text === failOnText) throw new Error("simulated migration 061 failure");
      return { rows: [] };
    },
  };
}

test("Recovery rehearsal uses the full dependency-safe plan and executes migration 061 last", () => {
  assert.deepEqual(recoveryMigrationPlan, [
    "057_bot_webhook_legacy_index_cutover",
    "060_tenant_rls_pilot_prepare",
    "062_private_media_contract_cutover",
    "065_notification_guard_search_path_hardening",
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
    "080_property_export_runtime",
    "081_broker_operations",
    "082_content_library_privacy",
    "083_list_productivity_controls",
    "084_media_deletion_lifecycle",
    "061_validate_and_activate_tenant_rls_pilot",
  ]);
  assert.equal(recoveryMigrationPlan.length, 22);
  assert.equal(recoveryMigrationPlan.at(-1), "061_validate_and_activate_tenant_rls_pilot");
  assert.ok(recoveryManualCutoverMigrations.includes("062_private_media_contract_cutover"));
  assert.ok(recoveryManualCutoverMigrations.includes("065_notification_guard_search_path_hardening"));
  assert.ok(recoveryManualCutoverMigrations.includes("084_media_deletion_lifecycle"));
  assert.match(source, /migration061Executed: records\.some/u);
  assert.match(source, /migration061FinalPlanPosition/u);
  assert.match(source, /schemaVersion: 2/u);
  assert.equal(recoveryMigrationPlanContract, "FULL_PRODUCTION_CHAIN_057_084_RLS_LAST_V2");
  assert.match(source, /migrationPlanContract: recoveryMigrationPlanContract/u);
  assert.match(source, /productionMutationPerformed: false/u);
});

test("Recovery rehearsal streams credentials and binds every apply to a fresh plan token", () => {
  assert.match(source, /readMigrationDatabaseUrlFromStdin/u);
  assert.match(source, /--connection-stdin/u);
  assert.match(source, /child\.stdin\.end\(`\$\{databaseUrl\}\\n`\)/u);
  assert.match(source, /delete childEnvironment\.MIGRATION_DATABASE_URL/u);
  assert.match(source, /dry-run[\s\S]*--plan-token-file/u);
  assert.match(source, /up[\s\S]*--plan-token-file/u);
  assert.match(source, /recoveryManualCutoverMigrations/u);
  assert.match(source, /flag: "wx"/u);
  assert.doesNotMatch(source, /console\.(?:log|error)\([^\n;]*databaseUrl/u);
});

test("Recovery rehearsal normalizes CRLF exactly like the committed migration checksum", () => {
  const lf = "select 1;\nselect 2;\n";
  const crlf = lf.replaceAll("\n", "\r\n");
  const expected = createHash("sha256").update(lf).digest("hex");
  assert.equal(recoveryMigrationChecksum(lf), expected);
  assert.equal(recoveryMigrationChecksum(crlf), expected);
});

test("Migration 061 provisions only the exact safe runtime roles immediately before apply", async () => {
  const migration = tenantCutoverMigration();
  const client = recordingClient();
  await applyTenantCutoverMigrationTransaction({
    candidateCommit,
    client,
    migration,
    prepareCutover: async () => client.query("select 'ledger-and-token-bound'"),
  });

  const texts = client.calls.map((call) => call.text);
  const prepareIndex = texts.indexOf("select 'ledger-and-token-bound'");
  const roleIndex = texts.findIndex((text) => text.includes("$novalure_role_preflight$"));
  const migrationIndex = texts.indexOf(migration.content);
  const ledgerIndex = texts.findIndex((text) => text.includes("insert into public.novalure_schema_migrations"));
  assert.equal(texts[0], "begin");
  assert.ok(prepareIndex > texts.indexOf("set local transaction_timeout = '15min'"));
  assert.ok(roleIndex > prepareIndex);
  assert.equal(migrationIndex, roleIndex + 1);
  assert.ok(ledgerIndex > migrationIndex);
  assert.equal(texts.at(-1), "commit");
  assert.ok(!texts.includes("rollback"));

  const roleSql = texts[roleIndex];
  assert.match(roleSql, /rolname = 'novalure_app'[\s\S]*rolcanlogin[\s\S]*rolinherit[\s\S]*not rolsuper/u);
  assert.match(roleSql, /rolname = 'novalure_tenant_app'[\s\S]*not rolcanlogin[\s\S]*not rolinherit/u);
  assert.match(roleSql, /membership\.member <> app_role_oid/u);
  assert.match(roleSql, /alter role novalure_tenant_app noinherit;/u);
  assert.match(roleSql, /grant novalure_tenant_app to novalure_app with inherit true;/u);
  assert.match(roleSql, /grant novalure_tenant_app to novalure_app with set false;/u);
  assert.match(roleSql, /revoke admin option for novalure_tenant_app from novalure_app;/u);
  assert.match(roleSql, /membership\.inherit_option[\s\S]*not membership\.set_option[\s\S]*not membership\.admin_option/u);
  assert.match(roleSql, new RegExp(`comment on role novalure_tenant_app is 'novalure-tenant-cutover:${candidateCommit}'`, "u"));
  assert.match(roleSql, /shobj_description\(tenant_role_oid, 'pg_authid'\) is distinct from/u);
  assert.doesNotMatch(roleSql, /\bcreate role\b/iu);

  const ledgerCall = client.calls[ledgerIndex];
  assert.deepEqual(ledgerCall.values, [migration.version, migration.name, migration.checksum]);
});

test("A migration 061 error rolls role membership and commit comment back with the migration", async () => {
  const migration = tenantCutoverMigration("select 'force-migration-061-failure'");
  const client = recordingClient({ failOnText: migration.content });
  await assert.rejects(
    applyTenantCutoverMigrationTransaction({ candidateCommit, client, migration }),
    /simulated migration 061 failure/u,
  );
  const texts = client.calls.map((call) => call.text);
  assert.ok(texts.some((text) => text.includes("comment on role novalure_tenant_app")));
  assert.equal(texts.at(-1), "rollback");
  assert.ok(!texts.includes("commit"));
  assert.ok(!texts.some((text) => text.includes("insert into public.novalure_schema_migrations")));
});

test("The commit-bound role comment rejects non-SHA input before opening a transaction", async () => {
  const client = recordingClient();
  await assert.rejects(
    applyTenantCutoverMigrationTransaction({
      candidateCommit: `${"a".repeat(39)}'`,
      client,
      migration: tenantCutoverMigration(),
    }),
    /exact lowercase Git SHA-1/u,
  );
  assert.deepEqual(client.calls, []);
});

test("The 061 special apply remains Recovery-only and consumes the dry-run token under the migration lock", () => {
  assert.match(source, /assertDatabaseTarget\([\s\S]*target: "recovery"/u);
  assert.match(source, /assertConnectedDatabaseTarget\([\s\S]*target: "recovery"/u);
  assert.match(source, /pg_try_advisory_lock/u);
  assert.match(source, /createMigrationPlanToken/u);
  assert.match(source, /consumeRecoveryPlanToken/u);
  assert.match(source, /version === tenantCutoverMigrationVersion[\s\S]*applyRecoveryTenantCutover/u);
  assert.match(source, /assertRepositoryCommitted\(\) !== candidateCommit/u);
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
