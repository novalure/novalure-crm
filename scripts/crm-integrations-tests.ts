import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {before,after,test} from 'node:test';
import type {AppSession} from '../src/lib/auth/session';
import type {TenantPool} from '../src/lib/db/tenant-client';
import {withCrmRead} from '../src/lib/crm-command';
import {readCrmIntegrations,disconnectCrmCalendar,createCrmTrainingIntegration,changeCrmWebsiteStatus,checkCrmIntegration} from '../src/lib/db/crm-integrations-repository';
import {integrationConfiguration} from '../src/lib/crm-integrations-configuration';
import {startLocalSalesDb,applySalesSchema} from './lib/local-sales-db.mjs';
let db:Awaited<ReturnType<typeof startLocalSalesDb>>;
const w=randomUUID(),foreignW=randomUUID(),owner=randomUUID(),agent=randomUUID(),foreignOwner=randomUUID(),project=randomUUID(),foreignProject=randomUUID(),form=randomUUID(),foreignForm=randomUUID();
const configuration=()=>({google:true,microsoft:false,resend:true,resendWebhook:false});
const options=()=>({pool:db.pool as unknown as TenantPool,configuration});
const meta=()=>({idempotencyKey:randomUUID(),correlationId:randomUUID()});
function session(actor=owner):AppSession{return{authenticated:true,userId:actor,workspaceId:w,workspaceName:'SYNTHETIC Integrations',name:'SYNTHETIC actor',email:'actor@example.invalid',role:'owner',productRole:'customer_owner',permissions:[],productPermissions:[],source:'database'};}
before(async()=>{
 db=await startLocalSalesDb();await applySalesSchema(db,{maxMigrationNumber:106});
 await db.admin.query("insert into novalure_schema_migrations(version,name,checksum) values('094_website_sales_ingestion','094_website_sales_ingestion.sql','SYNTHETIC prerequisite')");
 await db.admin.query(await readFile('migrations/095_form_tenant_isolation.sql','utf8'));await db.admin.query("insert into novalure_schema_migrations(version,name,checksum) values('095_form_tenant_isolation','095_form_tenant_isolation.sql','SYNTHETIC prerequisite')");for(const name of ['096_public_integration_gateway.sql','154_automation_graph.sql','157_newsletter_workspace.sql','165_automation_mail.sql','168_crm_integrations.sql'])await db.admin.query(await readFile('migrations/'+name,'utf8'));
 await db.admin.query("insert into workspaces(id,name,operating_model) values($1,'SYNTHETIC Integrations','self_service_customer'),($2,'SYNTHETIC Foreign','self_service_customer')",[w,foreignW]);
 await db.admin.query("insert into workspace_users(id,workspace_id,name,email,role,product_role,status) values($1,$4,'SYNTHETIC Owner','owner@example.invalid','owner','customer_owner','active'),($2,$4,'SYNTHETIC Agent','agent@example.invalid','agent','project_sales_member','active'),($3,$5,'SYNTHETIC Foreign','foreign@example.invalid','owner','customer_owner','active')",[owner,agent,foreignOwner,w,foreignW]);
 await db.admin.query("insert into projects(id,workspace_id,name,type) values($1,$2,'SYNTHETIC Project','Service'),($3,$4,'SYNTHETIC Foreign','Service')",[project,w,foreignProject,foreignW]);
 for(const [id,workspace,scope,actor] of [[form,w,project,owner],[foreignForm,foreignW,foreignProject,foreignOwner]])await db.admin.query("insert into forms(id,workspace_id,project_id,owner_user_id,name,slug,status,fields) values($1,$2,$3,$4,'SYNTHETIC Form',$5,'aktiv','[]')",[id,workspace,scope,actor,'synthetic-'+id]);
 await db.admin.query("insert into provider_connections(workspace_id,provider,status,account_label,config,scopes,error) values($1,'google-calendar','connected','SYNTHETIC Google','{\"accessToken\":\"MUST_NOT_LEAK_TOKEN\",\"refreshToken\":\"MUST_NOT_LEAK_REFRESH\"}','{calendar.read}','MUST_NOT_LEAK_PROVIDER_ERROR'),($2,'google-calendar','connected','FOREIGN ACCOUNT','{\"accessToken\":\"FOREIGN_SECRET\"}','{calendar.read}',null)",[w,foreignW]);
});
after(async()=>{if(db)await db.stop();});
test('configuration exposes only readiness booleans; manager reads are scoped and redact credentials/errors',async()=>{
 const result=await readCrmIntegrations(session(),project,options());assert.equal(result.gatewayInstalled,true);assert.equal(result.calendars[0].connected,true);assert.equal(result.calendars[0].accountLabel,'SYNTHETIC Google');assert.doesNotMatch(JSON.stringify(result),/MUST_NOT_LEAK|FOREIGN_SECRET|FOREIGN ACCOUNT/);assert.deepEqual(result.configuration,configuration());
 const flags=integrationConfiguration({NODE_ENV:'test',GOOGLE_CLIENT_ID:'SYNTHETIC',GOOGLE_CLIENT_SECRET:'SECRET',OAUTH_TOKEN_ENCRYPTION_KEY:'SECRET',OAUTH_STATE_SECRET:'x'.repeat(32),RESEND_API_KEY:'SECRET'});assert.equal(flags.google,true);assert.equal(flags.resend,true);assert.equal(flags.resendWebhook,false);assert.ok(Object.values(flags).every(value=>typeof value==='boolean'));
 await assert.rejects(readCrmIntegrations(session(agent),project,options()),/Verwaltung/);await assert.rejects(readCrmIntegrations(session(),foreignProject,options()));
});
test('calendar disconnect clears only the selected workspace stored credential and remains auditable/idempotent',async()=>{
 const metadata=meta(),first=await disconnectCrmCalendar(session(),{provider:'google'},metadata,options());assert.equal(first.data.changed,true);assert.equal(first.data.remoteRevocation,false);assert.equal((await disconnectCrmCalendar(session(),{provider:'google'},metadata,options())).replayed,true);
 const rows=(await db.admin.query('select workspace_id,status,config,scopes,error from provider_connections order by workspace_id')).rows;const own=rows.find(row=>row.workspace_id===w),foreign=rows.find(row=>row.workspace_id===foreignW);assert.deepEqual(own.config,{});assert.deepEqual(own.scopes,[]);assert.equal(own.error,null);assert.equal(own.status,'disconnected');assert.equal(foreign.config.accessToken,'FOREIGN_SECRET');assert.equal(foreign.status,'connected');
 assert.equal((await readCrmIntegrations(session(),project,options())).calendars[0].status,'disconnected');
 assert.equal((await db.admin.query('select action from audit_logs where id=$1',[first.auditReference])).rows[0].action,'crm.integration.calendar.disconnect');await assert.rejects(disconnectCrmCalendar(session(agent),{provider:'google'},meta(),options()));
});
test('new form connections use the existing origin-bound training model and never create a universal credential',async()=>{
 const input={formId:form,origin:'https://synthetic.example.invalid'},metadata=meta(),created=await createCrmTrainingIntegration(session(),input,metadata,options());assert.equal(created.data.mode,'training');assert.equal(created.data.status,'test');assert.equal((await createCrmTrainingIntegration(session(),input,metadata,options())).data.id,created.data.id);
 const source=await readCrmIntegrations(session(),project,options()),row=source.websites.find(item=>item.id===created.data.id)!;assert.deepEqual(row.capabilities,['form.read','form.submit']);assert.deepEqual(row.allowedOrigins,[input.origin]);assert.match(row.publicSiteKey,/^nov_pk_/);assert.equal(row.formId,form);await assert.rejects(createCrmTrainingIntegration(session(),{...input,formId:foreignForm},meta(),options()));await assert.rejects(createCrmTrainingIntegration(session(),{...input,origin:'https://example.invalid/secret/path'},meta(),options()));
});
test('local gateway checks use the actual resolver, persist failures, replay once and perform no external request',async()=>{
 const row=(await readCrmIntegrations(session(),project,options())).websites.find(item=>item.allowedOrigins.includes('https://synthetic.example.invalid'))!,metadata=meta();const fetchOriginal=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;throw new Error('Unexpected network request');};
 try{const good=await checkCrmIntegration(session(),{targetType:'website',targetId:row.id},metadata,options());assert.equal(good.data.passed,true);assert.equal(good.data.externalRequests,0);assert.equal((await checkCrmIntegration(session(),{targetType:'website',targetId:row.id},metadata,options())).replayed,true);const bad=await checkCrmIntegration(session(),{targetType:'website',targetId:row.id,origin:'https://forbidden.example.invalid'},meta(),options());assert.equal(bad.data.passed,false);assert.equal(calls,0);assert.equal((await db.admin.query('select count(*) from crm_integration_checks where target_id=$1',[row.id])).rows[0].count,'2');}finally{globalThis.fetch=fetchOriginal;}
});
test('status changes use current versions; revocation is terminal across both new and legacy writers',async()=>{
 const created=await createCrmTrainingIntegration(session(),{formId:form,origin:'https://revoke.example.invalid'},meta(),options());let row=(await readCrmIntegrations(session(),project,options())).websites.find(item=>item.id===created.data.id)!;await changeCrmWebsiteStatus(session(),{id:row.id,status:'disabled',expectedUpdatedAt:row.updatedAt},meta(),options());await assert.rejects(changeCrmWebsiteStatus(session(),{id:row.id,status:'active',expectedUpdatedAt:row.updatedAt},meta(),options()),/geändert/);row=(await readCrmIntegrations(session(),project,options())).websites.find(item=>item.id===created.data.id)!;await changeCrmWebsiteStatus(session(),{id:row.id,status:'revoked',expectedUpdatedAt:row.updatedAt},meta(),options());assert.equal((await checkCrmIntegration(session(),{targetType:'website',targetId:row.id},meta(),options())).data.passed,false);await assert.rejects(withCrmRead(session(),tx=>tx.execute("update external_integrations set status='active',revoked_at=null where workspace_id=$1::uuid and id=$2::uuid",[w,row.id]),options()),/reactivated/);
});
test('local mail configuration checks cannot assert provider delivery or alter customer records',async()=>{
 const before=(await db.admin.query('select count(*) from contacts')).rows[0].count;const result=await checkCrmIntegration(session(),{targetType:'resend',targetId:'resend'},meta(),options());assert.equal(result.data.mode,'local');assert.equal(result.data.passed,false);assert.equal(result.data.externalRequests,0);assert.equal((await db.admin.query('select count(*) from contacts')).rows[0].count,before);
});
