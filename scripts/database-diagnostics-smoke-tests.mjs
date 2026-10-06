import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  databaseConnectionRetryDelayMs,
  getRetryableDatabaseConnectionReason,
  withDatabaseConnectionRetry,
} from "../src/lib/db/connection-retry.ts";

test("database diagnostics read the migration ledger dynamically and redact failures", async () => {
  const [source, health] = await Promise.all([
    readFile(new URL("../src/app/api/system/database/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/app/api/health/route.ts", import.meta.url), "utf8"),
  ]);

  assert.ok(source.indexOf("getRequestSession(request)") < source.indexOf("getDatabaseStatus()"));
  assert.match(source, /if \(!oneTimeProofAuthorized && !canViewSystemDiagnostics\(session\)\)/);
  assert.match(source, /NOVALURE_DATABASE_PROOF_TOKEN/);
  assert.match(source, /expected\.length < 32/);
  assert.match(source, /timingSafeEqual\(expectedBytes, suppliedBytes\)/);
  assert.match(source, /oneTimeProofAuthorized \? null : await getRequestSession\(request\)/);
  assert.match(source, /\{ error: "not_found" \}/);
  assert.match(source, /status: 404/);
  assert.doesNotMatch(source, /isProductionDiagnosticsRestricted|NOVALURE_RESTRICT_SYSTEM_DIAGNOSTICS/);
  assert.match(source, /from novalure_schema_migrations/i);
  assert.match(source, /order by version asc/i);
  assert.match(source, /checksum/);
  assert.match(source, /migrationStatus/);
  assert.match(source, /current_user as "currentUser"/);
  assert.match(source, /session_user as "sessionUser"/);
  assert.match(source, /current_database\(\) as "database"/);
  assert.match(source, /current_setting\('neon\.project_id', true\) as "neonProjectId"/);
  assert.match(source, /current_setting\('neon\.branch_id', true\) as "neonBranchId"/);
  assert.match(source, /runtime_role\.rolsuper as "superuser"/);
  assert.match(source, /runtime_role\.rolbypassrls as "bypassRls"/);
  assert.match(source, /session_role\.rolsuper as "sessionSuperuser"/);
  assert.match(source, /session_role\.rolbypassrls as "sessionBypassRls"/);
  assert.match(source, /pg_has_role\(session_role\.oid, candidate\.oid, 'SET'\)/);
  assert.match(source, /tenant_role\.rolname = 'novalure_tenant_app'/);
  assert.match(source, /\('seller_listings'\)/);
  assert.match(source, /relation\.relrowsecurity/);
  assert.match(source, /relation\.relforcerowsecurity/);
  assert.match(source, /runtime_database_identity_proof/);
  assert.match(source, /correlationId/);
  assert.match(source, /POSTGRES_NEON_PROJECT_ID/);
  assert.match(source, /bindingMatchesExpectedProject/);
  assert.match(source, /runtimeProofPass \? "PASS" : "FAIL"/);
  assert.match(source, /identity\.ownedOrInheritedPublicTables === 0/);
  assert.match(source, /identity\.reachableElevatedRoles === 0/);
  assert.match(source, /!identity\.forbiddenCompanyProfilesSelect/);
  assert.match(source, /identity\.requiredRlsTablesProtected/);
  assert.doesNotMatch(source, /resolveDatabaseUrl|DATABASE_URL|POSTGRES_URL|password/);
  assert.doesNotMatch(source, /request\.json\(|request\.text\(|searchParams/);
  assert.doesNotMatch(source, /migrations\/039_property_content_partial_unique_indexes/);
  assert.doesNotMatch(source, /error instanceof Error \? error\.message/);
  assert.match(health, /\{ ok: true \}/);
  assert.match(health, /"Cache-Control": "no-store"/);
  assert.doesNotMatch(health, /queryRows|getDatabaseStatus|novalure_schema_migrations/);
});

test("database connection retries are limited to explicit pre-query capacity failures", async () => {
  const permitError = new Error(
    'Server error: {"message":"Failed to acquire permit to connect to the database. Too many database connection attempts are currently ongoing.","neon:retryable":false}',
  );
  const controlPlaneError = new Error(
    'Server error: {"message":"Control plane request failed","neon:retryable":true}',
  );
  const businessError = Object.assign(new Error("duplicate key value violates unique constraint"), {
    code: "23505",
  });

  assert.equal(getRetryableDatabaseConnectionReason(permitError), "neon_connection_permit");
  assert.equal(getRetryableDatabaseConnectionReason(controlPlaneError), "neon_control_plane");
  assert.equal(getRetryableDatabaseConnectionReason({ code: "53300" }), "postgres_connection_capacity");
  assert.equal(getRetryableDatabaseConnectionReason(businessError), null);
  assert.equal(databaseConnectionRetryDelayMs(1, () => 0), 100);
  assert.equal(databaseConnectionRetryDelayMs(2, () => 0), 200);

  let attempts = 0;
  const retryEvents = [];
  const result = await withDatabaseConnectionRetry(
    async () => {
      attempts += 1;
      if (attempts < 3) throw permitError;
      return "ok";
    },
    {
      onRetry: (event) => retryEvents.push(event),
      random: () => 0,
      sleep: async () => {},
    },
  );

  assert.equal(result, "ok");
  assert.equal(attempts, 3);
  assert.deepEqual(retryEvents.map((event) => event.delayMs), [100, 200]);
});

test("database connection retry never repeats business or ambiguous transport failures", async () => {
  for (const error of [
    Object.assign(new Error("permission denied"), { code: "42501" }),
    Object.assign(new Error("duplicate key"), { code: "23505" }),
    new Error("fetch failed"),
    new Error('Server error: {"message":"Control plane request failed","neon:retryable":false}'),
  ]) {
    let attempts = 0;
    await assert.rejects(
      withDatabaseConnectionRetry(
        async () => {
          attempts += 1;
          throw error;
        },
        { sleep: async () => {} },
      ),
      error,
    );
    assert.equal(attempts, 1);
  }
});
