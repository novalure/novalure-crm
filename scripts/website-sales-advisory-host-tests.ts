import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { readAdvisoryHostConfiguration, authorizeAdvisoryWorkerRequest } from '../src/lib/website-sales-advisory-host';

function fixture() {
  const identity = { workspaceId: randomUUID(), projectId: randomUUID(), companyId: randomUUID(), locationId: randomUUID() };
  const profile = { id: randomUUID(), identity, workflowId: randomUUID(), actorId: randomUUID(), workloadId: randomUUID(), grantId: randomUUID(),
    authorityReference: 'SYNTHETIC saved workload authority', allowedKinds: ['ADVICE', 'TRANSCRIPT_ANALYSIS', 'ROLEPLAY'], validUntil: new Date(Date.now() + 60_000).toISOString() };
  const config = { contractVersion: 'website-sales-advisory-host-v1', enabled: true, hostRuntime: 'VERCEL', environment: 'production', revision: 'a'.repeat(40),
    databaseHostDigest: createHash('sha256').update('synthetic.neon.tech').digest('hex'), maxJobsPerRun: 1, profiles: [profile] };
  const env = { NODE_ENV: 'test' as const, VERCEL: '1', VERCEL_PROJECT_ID: 'prj_R32Okl6AHijTohvuKmryuTLjWMsk', VERCEL_ENV: 'production', VERCEL_GIT_COMMIT_SHA: config.revision };
  const read = (value: unknown = config, patch: Record<string, string | undefined> = {}) => readAdvisoryHostConfiguration('VERCEL', { ...env, ...patch, CRM_WEBSITE_SALES_ADVISORY_HOST: JSON.stringify(value) });
  return { identity, profile, config, read, env };
}
test('advisory model host binds exact deployment identity and rejects duplicate resources or expanded job kinds', () => {
  const f = fixture(); assert.equal(f.read()?.profiles[0].workflowId, f.profile.workflowId);
  for (const patch of [{ VERCEL_PROJECT_ID: 'foreign' }, { VERCEL_ENV: 'preview' }, { VERCEL_GIT_COMMIT_SHA: 'b'.repeat(40) }, { VERCEL: '0' }])
    assert.throws(() => f.read(f.config, patch), { code: 'ADVISORY_HOST_NOT_CONFIGURED' });
  assert.throws(() => f.read({ ...f.config, profiles: [f.profile, { ...f.profile, id: randomUUID() }] }), { code: 'ADVISORY_HOST_NOT_CONFIGURED' });
  assert.throws(() => f.read({ ...f.config, profiles: [{ ...f.profile, allowedKinds: ['VIDEO'] }] }), { code: 'ADVISORY_HOST_NOT_CONFIGURED' });
  assert.throws(() => f.read({ ...f.config, profiles: [{ ...f.profile, allowedKinds: ['ADVICE', 'ADVICE'] }] }), { code: 'ADVISORY_HOST_NOT_CONFIGURED' });
  assert.throws(() => f.read({ ...f.config, profiles: [{ ...f.profile, identity: { ...f.identity, locationId: null } }] }), { code: 'ADVISORY_HOST_NOT_CONFIGURED' });
});
test('absent or disabled configuration grants nothing and Node capture cannot impersonate Vercel', () => {
  const f = fixture(); assert.equal(readAdvisoryHostConfiguration('VERCEL', { NODE_ENV: 'test' }), null);
  assert.equal(f.read({ ...f.config, enabled: false }), null);
  assert.throws(() => f.read({ ...f.config, hostRuntime: 'CHECKED_OUT_NODE' }), { code: 'ADVISORY_HOST_NOT_CONFIGURED' });
  assert.throws(() => readAdvisoryHostConfiguration('CHECKED_OUT_NODE', { ...f.env, CRM_WEBSITE_SALES_ADVISORY_HOST: JSON.stringify({ ...f.config, hostRuntime: 'CHECKED_OUT_NODE' }) }), { code: 'ADVISORY_HOST_NOT_CONFIGURED' });
});
test('worker authorization checks the full current host-only secret and never accepts a short or missing token', () => {
  const secret = 'synthetic-test-only-'.repeat(3), request = (value?: string) => new Request('https://crm.example.invalid/api/cron/website-sales-advisory', { method: 'POST', headers: value ? { authorization: value } : {} });
  authorizeAdvisoryWorkerRequest(request(`Bearer ${secret}`), secret);
  for (const value of [undefined, 'Bearer other', `Bearer ${secret}x`]) assert.throws(() => authorizeAdvisoryWorkerRequest(request(value), secret), { code: 'ADVISORY_WORKER_UNAUTHORIZED' });
  assert.throws(() => authorizeAdvisoryWorkerRequest(request('Bearer short'), 'short'), { code: 'ADVISORY_WORKER_UNAUTHORIZED' });
});
