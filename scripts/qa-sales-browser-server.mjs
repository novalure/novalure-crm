import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { writeFile, access } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { startLocalSalesDb, applySalesSchema } from "./lib/local-sales-db.mjs";
import { seedSalesBrowser } from "./lib/sales-browser-fixture.mjs";

let db;
let server;
let serverCompletion;
let log;
let readyForStop = false;
let stopRequested = false;
let cleanup;

async function waitForExit(completion, durationMs) {
  let timer;
  try {
    return await Promise.race([
      completion.then(() => true),
      new Promise(resolve => { timer = setTimeout(() => resolve(false), durationMs); }),
    ]);
  } finally { clearTimeout(timer); }
}

function stop(exitCode = 0) {
  if (cleanup) return cleanup;
  cleanup = (async () => {
    try {
      if (server && server.exitCode === null && server.signalCode === null) {
        server.kill("SIGTERM");
        if (!await waitForExit(serverCompletion, 15_000)) {
          server.kill("SIGKILL");
          if (!await waitForExit(serverCompletion, 5_000)) throw new Error("Owned Next QA server did not exit");
        }
      }
    } catch (error) { console.error(error); exitCode = 1; }
    finally {
      log?.end();
      try { await db?.stop(); }
      catch (error) { console.error(error); exitCode = 1; }
    }
    process.exit(exitCode);
  })();
  return cleanup;
}

function requestStop() {
  stopRequested = true;
  // During provisioning, finish the current bounded step so its cluster remains
  // reachable by cleanup; never exit while an unassigned start promise is running.
  if (readyForStop) void stop();
}
function checkStop() { if (stopRequested) throw new Error("Local sales QA startup was stopped"); }
process.on("SIGINT", requestStop);
process.on("SIGTERM", requestStop);
process.stdin.setEncoding("utf8");
let commandBuffer = "";
process.stdin.on("data", chunk => {
  commandBuffer += chunk;
  const lines = commandBuffer.split(/\r?\n/);
  commandBuffer = lines.pop() || "";
  if (lines.some(line => line.trim() === "stop")) requestStop();
});
process.stdin.on("end", requestStop);
process.stdin.resume();

try {
  for (const name of [".env.local", ".env.production.local", ".env.development.local", ".env.production", ".env.development", ".env"]) {
    try { await access(name); throw new Error("Refusing to run browser QA in a checkout with environment files"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  checkStop();
  db = await startLocalSalesDb();
  checkStop();
  await applySalesSchema(db);
  checkStop();
  const fixture = await seedSalesBrowser(db);
  checkStop();
  const port = await new Promise((resolve, reject) => {
    const listener = net.createServer();
    listener.on("error", reject);
    listener.listen(0, "127.0.0.1", () => { const value = listener.address().port; listener.close(() => resolve(value)); });
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(path|home|systemroot|windir|temp|tmp|tmpdir|userprofile|localappdata|appdata|programfiles|programfiles\(x86\)|comspec|pathext|number_of_processors|lang|lc_all)$/i.test(key)));
  Object.assign(env, { NODE_ENV: "development", NEXT_TELEMETRY_DISABLED: "1", CRM_LOCAL_TEST_DATABASE: "1", DATABASE_URL: `postgresql://${db.role}@127.0.0.1:${db.port}/postgres`, NOVALURE_APP_ORIGIN: baseUrl, NEXT_PUBLIC_APP_URL: baseUrl });
  for (const name of ["NOVALURE_SESSION_SECRET", "NOVALURE_AUTH_ENCRYPTION_KEY", "NOVALURE_AUTH_RATE_LIMIT_SECRET"]) env[name] = randomBytes(40).toString("hex");
  log = createWriteStream(".npm-cache/qa/sales-browser-server.log");
  server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "dev", "--webpack", "--hostname", "127.0.0.1", "--port", String(port)], { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  serverCompletion = new Promise(resolve => {
    server.once("exit", (code, signal) => resolve({ code, signal }));
    server.once("error", error => resolve({ error }));
  });
  server.stdout.pipe(log);
  server.stderr.pipe(log);
  await writeFile(".npm-cache/qa/sales-browser-context.json", JSON.stringify({ baseUrl, ...fixture, database: { host: "127.0.0.1", port: db.port, user: db.role, database: "postgres" }, syntheticOnly: true }, null, 2));
  let ready = false;
  for (let i = 0; i < 90; i++) {
    checkStop();
    if (server.exitCode !== null || server.signalCode !== null || !server.pid) throw new Error("Local Next server exited");
    try { const response = await fetch(baseUrl + "/login", { signal: AbortSignal.timeout(5_000) }); if (response.ok) { ready = true; break; } }
    catch { /* Startup may not yet be listening. */ }
    await new Promise(resolve => setTimeout(resolve, 1_000));
  }
  checkStop();
  if (!ready) throw new Error("Local Next server did not become ready");
  readyForStop = true;
  console.log(JSON.stringify({ ready: true, baseUrl, fixturePath: path.resolve(".npm-cache/qa/sales-browser-context.json"), syntheticOnly: true, productionAccess: 0 }));
  const result = await serverCompletion;
  if (result.error || result.code !== 0) throw result.error || new Error(`Local Next server exited (${result.code ?? result.signal})`);
  await stop();
} catch (error) {
  if (!stopRequested) console.error(error);
  await stop(stopRequested ? 0 : 1);
}
