import pg from "pg";
import { seedSalesBrowser } from "./lib/sales-browser-fixture.mjs";
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { chromium, expect } from "@playwright/test";
import { spawn } from 'node:child_process';
let fixture=JSON.parse(await readFile('.npm-cache/qa/sales-browser-context.json','utf8'));
if(!fixture.syntheticOnly||new URL(fixture.baseUrl).hostname!=='127.0.0.1')throw Error('Browser QA requires the isolated loopback fixture');
if(fixture.database?.host!=='127.0.0.1')throw Error('Invalid local database fixture');
const admin=new pg.Pool({...fixture.database,user:'qa_admin'});
try {
 const fresh = await seedSalesBrowser({admin,role:fixture.database.user});
 // Discard a legacy manually seeded cookie from older ignored QA contexts.
 fixture = {...fixture,...fresh};
 delete fixture.cookie;
 const sessions = await admin.query("select count(*)::int as count from auth_sessions where auth_identity_id=$1", [fixture.authIdentityId]);
 assert.equal(sessions.rows[0].count, 0, "The login fixture must start without a session");
 await writeFile('.npm-cache/qa/sales-browser-context.json',JSON.stringify(fixture,null,2));
} finally { await admin.end(); }
const browser=await chromium.launch({channel:process.env.CRM_QA_BROWSER_CHANNEL||'chrome',headless:true});
const context=await browser.newContext({viewport:{width:1440,height:1000},locale:'de-AT',timezoneId:'Europe/Vienna'});
await context.route('**/*',route=>{const u=new URL(route.request().url());return ['127.0.0.1','localhost'].includes(u.hostname)||['data:','blob:'].includes(u.protocol)?route.continue():route.abort()});
await context.addInitScript(()=>localStorage.setItem('novalure-crm-navigation-preset-v1','realEstateBroker'));
const page=await context.newPage(),results=[],errors=[];
// Persist only allowlisted diagnostic metadata, never auth headers or request bodies.
const requestTrace=[], requestStarted=new WeakMap(), traceTasks=[];
page.on('request',request=>{
 const url=new URL(request.url());
 if(url.origin!==fixture.baseUrl||!['/api/crm/offers','/api/crm/financial-snapshots'].includes(url.pathname))return;
 let operation;
 try{operation=request.postDataJSON()?.operation}catch{/* GET has no body. */}
 const entry={path:url.pathname,method:request.method(),operation,startedAt:new Date().toISOString(),startedMs:Date.now()};
 requestStarted.set(request,entry);requestTrace.push(entry);
});
page.on('response',response=>{
 const entry=requestStarted.get(response.request());if(!entry)return;
 traceTasks.push((async()=>{entry.status=response.status();entry.durationMs=Date.now()-entry.startedMs;try{const data=await response.json();entry.code=data.code;entry.persisted=data.persisted;entry.offerStatus=(data.data??data).offer?.status;entry.snapshotReviewState=data.snapshot?.reviewState;}catch{/* No response body available. */}})());
});
page.on('pageerror',error=>errors.push(error.message));
page.on('response',response=>{const url=new URL(response.url());if(url.origin===fixture.baseUrl&&response.status()>=500)errors.push('HTTP '+response.status()+' '+url.pathname);});
async function step(name,fn){try{await fn();results.push({name,status:'PASS'});console.log('PASS '+name)}catch(error){results.push({name,status:'FAIL',error:error.message});await page.screenshot({path:'.npm-cache/qa/sales-browser-failure.png',fullPage:true});throw error}}
async function requestApi(path,body,method='POST'){
 const response=await page.evaluate(async({path,body,method,key,correlationId})=>{const csrf=await fetch('/api/auth/csrf?'+new URLSearchParams({method,path:new URL(path,location.origin).pathname}));if(!csrf.ok)throw Error('CSRF issuance failed: '+csrf.status);const token=await csrf.json();const r=await fetch(path,{method,headers:{'content-type':'application/json','x-novalure-csrf-token':token.csrfToken,'Idempotency-Key':key,'X-Correlation-Id':correlationId},body:JSON.stringify(body)});return {status:r.status,body:await r.json()};},{path,body,method,key:randomUUID(),correlationId:randomUUID()});
 return response;
}
async function api(path,body,method='POST'){const response=await requestApi(path,body,method);assert.ok(response.status>=200&&response.status<300,JSON.stringify(response));return response.body;}
async function financialFixture(mode,offerId){
 const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>/^(path|systemroot|windir|temp|tmp|userprofile|localappdata|appdata|comspec|pathext)$/i.test(key)));env.NODE_ENV='test';
 await new Promise((resolve,reject)=>{const child=spawn(process.execPath,['--conditions=react-server','--import','tsx','scripts/qa-g27-browser-financial-fixture.ts',mode,offerId],{env,windowsHide:true,stdio:['ignore','pipe','pipe']});let output='';child.stdout.on('data',x=>output+=x);child.stderr.on('data',x=>output+=x);child.once('error',reject);child.once('close',code=>code===0?resolve():reject(new Error('Financial fixture failed: '+output)));});
 return JSON.parse(await readFile('.npm-cache/qa/g27-browser-financial.json','utf8'));
}

// Independent RFC 6238 authenticator: the key comes solely from the rendered enrollment UI.
function authenticatorCode(secret, atMillis=Date.now()) {
 const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
 let accumulator=0,bits=0;
 const bytes=[];
 for(const character of secret){
  const value=alphabet.indexOf(character);
  if(value<0)throw Error('Invalid synthetic enrollment key');
  accumulator=(accumulator<<5)|value;bits+=5;
  if(bits>=8){bits-=8;bytes.push((accumulator>>>bits)&255);accumulator&=(1<<bits)-1;}
 }
 const counter=Buffer.alloc(8);counter.writeBigUInt64BE(BigInt(Math.floor(atMillis/30000)));
 const digest=createHmac('sha1',Buffer.from(bytes)).update(counter).digest();
 const offset=digest[digest.length-1]&15;
 return String((digest.readUInt32BE(offset)&0x7fffffff)%1000000).padStart(6,'0');
}
function incorrectAuthenticatorCode(secret) {
 const now=Date.now();
 const acceptedWindow = new Set([-1,0,1].map(offset=>authenticatorCode(secret,now+offset*30000)));
 for(let candidate=0;candidate<1000000;candidate++){
  const code=String(candidate).padStart(6,'0');
  if(!acceptedWindow.has(code))return code;
 }
 throw Error('Cannot construct a negative authenticator code');
}
async function submitLoginForm(button) {
 await Promise.all([page.waitForNavigation({waitUntil:'domcontentloaded'}),button.click()]);
}
async function passwordLogin(password) {
 await page.locator('#login-email').fill(fixture.email);
 await page.locator('#login-password').fill(password);
 await submitLoginForm(page.locator('form:has(#login-password) button[type=submit]'));
}
async function submitMfa(code) {
 await page.locator('#login-mfa-code').fill(code);
 await submitLoginForm(page.getByRole('button',{name:'Sicher bestätigen',exact:true}));
}
async function assertProtectedDenied() {
 const response=await page.request.get(fixture.baseUrl+'/api/crm/core');
 assert.ok([401,403].includes(response.status()), 'Incomplete authentication must not access CRM');
 assert.ok(!(await context.cookies()).some(cookie=>cookie.name==='novalure_session'),'Incomplete authentication must not issue a session');
}
let totpSecret,firstSession;
let enrollmentVerified=false,loginCredentialExchangeVerified=false;

let contact,lead,deal,buyer,buyerLead,unit;
try{
 await step('anonymous login renders and protected CRM denies anonymous access',async()=>{await page.goto(fixture.baseUrl+'/login?lang=de');await expect(page.locator('body')).toContainText(/anmelden|login/i);const r=await page.request.get(fixture.baseUrl+'/api/crm/core');assert.ok([401,403].includes(r.status()));});
 await step('actual login rejects an incorrect password without granting a session',async()=>{
  await passwordLogin(fixture.password+'-incorrect');
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.locator('#login-password')).toBeVisible();
  await assertProtectedDenied();
 });
 await step('correct password requires real TOTP enrollment before CRM access',async()=>{
  await passwordLogin(fixture.password);
  await expect(page.locator('#login-mfa-code')).toBeVisible();
  const key = page.locator('p').filter({has:page.locator('strong', {hasText:'TOTP-Schlüssel:'})}).locator('code');
  await expect(key).toBeVisible();
  totpSecret = (await key.innerText()).trim();
  assert.ok(/^[A-Z2-7]{16,}$/.test(totpSecret), 'Login UI must provide a valid enrollment key');
  const recoveryCodes = await page.locator('form:has(#login-mfa-code) li code').allTextContents();
  assert.ok(recoveryCodes.length > 0, 'Enrollment UI must provide recovery codes');
  // Synthetic codes are saved only in the ignored fixture before the UI acknowledgment.
  await writeFile('.npm-cache/qa/sales-browser-context.json',JSON.stringify({...fixture,totpSecret,recoveryCodes},null,2));
  await assertProtectedDenied();
 });
 await step('MFA enrollment rejects an invalid code without creating a session',async()=>{
  await page.locator('input[name=recoveryCodesSaved]').check();
  await submitMfa(incorrectAuthenticatorCode(totpSecret));
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.locator('#login-mfa-code')).toBeVisible();
  await assertProtectedDenied();
 });
 await step('real UI TOTP enrollment creates a server-issued authenticated MFA session',async()=>{
  await page.locator('input[name=recoveryCodesSaved]').check();
  await submitMfa(authenticatorCode(totpSecret));
  await expect(page).not.toHaveURL(/\/login/);
  const session = (await context.cookies()).find(cookie=>cookie.name==='novalure_session');
  assert.ok(session?.httpOnly && session.value.startsWith('v2.'), 'Server must issue an opaque HttpOnly session');
  firstSession = session.value;
  assert.equal((await page.request.get(fixture.baseUrl+'/api/crm/core')).status(),200);
  enrollmentVerified = true;
 });
 await step('persisted real password and MFA session loads CRM after reload without framework errors',async()=>{
  await page.goto(fixture.baseUrl+'/?lang=de&workspaceId='+fixture.workspaceId+'&projectId=all');
  await expect(page.locator('body')).toContainText('SYNTHETIC');
  await page.reload();
  assert.equal((await page.request.get(fixture.baseUrl+'/api/crm/core')).status(),200);
 });
 await step('actual logout revokes the session and rejects replay of its previous cookie',async()=>{
  // Native logout performs a fetch redirect followed by router.replace/refresh.
  // Observe its actual server response before waiting for the resulting login UI.
  const [logout] = await Promise.all([
   page.waitForResponse(response=>new URL(response.url()).pathname==='/api/auth/logout'&&response.request().method()==='POST'),
   page.getByRole('button',{name:'Abmelden',exact:true}).click(),
  ]);
  assert.equal(logout.status(),303,'Logout must revoke the session and redirect');
  await expect(page).toHaveURL(url=>url.pathname==='/login',{timeout:30000});
  await expect(page.locator('#login-password')).toBeVisible();
  await assertProtectedDenied();
  const replay = await page.request.get(fixture.baseUrl+'/api/crm/core',{headers:{Cookie:'novalure_session='+firstSession}});
  assert.ok([401,403].includes(replay.status()), 'A revoked cookie must remain unauthorized');
 });
 await step('mobile login requires existing MFA and rejects an invalid TOTP',async()=>{
  await page.setViewportSize({width:390,height:844});
  await passwordLogin(fixture.password);
  await expect(page.locator('#login-mfa-code')).toBeVisible();
  assert.equal(await page.locator('input[name=recoveryCodesSaved]').count(),0, 'Enrolled account must verify, not enroll again');
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+2), 'Mobile login overflows horizontally');
  await submitMfa(incorrectAuthenticatorCode(totpSecret));
  await expect(page.getByRole('alert')).toBeVisible();
  await assertProtectedDenied();
 });
 await step('mobile password and TOTP login creates a fresh session through the actual UI',async()=>{
  await submitMfa(authenticatorCode(totpSecret));
  await expect(page).not.toHaveURL(/\/login/);
  const session = (await context.cookies()).find(cookie=>cookie.name==='novalure_session');
  assert.ok(session?.httpOnly && session.value!==firstSession, 'Reauthentication must create a fresh session');
  assert.equal((await page.request.get(fixture.baseUrl+'/api/crm/core')).status(),200);
  loginCredentialExchangeVerified = true;
  await page.setViewportSize({width:1440,height:1000});
 });
 await step('Flow A creates canonical contact, lead and linked deal through authenticated CSRF APIs',async()=>{
  contact=(await api('/api/crm/contacts',{contact:{name:'SYNTHETIC Offer Customer',email:'offer-browser-'+randomUUID().replaceAll('-','')+'@example.invalid',role:'Bauträger',source:'Manual',consent:'Opt-in',projectId:fixture.projectId}})).contact;
  lead=(await api('/api/crm/leads',{lead:{contactId:contact.id,projectId:fixture.projectId,type:'Bauträger',source:'Manual',intent:'SYNTHETIC service inquiry'}})).lead;
  deal=(await api('/api/crm/deals',{deal:{contactId:contact.id,leadId:lead.id,projectId:fixture.projectId,name:'SYNTHETIC Browser Offer',stage:'Neu',value:'9900',expectedCloseDate:'2030-12-31'}})).deal;
  assert.equal(deal.leadId,lead.id);
 });
 await step('Flow A offer draft is operable from the actual deal UI',async()=>{
  await page.goto(fixture.baseUrl+'/?lang=de&workspaceId='+fixture.workspaceId+'&projectId=all');await page.getByRole('button',{name:'Pipeline',exact:true}).first().click();
  const section=page.getByRole('region',{name:'Angebotsablauf',exact:true});
  await expect(page.getByText('Angebot und Kundenabschluss',{exact:true})).toBeVisible({timeout:30000});

  await section.getByLabel('Zugehöriger Lead').selectOption(lead.id);
  if(await section.getByLabel('Unternehmen des Kunden').count())await section.getByLabel('Unternehmen des Kunden').fill('SYNTHETIC Customer Company');
  await section.getByLabel('Empfängername',{exact:true}).fill('SYNTHETIC Offer Customer');
  await section.getByLabel('Empfänger-E-Mail',{exact:true}).fill(contact.email);
  await section.getByLabel('Betreff',{exact:true}).fill('SYNTHETIC browser offer');
  await section.getByLabel('Leistung',{exact:true}).fill('Synthetic project setup');
  await section.getByLabel('Einzelpreis (€)',{exact:true}).fill('9900');
  await section.getByLabel('Leistungsumfang und Konditionen').fill('SYNTHETIC approved scope for local browser QA. No contract or real delivery.');
  await section.getByRole('button',{name:'Angebotsentwurf anlegen',exact:true}).click();await expect(section.getByText('Entwurf',{exact:true})).toBeVisible();
 });
 await step('Flow A approval, manual delivery evidence, follow-up and customer acceptance through UI',async()=>{
  const section=page.getByRole('region',{name:'Angebotsablauf',exact:true});
  const approvalResponse=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/crm/offers'&&response.request().method()==='POST'&&response.request().postDataJSON()?.operation==='approve');
  await section.getByRole('button',{name:'Diese Revision freigeben',exact:true}).click();
  const approved=await approvalResponse;assert.equal(approved.status(),200);assert.equal((await approved.json()).persisted,true);
  await expect(section.getByText('Freigegeben',{exact:true})).toBeVisible();
  const persisted=await page.request.get(fixture.baseUrl+'/api/crm/offers?workspaceId='+fixture.workspaceId+'&dealId='+deal.id);assert.equal(persisted.status(),200);assert.equal((await persisted.json()).offer.status,'APPROVED');
  await section.getByRole('button',{name:'Manuellen Versand vorbereiten',exact:true}).click();
  await section.getByLabel('Manueller Versandbeleg',{exact:false}).fill('SYNTHETIC MANUAL LOCAL RECEIPT');await section.getByRole('button',{name:'Manuellen Versand bestätigen',exact:true}).click();
  await expect(section.getByText('Versand manuell belegt',{exact:true})).toBeVisible();
  await section.getByRole('button',{name:'Nachfassaufgabe planen',exact:true}).click();await expect(section).toContainText('SCHEDULED');
  await section.getByLabel('Kundenantwort / Annahme- oder Ablehnungsbeleg').fill('SYNTHETIC CUSTOMER ACCEPTANCE');
  await section.getByRole('button',{name:'Kundenannahme belegen',exact:true}).click();await expect(section.getByText('Angenommen · Deal gewonnen · Kunde',{exact:true})).toBeVisible();await expect(section).toContainText('STOPPED');
 });
 let financialState,financialOffer;
 const reloadFinancialOffer=async()=>{await page.reload();await page.getByRole('button',{name:'Pipeline',exact:true}).first().click();return page.getByRole('region',{name:'Angebotsablauf',exact:true});};
 await step('G27 browser B: explicit NEEDS_REVIEW evidence keeps authoritative printing blocked',async()=>{
  const view=await (await page.request.get(fixture.baseUrl+'/api/crm/offers?workspaceId='+fixture.workspaceId+'&dealId='+deal.id)).json();financialOffer=view.offer;
  financialState=await financialFixture('prepare',financialOffer.id);
  const section=await reloadFinancialOffer();await expect(section.getByRole('alert')).toContainText('Finanzprüfung offen',{timeout:30000});await expect(section.getByRole('button',{name:'Druck gesperrt – Finanzprüfung offen',exact:true})).toBeDisabled();
  const snapshot=await (await page.request.get(fixture.baseUrl+'/api/crm/financial-snapshots?workspaceId='+fixture.workspaceId+'&offerId='+financialOffer.id)).json();assert.equal(snapshot.snapshot.reviewState,'NEEDS_REVIEW');assert.equal(snapshot.snapshot.snapshotHash,financialState.pendingHash);
 });
 await step('G27 browser D: mismatching expected snapshot hash is rejected by the real HTTP boundary',async()=>{
  const response=await requestApi('/api/crm/financial-snapshots?workspaceId='+fixture.workspaceId,{projectId:fixture.projectId,priorSnapshotId:financialState.pendingId,expectedPriorSnapshotHash:'0'.repeat(64),policySelection:financialState.selection,reviewDecision:'VERIFY_EVIDENCED_NET'});assert.equal(response.status,409);assert.equal(response.body.code,'FINANCIAL_SNAPSHOT_HASH_MISMATCH');
 });
 await step('G27 browser F: another existing tenant cannot read the snapshot through the authenticated HTTP boundary',async()=>{
  const response=await page.request.get(fixture.baseUrl+'/api/crm/financial-snapshots?workspaceId='+financialState.foreignWorkspaceId+'&snapshotId='+financialState.pendingId);assert.ok([403,404].includes(response.status()));
 });
 await step('G27 browser C/E: missing tax policy and stale offer version fail during real V2 preparation',async()=>{
  // Never spoof the Preview-only HTTP gate locally: use the repository's guarded loopback test interface.
  financialState=await financialFixture('verify',financialOffer.id);assert.equal(financialState.missingTaxDenied,true);assert.equal(financialState.staleVersionDenied,true);
 });
 await step('G27 browser A: complete policy-backed V2 snapshot reloads from persistence and enables the approved document',async()=>{
  const section=await reloadFinancialOffer();await expect(section).toContainText('Verifizierter unveränderlicher Finanzsnapshot',{timeout:30000});await expect(section).toContainText(financialState.verifiedHash);await expect(section).toContainText('EUR 11\u00a0880,00');await expect(section.getByRole('button',{name:'Fassung drucken',exact:true})).toBeEnabled();
  const result=await (await page.request.get(fixture.baseUrl+'/api/crm/financial-snapshots?workspaceId='+fixture.workspaceId+'&offerId='+financialOffer.id)).json();assert.equal(result.snapshot.reviewState,'VERIFIED');assert.equal(result.snapshot.snapshot.reviewState,'COMPLETE');assert.equal(result.snapshot.snapshotHash,financialState.verifiedHash);
 });
 await step('G27 browser G: later current-value and tax-policy changes preserve historical evidence',async()=>{
  financialState=await financialFixture('change-current-values',financialOffer.id);assert.equal(financialState.historicalUnchanged,true);
  const section=await reloadFinancialOffer();await expect(section).toContainText(financialState.verifiedHash,{timeout:30000});await expect(section).toContainText('EUR 11\u00a0880,00');
 });
 await step('Flow B creates canonical buyer inquiry and available inventory via APIs',async()=>{
  buyer=(await api('/api/crm/contacts',{contact:{name:'SYNTHETIC Buyer',email:'buyer-browser-'+randomUUID().replaceAll('-','')+'@example.invalid',role:'Käufer',source:'Manual',consent:'Opt-in',projectId:fixture.projectId}})).contact;
  buyerLead=(await api('/api/crm/leads',{lead:{contactId:buyer.id,projectId:fixture.projectId,type:'Käufer',source:'Manual',intent:'SYNTHETIC apartment inquiry'}})).lead;
  unit=(await api('/api/crm/units',{projectId:fixture.projectId,unitNumber:'SYN-BROWSER-'+randomUUID().slice(0,5),floor:1,rooms:3,areaSqm:80,status:'available',priceCents:0,idempotencyKey:randomUUID(),correlationId:randomUUID()})).data;
  assert.ok(unit?.id);
 });
 await page.goto(fixture.baseUrl+'/?lang=de&workspaceId='+fixture.workspaceId+'&projectId=all');await page.getByRole('button',{name:'Einheiten / Bestand',exact:true}).click();
 const sales=page.locator('#property-sales-workflow');
 await expect(sales).toBeVisible({timeout:30000});await sales.getByLabel('Projekt',{exact:true}).selectOption(fixture.projectId);await sales.getByRole('button',{name:'Prozess laden / aktualisieren'}).click();
 async function action(value){await sales.getByLabel('Nächster Schritt').selectOption(value)}
 async function save(label){await sales.getByRole('button',{name:label,exact:true}).click();await expect(sales.getByRole('status')).toContainText('Gespeichert.',{timeout:15000});}
 async function source(text='SYNTHETIC authorized evidence'){await sales.getByLabel(/Quellbeleg|Beleg der Projektbeauftragung/).fill(text)}
 await step('Flow B project-specific authority assignment through UI',async()=>{
  await action('authority.assign');await sales.getByLabel('Befugter Benutzer',{exact:true}).selectOption(fixture.userId);await sales.getByLabel('Bauträger',{exact:true}).selectOption(fixture.developerId);await sales.getByLabel('Autorisierter Ansprechpartner').selectOption(fixture.developerContactId);
  for(const label of ['Preise bestätigen','Reservierungen bestätigen','Verkäufe bestätigen'])await sales.getByLabel(label,{exact:true}).selectOption('yes');await source();await save('Bauträger und Projektbefugnisse verwalten');
 });
 await step('Flow B confirmed price, complete qualification and priority through UI',async()=>{
  await action('unit.price.confirm');await sales.getByLabel('Einheit',{exact:true}).selectOption(unit.id);await sales.getByLabel('Bestätigter Verkaufspreis EUR').fill('350000');await source();await save('Bestätigten Verkaufspreis übernehmen');
  await action('qualification.save');await sales.getByLabel('Käuferanfrage').selectOption(buyerLead.id);await sales.getByLabel('Einheit',{exact:true}).selectOption(unit.id);await sales.getByLabel('Budget ab EUR').fill('300000');await sales.getByLabel('Budget bis EUR').fill('400000');await sales.getByLabel('Finanzierungsstatus').selectOption('vorqualifiziert');await sales.getByLabel('Kaufzeitraum').fill('Within six months');await sales.getByLabel('Priorität').selectOption('high');await source();await save('Käufer qualifizieren');await expect(sales).toContainText('Qualifiziert: 1');
 });
 await step('Flow B handover and viewing lifecycle through UI',async()=>{
  await action('handover.create');await sales.getByLabel('Empfänger der Übergabe').selectOption(fixture.userId);await source();await save('Qualifizierten Käufer übergeben');
  await action('viewing.save');await sales.getByLabel('Verantwortlicher für Besichtigung').selectOption(fixture.userId);await sales.getByLabel('Beginn (lokale Browserzeit)').fill('2030-01-01T10:00');await sales.getByLabel('Ende (lokale Browserzeit)').fill('2030-01-01T11:00');await save('Besichtigung planen / dokumentieren');
  await sales.getByLabel('Vorhandene Besichtigung').selectOption({index:1});await sales.getByLabel('Besichtigungsstatus').selectOption('confirmed');await save('Besichtigung planen / dokumentieren');await sales.getByLabel('Besichtigungsstatus').selectOption('completed');await save('Besichtigung planen / dokumentieren');
 });
 await step('Flow B reservation request, binding confirmation and sale through UI',async()=>{
  await action('reservation.request');await sales.getByLabel('Gewünschte Reservierungsfrist').fill('2030-02-01T12:00');await save('Reservierung anfragen');await expect(sales).toContainText(unit.unitNumber+': verfügbar');
  await action('reservation.confirm');await sales.getByLabel('Reservierung',{exact:true}).selectOption({index:1});await source();await save('Reservierung verbindlich bestätigen');await expect(sales).toContainText(unit.unitNumber+': reserviert');
  await action('sale.confirm');await source();await save('Verkauf bestätigen');await expect(sales).toContainText(unit.unitNumber+': verkauft');await expect(sales).toContainText('Bestätigte Verkäufe: 1');
 });
 await step('mobile layout and workflow navigation remain operable',async()=>{
  await page.setViewportSize({width:390,height:844});await sales.scrollIntoViewIfNeeded();await expect(sales.getByLabel('Nächster Schritt')).toBeVisible();await action('qualification.save');await expect(sales.getByLabel('Budget bis EUR')).toBeVisible();assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+2),'Mobile page overflows horizontally');await page.screenshot({path:'.npm-cache/qa/sales-mobile.png',fullPage:true});
 });
 await step('authenticated API rejects forged cross-tenant project and missing CSRF',async()=>{
  const r=await page.request.get(fixture.baseUrl+'/api/crm/property-sales?projectId='+randomUUID());assert.ok([403,404].includes(r.status()));const w=await page.request.post(fixture.baseUrl+'/api/crm/offers',{data:{}});assert.equal(w.status(),403);
 });
 await step('no browser runtime exceptions during either workflow',async()=>assert.deepEqual(errors,[]));
}catch(error){console.error(error.message);await page.screenshot({path:'.npm-cache/qa/sales-browser-failure.png',fullPage:true});await writeFile('.npm-cache/qa/sales-browser-failure.txt',await page.locator('body').innerText());process.exitCode=1;}finally{await Promise.allSettled(traceTasks);await writeFile('.npm-cache/qa/sales-browser-results.json',JSON.stringify({syntheticOnly:true,providerDeliveryVerified:false,loginCredentialExchangeVerified,mfaEnrollmentVerified:enrollmentVerified,authenticationTransport:"actual-login-ui",results,errors,requestTrace},null,2));console.log(JSON.stringify({passed:results.filter(r=>r.status==='PASS').length,total:results.length}));await browser.close();}
