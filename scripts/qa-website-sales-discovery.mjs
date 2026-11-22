import assert from "node:assert/strict";
import { createHash, createHmac, randomUUID } from "node:crypto";
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
const output = path.resolve(".npm-cache/qa/website-sales-discovery");
await mkdir(output, { recursive: true });
const expect = baseExpect.configure({ timeout: 15000 });
const require = createRequire(import.meta.url);
const admin = new pg.Pool({ ...fixture.database, user: "qa_admin" });
// Every rehearsal gets new synthetic companies; append-only evidence is never
// deleted or rewritten to make retries pass.
for (const project of fixture.websiteSales.projects) {
  project.companyId = randomUUID(); project.contactId = randomUUID();
  await admin.query("insert into organizations(id,workspace_id,project_id,name,type,division,city) values($1,$2,$3,$4,'Unternehmen','WEB_DESIGN',$5)", [project.companyId, fixture.workspaceId, project.projectId, `SYNTHETIC ${project.city} Company`, project.city]);
  await admin.query("insert into contacts(id,workspace_id,project_id,organization_id,owner_user_id,name,email,role) values($1,$2,$3,$4,$5,$6,$7,'Ansprechpartner')", [project.contactId, fixture.workspaceId, project.projectId, project.companyId, fixture.userId, `SYNTHETIC ${project.city} Contact`, `synthetic-${project.city.toLowerCase()}@example.invalid`]);
}
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
  await expect(page.locator("#login-mfa-code")).toBeVisible();
  assert.equal((await api("/api/crm/core")).status, 401, "Password alone must not authorize this internal account");
  let secret;
  const authFile = path.join(output, "synthetic-auth-context.json");
  if (await key.isVisible()) {
    secret = (await key.innerText()).trim();
    // Private ignored fixture credentials, never printed or used outside this
    // owned loopback identity. A rerun still performs ordinary password + TOTP.
    await writeFile(authFile, JSON.stringify({ syntheticOnly: true, authIdentityId: fixture.authIdentityId, secret }));
    await page.locator("input[name=recoveryCodesSaved]").check();
  } else {
    const cached = JSON.parse(await readFile(authFile, "utf8"));
    assert(cached.syntheticOnly && cached.authIdentityId === fixture.authIdentityId);
    secret = cached.secret;
  }
  await page.locator("#login-mfa-code").fill(totp(secret));
  await Promise.all([page.waitForNavigation({ waitUntil: "domcontentloaded" }), page.getByRole("button", { name: /^(Sicher bestätigen|Verify securely)$/ }).click()]);
  await expect(page.locator(".crm-app")).toBeVisible();
  const language = await api("/api/settings/language", { preference: "de", expectedUserId: fixture.userId });
  assert.equal(language.status, 200);
  const session = (await context.cookies()).find(cookie => cookie.name === "novalure_session");
  assert(session?.httpOnly && session.value.startsWith("v2."));
  const persisted = await admin.query("select mfa_verified_at from auth_sessions where auth_identity_id=$1 and revoked_at is null", [fixture.authIdentityId]);
  assert(persisted.rows.length >= 1 && persisted.rows.every(row => row.mfa_verified_at));
}
async function open(project = fixture.websiteSales.projects[0]) {
  const start = Date.now();
  await page.goto(new URL(`/?workspaceId=${fixture.workspaceId}&projectId=${project.projectId}#website-sales`, base).href);
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

const project=fixture.websiteSales.projects[0], companyName=`SYNTHETIC Discovery Café ${randomUUID()}`;
const address='88 Discovery Street, Dublin, Ireland', email=`discovery-${randomUUID()}@example.invalid`;
const quote=`${companyName}. ${address}. Public Contact ${email}. shared.example`;
const candidate={candidateId:randomUUID(),countryCode:'IE',companyName,locationLabel:address,address,domain:'shared.example',contacts:[{name:'Public Contact',email,sourceReferenceId:'source-company'}],sourceReferences:[{sourceId:'source-company',sourceUrl:'https://example.invalid/public-company',contentDigest:createHash('sha256').update(quote).digest('hex'),quote,observedAt:new Date(Date.now()-60000).toISOString(),validUntil:new Date(Date.now()+86400000).toISOString()}]};
const batch=JSON.stringify({workspaceId:fixture.workspaceId,projectId:project.projectId,candidates:[candidate]});
const panel=()=>page.locator('[data-website-sales-discovery]');
async function importFile(){await panel().locator('input[type=file]').setInputFiles({name:'synthetic-research.json',mimeType:'application/json',buffer:Buffer.from(batch)});}
async function confirm(){await panel().getByLabel('Begründung der Zuordnung',{exact:false}).fill('SYNTHETIC reviewed public company, address and contact source');await panel().locator('input[name=reviewed]').check();await panel().getByRole('button',{name:'Zuordnung übernehmen',exact:true}).click();}
try {
 await step('ordinary password and MFA then authorized discovery workbench',async()=>{await login();await open(project);await expect(panel()).toBeVisible();});
 await step('primary JSON file import matches source facts and creates one canonical company/location/contact',async()=>{await importFile();await expect(panel().getByText('Neuer Datensatz erforderlich',{exact:true})).toBeVisible();await confirm();await expect(page.locator('[data-website-sales-research]')).toBeVisible();const rows=await admin.query('select id from organizations where workspace_id=$1 and project_id=$2 and name=$3',[fixture.workspaceId,project.projectId,companyName]);assert.equal(rows.rows.length,1);project.discoveryCompanyId=rows.rows[0].id;});
 await step('hard reload restores source import draft and matches existing CRM branch',async()=>{await page.reload();await expect(panel()).toBeVisible();await panel().locator('details summary').click();await expect(panel().locator('textarea[name=discoveryImport]')).toHaveValue(batch);await panel().locator('details summary').click();await importFile();await expect(panel().getByText('Passender Standort gefunden',{exact:true})).toBeVisible();});
 await step('desktop tablet phone reduced-motion layouts and automated accessibility',async()=>{await screenshot('discovery-desktop',{width:1440,height:1000});await screenshot('discovery-tablet',{width:834,height:1112});await screenshot('discovery-phone',{width:390,height:844});await page.emulateMedia({reducedMotion:'reduce'});await screenshot('discovery-reduced',{width:1440,height:1000});});
 let originalBody;
 await step('actual committed registration with lost response retains original after reload',async()=>{
  await page.evaluate(()=>{const realFetch=window.fetch.bind(window);let lose=true;window.fetch=async(input,init)=>{const request=new Request(input instanceof Request?input.clone():new URL(String(input),location.href),init);const body=request.method==='POST'&&new URL(request.url).pathname==='/api/crm/website-sales/discovery'?await request.clone().text():null;const drop=lose&&body&&JSON.parse(body).operation==='register';const response=await realFetch(input,init);if(drop&&response.status===200){lose=false;window.__discoveryLost={body,status:response.status};await response.body?.cancel();throw new TypeError('SYNTHETIC lost committed receipt');}return response;};});
  await confirm();await expect.poll(()=>page.evaluate(()=>window.__discoveryLost?.status)).toBe(200);originalBody=(await page.evaluate(()=>window.__discoveryLost)).body;await expect(panel().getByText('Der Speicherstatus ist unklar.',{exact:false})).toBeVisible();await page.reload();await expect(panel().getByText('Der Speicherstatus ist unklar.',{exact:false})).toBeVisible();
 });
 await step('read-only original reconciliation performs no register fallback and produces no duplicate rows',async()=>{const bodies=[];const listener=request=>{if(request.method()==='POST'&&new URL(request.url()).pathname==='/api/crm/website-sales/discovery')bodies.push(JSON.parse(request.postData()));};page.on('request',listener);await panel().getByRole('button',{name:'Ursprüngliche Anfrage abgleichen',exact:true}).click();await expect(panel().getByText('Zuordnung gespeichert.',{exact:false})).toBeVisible();page.off('request',listener);assert.equal(bodies.length,1);assert.deepEqual(bodies[0],{...JSON.parse(originalBody),operation:'reconcile'});const counts=(await admin.query('select (select count(*)::int from organizations where workspace_id=$1 and name=$2) companies,(select count(*)::int from contacts where workspace_id=$1 and email=$3) contacts,(select count(*)::int from crm_company_locations where workspace_id=$1 and company_id=$4) locations',[fixture.workspaceId,companyName,email,project.discoveryCompanyId])).rows[0];assert.deepEqual(counts,{companies:1,contacts:1,locations:1});});
 await step('size guard rejects an oversized imported research file before matching',async()=>{const requests=[];const listener=request=>{if(new URL(request.url()).pathname==='/api/crm/website-sales/discovery')requests.push(request.url());};page.on('request',listener);await panel().locator('input[type=file]').setInputFiles({name:'oversized.json',mimeType:'application/json',buffer:Buffer.alloc(65537,32)});await expect(panel().getByText('Das Rechercheergebnis ist ungültig',{exact:false})).toBeVisible();page.off('request',listener);assert.equal(requests.length,0);});
 await step('actual role downgrade rejects discovery with no disclosed CRM match',async()=>{await admin.query("update workspace_users set product_role='viewer' where id=$1 and workspace_id=$2",[fixture.userId,fixture.workspaceId]);try{const response=await api('/api/crm/website-sales/discovery',{contractVersion:'website-sales-discovery-v1',operation:'match',projectId:project.projectId,candidate});assert.equal(response.status,403);assert.equal(JSON.stringify(response.body).includes(project.discoveryCompanyId),false);}finally{await admin.query("update workspace_users set product_role='novalureAdmin' where id=$1 and workspace_id=$2",[fixture.userId,fixture.workspaceId]);}});
 assert.deepEqual(pageErrors,[]);assert.deepEqual(consoleErrors.filter(message=>!message.startsWith('Failed to load resource:')),[]);assert.deepEqual(unexpectedNetwork,[]);
} catch(error){await page.screenshot({path:path.join(output,'failure.png'),fullPage:true}).catch(()=>undefined);throw error;}
finally{await writeFile(path.join(output,'result.json'),JSON.stringify({syntheticOnly:true,productionAccess:0,authentication:'ordinary-password-mfa-ui',server:'optimized-next-build',results,pageErrors,consoleErrors,unexpectedNetwork,accessibility,performance,completed:results.length},null,2));await context.close();await browser.close();await admin.end();}
