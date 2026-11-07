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
import { createServer } from 'node:http';
import { runInNewContext } from 'node:vm';
import { observeQaHeartbeatBodies, requiresCrmDocumentReload } from './lib/qa-response-inspection.mjs';

const turn = () => new Promise(resolve => setImmediate(resolve));
async function bounded(condition) {
  const deadline = Date.now() + 1000;
  while (!condition()) { assert.ok(Date.now() < deadline, 'bounded synthetic observation'); await new Promise(resolve => setTimeout(resolve, 5)); }
}
function observedFetch(perform, origin) {
  const world = { fetch: perform, URL, Request, Reflect };
  // Keep the actual global object used by the serialized browser init function.
  const context = { ...world, origin };
  runInNewContext(`(${observeQaHeartbeatBodies.toString()})({origin})`, context);
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
    await bounded(() => world.__crmQaHeartbeatBodies.completed === 1);
    assert.equal(calls, 1); assert.equal(response.status, 200); assert.match(response.headers.get('set-cookie'), /untouched/);
    assert.equal(world.__crmQaHeartbeatBodies.foreign, true);
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
    await turn(); assert.equal(world.__crmQaHeartbeatBodies.pending, 1);
    const barrier = createResponseInspectionBarrier(), request = {};
    barrier.started(request, { path: '/api/auth/session', method: 'POST' });
    const actualBody = response.text(); barrier.inspect(actualBody, request);
    await assert.rejects(barrier.drain(30), /before navigation timed out/);
    assert.equal(world.__crmQaHeartbeatBodies.completed, 0);
    controller.abort(); await assert.rejects(actualBody); await bounded(() => world.__crmQaHeartbeatBodies.pending === 0);
    assert.equal(world.__crmQaHeartbeatBodies.errors[0], 'heartbeat_body_read_failed');
  } finally { controller.abort(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('fragment and identical CRM URLs require a fresh document; changed actual query scope already navigates', () => {
  assert.equal(requiresCrmDocumentReload('http://127.0.0.1/?workspaceId=a#settings', 'http://127.0.0.1/?workspaceId=a#dashboard'), true);
  assert.equal(requiresCrmDocumentReload('http://127.0.0.1/?workspaceId=a#bots', 'http://127.0.0.1/?workspaceId=a#bots'), true);
  assert.equal(requiresCrmDocumentReload('http://127.0.0.1/?workspaceId=a', 'http://127.0.0.1/?workspaceId=b#dashboard'), false);
});
