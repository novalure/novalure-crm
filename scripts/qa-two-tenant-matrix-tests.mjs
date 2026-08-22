import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import test from "node:test";
import {
  assertEvidenceContainsNoSecrets,
  buildQaTwoTenantScenarioMatrix,
  canonicalJson,
  evaluateQaTenantRelationGate,
  parseQaTwoTenantConfig,
  QA_CLEANUP_CONFIRMATION,
  QA_WRITE_CONFIRMATION,
  qaLaunchSchemaArtifactNames,
  qaRequiredMigrationVersions,
  qaTenantConstraintNames,
  qaTenantRelationNames,
  qaTwoTenantRequiredEnvironment,
} from "./lib/qa-two-tenant-matrix.mjs";

function uuid(value) {
  return `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
}

function validEnvironment() {
  const env = {
    NOVALURE_PRODUCTION_DATABASE_HOST: "prod-pooler.example.neon.tech",
    NOVALURE_PRODUCTION_ORIGIN: "https://www.novalure-crm.app",
    NOVALURE_QA_BASE_URL: "https://candidate.example.test",
    NOVALURE_QA_BRANCH_ID: "br-qa-isolated",
    NOVALURE_QA_DATABASE_HOST: "qa-pooler.example.neon.tech",
    NOVALURE_QA_DATABASE_NAME: "neondb",
    NOVALURE_QA_DATABASE_ROLE: "novalure_app",
    NOVALURE_QA_DATABASE_URL: "postgresql://novalure_app:unit-test-only@qa-pooler.example.neon.tech/neondb?sslmode=require",
    NOVALURE_QA_E2E_CLEANUP_CONFIRM: QA_CLEANUP_CONFIRMATION,
    NOVALURE_QA_E2E_WRITE_CONFIRM: QA_WRITE_CONFIRMATION,
    NOVALURE_QA_EXPECTED_GIT_SHA: "a".repeat(40),
    NOVALURE_QA_PASSWORD: "unit-test-password",
    NOVALURE_QA_PROJECT_ID: "neon-project-qa",
    NOVALURE_QA_RESET_ADMIN_EMAIL: "qa-reset@example.test",
    NOVALURE_QA_RESET_ADMIN_TOTP_SECRET: "JBSWY3DPEHPK3PXP",
    NOVALURE_QA_RUN_PREFIX: "GOLIVETEST_20260822_MATRIX01",
  };
  let nextId = 1;
  for (const key of ["A", "B"]) {
    const prefix = `NOVALURE_QA_TENANT_${key}`;
    env[`${prefix}_WORKSPACE_ID`] = uuid(nextId++);
    env[`${prefix}_PROJECT_ID`] = uuid(nextId++);
    env[`${prefix}_BATCH_ID`] = uuid(nextId++);
    env[`${prefix}_BATCH_MARKER`] = `QA-TEST-20260822-120${key === "A" ? "1" : "2"}-matrix${key.toLowerCase()}1`;
    env[`${prefix}_PUBLIC_PATH`] = `/forms/qa-${key.toLowerCase()}`;
    env[`${prefix}_RESET_ACTOR_USER_ID`] = uuid(nextId++);
    for (const actor of ["OWNER", "ADMIN", "MEMBER", "CUSTOMER"]) {
      env[`${prefix}_${actor}_EMAIL`] = `qa-${key.toLowerCase()}-${actor.toLowerCase()}@example.test`;
      env[`${prefix}_${actor}_TOTP_SECRET`] = "JBSWY3DPEHPK3PXP";
      env[`${prefix}_${actor}_USER_ID`] = uuid(nextId++);
    }
  }
  return env;
}

test("two-tenant config accepts only explicit, isolated fixture identities", () => {
  const config = parseQaTwoTenantConfig(validEnvironment(), { requireExecution: true });
  assert.equal(config.tenants.length, 2);
  assert.notEqual(config.tenants[0].workspaceId, config.tenants[1].workspaceId);
  assert.equal(config.tenants[0].actors.owner.productRole, "customer_owner");
  assert.equal(config.tenants[0].actors.customer.productRole, "viewer");
});

test("two-tenant config rejects production origin and production database target", () => {
  const env = validEnvironment();
  env.NOVALURE_QA_BASE_URL = env.NOVALURE_PRODUCTION_ORIGIN;
  env.NOVALURE_PRODUCTION_DATABASE_HOST = env.NOVALURE_QA_DATABASE_HOST;
  assert.throws(
    () => parseQaTwoTenantConfig(env),
    /must not equal NOVALURE_PRODUCTION_ORIGIN[\s\S]*must not equal NOVALURE_PRODUCTION_DATABASE_HOST/,
  );
});

test("two-tenant config rejects duplicate tenant, batch, project and actor identities", () => {
  const env = validEnvironment();
  env.NOVALURE_QA_TENANT_B_WORKSPACE_ID = env.NOVALURE_QA_TENANT_A_WORKSPACE_ID;
  env.NOVALURE_QA_TENANT_B_PROJECT_ID = env.NOVALURE_QA_TENANT_A_PROJECT_ID;
  env.NOVALURE_QA_TENANT_B_BATCH_ID = env.NOVALURE_QA_TENANT_A_BATCH_ID;
  env.NOVALURE_QA_TENANT_B_OWNER_EMAIL = env.NOVALURE_QA_TENANT_A_OWNER_EMAIL;
  env.NOVALURE_QA_TENANT_B_OWNER_USER_ID = env.NOVALURE_QA_TENANT_A_OWNER_USER_ID;
  assert.throws(
    () => parseQaTwoTenantConfig(env),
    /workspace IDs must be distinct[\s\S]*project IDs must be distinct[\s\S]*batch IDs must be distinct[\s\S]*email addresses[\s\S]*user IDs must be globally distinct/,
  );
});

test("execution mode requires independent write and cleanup confirmations", () => {
  const env = validEnvironment();
  delete env.NOVALURE_QA_E2E_WRITE_CONFIRM;
  delete env.NOVALURE_QA_E2E_CLEANUP_CONFIRM;
  assert.throws(
    () => parseQaTwoTenantConfig(env, { requireExecution: true }),
    new RegExp(`${QA_WRITE_CONFIRMATION}[\\s\\S]*${QA_CLEANUP_CONFIRMATION}`),
  );
  assert.doesNotThrow(() => parseQaTwoTenantConfig(env, { requireExecution: false }));
});

test("scenario matrix covers both tenants, every role CRUD, isolation, persistence, concurrency and cleanup", () => {
  const matrix = buildQaTwoTenantScenarioMatrix();
  const ids = new Set(matrix.map((scenario) => scenario.id));
  assert.equal(ids.size, matrix.length);
  for (const tenant of ["a", "b"]) {
    for (const actor of ["owner", "admin", "member", "customer", "public"]) {
      for (const operation of ["create", "read", "update", "delete"]) {
        assert(ids.has(`${tenant}.contact.${actor}.${operation}`));
      }
    }
    for (const required of [
      `${tenant}.persistence.relogin`,
      `${tenant}.deal.idempotency`,
      `${tenant}.deal.concurrency`,
      `${tenant}.cleanup.dry_run`,
      `${tenant}.cleanup.execute`,
      `${tenant}.cleanup.remaining_rows`,
    ]) assert(ids.has(required));
  }
});

function validTenantRelationGateState() {
  const expectedMigrationChecksums = Object.fromEntries(
    qaRequiredMigrationVersions.map((version) => [version, "a".repeat(64)]),
  );
  return {
    constraintState: {
      deferrable: qaTenantConstraintNames.length,
      found: qaTenantConstraintNames.length,
      initiallyDeferred: qaTenantConstraintNames.length,
      validated: qaTenantConstraintNames.length,
    },
    expectedMigrationChecksums,
    migrations: qaRequiredMigrationVersions.map((version) => ({ checksum: "a".repeat(64), version })),
    schemaArtifacts: qaLaunchSchemaArtifactNames.map((artifact) => ({ artifact, ok: true })),
    violations: qaTenantRelationNames.map((relation) => ({ relation, violations: 0 })),
  };
}

test("tenant relation gate passes only the complete checksummed, validated and clean state", () => {
  const result = evaluateQaTenantRelationGate(validTenantRelationGateState());
  assert.equal(result.ok, true);
  assert.equal(result.migrationsChecksummed, true);
  assert.equal(result.schemaArtifactsValid, true);
  assert.equal(result.constraintsValidated, true);
  assert.equal(result.relationViolationsZero, true);
  assert.deepEqual(result.errors, []);
});

test("tenant relation gate rejects missing 073-076 and a blank checksum", () => {
  const missing073 = validTenantRelationGateState();
  missing073.migrations = missing073.migrations.filter((migration) => migration.version !== "073_launch_tenant_relation_guards");
  assert.match(
    evaluateQaTenantRelationGate(missing073).errors.join("\n"),
    /missing_migration:073_launch_tenant_relation_guards/,
  );

  const missing074 = validTenantRelationGateState();
  missing074.migrations = missing074.migrations.filter((migration) => migration.version !== "074_validate_launch_tenant_relation_guards");
  assert.match(
    evaluateQaTenantRelationGate(missing074).errors.join("\n"),
    /missing_migration:074_validate_launch_tenant_relation_guards/,
  );

  for (const version of ["075_public_funnel_visit_truth", "076_bot_webhook_durable_processing"]) {
    const missing = validTenantRelationGateState();
    missing.migrations = missing.migrations.filter((migration) => migration.version !== version);
    assert.match(
      evaluateQaTenantRelationGate(missing).errors.join("\n"),
      new RegExp(`missing_migration:${version}`),
    );
  }

  const blankChecksum = validTenantRelationGateState();
  blankChecksum.migrations.find((migration) => migration.version === "074_validate_launch_tenant_relation_guards").checksum = "";
  assert.match(
    evaluateQaTenantRelationGate(blankChecksum).errors.join("\n"),
    /migration_checksum_mismatch:074_validate_launch_tenant_relation_guards/,
  );

  const wrongButWellFormedChecksum = validTenantRelationGateState();
  wrongButWellFormedChecksum.migrations.find(
    (migration) => migration.version === "076_bot_webhook_durable_processing",
  ).checksum = "b".repeat(64);
  assert.match(
    evaluateQaTenantRelationGate(wrongButWellFormedChecksum).errors.join("\n"),
    /migration_checksum_mismatch:076_bot_webhook_durable_processing/,
  );
});

test("tenant relation gate requires every live 075/076 pg_catalog artifact check to pass", () => {
  const missing = validTenantRelationGateState();
  missing.schemaArtifacts = missing.schemaArtifacts.filter(
    (entry) => entry.artifact !== "075.index.expiry",
  );
  assert.match(
    evaluateQaTenantRelationGate(missing).errors.join("\n"),
    /missing_schema_artifact_check:075\.index\.expiry/,
  );

  const invalid = validTenantRelationGateState();
  invalid.schemaArtifacts.find(
    (entry) => entry.artifact === "076.audit.snapshot_without_fk",
  ).ok = false;
  const result = evaluateQaTenantRelationGate(invalid);
  assert.equal(result.schemaArtifactsValid, false);
  assert.match(
    result.errors.join("\n"),
    /invalid_schema_artifact:076\.audit\.snapshot_without_fk/,
  );
});

test("tenant relation gate rejects unvalidated constraints and any audited cross-tenant row", () => {
  const unvalidated = validTenantRelationGateState();
  unvalidated.constraintState.validated -= 1;
  assert.match(evaluateQaTenantRelationGate(unvalidated).errors.join("\n"), /tenant_constraints_unvalidated/);

  const violating = validTenantRelationGateState();
  violating.violations.find((entry) => entry.relation === "property_inquiries.contact").violations = 1;
  const violationResult = evaluateQaTenantRelationGate(violating);
  assert.equal(violationResult.ok, false);
  assert.equal(violationResult.violationTotal, 1);
  assert.match(violationResult.errors.join("\n"), /tenant_relation_violation:property_inquiries\.contact/);
});

test("evidence contract is canonical and rejects secret-shaped fields", () => {
  const first = canonicalJson({ z: 1, a: { y: 2, b: 3 } });
  const second = canonicalJson({ a: { b: 3, y: 2 }, z: 1 });
  assert.equal(first, second);
  assert.doesNotThrow(() => assertEvidenceContainsNoSecrets({ commit: "a".repeat(40), target: { workspace: "sha256:abc" } }));
  assert.throws(() => assertEvidenceContainsNoSecrets({ password: "must-never-be-written" }), /Secret-shaped evidence key/);
  assert.throws(() => assertEvidenceContainsNoSecrets({ nested: { databaseUrl: "must-never-be-written" } }), /Secret-shaped evidence key/);
});

test("required environment inventory includes every tenant role and safety target", () => {
  const required = new Set(qaTwoTenantRequiredEnvironment());
  for (const name of [
    "NOVALURE_QA_TENANT_A_OWNER_USER_ID",
    "NOVALURE_QA_TENANT_A_CUSTOMER_TOTP_SECRET",
    "NOVALURE_QA_TENANT_B_ADMIN_EMAIL",
    "NOVALURE_QA_TENANT_B_MEMBER_PASSWORD",
    "NOVALURE_QA_TENANT_B_RESET_ACTOR_USER_ID",
    "NOVALURE_PRODUCTION_DATABASE_HOST",
  ]) assert(required.has(name));
});

test("plan mode is offline, deterministic and contains no credential values", () => {
  const script = fileURLToPath(new URL("./qa-two-tenant-e2e.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [script, "--plan"], {
    encoding: "utf8",
    env: { ...process.env },
    timeout: 30_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /TWO_TENANT_QA_MATRIX/);
  assert.match(result.stdout, /No network or writes performed/);
  assert.doesNotMatch(result.stdout, /unit-test-password|postgresql:\/\//);
});

test("legacy unclean E2E entry points are replaced by the batch-safe harness", () => {
  const packageJson = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const legacy = fs.readFileSync(new URL("./qa-livegang-api.mjs", import.meta.url), "utf8");
  const harness = fs.readFileSync(new URL("./qa-two-tenant-e2e.mjs", import.meta.url), "utf8");
  const matrixContract = fs.readFileSync(new URL("./lib/qa-two-tenant-matrix.mjs", import.meta.url), "utf8");
  const workflow = fs.readFileSync(new URL("../.github/workflows/livegang-e2e.yml", import.meta.url), "utf8");
  const localQaCommand = "node --env-file-if-exists=.env.qa-two-tenant.local scripts/qa-two-tenant-e2e.mjs";
  assert.equal(packageJson.scripts["test:e2e"], `${localQaCommand} --execute`);
  assert.equal(packageJson.scripts["qa:livegang:api"], `${localQaCommand} --execute`);
  assert.match(workflow, /run:\s+npm run test:e2e/);
  assert.doesNotMatch(workflow, /qa:livegang:reset/);
  for (const [scriptName, mode] of [
    ["qa:two-tenant:plan", "--plan"],
    ["qa:two-tenant:validate", "--validate-config"],
    ["qa:two-tenant:preflight", "--preflight"],
    ["qa:two-tenant:execute", "--execute"],
  ]) {
    assert.equal(packageJson.scripts[scriptName], `${localQaCommand} ${mode}`);
  }
  assert.match(legacy, /Legacy QA Livegang API is disabled/);
  assert.match(legacy, /process\.exit\(1\)/);
  assert.match(harness, /capability\.json\?\.atomicRegistration === true/);
  assert.match(harness, /capability\.json\?\.gitSha === config\.expectedGitSha/);
  assert.match(harness, /x-novalure-qa-batch-registration/);
  assert.match(harness, /qaRequiredMigrationVersions/);
  assert.match(harness, /evaluateQaTenantRelationGate/);
  assert.match(matrixContract, /073_launch_tenant_relation_guards/);
  assert.match(matrixContract, /074_validate_launch_tenant_relation_guards/);
  assert.match(matrixContract, /075_public_funnel_visit_truth/);
  assert.match(matrixContract, /076_bot_webhook_durable_processing/);
  assert.match(harness, /migrations_checksummed_068_076/);
  assert.match(harness, /launch_schema_artifacts_075_076/);
  assert.match(harness, /loadRequiredMigrationChecksums/);
  assert.match(harness, /tenant_constraints_validated/);
  assert.match(harness, /tenant_relation_preflight_zero/);
  assert.match(harness, /left join seller_listings p on p\.workspace_id = c\.workspace_id/);
});
