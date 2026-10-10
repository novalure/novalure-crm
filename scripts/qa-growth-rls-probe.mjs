#!/usr/bin/env node
import { createHash } from "node:crypto";
import process from "node:process";
import { Pool } from "pg";
import { assertConnectedDatabaseTarget } from "./lib/infra-targets.mjs";

const growthWorkspaceId = "8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101";
const action = process.argv[2];

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required; QA Growth probe is fail-closed.`);
  return value;
}

function stableUuid(input) {
  const chars = createHash("sha1").update(`novalure-growth-qa-probe:${input}`).digest("hex").slice(0, 32).split("");
  chars[12] = "5";
  chars[16] = ((Number.parseInt(chars[16], 16) & 0x3) | 0x8).toString(16);
  const hex = chars.join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function probeIdentity() {
  const runPrefix = required("NOVALURE_QA_RUN_PREFIX");
  if (!/^GOLIVETEST_[A-Za-z0-9_-]{6,80}$/.test(runPrefix)) throw new Error("NOVALURE_QA_RUN_PREFIX must be a unique GOLIVETEST run identifier.");
  const normalizedRun = runPrefix.toLowerCase().replace(/[^a-z0-9_-]/g, "-");
  return Object.freeze({
    id: stableUuid(runPrefix),
    email: `qa-growth-rls-probe+${normalizedRun}@novalure.invalid`,
    name: `QA Growth RLS Probe ${runPrefix}`,
  });
}

function expectedProvisioning() {
  const marker = process.env.NOVALURE_QA_GROWTH_RLS_PROBE_PROVISIONED;
  if (marker === undefined || marker === "") return false;
  if (marker !== "1") throw new Error("NOVALURE_QA_GROWTH_RLS_PROBE_PROVISIONED must be exactly 1 when present.");
  return true;
}

function assertDirectMigrationUrl(value) {
  const url = new URL(value);
  if (!/^postgres(?:ql)?:$/.test(url.protocol) || url.hostname.includes("-pooler.")) throw new Error("QA Growth probe requires the direct migration connection.");
}

async function withOperatorTransaction(callback) {
  const migrationUrl = required("MIGRATION_DATABASE_URL");
  assertDirectMigrationUrl(migrationUrl);
  const pool = new Pool({ connectionString: migrationUrl, max: 1 });
  const client = await pool.connect();
  let begun = false;
  try {
    await client.query("begin"); begun = true;
    await assertConnectedDatabaseTarget({ client, connectionMode: "direct", minimumServerVersionNum: 170000, purpose: "QA Growth RLS probe", target: "test" });
    const result = await callback(client);
    await client.query("commit"); begun = false;
    return result;
  } catch (error) {
    if (begun) await client.query("rollback");
    throw error;
  } finally { client.release(); await pool.end(); }
}

async function seed() {
  const probe = probeIdentity();
  await withOperatorTransaction(async (client) => {
    const workspace = (await client.query("select id from workspaces where id=$1 and name='Novalure Growth' and slug='novalure-growth'", [growthWorkspaceId])).rows[0];
    if (!workspace) throw new Error("Canonical Growth workspace is unavailable; refusing QA probe creation.");
    const row = (await client.query("insert into workspace_users(id,workspace_id,name,email,role,status,product_role) values($1,$2,$3,lower($4),'agent','active','novalureGrowth') on conflict(id) do update set name=excluded.name,email=excluded.email,role='agent',status='active',product_role='novalureGrowth',updated_at=now() where workspace_users.workspace_id=excluded.workspace_id and lower(workspace_users.email)=lower(excluded.email) returning id,workspace_id,name,email,role,status,product_role", [probe.id, growthWorkspaceId, probe.name, probe.email])).rows[0];
    if (!row || row.id !== probe.id || row.workspace_id !== growthWorkspaceId || row.email !== probe.email || row.role !== "agent" || row.status !== "active" || row.product_role !== "novalureGrowth") throw new Error("QA Growth probe could not be verified with its least-privilege tenant membership.");
  });
  console.log("QA_GROWTH_RLS_PROBE=SEEDED");
}

async function cleanup() {
  const probe = probeIdentity();
  const provisioned = expectedProvisioning();
  let untrackedProvisioning = false;
  await withOperatorTransaction(async (client) => {
    const dependencies = Number((await client.query("select (select count(*) from audit_logs where actor_user_id=$1) + (select count(*) from deal_stage_history where changed_by_user_id=$1) as count", [probe.id])).rows[0]?.count ?? 0);
    if (dependencies !== 0) throw new Error("QA Growth probe has unexpected business evidence; refusing deletion.");
    const removed = (await client.query("delete from workspace_users where id=$1 and workspace_id=$2 and lower(email)=lower($3) and name=$4 and role='agent' and status='active' and product_role='novalureGrowth' returning id", [probe.id, growthWorkspaceId, probe.email, probe.name])).rows;
    if (removed.length > 1) throw new Error(`QA Growth probe cleanup matched ${removed.length} members.`);
    if (provisioned && removed.length !== 1) throw new Error(`QA Growth probe cleanup expected one exact member deletion after provisioning, found ${removed.length}.`);
    untrackedProvisioning = !provisioned && removed.length === 1;
  });
  if (untrackedProvisioning) throw new Error("QA Growth probe was removed without a provisioning marker; cleanup is complete but the workflow proof is invalid.");
  console.log("QA_GROWTH_RLS_PROBE=CLEANED");
}

async function quarantineStale() {
  const quarantined = await withOperatorTransaction(async (client) => {
    const rows = (await client.query(
      "update workspace_users set status='suspended',updated_at=now() where workspace_id=$1 and status='active' and role='agent' and product_role='novalureGrowth' and lower(email) ~ '^qa-growth-rls-probe\\+golivetest_[a-z0-9_-]+@novalure\\.invalid$' and name ~ '^QA Growth RLS Probe GOLIVETEST_[A-Za-z0-9_-]+$' returning id",
      [growthWorkspaceId],
    )).rows;
    const active = Number((await client.query(
      "select count(*)::int as count from workspace_users where workspace_id=$1 and status='active' and role='agent' and product_role='novalureGrowth' and lower(email) ~ '^qa-growth-rls-probe\\+golivetest_[a-z0-9_-]+@novalure\\.invalid$' and name ~ '^QA Growth RLS Probe GOLIVETEST_[A-Za-z0-9_-]+$'",
      [growthWorkspaceId],
    )).rows[0]?.count ?? 0);
    if (active !== 0) throw new Error("Active stale QA Growth probe membership remains after quarantine.");
    return rows.length;
  });
  console.log(`QA_GROWTH_RLS_PROBE_STALE_QUARANTINE=${quarantined}`);
}

if (action === "seed") await seed();
else if (action === "cleanup") await cleanup();
else if (action === "quarantine-stale") await quarantineStale();
else throw new Error("Usage: node scripts/qa-growth-rls-probe.mjs <seed|cleanup|quarantine-stale>");
