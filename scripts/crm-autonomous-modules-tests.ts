import assert from "node:assert/strict";
import {createHash,generateKeyPairSync,randomUUID,sign,type KeyObject} from "node:crypto";
import {readFile} from "node:fs/promises";
import {after,before,test} from "node:test";
import {setTimeout as delay} from "node:timers/promises";
import {startLocalSalesDb,applySalesSchema} from "./lib/local-sales-db.mjs";
import {handleAutonomousCrmModules,autonomousModuleDelegationDomain} from "../src/lib/crm-autonomous-modules";
import {autonomousModuleContract,autonomousModuleFields,type AutonomousModuleEntity} from "../src/lib/crm-autonomous-module-contract";
import {registerAutonomousCrmAccess,autonomousCrmDepartments,type AutonomousCrmRegistration} from "../src/lib/crm-autonomous-registration";
import {crmPayloadDigest} from "../src/lib/crm-command";
import {CRM_MACHINE_AUDIENCE,CRM_MACHINE_ISSUER,CRM_MACHINE_OWNER_ID,CRM_MACHINE_PROJECT_ID,CRM_MACHINE_SUBJECT,CRM_MACHINE_WORKSPACE_ID,type CrmMachineAuthOptions} from "../src/lib/crm-machine-auth";
import type {TenantPool} from "../src/lib/db/tenant-client";
import {handleAutonomousCrmAccess,autonomousAccessContract,autonomousDelegationDomain} from "../src/lib/crm-autonomous-access";
import {closeLocalTestPool} from "../src/lib/db/local-test-transport";
import {decideAutonomousBusinessAuthority} from "../src/lib/crm-autonomous-business-authority";
import {executeOfferCommand,getOfferWorkflow} from "../src/lib/db/offer-repositories";
import {getRolePermissions} from "../src/lib/auth/permissions";
import {getProductRoleCapabilities} from "../src/lib/product-model";
import type {AppSession} from "../src/lib/auth/session";
import {withTenantTransaction} from "../src/lib/db/tenant-client";

let db:Awaited<ReturnType<typeof startLocalSalesDb>>;
const actor=randomUUID(),workload=randomUUID(),project=randomUUID(),mission=randomUUID(),task=randomUUID(),contact=randomUUID(),company=randomUUID(),lead=randomUUID(),unit=randomUUID(),appointment=randomUUID(),communication=randomUUID(),foreignProject=randomUUID(),privateTask=randomUUID();
const key=generateKeyPairSync("ed25519");
const bearer=`eyJ${"a".repeat(20)}.${"b".repeat(24)}.${"c".repeat(24)}`;
const ownerId=randomUUID(),ownerSessionId=randomUUID();let owner:AppSession;
function auth():CrmMachineAuthOptions{const now=Math.floor(Date.now()/1000);return {env:{CRM_MACHINE_AUTH_ENABLED:"1",VERCEL_ENV:"production",NODE_ENV:"production"},verifier:async()=>({protectedHeader:{alg:"RS256",typ:"JWT",kid:"isolated-local-verifier"},payload:{iss:CRM_MACHINE_ISSUER,aud:CRM_MACHINE_AUDIENCE,sub:CRM_MACHINE_SUBJECT,project_id:CRM_MACHINE_PROJECT_ID,owner_id:CRM_MACHINE_OWNER_ID,environment:"production",iat:now-2,nbf:now-2,exp:now+3600,jti:randomUUID()}})} as CrmMachineAuthOptions;}
function body(operation="Read",patch:Record<string,unknown>={},expectedVersion:number|null=null){return {contractVersion:autonomousModuleContract,operation,patch,expectedVersion,correlationId:randomUUID(),idempotencyKey:randomUUID()};}
function signature(id:string,b:Record<string,unknown>,privateKey:KeyObject=key.privateKey,prefix=autonomousModuleDelegationDomain){const now=Math.floor(Date.now()/1000),p=Buffer.from(JSON.stringify({issuedAt:now,expiresAt:now+60,nonce:randomUUID(),requestHash:crmPayloadDigest(b)})).toString("base64url");return `v1.${id}.${p}.${sign(null,Buffer.from(`${prefix}.${id}.${p}`),privateKey).toString("base64url")}`;}
async function call(id:string,b=body(),credential=signature(id,b),headers:Record<string,string>={}){
 const response=await handleAutonomousCrmModules(new Request("https://crm.invalid/api/integrations/evelyn/access",{method:"POST",headers:{authorization:`Bearer ${bearer}`,"content-type":"application/json","x-evelyn-delegation":credential,...headers},body:JSON.stringify(b)}),{pool:db.pool as unknown as TenantPool,machineAuth:auth()});return {status:response.status,body:await response.json()};
}
function registration(entity:AutonomousModuleEntity,sourceId:string,overrides:Partial<AutonomousCrmRegistration>={}):AutonomousCrmRegistration{
 const names:Record<AutonomousModuleEntity,string>={Contact:"contacts",Company:"companies",Developer:"developers",Project:"projects",Unit:"units",BuyerLead:"leads",Qualification:"qualifications",Offer:"offers",Task:"tasks",Appointment:"appointments",Viewing:"viewings",Reservation:"reservations",Sale:"sales",Communication:"communications",ApprovalReference:"approvals"};
 return {workloadId:workload,workloadActorId:actor,grantId:randomUUID(),actorId:actor,projectId:project,sourceId,taskId:mission,departmentId:"SALES",agentId:"synthetic.sales.worker",entity,scopes:[`crm.${names[entity]}.read`],publicKey:key.publicKey.export({format:"der",type:"spki"}).toString("base64url"),authorityReference:"SYNTHETIC module integration acceptance",expiresAt:null,
 module:{contractVersion:autonomousModuleContract,readFields:autonomousModuleFields[entity].filter(f=>f!=="version"),writeFields:[],relatedResources:{},lifecycleMode:"EXISTING"},...overrides};
}
async function provision(r:AutonomousCrmRegistration){const c=await db.admin.connect();try{await c.query("set role autonomous_modules_installer");return await registerAutonomousCrmAccess(c,r);}finally{await c.query("reset role");c.release();}}
before(async()=>{
 db=await startLocalSalesDb();await applySalesSchema(db,{maxMigrationNumber:90});
 await db.admin.query("insert into workspaces(id,name,operating_model,customer_type) values($1,'SYNTHETIC module workspace','novalure_internal','novalure_internal') on conflict(id) do update set operating_model='novalure_internal',customer_type='novalure_internal'",[CRM_MACHINE_WORKSPACE_ID]);
 await db.admin.query("insert into workspace_users(id,workspace_id,name,email,role,product_role,status) values($1,$2,'SYNTHETIC actor','modules@service.invalid','agent','novalure_operator','active')",[actor,CRM_MACHINE_WORKSPACE_ID]);
 const ownerRow=(await db.admin.query("insert into workspace_users(id,workspace_id,name,email,role,product_role,status) values($1,$2,'SYNTHETIC owner','owner@modules.invalid','owner','platform_admin','active') returning auth_identity_id",[ownerId,CRM_MACHINE_WORKSPACE_ID])).rows[0];
 await db.admin.query("update workspaces set setup_state=jsonb_build_object('salesApprovalUserId',$2::text) where id=$1",[CRM_MACHINE_WORKSPACE_ID,ownerId]);
 await db.admin.query("update auth_identities set credential_state='active',mfa_enabled_at=clock_timestamp(),mfa_secret_ciphertext='SYNTHETIC_NONUSABLE_MFA_FIXTURE' where id=$1",[ownerRow.auth_identity_id]);
 await db.admin.query("insert into auth_sessions(id,token_hash,auth_identity_id,workspace_user_id,workspace_id,mfa_verified_at,expires_at) values($1,$2,$3,$4,$5,clock_timestamp(),clock_timestamp()+interval '1 hour')",[ownerSessionId,createHash("sha256").update(randomUUID()).digest("hex"),ownerRow.auth_identity_id,ownerId,CRM_MACHINE_WORKSPACE_ID]);
 owner={authenticated:true,userId:ownerId,workspaceId:CRM_MACHINE_WORKSPACE_ID,workspaceName:"SYNTHETIC module owner",name:"SYNTHETIC owner",email:"owner@modules.invalid",role:"owner",productRole:"platform_admin",permissions:getRolePermissions("owner"),productPermissions:getProductRoleCapabilities("platform_admin"),source:"cookie",authSessionId:ownerSessionId,authIdentityId:ownerRow.auth_identity_id,mfaVerifiedAt:new Date(),sessionCreatedAt:new Date()};
 for(const id of [project,foreignProject])await db.admin.query("insert into projects(id,workspace_id,name,type,status) values($1,$2,'SYNTHETIC project','Internal','Aktiv')",[id,CRM_MACHINE_WORKSPACE_ID]);
 await db.admin.query("insert into project_pipeline_permissions(workspace_id,project_id,user_id,can_read,can_edit_deals) values($1,$2,$3,true,true)",[CRM_MACHINE_WORKSPACE_ID,project,actor]);
 await db.admin.query("insert into organizations(id,workspace_id,project_id,name,type) values($1,$2,$3,'SYNTHETIC developer','Bauträger')",[company,CRM_MACHINE_WORKSPACE_ID,project]);
 await db.admin.query("insert into contacts(id,workspace_id,project_id,organization_id,name,role,email) values($1,$2,$3,$4,'SYNTHETIC contact','Käufer','synthetic@example.invalid')",[contact,CRM_MACHINE_WORKSPACE_ID,project,company]);
 await db.admin.query("insert into leads(id,workspace_id,project_id,contact_id,type,buyer_profile) values($1,$2,$3,$4,'Käufer',$5::jsonb)",[lead,CRM_MACHINE_WORKSPACE_ID,project,contact,JSON.stringify({budgetFrom:100,budgetTo:200,secretPrivateNote:"MUST_NOT_EXPORT"})]);
 await db.admin.query("insert into tasks(id,workspace_id,project_id,title) values($1,$2,$3,'SYNTHETIC task')",[task,CRM_MACHINE_WORKSPACE_ID,project]);
 await db.admin.query("insert into tasks(id,workspace_id,project_id,title,data_classification) values($1,$2,$3,'SYNTHETIC private','PRIVATE_FRANZ')",[privateTask,CRM_MACHINE_WORKSPACE_ID,project]);
 await db.admin.query("insert into property_units(id,workspace_id,project_id,unit_number,floor,rooms,area_sqm,price_cents,status) values($1,$2,$3,'SYNTHETIC-A',1,2,50,12300,'available')",[unit,CRM_MACHINE_WORKSPACE_ID,project]);
 await db.admin.query("insert into calendar_events(id,workspace_id,project_id,title,starts_at,ends_at) values($1,$2,$3,'SYNTHETIC appointment',now()+interval '1 day',now()+interval '1 day 1 hour')",[appointment,CRM_MACHINE_WORKSPACE_ID,project]);
 await db.admin.query("insert into conversations(id,workspace_id,project_id,contact_id,channel,direction,summary,data_classification,data_purpose) values($1,$2,$3,$4,'Webchat','internal','SYNTHETIC timeline','NOVALURE_INTERNAL','crm_sales')",[communication,CRM_MACHINE_WORKSPACE_ID,project,contact]);
 await db.admin.query("create role autonomous_modules_installer nologin nosuperuser nocreatedb nocreaterole noreplication nobypassrls");
 await db.admin.query("grant usage,create on schema public to autonomous_modules_installer;grant references on projects,auth_sessions,auth_identities to autonomous_modules_installer;grant execute on function crm_reject_immutable_mutation() to autonomous_modules_installer");
 await db.admin.query("grant select(id,auth_identity_id,workspace_user_id,workspace_id,mfa_verified_at,created_at,revoked_at,expires_at) on auth_sessions to autonomous_modules_installer;grant update(last_seen_at) on auth_sessions to autonomous_modules_installer");
 await db.admin.query("grant select(id,credential_state,disabled_at,mfa_enabled_at,normalized_email) on auth_identities to autonomous_modules_installer;grant update(updated_at) on auth_identities to autonomous_modules_installer");
 for(const table of ["workspaces","workspace_users","project_pipeline_permissions","calendar_events","conversations","contacts","crm_offers","crm_offer_revisions","property_reservations","property_units","property_sales"])await db.admin.query(`alter table ${table} owner to autonomous_modules_installer`);
 const c=await db.admin.connect();try{await c.query("set role autonomous_modules_installer");for(const stage of ["evelyn_autonomous_access.sql","evelyn_autonomous_personal_source.sql","evelyn_autonomous_modules.sql","evelyn_autonomous_business_authority.sql"]){await c.query("begin");try{await c.query(await readFile(`migrations/staged/${stage}`,"utf8"));await c.query("commit");}catch(e){await c.query("rollback");throw e;}}}finally{await c.query("reset role");c.release();}
});
after(async()=>{await closeLocalTestPool();if(db)await db.stop();});

test("v2 staged upgrade preserves a protected owner and a fieldmasked task read without login or MFA",async()=>{
 const r=registration("Task",task);await provision(r);const result=await call(r.grantId);assert.equal(result.status,200,JSON.stringify(result.body));assert.equal(result.body.data.title,"SYNTHETIC task");assert.equal(result.body.data.version,1);assert.ok(result.body.data.updatedAt);assert.equal(result.body.departmentId,"SALES");
 const description=await call(r.grantId,body("DescribeAssignment"));assert.equal(description.status,200,JSON.stringify(description.body));assert.equal(description.body.data.contractVersion,autonomousModuleContract);assert.equal(description.body.data.parentGrantId,null);assert.equal(description.body.data.delegationKind,"DEPARTMENT");assert.deepEqual(description.body.data.operations,["DescribeAssignment","Read"]);
});
test("module projections use stored entity scope and minimize all implemented ordinary CRM domains",async()=>{
 for(const [entity,id]of [["Contact",contact],["Company",company],["Developer",company],["Project",project],["Unit",unit],["BuyerLead",lead],["Qualification",lead],["Appointment",appointment],["Communication",communication]] as const){
  const r=registration(entity,id);await provision(r);const result=await call(r.grantId);assert.equal(result.status,200,`${entity}:${JSON.stringify(result.body)}`);assert.equal(result.body.entity,entity);assert.equal(result.body.sourceId,id);assert.equal(result.body.data.version,1);assert.doesNotMatch(JSON.stringify(result.body),/MUST_NOT_EXPORT|delegation_public_key|actor_user_id/);
 }
});
test("exact task mutation is versioned, receipt-idempotent, audited and freshly authorized",async()=>{
 const r=registration("Task",task,{scopes:["crm.tasks.read","crm.tasks.write"],module:{contractVersion:autonomousModuleContract,readFields:["title","status"],writeFields:["title"],relatedResources:{},lifecycleMode:"EXISTING"}});await provision(r);
 const b=body("Update",{title:"SYNTHETIC changed"},1),first=await call(r.grantId,b);assert.equal(first.status,200,JSON.stringify(first.body));assert.equal(first.body.data.version,2);assert.deepEqual(Object.keys(first.body.data).sort(),["status","title","updatedAt","version"]);
 const replay=await call(r.grantId,b);assert.equal(replay.status,200,JSON.stringify(replay.body));assert.equal(replay.body.replayed,true);assert.equal(replay.body.auditReference,first.body.auditReference);assert.equal(replay.body.data.version,2);
 assert.equal((await call(r.grantId,body("Update",{title:"SYNTHETIC stale"},1))).status,409);
 const before=(await db.admin.query("select count(*) from crm_autonomous_access_events where grant_id=$1",[r.grantId])).rows[0].count;assert.equal(before,"2");
 await db.admin.query("update crm_autonomous_access_grants set revoked_at=clock_timestamp() where id=$1",[r.grantId]);assert.equal((await call(r.grantId,b)).status,403);
});
test("a protected create assignment makes exactly its preregistered task and cannot choose another ID",async()=>{
 const id=randomUUID(),r=registration("Task",id,{scopes:["crm.tasks.read","crm.tasks.create"],module:{contractVersion:autonomousModuleContract,readFields:["title"],writeFields:["title"],relatedResources:{},lifecycleMode:"CREATE"}});await provision(r);
 assert.equal((await call(r.grantId,body("DescribeAssignment"))).status,200);const b=body("Create",{title:"SYNTHETIC created"}),first=await call(r.grantId,b);assert.equal(first.status,200,JSON.stringify(first.body));assert.equal(first.body.sourceId,id);assert.equal(first.body.data.version,1);
 const replay=await call(r.grantId,b);assert.equal(replay.status,200,JSON.stringify(replay.body));assert.equal(replay.body.replayed,true);assert.equal((await db.admin.query("select count(*) from tasks where id=$1",[id])).rows[0].count,"1");
 assert.equal((await call(r.grantId,body("Create",{title:"SYNTHETIC illicit",sourceId:randomUUID()}))).status,403);
});
test("OIDC, names and declared scopes cannot replace department field policy, actual projects or signing key",async()=>{
 const r=registration("Contact",contact,{departmentId:"HR"});await assert.rejects(provision(r),/AUTONOMOUS_REGISTRATION_INVALID/);assert.equal((await call(r.grantId)).status,403);
 const p=registration("Task",privateTask);await provision(p);assert.equal((await call(p.grantId)).status,403);
 const q=registration("Task",task);await provision(q);assert.equal((await call(q.grantId,body(),undefined,{cookie:"forbidden"})).status,401);
 const b=body();assert.equal((await call(q.grantId,b,signature(q.grantId,b,generateKeyPairSync("ed25519").privateKey))).status,401);
 assert.equal((await call(q.grantId,{...body(),actorId:"owner"} as ReturnType<typeof body>)).status,400);
 const legacy={...body(),contractVersion:autonomousAccessContract};const response=await handleAutonomousCrmAccess(new Request("https://crm.invalid/api/integrations/evelyn/access",{method:"POST",headers:{authorization:`Bearer ${bearer}`,"content-type":"application/json","x-evelyn-delegation":signature(q.grantId,legacy,key.privateKey,autonomousDelegationDomain)},body:JSON.stringify(legacy)}),{pool:db.pool as unknown as TenantPool,machineAuth:auth()});assert.equal(response.status,403);
});
test("all sixteen departments require distinct current grants and keys never imply broader fields",async()=>{
 for(const departmentId of autonomousCrmDepartments){const r=registration("Task",task,{departmentId});await provision(r);assert.equal((await call(r.grantId)).status,200,departmentId);}
 const r=registration("Contact",contact,{departmentId:"EVELYN_CEO",module:{contractVersion:autonomousModuleContract,readFields:["name","organizationId"],writeFields:[],relatedResources:{},lifecycleMode:"EXISTING"}});await provision(r);const result=await call(r.grantId);assert.equal(result.status,200,JSON.stringify(result.body));assert.deepEqual(Object.keys(result.body.data).sort(),["name","organizationId","updatedAt","version"]);
});

test("assigned Contact, Company, Project, Unit, qualification, calendar and timeline commands preserve field and version rules",async()=>{
 const cases:Array<{entity:AutonomousModuleEntity;id:string;departmentId:AutonomousCrmRegistration["departmentId"];scope:string;patch:Record<string,unknown>}>=[
  {entity:"Contact",id:contact,departmentId:"SALES",scope:"contacts",patch:{name:"SYNTHETIC contact changed"}},
  {entity:"Company",id:company,departmentId:"BUSINESS_DEVELOPMENT",scope:"companies",patch:{name:"SYNTHETIC company changed"}},
  {entity:"Project",id:project,departmentId:"PROJECT_MANAGEMENT",scope:"projects",patch:{description:"SYNTHETIC delivery detail"}},
  {entity:"Unit",id:unit,departmentId:"REAL_ESTATE_OPERATIONS",scope:"units",patch:{livingAreaSqm:62}},
  {entity:"Qualification",id:lead,departmentId:"SALES",scope:"qualifications",patch:{budgetFrom:100,budgetTo:200,financingStatus:"offen",purchaseTimeline:"SYNTHETIC 12 months",useCase:"Eigennutzung",desiredLocation:"SYNTHETIC Vienna"}},
  {entity:"Appointment",id:appointment,departmentId:"SECRETARIAT_ADMINISTRATION",scope:"appointments",patch:{note:"SYNTHETIC preparation"}},
  {entity:"Communication",id:communication,departmentId:"SUPPORT",scope:"communications",patch:{summary:"SYNTHETIC internal timeline correction"}},
 ];
 for(const c of cases){const rf=autonomousModuleFields[c.entity].filter(f=>f!=="version"),r=registration(c.entity,c.id,{departmentId:c.departmentId,scopes:[`crm.${c.scope}.read`,`crm.${c.scope}.write`],module:{contractVersion:autonomousModuleContract,readFields:rf,writeFields:Object.keys(c.patch),relatedResources:c.entity==="Qualification"?{unitId:unit,contactId:contact}:{},lifecycleMode:"EXISTING"}});await provision(r);
  const current=await call(r.grantId);assert.equal(current.status,200,`${c.entity}:${JSON.stringify(current.body)}`);const command=body("Update",c.patch,current.body.data.version),result=await call(r.grantId,command);assert.equal(result.status,200,`${c.entity}:${JSON.stringify(result.body)}`);assert.equal(result.body.data.version,current.body.data.version+1);for(const[f,v]of Object.entries(c.patch))assert.deepEqual(result.body.data[f],v);
  if(c.entity==="Qualification"){const replay=await call(r.grantId,command);assert.equal(replay.status,200,JSON.stringify(replay.body));assert.equal(replay.body.replayed,true);assert.equal(replay.body.data.version,result.body.data.version);}
 }
 const prices=(await db.admin.query("select price_cents,status from property_units where id=$1",[unit])).rows[0];assert.equal(prices.price_cents,"12300");assert.equal(prices.status,"available");
 const qualified=(await db.admin.query("select status,sales_qualification from leads where id=$1",[lead])).rows[0];assert.equal(qualified.status,"Qualifiziert");assert.equal(qualified.sales_qualification.complete,true);
});

test("fixed new Contact, Company, Unit, lead, appointment and timeline records have no implicit consent or external effect",async()=>{
 const definitions:Array<{entity:AutonomousModuleEntity;departmentId:AutonomousCrmRegistration["departmentId"];scope:string;patch:Record<string,unknown>;readFields:string[];relations?:Record<string,string>}>= [
  {entity:"Contact",departmentId:"SALES",scope:"contacts",patch:{name:"SYNTHETIC new contact",relationshipRole:"Käufer"},readFields:["name"]},
  {entity:"Company",departmentId:"BUSINESS_DEVELOPMENT",scope:"companies",patch:{name:"SYNTHETIC new company",organizationType:"Unternehmen"},readFields:["name"]},
  {entity:"Unit",departmentId:"REAL_ESTATE_OPERATIONS",scope:"units",patch:{unitNumber:"SYNTHETIC-new",floor:2,rooms:3,livingAreaSqm:70},readFields:["unitNumber","priceCents","status"]},
  {entity:"BuyerLead",departmentId:"SALES",scope:"leads",patch:{source:"Manual"},readFields:["contactId","status","source"],relations:{contactId:contact}},
  {entity:"Appointment",departmentId:"SECRETARIAT_ADMINISTRATION",scope:"appointments",patch:{title:"SYNTHETIC local calendar",startsAt:"2031-01-01T10:00:00Z",endsAt:"2031-01-01T11:00:00Z"},readFields:["title","startsAt","endsAt","status"]},
  {entity:"Communication",departmentId:"SUPPORT",scope:"communications",patch:{summary:"SYNTHETIC internal note"},readFields:["summary","direction","channel"],relations:{contactId:contact}},
 ];
 for(const c of definitions){const id=randomUUID(),r=registration(c.entity,id,{departmentId:c.departmentId,scopes:[`crm.${c.scope}.read`,`crm.${c.scope}.create`],module:{contractVersion:autonomousModuleContract,readFields:c.readFields,writeFields:Object.keys(c.patch),relatedResources:c.relations??{},lifecycleMode:"CREATE"}});await provision(r);
  const b=body("Create",c.patch),result=await call(r.grantId,b);
  assert.equal(result.status,200,`${c.entity}:${JSON.stringify(result.body)}`);assert.equal(result.body.sourceId,id);assert.equal(result.body.data.version,1);assert.equal((await call(r.grantId,b)).body.replayed,true);
  if(c.entity==="Contact")assert.equal((await db.admin.query("select consent_label from contacts where id=$1",[id])).rows[0].consent_label,"Nur CRM");
  if(c.entity==="Communication")assert.equal(result.body.data.direction,"internal");
  if(c.entity==="Unit"){assert.equal(result.body.data.priceCents,null);assert.equal(result.body.data.status,"blocked");}
 }
});

test("registered subagents can only narrow a bounded parent and server revocation survives a queued-command race",async()=>{
 const parent=registration("Task",task,{scopes:["crm.tasks.read","crm.tasks.write"],module:{contractVersion:autonomousModuleContract,readFields:["title","status"],writeFields:["title"],relatedResources:{},lifecycleMode:"EXISTING"}});await provision(parent);
 const child=registration("Task",task,{agentId:"synthetic.sales.subagent",scopes:["crm.tasks.read","crm.tasks.write"],module:{contractVersion:autonomousModuleContract,readFields:["title"],writeFields:["title"],relatedResources:{},lifecycleMode:"EXISTING",delegationKind:"SUBAGENT",parentGrantId:parent.grantId}});await provision(child);assert.equal((await call(child.grantId)).status,200);const description=await call(child.grantId,body("DescribeAssignment"));assert.equal(description.body.data.parentGrantId,parent.grantId);assert.equal(description.body.data.delegationKind,"SUBAGENT");
 const broad={...child,grantId:randomUUID(),module:{...child.module!,readFields:["title","description"]}};await assert.rejects(provision(broad),/AUTONOMOUS_SCOPE_NOT_GRANTED/);
 const missing={...child,grantId:randomUUID(),module:{...child.module!,parentGrantId:null}};await assert.rejects(provision(missing),/AUTONOMOUS_REGISTRATION_INVALID/);
 const current=await call(child.grantId),b=body("Update",{title:"SYNTHETIC parent-race must not commit"},current.body.data.version);
 const lock=await db.admin.connect();try{
  await lock.query("begin");await lock.query("select pg_advisory_xact_lock(hashtextextended($1,0))",[`crm-command:${CRM_MACHINE_WORKSPACE_ID}:${b.idempotencyKey}`]);
  const pending=call(child.grantId,b);let waiter=false;
  for(let i=0;i<100;i++){const rows=(await db.admin.query("select 1 from pg_stat_activity where wait_event_type='Lock' and query like 'select pg_advisory_xact_lock%' and pid<>pg_backend_pid()")).rows;if(rows.length){waiter=true;break;}await delay(10);}
  assert.equal(waiter,true,"actual child waits for canonical command lock");
  await db.admin.query("update crm_autonomous_access_grants set revoked_at=clock_timestamp() where id=$1",[parent.grantId]);await lock.query("commit");
  const result=await pending;assert.equal(result.status,403,JSON.stringify(result.body));assert.equal((await db.admin.query("select count(*) from crm_command_receipts where idempotency_key=$1",[b.idempotencyKey])).rows[0].count,"0");assert.equal((await call(child.grantId)).status,403);
 }finally{await lock.query("rollback");lock.release();}
 const parent2=registration("Task",task);await provision(parent2);const child2=registration("Task",task,{module:{...parent2.module!,delegationKind:"SUBAGENT",parentGrantId:parent2.grantId}});await provision(child2);
 await db.admin.query("update crm_autonomous_access_grants set expires_at=clock_timestamp()+interval '50 milliseconds' where id=$1",[parent2.grantId]);await delay(75);assert.equal((await call(child2.grantId)).status,403);
});

test("native offer preparation binds its exact new ID and retains genuine approval requirements",async()=>{
 const deal=randomUUID(),offer=randomUUID();await db.admin.query("insert into deals(id,workspace_id,project_id,contact_id,organization_id,lead_id,owner_user_id,name,stage) values($1,$2,$3,$4,$5,$6,$7,'SYNTHETIC scoped deal','Qualifizieren')",[deal,CRM_MACHINE_WORKSPACE_ID,project,contact,company,lead,actor]);
 const r=registration("Offer",offer,{scopes:["crm.offers.read","crm.offers.prepare"],module:{contractVersion:autonomousModuleContract,readFields:["title","content","status"],writeFields:["content"],relatedResources:{dealId:deal,leadId:lead,contactId:contact,organizationId:company},lifecycleMode:"CREATE"}});await provision(r);
 const content={subject:"SYNTHETIC offer",recipientName:"SYNTHETIC buyer",recipientEmail:"synthetic@example.invalid",scope:"SYNTHETIC internal scoped proposal",paymentPlan:"SYNTHETIC draft",discounts:"SYNTHETIC none",specialTerms:"SYNTHETIC none",riskComplianceNotes:"SYNTHETIC no real delivery",terms:"SYNTHETIC draft only",validUntil:new Date(Date.now()+86400000).toISOString(),currency:"EUR",taxBasis:"NET",items:[{description:"SYNTHETIC work",quantity:1,unitNetCents:1000}]};
 const b=body("PrepareOffer",{content},1),first=await call(r.grantId,b);assert.equal(first.status,200,JSON.stringify(first.body));assert.equal(first.body.sourceId,offer);assert.equal(first.body.data.status,"DRAFT");assert.equal(first.body.data.content.subject,content.subject);assert.equal((await call(r.grantId,b)).body.replayed,true);
 assert.equal((await db.admin.query("select count(*) from crm_offer_deliveries where offer_id=$1",[offer])).rows[0].count,"0");
});

test("native reservation preparation keeps the unit unreserved and respects qualification/handover",async()=>{
 const reservation=randomUUID(),current=(await db.admin.query("select version from leads where id=$1",[lead])).rows[0];
 await db.admin.query("insert into lead_sales_handovers(workspace_id,project_id,lead_id,qualification_version,recipient_user_id,actor_id,source_reference) values($1,$2,$3,$4,$5,$5,'SYNTHETIC existing handover')",[CRM_MACHINE_WORKSPACE_ID,project,lead,current.version,actor]);
 const unitVersion=Number((await db.admin.query("select version from property_units where id=$1",[unit])).rows[0].version);
 const r=registration("Reservation",reservation,{scopes:["crm.reservations.read","crm.reservations.prepare"],module:{contractVersion:autonomousModuleContract,readFields:["unitId","contactId","status","expiresAt","nextAction"],writeFields:["unitId","contactId","leadId","expiresAt","unitVersion"],relatedResources:{unitId:unit,leadId:lead,contactId:contact},lifecycleMode:"CREATE"}});await provision(r);
 const b=body("PrepareReservation",{unitId:unit,contactId:contact,leadId:lead,expiresAt:new Date(Date.now()+86400000).toISOString(),unitVersion},unitVersion),first=await call(r.grantId,b);assert.equal(first.status,200,JSON.stringify(first.body));assert.equal(first.body.sourceId,reservation);assert.equal(first.body.data.status,"requested");assert.equal((await call(r.grantId,b)).body.replayed,true);
 assert.equal((await db.admin.query("select status from property_units where id=$1",[unit])).rows[0].status,"available");
});

test("a bound Viewing uses native handover, recipient, unit and time-zone rules for retiming",async()=>{
 const id=randomUUID();await db.admin.query("insert into property_viewing_slots(id,workspace_id,project_id,unit_id,contact_id,lead_id,owner_user_id,starts_at,ends_at,status,time_zone) values($1,$2,$3,$4,$5,$6,$7,'2031-01-01T10:00:00Z','2031-01-01T11:00:00Z','planned','Europe/Vienna')",[id,CRM_MACHINE_WORKSPACE_ID,project,unit,contact,lead,actor]);
 const r=registration("Viewing",id,{scopes:["crm.viewings.read","crm.viewings.write"],module:{contractVersion:autonomousModuleContract,readFields:["startsAt","endsAt","status","unitId"],writeFields:["startsAt","endsAt"],relatedResources:{unitId:unit,contactId:contact,leadId:lead},lifecycleMode:"EXISTING"}});await provision(r);
 const before=await call(r.grantId);assert.equal(before.status,200,JSON.stringify(before.body));const changed=await call(r.grantId,body("Update",{startsAt:"2031-01-02T10:00:00Z",endsAt:"2031-01-02T11:00:00Z"},1));assert.equal(changed.status,200,JSON.stringify(changed.body));assert.equal(changed.body.data.version,2);assert.equal(changed.body.data.status,"planned");
});

test("a bound Sale projection reveals no mandate, bank, confirmation source or owner metadata",async()=>{
 const sale=randomUUID(),saleUnit=randomUUID(),reservation=randomUUID(),authority=randomUUID();
 await db.admin.query("insert into property_units(id,workspace_id,project_id,unit_number,status) values($1,$2,$3,'SYNTHETIC sale fixture','sold')",[saleUnit,CRM_MACHINE_WORKSPACE_ID,project]);
 await db.admin.query("insert into property_reservations(id,workspace_id,project_id,unit_id,contact_id,buyer_lead_id,status,expires_at) values($1,$2,$3,$4,$5,$6,'converted',now()+interval '1 day')",[reservation,CRM_MACHINE_WORKSPACE_ID,project,saleUnit,contact,lead]);
 await db.admin.query("insert into crm_project_sales_authorities(id,workspace_id,project_id,user_id,developer_organization_id,contact_id,assignment_source,assigned_by) values($1,$2,$3,$4,$5,$6,'SYNTHETIC seeded proof',$7)",[authority,CRM_MACHINE_WORKSPACE_ID,project,actor,company,contact,ownerId]);
 await db.admin.query("insert into property_sales(id,workspace_id,project_id,unit_id,reservation_id,buyer_lead_id,contact_id,authority_id,confirmed_by,source_reference,unit_version) values($1,$2,$3,$4,$5,$6,$7,$8,$9,'SYNTHETIC proof private source',2)",[sale,CRM_MACHINE_WORKSPACE_ID,project,saleUnit,reservation,lead,contact,authority,actor]);
 const r=registration("Sale",sale);await provision(r);const result=await call(r.grantId);assert.equal(result.status,200,JSON.stringify(result.body));assert.equal(result.body.data.status,"confirmed");assert.equal(result.body.data.version,2);assert.doesNotMatch(JSON.stringify(result.body),/source_reference|authority_id|SYNTHETIC proof private source/);
});

test("native reservation confirmation consumes a genuine exact owner decision and rolls it back when commercial authority fails",async()=>{
 const reservation=(await db.admin.query("select id,version from property_reservations where unit_id=$1 and status='requested'",[unit])).rows[0];assert.ok(reservation);
 const unitVersion=Number((await db.admin.query("select version from property_units where id=$1",[unit])).rows[0].version),decisionId=randomUUID();
 const r=registration("Reservation",reservation.id,{scopes:["crm.reservations.read","crm.reservations.confirm"],module:{contractVersion:autonomousModuleContract,readFields:["status","unitId"],writeFields:["approvalReference","unitVersion","sourceReference"],relatedResources:{unitId:unit},lifecycleMode:"EXISTING"}});await provision(r);
 const b=body("ConfirmReservation",{approvalReference:decisionId,unitVersion,sourceReference:"SYNTHETIC approved exact reservation"},Number(reservation.version));
 const absent=await call(r.grantId,b);assert.equal(absent.status,403,JSON.stringify(absent.body));assert.equal(absent.body.code,"APPROVAL_REQUIRED");
 await decideAutonomousBusinessAuthority(owner,{decision:"APPROVED",decisionId,grantId:r.grantId,command:b,expiresAt:new Date(Date.now()+60000).toISOString()},{pool:db.pool as unknown as TenantPool});
 const nativeDenied=await call(r.grantId,b);assert.equal(nativeDenied.status,403,JSON.stringify(nativeDenied.body));assert.equal((await db.admin.query("select count(*) from crm_autonomous_business_consumptions where decision_id=$1",[decisionId])).rows[0].count,"0");
 const developerContact=randomUUID();await db.admin.query("insert into contacts(id,workspace_id,project_id,organization_id,name,role) values($1,$2,$3,$4,'SYNTHETIC mandate contact','Bauträger')",[developerContact,CRM_MACHINE_WORKSPACE_ID,project,company]);
 await db.admin.query("update projects set developer_organization_id=$2 where id=$1",[project,company]);await db.admin.query("update crm_project_sales_authorities set contact_id=$4,can_confirm_reservation=true,can_confirm_sale=true,assigned_by=$5 where workspace_id=$1 and project_id=$2 and user_id=$3",[CRM_MACHINE_WORKSPACE_ID,project,actor,developerContact,ownerId]);
 const first=await call(r.grantId,b);assert.equal(first.status,200,JSON.stringify(first.body));assert.equal(first.body.data.status,"reserved");assert.equal(first.body.data.version,2);const replay=await call(r.grantId,b);assert.equal(replay.status,200,JSON.stringify(replay.body));assert.equal(replay.body.replayed,true);assert.equal(replay.body.auditReference,first.body.auditReference);assert.equal((await db.admin.query("select count(*) from crm_autonomous_business_consumptions where decision_id=$1",[decisionId])).rows[0].count,"1");
 await decideAutonomousBusinessAuthority(owner,{decision:"REVOKE",decisionId},{pool:db.pool as unknown as TenantPool});assert.equal((await call(r.grantId,b)).status,403);
});

test("native sale confirmation is planned-ID bound, separately owner-approved, atomic and receipt-idempotent",async()=>{
 const reservation=(await db.admin.query("select id,version from property_reservations where unit_id=$1 and status='reserved'",[unit])).rows[0];assert.ok(reservation);const id=randomUUID(),decisionId=randomUUID(),unitVersion=Number((await db.admin.query("select version from property_units where id=$1",[unit])).rows[0].version);
 const r=registration("Sale",id,{scopes:["crm.sales.read","crm.sales.confirm"],module:{contractVersion:autonomousModuleContract,readFields:["unitId","status","confirmedAt"],writeFields:["approvalReference","unitVersion","sourceReference"],relatedResources:{unitId:unit,reservationId:reservation.id},lifecycleMode:"CREATE"}});await provision(r);
 const b=body("ConfirmSale",{approvalReference:decisionId,unitVersion,sourceReference:"SYNTHETIC approved exact sale"},Number(reservation.version));assert.equal((await call(r.grantId,b)).status,403);
 await decideAutonomousBusinessAuthority(owner,{decision:"APPROVED",decisionId,grantId:r.grantId,command:b,expiresAt:new Date(Date.now()+60000).toISOString()},{pool:db.pool as unknown as TenantPool});
 const first=await call(r.grantId,b);assert.equal(first.status,200,JSON.stringify(first.body));assert.equal(first.body.sourceId,id);assert.equal(first.body.data.status,"confirmed");assert.equal((await call(r.grantId,b)).body.replayed,true);assert.equal((await db.admin.query("select count(*) from property_sales where id=$1",[id])).rows[0].count,"1");assert.equal((await db.admin.query("select status from property_units where id=$1",[unit])).rows[0].status,"sold");
});

test("offer queue requires separate exact human quality attestation, owner decision, native approval and consent",async()=>{
 const offer=(await db.admin.query("select id,deal_id,version from crm_offers limit 1")).rows[0];assert.ok(offer);
 const r=registration("Offer",offer.id,{scopes:["crm.offers.read","crm.offers.send"],module:{contractVersion:autonomousModuleContract,readFields:["title","status"],writeFields:[],relatedResources:{},lifecycleMode:"EXISTING"}});await provision(r);
 const firstBody=body("SendOffer",{},Number(offer.version)),firstDecision=randomUUID(),firstQuality=randomUUID();
 const makeDecision=(decision:string,decisionId:string,b:ReturnType<typeof body>)=>decideAutonomousBusinessAuthority(owner,{decision,decisionId,grantId:r.grantId,command:b,expiresAt:new Date(Date.now()+60000).toISOString()},{pool:db.pool as unknown as TenantPool});
 await makeDecision("APPROVED",firstDecision,firstBody);const noQuality=await call(r.grantId,firstBody);assert.equal(noQuality.status,403,JSON.stringify(noQuality.body));assert.equal(noQuality.body.code,"APPROVAL_REQUIRED");
 await makeDecision("ATTEST_OFFER_QUALITY",firstQuality,firstBody);const noNative=await call(r.grantId,firstBody);assert.equal(noNative.status,409,JSON.stringify(noNative.body));assert.equal((await db.admin.query("select count(*) from crm_autonomous_business_consumptions where decision_id=$1",[firstDecision])).rows[0].count,"0");
 const options={pool:db.pool as unknown as TenantPool},view=await getOfferWorkflow(owner,offer.deal_id,options);assert.ok(view.offer);
 await executeOfferCommand(owner,{operation:"approve",projectId:project,offerId:offer.id,expectedVersion:view.offer.version,payload:{revision:view.offer.revision,contentDigest:view.offer.contentDigest,expiresAt:new Date(Date.now()+3600000).toISOString()},idempotencyKey:randomUUID(),correlationId:randomUUID()},options);
 await db.admin.query("update contacts set consent_label='Opt-in' where id=$1",[contact]);
 const now=(await db.admin.query("select version from crm_offers where id=$1",[offer.id])).rows[0],b=body("SendOffer",{},Number(now.version)),decisionId=randomUUID(),qualityId=randomUUID();await makeDecision("APPROVED",decisionId,b);await makeDecision("ATTEST_OFFER_QUALITY",qualityId,b);
 const first=await call(r.grantId,b);assert.equal(first.status,200,JSON.stringify(first.body));assert.equal(first.body.data.status,"QUEUED");const replay=await call(r.grantId,b);assert.equal(replay.status,200,JSON.stringify(replay.body));assert.equal(replay.body.replayed,true);assert.equal(replay.body.auditReference,first.body.auditReference);
 const deliveries=(await db.admin.query("select status from crm_offer_deliveries where offer_id=$1",[offer.id])).rows;assert.equal(deliveries.length,1);assert.equal(deliveries[0].status,"QUEUED");
 const approval=(await db.admin.query("select approval_id from crm_offers where id=$1",[offer.id])).rows[0],approvalGrant=registration("ApprovalReference",approval.approval_id);await provision(approvalGrant);const reference=await call(approvalGrant.grantId);assert.equal(reference.status,200,JSON.stringify(reference.body));assert.equal(reference.body.data.status,"APPROVED");assert.equal(reference.body.data.action,"offer.send");assert.doesNotMatch(JSON.stringify(reference.body),/auth_session|actor_id|recipientEmail/);
 await decideAutonomousBusinessAuthority(owner,{decision:"REVOKE_OFFER_QUALITY",decisionId:qualityId},options);assert.equal((await call(r.grantId,b)).status,403);
});

test("full gateway concurrent approved confirmations use native lock order and commit exactly one effect",async()=>{
 const u=randomUUID(),res=randomUUID();await db.admin.query("insert into property_units(id,workspace_id,project_id,unit_number,status) values($1,$2,$3,'SYNTHETIC concurrency unit','available')",[u,CRM_MACHINE_WORKSPACE_ID,project]);await db.admin.query("insert into property_reservations(id,workspace_id,project_id,unit_id,contact_id,buyer_lead_id,status,expires_at) values($1,$2,$3,$4,$5,$6,'requested',now()+interval '1 day')",[res,CRM_MACHINE_WORKSPACE_ID,project,u,contact,lead]);
 const r=registration("Reservation",res,{scopes:["crm.reservations.read","crm.reservations.confirm"],module:{contractVersion:autonomousModuleContract,readFields:["status"],writeFields:["approvalReference","unitVersion","sourceReference"],relatedResources:{unitId:u},lifecycleMode:"EXISTING"}});await provision(r);
 const commands=[body("ConfirmReservation",{approvalReference:randomUUID(),unitVersion:1,sourceReference:"SYNTHETIC first concurrency mandate"},1),body("ConfirmReservation",{approvalReference:randomUUID(),unitVersion:1,sourceReference:"SYNTHETIC second concurrency mandate"},1)];
 for(const b of commands)await decideAutonomousBusinessAuthority(owner,{decision:"APPROVED",decisionId:b.patch.approvalReference,grantId:r.grantId,command:b,expiresAt:new Date(Date.now()+60000).toISOString()},{pool:db.pool as unknown as TenantPool});
 const lock=await db.admin.connect();try{
  await lock.query("begin");await lock.query("select id from property_reservations where id=$1 for update",[res]);const pending=commands.map(b=>call(r.grantId,b));let waiters=0;
  for(let i=0;i<100;i++){waiters=Number((await db.admin.query("select count(*) from pg_stat_activity where wait_event_type='Lock' and query like '%public.crm_consume_autonomous_business%' and pid<>pg_backend_pid()")).rows[0].count);if(waiters===2)break;await delay(10);}assert.equal(waiters,2,"both actual requests wait at their native reservation source lock");
  await lock.query("commit");const results=await Promise.all(pending);assert.deepEqual(results.map(r=>r.status).sort(),[200,409],JSON.stringify(results));assert.equal(results.find(r=>r.status===409)?.body.code,"VERSION_CONFLICT");
  assert.equal((await db.admin.query("select version from property_reservations where id=$1",[res])).rows[0].version,"2");assert.equal((await db.admin.query("select count(*) from crm_autonomous_business_consumptions where grant_id=$1",[r.grantId])).rows[0].count,"1");
 }finally{await lock.query("rollback");lock.release();}
});

test("native preparation cannot follow changed unassigned deal/organization associations",async()=>{
 const deal=randomUUID(),offer=randomUUID(),otherCompany=randomUUID();await db.admin.query("insert into organizations(id,workspace_id,project_id,name,type) values($1,$2,$3,'SYNTHETIC unassigned organization','Unternehmen')",[otherCompany,CRM_MACHINE_WORKSPACE_ID,project]);await db.admin.query("insert into deals(id,workspace_id,project_id,contact_id,organization_id,lead_id,name,stage) values($1,$2,$3,$4,$5,$6,'SYNTHETIC relation drift','Qualifizieren')",[deal,CRM_MACHINE_WORKSPACE_ID,project,contact,company,lead]);
 const r=registration("Offer",offer,{scopes:["crm.offers.read","crm.offers.prepare"],module:{contractVersion:autonomousModuleContract,readFields:["status"],writeFields:["content"],relatedResources:{dealId:deal,contactId:contact,leadId:lead,organizationId:company},lifecycleMode:"CREATE"}});await provision(r);
 const content=(await db.admin.query("select content from crm_offer_revisions limit 1")).rows[0].content;
 try{await db.admin.query("update deals set organization_id=$2 where id=$1",[deal,otherCompany]);await db.admin.query("update contacts set organization_id=$2 where id=$1",[contact,otherCompany]);
  const version=Number((await db.admin.query("select version from deals where id=$1",[deal])).rows[0].version),result=await call(r.grantId,body("PrepareOffer",{content},version));assert.equal(result.status,403,JSON.stringify(result.body));assert.equal(result.body.code,"RELATION_NOT_ASSIGNED");assert.equal((await db.admin.query("select count(*) from crm_offers where id=$1",[offer])).rows[0].count,"0");
 }finally{await db.admin.query("update contacts set organization_id=$2 where id=$1",[contact,company]);}
});

test("the protected Communication SQL helper masks every ungranted business field itself",async()=>{
 const r=registration("Communication",communication,{module:{contractVersion:autonomousModuleContract,readFields:["channel"],writeFields:[],relatedResources:{},lifecycleMode:"EXISTING"}});await provision(r);
 const raw=await withTenantTransaction({workspaceId:CRM_MACHINE_WORKSPACE_ID,actorId:actor},tx=>tx.queryOne<Record<string,unknown>>("select * from public.crm_read_autonomous_communication($1)",[r.grantId]),{pool:db.pool as unknown as TenantPool});assert.ok(raw);assert.equal(raw.channel,"Webchat");for(const key of ["contact_id","lead_id","direction","summary","last_message_at"])assert.equal(raw[key],null,key);
});

/** Test-only shared fixture for the separately invoked cross-repository proof.
 * No production route imports this module; it never reads an environment DB URL. */
export function autonomousPairedFixture(){return {db,registration,provision,body,ids:{actor,workload,project,mission,task,workspace:CRM_MACHINE_WORKSPACE_ID}};}
