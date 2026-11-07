import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile,mkdir,unlink} from 'node:fs/promises';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {test} from 'node:test';
import {startLocalSalesDb,applySalesSchema} from './lib/local-sales-db.mjs';
import type {AppSession} from '../src/lib/auth/session';
import type {TenantPool} from '../src/lib/db/tenant-client';
import {getStoredFunnel,saveStoredFunnel,restoreStoredFunnelVersion,getPublishedFunnel,publicFunnelBlueprint} from '../src/lib/funnel-store';
import {closeLocalTestPool} from '../src/lib/db/local-test-transport';
import type {FunnelBlueprint} from '../src/lib/funnel-schema';
import {POST} from '../src/app/api/funnels/[funnelId]/submissions/route';
import {GET} from '../src/app/api/funnels/[funnelId]/blueprint/route';
import {initialFunnelAnswers,funnelElementFields,setFunnelAnswer,buildFunnelRuntimeSubmission} from '../src/lib/funnel-runtime';
test('legacy funnel publishes, accepts a real isolated public submission, restores and fails closed', {timeout:180000},async(t)=>{
 const db=await startLocalSalesDb(),w=randomUUID(),u=randomUUID(),p=randomUUID(),other=randomUUID(),otherUser=randomUUID();
 const options={pool:db.pool as unknown as TenantPool};
 const session=(workspace=w,actor=u):AppSession=>({authenticated:true,workspaceId:workspace,userId:actor,name:'SYNTHETIC actor',workspaceName:'SYNTHETIC test',email:'actor@example.invalid',role:'owner',productRole:'customer_owner',permissions:[],productPermissions:[],source:'database'});
 try{
  await applySalesSchema(db,{maxMigrationNumber:106});await db.admin.query(await readFile('migrations/181_funnel_live_templates.sql','utf8'));
  await db.admin.query("insert into workspaces(id,name,operating_model) values($1,'SYNTHETIC Funnel','self_service_customer'),($2,'SYNTHETIC foreign','self_service_customer')",[w,other]);
  for(const[id,ws]of[[u,w],[otherUser,other]])await db.admin.query("insert into workspace_users(id,workspace_id,name,email,role,product_role,status) values($1,$2,'SYNTHETIC actor',$3,'owner','customer_owner','active')",[id,ws,id+'@example.invalid']);
  await db.admin.query("insert into projects(id,workspace_id,name,type,data_classification,data_purpose) values($1,$2,'SYNTHETIC Funnel project','Service','CUSTOMER_TENANT','crm_sales')",[p,w]);
  Object.assign(process.env,{NODE_ENV:'test',CRM_LOCAL_TEST_DATABASE:'1',DATABASE_URL:`postgresql://${db.role}@127.0.0.1:${db.port}/postgres`});
  await mkdir('.npm-cache/qa',{recursive:true});const fixture=path.resolve('.npm-cache/qa',`new-funnel-${randomUUID()}.json`);let blueprint:FunnelBlueprint;try{execFileSync(process.execPath,['--import','tsx','scripts/lib/build-new-funnel-fixture.ts',fixture,w,u,p],{cwd:process.cwd(),windowsHide:true,stdio:'pipe'});blueprint=JSON.parse(await readFile(fixture,'utf8')) as FunnelBlueprint;}finally{await unlink(fixture).catch(()=>undefined);}
  assert.equal((await db.admin.query('select id from funnels where id=$1',[blueprint.id])).rowCount,0);
  blueprint.crmHandover.destination='leadInbox';blueprint.tracking.metaCapiToken='PRIVATE-PROVIDER-SECRET';
  const saved=await saveStoredFunnel(blueprint,'SYNTHETIC initial',session(),options);
  assert.equal(saved.source,'database');assert.equal((await db.admin.query('select owner_user_id from funnels where id=$1',[saved.funnelId])).rows[0].owner_user_id,u);assert.equal(await getStoredFunnel(blueprint.id,session(other,otherUser),options),null);
  await assert.rejects(saveStoredFunnel({...blueprint,projectId:randomUUID()},'denied',session(),options));
  const published=await saveStoredFunnel({...blueprint,status:'aktiv'},'Reviewed publication',session(),options),token=String(published.tracking.publicToken);
  assert.equal(await getPublishedFunnel(blueprint.id,''),null);assert.equal(await getPublishedFunnel(blueprint.id,'X'.repeat(43)),null);
  const live=await getPublishedFunnel(blueprint.id,token);assert.ok(live);assert.doesNotMatch(JSON.stringify(publicFunnelBlueprint(live.blueprint)),/PRIVATE-PROVIDER-SECRET/);
  // Exercise the same contract used by the visible renderer, not a server-field-only payload.
  const firstForm=blueprint.pages[0].sections.flatMap(section=>section.rows.flatMap(row=>row.columns.flatMap(column=>column.elements))).find(element=>element.type==='form');assert.ok(firstForm);
  const renderedFields=funnelElementFields(firstForm),privacy=renderedFields.find(field=>field.crmField==='privacy_consent'),hidden=renderedFields.find(field=>field.type==='hidden');assert.ok(privacy&&hidden);
  let answers=initialFunnelAnswers(blueprint);assert.equal(answers[privacy.id],false);assert.equal(answers[hidden.id],'');
  for(const field of renderedFields.filter(field=>field.type!=='hidden'))answers=setFunnelAnswer(answers,field,field.type==='consent'?true:field.type==='email'?'funnel-customer@example.invalid':field.type==='phone'?'+431234567890':'SYNTHETIC rendered answer');
  const payload=buildFunnelRuntimeSubmission(blueprint,answers,{mode:'live',search:'?utm_source=synthetic-runtime&gclid=synthetic-click',sourceUrl:'https://synthetic.example.invalid/inquiry?utm_source=synthetic-runtime',userAgent:'SYNTHETIC Renderer QA'});
  assert.equal(payload.answers[hidden.id],'synthetic-runtime');assert.equal(Object.hasOwn(payload.answers,'name'),false);assert.equal(Object.hasOwn(payload.answers,'privacy_consent'),false);assert.deepEqual(payload.consent,{privacy:true,analytics:false,marketing:false});
  const requestKey=randomUUID();
  const submit=async(body:unknown=payload,publicToken=token)=>POST(new Request(`http://localhost/api/funnels/${blueprint.id}/submissions?token=${publicToken}`,{method:'POST',headers:{'content-type':'application/json','idempotency-key':requestKey},body:JSON.stringify(body)}),{params:Promise.resolve({funnelId:blueprint.id})});
  await t.test('unauthenticated designer reads and invalid links cannot disclose draft',async()=>{const r=await GET(new Request('http://localhost/api/funnels/'+blueprint.id+'/blueprint'),{params:Promise.resolve({funnelId:blueprint.id})});assert.equal(r.status,401);assert.equal((await submit(payload,'invalid')).status,404);});
  await t.test('public live POST commits original IDs, real lead/task/contact atomically',async()=>{const response=await submit(),result=await response.json();assert.equal(response.status,200,JSON.stringify(result));assert.equal(result.persisted,true);assert.ok(result.submissionId);const repeated=await submit();assert.equal(repeated.status,200);assert.equal((await repeated.json()).submissionId,result.submissionId);assert.equal(Object.hasOwn(result,'leadPreview'),false);const row=(await db.admin.query('select workspace_id,project_id,funnel_id,contact_id,lead_id,mode,answers,raw_payload from funnel_submissions where id=$1',[result.submissionId])).rows[0];assert.equal(row.workspace_id,w);assert.equal(row.project_id,p);assert.equal(row.funnel_id,blueprint.id);assert.equal(row.mode,'live');assert.deepEqual(row.answers,payload.answers);assert.deepEqual(row.raw_payload,payload);assert.ok(row.contact_id&&row.lead_id);assert.deepEqual((await db.admin.query('select name,email,phone from contacts where id=$1',[row.contact_id])).rows[0],{name:'SYNTHETIC rendered answer',email:'funnel-customer@example.invalid',phone:'+431234567890'});assert.equal(Number((await db.admin.query('select count(*) from tasks where lead_id=$1',[row.lead_id])).rows[0].count),1);});
  await t.test('saving a changed draft preserves the exact published snapshot and live token',async()=>{const changed=await saveStoredFunnel({...blueprint,name:'SYNTHETIC New unpublished name',status:'entwurf'},'New private draft',session(),options);assert.equal(changed.blueprint.name,'SYNTHETIC New unpublished name');assert.equal(changed.status,'aktiv');const live=await getPublishedFunnel(blueprint.id,token);assert.ok(live);assert.equal(live.blueprint.name,blueprint.name);assert.equal(live.versionId,published.versions[0].id);assert.equal(changed.tracking.publicToken,token);});
  await t.test('missing consent and malformed fields do not create leads',async()=>{const count=Number((await db.admin.query('select count(*) from leads where workspace_id=$1',[w])).rows[0].count);assert.equal((await submit({...payload,consent:{...payload.consent,privacy:false}})).status,422);assert.equal((await submit({...payload,answers:{...payload.answers,unexpected:'value'}})).status,422);assert.equal((await submit({...payload,answers:{...payload.answers,name:'shadow alias'}})).status,422);assert.equal((await submit({...payload,consent:{...payload.consent,analytics:true}})).status,422);assert.equal(Number((await db.admin.query('select count(*) from leads where workspace_id=$1',[w])).rows[0].count),count);});
  await t.test('restore keeps current tenant and explicitly unpublishes; revoked actor blocks intake',async()=>{await db.admin.query("update workspace_users set status='suspended' where id=$1",[u]);assert.equal((await submit()).status,404);await db.admin.query("update workspace_users set status='active' where id=$1",[u]);const restored=await restoreStoredFunnelVersion(blueprint.id,saved.versions[0].id,session(),options);assert.equal(restored?.blueprint.status,'entwurf');assert.equal(await getPublishedFunnel(blueprint.id,token),null);await assert.rejects(restoreStoredFunnelVersion(blueprint.id,saved.versions[0].id,{...session(),authenticated:false},options));});
 }finally{await closeLocalTestPool();delete process.env.DATABASE_URL;delete process.env.CRM_LOCAL_TEST_DATABASE;await db.stop();}
});
