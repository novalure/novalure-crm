import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { startLocalSalesDb, applySalesSchema } from "./lib/local-sales-db.mjs";
import { assertCrmServiceContext, assertExpectedVersion, assertMoneyCents, assertProjectGrant, CrmCommandError, crmCommandErrorResponse, crmPayloadDigest, executeCrmCommand, withCrmRead, type TenantTransactionOptions } from "../src/lib/crm-command";
import { createPropertyBuildingRecord, createPropertyUnitRecord } from "../src/lib/db/property-inventory-repositories";
import { getCoreCrmData } from "../src/lib/db/crm-loaders";
import { listDashboardViews, upsertDashboardView } from "../src/lib/db/crm-write-repositories";
import { queryOne } from "../src/lib/db/client";
import { currentTenantTransaction } from "../src/lib/db/transaction-context";
import type { AppSession } from "../src/lib/auth/session";
import { localTestDatabaseTarget } from "../src/lib/db/local-test-transport";

let db: Awaited<ReturnType<typeof startLocalSalesDb>>;
let options: TenantTransactionOptions;
const workspaceId=randomUUID(), otherWorkspace=randomUUID(), actorId=randomUUID(), restrictedId=randomUUID(), projectId=randomUUID(), hiddenProject=randomUUID(), otherProject=randomUUID();
const session:AppSession={authenticated:true,workspaceId,userId:actorId,workspaceName:"Synthetic QA",email:"owner@qa.invalid",name:"Synthetic Owner",role:"owner",productRole:"customer_owner",permissions:["crm:read","crm:write"],productPermissions:["reservations:write","pipeline:write"],source:"headers"};
const restricted:AppSession={...session,userId:restrictedId,role:"agent",productRole:"project_sales_member"};
const meta=()=>({idempotencyKey:randomUUID(),correlationId:randomUUID()});
const command=(extra:Record<string,unknown>={})=>({operation:"test.task.create",projectId,...meta(),payload:{title:"Synthetic task"},capability:"pipeline:write" as const,...extra});
const rejects=(code:string)=>(error:unknown)=>error instanceof CrmCommandError && error.code===code;

before(async()=>{
  db=await startLocalSalesDb();
  await applySalesSchema(db);
  options={pool:db.pool as unknown as NonNullable<TenantTransactionOptions["pool"]>};
  await db.admin.query("insert into workspaces(id,name,operating_model) values($1,'Synthetic QA','managed_by_novalure'),($2,'Synthetic Other','managed_by_novalure')",[workspaceId,otherWorkspace]);
  await db.admin.query("insert into workspace_users(id,workspace_id,name,email,role,product_role,status) values($1,$3,'Synthetic Owner','owner@qa.invalid','owner','customer_owner','active'),($2,$3,'Synthetic Agent','agent@qa.invalid','agent','project_sales_member','active')",[actorId,restrictedId,workspaceId]);
  await db.admin.query("insert into projects(id,workspace_id,name,type) values($1,$4,'Granted','Bauträger'),($2,$4,'Hidden','Bauträger'),($3,$5,'Other tenant','Bauträger')",[projectId,hiddenProject,otherProject,workspaceId,otherWorkspace]);
  await db.admin.query("insert into project_pipeline_permissions(workspace_id,project_id,user_id,can_read,can_edit_deals) values($1,$2,$3,true,true)",[workspaceId,projectId,restrictedId]);
});
after(async()=>{if(db)await db.stop();});

test("unit: canonical digest is order-independent and rejects non-JSON numbers",()=>{
  assert.equal(crmPayloadDigest({a:1,b:{d:2,c:3}}),crmPayloadDigest({b:{c:3,d:2},a:1}));
  assert.notEqual(crmPayloadDigest({a:1}),crmPayloadDigest({a:2}));
  assert.throws(()=>crmPayloadDigest({a:NaN}),rejects("INVALID_PAYLOAD"));
});
test("unit: money and expected versions reject imprecise and missing values",()=>{
  assert.equal(assertMoneyCents(990000),990000);
  for(const invalid of [-1,1.1,Number.MAX_SAFE_INTEGER+1,"100",NaN])assert.throws(()=>assertMoneyCents(invalid));
  for(const invalid of [undefined,0,-1,1.1,"1"])assert.throws(()=>assertExpectedVersion(invalid));
});
test("security: local test transport rejects production, Vercel, remote hosts and URL overrides",()=>{
  const local="postgresql://synthetic@127.0.0.1:5432/qa";
  assert.equal(localTestDatabaseTarget(local,{NODE_ENV:"test",CRM_LOCAL_TEST_DATABASE:"1"}),local);
  assert.equal(localTestDatabaseTarget(local,{NODE_ENV:"production"}),null);
  for(const env of [{NODE_ENV:"production",CRM_LOCAL_TEST_DATABASE:"1"},{NODE_ENV:"test",CRM_LOCAL_TEST_DATABASE:"1",VERCEL:"0"},{NODE_ENV:"test",CRM_LOCAL_TEST_DATABASE:"1",VERCEL_ENV:"preview"}] as const)assert.throws(()=>localTestDatabaseTarget(local,env));
  for(const target of ["postgresql://synthetic@provider.invalid/qa",`${local}?host=provider.invalid`,"https://127.0.0.1/qa","postgresql://synthetic@127.0.0.1/qa#fragment"])assert.throws(()=>localTestDatabaseTarget(target,{NODE_ENV:"test",CRM_LOCAL_TEST_DATABASE:"1"}));
});
test("security: service vocabulary never enables a principal or private data access",()=>{
  assert.throws(()=>assertCrmServiceContext({scopes:["crm.contacts.read"],workspaceId,projectIds:[projectId],classification:"PRIVATE_FRANZ",purpose:"crm_sales"}),rejects("SERVICE_SCOPE_DENIED"));
  assert.throws(()=>assertCrmServiceContext({scopes:["crm.contacts.read"],workspaceId,projectIds:[projectId],classification:"CUSTOMER_TENANT",purpose:"crm_sales"}),rejects("SERVICE_INTEGRATION_DISABLED"));
});
test("security: unexpected DB errors are redacted",async()=>{
  const response=crmCommandErrorResponse(new Error("private-qa@example.invalid credential-value"));
  assert.equal(response.status,503);
  assert.doesNotMatch(await response.text(),/private-qa|credential-value/);
});
test("database: runtime role is non-owner and cannot bypass RLS",async()=>{
  const result=await db.pool.query("select rolsuper,rolbypassrls from pg_roles where rolname=current_user");
  assert.deepEqual(result.rows[0],{rolsuper:false,rolbypassrls:false});
  assert.equal((await db.pool.query("select id from projects")).rowCount,0);
});
test("security: privileged or unrelated DB pool is refused before business code",async()=>{
  let effects=0;
  await assert.rejects(withCrmRead(session,async()=>{effects++;return true;},{pool:db.admin as unknown as NonNullable<TenantTransactionOptions["pool"]>}),/Tenant database role is unsafe/);
  assert.equal(effects,0);
});
test("integration: command effect, receipt, audit and event commit together",async()=>{
  const result=await executeCrmCommand(session,command(),async(tx,ctx)=>{
    assert.equal(currentTenantTransaction()?.scope.workspaceId,workspaceId);
    const row=await queryOne<{id:string}>("insert into tasks(workspace_id,project_id,title,owner_user_id) values($1,$2,'Synthetic atomic task',$3) returning id",[workspaceId,projectId,ctx.actorId]);
    assert.ok(row);return row;
  },options);
  assert.equal(result.replayed,false);
  for(const [table,column,value]of [["tasks","id",result.data.id],["crm_command_receipts","id",result.commandId],["audit_logs","id",result.auditReference],["crm_domain_events","command_id",result.commandId]])assert.equal((await db.admin.query(`select id from ${table} where ${column}=$1`,[value])).rowCount,1);
  assert.equal(currentTenantTransaction(),undefined);
});
test("integration: exception rolls back the effect and all receipts",async()=>{
  const input=command();const id=randomUUID();
  await assert.rejects(executeCrmCommand(session,input,async(tx)=>{await tx.execute("insert into tasks(id,workspace_id,project_id,title) values($1,$2,$3,'Rollback')",[id,workspaceId,projectId]);throw new Error("test rollback");},options));
  assert.equal((await db.admin.query("select id from tasks where id=$1",[id])).rowCount,0);
  assert.equal((await db.admin.query("select id from crm_command_receipts where workspace_id=$1 and idempotency_key=$2",[workspaceId,input.idempotencyKey])).rowCount,0);
});
test("database: a swallowed SQL failure can never return a successful commit",async()=>{
  const id=randomUUID();
  await assert.rejects(withCrmRead(session,async tx=>{
    await tx.execute("insert into tasks(id,workspace_id,project_id,title) values($1,$2,$3,'Must rollback')",[id,workspaceId,projectId]);
    try{await tx.query("select deliberately_missing_column from tasks");}catch{/* Legacy catch must not hide rollback. */}
    return {persisted:true};
  },options),/deliberately_missing_column/);
  assert.equal((await db.admin.query("select id from tasks where id=$1",[id])).rowCount,0);
});
test("integration: concurrent identical commands produce exactly one effect",async()=>{
  const input=command();let effects=0;
  const run=()=>executeCrmCommand(session,input,async(tx)=>{effects++;return(await tx.queryOne<{id:string}>("insert into tasks(workspace_id,project_id,title) values($1,$2,'Concurrent') returning id",[workspaceId,projectId]))!;},options);
  const results=await Promise.all([run(),run()]);
  assert.equal(effects,1);assert.equal(results[0].commandId,results[1].commandId);assert.equal(results.filter(r=>r.replayed).length,1);
});
test("integration: same key with altered payload is a conflict",async()=>{
  const input=command();await executeCrmCommand(session,input,async()=>({ok:true}),options);
  await assert.rejects(executeCrmCommand(session,{...input,payload:{title:"changed"}},async()=>({ok:true}),options),rejects("IDEMPOTENCY_CONFLICT"));
});
test("security: RLS prevents foreign tenant reads and writes",async()=>{
  await withCrmRead(session,async tx=>assert.equal((await tx.query("select id from projects where workspace_id=$1",[otherWorkspace])).length,0),options);
  await assert.rejects(withCrmRead(session,async tx=>tx.execute("insert into tasks(workspace_id,project_id,title) values($1,$2,'Forbidden')",[otherWorkspace,otherProject]),options),/row-level security/);
});
test("security: positive project grant excludes another project in the same tenant",async()=>{
  await withCrmRead(restricted,async(tx,fresh)=>{await assertProjectGrant(tx,fresh,projectId);const rows=await tx.query<{id:string}>("select id from projects");assert.deepEqual(rows.map(r=>r.id),[projectId]);await assert.rejects(assertProjectGrant(tx,fresh,hiddenProject),rejects("PROJECT_FORBIDDEN"));},options);
});
test("security: project check cannot impersonate a different recipient",async()=>{
  await withCrmRead(session,async tx=>assert.rejects(assertProjectGrant(tx,restricted,projectId),rejects("PROJECT_FORBIDDEN")),options);
});
test("security: missing membership, demomode and stale client role cannot authorize writes",async()=>{
  await assert.rejects(withCrmRead({...session,userId:randomUUID()},async()=>true,options),rejects("FORBIDDEN"));
  await assert.rejects(withCrmRead({...session,source:"demo"},async()=>true,options),rejects("UNAUTHENTICATED"));
  await db.admin.query("update workspace_users set role='assistant' where id=$1",[restrictedId]);
  try{await assert.rejects(executeCrmCommand({...restricted,role:"owner"},command(),async()=>true,options),rejects("FORBIDDEN"));}finally{await db.admin.query("update workspace_users set role='agent' where id=$1",[restrictedId]);}
});
test("security: PRIVATE_FRANZ data stays hidden even from a workspace owner",async()=>{
  const id=randomUUID();await db.admin.query("insert into projects(id,workspace_id,name,type,data_classification) values($1,$2,'Private fixture','Bauträger','PRIVATE_FRANZ')",[id,workspaceId]);
  await withCrmRead(session,async tx=>assert.equal((await tx.query("select id from projects where id=$1",[id])).length,0),options);
});
test("security: append-only command, event and audit records reject mutations",async()=>{
  const result=await executeCrmCommand(session,command(),async()=>({ok:true}),options);
  for(const table of ["crm_command_receipts","crm_domain_events","audit_logs"])await assert.rejects(db.admin.query(`update ${table} set created_at=now() where ${table==="crm_domain_events"?"command_id":"id"}=$1`,[table==="audit_logs"?result.auditReference:result.commandId]),/immutable|append-only/);
});
test("integration: pool reuse clears context and nested scope changes are denied",async()=>{
  await withCrmRead(session,async()=>assert.rejects(withCrmRead({...session,workspaceId:otherWorkspace},async()=>true,options),rejects("TENANT_MISMATCH")),options);
  assert.equal(currentTenantTransaction(),undefined);
  const rows=await db.pool.query("select nullif(current_setting('app.tenant_id',true),'') as tenant");assert.equal(rows.rows[0].tenant,null);
});
test("database: building and unit use their existing immutable inventory ledgers",async()=>{
  const buildingInput={projectId,session,name:"Synthetic building",...meta(),options};const building=await createPropertyBuildingRecord(buildingInput);const again=await createPropertyBuildingRecord(buildingInput);assert.equal(again.replayed,true);
  const unitInput={projectId,session,buildingId:building.data.id,unitNumber:randomUUID(),...meta(),options};const unit=await createPropertyUnitRecord(unitInput);const replay=await createPropertyUnitRecord(unitInput);assert.equal(replay.data.id,unit.data.id);assert.equal(replay.replayed,true);
  assert.equal((await db.admin.query("select id from property_unit_idempotency where unit_id=$1",[unit.data.id])).rowCount,1);
  assert.equal((await db.admin.query("select id from property_building_idempotency where building_id=$1",[building.data.id])).rowCount,1);
});
test("database: stale parallel unit updates cannot overwrite a newer version",async()=>{
  const unit=await createPropertyUnitRecord({projectId,session,unitNumber:randomUUID(),...meta(),options});
  const update={projectId,session,unitId:unit.data.id,unitNumber:unit.data.unitNumber,expectedVersion:1,options};
  const results=await Promise.allSettled([createPropertyUnitRecord({...update,rooms:2,...meta()}),createPropertyUnitRecord({...update,rooms:3,...meta()})]);
  assert.equal(results.filter(r=>r.status==="fulfilled").length,1);assert.equal(results.filter(r=>r.status==="rejected"&&rejects("VERSION_CONFLICT")(r.reason)).length,1);
  assert.equal(Number((await db.admin.query("select version from property_units where id=$1",[unit.data.id])).rows[0].version),2);
});
test("security: generic unit write cannot confirm a price, reservation or sale",async()=>{
  for(const status of ["reserved","sold"])await assert.rejects(createPropertyUnitRecord({projectId,session,unitNumber:randomUUID(),status,...meta(),options}),rejects("STATUS_CONFIRMATION_REQUIRED"));
  await assert.rejects(createPropertyUnitRecord({projectId,session,unitNumber:randomUUID(),priceCents:100,...meta(),options}),rejects("PRICE_CONFIRMATION_REQUIRED"));
});
test("database: duplicate unit number does not overwrite the existing row",async()=>{
  const unitNumber=randomUUID();const first=await createPropertyUnitRecord({projectId,session,unitNumber,rooms:2,...meta(),options});
  await assert.rejects(createPropertyUnitRecord({projectId,session,unitNumber,rooms:9,...meta(),options}),rejects("UNIT_EXISTS"));
  assert.equal(Number((await db.admin.query("select rooms from property_units where id=$1",[first.data.id])).rows[0].rooms),2);
});
test("security: building cannot be linked across projects",async()=>{
  const building=await createPropertyBuildingRecord({projectId:hiddenProject,session,name:"Other project building",...meta(),options});
  await assert.rejects(createPropertyUnitRecord({projectId,session,unitNumber:randomUUID(),buildingId:building.data.id,...meta(),options}),rejects("RELATIONSHIP_INVALID"));
});
test("integration: core read creates no pipeline and returns no mock modules",async()=>{
  const before=Number((await db.admin.query("select count(*) from crm_pipelines where workspace_id=$1",[workspaceId])).rows[0].count);
  const core=await withCrmRead(session,async()=>getCoreCrmData(workspaceId,{session}),options);
  assert.equal(core.collectionCompleteness,"LIMITED");assert.ok(Object.values(core.moduleSources).every(source=>source!=="mock"));
  assert.equal(Number((await db.admin.query("select count(*) from crm_pipelines where workspace_id=$1",[workspaceId])).rows[0].count),before);
  for(const key of Object.keys(core.moduleSources) as Array<keyof typeof core.moduleSources>)if(core.moduleSources[key]==="fallback")assert.deepEqual(core[key],[]);
});
test("integration: dashboard views create, read and update through the scoped repository",async()=>{
  const created=await withCrmRead(session,async()=>upsertDashboardView({session,name:"Synthetic dashboard",projectId,filters:{status:"open"},layout:[],widgets:["pipeline"],isDefault:true}),options);
  assert.equal(created.persisted,true,JSON.stringify(created));
  const listed=await withCrmRead(session,async()=>listDashboardViews({session}),options);
  assert.equal(listed.source,"database");assert.ok(listed.views.some(view=>view.id===created.data.id));
  const updated=await withCrmRead(session,async()=>upsertDashboardView({session,id:created.data.id,name:"Synthetic dashboard revised",projectId,filters:{status:"closed"},layout:[],widgets:[],isDefault:false}),options);
  assert.equal(updated.persisted,true);if(updated.persisted)assert.equal(updated.data.name,"Synthetic dashboard revised");
});
test("security: dashboard RLS separates users, tenants and ungranted projects",async()=>{
  const own=randomUUID(),shared=randomUUID(),hidden=randomUUID(),foreign=randomUUID();
  await db.admin.query("insert into dashboard_views(id,workspace_id,user_id,project_id,name) values($1,$5,$6,$7,'Other user personal'),($2,$5,null,$7,'Shared allowed'),($3,$5,null,$8,'Shared hidden'),($4,$9,null,$10,'Foreign tenant')",[own,shared,hidden,foreign,workspaceId,actorId,projectId,hiddenProject,otherWorkspace,otherProject]);
  const visible=await withCrmRead(restricted,async()=>listDashboardViews({session:restricted}),options);
  const ids=visible.views.map(view=>view.id);assert.ok(ids.includes(shared));assert.ok(!ids.includes(own));assert.ok(!ids.includes(hidden));assert.ok(!ids.includes(foreign));
  await withCrmRead(restricted,async tx=>assert.equal((await tx.query("update dashboard_views set name='Forbidden shared edit' where id=$1 returning id",[shared])).length,0),options);
  await assert.rejects(withCrmRead(restricted,async tx=>tx.execute("insert into dashboard_views(workspace_id,user_id,project_id,name) values($1,$2,$3,'Forbidden project')",[workspaceId,restrictedId,hiddenProject]),options),/row-level security/);
  await assert.rejects(withCrmRead(session,async tx=>tx.execute("insert into dashboard_views(workspace_id,user_id,project_id,name) values($1,$2,$3,'Foreign project')",[workspaceId,actorId,otherProject]),options),/dashboard_views_sales_project_fk/);
});
test("security: personal dashboard is writable only by its own authorized user",async()=>{
  const id=randomUUID();await db.admin.query("insert into dashboard_views(id,workspace_id,user_id,project_id,name) values($1,$2,$3,$4,'Agent personal')",[id,workspaceId,restrictedId,projectId]);
  await withCrmRead(session,async tx=>assert.equal((await tx.query("select id from dashboard_views where id=$1",[id])).length,0),options);
  const updated=await withCrmRead(restricted,async()=>upsertDashboardView({session:restricted,id,name:"Agent revised",projectId,filters:{},layout:[],widgets:[]}),options);assert.equal(updated.persisted,true);
  await db.admin.query("update workspace_users set role='assistant' where id=$1",[restrictedId]);
  try{await withCrmRead(restricted,async tx=>assert.equal((await tx.query("update dashboard_views set name='Forbidden assistant edit' where id=$1 returning id",[id])).length,0),options);}finally{await db.admin.query("update workspace_users set role='agent' where id=$1",[restrictedId]);}
});
