import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";
import { chromium, expect } from "@playwright/test";

// Synthetic HTTP tests exercise the real component; real tenant authorization,
// model calls and database persistence are covered by the server-side suite.
const output = path.resolve(".npm-cache/qa/crm-ai-assistant");
await mkdir(output, { recursive: true });
const compiled = await build({ stdin: { contents: 'import React from "react";import{createRoot}from"react-dom/client";import{CrmAiAssistant}from"./src/components/crm-ai-assistant";const q=new URLSearchParams(location.search);const root=createRoot(document.getElementById("root"));let props={workspaceId:q.get("workspaceId"),projectId:q.get("projectId"),language:q.get("lang")||"de"};window.setAssistantProps=next=>{props={...props,...next};root.render(<CrmAiAssistant {...props}/>)};window.setAssistantProps({});', loader: "tsx", resolveDir: process.cwd() }, bundle: true, write: false, format: "iife", platform: "browser", jsx: "automatic", define: { "process.env.NODE_ENV": '"test"' }, logLevel: "silent" });
const styles = (await postcss([tailwind({ base: process.cwd() })]).process('@import "tailwindcss";body{margin:0;font-family:Arial,sans-serif;background:#faf9f6;color:#0f172a}main{max-width:1440px;margin:auto;padding:24px}*{box-sizing:border-box}p,h2,h3,label{overflow-wrap:anywhere}@media(max-width:600px){main{padding:12px}}', { from: path.resolve("src/app/crm-ai-assistant-test-harness.css") })).css;
const server = createServer((request, response) => {
  if (request.url === "/bundle.js") { response.writeHead(200, { "content-type": "application/javascript" }); response.end(compiled.outputFiles[0].text); return; }
  if (request.url === "/style.css") { response.writeHead(200, { "content-type": "text/css" }); response.end(styles); return; }
  response.writeHead(200, { "content-type": "text/html" }); response.end('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"></head><body><main id="root"></main><script src="/bundle.js"></script></body></html>');
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ channel: process.env.CRM_QA_BROWSER_CHANNEL || "chrome", headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
await context.addInitScript(() => Object.defineProperty(navigator, "clipboard", { value: { writeText: async value => { window.copiedAssistantText = value; } }, configurable: true }));
const page = await context.newPage();
const workspaceId = "11111111-1111-4111-8111-111111111111", otherWorkspaceId = "22222222-2222-4222-8222-222222222222", projectId = "33333333-3333-4333-8333-333333333333";
const errors = [], results = [], requests = [];
let snapshots = new Map(), postBehaviours = [], failGet = false, mismatchGet = false, postGate = null;
function fresh(id = workspaceId, scopedProjectId = null) { return { source: "database", workspaceId: id, capturedAt: "2026-11-04T12:00:00Z", scope: { projectId: scopedProjectId, label: id === workspaceId ? "Grasl Immobilien" : "Other company" }, options: { leads: [{ id: "lead-1", label: "Anna Beispiel" }], properties: [{ id: "property-1", label: "Gartenwohnung Wien" }] }, metrics: { openLeads: 12, overdueTasks: 3, todayMeetings: 2, pipelineValueCents: 154000000 }, credits: { availableCredits: 900, monthlyCredits: 1000, usedCredits: 80, reservedCredits: 20 }, recentRuns: [] }; }
function answer(body, key) { return { id: key, mode: body.mode, createdAt: "2026-11-04T12:01:00Z", capturedAt: "2026-11-04T12:00:00Z", status: "completed", answer: 'Ihre Priorität: Anna kontaktieren.\n<img src=x onerror="window.unsafeAssistant=true">', email: body.mode === "email_draft" ? { subject: "Besichtigung Gartenwohnung", body: "Guten Tag Anna,\n\nhaben Sie Interesse an einer Besichtigung?", recipient: "anna@example.test" } : null, sources: [{ type: "lead", id: "lead-1", label: "Anna Beispiel" }], chargedCredits: 17 }; }
page.on("pageerror", error => errors.push(error.message));
await context.route("**/api/auth/csrf?**", route => route.fulfill({ json: { csrfToken: "synthetic-csrf-token" } }));
await context.route("**/api/crm/ai-assistant?**", async route => {
  const url = new URL(route.request().url()), id = url.searchParams.get("workspaceId"), scope = url.searchParams.get("projectId");
  if (route.request().method() === "GET") return route.fulfill(failGet ? { status: 503, json: { code: "AI_ASSISTANT_UNAVAILABLE" } } : { json: { persisted: true, data: mismatchGet ? fresh(otherWorkspaceId, scope) : snapshots.get(`${id}:${scope ?? ""}`) ?? fresh(id, scope) } });
  const body = route.request().postDataJSON(), key = route.request().headers()["idempotency-key"];
  assert.match(key, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.equal(route.request().headers()["x-novalure-csrf-token"], "synthetic-csrf-token");
  assert.equal(body.workspaceId, undefined); assert.equal(body.price, undefined);
  requests.push({ body, key, workspaceId: id, projectId: scope });
  assert.equal(body.timeZone, url.searchParams.get("timeZone"));
  assert.ok(["de", "en", "es"].includes(body.language));
  const behaviour = postBehaviours.shift();
  if (postGate) await postGate;
  if (behaviour === "network") return route.abort("failed");
  if (behaviour === "pending") return route.fulfill({ status: 202, json: { code: "AI_RESULT_PENDING" } });
  if (behaviour === "terminal") return route.fulfill({ status: 502, json: { code: "AI_PROVIDER_REJECTED", terminal: true } });
  const result = answer(body, key), snapshot = snapshots.get(`${id}:${scope ?? ""}`) ?? fresh(id, scope);
  snapshot.pendingRun = null;
  if (!snapshot.recentRuns.some(run => run.id === key)) { snapshot.recentRuns.unshift(result); snapshot.credits.availableCredits -= result.chargedCredits; }
  snapshots.set(`${id}:${scope ?? ""}`, snapshot);
  return route.fulfill({ status: 201, json: { persisted: true, data: result } });
});
async function open(language = "de", scope = null) { snapshots = new Map(); requests.length = 0; postBehaviours = []; failGet = false; mismatchGet = false; postGate = null; await page.goto(`${base}/?${new URLSearchParams({ lang: language, workspaceId, ...(scope ? { projectId: scope } : {}) })}`); await expect(page.getByRole("heading", { name: language === "de" ? "Wobei kann ich helfen?" : language === "es" ? "¿En qué puedo ayudarle?" : "How can I help?" })).toBeVisible(); }
async function step(name, run) { await run(); results.push({ name, status: "PASS" }); console.log("PASS " + name); }
async function noOverflow() { const clipped = await page.locator("section,article,button,input,textarea,label,h2,h3,p").evaluateAll(nodes => nodes.filter(node => { const box = node.getBoundingClientRect(); return box.width > 0 && (box.left < -1 || box.right > innerWidth + 1); }).map(node => ({ tag: node.tagName, text: node.textContent?.slice(0, 60) }))); assert.deepEqual(clipped, []); }
try {
  await step("six actions, real response, safe text, source provenance and refreshed company quota", async () => {
    await open(); await expect(page.getByRole("button", { pressed: true })).toContainText("Mein Tagesüberblick"); await page.getByRole("button", { name: "Antwort erstellen", exact: true }).click();
    await expect(page.locator("[data-assistant-answer]")).toContainText("Ihre Priorität: Anna kontaktieren."); await expect(page.locator("[data-assistant-answer] img")).toHaveCount(0); assert.equal(await page.evaluate(() => window.unsafeAssistant), undefined);
    await expect(page.getByRole("heading", { name: "Verwendete Quellen", exact: true })).toBeVisible(); await expect(page.locator("[data-assistant-result]")).toContainText("17 Credits"); await expect(page.getByText("883", { exact: true })).toBeVisible(); await expect(page.getByRole("button", { name: "Antwort öffnen", exact: true })).toHaveCount(1); await noOverflow(); await page.screenshot({ path: path.join(output, "assistant-desktop.png"), fullPage: true });
  });
  await step("lead, property and question validation send the selected project scope", async () => {
    await open("de", projectId); await page.getByRole("button", { name: "Lead zusammenfassen", exact: false }).click(); await expect(page.getByRole("button", { name: "Antwort erstellen", exact: true })).toBeDisabled(); await page.getByLabel("Lead", { exact: true }).selectOption("lead-1"); await page.getByRole("button", { name: "Antwort erstellen", exact: true }).click(); await expect(page.locator("[data-assistant-result]")).toBeVisible(); assert.equal(requests.at(-1).body.leadId, "lead-1"); assert.equal(requests.at(-1).body.projectId, projectId); assert.equal(requests.at(-1).projectId, projectId);
    await page.getByRole("button", { name: "Objekttext schreiben", exact: false }).click(); await expect(page.getByRole("button", { name: "Antwort erstellen", exact: true })).toBeDisabled(); await page.getByLabel("Objekt", { exact: true }).selectOption("property-1"); await page.getByRole("button", { name: "Antwort erstellen", exact: true }).click(); await expect(page.getByRole("button", { name: "Antwort erstellen", exact: true })).toBeEnabled(); assert.equal(requests.at(-1).body.propertyId, "property-1");
    await page.getByRole("button", { name: "Frage zu meinen CRM-Daten", exact: false }).click(); await expect(page.getByRole("button", { name: "Antwort erstellen", exact: true })).toBeDisabled(); await page.getByLabel("Ihre Frage", { exact: true }).fill("Welche Leads sollte ich heute kontaktieren?"); await page.getByRole("button", { name: "Antwort erstellen", exact: true }).click(); await expect(page.getByRole("button", { name: "Antwort erstellen", exact: true })).toBeEnabled(); assert.equal(requests.at(-1).body.mode, "crm_question");
  });
  await step("email draft is editable and copies or downloads the edited subject and body without a send action", async () => {
    await open("en"); await page.getByRole("button", { name: "Draft an email", exact: false }).click(); await page.getByLabel("Email or source text (optional)", { exact: false }).fill("Please arrange a viewing next week."); await page.getByLabel("Tone", { exact: true }).selectOption("friendly"); await page.getByRole("button", { name: "Create answer", exact: true }).click(); await expect(page.getByRole("article", { name: "Your email draft", exact: true })).toBeVisible();
    assert.equal(requests[0].body.sourceText, "Please arrange a viewing next week."); assert.equal(requests[0].body.tone, "friendly"); assert.equal(requests[0].body.leadId, undefined); await page.getByLabel("Subject", { exact: true }).fill("Updated viewing request"); await page.getByLabel("Message", { exact: true }).fill("Hello Anna,\nWould Tuesday suit you?"); await page.getByRole("button", { name: "Copy text", exact: true }).click(); assert.equal(await page.evaluate(() => window.copiedAssistantText), "Subject: Updated viewing request\n\nHello Anna,\nWould Tuesday suit you?");
    const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Download as text", exact: true }).click()]); assert.match(download.suggestedFilename(), /^crm-email_draft-.*\.txt$/); await expect(page.getByRole("button", { name: /send/i })).toHaveCount(0);
  });
  await step("uncertain and processing results reuse the exact request and terminal failures permit a new intent", async () => {
    await open("en"); postBehaviours = ["network", "pending"]; await page.getByRole("button", { name: "Create answer", exact: true }).click(); await expect(page.getByRole("status")).toContainText("could not yet be confirmed"); await expect(page.getByRole("button", { name: "Create answer", exact: true })).toBeDisabled(); await page.getByRole("button", { name: "Check result again", exact: true }).click(); await expect(page.getByRole("status")).toContainText("still processing"); await page.getByRole("button", { name: "Check result again", exact: true }).click(); await expect(page.locator("[data-assistant-result]")).toBeVisible(); assert.equal(requests.length, 3); assert.equal(new Set(requests.map(request => request.key)).size, 1); assert.deepEqual(requests[0].body, requests[2].body);
    postBehaviours = ["terminal"]; await page.getByRole("button", { name: "Create answer", exact: true }).click(); await expect(page.getByRole("alert")).toContainText("could not be completed"); await expect(page.getByRole("button", { name: "Create answer", exact: true })).toBeEnabled(); assert.notEqual(requests.at(-1).key, requests[0].key);
  });
  await step("an answer completing after a workspace switch never appears in the other company", async () => {
    await open("en"); let release; postGate = new Promise(resolve => { release = resolve; }); await page.getByRole("button", { name: "Create answer", exact: true }).click(); await expect.poll(() => requests.length).toBe(1); await page.evaluate(id => window.setAssistantProps({ workspaceId: id }), otherWorkspaceId); await expect(page.getByRole("heading", { name: "Other company", exact: true })).toBeVisible(); release(); postGate = null; await expect(page.getByRole("button", { name: "Create answer", exact: true })).toBeEnabled(); await expect(page.locator("[data-assistant-result]")).toHaveCount(0);
    await page.evaluate(id => window.setAssistantProps({ workspaceId: id }), workspaceId); await expect(page.getByRole("heading", { name: "Grasl Immobilien", exact: true })).toBeVisible(); await expect(page.locator("[data-assistant-result]")).toBeVisible(); assert.equal(requests.length, 1);
  });
  await step("Spanish mobile, exhausted credits and unavailable or mismatched snapshots remain usable", async () => {
    await page.setViewportSize({ width: 375, height: 812 }); await open("es"); await noOverflow(); await page.screenshot({ path: path.join(output, "assistant-spanish-mobile.png"), fullPage: true }); const snapshot = fresh(); snapshot.credits.availableCredits = 0; snapshots.set(`${workspaceId}:`, snapshot); await page.getByRole("button", { name: "Actualizar", exact: true }).click(); await expect(page.getByRole("button", { name: "Crear respuesta", exact: true })).toBeDisabled(); await expect(page.getByRole("link", { name: "Créditos y plan", exact: true }).first()).toHaveAttribute("href", "#billing");
    failGet = true; await page.getByRole("button", { name: "Actualizar", exact: true }).click(); await expect(page.getByRole("status")).toContainText("no está disponible"); await expect(page.getByText("Créditos disponibles", { exact: true })).toHaveCount(0); failGet = false; mismatchGet = true; await page.getByRole("button", { name: "Reintentar", exact: true }).click(); await expect(page.getByRole("status")).toContainText("no está disponible"); mismatchGet = false; await page.getByRole("button", { name: "Reintentar", exact: true }).click(); await expect(page.getByText("Créditos disponibles", { exact: true })).toBeVisible(); await noOverflow();
  });
  await step("server permission limits hide unavailable modes and explain bounded detail context", async () => {
    await page.setViewportSize({ width: 1440, height: 1000 }); await open("en"); const snapshot = fresh(); snapshot.allowedModes = ["daily_briefing", "email_draft", "crm_question"]; snapshot.contextLimited = true; snapshots.set(`${workspaceId}:`, snapshot); await page.getByRole("button", { name: "Refresh", exact: true }).click(); await expect(page.getByRole("button", { name: "Analyse pipeline", exact: false })).toHaveCount(0); await expect(page.getByText("Pipeline value", { exact: true })).toHaveCount(0); await expect(page.getByText("Open leads", { exact: true })).toBeVisible(); await expect(page.getByText("The figures cover all records accessible to you.", { exact: false })).toBeVisible(); await expect(page.getByRole("button", { name: "Draft an email", exact: false })).toBeVisible();
  });
  await step("a remounted assistant resumes the persisted request unchanged and supports Spanish output in an English CRM", async () => {
    await open("en"); await page.getByLabel("Answer language", { exact: true }).selectOption("es"); await page.getByRole("button", { name: "Create answer", exact: true }).click(); await expect(page.locator("[data-assistant-result]")).toBeVisible(); assert.equal(requests.at(-1).body.language, "es");
    const id = "44444444-4444-4444-8444-444444444444", request = { mode: "email_draft", prompt: "Prepare my reply", language: "es", sourceText: "Original incoming message", tone: "friendly", timeZone: "Europe/Madrid" }; const snapshot = fresh(); snapshot.pendingRun = { id, request, createdAt: "2026-11-04T12:00:00Z" }; snapshots.set(`${workspaceId}:`, snapshot); await page.reload(); await expect(page.getByRole("button", { name: "Check result again", exact: true })).toBeVisible(); await expect(page.getByRole("button", { name: "Create answer", exact: true })).toBeDisabled(); await expect(page.getByLabel("Answer language", { exact: true })).toHaveValue("es"); await page.getByRole("button", { name: "Check result again", exact: true }).click(); await expect(page.getByRole("article", { name: "Your email draft", exact: true })).toBeVisible(); assert.equal(requests.at(-1).key, id); assert.deepEqual(requests.at(-1).body, request);
  });
  assert.deepEqual(errors, []); await writeFile(path.join(output, "results.json"), JSON.stringify({ syntheticApi: true, databaseIntegration: false, results, browserErrors: errors }, null, 2));
} finally { await context.close(); await browser.close(); await new Promise(resolve => server.close(resolve)); }


