import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { MockLanguageModelV4 } from 'ai/test';
import { createAdvisoryFixture, prepareAdvisoryAdviceFixture } from './lib/website-sales-advisory-fixture';
import { runWebsiteSalesAdvisoryModelJob } from '../src/lib/website-sales-advisory-worker';
import { createWebsiteSalesAdvisoryExecutor, readWebsiteSalesAdvisoryJob } from '../src/lib/db/website-sales-advisory-jobs';
import { advisoryProfileExecutionBinding } from '../src/lib/website-sales-advisory-host';
import type { TenantPool } from '../src/lib/db/tenant-client';

// Actual restricted PostgreSQL, saved grants, existing credit ledger and actual AI SDK.
// The language-model provider is explicitly synthetic; no vendor request or live funding.
test('private Sales jobs execute through the actual SDK and normal durable credit ledger', { timeout: 180_000 }, async t => {
  const f = await createAdvisoryFixture();
  try {
    for (const name of ['146_ai_credit_billing.sql', '152_ai_billing_admin.sql', '153_ai_billing_runtime_acl.sql']) await f.adminPool.query(await readFile(`migrations/${name}`, 'utf8'));
    const prepared = await prepareAdvisoryAdviceFixture(f);
    let calls = 0, answer: unknown = { answerable: true, sourceIndices: [0], assertions: [], roleplayUtterance: null }, failTransport = false;
    const prompts: string[] = [];
    const model = new MockLanguageModelV4({ doGenerate: async options => {
      calls++; prompts.push(JSON.stringify(options.prompt));
      if (failTransport) throw Error('Synthetic provider acknowledgement loss');
      return { content: [{ type: 'text', text: JSON.stringify(answer) }], finishReason: { unified: 'stop', raw: undefined }, warnings: [],
        usage: { inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 20, text: 20, reasoning: undefined } } };
    } });
    const modelPorts = { model, profile: { enabled: true as const, targets: [{ workspaceId: f.ws, projectId: f.project }], validUntil: f.future, maxCreditsPerTurn: 100 } };
    const fixedProfile = { id: randomUUID(), identity: { workspaceId: f.ws, projectId: f.project, companyId: f.company, locationId: f.scope.locationId },
      workflowId: f.scope.workflowId, actorId: f.binding.actorId, workloadId: f.workload, grantId: f.grant, authorityReference: f.binding.authorityReference,
      allowedKinds: ['ADVICE', 'TRANSCRIPT_ANALYSIS', 'ROLEPLAY'], validUntil: f.future };
    const hostExecutor = createWebsiteSalesAdvisoryExecutor({ pool: f.executorPool as unknown as TenantPool,
      assertCurrent: async () => advisoryProfileExecutionBinding(fixedProfile, Date.parse(f.future)) });
    const run = (jobId: string) => runWebsiteSalesAdvisoryModelJob({ executor: hostExecutor, modelPorts }, jobId);
    await t.test('advice resolves an actual saved service actor, charges known usage once and persists a review draft', async () => {
      assert.equal((await run(prepared.jobId)).status, 'SUCCEEDED'); assert.equal(calls, 1);
      const rows = (await f.adminPool.query('select actor_id,status,actual_credits from ai_credit_reservations where workspace_id=$1 and request_id=$2', [f.ws, prepared.jobId])).rows;
      assert.equal(rows.length, 1); assert.equal(rows[0].actor_id, f.binding.actorId); assert.equal(rows[0].status, 'succeeded'); assert(rows[0].actual_credits > 0);
      const drafts = (await f.read()).records.filter(r => r.kind === 'ADVICE'); assert.equal(drafts.length, 1);
      assert.equal(drafts[0].payload.status, 'READY'); assert.equal((drafts[0].payload.value as Record<string, unknown>).status, 'DRAFT_REQUIRES_REVIEW');
      assert.equal((drafts[0].payload.value as Record<string, unknown>).summary, prepared.facts[0].text);
      assert.equal((await run(prepared.jobId)).status, 'NOT_CLAIMED'); assert.equal(calls, 1);
    });
    await t.test('transcript analysis can quote the final one of all90 authorized segments without changing customer facts', async () => {
      const segments = Array.from({ length: 90 }, (_, i) => ({ id: randomUUID(), speaker: 'CUSTOMER', startMs: i * 1000, endMs: i * 1000 + 900, text: `Synthetic recorded need ${i + 1}.` }));
      const saved = await f.run('register_transcript', { title: 'SYNTHETIC permitted transcript', segments, permissionReference: f.source, sourceReferences: [f.source], validUntil: f.future });
      answer = { answerable: true, sourceIndices: [], assertions: [{ segmentIndex: 89, exactQuote: segments[89].text, kind: 'NEED' }], roleplayUtterance: null };
      assert(saved.data.jobId); assert.equal((await run(saved.data.jobId)).status, 'SUCCEEDED');
      const analysis = (await f.read()).records.find(r => r.kind === 'TRANSCRIPT_ASSERTIONS'); assert(analysis);
      const body = analysis.payload.value as { canonicalFactsChanged: boolean; assertions: { segmentIds: string[]; exactQuotes: string[] }[] };
      assert.equal(body.canonicalFactsChanged, false); assert.deepEqual(body.assertions[0].segmentIds, [segments[89].id]); assert.deepEqual(body.assertions[0].exactQuotes, [segments[89].text]);
    });
    await t.test('continuing roleplay includes the actual previous simulated turn and current seller reply', async () => {
      answer = { answerable: true, sourceIndices: [], assertions: [], roleplayUtterance: 'Which approved service would address this need?' };
      const first = await f.run('prepare_roleplay', { knowledgeRef: prepared.knowledgeRef, scenarioId: 'price' }); assert(first.data.jobId);
      assert.equal((await run(first.data.jobId)).status, 'SUCCEEDED');
      const previous = (await f.read()).records.find(r => r.kind === 'ROLEPLAY' && (r.payload.value as Record<string, unknown> | null)?.customerReply === 'Which approved service would address this need?'); assert(previous);
      const second = await f.run('prepare_roleplay', { knowledgeRef: prepared.knowledgeRef, scenarioId: 'price', previousRoleplayRef: { id: previous.id, version: previous.version, digest: previous.digest }, sellerReply: 'Let us clarify the actual scope first.' });
      answer = { answerable: true, sourceIndices: [], assertions: [], roleplayUtterance: 'I would like to understand the delivery scope.' }; assert(second.data.jobId);
      assert.equal((await run(second.data.jobId)).status, 'SUCCEEDED');
      assert(prompts.at(-1)?.includes('Which approved service would address this need?')); assert(prompts.at(-1)?.includes('Let us clarify the actual scope first.'));
    });
    await t.test('a lost provider outcome holds the real reservation and the same job never generates again', async () => {
      const saved = await f.run('prepare_advice', { kind: 'WEBSITE', question: 'What approved scope helps us?', factRefs: [prepared.knowledgeRef], artifactRefs: [], knowledgeRefs: [prepared.knowledgeRef] }); assert(saved.data.jobId);
      failTransport = true; const before = calls; assert.equal((await run(saved.data.jobId)).status, 'UNKNOWN'); assert.equal(calls, before + 1);
      assert.equal((await readWebsiteSalesAdvisoryJob(f.executor, saved.data.jobId)).status, 'UNKNOWN');
      const row = (await f.adminPool.query('select status,actual_credits from ai_credit_reservations where workspace_id=$1 and request_id=$2', [f.ws, saved.data.jobId])).rows[0];
      assert.equal(row.status, 'reserved'); assert.equal(row.actual_credits, null);
      assert.equal((await run(saved.data.jobId)).status, 'NOT_CLAIMED'); assert.equal(calls, before + 1);
    });
  } finally { await f.close(); }
});
