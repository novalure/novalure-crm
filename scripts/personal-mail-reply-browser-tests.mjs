// LOCAL_UI_WITH_STUBBED_HTTP_NOT_AUTH_OR_PROVIDER_ACCEPTANCE.
// Actual React component + csrfFetch; all HTTP responses are synthetic and loopback-only.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {mkdir,writeFile,readFile,access} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {build} from 'esbuild';
import {chromium,expect} from '@playwright/test';
import {PDFDocument} from 'pdf-lib';
const root=resolve('.npm-cache/qa/personal-mail-ui');await mkdir(root,{recursive:true});
const entry=join(root,'entry.tsx'),bundle=join(root,'client.js');
await writeFile(entry,`import React from 'react';import {createRoot} from 'react-dom/client';import {PersonalMailReplyPanel} from '../../../src/components/personal-mail-reply-panel';const readonly=new URL(location.href).searchParams.has('readonly');createRoot(document.getElementById('root')!).render(<PersonalMailReplyPanel workspaceId="synthetic-workspace" messageId="synthetic-message" provider="google" replyEnabled={!readonly} attachments={[]} de={false}/>);`);
await build({entryPoints:[entry],bundle:true,outfile:bundle,format:'iife',platform:'browser',jsx:'automatic',tsconfig:resolve('tsconfig.json')});
const bytes=await readFile(bundle);
const passiveDocument=await PDFDocument.create();passiveDocument.addPage([100,100]);const passivePdf=Buffer.from(await passiveDocument.save());
const server=createServer((request,response)=>{if(request.url==='/client.js'){response.setHeader('Content-Type','text/javascript');response.end(bytes);}else{response.setHeader('Content-Type','text/html');response.end('<!doctype html><html><body><div id="root"></div><script src="/client.js"></script></body></html>');}});
server.listen(0,'127.0.0.1');await once(server,'listening');
const address=server.address();assert.ok(address&&typeof address==='object');const origin=`http://127.0.0.1:${address.port}`;
let browser;const errors=[];let checks=0;
try{
 let executablePath=chromium.executablePath();try{await access(executablePath);}catch{executablePath='C:/Program Files/Google/Chrome/Application/chrome.exe';await access(executablePath);}
 browser=await chromium.launch({headless:true,executablePath,args:['--disable-background-networking']});
 for(const scenario of ['readonly','accepted','lost','attachment','legacy-pdf','prepared','uncertain']){
  const context=await browser.newContext();
  await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
  await context.addInitScript(({scenario,passivePdfBase64})=>{
   const pdfBytes=Uint8Array.from(atob(passivePdfBase64),c=>c.charCodeAt(0));
   const legacyFile={id:'synthetic-legacy-pdf',fileName:'private.pdf',mimeType:'application/pdf',sizeBytes:pdfBytes.length,status:'ready',checkCode:'LOCAL_FORMAT_AND_STRUCTURE_CHECKED_NOT_ANTIVIRUS'};
   const history=status=>({id:'synthetic-'+status,status,acceptedByProvider:false,deliveryVerified:false,from:'own@example.invalid',to:'lead@example.invalid',subject:'Synthetic reviewed subject',body:'Earlier inert prepared reply',createdAt:'2026-11-04T10:00:00Z',attachments:[legacyFile]});
   const actualFetch=window.fetch.bind(window),state={calls:[],jobs:scenario==='prepared'||scenario==='uncertain'?[history(scenario)]:[],files:['legacy-pdf','prepared','uncertain'].includes(scenario)?[legacyFile]:[],csrf:0,fileReads:0,downloadAllowed:scenario!=='legacy-pdf',rejectPreview:false};window.mailUiState=state;
   window.fetch=async(input,init)=>{
    const url=new URL(typeof input==='string'?input:input.url,location.href),method=init?.method??'GET';
    const json=(data,status=200)=>Promise.resolve(new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}}));
    if(url.pathname==='/api/auth/csrf'){state.csrf++;return json({csrfToken:'synthetic-one-time-'+state.csrf});}
    if(!url.pathname.startsWith('/api/'))return actualFetch(input,init);
    if(method==='GET'){
     if(url.pathname.endsWith('/attachments')&&url.searchParams.has('id')){
      state.fileReads++;
      if(!state.downloadAllowed)return json({error:'Current inspection rejected the earlier ready marker; no file was released.'},409);
      return new Response(pdfBytes,{headers:{'Content-Type':'application/pdf','Content-Length':String(pdfBytes.length),'Cache-Control':'private, no-store'}});
     }
     return json({data:{files:state.files,jobs:state.jobs}});
    }
    const payload=JSON.parse(init.body),headers=new Headers(init.headers);state.calls.push({payload,key:headers.get('idempotency-key'),correlation:headers.get('x-correlation-id'),csrf:headers.get('x-novalure-csrf-token')});
    if(url.pathname.endsWith('/start'))return json({error:'Synthetic consent recorded; no provider navigation'},409);
    if(payload.action==='store'){const file={id:'synthetic-file',fileName:'private.txt',mimeType:'text/plain',sizeBytes:12,status:'ready'};state.files=[file];return json({data:file,persisted:true});}
    if(payload.action==='cancel_prepared'){state.jobs=state.jobs.map(job=>job.id===payload.jobId?{...job,status:'suppressed'}:job);return json({data:{id:payload.jobId,status:'suppressed'},persisted:true});}
    if(payload.action==='preview'&&state.rejectPreview)return json({error:'Current PDF inspection is not confirmed; review this copy again.'},409);
    if(payload.action==='preview')return json({data:{digest:'a'.repeat(64),from:'own@example.invalid',to:'lead@example.invalid',subject:'Synthetic reviewed subject',body:payload.body,attachments:state.files.filter(f=>payload.attachmentIds.includes(f.id))}});
    if(payload.action==='send'){
     const job={id:'synthetic-job',status:scenario==='lost'?'uncertain':'accepted',acceptedByProvider:scenario!=='lost',deliveryVerified:false,from:'own@example.invalid',to:'lead@example.invalid',subject:'Synthetic reviewed subject',body:payload.body,attachments:state.files};state.jobs=[job];
     if(scenario==='lost'&&state.calls.filter(c=>c.payload.action==='send').length===1)return json({error:'Synthetic lost response'},503);
     return json({data:job,persisted:true});
    }
    throw new Error('Unexpected synthetic API action');
   };
  },{scenario,passivePdfBase64:passivePdf.toString('base64')});
  const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`${origin}/?${scenario==='readonly'?'readonly=1':''}`);
  const text=page.getByRole('textbox',{name:'Plain text reply'}),review=page.getByRole('button',{name:'Review recipient and reply',exact:true});
  await expect(text).toBeVisible();
  if(scenario==='legacy-pdf'){
   await expect(page.getByText('private.pdf · stored private copy',{exact:true})).toBeVisible();
   await expect(page.getByText(/An earlier inspection marker is not current approval/)).toBeVisible();
   await page.getByLabel(/private.pdf/).check();await text.fill('Synthetic inert PDF reply');await review.click();
   const approval=page.getByRole('checkbox',{name:'I approve exactly this recipient, text and these files as my personal CRM reply.'});
   await approval.check();await page.evaluate(()=>{window.mailUiState.rejectPreview=true;});await review.click();
   await expect(page.getByRole('status')).toContainText('Current PDF inspection is not confirmed');
   await expect(approval).toHaveCount(0);await expect(page.getByRole('button',{name:'Send approved reply',exact:true})).toHaveCount(0);checks++;
   await page.evaluate(()=>{window.mailUiState.rejectPreview=false;});await review.click();await approval.check();
   let downloads=0;page.on('download',()=>downloads++);
   const downloadButton=page.getByRole('button',{name:'Inspect and download privately',exact:true});
   await downloadButton.click();await expect(page.getByRole('status')).toContainText('Current inspection rejected the earlier ready marker');
   assert.equal(downloads,0);assert.equal(await page.evaluate(()=>window.mailUiState.fileReads),1);await expect(approval).toHaveCount(0);checks++;
   await page.evaluate(()=>{window.mailUiState.downloadAllowed=true;});
   const [download]=await Promise.all([page.waitForEvent('download'),downloadButton.click()]);
   assert.equal(download.suggestedFilename(),'private.pdf');const stream=await download.createReadStream();assert.ok(stream);
   const parts=[];for await(const part of stream)parts.push(part);assert.deepEqual(Buffer.concat(parts),passivePdf);
   assert.equal(await page.evaluate(()=>window.mailUiState.fileReads),2);assert.equal((await page.evaluate(()=>window.mailUiState.calls)).filter(c=>c.payload.action==='send').length,0);checks++;
  }else if(scenario==='prepared'){
   await expect(page.getByText(/prepared, not started/)).toBeVisible();await expect(text).toBeDisabled();await expect(review).toBeDisabled();
   await page.getByRole('button',{name:'Discard unsent preparation',exact:true}).click();await expect(page.getByText(/suppressed before dispatch/)).toBeVisible();
   await expect(page.getByText('private.pdf · stored private copy',{exact:true})).toBeVisible();
   const calls=await page.evaluate(()=>window.mailUiState.calls);assert.equal(calls.length,1);assert.equal(calls[0].payload.action,'cancel_prepared');checks++;
  }else if(scenario==='uncertain'){
   await expect(page.getByText(/outcome unknown — no resend/)).toBeVisible();await expect(text).toBeDisabled();await expect(review).toBeDisabled();
   await expect(page.getByRole('button',{name:'Discard unsent preparation',exact:true})).toHaveCount(0);
   await expect(page.getByRole('button',{name:'Safely reconcile the same request',exact:true})).toHaveCount(0);
   await page.getByRole('button',{name:'Reload receipts only',exact:true}).click();await expect(page.getByText(/outcome unknown — no resend/)).toBeVisible();
   assert.equal((await page.evaluate(()=>window.mailUiState.calls)).length,0);checks++;
  }else if(scenario==='readonly'){
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
