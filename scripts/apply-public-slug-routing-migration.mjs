import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Pool } from "@neondatabase/serverless";

const testDbHost = "ep-morning-fog-al1enszq-pooler.c-3.eu-central-1.aws.neon.tech";
const testDbSuffix = "98273025";
const prodDbHost = "ep-wandering-union-alem0781-pooler.c-3.eu-central-1.aws.neon.tech";
const prodDbSuffix = "70835427";

function loadEnvFile(path) {
  if (!existsSync(path)) return;

  for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const index = line.indexOf("=");
    const key = line.slice(0, index).trim();
    let value = line.slice(index + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}

function maskDatabaseUrl(value) {
  return value
    .replace(/:\/\/[^:@/]+:([^@/]+)@/, "://***:***@")
    .replace(/(project|database|dbname)=([^&\s]+)/gi, "$1=***");
}

function cleanDatabaseUrl(value) {
  if (!value) return "";

  const trimmed = value.trim().replace(/^['"]|['"]$/g, "");
  const prefixedUrl = trimmed.match(/^[A-Z0-9_]+=((?:postgres|postgresql):\/\/.+)$/i);

  return prefixedUrl?.[1] ?? trimmed;
}

const target = process.env.PUBLIC_SLUG_ROUTING_MIGRATION_TARGET || "test";
const envFile = target === "prod" ? ".env.production.local" : ".env.local";

if (target !== "test" && target !== "prod") {
  throw new Error("PUBLIC_SLUG_ROUTING_MIGRATION_TARGET must be 'test' or 'prod'");
}

loadEnvFile(join(process.cwd(), envFile));

const databaseUrl =
  cleanDatabaseUrl(process.env.DATABASE_URL) ||
  cleanDatabaseUrl(process.env.POSTGRES_URL) ||
  cleanDatabaseUrl(process.env.POSTGRES_DATABASE_URL) ||
  cleanDatabaseUrl(process.env.POSTGRES_PRISMA_URL);
if (!databaseUrl) throw new Error("DATABASE_URL is missing");

const parsed = new URL(databaseUrl);
const projectId = process.env.POSTGRES_NEON_PROJECT_ID || process.env.NEON_PROJECT_ID || "";
const expectedHost = target === "prod" ? prodDbHost : testDbHost;
const expectedSuffix = target === "prod" ? prodDbSuffix : testDbSuffix;

console.log(`Active DATABASE_URL: ${maskDatabaseUrl(databaseUrl)}`);
console.log(`Active DB host: ${parsed.hostname}`);
console.log(`Active target: ${target}`);
console.log(`Project ID suffix verified: ${projectId ? "***" + projectId.slice(-8) : "missing"}`);
console.log(`Expected DB suffix: ${expectedSuffix}`);

if (parsed.hostname !== expectedHost) {
  throw new Error(`Refusing to write: active DB host is not ${target} (${expectedHost})`);
}

if (target === "test" && parsed.hostname === prodDbHost) {
  throw new Error("Refusing to write: active DB host is the Prod DB");
}

if (!projectId.includes(expectedSuffix)) {
  throw new Error(`Refusing to write: active project id does not contain expected suffix ${expectedSuffix}`);
}

const migration = readFileSync(join(process.cwd(), "migrations/032_public_slug_routing.sql"), "utf8");
const pool = new Pool({ connectionString: databaseUrl });

try {
  await pool.query(migration);
  console.log("Applied migrations/032_public_slug_routing.sql");
} finally {
  await pool.end();
}
