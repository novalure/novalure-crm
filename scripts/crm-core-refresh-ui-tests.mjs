import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";
import { chromium, expect } from "@playwright/test";
import { getPropertyDepartmentCopy } from "../src/lib/i18n.ts";

// Actual CrmWorkspace state, fetch/refresh/switch handlers and real property form.
// Only unrelated child panels and Next router primitives are stubbed. The test
// observer adds no production API or behavior; it exposes the mounted state and
// existing event handlers to control exact response ordering on loopback HTTP.
const workspaceA = "11111111-1111-4111-8111-111111111111";
const workspaceB = "44444444-4444-4444-8444-444444444444";
const projectA = "22222222-2222-4222-8222-222222222222";
const projectB = "55555555-5555-4555-8555-555555555555";
const propertyId = "33333333-3333-4333-8333-333333333333";
const copy = getPropertyDepartmentCopy("de");
const collections = ["brokerMandates", "buyerSearchProfiles", "calendarEvents", "contacts", "crmBots", "crmPipelineStages", "crmPipelines", "editorPreflightRuns", "leads", "deals", "funnelSteps", "funnels", "newsletterCampaigns", "newsletterSegments", "projectPipelinePermissions", "propertyBuildings", "propertyCostItems", "propertyDocuments", "propertyMedia", "propertyReservations", "propertyTextBlocks", "propertyUnits", "projects", "sellerListings", "tasks"];
function core(workspaceId, marker) {
  return { ...Object.fromEntries(collections.map(key => [key, []])), projects: [{ id: workspaceId === workspaceA ? projectA : projectB, workspaceId, name: marker, type: "Immobilien", status: "Aktiv", leads: 0, revenue: "—" }], moduleSources: Object.fromEntries(collections.map(key => [key, "database"])), source: "database", dailyQueue: { generatedAt: "2026-11-04T12:00:00Z", sections: [] } };
}
const workspace = id => ({ id, name: id === workspaceA ? "SYNTHETIC workspace A" : "SYNTHETIC workspace B", customerType: "hybrid_real_estate", operatingModel: "managed_by_novalure", teamStructure: "small_team", activeCalendarProvider: "none", setupState: {} });
const workspaces = [workspace(workspaceA), workspace(workspaceB)];
const sourcePath = path.resolve("src/components/crm-workspace.tsx");
const baseline = process.env.CRM_QA_CORE_REFRESH_BASELINE === "1";
const baselineRevision = "933a54660fa0be1368bd8b32dc077451cdb63bd6";
const original = (baseline ? execFileSync("git", ["show", `${baselineRevision}:src/components/crm-workspace.tsx`], { encoding: "utf8" }) : await readFile(sourcePath, "utf8")).replace(/\r\n/g, "\n");
const names = new Map([...original.matchAll(/import\s*\{([^{}]+)\}\s*from\s*["'](@\/components\/[^"']+)["']/g)].map(match => [match[2], match[1].split(",").map(item => item.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0]).filter(Boolean)]));
const observer = `window.__QA_CRM__={refreshCoreData,handleWorkspaceSwitch,handleSectionChange,activeWorkspace,liveCoreData,coreDataStatus,workspaceSwitchState,propertyDraftStore};`;
const needle = '  return (\n    <main className="crm-app';
assert.equal(original.includes(needle), true);
const compiled = await build({ stdin: { contents: `
import React from 'react';import{createRoot}from'react-dom/client';import{CrmWorkspace}from'./src/components/crm-workspace';
const root=createRoot(document.getElementById('root'));let user='SYNTHETIC-user-a';
const props={coreData:${JSON.stringify(core(workspaceA, "SYNTHETIC initial A"))},sessionWorkspace:${JSON.stringify(workspace(workspaceA))},sessionProductRole:'platform_admin',sessionRole:'admin',sessionUserName:'SYNTHETIC user',initialLanguage:'de'};
const render=()=>root.render(<React.StrictMode><CrmWorkspace {...props} sessionUserId={user}/></React.StrictMode>);window.setCrmUser=id=>{user=id;render()};window.unmountCrm=()=>root.unmount();render();`, loader: "tsx", resolveDir: process.cwd() }, bundle: true, write: false, format: "iife", platform: "browser", jsx: "automatic", define: { "process.env.NODE_ENV": '"test"' }, banner: { js: "var process={env:{NODE_ENV:'test'},browser:true};" }, logLevel: "silent", plugins: [{ name: "real-parent-observer", setup(builder) {
  builder.onLoad({ filter: /\.css$/ }, () => ({ contents: "export default {}", loader: "js" }));
  builder.onLoad({ filter: /crm-workspace\.tsx$/ }, args => args.path === sourcePath ? { contents: original.replace(needle, `  ${observer}\n${needle}`), loader: "tsx", resolveDir: path.dirname(sourcePath) } : undefined);
  builder.onResolve({ filter: /^@\/components\// }, args => args.importer === sourcePath && !["@/components/property-command-center", "@/components/crm-business-visibility"].includes(args.path) ? { path: args.path, namespace: "unrelated-child" } : undefined);
  builder.onLoad({ filter: /.*/, namespace: "unrelated-child" }, args => ({ contents: (names.get(args.path) ?? []).map(name => `export const ${name}=()=>${name.startsWith("get") ? "'SYNTHETIC label'" : "null"};`).join("\n"), loader: "js" }));
  builder.onResolve({ filter: /^next\/navigation$/ }, () => ({ path: "navigation", namespace: "next-test" }));
  builder.onResolve({ filter: /^next\/link$/ }, () => ({ path: "link", namespace: "next-test" }));
  builder.onLoad({ filter: /.*/, namespace: "next-test" }, args => ({ contents: args.path === "navigation" ? "export const useRouter=()=>({push(){},replace(){},refresh(){}});export const usePathname=()=>'/';export const useSearchParams=()=>new URLSearchParams();" : "import React from 'react';export default function Link({children,href}){return React.createElement('a',{href},children)}", loader: "js", resolveDir: process.cwd() }));
} }] });
const server = createServer((request, response) => {
  response.setHeader("content-type", request.url === "/bundle.js" ? "application/javascript" : "text/html");
  response.end(request.url === "/bundle.js" ? compiled.outputFiles[0].text : '<!doctype html><html><body><main id="root"></main><script src="/bundle.js"></script></body></html>');
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const browser = await chromium.launch({ channel: process.env.CRM_QA_BROWSER_CHANNEL || "chrome", headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage(), errors = [], results = [], coreRequests = [], propertyRequests = [];
let corePlans = [], propertyGate = null;
page.on("pageerror", error => errors.push(error.message));
await context.route("**/api/**", async route => {
  const request = route.request(), url = new URL(request.url());
  if (url.pathname === "/api/auth/csrf") return route.fulfill({ json: { csrfToken: "SYNTHETIC-csrf" } });
  if (url.pathname === "/api/workspaces") return route.fulfill({ json: { workspaces } });
  if (url.pathname === "/api/crm/core") {
    const workspaceId = url.searchParams.get("workspaceId") || workspaceA;
    coreRequests.push(workspaceId);
    const plan = corePlans.shift();
    if (plan) { assert.equal(workspaceId, plan.workspaceId); if (plan.gate) await plan.gate; if (plan.status) return route.fulfill({ status: plan.status, json: { error: "SYNTHETIC failure" } }); }
    return route.fulfill({ json: { data: core(workspaceId, plan?.marker || `SYNTHETIC default ${workspaceId}`) } });
  }
  if (url.pathname === "/api/crm/properties" && request.method() === "POST") {
    propertyRequests.push(request.postDataJSON());
    if (propertyGate) await propertyGate;
    return route.fulfill({ json: { persisted: true, data: { id: propertyId, workspaceId: workspaceA, projectId: projectA } } });
  }
  if (url.searchParams.get("operation") === "capabilities") return route.fulfill({ json: { workspaceId: url.searchParams.get("workspaceId"), capabilities: { canEditProperty: true, canReviewDocuments: true, canAssignInquiry: true } } });
  return route.fulfill({ json: { data: { drafts: [], projects: [], inquiries: [], assignments: [], candidates: [], counts: [] }, users: [], capabilities: {}, unreadCount: 0 } });
});
const snapshot = () => page.evaluate(() => ({ workspaceId: window.__QA_CRM__.activeWorkspace.id, marker: window.__QA_CRM__.liveCoreData.projects[0]?.name, status: window.__QA_CRM__.coreDataStatus, switchStatus: window.__QA_CRM__.workspaceSwitchState }));
async function open() {
  corePlans = []; coreRequests.length = 0; propertyRequests.length = 0; propertyGate = null;
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await expect.poll(() => page.evaluate(() => Boolean(window.__QA_CRM__))).toBe(true);
  await page.evaluate(async () => { await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); await window.__QA_CRM__.refreshCoreData(); });
  await expect.poll(async () => (await snapshot()).status).toBe("fresh"); coreRequests.length = 0;
}
const refresh = () => page.evaluate(() => { window.oldRefreshPromise = window.__QA_CRM__.refreshCoreData(); });
async function switchTo(workspaceId) {
  const result = await page.evaluate(({ workspaceId, workspaces }) => window.__QA_CRM__.handleWorkspaceSwitch(workspaceId, workspaces), { workspaceId, workspaces });
  if (result) await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  return result;
}
async function step(name, run) { await run(); results.push({ name, status: "PASS" }); console.log("PASS " + name); }
function gate() { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; }
try {
  await step(baseline ? "immutable baseline reproduces late property A data overwriting active workspace B" : "late confirmed property A save cannot refresh A into the real parent after B is active", async () => {
    await open(); await page.evaluate(() => window.__QA_CRM__.handleSectionChange("properties"));
    await expect.poll(async () => (await snapshot()).status).toBe("fresh");
    await page.getByRole("button", { name: "Objekt anlegen", exact: true }).click();
    await page.getByText("Erweiterte Direkterfassung mit allen Feldern", { exact: true }).click();
    const form = page.locator("form").filter({ has: page.getByText(copy.form.overview, { exact: true }) });
    await form.getByLabel(copy.form.title, { exact: true }).fill("SYNTHETIC delayed property A");
    await form.getByLabel(copy.form.address, { exact: true }).and(form.locator("input[required]")).fill("MUSTER A address");
    await form.getByRole("combobox", { name: copy.form.project, exact: true }).selectOption(projectA);
    const delayed = gate(); propertyGate = delayed.promise;
    await form.getByRole("button", { name: "Objekt speichern", exact: true }).click(); await expect.poll(() => propertyRequests.length).toBe(1);
    assert.equal(await switchTo(workspaceB), true);
    corePlans = [{ workspaceId: workspaceB, marker: "SYNTHETIC property callback must preserve B" }]; assert.equal(await page.evaluate(() => window.__QA_CRM__.refreshCoreData()), true);
    const requestCount = coreRequests.length; delayed.release(); propertyGate = null;
    // The scope transition can unmount the original form. Its async save still
    // awaits its captured real parent callback before releasing the shared lock.
    await expect.poll(() => page.evaluate(() => window.__QA_CRM__.propertyDraftStore.isMutationBusy())).toBe(false);
    if (baseline) {
      assert.equal(coreRequests.length, requestCount + 1);
      assert.equal((await snapshot()).workspaceId, workspaceB);
      assert.equal((await snapshot()).marker, `SYNTHETIC default ${workspaceA}`);
      return; // Immutable baseline reproduced A data replacing the B dataset.
    }
    await expect.poll(() => page.evaluate(() => window.__QA_CRM__.liveCoreData.projects[0]?.name)).toBe("SYNTHETIC property callback must preserve B");
    await expect.poll(() => page.evaluate(() => window.__QA_CRM__.coreDataStatus)).toBe("fresh");
    assert.equal(coreRequests.length, requestCount); assert.equal((await snapshot()).workspaceId, workspaceB);
  });
  if (!baseline) {
  await step("delayed A refresh cannot commit after the real parent switches and refreshes B", async () => {
    await open(); const delayed = gate(); corePlans = [{ workspaceId: workspaceA, marker: "SYNTHETIC stale A", gate: delayed.promise }];
    await refresh(); await expect.poll(() => coreRequests.length).toBe(1);
    const captured = await page.evaluate(() => { window.capturedARefresh = window.__QA_CRM__.refreshCoreData; return true; }); assert.equal(captured, true);
    assert.equal(await switchTo(workspaceB), true);
    corePlans = [{ workspaceId: workspaceB, marker: "SYNTHETIC latest B" }]; assert.equal(await page.evaluate(() => window.__QA_CRM__.refreshCoreData()), true);
    delayed.release(); assert.equal(await page.evaluate(() => window.oldRefreshPromise), false);
    assert.deepEqual(await snapshot(), { workspaceId: workspaceB, marker: "SYNTHETIC latest B", status: "fresh", switchStatus: "idle" });
    const count = coreRequests.length; assert.equal(await page.evaluate(() => window.capturedARefresh()), false); assert.equal(coreRequests.length, count);
  });
  await step("an older same-workspace failure cannot override the newest successful refresh", async () => {
    await open(); const delayed = gate(); corePlans = [{ workspaceId: workspaceA, status: 500, gate: delayed.promise }]; await refresh(); await expect.poll(() => coreRequests.length).toBe(1);
    corePlans = [{ workspaceId: workspaceA, marker: "SYNTHETIC newest A" }]; assert.equal(await page.evaluate(() => window.__QA_CRM__.refreshCoreData()), true);
    delayed.release(); assert.equal(await page.evaluate(() => window.oldRefreshPromise), false); assert.equal((await snapshot()).marker, "SYNTHETIC newest A"); assert.equal((await snapshot()).status, "fresh");
  });
  await step("a previous identity refresh cannot commit into the newly mounted identity session", async () => {
    await open(); const delayed = gate(); corePlans = [{ workspaceId: workspaceA, marker: "SYNTHETIC former user", gate: delayed.promise }]; await refresh(); await expect.poll(() => coreRequests.length).toBe(1);
    await page.evaluate(() => window.setCrmUser("SYNTHETIC-user-b"));
    corePlans = [{ workspaceId: workspaceA, marker: "SYNTHETIC current user" }]; assert.equal(await page.evaluate(() => window.__QA_CRM__.refreshCoreData()), true);
    delayed.release(); assert.equal(await page.evaluate(() => window.oldRefreshPromise), false); assert.equal((await snapshot()).marker, "SYNTHETIC current user");
  });
  await step("failed workspace switch keeps A authoritative and permits a fresh A retry", async () => {
    await open(); const previousMarker = (await snapshot()).marker;
    corePlans = [{ workspaceId: workspaceB, status: 500 }]; assert.equal(await switchTo(workspaceB), false);
    assert.equal((await snapshot()).workspaceId, workspaceA); assert.equal((await snapshot()).marker, previousMarker);
    corePlans = [{ workspaceId: workspaceA, marker: "SYNTHETIC A after failed switch" }]; assert.equal(await page.evaluate(() => window.__QA_CRM__.refreshCoreData()), true);
    assert.equal((await snapshot()).marker, "SYNTHETIC A after failed switch"); assert.equal((await snapshot()).status, "fresh");
  });
  }
  assert.deepEqual(errors, []);
} finally {
  const output = path.resolve(".npm-cache/qa/crm-core-refresh"); await mkdir(output, { recursive: true });
  await writeFile(path.join(output, baseline ? "baseline-results.json" : "results.json"), JSON.stringify({ localOnly: true, actualCrmWorkspace: true, unrelatedChildrenStubbed: true, syntheticHttp: true, databaseIntegration: false, baselineReproduction: baseline, baselineRevision: baseline ? baselineRevision : null, results, browserErrors: errors }, null, 2));
  await context.close(); await browser.close(); await new Promise(resolve => server.close(resolve));
}
