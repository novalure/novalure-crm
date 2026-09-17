import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { getRolePermissions } from "../src/lib/auth/permissions";
import { getProductRoleCapabilities } from "../src/lib/product-model";
import type { AppSession } from "../src/lib/auth/session";
import type { TenantPool } from "../src/lib/db/tenant-client";
import { runPropertySalesCommand, type PropertySalesCommand } from "../src/lib/db/property-sales-repositories";
import { startLocalSalesDb, applySalesSchema } from "./lib/local-sales-db.mjs";

test("final Flow B priorities, tenant negatives and parallel status changes on real PostgreSQL", async t => {
 const db=await startLocalSalesDb();
 try {
  await applySalesSchema(db);
  const w=randomUUID(), foreign=randomUUID(), p=randomUUID(), fp=randomUUID(), actor=randomUUID(), org=randomUUID(), dc=randomUUID();
  await db.admin.query("insert into workspaces(id,name,operating_model,customer_type) values($1,'SYNTHETIC final workflow','self_service_customer','property_developer'),($2,'SYNTHETIC foreign workflow','self_service_customer','property_developer')",[w,foreign]);
  await db.admin.query("insert into workspace_users(id,workspace_id,name,email,role,product_role) values($1,$2,'SYNTHETIC final actor','final@example.invalid','owner','customer_owner')",[actor,w]);
  await db.admin.query("insert into projects(id,workspace_id,name,type) values($1,$2,'SYNTHETIC project','Bauträger'),($3,$4,'SYNTHETIC foreign project','Bauträger')",[p,w,fp,foreign]);
  await db.admin.query("insert into organizations(id,workspace_id,project_id,name,type) values($1,$2,$3,'SYNTHETIC developer','Bauträger')",[org,w,p]);
  await db.admin.query("insert into contacts(id,workspace_id,project_id,organization_id,name,role,email) values($1,$2,$3,$4,'SYNTHETIC developer','Bauträger','developer@example.invalid')",[dc,w,p,org]);
  const session:AppSession={authenticated:true,userId:actor,workspaceId:w,workspaceName:"SYNTHETIC",name:"SYNTHETIC",email:"final@example.invalid",role:"owner",productRole:"customer_owner",permissions:getRolePermissions("owner"),productPermissions:getProductRoleCapabilities("customer_owner"),source:"database"};
  const command=(action:PropertySalesCommand["action"],payload:Record<string,unknown>,expectedVersion?:number):PropertySalesCommand=>({action,projectId:p,payload,expectedVersion,idempotencyKey:randomUUID(),correlationId:randomUUID()});
  const run=(input:PropertySalesCommand)=>runPropertySalesCommand(session,input,{pool:db.pool as unknown as TenantPool});
  const fixture=async(workspace=w,project=p)=>{
   const contact=randomUUID(),lead=randomUUID(),unit=randomUUID();
   await db.admin.query("insert into contacts(id,workspace_id,project_id,name,role,email) values($1,$2,$3,'SYNTHETIC buyer','Käufer','buyer@example.invalid')",[contact,workspace,project]);
   await db.admin.query("insert into leads(id,workspace_id,project_id,contact_id,type,intent) values($1,$2,$3,$4,'Käufer','SYNTHETIC inquiry')",[lead,workspace,project,contact]);
   await db.admin.query("insert into property_units(id,workspace_id,project_id,unit_number,status) values($1,$2,$3,$4,'available')",[unit,workspace,project,'SYN-'+unit.slice(0,8)]);
   return {lead,unit};
  };
  const qualify=(f:{lead:string;unit:string},priority:string)=>command("qualification.save",{leadId:f.lead,desiredUnitId:f.unit,budgetFrom:200000,budgetTo:400000,financingStatus:"vorqualifiziert",purchaseTimeline:"2030",useCase:"Eigennutzung",priority,sourceReference:"SYNTHETIC buyer interview"},1);
  for(const priority of ["high","medium","low"]){
   await t.test(priority+" qualification persists actor, source, version and an audited handover",async()=>{
    const f=await fixture();const input=qualify(f,priority);await run(input);
    const row=(await db.admin.query("select version,sales_qualification from leads where id=$1",[f.lead])).rows[0];
    assert.equal(row.sales_qualification.priority,priority);assert.equal(row.sales_qualification.qualifiedBy,actor);assert.equal(row.sales_qualification.sourceReference,"SYNTHETIC buyer interview");assert.equal(row.sales_qualification.version,Number(row.version));
    const handover=command("handover.create",{leadId:f.lead,recipientUserId:actor,sourceReference:"SYNTHETIC qualified handover"},2);await run(handover);
    const evidence=(await db.admin.query("select actor_id,source_reference,qualification_version from lead_sales_handovers where lead_id=$1",[f.lead])).rows[0];
    assert.equal(evidence.actor_id,actor);assert.equal(evidence.source_reference,"SYNTHETIC qualified handover");assert.equal(Number(evidence.qualification_version),2);
    assert.equal((await db.admin.query("select count(*) from crm_command_receipts where workspace_id=$1 and idempotency_key in ($2,$3)",[w,input.idempotencyKey,handover.idempotencyKey])).rows[0].count,"2");
   });
  }
  await t.test("cross-tenant qualification and handover cannot change source data or leave receipts",async()=>{
   const f=await fixture(foreign,fp);const before=(await db.admin.query("select to_jsonb(l) as row from leads l where id=$1",[f.lead])).rows[0].row;
   const inputs=[qualify(f,"high"),command("handover.create",{leadId:f.lead,recipientUserId:actor,sourceReference:"SYNTHETIC forbidden handover"},1)];
   for(const input of inputs){
    await assert.rejects(run(input),{code:"NOT_FOUND"});
    await assert.rejects(run({...input,projectId:fp}),{code:"PROJECT_FORBIDDEN"});
    assert.equal((await db.admin.query("select count(*) from crm_command_receipts where idempotency_key=$1",[input.idempotencyKey])).rows[0].count,"0");
   }
   assert.deepEqual((await db.admin.query("select to_jsonb(l) as row from leads l where id=$1",[f.lead])).rows[0].row,before);
   assert.equal((await db.admin.query("select count(*) from lead_sales_handovers where lead_id=$1",[f.lead])).rows[0].count,"0");
  });
  await run(command("authority.assign",{userId:actor,developerOrganizationId:org,contactId:dc,canConfirmReservation:true,canConfirmSale:true,sourceReference:"SYNTHETIC explicit developer authority"}));
  const f=await fixture();await run(qualify(f,"medium"));await run(command("handover.create",{leadId:f.lead,recipientUserId:actor,sourceReference:"SYNTHETIC concurrency handover"},2));
  let reservationId="";
  const exactlyOne=async(inputs:PropertySalesCommand[])=>{
   const results=await Promise.allSettled(inputs.map(run));
   const successes=results.filter(r=>r.status==="fulfilled");assert.equal(successes.length,1);
   const rejected=results.find(r=>r.status==="rejected");assert.ok(rejected?.status==="rejected");assert.equal(rejected.reason.code,"CONFLICT");
   const success=results.find(r=>r.status==="fulfilled");assert.ok(success?.status==="fulfilled");
   const winningInput=inputs[results.indexOf(success)];assert.equal((await run(winningInput)).replayed,true);
   assert.equal((await db.admin.query("select count(*) from crm_command_receipts where idempotency_key=any($1::text[])",[inputs.map(i=>i.idempotencyKey)])).rows[0].count,"1");
   return success.value;
  };
  await t.test("parallel distinct reservation requests commit exactly one request and keep unit available",async()=>{
   const payload={unitId:f.unit,leadId:f.lead,expiresAt:"2031-01-01T12:00:00Z"};
   const result=await exactlyOne([command("reservation.request",payload,1),command("reservation.request",payload,1)]);reservationId=String(result.data.record?.id);
   assert.equal((await db.admin.query("select status from property_units where id=$1",[f.unit])).rows[0].status,"available");
   assert.equal((await db.admin.query("select count(*) from property_reservations where unit_id=$1",[f.unit])).rows[0].count,"1");
  });
  await t.test("parallel reservation confirmations commit exactly one status event and version",async()=>{
   const payload={reservationId,unitVersion:1,sourceReference:"SYNTHETIC confirmed reservation"};
   await exactlyOne([command("reservation.confirm",payload,1),command("reservation.confirm",payload,1)]);
   const row=(await db.admin.query("select status,version from property_units where id=$1",[f.unit])).rows[0];assert.equal(row.status,"reserved");assert.equal(Number(row.version),2);
   assert.equal((await db.admin.query("select count(*) from property_unit_audit_events where unit_id=$1",[f.unit])).rows[0].count,"1");
  });
  await t.test("parallel sale confirmations commit exactly one sale and never release a sold unit",async()=>{
   const payload={reservationId,unitVersion:2,sourceReference:"SYNTHETIC confirmed sale"};
   await exactlyOne([command("sale.confirm",payload,2),command("sale.confirm",payload,2)]);
   const row=(await db.admin.query("select status,version from property_units where id=$1",[f.unit])).rows[0];assert.equal(row.status,"sold");assert.equal(Number(row.version),3);
   assert.equal((await db.admin.query("select count(*) from property_sales where unit_id=$1",[f.unit])).rows[0].count,"1");
   assert.equal((await db.admin.query("select count(*) from property_unit_audit_events where unit_id=$1",[f.unit])).rows[0].count,"2");
   await assert.rejects(run(command("reservation.expire",{reservationId,unitVersion:3},3)),/Invalid reservation/);
   await assert.rejects(run(command("reservation.request",{unitId:f.unit,leadId:f.lead,expiresAt:"2031-01-01T12:00:00Z"},3)),/Invalid reservation/);
   assert.equal((await db.admin.query("select status from property_units where id=$1",[f.unit])).rows[0].status,"sold");
  });
 } finally {await db.stop()}
});
