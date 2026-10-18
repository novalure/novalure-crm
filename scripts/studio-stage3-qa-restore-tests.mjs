import test from 'node:test';
import assert from 'node:assert/strict';
import { restoreSelectedQa, sourceTarget, restoreTarget, applicationRoles, compareDatabaseFingerprints } from './lib/studio-stage3-qa-restore.mjs';
import { databaseQueries, catalogQueries, extensionQueries, sourceExtensions, captureExtensionMetadata, captureDatabaseMetadata } from './lib/studio-stage3-qa-fingerprint.mjs';
const databaseProperties = { owner: 'neondb_owner', encoding: 'UTF8', collation: 'C.UTF-8', ctype: 'C.UTF-8', locale_provider: 'c', locale: null, icu_rules: null, collation_version: null, allow_connections: true, is_template: false, connection_limit: -1 };
const databaseAcl = [{ grantee: 'PUBLIC', grantor: 'neondb_owner', privilege_type: 'CONNECT', is_grantable: false }, { grantee: 'PUBLIC', grantor: 'neondb_owner', privilege_type: 'TEMPORARY', is_grantable: false }, { grantee: 'neondb_owner', grantor: 'neondb_owner', privilege_type: 'CREATE', is_grantable: false }];
const defaultDatabase = await captureDatabaseMetadata({ query: async (sql) => ({ rows: sql === databaseQueries.properties ? [databaseProperties] : sql === databaseQueries.acl ? databaseAcl : [] }) });
const plpgsql = { name: 'plpgsql', version: '1.0', schema: 'pg_catalog', owner: 'cloud_admin' };
const installed = [sourceExtensions[0], plpgsql, sourceExtensions[1]];
const namespaces = [{ nspname: 'public', owner: 'neondb_owner' }];
const schemaGrants = ['USAGE', 'CREATE'].map((privilege_type) => ({ nspname: 'public', owner: 'neondb_owner', grantee: 'neondb_owner', grantor: 'neondb_owner', privilege_type, is_grantable: false }));
const members = [{ catalog: 'pg_proc', object_type: 'function', schema: 'public', name: 'digest', identity: 'public.digest(text, text)', definition: { owner: 'neondb_owner', definition: 'synthetic extension function' } }];
const privileges = [{ catalog: 'pg_proc', identity: 'public.digest(text, text)', grantee: 'PUBLIC', grantor: 'neondb_owner', privilege_type: 'EXECUTE', is_grantable: false }];
const sourceProfile = await captureExtensionMetadata({ query: async (sql) => ({ rows:
  sql === extensionQueries.server ? [{ version: '17.11', version_num: 170011 }] :
    sql === extensionQueries.installed ? installed : sql === extensionQueries.members ? members :
      sql === extensionQueries.privileges ? privileges : sql === catalogQueries.namespaces ? namespaces : sql === catalogQueries.schemaGrants ? schemaGrants : [] }) });
const fp = () => ({ databaseName: sourceTarget.databaseName, projectId: sourceTarget.projectId, branchId: sourceTarget.branchId,
  readOnlyTransaction: true, database: defaultDatabase, extensionProfile: sourceProfile, schema: { sha256: 'a'.repeat(64) },
  ledger: { sha256: 'b'.repeat(64), rows: 42, through: 85, completeCanonicalCoverage: true, verifiedCommittedChecksums: true },
  executionReceipts: { sha256: 'c'.repeat(64), original061Verified: true },
  data: { sha256: 'd'.repeat(64), tables: 141, rows: 118 },
  classification: { markerChecks: 'PASS_NARROW_MARKER_CHECKS' } });
function targetClient({ nonempty = false, badIdentity = false, existing = false, unsafeMembership = false, creationFailure = false, databaseOverride = {}, badOwner = false, unavailableVersion = false, unknownExtension = false, extraSchema = false, extraGlobal = false, preparedExtraObject = false, preparedVersionDrift = false, preparedStructureDrift = false, preparedAclDrift = false } = {}) {
  const calls = []; let roleReads = 0, extensionCreates = 0, installedReads = 0;
  return { calls, async query(sql) {
    calls.push(sql);
    if (sql.includes("as session_role")) return { rows: [{ project: badIdentity ? sourceTarget.projectId : restoreTarget.projectId,
      branch: restoreTarget.branchId, database: 'neondb', role: 'neondb_owner', session_role: 'neondb_owner', database_owner: badOwner ? 'other_owner' : 'neondb_owner' }] };
    const databaseKind = Object.keys(databaseQueries).find((key) => databaseQueries[key] === sql);
    if (databaseKind) return { rows: databaseOverride[databaseKind] || (databaseKind === 'properties' ? [databaseProperties] : databaseKind === 'acl' ? databaseAcl : []) };
    if (sql === extensionQueries.server) return { rows: [{ version: '18.6', version_num: 180006 }] };
    if (sql === extensionQueries.installed) {
      installedReads++;
      return { rows: extensionCreates === 2 ? installed.map((row) => preparedVersionDrift && row.name === 'vector' ? { ...row, version: '0.8.6' } : row) : unknownExtension ? [plpgsql, { name: 'unknown', version: '1', schema: 'public', owner: 'neondb_owner' }] : [plpgsql] };
    }
    if (sql === extensionQueries.members) return { rows: extensionCreates === 2 ? preparedStructureDrift ? [{ ...members[0], definition: { changed: true } }] : members : [] };
    if (sql === extensionQueries.privileges) return { rows: extensionCreates === 2 ? preparedAclDrift && installedReads > 3 ? [...privileges, { ...privileges[0], grantee: 'novalure_app' }] : privileges : [] };
    if (sql === catalogQueries.namespaces) return { rows: extraSchema ? [...namespaces, { nspname: 'unexpected', owner: 'neondb_owner' }] : namespaces };
    if (sql === catalogQueries.schemaGrants) return { rows: schemaGrants };
    if (sql === extensionQueries.available) return { rows: sourceExtensions.filter((row) => !unavailableVersion || row.name !== 'vector') };
    if (sql === extensionQueries.globalObjects) return { rows: [{ count: extraGlobal ? 1 : 0 }] };
    if (sql === extensionQueries.userObjects) return { rows: extensionCreates === 2
      ? [...sourceExtensions.map((row) => ({ catalog: 'pg_extension', object_type: 'extension', schema: null, name: row.name, identity: row.name })), ...members,
        ...(preparedExtraObject ? [{ catalog: 'pg_proc', object_type: 'function', schema: 'public', name: 'extra', identity: 'public.extra()' }] : [])]
      : nonempty ? [{ catalog: 'pg_class', object_type: 'table', schema: 'public', name: 'extra', identity: 'public.extra' }] : [] };
    if (sql.startsWith('create extension')) extensionCreates++;
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
  assert.deepEqual(run.target.calls.filter((sql) => sql.startsWith('create extension')), [
    'create extension "pgcrypto" with schema "public" version \'1.3\'',
    'create extension "vector" with schema "public" version \'0.8.0\''
  ]);
  assert.equal(result.crossVersionProfile.sourceServer.version_num, 170011);
  assert.equal(result.crossVersionProfile.targetServer.version_num, 180006);
  assert.match(result.crossVersionProfile.scope, /Not a general disaster-recovery proof/u);
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
    assert.ok(run.target.calls.every((sql) => /^(begin|select|rollback)\b/iu.test(sql) || [extensionQueries.members, extensionQueries.privileges, extensionQueries.userObjects].includes(sql)));
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

test('database owner ACL CONNECT CREATE or setting drift fails before target roles or passwords', async () => {
  for (const targetOptions of [
    { badOwner: true },
    { databaseOverride: { properties: [{ ...databaseProperties, owner: 'other_owner' }] } },
    { databaseOverride: { acl: databaseAcl.filter((row) => row.privilege_type !== 'CONNECT') } },
    { databaseOverride: { acl: databaseAcl.filter((row) => row.privilege_type !== 'CREATE') } },
    { databaseOverride: { acl: [...databaseAcl, { grantee: 'PUBLIC', grantor: 'neondb_owner', privilege_type: 'CREATE', is_grantable: false }] } },
    { databaseOverride: { settings: [{ database_scope: 'CURRENT_DATABASE', role_name: 'ALL_ROLES', setting: 'search_path=different' }] } }
  ]) {
    const run = runOptions({ targetOptions });
    await assert.rejects(restoreSelectedQa(run.options));
    assert.equal(run.nativeCalls.length, 0); assert.equal(run.passwords.length, 0);
    assert.ok(!run.target.calls.some((sql) => /^(create|alter|grant|drop|revoke)\b/iu.test(sql)));
    assert.equal(run.evidence.at(-1).status, 'FAIL');
  }
});
test('database properties remain checked after native restore in addition to public schema and rows', async () => {
  const run = runOptions(); const capture = run.options.capture;
  run.options.capture = async (client) => client === run.target
    ? { ...fp(), database: { ...defaultDatabase, sha256: 'f'.repeat(64) } } : capture(client);
  await assert.rejects(restoreSelectedQa(run.options), /RESTORED_DATABASE_FINGERPRINT_MISMATCH/u);
  assert.equal(run.evidence.at(-1).status, 'FAIL');
});
test('an old approved report without database metadata cannot authorize target changes', async () => {
  const run = runOptions();
  run.options.approvedSource = { ...fp(), database: undefined };
  await assert.rejects(restoreSelectedQa(run.options), /SOURCE_FINGERPRINT_NOT_APPROVED/u);
  assert.equal(run.target.calls.length, 0); assert.equal(run.passwords.length, 0);
});

test('a missing source-authorized PUBLIC CREATE privilege also blocks before target writes', async () => {
  const sourceDatabase = await captureDatabaseMetadata({ query: async (sql) => ({ rows:
    sql === databaseQueries.properties ? [databaseProperties] :
      sql === databaseQueries.acl ? [...databaseAcl, { grantee: 'PUBLIC', grantor: 'neondb_owner', privilege_type: 'CREATE', is_grantable: false }] : [] }) });
  const run = runOptions();
  run.options.approvedSource = { ...fp(), database: sourceDatabase };
  run.options.capture = async () => ({ ...fp(), database: sourceDatabase });
  await assert.rejects(restoreSelectedQa(run.options), /SOURCE_TARGET_DATABASE_METADATA_MISMATCH/u);
  assert.equal(run.nativeCalls.length, 0); assert.equal(run.passwords.length, 0);
  assert.ok(!run.target.calls.some((sql) => /^(create|alter|grant|drop|revoke)\b/iu.test(sql)));
});
test('unavailable exact versions, unknown extensions, extra schema or global objects stop before any target mutation', async () => {
  for (const targetOptions of [{ unavailableVersion: true }, { unknownExtension: true }, { extraSchema: true }, { extraGlobal: true }]) {
    const run = runOptions({ targetOptions });
    await assert.rejects(restoreSelectedQa(run.options));
    assert.equal(run.nativeCalls.length, 0); assert.equal(run.passwords.length, 0);
    assert.ok(!run.target.calls.some((sql) => /^(create|alter|grant|drop|revoke)\b/iu.test(sql)));
    assert.equal(run.evidence.at(-1).status, 'FAIL');
  }
});
test('only the exact source extension list and versions can authorize setup', async () => {
  for (const extensionProfile of [undefined,
    { ...sourceProfile, extensions: [...installed, { name: 'unreviewed', version: '1', schema: 'public', owner: 'neondb_owner' }] },
    { ...sourceProfile, extensions: installed.map((row) => row.name === 'vector' ? { ...row, version: '0.8.6' } : row) }]) {
    const run = runOptions();
    const report = { ...fp(), extensionProfile };
    run.options.approvedSource = report; run.options.capture = async () => report;
    await assert.rejects(restoreSelectedQa(run.options));
    assert.equal(run.target.calls.length, 0); assert.equal(run.nativeCalls.length, 0);
  }
});
test('preinstalled extension members do not permit an extra object, changed version, changed structure or wider ACL', async () => {
  for (const targetOptions of [{ preparedExtraObject: true }, { preparedVersionDrift: true }, { preparedStructureDrift: true }, { preparedAclDrift: true }]) {
    const run = runOptions({ targetOptions });
    await assert.rejects(restoreSelectedQa(run.options));
    assert.ok(!run.nativeCalls.some(([, action]) => action === 'restore'));
    assert.equal(run.evidence.at(-1).status, 'FAIL');
    assert.ok(!run.target.calls.some((sql) => /^(alter extension|drop|revoke)\b/iu.test(sql)));
  }
});
test('source tenant grants may be absent before restore but must all match in the final full fingerprint', async () => {
  const run = runOptions();
  const extended = { ...sourceProfile, privileges: [...privileges, { ...privileges[0], grantee: 'novalure_tenant_app' }], sha256: '8'.repeat(64) };
  run.options.approvedSource = { ...fp(), extensionProfile: extended };
  run.options.capture = async (client) => client === run.target
    ? fp() : { ...fp(), extensionProfile: extended };
  await assert.rejects(restoreSelectedQa(run.options), /RESTORED_DATABASE_FINGERPRINT_MISMATCH/u);
  assert.ok(run.nativeCalls.some(([, action]) => action === 'restore'));
  assert.equal(run.evidence.at(-1).status, 'FAIL');
});
