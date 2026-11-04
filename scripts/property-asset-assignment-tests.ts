import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import type {AppSession} from '../src/lib/auth/session';
import {withCrmRead,type TenantTransactionOptions} from '../src/lib/crm-command';
import {loadPropertyUnits,loadPaginatedPropertyUnits,loadPaginatedPropertyAssets} from '../src/lib/db/crm-loaders';
import {createPropertyUnitRecord} from '../src/lib/db/property-inventory-repositories';
import {startLocalSalesDb,applySalesSchema} from './lib/local-sales-db.mjs';
import type {Project,PropertyBuilding,PropertyReservation,PropertyUnit,SellerListing} from '../src/lib/crm-types';
import {buildPropertyAssets,createPropertyUnitBoardScope,isUnitInPropertyBoardScope} from '../src/lib/property-department';
const workspaceId='workspace',projectId='project';
const project:Project={id:projectId,workspaceId,name:'Shared project',type:'Makler',leads:0,revenue:'',status:'Aktiv',defaultPipelineId:'pipeline'};
const building:PropertyBuilding={id:'building',workspaceId,projectId,name:'Existing Austrian building',address:'Vienna',completionDate:'',floors:4};
const unit:PropertyUnit={id:'unit-at',workspaceId,projectId,buildingId:building.id,unitNumber:'A-11',floor:1,rooms:3,areaSqm:92,priceCents:49500000,status:'available',updatedAt:'2026-11-04T10:00:00Z'};
const reservation:PropertyReservation={id:'reservation-at',workspaceId,projectId,unitId:unit.id,contactId:'contact',status:'hold',expiresAt:'2030-01-01T00:00:00Z',depositCents:0,contractMilestone:'not_started',nextAction:'Review'};
const listing=(values:Partial<SellerListing>={}):SellerListing=>({id:'listing-de',workspaceId,projectId,sellerLeadId:'',title:'New German apartment',address:'Berlin',countryCode:'DE',region:'Berlin',objectType:'Wohnung',areaSqm:94,rooms:3,yearBuilt:2026,marketValue:0,targetPrice:0,createdAt:'2026-11-04T10:00:00Z',...values});
const build=(sellerListings:SellerListing[],units:PropertyUnit[]=[unit],reservations:PropertyReservation[]=[reservation],buildings:PropertyBuilding[]=[building])=>buildPropertyAssets({sellerListings,units,reservations,buildings,projects:[project],brokerMandates:[]});

test('the actual browser regression: a new unlinked94sqm listing never inherits the existing92sqm495000EUR unit, building or reservation',()=>{
 const old=listing({id:'listing-at',unitId:unit.id,title:'Existing Austrian apartment',countryCode:'AT',region:'Wien',areaSqm:92}),fresh=listing();
 const assets=build([old,fresh]),created=assets.find(asset=>asset.sellerListingId===fresh.id)!,existing=assets.find(asset=>asset.sellerListingId===old.id)!;
 assert.equal(created.areaSqm,94);assert.equal(created.rooms,3);assert.equal(created.price,undefined);assert.deepEqual(created.unitIds,[]);assert.equal(created.unitCount,0);assert.equal(created.availableUnits,0);assert.equal(created.buildingCount,0);assert.equal(created.activeReservations,0);assert.equal(created.reservedUnits,0);assert.equal(created.soldUnits,0);
 assert.equal(existing.price,495000);assert.equal(existing.areaSqm,92);assert.deepEqual(existing.unitIds,[unit.id]);assert.equal(existing.buildingCount,1);assert.equal(existing.activeReservations,1);
});
test('a listing without saved unit ownership does not hide the independent project inventory card',()=>{
 const assets=build([listing()]),aggregate=assets.find(asset=>asset.id===`project:${projectId}`)!;assert.ok(aggregate);assert.deepEqual(aggregate.unitIds,[unit.id]);assert.equal(aggregate.unitCount,1);assert.equal(aggregate.activeReservations,1);assert.equal(aggregate.buildingCount,1);
});
test('saved metadata ownership supports multiple units and each unit is counted once alongside the primitive link',()=>{
 const property=listing({unitId:unit.id}),first={...unit,sellerListingId:property.id},second={...unit,id:'unit-de-2',sellerListingId:property.id,areaSqm:54,priceCents:20500000,status:'reserved' as const},other={...unit,id:'unit-other',sellerListingId:'other-property',areaSqm:200,priceCents:99900000};
 const assets=build([property],[first,second,other],[reservation,{...reservation,id:'reservation-other',unitId:other.id}]),asset=assets.find(item=>item.sellerListingId===property.id)!;
 assert.deepEqual(asset.unitIds,[first.id,second.id]);assert.equal(asset.unitCount,2);assert.equal(asset.areaSqm,146);assert.equal(asset.price,700000);assert.equal(asset.availableUnits,1);assert.equal(asset.reservedUnits,1);assert.equal(asset.activeReservations,1);assert.equal(asset.buildingCount,1);assert.ok(assets.some(item=>item.kind==='project'));
 const fullyCovered=build([property],[first,second]).filter(item=>item.kind==='project');assert.equal(fullyCovered.length,0);
});
test('metadata-owned units work with a null primitive link and foreign workspace or project relations remain excluded',()=>{
 const property=listing(),valid={...unit,sellerListingId:property.id},foreign={...valid,id:'unit-foreign',workspaceId:'other-workspace'},otherProject={...valid,id:'unit-other-project',projectId:'other-project'};
 const asset=build([property],[valid,foreign,otherProject]).find(item=>item.sellerListingId===property.id)!;assert.deepEqual(asset.unitIds,[valid.id]);assert.equal(asset.price,495000);
 const broken=build([listing({unitId:foreign.id})],[foreign,otherProject]).find(item=>item.kind==='property')!;assert.equal(broken.unitCount,0);assert.equal(broken.buildingCount,0);assert.equal(broken.activeReservations,0);assert.equal(broken.areaSqm,94);assert.equal(broken.price,undefined);
});
test('no stored unit price means no inferred release price from internal target or market valuation',()=>{
 const asset=build([listing({targetPrice:900000,marketValue:950000,publicPrice:0})],[],[],[]).find(item=>item.kind==='property')!;assert.equal(asset.price,undefined);assert.equal(asset.areaSqm,94);assert.equal(asset.unitCount,0);
});

test('opening the inventory for an empty property never widens to its project, while explicit project and global views still work',()=>{
 const assets=build([listing()]),property=assets.find(item=>item.kind==='property')!,aggregate=assets.find(item=>item.kind==='project')!,emptyScope=createPropertyUnitBoardScope(property)!;
 assert.deepEqual(emptyScope.unitIds,[]);assert.equal(emptyScope.originAssetId,property.id);assert.equal(isUnitInPropertyBoardScope(unit,emptyScope),false);
 const projectScope=createPropertyUnitBoardScope(aggregate)!;assert.equal(projectScope.unitIds,undefined);assert.equal(isUnitInPropertyBoardScope(unit,projectScope),true);assert.equal(isUnitInPropertyBoardScope({...unit,projectId:'different-project'},projectScope),false);assert.equal(isUnitInPropertyBoardScope(unit,undefined),true);
 const linked=build([listing({unitId:unit.id})]).find(item=>item.kind==='property')!,linkedScope=createPropertyUnitBoardScope(linked)!;assert.equal(isUnitInPropertyBoardScope(unit,linkedScope),true);assert.equal(isUnitInPropertyBoardScope({...unit,id:'different-unit'},linkedScope),false);
});

test('real persisted metadata survives full and paginated unit loaders, asset-summary mapping and a versioned inventory edit',async()=>{
 const db=await startLocalSalesDb();try{
  await applySalesSchema(db,{maxMigrationNumber:106});const workspaceId=randomUUID(),projectId=randomUUID(),actorId=randomUUID(),ownedId=randomUUID(),unlinkedId=randomUUID(),unitId=randomUUID();
  const session:AppSession={authenticated:true,source:'headers',workspaceId,userId:actorId,workspaceName:'Synthetic mapping',name:'Owner',email:'mapping@qa.invalid',role:'owner',productRole:'customer_owner',permissions:['crm:read','crm:write'],productPermissions:['pipeline:write','reservations:write']},options:TenantTransactionOptions={pool:db.pool as unknown as NonNullable<TenantTransactionOptions['pool']>};
  await db.admin.query("insert into workspaces(id,name,operating_model) values($1,'Synthetic unit mapping','managed_by_novalure')",[workspaceId]);await db.admin.query("insert into workspace_users(id,workspace_id,name,email,role,product_role,status) values($1,$2,'Owner','mapping@qa.invalid','owner','customer_owner','active')",[actorId,workspaceId]);await db.admin.query("insert into projects(id,workspace_id,name,type) values($1,$2,'Synthetic shared project','Makler')",[projectId,workspaceId]);
  await db.admin.query("insert into seller_listings(id,workspace_id,project_id,title,address,region,object_type,area_sqm,rooms,year_built) values($1,$3,$4,'Existing Austrian property','Vienna','Wien','Wohnung',92,3,2026),($2,$3,$4,'New German property','Berlin','Berlin','Wohnung',94,3,2026)",[ownedId,unlinkedId,workspaceId,projectId]);
  await db.admin.query("insert into property_units(id,workspace_id,project_id,unit_number,area_sqm,rooms,price_cents,status,metadata) values($1,$2,$3,'A-11',92,3,49500000,'available',jsonb_build_object('sellerListingId',$4::text))",[unitId,workspaceId,projectId,ownedId]);
  const full=await withCrmRead(session,()=>loadPropertyUnits(workspaceId),options),page=await withCrmRead(session,()=>loadPaginatedPropertyUnits(workspaceId,{projectId}),options);assert.equal(full.find(row=>row.id===unitId)?.sellerListingId,ownedId);assert.equal(page.units.find(row=>row.id===unitId)?.sellerListingId,ownedId);
  const assets=await withCrmRead(session,()=>loadPaginatedPropertyAssets(workspaceId,{projectId}),options),owned=assets.assets.find(row=>row.sellerListingId===ownedId)!,unlinked=assets.assets.find(row=>row.sellerListingId===unlinkedId)!;assert.deepEqual(owned.unitIds,[unitId]);assert.equal(owned.price,495000);assert.equal(unlinked.areaSqm,94);assert.equal(unlinked.price,undefined);assert.deepEqual(unlinked.unitIds,[]);
  const updated=await createPropertyUnitRecord({session,projectId,unitId,unitNumber:'A-11',rooms:4,areaSqm:92,expectedVersion:1,idempotencyKey:randomUUID(),correlationId:randomUUID(),options});assert.equal(updated.data.sellerListingId,ownedId);assert.equal((await withCrmRead(session,()=>loadPropertyUnits(workspaceId),options)).find(row=>row.id===unitId)?.sellerListingId,ownedId);
 }finally{await db.stop();}
});
