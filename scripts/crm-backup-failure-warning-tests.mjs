import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';
import { backupFailureClasses, classifyCrmBackupFailure, createCrmBackupFailureEvent,
  crmBackupFailureEventId, createCrmBackupFailureNotifier } from './lib/crm-backup-failure-warning.mjs';
import { createCrmBackupHttpHandler } from './lib/crm-full-backup-http.mjs';
import { defaultCrmBackupConfig as binding } from './lib/crm-full-backup.mjs';

const endpoint = 'https://evelyn-canary.novalure.eu/api/ops/backup-failure';
const now = Date.parse('2026-11-03T12:00:00.000Z');
const runId = '11111111-1111-4111-8111-111111111111';
const key = '1'.repeat(64); // synthetic; grants no access
const env = Object.freeze({ VERCEL_ENV: 'production', VERCEL_PROJECT_ID: binding.backupProjectId,
  VERCEL_TEAM_ID: binding.teamId, CRM_BACKUP_WARNING_ENABLED: 'true', CRM_BACKUP_WARNING_HMAC_KEY: key,
  CRM_FULL_BACKUP_ENABLED: 'true', CRON_SECRET: 'SYNTHETIC_CRON_SECRET_WITH_AT_LEAST_THIRTY_TWO_BYTES' });
const event = () => createCrmBackupFailureEvent({ runId, failureClass: 'PROVIDER_UNAVAILABLE', occurredAt: new Date(now).toISOString() });
const incoming = () => new Request('https://synthetic-backup.example.invalid/api/backup', { headers: { authorization: `Bearer ${env.CRON_SECRET}` } });
const receipt = input => Response.json({ status: 'DELIVERED', eventId: input.eventId, receiptSha256: 'a'.repeat(64) });
function oidc(claimPatch = {}) {
  const claims = { iss: `https://oidc.vercel.com/${binding.teamSlug}`, aud: `https://vercel.com/${binding.teamSlug}`,
    sub: `owner:${binding.teamSlug}:project:synthetic-backup:environment:production`, project_id: binding.backupProjectId,
    owner_id: binding.teamId, environment: 'production', iat: now / 1000 - 30, exp: now / 1000 + 3600, ...claimPatch };
  return [JSON.stringify({ alg: 'RS256', kid: 'synthetic' }), JSON.stringify(claims), 'synthetic-signature']
    .map(part => Buffer.from(part).toString('base64url')).join('.');
}
const tokenContext = () => ({ productionOidcToken: oidc() });

test('failure classification emits only eight fixed classes; raw errors cannot enter envelopes', () => {
  const cases = {
    BLOCKED_NEON_API_KEY_REQUIRED: 'CREDENTIALS_UNAVAILABLE', BLOCKED_PRODUCTION_OIDC_REQUIRED: 'CREDENTIALS_UNAVAILABLE',
    NEON_HTTP_401: 'CREDENTIALS_UNAVAILABLE', NEON_HTTP_403: 'CREDENTIALS_UNAVAILABLE',
    NEON_HTTP_422: 'BACKUP_EXECUTION_FAILED', NEON_HTTP_404: 'BACKUP_EXECUTION_FAILED',
    NEON_HTTP_429: 'PROVIDER_UNAVAILABLE', NEON_HTTP_503: 'PROVIDER_UNAVAILABLE',
    PRODUCTION_BRANCH_BINDING_CHANGED: 'PRODUCTION_BINDING_CHANGED', PRODUCTION_ENDPOINT_BINDING_CHANGED: 'PRODUCTION_BINDING_CHANGED',
    PRODUCTION_BINDING_CHANGED: 'PRODUCTION_BINDING_CHANGED', BACKUP_SNAPSHOT_ALREADY_CLAIMED: 'SNAPSHOT_ALREADY_CLAIMED',
    SNAPSHOT_SOURCE_BINDING_MISMATCH: 'SNAPSHOT_UNAVAILABLE', PRIVATE_FILE_SIZE_MISMATCH: 'DATA_INTEGRITY_FAILED',
    SOURCE_SNAPSHOT_REQUIRED: 'SNAPSHOT_UNAVAILABLE', BLOB_OBJECT_STORE_MISMATCH: 'DATA_INTEGRITY_FAILED',
    PRIVATE_ARCHIVE_HASH_MISMATCH: 'DATA_INTEGRITY_FAILED', SOURCE_FILE_HASH_MISMATCH: 'DATA_INTEGRITY_FAILED',
    MISSING_HISTORICAL_ASSET_REFERENCE: 'DATA_INTEGRITY_FAILED', FULL_DATABASE_FINGERPRINT_REQUIRED: 'DATA_INTEGRITY_FAILED',
    ISOLATED_COMPUTE_CLEANUP_UNCONFIRMED: 'CLEANUP_UNCONFIRMED', ISOLATED_CLEANUP_ENDPOINTS_UNCONFIRMED: 'CLEANUP_UNCONFIRMED',
    RESTORE_CLEANUP_UNCONFIRMED: 'CLEANUP_UNCONFIRMED',
    NEON_REQUEST_FAILED: 'PROVIDER_UNAVAILABLE', BLOB_REQUEST_FAILED: 'PROVIDER_UNAVAILABLE',
    BACKUP_HTTP_RESULT_INVALID: 'BACKUP_EXECUTION_FAILED', BACKUP_CONFIGURATION_OR_IO_FAILED: 'BACKUP_EXECUTION_FAILED',
  };
  for (const [code, expected] of Object.entries(cases)) assert.equal(classifyCrmBackupFailure(code), expected);
  for (const value of [null, {}, new Error('SYNTHETIC_PRIVATE_ERROR'), 'postgresql://private.invalid', 'SYNTHETIC_PRIVATE_VALUE']) {
    assert.equal(classifyCrmBackupFailure(value), 'BACKUP_EXECUTION_FAILED');
  }
  assert.equal(backupFailureClasses.length, 8);
});

test('event identity is deterministic per actual run and failure class, with no provider or document detail', () => {
  for (const failureClass of backupFailureClasses) {
    const first = createCrmBackupFailureEvent({ runId, failureClass, occurredAt: new Date(now).toISOString() });
    const later = createCrmBackupFailureEvent({ runId, failureClass, occurredAt: new Date(now + 1).toISOString() });
    assert.equal(first.eventId, later.eventId);
    assert.deepEqual(Object.keys(first), ['schemaVersion', 'source', 'environment', 'eventId', 'runId', 'failureClass', 'occurredAt']);
    assert.equal(first.eventId, crmBackupFailureEventId(runId, failureClass));
  }
  for (const input of [{ runId: 'backup-private-path', failureClass: 'PROVIDER_UNAVAILABLE' },
    { runId, failureClass: 'SYNTHETIC_PRIVATE_VALUE' }, { runId, failureClass: 'PROVIDER_UNAVAILABLE', occurredAt: 'tomorrow' }]) {
    assert.throws(() => createCrmBackupFailureEvent({ occurredAt: new Date(now).toISOString(), ...input }), /BACKUP_WARNING_ENVELOPE_INVALID/u);
  }
});

test('one signed metadata POST binds exact body, timestamp, fixed destination and dedicated secret', async () => {
  const calls = [];
  const notify = createCrmBackupFailureNotifier({ env, endpoint, now: () => now, request: async (url, init) => {
    calls.push({ url, init });
    return receipt(JSON.parse(init.body));
  } });
  assert.deepEqual(calls, [], 'construction does no I/O');
  const result = await notify(event(), tokenContext());
  assert.equal(result.status, 'DELIVERED');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, endpoint);
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.redirect, 'error');
  assert.equal(calls[0].init.headers['x-novalure-backup-timestamp'], new Date(now).toISOString());
  assert.equal(calls[0].init.headers['x-novalure-backup-signature'], createHmac('sha256', Buffer.from(key, 'hex')).update(new Date(now).toISOString() + '.' + calls[0].init.body).digest('hex'));
  assert.equal(calls[0].init.body.includes(key), false);
  assert.equal(calls[0].init.body.includes(env.CRON_SECRET), false);
  assert.equal(calls[0].init.headers.authorization, undefined);
  assert.equal(calls[0].init.headers['x-vercel-trusted-oidc-idp-token'], oidc());
  assert.equal(calls[0].init.body.includes(oidc()), false);
});

test('missing activation, wrong project/team/origin or malformed secret never sends', async () => {
  for (const changed of [{ CRM_BACKUP_WARNING_ENABLED: undefined }, { CRM_BACKUP_WARNING_ENABLED: 'TRUE' },
    { CRM_BACKUP_WARNING_HMAC_KEY: undefined }, { CRM_BACKUP_WARNING_HMAC_KEY: 'short' }, { VERCEL_ENV: 'preview' },
    { VERCEL_TARGET_ENV: 'preview' }, { VERCEL_PROJECT_ID: 'prj_foreign' }, { VERCEL_TEAM_ID: 'team_foreign' },
    { VERCEL_ORG_ID: 'team_foreign' }]) {
    let calls = 0;
    const result = await createCrmBackupFailureNotifier({ env: { ...env, ...changed }, endpoint, now: () => now,
      request: async () => { calls++; throw new Error('NO_SEND_EXPECTED'); } })(event(), tokenContext());
    assert.deepEqual(result, { status: 'ALARM_UNCONFIRMED' });
    assert.equal(calls, 0);
  }
  for (const destination of [null, 'http://evelyn-canary.novalure.eu/api/ops/backup-failure',
    'https://foreign.invalid/api/ops/backup-failure', endpoint + '?token=SYNTHETIC', endpoint + '#fragment',
    'https://evelyn-canary.novalure.eu:443/api/ops/backup-failure', 'https://evelyn.novalure.eu/api/ops/backup-failure']) {
    let calls = 0;
    await createCrmBackupFailureNotifier({ env, endpoint: destination, now: () => now, request: async () => { calls++; } })(event(), tokenContext());
    assert.equal(calls, 0);
  }
});

test('stale, forged or expanded event never sends', async () => {
  for (const input of [null, { ...event(), eventId: '11111111-1111-4111-8111-111111111111' },
    { ...event(), message: 'SYNTHETIC_PRIVATE_VALUE' }, { ...event(), source: 'foreign' },
    { ...event(), environment: 'development' }, createCrmBackupFailureEvent({ runId,
      failureClass: 'PROVIDER_UNAVAILABLE', occurredAt: new Date(now - 300_001).toISOString() })]) {
    let calls = 0;
    const result = await createCrmBackupFailureNotifier({ env, endpoint, now: () => now, request: async () => { calls++; } })(input, tokenContext());
    assert.deepEqual(result, { status: 'ALARM_UNCONFIRMED' });
    assert.equal(calls, 0);
  }
});

test('unknown provider outcomes or forged acknowledgments stay unconfirmed and never retry', async () => {
  const attempts = [
    async () => { throw new Error('SYNTHETIC_PRIVATE_TRANSPORT_ERROR'); },
    async () => new Response('', { status: 503 }),
    async () => Response.json({ status: 'ACCEPTED', eventId: event().eventId, receiptSha256: null }),
    async () => Response.json({ status: 'UNKNOWN', eventId: event().eventId, receiptSha256: null }),
    async () => Response.json({ status: 'DELIVERED', eventId: runId, receiptSha256: 'a'.repeat(64) }),
    async () => Response.json({ status: 'DELIVERED', eventId: event().eventId, receiptSha256: null }),
    async () => Response.json({ status: 'DELIVERED', eventId: event().eventId, receiptSha256: 'a'.repeat(64), extra: 'PRIVATE' }),
    async () => new Response('x'.repeat(1025)),
  ];
  for (const send of attempts) {
    let calls = 0;
    const result = await createCrmBackupFailureNotifier({ env, endpoint, now: () => now,
      request: async (...args) => { calls++; return send(...args); } })(event(), tokenContext());
    assert.deepEqual(result, { status: 'ALARM_UNCONFIRMED' });
    assert.equal(calls, 1);
  }
});

test('one nonsettling transport is bounded at five seconds and not retried', async () => {
  let calls = 0;
  const started = performance.now();
  const result = await createCrmBackupFailureNotifier({ env, endpoint, now: () => now,
    request: async () => { calls++; return new Promise(() => {}); } })(event(), tokenContext());
  assert.equal(result.status, 'ALARM_UNCONFIRMED');
  assert.equal(calls, 1);
  assert.ok(performance.now() - started >= 4_900);
  assert.ok(performance.now() - started < 10_000);
});

test('backup failure remains HTTP503 and original code even when notification is confirmed or unknown', async () => {
  for (const notifyFailure of [async input => ({ status: 'DELIVERED', eventId: input.eventId, receiptSha256: 'a'.repeat(64) }),
    async () => ({ status: 'ALARM_UNCONFIRMED' }), async () => { throw new Error('SYNTHETIC_PRIVATE_ERROR'); }]) {
    const captured = [], logs = [];
    const handler = createCrmBackupHttpHandler({ env, createRunId: () => runId, now: () => now, getOidcToken: () => undefined,
      notifyFailure: async input => { captured.push(input); return notifyFailure(input); }, log: input => logs.push(input),
      run: async (argv, _env, output) => { assert.deepEqual(argv, ['--execute', '--backup-id', `backup-${runId}`]);
        output({ status: 'INCOMPLETE', code: 'NEON_HTTP_401' }); return 1; } });
    const response = await handler(incoming());
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.equal(body.failureCode, 'NEON_HTTP_401');
    assert.equal(body.code, 'BACKUP_INCOMPLETE');
    assert.ok(['DELIVERED', 'ALARM_UNCONFIRMED'].includes(body.alarmStatus));
    assert.equal(captured.length, 1);
    assert.equal(captured[0].failureClass, 'CREDENTIALS_UNAVAILABLE');
    assert.equal(JSON.stringify(logs).includes('SYNTHETIC_PRIVATE_ERROR'), false);
  }
});

test('unauthorized, invalid workload, plan and valid FULL never trigger an alarm', async () => {
  for (const [actualEnv, req, output, exitCode] of [
    [env, new Request('https://synthetic-backup.example.invalid/api/backup'), null, 1],
    [{ ...env, VERCEL_PROJECT_ID: 'prj_foreign' }, incoming(), null, 1],
    [{ ...env, CRM_FULL_BACKUP_ENABLED: 'false' }, incoming(), { status: 'BLOCKED' }, 0],
    [env, incoming(), { status: 'FULL' }, 0],
  ]) {
    let alarms = 0;
    const handler = createCrmBackupHttpHandler({ env: actualEnv, createRunId: () => runId, now: () => now, getOidcToken: () => undefined,
      notifyFailure: async () => { alarms++; }, log: () => {},
      run: async (_argv, _env, capture) => { capture(output); return exitCode; } });
    await handler(req);
    assert.equal(alarms, 0);
  }
});

test('the real enabled CLI reports missing credentials to the bridge before any provider request', async () => {
  const originalFetch = globalThis.fetch, warnings = [];
  let providerRequests = 0;
  globalThis.fetch = async () => { providerRequests++; throw new Error('A missing-credential run must not contact providers'); };
  try {
    const handler = createCrmBackupHttpHandler({ env, createRunId: () => runId, now: () => now, getOidcToken: () => undefined,
      log: () => {}, notifyFailure: async input => { warnings.push(input); return { status: 'ALARM_UNCONFIRMED' }; } });
    const response = await handler(incoming());
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.equal(body.status, 'BLOCKED');
    assert.equal(body.code, 'BACKUP_EXECUTION_BLOCKED');
    assert.equal(body.alarmStatus, 'ALARM_UNCONFIRMED');
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].failureClass, 'CREDENTIALS_UNAVAILABLE');
    assert.equal(providerRequests, 0);
  } finally { globalThis.fetch = originalFetch; }
});

test('hosting admission forwards only a fresh exact backup-production OIDC identity and never an env fallback', async () => {
  const invalid = [undefined, '', 'SYNTHETIC_PRIVATE_TOKEN', oidc({ project_id: 'prj_foreign' }), oidc({ owner_id: 'team_foreign' }),
    oidc({ environment: 'development' }), oidc({ iss: 'https://untrusted.invalid' }), oidc({ aud: 'foreign' }),
    oidc({ sub: 'owner:novalure:project:synthetic:environment:preview' }), oidc({ exp: now / 1000 + 30 }),
    oidc({ iat: now / 1000 + 1 }), oidc({ nbf: now / 1000 + 1 })];
  for (const productionOidcToken of invalid) {
    let calls = 0;
    const notify = createCrmBackupFailureNotifier({ env: { ...env, VERCEL_OIDC_TOKEN: oidc() }, endpoint, now: () => now,
      request: async () => { calls++; } });
    assert.deepEqual(await notify(event(), { productionOidcToken }), { status: 'ALARM_UNCONFIRMED' });
    assert.equal(calls, 0);
  }
});

test('HTTP hands the same invocation-native OIDC only to the fixed notifier, and redacts all response/logs', async () => {
  for (const native of [oidc(), undefined]) {
    const calls = [], logs = [];
    const handler = createCrmBackupHttpHandler({ env: { ...env, VERCEL_OIDC_TOKEN: 'SYNTHETIC_OLDER_ENV_TOKEN_MUST_NOT_FORWARD' },
      createRunId: () => runId, now: () => now, getOidcToken: () => native,
      log: value => logs.push(value), notifyFailure: async (input, context) => { calls.push({ input, context }); return { status: 'ALARM_UNCONFIRMED' }; },
      run: async (_argv, _env, capture) => { capture({ status: 'INCOMPLETE', code: 'NEON_HTTP_422' }); return 1; } });
    const response = await handler(incoming());
    const body = await response.json();
    assert.equal(response.status, 503);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].context.productionOidcToken, native);
    assert.equal(calls[0].input.failureClass, 'BACKUP_EXECUTION_FAILED');
    for (const text of [JSON.stringify(body), JSON.stringify(logs)]) {
      assert.equal(text.includes(oidc()), false);
      assert.equal(text.includes('SYNTHETIC_OLDER_ENV_TOKEN_MUST_NOT_FORWARD'), false);
    }
  }
});
