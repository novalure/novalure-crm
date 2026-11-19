import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import type { AppSession } from "../src/lib/auth/session";
import { getRolePermissions } from "../src/lib/auth/permissions";
import { getProductRoleCapabilities } from "../src/lib/product-model";
import { withCrmRead } from "../src/lib/crm-command";
import type { TenantPool } from "../src/lib/db/tenant-client";
import { createPropertyUnitRecord, updatePropertyUnitDetailsRecord, confirmPropertyUnitInvestorPriceRecord } from "../src/lib/db/property-inventory-repositories";
import { loadPropertyUnits, loadPaginatedPropertyUnits } from "../src/lib/db/crm-loaders";
import { runPropertySalesCommand } from "../src/lib/db/property-sales-repositories";
import { parseUnitDetailsPatch, unitDetailsDraft, unitPriceInput } from "../src/lib/property-unit-details";
import { parsePropertyEuroCents } from "../src/lib/property-money";
import { startLocalSalesDb, applySalesSchema } from "./lib/local-sales-db.mjs";

test("unit detail parsing distinguishes unknown and zero and rejects lossy or malformed values", () => {
  assert.deepEqual(parseUnitDetailsPatch({ balconyAreaSqm: "0", gardenAreaSqm: "12,35", bedrooms: "2", heatingYear: "", carportCount: null }), { balconyAreaSqm: 0, gardenAreaSqm: 12.35, bedrooms: 2, heatingYear: null, carportCount: null });
  assert.deepEqual(parseUnitDetailsPatch({}), {});
  for (const value of [true, {}, "12m2", "1.234", -1, Infinity]) assert.throws(() => parseUnitDetailsPatch({ terraceAreaSqm: value }));
  for (const value of [true, "2.5", 1.2, -1, 10001]) assert.throws(() => parseUnitDetailsPatch({ carportCount: value }));
  for (const value of [0, 1799, 2201, "2000x"]) assert.throws(() => parseUnitDetailsPatch({ heatingYear: value }));
  assert.equal(unitDetailsDraft({ balconyAreaSqm: 0 }).balconyAreaSqm, "0");
  assert.equal(unitDetailsDraft().balconyAreaSqm, "");
  for(const cents of [0,1,35000001,9007199254740990,Number.MAX_SAFE_INTEGER]) assert.equal(parsePropertyEuroCents(unitPriceInput(cents)),cents);
  assert.throws(()=>unitPriceInput(-1));
  for(const cents of [-1,-35000001,-Number.MAX_SAFE_INTEGER]) assert.equal(parsePropertyEuroCents(unitPriceInput(cents,{allowNegative:true}),{allowNegative:true}),cents);
});

test("structured unit details persist with CAS, narrow permissions, audit, price preservation and real loader round trips", { timeout: 180000 }, async t => {
  const db=await startLocalSalesDb();
  try {
    await applySalesSchema(db,{maxMigrationNumber:184});
    await db.admin.query(await readFile("migrations/186_property_unit_details.sql","utf8"));
    const w=randomUUID(),otherW=randomUUID(),ownerId=randomUUID(),agentId=randomUUID(),unassignedId=randomUUID(),project=randomUUID(),otherProject=randomUUID(),organization=randomUUID(),developerContact=randomUUID(),buyer=randomUUID(),lead=randomUUID();
    const options={pool:db.pool as unknown as TenantPool};
    const owner:AppSession={authenticated:true,workspaceId:w,userId:ownerId,workspaceName:"SYNTHETIC units",name:"SYNTHETIC owner",email:"unit-owner@example.invalid",role:"owner",productRole:"customer_owner",permissions:getRolePermissions("owner"),productPermissions:getProductRoleCapabilities("customer_owner"),source:"database"};
    const agent:AppSession={...owner,userId:agentId,role:"agent",productRole:"developer_sales",permissions:getRolePermissions("agent"),productPermissions:getProductRoleCapabilities("developer_sales")};
    await db.admin.query("insert into workspaces(id,name,operating_model) values($1,'SYNTHETIC units','self_service_customer'),($2,'SYNTHETIC foreign','self_service_customer')",[w,otherW]);
    await db.admin.query("insert into workspace_users(id,workspace_id,name,email,role,product_role,status) values($1,$4,'SYNTHETIC owner','unit-owner@example.invalid','owner','customer_owner','active'),($2,$4,'SYNTHETIC agent','unit-agent@example.invalid','agent','developer_sales','active'),($3,$4,'SYNTHETIC unassigned','unit-unassigned@example.invalid','agent','developer_sales','active')",[ownerId,agentId,unassignedId,w]);
    await db.admin.query("insert into projects(id,workspace_id,name,type) values($1,$2,'SYNTHETIC project','Service'),($3,$4,'SYNTHETIC foreign project','Service')",[project,w,otherProject,otherW]);
    await db.admin.query("insert into project_pipeline_permissions(workspace_id,project_id,user_id,can_read,can_edit_deals) values($1,$2,$3,true,true)",[w,project,agentId]);
    await db.admin.query("insert into organizations(id,workspace_id,project_id,name,type) values($1,$2,$3,'SYNTHETIC developer','Bauträger')",[organization,w,project]);
    await db.admin.query("insert into contacts(id,workspace_id,project_id,organization_id,name,role,email) values($1,$3,$4,$5,'SYNTHETIC developer','Bauträger','developer@example.invalid'),($2,$3,$4,null,'SYNTHETIC buyer','Käufer','buyer@example.invalid')",[developerContact,buyer,w,project,organization]);
    await db.admin.query("insert into leads(id,workspace_id,project_id,contact_id,type,intent) values($1,$2,$3,$4,'Käufer','SYNTHETIC unit inquiry')",[lead,w,project,buyer]);
    await db.admin.query("insert into buyer_search_profiles(workspace_id,project_id,buyer_lead_id,contact_id,title) values($1,$2,$3,$4,'SYNTHETIC unit profile')",[w,project,lead,buyer]);
    await runPropertySalesCommand(owner,{action:"authority.assign",projectId:project,idempotencyKey:randomUUID(),correlationId:randomUUID(),payload:{userId:ownerId,developerOrganizationId:organization,contactId:developerContact,canConfirmPrice:true,sourceReference:"SYNTHETIC explicit developer price mandate"}},options);
    const metadata=()=>({idempotencyKey:randomUUID(),correlationId:randomUUID()});
    const fresh=async(extra:Record<string,unknown>={})=>(await createPropertyUnitRecord({session:owner,projectId:project,unitNumber:randomUUID(),options,...metadata(),...extra})).data;
    const update=(unitId:string,expectedVersion:number,details:Record<string,unknown>,session=owner)=>updatePropertyUnitDetailsRecord({session,projectId:project,unitId,expectedVersion,details,options,...metadata()});
    const investor=(unitId:string,expectedVersion:number,investorPriceCents:unknown,session=owner)=>confirmPropertyUnitInvestorPriceRecord({session,projectId:project,unitId,expectedVersion,investorPriceCents,sourceReference:"SYNTHETIC documented investor price",options,...metadata()});

    await t.test("new fields persist as typed numbers with unknown distinct from explicit zero",async()=>{
      const unit=await fresh({balconyAreaSqm:"0",terraceAreaSqm:"12.35",gardenAreaSqm:"84,50",loggiaAreaSqm:null,roofTerraceAreaSqm:3.75,undergroundParkingCount:"2",carportCount:0,outdoorParkingCount:1,bedrooms:2,heatingYear:"2022"});
      assert.equal(unit.balconyAreaSqm,0);assert.equal(unit.terraceAreaSqm,12.35);assert.equal(unit.gardenAreaSqm,84.5);assert.equal(unit.loggiaAreaSqm,null);assert.equal(unit.roofTerraceAreaSqm,3.75);assert.equal(unit.undergroundParkingCount,2);assert.equal(unit.carportCount,0);assert.equal(unit.bedrooms,2);assert.equal(unit.heatingYear,2022);assert.equal(unit.investorPriceCents,null);
      const loaded=await withCrmRead(owner,async()=>({all:await loadPropertyUnits(w),page:await loadPaginatedPropertyUnits(w,{projectId:project})}),options);
      for(const rows of [loaded.all,loaded.page.units]) {const reloaded=rows.find(row=>row.id===unit.id)!;assert.equal(reloaded.terraceAreaSqm,12.35);assert.equal(reloaded.balconyAreaSqm,0);assert.equal(reloaded.loggiaAreaSqm,null);assert.equal(reloaded.heatingYear,2022);}
    });
    await t.test("partial updates preserve omitted details, explicit null clears, prices and reserved status survive",async()=>{
      const unit=await fresh({terraceAreaSqm:15,gardenAreaSqm:10});
      await db.admin.query("update property_units set price_cents=12345678,status='reserved',investor_price_cents=11223344 where id=$1",[unit.id]);
      const changed=(await update(unit.id,unit.version,{terraceAreaSqm:null,carportCount:0})).data;
      assert.equal(changed.terraceAreaSqm,null);assert.equal(changed.gardenAreaSqm,10);assert.equal(changed.carportCount,0);assert.equal(changed.priceCents,12345678);assert.equal(changed.investorPriceCents,11223344);assert.equal(changed.status,"reserved");
      await assert.rejects(update(unit.id,changed.version,{investorPriceCents:1}),/Unknown command field/);
    });
    await t.test("simultaneous versioned edits admit exactly one writer and one audit record",async()=>{
      const unit=await fresh();
      const results=await Promise.allSettled([update(unit.id,unit.version,{bedrooms:1}),update(unit.id,unit.version,{bedrooms:2})]);
      assert.equal(results.filter(result=>result.status==="fulfilled").length,1);
      const failed=results.find(result=>result.status==="rejected") as PromiseRejectedResult;assert.match(String(failed.reason),/Unit changed/);
      assert.equal((await db.admin.query("select count(*)::int as n from property_unit_audit_events where unit_id=$1",[unit.id])).rows[0].n,1);
    });
    await t.test("details update queues matching refresh and increments authoritative unit source version",async()=>{
      const unit=await fresh();
      await db.admin.query("update lead_match_refresh_jobs set processed_at=now() where workspace_id=$1 and lead_id=$2",[w,lead]);
      const changed=(await update(unit.id,unit.version,{balconyAreaSqm:4.25,undergroundParkingCount:1})).data;
      assert.equal(changed.version,unit.version+1);
      const job=(await db.admin.query("select processed_at from lead_match_refresh_jobs where workspace_id=$1 and lead_id=$2",[w,lead])).rows[0];assert.equal(job.processed_at,null);
    });
    await t.test("project-authorized salesperson edits details but cannot confirm either price without explicit mandate",async()=>{
      const unit=await fresh();const changed=(await update(unit.id,unit.version,{bedrooms:3},agent)).data;
      await assert.rejects(investor(unit.id,changed.version,100,agent),/Explicit project price authority/);
      await assert.rejects(createPropertyUnitRecord({session:agent,projectId:project,unitNumber:randomUUID(),investorPriceCents:100,options,...metadata()}),/authorized investor price/);
    });
    await t.test("investor confirmation uses exact cents, is replayable, auditable and preserves ordinary price",async()=>{
      const unit=await fresh();await db.admin.query("update property_units set price_cents=40000099 where id=$1",[unit.id]);
      const command={session:owner,projectId:project,unitId:unit.id,expectedVersion:unit.version,investorPriceCents:35000001,sourceReference:"SYNTHETIC confirmed EUR 350000.01",options,...metadata()};
      const result=await confirmPropertyUnitInvestorPriceRecord(command);assert.equal(result.data.investorPriceCents,35000001);assert.equal(result.data.priceCents,40000099);
      assert.equal((await confirmPropertyUnitInvestorPriceRecord(command)).replayed,true);
      const audit=(await db.admin.query("select before,after,reason from property_unit_audit_events where unit_id=$1",[unit.id])).rows;assert.equal(audit.length,1);assert.equal(audit[0].after.investorPriceCents,35000001);assert.equal(audit[0].reason,command.sourceReference);
      const cleared=(await investor(unit.id,result.data.version,null)).data;assert.equal(cleared.investorPriceCents,null);assert.equal(cleared.priceCents,40000099);
      for(const value of ["100",1.5,-1,Number.MAX_SAFE_INTEGER+1]) await assert.rejects(investor(unit.id,cleared.version,value),/safe integer EUR cents/);
    });
    await t.test("revoked price authority and revoked project access fail before mutation or receipt",async()=>{
      const unit=await fresh();
      await db.admin.query("update crm_project_sales_authorities set enabled=false where workspace_id=$1 and user_id=$2",[w,ownerId]);
      await assert.rejects(investor(unit.id,unit.version,100),/Explicit project price authority/);
      await assert.rejects(update(unit.id,unit.version,{bedrooms:1},{...agent,userId:unassignedId}),/Project access/);
      await assert.rejects(updatePropertyUnitDetailsRecord({session:owner,projectId:otherProject,unitId:unit.id,expectedVersion:unit.version,details:{bedrooms:1},options,...metadata()}),/Project access/);
      assert.equal(Number((await db.admin.query("select version from property_units where id=$1",[unit.id])).rows[0].version),unit.version);
    });
    await t.test("DB range checks reject invalid direct values and audit failure rolls back unit and receipt",async()=>{
      const unit=await fresh();
      for(const sql of ["balcony_area_sqm=-1","balcony_area_sqm='NaN'","carport_count=-1","heating_year=1700","investor_price_cents=9007199254740992"]) await assert.rejects(db.admin.query(`update property_units set ${sql} where id=$1`,[unit.id]),/check constraint/);
      await db.admin.query("create function synthetic_unit_audit_failure() returns trigger language plpgsql as $$ begin raise exception 'SYNTHETIC audit failure'; end $$");
      await db.admin.query("create trigger synthetic_unit_audit_failure before insert on property_unit_audit_events for each row execute function synthetic_unit_audit_failure()");
      const meta=metadata();await assert.rejects(updatePropertyUnitDetailsRecord({session:owner,projectId:project,unitId:unit.id,expectedVersion:unit.version,details:{bedrooms:8},options,...meta}),/SYNTHETIC audit failure/);
      const stored=(await db.admin.query("select bedrooms,version from property_units where id=$1",[unit.id])).rows[0];assert.equal(stored.bedrooms,null);assert.equal(Number(stored.version),unit.version);
      assert.equal((await db.admin.query("select count(*)::int as n from crm_command_receipts where idempotency_key=$1",[meta.idempotencyKey])).rows[0].n,0);
      await db.admin.query("drop trigger synthetic_unit_audit_failure on property_unit_audit_events");
    });
  } finally {await db.stop();}
});
