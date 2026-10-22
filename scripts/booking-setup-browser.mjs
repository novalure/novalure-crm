// Auftrag 2: customer setup through real UI → HTTP/CSRF → disposable PostgreSQL.
// No hosted fixture reset, provider calls, live messages or scheduler proof.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import pg from "pg";
import { chromium, expect } from "@playwright/test";
import { seedDesignCIntegration, startDesignCIntegrationDatabase } from "./lib/design-c-integration-fixture.mjs";

const output = path.resolve(".npm-cache/qa/booking-setup-browser");
await mkdir(output, { recursive: true });
for (const file of [".env", ".env.local", ".env.development", ".env.development.local"]) {
  try { await readFile(file); throw new Error("Refusing browser QA with environment files"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
}
let db, owner, server, browser, serverDone;
const checks = [], errors = [], outbound = [], pageErrors = [];
let activeCheck = "bootstrap";
const check = async (name, action) => { activeCheck = name; await action(); checks.push({ name, passed: true }); console.log(JSON.stringify({ check: name, passed: true })); };
function totp(secret) {
  let accumulator = 0, bits = 0; const bytes = [];
  for (const character of secret) {
    const value = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567".indexOf(character); assert(value >= 0);
    accumulator = (accumulator << 5) | value; bits += 5;
    if (bits >= 8) { bits -= 8; bytes.push((accumulator >>> bits) & 255); accumulator &= (1 << bits) - 1; }
  }
  const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const digest = createHmac("sha1", Buffer.from(bytes)).update(counter).digest();
  return String((digest.readUInt32BE(digest.at(-1) & 15) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}
async function request(page, url, method = "GET", body, csrf = true) {
  return page.evaluate(async ({ url, method, body, csrf }) => {
    const headers = { "content-type": "application/json" };
    if (method !== "GET" && csrf) {
      const token = await fetch(`/api/auth/csrf?${new URLSearchParams({ method, path: url.split("?")[0] })}`, { cache: "no-store" });
      headers["x-novalure-csrf-token"] = (await token.json()).csrfToken;
    }
    const response = await fetch(url, { method, headers, cache: "no-store", ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json().catch(() => ({})), cacheControl: response.headers.get("cache-control") };
  }, { url, method, body, csrf });
}
async function waitForClientSetup(page) {
  return page.waitForResponse(response => new URL(response.url()).pathname === "/api/booking/setup" && response.request().method() === "GET" && response.status() === 200);
}
async function reloadBooking(page) {
  await Promise.all([waitForClientSetup(page),page.reload({waitUntil:"domcontentloaded"})]);
}
async function login(page, base, account) {
  await page.goto(`${base}/login?lang=de`, { waitUntil: "domcontentloaded" });
  const consent = page.getByRole("button", { name: /^(Nur essenzielle|Only necessary)$/ });
  await expect(consent).toBeVisible({ timeout: 15_000 }); await consent.click();
  await page.locator("#login-email").fill(account.email);
  await page.locator("#login-password").fill(account.password);
  await Promise.all([page.waitForNavigation({ waitUntil: "domcontentloaded" }), page.locator("form:has(#login-password) button[type=submit]").click()]);
  await page.waitForURL(url => url.pathname !== "/login" || ["workspace_selection", "mfa_enrollment", "mfa_verification"].includes(url.searchParams.get("step")), { timeout: 15_000 });
  if (new URL(page.url()).searchParams.get("step") === "workspace_selection") {
    const choice = page.getByRole("button", { name: account.name, exact: true });
    await expect(choice).toBeVisible();
    await Promise.all([page.waitForNavigation({ waitUntil: "domcontentloaded" }), choice.click()]);
    await page.waitForURL(url => url.searchParams.get("step") !== "workspace_selection", { timeout: 15_000 });
  }
  if (account.requiresMfa !== false) {
    const key = page.locator("p").filter({ has: page.locator("strong", { hasText: /TOTP-Schlüssel:|TOTP key:/ }) }).locator("code");
    await expect(key).toBeVisible(); const secret = (await key.innerText()).trim();
    assert.equal((await request(page, "/api/booking/settings")).status, 401);
    await page.locator("input[name=recoveryCodesSaved]").check();
    await page.locator("#login-mfa-code").fill(totp(secret));
    await Promise.all([page.waitForNavigation({ waitUntil: "domcontentloaded" }), page.getByRole("button", { name: /^(Sicher bestätigen|Verify securely)$/ }).click()]);
  }
  await page.waitForURL(url => url.pathname !== "/login", {timeout:30_000});
  await page.waitForLoadState("domcontentloaded");
  assert.equal((await request(page, "/api/settings/language", "POST", {preference:"de",expectedUserId:account.userId})).status,200);
  if (account.requiresMfa !== false) await Promise.all([waitForClientSetup(page),page.goto(`${base}/booking`, { waitUntil: "domcontentloaded" })]);
  else await page.goto(`${base}/booking`, {waitUntil:"domcontentloaded"});
}
try {
  db = await startDesignCIntegrationDatabase();
  assert.equal(db.database, "neondb"); assert(/^sales_qa_[a-f0-9]+$/.test(db.role));
  owner = new pg.Pool({ host: "127.0.0.1", port: db.port, user: "neondb_owner", database: db.database });
  const client = await owner.connect();
  try {
    await client.query("begin");
    for (const name of ["108_universal_booking.sql", "109_booking_setup_communications.sql", "110_account_ui_language_preference.sql"]) {
      const sql = await readFile(`migrations/${name}`, "utf8");
      await client.query(sql);
    }
    await client.query("commit");
  }
  catch (error) { await client.query("rollback"); throw error; } finally { client.release(); }
  const accounts = await seedDesignCIntegration({ admin: db.admin, role: db.role });
  for (const account of [accounts.operator, accounts.customer]) await db.admin.query("insert into workspace_module_settings(workspace_id,module_key,enabled) values($1,'calendar',true) on conflict(workspace_id,module_key) do update set enabled=true", [account.workspaceId]);
  const port = await new Promise((resolve, reject) => { const socket = net.createServer(); socket.on("error", reject); socket.listen(0, "127.0.0.1", () => { const value = socket.address().port; socket.close(() => resolve(value)); }); });
  const base = `http://127.0.0.1:${port}`;
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(path|home|systemroot|windir|temp|tmp|tmpdir|lang|lc_all)$/i.test(key)));
  Object.assign(env, { NODE_ENV: "development", NEXT_TELEMETRY_DISABLED: "1", CRM_LOCAL_TEST_DATABASE: "1", DATABASE_URL: `postgresql://${db.role}@127.0.0.1:${db.port}/${db.database}`, NOVALURE_APP_ORIGIN: base, NEXT_PUBLIC_APP_URL: base, BOOKING_ENGINE_ENABLED: "1" });
  for (const key of ["NOVALURE_SESSION_SECRET", "NOVALURE_AUTH_ENCRYPTION_KEY", "NOVALURE_AUTH_RATE_LIMIT_SECRET", "OAUTH_STATE_SECRET", "NOVALURE_ABUSE_SECRET", "OAUTH_TOKEN_ENCRYPTION_KEY"]) env[key] = randomBytes(40).toString("hex");
  server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "dev", "--webpack", "--hostname", "127.0.0.1", "--port", String(port)], { env, stdio: ["ignore", "pipe", "pipe"] });
  serverDone = new Promise(resolve => { server.once("exit", resolve); server.once("error", resolve); });
  server.stdout.resume(); server.stderr.resume();
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    if (server.exitCode !== null) throw new Error("Owned Next QA server exited");
    try { const response = await fetch(`${base}/login`, { signal: AbortSignal.timeout(5_000) }); if (response.ok) { ready = true; break; } } catch { /* Bounded startup probe. */ }
    await new Promise(resolve => setTimeout(resolve, 1_000));
  }
  assert(ready, "Owned Next QA server must become ready");
  browser = await chromium.launch({ headless: true, executablePath: process.env.CRM_QA_CHROMIUM_PATH || "/usr/bin/chromium", args: ["--no-sandbox"] });
  async function pageFor() {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: "de-AT", timezoneId: "Europe/Vienna" });
    await context.route("**/*", route => { const url = new URL(route.request().url()); if (url.origin === base || ["data:", "blob:"].includes(url.protocol)) return route.continue(); outbound.push(`${url.origin}${url.pathname}`); return route.abort(); });
    const page = await context.newPage(); page.setDefaultTimeout(30_000); page.on("pageerror", error => pageErrors.push(error.message)); return page;
  }
  const operator = await pageFor();
  const setupPath = "/api/booking/setup";
  const openStep = async (page, name) => {
    const control=page.getByRole("tab", {name,exact:true}).or(page.getByRole("button", {name,exact:true}));
    await control.click();
    await expect(control).toHaveAttribute("aria-current","step");
  };
  await check("Anonymous setup API is denied", async () => {
    await operator.goto(`${base}/booking`);
    assert.equal((await request(operator, setupPath)).status,401);
  });
  await check("Real password and MFA open the five-step DE setup", async () => {
    await login(operator,base,accounts.operator);
    await expect(operator.getByRole("heading", {name:"Terminbuchung",exact:true})).toBeVisible();
    for (const name of ["Kalender","Terminarten & Zeiten","Standorte & Fahrtzeiten","E-Mails & Erinnerungen","Veröffentlichen"]) {
      await expect(operator.getByRole("tab", {name,exact:true}).or(operator.getByRole("button", {name,exact:true}))).toBeVisible();
    }
    const response = await request(operator,setupPath);
    assert.equal(response.status,200);
    assert.match(response.cacheControl,/no-store/);
    assert.equal(response.body.canManageCompany,true);
  });
  await check("Disconnected calendars keep confirmation disabled", async () => {
    await expect(operator.getByRole("button", {name:"Verfügbarkeit prüfen",exact:true})).toBeDisabled();
    await expect(operator.getByRole("button", {name:"Zeit reservieren",exact:true})).toBeDisabled();
    assert.equal((await request(operator,"/api/booking/connections")).body.connections.length,0);
  });
  await check("DE appointment request persists once without provider or message effects", async () => {
    await operator.getByLabel("Titel",{exact:true}).fill("SYNTHETIC BOOKING REQUEST A");
    await operator.getByLabel(/Gewünschter Zeitpunkt/).fill("2026-11-02T10:00");
    for (let attempt=0;attempt<2;attempt++) {
      await operator.getByRole("button",{name:"Terminwunsch aufnehmen",exact:true}).click();
      await expect(operator.getByRole("status")).toContainText("Es wurde kein Kalendereintrag angelegt.");
    }
    const rows=await db.admin.query("select id,status,calendar_provider,metadata from meeting_bookings where workspace_id=$1 and title='SYNTHETIC BOOKING REQUEST A'",[accounts.operator.workspaceId]);
    assert.equal(rows.rowCount,1);
    assert.equal(rows.rows[0].status,"requested");
    assert.equal(rows.rows[0].calendar_provider,"none");
    assert.equal(rows.rows[0].metadata.providerCreated,false);
    assert.equal((await db.admin.query("select count(*)::int as count from booking_message_jobs")).rows[0].count,0);
  });
  await check("Missing CSRF and foreign workspace cannot write setup", async () => {
    const payload={scope:"employee",kind:"phone",section:"rules",value:{durationMinutes:45}};
    assert.equal((await request(operator,setupPath,"PUT",payload,false)).status,403);
    assert.equal((await request(operator,`${setupPath}?workspaceId=${accounts.customer.workspaceId}`)).status,403);
  });
  await check("Company rules save in DE UI, persist and reload", async () => {
    await openStep(operator,"Terminarten & Zeiten");
    await operator.getByRole("combobox",{name:/^Einstellungen für/}).first().selectOption("company");
    await operator.getByRole("combobox",{name:/^Terminart/}).first().selectOption("phone");
    await operator.getByLabel(/^Dauer \(Minuten\)/).fill("45");
    await operator.getByLabel(/^Vorbereitung \(Minuten\)/).fill("5");
    await operator.getByLabel(/^Nachbereitung \(Minuten\)/).fill("10");
    await operator.getByRole("button",{name:"Einstellungen speichern",exact:true}).click();
    await expect.poll(async ()=>(await request(operator,setupPath)).body.companyDefaults.phone.rules.durationMinutes).toBe(45);
    const rows=await db.admin.query("select rules from booking_rule_sets where workspace_id=$1 and user_id is null and kind='phone'",[accounts.operator.workspaceId]);
    assert.equal(rows.rowCount,1);
    assert.equal(rows.rows[0].rules.preparationMinutes,5);
    assert.equal(rows.rows[0].rules.followupMinutes,10);
    await reloadBooking(operator);
    await openStep(operator,"Terminarten & Zeiten");
    await operator.getByRole("combobox",{name:/^Einstellungen für/}).first().selectOption("company");
    await operator.getByRole("combobox",{name:/^Terminart/}).first().selectOption("phone");
    await expect(operator.getByLabel(/^Dauer \(Minuten\)/)).toHaveValue("45");
  });
  await check("Employee override and reset return to actual company default", async () => {
    await operator.getByRole("combobox",{name:/^Einstellungen für/}).first().selectOption("employee");
    await operator.getByLabel(/^Dauer \(Minuten\)/).fill("55");
    await operator.getByRole("button",{name:"Einstellungen speichern",exact:true}).click();
    await expect.poll(async ()=>(await request(operator,setupPath)).body.effective.phone.rules.durationMinutes).toBe(55);
    await operator.getByRole("button",{name:"Auf Unternehmensstandard zurücksetzen",exact:true}).click();
    await expect.poll(async ()=>(await request(operator,setupPath)).body.effective.phone.rules.durationMinutes).toBe(45);
    await expect(operator.getByLabel(/^Dauer \(Minuten\)/)).toHaveValue("45");
  });
  await check("Invalid range is rejected without changing persisted rules", async () => {
    const result=await request(operator,setupPath,"PUT",{scope:"employee",kind:"phone",section:"rules",value:{durationMinutes:0}});
    assert.equal(result.status,400);
    assert.equal((await request(operator,setupPath)).body.effective.phone.rules.durationMinutes,45);
  });
  await check("Company reset ignores employee-wide overrides and follows future company changes", async () => {
    assert.equal((await request(operator,setupPath,"PUT",{scope:"employee",kind:"*",section:"rules",value:{durationMinutes:55}})).status,200);
    await operator.getByLabel(/^Dauer \(Minuten\)/).fill("60");
    await operator.getByRole("button",{name:"Einstellungen speichern",exact:true}).click();
    await expect.poll(async ()=>(await request(operator,setupPath)).body.effective.phone.rules.durationMinutes).toBe(60);
    await operator.getByRole("button",{name:"Auf Unternehmensstandard zurücksetzen",exact:true}).click();
    await expect.poll(async ()=>(await request(operator,setupPath)).body.effective.phone.rules.durationMinutes).toBe(45);
    assert.equal((await request(operator,setupPath,"PUT",{scope:"company",kind:"phone",section:"rules",value:{durationMinutes:50}})).status,200);
    assert.equal((await request(operator,setupPath)).body.effective.phone.rules.durationMinutes,50);
    assert.equal((await request(operator,setupPath,"PUT",{scope:"company",kind:"phone",section:"rules",value:{durationMinutes:45}})).status,200);
  });
  await check("Confirmed travel locations and custom buffer save and reload through UI", async () => {
    await openStep(operator,"Standorte & Fahrtzeiten");
    await operator.getByRole("combobox",{name:/^Einstellungen für/}).first().selectOption("employee");
    await operator.getByRole("combobox",{name:/^Terminart/}).first().selectOption("phone");
    await operator.getByRole("button",{name:"Ort hinzufügen",exact:true}).click();
    await operator.getByLabel("Bezeichnung",{exact:true}).fill("SYNTHETIC QA office");
    await operator.getByLabel("Vollständige Adresse",{exact:true}).fill("SYNTHETIC test address, Vienna");
    await operator.getByRole("checkbox",{name:"Ich bestätige diese eindeutige Adresse",exact:true}).check();
    await operator.getByLabel(/^Büro beziehungsweise Tagesstartort/).selectOption({index:1});
    await operator.getByLabel(/^Teilnahmeort bei Online- und Telefonterminen/).selectOption({index:1});
    await operator.getByRole("checkbox",{name:"Fahrtzeit bei Außenterminen automatisch einplanen",exact:true}).check();
    await operator.getByLabel(/^Zusätzlicher Puffer je Fahrt \(Minuten\)/).fill("17");
    await operator.getByRole("button",{name:"Einstellungen speichern",exact:true}).click();
    await expect.poll(async ()=>(await request(operator,setupPath)).body.effective.phone.travel.additionalBufferMinutes).toBe(17);
    const setup=(await request(operator,setupPath)).body.effective.phone;
    assert.equal(setup.travel.enabled,true);
    assert.equal(setup.travel.locations[0].confirmed,true);
    assert.equal(setup.travel.startLocationId,setup.travel.locations[0].id);
    await reloadBooking(operator);
    await openStep(operator,"Standorte & Fahrtzeiten");
    await operator.getByRole("combobox",{name:/^Terminart/}).first().selectOption("phone");
    await expect(operator.getByLabel(/^Zusätzlicher Puffer je Fahrt \(Minuten\)/)).toHaveValue("17");
    await expect(operator.getByRole("checkbox",{name:"Fahrtzeit bei Außenterminen automatisch einplanen",exact:true})).toBeChecked();
  });
  await check("DE and EN templates plus multiple custom reminders persist", async () => {
    await openStep(operator,"E-Mails & Erinnerungen");
    await operator.getByRole("combobox",{name:/^Terminart/}).first().selectOption("phone");
    await operator.getByRole("textbox",{name:/^Firmenname/}).first().fill("SYNTHETIC QA company");
    await operator.getByRole("textbox",{name:/^Antwortadresse/}).first().fill("synthetic-reply@example.invalid");
    await operator.getByRole("checkbox",{name:"CRM-E-Mails und Erinnerungen aktivieren",exact:true}).check();
    await operator.getByRole("combobox",{name:/^Vorlagensprache/}).selectOption("de");
    await operator.getByRole("textbox",{name:/^Betreff/}).first().fill("QA Termin für {{firstName}}");
    await operator.getByRole("textbox",{name:/^Nachricht/}).first().fill("Hallo {{firstName}}. QA {{date}} {{time}} {{timeZone}}.");
    await operator.getByRole("combobox",{name:/^Vorlagensprache/}).selectOption("en");
    await operator.getByRole("textbox",{name:/^Betreff/}).first().fill("QA appointment for {{firstName}}");
    await operator.getByRole("button",{name:"Erinnerung hinzufügen",exact:true}).click();
    await operator.getByLabel("Minuten vor dem Termin",{exact:true}).last().fill("60");
    await operator.getByLabel("Terminbeginn für die Versandvorschau (Browser-Zeitzone)",{exact:true}).fill("2026-11-02T10:00");
    await expect(operator.getByRole("heading",{name:/Geplanter Versand/})).toBeVisible();
    await operator.getByRole("button",{name:"Einstellungen speichern",exact:true}).click();
    await expect.poll(async ()=>(await request(operator,setupPath)).body.effective.phone.communication.reminders.length).toBe(3);
    const communication=(await request(operator,setupPath)).body.effective.phone.communication;
    assert.equal(communication.enabled,true);
    assert.equal(communication.templates.de.confirmation.subject,"QA Termin für {{firstName}}");
    assert.equal(communication.templates.en.confirmation.subject,"QA appointment for {{firstName}}");
    assert.equal(communication.reminders.at(-1).minutesBefore,60);
    const stored=await db.admin.query("select communication from booking_setup_sets where workspace_id=$1 and user_id=$2 and kind='phone'",[accounts.operator.workspaceId,accounts.operator.userId]);
    assert.equal(stored.rows[0].communication.reminders.length,3);
    await reloadBooking(operator);
    await openStep(operator,"E-Mails & Erinnerungen");
    await operator.getByRole("combobox",{name:/^Terminart/}).first().selectOption("phone");
    await operator.getByRole("combobox",{name:/^Vorlagensprache/}).selectOption("en");
    await expect(operator.getByRole("textbox",{name:/^Betreff/}).first()).toHaveValue("QA appointment for {{firstName}}");
    await expect(operator.getByLabel("Minuten vor dem Termin",{exact:true})).toHaveCount(3);
    await expect(operator.getByRole("button",{name:"Testmail an hello@novalure.eu",exact:true})).toBeDisabled();
  });
  await check("Template preview renders allowed placeholders and rejects executable content", async () => {
    await operator.getByRole("combobox",{name:/^Vorlagensprache/}).selectOption("de");
    await operator.getByRole("button",{name:"Vorschau",exact:true}).click();
    await expect(operator.getByRole("region",{name:"Beispielvorschau",exact:true})).toBeVisible();
    const body=await operator.frameLocator('iframe[title="Beispielvorschau"]').locator("body").innerText();
    assert(!/[{}]/.test(body));
    assert(body.includes("QA"));
    const communication=structuredClone((await request(operator,setupPath)).body.effective.phone.communication);
    communication.templates.de.confirmation.body='<script>alert(1)</script>';
    const result=await request(operator,setupPath,"PUT",{scope:"employee",kind:"phone",section:"communication",value:communication});
    assert.equal(result.status,400);
    assert(!((await request(operator,setupPath)).body.effective.phone.communication.templates.de.confirmation.body).includes("<script>"));
    await operator.getByRole("textbox",{name:/^Betreff/}).first().fill("{{notAllowed}}");
    await operator.getByRole("button",{name:"Vorschau",exact:true}).click();
    await expect(operator.getByRole("alert").filter({hasText:"Die Vorlage kann nicht angezeigt werden"})).toBeVisible();
  });
  await reloadBooking(operator);
  await openStep(operator,"Standorte & Fahrtzeiten");
  await operator.getByRole("combobox",{name:/^Terminart/}).first().selectOption("phone");
  await operator.screenshot({path:path.join(output,"booking-setup-de-desktop.png"),fullPage:true});
  const customer=await pageFor();
  await check("Second tenant has independent defaults and explicit EN UI on mobile", async () => {
    await login(customer,base,accounts.customer);
    assert.notEqual((await request(customer,setupPath)).body.effective.phone.rules.durationMinutes,45);
    assert.equal((await request(customer,"/api/settings/language","POST",{preference:"en",expectedUserId:accounts.customer.userId})).status,200);
    await reloadBooking(customer);
    await expect(customer.getByRole("heading",{name:"Appointment booking",exact:true})).toBeVisible();
    await customer.setViewportSize({width:390,height:844});
    for (const name of ["Calendar","Appointment types & hours","Locations & travel","Emails & reminders","Publish"]) {
      await openStep(customer,name);
      assert.equal(await customer.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);
    }
    await reloadBooking(customer);
    await expect(customer.getByRole("heading",{name:"Appointment booking",exact:true})).toBeVisible();
    assert.equal((await request(customer,`${setupPath}?workspaceId=${accounts.operator.workspaceId}`)).status,403);
  });
  await check("EN request and legacy settings API remain tenant-isolated",async()=>{
    await openStep(customer,"Calendar");
    await customer.getByLabel("Title",{exact:true}).fill("SYNTHETIC BOOKING REQUEST B");
    await customer.getByLabel(/Requested time/).fill("2026-11-03T11:00");
    await customer.getByRole("button",{name:"Save appointment request",exact:true}).click();
    await expect(customer.getByRole("status")).toContainText("No calendar event was created.");
    assert.deepEqual((await db.admin.query("select workspace_id from meeting_bookings where title like 'SYNTHETIC BOOKING REQUEST %' order by title")).rows.map(row=>row.workspace_id),[accounts.operator.workspaceId,accounts.customer.workspaceId]);
    assert.equal((await request(customer,`/api/booking/connections?workspaceId=${accounts.operator.workspaceId}`)).status,403);
    assert.equal((await request(customer,"/api/booking/settings","PUT",{kind:"phone",rules:{durationMinutes:45}})).status,200);
    const stored=await request(customer,"/api/booking/settings");
    assert(stored.body.overrides.some(item=>item.kind==="phone"&&item.rules.durationMinutes===45));
    assert.match(stored.cacheControl,/no-store/);
  });
  await openStep(customer,"Appointment types & hours");
  await customer.screenshot({path:path.join(output,"booking-setup-en-mobile.png"),fullPage:true});
  const viewer=await pageFor();
  await check("Viewer cannot access booking setup or write APIs",async()=>{
    await login(viewer,base,accounts.viewer);
    await expect(viewer.getByText("Für diesen Bereich benötigen Sie das Kalendermodul und die Berechtigung zur Kalenderverwaltung.",{exact:true})).toBeVisible();
    assert.equal((await request(viewer,setupPath)).status,403);
    assert.equal((await request(viewer,"/api/booking/settings")).status,403);
  });
  await check("No browser exception or external request",async()=>{assert.deepEqual(pageErrors,[]);assert.deepEqual(outbound,[]);});
} catch (error) {
  for (const context of browser?.contexts() ?? []) for (const page of context.pages()) {
    if (new URL(page.url()).pathname !== "/booking") continue;
    await page.screenshot({path:path.join(output,"failure-booking-setup.png"),fullPage:true}).catch(()=>{});
    const safeState=await page.locator("select").evaluateAll(nodes=>nodes.map(node=>({label:node.closest("label")?.innerText?.slice(0,120),options:[...node.options].map(option=>({value:option.value,disabled:option.disabled}))}))).catch(()=>[]);
    console.error(JSON.stringify({check:activeCheck,selects:safeState,alerts:await page.getByRole("alert").allTextContents().catch(()=>[])}));
  }
  errors.push({ check: activeCheck, code: error.code || error.name || "QA_FAILED" });
  console.error(JSON.stringify({ check: activeCheck, passed: false, errorType: error.name, detail: error.message?.split("\n")[0].replace(/[A-Za-z0-9+\/_=-]{24,}/g,"[redacted]"), source: error.stack?.split("\n").find(line => line.includes("booking-setup-browser.mjs"))?.trim() }));
  process.exitCode = 1;
} finally {
  await browser?.close();
  if (server && server.exitCode === null) { server.kill("SIGTERM"); await Promise.race([serverDone, new Promise(resolve => setTimeout(resolve, 10_000))]); if (server.exitCode === null) server.kill("SIGKILL"); }
  await owner?.end(); await db?.stop();
  const report = { syntheticOnly: true, realLoginMfaCsrfHttpPostgres: true, mockedProviderSuccess: false, productionAccess: 0, hostedDatabaseAccess: 0, providerCalls: 0, emailSent: false, schedulerProof: false, checks, errors, pageErrors, outbound };
  await writeFile(path.join(output, "result.json"), JSON.stringify(report, null, 2), {mode:0o600});
  console.log(JSON.stringify({ passed: checks.length, failed: errors.length, report: path.join(output, "result.json"), syntheticOnly: true }));
}
