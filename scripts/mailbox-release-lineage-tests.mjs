import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createMigrationPlan, isManualCutoverVersion, validateMigrationPlan } from "./db-migrate.mjs";

const entries = [
  ["167_crm_partner_cooperation", "ceb4c8924613a212a1d47f05f083e2482ebfa2e16a30294da7779a2e92a36963"],
  ["170_crm_personal_mailbox", "1cf5a164c6bcac6330b1839db01a9d5e53d75744c30fff819506cb274eb7624a"],
  ["182_personal_mailbox_sync", "fb69d00ea24df4eea3cf9bcc2e023deac8219d73fedd68c83bc63fd0bc531786"],
  ["212_mailbox_verified_microsoft_identity", "d1bdb3c4cc3a286366d0adcb846f2158fb2e62a3ce7f025622ba731044b38cf7"],
  ["213_mailbox_contact_review", "adec62fefd88336bd34c8dc697d5d812ea8bb5340b6b74145e54a8c3e7f4e4ec"],
];
const migrations = entries.map(([version, checksum]) => ({ version, checksum,
  number: Number(version.slice(0, 3)), name: version.slice(4), file: `${version}.sql`,
  path: `migrations/${version}.sql`, content: readFileSync(new URL(`../migrations/${version}.sql`, import.meta.url), "utf8"),
  manualCutover: isManualCutoverVersion(version), rollback: false }));
const row = (entry, checksum = entry.checksum) => ({version: entry.version, number:entry.number, checksum});
const baseline = migrations.slice(0, 3).map((x) => row(x));
const [identity, review] = migrations.slice(3);
const plan = (target, rows = baseline, allow = true) => createMigrationPlan({
  allowManualCutover: allow, ledgerRows: rows, migrations, only: target.version,
});

test("both mailbox migrations are explicit manual cutovers, never in ordinary plan", () => {
  for (const target of [identity, review]) {
    assert.equal(target.manualCutover, true);
    assert.throws(() => plan(target, baseline, false), /manual cutover/);
  }
  assert.deepEqual(createMigrationPlan({ allowManualCutover: false, ledgerRows: baseline, migrations }), []);
});

test("212 and 213 require all exact reviewed predecessor ledger checksums", () => {
  for (const [target, complete] of [[identity, baseline], [review, [...baseline, row(identity)]]]) {
    assert.equal(plan(target, complete)[0].version, target.version);
    assert.doesNotThrow(() => validateMigrationPlan({ledgerRows:complete,migrations,plan:[target]}));
    const required = target === identity ? baseline.slice(1) : complete;
    for (const dependency of required) for (const invalid of [undefined, null, "f".repeat(64)]) {
      const rows = complete.filter((x) => x.version !== dependency.version);
      if (invalid !== undefined) rows.push({...dependency, checksum:invalid});
      assert.throws(() => plan(target, rows));
      assert.throws(() => validateMigrationPlan({ledgerRows:rows,migrations,plan:[target]}));
    }
  }
});

test("old mailbox version identities and aliases cannot be replayed", () => {
  for (const [target, old, earlier] of [[identity,"190",[]], [review,"192",[row(identity)]]]) {
    for (const version of [old, old === "190" ? "190_mailbox_verified_microsoft_identity" : "192_mailbox_contact_review"]) {
      assert.throws(() => plan(target, [...baseline, ...earlier, {version, number:Number(old),checksum:null}]), /historical mail identity/);
    }
  }
});

test("missing or modified source and already-applied bad checksums fail closed", () => {
  for (const target of [identity, review]) {
    const earlier = target === review ? [row(identity)] : [];
    for (const patch of [{content:"select 1;"}, {checksum:"f".repeat(64)}, {file:"other.sql"}]) {
      const altered = migrations.map((x) => x.version === target.version ? {...x,...patch} : x);
      assert.throws(() => createMigrationPlan({allowManualCutover:true,ledgerRows:[...baseline,...earlier],migrations:altered,only:target.version}));
    }
    assert.throws(() => plan(target, [...baseline,...earlier,row(target,null)]));
  }
});
