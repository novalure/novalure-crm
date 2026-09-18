import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { startLocalSalesDb, applySalesSchema } from "./lib/local-sales-db.mjs";
import { upsertLeadRecord, upsertDealRecord, upsertContactRecord, changeDealStageRecord } from "../src/lib/db/crm-write-repositories";
import type { AppSession } from "../src/lib/auth/session";
import type { TenantPool } from "../src/lib/db/tenant-client";
import { getRolePermissions } from "../src/lib/auth/permissions";
import { getProductRoleCapabilities } from "../src/lib/product-model";

test("legacy CRM entry points use atomic scoped commands and cannot bypass sales", { timeout: 180000 }, async t => {
 const db=await startLocalSalesDb(),previous=process.env.DATABASE_URL;
 process.env.DATABASE_URL=`postgresql://${db.role}@127.0.0.1:${db.port}/postgres`;
 try {
  await applySalesSchema(db);
  const options={pool:db.pool as unknown as TenantPool};
  const workspaceId=randomUUID(),userId=randomUUID(),projectId=randomUUID();
  await db.admin.query("insert into workspaces(id,name,operating_model,customer_type) values($1,'SYNTHETIC legacy sales','novalure_internal','novalure_internal')",[workspaceId]);
  await db.admin.query("insert into workspace_users(id,workspace_id,name,email,role,product_role) values($1,$2,'Synthetic owner','synthetic-legacy@example.invalid','owner','novalureAdmin')",[userId,workspaceId]);
  await db.admin.query("insert into projects(id,workspace_id,name,type) values($1,$2,'SYNTHETIC project','Service')",[projectId,workspaceId]);
  const session={authenticated:true,userId,workspaceId,workspaceName:"Synthetic sales",name:"Synthetic owner",email:"synthetic-legacy@example.invalid",role:"owner",productRole:"novalureAdmin",permissions:getRolePermissions("owner"),productPermissions:getProductRoleCapabilities("novalureAdmin"),source:"database"} as AppSession;
  const contact=await upsertContactRecord({session,contact:{name:"SYNTHETIC contact",email:"synthetic-contact@example.invalid",role:"Bauträger",source:"Manual",consent:"Opt-in",projectId}},options);
  assert.equal(contact.persisted,true,JSON.stringify(contact));
  let leadId="",dealId="";
  await t.test("lead create replay requires identical payload and writes one record",async()=>{
   const input={session,idempotencyKey:randomUUID(),lead:{contactId:contact.data.id,projectId,type:"Bauträger" as const,source:"Manual" as const,intent:"Synthetic sales inquiry"}};
   const result=await upsertLeadRecord(input,options);assert.equal(result.persisted,true,JSON.stringify(result));leadId=result.data.id;
   assert.deepEqual(await upsertLeadRecord(input,options),JSON.parse(JSON.stringify(result)));
   const conflict=await upsertLeadRecord({...input,lead:{...input.lead,intent:"changed effect"}},options);assert.equal(conflict.persisted,false);if(!conflict.persisted)assert.match(conflict.reason,/IDEMPOTENCY_CONFLICT/);
   const count=await db.admin.query("select count(*)::int n from leads where workspace_id=$1",[workspaceId]);assert.equal(count.rows[0].n,1);
  });
  await t.test("stale lead update and direct buyer qualification are rejected",async()=>{
   const saved=await upsertLeadRecord({session,requireExisting:true,lead:{id:leadId,version:1,intent:"Updated inquiry"}},options);assert.equal(saved.persisted,true);if(saved.persisted)assert.equal(saved.data.version,2);
   const stale=await upsertLeadRecord({session,requireExisting:true,lead:{id:leadId,version:1,intent:"stale"}},options);assert.equal(stale.persisted,false);if(!stale.persisted)assert.match(stale.reason,/VERSION_CONFLICT/);
   const bypass=await upsertLeadRecord({session,lead:{contactId:contact.data.id,projectId,type:"Käufer",status:"Qualifiziert",source:"Manual"}},options);assert.equal(bypass.persisted,false);if(!bypass.persisted)assert.match(bypass.reason,/CANONICAL_QUALIFICATION_REQUIRED/);
  });
  await t.test("deal creation binds lead and replay digest; version increments on edit",async()=>{
   const input={session,idempotencyKey:randomUUID(),deal:{contactId:contact.data.id,leadId,projectId,name:"Synthetic proposal",stage:"Neu" as const,value:"1000",expectedCloseDate:"2030-12-31"}};
   const result=await upsertDealRecord(input,options);assert.equal(result.persisted,true,JSON.stringify(result));dealId=result.data.id;assert.equal(result.data.leadId,leadId);
   assert.deepEqual(await upsertDealRecord(input,options),JSON.parse(JSON.stringify(result)));
   const conflict=await upsertDealRecord({...input,deal:{...input.deal,value:"2000"}},options);assert.equal(conflict.persisted,false);
   const updated=await upsertDealRecord({session,deal:{id:dealId,version:1,name:"Revised inquiry"}},options);assert.equal(updated.persisted,true);if(updated.persisted)assert.equal(updated.data.version,2);
   const stale=await upsertDealRecord({session,deal:{id:dealId,version:1,name:"Lost update"}},options);assert.equal(stale.persisted,false);
  });
  await t.test("legacy creation and stage change cannot declare a won deal",async()=>{
   const closed=await changeDealStageRecord({session,dealId,expectedVersion:2,toStage:"Gewonnen"},options);assert.equal(closed.persisted,false);if(!closed.persisted)assert.match(closed.reason,/CANONICAL_OFFER_REQUIRED/);
   const created=await upsertDealRecord({session,deal:{contactId:contact.data.id,projectId,name:"Bypass",stage:"Gewonnen",value:"1000",expectedCloseDate:"2030-12-31"}},options);assert.equal(created.persisted,false);
  });
  await t.test("cross-tenant existing resource cannot be rewritten",async()=>{
   const other=randomUUID();await db.admin.query("insert into workspaces(id,name,operating_model) values($1,'Synthetic foreign','self_service_customer')",[other]);
   const foreign=randomUUID();await db.admin.query("insert into deals(id,workspace_id,name) values($1,$2,'Synthetic foreign deal')",[foreign,other]);
   const result=await upsertDealRecord({session,requireExisting:true,deal:{id:foreign,version:1,name:"Unauthorized"}},options);assert.equal(result.persisted,false);
   assert.equal((await db.admin.query("select name from deals where id=$1",[foreign])).rows[0].name,"Synthetic foreign deal");
  });
 } finally {if(previous===undefined)delete process.env.DATABASE_URL;else process.env.DATABASE_URL=previous;await db.stop();}
});