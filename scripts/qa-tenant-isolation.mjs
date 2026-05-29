#!/usr/bin/env node
import fs from "node:fs";
import process from "node:process";
import { neon } from "@neondatabase/serverless";

const growthWorkspaceId = "8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101";
const growthStages = ["Neu", "Qualifiziert", "Demo gebucht", "Demo gehalten", "Angebot", "Pilot", "Gewonnen", "Verloren"];
const growthSources = ["Website", "Empfehlung", "LinkedIn", "Partner", "Event", "Newsletter", "Outbound", "Demo-Formular"];
const disabledModules = ["objectsMandates", "units", "reservations", "projectOverview"];
const enabledModules = [
  "dashboard",
  "leadInbox",
  "contacts",
  "pipeline",
  "deals",
  "tasks",
  "calendar",
  "communication",
  "funnels",
  "newsletter",
  "bots",
  "knowledge",
  "analytics",
  "settings",
];
const newRoles = ["novalureGrowth", "novalureServiceOps", "novalureAdmin"];
const envFiles = [".env.local", ".env.production.local"];
const matrix = [];

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

for (const file of envFiles) loadEnv(file);

function cleanDatabaseUrl(value) {
  if (!value) return "";
  const trimmed = String(value).trim().replace(/^['"]|['"]$/g, "");
  const prefixedUrl = trimmed.match(/^[A-Z0-9_]+=((?:postgres|postgresql):\/\/.+)$/i);
  return prefixedUrl?.[1] ?? trimmed;
}

const databaseUrl =
  cleanDatabaseUrl(process.env.DATABASE_URL) ||
  cleanDatabaseUrl(process.env.POSTGRES_URL) ||
  cleanDatabaseUrl(process.env.POSTGRES_DATABASE_URL) ||
  cleanDatabaseUrl(process.env.POSTGRES_PRISMA_URL);

const sql = databaseUrl ? neon(databaseUrl) : null;

function readText(path) {
  return fs.readFileSync(path, "utf8");
}

function addMatrix(row) {
  matrix.push({
    check: row.check,
    expected: row.expected,
    actual: row.actual,
    status: row.ok ? "gruen" : "rot",
    cause: row.ok ? "" : row.cause,
  });
}

function sameArray(actual, expected) {
  return actual.length === expected.length && actual.every((item, index) => item === expected[index]);
}

function productRoleBlock(source, role) {
  const match = source.match(new RegExp(`${role}: \\[([\\s\\S]*?)\\],`));
  return match?.[1] ?? "";
}

async function dbQuery(query, params = []) {
  if (!sql) throw new Error("No database URL is configured.");
  return await sql.query(query, params);
}

function runStaticChecks() {
  const productModel = readText("src/lib/product-model.ts");
  const crmWorkspace = readText("src/components/crm-workspace.tsx");
  const session = readText("src/lib/auth/session.ts");
  const workspaceRoute = readText("src/app/api/workspaces/route.ts");
  const writes = readText("src/lib/db/crm-write-repositories.ts");
  const migration = readText("migrations/030_novalure_growth_workspace.sql");

  for (const role of newRoles) {
    addMatrix({
      check: `product role ${role}`,
      expected: "role is additive in server product model",
      actual: productModel.includes(`| "${role}"`) ? "present" : "missing",
      ok: productModel.includes(`| "${role}"`),
      cause: `${role} is missing from ProductRole`,
    });
  }

  addMatrix({
    check: "existing navigation order",
    expected: "new profiles are appended after the existing twelve profile IDs",
    actual: crmWorkspace.includes('"novalureInternal",') && crmWorkspace.includes('"novalureGrowth",\n  "novalureServiceOps",\n  "novalureAdmin"')
      ? "appended"
      : "not confirmed",
    ok: crmWorkspace.includes('"novalureGrowth",\n  "novalureServiceOps",\n  "novalureAdmin"'),
    cause: "new profile order is not visible in navigationPresetOrder",
  });

  const growthRoleBlock = productRoleBlock(productModel, "novalureGrowth");
  addMatrix({
    check: "growth role protected capabilities",
    expected: "novalureGrowth can operate CRM but cannot publish bots or manage settings",
    actual: /growth-workspace:operate[\s\S]*workspace:read/.test(growthRoleBlock)
      ? "growth workspace capability present"
      : "missing",
    ok:
      /growth-workspace:operate[\s\S]*workspace:read/.test(growthRoleBlock) &&
      !/bots:publish/.test(growthRoleBlock) &&
      !/settings:manage/.test(growthRoleBlock),
    cause: "novalureGrowth RBAC is too broad or incomplete",
  });

  addMatrix({
    check: "service ops cross-workspace gate",
    expected: "novalureServiceOps requires explicit membership and writes an audit log",
    actual: session.includes("Service Ops workspace access requires explicit membership") && session.includes("workspace.cross_workspace_view")
      ? "membership gate plus audit"
      : "not confirmed",
    ok: session.includes("Service Ops workspace access requires explicit membership") && session.includes("workspace.cross_workspace_view"),
    cause: "service ops cross-workspace access is missing membership or audit enforcement",
  });

  addMatrix({
    check: "workspace list isolation",
    expected: "Growth workspace is hidden unless specialized profile or explicit membership applies",
    actual: workspaceRoute.includes("novalure-growth") && workspaceRoute.includes("specializedGrowthRole")
      ? "route filters Growth workspace"
      : "not confirmed",
    ok: workspaceRoute.includes("novalure-growth") && workspaceRoute.includes("specializedGrowthRole"),
    cause: "WorkspaceList route does not explicitly isolate Novalure Growth",
  });

  addMatrix({
    check: "growth lead source enforcement",
    expected: "Growth leads require one of the eight allowed sources",
    actual: writes.includes("Lead source is required in the Novalure Growth workspace") && writes.includes("Invalid Novalure Growth lead source")
      ? "write path enforces source"
      : "not confirmed",
    ok: writes.includes("Lead source is required in the Novalure Growth workspace") && writes.includes("Invalid Novalure Growth lead source"),
    cause: "Lead source enforcement is not present in server write path",
  });

  addMatrix({
    check: "no automatic user migration",
    expected: "migration does not update workspace_users product_role values",
    actual: /update\s+workspace_users\s+set\s+product_role/i.test(migration) ? "updates users" : "no user product_role update",
    ok: !/update\s+workspace_users\s+set\s+product_role/i.test(migration),
    cause: "migration appears to remap existing users",
  });
}

async function runDbChecks() {
  const workspaceRows = await dbQuery(
    `
      select id, name, slug, setup_state
      from workspaces
      where id = $1
      limit 1
    `,
    [growthWorkspaceId],
  );
  const workspace = workspaceRows[0];

  addMatrix({
    check: "growth workspace exists",
    expected: "Novalure Growth workspace with stable ID and slug exists",
    actual: workspace ? `${workspace.name} / ${workspace.slug ?? ""}` : "missing",
    ok: workspace?.name === "Novalure Growth" && workspace?.slug === "novalure-growth",
    cause: "Growth workspace row was not found or has a wrong slug/name",
  });

  const stageRows = await dbQuery(
    `
      select s.name
      from crm_pipeline_stages s
      join crm_pipelines p on p.id = s.pipeline_id
      where p.workspace_id = $1
        and p.key = 'novalure_growth_pipeline'
      order by s.position asc
    `,
    [growthWorkspaceId],
  );
  const stages = stageRows.map((row) => row.name);
  addMatrix({
    check: "growth pipeline stages",
    expected: growthStages.join(", "),
    actual: stages.join(", "),
    ok: sameArray(stages, growthStages),
    cause: "Growth pipeline stages differ from the required order",
  });

  const sourceRows = await dbQuery(
    `
      select source_value
      from workspace_lead_sources
      where workspace_id = $1
      order by position asc
    `,
    [growthWorkspaceId],
  );
  const sources = sourceRows.map((row) => row.source_value);
  addMatrix({
    check: "growth lead sources",
    expected: growthSources.join(", "),
    actual: sources.join(", "),
    ok: sameArray(sources, growthSources),
    cause: "Growth lead sources differ from the required enum",
  });

  const botRows = await dbQuery(
    `
      select name, status, config->>'tenantScope' as tenant_scope
      from bots
      where workspace_id = $1
      order by name asc
    `,
    [growthWorkspaceId],
  );
  addMatrix({
    check: "growth bot seeds",
    expected: "five bots, all inactive, tenant-scoped to novalure-growth",
    actual: `${botRows.length} bot(s), statuses ${[...new Set(botRows.map((row) => row.status))].join(", ")}`,
    ok: botRows.length === 5 && botRows.every((row) => row.status === "inactive" && row.tenant_scope === "novalure-growth"),
    cause: "Growth bot seeds are missing, active, or not tenant-scoped",
  });

  const moduleRows = await dbQuery(
    `
      select module_key, enabled
      from workspace_module_settings
      where workspace_id = $1
    `,
    [growthWorkspaceId],
  );
  const moduleMap = new Map(moduleRows.map((row) => [row.module_key, row.enabled]));
  addMatrix({
    check: "growth disabled real-estate modules",
    expected: disabledModules.map((key) => `${key}=false`).join(", "),
    actual: disabledModules.map((key) => `${key}=${moduleMap.get(key)}`).join(", "),
    ok: disabledModules.every((key) => moduleMap.get(key) === false),
    cause: "At least one real-estate-only module is still enabled for Growth",
  });
  addMatrix({
    check: "growth standard CRM modules",
    expected: enabledModules.map((key) => `${key}=true`).join(", "),
    actual: enabledModules.map((key) => `${key}=${moduleMap.get(key)}`).join(", "),
    ok: enabledModules.every((key) => moduleMap.get(key) === true),
    cause: "At least one standard CRM module is disabled for Growth",
  });

  const duplicateRows = await dbQuery(
    `
      select count(*)::int as count
      from workspaces
      where id <> $1
        and (
          slug = 'novalure-growth'
          or setup_state->>'workspaceKey' = 'novalure-growth'
        )
    `,
    [growthWorkspaceId],
  );
  addMatrix({
    check: "growth workspace uniqueness",
    expected: "no other workspace carries the Growth slug or workspaceKey",
    actual: `${duplicateRows[0]?.count ?? 0} duplicate(s)`,
    ok: Number(duplicateRows[0]?.count ?? 0) === 0,
    cause: "Another workspace is marked as novalure-growth",
  });

  const customerLeakRows = await dbQuery(
    `
      select count(*)::int as count
      from customer_workspace_access ca
      left join organizations o on o.id = ca.organization_id
      left join projects p on p.id = ca.project_id
      where ca.workspace_id = $1
         or o.name = 'Novalure Growth'
         or p.name = 'Novalure Eigenakquise'
    `,
    [growthWorkspaceId],
  );
  addMatrix({
    check: "customer workspace access leak",
    expected: "Growth workspace is not listed as a customer workspace access target",
    actual: `${customerLeakRows[0]?.count ?? 0} access row(s)`,
    ok: Number(customerLeakRows[0]?.count ?? 0) === 0,
    cause: "Growth workspace appears in customer access records",
  });
}

function printMarkdownTable(rows) {
  const headers = ["Check", "Erwartet", "Tatsaechlich", "Status", "Ursache"];
  console.log(headers.join(" | "));
  console.log(headers.map(() => "---").join(" | "));
  for (const row of rows) {
    console.log([
      row.check,
      row.expected,
      row.actual,
      row.status,
      row.cause,
    ].map((value) => String(value ?? "").replace(/\r?\n/g, " ").replace(/\|/g, "/")).join(" | "));
  }
}

async function main() {
  runStaticChecks();

  if (!databaseUrl) {
    addMatrix({
      check: "database-backed tenant matrix",
      expected: "DATABASE_URL or POSTGRES_URL is configured",
      actual: "missing database URL",
      ok: false,
      cause: "DB-backed tenant-isolation checks could not run",
    });
  } else {
    await runDbChecks();
  }

  console.log("TENANT_ISOLATION_MATRIX");
  printMarkdownTable(matrix);

  const failing = matrix.filter((row) => row.status === "rot");
  if (failing.length) {
    console.error(`\nTenant isolation diagnostics finished with ${failing.length} red row(s).`);
    process.exitCode = 1;
  } else {
    console.log("\nTenant isolation diagnostics finished green.");
  }
}

main().catch((error) => {
  console.error(`FAIL ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
