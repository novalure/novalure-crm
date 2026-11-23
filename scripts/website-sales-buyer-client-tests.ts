import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import * as client from '../src/lib/website-sales-buyer-client';
import type { WebsiteSalesAdvisoryBuyerRead } from '../src/lib/website-sales-advisory-types';

// Synthetic transport/account-binding fixtures only; no real customer identity or signature is asserted.
const originalFetch = globalThis.fetch, originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const saved = new Map<string, string>(), token = 's'.repeat(43);
const storage = { get length() { return saved.size; }, key: (index: number) => [...saved.keys()][index] ?? null, getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => { saved.set(key, value); }, removeItem: (key: string) => { saved.delete(key); } };
Object.defineProperty(globalThis, 'window', { configurable: true, value: { location: { origin: 'https://crm.example', href: 'https://crm.example/sales-review' }, sessionStorage: storage } });
after(() => { globalThis.fetch = originalFetch; if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow); else Reflect.deleteProperty(globalThis, 'window'); });
function fixture() {
  const grantId = randomUUID(), actorUserId = randomUUID(), packetRef = { id: randomUUID(), version: 1, digest: 'a'.repeat(64) }, stepId = randomUUID();
  const data: WebsiteSalesAdvisoryBuyerRead = { contractVersion: 'website-sales-advisory-buyer-v1', grantId, grantVersion: 1, actorBindingHash: 'c'.repeat(64), expiresAt: new Date(Date.now() + 3600000).toISOString(), actorUserId, authAssurance: 'AUTHENTICATED_ACCOUNT', canWrite: true, blockers: [], packetRef,
    title: 'Synthetic decision packet', summary: 'Synthetic shared content', decisionCriteria: [], options: [], questions: [], demo: null, video: null, valueCase: null, steps: [{ id: stepId, version: 1, label: 'Synthetic next step', responsible: 'BUYER', dueAt: null, status: 'PROPOSED' }] };
  const command: client.BuyerCommand = { contractVersion: 'website-sales-advisory-buyer-v1', grantId, expectedGrantVersion: 1, packetRef, actorBindingHash: 'c'.repeat(64), stepId, expectedStepVersion: 1, disposition: 'CONFIRMED', comment: null, idempotencyKey: randomUUID(), correlationId: randomUUID() };
  const receipt = { contractVersion: 'website-sales-advisory-buyer-v1', persisted: true, commandId: randomUUID(), auditReference: randomUUID(), correlationId: command.correlationId, replayed: false,
    data: { grantId, packetRef: { ...packetRef }, actorUserId, actorBindingHash: 'c'.repeat(64), grantVersion: 1, stepId: stepId as string | null, stepVersion: 2 as number | null, questionId: null as string | null } };
  return { data, command, receipt };
}
function mock(run: (request: Request) => Promise<Response>) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input), 'https://crm.example');
    if (url.pathname === '/api/auth/csrf') return Response.json({ csrfToken: 'synthetic-only' });
    return run(input instanceof Request ? input : new Request(url, init));
  }) as typeof fetch;
}
test('buyer writes require an actual fresh server projection and an authenticated approved account', async () => {
  const f = fixture(); let writes = 0; mock(async request => { if (request.method === 'POST') writes++; return Response.json(f.data); });
  await assert.rejects(client.writeBuyer(token, f.data, f.command));
  mock(async () => Response.json({ ...f.data, canWrite: false, actorUserId: null, actorBindingHash: null, authAssurance: 'READ_ONLY_LINK' }));
  const data = await client.readBuyer(token); await assert.rejects(client.writeBuyer(token, data, f.command)); assert.equal(writes, 0);
});
test('buyer UNKNOWN retains exact bytes without the secret and reconciles after reload only for the same account and packet', async () => {
  const f = fixture(); let body = '';
  mock(async request => { assert.equal(new URL(request.url).search, ''); assert.equal(request.headers.get('x-sales-review-token'), token); if (request.method === 'GET') return Response.json(f.data); body = await request.text(); throw Error('synthetic acknowledgement loss'); });
  const data = await client.readBuyer(token); await assert.rejects(client.writeBuyer(token, data, f.command));
  const stored = [...saved.values()].find(value => value.includes(f.data.grantId)); assert(stored); assert(!stored.includes(token));
  const fresh = await import(`${new URL('../src/lib/website-sales-buyer-client.ts', import.meta.url).href}?reload=${randomUUID()}`) as typeof client;
  assert.equal(fresh.buyerPending(f.data.grantId)?.body, body);
  mock(async request => request.method === 'GET' ? Response.json(f.data) : Response.json({ contractVersion: 'website-sales-advisory-buyer-reconcile-v1', status: 'COMMITTED', correlationId: f.command.correlationId, receipt: f.receipt, currentData: f.data }));
  const current = await fresh.readBuyer(token); assert.equal(await fresh.reconcileBuyer(token, current), 'COMMITTED'); assert.equal(fresh.buyerPending(f.data.grantId), undefined);
});
test('a different authenticated account cannot recover or replace the original buyer command', async () => {
  const f = fixture(); mock(async request => { if (request.method === 'GET') return Response.json(f.data); throw Error('lost'); });
  const data = await client.readBuyer(token); await assert.rejects(client.writeBuyer(token, data, f.command));
  let writes = 0; mock(async request => { if (request.method === 'POST') writes++; return Response.json({ ...f.data, actorUserId: randomUUID() }); });
  const changed = await client.readBuyer(token); await assert.rejects(client.reconcileBuyer(token, changed)); await assert.rejects(client.writeBuyer(token, changed, f.command, true)); assert.equal(writes, 0);
});
test('only NOT_FOUND plus a fresh exact account read permits retrying the original buyer bytes', async () => {
  const f = fixture(); mock(async request => { if (request.method === 'GET') return Response.json(f.data); throw Error('lost'); });
  const data = await client.readBuyer(token); await assert.rejects(client.writeBuyer(token, data, f.command));
  mock(async request => request.method === 'GET' ? Response.json(f.data) : Response.json({ contractVersion: 'website-sales-advisory-buyer-reconcile-v1', status: 'NOT_FOUND', correlationId: f.command.correlationId }));
  const current = await client.readBuyer(token); assert.equal(await client.reconcileBuyer(token, current), 'NOT_FOUND');
  let writes = 0; mock(async request => { writes++; assert.equal(await request.text(), JSON.stringify(f.command)); assert.equal(request.headers.get('idempotency-key'), f.command.idempotencyKey); return Response.json(f.receipt); });
  await assert.rejects(client.writeBuyer(token, current, { ...f.command, idempotencyKey: randomUUID() }, true)); assert.equal(writes, 0);
  await client.writeBuyer(token, current, f.command, true); assert.equal(writes, 1);
});
test('a revoked read invalidates previous write authority instead of retaining a usable stale projection', async () => {
  const f = fixture(); mock(async () => Response.json(f.data)); const data = await client.readBuyer(token);
  mock(async () => Response.json({ error: 'synthetic-revoked' }, { status: 403 })); await assert.rejects(client.readBuyer(token));
  let writes = 0; mock(async () => { writes++; return Response.json(f.receipt); }); await assert.rejects(client.writeBuyer(token, data, f.command)); assert.equal(writes, 0);
});
test('grafted actors, account bindings, grants, packets, steps or missing question receipts keep buyer results UNKNOWN', async () => {
  for (const mode of ['actor', 'binding', 'grant', 'packet', 'step', 'question'] as const) {
    const f = fixture(); if (mode === 'question') { f.command.stepId = null; f.command.expectedStepVersion = null; f.command.disposition = 'QUESTION'; f.command.comment = 'Synthetic question'; f.receipt.data.stepId = null; f.receipt.data.stepVersion = null; }
    if (mode === 'actor') f.receipt.data.actorUserId = randomUUID(); if (mode === 'binding') f.receipt.data.actorBindingHash = 'd'.repeat(64); if (mode === 'grant') f.receipt.data.grantId = randomUUID(); if (mode === 'packet') f.receipt.data.packetRef.digest = 'b'.repeat(64); if (mode === 'step') f.receipt.data.stepId = randomUUID();
    mock(async request => request.method === 'GET' ? Response.json(f.data) : Response.json(f.receipt)); const data = await client.readBuyer(token);
    await assert.rejects(client.writeBuyer(token, data, f.command)); assert.equal(client.buyerPending(f.data.grantId)?.state, 'UNKNOWN');
  }
});
test('a changed server account binding blocks recovery even when the displayed user and packet match', async () => {
  const f = fixture(); mock(async request => { if (request.method === 'GET') return Response.json(f.data); throw Error('synthetic lost acknowledgement'); });
  const current = await client.readBuyer(token); await assert.rejects(client.writeBuyer(token, current, f.command));
  mock(async () => Response.json({ ...f.data, actorBindingHash: 'e'.repeat(64) })); const changed = await client.readBuyer(token);
  assert.equal(client.buyerPending(f.data.grantId)?.currentRead, false);
  let writes = 0; mock(async () => { writes++; return Response.json(f.receipt); }); await assert.rejects(client.reconcileBuyer(token, changed)); await assert.rejects(client.writeBuyer(token, changed, f.command, true)); assert.equal(writes, 0);
});
