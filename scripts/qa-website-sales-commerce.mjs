import assert from 'node:assert/strict';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import { chromium, expect as baseExpect } from '@playwright/test';

// Real optimized local application and PostgreSQL, ordinary password/MFA, synthetic customer data only.
// This harness does not attest a real delivery/signature/payment provider or a production connection.
const fixture = JSON.parse(await readFile('.npm-cache/qa/sales-browser-context.json', 'utf8'));
const base = new URL(fixture.baseUrl), output = path.resolve(process.env.CRM_SALES_COMMERCE_QA_OUTPUT || '.npm-cache/qa/website-sales-commerce-20261122');
assert(fixture.syntheticOnly && fixture.websiteSales?.syntheticOnly);
assert(output.startsWith(path.resolve('.npm-cache/qa') + path.sep));
assert.equal(base.hostname, '127.0.0.1'); assert.equal(fixture.database.host, '127.0.0.1');
assert(/^sales_qa_[a-f0-9]+$/.test(fixture.database.user)); assert.equal(fixture.database.database, 'neondb');
assert.equal(fixture.fixtureMode, 'design-c-current-application-originals');
assert(fixture.websiteCommerce?.syntheticOnly, 'Commerce acceptance requires the isolated 209 fixture');
assert.equal(fixture.websiteCommerce.migration.file, '209_website_sales_commerce.sql');
assert.equal(fixture.websiteCommerce.migration.checksum, createHash('sha256').update((await readFile('migrations/209_website_sales_commerce.sql', 'utf8')).replace(/\r\n/g, '\n')).digest('hex'));
await mkdir(output, { recursive: true });
const expect = baseExpect.configure({ timeout: 20000 }), require = createRequire(import.meta.url);
const admin = new pg.Pool({ ...fixture.database, user: 'qa_admin' });
const browser = await chromium.launch({ channel: process.env.CRM_QA_BROWSER_CHANNEL || 'chrome', headless: true });
const contexts = [], results = [], errors = [], unexpectedNetwork = [], accessibility = [], expectedFaults = [];
const secretValues = new Set([fixture.password]);
const digest = value => createHash('sha256').update(value).digest('hex');
let actor, main, state, initialTemplate;

function scrub(value){let text=String(value);for(const secret of secretValues)if(secret)text=text.replaceAll(secret,"[redacted]");return text.replace(/#grant=[^\s"']+/g,"#[redacted]");}
async function step(name,action){await action();results.push({name,status:"PASS"});console.log("PASS "+name);}
async function context(){const value=await browser.newContext({viewport:{width:1440,height:1000},locale:"de-AT",timezoneId:"Europe/Vienna"});contexts.push(value);return value;}
async function api(page,pathname,body){return page.evaluate(async({pathname,body})=>{const method=body===undefined?"GET":"POST",headers={Accept:"application/json"};if(body!==undefined){const response=await fetch("/api/auth/csrf?"+new URLSearchParams({method,path:new URL(pathname,location.origin).pathname}),{cache:"no-store"});const token=await response.json();headers["x-novalure-csrf-token"]=token.csrfToken;headers["Content-Type"]="application/json";}const response=await fetch(pathname,{method,headers,cache:"no-store",...(body===undefined?{}:{body:JSON.stringify(body)})});return{status:response.status,body:await response.json()};},{pathname,body});}
function totp(secret){let bits=0,value=0;const bytes=[],alphabet="ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";for(const c of secret){const i=alphabet.indexOf(c);assert(i>=0);value=(value<<5)|i;bits+=5;if(bits>=8){bits-=8;bytes.push((value>>>bits)&255);value&=(1<<bits)-1;}}const counter=Buffer.alloc(8);counter.writeBigUInt64BE(BigInt(Math.floor(Date.now()/30000)));const hash=createHmac("sha1",Buffer.from(bytes)).update(counter).digest();return String((hash.readUInt32BE(hash.at(-1)&15)&0x7fffffff)%1000000).padStart(6,"0");}
async function login(account){const ctx=await context(),page=await ctx.newPage();page.on("dialog",d=>d.accept());await page.goto(new URL("/login",base).href);const consent=page.getByRole("button",{name:/^(Nur essenzielle|Only necessary)$/});if(await consent.isVisible())await consent.click();await page.locator("#login-email").fill(account.email);await page.locator("#login-password").fill(account.password);await Promise.all([page.waitForNavigation({waitUntil:"domcontentloaded"}),page.locator("form:has(#login-password) button[type=submit]").click()]);await expect(page.locator("#login-mfa-code")).toBeVisible();assert.equal((await api(page,"/api/crm/core")).status,401);const key=page.locator("p").filter({has:page.locator("strong",{hasText:/TOTP-Schlüssel:|TOTP key:/})}).locator("code"),authFile=path.join(output,`synthetic-auth-${account.authIdentityId}.json`);let secret;if(await key.isVisible()){secret=(await key.innerText()).trim();secretValues.add(secret);await writeFile(authFile,JSON.stringify({syntheticOnly:true,authIdentityId:account.authIdentityId,secret}));await page.locator("input[name=recoveryCodesSaved]").check();}else{const cached=JSON.parse(await readFile(authFile,"utf8"));assert(cached.syntheticOnly&&cached.authIdentityId===account.authIdentityId);secret=cached.secret;secretValues.add(secret);}const code=totp(secret);secretValues.add(code);await page.locator("#login-mfa-code").fill(code);await Promise.all([page.waitForNavigation({waitUntil:"domcontentloaded"}),page.getByRole("button",{name:/^(Sicher bestätigen|Verify securely)$/}).click()]);await expect(page.locator(".crm-app")).toBeVisible();assert.equal((await api(page,"/api/settings/language",{preference:"de",expectedUserId:account.userId})).status,200);const cookie=(await ctx.cookies()).find(c=>c.name==="novalure_session");assert(cookie?.httpOnly&&cookie.value.startsWith("v2."));const sessions=await admin.query("select mfa_verified_at from auth_sessions where auth_identity_id=$1 and revoked_at is null",[account.authIdentityId]);assert(sessions.rows.length&&sessions.rows.every(r=>r.mfa_verified_at));return{context:ctx,page,account};}
async function seedWorkflow(actor,project,label){const scope={projectId:project.projectId,companyId:project.companyId};const command=(operation,payload,extra={})=>({contractVersion:"website-sales-ireland-v1",operation,...scope,idempotencyKey:randomUUID(),correlationId:randomUUID(),payload,...extra});const register=await api(actor.page,"/api/crm/website-sales",command("register_location",{countryCode:"IE",address:`SYNTHETIC ${randomUUID()} ${label}, Dublin, Ireland`,sourceUrl:"https://example.invalid/studio-location",sourceReference:"Synthetic local integration evidence only"}));assert.equal(register.status,200);const locationId=register.body.data.location.id,identity={workspaceId:actor.account.workspaceId,...scope,locationId},validUntil=new Date(Date.now()+86400000).toISOString(),facts={IDENTITY:"Synthetic company operates at this registered Irish location.",OWN_WEBSITE_SEARCH:"No own website was found in the synthetic scoped research.",BUSINESS_NEED:"Service information and opening hours should be easy to find."};const prospect={identity,country:"IRELAND",identityStatus:"VERIFIED",domain:null,path:"NO_WEBSITE",ownWebsiteSearch:"NONE_FOUND",obstacle:null,platformUrl:null,bookingRoute:"UNKNOWN",need:"EVIDENCED",evidence:Object.entries(facts).map(([kind,finding])=>({evidenceId:kind.toLowerCase(),identity,kind,sourceUrl:"https://example.invalid/research/"+kind,observedAt:new Date(Date.now()-60000).toISOString(),validUntil,validityCondition:"Review if this exact synthetic source changes",finding,confidence:.95}))};const observe=await api(actor.page,"/api/crm/website-sales",command("observe",{prospect},{locationId,locationVersion:1}));assert.equal(observe.status,200);const qualified=await api(actor.page,"/api/crm/website-sales",command("qualify",{contactId:project.contactId,opportunitySummary:"Synthetic source-bound website opportunity",nextAction:"Review website studio internally",expectedEvidenceDigest:observe.body.data.workflow.evidenceDigest},{locationId,expectedVersion:observe.body.data.workflow.version}));assert.equal(qualified.status,200);assert(qualified.body.data.workflow.leadId&&qualified.body.data.workflow.dealId&&qualified.body.data.workflow.nextTaskId);return{scope:{...scope,locationId},prospect,workflow:qualified.body.data.workflow,project,actor};}
async function openCommerce(state){await state.actor.page.goto(new URL(`/?workspaceId=${state.actor.account.workspaceId}&projectId=${state.scope.projectId}#website-sales`,base).href);await state.actor.page.reload({waitUntil:"domcontentloaded"});const workbench=state.actor.page.locator("[data-website-sales-workbench]");await expect(workbench).toBeVisible();const restoring=await state.actor.page.evaluate(({workspaceId,actorId})=>["novalure.website-sales.pending.v1","novalure.website-studio.pending.v1","novalure.website-sales-lifecycle.pending.v1","novalure.website-sales-operations.pending.v1","novalure.website-sales-conversation.pending.v1","novalure.website-sales-enablement.pending.v1","novalure.website-sales-commerce.pending.v1"].some(prefix=>sessionStorage.getItem(`${prefix}:${actorId}:${workspaceId}`)!==null),{workspaceId:state.actor.account.workspaceId,actorId:state.actor.account.userId});if(restoring){await expect(workbench.getByLabel("Unternehmen",{exact:true})).toHaveValue(state.scope.companyId);await expect(workbench.getByLabel("Unternehmensstandort",{exact:true})).toHaveValue(state.scope.locationId);}else{await workbench.getByLabel("Unternehmen",{exact:true}).selectOption(state.scope.companyId);await workbench.getByLabel("Unternehmensstandort",{exact:true}).selectOption(state.scope.locationId);}await expect(state.actor.page.getByTestId("website-sales-commerce")).toBeVisible();}
async function distinctContactProject(state,label){const project={...state.project,contactId:randomUUID()};await admin.query("insert into contacts(id,workspace_id,project_id,organization_id,owner_user_id,name,email,role) values($1,$2,$3,$4,$5,$6,$7,'Ansprechpartner')",[project.contactId,state.actor.account.workspaceId,project.projectId,project.companyId,state.actor.account.userId,`SYNTHETIC ${label} recipient`,`synthetic-${project.contactId}@example.invalid`]);return project;}

const endpoint = '/api/crm/website-sales/commerce';
const panel = () => main.getByTestId('website-sales-commerce');
const scoped = () => endpoint + '?' + new URLSearchParams({ workspaceId: actor.account.workspaceId, workflowId: state.workflow.id, ...state.scope });
const form = operation => panel().locator(`[data-commerce-action="${operation}"]`);
const localDate = value => { const date = new Date(value); return new Date(date.valueOf() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16); };

async function current() { const value = await api(main, scoped()); assert.equal(value.status, 200, value.body.code); return value.body; }
async function stage(value) { await panel().getByLabel('Schritt in der Abschlussakte', { exact: true }).selectOption(value); }
async function openConfiguration(operation) {
  await stage('configuration');
  const target = form(operation), details = target.locator('..');
  if ((await details.getAttribute('open')) === null) await details.locator(':scope > summary').click();
  await expect(target).toBeVisible(); return target;
}
async function refresh() {
  const response = main.waitForResponse(value => new URL(value.url()).pathname === endpoint && value.request().method() === 'GET');
  await panel().getByRole('button', { name: 'Stand aktualisieren', exact: true }).click();
  await response; await expect(panel().getByRole('status').filter({ hasText: 'Abschlussakte wird geladen.' })).toHaveCount(0);
}
async function prepareOffer() {
  const detail = await api(main, '/api/crm/website-sales/workbench?' + new URLSearchParams({ workspaceId: actor.account.workspaceId, ...state.scope, view: 'detail' }));
  assert.equal(detail.status, 200);
  const content = { subject: 'SYNTHETIC commerce proposal', recipientName: detail.body.contact.name, recipientEmail: detail.body.contact.email,
    scope: 'Three synthetic responsive information pages', paymentPlan: 'Synthetic explicit payment plan; no real commitment', discounts: 'None', specialTerms: 'Synthetic local QA only', riskComplianceNotes: 'No real sending or production customer',
    terms: 'Synthetic local test document only', validUntil: new Date(Date.now() + 86400000).toISOString(), currency: 'EUR', taxBasis: 'NET', items: [{ description: 'Synthetic website', quantity: 1, unitNetCents: 100000 }] };
  const response = await api(main, '/api/crm/website-sales', { contractVersion: 'website-sales-ireland-v1', operation: 'prepare_offer', ...state.scope, expectedVersion: state.workflow.version,
    idempotencyKey: randomUUID(), correlationId: randomUUID(), payload: { content, expectedEvidenceDigest: state.workflow.evidenceDigest } });
  assert.equal(response.status, 200, response.body.code); state.workflow = response.body.data.workflow;
}
async function fillTemplate(target, label) {
  const values = { title: label, jurisdiction: 'SYNTHETIC local QA jurisdiction only', content: '  SYNTHETIC LOCAL QA TEMPLATE. This is fictional test content and is not approved for actual customers.  ', language: 'en',
    validUntil: localDate(Date.now() + 3600000), 'legal.reference': 'synthetic:local-qa-review-only', 'legal.digest': digest('SYNTHETIC local review evidence only'),
    'legal.observedAt': localDate(Date.now() - 120000), 'legal.validUntil': localDate(Date.now() + 7200000) };
  for (const [name, value] of Object.entries(values)) {
    const field = target.locator(`[name="${name}"]`);
    if (name === 'language') await field.selectOption(value); else await field.fill(value);
  }
}
async function scan(name, viewport) {
  await main.setViewportSize(viewport); await panel().scrollIntoViewIfNeeded();
  const overflow = await panel().evaluate(element => [...element.querySelectorAll('button,input,textarea,select,h3,h4,p')].filter(node => {
    const rectangle = node.getBoundingClientRect(); return rectangle.width > 0 && (rectangle.left < -1 || rectangle.right > innerWidth + 1);
  }).map(node => node.tagName));
  assert.deepEqual(overflow, []);
  await panel().screenshot({ path: path.join(output, `${name}.png`) });
  await main.addScriptTag({ path: require.resolve('axe-core/axe.min.js') });
  const result = await main.evaluate(async () => {
    const value = await window.axe.run(document.querySelector('[data-testid="website-sales-commerce"]'), { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] } });
    return { violations: value.violations.map(item => ({ id: item.id, impact: item.impact, targets: item.nodes.map(node => node.target) })), incomplete: value.incomplete.map(item => ({ id: item.id, targets: item.nodes.map(node => node.target) })) };
  });
  accessibility.push({ name, ...result }); assert.deepEqual(result.violations, []);
}

try {
  await step('ordinary password and MFA open a canonical Sales record with a new commerce area', async () => {
    actor = await login(fixture); main = actor.page;
    main.on('pageerror', error => errors.push(scrub(error.message)));
    await actor.context.route('**/*', route => {
      const url = new URL(route.request().url());
      if (['data:', 'blob:'].includes(url.protocol) || url.origin === base.origin) return route.continue();
      unexpectedNetwork.push(url.origin + url.pathname); return route.abort();
    });
    const project = await distinctContactProject({ actor, project: fixture.websiteSales.projects[0] }, 'Commerce');
    state = await seedWorkflow(actor, project, 'Commerce'); await prepareOffer(); await openCommerce(state);
    await expect(panel().getByRole('heading', { name: 'Abschluss und Betreuung', exact: true })).toBeVisible();
    const value = await current(); assert.equal(value.workflowId, state.workflow.id); assert.equal(value.canContact, false);
    assert(value.offerChoices.some(row => row.offerRef.id === state.workflow.offerDraftId));
    assert.equal(value.canApproveFacts, true, 'The isolated owner fixture must be explicitly configured, without weakening production admission');
  });
  await step('first policy uses canonical net offer choices without inventing tax issuer or legal defaults', async () => {
    const value = await current(); assert.equal(value.policy, null); assert.equal(value.offers.length, 0); assert(value.offerChoices.length > 0);
    const target = await openConfiguration('configure_policy');
    await expect(target.locator('[name="offer"] option')).toHaveCount(value.offerChoices.filter(row => !['REJECTED', 'CANCELLED'].includes(row.status)).length + 1);
    for (const name of ['taxRate', 'taxAmount', 'issuerName', 'issuerAddress', 'entity', 'termsDigest']) await expect(target.locator(`[name="${name}"]`)).toHaveValue('');
    const template = await openConfiguration('register_template'); await expect(template.locator('[name="content"]')).toHaveValue('');
    await expect(panel().getByRole('button', { name: /^(Als bezahlt markieren|Mark paid|Unterschrift bestätigen|Confirm signature)$/ })).toHaveCount(0);
  });
  await step('invalid template details focus a linked error summary without posting a command', async () => {
    const target = await openConfiguration('register_template'); let posts = 0;
    const observe = request => { if (new URL(request.url()).pathname === endpoint && request.method() === 'POST') posts++; };
    main.on('request', observe); await target.locator('button[type="submit"]').click();
    await expect(target.getByRole('alert')).toBeFocused(); await expect(target.getByRole('alert').getByRole('link').first()).toBeVisible();
    assert.equal(posts, 0); main.off('request', observe);
  });
  await step('an owner-recorded template is persisted through the real authenticated browser and API', async () => {
    const target = await openConfiguration('register_template'); await fillTemplate(target, 'SYNTHETIC commerce browser template');
    const saved = main.waitForResponse(response => new URL(response.url()).pathname === endpoint && response.request().method() === 'POST');
    await target.locator('button[type="submit"]').click(); const response = await saved; assert.equal(response.status(), 200);
    const receipt = await response.json(); assert.equal(receipt.persisted, true); const value = await current();
    initialTemplate = value.templates.find(row => row.id === receipt.data.recordId); assert(initialTemplate);
    assert.equal(initialTemplate.createdBy, actor.account.userId); assert(initialTemplate.payload.content.startsWith('  ') && initialTemplate.payload.content.endsWith('  ')); assert.equal(initialTemplate.payload.contentSha256, digest(initialTemplate.payload.content));
    assert.equal(value.contracts.length, 0); assert.equal(value.outbox.length, 0);
  });
  await step('lost committed template acknowledgement survives reload and blocks every Sales writer until exact reconciliation', async () => {
    const target = await openConfiguration('register_template'); await fillTemplate(target, 'SYNTHETIC lost acknowledgement template');
    let original, captured = false;
    await main.route('**/api/crm/website-sales/commerce?**', async route => {
      if (route.request().method() !== 'POST' || captured) return route.continue();
      original = route.request().postData(); const response = await route.fetch(); assert.equal(response.status(), 200); captured = true;
      expectedFaults.push({ kind: 'COMMITTED_ACKNOWLEDGEMENT_LOST', operation: JSON.parse(original).operation }); await route.abort('failed');
    });
    await target.locator('button[type="submit"]').click();
    await expect(panel().getByText('Das Ergebnis ist noch nicht eindeutig bestätigt.', { exact: false })).toBeVisible();
    const key = `novalure.website-sales-commerce.pending.v1:${actor.account.userId}:${actor.account.workspaceId}`;
    const stored = await main.evaluate(key => JSON.parse(sessionStorage.getItem(key)), key); assert.equal(stored.body, original);
    await main.unroute('**/api/crm/website-sales/commerce?**'); await main.reload(); await openCommerce(state, true);
    await expect(main.locator('[data-website-sales-workbench] form button[type="submit"]:enabled')).toHaveCount(0);
    const reconciled = main.waitForResponse(response => new URL(response.url()).pathname === endpoint + '/reconcile' && response.request().method() === 'POST');
    await panel().getByRole('button', { name: 'Ergebnis abgleichen', exact: true }).click(); const response = await reconciled;
    assert.equal(response.request().postData(), original); assert.equal(response.status(), 200); assert.equal((await response.json()).status, 'COMMITTED');
    await expect.poll(() => main.evaluate(key => sessionStorage.getItem(key), key)).toBe(null);
    const value = await current(); assert.equal(value.templates.filter(row => row.payload.title === 'SYNTHETIC lost acknowledgement template').length, 1);
  });
  await step('a failed latest commerce read retains entered data and disables stale actions until a fresh read', async () => {
    const target = await openConfiguration('register_template'); await target.locator('[name="title"]').fill('SYNTHETIC unsaved retained text');
    await main.route('**/api/crm/website-sales/commerce?**', async route => {
      if (route.request().method() !== 'GET') return route.continue(); expectedFaults.push({ kind: 'LATEST_READ_FAILED', status: 503 });
      return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ code: 'SYNTHETIC_LOCAL_QA_READ_FAILURE' }) });
    });
    await panel().getByRole('button', { name: 'Stand aktualisieren', exact: true }).click();
    await expect(panel().getByText('Der aktuelle Stand konnte nicht geladen werden.', { exact: false })).toBeVisible();
    await expect(target.locator('[name="title"]')).toHaveValue('SYNTHETIC unsaved retained text'); await expect(target.locator('button[type="submit"]')).toBeDisabled();
    await main.unroute('**/api/crm/website-sales/commerce?**'); await refresh(); await expect(target.locator('button[type="submit"]')).toBeEnabled();
  });
  await step('all six commerce sections fit desktop tablet and phone with keyboard access and reduced motion', async () => {
    for (const [name, viewport] of Object.entries({ desktop: { width: 1440, height: 1000 }, tablet: { width: 834, height: 1112 }, phone: { width: 390, height: 844 } })) {
      for (const section of ['offer', 'contract', 'delivery', 'invoice', 'subscription', 'configuration']) {
        await stage(section); if (section === 'configuration') { await openConfiguration('register_template'); await openConfiguration('configure_policy'); }
        await scan(`${name}-${section}`, viewport);
      }
    }
    await main.emulateMedia({ reducedMotion: 'reduce' }); await stage('offer'); await scan('phone-reduced-motion', { width: 390, height: 844 });
    const selector = panel().getByLabel('Schritt in der Abschlussakte', { exact: true }); await selector.focus(); await main.keyboard.press('ArrowDown');
    await expect(selector).toBeFocused(); await expect(selector).toHaveValue('contract');
  });
  await step('no real provider request delivery signature payment or browser exception was produced', async () => {
    const value = await current(); assert.equal(value.outbox.length, 0); assert.equal(value.invoices.length, 0); assert.equal(value.payments.length, 0); assert.equal(value.sourceEvents.length, 0);
    assert.deepEqual(errors, []); assert.deepEqual(unexpectedNetwork, []);
  });
} catch (error) {
  console.error('COMMERCE_BROWSER_FAILURE: ' + scrub(error.message));
  if (main) await main.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => undefined);
  throw new Error(scrub(error.message));
} finally {
  await writeFile(path.join(output, 'result.json'), JSON.stringify({ syntheticOnly: true, sourceRevision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), harnessSha256: digest(await readFile(new URL(import.meta.url))),
    productionAccess: 0, realProviderCalls: 0, providerAcceptance: 'NOT_ATTESTED', server: 'optimized-next-build', authentication: 'ordinary-password-plus-MFA', automaticAccessibilityOnly: true,
    results, accessibility, expectedFaults, errors, unexpectedNetwork, completed: results.length }, null, 2));
  for (const value of contexts) await value.close(); await browser.close(); await admin.end();
}
