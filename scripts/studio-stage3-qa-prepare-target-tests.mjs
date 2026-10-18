import test from 'node:test';
import assert from 'node:assert/strict';
import { captureDatabaseMetadata, captureExtensionMetadata, databaseQueries, catalogQueries, extensionQueries, sourceExtensions, restoreProject, restoreBranch } from './lib/studio-stage3-qa-fingerprint.mjs';
import { sourceTarget } from './lib/studio-stage3-qa-restore.mjs';
import { capturePrepareTargetPreflight, prepareSelectedQaTarget, prepareTargetQueries, managementDatabase, providerBaselineDatabase } from './lib/studio-stage3-qa-prepare-target.mjs';

const properties = { owner: 'neondb_owner', encoding: 'UTF8', collation: 'C.UTF-8', ctype: 'C.UTF-8', locale_provider: 'c', locale: null, icu_rules: null, collation_version: null, allow_connections: true, is_template: false, connection_limit: -1 };
const sourceAcl = ['CONNECT', 'CREATE', 'TEMPORARY'].map((privilege_type) => ({ grantee: 'neondb_owner', grantor: 'neondb_owner', privilege_type, is_grantable: false }));
const providerAcl = [...sourceAcl, ...sourceAcl.map((row) => ({ ...row, grantee: 'neon_superuser' }))];
const namespaces = [{ nspname: 'public', owner: 'neondb_owner' }];
const schemaGrants = ['CREATE', 'USAGE'].map((privilege_type) => ({ nspname: 'public', owner: 'neondb_owner', grantee: 'neondb_owner', grantor: 'neondb_owner', privilege_type, is_grantable: false }));
const plpgsql = { name: 'plpgsql', version: '1.0', schema: 'pg_catalog', owner: 'cloud_admin' };
const providerRolesFixture = [
  { name: 'cloud_admin', login: true, superuser: true, bypassrls: true, create_database: true, create_role: true },
  { name: 'neon_service', login: true, superuser: false, bypassrls: true, create_database: true, create_role: true },
  { name: 'neon_superuser', login: false, superuser: false, bypassrls: true, create_database: true, create_role: true },
  { name: 'neondb_owner', login: true, superuser: false, bypassrls: true, create_database: true, create_role: true }
];
const sourceDatabase = await captureDatabaseMetadata({ query: async (sql) => ({ rows:
  sql === databaseQueries.properties ? [properties] : sql === databaseQueries.acl ? sourceAcl :
    sql === databaseQueries.globalRoleSettings ? [{ database_scope: 'ALL_DATABASES', role_name: 'novalure_app', setting: 'search_path=pg_catalog,public' }] : [] }) });
const sourceProfile = await captureExtensionMetadata({ query: async (sql) => ({ rows:
  sql === extensionQueries.server ? [{ version: '17.11', version_num: 170011 }] :
    sql === extensionQueries.installed ? [sourceExtensions[0], plpgsql, sourceExtensions[1]] :
      sql === extensionQueries.members ? [{ catalog: 'pg_proc', object_type: 'function', schema: 'public', name: 'digest', identity: 'public.digest(text,text)', definition: { owner: 'neondb_owner', definition: 'synthetic' } }] :
        sql === catalogQueries.namespaces ? namespaces : sql === catalogQueries.schemaGrants ? schemaGrants : [] }) });
const sourceReport = { ...sourceTarget, databaseName: sourceTarget.databaseName, projectId: sourceTarget.projectId, branchId: sourceTarget.branchId,
  readOnlyTransaction: true, database: sourceDatabase, extensionProfile: sourceProfile, schema: { sha256: 'a'.repeat(64) },
  ledger: { rows: 42, through: 85, completeCanonicalCoverage: true, verifiedCommittedChecksums: true, sha256: 'b'.repeat(64) },
  executionReceipts: { original061Verified: true, sha256: 'c'.repeat(64) }, data: { tables: 141, rows: 118, sha256: 'd'.repeat(64) },
  classification: { markerChecks: 'PASS_NARROW_MARKER_CHECKS' } };

function cluster(options = {}) {
  const databases = new Map(['neondb', 'postgres', 'template0', 'template1'].map((name, i) => [name, { oid: 100 + i, provider: name === 'neondb' }]));
  const clients = new Map(), calls = [], writes = [], evidence = []; let nextPid = 1000 + (options.pidOffset || 0), nextOid = 200;
  const connect = async (database) => {
    assert.ok(databases.has(database), 'Synthetic database must already exist');
    const pid = ++nextPid;
    const client = { async end() { clients.delete(pid); }, async query(sql) {
      calls.push({ database, sql }); const entry = databases.get(database);
      if (sql === prepareTargetQueries.identity) return { rows: [{ project: options.badProject ? sourceTarget.projectId : restoreProject,
        branch: options.badBranch ? sourceTarget.branchId : restoreBranch, database,
        role: options.badRole ? 'other' : 'neondb_owner', session_role: 'neondb_owner', pid, database_oid: entry.oid,
        database_owner: options.badOwner ? 'other_owner' : 'neondb_owner', server_version_num: options.badVersion ? 170011 : 180006, can_create_database: !options.noCreatedb }] };
      if (sql === prepareTargetQueries.databases) return { rows: [...databases.keys(), ...(options.existingName ? [options.existingName] : [])].sort().map((name) => ({ name, is_template: /^template[01]$/u.test(name), owner: ['postgres', 'template0', 'template1'].includes(name) ? 'cloud_admin' : 'neondb_owner' })) };
      if (sql === prepareTargetQueries.roles) return { rows: options.roleRows || [...providerRolesFixture, ...(options.appRole ? [{ name: 'novalure_app' }] : []), ...(options.unknownRole ? [{ name: 'unknown_app' }] : [])].sort((a, b) => a.name.localeCompare(b.name)) };
      if (sql === prepareTargetQueries.sessions) return { rows: [...clients.entries()].map(([id, name]) => ({ pid: id, database: name, role: 'neondb_owner', state: id === pid ? 'active' : 'idle' }))
        .concat(options.foreignSession || (options.lateSession && writes.length) ? [{ pid: 999, database: 'neondb', role: 'neondb_owner', state: 'idle' }] : [], options.providerSessions || []) };
      if (sql === prepareTargetQueries.prepared) return { rows: [{ count: options.preparedTransaction ? 1 : 0 }] };
      if (sql === databaseQueries.properties) return { rows: [{ ...properties, ...(options.propertyDrift && database === 'neondb' ? { ctype: 'different' } : {}) }] };
      if (sql === databaseQueries.acl) return { rows: entry.provider ? options.baselineAcl || providerAcl : options.freshAclDrift ? providerAcl : sourceAcl };
      if (sql === databaseQueries.settings) return { rows: options.currentSetting ? [{ database_scope: 'CURRENT_DATABASE', role_name: 'ALL_ROLES', setting: 'search_path=changed' }] : [] };
      if (sql === databaseQueries.globalRoleSettings) return { rows: options.globalSetting ? [{ database_scope: 'ALL_DATABASES', role_name: 'neondb_owner', setting: 'search_path=changed' }] : [] };
      if (sql === extensionQueries.server) return { rows: [{ version: '18.6', version_num: 180006 }] };
      if (sql === extensionQueries.installed) return { rows: options.extraExtension ? [plpgsql, { name: 'unreviewed', version: '1', schema: 'public', owner: 'neondb_owner' }] : [plpgsql] };
      if (sql === extensionQueries.members || sql === extensionQueries.privileges) return { rows: [] };
      if (sql === extensionQueries.available) return { rows: sourceExtensions };
      if (sql === extensionQueries.userObjects) return { rows: options.nonempty ? [{ catalog: 'pg_class', identity: 'public.application_data' }] : [] };
      if (sql === extensionQueries.globalObjects) return { rows: [{ count: options.extraGlobal ? 1 : 0 }] };
      if (sql === catalogQueries.namespaces) return { rows: options.extraSchema ? [...namespaces, { nspname: 'extra', owner: 'neondb_owner' }] : namespaces };
      if (sql === catalogQueries.schemaGrants) return { rows: options.wideSchemaAcl ? [...schemaGrants, { ...schemaGrants[0], grantee: 'PUBLIC' }] : schemaGrants };
      if (/^(begin|rollback)\b/u.test(sql)) return { rows: [] };
      const mutations = [
        'create database "st1_stage3_management" with template "template0" owner "neondb_owner"',
        'alter database "neondb" rename to "st1_stage3_provider_baseline"',
        'create database "neondb" with template "template0" owner "neondb_owner"'
      ];
      assert.ok(mutations.includes(sql), 'Only the three reviewed database commands are supported');
      writes.push(sql);
      if (options.failWrite === writes.length) throw new Error('SYNTHETIC_PREPARE_DDL_FAILURE');
      if (sql === mutations[0]) databases.set(managementDatabase, { oid: ++nextOid, provider: false });
      if (sql === mutations[1]) {
        assert.ok(![...clients.values()].includes('neondb'), 'The original database connection must be closed before rename');
        databases.set(providerBaselineDatabase, { ...databases.get('neondb'), ...(options.preservedOidDrift ? { oid: 999 } : {}) }); databases.delete('neondb');
      }
      if (sql === mutations[2]) databases.set('neondb', { oid: ++nextOid, provider: false });
      if (options.lostDdlAcknowledgement && writes.length === 1) throw new Error('SYNTHETIC_DDL_ACKNOWLEDGEMENT_LOST');
      return { rows: [] };
    } };
    clients.set(pid, database); return client;
  };
  return { databases, calls, writes, clients, connect, evidence, saveEvidence: async (value) => evidence.push(JSON.parse(JSON.stringify(value))) };
}
async function preflight(run) { const client = await run.connect('neondb'); try { return await capturePrepareTargetPreflight(client, sourceReport); } finally { await client.end(); } }
async function prepare(run, approvedPreflight) { return prepareSelectedQaTarget({ connect: run.connect, sourceReport, approvedPreflight, saveEvidence: run.saveEvidence }); }

test('preflight is read-only and separates the source global role configuration from exact database properties', async () => {
  const run = cluster(); const plan = await preflight(run);
  assert.equal(plan.projectId, restoreProject); assert.equal(plan.branchId, restoreBranch);
  assert.equal(plan.databaseWrites, 0); assert.equal(run.writes.length, 0); assert.equal(run.clients.size, 0);
  assert.deepEqual(plan.providerRoles, providerRolesFixture);
  assert.equal(plan.sourceGlobalRoleSettingsSha256, sourceDatabase.globalRoleSettings.sha256);
  assert.equal(plan.database.globalRoleSettings.count, 0); assert.notEqual(plan.database.sha256, sourceDatabase.sha256);
  assert.equal(run.calls[0].sql, 'begin isolation level repeatable read read only'); assert.equal(run.calls.at(-1).sql, 'rollback');
});
test('prepare preserves the original provider database and ACL, then verifies pristine management and restore databases', async () => {
  const run = cluster(); const plan = await preflight(run); const originalOid = plan.databaseOid;
  const result = await prepare(run, plan);
  assert.equal(result.status, 'PASS'); assert.equal(result.providerBaselinePreserved, true);
  assert.equal(result.database.sha256, sourceDatabase.sha256);
  assert.equal(run.databases.get(providerBaselineDatabase).oid, originalOid);
  assert.equal(run.databases.get(providerBaselineDatabase).provider, true);
  assert.notEqual(run.databases.get('neondb').oid, originalOid);
  assert.deepEqual(result.steps, ['create_management_database', 'preserve_provider_baseline', 'create_clean_restore_database']);
  assert.equal(run.writes.length, 3); assert.equal(run.clients.size, 0);
  assert.ok(run.writes.every((sql) => !/drop|revoke|grant|create role|create extension|alter role|template0.*(?:update|alter)/iu.test(sql)));
});
test('identity project branch owner runtime role server version and CREATEDB capability fail before writes', async () => {
  for (const options of [{ badProject: true }, { badBranch: true }, { badOwner: true }, { badRole: true }, { badVersion: true }, { noCreatedb: true }]) {
    const run = cluster(options); await assert.rejects(preflight(run), /PINNED_PREPARE_TARGET_IDENTITY_MISMATCH/u); assert.equal(run.writes.length, 0);
  }
});
test('application roles, unknown roles, reused names, foreign sessions and prepared transactions prevent setup', async () => {
  for (const options of [{ appRole: true }, { unknownRole: true }, { existingName: managementDatabase }, { existingName: providerBaselineDatabase }, { existingName: 'unclassified_db' }, { foreignSession: true }, { preparedTransaction: true }]) {
    const run = cluster(options); await assert.rejects(preflight(run)); assert.equal(run.writes.length, 0);
  }
});
test('the four verified provider roles are exact: missing names, an extra provider-looking name or any observed attribute drift fail', async () => {
  const invalidRows = [providerRolesFixture.filter((row) => row.name !== 'neon_service'),
    [...providerRolesFixture, { ...providerRolesFixture[1], name: 'neon_additional_service' }]];
  for (const expected of providerRolesFixture) for (const attribute of ['login', 'superuser', 'bypassrls', 'create_database', 'create_role']) {
    invalidRows.push(providerRolesFixture.map((row) => row.name === expected.name ? { ...row, [attribute]: !row[attribute] } : row));
  }
  for (const roleRows of invalidRows) {
    const run = cluster({ roleRows });
    await assert.rejects(preflight(run), /PREPARE_TARGET_APPLICATION_OR_UNKNOWN_ROLE_EXISTS/u);
    assert.equal(run.writes.length, 0); assert.equal(run.clients.size, 0);
  }
});
test('extra tables schemas extensions global objects or wider schema ACL prevent setup', async () => {
  for (const options of [{ nonempty: true }, { extraSchema: true }, { extraExtension: true }, { extraGlobal: true }, { wideSchemaAcl: true }]) {
    const run = cluster(options); await assert.rejects(preflight(run)); assert.equal(run.writes.length, 0);
  }
});
test('baseline ACL must equal source plus exactly the three observed provider rights without settings or property drift', async () => {
  for (const options of [{ baselineAcl: sourceAcl }, { baselineAcl: providerAcl.slice(1) },
    { baselineAcl: providerAcl.map((row, i) => i === 4 ? { ...row, is_grantable: true } : row) },
    { baselineAcl: providerAcl.map((row, i) => i === 4 ? { ...row, grantor: 'neon_superuser' } : row) },
    { currentSetting: true }, { propertyDrift: true }, { globalSetting: true }]) {
    const run = cluster(options); await assert.rejects(preflight(run)); assert.equal(run.writes.length, 0);
  }
});
test('an unapproved or changed preflight cannot start a mutable prepare', async () => {
  const run = cluster(); const plan = await preflight(run);
  await assert.rejects(prepare(run, undefined), /APPROVED_PREPARE_PREFLIGHT_REQUIRED/u);
  await assert.rejects(prepare(run, { ...plan, sourceDatabaseSha256: 'e'.repeat(64) }), /APPROVED_PREPARE_PREFLIGHT_DRIFT/u);
  assert.equal(run.writes.length, 0);
});
test('a late foreign connection stops before rename without terminating sessions or dropping created databases', async () => {
  const clean = cluster(); const plan = await preflight(clean); const run = cluster({ lateSession: true });
  await assert.rejects(prepare(run, plan), /PREPARE_TARGET_FOREIGN_SESSION/u);
  assert.equal(run.writes.length, 1); assert.ok(run.databases.has('neondb')); assert.ok(run.databases.has(managementDatabase));
  assert.equal(run.evidence.at(-1).status, 'FAIL'); assert.equal(run.clients.size, 0);
});
test('only idle cloud_admin sessions in unchanged postgres are allowed and reported without unstable PIDs', async () => {
  const providerSessions = [900001, 900002, 900003].map((pid) => ({ pid, database: 'postgres', role: 'cloud_admin', state: 'idle' }));
  const run = cluster({ providerSessions }); const plan = await preflight(run);
  const otherPids = cluster({ pidOffset: 500, providerSessions: providerSessions.map((row) => ({ ...row, pid: row.pid + 100 })) });
  assert.equal((await preflight(otherPids)).sha256, plan.sha256);
  assert.equal(plan.providerBackgroundSessions.count, 3);
  assert.deepEqual(plan.providerBackgroundSessions.inventory, providerSessions.map(({ database, role, state }) => ({ database, role, state })));
  assert.ok(!JSON.stringify(plan).includes('900001'));
  const result = await prepare(run, plan);
  assert.equal(result.status, 'PASS'); assert.deepEqual(result.providerBackgroundSessions, plan.providerBackgroundSessions);
  assert.ok(run.writes.every((sql) => !/terminate|cancel|alter.*postgres/u.test(sql)));
});
test('provider-looking sessions with another role, active state or any changed database still fail before writes', async () => {
  const background = { pid: 900001, database: 'postgres', role: 'cloud_admin', state: 'idle' };
  for (const row of [
    { ...background, role: 'neon_service' }, { ...background, role: 'neondb_owner' },
    { ...background, state: 'active' }, { ...background, state: 'idle in transaction' }, { ...background, state: null },
    { ...background, database: 'neondb' }, { ...background, database: managementDatabase }, { ...background, database: providerBaselineDatabase },
    { ...background, database: 'unrelated_database' }
  ]) {
    const run = cluster({ providerSessions: [row] });
    await assert.rejects(preflight(run), /PREPARE_TARGET_FOREIGN_SESSION/u);
    assert.equal(run.writes.length, 0);
  }
});
test('template0 ACL mismatch or preserved OID drift stops without trying to repair ACLs or continue', async () => {
  const clean = cluster(); const plan = await preflight(clean);
  for (const options of [{ freshAclDrift: true }, { preservedOidDrift: true }]) {
    const run = cluster(options); await assert.rejects(prepare(run, plan));
    assert.ok(run.writes.length <= 2); assert.equal(run.evidence.at(-1).status, 'FAIL');
    assert.ok(run.writes.every((sql) => !/drop|grant|revoke/u.test(sql)));
  }
});
test('DDL failure or lost acknowledgement leaves a failed one-shot run and cannot silently resume', async () => {
  const clean = cluster(); const plan = await preflight(clean);
  for (const options of [{ failWrite: 1 }, { failWrite: 2 }, { failWrite: 3 }, { lostDdlAcknowledgement: true }]) {
    const run = cluster(options); await assert.rejects(prepare(run, plan));
    assert.equal(run.evidence.at(-1).status, 'FAIL'); assert.equal(run.clients.size, 0);
    const writesBeforeRetry = run.writes.length;
    if (run.databases.has(managementDatabase)) {
      await assert.rejects(prepare(run, plan)); assert.equal(run.writes.length, writesBeforeRetry);
    }
  }
});
