import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";
import { chromium, expect } from "@playwright/test";

// Component checks use a synthetic API; database and authorization integration
// are verified separately by ai-billing API and repository tests.
const output = path.resolve(".npm-cache/qa/ai-billing-ui");
await mkdir(output, { recursive: true });
const compiled = await build({ stdin: { contents: 'import React from "react";import{createRoot}from"react-dom/client";import{CrmAiBillingPanel}from"./src/components/crm-ai-billing-panel";const q=new URLSearchParams(location.search);createRoot(document.getElementById("root")).render(<CrmAiBillingPanel workspaceId={q.get("workspaceId")||"11111111-1111-4111-8111-111111111111"} language={q.get("lang")||"de"}/>);', loader: "tsx", resolveDir: process.cwd() }, bundle: true, write: false, format: "iife", platform: "browser", jsx: "automatic", define: { "process.env.NODE_ENV": '"test"' }, logLevel: "silent" });
const styles = (await postcss([tailwind({ base: process.cwd() })]).process('@import "tailwindcss";body{margin:0;font-family:Arial,sans-serif;background:#faf9f6;color:#0f172a}main{max-width:1440px;margin:auto;padding:24px}*{box-sizing:border-box}p,h2,h3,label{overflow-wrap:anywhere}@media(max-width:600px){main{padding:12px}}', { from: path.resolve("src/app/ai-billing-ui-harness.css") })).css;
const server = createServer((request, response) => {
  if (request.url === "/bundle.js") { response.writeHead(200, { "content-type": "application/javascript" }); response.end(compiled.outputFiles[0].text); return; }
  if (request.url === "/style.css") { response.writeHead(200, { "content-type": "text/css" }); response.end(styles); return; }
  response.writeHead(200, { "content-type": "text/html" }); response.end('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"></head><body><main id="root"></main><script src="/bundle.js"></script></body></html>');
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ channel: process.env.CRM_QA_BROWSER_CHANNEL || "chrome", headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
const errors = [], results = [], requests = [];
const workspaceId = "11111111-1111-4111-8111-111111111111";
let snapshot, failPosts = 0, failGet = false;
function fresh(canBook = true) { return { source: "database", workspaceId, planId: "included", paidThrough: null, cancelAtPeriodEnd: false, periodStart: "2026-11-01T00:00:00Z", periodEnd: "2026-12-01T00:00:00Z", monthlyCredits: 1000, monthlyRemaining: 700, topupRemaining: 300, availableCredits: 1000, reservedCredits: 100, usedCredits: 200, canBook, canRequestWebsite: true, bookings: [] }; }
page.on("pageerror", error => errors.push(error.message));
await context.route("**/api/auth/csrf?**", route => route.fulfill({ json: { csrfToken: "synthetic-csrf-token" } }));
await context.route("**/api/crm/ai-billing?**", async route => {
  assert.equal(new URL(route.request().url()).searchParams.get("workspaceId"), workspaceId);
  if (route.request().method() === "GET") return route.fulfill(failGet ? { status: 503, json: { code: "AI_BILLING_UNAVAILABLE" } } : { json: { data: snapshot, persisted: true } });
  const body = route.request().postDataJSON(), key = route.request().headers()["idempotency-key"];
  assert.match(key, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.equal(route.request().headers()["x-novalure-csrf-token"], "synthetic-csrf-token");
  requests.push({ body, key });
  if (failPosts-- > 0) return route.abort("failed");
  if (!snapshot.bookings.some(booking => booking.requestId === key)) snapshot.bookings.push({ id: key, requestId: key, kind: body.kind, itemId: body.itemId, status: "pending", amountCents: body.kind === "website" ? null : body.itemId === "ai_plus" ? 9900 : body.itemId === "credits_5000" ? 2900 : 19900, catalogVersion: body.catalogVersion, createdAt: "2026-11-04T12:00:00Z", fulfilledAt: null, notes: body.notes ?? null, requestedServices: body.requestedServices ?? [] });
  return route.fulfill({ status: 201, json: { data: { requestId: key }, persisted: true } });
});
async function open(language = "de", canBook = true) { snapshot = fresh(canBook); requests.length = 0; failPosts = 0; failGet = false; await page.goto(`${base}/?${new URLSearchParams({ lang: language, workspaceId })}`); await expect(page.locator("[data-ai-billing-panel] article").first()).toBeVisible(); }
async function step(name, run) { await run(); results.push({ name, status: "PASS" }); console.log("PASS " + name); }
async function noOverflow() { const clipped = await page.locator("section,article,button,input,textarea,label,h2,h3,p").evaluateAll(nodes => nodes.filter(node => { const box = node.getBoundingClientRect(); return box.width > 0 && (box.left < -1 || box.right > innerWidth + 1); }).map(node => ({ tag: node.tagName, text: node.textContent?.slice(0, 70) }))); assert.deepEqual(clipped, []); }
try {
  await step("owner sees shared balances, proposed prices and monthly versus non-expiring credits", async () => {
    await open(); await expect(page.getByText("Einige KI-Aufträge werden noch verarbeitet.", { exact: false })).toBeVisible(); await expect(page.getByText("1. Dezember 2026", { exact: true })).toBeVisible(); await expect(page.getByText("Das Monatskontingent erneuert sich zum Kalendermonat (UTC).", { exact: false })).toBeVisible(); await noOverflow(); await page.screenshot({ path: path.join(output, "owner-desktop.png"), fullPage: true });
    snapshot.planId = "ai_plus"; snapshot.cancelAtPeriodEnd = true; snapshot.paidThrough = "2027-02-01T00:00:00Z"; await page.getByRole("button", { name: "Aktualisieren", exact: true }).click(); await expect(page.getByText("Ihr KI-Zusatzpaket endet am", { exact: false })).toContainText("1. Februar 2027"); await expect(page.getByText("Danach stehen Ihrem Unternehmen wieder 1.000 Basis-Credits", { exact: false })).toBeVisible(); await expect(page.getByText("1. Dezember 2026", { exact: true })).toBeVisible(); await open();
  });
  await step("plan booking confirmation saves a pending request without activating a plan or granting credits", async () => {
    await page.locator("article").filter({ has: page.getByRole("heading", { name: "KI Plus", exact: true }) }).getByRole("button", { name: "Paket anfragen" }).click();
    const confirmation = page.getByRole("region", { name: "Anfrage prüfen" }); await expect(confirmation).toContainText(/€\s*99|99\s*€/); await expect(confirmation).toContainText(/21[.\s]000/); await expect(confirmation).toContainText("keine automatische Abbuchung"); await confirmation.getByRole("button", { name: "Anfrage senden" }).click();
    await expect(page.getByText("Ihre Anfrage wurde gespeichert", { exact: false })).toBeVisible(); await expect(page.getByText("In Prüfung", { exact: true })).toBeVisible(); assert.equal(snapshot.planId, "included"); assert.equal(snapshot.availableCredits, 1000); assert.equal(requests[0].body.kind, "plan"); assert.equal(requests[0].body.itemId, "ai_plus");
  });
  await step("credit request shows the full one-off proposed price and retries the same request UUID", async () => {
    await open("en"); await page.getByRole("button", { name: "Request credits", exact: true }).first().click(); const confirmation = page.getByRole("region", { name: "Review request" }); await expect(confirmation).toContainText("€29"); await expect(confirmation).toContainText("5,000"); failPosts = 1; await confirmation.getByRole("button", { name: "Send request" }).click(); await expect(page.getByRole("alert")).toContainText("could not be confirmed"); await confirmation.getByRole("button", { name: "Send request" }).click(); await expect(page.getByText("Your request has been saved", { exact: false })).toBeVisible(); assert.equal(requests.length, 2); assert.equal(requests[0].key, requests[1].key); assert.equal(snapshot.bookings.length, 1); assert.equal(snapshot.topupRemaining, 300);
  });
  await step("team member cannot request AI billing changes but can request a website quote with services and notes", async () => {
    await open("de", false); await expect(page.getByRole("button", { name: "Paket anfragen", exact: true })).toHaveCount(0); await expect(page.getByRole("button", { name: "Guthaben anfragen", exact: true })).toHaveCount(0); await page.getByLabel("Hosting", { exact: true }).check(); await page.getByLabel("Ihre Wünsche (optional)").fill("Neue Makler-Website mit Immobilienangeboten und laufender Betreuung."); await page.getByRole("button", { name: "Sonderpreis anfragen" }).click(); const confirmation = page.getByRole("region", { name: "Anfrage prüfen" }); await expect(confirmation).toContainText("Auf Anfrage"); await expect(confirmation).toContainText("unverbindliche Anfrage"); await expect(confirmation).toContainText("Neue Makler-Website"); await confirmation.getByRole("button", { name: "Anfrage senden" }).click(); await expect(page.getByText("Ihre Anfrage wurde gespeichert", { exact: false })).toBeVisible(); assert.equal(requests[0].body.kind, "website"); assert.deepEqual(requests[0].body.requestedServices, ["website_creation", "hosting"]); assert.equal(snapshot.availableCredits, 1000);
  });
  await step("Spanish mobile copy and quote confirmation remain within a 375px viewport", async () => {
    await page.setViewportSize({ width: 375, height: 812 }); await open("es"); await noOverflow(); await page.getByLabel("Sus necesidades (opcional)").fill("Necesitamos una web inmobiliaria multilingüe con alojamiento y mantenimiento continuado para nuestros clientes internacionales."); await page.getByRole("button", { name: "Solicitar precio especial" }).click(); await noOverflow(); await page.screenshot({ path: path.join(output, "spanish-mobile-confirmation.png"), fullPage: true }); await expect(page.getByRole("region", { name: "Revisar solicitud" })).toContainText("sin compromiso");
  });
  await step("unavailable and mismatched workspace data do not render balances and offer a working retry", async () => {
    snapshot = fresh(); failGet = true; await page.goto(`${base}/?${new URLSearchParams({ lang: "en", workspaceId })}`); await expect(page.getByText("Your plan and usage could not be loaded.", { exact: false })).toBeVisible(); await expect(page.getByText("Available credits", { exact: true })).toHaveCount(0); failGet = false; snapshot.workspaceId = "22222222-2222-4222-8222-222222222222"; await page.getByRole("button", { name: "Try again", exact: true }).click(); await expect(page.getByText("Your plan and usage could not be loaded.", { exact: false })).toBeVisible(); snapshot.workspaceId = workspaceId; await page.getByRole("button", { name: "Try again", exact: true }).click(); await expect(page.getByText("Available credits", { exact: true })).toBeVisible(); await noOverflow();
  });
  assert.deepEqual(errors, []); await writeFile(path.join(output, "results.json"), JSON.stringify({ syntheticApi: true, databaseIntegration: false, results, browserErrors: errors }, null, 2));
} finally { await context.close(); await browser.close(); await new Promise(resolve => server.close(resolve)); }
