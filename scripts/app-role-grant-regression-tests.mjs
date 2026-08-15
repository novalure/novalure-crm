#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const runtimeGrants = await readFile(
  new URL("../migrations/067_app_role_runtime_grants.sql", import.meta.url),
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
