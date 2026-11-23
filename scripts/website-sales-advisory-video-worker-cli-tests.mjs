import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { parseAdvisoryVideoWorkerArguments, runAdvisoryVideoWorkerCli } from './website-sales-advisory-video-worker-cli.mjs';

test('the standalone CLI accepts only explicit canonical profile and job identifiers', () => {
  const profileId = randomUUID(), jobId = randomUUID();
  assert.deepEqual(parseAdvisoryVideoWorkerArguments(['--job', jobId, '--profile', profileId.toUpperCase()]), { help: false, profileId, jobId });
  for (const args of [[], ['--profile', profileId], ['--profile', profileId, '--profile', jobId], ['--config', 'https://example.invalid/config', '--job', jobId], ['--profile', profileId, '--job', 'not-a-job'], ['--profile', profileId, '--job', jobId, '--force', 'true']]) assert.throws(() => parseAdvisoryVideoWorkerArguments(args));
});
test('invalid arguments and help never load authority, private database or a renderer', async () => {
  let loaded = 0; const load = async () => { loaded++; throw Error('must not load'); };
  const help = await runAdvisoryVideoWorkerCli(['--help'], load); assert.equal(help.exitCode, 0); assert(help.output.includes('--conditions=react-server'));
  await assert.rejects(runAdvisoryVideoWorkerCli(['--job', randomUUID()], load)); assert.equal(loaded, 0);
});
test('one job uses only the real checked-out-node host factory and closes its private pool', async () => {
  const profileId = randomUUID(), jobId = randomUUID(), executor = Object.freeze({ syntheticOpaqueExecutor: true }), calls = [];
  const result = await runAdvisoryVideoWorkerCli(['--profile', profileId, '--job', jobId], async () => ({
    configuredExecutor: async (...args) => { calls.push(args); return executor; },
    runJob: async (cap, id) => { assert.equal(cap, executor); assert.equal(id, jobId); return { jobId, status: 'SUCCEEDED', resultDigest: 'a'.repeat(64) }; },
    close: async () => calls.push('closed'),
  }));
  assert.deepEqual(calls, [[profileId, 'CHECKED_OUT_NODE'], 'closed']); assert.equal(result.exitCode, 0); assert.equal(JSON.parse(result.output).status, 'SUCCEEDED');
});
test('unknown outcomes receive no automatic retry and a distinct exit status', async () => {
  const profileId = randomUUID(), jobId = randomUUID(); let calls = 0, closed = 0;
  const result = await runAdvisoryVideoWorkerCli(['--profile', profileId, '--job', jobId], async () => ({ configuredExecutor: async () => ({}), runJob: async () => { calls++; return { jobId, status: 'UNKNOWN', resultDigest: null }; }, close: async () => { closed++; } }));
  assert.equal(calls, 1); assert.equal(closed, 1); assert.equal(result.exitCode, 2);
});
test('failed host admission or execution still closes the private pool without changing platform environment', async () => {
  const profileId = randomUUID(), jobId = randomUUID(), environment = { VERCEL: process.env.VERCEL, NODE_ENV: process.env.NODE_ENV }; let closed = 0, run = 0;
  await assert.rejects(runAdvisoryVideoWorkerCli(['--profile', profileId, '--job', jobId], async () => ({ configuredExecutor: async () => { throw Error('synthetic authority failure'); }, runJob: async () => { run++; }, close: async () => { closed++; } })));
  assert.equal(run, 0); assert.equal(closed, 1); assert.deepEqual({ VERCEL: process.env.VERCEL, NODE_ENV: process.env.NODE_ENV }, environment);
});
test('unexpected native result fields cannot be echoed as private data in a CLI receipt', async () => {
  const profileId = randomUUID(), jobId = randomUUID(); let closed = 0;
  await assert.rejects(runAdvisoryVideoWorkerCli(['--profile', profileId, '--job', jobId], async () => ({ configuredExecutor: async () => ({}), runJob: async () => ({ jobId, status: 'SUCCEEDED', resultDigest: 'synthetic private value must not be printed' }), close: async () => { closed++; } })), /RESULT_INVALID/);
  assert.equal(closed, 1);
});
