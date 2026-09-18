import type { AppSession } from "@/lib/auth/session";
import type { PropertyBuilding, PropertyUnit } from "@/lib/crm-types";
import {
  assertCrmUuid, assertExpectedVersion, CrmCommandError, crmPayloadDigest, executeCrmCommand,
  type TenantTransaction, type TenantTransactionOptions,
} from "@/lib/crm-command";

type InventoryMetadata = { idempotencyKey?: string; correlationId?: string; expectedVersion?: unknown; options?: TenantTransactionOptions };
type RepositoryWriteResult<T> = { data: T; persisted: true; replayed: boolean; auditReference: string; commandId: string };
type BuildingRow = { id:string; workspaceId:string; projectId:string; name:string; address:string; completionDate:string | Date | null; floors:number | string; version:number | string };
type UnitRow = { id:string; workspaceId:string; projectId:string; buildingId:string | null; unitNumber:string; floor:number | string; rooms:number | string; areaSqm:number | string; priceCents:number | string; status:PropertyUnit["status"]; buyerContactId:string | null; dealId:string | null; updatedAt:string | Date; version:number | string };

function text(value: unknown, label: string, maximum = 200) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > maximum) throw new CrmCommandError("VALIDATION_ERROR", `Invalid ${label}`);
  return value.trim();
}
function number(value: unknown, label: string, min = 0, max = 1_000_000) {
  const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value.replace(",", ".")) : 0;
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) throw new CrmCommandError("VALIDATION_ERROR", `Invalid ${label}`);
  return parsed;
}
function metadata(input: InventoryMetadata) {
  if (!input.idempotencyKey || !input.correlationId) throw new CrmCommandError("IDEMPOTENCY_REQUIRED", "Idempotency key and correlation id are required");
  return { idempotencyKey: input.idempotencyKey, correlationId: input.correlationId };
}
async function ledgerReplay<T>(tx: TenantTransaction, kind: "unit" | "building", workspaceId: string, key: string, digest: string): Promise<T | null> {
  const table = kind === "unit" ? "property_unit_idempotency" : "property_building_idempotency";
  const row = await tx.queryOne<{ requestHash:string; response:T }>(`select request_hash as "requestHash",response from ${table} where workspace_id=$1::uuid and idempotency_key=$2`, [workspaceId,key]);
  if (!row) return null;
  if (row.requestHash !== digest) throw new CrmCommandError("IDEMPOTENCY_CONFLICT", "Inventory key has different content",409);
  return row.response;
}
async function ledgerStore(tx: TenantTransaction, kind:"unit"|"building", input:{workspaceId:string;projectId:string;key:string;digest:string;id:string;data:unknown}) {
  const table=kind==="unit"?"property_unit_idempotency":"property_building_idempotency";
  const column=kind==="unit"?"unit_id":"building_id";
  await tx.execute(`insert into ${table}(workspace_id,project_id,idempotency_key,request_hash,${column},response) values($1::uuid,$2::uuid,$3,$4,$5::uuid,$6::jsonb)`,[input.workspaceId,input.projectId,input.key,input.digest,input.id,JSON.stringify(input.data)]);
}

export async function createPropertyBuildingRecord(input: InventoryMetadata & {
  address?:unknown;completionDate?:unknown;floors?:unknown;name?:unknown;projectId?:unknown;session:AppSession;
}): Promise<RepositoryWriteResult<PropertyBuilding & {version:number}>> {
  const projectId=assertCrmUuid(input.projectId,"projectId");
  const name=text(input.name,"name");
  const address=input.address == null ? "" : text(input.address,"address",500);
  const floors=number(input.floors,"floors",0,200);
  if(!Number.isInteger(floors)) throw new CrmCommandError("VALIDATION_ERROR","Floors must be an integer");
  const completionDate=input.completionDate == null || input.completionDate === "" ? null : text(input.completionDate,"completionDate",10);
  if(completionDate && (!/^\d{4}-\d{2}-\d{2}$/.test(completionDate) || Number.isNaN(Date.parse(completionDate)))) throw new CrmCommandError("VALIDATION_ERROR","Invalid completion date");
  const payload={projectId,name,address,floors,completionDate};
  const meta=metadata(input);
  const result=await executeCrmCommand(input.session,{operation:"inventory.building.create",projectId,...meta,payload,capability:"reservations:write"},async(tx,ctx)=>{
    const digest=crmPayloadDigest({payload,actorId:ctx.actorId});
    const replay=await ledgerReplay<PropertyBuilding & {version:number}>(tx,"building",ctx.workspaceId,meta.idempotencyKey,digest);
    if(replay) return replay;
    const row=await tx.queryOne<BuildingRow>(`insert into property_buildings(workspace_id,project_id,name,address,completion_date,floors,metadata) values($1::uuid,$2::uuid,$3,$4,$5::date,$6,$7::jsonb) returning id,workspace_id as "workspaceId",project_id as "projectId",name,address,completion_date as "completionDate",floors,version`,[ctx.workspaceId,projectId,name,address,completionDate,floors,JSON.stringify({source:"unit_board",updatedByUserId:ctx.actorId})]);
    if(!row) throw new CrmCommandError("CREATE_FAILED","Building was not created",409);
    const data={address:row.address,completionDate:date(row.completionDate),floors:Number(row.floors),id:row.id,name:row.name,projectId:row.projectId,workspaceId:row.workspaceId,version:Number(row.version)};
    await ledgerStore(tx,"building",{workspaceId:ctx.workspaceId,projectId,key:meta.idempotencyKey,digest,id:row.id,data});
    return data;
  },input.options);
  return {...result,persisted:true};
}

export async function createPropertyUnitRecord(input: InventoryMetadata & {
  areaSqm?:unknown;buildingId?:unknown;floor?:unknown;price?:unknown;priceCents?:unknown;projectId?:unknown;rooms?:unknown;session:AppSession;status?:unknown;unitNumber?:unknown;unitId?:unknown;
}): Promise<RepositoryWriteResult<PropertyUnit & {version:number}>> {
  const projectId=assertCrmUuid(input.projectId,"projectId");
  const unitId=input.unitId == null ? undefined : assertCrmUuid(input.unitId,"unitId");
  const expectedVersion=unitId ? assertExpectedVersion(input.expectedVersion) : undefined;
  const unitNumber=text(input.unitNumber,"unitNumber",80);
  const buildingId=input.buildingId == null || input.buildingId === "" ? null : assertCrmUuid(input.buildingId,"buildingId");
  const floor=number(input.floor,"floor",-10,200);
  if(!Number.isInteger(floor)) throw new CrmCommandError("VALIDATION_ERROR","Floor must be an integer");
  const rooms=number(input.rooms,"rooms",0,100);
  const areaSqm=number(input.areaSqm,"areaSqm",0,1_000_000);
  const status=input.status ?? "available";
  if(status!=="available" && status!=="blocked") throw new CrmCommandError("STATUS_CONFIRMATION_REQUIRED","Reservation and sale require the authorized workflow",409);
  // Price confirmation is a separate authority-bound command. This path never changes prices.
  if(input.price != null && Number(input.price)!==0 || input.priceCents != null && Number(input.priceCents)!==0) throw new CrmCommandError("PRICE_CONFIRMATION_REQUIRED","Use the authorized price confirmation command",409);
  const payload={projectId,unitId,expectedVersion,unitNumber,buildingId,floor,rooms,areaSqm,status};
  const meta=metadata(input);
  const result=await executeCrmCommand(input.session,{operation:unitId?"inventory.unit.update":"inventory.unit.create",resourceId:unitId,projectId,expectedVersion,...meta,payload,capability:"reservations:write"},async(tx,ctx)=>{
    const digest=crmPayloadDigest({payload,actorId:ctx.actorId});
    const replay=await ledgerReplay<PropertyUnit & {version:number}>(tx,"unit",ctx.workspaceId,meta.idempotencyKey,digest);
    if(replay) return replay;
    if(buildingId && !await tx.queryOne("select id from property_buildings where workspace_id=$1::uuid and project_id=$2::uuid and id=$3::uuid",[ctx.workspaceId,projectId,buildingId])) throw new CrmCommandError("RELATIONSHIP_INVALID","Building is not in the selected project",400);
    const columns=`id,workspace_id as "workspaceId",project_id as "projectId",building_id as "buildingId",unit_number as "unitNumber",floor,rooms,area_sqm as "areaSqm",price_cents as "priceCents",status,buyer_contact_id as "buyerContactId",deal_id as "dealId",updated_at as "updatedAt",version`;
    let row:UnitRow|null;
    if(unitId){
      row=await tx.queryOne<UnitRow>(`update property_units set building_id=$4::uuid,unit_number=$5,floor=$6,rooms=$7,area_sqm=$8,version=version+1,updated_at=now() where workspace_id=$1::uuid and project_id=$2::uuid and id=$3::uuid and version=$9 and status=$10 returning ${columns}`,[ctx.workspaceId,projectId,unitId,buildingId,unitNumber,floor,rooms,areaSqm,expectedVersion,status]);
      if(!row) throw new CrmCommandError("VERSION_CONFLICT","Unit version or status changed",409);
    }else{
      row=await tx.queryOne<UnitRow>(`insert into property_units(workspace_id,project_id,building_id,unit_number,floor,rooms,area_sqm,price_cents,status,metadata) values($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7,0,$8,$9::jsonb) on conflict(workspace_id,project_id,unit_number) do nothing returning ${columns}`,[ctx.workspaceId,projectId,buildingId,unitNumber,floor,rooms,areaSqm,status,JSON.stringify({source:"unit_board",priceConfirmed:false,updatedByUserId:ctx.actorId})]);
      if(!row) throw new CrmCommandError("UNIT_EXISTS","Unit already exists; use a versioned update",409);
    }
    const data:PropertyUnit & {version:number}={areaSqm:Number(row.areaSqm),buildingId:row.buildingId??"",buyerContactId:row.buyerContactId??undefined,dealId:row.dealId??undefined,floor:Number(row.floor),id:row.id,priceCents:Number(row.priceCents),projectId:row.projectId,rooms:Number(row.rooms),status:row.status,unitNumber:row.unitNumber,updatedAt:date(row.updatedAt),workspaceId:row.workspaceId,version:Number(row.version)};
    await ledgerStore(tx,"unit",{workspaceId:ctx.workspaceId,projectId,key:meta.idempotencyKey,digest,id:row.id,data});
    return data;
  },input.options);
  return {...result,persisted:true};
}

function date(value:string|Date|null) { return value ? (value instanceof Date?value:new Date(value)).toISOString() : ""; }
