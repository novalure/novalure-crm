import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { serialize } from 'pg-protocol';
import { createCrmCandidateManifest, crmCandidateOriginalSources, crmCandidateCurrentSources, crmCandidateSourceExtension,
  crmCandidateSourceExtensionSha256, crmCandidateSourceManifestSha256, crmCandidateExecutionVariantSha256, crmCandidateVariant, crmCandidateTarget, digest, sha256,
  validateCrmCandidateDescriptor, validateCrmCandidatePlan } from './lib/crm-candidate-fresh-manifest.mjs';
import { createCrmCandidatePgConfig, loadCrmCandidateCommittedManifest, validateCrmCandidatePrivateInput, verifyRuntime } from './crm-candidate-fresh-bootstrap.mjs';
import { planCrmCandidateOfficialStep, crmCandidateMetadataEnvironment } from './lib/crm-candidate-official-migrations.mjs';
import { assertCrmCandidateProviderRoles, assertCrmCandidateSessions, completeCrmCandidateFreshSchema, crmCandidateQueries } from './lib/crm-candidate-fresh-bootstrap.mjs';
import { catalogQueries } from './lib/studio-stage3-qa-fingerprint.mjs';
import { startLocalSalesDb } from './lib/local-sales-db.mjs';

const headCommit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const now = Date.now();
// Explicitly synthetic descriptor data. No native project or creation receipt exists in this test.
const descriptor = {
  format: 'crm-candidate-free-target-v1', status: 'NATIVE_NEW_FREE_PROJECT_AUTHORIZED', sourceRevision: headCommit,
  organizationId: 'org-cool-cloud-50864215', plan: 'free', projectId: 'synthetic-fresh-project-12345678',
  branchId: 'br-synthetic-fresh-12345678', branchParentId: null, endpointId: 'ep-synthetic-fresh-12345678',
  projectCreatedAt: new Date(now).toISOString(), directHost: 'ep-synthetic-fresh-12345678.eu-central-1.aws.neon.tech',
  pooledHost: 'ep-synthetic-fresh-12345678-pooler.eu-central-1.aws.neon.tech', databaseName: 'neondb',
  runtimeRole: 'novalure_app', migrationRole: 'neondb_owner', productionDirectHost: 'ep-synthetic-prod-12345678.eu-central-1.aws.neon.tech',
  productionPooledHost: 'ep-synthetic-prod-12345678-pooler.eu-central-1.aws.neon.tech', nativeCreationReceiptSha256: 'b'.repeat(64),
};
const files = crmCandidateCurrentSources.forward.map(row => ({ path: row.path, content: readFileSync(row.path, 'utf8') }));
const staged = crmCandidateOriginalSources.staged087.map(row => ({ path: row.path, content: readFileSync(row.path, 'utf8') }));
const manifest = createCrmCandidateManifest(files, staged, headCommit);
const descriptorDigest = digest(descriptor);

test('actual pg startup serialization excludes pooled timeout GUCs while preserving direct owner options and TLS', () => {
  const base = { descriptor, database: 'neondb', migrationPassword: 'PUBLIC_SYNTHETIC_PASSWORD', ca: 'PUBLIC_SYNTHETIC_CA' };
  const runtime = createCrmCandidatePgConfig({ ...base, runtimePassword: 'a'.repeat(80) });
  const owner = createCrmCandidatePgConfig(base);
  const startup = config => {
    // Real installed pg8 startup construction and the exact pg-protocol writer;
    // no connection, socket, authentication, provider response or SQL is mocked.
    const bytes = serialize.startup(new pg.Client(config).getStartupConf());
    assert.equal(bytes.readInt32BE(0), bytes.length);
    assert.equal(bytes.readInt32BE(4), 196608);
    const strings = bytes.subarray(8).toString('utf8').split('\0');
    assert.deepEqual(strings.splice(-2), ['', '']);
    assert.equal(strings.length % 2, 0);
    return Object.fromEntries(Array.from({ length: strings.length / 2 }, (_, index) => [strings[index * 2], strings[index * 2 + 1]]));
  };
  const runtimePacket = startup(runtime), ownerPacket = startup(owner);
  for (const key of ['options', 'statement_timeout', 'lock_timeout', 'idle_in_transaction_session_timeout']) {
    assert.equal(Object.hasOwn(runtime, key), false);
    assert.equal(Object.hasOwn(runtimePacket, key), false);
  }
  assert.deepEqual(runtimePacket, { user: 'novalure_app', database: 'neondb',
    application_name: 'crm-candidate-original-qa-bootstrap', client_encoding: 'UTF8' });
  assert.equal(ownerPacket.options, '-c statement_timeout=840000 -c lock_timeout=5000 -c idle_in_transaction_session_timeout=60000');
  assert.equal(ownerPacket.user, 'neondb_owner');
  for (const [config, host] of [[runtime, descriptor.pooledHost], [owner, descriptor.directHost]]) {
    assert.equal(config.host, host); assert.equal(config.ssl.servername, host);
    assert.equal(config.ssl.rejectUnauthorized, true); assert.equal(config.ssl.ca, base.ca);
    assert.equal(config.enableChannelBinding, true); assert.equal(config.sslnegotiation, 'postgres');
    assert.equal(config.query_timeout, 960_000); assert.equal(config.connectionTimeoutMillis, 15_000);
  }
  assert.throws(() => createCrmCandidatePgConfig({ ...base, database: 'postgres', runtimePassword: 'a'.repeat(80) }), /CONNECT_DATABASE_SCOPE/);
  assert.throws(() => createCrmCandidatePgConfig({ ...base, database: 'foreign' }), /CONNECT_DATABASE_SCOPE/);
});

function runtimeVerificationFixture({ failAt, settings = {}, posture = true, physical = 1, visible = 0,
  retired = true, runtimeProject = descriptor.projectId, rollbackFailure = false } = {}) {
  const calls = []; let active = false;
  const identity = roleName => ({ projectId: descriptor.projectId, branchId: descriptor.branchId,
    databaseName: 'neondb', roleName, serverVersionNum: '180007' });
  const client = role => ({ async query(query) {
    const text = typeof query === 'string' ? query : query.text;
    let step;
    if (text === 'begin read only' || text === 'rollback' || text.startsWith('set local ')) step = text;
    else if (text.includes("current_setting('transaction_read_only')")) step = 'settings';
    else if (text.includes("current_setting('neon.project_id'")) step = role + '_identity';
    else if (text.includes('from pg_roles r join pg_authid')) step = 'retired';
    else if (text.includes('not r.rolsuper')) step = 'posture';
    else if (text.includes('count(*)::int from forms')) step = role === 'runtime' ? 'visible' : 'physical';
    else assert.fail('Unexpected runtime-verification statement');
    calls.push({ role, step });
    if (step === failAt) throw new Error('SYNTHETIC_VERIFICATION_STEP_FAILED');
    if (step === 'begin read only') { assert.equal(active, false); active = true; return { rows: [] }; }
    if (step === 'rollback') { active = false; if (rollbackFailure) throw new Error('SYNTHETIC_ROLLBACK_FAILED'); return { rows: [] }; }
    assert.equal(active, true, 'Every verification read belongs to the same open runtime transaction');
    if (step.startsWith('set local ')) { assert.equal(role, 'runtime'); return { rows: [] }; }
    if (step === 'settings') return { rows: [{ read_only: true, statement_timeout_ok: true, lock_timeout_ok: true, idle_timeout_ok: true, ...settings }] };
    if (step === 'runtime_identity') return { rows: [{ ...identity('novalure_app'), projectId: runtimeProject }] };
    if (step === 'owner_identity') return { rows: [identity('neondb_owner')] };
    if (step === 'posture') return { rows: [{ safe: posture }] };
    if (step === 'physical') return { rows: [{ forms: physical, integrations: physical }] };
    if (step === 'visible') return { rows: [{ forms: visible, integrations: visible }] };
    if (step === 'retired') return { rows: [{ safe: retired }] };
  } });
  return { runtime: client('runtime'), owner: client('owner'), calls, active: () => active };
}

test('runtime identity, all existing posture/default-deny/retired checks share one bounded read-only transaction', async () => {
  const f = runtimeVerificationFixture();
  const result = await verifyRuntime(f.runtime, f.owner, descriptor);
  assert.equal(result.safeRoleSeparation, true); assert.equal(result.noContextDefaultDeny, true);
  assert.equal(result.retiredLookupNoLoginPasswordNull, true);
  assert.equal(result.runtimeIdentity.roleName, 'novalure_app'); assert.equal(result.ownerIdentity.roleName, 'neondb_owner');
  assert.deepEqual(f.calls.map(row => row.step), ['begin read only', 'set local statement_timeout=840000',
    'set local lock_timeout=5000', 'set local idle_in_transaction_session_timeout=60000', 'settings',
    'runtime_identity', 'owner_identity', 'posture', 'physical', 'visible', 'retired', 'rollback']);
  assert.equal(f.calls[0].role, 'runtime'); assert.equal(f.calls.at(-1).role, 'runtime');
  assert.equal(f.active(), false);
});

test('every failed runtime verification phase attempts rollback; no failed rollback can return a verified result', async () => {
  for (const failAt of ['begin read only', 'set local statement_timeout=840000', 'set local lock_timeout=5000',
    'set local idle_in_transaction_session_timeout=60000', 'settings', 'runtime_identity', 'owner_identity',
    'posture', 'physical', 'visible', 'retired']) {
    const f = runtimeVerificationFixture({ failAt });
    await assert.rejects(verifyRuntime(f.runtime, f.owner, descriptor), /SYNTHETIC_VERIFICATION_STEP_FAILED/);
    assert.deepEqual(f.calls.at(-1), { role: 'runtime', step: 'rollback' });
    assert.equal(f.active(), false);
  }
  const f = runtimeVerificationFixture({ rollbackFailure: true });
  await assert.rejects(verifyRuntime(f.runtime, f.owner, descriptor), /CRM_QA_RUNTIME_ROLLBACK_UNCONFIRMED/);
});

test('read-only/timeout readback and each pre-existing runtime authority guard still reject drift', async () => {
  for (const field of ['read_only', 'statement_timeout_ok', 'lock_timeout_ok', 'idle_timeout_ok']) {
    for (const value of [false, undefined, 'true']) {
      const f = runtimeVerificationFixture({ settings: { [field]: value } });
      await assert.rejects(verifyRuntime(f.runtime, f.owner, descriptor), /CRM_QA_RUNTIME_TRANSACTION_LIMITS/);
      assert.equal(f.calls.some(row => row.step === 'runtime_identity'), false);
      assert.equal(f.calls.at(-1).step, 'rollback');
    }
  }
  for (const [change, code] of [[{ runtimeProject: 'foreign' }, /fingerprint/], [{ posture: false }, /FULL_RUNTIME_POSTURE/],
    [{ physical: 0 }, /GATEWAY_ORIGINAL_SEEDS_MISSING/], [{ visible: 1 }, /RUNTIME_DEFAULT_DENY/], [{ retired: false }, /LOOKUP_NOT_RETIRED/]]) {
    const f = runtimeVerificationFixture(change);
    await assert.rejects(verifyRuntime(f.runtime, f.owner, descriptor), code);
    assert.equal(f.calls.at(-1).step, 'rollback'); assert.equal(f.active(), false);
  }
});

test('real loopback PostgreSQL applies and rolls back the exact runtime GUCs when native Neon identity is absent', async () => {
  const db = await startLocalSalesDb();
  const client = await db.pool.connect();
  const snapshot = () => client.query(`select current_setting('transaction_read_only') read_only,
    current_setting('statement_timeout') statement_timeout,current_setting('lock_timeout') lock_timeout,
    current_setting('idle_in_transaction_session_timeout') idle_timeout`);
  try {
    const before = (await snapshot()).rows;
    let actualLimits;
    const observed = { async query(query) {
      const result = await client.query(query);
      if (typeof query === 'string' && query.includes("current_setting('transaction_read_only')='on'")) actualLimits = result.rows[0];
      return result;
    } };
    await assert.rejects(verifyRuntime(observed, { query: () => assert.fail('Missing Neon identity must deny before owner reads') }, descriptor), /fingerprint/);
    assert.deepEqual(actualLimits, { read_only: true, statement_timeout_ok: true, lock_timeout_ok: true, idle_timeout_ok: true });
    assert.deepEqual((await snapshot()).rows, before, 'ROLLBACK restores every original timeout and read-only setting');
  } finally { client.release(); await db.stop(); }
});

// The five-name shape was observed read-only on native PG18.7. These test rows
// remain fixtures, not a new native preflight or SQL-installation claim.
const providerRoles = [
  { name: 'cloud_admin', login: true, superuser: true, bypassrls: true, create_database: true, create_role: true, replication: true },
  { name: 'neon_service', login: true, superuser: false, bypassrls: true, create_database: true, create_role: true, replication: true },
  { name: 'neon_superuser', login: false, superuser: false, bypassrls: true, create_database: true, create_role: true, replication: true },
  { name: 'neondb_owner', login: true, superuser: false, bypassrls: true, create_database: true, create_role: true, replication: true },
  { name: 'token_roles', login: false, superuser: false, bypassrls: false, create_database: false, create_role: false, replication: false },
];
const providerMemberships = [{ parent: 'neon_superuser', member: 'neondb_owner', grantor: 'cloud_admin',
  admin_option: false, inherit_option: true, set_option: true }];
const plan = () => {
  const bound = { headCommit, descriptorDigest, manifestDigest: manifest.sha256, target: crmCandidateTarget(descriptor), syntheticCatalog: true };
  return { format: 'crm-candidate-fresh-plan-v1', capturedAt: new Date(now).toISOString(), bound, sha256: digest(bound) };
};

test('new candidate recognizes only the native five-role shape with inert reserved token role; prior four names still work', () => {
  assert.equal(assertCrmCandidateProviderRoles(providerRoles, providerMemberships), providerRoles);
  assert.equal(assertCrmCandidateProviderRoles(providerRoles.slice(0, 4), providerMemberships).length, 4);
});

test('reserved token LOGIN/elevated/replication/membership or unknown provider roles remain denied', () => {
  for (const flag of ['login', 'superuser', 'bypassrls', 'create_database', 'create_role', 'replication']) {
    for (const value of [true, undefined, 'false']) {
      const altered = providerRoles.map(row => row.name === 'token_roles' ? { ...row, [flag]: value } : row);
      assert.throws(() => assertCrmCandidateProviderRoles(altered, providerMemberships), /RESERVED_TOKEN_ROLE_UNSAFE/);
    }
  }
  for (const edge of [
    { parent: 'neon_superuser', member: 'token_roles', grantor: 'cloud_admin' },
    { parent: 'token_roles', member: 'novalure_app', grantor: 'cloud_admin' },
    { parent: 'token_roles', member: 'other_bridge', grantor: 'cloud_admin' },
    { parent: 'pg_monitor', member: 'token_roles', grantor: 'cloud_admin' },
    { parent: 'neon_superuser', member: 'other_bridge', grantor: 'token_roles' },
  ]) assert.throws(() => assertCrmCandidateProviderRoles(providerRoles, [...providerMemberships, edge]), /RESERVED_TOKEN_ROLE_UNSAFE/);
  assert.throws(() => assertCrmCandidateProviderRoles([...providerRoles, { ...providerRoles[4], name: 'unknown_provider' }], providerMemberships), /FRESH_PROVIDER_ROLES/);
  assert.throws(() => assertCrmCandidateProviderRoles([...providerRoles, providerRoles[4]], providerMemberships), /FRESH_PROVIDER_ROLES/);
});

const sessionOwn = new Map([[11, 'postgres'], [12, 'neondb']]);
const ownSessions = [...sessionOwn].map(([pid, database]) => ({ pid, database, role: 'neondb_owner',
  state: 'active', backend_type: 'client backend', application_name: 'crm-candidate-original-qa-bootstrap' }));
const monitor = application_name => ({ pid: 21, database: 'postgres', role: 'cloud_admin', state: 'active',
  backend_type: 'client backend', application_name });

test('provider quiescence retries only reads and succeeds only after original strict-idle observation', async () => {
  for (const app of ['compute_ctl:compute_monitor', 'vm-monitor', 'neon_compute_sql_exporter']) {
    let reads = 0; const waits = [];
    const result = await assertCrmCandidateSessions({ own: sessionOwn, readSessions: async () => {
      reads++; return [...ownSessions, { ...monitor(app), state: reads === 1 ? 'active' : 'idle' }];
    }, wait: async ms => waits.push(ms) });
    assert.equal(result.attempts, 2); assert.equal(reads, 2); assert.deepEqual(waits, [100]);
  }
  const waits = [];
  const immediate = await assertCrmCandidateSessions({ own: sessionOwn,
    readSessions: async () => [...ownSessions, { ...monitor('original-idle-provider'), state: 'idle' }], wait: async ms => waits.push(ms) });
  assert.equal(immediate.attempts, 1); assert.equal(waits.length, 0);
});

test('known provider active never authorizes a write: five reads/four pauses then a safe held diagnostic', async () => {
  let reads = 0; const waits = [];
  await assert.rejects(assertCrmCandidateSessions({ own: sessionOwn,
    readSessions: async () => { reads++; return [...ownSessions, monitor('vm-monitor')]; },
    wait: async ms => waits.push(ms) }), error => {
    assert.equal(error.message, 'CRM_QA_FOREIGN_SESSION');
    assert.equal(error.sessionGuardDiagnostic.reason, 'PROVIDER_NOT_QUIESCENT_TIMEOUT');
    assert.equal(error.sessionGuardDiagnostic.attempts, 5);
    assert.equal(error.sessionGuardDiagnostic.sessions[0].application, 'vm-monitor');
    assert.equal(error.sessionGuardDiagnostic.sessions[0].state, 'active');
    return true;
  });
  assert.equal(reads, 5); assert.deepEqual(waits, [100, 100, 100, 100]);
});

test('own PID/identity failures and arbitrary foreign sessions deny immediately without waiting', async () => {
  const base = monitor('compute_ctl:compute_monitor');
  const cases = [
    { rows: [...ownSessions.slice(1), base], reason: 'MISSING_OWN_PID' },
    { rows: [...ownSessions.map((row, index) => index ? row : { ...row, role: 'cloud_admin' }), base], reason: 'MISMATCHED_OWN_IDENTITY' },
    { rows: [...ownSessions.map((row, index) => index ? row : { ...row, database: 'neondb' }), base], reason: 'MISMATCHED_OWN_IDENTITY' },
    { rows: [...ownSessions, base, { ...base, pid: 22, role: 'novalure_app' }], reason: 'UNRECOGNIZED_FOREIGN_SESSION' },
    ...[{ ...base, database: 'neondb' }, { ...base, role: 'neondb_owner' }, { ...base, backend_type: 'parallel worker' },
      { ...base, application_name: 'unknown-app' }, { ...base, state: 'idle in transaction' },
      { ...base, state: 'idle in transaction (aborted)' }, { ...base, state: null }]
      .map(row => ({ rows: [...ownSessions, row], reason: 'UNRECOGNIZED_FOREIGN_SESSION' })),
    { rows: [...ownSessions, ownSessions[0]], reason: 'INVALID_SESSION_INVENTORY' },
  ];
  for (const { rows, reason } of cases) {
    let reads = 0, waits = 0;
    await assert.rejects(assertCrmCandidateSessions({ own: sessionOwn, readSessions: async () => { reads++; return rows; },
      wait: async () => { waits++; } }), error => {
      assert.equal(error.sessionGuardDiagnostic.reason, reason); return true;
    });
    assert.equal(reads, 1); assert.equal(waits, 0);
  }
});

test('failed-session projection is bounded and never forwards unknown application, role, database or query text', async () => {
  const privateLabel = 'postgresql://SYNTHETIC-PRIVATE-NOT-A-CREDENTIAL@example.invalid/db';
  const rows = Array.from({ length: 50 }, (_, index) => ({ ...monitor(privateLabel), pid: index + 100,
    role: privateLabel, database: privateLabel, query: privateLabel }));
  await assert.rejects(assertCrmCandidateSessions({ own: sessionOwn, readSessions: async () => [...ownSessions, ...rows],
    wait: async () => assert.fail('Unknown sessions must not wait') }), error => {
    const diagnostic = error.sessionGuardDiagnostic;
    assert.equal(diagnostic.sessions.length, 32); assert.equal(diagnostic.observedCount, 52);
    assert.equal(diagnostic.sessions[0].roleClass, 'OTHER'); assert.equal(diagnostic.sessions[0].databaseClass, 'OTHER');
    assert.equal(diagnostic.sessions[0].application, 'OTHER'); assert.equal(diagnostic.sessions[0].applicationSha256, sha256(privateLabel));
    assert.ok(!JSON.stringify(diagnostic).includes(privateLabel)); assert.ok(!JSON.stringify(diagnostic).includes('query'));
    return true;
  });
});


test('historical061 module imports and renders independently without any new CRM registry or helper', async () => {
  const root = path.resolve('.npm-cache/qa');
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(path.join(root, 'crm-061-independent-'));
  const filename = path.join(directory, 'neon-061-compat.mjs');
  await writeFile(filename, readFileSync('scripts/lib/neon-061-compat.mjs'), { flag: 'wx' });
  const standalone = await import(pathToFileURL(filename).href);
  const source = files.find(row => row.path === 'migrations/061_validate_and_activate_tenant_rls_pilot.sql').content;
  assert.equal(standalone.renderNeon061Compatibility(source).sourceChecksum,
    manifest.forward.find(row => row.number === 61).checksum);
  await assert.rejects(standalone.applyNeon061Compatibility({}), /exact runner commit and plan digest/);
  // Own test output is intentionally retained; no tracked source was renamed or removed.
});

test('exact177-file current inventory appends202–209 to unchanged169-source baseline; standalone174-execution/133-ledger and83 early originals', () => {
  const actual = loadCrmCandidateCommittedManifest(headCommit);
  assert.equal(actual.sha256, manifest.sha256);
  assert.equal(actual.forward.length, 177); assert.equal(actual.early.length, 83);
  assert.equal(actual.forward.filter(row => row.number >= 41).length, 136);
  assert.equal(actual.selected.length, 174);
  assert.equal(actual.selected.filter(row => row.number >= 41).length, 133);
  assert.deepEqual(actual.forward.slice(0, 169).map(row => ({ path: row.path, sha256: row.checksum, manual: row.manual })), crmCandidateOriginalSources.forward);
  assert.equal(sha256(readFileSync('config/crm-candidate-fresh-migrations.json', 'utf8').replace(/\r\n/g, '\n')), crmCandidateSourceManifestSha256);
  assert.equal(sha256(readFileSync('config/crm-candidate-fresh-execution-variant.json', 'utf8').replace(/\r\n/g, '\n')), crmCandidateExecutionVariantSha256);
  assert.deepEqual([crmCandidateVariant.sourceInventorySqlFiles, crmCandidateVariant.executedOriginalSqlFiles, crmCandidateVariant.expectedCanonicalLedgerRows], [169, 166, 125]);
  const added = actual.forward.find(row => row.number === 202), registered = crmCandidateSourceExtension.forward[0];
  assert.deepEqual(actual.forward.slice(169).map(row => ({ path: row.path, sha256: row.checksum, manual: row.manual })), crmCandidateSourceExtension.forward);
  assert.equal(added.path, 'migrations/202_website_sales_ireland.sql');
  assert.equal(added.checksum, '6c4fce55b90fdbb4579c8a97f4d8891c54cab987c939d47a5d9b3282dae9b0fb');
  assert.equal(added.checksum, registered.sha256);
  assert.equal(actual.forward.at(-1).path, 'migrations/209_website_sales_commerce.sql');
  assert.equal(actual.forward.at(-1).checksum, '6e540bbe55d5514fe933500b225f35a4a103c0e44fea36ea857af0b31140f5cb');
  assert.equal(actual.sourceExtensionSha256, crmCandidateSourceExtensionSha256);
  assert.ok(actual.standard.some(row => row.path === added.path && row.checksum === added.checksum && !row.manual));
  assert.deepEqual(actual.coverage, { sourceInventorySqlFiles: 177, executedOriginalSqlFiles: 174, historicalExecutionsBeforeLedger: 41, expectedCanonicalLedgerRows: 133 });
  assert.deepEqual(actual.forward.slice(-4).map(row => row.path), ['migrations/206_website_sales_operations.sql', 'migrations/207_website_sales_conversations.sql', 'migrations/208_website_sales_enablement.sql', 'migrations/209_website_sales_commerce.sql']);
  assert.deepEqual(actual.excluded.map(row => row.path), ['migrations/097_studio_sales_calendar_bridge.sql',
    'migrations/098_studio_enquiry_handoff.sql', 'migrations/099_studio_enquiry_public_launch.sql']);
  assert.ok(actual.excluded.every(row => row.execution === 'NOT_EXECUTED_INCOMPATIBLE_PREVIEW_VARIANT'));
  assert.ok(Object.isFrozen(actual.excluded) && actual.excluded.every(Object.isFrozen));
  assert.equal(actual.forward.filter(row => row.number === 13).length, 2);
  assert.equal(actual.forward.filter(row => row.number === 108).length, 2);
  assert.equal(actual.early[actual.early.findIndex(row => row.number === 60) - 1].number, 62);
  assert.ok(actual.explicit.find(row => row.number === 95).manual);
  assert.ok(actual.explicit.find(row => row.number === 120).manual);
  assert.ok(actual.standard.some(row => row.number === 199));
  assert.deepEqual(actual.staged087.map(row => row.path), staged.map(row => row.path));
});

test('missing, duplicate, extra, changed originals or changed staged source fail before execution', () => {
  const variants = [files.slice(1), [...files, files[0]], [...files.slice(1), files[1]],
    files.map((row, index) => index === 0 ? { ...row, content: row.content + '\n-- altered' } : row),
    files.slice(0, -1), [...files, files.at(-1)], [...files, { path: 'migrations/203_unregistered.sql', content: 'select 1;' }],
    ...[202, 206, 207, 208, 209].map(number => files.map(row => Number(row.path.split('/').at(-1).slice(0, 3)) === number ? { ...row, content: row.content + `\n-- changed${number}` } : row))];
  for (const variant of variants) assert.throws(() => createCrmCandidateManifest(variant, staged, headCommit));
  assert.throws(() => createCrmCandidateManifest(files, staged.slice(1), headCommit));
  assert.throws(() => createCrmCandidateManifest(files, staged.map(row => ({ ...row, content: row.content + '-- changed' })), headCommit));
  // Worktree CRLF is normalized exactly as the original official ledger contract.
  assert.equal(createCrmCandidateManifest(files.map(row => ({ ...row, content: row.content.replace(/\r?\n/g, '\r\n') })), staged, headCommit).sha256, manifest.sha256);
});

test('owner-reviewed new Free descriptor has exact digest/source/identity and no credentials', () => {
  assert.deepEqual(validateCrmCandidateDescriptor(descriptor, { expectedDigest: descriptorDigest, headCommit, now }), descriptor);
  const cases = [
    { status: 'PENDING_NATIVE_PROJECT' }, { organizationId: 'org-divine-silence-19529003' }, { plan: 'launch' },
    ...['misty-cloud-70835427', 'weathered-term-98273025', 'super-block-59791927', 'green-thunder-49879900'].map(projectId => ({ projectId })),
    { branchParentId: 'br-production-parent' }, { directHost: descriptor.productionDirectHost, pooledHost: descriptor.productionPooledHost },
    { pooledHost: descriptor.directHost }, { endpointId: 'ep-foreign-endpoint-12345678' }, { databaseName: 'other_db' },
    { runtimeRole: 'neondb_owner' }, { migrationRole: 'novalure_app' }, { sourceRevision: 'c'.repeat(40) },
    { projectCreatedAt: new Date(now - 86_400_001).toISOString() }, { projectCreatedAt: new Date(now + 1).toISOString() },
    { nativeCreationReceiptSha256: 'PENDING' }, { password: 'synthetic-not-a-secret' },
  ];
  for (const change of cases) {
    const altered = { ...descriptor, ...change };
    assert.throws(() => validateCrmCandidateDescriptor(altered, { expectedDigest: digest(altered), headCommit, now }));
  }
  assert.throws(() => validateCrmCandidateDescriptor(descriptor, { expectedDigest: 'd'.repeat(64), headCommit, now }));
});

test('private recent plan rejects revision, catalog, descriptor, target, SQL, age and digest drift', () => {
  assert.equal(validateCrmCandidatePlan(plan(), { descriptor, descriptorDigest, manifest, headCommit, now }).sha256, plan().sha256);
  for (const altered of [
    { ...plan(), capturedAt: new Date(now - 3_600_001).toISOString() },
    { ...plan(), capturedAt: new Date(now + 1).toISOString() }, { ...plan(), sha256: 'a'.repeat(64) },
    { ...plan(), bound: { ...plan().bound, headCommit: 'c'.repeat(40) } },
    { ...plan(), bound: { ...plan().bound, syntheticCatalog: 'changed' } },
    { ...plan(), bound: { ...plan().bound, target: { ...plan().bound.target, databaseName: 'foreign' } } },
    { ...plan(), bound: { ...plan().bound, descriptorDigest: 'c'.repeat(64) } },
    { ...plan(), bound: { ...plan().bound, manifestDigest: 'c'.repeat(64) } },
  ]) assert.throws(() => validateCrmCandidatePlan(altered, { descriptor, descriptorDigest, manifest, headCommit, now }));
});

test('private stdin accepts only exact direct owner URL and80-hex runtime password; never an env credential', () => {
  const url = `postgresql://neondb_owner:synthetic-password@${descriptor.directHost}/neondb?sslmode=verify-full`;
  assert.equal(validateCrmCandidatePrivateInput({ migrationDatabaseUrl: url }, descriptor, '--preflight').url.hostname, descriptor.directHost);
  assert.equal(validateCrmCandidatePrivateInput({ migrationDatabaseUrl: url, runtimePassword: 'a'.repeat(80) }, descriptor, '--apply').runtimePassword.length, 80);
  for (const changed of [url.replace(descriptor.directHost, descriptor.pooledHost), url.replace('/neondb?', '/other?'),
    url.replace('neondb_owner:', 'novalure_app:'), url.replace('verify-full', 'disable'), url + '&options=-csearch_path=foreign',
    url + '&sslmode=verify-full', url.replace(descriptor.directHost, descriptor.productionDirectHost)]) {
    assert.throws(() => validateCrmCandidatePrivateInput({ migrationDatabaseUrl: changed }, descriptor, '--preflight'));
  }
  assert.throws(() => validateCrmCandidatePrivateInput({ migrationDatabaseUrl: url, runtimePassword: "'; invalid" }, descriptor, '--apply'));
  assert.throws(() => validateCrmCandidatePrivateInput({ migrationDatabaseUrl: url, environment: {} }, descriptor, '--preflight'));
  assert.ok(!JSON.stringify(crmCandidateMetadataEnvironment(descriptor)).includes('postgresql://'));
});

const ledgerRow = row => ({ version: row.version, name: row.name, checksum: row.checksum, number: row.number });
test('official planner preserves explicit manual predecessors and tokens bind full source/ledger/target', () => {
  const connectedTarget = { projectId: descriptor.projectId, branchId: descriptor.branchId, databaseName: 'neondb',
    roleName: 'neondb_owner', serverVersionNum: 180000, target: 'test' };
  const official = manifest.forward.map(row => ({ ...row, rollback: false, manualCutover: row.manual }));
  const chosen = manifest.explicit.find(row => row.number === 96);
  const preceding = manifest.forward.filter(row => row.number >= 41 && row.number < 96).map(ledgerRow);
  const input = { connectedTarget, migrations: official, ledgerRows: preceding, migration: chosen, headCommit, descriptor, cwd: process.cwd() };
  const a = planCrmCandidateOfficialStep(input);
  assert.deepEqual(a.plan.map(row => row.version), ['096_public_integration_gateway']);
  assert.throws(() => planCrmCandidateOfficialStep({ ...input, migration: { ...chosen, manual: false } }), /manual cutover/);
  assert.throws(() => planCrmCandidateOfficialStep({ ...input, ledgerRows: preceding.filter(row => row.number !== 95) }), /predecessor/);
  const other = planCrmCandidateOfficialStep({ ...input, connectedTarget: { ...connectedTarget, branchId: 'br-synthetic-different' } });
  assert.notEqual(other.token, a.token);
  assert.throws(() => planCrmCandidateOfficialStep({ ...input, ledgerRows: [...preceding, ledgerRow(chosen)] }), /UNEXPECTED_PLAN/);
  const preview = manifest.forward.find(row => row.number === 97);
  assert.throws(() => planCrmCandidateOfficialStep({ ...input, migration: preview }), /INCOMPATIBLE_PREVIEW_VARIANT/);
  assert.throws(() => planCrmCandidateOfficialStep({ ...input, ledgerRows: [...preceding, ledgerRow(preview)] }), /PREVIEW_ALREADY_INSTALLED/);
  const beforeExtension = manifest.selected.filter(row => row.number >= 41 && row.number < 202).map(ledgerRow);
  assert.equal(beforeExtension.length, 125, 'Historical standalone ledger remains unchanged before the additive202 step');
  const appended = planCrmCandidateOfficialStep({ ...input, migration: null, ledgerRows: beforeExtension });
  assert.deepEqual(appended.plan.map(row => ({ version: row.version, checksum: row.checksum })), crmCandidateSourceExtension.forward.map(row => ({version:row.path.split('/').at(-1).replace(/\.sql$/, ''),checksum:row.sha256})));
});

test('synthetic orchestration only: all086–209 and actual staged source identities retained; failures do not claim full success', async () => {
  const initial = manifest.early.filter(row => row.number >= 41).map(ledgerRow);
  const rows = [...initial], events = [], calls = [], stageSql = [];
  let observedRoles = providerRoles, observedMemberships = providerMemberships;
  const client = { async query(query) {
    if (query === crmCandidateQueries.providerRoles) return { rows: observedRoles };
    if (query === catalogQueries.memberships) return { rows: observedMemberships };
    if (query === 'select version,name,checksum from public.novalure_schema_migrations order by version') return { rows };
    if (query === manifest.staged087[0].content) { stageSql.push(query); return { rows: [{ crm_d11_backfill_batch: { remaining: { synthetic: 0 } } }] }; }
    if (query === manifest.staged087[1].content) { stageSql.push(query); return { rows: [] }; }
    assert.ok(['begin', 'commit', 'rollback'].includes(query)); return { rows: [] };
  } };
  const earlyResult = { status: 'PASS_NEW_NATIVE_EARLY_SCHEMA_THROUGH_085', headCommit, manifestDigest: manifest.sha256,
    providerRoleBaseline: { roles: providerRoles, sha256: digest(providerRoles) } };
  const runOfficial = async row => { calls.push(row?.version || 'STANDARD'); rows.push(...(row ? [row] : manifest.standard).map(ledgerRow)); };
  const result = await completeCrmCandidateFreshSchema({ client, manifest, earlyResult, runOfficial, journal: async event => events.push(event) });
  assert.equal(result.ledger.rows, 133); assert.equal(result.forwardSqlFiles, 174);
  assert.equal(result.sourceInventorySqlFiles, 177); assert.equal(result.excluded.length, 3);
  assert.equal(result.status, 'PASS_NEW_NATIVE_STANDALONE_SCHEMA_209');
  assert.equal(result.sourceExtensionSha256, crmCandidateSourceExtensionSha256);
  assert.ok(rows.some(row => row.version === '202_website_sales_ireland' && row.checksum === crmCandidateSourceExtension.forward[0].sha256));
  assert.equal(result.productionReadiness, false); assert.equal(result.applicationAcceptance, 'PENDING_EXISTING_MANUAL_QA');
  assert.equal(calls.length, manifest.explicit.length + 1); assert.equal(stageSql.length, 2);
  assert.deepEqual(result.staged087.map(row => row.checksum), manifest.staged087.map(row => row.checksum));
  assert.equal(events.filter(row => row.event === 'COMPLETE_SCHEMA_VERIFIED').length, 1);
  rows.splice(0, rows.length, ...initial);
  const failedEvents = [];
  await assert.rejects(completeCrmCandidateFreshSchema({ client, manifest, earlyResult,
    runOfficial: async () => { throw new Error('SYNTHETIC_OFFICIAL_FAILURE'); }, journal: async event => failedEvents.push(event) }));
  assert.equal(failedEvents.some(row => row.event === 'COMPLETE_SCHEMA_VERIFIED'), false);
  for (const alteration of ['token_flag', 'provider_drift', 'token_runtime_grant']) {
    rows.splice(0, rows.length, ...initial);
    observedRoles = providerRoles; observedMemberships = providerMemberships;
    const deniedEvents = []; let attempts = 0;
    await assert.rejects(completeCrmCandidateFreshSchema({ client, manifest, earlyResult,
      runOfficial: async row => {
        attempts++; rows.push(ledgerRow(row));
        if (alteration === 'token_flag') observedRoles = providerRoles.map(role => role.name === 'token_roles' ? { ...role, replication: true } : role);
        if (alteration === 'provider_drift') observedRoles = providerRoles.map(role => role.name === 'neon_service' ? { ...role, login: false } : role);
        if (alteration === 'token_runtime_grant') observedMemberships = [...providerMemberships,
          { parent: 'token_roles', member: 'novalure_app', grantor: 'neondb_owner', admin_option: false, inherit_option: true, set_option: true }];
      }, journal: async event => deniedEvents.push(event) }), /RESERVED_TOKEN_ROLE_UNSAFE|PROVIDER_BASELINE_CHANGED/);
    assert.equal(attempts, 1);
    assert.equal(deniedEvents.some(row => row.event === 'COMPLETE_SCHEMA_VERIFIED'), false);
  }
});
