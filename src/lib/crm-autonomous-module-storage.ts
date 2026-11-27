import type { AppSession } from "./auth/session";
import { CrmCommandError, assertExpectedVersion, type TenantTransaction } from "./crm-command";
import { executeOfferCommand } from "./db/offer-repositories";
import { runPropertySalesCommand } from "./db/property-sales-repositories";
import { savePropertyViewingInTransaction } from "./db/property-sales-repositories";
import { autonomousModuleLeadTypeCondition, type AutonomousModuleEntity, type AutonomousModuleRequest } from "./crm-autonomous-module-contract";
import { parseOfferContent } from "./offer-workflow";
import { createHash } from "node:crypto";

export type AutonomousModuleGrant = {
 id:string;workload_id:string;workspace_id:string;actor_user_id:string;project_id:string;source_id:string;
 entity:AutonomousModuleEntity;department_id:string;agent_id:string;task_id:string;scopes:string[];
 delegation_public_key:string;expires_at:Date|string|null;contract_version:string;read_fields:string[];write_fields:string[];
 related_resources:Record<string,string>;lifecycle_mode:"EXISTING"|"CREATE";
 parent_grant_id:string|null;delegation_kind:"DEPARTMENT"|"SUBAGENT";
};
type Definition={table:string;fields:Record<string,string>;version?:string;updatedAt?:string;condition?:string};
const definitions:Record<AutonomousModuleEntity,Definition>={
 Contact:{table:"contacts",fields:{name:"name",email:"email",phone:"phone",organizationId:"organization_id",relationshipRole:"role"},condition:"archived_at is null"},
 Company:{table:"organizations",fields:{name:"name",organizationType:"type",lifecycleStage:"lifecycle_stage",website:"domain"}},
 Developer:{table:"organizations",fields:{name:"name",organizationType:"type",lifecycleStage:"lifecycle_stage",website:"domain"},condition:"type='Bauträger'"},
 Project:{table:"projects",fields:{name:"name",projectType:"type",status:"status",description:"setup_defaults->>'description'"}},
 Unit:{table:"property_units",fields:{unitNumber:"unit_number",floor:"floor",rooms:"rooms",livingAreaSqm:"area_sqm",status:"status",priceCents:"case when price_cents>0 and metadata->'priceConfirmation'->>'sourceReference' is not null and metadata->'priceConfirmation'->>'priceCents'=price_cents::text then price_cents else null end"}},
 BuyerLead:{table:"leads",fields:{contactId:"contact_id",type:"type",status:"status",score:"score",buyerProfile:"buyer_profile",source:"source"},condition:autonomousModuleLeadTypeCondition("BuyerLead")!},
 Qualification:{table:"leads",fields:{buyerLeadId:"id",budgetFrom:"buyer_profile->'budgetFrom'",budgetTo:"buyer_profile->'budgetTo'",financingStatus:"buyer_profile->>'financingStatus'",desiredLocation:"buyer_profile->>'desiredLocation'",mustHaveCriteria:"buyer_profile->'mustHaveCriteria'",niceToHaveCriteria:"buyer_profile->'niceToHaveCriteria'",purchaseTimeline:"buyer_profile->>'purchaseTimeline'",propertyType:"buyer_profile->>'propertyType'",useCase:"buyer_profile->>'useCase'"},condition:autonomousModuleLeadTypeCondition("Qualification")!},
 Offer:{table:"crm_offers",fields:{title:"(select r.content->>'subject' from crm_offer_revisions r where r.workspace_id=t.workspace_id and r.offer_id=t.id and r.revision=t.revision)",content:"(select r.content from crm_offer_revisions r where r.workspace_id=t.workspace_id and r.offer_id=t.id and r.revision=t.revision)",status:"status",version:"version"}},
 Task:{table:"tasks",fields:{title:"title",description:"metadata->>'description'",dueAt:"due_at",priority:"priority",status:"status",contactId:"contact_id",leadId:"lead_id"}},
 Appointment:{table:"calendar_events",fields:{title:"title",startsAt:"starts_at",endsAt:"ends_at",status:"status",contactId:"contact_id",leadId:"lead_id",note:"metadata->>'notes'"}},
 Viewing:{table:"property_viewing_slots",fields:{startsAt:"starts_at",endsAt:"ends_at",status:"status",contactId:"contact_id",leadId:"lead_id",unitId:"unit_id",note:"note"}},
 Reservation:{table:"property_reservations",fields:{unitId:"unit_id",contactId:"contact_id",status:"status",expiresAt:"expires_at",nextAction:"next_action"}},
 Sale:{table:"property_sales",fields:{unitId:"unit_id",contactId:"contact_id",status:"'confirmed'::text",confirmedAt:"confirmed_at"},version:"unit_version",updatedAt:"confirmed_at"},
 Communication:{table:"conversations",fields:{contactId:"contact_id",leadId:"lead_id",channel:"channel",direction:"direction",summary:"summary",lastMessageAt:"last_message_at"}},
 ApprovalReference:{table:"crm_offer_approvals",fields:{action:"'offer.send'::text",status:"case when decision='APPROVED' and expires_at>clock_timestamp() and actor_id=crm_offer_configured_approver(workspace_id) and exists(select 1 from crm_offers o where o.workspace_id=t.workspace_id and o.id=t.offer_id and o.approval_id=t.id and o.revision=t.revision) then 'APPROVED' else 'INVALID' end",objectVersion:"revision",objectDigest:"content_digest",decidedAt:"created_at"},version:"revision",updatedAt:"created_at"},
};
function denied(code="ACCESS_DENIED",status=403):never{throw new CrmCommandError(code,"Assigned CRM resource is unavailable",status);}
function target(grant:AutonomousModuleGrant){const d=definitions[grant.entity];return {d,where:`t.id=$1::uuid and t.workspace_id=$2::uuid and ${grant.entity==="Project"?"t.id":"t.project_id"}=$3::uuid and t.data_classification='NOVALURE_INTERNAL' and t.data_purpose='crm_sales'${d.condition?` and (${d.condition})`:""}`};}
function normalize(value:unknown):unknown{
 if(value instanceof Date)return value.toISOString();
 if(typeof value==="bigint")return Number(value);
 if(Array.isArray(value))return value.map(normalize);
 if(value&&typeof value==="object")return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,normalize(v)]));return value;
}
export async function readAutonomousModule(tx:TenantTransaction,grant:AutonomousModuleGrant,fields:readonly string[],lock:"share"|"update"="share"){
 const {d,where}=target(grant);
 if(fields.some(f=>!(f in d.fields)))denied();
 const selected=[...new Set(fields)].filter(f=>f!=="version").map(f=>`${d.fields[f]} as "${f}"`);
 const from=grant.entity==="Communication"?"public.crm_read_autonomous_communication($4::uuid)":d.table;
 const row=await tx.queryOne<Record<string,unknown>>(`select ${[...selected,`${d.version??"version"} as version`,`${d.updatedAt??"updated_at"} as "updatedAt"`].join(",")} from ${from} t where ${where}${["Communication","Sale","ApprovalReference"].includes(grant.entity)?"":` for ${lock}`}`,[grant.source_id,grant.workspace_id,grant.project_id,...(grant.entity==="Communication"?[grant.id]:[])]);
 if(!row)denied();
 row.version=assertExpectedVersion(Number(row.version));
 for(const f of ["priceCents","floor","rooms","livingAreaSqm","score","objectVersion"])if(row[f]!==undefined&&row[f]!==null){const n=Number(row[f]);if(!Number.isFinite(n)||f==="priceCents"&&!Number.isSafeInteger(n))denied("INVALID_RESULT",502);row[f]=n;}
 if(row.buyerProfile&&typeof row.buyerProfile==="object"){
  const allowed=["budgetFrom","budgetTo","financingStatus","desiredLocation","mustHaveCriteria","niceToHaveCriteria","purchaseTimeline","propertyType","useCase"];
  row.buyerProfile=Object.fromEntries(Object.entries(row.buyerProfile).filter(([k])=>allowed.includes(k)));
 }
 if(row.content!==undefined)row.content=parseOfferContent(row.content);
 return normalize(row) as Record<string,unknown>;
}
export async function autonomousModuleExists(tx:TenantTransaction,grant:AutonomousModuleGrant){const {d}=target(grant);return grant.entity==="Communication"?Boolean(await tx.queryOne("select id from public.crm_read_autonomous_communication($1)",[grant.id])):Boolean(await tx.queryOne(`select id from ${d.table} where id=$1::uuid and workspace_id=$2::uuid`,[grant.source_id,grant.workspace_id]));}
export async function assertAutonomousModuleRelations(tx:TenantTransaction,grant:AutonomousModuleGrant,patch:Record<string,unknown>,lock=false){
 const tables:Record<string,string>={contactId:"contacts",leadId:"leads",organizationId:"organizations",unitId:"property_units",dealId:"deals",reservationId:"property_reservations"};
 for(const [field,id]of Object.entries(grant.related_resources).sort(([a],[b])=>a.localeCompare(b))){
  const table=tables[field];if(!table)denied();
  const row=await tx.queryOne(`select id from ${table} where id=$1::uuid and workspace_id=$2::uuid and project_id=$3::uuid and data_classification='NOVALURE_INTERNAL' and data_purpose='crm_sales'${lock?" for share":""}`,[id,grant.workspace_id,grant.project_id]);if(!row)denied();
 }
 for(const field of Object.keys(tables))if(field in patch&&patch[field]!==null&&patch[field]!==grant.related_resources[field])denied("RELATION_NOT_ASSIGNED");
}
function requireRelations(grant:AutonomousModuleGrant,required:readonly string[]){if(required.some(f=>!grant.related_resources[f]))denied("RELATION_NOT_ASSIGNED");}
function nativeKey(grant:AutonomousModuleGrant,request:AutonomousModuleRequest){const h=createHash("sha256").update(`crm-autonomous-native:${grant.id}:${request.idempotencyKey}`).digest("hex");return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-8${h.slice(17,20)}-${h.slice(20,32)}`;}
/** Exact named internal metadata commands. No price/status promotion, consent,
 * reassignment, deletion, permission edit or provider send is present. */
export async function writeAutonomousModule(tx:TenantTransaction,session:AppSession,grant:AutonomousModuleGrant,request:AutonomousModuleRequest){
 const p=request.patch,{d,where}=target(grant),creating=request.operation==="Create";
 if(["SendOffer","ConfirmReservation","ConfirmSale"].includes(request.operation)){
  const idempotencyKey=nativeKey(grant,request);
  if(request.operation==="SendOffer"){
   const result=await executeOfferCommand(session,{operation:"queue_send",offerId:grant.source_id,projectId:grant.project_id,expectedVersion:request.expectedVersion!,idempotencyKey,correlationId:request.correlationId,payload:{}});return {replayed:result.replayed};
  }
  const result=await runPropertySalesCommand(session,{action:request.operation==="ConfirmSale"?"sale.confirm":"reservation.confirm",projectId:grant.project_id,expectedVersion:request.expectedVersion!,idempotencyKey,correlationId:request.correlationId,
   payload:{reservationId:request.operation==="ConfirmSale"?grant.related_resources.reservationId:grant.source_id,unitVersion:p.unitVersion,sourceReference:p.sourceReference,...(request.operation==="ConfirmSale"?{saleId:grant.source_id}:{})}});return {replayed:result.replayed};
 }
 if(request.operation==="PrepareOffer"){
  if(grant.entity!=="Offer")denied();
  if(grant.lifecycle_mode==="CREATE"){
   requireRelations(grant,["dealId","contactId","organizationId","leadId"]);
   const deal=await tx.queryOne<{contactId:string;organizationId:string;leadId:string}>("select contact_id as \"contactId\",organization_id as \"organizationId\",lead_id as \"leadId\" from deals where id=$1 and workspace_id=$2 and project_id=$3 and data_classification='NOVALURE_INTERNAL' and data_purpose='crm_sales' for update",[grant.related_resources.dealId,grant.workspace_id,grant.project_id]);
   if(!deal||deal.contactId!==grant.related_resources.contactId||deal.organizationId!==grant.related_resources.organizationId||deal.leadId!==grant.related_resources.leadId)denied("RELATION_NOT_ASSIGNED");
   const contact=await tx.queryOne<{organizationId:string}>("select organization_id as \"organizationId\" from contacts where id=$1 and workspace_id=$2 and project_id=$3 and archived_at is null for update",[grant.related_resources.contactId,grant.workspace_id,grant.project_id]);
   const lead=await tx.queryOne<{contactId:string}>("select contact_id as \"contactId\" from leads where id=$1 and workspace_id=$2 and project_id=$3 for update",[grant.related_resources.leadId,grant.workspace_id,grant.project_id]);
   if(!contact||contact.organizationId!==grant.related_resources.organizationId||!lead||lead.contactId!==grant.related_resources.contactId)denied("RELATION_NOT_ASSIGNED");
  }
  const result=await executeOfferCommand(session,{operation:grant.lifecycle_mode==="CREATE"?"create":"revise",offerId:grant.source_id,
   dealId:grant.related_resources.dealId,projectId:grant.project_id,expectedVersion:request.expectedVersion!,idempotencyKey:nativeKey(grant,request),correlationId:request.correlationId,
   payload:{content:p.content,...(grant.lifecycle_mode==="CREATE"?{leadId:grant.related_resources.leadId}:{})}});
  return {replayed:result.replayed};
 }
 if(request.operation==="PrepareReservation"){
  if(grant.entity!=="Reservation"||grant.lifecycle_mode!=="CREATE")denied();
  requireRelations(grant,["unitId","leadId","contactId"]);
  if(p.unitVersion!==request.expectedVersion)denied("VERSION_CONFLICT",409);
  if(!await tx.queryOne("select id from property_units where id=$1 and workspace_id=$2 and project_id=$3 for update",[grant.related_resources.unitId,grant.workspace_id,grant.project_id]))denied();
  const buyer=await tx.queryOne<{contactId:string}>("select contact_id as \"contactId\" from leads where id=$1 and workspace_id=$2 and project_id=$3 for update",[grant.related_resources.leadId,grant.workspace_id,grant.project_id]);
  if(!buyer||buyer.contactId!==grant.related_resources.contactId)denied("RELATION_NOT_ASSIGNED");
  const result=await runPropertySalesCommand(session,{action:"reservation.request",projectId:grant.project_id,expectedVersion:request.expectedVersion!,idempotencyKey:nativeKey(grant,request),correlationId:request.correlationId,
   payload:{reservationId:grant.source_id,unitId:grant.related_resources.unitId,leadId:grant.related_resources.leadId,expiresAt:p.expiresAt}});
  return {replayed:result.replayed};
 }
 if(grant.entity==="Qualification"&&request.operation==="Update"){
  requireRelations(grant,["unitId","contactId"]);const idempotencyKey=nativeKey(grant,request);
  await tx.query("select pg_advisory_xact_lock(hashtextextended($1,0))",[`crm-command:${grant.workspace_id}:${idempotencyKey}`]);
  const current=await tx.queryOne<{profile:Record<string,unknown>;qualification:Record<string,unknown>;contactId:string}>(`select buyer_profile as profile,sales_qualification as qualification,contact_id as "contactId" from leads where id=$1 and workspace_id=$2 and project_id=$3 and data_classification='NOVALURE_INTERNAL' and data_purpose='crm_sales' and (${autonomousModuleLeadTypeCondition("Qualification")}) for update`,[grant.source_id,grant.workspace_id,grant.project_id]);if(!current||current.contactId!==grant.related_resources.contactId)denied("RELATION_NOT_ASSIGNED");
  const payload={...current.profile,...current.qualification,...p,leadId:grant.source_id,desiredUnitId:grant.related_resources.unitId,
   priority:current.qualification.priority??"medium",sourceReference:`Registered CRM assignment ${grant.id}`};
  const result=await runPropertySalesCommand(session,{action:"qualification.save",projectId:grant.project_id,expectedVersion:request.expectedVersion!,idempotencyKey,correlationId:request.correlationId,payload});return {replayed:result.replayed};
 }
 if(!["Create","Update"].includes(request.operation)||["Offer","Sale","ApprovalReference"].includes(grant.entity))denied("ADAPTER_UNSUPPORTED");
 if(grant.entity==="Communication"){
  const changed=await tx.queryOne<{id:string|null}>("select public.crm_write_autonomous_communication($1,$2,$3,$4) as id",[grant.id,request.expectedVersion,p.summary,creating]);if(!changed?.id)denied("VERSION_CONFLICT",409);return {replayed:false};
 }
 if(grant.entity==="Contact"&&typeof p.email==="string"){
  await tx.query("select pg_advisory_xact_lock(hashtextextended($1,0))",[`contact-email:${grant.workspace_id}:${p.email.toLowerCase()}`]);
  if(await tx.queryOne("select id from contacts where workspace_id=$1::uuid and lower(email)=lower($2) and archived_at is null and id<>$3::uuid",[grant.workspace_id,p.email,grant.source_id]))denied("CONTACT_IDENTITY_CONFLICT",409);
 }
 if(creating){
  await assertAutonomousModuleRelations(tx,grant,p,true);
  const defaults:Partial<Record<AutonomousModuleEntity,Record<string,unknown>>>={
   Contact:{name:p.name,role:p.relationshipRole,source:"Manual",consent_label:"Nur CRM",owner_user_id:session.userId},
   Company:{name:p.name,type:p.organizationType,owner_user_id:session.userId},Developer:{name:p.name,type:"Bauträger",owner_user_id:session.userId},
   Unit:{unit_number:p.unitNumber,floor:p.floor,rooms:p.rooms,area_sqm:p.livingAreaSqm,status:"blocked",price_cents:0,metadata:{source:"registered_agent_draft",priceConfirmed:false,availabilityConfirmed:false}},
   BuyerLead:{contact_id:grant.related_resources.contactId,type:"Käufer",source:p.source??"Manual",status:"Neu",assigned_to_user_id:session.userId},
   Task:{title:p.title,owner_user_id:session.userId},Appointment:{title:p.title,starts_at:p.startsAt,ends_at:p.endsAt,owner_user_id:session.userId,location:"Extern",metadata:{source:"registered_internal_calendar",externalEffect:false}},
   Communication:{summary:p.summary,channel:"Webchat",direction:"internal",metadata:{kind:"agent_timeline_note",externalEffect:false}},
  };
  const values=defaults[grant.entity];if(!values||Object.values(values).some(v=>v===undefined))denied("CREATE_FIELDS_REQUIRED",400);
  for(const [f,v]of Object.entries(p)){const column=d.fields[f];if(column&&/^[a-z_]+$/.test(column))values[column]=v;}
  for(const [f,id]of Object.entries(grant.related_resources)){const column=d.fields[f];if(column&&/^[a-z_]+$/.test(column))values[column]=id;}
  const description=p.description??p.note;if(description)values.metadata={...(values.metadata as object??{}),[grant.entity==="Appointment"?"notes":"description"]:description};
  const columns=["id","workspace_id","project_id",...Object.keys(values)];const params=[grant.source_id,grant.workspace_id,grant.project_id,...Object.values(values).map(v=>v&&typeof v==="object"?JSON.stringify(v):v)];
  const row=await tx.queryOne(`insert into ${d.table}(${columns.join(",")}) values(${params.map((_,i)=>`$${i+1}`).join(",")}) on conflict(id) do nothing returning id`,params);
  if(!row)denied("RESOURCE_ALREADY_EXISTS",409);return {replayed:false};
 }
 if(grant.entity==="Viewing"&&(p.startsAt!==undefined||p.endsAt!==undefined)){
  requireRelations(grant,["unitId","leadId","contactId"]);
  const current=await tx.queryOne<Record<string,unknown>>("select * from property_viewing_slots where id=$1 and workspace_id=$2 and project_id=$3",[grant.source_id,grant.workspace_id,grant.project_id]);if(!current||current.unit_id!==grant.related_resources.unitId||current.lead_id!==grant.related_resources.leadId||current.contact_id!==grant.related_resources.contactId)denied("RELATION_NOT_ASSIGNED");
  await savePropertyViewingInTransaction(tx,session,grant.project_id,{viewingId:grant.source_id,unitId:current.unit_id,leadId:current.lead_id,ownerUserId:current.owner_user_id,startsAt:p.startsAt??new Date(String(current.starts_at)).toISOString(),endsAt:p.endsAt??new Date(String(current.ends_at)).toISOString(),status:current.status,timeZone:current.time_zone},request.expectedVersion!);
  if(p.note!==undefined)await tx.execute("update property_viewing_slots set note=$4,updated_at=clock_timestamp() where id=$1 and workspace_id=$2 and project_id=$3",[grant.source_id,grant.workspace_id,grant.project_id,p.note]);return {replayed:false};
 }
 const before=await readAutonomousModule(tx,grant,[],"update");if(before.version!==request.expectedVersion)denied("VERSION_CONFLICT",409);
 await assertAutonomousModuleRelations(tx,grant,p,true);
 const params:unknown[]=[grant.source_id,grant.workspace_id,grant.project_id];const assignments:string[]=[];
 for(const [f,v]of Object.entries(p)){
  if(["description","note"].includes(f)&&!["Viewing"].includes(grant.entity)){params.push(JSON.stringify({[grant.entity==="Appointment"?"notes":"description"]:v}));const metadataColumn=grant.entity==="Project"?"setup_defaults":"metadata";assignments.push(`${metadataColumn}=${metadataColumn} || $${params.length}::jsonb`);continue;}
  const column=d.fields[f];if(!column||!/^[a-z_]+$/.test(column))denied("FIELD_NOT_WRITABLE");params.push(v);assignments.push(`${column}=$${params.length}`);
 }
 if(!assignments.length)denied("INVALID_REQUEST",400);
 if(grant.entity==="Appointment"||grant.entity==="Viewing"){
  const times=await tx.queryOne<{startsAt:Date;endsAt:Date}>(`select starts_at as "startsAt",ends_at as "endsAt" from ${d.table} where id=$1 and workspace_id=$2 and project_id=$3`,[grant.source_id,grant.workspace_id,grant.project_id]);
  if(!times||Date.parse(String(p.endsAt??times.endsAt))<=Date.parse(String(p.startsAt??times.startsAt)))denied("INVALID_REQUEST",400);
  if(grant.entity==="Appointment"&&(p.startsAt!==undefined||p.endsAt!==undefined)){
   const linked=await tx.queryOne<{linked:boolean}>("select metadata ? 'externalCalendarId' or metadata ? 'calendarSync' or metadata->>'calendarProvider' in ('google','microsoft') as linked from calendar_events where id=$1 and workspace_id=$2 and project_id=$3",[grant.source_id,grant.workspace_id,grant.project_id]);if(linked?.linked)denied("CALENDAR_PROVIDER_RECONCILIATION_REQUIRED",409);
  }
 }
 params.push(request.expectedVersion);const versionParam=params.length;
 const changed=await tx.queryOne(`update ${d.table} t set ${assignments.join(",")},version=version+1,updated_at=clock_timestamp() where ${where} and version=$${versionParam} returning id`,params);
 if(!changed)denied("VERSION_CONFLICT",409);return {replayed:false};
}
