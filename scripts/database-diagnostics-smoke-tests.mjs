import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("database diagnostics read the migration ledger dynamically and redact failures", async () => {
  const [source, health] = await Promise.all([
    readFile(new URL("../src/app/api/system/database/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/app/api/health/route.ts", import.meta.url), "utf8"),
  ]);

  assert.ok(source.indexOf("getRequestSession(request)") < source.indexOf("getDatabaseStatus()"));
  assert.match(source, /if \(!canViewSystemDiagnostics\(session\)\)/);
  assert.match(source, /\{ error: "not_found" \}/);
  assert.match(source, /status: 404/);
  assert.doesNotMatch(source, /isProductionDiagnosticsRestricted|NOVALURE_RESTRICT_SYSTEM_DIAGNOSTICS/);
  assert.match(source, /from novalure_schema_migrations/i);
  assert.match(source, /order by version asc/i);
  assert.match(source, /checksum/);
  assert.match(source, /migrationStatus/);
  assert.doesNotMatch(source, /migrations\/039_property_content_partial_unique_indexes/);
  assert.doesNotMatch(source, /error instanceof Error \? error\.message/);
  assert.match(health, /\{ ok: true \}/);
  assert.match(health, /"Cache-Control": "no-store"/);
  assert.doesNotMatch(health, /queryRows|getDatabaseStatus|novalure_schema_migrations/);
});
