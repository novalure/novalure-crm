import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";
import { chromium, expect } from "@playwright/test";

// Actual project dialog, fields, Save click, POST and Close click. All HTTP and
// authority are synthetic. Each case owns a fresh browser context; one project
// POST per independent A/B command, with no replay of an unresolved command.
const baselineRevision = "a9df44d5900f25659c7a2f153277eaa2755f9bf7";
const requestedRevision = process.env.CRM_QA_PROJECT_SAVE_REVISION;
if (requestedRevision) assert.match(requestedRevision, /^[a-f0-9]{7,40}$/i);
const baseline = !requestedRevision && process.env.CRM_QA_PROJECT_SAVE_BASELINE === "1";
const sourceRevision = requestedRevision ? execFileSync("git", ["rev-parse", "--verify", `${requestedRevision}^{commit}`], { encoding: "utf8" }).trim() : baseline ? baselineRevision : null;
const output = path.resolve(process.env.CRM_QA_PROJECT_SAVE_OUTPUT || "qa/qa001-project-save-20261105");
assert.ok(!output.startsWith("\\\\"));
const sourcePath = path.resolve("src/components/crm-workspace.tsx"), guardPath = path.resolve("src/lib/crm-core-request-guard.ts");
const readSource = async relative => (sourceRevision ? execFileSync("git", ["show", `${sourceRevision}:${relative}`], { encoding: "utf8" }) : await readFile(relative, "utf8")).replace(/\r\n/g, "\n");
const runtimePaths = ["src/components/crm-workspace.tsx", "src/lib/crm-core-request-guard.ts", "src/lib/security/crm-sales-client.ts", "src/lib/security/crm-safe-client.ts", "src/lib/security/csrf-client.ts"];
const runtimeSources = new Map(await Promise.all(runtimePaths.map(async relative => [relative, await readSource(relative)])));
const original = runtimeSources.get("src/components/crm-workspace.tsx"), guard = runtimeSources.get("src/lib/crm-core-request-guard.ts");
const sha256 = value => createHash("sha256").update(value).digest("hex");
const harnessSha256 = sha256(await readFile(new URL(import.meta.url), "utf8"));
const workspaceA = "11111111-1111-4111-8111-111111111111", workspaceB = "44444444-4444-4444-8444-444444444444";
const projectA = "22222222-2222-4222-8222-222222222222", projectB = "55555555-5555-4555-8555-555555555555", createdProjectId = "99999999-9999-4999-8999-999999999999";
const createdBProjectId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const baseProject = workspaceId => ({ id: workspaceId === workspaceA ? projectA : projectB, workspaceId, name: `SYNTHETIC initial ${workspaceId}`, type: "Immobilien", status: "Aktiv", leads: 0, revenue: "—" });
const collections = ["brokerMandates", "buyerSearchProfiles", "calendarEvents", "contacts", "crmBots", "crmPipelineStages", "crmPipelines", "editorPreflightRuns", "leads", "deals", "funnelSteps", "funnels", "newsletterCampaigns", "newsletterSegments", "projectPipelinePermissions", "propertyBuildings", "propertyCostItems", "propertyDocuments", "propertyMedia", "propertyReservations", "propertyTextBlocks", "propertyUnits", "projects", "sellerListings", "tasks"];
const core = (workspaceId, added = []) => ({ ...Object.fromEntries(collections.map(key => [key, []])), projects: [baseProject(workspaceId), ...added.filter(project => project.workspaceId === workspaceId)], moduleSources: Object.fromEntries(collections.map(key => [key, "database"])), source: "database", dailyQueue: { generatedAt: "2026-11-05T12:00:00Z", sections: [] } });
const workspace = (id, activeProjects = 1) => ({ id, name: `SYNTHETIC workspace ${id}`, activeProjects, customerType: "hybrid_real_estate", operatingModel: "novalure_internal", teamStructure: "small_team", activeCalendarProvider: "none", setupState: {} });
const names = new Map([...original.matchAll(/import\s*\{([^{}]+)\}\s*from\s*["'](@\/components\/[^"']+)["']/g)].map(match => [match[2], match[1].split(",").map(item => item.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0]).filter(Boolean)]));
const observed = "({identity:sessionUserId,workspaceId:activeWorkspace.id,activeProjects:activeWorkspace.activeProjects,projects:liveCoreData.projects.map(({id,workspaceId,name})=>({id,workspaceId,name})),scope:crmScope,section:visibleActiveSection,draft:projectDraft,notice:projectNotice,noticeTone:projectNoticeTone,saving:isProjectSaving,modal:actionModal,url:location.pathname+location.search+location.hash})";
const observer = `window.__QA_PROJECT_SAVE__={handleWorkspaceSwitch,sessionUserId,availableWorkspaces,read:()=>${observed}};qaProjectLayoutEffect(()=>{(window.__QA_PROJECT_COMMITS__??=[]).push(${observed})});`;
const needle = '  return (\n    <main className="crm-app'; assert.ok(original.includes(needle));
assert.ok(original.includes("onClick={handlePrepareProject}"));
const observedSource = original.replace("onClick={handlePrepareProject}", "onClick={()=>{const promise=handlePrepareProject();(window.__QA_PROJECT_SAVE_PROMISES__??=[]).push(promise)}}");
const compiled = await build({ stdin: { contents: `import React from'react';import{createRoot}from'react-dom/client';import{CrmWorkspace}from'./src/components/crm-workspace';const root=createRoot(document.getElementById('root'));let user='SYNTHETIC-project-user-A';const props={coreData:${JSON.stringify(core(workspaceA))},sessionWorkspace:${JSON.stringify(workspace(workspaceA))},sessionProductRole:'platform_admin',sessionRole:'admin',sessionUserName:'SYNTHETIC user',initialLanguage:'de'};const render=()=>root.render(<React.StrictMode><CrmWorkspace key={user} {...props} sessionUserId={user}/></React.StrictMode>);window.setProjectTestIdentity=value=>{user=value;render()};render();`, loader: "tsx", resolveDir: process.cwd() }, bundle: true, write: false, format: "iife", platform: "browser", jsx: "automatic", define: { "process.env.NODE_ENV": '"test"' }, banner: { js: "var process={env:{NODE_ENV:'test'},browser:true};" }, logLevel: "silent", plugins: [{ name: "project-save-real-dialog", setup(builder) {
  builder.onLoad({ filter: /\.css$/ }, () => ({ contents: "export default {}", loader: "js" }));
  builder.onLoad({ filter: /crm-workspace\.tsx$/ }, args => args.path === sourcePath ? { contents: observedSource.replace('"use client";', '"use client";\nimport{useLayoutEffect as qaProjectLayoutEffect}from"react";').replace(needle, `  ${observer}\n${needle}`), loader: "tsx", resolveDir: path.dirname(sourcePath) } : undefined);
  builder.onLoad({ filter: /crm-core-request-guard\.ts$/ }, args => args.path === guardPath ? { contents: guard, loader: "ts", resolveDir: path.dirname(guardPath) } : undefined);
  builder.onLoad({ filter: /(?:crm-sales-client|crm-safe-client|csrf-client)\.ts$/ }, args => { const relative = path.relative(process.cwd(), args.path).replaceAll(path.sep, "/"); return runtimeSources.has(relative) ? { contents: runtimeSources.get(relative), loader: "ts", resolveDir: path.dirname(args.path) } : undefined; });
  builder.onResolve({ filter: /^@\/components\// }, args => args.importer === sourcePath && args.path !== "@/components/crm-business-visibility" ? { path: args.path, namespace: "unrelated-child" } : undefined);
  builder.onLoad({ filter: /.*/, namespace: "unrelated-child" }, args => ({ contents: (names.get(args.path) ?? []).map(name => `export const ${name}=()=>${name.startsWith("get") ? "'SYNTHETIC label'" : "null"};`).join("\n"), loader: "js" }));
  builder.onResolve({ filter: /^next\/navigation$/ }, () => ({ path: "navigation", namespace: "next-test" }));
  builder.onResolve({ filter: /^next\/link$/ }, () => ({ path: "link", namespace: "next-test" }));
  builder.onLoad({ filter: /.*/, namespace: "next-test" }, args => ({ contents: args.path === "navigation" ? "export const useRouter=()=>({push(){},replace(){},refresh(){}});export const usePathname=()=>'/';export const useSearchParams=()=>new URLSearchParams();" : "import React from'react';export default function Link({children,href}){return React.createElement('a',{href},children)}", loader: "js", resolveDir: process.cwd() }));
} }] });
const server = createServer((request, response) => { response.setHeader("content-type", request.url === "/bundle.js" ? "application/javascript" : "text/html"); response.end(request.url === "/bundle.js" ? compiled.outputFiles[0].text : '<!doctype html><html><body><div id="root"></div><script src="/bundle.js"></script></body></html>'); });
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve)); const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ channel: process.env.CRM_QA_BROWSER_CHANNEL || "chrome", headless: true }); const results = [];
const settle = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve)))));
const snapshot = page => page.evaluate(() => window.__QA_PROJECT_SAVE__.read());
async function runCase(transition, outcome, positive = false, mode = "normal") {
  const name = mode === "wrong200" ? "wrong-workspace 200 remains unconfirmed and identical UI retry performs only reconcile" : mode === "overlap" ? "old uncertain A finally cannot release newer B saving; reconcile never repeats create" : mode === "refresh" ? "continuation retired during its own core refresh cannot navigate after dialog reopen" : positive ? `current project ${outcome} remains functional` : `late project ${outcome} after ${transition} cannot overwrite current dialog/navigation/data`;
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } }); await context.addInitScript(() => localStorage.setItem("novalure-crm-navigation-preset-v1", "realEstateBroker"));
  const page = await context.newPage(); page.setDefaultTimeout(3000); page.setDefaultNavigationTimeout(15000);
  const requests = [], posts = [], reconciliations = [], browserErrors = [], blockedNetwork = [], checkpoints = {}, persisted = []; let releasePost, releaseBPost, releaseRefresh, delivered = false, deliveredB = false, refreshSeen = false;
  const postGate = new Promise(resolve => { releasePost = resolve; });
  const bPostGate = new Promise(resolve => { releaseBPost = resolve; }), refreshGate = new Promise(resolve => { releaseRefresh = resolve; });
  page.on("pageerror", error => browserErrors.push(error.message));
  await context.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin) { blockedNetwork.push({ origin: url.origin, method: request.method() }); return route.abort("blockedbyclient"); }
    if (!url.pathname.startsWith("/api/")) return route.continue();
    requests.push({ path: url.pathname, method: request.method(), workspaceId: url.searchParams.get("workspaceId") });
    if (url.pathname === "/api/auth/csrf") return route.fulfill({ json: { csrfToken: "SYNTHETIC-csrf" } });
    if (url.pathname === "/api/workspaces") return route.fulfill({ json: { workspaces: [workspaceA, workspaceB].map(id => workspace(id, 1 + persisted.filter(project => project.workspaceId === id).length)) } });
    if (url.pathname === "/api/crm/core") { const id = url.searchParams.get("workspaceId") || workspaceA; if (mode === "refresh" && persisted.length && id === workspaceA && !refreshSeen) { refreshSeen = true; await refreshGate; } return route.fulfill({ json: { activeWorkspaceId: id, data: core(id, persisted) } }); }
    if (url.pathname === "/api/crm/projects" && request.method() === "POST") {
      const body = request.postDataJSON(), isB = url.searchParams.get("workspaceId") === workspaceB; posts.push({ workspaceId: url.searchParams.get("workspaceId"), body, idempotencyKey: request.headers()["idempotency-key"] });
      await (isB ? bPostGate : postGate);
      if (!isB && outcome === "unknown") { await route.abort("failed"); delivered = true; return; }
      if (mode === "wrong200") { const project = { ...body.project, workspaceId: workspaceB, id: createdBProjectId, version: 1, leads: 0, revenue: "—" }; await route.fulfill({ json: { persisted: true, project } }); }
      else if (outcome === "success" || isB) { const project = { ...body.project, id: isB ? createdBProjectId : createdProjectId, version: 1, leads: 0, revenue: "—" }; persisted.push(project); await route.fulfill({ json: { persisted: true, project } }); }
      else await route.fulfill({ status: 400, json: { error: "SYNTHETIC definitive project rejection" } });
      if (isB) deliveredB = true; else delivered = true; return;
    }
    if (url.pathname === "/api/crm/commands/reconcile" && request.method() === "POST") { reconciliations.push({ workspaceId: url.searchParams.get("workspaceId"), body: request.postDataJSON(), idempotencyKey: request.headers()["idempotency-key"] }); return route.fulfill({ json: { status: "UNKNOWN" } }); }
    return route.fulfill({ json: { data: { drafts: [], projects: [], inquiries: [], assignments: [], candidates: [], counts: [] }, users: [], capabilities: {}, unreadCount: 0 } });
  });
  const dialog = () => page.getByRole("dialog", { name: "Projekt-Wizard", exact: true });
  const openAndFill = async (name, notes) => { await page.getByRole("button", { name: "Neues Projekt", exact: true }).last().click(); await expect(dialog()).toBeVisible(); await dialog().getByLabel("Projektname", { exact: true }).fill(name); await dialog().locator("select").filter({ has: page.locator('option[value="pipeline_standard_sales"]') }).selectOption("pipeline_standard_sales"); await dialog().getByPlaceholder("Zielgruppe, Startdatum, Besonderheiten", { exact: true }).fill(notes); };
  const switchTo = async (workspaceId, projectId) => { const workspaces = [workspace(workspaceA), workspace(workspaceB)]; assert.equal(await page.evaluate(({ workspaceId, projectId, workspaces }) => window.__QA_PROJECT_SAVE__.handleWorkspaceSwitch(workspaceId, workspaces, projectId), { workspaceId, projectId, workspaces }), true); await settle(page); };
  try {
    await page.goto(`${origin}/?workspaceId=${workspaceA}&projectId=${projectA}#properties`, { waitUntil: "domcontentloaded", timeout: 15000 }); await expect.poll(() => page.evaluate(() => window.__QA_PROJECT_SAVE__?.availableWorkspaces.length)).toBe(2); await settle(page);
    await openAndFill("SYNTHETIC submitted project A", "SYNTHETIC submitted notes A"); await dialog().getByRole("button", { name: "Projekt anlegen", exact: true }).click(); await expect.poll(() => posts.length).toBe(1); checkpoints.submitted = await snapshot(page); assert.equal(checkpoints.submitted.saving, true);
    if (mode === "refresh") {
      releasePost(); await expect.poll(() => refreshSeen).toBe(true); checkpoints.duringOwnRefresh = await snapshot(page);
      await dialog().getByRole("button", { name: "Schließen", exact: true }).click(); await expect(dialog()).toHaveCount(0); await openAndFill("SYNTHETIC newer unsaved input", "SYNTHETIC newer unsaved notes");
    } else if (!positive) {
      await dialog().getByRole("button", { name: "Schließen", exact: true }).click(); await expect(dialog()).toHaveCount(0); checkpoints.closedDuringPost = await snapshot(page);
      if (transition === "A-to-B" || transition === "A-to-B-to-A") { await switchTo(workspaceB, projectB); if (transition === "A-to-B-to-A") await switchTo(workspaceA, projectA); }
      else { await page.evaluate(() => window.setProjectTestIdentity("SYNTHETIC-project-user-B")); await expect.poll(() => page.evaluate(() => window.__QA_PROJECT_SAVE__.sessionUserId)).toBe("SYNTHETIC-project-user-B"); await settle(page); }
      await openAndFill("SYNTHETIC newer unsaved input", "SYNTHETIC newer unsaved notes");
    }
    if (mode === "overlap") {
      const save = dialog().getByRole("button", { name: /^(Projekt anlegen|Projekt wird gespeichert)/ }); checkpoints.beforeDistinctBSubmit = await snapshot(page); checkpoints.overlapPrerequisiteBlocked = await save.isDisabled(); await expect(save).toBeEnabled({ timeout: 1000 }); await save.click(); await expect.poll(() => posts.length).toBe(2); checkpoints.beforeOldResponse = await snapshot(page); assert.equal(checkpoints.beforeOldResponse.saving, true);
      releasePost(); await page.evaluate(() => window.__QA_PROJECT_SAVE_PROMISES__[0]); await settle(page); checkpoints.afterOldFinally = await snapshot(page);
      assert.deepEqual(checkpoints.afterOldFinally, checkpoints.beforeOldResponse, "Old A finally must not change newer B saving, inputs, notice or navigation");
      assert.equal(posts.filter(post => post.workspaceId === workspaceA).length, 1); assert.equal(posts.filter(post => post.workspaceId === workspaceB).length, 1); assert.equal(reconciliations.length, 1); assert.equal(reconciliations[0].workspaceId, workspaceA); assert.equal(reconciliations[0].idempotencyKey, posts[0].idempotencyKey); assert.notEqual(posts[0].idempotencyKey, posts[1].idempotencyKey);
      releaseBPost(); await page.evaluate(() => window.__QA_PROJECT_SAVE_PROMISES__[1]); await expect.poll(() => deliveredB).toBe(true); await settle(page); checkpoints.afterBSuccess = await snapshot(page); assert.equal(checkpoints.afterBSuccess.saving, false); assert.equal(checkpoints.afterBSuccess.workspaceId, workspaceB); assert.equal(checkpoints.afterBSuccess.scope.projectId, createdBProjectId); assert.ok(checkpoints.afterBSuccess.projects.some(project => project.id === createdBProjectId));
      assert.deepEqual(browserErrors, []); assert.deepEqual(blockedNetwork, []); results.push({ name, transition, outcome, mode, status: "PASS", freshContext: true, checkpoints, posts, reconciliations, requests, browserErrors, blockedNetwork }); console.log(`PASS ${name}`); return;
    }
    checkpoints.beforeResponse = await snapshot(page); const commitStart = await page.evaluate(() => window.__QA_PROJECT_COMMITS__.length);
    releasePost(); releaseRefresh(); await page.evaluate(() => window.__QA_PROJECT_SAVE_PROMISES__[0]); await expect.poll(() => delivered).toBe(true); await settle(page); await expect.poll(async () => (await snapshot(page)).saving).toBe(false); await settle(page);
    checkpoints.afterResponse = await snapshot(page); checkpoints.responseCommits = await page.evaluate(start => window.__QA_PROJECT_COMMITS__.slice(start), commitStart); checkpoints.dialogCount = await dialog().count();
    assert.equal(posts.length, 1); assert.equal(posts[0].workspaceId, workspaceA); assert.equal(posts[0].body.project.workspaceId, workspaceA);
    if (mode === "wrong200") {
      assert.equal(checkpoints.afterResponse.noticeTone, "error"); assert.ok(checkpoints.afterResponse.notice.includes("CRM_RESULT_UNKNOWN")); assert.deepEqual(checkpoints.afterResponse.draft, checkpoints.beforeResponse.draft); assert.equal(checkpoints.afterResponse.url, checkpoints.beforeResponse.url); assert.equal(checkpoints.afterResponse.scope.projectId, projectA); assert.deepEqual(checkpoints.afterResponse.projects, checkpoints.beforeResponse.projects); assert.equal(reconciliations.length, 1);
      await dialog().getByRole("button", { name: "Projekt anlegen", exact: true }).click(); await page.evaluate(() => window.__QA_PROJECT_SAVE_PROMISES__[1]); await settle(page); checkpoints.afterIdenticalRetry = await snapshot(page);
      assert.equal(posts.length, 1); assert.equal(reconciliations.length, 2); assert.ok(reconciliations.every(item => item.idempotencyKey === posts[0].idempotencyKey && item.workspaceId === workspaceA)); assert.ok(reconciliations.every(item => JSON.stringify(item.body.body) === JSON.stringify(posts[0].body))); assert.deepEqual(checkpoints.afterIdenticalRetry, checkpoints.afterResponse);
    } else if (positive) {
      assert.equal(checkpoints.afterResponse.saving, false);
      if (outcome === "success") { assert.equal(checkpoints.afterResponse.scope.projectId, createdProjectId); assert.ok(checkpoints.afterResponse.projects.some(project => project.id === createdProjectId)); assert.equal(checkpoints.afterResponse.section, "dashboard"); assert.equal(checkpoints.afterResponse.draft.name, ""); assert.equal(checkpoints.afterResponse.draft.notes, ""); assert.equal(checkpoints.afterResponse.noticeTone, "success"); assert.ok(checkpoints.afterResponse.notice.includes("SYNTHETIC submitted project A")); }
      else { assert.deepEqual(checkpoints.afterResponse.draft, checkpoints.beforeResponse.draft); assert.equal(checkpoints.afterResponse.notice, "SYNTHETIC definitive project rejection"); assert.equal(checkpoints.afterResponse.noticeTone, "error"); assert.equal(checkpoints.afterResponse.url, checkpoints.beforeResponse.url); }
    } else if (mode === "refresh") {
      for (const key of ["draft", "url", "section", "notice", "noticeTone", "modal"]) assert.deepEqual(checkpoints.afterResponse[key], checkpoints.beforeResponse[key], `Retired post-refresh continuation cannot alter ${key}`);
      assert.ok(checkpoints.afterResponse.projects.some(project => project.id === createdProjectId)); assert.equal(posts.length, 1);
    } else {
      const before = { ...checkpoints.beforeResponse, saving: false }, after = checkpoints.afterResponse;
      assert.deepEqual(after, before, "Old save completion must not alter the current form, scope, URL, projects, counters or notices");
      assert.equal(checkpoints.dialogCount, 1); await expect(dialog().getByLabel("Projektname", { exact: true })).toHaveValue("SYNTHETIC newer unsaved input"); await expect(dialog().getByPlaceholder("Zielgruppe, Startdatum, Besonderheiten", { exact: true })).toHaveValue("SYNTHETIC newer unsaved notes");
      assert.ok(checkpoints.responseCommits.every(commit => JSON.stringify(commit.projects) === JSON.stringify(before.projects) && commit.activeProjects === before.activeProjects), "No transient old project/counter commit may enter the new context");
    }
    assert.deepEqual(browserErrors, []); assert.deepEqual(blockedNetwork, []); results.push({ name, transition, outcome, mode, positive, status: "PASS", freshContext: true, checkpoints, posts, reconciliations, requests, browserErrors, blockedNetwork }); console.log(`PASS ${name}`);
  } catch (error) { checkpoints.failure = await snapshot(page).catch(() => null); results.push({ name, transition, outcome, mode, positive, status: "FAIL", error: String(error.message ?? error), freshContext: true, checkpoints, posts, reconciliations, requests, browserErrors, blockedNetwork }); console.log(`FAIL ${name}: ${String(error.message ?? error).split("\n")[0]}`); }
  finally { releasePost(); releaseBPost(); releaseRefresh(); await context.close(); }
}
try {
  await runCase("A-to-B", "success");
  if (process.env.CRM_QA_PROJECT_SAVE_SMOKE !== "1") { await runCase("A-to-B", "error"); for (const transition of ["A-to-B-to-A", "identity-change"]) for (const outcome of ["success", "error"]) await runCase(transition, outcome); for (const outcome of ["success", "error"]) await runCase("current", outcome, true); await runCase("A-to-B", "unknown", false, "overlap"); await runCase("current-close-reopen", "success", false, "refresh"); await runCase("current", "wrong200", true, "wrong200"); }
} finally {
  await mkdir(output, { recursive: true }); const summary = { capturedAt: new Date().toISOString(), baselineRevision, baseline, sourceRevision, requestedRevision: requestedRevision ?? null, harnessSha256, sourceHashes: Object.fromEntries([...runtimeSources].map(([relative, contents]) => [relative, sha256(contents)])), sourceHashNormalization: "CRLF to LF", actualCrmWorkspace: true, actualInlineModalAndForm: true, actualUiSaveAndClose: true, actualSaveHandlerPromiseObserved: true, freshBrowserContextPerCase: true, readOnlyStateAndCommitObserver: true, syntheticHttp: true, authorizationStubbed: true, databaseIntegration: false, liveTest: false, noProjectPostReplay: true, totals: { cases: results.length, passed: results.filter(result => result.status === "PASS").length, failed: results.filter(result => result.status === "FAIL").length }, results };
  await writeFile(path.join(output, baseline ? "baseline-results.json" : "results.json"), JSON.stringify(summary, null, 2) + "\n"); console.log(JSON.stringify(summary.totals)); await browser.close(); await new Promise(resolve => server.close(resolve));
}
if (results.some(result => result.status === "FAIL")) process.exitCode = 1;
