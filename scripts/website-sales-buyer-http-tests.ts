import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import type { AppSession } from '../src/lib/auth/session';
import { createWebsiteSalesBuyerHttp, type WebsiteSalesBuyerHttpPorts } from '../src/lib/website-sales-buyer-http';
import { advisoryBuyerCommandSchema } from '../src/lib/website-sales-advisory-types';
import { advisoryBuyerActorBindingHash } from '../src/lib/website-sales-advisory-domain';

function fixture() {
  const token = randomBytes(32).toString('base64url'), origin = 'https://crm.example.invalid';
  const session: AppSession = { authenticated: true, userId: randomUUID(), workspaceId: randomUUID(), workspaceName: 'Synthetic workspace', email: 'synthetic@example.invalid',
    name: 'Synthetic buyer', role: 'agent', permissions: [], productRole: 'customer_owner', productPermissions: [], source: 'cookie', authSessionId: randomUUID(), authIdentityId: randomUUID() };
  let actor: AppSession | null = session, lost = false, badReceipt = false, badProjection = false, badAsset = false, writes = 0, reads = 0, csrf = 0;
  const packetRef = { id: randomUUID(), version: 1, digest: 'a'.repeat(64) }, grantId = randomUUID(), stepId = randomUUID();
  const actorBindingHash = advisoryBuyerActorBindingHash({ principalUserId: session.userId, authIdentityId: session.authIdentityId!, workspaceId: session.workspaceId, grantId, packetRef });
  const command = advisoryBuyerCommandSchema.parse({ contractVersion: 'website-sales-advisory-buyer-v1', grantId, expectedGrantVersion: 1, packetRef,
    actorBindingHash, stepId, expectedStepVersion: 1, disposition: 'CONFIRMED', comment: null, idempotencyKey: randomUUID(), correlationId: randomUUID() });
  const projection = () => ({ contractVersion: 'website-sales-advisory-buyer-v1', grantId, grantVersion: 1, expiresAt: '2027-01-01T00:00:00Z', actorUserId: actor?.userId ?? null,
    authAssurance: actor ? 'AUTHENTICATED_ACCOUNT' : 'READ_ONLY_LINK', actorBindingHash: actor ? actorBindingHash : null, canWrite: actor !== null, blockers: [], packetRef, title: 'Synthetic approved packet', summary: 'Only approved customer information.',
    decisionCriteria: ['Accessible booking'], options: [{ label: 'Approved option', benefits: ['Clear booking'], limits: ['Scope stays as approved'] }],
    steps: [{ id: stepId, version: writes + 1, label: 'Discuss the next step', responsible: 'BUYER', dueAt: null, status: writes ? 'CONFIRMED' : 'PROPOSED' }], questions: [], demo: null, video: null,
    ...(badProjection ? { internalMargin: 'Must never be disclosed' } : {}) });
  const receipt = (replayed: boolean) => ({ contractVersion: 'website-sales-advisory-buyer-v1', persisted: true, commandId: randomUUID(), auditReference: randomUUID(),
    correlationId: command.correlationId, replayed, data: { grantId, grantVersion: 1, packetRef, actorBindingHash, actorUserId: badReceipt ? randomUUID() : session.userId,
      stepId, stepVersion: 2, questionId: null } });
  const bytes = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3]);
  const ports: WebsiteSalesBuyerHttpPorts = {
    trustedOrigin: origin, session: async () => actor,
    csrf: async () => { csrf++; return { ok: true }; },
    read: async received => { assert.equal(received, token); reads++; return projection(); },
    confirm: async (who, received, original) => {
      assert.equal(who.userId, session.userId); assert.equal(received, token); assert.deepEqual(original, command);
      writes++; if (lost) throw Error('Synthetic lost committed acknowledgement'); return receipt(false);
    },
    reconcile: async (who, received, original) => { assert.equal(who.userId, session.userId); assert.equal(received, token); assert.deepEqual(original, command);
      return { contractVersion: 'website-sales-advisory-buyer-reconcile-v1', status: 'COMMITTED', correlationId: command.correlationId, receipt: receipt(true), currentData: projection() }; },
    asset: async received => { assert.equal(received, token); return { bytes, mediaType: 'video/webm', sha256: badAsset ? '0'.repeat(64) : createHash('sha256').update(bytes).digest('hex'), filename: 'synthetic.webm' }; },
  };
  const request = (method = 'GET', path = '', patch: Record<string, string> = {}, body: unknown = command) => new Request(`${origin}/api/public/website-sales/advisory${path}`, {
    method, headers: { origin, 'sec-fetch-site': 'same-origin', 'x-sales-review-token': token, 'content-type': 'application/json',
      'idempotency-key': command.idempotencyKey, 'x-correlation-id': command.correlationId, ...patch }, ...(method === 'GET' ? {} : { body: JSON.stringify(body) }) });
  return { http: createWebsiteSalesBuyerHttp(ports), request, ports, session, token, command, bytes, counts: () => ({ writes, reads, csrf }),
    anonymous: () => { actor = null; }, headerActor: () => { actor = { ...session, source: 'headers' }; },
    lost: () => { lost = true; }, invalidReceipt: () => { badReceipt = true; }, invalidProjection: () => { badProjection = true; }, invalidAsset: () => { badAsset = true; } };
}

test('buyer bearer read exposes only the strict owner-published projection and never creates a write identity', async () => {
  const f = fixture(); f.anonymous(); const response = await f.http.GET(f.request()); assert.equal(response.status, 200);
  const data = await response.json(); assert.equal(data.canWrite, false); assert.equal(data.actorUserId, null); assert.equal(data.authAssurance, 'READ_ONLY_LINK');
  assert(!JSON.stringify(data).includes(f.token)); assert.match(response.headers.get('cache-control')!, /no-store/);
  assert.equal((await f.http.POST(f.request('POST'))).status, 401); assert.equal(f.counts().writes, 0);
});
test('foreign origins, query selectors, noncanonical tokens and development identity headers fail before store access', async () => {
  const f = fixture();
  assert.equal((await f.http.GET(f.request('GET', '', { origin: 'https://foreign.example.invalid' }))).status, 403);
  assert.equal((await f.http.GET(f.request('GET', '?workspaceId=foreign'))).status, 400);
  assert.equal((await f.http.GET(f.request('GET', '', { 'x-sales-review-token': 'x'.repeat(43) }))).status, 403);
  f.headerActor(); assert.equal((await f.http.GET(f.request())).status, 403); assert.equal(f.counts().reads, 0);
});
test('a committed buyer step with lost acknowledgement reconciles the exact original without another mutation', async () => {
  const f = fixture(); f.lost(); assert.equal((await f.http.POST(f.request('POST'))).status, 503);
  const response = await f.http.RECONCILE(f.request('POST', '/reconcile')); assert.equal(response.status, 200);
  const data = await response.json(); assert.equal(data.status, 'COMMITTED'); assert.equal(data.receipt.replayed, true);
  assert.equal(data.receipt.data.actorUserId, f.session.userId); assert.equal(f.counts().writes, 1); assert.equal(f.counts().csrf, 2);
});
test('a response attributed to another actor remains an unconfirmed outcome', async () => {
  const f = fixture(); f.invalidReceipt(); const response = await f.http.POST(f.request('POST'));
  assert.equal(response.status, 503); assert.equal((await response.json()).code, 'BUYER_OUTCOME_UNCONFIRMED'); assert.equal(f.counts().writes, 1);
});
test('the public boundary rejects accidental internal fields rather than forwarding them to the browser', async () => {
  const f = fixture(); f.invalidProjection(); const response = await f.http.GET(f.request());
  assert.equal(response.status, 503); assert(!await response.text().then(text => text.includes('internalMargin')));
});
test('video bytes require current narrow grant admission and a matching hash before an uncacheable response', async () => {
  const f = fixture(), response = await f.http.ASSET(f.request('GET', `/assets/${randomUUID()}`), randomUUID());
  assert.equal(response.status, 200); assert.equal(response.headers.get('content-type'), 'video/webm'); assert.match(response.headers.get('cache-control')!, /no-store/);
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), f.bytes);
  f.invalidAsset(); assert.equal((await f.http.ASSET(f.request(), randomUUID())).status, 503);
});
test('untrusted identity fields and mismatched original metadata never reach the buyer mutation port', async () => {
  const f = fixture();
  assert.equal((await f.http.POST(f.request('POST', '', {}, { ...f.command, actorUserId: f.session.userId }))).status, 400);
  assert.equal((await f.http.POST(f.request('POST', '', { 'idempotency-key': randomUUID() }))).status, 400);
  assert.equal(f.counts().writes, 0);
});
