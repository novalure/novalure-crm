import {GET,POST} from '../src/app/api/crm/website-sales/commerce/route';
import {executeWebsiteSalesEnablementCommand,readWebsiteSalesEnablement} from '../src/lib/db/website-sales-enablement-repositories';
import type {WebsiteSalesEnablementCommand} from '../src/lib/website-sales-enablement-types';
import {websiteSalesCommerceTermMonths} from '../src/lib/db/website-sales-commerce-care';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createHash, randomBytes, randomUUID, generateKeyPairSync } from 'node:crypto';
import { Pool } from 'pg';
import type { AppSession } from '../src/lib/auth/session';
import type { TenantPool } from '../src/lib/db/tenant-client';
import { getRolePermissions } from '../src/lib/auth/permissions';
import { getProductRoleCapabilities } from '../src/lib/product-model';
import { withCrmRead } from '../src/lib/crm-command';
import { closeLocalTestPool } from '../src/lib/db/local-test-transport';
import { runWebsiteSalesIrelandCommand, websiteSalesIrelandContract, type WebsiteSalesIrelandCommand } from '../src/lib/db/website-sales-ireland-repositories';
import { executeOfferCommand } from '../src/lib/db/offer-repositories';
import { executeWebsiteSalesCommerceCommand as execute, readWebsiteSalesCommerce as read, reconcileWebsiteSalesCommerceCommand as reconcile } from '../src/lib/db/website-sales-commerce-repositories';
import { websiteSalesCommerceContract, type WebsiteSalesCommerceCommand as Command, type WebsiteSalesCommerceSourceEvent as Event } from '../src/lib/website-sales-commerce-types';
import { commerceDigest, commerceContentSha256, commerceSourceFactDigest } from '../src/lib/website-sales-commerce-domain';
import { createWebsiteSalesCommerceExecutor, claimWebsiteSalesCommerceJob, dispatchWebsiteSalesCommerceJob, verifyWebsiteSalesCommerceSource, readWebsiteSalesCommerceJob, type CommerceExecutionBinding } from '../src/lib/db/website-sales-commerce-outbox';
import { ingestVerifiedWebsiteSalesCommerceSource } from '../src/lib/db/website-sales-commerce-sources';
import { CRM_MACHINE_WORKSPACE_ID, CRM_MACHINE_AUDIENCE, CRM_MACHINE_ISSUER, CRM_MACHINE_SUBJECT, CRM_MACHINE_PROJECT_ID, CRM_MACHINE_OWNER_ID, CRM_MACHINE_ENVIRONMENT } from '../src/lib/crm-machine-auth';
import { applySalesSchema, startLocalSalesDb } from './lib/local-sales-db.mjs';

test('care finite obligations use original clamped calendar anniversaries without a month13 reset',()=>{
 assert.deepEqual(websiteSalesCommerceTermMonths('2026-01-31T09:30:00.000Z','2026-01-31T09:30:00.000Z','2026-02-28T09:30:00.000Z'),{firstServiceMonth:1,months:1});
 assert.deepEqual(websiteSalesCommerceTermMonths('2026-01-31T09:30:00.000Z','2026-02-28T09:30:00.000Z','2026-03-31T09:30:00.000Z'),{firstServiceMonth:2,months:1});
 assert.deepEqual(websiteSalesCommerceTermMonths('2025-01-31T09:30:00.000Z','2026-01-31T09:30:00.000Z','2026-02-28T09:30:00.000Z'),{firstServiceMonth:13,months:1});
 assert.throws(()=>websiteSalesCommerceTermMonths('2026-01-31T09:30:00.000Z','2026-02-27T09:30:00.000Z','2026-03-31T09:30:00.000Z'),{code:'CARE_FINITE_COMPLETE_MONTH_TERM_REQUIRED'});
});
test('commerce schema preserves historical migrations and installs forced scoped RLS without an active executor', { timeout: 120000 }, async () => {
 const db = await startLocalSalesDb();
 try {
  await applySalesSchema(db, { maxMigrationNumber: 90 });
  for (const name of ['170_crm_personal_mailbox.sql','202_website_sales_ireland.sql','203_website_sales_machine.sql','204_website_sales_studio.sql','205_website_sales_lifecycle.sql','206_website_sales_operations.sql','207_website_sales_conversations.sql','208_website_sales_enablement.sql','209_website_sales_commerce.sql']) await db.admin.query(await readFile(`migrations/${name}`, 'utf8'));
  const rows = (await db.admin.query("select relname,relrowsecurity,relforcerowsecurity from pg_class where relnamespace='public'::regnamespace and relname like 'crm_website_sales_commerce%' and relkind='r' order by relname")).rows;
  assert.equal(rows.length, 9); assert(rows.every(row => row.relrowsecurity && row.relforcerowsecurity));
  const role = (await db.admin.query("select rolcanlogin,rolsuper,rolbypassrls from pg_roles where rolname='novalure_website_sales_commerce_executor'")).rows[0];
  assert.deepEqual(role, {rolcanlogin:false,rolsuper:false,rolbypassrls:false});
  assert.equal((await db.admin.query("select count(*)::int n from crm_website_sales_commerce_sources")).rows[0].n, 0);
  assert.equal((await db.admin.query("select count(*)::int n from crm_website_sales_machine_grants")).rows[0].n, 0);
 } finally { await db.stop(); }
});

test('commerce canonical offer, native owner approval, outbox and verified financial facts use actual isolated PostgreSQL', {timeout:240000}, async t => {
 const db=await startLocalSalesDb(), keys=['DATABASE_URL','CRM_LOCAL_TEST_DATABASE','NODE_ENV','NOVALURE_SESSION_SECRET','NOVALURE_APP_ORIGIN','NOVALURE_AUTH_STRICT','NOVALURE_AUTH_ENCRYPTION_KEY','NOVALURE_AUTH_RATE_LIMIT_SECRET'], before=Object.fromEntries(keys.map(k=>[k,process.env[k]]));let executorPool:Pool|undefined;
 try{
  Object.assign(process.env,{DATABASE_URL:`postgresql://${db.role}@127.0.0.1:${db.port}/postgres`,CRM_LOCAL_TEST_DATABASE:'1',NODE_ENV:'test'});
  await applySalesSchema(db,{maxMigrationNumber:90});
  for(const file of ['170_crm_personal_mailbox.sql','202_website_sales_ireland.sql','203_website_sales_machine.sql','204_website_sales_studio.sql','205_website_sales_lifecycle.sql','206_website_sales_operations.sql','207_website_sales_conversations.sql','208_website_sales_enablement.sql','209_website_sales_commerce.sql'])await db.admin.query(await readFile(`migrations/${file}`,'utf8'));
  const ws=CRM_MACHINE_WORKSPACE_ID,ownerId=randomUUID(),agent=randomUUID(),project=randomUUID(),company=randomUUID(),contact=randomUUID(),pipeline=randomUUID(),otherWs=randomUUID(),foreignId=randomUUID();
  await db.admin.query("insert into workspaces(id,name,operating_model,customer_type)values($1,'SYNTHETIC commerce','novalure_internal','novalure_internal'),($2,'SYNTHETIC foreign','novalure_internal','novalure_internal')on conflict(id)do nothing",[ws,otherWs]);
  await db.admin.query("insert into workspace_users(id,workspace_id,name,email,role,product_role)values($1,$2,'SYNTHETIC owner','commerce-owner@example.invalid','owner','novalure_operator'),($3,$2,'SYNTHETIC agent','commerce-agent@example.invalid','agent','novalure_operator'),($4,$5,'SYNTHETIC foreign owner','commerce-foreign@example.invalid','owner','novalure_operator')",[ownerId,ws,agent,foreignId,otherWs]);
  await db.admin.query("update workspaces set setup_state=jsonb_build_object('salesApprovalUserId',$2::text)where id=$1",[ws,ownerId]);
  await db.admin.query("insert into projects(id,workspace_id,name,type,division)values($1,$2,'SYNTHETIC website','Website','WEB_DESIGN')",[project,ws]);
  await db.admin.query('insert into project_pipeline_permissions(workspace_id,project_id,user_id,can_read,can_edit_deals)values($1,$2,$3,true,true)',[ws,project,agent]);
  await db.admin.query("insert into crm_pipelines(id,workspace_id,project_id,key,name,purpose,is_default)values($1,$2,$3,'commerce-test','SYNTHETIC pipeline','novalure_internal',true)",[pipeline,ws,project]);
  for(const[i,name]of['Qualifizieren','Gewonnen','Verloren'].entries())await db.admin.query('insert into crm_pipeline_stages(pipeline_id,workspace_id,project_id,key,name,position,category)values($1,$2,$3,$4,$5,$6,$7)',[pipeline,ws,project,i===0?'qualify':name.toLowerCase(),name,i,i===1?'won':i===2?'lost':'work']);
  await db.admin.query('update projects set default_pipeline_id=$2 where id=$1',[project,pipeline]);
  await db.admin.query("insert into organizations(id,workspace_id,project_id,name,type,division)values($1,$2,$3,'SYNTHETIC canonical company','Unternehmen','WEB_DESIGN')",[company,ws,project]);
  await db.admin.query("insert into contacts(id,workspace_id,project_id,organization_id,name,email,role,consent_label)values($1,$2,$3,$4,'SYNTHETIC buyer','commerce-buyer@example.invalid','Ansprechpartner','Opt-in')",[contact,ws,project,company]);
  const authIdentityId=(await db.admin.query('select auth_identity_id from workspace_users where id=$1',[ownerId])).rows[0].auth_identity_id;
  const sessionFor=async()=>{const id=randomUUID();await db.admin.query("insert into auth_sessions(id,token_hash,auth_identity_id,workspace_user_id,workspace_id,mfa_verified_at,expires_at)values($1,$2,$3,$4,$5,clock_timestamp(),clock_timestamp()+interval '1 hour')",[id,createHash('sha256').update(randomBytes(32)).digest('hex'),authIdentityId,ownerId,ws]);return id;};
  const sessionId=await sessionFor(),precreatedSecondSession=await sessionFor();
  let owner:AppSession={authenticated:true,source:'database',workspaceId:ws,userId:ownerId,workspaceName:'SYNTHETIC commerce',name:'SYNTHETIC owner',email:'commerce-owner@example.invalid',role:'owner',productRole:'novalure_operator',permissions:getRolePermissions('owner'),productPermissions:getProductRoleCapabilities('novalure_operator'),authIdentityId,authSessionId:sessionId};
  const foreign={...owner,workspaceId:otherWs,userId:foreignId,authIdentityId:undefined,authSessionId:undefined},options={pool:db.pool as unknown as TenantPool},future=new Date(Date.now()+86400000).toISOString(),past=new Date(Date.now()-60000).toISOString();
  const ireland=(operation:WebsiteSalesIrelandCommand['operation'],payload:Record<string,unknown>,fields:Partial<WebsiteSalesIrelandCommand>={})=>runWebsiteSalesIrelandCommand(owner,{contractVersion:websiteSalesIrelandContract,operation,projectId:project,companyId:company,idempotencyKey:randomUUID(),correlationId:randomUUID(),payload,...fields},options);
  const location=(await ireland('register_location',{countryCode:'IE',address:'1 SYNTHETIC Street, Dublin, Ireland',sourceUrl:'https://example.invalid/company',sourceReference:'SYNTHETIC owner location'})).data.location.id;
  const identity={workspaceId:ws,projectId:project,companyId:company,locationId:location};
  const prospect={identity,country:'IRELAND',identityStatus:'VERIFIED',path:'NO_WEBSITE',domain:null,ownWebsiteSearch:'NONE_FOUND',obstacle:null,platformUrl:null,bookingRoute:'UNKNOWN',need:'EVIDENCED',evidence:['IDENTITY','OWN_WEBSITE_SEARCH','BUSINESS_NEED'].map(kind=>({identity,kind,evidenceId:kind,sourceUrl:`https://example.invalid/${kind}`,observedAt:past,validUntil:future,finding:'SYNTHETIC source evidence',validityCondition:'SYNTHETIC evidence remains current',confidence:0.9}))};
  const observed=await ireland('observe',{prospect},{locationId:location,locationVersion:1});
  const qualified=await ireland('qualify',{contactId:contact,expectedEvidenceDigest:observed.data.workflow!.evidenceDigest,opportunitySummary:'SYNTHETIC scoped opportunity',nextAction:'Review exact commercial scope'},{locationId:location,expectedVersion:1});
  const prepared=await ireland('prepare_offer',{expectedEvidenceDigest:qualified.data.workflow!.evidenceDigest,content:{subject:'SYNTHETIC Website Offer',recipientName:'SYNTHETIC buyer',recipientEmail:'commerce-buyer@example.invalid',scope:'Three responsive information pages',paymentPlan:'Owner-approved deposit and balance schedule',discounts:'None',specialTerms:'SYNTHETIC isolated business contract test',riskComplianceNotes:'No real customer or provider',terms:'Final contract approval required',validUntil:future,currency:'EUR',taxBasis:'NET',items:[{description:'Website delivery',quantity:1,unitNetCents:600000}]}},{locationId:location,expectedVersion:qualified.data.workflow!.version});
  const wf=prepared.data.workflow!,scope={projectId:project,companyId:company,locationId:location,workflowId:wf.id};
  const offerRow=(await db.admin.query('select o.id,o.version,o.revision,r.content_digest as digest from crm_offers o join crm_offer_revisions r on r.offer_id=o.id and r.revision=o.revision where o.id=$1',[wf.offerDraftId])).rows[0];
  const offerRef={id:offerRow.id,version:Number(offerRow.revision),digest:offerRow.digest};
  const approved=await executeOfferCommand(owner,{operation:'approve',offerId:offerRow.id,projectId:project,expectedVersion:Number(offerRow.version),idempotencyKey:randomUUID(),correlationId:randomUUID(),payload:{expiresAt:future,contentDigest:offerRef.digest,revision:offerRef.version}},options);
  assert(approved.data);
  const source={reference:'operator-recorded:SYNTHETIC policy basis',digest:'a'.repeat(64),observedAt:past,validUntil:future};
  const installments=[{installmentId:randomUUID(),label:'Deposit',percentageBps:3000,dueOffsetDays:0,anchor:'CONTRACT_SIGNED',kind:'DEPOSIT'},{installmentId:randomUUID(),label:'Delivery balance',percentageBps:7000,dueOffsetDays:7,anchor:'DELIVERY_ACCEPTED',kind:'BALANCE'}];
  const template={title:'SYNTHETIC reviewed website agreement',jurisdiction:'Ireland',language:'en',content:'Agreement with {{CUSTOMER_EMAIL}}. Scope: {{SCOPE}}. Net: {{NET_EUR}} EUR; tax: {{TAX_EUR}} EUR. Issuer: {{ISSUER_LEGAL_NAME}}.',contentSha256:'',allowedVariableKeys:['CUSTOMER_EMAIL','SCOPE','NET_EUR','TAX_EUR','ISSUER_LEGAL_NAME'],legalReviewReference:source,validUntil:future};template.contentSha256=commerceContentSha256(template.content);
  const policy={title:'SYNTHETIC sourced commercial policy',standardTermsReference:source,standardTermsDigest:'b'.repeat(64),signatureAssurance:'PROVIDER_ATTESTED',maxInstallments:2,accountingEntityReference:'SYNTHETIC-ACCOUNT-1',accountingSourceReference:source,accountingProfile:{issuerLegalName:'SYNTHETIC Novalure entity',issuerAddress:'SYNTHETIC Dublin, Ireland',taxIdentifier:'SYNTHETIC VAT',currency:'EUR',taxRateBps:2300,rounding:'HALF_UP',sourceReference:source},offerRef,financialSnapshot:{currency:'EUR',netMinor:600000,taxMinor:138000,grossMinor:738000,taxReference:source,termsDigest:'b'.repeat(64)},paymentTerms:{installments},validUntil:future};
  const command=async(operation:Command['operation'],payload:Record<string,unknown>):Promise<Command>=>{const view=await read(owner,scope,options);return{contractVersion:websiteSalesCommerceContract,operation,...scope,expectedVersion:view.version,expectedWorkflowVersion:view.workflowVersion,idempotencyKey:randomUUID(),correlationId:randomUUID(),payload};};
  const run=async(operation:Command['operation'],payload:Record<string,unknown>)=>execute(owner,await command(operation,payload),options);
  let templateRef:{id:string;version:number;digest:string},policyRef:{id:string;version:number;digest:string};
  const workload=randomUUID(),effectGrant=randomUUID(),ingestGrant=randomUUID(),readGrant=randomUUID(),keyPair=generateKeyPairSync('ed25519');
  await db.admin.query(`insert into crm_website_sales_machine_workloads(id,identity_id,workspace_id,actor_user_id,issuer,audience,project_id,owner_id,subject,environment,authority_reference)values($1,'EVELYN_WEBSITE_SALES_INTERNAL_IDENTITY',$2,$3,$4,$5,$6,$7,$8,$9,'SYNTHETIC commerce executor')`,[workload,ws,agent,CRM_MACHINE_ISSUER,CRM_MACHINE_AUDIENCE,CRM_MACHINE_PROJECT_ID,CRM_MACHINE_OWNER_ID,CRM_MACHINE_SUBJECT,CRM_MACHINE_ENVIRONMENT]);
  const effects=['crm.website-sales.commerce.read','crm.website-sales.commerce.reconcile','crm.website-sales.commerce.queue-offer-delivery','crm.website-sales.commerce.queue-contract-delivery','crm.website-sales.commerce.request-signature','crm.website-sales.commerce.prepare-invoice-request','crm.website-sales.commerce.propose-renewal'];
  for(const[id,scopes]of[[effectGrant,effects],[ingestGrant,['crm.website-sales.commerce.read','crm.website-sales.commerce.ingest-source']],[readGrant,['crm.website-sales.commerce.read']]]as const)await db.admin.query(`insert into crm_website_sales_machine_grants(id,workload_id,workspace_id,actor_user_id,project_id,company_id,location_id,department_id,agent_id,task_id,authority_reference,delegation_public_key,scopes,not_before,expires_at)values($1,$2,$3,$4,$5,$6,$7,'SALES','evelyn.sales.commerce-test',$8,'SYNTHETIC commerce executor',$9,$10,clock_timestamp(),$11)`,[id,workload,ws,agent,project,company,location,randomUUID(),keyPair.publicKey.export({format:'der',type:'spki'}).toString('base64url'),scopes,future]);
  await db.admin.query('create role commerce_private_executor login inherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls');await db.admin.query('grant novalure_website_sales_commerce_executor to commerce_private_executor');
  executorPool=new Pool({host:'127.0.0.1',port:db.port,user:'commerce_private_executor',database:'postgres',max:4});
  const binding:CommerceExecutionBinding={...scope,workspaceId:ws,actorId:agent,workloadId:workload,grantId:effectGrant,allowedKinds:['OFFER_SEND','CONTRACT_SEND','SIGNATURE_REQUEST','ACCOUNTING_INVOICE_REQUEST','SUBSCRIPTION_CHANGE'],expiresAt:Date.parse(future),authorityReference:'SYNTHETIC commerce executor'};
  const executor=createWebsiteSalesCommerceExecutor({pool:executorPool as unknown as TenantPool,assertCurrent:async()=>binding}),sourceExecutor=createWebsiteSalesCommerceExecutor({pool:executorPool as unknown as TenantPool,assertCurrent:async()=>({...binding,grantId:ingestGrant})}),readExecutor=createWebsiteSalesCommerceExecutor({pool:executorPool as unknown as TenantPool,assertCurrent:async()=>({...binding,grantId:readGrant})});
  let signedEvent:Event,invoiceEvent:Event,paymentEvent:Event,invoiceJobId='';let offerJobId='',contractRef:{id:string;version:number;digest:string},approvalId='',signatureJobId='';
  const sourceEvent=(kind:Event['kind'],payload:Record<string,unknown>,system:Event['source']['system'],resourceId:string=randomUUID(),version=1):Event=>({contractVersion:'website-sales-commerce-source-v1',eventId:randomUUID(),identity,workflowId:wf.id,source:{system,provider:'SYNTHETIC_ISOLATED_SOURCE',accountReference:system==='ACCOUNTING'?'SYNTHETIC-ACCOUNT-1':'SYNTHETIC-PRIVATE-ACCOUNT',resourceType:kind,resourceId,version,digest:commerceDigest(payload)},occurredAt:new Date().toISOString(),retrievedAt:new Date().toISOString(),verificationReceiptReference:'SYNTHETIC isolated host verifier; not provider proof',confidence:'PROVIDER_VERIFIED',supersedesEventId:null,kind,payload}as Event);
  const ingest=async(event:Event,jobId:string,cap=sourceExecutor)=>ingestVerifiedWebsiteSalesCommerceSource(cap,await verifyWebsiteSalesCommerceSource(event,async()=>({event,jobId})));
  await t.test('canonical choices exist before a financial policy and owner facts preserve exact replay/CAS and tenant boundaries',async()=>{
   const view=await read(owner,scope,options);assert.equal(view.offerChoices[0]!.totalNetMinor,600000);assert.equal(view.offers.length,0);assert.equal(view.policy,null);
   const c=await command('register_template',template),saved=await execute(owner,c,options);templateRef={id:saved.data.recordId!,version:1,digest:saved.data.recordDigest!};assert.equal((await execute(owner,c,options)).commandId,saved.commandId);
   await assert.rejects(execute(owner,{...c,payload:{...template,title:'Different title'}},options),{code:'IDEMPOTENCY_CONFLICT'});
   await assert.rejects(execute(owner,{...c,idempotencyKey:randomUUID()},options),{code:'COMMERCE_VERSION_CONFLICT'});
   const wrong=await command('configure_policy',policy);await assert.rejects(execute(owner,{...wrong,expectedWorkflowVersion:wf.version-1},options),{code:'COMMERCE_WORKFLOW_VERSION_CONFLICT'});
   const p=await run('configure_policy',policy);policyRef={id:p.data.recordId!,version:1,digest:p.data.recordDigest!};assert.equal((await read(owner,scope,options)).offers[0]!.payload.financial.taxMinor,138000);
   await assert.rejects(read(foreign,scope,options));assert.equal((await withCrmRead(foreign,tx=>tx.query('select id from crm_website_sales_commerce_records where workspace_id=$1',[ws]),options)).length,0);
   await assert.rejects(withCrmRead(owner,tx=>tx.execute("insert into crm_website_sales_commerce_sources(id,workspace_id)values($1,$2)",[randomUUID(),ws]),options),{code:'42501'});
  });
  await t.test('actual commerce route requires a current persisted MFA session and preserves CSRF before business writes',async()=>{
   const origin='http://127.0.0.1:3061',cookie='v2.'+randomBytes(32).toString('base64url');Object.assign(process.env,{NOVALURE_SESSION_SECRET:randomBytes(48).toString('base64url'),NOVALURE_APP_ORIGIN:origin,NOVALURE_AUTH_STRICT:'1',NOVALURE_AUTH_ENCRYPTION_KEY:randomBytes(40).toString('hex'),NOVALURE_AUTH_RATE_LIMIT_SECRET:randomBytes(40).toString('hex')});
   await db.admin.query("update auth_identities set credential_state='active' where id=$1",[authIdentityId]);await db.admin.query("insert into auth_sessions(id,token_hash,auth_identity_id,workspace_user_id,workspace_id,mfa_verified_at,expires_at)values($1,$2,$3,$4,$5,clock_timestamp(),clock_timestamp()+interval '1 hour')",[randomUUID(),createHash('sha256').update(cookie).digest('hex'),authIdentityId,ownerId,ws]);await db.admin.query(`grant select on auth_identities to ${db.role}`);await db.admin.query(`grant update(last_seen_at) on auth_sessions to ${db.role}`);
   const url=origin+'/api/crm/website-sales/commerce?'+new URLSearchParams(scope),headers={cookie:'novalure_session='+cookie};assert.equal((await GET(new Request(url))).status,401);const response=await GET(new Request(url,{headers}));assert.equal(response.status,200,await response.clone().text());assert.equal((await response.json()).identity.companyId,company);
   const count=(await db.admin.query('select count(*)::int n from crm_website_sales_commerce_records')).rows[0].n;
   assert.equal((await POST(new Request(url.split('?')[0],{method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify(await command('register_template',template))}))).status,403);
   assert.equal((await db.admin.query('select count(*)::int n from crm_website_sales_commerce_records')).rows[0].n,count);
  });
  await t.test('a separate exact executor dispatches the full approved payload and UNKNOWN fences legacy manual actions',async()=>{
   const current=(await read(owner,scope,options)).offerChoices.find(o=>o.offerRef.id===offerRef.id)!;assert.equal(current.status,'APPROVED');
   const approvalReference=(await db.admin.query('select approval_id from crm_offers where id=$1',[offerRef.id])).rows[0].approval_id;
   const queued=await run('queue_offer_delivery',{offerRef,approvalReference});offerJobId=queued.data.outboxId!;
   const claimed=await claimWebsiteSalesCommerceJob(executor,offerJobId);assert(claimed?.leaseToken);assert.equal(claimed.payload.documentRef&&commerceDigest(claimed.payload.documentRef),commerceDigest(offerRef));
   const native=(await db.admin.query('select version from crm_offers where id=$1',[offerRef.id])).rows[0];
   await assert.rejects(executeOfferCommand(owner,{operation:'record_sent',offerId:offerRef.id,projectId:project,expectedVersion:Number(native.version),idempotencyKey:randomUUID(),correlationId:randomUUID(),payload:{reference:'Attempted manual overwrite',recipientEmail:'commerce-buyer@example.invalid',contentDigest:offerRef.digest,revision:offerRef.version,sentAt:new Date().toISOString()}},options),{code:'COMMERCE_DELIVERY_OUTCOME_UNKNOWN'});
   let signal!:()=>void,release!:()=>void;const admitted=new Promise<void>(resolve=>signal=resolve),gate=new Promise<void>(resolve=>release=resolve);let calls=0;const pending=dispatchWebsiteSalesCommerceJob(executor,{jobId:offerJobId,leaseToken:claimed.leaseToken,payloadDigest:claimed.payloadDigest},async frozen=>{calls++;signal();await gate;assert(Object.isFrozen(frozen.payload));assert(String(frozen.payload.text).includes('6000.00 EUR net'));return{outcome:'ACCEPTED',providerReference:'SYNTHETIC-message-1',receiptDigest:'c'.repeat(64)};});await admitted;let suppressionCommitted=false;const suppression=db.admin.query("update contacts set consent_label='Abgemeldet',version=version+1 where id=$1",[contact]).then(()=>suppressionCommitted=true);await new Promise(resolve=>setTimeout(resolve,50));assert.equal(suppressionCommitted,false);release();const delivered=await pending;await suppression;assert.equal(calls,1);assert.equal(delivered.status,'ACCEPTED');await db.admin.query("update contacts set consent_label='Opt-in',version=version+1 where id=$1",[contact]); // Explicit isolated fixture reset after proving ordered opt-out commit.
   await assert.rejects(ingestVerifiedWebsiteSalesCommerceSource(sourceExecutor,{}as never),{code:'COMMERCE_VERIFIED_SOURCE_REQUIRED'});
   const event=sourceEvent('PROVIDER_DELIVERY',{outboxId:offerJobId,documentKind:'OFFER',documentRef:offerRef,documentSha256:claimed.payload.documentSha256,recipientDigest:claimed.payload.recipientDigest,providerMessageId:'SYNTHETIC-message-1',status:'DELIVERED'},'DELIVERY_PROVIDER');
   await assert.rejects(ingest(event,offerJobId,readExecutor),{code:'COMMERCE_INGEST_SOURCE_SCOPE_REQUIRED'});
   await ingest(event,offerJobId);assert.equal((await db.admin.query('select status from crm_offers where id=$1',[offerRef.id])).rows[0].status,'SENT');
   const repeated={...event,retrievedAt:new Date().toISOString(),verificationReceiptReference:'SYNTHETIC later read observation'};assert.equal((await ingest(repeated,offerJobId)).status,'DUPLICATE');assert.equal((await db.admin.query('select count(*)::int n from crm_website_sales_commerce_sources')).rows[0].n,1);
   assert.equal((await reconcile(owner,await command('prepare_contract',{offerRef,templateRef,policyRef}),options)).status,'NOT_FOUND');
  });
  await t.test('native contract approval requires later fresh MFA for the second distinct decision',async()=>{
   const created=await run('prepare_contract',{offerRef,templateRef,policyRef});contractRef={id:created.data.recordId!,version:1,digest:created.data.recordDigest!};
   await run('request_contract_approval',{documentRef:contractRef});let view=await read(owner,scope,options),approval=view.approvals[0]!;approvalId=approval.approvalId;assert.equal(approval.requiredSteps,2);assert(approval.currentChallenge);
   await run('approve_contract_step',{approvalId,documentRef:contractRef,challengeId:approval.currentChallenge.challengeId,stepNumber:1});
   owner={...owner,authSessionId:precreatedSecondSession};await assert.rejects(run('request_contract_approval',{documentRef:contractRef}),{code:'INDEPENDENT_FRESH_AUTHENTICATION_REQUIRED'});
   owner={...owner,authSessionId:await sessionFor()};await run('request_contract_approval',{documentRef:contractRef});view=await read(owner,scope,options);approval=view.approvals.find(a=>a.approvalId===approvalId)!;assert.equal(approval.currentChallenge!.stepNumber,2);
   await run('approve_contract_step',{approvalId,documentRef:contractRef,challengeId:approval.currentChallenge!.challengeId,stepNumber:2});assert.equal((await read(owner,scope,options)).approvals.find(a=>a.approvalId===approvalId)!.status,'APPROVED');
   const queued=await run('request_signature',{documentRef:contractRef,approvalReference:approvalId});signatureJobId=queued.data.outboxId!;assert.equal((await readWebsiteSalesCommerceJob(executor,signatureJobId)).payload.requiredAssurance,'PROVIDER_ATTESTED');
  });

  await t.test('verified exact signature closes the unchanged canonical offer and enables deposit before delivery',async()=>{
   const claimed=await claimWebsiteSalesCommerceJob(executor,signatureJobId);assert(claimed?.leaseToken);
   await dispatchWebsiteSalesCommerceJob(executor,{jobId:signatureJobId,leaseToken:claimed.leaseToken,payloadDigest:claimed.payloadDigest},async()=>({outcome:'ACCEPTED',providerReference:'SYNTHETIC-envelope-1',receiptDigest:'d'.repeat(64)}));
   const doc=(await read(owner,scope,options)).contracts.find(c=>c.id===contractRef.id)!;
   const payload={contractRef,documentSha256:doc.payload.documentSha256,envelopeId:'SYNTHETIC-envelope-1',status:'SIGNED',assurance:'PROVIDER_ATTESTED',signatoryReference:`recipient:${commerceDigest(doc.payload.recipientEmail.toLowerCase())}`,signedAt:new Date().toISOString(),providerSignedDocumentDigests:['e'.repeat(64)],providerAuditProofDigests:['f'.repeat(64)]};
   const {providerAuditProofDigests:omittedAudit,...withoutAudit}=payload;assert(omittedAudit);const unsigned=sourceEvent('SIGNATURE',withoutAudit,'SIGNATURE_PROVIDER','SYNTHETIC-envelope-1');await assert.rejects(ingest(unsigned,signatureJobId),{code:'COMMERCE_SIGNED_DOCUMENT_PROOF_REQUIRED'});
   signedEvent=sourceEvent('SIGNATURE',payload,'SIGNATURE_PROVIDER','SYNTHETIC-envelope-1');await ingest(signedEvent,signatureJobId);
   assert.equal((await db.admin.query('select status from crm_offers where id=$1',[offerRef.id])).rows[0].status,'ACCEPTED');
   assert.equal((await db.admin.query('select stage from deals where id=$1',[wf.dealId])).rows[0].stage,'Gewonnen');
   await assert.rejects(run('prepare_invoice_request',{contractRef,policyRef,deliveryAcceptanceRef:null,stage:'DEPOSIT',installmentIds:[installments[0]!.installmentId]}),{code:'COMMERCE_ACCOUNTING_CUSTOMER_REFERENCE_REQUIRED'});
   const mapped=await run('configure_policy',{...policy,accountingCustomerReference:'SYNTHETIC-customer-1'});policyRef={id:mapped.data.recordId!,version:2,digest:mapped.data.recordDigest!};
   const invoice=await run('prepare_invoice_request',{contractRef,policyRef,deliveryAcceptanceRef:null,stage:'DEPOSIT',installmentIds:[installments[0]!.installmentId]});invoiceJobId=invoice.data.outboxId!;
   const view=await read(owner,scope,options),request=view.invoiceRequests.find(r=>r.id===invoice.data.recordId)!;
   assert.equal(request.payload.financial.grossMinor,221400);assert.equal(request.payload.customerReference,'SYNTHETIC-customer-1');
   await assert.rejects(run('prepare_invoice_request',{contractRef,policyRef,deliveryAcceptanceRef:null,stage:'BALANCE',installmentIds:[installments[1]!.installmentId]}),{code:'COMMERCE_APPLICABLE_CUSTOMER_ACCEPTANCE_REQUIRED'});
   await assert.rejects(run('prepare_invoice_request',{contractRef,policyRef,deliveryAcceptanceRef:null,stage:'DEPOSIT',installmentIds:[installments[0]!.installmentId]}));
   const j=await claimWebsiteSalesCommerceJob(executor,invoiceJobId);assert(j?.leaseToken);await dispatchWebsiteSalesCommerceJob(executor,{jobId:j.id,leaseToken:j.leaseToken,payloadDigest:j.payloadDigest},async()=>({outcome:'ACCEPTED',providerReference:'SYNTHETIC-invoice-request-1',receiptDigest:'1'.repeat(64)}));
   const ip={invoiceRequestId:request.id,contractRef,customerReference:request.payload.customerReference,financial:request.payload.financial,installments:request.payload.installments,status:'ISSUED',invoiceNumber:'SYNTHETIC-INV-1'};
   await assert.rejects(ingest(sourceEvent('INVOICE',{...ip,customerReference:'FOREIGN-CUSTOMER'},'ACCOUNTING'),invoiceJobId),{code:'COMMERCE_ACCOUNTING_REQUEST_MISMATCH'});
   invoiceEvent=sourceEvent('INVOICE',ip,'ACCOUNTING','SYNTHETIC-INV-1');await ingest(invoiceEvent,invoiceJobId);
  });
  await t.test('manual delivery notes cannot authorize balance until exact customer-source proof and canonical DONE task',async()=>{
   // Minimal canonical boundary fixtures only; no provider, rendered QA or real delivery is claimed.
   const artifacts:string[]=[];for(const kind of ['CONCEPT','DEMO']){const id=randomUUID(),digest=commerceDigest({id,kind,fixture:'isolated commerce delivery'});artifacts.push(id);await db.admin.query(`insert into crm_website_studio_artifacts(id,workspace_id,project_id,company_id,location_id,workflow_id,kind,version,artifact_digest,evidence_digest,artifact,created_by,valid_until)values($1,$2,$3,$4,$5,$6,$7,1,$8,$9,$10::jsonb,$11,$12)`,[id,ws,project,company,location,wf.id,kind,digest,wf.evidenceDigest,JSON.stringify({kind,fixture:'No QA or external delivery claim'}),ownerId,future]);}
   const acceptance=randomUUID(),task=randomUUID();await db.admin.query(`insert into crm_website_sales_customer_acceptances(id,workspace_id,project_id,company_id,location_id,workflow_id,concept_artifact_id,demo_artifact_id,concept_digest,demo_digest,evidence_digest,source_reference,acceptance_digest,scope,version,accepted_by)values($1,$2,$3,$4,$5,$6,$7,$8,$9,$9,$10,'SYNTHETIC owner-recorded boundary fixture',$9,'{}',1,$11)`,[acceptance,ws,project,company,location,wf.id,artifacts[0],artifacts[1],'b'.repeat(64),wf.evidenceDigest,ownerId]);
   await db.admin.query("insert into tasks(id,workspace_id,project_id,contact_id,lead_id,owner_user_id,title,status,priority,metadata)values($1,$2,$3,$4,$5,$6,'SYNTHETIC canonical PM delivery task','done','Normal',$7::jsonb)",[task,ws,project,contact,wf.leadId,ownerId,JSON.stringify({websiteSalesWorkflowId:wf.id})]);
   await db.admin.query(`insert into crm_website_sales_handoffs(id,workspace_id,project_id,company_id,location_id,workflow_id,customer_acceptance_id,task_id,snapshot,snapshot_digest,created_by)values($1,$2,$3,$4,$5,$6,$7,$8,'{}',$9,$10)`,[randomUUID(),ws,project,company,location,wf.id,acceptance,task,'c'.repeat(64),ownerId]);
   const payload={contractRef,canonicalDeliveryTaskId:task,expectedDeliveryTaskVersion:1,scopeDigest:commerceDigest('Three responsive information pages'),sourceReference:source,acceptedAt:new Date().toISOString()};
   const manual=await run('record_delivery_acceptance',payload),manualRef={id:manual.data.recordId!,version:1,digest:manual.data.recordDigest!};
   await assert.rejects(run('prepare_invoice_request',{contractRef,policyRef,deliveryAcceptanceRef:manualRef,stage:'BALANCE',installmentIds:[installments[1]!.installmentId]}),{code:'COMMERCE_VERIFIED_CUSTOMER_ACCEPTANCE_REQUIRED'});
   await assert.rejects(ingest(sourceEvent('DELIVERY_ACCEPTANCE',{...payload,expectedDeliveryTaskVersion:2},'SERVICE_AUTHORITY'),signatureJobId),{code:'COMMERCE_CANONICAL_DELIVERY_REQUIRED'});
   await ingest(sourceEvent('DELIVERY_ACCEPTANCE',payload,'SERVICE_AUTHORITY'),signatureJobId);
   const actual=(await read(owner,scope,options)).deliveryAcceptances[0]!;const result=await run('prepare_invoice_request',{contractRef,policyRef,deliveryAcceptanceRef:{id:actual.id,version:actual.version,digest:actual.digest},stage:'BALANCE',installmentIds:[installments[1]!.installmentId]});assert(result.data.outboxId);
   const request=(await read(owner,scope,options)).invoiceRequests.find(r=>r.id===result.data.recordId)!;assert.equal(request.payload.financial.grossMinor,516600);
  });
  await t.test('partial accounting payments, refunds and immutable reversals conserve current outstanding',async()=>{
   const allocation={invoiceSourceEventId:invoiceEvent.eventId,installmentId:installments[0]!.installmentId,amountMinor:100000};
   paymentEvent=sourceEvent('PAYMENT',{currency:'EUR',amountMinor:100000,status:'SETTLED',kind:'DEPOSIT',allocations:[allocation]},'ACCOUNTING','SYNTHETIC-PAY-1');await ingest(paymentEvent,invoiceJobId);
   let assessment=(await read(owner,scope,options)).financialAssessment!;assert(assessment.value);assert.equal(assessment.value.invoices[0]!.outstandingMinor,121400);
   const refund=sourceEvent('REFUND',{paymentSourceEventId:paymentEvent.eventId,currency:'EUR',amountMinor:25000,status:'SETTLED',allocations:[{...allocation,amountMinor:25000}]},'ACCOUNTING','SYNTHETIC-REFUND-1');await ingest(refund,invoiceJobId);
   assessment=(await read(owner,scope,options)).financialAssessment!;assert.equal(assessment.value!.invoices[0]!.outstandingMinor,146400);
   const reversal=sourceEvent('REVERSAL',{reversesEventId:refund.eventId,reversedEventDigest:commerceSourceFactDigest(refund),reason:'SYNTHETIC actual refund reversal'},'ACCOUNTING','SYNTHETIC-REVERSAL-1');await ingest(reversal,invoiceJobId);
   assessment=(await read(owner,scope,options)).financialAssessment!;assert.equal(assessment.value!.invoices[0]!.outstandingMinor,121400);
   assert.equal((await db.admin.query("select count(*)::int n from crm_website_sales_commerce_allocations where kind='REVERSAL'")).rows[0].n,1);
   const forged=sourceEvent('PAYMENT',{currency:'EUR',amountMinor:900000,status:'SETTLED',kind:'PAYMENT',allocations:[{...allocation,amountMinor:900000}]},'CRM');await assert.rejects(ingest(forged,invoiceJobId));
  });
  await t.test('linked Care offers use the same canonical workflow and require a full finite catalog obligation',async()=>{
   const enable=async(operation:WebsiteSalesEnablementCommand['operation'],payload:Record<string,unknown>)=>{const current=await readWebsiteSalesEnablement(owner,{projectId:project,companyId:company,locationId:location},options);return executeWebsiteSalesEnablementCommand(owner,{contractVersion:'website-sales-enablement-v1',operation,projectId:project,companyId:company,locationId:location,expectedVersion:current.aggregateVersion,expectedWorkflowVersion:current.workflow!.version,idempotencyKey:randomUUID(),correlationId:randomUUID(),payload},options);};
   const task=(await read(owner,scope,options)).eligibleDeliveryTasks[0]!.taskRef;
   const basis=await enable('record_care_basis',{need:'SYNTHETIC owner-recorded ongoing website maintenance',sourceReferences:[{...source,basis:'OPERATOR_ATTESTATION'}],canonicalDeliveryTaskId:task.id,planKeys:['MANAGED'],validUntil:future});
   const proposal=await enable('propose_care',{planKey:'MANAGED',basisId:basis.data.recordId,basisDigest:basis.data.recordDigest});
   const care=await enable('prepare_care_offer',{careProposalId:proposal.data.recordId,careProposalDigest:proposal.data.recordDigest,expectedDeliveryTaskVersion:task.version});
   const id=String(care.data.offerId),current=(await read(owner,scope,options)).offerChoices.find(o=>o.offerRef.id===id)!;assert(current);assert.equal(current.totalNetMinor,3900);
   const carePolicy={...policy,offerRef:current.offerRef,financialSnapshot:{...policy.financialSnapshot,netMinor:3900,taxMinor:897,grossMinor:4797}};
   await assert.rejects(run('configure_policy',carePolicy),{code:'CARE_FINITE_FULL_CONTRACT_TERM_REQUIRED'});
   const native=(await db.admin.query('select o.version,r.content from crm_offers o join crm_offer_revisions r on r.offer_id=o.id and r.revision=o.revision where o.id=$1',[id])).rows[0];
   await executeOfferCommand(owner,{operation:'revise',offerId:id,projectId:project,expectedVersion:Number(native.version),idempotencyKey:randomUUID(),correlationId:randomUUID(),payload:{content:{...native.content,items:[{description:'Explicit owner-recorded finite12month MANAGED obligation',quantity:1,unitNetCents:46800}]}}},options);
   const revised=(await read(owner,scope,options)).offerChoices.find(o=>o.offerRef.id===id)!;assert.equal(revised.totalNetMinor,46800);
   const year=new Date().getUTCFullYear()+1,term={startAt:`${year}-01-31T09:30:00.000Z`,endAt:`${year+1}-01-31T09:30:00.000Z`,fullNetMinor:46800,sourceReference:source};
   const configured=await run('configure_policy',{...carePolicy,offerRef:revised.offerRef,financialSnapshot:{...policy.financialSnapshot,netMinor:46800,taxMinor:10764,grossMinor:57564},contractTerm:term});assert(configured.data.recordId);
   await assert.rejects(run('configure_policy',{...carePolicy,offerRef:revised.offerRef,financialSnapshot:{...policy.financialSnapshot,netMinor:46800,taxMinor:10764,grossMinor:57564},contractTerm:{...term,startAt:`${year}-02-01T09:30:00.000Z`}}),{code:'CARE_FINITE_COMPLETE_MONTH_TERM_REQUIRED'});
  });
  await t.test('only current actual service source supports month13 renewal and negative signature cannot fall back',async()=>{
   const start=new Date();start.setUTCFullYear(start.getUTCFullYear()-1);start.setUTCMonth(start.getUTCMonth()-1);const end=new Date();end.setUTCMonth(end.getUTCMonth()+1);
   const terms={contractRef,planKey:'MANAGED',originalServiceStartAt:start.toISOString(),periodStartAt:new Date(Date.now()-86400000).toISOString(),periodEndAt:end.toISOString(),renewalAt:end.toISOString(),cancellationEffectiveAt:null,currency:'EUR',termsDigest:'7'.repeat(64),sourceReference:source};
   await run('record_subscription_terms',terms);let view=await read(owner,scope,options);let sub=view.subscriptions[0]!;
   await assert.rejects(run('propose_renewal',{subscriptionRef:{id:sub.id,version:sub.version,digest:sub.digest}}));
   const active=sourceEvent('SUBSCRIPTION',{...terms,status:'ACTIVE',canonicalSourceEventId:null},'SERVICE_AUTHORITY','SYNTHETIC-service-1');await ingest(active,signatureJobId);view=await read(owner,scope,options);sub=view.subscriptions[0]!;
   const renewal=await run('propose_renewal',{subscriptionRef:{id:sub.id,version:sub.version,digest:sub.digest}});assert(renewal.data.recordId);
   const stored=(await db.admin.query("select payload from crm_website_sales_commerce_records where kind='RENEWAL_PROPOSAL' order by created_at desc limit 1")).rows[0].payload;assert.equal(stored.amountMinor,9900);
   const cancelled=sourceEvent('SUBSCRIPTION',{...terms,status:'CANCELLED',canonicalSourceEventId:null},'SERVICE_AUTHORITY','SYNTHETIC-service-1',2);await ingest(cancelled,signatureJobId);sub=(await read(owner,scope,options)).subscriptions[0]!;
   await assert.rejects(run('propose_renewal',{subscriptionRef:{id:sub.id,version:sub.version,digest:sub.digest}}));
   const archived=sourceEvent('SIGNATURE',{...(signedEvent as Extract<Event,{kind:'SIGNATURE'}>).payload,status:'SOURCE_UNAVAILABLE',providerArchivedAt:new Date().toISOString()},'SIGNATURE_PROVIDER','SYNTHETIC-envelope-1',2);await ingest(archived,signatureJobId);
   view=await read(owner,scope,options);assert.equal(view.sourceAssessment.activeEventIds.includes(signedEvent.eventId),false);assert.equal((await db.admin.query('select status from crm_offers where id=$1',[offerRef.id])).rows[0].status,'ACCEPTED');
   await assert.rejects(run('prepare_invoice_request',{contractRef,policyRef,deliveryAcceptanceRef:null,stage:'DEPOSIT',installmentIds:[installments[0]!.installmentId]}));
  });
  await t.test('revocation cancels future requests without erasing already accepted or unknown provider facts',async()=>{
   const q=await run('queue_contract_delivery',{documentRef:contractRef,approvalReference:approvalId});const job=await claimWebsiteSalesCommerceJob(executor,q.data.outboxId!);assert(job?.leaseToken);
   await dispatchWebsiteSalesCommerceJob(executor,{jobId:job.id,leaseToken:job.leaseToken,payloadDigest:job.payloadDigest},async()=>({outcome:'UNKNOWN',errorCode:'SYNTHETIC_RESPONSE_LOST'}));
   assert.equal((await readWebsiteSalesCommerceJob(executor,job.id)).status,'UNKNOWN');
   assert.equal((await read(owner,scope,options)).actionEligibility.find(v=>v.operation==='revoke_contract_approval')!.eligible,true);
   await run('revoke_contract_approval',{approvalId,documentRef:contractRef,reason:'SYNTHETIC revoke future authority despite earlier accepted signature request'});
   assert.equal((await readWebsiteSalesCommerceJob(executor,job.id)).status,'UNKNOWN');assert.equal((await readWebsiteSalesCommerceJob(executor,signatureJobId)).status,'ACCEPTED');
   await assert.rejects(run('request_signature',{documentRef:contractRef,approvalReference:approvalId}),{code:'COMMERCE_CONTRACT_APPROVAL_REQUIRED'});
  });

 }finally{await executorPool?.end();await closeLocalTestPool();for(const key of keys)if(before[key]===undefined)delete process.env[key];else process.env[key]=before[key];await db.stop();}
});
