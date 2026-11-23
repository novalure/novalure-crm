import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import { verifyCommerceSourceRequest, verifyCommerceSourcePull, type CommerceSourceConnection } from '../src/lib/website-sales-commerce-source';

function fixture() {
  const now = Date.now(), key = randomBytes(32), identity = { workspaceId: randomUUID(), projectId: randomUUID(), companyId: randomUUID(), locationId: randomUUID() };
  const connection: CommerceSourceConnection = { connectionId: randomUUID(), enabled: true, provider: 'synthetic-accounting-connector', accountReference: 'synthetic-book-only',
    identity, workflowId: randomUUID(), validUntil: new Date(now + 60_000).toISOString(), allowedSystems: ['PAYMENT_PROVIDER'], allowedKinds: ['PAYMENT'] };
  const event = { contractVersion: 'website-sales-commerce-source-v1', eventId: randomUUID(), identity, workflowId: connection.workflowId,
    source: { system: 'PAYMENT_PROVIDER', provider: connection.provider, accountReference: connection.accountReference, resourceType: 'payment', resourceId: 'synthetic-payment',
      version: 1, digest: createHash('sha256').update('synthetic actual source response').digest('hex') },
    occurredAt: new Date(now - 1000).toISOString(), retrievedAt: new Date(now - 500).toISOString(), verificationReceiptReference: 'caller-proof-is-not-authority',
    confidence: 'PROVIDER_VERIFIED', supersedesEventId: null, kind: 'PAYMENT', payload: { currency: 'EUR', amountMinor: 1000, status: 'SETTLED', kind: 'PAYMENT', allocations: [] } };
  const body = (value = event) => JSON.stringify({ contractVersion: 'website-sales-commerce-source-request-v1', jobId: randomUUID(), event: value });
  const headers = (raw: string) => { const timestamp = String(Math.floor(now / 1000)); return new Headers({ 'x-sales-source-id': connection.connectionId, 'x-sales-event-id': event.eventId,
    'x-sales-timestamp': timestamp, 'x-sales-signature': 'v1.' + createHmac('sha256', key).update(`website-sales-commerce-source-v1.${connection.connectionId}.${event.eventId}.${timestamp}.${raw}`).digest('base64url') }); };
  return { now, key, connection, event, body, headers };
}

test('actual raw-byte HMAC binds one source account workflow and resource; the host supplies its own retrieval proof', () => {
  const f = fixture(), raw = f.body(), result = verifyCommerceSourceRequest(raw, f.headers(raw), f.connection, f.key, f.now);
  assert.equal(result.event.kind, 'PAYMENT'); assert.equal(result.event.retrievedAt, new Date(f.now).toISOString());
  assert.notEqual(result.event.verificationReceiptReference, f.event.verificationReceiptReference);
  assert.equal(result.event.identity.workspaceId, f.connection.identity.workspaceId);
});
test('a JSON-equivalent but byte-different body, wrong secret or expired timestamp cannot establish provider facts', () => {
  const f = fixture(), raw = f.body();
  assert.throws(() => verifyCommerceSourceRequest(raw + ' ', f.headers(raw), f.connection, f.key, f.now), /UNAUTHORIZED/);
  assert.throws(() => verifyCommerceSourceRequest(raw, f.headers(raw), f.connection, randomBytes(32), f.now), /UNAUTHORIZED/);
  assert.throws(() => verifyCommerceSourceRequest(raw, f.headers(raw), { ...f.connection, validUntil: new Date(f.now + 600_000).toISOString() }, f.key, f.now + 301_000), /UNAUTHORIZED/);
});
test('even an authenticated connector cannot change company account workflow or registered event kinds', () => {
  const f = fixture();
  for (const patch of [
    { identity: { ...f.event.identity, companyId: randomUUID() } }, { workflowId: randomUUID() },
    { source: { ...f.event.source, accountReference: 'another-book' } },
  ]) { const raw = f.body({ ...f.event, ...patch }); assert.throws(() => verifyCommerceSourceRequest(raw, f.headers(raw), f.connection, f.key, f.now), /SCOPE_DENIED/); }
  const raw = f.body();
  assert.throws(() => verifyCommerceSourceRequest(raw, f.headers(raw), { ...f.connection, allowedKinds: ['INVOICE'] }, f.key, f.now), /SCOPE_DENIED/);
});
test('operator-recorded financial evidence cannot be promoted by sending it through a signed connector', () => {
  const f = fixture(), raw = f.body({ ...f.event, confidence: 'OPERATOR_RECORDED' });
  assert.throws(() => verifyCommerceSourceRequest(raw, f.headers(raw), f.connection, f.key, f.now), /SCOPE_DENIED/);
});

test('connector pull signatures bind the exact request and cannot be replayed as source-fact authority', () => {
  const f = fixture(), path = `/api/integrations/website-sales/commerce/requests?jobId=${randomUUID()}`;
  const timestamp = String(Math.floor(f.now / 1000));
  const headers = new Headers({ 'x-sales-source-id': f.connection.connectionId, 'x-sales-timestamp': timestamp,
    'x-sales-signature': 'v1.' + createHmac('sha256', f.key).update(`website-sales-commerce-pull-v1.${f.connection.connectionId}.${timestamp}.GET.${path}`).digest('base64url') });
  const request = new Request(`https://crm.example.invalid${path}`, { headers });
  assert.equal(verifyCommerceSourcePull(request, f.connection, f.key, f.now), new URL(request.url).searchParams.get('jobId'));
  assert.throws(() => verifyCommerceSourcePull(new Request(request.url + '&companyId=foreign', { headers }), f.connection, f.key, f.now), /UNAUTHORIZED/);
  assert.throws(() => verifyCommerceSourcePull(new Request(request.url.replace(/jobId=.*/, `jobId=${randomUUID()}`), { headers }), f.connection, f.key, f.now), /UNAUTHORIZED/);
  assert.throws(() => verifyCommerceSourcePull(request, f.connection, randomBytes(32), f.now), /UNAUTHORIZED/);
  assert.throws(() => verifyCommerceSourceRequest(f.body(), headers, f.connection, f.key, f.now), /UNAUTHORIZED/);
});
