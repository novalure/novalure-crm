import test from "node:test";
import assert from "node:assert/strict";
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { once, EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { observeQaServerResponse, qaRequestFingerprint, qualifyQaServerBodies, createQaCaptureRelay, requestQaCaptureSnapshot, answerQaCaptureRequest, createQaWireAudit, assertQaWireNativeMultisets } from "./lib/qa-server-response-capture.mjs";
import { assertObservedFetchCoverage, parseQaFetchBindingMessage, safeQaFetchDiagnostic, collectFetchLifecycleDiagnostics, createResponseInspectionBarrier } from "./lib/qa-response-inspection.mjs";

const secret = "b".repeat(64), runId = "a".repeat(32), doc = "1794075165538-0.7775903198219385";
const sha = value => createHash("sha256").update(value).digest("hex");
const wireHeaders = { cookie: "PUBLIC_SYNTHETIC_SESSION=one", authorization: "PUBLIC_SYNTHETIC_ONLY", "user-agent": "Public transport",
  accept: "application/json", "sec-fetch-mode": "cors", "sec-fetch-dest": "empty" };
function wireFixture() {
  const origin = "http://127.0.0.1:12345", url = origin + "/api/crm/team?public=one", key = sha("GET\0" + url);
  const channel = new EventEmitter(), wire = createQaWireAudit({ origin, secret }); wire.install(channel);
  const native = [{ kind: "request", key, path: "/api/crm/team", method: "GET" },
    { kind: "response", key, path: "/api/crm/team", method: "GET", status: 200, ok: true, json: true }];
  const events = {
    request: { requestId: "public.1", type: "Fetch", request: { method: "GET", url } },
    extra: { requestId: "public.1", headers: wireHeaders },
    response: { requestId: "public.1", type: "Fetch", response: { url, status: 200, headers: { "Content-Type": "application/json" } } },
    finished: { requestId: "public.1" },
  };
  const emit = (name, event = events[name]) => channel.emit({ request: "Network.requestWillBeSent", extra: "Network.requestWillBeSentExtraInfo",
    response: "Network.responseReceived", finished: "Network.loadingFinished", failed: "Network.loadingFailed" }[name], event);
  return { origin, url, key, channel, wire, native, events, emit };
}
function row(key, extra = {}) { return { kind: "terminal", documentId: doc, id: 1, key, path: "/api/crm/team", method: "GET", phase: "body", status: 200, json: true,
  bodyInspected: false, signalAborted: true, signalAbortedAtStart: false, keepalive: false, foreign: false, bodyError: "body_read_failed", bodySha256: null,
  failedBeforeHeaders: false, retiredReadBeforeHeaders: false, preAbortedNoDispatch: false, rejectedWithOriginalAbortReason: false, ...extra }; }
function audit(origin, headers, status = 200) {
  const url = origin + "/api/crm/team?workspaceId=SYNTHETIC_PRIVATE_QUERY", key = sha("GET\0" + url), captureKey = qaRequestFingerprint(secret, "GET", url, headers);
  return { key, captureKey, network: [{ kind: "request", key, captureKey }, { kind: "response", key, captureKey, status, ok: status >= 200 && status < 300, json: true }],
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

test("actual separate auth groups require every claimed group and body; unrelated global sessions cannot replace one", async () => {
  let calls = 0;
  const headers = session => ({ cookie: "SYNTHETIC_SESSION_" + session, accept: "application/json", "user-agent": "Synthetic transport", "sec-fetch-mode": "cors" });
  const bodies = ["A", "B", "UNRELATED"].map(session => JSON.stringify({ syntheticSession: session }));
  const f = await fixture((_request, response) => { response.writeHead(200, { "content-type": "application/json" }); response.end(bodies[calls++]); });
  try {
    const url = f.origin + "/api/crm/team?workspaceId=SYNTHETIC_PRIVATE_QUERY";
    const first = await fetch(url, { headers: headers("A"), redirect: "error" }); assert.equal(await first.text(), bodies[0]);
    const controller = new AbortController(), second = await fetch(url, { headers: headers("B"), signal: controller.signal, redirect: "error" });
    const clone = second.clone(); controller.abort(); await assert.rejects(() => clone.text());
    const unrelated = await fetch(url, { headers: headers("UNRELATED"), redirect: "error" }); assert.equal(await unrelated.text(), bodies[2]);
    assert.equal(f.records.length, 6); assert(f.records.filter(row => row.kind === "terminal").every(row => row.complete));
    const a = audit(f.origin, headers("A")), b = audit(f.origin, headers("B"));
    Object.assign(a.observations[1], { phase: "body-eof", bodyError: null, bodyInspected: true, bodySha256: sha(bodies[0]), signalAborted: false });
    b.observations = b.observations.map(row => ({ ...row, id: 2 }));
    const source = { network: [...a.network, ...b.network], observations: [...a.observations, ...b.observations], records: f.records };
    const diagnostics = [], proofs = qualifyQaServerBodies(source.network, source.observations, source.records, runId, diagnostics);
    assert.equal(proofs.size, 1); assert.doesNotThrow(() => assertObservedFetchCoverage(source.network, source.observations, proofs));
    const proof = [...proofs.values()][0];
    assert.equal(proof.authGroups.length, 2); assert.equal(proof.nativeRequestCount, 2); assert.equal(proof.successfulJsonBodyCount, 2);
    assert.equal(proof.resolvedBodyCount, 1); assert.equal(proof.serverIds.length, 2); assert.equal(proof.serverId, undefined);
    assert.equal(diagnostics[0].reason, "QUALIFIED_COMPLETE_AUTH_GROUPS"); assert.equal(diagnostics[0].unclaimedServerStartCount, 1);
    const negatives = [
      ["missing own group cannot borrow the unrelated session", x => x.records = x.records.filter(row => row.id !== 2), "AUTH_GROUP_REQUEST_COUNT_MISMATCH"],
      ["surplus in a claimed group", x => x.records.push(...x.records.filter(row => row.id === 1).map(row => ({ ...row, id: 4 }))), "AUTH_GROUP_REQUEST_COUNT_MISMATCH"],
      ["missing own terminal", x => x.records = x.records.filter(row => row.id !== 2 || row.kind !== "terminal"), "AUTH_GROUP_TERMINAL_MISSING"],
      ["wrong session cannot replace the exact own group", x => x.records.filter(row => row.id === 2).forEach(row => row.captureKey = x.records[4].captureKey), "AUTH_GROUP_REQUEST_COUNT_MISMATCH"],
      ["response must bind to its actual request auth group", x => x.network[3].captureKey = x.network[0].captureKey, "AUTH_GROUP_REQUEST_COUNT_MISMATCH"],
      ["unclaimed response group", x => x.network[3].captureKey = x.records[4].captureKey, "UNMATCHED_AUTH_GROUP"],
      ["missing response binding", x => delete x.network[3].captureKey, "NATIVE_RESPONSE_FINGERPRINT_MISSING"],
      ["incomplete body", x => x.records[3].complete = false, "INCOMPLETE_OR_UNSAFE_SERVER_BODY"],
      ["status counts are bound per auth group", x => x.records[3].status = 201, "AUTH_GROUP_SUCCESSFUL_BODY_STATUS_MISMATCH"],
      ["original inspected body must remain in the complete bag", x => x.observations[1].bodySha256 = sha("NOT_THE_ACTUAL_BODY"), "ORIGINAL_BODY_MULTISET_MISMATCH"],
      ["missing server request despite extra native count", x => x.network.push({ ...x.network[2] }), "AUTH_GROUP_REQUEST_COUNT_MISMATCH"],
    ];
    for (const [label, mutate, reason] of negatives) {
      const x = structuredClone(source), diagnostic = []; mutate(x);
      const denied = qualifyQaServerBodies(x.network, x.observations, x.records, runId, diagnostic);
      assert.equal(denied.size, 0, label); assert.equal(diagnostic[0].reason, reason, label);
      assert.throws(() => assertObservedFetchCoverage(x.network, x.observations, denied), undefined, label);
    }
    const foreign = structuredClone(source); foreign.records[5].foreign = true;
    assert.throws(() => qualifyQaServerBodies(foreign.network, foreign.observations, foreign.records, runId), /foreign private sentinel/);
    for (const mutate of [p => p.authGroups.pop(), p => p.authGroups[0].nativeRequestCount++,
      p => p.authGroups[1].captureKey = p.authGroups[0].captureKey, p => p.authGroups[0].serverIds = [...p.authGroups[1].serverIds],
      p => p.authGroups[0].bodyHashes[0].sha256 = sha("FORGED")]) {
      const changed = structuredClone(proof); mutate(changed);
      assert.throws(() => assertObservedFetchCoverage(source.network, source.observations, new Map([[`${doc}/2`, changed]])), /INVALID_SERVER_EGRESS_BODY_PROOF/);
    }
    const repeated = []; qualifyQaServerBodies(source.network, source.observations, source.records, runId, repeated);
    assert.equal(repeated[0].reference, diagnostics[0].reference);
    const persisted = JSON.stringify([...diagnostics, ...repeated]);
    for (const forbidden of [url, secret, a.key, a.captureKey, b.captureKey, ...bodies.map(sha), "SYNTHETIC_SESSION", "SYNTHETIC_PRIVATE_QUERY"])
      assert(!persisted.includes(forbidden));
    for (const diagnostic of [...diagnostics, ...repeated]) for (const [key, value] of Object.entries(diagnostic))
      assert(key === "reference" ? /^[a-f0-9]{32}$/.test(value) : key === "reason" ? /^[A-Z_]+$/.test(value) : Number.isSafeInteger(value) && value >= 0);
    assert.equal(calls, 3);
  } finally { await f.stop(); }
});

test("actual response metadata callback binds only its own delayed request-header promise and holds missing bindings", async () => {
  const text = readFileSync(new URL("./qa-design-c-integration.mjs", import.meta.url), "utf8");
  const start = text.indexOf('  page.on("response", (response) => {');
  const implementation = text.slice(start, text.indexOf("\n  });", start) + 6);
  assert(implementation.startsWith('  page.on("response",'));
  for (const mode of ["delayed", "missing", "invalid"]) {
    const page = new EventEmitter(), request = { resourceType: () => "fetch", method: () => "GET" };
    let resolveHeaders;
    const captureKeyPromise = mode === "missing" ? undefined : new Promise(resolve => { resolveHeaders = resolve; });
    const metadata = { captureKeyPromise }, requestInfo = new WeakMap([[request, metadata]]), responseChecks = [], responseInspectionErrors = [];
    const network = [], barrier = createResponseInspectionBarrier(), base = new URL("http://127.0.0.1");
    const fingerprint = sha("SYNTHETIC_HEADER_PROMISE_ONLY"), response = { url: () => base.origin + "/api/crm/team?private=SYNTHETIC_QUERY",
      request: () => request, status: () => 200, ok: () => true, headers: () => ({ "content-type": "application/json" }),
      text() { throw Error("Native fetch response must never be consumed by this metadata callback"); } };
    runInNewContext(implementation, { page, URL, base, requestInfo, fetchKey: () => sha("SYNTHETIC_URL_ONLY"), fetchAudit: () => ({ network }),
      Promise, assert, responseChecks, responseInspectionErrors, barrier, label: "synthetic", serverErrors: [], privateLeaks: [] });
    page.emit("response", response);
    assert.equal(network.length, 1); assert.equal(network[0].captureKey, undefined); assert.equal(metadata.responseReceived, true);
    if (mode !== "missing") {
      let drained = false; const pending = barrier.drain(500).then(() => { drained = true; });
      await Promise.resolve(); assert.equal(drained, false);
      resolveHeaders(mode === "invalid" ? undefined : fingerprint); await Promise.all(responseChecks); await pending;
    } else await Promise.all(responseChecks);
    if (mode === "delayed") { assert.equal(network[0].captureKey, fingerprint); assert.equal(responseInspectionErrors.length, 0); }
    else { assert.equal(network[0].captureKey, undefined); assert.equal(responseInspectionErrors.length, 1); assert.equal(responseInspectionErrors[0].error, "native_response_binding_failed"); }
  }
});

test("group coverage counts actual native JSON bodies once without assigning success to null-status original terminals", async () => {
  let calls = 0;
  const headers = { cookie: "SYNTHETIC_GROUP_ONLY", "user-agent": "Synthetic transport", accept: "application/json", "sec-fetch-mode": "cors" };
  const f = await fixture((_request, response) => { const status = ++calls === 1 ? 200 : 403; response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify({ syntheticStatus: status })); });
  try {
    for (let i = 0; i < 2; i++) { const response = await fetch(f.origin + "/api/crm/team?workspaceId=SYNTHETIC_PRIVATE_QUERY", { headers, redirect: "error" }); await response.text(); }
    const a = audit(f.origin, headers), b = audit(f.origin, headers, 403);
    const preheader = (row, id) => ({ ...row, id, phase: row.kind === "start" ? "request" : "fetch-aborted-before-headers", status: null, json: false,
      bodyError: null, bodyInspected: false, bodySha256: null, signalAborted: row.kind === "terminal", signalAbortedAtStart: false,
      failedBeforeHeaders: row.kind === "terminal", preAbortedNoDispatch: false, rejectedWithOriginalAbortReason: false, retiredReadBeforeHeaders: false });
    // Explicit original/native metadata fixtures; HTTP body and status evidence
    // above is real. Neither these fixtures nor this test claim Chromium IO.
    const network = [...a.network, ...b.network], observations = [...a.observations.map(row => preheader(row, 1)), ...b.observations.map(row => preheader(row, 2))];
    const proofs = qualifyQaServerBodies(network, observations, f.records, runId);
    assert.equal(proofs.size, 2); assert.doesNotThrow(() => assertObservedFetchCoverage(network, observations, proofs));
    assert(observations.filter(row => row.kind === "terminal").every(row => row.status === null && row.json === false && !row.bodyInspected));
    for (const proof of proofs.values()) { assert.equal(proof.status, null); assert.equal(proof.originalCandidateCount, 2); assert.equal(proof.resolvedBodyCount, 1); assert.equal(proof.successfulJsonBodyCount, 1); }
    for (const mutate of [proof => proof.resolvedBodyCount++, proof => proof.originalCandidateCount--, proof => proof.preHeaderAbortedReadCount--,
      proof => proof.receivedBodyErrorCount++, proof => proof.status = 200]) {
      const changed = new Map([...proofs].map(([id, proof]) => [id, structuredClone(proof)]));
      for (const proof of changed.values()) mutate(proof);
      assert.throws(() => assertObservedFetchCoverage(network, observations, changed), /INVALID_SERVER_EGRESS_BODY_PROOF/);
    }
    const insufficient = structuredClone({ network, observations, records: f.records });
    insufficient.network[3].status = 200; insufficient.network[3].ok = true;
    insufficient.records[3].status = 200; insufficient.records[3].bodySha256 = sha('{"syntheticStatus":200}');
    Object.assign(insufficient.observations[3], { phase: "response-not-json-success", status: 403, json: true, failedBeforeHeaders: false, signalAborted: false });
    const diagnostics = [], denied = qualifyQaServerBodies(insufficient.network, insufficient.observations, insufficient.records, runId, diagnostics);
    assert.equal(denied.size, 0); assert.equal(diagnostics[0].reason, "UNRESOLVED_BODY_COUNT_MISMATCH");
    assert.throws(() => assertObservedFetchCoverage(insufficient.network, insufficient.observations, denied));
    assert.equal(calls, 2);
  } finally { await f.stop(); }
});

test("a complete group cannot carry a keepalive or at-start-aborted uninspected sibling through an eligible read", () => {
  const a = audit("http://127.0.0.1", { cookie: "SYNTHETIC_MIXED_SCOPE" }, 403), b = audit("http://127.0.0.1", { cookie: "SYNTHETIC_MIXED_SCOPE" });
  const preheader = (row, id) => ({ ...row, id, phase: row.kind === "start" ? "request" : "fetch-aborted-before-headers", status: null, json: false,
    bodyError: null, bodyInspected: false, bodySha256: null, signalAborted: row.kind === "terminal", signalAbortedAtStart: false,
    failedBeforeHeaders: row.kind === "terminal", preAbortedNoDispatch: false, rejectedWithOriginalAbortReason: false, retiredReadBeforeHeaders: false });
  const network = [...a.network, ...b.network], baseObservations = [...a.observations.map(row => preheader(row, 1)), ...b.observations.map(row => preheader(row, 2))];
  // Explicit complete Node/native metadata fixtures for the review witness:
  // eligible ID1 has403; ineligible sibling ID2 has200. No actual IO is claimed.
  const records = [403, 200].flatMap((status, i) => {
    const identity = { runId, id: i + 1, key: a.key, captureKey: a.captureKey, path: "/api/crm/team", method: "GET" };
    return [{ ...identity, kind: "start" }, { ...identity, kind: "terminal", status, json: true, complete: true, terminal: "finish",
      bodySha256: status === 200 ? sha('{"synthetic":true}') : null, foreign: false, inspectionError: null }];
  });
  const positive = qualifyQaServerBodies(network, baseObservations, records, runId);
  assert.equal(positive.size, 2); assert.doesNotThrow(() => assertObservedFetchCoverage(network, baseObservations, positive));
  for (const mode of ["keepalive", "at-start"]) {
    const observations = structuredClone(baseObservations);
    for (const row of observations.filter(row => row.id === 2)) {
      if (mode === "keepalive") row.keepalive = true; else row.signalAbortedAtStart = true;
    }
    const diagnostic = [], denied = qualifyQaServerBodies(network, observations, records, runId, diagnostic);
    assert.equal(denied.size, 0); assert.equal(diagnostic[0].reason, "INELIGIBLE_UNRESOLVED_SIBLING");
    assert.equal(diagnostic[0].originalCandidateCount, 1); assert.equal(diagnostic[0].unresolvedOriginalSiblingCount, 2);
    assert.throws(() => assertObservedFetchCoverage(network, observations, denied), /UNINSPECTED_NATIVE_SUCCESSFUL_JSON_BODY/);
    const staleProof = new Map([[`${doc}/1`, positive.get(`${doc}/1`)]]);
    assert.throws(() => assertObservedFetchCoverage(network, observations, staleProof), /INVALID_SERVER_EGRESS_BODY_PROOF/);
  }
  for (const mode of ["completed403", "completedNonJson"]) {
    const known = structuredClone({ network, observations: baseObservations, records });
    Object.assign(known.network[1], { status: 200, ok: true });
    Object.assign(known.network[3], { status: mode === "completed403" ? 403 : 200, ok: mode !== "completed403", json: mode === "completed403" });
    Object.assign(known.records[1], { status: 200, bodySha256: sha('{"synthetic":true}') });
    Object.assign(known.records[3], { status: mode === "completed403" ? 403 : 200, json: mode === "completed403", bodySha256: null });
    Object.assign(known.observations[3], { phase: "response-not-json-success", status: mode === "completed403" ? 403 : 200,
      json: mode === "completed403", signalAborted: false, failedBeforeHeaders: false });
    const proof = qualifyQaServerBodies(known.network, known.observations, known.records, runId);
    assert.equal(proof.size, 1); assert.doesNotThrow(() => assertObservedFetchCoverage(known.network, known.observations, proof));
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

test("passive real ServerResponse error monitoring preserves native throws, original handlers and rejects EOF after errors", async () => {
  for (const observed of [false, true]) {
    const socket = new Socket(), request = new IncomingMessage(socket);
    request.method = "GET"; request.url = "/api/crm/team";
    const response = new ServerResponse(request), failure = Error("SYNTHETIC_ORIGINAL_ERROR");
    try {
      if (observed) observeQaServerResponse(request, response, { origin: "http://127.0.0.1:12345", secret, runId, id: 1, emit() {} });
      assert.equal(response.listenerCount("error"), 0);
      assert.throws(() => response.emit("error", failure), error => error === failure, "The exact original unhandled error must still throw");
      let calls = 0;
      const originalHandler = error => { calls++; assert.equal(error, failure); };
      response.once("error", originalHandler);
      assert.equal(response.emit("error", failure), true); assert.equal(calls, 1); assert.equal(response.listenerCount("error"), 0);
    } finally { response.destroy(); socket.destroy(); }
  }
  let originalCalls = 0;
  const failure = Error("SYNTHETIC_HANDLED_ERROR");
  const f = await fixture((_request, response) => {
    response.once("error", error => { originalCalls++; assert.equal(error, failure); });
    response.emit("error", failure);
    response.writeHead(200, { "content-type": "application/json" }); response.end('{"actual":true}');
  });
  try {
    const response = await fetch(f.origin + "/api/crm/team", { redirect: "error" });
    assert.equal(await response.text(), '{"actual":true}'); assert.equal(originalCalls, 1);
    const terminal = f.records.find(row => row.kind === "terminal");
    assert.equal(terminal.terminal, "finish"); assert.equal(terminal.complete, false); assert.equal(terminal.bodySha256, null);
  } finally { await f.stop(); }
});

test("CDP wire ExtraInfo supplies all strict fingerprint fields while preserving the complete independent PW multiset", () => {
  const f = wireFixture(); f.emit("extra"); f.emit("request"); f.emit("response"); f.emit("finished");
  const network = f.wire.snapshot(f.native), actual = qaRequestFingerprint(secret, "GET", f.url, wireHeaders);
  const provisional = { ...wireHeaders }; delete provisional["sec-fetch-mode"]; delete provisional["sec-fetch-dest"];
  assert.notEqual(qaRequestFingerprint(secret, "GET", f.url, provisional), actual);
  assert.equal(network[0].captureKey, actual); assert.equal(network[1].captureKey, actual);
  const observations = [row(f.key, { kind: "start", phase: "request", status: null, json: false, signalAborted: false, bodyError: null }), row(f.key)];
  const identity = { runId, id: 1, key: f.key, captureKey: actual, path: "/api/crm/team", method: "GET" };
  const records = [{ ...identity, kind: "start" }, { ...identity, kind: "terminal", status: 200, json: true, complete: true,
    terminal: "finish", bodySha256: sha('{"public":true}'), foreign: false, inspectionError: null }];
  const proofs = qualifyQaServerBodies(network, observations, records, runId);
  assert.equal(proofs.size, 1); assert.doesNotThrow(() => assertObservedFetchCoverage(f.native, observations, proofs, network));
  for (const change of [n => n.pop(), n => n.push({ ...n[0] }), n => n[1].status = 201, n => n[1].json = false,
    n => n[0].method = "POST", n => n[0].key = sha("OTHER_QUERY")]) {
    const native = structuredClone(f.native); change(native);
    assert.throws(() => assertQaWireNativeMultisets(native, network), /QA_WIRE_NATIVE_.*_MULTISET_MISMATCH/);
    assert.throws(() => assertObservedFetchCoverage(native, observations, proofs, network), /QA_WIRE_NATIVE_.*_MULTISET_MISMATCH/);
  }
  const privateProjection = JSON.stringify({ state: f.wire.diagnostics(), projected: safeQaFetchDiagnostic(network) });
  for (const value of [actual, f.key, f.url, ...Object.values(wireHeaders)]) assert(!privateProjection.includes(value));
  assert.equal(f.wire.diagnostics().missingExtraInfo, 0);
});

test("same-URL concurrent CDP requests bind out-of-order headers and statuses by exact IDs, never FIFO", () => {
  const f = wireFixture(), second = { ...wireHeaders, cookie: "PUBLIC_OTHER_SESSION" };
  f.native.push({ ...f.native[0] }, { ...f.native[1], status: 403, ok: false });
  f.emit("request"); f.emit("request", { ...f.events.request, requestId: "public.2" });
  f.emit("response", { ...f.events.response, requestId: "public.2", response: { ...f.events.response.response, status: 403 } });
  f.emit("extra", { requestId: "public.2", headers: second });
  f.emit("response"); f.emit("extra"); f.emit("finished", { requestId: "public.2" }); f.emit("finished");
  const network = f.wire.snapshot(f.native), success = network.find(row => row.kind === "response" && row.status === 200);
  const denied = network.find(row => row.kind === "response" && row.status === 403);
  assert.equal(success.captureKey, qaRequestFingerprint(secret, "GET", f.url, wireHeaders));
  assert.equal(denied.captureKey, qaRequestFingerprint(secret, "GET", f.url, second));
  assert.notEqual(success.captureKey, denied.captureKey);
});

test("missing, ambiguous, reused, redirected or detached wire data cannot supply authenticated Node body evidence", () => {
  const scenarios = [
    f => { f.emit("request"); f.emit("extra"); f.emit("extra"); },
    f => { f.emit("request"); f.emit("request"); },
    f => f.emit("request", { ...f.events.request, redirectResponse: { status: 302 } }),
    f => { f.emit("request"); f.emit("response", { ...f.events.response, response: { ...f.events.response.response, url: f.url + "&other=1" } }); },
    f => { f.emit("request"); f.emit("extra", { requestId: "public.1", headers: { Cookie: "PUBLIC_A", cookie: "PUBLIC_B" } }); },
    f => f.emit("response"),
    f => { f.emit("request"); f.emit("extra"); f.emit("response"); f.emit("response"); },
    f => { f.emit("request"); f.emit("extra"); f.emit("response"); f.emit("finished"); f.emit("finished"); },
    f => { f.emit("request"); f.emit("extra"); f.emit("response"); f.emit("finished"); f.channel.emit("close"); },
  ];
  for (const scenario of scenarios) {
    const f = wireFixture(); scenario(f); assert.throws(() => f.wire.snapshot(f.native), /QA_WIRE_INVALID/);
    assert(!JSON.stringify(f.wire.diagnostics()).includes(f.url));
  }
  const pending = wireFixture(); pending.emit("request"); pending.emit("extra"); pending.emit("response");
  assert.throws(() => pending.wire.snapshot(pending.native), /QA_WIRE_PENDING/);
  for (const cached of [false, true]) {
    const f = wireFixture(); f.emit("request"); if (cached) f.emit("extra");
    f.emit("response", { ...f.events.response, response: { ...f.events.response.response, fromServiceWorker: cached } }); f.emit("finished");
    const network = f.wire.snapshot(f.native); assert.equal(network[0].captureKey, null); assert.equal(network[1].captureKey, null);
    const observations = [row(f.key, { kind: "start", phase: "request", status: null, json: false, signalAborted: false, bodyError: null }), row(f.key)];
    const own = qaRequestFingerprint(secret, "GET", f.url, wireHeaders), identity = { runId, id: 1, key: f.key, captureKey: own, path: "/api/crm/team", method: "GET" };
    const records = [{ ...identity, kind: "start" }, { ...identity, kind: "terminal", status: 200, json: true, complete: true,
      terminal: "finish", bodySha256: sha('{"public":true}'), foreign: false, inspectionError: null }];
    const proofs = qualifyQaServerBodies(network, observations, records, runId); assert.equal(proofs.size, 0);
    assert.throws(() => assertObservedFetchCoverage(f.native, observations, proofs, network), /UNINSPECTED_NATIVE_SUCCESSFUL_JSON_BODY/);
  }
});

test("owned close retains all counters, while intercepted traffic has no fabricated wire-header or Node-EOF binding", () => {
  const f = wireFixture(); f.emit("request"); f.emit("extra"); f.emit("response"); f.emit("finished");
  f.wire.beginOwnerClose(f.native); f.channel.emit("close"); assert.doesNotThrow(() => f.wire.snapshot(f.native));
  assert.throws(() => f.wire.snapshot([...f.native, { ...f.native[0] }]), /QA_WIRE_NATIVE_REQUEST_MULTISET_MISMATCH/);
  const aborted = wireFixture(); aborted.emit("request"); aborted.emit("failed", { requestId: "public.1" });
  const native = [aborted.native[0]], wire = aborted.wire.snapshot(native);
  assert.equal(wire.length, 1); assert.equal(wire[0].captureKey, null); assert.equal(aborted.wire.diagnostics().missingExtraInfo, 1);
  assert.throws(() => assertQaWireNativeMultisets(aborted.native, wire), /QA_WIRE_NATIVE_RESPONSE_MULTISET_MISMATCH/);
});
