import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCrmBackupProviderPorts } from './lib/crm-full-backup-providers.mjs';
import { BACKUP_SCOPE, defaultCrmBackupConfig, runCrmFullBackup } from './lib/crm-full-backup.mjs';

const clock = Date.parse('2026-11-01T20:00:00Z');
const config = { ...defaultCrmBackupConfig, snapshotId: 'snap-synthetic-backup-proof' };
const copiedId = 'br-synthetic-isolated-copy';
const copiedEndpointId = 'ep-synthetic-isolated-copy';
const pathname = '11111111-1111-4111-8111-111111111111/private.pdf';
const restoreArgs = { snapshotId: config.snapshotId, name: 'crm-backup-backup-synthetic-proof', finalize: false };
const code = value => error => error?.code === value;
function environment(patch = {}) {
  const payload = { iss: `https://oidc.vercel.com/${config.teamSlug}`, aud: `https://vercel.com/${config.teamSlug}`,
    sub: `owner:${config.teamSlug}:project:synthetic-backup:environment:production`, project_id: config.backupProjectId,
    owner_id: config.teamId, environment: 'production', iat: clock / 1000 - 30, exp: clock / 1000 + 3600 };
  const jwt = [JSON.stringify({ alg: 'RS256', kid: 'synthetic' }), JSON.stringify(payload), 'synthetic-signature']
    .map(value => Buffer.from(value).toString('base64url')).join('.');
  return { NEON_API_KEY: ['SYNTHETIC', 'UNUSABLE', 'KEY'].join('_'), VERCEL_ENV: 'production', VERCEL_OIDC_TOKEN: jwt, ...patch };
}
function fixture(overrides = {}) {
  const calls = [], blobs = [], copied = [], stored = new Map();
  const source = { id: config.sourceBranchId, project_id: config.neonProjectId, name: 'main', default: true, primary: true, current_state: 'ready' };
  const production = { id: config.productionEndpointId, project_id: config.neonProjectId, branch_id: config.sourceBranchId,
    host: `${config.productionEndpointId}.c-3.eu-central-1.aws.neon.tech`, type: 'read_write', disabled: false, current_state: 'active' };
  let restored;
  const url = (storeId, path, access = 'private') => `https://${storeId.slice(6).toLowerCase()}.${access}.blob.vercel-storage.com/${path}`;
  const fetch = async (input, init = {}) => {
    const u = new URL(input), method = init.method ?? 'GET', body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ pathname: u.pathname, search: u.search, method, body, redirect: init.redirect });
    assert.equal(u.origin, 'https://console.neon.tech');
    const root = `/api/v2/projects/${config.neonProjectId}`;
    let value;
    if (u.pathname === root && method === 'GET') value = { project: { id: config.neonProjectId, owner: { subscription_type: 'launch_v3' } } };
    else if (u.pathname === `${root}/branches` && method === 'GET') value = { branches: [source, ...(restored ? [restored] : [])] };
    else if (u.pathname === `${root}/snapshots` && method === 'GET') value = { snapshots: [{ id: config.snapshotId, source_branch_id: source.id, created_at: new Date(clock).toISOString() }] };
    else if (u.pathname === `${root}/endpoints/${config.productionEndpointId}` && method === 'GET') value = { endpoint: production };
    else if (u.pathname === `${root}/snapshots/${config.snapshotId}/restore` && method === 'POST') {
      restored = { id: copiedId, project_id: config.neonProjectId, name: body.name, default: false, primary: false,
        restored_from: config.snapshotId, restore_status: 'restored', current_state: 'ready' };
      if (overrides.restoreWithCompute) copied.push({ id: copiedEndpointId, project_id: config.neonProjectId, branch_id: copiedId,
        host: `${copiedEndpointId}.c-3.eu-central-1.aws.neon.tech`, type: 'read_write', disabled: false, current_state: 'active' });
      // Optional project-wide endpoints in restore response must never be
      // mistaken for owned backup computes.
      value = { branch: restored, endpoints: [production], operations: [] };
      if (overrides.lostRestoreAck) throw new Error('SYNTHETIC transport failure after creation');
    } else if (u.pathname === `${root}/branches/${copiedId}` && method === 'GET') value = { branch: restored };
    else if (u.pathname === `${root}/branches/${copiedId}/endpoints` && method === 'GET') value = { endpoints: copied };
    else if (u.pathname === `${root}/endpoints` && method === 'POST') {
      const endpoint = { id: copiedEndpointId, project_id: config.neonProjectId, branch_id: body.endpoint.branch_id,
        host: `${copiedEndpointId}.c-3.eu-central-1.aws.neon.tech`, type: body.endpoint.type, disabled: body.endpoint.disabled,
        current_state: body.endpoint.disabled ? 'idle' : 'active' };
      copied.push(endpoint); value = { endpoint, operations: [] };
    } else if (u.pathname === `${root}/endpoints/${copiedEndpointId}`) {
      const endpoint = copied.find(row => row.id === copiedEndpointId);
      assert.ok(endpoint);
      if (method === 'PATCH') { endpoint.disabled = body.endpoint.disabled; endpoint.current_state = endpoint.disabled ? 'idle' : 'active'; }
      value = { endpoint, operations: [] };
    } else if (u.pathname === `${root}/connection_uri` && method === 'GET') {
      value = { uri: `postgresql://neondb_owner:${encodeURIComponent(['synthetic', 'only'].join('-'))}@${copiedEndpointId}.c-3.eu-central-1.aws.neon.tech/neondb?sslmode=require${overrides.unsafeUriOptions ? '&options=endpoint%3D' + config.productionEndpointId : ''}` };
    } else throw new Error('SYNTHETIC unexpected provider route');
    return { ok: true, json: async () => structuredClone(value) };
  };
  const blob = {
    list: async options => { blobs.push({ method: 'list', storeId: options.storeId });
      return { blobs: [{ pathname, size: 3, url: url(options.storeId, pathname, overrides.publicBlob ? 'public' : 'private') }], hasMore: false }; },
    get: async (path, options) => { blobs.push({ method: 'get', storeId: options.storeId, path, access: options.access, useCache: options.useCache });
      const bytes = options.storeId === config.sourceStoreId ? Buffer.from('abc') : stored.get(path);
      if (!bytes) return null;
      return { statusCode: 200, blob: { pathname: path, url: url(options.storeId, path) }, stream: new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }) }; },
    put: async (path, bytes, options) => { blobs.push({ method: 'put', storeId: options.storeId, path, access: options.access,
      allowOverwrite: options.allowOverwrite, addRandomSuffix: options.addRandomSuffix });
      assert.equal(stored.has(path), false); stored.set(path, Buffer.from(bytes));
      if (overrides.productionDriftAfterFullPut && path.endsWith('/FULL.json')) production.branch_id = 'br-unexpected-production-binding';
      return { pathname: path, url: url(options.storeId, path) }; },
  };
  const verifyOidc = async (_token, options) => {
    assert.equal(options.projectId, config.backupProjectId); assert.equal(options.ownerId, config.teamId); assert.equal(options.environment, 'production');
    if (overrides.invalidSignature) throw new Error('SYNTHETIC signature invalid');
    return { payload: { project_id: config.backupProjectId, owner_id: config.teamId, environment: 'production' } };
  };
  const make = patch => createCrmBackupProviderPorts(config, { env: environment(overrides.env), fetch, blob, verifyOidc, now: () => clock,
    wait: async () => {}, pollLimit: 2, ...patch });
  return { make, calls, blobs, copied, stored, source, production };
}

test('plan readiness and missing management credentials perform no SDK/fetch operation', async () => {
  const f = fixture({ env: { NEON_API_KEY: undefined } }), ports = await f.make();
  assert.equal((await ports.credentialsReady()).neonApiKey, false);
  await assert.rejects(ports.readProductionBinding(), code('BLOCKED_NEON_API_KEY_REQUIRED'));
  await assert.rejects(ports.listSourceObjects(), code('BLOCKED_NEON_API_KEY_REQUIRED'));
  assert.equal(f.calls.length, 0); assert.equal(f.blobs.length, 0);
});

test('wrong runtime environment and invalid signed identity block before provider access', async () => {
  const f = fixture({ env: { VERCEL_ENV: 'preview' } }), ports = await f.make();
  assert.equal((await ports.credentialsReady()).productionOidc, false);
  await assert.rejects(ports.listSourceObjects(), code('BLOCKED_PRODUCTION_OIDC_REQUIRED'));
  assert.equal(f.blobs.length, 0); assert.equal(f.calls.length, 0);
  const bad = fixture({ invalidSignature: true }), badPorts = await bad.make();
  await assert.rejects(badPorts.listSourceObjects(), code('BLOCKED_PRODUCTION_OIDC_REQUIRED'));
  assert.equal(bad.blobs.length, 0); assert.equal(bad.calls.length, 0);
});

test('Neon read failures preserve only a valid numeric HTTP status without inspecting private response data', async () => {
  for (const [status, expected] of [
    [401, 'NEON_HTTP_401'], [403, 'NEON_HTTP_403'], [404, 'NEON_HTTP_404'],
    ['401', 'NEON_REQUEST_FAILED'], [401.5, 'NEON_REQUEST_FAILED'], [undefined, 'NEON_REQUEST_FAILED'],
    [0, 'NEON_REQUEST_FAILED'], [600, 'NEON_REQUEST_FAILED'],
  ]) {
    const f = fixture(); let requests = 0;
    const ports = await f.make({ fetch: async () => {
      requests++;
      return { ok: false, status,
        get url() { throw new Error('SYNTHETIC private response URL must not be read'); },
        get headers() { throw new Error('SYNTHETIC private response headers must not be read'); },
        json: async () => { throw new Error('SYNTHETIC private response body must not be read'); },
      };
    } });
    await assert.rejects(ports.snapshotInfo(config.snapshotId), error => error.code === expected && error.message === expected &&
      /^[A-Z][A-Z0-9_]+$/u.test(error.code) && !JSON.stringify({ code: error.code, message: error.message }).includes('SYNTHETIC'));
    assert.equal(requests, 1);
  }
});

test('the exact REST restore flag is hardcoded and target/finalizer inputs are rejected', async () => {
  const f = fixture(), ports = await f.make();
  await assert.rejects(ports.restoreSnapshot({ ...restoreArgs, finalize: true }), code('UNSAFE_RESTORE_REQUEST'));
  await assert.rejects(ports.restoreSnapshot({ ...restoreArgs, target_branch_id: config.sourceBranchId }), code('UNSAFE_RESTORE_REQUEST'));
  assert.equal(f.calls.length, 0);
  const result = await ports.restoreSnapshot(restoreArgs);
  assert.equal(result.finalize, false); assert.equal(result.branch.id, copiedId);
  const writes = f.calls.filter(row => row.method !== 'GET');
  assert.deepEqual(writes.map(row => row.body), [{ name: restoreArgs.name, finalize_restore: false }]);
  assert.equal(f.calls.every(row => row.redirect === 'error'), true);
  assert.equal('finalizeRestore' in ports, false); assert.equal('deleteBranch' in ports, false);
});

test('source/default drift aborts before restore and source endpoints are never cleanup targets', async () => {
  const f = fixture(), ports = await f.make();
  f.production.branch_id = 'br-unexpected-production-binding';
  await assert.rejects(ports.restoreSnapshot(restoreArgs));
  assert.equal(f.calls.some(row => row.method !== 'GET'), false);
  await assert.rejects(ports.disableIsolatedEndpoint({ id: config.productionEndpointId, branchId: config.sourceBranchId }), code('ISOLATED_ENDPOINT_NOT_OWNED'));
  assert.equal(f.calls.some(row => row.method !== 'GET'), false);
});

test('copied compute is created disabled and idle, used, then confirmed disabled again', async () => {
  const f = fixture(), ports = await f.make();
  const restore = await ports.restoreSnapshot(restoreArgs);
  const endpoint = await ports.prepareIsolatedEndpoint(restore.branch, []);
  const create = f.calls.find(row => row.method === 'POST' && row.pathname.endsWith('/endpoints'));
  assert.deepEqual(create.body, { endpoint: { branch_id: copiedId, type: 'read_only', disabled: true, autoscaling_limit_min_cu: 0.25, autoscaling_limit_max_cu: 0.25 } });
  assert.equal(endpoint.disabled, false);
  const cleanup = await ports.disableIsolatedEndpoint(endpoint);
  assert.equal(cleanup.disabled, true); assert.equal(cleanup.currentState, 'idle');
  assert.equal(f.calls.filter(row => row.method === 'PATCH').every(row => row.pathname.endsWith('/' + copiedEndpointId)), true);
});

test('volatile production activity is excluded from the immutable binding guard', async () => {
  const f = fixture(), ports = await f.make();
  await ports.readProductionBinding(); f.production.current_state = 'idle';
  await ports.readProductionBinding();
});

test('source storage exposes only reads and wrong/public store receipts fail closed', async () => {
  const f = fixture(), ports = await f.make();
  assert.equal((await ports.listSourceObjects())[0].storeId, config.sourceStoreId);
  const receipt = await ports.readSourceFile({ pathname });
  assert.equal(receipt.storeId, config.sourceStoreId);
  assert.equal(f.blobs.filter(row => row.storeId === config.sourceStoreId).every(row => ['get', 'list'].includes(row.method)), true);
  const bad = fixture({ publicBlob: true }), badPorts = await bad.make();
  await assert.rejects(badPorts.listSourceObjects(), code('BLOB_OBJECT_STORE_MISMATCH'));
});

test('private target PUT fixes store, backup prefix and no-overwrite options', async () => {
  const f = fixture(), ports = await f.make(), path = `${config.prefix}/sets/backup-synthetic/FULL.json`;
  await ports.writeTarget(path, Buffer.from('abc'), { access: 'private', allowOverwrite: false, addRandomSuffix: false, contentType: 'application/json' });
  assert.deepEqual(f.blobs.find(row => row.method === 'put'), { method: 'put', storeId: config.targetStoreId, path, access: 'private', allowOverwrite: false, addRandomSuffix: false });
  await assert.rejects(ports.writeTarget(pathname, Buffer.from('abc'), { access: 'private', allowOverwrite: false, addRandomSuffix: false, contentType: 'application/pdf' }), code('TARGET_BACKUP_PREFIX_REQUIRED'));
  await assert.rejects(ports.writeTarget(path, Buffer.from('abc'), { access: 'public', allowOverwrite: true, addRandomSuffix: false, contentType: 'application/json' }), code('UNSAFE_BLOB_WRITE_OPTIONS'));
});

test('snapshot claims have a strict permitted append-only target path', async () => {
  const f = fixture(), ports = await f.make(), settings = { access: 'private', allowOverwrite: false, addRandomSuffix: false, contentType: 'application/json' };
  const claim = `${config.prefix}/snapshots/${config.snapshotId}/claim.json`;
  await ports.writeTarget(claim, Buffer.from('abc'), settings);
  assert.equal(f.stored.has(claim), true);
  await assert.rejects(ports.writeTarget(`${config.prefix}/snapshots/arbitrary/claim.json`, Buffer.from('abc'), settings), code('TARGET_BACKUP_PREFIX_REQUIRED'));
  await assert.rejects(ports.writeTarget(`${config.prefix}/snapshots/${config.snapshotId}/other.json`, Buffer.from('abc'), settings), code('TARGET_BACKUP_PREFIX_REQUIRED'));
});

test('post-FULL source guard failure is preserved and only own bound INCOMPLETE evidence bypasses that guard', async () => {
  const f = fixture({ productionDriftAfterFullPut: true }), ports = await f.make();
  const backupId = 'backup-synthetic-failure-evidence', root = `${config.prefix}/sets/${backupId}`;
  const settings = { access: 'private', allowOverwrite: false, addRandomSuffix: false, contentType: 'application/json' };
  const record = { format: 'crm-full-backup-v1', scope: BACKUP_SCOPE, backupId, projectId: config.neonProjectId,
    sourceBranchId: config.sourceBranchId, productionEndpointId: config.productionEndpointId,
    sourceStoreId: config.sourceStoreId, targetStoreId: config.targetStoreId };
  await ports.writeTarget(root + '/RUNNING.json', Buffer.from(JSON.stringify({ ...record, status: 'RUNNING' })), settings);
  await assert.rejects(ports.writeTarget(root + '/FULL.json', Buffer.from(JSON.stringify({ ...record, status: 'FULL' })), settings), code('PRODUCTION_ENDPOINT_BINDING_CHANGED'));
  assert.equal(f.stored.has(root + '/FULL.json'), true, 'the ambiguous completion bytes must be suppressed by failure evidence');
  const readCount = f.calls.length;
  await ports.writeTarget(root + '/INCOMPLETE.json', Buffer.from(JSON.stringify({ ...record, status: 'INCOMPLETE' })), settings);
  await ports.writeTarget(`${config.prefix}/index/${backupId}-INCOMPLETE.json`, Buffer.from(JSON.stringify({ ...record, status: 'INCOMPLETE' })), settings);
  assert.equal(f.calls.length, readCount, 'target failure records never invoke a Neon mutation or source guard');
  assert.equal(f.stored.has(root + '/INCOMPLETE.json'), true);
  await assert.rejects(ports.writeTarget(`${config.prefix}/sets/backup-other-run/INCOMPLETE.json`, Buffer.from(JSON.stringify({ ...record, backupId: 'backup-other-run', status: 'INCOMPLETE' })), settings), code('FAILURE_EVIDENCE_SCOPE_MISMATCH'));
  await assert.rejects(ports.writeTarget(root + '/INCOMPLETE.json', Buffer.from(JSON.stringify({ ...record, status: 'FULL' })), settings), code('FAILURE_EVIDENCE_SCOPE_MISMATCH'));
  const putCount = f.blobs.filter(call => call.method === 'put').length;
  await assert.rejects(ports.writeTarget(root + '/manifest.json', Buffer.from('{}'), settings), code('PRODUCTION_ENDPOINT_BINDING_CHANGED'));
  assert.equal(f.blobs.filter(call => call.method === 'put').length, putCount, 'normal target writes retain the source guard');
  assert.equal(f.calls.every(call => call.method === 'GET'), true);
});

test('source branch cannot be supplied to the SQL capture port', async () => {
  const f = fixture(), ports = await f.make({ createDatabasePool: async () => { throw new Error('SYNTHETIC no SQL connection expected'); } });
  await assert.rejects(ports.captureDatabase({ branch: { id: config.sourceBranchId, name: 'main' }, endpoint: { id: config.productionEndpointId, branchId: config.sourceBranchId } }), code('ISOLATED_BRANCH_NOT_OWNED'));
  assert.equal(f.calls.length, 0);
});

test('a lost restore acknowledgement reconciles its exact new branch without retrying', async () => {
  const f = fixture({ lostRestoreAck: true, restoreWithCompute: true }), ports = await f.make();
  await assert.rejects(ports.restoreSnapshot(restoreArgs), code('BACKUP_PROVIDER_REQUEST_FAILED'));
  assert.equal(f.calls.filter(row => row.method === 'POST' && row.pathname.endsWith('/restore')).length, 1);
  assert.equal(f.copied[0].disabled, true); assert.equal(f.copied[0].current_state, 'idle');
  assert.equal(f.calls.some(row => row.method !== 'GET' && row.pathname.endsWith('/' + config.productionEndpointId)), false);
});

test('connection URI cannot override the isolated host routing or expose provider secrets in errors', async () => {
  const f = fixture({ unsafeUriOptions: true }), ports = await f.make({ createDatabasePool: async () => { throw new Error('SYNTHETIC SQL factory must not run'); } });
  const restore = await ports.restoreSnapshot(restoreArgs);
  const endpoint = await ports.prepareIsolatedEndpoint(restore.branch, []);
  await assert.rejects(ports.captureDatabase({ branch: restore.branch, endpoint }), error => error.code === 'ISOLATED_CONNECTION_URI_INVALID' &&
    error.message === 'ISOLATED_CONNECTION_URI_INVALID' && !error.message.includes('postgres'));
});

test('real adapter ports integrate with the orchestrator claim, private copies and cleanup gates', async () => {
  const f = fixture(), ports = await f.make();
  const inventory = { assets: [{ id: '22222222-2222-4222-8222-222222222222', workspaceId: pathname.split('/')[0], pathname, bytes: 3,
    mimeType: 'application/pdf', storageProvider: 'vercel-blob', storageAccess: 'private', isPublic: false, publicToken: null }],
  references: [], missingReferences: [], legacyPublic: [] };
  // This request-shape test deliberately does not execute SQL. It replaces only
  // fingerprint capture; provider request paths and Blob receipts stay real.
  const result = await runCrmFullBackup({ config, now: () => new Date(clock), backupId: 'backup-synthetic-adapter-proof',
    ports: { ...ports, captureDatabase: async () => ({ identity: { projectId: config.neonProjectId, branchId: copiedId,
      databaseName: config.databaseName, readOnly: true, rlsFilteredTables: 0 }, fingerprint: { sha256: 'a'.repeat(64), tables: [], catalog: {}, sequences: [] }, inventory }) } });
  assert.equal(result.status, 'FULL');
  assert.equal(f.stored.has(`${config.prefix}/snapshots/${config.snapshotId}/claim.json`), true);
  assert.equal(f.stored.has(`${config.prefix}/sets/backup-synthetic-adapter-proof/FULL.json`), true);
  assert.equal(f.copied.every(ep => ep.disabled === true && ep.current_state === 'idle'), true);
  assert.equal(f.blobs.filter(call => call.storeId === config.sourceStoreId).every(call => ['get', 'list'].includes(call.method)), true);
});
