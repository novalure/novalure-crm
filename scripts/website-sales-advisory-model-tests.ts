import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { MockLanguageModelV4 } from 'ai/test';
import type { AppSession } from '../src/lib/auth/session';
import { runWebsiteSalesAdvisoryModel, type AdvisoryModelInput, type AdvisoryModelPorts, type AdvisoryModelProfile } from '../src/lib/website-sales-advisory-model';

function fixture() {
  const identity = { workspaceId: randomUUID(), projectId: randomUUID(), companyId: randomUUID(), locationId: randomUUID() };
  const session: AppSession = { authenticated: true, userId: randomUUID(), workspaceId: identity.workspaceId, workspaceName: 'Synthetic fixture', email: 'synthetic@example.invalid',
    name: 'Synthetic actor', role: 'owner', permissions: ['crm:read', 'bots:run'], productRole: 'customer_owner', productPermissions: [], source: 'cookie',
    authIdentityId: randomUUID(), authSessionId: randomUUID() };
  const ref = { id: randomUUID(), version: 1, digest: 'a'.repeat(64) };
  const input: AdvisoryModelInput = { requestId: randomUUID(), identity, workflowId: randomUUID(), kind: 'ADVICE', question: 'How is the website maintained?',
    sources: [{ ref, text: 'The approved scope includes a monthly technical maintenance review.' }], segments: [], scenario: null };
  const profile: AdvisoryModelProfile = { enabled: true, targets: [{ workspaceId: identity.workspaceId, projectId: identity.projectId }], validUntil: '2027-01-01T00:00:00Z', maxCreditsPerTurn: 100 };
  let generated = 0, reserved = 0, checked = 0, replayed = false, thrown = false, settlementFails = false;
  let output: unknown = { answerable: true, sourceIndices: [0], assertions: [], roleplayUtterance: null };
  let current: (n: number) => boolean = () => true;
  const settled: { actualCredits: number; status: string }[] = [];
  const ports: AdvisoryModelPorts = {
    profile, now: () => Date.parse('2026-11-23T07:00:00Z'),
    isCurrent: async () => current(++checked),
    model: new MockLanguageModelV4({ doGenerate: async () => {
      generated++; if (thrown) throw Error('Synthetic transport loss; never a provider receipt');
      return { content: [{ type: 'text', text: JSON.stringify(output) }], finishReason: { unified: 'stop', raw: undefined },
        usage: { inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 20, text: 20, reasoning: undefined } }, warnings: [] };
    } }),
    reserve: async (_actor, value) => { reserved++; return { requestId: value.requestId, reservationId: randomUUID(), reservedCredits: value.credits, status: 'reserved', replayed }; },
    settle: async (_actor, value) => { if (settlementFails) throw Error('Synthetic settlement unavailable'); settled.push(value);
      return { reservationId: randomUUID(), actualCredits: value.actualCredits, status: value.status, replayed: false }; },
  };
  return { session, input, ports, profile, settled, counts: () => ({ generated, reserved, checked }),
    output: (v: unknown) => { output = v; }, current: (fn: typeof current) => { current = fn; },
    replay: () => { replayed = true; }, disconnect: () => { thrown = true; }, settlementFailure: () => { settlementFails = true; } };
}

test('an inactive or differently scoped host profile starts no paid model call or credit reservation', async () => {
  const f = fixture();
  assert.equal((await runWebsiteSalesAdvisoryModel(f.session, f.input, { ...f.ports, profile: { ...f.profile, targets: [{ workspaceId: randomUUID(), projectId: f.input.identity.projectId }] } })).status, 'UNAVAILABLE');
  assert.equal(f.counts().reserved, 0); assert.equal(f.counts().generated, 0);
  assert.equal((await runWebsiteSalesAdvisoryModel({ ...f.session, source: 'headers' }, f.input, f.ports)).reason, 'AUTHENTICATED_MODEL_ACTOR_REQUIRED');
  assert.equal(f.counts().generated, 0);
});
test('actual SDK structured generation selects only approved literal excerpts and settles known usage', async () => {
  const f = fixture(), out = await runWebsiteSalesAdvisoryModel(f.session, f.input, f.ports);
  assert.equal(out.status, 'READY'); assert.equal(out.text, f.input.sources[0].text); assert.deepEqual(out.sourceRefs, [f.input.sources[0].ref]);
  assert.equal(out.reviewRequired, true); assert.equal(out.externalEffectAllowed, false);
  assert.deepEqual(f.counts(), { generated: 1, reserved: 1, checked: 3 }); assert.equal(f.settled.length, 1); assert.equal(f.settled[0].status, 'succeeded');
});

test('two distinct facts sharing one evidence reference retain the actual selected source position', async () => {
  const f = fixture(); f.input.sources.push({ ref: f.input.sources[0].ref, text: 'Only the approved second excerpt describes the support hours.' });
  f.output({ answerable: true, sourceIndices: [1], assertions: [], roleplayUtterance: null });
  const out = await runWebsiteSalesAdvisoryModel(f.session, f.input, f.ports);
  assert.equal(out.status, 'READY'); assert.deepEqual(out.selectedSourceIndices, [1]); assert.equal(out.text, f.input.sources[1].text);
});

test('a selected answer exceeding the public text bound is held for review without silently truncating either source', async () => {
  const f = fixture(); f.input.sources = [{ ref: f.input.sources[0].ref, text: 'A'.repeat(1200) }, { ref: f.input.sources[0].ref, text: 'B'.repeat(1200) }];
  f.output({ answerable: true, sourceIndices: [0, 1], assertions: [], roleplayUtterance: null });
  const out = await runWebsiteSalesAdvisoryModel(f.session, f.input, f.ports);
  assert.equal(out.status, 'UNANSWERABLE'); assert.equal(out.reason, 'APPROVED_ANSWER_LENGTH_REQUIRES_REVIEW'); assert.equal(out.text, null);
  assert.equal(f.settled.length, 1); assert.equal(f.settled[0].status, 'succeeded');
});

test('revoking the actual host AI profile during reservation prevents dispatch and releases the unused credits', async () => {
  const f = fixture(), previous = process.env.CRM_WEBSITE_SALES_ADVISORY_AI;
  process.env.CRM_WEBSITE_SALES_ADVISORY_AI = JSON.stringify(f.profile);
  const originalReserve = f.ports.reserve!;
  try {
    const out = await runWebsiteSalesAdvisoryModel(f.session, f.input, { ...f.ports, profile: undefined, reserve: async (...args) => {
      const held = await originalReserve(...args); delete process.env.CRM_WEBSITE_SALES_ADVISORY_AI; return held;
    } });
    assert.equal(out.status, 'STALE'); assert.equal(f.counts().generated, 0); assert.deepEqual(f.settled.map(s => s.actualCredits), [0]);
  } finally {
    if (previous === undefined) delete process.env.CRM_WEBSITE_SALES_ADVISORY_AI; else process.env.CRM_WEBSITE_SALES_ADVISORY_AI = previous;
  }
});
test('a previously reserved request is UNKNOWN and never causes a second provider call', async () => {
  const f = fixture(); f.replay(); const out = await runWebsiteSalesAdvisoryModel(f.session, f.input, f.ports);
  assert.equal(out.status, 'UNKNOWN'); assert.equal(f.counts().generated, 0); assert.equal(f.settled.length, 0);
});
test('revocation while the credit reservation commits releases only the confirmed unused reservation', async () => {
  const f = fixture(); f.current(n => n === 1);
  assert.equal((await runWebsiteSalesAdvisoryModel(f.session, f.input, f.ports)).status, 'STALE');
  assert.equal(f.counts().generated, 0); assert.deepEqual(f.settled.map(s => [s.actualCredits, s.status]), [[0, 'failed']]);
});
test('source revocation during a model call discards its output while preserving the actual charge', async () => {
  const f = fixture(); f.current(n => n < 3); const out = await runWebsiteSalesAdvisoryModel(f.session, f.input, f.ports);
  assert.equal(out.status, 'STALE'); assert.equal(out.text, null); assert(out.chargedCredits! > 0); assert.equal(f.settled[0].status, 'succeeded');
});
test('expiry while the independent credit reservation commits prevents provider dispatch and releases unused credits', async () => {
  const f = fixture(); let now = Date.parse('2026-11-23T07:00:00Z');
  f.profile.validUntil = new Date(now + 1000).toISOString(); f.ports.now = () => now;
  const reserve = f.ports.reserve!;
  f.ports.reserve = async (...args) => { const held = await reserve(...args); now += 2000; return held; };
  const out = await runWebsiteSalesAdvisoryModel(f.session, f.input, f.ports);
  assert.equal(out.status, 'STALE'); assert.equal(f.counts().generated, 0);
  assert.deepEqual(f.settled.map(s => [s.actualCredits, s.status]), [[0, 'failed']]);
});
test('a transcript assertion must quote an actual exact segment before it can become a review candidate', async () => {
  const f = fixture(), id = randomUUID(); f.input.kind = 'TRANSCRIPT_ANALYSIS';
  f.input.segments = [{ id, speaker: 'CUSTOMER', startMs: 0, endMs: 1000, text: 'Our preferred launch is in February.' }];
  f.output({ answerable: true, sourceIndices: [], assertions: [{ segmentIndex: 0, exactQuote: 'The customer has approved the contract.', kind: 'POSSIBLE_COMMITMENT' }], roleplayUtterance: null });
  const rejected = await runWebsiteSalesAdvisoryModel(f.session, f.input, f.ports);
  assert.equal(rejected.status, 'UNANSWERABLE'); assert.deepEqual(rejected.assertions, []);
  const next = fixture(); next.input.kind = 'TRANSCRIPT_ANALYSIS'; next.input.segments = f.input.segments;
  next.output({ answerable: true, sourceIndices: [], assertions: [{ segmentIndex: 0, exactQuote: 'preferred launch is in February', kind: 'CONSTRAINT' }], roleplayUtterance: null });
  const accepted = await runWebsiteSalesAdvisoryModel(next.session, next.input, next.ports);
  assert.equal(accepted.status, 'READY'); assert.equal(accepted.assertions[0].segmentId, id); assert.equal(accepted.reviewRequired, true);
});
test('an unknown model transport outcome has exactly one attempt and leaves credits reserved for reconciliation', async () => {
  const f = fixture(); f.disconnect(); const out = await runWebsiteSalesAdvisoryModel(f.session, f.input, f.ports);
  assert.equal(out.status, 'UNKNOWN'); assert.equal(out.text, null); assert.equal(f.counts().generated, 1); assert.equal(f.settled.length, 0);
});
test('unconfirmed credit settlement never exposes a seemingly completed answer', async () => {
  const f = fixture(); f.settlementFailure(); const out = await runWebsiteSalesAdvisoryModel(f.session, f.input, f.ports);
  assert.equal(out.status, 'UNKNOWN'); assert.equal(out.reason, 'MODEL_SETTLEMENT_PENDING_REVIEW'); assert.equal(out.text, null);
});
test('role play remains an internal simulation without any business action authority', async () => {
  const f = fixture(); f.input.kind = 'ROLEPLAY'; f.input.scenario = 'The buyer asks about an existing approved price.';
  f.output({ answerable: true, sourceIndices: [], assertions: [], roleplayUtterance: 'Which part of the proposed scope explains this price?' });
  const out = await runWebsiteSalesAdvisoryModel(f.session, f.input, f.ports);
  assert.equal(out.reason, 'INTERNAL_SIMULATION_ONLY'); assert.equal(out.externalEffectAllowed, false); assert.equal(out.reviewRequired, true);
});
