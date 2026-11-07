import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { applySalesSchema } from './lib/local-sales-db.mjs';
import { seedSalesBrowser } from './lib/sales-browser-fixture.mjs';
import { startReachabilityDb } from './lib/property-reachability-local-db.mjs';
import { startReachabilityHttp } from './lib/property-reachability-next-http.mjs';
import { createCsrfToken } from '../src/lib/security/csrf-core';
import { createPropertyGeography } from '../src/lib/property-country';

/** Real Next custom server on loopback, real local PG, synthetic session only.
 * No direct route-handler call, provider, remote publication or browser claim. */
export async function runPropertyReachabilityHttpProbe() {
  const db = await startReachabilityDb();
  let http: Awaited<ReturnType<typeof startReachabilityHttp>> | undefined;
  const result: Record<string, unknown> = { schemaVersion: 1, scope: 'ACTUAL_NEXT_LOCAL_HTTP_AND_REAL_PG_SYNTHETIC_ONLY_NOT_BROWSER_OR_PRODUCTION', startedAt: new Date().toISOString(),
    method: 'NEXT_DOCUMENTED_CUSTOM_SERVER', remoteCalls: 0, localFixturePublicationOnly: true, actualBrowserRun: false, ok: false };
  const root=path.join(db.directory,'http-probe.json');
  try {
    await applySalesSchema(db);
    const fixture=await seedSalesBrowser(db);
    await db.admin.query("update projects set type='Service',customer_type='real_estate_broker' where id=$1",[fixture.projectId]);
    const auth={session:randomBytes(48).toString('base64url'),encryption:randomBytes(40).toString('hex'),rateLimit:randomBytes(40).toString('hex')};
    const cookie='v2.'+randomBytes(32).toString('base64url');
    await db.admin.query("update auth_identities set mfa_enabled_at=now(),mfa_secret_ciphertext='SYNTHETIC-NOT-A-REAL-SECRET' where id=$1",[fixture.authIdentityId]);
    await db.admin.query("insert into auth_sessions(id,token_hash,auth_identity_id,workspace_user_id,workspace_id,mfa_verified_at,expires_at) values($1,$2,$3,$4,$5,now(),now()+interval '1 hour')",[randomUUID(),createHash('sha256').update(cookie).digest('hex'),fixture.authIdentityId,fixture.userId,fixture.workspaceId]);
    http=await startReachabilityHttp(db,auth);result.httpRunDirectory=http.runDirectory;
    const request=async(pathname:string,body?:unknown,authenticated=true,csrf=true)=>{
      const url=new URL(pathname,http!.origin);url.searchParams.set('workspaceId',fixture.workspaceId);
      const response=await fetch(url,{method:body===undefined?'GET':'POST',redirect:'error',signal:AbortSignal.timeout(90000),headers:{
        ...(authenticated?{cookie:'novalure_session='+cookie}:{}),...(body===undefined?{}:{'content-type':'application/json',origin:http!.origin,'sec-fetch-site':'same-origin','Idempotency-Key':randomUUID(),'X-Correlation-Id':randomUUID(),
          ...(csrf?{'x-novalure-csrf-token':createCsrfToken({method:'POST',pathname:url.pathname,secret:auth.session,sessionCookie:cookie})!.token}:{})})},...(body===undefined?{}:{body:JSON.stringify(body)})});
      return response;
    };
    const payload={operation:'create_property',projectId:fixture.projectId,title:'SYNTHETIC ES RENT HTTP',address:'SYNTHETIC PRIVATE ADDRESS 999 - NO REAL SITE',
      geography:{...createPropertyGeography('ES','Andalucía'),displayLocale:'en-IE'},energyCertificate:{version:1,countryCode:'ES',certificateType:'existing',energyClass:'B',finalEnergyDemandKwhM2:51.25,registration:'SYNTHETIC-UNVERIFIED'},
      areaSqm:85.75,rooms:3,yearBuilt:1998,objectType:'Wohnung',usageType:'residential',marketingType:'rent',price:315000,rentPrice:1743.21,rentNet:1394.57,priceVisibility:'publish_price'};
    const unauth=await request('/api/crm/properties',payload,false,false);assert.equal(unauth.status,401);
    const missingCsrf=await request('/api/crm/properties',payload,true,false);assert.equal(missingCsrf.status,403);
    Object.assign(result,{authDeniedStatus:unauth.status,csrfDeniedStatus:missingCsrf.status});
    const response=await request('/api/crm/properties',payload);assert.equal(response.status,200,'HTTP create must pass unchanged session/CSRF and real server validation');
    const created=await response.json();assert.equal(created.persisted,true);const propertyId=created.data.id;
    result.createStatus=response.status;
    const saved=(await db.admin.query("select id,rent_price_cents::text as rent,canonical_payload->'geography' as geography from seller_listings where id=$1 and workspace_id=$2",[propertyId,fixture.workspaceId])).rows[0];
    assert.equal(saved.rent,'174321');assert.equal(saved.geography.displayLocale,'en-IE');
    Object.assign(result,{savedRentCents:saved.rent,savedLocale:saved.geography.displayLocale});
    const full=await request(`/api/crm/properties?operation=full&propertyId=${propertyId}`);assert.equal(full.status,200);const fullBody=await full.json();assert.equal(fullBody.data.listing.id,propertyId);
    await writeFile(path.join(http.runDirectory,'local-property-read.json'),JSON.stringify(fullBody,null,2)+'\n');result.fullReadStatus=full.status;
    const web={action:'preview',propertyId,language:'es',description:'SYNTHETIC original HTTP fixture description',showAddress:false,showContact:false,reviewed:true,controller:'SYNTHETIC LOCAL QA',legalUrl:'https://example.invalid/legal',privacyUrl:'https://example.invalid/privacy'};
    const previewResponse=await request('/api/crm/web-exposes',web);assert.equal(previewResponse.status,200);const preview=(await previewResponse.json()).data;
    await writeFile(path.join(http.runDirectory,'local-web-preview-data.json'),JSON.stringify(preview,null,2)+'\n');result.previewStatus=previewResponse.status;
    assert.equal(preview.snapshot.locale,'en-IE');assert.equal(preview.snapshot.countryCode,'ES');assert.equal(preview.snapshot.price,new Intl.NumberFormat('en-IE',{style:'currency',currency:'EUR'}).format(1743.21));
    const publishedResponse=await request('/api/crm/web-exposes',{...web,action:'publish',expectedSourceFingerprint:preview.sourceFingerprint});assert.equal(publishedResponse.status,200);const published=(await publishedResponse.json()).data;
    result.localPublishStatus=publishedResponse.status;
    assert.match(published.path,/^\/expose\/[A-Za-z0-9_-]+$/);const token=published.path.split('/').at(-1)!;
    const page=await fetch(http.origin+published.path,{redirect:'error',signal:AbortSignal.timeout(90000)});assert.equal(page.status,200);const html=await page.text();assert.ok(html.includes(payload.title));assert.ok(!html.includes(payload.address));
    await writeFile(path.join(http.runDirectory,'local-public-page.html'),html);
    result.anonymousLocalHtmlStatus=page.status;
    const pdf=await fetch(`${http.origin}/api/public/exposes/${token}/pdf`,{redirect:'error',signal:AbortSignal.timeout(90000)});assert.equal(pdf.status,200);assert.match(pdf.headers.get('content-type')??'',/application\/pdf/);
    const pdfBytes=Buffer.from(await pdf.arrayBuffer());assert.equal(pdfBytes.subarray(0,5).toString(),'%PDF-');await writeFile(path.join(http.runDirectory,'local-public-expose.pdf'),pdfBytes);
    Object.assign(result,{ok:true,authDeniedStatus:unauth.status,csrfDeniedStatus:missingCsrf.status,createStatus:response.status,fullReadStatus:full.status,
      savedRentCents:saved.rent,savedLocale:saved.geography.displayLocale,previewStatus:previewResponse.status,previewPrice:preview.snapshot.price,previewLocale:preview.snapshot.locale,
      localPublishStatus:publishedResponse.status,anonymousLocalHtmlStatus:page.status,anonymousLocalPdfStatus:pdf.status,htmlBytes:Buffer.byteLength(html),pdfBytes:pdfBytes.length,
      publicHtmlFile:'local-public-page.html',publicPdfFile:'local-public-expose.pdf',credentialsOrPublicTokenIncludedInReceipt:false});
  } catch(error) { result.failure=error instanceof Error?{name:error.name,message:error.message.slice(0,300)}:{name:'UNKNOWN'};throw error; }
  finally {
    try{if(http)result.httpCleanup=await http.stop();}finally{result.dbCleanup=await db.stop();result.finishedAt=new Date().toISOString();await writeFile(root,JSON.stringify(result,null,2)+'\n');}
  }
  console.log(JSON.stringify({scope:result.scope,ok:result.ok,receipt:root,httpRunDirectory:http!.runDirectory,actualBrowserRun:false}));
}
if(process.argv[1]&&path.resolve(process.argv[1])===path.resolve('scripts/property-reachability-http-probe.ts'))void runPropertyReachabilityHttpProbe().catch(error=>{
  console.error(JSON.stringify({scope:'LOCAL_HTTP_PROBE_FAILURE',name:error instanceof Error?error.name:'UNKNOWN',message:error instanceof Error?error.message.slice(0,300):'UNKNOWN'}));process.exitCode=1;
});
