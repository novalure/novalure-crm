import {readFile} from "node:fs/promises";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {test} from "node:test";
import {applySalesSchema,startLocalSalesDb} from "./lib/local-sales-db.mjs";
import {withCrmRead} from "../src/lib/crm-command";
import type {TenantPool} from "../src/lib/db/tenant-client";
import type {AppSession} from "../src/lib/auth/session";
import {getRolePermissions} from "../src/lib/auth/permissions";
import {getProductRoleCapabilities} from "../src/lib/product-model";
import {createSellerListingRecord,savePropertyCostItems,savePropertyTextBlocks} from "../src/lib/db/property-department-repositories";
import {createPropertyGeography} from "../src/lib/property-country";

test("cost/text edit roundtrip preserves unit content, rejects stale replacements and validates amounts before replacement",{timeout:180000},async(t)=>{
 const db=await startLocalSalesDb();
 try{
  await applySalesSchema(db,{maxMigrationNumber:106});
  await db.admin.query(await readFile("migrations/187_property_fragment_editing.sql","utf8"));
  const workspaceId=randomUUID(),userId=randomUUID(),projectId=randomUUID(),unitId=randomUUID();
  await db.admin.query("insert into workspaces(id,name,operating_model,customer_type) values($1,'SYNTHETIC fragments','novalure_internal','novalure_internal')",[workspaceId]);
  await db.admin.query("insert into workspace_users(id,workspace_id,name,email,role,product_role,status) values($1,$2,'Synthetic','fragments@example.invalid','owner','novalureAdmin','active')",[userId,workspaceId]);
  await db.admin.query("insert into projects(id,workspace_id,name,type) values($1,$2,'SYNTHETIC fragments','Service')",[projectId,workspaceId]);
  const session={authenticated:true,userId,workspaceId,workspaceName:"Synthetic",name:"Synthetic",email:"fragments@example.invalid",role:"owner",productRole:"novalureAdmin",permissions:getRolePermissions("owner"),productPermissions:getProductRoleCapabilities("novalureAdmin"),source:"database"} as AppSession;
  const run=<T>(work:()=>Promise<T>)=>withCrmRead(session,work,{pool:db.pool as unknown as TenantPool});
  const created=await run(()=>createSellerListingRecord({session,property:{title:"SYNTHETIC fragments",address:"Synthetic address",projectId,geography:createPropertyGeography("DE","Berlin"),region:"Berlin",price:250000,areaSqm:70,objectType:"Wohnung"}}));
  assert.ok(created.persisted);if(!created.persisted)return;const propertyId=created.data.id;
  await db.admin.query("insert into property_units(id,workspace_id,project_id,unit_number,price_cents,area_sqm) values($1,$2,$3,'UNIT',20000000,50)",[unitId,workspaceId,projectId]);
  await db.admin.query("insert into property_text_blocks(workspace_id,project_id,property_id,unit_id,text_key,title,content,visibility,status) values($1,$2,$3,$4,'internal','Unit note','UNIT PRIVATE','internal','draft')",[workspaceId,projectId,propertyId,unitId]);
  const snapshot=async(table:string)=>(await db.admin.query(`select id,updated_at as "updatedAt" from ${table} where workspace_id=$1 and property_id=$2 and unit_id is null order by id`,[workspaceId,propertyId])).rows.map((r:{id:string;updatedAt:Date})=>({id:r.id,updatedAt:r.updatedAt.toISOString()}));
  const texts=[{textKey:"expose",title:"Deutsch",content:"Gespeicherter deutscher Text",metadata:{language:"de"},visibility:"public",status:"draft"},{textKey:"expose",title:"English",content:"Saved English text",metadata:{language:"en"},visibility:"public",status:"draft"}];
  assert.ok((await run(()=>savePropertyTextBlocks({session,projectId,propertyId,textBlocks:texts,expectedSnapshot:[]}))).persisted);
  const initial=await snapshot("property_text_blocks");assert.equal(initial.length,2);
  assert.ok((await run(()=>savePropertyTextBlocks({session,projectId,propertyId,textBlocks:[{...texts[0],content:"Neue deutsche Fassung"},texts[1]],expectedSnapshot:initial}))).persisted);
  const stale=await run(()=>savePropertyTextBlocks({session,projectId,propertyId,textBlocks:texts,expectedSnapshot:initial}));assert.equal(stale.persisted,false);
  const savedTexts=(await db.admin.query("select content from property_text_blocks where property_id=$1 order by content",[propertyId])).rows.map((x:{content:string})=>x.content);
  assert.deepEqual(savedTexts,["Neue deutsche Fassung","Saved English text","UNIT PRIVATE"]);
  const costs=[{costKey:"operating_costs",groupKey:"monthly",label:"Betriebskosten",monthlyNetCents:10000,monthlyVatCents:2000,monthlyGrossCents:12000,exposeVisible:true,internalNote:"PRIVATE COST NOTE"}];
  assert.ok((await run(()=>savePropertyCostItems({session,projectId,propertyId,costItems:costs,expectedSnapshot:[]}))).persisted);
  const costSnapshot=await snapshot("property_cost_items");
  const invalid=await run(()=>savePropertyCostItems({session,projectId,propertyId,costItems:[{...costs[0],monthlyGrossCents:12.5}],expectedSnapshot:costSnapshot}));assert.equal(invalid.persisted,false);
  assert.equal((await db.admin.query("select monthly_gross_cents from property_cost_items where property_id=$1",[propertyId])).rows[0].monthly_gross_cents,"12000");
  assert.ok((await run(()=>savePropertyCostItems({session,projectId,propertyId,costItems:[{...costs[0],monthlyGrossCents:15000}],expectedSnapshot:costSnapshot}))).persisted);
  assert.equal((await run(()=>savePropertyCostItems({session,projectId,propertyId,costItems:costs,expectedSnapshot:costSnapshot}))).persisted,false);
  const freshCosts=await snapshot("property_cost_items");const wrongScope=await run(()=>savePropertyCostItems({session,projectId:randomUUID(),propertyId,costItems:[],expectedSnapshot:freshCosts}));assert.equal(wrongScope.persisted,false);

  await t.test("malformed replacement entries and attempted unit fragments are rejected without deleting current rows",async()=>{
   const beforeTexts=await snapshot("property_text_blocks"),beforeCosts=await snapshot("property_cost_items");
   for(const textBlocks of [null,[null],[{}],[{textKey:"expose",content:7}],[{textKey:"expose",content:"not a unit save",unitId}]]){
    const result=await run(()=>savePropertyTextBlocks({session,projectId,propertyId,textBlocks,expectedSnapshot:beforeTexts}));assert.equal(result.persisted,false);assert.deepEqual(await snapshot("property_text_blocks"),beforeTexts);
   }
   for(const costItems of [null,[null],[{}],[{costKey:"operating_costs"}],[{...costs[0],unitId}]]){
    const result=await run(()=>savePropertyCostItems({session,projectId,propertyId,costItems,expectedSnapshot:beforeCosts}));assert.equal(result.persisted,false);assert.deepEqual(await snapshot("property_cost_items"),beforeCosts);
   }
  });
  await t.test("explicit empty replacements clear only property fragments and preserve associated unit content",async()=>{
   await db.admin.query("insert into property_cost_items(workspace_id,project_id,property_id,unit_id,cost_key,label,monthly_gross_cents) values($1,$2,$3,$4,'unit_private','UNIT PRIVATE COST',999)",[workspaceId,projectId,propertyId,unitId]);
   const beforeTexts=await snapshot("property_text_blocks"),beforeCosts=await snapshot("property_cost_items");
   assert.equal((await run(()=>savePropertyTextBlocks({session,projectId,propertyId,textBlocks:[],expectedSnapshot:beforeTexts}))).persisted,true);
   assert.equal((await run(()=>savePropertyCostItems({session,projectId,propertyId,costItems:[],expectedSnapshot:beforeCosts}))).persisted,true);
   assert.equal((await snapshot("property_text_blocks")).length,0);assert.equal((await snapshot("property_cost_items")).length,0);
   const clearedBinding=(await db.admin.query("select canonical_payload #> '{propertyDetails,values,costs.betriebskosten}' as operating from seller_listings where id=$1",[propertyId])).rows[0];assert.equal(clearedBinding.operating,null);
   assert.equal((await db.admin.query("select content from property_text_blocks where property_id=$1 and unit_id=$2",[propertyId,unitId])).rows[0].content,"UNIT PRIVATE");
   assert.equal((await db.admin.query("select monthly_gross_cents from property_cost_items where property_id=$1 and unit_id=$2",[propertyId,unitId])).rows[0].monthly_gross_cents,"999");
   assert.equal((await run(()=>savePropertyTextBlocks({session,projectId,propertyId,textBlocks:texts,expectedSnapshot:[]}))).persisted,true);
   assert.equal((await run(()=>savePropertyCostItems({session,projectId,propertyId,costItems:costs,expectedSnapshot:[]}))).persisted,true);
   const heating={costKey:"heating_costs",groupKey:"monthly",label:"Heating",monthlyGrossCents:1450,exposeVisible:false};
   const twoCostsSnapshot=await snapshot("property_cost_items");
   assert.equal((await run(()=>savePropertyCostItems({session,projectId,propertyId,costItems:[costs[0],heating],expectedSnapshot:twoCostsSnapshot}))).persisted,true);
   const replacementSnapshot=await snapshot("property_cost_items");
   assert.equal((await run(()=>savePropertyCostItems({session,projectId,propertyId,costItems:[heating],expectedSnapshot:replacementSnapshot}))).persisted,true);
   const omittedBinding=(await db.admin.query("select canonical_payload #> '{propertyDetails,values,costs.betriebskosten}' as operating,canonical_payload #> '{propertyDetails,values,costs.heizkosten}' as heating,canonical_payload #> '{propertyDetails,values,areas.wohnfl_che}' as area from seller_listings where id=$1",[propertyId])).rows[0];
   assert.equal(omittedBinding.operating,null);assert.equal(omittedBinding.heating,14.5);assert.equal(omittedBinding.area,70);
  });
  await t.test("new DELETE grants remain constrained by forced RLS for project readers and foreign projects",async()=>{
   const readerId=randomUUID(),foreignProject=randomUUID(),foreignProperty=randomUUID();
   await db.admin.query("insert into workspace_users(id,workspace_id,name,email,role,product_role,status) values($1,$2,'SYNTHETIC reader','fragment-reader@example.invalid','agent','novalureServiceOps','active')",[readerId,workspaceId]);
   await db.admin.query("insert into project_pipeline_permissions(workspace_id,project_id,user_id,can_read,can_edit_deals) values($1,$2,$3,true,false)",[workspaceId,projectId,readerId]);
   await db.admin.query("insert into projects(id,workspace_id,name,type) values($1,$2,'SYNTHETIC inaccessible project','Service')",[foreignProject,workspaceId]);
   await db.admin.query("insert into seller_listings(id,workspace_id,project_id,title,address,region,object_type,area_sqm) values($1,$2,$3,'SYNTHETIC inaccessible property','SYNTHETIC address','Berlin','Wohnung',50)",[foreignProperty,workspaceId,foreignProject]);
   await db.admin.query("insert into property_text_blocks(workspace_id,project_id,property_id,text_key,content) values($1,$2,$3,'expose','FOREIGN PRIVATE')",[workspaceId,foreignProject,foreignProperty]);
   await db.admin.query("insert into property_cost_items(workspace_id,project_id,property_id,cost_key,label) values($1,$2,$3,'foreign','FOREIGN PRIVATE COST')",[workspaceId,foreignProject,foreignProperty]);
   const reader:AppSession={...session,userId:readerId,role:"agent",productRole:"novalureServiceOps",permissions:getRolePermissions("agent"),productPermissions:getProductRoleCapabilities("novalureServiceOps")};
   const asReader=<T>(work:()=>Promise<T>)=>withCrmRead(reader,work,{pool:db.pool as unknown as TenantPool});
   const beforeTexts=await snapshot("property_text_blocks"),beforeCosts=await snapshot("property_cost_items");
   assert.equal((await asReader(()=>savePropertyTextBlocks({session:reader,projectId,propertyId,textBlocks:[],expectedSnapshot:beforeTexts}))).persisted,false);
   assert.equal((await asReader(()=>savePropertyCostItems({session:reader,projectId,propertyId,costItems:[],expectedSnapshot:beforeCosts}))).persisted,false);
   await withCrmRead(reader,async tx=>{
    const security=await tx.queryOne<{super:boolean;bypass:boolean;canDelete:boolean;forced:boolean}>("select r.rolsuper as super,r.rolbypassrls as bypass,has_table_privilege(current_user,'property_text_blocks','DELETE') as \"canDelete\",c.relforcerowsecurity as forced from pg_roles r cross join pg_class c where r.rolname=current_user and c.oid='property_text_blocks'::regclass");
    assert.deepEqual(security,{super:false,bypass:false,canDelete:true,forced:true});
    assert.equal((await tx.query("select id from property_text_blocks where property_id=$1",[propertyId])).length,beforeTexts.length+1);
    for(const table of ["property_text_blocks","property_cost_items"]){
     assert.equal((await tx.query(`delete from ${table} where property_id=$1 returning id`,[propertyId])).length,0);
     assert.equal((await tx.query(`select id from ${table} where property_id=$1`,[foreignProperty])).length,0);
     assert.equal((await tx.query(`delete from ${table} where property_id=$1 returning id`,[foreignProperty])).length,0);
    }
   },{pool:db.pool as unknown as TenantPool});
   assert.deepEqual(await snapshot("property_text_blocks"),beforeTexts);assert.deepEqual(await snapshot("property_cost_items"),beforeCosts);
   assert.equal((await db.admin.query("select count(*)::int as n from property_text_blocks where property_id=$1",[foreignProperty])).rows[0].n,1);
   await db.admin.query("update workspace_users set status='suspended' where id=$1",[readerId]);
   await assert.rejects(asReader(()=>savePropertyTextBlocks({session:reader,projectId,propertyId,textBlocks:[],expectedSnapshot:beforeTexts})),/Active workspace membership/);
  });
  await t.test("activity audit failure rolls back text and cost replacements and preserves canonical source",async()=>{
   const beforeTexts=await snapshot("property_text_blocks"),beforeCosts=await snapshot("property_cost_items");
   const canonical=(await db.admin.query("select canonical_payload,updated_at from seller_listings where id=$1",[propertyId])).rows[0];
   await db.admin.query("create function synthetic_fragment_audit_failure() returns trigger language plpgsql as $$ begin if new.event_type in ('property.text_blocks.saved','property.cost_items.saved') then raise exception 'SYNTHETIC fragment audit failure'; end if; return new; end $$");
   await db.admin.query("create trigger synthetic_fragment_audit_failure before insert on property_activity_events for each row execute function synthetic_fragment_audit_failure()");
   try{
    await assert.rejects(run(()=>savePropertyTextBlocks({session,projectId,propertyId,textBlocks:[{...texts[0],content:"MUST ROLLBACK"}],expectedSnapshot:beforeTexts})),/SYNTHETIC fragment audit failure/);
    await assert.rejects(run(()=>savePropertyCostItems({session,projectId,propertyId,costItems:[{...costs[0],monthlyGrossCents:123456}],expectedSnapshot:beforeCosts})),/SYNTHETIC fragment audit failure/);
    assert.deepEqual(await snapshot("property_text_blocks"),beforeTexts);assert.deepEqual(await snapshot("property_cost_items"),beforeCosts);
    assert.deepEqual((await db.admin.query("select canonical_payload,updated_at from seller_listings where id=$1",[propertyId])).rows[0],canonical);
   }finally{await db.admin.query("drop trigger synthetic_fragment_audit_failure on property_activity_events");}
  });
 }finally{await db.stop();}
});
