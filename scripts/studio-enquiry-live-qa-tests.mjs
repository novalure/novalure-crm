import assert from "node:assert/strict";
import { test } from "node:test";
import { validateLiveQaConfig, validateQaPut, parseCurlResponse } from "./studio-enquiry-live-qa.mjs";
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
  const config={runId:'GOLIVETEST_STUDIO_123456',approvalId:'synthetic',signingSecret:'a'.repeat(32),qaEmail:'synthetic@example.invalid',crm:{projectId:'prj_R32Okl6AHijTohvuKmryuTLjWMsk',branch:'codex/studio-preview-crm-handoff',deploymentId:'dpl_synthetic123',gitSha:'a'.repeat(40),origin:'https://crm-synthetic.vercel.app'},qa:{databaseUrl:'postgresql://app:synthetic@ep-qa-pooler.eu-west-2.aws.neon.tech/neondb?sslmode=require',host:'ep-qa-pooler.eu-west-2.aws.neon.tech',productionHost:'ep-prod-pooler.eu-west-2.aws.neon.tech',projectId:'syntheticProject',branchId:'syntheticBranch',databaseName:'neondb',role:'app'}};
  assert.equal(validateLiveQaConfig(config),config);
  for(const change of [c=>c.crm.projectId='foreign',c=>c.crm.branch='main',c=>c.crm.origin='https://novalure-crm.ie',c=>c.qa.productionHost=c.qa.host,c=>c.signingSecret='short']){const c=structuredClone(config);change(c);assert.throws(()=>validateLiveQaConfig(c));}
});
test('CLI response parser preserves binary private media and separate cookies without exposing them',()=>{
  const bytes=Buffer.from([0,255,13,10,123,0]);
  const response=parseCurlResponse(Buffer.concat([Buffer.from('HTTP/1.1 200 Connection established\r\n\r\nHTTP/2 200\r\nContent-Type: image/png\r\nSet-Cookie: one=synthetic; Secure\r\nSet-Cookie: two=synthetic; Secure\r\n\r\n'),bytes]));
  assert.equal(response.status,200);assert.ok(response.body.equals(bytes));assert.equal(response.headers.get('set-cookie').length,2);
  assert.throws(()=>parseCurlResponse(Buffer.from('not an HTTP response')),/invalid_http_response/);
});
