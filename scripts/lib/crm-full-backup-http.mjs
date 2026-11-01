/** Minimal Web Request/Response adapter for the separate backup workload.
 * Import/construction perform no I/O. Request values never become CLI options.
 */
import { timingSafeEqual } from 'node:crypto';
import { main } from '../crm-full-backup.mjs';
import { BACKUP_SCOPE, defaultCrmBackupConfig as binding } from './crm-full-backup.mjs';

const headers = Object.freeze({ 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' });
const knownFields = new Set(['status', 'code', 'mode', 'scope', 'source', 'target', 'snapshot', 'missing', 'retentionDays',
  'retentionMode', 'changesApplied', 'sourceSqlConnections', 'sourceBlobOperations', 'restoreFinalize', 'wholeApplicationBackup',
  'existingSchedulesChanged', 'backupId', 'snapshotId', 'isolatedBranchId', 'fileCount', 'fileBytes', 'historicalReferenceCount',
  'manifestSha256', 'cleanup', 'completedAt', 'remoteRequests', 'fullBackupClaimed']);
const missingNames = new Map([
  ['NEON_API_KEY: project-scoped Neon management credential', 'NEON_API_KEY'],
  ['VERCEL_OIDC_TOKEN: legitimate Production token for the exact backup project and team', 'PRODUCTION_OIDC'],
]);
const statuses = new Set(['BLOCKED', 'READY_FOR_EXPLICIT_EXECUTION', 'FULL', 'INCOMPLETE']);
const safeObject = value => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

function authorized(request, env) {
  const secret = env.CRON_SECRET;
  if (typeof secret !== 'string' || secret.length < 32 || Buffer.byteLength(secret) > 4096 || /[\r\n]/u.test(secret)) return false;
  const supplied = request.headers.get('authorization') ?? '';
  const expected = Buffer.from(`Bearer ${secret}`);
  const actual = Buffer.from(supplied);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
function workloadMatches(env) {
  const teams = ['VERCEL_TEAM_ID', 'VERCEL_ORG_ID', 'CRM_BACKUP_TEAM_ID'].filter(key => env[key] !== undefined);
  return env.VERCEL_ENV === 'production' && (env.VERCEL_TARGET_ENV === undefined || env.VERCEL_TARGET_ENV === 'production') &&
    env.VERCEL_PROJECT_ID === binding.backupProjectId && teams.length > 0 && teams.every(key => env[key] === binding.teamId);
}
/** Validate the CLI envelope and expose only typed summary values. Source/target
 * records, informational strings and unvalidated error codes never enter HTTP/logs. */
function publicSummary(value) {
  if (!safeObject(value) || Object.keys(value).some(key => !knownFields.has(key)) || !statuses.has(value.status)) return null;
  if (value.scope !== undefined && value.scope !== BACKUP_SCOPE) return null;
  if (value.code !== undefined && (typeof value.code !== 'string' || !/^[A-Z][A-Z0-9_]{1,100}$/u.test(value.code))) return null;
  if (value.mode !== undefined && value.mode !== 'PLAN_ONLY_NO_REMOTE_IO') return null;
  if (value.wholeApplicationBackup !== undefined && value.wholeApplicationBackup !== false) return null;
  if (value.fullBackupClaimed !== undefined && value.fullBackupClaimed !== false) return null;
  const result = { status: value.status, scope: BACKUP_SCOPE, wholeApplicationBackup: false };
  if (value.code !== undefined && ['BLOCKED', 'INCOMPLETE'].includes(value.status)) result.failureCode = value.code;
  if (value.missing !== undefined) {
    if (!Array.isArray(value.missing) || !value.missing.every(item => missingNames.has(item))) return null;
    result.missing = [...new Set(value.missing.map(item => missingNames.get(item)))];
  }
  for (const [key, pattern] of Object.entries({ backupId: /^backup-[a-z0-9-]{1,100}$/u, snapshotId: /^snap-[a-z0-9-]{5,100}$/u,
    isolatedBranchId: /^br-[a-z0-9-]{8,100}$/u, manifestSha256: /^[a-f0-9]{64}$/u })) {
    if (value[key] === undefined) continue;
    if (typeof value[key] !== 'string' || !pattern.test(value[key])) return null;
    result[key] = value[key];
  }
  for (const key of ['fileCount', 'fileBytes', 'historicalReferenceCount', 'remoteRequests']) {
    if (value[key] === undefined) continue;
    if (!Number.isSafeInteger(value[key]) || value[key] < 0) return null;
    result[key] = value[key];
  }
  if (value.cleanup !== undefined) {
    if (value.cleanup !== 'OBSERVED_DISABLED_AND_IDLE') return null;
    result.cleanup = value.cleanup;
  }
  if (value.completedAt !== undefined) {
    if (typeof value.completedAt !== 'string' || value.completedAt.length > 40 || !Number.isFinite(Date.parse(value.completedAt))) return null;
    result.completedAt = new Date(value.completedAt).toISOString();
  }
  return result;
}

async function currentRuntimeOidcToken() {
  // The synchronous native accessor reads Vercel's request context, then its
  // normal environment fallback. It never refreshes or fetches a token.
  const { getVercelOidcTokenSync } = await import('@vercel/oidc');
  return getVercelOidcTokenSync();
}

export function createCrmBackupHttpHandler({ env = process.env, run = main, getOidcToken = currentRuntimeOidcToken, log = record => console.info(JSON.stringify(record)) } = {}) {
  return async function handleCrmBackupRequest(request) {
    const respond = (value, status, extraHeaders = {}) => {
      // Only fixed HTTP codes, validated statuses and the same validated CLI
      // failure code are logged. Provider error objects/messages are excluded.
      try { log({ status: value.status, code: value.code, ...(value.failureCode ? { failureCode: value.failureCode } : {}) }); } catch { /* Logging is never an authority or an error-payload sink. */ }
      return Response.json(value, { status, headers: { ...headers, ...extraHeaders } });
    };
    const failure = (status, code, httpStatus) => respond({ status, code, wholeApplicationBackup: false }, httpStatus);
    try {
      if (request.method !== 'GET') return respond({ status: 'BLOCKED', code: 'BACKUP_HTTP_METHOD_NOT_ALLOWED' }, 405, { allow: 'GET' });
      if (!authorized(request, env)) return failure('BLOCKED', 'BACKUP_CRON_UNAUTHORIZED', 401);
      const url = new URL(request.url);
      if (url.search || url.hash) return failure('BLOCKED', 'BACKUP_HTTP_OPTIONS_FORBIDDEN', 400);
      if (!workloadMatches(env)) return failure('BLOCKED', 'BACKUP_HTTP_WORKLOAD_BLOCKED', 503);
      const enabled = env.CRM_FULL_BACKUP_ENABLED === 'true';
      const runnerEnv = { ...env };
      try {
        // Prefer the current platform context to a potentially older env token.
        // Do not read a caller-supplied request header or mutate process.env.
        const token = await getOidcToken();
        if (typeof token === 'string' && token) runnerEnv.VERCEL_OIDC_TOKEN = token;
      } catch { /* No runtime token: the unchanged local env fallback stays missing/blocked as appropriate. */ }
      let captured, count = 0;
      // No request body, query, headers or URL component can supply arguments,
      // configuration, credentials, source scope, snapshot or execution mode.
      const exitCode = await run([enabled ? '--execute' : '--plan'], runnerEnv, value => { captured = value; count++; });
      const summary = count === 1 ? publicSummary(captured) : null;
      if (!summary || !Number.isSafeInteger(exitCode)) return failure('INCOMPLETE', 'BACKUP_HTTP_RESULT_INVALID', 503);
      if (!enabled && exitCode === 0 && ['BLOCKED', 'READY_FOR_EXPLICIT_EXECUTION'].includes(summary.status)) {
        return respond({ ...summary, enabled: false, mode: 'PLAN_ONLY_NO_REMOTE_IO', code: summary.status === 'BLOCKED' ? 'BACKUP_PLAN_BLOCKED' : 'BACKUP_PLAN_READY' }, 200);
      }
      if (enabled && exitCode === 0 && summary.status === 'FULL') {
        return respond({ ...summary, enabled: true, mode: 'EXECUTE', code: 'BACKUP_FULL' }, 200);
      }
      if (summary.status === 'BLOCKED') return respond({ ...summary, enabled, code: 'BACKUP_EXECUTION_BLOCKED' }, 503);
      if (summary.status === 'INCOMPLETE') return respond({ ...summary, enabled, code: 'BACKUP_INCOMPLETE' }, 503);
      return failure('INCOMPLETE', 'BACKUP_HTTP_RESULT_INVALID', 503);
    } catch {
      return failure('INCOMPLETE', 'BACKUP_HTTP_RUNNER_FAILED', 503);
    }
  };
}
