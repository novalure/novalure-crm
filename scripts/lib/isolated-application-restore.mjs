import assert from 'node:assert/strict';

// Recovery never calls a provider restore/finalize endpoint. In particular,
// finalize restores can move an existing production compute to another branch.
export const isolatedRecoveryTarget = Object.freeze({
  projectId: 'misty-cloud-70835427',
  branchId: 'br-orange-brook-al5f6n0f',
  endpointId: 'ep-raspy-union-al4lz6jx',
  host: 'ep-raspy-union-al4lz6jx.c-3.eu-central-1.aws.neon.tech',
  database: 'crm_app_restore_20261102',
  webHost: '127.0.0.1',
});

export function assertIsolatedRestoreTarget(binding) {
  assert.deepEqual(binding, isolatedRecoveryTarget, 'EXACT_EXISTING_ISOLATED_RESTORE_TARGET_REQUIRED');
  return binding;
}

export function assertIsolatedConnectedDatabase(binding, actual) {
  assertIsolatedRestoreTarget(binding);
  assert.equal(actual.projectId, binding.projectId, 'RESTORE_DATABASE_PROJECT_MISMATCH');
  assert.equal(actual.branchId, binding.branchId, 'RESTORE_DATABASE_BRANCH_MISMATCH');
  assert.equal(actual.database, binding.database, 'RESTORE_DATABASE_NAME_MISMATCH');
  assert.equal(actual.role, 'crm_restore_runtime_20261102', 'RESTORE_RUNTIME_ROLE_REQUIRED');
  for (const field of ['superuser', 'bypassRls', 'createDb', 'createRole', 'replication']) {
    assert.equal(actual[field], false, 'RESTORE_RUNTIME_PRIVILEGE_DENIED');
  }
}

/** Pure, fail-closed capability check; it runs BEFORE any native request. */
export function assertRestoreProviderRequest({ provider, method, path, body }, originalEndpoint) {
  if (provider === 'vercel') {
    // No deployment/create/promote/alias/domain/env mutation is reachable.
    assert.equal(method, 'GET', 'RESTORE_HAS_NO_VERCEL_MUTATION_CAPABILITY');
    assert.equal(body, undefined, 'READ_BODY_DENIED');
    assert.match(path, /^\/(?:v[0-9]+)\/(?:projects|aliases|deployments)(?:\/|\?)/);
    assert.ok(!path.includes('://'), 'ABSOLUTE_PROVIDER_URL_DENIED');
    return;
  }
  assert.equal(provider, 'neon', 'UNKNOWN_RESTORE_PROVIDER');
  assert.ok(!path.includes('?') && !path.includes('://'), 'EXACT_NATIVE_PATH_REQUIRED');
  const base = `/projects/${isolatedRecoveryTarget.projectId}/endpoints/${isolatedRecoveryTarget.endpointId}`;
  if (method === 'GET') {
    assert.equal(path, base, 'ONLY_PINNED_COMPUTE_READ_ALLOWED');
    assert.equal(body, undefined, 'READ_BODY_DENIED');
    return;
  }
  assert.equal(method, 'PATCH', 'RESTORE_ENDPOINT_REASSIGNMENT_OR_RESTORE_API_DENIED');
  assert.equal(path, base, 'ONLY_EXISTING_ISOLATED_COMPUTE_CAN_CHANGE');
  if (body?.endpoint?.disabled === true) {
    assert.deepEqual(body, { endpoint: { disabled: true } }, 'ONLY_EXACT_CLEANUP_INVERSE_ALLOWED');
    assert.equal(originalEndpoint?.id, isolatedRecoveryTarget.endpointId);
    assert.equal(originalEndpoint?.branch_id, isolatedRecoveryTarget.branchId);
    assert.equal(originalEndpoint?.host, isolatedRecoveryTarget.host);
    assert.equal(originalEndpoint?.disabled, true, 'CLEANUP_REQUIRES_OBSERVED_ORIGINAL_DISABLED_STATE');
  } else assert.deepEqual(body, { endpoint: { disabled: false, autoscaling_limit_min_cu: 0.25, autoscaling_limit_max_cu: 0.25 } },
    'ONLY_BOUNDED_ISOLATED_COMPUTE_ENABLE_ALLOWED');
}

const forbiddenWorkerKey = /(?:VERCEL|NEON_API|AZURE|MICROSOFT|RESEND|GATEWAY|OPENAI|PUBLISHER|CRON_SECRET|BLOB.*TOKEN)/i;
export function assertRecoveryWorkerEnvironment(env, databaseUrl) {
  assert.equal(env.NOVALURE_AUTH_STRICT, '1', 'RESTORE_AUTH_MUST_REMAIN_STRICT');
  assert.ok(env.NOVALURE_DEMO_AUTH_ENABLED !== '1' && env.NOVALURE_TRUST_AUTH_HEADERS !== '1', 'RESTORE_AUTH_BYPASS_DENIED');
  assert.equal(env.NOVALURE_WORKERS_PAUSED, '1', 'RESTORE_WORKERS_MUST_BE_PAUSED');
  assert.ok(env.NOVALURE_SHARED_LEARNING_ENABLED !== '1', 'RESTORE_AUTOMATIC_LEARNING_DENIED');
  assert.ok(Object.keys(env).every(key => !forbiddenWorkerKey.test(key)), 'PROVIDER_CONTROL_OR_SIDE_EFFECT_CREDENTIAL_IN_WORKER');
  const allowed = new Set(['NODE_ENV', 'NODE_USE_SYSTEM_CA', 'DATABASE_URL', 'NOVALURE_APP_ORIGIN', 'NOVALURE_AUTH_STRICT',
    'NOVALURE_WORKERS_PAUSED', 'NOVALURE_SHARED_LEARNING_ENABLED', 'NOVALURE_DEMO_AUTH_ENABLED', 'NOVALURE_TRUST_AUTH_HEADERS',
    'NOVALURE_AUTH_ENCRYPTION_KEY', 'NOVALURE_AUTH_RATE_LIMIT_SECRET', 'NOVALURE_SESSION_SECRET', 'NOVALURE_MEDIA_ROOT']);
  assert.ok(Object.keys(env).every(key => allowed.has(key) || /^(?:PATH|SystemRoot|WINDIR|TEMP|TMP|LOCALAPPDATA|APPDATA|USERPROFILE|COMSPEC|PATHEXT)$/i.test(key)), 'UNEXPECTED_WORKER_ENVIRONMENT_KEY');
  assert.equal(env.DATABASE_URL, databaseUrl, 'WORKER_DATABASE_URL_MISMATCH');
  const url = new URL(databaseUrl);
  assert.ok(['postgres:', 'postgresql:'].includes(url.protocol));
  assert.equal(url.hostname, isolatedRecoveryTarget.host);
  assert.equal(url.pathname, '/' + isolatedRecoveryTarget.database);
  assert.equal(decodeURIComponent(url.username), 'crm_restore_runtime_20261102');
  // pg-connection-string accepts query host/user/ssl overrides. Reject all
  // options before any driver sees the URL, rather than checking URL.hostname alone.
  assert.ok(url.password && !url.hash && !url.search && !url.port, 'SCOPED_RUNTIME_CREDENTIAL_WITHOUT_OVERRIDES_REQUIRED');
  assert.equal(new URL(env.NOVALURE_APP_ORIGIN).hostname, isolatedRecoveryTarget.webHost, 'LOOPBACK_APPLICATION_ORIGIN_REQUIRED');
}
