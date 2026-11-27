import { CrmCommandError, assertCrmFields, assertCrmUuid, assertExpectedVersion } from "./crm-command";
import { parseOfferContent, OfferValidationError } from "./offer-workflow";

export const autonomousModuleContract = "crm-autonomous-access-v2";
export const autonomousModuleMaximumBytes = 131072;
export const autonomousModuleEntities = ["Contact","Company","Developer","Project","Unit","BuyerLead","Qualification","Offer","Task","Appointment","Viewing","Reservation","Sale","Communication","ApprovalReference"] as const;
export type AutonomousModuleEntity = typeof autonomousModuleEntities[number];
/** V2 source subtypes. Service-v1 keeps its separate, stricter projection. */
export const autonomousModuleLeadTypes = Object.freeze({
  BuyerLead: Object.freeze(["Käufer"]),
  Qualification: Object.freeze(["Käufer", "Investor"]),
});
export function autonomousModuleLeadTypeCondition(entity: AutonomousModuleEntity): string | null {
  const types = entity === "BuyerLead" || entity === "Qualification" ? autonomousModuleLeadTypes[entity] : null;
  return types ? `type in (${types.map(type => `'${type}'`).join(",")})` : null;
}
export const autonomousModuleOperations = ["DescribeAssignment","Read","Create","Update","PrepareOffer","PrepareReservation","SendOffer","ConfirmReservation","ConfirmSale"] as const;
export type AutonomousModuleOperation = typeof autonomousModuleOperations[number];
export type AutonomousModuleRequest = Readonly<{ contractVersion: typeof autonomousModuleContract; operation: AutonomousModuleOperation;
  correlationId: string; idempotencyKey: string; expectedVersion: number | null; patch: Record<string, unknown> }>;

/** Closed DTO vocabulary. The grant and department policy further narrow these fields. */
export const autonomousModuleFields: Record<AutonomousModuleEntity, readonly string[]> = {
  Contact:["name","email","phone","organizationId","relationshipRole"],
  Company:["name","organizationType","lifecycleStage","website"], Developer:["name","organizationType","lifecycleStage","website"],
  Project:["name","projectType","status","description"],
  Unit:["unitNumber","floor","rooms","livingAreaSqm","status","priceCents"],
  BuyerLead:["contactId","type","status","score","buyerProfile","source"],
  Qualification:["buyerLeadId","budgetFrom","budgetTo","financingStatus","desiredLocation","mustHaveCriteria","niceToHaveCriteria","purchaseTimeline","propertyType","useCase"],
  Offer:["title","content","status","version"], Task:["title","description","dueAt","priority","status","contactId","leadId"],
  Appointment:["title","startsAt","endsAt","status","contactId","leadId","note"],
  Viewing:["startsAt","endsAt","status","contactId","leadId","unitId","note"],
  Reservation:["unitId","contactId","status","expiresAt","nextAction"],
  Sale:["unitId","contactId","status","confirmedAt"],
  Communication:["contactId","leadId","channel","direction","summary","lastMessageAt"],
  ApprovalReference:["action","status","objectVersion","objectDigest","decidedAt"],
};
export const autonomousModuleWriteFields: Record<AutonomousModuleEntity, readonly string[]> = {
  Contact:autonomousModuleFields.Contact, Company:autonomousModuleFields.Company, Developer:["name","lifecycleStage","website"],
  Project:["name","description"], Unit:["unitNumber","floor","rooms","livingAreaSqm"],
  BuyerLead:["source"], Qualification:["budgetFrom","budgetTo","financingStatus","desiredLocation","mustHaveCriteria","niceToHaveCriteria","purchaseTimeline","propertyType","useCase"],
  Offer:["content"],Task:autonomousModuleFields.Task,Appointment:["title","startsAt","endsAt","note"],
  Viewing:["startsAt","endsAt","note"],Reservation:["unitId","contactId","leadId","expiresAt","nextAction","unitVersion","approvalReference","sourceReference"],Sale:["approvalReference","unitVersion","sourceReference"],Communication:["summary"],ApprovalReference:[],
};
const scopeNames: Record<AutonomousModuleEntity,string> = {Contact:"contacts",Company:"companies",Developer:"developers",Project:"projects",Unit:"units",BuyerLead:"leads",Qualification:"qualifications",Offer:"offers",Task:"tasks",Appointment:"appointments",Viewing:"viewings",Reservation:"reservations",Sale:"sales",Communication:"communications",ApprovalReference:"approvals"};
export function autonomousModuleScope(entity: AutonomousModuleEntity, operation: AutonomousModuleOperation): string {
  const suffix = operation === "Read" || operation === "DescribeAssignment" ? "read" : operation === "Create" ? "create"
    : operation === "PrepareOffer" || operation === "PrepareReservation" ? "prepare" : operation === "SendOffer" ? "send"
    : operation === "ConfirmReservation" || operation === "ConfirmSale" ? "confirm" : "write";
  return `crm.${scopeNames[entity]}.${suffix}`;
}
function invalid(code="INVALID_REQUEST"):never{throw new CrmCommandError(code,"CRM module request is invalid",400);}
export function parseAutonomousModuleRequest(value: unknown): AutonomousModuleRequest {
  if (!value || typeof value!=="object" || Array.isArray(value)) invalid();
  const p=value as Record<string,unknown>;
  assertCrmFields(p,["contractVersion","operation","correlationId","idempotencyKey","expectedVersion","patch"]);
  if(Object.keys(p).length!==6||p.contractVersion!==autonomousModuleContract||!autonomousModuleOperations.includes(p.operation as AutonomousModuleOperation)) invalid();
  assertCrmUuid(p.correlationId);assertCrmUuid(p.idempotencyKey);
  if(!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(String(p.idempotencyKey))) invalid();
  if(!p.patch||typeof p.patch!=="object"||Array.isArray(p.patch)) invalid();
  const reading=p.operation==="Read"||p.operation==="DescribeAssignment";
  if(reading||p.operation==="Create") {if(p.expectedVersion!==null||reading&&Object.keys(p.patch).length)invalid();}
  else assertExpectedVersion(p.expectedVersion);
  return p as unknown as AutonomousModuleRequest;
}
export function validateAutonomousModulePatch(entity: AutonomousModuleEntity, request: AutonomousModuleRequest): void {
  if(request.operation==="Read"||request.operation==="DescribeAssignment")return;
  const p=request.patch;
  const allowed = request.operation==="PrepareOffer" ? ["content"] : request.operation==="PrepareReservation" ? ["unitId","contactId","leadId","expiresAt","unitVersion"]
    : request.operation==="SendOffer" ? [] : request.operation==="ConfirmReservation"||request.operation==="ConfirmSale" ? ["approvalReference","unitVersion","sourceReference"]
    : entity==="Reservation"?["nextAction"]:autonomousModuleWriteFields[entity];
  assertCrmFields(p,allowed);
  if(request.operation!=="SendOffer"&&!Object.keys(p).length)invalid();
  if(request.operation==="PrepareOffer"){
    if(entity!=="Offer")invalid();try{parseOfferContent(p.content);}catch(e){if(e instanceof OfferValidationError)invalid(e.code);throw e;}return;
  }
  if(request.operation==="PrepareReservation"&&entity!=="Reservation"||request.operation==="SendOffer"&&entity!=="Offer"||request.operation==="ConfirmReservation"&&entity!=="Reservation"||request.operation==="ConfirmSale"&&entity!=="Sale")invalid();
  for(const [field,v] of Object.entries(p)){
    if(["contactId","leadId","organizationId","unitId","approvalReference"].includes(field)){if(v!==null)assertCrmUuid(v,field);continue;}
    if(field==="unitVersion"){assertExpectedVersion(v);continue;}
    if(["dueAt","startsAt","endsAt","lastMessageAt","expiresAt"].includes(field)){
      if(v===null&&field==="dueAt")continue;
      if(typeof v!=="string"||!/(Z|[+-]\d{2}:\d{2})$/.test(v)||!Number.isFinite(Date.parse(v)))invalid();continue;
    }
    if(["floor","rooms","livingAreaSqm","budgetFrom","budgetTo"].includes(field)){
      if(typeof v!=="number"||!Number.isFinite(v)||v<(field==="floor"?-10:0)||v>1_000_000||field==="floor"&&!Number.isInteger(v))invalid();continue;
    }
    if(["mustHaveCriteria","niceToHaveCriteria"].includes(field)){
      if(!Array.isArray(v)||v.length>50||v.some(x=>typeof x!=="string"||x.length>500||/[\p{Cc}\p{Cf}]/u.test(x)))invalid();continue;
    }
    if(typeof v!=="string"||!v.trim()||v!==v.trim()||v.length>(["summary","description","note"].includes(field)?4000:500)||/[\p{Cc}\p{Cf}]/u.test(v))invalid();
    if(field==="email"&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v))invalid();
    if(field==="website"&&!/^(?:https:\/\/)?[a-z0-9.-]+(?:\/[a-z0-9._~!$&'()*+,;=:@%/-]*)?$/i.test(v))invalid();
    if(field==="priority"&&!["Hoch","Mittel","Normal"].includes(v)||field==="status"&&entity==="Task"&&!["open","done"].includes(v))invalid();
    if(field==="financingStatus"&&!["offen","vorqualifiziert","Eigenmittel","Finanzierungszusage"].includes(v))invalid();
    if(field==="useCase"&&!["Eigennutzung","Anlage"].includes(v))invalid();
  }
  if(typeof p.budgetFrom==="number"&&typeof p.budgetTo==="number"&&p.budgetFrom>p.budgetTo)invalid();
  if(typeof p.startsAt==="string"&&typeof p.endsAt==="string"&&Date.parse(p.endsAt)<=Date.parse(p.startsAt))invalid();
}
