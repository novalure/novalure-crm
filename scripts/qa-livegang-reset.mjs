#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { neon } from "@neondatabase/serverless";
import { assertQaTarget } from "./qa-target-guard.mjs";

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

const qaTarget = await assertQaTarget();

function stableUuid(input) {
  const chars = createHash("sha1")
    .update(`novalure-livegang:${qaTarget.runPrefix}:${input}`)
    .digest("hex")
    .slice(0, 32)
    .split("");
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

const databaseUrl = qaTarget.databaseUrl;

const sql = neon(databaseUrl);

const qaWorkspaceIds = [
  stableUuid("workspace:internal"),
  stableUuid("workspace:developer"),
  stableUuid("workspace:broker"),
];

async function cleanup() {
  const rows = await sql.query(
    `
      select id, is_qa as "isQa", setup_state ->> 'qaSeedRun' as "qaSeedRun"
      from workspaces
      where id = any($1::uuid[])
    `,
    [qaWorkspaceIds],
  );
  for (const row of rows) {
    if (row.isQa !== true || row.qaSeedRun !== qaTarget.runPrefix) {
      throw new Error(`Refusing to reset a non-QA or foreign QA workspace fixture: ${row.id}`);
    }
  }

  // Delete deterministic QA Livegang workspaces/users is intentionally no
  // longer a valid operation: completed QA flows can create append-only audit,
  // receipt, event, and stage-history evidence. The seed is idempotent for a
  // unique run prefix, and QA infrastructure owns retention of that evidence.
  console.log("QA Livegang integrity reset complete; no append-only evidence was deleted.");
  console.log(`Verified reusable QA workspaces: ${rows.length}`);
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
