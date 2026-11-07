import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
function freeze(value) {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
export const sharedBehaviorMigrationContract = freeze(JSON.parse(readFileSync(new URL("../../config/shared-behavior-migration-contract.json", import.meta.url), "utf8")));
const digest = value => createHash("sha256").update(value).digest("hex");
const normalized = content => content.toString("utf8").replace(/\r\n/g, "\n");

/** Local source gate only. No network, credential, data or migration execution. */
export function assertSharedBehaviorMigrationSources({ cwd = resolve(import.meta.dirname, "../..") } = {}) {
  const contract = sharedBehaviorMigrationContract;
  assert.equal(contract.schemaVersion, "shared-behavior-migration-contract-v1");
  assert.equal(contract.rolloutMode, "MANUAL_EXACT_REVISION_ONLY");
  assert.equal(contract.steps.length, 4);
  assert.equal(contract.predecessor.version, "114_customer_workspace_provisioning");
  const prior = readFileSync(resolve(cwd, "migrations/" + contract.predecessor.version + ".sql"));
  assert.equal(digest(normalized(prior)), contract.predecessor.normalizedSqlSha256, "Actual114 predecessor source changed");
  const names = readdirSync(resolve(cwd, "migrations"));
  for (const [index, step] of contract.steps.entries()) {
    assert.equal(step.number, 115 + index);
    assert.match(step.version, /^11[5-8]_shared_behavior_[a-z0-9_]+$/);
    assert.equal(step.path, "migrations/" + step.version + ".sql");
    assert.equal(step.stagedPath, "migrations/staged/" + step.version.slice(4) + ".sql");
    assert.equal(step.requiredPredecessor, index === 0 ? contract.predecessor.version : contract.steps[index - 1].version);
    assert.deepEqual(names.filter(name => name.startsWith(step.number + "_")), [step.version + ".sql"], "Migration number collision");
    const staged = readFileSync(resolve(cwd, step.stagedPath));
    const regular = readFileSync(resolve(cwd, step.path));
    assert.equal(Buffer.compare(staged, regular), 0, "Regular migration differs from its unchanged staged source");
    assert.equal(digest(staged), step.rawSourceSha256, "Frozen staged source hash changed");
    assert.equal(digest(normalized(regular)), step.normalizedSqlSha256, "Verified SQL checksum changed");
  }
  return { status: "PASS_SOURCE_CONTRACT", predecessor: contract.predecessor.version,
    copiesByteIdentical: true, versions: contract.steps.map(step => step.version) };
}
/** Reuses the existing actual-schema QA ledger evidence; it performs no SQL. */
export function assertSharedBehaviorQaLedger(rows) {
  assert.ok(Array.isArray(rows));
  const relevant = rows.filter(row => /^11[5-8](?:_|$)/.test(row.version));
  assert.equal(relevant.length, 4, "Unexpected or duplicate QA migration number");
  assert.ok(relevant.every(row => sharedBehaviorMigrationContract.steps.some(step => step.version === row.version)), "Unknown QA migration version or numeric alias");
  for (const step of sharedBehaviorMigrationContract.steps) {
    const matches = rows.filter(row => row.version === step.version);
    assert.equal(matches.length, 1, "Missing or duplicate QA migration ledger reference");
    assert.equal(matches[0].checksum, step.normalizedSqlSha256, "QA ledger is bound to different SQL");
  }
  return { status: "PASS_EXISTING_QA_SQL_REFERENCE", versions: rows.filter(row =>
    sharedBehaviorMigrationContract.steps.some(step => step.version === row.version)).map(row => row.version) };
}
