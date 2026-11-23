import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import * as client from '../src/lib/website-sales-advisory-client';
import { assertSalesWriteBarrier } from '../src/lib/website-sales-write-barrier';
import { websiteSalesAdvisoryContract, type WebsiteSalesAdvisoryCommand, type WebsiteSalesAdvisoryRead } from '../src/lib/website-sales-advisory-types';

// Transport fixtures are explicitly synthetic. They do not attest model inference, buyer identity or forecast accuracy.
const originalFetch = globalThis.fetch, originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window'), originalTimer = globalThis.setTimeout;
const saved = new Map<string, string>();
const storage = {
  getItem: (key: string) => saved.get(key) ?? null,
  setItem: (key: string, value: string) => { saved.set(key, value); },
  removeItem: (key: string) => { saved.delete(key); },
};
Object.defineProperty(globalThis, 'window', { configurable: true, value: { location: { origin: 'https://crm.example', href: 'https://crm.example/' }, sessionStorage: storage } });
after(() => { globalThis.fetch = originalFetch; globalThis.setTimeout = originalTimer; if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow); else Reflect.deleteProperty(globalThis, 'window'); });

function fixture() {
  const workspaceId = randomUUID(), actorId = randomUUID(), workflowId = randomUUID();
  const scope = { projectId: randomUUID(), companyId: randomUUID(), locationId: randomUUID() };
  const command: WebsiteSalesAdvisoryCommand = { contractVersion: websiteSalesAdvisoryContract, operation: 'prepare_value_case', ...scope, workflowId,
    expectedVersion: 0, expectedWorkflowVersion: 2, idempotencyKey: randomUUID(), correlationId: randomUUID(),
    payload: { basisRef: { id: randomUUID(), version: 1, digest: 'b'.repeat(64) } } };
  const receipt = { contractVersion: websiteSalesAdvisoryContract, persisted: true, commandId: randomUUID(), auditReference: randomUUID(), correlationId: command.correlationId, replayed: false,
    data: { identity: { workspaceId, ...scope }, workflowId, version: 1, workflowVersion: 2, recordId: randomUUID(), recordDigest: 'a'.repeat(64), jobId: null, canContact: false } };
  const read: WebsiteSalesAdvisoryRead = { contractVersion: websiteSalesAdvisoryContract, source: 'database', identity: { workspaceId, ...scope }, workflowId,
    version: 1, workflowVersion: 2, canWrite: false, canApproveFacts: false, canContact: false, actionEligibility: [], blockers: [], records: [], jobs: [], buyerGrants: [], groundedFacts: [], recordStates: [], coverage: { historyComplete: true, recordsLimit: 200, hasMore: false }, buyerQuestions: [], experimentAssessments: [],
    choices: { briefs: [], closePlans: [], demos: [], offers: [], contacts: [], principals: [], tasks: [], sources: [], cohortCandidates: [], forecastOrigins: [] } };
  return { workspaceId, actorId, workflowId, scope, command, receipt, read };
}
function mock(run: (request: Request) => Promise<Response>) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input), 'https://crm.example');
    if (url.pathname === '/api/auth/csrf') return Response.json({ csrfToken: 'synthetic-only' });
    return run(input instanceof Request ? input : new Request(input, init));
  }) as typeof fetch;
}
const mark = (f: ReturnType<typeof fixture>) => client.markAdvisoryCurrentRead(f.workspaceId, f.actorId, f.command, f.scope);
const reconcile = (f: ReturnType<typeof fixture>) => ({ contractVersion: 'website-sales-advisory-reconcile-v1', status: 'COMMITTED', correlationId: f.command.correlationId, receipt: f.receipt, currentData: f.read });

test('advisory UNKNOWN survives reload with the exact original body, actor and workflow', async () => {
  const f = fixture(); let body = '';
  mock(async request => { body = await request.text(); throw Error('ack lost after dispatch'); });
  await assert.rejects(client.writeAdvisory(f.workspaceId, f.actorId, f.command));
  const fresh = await import(`${new URL('../src/lib/website-sales-advisory-client.ts', import.meta.url).href}?reload=${randomUUID()}`) as typeof client;
  assert.equal(fresh.advisoryPending(f.workspaceId, f.actorId)?.body, body);
  assert.equal(fresh.advisoryPending(f.workspaceId, randomUUID()), undefined);
  await assert.rejects(fresh.reconcileAdvisory(f.workspaceId, f.actorId));
  fresh.markAdvisoryCurrentRead(f.workspaceId, f.actorId, f.command, f.scope);
  mock(async request => { assert.equal(await request.text(), body); assert.equal(request.headers.get('idempotency-key'), f.command.idempotencyKey); return Response.json(reconcile(f)); });
  assert.equal(await fresh.reconcileAdvisory(f.workspaceId, f.actorId), 'COMMITTED');
  assert.equal(fresh.advisoryPending(f.workspaceId, f.actorId), undefined);
});

test('NOT_FOUND permits only the same command and a late different-workflow read cannot authorize recovery', async () => {
  const f = fixture(); mock(async () => { throw Error('lost'); });
  await assert.rejects(client.writeAdvisory(f.workspaceId, f.actorId, f.command));
  client.markAdvisoryCurrentRead(f.workspaceId, f.actorId, { ...f.command, workflowId: randomUUID() }, f.scope);
  assert.equal(client.advisoryPending(f.workspaceId, f.actorId)?.currentRead, false);
  mark(f); mock(async () => Response.json({ contractVersion: 'website-sales-advisory-reconcile-v1', status: 'NOT_FOUND', correlationId: f.command.correlationId }));
  assert.equal(await client.reconcileAdvisory(f.workspaceId, f.actorId), 'NOT_FOUND');
  let writes = 0; mock(async request => { writes++; assert.equal(await request.text(), JSON.stringify(f.command)); return Response.json(f.receipt); });
  await assert.rejects(client.writeAdvisory(f.workspaceId, f.actorId, { ...f.command, idempotencyKey: randomUUID() }, true));
  await assert.rejects(client.writeAdvisory(f.workspaceId, f.actorId, { ...f.command, payload: { ...f.command.payload, basisRef: { id: randomUUID(), version: 1, digest: 'b'.repeat(64) } } }, true));
  assert.equal(writes, 0);
  await client.writeAdvisory(f.workspaceId, f.actorId, f.command, true);
  assert.equal(writes, 1);
});

test('foreign scope, stale versions and malformed advisory receipts retain UNKNOWN', async () => {
  for (const mutate of [
    (f: ReturnType<typeof fixture>) => { f.receipt.data.identity.companyId = randomUUID(); },
    (f: ReturnType<typeof fixture>) => { f.receipt.data.workflowId = randomUUID(); },
    (f: ReturnType<typeof fixture>) => { f.receipt.data.workflowVersion = 1; },
    (f: ReturnType<typeof fixture>) => { f.receipt.data.version = f.command.expectedVersion; },
    (f: ReturnType<typeof fixture>) => { f.receipt.data.recordDigest = 'not-a-digest'; },
    (f: ReturnType<typeof fixture>) => { (f.receipt.data as { recordId: string | null }).recordId = null; },
    (f: ReturnType<typeof fixture>) => { Object.assign(f.receipt.data, { recordId: null, recordDigest: null }); },
  ]) {
    const f = fixture(); mutate(f); mock(async () => Response.json(f.receipt));
    await assert.rejects(client.writeAdvisory(f.workspaceId, f.actorId, f.command));
    assert.equal(client.advisoryPending(f.workspaceId, f.actorId)?.state, 'UNKNOWN');
  }
});

test('missing required native job effects retain UNKNOWN for writes and committed reconciliation', async () => {
  const ref = { id: randomUUID(), version: 1, digest: 'a'.repeat(64) }, future = new Date(Date.now() + 3600000).toISOString();
  const source = { id: randomUUID(), reference: 'synthetic:test-evidence', digest: 'b'.repeat(64), basis: 'OPERATOR_RECORDED', observedAt: new Date(Date.now() - 60000).toISOString(), validUntil: future };
  const cases = {
    register_transcript: { title: 'Synthetic transcript', segments: [{ id: randomUUID(), speaker: 'CUSTOMER', startMs: 0, endMs: 1000, text: 'Synthetic recorded question.' }], permissionReference: source, sourceReferences: [source], validUntil: future },
    prepare_advice: { kind: 'WEBSITE', question: 'Synthetic advice question?', factRefs: [ref], artifactRefs: [], knowledgeRefs: [] },
    prepare_roleplay: { knowledgeRef: ref, scenarioId: 'synthetic' },
    approve_video_storyboard: { recordRef: ref, validUntil: future },
  };
  for (const [operation, payload] of Object.entries(cases)) {
    const f = fixture(); f.command.operation = operation as WebsiteSalesAdvisoryCommand['operation']; f.command.payload = payload;
    mock(async () => Response.json(f.receipt)); await assert.rejects(client.writeAdvisory(f.workspaceId, f.actorId, f.command)); assert.equal(client.advisoryPending(f.workspaceId, f.actorId)?.state, 'UNKNOWN');
    mark(f); mock(async () => Response.json(reconcile(f))); await assert.rejects(client.reconcileAdvisory(f.workspaceId, f.actorId)); assert.equal(client.advisoryPending(f.workspaceId, f.actorId)?.state, 'UNKNOWN');
    Object.assign(f.receipt.data, { jobId: randomUUID() }); mock(async () => Response.json(reconcile(f))); await client.reconcileAdvisory(f.workspaceId, f.actorId); assert.equal(client.advisoryPending(f.workspaceId, f.actorId), undefined);
  }
});

test('reconciliation validates both the original receipt and the current scoped record before releasing the barrier', async () => {
  const f = fixture(); mock(async () => { throw Error('lost'); });
  await assert.rejects(client.writeAdvisory(f.workspaceId, f.actorId, f.command)); mark(f);
  mock(async () => Response.json({ ...reconcile(f), currentData: { ...f.read, identity: { ...f.read.identity, projectId: randomUUID() } } }));
  await assert.rejects(client.reconcileAdvisory(f.workspaceId, f.actorId));
  assert.equal(client.advisoryPending(f.workspaceId, f.actorId)?.state, 'UNKNOWN');
  mock(async () => Response.json(reconcile(f))); await client.reconcileAdvisory(f.workspaceId, f.actorId);
  assert.equal(client.advisoryPending(f.workspaceId, f.actorId), undefined);
});

test('advisory and all existing Sales areas share an actor/workspace barrier including damaged recovery', async () => {
  const f = fixture(); saved.set(`novalure.website-sales-advisory.pending.v1:${f.actorId}:${f.workspaceId}`, 'damaged');
  assert.equal(client.advisoryPending(f.workspaceId, f.actorId)?.damaged, true);
  for (const area of ['workflow', 'studio', 'lifecycle', 'autonomy', 'conversation', 'enablement', 'commerce'] as const)
    assert.throws(() => assertSalesWriteBarrier(area, f.workspaceId, f.actorId), /RECONCILIATION_REQUIRED/);
  assert.doesNotThrow(() => assertSalesWriteBarrier('enablement', randomUUID(), f.actorId));
  assert.doesNotThrow(() => assertSalesWriteBarrier('enablement', f.workspaceId, randomUUID()));
  let dispatched = 0; mock(async () => { dispatched++; return Response.json(f.receipt); });
  await assert.rejects(client.writeAdvisory(f.workspaceId, f.actorId, f.command));
  const other = fixture(); saved.set(`novalure.website-sales-enablement.pending.v1:${other.actorId}:${other.workspaceId}`, 'pending');
  await assert.rejects(client.writeAdvisory(other.workspaceId, other.actorId, other.command));
  assert.equal(dispatched, 0);
});

test('unavailable durable storage refuses dispatch and a hanging body has a bounded UNKNOWN result', async () => {
  const f = fixture(), originalSet = storage.setItem; let dispatched = 0;
  mock(async () => { dispatched++; return Response.json(f.receipt); });
  storage.setItem = () => { throw Error('quota'); };
  try { await assert.rejects(client.writeAdvisory(f.workspaceId, f.actorId, f.command)); } finally { storage.setItem = originalSet; }
  assert.equal(dispatched, 0);
  const hanging = fixture(); let cancelled = false;
  globalThis.setTimeout = ((handler: TimerHandler, delay?: number, ...args: unknown[]) => originalTimer(handler as (...values: unknown[]) => void, delay === 20000 ? 15 : delay, ...args)) as unknown as typeof setTimeout;
  try {
    mock(async () => new Response(new ReadableStream({ cancel() { cancelled = true; } })));
    await assert.rejects(client.writeAdvisory(hanging.workspaceId, hanging.actorId, hanging.command));
    assert.equal(cancelled, true); assert.equal(client.advisoryPending(hanging.workspaceId, hanging.actorId)?.state, 'UNKNOWN');
  } finally { globalThis.setTimeout = originalTimer; }
});

test('browser advisory reads reject an unrelated workflow before rendering its financial or contract data', async () => {
  const f = fixture(); mock(async () => Response.json({ ...f.read, workflowId: randomUUID() }));
  await assert.rejects(client.readAdvisory(f.workspaceId, f.scope, f.workflowId));
  mock(async request => { const url = new URL(request.url); assert.equal(url.searchParams.get('workflowId'), f.workflowId); assert.equal(url.searchParams.get('projectId'), f.scope.projectId); return Response.json(f.read); });
  const data = await client.readAdvisory(f.workspaceId, f.scope, f.workflowId);
  assert.equal(data.workflowId, f.workflowId); assert.equal(data.canWrite, false);
});
test('buyer link origin comes only from valid volatile server metadata without an alias fallback', async () => {
  const f = fixture();
  for (const origin of [null, 'https://canonical.example/', 'https://person@example.invalid', 'https://canonical.example/path', 'http://remote.example', 'javascript:alert(1)']) {
    mock(async () => Response.json(f.read, { headers: origin ? { 'x-sales-review-origin': origin } : {} })); const read = await client.readAdvisory(f.workspaceId, f.scope, f.workflowId); assert.equal(client.advisoryReviewOrigin(read), null);
  }
  for (const origin of ['https://canonical.example', 'http://127.0.0.1:43001']) {
    mock(async () => Response.json(f.read, { headers: { 'x-sales-review-origin': origin } })); const read = await client.readAdvisory(f.workspaceId, f.scope, f.workflowId); assert.equal(client.advisoryReviewOrigin(read), origin); assert.equal(client.advisoryReviewOrigin(structuredClone(read)), null); assert(!JSON.stringify(read).includes(origin));
  }
});

