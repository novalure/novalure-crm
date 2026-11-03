/** Metadata-only bridge to the existing fixed Evelyn owner warning channel.
 * No import/construction I/O, credential lookup, arbitrary message, URL or retry.
 */
import { createHash, createHmac } from 'node:crypto';
import { defaultCrmBackupConfig as binding } from './crm-full-backup.mjs';

// Existing protected production origin, independently read back before this pin.
export const CRM_BACKUP_WARNING_ENDPOINT = 'https://evelyn-canary.novalure.eu/api/ops/backup-failure';
export const backupFailureClasses = Object.freeze([
  'CREDENTIALS_UNAVAILABLE', 'PRODUCTION_BINDING_CHANGED', 'SNAPSHOT_UNAVAILABLE',
  'SNAPSHOT_ALREADY_CLAIMED', 'DATA_INTEGRITY_FAILED', 'CLEANUP_UNCONFIRMED',
  'PROVIDER_UNAVAILABLE', 'BACKUP_EXECUTION_FAILED',
]);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const canonicalInstant = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(value) &&
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;

/** Provider messages/objects are never forwarded. Unknown codes lose detail. */
export function classifyCrmBackupFailure(value) {
  const code = typeof value === 'string' && /^[A-Z][A-Z0-9_]{1,100}$/u.test(value) ? value : '';
  if (/^(?:BLOCKED_(?:NEON_API_KEY|PRODUCTION_OIDC)_REQUIRED|NEON_HTTP_(?:401|403))$/u.test(code)) return 'CREDENTIALS_UNAVAILABLE';
  // A provider which rejected a request has been reached; do not diagnose an
  // outage or a missing snapshot from an otherwise unclassified HTTP4xx.
  if (/^NEON_HTTP_4\d\d$/u.test(code) && code !== 'NEON_HTTP_429') return 'BACKUP_EXECUTION_FAILED';
  if (/^PRODUCTION_(?:BRANCH_BINDING|ENDPOINT_BINDING|BINDING)_CHANGED$/u.test(code)) return 'PRODUCTION_BINDING_CHANGED';
  if (code === 'BACKUP_SNAPSHOT_ALREADY_CLAIMED') return 'SNAPSHOT_ALREADY_CLAIMED';
  if (/^(?:SNAPSHOT_|NEON_SNAPSHOT_|SOURCE_SNAPSHOT_|INVALID_BACKUP_SNAPSHOT)/u.test(code)) return 'SNAPSHOT_UNAVAILABLE';
  if (/^(?:ISOLATED_(?:COMPUTE_CLEANUP|CLEANUP_ENDPOINTS)|RESTORE_CLEANUP)_UNCONFIRMED$/u.test(code)) return 'CLEANUP_UNCONFIRMED';
  if (/^(?:PRIVATE_|SOURCE_FILE_|REFERENCED_PRIVATE_|HISTORICAL_|MISSING_HISTORICAL_|FULL_DATABASE_|ISOLATED_DATABASE_|BLOB_OBJECT_|BACKUP_(?:MANIFEST|RECORD)_)/u.test(code)) return 'DATA_INTEGRITY_FAILED';
  if (/^(?:NEON_|BLOB_|BACKUP_PROVIDER_)/u.test(code)) return 'PROVIDER_UNAVAILABLE';
  // HTTP failures and every unrecognized failure remain operational failure.
  return 'BACKUP_EXECUTION_FAILED';
}

export function crmBackupFailureEventId(runId, failureClass) {
  if (!uuid.test(runId) || !backupFailureClasses.includes(failureClass)) throw new Error('BACKUP_WARNING_ENVELOPE_INVALID');
  const h = createHash('sha256').update(JSON.stringify(['crm-full-backup', 'production', runId, failureClass])).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export function createCrmBackupFailureEvent({ runId, failureClass, occurredAt }) {
  if (!canonicalInstant(occurredAt)) throw new Error('BACKUP_WARNING_ENVELOPE_INVALID');
  return Object.freeze({ schemaVersion: 1, source: 'crm-full-backup', environment: 'production',
    eventId: crmBackupFailureEventId(runId, failureClass), runId, failureClass, occurredAt });
}

function workloadMatches(env) {
  const teams = ['VERCEL_TEAM_ID', 'VERCEL_ORG_ID', 'CRM_BACKUP_TEAM_ID'].filter(key => env[key] !== undefined);
  return env.VERCEL_ENV === 'production' && (env.VERCEL_TARGET_ENV === undefined || env.VERCEL_TARGET_ENV === 'production') &&
    env.VERCEL_PROJECT_ID === binding.backupProjectId && teams.length > 0 && teams.every(key => env[key] === binding.teamId);
}
const unknown = Object.freeze({ status: 'ALARM_UNCONFIRMED' });

/** Local identity/expiry guard only. Vercel verifies the signature and its exact
 * Trusted Sources grant. The HTTP adapter supplies only its native getter's
 * result, without separately selecting an older env token or refreshing it. */
function currentProductionOidc(value, now) {
  if (typeof value !== 'string' || value.length > 20_000) return false;
  try {
    const parts = value.split('.');
    if (parts.length !== 3 || !parts.every(part => /^[A-Za-z0-9_-]+$/u.test(part))) return false;
    const claim = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    const seconds = Math.floor(now / 1000);
    return claim.project_id === binding.backupProjectId && claim.owner_id === binding.teamId && claim.environment === 'production' &&
      claim.iss === `https://oidc.vercel.com/${binding.teamSlug}` && claim.aud === `https://vercel.com/${binding.teamSlug}` &&
      typeof claim.sub === 'string' && claim.sub.startsWith(`owner:${binding.teamSlug}:project:`) && claim.sub.endsWith(':environment:production') &&
      Number.isSafeInteger(claim.exp) && claim.exp > seconds + 30 && Number.isSafeInteger(claim.iat) && claim.iat <= seconds &&
      (claim.nbf === undefined || Number.isSafeInteger(claim.nbf) && claim.nbf <= seconds);
  } catch { return false; }
}

async function responseBytes(response) {
  if (typeof response?.body?.getReader !== 'function') return null;
  const reader = response.body.getReader(), chunks = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 1024) { await reader.cancel().catch(() => {}); return null; }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, length).toString('utf8');
  } finally { reader.releaseLock(); }
}

/** A single bounded POST. Even a successful HTTP response is not delivery proof
 * unless it binds this event to a strict native-receipt digest. */
export function createCrmBackupFailureNotifier({ env = process.env, endpoint = CRM_BACKUP_WARNING_ENDPOINT,
  request = globalThis.fetch, now = Date.now } = {}) {
  return async function notifyCrmBackupFailure(event, { productionOidcToken } = {}) {
    let controller, timer;
    try {
      if (env.CRM_BACKUP_WARNING_ENABLED !== 'true' || !workloadMatches(env) ||
        endpoint !== CRM_BACKUP_WARNING_ENDPOINT ||
        typeof request !== 'function' || !/^[a-f0-9]{64}$/u.test(env.CRM_BACKUP_WARNING_HMAC_KEY ?? '')) return unknown;
      const expected = createCrmBackupFailureEvent(event);
      if (JSON.stringify(expected) !== JSON.stringify(event)) return unknown;
      const currentTime = now(), timestamp = event.occurredAt;
      if (!Number.isSafeInteger(currentTime) || Math.abs(currentTime - Date.parse(timestamp)) > 300_000 ||
        !currentProductionOidc(productionOidcToken, currentTime)) return unknown;
      const body = JSON.stringify(expected);
      const signature = createHmac('sha256', Buffer.from(env.CRM_BACKUP_WARNING_HMAC_KEY, 'hex')).update(timestamp + '.' + body).digest('hex');
      controller = new AbortController();
      // Promise.race also bounds an injected or noncompliant transport which
      // ignores AbortSignal. No second send follows an ambiguous outcome.
      const timedOut = new Promise(resolve => { timer = setTimeout(() => { controller.abort(); resolve(null); }, 5_000); });
      const response = await Promise.race([request(endpoint, { method: 'POST', redirect: 'error',
        signal: controller.signal, headers: { 'content-type': 'application/json',
          'x-vercel-trusted-oidc-idp-token': productionOidcToken,
          'x-novalure-backup-timestamp': timestamp, 'x-novalure-backup-signature': signature }, body }), timedOut]);
      if (!response?.ok) return unknown;
      const raw = await Promise.race([responseBytes(response), timedOut]);
      if (typeof raw !== 'string' || Buffer.byteLength(raw) > 1024) return unknown;
      const result = JSON.parse(raw);
      if (result === null || Array.isArray(result) || typeof result !== 'object' ||
        Object.keys(result).sort().join(',') !== 'eventId,receiptSha256,status' ||
        result.eventId !== event.eventId || result.status !== 'DELIVERED' || !/^[a-f0-9]{64}$/u.test(result.receiptSha256 ?? '')) return unknown;
      return Object.freeze({ status: 'DELIVERED', eventId: result.eventId, receiptSha256: result.receiptSha256 });
    } catch { return unknown; }
    finally { clearTimeout(timer); controller?.abort(); }
  };
}
