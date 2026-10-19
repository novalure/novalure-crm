import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHmac, randomBytes, randomUUID, scrypt as scryptCallback } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { chromium, expect } from "@playwright/test";
import jsQR from "jsqr";
import sharp from "sharp";
import { buildTotpProvisioningUri } from "../src/lib/auth/mfa.ts";
import { applySalesSchema, startLocalSalesDb } from "./lib/local-sales-db.mjs";

// Run with node --import tsx scripts/mfa-qr-browser-tests.mjs. The server and
// PostgreSQL cluster are owned by this process; no configured database is used.
const cwd = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
assert.equal(process.cwd(), cwd, "Run the isolated MFA browser check from the repository root");
const scrypt = promisify(scryptCallback);
const checks = [];
const sensitiveValues = [];
const serverOutput = [];
const browserOutput = [];
const pageErrors = [];
const externalRequests = [];
let db, server, serverDone, browser, activePage;
let currentCheck = "initialize isolated browser test";

function record(name) {
  currentCheck = name;
  checks.push(name);
  console.log(`PASS ${name}`);
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const socket = net.createServer();
    socket.once("error", reject);
    socket.listen(0, "127.0.0.1", () => {
      const port = socket.address().port;
      socket.close(error => error ? reject(error) : resolve(port));
    });
  });
}

async function decodeImage(png) {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const decoded = jsQR(new Uint8ClampedArray(data), info.width, info.height);
  assert.ok(decoded, "An independent QR decoder must recognize the visible image");
  return decoded.data;
}

async function submit(page, button) {
  await Promise.all([page.waitForNavigation({ waitUntil: "domcontentloaded" }), button.click()]);
}

// Independent RFC 4226/6238 authenticator simulation, exclusively in the test.
// The application verifier never supplies its own expected enrollment code.
function authenticatorCode(secret, now = Date.now()) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const character of secret) {
    const digit = alphabet.indexOf(character);
    assert.ok(digit >= 0, "Synthetic authenticator must receive a valid Base32 key");
    bits += digit.toString(2).padStart(5, "0");
  }
  const key = Buffer.from((bits.match(/.{8}/g) ?? []).map(byte => Number.parseInt(byte, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(now / 30_000)));
  const digest = createHmac("sha1", key).update(counter).digest();
  const offset = digest[digest.length - 1] & 15;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

try {
  // Next reads these files automatically, independently of the filtered child
  // environment. Refuse to start rather than consume real configured services.
  for (const name of [".env.local", ".env.development.local", ".env.development", ".env"]) {
    try {
      await access(path.join(cwd, name));
      throw new Error("Local environment file would prevent an isolated browser test");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  db = await startLocalSalesDb();
  await applySalesSchema(db, { includeSales: false, maxMigrationNumber: 79 });
  await db.admin.query(await readFile(path.join(cwd, "migrations/106_auth_mfa_hardening.sql"), "utf8"));
  const fixtures = [];
  for (let number = 0; number < 2; number += 1) {
    const workspaceId = randomUUID(), userId = randomUUID();
    const email = `synthetic-qr-${randomUUID()}@example.invalid`;
    const password = `SYNTHETIC QR browser ${randomUUID()}`;
    const salt = randomBytes(16).toString("base64url");
    const passwordHash = ["scrypt", salt, Buffer.from(await scrypt(password, salt, 64)).toString("base64url")].join(":");
    sensitiveValues.push(password);
    await db.admin.query("insert into workspaces(id,name,operating_model,customer_type) values($1,'SYNTHETIC QR browser','self_service_customer','real_estate_broker')", [workspaceId]);
    await db.admin.query("insert into workspace_users(id,workspace_id,name,email,role,product_role,password_hash,status) values($1,$2,'SYNTHETIC QR browser user',$3,'owner','customer_owner',$4,'active')", [userId, workspaceId, email, passwordHash]);
    fixtures.push({ userId, email, password });
  }

  const port = await freePort(), baseUrl = `http://127.0.0.1:${port}`;
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(path|home|temp|tmp|tmpdir|lang|lc_all)$/i.test(key)));
  Object.assign(env, {
    NODE_ENV: "development", NEXT_TELEMETRY_DISABLED: "1", CRM_LOCAL_TEST_DATABASE: "1",
    DATABASE_URL: `postgresql://${db.role}@127.0.0.1:${db.port}/postgres`,
    NOVALURE_APP_ORIGIN: baseUrl, NEXT_PUBLIC_APP_URL: baseUrl,
  });
  for (const name of ["NOVALURE_SESSION_SECRET", "NOVALURE_AUTH_ENCRYPTION_KEY", "NOVALURE_AUTH_RATE_LIMIT_SECRET"]) {
    env[name] = randomBytes(40).toString("hex");
    sensitiveValues.push(env[name]);
  }
  server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "dev", "--webpack", "--hostname", "127.0.0.1", "--port", String(port)], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  serverDone = new Promise(resolve => {
    server.once("exit", () => resolve());
    server.once("error", () => resolve());
  });
  // Capture only in memory: never write unredacted server logs or screenshots
  // containing provisioning credentials to disk or print them on failures.
  server.stdout.on("data", chunk => serverOutput.push(chunk.toString()));
  server.stderr.on("data", chunk => serverOutput.push(chunk.toString()));
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (server.exitCode !== null || server.signalCode !== null) throw new Error("Owned Next server exited");
    try {
      const response = await fetch(`${baseUrl}/login?lang=de&returnTo=%2Fimprint`, { signal: AbortSignal.timeout(5_000) });
      if (response.ok) { ready = true; break; }
    } catch { /* The owned server is still starting. */ }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  assert.equal(ready, true, "Owned loopback Next server must become ready");
  record("disposable synthetic PostgreSQL and loopback Next server ready");

  const launchOptions = { headless: true };
  if (process.env.CRM_QA_BROWSER_EXECUTABLE) launchOptions.executablePath = process.env.CRM_QA_BROWSER_EXECUTABLE;
  else if (process.env.CRM_QA_BROWSER_CHANNEL) launchOptions.channel = process.env.CRM_QA_BROWSER_CHANNEL;
  browser = await chromium.launch(launchOptions);

  for (const [number, fixture] of fixtures.entries()) {
    currentCheck = number === 0 ? "QR enrollment" : "manual enrollment";
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: "de-AT", timezoneId: "Europe/Vienna" });
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: baseUrl });
    await context.route("**/*", route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== baseUrl && !["data:", "blob:"].includes(url.protocol)) {
        externalRequests.push(`${request.url()}\n${request.postData() ?? ""}`);
        return route.abort();
      }
      return route.continue();
    });
    const page = await context.newPage();
    activePage = page;
    page.setDefaultTimeout(30_000);
    page.on("console", message => browserOutput.push(message.text()));
    page.on("pageerror", error => pageErrors.push(error.message));
    await page.goto(`${baseUrl}/login?lang=de&returnTo=%2Fimprint`);
    await page.locator("#login-email").fill(fixture.email);
    await page.locator("#login-password").fill(fixture.password);
    await submit(page, page.locator("form:has(#login-password) button[type=submit]"));
    await expect(page.locator("#login-mfa-code")).toBeVisible();
    assert.equal((await page.request.get(`${baseUrl}/api/auth/session`)).status(), 401, "Enrollment must not issue an authenticated session");

    const image = page.getByRole("img", { name: "QR-Code zur Einrichtung Ihrer Authenticator-App", exact: true });
    const details = page.locator("details").filter({ has: page.getByText("QR-Code kann nicht gescannt werden? Einrichtungsschlüssel anzeigen.", { exact: true }) });
    await expect(image).toBeVisible();
    assert.equal(await details.getAttribute("open"), null, "Manual key must be collapsed by default");
    const source = await image.getAttribute("src");
    assert.ok(source?.startsWith("data:image/png;base64,"), "QR must use an inline PNG instead of an external image service");
    const provisioningUri = await decodeImage(Buffer.from(source.slice("data:image/png;base64,".length), "base64"));
    const parsed = new URL(provisioningUri), secret = parsed.searchParams.get("secret");
    assert.ok(secret && /^[A-Z2-7]{32}$/.test(secret), "QR must contain the existing generated TOTP key");
    sensitiveValues.push(secret, provisioningUri, source);
    assert.ok(provisioningUri === buildTotpProvisioningUri({ email: fixture.email, secret }), "Visible QR must preserve the existing provisioning URI exactly");
    // Decode screenshots in memory, verifying that the displayed QR remains
    // scannable at the actual CSS size on both narrow and desktop viewports.
    for (const viewport of [{ width: 390, height: 844 }, { width: 1280, height: 900 }]) {
      await page.setViewportSize(viewport);
      assert.ok(await decodeImage(await image.screenshot()) === provisioningUri, "Rendered QR must decode without changing its provisioning data");
      const fits = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 2);
      assert.ok(fits, "Enrollment must fit the viewport without horizontal overflow");
    }
    record(`${number === 0 ? "QR" : "manual"} enrollment defaults to a locally generated QR readable on mobile and desktop`);

    // Native disclosure toggles work before React hydrates. Wait for client
    // assets first so hydration cannot restore the initial closed disclosure
    // between opening the manual key and interacting with its clipboard button.
    currentCheck = "German manual setup client readiness";
    await page.waitForLoadState("networkidle");
    await page.setViewportSize({ width: 390, height: 844 });
    currentCheck = "German manual key visibility";
    await details.locator("summary").click();
    await expect(details.locator("code")).toBeVisible();
    const manualSecret = (await details.locator("code").innerText()).trim();
    assert.ok(manualSecret === secret, "Manual key must match the QR key");
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 2), "Expanded manual key must fit a smartphone viewport");
    {
      const copyButton = details.getByRole("button", { name: "Einrichtungsschlüssel kopieren", exact: true });
      await page.bringToFront();
      await page.evaluate(() => {
        const write = navigator.clipboard.writeText.bind(navigator.clipboard);
        window.__mfaQrClipboardDiagnostic = { attempted: false, errorCategory: null };
        navigator.clipboard.writeText = async value => {
          window.__mfaQrClipboardDiagnostic.attempted = true;
          try { await write(value); }
          catch (error) { window.__mfaQrClipboardDiagnostic.errorCategory = error.name; throw error; }
        };
      });
      currentCheck = "German clipboard copied status";
      await copyButton.click();
      await expect(details.getByRole("status")).toHaveText("Einrichtungsschlüssel kopiert.");
      currentCheck = "German clipboard native read";
      assert.ok(await page.evaluate(() => navigator.clipboard.readText()) === secret, "Clipboard must receive the complete manual key");
      await page.evaluate(() => { navigator.clipboard.writeText = async () => { throw new Error("SYNTHETIC clipboard permission denial"); }; });
      currentCheck = "German clipboard denied status";
      await copyButton.click();
      await expect(details.getByRole("status")).toHaveText("Der Einrichtungsschlüssel konnte nicht kopiert werden. Markieren und kopieren Sie ihn manuell.");
      assert.ok((await details.locator("code").innerText()).trim() === secret, "Clipboard failure must retain the selectable manual key");
      record("German manual key, real clipboard copy and clipboard-denied guidance work");
    }
    if (number === 0) {
      currentCheck = "English QR and clipboard handling";
      await page.goto(`${baseUrl}/login?lang=en&returnTo=%2Fimprint`);
      await expect(page.getByRole("img", { name: "QR code to set up your authenticator app", exact: true })).toBeVisible();
      const englishDetails = page.locator("details").filter({ has: page.getByText("Can't scan the QR code? Show setup key.", { exact: true }) });
      assert.equal(await englishDetails.getAttribute("open"), null, "English enrollment must also default to QR");
      await page.waitForLoadState("networkidle");
      await englishDetails.locator("summary").click();
      await englishDetails.getByRole("button", { name: "Copy setup key", exact: true }).click();
      await expect(englishDetails.getByRole("status")).toHaveText("Setup key copied.");
      assert.ok(await page.evaluate(() => navigator.clipboard.readText()) === secret, "English clipboard copy must use the same pending secret");
      await page.evaluate(() => { navigator.clipboard.writeText = async () => { throw new Error("SYNTHETIC clipboard permission denial"); }; });
      await englishDetails.getByRole("button", { name: "Copy setup key", exact: true }).click();
      await expect(englishDetails.getByRole("status")).toHaveText("The setup key could not be copied. Select it and copy it manually.");
      record("English QR, manual key and both clipboard outcomes work");
    }

    currentCheck = number === 0 ? "QR six-digit enrollment confirmation" : "manual six-digit enrollment confirmation";
    const codeInput = page.locator("#login-mfa-code");
    await expect(codeInput).toHaveAttribute("inputmode", "numeric");
    await expect(codeInput).toHaveAttribute("pattern", "[0-9]{6}");
    await expect(codeInput).toHaveAttribute("maxlength", "6");
    await codeInput.fill("12345");
    assert.equal(await codeInput.evaluate(input => input.checkValidity()), false, "Enrollment must require six digits");
    await page.locator("input[name=recoveryCodesSaved]").check();
    const code = authenticatorCode(number === 0 ? secret : manualSecret);
    sensitiveValues.push(code);
    await codeInput.fill(code);
    await submit(page, page.locator("form:has(#login-mfa-code) button[type=submit]"));
    assert.equal(new URL(page.url()).pathname, "/imprint", "Six-digit confirmation must finish enrollment");
    const sessionResponse = await page.request.get(`${baseUrl}/api/auth/session`);
    assert.equal(sessionResponse.status(), 200, "Successful enrollment must establish a real session");
    const session = await sessionResponse.json();
    assert.ok(session.authenticated === true && session.user.id === fixture.userId, "Session must belong to the synthetic account that enrolled");
    const cookie = (await context.cookies()).find(value => value.name === "novalure_session");
    assert.ok(cookie?.httpOnly && cookie.value.startsWith("v2."), "Enrollment must retain the opaque HttpOnly session mechanism");
    record(`${number === 0 ? "QR-decoded" : "manually exposed"} TOTP key completes real six-digit MFA enrollment`);
    await context.close();
  }

  currentCheck = "credential-free logs and local-only network";
  const logs = serverOutput.join("") + browserOutput.join("\n");
  for (const sensitive of sensitiveValues) {
    assert.ok(!logs.includes(sensitive), "Server and browser logs must not contain MFA credentials or provisioning data");
    assert.ok(externalRequests.every(request => !request.includes(sensitive) && !request.includes(encodeURIComponent(sensitive))), "MFA credentials must not be sent to external services");
  }
  assert.equal(externalRequests.length, 0, "Enrollment must not request external services");
  assert.equal(pageErrors.length, 0, "Enrollment must not trigger browser page errors");
  record("no MFA credentials in logs, no external requests and no browser page errors");
  console.log(`PASS ${checks.length} isolated MFA QR browser checks; no production access`);
} catch (error) {
  // Playwright errors may include DOM values. Only the public check label is
  // reported; raw exception, server output and credential screenshots stay private.
  console.error(`FAIL isolated MFA QR browser check near: ${currentCheck}`);
  if (activePage) {
    const diagnostic = await activePage.evaluate(() => ({
      readyState: document.readyState,
      focused: document.hasFocus(),
      manualOpen: document.querySelector("details")?.open ?? null,
      publicStatus: document.querySelector("details [role=status]")?.textContent ?? null,
      clipboard: window.__mfaQrClipboardDiagnostic ?? null,
    })).catch(() => null);
    console.error(`DIAGNOSTIC ${JSON.stringify({ category: error.name, ...diagnostic })}`);
  }
  process.exitCode = 1;
} finally {
  await browser?.close();
  if (server && server.exitCode === null && server.signalCode === null) {
    server.kill("SIGTERM");
    await Promise.race([serverDone, new Promise(resolve => setTimeout(resolve, 10_000))]);
    if (server.exitCode === null && server.signalCode === null) { server.kill("SIGKILL"); await serverDone; }
  }
  await db?.stop();
}
