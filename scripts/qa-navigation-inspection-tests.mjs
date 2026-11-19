import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { runInNewContext } from "node:vm";
import { chromium } from "@playwright/test";
import { observeQaFetchBodies, navigateQaAfterObservedFetch, parseQaFetchBindingMessage, assertObservedFetchCoverage } from "./lib/qa-response-inspection.mjs";
import { createQaWireAudit, createQaCaptureRelay } from "./lib/qa-server-response-capture.mjs";

const secret = "a".repeat(64), runId = "b".repeat(32);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(condition) {
  const deadline = Date.now() + 5000;
  while (!condition()) { assert(Date.now() < deadline, "Owned browser/IPC observation timed out"); await delay(10); }
}

async function fixture() {
  const captureModule = new URL("./lib/qa-server-response-capture.mjs", import.meta.url).href;
  const source = `import {createServer} from 'node:http';
    import {observeQaServerResponse} from ${JSON.stringify(captureModule)};
    let id=0;const s=createServer((q,r)=>{
      if(q.url.startsWith('/api/')){
        observeQaServerResponse(q,r,{origin:'http://127.0.0.1:'+s.address().port,secret:${JSON.stringify(secret)},runId:${JSON.stringify(runId)},id:++id,emit:row=>process.send({type:'crm.qa.server-capture/v1',row})});
        if(q.url==='/api/never'){r.writeHead(200,{'content-type':'application/json'});r.write('{"unfinished":');}
        else if(q.url==='/api/rejected')q.destroy();
        else setTimeout(()=>{r.writeHead(200,{'content-type':'application/json'});r.end('{"synthetic":true}');},250);
      }else{r.writeHead(200,{'content-type':'text/html'});r.end('<!doctype html><title>Owned navigation fixture</title><body>Local only</body>');}
    });s.listen(0,'127.0.0.1',()=>process.send({type:'ready',origin:'http://127.0.0.1:'+s.address().port}));
    process.on('message',m=>{if(m==='stop'){s.closeAllConnections();s.close(()=>process.disconnect());}});`;
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(path|systemroot|windir|temp|tmp|tmpdir|userprofile|localappdata|appdata)$/i.test(key)));
  const child = spawn(process.execPath, ["--input-type=module", "-e", source], { env, windowsHide: true, stdio: ["ignore", "ignore", "pipe", "ipc"] });
  const closed = new Promise(resolve => { child.once("close", resolve); child.once("error", resolve); });
  const relay = createQaCaptureRelay(); let origin, stderr = "";
  child.stderr.on("data", bytes => { stderr += bytes; });
  child.on("message", message => { if (message?.type === "ready") origin = message.origin; else relay.accept(message); });
  let browser, context, wire, native, qualified = false;
  try {
    await until(() => origin || child.exitCode !== null);
    assert(origin && new URL(origin).hostname === "127.0.0.1", "Owned loopback fixture must start");
    browser = await chromium.launch({ headless: true, ...(process.env.CRM_QA_CHROMIUM_PATH ? { executablePath: process.env.CRM_QA_CHROMIUM_PATH } : {}) });
    context = await browser.newContext();
    await context.route("**/*", route => {
      assert.equal(new URL(route.request().url()).origin, origin, "No external fixture traffic");
      return route.continue();
    });
    await context.addInitScript(observeQaFetchBodies, { origin, bindingTransport: "cdp" });
    const page = await context.newPage(), channel = await context.newCDPSession(page);
    native = []; const observations = [];
    wire = createQaWireAudit({ origin, secret }); wire.install(channel);
    await channel.send("Network.enable");
    channel.on("Runtime.bindingCalled", message => {
      if (message.name === "__crmQaFetchReport") observations.push(parseQaFetchBindingMessage(message));
    });
    await channel.send("Runtime.enable");
    await channel.send("Runtime.addBinding", { name: "__crmQaFetchReport" });
    const key = request => createHash("sha256").update(request.method() + "\0" + request.url()).digest("hex");
    page.on("request", request => {
      if (request.resourceType() === "fetch") native.push({ kind: "request", key: key(request), path: new URL(request.url()).pathname, method: request.method() });
    });
    page.on("response", response => {
      const request = response.request();
      if (request.resourceType() === "fetch") native.push({ kind: "response", key: key(request), path: new URL(request.url()).pathname,
        method: request.method(), status: response.status(), ok: response.ok(), json: (response.headers()["content-type"] ?? "").includes("application/json") });
    });
    await page.goto(origin); page.setDefaultNavigationTimeout(5000);
    return { page, wire, native, observations, relay, origin,
      qualifyClose() { wire.beginOwnerClose(native); qualified = true; },
      async close() {
        if (!qualified) wire.cleanupAfterFailure();
        await context.close(); await browser.close();
        child.send("stop"); await closed; assert.equal(stderr, ""); relay.clear();
      } };
  } catch (error) {
    wire?.cleanupAfterFailure(); await context?.close(); await browser?.close();
    if (child.connected) child.send("stop"); await closed; throw error;
  }
}

test("real renderer navigation retains GET/POST bodies, complete CDP terminals and independent Node IPC EOF", async () => {
  const f = await fixture();
  try {
    // This is the gap in the old host flow: its prior empty snapshot is valid,
    // then actual hydration/heartbeat traffic starts before host navigation.
    assert.equal((await f.page.evaluate(() => globalThis.__crmQaFetchBodies.drain(1000))).ok, true);
    await f.page.evaluate(() => {
      void fetch("/api/notifications");
      void fetch("/api/session", { method: "POST" });
    });
    await until(() => f.relay.snapshot(runId).filter(row => row.kind === "start").length === 2);
    assert.equal(f.wire.diagnostics().pendingTerminals, 2);
    await Promise.all([
      f.page.waitForNavigation({ waitUntil: "domcontentloaded" }),
      f.page.evaluate(navigateQaAfterObservedFetch, { kind: "reload", timeoutMs: 1500 }),
    ]);
    await until(() => f.wire.diagnostics().pendingTerminals === 0 && f.observations.filter(row => row.kind === "terminal").length === 2);
    const records = f.relay.snapshot(runId), terminals = records.filter(row => row.kind === "terminal");
    assert.equal(records.filter(row => row.kind === "start").length, 2, "No refetch or replacement request");
    assert.equal(terminals.length, 2);
    assert(terminals.every(row => row.complete && row.terminal === "finish" && /^[a-f0-9]{64}$/.test(row.bodySha256)));
    assert(f.observations.filter(row => row.kind === "terminal").every(row => row.bodyInspected && row.phase === "body-eof" && row.bodyError === null));
    const network = f.wire.snapshot(f.native);
    assert.equal(network.filter(row => row.kind === "request").length, 2);
    assert.equal(network.filter(row => row.kind === "response").length, 2);
    assertObservedFetchCoverage(f.native, f.observations, new Map(), network);
    f.qualifyClose();
  } finally { await f.close(); }
});

test("real never-ending successful POST body keeps navigation and qualified owner close denied", async () => {
  const f = await fixture();
  try {
    const url = f.page.url();
    await f.page.evaluate(() => { void fetch("/api/never", { method: "POST" }); });
    await until(() => f.native.some(row => row.kind === "response"));
    await assert.rejects(f.page.evaluate(navigateQaAfterObservedFetch, { kind: "reload", timeoutMs: 150 }), /QA_NAVIGATION_ORIGINAL_FETCH_UNSETTLED/);
    assert.equal(f.page.url(), url);
    assert.equal(f.relay.snapshot(runId).filter(row => row.kind === "start").length, 1);
    assert.equal(f.wire.diagnostics().pendingTerminals, 1);
    assert.throws(() => f.qualifyClose(), /QA_WIRE_PENDING/);
  } finally { await f.close(); }
});

test("real preheader POST failure cannot be turned into permission to navigate", async () => {
  const f = await fixture();
  try {
    const url = f.page.url();
    await f.page.evaluate(() => { void fetch("/api/rejected", { method: "POST" }).catch(() => {}); });
    await until(() => f.observations.some(row => row.kind === "terminal"));
    assert(f.observations.some(row => row.bodyError === "unsafe_fetch_outcome_without_headers"));
    const requestsBeforeNavigation = f.relay.snapshot(runId).filter(row => row.kind === "start").length;
    assert(requestsBeforeNavigation >= 1);
    assert.equal(f.observations.filter(row => row.kind === "start").length, 1, "One original fetch; Chromium may itself retry a reset transport");
    await assert.rejects(f.page.evaluate(navigateQaAfterObservedFetch, { kind: "assign", href: f.origin + "/other", timeoutMs: 500 }), /QA_NAVIGATION_ORIGINAL_FETCH_UNSETTLED/);
    assert.equal(f.page.url(), url);
    assert.equal(f.relay.snapshot(runId).filter(row => row.kind === "start").length, requestsBeforeNavigation, "The denied navigation performs no additional request");
  } finally { await f.close(); }
});

test("the renderer checks for microtask traffic after its drain and preserves the original finite budget", async () => {
  let calls = 0, navigations = 0, now = 0;
  const state = { async drain() { calls++; now += 5; return { ok: true, sequence: calls }; },
    snapshot() { return { pending: calls === 1 ? 1 : 0, bridgesPending: 0, sequence: calls, errors: [], foreign: false }; } };
  const world = { URL, Error, Number, Date: { now: () => now }, __crmQaFetchBodies: state,
    location: { href: "http://127.0.0.1/", origin: "http://127.0.0.1", reload() { navigations++; } } };
  const run = runInNewContext("(" + navigateQaAfterObservedFetch.toString() + ")", world);
  await run({ kind: "reload", timeoutMs: 100 }); assert.equal(calls, 2); assert.equal(navigations, 1);
  await assert.rejects(run({ kind: "assign", href: "https://example.invalid/", timeoutMs: 100 }), /TARGET_INVALID/);
  state.snapshot = () => ({ pending: 1, bridgesPending: 0, sequence: calls, errors: [], foreign: false });
  await assert.rejects(run({ kind: "reload", timeoutMs: 10 }), /ORIGINAL_FETCH_UNSETTLED/);
  assert.equal(navigations, 1, "Exhaustion never schedules navigation");
});
