// Run the complete package-4 browser acceptance against one fresh, disposable
// loopback fixture. The application must already be built and Chromium installed.
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const artifactPath = path.join(projectRoot, ".npm-cache/qa/package4-e2e-result.json");
const startTimeoutMs = 120_000;
const stopTimeoutMs = 60_000;
const suiteTimeoutMs = 20 * 60_000;
const controller = new AbortController();
const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  /^(path|home|systemroot|windir|temp|tmp|tmpdir|userprofile|localappdata|appdata|programfiles|programfiles\(x86\)|comspec|pathext|number_of_processors|lang|lc_all)$/i.test(key)));
// Database, provider, authentication and deployment variables are never inherited.
environment.NEXT_TELEMETRY_DISABLED = "1";

const suites = [
  { id: "design-c-integration", script: "scripts/qa-design-c-integration.mjs", nodeArgs: [] },
  { id: "knowledge-browser", script: "scripts/qa-knowledge-browser.mjs", nodeArgs: [] },
  { id: "package4-integration", script: "scripts/qa-package4-integration.mjs", nodeArgs: ["--conditions=react-server", "--import", "tsx"] },
].map(suite => ({ ...suite, invoked: false, status: "NOT_RUN" }));
const audit = {
  version: 1,
  status: "FAIL",
  syntheticOnly: true,
  productionAccess: 0,
  startedAt: new Date().toISOString(),
  fixture: { fresh: false, built: true, mode: "design-c-actual-predecessors" },
  suites,
  errors: [],
};

function launch(args, stdio) {
  const child = spawn(process.execPath, args, {
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
            url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.username || url.password ||
            path.resolve(message.fixturePath || "") !== path.join(projectRoot, ".npm-cache/qa/sales-browser-context.json")) {
          throw new Error("Local package-4 QA server returned an unsafe readiness record");
        }
        resolve(message);
      } catch (error) { reject(error); }
    });
  });
  try {
    const outcome = await abortable(within(Promise.race([
      ready,
      server.completion.then(result => { throw result.error || new Error(`Local package-4 QA server exited before readiness (${result.code ?? result.signal})`); }),
    ]), startTimeoutMs));
    if (!outcome.completed) throw new Error("Local package-4 QA server did not become ready within 120 seconds");
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
    // Target only this exact spawned child; never discover or kill other processes.
    child.kill("SIGKILL");
    await within(completion, 5_000);
    throw new Error("Owned package-4 QA child required forced shutdown after 60 seconds");
  }
  if (cooperative && (result.value.error || result.value.code !== 0)) {
    throw result.value.error || new Error(`Local package-4 QA cleanup failed (${result.value.code ?? result.value.signal})`);
  }
}

function recordFailure(error) {
  const message = error instanceof Error ? error.message : String(error);
  audit.errors.push(message);
  console.error(error);
  process.exitCode = 1;
}

let server;
let browser;
const interrupt = signal => controller.abort(new Error(`Package-4 QA interrupted by ${signal}`));
const onSigint = () => interrupt("SIGINT");
const onSigterm = () => interrupt("SIGTERM");
process.on("SIGINT", onSigint);
process.on("SIGTERM", onSigterm);
try {
  await mkdir(path.dirname(artifactPath), { recursive: true });
  const { chromium } = await import("@playwright/test");
  const chromiumPath = path.resolve(projectRoot, process.env.CRM_QA_CHROMIUM_PATH || chromium.executablePath());
  try {
    await access(chromiumPath, constants.X_OK);
    if (!(await stat(chromiumPath)).isFile()) throw new Error("Chromium path is not a regular file");
  } catch (error) {
    throw new Error(`Installed Chromium executable required at ${chromiumPath}; install it separately or set CRM_QA_CHROMIUM_PATH`, { cause: error });
  }
  environment.CRM_QA_CHROMIUM_PATH = chromiumPath;
  // Fail before creating a database if optimized application assets are missing.
  await access(path.join(projectRoot, ".next/BUILD_ID"), constants.R_OK);
  server = launch(["scripts/qa-sales-browser-server.mjs", "--built", "--design-c"], ["pipe", "pipe", "inherit"]);
  // A closed startup pipe must not turn cleanup into an unhandled EPIPE.
  server.child.stdin.on("error", () => {});
  const ready = await awaitReady(server);
  Object.assign(audit.fixture, { fresh: true, baseUrl: ready.baseUrl, readyAt: new Date().toISOString() });
  console.log(`Local package-4 QA ready at ${ready.baseUrl}; synthetic data only.`);

  for (const suite of suites) {
    suite.invoked = true;
    suite.status = "RUNNING";
    suite.startedAt = new Date().toISOString();
    try {
      browser = launch([...suite.nodeArgs, suite.script], ["ignore", "inherit", "inherit"]);
      const outcome = await abortable(within(Promise.race([
        browser.completion,
        server.completion.then(result => { throw result.error || new Error("Local package-4 QA server exited during browser tests"); }),
      ]), suiteTimeoutMs));
      if (!outcome.completed) throw new Error(`${suite.id} exceeded its 20-minute execution limit`);
      const result = outcome.value;
      suite.exitCode = result.code ?? null;
      suite.signal = result.signal ?? null;
      if (result.error || result.code !== 0) throw result.error || new Error(`${suite.id} failed (${result.code ?? result.signal})`);
      suite.status = "PASS";
    } catch (error) {
      suite.status = "FAIL";
      suite.error = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      suite.finishedAt = new Date().toISOString();
    }
    await stopOwned(browser);
    browser = undefined;
  }
} catch (error) {
  recordFailure(error);
} finally {
  for (const [handle, cooperative] of [[browser, false], [server, true]]) {
    try { await stopOwned(handle, cooperative); }
    catch (error) { recordFailure(error); }
  }
  process.off("SIGINT", onSigint);
  process.off("SIGTERM", onSigterm);
  if (controller.signal.aborted && !audit.errors.includes(controller.signal.reason.message)) {
    recordFailure(controller.signal.reason);
  }
  audit.finishedAt = new Date().toISOString();
  audit.status = audit.errors.length === 0 && suites.every(suite => suite.status === "PASS") ? "PASS" : "FAIL";
  try {
    await mkdir(path.dirname(artifactPath), { recursive: true });
    await writeFile(artifactPath, JSON.stringify(audit, null, 2) + "\n");
    console.log(`Package-4 QA ${audit.status}; audit: ${artifactPath}`);
  } catch (error) { recordFailure(error); }
}
