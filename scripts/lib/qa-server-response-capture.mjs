// Test-harness evidence only. Never changes request/response headers or payloads.
import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";

export const QA_CAPTURE_LIMIT = 2 * 1024 * 1024;
const sha = value => createHash("sha256").update(value).digest("hex");
const header = (headers, name) => String(headers[name] ?? "");
export function qaRequestFingerprint(secret, method, url, headers) {
  assert(/^[a-f0-9]{64}$/.test(secret));
  // Values stay in local host RAM. The per-run digest crosses owned IPC only;
  // neither credential-derived digests nor header/URL values enter a file.
  return createHmac("sha256", secret).update(JSON.stringify([method, url,
    ...["cookie", "authorization", "user-agent", "accept", "sec-fetch-mode", "sec-fetch-dest"].map(name => header(headers, name)),
  ])).digest("hex");
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
    const finish = (error, rows) => { clearTimeout(timer); parent.off("message", receive); error ? reject(error) : resolve(rows); };
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
  response.once("error", () => { error = true; });
  response.once("finish", () => finish("finish"));
  response.once("close", () => finish("close"));
}

/** Independent server EOF can resolve ONLY a received JSON whose observer was
 * aborted later. Every matching actual request/response and every body remains
 * counted, including duplicates. Unknown or ambiguous binding always fails. */
export function qualifyQaServerBodies(network, observations, records, runId) {
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
  const candidates = observations.filter(row => row.kind === "terminal" && row.bodyError);
  for (const key of new Set(candidates.map(row => row.key))) {
    const group = candidates.filter(row => row.key === key);
    if (group.some(row => row.bodyError !== "body_read_failed" || row.method !== "GET" || row.keepalive ||
      row.signalAbortedAtStart || !row.signalAborted || !row.json || row.status < 200 || row.status >= 300 || row.bodyInspected)) continue;
    const nativeRequests = network.filter(row => row.kind === "request" && row.key === key);
    const fingerprints = new Set(nativeRequests.map(row => row.captureKey));
    if (fingerprints.size !== 1 || !/^[a-f0-9]{64}$/.test([...fingerprints][0] ?? "")) continue;
    const captureKey = [...fingerprints][0], serverStarts = [...starts.values()].filter(row => row.captureKey === captureKey);
    if (serverStarts.length !== nativeRequests.length || serverStarts.some(row => row.key !== key || !terminals.has(row.id))) continue;
    const serverBodies = serverStarts.map(row => terminals.get(row.id)).filter(row => row.json && row.status >= 200 && row.status < 300);
    if (serverBodies.some(row => !row.complete || row.terminal !== "finish" || row.inspectionError || row.foreign || !/^[a-f0-9]{64}$/.test(row.bodySha256 ?? ""))) continue;
    const nativeBodies = network.filter(row => row.kind === "response" && row.key === key && row.ok && row.json);
    const counts = rows => rows.reduce((map, row) => map.set(row.status, (map.get(row.status) ?? 0) + 1), new Map());
    const a = counts(serverBodies), b = counts(nativeBodies);
    if (a.size !== b.size || [...a].some(([status, n]) => b.get(status) !== n)) continue;
    const remaining = [...serverBodies];
    for (const row of observations.filter(row => row.kind === "terminal" && row.key === key && row.bodyInspected)) {
      const i = remaining.findIndex(body => body.status === row.status && body.bodySha256 === row.bodySha256);
      if (i < 0) { remaining.length = 0; break; }
      remaining.splice(i, 1);
    }
    if (remaining.length !== group.length) continue;
    const unresolvedCounts = counts(remaining), groupCounts = counts(group);
    if (unresolvedCounts.size !== groupCounts.size || [...unresolvedCounts].some(([status, n]) => groupCounts.get(status) !== n)) continue;
    // Do not invent FIFO identity for simultaneous identical requests. The
    // evidence is the complete, two-sided, fully inspected authenticated bag.
    for (const row of group) proofs.set(`${row.documentId}/${row.id}`, {
      source: "actual-node-egress-finish-multiset", captureKey, status: row.status,
      serverIds: serverStarts.map(start => start.id), nativeRequestCount: nativeRequests.length,
      successfulJsonBodyCount: serverBodies.length, resolvedBodyCount: group.length,
      bodyHashes: serverBodies.map(body => ({ status: body.status, sha256: body.bodySha256 })),
    });
  }
  return proofs;
}
