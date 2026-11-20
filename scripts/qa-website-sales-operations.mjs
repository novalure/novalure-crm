import assert from 'node:assert/strict';
import {createHash,createHmac,randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import {chromium,expect as baseExpect} from '@playwright/test';
// Actual optimized local application, ordinary password/MFA, synthetic records only.
// Start qa-sales-browser-server.mjs --website-sales-operations.
const fixture=JSON.parse(await readFile('.npm-cache/qa/sales-browser-context.json','utf8'));
const base=new URL(fixture.baseUrl),output=path.resolve('.npm-cache/qa/website-sales-operations'),expect=baseExpect.configure({timeout:20000});
assert(fixture.syntheticOnly&&fixture.websiteSales?.syntheticOnly&&fixture.websiteStudio?.syntheticOnly);
assert.equal(base.hostname,'127.0.0.1');assert.equal(fixture.database.host,'127.0.0.1');assert(/^sales_qa_[a-f0-9]+$/.test(fixture.database.user));assert.equal(fixture.database.database,'neondb');assert.equal(fixture.fixtureMode,'design-c-current-application-originals');
await mkdir(output,{recursive:true});
const require=createRequire(import.meta.url),admin=new pg.Pool({...fixture.database,user:'qa_admin'}),browser=await chromium.launch({channel:process.env.CRM_QA_BROWSER_CHANNEL||'chrome',headless:true});
const contexts=[],results=[],errors=[],unexpectedNetwork=[],accessibility=[],secretValues=new Set([fixture.password]);
const digest=value=>createHash('sha256').update(value).digest('hex');let main,actor,state,second;

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
async function incoming(state,body){const connection=await admin.connect();const connectionId=randomUUID(),messageId=randomUUID();try{await connection.query("begin");await connection.query("select set_config('app.tenant_id',$1,true),set_config('app.actor_id',$2,true)",[state.actor.account.workspaceId,state.actor.account.userId]);const contact=(await connection.query("select email from contacts where workspace_id=$1 and id=$2",[state.actor.account.workspaceId,state.project.contactId])).rows[0];await connection.query("insert into crm_mailbox_connections(id,workspace_id,user_id,provider,account_label,status,granted_scopes) values($1,$2,$3,'google',$4,'disconnected','[]'::jsonb)",[connectionId,state.actor.account.workspaceId,state.actor.account.userId,"SYNTHETIC disconnected canonical fixture "+connectionId]);await connection.query("insert into crm_mailbox_messages(id,workspace_id,user_id,connection_id,provider_id,subject,from_label,from_address,received_at,body_text,content_hash) values($1,$2,$3,$4,$5,'SYNTHETIC incoming test message','Synthetic existing contact',$6,clock_timestamp(),$7,$8)",[messageId,state.actor.account.workspaceId,state.actor.account.userId,connectionId,`synthetic-${messageId}`,contact.email,body,digest(body)]);await connection.query("insert into crm_mailbox_links(workspace_id,user_id,message_id,project_id,lead_id,contact_id,share_body,confirmed_reply,review_reason) values($1,$2,$3,$4,$5,$6,false,true,'Synthetic confirmed local message association for real browser acceptance')",[state.actor.account.workspaceId,state.actor.account.userId,messageId,state.scope.projectId,state.workflow.leadId,state.project.contactId]);await connection.query("commit");return messageId;}catch(error){await connection.query("rollback");throw error;}finally{connection.release();}}

const operationsPath = "/api/crm/website-sales/autonomy", conversationPath = "/api/crm/website-sales/conversation";
function scoped(pathname, target = state) { return pathname + "?" + new URLSearchParams({ workspaceId: actor.account.workspaceId, ...target.scope }); }
async function opsRead(target = state) { const response = await api(main, scoped(operationsPath, target)); assert.equal(response.status, 200, response.body.code ?? "Operations read failed"); return response.body; }
async function dialogRead() { const response = await api(main, scoped(conversationPath)); assert.equal(response.status, 200, response.body.code ?? "Conversation read failed"); return response.body; }
async function ops(operation, payload, expectedVersion) {
  const response = await api(main, scoped(operationsPath), { contractVersion: "website-sales-operations-v1", operation, ...state.scope, expectedVersion,
    idempotencyKey: randomUUID(), correlationId: randomUUID(), payload });
  assert.equal(response.status, 200, `Operations ${operation}: ${response.body.code ?? response.status}`); return response.body;
}
async function openOperations(tab = "Portfolio") {
  await openStudio(state); const panel = main.getByTestId("website-sales-operations"); await expect(panel).toBeVisible();
  await panel.getByRole("tab", { name: tab, exact: true }).click(); return panel;
}
async function refreshOperations() {
  const panel = main.getByTestId("website-sales-operations"); await panel.getByRole("button", { name: "Aktuellen Stand laden", exact: true }).click();
  await expect(panel.getByRole("button", { name: "Aktuellen Stand laden", exact: true })).toBeEnabled(); return panel;
}
async function prepareOffer() {
  const detail = await api(main, scoped("/api/crm/website-sales/workbench") + "&view=detail"); assert.equal(detail.status, 200);
  const content = { subject: "SYNTHETIC website proposal", recipientName: detail.body.contact.name, recipientEmail: detail.body.contact.email,
    scope: "Three responsive information pages", paymentPlan: "Internal review only", discounts: "None", specialTerms: "Synthetic local QA only", riskComplianceNotes: "No live sending",
    terms: "Subject to actual final offer approval", validUntil: new Date(Date.now() + 86400000).toISOString(), currency: "EUR", taxBasis: "NET", items: [{ description: "Website", quantity: 1, unitNetCents: 100000 }] };
  const result = await api(main, scoped("/api/crm/website-sales"), { contractVersion: "website-sales-ireland-v1", operation: "prepare_offer", ...state.scope,
    expectedVersion: state.workflow.version, idempotencyKey: randomUUID(), correlationId: randomUUID(), payload: { content, expectedEvidenceDigest: state.workflow.evidenceDigest } });
  assert.equal(result.status, 200, result.body.code); state.workflow = result.body.data.workflow;
}
async function includeDocument(kind, amountMinor = null) {
  const read = await opsRead(), money = amountMinor !== null, financial = money || kind.endsWith("_COMPLETE");
  const recorded = await ops("register_financial_evidence", { sourceSystem: financial ? "APPROVED_MANUAL" : "CRM", recordId: "synthetic-document:" + randomUUID(), economicEventId: randomUUID(),
    recordVersion: 1, previousSourceDigest: null, supersedesSourceId: null, kind, currency: "EUR", amountMinor,
    occurredAt: new Date(Date.now() - 1000).toISOString(), relatedSourceId: null, basis: money ? "SETTLED_ACTUAL" : "CRM_OBSERVATION" }, read.workflow.version);
  const source = (await opsRead()).financialEvidence.find(value => value.sourceId === recorded.data.financialEvidenceId); assert(source);
  await ops("record_outcome", { sourceId: source.sourceId, canonicalSourceHash: source.canonicalSourceHash }, read.workflow.version);
}

let pricingRuleId, lossCandidate;
try {
  await step("ordinary password and MFA open the actual operations workbench with two canonical companies", async () => {
    actor = await login(fixture); main = actor.page;
    main.on("pageerror", error => errors.push(scrub(error.message)));
    main.on("console", message => { if (message.type() === "error" && !message.text().startsWith("Failed to load resource:")) errors.push(scrub(message.text())); });
    main.on("request", request => { if (new URL(request.url()).origin !== base.origin) unexpectedNetwork.push(new URL(request.url()).origin); });
    const project = fixture.websiteSales.projects[0];
    state = await seedWorkflow(actor, await distinctContactProject({ actor, project }, "Operations first"), "Operations first");
    const companyId = randomUUID();
    await admin.query("insert into organizations(id,workspace_id,project_id,name,type,division) values($1,$2,$3,'SYNTHETIC second operations company','Unternehmen','WEB_DESIGN')", [companyId, actor.account.workspaceId, project.projectId]);
    const secondProject = { ...project, companyId };
    second = await seedWorkflow(actor, await distinctContactProject({ actor, project: secondProject }, "Operations second"), "Operations second");
    await prepareOffer(); await openOperations("Preise");
  });
  await step("owner records a bounded pricing rule through the real labelled form", async () => {
    const form = main.getByTestId("website-operations-pricing-rule-form");
    for (const [name, value] of Object.entries({ service: "SYNTHETIC Website project", listPrice: "1000", minimumPrice: "700", deliveryCost: "400", discount: "20", margin: "30", rounds: "4", age: "60", step: "5", counteroffers: "2" })) await form.locator(`[name="${name}"]`).fill(value);
    await form.getByRole("checkbox").check(); await form.getByRole("button", { name: "Preisregel freigeben", exact: true }).click();
    await expect.poll(async () => (await opsRead()).policies.filter(value => value.kind === "PRICING" && value.active).length).toBe(1);
    pricingRuleId = (await opsRead()).policies.find(value => value.kind === "PRICING" && value.active).id;
  });
  await step("owner explicitly saves portfolio effort and the project retains the original two-opportunity denominator", async () => {
    await main.getByTestId("website-sales-operations").getByRole("tab", { name: "Portfolio", exact: true }).click();
    const form = main.getByTestId("website-operations-portfolio-form");
    for (const [name, value] of Object.entries({ name: "SYNTHETIC shared operations window", budget: "3", capacity: "10", maxCases: "2", maxCompany: "1", maxCost: "3", maxMinutes: "10", known: "2", score: "1" })) await form.locator(`[name="${name}"]`).fill(value);
    for (const stage of ["DIAGNOSIS", "CONCEPT", "DEMO", "CONVERSATION"]) { await form.locator(`[name="cost-${stage}"]`).fill(stage === "CONVERSATION" ? "0" : "3"); await form.locator(`[name="minutes-${stage}"]`).fill(stage === "CONVERSATION" ? "1" : "10"); }
    await form.getByLabel("Ich habe Budget, Kapazität und Aufwand geprüft und gebe diese internen Grenzen frei.", { exact: true }).check();
    await form.getByRole("button", { name: "Grenzen freigeben", exact: true }).click(); await expect.poll(async () => (await opsRead()).portfolio?.version ?? 0).toBe(1);
    const view = await opsRead(), past = new Date(Date.now() - 60000).toISOString(), until = new Date(Date.now() + 3600000).toISOString();
    // Owner-recorded test configuration adds a bounded learning rule; no financial or promotion authority is minted by the machine.
    await ops("configure_portfolio", { title: "SYNTHETIC shared operations window", budgetMinor: 300, capacityMinutes: 10, windowStart: past, windowEnd: until,
      managedResources: [state.scope, second.scope], stageEstimates: [{ stage: "DIAGNOSIS", estimatedCostMinor: 300, requiredMinutes: 10 }, { stage: "CONVERSATION", estimatedCostMinor: 0, requiredMinutes: 1 }],
      policy: { enabled: true, validFrom: past, validUntil: until, maxOpportunities: 2, maxPerCompany: 1, maxCostPerOpportunityMinor: 300, maxMinutesPerOpportunity: 10, minimumKnownSignals: 2, minimumScore: 1, weights: { FIT: 5000, NEED: 5000, INTENT: 0, URGENCY: 0, ENGAGEMENT: 0 } },
      improvementTargetRuleId: pricingRuleId, improvementRule: { enabled: true, validFrom: past, validUntil: until, minimumCompletedSamples: 1, minimumCoverageBps: 5000,
        permittedField: "MIN_MARGIN_BPS", currentValue: 3000, minimumValue: 2000, maximumValue: 6000, maximumAbsoluteChange: 500 } }, view.portfolio.version);
    await refreshOperations();
    const plan = main.getByTestId("website-operations-plan-form"); await plan.locator('[name="stage"]').selectOption("DIAGNOSIS");
    for (const workflowId of [state.workflow.id, second.workflow.id]) await main.getByTestId("website-operations-portfolio").locator(`input[name="opportunityId"][value="${workflowId}"]`).check();
    await plan.getByRole("button", { name: "Aufwand reservieren", exact: true }).click();
    await expect.poll(async () => (await opsRead()).allocations.filter(value => value.status === "RESERVED").length).toBe(1);
    const allocated = await opsRead(); assert.equal(allocated.cohort.denominator, 2); assert.equal(allocated.portfolio.allocatedBudgetMinor, 300); assert.equal(allocated.portfolio.allocatedCapacityMinutes, 10);
    const reserved = allocated.allocations.find(value => value.status === "RESERVED"), original = state;
    if (reserved.locationId !== state.scope.locationId) state = second;
    await openOperations("Portfolio"); await main.getByTestId("website-operations-portfolio").getByRole("button", { name: "Reservierung freigeben", exact: true }).click();
    await expect.poll(async () => (await opsRead()).allocations.find(value => value.id === reserved.id).status).toBe("RELEASED");
    state = original; await openOperations("Preise");
  });
  await step("a lost committed price response survives reload and blocks all workbench writes until exact reconciliation", async () => {
    const form = main.getByTestId("website-operations-quote-form"); await form.locator('[name="rule"]').selectOption(pricingRuleId);
    await main.evaluate(() => { const original = window.fetch.bind(window); let once = true; window.fetch = async (input, init) => {
      const request = new Request(input instanceof Request ? input.clone() : new URL(String(input), location.href), init);
      const lose = once && request.method === "POST" && new URL(request.url).pathname === "/api/crm/website-sales/autonomy" && (await request.clone().json()).operation === "propose_price";
      const response = await original(input, init); if (lose && response.ok) { once = false; await response.body?.cancel(); throw new TypeError("SYNTHETIC post-commit price response loss"); } return response;
    }; });
    await form.getByRole("button", { name: "Preisvorschlag erstellen", exact: true }).click();
    await expect(main.getByTestId("website-sales-operations").getByText(/Ergebnis unbestätigt/).first()).toBeVisible();
    await expect.poll(async () => (await admin.query("select count(*)::int n from crm_website_sales_ops_quotes where workflow_id=$1", [state.workflow.id])).rows[0].n).toBe(1);
    await expect(main.getByTestId("website-sales-operations").getByText("Die Änderung wurde nicht gespeichert. Prüfen Sie die Angaben und laden Sie den aktuellen Stand.", { exact: true })).toHaveCount(0);
    await main.reload({ waitUntil: "domcontentloaded" }); const panel = main.getByTestId("website-sales-operations"); await expect(panel).toBeVisible();
    await expect(main.locator("[data-website-sales-workbench]").getByLabel("Unternehmen", { exact: true })).toBeDisabled();
    await expect(panel.locator('form button[type="submit"]:enabled')).toHaveCount(0);
    await panel.getByRole("button", { name: "Gespeichertes Ergebnis prüfen", exact: true }).click();
    await expect.poll(async () => (await opsRead()).quotes.length).toBe(1); await expect(main.locator("[data-website-sales-workbench]").getByLabel("Unternehmen", { exact: true })).toBeEnabled();
    assert.equal((await admin.query("select count(*)::int n from crm_website_sales_ops_quotes where workflow_id=$1", [state.workflow.id])).rows[0].n, 1);
  });
  await step("reviewed quote application creates an exact canonical draft revision without offer approval or delivery", async () => {
    await main.getByTestId("website-sales-operations").getByRole("tab", { name: "Preise", exact: true }).click();
    const quote = (await opsRead()).quotes[0], form = main.getByTestId("website-operations-apply-form");
    await form.locator('[name="quote"]').selectOption(quote.id); await form.getByRole("checkbox").check();
    await form.getByRole("button", { name: "In Angebotsentwurf übernehmen", exact: true }).click();
    await expect.poll(async () => (await opsRead()).quotes.find(value => value.id === quote.id).status).toBe("APPLIED");
    state.workflow = (await opsRead()).workflow; const offer = (await admin.query("select status,revision,approval_id from crm_offers where id=$1", [state.workflow.offerDraftId])).rows[0];
    assert.equal(offer.status, "DRAFT"); assert.equal(offer.revision, 2); assert.equal(offer.approval_id, null);
  });
  await step("approved facts and a separately permitted canonical question create a private-body-free current dialog", async () => {
    await main.getByTestId("website-sales-operations").getByRole("tab", { name: "Gespräche", exact: true }).click();
    const form = main.getByTestId("website-conversation-fact"), fact = "Das freigegebene Konzept umfasst drei responsive Informationsseiten.";
    await form.locator('[name="topic"]').selectOption("SCOPE"); await form.locator('[name="text"]').fill(fact); await form.locator('[name="reference"]').fill("https://example.invalid/approved-scope");
    await form.getByRole("checkbox").check(); await form.getByRole("button", { name: "Information freigeben", exact: true }).click();
    await expect.poll(async () => (await dialogRead()).facts.filter(value => value.current && value.fact.topicCode === "SCOPE").length).toBe(1);
    const privateMarker = "SYNTHETIC_PRIVATE_BODY_" + randomUUID(), messageId = await incoming(state, "What is included in the scope? " + privateMarker);
    await refreshOperations(); const panel = main.getByTestId("website-operations-conversation"); await panel.getByLabel("Verknüpfte CRM-Nachricht", { exact: true }).selectOption(messageId);
    const permission = main.getByTestId("website-conversation-permission"); await permission.getByRole("checkbox").check(); await permission.getByRole("button", { name: "Themeneinordnung erlauben", exact: true }).click();
    await expect.poll(async () => (await dialogRead()).sources.find(value => value.messageId === messageId)?.authorized).toBe(true);
    await panel.getByRole("button", { name: "Kundenfrage bearbeiten", exact: true }).click();
    await expect(main.getByTestId("website-conversation-draft")).toContainText(fact); const current = await dialogRead(); assert.equal(current.workflow.stopReason, "REPLY_RECEIVED");
    assert(!JSON.stringify(current).includes(privateMarker)); assert(!(await panel.innerText()).includes(privateMarker));
  });
  await step("changed approved facts regenerate a new stored answer for the same question", async () => {
    const form = main.getByTestId("website-conversation-fact"), revised = "Das überarbeitete Konzept umfasst vier responsive Informationsseiten.";
    await form.locator('[name="topic"]').selectOption("SCOPE"); await form.locator('[name="text"]').fill(revised); await form.locator('[name="reference"]').fill("https://example.invalid/revised-scope");
    let release, held;
    const released = new Promise(resolve => { release = resolve; }), received = new Promise(resolve => { held = resolve; });
    const pattern = "**/api/crm/website-sales/conversation?*", handler = async route => {
      const request = route.request();
      if (request.method() === "GET" && !request.headers().accept?.includes("application/json")) { held(); await released; }
      await route.continue();
    };
    await main.route(pattern, handler);
    try {
      const parentFresh = main.waitForResponse(response => new URL(response.url()).pathname === "/api/crm/website-sales/workbench" && new URL(response.url()).searchParams.get("view") === "detail" && response.request().method() === "GET" && response.status() === 200);
      await form.getByRole("checkbox").check(); await form.getByRole("button", { name: "Information freigeben", exact: true }).click();
      await expect.poll(async () => (await dialogRead()).facts.some(value => value.current && value.fact.version === 2)).toBe(true);
      await received; await parentFresh;
      await expect(main.locator("[data-website-sales-workbench]").getByText("Aktuelle CRM-Daten werden geladen…", { exact: true })).toHaveCount(0);
      await expect(main.getByTestId("website-operations-conversation").getByRole("button", { name: "Kundenfrage bearbeiten", exact: true })).toBeDisabled();
      await expect(main.getByTestId("website-sales-operations").locator('form button[type="submit"]:enabled')).toHaveCount(0);
      await expect(form.locator('[name="text"]')).toHaveValue(revised);
    } finally { release(); await main.unroute(pattern, handler); }
    await main.getByTestId("website-operations-conversation").getByRole("button", { name: "Kundenfrage bearbeiten", exact: true }).click();
    await expect(main.getByTestId("website-conversation-draft")).toContainText(revised);
  });
  await step("a canonical price objection prepares an automatic counteroffer using the approved step without caller discount input", async () => {
    const messageId = await incoming(state, "This price is too expensive."), panel = main.getByTestId("website-operations-conversation");
    await refreshOperations(); await panel.getByLabel("Verknüpfte CRM-Nachricht", { exact: true }).selectOption(messageId);
    const permission = main.getByTestId("website-conversation-permission"); await permission.getByRole("checkbox").check(); await permission.getByRole("button", { name: "Themeneinordnung erlauben", exact: true }).click();
    await expect.poll(async () => (await dialogRead()).sources.find(value => value.messageId === messageId)?.topicCode).toBe("OBJECTION_PRICE");
    await main.getByTestId("website-sales-operations").getByRole("tab", { name: "Preise", exact: true }).click();
    const form = main.getByTestId("website-operations-quote-form"); await form.locator('[name="rule"]').selectOption(pricingRuleId); await form.locator('[name="mode"]').selectOption("AUTO_COUNTEROFFER");
    await expect(form.locator('[name="discount"]')).toHaveCount(0); await form.locator('[name="dialog"]').selectOption(messageId);
    await form.getByRole("button", { name: "Preisvorschlag erstellen", exact: true }).click();
    await expect.poll(async () => (await opsRead()).quotes.length).toBe(2); const quote = (await opsRead()).quotes[0]; assert.equal(quote.quote.requestedDiscountBps, 500); assert.equal(quote.quote.netMinor, 95000);
    const apply = main.getByTestId("website-operations-apply-form"); await apply.locator('[name="quote"]').selectOption(quote.id); await apply.getByRole("checkbox").check();
    await apply.getByRole("button", { name: "In Angebotsentwurf übernehmen", exact: true }).click(); await expect.poll(async () => (await opsRead()).quotes[0].status).toBe("APPLIED");
    state.workflow = (await opsRead()).workflow; await main.getByTestId("website-sales-operations").getByRole("tab", { name: "Gespräche", exact: true }).click();
  });
  await step("canonical opt-out stops contact while financial documents remain recordable", async () => {
    const messageId = await incoming(state, "Please unsubscribe me."), panel = main.getByTestId("website-operations-conversation");
    await refreshOperations(); await panel.getByLabel("Verknüpfte CRM-Nachricht", { exact: true }).selectOption(messageId);
    const permission = main.getByTestId("website-conversation-permission"); await permission.getByRole("checkbox").check(); await permission.getByRole("button", { name: "Themeneinordnung erlauben", exact: true }).click();
    await expect.poll(async () => (await dialogRead()).sources.find(value => value.messageId === messageId)?.authorized).toBe(true); await panel.getByRole("button", { name: "Kundenfrage bearbeiten", exact: true }).click();
    await expect.poll(async () => (await dialogRead()).conversation?.stopReason).toBe("OPT_OUT");
    assert.equal((await dialogRead()).workflow.blockedReason, "OPT_OUT");
    const consent = (await admin.query("select consent_label from contacts where id=$1", [state.project.contactId])).rows[0]; assert.equal(consent.consent_label, "Abgemeldet");
    await main.getByTestId("website-sales-operations").getByRole("tab", { name: "Ergebnisse", exact: true }).click();
    const financial = main.getByTestId("website-operations-financial-form"); await financial.locator('[name="reference"]').fill("SYNTHETIC real-form-cost-document");
    await financial.locator('[name="kind"]').selectOption("COST"); await financial.locator('[name="amount"]').fill("1200"); await financial.getByRole("checkbox").check();
    await financial.getByRole("button", { name: "Beleg dokumentieren", exact: true }).click();
    await expect.poll(async () => (await opsRead()).financialEvidence.some(value => value.source.recordId === "SYNTHETIC real-form-cost-document")).toBe(true);
    const document = (await opsRead()).financialEvidence.find(value => value.source.recordId === "SYNTHETIC real-form-cost-document");
    const include = main.getByTestId("website-operations-outcome-form"); await include.locator('[name="source"]').selectOption(document.id); await include.getByRole("button", { name: "In Ergebnisse übernehmen", exact: true }).click();
    await expect.poll(async () => (await opsRead()).outcomes.length).toBe(1);
    await includeDocument("PAYMENT", 95000); await includeDocument("FULFILLED"); await includeDocument("PAYMENTS_COMPLETE"); await includeDocument("COSTS_COMPLETE");
    await refreshOperations(); const report = (await opsRead()).cohort; assert.equal(report.denominator, 2); assert.equal(report.completedProfitSamples, 1);
    assert.equal(report.results.find(value => value.realizedProfitMinor !== null).realizedProfitMinor, -25000); assert.equal(report.conversion.closedWonCount, 0);
  });
  await step("actual results produce a review-only improvement and only the reviewed proposal can be promoted", async () => {
    const view = await opsRead(), rule = view.policies.find(value => value.kind === "IMPROVEMENT" && value.active), form = main.getByTestId("website-operations-improvement-form");
    await form.locator('[name="rule"]').selectOption(rule.id); await form.getByRole("button", { name: "Aus Ergebnissen Vorschlag erstellen", exact: true }).click();
    await expect.poll(async () => (await opsRead()).improvements.length).toBe(1); lossCandidate = (await opsRead()).improvements[0]; assert.equal(lossCandidate.candidate.proposal.proposedValue, 3500);
    const review = main.getByTestId("website-operations-review-form"); await review.locator('[name="improvement"]').selectOption(lossCandidate.id); await review.locator('[name="decision"]').selectOption("APPROVED");
    await review.getByRole("checkbox").check(); await review.getByRole("button", { name: "Prüfung speichern", exact: true }).click();
    await expect.poll(async () => (await opsRead()).improvements[0].status).toBe("APPROVED");
    const promote = main.getByTestId("website-operations-promote-form"); await promote.locator('[name="improvement"]').selectOption(lossCandidate.id); await promote.getByRole("checkbox").check();
    await promote.getByRole("button", { name: "Freigegebene Änderung übernehmen", exact: true }).click();
    await expect.poll(async () => (await opsRead()).improvements[0].status).toBe("PROMOTED");
  });
  await step("all four tabs remain keyboard accessible and fit desktop tablet and phone with no automatic accessibility violations", async () => {
    const names = ["Portfolio", "Preise", "Gespräche", "Ergebnisse"], panels = ["portfolio", "pricing", "conversation", "outcomes"];
    for (const [viewportName, viewport] of Object.entries({ desktop: { width: 1440, height: 1000 }, tablet: { width: 834, height: 1112 }, phone: { width: 390, height: 844 } })) {
      for (let index = 0; index < names.length; index++) { await main.getByTestId("website-sales-operations").getByRole("tab", { name: names[index], exact: true }).click(); await scanUi(main, `${viewportName}-${panels[index]}`, viewport, `website-operations-${panels[index]}`); }
    }
    const tabs = main.getByTestId("website-sales-operations").getByRole("tab"); await tabs.nth(0).focus(); await main.keyboard.press("ArrowRight"); await expect(tabs.nth(1)).toBeFocused();
    await expect(main.getByTestId("website-sales-operations").getByRole("button", { name: /^(Senden|Send)$/ })).toHaveCount(0);
  });
  await step("no outbound delivery provider request or browser exception occurred", async () => {
    const counts = (await admin.query("select (select count(*) from crm_offer_deliveries)::int offers,(select count(*) from crm_outreach_deliveries)::int outreach")).rows[0];
    assert.deepEqual(counts, { offers: 0, outreach: 0 }); assert.deepEqual(errors, []); assert.deepEqual(unexpectedNetwork, []);
  });
} catch (error) {
  console.error("OPERATIONS_BROWSER_FAILURE: " + scrub(error.message)); if (main) await main.screenshot({ path: path.join(output, "failure.png"), fullPage: true }).catch(() => undefined); throw new Error(scrub(error.message));
} finally {
  await writeFile(path.join(output, "result.json"), JSON.stringify({ syntheticOnly: true, sourceRevision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    productionAccess: 0, providerCalls: 0, server: "optimized-next-build", authentication: "ordinary-password-plus-MFA", automaticAccessibilityOnly: true, results, accessibility, errors, unexpectedNetwork, completed: results.length }, null, 2));
  for (const value of contexts) await value.close(); await browser.close(); await admin.end();
}
