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
import { readFileSync } from 'node:fs';
import { observeQaFetchBodies, requiresCrmDocumentReload, assertObservedFetchCoverage, collectFetchLifecycleDiagnostics } from './lib/qa-response-inspection.mjs';

const turn = () => new Promise(resolve => setImmediate(resolve));
async function bounded(condition) {
  const deadline = Date.now() + 1000;
  while (!condition()) { assert.ok(Date.now() < deadline, 'bounded synthetic observation'); await new Promise(resolve => setTimeout(resolve, 5)); }
}
function observedFetch(perform, origin, { report, observerSource } = {}) {
  const reports = [], listeners = {};
  const world = { fetch: perform, URL, Request, AbortSignal, DOMException, Reflect, TextEncoder, crypto: webcrypto, setTimeout,
    __crmQaFetchReport: report ? event => report(event, reports) : async event => { reports.push(event); },
    addEventListener: (name, callback) => { listeners[name] = callback; } };
  // Keep the actual global object used by the serialized browser init function.
  const context = { ...world, origin };
  runInNewContext(`(${observerSource ?? observeQaFetchBodies.toString()})({origin})`, context);
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

test('pre-aborted actual GET has no dispatch, preserves its native promise and cannot hide any native request or body', async () => {
  let requests = 0, nativePromise;
  const server = createServer((_request, response) => { requests++; response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"actual":true}'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`, url = origin + '/api/crm/team';
  try {
    const world = observedFetch((...args) => { nativePromise = fetch(...args); return nativePromise; }, origin);
    const controller = new AbortController(); controller.abort();
    const original = world.fetch(url, { signal: controller.signal });
    assert.equal(original, nativePromise); await assert.rejects(original, error => error === controller.signal.reason && error.name === 'AbortError');
    assert.equal((await world.__crmQaFetchBodies.drain(500)).ok, true);
    assert.equal(requests, 0); const done = world.reports.find(row => row.kind === 'terminal');
    assert.equal(done.signalAbortedAtStart, true); assert.equal(done.preAbortedNoDispatch, true); assert.equal(done.bodyInspected, false);
    assertObservedFetchCoverage([], world.reports);
    assert.throws(() => assertObservedFetchCoverage([{ kind: 'request', key: done.key }], world.reports), /UNOBSERVED_NATIVE_FETCH_REQUEST/);
    assert.throws(() => assertObservedFetchCoverage([{ kind: 'response', key: done.key, ok: true, json: true, status: 200 }], world.reports), /UNINSPECTED_NATIVE_SUCCESSFUL_JSON_BODY/);
    // A separate actual call to the identical URL still needs its full native
    // request and completed JSON body; the canceled call cannot supply either.
    const response = await world.fetch(url); assert.deepEqual(await response.json(), { actual: true });
    assert.equal((await world.__crmQaFetchBodies.drain(500)).ok, true); assert.equal(requests, 1);
    const native = [{ kind: 'request', key: done.key }, { kind: 'response', key: done.key, ok: true, json: true, status: 200 }];
    assertObservedFetchCoverage(native, world.reports);
    assert.throws(() => assertObservedFetchCoverage([], world.reports), /UNMATCHED_ORIGINAL_FETCH_START/);
    assert.throws(() => assertObservedFetchCoverage([...native, native[0]], world.reports), /UNOBSERVED_NATIVE_FETCH_REQUEST/);
    assert.throws(() => assertObservedFetchCoverage([...native, native[1]], world.reports), /UNINSPECTED_NATIVE_SUCCESSFUL_JSON_BODY/);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('pre-aborted dispatch proof excludes late Abort, event-only, POST, keepalive and forged terminal metadata', async () => {
  for (const mode of ['late', 'POST', 'keepalive', 'other-reason', 'accessor']) {
    const controller = new AbortController(); if (mode !== 'late') controller.abort();
    let reject; const promise = new Promise((_, rejectPromise) => { reject = rejectPromise; });
    const world = observedFetch(() => promise, 'http://127.0.0.1');
    const init = { signal: controller.signal, method: mode === 'POST' ? 'POST' : 'GET', keepalive: mode === 'keepalive' };
    if (mode === 'accessor') Object.defineProperty(init, 'signal', { get: () => controller.signal });
    assert.equal(world.fetch('http://127.0.0.1/api/crm/team', init), promise);
    if (mode === 'late') controller.abort();
    const error = mode === 'other-reason' ? new DOMException('synthetic distinct object', 'AbortError') : controller.signal.reason;
    const rejection = assert.rejects(promise); reject(error); await rejection;
    await world.__crmQaFetchBodies.drain(500);
    assert.equal(world.reports.find(row => row.kind === 'terminal').preAbortedNoDispatch, false);
    assert.throws(() => assertObservedFetchCoverage([], world.reports), /UNMATCHED_ORIGINAL_FETCH_START/);
  }
  const controller = new AbortController(); controller.abort();
  const unresolved = observedFetch(() => new Promise(() => {}), 'http://127.0.0.1');
  unresolved.fetch('http://127.0.0.1/api/crm/team', { signal: controller.signal });
  assert.equal((await unresolved.__crmQaFetchBodies.drain(30)).ok, false);
  await bounded(() => unresolved.reports.some(row => row.kind === 'start'));
  assert.throws(() => assertObservedFetchCoverage([], unresolved.reports), /UNSETTLED_ORIGINAL_FETCH_LIFECYCLE/);
  const world = observedFetch(() => Promise.reject(controller.signal.reason), 'http://127.0.0.1');
  await assert.rejects(world.fetch('http://127.0.0.1/api/crm/team', { signal: controller.signal }));
  assert.equal((await world.__crmQaFetchBodies.drain(500)).ok, true);
  for (const change of [{ signalAbortedAtStart: false }, { rejectedWithOriginalAbortReason: false }, { failedBeforeHeaders: false }, { signalAborted: false }, { keepalive: true }, { phase: 'body-eof' }, { status: 200 }, { json: true }, { bodyInspected: true }, { bodySha256: 'a'.repeat(64) }])
    assert.throws(() => assertObservedFetchCoverage([], world.reports.map(row => row.kind === 'terminal' ? { ...row, ...change } : row)), /INVALID_PREABORTED_FETCH_PROOF/);
  assert.throws(() => assertObservedFetchCoverage([], world.reports.map(row => row.kind === 'terminal' ? { ...row, path: '/api/crm/other' } : row)), /UNBOUND_ORIGINAL_FETCH_TERMINAL/);
});

test('finite quiet deadline cannot pass or conceal the last original/native coverage failure', async () => {
  const world = observedFetch(fetch, 'http://127.0.0.1');
  const short = await world.__crmQaFetchBodies.drain(75);
  assert.equal(short.ok, false); assert.equal(short.timedOut, true); assert.equal(short.pending, 0); assert.equal(short.bridgesPending, 0);
  assert.ok(short.quietTurns < 2);
  const text = readFileSync(new URL('./qa-design-c-integration.mjs', import.meta.url), 'utf8');
  const implementation = text.slice(text.indexOf('async function drainResponseInspections('), text.indexOf('\nasync function gotoAfterInspection('));
  assert.ok(implementation.startsWith('async function drainResponseInspections('));
  let now = 0, evaluated = 0;
  const key = 'a'.repeat(64), page = { url: () => 'http://127.0.0.1/', async evaluate() { return ++evaluated === 1 ? { ok: true } : short; } };
  const context = { Date: { now: () => now }, Error, JSON, Promise,
    setTimeout: callback => { now += 25; callback(); },
    responseBarriers: { get: () => ({ drain: async () => {} }) },
    fetchAudit: () => ({ network: [{ kind: 'request', key }], observations: [] }),
    assertObservedFetchCoverage, privateLeaks: [] };
  runInNewContext(implementation + ';globalThis.run = drainResponseInspections;', context);
  await assert.rejects(context.run(page), error => error.message.includes('"timedOut":true') && error.message.includes('"lastCoverageError":{"code":"UNOBSERVED_NATIVE_FETCH_REQUEST"') && error.message.includes('"nativeCount":1') && error.message.includes('"originalCount":0'));
  assert.equal(evaluated, 2); assert.equal(now, 25);
});

test('synchronous lifecycle delivery survives immediate document destruction; exact former deferral loses its terminal', async () => {
  const current = observeQaFetchBodies.toString();
  // Exact former FD report block. Only the reporting block is substituted;
  // both cases execute the same original fetch/pagehide lifecycle code.
  const formerReport = `const report = (kind, e) => {
    const task = e.keyPromise.then(async key => {
      e.key = key;
      await globalThis.__crmQaFetchReport({ kind, ...metadata(e) });
    }).catch(() => { state.errors.push("fetch_observer_bridge_failed"); });
    bridges.add(task); void task.finally(() => bridges.delete(task));
  };`;
  const former = current.replace(/const report = \(kind, e\) => \{[\s\S]*?\n  \};/, formerReport);
  assert.notEqual(former, current);
  for (const observerSource of [former, current]) {
    let destroyed = false, calls = 0;
    const promise = new Promise(() => {}), init = { method: 'GET' };
    const world = observedFetch((_url, actualInit) => { calls++; assert.equal(actualInit, init); return promise; }, 'http://127.0.0.1', {
      observerSource, report(event, reports) { if (destroyed) throw Error('synthetic document destroyed'); reports.push(event); },
    });
    assert.equal(world.fetch('http://127.0.0.1/api/crm/team', init), promise);
    await bounded(() => world.reports.some(row => row.kind === 'start'));
    const key = world.reports[0].key; assert.match(key, /^[a-f0-9]{64}$/);
    world.listeners.pagehide({ persisted: false }); destroyed = true;
    const sentSynchronously = world.reports.some(row => row.kind === 'terminal');
    await turn(); assert.equal(calls, 1);
    if (observerSource === former) {
      assert.equal(sentSynchronously, false);
      assert.equal(world.reports.some(row => row.kind === 'terminal'), false);
      assert.throws(() => assertObservedFetchCoverage([{ kind: 'request', key }], world.reports), /UNSETTLED_ORIGINAL_FETCH_LIFECYCLE/);
    } else {
      assert.equal(sentSynchronously, true);
      const end = world.reports.find(row => row.kind === 'terminal');
      assert.equal(end.retiredReadBeforeHeaders, true); assert.equal(end.bodyInspected, false); assert.equal(end.status, null);
      assertObservedFetchCoverage([{ kind: 'request', key }], world.reports);
    }
  }
});

test('synchronous lifecycle reporting retains pending writes, keepalive and real JSON EOF requirements', async () => {
  for (const init of [{ method: 'POST' }, { method: 'GET', keepalive: true }]) {
    const world = observedFetch(() => new Promise(() => {}), 'http://127.0.0.1');
    world.fetch('http://127.0.0.1/api/crm/team', init);
    await bounded(() => world.reports.some(row => row.kind === 'start'));
    world.listeners.pagehide({ persisted: false });
    const end = world.reports.find(row => row.kind === 'terminal');
    assert.ok(end.bodyError); assert.equal(end.bodyInspected, false);
    assert.throws(() => assertObservedFetchCoverage([{ kind: 'request', key: end.key }], world.reports), /ORIGINAL_FETCH_BODY_INSPECTION_FAILED/);
  }
  for (const eofBeforeRetirement of [false, true]) {
    let stream; const response = new Response(new ReadableStream({ start(controller) { stream = controller; } }), { headers: { 'content-type': 'application/json' } });
    const native = Promise.resolve(response), world = observedFetch(() => native, 'http://127.0.0.1');
    const returned = world.fetch('http://127.0.0.1/api/crm/team'); assert.equal(returned, native); assert.equal(await returned, response);
    await bounded(() => world.reports.some(row => row.kind === 'start'));
    if (eofBeforeRetirement) { stream.enqueue(new TextEncoder().encode('{"actual":true}')); stream.close(); await bounded(() => world.reports.some(row => row.kind === 'terminal')); }
    world.listeners.pagehide({ persisted: false });
    const end = world.reports.find(row => row.kind === 'terminal');
    const network = [{ kind: 'request', key: end.key }, { kind: 'response', key: end.key, status: 200, ok: true, json: true }];
    if (eofBeforeRetirement) { assert.equal(end.bodyInspected, true); assertObservedFetchCoverage(network, world.reports); }
    else { assert.ok(end.bodyError); assert.equal(end.bodyInspected, false); assert.throws(() => assertObservedFetchCoverage(network, world.reports)); stream.error(Error('synthetic retired stream')); }
  }
});

test('synchronous lifecycle bridge failures and complete bounded diagnostics cannot silently pass or expose extra fields', async () => {
  for (const asyncFailure of [false, true]) {
    const world = observedFetch(() => new Promise(() => {}), 'http://127.0.0.1', { report(event, reports) {
      if (event.kind === 'start') { reports.push(event); return Promise.resolve(); }
      const error = Error('SYNTHETIC_PRIVATE_BRIDGE_REASON'); if (asyncFailure) return Promise.reject(error); throw error;
    } });
    world.fetch('http://127.0.0.1/api/crm/team');
    await bounded(() => world.reports.some(row => row.kind === 'start'));
    world.listeners.pagehide({ persisted: false });
    const drained = await world.__crmQaFetchBodies.drain(500);
    assert.equal(drained.ok, false); assert.equal(drained.bridgesPending, 0);
    assert.equal(drained.errors[0], 'fetch_observer_bridge_failed'); assert.doesNotMatch(JSON.stringify(drained), /SYNTHETIC_PRIVATE_BRIDGE_REASON/);
  }
  const first = { kind: 'start', documentId: 'old-document', id: 3, key: 'a'.repeat(64), path: '/api/crm/team', method: 'GET', url: 'SYNTHETIC_PRIVATE_URL', abortReason: 'SYNTHETIC_PRIVATE_REASON', body: 'SYNTHETIC_PRIVATE_BODY' };
  const next = { ...first, documentId: 'next-document', id: 1 };
  const rows = [first, next, { ...next, kind: 'terminal', bodyInspected: false }], audit = [{ observations: rows }];
  const diagnostic = collectFetchLifecycleDiagnostics(audit);
  assert.equal(diagnostic.complete, true); assert.equal(diagnostic.total, 3); assert.equal(diagnostic.events.length, 3);
  assert.equal(diagnostic.missingTerminalCount, 1); assert.deepEqual(diagnostic.missingTerminalExamples[0], { documentId: first.documentId, id: 3, key: first.key, path: first.path, method: 'GET' });
  assert.doesNotMatch(JSON.stringify(diagnostic), /SYNTHETIC_PRIVATE_/);
  assert.throws(() => assertObservedFetchCoverage([], rows), error => error.message === 'UNSETTLED_ORIGINAL_FETCH_LIFECYCLE' && error.coverage.missingTerminalExamples[0].documentId === first.documentId);
  const overflow = collectFetchLifecycleDiagnostics([{ observations: Array.from({ length: 4001 }, (_, id) => ({ ...first, id })) }]);
  assert.equal(overflow.complete, false); assert.equal(overflow.total, 4001); assert.equal(overflow.events.length, 4000); assert.equal(overflow.missingTerminalExamples.length, 10);
  assert.equal(rows.length, 3); assert.equal(audit[0].observations, rows);
});
