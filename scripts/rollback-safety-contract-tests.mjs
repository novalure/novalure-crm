import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { splitPostgresStatements } from "./lib/postgres-statement-splitter.mjs";
import { createMigrationPlan, validateMigrationTargetPolicy } from "./db-migrate.mjs";

const cases = [
  {
    destructive: "drop policy if exists property_channels_runtime_tenant_policy",
    file: "migrations/080_property_export_runtime_rollback.sql",
    version: "080_property_export_runtime",
  },
  {
    destructive: "drop trigger if exists crm_content_links_validate_target",
    file: "migrations/082_content_library_privacy_rollback.sql",
    version: "082_content_library_privacy",
  },
  {
    destructive: "drop table if exists public.crm_bulk_runtime_batch_items",
    file: "migrations/083_list_productivity_controls_rollback.sql",
    version: "083_list_productivity_controls",
  },
  {
    destructive: "drop trigger if exists crm_content_document_versions_active_media",
    file: "migrations/084_media_deletion_lifecycle_rollback.sql",
    version: "084_media_deletion_lifecycle",
  },
];

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const readBytes = (path) => readFile(new URL(`../${path}`, import.meta.url));
const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));

function canonicalGitCleanBytes(bytes, label) {
  const decoded = bytes.toString("utf8");
  assert.deepEqual(Buffer.from(decoded, "utf8"), bytes, `${label} must be valid UTF-8`);
  const normalized = decoded.replace(/\r\n/gu, "\n");
  assert.doesNotMatch(normalized, /\r/u, `${label} contains an unsupported bare CR byte`);
  return Buffer.from(normalized, "utf8");
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

test("migration inventory binds exactly 080-084 to canonical Git-clean bytes", async () => {
  const inventoryPath = "docs/audit/2026-09-02/justimmo-inspired-migration-checksums.json";
  const expectedPaths = [
    "migrations/080_property_export_runtime.sql",
    "migrations/080_property_export_runtime_rollback.sql",
    "migrations/081_broker_operations.sql",
    "migrations/081_broker_operations_rollback.sql",
    "migrations/082_content_library_privacy.sql",
    "migrations/082_content_library_privacy_rollback.sql",
    "migrations/083_list_productivity_controls.sql",
    "migrations/083_list_productivity_controls_rollback.sql",
    "migrations/084_media_deletion_lifecycle.sql",
    "migrations/084_media_deletion_lifecycle_rollback.sql",
  ];
  const attributes = await read(".gitattributes");
  assert.match(attributes, /^\*\.sql text eol=lf$/mu);
  assert.match(attributes, /^migrations\/\*\.sql text eol=lf$/mu);

  const inventoryBytes = canonicalGitCleanBytes(await readBytes(inventoryPath), inventoryPath);
  const inventory = JSON.parse(inventoryBytes.toString("utf8"));
  assert.deepEqual(inventory.files.map((entry) => entry.path), expectedPaths);
  assert.equal(inventory.byteContract.mode, "GIT_CLEAN_FILTERED_BYTES");
  assert.equal(inventory.candidateCommit, null);
  assert.equal(inventory.migrationByteFreeze, "FROZEN_PENDING_IMPLEMENTATION_COMMIT");
  assert.deepEqual(inventory.executionBoundary, {
    databaseExecution: "NOT_RUN",
    previewDatabaseValidation: "NOT_RUN",
    productionMutationPerformed: false,
    signed: false,
  });

  for (const entry of inventory.files) {
    const bytes = canonicalGitCleanBytes(await readBytes(entry.path), entry.path);
    assert.equal(entry.byteLength, bytes.byteLength, `${entry.path} byte length drifted`);
    assert.equal(entry.sha256, sha256(bytes), `${entry.path} SHA-256 drifted`);

    const filteredOid = execFileSync(
      "git",
      ["hash-object", `--path=${entry.path}`, entry.path],
      { cwd: repositoryRoot, encoding: "utf8" },
    ).trim();
    const canonicalOid = execFileSync(
      "git",
      ["hash-object", "--no-filters", "--stdin"],
      { cwd: repositoryRoot, encoding: "utf8", input: bytes },
    ).trim();
    assert.equal(filteredOid, canonicalOid, `${entry.path} does not match its Git clean filter`);
    assert.equal(entry.gitBlobOidSha1, canonicalOid, `${entry.path} Git object ID drifted`);
  }

  const expectedInventoryDigest = sha256(inventoryBytes);
  const sidecar = (await read(`${inventoryPath}.sha256`)).trim();
  assert.equal(sidecar, `${expectedInventoryDigest}  justimmo-inspired-migration-checksums.json`);
});

test("080-084 require one explicit manual Preview/Recovery cutover and refuse prod", async () => {
  const runner = await read("scripts/db-migrate.mjs");
  const rehearsal = await read("scripts/recovery-migration-rehearsal.mjs");
  for (const version of cases.map((item) => item.version).concat("081_broker_operations")) {
    assert.match(runner, new RegExp(`"${version}"`));
    assert.match(rehearsal, new RegExp(`"${version}"`));
  }
  assert.match(runner, /\.\.\.isolatedPreviewOnlyMigrationVersions/);
  const migration = {
    checksum: "a".repeat(64),
    file: "080_property_export_runtime.sql",
    manualCutover: true,
    name: "property export runtime",
    number: 80,
    path: "migrations/080_property_export_runtime.sql",
    rollback: false,
    version: "080_property_export_runtime",
  };
  assert.deepEqual(createMigrationPlan({ ledgerRows: [], migrations: [migration], only: "" }), []);
  assert.throws(
    () => validateMigrationTargetPolicy({ migrations: [migration], only: migration.version, targetName: "prod" }),
    /Refusing Preview-only migration 080_property_export_runtime on prod/,
  );
  assert.doesNotThrow(
    () => validateMigrationTargetPolicy({ migrations: [migration], only: migration.version, targetName: "test" }),
  );
});

test("081 rollback is atomic, doubly armed, RLS-independent and ledger-consistent", async () => {
  const sql = await read("migrations/081_broker_operations_rollback.sql");
  const normalized = sql.toLowerCase();
  const statements = splitPostgresStatements(sql);

  assert.match(statements[0], /\bbegin\s*$/i);
  assert.match(statements.at(-1), /^\s*commit\s*$/i);
  assert.match(sql, /current_setting\('novalure\.environment', true\) is distinct from 'preview'/i);
  assert.match(sql, /current_setting\('novalure\.allow_qa_schema_rollback', true\) is distinct from 'true'/i);
  assert.match(sql, /set local row_security = off/i);
  assert.match(sql, /broker_commission_splits[\s\S]*still contains operational data/i);
  assert.match(sql, /buyer_search_profiles contains Broker Operations data/i);
  assert.match(sql, /property_viewing_slots contains Broker Operations data/i);
  assert.match(sql, /contact_timeline_items contains Broker Operations data/i);
  assert.match(sql, /tasks contains Broker Operations relations/i);
  const ledgerStart = normalized.lastIndexOf("do $rollback_ledger$");
  assert.ok(ledgerStart > normalized.lastIndexOf("\ndrop "));
  assert.ok(ledgerStart > normalized.lastIndexOf("\nalter table"));
  assert.match(sql, /using '081_broker_operations'/i);
  assert.ok(normalized.lastIndexOf("commit;") > ledgerStart);
  assert.doesNotMatch(sql, /\bcascade\b/i);
});

test("080/082/083/084 rollbacks are atomic, doubly armed and ledger-consistent", async () => {
  for (const rollbackCase of cases) {
    const sql = await read(rollbackCase.file);
    const normalized = sql.toLowerCase();
    const statements = splitPostgresStatements(sql);

    assert.match(statements[0], /\bbegin\s*$/i, `${rollbackCase.file} must start atomically`);
    assert.match(statements.at(-1), /^\s*commit\s*$/i, `${rollbackCase.file} must commit explicitly`);
    assert.match(sql, /current_setting\('novalure\.environment', true\) is distinct from 'preview'/i);
    assert.match(sql, /current_setting\('novalure\.allow_qa_schema_rollback', true\) is distinct from 'true'/i);
    assert.match(sql, /set local row_security = off/i);

    const guardEnd = normalized.indexOf("$rollback_guard$;");
    const firstDestructive = normalized.indexOf(rollbackCase.destructive);
    assert.ok(guardEnd >= 0 && firstDestructive > guardEnd,
      `${rollbackCase.file} must finish all guards before destructive DDL`);

    const ledgerStart = normalized.lastIndexOf("do $rollback_ledger$");
    const lastDrop = normalized.lastIndexOf("\ndrop ");
    const lastAlter = normalized.lastIndexOf("\nalter table");
    assert.ok(ledgerStart > lastDrop && ledgerStart > lastAlter,
      `${rollbackCase.file} must clean the ledger after its final schema action`);
    assert.match(sql, /delete from public\.novalure_schema_migrations where version = \$1/i);
    assert.match(sql, new RegExp(`using '${rollbackCase.version}'`, "i"));
    assert.ok(normalized.lastIndexOf("commit;") > ledgerStart);
    assert.doesNotMatch(sql, /\bcascade\b/i);
  }
});

test("rollback data guards cover durable evidence before it can be dropped", async () => {
  const exportRollback = await read(cases[0].file);
  assert.match(exportRollback, /relrowsecurity[\s\S]*not exists[\s\S]*_runtime_tenant_policy/i);
  assert.match(exportRollback, /property_export_job_events still contains lifecycle evidence/i);
  assert.match(exportRollback, /property_channels contains 080 runtime keys/i);
  assert.match(exportRollback, /property_export_jobs contains 080 runtime evidence/i);

  const contentRollback = await read(cases[1].file);
  for (const table of [
    "crm_safe_mutation_requests",
    "crm_content_documents",
    "crm_content_document_versions",
    "crm_content_links",
    "crm_communication_templates",
    "crm_communication_template_versions",
    "privacy_retention_policies",
    "privacy_retention_reviews",
    "privacy_legal_holds",
    "privacy_data_subject_requests",
  ]) assert.match(contentRollback, new RegExp(`'${table}'`, "i"));
  assert.match(contentRollback, /still contains tenant or release evidence/i);

  const listRollback = await read(cases[2].file);
  assert.match(listRollback, /relrowsecurity[\s\S]*not exists[\s\S]*crm_bulk_runtime_batches_runtime_policy/i);
  assert.match(listRollback, /crm_saved_views/);
  assert.match(listRollback, /crm_recent_records/);
  assert.match(listRollback, /crm_bulk_runtime_batch_items/);
  assert.match(listRollback, /contains actor-bound or non-legacy evidence/i);

  const mediaRollback = await read(cases[3].file);
  const pendingCheck = mediaRollback.indexOf("where deletion_state = 'pending'");
  const columnDrop = mediaRollback.indexOf("drop column if exists deletion_state");
  assert.ok(pendingCheck >= 0 && columnDrop > pendingCheck);
  assert.match(mediaRollback, /pending or non-canonical media deletion evidence requires reconciliation/i);
  assert.match(mediaRollback, /where created_by_user_id is not null[\s\S]*media creator attribution requires reconciliation/i);
  assert.ok(mediaRollback.indexOf("drop column if exists created_by_user_id") > mediaRollback.indexOf("where created_by_user_id is not null"));
});

test("rollback dependency guards detect later relations, views, policies and triggers", async () => {
  for (const rollbackCase of cases.slice(0, 3)) {
    const sql = await read(rollbackCase.file);
    assert.match(sql, /pg_catalog\.pg_constraint/i);
    assert.match(sql, /pg_catalog\.pg_depend/i);
    assert.match(sql, /pg_catalog\.pg_trigger/i);
    assert.match(sql, /pg_catalog\.pg_policies/i);
    assert.match(sql, /unexpected later|later object|external relation|view %s depends/i);
  }

  const contentRollback = await read(cases[1].file);
  assert.doesNotMatch(
    contentRollback.slice(0, contentRollback.indexOf("$rollback_guard$;")),
    /crm_content_document_versions_active_media[\s\S]*not in/i,
  );

  const mediaRollback = await read(cases[3].file);
  assert.match(mediaRollback, /pg_catalog\.pg_depend/i);
  assert.match(mediaRollback, /pg_catalog\.pg_describe_object/i);
  assert.match(mediaRollback, /later trigger %s depends on the active-media function/i);
  assert.match(mediaRollback, /later object %s depends on deletion lifecycle columns/i);
  assert.match(mediaRollback, /'created_by_user_id'/i);
});
