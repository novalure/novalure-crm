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
