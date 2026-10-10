#!/usr/bin/env node
import { createHash } from "node:crypto";
import fs from "node:fs";
import process from "node:process";
import { neon } from "@neondatabase/serverless";
import { Pool } from "pg";
import { withTenantTransaction } from "../src/lib/db/tenant-client.ts";
import { assertConnectedDatabaseTarget } from "./lib/infra-targets.mjs";
import { assertQaTarget } from "./qa-target-guard.mjs";

const growthWorkspaceId = "8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101";
const growthProjectId = "f7d83c6b-d08d-4d73-b822-1f1c0b4733d2";
const growthPipelineId = "a5cf82f8-c6f4-4517-a0f6-9d9f17601830";
const growthStages = ["Neu", "Qualifiziert", "Demo gebucht", "Demo gehalten", "Angebot", "Pilot", "Gewonnen", "Verloren"];
const growthSources = ["Website", "Empfehlung", "LinkedIn", "Partner", "Event", "Newsletter", "Outbound", "Formular"];
const growthBotSeedKeys = ["demo_request_bot", "outbound_research_bot", "demo_follow_up_bot", "pilot_check_in_bot", "knowledge_bot"];
const enabledModules = ["properties", "dashboard", "leadInbox", "contacts", "pipeline", "deals", "tasks", "calendar", "communication", "funnels", "newsletter", "bots", "knowledge", "analytics", "settings", "objectsMandates", "units", "reservations", "projectOverview"];
const newRoles = ["novalureGrowth", "novalureServiceOps", "novalureAdmin"];
const internalGrowthRoles = ["platform_admin", "novalureGrowth", "novalureServiceOps", "novalureAdmin", "novalure_sales", "novalure_onboarding", "novalure_customer_success", "novalure_operator"];
const envFiles = [".env.local", ".env.production.local"];
const matrix = [];
const operatorOnly = process.argv.includes("--operator-only");

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required; tenant diagnostics are fail-closed.`);
  return value;
}

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

for (const file of envFiles) loadEnv(file);

function readText(path) { return fs.readFileSync(path, "utf8"); }
function addMatrix(row) { matrix.push({ check: row.check, expected: row.expected, actual: row.actual, status: row.ok ? "gruen" : "rot", cause: row.ok ? "" : row.cause }); }
function sameArray(actual, expected) { return actual.length === expected.length && actual.every((item, index) => item === expected[index]); }
function productRoleBlock(source, role) { return source.match(new RegExp(`${role}: \\[([\\s\\S]*?)\\],`))?.[1] ?? ""; }
function parseNavigationPresetOrder(source) { const match = source.match(/const navigationPresetOrder: NavigationPresetId\[\] = \[([\s\S]*?)\];/); return match ? [...match[1].matchAll(/"([^"]+)"/g)].map((entry) => entry[1]) : []; }
function fingerprint(snapshot) { return createHash("sha256").update(JSON.stringify(snapshot)).digest("hex").slice(0, 24); }

function assertDirectMigrationUrl(value) {
  const url = new URL(value);
  if (!/^postgres(?:ql)?:$/.test(url.protocol) || url.hostname.includes("-pooler.")) throw new Error("Operator proof requires the approved direct migration connection, never the pooled runtime connection.");
}

function runStaticChecks() {
  const productModel = readText("src/lib/product-model.ts");
  const crmWorkspace = readText("src/components/crm-workspace.tsx");
  const session = readText("src/lib/auth/session.ts");
  const workspaceRoute = readText("src/app/api/workspaces/route.ts");
  const writes = readText("src/lib/db/crm-write-repositories.ts");
  const migration = readText("migrations/030_novalure_growth_workspace.sql");
  const navigationOrder = parseNavigationPresetOrder(crmWorkspace);
  const expectedNavigationProfiles = ["completeBrokerage", "realEstateBroker", "propertyDeveloper", "hybridRealEstate", "managedService", "sales", "salesLead", "management", "marketing", "assistant", "newUser", "admin", "novalureInternal", "novalureGrowth", "novalureServiceOps", "novalureAdmin"];
  for (const role of newRoles) addMatrix({ check: `product role ${role}`, expected: "role is additive in server product model", actual: productModel.includes(`| \"${role}\"`) ? "present" : "missing", ok: productModel.includes(`| \"${role}\"`), cause: `${role} is missing from ProductRole` });
  addMatrix({ check: "existing navigation order", expected: "completeBrokerage first; standard profiles before team and Novalure internal profiles", actual: navigationOrder.length ? navigationOrder.join(", ") : "not confirmed", ok: sameArray(navigationOrder, expectedNavigationProfiles), cause: "new profile order is not visible in navigationPresetOrder" });
  const growthRoleBlock = productRoleBlock(productModel, "novalureGrowth");
  addMatrix({ check: "growth role protected capabilities", expected: "novalureGrowth can operate CRM but cannot publish bots or manage settings", actual: /growth-workspace:operate[\s\S]*workspace:read/.test(growthRoleBlock) ? "growth workspace capability present" : "missing", ok: /growth-workspace:operate[\s\S]*workspace:read/.test(growthRoleBlock) && !/bots:publish/.test(growthRoleBlock) && !/settings:manage/.test(growthRoleBlock), cause: "novalureGrowth RBAC is too broad or incomplete" });
  const workspaceListIsMembershipBacked = /from workspace_users wu[\s\S]*join workspaces w on w\.id = wu\.workspace_id/.test(workspaceRoute) && /wu\.id = \$1::uuid[\s\S]*lower\(wu\.email\) = lower\(\$3\)/.test(workspaceRoute) && workspaceRoute.includes("const listManagedWorkspaces = canSwitchWorkspace(auth.session)");
  addMatrix({ check: "service ops cross-workspace gate", expected: "novalureServiceOps requires explicit membership and writes an audit log", actual: session.includes("findActiveMembershipForSession") && session.includes("Target workspace access requires explicit active membership") && session.includes("workspace.cross_workspace_view") ? "membership gate plus audit" : "not confirmed", ok: session.includes("findActiveMembershipForSession") && session.includes("Target workspace access requires explicit active membership") && session.includes("workspace.cross_workspace_view"), cause: "service ops cross-workspace access is missing membership or audit enforcement" });
  addMatrix({ check: "workspace list isolation", expected: "Growth workspace is hidden unless specialized profile or explicit membership applies", actual: workspaceListIsMembershipBacked ? "route lists only active memberships" : "not confirmed", ok: workspaceListIsMembershipBacked, cause: "WorkspaceList route does not explicitly isolate Novalure Growth" });
  addMatrix({ check: "growth lead source enforcement", expected: "Growth leads require one of the eight allowed sources", actual: writes.includes("Lead source is required in the Novalure Growth workspace") && writes.includes("Invalid Novalure Growth lead source") ? "write path enforces source" : "not confirmed", ok: writes.includes("Lead source is required in the Novalure Growth workspace") && writes.includes("Invalid Novalure Growth lead source"), cause: "Lead source enforcement is not present in server write path" });
  addMatrix({ check: "no automatic user migration", expected: "migration does not update workspace_users product_role values", actual: /update\s+workspace_users\s+set\s+product_role/i.test(migration) ? "updates users" : "no user product_role update", ok: !/update\s+workspace_users\s+set\s+product_role/i.test(migration), cause: "migration appears to remap existing users" });
}

async function withOperatorReadOnly(callback) {
  const migrationUrl = required("MIGRATION_DATABASE_URL");
  assertDirectMigrationUrl(migrationUrl);
  const pool = new Pool({ connectionString: migrationUrl, max: 1 });
  const client = await pool.connect();
  let begun = false;
  try {
    await client.query("begin read only"); begun = true;
    await assertConnectedDatabaseTarget({ client, connectionMode: "direct", minimumServerVersionNum: 170000, purpose: "Growth seed read-only proof", target: "test" });
    const result = await callback(client);
    await client.query("commit"); begun = false;
    return result;
  } catch (error) {
    if (begun) await client.query("rollback");
    throw error;
  } finally { client.release(); await pool.end(); }
}

async function operatorSnapshot() {
  return withOperatorReadOnly(async (client) => {
    const workspace = (await client.query("select id, name, slug from workspaces where id=$1", [growthWorkspaceId])).rows[0] ?? null;
    const project = (await client.query("select id, workspace_id, name from projects where id=$1 and workspace_id=$2", [growthProjectId, growthWorkspaceId])).rows[0] ?? null;
    const pipeline = (await client.query("select id, workspace_id, project_id, key, name from crm_pipelines where id=$1 and workspace_id=$2 and project_id=$3", [growthPipelineId, growthWorkspaceId, growthProjectId])).rows[0] ?? null;
    const stages = (await client.query("select id, key, name, position from crm_pipeline_stages where pipeline_id=$1 and workspace_id=$2 and project_id=$3 order by position asc, id asc", [growthPipelineId, growthWorkspaceId, growthProjectId])).rows;
    const sources = (await client.query("select key, source_value, position from workspace_lead_sources where workspace_id=$1 order by position asc, id asc", [growthWorkspaceId])).rows;
    const bots = (await client.query("select id, name, status, config->>'seedKey' as seed_key, config->>'tenantScope' as tenant_scope from bots where workspace_id=$1 and project_id=$2 and config->>'seedKey'=any($3::text[]) order by config->>'seedKey' asc, id asc", [growthWorkspaceId, growthProjectId, growthBotSeedKeys])).rows;
    const modules = (await client.query("select module_key, enabled from workspace_module_settings where workspace_id=$1 order by module_key asc", [growthWorkspaceId])).rows;
    const duplicateWorkspaceCount = Number((await client.query("select count(*)::int as count from workspaces where id<>$1 and (slug='novalure-growth' or setup_state->>'workspaceKey'='novalure-growth')", [growthWorkspaceId])).rows[0]?.count ?? 0);
    const canonicalProjectCount = Number((await client.query("select count(*)::int as count from projects where workspace_id=$1 and name='Novalure Eigenakquise'", [growthWorkspaceId])).rows[0]?.count ?? 0);
    const canonicalPipelineCount = Number((await client.query("select count(*)::int as count from crm_pipelines where workspace_id=$1 and key='novalure_growth_pipeline'", [growthWorkspaceId])).rows[0]?.count ?? 0);
    const duplicateStageKeyCount = Number((await client.query("select count(*)::int as count from (select key from crm_pipeline_stages where pipeline_id=$1 and workspace_id=$2 group by key having count(*)>1) duplicates", [growthPipelineId, growthWorkspaceId])).rows[0]?.count ?? 0);
    const duplicateBotSeedKeyCount = Number((await client.query("select count(*)::int as count from (select config->>'seedKey' from bots where workspace_id=$1 and project_id=$2 and config->>'seedKey'=any($3::text[]) group by config->>'seedKey' having count(*)>1) duplicates", [growthWorkspaceId, growthProjectId, growthBotSeedKeys])).rows[0]?.count ?? 0);
    const customerLeakCount = Number((await client.query("select count(*)::int as count from customer_workspace_access ca left join organizations o on o.id=ca.organization_id left join projects p on p.id=ca.project_id where ca.workspace_id=$1 or o.name='Novalure Growth' or p.name='Novalure Eigenakquise'", [growthWorkspaceId])).rows[0]?.count ?? 0);
    const growthActor = (await client.query("select id, role, product_role from workspace_users where workspace_id=$1 and status='active' and role in ('owner','admin','agent') and product_role=any($2::text[]) order by case role when 'owner' then 0 when 'admin' then 1 else 2 end, id asc limit 1", [growthWorkspaceId, internalGrowthRoles])).rows[0] ?? null;
    const foreignContext = (await client.query("select w.id as workspace_id, u.id as actor_id from workspaces w join workspace_users u on u.workspace_id=w.id and u.status='active' and u.role in ('owner','admin','agent') where w.is_qa=true and w.setup_state->>'qaSeedRun'=$1 order by case u.role when 'owner' then 0 when 'admin' then 1 else 2 end, w.id, u.id limit 1", [required("NOVALURE_QA_RUN_PREFIX")])).rows[0] ?? null;
    return { workspace, project, pipeline, stages, sources, bots, modules, duplicateWorkspaceCount, canonicalProjectCount, canonicalPipelineCount, duplicateStageKeyCount, duplicateBotSeedKeyCount, customerLeakCount, growthActor, foreignContext };
  });
}

function addOperatorChecks(snapshot) {
  const stageNames = snapshot.stages.map((row) => row.name);
  const sourceNames = snapshot.sources.map((row) => row.source_value);
  const moduleMap = new Map(snapshot.modules.map((row) => [row.module_key, row.enabled]));
  const seedKeys = snapshot.bots.map((row) => row.seed_key).sort();
  addMatrix({ check: "OPERATOR_SEED_EXISTENCE workspace", expected: "Novalure Growth workspace with stable ID and slug exists", actual: snapshot.workspace ? `${snapshot.workspace.name} / ${snapshot.workspace.slug ?? ""}` : "missing", ok: snapshot.workspace?.name === "Novalure Growth" && snapshot.workspace?.slug === "novalure-growth", cause: "Growth workspace row was not found or has a wrong slug/name" });
  addMatrix({ check: "OPERATOR_SEED_EXISTENCE project", expected: "Novalure Eigenakquise project with stable ID exists", actual: snapshot.project?.name ?? "missing", ok: snapshot.project?.name === "Novalure Eigenakquise", cause: "Growth project row was not found or has a wrong name" });
  addMatrix({ check: "GROWTH_PIPELINE", expected: "stable Novalure Growth pipeline exists", actual: snapshot.pipeline?.key ?? "missing", ok: snapshot.pipeline?.key === "novalure_growth_pipeline" && snapshot.pipeline?.name === "Novalure Growth Pipeline", cause: "Growth pipeline row was not found or does not match its canonical key" });
  addMatrix({ check: "GROWTH_STAGE_ORDER", expected: growthStages.join(", "), actual: stageNames.join(", "), ok: sameArray(stageNames, growthStages), cause: "Growth pipeline stages differ from the required order" });
  addMatrix({ check: "growth lead sources", expected: growthSources.join(", "), actual: sourceNames.join(", "), ok: sameArray(sourceNames, growthSources), cause: "Growth lead sources differ from the required enum" });
  addMatrix({ check: "GROWTH_BOT_COUNT", expected: "5 canonical Growth bots", actual: `${snapshot.bots.length} canonical bot(s)`, ok: snapshot.bots.length === 5 && sameArray(seedKeys, [...growthBotSeedKeys].sort()), cause: "Canonical Growth bot rows are missing or duplicated" });
  addMatrix({ check: "GROWTH_BOT_STATUS", expected: "all canonical Growth bots inactive", actual: [...new Set(snapshot.bots.map((row) => row.status))].join(", ") || "none", ok: snapshot.bots.length === 5 && snapshot.bots.every((row) => row.status === "inactive"), cause: "A canonical Growth bot is missing or active" });
  addMatrix({ check: "GROWTH_BOT_SCOPE", expected: "all canonical Growth bots tenant-scoped to novalure-growth", actual: [...new Set(snapshot.bots.map((row) => row.tenant_scope))].join(", ") || "none", ok: snapshot.bots.length === 5 && snapshot.bots.every((row) => row.tenant_scope === "novalure-growth"), cause: "A canonical Growth bot is missing its tenant scope" });
  addMatrix({ check: "growth standard CRM modules", expected: enabledModules.map((key) => `${key}=true`).join(", "), actual: enabledModules.map((key) => `${key}=${moduleMap.get(key)}`).join(", "), ok: enabledModules.every((key) => moduleMap.get(key) === true), cause: "At least one standard CRM module is disabled for Growth" });
  addMatrix({ check: "canonical record uniqueness", expected: "one canonical project/pipeline; no duplicate Growth workspace, stage key, or bot seed key", actual: `${snapshot.canonicalProjectCount} project(s), ${snapshot.canonicalPipelineCount} pipeline(s), ${snapshot.duplicateWorkspaceCount} workspace duplicate(s), ${snapshot.duplicateStageKeyCount} stage-key duplicate(s), ${snapshot.duplicateBotSeedKeyCount} bot seed-key duplicate(s)`, ok: snapshot.canonicalProjectCount === 1 && snapshot.canonicalPipelineCount === 1 && snapshot.duplicateWorkspaceCount === 0 && snapshot.duplicateStageKeyCount === 0 && snapshot.duplicateBotSeedKeyCount === 0, cause: "A canonical Growth identifier is duplicated" });
  addMatrix({ check: "customer workspace access leak", expected: "Growth workspace is not listed as a customer workspace access target", actual: `${snapshot.customerLeakCount} access row(s)`, ok: snapshot.customerLeakCount === 0, cause: "Growth workspace appears in customer access records" });
}

function canonicalSeedFingerprint(snapshot) {
  return fingerprint({ workspace: snapshot.workspace && { id: snapshot.workspace.id, name: snapshot.workspace.name, slug: snapshot.workspace.slug }, project: snapshot.project && { id: snapshot.project.id, workspace_id: snapshot.project.workspace_id, name: snapshot.project.name }, pipeline: snapshot.pipeline && { id: snapshot.pipeline.id, workspace_id: snapshot.pipeline.workspace_id, project_id: snapshot.pipeline.project_id, key: snapshot.pipeline.key, name: snapshot.pipeline.name }, stages: snapshot.stages.map(({ id, key, name, position }) => ({ id, key, name, position })), sources: snapshot.sources.map(({ key, source_value, position }) => ({ key, source_value, position })), bots: snapshot.bots.map(({ id, name, status, seed_key, tenant_scope }) => ({ id, name, status, seed_key, tenant_scope })), modules: snapshot.modules.map(({ module_key, enabled }) => ({ module_key, enabled })) });
}

async function noContextProtectedRead(sql) {
  try {
    const row = (await sql.query("select (select count(*)::int from crm_pipelines where id=$1 and workspace_id=$2) as pipeline_count, (select count(*)::int from crm_pipeline_stages where pipeline_id=$1 and workspace_id=$2) as stage_count, (select count(*)::int from bots where workspace_id=$2 and project_id=$3 and config->>'seedKey'=any($4::text[])) as bot_count", [growthPipelineId, growthWorkspaceId, growthProjectId, growthBotSeedKeys]))[0];
    const counts = [Number(row?.pipeline_count ?? 0), Number(row?.stage_count ?? 0), Number(row?.bot_count ?? 0)];
    return { denied: false, counts, ok: counts.every((count) => count === 0) };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "42501") return { denied: true, counts: [], ok: true };
    throw error;
  }
}

async function scopedProtectedRead(scope) {
  return withTenantTransaction(scope, async (transaction) => {
    const pipeline = await transaction.query("select id, key, name from crm_pipelines where id=$1 and workspace_id=$2 and project_id=$3", [growthPipelineId, growthWorkspaceId, growthProjectId]);
    const stages = await transaction.query("select name from crm_pipeline_stages where pipeline_id=$1 and workspace_id=$2 and project_id=$3 order by position asc", [growthPipelineId, growthWorkspaceId, growthProjectId]);
    const bots = await transaction.query("select status, config->>'tenantScope' as tenant_scope from bots where workspace_id=$1 and project_id=$2 and config->>'seedKey'=any($3::text[]) order by config->>'seedKey' asc", [growthWorkspaceId, growthProjectId, growthBotSeedKeys]);
    return { pipeline, stages, bots };
  });
}

async function runRuntimeChecks(sql, snapshot) {
  const noContext = await noContextProtectedRead(sql);
  addMatrix({ check: "NO_CONTEXT_PROTECTED_READ", expected: "DENIED_OR_ZERO", actual: noContext.denied ? "DENIED" : `ZERO (${noContext.counts.join("/")})`, ok: noContext.ok, cause: "Runtime identity read protected Growth data without a tenant context" });
  addMatrix({ check: "Growth runtime actor", expected: "an active internal Growth member is available for the same-tenant proof", actual: snapshot.growthActor ? `${snapshot.growthActor.role}/${snapshot.growthActor.product_role}` : "missing", ok: Boolean(snapshot.growthActor), cause: "No active internal Growth member is available for a valid tenant-scoped runtime proof" });
  addMatrix({ check: "Foreign runtime actor", expected: "an active synthetic QA member is available for the cross-tenant proof", actual: snapshot.foreignContext ? "available" : "missing", ok: Boolean(snapshot.foreignContext), cause: "No active synthetic QA member is available for the cross-tenant proof" });
  if (!snapshot.growthActor || !snapshot.foreignContext) return false;
  const growth = await scopedProtectedRead({ workspaceId: growthWorkspaceId, actorId: snapshot.growthActor.id });
  const growthStageNames = growth.stages.map((row) => row.name);
  addMatrix({ check: "GROWTH_CONTEXT_PROTECTED_READ", expected: "Growth pipeline, all stages, and all canonical bots are visible", actual: `${growth.pipeline.length} pipeline(s), ${growth.stages.length} stage(s), ${growth.bots.length} bot(s)`, ok: growth.pipeline.length === 1 && sameArray(growthStageNames, growthStages) && growth.bots.length === 5 && growth.bots.every((row) => row.status === "inactive" && row.tenant_scope === "novalure-growth"), cause: "Valid Growth tenant context could not read exactly the canonical Growth records" });
  const foreign = await scopedProtectedRead({ workspaceId: snapshot.foreignContext.workspace_id, actorId: snapshot.foreignContext.actor_id });
  const foreignCounts = [foreign.pipeline.length, foreign.stages.length, foreign.bots.length];
  addMatrix({ check: "CROSS_TENANT_PROTECTED_READ", expected: "DENIED_OR_ZERO", actual: `ZERO (${foreignCounts.join("/")})`, ok: foreignCounts.every((count) => count === 0), cause: "A foreign QA tenant context read protected Growth data" });
  return noContext.ok && growth.pipeline.length === 1 && sameArray(growthStageNames, growthStages) && growth.bots.length === 5 && foreignCounts.every((count) => count === 0);
}

function printMarkdownTable(rows) {
  const headers = ["Check", "Erwartet", "Tatsächlich", "Status", "Ursache"];
  console.log(headers.join(" | ")); console.log(headers.map(() => "---").join(" | "));
  for (const row of rows) console.log([row.check, row.expected, row.actual, row.status, row.cause].map((value) => String(value ?? "").replace(/\r?\n/g, " ").replace(/\|/g, "/")).join(" | "));
}

async function main() {
  const qaTarget = await assertQaTarget();
  if (process.env.DATABASE_URL && process.env.DATABASE_URL !== qaTarget.databaseUrl) throw new Error("DATABASE_URL must match the QA runtime URL for tenant diagnostics.");
  process.env.DATABASE_URL = qaTarget.databaseUrl;
  const snapshot = await operatorSnapshot();
  addOperatorChecks(snapshot);
  const seedFingerprint = canonicalSeedFingerprint(snapshot);
  const expectedFingerprint = process.env.GROWTH_CANONICAL_SEED_FINGERPRINT?.trim();
  if (expectedFingerprint) addMatrix({ check: "QA_CLEANUP_PRESERVES_CANONICAL_SEEDS", expected: "operator snapshot matches the pre-reset canonical fingerprint", actual: seedFingerprint, ok: seedFingerprint === expectedFingerprint, cause: "Cleanup or QA seeding changed canonical Growth seed data" });
  let runtimeProofPassed = false;
  if (!operatorOnly) {
    runStaticChecks();
    runtimeProofPassed = await runRuntimeChecks(neon(qaTarget.databaseUrl), snapshot);
    const operatorPassed = matrix.every((row) => row.status === "gruen");
    const rootCause = operatorPassed && runtimeProofPassed ? "CASE_A: DATA_EXISTS_BUT_DIAGNOSTIC_LACKS_TENANT_CONTEXT" : "UNRESOLVED";
    addMatrix({ check: "ROOT_CAUSE_CLASSIFICATION", expected: "exactly one evidence-based case", actual: rootCause, ok: rootCause.startsWith("CASE_A"), cause: "Evidence did not prove the requested Case A three-way RLS diagnosis" });
  }
  console.log("TENANT_ISOLATION_MATRIX"); printMarkdownTable(matrix);
  console.log(`GROWTH_CANONICAL_SEED_FINGERPRINT=${seedFingerprint}`);
  const failing = matrix.filter((row) => row.status === "rot");
  if (failing.length) { console.error(`\nTenant isolation diagnostics finished with ${failing.length} red row(s).`); process.exitCode = 1; }
  else console.log(operatorOnly ? "\nGrowth operator seed snapshot finished green." : "\nTenant isolation diagnostics finished green.");
}

main().catch((error) => { console.error(`FAIL ${error instanceof Error ? error.message : String(error)}`); process.exit(1); });
