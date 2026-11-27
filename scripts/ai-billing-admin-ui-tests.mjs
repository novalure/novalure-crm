import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";
import { chromium, expect } from "@playwright/test";

const output = path.resolve(".npm-cache/qa/ai-billing-admin-ui");
await mkdir(output, { recursive: true });
const compiled = await build({ stdin: { contents: 'import React from "react";import{createRoot}from"react-dom/client";import{AiBillingAdminPanel}from"./src/components/ai-billing-admin-panel";createRoot(document.getElementById("root")).render(<AiBillingAdminPanel workspaceId="11111111-1111-4111-8111-111111111111" language="de"/>);', loader: "tsx", resolveDir: process.cwd() }, bundle: true, write: false, format: "iife", platform: "browser", jsx: "automatic", define: { "process.env.NODE_ENV": '"test"' }, logLevel: "silent" });
const css = (await postcss([tailwind({ base: process.cwd() })]).process('@import "tailwindcss";body{margin:0;font-family:Arial,sans-serif;background:#faf9f6;color:#0f172a}main{max-width:1440px;margin:auto;padding:24px}*{box-sizing:border-box}@media(max-width:600px){main{padding:12px}}', { from: path.resolve("src/app/ai-admin-harness.css") })).css;
const server = createServer((request, response) => {
  if (request.url === "/bundle.js") { response.writeHead(200, { "content-type": "application/javascript" }); response.end(compiled.outputFiles[0].text); return; }
  if (request.url === "/style.css") { response.writeHead(200, { "content-type": "text/css" }); response.end(css); return; }
  response.writeHead(200, { "content-type": "text/html" }); response.end('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"></head><body><main id="root"></main><script src="/bundle.js"></script></body></html>');
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const browser = await chromium.launch({ channel: process.env.CRM_QA_BROWSER_CHANNEL || "chrome", headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage(), calls = [], errors = [], results = [];
let rows, failAfterApply = false, denied = false;
const applied = new Set();
page.on("pageerror", error => errors.push(error.message));
function reset() {
  applied.clear(); calls.length = 0; failAfterApply = false; denied = false;
  rows = [
    { id: "22222222-2222-4222-8222-222222222222", workspaceName: "SYNTHETIC Agency A", kind: "plan", itemId: "ai_plus", amountCents: 9900 },
    { id: "33333333-3333-4333-8333-333333333333", workspaceName: "SYNTHETIC Agency B", kind: "topup", itemId: "credits_5000", amountCents: 2900 },
    { id: "44444444-4444-4444-8444-444444444444", workspaceName: "SYNTHETIC Agency C", kind: "website", itemId: "real_estate_website", amountCents: null },
  ].map(row => ({ ...row, status: "pending", workspaceId: row.id, requestId: row.id, catalogVersion: "2026-11-04-draft-v1", requesterName: "Synthetic requester", requesterEmail: "synthetic@example.invalid", createdAt: "2026-11-04T12:00:00Z", fulfilledAt: null, notes: null, requestedServices: [] }));
}
await context.route("**/api/auth/csrf?**", route => route.fulfill({ json: { csrfToken: "synthetic-admin-csrf" } }));
await context.route("**/api/admin/ai-billing?**", async route => {
  const request = route.request(), params = new URL(request.url()).searchParams;
  assert.equal(params.get("workspaceId"), "11111111-1111-4111-8111-111111111111");
  if (request.method() === "GET") return route.fulfill(denied ? { status: 403, json: { code: "AI_ADMIN_FORBIDDEN" } } : { json: { data: { source: "database", canAdmin: true, requests: rows.filter(row => row.status === params.get("status")), reservations: [] }, persisted: true } });
  const body = request.postDataJSON(), key = request.headers()["idempotency-key"];
  assert.match(key, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i);
  assert.equal(request.headers()["x-novalure-csrf-token"], "synthetic-admin-csrf"); calls.push({ body, key });
  const replayed = applied.has(key);
  if (!replayed) { applied.add(key); rows.find(row => row.id === body.requestId).status = body.action === "fulfill" ? "fulfilled" : body.status; }
  if (failAfterApply) { failAfterApply = false; return route.abort("failed"); }
  return route.fulfill({ json: { data: { status: "fulfilled", replayed }, persisted: true } });
});
async function open() { reset(); await page.goto(`http://127.0.0.1:${server.address().port}`); await expect(page.getByRole("heading", { name: "SYNTHETIC Agency A", exact: true })).toBeVisible(); }
async function step(name, run) { await run(); results.push({ name, status: "PASS" }); console.log("PASS " + name); }
const confirmation = () => page.getByRole("region", { name: "Freigabe prüfen", exact: true });
async function review(reference) { await confirmation().getByRole("textbox", { name: "Rechnungs-, Vertrags- oder Prüfbeleg", exact: true }).fill(reference); await confirmation().getByRole("checkbox").check(); }
try {
  await step("manual approval requires company review, reference and exact UTC calendar period", async () => {
    await open(); await page.getByRole("article").filter({ has: page.getByRole("heading", { name: "SYNTHETIC Agency A", exact: true }) }).getByRole("button", { name: "Buchung freigeben", exact: true }).click();
    await expect(confirmation()).toContainText("SYNTHETIC Agency A"); await expect(confirmation()).toContainText("99,00"); await expect(confirmation()).toContainText("Stripe-Zahlung erfolgt nicht");
    await expect(confirmation().getByRole("button", { name: "Freigabe bestätigen", exact: true })).toBeDisabled(); await review("SYNTHETIC-INVOICE-001");
    await confirmation().getByRole("button", { name: "Freigabe bestätigen", exact: true }).click(); await expect(page.getByText("Die Änderung wurde bestätigt und gespeichert.", { exact: true })).toBeVisible();
    assert.equal(calls.length, 1); assert.equal(calls[0].body.action, "fulfill"); assert.equal(calls[0].body.reference, "SYNTHETIC-INVOICE-001");
    const period = new Date(calls[0].body.paidThrough); assert.equal(period.getUTCDate(), 1); assert.equal(period.getUTCHours(), 0); assert.ok(period.getTime() > Date.now());
    await expect(page.getByRole("heading", { name: "SYNTHETIC Agency A", exact: true })).toHaveCount(0);
  });
  await step("lost response freezes the original approval and retries its same key and body", async () => {
    await open(); await page.getByRole("article").filter({ has: page.getByRole("heading", { name: "SYNTHETIC Agency B", exact: true }) }).getByRole("button", { name: "Buchung freigeben", exact: true }).click(); await review("SYNTHETIC-INVOICE-002"); failAfterApply = true;
    await confirmation().getByRole("button", { name: "Freigabe bestätigen", exact: true }).click(); await expect(page.getByText("Das Ergebnis ist noch ungeklärt.", { exact: false })).toBeVisible();
    await expect(confirmation().getByRole("textbox")).toBeDisabled(); await expect(confirmation().getByRole("button", { name: "Zurück", exact: true })).toBeDisabled();
    await confirmation().getByRole("button", { name: "Denselben Vorgang erneut prüfen", exact: true }).click(); await expect(page.getByText("Die Änderung wurde bestätigt und gespeichert.", { exact: true })).toBeVisible();
    assert.equal(calls.length, 2); assert.equal(calls[0].key, calls[1].key); assert.deepEqual(calls[0].body, calls[1].body); assert.equal(applied.size, 1);
  });
  await step("website completion updates only status and remains usable on mobile", async () => {
    await open(); await page.setViewportSize({ width: 390, height: 844 }); await page.getByRole("button", { name: "Als bearbeitet markieren", exact: true }).click(); await expect(confirmation()).toContainText("Diese Statusänderung vergibt keine KI-Credits."); await review("SYNTHETIC-WEBSITE-REVIEW");
    await confirmation().getByRole("button", { name: "Status bestätigen", exact: true }).click(); await expect(page.getByText("Die Änderung wurde bestätigt und gespeichert.", { exact: true })).toBeVisible();
    assert.deepEqual(Object.keys(calls[0].body).sort(), ["action", "reference", "requestId", "status"]); assert.equal(calls[0].body.action, "close"); assert.equal(calls[0].body.status, "fulfilled");
    const overflow = await page.locator("section,article,button,input,label,p,h2,h3").evaluateAll(nodes => nodes.filter(node => { const b = node.getBoundingClientRect(); return b.width > 0 && (b.left < -1 || b.right > innerWidth + 1); }).map(node => node.tagName)); assert.deepEqual(overflow, []);
    await page.screenshot({ path: path.join(output, "admin-mobile.png"), fullPage: true });
  });
  await step("a denied administration response exposes no customer list or approval control", async () => {
    await open(); denied = true; await page.getByRole("button", { name: "Aktualisieren", exact: true }).click(); await expect(page.getByText("Die interne Buchungsverwaltung ist nicht verfügbar.", { exact: false })).toBeVisible();
    await expect(page.getByRole("button", { name: "Buchung freigeben", exact: true })).toHaveCount(0); await expect(page.getByRole("heading", { name: "SYNTHETIC Agency A", exact: true })).toHaveCount(0);
  });
  assert.deepEqual(errors, []); await writeFile(path.join(output, "results.json"), JSON.stringify({ syntheticApi: true, results, browserErrors: errors }, null, 2));
} finally { await context.close(); await browser.close(); await new Promise(resolve => server.close(resolve)); }
