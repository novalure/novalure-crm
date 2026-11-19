import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";
import { chromium, expect } from "@playwright/test";

// N1 only: actual React shell and existing selection/switch handlers. A captured
// handler models the documented async project-save continuation, not a complete
// project form/POST test. Every case owns a fresh browser context and RAM state.
const baselineRevision = "a942049c967009f6df09bf2eb905f8d5ba5e5ac8";
const requestedRevision = process.env.CRM_QA_N1_REVISION;
if (requestedRevision) assert.match(requestedRevision, /^[a-f0-9]{7,40}$/i, "revision must be a commit SHA");
const baseline = !requestedRevision && process.env.CRM_QA_N1_BASELINE === "1";
const sourceRevision = requestedRevision ? execFileSync("git", ["rev-parse", "--verify", `${requestedRevision}^{commit}`], { encoding: "utf8" }).trim() : baseline ? baselineRevision : null;
const output = path.resolve(process.env.CRM_QA_N1_OUTPUT || "qa/qa001-n1-20261105");
assert.ok(!output.startsWith("\\\\"), "evidence output must be a local directory");
const sourcePath = path.resolve("src/components/crm-workspace.tsx");
const guardPath = path.resolve("src/lib/crm-core-request-guard.ts");
const readSource = async relative => (sourceRevision ? execFileSync("git", ["show", `${sourceRevision}:${relative}`], { encoding: "utf8" }) : await readFile(relative, "utf8")).replace(/\r\n/g, "\n");
const original = await readSource("src/components/crm-workspace.tsx");
const guard = await readSource("src/lib/crm-core-request-guard.ts");
const sha256 = value => createHash("sha256").update(value).digest("hex");
const harnessSha256 = sha256(await readFile(new URL(import.meta.url), "utf8"));
const workspaceA = "11111111-1111-4111-8111-111111111111";
const workspaceB = "44444444-4444-4444-8444-444444444444";
const workspaceC = "77777777-7777-4777-8777-777777777777";
const projectA = "22222222-2222-4222-8222-222222222222";
const projectB = "55555555-5555-4555-8555-555555555555";
const projectC = "88888888-8888-4888-8888-888888888888";
const projectFor = workspaceId => ({ [workspaceA]: projectA, [workspaceB]: projectB, [workspaceC]: projectC })[workspaceId];
const collections = ["brokerMandates", "buyerSearchProfiles", "calendarEvents", "contacts", "crmBots", "crmPipelineStages", "crmPipelines", "editorPreflightRuns", "leads", "deals", "funnelSteps", "funnels", "newsletterCampaigns", "newsletterSegments", "projectPipelinePermissions", "propertyBuildings", "propertyCostItems", "propertyDocuments", "propertyMedia", "propertyReservations", "propertyTextBlocks", "propertyUnits", "projects", "sellerListings", "tasks"];
function core(workspaceId, marker = `SYNTHETIC ${workspaceId}`) {
  return { ...Object.fromEntries(collections.map(key => [key, []])), projects: [{ id: projectFor(workspaceId), workspaceId, name: marker, type: "Immobilien", status: "Aktiv", leads: 0, revenue: "—" }], moduleSources: Object.fromEntries(collections.map(key => [key, "database"])), source: "database", dailyQueue: { generatedAt: "2026-11-05T12:00:00Z", sections: [] } };
}
const workspace = id => ({ id, name: `SYNTHETIC workspace ${id}`, customerType: "hybrid_real_estate", operatingModel: "novalure_internal", teamStructure: "small_team", activeCalendarProvider: "none", setupState: {} });
const workspaces = [workspaceA, workspaceB, workspaceC].map(workspace);
const names = new Map([...original.matchAll(/import\s*\{([^{}]+)\}\s*from\s*["'](@\/components\/[^"']+)["']/g)].map(match => [match[2], match[1].split(",").map(item => item.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0]).filter(Boolean)]));
const observer = "window.__QA_N1__={handleWorkspaceSwitch,handleProjectScopeChange,activeWorkspace,liveCoreData,coreDataStatus,workspaceSwitchState,crmScope,scopeHydrated,projectScopeInvalid,sectionScopeUnavailable,availableWorkspaces,sessionUserId};";
const needle = '  return (\n    <main className="crm-app';
assert.ok(original.includes(needle));
const compiled = await build({ stdin: { contents: `import React from'react';import{createRoot}from'react-dom/client';import{CrmWorkspace}from'./src/components/crm-workspace';const root=createRoot(document.getElementById('root'));let user='SYNTHETIC-N1-user-A';const props={coreData:${JSON.stringify(core(workspaceA))},sessionWorkspace:${JSON.stringify(workspace(workspaceA))},sessionProductRole:'platform_admin',sessionRole:'admin',sessionUserName:'SYNTHETIC user',initialLanguage:'de'};const render=()=>root.render(<React.StrictMode><CrmWorkspace key={user} {...props} sessionUserId={user}/></React.StrictMode>);window.setN1Identity=value=>{user=value;render()};render();`, loader: "tsx", resolveDir: process.cwd() }, bundle: true, write: false, format: "iife", platform: "browser", jsx: "automatic", define: { "process.env.NODE_ENV": '"test"' }, banner: { js: "var process={env:{NODE_ENV:'test'},browser:true};" }, logLevel: "silent", plugins: [{ name: "n1-real-shell", setup(builder) {
  builder.onLoad({ filter: /\.css$/ }, () => ({ contents: "export default {}", loader: "js" }));
  builder.onLoad({ filter: /crm-workspace\.tsx$/ }, args => args.path === sourcePath ? { contents: original.replace(needle, `  ${observer}\n${needle}`), loader: "tsx", resolveDir: path.dirname(sourcePath) } : undefined);
  builder.onLoad({ filter: /crm-core-request-guard\.ts$/ }, args => args.path === guardPath ? { contents: guard, loader: "ts", resolveDir: path.dirname(guardPath) } : undefined);
  builder.onResolve({ filter: /^@\/components\// }, args => args.importer === sourcePath && args.path !== "@/components/crm-business-visibility" ? { path: args.path, namespace: "unrelated-child" } : undefined);
  builder.onLoad({ filter: /.*/, namespace: "unrelated-child" }, args => ({ contents: (names.get(args.path) ?? []).map(name => `export const ${name}=()=>${name.startsWith("get") ? "'SYNTHETIC label'" : "null"};`).join("\n"), loader: "js" }));
  builder.onResolve({ filter: /^next\/navigation$/ }, () => ({ path: "navigation", namespace: "next-test" }));
  builder.onResolve({ filter: /^next\/link$/ }, () => ({ path: "link", namespace: "next-test" }));
  builder.onLoad({ filter: /.*/, namespace: "next-test" }, args => ({ contents: args.path === "navigation" ? "export const useRouter=()=>({push(){},replace(){},refresh(){}});export const usePathname=()=>'/';export const useSearchParams=()=>new URLSearchParams();" : "import React from'react';export default function Link({children,href}){return React.createElement('a',{href},children)}", loader: "js", resolveDir: process.cwd() }));
} }] });
const server = createServer((request, response) => { response.setHeader("content-type", request.url === "/bundle.js" ? "application/javascript" : "text/html"); response.end(request.url === "/bundle.js" ? compiled.outputFiles[0].text : '<!doctype html><html><body><div id="root"></div><script src="/bundle.js"></script></body></html>'); });
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ channel: process.env.CRM_QA_BROWSER_CHANNEL || "chrome", headless: true });
const results = [];
const snapshot = page => page.evaluate(() => { const qa = window.__QA_N1__; return { identity: qa.sessionUserId, workspaceId: qa.activeWorkspace.id, dataWorkspaceIds: [...new Set(qa.liveCoreData.projects.map(project => project.workspaceId))], scope: qa.crmScope, hydrated: qa.scopeHydrated, blocked: qa.sectionScopeUnavailable, invalid: qa.projectScopeInvalid, status: qa.coreDataStatus, switchStatus: qa.workspaceSwitchState, url: location.pathname + location.search + location.hash, historyLength: history.length }; });
const settle = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve)))));
async function runCase(name, run) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addInitScript(() => localStorage.setItem("novalure-crm-navigation-preset-v1", "realEstateBroker"));
  const page = await context.newPage(); page.setDefaultTimeout(2500); page.setDefaultNavigationTimeout(15000);
  const browserErrors = [], blockedNetwork = [], requests = [], checkpoints = {};
  let plans = [], gates = [];
  const gate = () => { let release; const promise = new Promise(resolve => { release = resolve; }); const value = { promise, release }; gates.push(value); return value; };
  page.on("pageerror", error => browserErrors.push(error.message));
  await context.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin) { blockedNetwork.push({ origin: url.origin, method: request.method() }); return route.abort("blockedbyclient"); }
    if (!url.pathname.startsWith("/api/")) return route.continue();
    if (url.pathname === "/api/workspaces") return route.fulfill({ json: { workspaces } });
    if (url.pathname === "/api/crm/core") {
      const workspaceId = url.searchParams.get("workspaceId") || workspaceA;
      const index = plans.findIndex(plan => plan.workspaceId === workspaceId), plan = index >= 0 ? plans.splice(index, 1)[0] : null;
      requests.push({ workspaceId, gated: Boolean(plan?.gate), marker: plan?.marker ?? null });
      if (plan?.gate) await plan.gate;
      return route.fulfill({ json: { activeWorkspaceId: workspaceId, data: core(workspaceId, plan?.marker) } });
    }
    return route.fulfill({ json: { data: { drafts: [], projects: [], inquiries: [], assignments: [], candidates: [], counts: [] }, users: [], capabilities: {}, unreadCount: 0 } });
  });
  const assertScope = async (workspaceId, projectId) => {
    await expect.poll(async () => { const state = await snapshot(page); return { workspaceId: state.workspaceId, dataWorkspaceIds: state.dataWorkspaceIds, scopeWorkspaceId: state.scope.workspaceId, projectId: state.scope.projectId, scopeStatus: state.scope.status, hydrated: state.hydrated, invalid: state.invalid }; }).toEqual({ workspaceId, dataWorkspaceIds: [workspaceId], scopeWorkspaceId: workspaceId, projectId, scopeStatus: "valid", hydrated: true, invalid: false });
    const url = new URL(page.url()); assert.equal(url.searchParams.get("workspaceId"), workspaceId); assert.equal(url.searchParams.get("projectId"), projectId ?? "all");
  };
  const switchTo = async (workspaceId, projectId) => { const completed = await page.evaluate(({ workspaceId, projectId, workspaces }) => window.__QA_N1__.handleWorkspaceSwitch(workspaceId, workspaces, projectId), { workspaceId, projectId, workspaces }); await settle(page); return completed; };
  const pendingC = async () => {
    const delayed = gate(); plans.push({ workspaceId: workspaceC, gate: delayed.promise, marker: "SYNTHETIC newest C" }); const count = requests.length;
    await page.evaluate(({ workspaceC, projectC, workspaces }) => { window.pendingC = window.__QA_N1__.handleWorkspaceSwitch(workspaceC, workspaces, projectC); }, { workspaceC, projectC, workspaces });
    await expect.poll(() => requests.length).toBe(count + 1); await settle(page); return delayed;
  };
  try {
    await page.goto(`${origin}/?workspaceId=${workspaceA}&projectId=${projectA}#properties`, { waitUntil: "domcontentloaded", timeout: 15000 });
    await expect.poll(() => page.evaluate(() => window.__QA_N1__?.availableWorkspaces.length)).toBe(3); await settle(page); await assertScope(workspaceA, projectA);
    await run({ page, checkpoints, assertScope, switchTo, pendingC });
    assert.deepEqual(browserErrors, []); assert.deepEqual(blockedNetwork, []);
    results.push({ name, status: "PASS", freshContext: true, checkpoints, requests, browserErrors, blockedNetwork }); console.log(`PASS ${name}`);
  } catch (error) {
    checkpoints.failure = await snapshot(page).catch(() => null);
    results.push({ name, status: "FAIL", freshContext: true, error: String(error.message ?? error), checkpoints, requests, browserErrors, blockedNetwork }); console.log(`FAIL ${name}: ${String(error.message ?? error).split("\n")[0]}`);
  } finally { for (const delayed of gates) delayed.release(); gates = []; plans = []; await context.close(); }
}
try {
  await runCase("stale A selection cannot cancel current B-to-C switch or overwrite pending scope/URL", async ({ page, checkpoints, assertScope, switchTo, pendingC }) => {
    await page.evaluate(() => { window.oldASelection = window.__QA_N1__.handleProjectScopeChange; });
    assert.equal(await switchTo(workspaceB, projectB), true); await assertScope(workspaceB, projectB);
    const delayed = await pendingC(); checkpoints.beforeOldCallback = await snapshot(page);
    await page.evaluate(projectA => window.oldASelection(projectA), projectA); await settle(page); checkpoints.afterOldCallback = await snapshot(page);
    delayed.release(); checkpoints.newestSwitchCompleted = await page.evaluate(() => window.pendingC); await settle(page); checkpoints.final = await snapshot(page);
    assert.deepEqual(checkpoints.afterOldCallback, checkpoints.beforeOldCallback, "An old A callback must have no current navigation authority");
    assert.equal(checkpoints.newestSwitchCompleted, true); await assertScope(workspaceC, projectC);
  });
  await runCase("genuine current B project selection still cancels pending C and preserves explicit All", async ({ page, checkpoints, assertScope, switchTo, pendingC }) => {
    assert.equal(await switchTo(workspaceB, projectB), true); await assertScope(workspaceB, projectB);
    const delayed = await pendingC(); checkpoints.beforeCurrentSelection = await snapshot(page);
    await page.evaluate(() => window.__QA_N1__.handleProjectScopeChange("all")); await settle(page); checkpoints.afterCurrentSelection = await snapshot(page); await assertScope(workspaceB, null);
    delayed.release(); checkpoints.newestSwitchCompleted = await page.evaluate(() => window.pendingC); await settle(page); checkpoints.final = await snapshot(page);
    assert.equal(checkpoints.newestSwitchCompleted, false); await assertScope(workspaceB, null); assert.equal(checkpoints.final.switchStatus, "idle");
  });
  await runCase("old B selection cannot overwrite an already accepted C scope or URL", async ({ page, checkpoints, assertScope, switchTo }) => {
    assert.equal(await switchTo(workspaceB, projectB), true); await assertScope(workspaceB, projectB); await page.evaluate(() => { window.oldBSelection = window.__QA_N1__.handleProjectScopeChange; });
    assert.equal(await switchTo(workspaceC, projectC), true); await assertScope(workspaceC, projectC); checkpoints.beforeOldCallback = await snapshot(page);
    await page.evaluate(projectB => window.oldBSelection(projectB), projectB); await settle(page); checkpoints.afterOldCallback = await snapshot(page);
    assert.deepEqual(checkpoints.afterOldCallback, checkpoints.beforeOldCallback); await assertScope(workspaceC, projectC);
  });
  await runCase("callback from retired login identity cannot overwrite current same-workspace All URL", async ({ page, checkpoints, assertScope }) => {
    await page.evaluate(() => { window.oldIdentitySelection = window.__QA_N1__.handleProjectScopeChange; window.setN1Identity("SYNTHETIC-N1-user-B"); });
    await expect.poll(() => page.evaluate(() => window.__QA_N1__.sessionUserId)).toBe("SYNTHETIC-N1-user-B"); await settle(page); await assertScope(workspaceA, projectA);
    await page.evaluate(() => window.__QA_N1__.handleProjectScopeChange("all")); await settle(page); await assertScope(workspaceA, null); checkpoints.beforeOldCallback = await snapshot(page);
    await page.evaluate(projectA => window.oldIdentitySelection(projectA), projectA); await settle(page); checkpoints.afterOldCallback = await snapshot(page);
    assert.deepEqual(checkpoints.afterOldCallback, checkpoints.beforeOldCallback); await assertScope(workspaceA, null);
  });
} finally {
  await mkdir(output, { recursive: true });
  const summary = { capturedAt: new Date().toISOString(), baseline, baselineRevision, requestedRevision: requestedRevision ?? null, sourceRevision, testedHead: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), harnessSha256, sourceHashNormalization: "CRLF to LF", sourceHashes: { "src/components/crm-workspace.tsx": sha256(original), "src/lib/crm-core-request-guard.ts": sha256(guard) }, localOnly: true, actualCrmWorkspace: true, actualExistingHandlers: true, freshBrowserContextPerCase: true, reactStrictMode: true, unrelatedChildrenStubbed: true, syntheticHttp: true, serverAuthorizationStubbed: true, fullProjectFormPostSequenceExecuted: false, databaseIntegration: false, liveTest: false, fixtureContext: { productRole: "platform_admin", operatingModel: "novalure_internal", syntheticOnly: true }, totals: { cases: results.length, passed: results.filter(result => result.status === "PASS").length, failed: results.filter(result => result.status === "FAIL").length }, results };
  await writeFile(path.join(output, baseline ? "baseline-results.json" : "results.json"), JSON.stringify(summary, null, 2) + "\n"); console.log(JSON.stringify(summary.totals));
  await browser.close(); await new Promise(resolve => server.close(resolve));
}
if (results.some(result => result.status === "FAIL")) process.exitCode = 1;
