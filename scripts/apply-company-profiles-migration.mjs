#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Pool } from "@neondatabase/serverless";

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

loadEnvFile(join(process.cwd(), ".env.production.local"));

const databaseUrl =
  cleanDatabaseUrl(process.env.DATABASE_URL) ||
  cleanDatabaseUrl(process.env.POSTGRES_URL) ||
  cleanDatabaseUrl(process.env.POSTGRES_DATABASE_URL) ||
  cleanDatabaseUrl(process.env.POSTGRES_PRISMA_URL);
if (!databaseUrl) throw new Error("DATABASE_URL is missing");

const parsed = new URL(databaseUrl);
const projectId = process.env.POSTGRES_NEON_PROJECT_ID || process.env.NEON_PROJECT_ID || "";

console.log(`Active DATABASE_URL: ${maskDatabaseUrl(databaseUrl)}`);
console.log(`Active DB host: ${parsed.hostname}`);
console.log("Active target: prod");
console.log(`Project ID suffix verified: ${projectId ? "***" + projectId.slice(-8) : "missing"}`);
console.log(`Expected DB suffix: ${prodDbSuffix}`);

if (parsed.hostname !== prodDbHost) {
  throw new Error(`Refusing to write: active DB host is not prod (${prodDbHost})`);
}

if (!projectId.includes(prodDbSuffix)) {
  throw new Error(`Refusing to write: active project id does not contain expected suffix ${prodDbSuffix}`);
}

const pool = new Pool({ connectionString: databaseUrl });

try {
  const migrationPath = "migrations/036_company_profiles.sql";
  const migration = readFileSync(join(process.cwd(), migrationPath), "utf8");
  await pool.query(migration);
  console.log(`Applied ${migrationPath}`);
} finally {
  await pool.end();
}
