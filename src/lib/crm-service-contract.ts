import { createHash } from "node:crypto";
import type { AppSession } from "./auth/session";
import { getRolePermissions } from "./auth/permissions";
import { getProductRoleCapabilities } from "./product-model";
import { assertCrmFields, assertProjectGrant, CrmCommandError, crmPayloadDigest, executeCrmCommand, reconcileCrmCommand, withCrmRead, type TenantTransaction, type TenantTransactionOptions } from "./crm-command";
import { queryAuthenticationRows } from "./db/tenant-client";

export const CRM_CONTRACT_VERSION = "crm-integration-v1";
export const CRM_READ_CONTRACT_VERSION = "crm-integration-v1.1";
export const CRM_CONTRACT_SCOPES = ["crm.contacts.read","crm.contacts.write","crm.companies.read","crm.developers.read","crm.projects.read","crm.projects.write","crm.units.read","crm.leads.read","crm.leads.write","crm.deals.read","crm.search.read","crm.qualifications.read","crm.offers.read","crm.offers.prepare","crm.tasks.read","crm.tasks.write","crm.appointments.read","crm.viewings.read","crm.reservations.read","crm.reservations.prepare","crm.sales.read","crm.communications.read","crm.communications.write","crm.approvals.read"] as const;
const entities = ["Contact","Company","Developer","Project","Unit","BuyerLead","Deal","Qualification","Offer","Task","Appointment","Viewing","Reservation","Sale","Communication","ApprovalReference"] as const;
type Entity = typeof entities[number];
type SearchRequest = { page:number; pageSize:number; filters:{updatedAfter?:string;status?:string;stage?:string} };
type RequestEnvelope = { contractVersion: string; environment: string; synthetic: boolean; operation: string; entity: Entity; tenantId: string; resourceId: string; actorId: string; correlationId: string; idempotencyKey: string; expectedVersion: number|null; approvalReference:string|null; auditReference:string; validation:{status:string;schemaVersion:string}; patch:{name?:string;title?:string}; search?:SearchRequest|null };
type Principal = { id:string; workspace_id:string; actor_user_id:string; tenant_alias:string; agent_id:string; scopes:string[]; data_context:string; data_classification:string; purpose:string };
type Binding = { source_id:string; project_id:string; entity:Entity; data_context:string;data_classification:string;domain:string;purpose:string };
const simId = /^sim-[a-z0-9][a-z0-9:_-]{0,100}$/;
const unsafeText = /(?:https?:\/\/|@|bearer\s|password|passwd|secret|token|api[_-]?key|credential|private.key|canary|sk-[a-z0-9]|gh[pousr]_|github_pat_|AKIA)/i;
const departments = ["executive","sales","marketing","buyer","support","finance","engineering","security","legal","qc","procurement","hr","personal"];
const reads: Record<Entity,string> = {Contact:"crm.contacts.read",Company:"crm.companies.read",Developer:"crm.developers.read",Project:"crm.projects.read",Unit:"crm.units.read",BuyerLead:"crm.leads.read",Deal:"crm.deals.read",Qualification:"crm.qualifications.read",Offer:"crm.offers.read",Task:"crm.tasks.read",Appointment:"crm.appointments.read",Viewing:"crm.viewings.read",Reservation:"crm.reservations.read",Sale:"crm.sales.read",Communication:"crm.communications.read",ApprovalReference:"crm.approvals.read"};
function fail(code="CRM_NOT_ACCESSIBLE",status=403):never { throw new CrmCommandError(code,code,status); }
function object(value:unknown):Record<string,unknown> {
 if (!value || typeof value!=="object" || Array.isArray(value)) return fail("INVALID_CRM_REQUEST",400);
 return value as Record<string,unknown>;
}
export function parseCrmContractRequest(raw:unknown):RequestEnvelope {
 const p=object(raw);
 const version=String(p.contractVersion);
 const fields=["contractVersion","environment","synthetic","operation","entity","tenantId","resourceId","actorId","correlationId","idempotencyKey","expectedVersion","approvalReference","auditReference","validation","patch",...(version===CRM_READ_CONTRACT_VERSION?["search"]:[])];
 try { assertCrmFields(p,fields); }
 catch { return fail("INVALID_CRM_REQUEST",400); }
 if(![CRM_CONTRACT_VERSION,CRM_READ_CONTRACT_VERSION].includes(version) || p.environment!=="simulation" || p.synthetic!==true || !entities.includes(p.entity as Entity) || !departments.includes(String(p.actorId))) return fail("INVALID_CRM_REQUEST",400);
 if(!["Read","Search","Update","PrepareOffer","PrepareReservation","SendOffer","ConfirmReservation","ConfirmSale"].includes(String(p.operation))) return fail("INVALID_CRM_REQUEST",400);
 if((p.entity==="Deal" || p.operation==="Search") && version!==CRM_READ_CONTRACT_VERSION)return fail("INVALID_CRM_REQUEST",400);
 if(version===CRM_READ_CONTRACT_VERSION&&!["Read","Search"].includes(String(p.operation)))return fail("INVALID_CRM_REQUEST",400);
 for(const key of ["tenantId","resourceId","correlationId","idempotencyKey","auditReference"]) if(typeof p[key]!=="string" || !simId.test(p[key] as string)) return fail("INVALID_CRM_REQUEST",400);
 if(p.approvalReference!==null && (typeof p.approvalReference!=="string" || !simId.test(p.approvalReference))) return fail("INVALID_CRM_REQUEST",400);
 if(p.expectedVersion!==null && (!Number.isSafeInteger(p.expectedVersion) || Number(p.expectedVersion)<1)) return fail("INVALID_CRM_REQUEST",400);
 if(!["Read","Search"].includes(String(p.operation)) && p.expectedVersion===null) return fail("INVALID_CRM_REQUEST",400);
 const validation=object(p.validation),patch=object(p.patch);
 if(Object.keys(validation).length!==2 || validation.status!=="VALIDATED" || validation.schemaVersion!==version) return fail("INVALID_CRM_REQUEST",400);
 for(const [key,value] of Object.entries(patch)) if(!["name","title"].includes(key) || typeof value!=="string" || (!/^SYNTHETIC: [a-zA-Z0-9 ._-]{1,100}$/.test(value) || unsafeText.test(value))) return fail("INVALID_CRM_REQUEST",400);
 if(["Read","Search"].includes(String(p.operation)) && Object.keys(patch).length) return fail("INVALID_CRM_REQUEST",400);
 if(version===CRM_READ_CONTRACT_VERSION) {
  if(p.operation==="Search") {
   if(!["Contact","BuyerLead","Deal"].includes(String(p.entity)))return fail("INVALID_CRM_REQUEST",400);
   const search=object(p.search),filters=object(search.filters);
   try {assertCrmFields(search,["page","pageSize","filters"]);assertCrmFields(filters,["updatedAfter","status","stage"]);}catch{return fail("INVALID_CRM_REQUEST",400);}
   if(!Number.isSafeInteger(search.page)||Number(search.page)<1||Number(search.page)>5||!Number.isSafeInteger(search.pageSize)||Number(search.pageSize)<1||Number(search.pageSize)>25)return fail("INVALID_CRM_REQUEST",400);
   if(p.expectedVersion!==null)return fail("INVALID_CRM_REQUEST",400);
   if(filters.updatedAfter!==undefined && (typeof filters.updatedAfter!=="string"||filters.updatedAfter.length>40||!Number.isFinite(Date.parse(filters.updatedAfter))))return fail("INVALID_CRM_REQUEST",400);
   for(const key of ["status","stage"])if(filters[key]!==undefined&&(typeof filters[key]!=="string"||!/^[\p{L}\p{N} ._-]{1,80}$/u.test(filters[key] as string)||unsafeText.test(filters[key] as string)))return fail("INVALID_CRM_REQUEST",400);
   if((p.entity==="Contact"&&(filters.status!==undefined||filters.stage!==undefined))||(p.entity==="BuyerLead"&&filters.stage!==undefined)||(p.entity==="Deal"&&filters.status!==undefined))return fail("INVALID_CRM_REQUEST",400);
  } else if(p.search!==null)return fail("INVALID_CRM_REQUEST",400);
 }
 if(["SendOffer","ConfirmReservation","ConfirmSale"].includes(String(p.operation)) && p.approvalReference===null) return fail("INVALID_CRM_REQUEST",400);
 if((["PrepareOffer","SendOffer"].includes(String(p.operation)) && p.entity!=="Offer") || (["PrepareReservation","ConfirmReservation"].includes(String(p.operation)) && p.entity!=="Reservation") || (p.operation==="ConfirmSale" && p.entity!=="Sale")) return fail("INVALID_CRM_REQUEST",400);
 return p as RequestEnvelope;
}
function nativeRequestId(principal:string,domain:string,alias:string) {
 const bytes=createHash("sha256").update(principal+":"+domain+":"+alias).digest().subarray(0,16);
 bytes[6]=(bytes[6]&15)|64; bytes[8]=(bytes[8]&63)|128;
 const h=bytes.toString("hex"); return h.slice(0,8)+"-"+h.slice(8,12)+"-"+h.slice(12,16)+"-"+h.slice(16,20)+"-"+h.slice(20);
}
const tables:Partial<Record<Entity,{table:string;columns:string;representation?:string}>> = {
 Contact:{table:"contacts",columns:"name,organization_id"},
 Company:{table:"organizations",columns:"name,type,lifecycle_stage"},Developer:{table:"organizations",columns:"name,type,lifecycle_stage",representation:"organizations[type=Bauträger]"},
 Project:{table:"projects",columns:"name,type,status"},
 Unit:{table:"property_units",columns:"unit_number,building_id,buyer_contact_id,deal_id,status,price_cents"},
 BuyerLead:{table:"leads",columns:"contact_id,type,status,score,buyer_profile",representation:"leads[type=Käufer]"},Qualification:{table:"leads",columns:"contact_id,type,status,score,buyer_profile",representation:"leads.buyer_profile"},
 Deal:{table:"deals",columns:"contact_id,owner_user_id,stage,value_cents,next_action"},
 Task:{table:"tasks",columns:"title,contact_id,lead_id,due_at,priority,status"},
 Appointment:{table:"calendar_events",columns:"title,contact_id,lead_id,starts_at,ends_at,status"},
 Viewing:{table:"property_viewing_slots",columns:"unit_id,contact_id,lead_id,starts_at,ends_at,status,note"},
 Reservation:{table:"property_reservations",columns:"unit_id,contact_id,deal_id,status,expires_at,deposit_cents,contract_milestone,next_action"},
 Communication:{table:"conversations",columns:"contact_id,lead_id,channel,direction,summary,sentiment,last_message_at"},
};
function integer(value:unknown) {const n=Number(value);if(!Number.isSafeInteger(n)||n<0)fail("INVALID_CRM_RESPONSE",502);return n;}
function timestamp(value:unknown) {const d=new Date(String(value));if(!Number.isFinite(d.valueOf()))return fail("INVALID_CRM_RESPONSE",502);return d.toISOString();}

function syntheticText(value:unknown) {
 if(typeof value!=="string" || !/^SYNTHETIC: [\p{L}\p{N} .,_-]{1,200}$/u.test(value) || unsafeText.test(value))return fail("INVALID_CRM_RESPONSE",502);
 return value;
}
function assertProfile(profile:Record<string,unknown>) {
 for(const [key,value]of Object.entries(profile)) {
  if(["budgetFrom","budgetTo"].includes(key) && (typeof value!=="number" || !Number.isFinite(value) || value<0))return fail("INVALID_CRM_RESPONSE",502);
  if(["desiredLocation","purchaseTimeline"].includes(key))syntheticText(value);
  if(["mustHaveCriteria","niceToHaveCriteria"].includes(key)) {
   if(!Array.isArray(value)||value.length>50)return fail("INVALID_CRM_RESPONSE",502);
   value.forEach(syntheticText);
  }
  if(key==="financingStatus"&&!["offen","vorqualifiziert","Eigenmittel","Finanzierungszusage"].includes(String(value)))return fail("INVALID_CRM_RESPONSE",502);
  if(key==="propertyType"&&!["Wohnung","Haus","Neubau","Zinshaus","Gewerbe","Grundstück","Portfolio"].includes(String(value)))return fail("INVALID_CRM_RESPONSE",502);
  if(key==="useCase"&&!["Eigennutzung","Anlage"].includes(String(value)))return fail("INVALID_CRM_RESPONSE",502);
 }
 if(typeof profile.budgetFrom==="number"&&typeof profile.budgetTo==="number"&&profile.budgetFrom>profile.budgetTo)return fail("INVALID_CRM_RESPONSE",502);
}
function safeProjectionValue(value:unknown):void {
 if(typeof value==="string" && unsafeText.test(value))return fail("INVALID_CRM_RESPONSE",502);
 if(Array.isArray(value))value.forEach(safeProjectionValue);
 else if(value && typeof value==="object")Object.values(value).forEach(safeProjectionValue);
}

function requireEnum(value:unknown,values:string[]) {if(!values.includes(String(value)))return fail("INVALID_CRM_RESPONSE",502);}
function validateProjection(kind:Entity,r:Record<string,unknown>) {
 if(kind==="Company"||kind==="Developer") {requireEnum(r.type,["Privat","Immobilienagentur","Bauträger","Investmentgesellschaft","Hausverwaltung","Finanzierungspartner"]);requireEnum(r.lifecycle_stage,["Lead","Opportunity","Kunde","Partner"]);}
 if(kind==="Project") {syntheticText(r.type);requireEnum(r.status,["Aktiv","Skaliert","Review","Archiviert"]);}
 if(kind==="Unit")requireEnum(r.status,["available","reserved","sold","blocked"]);
 if(kind==="BuyerLead"||kind==="Qualification") {
  requireEnum(r.status,["Neu","Qualifiziert","Qualifizieren","Termin offen","Übergabe","Archiviert"]);
  if(typeof r.score!=="number"||integer(r.score)>100)return fail("INVALID_CRM_RESPONSE",502);
  if(r.buyer_profile!==null) {
   if(!r.buyer_profile||typeof r.buyer_profile!=="object"||Array.isArray(r.buyer_profile))return fail("INVALID_CRM_RESPONSE",502);
   const profile=r.buyer_profile as Record<string,unknown>,allowed=["budgetFrom","budgetTo","financingStatus","desiredLocation","mustHaveCriteria","niceToHaveCriteria","purchaseTimeline","propertyType","useCase"];
   if(Object.keys(profile).some(key=>!allowed.includes(key)))return fail("INVALID_CRM_RESPONSE",502);assertProfile(profile);
  }
 }
 if(kind==="Deal") {
  if(typeof r.stage!=="string"||!/^[\p{L}\p{N} ._-]{1,80}$/u.test(r.stage)||unsafeText.test(r.stage))return fail("INVALID_CRM_RESPONSE",502);
  integer(r.value_cents);integer(r.version);
  if(r.next_action!=="")syntheticText(r.next_action);
 }
 if(kind==="Task") {requireEnum(r.priority,["Hoch","Mittel","Normal"]);requireEnum(r.status,["open","done"]);}
 if(kind==="Appointment")requireEnum(r.status,["geplant","vorbereiten","bestätigt","nachfassen"]);
 if(kind==="Viewing")requireEnum(r.status,["planned","confirmed","completed","cancelled","no_show"]);
 if(kind==="Appointment"||kind==="Viewing")if(Date.parse(timestamp(r.ends_at))<=Date.parse(timestamp(r.starts_at)))return fail("INVALID_CRM_RESPONSE",502);
 if(kind==="Reservation")requireEnum(r.contract_milestone,["not_started","offer_sent","financing_check","contract_draft","signed"]);
 if(kind==="Communication") {requireEnum(r.channel,["WhatsApp","Instagram","Facebook Messenger","E-Mail","Telefon","Webchat","Website Bot"]);requireEnum(r.direction,["inbound","outbound"]);requireEnum(r.sentiment,["hot","warm","neutral","risk"]);}
}
function dataProjection(kind:Entity,r:Record<string,unknown>):Record<string,unknown> {
 switch(kind) {
 case "Contact":return {displayName:r.name,companySourceId:r.organization_id};
 case "Company":case "Developer":if(r.type==="Privat"||(kind==="Developer"&&r.type!=="Bauträger"))return fail("CRM_SEMANTIC_GAP",422);return {name:r.name,organizationType:r.type,lifecycleStage:r.lifecycle_stage};
 case "Project":return {name:r.name,projectType:r.type,crmStatus:r.status,developerSourceId:null};
 case "Unit":return {unitNumber:r.unit_number,buildingSourceId:r.building_id,buyerContactSourceId:r.buyer_contact_id,dealSourceId:r.deal_id,status:({available:"AVAILABLE",reserved:"RESERVED",sold:"SOLD",blocked:"BLOCKED"} as Record<string,string>)[String(r.status)],crmStatus:r.status,price:{minorUnits:integer(r.price_cents),currency:null,taxBasis:"NOT_VERIFIED"},authorizedStatusSource:null};
 case "BuyerLead":case "Qualification":{
  if(r.type!=="Käufer")return fail("CRM_SEMANTIC_GAP",422);
  if(kind==="BuyerLead")return {contactSourceId:r.contact_id,crmStatus:r.status,score:integer(r.score)};
  if(r.buyer_profile===null)return fail("CRM_SEMANTIC_GAP",422);
  const profile=r.buyer_profile as Record<string,unknown>;const allowed=["budgetFrom","budgetTo","financingStatus","desiredLocation","mustHaveCriteria","niceToHaveCriteria","purchaseTimeline","propertyType","useCase"];
  if(!Object.keys(profile).length || Object.keys(profile).some(key=>!allowed.includes(key)))return fail("CRM_SEMANTIC_GAP",422);
  assertProfile(profile);
  return {buyerLeadSourceId:r.id,profile,completion:"NOT_VERIFIED",currency:null,budgetUnit:"NOT_VERIFIED",desiredUnitSourceId:null};
 }
 case "Deal":return {dealReference:r.id,tenantReference:r.workspace_id,pipeline:r.pipeline,stage:r.stage,value:{minorUnits:integer(r.value_cents),currency:"EUR",classification:"FINANCIAL"},ownerReference:r.owner_user_id,linkedContacts:r.contact_id?[r.contact_id]:[],nextAction:r.next_action||null,updatedAt:timestamp(r.updated_at)};
 case "Task":return {title:r.title,contactSourceId:r.contact_id,leadSourceId:r.lead_id,dueAt:r.due_at?timestamp(r.due_at):null,crmPriority:r.priority,state:r.status==="done"?"COMPLETED":"OPEN"};
 case "Appointment":return {title:r.title,contactSourceId:r.contact_id,leadSourceId:r.lead_id,startsAt:timestamp(r.starts_at),endsAt:timestamp(r.ends_at),crmStatus:r.status,timeZone:null,calendarReference:null};
 case "Viewing":return {unitSourceId:r.unit_id,contactSourceId:r.contact_id,leadSourceId:r.lead_id,startsAt:timestamp(r.starts_at),endsAt:timestamp(r.ends_at),crmStatus:r.status,note:r.note,appointmentSourceId:null};
 case "Reservation":if(!["hold","reserved","expired","converted"].includes(String(r.status)))return fail("CRM_SEMANTIC_GAP",422);return {unitSourceId:r.unit_id,contactSourceId:r.contact_id,dealSourceId:r.deal_id,crmStatus:r.status,expiresAt:timestamp(r.expires_at),deposit:{minorUnits:integer(r.deposit_cents),currency:null,taxBasis:"NOT_VERIFIED"},contractMilestone:r.contract_milestone,nextAction:r.next_action,authorizedConfirmation:null,buyerLeadSourceId:null};
 case "Communication":return {contactSourceId:r.contact_id,leadSourceId:r.lead_id,crmChannel:r.channel,direction:r.direction,summary:r.summary,sentiment:r.sentiment,lastMessageAt:timestamp(r.last_message_at),deliveryState:"NOT_VERIFIED"};
 default:return fail("CRM_SEMANTIC_GAP",422);
 }
}
async function project(tx:TenantTransaction,p:Principal,b:Binding,kind:Entity,credentialHash:string,contractVersion=CRM_CONTRACT_VERSION) {
 const config=tables[kind];if(!config)return fail("CRM_SEMANTIC_GAP",422);
 const projectColumn=kind==="Project"?"id":"project_id";
 const versionColumn=kind==="Deal"?"version,":"";
 const row=kind==="Communication" ? await tx.queryOne<Record<string,unknown>>("select * from crm_read_contract_conversation($1,$2,$3,$4)",[credentialHash,p.workspace_id,b.project_id,b.source_id]) : await tx.queryOne<Record<string,unknown>>("select id,workspace_id,"+projectColumn+" as project_id,updated_at,"+versionColumn+"data_classification,data_purpose,"+config.columns+" from "+config.table+" where id=$1::uuid and workspace_id=$2::uuid and "+projectColumn+"=$3::uuid and data_classification=$4 and data_purpose='crm_sales'",[b.source_id,p.workspace_id,b.project_id,p.data_context]);
 if(!row || row.data_classification!==p.data_context || row.data_purpose!=="crm_sales")return fail();
 if(kind==="Deal") {
  const pipeline=await tx.queryOne<{id:string;key:string}>("select id,key from crm_pipelines where workspace_id=$1::uuid and project_id=$2::uuid and data_classification=$3 and data_purpose='crm_sales' order by is_default desc,created_at,id limit 1",[p.workspace_id,b.project_id,p.data_context]);
  row.pipeline=pipeline?{sourceId:pipeline.id,key:pipeline.key}:null;
 }
 const textField=({Contact:"name",Company:"name",Developer:"name",Project:"name",Unit:"unit_number",Task:"title",Appointment:"title",Viewing:"note",Reservation:"next_action",Communication:"summary"} as Partial<Record<Entity,string>>)[kind];
 if(textField)syntheticText(row[textField]);
 validateProjection(kind,row);
 const data=dataProjection(kind,row);safeProjectionValue(data);
 const version=kind==="Deal"?integer(row.version):null;
 const projected={...data,sourceUpdatedAt:timestamp(row.updated_at),referenceScope:"NOT_VERIFIED"};
 return {contractVersion,kind,workspaceId:p.workspace_id,sourceId:b.source_id,projectId:b.project_id,representation:config.representation??config.table,compatibility:kind==="Contact"||kind==="Company"||kind==="Deal"?"DIRECT":"PARTIAL",sourceVersion:version,projectionHash:crmPayloadDigest({kind,workspaceId:p.workspace_id,sourceId:b.source_id,projectId:b.project_id,version,data:projected}),data:projected};
}

async function search(tx:TenantTransaction,p:Principal,b:Binding,r:RequestEnvelope,credentialHash:string) {
 const query=r.search!;const offset=(query.page-1)*query.pageSize;const filters=query.filters;
 const baseParams=[p.id,p.workspace_id,b.project_id,filters.updatedAfter??null,(r.entity==="BuyerLead"?filters.status:r.entity==="Deal"?filters.stage:null)??null,query.pageSize+1,offset] as const;
 const source=r.entity==="Contact"
  ?"contacts"
  :r.entity==="BuyerLead"?"leads":"deals";
 const extra=r.entity==="Contact"?"and $5::text is null":r.entity==="BuyerLead"?"and t.type='Käufer' and ($5::text is null or t.status=$5)":"and ($5::text is null or t.stage=$5)";
 const rows=await tx.query<Binding>("select b.source_id,b.project_id,b.entity,b.data_context,b.data_classification,b.domain,b.purpose from crm_service_resource_bindings b join "+source+" t on t.id=b.source_id and t.workspace_id=b.workspace_id and t.project_id=b.project_id where b.principal_id=$1::uuid and b.workspace_id=$2::uuid and b.project_id=$3::uuid and b.entity='"+r.entity+"' and b.data_context=$8 and b.data_classification=$9 and b.domain='BUSINESS' and b.purpose=$10 and t.data_classification=$8 and t.data_purpose='crm_sales' and ($4::timestamptz is null or t.updated_at>=$4) "+extra+" order by t.updated_at,t.id limit $6 offset $7",[...baseParams,p.data_context,p.data_classification,p.purpose]);
 const pageRows=rows.slice(0,query.pageSize);const items=[];
 for(const item of pageRows)items.push(await project(tx,p,item,r.entity,credentialHash,r.contractVersion));
 return {contractVersion:r.contractVersion,kind:r.entity,workspaceId:p.workspace_id,projectId:b.project_id,page:query.page,pageSize:query.pageSize,hasMore:rows.length>query.pageSize,items};
}
function errorResponse(error:unknown,correlationId?:string,contractVersion=CRM_CONTRACT_VERSION) {
 let code="CRM_RESULT_UNKNOWN",status=503;
 if(error instanceof CrmCommandError) {
  status=error.status;
  if(["INVALID_CRM_REQUEST","INVALID_CRM_RESPONSE","CRM_NOT_ACCESSIBLE","CRM_VERSION_CONFLICT","CRM_IDEMPOTENCY_CONFLICT","CRM_UNSUPPORTED_OPERATION","CRM_SEMANTIC_GAP","CRM_UNAVAILABLE","CRM_RESULT_UNKNOWN"].includes(error.code))code=error.code;
  else if(error.code==="IDEMPOTENCY_CONFLICT")code="CRM_IDEMPOTENCY_CONFLICT";
  else if(error.code.includes("VERSION"))code="CRM_VERSION_CONFLICT";
  else if(error.status===401||error.status===403)code="CRM_NOT_ACCESSIBLE";
  else code="INVALID_CRM_REQUEST";
 }
 return Response.json({contractVersion,code,retry:code==="CRM_RESULT_UNKNOWN"?"RECONCILE_ONLY":code==="CRM_UNAVAILABLE"?"AFTER_BACKOFF":"NEVER",correlationId:correlationId??null},{status,headers:{"Cache-Control":"no-store"}});
}
/** Dedicated bearer endpoint. Cookie/header identities cannot enter or acquire these grants. */
export async function handleCrmContractRequest(request:Request,options:TenantTransactionOptions={}):Promise<Response> {
 let envelope:RequestEnvelope|undefined;
 try {
  if(process.env.VERCEL_ENV==="production" || (process.env.NODE_ENV==="production" && process.env.VERCEL_ENV!=="preview"))return fail();
  if(request.method!=="POST" || request.headers.has("cookie") || request.headers.has("origin"))return fail();
  const match=/^Bearer (qa-crm-v1\.[A-Za-z0-9_-]{43,128})$/.exec(request.headers.get("authorization")??"");
  if(!match)return fail("CRM_NOT_ACCESSIBLE",401);
  const hash=createHash("sha256").update(match[1]).digest("hex");
  const principal=(await queryAuthenticationRows<Principal>("select * from crm_authenticate_service($1)",[hash],options))[0];
  if(!principal)return fail("CRM_NOT_ACCESSIBLE",401);
  const body=await request.text();if(body.length>16_384)return fail("INVALID_CRM_REQUEST",400);
  try {envelope=parseCrmContractRequest(JSON.parse(body));}catch(error){if(error instanceof CrmCommandError)throw error;return fail("INVALID_CRM_REQUEST",400);}
  const r=envelope;
  if(r.tenantId!==principal.tenant_alias || r.actorId!==principal.agent_id)return fail();
  for(const [header,value]of [["x-crm-purpose",principal.purpose],["x-crm-data-context",principal.data_context],["x-crm-classification",principal.data_classification]])if(request.headers.has(header)&&request.headers.get(header)!==value)return fail();
  const required=r.operation==="Read"?[reads[r.entity]]:r.operation==="Search"?["crm.search.read",reads[r.entity]]:r.operation==="Update"?[({Contact:"crm.contacts.write",Project:"crm.projects.write",Task:"crm.tasks.write",BuyerLead:"crm.leads.write",Communication:"crm.communications.write"} as Partial<Record<Entity,string>>)[r.entity]]:r.operation==="PrepareOffer"?["crm.offers.prepare"]:r.operation==="PrepareReservation"?["crm.reservations.prepare"]:[];
  if(!required.length || required.some(scope=>!scope||!principal.scopes.includes(scope)))return fail();
  if(!["Read","Search","Update"].includes(r.operation) || (r.operation==="Update"&&!["Contact","Project","Task"].includes(r.entity)))return fail("CRM_UNSUPPORTED_OPERATION",422);
  if(r.operation==="Update") {
   const field=r.entity==="Task"?"title":"name";
   if(Object.keys(r.patch).length!==1 || !Object.hasOwn(r.patch,field) || r.approvalReference!==null)return fail("INVALID_CRM_REQUEST",400);
  }
  const session:AppSession={authenticated:true,userId:principal.actor_user_id,workspaceId:principal.workspace_id,workspaceName:"Synthetic contract",name:"Synthetic service actor",email:"synthetic-service@example.invalid",role:"agent",productRole:"project_sales_member",permissions:getRolePermissions("agent"),productPermissions:getProductRoleCapabilities("project_sales_member"),source:"database"};
  const result=await withCrmRead(session,async(tx,fresh)=>{
   const locked=await tx.queryOne<Principal>("select * from crm_authenticate_service($1)",[hash]);
   if(!locked || crmPayloadDigest(locked)!==crmPayloadDigest(principal))return fail();
   const binding=await tx.queryOne<Binding>("select source_id,project_id,entity,data_context,data_classification,domain,purpose from crm_service_resource_bindings where principal_id=$1 and workspace_id=$2 and resource_alias=$3",[principal.id,principal.workspace_id,r.resourceId]);
    const expectedBindingEntity=r.operation==="Search"?"Project":r.entity;
    if(!binding || binding.entity!==expectedBindingEntity || binding.data_context!==principal.data_context || binding.data_classification!==principal.data_classification || binding.domain!=="BUSINESS" || binding.purpose!==principal.purpose)return fail();
    await assertProjectGrant(tx,fresh,binding.project_id,!["Read","Search"].includes(r.operation));
   const audit=await tx.queryOne("select audit_alias from crm_service_audit_bindings where principal_id=$1 and workspace_id=$2 and audit_alias=$3 and resource_alias=$4 and request_hash=$5 and expires_at>clock_timestamp()",[principal.id,principal.workspace_id,r.auditReference,r.resourceId,crmPayloadDigest(r)]);
   if(!audit)return fail();
    if(r.operation==="Read")return {projection:await project(tx,principal,binding,r.entity,hash,r.contractVersion),auditReference:r.auditReference};
    if(r.operation==="Search")return {search:await search(tx,principal,binding,r,hash),auditReference:r.auditReference};
   const input={operation:"contract.v1."+r.entity.toLowerCase()+".update",resourceId:binding.source_id,projectId:binding.project_id,expectedVersion:r.expectedVersion!,idempotencyKey:nativeRequestId(principal.id,"idempotency",r.idempotencyKey),correlationId:nativeRequestId(principal.id,"correlation",r.correlationId),payload:{principalId:principal.id,request:r},capability:"pipeline:write" as const};
   if(request.headers.get("x-crm-reconcile")==="1")return reconcileCrmCommand(fresh,input,options);
   return executeCrmCommand(fresh,input,async(commandTx)=>{
    const field=r.entity==="Task"?"title":"name",table=r.entity==="Task"?"tasks":r.entity==="Project"?"projects":"contacts",projectColumn=r.entity==="Project"?"id":"project_id";
    const changed=await commandTx.queryOne("update "+table+" set "+field+"=$4,version=version+1,updated_at=now() where id=$1 and workspace_id=$2 and "+projectColumn+"=$3 and version=$5 returning id",[binding.source_id,principal.workspace_id,binding.project_id,r.patch[field],r.expectedVersion]);
    if(!changed)return fail("CRM_VERSION_CONFLICT",409);
    return {projection:await project(commandTx,principal,binding,r.entity,hash),resourceVersion:r.expectedVersion!+1,requestAuditReference:r.auditReference};
   },options);
  },options);
  return Response.json({contractVersion:r.contractVersion,correlationId:r.correlationId,idempotencyKey:r.idempotencyKey,...result},{headers:{"Cache-Control":"no-store"}});
 } catch(error) {return errorResponse(error,envelope?.correlationId,envelope?.contractVersion);}
}
