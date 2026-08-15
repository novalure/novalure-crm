#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { Pool } from "@neondatabase/serverless";

const targets = {
  test: {
    envFile: ".env.local",
    hostPrefix: "ep-morning-fog-al1enszq",
    suffix: "98273025",
  },
  prod: {
    envFile: ".env.production.local",
    hostPrefix: "ep-wandering-union-alem0781",
    suffix: "70835427",
  },
};

const baselineVersion = "041_schema_ledger_baseline";
const baselineNumber = 41;
const ledgerTable = "novalure_schema_migrations";
const lockKey = 941041;
const validCommands = new Set(["status", "dry-run", "up"]);

function fail(message) {
  console.error(`[ERROR] ${message}`);
  process.exit(1);
}

function loadEnvFile(path) {
  if (!existsSync(path)) return;

  for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const index = line.indexOf("=");
    const key = line.slice(0, index).trim();
    let value = line.slice(index + 1).trim();
    value = value.replace(/^['"]|['"]$/g, "");
    if (!process.env[key]) process.env[key] = value;
  }
}

function cleanDatabaseUrl(value) {
  if (!value) return "";

  const trimmed = value.trim().replace(/^['"]|['"]$/g, "");
  const prefixedUrl = trimmed.match(/^[A-Z0-9_]+=((?:postgres|postgresql):\/\/.+)$/i);

  return prefixedUrl?.[1] ?? trimmed;
}

function maskDatabaseUrl(value) {
  return value
    .replace(/:\/\/[^:@/]+:([^@/]+)@/, "://***:***@")
    .replace(/(project|database|dbname)=([^&\s]+)/gi, "$1=***");
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const command = args.find((arg) => !arg.startsWith("--"));
  const onlyArg = args.find((arg) => arg.startsWith("--only="));

  if (!command || !validCommands.has(command)) {
    fail(`Command required: ${[...validCommands].join("|")}`);
  }

  return {
    command,
    only: onlyArg ? onlyArg.slice("--only=".length).trim() : "",
  };
}

function resolveTarget() {
  const targetName = process.env.MIGRATION_TARGET;
  if (!targetName || !(targetName in targets)) {
    fail("MIGRATION_TARGET must be explicitly set to 'test' or 'prod'");
  }

  const target = targets[targetName];
  loadEnvFile(join(process.cwd(), target.envFile));

  const databaseUrl =
    cleanDatabaseUrl(process.env.DATABASE_URL) ||
    cleanDatabaseUrl(process.env.POSTGRES_URL) ||
    cleanDatabaseUrl(process.env.POSTGRES_DATABASE_URL) ||
    cleanDatabaseUrl(process.env.POSTGRES_PRISMA_URL);

  if (!databaseUrl) fail("DATABASE_URL/POSTGRES_URL is missing");

  const parsed = new URL(databaseUrl);
  const projectId = process.env.POSTGRES_NEON_PROJECT_ID || process.env.NEON_PROJECT_ID || "";

  console.log(`Active DATABASE_URL: ${maskDatabaseUrl(databaseUrl)}`);
  console.log(`Active DB host: ${parsed.hostname}`);
  console.log(`Active target: ${targetName}`);
  console.log(`Project ID suffix verified: ${projectId ? "***" + projectId.slice(-8) : "missing"}`);
  console.log(`Expected DB suffix: ${target.suffix}`);

  if (!parsed.hostname.startsWith(target.hostPrefix)) {
    fail(`Refusing to continue: active DB host is not ${targetName} (${target.hostPrefix})`);
  }

  if (targetName === "test" && parsed.hostname.startsWith(targets.prod.hostPrefix)) {
    fail("Refusing to continue: test target points at the Prod DB host");
  }

  if (!projectId.endsWith(target.suffix)) {
    fail(`Refusing to continue: active project id does not end with expected suffix ${target.suffix}`);
  }

  return { databaseUrl, name: targetName };
}

function normalizeSqlContent(content) {
  return content.replace(/\r\n/g, "\n");
}

function checksum(content) {
  return createHash("sha256").update(normalizeSqlContent(content)).digest("hex");
}

function assertMigrationFileTracked(gitPath) {
  try {
    execFileSync("git", ["ls-files", "--error-unmatch", gitPath], { stdio: "ignore" });
  } catch {
    fail(`Refusing migration file that is not tracked by git: ${gitPath}`);
  }
}

function readMigrations() {
  const migrationsDir = join(process.cwd(), "migrations");

  return readdirSync(migrationsDir)
    .filter((file) => file.endsWith(".sql"))
    .map((file) => {
      const match = file.match(/^(\d{3})_(.+)\.sql$/);
      if (!match) fail(`Invalid migration filename: ${file}`);

      const version = file.replace(/\.sql$/, "");
      const content = readFileSync(join(migrationsDir, file), "utf8");
      const gitPath = `migrations/${file}`;
      assertMigrationFileTracked(gitPath);

      return {
        content,
        checksum: checksum(content),
        file,
        name: match[2],
        number: Number(match[1]),
        path: gitPath,
        rollback: version.endsWith("_rollback"),
        version,
      };
    })
    .sort((left, right) => left.number - right.number || left.file.localeCompare(right.file));
}

async function ledgerExists(client) {
  const result = await client.query(
    `
    select to_regclass($1) as "tableName"
  `,
    [ledgerTable],
  );
  return Boolean(result.rows[0]?.tableName);
}

async function readLedger(client) {
  if (!(await ledgerExists(client))) return { exists: false, rows: [] };

  const result = await client.query(
    `
    select version, name, checksum, applied_at as "appliedAt"
    from novalure_schema_migrations
    order by version asc
  `,
  );

  return {
    exists: true,
    rows: result.rows.map((row) => ({
      appliedAt: row.appliedAt,
      checksum: row.checksum,
      name: row.name,
      number: Number(String(row.version).slice(0, 3)),
      version: row.version,
    })),
  };
}

function byVersion(rows) {
  return new Map(rows.map((row) => [row.version, row]));
}

function numberCollisions(ledgerRows, migrations) {
  const migrationsByNumber = new Map();
  for (const migration of migrations) {
    if (migration.rollback) continue;
    if (!migrationsByNumber.has(migration.number)) migrationsByNumber.set(migration.number, []);
    migrationsByNumber.get(migration.number).push(migration.version);
  }

  return ledgerRows.flatMap((row) => {
    const codeVersions = migrationsByNumber.get(row.number) ?? [];
    if (!codeVersions.length || codeVersions.includes(row.version)) return [];
    return [{ ledger: row.version, number: row.number, codeVersions }];
  });
}

function plannedMigrations({ ledgerRows, migrations, only }) {
  const ledgerByVersion = byVersion(ledgerRows);
  const hasBaseline = ledgerByVersion.has(baselineVersion);
  const runnable = migrations.filter((migration) => !migration.rollback);

  if (only) {
    const migration = runnable.find((candidate) => candidate.version === only || candidate.file === only);
    if (!migration) fail(`--only migration not found: ${only}`);
    return ledgerByVersion.has(migration.version) ? [] : [migration];
  }

  return runnable.filter((migration) => {
    if (ledgerByVersion.has(migration.version)) return false;
    if (hasBaseline && migration.number < baselineNumber) return false;
    if (!hasBaseline && migration.number < baselineNumber) return false;
    return true;
  });
}

function assertChecksumSafety({ ledgerRows, migrations, plan }) {
  const ledgerByVersion = byVersion(ledgerRows);

  for (const migration of migrations) {
    const ledgerRow = ledgerByVersion.get(migration.version);
    if (ledgerRow?.checksum && ledgerRow.checksum !== migration.checksum) {
      fail(
        `Checksum mismatch for ${migration.version}: ledger ${ledgerRow.checksum}, file ${migration.checksum}`,
      );
    }
  }

  for (const migration of plan) {
    const conflictingRows = ledgerRows.filter(
      (row) => row.number === migration.number && row.version !== migration.version,
    );
    if (conflictingRows.length) {
      fail(
        `Refusing migration ${migration.version}: number ${String(migration.number).padStart(3, "0")} already exists in ledger as ${conflictingRows.map((row) => row.version).join(", ")}`,
      );
    }
  }
}

function printStatus({ ledger, migrations, plan }) {
  const ledgerByVersion = byVersion(ledger.rows);
  const hasBaseline = ledgerByVersion.has(baselineVersion);
  const collisions = numberCollisions(ledger.rows, migrations);
  const legacyWithoutChecksum = ledger.rows.filter((row) => !row.checksum);

  console.log(`Ledger table: ${ledger.exists ? "present" : "missing"}`);
  console.log(`Baseline ${baselineVersion}: ${hasBaseline ? "present" : "missing"}`);
  console.log(`Migration files: ${migrations.length}`);
  console.log(`Ledger rows: ${ledger.rows.length}`);
  console.log(`Legacy ledger rows without checksum: ${legacyWithoutChecksum.length}`);

  if (collisions.length) {
    console.log("Number collisions / ledger-only legacy rows:");
    for (const collision of collisions) {
      console.log(
        `  - ${String(collision.number).padStart(3, "0")}: ledger=${collision.ledger}; code=${collision.codeVersions.join(", ")}`,
      );
    }
  }

  if (legacyWithoutChecksum.length) {
    console.log("Legacy rows without checksum, tolerated but not treated as verified file checksums:");
    for (const row of legacyWithoutChecksum) {
      console.log(`  - ${row.version}`);
    }
  }

  console.log("Planned migrations:");
  if (!plan.length) {
    console.log("  - none");
  } else {
    for (const migration of plan) {
      console.log(`  - ${migration.version} ${migration.checksum} ${migration.path}`);
    }
  }

  if (hasBaseline) {
    const covered = migrations.filter(
      (migration) =>
        !migration.rollback &&
        migration.number < baselineNumber &&
        !ledgerByVersion.has(migration.version),
    ).length;
    console.log(`Historical migrations covered by baseline, not ledgered individually: ${covered}`);
  }
}

async function applyMigration(client, migration) {
  console.log(`Applying ${migration.path}`);
  await client.query("begin");
  try {
    await client.query(migration.content);
    await client.query(
      `
      insert into novalure_schema_migrations (version, name, checksum)
      values ($1, $2, $3)
    `,
      [migration.version, migration.name, migration.checksum],
    );
    await client.query("commit");
    console.log(`Applied ${migration.path}`);
  } catch (error) {
    await client.query("rollback");
    throw error;
  }
}

const { command, only } = parseArgs(process.argv);
const target = resolveTarget();
const migrations = readMigrations();
const pool = new Pool({ connectionString: target.databaseUrl });
const client = await pool.connect();

try {
  let hasLock = false;
  if (command === "up") {
    await client.query("select pg_advisory_lock($1)", [lockKey]);
    hasLock = true;
  }

  const ledger = await readLedger(client);
  const plan = plannedMigrations({ ledgerRows: ledger.rows, migrations, only });
  assertChecksumSafety({ ledgerRows: ledger.rows, migrations, plan });

  try {
    if (command === "status" || command === "dry-run") {
      printStatus({ ledger, migrations, plan });
      if (command === "dry-run") console.log("Dry run only: no migration executed.");
      process.exitCode = 0;
    } else {
      if (!plan.length) {
        console.log("No pending migrations.");
      } else {
        for (const migration of plan) {
          await applyMigration(client, migration);
        }
      }

      const nextLedger = await readLedger(client);
      const nextPlan = plannedMigrations({ ledgerRows: nextLedger.rows, migrations, only: "" });
      printStatus({ ledger: nextLedger, migrations, plan: nextPlan });
    }
  } finally {
    if (hasLock) await client.query("select pg_advisory_unlock($1)", [lockKey]);
  }
} finally {
  client.release();
  await pool.end();
}
