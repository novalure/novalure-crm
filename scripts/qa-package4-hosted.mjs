// Hosted acceptance only. No database URLs, local fixtures, injected sessions,
// verifier overrides or synthetic scanner ports are consumed by this runner.
import assert from "node:assert/strict";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open as openFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, expect as baseExpect } from "@playwright/test";
import { createTextPdf, createDocx, createScanPdf, createNearLimitPdf, createNearLimitDocx, DOCX_MIME, PNG_FIXTURE } from "./lib/knowledge-document-fixtures.ts";
import { assertHostedRuntimeBinding, exactHostedUrl, loadHostedOwnerMigrationReceipt, validateHostedTarget, verifyHostedMigrationFiles } from "./lib/package4-hosted-target.mjs";
import { installHostedOriginRouting } from "./lib/package4-hosted-browser-access.mjs";

const fail = code => { throw new Error(code); };
const parseJson = (text, code) => { try { return JSON.parse(text); } catch { return fail(code); } };
const output = path.resolve(".npm-cache/qa/package4-hosted");
await mkdir(output, { recursive: true });
// An invalid new invocation cannot leave an earlier PASS as its apparent result.
await writeFile(path.join(output, "result.json"), JSON.stringify({ schema: "novalure.package4.hosted-acceptance.v1", status: "NOT TESTED", startedAt: new Date().toISOString(), reason: "Target and credential validation has not completed; no remote requests performed." }, null, 2));
const targetPath = process.env.NOVALURE_PACKAGE4_HOSTED_TARGET_FILE;
if (!targetPath) fail("HOSTED_TARGET_FILE_REQUIRED");
const target = validateHostedTarget(parseJson(await readFile(targetPath, "utf8"), "HOSTED_TARGET_JSON_INVALID"));
await verifyHostedMigrationFiles(target);
const ownerMigrationReceipt = await loadHostedOwnerMigrationReceipt(target);
if (process.argv.includes("--validate-config")) {
  console.log("HOSTED_CONFIGURATION_VALIDATED_NO_REMOTE_REQUESTS");
  process.exit(0);
}
if (process.argv.length !== 3 || process.argv[2] !== "--run-authorized-hosted") fail("HOSTED_EXPLICIT_RUN_FLAG_REQUIRED");
const credentials = parseJson(process.env.NOVALURE_PACKAGE4_HOSTED_CREDENTIALS_JSON || "null", "HOSTED_CREDENTIALS_JSON_INVALID");
const protectionToken = process.env.VERCEL_OIDC_TOKEN;
if (!credentials || typeof protectionToken !== "string" || protectionToken.length < 32) fail("HOSTED_SECRET_MANAGER_CREDENTIALS_AND_PROTECTION_REQUIRED");
const expect = baseExpect.configure({ timeout: 30_000 });
const runId = randomUUID().replaceAll("-", "").slice(0, 10);
const areaName = "SYNTHETIC HOSTED COMPANY " + runId;
const pdfName = "SYNTHETIC HOSTED PDF " + runId;
const websiteName = "SYNTHETIC HOSTED WEBSITE " + runId;
const marker = "hpdf" + runId;
const reason = "SYNTHETIC hosted acceptance: content, currentness and legal information reviewed";
const results = [], pageErrors = [], serverErrors = [], blockedOutbound = [], uploadProofs = [], networkRequests = [], authorizedProviderRequests = [], mfa = new Map();
const knownSecrets = new Set([protectionToken]);
for (const account of Object.values(target.accounts)) {
  const secret = credentials[account.credentialKey];
  if (!secret || typeof secret.password !== "string" || secret.password.length < 12) fail("HOSTED_ACCOUNT_SECRET_REQUIRED");
  knownSecrets.add(secret.password);
  if (secret.totpSecret) { knownSecrets.add(secret.totpSecret); mfa.set(account.userId, secret.totpSecret); }
}
let browser, operatorPage, customerPage, foreignPage, viewerPage, memberPage, areaId, pdfSource, originalPdf, originalWebsiteVersion;
const contexts = [];
const authComplete = new WeakSet();
const plannedScenarios = [
  "Exact Preview is protected without access credentials",
  "Operator uses regular password and genuine TOTP; missing MFA remains unauthorized",
  "Authenticated diagnostics bind exact Preview implementation, Neon runtime and migration ledger",
  "Operator Design C navigation, scoped database core and explicit Studio/customer workspaces",
  "Two independent synthetic customers use ordinary password and TOTP sessions",
  "Customer company/project scope and property/bot views read actual tenant database rows",
  "Hosted private PDF/DOCX/UTF8 import parses real bytes; scan PDF and image retain honest OCR state",
  "Near-limit private PDF and DOCX cross hosted upload transport and round-trip exact bytes",
  "Identical document retry deduplicates and explicit review/publication feeds both independent channels",
  "Document replacement retains publication and older private immutable version bytes",
  "Viewer cannot write or publish and restricted project member cannot read or alter another project",
  "Real external HTTPS scan stores an untrusted change proposal while published answers stay unchanged",
  "Hosted manual batch uses saved current-actor scopes and real HTTPS without installing a timer",
  "Customer compares and accepts real website proposal; new version reaches both channels only after publication",
  "Historical restoration stays a private draft and source revocation immediately denies both channels",
  "Foreign tenant knowledge, files, dashboard and approvals deny access; missing feature and query quota are enforced",
  "Machine endpoints remain failclosed on Preview without widening pinned Evelyn identity",
  "Desktop and mobile Design C retain usable hosted uploads, lifecycle controls and tenant state",
].map(name => ({ name, status: "NOT TESTED" }));
const evidence = { schema: "novalure.package4.hosted-acceptance.v1", status: "NOT TESTED", syntheticOnly: true,
  productionMutationPerformed: false, sessionInjection: false, scannerPortInjection: false,
  deployment: { id: target.deploymentId, origin: target.origin, sourceSha: target.sourceSha, gitBranch: target.gitBranch, projectId: target.projectId, teamId: target.teamId },
  neon: { projectId: target.neon.projectId, branchId: target.neon.branchId, database: target.neon.database, runtimeRole: target.neon.runtimeRole, migrationRole: target.neon.migrationRole },
  storage: { provider: target.storage.provider, access: target.storage.access, storeId: target.storage.storeId },
  startedAt: new Date().toISOString(), plannedScenarios, results, pageErrors, serverErrors, blockedOutbound, uploadProofs, networkRequests, authorizedProviderRequests, authenticationProofs: [],
  externalMachinePositive: { status: "NOT TESTED", reason: "Existing pinned verifier requires production runtime and actual Evelyn production OIDC workload; Preview acceptance preserves this restriction." },
  recurringScheduler: { status: "NOT TESTED", activated: false }, telephonyProviderConnections: 0, paidProviderActivations: 0 };

function safeError(error) {
  let message = String(error?.message || "HOSTED_UNEXPECTED_FAILURE");
  for (const secret of knownSecrets) if (secret) message = message.replaceAll(secret, "[REDACTED]");
  return message.replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/gu, "[REDACTED_JWT]")
    .replace(/vercel_blob_(?:rw|client)_[A-Za-z0-9_=-]+/gu, "[REDACTED_BLOB_TOKEN]")
    .replace(/(?:postgres|postgresql):\/\/[^\s"']+/gu, "[REDACTED_DATABASE_URL]")
    .replace(/Bearer\s+[A-Za-z0-9._=-]+/giu, "Bearer [REDACTED]").split("\n")[0].slice(0, 500);
}
async function writeEvidence() {
  const serialized = JSON.stringify(evidence, null, 2);
  if ([...knownSecrets].some(secret => secret && serialized.includes(secret)) || /(?:postgres|postgresql):\/\/|vercel_blob_(?:rw|client)_/u.test(serialized)) fail("HOSTED_EVIDENCE_SECRET_CHECK_FAILED");
  await writeFile(path.join(output, "result.json"), serialized);
}
async function step(name, callback) {
  try {
    const detail = await callback();
    results.push({ name, status: "PASS", ...(detail === undefined ? {} : { detail }) });
    const planned = plannedScenarios.find(item => item.name === name); if (planned) planned.status = "PASS";
    console.log("PASS " + name);
  } catch (error) {
    results.push({ name, status: "FAIL", error: safeError(error) });
    const planned = plannedScenarios.find(item => item.name === name); if (planned) planned.status = "FAIL";
    for (const [index, page] of [operatorPage, customerPage, foreignPage, viewerPage, memberPage].entries()) {
      // Login/MFA pages contain secret material and never become screenshots.
      if (page && authComplete.has(page) && !/\/login/.test(page.url())) await page.screenshot({ path: path.join(output, `failure-${results.length}-${index}.png`), fullPage: true }).catch(() => {});
    }
    throw error;
  } finally { await writeEvidence(); }
}
function totp(secret) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567", bytes = [];
  let value = 0, bits = 0;
  for (const letter of secret) {
    if (!alphabet.includes(letter)) fail("HOSTED_INVALID_MFA_KEY");
    value = (value << 5) | alphabet.indexOf(letter); bits += 5;
    if (bits >= 8) { bits -= 8; bytes.push((value >>> bits) & 255); value &= (1 << bits) - 1; }
  }
  const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const digest = createHmac("sha1", Buffer.from(bytes)).update(counter).digest();
  return String((digest.readUInt32BE(digest.at(-1) & 15) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}
async function newPage(label) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: "de-AT", timezoneId: "Europe/Vienna", serviceWorkers: "block" });
  contexts.push(context);
  const allowedStorage = target.storage.allowedUploadOrigins || [];
  for (const origin of allowedStorage) {
    const parsed = new URL(origin);
    if (parsed.origin !== origin || parsed.protocol !== "https:" || !(parsed.hostname === "blob.vercel-storage.com" || parsed.hostname.endsWith(".blob.vercel-storage.com"))) fail("HOSTED_PRIVATE_UPLOAD_ORIGIN_DENIED");
  }
  const page = await context.newPage();
  await installHostedOriginRouting(page, { origin: target.origin, protectionToken, allowedUploadOrigins: allowedStorage,
    uploadApi: { ...target.storage.uploadApi, storeId: target.storage.storeId, workspaceIds: target.allWorkspaceIds, actorIds: Object.values(target.accounts).map(account => account.userId) },
    onAuthorizedProviderRequest: value => authorizedProviderRequests.push({ label, ...value }),
    onBlocked: value => blockedOutbound.push({ label, ...value }),
    onFailure: value => pageErrors.push({ label, ...value }),
  });
  // Bounded transport metadata locates a stalled hop without storing headers,
  // request bodies, signed queries or private object paths.
  const requests = new WeakMap();
  page.on("request", request => {
    if (networkRequests.length >= 2_000) return;
    const url = new URL(request.url());
    if (!["http:", "https:"].includes(url.protocol)) return;
    const record = { label, method: request.method(), origin: url.origin, ...(url.origin === target.origin ? { path: url.pathname } : {}),
      resourceType: request.resourceType(), startedAt: new Date().toISOString(), state: "pending" };
    requests.set(request, record); networkRequests.push(record);
  });
  page.on("response", response => { const record = requests.get(response.request()); if (record) record.status = response.status(); });
  page.on("requestfinished", request => { const record = requests.get(request); if (record) Object.assign(record, { state: "finished", finishedAt: new Date().toISOString() }); });
  page.on("requestfailed", request => {
    const record = requests.get(request), error = request.failure()?.errorText;
    if (record) Object.assign(record, { state: "failed", finishedAt: new Date().toISOString(), code: /^[A-Za-z0-9_:.-]{1,100}$/u.test(error ?? "") ? error : "HOSTED_TRANSPORT_FAILED" });
  });
  page.setDefaultTimeout(30_000); page.setDefaultNavigationTimeout(90_000);
  page.on("pageerror", error => pageErrors.push({ label, message: safeError(error) }));
  page.on("response", response => { if (new URL(response.url()).origin === target.origin && response.status() >= 500) serverErrors.push({ label, status: response.status(), path: new URL(response.url()).pathname }); });
  return page;
}
async function api(page, pathname, body, workspaceId, method = body === undefined ? "GET" : "POST") {
  exactHostedUrl(pathname, target);
  return page.evaluate(async ({ pathname, body, workspaceId, method }) => {
    const url = new URL(pathname, location.origin);
    if (workspaceId) url.searchParams.set("workspaceId", workspaceId);
    const headers = {};
    if (method !== "GET") {
      const response = await fetch("/api/auth/csrf?" + new URLSearchParams({ method, path: url.pathname }), { redirect: "error", signal: AbortSignal.timeout(30_000) });
      const token = await response.json();
      if (!response.ok || typeof token.csrfToken !== "string") return { status: response.status, body: { code: "HOSTED_CSRF_UNAVAILABLE" } };
      headers["content-type"] = "application/json"; headers["x-novalure-csrf-token"] = token.csrfToken;
    }
    const response = await fetch(url, { method, headers, cache: "no-store", redirect: "error", signal: AbortSignal.timeout(60_000), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json(), cacheControl: response.headers.get("cache-control") };
  }, { pathname, body, workspaceId, method });
}
async function login(page, account) {
  await page.goto(target.origin + "/login?lang=de", { waitUntil: "domcontentloaded" });
  if (new URL(page.url()).origin !== target.origin) fail("HOSTED_PROTECTION_REDIRECT_DENIED");
  await expect(page.locator("#login-email")).toBeVisible();
  const consent = page.getByRole("button", { name: "Nur essentielle", exact: true });
  if (await consent.isVisible()) await consent.click();
  if (account.userId === target.accounts.operator.userId) {
    await page.locator("#login-email").fill(account.email);
    await page.locator("#login-password").fill("SYNTHETIC-wrong-password-" + randomUUID());
    await Promise.all([page.waitForNavigation({ waitUntil: "domcontentloaded" }), page.locator("form:has(#login-password) button[type=submit]").click()]);
    await expect(page.locator('p[role="alert"]')).toBeVisible();
    assert.equal((await api(page, "/api/crm/core")).status, 401);
    assert(!(await page.context().cookies()).some(cookie => cookie.name === "novalure_session"));
  }
  await page.locator("#login-email").fill(account.email);
  await page.locator("#login-password").fill(credentials[account.credentialKey].password);
  await Promise.all([page.waitForNavigation({ waitUntil: "domcontentloaded" }), page.locator("form:has(#login-password) button[type=submit]").click()]);
  if (account.workspaceName) {
    const choice = page.getByRole("button", { name: account.workspaceName, exact: false });
    if (await choice.isVisible()) await Promise.all([page.waitForNavigation({ waitUntil: "domcontentloaded" }), choice.click()]);
  }
  if (account.requiresMfa !== false) await expect(page.locator("#login-mfa-code")).toBeVisible();
  const requiresMfa = await page.locator("#login-mfa-code").isVisible();
  if (requiresMfa) {
    assert.equal((await api(page, "/api/knowledge-center", undefined, account.workspaceId)).status, 401);
  }
  if (requiresMfa && await page.locator("input[name=recoveryCodesSaved]").count()) {
    const key = (await page.locator("p").filter({ has: page.locator("strong", { hasText: "TOTP-Schlüssel:" }) }).locator("code").innerText()).trim();
    knownSecrets.add(key); mfa.set(account.userId, key);
    await page.locator("input[name=recoveryCodesSaved]").check();
    // A private optional resumption file is never part of acceptance artifacts.
    const mfaFile = process.env.NOVALURE_PACKAGE4_HOSTED_MFA_FILE;
    if (mfaFile) {
      if (!path.isAbsolute(mfaFile) || path.resolve(mfaFile).startsWith(path.resolve(process.cwd()) + path.sep)) fail("HOSTED_MFA_FILE_MUST_BE_OUTSIDE_CHECKOUT");
      const parent = await lstat(path.dirname(mfaFile));
      if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o077) !== 0) fail("HOSTED_MFA_DIRECTORY_MUST_BE_PRIVATE");
      const privateFile = await openFile(mfaFile, constants.O_WRONLY | constants.O_CREAT | (constants.O_NOFOLLOW || 0), 0o600);
      try {
        const state = await privateFile.stat();
        if (!state.isFile() || state.nlink !== 1 || (state.mode & 0o077) !== 0) fail("HOSTED_MFA_FILE_MUST_BE_PRIVATE");
        await privateFile.truncate(0); await privateFile.writeFile(JSON.stringify(Object.fromEntries(mfa)));
      } finally { await privateFile.close(); }
    }
  }
  if (requiresMfa) {
    if (!mfa.has(account.userId)) fail("HOSTED_EXISTING_MFA_SECRET_REQUIRED");
    await page.locator("#login-mfa-code").fill(totp(mfa.get(account.userId)));
    await Promise.all([page.waitForNavigation({ waitUntil: "domcontentloaded" }), page.getByRole("button", { name: "Sicher bestätigen", exact: true }).click()]);
  }
  await expect(page).not.toHaveURL(/\/login/);
  const cookie = (await page.context().cookies()).find(item => item.name === "novalure_session");
  if (!cookie?.secure || !cookie.httpOnly || !cookie.value.startsWith("v2.")) fail("HOSTED_SERVER_ISSUED_SECURE_SESSION_REQUIRED");
  knownSecrets.add(cookie.value);
  const session = await api(page, "/api/auth/session");
  assert.equal(session.status, 200); assert.equal(session.body.source, "cookie");
  assert.equal(session.body.user.id, account.userId); assert.equal(session.body.workspace.id, account.workspaceId);
  authComplete.add(page);
  evidence.authenticationProofs.push({ userId: account.userId, ordinaryPassword: true, actualMfaChallengeCompleted: requiresMfa, sessionInjected: false });
}
async function open(page, workspaceId, section = "knowledge", projectId = "all") {
  const url = new URL("/", target.origin); url.search = new URLSearchParams({ lang: "de", workspaceId, projectId }).toString(); url.hash = section;
  const previous = page.url();
  await page.goto(url.href, { waitUntil: "domcontentloaded" });
  if (previous === page.url()) await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator(".crm-app.design-c")).toBeVisible();
  await expect(page.locator("[data-crm-content]")).toBeVisible();
  if (section === "knowledge") await page.getByRole("button", { name: /^Wissensquellen \(/ }).click();
}
async function snapshot() {
  const response = await api(customerPage, "/api/knowledge-center", undefined, target.accounts.customerA.workspaceId);
  assert.equal(response.status, 200); return response.body.snapshot;
}
async function source(id) { const row = (await snapshot()).sources.find(item => item.id === id); assert(row); return row; }
function card(name) { return customerPage.locator("li").filter({ has: customerPage.getByRole("heading", { name, exact: true }) }); }
async function panel(name) {
  if (!await card(name).getByTestId("knowledge-lifecycle").count()) await card(name).getByRole("button", { name: "Inhalt prüfen", exact: true }).click();
  return card(name).getByTestId("knowledge-lifecycle");
}
async function publish(name, content) {
  const review = await panel(name); await expect(review).toContainText(content);
  for (const action of ["submit", "review", "approve", "publish"]) {
    const button = review.getByTestId("knowledge-" + action); await expect(button).toBeVisible();
    await review.locator("form textarea").first().fill(reason);
    if (action !== "submit") { await expect(button).toBeDisabled(); await review.getByRole("checkbox", { name: "Ich habe den Inhalt vollständig geprüft.", exact: true }).check(); }
    await button.click(); await expect(button).toHaveCount(0);
  }
  await expect(review.getByTestId("knowledge-revoke")).toBeVisible();
}
async function assign(channel, checked = true) {
  await customerPage.getByRole("button", { name: "KI-Zuordnungen", exact: true }).click();
  await customerPage.getByLabel("KI-Assistent", { exact: true }).selectOption(target.accounts.customerA.botId);
  await customerPage.getByRole("button", { name: channel === "voice" ? "Telefonassistent" : "Webchat", exact: true }).click();
  await customerPage.getByRole("checkbox", { name: new RegExp(areaName) }).setChecked(checked);
  await customerPage.getByRole("button", { name: "Zuordnungen speichern", exact: true }).click();
  await expect(customerPage.getByText("Wissenszuordnungen gespeichert.", { exact: true })).toBeVisible();
}
async function query(channel, text) {
  const response = await api(customerPage, "/api/knowledge-center/query", { botId: target.accounts.customerA.botId, channel, query: text }, target.accounts.customerA.workspaceId);
  assert.equal(response.status, 200); assert.match(response.cacheControl, /private.*no-store/);
  return response.body.matches;
}
async function both(id, text, expectedContent, expectedVersion) {
  for (const channel of ["webchat", "voice"]) {
    const matches = await query(channel, text); assert.equal(matches.length, 1); assert.equal(matches[0].sourceId, id);
    assert.equal(matches[0].versionId, expectedVersion); assert(matches[0].excerpt.includes(expectedContent));
  }
}
async function upload(name, filename, mimeType, bytes) {
  await customerPage.getByRole("button", { name: /^Wissensquellen \(/ }).click();
  await customerPage.getByRole("button", { name: "Datei hochladen", exact: true }).click();
  const form = customerPage.locator("form").filter({ has: customerPage.getByRole("heading", { name: "Wissen hinzufügen", exact: true }) });
  await form.getByLabel("Wissensbereich", { exact: true }).selectOption(areaId);
  await form.getByLabel("Name (optional)", { exact: true }).fill(name);
  await form.getByLabel("Privates Dokument hochladen", { exact: true }).setInputFiles({ name: filename, mimeType, buffer: Buffer.from(bytes) });
  await expect(card(name).getByRole("heading", { name, exact: true })).toBeVisible({ timeout: 90_000 });
  const row = (await snapshot()).sources.find(item => item.name === name); assert(row);
  const hash = createHash("sha256").update(bytes).digest("hex");
  uploadProofs.push({ name, sourceId: row.id, versionId: row.version.id, sizeBytes: bytes.length, sha256: hash, processingStatus: row.version.processingStatus });
  return row;
}
async function download(page, sourceId, versionId, workspaceId) {
  return page.evaluate(async ({ sourceId, versionId, workspaceId }) => {
    const params = new URLSearchParams({ workspaceId, ...(versionId ? { versionId } : {}) });
    const response = await fetch(`/api/knowledge-center/sources/${sourceId}/document?${params}`, { cache: "no-store", redirect: "error", signal: AbortSignal.timeout(60_000) });
    const bytes = await response.arrayBuffer();
    const hash = await crypto.subtle.digest("SHA-256", bytes);
    return { status: response.status, bytes: bytes.byteLength, sha256: [...new Uint8Array(hash)].map(value => value.toString(16).padStart(2, "0")).join(""), cacheControl: response.headers.get("cache-control") };
  }, { sourceId, versionId, workspaceId });
}

try {
  await step("Exact Preview is protected without access credentials", async () => {
    const response = await fetch(target.origin + "/login", { redirect: "manual", signal: AbortSignal.timeout(30_000) });
    assert([301, 302, 303, 307, 308, 401, 403].includes(response.status));
    return { status: response.status };
  });
  browser = await chromium.launch({ executablePath: process.env.CRM_QA_CHROMIUM_PATH || chromium.executablePath(), headless: true, args: ["--no-sandbox"] });
  operatorPage = await newPage("operator");
  await step("Operator uses regular password and genuine TOTP; missing MFA remains unauthorized", () => login(operatorPage, target.accounts.operator));
  await step("Authenticated diagnostics bind exact Preview implementation, Neon runtime and migration ledger", async () => {
    const response = await api(operatorPage, "/api/system/database"); assert.equal(response.status, 200);
    return assertHostedRuntimeBinding(response.body, target, ownerMigrationReceipt);
  });
  await step("Operator Design C navigation, scoped database core and explicit Studio/customer workspaces", async () => {
    const account = target.accounts.operator;
    const core = await api(operatorPage, "/api/crm/core", undefined, account.workspaceId); assert.equal(core.status, 200); assert.equal(core.body.source, "database");
    await open(operatorPage, account.workspaceId, "dashboard");
    assert(await operatorPage.locator("[data-crm-sidebar] [data-crm-nav-item]").count() >= 6);
    const workspaces = await api(operatorPage, "/api/workspaces"); assert.equal(workspaces.status, 200);
    const ids = workspaces.body.workspaces.map(item => item.id);
    assert(ids.includes(account.workspaceId)); assert(ids.includes(target.accounts.customerA.workspaceId));
    if (!target.studio?.workspaceId) fail("HOSTED_STUDIO_BINDING_REQUIRED");
    assert(ids.includes(target.studio.workspaceId)); assert(!ids.includes(target.accounts.customerB.workspaceId));
    await open(operatorPage, target.studio.workspaceId, "dashboard");
    await expect(operatorPage.locator("[data-crm-content]")).not.toContainText("FOREIGN PRIVATE");
  });
  customerPage = await newPage("customerA"); foreignPage = await newPage("customerB");
  await step("Two independent synthetic customers use ordinary password and TOTP sessions", async () => {
    await login(customerPage, target.accounts.customerA); await login(foreignPage, target.accounts.customerB);
    await open(customerPage, target.accounts.customerA.workspaceId);
    await expect(customerPage.locator(".crm-app")).toHaveAttribute("data-crm-audience", "customer");
  });
  await step("Customer company/project scope and property/bot views read actual tenant database rows", async () => {
    const account = target.accounts.customerA;
    const core = await api(customerPage, "/api/crm/core", undefined, account.workspaceId); assert.equal(core.status, 200); assert.equal(core.body.source, "database");
    assert(core.body.data.crmBots.some(bot => bot.id === account.botId));
    assert(core.body.data.propertyUnits.some(unit => unit.id === account.unitId));
    assert((await snapshot()).entitlement.maxStorageBytes > 50 * 1024 * 1024, "Hosted near-limit PDF and DOCX require the bounded provisioned test storage quota");
    for (const section of ["dashboard", "contacts", "properties", "units", "bots"]) await open(customerPage, account.workspaceId, section, account.projectId);
    await open(customerPage, account.workspaceId);
    await customerPage.getByRole("button", { name: /^Wissensbereiche \(/ }).click();
    await customerPage.getByRole("button", { name: "Bereich erstellen", exact: true }).click();
    const form = customerPage.locator("form").filter({ has: customerPage.getByRole("heading", { name: "Bereich erstellen", exact: true }) });
    await form.getByLabel("Name", { exact: true }).fill(areaName); await form.getByRole("button", { name: "Speichern", exact: true }).click();
    await expect(customerPage.getByText("Änderung gespeichert.", { exact: true })).toBeVisible();
    areaId = (await snapshot()).areas.find(area => area.name === areaName).id;
    const projectArea = await api(customerPage, "/api/knowledge-center/areas", { name: "SYNTHETIC HOSTED PROJECT " + runId, kind: "project", projectId: account.projectId }, account.workspaceId);
    assert.equal(projectArea.status, 201);
    await assign("webchat"); await assign("voice");
  });
  await step("Hosted private PDF/DOCX/UTF8 import parses real bytes; scan PDF and image retain honest OCR state", async () => {
    const pdf = await createTextPdf([`SYNTHETIC ${marker} 09:00.`]);
    originalPdf = Buffer.from(pdf); pdfSource = await upload(pdfName, "synthetic-hosted.pdf", "application/pdf", pdf);
    assert(pdfSource.version.content.includes(marker + " 09:00")); assert.equal(pdfSource.approvedVersionId, null);
    const docx = await upload("SYNTHETIC HOSTED DOCX " + runId, "synthetic-hosted.docx", DOCX_MIME, createDocx());
    assert(docx.version.content.includes("Table two"));
    const text = await upload("SYNTHETIC HOSTED UTF8 " + runId, "synthetic-hosted.txt", "text/plain", Buffer.from("SYNTHETIC UTF8 Büroprüfung " + runId));
    assert(text.version.content.includes("Büroprüfung"));
    for (const fixture of [{ name: "SYNTHETIC HOSTED SCAN " + runId, file: "scan.pdf", mime: "application/pdf", bytes: await createScanPdf() },
      { name: "SYNTHETIC HOSTED IMAGE " + runId, file: "image.png", mime: "image/png", bytes: PNG_FIXTURE }]) {
      const row = await upload(fixture.name, fixture.file, fixture.mime, fixture.bytes); assert.equal(row.version.processingStatus, "needs_ocr");
      const review = await panel(fixture.name); await review.locator("form textarea").first().fill(reason); await expect(review.getByTestId("knowledge-submit")).toBeDisabled();
    }
    const privateFile = await download(customerPage, pdfSource.id, pdfSource.version.id, target.accounts.customerA.workspaceId);
    assert.equal(privateFile.status, 200); assert.equal(privateFile.sha256, createHash("sha256").update(pdf).digest("hex")); assert.match(privateFile.cacheControl, /private.*no-store/);
  });
  await step("Near-limit private PDF and DOCX cross hosted upload transport and round-trip exact bytes", async () => {
    const proofs = [];
    for (const fixture of [
      { name: "SYNTHETIC HOSTED NEAR LIMIT PDF " + runId, filename: "near-limit.pdf", mime: "application/pdf", bytes: await createNearLimitPdf(), text: "SYNTHETIC near-limit private PDF ALPHA" },
      { name: "SYNTHETIC HOSTED NEAR LIMIT DOCX " + runId, filename: "near-limit.docx", mime: DOCX_MIME, bytes: createNearLimitDocx(), text: "Table two" },
    ]) {
      assert.equal(fixture.bytes.length, 10 * 1024 * 1024);
      const row = await upload(fixture.name, fixture.filename, fixture.mime, fixture.bytes);
      assert.equal(row.version.processingStatus, "ready"); assert(row.version.content.includes(fixture.text));
      const file = await download(customerPage, row.id, row.version.id, target.accounts.customerA.workspaceId);
      assert.equal(file.status, 200); assert.equal(file.bytes, fixture.bytes.length); assert.equal(file.sha256, createHash("sha256").update(fixture.bytes).digest("hex"));
      proofs.push({ format: fixture.mime, testedBytes: fixture.bytes.length, sha256: file.sha256 });
    }
    return { applicationMaxBytes: 10 * 1024 * 1024, documents: proofs };
  });
  await step("Identical document retry deduplicates and explicit review/publication feeds both independent channels", async () => {
    const repeated = await upload(pdfName, "synthetic-hosted.pdf", "application/pdf", originalPdf); assert.equal(repeated.id, pdfSource.id); assert.equal(repeated.version.id, pdfSource.version.id);
    assert.deepEqual(await query("webchat", marker), []); assert.deepEqual(await query("voice", marker), []);
    await publish(pdfName, marker); pdfSource = await source(pdfSource.id);
    await both(pdfSource.id, marker, "09:00", pdfSource.approvedVersionId);
    await assign("voice", false); assert.deepEqual(await query("voice", marker), []); assert.equal((await query("webchat", marker)).length, 1); await assign("voice");
  });
  await step("Document replacement retains publication and older private immutable version bytes", async () => {
    await open(customerPage, target.accounts.customerA.workspaceId);
    const sourceCard = card(pdfName), file = sourceCard.locator('input[type="file"]');
    await file.setInputFiles({ name: "replacement.pdf", mimeType: "application/pdf", buffer: Buffer.from(await createTextPdf([`SYNTHETIC ${marker} 11:00.`])) });
    await expect.poll(async () => (await source(pdfSource.id)).version.version).toBe(2);
    const replaced = await source(pdfSource.id); assert(replaced.version.content.includes("11:00")); assert.equal(replaced.approvedVersionId, pdfSource.approvedVersionId);
    await both(pdfSource.id, marker, "09:00", pdfSource.approvedVersionId);
    const historical = await download(customerPage, pdfSource.id, pdfSource.version.id, target.accounts.customerA.workspaceId);
    assert.equal(historical.status, 200); assert.equal(historical.sha256, createHash("sha256").update(originalPdf).digest("hex"));
  });
  await step("Viewer cannot write or publish and restricted project member cannot read or alter another project", async () => {
    viewerPage = await newPage("viewer"); memberPage = await newPage("projectMember");
    await login(viewerPage, target.accounts.viewer); await login(memberPage, target.accounts.projectMember);
    await open(viewerPage, target.accounts.customerA.workspaceId);
    const read = await api(viewerPage, "/api/knowledge-center", undefined, target.accounts.customerA.workspaceId);
    assert.equal(read.status, 200); assert.deepEqual(read.body.snapshot.permissions, { canWrite: false, canPublish: false, canAssign: false });
    for (const name of ["Wissen hinzufügen", "Datei hochladen", "Bereich erstellen"]) {
      const action = viewerPage.getByRole("button", { name, exact: true }); assert(await action.count() === 0 || !await action.isEnabled());
    }
    for (const [endpoint, body] of [
      ["/api/knowledge-center/areas", { name: "SYNTHETIC viewer denied", kind: "company" }],
      ["/api/knowledge-center/workflow", { action: "revoke", sourceId: pdfSource.id, versionId: pdfSource.approvedVersionId, expectedVersion: (await source(pdfSource.id)).revision, reason }],
      ["/api/knowledge-center/documents", { action: "prepare", areaId, name: "SYNTHETIC viewer denied", fileName: "denied.txt", mimeType: "text/plain", sizeBytes: 1, sha256: createHash("sha256").update("x").digest("hex") }],
      ["/api/knowledge-center/monitoring/batch", {}],
    ]) assert.equal((await api(viewerPage, endpoint, body, target.accounts.customerA.workspaceId)).status, 403);
    const hiddenArea = await api(customerPage, "/api/knowledge-center/areas", { name: "SYNTHETIC RESTRICTED PROJECT " + runId, kind: "project", projectId: target.accounts.customerA.hiddenProjectId }, target.accounts.customerA.workspaceId);
    assert.equal(hiddenArea.status, 201);
    const hiddenSource = await api(customerPage, "/api/knowledge-center/sources", { areaId: hiddenArea.body.area.id, name: "SYNTHETIC RESTRICTED PROJECT SOURCE " + runId, type: "manual", content: "SYNTHETIC hidden project sentinel " + runId }, target.accounts.customerA.workspaceId);
    assert.equal(hiddenSource.status, 201);
    const core = await api(memberPage, "/api/crm/core", undefined, target.accounts.customerA.workspaceId); assert.equal(core.status, 200); assert.equal(core.body.source, "database");
    assert(!core.body.data.propertyUnits.some(unit => unit.id === target.accounts.customerA.hiddenUnitId));
    assert(core.body.data.propertyUnits.some(unit => unit.id === target.accounts.customerA.unitId));
    const visible = await api(memberPage, "/api/knowledge-center", undefined, target.accounts.customerA.workspaceId);
    assert.equal(visible.status, 200); assert(!visible.body.snapshot.areas.some(area => area.id === hiddenArea.body.area.id));
    const direct = await api(memberPage, "/api/knowledge-center/workflow?sourceId=" + hiddenSource.body.source.id, undefined, target.accounts.customerA.workspaceId); assert([403, 404].includes(direct.status));
    const alter = await api(memberPage, "/api/knowledge-center/sources", { areaId: hiddenArea.body.area.id, name: "SYNTHETIC member denied", type: "manual", content: "SYNTHETIC denied" }, target.accounts.customerA.workspaceId); assert([403, 404].includes(alter.status));
    await open(memberPage, target.accounts.customerA.workspaceId, "properties", target.accounts.customerA.projectId);
    const project = memberPage.getByRole("combobox", { name: "Projekte", exact: true }).first();
    if (await project.count()) assert(!await project.locator(`option[value="${target.accounts.customerA.hiddenProjectId}"]`).count());
  });
  let website;
  await step("Real external HTTPS scan stores an untrusted change proposal while published answers stay unchanged", async () => {
    const control = target.controlledWebsite;
    if (!control?.url || !control.beforeContent || !control.afterContent || !control.query) fail("HOSTED_CONTROLLED_HTTPS_SOURCE_REQUIRED");
    const url = new URL(control.url); if (url.protocol !== "https:" || url.username || url.password || url.hash || url.search || url.origin === target.origin) fail("HOSTED_CONTROLLED_HTTPS_SOURCE_INVALID");
    const created = await api(customerPage, "/api/knowledge-center/sources", { areaId, name: websiteName, type: "url", url: control.url, content: control.beforeContent }, target.accounts.customerA.workspaceId);
    assert.equal(created.status, 201); website = created.body.source;
    await open(customerPage, target.accounts.customerA.workspaceId); await publish(websiteName, control.beforeContent);
    originalWebsiteVersion = (await source(website.id)).approvedVersionId;
    await card(websiteName).getByRole("button", { name: "Websiteüberwachung", exact: true }).click();
    const monitoring = card(websiteName).getByTestId("knowledge-monitoring");
    const responsePromise = customerPage.waitForResponse(response => new URL(response.url()).pathname === "/api/knowledge-center/scans" && response.request().method() === "POST");
    await monitoring.getByTestId("knowledge-monitoring-scan").click();
    const response = await responsePromise; assert([200, 201].includes(response.status())); const scanned = await response.json();
    assert.equal(scanned.run.status, "changed"); assert.equal(scanned.scan.trust, "untrusted_external_content");
    assert.equal(scanned.scan.change.proposedHash, createHash("sha256").update(control.afterContent).digest("hex"));
    await both(website.id, control.query, control.beforeContent, originalWebsiteVersion);
    const finalUrl = new URL(scanned.scan.finalUrl); finalUrl.search = "";
    return { actualHostedHttpsFetch: true, requestedUrl: control.url, finalUrl: finalUrl.href, runId: scanned.run.id, contentHash: scanned.scan.change.proposedHash, syntheticPortInjection: false };
  });
  await step("Hosted manual batch uses saved current-actor scopes and real HTTPS without installing a timer", async () => {
    const monitoring = card(websiteName).getByTestId("knowledge-monitoring");
    await monitoring.getByTestId("knowledge-monitoring-interval").selectOption("daily"); await monitoring.getByTestId("knowledge-monitoring-save").click();
    await expect(monitoring.getByRole("status")).toHaveText("Änderung gespeichert.");
    const batch = await api(customerPage, "/api/knowledge-center/monitoring/batch", {}, target.accounts.customerA.workspaceId);
    assert.equal(batch.status, 200); assert(batch.body.attemptedJobs >= 1 && batch.body.attemptedJobs <= 3);
    assert(batch.body.results.every(row => row.workspaceId === target.accounts.customerA.workspaceId));
    const row = batch.body.results.find(item => item.sourceId === website.id); assert.equal(row?.outcome, "completed"); assert.equal(row.status, "changed");
    const denied = await api(customerPage, "/api/knowledge-center/monitoring/batch", { actorId: target.accounts.customerB.userId }, target.accounts.customerA.workspaceId); assert.equal(denied.status, 400);
    const history = await api(customerPage, "/api/knowledge-center/monitoring?sourceId=" + website.id, undefined, target.accounts.customerA.workspaceId);
    assert(history.body.history.some(item => item.trigger === "scheduled" && item.status === "changed"));
    await monitoring.getByTestId("knowledge-monitoring-interval").selectOption("manual"); await monitoring.getByTestId("knowledge-monitoring-save").click();
    await expect(monitoring.getByRole("status")).toHaveText("Änderung gespeichert.");
    return { attemptedJobs: batch.body.attemptedJobs, scheduledRunId: row.runId, recurringTimerActivated: false, scheduleReturnedToManual: true };
  });
  await step("Customer compares and accepts real website proposal; new version reaches both channels only after publication", async () => {
    await customerPage.getByRole("button", { name: "Wissenspflege", exact: true }).click();
    const proposal = customerPage.locator("article").filter({ hasText: websiteName }).first(); await proposal.getByRole("button", { name: "Vorschlag prüfen", exact: true }).click();
    await expect(proposal.getByTestId("knowledge-proposal-comparison")).toContainText(target.controlledWebsite.beforeContent);
    await expect(proposal.getByTestId("knowledge-proposal-comparison")).toContainText(target.controlledWebsite.afterContent);
    await proposal.getByRole("textbox", { name: /^Begründung für die Entscheidung/ }).fill(reason);
    await proposal.getByRole("button", { name: "Annehmen und Entwurf erstellen", exact: true }).click();
    await expect(customerPage.getByText("Vorschlag angenommen. Der neue Entwurf muss noch separat geprüft, freigegeben und veröffentlicht werden.", { exact: true })).toBeVisible();
    assert.equal((await source(website.id)).approvedVersionId, originalWebsiteVersion);
    await both(website.id, target.controlledWebsite.query, target.controlledWebsite.beforeContent, originalWebsiteVersion);
    await customerPage.getByRole("button", { name: /^Wissensquellen \(/ }).click(); await publish(websiteName, target.controlledWebsite.afterContent);
    website = await source(website.id); await both(website.id, target.controlledWebsite.query, target.controlledWebsite.afterContent, website.approvedVersionId);
  });
  await step("Historical restoration stays a private draft and source revocation immediately denies both channels", async () => {
    const review = await panel(websiteName), history = review.getByTestId("knowledge-version-history"); await history.locator("summary").click();
    await history.getByRole("combobox").selectOption(originalWebsiteVersion); await history.locator("textarea").fill(reason);
    await expect(history.getByTestId("knowledge-restore")).toBeDisabled(); await history.getByRole("checkbox", { name: /weiterhin aktuell/ }).check();
    await expect(history.getByTestId("knowledge-restore")).toBeDisabled(); await history.getByRole("checkbox", { name: /rechtliche Angaben/ }).check(); await history.getByTestId("knowledge-restore").click();
    await expect(review.getByTestId("knowledge-submit")).toBeVisible(); assert.equal((await source(website.id)).approvedVersionId, website.approvedVersionId);
    await both(website.id, target.controlledWebsite.query, target.controlledWebsite.afterContent, website.approvedVersionId);
    await review.locator("form textarea").first().fill(reason); await review.getByTestId("knowledge-revoke").click();
    await expect.poll(async () => (await source(website.id)).approvedVersionId).toBe(null);
    for (const channel of ["webchat", "voice"]) assert.deepEqual(await query(channel, target.controlledWebsite.query), []);
  });
  await step("Foreign tenant knowledge, files, dashboard and approvals deny access; missing feature and query quota are enforced", async () => {
    for (const endpoint of ["/api/knowledge-center", "/api/crm/core", "/api/approvals", "/api/knowledge-center/workflow?sourceId=" + pdfSource.id]) {
      const response = await api(foreignPage, endpoint, undefined, target.accounts.customerA.workspaceId); assert([403, 404].includes(response.status));
    }
    const file = await download(foreignPage, pdfSource.id, pdfSource.version.id, target.accounts.customerB.workspaceId); assert([403, 404].includes(file.status));
    const own = await api(foreignPage, "/api/crm/core", undefined, target.accounts.customerB.workspaceId); assert.equal(own.status, 200);
    assert(!JSON.stringify(own.body).includes(target.accounts.customerA.unitId));
    await open(foreignPage, target.accounts.customerB.workspaceId, "dashboard");
    const searchTrigger = foreignPage.getByRole("button", { name: "CRM durchsuchen", exact: true });
    await searchTrigger.click();
    const search = foreignPage.getByRole("dialog", { name: "CRM durchsuchen", exact: true });
    const searchbox = search.getByRole("searchbox", { name: "CRM durchsuchen", exact: true });
    await searchbox.fill(target.accounts.customerA.searchSentinel || marker);
    await expect(search.locator("[data-crm-search-results]")).toHaveText("Keine passenden Ergebnisse im geladenen Bereich.");
    // Chromium gives a populated native search input the first Escape to clear.
    await foreignPage.keyboard.press("Escape"); await expect(searchbox).toHaveValue(""); await expect(search).toBeVisible();
    await foreignPage.keyboard.press("Escape"); await expect(search).not.toBeVisible(); await expect(searchTrigger).toBeFocused();
    for (const [channel, expectedCode] of [["voice", "ENTITLEMENT_REQUIRED"], ["webchat", "LIMIT_EXCEEDED"]]) {
      const denied = await api(foreignPage, "/api/knowledge-center/query", { botId: target.accounts.customerB.botId, channel, query: marker }, target.accounts.customerB.workspaceId);
      assert([403, 409].includes(denied.status)); assert.equal(denied.body.code, expectedCode);
    }
  });
  await step("Machine endpoints remain failclosed on Preview without widening pinned Evelyn identity", async () => {
    const statuses = {};
    for (const channel of ["voice", "webchat"]) {
      const response = await fetch(exactHostedUrl("/api/integrations/knowledge/" + channel, target), { method: "POST", redirect: "manual", signal: AbortSignal.timeout(30_000),
        headers: { "content-type": "application/json", "x-vercel-trusted-oidc-idp-token": protectionToken }, body: JSON.stringify({ query: marker, maxResults: 3 }) });
      assert([401, 403].includes(response.status)); const body = await response.json(); assert.equal(body.code, "ASSISTANT_ACCESS_DENIED"); statuses[channel] = response.status;
    }
    return { statuses, verifiedMachineIdentityUsed: false, positiveMachineClaim: false };
  });
  await step("Desktop and mobile Design C retain usable hosted uploads, lifecycle controls and tenant state", async () => {
    await open(customerPage, target.accounts.customerA.workspaceId);
    for (const width of [1440, 390]) {
      await customerPage.setViewportSize({ width, height: width === 390 ? 844 : 1000 }); await expect(card(websiteName)).toBeVisible(); await panel(websiteName);
      if (width === 390) {
        const mobile = await upload("SYNTHETIC HOSTED MOBILE " + runId, "mobile.txt", "text/plain", Buffer.from("SYNTHETIC mobile upload " + runId));
        assert(mobile.version.content.includes("mobile upload"));
        const trigger = customerPage.getByRole("button", { name: "Navigation öffnen", exact: true }); await trigger.click();
        const drawer = customerPage.locator("[data-crm-mobile-drawer]"); await expect(drawer).toBeVisible();
        assert.equal(await drawer.getAttribute("aria-modal"), "true"); await customerPage.keyboard.press("Escape");
        await expect(drawer).not.toBeVisible(); await expect(trigger).toBeFocused();
      }
      assert(await customerPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2));
      await customerPage.screenshot({ path: path.join(output, width === 390 ? "mobile.png" : "desktop.png"), fullPage: true });
    }
    assert.deepEqual(pageErrors, []); assert.deepEqual(serverErrors, []); assert.deepEqual(blockedOutbound, []);
  });
  evidence.status = "PASS";
} catch (error) {
  evidence.status = "FAIL";
  if (!results.some(item => item.status === "FAIL")) results.push({ name: "Hosted setup", status: "FAIL", error: safeError(error) });
  console.error("HOSTED_ACCEPTANCE_FAILED " + safeError(error)); process.exitCode = 1;
} finally {
  evidence.finishedAt = new Date().toISOString();
  for (const context of contexts) await context.close().catch(() => {});
  await browser?.close();
  await writeEvidence();
  console.log(`HOSTED_ACCEPTANCE_${evidence.status}; completed ${results.filter(item => item.status === "PASS").length} steps; evidence .npm-cache/qa/package4-hosted/result.json`);
}
