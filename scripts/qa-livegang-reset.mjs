#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { neon } from "@neondatabase/serverless";

function loadEnv(path) {
  if (!fs.existsSync(path)) return;
  for (const line of fs.readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator === -1) continue;
    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim().replace(/^['"]|['"]$/g, "");
    if (!process.env[key]) process.env[key] = value;
  }
}

loadEnv(".env.local");
loadEnv(".env.production.local");

function resolveDatabaseUrl() {
  return (
    process.env.DATABASE_URL ||
    process.env.POSTGRES_URL ||
    process.env.POSTGRES_DATABASE_URL ||
    process.env.POSTGRES_PRISMA_URL ||
    ""
  ).trim().replace(/^['"]|['"]$/g, "");
}

function stableUuid(input) {
  const chars = createHash("sha1").update(`novalure-livegang:${input}`).digest("hex").slice(0, 32).split("");
  chars[12] = "5";
  chars[16] = ((Number.parseInt(chars[16], 16) & 0x3) | 0x8).toString(16);
  const hex = chars.join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const args = new Set(process.argv.slice(2));
const shouldReset = args.has("--reset");
const shouldCleanupOnly = args.has("--cleanup-only") || !shouldReset;

if (args.has("--help")) {
  console.log("Usage: node scripts/qa-livegang-reset.mjs [--cleanup-only|--reset]");
  console.log("--cleanup-only  Delete deterministic QA Livegang workspaces/users. Default.");
  console.log("--reset         Delete QA Livegang data and run qa-livegang-seed.mjs afterwards.");
  process.exit(0);
}

const databaseUrl = resolveDatabaseUrl();

if (!databaseUrl) {
  console.error("Missing DATABASE_URL/POSTGRES_URL for QA cleanup.");
  process.exit(1);
}

const sql = neon(databaseUrl);

const qaWorkspaceIds = [
  stableUuid("workspace:internal"),
  stableUuid("workspace:developer"),
  stableUuid("workspace:broker"),
];

const qaWorkspaceNames = [
  "QA Novalure Internal Workspace",
  "QA Bautr\u00e4ger Workspace",
  "QA Makler Workspace",
];

const qaEmails = [
  "qa-platform-admin@novalure.local",
  "qa-developer-sales@novalure.local",
  "qa-broker-sales@novalure.local",
  "qa-assistant@novalure.local",
];

async function countDeleted(query, params = []) {
  const rows = await sql.query(query, params);
  return Number(rows[0]?.count ?? 0);
}

async function cleanup() {
  const deletedWorkspaces = await countDeleted(
    `
      with deleted as (
        delete from workspaces
        where id = any($1::uuid[])
           or name = any($2::text[])
        returning 1
      )
      select count(*)::int as count from deleted
    `,
    [qaWorkspaceIds, qaWorkspaceNames],
  );

  const deletedUsers = await countDeleted(
    `
      with deleted as (
        delete from workspace_users
        where lower(email) = any($1::text[])
        returning 1
      )
      select count(*)::int as count from deleted
    `,
    [qaEmails],
  );

  console.log("QA Livegang cleanup complete.");
  console.log(`Deleted QA workspace users: ${deletedUsers}`);
  console.log(`Deleted QA workspaces: ${deletedWorkspaces}`);
}

await cleanup();

if (shouldReset && !shouldCleanupOnly) {
  const seedPath = fileURLToPath(new URL("./qa-livegang-seed.mjs", import.meta.url));
  console.log("Reseeding QA Livegang data...");
  const result = spawnSync(process.execPath, [seedPath], {
    env: process.env,
    stdio: "inherit",
  });
  process.exit(result.status ?? 1);
}
