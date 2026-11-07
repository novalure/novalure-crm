import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {test} from "node:test";
import {startLocalSalesDb,applySalesSchema} from "./lib/local-sales-db.mjs";
import {withCrmRead} from "../src/lib/crm-command";
import type {AppSession} from "../src/lib/auth/session";
import type {TenantPool} from "../src/lib/db/tenant-client";
import {createSellerListingRecord,loadFullPropertyRecord,updateFullPropertyRecord} from "../src/lib/db/property-department-repositories";
import {createPropertyGeography} from "../src/lib/property-country";
import {createPropertyCoreDraft,propertyCoreUpdatePayload} from "../src/lib/property-core-editing";
import {propertyDetailDefinitions,propertyDetailCoreBindings,propertyDetailCostBindings,readPropertyDetails,parsePropertyDetails,getPropertyMatchingFeatures,type PropertyDetails} from "../src/lib/property-details";

test("typed property details retain unknowns, invalid historical values and explicit cleared features",()=>{
 const legacy=readPropertyDetails({fieldValues:{"rooms.balkone":"1","equipment.fahrstuhl":"nein","energy.energieausweis_g_ltig_bis":"2026-99-99","unknown.imported":"KEEP PRIVATE","areas.nutzfl_che":"legacy uncertain"}});
 assert.equal(legacy.values["rooms.balkone"],1);assert.equal(legacy.values["equipment.fahrstuhl"],false);assert.equal(legacy.values["energy.energieausweis_g_ltig_bis"],null);assert.equal(legacy.legacy["areas.nutzfl_che"],"legacy uncertain");assert.equal(legacy.legacy["unknown.imported"],"KEEP PRIVATE");
 assert.equal(readPropertyDetails({}, {energy_certificate_valid_until:new Date("2027-01-02T00:00:00Z")}).values["energy.energieausweis_g_ltig_bis"],"2027-01-02");
 legacy.values["rooms.balkone"]=null;const feature=getPropertyMatchingFeatures({propertyDetails:legacy},{balconies_count:3});assert.equal(feature.balcony,null);assert.equal(feature.touristRental,null);
 assert.throws(()=>parsePropertyDetails({...legacy,values:{...legacy.values,"rooms.schlafzimmer":"3"}}));
 assert.equal(propertyDetailDefinitions.filter(d=>["seller","cadastre","notes","costs","investment","legal"].includes(d.group)).every(d=>!d.public),true);
});

test("all125 property details roundtrip through real tenant create, full edit and optimistic conflict checks",{timeout:180000},async t=>{
 const db=await startLocalSalesDb();
 try{
  await applySalesSchema(db,{maxMigrationNumber:106});const w=randomUUID(),u=randomUUID(),p=randomUUID(),foreign=randomUUID(),fu=randomUUID();
  await db.admin.query("insert into workspaces(id,name,operating_model) values($1,'SYNTHETIC Full property','self_service_customer'),($2,'SYNTHETIC Foreign','self_service_customer')",[w,foreign]);
  for(const[id,workspace]of[[u,w],[fu,foreign]])await db.admin.query("insert into workspace_users(id,workspace_id,name,email,role,product_role,status) values($1,$2,'SYNTHETIC Owner',$3,'owner','customer_owner','active')",[id,workspace,`${id}@example.invalid`]);
  await db.admin.query("insert into projects(id,workspace_id,name,type) values($1,$2,'SYNTHETIC Full property','Service')",[p,w]);
  const session:AppSession={authenticated:true,workspaceId:w,userId:u,name:"SYNTHETIC",email:"owner@example.invalid",workspaceName:"SYNTHETIC",role:"owner",productRole:"customer_owner",permissions:[],productPermissions:[],source:"database"};
  const options={pool:db.pool as unknown as TenantPool},run=<T>(fn:()=>Promise<T>,actor=session)=>withCrmRead(actor,fn,options);
  const details:PropertyDetails={version:1,values:{},legacy:{"unknown.imported":"SYNTHETIC retained import","costs.provision_kauf":"3 % plus VAT"}};
  for(const d of propertyDetailDefinitions)details.values[d.id]=d.kind==="boolean"?true:d.kind==="integer"?2:d.kind==="number"?55.25:d.kind==="date"?"2026-01-02":d.kind==="enum"?d.options![0]:d.id==="location.ie_eircode"?"D02 X285":`SYNTHETIC ${d.id}`;
  const created=await run(()=>createSellerListingRecord({session,property:{projectId:p,title:"SYNTHETIC all fields",address:"SYNTHETIC address",geography:createPropertyGeography("DE","Bayern"),region:"Bayern",energyCertificate:{version:1,countryCode:"DE"},objectType:"Wohnung",usageType:"residential",marketingType:"sale",areaSqm:80.5,rooms:3,yearBuilt:2000,price:250000,publicPrice:250000,propertyDetails:details}}));
  assert.equal(created.persisted,true,created.persisted?undefined:created.reason);if(!created.persisted)return;const id=created.data.id;
  const load=()=>run(()=>loadFullPropertyRecord(session,id));let loaded=await load();assert.equal(Object.keys(loaded.details.values).length,propertyDetailDefinitions.length);assert.equal(loaded.details.legacy["unknown.imported"],details.legacy["unknown.imported"]);
  const energyLinked=new Set(["energy.hwb","energy.hwb_klasse","energy.fgee","energy.energieausweis_g_ltig_bis"]);
  await t.test("each original registry field has a retained or canonical bound stored value",()=>{
   for(const d of propertyDetailDefinitions){assert.ok(Object.hasOwn(loaded.details.values,d.id),d.id);if(!propertyDetailCoreBindings[d.id]&&!energyLinked.has(d.id))assert.equal(loaded.details.values[d.id],details.values[d.id],d.id);}
  });
  const edit=()=>{const draft=createPropertyCoreDraft(loaded.listing);draft.propertyDetails=structuredClone(loaded.details);draft.coreEdit!.expectedFullSnapshot=loaded.snapshot;return draft;};
  const draft=edit(),stale=edit();
  const editableDefinitions=propertyDetailDefinitions.filter(d=>!propertyDetailCoreBindings[d.id]&&!energyLinked.has(d.id)&&!Object.values(propertyDetailCostBindings).includes(d.id));
  for(const d of editableDefinitions)draft.propertyDetails!.values[d.id]=d.kind==="boolean"?false:d.kind==="integer"?3:d.kind==="number"?75.25:d.kind==="date"?"2027-02-03":d.kind==="enum"?d.options!.at(-1)!:d.id==="location.ie_eircode"?"D04 R2P1":`SYNTHETIC updated ${d.id}`;
  draft.propertyDetails!.legacy["costs.provision_kauf"]="4 % reviewed privately";
  draft.title="SYNTHETIC changed";draft.city="SYNTHETIC city";draft.street="SYNTHETIC street";draft.rentNet="900.12";draft.rentPrice="1080.14";draft.propertyDetails!.values["rooms.balkone"]=null;draft.propertyDetails!.values["equipment.fahrstuhl"]=false;draft.propertyDetails!.values["rooms.schlafzimmer"]=4;draft.propertyDetails!.values["construction.heizungsjahr"]=2025;draft.propertyDetails!.values["legal.tourist_permission"]="denied";
  const request=propertyCoreUpdatePayload(draft,w,id),saved=await run(()=>updateFullPropertyRecord({session,propertyId:id,property:request.property}));assert.equal(saved.persisted,true,saved.persisted?undefined:saved.reason);
  await t.test("reload retains canonical details and exact typed values while old imports survive",async()=>{
   loaded=await load();assert.equal(loaded.listing.rentNet,900.12);assert.equal(loaded.listing.rentPrice,1080.14);assert.equal(loaded.details.values["rooms.schlafzimmer"],4);assert.equal(loaded.details.values["construction.heizungsjahr"],2025);assert.equal(loaded.details.values["rooms.balkone"],null);assert.equal(loaded.details.values["equipment.fahrstuhl"],false);assert.equal(loaded.details.legacy["unknown.imported"],"SYNTHETIC retained import");assert.equal(getPropertyMatchingFeatures(loaded.listing.canonicalPayload).touristRental,false);
   for(const d of editableDefinitions)assert.equal(loaded.details.values[d.id],draft.propertyDetails!.values[d.id],`edited field ${d.id}`);
   assert.equal(loaded.details.legacy["costs.provision_kauf"],"4 % reviewed privately");
  });
  await t.test("stale edits cannot overwrite the saved full property",async()=>{
   stale.title="SYNTHETIC stale";const payload=propertyCoreUpdatePayload(stale,w,id);const result=await run(()=>updateFullPropertyRecord({session,propertyId:id,property:payload.property}));assert.equal(result.persisted,false);if(!result.persisted)assert.match(result.reason,/Conflict/);assert.equal((await load()).listing.title,"SYNTHETIC changed");
  });
  await t.test("intentional optional money clearing persists null and foreign scope cannot read details",async()=>{
   const clear=edit();clear.rentNet="";clear.rentPrice="";const payload=propertyCoreUpdatePayload(clear,w,id);const result=await run(()=>updateFullPropertyRecord({session,propertyId:id,property:payload.property}));assert.equal(result.persisted,true,result.persisted?undefined:result.reason);const values=(await db.admin.query("select rent_net_cents,rent_price_cents from seller_listings where id=$1",[id])).rows[0];assert.deepEqual(values,{rent_net_cents:null,rent_price_cents:null});
   await assert.rejects(run(()=>loadFullPropertyRecord({...session,userId:fu,workspaceId:foreign},id),{...session,userId:fu,workspaceId:foreign}));
  });
  await t.test("typed legacy database columns are visible before a complete canonical edit",async()=>{
   await db.admin.query("update seller_listings set canonical_payload=canonical_payload-'propertyDetails'-'fieldValues',balconies_count=3,land_register_number='SYNTHETIC land register',unit_floor=5 where id=$1",[id]);const legacy=await load();assert.equal(legacy.details.values["rooms.balkone"],3);assert.equal(legacy.details.values["construction.etage"],5);assert.equal(legacy.details.values["cadastre.einlagezahl"],"SYNTHETIC land register");
  });
  await t.test("a final audit failure rolls the full edit and its earlier audit back together",async()=>{
   loaded=await load();const changed=edit();changed.title="SYNTHETIC rollback";const payload=propertyCoreUpdatePayload(changed,w,id),before=(await db.admin.query("select title,canonical_payload from seller_listings where id=$1",[id])).rows[0];
   await db.admin.query(`create function qa_full_property_audit_failure() returns trigger language plpgsql as $$begin if new.action='property.full_updated' then raise exception 'synthetic full property audit failure'; end if; return new; end$$;create trigger qa_full_property_audit_failure before insert on audit_logs for each row execute function qa_full_property_audit_failure()`);
   try{await assert.rejects(run(()=>updateFullPropertyRecord({session,propertyId:id,property:payload.property})),/synthetic full property audit failure/);}finally{await db.admin.query("drop trigger qa_full_property_audit_failure on audit_logs;drop function qa_full_property_audit_failure()");}
   assert.deepEqual((await db.admin.query("select title,canonical_payload from seller_listings where id=$1",[id])).rows[0],before);
  });
  assert.ok(Number((await db.admin.query("select count(*) from audit_logs where workspace_id=$1 and action='property.full_updated'",[w])).rows[0].count)>=2);
 }finally{await db.stop();}
});
