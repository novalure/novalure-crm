import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { startLocalSalesDb, applySalesSchema } from "./lib/local-sales-db.mjs";
import { executeSalesHttp, reconcileSalesHttp, type SalesHttpRequest } from "../src/lib/crm-sales-http";
import { upsertContactRecord, upsertTaskRecord, updateProjectRecord } from "../src/lib/db/crm-write-repositories";
import type { AppSession } from "../src/lib/auth/session";
import type { TenantPool } from "../src/lib/db/tenant-client";
import { getRolePermissions } from "../src/lib/auth/permissions";
import { getProductRoleCapabilities } from "../src/lib/product-model";

test("G06 HTTP receipts: real local PostgreSQL effects survive lost commit responses without replay", { timeout: 180000 }, async t => {
 const db=await startLocalSalesDb(), previous=process.env.DATABASE_URL;
 process.env.DATABASE_URL=`postgresql://${db.role}@127.0.0.1:${db.port}/postgres`;
 try {
  await applySalesSchema(db);
  const options={pool:db.pool as unknown as TenantPool},workspaceId=randomUUID(),projectId=randomUUID(),userId=randomUUID();
  await db.admin.query("insert into workspaces(id,name,operating_model,customer_type) values($1,'SYNTHETIC G06','novalure_internal','novalure_internal')",[workspaceId]);
  await db.admin.query("insert into workspace_users(id,workspace_id,name,email,role,product_role) values($1,$2,'Synthetic owner','g06@example.invalid','owner','novalureAdmin')",[userId,workspaceId]);
  await db.admin.query("insert into projects(id,workspace_id,name,type) values($1,$2,'SYNTHETIC G06 project','Service')",[projectId,workspaceId]);
  const session={authenticated:true,userId,workspaceId,name:"Synthetic owner",email:"g06@example.invalid",workspaceName:"Synthetic",role:"owner",productRole:"novalureAdmin",permissions:getRolePermissions("owner"),productPermissions:getProductRoleCapabilities("novalureAdmin"),source:"database"} as AppSession;
  const request=(target:string,body:Record<string,unknown>):SalesHttpRequest=>({target,method:"POST",body,idempotencyKey:randomUUID(),correlationId:randomUUID()});
  let contactId="",taskId="";
  await t.test("parallel duplicate contact creation persists one domain effect and durable receipt",async()=>{
   const input=request("/api/crm/contacts",{contact:{projectId,name:"SYNTHETIC receipt contact",source:"Manual"}});let calls=0;
   const callback=async()=>{calls++;const result=await upsertContactRecord({session,contact:input.body.contact as Record<string,unknown>},options);return Response.json(result.persisted?{contact:result.data,persisted:true}:{error:result.reason},{status:result.persisted?200:400})};
   const responses=await Promise.all([executeSalesHttp(session,input,callback,options),executeSalesHttp(session,input,callback,options)]);
   assert.equal(calls,1);for(const response of responses)assert.equal(response.status,200);
   const first=await responses[0].json(),second=await responses[1].json();contactId=first.contact.id;
   assert.deepEqual(first.contact,second.contact);assert.equal(first.commandId,second.commandId);assert.equal(first.auditReference,second.auditReference);
   assert.equal(Number((await db.admin.query("select count(*) from contacts where workspace_id=$1",[workspaceId])).rows[0].count),1);
   const conflict=await executeSalesHttp(session,{...input,body:{contact:{projectId,name:"Changed effect"}}},callback,options);assert.equal(conflict.status,409);assert.equal(calls,1);
   await assert.rejects(reconcileSalesHttp(session,{...input,correlationId:randomUUID()},options),{code:"IDEMPOTENCY_CONFLICT"});
  });
  await t.test("contact task and project updates replay exact prior result without a second version bump",async()=>{
   const created=await upsertTaskRecord({session,task:{projectId,title:"SYNTHETIC task"}},options);assert.equal(created.persisted,true);taskId=created.data.id;
   for(const kind of ["contact","task","project"] as const){
    const entity=kind==="contact"?{id:contactId,name:"Changed contact"}:kind==="task"?{id:taskId,title:"Changed task"}:{id:projectId,name:"Changed project"};
    const input=request(`/api/crm/${kind}s`,{[kind]:entity,expectedVersion:1});input.method="PATCH";let calls=0;
    const callback=async()=>{calls++;const result=kind==="contact"?await upsertContactRecord({session,contact:entity,expectedVersion:1},options):kind==="task"?await upsertTaskRecord({session,task:entity,expectedVersion:1},options):await updateProjectRecord({session,project:entity,expectedVersion:1},options);return Response.json(result.persisted?{[kind]:result.data}:{error:result.reason},{status:result.persisted?200:409})};
    const first=await executeSalesHttp(session,input,callback,options);assert.equal(first.status,200,await first.clone().text());
    const repeated=await executeSalesHttp(session,input,callback,options);assert.equal(repeated.status,200);assert.equal(calls,1);
    assert.equal(Number((await db.admin.query(`select version from ${kind}s where id=$1`,[entity.id])).rows[0].version),2);
    const reconciled=await reconcileSalesHttp(session,input,options);assert.equal(reconciled.status,"COMMITTED");
    const stale=await executeSalesHttp(session,{...input,idempotencyKey:randomUUID()},callback,options);assert.equal(stale.status,409);
   }
  });
  await t.test("server commits then loses COMMIT acknowledgement: authorized lookup proves one effect",async()=>{
   const input=request("/api/crm/tasks",{task:{projectId,title:"SYNTHETIC lost acknowledgement"}});let calls=0,dropped=false;
   const droppingPool={connect:async()=>{const client=await db.pool.connect();return new Proxy(client,{get(target,key){if(key==="query")return async(...args:unknown[])=>{const result=await Reflect.apply(target.query,target,args);if(!dropped&&typeof args[0]==="string"&&args[0].trim().toLowerCase()==="commit"){dropped=true;throw new Error("SYNTHETIC_LOST_COMMIT_ACK")}return result};const member=Reflect.get(target,key);return typeof member==="function"?member.bind(target):member}})}} as unknown as TenantPool;
   const response=await executeSalesHttp(session,input,async()=>{calls++;const result=await upsertTaskRecord({session,task:input.body.task as Record<string,unknown>},options);return Response.json(result.persisted?{task:result.data}:{error:result.reason},{status:result.persisted?200:400})},{pool:droppingPool});
   assert.equal(dropped,true);assert.equal(response.status,503);assert.equal(calls,1);
   const receipt=await reconcileSalesHttp(session,input,options);assert.equal(receipt.status,"COMMITTED");
   const retry=await executeSalesHttp(session,input,async()=>{assert.fail("Already committed handler must not run")},options);assert.equal(retry.status,200);
   assert.equal(Number((await db.admin.query("select count(*) from tasks where workspace_id=$1 and title='SYNTHETIC lost acknowledgement'",[workspaceId])).rows[0].count),1);
  });
  await t.test("not-found lookup creates nothing, different tenant and revoked membership receive no result",async()=>{
   const input=request("/api/crm/tasks",{task:{projectId,title:"SYNTHETIC never executed"}});
   assert.equal((await reconcileSalesHttp(session,input,options)).status,"NOT_FOUND");
   const changed={...session,workspaceId:randomUUID()};await assert.rejects(reconcileSalesHttp(changed,input,options));
   await db.admin.query("update workspace_users set status='suspended' where id=$1",[userId]);
   await assert.rejects(reconcileSalesHttp(session,input,options));
   assert.equal(Number((await db.admin.query("select count(*) from tasks where title='SYNTHETIC never executed'",[])).rows[0].count),0);
  });
 }finally{if(previous===undefined)delete process.env.DATABASE_URL;else process.env.DATABASE_URL=previous;await db.stop()}
});
