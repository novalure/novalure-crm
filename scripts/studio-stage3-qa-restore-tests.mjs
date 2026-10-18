import test from 'node:test';
import assert from 'node:assert/strict';
import { restoreSelectedQa, sourceTarget, restoreTarget, applicationRoles, provisionRunOwnedRoles, compareDatabaseFingerprints } from './lib/studio-stage3-qa-restore.mjs';
const fp = () => ({ databaseName: sourceTarget.databaseName, projectId: sourceTarget.projectId, branchId: sourceTarget.branchId,
  readOnlyTransaction: true, schema: { sha256: 'a'.repeat(64) },
  ledger: { sha256: 'b'.repeat(64), rows: 42, through: 85, completeCanonicalCoverage: true, verifiedCommittedChecksums: true },
  executionReceipts: { sha256: 'c'.repeat(64), original061Verified: true },
  data: { sha256: 'd'.repeat(64), tables: 141, rows: 118 },
  classification: { markerChecks: 'PASS_NARROW_MARKER_CHECKS' } });
function targetClient({ nonempty = false, badIdentity = false, existing = false, unsafeMembership = false, creationFailure = false } = {}) {
  const calls = []; let roleReads = 0;
  return { calls, async query(sql) {
    calls.push(sql);
    if (sql.includes("as session_role")) return { rows: [{ project: badIdentity ? sourceTarget.projectId : restoreTarget.projectId,
      branch: restoreTarget.branchId, database: 'neondb', role: 'neondb_owner', session_role: 'neondb_owner' }] };
    if (sql.includes('as extra_schemas')) return { rows: [{ relations: nonempty ? 1 : 0, functions: 0, extra_schemas: 0 }] };
    if (sql.startsWith('select rolname')) {
      roleReads += 1;
      return { rows: existing || roleReads > 1 ? applicationRoles.map((role) => ({ rolname: role.name, rolcanlogin: role.login,
        rolinherit: role.inherit, rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false, rolbypassrls: false, rolconfig: null })) : [] };
    }
    if (sql.startsWith('select parent.rolname')) return { rows: [{ parent: 'novalure_tenant_app', member: 'novalure_app',
      admin_option: unsafeMembership, inherit_option: true, set_option: false }] };
    if (creationFailure && sql.startsWith('create role')) throw new Error('SYNTHETIC_ROLE_FAILURE');
    return { rows: [] };
  } };
}
function runOptions(extra = {}) {
  const source = {}, target = targetClient(extra.targetOptions), evidence = [], nativeCalls = [], passwords = [];
  const options = { source, target, approvedSource: fp(),
    capture: async (client) => client === source ? fp() : { ...fp(), databaseName: 'neondb', projectId: restoreTarget.projectId, branchId: restoreTarget.branchId },
    native: async (tool, action) => { nativeCalls.push([tool, action]); return action === 'version' ? tool + ' (PostgreSQL) 18.6' :
      action === 'dump' ? { sha256: 'e'.repeat(64), bytes: 123, format: 'native-pg-custom-selected-database' } : ''; },
    savePassword: async (password) => { passwords.push(password); },
    saveEvidence: async (value) => { evidence.push(JSON.parse(JSON.stringify(value))); }, ...extra.options };
  return { options, evidence, nativeCalls, passwords, target };
}
test('selected restore preserves exact source DB fingerprints with only the documented target role restrictions', async () => {
  const run = runOptions();
  const result = await restoreSelectedQa(run.options);
  assert.equal(result.status, 'PASS');
  assert.deepEqual(run.nativeCalls, [['pg_dump', 'version'], ['pg_restore', 'version'], ['pg_dump', 'dump'], ['pg_restore', 'restore']]);
  assert.equal(result.ledgerRecreation, 0); assert.equal(result.sourceWrites, 0);
  assert.equal(run.passwords.length, 1); assert.match(run.passwords[0].password, /^[a-f0-9]{80}$/u);
  assert.ok(!JSON.stringify(result).includes(run.passwords[0].password));
  assert.ok(run.target.calls.includes('grant novalure_tenant_app to novalure_app with admin false, inherit true, set false'));
  assert.ok(run.target.calls.some((sql) => sql.startsWith('create role "g24_qa_20260917_r3" nologin noinherit')));
  assert.equal(result.archive.sha256, 'e'.repeat(64));
});
test('unapproved or incomplete source stops before native tools, role setup or restore', async () => {
  for (const report of [{ ...fp(), data: { ...fp().data, rows: 119 } },
    { ...fp(), classification: { markerChecks: 'REVIEW_REQUIRED' } }, { ...fp(), schema: { sha256: 'f'.repeat(64) } }]) {
    const run = runOptions({ options: { capture: async () => report } });
    await assert.rejects(restoreSelectedQa(run.options));
    assert.equal(run.nativeCalls.length, 0); assert.equal(run.target.calls.length, 0); assert.equal(run.passwords.length, 0);
    assert.equal(run.evidence.at(-1).status, 'FAIL');
  }
});
test('wrong target or any existing target relation stops without writes', async () => {
  for (const targetOptions of [{ badIdentity: true }, { nonempty: true }]) {
    const run = runOptions({ targetOptions });
    await assert.rejects(restoreSelectedQa(run.options));
    assert.equal(run.nativeCalls.length, 0);
    assert.ok(run.target.calls.every((sql) => /^(begin|select|rollback)\b/iu.test(sql)));
  }
});
test('existing target role names are not silently reused, rotated or repaired', async () => {
  const run = runOptions({ targetOptions: { existing: true } });
  await assert.rejects(restoreSelectedQa(run.options), /RUN_OWNED_ROLES_ALREADY_EXIST/u);
  assert.equal(run.passwords.length, 0); assert.ok(!run.target.calls.some((sql) => /^(create|alter|grant|drop)\b/iu.test(sql)));
  assert.ok(!run.nativeCalls.some(([, action]) => action === 'dump' || action === 'restore'));
});
test('role or membership failure rolls back and never proceeds to dump/restore', async () => {
  for (const targetOptions of [{ creationFailure: true }, { unsafeMembership: true }]) {
    const run = runOptions({ targetOptions });
    await assert.rejects(restoreSelectedQa(run.options));
    assert.equal(run.target.calls.at(-1), 'rollback'); assert.equal(run.passwords.length, 1);
    assert.ok(!run.nativeCalls.some(([, action]) => action === 'dump' || action === 'restore'));
  }
});
test('source drift after dump prevents any restore and preserves failure evidence', async () => {
  const run = runOptions(); let reads = 0;
  run.options.capture = async () => ++reads === 1 ? fp() : { ...fp(), data: { ...fp().data, sha256: 'f'.repeat(64) } };
  await assert.rejects(restoreSelectedQa(run.options), /SOURCE_DRIFT_DURING_DUMP/u);
  assert.equal(run.evidence.at(-1).status, 'FAIL');
  assert.ok(run.nativeCalls.some(([, action]) => action === 'dump'));
  assert.ok(!run.nativeCalls.some(([, action]) => action === 'restore'));
});
test('native restore failure or DB signature mismatch cannot become PASS or invoke a repair', async () => {
  for (const mode of ['native-failure', 'signature-mismatch']) {
    const run = runOptions();
    const baseNative = run.options.native;
    run.options.native = async (tool, action) => {
      if (mode === 'native-failure' && action === 'restore') throw new Error('NATIVE_PG_TOOL_EXIT_FAILURE');
      return baseNative(tool, action);
    };
    const capture = run.options.capture;
    run.options.capture = async (client) => mode === 'signature-mismatch' && client === run.target
      ? { ...fp(), schema: { sha256: 'f'.repeat(64) } } : capture(client);
    await assert.rejects(restoreSelectedQa(run.options));
    assert.equal(run.evidence.at(-1).status, 'FAIL');
    assert.ok(!run.target.calls.some((sql) => /^drop\b/iu.test(sql)));
  }
});
test('a changed source after restoration remains failed rather than inheriting earlier PASS', async () => {
  const run = runOptions(); let sourceReads = 0;
  run.options.capture = async (client) => {
    if (client === run.options.source && ++sourceReads === 3) return { ...fp(), ledger: { ...fp().ledger, sha256: 'f'.repeat(64) } };
    return fp();
  };
  await assert.rejects(restoreSelectedQa(run.options), /SOURCE_CHANGED_DURING_RESTORE/u);
  assert.equal(run.evidence.at(-1).status, 'FAIL');
  assert.equal(compareDatabaseFingerprints(fp(), fp()), true);
});
test('unsafe source, parent and Production target identifiers stay outside the fixed restore contract', () => {
  assert.equal(sourceTarget.projectId, 'weathered-term-98273025');
  assert.equal(sourceTarget.databaseName, 'qa_g24_pr63_20260917_r3');
  assert.equal(restoreTarget.projectId, 'super-block-59791927');
  assert.equal(restoreTarget.branchId, 'br-ancient-term-awip1q3q');
});
