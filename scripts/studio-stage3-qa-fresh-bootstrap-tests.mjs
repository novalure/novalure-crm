import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createFreshBootstrapManifest, captureFreshBootstrapPreflight, runFreshBootstrap, freshBootstrapTarget, freshBootstrapBaseline } from './lib/studio-stage3-qa-fresh-bootstrap.mjs';
import { prepareTargetQueries, managementDatabase, providerBaselineDatabase } from './lib/studio-stage3-qa-prepare-target.mjs';
import { catalogQueries, extensionQueries, sourceExtensions } from './lib/studio-stage3-qa-fingerprint.mjs';
import { renderNeon061Compatibility } from './lib/neon-061-compat.mjs';
import { validateFreshBootstrapConfig, validateReviewedFreshPlan } from './studio-stage3-qa-fresh-bootstrap.mjs';
const originalPreflight = JSON.parse(readFileSync(new URL('./fixtures/studio-stage3-original-preflight.json', import.meta.url), 'utf8'));
const headCommit = 'a'.repeat(40), cutoverSourceSha = 'b'.repeat(40);
const files = readdirSync(new URL('../migrations/', import.meta.url)).filter((name) => /^\d{3}_.+\.sql$/u.test(name) && !name.includes('_rollback') && Number(name.slice(0, 3)) <= 85)
  .map((name) => ({ name, content: readFileSync(new URL('../migrations/' + name, import.meta.url), 'utf8') }));
const manifest = createFreshBootstrapManifest(files, { headCommit, cutoverSourceSha });
const clone = (value) => JSON.parse(JSON.stringify(value));
const apiSnapshot = { database: originalPreflight.preflight.database, extensionProfile: originalPreflight.preflight.extensionProfile,
  objects: ['sequences', 'tables'].map((kind) => ({ catalog: 'pg_default_acl', object_type: 'default acl', schema: null, name: null, identity: 'for role cloud_admin in schema public on ' + kind })), globals: { count: 0 } };
const managementSnapshot = { database: { ...apiSnapshot.database, acl: apiSnapshot.database.acl.filter((row) => row.grantee !== 'neon_superuser'), sha256: freshBootstrapBaseline.managementDatabase },
  extensionProfile: { ...apiSnapshot.extensionProfile, defaultGrants: [], sha256: freshBootstrapBaseline.managementCatalog }, objects: [], globals: { count: 0 } };
const sourceDatabase = { ...managementSnapshot.database, globalRoleSettings: { count: 1, settings: [], sha256: originalPreflight.preflight.sourceGlobalRoleSettingsSha256 } };
const sourceProfile = { ...apiSnapshot.extensionProfile, server: { version: '17.11', version_num: 170011 }, extensions: [sourceExtensions[0], apiSnapshot.extensionProfile.extensions[0], sourceExtensions[1]],
  memberCount: 1, sha256: originalPreflight.preflight.sourceExtensionProfileSha256 };
const source = { databaseName: 'qa_g24_pr63_20260917_r3', projectId: 'weathered-term-98273025', branchId: 'br-spring-snow-alupo8u4', readOnlyTransaction: true,
  database: sourceDatabase, extensionProfile: sourceProfile, schema: { sha256: '1'.repeat(64) },
  ledger: { rows: 42, through: 85, completeCanonicalCoverage: true, verifiedCommittedChecksums: true, sha256: '2'.repeat(64) },
  executionReceipts: { original061Verified: true, sha256: '3'.repeat(64) }, data: { tables: 141, rows: 118, sha256: '4'.repeat(64) }, classification: { markerChecks: 'PASS_NARROW_MARKER_CHECKS' } };
function history() { return {
  sourceReport: { databases: [source] }, originalPreflight,
  failedPrepare: { format: 'studio-stage3-prepare-target-run-v1', status: 'FAIL', failureCode: 'TARGET_DEFAULT_ACL_MISMATCH',
    headCommit: freshBootstrapBaseline.originalCommit, projectId: freshBootstrapTarget.projectId, branchId: freshBootstrapTarget.branchId,
    sourceWrites: 0, rolesCreated: 0, extensionWrites: 0, aclChanges: 0, drops: 0, steps: ['create_management_database'], preflight: originalPreflight.preflight },
  startInventory: { readOnly: true, databases: [['neondb', apiSnapshot], [managementDatabase, managementSnapshot]].map(([database, snapshot]) => ({ identity: {
    project: freshBootstrapTarget.projectId, branch: freshBootstrapTarget.branchId, database, role: 'neondb_owner', session_role: 'neondb_owner' }, ...snapshot })) },
  nativeDenial: { status: 'BLOCKED_PROVIDER_42501', sqlState: '42501', rollbackConfirmed: true, effectiveRightsChanged: false, sourceWrites: 0, commitAllowed: false,
    before: { database: freshBootstrapBaseline.baselineDatabaseDigest, extensionProfile: freshBootstrapBaseline.baselineExtensionDigest }, after: { database: freshBootstrapBaseline.baselineDatabaseDigest, extensionProfile: freshBootstrapBaseline.baselineExtensionDigest } }
}; }
function cluster(options = {}) {
  const databases = new Map([['neondb', { oid: 16396, kind: 'api' }], ['postgres', { oid: 5 }], [managementDatabase, { oid: 32768, kind: 'management' }], ['template0', { oid: 4 }], ['template1', { oid: 1 }]]);
  const clients = new Map(), calls = [], ddl = [], attempted = [], committed = [], ledger = [], evidence = [], secrets = [];
  const roles = new Map(originalPreflight.preflight.providerRoles.map((row) => [row.name, row])); let pid = 1000 + (options.pidOffset || 0), transaction;
  const sqlMap = new Map(manifest.filter((row) => row.number !== 61).map((row) => [row.content, row]));
  const runtimeRow = (tenant = false) => ({ rolname: tenant ? 'novalure_tenant_app' : 'novalure_app', rolcanlogin: !tenant, rolinherit: !tenant, rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false, rolbypassrls: Boolean(options.unsafeRuntime && !tenant) });
  const connect = async (database) => {
    assert.ok(databases.has(database), 'Synthetic selected database must exist'); const currentPid = ++pid;
    const client = { database, async end() { clients.delete(currentPid); }, async query(sql, args) {
      calls.push({ database, sql });
      if (sql === prepareTargetQueries.identity) return { rows: [{ project: options.wrongProject ? 'weathered-term-98273025' : freshBootstrapTarget.projectId,
        branch: freshBootstrapTarget.branchId, database, role: 'neondb_owner', session_role: 'neondb_owner', server_version_num: 180006,
        can_create_database: true, database_owner: database === 'postgres' ? 'cloud_admin' : 'neondb_owner', database_oid: databases.get(database).oid + (options.oidDrift && database === managementDatabase ? 1 : 0), pid: currentPid }] };
      if (sql === prepareTargetQueries.databases) return { rows: [...databases.keys(), ...(options.extraDatabase ? ['foreign_data'] : [])].sort().map((name) => ({ name })) };
      if (sql === prepareTargetQueries.roles) return { rows: [...roles.values(), ...(options.extraRole ? [{ name: 'unknown_app' }] : [])].sort((a, b) => a.name.localeCompare(b.name)) };
      if (sql === prepareTargetQueries.sessions) return { rows: [...clients.entries()].map(([id, name]) => ({ pid: id, database: name, role: 'neondb_owner', state: id === currentPid ? 'active' : 'idle' }))
        .concat(Array.from({ length: options.providerCount || 0 }, (_, index) => ({ pid: 9000 + index, database: 'postgres', role: 'cloud_admin', state: options.providerActive ? 'active' : 'idle' }))) };
      if (sql === prepareTargetQueries.prepared) return { rows: [{ count: options.prepared ? 1 : 0 }] };
      if (sql === catalogQueries.memberships) return { rows: options.membershipDrift ? [{ altered: true }] : [] };
      if (sql === 'begin') { transaction = { roles: new Map(roles), ledgerCount: ledger.length, migrations: [] }; return { rows: [] }; }
      if (sql === 'commit') { if (transaction) committed.push(...transaction.migrations); transaction = undefined; return { rows: [] }; }
      if (sql === 'rollback') { if (transaction) { roles.clear(); for (const [name, row] of transaction.roles) roles.set(name, row); ledger.splice(transaction.ledgerCount); } transaction = undefined; return { rows: [] }; }
      if (sql === 'set local search_path=public') return { rows: [] };
      if (sql.startsWith('alter database')) { ddl.push(sql); databases.set(providerBaselineDatabase, databases.get('neondb')); databases.delete('neondb'); return { rows: [] }; }
      if (sql.startsWith('create database')) { ddl.push(sql); databases.set('neondb', { oid: 40000, kind: 'fresh' }); return { rows: [] }; }
      if (sql.startsWith('create role novalure_app')) { ddl.push('create safe run-owned login'); roles.set('novalure_app', { name: 'novalure_app', login: true, superuser: false, bypassrls: false, create_database: false, create_role: false }); return { rows: [] }; }
      if (sql.startsWith('select rolname,rolcanlogin')) return { rows: [runtimeRow(), ...(roles.has('novalure_tenant_app') ? [runtimeRow(true)] : [])] };
      if (sql.startsWith('grant novalure_tenant_app') || sql.startsWith('comment on role novalure_tenant_app')) return { rows: [] };
      if (sql.startsWith('insert into public.novalure_schema_migrations')) { ledger.push({ version: args[0], name: args[1], checksum: args[2], applied_at: '2026-10-18T20:00:00Z' }); return { rows: [] }; }
      if (sql.startsWith('select count(*)::int as n')) return { rows: [{ n: options.mediaNotEmpty && sql.includes('media_assets') ? 1 : 0 }] };
      if (sql.startsWith('select count(*)::int total')) return { rows: [{ total: 1, expected: options.badAuditSeed ? 0 : 1 }] };
      if (sql.startsWith('select version,name,checksum,applied_at')) return { rows: ledger };
      if (sql.startsWith('select source_checksum,executed_sql_checksum')) return { rows: [{ source_checksum: manifest.find((row) => row.number === 61).checksum,
        executed_sql_checksum: renderNeon061Compatibility(manifest.find((row) => row.number === 61).content).executedSqlChecksum,
        profile_id: 'studio-stage3-qa:neon-provider-creator-admin-only-061-v1', target: freshBootstrapTarget }] };
      if (sql === extensionQueries.installed) return { rows: [{ name: 'pgcrypto', version: '1.4' }, { name: 'vector', version: '0.8.6' }] };
      if (Object.values(catalogQueries).includes(sql)) return { rows: [] };
      const migration = sqlMap.get(sql);
      assert.ok(migration, 'Every executed SQL string must be one exact original migration or reviewed setup/guard');
      attempted.push(migration.name);
      if (options.failMigration === migration.number) throw Object.assign(new Error('synthetic source SQL failure'), { code: '42501' });
      transaction.migrations.push(migration.name);
      if (migration.number === 60) roles.set('novalure_tenant_app', { name: 'novalure_tenant_app', login: false, superuser: false, bypassrls: false, create_database: false, create_role: false });
      return { rows: [] };
    } }; clients.set(currentPid, database); return client;
  };
  const snapshot = async (client) => {
    const kind = databases.get(client.database).kind;
    const value = clone(kind === 'api' ? apiSnapshot : managementSnapshot);
    if (options.catalogDrift) value.extensionProfile.sha256 = 'f'.repeat(64);
    return value;
  };
  const apply061 = async (input) => {
    assert.equal(input.executionProfile, 'studio-stage3-qa'); assert.deepEqual(input.target, freshBootstrapTarget);
    assert.equal(input.sql, manifest.find((row) => row.number === 61).content);
    attempted.push('061_validate_and_activate_tenant_rls_pilot.sql');
    if (options.bad061Attestation) throw new Error('SYNTHETIC_061_ATTESTATION_FAILED');
    transaction.migrations.push('061_validate_and_activate_tenant_rls_pilot.sql');
    return { receiptId: 'synthetic-new-receipt', sourceChecksum: manifest.find((row) => row.number === 61).checksum,
      executedSqlChecksum: renderNeon061Compatibility(input.sql).executedSqlChecksum };
  };
  return { connect, snapshot, apply061, databases, clients, calls, ddl, attempted, committed, ledger, evidence, secrets,
    saveEvidence: async (value) => evidence.push(clone(value)), saveRuntimeSecret: async (value) => secrets.push(value) };
}
const input = (run, extra = {}) => ({ connect: run.connect, snapshot: run.snapshot, history: history(), manifest, headCommit, cutoverSourceSha, ...extra });
const planFor = (run, extra) => captureFreshBootstrapPreflight(input(run, extra));
const execute = (run, approvedPlan, extra) => runFreshBootstrap({ ...input(run), apply061: run.apply061, saveEvidence: run.saveEvidence, saveRuntimeSecret: run.saveRuntimeSecret, approvedPlan, ...extra });

test('the actual 83 committed original SQL files retain LF checksums and only062 moves before060', () => {
  assert.equal(manifest.length, 83); assert.equal(manifest.at(-1).number, 85);
  assert.ok(manifest.findIndex((row) => row.number === 51) < manifest.findIndex((row) => row.number === 62));
  assert.ok(manifest.findIndex((row) => row.number === 62) < manifest.findIndex((row) => row.number === 60));
  for (const row of manifest) assert.equal(row.checksum, createHash('sha256').update(row.content).digest('hex'));
  assert.throws(() => createFreshBootstrapManifest(files.slice(1), { headCommit, cutoverSourceSha }));
  assert.throws(() => createFreshBootstrapManifest(files.map((row) => row.name.startsWith('061_') ? { ...row, content: row.content + '\n-- changed' } : row), { headCommit, cutoverSourceSha }));
});
test('fresh preflight binds the exact failed history, five databases, stable OIDs and role graph while provider pool counts remain diagnostic', async () => {
  const first = cluster({ providerCount: 1 }), second = cluster({ providerCount: 4, pidOffset: 20 });
  const a = await planFor(first), b = await planFor(second);
  assert.equal(a.sha256, b.sha256); assert.equal(a.bound.databases.neondb.oid, 16396); assert.equal(a.bound.databases[managementDatabase].oid, 32768);
  assert.equal(a.diagnostics.providerBackgroundSessions.count, 1); assert.equal(b.diagnostics.providerBackgroundSessions.count, 4);
  assert.equal(first.ddl.length, 0); assert.equal(first.clients.size, 0);
  const graphDrift = await planFor(cluster({ membershipDrift: true })); assert.notEqual(graphDrift.sha256, a.sha256);
});
test('the full synthetic adapter run executes every original migration, commits honest ledger rows and a new061 receipt, and stops at085', async () => {
  const run = cluster(); const plan = await planFor(run); const result = await execute(run, plan);
  assert.equal(result.status, 'PASS'); assert.equal(result.nativeRestore, false); assert.equal(result.historicalLedgerCopied, false);
  assert.deepEqual(run.committed, manifest.map((row) => row.name)); assert.equal(result.applied.length, 83);
  assert.equal(run.ledger.length, 42); assert.equal(result.final.ledgerRows, 42);
  assert.equal(run.databases.get(providerBaselineDatabase).oid, 16396); assert.equal(run.databases.get(managementDatabase).oid, 32768);
  assert.equal(run.ddl.length, 3); assert.ok(run.ddl.every((sql) => !/drop|grant|revoke|cloud_admin/u.test(sql)));
  assert.equal(run.secrets.length, 1); assert.match(run.secrets[0].password, /^[a-f0-9]{80}$/u);
  assert.ok(!JSON.stringify(run.evidence).includes(run.secrets[0].password)); assert.equal(run.clients.size, 0);
  assert.ok(run.calls.every((row) => ['postgres', 'neondb', managementDatabase, providerBaselineDatabase].includes(row.database)));
});
test('wrong target, OIDs, extra roles/databases/sessions, catalog or recorded history refuse before writes', async () => {
  for (const options of [{ wrongProject: true }, { oidDrift: true }, { extraRole: true }, { extraDatabase: true }, { providerCount: 1, providerActive: true }, { prepared: true }, { catalogDrift: true }]) {
    const run = cluster(options); await assert.rejects(planFor(run)); assert.equal(run.ddl.length, 0);
  }
  for (const mutate of [(h) => { h.failedPrepare.status = 'PASS'; }, (h) => { h.nativeDenial.rollbackConfirmed = false; }, (h) => { h.originalPreflight.preflight.providerRoles.pop(); }]) {
    const run = cluster(), altered = clone(history()); mutate(altered); await assert.rejects(planFor(run, { history: altered })); assert.equal(run.ddl.length, 0);
  }
});
test('changed source SQL after review or changed bound role graph refuses before database rename', async () => {
  const plan = await planFor(cluster()); const run = cluster();
  const changed = manifest.map((row) => row.number === 1 ? { ...row, content: row.content + '\n-- unreviewed' } : row);
  await assert.rejects(execute(run, plan, { manifest: changed }), /REVIEWED_FRESH_PLAN_DRIFT/u); assert.equal(run.ddl.length, 0);
  const graph = cluster({ membershipDrift: true }); await assert.rejects(execute(graph, plan), /REVIEWED_FRESH_PLAN_DRIFT/u); assert.equal(graph.ddl.length, 0);
});
test('unsafe runtime or062 media/audit guards fail without executing062 or later migrations', async () => {
  const plan = await planFor(cluster());
  for (const options of [{ unsafeRuntime: true }, { mediaNotEmpty: true }, { badAuditSeed: true }]) {
    const run = cluster(options); await assert.rejects(execute(run, plan)); assert.equal(run.evidence.at(-1).status, 'FAIL');
    assert.ok(!run.attempted.includes(manifest.find((row) => row.number === 62).name));
    assert.ok(!run.attempted.includes(manifest.find((row) => row.number === 85).name));
  }
});
test('061 attestation or originalSQL errors roll back that migration, preserve earlier truthful ledger, and never resume a partial run', async () => {
  const plan = await planFor(cluster());
  for (const options of [{ bad061Attestation: true }, { failMigration: 65 }]) {
    const run = cluster(options); await assert.rejects(execute(run, plan));
    assert.equal(run.evidence.at(-1).status, 'FAIL'); assert.ok(!run.committed.includes('085_crm_approval_evidence.sql'));
    assert.ok(!run.ledger.some((row) => row.version.startsWith(options.bad061Attestation ? '061_' : '065_')));
    const before = run.ddl.length; await assert.rejects(execute(run, plan)); assert.equal(run.ddl.length, before);
  }
});
test('CLI config and reviewed-plan validators reject target, host, history, mode, revision and age drift without main execution', async () => {
  const config = { target: freshBootstrapTarget, targetHost: 'ep-test.eu-central-1.aws.neon.tech', targetUriFile: '.npm-cache/qa/target-uri.txt', cutoverSourceSha,
    historyFiles: Object.fromEntries(['sourceReport', 'originalPreflight', 'failedPrepare', 'startInventory', 'nativeDenial'].map((key) => [key, '.npm-cache/qa/' + key + '.json'])), approvedPlanFile: '.npm-cache/qa/plan.json' };
  assert.equal(validateFreshBootstrapConfig(config, '--preflight'), config);
  for (const altered of [{ ...config, target: { ...config.target, branchId: 'foreign' } }, { ...config, targetHost: 'ep-test-pooler.eu-central-1.aws.neon.tech' },
    { ...config, targetHost: 'https://wrong.example' }, { ...config, historyFiles: {} }, { ...config, approvedPlanFile: undefined }]) {
    assert.throws(() => validateFreshBootstrapConfig(altered, '--run-authorized-fresh-bootstrap'));
  }
  assert.throws(() => validateFreshBootstrapConfig(config, '--unreviewed'));
  const plan = await planFor(cluster()), now = Date.parse('2026-10-18T21:00:00Z');
  const wrapper = { format: 'studio-stage3-fresh-bootstrap-reviewed-plan-v1', headCommit, capturedAt: new Date(now).toISOString(), plan };
  assert.equal(validateReviewedFreshPlan(wrapper, { headCommit, cutoverSourceSha, now }), plan);
  for (const altered of [{ ...wrapper, headCommit: 'f'.repeat(40) }, { ...wrapper, capturedAt: new Date(now - 3600001).toISOString() },
    { ...wrapper, capturedAt: new Date(now + 1).toISOString() }, { ...wrapper, plan: { ...plan, sha256: 'not-a-digest' } },
    { ...wrapper, plan: { ...plan, bound: { ...plan.bound, cutoverSourceSha: 'f'.repeat(40) } } }]) {
    assert.throws(() => validateReviewedFreshPlan(altered, { headCommit, cutoverSourceSha, now }));
  }
});
