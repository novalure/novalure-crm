import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { queryOne, queryRows } from "@/lib/db/client";

const baselineVersion = "041_schema_ledger_baseline";
const baselineNumber = 41;

type MigrationFile = { checksum: string; file: string; name: string; number: number; rollback: boolean; version: string };
type LedgerRow = { appliedAt: string | Date; checksum: string | null; name: string; version: string };

function migrationNumber(version: string) {
  return Number(version.slice(0, 3));
}

export function readMigrationManifest(): MigrationFile[] {
  const directory = join(process.cwd(), "migrations");
  return readdirSync(directory)
    .filter((file) => file.endsWith(".sql"))
    .map((file) => {
      const match = file.match(/^(\d{3})_(.+)\.sql$/);
      if (!match) throw new Error(`Invalid migration filename: ${file}`);
      const content = readFileSync(join(directory, file), "utf8").replace(/\r\n/g, "\n");
      const version = file.replace(/\.sql$/, "");
      return {
        checksum: createHash("sha256").update(content).digest("hex"),
        file: `migrations/${file}`,
        name: match[2],
        number: Number(match[1]),
        rollback: version.endsWith("_rollback"),
        version,
      };
    })
    .sort((left, right) => left.number - right.number || left.file.localeCompare(right.file));
}

export async function getMigrationLedgerStatus() {
  const files = readMigrationManifest();
  const ledgerTable = await queryOne<{ tableName: string | null }>(
    "select to_regclass('public.novalure_schema_migrations')::text as \"tableName\"",
  );
  if (!ledgerTable?.tableName) {
    return {
      checksumMismatches: [],
      collisions: [],
      files,
      ledgerExists: false,
      ledgerRows: [],
      pending: files.filter((file) => !file.rollback && file.number >= baselineNumber),
    };
  }

  const ledgerRows = await queryRows<LedgerRow>(
    `select version, name, checksum, applied_at as "appliedAt" from novalure_schema_migrations order by version`,
  );
  const byVersion = new Map(ledgerRows.map((row) => [row.version, row]));
  const baselineApplied = byVersion.has(baselineVersion);
  const runnable = files.filter((file) => !file.rollback);
  const pending = runnable.filter((file) => {
    if (byVersion.has(file.version)) return false;
    return file.number >= baselineNumber || !baselineApplied;
  });
  const checksumMismatches = runnable.flatMap((file) => {
    const ledger = byVersion.get(file.version);
    return ledger?.checksum && ledger.checksum !== file.checksum
      ? [{ actual: ledger.checksum, expected: file.checksum, version: file.version }]
      : [];
  });
  const collisions = ledgerRows.flatMap((ledger) => {
    const codeVersions = runnable
      .filter((file) => file.number === migrationNumber(ledger.version))
      .map((file) => file.version);
    return codeVersions.length && !codeVersions.includes(ledger.version)
      ? [{ codeVersions, ledgerVersion: ledger.version, number: migrationNumber(ledger.version) }]
      : [];
  });

  return { checksumMismatches, collisions, files, ledgerExists: true, ledgerRows, pending };
}
