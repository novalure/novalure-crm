import { caller } from "./caller.mjs";

function emptyIncomingBody(req, timeoutMs) {
  const parsed = req.body;
  if (parsed !== undefined && parsed !== null && parsed !== "" &&
      !(Buffer.isBuffer(parsed) && parsed.byteLength === 0)) return Promise.resolve(false);
  if (req.readableEnded) return Promise.resolve(true);
  return new Promise((resolve) => {
    const finish = (empty) => {
      clearTimeout(timer);
      req.off("data", data); req.off("end", end); req.off("error", error); req.off("close", error);
      resolve(empty);
    };
    const data = (chunk) => { if (chunk.length > 0) finish(false); };
    const end = () => finish(true);
    const error = () => finish(false);
    const timer = setTimeout(() => finish(false), timeoutMs);
    req.on("data", data); req.once("end", end); req.once("error", error); req.once("close", error);
  });
}

/** Dependency overrides exist only for local adapter tests. */
export function createNodeHandler({ env = process.env, call = caller, bodyTimeoutMs = 1000 } = {}) {
  return async (req, res) => {
    const host = env.VERCEL_URL;
    if (req.method !== "POST" || req.url !== "/api/package4-machine-proof" ||
        req.headers.host !== host || req.headers["transfer-encoding"] ||
        (req.headers["content-length"] && req.headers["content-length"] !== "0") ||
        !(await emptyIncomingBody(req, bodyTimeoutMs))) {
      res.writeHead(400, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({ status: "FAIL", code: "QA_CALLER_TRIGGER_DENIED" }));
      return;
    }
    const response = await call(new Request(`https://${host}/api/package4-machine-proof`, {
      method: "POST", headers: { "x-package4-qa-challenge": req.headers["x-package4-qa-challenge"] ?? "" },
    }));
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(await response.text());
  };
}

export default createNodeHandler();
