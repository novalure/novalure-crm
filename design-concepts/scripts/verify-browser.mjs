const { chromium } = await import(process.env.PLAYWRIGHT_MODULE_PATH || '@playwright/test');
import { writeFile, mkdir } from 'node:fs/promises';
const base=process.env.DESIGN_BASE_URL || 'http://127.0.0.1:4173';
await mkdir('/tmp/evelyn-design-shots',{recursive:true});
await mkdir('verification',{recursive:true});
const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
const page=await browser.newPage({viewport:{width:1440,height:1050},deviceScaleFactor:1});
const errors=[],requests=[],checks=[];
page.on('pageerror',e=>errors.push(e.message));
page.on('request',r=>{if(!r.url().startsWith(base)||r.method()!=='GET')requests.push({url:r.url(),method:r.method()});});
await page.goto(base+'/',{waitUntil:'networkidle'});
await page.screenshot({path:'/tmp/evelyn-design-shots/selection.png',fullPage:true});
for(const v of ['a','b','c']){
 await page.goto(`${base}/${v}/`,{waitUntil:'networkidle'});
 await page.screenshot({path:`/tmp/evelyn-design-shots/${v}-desktop.png`,fullPage:true});
 for(const [id,label] of [['dashboard','Übersicht'],['customers','Kunden'],['studio','Novalure Studio'],['assistants','KI-Assistenten'],['knowledge','Wissen']]){
  await page.locator('nav').getByRole('button',{name:new RegExp('^'+label)}).first().click();
  await page.waitForTimeout(70);
  checks.push({variant:v,view:id,width:1440,heading:await page.locator('main h1').innerText(),overflow:await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1)});
 }
 await page.setViewportSize({width:390,height:844});
 for(const id of ['dashboard','customers','studio','assistants','knowledge']){
  await page.goto(`${base}/${v}/?frame=1#${id}`,{waitUntil:'networkidle'});
  checks.push({variant:v,view:id,width:390,overflow:await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1)});
  if(id==='dashboard'||id==='knowledge')await page.screenshot({path:`/tmp/evelyn-design-shots/${v}-mobile-${id}.png`,fullPage:true});
 }
 await page.setViewportSize({width:768,height:1024});await page.goto(`${base}/${v}/?frame=1`,{waitUntil:'networkidle'});
 checks.push({variant:v,view:'dashboard',width:768,overflow:await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1)});
 await page.setViewportSize({width:1440,height:1050});
}
await page.goto(base+'/b/#assistants',{waitUntil:'networkidle'});
await page.getByRole('button',{name:'Assistent einrichten',exact:true}).click();
for(let i=0;i<5;i++)await page.getByRole('button',{name:'Weiter',exact:true}).click();
await page.getByRole('button',{name:'Demo abschließen',exact:true}).click();
checks.push({wizard:await page.getByRole('status').innerText()});
await page.locator('nav').getByRole('button',{name:'Wissen',exact:true}).click();
await page.getByRole('button',{name:'Entwurf freigeben',exact:true}).click();
checks.push({knowledgeApproval:await page.locator('.knowledge-notice strong').innerText()});
await page.getByRole('combobox',{name:'Demo-Mandant wechseln'}).selectOption('haven');
checks.push({tenantReset:await page.locator('.knowledge-notice strong').innerText(),wrongTenantContent:await page.locator('main').innerText().then(s=>s.includes('Atelier Nord'))});
await page.locator('.variant-switcher a').filter({hasText:'AI Command Center'}).click();
checks.push({variantPreserved:page.url().endsWith('#knowledge')});
await page.getByRole('button',{name:'Dark Mode umschalten'}).click();
checks.push({darkMode:await page.locator('.is-dark').count()===1});
await page.getByRole('button',{name:'Mobile-Vorschau'}).click();
checks.push({mobilePreview:await page.locator('iframe').count()===1});
await page.goto(base+'/compare/?view=knowledge&tenant=haven',{waitUntil:'networkidle'});
checks.push({compareFrames:await page.locator('iframe').count(),compareContext:await page.locator('iframe').first().getAttribute('src')});
for(const v of ['a','b','c']) { await page.goto(`${base}/${v}/?portal=1&frame=1`,{waitUntil:'networkidle'});checks.push({portal:v,navCount:await page.locator('nav button').count()}); }
await page.goto(base+'/b/#assistants',{waitUntil:'networkidle'});await page.getByRole('button',{name:'Assistent einrichten',exact:true}).click();checks.push({dialogName:await page.getByRole('dialog',{name:'Assistent einrichten',exact:true}).count()});await page.keyboard.press('Escape');checks.push({escapeClosesDialog:await page.getByRole('dialog').count()===0});
await page.goto(base+'/compare/',{waitUntil:'networkidle'});
await page.screenshot({path:'/tmp/evelyn-design-shots/compare.png',fullPage:true});
await writeFile('verification/browser-results.json',JSON.stringify({errors,nonStaticRequests:requests,checks},null,2));
console.log(JSON.stringify({errors,nonStaticRequests:requests,checks},null,2));
const failed=errors.length || requests.length || checks.some(c=>c.overflow||c.wrongTenantContent||c.variantPreserved===false||c.darkMode===false||c.mobilePreview===false);
if(failed)process.exitCode=1;
await browser.close();
