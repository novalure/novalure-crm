#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const runtimeGrants = await readFile(
  new URL("../migrations/067_app_role_runtime_grants.sql", import.meta.url),
  "utf8",
);
const ledgerProjection = await readFile(
  new URL("../migrations/077_schema_ledger_runtime_projection.sql", import.meta.url),
  "utf8",
);

test("new runtime tables grant only the operations used by the app role", () => {
  assert.match(
    runtimeGrants,
    /grant select, insert, update on table media_asset_shares to novalure_app/i,
  );
  assert.match(
    runtimeGrants,
    /grant select, insert, update, delete on table oauth_authorization_states to novalure_app/i,
  );
});

test("runtime grant reconciliation does not weaken role separation", () => {
  assert.doesNotMatch(runtimeGrants, /novalure_schema_migrations/i);
  assert.doesNotMatch(runtimeGrants, /grant\s+all/i);
  assert.doesNotMatch(runtimeGrants, /alter\s+default\s+privileges/i);
  assert.doesNotMatch(runtimeGrants, /grant[^;]+on\s+all\s+tables/i);
});

test("schema-ledger runtime evidence preserves zero base-table access", () => {
  assert.match(ledgerProjection, /create or replace view public\.novalure_schema_migration_checksums/i);
  assert.match(ledgerProjection, /with \(security_barrier = true, security_invoker = false\)/i);
  assert.match(ledgerProjection, /select distinct\s+version,\s+checksum\s+from public\.novalure_schema_migrations/i);
  assert.match(ledgerProjection, /revoke all on table public\.novalure_schema_migration_checksums[\s\S]*from public, novalure_tenant_app, novalure_app/i);
  assert.match(ledgerProjection, /grant select on table public\.novalure_schema_migration_checksums\s+to novalure_app/i);
  for (const privilege of ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER", "MAINTAIN"]) {
    assert.match(
      ledgerProjection,
      new RegExp(`has_table_privilege\\('novalure_app', 'public\\.novalure_schema_migrations', '${privilege}'\\)`, "i"),
    );
  }
  for (const privilege of ["SELECT", "INSERT", "UPDATE", "REFERENCES"]) {
    assert.match(
      ledgerProjection,
      new RegExp(`has_any_column_privilege\\('novalure_app', 'public\\.novalure_schema_migrations', '${privilege}'\\)`, "i"),
    );
  }
  assert.match(ledgerProjection, /has_table_privilege\('novalure_app', projection_oid, 'SELECT WITH GRANT OPTION'\)/i);
  assert.match(ledgerProjection, /has_any_column_privilege\('novalure_app', projection_oid, 'SELECT WITH GRANT OPTION'\)/i);
  assert.match(ledgerProjection, /cross join lateral pg_catalog\.aclexplode\(attribute\.attacl\)/i);
  assert.match(ledgerProjection, /projection_owner is distinct from ledger_owner/i);
  assert.match(ledgerProjection, /pg_has_role\('novalure_app', projection_owner, 'MEMBER'\)/i);
  assert.match(ledgerProjection, /pg_has_role\('novalure_app', projection_owner, 'USAGE'\)/i);
  assert.doesNotMatch(ledgerProjection, /grant\s+select\s+on\s+table\s+public\.novalure_schema_migrations\b/i);
  assert.doesNotMatch(ledgerProjection, /security\s+definer/i);
  assert.doesNotMatch(ledgerProjection, /grant\s+all/i);
});
