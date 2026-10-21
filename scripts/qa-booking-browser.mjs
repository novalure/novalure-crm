// Narrow Package-5 browser evidence: real login/MFA, CSRF, HTTP and PostgreSQL;
// synthetic accounts only. Provider creation is deliberately not simulated here.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import pg from "pg";
import { chromium, expect } from "@playwright/test";
import { seedDesignCIntegration, startDesignCIntegrationDatabase } from "./lib/design-c-integration-fixture.mjs";

const output = path.resolve(".npm-cache/qa/booking-browser");
await mkdir(output, { recursive: true });
for (const file of [".env", ".env.local", ".env.development", ".env.development.local"]) {
  try { await readFile(file); throw new Error("Refusing browser QA with environment files"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
}
let db, owner, server, browser, serverDone;
const checks = [], errors = [], outbound = [], pageErrors = [];
let serverLog = "";
const check = async (name, action) => { await action(); checks.push({ name, passed: true }); console.log(JSON.stringify({ check: name, passed: true })); };
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
async function login(page, base, account) {
  await page.goto(`${base}/login?lang=de`, { waitUntil: "domcontentloaded" });
  const consent = page.getByRole("button", { name: "Nur essenzielle", exact: true });
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
    const key = page.locator("p").filter({ has: page.locator("strong", { hasText: "TOTP-Schlüssel:" }) }).locator("code");
    await expect(key).toBeVisible(); const secret = (await key.innerText()).trim();
    assert.equal((await request(page, "/api/booking/settings")).status, 401);
    await page.locator("input[name=recoveryCodesSaved]").check();
    await page.locator("#login-mfa-code").fill(totp(secret));
    await Promise.all([page.waitForNavigation({ waitUntil: "domcontentloaded" }), page.getByRole("button", { name: "Sicher bestätigen", exact: true }).click()]);
  }
  assert((await page.context().cookies()).some(cookie => cookie.name === "novalure_session"));
  await page.goto(`${base}/booking`, { waitUntil: "domcontentloaded" });
  if (account.requiresMfa !== false) await expect(page.getByLabel("Titel", { exact: true })).toBeEnabled();
}
try {
  db = await startDesignCIntegrationDatabase();
  assert.equal(db.database, "neondb"); assert(/^sales_qa_[a-f0-9]+$/.test(db.role));
  owner = new pg.Pool({ host: "127.0.0.1", port: db.port, user: "neondb_owner", database: db.database });
  const client = await owner.connect();
  try { await client.query("begin"); await client.query(await readFile("migrations/108_universal_booking.sql", "utf8")); await client.query("commit"); }
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
  server.stdout.on("data", chunk => { serverLog += chunk; }); server.stderr.on("data", chunk => { serverLog += chunk; });
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
  await check("Anonymous booking API denied", async () => { await operator.goto(`${base}/booking`); assert.match(operator.url(), /\/login/); assert.equal((await request(operator, "/api/booking/settings")).status, 401); });
  await check("Real password and MFA login opens booking", async () => { await login(operator, base, accounts.operator); await expect(operator.getByRole("heading", { name: "Terminbuchung", exact: true })).toBeVisible(); await expect(operator.getByRole("button", { name: "Terminwunsch aufnehmen", exact: true })).toBeVisible(); });
  await check("Disconnected providers cannot confirm a booking", async () => { await expect(operator.getByRole("button", { name: "Verfügbarkeit prüfen", exact: true })).toBeDisabled(); await expect(operator.getByRole("button", { name: "Zeit reservieren", exact: true })).toBeDisabled(); assert.equal((await request(operator, "/api/booking/connections")).body.connections.length, 0); });
  await check("CSRF blocks write without token", async () => { assert.equal((await request(operator, "/api/booking/settings", "PUT", { rules: { durationMinutes: 45 } }, false)).status, 403); });
  await check("DE request persists without calendar or message effects; repeat is idempotent", async () => {
    await operator.getByLabel("Titel", { exact: true }).fill("SYNTHETIC BOOKING REQUEST A");
    await operator.getByLabel(/Gewünschter Zeitpunkt/).fill("2026-11-02T10:00");
    await expect(operator.getByLabel("Titel", { exact: true })).toHaveValue("SYNTHETIC BOOKING REQUEST A");
    await expect(operator.getByLabel(/Gewünschter Zeitpunkt/)).toHaveValue("2026-11-02T10:00");
    await operator.getByRole("button", { name: "Terminwunsch aufnehmen", exact: true }).click();
    await expect(operator.getByRole("status")).toContainText("Es wurde kein Kalendereintrag angelegt.");
    await operator.getByRole("button", { name: "Terminwunsch aufnehmen", exact: true }).click();
    await expect(operator.getByRole("status")).toContainText("Es wurde kein Kalendereintrag angelegt.");
    const rows = await db.admin.query("select id,status,calendar_provider,metadata from meeting_bookings where workspace_id=$1 and title='SYNTHETIC BOOKING REQUEST A'", [accounts.operator.workspaceId]);
    assert.equal(rows.rowCount, 1); assert.equal(rows.rows[0].status, "requested"); assert.equal(rows.rows[0].calendar_provider, "none"); assert.equal(rows.rows[0].metadata.providerCreated, false);
  });
  await operator.screenshot({ path: path.join(output, "booking-de-desktop.png"), fullPage: true });
  const customer = await pageFor();
  await check("Second isolated tenant uses real MFA and independent request", async () => {
    await login(customer, base, accounts.customer);
    await customer.getByLabel("Sprache", { exact: true }).selectOption("en");
    await expect(customer.getByRole("heading", { name: "Appointment booking", exact: true })).toBeVisible();
    await customer.getByLabel("Title", { exact: true }).fill("SYNTHETIC BOOKING REQUEST B");
    await customer.getByLabel(/Requested time/).fill("2026-11-03T11:00");
    await customer.getByRole("button", { name: "Save appointment request", exact: true }).click();
    await expect(customer.getByRole("status")).toContainText("No calendar event was created.");
    const rows = await db.admin.query("select workspace_id from meeting_bookings where title like 'SYNTHETIC BOOKING REQUEST %' order by title");
    assert.deepEqual(rows.rows.map(row => row.workspace_id), [accounts.operator.workspaceId, accounts.customer.workspaceId]);
  });
  await check("Foreign workspace connection lookup denied", async () => { assert.equal((await request(customer, `/api/booking/connections?workspaceId=${accounts.operator.workspaceId}`)).status, 403); });
  await check("Narrow booking rules write persists through real HTTP and forced RLS", async () => { const response = await request(customer, "/api/booking/settings", "PUT", { kind: "phone", rules: { durationMinutes: 45 } }); assert.equal(response.status, 200); const stored = await request(customer, "/api/booking/settings"); assert(stored.body.overrides.some(item => item.kind === "phone" && item.rules.durationMinutes === 45)); assert.match(stored.cacheControl, /no-store/); });
  await customer.setViewportSize({ width: 390, height: 844 });
  await check("EN mobile has no horizontal overflow", async () => { assert.equal(await customer.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true); });
  await customer.screenshot({ path: path.join(output, "booking-en-mobile.png"), fullPage: true });
  const viewer = await pageFor();
  await check("Viewer login cannot access booking write UI or API", async () => { await login(viewer, base, accounts.viewer); await expect(viewer.getByText("Für diesen Bereich benötigen Sie das Kalendermodul und die Berechtigung zur Kalenderverwaltung.", { exact: true })).toBeVisible(); assert.equal((await request(viewer, "/api/booking/settings")).status, 403); });
  await check("No browser exception or external request", async () => { assert.deepEqual(pageErrors, []); assert.deepEqual(outbound, []); });
} catch (error) {
  for (const context of browser?.contexts() ?? []) for (const page of context.pages()) if (new URL(page.url()).pathname === "/booking") await page.screenshot({ path: path.join(output, "failure-booking.png"), fullPage: true }).catch(() => {});
  errors.push(error.message); throw error;
}
finally {
  await browser?.close();
  if (server && server.exitCode === null) { server.kill("SIGTERM"); await Promise.race([serverDone, new Promise(resolve => setTimeout(resolve, 10_000))]); if (server.exitCode === null) server.kill("SIGKILL"); }
  await owner?.end(); await db?.stop();
  await writeFile(path.join(output, "server.log"), serverLog);
  const report = { syntheticOnly: true, realLoginMfaCsrfHttpPostgres: true, mockedProviderSuccess: false, realMicrosoftProof: "not_executed", realGoogleProof: "not_executed", productionAccess: 0, checks, errors, pageErrors, outbound };
  await writeFile(path.join(output, "result.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: checks.length, failed: errors.length, report: path.join(output, "result.json"), syntheticOnly: true }));
}
