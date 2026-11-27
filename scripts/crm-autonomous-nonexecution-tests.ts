import assert from "node:assert/strict";
import {generateKeyPairSync,randomUUID,sign} from "node:crypto";
import {readFile} from "node:fs/promises";
import {setTimeout as delay} from "node:timers/promises";
import {test} from "node:test";
import {SignJWT,jwtVerify,type JWTVerifyOptions} from "jose";
import {autonomousPairedFixture} from "./crm-autonomous-modules-tests";
import {handleAutonomousCrmModules} from "../src/lib/crm-autonomous-modules";
import {handleAutonomousCrmNonexecution,autonomousNonexecutionDomain} from "../src/lib/crm-autonomous-nonexecution";
import {crmPayloadDigest} from "../src/lib/crm-command";
import {decideAutonomousBusinessAuthority} from "../src/lib/crm-autonomous-business-authority";
import {executeOfferCommand,getOfferWorkflow} from "../src/lib/db/offer-repositories";
import {CRM_MACHINE_AUDIENCE,CRM_MACHINE_ISSUER,CRM_MACHINE_OWNER_ID,CRM_MACHINE_PROJECT_ID,CRM_MACHINE_SUBJECT,type CrmMachineAuthOptions} from "../src/lib/crm-machine-auth";
import type {AutonomousCrmRegistration} from "../src/lib/crm-autonomous-registration";
import type {TenantPool} from "../src/lib/db/tenant-client";
type F=ReturnType<typeof autonomousPairedFixture>;
let f:F;
const recovery=generateKeyPairSync("ed25519"),rsa=generateKeyPairSync("rsa",{modulusLength:2048}),controlProject=randomUUID();
const publicKey=recovery.publicKey.export({format:"der",type:"spki"}).toString("base64url");
const auth=():CrmMachineAuthOptions=>({env:{CRM_MACHINE_AUTH_ENABLED:"1",CRM_AUTONOMOUS_NONEXECUTION_ENABLED:"1",VERCEL_ENV:"production",NODE_ENV:"production"},verifier:async(t,o)=>jwtVerify(t,rsa.publicKey,o as JWTVerifyOptions) as ReturnType<NonNullable<CrmMachineAuthOptions["verifier"]>>});
async function tokenWithLifetime(lifetime=60){const now=Math.floor(Date.now()/1000);return new SignJWT({iss:CRM_MACHINE_ISSUER,aud:CRM_MACHINE_AUDIENCE,sub:CRM_MACHINE_SUBJECT,project_id:CRM_MACHINE_PROJECT_ID,owner_id:CRM_MACHINE_OWNER_ID,environment:"production",iat:now,nbf:now,exp:now+lifetime,jti:randomUUID()}).setProtectedHeader({alg:"RS256",typ:"JWT",kid:"synthetic-recovery-rsa"}).sign(rsa.privateKey);}
async function token(){return tokenWithLifetime();}
async function authority(grantId:string,key=publicKey){const id=randomUUID();await f.db.admin.query("insert into crm_autonomous_recovery_authorities(id,workload_id,control_project_id,grant_ids,recovery_public_key,authority_reference,expires_at) values($1,$2,$3,array[$4::uuid],$5,'SYNTHETIC fixed recovery authority',clock_timestamp()+interval '1 hour')",[id,f.ids.workload,controlProject,grantId,key]);return id;}
function binding(r:AutonomousCrmRegistration,b:ReturnType<F["body"]>){return {grantId:r.grantId,workspaceId:f.ids.workspace,sourceId:r.sourceId,taskId:r.taskId,departmentId:r.departmentId,agentId:r.agentId,entity:r.entity,crmProjectId:r.projectId,controlProjectId:controlProject,missionId:randomUUID(),attemptId:randomUUID(),effectId:randomUUID(),registryVersion:"1",targetDigest:"a".repeat(64),artifactDigest:"b".repeat(64),requestDigest:crmPayloadDigest(b)};}
type B=ReturnType<typeof binding>;
function envelope(id:string,b:B,extra:Record<string,unknown>={}){const now=Math.floor(Date.now()/1000),p=Buffer.from(JSON.stringify({...b,issuedAt:now,expiresAt:now+60,nonce:randomUUID(),...extra})).toString("base64url");return `v1.${id}.${p}.${sign(null,Buffer.from(`${autonomousNonexecutionDomain}.${id}.${p}`),recovery.privateKey).toString("base64url")}`;}
async function close(id:string,b:B,body:ReturnType<F["body"]>,headers:Record<string,string>={}){const response=await handleAutonomousCrmNonexecution(new Request("https://crm.invalid/api/integrations/evelyn/access",{method:"POST",headers:{authorization:`Bearer ${await token()}`,"content-type":"application/json","x-evelyn-close-without-effect":"1","x-evelyn-recovery":envelope(id,b),...headers},body:JSON.stringify(body)}),{pool:f.db.pool as unknown as TenantPool,machineAuth:auth()});return {status:response.status,body:await response.json()};}
function taskRegistration(sourceId:string,lifecycleMode:"CREATE"|"EXISTING"="EXISTING"){return f.registration("Task",sourceId,{scopes:["crm.tasks.read",lifecycleMode==="CREATE"?"crm.tasks.create":"crm.tasks.write"],module:{contractVersion:"crm-autonomous-access-v2",readFields:["title"],writeFields:["title"],relatedResources:{},lifecycleMode}});}
async function install(){f=autonomousPairedFixture();await f.db.admin.query("alter table crm_command_receipts owner to autonomous_modules_installer");const sql=await readFile("migrations/staged/evelyn_autonomous_nonexecution.sql","utf8");const c=await f.db.admin.connect();try{await c.query("begin");await c.query("set local role autonomous_modules_installer");await c.query(sql);await c.query("commit");}finally{await c.query("rollback");c.release();}}
async function invoke(r:AutonomousCrmRegistration,body:ReturnType<F["body"]>,writes:string[]=[]){
 const pool={connect:async()=>{const c=await f.db.pool.connect();return {query:async(query:unknown,params?:unknown[])=>{
  const result=await c.query(query as string,params);const text=typeof query==="string"?query:"";
  if(/^\s*(insert into|update) (tasks|crm_offers|crm_offer_deliveries|property_units|property_reservations|property_sales)\b/i.test(text))writes.push(text.split(/[\s(]+/).slice(0,3).join(" "));
  return result;},release:(destroy?:boolean)=>c.release(destroy)};}} as unknown as TenantPool;
 const response=await handleAutonomousCrmModules(new Request("https://crm.invalid/api/integrations/evelyn/access",{method:"POST",headers:{authorization:`Bearer ${await token()}`,"content-type":"application/json","x-evelyn-delegation":f.signature(r.grantId,body)},body:JSON.stringify(body)}),{pool,machineAuth:{...auth(),env:{...auth().env,NODE_ENV:"production",CRM_AUTONOMOUS_NONEXECUTION_ENABLED:"0"}}});return {status:response.status,body:await response.json()};
}
async function snapshot(){const out:Record<string,string>={};for(const table of ["tasks","property_units","property_reservations","property_sales","crm_offers","crm_offer_revisions","crm_offer_deliveries","crm_command_receipts","crm_autonomous_access_events","crm_autonomous_business_consumptions","consent_policy_decisions","audit_logs"]){out[table]=(await f.db.admin.query(`select md5(coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text)::text,'[]')) as digest from ${table} t`)).rows[0].digest;}return out;}
async function approve(r:AutonomousCrmRegistration,b:ReturnType<F["body"]>,decision="APPROVED",decisionId=String(b.patch.approvalReference??randomUUID())){return decideAutonomousBusinessAuthority(f.owner,{decision,decisionId,grantId:r.grantId,command:b,expiresAt:new Date(Date.now()+60000).toISOString()},{pool:f.db.pool as unknown as TenantPool});}
async function reservationFixture(){const unit=randomUUID(),id=randomUUID();await f.db.admin.query("insert into property_units(id,workspace_id,project_id,unit_number,status,price_cents,area_sqm,rooms,floor) values($1::uuid,$2,$3,'SYNTHETIC rollback unit '||($1::uuid)::text,'available',12300,50,2,1)",[unit,f.ids.workspace,f.ids.project]);await f.db.admin.query("insert into property_reservations(id,workspace_id,project_id,unit_id,contact_id,buyer_lead_id,status,expires_at) values($1,$2,$3,$4,$5,$6,'requested',now()+interval '1 day')",[id,f.ids.workspace,f.ids.project,unit,f.ids.contact,f.ids.lead]);return {id,unit};}
function reservationRegistration(id:string,unit:string){return f.registration("Reservation",id,{scopes:["crm.reservations.read","crm.reservations.confirm"],module:{contractVersion:"crm-autonomous-access-v2",readFields:["status"],writeFields:["approvalReference","unitVersion","sourceReference"],relatedResources:{unitId:unit},lifecycleMode:"EXISTING"}});}
async function operationFixture(operation:string){
 if(operation==="Create"||operation==="Update"){
  const id=randomUUID();if(operation==="Update")await f.db.admin.query("insert into tasks(id,workspace_id,project_id,owner_user_id,title) values($1,$2,$3,$4,'SYNTHETIC rollback task')",[id,f.ids.workspace,f.ids.project,f.ids.actor]);
  const r=taskRegistration(id,operation==="Create"?"CREATE":"EXISTING");await f.provision(r);return {r,body:f.body(operation,{title:"SYNTHETIC must rollback"},operation==="Create"?null:1)};
 }
 if(operation==="PrepareOffer"||operation==="SendOffer"){
  const id=randomUUID(),deal=randomUUID();await f.db.admin.query("insert into deals(id,workspace_id,project_id,contact_id,organization_id,lead_id,name,stage) values($1,$2,$3,$4,$5,$6,'SYNTHETIC rollback deal','Qualifizieren')",[deal,f.ids.workspace,f.ids.project,f.ids.contact,f.ids.company,f.ids.lead]);
  const content=(await f.db.admin.query("select content from crm_offer_revisions limit 1")).rows[0].content;
  if(operation==="PrepareOffer"){
   const r=f.registration("Offer",id,{scopes:["crm.offers.read","crm.offers.prepare"],module:{contractVersion:"crm-autonomous-access-v2",readFields:["status"],writeFields:["content"],relatedResources:{dealId:deal,contactId:f.ids.contact,leadId:f.ids.lead,organizationId:f.ids.company},lifecycleMode:"CREATE"}});await f.provision(r);return {r,body:f.body(operation,{content},1)};
  }
  const options={pool:f.db.pool as unknown as TenantPool};await executeOfferCommand(f.owner,{operation:"create",offerId:id,dealId:deal,projectId:f.ids.project,expectedVersion:1,idempotencyKey:randomUUID(),correlationId:randomUUID(),payload:{content,leadId:f.ids.lead}},options);
  const view=await getOfferWorkflow(f.owner,deal,options);assert.ok(view.offer);await executeOfferCommand(f.owner,{operation:"approve",offerId:id,projectId:f.ids.project,expectedVersion:view.offer.version,idempotencyKey:randomUUID(),correlationId:randomUUID(),payload:{revision:view.offer.revision,contentDigest:view.offer.contentDigest,expiresAt:new Date(Date.now()+3600000).toISOString()}},options);
  const version=Number((await f.db.admin.query("select version from crm_offers where id=$1",[id])).rows[0].version),r=f.registration("Offer",id,{scopes:["crm.offers.read","crm.offers.send"],module:{contractVersion:"crm-autonomous-access-v2",readFields:["status"],writeFields:[],relatedResources:{},lifecycleMode:"EXISTING"}});await f.provision(r);
  const body=f.body(operation,{},version);await approve(r,body);await approve(r,body,"ATTEST_OFFER_QUALITY",randomUUID());return {r,body};
 }
 if(operation==="PrepareReservation"){
  const unit=randomUUID(),id=randomUUID();await f.db.admin.query("insert into property_units(id,workspace_id,project_id,unit_number,status,price_cents,area_sqm,rooms,floor) values($1,$2,$3,'SYNTHETIC prepare rollback unit','available',12300,50,2,1)",[unit,f.ids.workspace,f.ids.project]);
  await f.db.admin.query("update leads set sales_qualification=jsonb_set(sales_qualification,'{desiredUnitId}',to_jsonb($2::text)) where id=$1",[f.ids.lead,unit]);
  const r=f.registration("Reservation",id,{scopes:["crm.reservations.read","crm.reservations.prepare"],module:{contractVersion:"crm-autonomous-access-v2",readFields:["status"],writeFields:["unitId","contactId","leadId","expiresAt","unitVersion"],relatedResources:{unitId:unit,contactId:f.ids.contact,leadId:f.ids.lead},lifecycleMode:"CREATE"}});await f.provision(r);return {r,body:f.body(operation,{unitId:unit,contactId:f.ids.contact,leadId:f.ids.lead,expiresAt:new Date(Date.now()+86400000).toISOString(),unitVersion:1},1)};
 }
 const reservation=await reservationFixture(),rr=reservationRegistration(reservation.id,reservation.unit);await f.provision(rr);
 const rb=f.body("ConfirmReservation",{approvalReference:randomUUID(),unitVersion:1,sourceReference:"SYNTHETIC exact rollback mandate"},1);await approve(rr,rb);
 if(operation==="ConfirmReservation")return {r:rr,body:rb};
 const confirmed=await invoke(rr,rb);assert.equal(confirmed.status,200,JSON.stringify(confirmed.body));
 const id=randomUUID(),r=f.registration("Sale",id,{scopes:["crm.sales.read","crm.sales.confirm"],module:{contractVersion:"crm-autonomous-access-v2",readFields:["status"],writeFields:["approvalReference","unitVersion","sourceReference"],relatedResources:{unitId:reservation.unit,reservationId:reservation.id},lifecycleMode:"CREATE"}});await f.provision(r);
 const body=f.body("ConfirmSale",{approvalReference:randomUUID(),unitVersion:2,sourceReference:"SYNTHETIC exact rollback sale mandate"},2);await approve(r,body);return {r,body};
}

test("separate recovery signature fences missing intent, keeps stable metadata and blocks late old-handler SQL",async()=>{
 await install();
 const id=randomUUID();await f.db.admin.query("insert into tasks(id,workspace_id,project_id,owner_user_id,title) values($1,$2,$3,$4,'SYNTHETIC fence original')",[id,f.ids.workspace,f.ids.project,f.ids.actor]);
 const r=taskRegistration(id);await f.provision(r);const body=f.body("Update",{title:"SYNTHETIC late mutation"},1),a=await authority(r.grantId),b=binding(r,body);
 const first=await close(a,b,body);assert.equal(first.status,200,JSON.stringify(first.body));assert.equal(first.body.outcome,"NO_EFFECT");assert.equal(first.body.replayed,false);assert.equal("data" in first.body,false);
 const replay=await close(a,b,body);assert.equal(replay.status,200);assert.equal(replay.body.closureReference,first.body.closureReference);assert.equal(replay.body.auditReference,first.body.auditReference);assert.equal(replay.body.replayed,true);
 // Default old handler has no early-fence flag. Its callback attempts the SQL,
 // but the database receipt trigger rolls back the entire transaction.
 const late=await f.call(r.grantId,body);assert.notEqual(late.status,200);assert.deepEqual((await f.db.admin.query("select title,version from tasks where id=$1",[id])).rows[0],{title:"SYNTHETIC fence original",version:"1"});
 assert.equal((await f.db.admin.query("select count(*) from crm_command_receipts where idempotency_key=$1",[body.idempotencyKey])).rows[0].count,"0");
 const a2=await authority(r.grantId);const rotated=await close(a2,b,body);assert.equal(rotated.status,200);assert.equal(rotated.body.closureReference,first.body.closureReference);
 const changed=f.body("Update",{title:"SYNTHETIC changed"},1);changed.idempotencyKey=body.idempotencyKey;assert.equal((await close(a,binding(r,changed),changed)).status,409);
});
test("already committed full exact command recovers APPLIED metadata after grant expiry and identical reconcile events",async()=>{
 const id=randomUUID();await f.db.admin.query("insert into tasks(id,workspace_id,project_id,owner_user_id,title) values($1,$2,$3,$4,'SYNTHETIC committed original')",[id,f.ids.workspace,f.ids.project,f.ids.actor]);
 const r=taskRegistration(id);await f.provision(r);const body=f.body("Update",{title:"SYNTHETIC committed result"},1),first=await f.call(r.grantId,body);assert.equal(first.status,200,JSON.stringify(first.body));
 assert.equal((await f.reconcile(r.grantId,body)).status,200);assert.equal((await f.reconcile(r.grantId,body)).status,200);
 await f.db.admin.query("update crm_autonomous_access_grants set revoked_at=clock_timestamp() where id=$1",[r.grantId]);await f.db.admin.query("delete from tasks where id=$1",[id]);const a=await authority(r.grantId),b=binding(r,body),recovered=await close(a,b,body);
 const meta=await f.db.admin.query("select actor_user_id,project_id,resource_id,operation,correlation_id,data_classification,data_purpose from crm_command_receipts where workspace_id=$1 and idempotency_key=$2",[f.ids.workspace,body.idempotencyKey]);
 assert.equal(recovered.status,200,JSON.stringify({body:recovered.body,syntheticReceiptMetadata:meta.rows}));assert.equal(recovered.body.outcome,"APPLIED");assert.equal(recovered.body.replayed,true);assert.equal(recovered.body.auditReference,first.body.auditReference);assert.doesNotMatch(JSON.stringify(recovered.body),/committed result|data|version|updatedAt/);
});
test("foreign scope, body, mixed headers, expired proof and department keys cannot close; workload revocation is current",async()=>{
 const r=taskRegistration(randomUUID(),"CREATE");await f.provision(r);const body=f.body("Create",{title:"SYNTHETIC negative boundaries"}),a=await authority(r.grantId),b=binding(r,body);
 await assert.rejects(authority(r.grantId,r.publicKey),/RECOVERY_AUTHORITY_SCOPE_INVALID/);
 for(const changed of [{...b,grantId:randomUUID()},{...b,crmProjectId:randomUUID()},{...b,controlProjectId:randomUUID()},{...b,sourceId:randomUUID()},{...b,requestDigest:"0".repeat(64)}])assert.notEqual((await close(a,changed,body)).status,200);
 const mixed:Record<string,string>[]=[{"x-evelyn-delegation":f.signature(r.grantId,body)},{"x-evelyn-reconcile-only":"1"},{origin:"https://crm.invalid"},{"x-evelyn-recovery":envelope(a,b,{expiresAt:1})}];
 for(const headers of mixed)assert.notEqual((await close(a,b,body,headers)).status,200);
 const issuedAt=Math.floor(Date.now()/1000),overlong=await close(a,b,body,{"x-evelyn-recovery":envelope(a,b,{issuedAt,expiresAt:issuedAt+61})});assert.equal(overlong.status,401);assert.equal(overlong.body.code,"RECOVERY_SIGNATURE_INVALID");
 for(const [method,url] of [["PUT","https://crm.invalid/api/integrations/evelyn/access"],["POST","https://crm.invalid/api/integrations/evelyn/access?selector=foreign"],["POST","https://crm.invalid/api/integrations/other"]]){
  const result=await handleAutonomousCrmNonexecution(new Request(url!,{method,headers:{authorization:`Bearer ${await token()}`,"content-type":"application/json","x-evelyn-close-without-effect":"1","x-evelyn-recovery":envelope(a,b)},body:JSON.stringify(body)}),{pool:f.db.pool as unknown as TenantPool,machineAuth:auth()});assert.equal(result.status,400);
 }
 await f.db.admin.query("update crm_autonomous_workloads set disabled=true where id=$1",[f.ids.workload]);try{assert.notEqual((await close(a,b,body)).status,200);}finally{await f.db.admin.query("update crm_autonomous_workloads set disabled=false where id=$1",[f.ids.workload]);}
 assert.equal((await f.db.admin.query("select count(*) from crm_autonomous_nonexecution_closures where grant_id=$1",[r.grantId])).rows[0].count,"0");
});
test("every actual native mutation rolls back its successful SQL and outbox before a legacy handler can commit a fenced outer receipt",async t=>{
 for(const operation of ["Create","Update","PrepareOffer","PrepareReservation","SendOffer","ConfirmReservation","ConfirmSale"]){await t.test(operation,async()=>{
  const {r,body}=await operationFixture(operation),a=await authority(r.grantId),b=binding(r,body),fenced=await close(a,b,body);assert.equal(fenced.status,200,JSON.stringify(fenced.body));assert.equal(fenced.body.outcome,"NO_EFFECT");
  const before=await snapshot(),writes:string[]=[],late=await invoke(r,body,writes);assert.notEqual(late.status,200,JSON.stringify(late.body));assert.ok(writes.length>0,`${operation} must reach a successful actual business SQL before the outer receipt fence: ${JSON.stringify(late.body)}`);
  if(operation==="SendOffer")assert.ok(writes.some(s=>s.includes("crm_offer_deliveries")),"The real approved/consented outbox insert must have run");
  assert.deepEqual(await snapshot(),before,`${operation} left no business, approval-consumption, audit, native-receipt or outbox change`);
 });}
});
test("canonical SPKI, fresh nonce, immutable rows and denied direct table access protect the recovery capability",async()=>{
 const r=taskRegistration(randomUUID(),"CREATE");await f.provision(r);const body=f.body("Create",{title:"SYNTHETIC purpose boundary"}),a=await authority(r.grantId),b=binding(r,body);
 const alphabet="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_",alias=(p:string)=>p.slice(0,-1)+alphabet[(alphabet.indexOf(p.at(-1)!)+1)%64];
 assert.deepEqual(Buffer.from(alias(r.publicKey),"base64url"),Buffer.from(r.publicKey,"base64url"));await assert.rejects(authority(r.grantId,alias(r.publicKey)),/RECOVERY_AUTHORITY_SCOPE_INVALID/);await assert.rejects(authority(r.grantId,alias(publicKey)),/RECOVERY_AUTHORITY_SCOPE_INVALID/);
 const reuse=f.registration("Task",randomUUID(),{publicKey});await assert.rejects(f.provision(reuse),/DEPARTMENT_RECOVERY_KEY_COLLISION/);
 const personalReuse={...reuse,grantId:randomUUID(),workloadId:randomUUID(),sourceProfile:"FRANZ_PERSONAL" as const};await assert.rejects(f.provision(personalReuse),/DEPARTMENT_RECOVERY_KEY_COLLISION/);
 const personalKey=generateKeyPairSync("ed25519").publicKey.export({format:"der",type:"spki"}).toString("base64url"),personal={...personalReuse,grantId:randomUUID(),publicKey:personalKey};await f.provision(personal);await assert.rejects(authority(r.grantId,personalKey),/RECOVERY_AUTHORITY_SCOPE_INVALID/);
 const fixed=envelope(a,b);assert.equal((await close(a,b,body,{"x-evelyn-recovery":fixed})).status,200);const replay=await close(a,b,body,{"x-evelyn-recovery":fixed});assert.equal(replay.status,409);assert.equal(replay.body.code,"NONCE_REPLAY");
 const c=await f.db.pool.connect();try{for(const table of ["crm_autonomous_recovery_authorities","crm_autonomous_nonexecution_closures","crm_autonomous_recovery_events"])await assert.rejects(c.query(`select * from ${table}`),{code:"42501"});}finally{c.release();}
 await assert.rejects(f.db.admin.query("update crm_autonomous_nonexecution_closures set outcome='APPLIED' where grant_id=$1",[r.grantId]),/immutable/);
});
test("an inactive historical grant actor and absent business record do not prevent metadata-only fencing",async()=>{
 const actor=randomUUID();await f.db.admin.query("insert into workspace_users(id,workspace_id,name,email,role,product_role,status) values($1,$2,'SYNTHETIC historic actor',$3,'agent','novalure_operator','active')",[actor,f.ids.workspace,`historical-${actor}@service.invalid`]);
 await f.db.admin.query("insert into project_pipeline_permissions(workspace_id,project_id,user_id,can_read,can_edit_deals) values($1,$2,$3,true,true)",[f.ids.workspace,f.ids.project,actor]);
 const r={...taskRegistration(randomUUID(),"CREATE"),actorId:actor};await f.provision(r);const a=await authority(r.grantId),body=f.body("Create",{title:"SYNTHETIC never delivered"}),b=binding(r,body);
 await f.db.admin.query("update crm_autonomous_access_grants set revoked_at=clock_timestamp() where id=$1",[r.grantId]);await f.db.admin.query("update workspace_users set status='suspended' where id=$1",[actor]);
 const closed=await close(a,b,body);assert.equal(closed.status,200,JSON.stringify(closed.body));assert.equal(closed.body.outcome,"NO_EFFECT");assert.equal((await f.db.admin.query("select count(*) from tasks where id=$1",[r.sourceId])).rows[0].count,"0");
});
test("accepted uppercase legacy keys keep the exact same command lock and receipt identity",async()=>{
 const r=taskRegistration(randomUUID(),"CREATE");await f.provision(r);const body=f.body("Create",{title:"SYNTHETIC uppercase delayed intent"});body.idempotencyKey=body.idempotencyKey.toUpperCase() as typeof body.idempotencyKey;
 const a=await authority(r.grantId),b=binding(r,body),closed=await close(a,b,body);assert.equal(closed.status,200,JSON.stringify(closed.body));assert.equal(closed.body.outcome,"NO_EFFECT");assert.notEqual((await invoke(r,body)).status,200);assert.equal((await f.db.admin.query("select count(*) from tasks where id=$1",[r.sourceId])).rows[0].count,"0");
});
test("signature and JWT expiry are rechecked after the actual command lock without a real-clock wait",async t=>{
 for(const expired of ["signature","jwt"])await t.test(expired,async()=>{
  const r=taskRegistration(randomUUID(),"CREATE");await f.provision(r);const body=f.body("Create",{title:"SYNTHETIC lock expiry"}),a=await authority(r.grantId),b=binding(r,body),clock=new Date();
  const pool={connect:async()=>{const c=await f.db.pool.connect();return {query:async(query:unknown,params?:unknown[])=>{const result=await c.query(query as string,params);if(typeof query==="string"&&query.startsWith("select pg_advisory_xact_lock"))clock.setTime(Date.now()+(expired==="jwt"?30000:120000));return result;},release:(destroy?:boolean)=>c.release(destroy)};}} as unknown as TenantPool;
  const proof=envelope(a,b),response=await handleAutonomousCrmNonexecution(new Request("https://crm.invalid/api/integrations/evelyn/access",{method:"POST",headers:{authorization:`Bearer ${await tokenWithLifetime(expired==="jwt"?10:180)}`,"content-type":"application/json","x-evelyn-close-without-effect":"1","x-evelyn-recovery":proof},body:JSON.stringify(body)}),{pool,machineAuth:{...auth(),now:clock}});
  assert.equal(response.status,401);assert.equal((await response.json()).code,expired==="jwt"?"ACCESS_DENIED":"RECOVERY_SIGNATURE_INVALID");assert.equal((await f.db.admin.query("select count(*) from crm_autonomous_nonexecution_closures where grant_id=$1",[r.grantId])).rows[0].count,"0");
 });
});
test("conflicting event attribution or changed exact body cannot turn an existing receipt into a closure",async()=>{
 const id=randomUUID();await f.db.admin.query("insert into tasks(id,workspace_id,project_id,owner_user_id,title) values($1,$2,$3,$4,'SYNTHETIC attribution')",[id,f.ids.workspace,f.ids.project,f.ids.actor]);
 const r=taskRegistration(id);await f.provision(r);const body=f.body("Update",{title:"SYNTHETIC exact attribution"},1),applied=await invoke(r,body);assert.equal(applied.status,200,JSON.stringify(applied.body));const a=await authority(r.grantId);
 const changed={...body,patch:{title:"SYNTHETIC different body"}};assert.equal((await close(a,binding(r,changed),changed)).status,409);
 const other={...taskRegistration(id),agentId:"synthetic.other.attribution"};await f.provision(other);
 await f.db.admin.query("insert into crm_autonomous_access_events(grant_id,nonce,workspace_id,actor_user_id,department_id,agent_id,task_id,project_id,source_id,action,request_hash,oidc_jti_hash,audit_reference,outcome) values($1,$2,$3,$4,$5,$6,$7,$8,$9,'crm.tasks.write',$10,$11,$12,'SUCCESS')",[other.grantId,randomUUID(),f.ids.workspace,f.ids.actor,other.departmentId,other.agentId,other.taskId,other.projectId,other.sourceId,crmPayloadDigest(body),"0".repeat(64),applied.body.auditReference]);
 const denied=await close(a,binding(r,body),body);assert.equal(denied.status,409,JSON.stringify(denied.body));assert.equal((await f.db.admin.query("select count(*) from crm_autonomous_nonexecution_closures where grant_id=$1",[r.grantId])).rows[0].count,"0");
});
test("current recovery and workload revocations serialize before the command lock without lock inversion",async t=>{
 for(const table of ["crm_autonomous_recovery_authorities","crm_autonomous_workloads"])await t.test(table,async()=>{
  const r=taskRegistration(randomUUID(),"CREATE");await f.provision(r);const body=f.body("Create",{title:"SYNTHETIC revocation ordering"}),a=await authority(r.grantId),b=binding(r,body),held=await f.db.admin.connect(),revoker=await f.db.admin.connect();
  const wait=async(marker:string)=>{for(let i=0;i<200;i++){if(Number((await f.db.admin.query("select count(*) from pg_stat_activity where wait_event_type='Lock' and query like $1 and pid<>pg_backend_pid()",[`%${marker}%`])).rows[0].count)>0)return;await delay(10);}assert.fail("Expected local transaction did not queue at its lock");};
  try{
   await held.query("begin");await held.query("select pg_advisory_xact_lock(hashtextextended($1,0))",[`crm-command:${f.ids.workspace}:${body.idempotencyKey}`]);
   const pending=close(a,b,body);await wait("pg_advisory_xact_lock");
   await revoker.query("begin");await revoker.query("set local statement_timeout='5s'");const revoked=revoker.query(`update ${table} set disabled=true where id=$1`,[table==="crm_autonomous_workloads"?f.ids.workload:a]);await wait(`update ${table}`);
   await held.query("commit");const result=await pending;assert.equal(result.status,200,JSON.stringify(result.body));assert.equal(result.body.outcome,"NO_EFFECT");await revoked;await revoker.query("commit");assert.notEqual((await close(a,b,body)).status,200);
  }finally{await held.query("rollback");await revoker.query("rollback");held.release();revoker.release();if(table==="crm_autonomous_workloads")await f.db.admin.query("update crm_autonomous_workloads set disabled=false where id=$1",[f.ids.workload]);}
 });
});
test("the same real command lock serializes close-before-delivery and commit-before-close with no duplicate effect",async t=>{
 for(const closeFirst of [true,false])await t.test(closeFirst?"CLOSE wins":"EXECUTE wins",async()=>{
  const id=randomUUID();await f.db.admin.query("insert into tasks(id,workspace_id,project_id,owner_user_id,title) values($1,$2,$3,$4,'SYNTHETIC race before')",[id,f.ids.workspace,f.ids.project,f.ids.actor]);
  const r=taskRegistration(id);await f.provision(r);const body=f.body("Update",{title:"SYNTHETIC race after"},1),a=await authority(r.grantId),b=binding(r,body),lock=await f.db.admin.connect();
  const wait=async(marker:string,count:number)=>{for(let i=0;i<200;i++){const n=Number((await f.db.admin.query("select count(*) from pg_stat_activity where wait_event_type='Lock' and query like $1 and pid<>pg_backend_pid()",[`%${marker}%`])).rows[0].count);if(n>=count)return;await delay(10);}assert.fail("Actual handler did not queue at the canonical command lock");};
  try{
   await lock.query("begin");await lock.query("select pg_advisory_xact_lock(hashtextextended($1,0))",[`crm-command:${f.ids.workspace}:${body.idempotencyKey}`]);
   const first=closeFirst?close(a,b,body):invoke(r,body);await wait("pg_advisory_xact_lock",1);
   const second=closeFirst?invoke(r,body):close(a,b,body);await wait("",2);await lock.query("commit");
   const results=await Promise.all([first,second]),closure=results[closeFirst?0:1]!,effect=results[closeFirst?1:0]!;assert.equal(closure.status,200,JSON.stringify(results));assert.equal(closure.body.outcome,closeFirst?"NO_EFFECT":"APPLIED");
   assert.equal(effect.status===200,!closeFirst,JSON.stringify(results));const current=(await f.db.admin.query("select title,version from tasks where id=$1",[id])).rows[0];assert.equal(current.title,closeFirst?"SYNTHETIC race before":"SYNTHETIC race after");assert.equal(current.version,closeFirst?"1":"2");
  }finally{await lock.query("rollback");lock.release();}
 });
});
/** Test-only bridge for the separately invoked immutable counterpart proof. */
export function autonomousNonexecutionFixture(){return {f,recovery,auth,token,authority,binding,invoke};}
