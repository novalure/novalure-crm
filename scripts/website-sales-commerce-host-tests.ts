import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { readCommerceHostConfiguration, authorizeCommerceWorkerRequest, runConfiguredCommerceWorker, runCommerceProfileSequence } from '../src/lib/website-sales-commerce-host';
import { CrmCommandError } from '../src/lib/crm-command';

function fixture() {
  const identity = { workspaceId: randomUUID(), projectId: randomUUID(), companyId: randomUUID(), locationId: randomUUID() };
  const profile = { id: randomUUID(), identity, workflowId: randomUUID(), actorId: randomUUID(), workloadId: randomUUID(), dispatchGrantId: randomUUID(),
    sourceGrantId: randomUUID(), allowedKinds: ['OFFER_SEND'], validUntil: new Date(Date.now() + 60_000).toISOString(), accounts: { resend: 'synthetic-account', docuseal: '' } };
  const config = { contractVersion: 'website-sales-commerce-host-v1', enabled: true, environment: 'production', revision: 'a'.repeat(40),
    databaseHostDigest: createHash('sha256').update('synthetic.neon.tech').digest('hex'), sender: 'sales@novalure.eu',
    htmlSignatureCapabilityApproved: false, maxJobsPerRun: 2, profiles: [profile], sourceConnections: [] as unknown[] };
  const env = { VERCEL: '1', VERCEL_PROJECT_ID: 'prj_R32Okl6AHijTohvuKmryuTLjWMsk', VERCEL_ENV: 'production', VERCEL_GIT_COMMIT_SHA: config.revision };
  const read = (value: unknown = config, patch: Record<string, string | undefined> = {}) => readCommerceHostConfiguration({ ...env, ...patch, NODE_ENV: 'test', CRM_WEBSITE_SALES_COMMERCE_HOST: JSON.stringify(value) });
  return { config, env, read, profile, identity };
}

test('host configuration binds the actual deployment project environment revision and unique fixed resource profiles', () => {
  const f = fixture(); assert.equal(f.read()?.profiles[0]?.workflowId, f.profile.workflowId);
  for (const patch of [{ VERCEL_PROJECT_ID: 'foreign' }, { VERCEL_ENV: 'preview' }, { VERCEL_GIT_COMMIT_SHA: 'b'.repeat(40) }, { VERCEL: '0' }])
    assert.throws(() => f.read(f.config, patch), /HOST_NOT_CONFIGURED/);
  assert.throws(() => f.read({ ...f.config, profiles: [f.profile, { ...f.profile, id: randomUUID() }] }), /HOST_NOT_CONFIGURED/);
  assert.throws(() => f.read({ ...f.config, profiles: [{ ...f.profile, identity: { ...f.identity, locationId: null } }] }), /HOST_NOT_CONFIGURED/);
  assert.equal(f.read({ ...f.config, enabled: false }), null);
  assert.throws(() => f.read({ ...f.config, environment: 'preview' }), /HOST_NOT_CONFIGURED/);
  assert.equal(readCommerceHostConfiguration({ NODE_ENV: 'test' }), null);
});

test('registered source accounts cannot choose another profile workflow or tenant through configuration', () => {
  const f = fixture(), connection = { connectionId: randomUUID(), profileId: f.profile.id, enabled: true, provider: 'synthetic', accountReference: 'synthetic-book',
    identity: f.identity, workflowId: f.profile.workflowId, validUntil: f.profile.validUntil, allowedSystems: ['ACCOUNTING'], allowedKinds: ['INVOICE'] };
  assert.equal(f.read({ ...f.config, sourceConnections: [connection] })?.sourceConnections.length, 1);
  for (const change of [{ profileId: randomUUID() }, { workflowId: randomUUID() }, { identity: { ...f.identity, companyId: randomUUID() } }])
    assert.throws(() => f.read({ ...f.config, sourceConnections: [{ ...connection, ...change }] }), /HOST_NOT_CONFIGURED/);
  assert.throws(() => f.read({ ...f.config, sourceConnections: [connection, connection] }), /HOST_NOT_CONFIGURED/);
});

test('worker authorization requires its own strong exact bearer and never accepts ordinary browser state', () => {
  const secret = 'synthetic-only-worker-secret-'.repeat(2);
  assert.doesNotThrow(() => authorizeCommerceWorkerRequest(new Request('https://example.invalid', { headers: { authorization: `Bearer ${secret}` } }), secret));
  const variants: Record<string, string>[] = [{}, { cookie: 'novalure_session=synthetic' }, { authorization: 'Bearer wrong' }, { authorization: `Bearer  ${secret}` }];
  for (const headers of variants)
    assert.throws(() => authorizeCommerceWorkerRequest(new Request('https://example.invalid', { headers }), secret), /UNAUTHORIZED/);
  assert.throws(() => authorizeCommerceWorkerRequest(new Request('https://example.invalid', { headers: { authorization: 'Bearer short' } }), 'short'), /UNAUTHORIZED/);
});

test('the existing global pause stops authenticated scheduled work before a database claim or provider call', async () => {
  const keys = ['NOVALURE_WORKERS_PAUSED', 'CRM_WEBSITE_SALES_COMMERCE_WORKER_SECRET'] as const;
  const before = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  try {
    process.env.NOVALURE_WORKERS_PAUSED = '1'; process.env.CRM_WEBSITE_SALES_COMMERCE_WORKER_SECRET = 'synthetic-worker-pause-secret-only-'.repeat(2);
    const request = new Request('https://example.invalid/api/cron/website-sales-commerce', { headers: {
      authorization: `Bearer ${process.env.CRM_WEBSITE_SALES_COMMERCE_WORKER_SECRET}` } });
    const result = await runConfiguredCommerceWorker(request); assert.equal(result.status, 'PAUSED'); assert.deepEqual(result.results, []);
    await assert.rejects(runConfiguredCommerceWorker(new Request(request.url)), /UNAUTHORIZED/);
  } finally { for (const key of keys) { if (before[key] === undefined) delete process.env[key]; else process.env[key] = before[key]; } }
});

test('a stopped recipient remains blocked while an unrelated profile proceeds, and technical faults still abort', async () => {
  const validUntil = new Date(Date.now() + 60000).toISOString(); let unrelatedCalls = 0;
  const next = { id: randomUUID(), validUntil, run: async () => { unrelatedCalls++; return { results: [], externalEffectsOnlyFromClaimedJobs: true as const }; } };
  const results = await runCommerceProfileSequence([{ id: randomUUID(), validUntil, run: async () => { throw new CrmCommandError('OPT_OUT', 'Synthetic recipient stopped', 409); } }, next]);
  assert.equal(results[0]?.status, 'BLOCKED'); assert.equal(results[0]?.code, 'OPT_OUT'); assert.equal(unrelatedCalls, 1);
  await assert.rejects(runCommerceProfileSequence([{ id: randomUUID(), validUntil, run: async () => { throw Error('Synthetic database unavailable'); } }, next]), /database unavailable/);
  assert.equal(unrelatedCalls, 1);
});
