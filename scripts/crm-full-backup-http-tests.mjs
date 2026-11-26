import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCrmBackupHttpHandler } from './lib/crm-full-backup-http.mjs';
import { defaultCrmBackupConfig } from './lib/crm-full-backup.mjs';

const cronSecret = 'SYNTHETIC_CRON_SECRET_WITH_AT_LEAST_THIRTY_TWO_BYTES';
const workload = Object.freeze({
  CRON_SECRET: cronSecret,
  VERCEL_ENV: 'production',
  VERCEL_PROJECT_ID: defaultCrmBackupConfig.backupProjectId,
  VERCEL_TEAM_ID: defaultCrmBackupConfig.teamId,
});
const request = ({ method = 'GET', authorization = `Bearer ${cronSecret}`, query = '' } = {}) => new Request(`https://synthetic-backup.example.invalid/api/cron/full-backup${query}`, {
  method,
  headers: authorization === null ? {} : { authorization },
});
function fixture({ env = workload, output = { status: 'BLOCKED', code: 'BLOCKED_NEON_API_KEY_REQUIRED' }, exitCode = 0, run } = {}) {
  const calls = [], logs = [];
  const handler = createCrmBackupHttpHandler({ env,
    run: run ?? (async (argv, actualEnv, capture) => { calls.push({ argv, env: actualEnv }); capture(output); return exitCode; }),
    log: payload => logs.push(payload),
  });
  return { handler, calls, logs };
}
function privateHeaders(response) {
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
}
function safeLogs(logs) {
  for (const payload of logs) {
    assert.equal(payload !== null && typeof payload === 'object' && !Array.isArray(payload), true);
    assert.equal(Object.keys(payload).every(key => ['status', 'code', 'failureCode'].includes(key)), true);
    if (payload.failureCode !== undefined) assert.match(payload.failureCode, /^[A-Z][A-Z0-9_]{1,100}$/u);
    assert.equal(JSON.stringify(payload).includes(cronSecret), false);
  }
}

test('backup HTTP handler construction performs no execution or logging', () => {
  const f = fixture();
  assert.equal(typeof f.handler, 'function');
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.logs, []);
});

test('backup HTTP handler accepts only GET', async () => {
  const f = fixture();
  for (const method of ['POST', 'PUT', 'DELETE', 'HEAD', 'OPTIONS']) {
    const response = await f.handler(request({ method, authorization: null }));
    assert.equal(response.status, 405);
    assert.equal(response.headers.get('allow'), 'GET');
    privateHeaders(response);
  }
  assert.deepEqual(f.calls, []);
  safeLogs(f.logs);
});

test('missing, malformed or wrong cron authorization never invokes the runner', async () => {
  const f = fixture();
  for (const authorization of [null, '', cronSecret, `Basic ${cronSecret}`, `Bearer ${cronSecret}x`, `bearer ${cronSecret}`]) {
    const response = await f.handler(request({ authorization }));
    assert.equal(response.status, 401);
    privateHeaders(response);
  }
  assert.deepEqual(f.calls, []);
  safeLogs(f.logs);
});

test('an absent or short configured cron secret cannot authorize execution', async () => {
  for (const secret of [undefined, '', 'x'.repeat(31)]) {
    const f = fixture({ env: { ...workload, CRON_SECRET: secret } });
    const response = await f.handler(request({ authorization: `Bearer ${secret ?? ''}` }));
    assert.equal(response.status, 401);
    assert.deepEqual(f.calls, []);
    privateHeaders(response);
  }
});

test('request query selectors are rejected before the runner', async () => {
  const f = fixture();
  for (const query of ['?snapshot=snap-untrusted', '?workspaceId=untrusted', '?execute=true', '?snapshot=a&snapshot=b']) {
    const response = await f.handler(request({ query }));
    assert.equal(response.status, 400);
    privateHeaders(response);
  }
  assert.deepEqual(f.calls, []);
  safeLogs(f.logs);
});

test('only the exact Production project and team may invoke the backup runner', async () => {
  for (const changed of [
    { VERCEL_ENV: undefined }, { VERCEL_ENV: 'development' }, { VERCEL_ENV: 'preview' },
    { VERCEL_PROJECT_ID: undefined }, { VERCEL_PROJECT_ID: 'prj_foreignProject' },
    { VERCEL_TEAM_ID: undefined }, { VERCEL_TEAM_ID: 'team_foreignTeam' },
  ]) {
    const f = fixture({ env: { ...workload, CRM_FULL_BACKUP_ENABLED: 'true', ...changed } });
    const response = await f.handler(request());
    assert.equal(response.status, 503);
    assert.equal((await response.json()).status, 'BLOCKED');
    assert.deepEqual(f.calls, []);
    privateHeaders(response);
    safeLogs(f.logs);
  }
});

test('execution is disabled by default and every nonexact enable flag invokes plan only', async () => {
  for (const flag of [undefined, '', 'false', '1', 'TRUE', ' true ', true]) {
    const f = fixture({ env: { ...workload, CRM_FULL_BACKUP_ENABLED: flag } });
    const response = await f.handler(request());
    assert.equal(response.status, 200);
    assert.equal(f.calls.length, 1);
    assert.deepEqual(f.calls[0].argv, ['--plan']);
    assert.equal(f.calls[0].env.CRM_FULL_BACKUP_ENABLED, flag);
    privateHeaders(response);
    safeLogs(f.logs);
  }
});

test('plan readiness and missing provider credentials remain successful plan responses', async () => {
  for (const status of ['READY_FOR_EXPLICIT_EXECUTION', 'BLOCKED']) {
    const f = fixture({ output: { status }, exitCode: 0 });
    const response = await f.handler(request());
    assert.equal(response.status, 200);
    assert.equal((await response.json()).status, status);
    assert.deepEqual(f.calls[0].argv, ['--plan']);
    privateHeaders(response);
  }
});

test('only exact enabled execution with a successful FULL result returns HTTP 200', async () => {
  const f = fixture({ env: { ...workload, CRM_FULL_BACKUP_ENABLED: 'true' }, output: { status: 'FULL' }, exitCode: 0 });
  const response = await f.handler(request());
  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, 'FULL');
  assert.deepEqual(f.calls[0].argv, ['--execute']);
  privateHeaders(response);
  safeLogs(f.logs);
});

test('blocked, incomplete and inconsistent execution results are unavailable', async () => {
  for (const [status, exitCode] of [['BLOCKED', 2], ['INCOMPLETE', 1], ['FULL', 1], ['RUNNING', 0], ['READY_FOR_EXPLICIT_EXECUTION', 0]]) {
    const f = fixture({ env: { ...workload, CRM_FULL_BACKUP_ENABLED: 'true' }, output: { status }, exitCode });
    const response = await f.handler(request());
    assert.equal(response.status, 503);
    assert.deepEqual(f.calls[0].argv, ['--execute']);
    privateHeaders(response);
    safeLogs(f.logs);
  }
});

test('unsafe runner output and thrown errors are redacted from response and logs', async () => {
  const sensitive = 'SYNTHETIC_PRIVATE_TOKEN_OR_CONNECTION_STRING_DO_NOT_ECHO';
  const runs = [
    async () => { throw new Error(sensitive); },
    async (_argv, _env, capture) => { capture({ status: 'FULL', token: sensitive }); return 0; },
    async (_argv, _env, capture) => { capture({ status: sensitive, code: sensitive }); return 0; },
    async (_argv, _env, capture) => { capture(sensitive); return 0; },
    async () => 0,
    async (_argv, _env, capture) => { capture({ status: 'FULL' }); capture({ status: 'FULL' }); return 0; },
  ];
  for (const run of runs) {
    const f = fixture({ env: { ...workload, CRM_FULL_BACKUP_ENABLED: 'true' }, run });
    const response = await f.handler(request());
    assert.equal(response.status, 503);
    const body = await response.text();
    assert.equal(body.includes(sensitive), false);
    assert.equal(body.includes(cronSecret), false);
    assert.equal(JSON.stringify(f.logs).includes(sensitive), false);
    safeLogs(f.logs);
    privateHeaders(response);
  }
});

test('the real CLI stays in plan mode with missing provider credentials and performs no fetch', async () => {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  const logs = [];
  globalThis.fetch = async () => { requests++; throw new Error('The default HTTP plan must not request providers'); };
  try {
    const handler = createCrmBackupHttpHandler({ env: { ...workload }, log: payload => logs.push(payload) });
    const response = await handler(request());
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.status, 'BLOCKED');
    assert.equal(requests, 0);
    privateHeaders(response);
    safeLogs(logs);
  } finally { globalThis.fetch = originalFetch; }
});

test('documented team metadata fallbacks allow the exact workload without a VERCEL_TEAM_ID', async () => {
  for (const teamField of ['VERCEL_ORG_ID', 'CRM_BACKUP_TEAM_ID']) {
    const f = fixture({ env: { ...workload, VERCEL_TEAM_ID: undefined, [teamField]: defaultCrmBackupConfig.teamId } });
    const response = await f.handler(request());
    assert.equal(response.status, 200);
    assert.deepEqual(f.calls[0].argv, ['--plan']);
    privateHeaders(response);
    safeLogs(f.logs);
  }
});

test('conflicting present team metadata blocks the workload rather than selecting a favorable fallback', async () => {
  for (const changed of [
    { VERCEL_ORG_ID: 'team_foreignTeam' },
    { CRM_BACKUP_TEAM_ID: 'team_foreignTeam' },
    { VERCEL_TEAM_ID: undefined, VERCEL_ORG_ID: defaultCrmBackupConfig.teamId, CRM_BACKUP_TEAM_ID: 'team_foreignTeam' },
    { VERCEL_TEAM_ID: '', CRM_BACKUP_TEAM_ID: defaultCrmBackupConfig.teamId },
  ]) {
    const f = fixture({ env: { ...workload, ...changed } });
    const response = await f.handler(request());
    assert.equal(response.status, 503);
    assert.deepEqual(f.calls, []);
    privateHeaders(response);
    safeLogs(f.logs);
  }
});

test('current execution-context OIDC reaches only a copied runner environment after authorization', async t => {
  const currentToken = 'SYNTHETIC_CURRENT_CONTEXT_OPAQUE_TOKEN_NO_REAL_ACCESS';
  const oldToken = 'SYNTHETIC_STALE_ENV_OPAQUE_TOKEN_NO_REAL_ACCESS';
  const incomingToken = 'SYNTHETIC_UNTRUSTED_REQUEST_TOKEN_NO_REAL_ACCESS';
  const getterFailure = 'SYNTHETIC_TOKEN_GETTER_FAILURE_MUST_STAY_PRIVATE';
  const processToken = process.env.VERCEL_OIDC_TOKEN;
  const env = Object.freeze({ ...workload, VERCEL_OIDC_TOKEN: oldToken });
  const assertRedacted = async (response, logs) => {
    const text = await response.text(), recorded = JSON.stringify(logs);
    for (const sensitive of [currentToken, oldToken, incomingToken, getterFailure]) {
      assert.equal(text.includes(sensitive), false);
      assert.equal(recorded.includes(sensitive), false);
    }
    privateHeaders(response);
    safeLogs(logs);
  };
  await t.test('trusted context token takes precedence without mutating frozen or process environments', async () => {
    const calls = [], logs = [];
    let gets = 0;
    const handler = createCrmBackupHttpHandler({ env,
      getOidcToken: (...args) => { gets++; assert.deepEqual(args, []); return currentToken; },
      run: async (argv, passedEnv, capture) => { calls.push({ argv, env: passedEnv }); capture({ status: 'BLOCKED' }); return 0; },
      log: value => logs.push(value),
    });
    const incoming = request();
    incoming.headers.set('x-vercel-oidc-token', incomingToken);
    const response = await handler(incoming);
    assert.equal(response.status, 200);
    assert.equal(gets, 1);
    assert.deepEqual(calls[0].argv, ['--plan']);
    assert.notEqual(calls[0].env, env);
    assert.equal(calls[0].env.VERCEL_OIDC_TOKEN, currentToken);
    assert.equal(env.VERCEL_OIDC_TOKEN, oldToken);
    assert.equal(process.env.VERCEL_OIDC_TOKEN, processToken);
    assert.equal(incoming.headers.get('x-vercel-oidc-token'), incomingToken);
    await assertRedacted(response, logs);
  });
  await t.test('throwing or empty context getters fall back to the unchanged environment token', async () => {
    for (const getOidcToken of [() => { throw new Error(getterFailure); }, () => undefined]) {
      let passedEnv;
      const logs = [];
      const handler = createCrmBackupHttpHandler({ env, getOidcToken,
        run: async (_argv, actualEnv, capture) => { passedEnv = actualEnv; capture({ status: 'BLOCKED' }); return 0; },
        log: value => logs.push(value),
      });
      const response = await handler(request());
      assert.equal(response.status, 200);
      assert.notEqual(passedEnv, env);
      assert.equal(passedEnv.VERCEL_OIDC_TOKEN, oldToken);
      assert.equal(env.VERCEL_OIDC_TOKEN, oldToken);
      assert.equal(process.env.VERCEL_OIDC_TOKEN, processToken);
      await assertRedacted(response, logs);
    }
  });
  await t.test('failed authentication or workload binding never asks for a context token', async () => {
    for (const [actualEnv, incoming, expectedStatus] of [
      [env, request({ authorization: 'Bearer SYNTHETIC_WRONG_AUTHORIZATION' }), 401],
      [Object.freeze({ ...env, VERCEL_PROJECT_ID: 'prj_foreignProject' }), request(), 503],
    ]) {
      let gets = 0, runs = 0;
      const logs = [];
      const handler = createCrmBackupHttpHandler({ env: actualEnv,
        getOidcToken: () => { gets++; return currentToken; },
        run: async () => { runs++; return 0; }, log: value => logs.push(value),
      });
      const response = await handler(incoming);
      assert.equal(response.status, expectedStatus);
      assert.equal(gets, 0);
      assert.equal(runs, 0);
      assert.equal(process.env.VERCEL_OIDC_TOKEN, processToken);
      await assertRedacted(response, logs);
    }
  });
});


test('validated CLI failure codes remain visible without exposing unsafe runner output', async t => {
  await t.test('a validated incomplete code is returned alongside the fixed HTTP code', async () => {
    const f = fixture({ env: { ...workload, CRM_FULL_BACKUP_ENABLED: 'true' }, output: { status: 'INCOMPLETE', code: 'NEON_REQUEST_FAILED' }, exitCode: 1 });
    const response = await f.handler(request());
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.equal(body.status, 'INCOMPLETE');
    assert.equal(body.code, 'BACKUP_INCOMPLETE');
    assert.equal(body.failureCode, 'NEON_REQUEST_FAILED');
    for (const record of f.logs) if (record.failureCode !== undefined) assert.equal(record.failureCode, 'NEON_REQUEST_FAILED');
    safeLogs(f.logs);
    privateHeaders(response);
  });
  await t.test('a private URI or unknown secret field yields no exposed failure code', async () => {
    const secret = 'SYNTHETIC_PRIVATE_VALUE_MUST_NOT_LEAK';
    const uri = `postgresql://user:${secret}@private.example.invalid/neondb`;
    for (const output of [
      { status: 'INCOMPLETE', code: uri },
      { status: 'INCOMPLETE', code: 'NEON_REQUEST_FAILED', token: secret },
    ]) {
      const f = fixture({ env: { ...workload, CRM_FULL_BACKUP_ENABLED: 'true' }, output, exitCode: 1 });
      const response = await f.handler(request());
      assert.equal(response.status, 503);
      const body = await response.json();
      assert.equal(body.code, 'BACKUP_HTTP_RESULT_INVALID');
      assert.equal('failureCode' in body, false);
      assert.equal(JSON.stringify(body).includes(secret), false);
      assert.equal(JSON.stringify(body).includes(uri), false);
      assert.equal(JSON.stringify(f.logs).includes(secret), false);
      assert.equal(JSON.stringify(f.logs).includes(uri), false);
      for (const record of f.logs) assert.equal(record.failureCode, undefined);
      safeLogs(f.logs);
      privateHeaders(response);
    }
  });
});
