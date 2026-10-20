import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import { chromium } from "@playwright/test";
import { installHostedOriginRouting } from "./lib/package4-hosted-browser-access.mjs";

test("per-hop protection access preserves same-origin login redirects and refuses credential-bearing external redirects", { timeout: 30_000 }, async () => {
  const seen = [], blocked = [], failures = [];
  let origin;
  const external = http.createServer((request, response) => {
    seen.push({ server: "storage", header: request.headers["x-vercel-trusted-oidc-idp-token"] });
    if (request.url === "/storage-redirect") { response.writeHead(302, { location: origin + "/finished" }); response.end(); }
    else { response.writeHead(200, { "content-type": "text/plain" }); response.end("SYNTHETIC external"); }
  });
  await new Promise(resolve => external.listen(0, "127.0.0.1", resolve));
  const storageOrigin = `http://127.0.0.1:${external.address().port}`;
  const app = http.createServer((request, response) => {
    seen.push({ server: "app", path: request.url, header: request.headers["x-vercel-trusted-oidc-idp-token"], cookie: request.headers.cookie });
    if (request.url === "/same-redirect") response.writeHead(302, { location: "/finished", "set-cookie": "synthetic_cookie=present; Path=/; HttpOnly" });
    else if (request.url === "/foreign-redirect") response.writeHead(302, { location: storageOrigin + "/should-never-be-requested" });
    else response.writeHead(200, { "content-type": "text/html" });
    response.end("SYNTHETIC finished");
  });
  await new Promise(resolve => app.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${app.address().port}`;
  const browser = await chromium.launch({ executablePath: process.env.CRM_QA_CHROMIUM_PATH || chromium.executablePath(), headless: true, args: ["--no-sandbox"] });
  try {
    const context = await browser.newContext({ serviceWorkers: "block" });
    const page = await context.newPage();
    await installHostedOriginRouting(page, { origin, protectionToken: "SYNTHETIC_ORIGIN_SCOPING_ONLY", allowedUploadOrigins: [storageOrigin], onBlocked: value => blocked.push(value), onFailure: value => failures.push(value) });
    await page.goto(origin + "/same-redirect");
    assert.equal(page.url(), origin + "/finished");
    const finished = seen.find(row => row.server === "app" && row.path === "/finished");
    assert.equal(finished.header, "SYNTHETIC_ORIGIN_SCOPING_ONLY");
    assert.match(finished.cookie, /synthetic_cookie=present/);
    const before = seen.filter(row => row.server === "storage").length;
    await page.goto(origin + "/foreign-redirect").catch(() => {});
    assert.equal(seen.filter(row => row.server === "storage").length, before);
    await page.goto(storageOrigin + "/storage-redirect").catch(() => {});
    assert.equal(seen.find(row => row.server === "storage").header, undefined);
    assert.equal(seen.filter(row => row.server === "app" && row.path === "/finished").length, 1);
    assert.equal(blocked.length, 2); assert.deepEqual(failures, []);
    await context.close();
  } finally {
    await browser.close();
    await Promise.all([new Promise(resolve => app.close(resolve)), new Promise(resolve => external.close(resolve))]);
  }
});
