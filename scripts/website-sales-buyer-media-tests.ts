import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { createBuyerGrantSecret, loadBuyerVideo } from '../src/lib/website-sales-buyer-media-client';

// Transport fixtures only. Three bytes are not a rendered demo video or a provider acceptance.
const originalFetch = globalThis.fetch, originalCreate = URL.createObjectURL;
after(() => { globalThis.fetch = originalFetch; URL.createObjectURL = originalCreate; });
const token = 'a'.repeat(43), bytes = new Uint8Array([0, 1, 2]), sha256 = createHash('sha256').update(bytes).digest('hex');
const asset = () => ({ mediaPath: `/api/public/website-sales/advisory/assets/${randomUUID()}`, sha256 });

test('buyer grant secrets have 32 fresh random bytes and a hash of the exact canonical token string', async () => {
  const first = await createBuyerGrantSecret(), second = await createBuyerGrantSecret();
  assert.equal(first.token.length, 43); assert.equal(Buffer.from(first.token, 'base64url').length, 32);
  assert.equal(first.tokenHash, createHash('sha256').update(first.token, 'utf8').digest('hex'));
  assert(first.token !== second.token, 'Each grant must use fresh cryptographic entropy');
});
test('buyer video uses a fixed same-origin path, a private header and a hash-confirmed temporary URL', async () => {
  let created = 0; URL.createObjectURL = value => { assert.equal(value.size, 3); created++; return 'blob:synthetic-transport'; };
  const reference = asset();
  globalThis.fetch = (async (input, init) => {
    assert.equal(input, reference.mediaPath); assert.equal(init?.redirect, 'error'); assert.equal(init?.cache, 'no-store'); assert.equal(init?.referrerPolicy, 'no-referrer');
    assert.equal(new Headers(init?.headers).get('x-sales-review-token'), token); assert(!String(input).includes(token));
    return new Response(bytes, { headers: { 'content-type': 'video/webm', 'content-length': '3' } });
  }) as typeof fetch;
  assert.equal(await loadBuyerVideo(token, reference), 'blob:synthetic-transport'); assert.equal(created, 1);
});
test('foreign or query-bearing media paths cannot receive the buyer token', async () => {
  let dispatched = 0; globalThis.fetch = (async () => { dispatched++; throw Error(); }) as typeof fetch;
  for (const mediaPath of ['https://external.example/video', '/api/public/website-sales/advisory/assets/id?grant=secret', '/api/crm/core', '/api/public/website-sales/advisory/assets/../private'])
    await assert.rejects(loadBuyerVideo(token, { mediaPath, sha256 }));
  assert.equal(dispatched, 0);
});
test('unavailable, oversized, wrong-type and hash-mismatched media never become browser URLs', async () => {
  let created = 0; URL.createObjectURL = () => { created++; return 'blob:unexpected'; };
  for (const response of [new Response(null, { status: 403 }), new Response(bytes, { headers: { 'content-type': 'text/html' } }),
    new Response(bytes, { headers: { 'content-type': 'video/mp4', 'content-length': '25000001' } }), new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'video/mp4' } })]) {
    globalThis.fetch = (async () => response) as typeof fetch;
    await assert.rejects(loadBuyerVideo(token, asset()));
  }
  assert.equal(created, 0);
});
