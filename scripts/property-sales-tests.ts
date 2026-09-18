import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";
import { getRolePermissions } from "../src/lib/auth/permissions";
import { getProductRoleCapabilities } from "../src/lib/product-model";
import type { AppSession } from "../src/lib/auth/session";
import type { TenantPool } from "../src/lib/db/tenant-client";
import { runPropertySalesCommand,loadPropertySalesWorkspace,type PropertySalesCommand } from "../src/lib/db/property-sales-repositories";
import { withCrmRead } from "../src/lib/crm-command";
import { upsertBuyerSearchProfile } from "../src/lib/db/broker-entity-repositories";
import { expireOverduePropertyReservations } from "../src/lib/db/reservation-repositories";
import { validateQualification,validateViewing,assertReservationTransition,salesVersion } from "../src/lib/property-sales";
import { startLocalSalesDb,applySalesSchema } from "./lib/local-sales-db.mjs";

const qualification={budgetFrom:200000,budgetTo:400000,financingStatus:"vorqualifiziert",purchaseTimeline:"Q4 2026",useCase:"Eigennutzung",desiredUnitId:randomUUID(),priority:"high",sourceReference:"Synthetic buyer interview"};
describe("Flow B domain validation",()=>{
 test("legacy automatic expiry fails closed before any persistence",async()=>{
  await assert.rejects(expireOverduePropertyReservations({workspaceId:randomUUID(),source:"synthetic-test"}),/AUTOMATIC_RESERVATION_EXPIRY_DISABLED/);
 });

 test("valid qualification computes complete inputs without trusting a complete flag",()=>assert.equal(validateQualification(qualification).priority,"high"));
 for(const key of ["budgetFrom","budgetTo","financingStatus","purchaseTimeline","useCase","desiredUnitId","priority","sourceReference"]){
  test("incomplete qualification rejected: "+key,()=>assert.throws(()=>validateQualification({...qualification,[key]:undefined,complete:true})));
 }
 test("sold units cannot be reserved",()=>assert.throws(()=>assertReservationTransition("reservation.request","new","sold")));
 test("request cannot be converted directly",()=>assert.throws(()=>assertReservationTransition("sale.confirm","requested","available")));
 test("confirmation requires requested + available",()=>{assertReservationTransition("reservation.confirm","requested","available");assert.throws(()=>assertReservationTransition("reservation.confirm","reserved","reserved"))});
 test("explicit version required",()=>{assert.equal(salesVersion(2),2);assert.throws(()=>salesVersion("2"));assert.throws(()=>salesVersion(0))});
 test("viewing rejects reverse dates and unknown time zone",()=>{
  assert.throws(()=>validateViewing({startsAt:"2030-01-01T12:00:00Z",endsAt:"2030-01-01T11:00:00Z",timeZone:"Europe/Vienna",status:"planned"}));
  assert.throws(()=>validateViewing({startsAt:"2030-01-01T10:00:00Z",endsAt:"2030-01-01T11:00:00Z",timeZone:"Unknown/Zone",status:"planned"}));
 });
 test("viewing cannot jump directly to completed",()=>assert.throws(()=>validateViewing({startsAt:"2030-01-01T10:00:00Z",endsAt:"2030-01-01T11:00:00Z",timeZone:"Europe/Vienna",status:"completed"})));
});

describe("Flow B real local PostgreSQL workflow / constraints / RBAC",{concurrency:false},()=>{
 let db:Awaited<ReturnType<typeof startLocalSalesDb>>;
 const ids={workspace:randomUUID(),otherWorkspace:randomUUID(),owner:randomUUID(),agent:randomUUID(),unassigned:randomUUID(),project:randomUUID(),otherProject:randomUUID(),organization:randomUUID(),developerContact:randomUUID(),buyer:randomUUID(),lead:randomUUID(),unit:randomUUID(),listing:randomUUID()};
 const owner:AppSession={authenticated:true,userId:ids.owner,workspaceId:ids.workspace,workspaceName:"Synthetic Flow B",name:"Synthetic owner",email:"owner@example.invalid",role:"owner",productRole:"customer_owner",permissions:getRolePermissions("owner"),productPermissions:getProductRoleCapabilities("customer_owner"),source:"database"};
 const agent:AppSession={...owner,userId:ids.agent,role:"agent",productRole:"developer_sales",permissions:getRolePermissions("agent"),productPermissions:getProductRoleCapabilities("developer_sales")};
 const command=(action:PropertySalesCommand["action"],payload:Record<string,unknown>,expectedVersion?:number):PropertySalesCommand=>({action,projectId:ids.project,payload,expectedVersion,idempotencyKey:randomUUID(),correlationId:randomUUID()});
 const run=(input:PropertySalesCommand,session=owner)=>runPropertySalesCommand(session,input,{pool:db.pool as unknown as TenantPool});
 before(async()=>{
  db=await startLocalSalesDb();await applySalesSchema(db);
  await db.admin.query("insert into workspaces(id,name,operating_model,customer_type) values($1,'Synthetic Flow B','self_service_customer','property_developer'),($2,'Synthetic foreign tenant','self_service_customer','property_developer')",[ids.workspace,ids.otherWorkspace]);
  await db.admin.query("insert into workspace_users(id,workspace_id,name,email,role,product_role) values($1,$3,'Synthetic owner','flow-b-owner@example.invalid','owner','customer_owner'),($2,$3,'Synthetic salesperson','flow-b-sales@example.invalid','agent','developer_sales')",[ids.owner,ids.agent,ids.workspace]);
  await db.admin.query("insert into workspace_users(id,workspace_id,name,email,role,product_role) values($1,$2,'Synthetic unassigned','unassigned@example.invalid','agent','developer_sales')",[ids.unassigned,ids.workspace]);
  await db.admin.query("insert into projects(id,workspace_id,name,type) values($1,$2,'Synthetic project','Bauträger'),($3,$4,'Foreign project','Bauträger')",[ids.project,ids.workspace,ids.otherProject,ids.otherWorkspace]);
  await db.admin.query("insert into project_pipeline_permissions(workspace_id,project_id,user_id,can_read,can_edit_deals) values($1,$2,$3,true,true)",[ids.workspace,ids.project,ids.agent]);
  await db.admin.query("insert into organizations(id,workspace_id,project_id,name,type) values($1,$2,$3,'Synthetic developer','Bauträger')",[ids.organization,ids.workspace,ids.project]);
  await db.admin.query("insert into contacts(id,workspace_id,project_id,organization_id,name,role,email) values($1,$3,$4,$5,'Synthetic developer contact','Bauträger','developer@example.invalid'),($2,$3,$4,null,'Synthetic buyer','Käufer','buyer@example.invalid')",[ids.developerContact,ids.buyer,ids.workspace,ids.project,ids.organization]);
  await db.admin.query("insert into leads(id,workspace_id,project_id,contact_id,type,intent) values($1,$2,$3,$4,'Käufer','Synthetic apartment purchase')",[ids.lead,ids.workspace,ids.project,ids.buyer]);
  await db.admin.query("insert into property_units(id,workspace_id,project_id,unit_number,status) values($1,$2,$3,'SYN-1','available')",[ids.unit,ids.workspace,ids.project]);
 });
 after(async()=>{await db?.stop()});
 test("Flow B completes using explicit authority, qualification, handover, viewing, request, confirmation and sale",async()=>{
  await assert.rejects(run(command("unit.price.confirm",{unitId:ids.unit,priceCents:35000000,sourceReference:"Synthetic source"},1)),/Explicit project authority/);
  await run(command("authority.assign",{userId:ids.owner,developerOrganizationId:ids.organization,contactId:ids.developerContact,canConfirmPrice:true,canConfirmReservation:true,canConfirmSale:true,sourceReference:"Synthetic developer mandate"}));
  const listingSql="insert into seller_listings(id,workspace_id,project_id,unit_id,title,address,region,object_type,area_sqm,public_price_cents,target_price_cents,price_visibility) values($1,$2,$3,$4,'Synthetic listing','Synthetic address','Tirol','Wohnung',70,35000000,35000000,'publish_price')";
  const listingParams=[ids.listing,ids.workspace,ids.project,ids.unit];
  await assert.rejects(db.admin.query(listingSql,listingParams),/authorized confirmed unit price/);
  await run(command("unit.price.confirm",{unitId:ids.unit,priceCents:35000000,sourceReference:"Synthetic confirmed price v1"},1));
  await db.admin.query(listingSql,listingParams);
  await assert.rejects(db.admin.query("update seller_listings set public_price_cents=1 where id=$1",[ids.listing]),/authorized confirmed unit price/);

  await assert.rejects(run(command("qualification.save",{...qualification,leadId:ids.lead,desiredUnitId:ids.unit,budgetTo:undefined,complete:true},1)),/budget range/);
  const q=command("qualification.save",{...qualification,leadId:ids.lead,desiredUnitId:ids.unit},1);
  await run(q);
  await assert.rejects(run(command("qualification.save",{...qualification,leadId:ids.lead,desiredUnitId:ids.unit},1)),/Version changed/);
  const profile=await db.admin.query("select id,budget_to_cents from buyer_search_profiles where workspace_id=$1 and buyer_lead_id=$2",[ids.workspace,ids.lead]);
  assert.equal(Number(profile.rows[0].budget_to_cents),40000000);
  for(const identity of [{id:String(profile.rows[0].id)},{buyerLeadId:ids.lead}]){
   await assert.rejects(withCrmRead(owner,()=>upsertBuyerSearchProfile({session:owner,profile:{...identity,projectId:ids.project,budgetTo:1}},{pool:db.pool as unknown as TenantPool}),{pool:db.pool as unknown as TenantPool}),{code:"CANONICAL_QUALIFICATION_REQUIRED"});
  }
  assert.equal(Number((await db.admin.query("select budget_to_cents from buyer_search_profiles where workspace_id=$1 and buyer_lead_id=$2",[ids.workspace,ids.lead])).rows[0].budget_to_cents),40000000);

  await assert.rejects(run(command("handover.create",{leadId:ids.lead,recipientUserId:ids.unassigned,sourceReference:"Synthetic invalid recipient"},2)),/Active project recipient/);
  const h=command("handover.create",{leadId:ids.lead,recipientUserId:ids.agent,sourceReference:"Synthetic handover"},2);
  await run(h);assert.equal((await run(h)).replayed,true);
  await assert.rejects(run(command("handover.create",h.payload,3)),/current complete qualification/);
  const viewing=await run(command("viewing.save",{unitId:ids.unit,leadId:ids.lead,ownerUserId:ids.agent,startsAt:"2030-01-01T10:00:00Z",endsAt:"2030-01-01T11:00:00Z",timeZone:"Europe/Vienna",status:"planned"}));
  const viewingId=String(viewing.data.record?.id);
  const viewPayload={viewingId,unitId:ids.unit,leadId:ids.lead,ownerUserId:ids.agent,startsAt:"2030-01-01T10:00:00Z",endsAt:"2030-01-01T11:00:00Z",timeZone:"Europe/Vienna"};
  await run(command("viewing.save",{...viewPayload,status:"confirmed"},1));
  await run(command("viewing.save",{...viewPayload,status:"completed"},2));
  const request=command("reservation.request",{unitId:ids.unit,leadId:ids.lead,expiresAt:"2031-01-01T12:00:00Z"},2);
  const requestResult=await run(request),reservationId=String(requestResult.data.record?.id);
  assert.equal((await run(request)).replayed,true);
  assert.equal((await db.admin.query("select status from property_units where id=$1",[ids.unit])).rows[0].status,"available");
  await assert.rejects(run(command("reservation.request",request.payload,2)),/already has an open reservation/);
  const confirm=command("reservation.confirm",{reservationId,unitVersion:2,sourceReference:"Synthetic authorized reservation"},1);
  await assert.rejects(run(confirm,agent),/Explicit project authority/);
  await run(confirm);
  assert.equal((await db.admin.query("select status from property_units where id=$1",[ids.unit])).rows[0].status,"reserved");
  await assert.rejects(run(command("reservation.expire",{reservationId,unitVersion:3},2),agent),/expiry has not been reached/);
  assert.equal((await db.admin.query("select status from property_units where id=$1",[ids.unit])).rows[0].status,"reserved");
  const sale=command("sale.confirm",{reservationId,unitVersion:3,sourceReference:"Synthetic completed sale confirmation"},2);
  await assert.rejects(run(sale,agent),/Explicit project authority/);
  await run(sale);assert.equal((await run(sale)).replayed,true);
  await assert.rejects(run(command("sale.confirm",sale.payload,3)),/Version changed|Invalid reservation/);
  await assert.rejects(run(command("reservation.request",request.payload,4)),/Invalid reservation/);
  const persisted=(await db.admin.query("select status,version from property_units where id=$1",[ids.unit])).rows[0];
  assert.equal(persisted.status,"sold");assert.equal(Number(persisted.version),4);
  assert.equal(Number((await db.admin.query("select count(*) from property_sales where workspace_id=$1",[ids.workspace])).rows[0].count),1);
  assert.equal(Number((await db.admin.query("select count(*) from property_unit_audit_events where workspace_id=$1",[ids.workspace])).rows[0].count),3);
 });
 test("cross-tenant reads and writes fail",async()=>{
  await assert.rejects(loadPropertySalesWorkspace(owner,ids.otherProject,{pool:db.pool as unknown as TenantPool}),/Project access/);
  await assert.rejects(run({...command("unit.price.confirm",{unitId:ids.unit,priceCents:1,sourceReference:"Synthetic forbidden"},4),projectId:ids.otherProject}),/Project access/);
 });
 test("new foreign-key constraints reject cross-tenant authority",async()=>{
  await assert.rejects(db.admin.query("insert into crm_project_sales_authorities(workspace_id,project_id,user_id,developer_organization_id,contact_id,assignment_source,assigned_by) values($1,$2,$3,$4,$5,'Synthetic invalid',$3)",[ids.otherWorkspace,ids.otherProject,ids.owner,ids.organization,ids.developerContact]),/foreign key/);
 });
 test("failed command rolls back business state and immutable receipt",async()=>{
  const before=await db.admin.query("select count(*) from crm_command_receipts where workspace_id=$1",[ids.workspace]);
  await assert.rejects(run(command("unit.price.confirm",{unitId:ids.unit,priceCents:100,sourceReference:""},4)),/source/);
  const after=await db.admin.query("select count(*) from crm_command_receipts where workspace_id=$1",[ids.workspace]);
  assert.equal(before.rows[0].count,after.rows[0].count);
  assert.equal(Number((await db.admin.query("select price_cents from property_units where id=$1",[ids.unit])).rows[0].price_cents),35000000);
 });

 test("audit failure rolls back price write, status evidence and command receipt atomically",async()=>{
  const count=await db.admin.query("select count(*) from crm_command_receipts where workspace_id=$1",[ids.workspace]);
  await db.admin.query("create function synthetic_reject_unit_audit() returns trigger language plpgsql as $$ begin raise exception 'synthetic audit failure'; end $$");
  await db.admin.query("create trigger synthetic_reject_unit_audit before insert on property_unit_audit_events for each row execute function synthetic_reject_unit_audit()");
  try{
   await assert.rejects(run(command("unit.price.confirm",{unitId:ids.unit,priceCents:100,sourceReference:"Synthetic failpoint"},4)),/synthetic audit failure/);
   assert.equal(Number((await db.admin.query("select price_cents from property_units where id=$1",[ids.unit])).rows[0].price_cents),35000000);
   assert.equal(count.rows[0].count,(await db.admin.query("select count(*) from crm_command_receipts where workspace_id=$1",[ids.workspace])).rows[0].count);
  }finally{await db.admin.query("drop trigger synthetic_reject_unit_audit on property_unit_audit_events");await db.admin.query("drop function synthetic_reject_unit_audit()")}
 });

 test("simultaneous stale updates commit exactly one price version",async()=>{
  const updates=[command("unit.price.confirm",{unitId:ids.unit,priceCents:35000001,sourceReference:"Synthetic concurrent A"},4),command("unit.price.confirm",{unitId:ids.unit,priceCents:35000002,sourceReference:"Synthetic concurrent B"},4)];
  const results=await Promise.allSettled(updates.map(input=>run(input)));
  assert.equal(results.filter(result=>result.status==="fulfilled").length,1);
  const failure=results.find(result=>result.status==="rejected");
  assert.ok(failure?.status==="rejected");assert.match(String(failure.reason),/Version changed/);
  const row=(await db.admin.query("select version,price_cents from property_units where id=$1",[ids.unit])).rows[0];
  assert.equal(Number(row.version),5);assert.ok([35000001,35000002].includes(Number(row.price_cents)));
 });

 test("explicitly delegated project salesperson can confirm prices but cannot self-assign authority",async()=>{
  await run(command("authority.assign",{userId:ids.agent,developerOrganizationId:ids.organization,contactId:ids.developerContact,canConfirmPrice:true,canConfirmReservation:false,canConfirmSale:false,sourceReference:"Synthetic delegated price mandate"}));
  await assert.rejects(run(command("authority.assign",{userId:ids.agent,developerOrganizationId:ids.organization,contactId:ids.developerContact,canConfirmPrice:true,canConfirmReservation:true,canConfirmSale:true,sourceReference:"Synthetic forbidden self-assignment"},1),agent),/capability|permission/i);
  await run(command("unit.price.confirm",{unitId:ids.unit,priceCents:35000003,sourceReference:"Synthetic delegated confirmation"},5),agent);
  assert.equal(Number((await db.admin.query("select price_cents from property_units where id=$1",[ids.unit])).rows[0].price_cents),35000003);
  assert.equal(Number((await db.admin.query("select public_price_cents from seller_listings where id=$1",[ids.listing])).rows[0].public_price_cents),35000003);

 });

 test("authority revocation serializes ahead of a concurrent confirmation",async()=>{
  await db.admin.query("create function synthetic_slow_authority_revoke() returns trigger language plpgsql as $$ begin if new.enabled=false then perform pg_sleep(0.35); end if; return new; end $$");
  await db.admin.query("create trigger synthetic_slow_authority_revoke before update on crm_project_sales_authorities for each row execute function synthetic_slow_authority_revoke()");
  try{
   const revoke=run(command("authority.assign",{userId:ids.agent,developerOrganizationId:ids.organization,contactId:ids.developerContact,canConfirmPrice:true,canConfirmReservation:false,canConfirmSale:false,enabled:false,sourceReference:"Synthetic mandate revoked"},1));
   let sleeping=false;
   for(let attempt=0;attempt<100;attempt++){
    const rows=await db.admin.query("select exists(select 1 from pg_stat_activity where wait_event='PgSleep' and query like 'insert into crm_project_sales_authorities%') as sleeping");
    if(rows.rows[0].sleeping){sleeping=true;break}
    await new Promise(resolve=>setTimeout(resolve,10));
   }
   assert.equal(sleeping,true,"Revocation reached its locked database update");
   const confirm=run(command("unit.price.confirm",{unitId:ids.unit,priceCents:1,sourceReference:"Synthetic racing confirmation"},6),agent).then(()=>({ok:true,error:""}),error=>({ok:false,error:String(error)}));
   await revoke;
   const result=await confirm;assert.equal(result.ok,false);assert.match(result.error,/Explicit project authority/);
   assert.equal(Number((await db.admin.query("select price_cents from property_units where id=$1",[ids.unit])).rows[0].price_cents),35000003);
  }finally{await db.admin.query("drop trigger synthetic_slow_authority_revoke on crm_project_sales_authorities");await db.admin.query("drop function synthetic_slow_authority_revoke()")}
 });
});
