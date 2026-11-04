// LOCAL_UI_WITH_STUBBED_HTTP_NOT_AUTH_OR_PROVIDER_ACCEPTANCE.
// Actual React component + csrfFetch; all HTTP responses are synthetic and loopback-only.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {mkdir,writeFile,readFile,access} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {build} from 'esbuild';
import {chromium,expect} from '@playwright/test';
const root=resolve('.npm-cache/qa/personal-mail-ui');await mkdir(root,{recursive:true});
const entry=join(root,'entry.tsx'),bundle=join(root,'client.js');
await writeFile(entry,`import React from 'react';import {createRoot} from 'react-dom/client';import {PersonalMailReplyPanel} from '../../../src/components/personal-mail-reply-panel';const readonly=new URL(location.href).searchParams.has('readonly');createRoot(document.getElementById('root')!).render(<PersonalMailReplyPanel workspaceId="synthetic-workspace" messageId="synthetic-message" provider="google" replyEnabled={!readonly} attachments={[]} de={false}/>);`);
await build({entryPoints:[entry],bundle:true,outfile:bundle,format:'iife',platform:'browser',jsx:'automatic',tsconfig:resolve('tsconfig.json')});
const bytes=await readFile(bundle);
const server=createServer((request,response)=>{if(request.url==='/client.js'){response.setHeader('Content-Type','text/javascript');response.end(bytes);}else{response.setHeader('Content-Type','text/html');response.end('<!doctype html><html><body><div id="root"></div><script src="/client.js"></script></body></html>');}});
server.listen(0,'127.0.0.1');await once(server,'listening');
const address=server.address();assert.ok(address&&typeof address==='object');const origin=`http://127.0.0.1:${address.port}`;
let browser;const errors=[];let checks=0;
try{
 let executablePath=chromium.executablePath();try{await access(executablePath);}catch{executablePath='C:/Program Files/Google/Chrome/Application/chrome.exe';await access(executablePath);}
 browser=await chromium.launch({headless:true,executablePath,args:['--disable-background-networking']});
 for(const scenario of ['readonly','accepted','lost','attachment']){
  const context=await browser.newContext();
  await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
  await context.addInitScript(({scenario})=>{
   const actualFetch=window.fetch.bind(window),state={calls:[],jobs:[],files:[],csrf:0};window.mailUiState=state;
   window.fetch=async(input,init)=>{
    const url=new URL(typeof input==='string'?input:input.url,location.href),method=init?.method??'GET';
    const json=(data,status=200)=>Promise.resolve(new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}}));
    if(url.pathname==='/api/auth/csrf'){state.csrf++;return json({csrfToken:'synthetic-one-time-'+state.csrf});}
    if(!url.pathname.startsWith('/api/'))return actualFetch(input,init);
    if(method==='GET')return json({data:{files:state.files,jobs:state.jobs}});
    const payload=JSON.parse(init.body),headers=new Headers(init.headers);state.calls.push({payload,key:headers.get('idempotency-key'),correlation:headers.get('x-correlation-id'),csrf:headers.get('x-novalure-csrf-token')});
    if(url.pathname.endsWith('/start'))return json({error:'Synthetic consent recorded; no provider navigation'},409);
    if(payload.action==='store'){const file={id:'synthetic-file',fileName:'private.txt',mimeType:'text/plain',sizeBytes:12,status:'ready'};state.files=[file];return json({data:file,persisted:true});}
    if(payload.action==='preview')return json({data:{digest:'a'.repeat(64),from:'own@example.invalid',to:'lead@example.invalid',subject:'Synthetic reviewed subject',body:payload.body,attachments:state.files.filter(f=>payload.attachmentIds.includes(f.id))}});
    if(payload.action==='send'){
     const job={id:'synthetic-job',status:scenario==='lost'?'uncertain':'accepted',acceptedByProvider:scenario!=='lost',deliveryVerified:false,from:'own@example.invalid',to:'lead@example.invalid',subject:'Synthetic reviewed subject',body:payload.body,attachments:state.files};state.jobs=[job];
     if(scenario==='lost'&&state.calls.filter(c=>c.payload.action==='send').length===1)return json({error:'Synthetic lost response'},503);
     return json({data:job,persisted:true});
    }
    throw new Error('Unexpected synthetic API action');
   };
  },{scenario});
  const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`${origin}/?${scenario==='readonly'?'readonly=1':''}`);
  const text=page.getByRole('textbox',{name:'Plain text reply'}),review=page.getByRole('button',{name:'Review recipient and reply',exact:true});
  await expect(text).toBeVisible();
  if(scenario==='readonly'){
   await text.fill('Synthetic inert text');await expect(review).toBeDisabled();await page.getByRole('button',{name:'Explicitly allow reading and replying'}).click();await expect(page.getByRole('status')).toContainText('Synthetic consent');const calls=await page.evaluate(()=>window.mailUiState.calls);assert.deepEqual(calls[0].payload,{enableReply:true});checks++;
  }else{
   if(scenario==='attachment'){await page.getByLabel('Inspect a file for this reply').setInputFiles({name:'private.txt',mimeType:'text/plain',buffer:Buffer.from('private file')});await expect(page.getByLabel(/private.txt/)).toBeVisible();await page.getByLabel(/private.txt/).check();checks++;}
   await text.fill('<img src="https://attacker.invalid/tracker"> inert reply');await review.click();await expect(page.getByText('own@example.invalid → lead@example.invalid')).toBeVisible();assert.equal(await page.locator('img').count(),0);const send=page.getByRole('button',{name:'Send approved reply',exact:true});await expect(send).toBeDisabled();await page.getByRole('checkbox',{name:'I approve exactly this recipient, text and these files as my personal CRM reply.'}).check();await send.click();
   if(scenario==='lost'){
    const replay=page.getByRole('button',{name:'Safely reconcile the same request'});await expect(replay).toBeVisible();await expect(text).toBeDisabled();await replay.click();await expect.poll(async()=>page.evaluate(()=>window.mailUiState.calls.filter(c=>c.payload.action==='send').length)).toBe(2);await expect(page.getByText(/outcome unknown — no resend/)).toBeVisible();const sent=await page.evaluate(()=>window.mailUiState.calls.filter(c=>c.payload.action==='send'));assert.equal(sent.length,2);assert.equal(sent[0].key,sent[1].key);assert.equal(sent[0].correlation,sent[1].correlation);assert.deepEqual(sent[0].payload,sent[1].payload);checks++;
   }else{await expect(page.getByRole('status')).toContainText('delivery is not verified');await expect(page.getByText(/accepted by provider, delivery unverified/)).toBeVisible();checks++;}
  }
  const calls=await page.evaluate(()=>window.mailUiState.calls);assert.ok(calls.every(c=>c.csrf?.startsWith('synthetic-one-time-')));await context.close();
 }
 assert.deepEqual(errors,[]);console.log(JSON.stringify({classification:'LOCAL_UI_WITH_STUBBED_HTTP_NOT_AUTH_OR_PROVIDER_ACCEPTANCE',checks,pass:true,providerCalls:0}));
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
