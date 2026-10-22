// LOCAL_UI_WITH_STUBBED_HTTP_NOT_AUTH_OR_PROVIDER_ACCEPTANCE
// Render the actual WebsiteIntegrationPanel and use its real csrfFetch client.
// Only loopback static files and synthetic fetch responses are permitted. This
// does not exercise authentication, API authorization, a database or a provider.
import assert from "node:assert/strict";
import { once } from "node:events";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium, expect as baseExpect } from "@playwright/test";

const classification = "LOCAL_UI_WITH_STUBBED_HTTP_NOT_AUTH_OR_PROVIDER_ACCEPTANCE";
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixtureRoot = resolve(process.env.WEBSITE_INTEGRATION_UI_FIXTURE_ROOT || tmpdir());
const expect = baseExpect.configure({ timeout: 10_000 });
const ids = {
  workspace: "synthetic-workspace", project: "synthetic-project", otherProject: "synthetic-other-project",
  bot: "synthetic-project-bot", otherBot: "synthetic-other-bot", companyBot: "synthetic-company-bot",
  integration: "synthetic-website-integration",
};
const siteKey = "nov_pk_AbCdEfGhIjKlMnOpQrStUvWxYz01_-23";
const initialTimestamp = "2026-10-21T12:00:00.000Z";
const updatedTimestamp = "2026-10-21T12:01:00.000Z";
const concurrentTimestamp = "2026-10-21T12:02:00.000Z";
const snapshot = {
  workspace: { id: ids.workspace, name: "SYNTHETIC company" }, available: true,
  areas: [], sources: [], assignments: [],
  projects: [{ id: ids.project, name: "SYNTHETIC Studio" }, { id: ids.otherProject, name: "SYNTHETIC other project" }],
  bots: [
    { id: ids.bot, projectId: ids.project, name: "SYNTHETIC Studio assistant" },
    { id: ids.otherBot, projectId: ids.otherProject, name: "SYNTHETIC other assistant" },
    { id: ids.companyBot, projectId: null, name: "SYNTHETIC company assistant" },
  ],
  entitlement: { enabled: true, limits: { maxAssistants: 5 } },
  usage: { sources: 0, storageBytes: 0, queriesThisMonth: 0, connectedAssistants: 1 },
  permissions: { canWrite: true, canPublish: true, canAssign: true },
};
const initialIntegration = {
  id: ids.integration, publicSiteKey: siteKey, projectId: ids.project, formId: null,
  integrationType: "website_chat", knowledgeAssistantId: ids.bot,
  status: "active", mode: "training", allowedOrigins: ["https://synthetic.invalid"],
  capabilities: ["chat.start", "chat.context", "chat.message"], updatedAt: initialTimestamp,
  widget: { brandName: "SYNTHETIC connected website", assistantName: "SYNTHETIC assistant", welcomeMessage: "SYNTHETIC greeting",
    primaryColor: "#111827", language: "en", widgetPosition: "bottom_right", chatEnabled: true },
  readiness: { ready: true, code: null, message: null, publishedSources: 6 },
};

// The component still obtains a new method/path-bound token through its real
// csrfFetch client. All tokens and server responses here are synthetic fixtures.
function installSyntheticFetch(scope, seed, timestamps) {
  const scenario = new URL(location.href).searchParams.get("scenario");
  if (scenario !== "manager" && scenario !== "pause-only") throw new Error("Unknown synthetic UI scenario");
  const state = {
    integrations: scenario === "manager" ? [] : [structuredClone(seed)],
    permissions: { canManage: scenario === "manager", canPause: true },
    calls: [], csrfRequests: [], unexpected: [], assignments: [], reads: 0,
  };
  const tokens = new Map();
  let conflictNext = false;
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fail = (message) => { state.unexpected.push(message); throw new Error(message); };
  const replace = (item) => { state.integrations = [item, ...state.integrations.filter(existing => existing.id !== item.id)]; };
  window.syntheticWebsiteUi = {
    inspect: () => structuredClone(state),
    conflictNext: () => { conflictNext = true; },
    assignKnowledge: (assistantId) => state.assignments.push(assistantId),
  };
  window.fetch = async (input, init = {}) => {
    const request = input instanceof Request ? input : null;
    const url = new URL(request ? request.url : String(input), location.href);
    const method = (init.method || request?.method || "GET").toUpperCase();
    if (url.origin !== location.origin) return fail("External fetch denied by synthetic fixture");
    if (url.pathname === "/api/auth/csrf" && method === "GET") {
      const scopeMethod = url.searchParams.get("method");
      if (!["POST", "PATCH"].includes(scopeMethod) || url.searchParams.get("path") !== "/api/integrations/websites") return fail("Unexpected CSRF scope");
      state.csrfRequests.push({ method: scopeMethod, path: url.searchParams.get("path") });
      const token = `SYNTHETIC-NOT-AUTHENTICATION-${state.csrfRequests.length}`;
      tokens.set(token, scopeMethod);
      return json({ csrfToken: token });
    }
    if (url.pathname !== "/api/integrations/websites" || url.searchParams.get("workspaceId") !== scope.workspace) return fail("Unexpected API or missing workspace scope");
    if (method === "GET") { state.reads += 1; return json({ integrations: state.integrations, permissions: state.permissions }); }
    if (method !== "POST" && method !== "PATCH") return fail("Unexpected mutation method");
    const token = new Headers(init.headers || request?.headers).get("x-novalure-csrf-token");
    if (!token || tokens.get(token) !== method || (init.credentials ?? request?.credentials) !== "same-origin") return fail("Missing fresh method-bound CSRF token or same-origin credentials");
    tokens.delete(token);
    const body = JSON.parse(init.body || await request?.text() || "{}");
    state.calls.push({ method, path: url.pathname, body });
    if (method === "POST") {
      if (!state.permissions.canManage || state.integrations.length || body.projectId !== scope.project || body.knowledgeAssistantId !== scope.bot || body.mode !== "training") return fail("Unexpected synthetic creation scope or mode");
      const integration = { ...seed, status: "test", ...body, id: scope.integration, updatedAt: timestamps.initial };
      replace(integration); return json({ integration }, 201);
    }
    const current = state.integrations.find(item => item.id === body.integrationId);
    if (!current || body.expectedUpdatedAt !== current.updatedAt) return fail("Missing expected integration revision");
    if (!state.permissions.canManage && (Object.keys(body).sort().join(",") !== "expectedUpdatedAt,integrationId,status" || body.status !== "disabled")) return fail("Pause-only fixture received a management mutation");
    if (conflictNext) {
      conflictNext = false;
      replace({ ...current, updatedAt: timestamps.concurrent, widget: { ...current.widget, brandName: "SYNTHETIC concurrent saved name" } });
      return json({ error: "SYNTHETIC concurrent update", code: "CONFLICT" }, 409);
    }
    const patch = { ...body };
    delete patch.integrationId;
    delete patch.expectedUpdatedAt;
    const integration = { ...current, ...patch, updatedAt: timestamps.updated };
    replace(integration); return json({ integration });
  };
}

await access(join(repository, "src/components/website-integration-panel.tsx"));
await mkdir(fixtureRoot, { recursive: true });
const fixtureDirectory = await mkdtemp(join(fixtureRoot, "website-integration-ui-"));
const pageErrors = [];
const blockedNetwork = [];
let server;
let browser;
try {
  const entry = `import { createRoot } from "react-dom/client";
    import { WebsiteIntegrationPanel } from ${JSON.stringify(join(repository, "src/components/website-integration-panel.tsx"))};
    (${installSyntheticFetch.toString()})(${JSON.stringify(ids)}, ${JSON.stringify(initialIntegration)}, ${JSON.stringify({ initial: initialTimestamp, updated: updatedTimestamp, concurrent: concurrentTimestamp })});
    const scopedPath = path => path + "?workspaceId=" + encodeURIComponent(${JSON.stringify(ids.workspace)});
    createRoot(document.getElementById("root")).render(<WebsiteIntegrationPanel snapshot={${JSON.stringify(snapshot)}} language="en" scopedPath={scopedPath} active={true} onAssignKnowledge={id => window.syntheticWebsiteUi.assignKnowledge(id)} />);`;
  await build({
    stdin: { contents: entry, loader: "tsx", resolveDir: repository, sourcefile: "synthetic-website-integration-ui.tsx" },
    absWorkingDir: repository, bundle: true, platform: "browser", format: "iife", jsx: "automatic",
    tsconfig: join(repository, "tsconfig.json"), define: { "process.env.NODE_ENV": '"production"' },
    outfile: join(fixtureDirectory, "fixture.js"), logLevel: "silent",
  });
  await writeFile(join(fixtureDirectory, "index.html"), `<!doctype html><html lang="en"><meta charset="utf-8"><title>Synthetic website connection UI regression</title><style>body{font:16px sans-serif;margin:24px}button,input,select,textarea{font:inherit;margin:4px;padding:8px}label{display:block}li{margin:16px 0;padding:12px;border:1px solid #aaa}</style><p>${classification}</p><div id="root"></div><script src="/fixture.js"></script></html>`);
  const [html, bundle] = await Promise.all([readFile(join(fixtureDirectory, "index.html")), readFile(join(fixtureDirectory, "fixture.js"))]);
  server = createServer((request, response) => {
    const pathname = new URL(request.url || "/", "http://127.0.0.1").pathname;
    if (pathname === "/" || pathname === "/fixture.js") {
      response.writeHead(200, { "content-type": pathname === "/" ? "text/html; charset=utf-8" : "text/javascript; charset=utf-8", "cache-control": "no-store" });
      response.end(pathname === "/" ? html : bundle);
    } else { response.writeHead(404); response.end(); }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    browser = await chromium.launch({ headless: true, args: ["--no-sandbox"], ...(process.env.CRM_QA_CHROMIUM_PATH ? { executablePath: process.env.CRM_QA_CHROMIUM_PATH } : {}) });
  } catch (cause) {
    throw new Error("An existing Playwright Chromium installation is required; this test does not install or download browsers.", { cause });
  }

  async function inspect(page) { return page.evaluate(() => window.syntheticWebsiteUi.inspect()); }
  async function inScenario(scenario, callback) {
    const context = await browser.newContext({ viewport: { width: 1365, height: 1000 }, serviceWorkers: "block" });
    await context.route("**/*", async route => {
      const url = new URL(route.request().url());
      if (url.origin === origin && ["/", "/fixture.js", "/favicon.ico"].includes(url.pathname)) return route.continue();
      blockedNetwork.push("Unexpected browser network request blocked"); return route.abort();
    });
    try {
      const page = await context.newPage();
      page.setDefaultTimeout(10_000);
      page.on("pageerror", error => pageErrors.push(error.message));
      await page.goto(`${origin}/?scenario=${scenario}`);
      await expect(page.getByRole("heading", { name: "Connect your website chat", exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "Refresh", exact: true })).toBeEnabled();
      await callback(page);
      const state = await inspect(page);
      assert.deepEqual(state.unexpected, [], "No unexpected synthetic API calls");
      assert.equal(state.csrfRequests.length, state.calls.length, "Each mutation obtains one fresh token using real csrfFetch");
      assert.deepEqual(state.csrfRequests, state.calls.map(({ method, path }) => ({ method, path })));
    } finally { await context.close(); }
  }
  const projectSelect = form => form.getByRole("combobox", { name: /^Project(?:\s|$)/ });
  const assistantSelect = form => form.getByRole("combobox", { name: /^Assistant(?:\s|$)/ });
  const originsInput = form => form.getByRole("textbox", { name: /^Allowed website addresses(?:\s|$)/ });
  const card = (page, name) => page.locator("li").filter({ has: page.getByRole("heading", { name, exact: true }) });

  await inScenario("manager", async page => {
    await page.getByRole("button", { name: "Connect a website", exact: true }).click();
    const form = page.locator("form");
    await expect(form).toBeVisible();
    assert.deepEqual(await assistantSelect(form).locator("option").evaluateAll(options => options.map(option => option.value)), ["", ids.companyBot]);
    await assistantSelect(form).selectOption(ids.companyBot);
    await projectSelect(form).selectOption(ids.project);
    await expect(assistantSelect(form)).toHaveValue("");
    assert.deepEqual(await assistantSelect(form).locator("option").evaluateAll(options => options.map(option => option.value)), ["", ids.bot]);
    await assistantSelect(form).selectOption(ids.bot);
    await page.getByRole("button", { name: "Assign webchat knowledge", exact: true }).click();
    assert.deepEqual((await inspect(page)).assignments, [ids.bot]);
    await originsInput(form).fill("https://synthetic.invalid\n\n https://www.synthetic.invalid ");
    await form.getByRole("textbox", { name: "Company name", exact: true }).fill("SYNTHETIC created website");
    await form.getByRole("textbox", { name: "Assistant display name", exact: true }).fill("SYNTHETIC Studio guide");
    await form.getByRole("textbox", { name: "Greeting", exact: true }).fill("SYNTHETIC welcome");
    await form.getByRole("combobox", { name: "Language", exact: true }).selectOption("de");
    await form.getByRole("combobox", { name: "Position", exact: true }).selectOption("bottom_left");
    await expect(form.getByRole("combobox", { name: "Operation", exact: true })).toHaveCount(0);
    await form.getByRole("button", { name: "Save connection", exact: true }).click();
    await expect(form).toHaveCount(0);
    let state = await inspect(page);
    assert.equal(state.calls.length, 1);
    assert.deepEqual(state.calls[0], { method: "POST", path: "/api/integrations/websites", body: {
      projectId: ids.project, knowledgeAssistantId: ids.bot, allowedOrigins: ["https://synthetic.invalid", "https://www.synthetic.invalid"], mode: "training",
      widget: { brandName: "SYNTHETIC created website", assistantName: "SYNTHETIC Studio guide", welcomeMessage: "SYNTHETIC welcome", primaryColor: "#111827", language: "de", widgetPosition: "bottom_left" },
    } });
    const created = card(page, "SYNTHETIC created website");
    await expect(created).toContainText("Test · Training");
    await created.locator("summary").click();
    await expect(created.getByRole("textbox", { name: "Embed code: https://synthetic.invalid", exact: true })).toHaveValue(`<script async src="https://www.novalure-crm.app/chat/widget.js" data-site-key="${siteKey}"></script>`);
    await expect(created.locator("script")).toHaveCount(0);

    await created.getByRole("button", { name: "Edit connection", exact: true }).click();
    await expect(projectSelect(form)).toBeDisabled();
    await expect(assistantSelect(form)).toHaveValue(ids.bot);
    await expect(form.getByRole("combobox", { name: "Language", exact: true })).toHaveValue("de");
    await expect(form.getByRole("combobox", { name: "Position", exact: true })).toHaveValue("bottom_left");
    await form.getByRole("textbox", { name: "Company name", exact: true }).fill("SYNTHETIC edited website");
    await form.getByRole("button", { name: "Save connection", exact: true }).click();
    await expect(form).toHaveCount(0);
    state = await inspect(page);
    assert.equal(state.calls.length, 2);
    assert.equal(state.calls[1].method, "PATCH");
    assert.deepEqual(state.calls[1].body, {
      integrationId: ids.integration, expectedUpdatedAt: initialTimestamp, status: "test", knowledgeAssistantId: ids.bot,
      allowedOrigins: ["https://synthetic.invalid", "https://www.synthetic.invalid"], mode: "training",
      widget: { ...state.calls[0].body.widget, brandName: "SYNTHETIC edited website" },
    });

    await card(page, "SYNTHETIC edited website").getByRole("button", { name: "Edit connection", exact: true }).click();
    await form.getByRole("textbox", { name: "Company name", exact: true }).fill("SYNTHETIC unsaved draft");
    await form.getByRole("textbox", { name: "Greeting", exact: true }).fill("SYNTHETIC unsaved greeting");
    await page.evaluate(() => window.syntheticWebsiteUi.conflictNext());
    await form.getByRole("button", { name: "Save connection", exact: true }).click();
    await expect(page.getByRole("alert")).toHaveText("The connection has changed. Refresh the list and reopen the editor.");
    await expect(form).toBeVisible();
    await expect(form.getByRole("textbox", { name: "Company name", exact: true })).toHaveValue("SYNTHETIC unsaved draft");
    await expect(form.getByRole("textbox", { name: "Greeting", exact: true })).toHaveValue("SYNTHETIC unsaved greeting");
    await expect(form.getByRole("button", { name: "Save connection", exact: true })).toBeEnabled();
    state = await inspect(page);
    assert.equal(state.calls.length, 3, "A CAS conflict does not silently retry or create another connection");
    assert.equal(state.calls[2].body.expectedUpdatedAt, updatedTimestamp, "The editor uses the last successful saved revision");
    assert.equal(state.calls[2].body.integrationId, ids.integration);
    assert.equal(state.integrations[0].updatedAt, concurrentTimestamp);
    assert.equal(state.integrations[0].widget.brandName, "SYNTHETIC concurrent saved name", "A conflict does not overwrite the concurrent saved state");
  });

  await inScenario("pause-only", async page => {
    await expect(page.getByRole("button", { name: "Connect a website", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Edit connection", exact: true })).toHaveCount(0);
    await expect(page.locator("form")).toHaveCount(0);
    const connected = card(page, "SYNTHETIC connected website");
    await connected.getByRole("button", { name: "Pause", exact: true }).click();
    await expect(connected).toContainText("Paused · Training");
    await expect(page.getByRole("button", { name: "Pause", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Connect a website", exact: true })).toHaveCount(0);
    const state = await inspect(page);
    assert.deepEqual(state.permissions, { canManage: false, canPause: true });
    assert.deepEqual(state.calls, [{ method: "PATCH", path: "/api/integrations/websites", body: {
      integrationId: ids.integration, expectedUpdatedAt: initialTimestamp, status: "disabled",
    } }]);
    assert.deepEqual(state.integrations[0].widget, initialIntegration.widget);
    assert.deepEqual(state.integrations[0].allowedOrigins, initialIntegration.allowedOrigins);
    assert.equal(state.integrations[0].knowledgeAssistantId, ids.bot);
    assert.equal(state.integrations[0].mode, "training");
  });
  assert.deepEqual(pageErrors, [], "No browser page errors");
  assert.deepEqual(blockedNetwork, [], "All browser HTTP stays within the static loopback fixture");
  console.log("PASS website connection customer flow: scoped training create, public script, CAS edit/conflict draft, pause-only permission");
  console.log(JSON.stringify({ classification, passed: 1, failed: 0, scenarios: 2, browserPageErrors: pageErrors.length, unexpectedBrowserNetworkRequests: blockedNetwork.length,
    limitations: ["Synthetic fetch responses only", "No Next server or actual API routes", "No authentication, database, external website, model or provider acceptance"] }));
} finally {
  if (browser) await browser.close();
  if (server) await new Promise((resolveClose, rejectClose) => server.close(error => error ? rejectClose(error) : resolveClose()));
  await rm(fixtureDirectory, { recursive: true, force: true });
}
