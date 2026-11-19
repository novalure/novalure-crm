import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { chromium, expect as baseExpect } from "@playwright/test";

// Real built application, login/MFA, CSRF, RLS and PostgreSQL; synthetic records.
// Start qa:sales:server -- --built --design-c --website-sales-workbench first.
const fixture = JSON.parse(await readFile(".npm-cache/qa/sales-browser-context.json", "utf8"));
const base = new URL(fixture.baseUrl);
assert(fixture.syntheticOnly && fixture.websiteSales?.syntheticOnly);
assert(base.hostname === "127.0.0.1" && fixture.database.host === "127.0.0.1");
assert(/^sales_qa_[a-f0-9]+$/.test(fixture.database.user));
assert.equal(fixture.database.database, "neondb");
assert.equal(fixture.fixtureMode, "design-c-current-application-originals");
const output = path.resolve(".npm-cache/qa/website-sales-workbench");
await mkdir(output, { recursive: true });
const expect = baseExpect.configure({ timeout: 15000 });
const require = createRequire(import.meta.url);
const admin = new pg.Pool({ ...fixture.database, user: "qa_admin" });
const browser = await chromium.launch({ channel: process.env.CRM_QA_BROWSER_CHANNEL || "chrome", headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: "de-AT", timezoneId: "Europe/Vienna" });
const page = await context.newPage();
const results = [], pageErrors = [], consoleErrors = [], unexpectedNetwork = [], accessibility = [], performance = [];
page.on("dialog", dialog => dialog.accept());
page.on("pageerror", error => pageErrors.push(error.message));
page.on("console", message => { if (message.type() === "error") consoleErrors.push(message.text()); });
page.on("request", request => {
  if (new URL(request.url()).origin !== base.origin) unexpectedNetwork.push(new URL(request.url()).origin);
});
function totp(secret) {
  let bits = 0, value = 0;
  const bytes = [], alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  for (const character of secret) {
    const index = alphabet.indexOf(character);
    assert(index >= 0);
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) { bits -= 8; bytes.push((value >>> bits) & 255); value &= (1 << bits) - 1; }
  }
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const digest = createHmac("sha1", Buffer.from(bytes)).update(counter).digest();
  return String((digest.readUInt32BE(digest.at(-1) & 15) & 0x7fffffff) % 1000000).padStart(6, "0");
}
async function step(name, action) {
  await action();
  results.push({ name, status: "PASS" });
  console.log("PASS " + name);
}
async function api(pathname, body) {
  return page.evaluate(async ({ pathname, body }) => {
    const method = body === undefined ? "GET" : "POST";
    const headers = { Accept: "application/json" };
    if (body !== undefined) {
      const csrf = await fetch("/api/auth/csrf?" + new URLSearchParams({ method, path: new URL(pathname, location.origin).pathname }), { cache: "no-store" });
      const token = await csrf.json();
      headers["x-novalure-csrf-token"] = token.csrfToken;
      headers["Content-Type"] = "application/json";
    }
    const response = await fetch(pathname, { method, headers, cache: "no-store", ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  }, { pathname, body });
}
async function login() {
  await page.goto(new URL("/login", base).href);
  const consent = page.getByRole("button", { name: /^(Nur essenzielle|Only necessary)$/ });
  if (await consent.isVisible()) await consent.click();
  await page.locator("#login-email").fill(fixture.email);
  await page.locator("#login-password").fill(fixture.password);
  await Promise.all([page.waitForNavigation({ waitUntil: "domcontentloaded" }), page.locator("form:has(#login-password) button[type=submit]").click()]);
  const key = page.locator("p").filter({ has: page.locator("strong", { hasText: /TOTP-Schlüssel:|TOTP key:/ }) }).locator("code");
  await expect(key).toBeVisible();
  assert.equal((await api("/api/crm/core")).status, 401, "Password alone must not authorize this internal account");
  const secret = (await key.innerText()).trim();
  await page.locator("input[name=recoveryCodesSaved]").check();
  await page.locator("#login-mfa-code").fill(totp(secret));
  await Promise.all([page.waitForNavigation({ waitUntil: "domcontentloaded" }), page.getByRole("button", { name: /^(Sicher bestätigen|Verify securely)$/ }).click()]);
  await expect(page.locator(".crm-app")).toBeVisible();
  const language = await api("/api/settings/language", { preference: "de", expectedUserId: fixture.userId });
  assert.equal(language.status, 200);
  const session = (await context.cookies()).find(cookie => cookie.name === "novalure_session");
  assert(session?.httpOnly && session.value.startsWith("v2."));
  const persisted = await admin.query("select mfa_verified_at from auth_sessions where auth_identity_id=$1 and revoked_at is null", [fixture.authIdentityId]);
  assert.equal(persisted.rows.length, 1);
  assert(persisted.rows[0].mfa_verified_at);
}
async function open(project = fixture.websiteSales.projects[0]) {
  const start = Date.now();
  await page.goto(new URL(`/?projectId=${project.projectId}#website-sales`, base).href);
  await expect(page.locator("[data-website-sales-workbench]")).toBeVisible();
  performance.push({ project: project.city, workbenchVisibleMs: Date.now() - start, environment: "optimized-loopback-synthetic" });
}
async function screenshot(name, viewport) {
  await page.setViewportSize(viewport);
  const overflowing = await page.locator("[data-website-sales-workbench]").evaluate(element => {
    const width = innerWidth;
    return [...element.querySelectorAll("button,input,textarea,select,h2,h3,p")].filter(node => {
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && (rect.left < -1 || rect.right > width + 1);
    }).map(node => ({ tag: node.tagName, text: node.textContent?.slice(0, 60) }));
  });
  assert.deepEqual(overflowing, [], "Workbench must fit the viewport");
  await page.screenshot({ path: path.join(output, name + ".png"), fullPage: true });
  await page.screenshot({ path: path.join(output, name + "-fold.png"), fullPage: false });
  await page.addScriptTag({ path: require.resolve("axe-core/axe.min.js") });
  const scan = await page.evaluate(async () => {
    const result = await window.axe.run(document.querySelector("[data-website-sales-workbench]"), { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] } });
    return { violations: result.violations.map(item => ({ id: item.id, impact: item.impact, nodes: item.nodes.map(node => ({ target: node.target, summary: node.failureSummary })) })), incomplete: result.incomplete.map(item => ({ id: item.id, nodes: item.nodes.map(node => node.target) })), passes: result.passes.length };
  });
  accessibility.push({ name, ...scan });
  assert.deepEqual(scan.violations, [], "Workbench has no automatic axe WCAG violations");
}
async function selectCompany(project = fixture.websiteSales.projects[0]) {
  await page.locator("[data-website-sales-workbench]").getByLabel("Unternehmen", { exact: true }).selectOption(project.companyId);
}
async function registerLocation(address) {
  const registration = page.locator("[data-website-sales-register]");
  await registration.locator("summary").click();
  await registration.getByLabel("Irische Standortadresse", { exact: false }).fill(address);
  await registration.getByLabel("Quellen-URL", { exact: false }).fill("https://example.invalid/location");
  await registration.getByLabel("Quellenreferenz", { exact: false }).fill("SYNTHETIC source tying this location to the company; no real prospect");
  await registration.getByRole("button", { name: "Standort erfassen", exact: true }).click();
  await expect(page.locator("[data-website-sales-research]")).toBeVisible();
}
async function fillResearch(pathValue = "NO_WEBSITE") {
  const research = page.locator("[data-website-sales-research]");
  await research.getByLabel("Recherchepfad", { exact: false }).selectOption(pathValue);
  await research.getByLabel("Geschäftlicher Bedarf", { exact: false }).first().selectOption("EVIDENCED");
  await research.getByLabel("Suche nach eigener Website", { exact: false }).first().selectOption(pathValue === "WEBSITE_OBSTACLE" ? "FOUND" : "NONE_FOUND");
  await research.getByLabel("Domain der eigenen Website", { exact: false }).fill(pathValue === "WEBSITE_OBSTACLE" ? "example.invalid" : "");
  if (pathValue === "WEBSITE_OBSTACLE") {
    await research.getByLabel("Domain der eigenen Website", { exact: false }).fill("example.invalid");
    await research.getByLabel("Website-Hindernis", { exact: false }).first().selectOption("CONFIRMED_REPRODUCIBLE");
  }
  if (pathValue === "PLATFORM_PRIMARY") {
    await research.getByLabel("URL des Plattformprofils", { exact: false }).fill("https://example.invalid/platform/company");
    await research.getByLabel("Bestehender Buchungsweg", { exact: false }).selectOption("CHECKED_WORKING");
  }
  await research.locator('input[name="identityVerified"]').check();
  const times = await page.evaluate(() => {
    const local = value => { const date = new Date(value); return new Date(value - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16); };
    return { observed: local(Date.now() - 300000), expiry: local(Date.now() + 86400000) };
  });
  for (const fact of await research.locator("[data-website-sales-fact]").all()) {
    const kind = await fact.getAttribute("data-website-sales-fact");
    await fact.getByLabel("Quellen-URL", { exact: false }).fill(`https://example.invalid/evidence/${kind.toLowerCase()}`);
    await fact.getByLabel("Beobachtet am", { exact: false }).fill(times.observed);
    await fact.getByLabel("Gültig bis", { exact: false }).fill(times.expiry);
    await fact.getByLabel("Aussagesicherheit", { exact: false }).fill("90");
    await fact.getByLabel("Beobachteter Befund", { exact: false }).fill(`SYNTHETIC ${kind} finding for this company and location`);
    await fact.getByLabel("Wann muss dieser Befund", { exact: false }).fill("Review if this scoped source changes or the evidence expires");
  }
}

try {
  await step("ordinary password, actual TOTP enrollment and server-issued MFA session", login);
  await step("internal CRM navigation reaches the project-scoped Website Sales workbench", () => open());
  await step("desktop, tablet, phone and reduced-motion workbench layouts fit the viewport", async () => {
    await selectCompany();
    await screenshot("workbench-desktop", { width: 1440, height: 1000 });
    await screenshot("workbench-tablet", { width: 834, height: 1112 });
    await screenshot("workbench-phone", { width: 390, height: 844 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await screenshot("workbench-reduced-motion", { width: 1440, height: 1000 });
  });
  await step("invalid registration focuses a linked error summary without a business write", async () => {
    const registration = page.locator("[data-website-sales-register]");
    await registration.locator("summary").click();
    await registration.getByRole("button", { name: "Standort erfassen", exact: true }).click();
    await expect(registration.locator('[role="alert"]')).toBeFocused();
    assert.equal((await admin.query("select count(*)::int as count from crm_company_locations where workspace_id=$1", [fixture.workspaceId])).rows[0].count, 0);
    await registration.locator("summary").click();
  });
  await step("location registration uses canonical company identity and persists unchanged after reload", async () => {
    await registerLocation("SYNTHETIC 1 Research Street, Dublin, Ireland");
    const stored = await admin.query("select id,registration_basis,version from crm_company_locations where workspace_id=$1 and company_id=$2", [fixture.workspaceId, fixture.websiteSales.projects[0].companyId]);
    assert.equal(stored.rows.length, 1);
    assert.equal(stored.rows[0].registration_basis, "SESSION_ATTESTED");
    assert.equal(stored.rows[0].version, 1);
    await page.reload();
    await selectCompany();
    await page.locator("[data-website-sales-workbench]").getByLabel("Unternehmensstandort", { exact: true }).selectOption(stored.rows[0].id);
    await expect(page.locator("[data-website-sales-research]")).toBeVisible();
  });
  let lostBody;
  await step("committed research with a lost response stays UNKNOWN through a hard reload", async () => {
    await fillResearch();
    await context.route("**/api/crm/website-sales?**", async route => {
      if (route.request().method() !== "POST" || route.request().postDataJSON().operation !== "observe") return route.continue();
      lostBody = route.request().postData();
      const response = await route.fetch();
      assert.equal(response.status(), 200);
      await route.abort("failed");
    }, { times: 1 });
    await page.locator("[data-website-sales-research]").getByRole("button", { name: "Recherche speichern", exact: true }).click();
    await expect(page.getByText("Das Speicherergebnis ist unbestätigt.", { exact: false })).toBeVisible();
    assert.equal((await admin.query("select count(*)::int as count from crm_website_sales_observations where workspace_id=$1", [fixture.workspaceId])).rows[0].count, 1);
    await page.reload();
    await expect(page.getByRole("button", { name: "Ursprünglichen Vorgang abgleichen", exact: true })).toBeDisabled();
    await expect(page.getByText("Das Speicherergebnis ist unbestätigt.", { exact: false })).toBeVisible();
    await expect(page.locator("[data-website-sales-research]").getByRole("button", { name: "Recherche speichern", exact: true })).toBeDisabled();
  });
  await step("explicit current-read and reconciliation resend identical bytes and create no duplicate", async () => {
    const requests = [];
    page.on("request", request => { if (request.method() === "POST" && new URL(request.url()).pathname === "/api/crm/website-sales") requests.push(request.postData()); });
    await page.getByRole("button", { name: "Aktuellen Stand lesen", exact: true }).click();
    await expect(page.getByRole("button", { name: "Ursprünglichen Vorgang abgleichen", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "Ursprünglichen Vorgang abgleichen", exact: true }).click();
    await expect(page.getByText("Das Speicherergebnis ist unbestätigt.", { exact: false })).toHaveCount(0);
    assert.equal(requests.length, 1);
    assert.equal(requests[0], lostBody);
    assert.equal((await admin.query("select count(*)::int as count from crm_website_sales_observations where workspace_id=$1", [fixture.workspaceId])).rows[0].count, 1);
  });
  await step("qualification creates the linked lead, configured pipeline opportunity and next task", async () => {
    const form = page.locator("[data-website-sales-qualification]");
    await form.getByLabel("Ansprechperson", { exact: false }).selectOption(fixture.websiteSales.projects[0].contactId);
    await form.getByLabel("Zusammenfassung der Verkaufschance", { exact: false }).fill("SYNTHETIC scoped website need supported by current sources");
    await form.getByLabel("Nächste interne Aufgabe", { exact: false }).fill("SYNTHETIC review diagnosis and scope internally");
    await form.getByRole("button", { name: "Verkaufschance und nächste Aufgabe anlegen", exact: true }).click();
    await expect(page.locator("[data-website-sales-offer]")).toBeVisible();
    const rows = await admin.query("select l.contact_id,d.organization_id,d.stage,t.lead_id from crm_website_sales_workflows w join leads l on l.id=w.lead_id join deals d on d.id=w.deal_id join tasks t on t.id=w.next_task_id where w.workspace_id=$1", [fixture.workspaceId]);
    assert.equal(rows.rows.length, 1);
    assert.equal(rows.rows[0].contact_id, fixture.websiteSales.projects[0].contactId);
    assert.equal(rows.rows[0].organization_id, fixture.websiteSales.projects[0].companyId);
    assert.equal(rows.rows[0].stage, "Research qualified");
  });
  await step("canonical proposal draft persists with no approval, delivery or contact authority", async () => {
    const form = page.locator("[data-website-sales-offer]");
    const text = { subject: "SYNTHETIC Website proposal", item: "SYNTHETIC Website scope", scope: "Website diagnosis and design", paymentPlan: "For internal review", discounts: "None", specialTerms: "Synthetic draft only", riskComplianceNotes: "No contact authority", terms: "Subject to separate owner approval" };
    for (const [name, value] of Object.entries(text)) await form.locator(`[name="${name}"]`).fill(value);
    await form.locator('[name="price"]').fill("2500");
    await form.locator('[name="quantity"]').fill("1");
    await form.locator('[name="validUntil"]').fill(await page.evaluate(() => { const date = new Date(Date.now() + 86400000); return new Date(date.valueOf() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16); }));
    await form.getByRole("button", { name: "Angebotsentwurf speichern", exact: true }).click();
    await expect(page.getByText("Angebot entworfen", { exact: true })).toBeVisible();
    const rows = await admin.query("select o.status,o.approval_id,(select count(*)::int from crm_offer_deliveries where workspace_id=$1) as deliveries from crm_website_sales_workflows w join crm_offers o on o.id=w.offer_draft_id where w.workspace_id=$1", [fixture.workspaceId]);
    assert.equal(rows.rows.length, 1);
    assert.equal(rows.rows[0].status, "DRAFT"); assert.equal(rows.rows[0].approval_id, null); assert.equal(rows.rows[0].deliveries, 0);
    await screenshot("workbench-offer-draft", { width: 1440, height: 1000 });
  });
  await step("project navigation does not expose another project's company or location", async () => {
    await open(fixture.websiteSales.projects[1]);
    await selectCompany(fixture.websiteSales.projects[1]);
    await expect(page.locator("[data-website-sales-workbench]").getByLabel("Unternehmensstandort", { exact: true }).locator("option")).toHaveCount(1);
    await expect(page.locator("[data-website-sales-workbench]")).not.toContainText("SYNTHETIC 1 Research Street");
  });
  await step("website-obstacle and platform paths retain their separate evidence requirements", async () => {
    await registerLocation("SYNTHETIC 2 Platform Street, Cork, Ireland");
    await fillResearch("WEBSITE_OBSTACLE");
    const research = page.locator("[data-website-sales-research]");
    await research.getByLabel("Website-Hindernis", { exact: false }).first().selectOption("OLD_DESIGN_ONLY");
    await research.getByRole("button", { name: "Recherche speichern", exact: true }).click();
    await expect(page.getByText("Klärung erforderlich", { exact: true })).toBeVisible();
    await expect(page.locator("[data-website-sales-qualification]").getByRole("button", { name: "Verkaufschance und nächste Aufgabe anlegen", exact: true })).toBeDisabled();
    await fillResearch("WEBSITE_OBSTACLE");
    await research.getByRole("button", { name: "Recherche speichern", exact: true }).click();
    await expect(page.getByText("Befunde bereit", { exact: true })).toBeVisible();
    await fillResearch("PLATFORM_PRIMARY");
    await research.getByRole("button", { name: "Recherche speichern", exact: true }).click();
    await expect(page.getByText("Befunde bereit", { exact: true })).toBeVisible();
    const observations = await admin.query("select prospect->>'path' as path,prospect->>'bookingRoute' as booking_route from crm_website_sales_observations where workspace_id=$1 and company_id=$2 order by created_at", [fixture.workspaceId, fixture.websiteSales.projects[1].companyId]);
    assert.deepEqual(observations.rows.map(row => row.path), ["WEBSITE_OBSTACLE", "WEBSITE_OBSTACLE", "PLATFORM_PRIMARY"]);
    assert.equal(observations.rows.at(-1).booking_route, "CHECKED_WORKING");
  });
  await step("explicitly confirmed stop is terminal in the UI and database", async () => {
    const stop = page.locator("[data-website-sales-stop]");
    await stop.locator("summary").click();
    await stop.getByLabel("Grund", { exact: false }).selectOption("NO_FIT");
    await stop.getByLabel("Referenz für diesen Stopp", { exact: false }).fill("SYNTHETIC terminal stop test; no real opt-out");
    await stop.getByRole("checkbox").check();
    await stop.getByRole("button", { name: "Vorgang stoppen", exact: true }).click();
    await expect(page.getByText("Dieser Vorgang ist gestoppt.", { exact: false })).toBeVisible();
    await expect(page.locator("[data-website-sales-research]")).toHaveCount(0);
    const row = await admin.query("select status,stop_reason from crm_website_sales_workflows where workspace_id=$1 and company_id=$2", [fixture.workspaceId, fixture.websiteSales.projects[1].companyId]);
    assert.deepEqual(row.rows, [{ status: "STOPPED", stop_reason: "NO_FIT" }]);
  });
  await step("a real product-role downgrade removes the internal workbench and denies its API", async () => {
    await admin.query("update workspace_users set product_role='viewer' where id=$1 and workspace_id=$2", [fixture.userId, fixture.workspaceId]);
    try {
      await page.reload();
      await expect(page.locator(".crm-app")).toBeVisible();
      await expect(page.locator("[data-website-sales-workbench]")).toHaveCount(0);
      const response = await api("/api/crm/website-sales/workbench?view=projects");
      assert.equal(response.status, 403);
      assert.equal(JSON.stringify(response.body).includes("SYNTHETIC Dublin Company"), false);
    } finally { await admin.query("update workspace_users set product_role='novalureAdmin' where id=$1 and workspace_id=$2", [fixture.userId, fixture.workspaceId]); }
  });
  assert.deepEqual(pageErrors, []);
  assert.deepEqual(consoleErrors.filter(message => !message.startsWith("Failed to load resource:")), []);
  assert.deepEqual(unexpectedNetwork, []);
} catch (error) {
  await page.screenshot({ path: path.join(output, "failure.png"), fullPage: true }).catch(() => undefined);
  throw error;
} finally {
  await writeFile(path.join(output, "result.json"), JSON.stringify({ syntheticOnly: true, productionAccess: 0, realPasswordAndMfa: results.some(row => row.name.startsWith("ordinary password")), results, pageErrors, consoleErrors, unexpectedNetwork, accessibility, performance, completed: results.length, authentication: "ordinary-login-ui", server: "optimized-next-build", browserExternalRequests: unexpectedNetwork.length }, null, 2));
  await context.close(); await browser.close(); await admin.end();
}
