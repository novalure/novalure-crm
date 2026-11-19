import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { build } from "esbuild";
import { chromium, expect } from "@playwright/test";

// Local real CrmWorkspace / real History API. Child panels and Next primitives
// are replaced; authorization and HTTP responses are synthetic, not API/DB E2E.
// CRM_QA_HISTORY_BASELINE=1 freezes BOTH shell and request guard from this SHA.
const baselineRevision = "94838b983df9cfe61d8367d5f2e1ca316bfb8184";
const baseline = process.env.CRM_QA_HISTORY_BASELINE === "1";
const output = path.resolve("qa/qa001-history-20261105");
const sourcePath = path.resolve("src/components/crm-workspace.tsx");
const guardPath = path.resolve("src/lib/crm-core-request-guard.ts");
const readRevision = relative => execFileSync("git", ["show", `${baselineRevision}:${relative}`], { encoding: "utf8" }).replace(/\r\n/g, "\n");
const baseSource = readRevision("src/components/crm-workspace.tsx");
const original = baseline ? baseSource : (await readFile(sourcePath, "utf8")).replace(/\r\n/g, "\n");
const guard = baseline ? readRevision("src/lib/crm-core-request-guard.ts") : (await readFile(guardPath, "utf8")).replace(/\r\n/g, "\n");
const sha256 = value => createHash("sha256").update(value).digest("hex");
const harnessSha256 = sha256(await readFile(path.resolve("scripts/qa001-history-browser-tests.mjs"), "utf8"));
const workspaceA = "11111111-1111-4111-8111-111111111111";
const workspaceB = "44444444-4444-4444-8444-444444444444";
const workspaceAbsent = "77777777-7777-4777-8777-777777777777";
const workspaceStudio = "8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101";
const projectA = "22222222-2222-4222-8222-222222222222";
const projectB = "55555555-5555-4555-8555-555555555555";
const projectStudio = "f7d83c6b-d08d-4d73-b822-1f1c0b4733d2";
const projectFor = id => id === workspaceB ? projectB : id === workspaceStudio ? projectStudio : projectA;
const collections = ["brokerMandates", "buyerSearchProfiles", "calendarEvents", "contacts", "crmBots", "crmPipelineStages", "crmPipelines", "editorPreflightRuns", "leads", "deals", "funnelSteps", "funnels", "newsletterCampaigns", "newsletterSegments", "projectPipelinePermissions", "propertyBuildings", "propertyCostItems", "propertyDocuments", "propertyMedia", "propertyReservations", "propertyTextBlocks", "propertyUnits", "projects", "sellerListings", "tasks"];
function core(workspaceId, marker = `SYNTHETIC ${workspaceId}`) {
  return { ...Object.fromEntries(collections.map(key => [key, []])), projects: [{ id: projectFor(workspaceId), workspaceId, name: marker, type: "Immobilien", status: "Aktiv", leads: 0, revenue: "—" }], moduleSources: Object.fromEntries(collections.map(key => [key, "database"])), source: "database", dailyQueue: { generatedAt: "2026-11-05T12:00:00Z", sections: [] } };
}
const workspace = id => ({ id, name: `SYNTHETIC workspace ${id}`, customerType: "hybrid_real_estate", operatingModel: "novalure_internal", teamStructure: "small_team", activeCalendarProvider: "none", setupState: {} });
const workspaces = [workspaceA, workspaceB, workspaceStudio].map(workspace);

// Extract DATA-ONLY navigation declarations from the immutable base. These are
// the contract inventory, never an execution of the resolver under test.
const sourceAst = ts.createSourceFile("base.tsx", baseSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function literal(name) {
  let initializer;
  function visit(node) { if (ts.isVariableDeclaration(node) && node.name.getText(sourceAst) === name) initializer = node.initializer; ts.forEachChild(node, visit); }
  visit(sourceAst); assert.ok(initializer, name);
  return runInNewContext(`(${initializer.getText(sourceAst)})`, Object.create(null), { timeout: 1000 });
}
const entries = literal("navigationEntries"), presets = literal("navigationPresets"), entryHashes = literal("navigationEntryHashes");
const sectionHash = { customerAccess: "customer-access", managedService: "managed-service", customerSuccess: "customer-success", dataHygiene: "data-hygiene", objectsMandates: "objects-mandates", dailyQueue: "daily-queue", calendar: "meetings" };
const sections = [...new Set(Object.values(entries).map(entry => entry.section))];
function presetFor(section, entryId) {
  if (["billing", "aiBillingAdmin", "aiAssistant"].includes(entryId)) return "realEstateBroker"; // Authorized additions in getCrmSelfServiceEntries.
  const found = Object.entries(presets).find(([presetId, preset]) => presetId !== "novalureStudio" && (entryId ? preset.navigationEntries.includes(entryId) && !preset.navigationEntries.some(other => other !== entryId && entryHashes[other] === entryHashes[entryId] && preset.navigationEntries.indexOf(other) < preset.navigationEntries.indexOf(entryId)) : preset.navigationEntries.some(id => entries[id].section === section)));
  return found?.[0] ?? (presets.novalureStudio.navigationEntries.some(id => entryId ? id === entryId : entries[id].section === section) ? "novalureStudio" : undefined);
}
const names = new Map([...original.matchAll(/import\s*\{([^{}]+)\}\s*from\s*["'](@\/components\/[^"']+)["']/g)].map(match => [match[2], match[1].split(",").map(item => item.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0]).filter(Boolean)]));
const observer = `window.__QA_CRM__={refreshCoreData,handleWorkspaceSwitch,handleSectionChange,handleProjectScopeChange,handlePresetChange,handleNavigationChange,activeWorkspace,liveCoreData,coreDataStatus,workspaceSwitchState,crmScope,scopeHydrated,projectScopeInvalid,sectionScopeUnavailable,visibleActiveSection,visibleActiveNavigationEntry,normalizedActivePresetId,availableWorkspaces};`;
const needle = '  return (\n    <main className="crm-app';
assert.ok(original.includes(needle), "test observer placement remains explicit");
const compiled = await build({ stdin: { contents: `import React from'react';import{createRoot}from'react-dom/client';import{CrmWorkspace}from'./src/components/crm-workspace';const root=createRoot(document.getElementById('root'));root.render(<React.StrictMode><CrmWorkspace coreData={${JSON.stringify(core(workspaceA))}} sessionWorkspace={${JSON.stringify(workspace(workspaceA))}} sessionProductRole="platform_admin" sessionRole="admin" sessionUserName="SYNTHETIC user" sessionUserId="SYNTHETIC-history-user" initialLanguage="de"/></React.StrictMode>);`, loader: "tsx", resolveDir: process.cwd() }, bundle: true, write: false, format: "iife", platform: "browser", jsx: "automatic", define: { "process.env.NODE_ENV": '"test"' }, banner: { js: "var process={env:{NODE_ENV:'test'},browser:true};" }, logLevel: "silent", plugins: [{ name: "qa001-real-shell", setup(builder) {
  builder.onLoad({ filter: /\.css$/ }, () => ({ contents: "export default {}", loader: "js" }));
  builder.onLoad({ filter: /crm-workspace\.tsx$/ }, args => args.path === sourcePath ? { contents: original.replace(needle, `  ${observer}\n${needle}`), loader: "tsx", resolveDir: path.dirname(sourcePath) } : undefined);
  builder.onLoad({ filter: /crm-core-request-guard\.ts$/ }, args => args.path === guardPath ? { contents: guard, loader: "ts", resolveDir: path.dirname(guardPath) } : undefined);
  builder.onResolve({ filter: /^@\/components\// }, args => args.importer === sourcePath && !["@/components/crm-business-visibility", "@/components/workspace-navigation", "@/components/workspace-section-tabs"].includes(args.path) ? { path: args.path, namespace: "unrelated-child" } : undefined);
  builder.onLoad({ filter: /.*/, namespace: "unrelated-child" }, args => ({ contents: "import React from'react';\n" + (names.get(args.path) ?? []).map(name => ["CrmAiBillingPanel", "AiBillingAdminPanel", "CrmAiAssistant"].includes(name) ? `export const ${name}=props=>React.createElement('div',{'data-qa-panel':'${name}','data-qa-workspace':props.workspaceId});` : `export const ${name}=()=>${name.startsWith("get") ? "'SYNTHETIC label'" : "null"};`).join("\n"), loader: "js", resolveDir: process.cwd() }));
  builder.onResolve({ filter: /^next\/navigation$/ }, () => ({ path: "navigation", namespace: "next-test" }));
  builder.onResolve({ filter: /^next\/link$/ }, () => ({ path: "link", namespace: "next-test" }));
  builder.onLoad({ filter: /.*/, namespace: "next-test" }, args => ({ contents: args.path === "navigation" ? "export const useRouter=()=>({push(){},replace(){},refresh(){}});export const usePathname=()=>'/';export const useSearchParams=()=>new URLSearchParams();" : "import React from'react';export default function Link({children,href}){return React.createElement('a',{href},children)}", loader: "js", resolveDir: process.cwd() }));
} }] });
const server = createServer((request, response) => { response.setHeader("content-type", request.url === "/bundle.js" ? "application/javascript" : "text/html"); response.end(request.url === "/bundle.js" ? compiled.outputFiles[0].text : '<!doctype html><html><body><div id="root"></div><script src="/bundle.js"></script></body></html>'); });
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ channel: process.env.CRM_QA_BROWSER_CHANNEL || "chrome", headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
await context.addInitScript(({ workspaceStudio }) => { localStorage.clear(); const preset = new URL(location.href).searchParams.get("qaPreset") || "realEstateBroker"; localStorage.setItem("novalure-crm-navigation-preset-v1", preset); localStorage.setItem(`novalure-crm-navigation-preset-v1:SYNTHETIC-history-user:${workspaceStudio}`, preset); }, { workspaceStudio });
const page = await context.newPage();
page.setDefaultTimeout(2500); page.setDefaultNavigationTimeout(15000);
const browserErrors = [], results = [], requests = [], blockedNetwork = [];
let plans = [], gates = [], scenario = "startup", navigationSerial = 0;
page.on("pageerror", error => browserErrors.push({ scenario, message: error.message }));
await context.route("**/*", async route => {
  const request = route.request(), url = new URL(request.url());
  if (url.origin !== origin) { blockedNetwork.push({ origin: url.origin, method: request.method() }); return route.abort("blockedbyclient"); }
  if (!url.pathname.startsWith("/api/")) return route.continue();
  if (url.pathname === "/api/auth/csrf") return route.fulfill({ json: { csrfToken: "SYNTHETIC-csrf" } });
  if (url.pathname === "/api/workspaces") return route.fulfill({ json: { workspaces } });
  if (url.pathname === "/api/crm/core") {
    const workspaceId = url.searchParams.get("workspaceId") || workspaceA;
    const index = plans.findIndex(plan => plan.workspaceId === workspaceId), plan = index >= 0 ? plans.splice(index, 1)[0] : null;
    requests.push({ scenario, workspaceId, marker: plan?.marker ?? null, status: plan?.status ?? 200 });
    if (plan?.gate) await plan.gate;
    const data = core(plan?.dataWorkspaceId ?? workspaceId, plan?.marker); if (plan?.projects) data.projects = plan.projects;
    try { return await route.fulfill({ status: plan?.status ?? 200, json: plan?.status ? { error: "SYNTHETIC target unavailable" } : { activeWorkspaceId: plan?.responseWorkspaceId ?? workspaceId, data } }); } catch (error) { if (!page.isClosed() && !String(error).includes("Target page")) throw error; return; }
  }
  return route.fulfill({ json: { data: { drafts: [], projects: [], inquiries: [], assignments: [], candidates: [], counts: [] }, users: [], capabilities: {}, unreadCount: 0 } });
});
const snapshot = () => page.evaluate(() => { const qa = window.__QA_CRM__; return { workspaceId: qa.activeWorkspace.id, dataWorkspaceIds: [...new Set(qa.liveCoreData.projects.map(project => project.workspaceId))], marker: qa.liveCoreData.projects[0]?.name, status: qa.coreDataStatus, switchStatus: qa.workspaceSwitchState, scope: qa.crmScope, hydrated: qa.scopeHydrated, blocked: qa.sectionScopeUnavailable, invalid: qa.projectScopeInvalid, section: qa.visibleActiveSection, entry: qa.visibleActiveNavigationEntry.id, preset: qa.normalizedActivePresetId, url: location.pathname + location.search + location.hash, historyLength: history.length }; });
const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve)))));
function gate() { let release; const promise = new Promise(resolve => { release = resolve; }); const value = { promise, release }; gates.push(value); return value; }
function releaseAll() { for (const value of gates) value.release(); gates = []; }
function urlFor(workspaceId, projectId = "all", hash = "properties", preset = "realEstateBroker") { return `${origin}/?workspaceId=${workspaceId}&projectId=${projectId ?? "all"}&qaPreset=${preset}&qaCase=${++navigationSerial}#${hash}`; }
async function open(workspaceId = workspaceA, projectId = projectA, hash = "properties", preset = "realEstateBroker") {
  releaseAll(); plans = []; await page.goto(urlFor(workspaceId, projectId, hash, preset), { waitUntil: "domcontentloaded", timeout: 15000 });
  await expect.poll(() => page.evaluate(() => Boolean(window.__QA_CRM__)), { timeout: 3000 }).toBe(true);
  await settle(); await expect.poll(() => page.evaluate(() => window.__QA_CRM__.availableWorkspaces.length), { timeout: 3000 }).toBe(3); await settle();
}
async function assertScope(workspaceId, projectId = null, section = "properties") {
  await expect.poll(async () => { const s = await snapshot(); return { workspaceId: s.workspaceId, dataWorkspaceIds: s.dataWorkspaceIds, scopeWorkspace: s.scope.workspaceId, projectId: s.scope.projectId, valid: s.scope.status, hydrated: s.hydrated, section: s.section }; }, { timeout: 2200 }).toEqual({ workspaceId, dataWorkspaceIds: [workspaceId], scopeWorkspace: workspaceId, projectId, valid: "valid", hydrated: true, section });
  const url = new URL(page.url()); assert.equal(url.searchParams.get("workspaceId"), workspaceId); assert.equal(url.searchParams.get("projectId"), projectId ?? "all");
}
async function switchTo(workspaceId, projectId) { const ok = await page.evaluate(({ workspaceId, workspaces, projectId }) => window.__QA_CRM__.handleWorkspaceSwitch(workspaceId, workspaces, projectId), { workspaceId, workspaces, projectId }); await settle(); return ok; }
async function startSwitch(workspaceId, projectId) { await page.evaluate(({ workspaceId, workspaces, projectId }) => { window.switchPromise = window.__QA_CRM__.handleWorkspaceSwitch(workspaceId, workspaces, projectId); }, { workspaceId, workspaces, projectId }); }
async function installForwardEntry(url) { await page.evaluate(url => history.pushState(null, "", url), url); await page.goBack(); await settle(); }
async function step(name, run, details = {}) {
  scenario = name; const requestStart = requests.length, errorStart = browserErrors.length, start = Date.now();
  try { await run(); assert.deepEqual(browserErrors.slice(errorStart), []); results.push({ name, status: "PASS", durationMs: Date.now() - start, requests: requests.slice(requestStart), ...details }); console.log(`PASS ${name}`); }
  catch (error) { let state = null; try { state = await snapshot(); } catch {} results.push({ name, status: "FAIL", durationMs: Date.now() - start, error: String(error.message ?? error), state, requests: requests.slice(requestStart), ...details }); console.log(`FAIL ${name}: ${String(error.message ?? error).split("\n")[0]}`); }
  finally { releaseAll(); }
}
try {
  await step("direct B/project deep link and actual reload retain workspace, project and properties", async () => { await open(workspaceB, projectB); await assertScope(workspaceB, projectB); await page.reload({ waitUntil: "domcontentloaded", timeout: 15000 }); await settle(); await assertScope(workspaceB, projectB); });
  await step("A to B to real Back to real Forward restores dataset and project without new history entries", async () => { await open(); await assertScope(workspaceA, projectA); assert.equal(await switchTo(workspaceB, projectB), true); await assertScope(workspaceB, projectB); const length = (await snapshot()).historyLength; await page.goBack(); await assertScope(workspaceA, projectA); await page.goForward(); await assertScope(workspaceB, projectB); assert.equal((await snapshot()).historyLength, length); });
  await step("explicit All Projects survives project history Back Forward and reload", async () => { await open(); await page.evaluate(() => window.__QA_CRM__.handleProjectScopeChange("all")); await assertScope(workspaceA, null); await page.goBack(); await assertScope(workspaceA, projectA); await page.goForward(); await assertScope(workspaceA, null); await page.reload({ waitUntil: "domcontentloaded", timeout: 15000 }); await settle(); await assertScope(workspaceA, null); });
  await step("section history preserves explicit nested buyer-leads and properties", async () => { await open(workspaceA, projectA, "buyer-leads"); await expect.poll(async () => (await snapshot()).entry).toBe("buyerLeads"); await page.evaluate(() => window.__QA_CRM__.handleNavigationChange("properties")); await expect.poll(async () => (await snapshot()).entry).toBe("properties"); await page.goBack(); await expect.poll(async () => (await snapshot()).entry).toBe("buyerLeads"); await page.goForward(); await expect.poll(async () => (await snapshot()).entry).toBe("properties"); });
  await step("delayed B switch is cancelled when user selects already active A", async () => { await open(); const delayed = gate(); plans.push({ workspaceId: workspaceB, gate: delayed.promise, marker: "SYNTHETIC stale B after return to A" }); const count = requests.length; await startSwitch(workspaceB, projectB); await expect.poll(() => requests.length).toBe(count + 1); assert.equal(await switchTo(workspaceA, projectA), true); delayed.release(); await page.evaluate(() => window.switchPromise); await settle(); await assertScope(workspaceA, projectA); assert.notEqual((await snapshot()).switchStatus, "loading"); });
  await step("local project selection cancels pending B and late B cannot replace explicit All in A", async () => { await open(); const delayed = gate(); plans.push({ workspaceId: workspaceB, gate: delayed.promise, marker: "SYNTHETIC stale B after local project selection" }); const count = requests.length; await startSwitch(workspaceB, projectB); await expect.poll(() => requests.length).toBe(count + 1); assert.equal((await snapshot()).blocked, true); await page.evaluate(() => window.__QA_CRM__.handleProjectScopeChange("all")); await assertScope(workspaceA, null); delayed.release(); await page.evaluate(() => window.switchPromise); await settle(); await assertScope(workspaceA, null); assert.equal((await snapshot()).switchStatus, "idle"); });
  await step("Back A request delayed then Forward B cannot commit late A or grow history", async () => { await open(); assert.equal(await switchTo(workspaceB, projectB), true); await assertScope(workspaceB, projectB); const length = (await snapshot()).historyLength; const delayed = gate(); plans.push({ workspaceId: workspaceA, gate: delayed.promise, marker: "SYNTHETIC stale history A" }); const count = requests.length; await page.goBack(); await expect.poll(() => requests.length, { timeout: 2200 }).toBe(count + 1); await page.goForward(); await settle(); delayed.release(); await settle(); await assertScope(workspaceB, projectB); assert.equal((await snapshot()).historyLength, length); });
  await step("unknown workspace direct link blocks business scope without adopting foreign data", async () => { await open(workspaceAbsent, projectB); const s = await snapshot(); assert.equal(s.invalid, true); assert.equal(s.blocked, true); assert.notEqual(s.workspaceId, workspaceAbsent); assert.equal(s.dataWorkspaceIds.includes(workspaceAbsent), false); assert.equal(new URL(page.url()).searchParams.get("workspaceId"), workspaceAbsent); });
  await step("known target revoked by core 403 remains blocked and URL is not rewritten to a false success", async () => { await open(); await installForwardEntry(urlFor(workspaceB, projectB)); plans.push({ workspaceId: workspaceB, status: 403 }); const count = requests.length; await page.goForward(); await expect.poll(() => requests.length, { timeout: 2200 }).toBe(count + 1); await expect.poll(async () => (await snapshot()).switchStatus, { timeout: 2200 }).not.toBe("loading"); await settle(); const s = await snapshot(); assert.equal(s.invalid, true); assert.equal(s.blocked, true); assert.notEqual(s.workspaceId, workspaceB); assert.equal(s.dataWorkspaceIds.includes(workspaceB), false); assert.equal(new URL(page.url()).searchParams.get("workspaceId"), workspaceB); });
  await step("pending B response cannot commit after real Forward to absent workspace", async () => { await open(); await installForwardEntry(urlFor(workspaceAbsent, projectB)); const delayed = gate(); plans.push({ workspaceId: workspaceB, gate: delayed.promise, marker: "SYNTHETIC stale B after absent target" }); const count = requests.length; await startSwitch(workspaceB, projectB); await expect.poll(() => requests.length).toBe(count + 1); await page.goForward(); await settle(); delayed.release(); await page.evaluate(() => window.switchPromise); await settle(); const s = await snapshot(); assert.equal(s.invalid, true); assert.equal(s.blocked, true); assert.notEqual(s.workspaceId, workspaceB); assert.equal(s.dataWorkspaceIds.includes(workspaceB), false); assert.equal(new URL(page.url()).searchParams.get("workspaceId"), workspaceAbsent); });
  await step("wrong activeWorkspaceId in core 200 cannot be adopted as requested B", async () => { await open(); plans.push({ workspaceId: workspaceB, responseWorkspaceId: workspaceA, dataWorkspaceId: workspaceA }); assert.equal(await switchTo(workspaceB, projectB), false); const s = await snapshot(); assert.equal(s.workspaceId, workspaceA); assert.deepEqual(s.dataWorkspaceIds, [workspaceA]); });
  await step("foreign project ID is invalid and never falls back to first project", async () => { await open(workspaceA, projectB); const s = await snapshot(); assert.equal(s.invalid, true); assert.equal(s.blocked, true); assert.equal(s.scope.projectId, projectB); assert.notEqual(s.scope.projectId, projectA); });
  await step("authorized B core 200 with revoked project filtered out blocks the requested project without fallback", async () => { await open(); plans.push({ workspaceId: workspaceB, projects: [] }); assert.equal(await switchTo(workspaceB, projectB), true); const s = await snapshot(); assert.equal(s.workspaceId, workspaceB); assert.equal(s.scope.workspaceId, workspaceB); assert.equal(s.scope.projectId, projectB); assert.equal(s.scope.invalidReason, "project_not_available"); assert.equal(s.invalid, true); assert.equal(s.blocked, true); assert.deepEqual(s.dataWorkspaceIds, []); });
  await step("legacy camelCase #objectsMandates restores its allowed section", async () => { await open(workspaceA, "all", "objectsMandates", "realEstateBroker"); await expect.poll(async () => (await snapshot()).section, { timeout: 1200 }).toBe("objectsMandates"); });
  for (const [hash, panel] of [["billing", "CrmAiBillingPanel"], ["ai-billing-admin", "AiBillingAdminPanel"], ["ai-assistant", "CrmAiAssistant"]]) {
    await step(`#${hash} never renders old-workspace panel while target pending or revoked`, async () => { await open(workspaceA, projectA, hash); await expect(page.locator(`[data-qa-panel="${panel}"]`)).toHaveCount(1); await installForwardEntry(urlFor(workspaceB, projectB, hash)); const delayed = gate(); plans.push({ workspaceId: workspaceB, status: 403, gate: delayed.promise }); const count = requests.length; await page.goForward(); await expect.poll(() => requests.length, { timeout: 2200 }).toBe(count + 1); await expect(page.locator(`[data-qa-panel="${panel}"]`)).toHaveCount(0); delayed.release(); await expect.poll(async () => (await snapshot()).blocked, { timeout: 2200 }).toBe(true); await settle(); await expect(page.locator(`[data-qa-panel="${panel}"]`)).toHaveCount(0); assert.equal((await snapshot()).invalid, true); });
    await step(`#${hash} never renders panel for unknown-workspace direct URL`, async () => { await open(workspaceAbsent, projectB, hash); assert.equal((await snapshot()).blocked, true); await expect(page.locator(`[data-qa-panel="${panel}"]`)).toHaveCount(0); });
  }
  if (process.env.CRM_QA_HISTORY_SKIP_HASHES !== "1") {
    for (const section of sections) {
      const preset = presetFor(section), hash = sectionHash[section] ?? section;
      assert.ok(preset, `an authorized profile exists for ${section}`);
      await step(`canonical hash #${hash} restores allowed section ${section}`, async () => { await open(preset === "novalureStudio" ? workspaceStudio : workspaceA, "all", hash, preset); await expect.poll(async () => (await snapshot()).section, { timeout: 1200 }).toBe(section); }, { hash, expectedSection: section, profile: preset, group: "canonical-sections" });
    }
    for (const [entryId, hash] of Object.entries(entryHashes)) {
      const preset = presetFor(entries[entryId].section, entryId); assert.ok(preset, `an unambiguous profile exists for ${entryId}`);
      await step(`explicit nested hash #${hash} restores ${entryId}`, async () => { await open(preset === "novalureStudio" ? workspaceStudio : workspaceA, "all", hash, preset); await expect.poll(async () => (await snapshot()).entry, { timeout: 1200 }).toBe(entryId); }, { hash, expectedEntry: entryId, profile: preset, group: "explicit-nested-hashes" });
    }
    let aliases;
    function findAliases(node) { if (ts.isFunctionDeclaration(node) && node.name?.text === "readInitialSection") { function visit(child) { if (ts.isVariableDeclaration(child) && child.name.getText(sourceAst) === "sections") aliases = runInNewContext(`(${child.initializer.getText(sourceAst)})`, Object.create(null), { timeout: 1000 }); ts.forEachChild(child, visit); } visit(node); } ts.forEachChild(node, findAliases); }
    findAliases(sourceAst); assert.ok(aliases);
    const already = new Set(sections.map(section => sectionHash[section] ?? section));
    for (const [hash, section] of Object.entries(aliases)) {
      if (already.has(hash) || Object.values(entryHashes).includes(hash)) continue;
      const preset = presetFor(section);
      await step(`legacy alias #${hash} restores allowed section ${section}`, async () => { await open(preset === "novalureStudio" ? workspaceStudio : workspaceA, "all", hash, preset); await expect.poll(async () => (await snapshot()).section, { timeout: 1200 }).toBe(section); }, { hash, expectedSection: section, profile: preset, group: "legacy-aliases" });
    }
  }
  assert.deepEqual(blockedNetwork, [], "no live or provider network requests attempted");
} finally {
  releaseAll(); await mkdir(output, { recursive: true });
  const summary = { capturedAt: new Date().toISOString(), localOnly: true, syntheticHttp: true, actualCrmWorkspace: true, actualBrowserHistoryTraversal: true, realWorkspaceNavigationComponents: true, testObserverReadOnlyStateAndExistingHandlers: true, unrelatedChildPanelsStubbed: true, nextPrimitivesStubbed: true, databaseIntegration: false, authorizationIntegration: false, liveTest: false, fixtureContext: { sessionProductRole: "platform_admin", operatingModel: "novalure_internal", allWorkspacesSynthetic: true, serverAuthorizationStubbed: true }, baseline, baselineRevision, harnessSha256, testedHead: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), sourceHashNormalization: "CRLF to LF", sourceHashes: { "src/components/crm-workspace.tsx": sha256(original), "src/lib/crm-core-request-guard.ts": sha256(guard) }, totals: { cases: results.length, passed: results.filter(result => result.status === "PASS").length, failed: results.filter(result => result.status === "FAIL").length }, results, browserErrors, blockedNetwork, requests };
  await writeFile(path.join(output, baseline ? "baseline-browser-results.json" : "browser-results.json"), JSON.stringify(summary, null, 2) + "\n");
  console.log(JSON.stringify(summary.totals)); await context.close(); await browser.close(); await new Promise(resolve => server.close(resolve));
}
if (results.some(result => result.status === "FAIL")) process.exitCode = 1;
