import { withTenantTransaction, type TenantPool } from "../src/lib/db/tenant-client";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { after, before, test } from "node:test";
import { createServer, type Server } from "node:http";
import { startLocalSalesDb,applySalesSchema } from "./lib/local-sales-db.mjs";
import { CRM_CONTRACT_SCOPES,CRM_READ_CONTRACT_VERSION,parseCrmContractRequest } from "../src/lib/crm-service-contract";
import { crmPayloadDigest } from "../src/lib/crm-command";
import { resolveTenantDatabaseUrl } from "../src/lib/db/tenant-client";

import { closeLocalTestPool } from "../src/lib/db/local-test-transport";
type Handler=(request:Request,context:{params:Promise<Record<string,string>>})=>Promise<Response>;
const routes=new Map<string,Record<string,Handler>>();
let db:Awaited<ReturnType<typeof startLocalSalesDb>>,server:Server,baseUrl:string;
const w=randomUUID(),actor=randomUUID(),project=randomUUID(),hidden=randomUUID(),foreignW=randomUUID(),foreignProject=randomUUID(),foreignActor=randomUUID(),internalW=randomUUID(),internalActor=randomUUID(),internalProject=randomUUID();
const contact=randomUUID(),internalContact=randomUUID(),hiddenContact=randomUUID(),privateContact=randomUUID(),unknownContact=randomUUID(),task=randomUUID(),lead=randomUUID(),deal=randomUUID(),unboundDeal=randomUUID(),principalId=randomUUID(),readOnlyPrincipalId=randomUUID(),internalPrincipalId=randomUUID();
const token="qa-crm-v1."+randomBytes(32).toString("base64url");
const readOnlyToken="qa-crm-v1."+randomBytes(32).toString("base64url");
const internalToken="qa-crm-v1."+randomBytes(32).toString("base64url");
const readOnlyScopes=["crm.contacts.read","crm.leads.read","crm.deals.read","crm.search.read"];
const savedEnv={NODE_ENV:process.env.NODE_ENV,DATABASE_URL:process.env.DATABASE_URL,CRM_LOCAL_TEST_DATABASE:process.env.CRM_LOCAL_TEST_DATABASE};
const sim=()=> "sim-"+randomUUID();
const envelope=(extra:Record<string,unknown>={})=>({contractVersion:"crm-integration-v1",environment:"simulation",synthetic:true,operation:"Read",entity:"Contact",tenantId:"sim-qa-tenant",resourceId:"sim-contact",actorId:"sales",correlationId:sim(),idempotencyKey:sim(),expectedVersion:null,approvalReference:null,auditReference:sim(),validation:{status:"VALIDATED",schemaVersion:"crm-integration-v1"},patch:{},...extra});
const readEnvelope=(extra:Record<string,unknown>={})=>envelope({contractVersion:CRM_READ_CONTRACT_VERSION,validation:{status:"VALIDATED",schemaVersion:CRM_READ_CONTRACT_VERSION},search:null,...extra});
const searchEnvelope=(entity:"Contact"|"BuyerLead"|"Deal",filters:Record<string,unknown>={},extra:Record<string,unknown>={})=>readEnvelope({operation:"Search",entity,resourceId:"sim-project",search:{page:1,pageSize:25,filters},...extra});
async function register(r:ReturnType<typeof envelope>,targetPrincipal=principalId,targetWorkspace=w) {
 await db.admin.query("insert into crm_service_audit_bindings(principal_id,workspace_id,audit_alias,resource_alias,request_hash,expires_at) values($1,$2,$3,$4,$5,now()+interval '10 minutes')",[targetPrincipal,targetWorkspace,r.auditReference,r.resourceId,crmPayloadDigest(r)]);
}
/** Contract tests do not test connection pooling. Avoid idle-socket reuse across cases. */
async function fetchLocal(url:string|URL,init:RequestInit):Promise<Response> {
 const target=new URL(url);
 if(target.origin!==new URL(baseUrl).origin)throw new Error("Test HTTP target is not the owned loopback server");
 const headers=new Headers(init.headers);headers.set("connection","close");
 try {
  const response=await fetch(target,{...init,headers,signal:AbortSignal.timeout(15_000)});
  assert.equal(response.headers.get("connection"),"close","Harness must not pool connections between test cases");
  return response;
 } catch(error) {
  throw new Error("Local contract HTTP transport failed: "+(init.method??"GET")+" "+target.pathname,{cause:error});
 }
}
async function call(r:ReturnType<typeof envelope>,headers:Record<string,string>={},bearer=token) {
 const response=await fetchLocal(baseUrl,{method:"POST",headers:{"content-type":"application/json",authorization:"Bearer "+bearer,...headers},body:JSON.stringify(r)});
 return {status:response.status,body:await response.json() as {projection?: {contractVersion:string;data:Record<string,unknown>;sourceId:string;sourceVersion:number|null;projectionHash:string}; search?:{kind:string;page:number;pageSize:number;hasMore:boolean;items:Array<{sourceId:string;data:Record<string,unknown>}>}; data?: {resourceVersion:number}; code?:string; retry?:string; replayed?:boolean; commandId?:string; status?:string}};
}
test("target: EVM-08B.1 branch uses only the isolated QA database variable",()=>{
 const qa="postgresql://g24_qa_20260917_r3:synthetic@ep-flat-surf-al1a9k1y-pooler.c-3.eu-central-1.aws.neon.tech/qa_g08_pr63_20260917?sslmode=require";
 const preview={NODE_ENV:"production",VERCEL:"1",VERCEL_ENV:"preview",VERCEL_GIT_COMMIT_REF:"codex/evm-08b1-read-contracts",G27_QA_DATABASE_URL:qa} as NodeJS.ProcessEnv;
 assert.equal(resolveTenantDatabaseUrl(preview),qa);
 assert.equal(resolveTenantDatabaseUrl({...preview,DATABASE_URL:"postgresql://runtime@production.example.neon.tech/production?sslmode=require"}),qa);
 assert.throws(()=>resolveTenantDatabaseUrl({...preview,G27_QA_DATABASE_URL:"postgresql://g24_qa_20260917_r3:synthetic@production.example.neon.tech/qa_g08_pr63_20260917?sslmode=require"}),/binding is denied/);
 assert.throws(()=>resolveTenantDatabaseUrl({...preview,G27_QA_DATABASE_URL:"postgresql://g24_qa_20260917_r3:synthetic@ep-flat-surf-al1a9k1y.c-3.eu-central-1.aws.neon.tech/production?sslmode=require"}),/binding is denied/);
 assert.throws(()=>resolveTenantDatabaseUrl({NODE_ENV:"production",VERCEL:"1",VERCEL_ENV:"preview",VERCEL_GIT_COMMIT_REF:"codex/evm-08b1-read-contracts"}),/not configured/);
 assert.equal(resolveTenantDatabaseUrl({NODE_ENV:"production",VERCEL:"1",VERCEL_ENV:"production",VERCEL_GIT_COMMIT_REF:"main",G27_QA_DATABASE_URL:qa}),"");
});
before(async()=>{
 db=await startLocalSalesDb();await applySalesSchema(db);
 Object.assign(process.env,{NODE_ENV:"test"});process.env.CRM_LOCAL_TEST_DATABASE="1";process.env.DATABASE_URL=`postgresql://${db.role}@127.0.0.1:${db.port}/postgres`;
 await db.admin.query("insert into workspaces(id,name,operating_model,setup_state) values($1,'SYNTHETIC QA','managed_by_novalure','{\"syntheticQa\":true}'),($2,'SYNTHETIC FOREIGN','managed_by_novalure','{\"syntheticQa\":true}'),($3,'SYNTHETIC INTERNAL','novalure_internal','{\"syntheticQa\":true}')",[w,foreignW,internalW]);
 await db.admin.query("insert into workspace_users(id,workspace_id,name,email,role,product_role,status) values($1,$2,'SYNTHETIC Service','service@example.invalid','agent','project_sales_member','active'),($3,$4,'SYNTHETIC Other','foreign@example.invalid','agent','project_sales_member','active'),($5,$6,'SYNTHETIC Internal Service','internal-service@example.invalid','agent','novalure_sales','active')",[actor,w,foreignActor,foreignW,internalActor,internalW]);
 await db.admin.query("insert into projects(id,workspace_id,name,type) values($1,$4,'SYNTHETIC: Granted','SYNTHETIC: Service'),($2,$4,'SYNTHETIC: Hidden','SYNTHETIC: Service'),($3,$5,'SYNTHETIC: Foreign','SYNTHETIC: Service'),($6,$7,'SYNTHETIC: Internal','SYNTHETIC: Service')",[project,hidden,foreignProject,w,foreignW,internalProject,internalW]);
 await db.admin.query("insert into project_pipeline_permissions(workspace_id,project_id,user_id,can_read,can_edit_deals) values($1,$2,$3,true,true)",[w,project,actor]);
 await db.admin.query("insert into project_pipeline_permissions(workspace_id,project_id,user_id,can_read,can_edit_deals) values($1,$2,$3,true,false)",[internalW,internalProject,internalActor]);
 for(const [id,p,classification]of [[contact,project,"CUSTOMER_TENANT"],[hiddenContact,hidden,"CUSTOMER_TENANT"],[privateContact,project,"PRIVATE_FRANZ"],[unknownContact,project,"UNKNOWN"]])await db.admin.query("insert into contacts(id,workspace_id,project_id,name,email,role,data_classification) values($1,$2,$3,'SYNTHETIC: Contact','synthetic-sensitive@example.invalid','Bauträger',$4)",[id,w,p,classification]);
 await db.admin.query("insert into tasks(id,workspace_id,project_id,title) values($1,$2,$3,'SYNTHETIC: Task')",[task,w,project]);
 await db.admin.query("insert into crm_service_principals(id,workspace_id,actor_user_id,token_hash,tenant_alias,agent_id,scopes,data_context,data_classification,purpose,expires_at) values($1,$2,$3,$4,'sim-qa-tenant','sales',$5,'CUSTOMER_TENANT','CONFIDENTIAL','OPERATIONS',now()+interval '1 hour')",[principalId,w,actor,createHash("sha256").update(token).digest("hex"),CRM_CONTRACT_SCOPES]);
 await db.admin.query("insert into crm_service_principals(id,workspace_id,actor_user_id,token_hash,tenant_alias,agent_id,scopes,data_context,data_classification,purpose,expires_at) values($1,$2,$3,$4,'sim-qa-tenant','sales',$5,'CUSTOMER_TENANT','CONFIDENTIAL','OPERATIONS',now()+interval '1 hour')",[readOnlyPrincipalId,w,actor,createHash("sha256").update(readOnlyToken).digest("hex"),readOnlyScopes]);
 await db.admin.query("insert into contacts(id,workspace_id,project_id,name,email,role,data_classification) values($1,$2,$3,'SYNTHETIC: Internal Contact','synthetic-internal@example.invalid','Bauträger','NOVALURE_INTERNAL')",[internalContact,internalW,internalProject]);
 await db.admin.query("insert into crm_service_principals(id,workspace_id,actor_user_id,token_hash,tenant_alias,agent_id,scopes,data_context,data_classification,purpose,expires_at) values($1,$2,$3,$4,'sim-qa-tenant','sales',array['crm.contacts.read'],'NOVALURE_INTERNAL','CONFIDENTIAL','OPERATIONS',now()+interval '1 hour')",[internalPrincipalId,internalW,internalActor,createHash("sha256").update(internalToken).digest("hex")]);
 await db.admin.query("insert into crm_service_resource_bindings(principal_id,workspace_id,resource_alias,entity,source_id,project_id,data_context,data_classification,domain,purpose) values($1,$2,'sim-internal-contact','Contact',$3,$4,'NOVALURE_INTERNAL','CONFIDENTIAL','BUSINESS','OPERATIONS')",[internalPrincipalId,internalW,internalContact,internalProject]);
 for(const [alias,entity,id,p]of [["sim-contact","Contact",contact,project],["sim-hidden","Contact",hiddenContact,hidden],["sim-private","Contact",privateContact,project],["sim-unknown","Contact",unknownContact,project],["sim-project","Project",project,project],["sim-task","Task",task,project]])await db.admin.query("insert into crm_service_resource_bindings(principal_id,workspace_id,resource_alias,entity,source_id,project_id,data_context,data_classification,domain,purpose) values($1,$2,$3,$4,$5,$6,'CUSTOMER_TENANT','CONFIDENTIAL','BUSINESS','OPERATIONS')",[principalId,w,alias,entity,id,p]);

 const company=randomUUID(),unit=randomUUID(),appointment=randomUUID(),viewing=randomUUID(),reservation=randomUUID(),communication=randomUUID(),unclassifiedCommunication=randomUUID();
 await db.admin.query("insert into organizations(id,workspace_id,project_id,name,type) values($1,$2,$3,'SYNTHETIC: Developer','Bauträger')",[company,w,project]);
 await db.admin.query("insert into property_units(id,workspace_id,project_id,unit_number) values($1,$2,$3,'SYNTHETIC: Unit')",[unit,w,project]);
 await db.admin.query("insert into leads(id,workspace_id,project_id,contact_id,type,buyer_profile) values($1,$2,$3,$4,'Käufer',$5::jsonb)",[lead,w,project,contact,JSON.stringify({budgetFrom:100000,budgetTo:300000,financingStatus:"offen",desiredLocation:"SYNTHETIC: City"})]);
 await db.admin.query("insert into crm_pipelines(id,workspace_id,project_id,key,name,is_default) values($1,$2,$3,'synthetic-sales','SYNTHETIC: Sales',true)",[randomUUID(),w,project]);
 await db.admin.query("insert into deals(id,workspace_id,project_id,contact_id,owner_user_id,lead_id,name,stage,value_cents,next_action) values($1,$2,$3,$4,$5,$6,'SYNTHETIC: Deal','Qualifiziert',25000000,'SYNTHETIC: Follow up'),($7,$2,$3,$4,$5,$6,'SYNTHETIC: Unbound','Qualifiziert',10000000,'SYNTHETIC: Hidden')",[deal,w,project,contact,actor,lead,unboundDeal]);
 await db.admin.query("insert into calendar_events(id,workspace_id,project_id,title,starts_at,ends_at) values($1,$2,$3,'SYNTHETIC: Appointment',now()+interval '1 day',now()+interval '25 hours')",[appointment,w,project]);
 await db.admin.query("insert into property_viewing_slots(id,workspace_id,project_id,unit_id,contact_id,starts_at,ends_at,note) values($1,$2,$3,$4,$5,now()+interval '1 day',now()+interval '25 hours','SYNTHETIC: Viewing')",[viewing,w,project,unit,contact]);
 await db.admin.query("insert into property_reservations(id,workspace_id,project_id,unit_id,contact_id,expires_at,next_action) values($1,$2,$3,$4,$5,now()+interval '1 day','SYNTHETIC: Next step')",[reservation,w,project,unit,contact]);
 await db.admin.query("insert into conversations(id,workspace_id,project_id,channel,direction,summary,data_classification,data_purpose) values($1,$2,$3,'E-Mail','inbound','SYNTHETIC: Inquiry','CUSTOMER_TENANT','crm_sales'),($4,$2,$3,'E-Mail','inbound','SYNTHETIC: Legacy','UNCLASSIFIED','UNCLASSIFIED')",[communication,w,project,unclassifiedCommunication]);
 for(const [alias,entity,id]of [["sim-company","Company",company],["sim-developer","Developer",company],["sim-unit","Unit",unit],["sim-buyer","BuyerLead",lead],["sim-deal","Deal",deal],["sim-qualification","Qualification",lead],["sim-appointment","Appointment",appointment],["sim-viewing","Viewing",viewing],["sim-reservation","Reservation",reservation],["sim-communication","Communication",communication],["sim-unclassified-communication","Communication",unclassifiedCommunication],["sim-offer-gap","Offer",randomUUID()],["sim-sale-gap","Sale",randomUUID()],["sim-approval-gap","ApprovalReference",randomUUID()]]){
  await db.admin.query("insert into crm_service_resource_bindings(principal_id,workspace_id,resource_alias,entity,source_id,project_id,data_context,data_classification,domain,purpose) values($1,$2,$3,$4,$5,$6,'CUSTOMER_TENANT','CONFIDENTIAL','BUSINESS','OPERATIONS')",[principalId,w,alias,entity,id,project]);
 }
 for(const [alias,entity,id]of [["sim-contact","Contact",contact],["sim-buyer","BuyerLead",lead],["sim-deal","Deal",deal],["sim-project","Project",project]])await db.admin.query("insert into crm_service_resource_bindings(principal_id,workspace_id,resource_alias,entity,source_id,project_id,data_context,data_classification,domain,purpose) values($1,$2,$3,$4,$5,$6,'CUSTOMER_TENANT','CONFIDENTIAL','BUSINESS','OPERATIONS')",[readOnlyPrincipalId,w,alias,entity,id,project]);
 for(const relative of await readdir("src/app/api/crm",{recursive:true})) {
  if(!String(relative).endsWith("route.ts"))continue;
  const routeModule=await import(pathToFileURL(path.resolve("src/app/api/crm",String(relative))).href) as Record<string,unknown>;
  const pathname="/api/crm/"+String(relative).replaceAll("\\","/").replace(/\/route.ts$/,"").replace(/\[[^\]]+\]/g,contact);
  const handlers:Record<string,Handler>={};
  for(const method of ["GET","POST","PATCH","PUT","DELETE"])if(typeof routeModule[method]==="function")handlers[method]=routeModule[method] as Handler;
  routes.set(pathname,handlers);
 }

 server=createServer(async(req,res)=>{
  res.shouldKeepAlive=false;
  try {
   let body="";for await(const part of req)body+=part;
   const headers=new Headers();for(const [key,value]of Object.entries(req.headers))if(value)headers.set(key,Array.isArray(value)?value.join(","):value);
   const target=new URL(req.url??"/",baseUrl);const method=req.method??"GET";const handler=routes.get(target.pathname)?.[method];if(!handler){res.writeHead(404);res.end();return;}
   const response=await handler(new Request(target,{method,headers,...(["GET","HEAD"].includes(method)?{}:{body})}),{params:Promise.resolve({dealId:contact,notificationId:contact})});
   res.writeHead(response.status,Object.fromEntries(response.headers));res.end(await response.text());
  }catch{res.writeHead(500);res.end("failed");}
 });
 await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));baseUrl=`http://127.0.0.1:${(server.address() as {port:number}).port}/api/crm/contract/v1`;
});
after(async()=>{
 if(server)await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
 await closeLocalTestPool();if(db)await db.stop();
 for(const [key,value]of Object.entries(savedEnv))if(value===undefined)delete process.env[key];else process.env[key]=value;
});
test("HTTP: authenticated narrow read returns selected fields and produces no business write",async()=>{
 const r=envelope();await register(r);const before=await db.admin.query("select count(*) from crm_command_receipts");
 const result=await call(r);assert.equal(result.status,200,JSON.stringify(result.body));assert.equal(result.body.projection!.data.displayName,"SYNTHETIC: Contact");
 assert.equal(result.body.projection!.sourceId,contact);assert.doesNotMatch(JSON.stringify(result.body),/synthetic-sensitive|email|phone|token_hash/);
 assert.deepEqual((await db.admin.query("select count(*) from crm_command_receipts")).rows,before.rows);
});
test("HTTP: missing/forged bearer, cookie and browser Origin cannot impersonate service",async()=>{
 const r=envelope();await register(r);
 for(const headers of [{authorization:""},{authorization:"Bearer qa-crm-v1."+randomBytes(32).toString("base64url")},{cookie:"novalure_session=forged"},{origin:baseUrl},{"x-crm-purpose":"PERSONAL"},{"x-crm-data-context":"PRIVATE_FRANZ"},{"x-crm-classification":"SECRET"}]){const result=await call(r,headers as unknown as Record<string,string>);assert.ok([401,403].includes(result.status),JSON.stringify(result));}
});
test("HTTP: tenant and agent must match credential; native UUIDs cannot replace aliases",async()=>{
 for(const extra of [{tenantId:"sim-other"},{actorId:"buyer"},{tenantId:w},{actorId:actor}]){const r=envelope(extra);const result=await call(r);assert.ok([400,403].includes(result.status),JSON.stringify(result));}
});
test("HTTP: additional fields, version downgrade, live mode and invalid patch fail closed",async()=>{
 for(const extra of [{owner:true},{contractVersion:"2"},{environment:"production"},{synthetic:false},{patch:{email:"bad"}},{operation:"Update",expectedVersion:1,patch:{name:"Real name"}},{expectedVersion:undefined}]){const result=await call(envelope(extra));assert.equal(result.status,400,JSON.stringify(result));}
});
test("HTTP: same-tenant hidden project, private and unknown classes are inaccessible",async()=>{
 for(const resourceId of ["sim-hidden","sim-private","sim-unknown"]){const r=envelope({resourceId});await register(r);const result=await call(r);assert.equal(result.status,403,JSON.stringify(result));}
});
test("HTTP: unregistered or mismatched audit reference cannot authorize a read",async()=>{
 const r=envelope();assert.equal((await call(r)).status,403);
 await register(r);assert.equal((await call({...r,correlationId:sim()})).status,403);
});
test("HTTP: scope removal is effective before access",async()=>{
 const r=envelope();await register(r);await db.admin.query("update crm_service_principals set scopes=array['crm.tasks.read'] where id=$1",[principalId]);
 try{assert.equal((await call(r)).status,403);}finally{await db.admin.query("update crm_service_principals set scopes=$2 where id=$1",[principalId,CRM_CONTRACT_SCOPES]);}
});
test("HTTP: revocation, expiry, inactive actor, owner promotion and non-QA workspace all block authentication",async()=>{
 const r=envelope();await register(r);
 for(const [change,undo]of [
 ["update crm_service_principals set revoked_at=now() where id=$1","update crm_service_principals set revoked_at=null where id=$1"],
 ["update crm_service_principals set expires_at=now()-interval '1 second' where id=$1","update crm_service_principals set expires_at=now()+interval '1 hour' where id=$1"],
 ]){
  await db.admin.query(change,[principalId]);try{assert.equal((await call(r)).status,401);}finally{await db.admin.query(undo,[principalId]);}
 }
 await db.admin.query("update workspace_users set role='owner' where id=$1",[actor]);try{assert.equal((await call(r)).status,401);}finally{await db.admin.query("update workspace_users set role='agent' where id=$1",[actor]);}
 await db.admin.query("update workspace_users set status='suspended' where id=$1",[actor]);try{assert.equal((await call(r)).status,401);}finally{await db.admin.query("update workspace_users set status='active' where id=$1",[actor]);}
 await db.admin.query("update workspaces set setup_state='{}' where id=$1",[w]);try{assert.equal((await call(r)).status,401);}finally{await db.admin.query("update workspaces set setup_state='{\"syntheticQa\":true}' where id=$1",[w]);}
});
test("HTTP: contact update is CAS-bound, immutable-receipted, replayable and reconcilable",async()=>{
 const r=envelope({operation:"Update",expectedVersion:1,patch:{name:"SYNTHETIC: Updated"}});await register(r);
 const first=await call(r);assert.equal(first.status,200,JSON.stringify(first));assert.equal(first.body.data!.resourceVersion,2);
 const repeated=await call(r);assert.equal(repeated.status,200);assert.equal(repeated.body.replayed,true);assert.equal(repeated.body.commandId,first.body.commandId);
 const reconciled=await call(r,{"x-crm-reconcile":"1"});assert.equal(reconciled.body.status,"COMMITTED");assert.equal(reconciled.body.commandId,first.body.commandId);
 const count=await db.admin.query("select count(*)::int n from crm_command_receipts where resource_id=$1",[contact]);assert.equal(count.rows[0].n,1);
 const changed={...r,auditReference:sim(),patch:{name:"SYNTHETIC: Altered"}};await register(changed);
 assert.equal((await call(changed)).body.code,"CRM_IDEMPOTENCY_CONFLICT");
});
test("HTTP: stale and parallel versions allow exactly one effect",async()=>{
 const a=envelope({operation:"Update",expectedVersion:2,patch:{name:"SYNTHETIC: Race A"}}),b=envelope({operation:"Update",expectedVersion:2,patch:{name:"SYNTHETIC: Race B"}});
 await register(a);await register(b);const results=await Promise.all([call(a),call(b)]);assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);
 assert.equal(results.find(r=>r.status===409)?.body.code,"CRM_VERSION_CONFLICT");
});
test("HTTP: project name and task title are the only additional write fields",async()=>{
 for(const [entity,resourceId,patch]of [["Project","sim-project",{name:"SYNTHETIC: Project renamed"}],["Task","sim-task",{title:"SYNTHETIC: Task renamed"}]] as const){const r=envelope({operation:"Update",entity,resourceId,expectedVersion:1,patch});await register(r);const response=await call(r);assert.equal(response.status,200,JSON.stringify(response));}
 const r=envelope({operation:"Update",expectedVersion:3,patch:{title:"SYNTHETIC: Wrong field"}});assert.equal((await call(r)).status,400);
});
test("DB: runtime cannot read credential hashes or mint/alter service bindings",async()=>{
 await assert.rejects(db.pool.query("select token_hash from crm_service_principals"),/permission denied/);
 await assert.rejects(db.pool.query("update crm_service_resource_bindings set source_id=$1",[hiddenContact]),/permission denied/);
 await assert.rejects(db.admin.query("update crm_service_resource_bindings set source_id=$1 where principal_id=$2",[hiddenContact,principalId]),/immutable/);
 await assert.rejects(db.admin.query("insert into crm_service_resource_bindings(principal_id,workspace_id,resource_alias,entity,source_id,project_id) values($1,$2,'sim-cross','Project',$3,$3)",[principalId,w,foreignProject]),/foreign key/);
});
test("contract: sensitive commands remain unsupported and cannot borrow a generic write scope",async()=>{
 for(const [operation,entity]of [["PrepareOffer","Offer"],["PrepareReservation","Reservation"],["SendOffer","Offer"],["ConfirmReservation","Reservation"],["ConfirmSale","Sale"]]){
  const r=envelope({operation,entity,expectedVersion:1,approvalReference:"sim-not-a-business-approval"});
  assert.doesNotThrow(()=>parseCrmContractRequest(r));const result=await call(r);assert.ok([403,422].includes(result.status));assert.ok(["CRM_NOT_ACCESSIBLE","CRM_UNSUPPORTED_OPERATION"].includes(String(result.body.code)));
 }
});

test("HTTP: every one of the twelve v1 read projections executes against PostgreSQL",async()=>{
 for(const [entity,resourceId]of [["Contact","sim-contact"],["Company","sim-company"],["Developer","sim-developer"],["Project","sim-project"],["Unit","sim-unit"],["BuyerLead","sim-buyer"],["Qualification","sim-qualification"],["Task","sim-task"],["Appointment","sim-appointment"],["Viewing","sim-viewing"],["Reservation","sim-reservation"],["Communication","sim-communication"]]){
  const r=envelope({entity,resourceId});await register(r);const result=await call(r);
  assert.equal(result.status,200,entity+":"+JSON.stringify(result));assert.equal(result.body.projection?.data.referenceScope,"NOT_VERIFIED");
 }
});
test("HTTP: v1.1 Deal read is versioned, hashed, financial-classified and field-minimized",async()=>{
 const r=readEnvelope({entity:"Deal",resourceId:"sim-deal"});await register(r);const result=await call(r);
 assert.equal(result.status,200,JSON.stringify(result));const projection=result.body.projection!;
 assert.equal(projection.contractVersion,CRM_READ_CONTRACT_VERSION);assert.equal(projection.sourceId,deal);assert.equal(projection.sourceVersion,1);
 assert.match(projection.projectionHash,/^[a-f0-9]{64}$/);assert.deepEqual(projection.data.value,{minorUnits:25000000,currency:"EUR",classification:"FINANCIAL"});
 assert.equal(projection.data.stage,"Qualifiziert");assert.equal(projection.data.ownerReference,actor);assert.deepEqual(projection.data.linkedContacts,[contact]);
 assert.ok(projection.data.pipeline);assert.doesNotMatch(JSON.stringify(result.body),/probability|risk_level|metadata|expected_close_date|synthetic-sensitive/);
});
test("HTTP: structured v1.1 Contact, BuyerLead and Deal searches return only bound project resources",async()=>{
 for(const [entity,expected]of [["Contact",contact],["BuyerLead",lead],["Deal",deal]] as const){
  const filters=entity==="BuyerLead"?{status:"Neu"}:entity==="Deal"?{stage:"Qualifiziert"}:{};
  const r=searchEnvelope(entity,filters);await register(r);const result=await call(r);
  assert.equal(result.status,200,entity+":"+JSON.stringify(result));assert.equal(result.body.search?.kind,entity);assert.equal(result.body.search?.page,1);assert.equal(result.body.search?.hasMore,false);
  assert.deepEqual(result.body.search?.items.map(item=>item.sourceId),[expected]);assert.doesNotMatch(JSON.stringify(result.body),new RegExp(unboundDeal));
 }
});
test("contract: v1.1 Search rejects downgrade, arbitrary fields/query language and pagination overflow",()=>{
 const valid=searchEnvelope("Deal",{stage:"Qualifiziert"});assert.doesNotThrow(()=>parseCrmContractRequest(valid));
 for(const invalid of [
  {...valid,contractVersion:"crm-integration-v1",validation:{status:"VALIDATED",schemaVersion:"crm-integration-v1"}},
  {...valid,search:{page:6,pageSize:25,filters:{}}},
  {...valid,search:{page:1,pageSize:26,filters:{}}},
  {...valid,search:{page:1,pageSize:25,filters:{query:"select * from contacts"}}},
  {...valid,search:{page:1,pageSize:25,filters:{stage:"Qualifiziert"},fields:["email"]}},
 ])assert.throws(()=>parseCrmContractRequest(invalid),/INVALID_CRM_REQUEST/);
 assert.throws(()=>parseCrmContractRequest(envelope({entity:"Deal",resourceId:"sim-deal"})),/INVALID_CRM_REQUEST/);
});
test("HTTP: disposable read-only principal allows four reads and denies writes, delete, finance and contract actions before effect",async()=>{
 const readsToRun=[envelope(),envelope({entity:"BuyerLead",resourceId:"sim-buyer"}),readEnvelope({entity:"Deal",resourceId:"sim-deal"}),searchEnvelope("Deal",{stage:"Qualifiziert"})];
 for(const r of readsToRun){await register(r,readOnlyPrincipalId);assert.equal((await call(r,{},readOnlyToken)).status,200,JSON.stringify(r));}
 const receiptBefore=(await db.admin.query("select count(*)::int n from crm_command_receipts")).rows[0].n;
 const dealBefore=(await db.admin.query("select name,stage,value_cents,version from deals where id=$1",[deal])).rows[0];
 const denied=[
  envelope({operation:"Update",expectedVersion:1,patch:{name:"SYNTHETIC: Forbidden"}}),
  readEnvelope({operation:"Update",entity:"Deal",resourceId:"sim-deal",expectedVersion:1,patch:{name:"SYNTHETIC: Forbidden"}}),
  readEnvelope({operation:"Delete",entity:"Deal",resourceId:"sim-deal",expectedVersion:1,patch:{}}),
  envelope({operation:"PrepareOffer",entity:"Offer",resourceId:"sim-deal",expectedVersion:1}),
  envelope({operation:"SendOffer",entity:"Offer",resourceId:"sim-deal",expectedVersion:1,approvalReference:"sim-no-approval"}),
 ];
 for(const r of denied){try{await register(r,readOnlyPrincipalId);}catch{}const result=await call(r,{},readOnlyToken);assert.ok([400,403,422].includes(result.status),JSON.stringify(result));}
 assert.equal((await db.admin.query("select count(*)::int n from crm_command_receipts")).rows[0].n,receiptBefore);
 assert.deepEqual((await db.admin.query("select name,stage,value_cents,version from deals where id=$1",[deal])).rows[0],dealBefore);
});
test("HTTP: disposable Preview principal may read an exact NOVALURE_INTERNAL synthetic binding only",async()=>{
 const r=envelope({resourceId:"sim-internal-contact"});await register(r,internalPrincipalId,internalW);
 const result=await call(r,{},internalToken);assert.equal(result.status,200,JSON.stringify(result));
 assert.equal(result.body.projection?.sourceId,internalContact);
 assert.equal(result.body.projection?.data.displayName,"SYNTHETIC: Internal Contact");
 const other=envelope({resourceId:"sim-contact"});assert.equal((await call(other,{},internalToken)).status,403);
 await assert.rejects(db.admin.query("insert into crm_service_principals(workspace_id,actor_user_id,token_hash,tenant_alias,agent_id,scopes,data_context,data_classification,purpose,expires_at) values($1,$2,$3,'sim-private','sales',array['crm.contacts.read'],'PRIVATE_FRANZ','CONFIDENTIAL','OPERATIONS',now()+interval '1 hour')",[internalW,internalActor,"0".repeat(64)]),/crm_service_principals_data_context_check/);
});
test("HTTP: Search requires both search and target read scopes",async()=>{
 const r=searchEnvelope("Deal",{stage:"Qualifiziert"});await register(r,readOnlyPrincipalId);
 await db.admin.query("update crm_service_principals set scopes=array_remove(scopes,'crm.deals.read') where id=$1",[readOnlyPrincipalId]);
 try{assert.equal((await call(r,{},readOnlyToken)).status,403);}finally{await db.admin.query("update crm_service_principals set scopes=$2 where id=$1",[readOnlyPrincipalId,readOnlyScopes]);}
});
test("HTTP: semantic-gap entities and unclassified legacy communication remain closed",async()=>{
 for(const [entity,resourceId]of [["Offer","sim-offer-gap"],["Sale","sim-sale-gap"],["ApprovalReference","sim-approval-gap"]]){
  const r=envelope({entity,resourceId});await register(r);assert.equal((await call(r)).body.code,"CRM_SEMANTIC_GAP");
 }
 const r=envelope({entity:"Communication",resourceId:"sim-unclassified-communication"});await register(r);assert.equal((await call(r)).status,403);
});
test("HTTP: every legacy CRM method rejects service bearer plus forged owner headers",async()=>{
 let checked=0;
 for(const [pathname,methods]of routes) {
  if(pathname==="/api/crm/contract/v1")continue;
  for(const method of Object.keys(methods)) {
   const result=await fetchLocal(new URL(pathname,baseUrl),{method,headers:{authorization:"Bearer "+token,"content-type":"application/json","x-novalure-role":"owner","x-novalure-user-id":actor,"x-novalure-workspace-id":w},...(["GET","HEAD"].includes(method)?{}:{body:"{}"})});
   assert.ok([401,403].includes(result.status),method+" "+pathname+" status="+result.status+" "+await result.text());checked++;
  }
 }
 assert.ok(checked>=40,"Full historical CRM method inventory must be covered");
 console.log("Legacy CRM HTTP boundary checked methods:",checked);
});
test("contract: pinned synthetic-text safety refinement rejects credential markers",()=>{
 for(const value of ["passwordvalue","passwd","secretvalue","tokenvalue","api_key","credential","private-key","canary","sk-a","ghp_value","github_pat_value","AKIA","bearer value"]){
  assert.throws(()=>parseCrmContractRequest(envelope({operation:"Update",expectedVersion:1,patch:{name:"SYNTHETIC: "+value}})),/INVALID_CRM_REQUEST/);
 }
 for(const value of ["SYNTHETIC: Correct name","SYNTHETIC: Project 12_A-B"]){
  assert.doesNotThrow(()=>parseCrmContractRequest(envelope({operation:"Update",expectedVersion:1,patch:{name:value}})));
 }
});

test("HTTP: immutable resource context, sensitivity, domain and purpose are independently enforced",async()=>{
 for(const override of [{data_context:"PRIVATE_FRANZ"},{data_context:"NOVALURE_INTERNAL"},{data_context:"UNCLASSIFIED"},{data_classification:"SECRET"},{data_classification:"UNCLASSIFIED"},{domain:"PERSONAL"},{purpose:"MANAGEMENT"}]){
  const native=randomUUID(),alias=sim();const context={data_context:"CUSTOMER_TENANT",data_classification:"CONFIDENTIAL",domain:"BUSINESS",purpose:"OPERATIONS",...override};
  await db.admin.query("insert into contacts(id,workspace_id,project_id,name,role) values($1,$2,$3,'SYNTHETIC: Classified fixture','Bauträger')",[native,w,project]);
  await db.admin.query("insert into crm_service_resource_bindings(principal_id,workspace_id,resource_alias,entity,source_id,project_id,data_context,data_classification,domain,purpose) values($1,$2,$3,'Contact',$4,$5,$6,$7,$8,$9)",[principalId,w,alias,native,project,context.data_context,context.data_classification,context.domain,context.purpose]);
  const r=envelope({resourceId:alias});await register(r);assert.equal((await call(r)).status,403,JSON.stringify(override));
 }
});
test("DB: conversation helper requires credential and matching actor/project; generic read has no grant",async()=>{
 const binding=(await db.admin.query("select source_id from crm_service_resource_bindings where principal_id=$1 and resource_alias='sim-communication'",[principalId])).rows[0];
 await assert.rejects(db.pool.query("select summary from conversations"),/permission denied/);
 const args=[createHash("sha256").update(token).digest("hex"),w,project,binding.source_id];
 await assert.rejects(db.pool.query("select * from crm_read_contract_conversation($1,$2,$3,$4)",args),/not accessible/);
 await assert.rejects(withTenantTransaction({workspaceId:w,actorId:foreignActor},tx=>tx.query("select * from crm_read_contract_conversation($1,$2,$3,$4)",args),{pool:db.pool as unknown as TenantPool}),/not accessible/);
 await assert.rejects(withTenantTransaction({workspaceId:w,actorId:actor},tx=>tx.query("select * from crm_read_contract_conversation($1,$2,$3,$4)",["0".repeat(64),w,project,binding.source_id]),{pool:db.pool as unknown as TenantPool}),/not accessible/);
});

test("HTTP: unsafe source text and malformed buyer profile cannot escape a valid grant",async()=>{
 const resourceId="sim-communication",r=envelope({entity:"Communication",resourceId});await register(r);
 const id=(await db.admin.query("select source_id from crm_service_resource_bindings where principal_id=$1 and resource_alias=$2",[principalId,resourceId])).rows[0].source_id;
 await db.admin.query("update conversations set summary='SYNTHETIC: passwordvalue' where id=$1",[id]);
 try{const result=await call(r);assert.equal(result.status,502);assert.equal(result.body.code,"INVALID_CRM_RESPONSE");assert.doesNotMatch(JSON.stringify(result.body),/passwordvalue/);}finally{await db.admin.query("update conversations set summary='SYNTHETIC: Inquiry' where id=$1",[id]);}
 const q=envelope({entity:"Qualification",resourceId:"sim-qualification"});await register(q);
 const lead=(await db.admin.query("select source_id from crm_service_resource_bindings where principal_id=$1 and resource_alias='sim-qualification'",[principalId])).rows[0].source_id;
 const previous=(await db.admin.query("select buyer_profile from leads where id=$1",[lead])).rows[0].buyer_profile;
 await db.admin.query("update leads set buyer_profile=$2::jsonb where id=$1",[lead,JSON.stringify({budgetFrom:300,budgetTo:100})]);
 try{assert.equal((await call(q)).body.code,"INVALID_CRM_RESPONSE");}finally{await db.admin.query("update leads set buyer_profile=$2::jsonb where id=$1",[lead,JSON.stringify(previous)]);}
});

test("contract: pinned Evelyn request parity vectors remain accepted or rejected identically",async()=>{
 const fixture=JSON.parse(await readFile("scripts/fixtures/crm-v1-request-parity.json","utf8")) as {sourceRevision:string;vectors:{label:string;request:unknown;accepted:boolean}[]};
 assert.equal(fixture.sourceRevision,"8119798a97347eb1c96126c6a14308e158e20862");assert.ok(fixture.vectors.length>=160);
 for(const vector of fixture.vectors){let accepted=true;try{parseCrmContractRequest(vector.request);}catch{accepted=false;}assert.equal(accepted,vector.accepted,vector.label);}
});
