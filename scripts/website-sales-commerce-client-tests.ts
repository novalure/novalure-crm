import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import * as client from '../src/lib/website-sales-commerce-client';
import { assertSalesWriteBarrier } from '../src/lib/website-sales-write-barrier';
import { websiteSalesCommerceContract, type WebsiteSalesCommerceCommand, type WebsiteSalesCommerceRead } from '../src/lib/website-sales-commerce-types';

// Transport fixtures are explicitly synthetic. They do not attest provider delivery, signing or payment.
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
  const command: WebsiteSalesCommerceCommand = { contractVersion: websiteSalesCommerceContract, operation: 'propose_renewal', ...scope, workflowId,
    expectedVersion: 0, expectedWorkflowVersion: 2, idempotencyKey: randomUUID(), correlationId: randomUUID(),
    payload: { subscriptionRef: { id: randomUUID(), version: 1, digest: 'b'.repeat(64) } } };
  const receipt = { contractVersion: websiteSalesCommerceContract, persisted: true, commandId: randomUUID(), auditReference: randomUUID(), correlationId: command.correlationId, replayed: false,
    data: { identity: { workspaceId, ...scope }, workflowId, version: 1, workflowVersion: 2, recordId: randomUUID(), recordDigest: 'a'.repeat(64), outboxId: null, canContact: false } };
  const read: WebsiteSalesCommerceRead = { contractVersion: websiteSalesCommerceContract, source: 'database', identity: { workspaceId, ...scope }, workflowId,
    version: 1, workflowVersion: 2, canWrite: false, canApproveFacts: false, canApproveContract: false, canContact: false, actionEligibility: [], eligibleDeliveryTasks: [], sourceConnections: [], offerChoices: [], templates: [], policy: null, offers: [], contracts: [], approvals: [],
    deliveryAcceptances: [], invoiceRequests: [], invoices: [], payments: [], subscriptions: [], outbox: [], sourceEvents: [], sourceAssessment: { status: 'READY', activeEventIds: [], invalidatedEventIds: [], reasons: [], complete: true }, blockers: [] };
  return { workspaceId, actorId, workflowId, scope, command, receipt, read };
}
function mock(run: (request: Request) => Promise<Response>) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input), 'https://crm.example');
    if (url.pathname === '/api/auth/csrf') return Response.json({ csrfToken: 'synthetic-only' });
    return run(input instanceof Request ? input : new Request(input, init));
  }) as typeof fetch;
}
const mark = (f: ReturnType<typeof fixture>) => client.markCommerceCurrentRead(f.workspaceId, f.actorId, f.command, f.scope);
const reconcile = (f: ReturnType<typeof fixture>) => ({ contractVersion: 'website-sales-commerce-reconcile-v1', status: 'COMMITTED', correlationId: f.command.correlationId, receipt: f.receipt, currentData: f.read });

test('commerce UNKNOWN survives reload with the exact original body, actor and workflow', async () => {
  const f = fixture(); let body = '';
  mock(async request => { body = await request.text(); throw Error('ack lost after dispatch'); });
  await assert.rejects(client.writeCommerce(f.workspaceId, f.actorId, f.command));
  const fresh = await import(`${new URL('../src/lib/website-sales-commerce-client.ts', import.meta.url).href}?reload=${randomUUID()}`) as typeof client;
  assert.equal(fresh.commercePending(f.workspaceId, f.actorId)?.body, body);
  assert.equal(fresh.commercePending(f.workspaceId, randomUUID()), undefined);
  await assert.rejects(fresh.reconcileCommerce(f.workspaceId, f.actorId));
  fresh.markCommerceCurrentRead(f.workspaceId, f.actorId, f.command, f.scope);
  mock(async request => { assert.equal(await request.text(), body); assert.equal(request.headers.get('idempotency-key'), f.command.idempotencyKey); return Response.json(reconcile(f)); });
  assert.equal(await fresh.reconcileCommerce(f.workspaceId, f.actorId), 'COMMITTED');
  assert.equal(fresh.commercePending(f.workspaceId, f.actorId), undefined);
});

test('NOT_FOUND permits only the same command and a late different-workflow read cannot authorize recovery', async () => {
  const f = fixture(); mock(async () => { throw Error('lost'); });
  await assert.rejects(client.writeCommerce(f.workspaceId, f.actorId, f.command));
  client.markCommerceCurrentRead(f.workspaceId, f.actorId, { ...f.command, workflowId: randomUUID() }, f.scope);
  assert.equal(client.commercePending(f.workspaceId, f.actorId)?.currentRead, false);
  mark(f); mock(async () => Response.json({ contractVersion: 'website-sales-commerce-reconcile-v1', status: 'NOT_FOUND', correlationId: f.command.correlationId }));
  assert.equal(await client.reconcileCommerce(f.workspaceId, f.actorId), 'NOT_FOUND');
  let writes = 0; mock(async request => { writes++; assert.equal(await request.text(), JSON.stringify(f.command)); return Response.json(f.receipt); });
  await assert.rejects(client.writeCommerce(f.workspaceId, f.actorId, { ...f.command, idempotencyKey: randomUUID() }, true));
  await assert.rejects(client.writeCommerce(f.workspaceId, f.actorId, { ...f.command, payload: { ...f.command.payload, subscriptionRef: { id: randomUUID(), version: 1, digest: 'b'.repeat(64) } } }, true));
  assert.equal(writes, 0);
  await client.writeCommerce(f.workspaceId, f.actorId, f.command, true);
  assert.equal(writes, 1);
});

test('foreign scope, stale versions and malformed commerce receipts retain UNKNOWN', async () => {
  for (const mutate of [
    (f: ReturnType<typeof fixture>) => { f.receipt.data.identity.companyId = randomUUID(); },
    (f: ReturnType<typeof fixture>) => { f.receipt.data.workflowId = randomUUID(); },
    (f: ReturnType<typeof fixture>) => { f.receipt.data.workflowVersion = 1; },
    (f: ReturnType<typeof fixture>) => { f.receipt.data.recordDigest = 'not-a-digest'; },
    (f: ReturnType<typeof fixture>) => { (f.receipt.data as { recordId: string | null }).recordId = null; },
  ]) {
    const f = fixture(); mutate(f); mock(async () => Response.json(f.receipt));
    await assert.rejects(client.writeCommerce(f.workspaceId, f.actorId, f.command));
    assert.equal(client.commercePending(f.workspaceId, f.actorId)?.state, 'UNKNOWN');
  }
});

test('reconciliation validates both the original receipt and the current scoped record before releasing the barrier', async () => {
  const f = fixture(); mock(async () => { throw Error('lost'); });
  await assert.rejects(client.writeCommerce(f.workspaceId, f.actorId, f.command)); mark(f);
  mock(async () => Response.json({ ...reconcile(f), currentData: { ...f.read, identity: { ...f.read.identity, projectId: randomUUID() } } }));
  await assert.rejects(client.reconcileCommerce(f.workspaceId, f.actorId));
  assert.equal(client.commercePending(f.workspaceId, f.actorId)?.state, 'UNKNOWN');
  mock(async () => Response.json(reconcile(f))); await client.reconcileCommerce(f.workspaceId, f.actorId);
  assert.equal(client.commercePending(f.workspaceId, f.actorId), undefined);
});

test('commerce and all existing Sales areas share an actor/workspace barrier including damaged recovery', async () => {
  const f = fixture(); saved.set(`novalure.website-sales-commerce.pending.v1:${f.actorId}:${f.workspaceId}`, 'damaged');
  assert.equal(client.commercePending(f.workspaceId, f.actorId)?.damaged, true);
  for (const area of ['workflow', 'studio', 'lifecycle', 'autonomy', 'conversation', 'enablement'] as const)
    assert.throws(() => assertSalesWriteBarrier(area, f.workspaceId, f.actorId), /RECONCILIATION_REQUIRED/);
  assert.doesNotThrow(() => assertSalesWriteBarrier('enablement', randomUUID(), f.actorId));
  assert.doesNotThrow(() => assertSalesWriteBarrier('enablement', f.workspaceId, randomUUID()));
  let dispatched = 0; mock(async () => { dispatched++; return Response.json(f.receipt); });
  await assert.rejects(client.writeCommerce(f.workspaceId, f.actorId, f.command));
  const other = fixture(); saved.set(`novalure.website-sales-enablement.pending.v1:${other.actorId}:${other.workspaceId}`, 'pending');
  await assert.rejects(client.writeCommerce(other.workspaceId, other.actorId, other.command));
  assert.equal(dispatched, 0);
});

test('unavailable durable storage refuses dispatch and a hanging body has a bounded UNKNOWN result', async () => {
  const f = fixture(), originalSet = storage.setItem; let dispatched = 0;
  mock(async () => { dispatched++; return Response.json(f.receipt); });
  storage.setItem = () => { throw Error('quota'); };
  try { await assert.rejects(client.writeCommerce(f.workspaceId, f.actorId, f.command)); } finally { storage.setItem = originalSet; }
  assert.equal(dispatched, 0);
  const hanging = fixture(); let cancelled = false;
  globalThis.setTimeout = ((handler: TimerHandler, delay?: number, ...args: unknown[]) => originalTimer(handler as (...values: unknown[]) => void, delay === 20000 ? 15 : delay, ...args)) as unknown as typeof setTimeout;
  try {
    mock(async () => new Response(new ReadableStream({ cancel() { cancelled = true; } })));
    await assert.rejects(client.writeCommerce(hanging.workspaceId, hanging.actorId, hanging.command));
    assert.equal(cancelled, true); assert.equal(client.commercePending(hanging.workspaceId, hanging.actorId)?.state, 'UNKNOWN');
  } finally { globalThis.setTimeout = originalTimer; }
});

test('browser commerce reads reject an unrelated workflow before rendering its financial or contract data', async () => {
  const f = fixture(); mock(async () => Response.json({ ...f.read, workflowId: randomUUID() }));
  await assert.rejects(client.readCommerce(f.workspaceId, f.scope, f.workflowId));
  mock(async request => { const url = new URL(request.url); assert.equal(url.searchParams.get('workflowId'), f.workflowId); assert.equal(url.searchParams.get('projectId'), f.scope.projectId); return Response.json(f.read); });
  const data = await client.readCommerce(f.workspaceId, f.scope, f.workflowId);
  assert.equal(data.workflowId, f.workflowId); assert.equal(data.canWrite, false);
});

test('a committed reconciliation can safely validate the same bounded large read accepted by GET', async () => {
  const f = fixture(); mock(async () => { throw Error('lost'); });
  await assert.rejects(client.writeCommerce(f.workspaceId, f.actorId, f.command)); mark(f);
  f.read.sourceEvents = Array.from({ length: 50 }, (_, index) => ({ contractVersion: 'website-sales-commerce-source-v1', eventId: randomUUID(), identity: { workspaceId: f.workspaceId, ...f.scope }, workflowId: f.workflowId,
    source: { system: 'PAYMENT_PROVIDER', provider: 'synthetic-unit', accountReference: 'unit', resourceType: 'payment', resourceId: `unit-${index}`, version: 1, digest: 'a'.repeat(64) },
    occurredAt: '2026-11-22T10:00:00.000Z', retrievedAt: '2026-11-22T10:00:00.000Z', verificationReceiptReference: 'synthetic-transport-fixture-not-provider-evidence', confidence: 'PROVIDER_VERIFIED', supersedesEventId: null,
    kind: 'PAYMENT', payload: { currency: 'EUR', amountMinor: 100, status: 'SETTLED', kind: 'PAYMENT', allocations: Array.from({ length: 100 }, () => ({ invoiceSourceEventId: randomUUID(), installmentId: randomUUID(), amountMinor: 1 })) } }));
  f.read.sourceAssessment.activeEventIds = f.read.sourceEvents.map(event => event.eventId);
  const result = reconcile(f); assert(new TextEncoder().encode(JSON.stringify(result)).byteLength > 524288);
  mock(async () => Response.json(result));
  assert.equal(await client.reconcileCommerce(f.workspaceId, f.actorId), 'COMMITTED');
  assert.equal(client.commercePending(f.workspaceId, f.actorId), undefined);
});
