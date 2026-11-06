/** Real provider ports for the isolated CRM backup job. Import/plan does no I/O.
 * Neon REST contract: https://neon.com/api_spec/release/v2.json (2026-11-01).
 * restoreSnapshot: POST /projects/{project_id}/snapshots/{snapshot_id}/restore
 * JSON {name, finalize_restore:false}; target_branch_id MUST be absent.
 * copyPointInTime: POST /projects/{project_id}/branches, pinned parent and time.
 * No finalize, source database connection, source Blob write or delete port.
 */
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { BACKUP_SCOPE, CrmBackupError, captureCrmBackupDatabase, defaultCrmBackupConfig, pitrParentAtOrBefore,
  validateBackupConfig } from './crm-full-backup.mjs';

const API = 'https://console.neon.tech/api/v2';
const requireValue = (condition, code) => { if (!condition) throw new CrmBackupError(code); };
const safeFailure = error => error instanceof CrmBackupError ? error : new CrmBackupError('BACKUP_PROVIDER_REQUEST_FAILED');
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const endpointId = /^ep-[a-z0-9-]{8,100}$/u;
const branchId = /^br-[a-z0-9-]{8,100}$/u;
const snapshotId = /^snap-[a-z0-9-]{5,100}$/u;
const segment = value => encodeURIComponent(value);

function normalizeLsn(value) {
  if (typeof value !== 'string' || !/^[0-9a-f]{1,8}\/[0-9a-f]{1,8}$/iu.test(value)) return null;
  const normalized = value.toUpperCase().split('/').map(part => part.replace(/^0+(?=.)/u, '')).join('/');
  return normalized === '0/0' ? null : normalized;
}

function localOidcClaims(env, config, now) {
  if (env.VERCEL_ENV !== 'production' || typeof env.VERCEL_OIDC_TOKEN !== 'string') return null;
  if (env.VERCEL_PROJECT_ID && env.VERCEL_PROJECT_ID !== config.backupProjectId) return null;
  if (env.VERCEL_TEAM_ID && env.VERCEL_TEAM_ID !== config.teamId) return null;
  try {
    const token = env.VERCEL_OIDC_TOKEN;
    const parts = token.split('.');
    if (parts.length !== 3 || token.length > 20000 || !parts.every(value => /^[A-Za-z0-9_-]+$/u.test(value))) return null;
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    const seconds = Math.floor(now() / 1000);
    if (claims.project_id !== config.backupProjectId || claims.owner_id !== config.teamId || claims.environment !== 'production' ||
      claims.iss !== `https://oidc.vercel.com/${config.teamSlug}` || claims.aud !== `https://vercel.com/${config.teamSlug}` ||
      typeof claims.sub !== 'string' || !claims.sub.startsWith(`owner:${config.teamSlug}:project:`) || !claims.sub.endsWith(':environment:production') ||
      !Number.isSafeInteger(claims.exp) || claims.exp <= seconds + 30 || !Number.isSafeInteger(claims.iat) || claims.iat > seconds ||
      (claims.nbf !== undefined && (!Number.isSafeInteger(claims.nbf) || claims.nbf > seconds))) return null;
    return claims;
  } catch { return null; }
}

function normalizeBranch(value) {
  return { id: value?.id, projectId: value?.project_id, name: value?.name,
    default: value?.default, primary: value?.primary ?? value?.default,
    restoredFrom: value?.restored_from, restoreStatus: value?.restore_status, currentState: value?.current_state };
}
function normalizeEndpoint(value) {
  return { id: value?.id, projectId: value?.project_id, branchId: value?.branch_id, host: value?.host,
    type: value?.type, disabled: value?.disabled, currentState: value?.current_state };
}
function blobHost(storeId) { return `${storeId.slice('store_'.length).toLowerCase()}.private.blob.vercel-storage.com`; }
function assertBlobObject(object, storeId, pathname) {
  requireValue(object && typeof object.pathname === 'string' && (!pathname || object.pathname === pathname), 'BLOB_OBJECT_PATH_MISMATCH');
  let url;
  try { url = new URL(object.url); } catch { throw new CrmBackupError('BLOB_OBJECT_STORE_MISMATCH'); }
  requireValue(url.protocol === 'https:' && url.hostname === blobHost(storeId) && !url.port && !url.username && !url.password && !url.search && !url.hash,
    'BLOB_OBJECT_STORE_MISMATCH');
  requireValue(decodeURIComponent(url.pathname.slice(1)) === object.pathname, 'BLOB_OBJECT_PATH_MISMATCH');
}
function assertPathname(value) {
  requireValue(typeof value === 'string' && value.length > 0 && value.length <= 2048 && !value.startsWith('/') &&
    !/[\u0000-\u001f\\]/u.test(value) && !value.split('/').some(part => part === '.' || part === '..') && !value.includes('://'), 'INVALID_BLOB_PATHNAME');
}

/** Only dependency injection used by local request-shape tests is optional.
 * Readiness checks are local, not a signature/grant attestation. First real
 * operation verifies the OIDC signature and the provider enforces store grants.
 */
export async function createCrmBackupProviderPorts(input, options = {}) {
  const config = validateBackupConfig(input);
  // This adapter is deliberately bound to the authorized source and backup job.
  for (const key of ['neonProjectId', 'sourceBranchId', 'productionEndpointId', 'databaseName', 'sourceStoreId', 'targetStoreId', 'backupProjectId', 'teamId', 'teamSlug']) {
    requireValue(config[key] === defaultCrmBackupConfig[key], 'BACKUP_AUTHORIZED_SCOPE_REQUIRED');
  }
  const env = options.env ?? process.env;
  const request = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const wait = options.wait ?? delay;
  const pollLimit = options.pollLimit ?? 60;
  requireValue(typeof request === 'function' && Number.isSafeInteger(pollLimit) && pollLimit >= 1 && pollLimit <= 120, 'BACKUP_PROVIDER_OPTIONS_INVALID');
  let blob, verifier, verifiedTokenDigest = null, originalProduction = null;
  let pointCopyAttempted = false, pointClaimOwner;
  const owned = new Map(), ownRuns = new Set();
  const sdk = async () => blob ??= options.blob ?? await import('@vercel/blob');
  const oidcVerifier = async () => verifier ??= options.verifyOidc ?? (await import('@vercel/oidc')).verifyVercelOidcToken;
  const credentialsReady = async () => ({
    neonApiKey: typeof env.NEON_API_KEY === 'string' && env.NEON_API_KEY.trim().length > 0,
    productionOidc: localOidcClaims(env, config, now) !== null,
    projectId: config.backupProjectId, teamId: config.teamId, environment: env.VERCEL_ENV,
  });
  const authenticate = async ({ requireNeon = true } = {}) => {
    if (requireNeon) requireValue((await credentialsReady()).neonApiKey, 'BLOCKED_NEON_API_KEY_REQUIRED');
    const claims = localOidcClaims(env, config, now);
    requireValue(claims, 'BLOCKED_PRODUCTION_OIDC_REQUIRED');
    const token = env.VERCEL_OIDC_TOKEN, tokenDigest = digest(token);
    if (verifiedTokenDigest !== tokenDigest) {
      try {
        const verify = await oidcVerifier();
        const result = await verify(token, { projectId: config.backupProjectId, ownerId: config.teamId, environment: 'production',
          issuer: `https://oidc.vercel.com/${config.teamSlug}`, audience: `https://vercel.com/${config.teamSlug}`,
          algorithms: ['RS256'], requiredClaims: ['exp', 'iat', 'sub', 'iss', 'aud'], currentDate: new Date(now()) });
        requireValue(result?.payload?.project_id === config.backupProjectId && result.payload.owner_id === config.teamId && result.payload.environment === 'production', 'BLOCKED_PRODUCTION_OIDC_REQUIRED');
        verifiedTokenDigest = tokenDigest;
      } catch { throw new CrmBackupError('BLOCKED_PRODUCTION_OIDC_REQUIRED'); }
    }
    return token;
  };
  const providerStage = (path, method) => {
    const root = `/projects/${segment(config.neonProjectId)}`;
    if (method === 'GET' && (path === root || path.startsWith(root + '/branches?') ||
      path === root + '/endpoints/' + segment(config.productionEndpointId))) return 'PRODUCTION_BINDING_READ';
    if (method === 'GET' && path === root + '/snapshots') return 'SNAPSHOT_READ';
    if (method === 'POST' && path.startsWith(root + '/snapshots/') && path.endsWith('/restore')) return 'SNAPSHOT_RESTORE';
    if (method === 'POST' && path === root + '/branches') return 'PITR_CHILD_CREATE';
    if (method === 'POST' && path === root + '/endpoints') return 'ISOLATED_ENDPOINT_CREATE';
    if (method === 'PATCH' && path.startsWith(root + '/endpoints/')) return 'ISOLATED_ENDPOINT_UPDATE';
    if (method === 'GET' && path.startsWith(root + '/connection_uri?')) return 'ISOLATED_CONNECTION_READ';
    if (method === 'GET' && path.startsWith(root + '/operations/')) return 'OPERATION_READ';
    if (method === 'GET' && (path.startsWith(root + '/branches/') || path.startsWith(root + '/endpoints/'))) return 'ISOLATED_RESOURCE_READ';
    return 'NEON_REQUEST';
  };
  const neon = async (path, { method = 'GET', body } = {}) => {
    await authenticate();
    requireValue(path.startsWith(`/projects/${segment(config.neonProjectId)}`) && !path.includes('..'), 'NEON_REQUEST_SCOPE_MISMATCH');
    const stage = providerStage(path, method);
    try {
      const response = await request(API + path, { method, redirect: 'error', signal: AbortSignal.timeout(20000),
        headers: { authorization: `Bearer ${env.NEON_API_KEY}`, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}) });
      if (!response.ok) {
        const status = response.status;
        throw new CrmBackupError(Number.isInteger(status) && status >= 100 && status <= 599 ? `NEON_HTTP_${status}` : 'NEON_REQUEST_FAILED',
          { providerStage: stage, providerHttpStatus: status });
      }
      return await response.json();
    } catch (error) { throw error instanceof CrmBackupError ? error : new CrmBackupError('BACKUP_PROVIDER_REQUEST_FAILED', { providerStage: stage }); }
  };
  const projectPath = `/projects/${segment(config.neonProjectId)}`;
  async function listBranches() {
    const rows = [], cursors = new Set(); let cursor;
    for (let page = 0; page < 100; page++) {
      const query = new URLSearchParams({ limit: '100' }); if (cursor) query.set('cursor', cursor);
      const result = await neon(`${projectPath}/branches?${query}`);
      requireValue(Array.isArray(result.branches) && result.branches.every(row => row.project_id === config.neonProjectId), 'NEON_BRANCH_INVENTORY_MISMATCH');
      rows.push(...result.branches);
      const next = result.pagination?.cursor;
      if (!next) return rows;
      requireValue(!cursors.has(next), 'NEON_PAGINATION_REPEATED'); cursors.add(next); cursor = next;
    }
    throw new CrmBackupError('NEON_INVENTORY_LIMIT_EXCEEDED');
  }
  async function readProductionState() {
    const [project, branches, result] = await Promise.all([neon(projectPath), listBranches(), neon(`${projectPath}/endpoints/${segment(config.productionEndpointId)}`)]);
    const defaults = branches.filter(row => row.default === true), source = branches.find(row => row.id === config.sourceBranchId);
    requireValue(project.project?.id === config.neonProjectId && source && defaults.length === 1, 'PRODUCTION_BRANCH_BINDING_CHANGED');
    const receipt = { projectId: config.neonProjectId, sourceBranch: normalizeBranch(source), defaultBranchId: defaults[0].id,
      endpoint: normalizeEndpoint(result.endpoint) };
    requireValue(receipt.sourceBranch.name === 'main' && receipt.sourceBranch.default === true && receipt.sourceBranch.primary === true &&
      receipt.defaultBranchId === config.sourceBranchId && receipt.endpoint.id === config.productionEndpointId &&
      receipt.endpoint.projectId === config.neonProjectId && receipt.endpoint.branchId === config.sourceBranchId && receipt.endpoint.disabled === false &&
      receipt.endpoint.type === 'read_write' && receipt.endpoint.host?.split('.')[0] === config.productionEndpointId,
    'PRODUCTION_ENDPOINT_BINDING_CHANGED');
    const stable = digest({ projectId: receipt.projectId, defaultBranchId: receipt.defaultBranchId,
      sourceBranch: { id: source.id, name: source.name, default: source.default, primary: receipt.sourceBranch.primary },
      endpoint: { id: receipt.endpoint.id, projectId: receipt.endpoint.projectId, branchId: receipt.endpoint.branchId,
        host: receipt.endpoint.host, type: receipt.endpoint.type, disabled: receipt.endpoint.disabled } });
    requireValue(!originalProduction || stable === originalProduction, 'PRODUCTION_BINDING_CHANGED'); originalProduction ??= stable;
    return { receipt, project: project.project, branches, source };
  }
  async function readProductionBinding() {
    return (await readProductionState()).receipt;
  }
  async function readPointInTimeState() {
    const pointInTime = config.pointInTime, requestedAt = Date.parse(pointInTime);
    requireValue(typeof pointInTime === 'string' && Number.isFinite(requestedAt), 'PITR_POINT_REQUIRED');
    const { project, branches, source } = await readProductionState();
    const historyRetentionSeconds = project.history_retention_seconds;
    const checkedAt = now();
    const sourceCreatedAt = Date.parse(source.created_at);
    requireValue(Number.isSafeInteger(historyRetentionSeconds) && historyRetentionSeconds > 0 && historyRetentionSeconds <= 2_147_483_647 &&
      Number.isSafeInteger(checkedAt) && Number.isFinite(sourceCreatedAt) && requestedAt >= sourceCreatedAt &&
      requestedAt < checkedAt && checkedAt - requestedAt <= historyRetentionSeconds * 1000,
    'PITR_POINT_OUTSIDE_VERIFIED_HISTORY');
    const managedChildren = branches.filter(row => typeof row.name === 'string' && row.name.startsWith('crm-backup-') &&
      row.parent_id === config.sourceBranchId && !row.restore_status && !row.restored_from && !row.restored_as);
    requireValue(Number.isInteger(config.pitrBranchLimit) && config.pitrBranchLimit >= 1 && config.pitrBranchLimit <= 35 &&
      managedChildren.length < config.pitrBranchLimit, 'PITR_CHILD_CAPACITY_UNAVAILABLE');
    return { pointInTime, historyRetentionSeconds, branches };
  }
  async function validatePointInTime() {
    const { pointInTime, historyRetentionSeconds } = await readPointInTimeState();
    return { pointInTime, historyRetentionSeconds };
  }
  function validatePointInTimeBranch(raw, id, name) {
    const branch = normalizeBranch(raw), parentLsn = normalizeLsn(raw?.parent_lsn);
    requireValue(branchId.test(id ?? '') && id !== config.sourceBranchId && branch.id === id && branch.projectId === config.neonProjectId &&
      branch.name === name && branch.default === false && branch.primary === false && branch.currentState === 'ready' &&
      raw.parent_id === config.sourceBranchId && pitrParentAtOrBefore(raw.parent_timestamp, config.pointInTime) && parentLsn &&
      raw.archived !== true && !raw.restored_from && !raw.restored_as && !raw.restore_status,
    'ISOLATED_PITR_BRANCH_SCOPE_MISMATCH');
    return { ...branch, parentId: raw.parent_id, parentTimestamp: raw.parent_timestamp, parentLsn };
  }
  async function assertOwned(branch) {
    const saved = owned.get(branch?.id);
    requireValue(saved && branch.id !== config.sourceBranchId && branchId.test(branch.id) && saved.name === branch.name, 'ISOLATED_BRANCH_NOT_OWNED');
    const raw = (await neon(`${projectPath}/branches/${segment(branch.id)}`)).branch;
    if (saved.parentLsn) {
      const live = validatePointInTimeBranch(raw, branch.id, saved.name);
      requireValue(live.parentLsn === saved.parentLsn && live.parentTimestamp === saved.parentTimestamp,
        'ISOLATED_PITR_BRANCH_SCOPE_MISMATCH');
      return live;
    }
    const live = normalizeBranch(raw);
    requireValue(live.projectId === config.neonProjectId && live.id === branch.id && live.name === saved.name && live.default === false && live.primary === false &&
      live.restoreStatus === 'restored' && live.restoredFrom === saved.snapshotId, 'ISOLATED_BRANCH_SCOPE_MISMATCH');
    return live;
  }
  async function liveEndpoint(endpoint) {
    requireValue(endpoint && endpoint.id !== config.productionEndpointId && endpointId.test(endpoint.id) && endpoint.branchId !== config.sourceBranchId && owned.has(endpoint.branchId), 'ISOLATED_ENDPOINT_NOT_OWNED');
    const branch = owned.get(endpoint.branchId); await assertOwned({ id: endpoint.branchId, name: branch.name });
    const live = normalizeEndpoint((await neon(`${projectPath}/endpoints/${segment(endpoint.id)}`)).endpoint);
    requireValue(live.id === endpoint.id && live.branchId === endpoint.branchId && live.projectId === config.neonProjectId &&
      live.host?.split('.')[0] === live.id && /^ep-[a-z0-9-]+\.[a-z0-9.-]+\.neon\.tech$/u.test(live.host), 'ISOLATED_ENDPOINT_SCOPE_MISMATCH');
    return live;
  }
  async function mutation(path, body, method = 'POST') {
    await readProductionBinding();
    try { return await neon(path, { method, body }); }
    finally { await readProductionBinding(); }
  }
  async function waitOperations(operations) {
    requireValue(Array.isArray(operations), 'NEON_OPERATIONS_REQUIRED');
    for (const initial of operations) {
      requireValue(initial.project_id === config.neonProjectId && typeof initial.id === 'string' && /^[a-z0-9-]+$/u.test(initial.id), 'NEON_OPERATION_SCOPE_MISMATCH');
      let operation = initial;
      for (let attempt = 0; attempt < pollLimit; attempt++) {
        requireValue(!['failed', 'error', 'cancelled', 'cancelling'].includes(operation.status), 'NEON_OPERATION_FAILED');
        if (['finished', 'skipped'].includes(operation.status)) break;
        requireValue(attempt + 1 < pollLimit, 'NEON_OPERATION_TIMEOUT');
        await wait(1000);
        operation = (await neon(`${projectPath}/operations/${segment(initial.id)}`)).operation;
        requireValue(operation?.id === initial.id && operation.project_id === config.neonProjectId, 'NEON_OPERATION_SCOPE_MISMATCH');
      }
    }
  }
  async function getIsolatedEndpoints(branch) {
    await assertOwned(branch);
    const result = await neon(`${projectPath}/branches/${segment(branch.id)}/endpoints`);
    requireValue(Array.isArray(result.endpoints), 'ISOLATED_ENDPOINT_INVENTORY_REQUIRED');
    const endpoints = result.endpoints.map(normalizeEndpoint);
    requireValue(endpoints.every(ep => ep.projectId === config.neonProjectId && ep.branchId === branch.id && ep.id !== config.productionEndpointId && endpointId.test(ep.id)), 'ISOLATED_ENDPOINT_SCOPE_MISMATCH');
    return endpoints;
  }
  async function setEndpointDisabled(endpoint, disabled, resize = false) {
    const live = await liveEndpoint(endpoint);
    const result = await mutation(`${projectPath}/endpoints/${segment(live.id)}`, { endpoint: { disabled, ...(resize ? { autoscaling_limit_min_cu: 0.25, autoscaling_limit_max_cu: 0.25 } : {}) } }, 'PATCH');
    await waitOperations(result.operations);
    for (let attempt = 0; attempt < pollLimit; attempt++) {
      const observed = await liveEndpoint(live);
      if (observed.disabled === disabled && (!disabled || observed.currentState === 'idle')) return observed;
      requireValue(attempt + 1 < pollLimit, 'ISOLATED_COMPUTE_STATE_UNCONFIRMED'); await wait(1000);
    }
  }
  async function waitForRestore(result) {
    await waitOperations(result.operations);
    const branch = await assertOwned(result.branch);
    await readProductionBinding();
    return { ...result, branch };
  }
  async function reconcileRestoreFailure(name, requestedSnapshotId, beforeIds) {
    // Never retry a timed-out POST. Reconcile only a uniquely named branch that
    // did not exist before this request, then disable its own endpoints.
    const found = (await listBranches()).filter(row => row.name === name && !beforeIds.has(row.id));
    requireValue(found.length <= 1, 'RESTORE_ACKNOWLEDGEMENT_UNCONFIRMED');
    if (!found.length) return;
    const branch = normalizeBranch(found[0]);
    requireValue(branch.id !== config.sourceBranchId && branch.projectId === config.neonProjectId && branch.default === false && branch.primary === false &&
      branch.restoredFrom === requestedSnapshotId && branch.restoreStatus === 'restored', 'RESTORE_ACKNOWLEDGEMENT_UNCONFIRMED');
    owned.set(branch.id, { name, snapshotId: requestedSnapshotId });
    for (const endpoint of await getIsolatedEndpoints(branch)) await setEndpointDisabled(endpoint, true);
  }
  async function restoreSnapshot(args) {
    requireValue(!config.pointInTime && args && Object.keys(args).every(key => ['snapshotId', 'name', 'finalize'].includes(key)) && args.finalize === false &&
      snapshotId.test(args.snapshotId) && /^crm-backup-[a-z0-9-]{6,110}$/u.test(args.name), 'UNSAFE_RESTORE_REQUEST');
    const snapshots = await neon(`${projectPath}/snapshots`);
    requireValue(snapshots.snapshots?.some(row => row.id === args.snapshotId && row.source_branch_id === config.sourceBranchId), 'SNAPSHOT_SOURCE_BINDING_MISMATCH');
    const before = await listBranches(); requireValue(!before.some(row => row.name === args.name), 'ISOLATED_BRANCH_NAME_ALREADY_EXISTS');
    try {
      // Exact official REST flag, hardcoded false; no target_branch_id field.
      const raw = await mutation(`${projectPath}/snapshots/${segment(args.snapshotId)}/restore`, { name: args.name, finalize_restore: false });
      const branch = normalizeBranch(raw.branch);
      requireValue(branch.id !== config.sourceBranchId && branchId.test(branch.id) && !before.some(row => row.id === branch.id) && branch.projectId === config.neonProjectId &&
        branch.name === args.name && branch.default === false && branch.primary === false && branch.restoreStatus === 'restored' && branch.restoredFrom === args.snapshotId,
      'UNSAFE_OR_FINALIZED_RESTORE');
      owned.set(branch.id, { name: args.name, snapshotId: args.snapshotId });
      const result = { finalize: false, branch, operations: raw.operations, endpoints: [] };
      // The restore response may include project endpoints; branch-scoped
      // discovery is authoritative and prevents cleanup of a source endpoint.
      return await waitForRestore(result);
    } catch (error) {
      try { await reconcileRestoreFailure(args.name, args.snapshotId, new Set(before.map(row => row.id))); }
      catch { throw new CrmBackupError('RESTORE_CLEANUP_UNCONFIRMED'); }
      throw safeFailure(error);
    }
  }
  async function copyPointInTime(args) {
    requireValue(config.pointInTime && args && Object.keys(args).length === 1 && Object.hasOwn(args, 'name') && typeof args.name === 'string' &&
      /^crm-backup-[a-z0-9-]{6,110}$/u.test(args.name), 'UNSAFE_PITR_COPY_REQUEST');
    requireValue(!pointCopyAttempted, 'PITR_COPY_ALREADY_ATTEMPTED');
    requireValue(pointClaimOwner && args.name === `crm-backup-${pointClaimOwner}`, 'PITR_COPY_CLAIM_REQUIRED');
    const { name } = args, { branches } = await readPointInTimeState();
    requireValue(!branches.some(row => row.name === name), 'ISOLATED_BRANCH_NAME_ALREADY_EXISTS');
    const beforeIds = new Set(branches.map(row => row.id));
    requireValue(!pointCopyAttempted, 'PITR_COPY_ALREADY_ATTEMPTED');
    pointCopyAttempted = true;
    let createdBranchId, createdParentLsn, observedParentTimestamp;
    try {
      let result;
      try {
        result = await neon(`${projectPath}/branches`, { method: 'POST', body: { branch: {
          name, parent_id: config.sourceBranchId, parent_timestamp: config.pointInTime, init_source: 'parent-data',
        } } });
        const created = normalizeBranch(result?.branch);
        requireValue(branchId.test(created.id ?? '') && created.id !== config.sourceBranchId && !beforeIds.has(created.id) &&
          created.name === name && created.projectId === config.neonProjectId && created.default === false && created.primary === false &&
          result.branch.parent_id === config.sourceBranchId && (result.branch.parent_timestamp == null ||
            pitrParentAtOrBefore(result.branch.parent_timestamp, config.pointInTime)) &&
          !result.branch.restored_from && !result.branch.restored_as && !result.branch.restore_status,
        'ISOLATED_PITR_BRANCH_SCOPE_MISMATCH');
        createdParentLsn = normalizeLsn(result.branch.parent_lsn);
        requireValue(createdParentLsn, 'ISOLATED_PITR_BRANCH_SCOPE_MISMATCH');
        createdBranchId = created.id;
      } finally { await readProductionBinding(); }
      await waitOperations(result.operations);
      const branch = validatePointInTimeBranch((await neon(`${projectPath}/branches/${segment(createdBranchId)}`)).branch, createdBranchId, name);
      requireValue(branch.parentLsn === createdParentLsn, 'ISOLATED_PITR_BRANCH_SCOPE_MISMATCH');
      observedParentTimestamp = branch.parentTimestamp;
      await readProductionBinding();
      owned.set(createdBranchId, { name, parentLsn: branch.parentLsn, parentTimestamp: branch.parentTimestamp });
      return { finalize: false, branch, operations: result.operations, endpoints: [] };
    } catch (error) {
      // An unacknowledged child create may have happened, but a name match or
      // an earlier timestamp alone cannot establish ownership for a mutation.
      if (!createdBranchId) throw safeFailure(error);
      try {
        await readProductionBinding();
        const branch = validatePointInTimeBranch((await neon(`${projectPath}/branches/${segment(createdBranchId)}`)).branch, createdBranchId, name);
        requireValue(branch.parentLsn === createdParentLsn && (!observedParentTimestamp || branch.parentTimestamp === observedParentTimestamp),
          'PITR_COPY_CLEANUP_UNCONFIRMED');
        owned.set(createdBranchId, { name, parentLsn: branch.parentLsn, parentTimestamp: branch.parentTimestamp });
        try {
          for (const endpoint of await getIsolatedEndpoints(branch)) await setEndpointDisabled(endpoint, true);
        } finally { owned.delete(createdBranchId); }
      } catch { throw new CrmBackupError('PITR_COPY_CLEANUP_UNCONFIRMED'); }
      throw safeFailure(error);
    }
  }
  async function prepareIsolatedEndpoint(branch, endpoints) {
    await assertOwned(branch);
    const actual = await getIsolatedEndpoints(branch);
    requireValue(Array.isArray(endpoints) && endpoints.length === actual.length && endpoints.every(ep => actual.some(row => row.id === ep.id)), 'ISOLATED_ENDPOINT_INVENTORY_CHANGED');
    let selected = actual.find(ep => ep.type === 'read_write') ?? actual[0];
    if (!selected) {
      const result = await mutation(`${projectPath}/endpoints`, { endpoint: { branch_id: branch.id, type: 'read_only', disabled: true,
        autoscaling_limit_min_cu: 0.25, autoscaling_limit_max_cu: 0.25 } });
      selected = normalizeEndpoint(result.endpoint);
      requireValue(selected.branchId === branch.id && selected.id !== config.productionEndpointId && selected.projectId === config.neonProjectId, 'ISOLATED_ENDPOINT_SCOPE_MISMATCH');
      await waitOperations(result.operations);
    }
    // Every owned endpoint is observed disabled+idle before SQL access begins.
    for (const endpoint of await getIsolatedEndpoints(branch)) await setEndpointDisabled(endpoint, true, true);
    return setEndpointDisabled(selected, false);
  }
  async function captureDatabase({ branch, endpoint }) {
    await assertOwned(branch); const live = await liveEndpoint(endpoint); await readProductionBinding();
    requireValue(live.disabled === false && live.branchId === branch.id, 'ISOLATED_ENDPOINT_SCOPE_MISMATCH');
    const query = new URLSearchParams({ branch_id: branch.id, endpoint_id: live.id, database_name: config.databaseName, role_name: 'neondb_owner', pooled: 'false' });
    const response = await neon(`${projectPath}/connection_uri?${query}`);
    let uri;
    try { uri = new URL(response.uri); } catch { throw new CrmBackupError('ISOLATED_CONNECTION_URI_INVALID'); }
    requireValue(['postgres:', 'postgresql:'].includes(uri.protocol) && uri.hostname === live.host && uri.hostname.split('.')[0] !== config.productionEndpointId &&
      uri.pathname === '/' + config.databaseName && decodeURIComponent(uri.username) === 'neondb_owner' && uri.password && !uri.port && !uri.hash &&
      [...uri.searchParams.keys()].every(key => ['sslmode', 'channel_binding'].includes(key)) &&
      ['require', 'verify-full'].includes(uri.searchParams.get('sslmode')) &&
      (!uri.searchParams.has('channel_binding') || uri.searchParams.get('channel_binding') === 'require'),
    'ISOLATED_CONNECTION_URI_INVALID');
    let pool, client;
    try {
      const factory = options.createDatabasePool ?? (async connectionString => {
        const { Pool, neonConfig } = await import('@neondatabase/serverless');
        neonConfig.webSocketConstructor = globalThis.WebSocket;
        return new Pool({ connectionString, max: 1, connectionTimeoutMillis: 20000 });
      });
      pool = await factory(uri.toString()); client = await pool.connect();
      return await captureCrmBackupDatabase(client, { config, branch });
    } catch (error) { throw safeFailure(error); }
    finally { await client?.release(); await pool?.end().catch(() => {}); }
  }
  const blobOptions = async (storeId, policy) => ({ storeId, oidcToken: await authenticate(policy) });
  async function listObjects(storeId, prefix) {
    try {
      await authenticate();
      const api = await sdk(), objects = [], cursors = new Set(); let cursor;
      for (let page = 0; page < 1000; page++) {
        const result = await api.list({ ...await blobOptions(storeId), limit: 1000, ...(prefix ? { prefix } : {}), ...(cursor ? { cursor } : {}) });
        requireValue(Array.isArray(result.blobs), 'SOURCE_STORE_INVENTORY_MISMATCH');
        for (const object of result.blobs) { assertBlobObject(object, storeId); objects.push({ storeId, pathname: object.pathname, size: object.size, access: 'private' }); }
        if (!result.hasMore) return objects;
        requireValue(typeof result.cursor === 'string' && !cursors.has(result.cursor), 'BLOB_PAGINATION_REPEATED'); cursors.add(result.cursor); cursor = result.cursor;
      }
      throw new CrmBackupError('BLOB_INVENTORY_LIMIT_EXCEEDED');
    } catch (error) { throw safeFailure(error); }
  }
  async function readBlob(storeId, pathname) {
    assertPathname(pathname);
    try {
      const auth = await blobOptions(storeId);
      const result = await (await sdk()).get(pathname, { ...auth, access: 'private', useCache: false });
      if (result === null) return null;
      requireValue(result.statusCode === 200 && result.stream, 'PRIVATE_BLOB_READ_UNCONFIRMED');
      assertBlobObject(result.blob, storeId, pathname);
      return { storeId, pathname, access: 'private', body: result.stream };
    } catch (error) { throw safeFailure(error); }
  }
  async function writeTarget(pathname, bytes, settings) {
    assertPathname(pathname);
    const claim = !config.pointInTime && pathname.startsWith(config.prefix + '/snapshots/') ? pathname.slice((config.prefix + '/snapshots/').length).split('/') : [];
    const snapshotClaim = claim.length === 2 && snapshotId.test(claim[0]) && claim[1] === 'claim.json';
    const pointClaim = config.pointInTime && pathname === `${config.prefix}/pitr/${config.pointInTime.replace(/\D/gu, '')}/claim.json`;
    requireValue(pathname.startsWith(config.prefix + '/sets/') || pathname.startsWith(config.prefix + '/index/') ||
      snapshotClaim || pointClaim, 'TARGET_BACKUP_PREFIX_REQUIRED');
    requireValue(settings?.access === 'private' && settings.allowOverwrite === false && settings.addRandomSuffix === false &&
      Buffer.isBuffer(bytes) && typeof settings.contentType === 'string' && settings.contentType.length <= 200, 'UNSAFE_BLOB_WRITE_OPTIONS');
    let record;
    if (settings.contentType === 'application/json' && bytes.length <= 10 * 1024 * 1024) {
      try { record = JSON.parse(bytes.toString('utf8')); } catch { /* Normal opaque archive bytes are not evidence records. */ }
    }
    if (pointClaim) requireValue(!pointClaimOwner && record?.pointInTime === config.pointInTime && record.sourceBranchId === config.sourceBranchId &&
      record.sourceStoreId === config.sourceStoreId && record.targetStoreId === config.targetStoreId &&
      /^[a-z0-9][a-z0-9-]{5,100}$/u.test(record.backupId ?? ''), 'PITR_CLAIM_SCOPE_MISMATCH');
    const boundRecord = value => value?.format === 'crm-full-backup-v1' && value.scope === BACKUP_SCOPE &&
      value.projectId === config.neonProjectId && value.sourceBranchId === config.sourceBranchId &&
      value.productionEndpointId === config.productionEndpointId && value.sourceStoreId === config.sourceStoreId && value.targetStoreId === config.targetStoreId;
    const setParts = pathname.startsWith(config.prefix + '/sets/') ? pathname.slice((config.prefix + '/sets/').length).split('/') : [];
    const indexFailure = pathname.startsWith(config.prefix + '/index/') ? pathname.slice((config.prefix + '/index/').length).match(/^([a-z0-9][a-z0-9-]{5,100})-INCOMPLETE\.json$/u) : null;
    const failureRun = setParts.length === 2 && /^[a-z0-9][a-z0-9-]{5,100}$/u.test(setParts[0]) && setParts[1] === 'INCOMPLETE.json'
      ? setParts[0] : indexFailure?.[1];
    if (failureRun) requireValue(ownRuns.has(failureRun) && boundRecord(record) && record.status === 'INCOMPLETE' && record.backupId === failureRun, 'FAILURE_EVIDENCE_SCOPE_MISMATCH');
    try {
      if (pointClaim) await readPointInTimeState();
      else if (!failureRun) await readProductionBinding();
      // A previously claimed run may append only its bound failure record after
      // source drift. This target-only suppressor never grants a Neon mutation
      // or exempts a FULL marker; the current signed Production OIDC is required.
      const result = await (await sdk()).put(pathname, bytes, { ...await blobOptions(config.targetStoreId, { requireNeon: !failureRun }), access: 'private', allowOverwrite: false,
        addRandomSuffix: false, contentType: settings.contentType });
      assertBlobObject(result, config.targetStoreId, pathname);
      if ((snapshotClaim && record?.snapshotId === claim[0] &&
        record.sourceBranchId === config.sourceBranchId && record.sourceStoreId === config.sourceStoreId && record.targetStoreId === config.targetStoreId &&
        /^[a-z0-9][a-z0-9-]{5,100}$/u.test(record.backupId ?? '')) ||
        (!config.pointInTime && setParts.length === 2 && setParts[1] === 'RUNNING.json' && boundRecord(record) && record.status === 'RUNNING' && record.backupId === setParts[0])) ownRuns.add(record.backupId);
      if (!failureRun) await readProductionBinding();
      if (pointClaim) {
        pointClaimOwner = record.backupId;
        ownRuns.add(record.backupId);
      }
      return { storeId: config.targetStoreId, pathname, access: 'private' };
    } catch (error) { throw safeFailure(error); }
  }
  return Object.freeze({ credentialsReady, readProductionBinding, restoreSnapshot, validatePointInTime, copyPointInTime,
    waitForRestore, getIsolatedEndpoints, prepareIsolatedEndpoint, captureDatabase,
    snapshotInfo: async requested => {
      const result = await neon(`${projectPath}/snapshots`);
      requireValue(Array.isArray(result.snapshots), 'SNAPSHOT_INVENTORY_INVALID');
      const selected = result.snapshots.filter(row => row.source_branch_id === config.sourceBranchId && (!requested || row.id === requested))
        .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0];
      requireValue(selected && snapshotId.test(selected.id) && Number.isFinite(Date.parse(selected.created_at)), 'SOURCE_SNAPSHOT_REQUIRED');
      return { id: selected.id, sourceBranchId: selected.source_branch_id, createdAt: selected.created_at };
    },
    listSourceObjects: () => listObjects(config.sourceStoreId),
    listTargetRecords: prefix => { requireValue(typeof prefix === 'string' && prefix.startsWith(config.prefix + '/'), 'TARGET_BACKUP_PREFIX_REQUIRED'); return listObjects(config.targetStoreId, prefix); },
    readSourceFile: file => readBlob(config.sourceStoreId, file.pathname), readTarget: pathname => readBlob(config.targetStoreId, pathname),
    writeTarget, disableIsolatedEndpoint: endpoint => setEndpointDisabled(endpoint, true),
  });
}
