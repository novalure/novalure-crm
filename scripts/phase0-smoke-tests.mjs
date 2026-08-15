import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

function readText(path) {
  return fs.readFileSync(path, "utf8");
}

function readJson(path) {
  return JSON.parse(readText(path));
}

test("Next.js app baseline scripts and versions are present", () => {
  const pkg = readJson("package.json");

  assert.equal(pkg.dependencies.next, "16.2.6");
  assert.equal(pkg.dependencies.react, "19.2.4");
  assert.equal(pkg.dependencies["react-dom"], "19.2.4");
  assert.equal(pkg.scripts.lint, "eslint");
  assert.equal(pkg.scripts.build, "next build");
});

test("core CRM database contract covers tenant-scoped production entities", () => {
  const schema = readText("src/lib/db/schema.ts");
  const initialMigration = readText("migrations/001_initial_novalure_crm.sql");
  const laterMigrations = [
    "migrations/013_analysis_bot_70_sprint.sql",
    "migrations/020_production_readiness_repair.sql",
    "migrations/027_broker_pipeline_preflights.sql",
    "migrations/028_contact_archiving.sql",
    "migrations/029_contact_owner_scope.sql",
    "migrations/030_novalure_growth_workspace.sql",
  ].map(readText).join("\n");

  for (const table of [
    "workspaces",
    "workspace_users",
    "workspace_lead_sources",
    "workspace_module_settings",
    "projects",
    "contacts",
    "leads",
    "deals",
    "tasks",
    "calendar_events",
    "funnels",
    "consent_records",
    "knowledge_sources",
    "bots",
    "audit_logs",
  ]) {
    assert.match(schema, new RegExp(`"${table}"`), `${table} is listed in src/lib/db/schema.ts`);
    assert.match(`${initialMigration}\n${laterMigrations}`, new RegExp(`create table(?: if not exists)? ${table}`), `${table} has a migration`);
  }

  for (const table of [
    "projects",
    "workspace_lead_sources",
    "workspace_module_settings",
    "contacts",
    "leads",
    "deals",
    "tasks",
    "calendar_events",
    "funnels",
    "consent_records",
    "knowledge_sources",
    "bots",
    "audit_logs",
  ]) {
    assert.match(
      `${initialMigration}\n${laterMigrations}`,
      new RegExp(`create table(?: if not exists)? ${table} \\([\\s\\S]*workspace_id`, "m"),
      `${table} is tenant scoped by workspace_id`,
    );
  }
});

test("server-side CRM route handlers use authorization helpers", () => {
  const routes = [
    "src/app/api/crm/core/route.ts",
    "src/app/api/crm/projects/route.ts",
    "src/app/api/crm/leads/route.ts",
    "src/app/api/crm/contacts/route.ts",
    "src/app/api/crm/deals/route.ts",
    "src/app/api/crm/tasks/route.ts",
    "src/app/api/crm/bots/route.ts",
  ];

  for (const route of routes) {
    const source = readText(route);
    assert.match(
      source,
      /requirePermission|requireProductCapability|requirePermissionAndProductCapability|resolveWorkspaceScopedSession/,
      `${route} gates access server-side`,
    );
  }
});

test("auth/session layer verifies users against persisted workspace users", () => {
  const sessionSource = readText("src/lib/auth/session.ts");

  assert.match(sessionSource, /novalure_session/, "signed session cookie is defined");
  assert.match(sessionSource, /workspace_users/, "session resolves persisted workspace users");
  assert.match(sessionSource, /workspace_id/, "session is bound to workspace_id");
  assert.match(sessionSource, /Forbidden/, "authorization failures return forbidden responses");
});
