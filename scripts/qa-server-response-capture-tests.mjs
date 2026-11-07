import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once, EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { spawn } from "node:child_process";
import { observeQaServerResponse, qaRequestFingerprint, qualifyQaServerBodies, createQaCaptureRelay, requestQaCaptureSnapshot, answerQaCaptureRequest } from "./lib/qa-server-response-capture.mjs";
import { assertObservedFetchCoverage, parseQaFetchBindingMessage, safeQaFetchDiagnostic, collectFetchLifecycleDiagnostics } from "./lib/qa-response-inspection.mjs";

const secret = "b".repeat(64), runId = "a".repeat(32), doc = "1794075165538-0.7775903198219385";
const sha = value => createHash("sha256").update(value).digest("hex");
function row(key, extra = {}) { return { kind: "terminal", documentId: doc, id: 1, key, path: "/api/crm/team", method: "GET", phase: "body", status: 200, json: true,
  bodyInspected: false, signalAborted: true, signalAbortedAtStart: false, keepalive: false, foreign: false, bodyError: "body_read_failed", bodySha256: null,
  failedBeforeHeaders: false, retiredReadBeforeHeaders: false, preAbortedNoDispatch: false, rejectedWithOriginalAbortReason: false, ...extra }; }
function audit(origin, headers, status = 200) {
  const url = origin + "/api/crm/team?workspaceId=SYNTHETIC_PRIVATE_QUERY", key = sha("GET\0" + url), captureKey = qaRequestFingerprint(secret, "GET", url, headers);
  return { key, captureKey, network: [{ kind: "request", key, captureKey }, { kind: "response", key, status, ok: status >= 200 && status < 300, json: true }],
    observations: [row(key, { kind: "start", phase: "request", status: null, json: false, signalAborted: false, bodyError: null }), row(key)] };
}
async function fixture(handler) {
  const records = []; let id = 0, origin;
  const server = createServer((request, response) => {
    observeQaServerResponse(request, response, { origin, secret, runId, id: ++id, emit: row => records.push(row) });
    handler(request, response);
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening"); origin = `http://127.0.0.1:${server.address().port}`;
  return { records, origin, stop: async () => { server.closeAllConnections(); server.close(); await once(server, "close"); } };
}

test("actual server bytes and finish resolve a late-aborted original body without another request or response change", async () => {
  let calls = 0;
  const body = '{"members":[{"name":"SYNTHETIC_ONLY"}]}', headers = { cookie: "synthetic_session=OWN_ONLY", accept: "application/json", "user-agent": "Synthetic transport", "sec-fetch-mode": "cors" };
  const f = await fixture((_request, response) => { calls++; response.writeHead(200, { "content-type": "application/json", "set-cookie": "synthetic=untouched; HttpOnly" }); response.end(body); });
  try {
    const controller = new AbortController();
    const response = await fetch(f.origin + "/api/crm/team?workspaceId=SYNTHETIC_PRIVATE_QUERY", { headers, signal: controller.signal });
    const clone = response.clone(); controller.abort(); await assert.rejects(() => clone.text());
    assert.equal(response.status, 200); assert.equal(response.headers.get("set-cookie"), "synthetic=untouched; HttpOnly");
    const terminal = f.records.find(row => row.kind === "terminal");
    assert(terminal?.complete && terminal.terminal === "finish"); assert.equal(terminal.bodySha256, sha(body));
    const a = audit(f.origin, headers); assert.equal(a.captureKey, terminal.captureKey);
    assert.throws(() => assertObservedFetchCoverage(a.network, a.observations), /UNINSPECTED_NATIVE_SUCCESSFUL_JSON_BODY/);
    const proof = qualifyQaServerBodies(a.network, a.observations, f.records, runId);
    assert.equal(proof.size, 1); assert.doesNotThrow(() => assertObservedFetchCoverage(a.network, a.observations, proof));
    assert.equal(calls, 1); assert.equal(a.observations[1].bodyError, "body_read_failed"); assert.equal(a.observations[1].bodyInspected, false);
    assert.doesNotMatch(JSON.stringify(f.records), /OWN_ONLY|SYNTHETIC_PRIVATE_QUERY|SYNTHETIC_ONLY/);
    for (const mutate of [x => x.records[1].complete = false, x => x.records[1].terminal = "close", x => x.records[1].bodySha256 = null,
      x => x.records[1].foreign = true, x => x.records[1].inspectionError = "encoded_body_limit", x => x.network.push({ ...x.network[0] }),
      x => x.records[0].captureKey = "f".repeat(64),
      x => x.network[0].captureKey = qaRequestFingerprint(secret, "GET", f.origin + "/api/crm/team?workspaceId=SYNTHETIC_PRIVATE_QUERY", { ...headers, cookie: "OTHER_SYNTHETIC_SESSION" }),
      x => x.records.push({ ...x.records[0], id: 2 }), x => x.observations[1].signalAbortedAtStart = true,
      x => x.observations[1].keepalive = true, x => x.observations[1].method = "POST", x => x.observations[1].bodyError = "clone_failed"]) {
      const x = structuredClone({ ...a, records: f.records }); mutate(x);
      let proofs = new Map(); try { proofs = qualifyQaServerBodies(x.network, x.observations, x.records, runId); } catch { /* malformed proof is denied */ }
      assert.equal(proofs.size, 0); assert.throws(() => assertObservedFetchCoverage(x.network, x.observations, proofs));
    }
    assert.notEqual(qaRequestFingerprint(secret, "GET", f.origin + "/api/crm/team", { cookie: "SESSION_A" }), qaRequestFingerprint(secret, "GET", f.origin + "/api/crm/team", { cookie: "SESSION_B" }));
  } finally { await f.stop(); }
});

test("real incomplete/never-ending HTTP responses, oversized bytes and encoded JSON never manufacture EOF", async () => {
  for (const mode of ["truncated", "never", "overflow", "gzip", "length-mismatch"]) {
    const body = '{"ok":true}', f = await fixture((_request, response) => {
      response.writeHead(200, { "content-type": "application/json", ...(mode === "gzip" ? { "content-encoding": "gzip" } : {}), ...(mode === "length-mismatch" ? { "content-length": body.length + 1 } : {}) });
      if (mode === "gzip") response.end(gzipSync(body));
      else if (mode === "overflow") response.end(Buffer.alloc(2 * 1024 * 1024 + 1, "x"));
      else if (mode === "length-mismatch") response.end(body);
      else { response.write('{"unfinished":'); if (mode === "truncated") setTimeout(() => response.destroy(), 25); }
    });
    try {
      const controller = new AbortController(), response = await fetch(f.origin + "/api/crm/team?workspaceId=SYNTHETIC_PRIVATE_QUERY", { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(500)]), redirect: "error" });
      if (mode === "never") { assert.equal(f.records.filter(row => row.kind === "terminal").length, 0); controller.abort(); }
      try { await response.text(); } catch { /* An actual broken body is the negative control. */ }
      await new Promise(resolve => setTimeout(resolve, 40));
      const terminal = f.records.find(row => row.kind === "terminal"); assert(terminal);
      if (mode === "gzip") { assert(terminal.complete); assert.equal(terminal.bodySha256, sha(body)); }
      else if (mode === "overflow") { assert.equal(terminal.complete, false); assert.equal(terminal.inspectionError, "encoded_body_limit"); assert.equal(terminal.bodySha256, null); }
      else if (mode === "length-mismatch") { assert.equal(terminal.complete, false); assert.equal(terminal.bodySha256, null); }
      else { assert.equal(terminal.complete, false); assert.equal(terminal.terminal, "close"); assert.equal(terminal.bodySha256, null); }
    } finally { await f.stop(); }
  }
});

test("concurrent same-URL same-session requests require the complete inspected multiset, never a guessed FIFO body", async () => {
  for (const incomplete of [false, true]) {
    let calls = 0;
    const headers = { cookie: "SYNTHETIC_SESSION", accept: "application/json", "user-agent": "Synthetic transport", "sec-fetch-mode": "cors" };
    const f = await fixture((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      if (++calls === 2 && incomplete) response.write('{"unfinished":');
      else response.end(JSON.stringify({ actualRequest: calls }));
    });
    try {
      const controllers = [new AbortController(), new AbortController()];
      const responses = await Promise.all(controllers.map(controller => fetch(f.origin + "/api/crm/team?workspaceId=SYNTHETIC_PRIVATE_QUERY", { headers, signal: controller.signal, redirect: "error" })));
      const clones = responses.map(response => response.clone()); controllers.forEach(controller => controller.abort());
      await Promise.all(clones.map(clone => assert.rejects(() => clone.text())));
      await new Promise(resolve => setTimeout(resolve, 50));
      const a = audit(f.origin, headers); a.network.push(...structuredClone(a.network));
      a.observations.push(...structuredClone(a.observations).map(row => ({ ...row, id: 2 })));
      const proofs = qualifyQaServerBodies(a.network, a.observations, f.records, runId);
      if (incomplete) { assert.equal(proofs.size, 0); assert.throws(() => assertObservedFetchCoverage(a.network, a.observations, proofs)); }
      else {
        assert.equal(proofs.size, 2); assert.doesNotThrow(() => assertObservedFetchCoverage(a.network, a.observations, proofs));
        for (const proof of proofs.values()) { assert.equal(proof.bodyHashes.length, 2); assert.equal(proof.nativeRequestCount, 2); assert.equal(proof.resolvedBodyCount, 2); assert.equal(proof.serverId, undefined); }
      }
      assert.equal(calls, 2);
    } finally { await f.stop(); }
  }
});

test("native copied CDP metadata survives context removal; old exposeBinding lookup loses the same four terminals", async () => {
  const source = row("c".repeat(64), { phase: "document-retired-before-headers", status: null, json: false, signalAborted: false,
    bodyError: null, retiredReadBeforeHeaders: true });
  const payloads = [1, 2, 3, 4].map(id => ({ name: "__crmQaFetchReport", executionContextId: 17, payload: JSON.stringify({ ...source, id }) }));
  const contexts = new Map([[17, {}]]), old = [];
  const oldCalls = payloads.map(async message => { await Promise.resolve(); if (contexts.has(message.executionContextId)) old.push(JSON.parse(message.payload)); });
  contexts.delete(17); await Promise.all(oldCalls); assert.equal(old.length, 0);
  const copied = payloads.map(parseQaFetchBindingMessage); assert.deepEqual(copied.map(row => row.id), [1, 2, 3, 4]);
  for (const change of [x => x.payload = JSON.stringify({ ...source, url: "https://private.invalid/?secret=NO_OUTPUT" }),
    x => x.payload = JSON.stringify({ ...source, path: "/api/crm/team?private=1" }), x => x.payload = "x".repeat(8192),
    x => x.payload = JSON.stringify({ ...source, bodyInspected: true }), x => x.executionContextId = null]) {
    const x = structuredClone(payloads[0]); change(x); assert.throws(() => parseQaFetchBindingMessage(x));
  }
});

test("actual Node preload uses the existing HTTP diagnostic channel and emits bounded metadata only over owned IPC", async () => {
  const probe = createServer(); probe.listen(0, "127.0.0.1"); await once(probe, "listening");
  const port = probe.address().port; probe.close(); await once(probe, "close");
  const origin = `http://127.0.0.1:${port}`;
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(path|systemroot|windir|temp|tmp|tmpdir)$/i.test(key)));
  env.CRM_QA_SERVER_RESPONSE_CAPTURE = JSON.stringify({ syntheticOnly: true, origin, secret, runId });
  const source = `import {createServer} from 'node:http';const s=createServer((q,r)=>{r.writeHead(200,{'content-type':'application/json','x-synthetic':'unchanged'});r.end('{"actual":true}');});s.listen(${port},'127.0.0.1',()=>console.log('READY'));`;
  const child = spawn(process.execPath, ["--import", new URL("./lib/qa-server-response-preload.mjs", import.meta.url).href, "--input-type=module", "-e", source],
    { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  const exited = once(child, "exit"); let output = "", errors = "";
  const relay = createQaCaptureRelay(); child.on("message", message => relay.accept(message));
  child.stdout.on("data", chunk => { output += chunk; }); child.stderr.on("data", chunk => { errors += chunk; });
  try {
    const until = Date.now() + 5000;
    while (!output.includes("READY") && child.exitCode === null && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 20));
    assert(output.includes("READY"), "Owned loopback preload child must start: " + (errors.match(/ERR_[A-Z_]+/g) ?? []).join(",")); assert.equal(errors, "");
    const headers = { cookie: "SYNTHETIC_COOKIE_ONLY", "user-agent": "SYNTHETIC_USER_AGENT", accept: "application/json", "sec-fetch-mode": "cors" };
    const response = await fetch(origin + "/api/crm/team?private=SYNTHETIC_QUERY", { headers, redirect: "error" });
    assert.equal(response.headers.get("x-synthetic"), "unchanged"); assert.equal(await response.text(), '{"actual":true}');
    const untilCapture = Date.now() + 1000;
    while (relay.snapshot(runId).length < 2 && Date.now() < untilCapture) await new Promise(resolve => setTimeout(resolve, 10));
    const records = relay.snapshot(runId), raw = JSON.stringify(records);
    assert.equal(records.length, 2); assert.equal(records[0].kind, "start"); assert.equal(records[1].terminal, "finish");
    assert(records[1].complete); assert.equal(records[1].bodySha256, sha('{"actual":true}'));
    assert.equal(records[0].captureKey, qaRequestFingerprint(secret, "GET", origin + "/api/crm/team?private=SYNTHETIC_QUERY", headers));
    assert.doesNotMatch(raw, /SYNTHETIC_COOKIE_ONLY|SYNTHETIC_USER_AGENT|SYNTHETIC_QUERY|actual|secret/);
  } finally {
    child.kill(); await exited;
    relay.clear();
  }
});

test("private snapshot correlation fails closed and persistent projection contains no URL/body/header-derived digest", async () => {
  const relay = createQaCaptureRelay();
  relay.accept({ type: "crm.qa.server-capture/v1", row: { runId, kind: "start", id: 1, captureKey: "d".repeat(64) } });
  const parent = new EventEmitter(); parent.connected = true;
  parent.send = (message, callback) => { queueMicrotask(() => parent.emit("message", answerQaCaptureRequest(relay, message))); callback(); };
  assert.equal((await requestQaCaptureSnapshot(runId, { parent })).length, 1);
  await assert.rejects(() => requestQaCaptureSnapshot("f".repeat(32), { parent }), /HELD/);
  parent.send = (_message, callback) => callback();
  await assert.rejects(() => requestQaCaptureSnapshot(runId, { parent, timeoutMs: 20 }), /PENDING/);
  const body = row("c".repeat(64), { bodySha256: "b".repeat(64), bodyInspected: true, bodyError: null, phase: "body-eof" });
  const projection = collectFetchLifecycleDiagnostics([{ observations: [{ ...body, kind: "start" }, body] }]);
  const raw = JSON.stringify({ projection, pending: safeQaFetchDiagnostic({ key: body.key, bodySha256: body.bodySha256, captureKey: "d".repeat(64) }) });
  assert.doesNotMatch(raw, new RegExp([body.key, body.bodySha256, "d".repeat(64)].join("|")));
  assert.equal(projection.events[1].bodyHashPresent, true); assert.equal(projection.events[0].key, projection.events[1].key);
  assert.equal(parent.listenerCount("message"), 0); relay.clear();
});
