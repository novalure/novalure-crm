import { randomBytes } from "node:crypto";
import { validQaServerAuthGroups, validQaServerOriginalBag, isQaPreheaderAbortedRead } from "./qa-server-response-capture.mjs";
const opaqueReferences = new Map();
const opaqueReference = value => {
  if (typeof value !== "string") return null;
  if (!opaqueReferences.has(value)) opaqueReferences.set(value, randomBytes(32).toString("hex"));
  return opaqueReferences.get(value);
};
export function safeQaFetchDiagnostic(value) {
  if (Array.isArray(value)) return value.map(safeQaFetchDiagnostic);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) =>
    key === "bodySha256" || key === "captureKey" ? [key + "Present", typeof item === "string"] :
    key === "key" ? [key, opaqueReference(item)] : [key, safeQaFetchDiagnostic(item)]));
}

/** Finish observed API traffic and its body inspection before destroying a document. */
export function createResponseInspectionBarrier() {
  const requests = new Map();
  const checks = new Map();
  return {
    started(request, metadata = {}) {
      let finish;
      const done = new Promise(resolve => { finish = resolve; });
      requests.set(request, { done, finish, metadata });
    },
    finished(request) {
      requests.get(request)?.finish();
      requests.delete(request);
    },
    inspect(check, request) {
      checks.set(check, requests.get(request)?.metadata ?? {});
      // A settled body check is a terminal observation even when the browser
      // never publishes requestfinished. Its errors remain caller-owned evidence.
      const settled = () => {
        checks.delete(check);
        if (request) { requests.get(request)?.finish(); requests.delete(request); }
      };
      void check.then(settled, settled);
    },
    pendingInfo() {
      return [...requests.values()].map(row => ({ ...row.metadata, phase: "request" }))
        .concat([...checks.values()].map(metadata => ({ ...metadata, phase: "response-body" }))).slice(0, 10);
    },
    async drain(timeoutMs = 15_000) {
      let timer;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("Pending API/body inspection before navigation timed out")), timeoutMs);
      });
      try {
        while (requests.size || checks.size) {
          await Promise.race([
            Promise.allSettled([...requests.values()].map(row => row.done).concat([...checks.keys()])),
            timeout,
          ]);
        }
      } finally { clearTimeout(timer); }
    },
  };
}

/** Observe the original same-origin API Fetch lifecycle and finite JSON bodies.
 * The original fetch promise/Response, request, cookies, CSRF and application
 * consumption are unchanged. A server body that never ends still never resolves.
 * Serialized by Playwright addInitScript; deliberately has no module closure.
 */
export function observeQaFetchBodies({ origin, bindingTransport = "playwright" }) {
  const active = new Map(), bridges = new Set();
  const readAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted").get;
  const readAbortReason = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "reason").get;
  const state = { errors: [], foreign: false, completed: 0, sequence: 0 };
  const documentId = `${Date.now()}-${Math.random()}`;
  const digest = async value => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))].map(n => n.toString(16).padStart(2, "0")).join("");
  const metadata = e => ({ id: e.id, documentId, key: e.key, path: e.path, method: e.method,
    phase: e.phase, status: e.status ?? null, json: e.json ?? false, bodyInspected: e.bodyInspected ?? false,
    signalAborted: e.signal?.aborted === true, keepalive: e.keepalive, foreign: e.foreign ?? false,
    signalAbortedAtStart: e.signalAbortedAtStart, preAbortedNoDispatch: e.preAbortedNoDispatch ?? false,
    rejectedWithOriginalAbortReason: e.rejectedWithOriginalAbortReason ?? false,
    bodyError: e.bodyError ?? null, failedBeforeHeaders: e.failedBeforeHeaders ?? false,
    retiredReadBeforeHeaders: e.retiredReadBeforeHeaders ?? false, bodySha256: e.bodySha256 ?? null });
  const report = (kind, e) => {
    const deliver = key => {
      e.key = key;
      const event = { kind, ...metadata(e) };
      return globalThis.__crmQaFetchReport(bindingTransport === "cdp" ? JSON.stringify(event) : event);
    };
    let task;
    try {
      // pagehide can be the last synchronous callback of this document. With
      // the real hash ready, enqueue its actual message before returning.
      task = /^[a-f0-9]{64}$/.test(e.key ?? "") ? Promise.resolve(deliver(e.key)) : e.keyPromise.then(deliver);
    } catch { state.errors.push("fetch_observer_bridge_failed"); return; }
    task = task.catch(() => { state.errors.push("fetch_observer_bridge_failed"); });
    bridges.add(task); void task.finally(() => bridges.delete(task));
  };
  const finish = e => {
    if (!active.has(e.id)) return;
    active.delete(e.id); report("terminal", e);
  };
  state.snapshot = () => ({ pending: active.size, completed: state.completed, foreign: state.foreign,
    bridgesPending: bridges.size, sequence: state.sequence,
    errors: state.errors.slice(0, 10), pendingInfo: [...active.values()].slice(0, 10).map(metadata) });
  state.drain = async (timeoutMs = 15000) => {
    const until = Date.now() + timeoutMs;
    let quiet = 0, sequence = state.sequence;
    while (Date.now() < until) {
      if (until - Date.now() < 50) break;
      await new Promise(resolve => setTimeout(resolve, 50));
      if (Date.now() >= until) break;
      if (!active.size && !bridges.size && sequence === state.sequence) quiet++;
      else { quiet = 0; sequence = state.sequence; }
      if (quiet >= 2) return { ok: state.errors.length === 0, timedOut: false, quietTurns: quiet, ...state.snapshot() };
    }
    return { ok: false, timedOut: true, quietTurns: quiet, ...state.snapshot() };
  };
  Object.defineProperty(globalThis, "__crmQaFetchBodies", { value: state });
  const perform = globalThis.fetch;
  globalThis.fetch = function (...args) {
    // Observe only an explicit own data-property signal through native getters.
    // No caller accessor is invoked or request argument changed before fetch.
    let preAbortedSignal, abortReasonAtCall;
    try {
      const descriptor = Object.getOwnPropertyDescriptor(args[1] ?? {}, "signal");
      if (descriptor && "value" in descriptor && readAborted.call(descriptor.value)) {
        preAbortedSignal = descriptor.value; abortReasonAtCall = readAbortReason.call(preAbortedSignal);
      }
    } catch { /* Unknown signal forms cannot qualify as undispatched calls. */ }
    const result = Reflect.apply(perform, this, args);
    let e;
    try {
      const input = args[0], init = args[1];
      const url = new URL(input instanceof Request ? input.url : String(input), globalThis.location?.href ?? origin);
      const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
      if (url.origin !== origin || !url.pathname.startsWith("/api/")) return result;
      e = { id: ++state.sequence, path: url.pathname, method, phase: "request",
        signal: init?.signal !== undefined ? init.signal : input instanceof Request ? input.signal : undefined,
        keepalive: init?.keepalive ?? (input instanceof Request ? input.keepalive : false),
        keyPromise: digest(method + "\0" + url.href) };
      e.signalAbortedAtStart = preAbortedSignal !== undefined && e.signal === preAbortedSignal;
      active.set(e.id, e); report("start", e);
    } catch { state.errors.push("fetch_observer_metadata_failed"); return result; }
    void result.then(response => {
      if (!active.has(e.id)) return;
      e.status = response.status; e.json = (response.headers.get("content-type") ?? "").includes("application/json");
      if (!response.ok || !e.json) { e.phase = "response-not-json-success"; finish(e); return; }
      e.phase = "body";
      let clone;
      try { clone = response.clone(); }
      catch { e.bodyError = "clone_failed"; state.errors.push(e.bodyError); finish(e); return; }
      void clone.text().then(async body => {
        e.bodySha256 = await digest(body);
        e.foreign = /SYNTHETIC FOREIGN PRIVATE SENTINEL|FOREIGN-PRIVATE-UNIT/.test(body);
        state.foreign ||= e.foreign; e.bodyInspected = true; e.phase = "body-eof";
        state.completed++;
      }, () => { e.bodyError = "body_read_failed"; state.errors.push(e.bodyError); }).catch(() => { e.bodyError = "body_observation_failed"; state.errors.push(e.bodyError); }).finally(() => finish(e));
    }, error => {
      e.failedBeforeHeaders = true; e.phase = e.signal?.aborted ? "fetch-aborted-before-headers" : "fetch-rejected-before-headers";
      e.rejectedWithOriginalAbortReason = e.signalAbortedAtStart && error === abortReasonAtCall && error instanceof DOMException && error.name === "AbortError";
      e.preAbortedNoDispatch = e.rejectedWithOriginalAbortReason && e.method === "GET" && !e.keepalive;
      if (e.preAbortedNoDispatch) e.phase = "fetch-aborted-before-dispatch";
      if (!["GET", "HEAD", "OPTIONS"].includes(e.method)) { e.bodyError = "unsafe_fetch_outcome_without_headers"; state.errors.push(e.bodyError); }
      finish(e);
    });
    return result;
  };
  globalThis.addEventListener("pagehide", event => {
    if (event.persisted) return;
    for (const e of active.values()) {
      // A retired non-keepalive GET with no response has no JSON body to waive.
      // Unknown writes, keepalive and bodies already received remain failures.
      if (e.phase === "request" && e.method === "GET" && !e.keepalive) {
        e.retiredReadBeforeHeaders = true; e.phase = "document-retired-before-headers";
      } else { e.bodyError = "document_retired_with_uninspected_response_or_write"; state.errors.push(e.bodyError); }
      finish(e);
    }
  });
}

const requestTrace = row => ({ documentId: row.documentId ?? null, id: row.id ?? null,
  key: opaqueReference(row.key), path: row.path ?? null, method: row.method ?? null });

/** Complete bounded metadata only; overflow is a caller-owned failure, never a
 * silent partial coverage claim. The internal full audit is not modified. */
export function collectFetchLifecycleDiagnostics(audits) {
  const rows = audits.flatMap(audit => audit.observations), limit = 4000;
  const ids = row => `${row.documentId}/${row.id}`;
  const terminalIds = new Set(rows.filter(row => row.kind === "terminal").map(ids));
  const missing = rows.filter(row => row.kind === "start" && !terminalIds.has(ids(row)));
  const terminalFields = ["phase", "status", "json", "bodyInspected", "signalAborted", "signalAbortedAtStart", "preAbortedNoDispatch", "rejectedWithOriginalAbortReason", "keepalive", "foreign", "bodyError", "failedBeforeHeaders", "retiredReadBeforeHeaders"];
  return { complete: rows.length <= limit, limit, total: rows.length,
    missingTerminalCount: missing.length, missingTerminalExamples: missing.slice(0, 10).map(requestTrace),
    events: rows.slice(0, limit).map(row => ({ kind: row.kind, role: row.role ?? null, ...requestTrace(row),
      ...Object.fromEntries((row.kind === "terminal" ? terminalFields : ["signalAbortedAtStart", "keepalive"]).map(field => [field, row[field] ?? null])),
      ...(row.kind === "terminal" ? { bodyHashPresent: typeof row.bodySha256 === "string" } : {}) })) };
}

/** Native CDP already copied this string out of the document. Parsing never
 * evaluates a destroyed execution context or acknowledges through that context. */
export function parseQaFetchBindingMessage(message) {
  if (message.name !== "__crmQaFetchReport") return null;
  if (typeof message.payload !== "string" || message.payload.length >= 8192 || !Number.isSafeInteger(message.executionContextId))
    throw new Error("INVALID_NATIVE_FETCH_BINDING");
  const row = JSON.parse(message.payload);
  const fields = ["kind", "id", "documentId", "key", "path", "method", "phase", "status", "json", "bodyInspected", "signalAborted", "keepalive", "foreign", "signalAbortedAtStart", "preAbortedNoDispatch", "rejectedWithOriginalAbortReason", "bodyError", "failedBeforeHeaders", "retiredReadBeforeHeaders", "bodySha256"];
  if (Object.keys(row).some(key => !fields.includes(key)) || !["start", "terminal"].includes(row.kind) || !/^[a-f0-9]{64}$/.test(row.key) ||
    !Number.isSafeInteger(row.id) || row.id <= 0 || typeof row.documentId !== "string" || !/^[0-9]+-[0-9.e+-]+$/.test(row.documentId) || row.documentId.length >= 100 ||
    !/^\/api\/[A-Za-z0-9._~%/-]{1,450}$/.test(row.path) || !/^[A-Z]{3,8}$/.test(row.method) ||
    !["request", "body", "body-eof", "response-not-json-success", "fetch-aborted-before-headers", "fetch-rejected-before-headers", "fetch-aborted-before-dispatch", "document-retired-before-headers"].includes(row.phase) ||
    (row.status !== null && (!Number.isInteger(row.status) || row.status < 0 || row.status > 599)) ||
    ![null, "clone_failed", "body_read_failed", "body_observation_failed", "unsafe_fetch_outcome_without_headers", "document_retired_with_uninspected_response_or_write"].includes(row.bodyError) ||
    (row.bodySha256 !== null && !/^[a-f0-9]{64}$/.test(row.bodySha256))) throw new Error("INVALID_NATIVE_FETCH_BINDING");
  for (const key of ["json", "bodyInspected", "signalAborted", "keepalive", "foreign", "signalAbortedAtStart", "preAbortedNoDispatch", "rejectedWithOriginalAbortReason", "failedBeforeHeaders", "retiredReadBeforeHeaders"])
    if (typeof row[key] !== "boolean") throw new Error("INVALID_NATIVE_FETCH_BINDING");
  if (row.bodyInspected && (!row.json || row.status < 200 || row.status >= 300 || !/^[a-f0-9]{64}$/.test(row.bodySha256))) throw new Error("INVALID_NATIVE_FETCH_BINDING");
  if (row.retiredReadBeforeHeaders && (row.method !== "GET" || row.status !== null || row.keepalive || row.bodyInspected)) throw new Error("INVALID_NATIVE_FETCH_BINDING");
  return row;
}

export function assertObservedFetchCoverage(network, observations, serverBodyProofs = new Map()) {
  const startsById = new Map(), terminalIds = new Set(), undispatchedIds = new Set();
  for (const row of observations) {
    const id = `${row.documentId}/${row.id}`;
    if (row.kind === "start") {
      if (startsById.has(id)) throw new Error("DUPLICATE_ORIGINAL_FETCH_START");
      startsById.set(id, row);
    } else {
      const start = startsById.get(id);
      if (row.kind !== "terminal" || !start || terminalIds.has(id) ||
        ["key", "path", "method"].some(field => row[field] !== start[field]))
        throw new Error("UNBOUND_ORIGINAL_FETCH_TERMINAL");
      terminalIds.add(id);
      if (row.preAbortedNoDispatch) {
        if (!start.signalAbortedAtStart || !row.signalAbortedAtStart || !row.rejectedWithOriginalAbortReason ||
          !row.failedBeforeHeaders || !row.signalAborted || row.method !== "GET" || row.keepalive ||
          row.phase !== "fetch-aborted-before-dispatch" || row.status !== null || row.json || row.bodyInspected || row.bodySha256 !== null || row.bodyError)
          throw new Error("INVALID_PREABORTED_FETCH_PROOF");
        undispatchedIds.add(id);
      }
    }
  }
  const missing = [...startsById].filter(([id]) => !terminalIds.has(id)).map(([, row]) => row);
  if (missing.length) {
    const error = new Error("UNSETTLED_ORIGINAL_FETCH_LIFECYCLE");
    error.coverage = { missingTerminalCount: missing.length, missingTerminalExamples: missing.slice(0, 10).map(requestTrace) };
    throw error;
  }
  if (observations.some(r => r.bodyInspected && (!r.json || !Number.isInteger(r.status) || r.status < 200 || r.status >= 300 || !/^[a-f0-9]{64}$/.test(r.bodySha256))))
    throw new Error("INVALID_ORIGINAL_BODY_PROOF");
  const count = (rows, key) => rows.reduce((m, r) => m.set(key(r), (m.get(key(r)) ?? 0) + 1), new Map());
  const countFailure = (code, key, nativeCount, originalCount) => {
    const error = new Error(code); error.coverage = { key: opaqueReference(key), nativeCount, originalCount }; throw error;
  };
  const starts = count([...startsById].filter(([id]) => !undispatchedIds.has(id)).map(([, row]) => row), r => r.key);
  const actual = count(network.filter(r => r.kind === "request"), r => r.key);
  for (const [key, n] of actual) if ((starts.get(key) ?? 0) < n) countFailure("UNOBSERVED_NATIVE_FETCH_REQUEST", key, n, starts.get(key) ?? 0);
  for (const [key, n] of starts) if ((actual.get(key) ?? 0) < n) countFailure("UNMATCHED_ORIGINAL_FETCH_START", key, actual.get(key) ?? 0, n);
  const expectedBodies = count(network.filter(r => r.kind === "response" && r.ok && r.json), r => `${r.key}/${r.status}`);
  const bodyProven = row => {
    const proof = serverBodyProofs.get(`${row.documentId}/${row.id}`);
    if (!proof) return false;
    if (proof.source !== "actual-node-egress-finish-multiset" || proof.status !== row.status ||
      !Array.isArray(proof.serverIds) ||
      proof.serverIds.length !== proof.nativeRequestCount || new Set(proof.serverIds).size !== proof.serverIds.length ||
      proof.serverIds.some(id => !Number.isSafeInteger(id) || id <= 0) ||
      proof.nativeRequestCount !== network.filter(item => item.kind === "request" && item.key === row.key).length ||
      proof.successfulJsonBodyCount !== network.filter(item => item.kind === "response" && item.key === row.key && item.ok && item.json).length ||
      !Array.isArray(proof.bodyHashes) || proof.bodyHashes.length !== proof.successfulJsonBodyCount ||
      proof.bodyHashes.some(body => !Number.isInteger(body.status) || body.status < 200 || body.status >= 300 || !/^[a-f0-9]{64}$/.test(body.sha256)) ||
      (!(row.bodyError === "body_read_failed" && row.json && row.status >= 200 && row.status < 300 && row.method === "GET" &&
        !row.keepalive && !row.signalAbortedAtStart && row.signalAborted && !row.bodyInspected) && !isQaPreheaderAbortedRead(row)) ||
      !validQaServerAuthGroups(network, row, proof) || !validQaServerOriginalBag(observations, row, proof))
      throw new Error("INVALID_SERVER_EGRESS_BODY_PROOF");
    return true;
  };
  const bodies = count(observations.filter(r => r.kind === "terminal" && r.bodyInspected), r => `${r.key}/${r.status}`);
  const qualifiedBags = new Map();
  for (const row of observations.filter(row => row.kind === "terminal")) if (bodyProven(row)) qualifiedBags.set(row.key, serverBodyProofs.get(`${row.documentId}/${row.id}`));
  for (const [key, proof] of qualifiedBags) {
    // A complete actual server bag replaces body counts for this exact key.
    // It never assigns a successful status or body to an aborted original call.
    for (const name of bodies.keys()) if (name.startsWith(key + "/")) bodies.delete(name);
    for (const body of proof.bodyHashes) { const name = `${key}/${body.status}`; bodies.set(name, (bodies.get(name) ?? 0) + 1); }
  }
  for (const [key, n] of expectedBodies) if ((bodies.get(key) ?? 0) < n) countFailure("UNINSPECTED_NATIVE_SUCCESSFUL_JSON_BODY", key, n, bodies.get(key) ?? 0);
  for (const [key, n] of bodies) if ((expectedBodies.get(key) ?? 0) < n) countFailure("UNMATCHED_ORIGINAL_SUCCESSFUL_JSON_BODY", key, expectedBodies.get(key) ?? 0, n);
  if (observations.some(r => r.kind === "terminal" && r.bodyError && !bodyProven(r))) throw new Error("ORIGINAL_FETCH_BODY_INSPECTION_FAILED");
}

/** Fragment/identical URLs are same-document navigations, not fresh fixtures. */
export function requiresCrmDocumentReload(previous, next) {
  const from = new URL(previous), to = new URL(next);
  return from.origin === to.origin && from.pathname === to.pathname && from.search === to.search;
}
