import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const script = path.join(repositoryRoot, "scripts", "qa-two-tenant-provision.mjs");
const baseEnv = {
  ...process.env,
  NOVALURE_QA_BRANCH_ID: "br-lucky-heart-alrm9dlw",
  NOVALURE_QA_PROJECT_ID: "weathered-term-98273025",
  NOVALURE_QA_PROVISION_CONFIRM: "PROVISION_ISOLATED_TWO_TENANT_QA",
};

function run(cwd, mode, env = baseEnv) {
  return spawnSync(process.execPath, [script, mode], {
    cwd,
    encoding: "utf8",
    env,
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
    assert.match(bundle, /^NOVALURE_ABUSE_SECRET=/m);
    assert.match(bundle, /^NOVALURE_AUTH_ENCRYPTION_KEY=/m);
    assert.match(bundle, /^NOVALURE_QA_TENANT_A_OWNER_PASSWORD=/m);
    assert.match(bundle, /^NOVALURE_QA_TENANT_B_CUSTOMER_TOTP_SECRET=/m);
    assert.match(bundle, /^NOVALURE_QA_RESET_WORKSPACE_IDS=[^,]+,[^,]+$/m);

    const plan = JSON.parse(await readFile(path.join(directory, ".env.qa-two-tenant-plan.local.json"), "utf8"));
    assert.equal(plan.schemaVersion, 1);
    assert.equal(plan.tenants.length, 2);
    const sql = plan.sqlStatements.join("\n");
    assert.match(sql, /insert into public\.workspaces/);
    assert.match(sql, /is_qa/);
    assert.match(sql, /insert into public\.qa_batches/);
    assert.equal((sql.match(/insert into public\.workspace_users/g) ?? []).length, 10);
    assert.equal((sql.match(/update public\.auth_identities/g) ?? []).length, 10);

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
