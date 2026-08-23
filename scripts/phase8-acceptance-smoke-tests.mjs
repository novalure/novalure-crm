import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

function readText(path) {
  return fs.readFileSync(path, "utf8");
}

test("fallback CRM data uses relative operational dates for the critical demo flows", () => {
  const data = readText("src/lib/crm-data.ts");

  assert.match(data, /function isoInHours/);
  assert.match(data, /function dueLabelInHours/);
  assert.match(data, /slaDueAt: isoInHours/);
  assert.match(data, /receivedAt: isoInHours/);
  assert.match(data, /due: dueLabelInHours/);
  assert.match(data, /startsAt: isoAtOffset|startsAt: isoInHours/);
  assert.doesNotMatch(data, /slaDueAt:\s*"2026-05/);
  assert.doesNotMatch(data, /due:\s*"Heute\s+\d/);
  assert.doesNotMatch(data, /expectedCloseDate:\s*"2026-05/);
  assert.doesNotMatch(data, /expiresAt:\s*"2026-05/);
});

test("QA seed is separated while the legacy root-deleting reset remains hard-disabled", () => {
  const seed = readText("scripts/qa-livegang-seed.mjs");
  const reset = readText("scripts/qa-livegang-reset.mjs");

  assert.match(seed, /qaSeed: "livegang-8-10"/);
  assert.match(seed, /now\(\) \+ interval '4 hours'/);
  assert.match(seed, /now\(\) \+ interval '1 day'/);
  assert.match(seed, /current_date \+ 30/);
  assert.match(seed, /QA Novalure Internal Workspace/);
  assert.match(seed, /QA Bautr/);
  assert.match(seed, /QA Makler Workspace/);
  assert.match(reset, /Legacy QA Livegang reset is disabled by DB-01/);
  assert.match(reset, /POST \/api\/admin\/qa-reset/);
  assert.doesNotMatch(reset, /@neondatabase\/serverless|delete from workspaces|delete from workspace_users/i);
});

test("all phase-level smoke tests are registered for repeatable acceptance", () => {
  const pkg = JSON.parse(readText("package.json"));

  for (let index = 0; index <= 8; index += 1) {
    assert.equal(typeof pkg.scripts[`test:phase${index}`], "string", `test:phase${index} is registered`);
  }

  assert.equal(typeof pkg.scripts["qa:livegang:api"], "string");
  assert.equal(typeof pkg.scripts["qa:livegang:reset"], "string");
});

test("Inventory writes have one Euro contract and persistent reset-safe replay ledgers", () => {
  const component = readText("src/components/unit-board.tsx");
  const route = readText("src/app/api/crm/units/route.ts");
  const repository = readText("src/lib/db/property-inventory-repositories.ts");
  const migration = readText("migrations/069_property_unit_idempotency.sql");
  const schema = readText("src/lib/db/schema.ts");
  const resetContract = readText("src/lib/qa-reset-contract.ts");

  assert.match(component, /name="priceEuros"/);
  assert.match(route, /priceEuros: input\.priceEuros/);
  assert.match(route, /"price" in input \|\| "priceCents" in input/);
  assert.match(repository, /parseEuroAmountToCents\(input\.priceEuros\)/);
  assert.match(repository, /cross join property_building_idempotency operation/);
  assert.match(repository, /insert into property_building_idempotency/);
  assert.match(repository, /cross join property_unit_idempotency operation/);
  assert.match(repository, /insert into property_unit_idempotency/);
  assert.match(migration, /unique \(workspace_id, idempotency_key\)/);
  assert.match(
    migration,
    /foreign key \(workspace_id, project_id, unit_id\)[\s\S]*references property_units\(workspace_id, project_id, id\)[\s\S]*on delete cascade/,
  );
  assert.match(migration, /create table if not exists property_building_idempotency/);
  assert.match(schema, /"property_unit_idempotency"/);
  assert.match(schema, /"property_building_idempotency"/);
  assert.match(resetContract, /qaResetCascadeOwnedTables[\s\S]*"property_unit_idempotency"/);
  assert.match(resetContract, /qaResetCascadeOwnedTables[\s\S]*"property_building_idempotency"/);
});

test("fresh-user onboarding tour has a persisted profile confirmation path", () => {
  const migration = readText("migrations/031_user_onboarding.sql");
  const databaseRoute = readText("src/app/api/system/database/route.ts");
  const seed = readText("scripts/qa-livegang-seed.mjs");
  const workflow = readText(".github/workflows/livegang-e2e.yml");
  const apiRoute = readText("src/app/api/auth/onboarding/route.ts");
  const tour = readText("src/components/workspace-onboarding-tour.tsx");
  const checklist = readText("src/lib/onboarding-checklist.ts");
  const workspace = readText("src/components/crm-workspace.tsx");

  assert.match(migration, /add column if not exists onboarding_completed_at timestamptz/);
  assert.match(migration, /add column if not exists onboarding_current_step text/);
  assert.match(migration, /add column if not exists onboarding_completed_steps text\[\] not null default '\{\}'/);
  assert.match(migration, /add column if not exists onboarding_skipped_steps text\[\] not null default '\{\}'/);
  assert.match(databaseRoute, /from public\.novalure_schema_migration_checksums/);
  assert.match(workflow, /Apply checksummed QA migrations[\s\S]*Seed two or more isolated QA workspaces/);
  assert.doesNotMatch(seed, /applyMigration\(/);
  assert.match(apiRoute, /select[\s\S]*onboarding_completed_at as "completedAt"/);
  assert.match(apiRoute, /onboarding_completed_at = case when \$8::boolean then coalesce\(onboarding_completed_at, now\(\)\)/);
  assert.match(apiRoute, /onboarding_step_forbidden/);
  assert.match(checklist, /team_invite/);
  assert.match(checklist, /roles_rights/);
  assert.match(checklist, /read_only_orientation/);
  assert.match(tour, /csrfFetch\("\/api\/auth\/onboarding"/);
  assert.match(tour, /Tour wiederholen/);
  assert.match(tour, /Diese Einführung erscheint einmal pro Nutzerprofil/);
  assert.match(tour, /Setup-Checkliste/);
  assert.match(tour, /Als erledigt markieren/);
  assert.doesNotMatch(tour, /Platzhalter zur Freigabe/);
  assert.doesNotMatch(tour, /Approval placeholder/);
  assert.match(workspace, /<WorkspaceOnboardingTour/);
  assert.match(workspace, /productRole=\{sessionProductRole\}/);
  assert.match(workspace, /technicalRole=\{sessionRole\}/);
});

test("production readiness reports exist for all implementation phases", () => {
  for (let index = 0; index <= 8; index += 1) {
    assert.equal(
      fs.existsSync(`docs/production-readiness-phase-${index}.md`),
      true,
      `phase ${index} report exists`,
    );
  }
});

test("phase 8 report contains the KO and score evidence required for final acceptance", () => {
  const report = readText("docs/production-readiness-phase-8.md");

  for (const criterion of ["K1", "K2", "K3", "K4", "K5", "K6", "K7"]) {
    assert.match(report, new RegExp(`\\| ${criterion} \\| gruen \\|`));
  }

  for (const score of ["Technik gesamt", "UX gesamt", "Immobilien-CRM-Fit", "Rollenlogik", "Persistenz/Speicherung"]) {
    assert.match(report, new RegExp(`\\| ${score} \\| 9[0-9]`));
  }
});
