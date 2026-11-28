import assert from 'node:assert/strict';
import {before,after,test} from 'node:test';
import {readFile} from 'node:fs/promises';
import {createHash,generateKeyPairSync,randomUUID,sign} from 'node:crypto';
import pg from 'pg';
import {SignJWT,jwtVerify,type JWTVerifyOptions} from 'jose';
import {startLocalSalesDb,applySalesSchema,LocalSalesPool} from './lib/local-sales-db.mjs';
import {registerAutonomousCrmPreviewAccess,type AutonomousPreviewRegistration} from '../src/lib/crm-autonomous-preview-registration';
import {registerAutonomousCrmAccess} from '../src/lib/crm-autonomous-registration';
import {handleAutonomousCrmModules,autonomousModuleReceiverDomain,autonomousModuleReceiverReconciliationDomain,autonomousModuleDelegationDomain} from '../src/lib/crm-autonomous-modules';
import {handleAutonomousCrmNonexecution,autonomousNonexecutionReceiverDomain} from '../src/lib/crm-autonomous-nonexecution';
import {autonomousPreviewIdentity,autonomousPreviewAudience,autonomousPreviewSubject,verifyAutonomousPreviewToken} from '../src/lib/crm-autonomous-preview-auth';
import {CRM_MACHINE_ISSUER,CRM_MACHINE_OWNER_ID,CRM_MACHINE_PROJECT_ID,CRM_MACHINE_WORKSPACE_ID,CRM_MACHINE_AUDIENCE,CRM_MACHINE_SUBJECT,type CrmMachineAuthOptions} from '../src/lib/crm-machine-auth';
import {crmPayloadDigest} from '../src/lib/crm-command';
import type {TenantPool} from '../src/lib/db/tenant-client';
let db:Awaited<ReturnType<typeof startLocalSalesDb>>,runtime:pg.Pool,productionStageRejected=false;
const actor=randomUUID(),project=randomUUID(),mission=randomUUID(),control=randomUUID(),key=generateKeyPairSync('ed25519'),recovery=generateKeyPairSync('ed25519');
const receiver={origin:'https://novalure-synthetic-v2-novalure.vercel.app',deploymentId:'dpl_PreviewV2',revision:'a'.repeat(40)};
const rsa=generateKeyPairSync('rsa',{modulusLength:2048});
async function token(extra:Record<string,unknown>={}){const now=Math.floor(Date.now()/1000);return new SignJWT({iss:CRM_MACHINE_ISSUER,aud:autonomousPreviewAudience,sub:autonomousPreviewSubject,project_id:CRM_MACHINE_PROJECT_ID,owner_id:CRM_MACHINE_OWNER_ID,environment:'preview',iat:now-1,nbf:now-1,exp:now+3600,jti:randomUUID(),...extra}).setProtectedHeader({alg:'RS256',typ:'JWT',kid:'synthetic-preview'}).sign(rsa.privateKey);}
const env:NodeJS.ProcessEnv={NODE_ENV:'production',VERCEL:'1',VERCEL_ENV:'preview',VERCEL_PROJECT_ID:'prj_R32Okl6AHijTohvuKmryuTLjWMsk',VERCEL_URL:new URL(receiver.origin).hostname,
 VERCEL_DEPLOYMENT_ID:receiver.deploymentId,VERCEL_GIT_COMMIT_SHA:receiver.revision,CRM_MACHINE_AUTH_ENABLED:'1',CRM_AUTONOMOUS_PREVIEW_ENABLED:'1',CRM_AUTONOMOUS_NONEXECUTION_ENABLED:'1',
 DATABASE_URL:'postgresql://novalure_app:synthetic-nonusable@ep-summer-dew-bht4t903-pooler.c-3.eu-central-1.aws.neon.tech/neondb?sslmode=verify-full'};
function auth(runtimeEnv:NodeJS.ProcessEnv=env):CrmMachineAuthOptions{return {env:{...runtimeEnv},verifier:async(t,o)=>jwtVerify(t,rsa.publicKey,o as JWTVerifyOptions) as ReturnType<NonNullable<CrmMachineAuthOptions['verifier']>>};}
function body(operation='Read',patch:Record<string,unknown>={},expectedVersion:number|null=null){return {contractVersion:'crm-autonomous-access-v2',operation,patch,expectedVersion,correlationId:randomUUID(),idempotencyKey:randomUUID()};}
function delegation(r:AutonomousPreviewRegistration,b:ReturnType<typeof body>,pins:Record<string,unknown>={receiverDeploymentId:receiver.deploymentId,receiverRevision:receiver.revision},domain=autonomousModuleReceiverDomain,privateKey=key.privateKey){const t=Math.floor(Date.now()/1000),p=Buffer.from(JSON.stringify({issuedAt:t,expiresAt:t+60,nonce:randomUUID(),requestHash:crmPayloadDigest(b),...pins})).toString('base64url');return `v1.${r.grantId}.${p}.${sign(null,Buffer.from(`${domain}.${r.grantId}.${p}`),privateKey).toString('base64url')}`;}
async function call(r:AutonomousPreviewRegistration,b=body(),options:CrmMachineAuthOptions=auth(),proof=delegation(r,b),headers:Record<string,string>={}){const res=await handleAutonomousCrmModules(new Request(receiver.origin+'/api/integrations/evelyn/access',{method:'POST',headers:{authorization:`Bearer ${await token()}`,'content-type':'application/json','x-evelyn-delegation':proof,...headers},body:JSON.stringify(b)}),{pool:runtime as unknown as TenantPool,machineAuth:options});return {status:res.status,body:await res.json()};}
async function fixture(write=true,changes:Partial<AutonomousPreviewRegistration>={}){
 const id=randomUUID(),run=randomUUID();await db.admin.query("insert into tasks(id,workspace_id,project_id,owner_user_id,title,metadata) values($1,$2,$3,$4,'SYNTHETIC: Preview Task',$5::jsonb)",[id,CRM_MACHINE_WORKSPACE_ID,project,actor,JSON.stringify({syntheticTest:true,qaRunId:run,scope:'autonomous-v2-preview-task'})]);
 const r:AutonomousPreviewRegistration={workloadId:randomUUID(),workloadActorId:actor,grantId:randomUUID(),actorId:actor,projectId:project,sourceId:id,taskId:mission,departmentId:'SALES',agentId:'synthetic.preview',entity:'Task',scopes:['crm.tasks.read',...(write?['crm.tasks.write']:[])],publicKey:key.publicKey.export({format:'der',type:'spki'}).toString('base64url'),authorityReference:'SYNTHETIC own V2 Preview task',expiresAt:new Date(Date.now()+600000).toISOString(),preview:{...receiver,qaRunId:run},module:{contractVersion:'crm-autonomous-access-v2',readFields:['title'],writeFields:write?['title']:[],relatedResources:{},lifecycleMode:'EXISTING'},...changes};return r;
}
async function provision(r:AutonomousPreviewRegistration){const c=await db.admin.connect();try{return await registerAutonomousCrmPreviewAccess(c,r);}finally{c.release();}}
async function snapshot(r:AutonomousPreviewRegistration){return (await db.admin.query("select (select to_jsonb(t) from tasks t where id=$1) as task,(select count(*) from crm_command_receipts where resource_id=$1) as receipts,(select count(*) from audit_logs where entity_id=$1) as audits,(select count(*) from crm_autonomous_access_events where grant_id=$2) as access",[r.sourceId,r.grantId])).rows[0];}
before(async()=>{
 db=await startLocalSalesDb({database:'neondb'});await applySalesSchema(db,{maxMigrationNumber:90});
 await db.admin.query("alter database neondb set neon.project_id='long-fog-84900593';alter database neondb set neon.branch_id='br-summer-mountain-bh7w67e3'");
 await db.admin.query("insert into workspaces(id,name,operating_model,customer_type) values($1,'SYNTHETIC Preview','novalure_internal','novalure_internal') on conflict(id) do update set operating_model='novalure_internal',customer_type='novalure_internal'",[CRM_MACHINE_WORKSPACE_ID]);
 await db.admin.query("insert into workspace_users(id,workspace_id,name,email,role,product_role,status) values($1,$2,'SYNTHETIC Preview Actor','preview@qa.invalid','agent','novalure_operator','active')",[actor,CRM_MACHINE_WORKSPACE_ID]);
 await db.admin.query("insert into projects(id,workspace_id,name,type) values($1,$2,'SYNTHETIC Preview Project','Internal')",[project,CRM_MACHINE_WORKSPACE_ID]);
 await db.admin.query("insert into project_pipeline_permissions(workspace_id,project_id,user_id,can_read,can_edit_deals) values($1,$2,$3,true,true)",[CRM_MACHINE_WORKSPACE_ID,project,actor]);
 await db.admin.query("create role autonomous_modules_installer nologin nosuperuser nocreatedb nocreaterole noreplication nobypassrls");
 await db.admin.query("grant usage,create on schema public to autonomous_modules_installer;grant references on projects,auth_sessions,auth_identities to autonomous_modules_installer;grant execute on function crm_reject_immutable_mutation() to autonomous_modules_installer");
 await db.admin.query("grant select(id,auth_identity_id,workspace_user_id,workspace_id,mfa_verified_at,created_at,revoked_at,expires_at) on auth_sessions to autonomous_modules_installer;grant update(last_seen_at) on auth_sessions to autonomous_modules_installer");
 await db.admin.query("grant select(id,credential_state,disabled_at,mfa_enabled_at,normalized_email) on auth_identities to autonomous_modules_installer;grant update(updated_at) on auth_identities to autonomous_modules_installer");
 for(const table of ['workspaces','workspace_users','project_pipeline_permissions','calendar_events','conversations','contacts','crm_offers','crm_offer_revisions','property_reservations','property_units','property_sales'])await db.admin.query(`alter table ${table} owner to autonomous_modules_installer`);
 const c=await db.admin.connect();try{await c.query("set neon.project_id='long-fog-84900593';set neon.branch_id='br-summer-mountain-bh7w67e3'");await c.query('set role autonomous_modules_installer');
  for(const stage of ['evelyn_autonomous_access.sql','evelyn_autonomous_personal_source.sql','evelyn_autonomous_modules.sql','evelyn_autonomous_business_authority.sql']){await c.query('begin');try{await c.query(await readFile('migrations/staged/'+stage,'utf8'));await c.query('commit');}catch(e){await c.query('rollback');throw e;}}
  await c.query('reset role');await c.query('alter table crm_command_receipts owner to autonomous_modules_installer');await c.query('set role autonomous_modules_installer');
  for(const stage of ['evelyn_autonomous_nonexecution.sql','evelyn_autonomous_preview_qa.sql']){
   const sql=await readFile('migrations/staged/'+stage,'utf8');
   if(stage==='evelyn_autonomous_preview_qa.sql'){
    await c.query("set neon.project_id='misty-cloud-70835427';set neon.branch_id='br-spring-night-alyu48yp'");await c.query('begin');
    try{await assert.rejects(c.query(sql),/AUTONOMOUS_PREVIEW_INSTALLER_BOUNDARY/);productionStageRejected=true;}finally{await c.query('rollback');}
    assert.equal((await c.query("select count(*)::int as n from information_schema.columns where table_schema='public' and table_name='crm_autonomous_workloads' and column_name='preview_identity_id'")).rows[0].n,0);
    await c.query("set neon.project_id='long-fog-84900593';set neon.branch_id='br-summer-mountain-bh7w67e3'");
   }
   await c.query('begin');try{await c.query(sql);await c.query('commit');}catch(e){await c.query('rollback');throw e;}
  }
 }finally{await c.query('reset role');c.release();}
 await db.admin.query('alter role novalure_app login;grant novalure_tenant_app to novalure_app');runtime=new LocalSalesPool({host:'127.0.0.1',port:db.port,user:'novalure_app',database:'neondb',max:6});
});
after(async()=>{await runtime?.end();if(db)await db.stop();});
test('QA-only stage rejects actual PostgreSQL production target settings before any additive DDL',()=>{assert.equal(productionStageRejected,true);});
test('separate Preview iat acceptance caps original long-lived token at five minutes',async()=>{const now=new Date(),p=await verifyAutonomousPreviewToken(await token(),{...auth(),now});assert.ok(p.expiresAt<=Math.floor(now.valueOf()/1000)+300);assert.equal(p.identityId,autonomousPreviewIdentity);for(const bad of [{aud:CRM_MACHINE_AUDIENCE},{environment:'production'},{sub:CRM_MACHINE_SUBJECT},{iat:Math.floor(now.valueOf()/1000)-301}])await assert.rejects(verifyAutonomousPreviewToken(await token(bad),{...auth(),now}));});
test('registered actual Preview Task Describe/Read and local mutation/restore preserve exact original receipt',async()=>{
 const r=await fixture(),handoff=await provision(r);assert.equal(handoff.grant.publicKeyDigest,createHash('sha256').update(key.publicKey.export({format:'der',type:'spki'})).digest('hex'));
 for(const op of ['DescribeAssignment','Read']){const out=await call(r,body(op));assert.equal(out.status,200,JSON.stringify(out.body));}
 const b=body('Update',{title:'SYNTHETIC: changed Preview'},1),first=await call(r,b);assert.equal(first.status,200,JSON.stringify(first.body));
 const replay=await call(r,b);assert.equal(replay.status,200,JSON.stringify(replay.body));assert.equal(replay.body.auditReference,first.body.auditReference);assert.equal(replay.body.replayed,true);
 const recovered=await call(r,b,auth(),delegation(r,b,undefined,autonomousModuleReceiverReconciliationDomain),{'x-evelyn-reconcile-only':'1'});assert.equal(recovered.status,200,JSON.stringify(recovered.body));assert.equal(recovered.body.auditReference,first.body.auditReference);
 assert.equal((await call(r,body('Update',{title:'SYNTHETIC: Preview Task'},2))).status,200);assert.equal((await snapshot(r)).task.version,3);
});
test('Preview native flags, DB role/host, mandatory signed pair and body profile fail closed without effects',async()=>{
 const r=await fixture();await provision(r);const b=body('Update',{title:'SYNTHETIC: denied'},1),before=await snapshot(r);
 for(const change of [{CRM_AUTONOMOUS_PREVIEW_ENABLED:'0'},{VERCEL_ENV:'production'},{VERCEL_PROJECT_ID:'other'},{VERCEL_DEPLOYMENT_ID:'dpl_Other'},{VERCEL_GIT_COMMIT_SHA:'b'.repeat(40)},{VERCEL_URL:'other.vercel.app'},{DATABASE_URL:'postgresql://novalure_app:synthetic@ep-wandering-union-alem0781-pooler.c-3.eu-central-1.aws.neon.tech/neondb?sslmode=verify-full'},{DATABASE_URL:env.DATABASE_URL!.replace('novalure_app','neondb_owner')}])assert.notEqual((await call(r,b,auth({...env,...change}))).status,200);
 for(const pins of [{},{receiverDeploymentId:receiver.deploymentId},{receiverRevision:receiver.revision}])assert.notEqual((await call(r,b,auth(),delegation(r,b,pins))).status,200);
 assert.notEqual((await call(r,b,auth(),delegation(r,b,{}),{'x-receiver-deployment-id':receiver.deploymentId,'x-receiver-revision':receiver.revision})).status,200);
 assert.notEqual((await call(r,b,auth(),delegation(r,b,{receiverDeploymentId:receiver.deploymentId,receiverRevision:receiver.revision},autonomousModuleDelegationDomain))).status,200);
 assert.equal((await call(r,{...b,profile:'preview'} as typeof b)).status,400);assert.deepEqual(await snapshot(r),before);
});
test('Preview registration rejects foreign/non-synthetic resource and supports distinct immutable run/build histories',async()=>{
 const r=await fixture();await db.admin.query("update tasks set metadata='{}' where id=$1",[r.sourceId]);await assert.rejects(provision(r),/OWN_TASK_REQUIRED/);assert.equal((await db.admin.query('select count(*) from crm_autonomous_access_grants where id=$1',[r.grantId])).rows[0].count,'0');
 const a=await fixture(false),b=await fixture(false);await assert.rejects(provision({...a,preview:{...a.preview,qaRunId:'00000000-0000-1000-8000-000000000000'}}),/REGISTRATION_INVALID/);await provision(a);await provision(b);assert.notEqual(a.workloadId,b.workloadId);
 assert.equal((await call(a)).status,200);assert.equal((await call(b)).status,200);
 const c=await db.admin.connect();try{await c.query('set role autonomous_modules_installer');await assert.rejects(registerAutonomousCrmAccess(c,{...a,entity:'Task',expiresAt:a.expiresAt,sourceProfile:'PREVIEW' as never}),/REGISTRATION_INVALID/);}finally{await c.query('reset role');c.release();}
});
test('Preview workload expiry and revocation stop signed requests and native DB target remains authoritative',async()=>{
 for(const field of ['expires_at','revoked_at']){const r=await fixture();await provision(r);await db.admin.query(`update crm_autonomous_workloads set ${field}=${field==='expires_at'?"not_before+interval '1 microsecond'":"clock_timestamp()"} where id=$1`,[r.workloadId]);assert.notEqual((await call(r)).status,200);}
 const r=await fixture();await provision(r);const badPool=new LocalSalesPool({host:'127.0.0.1',port:db.port,user:'novalure_app',database:'neondb',options:'-c neon.project_id=misty-cloud-70835427 -c neon.branch_id=br-spring-night-alyu48yp'});
 try{const b=body(),res=await handleAutonomousCrmModules(new Request(receiver.origin+'/api/integrations/evelyn/access',{method:'POST',headers:{authorization:`Bearer ${await token()}`,'content-type':'application/json','x-evelyn-delegation':delegation(r,b)},body:JSON.stringify(b)}),{pool:badPool as unknown as TenantPool,machineAuth:auth()});assert.notEqual(res.status,200);}finally{await badPool.end();}
});
test('Preview independent recovery closes genuine stored binding without re-reading a deleted or revoked business assignment',async()=>{
 const r=await fixture();await provision(r);const authority=randomUUID(),b=body('Update',{title:'SYNTHETIC: never applied'},1);
 await db.admin.query("insert into crm_autonomous_recovery_authorities(id,workload_id,control_project_id,grant_ids,recovery_public_key,authority_reference,expires_at) values($1,$2,$3,array[$4::uuid],$5,'SYNTHETIC Preview recovery',clock_timestamp()+interval '5 minutes')",[authority,r.workloadId,control,r.grantId,recovery.publicKey.export({format:'der',type:'spki'}).toString('base64url')]);
 await db.admin.query('update crm_autonomous_access_grants set revoked_at=clock_timestamp() where id=$1',[r.grantId]);await db.admin.query('delete from tasks where id=$1',[r.sourceId]);
 const binding={grantId:r.grantId,workspaceId:CRM_MACHINE_WORKSPACE_ID,sourceId:r.sourceId,taskId:r.taskId,departmentId:r.departmentId,agentId:r.agentId,entity:'Task',crmProjectId:r.projectId,controlProjectId:control,missionId:randomUUID(),attemptId:randomUUID(),effectId:randomUUID(),registryVersion:'1',targetDigest:'a'.repeat(64),artifactDigest:'b'.repeat(64),requestDigest:crmPayloadDigest(b)};
 const t=Math.floor(Date.now()/1000),p=Buffer.from(JSON.stringify({...binding,issuedAt:t,expiresAt:t+60,nonce:randomUUID(),receiverDeploymentId:receiver.deploymentId,receiverRevision:receiver.revision})).toString('base64url');
 const res=await handleAutonomousCrmNonexecution(new Request(receiver.origin+'/api/integrations/evelyn/access',{method:'POST',headers:{authorization:`Bearer ${await token()}`,'content-type':'application/json','x-evelyn-close-without-effect':'1','x-evelyn-recovery':`v1.${authority}.${p}.${sign(null,Buffer.from(`${autonomousNonexecutionReceiverDomain}.${authority}.${p}`),recovery.privateKey).toString('base64url')}`},body:JSON.stringify(b)}),{pool:runtime as unknown as TenantPool,machineAuth:auth()});assert.equal(res.status,200,await res.clone().text());assert.equal((await res.json()).outcome,'NO_EFFECT');
});
test('original identity unique and ON CONFLICT(identity_id) retain Production and personal registration behavior',async()=>{
 const r=await fixture(false),{preview,...normal}=r,c=await db.admin.connect();void preview;
 const originalRead=async(registration:typeof normal,personal=false)=>{
  const b=body(),bearer=await token({aud:CRM_MACHINE_AUDIENCE,environment:personal?'franz-personal':'production',sub:personal?'owner:novalure:project:evelyn:environment:franz-personal':CRM_MACHINE_SUBJECT,...(personal?{custom_environment_id:'env_sue274zKgFxQJiKfw64x7BmEfEwE'}:{})});
  const response=await handleAutonomousCrmModules(new Request(receiver.origin+'/api/integrations/evelyn/access',{method:'POST',headers:{authorization:`Bearer ${bearer}`,'content-type':'application/json','x-evelyn-delegation':delegation({...registration,preview:r.preview},b,{},autonomousModuleDelegationDomain)},body:JSON.stringify(b)}),{pool:runtime as unknown as TenantPool,machineAuth:auth({...env,VERCEL_ENV:'production',CRM_AUTONOMOUS_PERSONAL_SOURCE_ENABLED:'1'})});
  assert.equal(response.status,200,await response.clone().text());
 };
 try{await c.query('set role autonomous_modules_installer');await registerAutonomousCrmAccess(c,normal);await registerAutonomousCrmAccess(c,normal);
  const row=(await c.query("insert into crm_autonomous_workloads(id,identity_id,workspace_id,actor_user_id,issuer,audience,project_id,owner_id,subject,environment,authority_reference) select $1,identity_id,workspace_id,actor_user_id,issuer,audience,project_id,owner_id,subject,environment,authority_reference from crm_autonomous_workloads where id=$2 on conflict(identity_id) do nothing returning id",[randomUUID(),normal.workloadId])).rows;assert.equal(row.length,0);
  const personal={...normal,workloadId:randomUUID(),grantId:randomUUID(),sourceProfile:'FRANZ_PERSONAL' as const};await registerAutonomousCrmAccess(c,personal);await registerAutonomousCrmAccess(c,personal);
  const again=await c.query("insert into crm_autonomous_workloads(id,identity_id,workspace_id,actor_user_id,issuer,audience,project_id,owner_id,subject,environment,custom_environment_id,authority_reference) select $1,identity_id,workspace_id,actor_user_id,issuer,audience,project_id,owner_id,subject,environment,custom_environment_id,authority_reference from crm_autonomous_workloads where id=$2 on conflict(identity_id) do nothing returning id",[randomUUID(),personal.workloadId]);assert.equal(again.rowCount,0);
  await originalRead(normal);await originalRead(personal,true);
 }finally{await c.query('reset role');c.release();}
});
test('Preview parent chain retains its current source, field subset and late parent revocation ceilings',async()=>{
 const parent=await fixture();await provision(parent);const childKey=generateKeyPairSync('ed25519');
 const child:AutonomousPreviewRegistration={...parent,grantId:randomUUID(),agentId:'synthetic.preview.child',publicKey:childKey.publicKey.export({format:'der',type:'spki'}).toString('base64url'),scopes:['crm.tasks.read'],module:{...parent.module,writeFields:[],delegationKind:'SUBAGENT',parentGrantId:parent.grantId}};await provision(child);
 const read=body();assert.equal((await call(child,read,auth(),delegation(child,read,undefined,undefined,childKey.privateKey))).status,200);
 const update=body('Update',{title:'SYNTHETIC: child denied'},1),before=await snapshot(child);assert.equal((await call(child,update,auth(),delegation(child,update,undefined,undefined,childKey.privateKey))).status,403);assert.deepEqual(await snapshot(child),before);
 const other=await fixture(false),foreign={...other,module:{...other.module,delegationKind:'SUBAGENT' as const,parentGrantId:parent.grantId}};await assert.rejects(provision(foreign),/SCOPE_NOT_GRANTED/);
 await db.admin.query('update crm_autonomous_access_grants set revoked_at=clock_timestamp() where id=$1',[parent.grantId]);const q=body();assert.equal((await call(child,q,auth(),delegation(child,q,undefined,undefined,childKey.privateKey))).status,403);
});
test('Preview registry rejects mixed bundles, expired insertion and reopening; expiry still permits exact cleanup',async()=>{
 const expired=await fixture(false,{expiresAt:new Date(Date.now()-1000).toISOString()});await assert.rejects(provision(expired),/REGISTRATION_INVALID/);
 const r=await fixture();await provision(r);
 await assert.rejects(db.admin.query("update crm_autonomous_workloads set expires_at='infinity'::timestamptz where id=$1",[r.workloadId]),/check constraint/);
 await assert.rejects(db.admin.query("update crm_autonomous_workloads set preview_identity_id=null where id=$1",[r.workloadId]),/Replace a revoked registration|check constraint/);
 await db.admin.query("update crm_autonomous_workloads set expires_at=not_before+interval '1 microsecond' where id=$1",[r.workloadId]);
 await db.admin.query('update crm_autonomous_access_grants set revoked_at=clock_timestamp() where id=$1',[r.grantId]);
 await assert.rejects(db.admin.query('update crm_autonomous_access_grants set revoked_at=null where id=$1',[r.grantId]),/PREVIEW_CLOSED/);
 await db.admin.query('update crm_autonomous_workloads set revoked_at=clock_timestamp() where id=$1',[r.workloadId]);await assert.rejects(db.admin.query('update crm_autonomous_workloads set revoked_at=null where id=$1',[r.workloadId]),/PREVIEW_CLOSED/);
});
test('only the real original Task owner and existing SET lease register; nonreaders and no-SET calls roll back',async()=>{
 const r=await fixture(),role='qa_preview_reader_'+randomUUID().replaceAll('-','').slice(0,10),original=String((await db.admin.query('select current_user as actor')).rows[0].actor);let reader:pg.Client|undefined;
 const denied=await db.admin.connect();try{await denied.query('set role autonomous_modules_installer');await assert.rejects(registerAutonomousCrmPreviewAccess(denied,r),/OPERATOR_READER_REQUIRED/);}finally{await denied.query('reset role');denied.release();}
 // The existing native technical source owner has BYPASSRLS; neither the
 // metadata registrar nor the application runtime receives that privilege.
 await db.admin.query(`create role ${role} login nosuperuser nocreatedb nocreaterole noreplication bypassrls;alter table tasks owner to ${role}`);
 await db.admin.query(`grant usage on schema public to ${role};grant autonomous_modules_installer to ${role} with admin true,inherit false,set false`);
 try{reader=new pg.Client({host:'127.0.0.1',port:db.port,user:role,database:'neondb'});await reader.connect();assert.deepEqual((await reader.query('select rolsuper,rolbypassrls from pg_roles where rolname=current_user')).rows[0],{rolsuper:false,rolbypassrls:true});await reader.query(`grant autonomous_modules_installer to ${role} with admin false,inherit true,set false granted by current_user`);
  const edges=async()=> (await reader!.query("select grantor,admin_option,inherit_option,set_option from pg_auth_members where roleid='autonomous_modules_installer'::regrole and member=$1::regrole order by grantor",[role])).rows,initial=await edges();assert.equal(initial.length,2);
  await assert.rejects(registerAutonomousCrmPreviewAccess(reader,r),/REGISTRAR_ROLE_UNAVAILABLE/);
  try{await reader.query(`grant autonomous_modules_installer to ${role} with admin false,inherit true,set true granted by current_user`);assert.equal((await registerAutonomousCrmPreviewAccess(reader,r)).status,'REGISTERED');assert.equal((await reader.query('select current_user::text as actor,session_user::text as original')).rows[0].actor,role);}
  finally{await reader.query(`grant autonomous_modules_installer to ${role} with admin false,inherit true,set false granted by current_user`);}
  assert.deepEqual(await edges(),initial);
 }finally{await reader?.end();await db.admin.query(`alter table tasks owner to "${original}";revoke usage on schema public from ${role};drop role ${role}`);}
});

/** Existing local harness bridge for an exact compiled Preview sender counterpart. */
export function autonomousPreviewFixture(){return {db,runtime,fixture,provision,body,auth,token,receiver,key,recovery,call,control,ids:{actor,project,mission,workspace:CRM_MACHINE_WORKSPACE_ID}};}
