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

/** A second reader of the original finite session-heartbeat body, not a response patch.
 * The original fetch promise/Response, request, cookies, CSRF and application
 * consumption are unchanged. A server body that never ends still never resolves.
 * Serialized by Playwright addInitScript; deliberately has no module closure.
 */
export function observeQaHeartbeatBodies({ origin }) {
  const state = { pending: 0, completed: 0, foreign: false, errors: [] };
  Object.defineProperty(globalThis, "__crmQaHeartbeatBodies", { value: state });
  const perform = globalThis.fetch;
  globalThis.fetch = function (...args) {
    const result = Reflect.apply(perform, this, args);
    void result.then(response => {
      const input = args[0], init = args[1];
      const url = new URL(input instanceof Request ? input.url : String(input), origin);
      const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
      if (url.origin !== origin || url.pathname !== "/api/auth/session" || method !== "POST" ||
          !response.ok || !(response.headers.get("content-type") ?? "").includes("application/json")) return;
      state.pending++;
      let clone;
      try { clone = response.clone(); }
      catch { state.pending--; state.errors.push("heartbeat_clone_failed"); return; }
      void clone.text().then(body => {
        state.foreign ||= /SYNTHETIC FOREIGN PRIVATE SENTINEL|FOREIGN-PRIVATE-UNIT/.test(body);
        state.completed++;
      }, () => { state.errors.push("heartbeat_body_read_failed"); }).finally(() => { state.pending--; });
    }, () => { /* Original rejected promise still reaches its actual caller. */ });
    return result;
  };
}

/** Fragment/identical URLs are same-document navigations, not fresh fixtures. */
export function requiresCrmDocumentReload(previous, next) {
  const from = new URL(previous), to = new URL(next);
  return from.origin === to.origin && from.pathname === to.pathname && from.search === to.search;
}
