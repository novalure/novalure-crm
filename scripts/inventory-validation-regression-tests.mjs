#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  getInventoryValidationMessage,
  parseEuroAmountToCents,
  validateInventoryInput,
} from "../src/lib/inventory-validation.ts";

const projectId = "11111111-1111-4111-8111-111111111111";
const buildingId = "22222222-2222-4222-8222-222222222222";

test("building and unit required fields fail before persistence", () => {
  assert.deepEqual(validateInventoryInput("building", {}), [
    { code: "project_required", field: "projectId" },
    { code: "name_required", field: "name" },
  ]);
  assert.deepEqual(validateInventoryInput("unit", {}), [
    { code: "project_required", field: "projectId" },
    { code: "unit_number_required", field: "unitNumber" },
  ]);
  assert.equal(
    getInventoryValidationMessage("project_required", "de"),
    "Bitte wählen Sie ein Projekt aus.",
  );
});

test("server validation rejects malformed ids and numeric coercion", () => {
  assert.deepEqual(
    validateInventoryInput(
      "unit",
      {
        areaSqm: "not-a-number",
        buildingId: "outside-scope",
        floor: "1.5",
        priceEuros: "-1",
        projectId: "not-a-project",
        rooms: "101",
        unitNumber: "A-1",
      },
      { requireUuidIds: true },
    ).map(({ code, field }) => `${field}:${code}`),
    [
      "projectId:project_invalid",
      "buildingId:building_invalid",
      "floor:floor_invalid",
      "rooms:rooms_invalid",
      "areaSqm:area_invalid",
      "priceEuros:price_invalid",
    ],
  );
});

test("valid building and unit drafts pass the same shared validator", () => {
  assert.deepEqual(
    validateInventoryInput(
      "building",
      { floors: "8", name: "QA building", projectId },
      { requireUuidIds: true },
    ),
    [],
  );
  assert.deepEqual(
    validateInventoryInput(
      "unit",
      {
        areaSqm: "82.5",
        buildingId,
        floor: "2",
        priceEuros: "450000",
        projectId,
        rooms: "3.5",
        unitNumber: "A-12",
      },
      { requireUuidIds: true },
    ),
    [],
  );
});

test("Unit Euro contract converts 1.5 million Euros to 150 million cents exactly", () => {
  assert.equal(parseEuroAmountToCents(1_500_000), 150_000_000);
  assert.equal(parseEuroAmountToCents("1500000"), 150_000_000);
  assert.equal(parseEuroAmountToCents("1500000.25"), 150_000_025);
  assert.equal(parseEuroAmountToCents("1500000.001"), null);
});

test("UI, route and repository share validation, focus errors and DB-backed replay guards", async () => {
  const [component, migration, route, repository] = await Promise.all([
    readFile(new URL("../src/components/unit-board.tsx", import.meta.url), "utf8"),
    readFile(new URL("../migrations/069_property_unit_idempotency.sql", import.meta.url), "utf8"),
    readFile(new URL("../src/app/api/crm/units/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/lib/db/property-inventory-repositories.ts", import.meta.url), "utf8"),
  ]);

  assert.match(component, /validateInventoryInput\(inventoryMode, inventoryDraft\)/);
  assert.match(component, /inventorySubmissionInFlight\.current/);
  assert.match(component, /inventoryOperationRef\.current/);
  assert.match(component, /"Idempotency-Key": inventoryOperationRef\.current\.id/);
  assert.match(component, /document\.getElementById\(`inventory-\$\{firstError\.field\}`\)\?\.focus\(\)/);
  assert.match(component, /noValidate onSubmit=\{submitInventory\}/);
  assert.match(component, /aria-invalid=\{Boolean\(inventoryFieldErrors\.projectId\)/);
  assert.match(component, /role=\{inventoryNotice\.kind === "error" \? "alert" : "status"\}/);

  assert.match(route, /operationValue !== "building" && operationValue !== "unit"/);
  assert.match(route, /validateInventoryInput\(operation, input, \{ requireUuidIds: true \}\)/);
  assert.match(route, /request\.headers\.get\("idempotency-key"\)/);
  assert.match(route, /priceEuros: input\.priceEuros/);
  assert.match(route, /"price" in input \|\| "priceCents" in input/);
  assert.match(route, /status: result\.conflict \? 409 : 400/);
  assert.match(repository, /validateInventoryInput\("building", input, \{ requireUuidIds: true \}\)/);
  assert.match(repository, /validateInventoryInput\("unit", input, \{ requireUuidIds: true \}\)/);
  assert.match(repository, /pg_advisory_xact_lock/);
  assert.match(repository, /withTenantTransaction/);
  assert.ok((repository.match(/await transaction\.execute\([\s\S]*?pg_advisory_xact_lock/g) ?? []).length >= 2);
  assert.ok((repository.match(/transaction\.queryOne<(?:Building|Unit)OperationRow>/g) ?? []).length >= 2);
  assert.ok((repository.match(/insert into audit_logs/g) ?? []).length >= 2);
  assert.doesNotMatch(repository, /writeAuditLog/);
  assert.doesNotMatch(repository, /metadata->>'idempotencyKey'/);
  assert.match(repository, /cross join property_building_idempotency operation/);
  assert.match(repository, /insert into property_building_idempotency/);
  assert.match(repository, /different building request/);
  assert.match(repository, /cross join property_unit_idempotency operation/);
  assert.match(repository, /insert into property_unit_idempotency/);
  assert.match(repository, /not exists \(select 1 from existing_operation\)/);
  assert.match(repository, /row\.requestHash !== requestHash/);
  assert.match(repository, /different unit request/);
  assert.doesNotMatch(repository, /parsed > 999_999/);
  assert.doesNotMatch(repository, /priceCents\?: unknown/);
  assert.match(migration, /id uuid primary key default gen_random_uuid\(\)/);
  assert.match(migration, /unique \(workspace_id, idempotency_key\)/);
  assert.match(
    migration,
    /foreign key \(workspace_id, project_id, unit_id\)[\s\S]*references property_units\(workspace_id, project_id, id\)[\s\S]*on delete cascade/,
  );
  assert.match(migration, /create table if not exists property_building_idempotency/);
  assert.match(
    migration,
    /foreign key \(workspace_id, project_id, building_id\)[\s\S]*references property_buildings\(workspace_id, project_id, id\)[\s\S]*on delete cascade/,
  );
  assert.match(migration, /request_hash text not null/);
  assert.match(migration, /response jsonb not null/);
  assert.match(migration, /revoke all on table property_unit_idempotency from public/);
  assert.match(migration, /revoke all on table property_unit_idempotency from novalure_tenant_app/);
  assert.match(migration, /revoke all on table property_building_idempotency from novalure_tenant_app/);
  assert.doesNotMatch(migration, /grant select, insert on table property_unit_idempotency to novalure_tenant_app/);
  assert.doesNotMatch(migration, /grant select, insert on table property_building_idempotency to novalure_tenant_app/);
  assert.doesNotMatch(repository, /cleanString\(input\.name\) \|\| "Gebäude"/);
});
