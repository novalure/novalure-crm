// Run after qa:sales:server. Uses its disposable loopback database and ordinary
// password/MFA login; no injected sessions, provider credentials or external IO.
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import pg from "pg";
import { chromium, expect as baseExpect } from "@playwright/test";
import { seedSalesBrowser } from "./lib/sales-browser-fixture.mjs";
import { createTextPdf, createDocx, createScanPdf, DOCX_MIME } from "./lib/knowledge-document-fixtures.ts";

const fixture = JSON.parse(await readFile(".npm-cache/qa/sales-browser-context.json", "utf8"));
const expect = baseExpect.configure({ timeout: 30000 });
if (!fixture.syntheticOnly || new URL(fixture.baseUrl).hostname !== "127.0.0.1" || fixture.database?.host !== "127.0.0.1") {
  throw new Error("Knowledge browser QA requires the disposable loopback fixture");
}
const admin = new pg.Pool({ ...fixture.database, user: "qa_admin" });
Object.assign(fixture, await seedSalesBrowser({ admin, role: fixture.database.user }));
await admin.query("insert into account_ui_preferences(auth_identity_id,language_preference) values($1,'de') on conflict(auth_identity_id) do update set language_preference=excluded.language_preference", [fixture.authIdentityId]);
const browser = await chromium.launch({ executablePath: process.env.CRM_QA_CHROMIUM_PATH || "/usr/bin/chromium", headless: true, args: ["--no-sandbox"] });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: "de-AT", timezoneId: "Europe/Vienna" });
await context.route("**/*", route => {
  const url = new URL(route.request().url());
  return url.hostname === "127.0.0.1" || ["data:", "blob:"].includes(url.protocol) ? route.continue() : route.abort();
});
await context.addInitScript(() => localStorage.setItem("novalure-crm-navigation-preset-v1", "realEstateBroker"));
const page = await context.newPage();
page.setDefaultTimeout(30000);
page.setDefaultNavigationTimeout(120000); // Cold local Next compilation is outside the product request budget.
const results = [], pageErrors = [];
page.on("pageerror", error => pageErrors.push(error.message));
const botId = randomUUID();
let sourceId;
async function step(name, callback) {
  await callback();
  results.push({ name, status: "PASS" });
  console.log("PASS " + name);
}
async function publishThroughUi(card, expectedContent) {
  if (!await card.getByTestId("knowledge-lifecycle").count()) await card.getByRole("button", { name: "Inhalt prüfen", exact: true }).click();
  const lifecycle = card.getByTestId("knowledge-lifecycle");
  await expect(lifecycle).toBeVisible();
  if (expectedContent) await expect(lifecycle).toContainText(expectedContent);
  for (const action of ["submit", "review", "approve", "publish"]) {
    const button = lifecycle.getByTestId("knowledge-" + action);
    await expect(button).toBeVisible();
    await lifecycle.locator("form textarea").first().fill("SYNTHETIC vollständig geprüfte Veröffentlichung");
    if (action !== "submit") await lifecycle.getByRole("checkbox", { name: "Ich habe den Inhalt vollständig geprüft.", exact: true }).check();
    await button.click();
    await expect(button).toHaveCount(0);
  }
  await expect(lifecycle.getByTestId("knowledge-revoke")).toBeVisible();
}
async function api(path, body, method = "POST") {
  return page.evaluate(async ({ path, body, method }) => {
    const scopedPath = path + (path.includes("?") ? "&" : "?") + new URLSearchParams({ workspaceId: window.knowledgeWorkspace });
    const tokenResponse = await fetch("/api/auth/csrf?" + new URLSearchParams({ method, path: new URL(scopedPath, location.origin).pathname }));
    const token = await tokenResponse.json();
    const response = await fetch(scopedPath, { method, headers: { "content-type": "application/json", "x-novalure-csrf-token": token.csrfToken }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  }, { path, body, method });
}
async function readSnapshot() {
  // Use the real browser cookie policy, including Secure cookies on loopback.
  // The separate HTTP request client treats plain loopback differently.
  const result = await page.evaluate(async () => {
    const response = await fetch("/api/knowledge-center?" + new URLSearchParams({ workspaceId: window.knowledgeWorkspace }), { cache: "no-store" });
    return { status: response.status, body: await response.json() };
  });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return result.body.snapshot;
}
function totp(secret) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567", bytes = [];
  let accumulator = 0, bits = 0;
  for (const character of secret) {
    accumulator = (accumulator << 5) | alphabet.indexOf(character); bits += 5;
    if (bits >= 8) { bits -= 8; bytes.push((accumulator >>> bits) & 255); accumulator &= (1 << bits) - 1; }
  }
  const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const digest = createHmac("sha1", Buffer.from(bytes)).update(counter).digest();
  return String((digest.readUInt32BE(digest.at(-1) & 15) & 0x7fffffff) % 1000000).padStart(6, "0");
}
try {
  await step("anonymous Knowledge API denies access", async () => {
    assert.equal((await page.request.get(fixture.baseUrl + "/api/knowledge-center", { timeout: 120000 })).status(), 401);
  });
  await step("ordinary password and real TOTP enrollment create the session", async () => {
    await page.goto(fixture.baseUrl + "/login?languagePreference=de&lang=de");
    await page.locator("#login-email").fill(fixture.email);
    await page.locator("#login-password").fill(fixture.password);
    await Promise.all([page.waitForNavigation(), page.locator("form:has(#login-password) button[type=submit]").click({ timeout: 120000 })]);
    const secret = (await page.locator("p").filter({ has: page.locator("strong", { hasText: "TOTP-Schlüssel:" }) }).locator("code").innerText()).trim();
    await page.locator("input[name=recoveryCodesSaved]").check();
    await page.locator("#login-mfa-code").fill(totp(secret));
    await Promise.all([page.waitForNavigation(), page.getByRole("button", { name: "Sicher bestätigen", exact: true }).click({ timeout: 120000 })]);
    await expect(page).not.toHaveURL(/\/login/);
    assert.ok((await context.cookies()).some(cookie => cookie.name === "novalure_session" && cookie.httpOnly && cookie.value.startsWith("v2.")));
  });
  await step("disabled module shows an honest state with no sample knowledge", async () => {
    await page.goto(fixture.baseUrl + "/?lang=de&workspaceId=" + fixture.workspaceId + "&projectId=all#knowledge");
    await expect(page.getByRole("heading", { name: "Mein Unternehmenswissen", exact: true })).toBeVisible();
    await expect(page.getByText("Das Knowledge-Modul ist nicht freigeschaltet.", { exact: true })).toBeVisible();
    await page.evaluate(workspace => { window.knowledgeWorkspace = workspace; }, fixture.workspaceId);
    assert.equal((await api("/api/knowledge-center/areas", { name: "SYNTHETIC denied", kind: "company" })).status, 403);
  });
  // Only this isolated synthetic database is provisioned. This is not a Stripe
  // checkout, real customer subscription or production module activation.
  await admin.query(`insert into knowledge_center_entitlements(workspace_id,enabled,max_sources,max_storage_bytes,max_queries_per_month,contract_reference,features,limits)
    values($1,true,20,10485760,50,'SYNTHETIC-BROWSER-ONLY','{"websiteImport":true,"webchatAccess":true,"voiceAccess":true}'::jsonb,'{"maxAreas":10,"maxWebsites":3,"maxScansPerMonth":3,"maxUsers":5,"maxAssistants":5}'::jsonb)`, [fixture.workspaceId]);
  await admin.query("insert into bots(id,workspace_id,project_id,name,role) values($1,$2,$3,'SYNTHETIC Knowledge Bot','advisor')", [botId,fixture.workspaceId,fixture.projectId]);
  await page.reload();
  await page.evaluate(workspace => { window.knowledgeWorkspace = workspace; }, fixture.workspaceId);
  await step("area and source forms persist real scoped drafts", async () => {
    await page.getByRole("button", { name: /^Wissensbereiche \(/ }).click();
    await page.getByRole("button", { name: "Bereich erstellen", exact: true }).click();
    const form = page.locator("form").filter({ has: page.getByRole("heading", { name: "Bereich erstellen" }) });
    await form.getByLabel("Name", { exact: true }).fill("SYNTHETIC Firmenwissen");
    await form.getByRole("button", { name: "Speichern", exact: true }).click();
    await expect(page.getByText("Änderung gespeichert.", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: /^Wissensquellen \(/ }).click();
    await page.getByRole("button", { name: "Wissen hinzufügen", exact: true }).click();
    const sourceForm = page.locator("form").filter({ has: page.getByRole("heading", { name: "Wissen hinzufügen" }) });
    await sourceForm.getByLabel("Wissensbereich", { exact: true }).selectOption({ label: "SYNTHETIC Firmenwissen" });
    await sourceForm.getByLabel("Name", { exact: true }).fill("SYNTHETIC Öffnungszeiten");
    await sourceForm.getByLabel("Inhalt", { exact: true }).fill("SYNTHETIC mango: geöffnet ab 09:00 Uhr.");
    await sourceForm.getByRole("button", { name: "Speichern", exact: true }).click();
    await expect(page.getByRole("heading", { name: "SYNTHETIC Öffnungszeiten", exact: true })).toBeVisible();
    const snapshot = await readSnapshot(); sourceId = snapshot.sources[0].id;
    assert.equal(snapshot.sources[0].version.status, "draft");
  });
  await step("explicit assistant assignment never activates an unpublished draft", async () => {
    await page.getByRole("button", { name: "KI-Zuordnungen", exact: true }).click();
    await page.getByLabel("KI-Assistent", { exact: true }).selectOption(botId);
    await page.getByRole("checkbox", { name: /SYNTHETIC Firmenwissen/ }).check();
    await page.getByRole("button", { name: "Zuordnungen speichern", exact: true }).click();
    await expect(page.getByText("Wissenszuordnungen gespeichert.", { exact: true })).toBeVisible();
    const response = await api("/api/knowledge-center/query", { query: "mango", botId, channel: "webchat" });
    assert.equal(response.status, 200); assert.equal(response.body.matches.length, 0);
  });
  await step("admin publication uses an exact version and subsequent edits remain drafts", async () => {
    let source = (await readSnapshot()).sources.find(item => item.id === sourceId);
    const publication = await api("/api/knowledge-center/publish", { sourceId,versionId:source.version.id,expectedVersion: source.revision });
    assert.equal(publication.status, 200);
    let query = await api("/api/knowledge-center/query", { query: "mango",botId,channel: "webchat" });
    assert.equal(query.status,200); assert.equal(query.body.matches.length,1);
    source = (await readSnapshot()).sources.find(item => item.id === sourceId);
    const edit = await api("/api/knowledge-center/versions", { sourceId,expectedVersion:source.revision,content:"SYNTHETIC mango: neuer Entwurf ab 11:00 Uhr." });
    assert.equal(edit.status,201);
    query = await api("/api/knowledge-center/query", { query:"mango",botId,channel:"webchat" });
    assert.equal(query.body.matches.length,1); assert.match(query.body.matches[0].excerpt,/09:00/); assert.doesNotMatch(query.body.matches[0].excerpt,/11:00/);
  });
  await step("PDF and DOCX upload through the UI expose extracted text for explicit review", async () => {
    await page.getByRole("button", { name: /^Wissensquellen \(/ }).click();
    const fixtures = [
      { name: "SYNTHETIC Unternehmen PDF", file: "company.pdf", mime: "application/pdf", bytes: await createTextPdf(["SYNTHETIC officeknowledge: Office opens at 09:00."]), text: "officeknowledge" },
      { name: "SYNTHETIC Leistungen DOCX", file: "services.docx", mime: DOCX_MIME, bytes: createDocx(), text: "Table two" },
    ];
    for (const item of fixtures) {
      await page.getByRole("button", { name: "Datei hochladen", exact: true }).click();
      const form = page.locator("form").filter({ has: page.getByRole("heading", { name: "Wissen hinzufügen", exact: true }) });
      await form.getByLabel("Wissensbereich", { exact: true }).selectOption({ label: "SYNTHETIC Firmenwissen" });
      await form.getByLabel("Name (optional)", { exact: true }).fill(item.name);
      await form.getByLabel("Privates Dokument hochladen", { exact: true }).setInputFiles({ name: item.file, mimeType: item.mime, buffer: Buffer.from(item.bytes) });
      const card = page.locator("li").filter({ has: page.getByRole("heading", { name: item.name, exact: true }) });
      await expect(card.getByText("Inhalt erkannt · Bitte prüfen", { exact: true })).toBeVisible();
      await publishThroughUi(card, item.text);
      await expect(card.getByText("Für Assistenten aktive Version", { exact: true }).first()).toBeVisible();
    }
  });
  await step("one approved document serves independently assigned webchat and voice; revocation is immediate", async () => {
    await page.getByRole("button", { name: "KI-Zuordnungen", exact: true }).click();
    await page.getByLabel("KI-Assistent", { exact: true }).selectOption(botId);
    await page.getByRole("button", { name: "Telefonassistent", exact: true }).click();
    await page.getByRole("checkbox", { name: /SYNTHETIC Firmenwissen/ }).check();
    await page.getByRole("button", { name: "Zuordnungen speichern", exact: true }).click();
    await expect(page.getByText("Wissenszuordnungen gespeichert.", { exact: true })).toBeVisible();
    const webchat = await api("/api/knowledge-center/query", { query: "officeknowledge", botId, channel: "webchat" });
    const voice = await api("/api/knowledge-center/query", { query: "officeknowledge", botId, channel: "voice" });
    assert.equal(webchat.status, 200); assert.equal(voice.status, 200);
    assert.equal(webchat.body.matches.length, 1); assert.deepEqual(voice.body.matches, webchat.body.matches);
    await page.getByRole("checkbox", { name: /SYNTHETIC Firmenwissen/ }).uncheck();
    await page.getByRole("button", { name: "Zuordnungen speichern", exact: true }).click();
    await expect(page.getByText("Wissenszuordnungen gespeichert.", { exact: true })).toBeVisible();
    assert.equal((await api("/api/knowledge-center/query", { query: "officeknowledge", botId, channel: "voice" })).body.matches.length, 0);
    assert.equal((await api("/api/knowledge-center/query", { query: "officeknowledge", botId, channel: "webchat" })).body.matches.length, 1);
  });
  await step("scan PDFs show an actionable OCR state and have no approval button", async () => {
    await page.getByRole("button", { name: /^Wissensquellen \(/ }).click();
    await page.getByRole("button", { name: "Datei hochladen", exact: true }).click();
    const form = page.locator("form").filter({ has: page.getByRole("heading", { name: "Wissen hinzufügen", exact: true }) });
    await form.getByLabel("Wissensbereich", { exact: true }).selectOption({ label: "SYNTHETIC Firmenwissen" });
    await form.getByLabel("Name (optional)", { exact: true }).fill("SYNTHETIC Scan ohne Textebene");
    await form.getByLabel("Privates Dokument hochladen", { exact: true }).setInputFiles({ name: "scan.pdf", mimeType: "application/pdf", buffer: Buffer.from(await createScanPdf()) });
    const card = page.locator("li").filter({ has: page.getByRole("heading", { name: "SYNTHETIC Scan ohne Textebene", exact: true }) });
    await expect(card.getByText("Lesbare Textfassung erforderlich", { exact: true })).toBeVisible();
    await expect(card.getByRole("button", { name: "Diese Version freigeben", exact: true })).toHaveCount(0);
  });
  await step("reviewed draft publication and historical restoration work through the customer portal", async () => {
    const card = page.locator("li").filter({ has: page.getByRole("heading", { name: "SYNTHETIC Öffnungszeiten", exact: true }) });
    await publishThroughUi(card);
    assert.match((await api("/api/knowledge-center/query", { query: "mango", botId, channel: "webchat" })).body.matches[0].excerpt, /11:00/);
    const lifecycle = card.getByTestId("knowledge-lifecycle");
    const history = lifecycle.getByTestId("knowledge-version-history");
    await history.locator("summary").click();
    await history.getByRole("combobox").selectOption({ label: await history.getByRole("combobox").locator("option").last().innerText() });
    await history.locator("textarea").fill("SYNTHETIC geprüfte Wiederherstellung");
    await expect(history.getByTestId("knowledge-restore")).toBeDisabled();
    await history.getByRole("checkbox", { name: /weiterhin aktuell/ }).check();
    await history.getByRole("checkbox", { name: /rechtliche Angaben/ }).check();
    await history.getByTestId("knowledge-restore").click();
    await expect(lifecycle.getByTestId("knowledge-submit")).toBeVisible();
    const source = (await readSnapshot()).sources.find(item => item.id === sourceId);
    assert.equal(source.version.version, 3);
    assert.match(source.version.content, /09:00/);
    assert.match((await api("/api/knowledge-center/query", { query: "mango", botId, channel: "webchat" })).body.matches[0].excerpt, /11:00/);
    await lifecycle.locator("form textarea").first().fill("SYNTHETIC Veröffentlichung trotz neuem Entwurf zurückziehen");
    await lifecycle.getByTestId("knowledge-revoke").click();
    await expect.poll(async () => (await readSnapshot()).sources.find(item => item.id === sourceId).approvedVersionId).toBe(null);
    assert.equal((await api("/api/knowledge-center/query", { query: "mango", botId, channel: "webchat" })).body.matches.length, 0);
  });
  await step("website monitoring schedules are customer configurable and remain isolated from live publishing", async () => {
    const snapshot = await readSnapshot();
    await admin.query(`update knowledge_center_entitlements set features=features||'{"monitoring":true,"advancedMaintenance":true}'::jsonb,monitoring_intervals=array['manual','daily','weekly','monthly']::text[] where workspace_id=$1`, [fixture.workspaceId]);
    const response = await api("/api/knowledge-center/sources", { areaId: snapshot.areas.find(item => item.name === "SYNTHETIC Firmenwissen").id, name: "SYNTHETIC Unternehmenswebsite", type: "url", url: "https://company.com", content: "SYNTHETIC website facts." });
    assert.equal(response.status, 201);
    await page.getByRole("region", { name: "Mein Unternehmenswissen", exact: true }).getByRole("button", { name: "Aktualisieren", exact: true }).click();
    const card = page.locator("li").filter({ has: page.getByRole("heading", { name: "SYNTHETIC Unternehmenswebsite", exact: true }) });
    await card.getByRole("button", { name: "Websiteüberwachung", exact: true }).click();
    const monitoring = card.getByTestId("knowledge-monitoring");
    await monitoring.getByTestId("knowledge-monitoring-interval").selectOption("daily");
    await monitoring.getByTestId("knowledge-monitoring-save").click();
    await expect(monitoring.getByRole("status")).toHaveText("Änderung gespeichert.");
    const stored = (await admin.query("select interval,enabled,next_due_at is not null as scheduled from knowledge_website_monitoring where source_id=$1", [response.body.source.id])).rows[0];
    assert.deepEqual(stored, { interval: "daily", enabled: true, scheduled: true });
    assert.equal((await admin.query("select count(*)::int as count from knowledge_website_scan_runs")).rows[0].count, 0);
    await monitoring.getByTestId("knowledge-monitoring-interval").selectOption("manual");
    await monitoring.getByTestId("knowledge-monitoring-save").click();
    await expect(monitoring.getByRole("status")).toHaveText("Änderung gespeichert.");
    await expect.poll(async () => (await admin.query("select enabled from knowledge_website_monitoring where source_id=$1", [response.body.source.id])).rows[0].enabled).toBe(false);
  });
  await step("maintenance analysis produces persistent customer-reviewable proposals without publishing", async () => {
    await page.getByRole("button", { name: "Wissenspflege", exact: true }).click();
    await page.getByRole("button", { name: "Wissen jetzt prüfen", exact: true }).click();
    await expect(page.getByText("Prüfung abgeschlossen. Neue Hinweise stehen in den Prüfvorschlägen.", { exact: true })).toBeVisible();
    const proposal = page.locator("article").filter({ hasText: "SYNTHETIC Unternehmenswebsite" }).first();
    await proposal.getByRole("button", { name: "Vorschlag prüfen", exact: true }).click();
    await proposal.getByRole("textbox", { name: /^Vorgeschlagener Inhalt/ }).fill("SYNTHETIC website: approved customer draft ALPHA.");
    await proposal.getByRole("textbox", { name: /^Begründung für die Entscheidung/ }).fill("SYNTHETIC Information geprüft");
    await proposal.getByRole("button", { name: "Vorschlag speichern", exact: true }).click();
    await expect(page.getByText("Änderungen am Vorschlag gespeichert.", { exact: true })).toBeVisible();
    await proposal.getByRole("textbox", { name: /^Begründung für die Entscheidung/ }).fill("SYNTHETIC als Entwurf übernehmen");
    await proposal.getByRole("button", { name: "Annehmen und Entwurf erstellen", exact: true }).click();
    await expect(page.getByText("Vorschlag angenommen. Der neue Entwurf muss noch separat geprüft, freigegeben und veröffentlicht werden.", { exact: true })).toBeVisible();
    const source = (await readSnapshot()).sources.find(item => item.name === "SYNTHETIC Unternehmenswebsite");
    assert.equal(source.version.version, 2);
    assert.equal(source.approvedVersionId, null);
    assert.match(source.version.content, /ALPHA/);
    await page.getByRole("tab", { name: "Benachrichtigungen", exact: true }).click();
    await expect(page.getByRole("tabpanel")).toContainText("SYNTHETIC Unternehmenswebsite");
  });
  await step("desktop and mobile views remain usable without horizontal overflow", async () => {
    await page.getByRole("button", { name: /^Wissensquellen \(/ }).click();
    await page.getByRole("region", { name: "Mein Unternehmenswissen", exact: true }).getByRole("button", { name: "Aktualisieren", exact: true }).click();
    await expect(page.getByRole("heading", { name: "SYNTHETIC Öffnungszeiten",exact:true })).toBeVisible();
    await mkdir(".npm-cache/qa/knowledge",{recursive:true});
    await page.screenshot({path:".npm-cache/qa/knowledge/desktop.png",fullPage:true});
    await page.setViewportSize({width:390,height:844});
    await expect(page.getByRole("heading",{name:"Mein Unternehmenswissen",exact:true})).toBeVisible();
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2));
    const controls = page.getByRole("region",{name:"Mein Unternehmenswissen",exact:true}).getByRole("button");
    for (const control of await controls.all()) {
      if (!await control.isVisible()) continue;
      const box = await control.evaluate(element => {
        // Replacement inputs are visually hidden inside their full-size label.
        // Measure the actual associated touch target for those native controls.
        const target = element.matches('input[type="file"].sr-only') ? element.closest("label") : element;
        const rect = target?.getBoundingClientRect();
        return rect ? { width: rect.width, height: rect.height } : null;
      });
      assert.ok(box && box.width >= 44 && box.height >= 44,
        `Knowledge actions must retain 44px touch targets: ${await control.innerText()} ${JSON.stringify(box)}`);
    }
    await page.screenshot({path:".npm-cache/qa/knowledge/mobile.png",fullPage:true});
    assert.deepEqual(pageErrors,[]);
  });
} catch(error) {
  results.push({status:"FAIL",error:error.message});
  await page.screenshot({path:".npm-cache/qa/knowledge-browser-failure.png",fullPage:true}).catch(()=>{});
  throw error;
} finally {
  await writeFile(".npm-cache/qa/knowledge-browser-result.json",JSON.stringify({syntheticOnly:true,productionAccess:0,ordinaryPasswordAndMfa:true,results,pageErrors},null,2));
  await context.close(); await browser.close(); await admin.end();
}
