// Test-harness evidence only. Never changes request/response headers or payloads.
import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { errorMonitor } from "node:events";
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";

export const QA_CAPTURE_LIMIT = 2 * 1024 * 1024;
const sha = value => createHash("sha256").update(value).digest("hex");
const header = (headers, name) => String(headers[name] ?? "");
const diagnosticReferences = new Map();
const counts = rows => rows.reduce((map, row) => map.set(row.status, (map.get(row.status) ?? 0) + 1), new Map());
const equalCounts = (a, b) => a.size === b.size && [...a].every(([status, n]) => b.get(status) === n);
const validFingerprint = value => /^[a-f0-9]{64}$/.test(value ?? "");
export const isQaPreheaderAbortedRead = row => row.kind === "terminal" && row.method === "GET" && row.keepalive === false &&
  row.phase === "fetch-aborted-before-headers" && row.failedBeforeHeaders === true && row.signalAborted === true &&
  row.signalAbortedAtStart === false && row.preAbortedNoDispatch === false && row.rejectedWithOriginalAbortReason === false &&
  row.retiredReadBeforeHeaders === false && row.status === null && row.json === false && row.bodyInspected === false &&
  row.bodySha256 === null && row.bodyError === null;
const receivedBodyFailure = row => row.kind === "terminal" && row.bodyError === "body_read_failed" && row.method === "GET" &&
  !row.keepalive && !row.signalAbortedAtStart && row.signalAborted && row.json && row.status >= 200 && row.status < 300 && !row.bodyInspected;
const preheaderStartBound = (row, observations) => observations.some(start => start.kind === "start" &&
  start.documentId === row.documentId && start.id === row.id && start.key === row.key && start.path === row.path &&
  start.method === "GET" && start.keepalive === false && start.signalAbortedAtStart === false);
const unresolvedOriginalSibling = row => row.kind === "terminal" && !row.bodyInspected &&
  !(row.phase === "response-not-json-success" && row.bodyError === null && Number.isInteger(row.status) && row.status >= 200 && row.status <= 599 &&
    (!row.json || row.status >= 300));
export function qaRequestFingerprint(secret, method, url, headers) {
  assert(/^[a-f0-9]{64}$/.test(secret));
  // Values stay in local host RAM. The per-run digest crosses owned IPC only;
  // neither credential-derived digests nor header/URL values enter a file.
  return createHmac("sha256", secret).update(JSON.stringify([method, url,
    ...["cookie", "authorization", "user-agent", "accept", "sec-fetch-mode", "sec-fetch-dest"].map(name => header(headers, name)),
  ])).digest("hex");
}

/** Independent CDP wire metadata must retain the complete existing PW audit. */
export function assertQaWireNativeMultisets(native, wire) {
  const signature = row => JSON.stringify([row.key, row.path, row.method,
    ...(row.kind === "response" ? [row.status, row.ok, row.json] : [])]);
  for (const kind of ["request", "response"]) {
    const count = rows => rows.filter(row => row.kind === kind).reduce((map, row) => {
      const key = signature(row); map.set(key, (map.get(key) ?? 0) + 1); return map;
    }, new Map());
    const a = count(native), b = count(wire);
    if (a.size !== b.size || [...a].some(([key, n]) => b.get(key) !== n)) {
      const error = new Error(kind === "request" ? "QA_WIRE_NATIVE_REQUEST_MULTISET_MISMATCH" : "QA_WIRE_NATIVE_RESPONSE_MULTISET_MISMATCH");
      error.coverage = { nativeCount: native.filter(row => row.kind === kind).length, wireCount: wire.filter(row => row.kind === kind).length };
      throw error;
    }
  }
}

/** Header values/URLs stay in this owned host's RAM. No provisional header,
 * guessed sec-fetch value or FIFO request assignment is a wire binding. */
export function createQaWireAudit({ origin, secret }) {
  assert(new URL(origin).origin === origin && new URL(origin).hostname === "127.0.0.1" && /^[a-f0-9]{64}$/.test(secret));
  const requests = new Map(), ignored = new Set(), pending = new Map();
  let failure = null, events = 0, ownerClosing = false, detached = false, pendingBytes = 0;
  const need = (condition, code) => { if (!condition) throw Error(code); };
  const id = value => { need(typeof value === "string" && value.length > 0 && value.length < 200, "QA_WIRE_INVALID_ID"); return value; };
  const scope = (url, type) => type === "Fetch" && url.origin === origin && url.pathname.startsWith("/api/");
  const normalizedHeaders = headers => {
    need(headers && typeof headers === "object" && !Array.isArray(headers) && JSON.stringify(headers).length <= 65536, "QA_WIRE_INVALID_HEADERS");
    const result = Object.create(null);
    for (const [name, value] of Object.entries(headers)) {
      const lower = name.toLowerCase();
      need(!Object.hasOwn(result, lower) && typeof value === "string", "QA_WIRE_AMBIGUOUS_HEADERS"); result[lower] = value;
    }
    return result;
  };
  const bind = (row, headers) => {
    need(!row.extra, "QA_WIRE_DUPLICATE_EXTRAINFO");
    row.captureKey = qaRequestFingerprint(secret, row.method, row.url, headers); row.extra = true; row.url = null;
  };
  const receive = action => event => {
    if (failure) return;
    try { need(++events <= 50000 && requests.size + ignored.size + pending.size <= 20000, "QA_WIRE_EVENT_LIMIT"); action(event); }
    catch (error) { failure = error instanceof Error && /^QA_WIRE_[A-Z_]+$/.test(error.message) ? error.message : "QA_WIRE_INVALID_EVENT"; }
  };
  const onRequest = receive(event => {
    const requestId = id(event.requestId), url = new URL(event.request.url);
    if (!scope(url, event.type)) {
      need(!requests.has(requestId), "QA_WIRE_SCOPE_OR_REDIRECT_CHANGED"); ignored.add(requestId);
      if (pending.has(requestId)) { pendingBytes -= pending.get(requestId).bytes; pending.delete(requestId); } return;
    }
    need(!requests.has(requestId) && !ignored.has(requestId) && !event.redirectResponse, "QA_WIRE_REDIRECT_OR_REUSED_ID");
    need(/^[A-Z]{3,8}$/.test(event.request.method), "QA_WIRE_INVALID_METHOD");
    const row = { requestId, key: sha(event.request.method + "\0" + url.href), path: url.pathname, method: event.request.method,
      url: url.href, extra: false, captureKey: null, response: null, terminal: null, direct: true };
    requests.set(requestId, row);
    if (pending.has(requestId)) {
      const saved = pending.get(requestId); pendingBytes -= saved.bytes; pending.delete(requestId); bind(row, saved.headers);
    }
  });
  const onExtra = receive(event => {
    const requestId = id(event.requestId); if (ignored.has(requestId)) return;
    const headers = normalizedHeaders(event.headers), row = requests.get(requestId);
    if (row) bind(row, headers);
    else {
      need(!pending.has(requestId), "QA_WIRE_DUPLICATE_EXTRAINFO");
      const bytes = JSON.stringify(headers).length; need(pending.size < 128 && pendingBytes + bytes <= 524288, "QA_WIRE_PENDING_HEADER_LIMIT");
      pendingBytes += bytes; pending.set(requestId, { headers, bytes });
    }
  });
  const onResponse = receive(event => {
    const requestId = id(event.requestId), url = new URL(event.response.url), row = requests.get(requestId);
    if (!row) { need(!scope(url, event.type), "QA_WIRE_RESPONSE_WITHOUT_REQUEST"); return; }
    need(event.type === "Fetch" && !row.response && sha(row.method + "\0" + url.href) === row.key, "QA_WIRE_UNBOUND_RESPONSE");
    const headers = normalizedHeaders(event.response.headers);
    need(Number.isInteger(event.response.status) && event.response.status >= 200 && event.response.status <= 599, "QA_WIRE_INVALID_STATUS");
    row.direct = !event.response.fromDiskCache && !event.response.fromServiceWorker && !event.response.fromPrefetchCache;
    row.response = { kind: "response", key: row.key, path: row.path, method: row.method, status: event.response.status,
      ok: event.response.status < 300, json: String(headers["content-type"] ?? "").includes("application/json") };
  });
  const terminal = kind => receive(event => {
    const row = requests.get(id(event.requestId)); if (!row) return;
    need(!row.terminal, "QA_WIRE_DUPLICATE_TERMINAL"); row.terminal = kind;
    need(kind !== "finished" || row.response, "QA_WIRE_FINISHED_WITHOUT_RESPONSE");
  });
  const diagnostics = () => ({ requests: requests.size, responses: [...requests.values()].filter(row => row.response).length,
    missingExtraInfo: [...requests.values()].filter(row => !row.extra).length,
    nonDirectResponses: [...requests.values()].filter(row => !row.direct).length,
    pendingTerminals: [...requests.values()].filter(row => !row.terminal).length, unmatchedExtraInfo: pending.size,
    detached, ownerClosing, failure });
  const snapshot = native => {
    if (failure) { const error = Error("QA_WIRE_INVALID"); error.coverage = diagnostics(); throw error; }
    if (pending.size || [...requests.values()].some(row => !row.terminal)) {
      const error = Error("QA_WIRE_PENDING"); error.coverage = diagnostics(); throw error;
    }
    const network = [...requests.values()].flatMap(row => {
      // Intercepted abort/fulfill traffic remains fully counted. Without actual
      // ExtraInfo/direct transport its null binding can NEVER prove Node EOF.
      const captureKey = row.extra && row.direct ? row.captureKey : null;
      const request = { kind: "request", key: row.key, path: row.path, method: row.method, captureKey };
      return row.response ? [request, { ...row.response, captureKey }] : [request];
    });
    assertQaWireNativeMultisets(native, network); return network;
  };
  return {
    install(channel) {
      channel.on("Network.requestWillBeSent", onRequest); channel.on("Network.requestWillBeSentExtraInfo", onExtra);
      channel.on("Network.responseReceived", onResponse); channel.on("Network.loadingFinished", terminal("finished"));
      channel.on("Network.loadingFailed", terminal("failed"));
      channel.on("close", () => { detached = true; if (!ownerClosing) failure = "QA_WIRE_UNEXPECTED_DETACH"; });
    },
    snapshot, diagnostics,
    beginOwnerClose(native) { snapshot(native); ownerClosing = true; },
    cleanupAfterFailure() { failure ??= "QA_WIRE_UNQUALIFIED_OWNER_CLOSE"; ownerClosing = true; },
  };
}

export function createQaCaptureRelay() {
  const rows = []; let failure = false, runId;
  return {
    accept(message) {
      if (message?.type !== "crm.qa.server-capture/v1") return;
      const row = message.row;
      if (!row || !/^[a-f0-9]{32}$/.test(row.runId) || (runId && row.runId !== runId) || rows.length >= 20000 || JSON.stringify(row).length >= 8192) { failure = true; return; }
      runId ??= row.runId; rows.push(row);
    },
    snapshot(id) { assert(!failure && (!runId || id === runId)); return rows.slice(); },
    clear() { rows.length = 0; },
    get failure() { return failure; },
  };
}

export function requestQaCaptureSnapshot(runId, { parent = process, timeoutMs = 1000 } = {}) {
  assert(/^[a-f0-9]{32}$/.test(runId) && typeof parent.send === "function" && parent.connected);
  const requestId = randomBytes(16).toString("hex");
  return new Promise((resolve, reject) => {
    let timer;
    const finish = (error, rows) => { clearTimeout(timer); parent.off("message", receive); if (error) reject(error); else resolve(rows); };
    const receive = message => {
      if (message?.type !== "crm.qa.capture-snapshot/v1" || message.requestId !== requestId) return;
      if (message.runId !== runId || message.held || !Array.isArray(message.rows) || message.rows.length > 20000) finish(new Error("QA_SERVER_CAPTURE_HELD"));
      else finish(null, message.rows);
    };
    parent.on("message", receive);
    timer = setTimeout(() => finish(new Error("QA_SERVER_CAPTURE_PENDING")), timeoutMs);
    parent.send({ type: "crm.qa.capture-request/v1", runId, requestId }, error => { if (error) finish(new Error("QA_SERVER_CAPTURE_HELD")); });
  });
}

export function answerQaCaptureRequest(relay, message) {
  assert(message?.type === "crm.qa.capture-request/v1" && /^[a-f0-9]{32}$/.test(message.runId) && /^[a-f0-9]{32}$/.test(message.requestId));
  try { return { type: "crm.qa.capture-snapshot/v1", requestId: message.requestId, runId: message.runId, held: false, rows: relay.snapshot(message.runId) }; }
  catch { return { type: "crm.qa.capture-snapshot/v1", requestId: message.requestId, runId: message.runId, held: true }; }
}

export function observeQaServerResponse(request, response, { origin, secret, runId, id, emit, limit = QA_CAPTURE_LIMIT }) {
  const url = new URL(request.url, origin);
  if (url.origin !== origin || !url.pathname.startsWith("/api/")) return;
  const identity = { runId, id, key: sha(request.method + "\0" + url.href),
    captureKey: qaRequestFingerprint(secret, request.method, url.href, request.headers),
    path: url.pathname, method: request.method };
  let bytes = 0, overflow = false, ended = false, published = false, error = false, sentStatus;
  const chunks = [];
  const remember = args => {
    const value = args[0];
    if (value === undefined || value === null || typeof value === "function") return;
    try {
      if (typeof value !== "string" && !(value instanceof Uint8Array)) { error = true; return; }
      const encoding = typeof args[1] === "string" ? args[1] : "utf8";
      bytes += typeof value === "string" ? Buffer.byteLength(value, encoding) : value.byteLength;
      if (bytes > limit) { overflow = true; chunks.length = 0; }
      else if (!overflow) chunks.push(typeof value === "string" ? Buffer.from(value, encoding) : Buffer.from(value));
    } catch { error = true; }
  };
  emit({ kind: "start", ...identity });
  const explicitHeaders = new Map(), writeHead = response.writeHead;
  response.writeHead = function (...args) {
    let result;
    try { result = Reflect.apply(writeHead, this, args); }
    catch (failure) { error = true; throw failure; }
    sentStatus ??= args[0];
    const supplied = typeof args[1] === "string" ? args[2] : args[1];
    try {
      const descriptors = Object.getOwnPropertyDescriptors(supplied ?? {});
      const entries = Array.isArray(supplied) ? Array.from({ length: supplied.length / 2 }, (_, i) => [descriptors[i * 2], descriptors[i * 2 + 1]])
        .map(([key, value]) => { assert(key && value && "value" in key && "value" in value); return [key.value, value.value]; })
        : Object.entries(descriptors).map(([key, value]) => { assert("value" in value); return [key, value.value]; });
      for (const [name, value] of entries) if (["content-type", "content-encoding", "content-length"].includes(String(name).toLowerCase())) explicitHeaders.set(String(name).toLowerCase(), String(value));
    } catch { error = true; }
    return result;
  };
  const responseHeader = name => explicitHeaders.get(name) ?? response.getHeader(name) ?? "";
  const write = response.write, end = response.end;
  response.write = function (...args) { remember(args); try { return Reflect.apply(write, this, args); } catch (failure) { error = true; throw failure; } };
  response.end = function (...args) { remember(args); ended = true; try { return Reflect.apply(end, this, args); } catch (failure) { error = true; throw failure; } };
  const finish = terminal => {
    if (published) return;
    published = true;
    const status = sentStatus ?? response.statusCode, json = String(responseHeader("content-type")).toLowerCase().includes("application/json");
    const contentLength = String(responseHeader("content-length"));
    const lengthMatches = !contentLength || (/^[0-9]+$/.test(contentLength) && Number(contentLength) === bytes);
    const complete = terminal === "finish" && ended && response.writableFinished && !error && !overflow && lengthMatches;
    let bodySha256 = null, foreign = false, inspectionError = overflow ? "encoded_body_limit" : null;
    if (complete && status >= 200 && status < 300 && json) {
      try {
        let body = Buffer.concat(chunks), encoding = String(responseHeader("content-encoding") || "identity").toLowerCase();
        const options = { maxOutputLength: limit };
        if (encoding === "gzip") body = gunzipSync(body, options);
        else if (encoding === "br") body = brotliDecompressSync(body, options);
        else if (encoding === "deflate") body = inflateSync(body, options);
        else assert(encoding === "identity");
        assert(body.length <= limit);
        const text = new TextDecoder().decode(body);
        JSON.parse(text); // An actual complete JSON body, never a status-only proof.
        bodySha256 = sha(text);
        foreign = /SYNTHETIC FOREIGN PRIVATE SENTINEL|FOREIGN-PRIVATE-UNIT/.test(text);
      } catch { inspectionError = "egress_json_inspection_failed"; }
    }
    chunks.length = 0;
    emit({ kind: "terminal", ...identity, status, json, complete,
      terminal, encodedBytes: bytes, bodySha256, foreign, inspectionError });
  };
  response.once(errorMonitor, () => { error = true; });
  response.once("finish", () => finish("finish"));
  response.once("close", () => finish("close"));
}

/** Independent server EOF can resolve ONLY a received JSON whose observer was
 * aborted later. Every matching actual request/response and every body remains
 * counted, including duplicates. Unknown or ambiguous binding always fails. */
export function qualifyQaServerBodies(network, observations, records, runId, diagnostics = []) {
  assert(Array.isArray(diagnostics));
  assert(!records.some(row => row.foreign), "Actual server egress contains a foreign private sentinel");
  const proofs = new Map(), starts = new Map(), terminals = new Map();
  for (const row of records) {
    assert(row.runId === runId && /^[a-f0-9]{64}$/.test(row.key) && /^[a-f0-9]{64}$/.test(row.captureKey));
    assert(Number.isSafeInteger(row.id) && row.id > 0);
    if (row.kind === "start") { assert(!starts.has(row.id)); starts.set(row.id, row); }
    else {
      assert(row.kind === "terminal" && !terminals.has(row.id));
      const start = starts.get(row.id);
      assert(start && ["key", "captureKey", "path", "method"].every(k => start[k] === row[k]));
      terminals.set(row.id, row);
    }
  }
  const candidates = observations.filter(row => row.kind === "terminal" && (row.bodyError || isQaPreheaderAbortedRead(row)));
  const keys = new Set(candidates.map(row => row.key));
  const nativeCounts = new Map(), originalCounts = new Map();
  for (const row of network.filter(row => row.kind === "response" && row.ok && row.json)) nativeCounts.set(row.key, (nativeCounts.get(row.key) ?? 0) + 1);
  for (const row of observations.filter(row => row.kind === "terminal" && row.bodyInspected)) originalCounts.set(row.key, (originalCounts.get(row.key) ?? 0) + 1);
  for (const [key, native] of nativeCounts) if (native > (originalCounts.get(key) ?? 0)) keys.add(key);
  for (const key of keys) {
    const group = candidates.filter(row => row.key === key);
    const unresolvedSiblings = observations.filter(row => row.key === key && unresolvedOriginalSibling(row));
    const nativeRequests = network.filter(row => row.kind === "request" && row.key === key);
    const nativeResponses = network.filter(row => row.kind === "response" && row.key === key);
    const allServerStarts = [...starts.values()].filter(row => row.key === key);
    const nativeBodies = nativeResponses.filter(row => row.ok && row.json);
    const fingerprints = new Set(nativeRequests.map(row => row.captureKey));
    // The server relay covers the whole run; this native audit covers one page.
    // Unclaimed sessions cannot supply or replace a claimed group's evidence.
    const serverStarts = allServerStarts.filter(row => fingerprints.has(row.captureKey));
    const diagnosticKey = runId + "/" + key;
    if (!diagnosticReferences.has(diagnosticKey)) {
      assert(diagnosticReferences.size < 20000);
      diagnosticReferences.set(diagnosticKey, randomBytes(16).toString("hex"));
    }
    const report = (reason, extra = {}) => diagnostics.push({ reference: diagnosticReferences.get(diagnosticKey), reason,
      nativeRequestCount: nativeRequests.length, nativeResponseCount: nativeResponses.length,
      nativeSuccessfulJsonCount: nativeBodies.length, fingerprintGroupCount: fingerprints.size,
      serverStartCount: serverStarts.length, serverTerminalCount: serverStarts.filter(row => terminals.has(row.id)).length,
      unclaimedServerStartCount: allServerStarts.length - serverStarts.length, originalCandidateCount: group.length,
      unresolvedOriginalSiblingCount: unresolvedSiblings.length,
      bodyErrorCount: group.filter(row => row.bodyError).length, preHeaderAbortedReadCount: group.filter(isQaPreheaderAbortedRead).length, ...extra });
    if (!group.length) { report("NO_ELIGIBLE_ORIGINAL_TERMINAL"); continue; }
    if (unresolvedSiblings.length !== group.length) { report("INELIGIBLE_UNRESOLVED_SIBLING"); continue; }
    if (group.some(row => !receivedBodyFailure(row) && !isQaPreheaderAbortedRead(row))) { report("INELIGIBLE_ORIGINAL_BODY"); continue; }
    if (group.some(row => isQaPreheaderAbortedRead(row) && !preheaderStartBound(row, observations))) { report("PREHEADER_START_BINDING_INVALID"); continue; }
    if (!nativeRequests.length || [...fingerprints].some(value => !validFingerprint(value))) { report("NATIVE_REQUEST_FINGERPRINT_MISSING"); continue; }
    if (nativeResponses.some(row => !validFingerprint(row.captureKey))) { report("NATIVE_RESPONSE_FINGERPRINT_MISSING"); continue; }
    if (nativeResponses.some(row => !fingerprints.has(row.captureKey))) { report("UNMATCHED_AUTH_GROUP"); continue; }
    const authGroups = []; let rejected = false;
    for (const captureKey of fingerprints) {
      const requests = nativeRequests.filter(row => row.captureKey === captureKey);
      const responses = nativeResponses.filter(row => row.captureKey === captureKey);
      const matched = serverStarts.filter(row => row.captureKey === captureKey);
      const detail = { groupNativeRequestCount: requests.length, groupNativeResponseCount: responses.length, groupServerStartCount: matched.length };
      if (matched.length !== requests.length || responses.length > requests.length) { report("AUTH_GROUP_REQUEST_COUNT_MISMATCH", detail); rejected = true; break; }
      if (matched.some(row => !terminals.has(row.id))) { report("AUTH_GROUP_TERMINAL_MISSING", detail); rejected = true; break; }
      const bodies = matched.map(row => terminals.get(row.id)).filter(row => row.json && row.status >= 200 && row.status < 300);
      if (bodies.some(row => !row.complete || row.terminal !== "finish" || row.inspectionError || row.foreign || !validFingerprint(row.bodySha256))) { report("INCOMPLETE_OR_UNSAFE_SERVER_BODY", detail); rejected = true; break; }
      if (!equalCounts(counts(bodies), counts(responses.filter(row => row.ok && row.json)))) { report("AUTH_GROUP_SUCCESSFUL_BODY_STATUS_MISMATCH", detail); rejected = true; break; }
      authGroups.push({ captureKey, serverIds: matched.map(row => row.id), nativeRequestCount: requests.length,
        successfulJsonBodyCount: bodies.length, bodyHashes: bodies.map(row => ({ status: row.status, sha256: row.bodySha256 })) });
    }
    if (rejected) continue;
    const serverBodies = serverStarts.map(row => terminals.get(row.id)).filter(row => row.json && row.status >= 200 && row.status < 300);
    const remaining = [...serverBodies];
    let unmatchedOriginal = false;
    for (const row of observations.filter(row => row.kind === "terminal" && row.key === key && row.bodyInspected)) {
      const i = remaining.findIndex(body => body.status === row.status && body.bodySha256 === row.bodySha256);
      if (i < 0) { unmatchedOriginal = true; break; }
      remaining.splice(i, 1);
    }
    if (unmatchedOriginal) { report("ORIGINAL_BODY_MULTISET_MISMATCH"); continue; }
    const receivedFailures = group.filter(receivedBodyFailure), preHeaderReads = group.filter(isQaPreheaderAbortedRead);
    if (!remaining.length) { report("NO_UNINSPECTED_NATIVE_JSON_BODY"); continue; }
    if (remaining.length < receivedFailures.length || remaining.length > group.length) { report("UNRESOLVED_BODY_COUNT_MISMATCH", { remainingBodyCount: remaining.length }); continue; }
    const unresolvedCounts = counts(remaining), receivedCounts = counts(receivedFailures);
    if ([...receivedCounts].some(([status, n]) => (unresolvedCounts.get(status) ?? 0) < n)) { report("UNRESOLVED_BODY_STATUS_MISMATCH"); continue; }
    // Do not invent FIFO identity for simultaneous identical requests. The
    // evidence is the complete, two-sided, fully inspected authenticated bag.
    for (const row of group) proofs.set(`${row.documentId}/${row.id}`, {
      source: "actual-node-egress-finish-multiset", requestKey: key, authGroups, status: row.status,
      serverIds: serverStarts.map(start => start.id), nativeRequestCount: nativeRequests.length,
      successfulJsonBodyCount: serverBodies.length, resolvedBodyCount: remaining.length,
      originalCandidateCount: group.length, receivedBodyErrorCount: receivedFailures.length, preHeaderAbortedReadCount: preHeaderReads.length,
      bodyHashes: serverBodies.map(body => ({ status: body.status, sha256: body.bodySha256 })),
    });
    report("QUALIFIED_COMPLETE_AUTH_GROUPS", { serverSuccessfulJsonCount: serverBodies.length });
  }
  return proofs;
}

/** Every group remains private RAM evidence; no per-original/session or FIFO
 * identity is asserted by the union of completely inspected authenticated bags. */
export function validQaServerAuthGroups(network, row, proof) {
  if (!Array.isArray(proof.authGroups) || !proof.authGroups.length || proof.requestKey !== row.key) return false;
  const groups = proof.authGroups, fingerprints = groups.map(group => group.captureKey);
  if (fingerprints.some(value => !validFingerprint(value)) || new Set(fingerprints).size !== fingerprints.length) return false;
  const requests = network.filter(item => item.kind === "request" && item.key === row.key);
  const responses = network.filter(item => item.kind === "response" && item.key === row.key);
  if ([...requests, ...responses].some(item => !fingerprints.includes(item.captureKey))) return false;
  for (const group of groups) {
    const actualRequests = requests.filter(item => item.captureKey === group.captureKey);
    const actualResponses = responses.filter(item => item.captureKey === group.captureKey);
    const actualBodies = responses.filter(item => item.captureKey === group.captureKey && item.ok && item.json);
    if (!actualRequests.length || actualResponses.length > actualRequests.length || !Array.isArray(group.serverIds) || group.serverIds.length !== actualRequests.length ||
      group.nativeRequestCount !== actualRequests.length || group.successfulJsonBodyCount !== actualBodies.length ||
      !Array.isArray(group.bodyHashes) || group.bodyHashes.length !== actualBodies.length ||
      group.bodyHashes.some(body => !Number.isInteger(body.status) || body.status < 200 || body.status >= 300 || !validFingerprint(body.sha256)) ||
      !equalCounts(counts(group.bodyHashes), counts(actualBodies))) return false;
  }
  const ids = groups.flatMap(group => group.serverIds), hashes = groups.flatMap(group => group.bodyHashes);
  const bag = rows => counts(rows.map(body => ({ status: body.status + "/" + body.sha256 })));
  return new Set(ids).size === ids.length && ids.length === proof.serverIds.length &&
    ids.every(id => Number.isSafeInteger(id) && id > 0 && proof.serverIds.includes(id)) &&
    equalCounts(bag(hashes), bag(proof.bodyHashes));
}

export function validQaServerOriginalBag(observations, row, proof) {
  const candidates = observations.filter(item => item.kind === "terminal" && item.key === row.key && (item.bodyError || isQaPreheaderAbortedRead(item)));
  const unresolvedSiblings = observations.filter(item => item.key === row.key && unresolvedOriginalSibling(item));
  const received = candidates.filter(receivedBodyFailure), preHeader = candidates.filter(isQaPreheaderAbortedRead);
  if (unresolvedSiblings.length !== candidates.length || candidates.length !== received.length + preHeader.length || proof.originalCandidateCount !== candidates.length ||
    proof.receivedBodyErrorCount !== received.length || proof.preHeaderAbortedReadCount !== preHeader.length ||
    preHeader.some(item => !preheaderStartBound(item, observations))) return false;
  const remaining = [...proof.bodyHashes];
  for (const body of observations.filter(item => item.kind === "terminal" && item.key === row.key && item.bodyInspected)) {
    const index = remaining.findIndex(item => item.status === body.status && item.sha256 === body.bodySha256);
    if (index < 0) return false;
    remaining.splice(index, 1);
  }
  const available = counts(remaining);
  return proof.resolvedBodyCount === remaining.length && remaining.length > 0 && remaining.length >= received.length &&
    remaining.length <= candidates.length && [...counts(received)].every(([status, n]) => (available.get(status) ?? 0) >= n);
}
