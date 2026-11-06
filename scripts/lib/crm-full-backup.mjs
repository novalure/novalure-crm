/** Production backup orchestration. Importing this module performs no I/O.
 * Recovery is ALWAYS a new, unfinalized branch. The source database is never
 * connected to, and source Blob ports expose no write/delete operation.
 */
import { createHash, randomUUID } from 'node:crypto';
import { posix as path } from 'node:path';
import { canonical, catalogQueries, captureDatabaseMetadata } from './studio-stage3-qa-fingerprint.mjs';

export const BACKUP_SCOPE = 'FULL_DATABASE_AND_DATABASE_REFERENCED_PRIVATE_FILES';
export const backupProviderStages = Object.freeze(['PRODUCTION_BINDING_READ', 'SNAPSHOT_READ', 'SNAPSHOT_RESTORE',
  'ISOLATED_RESOURCE_READ', 'ISOLATED_ENDPOINT_CREATE', 'ISOLATED_ENDPOINT_UPDATE', 'ISOLATED_CONNECTION_READ',
  'OPERATION_READ', 'NEON_REQUEST']);
/** Fixed operation categories and numeric status only, never path/body/error text. */
export function backupProviderDiagnostics(error) {
  if (!backupProviderStages.includes(error?.providerStage)) return {};
  return { providerStage: error.providerStage, ...(Number.isInteger(error.providerHttpStatus) &&
    error.providerHttpStatus >= 100 && error.providerHttpStatus <= 599 ? { providerHttpStatus: error.providerHttpStatus } : {}) };
}
export const defaultCrmBackupConfig = Object.freeze({
  neonProjectId: 'misty-cloud-70835427', sourceBranchId: 'br-spring-night-alyu48yp',
  productionEndpointId: 'ep-wandering-union-alem0781', databaseName: 'neondb',
  sourceStoreId: 'store_vCn7LiyRocYNC8pM', targetStoreId: 'store_Xq45pbZfYunmR6ah',
  backupProjectId: 'prj_bmEuDFXrLvSX2VXtt2GQ9Mbrfrlk', teamId: 'team_sjD78IkSicXJK6TAOR1JC7Wv',
  teamSlug: 'novalure', prefix: 'crm-full-backups', retentionDays: 7, maxFileBytes: 20 * 1024 * 1024,
});
export class CrmBackupError extends Error {
  constructor(code, diagnostics = {}) {
    super(code); this.name = 'CrmBackupError'; this.code = code;
    Object.assign(this, backupProviderDiagnostics(diagnostics));
  }
}
const requireValue = (condition, code) => { if (!condition) throw new CrmBackupError(code); };
export const sha256 = value => createHash('sha256').update(value).digest('hex');
const digest = value => sha256(canonical(value));
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const quoteIdentifier = value => '"' + value.replaceAll('"', '""') + '"';
const quoteLiteral = value => "'" + value.replaceAll("'", "''") + "'";
const errorCode = error => error instanceof CrmBackupError ? error.code : 'BACKUP_PROVIDER_OR_IO_FAILED';

export function validateBackupConfig(value) {
  requireValue(value && typeof value === 'object' && !Array.isArray(value), 'BACKUP_CONFIG_REQUIRED');
  const allowed = new Set([...Object.keys(defaultCrmBackupConfig), 'snapshotId']);
  requireValue(Object.keys(value).every(key => allowed.has(key)), 'UNKNOWN_BACKUP_CONFIG_FIELD');
  const config = { ...defaultCrmBackupConfig, ...value };
  for (const [key, pattern] of Object.entries({ neonProjectId: /^[a-z0-9-]{8,100}$/, sourceBranchId: /^br-[a-z0-9-]{8,100}$/,
    productionEndpointId: /^ep-[a-z0-9-]{8,100}$/, databaseName: /^[a-z_][a-z0-9_]{0,62}$/, sourceStoreId: /^store_[a-zA-Z0-9]+$/,
    targetStoreId: /^store_[a-zA-Z0-9]+$/, backupProjectId: /^prj_[a-zA-Z0-9]+$/, teamId: /^team_[a-zA-Z0-9]+$/, teamSlug: /^[a-z0-9-]+$/ })) {
    requireValue(typeof config[key] === 'string' && pattern.test(config[key]), 'INVALID_BACKUP_' + key.toUpperCase());
  }
  requireValue(config.sourceStoreId !== config.targetStoreId, 'SOURCE_TARGET_STORE_COLLISION');
  requireValue(typeof config.prefix === 'string' && /^[a-z0-9][a-z0-9/_-]{2,120}$/.test(config.prefix) && !config.prefix.includes('..') && !config.prefix.endsWith('/'), 'INVALID_BACKUP_PREFIX');
  requireValue(Number.isSafeInteger(config.retentionDays) && config.retentionDays >= 1 && config.retentionDays <= 35, 'INVALID_BACKUP_RETENTION');
  requireValue(Number.isSafeInteger(config.maxFileBytes) && config.maxFileBytes >= 1 && config.maxFileBytes <= 100 * 1024 * 1024, 'INVALID_BACKUP_FILE_BUDGET');
  if (config.snapshotId !== undefined) requireValue(/^snap-[a-z0-9-]{5,100}$/.test(config.snapshotId), 'INVALID_BACKUP_SNAPSHOT');
  return Object.freeze(config);
}

/** Every historical reference is retained. Generic private CRM images do not
 * need a Knowledge version. Legacy-public assets are explicitly outside scope. */
export function validatePrivateManifest(inventory) {
  requireValue(inventory && Array.isArray(inventory.assets) && Array.isArray(inventory.references) && Array.isArray(inventory.missingReferences) && Array.isArray(inventory.legacyPublic), 'INVALID_PRIVATE_MANIFEST');
  requireValue(inventory.missingReferences.length === 0, 'MISSING_HISTORICAL_ASSET_REFERENCE');
  const byId = new Map(), byKey = new Map(), legacy = new Set();
  for (const original of inventory.assets) {
    const asset = { ...original };
    requireValue(uuid.test(asset.id) && uuid.test(asset.workspaceId) && !byId.has(asset.id), 'INVALID_OR_DUPLICATE_PRIVATE_ASSET');
    requireValue(asset.storageProvider === 'vercel-blob' && asset.storageAccess === 'private' && asset.isPublic === false && asset.publicToken === null, 'PRIVATE_ASSET_PRIVACY_MISMATCH');
    requireValue(typeof asset.pathname === 'string' && asset.pathname.length <= 2048 && asset.pathname === path.normalize(asset.pathname) && asset.pathname.startsWith(asset.workspaceId + '/') && !/[\u0000-\u001f\\]/u.test(asset.pathname), 'INVALID_TENANT_OBJECT_KEY');
    requireValue(Number.isSafeInteger(asset.bytes) && asset.bytes > 0 && typeof asset.mimeType === 'string' && asset.mimeType.length <= 200, 'INVALID_PRIVATE_ASSET_SIZE');
    const existing = byKey.get(asset.pathname);
    requireValue(!existing || (existing.workspaceId === asset.workspaceId && existing.bytes === asset.bytes), 'CONFLICTING_PRIVATE_OBJECT_BINDING');
    byId.set(asset.id, asset); byKey.set(asset.pathname, asset);
  }
  for (const asset of inventory.legacyPublic) {
    requireValue(uuid.test(asset.id) && uuid.test(asset.workspaceId) && !byId.has(asset.id) && !legacy.has(asset.id), 'INVALID_LEGACY_ASSET');
    legacy.add(asset.id);
  }
  const versions = new Set();
  for (const ref of inventory.references) {
    requireValue(uuid.test(ref.versionId) && uuid.test(ref.sourceId) && uuid.test(ref.workspaceId) && uuid.test(ref.assetId) && !versions.has(ref.versionId), 'INVALID_HISTORICAL_REFERENCE');
    versions.add(ref.versionId);
    const asset = byId.get(ref.assetId) ?? inventory.legacyPublic.find(candidate => candidate.id === ref.assetId);
    requireValue(asset && asset.workspaceId === ref.workspaceId, 'MISSING_HISTORICAL_ASSET_REFERENCE');
    if (ref.sha256 != null) {
      requireValue(/^[a-f0-9]{64}$/.test(ref.sha256) && (!asset.expectedSha256 || asset.expectedSha256 === ref.sha256), 'HISTORICAL_FILE_HASH_CONFLICT');
      if (byId.has(ref.assetId)) asset.expectedSha256 = ref.sha256;
    }
  }
  return { assets: [...byId.values()].sort((a, b) => a.id.localeCompare(b.id)),
    references: [...inventory.references].sort((a, b) => a.versionId.localeCompare(b.versionId)), missingReferences: [],
    legacyPublic: inventory.legacyPublic, versionBindingsSha256: digest([...inventory.references].sort((a, b) => a.versionId.localeCompare(b.versionId))) };
}

function productionReceipt(value, config) {
  requireValue(value?.projectId === config.neonProjectId && value.sourceBranch?.id === config.sourceBranchId && value.sourceBranch.name === 'main' && value.sourceBranch.default === true && value.sourceBranch.primary === true && value.defaultBranchId === config.sourceBranchId, 'PRODUCTION_BRANCH_BINDING_CHANGED');
  const ep = value.endpoint;
  requireValue(ep?.id === config.productionEndpointId && ep.projectId === config.neonProjectId && ep.branchId === config.sourceBranchId && ep.type === 'read_write' && ep.disabled === false && /^ep-[a-z0-9-]+\.[a-z0-9.-]+\.neon\.tech$/.test(ep.host ?? ''), 'PRODUCTION_ENDPOINT_BINDING_CHANGED');
  // Activity/updated_at naturally change under ordinary production traffic.
  return { projectId: value.projectId, sourceBranch: { id: value.sourceBranch.id, name: value.sourceBranch.name, default: true, primary: true },
    defaultBranchId: value.defaultBranchId, endpoint: { id: ep.id, projectId: ep.projectId, branchId: ep.branchId, host: ep.host, type: ep.type, disabled: false } };
}
function validateCopy(value, config, snapshot, name) {
  const branch = value?.branch;
  requireValue(value?.finalize === false && branch?.id !== config.sourceBranchId && /^br-[a-z0-9-]{8,100}$/.test(branch?.id ?? '') && branch.projectId === config.neonProjectId && branch.name === name && branch.default === false && branch.primary === false && branch.restoredFrom === snapshot.id && branch.restoreStatus === 'restored', 'UNSAFE_OR_FINALIZED_RESTORE');
  return branch;
}
function validateEndpoint(ep, branch, config) {
  requireValue(ep?.projectId === config.neonProjectId && ep.branchId === branch.id && ep.id !== config.productionEndpointId && /^ep-[a-z0-9-]{8,100}$/.test(ep?.id ?? ''), 'ISOLATED_ENDPOINT_SCOPE_MISMATCH');
  return ep;
}
async function exactBytes(receipt, { storeId, pathname, bytes, maxBytes }) {
  requireValue(receipt?.storeId === storeId && receipt.pathname === pathname && receipt.access === 'private' && receipt.body != null, 'PRIVATE_FILE_SCOPE_MISMATCH');
  let length = 0; const chunks = [];
  const body = receipt.body;
  if (Buffer.isBuffer(body) || body instanceof Uint8Array) { length = body.byteLength; chunks.push(Buffer.from(body)); }
  else {
    requireValue(typeof body[Symbol.asyncIterator] === 'function', 'PRIVATE_FILE_STREAM_REQUIRED');
    for await (const chunk of body) {
      length += chunk.byteLength;
      if (length > maxBytes || (bytes !== undefined && length > bytes)) { await body.cancel?.().catch(() => {}); throw new CrmBackupError('PRIVATE_FILE_SIZE_MISMATCH'); }
      chunks.push(Buffer.from(chunk));
    }
  }
  requireValue(length <= maxBytes && (bytes === undefined || length === bytes), 'PRIVATE_FILE_SIZE_MISMATCH');
  return Buffer.concat(chunks, length);
}

/** Pure retention proposal. This module has NO delete-storage/branch port. */
export function planBackupRetention(index, { now = new Date(), keepDays = 7, sourceStoreId, targetStoreId, prefix = 'crm-full-backups' }) {
  requireValue(Array.isArray(index) && sourceStoreId !== targetStoreId && /^store_/.test(sourceStoreId ?? '') && /^store_/.test(targetStoreId ?? '') && Number.isInteger(keepDays) && keepDays >= 1 && keepDays <= 35, 'INVALID_RETENTION_PLAN');
  const at = new Date(now).getTime(); requireValue(Number.isFinite(at), 'INVALID_RETENTION_TIME');
  const eligible = index.filter(row => row?.status === 'FULL' && row.scope === BACKUP_SCOPE && row.sourceStoreId === sourceStoreId && row.targetStoreId === targetStoreId && typeof row.manifestPath === 'string' && row.manifestPath === `${prefix}/sets/${row.backupId}/manifest.json` && /^[a-z0-9][a-z0-9-]{5,100}$/.test(row.backupId ?? '') && Number.isFinite(Date.parse(row.completedAt)) && /^[a-f0-9]{64}$/.test(row.manifestSha256 ?? ''));
  const latest = [...eligible].sort((a, b) => Date.parse(b.completedAt) - Date.parse(a.completedAt))[0];
  return { mode: 'PLAN_ONLY_NO_DELETIONS', protectedLatestFull: latest?.backupId ?? null,
    candidates: eligible.filter(row => row.backupId !== latest?.backupId && Date.parse(row.completedAt) < at - keepDays * 86400000).map(row => ({ backupId: row.backupId, targetStoreId, manifestPath: row.manifestPath, requiresFreshManifestAndReferenceRecheck: true })),
    ignored: index.length - eligible.length, externalReusedObjectsNeverDeleted: true };
}


/** A candidate index row is not proof. Verify the private final marker and its
 * canonical manifest before yielding either marker or snapshot metadata. */
async function* readVerifiedBackupSets({ config: input, ports }, { confirmNoIncomplete = false } = {}) {
  const config = validateBackupConfig(input);
  requireValue(typeof ports?.listTargetRecords === 'function' && typeof ports.readTarget === 'function', 'BACKUP_INDEX_READ_PORTS_REQUIRED');
  const entries = await ports.listTargetRecords(config.prefix + '/index/');
  requireValue(Array.isArray(entries), 'INVALID_BACKUP_INDEX_INVENTORY');
  const readJson = async pathname => {
    const receipt = await ports.readTarget(pathname);
    if (!receipt) return null;
    const bytes = await exactBytes(receipt, { storeId: config.targetStoreId, pathname, maxBytes: 10 * 1024 * 1024 });
    try { return { value: JSON.parse(bytes.toString('utf8')), bytes }; }
    catch { throw new CrmBackupError('INVALID_BACKUP_INDEX_JSON'); }
  };
  for (const entry of entries) {
    requireValue(entry.storeId === config.targetStoreId && entry.access === 'private' && entry.pathname.startsWith(config.prefix + '/index/'), 'BACKUP_INDEX_TARGET_MISMATCH');
    if (!entry.pathname.endsWith('-FULL.json')) continue;
    const candidate = (await readJson(entry.pathname))?.value;
    requireValue(candidate && /^[a-z0-9][a-z0-9-]{5,100}$/.test(candidate.backupId ?? ''), 'INVALID_BACKUP_INDEX_RECORD');
    const root = `${config.prefix}/sets/${candidate.backupId}`;
    const incompletePath = root + '/INCOMPLETE.json';
    if (await ports.readTarget(incompletePath)) continue;
    const full = (await readJson(root + '/FULL.json'))?.value;
    if (!full) continue;
    requireValue(full.status === 'FULL' && full.scope === BACKUP_SCOPE && full.projectId === config.neonProjectId && full.sourceBranchId === config.sourceBranchId && full.productionEndpointId === config.productionEndpointId && full.sourceStoreId === config.sourceStoreId && full.targetStoreId === config.targetStoreId && full.backupId === candidate.backupId && full.snapshotId === candidate.snapshotId && full.manifestSha256 === candidate.manifestSha256 && full.manifestPath === root + '/manifest.json' && full.cleanup?.status === 'OBSERVED_DISABLED_AND_IDLE' && Array.isArray(full.cleanup.endpoints) && full.cleanup.endpoints.length > 0 && full.cleanup.endpoints.every(ep => ep.disabled === true && ep.currentState === 'idle'), 'INVALID_BACKUP_FULL_MARKER');
    const manifest = await readJson(full.manifestPath);
    requireValue(manifest && sha256(manifest.bytes) === full.manifestSha256 && manifest.value.snapshot?.id === full.snapshotId && manifest.value.snapshot.sourceBranchId === config.sourceBranchId && manifest.value.backupId === full.backupId && manifest.value.scope === BACKUP_SCOPE && manifest.value.files?.length === full.fileCount && manifest.value.historicalReferences?.length === full.historicalReferenceCount, 'BACKUP_MANIFEST_HASH_MISMATCH');
    // The writer can append INCOMPLETE if the post-FULL production guard fails.
    if (confirmNoIncomplete && await ports.readTarget(incompletePath)) continue;
    yield { full, snapshotCreatedAt: manifest.value.snapshot.createdAt };
  }
}

export async function readCrmBackupIndex(options) {
  const index = [];
  for await (const { full } of readVerifiedBackupSets(options)) index.push(full);
  return index;
}

function parseBackupInstant(value) {
  if (typeof value !== 'string') return NaN;
  const date = /^(\d{4}-\d{2}-\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.exec(value)?.[1];
  if (!date) return NaN;
  const midnight = Date.parse(date);
  if (!Number.isFinite(midnight) || new Date(midnight).toISOString().slice(0, 10) !== date) return NaN;
  return Date.parse(value);
}

/** Read only the private backup index, markers and manifests. The age check
 * uses the recorded snapshot time, regardless of when its export finished. */
export async function readCrmBackupFreshness({ config, ports, now = new Date() } = {}) {
  const rpoHours = 24;
  const unverified = { status: 'unverified', rpoHours };
  try {
    const checkedAt = now instanceof Date ? now.getTime() : parseBackupInstant(now);
    if (!Number.isFinite(checkedAt)) return unverified;
    let latestSnapshot = -Infinity;
    for await (const { snapshotCreatedAt } of readVerifiedBackupSets({ config, ports }, { confirmNoIncomplete: true })) {
      const snapshotAt = parseBackupInstant(snapshotCreatedAt);
      if (!Number.isFinite(snapshotAt) || snapshotAt > checkedAt) return unverified;
      latestSnapshot = Math.max(latestSnapshot, snapshotAt);
    }
    if (latestSnapshot === -Infinity) return { status: 'no-full', rpoHours };
    const ageMs = checkedAt - latestSnapshot;
    return { status: ageMs <= rpoHours * 60 * 60 * 1000 ? 'fresh' : 'stale', rpoHours,
      snapshotCreatedAt: new Date(latestSnapshot).toISOString(), ageMs };
  } catch {
    return unverified;
  }
}

/** No truthy callback result can replace the individual evidence gates. */
export async function runCrmFullBackup({ config: input, ports, now = () => new Date(), backupId = 'backup-' + randomUUID() }) {
  const config = validateBackupConfig(input);
  requireValue(/^[a-z0-9][a-z0-9-]{5,100}$/.test(backupId), 'INVALID_BACKUP_ID');
  for (const name of ['credentialsReady', 'readProductionBinding', 'snapshotInfo', 'listSourceObjects', 'restoreSnapshot', 'waitForRestore', 'getIsolatedEndpoints', 'prepareIsolatedEndpoint', 'captureDatabase', 'readSourceFile', 'readTarget', 'writeTarget', 'disableIsolatedEndpoint']) requireValue(typeof ports?.[name] === 'function', 'BACKUP_PORTS_REQUIRED');
  const ready = await ports.credentialsReady();
  requireValue(ready?.neonApiKey === true, 'BLOCKED_NEON_API_KEY_REQUIRED');
  requireValue(ready?.productionOidc === true && ready.projectId === config.backupProjectId && ready.teamId === config.teamId && ready.environment === 'production', 'BLOCKED_PRODUCTION_OIDC_REQUIRED');
  const timestamp = () => new Date(typeof now === 'function' ? now() : now).toISOString();
  const root = `${config.prefix}/sets/${backupId}`, createdAt = timestamp();
  const evidence = { format: 'crm-full-backup-v1', backupId, status: 'RUNNING', scope: BACKUP_SCOPE, createdAt,
    sourceStoreId: config.sourceStoreId, targetStoreId: config.targetStoreId,
    projectId: config.neonProjectId, sourceBranchId: config.sourceBranchId, productionEndpointId: config.productionEndpointId,
    wholeApplicationBackup: false, legacyPublicFilesCopied: false, retentionDays: config.retentionDays };
  let branch = null, initial = null, cleanup = null, snapshot = null, claimOwned = false, fullMarkerAttempted = false;
  const checkProduction = async () => {
    const receipt = productionReceipt(await ports.readProductionBinding(), config);
    if (initial) requireValue(digest(receipt) === digest(initial), 'PRODUCTION_BINDING_CHANGED');
    return receipt;
  };
  const save = async (pathname, object) => {
    const bytes = Buffer.from(canonical(object));
    const existing = await ports.readTarget(pathname);
    if (!existing) {
      try {
        const receipt = await ports.writeTarget(pathname, bytes, { access: 'private', allowOverwrite: false, addRandomSuffix: false, contentType: 'application/json' });
        requireValue(receipt?.storeId === config.targetStoreId && receipt.pathname === pathname && receipt.access === 'private', 'BACKUP_RECORD_TARGET_MISMATCH');
      } catch (error) {
        // Only transport uncertainty may be resolved by readback. A failed
        // production/scope/auth guard remains a failure even if bytes exist.
        if (error instanceof CrmBackupError && !['BACKUP_PROVIDER_REQUEST_FAILED', 'BACKUP_PROVIDER_OR_IO_FAILED'].includes(error.code)) throw error;
        const reconciled = await ports.readTarget(pathname);
        if (!reconciled) throw error;
        const actual = await exactBytes(reconciled, { storeId: config.targetStoreId, pathname, bytes: bytes.length, maxBytes: 10 * 1024 * 1024 });
        requireValue(sha256(actual) === sha256(bytes), 'BACKUP_RECORD_HASH_MISMATCH');
      }
    }
    const stored = await exactBytes(existing ?? await ports.readTarget(pathname), { storeId: config.targetStoreId, pathname, bytes: bytes.length, maxBytes: 10 * 1024 * 1024 });
    requireValue(sha256(stored) === sha256(bytes), 'BACKUP_RECORD_HASH_MISMATCH');
    return { pathname, sha256: sha256(bytes) };
  };
  const shutDown = async () => {
    if (!branch) return { status: 'NO_OWNED_COMPUTE_CREATED', endpoints: [] };
    const endpoints = await ports.getIsolatedEndpoints(branch);
    requireValue(Array.isArray(endpoints) && endpoints.length > 0, 'ISOLATED_CLEANUP_ENDPOINTS_UNCONFIRMED');
    const receipts = [];
    for (const ep of endpoints) {
      validateEndpoint(ep, branch, config); await checkProduction();
      const receipt = await ports.disableIsolatedEndpoint(ep);
      validateEndpoint(receipt, branch, config);
      requireValue(receipt.disabled === true && receipt.currentState === 'idle', 'ISOLATED_COMPUTE_CLEANUP_UNCONFIRMED');
      await checkProduction(); receipts.push({ id: ep.id, branchId: ep.branchId, disabled: true, currentState: 'idle' });
    }
    // Re-list prevents silently ignoring a second endpoint returned by restore.
    const observed = await ports.getIsolatedEndpoints(branch);
    requireValue(observed.length === receipts.length && observed.every(ep => { validateEndpoint(ep, branch, config); return receipts.some(receipt => receipt.id === ep.id) && ep.disabled === true && ep.currentState === 'idle'; }), 'ISOLATED_COMPUTE_CLEANUP_UNCONFIRMED');
    return { status: 'OBSERVED_DISABLED_AND_IDLE', observedAt: timestamp(), endpoints: receipts };
  };
  try {
    // List authenticates the actual source OIDC grant before any Neon mutation.
    const sourceObjects = await ports.listSourceObjects();
    requireValue(Array.isArray(sourceObjects) && sourceObjects.every(object => object.storeId === config.sourceStoreId && object.access === 'private' && typeof object.pathname === 'string'), 'SOURCE_STORE_INVENTORY_MISMATCH');
    initial = await checkProduction();
    snapshot = await ports.snapshotInfo(config.snapshotId);
    requireValue(/^snap-[a-z0-9-]{5,100}$/.test(snapshot?.id ?? '') && snapshot.sourceBranchId === config.sourceBranchId && Number.isFinite(Date.parse(snapshot.createdAt)) && (!config.snapshotId || config.snapshotId === snapshot.id), 'SNAPSHOT_SOURCE_BINDING_MISMATCH');
    evidence.snapshot = snapshot;
    const claimPath = `${config.prefix}/snapshots/${snapshot.id}/claim.json`;
    requireValue(await ports.readTarget(claimPath) === null, 'BACKUP_SNAPSHOT_ALREADY_CLAIMED');
    // Atomic no-overwrite creates one owner for a scheduled snapshot. An
    // interrupted claim is reviewed explicitly; execution never repeats restore.
    try {
      const claimed = await ports.writeTarget(claimPath, Buffer.from(canonical({ backupId, snapshotId: snapshot.id, sourceBranchId: config.sourceBranchId, sourceStoreId: config.sourceStoreId, targetStoreId: config.targetStoreId })), { access: 'private', allowOverwrite: false, addRandomSuffix: false, contentType: 'application/json' });
      requireValue(claimed?.storeId === config.targetStoreId && claimed.pathname === claimPath && claimed.access === 'private', 'BACKUP_RECORD_TARGET_MISMATCH');
      claimOwned = true;
    } catch (error) {
      // Do not turn an authorization/transport failure into a fictitious
      // existing claim. An uncertain claim is never followed by another POST.
      let raced = null; try { raced = await ports.readTarget(claimPath); } catch {}
      if (raced) throw new CrmBackupError('BACKUP_SNAPSHOT_ALREADY_CLAIMED');
      throw error;
    }
    await save(root + '/RUNNING.json', evidence);
    await checkProduction();
    const name = `crm-backup-${backupId}`;
    const restored = await ports.restoreSnapshot({ snapshotId: snapshot.id, name, finalize: false });
    branch = validateCopy(restored, config, snapshot, name);
    await checkProduction();
    validateCopy(await ports.waitForRestore(restored), config, snapshot, name);
    const endpoints = await ports.getIsolatedEndpoints(branch);
    requireValue(Array.isArray(endpoints), 'ISOLATED_ENDPOINT_INVENTORY_REQUIRED');
    endpoints.forEach(ep => validateEndpoint(ep, branch, config));
    await checkProduction();
    const endpoint = validateEndpoint(await ports.prepareIsolatedEndpoint(branch, endpoints), branch, config);
    await checkProduction();
    const captured = await ports.captureDatabase({ branch, endpoint });
    requireValue(captured?.identity?.projectId === config.neonProjectId && captured.identity.branchId === branch.id && captured.identity.databaseName === config.databaseName && captured.identity.readOnly === true && captured.identity.rlsFilteredTables === 0, 'ISOLATED_DATABASE_IDENTITY_MISMATCH');
    requireValue(/^[a-f0-9]{64}$/.test(captured.fingerprint?.sha256 ?? '') && Array.isArray(captured.fingerprint.tables) && captured.fingerprint.catalog && Array.isArray(captured.fingerprint.sequences), 'FULL_DATABASE_FINGERPRINT_REQUIRED');
    const inventory = validatePrivateManifest(captured.inventory);
    const sourceByPath = new Map(sourceObjects.map(object => [object.pathname, object]));
    for (const file of inventory.assets) requireValue(sourceByPath.has(file.pathname) && sourceByPath.get(file.pathname).size === file.bytes, 'REFERENCED_PRIVATE_FILE_MISSING_FROM_STORE');
    const files = [];
    for (const file of inventory.assets) {
      requireValue(file.bytes <= config.maxFileBytes, 'PRIVATE_FILE_BUDGET_EXCEEDED');
      const bytes = await exactBytes(await ports.readSourceFile(file), { storeId: config.sourceStoreId, pathname: file.pathname, bytes: file.bytes, maxBytes: config.maxFileBytes });
      const checksum = sha256(bytes);
      requireValue(!file.expectedSha256 || file.expectedSha256 === checksum, 'SOURCE_FILE_HASH_MISMATCH');
      // The two already restored objects can be reused only after an exact read.
      // They remain external to retention ownership and are never overwritten.
      let archivePathname = file.pathname, archiveOwned = false, reused = false;
      const original = await ports.readTarget(file.pathname);
      if (original) {
        const old = await exactBytes(original, { storeId: config.targetStoreId, pathname: file.pathname, maxBytes: config.maxFileBytes });
        reused = old.length === file.bytes && sha256(old) === checksum;
      }
      if (!reused) {
        archivePathname = `${root}/files/${file.id}-${checksum}`; archiveOwned = true;
        const existing = await ports.readTarget(archivePathname);
        if (existing) {
          const old = await exactBytes(existing, { storeId: config.targetStoreId, pathname: archivePathname, bytes: file.bytes, maxBytes: config.maxFileBytes });
          requireValue(sha256(old) === checksum, 'PRIVATE_ARCHIVE_HASH_MISMATCH'); reused = true;
        } else {
          const receipt = await ports.writeTarget(archivePathname, bytes, { access: 'private', allowOverwrite: false, addRandomSuffix: false, contentType: file.mimeType });
          requireValue(receipt?.storeId === config.targetStoreId && receipt.pathname === archivePathname && receipt.access === 'private', 'PRIVATE_ARCHIVE_TARGET_MISMATCH');
        }
      }
      const readback = await exactBytes(await ports.readTarget(archivePathname), { storeId: config.targetStoreId, pathname: archivePathname, bytes: file.bytes, maxBytes: config.maxFileBytes });
      requireValue(sha256(readback) === checksum, 'PRIVATE_ARCHIVE_HASH_MISMATCH');
      files.push({ ...file, sha256: checksum, archivePathname, archiveOwned, reused });
    }
    await checkProduction();
    cleanup = await shutDown();
    const referenced = new Set(inventory.assets.map(file => file.pathname));
    const manifest = { ...evidence, status: 'DATA_COMPLETE', snapshot, isolatedBranch: branch,
      productionBinding: initial, database: captured.fingerprint, files, historicalReferences: inventory.references,
      versionBindingsSha256: inventory.versionBindingsSha256, legacyPublic: inventory.legacyPublic,
      unreferencedSourceObjects: sourceObjects.filter(object => !referenced.has(object.pathname)),
      excludedScope: ['Legacy-public and public files are inventoried but not copied', 'Unreferenced source-store objects are reported, not silently included', 'No authenticated restored application acceptance is claimed'],
      cleanup, expiresAt: new Date(Date.parse(createdAt) + config.retentionDays * 86400000).toISOString() };
    const manifestReceipt = await save(root + '/manifest.json', manifest);
    await checkProduction();
    const full = { ...evidence, status: 'FULL', snapshotId: snapshot.id, isolatedBranchId: branch.id,
      completedAt: timestamp(), manifestPath: manifestReceipt.pathname, manifestSha256: manifestReceipt.sha256,
      fileCount: files.length, fileBytes: files.reduce((sum, file) => sum + file.bytes, 0), historicalReferenceCount: inventory.references.length, cleanup };
    // Index first, commit marker last. Readers must verify FULL.json AND its hash.
    await save(`${config.prefix}/index/${backupId}-FULL.json`, { ...full, status: 'COMMIT_CANDIDATE', requiresVerifiedFullMarker: true });
    fullMarkerAttempted = true;
    await save(root + '/FULL.json', full);
    await checkProduction();
    return full;
  } catch (error) {
    let cleanupCode = null, cleanupFailure = null, productionVerification = { status: 'NOT_YET_CAPTURED' };
    if (initial) {
      try { await checkProduction(); productionVerification = { status: 'UNCHANGED' }; }
      catch (failure) { productionVerification = { status: 'UNCONFIRMED_OR_CHANGED', failureCode: errorCode(failure), ...backupProviderDiagnostics(failure) }; cleanupCode = errorCode(failure); cleanupFailure = failure; }
    }
    // Unexpected production drift stops further Neon mutations; it must never
    // be 'repaired' by moving an endpoint or touching an unverified branch.
    if (branch && !cleanup && productionVerification.status === 'UNCHANGED') try { cleanup = await shutDown(); } catch (failure) { cleanupCode = errorCode(failure); cleanupFailure = failure; }
    const incomplete = { ...evidence, status: 'INCOMPLETE', failureCode: errorCode(error), ...backupProviderDiagnostics(error), completedAt: timestamp(),
      isolatedBranchId: branch?.id ?? null, productionVerification, cleanup: cleanup ?? { status: 'UNCONFIRMED', failureCode: cleanupCode, ...backupProviderDiagnostics(cleanupFailure) },
      fullMarkerState: fullMarkerAttempted ? 'MAY_EXIST_BUT_SUPPRESSED' : 'NOT_ATTEMPTED' };
    // A duplicate invocation must not attach INCOMPLETE to an earlier valid
    // FULL set. Only the atomic claim owner may append this run's evidence.
    if (claimOwned) {
      await save(root + '/INCOMPLETE.json', incomplete).catch(() => {});
      await save(`${config.prefix}/index/${backupId}-INCOMPLETE.json`, incomplete).catch(() => {});
    }
    throw new CrmBackupError(cleanupCode ?? errorCode(error), backupProviderDiagnostics(cleanupFailure ?? error));
  }
}

/** Read a frozen restored database only; no synthetic safeguards are relaxed. */
export async function captureCrmBackupDatabase(client, { config, branch }) {
  await client.query('begin isolation level repeatable read read only');
  try {
    await client.query("set local search_path=pg_catalog,public");
    await client.query("set local timezone='UTC'");
    await client.query("set local datestyle='ISO, YMD'");
    await client.query('set local extra_float_digits=3');
    await client.query('set local statement_timeout=60000');
    const identityRow = (await client.query(`select current_setting('neon.project_id',true) as "projectId",current_setting('neon.branch_id',true) as "branchId",current_database() as "databaseName",current_setting('transaction_read_only')='on' as "readOnly",current_user as role`)).rows[0];
    requireValue(identityRow.projectId === config.neonProjectId && identityRow.branchId === branch.id && identityRow.databaseName === config.databaseName && identityRow.readOnly === true, 'ISOLATED_DATABASE_IDENTITY_MISMATCH');
    const relations = (await client.query(`select n.nspname as schema,c.relname as name,c.relkind as kind,row_security_active(c.oid) as filtered from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname !~ '^pg_' and n.nspname<>'information_schema' and c.relkind in('r','p','m','f','S') order by n.nspname,c.relname`)).rows;
    requireValue(relations.every(row => !row.filtered), 'BACKUP_DATABASE_RLS_FILTERED');
    requireValue(relations.every(row => row.kind !== 'f'), 'EXTERNAL_TABLE_BACKUP_UNSUPPORTED');
    const namespaces = (await client.query(catalogQueries.namespaces)).rows.map(row => row.nspname);
    const catalog = {};
    for (const [category, sql] of Object.entries(catalogQueries)) {
      const rows = [];
      if (sql.includes("'public'")) {
        for (const schema of namespaces) {
          for (const row of (await client.query(sql.replaceAll("'public'", quoteLiteral(schema)))).rows) rows.push({ schema, ...row });
        }
      } else rows.push(...(await client.query(sql)).rows);
      if (category === 'roles') for (const row of rows) if (row.rolconfig) row.rolconfig = row.rolconfig.map(value => ({ name: value.split('=', 1)[0], sha256: sha256(value) }));
      catalog[category] = { objects: rows.length, sha256: digest(rows) };
    }
    const metadata = await captureDatabaseMetadata(client);
    for (const [category, rows] of Object.entries({ database_properties: [metadata.properties], database_acl: metadata.acl, database_settings: metadata.settings, database_globalRoleSettings: metadata.globalRoleSettings.settings })) {
      catalog[category] = { objects: rows.length, sha256: digest(rows) };
    }
    const extraQueries = {
      migrationLedger: 'select version,name,checksum,applied_at from public.novalure_schema_migrations order by version',
      eventTriggers: "select evtname,evtevent,pg_get_userbyid(evtowner) as owner,evtfoid::regprocedure::text as function,evtenabled,evttags from pg_event_trigger order by evtname",
      publications: "select pubname,pg_get_userbyid(pubowner) as owner,puballtables,pubinsert,pubupdate,pubdelete,pubtruncate,pubviaroot from pg_publication order by pubname",
      largeObjectMetadata: "select m.oid::text,pg_get_userbyid(m.lomowner) as owner,m.lomacl,(select encode(public.digest(coalesce(string_agg(l.data,''::bytea order by l.pageno),''::bytea),'sha256'),'hex') from pg_largeobject l where l.loid=m.oid) as data_sha256 from pg_largeobject_metadata m order by m.oid",
    };
    for (const [category, sql] of Object.entries(extraQueries)) {
      const rows = (await client.query(sql)).rows; catalog[category] = { objects: rows.length, sha256: digest(rows) };
    }
    const tables = [], sequences = [];
    for (const table of relations) {
      const name = `${quoteIdentifier(table.schema)}.${quoteIdentifier(table.name)}`;
      if (table.kind === 'S') {
        const state = (await client.query(`select last_value::text as "lastValue",is_called as "isCalled" from ${name}`)).rows[0];
        sequences.push({ schema: table.schema, name: table.name, ...state });
      } else {
        const row = (await client.query(`select count(*)::text as rows,encode(public.digest(convert_to(coalesce(string_agg(to_jsonb(t)::text,E'\\n' order by (to_jsonb(t)::text) collate "C"),''),'UTF8'),'sha256'),'hex') as sha256 from ${name} t`)).rows[0];
        requireValue(Number.isSafeInteger(Number(row.rows)) && Number(row.rows) >= 0 && /^[a-f0-9]{64}$/.test(row.sha256 ?? ''), 'DATABASE_TABLE_FINGERPRINT_INVALID');
        tables.push({ schema: table.schema, name: table.name, rows: Number(row.rows), sha256: row.sha256 });
      }
    }
    const allAssets = (await client.query(`select id::text,workspace_id::text as "workspaceId",relative_path as pathname,size_bytes::float8 as bytes,mime_type as "mimeType",storage_provider as "storageProvider",storage_access as "storageAccess",is_public as "isPublic",case when public_token is null then null else 'PRESENT' end as "publicToken" from public.media_assets order by id`)).rows;
    const references = (await client.query(`select v.id::text as "versionId",v.source_id::text as "sourceId",v.workspace_id::text as "workspaceId",v.media_asset_id::text as "assetId",v.status,v.document_sha256 as sha256,(v.id=s.draft_version_id or v.id=s.approved_version_id) as "isCurrent" from public.knowledge_source_versions v left join public.knowledge_sources s on s.id=v.source_id and s.workspace_id=v.workspace_id where v.media_asset_id is not null order by v.id`)).rows;
    const ids = new Set(allAssets.map(asset => asset.id));
    const inventory = { assets: allAssets.filter(asset => asset.storageAccess === 'private'), references,
      missingReferences: references.filter(ref => !ids.has(ref.assetId)), legacyPublic: allAssets.filter(asset => asset.storageAccess !== 'private') };
    validatePrivateManifest(inventory);
    const fingerprint = { tables, sequences, catalog, sha256: digest({ tables, sequences, catalog }) };
    await client.query('rollback');
    return { identity: { ...identityRow, rlsFilteredTables: 0 }, fingerprint, inventory };
  } catch (error) { await client.query('rollback').catch(() => {}); throw error; }
}
