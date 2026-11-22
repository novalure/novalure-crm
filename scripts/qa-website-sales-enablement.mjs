import assert from 'node:assert/strict';
import {createHash,createHmac,randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import {chromium,expect as baseExpect} from '@playwright/test';
import sharp from 'sharp';
import { inspectAndSignWebsiteDemo } from './lib/website-sales-rendered-qa.mjs';
// Actual optimized local application, ordinary password/MFA, synthetic records only.
// Start qa-sales-browser-server.mjs --website-sales-operations after the integrated enablement build.
const fixture=JSON.parse(await readFile('.npm-cache/qa/sales-browser-context.json','utf8'));
const base=new URL(fixture.baseUrl),output=path.resolve('.npm-cache/qa/website-sales-enablement-20261122'),expect=baseExpect.configure({timeout:20000});
assert(fixture.syntheticOnly&&fixture.websiteSales?.syntheticOnly&&fixture.websiteStudio?.syntheticOnly);
assert.equal(base.hostname,'127.0.0.1');assert.equal(fixture.database.host,'127.0.0.1');assert(/^sales_qa_[a-f0-9]+$/.test(fixture.database.user));assert.equal(fixture.database.database,'neondb');assert.equal(fixture.fixtureMode,'design-c-current-application-originals');
await mkdir(output,{recursive:true});
const require=createRequire(import.meta.url),admin=new pg.Pool({...fixture.database,user:'qa_admin'}),browser=await chromium.launch({channel:process.env.CRM_QA_BROWSER_CHANNEL||'chrome',headless:true});
const contexts=[],results=[],errors=[],unexpectedNetwork=[],accessibility=[],secretValues=new Set([fixture.password,fixture.websiteStudio.qa.password,fixture.websiteStudio.signer.privateKeyPem]);
const digest=value=>createHash('sha256').update(value).digest('hex');let main,actor,state;

function scrub(value){let text=String(value);for(const secret of secretValues)if(secret)text=text.replaceAll(secret,"[redacted]");return text.replace(/#grant=[^\s"']+/g,"#[redacted]");}
async function step(name,action){await action();results.push({name,status:"PASS"});console.log("PASS "+name);}
async function context(){const value=await browser.newContext({viewport:{width:1440,height:1000},locale:"de-AT",timezoneId:"Europe/Vienna"});contexts.push(value);return value;}
async function api(page,pathname,body){return page.evaluate(async({pathname,body})=>{const method=body===undefined?"GET":"POST",headers={Accept:"application/json"};if(body!==undefined){const response=await fetch("/api/auth/csrf?"+new URLSearchParams({method,path:new URL(pathname,location.origin).pathname}),{cache:"no-store"});const token=await response.json();headers["x-novalure-csrf-token"]=token.csrfToken;headers["Content-Type"]="application/json";}const response=await fetch(pathname,{method,headers,cache:"no-store",...(body===undefined?{}:{body:JSON.stringify(body)})});return{status:response.status,body:await response.json()};},{pathname,body});}
function totp(secret){let bits=0,value=0;const bytes=[],alphabet="ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";for(const c of secret){const i=alphabet.indexOf(c);assert(i>=0);value=(value<<5)|i;bits+=5;if(bits>=8){bits-=8;bytes.push((value>>>bits)&255);value&=(1<<bits)-1;}}const counter=Buffer.alloc(8);counter.writeBigUInt64BE(BigInt(Math.floor(Date.now()/30000)));const hash=createHmac("sha1",Buffer.from(bytes)).update(counter).digest();return String((hash.readUInt32BE(hash.at(-1)&15)&0x7fffffff)%1000000).padStart(6,"0");}
async function login(account){const ctx=await context(),page=await ctx.newPage();page.on("dialog",d=>d.accept());await page.goto(new URL("/login",base).href);const consent=page.getByRole("button",{name:/^(Nur essenzielle|Only necessary)$/});if(await consent.isVisible())await consent.click();await page.locator("#login-email").fill(account.email);await page.locator("#login-password").fill(account.password);await Promise.all([page.waitForNavigation({waitUntil:"domcontentloaded"}),page.locator("form:has(#login-password) button[type=submit]").click()]);await expect(page.locator("#login-mfa-code")).toBeVisible();assert.equal((await api(page,"/api/crm/core")).status,401);const key=page.locator("p").filter({has:page.locator("strong",{hasText:/TOTP-Schlüssel:|TOTP key:/})}).locator("code"),authFile=path.join(output,`synthetic-auth-${account.authIdentityId}.json`);let secret;if(await key.isVisible()){secret=(await key.innerText()).trim();secretValues.add(secret);await writeFile(authFile,JSON.stringify({syntheticOnly:true,authIdentityId:account.authIdentityId,secret}));await page.locator("input[name=recoveryCodesSaved]").check();}else{const cached=JSON.parse(await readFile(authFile,"utf8"));assert(cached.syntheticOnly&&cached.authIdentityId===account.authIdentityId);secret=cached.secret;secretValues.add(secret);}const code=totp(secret);secretValues.add(code);await page.locator("#login-mfa-code").fill(code);await Promise.all([page.waitForNavigation({waitUntil:"domcontentloaded"}),page.getByRole("button",{name:/^(Sicher bestätigen|Verify securely)$/}).click()]);await expect(page.locator(".crm-app")).toBeVisible();assert.equal((await api(page,"/api/settings/language",{preference:"de",expectedUserId:account.userId})).status,200);const cookie=(await ctx.cookies()).find(c=>c.name==="novalure_session");assert(cookie?.httpOnly&&cookie.value.startsWith("v2."));const sessions=await admin.query("select mfa_verified_at from auth_sessions where auth_identity_id=$1 and revoked_at is null",[account.authIdentityId]);assert(sessions.rows.length&&sessions.rows.every(r=>r.mfa_verified_at));return{context:ctx,page,account};}
async function seedWorkflow(actor,project,label){const scope={projectId:project.projectId,companyId:project.companyId};const command=(operation,payload,extra={})=>({contractVersion:"website-sales-ireland-v1",operation,...scope,idempotencyKey:randomUUID(),correlationId:randomUUID(),payload,...extra});const register=await api(actor.page,"/api/crm/website-sales",command("register_location",{countryCode:"IE",address:`SYNTHETIC ${randomUUID()} ${label}, Dublin, Ireland`,sourceUrl:"https://example.invalid/studio-location",sourceReference:"Synthetic local integration evidence only"}));assert.equal(register.status,200);const locationId=register.body.data.location.id,identity={workspaceId:actor.account.workspaceId,...scope,locationId},validUntil=new Date(Date.now()+86400000).toISOString(),facts={IDENTITY:"Synthetic company operates at this registered Irish location.",OWN_WEBSITE_SEARCH:"No own website was found in the synthetic scoped research.",BUSINESS_NEED:"Service information and opening hours should be easy to find."};const prospect={identity,country:"IRELAND",identityStatus:"VERIFIED",domain:null,path:"NO_WEBSITE",ownWebsiteSearch:"NONE_FOUND",obstacle:null,platformUrl:null,bookingRoute:"UNKNOWN",need:"EVIDENCED",evidence:Object.entries(facts).map(([kind,finding])=>({evidenceId:kind.toLowerCase(),identity,kind,sourceUrl:"https://example.invalid/research/"+kind,observedAt:new Date(Date.now()-60000).toISOString(),validUntil,validityCondition:"Review if this exact synthetic source changes",finding,confidence:.95}))};const observe=await api(actor.page,"/api/crm/website-sales",command("observe",{prospect},{locationId,locationVersion:1}));assert.equal(observe.status,200);const qualified=await api(actor.page,"/api/crm/website-sales",command("qualify",{contactId:project.contactId,opportunitySummary:"Synthetic source-bound website opportunity",nextAction:"Review website studio internally",expectedEvidenceDigest:observe.body.data.workflow.evidenceDigest},{locationId,expectedVersion:observe.body.data.workflow.version}));assert.equal(qualified.status,200);assert(qualified.body.data.workflow.leadId&&qualified.body.data.workflow.dealId&&qualified.body.data.workflow.nextTaskId);return{scope:{...scope,locationId},prospect,workflow:qualified.body.data.workflow,project,actor};}
async function openStudio(state){await state.actor.page.goto(new URL(`/?workspaceId=${state.actor.account.workspaceId}&projectId=${state.scope.projectId}#website-sales`,base).href);await state.actor.page.reload({waitUntil:"domcontentloaded"});const workbench=state.actor.page.locator("[data-website-sales-workbench]");await expect(workbench).toBeVisible();const restoring=await state.actor.page.evaluate(({workspaceId,actorId})=>["novalure.website-sales.pending.v1","novalure.website-studio.pending.v1","novalure.website-sales-lifecycle.pending.v1"].some(prefix=>sessionStorage.getItem(`${prefix}:${actorId}:${workspaceId}`)!==null),{workspaceId:state.actor.account.workspaceId,actorId:state.actor.account.userId});if(restoring){await expect(workbench.getByLabel("Unternehmen",{exact:true})).toHaveValue(state.scope.companyId);await expect(workbench.getByLabel("Unternehmensstandort",{exact:true})).toHaveValue(state.scope.locationId);}else{await workbench.getByLabel("Unternehmen",{exact:true}).selectOption(state.scope.companyId);await workbench.getByLabel("Unternehmensstandort",{exact:true}).selectOption(state.scope.locationId);}await expect(state.actor.page.getByTestId("website-sales-studio")).toBeVisible();}
async function scanUi(page,name,viewport,testId="website-sales-studio"){await page.setViewportSize(viewport);const area=page.getByTestId(testId);await area.scrollIntoViewIfNeeded();const overflow=await area.evaluate(element=>[...element.querySelectorAll("button,input,textarea,select,h2,h3,p")].filter(node=>{const r=node.getBoundingClientRect();return r.width>0&&(r.left< -1||r.right>innerWidth+1);}).map(node=>node.tagName));assert.deepEqual(overflow,[]);await page.screenshot({path:path.join(output,`${name}.png`),fullPage:true});await page.addScriptTag({path:require.resolve("axe-core/axe.min.js")});const scan=await page.evaluate(async testId=>{const result=await window.axe.run(document.querySelector(`[data-testid="${testId}"]`),{runOnly:{type:"tag",values:["wcag2a","wcag2aa","wcag21a","wcag21aa","wcag22aa"]}});return{violations:result.violations.map(v=>({id:v.id,impact:v.impact,targets:v.nodes.map(n=>n.target)})),incomplete:result.incomplete.map(v=>({id:v.id,targets:v.nodes.map(n=>n.target)}))};},testId);accessibility.push({name,...scan});assert.deepEqual(scan.violations,[]);}
async function distinctContactProject(state,label){const project={...state.project,contactId:randomUUID()};await admin.query("insert into contacts(id,workspace_id,project_id,organization_id,owner_user_id,name,email,role) values($1,$2,$3,$4,$5,$6,$7,'Ansprechpartner')",[project.contactId,state.actor.account.workspaceId,project.projectId,project.companyId,state.actor.account.userId,`SYNTHETIC ${label} recipient`,`synthetic-${project.contactId}@example.invalid`]);return project;}

const qaAssetDiagnostics=[],probePages=new WeakMap();
function responseEvent(page,predicate){return page.waitForResponse(predicate,{timeout:15000}).then(response=>({response}),()=>({response:null}));}
async function requireResponse(promise,label){const result=await promise;assert(result.response,`${label}: expected actual response was not received`);return result.response;}
async function readStudio(state){const result=await api(state.actor.page,"/api/crm/website-sales/studio?"+new URLSearchParams({workspaceId:state.actor.account.workspaceId,...state.scope}));assert.equal(result.status,200);return result.body;}
async function studioCommand(state,operation,payload){const body={contractVersion:"website-sales-studio-api-v1",operation,...state.scope,workflowId:state.workflow.id,expectedWorkflowVersion:state.workflow.version,expectedEvidenceDigest:state.workflow.evidenceDigest,idempotencyKey:randomUUID(),correlationId:randomUUID(),payload};const result=await api(state.actor.page,"/api/crm/website-sales/studio",body);assert.equal(result.status,200,`Studio ${operation} must succeed: ${result.body.code??result.status}`);assert.equal(result.body.persisted,true);return result.body;}
async function signDemo(state,qaActor,label){const current=await readStudio(state),record=current.artifacts.find(row=>row.artifact.kind==="DEMO");assert(record);for(const asset of record.artifact.content.assets){const assetUrl=new URL(`/api/crm/website-sales/studio/qa-render/${record.id}/assets/${asset.path}`,base).href,live=await qaActor.page.evaluate(async url=>{const r=await fetch(url,{cache:"no-store"});return{status:r.status,type:r.headers.get("content-type")};},assetUrl),replay=await qaActor.context.request.get(assetUrl);const diagnostic={label,path:asset.path,browserStatus:live.status,apiStatus:replay.status()};qaAssetDiagnostics.push(diagnostic);console.log("QA_ASSET_DIAGNOSTIC "+JSON.stringify(diagnostic));assert.equal(live.status,200,"The genuine authenticated browser must load the scoped QA asset");}const certificate=await inspectAndSignWebsiteDemo({context:qaActor.context,baseUrl:base.href,scope:{workspaceId:state.actor.account.workspaceId,...state.scope},artifactRecord:record,workflowId:state.workflow.id,qaActorId:qaActor.account.userId,...fixture.websiteStudio.signer,outputDirectory:path.join(output,label)});await studioCommand(state,"submit_qa",{artifactId:record.id,certificate});return record;}
async function newGrant(state,demo){const response=await studioCommand(state,"create_preview",{artifactId:demo.id,contactId:state.project.contactId,expiresAt:new Date(Date.now()+600000).toISOString()});assert(response.invitation);secretValues.add(response.invitation.token);return response.invitation;}
async function browserStatus(ctx,url,body){let page=probePages.get(ctx);if(!page){page=await ctx.newPage();await page.goto(new URL("/sales-preview/access",base).href,{waitUntil:"domcontentloaded"});probePages.set(ctx,page);}return page.evaluate(async({url,body})=>{const response=await fetch(url,{cache:"no-store",credentials:"same-origin",...(body===undefined?{}:{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)})});await response.body?.cancel();return response.status;},{url,body});}
async function exchange(ctx,grant){const page=await ctx.newPage(),url=new URL(`/sales-preview/access#grant=${grant.grantId}&token=${grant.token}`,base).href;const loaded=responseEvent(page,response=>new URL(response.url()).pathname===`/sales-preview/${grant.grantId}/render`);await page.goto(url,{waitUntil:"domcontentloaded"});const response=await requireResponse(loaded,"Recipient render after exchange");await page.waitForLoadState("networkidle",{timeout:10000});assert.equal(response.status(),200,"The genuine recipient browser must reach authorized HTML");await expect(page).toHaveURL(new URL(`/sales-preview/${grant.grantId}/render`,base).href);await page.close();return {status:200};}

const endpoint = '/api/crm/website-sales/enablement';
const panel = () => main.getByTestId('website-sales-enablement');
const scoped = () => endpoint + '?' + new URLSearchParams({ workspaceId: actor.account.workspaceId, ...state.scope });
async function current() { const response = await api(main, scoped()); assert.equal(response.status, 200, response.body.code); return response.body; }
async function tab(name) { await panel().getByRole('tab', { name, exact: true }).click(); }
async function basis(form, reference = 'SYNTHETIC operator-recorded local QA source') {
  await form.locator('[name="sourceReference"]').fill(reference);
  await form.locator('[name="attest"]').check();
}
async function save(form) { await form.locator('button[type="submit"]').click(); }
async function refresh() {
  await panel().getByRole('button', { name: 'Aktualisieren', exact: true }).click();
  await expect(panel().getByRole('button', { name: 'Aktualisieren', exact: true })).toBeEnabled();
}
let initialBriefId;
try {
  await step('ordinary password and MFA open seven enablement areas on an actual qualified CRM opportunity', async () => {
    actor = await login(fixture); main = actor.page;
    main.on('pageerror', error => errors.push(scrub(error.message)));
    main.on('console', message => { if (message.type() === 'error' && !message.text().startsWith('Failed to load resource:')) errors.push(scrub(message.text())); });
    main.on('request', request => { if (new URL(request.url()).origin !== base.origin) unexpectedNetwork.push(new URL(request.url()).origin); });
    state = await seedWorkflow(actor, await distinctContactProject({ actor, project: fixture.websiteSales.projects[0] }, 'Enablement'), 'Enablement');
    await openStudio(state); await expect(panel()).toBeVisible(); await expect(panel().getByRole('tab')).toHaveCount(7);
    const read = await current(); assert.equal(read.canContact, false); assert.equal(read.identity.companyId, state.scope.companyId);
  });
  await step('the labelled brief form preserves unknown customer budget and records source-backed open questions', async () => {
    await tab('Bedarf'); const form = main.getByTestId('enablement-brief-form');
    for (const [name, value] of Object.entries({ goals: 'PRIVATE_SYNTHETIC_BUDGET_STRATEGY', audience: 'Local test audience', services: 'Information pages', openQuestions: 'Who signs the final scope?' })) await form.locator(`[name="${name}"]`).fill(value);
    await tab('Abschluss'); await tab('Bedarf'); await expect(form.locator('[name="goals"]')).toHaveValue('PRIVATE_SYNTHETIC_BUDGET_STRATEGY');
    await basis(form); await save(form);
    await expect.poll(async () => (await current()).brief?.payload.goals[0]).toBe('PRIVATE_SYNTHETIC_BUDGET_STRATEGY');
    const read = await current(); assert.deepEqual(read.brief.payload.customerBudget, { status: 'UNKNOWN', amountMinor: null, currency: 'EUR' });
    assert(read.briefAssessment.reasons.includes('CUSTOMER_BUDGET_UNKNOWN')); initialBriefId = read.brief.id;
  });
  await step('a lost committed brief response survives reload and blocks every Sales write until exact reconciliation', async () => {
    const form = main.getByTestId('enablement-brief-form'); await form.locator('[name="budgetStatus"]').selectOption('KNOWN');
    await form.locator('[name="budget"]').fill('0'); await basis(form, 'SYNTHETIC explicitly known zero customer budget');
    await main.evaluate(() => { const original = window.fetch.bind(window); let once = true; window.fetch = async (input, init) => {
      const request = new Request(input instanceof Request ? input.clone() : new URL(String(input), location.href), init);
      const lose = once && request.method === 'POST' && new URL(request.url).pathname === '/api/crm/website-sales/enablement' && (await request.clone().json()).operation === 'record_brief';
      const response = await original(input, init); if (lose && response.ok) { once = false; await response.body?.cancel(); throw new TypeError('SYNTHETIC post-commit enablement response loss'); } return response;
    }; });
    await save(form); await expect(panel().getByText('Eine vorherige Speicherung muss zuerst geklärt werden.', { exact: true })).toBeVisible();
    await expect(main.locator('[data-website-sales-workbench]').getByLabel('Unternehmen', { exact: true })).toBeDisabled();
    await expect(panel().locator('form button[type="submit"]:enabled')).toHaveCount(0);
    await expect(main.locator('[data-website-sales-workbench] form button[type="submit"]:enabled')).toHaveCount(0);
    await main.reload({ waitUntil: 'domcontentloaded' }); await expect(panel()).toBeVisible();
    await expect(main.locator('[data-website-sales-workbench]').getByLabel('Unternehmen', { exact: true })).toBeDisabled();
    await panel().getByRole('button', { name: 'Speicherung abgleichen', exact: true }).click();
    await expect(main.locator('[data-website-sales-workbench]').getByLabel('Unternehmen', { exact: true })).toBeEnabled();
    const read = await current(); assert.deepEqual(read.brief.payload.customerBudget, { status: 'KNOWN', amountMinor: 0, currency: 'EUR' });
    assert(read.briefAssessment.reasons.includes('CUSTOMER_BUDGET_KNOWN_ZERO')); assert.equal(read.brief.id, initialBriefId);
  });
  await step('a failed refresh retains edited form fields and keeps stale writes disabled until a fresh read succeeds', async () => {
    await tab('Bedarf'); const form = main.getByTestId('enablement-brief-form');
    await form.locator('[name="goals"]').fill('SYNTHETIC unsaved field retained after read failure');
    const failRead = route => route.request().method()==='GET' ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ code: 'SYNTHETIC_READ_UNAVAILABLE' }) }) : route.continue();
    await main.route('**/api/crm/website-sales/enablement?*', failRead); await refresh();
    await expect(form.locator('button[type="submit"]')).toBeDisabled(); await expect(form.locator('[name="goals"]')).toHaveValue('SYNTHETIC unsaved field retained after read failure');
    await main.unroute('**/api/crm/website-sales/enablement?*', failRead); await refresh(); await expect(form.locator('button[type="submit"]')).toBeEnabled();
    await expect(form.locator('[name="goals"]')).toHaveValue('SYNTHETIC unsaved field retained after read failure');
  });
  await step('the close plan binds actual contact versions, roles and existing canonical milestone tasks', async () => {
    await tab('Abschluss'); const form = main.getByTestId('enablement-close-plan-form'), read = await current();
    const contact = read.contacts.find(row => row.contactId === state.project.contactId), task = read.tasks.find(row => row.status === 'OPEN'); assert(contact && task);
    await form.locator(`[name="contactIds"][value="${contact.contactId}"]`).check();
    for (const role of ['DECISION_MAKER', 'SIGNATORY']) await form.locator(`[name="roles-${contact.contactId}"][value="${role}"]`).check();
    await form.locator(`[name="taskIds"][value="${task.taskId}"]`).check(); await form.locator('[name="nextStepTaskId"]').selectOption(task.taskId);
    await basis(form); await save(form); await expect.poll(async () => (await current()).closePlan?.payload.nextStepTaskId).toBe(task.taskId);
    const plan = (await current()).closePlan.payload; assert.equal(plan.contacts[0].contactVersion, contact.version); assert.equal(plan.contacts[0].sourceDigest, contact.sourceDigest); assert.equal(plan.milestones[0].kind, 'INTERNAL_TARGET');
    await panel().getByRole('button', { name: 'Nächsten Schritt vorbereiten', exact: true }).click();
    await expect.poll(async () => (await current()).aggregateVersion).toBeGreaterThan(read.aggregateVersion + 1);
  });
  await step('contact changes make the saved close-plan assessment visibly stale instead of silently reusing its roles', async () => {
    await admin.query('update contacts set name=name || $1,version=version+1 where id=$2 and workspace_id=$3', [' changed', state.project.contactId, actor.account.workspaceId]);
    await refresh(); const read = await current(); assert(read.closePlanAssessment.reasons.includes('CANONICAL_CONTACT_CHANGED'));
    await expect(panel().getByText('Entscheidung klären', { exact: true })).toBeVisible();
  });
  await step('real decoded image bytes and separately approved references bind the selected industry profile', async () => {
    await tab('Demos & Referenzen');
    const raster = await sharp({ create: { width: 640, height: 400, channels: 3, background: '#153a52' } }).png().toBuffer();
    const assetForm = main.getByTestId('enablement-asset-form');
    await assetForm.locator('[name="file"]').setInputFiles({ name: 'synthetic-owned-qa.png', mimeType: 'image/png', buffer: raster });
    for (const [name,value] of Object.entries({ title: 'SYNTHETIC owned QA image', alt: 'Solid blue synthetic QA image', rightsReference: 'SYNTHETIC generated locally for this isolated test' })) await assetForm.locator(`[name="${name}"]`).fill(value);
    await assetForm.locator('[name="rights"]').check(); await save(assetForm);
    await expect.poll(async () => (await current()).assets.length).toBe(1);
    const asset = (await current()).assets[0]; assert.equal(asset.mediaType, 'image/webp'); assert.equal(asset.width, 640); assert.equal(asset.height, 400);
    assert(asset.sizeBytes > 0 && asset.sizeBytes <= 262144); assert.equal(Object.hasOwn(asset, 'body'), false); assert.equal(Object.hasOwn(asset, 'bytes'), false);
    const referenceForm = main.getByTestId('enablement-reference-form');
    for (const [name,value] of Object.entries({ title: 'SYNTHETIC supported local reference', summary: 'Synthetic local QA fixture; no real client result claimed', claims: 'Synthetic locally approved case information', rightsReference: 'SYNTHETIC local test owner reference' })) await referenceForm.locator(`[name="${name}"]`).fill(value);
    await referenceForm.locator('[name="presentation"]').check(); await basis(referenceForm); await save(referenceForm);
    await expect.poll(async () => (await current()).references.length).toBe(1);
    const reference = (await current()).references[0], approval = main.getByTestId(`enablement-approve-reference-${reference.id}-form`);
    await approval.locator('[name="confirm"]').check(); await save(approval);
    await expect.poll(async () => (await current()).referenceReviews.length).toBe(1);
    const profileForm = main.getByTestId('enablement-profile-form'); await profileForm.locator('[name="industryCode"]').selectOption('HOSPITALITY');
    await profileForm.locator(`[name="assetIds"][value="${asset.assetId}"]`).check(); await profileForm.locator(`[name="referenceCaseIds"][value="${reference.id}"]`).check();
    await basis(profileForm); await save(profileForm);
    await expect.poll(async () => (await current()).demoProfiles[0]?.payload.industryCode).toBe('HOSPITALITY');
    const profile = (await current()).demoProfiles[0]; assert.deepEqual(profile.payload.assetIds, [asset.assetId]); assert.deepEqual(profile.payload.referenceCaseIds, [reference.id]);
  });
  await step('a saved private brief and approved media produce a real independently inspected demo whose HTML and assets revoke together', async () => {
    const enabled = await current(), brief = enabled.brief, profile = enabled.demoProfiles[0];
    const plan = { estimatedCostMinor: 0, availableBudgetMinor: 0, expectedNetPriceMinor: 250000, estimatedDeliveryCostMinor: 50000, minimumMarginBasisPoints: 3000, requiredCapacityMinutes: 60, availableCapacityMinutes: 600, rightsVerified: true, budgetReference: null };
    const source = state.prospect.evidence.find(row => row.kind==='BUSINESS_NEED'), claim = { text: source.finding, evidenceIds: [source.evidenceId] }, scope = { included: ['Proposed website information'], excluded: ['No booking, payment, publication or unagreed services'] };
    const diagnosis = await studioCommand(state, 'create_diagnosis', { version: 1, previousArtifactDigest: null, recommendations: [claim], scope, investmentPlan: plan });
    const concept = await studioCommand(state, 'create_concept', { version: 1, previousArtifactDigest: null, diagnosisDigest: diagnosis.data.artifactDigest, objective: 'Source-backed internal website direction',
      hero: claim, sections: [{ title: 'Current source observation', body: claim }], visualDirection: 'STUDIO_BLUE', scope, investmentPlan: plan, briefBinding: { briefId: brief.id, version: brief.version, digest: brief.digest } });
    await studioCommand(state, 'accept_concept', { artifactId: concept.data.artifactId });
    const built = await studioCommand(state, 'build_demo', { version: 1, previousArtifactDigest: null, conceptDigest: concept.data.artifactDigest, investmentPlan: plan, profileBinding: { profileId: profile.id, version: profile.version, digest: profile.digest } });
    const history = await readStudio(state), selected = history.artifacts.find(row => row.id===built.data.artifactId); assert(selected);
    const binary = selected.artifact.content.assets.find(asset => asset.bodyEncoding==='BASE64'); assert(binary && binary.bodyOmitted===true && !Object.hasOwn(binary,'body'));
    const stored = (await admin.query('select artifact from crm_website_studio_artifacts where id=$1 and workspace_id=$2', [built.data.artifactId, actor.account.workspaceId])).rows[0].artifact;
    const publicBytes = stored.content.html + stored.content.assets.map(asset => asset.body).join('');
    assert.equal(publicBytes.includes('PRIVATE_SYNTHETIC_BUDGET_STRATEGY'), false); assert.equal(publicBytes.includes('Who signs the final scope?'), false);
    assert.equal((await admin.query('select crm_website_sales_demo_profile_current($1::jsonb) as current', [JSON.stringify(stored)])).rows[0].current, true);
    const qa = await login(fixture.websiteStudio.qa), demo = await signDemo(state, qa, 'branded-independent-render'), grant = await newGrant(state, demo), recipient = await context();
    await exchange(recipient, grant);
    for (const resource of ['render', ...stored.content.assets.map(asset => 'assets/'+asset.path)]) assert.equal(await browserStatus(recipient, new URL(`/sales-preview/${grant.grantId}/${resource}`,base).href), 200);
    const live = await current(), revoked = await api(main, scoped(), { contractVersion: 'website-sales-enablement-v1', ...state.scope, operation: 'revoke_asset', expectedVersion: live.aggregateVersion,
      expectedWorkflowVersion: live.workflowVersion, idempotencyKey: randomUUID(), correlationId: randomUUID(), payload: { assetId: enabled.assets[0].assetId, reason: 'SYNTHETIC permission withdrawal after genuine local rendered QA' } });
    assert.equal(revoked.status, 200, revoked.body.code); assert.equal((await admin.query('select crm_website_sales_demo_profile_current($1::jsonb) as current', [JSON.stringify(stored)])).rows[0].current, false);
    for (const resource of ['render', ...stored.content.assets.map(asset => 'assets/'+asset.path)]) assert.equal(await browserStatus(recipient, new URL(`/sales-preview/${grant.grantId}/${resource}`,base).href), 404);
    assert.equal((await api(qa.page, `/api/crm/website-sales/studio/qa-render/${demo.id}/artifact?`+new URLSearchParams(state.scope))).status, 404);
    await refresh();
  });
  await step('project-wide duplicate suggestions and their recorded review never merge or delete canonical companies', async () => {
    const existing = (await admin.query('select name from organizations where workspace_id=$1 and project_id=$2 and id=$3', [actor.account.workspaceId, state.scope.projectId, state.scope.companyId])).rows[0];
    const duplicate = randomUUID(), domain = `https://synthetic-${duplicate}.example.invalid`;
    await admin.query('update organizations set domain=$1,version=version+1 where workspace_id=$2 and id=$3', [domain, actor.account.workspaceId, state.scope.companyId]);
    await admin.query("insert into organizations(id,workspace_id,project_id,name,type,division,domain) values($1,$2,$3,$4,'Unternehmen','WEB_DESIGN',$5)", [duplicate, actor.account.workspaceId, state.scope.projectId, existing.name, domain]);
    const before = (await admin.query('select count(*)::int total from organizations where workspace_id=$1 and project_id=$2', [actor.account.workspaceId, state.scope.projectId])).rows[0].total;
    await tab('Datenqualität'); await panel().getByRole('button', { name: 'Projektweite Datenprüfung', exact: true }).click();
    await expect.poll(async () => (await current()).hygieneCandidates.some(row => row.kind==='ORGANIZATION' && row.recordIds.includes(duplicate) && row.recordIds.includes(state.scope.companyId))).toBe(true);
    const read = await current(), candidate = read.hygieneCandidates.find(row => row.kind==='ORGANIZATION' && row.recordIds.includes(duplicate));
    assert.equal(candidate.autoMergeAllowed, false); assert.equal(candidate.realRecordMutationAllowed, false);
    const form = main.getByTestId(`enablement-hygiene-${candidate.candidateDigest}-form`);
    await form.locator('[name="disposition"]').selectOption('NEEDS_MORE_EVIDENCE'); await form.locator('[name="rationale"]').fill('SYNTHETIC shared-name/domain evidence needs owner review');
    await basis(form); await save(form); await expect.poll(async () => (await current()).aggregateVersion).toBeGreaterThan(read.aggregateVersion);
    await openStudio(state); await tab('Datenqualität');
    const decision = (await current()).hygieneAnnotations.find(item => item.candidateDigest===candidate.candidateDigest);
    assert(decision && decision.disposition==='NEEDS_MORE_EVIDENCE' && decision.current); assert.equal(decision.recordedBy, actor.account.userId);
    await expect(main.getByTestId('website-enablement-hygiene-decisions').getByText('SYNTHETIC shared-name/domain evidence needs owner review', { exact: true })).toBeVisible();
    assert.equal((await admin.query('select count(*)::int total from organizations where workspace_id=$1 and project_id=$2', [actor.account.workspaceId, state.scope.projectId])).rows[0].total, before);
    assert.equal((await admin.query('select count(*)::int total from organizations where workspace_id=$1 and id=any($2::uuid[])', [actor.account.workspaceId, [duplicate,state.scope.companyId]])).rows[0].total, 2);
  });
  await step('terminal reasons and care offers refuse invented canonical closure or completed delivery', async () => {
    const read = await current(), identity = read.identity, original = { contractVersion: 'website-sales-enablement-v1', ...state.scope,
      expectedVersion: read.aggregateVersion, expectedWorkflowVersion: read.workflowVersion, idempotencyKey: randomUUID(), correlationId: randomUUID(),
      operation: 'record_closure_reason', payload: { reasonCode: 'PRICE', explanation: 'SYNTHETIC unclosed deal cannot be declared lost', industryCode: 'GENERAL', offerVersion: null,
        sourceReferences: [{ reference: 'SYNTHETIC owner record', digest: 'a'.repeat(64), basis: 'OPERATOR_ATTESTATION', observedAt: new Date().toISOString(), validUntil: new Date(Date.now()+86400000).toISOString() }], validUntil: new Date(Date.now()+86400000).toISOString() } };
    assert(identity.workspaceId === actor.account.workspaceId); assert.notEqual((await api(main, scoped(), original)).status, 200);
    const denied = await api(main, scoped(), { ...original, operation: 'record_care_basis', idempotencyKey: randomUUID(), correlationId: randomUUID(),
      payload: { need: 'SYNTHETIC uncompleted delivery', canonicalDeliveryTaskId: randomUUID(), planKeys: ['MANAGED'], sourceReferences: original.payload.sourceReferences, validUntil: original.payload.validUntil } });
    assert.notEqual(denied.status, 200); assert.equal((await current()).careCandidates.length, 0);
  });
  await step('all seven areas fit desktop tablet and phone and remain usable with reduced motion and keyboard navigation', async () => {
    const names = ['Bedarf', 'Abschluss', 'Demos & Referenzen', 'Heute', 'Abschlussgründe', 'Bestandskunden', 'Datenqualität'];
    const ids = ['brief', 'close-plan', 'demos', 'today', 'closures', 'care', 'hygiene'];
    for (const [name, viewport] of Object.entries({ desktop: { width: 1440, height: 1000 }, tablet: { width: 834, height: 1112 }, phone: { width: 390, height: 844 } })) {
      for (let index=0; index<names.length; index++) { await tab(names[index]); await scanUi(main, `${name}-${ids[index]}`, viewport, `website-enablement-${ids[index]}`); }
    }
    await main.emulateMedia({ reducedMotion: 'reduce' }); await tab('Bedarf'); await scanUi(main, 'phone-reduced-motion', { width: 390, height: 844 }, 'website-enablement-brief');
    const tabs = panel().getByRole('tab'); await tabs.nth(0).focus(); await main.keyboard.press('ArrowRight'); await expect(tabs.nth(1)).toBeFocused();
    await expect(panel().getByRole('button', { name: /^(Senden|Send)$/ })).toHaveCount(0);
  });
  await step('no provider request outbound delivery or browser exception occurred', async () => {
    assert.deepEqual((await admin.query('select (select count(*) from crm_offer_deliveries)::int offers,(select count(*) from crm_outreach_deliveries)::int outreach')).rows[0], { offers: 0, outreach: 0 });
    assert.deepEqual(errors, []); assert.deepEqual(unexpectedNetwork, []);
  });
} catch (error) {
  console.error('ENABLEMENT_BROWSER_FAILURE: ' + scrub(error.message));
  if (main) await main.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => undefined);
  throw new Error(scrub(error.message));
} finally {
  await writeFile(path.join(output, 'result.json'), JSON.stringify({ syntheticOnly: true, sourceRevision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    harnessSha256: digest(await readFile(new URL(import.meta.url))), productionAccess: 0, providerCalls: 0, server: 'optimized-next-build', authentication: 'ordinary-password-plus-MFA',
    automaticAccessibilityOnly: true, results, accessibility, qaAssetDiagnostics, errors, unexpectedNetwork, completed: results.length }, null, 2));
  for (const value of contexts) await value.close(); await browser.close(); await admin.end();
}
