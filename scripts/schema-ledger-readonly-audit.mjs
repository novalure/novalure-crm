#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { neon } from "@neondatabase/serverless";

const manualCutovers = new Set([
  "057_bot_webhook_legacy_index_cutover",
  "060_tenant_rls_pilot_prepare",
  "061_validate_and_activate_tenant_rls_pilot",
  "062_private_media_contract_cutover",
  "065_notification_guard_search_path_hardening",
  "068_qa_batch_reset_safety",
]);

function clean(value) {
  return typeof value === "string" ? value.trim().replace(/^['"]|['"]$/g, "") : "";
}

function databaseUrl() {
  return clean(
    process.env.DATABASE_URL ||
      process.env.POSTGRES_URL ||
      process.env.POSTGRES_DATABASE_URL ||
      process.env.POSTGRES_PRISMA_URL,
  );
}

function checksum(content) {
  return createHash("sha256").update(content.replace(/\r\n/g, "\n")).digest("hex");
}

function readExpectedTables() {
  const schema = readFileSync(join(process.cwd(), "src/lib/db/schema.ts"), "utf8");
  const match = schema.match(/export const crmTables = \[([\s\S]*?)\] as const;/u);
  if (!match) throw new Error("crmTables inventory could not be parsed");
  return [...match[1].matchAll(/"([a-z0-9_]+)"/gu)].map((entry) => entry[1]);
}

function readMigrations() {
  return readdirSync(join(process.cwd(), "migrations"))
    .filter((file) => /^\d{3}_.+\.sql$/u.test(file) && !file.includes("_rollback"))
    .map((file) => {
      const version = file.replace(/\.sql$/u, "");
      return {
        checksum: checksum(readFileSync(join(process.cwd(), "migrations", file), "utf8")),
        manualCutover: manualCutovers.has(version),
        number: Number(file.slice(0, 3)),
        version,
      };
    })
    .sort((left, right) => left.number - right.number || left.version.localeCompare(right.version));
}

function reconcileLedger(migrations, ledgerRows) {
  const applied = new Set();
  const checksumMismatches = [];
  const ambiguousAliases = [];
  const ledgerOnly = [];

  for (const row of ledgerRows) {
    const exact = migrations.find((migration) => migration.version === row.version);
    if (exact) {
      applied.add(exact.version);
      if (!row.checksum || row.checksum !== exact.checksum) checksumMismatches.push(row.version);
      continue;
    }

    if (/^\d{3}$/u.test(row.version)) {
      const number = Number(row.version);
      const candidates = migrations.filter(
        (migration) => migration.number === number && migration.checksum === row.checksum,
      );
      if (candidates.length === 1) {
        applied.add(candidates[0].version);
      } else {
        ambiguousAliases.push(row.version);
      }
      continue;
    }

    ledgerOnly.push(row.version);
  }

  const baselineApplied = applied.has("041_schema_ledger_baseline");
  const pending = migrations.filter(
    (migration) =>
      migration.number >= 41 &&
      !migration.manualCutover &&
      !applied.has(migration.version),
  );
  const pendingManualCutovers = migrations.filter(
    (migration) => migration.manualCutover && !applied.has(migration.version),
  );

  return {
    ambiguousAliases,
    baselineApplied,
    checksumMismatches,
    ledgerOnly,
    pending: pending.map((migration) => migration.version),
    pendingManualCutovers: pendingManualCutovers.map((migration) => migration.version),
  };
}

const url = databaseUrl();
if (!url) throw new Error("Database URL is not available to the read-only audit");

const sql = neon(url);
const expectedTables = readExpectedTables();
const migrations = readMigrations();
const [tableRows, ledgerTableRows] = await Promise.all([
  sql.query(
    `
      select expected.table_name as "tableName", (actual.table_name is not null) as "exists"
      from unnest($1::text[]) as expected(table_name)
      left join information_schema.tables actual
        on actual.table_schema = 'public' and actual.table_name = expected.table_name
      order by expected.table_name
    `,
    [expectedTables],
  ),
  sql.query("select to_regclass('public.novalure_schema_migrations') is not null as \"exists\""),
]);

const ledgerExists = ledgerTableRows[0]?.exists === true;
const ledgerRows = ledgerExists
  ? await sql.query(
      `select version, checksum from public.novalure_schema_migrations order by version asc`,
    )
  : [];
const missingTables = tableRows.filter((row) => row.exists !== true).map((row) => row.tableName);
const reconciliation = reconcileLedger(migrations, ledgerRows);
const result = {
  expectedTableCount: expectedTables.length,
  ledger: {
    ...reconciliation,
    checksumRowCount: ledgerRows.filter((row) => Boolean(clean(row.checksum))).length,
    currentVersion: ledgerRows.at(-1)?.version ?? null,
    exists: ledgerExists,
    rowCount: ledgerRows.length,
  },
  migrationFileCount: migrations.length,
  missingTables,
  ok:
    ledgerExists &&
    missingTables.length === 0 &&
    reconciliation.baselineApplied &&
    reconciliation.ambiguousAliases.length === 0 &&
    reconciliation.checksumMismatches.length === 0 &&
    reconciliation.ledgerOnly.length === 0 &&
    reconciliation.pending.length === 0 &&
    reconciliation.pendingManualCutovers.length === 0,
};

console.log(JSON.stringify(result, null, 2));
if (!result.ok) process.exitCode = 2;
