import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { chromium } from "@playwright/test";
import { installHostedOriginRouting } from "./lib/package4-hosted-browser-access.mjs";

test("per-hop protection access preserves same-origin login redirects and refuses credential-bearing external redirects", { timeout: 30_000 }, async () => {
  const seen = [], blocked = [], failures = [];
  let origin;
  const external = http.createServer((request, response) => {
    seen.push({ server: "storage", header: request.headers["x-vercel-trusted-oidc-idp-token"], skipToolbar: request.headers["x-vercel-skip-toolbar"] });
    if (request.url === "/storage-redirect") { response.writeHead(302, { location: origin + "/finished" }); response.end(); }
    else { response.writeHead(200, { "content-type": "text/plain" }); response.end("SYNTHETIC external"); }
  });
  await new Promise(resolve => external.listen(0, "127.0.0.1", resolve));
  const storageOrigin = `http://127.0.0.1:${external.address().port}`;
  const app = http.createServer((request, response) => {
    seen.push({ server: "app", path: request.url, header: request.headers["x-vercel-trusted-oidc-idp-token"], cookie: request.headers.cookie, skipToolbar: request.headers["x-vercel-skip-toolbar"] });
    if (request.url === "/same-redirect") response.writeHead(302, { location: "/finished", "set-cookie": "synthetic_cookie=present; Path=/; HttpOnly" });
    else if (request.url === "/foreign-redirect") response.writeHead(302, { location: storageOrigin + "/should-never-be-requested" });
    else response.writeHead(200, { "content-type": "text/html" });
    response.end("SYNTHETIC finished");
  });
  await new Promise(resolve => app.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${app.address().port}`;
  const browser = await chromium.launch({ executablePath: process.env.CRM_QA_CHROMIUM_PATH || chromium.executablePath(), headless: true, args: ["--no-sandbox"] });
  try {
    const context = await browser.newContext({ serviceWorkers: "block", extraHTTPHeaders: { "x-vercel-trusted-oidc-idp-token": "SYNTHETIC_INHERITED_MUST_BE_REMOVED", "x-vercel-skip-toolbar": "SYNTHETIC_INHERITED_MUST_BE_REMOVED" } });
    const page = await context.newPage();
    await installHostedOriginRouting(page, { origin, protectionToken: "SYNTHETIC_ORIGIN_SCOPING_ONLY", allowedUploadOrigins: [storageOrigin], onBlocked: value => blocked.push(value), onFailure: value => failures.push(value) });
    await page.goto(origin + "/same-redirect");
    assert.equal(page.url(), origin + "/finished");
    const finished = seen.find(row => row.server === "app" && row.path === "/finished");
    assert.equal(finished.header, "SYNTHETIC_ORIGIN_SCOPING_ONLY");
    assert.equal(finished.skipToolbar, "1");
    assert(seen.filter(row => row.server === "app").every(row => row.skipToolbar === "1"));
    assert.match(finished.cookie, /synthetic_cookie=present/);
    const before = seen.filter(row => row.server === "storage").length;
    await page.goto(origin + "/foreign-redirect").catch(() => {});
    assert.equal(seen.filter(row => row.server === "storage").length, before);
    await page.goto(storageOrigin + "/storage-redirect").catch(() => {});
    assert.equal(seen.find(row => row.server === "storage").header, undefined);
    assert.equal(seen.find(row => row.server === "storage").skipToolbar, undefined);
    assert.equal(seen.filter(row => row.server === "app" && row.path === "/finished").length, 1);
    assert.equal(blocked.length, 2); assert.deepEqual(failures, []);
    await context.close();
  } finally {
    await browser.close();
    await Promise.all([new Promise(resolve => app.close(resolve)), new Promise(resolve => external.close(resolve))]);
  }
});

test("real CORS upload requires this page's prepare grant, exact provider API and source store without app headers", { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "package4-provider-cors-"));
  const key = path.join(directory, "synthetic.key"), cert = path.join(directory, "synthetic.crt");
  // Ephemeral local TLS fixture only; the hosted runner keeps normal TLS checks.
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-keyout", key, "-out", cert, "-subj", "/CN=vercel.com", "-addext", "subjectAltName=DNS:vercel.com"], { stdio: "ignore" });
  const workspace = "11111111-1111-4111-8111-111111111111", actor = "22222222-2222-4222-8222-222222222222";
  const staging = suffix => `${workspace}/knowledge-staging-${actor}/${Date.now() + 290_000}-${suffix}.pdf`;
  const authorized = staging("33333333-3333-4333-8333-333333333333"), unregistered = staging("44444444-4444-4444-8444-444444444444");
  const blocked = [], failures = [], providerEvents = [], received = [], sockets = new Set();
  let origin;
  const provider = https.createServer({ key: await readFile(key), cert: await readFile(cert) }, (request, response) => {
    received.push({ method: request.method, appToken: request.headers["x-vercel-trusted-oidc-idp-token"], toolbar: request.headers["x-vercel-skip-toolbar"], store: request.headers["x-vercel-blob-store-id"] });
    response.setHeader("access-control-allow-origin", origin);
    response.setHeader("access-control-allow-methods", "PUT");
    response.setHeader("access-control-allow-headers", "authorization,content-type,x-vercel-blob-store-id,x-vercel-trusted-oidc-idp-token,x-vercel-skip-toolbar");
    if (request.method === "OPTIONS") { response.writeHead(204); response.end(); return; }
    let body = ""; request.on("data", chunk => { body += chunk; });
    request.on("end", () => {
      if (body === "SYNTHETIC redirect") response.writeHead(302, { location: origin + "/unexpected-redirect-target" });
      else response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ bytes: body.length }));
    });
  });
  await new Promise(resolve => provider.listen(0, "127.0.0.1", resolve));
  const proxy = http.createServer();
  proxy.on("connect", (request, socket, head) => {
    sockets.add(socket); socket.on("close", () => sockets.delete(socket));
    if (request.url !== "vercel.com:443") { socket.destroy(); return; }
    const upstream = net.connect(provider.address().port, "127.0.0.1", () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      socket.pipe(upstream); upstream.pipe(socket);
    });
    sockets.add(upstream); upstream.on("close", () => sockets.delete(upstream));
    socket.on("error", () => upstream.destroy()); upstream.on("error", () => socket.destroy());
  });
  await new Promise(resolve => proxy.listen(0, "127.0.0.1", resolve));
  let unexpectedRedirects = 0;
  const app = http.createServer((request, response) => {
    if (request.url === "/api/knowledge-center/documents") { response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ transport: "private-blob", pathname: authorized })); return; }
    if (request.url === "/unexpected-redirect-target") unexpectedRedirects++;
    response.setHeader("content-type", "text/html"); response.end("SYNTHETIC local app");
  });
  await new Promise(resolve => app.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${app.address().port}`;
  const browser = await chromium.launch({ executablePath: process.env.CRM_QA_CHROMIUM_PATH || chromium.executablePath(), headless: true, args: ["--no-sandbox"], proxy: { server: `http://127.0.0.1:${proxy.address().port}`, bypass: "127.0.0.1" } });
  try {
    const context = await browser.newContext({ serviceWorkers: "block", ignoreHTTPSErrors: true,
      extraHTTPHeaders: { "x-vercel-trusted-oidc-idp-token": "SYNTHETIC_INHERITED_APP_TOKEN", "x-vercel-skip-toolbar": "SYNTHETIC_INHERITED_TOOLBAR" } });
    const page = await context.newPage();
    // Delay Node's response-body read while the browser immediately preflights.
    // The grant guard must wait, without opening an unregistered-path window.
    page.on("response", response => {
      if (new URL(response.url()).pathname !== "/api/knowledge-center/documents") return;
      const json = response.json.bind(response);
      response.json = async () => { await new Promise(resolve => setTimeout(resolve, 50)); return json(); };
    });
    await installHostedOriginRouting(page, { origin, protectionToken: "SYNTHETIC_APP_TOKEN", allowedUploadOrigins: [],
      uploadApi: { origin: "https://vercel.com", pathname: "/api/blob/", storeId: "store_SYNTHETIC", workspaceIds: [workspace], actorIds: [actor] },
      onBlocked: row => blocked.push(row), onFailure: row => failures.push(row), onAuthorizedProviderRequest: row => providerEvents.push(row) });
    await page.goto(origin);
    const send = (pathname, options = {}) => page.evaluate(async ({ pathname, options }) => {
      try {
        const response = await fetch(`https://vercel.com${options.apiPath || "/api/blob/"}?${options.query || new URLSearchParams({ pathname })}`, {
          method: options.method || "PUT", headers: { authorization: "Bearer vercel_blob_client_SYNTHETIC_scoped", "x-vercel-blob-store-id": options.store || "SYNTHETIC", "content-type": "application/pdf" }, body: options.method === "GET" ? undefined : options.body || "SYNTHETIC private bytes", signal: AbortSignal.timeout(7_000) });
        return response.status;
      } catch { return "BLOCKED"; }
    }, { pathname, options });
    await page.evaluate(async () => { await (await fetch("/api/knowledge-center/documents", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "prepare" }) })).json(); });
    assert.equal(await send(authorized), 200);
    assert(received.some(row => row.method === "OPTIONS")); assert(received.some(row => row.method === "PUT" && row.store === "SYNTHETIC"));
    assert(received.every(row => row.appToken === undefined && row.toolbar === undefined));
    const accepted = received.length;
    for (const options of [{ method: "GET" }, { apiPath: "/api/blob/other" }, { query: new URLSearchParams({ pathname: authorized, extra: "denied" }).toString() },
      { query: new URLSearchParams([["pathname", authorized], ["pathname", authorized]]).toString() }, { store: "FOREIGN" }]) assert.equal(await send(authorized, options), "BLOCKED");
    assert.equal(await send(unregistered), "BLOCKED");
    assert.equal(received.length, accepted);
    assert.equal(await send(authorized, { body: "SYNTHETIC redirect" }), "BLOCKED");
    assert.equal(unexpectedRedirects, 0);
    assert(providerEvents.every(row => row.pageLocalPrepareGrant === true && row.endpoint === "/api/blob/" && row.sourceStoreId === "store_SYNTHETIC"));
    assert(blocked.some(row => row.reason === "page-local upload grant unavailable"));
    assert(blocked.some(row => row.reason === "cross-origin redirect"));
    assert.deepEqual(failures, []);
    await context.close();
  } finally {
    await browser.close(); for (const socket of sockets) socket.destroy();
    await Promise.all([app, provider, proxy].map(server => new Promise(resolve => server.close(resolve))));
    await rm(directory, { recursive: true, force: true });
  }
});
