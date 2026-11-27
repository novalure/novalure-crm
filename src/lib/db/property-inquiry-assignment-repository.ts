import 'server-only';
import type {AppSession} from '@/lib/auth/session';
import {canViewAllWorkspaceContacts} from '@/lib/contact-access';
import {hasProductCapability} from '@/lib/product-model';
import {assertCrmUuid,assertProjectGrant,CrmCommandError,executeCrmCommand,withCrmRead,type TenantTransaction,type TenantTransactionOptions} from '@/lib/crm-command';
import type {PropertyInquiryCandidate} from '@/lib/property-inquiry-assignment';

export function canAssignPropertyInquiry(session:AppSession){return !session.serviceIdentity&&session.permissions.includes('crm:write')&&(session.role==='owner'||session.role==='admin'||hasProductCapability(session.productRole,'workspace:operate')||hasProductCapability(session.productRole,'pipeline:write')||hasProductCapability(session.productRole,'settings:manage')||hasProductCapability(session.productRole,'workspace:admin'));}
type AssignmentInput={leadId:string;propertyId:string;unitId:string|null;expectedVersion:string|null;confirmed:true};
export function parsePropertyInquiryAssignment(value:unknown):AssignmentInput{
 if(!value||typeof value!=='object'||Array.isArray(value))throw new CrmCommandError('INVALID_ASSIGNMENT','Ungültige Zuordnung.');
 const input=value as Record<string,unknown>;
 if(Object.keys(input).some(key=>!['operation','leadId','propertyId','unitId','expectedVersion','confirmed'].includes(key))||input.confirmed!==true||!Object.hasOwn(input,'expectedVersion')||!Object.hasOwn(input,'unitId')||(input.expectedVersion!==null&&(typeof input.expectedVersion!=='string'||!/^\d{1,10}$/.test(input.expectedVersion)||Number(input.expectedVersion)<1||Number(input.expectedVersion)>=2147483647)))throw new CrmCommandError('INVALID_ASSIGNMENT','Bestätigte Zuordnung und Vergleichsrevision sind erforderlich.');
 return {leadId:assertCrmUuid(input.leadId),propertyId:assertCrmUuid(input.propertyId),unitId:input.unitId===null?null:assertCrmUuid(input.unitId),expectedVersion:input.expectedVersion as string|null,confirmed:true};
}
async function ready(tx:TenantTransaction){if(!(await tx.queryOne<{ready:boolean}>("select to_regclass('public.property_inquiry_assignments') is not null as ready"))?.ready)throw new CrmCommandError('ASSIGNMENT_UNAVAILABLE','Die gespeicherte Anfragezuordnung ist noch nicht eingerichtet.',503);}
async function leadScope(tx:TenantTransaction,session:AppSession,leadId:string,write:boolean){
 if(session.serviceIdentity||(write&&!canAssignPropertyInquiry(session)))throw new CrmCommandError('FORBIDDEN','Persönliche Berechtigung zur Anfragezuordnung erforderlich.',403);
 const lead=await tx.queryOne<{projectId:string|null;contactId:string}>(`select l.project_id as "projectId",c.id as "contactId" from leads l join contacts c on c.id=l.contact_id and c.workspace_id=l.workspace_id where l.workspace_id=$1::uuid and l.id=$2::uuid and c.archived_at is null and crm_inquiry_assignment_access(l.workspace_id,l.id,$3::boolean) for share of l,c`,[session.workspaceId,leadId,write]);
 if(!lead)throw new CrmCommandError('ASSIGNMENT_NOT_AVAILABLE','Die Anfrage ist in diesem Bereich nicht verfügbar.',404);
 if(lead.projectId)await assertProjectGrant(tx,session,lead.projectId,write);else if(!canViewAllWorkspaceContacts(session))throw new CrmCommandError('FORBIDDEN','Projektlose Anfragen benötigen Workspace-Verwaltungsrechte.',403);
 return lead;
}
const selectCandidate=`select l.id as "leadId",c.name as "contactName",l.intent,l.project_id as "projectId",project.name as "projectName",l.source,
 case when a.id is null then null else jsonb_build_object('id',a.id,'version',a.version::text,'propertyId',p.id,'propertyTitle',p.title,'projectId',a.project_id,'unitId',u.id,'unitNumber',u.unit_number) end as assignment
 from leads l join contacts c on c.id=l.contact_id and c.workspace_id=l.workspace_id
 left join projects project on project.id=l.project_id and project.workspace_id=l.workspace_id
 left join property_inquiry_assignments a on a.workspace_id=l.workspace_id and a.lead_id=l.id
 left join seller_listings p on p.id=a.property_id and p.workspace_id=a.workspace_id and p.project_id is not distinct from a.project_id
 left join property_units u on u.id=a.unit_id and u.workspace_id=a.workspace_id and u.project_id is not distinct from a.project_id
 where l.workspace_id=$1::uuid and crm_inquiry_assignment_access(l.workspace_id,l.id,false)`;
export async function readPropertyInquiryAssignments(session:AppSession,projectId:string|null,options:TenantTransactionOptions={}){
 return withCrmRead(session,async(tx,fresh)=>{await ready(tx);if(fresh.serviceIdentity)throw new CrmCommandError('FORBIDDEN','Persönliche Anmeldung erforderlich.',403);if(projectId)await assertProjectGrant(tx,fresh,assertCrmUuid(projectId));const rows=await tx.query<PropertyInquiryCandidate>(selectCandidate+' and ($2::uuid is null or l.project_id=$2::uuid) order by l.received_at desc,l.id limit 501',[fresh.workspaceId,projectId]);if(rows.length>500)throw new CrmCommandError('ASSIGNMENT_LIMIT','Bitte den Projektfilter eingrenzen.',400);return {candidates:rows};},options);
}
export async function assignPropertyInquiry(session:AppSession,input:AssignmentInput,metadata:{idempotencyKey:string;correlationId:string},options:TenantTransactionOptions={}){
 return withCrmRead(session,async(tx,fresh)=>{
  await ready(tx);await tx.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[`inquiry-assignment:${fresh.workspaceId}:${input.leadId}`]);
  const scope=await leadScope(tx,fresh,input.leadId,true);
  const property=await tx.queryOne<{id:string;unitId:string|null}>(`select id,unit_id as "unitId" from seller_listings where workspace_id=$1::uuid and id=$2::uuid and project_id is not distinct from $3::uuid and crm_classification_allowed(workspace_id,data_classification,data_purpose) for share`,[fresh.workspaceId,input.propertyId,scope.projectId]);
  if(!property)throw new CrmCommandError('ASSIGNMENT_TARGET_DENIED','Die Immobilie gehört nicht zum berechtigten Projekt der Anfrage.',404);
  if(input.unitId&&!await tx.queryOne(`select id from property_units where workspace_id=$1::uuid and id=$2::uuid and project_id is not distinct from $3::uuid and (id=$4::uuid or metadata->>'sellerListingId'=$5::text) and coalesce(metadata->>'hidden','false')<>'true' and crm_classification_allowed(workspace_id,data_classification,data_purpose) for share`,[fresh.workspaceId,input.unitId,scope.projectId,property.unitId,input.propertyId]))throw new CrmCommandError('ASSIGNMENT_UNIT_DENIED','Die Einheit ist nicht mit dieser Immobilie verknüpft.',404);
  return executeCrmCommand(fresh,{operation:'crm.inquiry.assign',resourceId:input.leadId,projectId:scope.projectId??undefined,capability:'workspace:operate',payload:input,...metadata},async(commandTx,context)=>{
   const current=await commandTx.queryOne<{version:string;propertyId:string;unitId:string|null}>('select version::text,property_id as "propertyId",unit_id as "unitId" from property_inquiry_assignments where workspace_id=$1::uuid and lead_id=$2::uuid for update',[context.workspaceId,input.leadId]);
   if((current?.version??null)!==input.expectedVersion)throw new CrmCommandError('ASSIGNMENT_CONFLICT','Die Zuordnung wurde inzwischen geändert. Bitte neu laden.',409);
   if(current?.propertyId===input.propertyId&&current.unitId===input.unitId)throw new CrmCommandError('ASSIGNMENT_UNCHANGED','Diese Zuordnung ist bereits gespeichert.',409);
   if(current)await commandTx.execute('update property_inquiry_assignments set property_id=$3::uuid,unit_id=$4::uuid,version=version+1 where workspace_id=$1::uuid and lead_id=$2::uuid',[context.workspaceId,input.leadId,input.propertyId,input.unitId]);
   else await commandTx.execute('insert into property_inquiry_assignments(workspace_id,project_id,lead_id,property_id,unit_id,confirmed_by) values($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6::uuid)',[context.workspaceId,scope.projectId,input.leadId,input.propertyId,input.unitId,context.actorId]);
   const row=await commandTx.queryOne<PropertyInquiryCandidate>(selectCandidate+' and l.id=$2::uuid',[context.workspaceId,input.leadId]);if(!row?.assignment)throw new CrmCommandError('ASSIGNMENT_NOT_SAVED','Die gespeicherte Zuordnung konnte nicht bestätigt werden.',503);return row;
  });
 },options);
}
