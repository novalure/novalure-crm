#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createMigrationPlan } from "./db-migrate.mjs";

const [migration, validationMigration, schema, qaResetContract] = await Promise.all([
  readFile(new URL("../migrations/073_launch_tenant_relation_guards.sql", import.meta.url), "utf8"),
  readFile(new URL("../migrations/074_validate_launch_tenant_relation_guards.sql", import.meta.url), "utf8"),
  readFile(new URL("../src/lib/db/schema.ts", import.meta.url), "utf8"),
  readFile(new URL("../src/lib/qa-reset-contract.ts", import.meta.url), "utf8"),
]);

function migrationItem(version, checksum, manualCutover = false) {
  return {
    checksum,
    file: `${version}.sql`,
    manualCutover,
    number: Number(version.slice(0, 3)),
    rollback: false,
    version,
  };
}

function ledgerRow(version, checksum) {
  return {
    checksum,
    number: Number(version.slice(0, 3)),
    version,
  };
}

const relations = Object.freeze([
  ["funnels", "project", "projects", "project_id"],
  ["funnels", "owner", "workspace_users", "owner_user_id"],
  ["funnel_steps", "project", "projects", "project_id"],
  ["funnel_steps", "funnel", "funnels", "funnel_id"],
  ["funnel_steps", "bot", "bots", "bot_rule_id"],
  ["property_inquiries", "project", "projects", "project_id"],
  ["property_inquiries", "property", "seller_listings", "property_id"],
  ["property_inquiries", "unit", "property_units", "unit_id"],
  ["property_inquiries", "contact", "contacts", "contact_id"],
  ["property_inquiries", "lead", "leads", "lead_id"],
  ["property_inquiries", "funnel", "funnels", "funnel_id"],
  ["property_inquiries", "form", "forms", "form_id"],
  ["property_inquiries", "owner", "workspace_users", "owner_user_id"],
  ["property_activity_events", "project", "projects", "project_id"],
  ["property_activity_events", "property", "seller_listings", "property_id"],
  ["property_activity_events", "unit", "property_units", "unit_id"],
  ["property_activity_events", "contact", "contacts", "contact_id"],
  ["property_activity_events", "lead", "leads", "lead_id"],
  ["property_activity_events", "actor", "workspace_users", "actor_user_id"],
]);

test("migration 073 adds every semantically available tenant-qualified relation", () => {
  for (const [table, relation, parent, column] of relations) {
    assert.match(migration, new RegExp(`${table}_workspace_${relation}_fk`));
    assert.match(
      migration,
      new RegExp(
        `foreign key \\(workspace_id, ${column}\\) references public\\.${parent}\\(workspace_id, id\\)[^']*deferrable initially deferred not valid`,
        "i",
      ),
    );
  }

  assert.equal(
    (migration.match(/deferrable initially deferred not valid/gi) ?? []).length,
    relations.length,
  );
  assert.match(
    migration,
    /funnel_steps_workspace_bot_fk[\s\S]*on delete set null \(bot_rule_id\)[\s\S]*deferrable initially deferred not valid/i,
  );
});

test("migration 073 creates only primary-key-compatible unique targets", () => {
  for (const table of ["bots", "seller_listings", "property_units"]) {
    assert.match(
      migration,
      new RegExp(
        `create unique index if not exists ${table}_workspace_id_id_uidx\\s+on public\\.${table}\\(workspace_id, id\\)`,
        "i",
      ),
    );
  }

  assert.equal((migration.match(/create unique index/gi) ?? []).length, 3);
  assert.doesNotMatch(migration, /create unique index[\s\S]{0,160}\b(email|slug|unit_number|duplicate_group_key)\b/i);
});

test("migration 073 is additive, idempotent, and leaves legacy validation to a preflight", () => {
  assert.match(migration, /migration 072_form_submission_atomicity is required before 073/);
  assert.equal((migration.match(/if not exists \(/gi) ?? []).length, 2);
  assert.match(migration, /pg_catalog\.pg_constraint/);
  assert.doesNotMatch(migration, /alter table[^;]+validate constraint/i);
  assert.doesNotMatch(migration, /\b(delete from|update public\.|drop table|drop column|truncate)\b/i);
});

test("migration 073 child relations retain workspace-leading indexes and inventories", () => {
  for (const index of [
    "funnels_workspace_project_guard_idx",
    "funnels_workspace_owner_guard_idx",
    "funnel_steps_workspace_project_guard_idx",
    "funnel_steps_workspace_funnel_guard_idx",
    "funnel_steps_workspace_bot_guard_idx",
    "property_inquiries_workspace_property_guard_idx",
    "property_inquiries_workspace_unit_guard_idx",
    "property_inquiries_workspace_contact_guard_idx",
    "property_inquiries_workspace_lead_guard_idx",
    "property_inquiries_workspace_funnel_guard_idx",
    "property_inquiries_workspace_form_guard_idx",
    "property_inquiries_workspace_owner_guard_idx",
    "property_activity_workspace_project_guard_idx",
    "property_activity_workspace_unit_guard_idx",
    "property_activity_workspace_contact_guard_idx",
    "property_activity_workspace_lead_guard_idx",
    "property_activity_workspace_actor_guard_idx",
  ]) {
    assert.match(migration, new RegExp(`create index if not exists ${index}`));
  }

  assert.match(migration, /property_inquiries_workspace_route_idx already covers/);
  assert.match(migration, /property_activity_workspace_entity_idx already covers/);
  for (const table of ["funnels", "funnel_steps", "property_inquiries", "property_activity_events"]) {
    assert.match(schema, new RegExp(`"${table}"`));
    assert.match(qaResetContract, new RegExp(`"${table}"`));
  }
});

test("migration 074 preflights and validates every 073 tenant relation", () => {
  assert.match(validationMigration, /migration 073_launch_tenant_relation_guards is required before 074/);
  assert.match(validationMigration, /left join public\.%I parent/);
  assert.match(validationMigration, /parent\.workspace_id = child\.workspace_id and parent\.id = child\.%I/);
  assert.match(validationMigration, /tenant relation preflight failed/);
  assert.equal(
    (validationMigration.match(/alter table public\.[a-z_]+ validate constraint [a-z_]+;/gi) ?? []).length,
    relations.length,
  );
  for (const [table, relation] of relations) {
    const constraint = `${table}_workspace_${relation}_fk`;
    assert.match(validationMigration, new RegExp(`validate constraint ${constraint}`));
  }
  assert.match(validationMigration, /validated_count <> 19/);
  assert.doesNotMatch(validationMigration, /\b(delete from|update public\.|drop table|drop column|truncate)\b/i);
});

test("migration planner refuses 073 without its checksummed 072 predecessor", () => {
  const oauthIntegrity = migrationItem("053_oauth_state_integrity", "sha-053");
  const abuseGuards = migrationItem("055_public_submission_abuse_guards", "sha-055");
  const oauthWorkspaceGuard = migrationItem("066_oauth_state_workspace_user_guard", "sha-066");
  const funnelRecovery = migrationItem("070_funnel_submission_idempotency_recovery", "sha-070");
  const formOwnerGuard = migrationItem("071_forms_owner_tenant_guard", "sha-071");
  const formAtomicity = migrationItem("072_form_submission_atomicity", "sha-072");
  const tenantRelations = migrationItem("073_launch_tenant_relation_guards", "sha-073");
  const migrations = [
    oauthIntegrity,
    abuseGuards,
    oauthWorkspaceGuard,
    funnelRecovery,
    formOwnerGuard,
    formAtomicity,
    tenantRelations,
  ];
  const predecessorLedger = [
    oauthIntegrity,
    abuseGuards,
    oauthWorkspaceGuard,
    funnelRecovery,
    formOwnerGuard,
  ].map(({ version, checksum }) => ledgerRow(version, checksum));

  assert.throws(
    () => createMigrationPlan({
      ledgerRows: predecessorLedger,
      migrations,
      only: tenantRelations.version,
    }),
    /required predecessor 072_form_submission_atomicity/,
  );
  assert.throws(
    () => createMigrationPlan({
      ledgerRows: [
        ...predecessorLedger,
        ledgerRow(formAtomicity.version, null),
      ],
      migrations,
      only: tenantRelations.version,
    }),
    /required predecessor 072_form_submission_atomicity is not checksummed in the ledger/,
  );
  assert.deepEqual(
    createMigrationPlan({
      ledgerRows: [
        ...predecessorLedger,
        ledgerRow(formAtomicity.version, formAtomicity.checksum),
      ],
      migrations,
      only: tenantRelations.version,
    }),
    [tenantRelations],
  );

  assert.deepEqual(
    createMigrationPlan({
      ledgerRows: predecessorLedger,
      migrations,
      only: "",
    }),
    [formAtomicity, tenantRelations],
  );
  assert.throws(
    () => createMigrationPlan({
      ledgerRows: predecessorLedger,
      migrations: [...migrations.slice(0, -2), tenantRelations, formAtomicity],
      only: "",
    }),
    /required predecessor 072_form_submission_atomicity is neither checksummed in the ledger nor ordered earlier in this plan/,
  );
});

test("migration planner treats 074 validation as an explicit cutover after checksummed 073", () => {
  const oauthIntegrity = migrationItem("053_oauth_state_integrity", "sha-053");
  const abuseGuards = migrationItem("055_public_submission_abuse_guards", "sha-055");
  const oauthWorkspaceGuard = migrationItem("066_oauth_state_workspace_user_guard", "sha-066");
  const funnelRecovery = migrationItem("070_funnel_submission_idempotency_recovery", "sha-070");
  const formOwnerGuard = migrationItem("071_forms_owner_tenant_guard", "sha-071");
  const formAtomicity = migrationItem("072_form_submission_atomicity", "sha-072");
  const tenantRelations = migrationItem("073_launch_tenant_relation_guards", "sha-073");
  const validation = migrationItem("074_validate_launch_tenant_relation_guards", "sha-074", true);
  const migrations = [
    oauthIntegrity,
    abuseGuards,
    oauthWorkspaceGuard,
    funnelRecovery,
    formOwnerGuard,
    formAtomicity,
    tenantRelations,
    validation,
  ];
  const through072 = migrations
    .filter((migration) => migration.number <= 72)
    .map(({ version, checksum }) => ledgerRow(version, checksum));

  assert.throws(
    () => createMigrationPlan({
      allowManualCutover: true,
      ledgerRows: through072,
      migrations,
      only: validation.version,
    }),
    /required predecessor 073_launch_tenant_relation_guards/,
  );
  assert.throws(
    () => createMigrationPlan({
      allowManualCutover: true,
      ledgerRows: [...through072, ledgerRow(tenantRelations.version, "")],
      migrations,
      only: validation.version,
    }),
    /required predecessor 073_launch_tenant_relation_guards is not checksummed in the ledger/,
  );
  assert.deepEqual(
    createMigrationPlan({
      allowManualCutover: true,
      ledgerRows: [...through072, ledgerRow(tenantRelations.version, tenantRelations.checksum)],
      migrations,
      only: validation.version,
    }),
    [validation],
  );
  assert.throws(
    () => createMigrationPlan({
      allowManualCutover: false,
      ledgerRows: [...through072, ledgerRow(tenantRelations.version, tenantRelations.checksum)],
      migrations,
      only: validation.version,
    }),
    /manual cutover/i,
  );
});
