import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createCrmTeamRead, crmTeamResponseByteLimit } from "../src/lib/crm-team-reader";

const originalFetch = globalThis.fetch;
after(() => { globalThis.fetch = originalFetch; });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));

test("a scope retired before dispatch sends no request and cannot publish a result", async () => {
  let calls = 0; globalThis.fetch = async () => { calls++; return Response.json({ members: [] }); };
  const read = createCrmTeamRead("https://crm.example/api/crm/team"); read.retire();
  await assert.rejects(read.promise, { name: "AbortError" }); assert.equal(calls, 0); assert.equal(read.isCurrent(), false);
});
test("retirement after dispatch drains delayed headers instead of racing native header delivery", async () => {
  const headers = deferred<Response>(), started = deferred<AbortSignal>();
  globalThis.fetch = async (_input, init) => { started.resolve(init!.signal!); return headers.promise; };
  const read = createCrmTeamRead("https://crm.example/api/crm/team"), signal = await started.promise;
  read.retire(); assert.equal(signal.aborted, false);
  headers.resolve(Response.json({ members: [], workspaceId: "original-scope" }));
  assert.deepEqual((await read.promise).payload, { members: [], workspaceId: "original-scope" });
  assert.equal(read.isCurrent(), false); assert.equal(signal.aborted, false);
});
test("post-header retirement drains the actual stream and its independent clone without a late scope update", async () => {
  let stream!: ReadableStreamDefaultController<Uint8Array>, signal!: AbortSignal, cloneBody!: Promise<string>;
  const firstRead = deferred<void>(), payload = '{"members":[],"workspaceId":"original-scope"}';
  globalThis.fetch = async (_input, init) => {
    signal = init!.signal!;
    const response = new Response(new ReadableStream<Uint8Array>({ start(controller) { stream = controller; }, pull() { firstRead.resolve(); } }));
    signal.addEventListener("abort", () => stream.error(new DOMException("Aborted", "AbortError")), { once: true });
    cloneBody = response.clone().text(); return response;
  };
  const read = createCrmTeamRead("https://crm.example/api/crm/team"), published: unknown[] = [];
  const publication = read.promise.then(value => { if (read.isCurrent()) published.push(value.payload); });
  await firstRead.promise; stream.enqueue(new TextEncoder().encode(payload.slice(0, 12))); await tick(); read.retire();
  stream.enqueue(new TextEncoder().encode(payload.slice(12))); stream.close();
  await publication; assert.equal(await cloneBody, payload); assert.deepEqual(published, []); assert.equal(signal.aborted, false);
});
test("retiring after application EOF still leaves an independent successful body readable", async () => {
  let signal!: AbortSignal, clone!: Response;
  globalThis.fetch = async (_input, init) => { signal = init!.signal!; const response = Response.json({ members: [] }); clone = response.clone(); return response; };
  const read = createCrmTeamRead("https://crm.example/api/crm/team"); await read.promise; read.retire();
  assert.deepEqual(await clone.json(), { members: [] }); assert.equal(signal.aborted, false); assert.equal(read.isCurrent(), false);
});
test("the finite deadline aborts both missing headers and a stalled post-header body", async () => {
  let signal!: AbortSignal;
  globalThis.fetch = (_input, init) => { signal = init!.signal!; return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new DOMException("Deadline", "AbortError")), { once: true })); };
  const before = createCrmTeamRead("https://crm.example/api/crm/team", 15); await assert.rejects(before.promise); assert.equal(signal.aborted, true);
  let cancelled = false;
  globalThis.fetch = async (_input, init) => { signal = init!.signal!; return new Response(new ReadableStream({ cancel() { cancelled = true; } })); };
  const after = createCrmTeamRead("https://crm.example/api/crm/team", 15); await tick(); after.retire();
  await assert.rejects(after.promise, /deadline/); assert.equal(cancelled, true); assert.equal(signal.aborted, true);
});
test("byte limits count UTF-8 and malformed or partial JSON never become a successful team result", async () => {
  let signal!: AbortSignal, cancelled = false;
  globalThis.fetch = async (_input, init) => { signal = init!.signal!; return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("€".repeat(Math.floor(crmTeamResponseByteLimit / 3) + 1))); }, cancel() { cancelled = true; } })); };
  await assert.rejects(createCrmTeamRead("https://crm.example/api/crm/team").promise, /byte limit/); assert.equal(cancelled, true); assert.equal(signal.aborted, true);
  for (const body of [new Uint8Array([0xc0, 0xaf]), new TextEncoder().encode('{"members":[')]) {
    globalThis.fetch = async () => new Response(body); await assert.rejects(createCrmTeamRead("https://crm.example/api/crm/team").promise);
  }
});
