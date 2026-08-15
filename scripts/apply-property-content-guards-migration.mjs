#!/usr/bin/env node
import fs from "node:fs";
import process from "node:process";
import { neon } from "@neondatabase/serverless";

const testDbHost = "ep-morning-fog-al1enszq-pooler.c-3.eu-central-1.aws.neon.tech";
const testDbSuffix = "98273025";
const prodDbHost = "ep-wandering-union-alem0781-pooler.c-3.eu-central-1.aws.neon.tech";
const prodDbSuffix = "70835427";

function loadEnv(path) {
  if (!fs.existsSync(path)) return;

  for (const line of fs.readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const separator = trimmed.indexOf("=");
    if (separator === -1) continue;

    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
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

function splitSql(sql) {
  return sql
    .split(";")
    .map((statement) => statement.trim())
    .filter(Boolean);
}

const target = process.env.PROPERTY_CONTENT_GUARDS_MIGRATION_TARGET || "test";
const envFile = target === "prod" ? ".env.production.local" : ".env.local";

if (target !== "test" && target !== "prod") {
  throw new Error("PROPERTY_CONTENT_GUARDS_MIGRATION_TARGET must be 'test' or 'prod'");
}

loadEnv(envFile);

const databaseUrl =
  cleanDatabaseUrl(process.env.DATABASE_URL) ||
  cleanDatabaseUrl(process.env.POSTGRES_URL) ||
  cleanDatabaseUrl(process.env.POSTGRES_DATABASE_URL) ||
  cleanDatabaseUrl(process.env.POSTGRES_PRISMA_URL);

if (!databaseUrl) {
  console.error("No database URL configured.");
  process.exit(1);
}

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

const sql = neon(databaseUrl);
const migration = "migrations/039_property_content_partial_unique_indexes.sql";
for (const statement of splitSql(fs.readFileSync(migration, "utf8"))) {
  await sql.query(statement);
}
console.log(`Applied ${migration}`);
console.log("property content duplicate guards migration applied");
