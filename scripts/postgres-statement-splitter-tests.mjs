#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { splitPostgresStatements } from "./lib/postgres-statement-splitter.mjs";

const fixture = `
-- semicolon ; in a comment
create table example (value text default ';');
do $migration$
begin
  perform ';';
  perform 1;
end;
$migration$;
/* nested /* ; */ comment */
select E'escaped\\';still quoted' as value;
`;

const fixtureStatements = splitPostgresStatements(fixture);
assert.equal(fixtureStatements.length, 3);
assert.match(fixtureStatements[1], /perform 1;/);

for (const file of [
  "migrations/060_tenant_rls_pilot_prepare.sql",
  "migrations/061_validate_and_activate_tenant_rls_pilot.sql",
  "migrations/068_qa_batch_reset_safety.sql",
  "migrations/069_property_unit_idempotency.sql",
  "migrations/070_funnel_submission_idempotency_recovery.sql",
  "migrations/071_forms_owner_tenant_guard.sql",
  "migrations/072_form_submission_atomicity.sql",
  "migrations/073_launch_tenant_relation_guards.sql",
  "migrations/074_validate_launch_tenant_relation_guards.sql",
  "migrations/075_public_funnel_visit_truth.sql",
  "migrations/076_bot_webhook_durable_processing.sql",
]) {
  const statements = splitPostgresStatements(await readFile(file, "utf8"));
  assert.ok(statements.length > 0, `${file} should contain executable statements`);
  assert.ok(statements.every((statement) => statement.trim() && !statement.trim().endsWith(";")));
}

console.log("PostgreSQL statement splitter: passed");
