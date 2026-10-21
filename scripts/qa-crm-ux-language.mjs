// Supplementary browser regression against the existing disposable loopback app.
// Run: node --conditions=react-server --import tsx scripts/qa-crm-ux-language.mjs
// Never attaches to a user browser, exports auth state, starts/stops the server,
// provisions a provider, or contacts a Production origin.
import assert from "node:assert/strict";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { chromium, expect as baseExpect } from "@playwright/test";
import { seedDesignCIntegration } from "./lib/design-c-integration-fixture.mjs";

for (const file of [".env", ".env.local", ".env.production", ".env.production.local", ".env.development", ".env.development.local"]) {
  await access(file).then(() => { throw new Error("Use an isolated checkout without environment files"); }, error => { if (error.code !== "ENOENT") throw error; });
}
const fixture = JSON.parse(await readFile(".npm-cache/qa/sales-browser-context.json", "utf8"));
const base = new URL(fixture.baseUrl);
assert(fixture.syntheticOnly && base.protocol === "http:" && base.hostname === "127.0.0.1" &&
  fixture.database?.host === "127.0.0.1" && /^sales_qa_[a-f0-9]+$/.test(fixture.database.user), "Disposable loopback context required");
assert.equal(fixture.fixtureMode, "design-c-actual-predecessors");
assert.equal(fixture.database.database, "neondb");
const visualDelta = process.argv.includes("--visual-delta");
const inspectClosedControls = process.argv.includes("--inspect-closed-controls");
const captureOnly = process.argv.includes("--capture-only");
assert(process.argv.slice(2).every(argument => ["--visual-delta", "--inspect-closed-controls", "--capture-only"].includes(argument)) && [visualDelta, inspectClosedControls, captureOnly].filter(Boolean).length <= 1, "Unknown QA argument");
const runId = new Date().toISOString().replace(/[:.]/g, "-");
const mode = visualDelta ? "visual-delta" : inspectClosedControls ? "closed-controls-inspection" : captureOnly ? "capture-only" : "full-focused-ui";
const output = path.resolve(".npm-cache/qa/crm-ux-language", `${mode}-${runId}`);
await mkdir(output, { recursive: true });
console.log(JSON.stringify({ runId, output, mode }));
const admin = new pg.Pool({ ...fixture.database, user: "qa_admin", max: 2 });
const expect = baseExpect.configure({ timeout: 20_000 });
const results = [], coverage = [], authentication = [], faults = [], pageErrors = [], unexpectedResponses = [], externalRequests = [], blockedWrites = [];
const contexts = [], mfaSecrets = new Map(), lastMfaCounter = new Map(), privateValues = new Set();
let browser, accounts, currentPage, controlledFailure = false;
async function fingerprintFiles(files) {
  const hash = createHash("sha256");
  for (const file of [...new Set(files)].sort()) { hash.update(file); hash.update("\0"); hash.update(await readFile(file)); hash.update("\0"); }
  return { files: new Set(files).size, sha256: hash.digest("hex") };
}
async function walkFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walkFiles(filename)); else if (entry.isFile()) files.push(filename);
  }
  return files;
}
const sourceFiles = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "--", "src", "migrations", "scripts/qa-crm-ux-language.mjs"], { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }).trim().split(/\r?\n/).filter(Boolean);
const sourceBinding = {
  gitHeadAtStart: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }).trim(),
  workingSourceAtStart: await fingerprintFiles(sourceFiles),
  trackedRuntimeDiffFromMainSha256: createHash("sha256").update(execFileSync("git", ["diff", "--binary", "origin/main", "--", "src", "migrations"], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] })).digest("hex"),
  builtArtifact: await fingerprintFiles([".next/BUILD_ID", ...await walkFiles(".next/server/app"), ...await walkFiles(".next/static")]),
  buildId: (await readFile(".next/BUILD_ID", "utf8")).trim(),
  note: "Built bytes and current source snapshot are recorded separately. An uncommitted source snapshot is not an exact final Git revision or proof that later source edits were built.",
};

function safeMessage(error) {
  let message = String(error?.message ?? error).split("\n")[0].slice(0, 240);
  for (const value of privateValues) if (value) message = message.replaceAll(value, "[private QA credential]");
  return message.replace(/v2\.[A-Za-z0-9_-]+/g, "[session]");
}
async function screenshot(page, name, fullPage = true) {
  // Enrollment screens contain ephemeral credentials and are never captured.
  if (!page || !await page.locator(".crm-app").isVisible().catch(() => false)) return null;
  const filename = `${name.replace(/[^a-zA-Z0-9_-]/g, "-")}.png`;
  await page.screenshot({ path: path.join(output, filename), fullPage });
  return filename;
}
async function step(name, run, fatal = false) {
  try {
    const detail = await run();
    results.push({ name, status: "PASS", ...(detail ? { detail } : {}) });
    console.log(`PASS ${name}`);
    return detail;
  } catch (error) {
    const shot = await screenshot(currentPage, `failure-${results.length + 1}`).catch(() => null);
    results.push({ name, status: "FAIL", error: safeMessage(error), ...(shot ? { screenshot: shot } : {}) });
    console.log(`FAIL ${name}: ${safeMessage(error)}`);
    await currentPage?.keyboard.press("Escape").catch(() => undefined);
    if (fatal) throw error;
    return null;
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
async function newContext(label, blockedStorage = false) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "de-AT", timezoneId: "Europe/Vienna" });
  contexts.push(context);
  if (blockedStorage) await context.addInitScript(() => {
    Object.defineProperty(window, "localStorage", { get() { throw new DOMException("Synthetic storage denial", "SecurityError"); } });
  });
  await context.route("**/*", route => {
    const request = route.request(), url = new URL(request.url());
    if (["data:", "blob:"].includes(url.protocol)) return route.continue();
    if (url.origin !== base.origin) {
      externalRequests.push({ role: label, method: request.method(), origin: url.origin });
      return route.abort("blockedbyclient");
    }
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method()) && url.pathname.startsWith("/api/") &&
      !url.pathname.startsWith("/api/auth/") && url.pathname !== "/api/settings/language") {
      blockedWrites.push({ role: label, path: url.pathname, method: request.method() });
      return route.abort("blockedbyclient");
    }
    return route.continue();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(20_000); page.setDefaultNavigationTimeout(90_000);
  page.on("pageerror", error => pageErrors.push({ role: label, error: safeMessage(error) }));
  page.on("response", response => {
    const url = new URL(response.url());
    if (!controlledFailure && url.origin === base.origin && response.status() >= 500) unexpectedResponses.push({ role: label, path: url.pathname, status: response.status() });
  });
  return page;
}
async function api(page, pathname, body, method = body === undefined ? "GET" : "POST") {
  return page.evaluate(async ({ pathname, body, method }) => {
    const headers = {};
    if (method !== "GET") {
      const response = await fetch("/api/auth/csrf?" + new URLSearchParams({ method, path: pathname.split("?")[0] }), { cache: "no-store" });
      const token = await response.json();
      headers["content-type"] = "application/json";
      headers["x-novalure-csrf-token"] = token.csrfToken;
    }
    const response = await fetch(pathname, { method, headers, cache: "no-store", ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const json = await response.json().catch(() => null);
    return { status: response.status, body: json, cacheControl: response.headers.get("cache-control") };
  }, { pathname, body, method });
}
async function ready(page) {
  await expect(page.locator(".crm-app.design-c")).toBeVisible();
  await expect(page.locator("[data-crm-content]")).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}
async function login(page, role) {
  const account = accounts[role];
  await page.goto(new URL("/login?languagePreference=en", base).href, { waitUntil: "domcontentloaded" });
  const consent = page.getByRole("button", { name: /Only essential|Necessary only|Nur essenzielle|Nur essentielle/i });
  if (await consent.first().isVisible().catch(() => false)) await consent.first().click();
  await page.locator("#login-email").fill(account.email);
  await page.locator("#login-password").fill(account.password);
  await Promise.all([page.waitForNavigation({ waitUntil: "domcontentloaded" }), page.locator("form:has(#login-password) button[type=submit]").click()]);
  const workspaceChoice = account.name ? page.getByRole("button", { name: account.name, exact: false }) : null;
  if (workspaceChoice && await workspaceChoice.isVisible().catch(() => false)) await Promise.all([page.waitForNavigation({ waitUntil: "domcontentloaded" }), workspaceChoice.click()]);
  if (account.requiresMfa !== false) {
    await expect(page.locator("#login-mfa-code")).toBeVisible();
    const enrollment = page.locator("p").filter({ has: page.locator("strong", { hasText: /TOTP key:|TOTP-Schlüssel:/ }) }).locator("code");
    if (await enrollment.isVisible().catch(() => false)) {
      const secret = (await enrollment.innerText()).trim();
      mfaSecrets.set(role, secret); privateValues.add(secret);
      await page.locator("input[name=recoveryCodesSaved]").check();
    }
    assert(mfaSecrets.has(role), "A repeat login needs this run's own UI-enrolled QA key");
    const previous = lastMfaCounter.get(role);
    while (previous === Math.floor(Date.now() / 30_000)) await page.waitForTimeout(250);
    await page.locator("#login-mfa-code").fill(totp(mfaSecrets.get(role)));
    lastMfaCounter.set(role, Math.floor(Date.now() / 30_000));
    await Promise.all([page.waitForNavigation({ waitUntil: "domcontentloaded" }), page.locator("form:has(#login-mfa-code) button[type=submit]").click()]);
  }
  await ready(page);
  const session = await api(page, "/api/auth/session");
  assert.equal(session.status, 200);
  assert.equal(session.body.user.id, account.userId);
  assert.equal(session.body.user.productRole, role === "operator" ? "novalureAdmin" : role === "customer" ? "customer_owner" : "viewer");
  authentication.push({ role, productRole: session.body.user.productRole, normalPassword: true, mfaRequired: account.requiresMfa !== false, sessionInjected: false });
  return session.body.user.productRole;
}
async function logout(page) {
  await page.getByRole("button", { name: /^(Abmelden|Sign out|Log out)$/ }).first().click();
  await expect(page).toHaveURL(/\/login/);
}
function languageControl(page) { return page.locator("[data-crm-language-control] select:visible").first(); }
async function pageResetForLanguage(page) {
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 1440, height: 900 });
  await ready(page);
}
async function chooseLanguage(page, preference) {
  await languageControl(page).selectOption(preference);
  await expect(languageControl(page)).toHaveValue(preference);
  await expect(page.locator(".crm-app")).toHaveAttribute("data-crm-language-preference", preference);
  await expect(page.locator("html")).toHaveAttribute("lang", preference === "auto" ? "en" : preference);
}
async function openScope(page, workspaceId, section = "dashboard") {
  // URL scope is validated against the active workspace; it does not authorize
  // a managed-workspace switch. Exercise the real authorized UI instead.
  await page.goto(new URL("/", base).href, { waitUntil: "domcontentloaded" }); await ready(page);
  const session = await api(page, "/api/auth/session");
  if (session.body.workspace.id !== workspaceId) {
    const select = page.locator("select").filter({ has: page.locator(`option[value="${workspaceId}"]`) }).first();
    const details = select.locator("xpath=ancestor::details[1]");
    if (!await select.isVisible() && await details.count()) await details.locator("summary").first().click();
    await expect(select).toBeVisible(); await select.selectOption(workspaceId);
    await expect.poll(() => new URL(page.url()).searchParams.get("workspaceId")).toBe(workspaceId);
  }
  await ready(page);
  void section;
}
async function chooseProfile(page, profile) {
  if (await page.locator("[data-crm-sidebar]").isVisible()) {
    await expect(async () => {
      const sidebar = page.locator("[data-crm-sidebar]");
      if (await sidebar.getAttribute("data-collapsed") === "true") await page.locator("[data-crm-collapse]").click();
      await expect(sidebar).toHaveAttribute("data-collapsed", "false", { timeout: 1000 });
      const select = page.locator("[data-crm-profile-card] select");
      await select.selectOption(profile, { timeout: 1000 }); await expect(select).toHaveValue(profile, { timeout: 1000 });
    }).toPass({ timeout: 15_000, intervals: [100, 250, 500] });
  } else {
    await page.locator("[data-crm-mobile-trigger]").click();
    const select = page.locator("[data-crm-mobile-drawer] select").filter({ has: page.locator(`option[value="${profile}"]`) }).first();
    await select.selectOption(profile);
    if (await page.locator("[data-crm-mobile-close]").isVisible().catch(() => false)) await page.locator("[data-crm-mobile-close]").click();
  }
  await ready(page);
}
async function navEntries(page) {
  return page.locator("[data-crm-quick-actions] select").first().locator("option").evaluateAll(options => options.map(option => ({ id: option.value, label: option.textContent?.trim() ?? "" })));
}
async function navigate(page, entry) {
  if (await page.locator("[data-crm-sidebar]").isVisible()) {
    // aria-label is preserved even when the desktop rail is collapsed.
    await page.locator("[data-crm-sidebar]").getByRole("button", { name: entry.label, exact: true }).first().click();
  } else {
    await page.locator("[data-crm-mobile-trigger]").click();
    await page.locator("[data-crm-mobile-drawer]").getByRole("button", { name: entry.label, exact: true }).first().click();
  }
  await ready(page);
  await page.waitForTimeout(200);
}
async function geometry(page) {
  return page.evaluate(() => {
    const visible = element => {
      const box = element.getBoundingClientRect();
      if (box.width <= 0 || box.height <= 0 || getComputedStyle(element).visibility === "hidden") return false;
      if (element.checkVisibility && !element.checkVisibility({ contentVisibilityAuto: true, checkVisibilityCSS: true })) return false;
      for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
        if (ancestor.tagName === "DETAILS" && !ancestor.open && !ancestor.querySelector(":scope > summary")?.contains(element)) return false;
      }
      return true;
    };
    const root = document.querySelector(".crm-app");
    const unnamed = [...root.querySelectorAll("button")].filter(visible).filter(element => {
      const labelled = (element.getAttribute("aria-labelledby") ?? "").split(/\s+/).map(id => document.getElementById(id)?.textContent ?? "").join(" ");
      const text = element.getAttribute("aria-label") || labelled || element.innerText || element.getAttribute("title") || "";
      return !text.trim() || /^[+\-×x<>→←↗⋯…·\s]+$/.test(text.trim());
    }).map(element => ({ tag: element.tagName, text: element.innerText?.slice(0, 30) ?? "", html: element.outerHTML.slice(0, 500), ancestor: element.parentElement?.outerHTML.slice(0, 500) ?? "" }));
    const sections = document.querySelector("[data-crm-content]");
    const bodyText = sections?.textContent ?? "";
    return { viewport: innerWidth, document: document.documentElement.scrollWidth, unnamedSymbolControls: unnamed,
      sourceState: /Daten für diesen Bereich nicht verfügbar|Data for this section is unavailable/.test(bodyText) ? "unavailable" : /Wird geladen|Loading|werden geladen/.test(bodyText) ? "loading-observed" : /Noch keine Wissens|No knowledge (sources|areas)|Keine Einträge|No records|No contacts for|Keine Kontakte|Keine Aufgaben|No tasks|No appointments|Keine Termine|Keine Deals|No deals/.test(bodyText) ? "empty-message-observed" : "data-or-state-rendered",
      horizontalScrollContainers: [...root.querySelectorAll("div,section,article")].filter(element => visible(element) && ["auto", "scroll"].includes(getComputedStyle(element).overflowX) && element.scrollWidth > element.clientWidth + 1).length };
  });
}
async function coverageForRole(page, role) {
  const scopes = role === "operator"
    ? [{ id: accounts.operator.workspaceId, kind: "internal", profiles: ["novalureAdmin", "completeBrokerage", "propertyDeveloper"] }, { id: accounts.studio.workspaceId, kind: "Studio", profiles: ["novalureStudio"] }]
    : [{ id: accounts[role].workspaceId, kind: "customer", profiles: ["completeBrokerage", "propertyDeveloper"] }];
  for (const language of ["de", "en"]) {
    await pageResetForLanguage(page);
    await chooseLanguage(page, language);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width === 1440 ? 900 : 844 });
      const visited = new Map();
      for (const scope of scopes) {
        await openScope(page, scope.id);
        const profiles = await page.locator("select").filter({ has: page.locator('option[value="propertyDeveloper"]') }).first().locator("option").evaluateAll(options => options.map(option => option.value));
        for (const profile of scope.profiles) {
          if (!profiles.includes(profile)) { coverage.push({ role, scope: scope.kind, language, width, profile, status: "NOT_AVAILABLE", reason: "Profile is not in this account's actual allowed selection" }); continue; }
          await chooseProfile(page, profile);
          const entries = await navEntries(page);
          for (const entry of entries) {
            const key = `${scope.kind}:${entry.id}`;
            if (visited.has(key)) { coverage.push({ role, scope: scope.kind, language, width, profile, section: entry.id, status: "COVERED_VIA_SAME_SECTION", coveredVia: visited.get(key) }); continue; }
            const item = { role, scope: scope.kind, language, width, profile, section: entry.id, status: "PASS" };
            try {
              await navigate(page, entry);
              let layout = await geometry(page);
              if (layout.sourceState === "loading-observed") {
                item.loadingInitiallyObserved = true;
                try { await expect.poll(async () => (await geometry(page)).sourceState, { timeout: 20_000, intervals: [100, 250, 500] }).not.toBe("loading-observed"); }
                catch { item.status = "LOADING_ONLY"; }
                layout = await geometry(page);
              }
              Object.assign(item, layout);
              if (layout.document > layout.viewport + 1 || layout.unnamedSymbolControls.length) item.status = "FAIL";
              item.screenshot = await screenshot(page, `${role}-${scope.kind}-${language}-${width}-${entry.id}`);
              visited.set(key, profile);
            } catch (error) { item.status = "FAIL"; item.error = safeMessage(error); item.screenshot = await screenshot(page, `coverage-failure-${coverage.length}`); }
            coverage.push(item);
          }
        }
      }
      console.log(`COVERAGE ${role} ${language} ${width}: ${visited.size} distinct sections`);
    }
  }
}
async function languageCases(page) {
  await step("Personal manual language survives reload and the same user's workspace/profile switch", async () => {
    await chooseLanguage(page, "en"); await page.reload({ waitUntil: "domcontentloaded" }); await ready(page);
    await expect(languageControl(page)).toHaveValue("en");
    await openScope(page, accounts.studio.workspaceId); await chooseProfile(page, "novalureStudio");
    await expect(languageControl(page)).toHaveValue("en");
    await openScope(page, accounts.operator.workspaceId); await chooseProfile(page, "completeBrokerage");
  });
  await step("Automatic reset stores auto and resolves missing local geo to English", async () => {
    await chooseLanguage(page, "de"); await chooseLanguage(page, "auto");
    const row = await admin.query("select language_preference from account_ui_preferences where auth_identity_id=$1", [accounts.operator.authIdentityId]);
    assert.equal(row.rows[0].language_preference, "auto");
    await page.reload({ waitUntil: "domcontentloaded" }); await ready(page);
    await expect(languageControl(page)).toHaveValue("auto"); await expect(page.locator("html")).toHaveAttribute("lang", "en");
    return { geo: "missing in real loopback server", physicalLocationSimulated: false };
  });
  await step("Failed personal save keeps the previous preference and never claims success", async () => {
    await chooseLanguage(page, "de"); let intercepted = 0; controlledFailure = true;
    const handler = route => { intercepted++; return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "synthetic_save_unavailable", persisted: false }) }); };
    await page.route("**/api/settings/language", handler);
    try {
      await languageControl(page).selectOption("en");
      await expect(page.locator("[data-crm-language-control] [role=alert]").first()).toBeVisible();
      await expect(languageControl(page)).toHaveValue("de"); await expect(page.locator("html")).toHaveAttribute("lang", "de");
      assert(intercepted > 0); await expect(page.locator("[data-crm-language-control]").first()).not.toContainText("Sprache gespeichert.");
      await screenshot(page, "language-save-error-de");
    } finally { await page.unroute("**/api/settings/language", handler); controlledFailure = false; }
  });
  await step("Language switch preserves a synthetic contact draft, its search and the selected hash/scope", async () => {
    await chooseLanguage(page, "de");
    const contact = (await navEntries(page)).find(entry => entry.id === "contacts"); assert(contact, "Contacts must be authorized"); await navigate(page, contact);
    const search = page.getByPlaceholder(/Kontakt, Firma, Ort oder Quelle suchen|Search contact, company, city or source/);
    await search.fill("Synthetic");
    const nameInput = page.locator("[data-crm-content] label").filter({ hasText: /^Name\s*$/ }).locator("input").last();
    await expect(nameInput).toBeVisible();
    const draft = "SYNTHETIC ungespeicherter Kontaktname für den Sprachwechsel"; await nameInput.fill(draft);
    const url = page.url(); await chooseLanguage(page, "en"); assert.equal(page.url(), url);
    await expect(nameInput).toHaveValue(draft); await expect(search).toHaveValue("Synthetic");
    await screenshot(page, "contact-draft-en-preserved");
  });
  await step("Search dialog supports keyboard, Escape and focus restoration", async () => {
    const trigger = page.locator("[data-crm-search-trigger]"); await trigger.focus(); await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", { name: "Search CRM", exact: true }); await expect(dialog).toBeVisible();
    try {
      await page.locator("#crm-command-query").fill("SYNTHETIC long project and company search text");
      await page.keyboard.press("Tab");
      const focus = await dialog.evaluate(element => ({ inside: element.contains(document.activeElement), boundary: [document.body, document.documentElement].includes(document.activeElement) }));
      assert(focus.inside || focus.boundary, "Modal focus must never reach an underlying app control");
      if (focus.boundary) { await page.keyboard.press("Tab"); assert(await dialog.evaluate(element => element.contains(document.activeElement))); }
      await screenshot(page, "search-dialog-keyboard-en");
    } finally { await page.keyboard.press("Escape"); }
    await expect(dialog).not.toBeVisible(); await expect(trigger).toBeFocused();
  });
  await step("Controlled local Knowledge delay/failure is observed and rendered as unavailable", async () => {
    await chooseProfile(page, "completeBrokerage"); let intercepted = 0, fulfilled = 0, cancelled = 0; controlledFailure = true;
    const pendingFaults = new Set();
    const handler = route => {
      const pending = (async () => {
        intercepted++; await new Promise(resolve => setTimeout(resolve, 800));
        try { await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "synthetic_knowledge_unavailable" }) }); fulfilled++; }
        catch { cancelled++; /* React may abort a superseded read; it is not an injected response. */ }
      })();
      pendingFaults.add(pending); void pending.finally(() => pendingFaults.delete(pending)); return pending;
    };
    await page.route("**/api/knowledge-center**", handler);
    try {
      const entry = (await navEntries(page)).find(item => item.id === "knowledge"); assert(entry); await navigate(page, entry);
      await expect.poll(() => intercepted).toBeGreaterThan(0);
      const loadingObserved = /Loading knowledge center|Wissensverwaltung wird geladen/.test(await page.locator("[data-crm-content]").innerText());
      await expect(page.locator("[data-crm-content]")).toContainText(/could not|unavailable|not available|nicht.*geladen|nicht verfügbar/i);
      await expect.poll(() => fulfilled).toBeGreaterThan(0);
      faults.push({ source: "knowledge", realLocalGetIntercepted: true, delayMs: 800, loadingObserved, synthetic503: true, fulfilled, cancelled });
      await screenshot(page, "knowledge-controlled-error-en");
    } finally { await page.unroute("**/api/knowledge-center**", handler); await Promise.allSettled([...pendingFaults]); controlledFailure = false; }
  });
}
async function visualDeltaCases(page) {
  await step("English desktop header and native language selector viewport", async () => {
    await chooseLanguage(page, "en");
    await screenshot(page, "after-en-desktop-header-1440", false);
    const layout = await geometry(page); assert(layout.document <= layout.viewport + 1);
  });
  await step("English search dialog uses an English accessible close label", async () => {
    await page.locator("[data-crm-search-trigger]").click();
    const dialog = page.getByRole("dialog", { name: "Search CRM", exact: true });
    try { await expect(dialog.getByRole("button", { name: "Close dialog", exact: true })).toBeVisible(); }
    finally { await page.keyboard.press("Escape"); }
  });
  await step("English offer form viewport contains localized fields and preserves the disabled sending warning", async () => {
    await chooseProfile(page, "completeBrokerage");
    const entry = (await navEntries(page)).find(item => item.id === "pipelines"); assert(entry); await navigate(page, entry);
    const record = page.getByText("SYNTHETIC UX interface offer", { exact: true }).first();
    if (await record.isVisible().catch(() => false)) await record.click();
    const form = page.getByRole("region", { name: "Offer workflow", exact: true });
    await expect(form).toBeVisible(); await expect(form.getByLabel("Subject", { exact: true })).toBeVisible();
    await expect(form).toContainText(/Contract and payment|contract and payment|not enabled/i);
    await form.scrollIntoViewIfNeeded(); await screenshot(page, "after-en-offer-form-1440", false);
  });
  const viewer = await newContext("visual-delta-viewer"); currentPage = viewer;
  await step("Actual read-only viewer sees a truthful empty Knowledge state at mobile390", async () => {
    await login(viewer, "viewer"); await chooseLanguage(viewer, "en");
    await viewer.setViewportSize({ width: 390, height: 844 }); await chooseProfile(viewer, "propertyDeveloper");
    const entry = (await navEntries(viewer)).find(item => item.id === "knowledge"); assert(entry); await navigate(viewer, entry);
    await expect(viewer.locator("[data-crm-content]")).toContainText(/No knowledge sources yet|No knowledge areas yet/);
    await expect(viewer.locator("[data-crm-content]")).not.toContainText("Create the first");
    const layout = await geometry(viewer); assert(layout.document <= layout.viewport + 1);
    await viewer.evaluate(() => scrollTo(0, 0)); await screenshot(viewer, "after-en-viewer-knowledge-390", false);
    await pageResetForLanguage(viewer); await chooseLanguage(viewer, "de");
  });
  currentPage = page;
  await step("Different users in the same browser retain independent account preferences", async () => {
    await pageResetForLanguage(page); await chooseLanguage(page, "en"); await logout(page); await login(page, "viewer");
    await expect(languageControl(page)).toHaveValue("de"); await expect(page.locator("html")).toHaveAttribute("lang", "de");
  });
  await step("Denied localStorage leaves sign-in cookie controls and the signed-in app functional", async () => {
    const blocked = await newContext("visual-delta-blocked-storage", true); currentPage = blocked; await login(blocked, "viewer");
    await chooseLanguage(blocked, "en"); await blocked.reload({ waitUntil: "domcontentloaded" }); await ready(blocked);
    await expect(languageControl(blocked)).toHaveValue("en");
    assert.equal(pageErrors.filter(error => error.role === "visual-delta-blocked-storage").length, 0);
    await screenshot(blocked, "blocked-storage-viewer-en", false);
  });
}
async function inspectFunnelControls(page) {
  await step("Inspect actual Funnel advanced buttons and closed-details visibility", async () => {
    await openScope(page, accounts.studio.workspaceId); await chooseProfile(page, "novalureStudio");
    const entry = (await navEntries(page)).find(item => item.id === "funnels"); assert(entry); await navigate(page, entry);
    const inspection = await page.locator("[data-crm-content]").evaluate(root => [...root.querySelectorAll("button")].filter(element => {
      const box = element.getBoundingClientRect();
      return box.width > 0 && box.height > 0 && !(element.innerText || element.getAttribute("aria-label") || element.getAttribute("title"));
    }).map(element => ({
      html: element.outerHTML.slice(0, 700), parent: element.parentElement?.outerHTML.slice(0, 700),
      textContent: element.textContent, checkVisibility: element.checkVisibility({ contentVisibilityAuto: true, checkVisibilityCSS: true }),
      closedDetails: Boolean(element.closest("details:not([open])")), cssVisibility: getComputedStyle(element).visibility,
    })));
    await writeFile(path.join(output, "funnel-control-inspection.json"), JSON.stringify(inspection, null, 2));
    const layout = await geometry(page); assert.equal(layout.unnamedSymbolControls.length, 0);
    await screenshot(page, "funnel-closed-advanced-controls-1440", false);
    return { candidatesFromOldBoundingBoxHeuristic: inspection.length, hiddenInsideClosedDetails: inspection.filter(item => item.closedDetails && !item.checkVisibility).length, genuineVisibleUnnamed: 0 };
  });
}
try {
  assert.equal((await admin.query("select current_user as role")).rows[0].role, "qa_admin");
  accounts = await seedDesignCIntegration({ admin, role: fixture.database.user, languagePreference: "de" });
  const leadId = randomUUID(), dealId = randomUUID();
  await admin.query("insert into leads(id,workspace_id,project_id,contact_id,assigned_to_user_id,type,source,intent) values($1,$2,$3,$4,$5,'Bauträger','Manual','SYNTHETIC UX enquiry')", [leadId, accounts.operator.workspaceId, accounts.operator.projectId, accounts.operator.developerContactId, accounts.operator.userId]);
  await admin.query("insert into deals(id,workspace_id,project_id,contact_id,organization_id,lead_id,owner_user_id,name,stage,value_cents) values($1,$2,$3,$4,$5,$6,$7,'SYNTHETIC UX interface offer','Neu',123456789)", [dealId, accounts.operator.workspaceId, accounts.operator.projectId, accounts.operator.developerContactId, accounts.operator.developerId, leadId, accounts.operator.userId]);
  for (const role of ["operator", "customer", "viewer"]) privateValues.add(accounts[role].password);
  await writeFile(path.join(output, "inspection-accounts.json"), JSON.stringify({ syntheticOnly: true, baseUrl: base.origin, accounts: ["operator", "customer", "viewer"].map(role => ({ role, userId: accounts[role].userId, authIdentityId: accounts[role].authIdentityId, workspaceId: accounts[role].workspaceId, email: accounts[role].email, productRole: role === "operator" ? "novalureAdmin" : role === "customer" ? "customer_owner" : "viewer" })) }, null, 2));
  await writeFile(path.resolve(".npm-cache/qa/crm-ux-language/latest-run.json"), JSON.stringify({ runId, output, mode, inspectionAccounts: path.join(output, "inspection-accounts.json") }, null, 2));
  browser = await chromium.launch({ headless: true, ...(process.env.CRM_QA_CHROMIUM_PATH ? { executablePath: process.env.CRM_QA_CHROMIUM_PATH } : { channel: "chrome" }) });
  const operator = await newContext("operator"); currentPage = operator;
  await step("Regular synthetic operator password and required MFA", () => login(operator, "operator"), true);
  if (inspectClosedControls) {
    await inspectFunnelControls(operator);
  } else if (visualDelta) {
    await visualDeltaCases(operator);
  } else {
  if (!captureOnly) {
  await languageCases(operator);
  await step("Manual language survives normal logout and another normal login", async () => {
    await chooseLanguage(operator, "en"); await logout(operator); await login(operator, "operator"); await expect(languageControl(operator)).toHaveValue("en");
  });
  await step("A new isolated browser context reads the same account preference after normal login", async () => {
    const device = await newContext("simulated-second-device"); currentPage = device; await login(device, "operator");
    await expect(languageControl(device)).toHaveValue("en"); await expect(device.locator("html")).toHaveAttribute("lang", "en");
    return { newIsolatedBrowserContext: true, physicalSecondDevice: false, authStateCopied: false };
  });
  }
  currentPage = operator; await coverageForRole(operator, "operator");
  if (!captureOnly) {
  await step("Another user in the same browser keeps their independent saved choice", async () => {
    await pageResetForLanguage(operator);
    await chooseLanguage(operator, "en"); await logout(operator); await login(operator, "viewer");
    await expect(languageControl(operator)).toHaveValue("de"); await expect(operator.locator("html")).toHaveAttribute("lang", "de");
  });
  }
  for (const role of ["customer", "viewer"]) {
    const page = await newContext(role); currentPage = page;
    await step(`Regular synthetic ${role} account proves its actual product role`, () => login(page, role), true);
    await step(`${role} cannot read a foreign workspace`, async () => {
      const response = await api(page, "/api/crm/core?workspaceId=" + accounts.foreign.workspaceId); assert.equal(response.status, 403);
      return { denied: true, normalProductRole: role === "viewer" ? "viewer" : "customer_owner" };
    });
    await coverageForRole(page, role);
  }
  if (!captureOnly) await step("The actual app remains usable when localStorage throws", async () => {
    const blocked = await newContext("blocked-storage-viewer", true); currentPage = blocked; await login(blocked, "viewer");
    await chooseLanguage(blocked, "en"); await blocked.reload({ waitUntil: "domcontentloaded" }); await ready(blocked); await expect(languageControl(blocked)).toHaveValue("en");
    const layout = await geometry(blocked); assert(layout.document <= layout.viewport + 1);
    await screenshot(blocked, "blocked-storage-viewer-en");
  });
  }
} catch (error) {
  results.push({ name: "Harness stopped before remaining checks", status: "FAIL", error: safeMessage(error) });
} finally {
  for (const context of contexts) await context.close().catch(() => undefined);
  await browser?.close().catch(() => undefined); await admin.end();
  const report = { runId, mode, sourceBinding, syntheticOnly: true, supplementaryIsolatedBrowser: true, actualSignedInAppBrowserAudit: false, productionAccess: 0, source: "working tree; final exact-SHA gate remains separate", results, coverage, authentication, controlledFaults: faults, pageErrors, unexpectedResponses, externalRequests, blockedWrites, screenshotVisualReview: "pending human/parent inspection", secondDeviceEvidence: "new isolated browser context, not a physical second device" };
  await writeFile(path.join(output, "result.json"), JSON.stringify(report, null, 2));
  const failures = results.filter(result => result.status === "FAIL").length + coverage.filter(item => ["FAIL", "LOADING_ONLY"].includes(item.status)).length + pageErrors.length + unexpectedResponses.length + externalRequests.length + blockedWrites.length;
  console.log(JSON.stringify({ results: results.length, coverage: coverage.length, failures, report: path.join(output, "result.json") }));
  process.exitCode = failures ? 1 : 0;
}
