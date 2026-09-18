import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const startTimeoutMs = 120_000;
const stopTimeoutMs = 60_000;
const controller = new AbortController();
const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  /^(path|home|systemroot|windir|temp|tmp|tmpdir|userprofile|localappdata|appdata|programfiles|programfiles\(x86\)|comspec|pathext|number_of_processors|lang|lc_all)$/i.test(key)));
// Deliberately do not forward database, provider, auth or deployment variables.
environment.CRM_QA_BROWSER_CHANNEL = process.env.CRM_QA_BROWSER_CHANNEL || "chrome";
if (!["chrome", "chromium"].includes(environment.CRM_QA_BROWSER_CHANNEL)) {
  throw new Error("CRM_QA_BROWSER_CHANNEL must be chrome or chromium");
}

function launch(script, stdio) {
  const child = spawn(process.execPath, [script], {
    cwd: projectRoot, env: environment, stdio, windowsHide: true,
  });
  const completion = new Promise(resolve => {
    child.once("error", error => resolve({ error }));
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  return { child, completion };
}

async function within(promise, durationMs) {
  let timer;
  try {
    return await Promise.race([
      promise.then(value => ({ completed: true, value })),
      new Promise(resolve => { timer = setTimeout(() => resolve({ completed: false }), durationMs); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function abortable(promise) {
  if (controller.signal.aborted) return Promise.reject(controller.signal.reason);
  let onAbort;
  const interrupted = new Promise((_, reject) => {
    onAbort = () => reject(controller.signal.reason);
    controller.signal.addEventListener("abort", onAbort, { once: true });
  });
  return Promise.race([promise, interrupted]).finally(() => controller.signal.removeEventListener("abort", onAbort));
}

async function awaitReady(server) {
  const lines = createInterface({ input: server.child.stdout });
  const ready = new Promise((resolve, reject) => {
    lines.on("line", line => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (message.ready !== true) return;
      try {
        const url = new URL(message.baseUrl);
        if (message.syntheticOnly !== true || message.productionAccess !== 0 ||
            url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.username || url.password) {
          throw new Error("Local sales QA server returned an unsafe readiness record");
        }
        resolve(message);
      } catch (error) { reject(error); }
    });
  });
  try {
    const outcome = await abortable(within(Promise.race([
      ready,
      server.completion.then(result => { throw result.error || new Error(`Local sales QA server exited before readiness (${result.code ?? result.signal})`); }),
    ]), startTimeoutMs));
    if (!outcome.completed) throw new Error("Local sales QA server did not become ready within 120 seconds");
    return outcome.value;
  } finally {
    lines.close();
  }
}

async function stopOwned(processHandle, cooperative = false) {
  if (!processHandle) return;
  const { child, completion } = processHandle;
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (cooperative && !child.stdin.destroyed) child.stdin.end("stop\n");
  else child.kill("SIGTERM");
  const result = await within(completion, stopTimeoutMs);
  if (!result.completed) {
    // Only this exact spawned child is targeted; never discover or kill other processes.
    child.kill("SIGKILL");
    await within(completion, 5_000);
    throw new Error("Owned sales QA child required forced shutdown after 60 seconds");
  }
  if (cooperative && (result.value.error || result.value.code !== 0)) {
    throw result.value.error || new Error(`Local sales QA cleanup failed (${result.value.code ?? result.value.signal})`);
  }
}

let server;
let browser;
const interrupt = signal => controller.abort(new Error(`Sales QA interrupted by ${signal}`));
const onSigint = () => interrupt("SIGINT");
const onSigterm = () => interrupt("SIGTERM");
process.on("SIGINT", onSigint);
process.on("SIGTERM", onSigterm);
try {
  server = launch("scripts/qa-sales-browser-server.mjs", ["pipe", "pipe", "inherit"]);
  // A closed startup pipe must not turn cleanup into an unhandled EPIPE.
  server.child.stdin.on("error", () => {});
  const ready = await awaitReady(server);
  console.log(`Local sales QA ready at ${ready.baseUrl}; synthetic data only.`);
  browser = launch("scripts/qa-sales-browser.mjs", ["ignore", "inherit", "inherit"]);
  const result = await abortable(Promise.race([
    browser.completion,
    server.completion.then(value => { throw value.error || new Error("Local sales QA server exited during browser tests"); }),
  ]));
  if (result.error || result.code !== 0) throw result.error || new Error(`Sales browser tests failed (${result.code ?? result.signal})`);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  for (const [handle, cooperative] of [[browser, false], [server, true]]) {
    try { await stopOwned(handle, cooperative); }
    catch (error) { console.error(error); process.exitCode = 1; }
  }
  process.off("SIGINT", onSigint);
  process.off("SIGTERM", onSigterm);
}
