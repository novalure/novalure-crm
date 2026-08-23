import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const script = path.join(repositoryRoot, "scripts", "qa-two-tenant-provision.mjs");
const { verifyOwnerOnlySecretFile, writeSecretFile } = await import("./qa-two-tenant-provision.mjs");
const baseEnv = {
  ...process.env,
  NOVALURE_PRODUCTION_BRANCH_ID: "br-production-main-1234",
  NOVALURE_PRODUCTION_DATABASE_HOST: "prod-pooler.example.neon.tech",
  NOVALURE_PRODUCTION_PROJECT_ID: "production-project-1234",
  NOVALURE_QA_BRANCH_ID: "br-lucky-heart-alrm9dlw",
  NOVALURE_QA_DATABASE_HOST: "qa-pooler.example.neon.tech",
  NOVALURE_QA_DATABASE_NAME: "neondb",
  NOVALURE_QA_EXPECTED_GIT_BRANCH: "codex/go-live-remediation-20260822",
  NOVALURE_QA_EXPECTED_GIT_SHA: "a".repeat(40),
  NOVALURE_QA_PROJECT_ID: "weathered-term-98273025",
  NOVALURE_QA_PROVISION_CONFIRM: "PROVISION_ISOLATED_TWO_TENANT_QA",
};

function run(cwd, mode, env = baseEnv, input) {
  return spawnSync(process.execPath, [script, mode], {
    cwd,
    encoding: "utf8",
    env,
    input,
  });
}

function runtimeBinding(overrides = {}) {
  const { database: databaseOverrides = {}, ...rootOverrides } = overrides;
  return JSON.stringify({
    baseUrl: "https://candidate-preview.vercel.app",
    confirmation: "BIND_EXACT_PREVIEW_RUNTIME",
    database: {
      branchId: baseEnv.NOVALURE_QA_BRANCH_ID,
      databaseName: "neondb",
      host: "qa-pooler.example.neon.tech",
      projectId: baseEnv.NOVALURE_QA_PROJECT_ID,
      role: "novalure_app",
      url: "postgresql://novalure_app:unit-test-runtime-secret@qa-pooler.example.neon.tech/neondb?sslmode=require",
      ...databaseOverrides,
    },
    deploymentId: "dpl_1234567890abcdefghij",
    evidenceDirectory: "artifacts/qa/final-candidate-runtime",
    productionDatabase: {
      branchId: baseEnv.NOVALURE_PRODUCTION_BRANCH_ID,
      host: baseEnv.NOVALURE_PRODUCTION_DATABASE_HOST,
      projectId: baseEnv.NOVALURE_PRODUCTION_PROJECT_ID,
    },
    schemaVersion: 2,
    ...rootOverrides,
  });
}

test("provisioning generates a secret local bundle without printing credentials", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "novalure-qa-provision-"));
  try {
    const generated = run(directory, "generate");
    assert.equal(generated.status, 0, generated.stderr);
    const output = JSON.parse(generated.stdout);
    assert.equal(output.statementCount > 20, true);
    assert.equal(output.tenants.length, 2);
    assert.doesNotMatch(generated.stdout, /PASSWORD|TOTP|ENCRYPTION|DATABASE_URL|ABUSE_SECRET/);

    const bundle = await readFile(path.join(directory, ".env.qa-two-tenant.local"), "utf8");
    await verifyOwnerOnlySecretFile(path.join(directory, ".env.qa-two-tenant.local"));
    assert.match(bundle, /^NOVALURE_ABUSE_SECRET=/m);
    assert.match(bundle, /^NOVALURE_AUTH_ENCRYPTION_KEY=/m);
    assert.match(bundle, /^NOVALURE_QA_TENANT_A_OWNER_PASSWORD=/m);
    assert.match(bundle, /^NOVALURE_QA_TENANT_B_CUSTOMER_TOTP_SECRET=/m);
    assert.match(bundle, /^NOVALURE_QA_RESET_WORKSPACE_IDS=[^,]+,[^,]+$/m);
    assert.match(bundle, /^NOVALURE_QA_EXPECTED_GIT_BRANCH=codex\/go-live-remediation-20260822$/m);
    assert.match(bundle, new RegExp(`^NOVALURE_QA_EXPECTED_GIT_SHA=${"a".repeat(40)}$`, "m"));
    assert.match(bundle, /^NOVALURE_PRODUCTION_WORKSPACE_IDS=[^,]+,[^,]+$/m);

    const plan = JSON.parse(await readFile(path.join(directory, ".env.qa-two-tenant-plan.local.json"), "utf8"));
    await verifyOwnerOnlySecretFile(path.join(directory, ".env.qa-two-tenant-plan.local.json"));
    assert.equal(plan.schemaVersion, 2);
    assert.equal(plan.transactionRequired, true);
    assert.equal(plan.expectedGitBranch, "codex/go-live-remediation-20260822");
    assert.equal(plan.expectedGitSha, "a".repeat(40));
    assert.equal(plan.tenants.length, 2);
    assert.match(plan.sqlStatements[0], /^do \$novalure_qa_fixture_target_guard\$/);
    assert.doesNotMatch(plan.sqlStatements[0], /insert|update|delete/i);
    const sql = plan.sqlStatements.join("\n");
    assert.match(plan.sqlStatements[0], /current_setting\('neon\.project_id'/);
    assert.match(plan.sqlStatements[0], /current_setting\('neon\.branch_id'/);
    assert.match(plan.sqlStatements[0], /current_database\(\)/);
    assert.match(plan.sqlStatements[0], new RegExp(baseEnv.NOVALURE_PRODUCTION_PROJECT_ID));
    assert.match(plan.sqlStatements[0], new RegExp(baseEnv.NOVALURE_PRODUCTION_BRANCH_ID));
    assert.match(sql, /insert into public\.workspaces/);
    assert.match(sql, /is_qa/);
    assert.match(sql, /insert into public\.qa_batches/);
    assert.match(sql, new RegExp(`"candidate":"${"a".repeat(40)}"`));
    assert.equal((sql.match(/insert into public\.workspace_users/g) ?? []).length, 10);
    assert.equal((sql.match(/update public\.auth_identities/g) ?? []).length, 10);
    assert.equal((sql.match(/update public\.auth_sessions session/g) ?? []).length, 10);
    assert.equal((sql.match(/auth\.qa_fixture\.credentials_rotated/g) ?? []).length, 10);
    assert.equal((sql.match(/update public\.auth_login_challenges challenge/g) ?? []).length, 10);

    const duplicate = run(directory, "generate");
    assert.notEqual(duplicate.status, 0);
    assert.match(duplicate.stderr, /already exists/i);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("provisioning fails closed without exact target confirmation", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "novalure-qa-provision-"));
  try {
    const result = run(directory, "generate", {
      ...baseEnv,
      NOVALURE_QA_PROVISION_CONFIRM: "yes",
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /must equal PROVISION_ISOLATED_TWO_TENANT_QA/);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("secret file protection failure deletes the file before returning", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "novalure-qa-provision-"));
  const target = path.join(directory, ".env.qa-two-tenant-protection-test");
  try {
    await assert.rejects(
      writeSecretFile(target, "must-not-remain", {
        protect: async () => {
          throw new Error("simulated owner-only ACL failure");
        },
      }),
      /simulated owner-only ACL failure/,
    );
    await assert.rejects(access(target), (error) => error?.code === "ENOENT");
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("generation is atomic when the plan target already exists", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "novalure-qa-provision-"));
  const planPath = path.join(directory, ".env.qa-two-tenant-plan.local.json");
  const bundlePath = path.join(directory, ".env.qa-two-tenant.local");
  try {
    await writeFile(planPath, "pre-existing", "utf8");
    const generated = run(directory, "generate");
    assert.notEqual(generated.status, 0);
    assert.equal(await readFile(planPath, "utf8"), "pre-existing");
    await assert.rejects(access(bundlePath), (error) => error?.code === "ENOENT");
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("provisioning rejects overlap with independent Production target identities", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "novalure-qa-provision-"));
  try {
    for (const overlap of [
      { NOVALURE_PRODUCTION_PROJECT_ID: baseEnv.NOVALURE_QA_PROJECT_ID },
      { NOVALURE_PRODUCTION_BRANCH_ID: baseEnv.NOVALURE_QA_BRANCH_ID },
      { NOVALURE_PRODUCTION_DATABASE_HOST: baseEnv.NOVALURE_QA_DATABASE_HOST },
    ]) {
      const result = run(directory, "generate", { ...baseEnv, ...overlap });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /must be independently distinct/);
    }
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("provisioning requires every independent Production deny-target identity", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "novalure-qa-provision-"));
  try {
    for (const name of [
      "NOVALURE_PRODUCTION_PROJECT_ID",
      "NOVALURE_PRODUCTION_BRANCH_ID",
      "NOVALURE_PRODUCTION_DATABASE_HOST",
    ]) {
      const env = { ...baseEnv };
      delete env[name];
      const result = run(directory, "generate", env);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, new RegExp(`${name} is required`));
    }
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("runtime binding adds only exact deployment and database targets without printing the database URL", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "novalure-qa-provision-"));
  try {
    const generated = run(directory, "generate");
    assert.equal(generated.status, 0, generated.stderr);
    const bound = run(directory, "bind-runtime", baseEnv, runtimeBinding());
    assert.equal(bound.status, 0, bound.stderr);
    assert.doesNotMatch(`${bound.stdout}\n${bound.stderr}`, /unit-test-runtime-secret|postgresql:/i);
    const result = JSON.parse(bound.stdout);
    assert.equal(result.bound, true);
    assert.equal(result.deploymentId, "dpl_1234567890abcdefghij");

    const bundle = await readFile(path.join(directory, ".env.qa-two-tenant.local"), "utf8");
    assert.match(bundle, /^NOVALURE_QA_EXPECTED_DEPLOYMENT_ID=dpl_1234567890abcdefghij$/m);
    assert.match(bundle, /^NOVALURE_QA_BASE_URL=https:\/\/candidate-preview\.vercel\.app$/m);
    assert.match(bundle, /^NOVALURE_QA_DATABASE_URL=postgresql:\/\/novalure_app:unit-test-runtime-secret@/m);
    assert.equal((bundle.match(/^NOVALURE_QA_DATABASE_URL=/gm) ?? []).length, 1);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("runtime binding rejects target drift without changing the secret bundle", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "novalure-qa-provision-"));
  try {
    const generated = run(directory, "generate");
    assert.equal(generated.status, 0, generated.stderr);
    const bundlePath = path.join(directory, ".env.qa-two-tenant.local");
    const before = await readFile(bundlePath, "utf8");
    const rejected = run(directory, "bind-runtime", baseEnv, runtimeBinding({
      database: { branchId: "br-unexpected-preview" },
    }));
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /does not match the generated fixture plan/);
    assert.equal(await readFile(bundlePath, "utf8"), before);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("runtime binding rejects Production deny-target drift without changing the secret bundle", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "novalure-qa-provision-"));
  try {
    const generated = run(directory, "generate");
    assert.equal(generated.status, 0, generated.stderr);
    const bundlePath = path.join(directory, ".env.qa-two-tenant.local");
    const before = await readFile(bundlePath, "utf8");
    const rejected = run(directory, "bind-runtime", baseEnv, runtimeBinding({
      productionDatabase: {
        branchId: baseEnv.NOVALURE_PRODUCTION_BRANCH_ID,
        host: "alternate-prod-pooler.example.neon.tech",
        projectId: baseEnv.NOVALURE_PRODUCTION_PROJECT_ID,
      },
    }));
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /preserve distinct Production/);
    assert.equal(await readFile(bundlePath, "utf8"), before);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("provisioning fails closed without the exact final candidate SHA", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "novalure-qa-provision-"));
  try {
    const env = { ...baseEnv };
    delete env.NOVALURE_QA_EXPECTED_GIT_SHA;
    const result = run(directory, "generate", env);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /NOVALURE_QA_EXPECTED_GIT_SHA is required/);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("provisioning fails closed without the exact final candidate branch", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "novalure-qa-provision-"));
  try {
    const env = { ...baseEnv };
    delete env.NOVALURE_QA_EXPECTED_GIT_BRANCH;
    const result = run(directory, "generate", env);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /NOVALURE_QA_EXPECTED_GIT_BRANCH is required/);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});
