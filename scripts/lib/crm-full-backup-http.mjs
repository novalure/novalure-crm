/** Minimal Web Request/Response adapter for the separate backup workload.
 * Import/construction perform no I/O. Request values never become CLI options.
 */
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { main } from '../crm-full-backup.mjs';
import { BACKUP_SCOPE, backupProviderStages, defaultCrmBackupConfig as binding } from './crm-full-backup.mjs';
import { classifyCrmBackupFailure, createCrmBackupFailureEvent, createCrmBackupFailureNotifier } from './crm-backup-failure-warning.mjs';

const headers = Object.freeze({ 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' });
const knownFields = new Set(['status', 'code', 'mode', 'scope', 'source', 'target', 'snapshot', 'missing', 'retentionDays',
  'retentionMode', 'changesApplied', 'sourceSqlConnections', 'sourceBlobOperations', 'restoreFinalize', 'wholeApplicationBackup',
  'existingSchedulesChanged', 'backupId', 'snapshotId', 'isolatedBranchId', 'fileCount', 'fileBytes', 'historicalReferenceCount',
  'manifestSha256', 'cleanup', 'completedAt', 'remoteRequests', 'fullBackupClaimed', 'providerStage', 'providerHttpStatus']);
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
  if (value.providerStage !== undefined) {
    if (!backupProviderStages.includes(value.providerStage) || value.status !== 'INCOMPLETE') return null;
    result.providerStage = value.providerStage;
  }
  if (value.providerHttpStatus !== undefined) {
    if (!value.providerStage || !Number.isInteger(value.providerHttpStatus) || value.providerHttpStatus < 100 || value.providerHttpStatus > 599 ||
      (value.code?.startsWith('NEON_HTTP_') && value.code !== `NEON_HTTP_${value.providerHttpStatus}`)) return null;
    result.providerHttpStatus = value.providerHttpStatus;
  }
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

export function createCrmBackupHttpHandler({ env = process.env, run = main, getOidcToken = currentRuntimeOidcToken,
  createRunId = randomUUID, now = Date.now, notifyFailure = createCrmBackupFailureNotifier({ env }),
  log = record => console.info(JSON.stringify(record)) } = {}) {
  return async function handleCrmBackupRequest(request) {
    let runId = null, enabled = false, productionOidcToken;
    const respond = (value, status, extraHeaders = {}) => {
      // Only fixed HTTP codes, validated statuses and the same validated CLI
      // failure code are logged. Provider error objects/messages are excluded.
      try { log({ status: value.status, code: value.code, ...(value.failureCode ? { failureCode: value.failureCode } : {}),
        ...(value.providerStage ? { providerStage: value.providerStage, ...(value.providerHttpStatus ? { providerHttpStatus: value.providerHttpStatus } : {}) } : {}),
        ...(value.alarmStatus ? { alarmStatus: value.alarmStatus, eventId: value.eventId } : {}) }); } catch { /* Logging is never an authority or an error-payload sink. */ }
      return Response.json(value, { status, headers: { ...headers, ...extraHeaders } });
    };
    const unavailable = async (value, httpStatus) => {
      if (!enabled || runId === null) return respond(value, httpStatus);
      // This is reached only after cron authentication AND exact workload
      // identity. A bad request cannot turn the bridge into an alarm relay.
      const event = createCrmBackupFailureEvent({ runId, occurredAt: new Date(now()).toISOString(),
        failureClass: value.status === 'BLOCKED' && Array.isArray(value.missing) && value.missing.length ?
          'CREDENTIALS_UNAVAILABLE' : classifyCrmBackupFailure(value.failureCode ?? value.code) });
      let notification;
      try { notification = await notifyFailure(event, { productionOidcToken }); } catch { /* Unknown delivery remains unknown; never retry. */ }
      const confirmed = notification?.status === 'DELIVERED' && notification.eventId === event.eventId &&
        /^[a-f0-9]{64}$/u.test(notification.receiptSha256 ?? '');
      return respond({ ...value, eventId: event.eventId, alarmStatus: confirmed ? 'DELIVERED' : 'ALARM_UNCONFIRMED' }, httpStatus);
    };
    const failure = (status, code, httpStatus) => unavailable({ status, code, wholeApplicationBackup: false }, httpStatus);
    try {
      if (request.method !== 'GET') return respond({ status: 'BLOCKED', code: 'BACKUP_HTTP_METHOD_NOT_ALLOWED' }, 405, { allow: 'GET' });
      if (!authorized(request, env)) return failure('BLOCKED', 'BACKUP_CRON_UNAUTHORIZED', 401);
      const url = new URL(request.url);
      if (url.search || url.hash) return failure('BLOCKED', 'BACKUP_HTTP_OPTIONS_FORBIDDEN', 400);
      if (!workloadMatches(env)) return failure('BLOCKED', 'BACKUP_HTTP_WORKLOAD_BLOCKED', 503);
      enabled = env.CRM_FULL_BACKUP_ENABLED === 'true';
      if (enabled) {
        runId = createRunId();
        if (typeof runId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(runId)) {
          runId = null;
          return failure('INCOMPLETE', 'BACKUP_HTTP_RUN_ID_INVALID', 503);
        }
      }
      const runnerEnv = { ...env };
      try {
        // Prefer the current platform context to a potentially older env token.
        // Do not read a caller-supplied request header or mutate process.env.
        const token = await getOidcToken();
        if (typeof token === 'string' && token) {
          runnerEnv.VERCEL_OIDC_TOKEN = token;
          // Only this invocation's native context result reaches hosting
          // admission; the warning bridge never falls back to an older env token.
          productionOidcToken = token;
        }
      } catch { /* No runtime token: the unchanged local env fallback stays missing/blocked as appropriate. */ }
      let captured, count = 0;
      // No request body, query, headers or URL component can supply arguments,
      // configuration, credentials, source scope, snapshot or execution mode.
      const exitCode = await run(enabled ? ['--execute', '--backup-id', `backup-${runId}`] : ['--plan'], runnerEnv, value => { captured = value; count++; });
      const summary = count === 1 ? publicSummary(captured) : null;
      if (!summary || !Number.isSafeInteger(exitCode)) return failure('INCOMPLETE', 'BACKUP_HTTP_RESULT_INVALID', 503);
      if (!enabled && exitCode === 0 && ['BLOCKED', 'READY_FOR_EXPLICIT_EXECUTION'].includes(summary.status)) {
        return respond({ ...summary, enabled: false, mode: 'PLAN_ONLY_NO_REMOTE_IO', code: summary.status === 'BLOCKED' ? 'BACKUP_PLAN_BLOCKED' : 'BACKUP_PLAN_READY' }, 200);
      }
      if (enabled && exitCode === 0 && summary.status === 'FULL') {
        return respond({ ...summary, enabled: true, mode: 'EXECUTE', code: 'BACKUP_FULL' }, 200);
      }
      if (summary.status === 'BLOCKED') return unavailable({ ...summary, enabled, code: 'BACKUP_EXECUTION_BLOCKED' }, 503);
      if (summary.status === 'INCOMPLETE') return unavailable({ ...summary, enabled, code: 'BACKUP_INCOMPLETE' }, 503);
      return failure('INCOMPLETE', 'BACKUP_HTTP_RESULT_INVALID', 503);
    } catch {
      return failure('INCOMPLETE', 'BACKUP_HTTP_RUNNER_FAILED', 503);
    }
  };
}
