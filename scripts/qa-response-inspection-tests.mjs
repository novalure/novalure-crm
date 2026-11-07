import assert from "node:assert/strict";
import test from "node:test";
import { createResponseInspectionBarrier } from "./lib/qa-response-inspection.mjs";

test("navigation waits for a response body after its request has completed", async () => {
  const barrier = createResponseInspectionBarrier();
  const request = {};
  barrier.started(request);
  let bodyDone;
  const body = new Promise(resolve => { bodyDone = resolve; });
  barrier.inspect(body);
  let navigated = false;
  const navigation = barrier.drain().then(() => { navigated = true; });
  barrier.finished(request);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(navigated, false);
  bodyDone();
  await navigation;
  assert.equal(navigated, true);
});

test("traffic starting during an earlier inspection is also drained", async () => {
  const barrier = createResponseInspectionBarrier();
  const first = {}, second = {};
  barrier.started(first);
  let navigated = false;
  const navigation = barrier.drain().then(() => { navigated = true; });
  barrier.started(second);
  barrier.finished(first);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(navigated, false);
  barrier.finished(second);
  await navigation;
});

test("failed/aborted traffic can finish, while incomplete traffic blocks navigation finitely", async () => {
  const barrier = createResponseInspectionBarrier();
  const aborted = {};
  barrier.started(aborted); barrier.finished(aborted);
  await barrier.drain(20);
  const incomplete = {};
  barrier.started(incomplete);
  await assert.rejects(barrier.drain(20), /before navigation timed out/);
  barrier.finished(incomplete);
  await barrier.drain(20);
});
import { webcrypto } from "node:crypto";
import { createServer } from 'node:http';
import { runInNewContext } from 'node:vm';
import { observeQaFetchBodies, requiresCrmDocumentReload, assertObservedFetchCoverage } from './lib/qa-response-inspection.mjs';

const turn = () => new Promise(resolve => setImmediate(resolve));
async function bounded(condition) {
  const deadline = Date.now() + 1000;
  while (!condition()) { assert.ok(Date.now() < deadline, 'bounded synthetic observation'); await new Promise(resolve => setTimeout(resolve, 5)); }
}
function observedFetch(perform, origin) {
  const reports = [], listeners = {};
  const world = { fetch: perform, URL, Request, Reflect, TextEncoder, crypto: webcrypto, setTimeout,
    __crmQaFetchReport: async event => { reports.push(event); },
    addEventListener: (name, callback) => { listeners[name] = callback; } };
  // Keep the actual global object used by the serialized browser init function.
  const context = { ...world, origin };
  runInNewContext(`(${observeQaFetchBodies.toString()})({origin})`, context);
  context.reports = reports; context.listeners = listeners;
  return context;
}

test('terminal response-body observation releases its matching request without requiring a second finish event', async () => {
  const barrier = createResponseInspectionBarrier(), request = {};
  barrier.started(request, { path: '/api/auth/session', method: 'POST' });
  const body = Promise.resolve('actual body'); barrier.inspect(body, request);
  await barrier.drain(30);
  assert.deepEqual(barrier.pendingInfo(), []);
  const old = createResponseInspectionBarrier(); old.started(request); old.inspect(Promise.resolve('body'));
  await assert.rejects(old.drain(20), /before navigation timed out/);
  old.finished(request);
});

test('terminal failed inspection preserves its error while releasing only the finished observation', async () => {
  const barrier = createResponseInspectionBarrier(), request = {}, errors = [];
  barrier.started(request);
  const body = Promise.reject(new Error('actual_body_failure')).catch(error => { errors.push(error.message); });
  barrier.inspect(body, request); await barrier.drain(30);
  assert.deepEqual(errors, ['actual_body_failure']);
});

test('heartbeat observer returns the identical native promise/response and consumes only its real clone with one POST', async () => {
  let calls = 0, nativePromise;
  const server = createServer((request, response) => {
    calls++; assert.equal(request.method, 'POST'); assert.equal(request.headers['x-novalure-csrf-token'], 'SYNTHETIC');
    response.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'synthetic=untouched; HttpOnly' });
    response.end(JSON.stringify({ marker: 'SYNTHETIC FOREIGN PRIVATE SENTINEL' }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const world = observedFetch((...args) => { nativePromise = fetch(...args); return nativePromise; }, origin);
    const returned = world.fetch(origin + '/api/auth/session', { method: 'POST', headers: { 'x-novalure-csrf-token': 'SYNTHETIC' } });
    assert.equal(returned, nativePromise);
    const response = await returned;
    await bounded(() => world.__crmQaFetchBodies.completed === 1);
    assert.equal(calls, 1); assert.equal(response.status, 200); assert.match(response.headers.get('set-cookie'), /untouched/);
    assert.equal(world.__crmQaFetchBodies.foreign, true);
    assert.equal((await response.json()).marker, 'SYNTHETIC FOREIGN PRIVATE SENTINEL');
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('heartbeat observer cannot turn an actual never-ending 200 JSON response into a completed body', async () => {
  const server = createServer((_request, response) => { response.writeHead(200, { 'content-type': 'application/json' }); response.write('{"unfinished":'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`, controller = new AbortController();
  try {
    const world = observedFetch(fetch, origin);
    const response = await world.fetch(origin + '/api/auth/session', { method: 'POST', signal: controller.signal });
    assert.equal(response.status, 200);
    await turn(); assert.equal(world.__crmQaFetchBodies.snapshot().pending, 1);
    const barrier = createResponseInspectionBarrier(), request = {};
    barrier.started(request, { path: '/api/auth/session', method: 'POST' });
    const actualBody = response.text(); barrier.inspect(actualBody, request);
    await assert.rejects(barrier.drain(30), /before navigation timed out/);
    assert.equal(world.__crmQaFetchBodies.completed, 0);
    controller.abort(); await assert.rejects(actualBody); await bounded(() => world.__crmQaFetchBodies.snapshot().pending === 0);
    assert.equal(world.__crmQaFetchBodies.errors[0], 'body_read_failed');
  } finally { controller.abort(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('fragment and identical CRM URLs require a fresh document; changed actual query scope already navigates', () => {
  assert.equal(requiresCrmDocumentReload('http://127.0.0.1/?workspaceId=a#settings', 'http://127.0.0.1/?workspaceId=a#dashboard'), true);
  assert.equal(requiresCrmDocumentReload('http://127.0.0.1/?workspaceId=a#bots', 'http://127.0.0.1/?workspaceId=a#bots'), true);
  assert.equal(requiresCrmDocumentReload('http://127.0.0.1/?workspaceId=a', 'http://127.0.0.1/?workspaceId=b#dashboard'), false);
});

test('general original fetch observer proves ordinary API GET bodies and keeps query/CSRF values out of reports', async () => {
  let calls = 0;
  const server = createServer((request, response) => { calls++; assert.match(request.url, /workspaceId=SYNTHETIC_PRIVATE_QUERY/); response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"assets":[]}'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const world = observedFetch(fetch, origin), url = origin + '/api/crm/expose-template-assets?workspaceId=SYNTHETIC_PRIVATE_QUERY';
    const response = await world.fetch(url, { headers: { 'x-novalure-csrf-token': 'SYNTHETIC_PRIVATE_HEADER' } });
    assert.deepEqual(await response.json(), { assets: [] });
    assert.equal((await world.__crmQaFetchBodies.drain(500)).ok, true);
    assert.equal(calls, 1);
    const terminal = world.reports.find(r => r.kind === 'terminal');
    assert.equal(terminal.bodyInspected, true); assert.match(terminal.bodySha256, /^[a-f0-9]{64}$/);
    assert.doesNotMatch(JSON.stringify(world.reports), /SYNTHETIC_PRIVATE_QUERY|SYNTHETIC_PRIVATE_HEADER/);
    assertObservedFetchCoverage([{ kind: 'request', key: terminal.key }, { kind: 'response', key: terminal.key, ok: true, json: true, status: 200 }], world.reports);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('never-headers GET remains pending until its original promise actually rejects on Abort', async () => {
  const server = createServer(() => {});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`, controller = new AbortController();
  try {
    const world = observedFetch(fetch, origin);
    const original = world.fetch(origin + '/api/crm/expose-template-assets', { signal: controller.signal });
    const rejection = assert.rejects(original, { name: 'AbortError' });
    const pending = await world.__crmQaFetchBodies.drain(30);
    assert.equal(pending.ok, false); assert.equal(pending.pendingInfo[0].phase, 'request'); assert.equal(pending.pendingInfo[0].status, null);
    controller.abort(); await rejection;
    assert.equal((await world.__crmQaFetchBodies.drain(500)).ok, true);
    const end = world.reports.find(r => r.kind === 'terminal');
    assert.equal(end.failedBeforeHeaders, true); assert.equal(end.signalAborted, true); assert.equal(end.bodyInspected, false);
  } finally { controller.abort(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('Abort event alone cannot retire an unresolved original fetch promise', async () => {
  const controller = new AbortController(), promise = new Promise(() => {});
  const world = observedFetch(() => promise, 'http://127.0.0.1');
  assert.equal(world.fetch('http://127.0.0.1/api/crm/expose-template-assets', { signal: controller.signal }), promise);
  controller.abort();
  const pending = await world.__crmQaFetchBodies.drain(30);
  assert.equal(pending.ok, false); assert.equal(pending.pending, 1); assert.equal(pending.pendingInfo[0].signalAborted, true);
  assert.equal(world.reports.some(r => r.kind === 'terminal'), false);
});

test('retired document pre-header GET is recorded as canceled read, while a pending POST remains failure', async () => {
  for (const method of ['GET', 'POST']) {
    const world = observedFetch(() => new Promise(() => {}), 'http://127.0.0.1');
    world.fetch('http://127.0.0.1/api/crm/expose-template-assets', { method });
    world.listeners.pagehide({ persisted: false });
    const state = await world.__crmQaFetchBodies.drain(500);
    const end = world.reports.find(r => r.kind === 'terminal');
    assert.equal(end.bodyInspected, false); assert.equal(end.status, null);
    if (method === 'GET') { assert.equal(end.retiredReadBeforeHeaders, true); assert.equal(state.ok, true); }
    else { assert.ok(end.bodyError); assert.equal(state.ok, false); }
  }
});

test('original/native coverage requires exact two-sided request and body multisets', () => {
  const key = 'a'.repeat(64), hash = 'b'.repeat(64);
  const start = { kind: 'start', key, path: '/api/crm/expose-template-assets', method: 'GET', id: 1, documentId: 'test' };
  const done = { ...start, kind: 'terminal', status: 200, json: true, bodyInspected: true, bodySha256: hash };
  const request = { kind: 'request', key }, response = { kind: 'response', key, ok: true, json: true, status: 200 };
  assert.throws(() => assertObservedFetchCoverage([request], []), /UNOBSERVED/);
  assert.throws(() => assertObservedFetchCoverage([request, response], [start]), /UNSETTLED/);
  assert.throws(() => assertObservedFetchCoverage([request, response, response], [start, done]), /UNINSPECTED/);
  // These unmatched extra observations passed the former one-sided comparison.
  assert.throws(() => assertObservedFetchCoverage([request, response], [start, done, { ...start, id: 2 }, { ...done, id: 2 }]), /UNMATCHED_ORIGINAL_FETCH_START/);
  assert.throws(() => assertObservedFetchCoverage([request, response], [start, done, { ...start, key: 'c'.repeat(64), id: 2 }, { ...done, key: 'c'.repeat(64), id: 2 }]), /UNMATCHED_ORIGINAL_FETCH_START/);
  assert.throws(() => assertObservedFetchCoverage([], [start, done]), /UNMATCHED_ORIGINAL_FETCH_START/);
  assert.throws(() => assertObservedFetchCoverage([request], [start, done]), /UNMATCHED_ORIGINAL_SUCCESSFUL_JSON_BODY/);
  assert.throws(() => assertObservedFetchCoverage([request, response, request], [start, done, { ...start, id: 2 }, { ...done, id: 2 }]), /UNMATCHED_ORIGINAL_SUCCESSFUL_JSON_BODY/);
  assertObservedFetchCoverage([request, response, request, response], [start, done, { ...start, id: 2 }, { ...done, id: 2 }]);
  assert.throws(() => assertObservedFetchCoverage([request, response], [start, { ...done, bodyError: 'body_read_failed' }]), /INSPECTION_FAILED/);
});

test('original/native coverage binds each terminal to its own exact start metadata', () => {
  const key = 'a'.repeat(64), path = '/api/crm/expose-template-assets', method = 'GET';
  const start = { kind: 'start', key, path, method, id: 1, documentId: 'test' };
  const done = { ...start, kind: 'terminal', status: 200, json: true, bodyInspected: true, bodySha256: 'b'.repeat(64) };
  const network = [{ kind: 'request', key }, { kind: 'response', key, ok: true, json: true, status: 200 }];
  for (const replacement of [{ key: 'c'.repeat(64) }, { path: '/api/crm/other' }, { method: 'POST' }, { id: 2 }, { documentId: 'other' }, { kind: 'unknown' }])
    assert.throws(() => assertObservedFetchCoverage(network, [start, { ...done, ...replacement }]), /UNBOUND_ORIGINAL_FETCH_TERMINAL/);
  // Equal aggregate counts cannot let the body for request2 serve request1.
  const otherStart = { ...start, key: 'c'.repeat(64), id: 2 };
  const otherDone = { ...done, key: otherStart.key, id: 2 };
  const otherNetwork = network.map(row => ({ ...row, key: otherStart.key }));
  assert.throws(() => assertObservedFetchCoverage([...network, ...otherNetwork], [start, otherStart, { ...done, key: otherStart.key }, { ...otherDone, key }]), /UNBOUND_ORIGINAL_FETCH_TERMINAL/);
  assert.throws(() => assertObservedFetchCoverage(network, [start, start, done]), /DUPLICATE_ORIGINAL_FETCH_START/);
  assert.throws(() => assertObservedFetchCoverage(network, [start, done, done]), /UNBOUND_ORIGINAL_FETCH_TERMINAL/);
  assert.throws(() => assertObservedFetchCoverage(network, [start, { ...done, status: undefined }]), /INVALID_ORIGINAL_BODY_PROOF/);
  assertObservedFetchCoverage(network, [start, done]);
});
