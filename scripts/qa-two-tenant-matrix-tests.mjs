import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import test from "node:test";
import {
  bootstrapPreviewShareCookies,
  createHttpClient,
  matchesQaRuntimeCapability,
  matchesQaRuntimeIdentity,
  validatePreviewShareUrl,
  verifyPreviewRuntimeIdentity,
} from "./qa-two-tenant-e2e.mjs";
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
  qaRuntimeDatabaseTargetDigest,
  qaTenantConstraintNames,
  qaTenantRelationNames,
  qaTwoTenantRequiredEnvironment,
} from "./lib/qa-two-tenant-matrix.mjs";
import { validateProtectedPreviewWorkflowContract } from "./qa-protected-preview-workflow-contract.mjs";

function uuid(value) {
  return `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
}

function validEnvironment() {
  const env = {
    NOVALURE_PRODUCTION_BRANCH_ID: "br-production-main-1234",
    NOVALURE_PRODUCTION_DATABASE_HOST: "prod-pooler.example.neon.tech",
    NOVALURE_PRODUCTION_PROJECT_ID: "production-project-1234",
    NOVALURE_PRODUCTION_ORIGIN: "https://www.novalure-crm.app",
    NOVALURE_QA_BASE_URL: "https://candidate.example.test",
    NOVALURE_QA_BRANCH_ID: "br-qa-isolated",
    NOVALURE_QA_DATABASE_HOST: "qa-pooler.example.neon.tech",
    NOVALURE_QA_DATABASE_NAME: "neondb",
    NOVALURE_QA_DATABASE_ROLE: "novalure_app",
    NOVALURE_QA_DATABASE_URL: "postgresql://novalure_app:unit-test-only@qa-pooler.example.neon.tech/neondb?sslmode=require",
    NOVALURE_QA_E2E_CLEANUP_CONFIRM: QA_CLEANUP_CONFIRMATION,
    NOVALURE_QA_E2E_WRITE_CONFIRM: QA_WRITE_CONFIRMATION,
    NOVALURE_QA_EXPECTED_DEPLOYMENT_ID: "dpl_1234567890abcdefghij",
    NOVALURE_QA_EXPECTED_GIT_BRANCH: "codex/go-live-remediation-20260822",
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
  assert.equal(config.expectedGitBranch, "codex/go-live-remediation-20260822");
});

test("two-tenant config requires an explicit codex Preview branch", () => {
  const missing = validEnvironment();
  delete missing.NOVALURE_QA_EXPECTED_GIT_BRANCH;
  assert.throws(() => parseQaTwoTenantConfig(missing), /NOVALURE_QA_EXPECTED_GIT_BRANCH/);

  const production = validEnvironment();
  production.NOVALURE_QA_EXPECTED_GIT_BRANCH = "main";
  assert.throws(() => parseQaTwoTenantConfig(production), /explicit codex\/ Preview branch/);
});

test("two-tenant config requires an exact Vercel Preview deployment id", () => {
  const missing = validEnvironment();
  delete missing.NOVALURE_QA_EXPECTED_DEPLOYMENT_ID;
  assert.throws(() => parseQaTwoTenantConfig(missing), /NOVALURE_QA_EXPECTED_DEPLOYMENT_ID/);

  const invalid = validEnvironment();
  invalid.NOVALURE_QA_EXPECTED_DEPLOYMENT_ID = "preview-latest";
  assert.throws(() => parseQaTwoTenantConfig(invalid), /exact Vercel deployment id/);
});

test("two-tenant config rejects production origin and production database target", () => {
  const env = validEnvironment();
  env.NOVALURE_QA_BASE_URL = env.NOVALURE_PRODUCTION_ORIGIN;
  env.NOVALURE_PRODUCTION_DATABASE_HOST = env.NOVALURE_QA_DATABASE_HOST;
  env.NOVALURE_PRODUCTION_PROJECT_ID = env.NOVALURE_QA_PROJECT_ID;
  env.NOVALURE_PRODUCTION_BRANCH_ID = env.NOVALURE_QA_BRANCH_ID;
  assert.throws(
    () => parseQaTwoTenantConfig(env),
    /must not equal NOVALURE_PRODUCTION_ORIGIN[\s\S]*project must not equal[\s\S]*branch must not equal[\s\S]*host must not equal/,
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

test("evidence output is constrained to the secret-free artifacts/qa tree", () => {
  for (const value of ["../outside", "artifacts/qa/../../outside", "C:/outside", "artifacts/qa//nested"]) {
    const env = validEnvironment();
    env.NOVALURE_QA_EVIDENCE_DIR = value;
    assert.throws(() => parseQaTwoTenantConfig(env), /must stay inside artifacts\/qa/);
  }
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

test("tenant relation gate rejects missing launch migrations through 079 and a blank checksum", () => {
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

  for (const version of [
    "075_public_funnel_visit_truth",
    "076_bot_webhook_durable_processing",
    "077_schema_ledger_runtime_projection",
    "078_company_profile_approval_integrity",
    "079_public_funnel_visit_role_boundary",
  ]) {
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
    "NOVALURE_QA_EXPECTED_DEPLOYMENT_ID",
    "NOVALURE_QA_EXPECTED_GIT_BRANCH",
    "NOVALURE_PRODUCTION_BRANCH_ID",
    "NOVALURE_PRODUCTION_DATABASE_HOST",
    "NOVALURE_PRODUCTION_PROJECT_ID",
  ]) assert(required.has(name));
});

test("runtime capability is bound to exact deployment id, host, Git branch, database branch and SHA", () => {
  const config = parseQaTwoTenantConfig(validEnvironment());
  const valid = {
    atomicRegistration: true,
    databaseBranchId: config.database.branchId,
    databaseLeastPrivilege: true,
    databaseRlsActive: true,
    databaseTargetDigest: qaRuntimeDatabaseTargetDigest(config.database),
    deploymentId: config.expectedDeploymentId,
    deploymentHost: new URL(config.baseUrl).hostname,
    gitBranch: config.expectedGitBranch,
    gitSha: config.expectedGitSha,
    header: "x-novalure-qa-batch-id",
    version: 2,
  };
  assert.equal(matchesQaRuntimeCapability(config, 200, valid), true);
  for (const [field, value] of [
    ["deploymentId", "dpl_abcdefghij1234567890"],
    ["deploymentHost", "other-preview.vercel.app"],
    ["gitBranch", "codex/other-candidate"],
    ["databaseBranchId", "br-other-isolated"],
    ["databaseLeastPrivilege", false],
    ["databaseRlsActive", false],
    ["databaseTargetDigest", `sha256:${"b".repeat(64)}`],
    ["gitSha", "b".repeat(40)],
  ]) {
    assert.equal(matchesQaRuntimeCapability(config, 200, { ...valid, [field]: value }), false, field);
  }
  assert.equal(matchesQaRuntimeCapability(config, 503, valid), false);
});

test("runtime identity mismatch stops after the public identity request with zero auth requests", async () => {
  const config = parseQaTwoTenantConfig(validEnvironment());
  const validIdentity = {
    databaseLeastPrivilege: true,
    databaseRlsActive: true,
    databaseTargetDigest: qaRuntimeDatabaseTargetDigest(config.database),
    deploymentHost: new URL(config.baseUrl).hostname,
    deploymentId: config.expectedDeploymentId,
    gitBranch: config.expectedGitBranch,
    gitSha: config.expectedGitSha,
    version: 2,
  };
  assert.equal(matchesQaRuntimeIdentity(config, 200, validIdentity), true);

  const calls = [];
  const evidence = { requests: [], results: [] };
  await assert.rejects(
    verifyPreviewRuntimeIdentity(config, evidence, new Map(), async (input) => {
      const url = new URL(input);
      calls.push(url.pathname);
      return Response.json({ ...validIdentity, deploymentId: "dpl_abcdefghij1234567890" });
    }),
    /runtime\.identity\.pre_auth failed/,
  );
  assert.deepEqual(calls, ["/api/admin/qa-runtime-identity"]);
  assert.equal(calls.some((item) => item.startsWith("/api/auth/")), false);
  assert.deepEqual(evidence.requests.map((item) => item.path), ["/api/admin/qa-runtime-identity"]);
});

test("runner orders public runtime identity and zero-session proof before login", () => {
  const harness = fs.readFileSync(new URL("./qa-two-tenant-e2e.mjs", import.meta.url), "utf8");
  const main = harness.slice(harness.indexOf("async function main()"));
  assert.ok(main.indexOf("verifyPreviewRuntimeIdentity(config") < main.indexOf("verifyDatabasePreflight(config"));
  assert.ok(main.indexOf("verifyDatabasePreflight(config") < main.indexOf("verifyHttpPreflight(config"));
  assert.match(harness, /active_sessions_before_login/);
  assert.match(harness, /session\.revoked_at is null[\s\S]*session\.expires_at > now\(\)/);
});

function validProtectedWorkflowEnvironment(overrides = {}) {
  const env = validEnvironment();
  env.NOVALURE_QA_BASE_URL = "https://candidate-preview.vercel.app";
  return {
    ...env,
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_REF: "refs/heads/main",
    GITHUB_REPOSITORY: "novalure/novalure-crm",
    GITHUB_SHA: "c".repeat(40),
    GITHUB_WORKFLOW_REF: "novalure/novalure-crm/.github/workflows/livegang-e2e.yml@refs/heads/main",
    NOVALURE_QA_VERCEL_SHARE_URL: "https://candidate-preview.vercel.app/?_vercel_share=workflow-share-token-1234567890",
    NOVALURE_WORKFLOW_CANDIDATE_BRANCH: env.NOVALURE_QA_EXPECTED_GIT_BRANCH,
    NOVALURE_WORKFLOW_CANDIDATE_SHA: env.NOVALURE_QA_EXPECTED_GIT_SHA,
    NOVALURE_WORKFLOW_CONFIRMATION: "RUN_EXACT_PROTECTED_PREVIEW_QA",
    NOVALURE_WORKFLOW_DEPLOYMENT_ID: env.NOVALURE_QA_EXPECTED_DEPLOYMENT_ID,
    NOVALURE_WORKFLOW_ENVIRONMENT: "go-live-preview",
    NOVALURE_WORKFLOW_NEON_BRANCH_ID: env.NOVALURE_QA_BRANCH_ID,
    NOVALURE_WORKFLOW_NEON_PROJECT_ID: env.NOVALURE_QA_PROJECT_ID,
    NOVALURE_WORKFLOW_PREVIEW_HOST: "candidate-preview.vercel.app",
    NOVALURE_WORKFLOW_PREVIEW_ORIGIN: "https://candidate-preview.vercel.app",
    NOVALURE_WORKFLOW_TRUSTED_HARNESS_SHA: "c".repeat(40),
    NOVALURE_WORKFLOW_TRUSTED_HARNESS_SHA_INPUT: "c".repeat(40),
    ...overrides,
  };
}

test("manual protected-Preview workflow contract binds every dispatched identity", () => {
  const valid = validProtectedWorkflowEnvironment();
  assert.equal(validateProtectedPreviewWorkflowContract(valid).candidateSha, valid.NOVALURE_QA_EXPECTED_GIT_SHA);
  for (const mismatch of [
    { GITHUB_EVENT_NAME: "push" },
    { NOVALURE_WORKFLOW_ENVIRONMENT: "production" },
    { GITHUB_REF: "refs/heads/codex/untrusted" },
    { GITHUB_SHA: "b".repeat(40) },
    { NOVALURE_WORKFLOW_TRUSTED_HARNESS_SHA_INPUT: "b".repeat(40) },
    { NOVALURE_WORKFLOW_CANDIDATE_BRANCH: "codex/other-preview" },
    { NOVALURE_WORKFLOW_DEPLOYMENT_ID: "dpl_abcdefghij1234567890" },
    { NOVALURE_WORKFLOW_NEON_PROJECT_ID: "different-preview-project" },
    { NOVALURE_WORKFLOW_NEON_BRANCH_ID: "br-different-preview" },
    { NOVALURE_WORKFLOW_PREVIEW_HOST: "other-preview.vercel.app" },
    { NOVALURE_QA_VERCEL_SHARE_URL: "https://vercel.com/share/candidate?_vercel_share=workflow-share-token-1234567890" },
  ]) {
    assert.throws(() => validateProtectedPreviewWorkflowContract({ ...valid, ...mismatch }));
  }

  const productionOrigin = validProtectedWorkflowEnvironment({
    NOVALURE_QA_BASE_URL: "https://www.novalure-crm.app",
    NOVALURE_WORKFLOW_PREVIEW_HOST: "www.novalure-crm.app",
    NOVALURE_WORKFLOW_PREVIEW_ORIGIN: "https://www.novalure-crm.app",
  });
  assert.throws(() => validateProtectedPreviewWorkflowContract(productionOrigin), /Vercel deployment|Production/);
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

test("Preview share URL validator is deployment-bound, HTTPS-only and parameter-exact", () => {
  const baseUrl = "https://candidate.example.test";
  const shareToken = "A_share-token-1234567890";
  assert.equal(
    validatePreviewShareUrl(`${baseUrl}/?_vercel_share=${shareToken}`, baseUrl).origin,
    baseUrl,
  );
  assert.equal(
    validatePreviewShareUrl(`https://vercel.com/share/candidate?_vercel_share=${shareToken}`, baseUrl).origin,
    "https://vercel.com",
  );

  for (const invalid of [
    `http://candidate.example.test/?_vercel_share=${shareToken}`,
    `https://other.example.test/?_vercel_share=${shareToken}`,
    `https://user:password@candidate.example.test/?_vercel_share=${shareToken}`,
    `https://candidate.example.test/private?_vercel_share=${shareToken}`,
    `https://candidate.example.test/?_vercel_share=${shareToken}&extra=1`,
    `https://candidate.example.test/?_vercel_share=${shareToken}&_vercel_share=${shareToken}`,
    `https://candidate.example.test/?_vercel_share=short`,
    `https://candidate.example.test/?_vercel_share=${shareToken}#fragment`,
  ]) {
    assert.throws(() => validatePreviewShareUrl(invalid, baseUrl), /Preview|Vercel|share/);
  }
  assert.throws(
    () => validatePreviewShareUrl(`${baseUrl}/?_vercel_share=${shareToken}`, `${baseUrl}/path?unsafe=1`),
    /base URL must be an HTTPS origin/,
  );
});

test("Preview share bootstrap keeps Vercel cookies origin-scoped and discards application cookies", async () => {
  const baseUrl = "https://candidate.example.test";
  const shareToken = "B_share-token-1234567890";
  const shareUrl = `https://vercel.com/share/candidate?_vercel_share=${shareToken}`;
  const calls = [];
  const redirect = (location, cookies = []) => {
    const headers = new Headers({ location });
    for (const cookie of cookies) headers.append("set-cookie", cookie);
    return new Response(null, { headers, status: 302 });
  };
  const fetchImplementation = async (input, init = {}) => {
    const url = new URL(input);
    calls.push({
      cookie: new Headers(init.headers ?? {}).get("cookie"),
      origin: url.origin,
      path: url.pathname,
      redirect: init.redirect,
    });
    if (calls.length === 1) {
      return redirect(`${baseUrl}/?_vercel_share=${shareToken}`, [
        "_vercel_landing=landing-cookie; Path=/; Secure; HttpOnly",
        "novalure_session=must-not-cross; Path=/; Secure; HttpOnly",
      ]);
    }
    if (calls.length === 2) {
      return redirect("/", [
        "_vercel_jwt=preview.jwt.value; Path=/; Secure; HttpOnly; SameSite=Lax",
        "novalure_session=must-not-bootstrap; Path=/; Secure; HttpOnly",
      ]);
    }
    return new Response("ok", { status: 200 });
  };

  const previewCookies = await bootstrapPreviewShareCookies(baseUrl, shareUrl, fetchImplementation);
  assert.deepEqual(calls, [
    { cookie: null, origin: "https://vercel.com", path: "/share/candidate", redirect: "manual" },
    { cookie: null, origin: baseUrl, path: "/", redirect: "manual" },
    { cookie: "_vercel_jwt=preview.jwt.value", origin: baseUrl, path: "/", redirect: "manual" },
  ]);
  assert.deepEqual([...previewCookies.entries()], [["_vercel_jwt", "preview.jwt.value"]]);
});

test("Preview share bootstrap rejects cross-origin redirects without exposing the share token", async () => {
  const baseUrl = "https://candidate.example.test";
  const shareToken = "C_share-token-1234567890";
  const shareUrl = `${baseUrl}/?_vercel_share=${shareToken}`;
  await assert.rejects(
    bootstrapPreviewShareCookies(baseUrl, shareUrl, async () => new Response(null, {
      headers: { location: "https://attacker.example.test/collect" },
      status: 302,
    })),
    (error) => {
      assert.match(error.message, /Cross-origin/);
      assert.doesNotMatch(error.message, new RegExp(shareToken));
      return true;
    },
  );
});

test("share stdin is rejected before plan or config validation and its value is never printed", () => {
  const script = fileURLToPath(new URL("./qa-two-tenant-e2e.mjs", import.meta.url));
  const shareToken = "D_share-token-1234567890";
  for (const mode of ["--plan", "--validate-config"]) {
    const result = spawnSync(process.execPath, [script, mode, "--share-url-stdin"], {
      encoding: "utf8",
      env: {},
      input: `https://candidate.example.test/?_vercel_share=${shareToken}\n`,
      timeout: 30_000,
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /allowed only in preflight or execute mode/);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, new RegExp(shareToken));
    assert.doesNotMatch(result.stderr, /Missing environment variables/);
  }
});

test("login challenge continuation forwards and rotates the stored challenge cookie", async (context) => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  const workspaceId = uuid(900);
  const userId = uuid(901);
  const redirect = (location, cookies = []) => {
    const headers = new Headers({ location });
    for (const cookie of cookies) headers.append("set-cookie", cookie);
    return new Response(null, { headers, status: 303 });
  };

  globalThis.fetch = async (input, init = {}) => {
    const headers = new Headers(init.headers ?? {});
    calls.push({
      body: init.body === undefined ? null : String(init.body),
      cookie: headers.get("cookie"),
      method: init.method ?? "GET",
      path: new URL(input).pathname,
    });
    if (calls.length === 1) {
      return redirect("/?step=workspace_selection", ["novalure_login_challenge=challenge-one; Path=/; HttpOnly"]);
    }
    if (calls.length === 2) {
      return redirect("/?step=mfa_verification", ["novalure_login_challenge=challenge-two; Path=/; HttpOnly"]);
    }
    if (calls.length === 3) {
      return redirect("/", [
        "novalure_login_challenge=; Path=/; Max-Age=0",
        "novalure_session=session-one; Path=/; HttpOnly",
      ]);
    }
    return new Response(JSON.stringify({
      user: { id: userId, productRole: "customer_owner", role: "owner" },
      workspace: { id: workspaceId },
    }), { headers: { "content-type": "application/json" }, status: 200 });
  };
  context.after(() => {
    globalThis.fetch = originalFetch;
  });

  const client = createHttpClient(
    { baseUrl: "https://candidate.example.test" },
    {
      appRole: "owner",
      email: "qa-owner@example.test",
      password: "unit-test-password",
      productRole: "customer_owner",
      totpSecret: "JBSWY3DPEHPK3PXP",
      userId,
    },
    { batchId: uuid(902), workspaceId },
    { requests: [] },
    new Map([["_vercel_jwt", "preview-protection"]]),
  );
  await client.login();

  assert.equal(calls.length, 4);
  assert.deepEqual(calls.map((call) => [call.method, call.path]), [
    ["POST", "/api/auth/login"],
    ["POST", "/api/auth/login"],
    ["POST", "/api/auth/login"],
    ["GET", "/api/auth/session"],
  ]);
  assert.equal(calls[0].cookie, "_vercel_jwt=preview-protection");
  assert.equal(calls[1].cookie, "_vercel_jwt=preview-protection; novalure_login_challenge=challenge-one");
  assert.equal(calls[2].cookie, "_vercel_jwt=preview-protection; novalure_login_challenge=challenge-two");
  assert.equal(calls[3].cookie, "_vercel_jwt=preview-protection; novalure_session=session-one");
  assert.equal(new URLSearchParams(calls[1].body).get("flow"), "challenge");
  assert.equal(new URLSearchParams(calls[2].body).get("flow"), "challenge");
});

test("unexpected login redirect diagnostics never expose raw query values", async (context) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(null, {
    headers: { location: "/?step=raw-secret-value&error=credential-leak" },
    status: 303,
  });
  context.after(() => {
    globalThis.fetch = originalFetch;
  });

  const client = createHttpClient(
    { baseUrl: "https://candidate.example.test" },
    {
      appRole: "owner",
      email: "qa-owner@example.test",
      password: "unit-test-password",
      productRole: "customer_owner",
      totpSecret: "JBSWY3DPEHPK3PXP",
      userId: uuid(910),
    },
    { batchId: uuid(911), workspaceId: uuid(912) },
    { requests: [] },
  );

  await assert.rejects(
    client.login(),
    (error) => {
      assert.equal(error.message, "Unexpected login challenge (step=unknown, error=unknown).");
      assert.doesNotMatch(error.message, /raw-secret-value|credential-leak/);
      return true;
    },
  );
});

test("legacy unclean E2E entry points are replaced by the batch-safe harness", () => {
  const packageJson = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const legacy = fs.readFileSync(new URL("./qa-livegang-api.mjs", import.meta.url), "utf8");
  const harness = fs.readFileSync(new URL("./qa-two-tenant-e2e.mjs", import.meta.url), "utf8");
  const matrixContract = fs.readFileSync(new URL("./lib/qa-two-tenant-matrix.mjs", import.meta.url), "utf8");
  const workflow = fs.readFileSync(new URL("../.github/workflows/livegang-e2e.yml", import.meta.url), "utf8");
  const localQaCommand = "node --env-file-if-exists=.env.qa-two-tenant.local scripts/qa-two-tenant-e2e.mjs";
  assert.equal(packageJson.scripts["test:e2e"], `${localQaCommand} --execute --share-url-stdin`);
  assert.equal(packageJson.scripts["qa:livegang:api"], `${localQaCommand} --execute --share-url-stdin`);
  assert.match(workflow, /node scripts\/qa-protected-preview-action-runner\.mjs/u);
  assert.doesNotMatch(workflow, /qa:livegang:reset/);
  assert.match(workflow, /^on:\s*\n\s+workflow_dispatch:/mu);
  assert.match(workflow, /environment:\s+go-live-preview/u);
  assert.match(workflow, /ref:\s+\$\{\{ inputs\.trusted_harness_sha \}\}/u);
  assert.match(workflow, /GITHUB_WORKFLOW_REF[\s\S]*refs\/heads\/main/u);
  assert.match(workflow, /NOVALURE_WORKFLOW_TRUSTED_HARNESS_SHA:\s+\$\{\{ vars\.NOVALURE_QA_TRUSTED_HARNESS_SHA \}\}/u);
  assert.match(workflow, /NOVALURE_QA_TWO_TENANT_ENV_B64:\s+\$\{\{ secrets\.NOVALURE_QA_TWO_TENANT_ENV_B64 \}\}/u);
  assert.match(workflow, /NOVALURE_QA_VERCEL_SHARE_URL:\s+\$\{\{ secrets\.NOVALURE_QA_VERCEL_SHARE_URL \}\}/u);
  assert.doesNotMatch(workflow, /base64\s+--decode|--env-file|GITHUB_ENV|\.env\.qa-two-tenant/u);
  assert.match(workflow, /Verify the exact secret-free upload allowlist/u);
  assert.match(workflow, /find "\$EVIDENCE_ROOT"[^\n]+-type f -links 1/u);
  assert.match(workflow, /if-no-files-found: error/u);
  assert.doesNotMatch(workflow, /path:\s*artifacts\/qa/u);
  assert.doesNotMatch(workflow, /127\.0\.0\.1|localhost|npm run start|pull_request:|push:/u);
  assert.doesNotMatch(workflow, /set -x|printenv|\benv\s*>/u);
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
  assert.match(harness, /capability\?\.atomicRegistration === true/);
  assert.match(harness, /identity\?\.deploymentHost === expectedDeploymentHost/);
  assert.match(harness, /identity\?\.gitBranch === config\.expectedGitBranch/);
  assert.match(harness, /capability\?\.databaseBranchId === config\.database\.branchId/);
  assert.match(harness, /identity\?\.gitSha === config\.expectedGitSha/);
  assert.match(harness, /identity\?\.databaseTargetDigest === qaRuntimeDatabaseTargetDigest\(config\.database\)/);
  assert.match(harness, /identity\?\.databaseRlsActive === true/);
  assert.match(harness, /identity\?\.databaseLeastPrivilege === true/);
  assert.match(harness, /\/api\/admin\/qa-runtime-identity/);
  assert.match(harness, /x-novalure-qa-batch-registration/);
  assert.match(harness, /--share-url-stdin/);
  assert.match(harness, /bootstrapPreviewShareCookies/);
  assert.doesNotMatch(harness, /x-vercel-protection-bypass/i);
  assert.match(harness, /qaRequiredMigrationVersions/);
  assert.match(harness, /evaluateQaTenantRelationGate/);
  assert.match(matrixContract, /073_launch_tenant_relation_guards/);
  assert.match(matrixContract, /074_validate_launch_tenant_relation_guards/);
  assert.match(matrixContract, /075_public_funnel_visit_truth/);
  assert.match(matrixContract, /076_bot_webhook_durable_processing/);
  assert.match(matrixContract, /077_schema_ledger_runtime_projection/);
  assert.match(matrixContract, /078_company_profile_approval_integrity/);
  assert.match(matrixContract, /079_public_funnel_visit_role_boundary/);
  assert.match(harness, /from public\.novalure_schema_migration_checksums/);
  assert.doesNotMatch(harness, /from (?:public\.)?novalure_schema_migrations/);
  assert.match(harness, /ledger_base_denied/);
  assert.match(harness, /ledger_projection_read_only/);
  assert.match(harness, /tenant_role_inherited/);
  assert.match(harness, /row_security_active\('public\.qa_batches'::regclass\)/);
  assert.match(harness, /row_security_active\('public\.qa_batch_objects'::regclass\)/);
  assert.match(harness, /relation\.relowner = ledger\.relowner/);
  assert.match(harness, /not pg_catalog\.pg_has_role\(current_user, relation\.relowner, 'MEMBER'\)/);
  assert.match(harness, /not pg_catalog\.pg_has_role\(current_user, relation\.relowner, 'USAGE'\)/);
  for (const privilege of ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER", "MAINTAIN"]) {
    assert.match(
      harness,
      new RegExp(`has_table_privilege\\(current_user, 'public\\.novalure_schema_migrations', '${privilege}'\\)`, "i"),
    );
  }
  for (const privilege of ["SELECT", "INSERT", "UPDATE", "REFERENCES"]) {
    assert.match(
      harness,
      new RegExp(`has_any_column_privilege\\(current_user, 'public\\.novalure_schema_migrations', '${privilege}'\\)`, "i"),
    );
  }
  assert.match(harness, /has_table_privilege\(current_user, 'public\.novalure_schema_migration_checksums', 'SELECT WITH GRANT OPTION'\)/i);
  assert.match(harness, /has_any_column_privilege\(current_user, 'public\.novalure_schema_migration_checksums', 'SELECT WITH GRANT OPTION'\)/i);
  assert.equal((harness.match(/where c\.workspace_id = \$\{tenant\.workspaceId\}::uuid/g) ?? []).length, 19);
  assert.match(harness, /migrations_launch_required_checksummed/);
  assert.match(harness, /launch_schema_artifacts_075_076/);
  assert.match(harness, /loadRequiredMigrationChecksums/);
  assert.match(harness, /tenant_constraints_validated/);
  assert.match(harness, /tenant_relation_preflight_zero/);
  assert.match(harness, /left join seller_listings p on p\.workspace_id = c\.workspace_id/);
});
