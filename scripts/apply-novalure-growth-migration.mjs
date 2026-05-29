#!/usr/bin/env node
import fs from "node:fs";
import process from "node:process";
import { neon } from "@neondatabase/serverless";

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

function splitSql(sql) {
  return sql
    .split(";")
    .map((statement) => statement.trim())
    .filter(Boolean);
}

loadEnv(".env.local");
loadEnv(".env.production.local");

const databaseUrl =
  cleanDatabaseUrl(process.env.DATABASE_URL) ||
  cleanDatabaseUrl(process.env.POSTGRES_URL) ||
  cleanDatabaseUrl(process.env.POSTGRES_DATABASE_URL) ||
  cleanDatabaseUrl(process.env.POSTGRES_PRISMA_URL);

if (!databaseUrl) {
  console.error("No database URL configured.");
  process.exit(1);
}

const sql = neon(databaseUrl);
const statements = splitSql(fs.readFileSync("migrations/030_novalure_growth_workspace.sql", "utf8"));

for (const statement of statements) {
  await sql.query(statement);
}

console.log("novalure growth workspace migration applied");
