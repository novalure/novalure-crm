// Run with: node --conditions=react-server --import tsx scripts/qa-package4-integration.mjs
// Uses the built, disposable --design-c QA server. Browser authentication,
// publication, proposal decisions and retrieval HTTP calls are real. Website
// DNS/HTTP alone use the scanner's existing service ports, with synthetic bytes;
// this is deliberately not evidence of a real website/provider connection.
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { chromium, expect as baseExpect } from "@playwright/test";
import { seedDesignCIntegration } from "./lib/design-c-integration-fixture.mjs";
import { createTextPdf } from "./lib/knowledge-document-fixtures.ts";
import { runKnowledgeWebsiteScan } from "../src/lib/knowledge-center/monitoring.ts";
import { retrieveAssistantKnowledge } from "../src/lib/knowledge-center/integrations.ts";

const fixture = JSON.parse(await readFile(".npm-cache/qa/sales-browser-context.json", "utf8"));
const base = new URL(fixture.baseUrl);
assert(fixture.syntheticOnly && base.protocol === "http:" && base.hostname === "127.0.0.1" &&
  fixture.database?.host === "127.0.0.1" && /^sales_qa_[a-f0-9]+$/.test(fixture.database.user),
"Package 4 requires the disposable loopback QA fixture");
assert.equal(fixture.fixtureMode, "design-c-actual-predecessors");
assert.equal(fixture.database.database, "neondb");
const output = path.resolve(".npm-cache/qa/package4-integration");
await mkdir(output, { recursive: true });
const expect = baseExpect.configure({ timeout: 30_000 });
const admin = new pg.Pool({ ...fixture.database, user: "qa_admin" });
const runtime = new pg.Pool(fixture.database);
const results = [], pageErrors = [], serverErrors = [], outbound = [], scanRequests = [];
let browser, context, page, accounts, session, areaId, documentId, websiteId, originalWebsiteVersion;
const areaName = "SYNTHETIC PACKAGE 4 COMPANY KNOWLEDGE";
const documentName = "SYNTHETIC PACKAGE 4 PRIVATE PDF";
const websiteName = "SYNTHETIC PACKAGE 4 COMPANY WEBSITE";
const websiteUrl = "https://synthetic-company.com/package4";
const beforeContent = "SYNTHETIC packagefourwebsite: Company office opens at 09:00.";
const afterContent = "SYNTHETIC packagefourwebsite: Company office opens at 10:00.";
const reason = "SYNTHETIC package 4 acceptance: complete content and currentness reviewed";

async function step(name, run) {
  try {
    const detail = await run();
    results.push({ name, status: "PASS", ...(detail === undefined ? {} : { detail }) });
    console.log("PASS " + name);
  } catch (error) {
    results.push({ name, status: "FAIL", error: error.message });
    await page?.screenshot({ path: path.join(output, `failure-${results.length}.png`), fullPage: true }).catch(() => {});
    throw error;
  }
}

function totp(secret) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567", bytes = [];
  let accumulator = 0, bits = 0;
  for (const character of secret) {
    assert(alphabet.includes(character));
    accumulator = (accumulator << 5) | alphabet.indexOf(character); bits += 5;
    if (bits >= 8) { bits -= 8; bytes.push((accumulator >>> bits) & 255); accumulator &= (1 << bits) - 1; }
  }
  const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const digest = createHmac("sha1", Buffer.from(bytes)).update(counter).digest();
  return String((digest.readUInt32BE(digest.at(-1) & 15) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

async function api(pathname, body, workspaceId = accounts.customer.workspaceId, method = body === undefined ? "GET" : "POST") {
  return page.evaluate(async ({ pathname, body, workspaceId, method }) => {
    const url = new URL(pathname, location.origin);
    if (workspaceId) url.searchParams.set("workspaceId", workspaceId);
    const headers = {};
    if (method !== "GET") {
      const tokenResponse = await fetch("/api/auth/csrf?" + new URLSearchParams({ method, path: url.pathname }));
      const token = await tokenResponse.json();
      headers["content-type"] = "application/json";
      headers["x-novalure-csrf-token"] = token.csrfToken;
    }
    const response = await fetch(url, { method, headers, cache: "no-store", ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json(), cacheControl: response.headers.get("cache-control") };
  }, { pathname, body, workspaceId, method });
}

async function snapshot() {
  const response = await api("/api/knowledge-center");
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response.body.snapshot;
}
async function source(id) {
  const row = (await snapshot()).sources.find(item => item.id === id);
  assert(row, "Expected the customer-owned source in the real HTTP snapshot");
  return row;
}
async function openKnowledge() {
  const url = new URL("/", base);
  url.search = new URLSearchParams({ lang: "de", workspaceId: accounts.customer.workspaceId, projectId: "all" }).toString();
  url.hash = "knowledge";
  const previousUrl = page.url();
  await page.goto(url.href, { waitUntil: "domcontentloaded" });
  // An identical fragment URL is a same-document navigation. A new HTTP-created
  // source requires a refreshed snapshot and the sources tab for this helper.
  if (previousUrl === page.url()) await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator(".crm-app.design-c")).toBeVisible();
  await expect(page.locator(".crm-app")).toHaveAttribute("data-crm-audience", "customer");
  await expect(page.getByRole("button", { name: /^Wissensquellen \(/ })).toBeVisible();
  await page.getByRole("button", { name: /^Wissensquellen \(/ }).click();
}
function card(name) { return page.locator("li").filter({ has: page.getByRole("heading", { name, exact: true }) }); }
async function lifecycle(name) {
  const sourceCard = card(name);
  if (!await sourceCard.getByTestId("knowledge-lifecycle").count()) {
    await sourceCard.getByRole("button", { name: "Inhalt prüfen", exact: true }).click();
  }
  const panel = sourceCard.getByTestId("knowledge-lifecycle");
  await expect(panel).toBeVisible();
  return panel;
}
async function publish(name, content) {
  const panel = await lifecycle(name);
  await expect(panel).toContainText(content);
  for (const action of ["submit", "review", "approve", "publish"]) {
    const button = panel.getByTestId("knowledge-" + action);
    await expect(button).toBeVisible();
    await panel.locator("form textarea").first().fill(reason);
    if (action !== "submit") {
      await expect(button).toBeDisabled();
      await panel.getByRole("checkbox", { name: "Ich habe den Inhalt vollständig geprüft.", exact: true }).check();
    }
    await expect(button).toBeEnabled();
    await button.click();
    await expect(button).toHaveCount(0);
  }
  await expect(panel.getByTestId("knowledge-revoke")).toBeVisible();
}
async function assign(channel, checked = true) {
  await page.getByRole("button", { name: "KI-Zuordnungen", exact: true }).click();
  await page.getByLabel("KI-Assistent", { exact: true }).selectOption(accounts.customer.botId);
  await page.getByRole("button", { name: channel === "voice" ? "Telefonassistent" : "Webchat", exact: true }).click();
  const checkbox = page.getByRole("checkbox", { name: new RegExp(areaName) });
  await checkbox.setChecked(checked);
  await page.getByRole("button", { name: "Zuordnungen speichern", exact: true }).click();
  await expect(page.getByText("Wissenszuordnungen gespeichert.", { exact: true })).toBeVisible();
}
async function query(channel, queryText) {
  const response = await api("/api/knowledge-center/query", { botId: accounts.customer.botId, channel, query: queryText });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.match(response.cacheControl, /private/); assert.match(response.cacheControl, /no-store/);
  return response.body.matches;
}
async function assertBoth(id, queryText, content, versionId) {
  for (const channel of ["webchat", "voice"]) {
    const matches = await query(channel, queryText);
    assert.equal(matches.length, 1);
    assert.equal(matches[0].sourceId, id);
    assert.equal(matches[0].versionId, versionId);
    assert.match(matches[0].excerpt, content);
    const adapter = await retrieveAssistantKnowledge(session, {
      assistantId: accounts.customer.botId, channel: channel === "voice" ? "telephony" : "webchat", query: queryText, maxResults: 3,
    }, { pool: runtime });
    assert.equal(adapter.answerStatus, "grounded");
    assert.equal(adapter.excerpts.length, 1);
    assert.equal(adapter.excerpts[0].versionId, versionId);
    assert.equal(adapter.excerpts[0].trust, "retrieved_knowledge_data");
    assert.match(adapter.excerpts[0].text, content);
  }
}

try {
  await step("Combined unchanged predecessor migrations include Knowledge workflow, monitoring and CRM readers", async () => {
    const rows = (await admin.query("select version from novalure_schema_migrations where version ~ '^(091_|101_|102_|103_|104_|105_|106_)' order by version")).rows;
    for (const prefix of ["091_", "101_", "102_", "103_", "104_", "105_", "106_"]) assert(rows.some(row => row.version.startsWith(prefix)));
    const role = (await runtime.query("select current_user as role,rolsuper,rolbypassrls from pg_roles where rolname=current_user")).rows[0];
    assert.deepEqual(role, { role: fixture.database.user, rolsuper: false, rolbypassrls: false });
    return { migrations: rows.map(row => row.version), runtime: role };
  });
  accounts = await seedDesignCIntegration({ admin, role: fixture.database.user });
  await admin.query(`update knowledge_center_entitlements set max_queries_per_month=200,features=features||'{"monitoring":true,"advancedMaintenance":true}'::jsonb,monitoring_intervals=array['manual','daily','weekly','monthly'] where workspace_id=$1`, [accounts.customer.workspaceId]);
  browser = await chromium.launch({ executablePath: process.env.CRM_QA_CHROMIUM_PATH || chromium.executablePath(), headless: true, args: ["--no-sandbox"] });
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: "de-AT", timezoneId: "Europe/Vienna" });
  await context.route("**/*", route => {
    const url = new URL(route.request().url());
    if (url.origin === base.origin || ["data:", "blob:"].includes(url.protocol)) return route.continue();
    outbound.push({ method: route.request().method(), origin: url.origin });
    return route.abort("blockedbyclient");
  });
  page = await context.newPage();
  page.setDefaultTimeout(30_000); page.setDefaultNavigationTimeout(120_000);
  page.on("pageerror", error => pageErrors.push(error.message));
  page.on("response", response => { if (new URL(response.url()).origin === base.origin && response.status() >= 500) serverErrors.push({ status: response.status(), path: new URL(response.url()).pathname }); });

  await step("A fresh Design C customer obtains its session with ordinary password and real TOTP", async () => {
    await page.goto(new URL("/login?lang=de", base).href);
    const consent = page.getByRole("button", { name: "Nur essentielle", exact: true });
    if (await consent.isVisible()) await consent.click();
    await page.locator("#login-email").fill(accounts.customer.email);
    await page.locator("#login-password").fill(accounts.customer.password);
    await Promise.all([page.waitForNavigation({ waitUntil: "domcontentloaded" }), page.locator("form:has(#login-password) button[type=submit]").click()]);
    const key = page.locator("p").filter({ has: page.locator("strong", { hasText: "TOTP-Schlüssel:" }) }).locator("code");
    await expect(key).toBeVisible();
    assert.equal((await api("/api/knowledge-center")).status, 401);
    await page.locator("input[name=recoveryCodesSaved]").check();
    await page.locator("#login-mfa-code").fill(totp((await key.innerText()).trim()));
    await Promise.all([page.waitForNavigation({ waitUntil: "domcontentloaded" }), page.getByRole("button", { name: "Sicher bestätigen", exact: true }).click()]);
    await expect(page).not.toHaveURL(/\/login/);
    assert((await context.cookies()).some(cookie => cookie.name === "novalure_session" && cookie.httpOnly && cookie.value.startsWith("v2.")));
    const auth = await api("/api/auth/session", undefined, null);
    assert.equal(auth.status, 200); assert.equal(auth.body.source, "cookie");
    assert.equal(auth.body.user.id, accounts.customer.userId); assert.equal(auth.body.workspace.id, accounts.customer.workspaceId);
    const stored = (await admin.query("select id,mfa_verified_at from auth_sessions where auth_identity_id=$1 and revoked_at is null", [accounts.customer.authIdentityId])).rows;
    assert.equal(stored.length, 1); assert(stored[0].mfa_verified_at);
    // Rehydrate the actual browser-authenticated actor for the server-only scanner
    // and assistant adapters. No cookie, session row or MFA secret is injected.
    session = { authenticated: true, source: "cookie", userId: auth.body.user.id, workspaceId: auth.body.workspace.id, workspaceName: auth.body.workspace.name,
      name: auth.body.user.name, email: auth.body.user.email, role: auth.body.user.role, permissions: auth.body.user.permissions,
      productRole: auth.body.user.productRole, productPermissions: auth.body.user.productPermissions,
      authIdentityId: accounts.customer.authIdentityId, authSessionId: stored[0].id, mfaVerifiedAt: stored[0].mfa_verified_at };
    await openKnowledge();
    return { ordinaryPassword: true, totpFromEnrollmentUi: true, sessionInjected: false };
  });

  await step("Customer creates a company knowledge area through the real portal", async () => {
    await page.getByRole("button", { name: /^Wissensbereiche \(/ }).click();
    await page.getByRole("button", { name: "Bereich erstellen", exact: true }).click();
    const form = page.locator("form").filter({ has: page.getByRole("heading", { name: "Bereich erstellen", exact: true }) });
    await form.getByLabel("Name", { exact: true }).fill(areaName);
    await form.getByRole("button", { name: "Speichern", exact: true }).click();
    await expect(page.getByText("Änderung gespeichert.", { exact: true })).toBeVisible();
    areaId = (await snapshot()).areas.find(area => area.name === areaName).id;
    await assign("webchat"); await assign("voice");
  });

  await step("Real PDF parsing remains a draft until customer review, approval and publication", async () => {
    await page.getByRole("button", { name: /^Wissensquellen \(/ }).click();
    await page.getByRole("button", { name: "Datei hochladen", exact: true }).click();
    const form = page.locator("form").filter({ has: page.getByRole("heading", { name: "Wissen hinzufügen", exact: true }) });
    await form.getByLabel("Wissensbereich", { exact: true }).selectOption(areaId);
    await form.getByLabel("Name (optional)", { exact: true }).fill(documentName);
    await form.getByLabel("Privates Dokument hochladen", { exact: true }).setInputFiles({ name: "synthetic-package4.pdf", mimeType: "application/pdf",
      buffer: Buffer.from(await createTextPdf(["SYNTHETIC packagefourdocument: 09:00."])) });
    await expect(card(documentName).getByText("Inhalt erkannt · Bitte prüfen", { exact: true })).toBeVisible();
    documentId = (await snapshot()).sources.find(row => row.name === documentName).id;
    const parsed = await source(documentId);
    assert.equal(parsed.approvedVersionId, null);
    assert.match(parsed.version.content, /packagefourdocument: 09:00/);
    assert.deepEqual(await query("webchat", "packagefourdocument"), []);
    assert.deepEqual(await query("voice", "packagefourdocument"), []);
    await publish(documentName, "packagefourdocument");
    const saved = await source(documentId);
    await assertBoth(documentId, "packagefourdocument", /09:00/, saved.approvedVersionId);
  });

  await step("Voice assignment can be withdrawn independently while webchat retains the same document", async () => {
    await assign("voice", false);
    assert.deepEqual(await query("voice", "packagefourdocument"), []);
    assert.equal((await query("webchat", "packagefourdocument")).length, 1);
    const voice = await retrieveAssistantKnowledge(session, { assistantId: accounts.customer.botId, channel: "telephony", query: "packagefourdocument", maxResults: 3 }, { pool: runtime });
    assert.equal(voice.answerStatus, "insufficient_knowledge");
    await assign("voice");
  });

  await step("An authenticated synthetic website draft is explicitly published through the same portal", async () => {
    const created = await api("/api/knowledge-center/sources", { areaId, name: websiteName, type: "url", url: websiteUrl, content: beforeContent });
    assert.equal(created.status, 201, JSON.stringify(created.body)); websiteId = created.body.source.id;
    await openKnowledge();
    await publish(websiteName, "09:00");
    originalWebsiteVersion = (await source(websiteId)).approvedVersionId;
    await assertBoth(websiteId, "packagefourwebsite", /09:00/, originalWebsiteVersion);
  });

  await step("Synthetic website scan detects changed bytes through the unchanged scanner and persists one proposal", async () => {
    const saved = await source(websiteId);
    const result = await runKnowledgeWebsiteScan(session, { sourceId: websiteId, expectedVersion: saved.revision }, { pool: runtime, scanPorts: {
      resolve: async hostname => { assert.equal(hostname, "synthetic-company.com"); return [{ address: "93.184.216.34", family: 4 }]; },
      request: async ({ url, address, signal }) => {
        assert.equal(url.href, websiteUrl); assert.equal(address.address, "93.184.216.34"); assert.equal(signal.aborted, false);
        scanRequests.push({ url: url.href, syntheticDns: true, syntheticHttp: true });
        return { status: 200, headers: { "content-type": "text/plain; charset=utf-8" }, body: Buffer.from(afterContent) };
      },
    } });
    assert.equal(result.run.status, "changed"); assert(result.proposal.id);
    assert.equal(result.scan.trust, "untrusted_external_content");
    const workflow = await api("/api/knowledge-center/workflow?sourceId=" + websiteId);
    assert.equal(workflow.status, 200); assert.equal(workflow.body.proposals.length, 1);
    assert.equal(workflow.body.proposals[0].status, "open");
    assert.equal(workflow.body.proposals[0].changes.content, afterContent);
    assert.equal((await source(websiteId)).approvedVersionId, originalWebsiteVersion);
    await assertBoth(websiteId, "packagefourwebsite", /09:00/, originalWebsiteVersion);
    return { scanner: "unchanged service", externalDnsRequests: 0, externalHttpRequests: 0, syntheticPortRequests: scanRequests.length, runId: result.run.id };
  });

  await step("Customer sees the website comparison and accepts its proposal as an unpublished draft", async () => {
    await page.getByRole("button", { name: "Wissenspflege", exact: true }).click();
    const proposal = page.locator("article").filter({ hasText: websiteName }).first();
    await proposal.getByRole("button", { name: "Vorschlag prüfen", exact: true }).click();
    await expect(proposal.getByTestId("knowledge-proposal-comparison")).toContainText("09:00");
    await expect(proposal.getByTestId("knowledge-proposal-comparison")).toContainText("10:00");
    await expect(proposal.getByRole("textbox", { name: /^Vorgeschlagener Inhalt/ })).toHaveValue(afterContent);
    await proposal.getByRole("textbox", { name: /^Begründung für die Entscheidung/ }).fill(reason);
    await proposal.getByRole("button", { name: "Annehmen und Entwurf erstellen", exact: true }).click();
    await expect(page.getByText("Vorschlag angenommen. Der neue Entwurf muss noch separat geprüft, freigegeben und veröffentlicht werden.", { exact: true })).toBeVisible();
    const saved = await source(websiteId);
    assert.equal(saved.version.status, "draft"); assert.match(saved.version.content, /10:00/);
    assert.equal(saved.approvedVersionId, originalWebsiteVersion);
    await assertBoth(websiteId, "packagefourwebsite", /09:00/, originalWebsiteVersion);
  });

  await step("Customer publication of the accepted website version updates webchat and voice together", async () => {
    await page.getByRole("button", { name: /^Wissensquellen \(/ }).click();
    await publish(websiteName, "10:00");
    const saved = await source(websiteId);
    assert.notEqual(saved.approvedVersionId, originalWebsiteVersion);
    await assertBoth(websiteId, "packagefourwebsite", /10:00/, saved.approvedVersionId);
  });

  await step("History preserves both website versions; restoration requires currentness and legal confirmation", async () => {
    const saved = await source(websiteId);
    const panel = await lifecycle(websiteName), history = panel.getByTestId("knowledge-version-history");
    await history.locator("summary").click();
    await history.getByRole("combobox").selectOption(originalWebsiteVersion);
    await expect(history).toContainText("09:00"); await expect(history).toContainText("10:00");
    await history.locator("textarea").fill(reason);
    await expect(history.getByTestId("knowledge-restore")).toBeDisabled();
    await history.getByRole("checkbox", { name: /weiterhin aktuell/ }).check();
    await expect(history.getByTestId("knowledge-restore")).toBeDisabled();
    await history.getByRole("checkbox", { name: /rechtliche Angaben/ }).check();
    await history.getByTestId("knowledge-restore").click();
    await expect(panel.getByTestId("knowledge-submit")).toBeVisible();
    const restored = await source(websiteId);
    assert.equal(restored.version.version, 3); assert.match(restored.version.content, /09:00/);
    assert.notEqual(restored.version.id, originalWebsiteVersion); assert.equal(restored.approvedVersionId, saved.approvedVersionId);
    await assertBoth(websiteId, "packagefourwebsite", /10:00/, saved.approvedVersionId);
  });

  await step("Publication revocation is immediate for both channels while the restored draft stays private", async () => {
    const panel = await lifecycle(websiteName);
    await panel.locator("form textarea").first().fill(reason);
    await panel.getByTestId("knowledge-revoke").click();
    await expect.poll(async () => (await source(websiteId)).approvedVersionId).toBe(null);
    for (const channel of ["webchat", "voice"]) assert.deepEqual(await query(channel, "packagefourwebsite"), []);
    for (const channel of ["webchat", "telephony"]) {
      const result = await retrieveAssistantKnowledge(session, { assistantId: accounts.customer.botId, channel, query: "packagefourwebsite", maxResults: 3 }, { pool: runtime });
      assert.equal(result.answerStatus, "insufficient_knowledge");
    }
    assert.equal((await source(documentId)).approvedVersionId !== null, true);
  });

  await step("Foreign tenant selectors, sources and assistant IDs remain inaccessible across the integrated workflow", async () => {
    for (const endpoint of ["/api/crm/core", "/api/knowledge-center", "/api/knowledge-center/workflow?sourceId=" + websiteId, "/api/knowledge-center/monitoring?sourceId=" + websiteId]) {
      assert([403, 404].includes((await api(endpoint, undefined, accounts.foreign.workspaceId)).status), endpoint);
    }
    const foreignBot = await api("/api/knowledge-center/query", { botId: accounts.foreign.botId, channel: "webchat", query: "packagefourdocument" });
    assert([403, 404].includes(foreignBot.status), JSON.stringify(foreignBot.body));
    const json = JSON.stringify(await snapshot());
    assert(!/FOREIGN PRIVATE|FOREIGN-PRIVATE-UNIT/.test(json));
  });

  await step("Desktop and mobile Design C render the combined lifecycle without overflow or runtime errors", async () => {
    await openKnowledge();
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
      await expect(page.getByRole("heading", { name: "Mein Unternehmenswissen", exact: true })).toBeVisible();
      await expect(card(websiteName)).toBeVisible();
      await lifecycle(websiteName);
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2));
      await page.screenshot({ path: path.join(output, width === 390 ? "mobile.png" : "desktop.png"), fullPage: true });
    }
    assert.deepEqual(pageErrors, []); assert.deepEqual(serverErrors, []); assert.deepEqual(outbound, []);
    const bot = (await admin.query("select status from bots where id=$1", [accounts.customer.botId])).rows[0];
    assert.equal(bot.status, "Entwurf", "Knowledge integration must not activate an assistant");
  });
} catch (error) {
  if (!results.some(result => result.status === "FAIL")) results.push({ name: "Package 4 setup", status: "FAIL", error: error.message });
  console.error(error);
  process.exitCode = 1;
} finally {
  await writeFile(path.join(output, "result.json"), JSON.stringify({ syntheticOnly: true, productionAccess: 0,
    ordinaryPasswordAndMfa: Boolean(session), sessionInjected: false,
    websiteScanBoundary: "Real scanner and persistence; DNS and HTTP are explicit synthetic service ports, not the browser scan endpoint or an external website",
    providerConnections: 0, results, pageErrors, serverErrors, outbound, scanRequests,
    passed: results.length > 0 && results.every(result => result.status === "PASS") }, null, 2));
  await context?.close(); await browser?.close(); await Promise.all([runtime.end(), admin.end()]);
}
