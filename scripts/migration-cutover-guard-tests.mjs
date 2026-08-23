#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import {
  applyCommittedMigrationPlan,
  assertMigrationCommitted,
  createMigrationPlanToken,
  createMigrationPlan,
  readMigrationDatabaseUrlFromStdin,
  resolveMigrationLedgerState,
  validateMigrationPlan,
} from "./db-migrate.mjs";

const runner = await readFile(new URL("./db-migrate.mjs", import.meta.url), "utf8");
const workflow = await readFile(
  new URL("../.github/workflows/livegang-e2e.yml", import.meta.url),
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

function ledgerRow(version, checksum) {
  return {
    checksum,
    number: Number(version.slice(0, 3)),
    version,
  };
}

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
  assert.match(runner, /manualCutoverVersions = new Set\(\[/);
  assert.match(runner, /"057_bot_webhook_legacy_index_cutover"/);
  assert.match(runner, /"060_tenant_rls_pilot_prepare"/);
  assert.match(runner, /"061_validate_and_activate_tenant_rls_pilot"/);
  assert.match(runner, /"062_private_media_contract_cutover"/);
  assert.match(runner, /"065_notification_guard_search_path_hardening"/);
  assert.match(runner, /"068_qa_batch_reset_safety"/);
  assert.match(runner, /"078_company_profile_approval_integrity"/);
  assert.match(runner, /"079_public_funnel_visit_role_boundary"/);
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
  assert.match(runner, /if \(migration\.manualCutover\) return false/);
});

test("a manual cutover requires a single explicit version and opt-in flag", () => {
  assert.match(runner, /--allow-manual-cutover requires one explicit --only=<version>/);
  assert.match(runner, /migration\.manualCutover && !allowManualCutover/);
  assert.match(runner, /Refusing manual cutover migration/);
  assert.match(runner, /never included automatically/);
  assert.match(
    runner,
    /const nextPlan = plannedMigrations\(\{\s*allowManualCutover,\s*ledgerRows: nextLedger\.rows,\s*migrations,\s*only,\s*\}\)/,
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

test("QA migration CI previews before apply and keeps manual tenant cutovers excluded", () => {
  const previewIndex = workflow.indexOf("node scripts/db-migrate.mjs dry-run");
  const applyIndex = workflow.indexOf("node scripts/db-migrate.mjs up");
  assert.ok(previewIndex > 0, "QA CI must contain a read-only migration preview");
  assert.ok(applyIndex > previewIndex, "QA CI must preview the checksummed plan before applying it");
  assert.match(workflow, /dry-run --plan-token-file="\$MIGRATION_PLAN_TOKEN_FILE"/);
  assert.match(workflow, /up --plan-token-file="\$MIGRATION_PLAN_TOKEN_FILE"/);
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
  assert.doesNotMatch(workflow, /--allow-manual-cutover/);
});

test("QA secrets are step-scoped behind install and all third-party actions are SHA pinned", () => {
  const qaJob = workflow.slice(workflow.indexOf("  qa-e2e:"));
  const jobEnv = qaJob.match(/\n    env:\n([\s\S]*?)\n    steps:/)?.[1] ?? "";
  assert.doesNotMatch(jobEnv, /secrets\./);
  assert.match(qaJob, /environment: novalure-qa/);
  assert.ok(
    qaJob.indexOf("Install dependencies from lockfile") < qaJob.indexOf("secrets.NOVALURE_QA_DATABASE_URL"),
    "QA secrets must not be exposed to checkout, setup, or npm lifecycle scripts",
  );

  const actionReferences = [...workflow.matchAll(/uses:\s+([^\s#]+)/g)].map((match) => match[1]);
  assert.ok(actionReferences.length >= 7);
  for (const reference of actionReferences) {
    assert.match(reference, /@[0-9a-f]{40}$/, `${reference} must use a full commit SHA`);
  }
});
