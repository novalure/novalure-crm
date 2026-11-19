import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import test from "node:test";
import { assertSharedBehaviorMigrationSources, assertSharedBehaviorQaLedger, sharedBehaviorMigrationContract as contract } from "./lib/shared-behavior-migration-contract.mjs";
import { createMigrationPlan, isManualCutoverVersion } from "./db-migrate.mjs";
const root = resolve(import.meta.dirname, "..");
const qa = JSON.parse(readFileSync(resolve(root, "qa/shared-behavior-package3-personal-2026-10-27/actual-qa-migration-ledger.json"), "utf8"));
function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), "novalure-shared-behavior-contract-"));
  for (const path of ["migrations/" + contract.predecessor.version + ".sql", ...contract.steps.flatMap(step => [step.path, step.stagedPath])]) {
    mkdirSync(dirname(resolve(cwd, path)), { recursive: true }); copyFileSync(resolve(root, path), resolve(cwd, path));
  }
  return cwd;
}
function cleanup(cwd) {
  assert.equal(dirname(resolve(cwd)), resolve(tmpdir()));
  assert.ok(basename(cwd).startsWith("novalure-shared-behavior-contract-"));
  rmSync(cwd, { recursive: true, force: true });
}
test("numbered SQL is byte-identical and bound to the existing actual114 QA ledger", () => {
  assert.equal(assertSharedBehaviorMigrationSources().copiesByteIdentical, true);
  assert.equal(assertSharedBehaviorQaLedger(qa).status, "PASS_EXISTING_QA_SQL_REFERENCE");
});
test("source drift, coordinated copy drift, wrong114 and duplicate migration numbers fail closed", () => {
  for (const damage of ["regular", "both", "predecessor", "duplicate"]) {
    const cwd = fixture();
    try {
      const step = contract.steps[0];
      if (damage === "regular" || damage === "both") {
        writeFileSync(resolve(cwd, step.path), readFileSync(resolve(cwd, step.path), "utf8") + "\n-- unreviewed\n");
        if (damage === "both") writeFileSync(resolve(cwd, step.stagedPath), readFileSync(resolve(cwd, step.path)));
      }
      if (damage === "predecessor") writeFileSync(resolve(cwd, "migrations/" + contract.predecessor.version + ".sql"), "-- wrong predecessor\n");
      if (damage === "duplicate") writeFileSync(resolve(cwd, "migrations/115_unreviewed.sql"), "select 1;\n");
      assert.throws(() => assertSharedBehaviorMigrationSources({ cwd }));
    } finally { cleanup(cwd); }
  }
});
test("QA references reject another SQL revision, missing steps and duplicate ledger rows", () => {
  assert.throws(() => assertSharedBehaviorQaLedger(qa.slice(1)));
  assert.throws(() => assertSharedBehaviorQaLedger([...qa, qa[0]]));
  assert.throws(() => assertSharedBehaviorQaLedger([...qa, { ...qa[0], version: "115_unreviewed" }]));
  assert.throws(() => assertSharedBehaviorQaLedger([...qa, { ...qa[0], version: "115" }]));
  assert.throws(() => assertSharedBehaviorQaLedger(qa.map((row, index) => index ? row : { ...row, checksum: "0".repeat(64) })));
});
test("the regular runner keeps every step manual and enforces the exact114→115→116→117→118 chain", () => {
  const prior = { version: contract.predecessor.version, number: 114, checksum: contract.predecessor.normalizedSqlSha256 };
  const earlier = ["101_knowledge_center", "108_knowledge_connected_assistant_quota"].map(version => ({ version,
    number: Number(version.slice(0, 3)), checksum: createHash("sha256").update(readFileSync(resolve(root, "migrations/" + version + ".sql"))).digest("hex") }));
  const steps = contract.steps.map(step => ({ ...step, file: step.version + ".sql", checksum: step.normalizedSqlSha256, manualCutover: isManualCutoverVersion(step.version), rollback: false }));
  const migrations = [...earlier, prior, ...steps];
  const baseline = [...earlier, prior];
  const ledger = [...baseline];
  assert.ok(steps.every(step => step.manualCutover));
  assert.deepEqual(createMigrationPlan({ ledgerRows: ledger, migrations, only: "" }), []);
  assert.throws(() => createMigrationPlan({ allowManualCutover: true, ledgerRows: earlier, migrations, only: steps[0].version }), /required predecessor/);
  for (const step of steps) {
    assert.throws(() => createMigrationPlan({ ledgerRows: ledger, migrations, only: step.version }), /manual cutover/);
    if (step.number > 115) assert.throws(() => createMigrationPlan({ allowManualCutover: true, ledgerRows: baseline, migrations, only: step.version }), /required predecessor/);
    assert.deepEqual(createMigrationPlan({ allowManualCutover: true, ledgerRows: ledger, migrations, only: step.version }), [step]);
    ledger.push({ version: step.version, number: step.number, checksum: step.checksum });
  }
});
