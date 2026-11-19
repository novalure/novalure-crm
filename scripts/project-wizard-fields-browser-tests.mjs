import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, expect as playwrightExpect } from "@playwright/test";
import { applySalesSchema } from "./lib/local-sales-db.mjs";
import { seedSalesBrowser } from "./lib/sales-browser-fixture.mjs";
import { startReachabilityDb } from "./lib/property-reachability-local-db.mjs";
import { startReachabilityHttp } from "./lib/property-reachability-next-http.mjs";
import { hashPassword } from "../src/lib/auth/passwords.ts";

const repository = process.cwd();
const baselineRevision = "3492729aa8cb48459bad650fca91c9095aa9534e";
const requestedRevision = process.env.CRM_QA_WIZARD_REVISION;
if (requestedRevision) assert.match(requestedRevision, /^[a-f0-9]{7,40}$/i);
const baseline = !requestedRevision && process.env.CRM_QA_WIZARD_BASELINE === "1";
const sourceRevision = requestedRevision ? execFileSync("git", ["rev-parse", "--verify", `${requestedRevision}^{commit}`], { cwd: repository, encoding: "utf8" }).trim() : baseline ? baselineRevision : null;
let sourceDirectory = baseline ? path.join(repository, ".npm-cache/qa/wizard-fields-baseline-349") : repository;
const output = path.resolve(process.env.CRM_QA_WIZARD_OUTPUT || "qa/project-wizard-fields-20261105", baseline ? "baseline" : "fixed");
const sha = value => createHash("sha256").update(value).digest("hex");
const harnessSha256 = sha(await readFile(new URL(import.meta.url)));
const checks = [], browserErrors = [], serverErrors = [], externalBrowserRequests = [], projectPosts = [], projectResponses = [];
const evidence = { schemaVersion: 1, baseline, baselineRevision, sourceRevision, harnessSha256, scope: "ACTUAL_LOOPBACK_BROWSER_LOGIN_MFA_COOKIE_CSRF_NEXT_API_AND_POSTGRES_SYNTHETIC_DATA_ONLY", noHttpMocks: true, noSessionSeed: true, externalNodeConnectionsBlocked: true, startedAt: new Date().toISOString(), checks };
let db, http, browser, context, page, enteredCrm = false;
const check = (name, passed, details) => { checks.push({ name, status: passed ? "PASS" : "FAIL", ...(details === undefined ? {} : { details }) }); console.log(`${passed ? "PASS" : "FAIL"} ${name}`); };
const expect = playwrightExpect.configure({ timeout: 30000 });
function totp(secret) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567", bytes = []; let bits = 0, value = 0;
  for (const character of secret) { const digit = alphabet.indexOf(character); assert.ok(digit >= 0); value = (value << 5) | digit; bits += 5; if (bits >= 8) { bits -= 8; bytes.push((value >>> bits) & 255); value &= (1 << bits) - 1; } }
  const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000))); const digest = createHmac("sha1", Buffer.from(bytes)).update(counter).digest();
  return String((digest.readUInt32BE(digest[digest.length - 1] & 15) & 0x7fffffff) % 1000000).padStart(6, "0");
}
try {
  await mkdir(output, { recursive: true });
  if (requestedRevision) {
    const qaRoot = path.join(repository, '.npm-cache/qa'); await mkdir(qaRoot, { recursive: true });
    sourceDirectory = await mkdtemp(path.join(qaRoot, 'wizard-fields-revision-')); assert.equal(path.dirname(sourceDirectory), qaRoot);
    const archive = path.join(sourceDirectory, 'source.tar');
    execFileSync('git', ['archive', '--format=tar', `--output=${archive}`, sourceRevision, '--', 'src', 'public', 'design-c/styles', 'design-c/components', 'package.json', 'package-lock.json', 'tsconfig.json', 'next.config.ts', 'postcss.config.mjs', 'migrations'], { cwd: repository });
    execFileSync('tar', ['-xf', archive, '-C', sourceDirectory]);
    await symlink(await realpath(path.join(repository, 'node_modules')), path.join(sourceDirectory, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  }
  if (baseline) {
    const frozen = await readFile(path.join(sourceDirectory, "src/components/crm-workspace.tsx"));
    const committed = execFileSync("git", ["show", `${baselineRevision}:src/components/crm-workspace.tsx`], { cwd: repository });
    const canonical = bytes => bytes.toString("utf8").replace(/\r\n/g, "\n");
    assert.equal(sha(canonical(frozen)), sha(canonical(committed)), "baseline app must match exact 349 commit after newline normalization");
    evidence.baselineCanonicalShellSha256 = sha(canonical(frozen));
  }
  process.chdir(sourceDirectory);
  console.log("PHASE owned local PostgreSQL and unchanged historical schema");
  db = await startReachabilityDb(); evidence.databaseDirectory = db.directory;
  evidence.appliedMigrations = await applySalesSchema(db);
  evidence.migrationHashes = Object.fromEntries(await Promise.all(evidence.appliedMigrations.map(async name => [name, sha((await readFile(path.join("migrations", name), "utf8")).replace(/\r\n/g, "\n"))])));
  const fixture = await seedSalesBrowser(db), ownerId = randomUUID(), funnelId = randomUUID();
  await db.admin.query("insert into account_ui_preferences(auth_identity_id,language_preference) values($1,'de')", [fixture.authIdentityId]);
  const ownerEmail = `synthetic-wizard-${ownerId}@example.invalid`, ownerPassword = randomBytes(32).toString("base64url");
  const ownerIdentity = (await db.admin.query("insert into workspace_users(id,workspace_id,name,email,role,product_role,status,onboarding_completed_at) values($1,$2,'SYNTHETIC WIZARD ASSIGNEE',$3,'admin','novalureAdmin','active',now()) returning auth_identity_id", [ownerId, fixture.workspaceId, ownerEmail])).rows[0].auth_identity_id;
  await db.admin.query("update auth_identities set credential_state='active',password_hash=$2 where id=$1", [ownerIdentity, await hashPassword(ownerPassword)]);
  await db.admin.query("insert into account_ui_preferences(auth_identity_id,language_preference) values($1,'de')", [ownerIdentity]);
  await db.admin.query("insert into funnels(id,workspace_id,project_id,owner_user_id,name,goal,audience,entry_channel,status) values($1,$2,$3,$4,'SYNTHETIC WIZARD FIELD TEMPLATE','SYNTHETIC inert template','SYNTHETIC','Website','entwurf')", [funnelId, fixture.workspaceId, fixture.projectId, fixture.userId]);
  const initialSessions = (await db.admin.query("select count(*)::int as count from auth_sessions where auth_identity_id=$1", [fixture.authIdentityId])).rows[0].count;
  assert.equal(initialSessions, 0);
  evidence.fixture = { workspaceId: fixture.workspaceId, actorId: fixture.userId, sourceProjectId: fixture.projectId, selectedOwnerId: ownerId, selectedFunnelId: funnelId, initialSessionCount: initialSessions, allBusinessDataSynthetic: true };
  const runtimeFlags = (await db.pool.query("select current_user as role,rolsuper,rolbypassrls,rolcreatedb,rolcreaterole,rolreplication from pg_roles where rolname=current_user")).rows[0];
  assert.ok(Object.entries(runtimeFlags).filter(([key]) => key !== "role").every(([, value]) => value === false)); evidence.runtimeRole = runtimeFlags;
  console.log("PHASE immutable app-byte capture and real local Next server");
  http = await startReachabilityHttp(db, { session: randomBytes(48).toString("base64url"), encryption: randomBytes(40).toString("hex"), rateLimit: randomBytes(40).toString("hex") });
  evidence.appInputs = http.inputs; evidence.httpRunDirectory = http.runDirectory;
  browser = await chromium.launch({ channel: process.env.CRM_QA_BROWSER_CHANNEL || "chrome", headless: true });
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: "de-AT", timezoneId: "Europe/Vienna", serviceWorkers: "block" });
  await context.route("**/*", route => { const url = new URL(route.request().url()); if (url.origin === http.origin || ["data:", "blob:"].includes(url.protocol)) return route.continue(); externalBrowserRequests.push({ origin: url.origin, pathname: url.pathname }); return route.abort(); });
  await context.addInitScript(() => localStorage.setItem("novalure-crm-navigation-preset-v1", "realEstateBroker"));
  page = await context.newPage(); page.setDefaultTimeout(30000); page.setDefaultNavigationTimeout(120000);
  page.on("pageerror", error => browserErrors.push(error.message));
  page.on("response", response => { const url = new URL(response.url()); if (url.origin === http.origin && response.status() >= 500) serverErrors.push({ path: url.pathname, status: response.status() }); });
  page.on("request", request => { const url = new URL(request.url()); if (url.origin === http.origin && url.pathname === "/api/crm/projects" && request.method() === "POST") projectPosts.push({ pathname: url.pathname, workspaceId: url.searchParams.get("workspaceId"), body: request.postDataJSON(), csrfPresent: Boolean(request.headers()["x-novalure-csrf-token"]), idempotencyKey: request.headers()["idempotency-key"] ?? null }); });
  console.log("PHASE actual password and rendered TOTP enrollment");
  await page.goto(http.origin + "/login?lang=de", { waitUntil: "domcontentloaded" });
  const consent = page.getByRole("button", { name: /^(Nur essenzielle|Only necessary)$/ }); if (await consent.isVisible()) await consent.click();
  await page.locator("#login-email").fill(fixture.email); await page.locator("#login-password").fill(fixture.password);
  await Promise.all([page.waitForNavigation({ waitUntil: "domcontentloaded" }), page.locator("form:has(#login-password) button[type=submit]").click()]);
  await expect(page.locator("#login-mfa-code")).toBeVisible();
  const secret = (await page.locator("p").filter({ has: page.locator("strong", { hasText: /TOTP-Schlüssel:|TOTP key:/ }) }).locator("code").innerText()).trim();
  const recoveryCodes = await page.locator("form:has(#login-mfa-code) li code").allTextContents(); assert.ok(recoveryCodes.length > 0);
  await page.locator('input[name="recoveryCodesSaved"]').check(); await page.locator("#login-mfa-code").fill(totp(secret));
  await Promise.all([page.waitForNavigation({ waitUntil: "domcontentloaded" }), page.getByRole("button", { name: /^(Sicher bestätigen|Verify securely)$/ }).click()]);
  await expect(page.locator("[data-crm-sidebar]")).toBeVisible({ timeout: 120000 });
  enteredCrm = true;
  const cookie = (await context.cookies()).find(value => value.name === "novalure_session");
  check("actual password/TOTP flow issued opaque HttpOnly MFA session", Boolean(cookie?.httpOnly && cookie.value.startsWith("v2.")));
  await page.goto(`${http.origin}/?workspaceId=${fixture.workspaceId}&projectId=all#projects`, { waitUntil: "domcontentloaded" });
  await expect(page.locator("[data-crm-profile-select]").first()).toHaveValue("realEstateBroker");
  const readyCore = await page.evaluate(async () => { const response = await fetch("/api/crm/core", { cache: "no-store", credentials: "same-origin" }); return response.status; }); assert.equal(readyCore, 200);
  const marker = `SYNTHETIC WIZARD FIELDS ${randomUUID().slice(0, 8)}`, notes = "SYNTHETIC WIZARD NOTES — harmless persistence marker";
  const options = baseline ? null : await page.evaluate(async workspaceId => { const response = await fetch('/api/crm/projects?' + new URLSearchParams({ operation: 'wizard-options', workspaceId, customerType: 'novalure_internal', operatingModel: 'novalure_internal' }), { cache: 'no-store', credentials: 'same-origin' }); return { status: response.status, body: await response.json() }; }, fixture.workspaceId);
  if (options) { evidence.wizardOptions = options; assert.equal(options.status, 200); assert.equal(options.body.data.workspaceId, fixture.workspaceId); assert.equal(options.body.data.actorId, fixture.userId); assert.ok(options.body.data.responsibleUsers.some(user => user.id === ownerId)); assert.ok(options.body.data.funnelReferences.some(funnel => funnel.id === funnelId)); assert.equal(options.body.data.pipelineTemplates.length, 1); }
  const pipelineKey = baseline ? "pipeline_investment" : options.body.data.pipelineTemplates[0].key;
  console.log("PHASE actual project wizard and single real create");
  await page.getByRole("button", { name: "Neues Projekt", exact: true }).last().click();
  const dialog = page.getByRole("dialog", { name: "Projekt-Wizard", exact: true }); await expect(dialog).toBeVisible();
  await dialog.getByLabel("Projektname", { exact: true }).fill(marker);
  if (!baseline) await dialog.locator("select").filter({ has: page.locator('option[value="b2b_workspace"]') }).selectOption("b2b_workspace");
  await (baseline ? dialog.getByPlaceholder("Zielgruppe, Startdatum, Besonderheiten", { exact: true }) : dialog.getByLabel("Notizen", { exact: true })).fill(notes);
  await dialog.locator("select").filter({ has: page.locator(`option[value="${ownerId}"]`) }).selectOption(ownerId);
  await dialog.locator("select").filter({ has: page.locator(`option[value="${funnelId}"]`) }).selectOption(funnelId);
  await dialog.locator("select").filter({ has: page.locator(`option[value="${pipelineKey}"]`) }).selectOption(pipelineKey);
  evidence.selected = { name: marker, privateNotes: notes, responsibleUserId: ownerId, funnelReferenceId: funnelId, pipelineTemplateKey: pipelineKey, typeKey: baseline ? "real_estate_project" : "b2b_workspace" };
  const [response] = await Promise.all([page.waitForResponse(value => new URL(value.url()).pathname === "/api/crm/projects" && value.request().method() === "POST"), dialog.getByRole("button", { name: "Projekt anlegen", exact: true }).click()]);
  const payload = await response.json(); projectResponses.push({ status: response.status(), body: payload });
  check("real project POST passed server authorization and CSRF", response.status() === 200 && payload.persisted === true && Boolean(payload.project?.id), { status: response.status(), persisted: payload.persisted ?? null });
  assert.equal(response.status(), 200); assert.equal(payload.persisted, true); const createdId = payload.project.id; assert.match(createdId, /^[a-f0-9-]{36}$/i);
  evidence.createdProjectId = createdId;
  await expect.poll(() => projectPosts.length).toBe(1); check("one create with real browser CSRF and command identity", projectPosts.length === 1 && projectPosts[0].csrfPresent && Boolean(projectPosts[0].idempotencyKey));
  await expect(page.getByRole("button", { name: "Projekt wird gespeichert...", exact: true })).toHaveCount(0);
  await page.reload({ waitUntil: "domcontentloaded" }); await expect(page.locator("[data-crm-sidebar]")).toBeVisible();
  const readback = await page.evaluate(async () => { const response = await fetch("/api/crm/core", { credentials: "same-origin", cache: "no-store" }); return { status: response.status, body: await response.json() }; });
  assert.equal(readback.status, 200); const reloaded = readback.body.data?.projects?.find(project => project.id === createdId); assert.ok(reloaded); evidence.reloadedProject = reloaded;
  const client = await db.pool.connect(); let row, pipeline;
  try { await client.query("begin read only"); await client.query("select set_config('app.tenant_id',$1,true),set_config('app.actor_id',$2,true)", [fixture.workspaceId, fixture.userId]); row = (await client.query("select to_jsonb(p) as project from projects p where p.workspace_id=$1 and p.id=$2", [fixture.workspaceId, createdId])).rows[0]?.project; if (row?.default_pipeline_id) pipeline = (await client.query("select id,workspace_id,project_id,key,name,purpose from crm_pipelines where workspace_id=$1 and id=$2", [fixture.workspaceId, row.default_pipeline_id])).rows[0]; await client.query("rollback"); }
  catch (error) { await client.query("rollback"); throw error; } finally { client.release(); }
  assert.ok(row); evidence.databaseProject = row; evidence.databaseDefaultPipeline = pipeline ?? null;
  check("real reload/Core and RLS-scoped runtime SQL agree on the created project", reloaded.id === row.id && reloaded.name === marker && row.workspace_id === fixture.workspaceId);
  const submitted = projectPosts[0].body.project;
  if (baseline) {
    for (const [field, expected] of Object.entries({ notes, ownerUserId: ownerId, funnelTemplateId: funnelId })) check(`wizard ${field} is transmitted and survives real reload`, submitted[field] === expected && reloaded[field] === expected, { sent: submitted[field] ?? null, reloaded: reloaded[field] ?? null, expected });
    check("selected pipeline template survives reload as explicit selection", reloaded.setupDefaults?.pipelineTemplateKey === pipelineKey, { requested: pipelineKey, sentDefaultPipelineId: submitted.defaultPipelineId ?? null, reloadedSetupDefaults: reloaded.setupDefaults ?? null, actualDefaultPipeline: pipeline ?? null });
  } else {
    const wizard = submitted.wizard, safeWizard = { schemaVersion: 1, typeKey: 'b2b_workspace', responsibleUserId: ownerId, funnelReferenceId: funnelId, pipelineTemplateKey: pipelineKey };
    assert.deepEqual(wizard, { ...safeWizard, expectedActorId: options.body.data.actorId, privateNotes: notes }); assert.equal(submitted.type, 'b2b_workspace'); assert.equal(Object.hasOwn(submitted, 'defaultPipelineId'), false);
    check('wizard POST uses resolved actor, stable type and server-listed references/template', true);
    assert.deepEqual(payload.project.wizard, safeWizard); assert.equal(reloaded.type, 'b2b_workspace');
    check('receipt metadata matches exactly and fresh Core/receipt omit private text', !JSON.stringify(payload).includes(notes) && !JSON.stringify(readback.body).includes(notes));
    const details = await page.evaluate(async ({ workspaceId, projectId }) => { const response = await fetch('/api/crm/projects?' + new URLSearchParams({ operation: 'wizard-details', workspaceId, projectId }), { cache: 'no-store', credentials: 'same-origin' }); return { status: response.status, body: await response.json() }; }, { workspaceId: fixture.workspaceId, projectId: createdId }); evidence.wizardDetails = details;
    assert.equal(details.status, 200); const saved = details.body.data; assert.equal(saved.legacy, false); assert.equal(saved.projectId, createdId); assert.equal(saved.privateNotes, notes); assert.equal(saved.responsibleUserId, ownerId); assert.equal(saved.responsibleName, 'SYNTHETIC WIZARD ASSIGNEE'); assert.equal(saved.funnelReferenceId, funnelId); assert.equal(saved.funnelReferenceTitle, 'SYNTHETIC WIZARD FIELD TEMPLATE'); assert.equal(saved.pipelineTemplateKey, pipelineKey); assert.equal(saved.pipelineId, row.default_pipeline_id); assert.equal(pipeline.project_id, createdId); assert.equal(pipeline.key, pipelineKey); assert.notEqual(saved.pipelineId, fixture.pipelineId);
    check('actor-private wizard-details roundtrip resolves exact references and a new own pipeline', true);
    const summary = page.locator('[data-project-wizard-details]'); await expect(summary).toBeVisible(); await summary.locator('summary').click(); await expect(summary.locator('[data-project-private-notes]')).toHaveText(notes); await expect(summary.locator('[data-project-saved-responsible]')).toHaveText('SYNTHETIC WIZARD ASSIGNEE'); await expect(summary.locator('[data-project-saved-funnel]')).toHaveText('SYNTHETIC WIZARD FIELD TEMPLATE'); await expect(summary.locator('[data-project-saved-pipeline]')).toHaveText(pipeline.name);
    await summary.screenshot({ path: path.join(output, 'creator-reloaded-summary.png') });
    check('actual page reload displays persisted authorized project summary and private note', true);
    const scoped = await db.pool.connect();
    try { await scoped.query('begin read only'); await scoped.query("select set_config('app.tenant_id',$1,true),set_config('app.actor_id',$2,true)", [fixture.workspaceId, fixture.userId]);
      const settings = (await scoped.query('select to_jsonb(s) as settings from project_wizard_settings s where workspace_id=$1 and project_id=$2', [fixture.workspaceId, createdId])).rows[0].settings;
      const privateNote = (await scoped.query('select private_notes from project_wizard_private_notes where workspace_id=$1 and project_id=$2 and actor_id=$3', [fixture.workspaceId, createdId, fixture.userId])).rows[0].private_notes;
      const receipts = (await scoped.query('select count(*)::int as count,bool_or(position($3 in to_jsonb(r)::text)>0) as contains_note from crm_command_receipts r where workspace_id=$1 and id=$2::uuid and idempotency_key=$4 and actor_user_id=$5::uuid', [fixture.workspaceId, payload.commandId, notes, projectPosts[0].idempotencyKey, fixture.userId])).rows[0];
      const audits = (await scoped.query('select count(*)::int as count,bool_or(position($3 in to_jsonb(a)::text)>0) as contains_note from audit_logs a where workspace_id=$1 and (entity_id=$2::uuid or id=$4::uuid) and actor_user_id=$5::uuid', [fixture.workspaceId, createdId, notes, payload.auditReference, fixture.userId])).rows[0];
      const funnels = (await scoped.query('select count(*)::int as total,count(*) filter(where project_id=$2)::int as new_project_count from funnels where workspace_id=$1', [fixture.workspaceId, createdId])).rows[0];
      evidence.databaseWizardSettings = settings; evidence.privacy = { privateNoteMatches: privateNote === notes, receiptBinding: { workspaceId: fixture.workspaceId, actorId: fixture.userId, commandId: payload.commandId, idempotencyKey: projectPosts[0].idempotencyKey, auditReference: payload.auditReference }, receipts, audits, funnels }; await scoped.query('rollback');
      check('RLS runtime SQL confirms settings plus actor-private storage and no funnel clone', settings.responsible_user_id === ownerId && settings.funnel_reference_id === funnelId && settings.pipeline_template_key === pipelineKey && privateNote === notes && funnels.total === 1 && funnels.new_project_count === 0);
      check('private marker absent from stored command receipts and audits', receipts.count > 0 && audits.count > 0 && receipts.contains_note === false && audits.contains_note === false);
    } catch (error) { await scoped.query('rollback'); throw error; } finally { scoped.release(); }
    const negativeBody = structuredClone(projectPosts[0].body); negativeBody.project.name = marker + ' rejected actor'; negativeBody.project.wizard.expectedActorId = ownerId;
    const actorMismatch = await page.evaluate(async ({ workspaceId, body }) => { const path = '/api/crm/projects', csrf = await fetch('/api/auth/csrf?' + new URLSearchParams({ method: 'POST', path }), { credentials: 'same-origin' }); const { csrfToken } = await csrf.json(); const response = await fetch(path + '?' + new URLSearchParams({ workspaceId }), { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'x-novalure-csrf-token': csrfToken, 'Idempotency-Key': crypto.randomUUID(), 'X-Correlation-Id': crypto.randomUUID() }, body: JSON.stringify(body) }); return { status: response.status, body: await response.json() }; }, { workspaceId: fixture.workspaceId, body: negativeBody }); evidence.actorMismatch = actorMismatch;
    const noRejectedProject = (await db.admin.query('select count(*)::int as count from projects where workspace_id=$1 and name=$2', [fixture.workspaceId, negativeBody.project.name])).rows[0].count;
    check('fresh real cookie/CSRF rejects changed expected actor with no project insertion', actorMismatch.status === 403 && noRejectedProject === 0);
    const noCsrfBody = structuredClone(projectPosts[0].body); noCsrfBody.project.name = marker + ' rejected csrf';
    const missingCsrf = await page.evaluate(async ({ workspaceId, body }) => { const response = await fetch('/api/crm/projects?' + new URLSearchParams({ workspaceId }), { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID(), 'X-Correlation-Id': crypto.randomUUID() }, body: JSON.stringify(body) }); return { status: response.status, body: await response.json() }; }, { workspaceId: fixture.workspaceId, body: noCsrfBody }); evidence.missingCsrf = missingCsrf;
    const noCsrfProject = (await db.admin.query('select count(*)::int as count from projects where workspace_id=$1 and name=$2', [fixture.workspaceId, noCsrfBody.project.name])).rows[0].count;
    check('real authenticated create without CSRF is denied before insertion', missingCsrf.status === 403 && noCsrfProject === 0);
    const secondary = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'de-AT', serviceWorkers: 'block' });
    try {
      await secondary.route('**/*', route => { const url = new URL(route.request().url()); if (url.origin === http.origin || ['data:', 'blob:'].includes(url.protocol)) return route.continue(); externalBrowserRequests.push({ origin: url.origin, pathname: url.pathname }); return route.abort(); }); const second = await secondary.newPage(); second.setDefaultNavigationTimeout(120000); second.on('pageerror', error => browserErrors.push(error.message));
      await second.goto(http.origin + '/login?lang=de', { waitUntil: 'domcontentloaded' }); const secondaryConsent = second.getByRole('button', { name: /^(Nur essenzielle|Only necessary)$/ }); if (await secondaryConsent.isVisible()) await secondaryConsent.click(); await second.locator('#login-email').fill(ownerEmail); await second.locator('#login-password').fill(ownerPassword);
      await Promise.all([second.waitForNavigation({ waitUntil: 'domcontentloaded' }), second.locator('form:has(#login-password) button[type=submit]').click()]); await expect(second.locator('#login-mfa-code')).toBeVisible(); const secondarySecret = (await second.locator('p').filter({ has: second.locator('strong', { hasText: /TOTP-Schlüssel:|TOTP key:/ }) }).locator('code').innerText()).trim(); const secondaryRecoveryCodes = await second.locator('form:has(#login-mfa-code) li code').allTextContents(); assert.ok(secondaryRecoveryCodes.length > 0); await second.locator('input[name="recoveryCodesSaved"]').check(); await second.locator('#login-mfa-code').fill(totp(secondarySecret)); await Promise.all([second.waitForNavigation({ waitUntil: 'domcontentloaded' }), second.getByRole('button', { name: /^(Sicher bestätigen|Verify securely)$/ }).click()]); await expect(second.locator('[data-crm-sidebar]')).toBeVisible();
      const ownCookie = (await secondary.cookies()).find(value => value.name === 'novalure_session'); assert.ok(ownCookie?.httpOnly && ownCookie.value !== cookie.value);
      const otherActorDetails = await second.evaluate(async ({ workspaceId, projectId }) => { const response = await fetch('/api/crm/projects?' + new URLSearchParams({ operation: 'wizard-details', workspaceId, projectId }), { credentials: 'same-origin', cache: 'no-store' }); return { status: response.status, body: await response.json() }; }, { workspaceId: fixture.workspaceId, projectId: createdId }); evidence.otherActorDetails = otherActorDetails;
      check('separately authenticated assigned manager reads metadata but not creator private note', otherActorDetails.status === 200 && otherActorDetails.body.data.responsibleUserId === ownerId && otherActorDetails.body.data.privateNotes === '' && !JSON.stringify(otherActorDetails).includes(notes));
      await second.goto(`${http.origin}/?workspaceId=${fixture.workspaceId}&projectId=${createdId}#projects`, { waitUntil: 'domcontentloaded' }); const secondSummary = second.locator('[data-project-wizard-details]'); await expect(secondSummary).toBeVisible(); await secondSummary.locator('summary').click(); await expect(secondSummary.locator('[data-project-saved-responsible]')).toHaveText('SYNTHETIC WIZARD ASSIGNEE'); await expect(secondSummary.locator('[data-project-private-notes]')).toHaveText('Keine privaten Notizen'); await expect(secondSummary).not.toContainText(notes); await secondSummary.screenshot({ path: path.join(output, 'assigned-manager-reloaded-summary.png') });
      check('separate manager reload renders authorized shared fields and no creator private note', true);
    } finally { await secondary.close(); }
  }
  check("no browser exception or external browser request", browserErrors.length === 0 && externalBrowserRequests.length === 0, { browserErrors, externalBrowserRequests });
} catch (error) { evidence.failure = { name: error.name, message: String(error.message).slice(0, 1500) }; if (enteredCrm && page) { evidence.failedCrmDom = await page.evaluate(() => ({ url: location.pathname + location.search + location.hash, lang: document.querySelector("main.crm-app")?.getAttribute("lang"), dialogs: [...document.querySelectorAll('[role="dialog"]')].map(element => ({ labelledby: element.getAttribute("aria-labelledby"), heading: element.querySelector("h1,h2,h3")?.textContent, text: element.textContent?.slice(0, 2000) })), buttons: [...document.querySelectorAll("button")].filter(element => /Neues Projekt|New project/.test(element.textContent ?? "")).map(element => ({ text: element.textContent, disabled: element.disabled })) })).catch(() => null); await page.screenshot({ path: path.join(output, "failure.png"), fullPage: false }).catch(() => undefined); } console.error(`LOCAL_WIZARD_FAILURE ${error.name}: ${String(error.message).slice(0, 500)}`); process.exitCode = 1; }
finally {
  if (context) await context.close().catch(error => { evidence.browserCleanupError = error.message; }); if (browser) await browser.close().catch(error => { evidence.browserCleanupError = error.message; });
  try { if (http) evidence.httpCleanup = await http.stop(); } catch (error) { evidence.httpCleanupError = error.message; process.exitCode = 1; }
  try { if (db) evidence.dbCleanup = await db.stop(); } catch (error) { evidence.dbCleanupError = error.message; process.exitCode = 1; }
  process.chdir(repository); Object.assign(evidence, { finishedAt: new Date().toISOString(), projectPosts, projectResponses, browserErrors, serverErrors, externalBrowserRequests, totals: { checks: checks.length, passed: checks.filter(item => item.status === "PASS").length, failed: checks.filter(item => item.status === "FAIL").length } });
  await mkdir(output, { recursive: true }); await writeFile(path.join(output, "results.json"), JSON.stringify(evidence, null, 2) + "\n"); console.log(JSON.stringify({ output, totals: evidence.totals, failure: evidence.failure ?? null }));
}
if (checks.some(item => item.status === "FAIL")) process.exitCode = 1;
