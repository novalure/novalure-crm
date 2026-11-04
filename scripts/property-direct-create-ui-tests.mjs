import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";
import { chromium, expect } from "@playwright/test";
import { getPropertyDepartmentCopy } from "../src/lib/i18n.ts";

// Local real-component/browser checks with synthetic HTTP only. Tenant/database
// authorization and replay persistence are qualified by the server regression suite.
const output = path.resolve(".npm-cache/qa/property-direct-create");
await mkdir(output, { recursive: true });
const workspaceId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const propertyId = "33333333-3333-4333-8333-333333333333";
const otherWorkspaceId = "44444444-4444-4444-8444-444444444444";
const otherProjectId = "55555555-5555-4555-8555-555555555555";
const copy = getPropertyDepartmentCopy("de");
const baseline = process.env.CRM_QA_INPUT_BASELINE === "1";
const baselineRevision = "11c4384c0c5a360e448f441c822edc1057d9fe17";
const compiled = await build({ stdin: { contents: `
import React from 'react';import{createRoot}from'react-dom/client';
import{PropertyCommandCenter}from'./src/components/property-command-center';
import{usePropertyDraftSessionStore}from'./src/lib/use-property-draft';
const root=createRoot(document.getElementById('root'));
let visible=true,userId='SYNTHETIC-user-a';
let props={activeProjectId:'${projectId}',brokerMandates:[],buyerSearchProfiles:[],buildings:[],contacts:[],
context:{workspaceId:'${workspaceId}',workspaceName:'SYNTHETIC selected QA',customerType:'hybrid_real_estate',operatingModel:'managed_by_novalure',teamStructure:'small_team',activeCalendarProvider:'none'},
language:'de',leads:[],onOpenLeadInbox:()=>{},onOpenReservations:()=>{},onOpenUnits:()=>{},
onPropertyChanged:async()=>{if(window.failPropertyRefresh)throw Error('SYNTHETIC refresh failed')},projectLabel:'SYNTHETIC QA project',
projects:[{id:'${projectId}',workspaceId:'${workspaceId}',name:'SYNTHETIC QA project',type:'Immobilien',status:'Aktiv',leads:0,revenue:'—'}],
propertyCostItems:[],propertyDocuments:[],propertyMedia:[],propertyTextBlocks:[],reservations:[],sellerListings:[],sessionProductRole:'workspace_admin',sessionRole:'admin',units:[],users:[]};
function Harness(){const store=usePropertyDraftSessionStore(userId);return visible?<PropertyCommandCenter {...props} draftStore={store} draftUserId={userId}/>:<p>Section closed</p>}
const render=()=>root.render(<React.StrictMode><Harness/></React.StrictMode>);
window.setPropertyWorkspace=id=>{props={...props,context:{...props.context,workspaceId:id}};render()};
window.setPropertyScope=(workspaceId,activeProjectId)=>{props={...props,activeProjectId,context:{...props.context,workspaceId},projects:[{...props.projects[0],id:activeProjectId,workspaceId}]};render()};
window.setPropertyRecords=sellerListings=>{props={...props,sellerListings};render()};
window.setPropertyVisible=value=>{visible=value;render()};
window.setPropertyUser=value=>{userId=value;render()};
render();`, loader: "tsx", resolveDir: process.cwd() }, bundle: true,
write: false, format: "iife", platform: "browser", jsx: "automatic", banner: { js: "var process={env:{NODE_ENV:'test'},browser:true};" }, define: { "process.env.NODE_ENV": '"test"' },
plugins: baseline ? [{ name: "immutable-baseline-component", setup(builder) {
  builder.onLoad({ filter: /property-command-center\.tsx$/ }, () => ({
    contents: execFileSync("git", ["show", `${baselineRevision}:src/components/property-command-center.tsx`], { encoding: "utf8" }),
    loader: "tsx", resolveDir: path.resolve("src/components"),
  }));
} }] : [], logLevel: "silent" });
const server = createServer((request, response) => {
  if (request.url === "/bundle.js") { response.writeHead(200, { "content-type": "application/javascript" }); response.end(compiled.outputFiles[0].text); return; }
  response.writeHead(200, { "content-type": "text/html" });
  response.end('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font-family:Arial;margin:20px}input,select,button{margin:5px;padding:5px}.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)}</style></head><body><main id="root"></main><script src="/bundle.js"></script></body></html>');
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const browser = await chromium.launch({ channel: process.env.CRM_QA_BROWSER_CHANNEL || "chrome", headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
const errors = [], results = [], requests = [];
let behaviours = [], gate = null;
page.on("pageerror", error => errors.push(error.message));
await context.route("**/api/**", async route => {
  const request = route.request(), url = new URL(request.url());
  if (url.pathname === "/api/auth/csrf") return route.fulfill({ json: { csrfToken: "SYNTHETIC-csrf" } });
  if (url.searchParams.get("operation") === "capabilities") return route.fulfill({ json: { workspaceId: url.searchParams.get("workspaceId"), capabilities: { canEditProperty: true, canReviewDocuments: true, canAssignInquiry: true } } });
  if (request.method() === "GET") return route.fulfill({ json: { persisted: true, data: { drafts: [], projects: [], inquiries: [], assignments: [], candidates: [], counts: [] } } });
  assert.equal(url.pathname, "/api/crm/properties");
  const record = { workspaceId: url.searchParams.get("workspaceId"), body: request.postDataJSON(), key: request.headers()["idempotency-key"], correlation: request.headers()["x-correlation-id"] };
  requests.push(record);
  if (gate) await gate;
  const behaviour = behaviours.shift();
  if (behaviour === "network") return route.abort("failed");
  if (behaviour === "invalid") return route.fulfill({ status: 400, json: { error: "SYNTHETIC invalid amount" } });
  if (behaviour === "unavailable") return route.fulfill({ status: 503, json: { error: "SYNTHETIC unavailable" } });
  if (behaviour === "unconfirmed") return route.fulfill({ json: { persisted: false } });
  if (behaviour === "wrong_scope") return route.fulfill({ json: { persisted: true, data: { id: propertyId, workspaceId: otherWorkspaceId, projectId } } });
  return route.fulfill({ json: { persisted: true, data: { id: propertyId, workspaceId: record.workspaceId, projectId: record.body.projectId } } });
});
const form = page.locator("form").filter({ has: page.getByText(copy.form.overview, { exact: true }) });
async function open() {
  requests.length = 0; behaviours = []; gate = null;
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await openForm();
  await form.getByLabel(copy.form.title, { exact: true }).fill("SYNTHETIC direct QA");
  await form.getByLabel(copy.form.address, { exact: true }).and(form.locator("input[required]")).fill("MUSTER Beispielstraße 1, Wien");
}
async function openForm() {
  await page.getByRole("button", { name: "Objekt anlegen", exact: true }).click();
  await page.getByText("Erweiterte Direkterfassung mit allen Feldern", { exact: true }).click();
  await expect(form).toBeVisible();
}
async function leaveSection() { await page.evaluate(() => window.setPropertyVisible(false)); await expect(page.getByText("Section closed", { exact: true })).toBeVisible(); }
async function returnToSection() { await page.evaluate(() => window.setPropertyVisible(true)); await openForm(); }
async function expectUnloadProtected() { assert.equal(await page.evaluate(() => !window.dispatchEvent(new Event("beforeunload", { cancelable: true }))), true); }
const submit = () => form.getByRole("button", { name: "Objekt speichern", exact: true }).click();
async function step(name, run) { await run(); results.push({ name, status: "PASS" }); console.log("PASS " + name); }
try {
  if (baseline) {
    await step("baseline reproduces rejected valid decimals before submission", async () => {
      await open(); await form.getByRole("spinbutton", { name: copy.form.livingArea, exact: true }).fill("75.25");
      assert.equal(await form.evaluate(node => node.checkValidity()), false); await submit(); assert.equal(requests.length, 0);
    });
    await step("baseline reproduces missing selected workspace in direct request", async () => {
      await open(); await form.getByRole("spinbutton", { name: copy.form.livingArea, exact: true }).fill("75");
      await submit(); await expect.poll(() => requests.length).toBe(1); assert.equal(requests[0].workspaceId, null);
    });
  } else {
  await step("decimal area, fractional rooms and cents reach the selected workspace and project", async () => {
    await open();
    await form.getByRole("spinbutton", { name: copy.form.livingArea, exact: true }).fill("75.25");
    await form.getByRole("spinbutton", { name: copy.form.rooms, exact: true }).fill("3.5");
    await form.getByRole("spinbutton", { name: copy.form.purchasePrice, exact: true }).fill("345000.25");
    assert.equal(await form.evaluate(node => node.checkValidity()), true);
    await submit(); await expect(form.getByLabel(copy.form.title, { exact: true })).toHaveValue("");
    assert.equal(requests.length, 1); assert.equal(requests[0].workspaceId, workspaceId); assert.equal(requests[0].body.projectId, projectId);
    assert.equal(requests[0].body.areaSqm, "75.25"); assert.equal(requests[0].body.rooms, "3.5"); assert.equal(requests[0].body.price, "345000.25");
    assert.match(requests[0].key, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i); assert.ok(requests[0].correlation);
  });
  await step("negative values and fractions of a cent do not submit", async () => {
    await open(); await form.getByRole("spinbutton", { name: copy.form.livingArea, exact: true }).fill("-1"); await submit(); assert.equal(requests.length, 0);
    await form.getByRole("spinbutton", { name: copy.form.livingArea, exact: true }).fill("75.25"); await form.getByRole("spinbutton", { name: copy.form.purchasePrice, exact: true }).fill("10.001"); await submit(); assert.equal(requests.length, 0);
    await form.getByRole("spinbutton", { name: copy.form.purchasePrice, exact: true }).fill("10.01");
    await form.getByRole("spinbutton", { name: copy.form.yearBuilt, exact: true }).fill("0"); await submit(); assert.equal(requests.length, 0);
    await form.getByRole("spinbutton", { name: copy.form.yearBuilt, exact: true }).fill("10000"); await submit(); assert.equal(requests.length, 0);
  });
  await step("uncertain response freezes inputs and replays the exact request and identifiers", async () => {
    await open(); behaviours = ["network"]; await submit();
    await expect(form.getByRole("button", { name: "Speicherergebnis erneut prüfen" })).toBeVisible();
    await expect(form.getByLabel(copy.form.title, { exact: true })).toBeDisabled();
    const dialogPromise = page.waitForEvent("dialog");
    const reload = page.reload().catch(() => null);
    const dialog = await dialogPromise; assert.equal(dialog.type(), "beforeunload"); await dialog.dismiss(); await reload;
    await form.getByRole("button", { name: "Speicherergebnis erneut prüfen" }).click();
    await expect(form.getByLabel(copy.form.title, { exact: true })).toHaveValue(""); assert.equal(requests.length, 2); assert.deepEqual(requests[0], requests[1]);
  });
  await step("malformed success, wrong workspace and server failure retain the original attempt", async () => {
    for (const behaviour of ["unconfirmed", "wrong_scope", "unavailable"]) {
      await open(); behaviours = [behaviour]; await submit(); await expect(form.getByLabel(copy.form.title, { exact: true })).toBeDisabled();
      await form.getByRole("button", { name: "Speicherergebnis erneut prüfen" }).click(); await expect(form.getByLabel(copy.form.title, { exact: true })).toHaveValue(""); assert.deepEqual(requests[0], requests[1]);
    }
  });
  await step("terminal validation allows correction and uses a fresh intent", async () => {
    await open(); behaviours = ["invalid"]; await submit(); await expect(form.getByLabel(copy.form.title, { exact: true })).toBeEnabled();
    await form.getByLabel(copy.form.title, { exact: true }).fill("SYNTHETIC corrected"); await submit(); await expect(form.getByLabel(copy.form.title, { exact: true })).toHaveValue("");
    assert.equal(requests.length, 2); assert.notEqual(requests[0].key, requests[1].key); assert.notEqual(requests[0].body.title, requests[1].body.title);
  });
  await step("a double submit during a delayed response sends one command", async () => {
    await open(); let release; gate = new Promise(resolve => { release = resolve; });
    await form.evaluate(node => { node.requestSubmit(); node.requestSubmit(); }); await expect.poll(() => requests.length).toBe(1);
    await expect(form.getByLabel(copy.form.title, { exact: true })).toBeDisabled(); release(); gate = null;
    await expect(form.getByLabel(copy.form.title, { exact: true })).toHaveValue(""); assert.equal(requests.length, 1);
  });
  await step("refresh failure after confirmed persistence cannot replay the completed command", async () => {
    await open(); await page.evaluate(() => { window.failPropertyRefresh = true; }); await submit();
    await expect(form.getByText("Objekt gespeichert. Die Ansicht konnte noch nicht aktualisiert werden; bitte neu laden.")).toBeVisible();
    await expect(form.getByLabel(copy.form.title, { exact: true })).toHaveValue(""); await expect(form.getByRole("button", { name: "Speicherergebnis erneut prüfen" })).toHaveCount(0); assert.equal(requests.length, 1);
  });
  await step("an unconfirmed create cannot be retargeted to another workspace", async () => {
    await open(); behaviours = ["network"]; await submit(); await expect(form.getByLabel(copy.form.title, { exact: true })).toBeDisabled();
    await page.evaluate(id => window.setPropertyWorkspace(id), otherWorkspaceId);
    await expect(form.getByLabel(copy.form.title, { exact: true })).toHaveValue("");
    await expect(page.getByText("Bitte zum ursprünglichen Arbeitsbereich und Projekt zurückkehren, um den offenen Speichervorgang zu prüfen.", { exact: true })).toBeVisible();
    await expect(form.getByRole("button", { name: "Speicherergebnis erneut prüfen" })).toHaveCount(0); assert.equal(requests.length, 1);
    await page.evaluate(id => window.setPropertyWorkspace(id), workspaceId); await form.getByRole("button", { name: "Speicherergebnis erneut prüfen" }).click();
    await expect(form.getByLabel(copy.form.title, { exact: true })).toHaveValue(""); assert.equal(requests.length, 2); assert.deepEqual(requests[0], requests[1]);
  });
  await step("unsaved inputs survive actual section unmount without an automatic request", async () => {
    await open(); await form.getByRole("spinbutton", { name: copy.form.livingArea, exact: true }).fill("12.25");
    await leaveSection(); await expectUnloadProtected(); await returnToSection();
    await expect(form.getByLabel(copy.form.title, { exact: true })).toHaveValue("SYNTHETIC direct QA");
    await expect(form.getByRole("spinbutton", { name: copy.form.livingArea, exact: true })).toHaveValue("12.25"); assert.equal(requests.length, 0);
  });
  await step("delayed create across unmount and remount keeps one command and freezes the remounted form", async () => {
    await open(); let release; gate = new Promise(resolve => { release = resolve; }); await submit(); await expect.poll(() => requests.length).toBe(1);
    await leaveSection(); await expectUnloadProtected(); await returnToSection();
    await expect(form.getByLabel(copy.form.title, { exact: true })).toHaveValue("SYNTHETIC direct QA");
    await expect(form.getByLabel(copy.form.title, { exact: true })).toBeDisabled();
    await form.evaluate(node => { node.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); }); assert.equal(requests.length, 1);
    release(); gate = null; await expect(form.getByLabel(copy.form.title, { exact: true })).toHaveValue(""); assert.equal(requests.length, 1);
  });
  await step("a lost response across section unmount requires explicit exact replay", async () => {
    await open(); behaviours = ["network"]; await submit(); await expect(form.getByRole("button", { name: "Speicherergebnis erneut prüfen" })).toBeVisible();
    await leaveSection(); await expectUnloadProtected(); await returnToSection();
    await expect(form.getByLabel(copy.form.title, { exact: true })).toHaveValue("SYNTHETIC direct QA"); await expect(form.getByLabel(copy.form.title, { exact: true })).toBeDisabled(); assert.equal(requests.length, 1);
    await form.getByRole("button", { name: "Speicherergebnis erneut prüfen" }).click(); await expect(form.getByLabel(copy.form.title, { exact: true })).toHaveValue(""); assert.deepEqual(requests[0], requests[1]);
  });
  await step("success while the section is unmounted clears only its submitted draft", async () => {
    await open(); let release; gate = new Promise(resolve => { release = resolve; }); await submit(); await expect.poll(() => requests.length).toBe(1);
    await leaveSection(); release(); gate = null; await expect.poll(() => requests.length).toBe(1);
    // The callback may finish while no property component is subscribed.
    await expect.poll(() => page.evaluate(() => window.dispatchEvent(new Event("beforeunload", { cancelable: true })))).toBe(true);
    await returnToSection(); await expect(form.getByLabel(copy.form.title, { exact: true })).toHaveValue(""); assert.equal(requests.length, 1);
  });
  await step("late workspace A success preserves newer workspace B inputs and its own pending command", async () => {
    await open();
    await page.evaluate(({ otherWorkspaceId, otherProjectId }) => window.setPropertyScope(otherWorkspaceId, otherProjectId), { otherWorkspaceId, otherProjectId });
    await form.getByLabel(copy.form.title, { exact: true }).fill("SYNTHETIC workspace B new input"); await form.getByLabel(copy.form.address, { exact: true }).and(form.locator("input[required]")).fill("MUSTER B address");
    await page.evaluate(({ workspaceId, projectId }) => window.setPropertyScope(workspaceId, projectId), { workspaceId, projectId });
    let release; gate = new Promise(resolve => { release = resolve; }); await submit(); await expect.poll(() => requests.length).toBe(1);
    await page.evaluate(({ otherWorkspaceId, otherProjectId }) => window.setPropertyScope(otherWorkspaceId, otherProjectId), { otherWorkspaceId, otherProjectId });
    await expect(form.getByLabel(copy.form.title, { exact: true })).toHaveValue("SYNTHETIC workspace B new input"); await expect(form.getByLabel(copy.form.title, { exact: true })).toBeDisabled();
    release(); gate = null; await expect(form.getByLabel(copy.form.title, { exact: true })).toBeEnabled();
    await expect(form.getByLabel(copy.form.title, { exact: true })).toHaveValue("SYNTHETIC workspace B new input");
    behaviours = ["network"]; await submit(); await expect(form.getByRole("button", { name: "Speicherergebnis erneut prüfen" })).toBeVisible();
    await page.evaluate(({ workspaceId, projectId }) => window.setPropertyScope(workspaceId, projectId), { workspaceId, projectId }); await expect(form.getByLabel(copy.form.title, { exact: true })).toHaveValue("");
    await page.evaluate(({ otherWorkspaceId, otherProjectId }) => window.setPropertyScope(otherWorkspaceId, otherProjectId), { otherWorkspaceId, otherProjectId }); await expect(form.getByLabel(copy.form.title, { exact: true })).toHaveValue("SYNTHETIC workspace B new input");
    await form.getByRole("button", { name: "Speicherergebnis erneut prüfen" }).click(); await expect(form.getByLabel(copy.form.title, { exact: true })).toHaveValue(""); assert.deepEqual(requests[1], requests[2]); assert.notEqual(requests[0].key, requests[1].key);
  });
  await step("late previous-user completion cannot clear current-user inputs", async () => {
    await open(); let release; gate = new Promise(resolve => { release = resolve; }); await submit(); await expect.poll(() => requests.length).toBe(1);
    await page.evaluate(() => window.setPropertyUser("SYNTHETIC-user-b")); await expect(form.getByLabel(copy.form.title, { exact: true })).toHaveValue("");
    await form.getByLabel(copy.form.title, { exact: true }).fill("SYNTHETIC current-user draft");
    release(); gate = null; await expect(form.getByLabel(copy.form.title, { exact: true })).toHaveValue("SYNTHETIC current-user draft");
    // Starting a B save also proves the late A release cannot own B's lock.
    await form.getByLabel(copy.form.address, { exact: true }).and(form.locator("input[required]")).fill("MUSTER current-user address");
    await submit(); await expect(form.getByLabel(copy.form.title, { exact: true })).toHaveValue(""); assert.equal(requests.length, 2); assert.notEqual(requests[0].key, requests[1].key);
  });
  await step("project and signed-in identity changes isolate inputs and cannot replay a previous identity", async () => {
    await open(); behaviours = ["network"]; await submit(); await expect(form.getByRole("button", { name: "Speicherergebnis erneut prüfen" })).toBeVisible();
    await page.evaluate(({ workspaceId, otherProjectId }) => window.setPropertyScope(workspaceId, otherProjectId), { workspaceId, otherProjectId }); await expect(form.getByLabel(copy.form.title, { exact: true })).toHaveValue("");
    await page.evaluate(({ workspaceId, projectId }) => window.setPropertyScope(workspaceId, projectId), { workspaceId, projectId }); await expect(form.getByLabel(copy.form.title, { exact: true })).toHaveValue("SYNTHETIC direct QA");
    await page.evaluate(() => window.setPropertyUser("SYNTHETIC-user-b")); await expect(form.getByLabel(copy.form.title, { exact: true })).toHaveValue(""); await expect(form.getByRole("button", { name: "Speicherergebnis erneut prüfen" })).toHaveCount(0);
    await page.evaluate(() => window.setPropertyUser("SYNTHETIC-user-a")); await expect(form.getByLabel(copy.form.title, { exact: true })).toHaveValue(""); assert.equal(requests.length, 1);
    assert.deepEqual(await page.evaluate(() => ({ local: Object.keys(localStorage), session: Object.keys(sessionStorage) })), { local: [], session: [] });
  });
  await step("overview distinguishes explicit scalar area zero from unknown without certifying an unconfirmed unit price", async () => {
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    const listing = { id: propertyId, workspaceId, projectId, title: "SYNTHETIC area state", address: "MUSTER address", region: "Wien", objectType: "Wohnung", areaSqm: 0, targetPrice: 0, yearBuilt: 0, createdAt: "2026-11-04T12:00:00Z", priceVisibility: "price_on_request" };
    const row = page.getByRole("row").filter({ hasText: listing.title });
    for (const state of ["known", "unknown", "legacy"]) {
      await page.evaluate(({ listing, state }) => window.setPropertyRecords([{ ...listing, canonicalPayload: state === "legacy" ? {} : { coreNumericState: { version: 1, areaSqm: state, price: "known" } } }]), { listing, state });
      await expect(row.getByRole("cell").nth(3)).toHaveText(state === "known" ? "0 m2" : "-");
      await expect(row.getByRole("cell").nth(2)).toHaveText("-");
    }
  });
  }
  assert.deepEqual(errors, []);
} finally {
  await writeFile(path.join(output, baseline ? "baseline-results.json" : "results.json"), JSON.stringify({ syntheticHttp: true, databaseIntegration: false, baseline, baselineRevision: baseline ? baselineRevision : null, results, browserErrors: errors }, null, 2));
  await context.close(); await browser.close(); await new Promise(resolve => server.close(resolve));
}
