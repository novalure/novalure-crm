import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateBackupConfig, validatePrivateManifest, runCrmFullBackup, readCrmBackupIndex, readCrmBackupFreshness, planBackupRetention, sha256, BACKUP_SCOPE, CrmBackupError } from './lib/crm-full-backup.mjs';
import { createCrmBackupProviderPorts } from './lib/crm-full-backup-providers.mjs';
import { createCrmBackupHttpHandler } from './lib/crm-full-backup-http.mjs';
import { createCrmBackupFailureNotifier } from './lib/crm-backup-failure-warning.mjs';

const NOW = '2026-11-01T20:00:00.000Z';
const backupId = 'backup-20261101-proof';
const config = Object.freeze({
  neonProjectId: 'misty-cloud-70835427', sourceBranchId: 'br-spring-night-alyu48yp',
  productionEndpointId: 'ep-wandering-union-alem0781', databaseName: 'neondb',
  sourceStoreId: 'store_vCn7LiyRocYNC8pM', targetStoreId: 'store_Xq45pbZfYunmR6ah',
  backupProjectId: 'prj_bmEuDFXrLvSX2VXtt2GQ9Mbrfrlk', teamId: 'team_sjD78IkSicXJK6TAOR1JC7Wv',
  snapshotId: 'snap-full-backup-proof', retentionDays: 7,
});
const workspaceId = '11111111-1111-4111-8111-111111111111';
const sourceId = '22222222-2222-4222-8222-222222222222';
const historicalVersionId = '33333333-3333-4333-8333-333333333333';
const currentVersionId = '44444444-4444-4444-8444-444444444444';
const assetId = '55555555-5555-4555-8555-555555555555';
const imageId = '66666666-6666-4666-8666-666666666666';
const isFull = pathname => /(?:\/FULL|-FULL)\.json$/u.test(pathname);
const isFile = pathname => pathname.includes('/files/');
const hasSafeCode = error => typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]+$/u.test(error.code);

function fixture(overrides = {}, snapshotId = config.snapshotId) {
  const pdf = Buffer.from('SYNTHETIC private document bytes');
  const image = Buffer.from('SYNTHETIC private CRM image bytes');
  const assets = [
    { id: assetId, workspaceId, pathname: `${workspaceId}/private.pdf`, bytes: pdf.length, mimeType: 'application/pdf', storageProvider: 'vercel-blob', storageAccess: 'private', isPublic: false, publicToken: null },
    { id: imageId, workspaceId, pathname: `${workspaceId}/private.png`, bytes: image.length, mimeType: 'image/png', storageProvider: 'vercel-blob', storageAccess: 'private', isPublic: false, publicToken: null },
  ];
  const inventory = { assets, references: [
    { versionId: historicalVersionId, sourceId, workspaceId, assetId, status: 'approved', isCurrent: false },
    { versionId: currentVersionId, sourceId, workspaceId, assetId, status: 'draft', isCurrent: true },
  ], missingReferences: [], legacyPublic: [{ id: '77777777-7777-4777-8777-777777777777', workspaceId, pathname: `${workspaceId}/legacy.pdf`, bytes: 362780, storageAccess: 'legacy-public' }] };
  const files = new Map([[assetId, pdf], [imageId, image]]);
  const target = new Map();
  const events = [];
  const writes = [];
  const production = { projectId: config.neonProjectId,
    sourceBranch: { id: config.sourceBranchId, name: 'main', default: true, primary: true },
    endpoint: { id: config.productionEndpointId, projectId: config.neonProjectId, branchId: config.sourceBranchId, host: 'ep-wandering-union-alem0781.c-3.eu-central-1.aws.neon.tech', type: 'read_write', disabled: false },
    defaultBranchId: config.sourceBranchId,
  };
  let isolated;
  const endpoint = { id: 'ep-isolated-backup-proof', projectId: config.neonProjectId, branchId: 'br-isolated-backup-proof', host: 'ep-isolated-backup-proof.c-3.eu-central-1.aws.neon.tech', type: 'read_write', disabled: false, currentState: 'active' };
  const receipt = (pathname, body, storeId = config.targetStoreId) => ({ storeId, pathname, access: 'private', body: Buffer.from(body) });
  const ports = {
    credentialsReady: async () => ({ neonApiKey: true, productionOidc: true, projectId: config.backupProjectId, teamId: config.teamId, environment: 'production' }),
    readProductionBinding: async () => { events.push('readProductionBinding'); return structuredClone(production); },
    snapshotInfo: async id => { events.push('snapshotInfo'); return { id, sourceBranchId: config.sourceBranchId, createdAt: NOW }; },
    listSourceObjects: async () => { events.push('listSourceObjects'); return [...assets.map(a => ({ storeId: config.sourceStoreId, pathname: a.pathname, size: a.bytes, access: 'private' })), { storeId: config.sourceStoreId, pathname: `${workspaceId}/orphan-private.pdf`, size: 4, access: 'private' }]; },
    restoreSnapshot: async args => {
      events.push('restoreSnapshot');
      assert.equal(args.finalize, false);
      assert.equal('targetBranchId' in args, false);
      assert.equal('target_branch_id' in args, false);
      assert.equal(args.snapshotId, snapshotId);
      isolated = { finalize: false, branch: { id: 'br-isolated-backup-proof', projectId: config.neonProjectId, name: args.name, restoredFrom: args.snapshotId, restoreStatus: 'restored', default: false, primary: false }, endpoints: [] };
      return structuredClone(isolated);
    },
    waitForRestore: async result => { events.push('waitForRestore'); return result; },
    getIsolatedEndpoints: async branch => { events.push('getIsolatedEndpoints'); assert.equal(branch.id, endpoint.branchId); return [structuredClone(endpoint)]; },
    prepareIsolatedEndpoint: async (branch, endpoints) => { events.push('prepareIsolatedEndpoint'); assert.equal(branch.id, endpoint.branchId); return structuredClone(endpoints[0] ?? endpoint); },
    captureDatabase: async () => { events.push('captureDatabase'); return { identity: { projectId: config.neonProjectId, branchId: endpoint.branchId, databaseName: config.databaseName, readOnly: true, rlsFilteredTables: 0 }, fingerprint: { sha256: 'a'.repeat(64), tables: [], catalog: {}, sequences: [] }, inventory: structuredClone(inventory) }; },
    readSourceFile: async file => { events.push(`readSourceFile:${file.id ?? file.assetId}`); const bytes = files.get(file.id ?? file.assetId); return bytes ? receipt(file.pathname, bytes, config.sourceStoreId) : null; },
    listTargetRecords: async prefix => [...target.keys()].filter(pathname => pathname.startsWith(prefix)).map(pathname => ({ storeId: config.targetStoreId, pathname, access: 'private' })),
    readTarget: async pathname => { events.push(`readTarget:${pathname}`); const body = target.get(pathname); return body === undefined ? null : receipt(pathname, body); },
    writeTarget: async (pathname, bytes, options) => {
      events.push(`writeTarget:${pathname}`);
      assert.equal(options.access, 'private');
      assert.equal(options.allowOverwrite, false);
      assert.equal(options.addRandomSuffix, false);
      assert.equal(target.has(pathname), false, 'The fixture forbids overwriting any existing target object');
      const data = Buffer.from(bytes);
      writes.push({ pathname, bytes: data, options }); target.set(pathname, data);
      return { storeId: config.targetStoreId, pathname, access: 'private' };
    },
    disableIsolatedEndpoint: async actual => { events.push('disableIsolatedEndpoint'); assert.equal(actual.id, endpoint.id); endpoint.disabled = true; endpoint.currentState = 'idle'; return { ...actual, disabled: true, currentState: 'idle' }; },
    ...overrides,
  };
  const backupConfig = { ...config, snapshotId };
  return { config: { ...backupConfig }, ports, events, writes, target, files, inventory, production, endpoint, receipt, run: () => runCrmFullBackup({ config: { ...backupConfig }, ports, now: NOW, backupId }) };
}
const assertNoFull = f => assert.equal(f.writes.filter(write => isFull(write.pathname)).length, 0, 'A failed backup must not leave a FULL completion marker');

test('actual backup failures reach the signed warning bridge without new FULL or production mutations', async t => {
  const cases = [
    ['missing credential', 'CREDENTIALS_UNAVAILABLE', f => { f.ports.credentialsReady = async () => ({ neonApiKey: false }); }],
    ['provider failure', 'PROVIDER_UNAVAILABLE', f => { f.ports.snapshotInfo = async () => { throw new CrmBackupError('NEON_REQUEST_FAILED'); }; }],
    ['wrong snapshot', 'SNAPSHOT_UNAVAILABLE', f => { f.ports.snapshotInfo = async () => ({ id: f.config.snapshotId, sourceBranchId: 'br-foreign-snapshot', createdAt: NOW }); }],
    ['missing private file', 'DATA_INTEGRITY_FAILED', f => { f.files.delete(assetId); }],
    ['corrupt private bytes', 'DATA_INTEGRITY_FAILED', f => { f.files.set(assetId, Buffer.from('SYNTHETIC corrupt source')); }],
    ['target write failure', 'PROVIDER_UNAVAILABLE', f => { f.ports.writeTarget = async () => { throw new CrmBackupError('BACKUP_PROVIDER_REQUEST_FAILED'); }; }],
    ['cleanup not idle', 'CLEANUP_UNCONFIRMED', f => { f.ports.disableIsolatedEndpoint = async ep => ({ ...ep, disabled: true, currentState: 'active' }); }],
    ['production drift', 'PRODUCTION_BINDING_CHANGED', f => {
      const read = f.ports.readProductionBinding;
      f.ports.readProductionBinding = async () => { const value = await read(); if (f.events.includes('restoreSnapshot')) value.defaultBranchId = 'br-unexpected-default'; return value; };
    }],
    ['unknown I/O exception', 'PROVIDER_UNAVAILABLE', f => { f.ports.snapshotInfo = async () => { throw new Error('SYNTHETIC_PRIVATE_PROVIDER_ERROR_MUST_NOT_LEAK'); }; }],
    ['snapshot already claimed', 'SNAPSHOT_ALREADY_CLAIMED', async f => { await f.run(); }],
  ];
  for (const [name, failureClass, change] of cases) await t.test(name, async () => {
    const f = fixture();
    await change(f);
    const fullBefore = f.writes.filter(write => isFull(write.pathname)).length;
    const restoresBefore = f.events.filter(value => value === 'restoreSnapshot').length;
    const runId = '99999999-9999-4999-8999-999999999999';
    const bridgeEnv = { VERCEL_ENV: 'production', VERCEL_PROJECT_ID: config.backupProjectId,
      VERCEL_TEAM_ID: config.teamId, CRM_FULL_BACKUP_ENABLED: 'true',
      CRON_SECRET: 'SYNTHETIC_CRON_SECRET_WITH_AT_LEAST_THIRTY_TWO_BYTES',
      CRM_BACKUP_WARNING_ENABLED: 'true', CRM_BACKUP_WARNING_HMAC_KEY: '1'.repeat(64) };
    const warnings = [], logs = [];
    const oidcClaims = { iss: 'https://oidc.vercel.com/novalure', aud: 'https://vercel.com/novalure',
      sub: 'owner:novalure:project:synthetic-backup:environment:production', project_id: config.backupProjectId,
      owner_id: config.teamId, environment: 'production', iat: Date.parse(NOW) / 1000 - 30, exp: Date.parse(NOW) / 1000 + 3600 };
    const oidcToken = [JSON.stringify({ alg: 'RS256', kid: 'synthetic' }), JSON.stringify(oidcClaims), 'synthetic-signature']
      .map(part => Buffer.from(part).toString('base64url')).join('.');
    const notify = createCrmBackupFailureNotifier({ env: bridgeEnv,
      endpoint: 'https://evelyn-canary.novalure.eu/api/ops/backup-failure', now: () => Date.parse(NOW),
      request: async (_url, init) => {
        const envelope = JSON.parse(init.body);
        warnings.push(envelope);
        assert.equal(init.headers['x-novalure-backup-timestamp'], NOW);
        assert.match(init.headers['x-novalure-backup-signature'], /^[a-f0-9]{64}$/u);
        // This is deliberately a local transport fixture, not a live delivery claim.
        return Response.json({ status: 'DELIVERED', eventId: envelope.eventId, receiptSha256: 'a'.repeat(64) });
      } });
    const handler = createCrmBackupHttpHandler({ env: bridgeEnv, createRunId: () => runId,
      now: () => Date.parse(NOW), getOidcToken: () => oidcToken, notifyFailure: notify, log: value => logs.push(value),
      run: async (argv, _env, capture) => {
        assert.deepEqual(argv, ['--execute', '--backup-id', `backup-${runId}`]);
        try {
          const result = await runCrmFullBackup({ config: f.config, ports: f.ports, now: NOW, backupId: argv[2] });
          capture({ status: result.status }); return 0;
        } catch (error) {
          capture({ status: 'INCOMPLETE', code: error instanceof CrmBackupError ? error.code : 'BACKUP_CONFIGURATION_OR_IO_FAILED', fullBackupClaimed: false });
          return 1;
        }
      } });
    const response = await handler(new Request('https://synthetic-backup.example.invalid/api/backup',
      { headers: { authorization: `Bearer ${bridgeEnv.CRON_SECRET}` } }));
    assert.equal(response.status, 503);
    const result = await response.json();
    assert.equal(result.alarmStatus, 'DELIVERED');
    assert.equal(result.status, 'INCOMPLETE');
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].failureClass, failureClass);
    assert.equal(warnings[0].runId, runId);
    assert.equal(f.writes.filter(write => isFull(write.pathname)).length, fullBefore);
    if (name === 'snapshot already claimed') assert.equal(f.events.filter(value => value === 'restoreSnapshot').length, restoresBefore);
    if (name === 'production drift') assert.equal(f.events.includes('disableIsolatedEndpoint'), false, 'Unknown production state prevents further Neon mutation');
    for (const text of [JSON.stringify(result), JSON.stringify(warnings), JSON.stringify(logs)]) {
      assert.equal(text.includes('SYNTHETIC_PRIVATE_PROVIDER_ERROR_MUST_NOT_LEAK'), false);
      assert.equal(text.includes(bridgeEnv.CRON_SECRET), false);
      assert.equal(text.includes(bridgeEnv.CRM_BACKUP_WARNING_HMAC_KEY), false);
      assert.equal(text.includes(oidcToken), false);
    }
    assert.equal(f.production.defaultBranchId, config.sourceBranchId, 'Fault injection never mutates the retained production object');
  });
});

test('backup scope cannot reuse its private source store as target', () => {
  assert.throws(() => validateBackupConfig({ ...config, targetStoreId: config.sourceStoreId }), hasSafeCode);
});

test('private manifest includes generic CRM assets and preserves historical Knowledge references', () => {
  const f = fixture();
  const manifest = validatePrivateManifest(f.inventory);
  assert.equal(manifest.assets.length, 2);
  assert.equal(manifest.references.length, 2);
  assert.equal(manifest.references.some(ref => ref.versionId === historicalVersionId && ref.isCurrent === false), true);
});

test('a historical Knowledge reference with no asset blocks backup completeness', async () => {
  const f = fixture();
  f.inventory.references[0].assetId = '88888888-8888-4888-8888-888888888888';
  assert.throws(() => validatePrivateManifest(f.inventory), hasSafeCode);
  await assert.rejects(f.run(), hasSafeCode);
  assertNoFull(f);
});

test('historical references cannot attach an asset belonging to a different tenant', () => {
  const f = fixture();
  f.inventory.references[0].workspaceId = '99999999-9999-4999-8999-999999999999';
  assert.throws(() => validatePrivateManifest(f.inventory), hasSafeCode);
});

test('missing source bytes never produce a FULL marker', async () => {
  const f = fixture();
  f.files.delete(assetId);
  await assert.rejects(f.run(), hasSafeCode);
  assertNoFull(f);
});

test('wrong production endpoint binding stops before creating an isolated restore', async () => {
  const f = fixture();
  f.production.endpoint.branchId = 'br-unexpected-source';
  await assert.rejects(f.run(), hasSafeCode);
  assert.equal(f.events.includes('restoreSnapshot'), false);
  assertNoFull(f);
});

test('production binding drift after an isolated restore blocks FULL', async () => {
  const f = fixture();
  const normal = f.ports.readProductionBinding;
  f.ports.readProductionBinding = async () => { const result = await normal(); if (f.events.includes('restoreSnapshot')) result.defaultBranchId = 'br-unexpected-new-default'; return result; };
  await assert.rejects(f.run(), hasSafeCode);
  assertNoFull(f);
});

test('a finalized restore response cannot masquerade as an isolated backup copy', async () => {
  const f = fixture();
  const restore = f.ports.restoreSnapshot;
  f.ports.restoreSnapshot = async args => ({ ...await restore(args), finalize: true });
  await assert.rejects(f.run(), hasSafeCode);
  assert.ok(f.events.filter(event => event === 'readProductionBinding').length >= 2, 'Unexpected provider responses still require a post-operation production binding check');
  assertNoFull(f);
});

test('a source receipt from an unbound store blocks FULL', async () => {
  const f = fixture();
  const read = f.ports.readSourceFile;
  f.ports.readSourceFile = async file => ({ ...await read(file), storeId: 'store_foreignPrivateStore' });
  await assert.rejects(f.run(), hasSafeCode);
  assertNoFull(f);
});

test('target readback must match the exact archived bytes and SHA256', async () => {
  const f = fixture();
  const read = f.ports.readTarget;
  f.ports.readTarget = async pathname => { const result = await read(pathname); return result && isFile(pathname) ? { ...result, body: Buffer.from('SYNTHETIC corrupt readback') } : result; };
  await assert.rejects(f.run(), hasSafeCode);
  assertNoFull(f);
});

test('an active or unconfirmed isolated compute blocks FULL even after all files match', async () => {
  const f = fixture();
  f.ports.disableIsolatedEndpoint = async actual => { f.events.push('disableIsolatedEndpoint'); return { ...actual, disabled: true, currentState: 'active' }; };
  await assert.rejects(f.run(), hasSafeCode);
  assert.equal(f.events.includes('disableIsolatedEndpoint'), true);
  assertNoFull(f);
});

test('successful scope is database and all referenced private files, after confirmed cleanup', async () => {
  const f = fixture();
  const result = await f.run();
  assert.equal(result.status, 'FULL');
  assert.equal(result.scope, BACKUP_SCOPE);
  assert.equal(result.wholeApplicationBackup, false);
  const manifest = JSON.parse(f.target.get(result.manifestPath).toString('utf8'));
  assert.equal(manifest.legacyPublic.length, 1);
  assert.equal(manifest.unreferencedSourceObjects.length, 1);
  assert.equal(manifest.historicalReferences.length, 2);
  assert.equal(f.writes.some(write => isFull(write.pathname)), true);
  const cleanup = f.events.indexOf('disableIsolatedEndpoint');
  const complete = f.events.findIndex(event => event.startsWith('writeTarget:') && isFull(event.slice('writeTarget:'.length)));
  assert.ok(cleanup >= 0 && complete > cleanup);
  assert.equal(f.events.filter(event => event.startsWith('readSourceFile:')).length, 2);
  assert.equal(f.writes.filter(write => isFile(write.pathname)).length, 2);
});

test('two exact original-path target files are reused without another upload', async () => {
  const f = fixture();
  for (const asset of f.inventory.assets) f.target.set(asset.pathname, Buffer.from(f.files.get(asset.id)));
  const result = await f.run();
  assert.equal(result.status, 'FULL');
  assert.equal(f.writes.filter(write => isFile(write.pathname)).length, 0);
  assert.equal(f.events.filter(event => event.startsWith('readSourceFile:')).length, 2);
});

test('missing ordinary production credentials stop before every remote operation', async () => {
  const f = fixture();
  f.ports.credentialsReady = async () => ({ neonApiKey: false, productionOidc: false, projectId: config.backupProjectId, teamId: config.teamId, environment: 'production' });
  await assert.rejects(f.run(), hasSafeCode);
  assert.deepEqual(f.events, []);
  assertNoFull(f);
});


test('retention plans only owned completed sets and protects the latest FULL even when old', () => {
  const row = (id, completedAt, more = {}) => ({ status: 'FULL', scope: BACKUP_SCOPE,
    sourceStoreId: config.sourceStoreId, targetStoreId: config.targetStoreId, backupId: id, completedAt,
    manifestPath: `crm-full-backups/sets/${id}/manifest.json`, manifestSha256: sha256(id), ...more });
  const index = [
    row('backup-older-proof', '2026-10-01T00:00:00Z'),
    row('backup-latest-proof', '2026-10-15T00:00:00Z'),
    row('backup-foreign-target', '2026-10-01T00:00:00Z', { targetStoreId: 'store_foreignPrivateStore' }),
    row('backup-source-target', '2026-10-01T00:00:00Z', { targetStoreId: config.sourceStoreId }),
    row('backup-foreign-prefix', '2026-10-01T00:00:00Z', { manifestPath: 'unowned-prefix/manifest.json' }),
    row('backup-incomplete-proof', '2026-10-01T00:00:00Z', { status: 'INCOMPLETE' }),
  ];
  const plan = planBackupRetention(index, { now: NOW, keepDays: 7, sourceStoreId: config.sourceStoreId, targetStoreId: config.targetStoreId });
  assert.equal(plan.mode, 'PLAN_ONLY_NO_DELETIONS');
  assert.equal(plan.protectedLatestFull, 'backup-latest-proof');
  assert.deepEqual(plan.candidates.map(candidate => candidate.backupId), ['backup-older-proof']);
  assert.equal(plan.candidates.every(candidate => candidate.targetStoreId === config.targetStoreId && candidate.requiresFreshManifestAndReferenceRecheck === true), true);
  assert.equal(plan.externalReusedObjectsNeverDeleted, true);
  assert.equal(plan.ignored, 4);
});

test('a claimed snapshot cannot create a second restore under the same or another backup ID', async () => {
  const f = fixture();
  await f.run();
  const restoreCount = f.events.filter(event => event === 'restoreSnapshot').length;
  const fullCount = f.writes.filter(write => isFull(write.pathname)).length;
  for (const id of [backupId, 'backup-second-snapshot-proof']) {
    await assert.rejects(runCrmFullBackup({ config: f.config, ports: f.ports, now: NOW, backupId: id }), hasSafeCode);
    assert.equal(f.events.filter(event => event === 'restoreSnapshot').length, restoreCount);
    assert.equal(f.writes.filter(write => isFull(write.pathname)).length, fullCount);
  }
  assert.equal((await readCrmBackupIndex({ config, ports: f.ports })).length, 1, 'Rejected duplicate claims cannot invalidate the existing complete set');
});


test('the real adapter blocks missing Neon or Production OIDC credentials before any request', async () => {
  for (const env of [{}, { NEON_API_KEY: 'SYNTHETIC-NOT-A-REAL-KEY' }]) {
    let requests = 0;
    const ports = await createCrmBackupProviderPorts(config, { env, fetch: async () => { requests++; throw new Error('A blocked adapter must not request a provider'); } });
    await assert.rejects(runCrmFullBackup({ config, ports, now: NOW, backupId }), error => error?.code === (env.NEON_API_KEY ? 'BLOCKED_PRODUCTION_OIDC_REQUIRED' : 'BLOCKED_NEON_API_KEY_REQUIRED'));
    assert.equal(requests, 0);
  }
});

test('a verified FULL index requires its completion marker; an index candidate alone is insufficient', async () => {
  const f = fixture();
  await f.run();
  const candidate = JSON.parse(f.target.get(`crm-full-backups/index/${backupId}-FULL.json`).toString('utf8'));
  assert.equal(candidate.status, 'COMMIT_CANDIDATE');
  const verified = await readCrmBackupIndex({ config, ports: f.ports });
  assert.equal(verified.length, 1);
  assert.equal(verified[0].status, 'FULL');
  f.target.delete(`crm-full-backups/sets/${backupId}/FULL.json`);
  assert.deepEqual(await readCrmBackupIndex({ config, ports: f.ports }), []);
});

test('tampered manifest data cannot be reported as a verified FULL set', async () => {
  const f = fixture();
  await f.run();
  f.target.set(`crm-full-backups/sets/${backupId}/manifest.json`, Buffer.from('{}'));
  await assert.rejects(readCrmBackupIndex({ config, ports: f.ports }), error => error?.code === 'BACKUP_MANIFEST_HASH_MISMATCH');
});

test('an INCOMPLETE marker suppresses a previously written completion candidate', async () => {
  const f = fixture();
  await f.run();
  f.target.set(`crm-full-backups/sets/${backupId}/INCOMPLETE.json`, Buffer.from('{"status":"INCOMPLETE"}'));
  assert.deepEqual(await readCrmBackupIndex({ config, ports: f.ports }), []);
});

test('freshness uses the newest snapshot creation as a lower bound on age', async () => {
  const newest = fixture();
  await newest.run();
  const older = fixture({ snapshotInfo: async id => ({ id, sourceBranchId: config.sourceBranchId,
    createdAt: '2026-10-31T21:00:00.000001+01:00' }) }, 'snap-older-backup-proof');
  await runCrmFullBackup({ config: older.config, ports: older.ports, now: '2026-11-02T19:00:00.000Z', backupId: 'backup-late-export-proof' });
  for (const [pathname, bytes] of older.target) newest.target.set(pathname, bytes);
  const writeCount = newest.writes.length;
  newest.events.length = 0;
  const ports = Object.freeze({ listTargetRecords: newest.ports.listTargetRecords, readTarget: newest.ports.readTarget });
  assert.deepEqual(await readCrmBackupFreshness({ config, ports, now: '2026-11-02T20:00:00.000Z' }),
    { status: 'unverified', rpoHours: 24 });
  assert.deepEqual(await readCrmBackupFreshness({ config, ports, now: '2026-11-02T20:00:00.001Z' }),
    { status: 'stale', rpoHours: 24, latestPossibleDataAt: NOW, minimumAgeMs: 86_400_001 });
  assert.equal(newest.writes.length, writeCount);
  assert.ok(newest.events.every(event => event.startsWith('readTarget:')));
});

test('a FULL marker visible during the final writer guard cannot prove freshness', async () => {
  const f = fixture();
  const ports = Object.freeze({ listTargetRecords: f.ports.listTargetRecords, readTarget: f.ports.readTarget });
  const readProductionBinding = f.ports.readProductionBinding;
  let observed;
  f.ports.readProductionBinding = async () => {
    if (f.target.has(`crm-full-backups/sets/${backupId}/FULL.json`) && observed === undefined) {
      observed = await readCrmBackupFreshness({ config, ports, now: NOW });
    }
    return readProductionBinding();
  };
  await f.run();
  assert.deepEqual(observed, { status: 'unverified', rpoHours: 24 });
});

test('a separately claimed PITR child yields a combined backup with exact lineage', async () => {
  const pointInTime = '2026-11-01T19:45:00Z';
  const f = fixture();
  const base = { ...f.config };
  delete base.snapshotId;
  const pointConfig = { ...base, pointInTime, pitrBranchLimit: 1 };
  const child = { id: f.endpoint.branchId, projectId: config.neonProjectId, default: false, primary: false,
    parentId: config.sourceBranchId, parentTimestamp: pointInTime, parentLsn: '0/A176B330' };
  const claim = 'crm-full-backups/pitr/20261101194500/claim.json';
  const indexPath = `crm-full-backups/index/${backupId}-FULL.json`;
  const fullPath = `crm-full-backups/sets/${backupId}/FULL.json`;
  let copyAttempts = 0, computeCreated = false;
  let terminalGuardSeen = false;
  const readProduction = f.ports.readProductionBinding;
  f.ports.readProductionBinding = async () => {
    assert.equal(f.target.has(fullPath), false, 'No final source guard can occur after terminal FULL is visible');
    if (f.target.has(indexPath)) terminalGuardSeen = true;
    return readProduction();
  };
  const writeTarget = f.ports.writeTarget;
  f.ports.writeTarget = async (pathname, bytes, options) => {
    if (pathname === fullPath) assert.equal(terminalGuardSeen, true, 'Terminal FULL follows the final source guard');
    return writeTarget(pathname, bytes, options);
  };
  const listEndpoints = f.ports.getIsolatedEndpoints;
  const prepareEndpoint = f.ports.prepareIsolatedEndpoint;
  f.ports.getIsolatedEndpoints = branch => computeCreated ? listEndpoints(branch) : [];
  f.ports.prepareIsolatedEndpoint = async (branch, endpoints) => {
    assert.deepEqual(endpoints, []);
    computeCreated = true;
    return prepareEndpoint(branch, endpoints);
  };
  f.ports.snapshotInfo = f.ports.restoreSnapshot = undefined;
  f.ports.validatePointInTime = async () => ({ pointInTime, historyRetentionSeconds: 21600 });
  f.ports.copyPointInTime = async ({ name }) => {
    copyAttempts++;
    assert.ok(f.target.has(claim), 'The recovery point is claimed before branch creation');
    return { finalize: false, branch: { ...child, name } };
  };
  const args = { config: pointConfig, ports: f.ports, now: NOW, backupId };
  const full = await runCrmFullBackup(args);
  assert.equal(full.status, 'FULL');
  assert.equal(full.snapshotId, undefined);
  assert.deepEqual(full.recoveryPoint, { kind: 'NEON_PITR', sourceBranchId: config.sourceBranchId, requestedAt: pointInTime });
  assert.equal(full.fileCount, 2);
  assert.equal(full.cleanup.status, 'OBSERVED_DISABLED_AND_IDLE');
  assert.equal(JSON.parse(f.target.get(claim)).pointInTime, pointInTime);
  assert.deepEqual(await readCrmBackupIndex({ config, ports: f.ports }), [full]);
  assert.deepEqual(await readCrmBackupFreshness({ config, ports: f.ports, now: '2026-11-02T19:45:01Z' }),
    { status: 'stale', rpoHours: 24, latestPossibleDataAt: '2026-11-01T19:45:00.000Z', minimumAgeMs: 86_401_000 });
  const withoutTerminalProof = { ...full };
  delete withoutTerminalProof.pitrCompletion;
  f.target.set(fullPath, Buffer.from(JSON.stringify(withoutTerminalProof)));
  await assert.rejects(readCrmBackupIndex({ config, ports: f.ports }), { code: 'BACKUP_MANIFEST_PITR_MISMATCH' });
  f.ports.readProductionBinding = readProduction;
  await assert.rejects(runCrmFullBackup({ ...args, backupId: 'backup-duplicate-pitr' }), { code: 'BACKUP_SNAPSHOT_ALREADY_CLAIMED' });
  assert.equal(copyAttempts, 1);
});

test('PITR preflight and child lineage failures leave no FULL and never use the snapshot path', async () => {
  const pointInTime = '2026-11-01T19:45:00Z';
  const f = fixture();
  const base = { ...f.config };
  delete base.snapshotId;
  const args = { config: { ...base, pointInTime, pitrBranchLimit: 1 }, ports: f.ports, now: NOW, backupId };
  f.ports.validatePointInTime = async () => ({ pointInTime: '2026-11-01T19:44:00Z' });
  f.ports.copyPointInTime = async () => { assert.fail('Unverified history must stop before a claim or copy'); };
  await assert.rejects(runCrmFullBackup(args), { code: 'PITR_POINT_NOT_VERIFIED' });
  assert.deepEqual(f.writes, []);
  f.ports.validatePointInTime = async () => ({ pointInTime });
  f.ports.copyPointInTime = async ({ name }) => ({ finalize: false,
    branch: { id: f.endpoint.branchId, projectId: config.neonProjectId, name, default: false, primary: false,
      parentId: 'br-unexpected-parent', parentTimestamp: pointInTime, parentLsn: '0/A176B330' } });
  await assert.rejects(runCrmFullBackup(args), { code: 'PITR_COPY_POINT_MISMATCH' });
  assertNoFull(f);
  assert.ok(!f.events.includes('restoreSnapshot') && !f.events.includes('captureDatabase'));
});

test('a PITR child with unexpected compute is contained before database capture', async () => {
  const pointInTime = '2026-11-01T19:45:00Z';
  const f = fixture();
  const base = { ...f.config };
  delete base.snapshotId;
  f.ports.validatePointInTime = async () => ({ pointInTime });
  f.ports.copyPointInTime = async ({ name }) => ({ finalize: false,
    branch: { id: f.endpoint.branchId, projectId: config.neonProjectId, name, default: false, primary: false,
      parentId: config.sourceBranchId, parentTimestamp: '2026-11-01T19:44:55Z', parentLsn: '0/A176B330' } });
  await assert.rejects(runCrmFullBackup({ config: { ...base, pointInTime, pitrBranchLimit: 1 }, ports: f.ports, now: NOW, backupId }),
    { code: 'PITR_COPY_UNEXPECTED_COMPUTE' });
  assertNoFull(f);
  assert.ok(!f.events.includes('prepareIsolatedEndpoint') && !f.events.includes('captureDatabase'));
  assert.ok(f.events.includes('disableIsolatedEndpoint'));
});

test('freshness distinguishes missing completion from unverifiable private evidence', async () => {
  const f = fixture();
  const ports = Object.freeze({ listTargetRecords: f.ports.listTargetRecords, readTarget: f.ports.readTarget });
  const read = (now = NOW) => readCrmBackupFreshness({ config, ports, now });
  const noFull = { status: 'no-full', rpoHours: 24 };
  const unverified = { status: 'unverified', rpoHours: 24 };
  assert.deepEqual(await read(), noFull);
  await f.run();
  assert.deepEqual(await read('2026-11-01T19:59:59.999Z'), unverified);
  assert.deepEqual(await read('invalid clock'), unverified);
  assert.deepEqual(await read('2026-11-01T21:00:00'), unverified);
  assert.deepEqual(await read('2026-11-31T21:00:00Z'), unverified);
  const root = `crm-full-backups/sets/${backupId}`;
  const full = f.target.get(root + '/FULL.json');
  f.target.delete(root + '/FULL.json');
  assert.deepEqual(await read(), noFull);
  f.target.set(root + '/FULL.json', full);
  f.target.set(root + '/manifest.json', Buffer.from('SYNTHETIC_PRIVATE_DATA_MUST_NOT_LEAK'));
  assert.deepEqual(await read(), unverified);
  f.target.set(root + '/INCOMPLETE.json', Buffer.from('{"status":"INCOMPLETE"}'));
  assert.deepEqual(await read(), noFull);
  const denied = { ...ports, listTargetRecords: async () => { throw new Error('SYNTHETIC_PRIVATE_PROVIDER_ERROR_MUST_NOT_LEAK'); } };
  assert.deepEqual(await readCrmBackupFreshness({ config, ports: denied, now: NOW }), unverified);
});

test('freshness suppresses a FULL when the writer records INCOMPLETE during verification', async () => {
  const f = fixture();
  await f.run();
  const root = `crm-full-backups/sets/${backupId}`;
  const ports = Object.freeze({ listTargetRecords: f.ports.listTargetRecords, readTarget: async pathname => {
    const receipt = await f.ports.readTarget(pathname);
    if (pathname === root + '/manifest.json') f.target.set(root + '/INCOMPLETE.json', Buffer.from('{"status":"INCOMPLETE"}'));
    return receipt;
  } });
  assert.deepEqual(await readCrmBackupFreshness({ config, ports, now: NOW }), { status: 'no-full', rpoHours: 24 });
  assert.equal(f.events.filter(event => event === `readTarget:${root}/INCOMPLETE.json`).length, 2);
});

test('a stored historical Knowledge SHA must agree with the source file bytes', async () => {
  const f = fixture();
  f.inventory.references[0].sha256 = 'b'.repeat(64);
  await assert.rejects(f.run(), hasSafeCode);
  assertNoFull(f);
});


test('a failed production guard after an uncertain FULL write remains INCOMPLETE in the verified index', async () => {
  const f = fixture();
  const write = f.ports.writeTarget;
  f.ports.writeTarget = async (pathname, bytes, options) => {
    const receipt = await write(pathname, bytes, options);
    if (pathname.endsWith('/FULL.json')) {
      f.production.defaultBranchId = 'br-unexpected-post-write-default';
      throw new CrmBackupError('PRODUCTION_BINDING_CHANGED');
    }
    return receipt;
  };
  await assert.rejects(f.run(), hasSafeCode);
  assert.equal(f.target.has(`crm-full-backups/sets/${backupId}/FULL.json`), true, 'The uncertain write physically completed before its guard rejected it');
  const incomplete = JSON.parse(f.target.get(`crm-full-backups/sets/${backupId}/INCOMPLETE.json`).toString('utf8'));
  assert.equal(incomplete.status, 'INCOMPLETE');
  assert.equal(incomplete.failureCode, 'PRODUCTION_BINDING_CHANGED');
  assert.equal(incomplete.productionVerification.status, 'UNCONFIRMED_OR_CHANGED');
  assert.equal(incomplete.fullMarkerState, 'MAY_EXIST_BUT_SUPPRESSED');
  assert.deepEqual(await readCrmBackupIndex({ config, ports: f.ports }), []);
});

test('allowlisted primary provider diagnostics survive orchestration and private INCOMPLETE evidence', async () => {
  const f = fixture();
  f.ports.restoreSnapshot = async () => { throw new CrmBackupError('NEON_HTTP_422', { providerStage: 'SNAPSHOT_RESTORE', providerHttpStatus: 422 }); };
  await assert.rejects(f.run(), error => error.code === 'NEON_HTTP_422' && error.providerStage === 'SNAPSHOT_RESTORE' && error.providerHttpStatus === 422);
  const incomplete = JSON.parse(f.target.get(`crm-full-backups/sets/${backupId}/INCOMPLETE.json`).toString('utf8'));
  assert.equal(incomplete.failureCode, 'NEON_HTTP_422');
  assert.equal(incomplete.providerStage, 'SNAPSHOT_RESTORE');
  assert.equal(incomplete.providerHttpStatus, 422);
  assertNoFull(f);
  const unsafe = new CrmBackupError('NEON_HTTP_422', { providerStage: 'SYNTHETIC_PRIVATE_PROVIDER_PATH', providerHttpStatus: 422, responseBody: 'SYNTHETIC_PRIVATE_ERROR' });
  assert.equal(unsafe.providerStage, undefined);
  assert.equal(unsafe.providerHttpStatus, undefined);
  assert.equal(unsafe.responseBody, undefined);
});
