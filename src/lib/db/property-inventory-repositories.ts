import type { AppSession } from "@/lib/auth/session";
import type { PropertyBuilding, PropertyUnit } from "@/lib/crm-types";
import { UNIT_DETAIL_FIELDS, UNIT_DETAIL_SELECT, mapUnitDetails, parseUnitDetailsPatch, type UnitDetailKey, type UnitDetailsPatch } from "@/lib/property-unit-details";
import {
  assertCrmFields, assertCrmUuid, assertExpectedVersion, assertMoneyCents, CrmCommandError, crmPayloadDigest, executeCrmCommand,
  type TenantTransaction, type TenantTransactionOptions,
} from "@/lib/crm-command";

type InventoryMetadata = { idempotencyKey?: string; correlationId?: string; expectedVersion?: unknown; options?: TenantTransactionOptions };
type RepositoryWriteResult<T> = { data: T; persisted: true; replayed: boolean; auditReference: string; commandId: string };
type BuildingRow = { id:string; workspaceId:string; projectId:string; name:string; address:string; completionDate:string | Date | null; floors:number | string; version:number | string };
type UnitRow = Record<string, unknown> & { id:string; workspaceId:string; projectId:string; buildingId:string | null; unitNumber:string; floor:number | string; rooms:number | string; areaSqm:number | string; priceCents:number | string; status:PropertyUnit["status"]; buyerContactId:string | null; dealId:string | null; sellerListingId:string | null; updatedAt:string | Date; version:number | string };
const unitColumns = `id,workspace_id as "workspaceId",project_id as "projectId",building_id as "buildingId",unit_number as "unitNumber",floor,rooms,area_sqm as "areaSqm",price_cents as "priceCents",status,buyer_contact_id as "buyerContactId",deal_id as "dealId",metadata->>'sellerListingId' as "sellerListingId",updated_at as "updatedAt",version,${UNIT_DETAIL_SELECT.replaceAll("pu.", "")}`;

function mapUnit(row: UnitRow): PropertyUnit & { version: number } {
  return { ...mapUnitDetails(row), areaSqm:Number(row.areaSqm),buildingId:row.buildingId??"",buyerContactId:row.buyerContactId??undefined,dealId:row.dealId??undefined,floor:Number(row.floor),id:row.id,priceCents:Number(row.priceCents),projectId:row.projectId,rooms:Number(row.rooms),sellerListingId:row.sellerListingId??undefined,status:row.status,unitNumber:row.unitNumber,updatedAt:date(row.updatedAt),workspaceId:row.workspaceId,version:Number(row.version) };
}

function details(input: Record<string, unknown>): UnitDetailsPatch {
  try { return parseUnitDetailsPatch(input); }
  catch (error) { throw new CrmCommandError("VALIDATION_ERROR", error instanceof Error ? error.message : "Invalid unit details"); }
}

function detailAssignments(values: UnitDetailsPatch, params: unknown[]) {
  return UNIT_DETAIL_FIELDS.filter(({ key }) => values[key] !== undefined).map(({ key, column }) => {
    params.push(values[key]); return `${column}=$${params.length}`;
  });
}

async function auditDetails(tx: TenantTransaction, session: AppSession, before: UnitRow | null, after: UnitRow, reason: string, eventType = "unit_details_changed") {
  await tx.execute(`insert into property_unit_audit_events(workspace_id,project_id,unit_id,actor_user_id,event_type,before,after,reason,metadata)
    values($1,$2,$3,$4,$8,$5::jsonb,$6::jsonb,$7,'{}')`,
  [session.workspaceId,after.projectId,after.id,session.userId,JSON.stringify(before ? { ...mapUnitDetails(before), version:Number(before.version) } : {}),JSON.stringify({ ...mapUnitDetails(after), version:Number(after.version) }),reason,eventType]);
}

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

export async function createPropertyUnitRecord(input: InventoryMetadata & Partial<Record<UnitDetailKey, unknown>> & {
  areaSqm?:unknown;buildingId?:unknown;floor?:unknown;price?:unknown;priceCents?:unknown;projectId?:unknown;rooms?:unknown;session:AppSession;status?:unknown;unitNumber?:unknown;unitId?:unknown;
  investorPriceCents?:unknown;
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
  if(input.investorPriceCents != null) throw new CrmCommandError("PRICE_CONFIRMATION_REQUIRED","Use the authorized investor price confirmation command",409);
  const detailValues=details(input);
  const payload={projectId,unitId,expectedVersion,unitNumber,buildingId,floor,rooms,areaSqm,status,details:detailValues};
  const meta=metadata(input);
  const result=await executeCrmCommand(input.session,{operation:unitId?"inventory.unit.update":"inventory.unit.create",resourceId:unitId,projectId,expectedVersion,...meta,payload,capability:"reservations:write"},async(tx,ctx)=>{
    const digest=crmPayloadDigest({payload,actorId:ctx.actorId});
    const replay=await ledgerReplay<PropertyUnit & {version:number}>(tx,"unit",ctx.workspaceId,meta.idempotencyKey,digest);
    if(replay) return replay;
    if(buildingId && !await tx.queryOne("select id from property_buildings where workspace_id=$1::uuid and project_id=$2::uuid and id=$3::uuid",[ctx.workspaceId,projectId,buildingId])) throw new CrmCommandError("RELATIONSHIP_INVALID","Building is not in the selected project",400);
    let before: UnitRow|null=null;
    let row:UnitRow|null;
    if(unitId){
      before=await tx.queryOne<UnitRow>(`select ${unitColumns} from property_units where workspace_id=$1 and project_id=$2 and id=$3 for update`,[ctx.workspaceId,projectId,unitId]);
      const params: unknown[]=[ctx.workspaceId,projectId,unitId,buildingId,unitNumber,floor,rooms,areaSqm,expectedVersion,status];
      const assignments=detailAssignments(detailValues,params);
      row=await tx.queryOne<UnitRow>(`update property_units set building_id=$4::uuid,unit_number=$5,floor=$6,rooms=$7,area_sqm=$8,${assignments.length?assignments.join(",")+",":""}version=version+1,updated_at=now() where workspace_id=$1::uuid and project_id=$2::uuid and id=$3::uuid and version=$9 and status=$10 returning ${unitColumns}`,params);
      if(!row) throw new CrmCommandError("VERSION_CONFLICT","Unit version or status changed",409);
    }else{
      const supplied=UNIT_DETAIL_FIELDS.filter(({key})=>detailValues[key]!==undefined);
      const params:unknown[]=[ctx.workspaceId,projectId,buildingId,unitNumber,floor,rooms,areaSqm,status,JSON.stringify({source:"unit_board",priceConfirmed:false,updatedByUserId:ctx.actorId})];
      const extraValues=supplied.map(({key})=>{params.push(detailValues[key]);return `$${params.length}`;});
      row=await tx.queryOne<UnitRow>(`insert into property_units(workspace_id,project_id,building_id,unit_number,floor,rooms,area_sqm,price_cents,status,metadata${supplied.length?","+supplied.map(({column})=>column).join(","):""}) values($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7,0,$8,$9::jsonb${extraValues.length?","+extraValues.join(","):""}) on conflict(workspace_id,project_id,unit_number) do nothing returning ${unitColumns}`,params);
      if(!row) throw new CrmCommandError("UNIT_EXISTS","Unit already exists; use a versioned update",409);
    }
    const data=mapUnit(row);
    if(Object.keys(detailValues).length) await auditDetails(tx,ctx.session,before,row,"Unit details recorded in inventory");
    await ledgerStore(tx,"unit",{workspaceId:ctx.workspaceId,projectId,key:meta.idempotencyKey,digest,id:row.id,data});
    return data;
  },input.options);
  return {...result,persisted:true};
}

/** Edit descriptive unit data in every sales status without changing status or prices. */
export async function updatePropertyUnitDetailsRecord(input: InventoryMetadata & {
  projectId:unknown;unitId:unknown;details:Record<string,unknown>;session:AppSession;
}):Promise<RepositoryWriteResult<PropertyUnit & {version:number}>> {
  const projectId=assertCrmUuid(input.projectId,"projectId"),unitId=assertCrmUuid(input.unitId,"unitId"),expectedVersion=assertExpectedVersion(input.expectedVersion);
  assertCrmFields(input.details,UNIT_DETAIL_FIELDS.map(({key})=>key));
  const values=details(input.details);
  if(!Object.keys(values).length) throw new CrmCommandError("VALIDATION_ERROR","At least one detail is required");
  const meta=metadata(input);
  const result=await executeCrmCommand(input.session,{operation:"inventory.unit.details",projectId,resourceId:unitId,expectedVersion,...meta,payload:values,capability:"reservations:write"},async(tx,ctx)=>{
    const before=await tx.queryOne<UnitRow>(`select ${unitColumns} from property_units where workspace_id=$1 and project_id=$2 and id=$3 for update`,[ctx.workspaceId,projectId,unitId]);
    if(!before || Number(before.version)!==expectedVersion) throw new CrmCommandError("VERSION_CONFLICT","Unit changed; reload before retrying",409);
    const params:unknown[]=[ctx.workspaceId,projectId,unitId,expectedVersion];
    const assignments=detailAssignments(values,params);
    const after=await tx.queryOne<UnitRow>(`update property_units set ${assignments.join(",")},version=version+1,updated_at=clock_timestamp() where workspace_id=$1 and project_id=$2 and id=$3 and version=$4 returning ${unitColumns}`,params);
    if(!after) throw new CrmCommandError("VERSION_CONFLICT","Unit changed; reload before retrying",409);
    await auditDetails(tx,ctx.session,before,after,"Unit details updated");
    return mapUnit(after);
  },input.options);
  return {...result,persisted:true};
}

/** A second price never bypasses the existing explicit project price authority. */
export async function confirmPropertyUnitInvestorPriceRecord(input: InventoryMetadata & {
  projectId:unknown;unitId:unknown;investorPriceCents:unknown;sourceReference:unknown;session:AppSession;
}):Promise<RepositoryWriteResult<PropertyUnit & {version:number}>> {
  const projectId=assertCrmUuid(input.projectId,"projectId"),unitId=assertCrmUuid(input.unitId,"unitId"),expectedVersion=assertExpectedVersion(input.expectedVersion);
  const investorPriceCents=input.investorPriceCents===null?null:assertMoneyCents(input.investorPriceCents,"investorPriceCents");
  const sourceReference=text(input.sourceReference,"documented price confirmation source",2000),meta=metadata(input);
  const result=await executeCrmCommand(input.session,{operation:"inventory.unit.investor_price.confirm",projectId,resourceId:unitId,expectedVersion,...meta,payload:{investorPriceCents,sourceReference},capability:"reservations:write"},async(tx,ctx)=>{
    const before=await tx.queryOne<UnitRow>(`select ${unitColumns} from property_units where workspace_id=$1 and project_id=$2 and id=$3 for update`,[ctx.workspaceId,projectId,unitId]);
    if(!before || Number(before.version)!==expectedVersion) throw new CrmCommandError("VERSION_CONFLICT","Unit changed; reload before retrying",409);
    await tx.query("select pg_advisory_xact_lock(hashtextextended($1,0))",["property-sales-authority:"+ctx.workspaceId+":"+projectId+":"+ctx.actorId]);
    const authority=await tx.queryOne<{id:string}>(`select a.id from crm_project_sales_authorities a
      join contacts c on c.id=a.contact_id and c.workspace_id=a.workspace_id and c.organization_id=a.developer_organization_id
      join projects p on p.id=a.project_id and p.workspace_id=a.workspace_id and p.developer_organization_id=a.developer_organization_id
      where a.workspace_id=$1 and a.project_id=$2 and a.user_id=$3 and a.enabled and a.can_confirm_price`,[ctx.workspaceId,projectId,ctx.actorId]);
    if(!authority) throw new CrmCommandError("FORBIDDEN","Explicit project price authority is required",403);
    const evidence={authorityId:authority.id,sourceReference,confirmedBy:ctx.actorId,confirmedAt:new Date().toISOString(),investorPriceCents};
    const after=await tx.queryOne<UnitRow>(`update property_units set investor_price_cents=$4,metadata=metadata || jsonb_build_object('investorPriceConfirmation',$5::jsonb),version=version+1,updated_at=clock_timestamp() where workspace_id=$1 and project_id=$2 and id=$3 returning ${unitColumns}`,[ctx.workspaceId,projectId,unitId,investorPriceCents,JSON.stringify(evidence)]);
    if(!after) throw new CrmCommandError("VERSION_CONFLICT","Unit changed",409);
    await auditDetails(tx,ctx.session,before,after,sourceReference,"unit_investor_price_confirmed");
    return mapUnit(after);
  },input.options);
  return {...result,persisted:true};
}

function date(value:string|Date|null) { return value ? (value instanceof Date?value:new Date(value)).toISOString() : ""; }
