import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { parseStudioEnquiryRequest, verifyStudioEnquirySignature } from "../src/lib/studio-enquiry-contract.ts";
import path from "node:path";
import {readFile} from "node:fs/promises";
import { validateLiveQaConfig, validateQaPut, parseCurlResponse, liveQaDatabaseOptions, isAllowedLiveQaHttpPath,buildPrivateCurlRequest,nativeCurlEnvironment,createSignedQaCaller,verifySignedPreReserveRejections,verifyMissingCopyRejection } from "./studio-enquiry-live-qa.mjs";
const operationId='4d1aac3d-d3dc-40f5-87c1-3664e1272da7', sourceId='e173fc56-165c-4920-aa9c-5c945ea6db8a', assetId='fe711063-f9a1-4289-8f70-2b7c96635018';
const workspace='8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101';
const content={mime:'image/png',bytes:123,sha256:'a'.repeat(64)};
const snapshot={files:[{id:sourceId,original:content,mime:'image/webp',bytes:50,sha256:'b'.repeat(64)}]};
function target(){const pathname=`${workspace}/studio-enquiries/${operationId}/${assetId}.png`;return{sourceId,variant:'original',assetId,sha256:content.sha256,pathname,status:'upload_required',put:{url:'https://vercel.com/api/blob/?pathname='+encodeURIComponent(pathname),headers:{'Content-Type':content.mime,'x-content-type':content.mime,'x-content-length':'123','x-vercel-blob-access':'private','x-vercel-blob-store-id':'syntheticStore','x-api-version':'13'}}};}
test('live harness grants reject foreign endpoint, scope, role, credential header and changed bytes',()=>{
  assert.deepEqual(validateQaPut(target(),snapshot,operationId),content);
  for(const change of [t=>t.put.url=t.put.url.replace('vercel.com','foreign.example'),t=>t.pathname='foreign/'+t.pathname,t=>{t.pathname=t.pathname.replace(assetId,'../'+assetId);t.put.url='https://vercel.com/api/blob/?pathname='+encodeURIComponent(t.pathname);},t=>t.variant='unknown',t=>t.put.headers.Authorization='secret',t=>t.put.headers['x-content-length']='124']){
    const t=target();change(t);assert.throws(()=>validateQaPut(t,snapshot,operationId));
  }
});
test('live harness requires exact isolated Preview and rejects Production DB identity before any request',()=>{
  const config={runId:'GOLIVETEST_STUDIO_123456',approvalId:'synthetic',protectionTokenFile:path.resolve('synthetic-private-existing-protection.txt'),signingSecret:'a'.repeat(32),qaEmail:'synthetic@example.invalid',crm:{projectId:'prj_R32Okl6AHijTohvuKmryuTLjWMsk',branch:'codex/studio-preview-crm-handoff',deploymentId:'dpl_synthetic123',gitSha:'a'.repeat(40),origin:'https://crm-synthetic.vercel.app'},qa:{databaseUrl:'postgresql://app:synthetic@ep-qa-pooler.eu-west-2.aws.neon.tech/neondb?sslmode=verify-full',host:'ep-qa-pooler.eu-west-2.aws.neon.tech',productionHost:'ep-prod-pooler.eu-west-2.aws.neon.tech',projectId:'syntheticProject',branchId:'syntheticBranch',databaseName:'neondb',role:'app'}};
  assert.equal(validateLiveQaConfig(config),config);
  const options=liveQaDatabaseOptions(config);assert.equal(options.ssl.rejectUnauthorized,true);assert.ok(options.ssl.ca.length>0);
  assert.equal(options.host,config.qa.host);assert.equal(Object.hasOwn(options,'connectionString'),false);
  for(const query of ['', '?sslmode=require', '?sslmode=require&uselibpqcompat=true', '?sslmode=verify-full&sslrootcert=system', '?sslmode=verify-full&options=-c%20ssl=off']){
    const unsafe=structuredClone(config);unsafe.qa.databaseUrl=config.qa.databaseUrl.split('?')[0]+query;assert.throws(()=>liveQaDatabaseOptions(unsafe),/invalid_qa_database/);
  }
  for(const change of [c=>c.crm.projectId='foreign',c=>c.crm.branch='main',c=>c.crm.origin='https://novalure-crm.ie',c=>c.qa.productionHost=c.qa.host,c=>c.signingSecret='short']){const c=structuredClone(config);change(c);assert.throws(()=>validateLiveQaConfig(c));}
});
test('CLI response parser preserves binary private media and separate cookies without exposing them',()=>{
  const bytes=Buffer.from([0,255,13,10,123,0]);
  const response=parseCurlResponse(Buffer.concat([Buffer.from('HTTP/1.1 200 Connection established\r\n\r\nHTTP/2 200\r\nContent-Type: image/png\r\nSet-Cookie: one=synthetic; Secure\r\nSet-Cookie: two=synthetic; Secure\r\n\r\n'),bytes]));
  assert.equal(response.status,200);assert.ok(response.body.equals(bytes));assert.equal(response.headers.get('set-cookie').length,2);
  assert.throws(()=>parseCurlResponse(Buffer.from('not an HTTP response')),/invalid_http_response/);
});

test('normal MFA page access is limited to the two exact same-origin challenge paths',()=>{
  for(const value of ['/login?step=mfa_enrollment','/login?step=mfa_verification','/api/auth/login','/api/auth/session']){
    assert.equal(isAllowedLiveQaHttpPath(value),true);
  }
  for(const value of ['/login','/login?step=mfa_enrollment&returnTo=https://foreign.example','//foreign.example/login?step=mfa_enrollment',
    'https://foreign.example/login?step=mfa_enrollment','/login?step=workspace_selection','/login?step=mfa_enrollment#secret','/api/auth/login\r\nAuthorization: secret','/api\\foreign']){
    assert.equal(isAllowedLiveQaHttpPath(value),false);
  }
});

test('native protected HTTP keeps every secret out of argv and quotes private curl config',()=>{
  const protectionToken='synthetic-existing-protection-token',cookie='session="synthetic"; directory=C:\\private\\file',signature='synthetic-hmac-value';
  const bodyFile=path.resolve('synthetic-private-request.body');
  const request=buildPrivateCurlRequest({origin:'https://crm-synthetic.vercel.app',pathname:'/api/public/website-sales/enquiry',method:'POST',
    headers:{Cookie:cookie,'X-Novalure-Signature':signature,'Content-Type':'application/json'},bodyFile,protectionToken});
  assert.deepEqual(request.args,['--disable','--config','-']);
  for(const value of [protectionToken,cookie,signature])assert.equal(JSON.stringify(request.args).includes(value),false);
  const config=request.input.toString('utf8');
  assert.ok(config.includes('header = "Cookie: session=\\"synthetic\\"; directory=C:\\\\private\\\\file"'));
  assert.ok(config.includes('header = "X-Novalure-Signature: '+signature+'"'));
  assert.ok(config.includes('url = "https://crm-synthetic.vercel.app/api/public/website-sales/enquiry"'));
  assert.ok(config.includes('data-binary = "@'+bodyFile.replaceAll('\\','\\\\')+'"'));
  assert.ok(config.includes('max-redirs = 0'));assert.ok(config.includes('proto = "=https"'));
  assert.equal(config.includes('insecure'),false);assert.equal(config.includes('location'),false);
});
test('native request rejects CRLF/header overrides, traversal and absent existing protection',()=>{
  const base={origin:'https://crm-synthetic.vercel.app',pathname:'/api/version',protectionToken:'synthetic-existing-protection-token'};
  for(const changes of [{headers:{Cookie:'secret\r\nInjected: yes'}},{headers:{'X-Novalure-Signature':'secret\nbad'}},
    {headers:{Host:'foreign.example'}},{headers:{'X-Vercel-Protection-Bypass':'other'}},{headers:{Cookie:'one',cookie:'two'}},
    {protectionToken:'secret\r\nInjected: yes'},{protectionToken:''},{method:'PUT'},{bodyFile:'relative-file'},
    {pathname:'/api/../foreign'},{pathname:'/api/%2e%2e/foreign'},{pathname:'//foreign.example/api/version'},
    {origin:'https://crm-synthetic.vercel.app@foreign.example'}]){
    assert.throws(()=>buildPrivateCurlRequest({...base,...changes}));
  }
});
test('native client strips ambient secret, proxy and certificate override environment',()=>{
  const result=nativeCurlEnvironment({Path:'system-path',SystemRoot:'C:\\Windows',HTTPS_PROXY:'synthetic-proxy',ALL_PROXY:'synthetic-proxy',
    VERCEL_AUTOMATION_BYPASS_SECRET:'must-not-enter-env',SSL_CERT_FILE:'override',CURL_CA_BUNDLE:'override',SSLKEYLOGFILE:'private-key-log',SIGNING_SECRET:'must-not-copy'});
  assert.deepEqual(result,{Path:'system-path',SystemRoot:'C:\\Windows'});
});
test('authoritative transport has no Vercel curl or token-provisioning path',async()=>{
  const source=await readFile(new URL('./studio-enquiry-live-qa.mjs',import.meta.url),'utf8');
  assert.doesNotMatch(source,/executeCli\(cli,\s*\[\s*["']curl/);
  assert.doesNotMatch(source,/--protection-bypass|VERCEL_AUTOMATION_BYPASS_SECRET|getOrCreate/);
  assert.match(source,/C:\\\\Windows\\\\System32\\\\curl\.exe/);
  assert.match(source,/assertPrivateQaPath\(config\.protectionTokenFile\)/);
});

test('signed negative HTTP probes bypass only client validation and precede an empty reserve/finalize-409 flow', async()=>{
  const signingSecret='synthetic-live-qa-negative-signing-secret',conversationId='e8025342-bebf-4695-aae4-a845ec798104';
  const s={schemaVersion:'studio-enquiry-snapshot-v1',conversationId,confirmedAt:new Date().toISOString(),
    consent:{privacy:true,policyVersion:'studio-enquiry-2026-10-18'},brief:{values:{goals:'Synthetic website',email:'st1-qa@example.invalid',contactMethod:'email'},
      summary:'Synthetic website',openQuestions:[]},files:[{id:sourceId,conversationId,name:'synthetic.png',...content,mime:'image/webp',originalSha256:content.sha256,
        original:content,analysis:{status:'partial',summary:'Synthetic file',extractedText:'Synthetic file',limitations:['Synthetic offline harness fixture.']}}],websites:[],syntheticTest:true};
  const digest=value=>createHash('sha256').update(value).digest('hex');
  const state={operationId,revision:1,snapshot:s,payloadHash:digest(JSON.stringify(s))};
  const sequence=[],effects={transfers:0,leads:0,submissions:0,assets:0,links:0};
  const http=async(pathname,{headers,body})=>{
    assert.equal(pathname,'/api/public/website-sales/enquiry');
    assert.equal(verifyStudioEnquirySignature(body,headers['X-Novalure-Timestamp'],headers['X-Novalure-Signature'],signingSecret),true);
    const raw=JSON.parse(body);assert.equal(raw.payloadHash,digest(JSON.stringify(raw.snapshot)));
    assert.equal(headers['Idempotency-Key'],operationId);
    let data,status;
    try{parseStudioEnquiryRequest(raw);}catch{
      assert.ok(raw.snapshot.workspaceId || raw.snapshot.files[0].conversationId!==raw.snapshot.conversationId);
      sequence.push(raw.snapshot.workspaceId?'foreignScope400':'foreignConversation400');
      return{status:400,body:Buffer.from(JSON.stringify({error:'invalid_enquiry'}))};
    }
    if(raw.action==='reserve'){effects.transfers=1;sequence.push('reserve');status=200;data={status:'reserved'};}
    else {assert.equal(raw.action,'finalize');sequence.push('prematureFinalize409');status=409;data={error:'files_not_copied'};}
    return{status,body:Buffer.from(JSON.stringify(data))};
  };
  const result=await verifySignedPreReserveRejections({state,http,signingSecret,captureCounts:async()=>({...effects})});
  assert.ok(Object.values(result).every(v=>v.startsWith('PASS')));
  assert.equal(effects.transfers,0);
  const call=createSignedQaCaller({state,http,signingSecret});await call('reserve');
  const counts=()=>Promise.resolve({state:'reserved',leads:effects.leads,submissions:effects.submissions,assets:effects.assets,links:effects.links});
  assert.match(await verifyMissingCopyRejection({call,captureCounts:counts}),/^PASS_HTTP409/);
  assert.deepEqual(sequence,['foreignScope400','foreignConversation400','reserve','prematureFinalize409']);
  assert.deepEqual(effects,{transfers:1,leads:0,submissions:0,assets:0,links:0});
  await assert.rejects(verifySignedPreReserveRejections({state,http:async()=>({status:200,body:Buffer.from('{}')}),signingSecret,
    captureCounts:async()=>({...effects})}),/signed_negative_not_rejected/);
  await assert.rejects(verifyMissingCopyRejection({call:async()=>({data:{error:'wrong'}}),captureCounts:counts}),/missing_copy_error/);
  await assert.rejects(verifyMissingCopyRejection({call:async()=>{throw new Error('must_not_dispatch');},captureCounts:async()=>({...await counts(),assets:1})}),/precopy_state_not_empty/);
});
