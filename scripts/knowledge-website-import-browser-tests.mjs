// LOCAL_UI_WITH_STUBBED_HTTP_NOT_AUTH_OR_PROVIDER_ACCEPTANCE
// Exercise the actual client component with synthetic fetch responses. This does
// not start Next, connect a database, authenticate a user, or fetch a website.
// Requires the repository's existing esbuild, Playwright and Chromium install.
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
const fixtureRoot = resolve(process.env.KNOWLEDGE_WEBSITE_UI_FIXTURE_ROOT || tmpdir());
const expect = baseExpect.configure({ timeout: 10_000 });
const ids = { workspace: "synthetic-workspace", project: "synthetic-project", area: "synthetic-area", bot: "synthetic-bot" };
const readyContent = "SYNTHETIC website body returned by the initial import. Office hours are 09:00 to 17:00.";
const retryContent = "SYNTHETIC website body returned by retry on the saved source.";
const timestamp = "2026-10-21T12:00:00.000Z";

function source(id, name, { content = "", revision = 1, published = false, structuredData = {} } = {}) {
  const versionId = `${id}-version-${revision}`;
  return {
    id, areaId: ids.area, projectId: ids.project, name, type: "url", status: published ? "published" : "draft", revision,
    approvedVersionId: published ? versionId : null, draftVersionId: published ? null : versionId, archivedAt: null,
    version: {
      id: versionId, sourceId: id, version: revision, name, content, structuredData,
      url: "https://synthetic.invalid/knowledge", mediaAssetId: null, status: published ? "approved" : "draft",
      createdAt: timestamp, approvedAt: published ? timestamp : null, processingStatus: "manual",
      processingMessage: null, processingFormat: null, provenance: { kind: "website_import" },
    },
  };
}

function snapshot(sources = []) {
  return {
    workspace: { id: ids.workspace, name: "SYNTHETIC company" }, available: true,
    areas: [{ id: ids.area, name: "SYNTHETIC company knowledge", kind: "company", projectId: null, description: "", archivedAt: null }],
    sources, projects: [{ id: ids.project, name: "SYNTHETIC project" }],
    bots: [{ id: ids.bot, name: "SYNTHETIC assistant", projectId: ids.project }],
    assignments: [{ botId: ids.bot, channel: "webchat", areaId: ids.area }],
    entitlement: {
      enabled: true, maxSources: 20, maxStorageBytes: 10_485_760, maxQueriesPerMonth: 50,
      contractReference: "SYNTHETIC-LOCAL-ONLY", allowedMonitoringIntervals: ["manual", "daily", "weekly", "monthly"],
      features: { websiteImport: true, monitoring: true, advancedMaintenance: true, webchatAccess: true, voiceAccess: true },
      limits: { maxAreas: 10, maxWebsites: 10, maxScansPerMonth: 20, maxUsers: 5, maxAssistants: 5 },
    },
    usage: { sources: sources.length, storageBytes: 0, queriesThisMonth: 0 },
    permissions: { canWrite: true, canPublish: true, canAssign: true },
  };
}

// Installed in this isolated fixture page only. Requests still pass through the
// production csrfFetch client, which obtains a deliberately synthetic CSRF token.
// Session storage only persists synthetic stub state across an explicit reload.
function installSyntheticFetch(fixtures, scope, content, retriedContent) {
  const mode = new URL(location.href).searchParams.get("scenario");
  if (!Object.hasOwn(fixtures, mode)) throw new Error("Unknown synthetic UI scenario");
  const storageKey = `synthetic-knowledge-ui:${mode}`;
  let state = JSON.parse(sessionStorage.getItem(storageKey) || "null") || {
    snapshot: fixtures[mode], calls: [], csrfRequests: 0, unexpected: [], snapshotReads: 0,
    snapshotFailuresRemaining: 0, snapshotFailuresObserved: 0,
  };
  const save = () => sessionStorage.setItem(storageKey, JSON.stringify(state));
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fail = (message) => {
    state.unexpected.push(message); save();
    throw new Error(message);
  };
  const replace = (item) => {
    state.snapshot.sources = [item, ...state.snapshot.sources.filter((existing) => existing.id !== item.id)];
    state.snapshot.usage.sources = state.snapshot.sources.length;
  };
  window.syntheticKnowledgeUi = { inspect: () => structuredClone(state) };
  window.fetch = async (input, init = {}) => {
    const request = input instanceof Request ? input : null;
    const url = new URL(request ? request.url : String(input), location.href);
    const method = (init.method || request?.method || "GET").toUpperCase();
    if (url.origin !== location.origin) return fail("External fetch denied by synthetic fixture");
    if (url.pathname === "/api/auth/csrf" && method === "GET") {
      if (url.searchParams.get("method") !== "POST" || url.searchParams.get("path") !== "/api/knowledge-center/websites") {
        return fail("Unexpected CSRF scope in synthetic fixture");
      }
      state.csrfRequests += 1; save();
      return json({ csrfToken: "SYNTHETIC-LOCAL-CSRF-NOT-AUTHENTICATION" });
    }
    if (url.searchParams.get("workspaceId") !== scope.workspace) return fail("Missing synthetic workspace scope");
    if (url.pathname === "/api/knowledge-center" && method === "GET") {
      state.snapshotReads += 1;
      if (state.snapshotFailuresRemaining > 0) {
        state.snapshotFailuresRemaining -= 1; state.snapshotFailuresObserved += 1; save();
        return json({ error: "SYNTHETIC snapshot refresh unavailable" }, 503);
      }
      save(); return json({ snapshot: state.snapshot });
    }
    if (url.pathname === "/api/knowledge-center/websites" && method === "POST") {
      const headers = new Headers(init.headers || request?.headers);
      if (headers.get("x-novalure-csrf-token") !== "SYNTHETIC-LOCAL-CSRF-NOT-AUTHENTICATION") return fail("Synthetic CSRF token was not forwarded");
      const body = JSON.parse(init.body || await request?.text() || "{}");
      state.calls.push({ path: url.pathname, method, body });
      let item;
      if (body.action === "create") {
        if (state.snapshot.sources.length || body.areaId !== scope.area || typeof body.name !== "string" || body.url !== "https://synthetic.invalid/knowledge") {
          return fail("Unexpected or duplicate synthetic website create");
        }
        item = {
          id: `synthetic-${mode}-source`, areaId: body.areaId, projectId: scope.project, name: body.name,
          type: "url", status: "draft", revision: 1, approvedVersionId: null,
          draftVersionId: `synthetic-${mode}-version-1`, archivedAt: null,
          version: {
            id: `synthetic-${mode}-version-1`, sourceId: `synthetic-${mode}-source`, version: 1,
            name: body.name, content: mode === "ready" ? content : "", structuredData: {}, url: body.url,
            mediaAssetId: null, status: "draft", createdAt: "2026-10-21T12:00:00.000Z", approvedAt: null,
            processingStatus: "manual", processingMessage: null, processingFormat: null, provenance: { kind: "website_import" },
          },
        };
        replace(item);
        if (mode === "partial-refresh-failure") state.snapshotFailuresRemaining = 1;
        save();
        return json({ source: item, websiteImport: mode === "ready" ? { status: "ready" } : { status: "scan_failed", errorCode: "website_scan_timeout" } }, 201);
      }
      if (body.action === "import") {
        const current = state.snapshot.sources.find((existing) => existing.id === body.sourceId);
        if (!current || current.revision !== body.expectedVersion || current.approvedVersionId || current.version.content) {
          return fail("Retry did not target the saved synthetic source and current revision");
        }
        item = {
          ...current, revision: current.revision + 1, draftVersionId: `${current.id}-version-2`,
          version: { ...current.version, id: `${current.id}-version-2`, version: 2, content: retriedContent },
        };
        replace(item); save();
        return json({ source: item, websiteImport: { status: "ready" } });
      }
      return fail("Unexpected synthetic website action");
    }
    if (["/api/knowledge-center/workflow", "/api/knowledge-center/versions"].includes(url.pathname) && method === "GET") {
      const item = state.snapshot.sources.find((existing) => existing.id === url.searchParams.get("sourceId"));
      if (!item) return fail("Unknown synthetic workflow source");
      return json({ source: item, versions: [item.version], workflow: null });
    }
    if (url.pathname === "/api/knowledge-center/monitoring" && method === "GET") {
      if (!state.snapshot.sources.some((existing) => existing.id === url.searchParams.get("sourceId"))) return fail("Unknown synthetic monitoring source");
      return json({ config: null, history: [], scansThisMonth: 0, allowedIntervals: ["manual", "daily", "weekly", "monthly"] });
    }
    return fail("Unexpected synthetic API request");
  };
  save();
}

const fixtures = {
  ready: snapshot(),
  partial: snapshot(),
  "partial-refresh-failure": snapshot(),
  visibility: snapshot([
    source("synthetic-empty", "SYNTHETIC initial empty website"),
    source("synthetic-published", "SYNTHETIC published website", { published: true }),
    source("synthetic-populated", "SYNTHETIC populated website", { content: "SYNTHETIC existing content" }),
    source("synthetic-structured", "SYNTHETIC structured website", { structuredData: { company: "SYNTHETIC saved details" } }),
  ]),
};

await access(join(repository, "src/components/knowledge-command-center.tsx"));
await mkdir(fixtureRoot, { recursive: true });
const fixtureDirectory = await mkdtemp(join(fixtureRoot, "knowledge-website-ui-"));
const results = [];
const pageErrors = [];
const blockedNetwork = [];
let server;
let browser;
try {
  const entry = `import { createRoot } from "react-dom/client";
    import { KnowledgeCommandCenter } from ${JSON.stringify(join(repository, "src/components/knowledge-command-center.tsx"))};
    (${installSyntheticFetch.toString()})(${JSON.stringify(fixtures)}, ${JSON.stringify(ids)}, ${JSON.stringify(readyContent)}, ${JSON.stringify(retryContent)});
    createRoot(document.getElementById("root")).render(<KnowledgeCommandCenter language="en" workspaceId=${JSON.stringify(ids.workspace)} workspaceName="SYNTHETIC company" />);`;
  await build({
    stdin: { contents: entry, loader: "tsx", resolveDir: repository, sourcefile: "synthetic-knowledge-website-ui.tsx" },
    absWorkingDir: repository, bundle: true, platform: "browser", format: "iife", jsx: "automatic",
    tsconfig: join(repository, "tsconfig.json"), define: { "process.env.NODE_ENV": '"production"' },
    outfile: join(fixtureDirectory, "fixture.js"), logLevel: "silent",
  });
  await writeFile(join(fixtureDirectory, "index.html"), `<!doctype html><html lang="en"><meta charset="utf-8"><title>Synthetic knowledge import UI regression</title><style>body{font:16px sans-serif;margin:24px}button,input,select,textarea{font:inherit;margin:4px;padding:8px}label{display:block}li{margin:16px 0;padding:12px;border:1px solid #aaa}.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)}</style><p>${classification}</p><div id="root"></div><script src="/fixture.js"></script></html>`);
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

  async function inScenario(mode, callback) {
    const context = await browser.newContext({ viewport: { width: 1365, height: 1000 }, serviceWorkers: "block" });
    await context.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.origin === origin && ["/", "/fixture.js", "/favicon.ico"].includes(url.pathname)) return route.continue();
      blockedNetwork.push("Unexpected browser network request blocked");
      return route.abort();
    });
    try {
      const page = await context.newPage();
      page.setDefaultTimeout(10_000);
      page.on("pageerror", () => pageErrors.push("Browser page error"));
      await page.goto(`${origin}/?scenario=${mode}`);
      await expect(page.getByRole("heading", { name: "My company knowledge", exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "Import website", exact: true })).toBeVisible();
      await callback(page);
      const state = await inspect(page);
      assert.deepEqual(state.unexpected, [], "No unexpected synthetic fetch calls");
      assert.equal(state.csrfRequests, state.calls.length, "Every website mutation obtains its synthetic token via the real csrfFetch client");
    } finally { await context.close(); }
  }
  async function inspect(page) {
    return page.evaluate(() => window.syntheticKnowledgeUi.inspect());
  }
  function card(page, name) {
    return page.locator("li").filter({ has: page.getByRole("heading", { name, exact: true }) });
  }
  async function createThroughUi(page, name) {
    await page.getByRole("button", { name: "Import website", exact: true }).click();
    const form = page.getByRole("form", { name: "Add knowledge", exact: true });
    await expect(form).toBeVisible();
    await expect(form.getByLabel("Source type", { exact: true })).toHaveValue("url");
    await form.getByLabel("Knowledge area", { exact: true }).selectOption(ids.area);
    await form.getByLabel("Name", { exact: true }).fill(name);
    await form.getByLabel("Public website address", { exact: true }).fill("https://synthetic.invalid/knowledge");
    await form.getByRole("button", { name: "Save", exact: true }).click();
    await expect(form).toHaveCount(0);
  }
  async function assertReadableDraft(page, name, content) {
    const item = card(page, name);
    await expect(item).toBeVisible();
    const review = item.getByTestId("knowledge-lifecycle");
    await expect(review).toBeVisible();
    await expect(review).toContainText(content);
    await expect(item.getByText("Not yet published for assistants", { exact: true })).toBeVisible();
    await expect(review.getByText("Draft", { exact: true })).toBeVisible();
    await review.getByRole("textbox", { name: /^Reason/ }).fill("SYNTHETIC review readiness check");
    await expect(review.getByTestId("knowledge-submit")).toBeEnabled();
    await expect(item.getByRole("button", { name: "Import website content", exact: true })).toHaveCount(0);
  }
  async function step(name, callback) {
    await callback();
    results.push({ name, status: "PASS" });
    console.log(`PASS ${name}`);
  }

  await step("new URL uses website create once and exposes the returned readable draft for review", async () => {
    await inScenario("ready", async (page) => {
      const name = "SYNTHETIC ready website";
      await createThroughUi(page, name);
      await assertReadableDraft(page, name, readyContent);
      await expect(page.getByRole("status").filter({ hasText: "Website content imported as a draft." })).toBeVisible();
      const state = await inspect(page);
      assert.equal(state.calls.length, 1);
      assert.deepEqual(state.calls[0], { path: "/api/knowledge-center/websites", method: "POST", body: { action: "create", areaId: ids.area, name, url: "https://synthetic.invalid/knowledge" } });
      assert.equal(state.snapshot.sources.length, 1);
      assert.equal(state.snapshot.sources[0].version.status, "draft");
      assert.equal(state.snapshot.sources[0].approvedVersionId, null);
      assert.ok(state.snapshotReads >= 2, "Successful create reloads the snapshot");
    });
  });

  for (const mode of ["partial", "partial-refresh-failure"]) {
    await step(`${mode}: failed initial fetch preserves the source across reload and retries its current revision`, async () => {
      await inScenario(mode, async (page) => {
        const name = "SYNTHETIC saved website awaiting content";
        await createThroughUi(page, name);
        const item = card(page, name);
        const retry = item.getByRole("button", { name: "Import website content", exact: true });
        await expect(retry).toBeEnabled();
        await expect(item.getByTestId("knowledge-monitoring")).toBeVisible();
        await expect(page.getByRole("status").filter({ hasText: "The address is saved, but content has not been imported." })).toBeVisible();
        if (mode === "partial-refresh-failure") {
          await expect(page.getByRole("alert")).toHaveText("The change is saved. The overview could not be refreshed. Please reload the view.");
          await expect(page.locator("body")).not.toContainText("SYNTHETIC snapshot refresh unavailable");
        }
        const saved = await inspect(page);
        assert.equal(saved.calls.length, 1);
        assert.equal(saved.snapshot.sources.length, 1);
        assert.equal(saved.snapshotFailuresObserved, mode === "partial-refresh-failure" ? 1 : 0);
        const { id: sourceId, revision } = saved.snapshot.sources[0];
        await page.reload();
        await expect(page.getByRole("form", { name: "Add knowledge", exact: true })).toHaveCount(0);
        await expect(retry).toBeEnabled();
        const reloaded = await inspect(page);
        assert.equal(reloaded.snapshot.sources[0].id, sourceId);
        assert.equal(reloaded.snapshot.sources[0].revision, revision);
        assert.ok(reloaded.snapshotReads > saved.snapshotReads, "Reload reads the saved synthetic snapshot");
        await retry.click();
        await assertReadableDraft(page, name, retryContent);
        const retried = await inspect(page);
        assert.deepEqual(retried.calls.map((call) => call.body.action), ["create", "import"]);
        assert.deepEqual(retried.calls[1].body, { action: "import", sourceId, expectedVersion: revision });
        assert.equal(retried.snapshot.sources.length, 1);
        assert.equal(retried.snapshot.sources[0].id, sourceId);
        assert.equal(retried.snapshot.sources[0].revision, revision + 1);
      });
    });
  }

  await step("only an existing initial empty URL offers initial import; published and populated sources do not", async () => {
    await inScenario("visibility", async (page) => {
      await expect(card(page, "SYNTHETIC initial empty website").getByRole("button", { name: "Import website content", exact: true })).toBeEnabled();
      for (const name of ["SYNTHETIC published website", "SYNTHETIC populated website", "SYNTHETIC structured website"]) {
        const item = card(page, name);
        await expect(item).toBeVisible();
        await expect(item.getByRole("button", { name: "Import website content", exact: true })).toHaveCount(0);
        await expect(item.getByRole("button", { name: "Website monitoring", exact: true })).toBeVisible();
      }
      await expect(page.getByRole("button", { name: "Import website content", exact: true })).toHaveCount(1);
      assert.equal((await inspect(page)).calls.length, 0);
    });
  });
  assert.deepEqual(pageErrors, [], "No browser page errors");
  assert.deepEqual(blockedNetwork, [], "All browser HTTP stays within the static loopback fixture");
  console.log(JSON.stringify({ classification, passed: results.length, failed: 0, browserPageErrors: pageErrors.length, unexpectedBrowserNetworkRequests: blockedNetwork.length, limitations: ["Synthetic fetch responses only", "No Next server or actual API routes", "No authentication, database, website provider, model or email acceptance"] }));
} finally {
  if (browser) await browser.close();
  if (server) await new Promise((resolveClose, rejectClose) => server.close((error) => error ? rejectClose(error) : resolveClose()));
  await rm(fixtureDirectory, { recursive: true, force: true });
}
