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
export function observeQaFetchBodies({ origin }) {
  const active = new Map(), bridges = new Set();
  const state = { errors: [], foreign: false, completed: 0, sequence: 0 };
  const documentId = `${Date.now()}-${Math.random()}`;
  const digest = async value => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))].map(n => n.toString(16).padStart(2, "0")).join("");
  const metadata = e => ({ id: e.id, documentId, key: e.key, path: e.path, method: e.method,
    phase: e.phase, status: e.status ?? null, json: e.json ?? false, bodyInspected: e.bodyInspected ?? false,
    signalAborted: e.signal?.aborted === true, keepalive: e.keepalive, foreign: e.foreign ?? false,
    bodyError: e.bodyError ?? null, failedBeforeHeaders: e.failedBeforeHeaders ?? false,
    retiredReadBeforeHeaders: e.retiredReadBeforeHeaders ?? false, bodySha256: e.bodySha256 ?? null });
  const report = (kind, e) => {
    const task = e.keyPromise.then(async key => {
      e.key = key;
      await globalThis.__crmQaFetchReport({ kind, ...metadata(e) });
    }).catch(() => { state.errors.push("fetch_observer_bridge_failed"); });
    bridges.add(task); void task.finally(() => bridges.delete(task));
  };
  const finish = e => {
    if (!active.has(e.id)) return;
    active.delete(e.id); report("terminal", e);
  };
  state.snapshot = () => ({ pending: active.size, completed: state.completed, foreign: state.foreign,
    errors: state.errors.slice(0, 10), pendingInfo: [...active.values()].slice(0, 10).map(metadata) });
  state.drain = async (timeoutMs = 15000) => {
    const until = Date.now() + timeoutMs;
    let quiet = 0, sequence = state.sequence;
    while (Date.now() < until) {
      await new Promise(resolve => setTimeout(resolve, 50));
      if (!active.size && !bridges.size && sequence === state.sequence) quiet++;
      else { quiet = 0; sequence = state.sequence; }
      if (quiet >= 2) return { ok: state.errors.length === 0, ...state.snapshot() };
    }
    return { ok: false, ...state.snapshot() };
  };
  Object.defineProperty(globalThis, "__crmQaFetchBodies", { value: state });
  const perform = globalThis.fetch;
  globalThis.fetch = function (...args) {
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
    }, () => {
      e.failedBeforeHeaders = true; e.phase = e.signal?.aborted ? "fetch-aborted-before-headers" : "fetch-rejected-before-headers";
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

export function assertObservedFetchCoverage(network, observations) {
  const startsById = new Set(), terminalIds = new Set();
  for (const row of observations) {
    const id = `${row.documentId}/${row.id}`;
    if (row.kind === "start") { if (startsById.has(id)) throw new Error("DUPLICATE_ORIGINAL_FETCH_START"); startsById.add(id); }
    else { if (!startsById.has(id) || terminalIds.has(id)) throw new Error("UNBOUND_ORIGINAL_FETCH_TERMINAL"); terminalIds.add(id); }
  }
  if ([...startsById].some(id => !terminalIds.has(id))) throw new Error("UNSETTLED_ORIGINAL_FETCH_LIFECYCLE");
  if (observations.some(r => r.bodyInspected && (!r.json || r.status < 200 || r.status >= 300 || !/^[a-f0-9]{64}$/.test(r.bodySha256))))
    throw new Error("INVALID_ORIGINAL_BODY_PROOF");
  const count = (rows, key) => rows.reduce((m, r) => m.set(key(r), (m.get(key(r)) ?? 0) + 1), new Map());
  const starts = count(observations.filter(r => r.kind === "start"), r => r.key);
  const actual = count(network.filter(r => r.kind === "request"), r => r.key);
  for (const [key, n] of actual) if ((starts.get(key) ?? 0) < n) throw new Error("UNOBSERVED_NATIVE_FETCH_REQUEST");
  const expectedBodies = count(network.filter(r => r.kind === "response" && r.ok && r.json), r => `${r.key}/${r.status}`);
  const bodies = count(observations.filter(r => r.kind === "terminal" && r.bodyInspected), r => `${r.key}/${r.status}`);
  for (const [key, n] of expectedBodies) if ((bodies.get(key) ?? 0) < n) throw new Error("UNINSPECTED_NATIVE_SUCCESSFUL_JSON_BODY");
  if (observations.some(r => r.kind === "terminal" && r.bodyError)) throw new Error("ORIGINAL_FETCH_BODY_INSPECTION_FAILED");
}

/** Fragment/identical URLs are same-document navigations, not fresh fixtures. */
export function requiresCrmDocumentReload(previous, next) {
  const from = new URL(previous), to = new URL(next);
  return from.origin === to.origin && from.pathname === to.pathname && from.search === to.search;
}
