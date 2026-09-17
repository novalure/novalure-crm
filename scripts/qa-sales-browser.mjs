import pg from "pg";
import { seedSalesBrowser } from "./lib/sales-browser-fixture.mjs";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { chromium, expect } from "@playwright/test";
let fixture=JSON.parse(await readFile('.npm-cache/qa/sales-browser-context.json','utf8'));
if(!fixture.syntheticOnly||new URL(fixture.baseUrl).hostname!=='127.0.0.1')throw Error('Browser QA requires the isolated loopback fixture');
if(fixture.database?.host!=='127.0.0.1')throw Error('Invalid local database fixture');
const admin=new pg.Pool({...fixture.database,user:'qa_admin'});
try{const fresh=await seedSalesBrowser({admin,role:fixture.database.user});fixture={...fixture,...fresh};await writeFile('.npm-cache/qa/sales-browser-context.json',JSON.stringify(fixture,null,2));}finally{await admin.end()}
const browser=await chromium.launch({channel:process.env.CRM_QA_BROWSER_CHANNEL||'chrome',headless:true});
const context=await browser.newContext({viewport:{width:1440,height:1000},locale:'de-AT',timezoneId:'Europe/Vienna'});
await context.route('**/*',route=>{const u=new URL(route.request().url());return ['127.0.0.1','localhost'].includes(u.hostname)||['data:','blob:'].includes(u.protocol)?route.continue():route.abort()});
await context.addInitScript(()=>localStorage.setItem('novalure-crm-navigation-preset-v1','realEstateBroker'));
const page=await context.newPage(),results=[],errors=[];
page.on('pageerror',error=>errors.push(error.message));
async function step(name,fn){try{await fn();results.push({name,status:'PASS'});console.log('PASS '+name)}catch(error){results.push({name,status:'FAIL',error:error.message});await page.screenshot({path:'.npm-cache/qa/sales-browser-failure.png',fullPage:true});throw error}}
async function api(path,body,method='POST'){
 const response=await page.evaluate(async({path,body,method,key})=>{const csrf=await fetch('/api/auth/csrf?'+new URLSearchParams({method,path}));const token=await csrf.json();const r=await fetch(path,{method,headers:{'content-type':'application/json','x-novalure-csrf-token':token.csrfToken,'Idempotency-Key':key},body:JSON.stringify(body)});return {status:r.status,body:await r.json()};},{path,body,method,key:randomUUID()});
 assert.ok(response.status>=200&&response.status<300,JSON.stringify(response));return response.body;
}
let contact,lead,deal,buyer,buyerLead,unit;
try{
 await step('anonymous login renders and protected CRM denies anonymous access',async()=>{await page.goto(fixture.baseUrl+'/login?lang=de');await expect(page.locator('body')).toContainText(/anmelden|login/i);const r=await page.request.get(fixture.baseUrl+'/api/crm/core');assert.ok([401,403].includes(r.status()));});
 await context.addCookies([{name:'novalure_session',value:fixture.cookie,url:fixture.baseUrl,httpOnly:true,sameSite:'Lax'}]);
 await step('persisted synthetic MFA session loads CRM without framework errors',async()=>{await page.goto(fixture.baseUrl+'/?lang=de&workspaceId='+fixture.workspaceId+'&projectId=all');await expect(page.locator('body')).toContainText('SYNTHETIC');const r=await page.request.get(fixture.baseUrl+'/api/crm/core');assert.equal(r.status(),200);});
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
  await section.getByRole('button',{name:'Diese Revision freigeben',exact:true}).click();await expect(section.getByText('Freigegeben',{exact:true})).toBeVisible();
  await section.getByRole('button',{name:'Manuellen Versand vorbereiten',exact:true}).click();
  await section.getByLabel('Manueller Versandbeleg',{exact:false}).fill('SYNTHETIC MANUAL LOCAL RECEIPT');await section.getByRole('button',{name:'Manuellen Versand bestätigen',exact:true}).click();
  await expect(section.getByText('Versand manuell belegt',{exact:true})).toBeVisible();
  await section.getByRole('button',{name:'Nachfassaufgabe planen',exact:true}).click();await expect(section).toContainText('SCHEDULED');
  await section.getByLabel('Kundenantwort / Annahme- oder Ablehnungsbeleg').fill('SYNTHETIC CUSTOMER ACCEPTANCE');
  await section.getByRole('button',{name:'Kundenannahme belegen',exact:true}).click();await expect(section.getByText('Angenommen · Deal gewonnen · Kunde',{exact:true})).toBeVisible();await expect(section).toContainText('STOPPED');
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
}catch(error){console.error(error.message);await page.screenshot({path:'.npm-cache/qa/sales-browser-failure.png',fullPage:true});await writeFile('.npm-cache/qa/sales-browser-failure.txt',await page.locator('body').innerText());process.exitCode=1;}finally{await writeFile('.npm-cache/qa/sales-browser-results.json',JSON.stringify({syntheticOnly:true,providerDeliveryVerified:false,loginCredentialExchangeVerified:false,results,errors},null,2));console.log(JSON.stringify({passed:results.filter(r=>r.status==='PASS').length,total:results.length}));await browser.close();}