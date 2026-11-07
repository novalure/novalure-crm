import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  assertMigrationCommitted,
  createMigrationPlan,
  validateMigrationPlan,
} from "../db-migrate.mjs";

/** Full current application frontier on the existing private disposable fixture only. */
export async function applyDesignCCurrentApplicationSchema({ owner, applied, directory }) {
  assert(owner.options.host === "127.0.0.1" && owner.options.database === "neondb");
  assert(path.resolve(directory).startsWith(path.resolve(".npm-cache/qa") + path.sep));
  const manifestBytes = await readFile(new URL("../fixtures/design-c-current-application-schema.json", import.meta.url));
  const manifest = JSON.parse(manifestBytes);
  assert(manifest.schema === "crm.design-c-current-application-original-schema/v1" && manifest.migrations.length === 124);
  const migrations = await Promise.all(manifest.migrations.map(async row => {
    assert(/^\d{3}_[a-z0-9_]+\.sql$/.test(row.file) && !row.file.endsWith("_rollback.sql"));
    const bytes = await readFile(path.resolve("migrations", row.file));
    assert(createHash("sha256").update(bytes).digest("hex") === row.sha256, `Original source changed: ${row.file}`);
    const migration = { ...row, path: `migrations/${row.file}`, content: bytes.toString("utf8"), checksum: row.sha256,
      number: Number(row.version.slice(0, 3)), rollback: false };
    assertMigrationCommitted({ migration });
    return migration;
  }));
  const client = await owner.connect();
  const readLedger = async () => (await client.query("select version,name,checksum from public.novalure_schema_migrations order by version")).rows
    .map(row => ({ ...row, number: Number(row.version.slice(0, 3)) }));
  const added = [];
  try {
    const identity = (await client.query("select current_database() as database,current_user as actor,rolsuper,rolbypassrls from pg_roles where rolname=current_user")).rows[0];
    assert(identity.database === "neondb" && identity.actor === "neondb_owner" && !identity.rolsuper && identity.rolbypassrls);
    for (const migration of migrations) {
      const ledgerRows = await readLedger();
      const plan = createMigrationPlan({ allowManualCutover: true, ledgerRows, migrations, only: migration.version });
      validateMigrationPlan({ ledgerRows, migrations, plan });
      if (!plan.length) continue;
      assert(plan.length === 1 && plan[0].version === migration.version);
      await client.query("begin");
      try {
        // Byte-identical original SQL, including its actual policies and guards.
        await client.query(migration.content);
        await client.query("insert into public.novalure_schema_migrations(version,name,checksum) values($1,$2,$3)",
          [migration.version, migration.name, migration.checksum]);
        await client.query("commit");
      } catch (error) {
        await client.query("rollback");
        throw new Error(`Current application original migration ${migration.file} failed`, { cause: error });
      }
      applied.push(migration.file); added.push(migration.version);
    }
    const ledger = await readLedger();
    assert(ledger.length === migrations.length && migrations.every(m => ledger.some(r => r.version === m.version && r.checksum === m.checksum)), "Complete124 application ledger required");
    return { schema: manifest.schema, manifestSha256: createHash("sha256").update(manifestBytes).digest("hex"),
      ledgerVersions: ledger.length, added, originalSqlUnmodified: true, productionAcceptance: false };
  } finally { client.release(); }
}
