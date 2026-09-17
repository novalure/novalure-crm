
import type { AppSession } from "@/lib/auth/session";
import { can } from "@/lib/auth/permissions";
import { executeCrmCommand, withCrmRead, assertProjectGrant, CrmCommandError } from "@/lib/crm-command";
import type { TenantTransaction, TenantTransactionOptions } from "@/lib/db/tenant-client";
import { syncBuyerSearchProfileInTransaction } from "@/lib/db/broker-entity-repositories";
import { assertReservationTransition, salesActions, salesText, salesUuid, salesVersion, validateQualification, validateViewing, PropertySalesValidationError, type PropertySalesAction } from "@/lib/property-sales";
type Row = Record<string,unknown>;
export type PropertySalesCommand = {action:PropertySalesAction;projectId:string;expectedVersion?:number;idempotencyKey:string;correlationId:string;payload:Record<string,unknown>};
function object(value:unknown):Record<string,unknown>{return value && typeof value==='object' && !Array.isArray(value)?value as Record<string,unknown>:{}}
function conflict(message:string):never{throw new CrmCommandError('CONFLICT',message,409)}
function required(row:Row|null,label:string):Row{if(!row)throw new CrmCommandError('NOT_FOUND',label+' not found',404);return row}
function version(row:Row,expected:unknown){if(Number(row.version)!==salesVersion(expected))conflict('Version changed; reload before retrying')}
function source(value:unknown){return salesText(value,'Documented confirmation source',2000)}
async function unit(tx:TenantTransaction,workspace:string,project:string,id:unknown) {
 return required(await tx.queryOne<Row>('select * from property_units where workspace_id=$1 and project_id=$2 and id=$3 for update',[workspace,project,salesUuid(id,'unitId')]),'Unit');
}
async function lead(tx:TenantTransaction,workspace:string,project:string,id:unknown) {
 return required(await tx.queryOne<Row>('select * from leads where workspace_id=$1 and project_id=$2 and id=$3 for update',[workspace,project,salesUuid(id,'leadId')]),'Lead');
}
async function lockAuthority(tx:TenantTransaction,workspace:string,project:string,userId:string){
 await tx.query("select pg_advisory_xact_lock(hashtextextended($1,0))",["property-sales-authority:"+workspace+":"+project+":"+userId]);
}
async function authority(tx:TenantTransaction,session:AppSession,project:string,kind:'price'|'reservation'|'sale'){
 await lockAuthority(tx,session.workspaceId,project,session.userId);
 const row=await tx.queryOne<Row>(`select a.* from crm_project_sales_authorities a
  join contacts c on c.id=a.contact_id and c.workspace_id=a.workspace_id and c.organization_id=a.developer_organization_id
  join projects p on p.id=a.project_id and p.workspace_id=a.workspace_id and p.developer_organization_id=a.developer_organization_id
  where a.workspace_id=$1 and a.project_id=$2 and a.user_id=$3 and a.enabled=true`,[session.workspaceId,project,session.userId]);
 if(!row || row['can_confirm_'+kind]!==true) throw new CrmCommandError('FORBIDDEN','Explicit project authority is required',403);
 return row;
}
async function auditUnit(tx:TenantTransaction,session:AppSession,projectId:string,before:Row,status:string,reason:string,extra:Row={}){
 await tx.execute("insert into property_unit_audit_events(workspace_id,project_id,unit_id,actor_user_id,event_type,before,after,reason,metadata) values($1,$2,$3,$4,'authorized_sales_transition',$5::jsonb,$6::jsonb,$7,'{}')",[session.workspaceId,projectId,before.id,session.userId,JSON.stringify({status:before.status,priceCents:String(before.price_cents),version:Number(before.version)}),JSON.stringify({status,version:Number(before.version)+1,...extra}),reason]);
}
async function handoverExists(tx:TenantTransaction,workspace:string,project:string,leadId:string) {
 const row=await tx.queryOne<Row>('select id from lead_sales_handovers where workspace_id=$1 and project_id=$2 and lead_id=$3',[workspace,project,leadId]);
 if(!row)throw new CrmCommandError('PRECONDITION_FAILED','Complete qualification and documented handover first',409);
}
async function activeRecipient(tx:TenantTransaction,session:AppSession,project:string,id:unknown) {
 const user=required(await tx.queryOne<Row>(`select u.* from workspace_users u where u.workspace_id=$1 and u.id=$2 and u.status='active'
  and (u.product_role in ('platform_admin','novalureAdmin','workspace_admin','customer_owner')
   or exists(select 1 from project_pipeline_permissions p where p.workspace_id=u.workspace_id and p.project_id=$3 and p.user_id=u.id and p.can_read=true and p.can_edit_deals=true))`,[session.workspaceId,salesUuid(id,'recipientUserId'),project]),'Active project recipient');
 return user;
}
/** No caller-supplied tenant or actor is accepted. All side effects share one command transaction. */
export async function runPropertySalesCommand(session:AppSession,command:PropertySalesCommand,options?:TenantTransactionOptions) {
 try{
  if(!salesActions.includes(command.action))throw new PropertySalesValidationError('Unsupported action');
  const projectId=salesUuid(command.projectId,'projectId'), p=object(command.payload);
  const capability=command.action==='authority.assign'?'settings:manage':'reservations:write';
  return await executeCrmCommand(session,{operation:'property_sales.'+command.action,projectId,expectedVersion:command.expectedVersion,idempotencyKey:command.idempotencyKey,correlationId:command.correlationId,payload:p,capability},async(tx,ctx)=>{
   const session=ctx.session;
   const w=session.workspaceId;
   await assertProjectGrant(tx,session,projectId,true);
   if(command.action==='authority.assign'){
    await lockAuthority(tx,w,projectId,salesUuid(p.userId,'userId'));
    if(!can(session.role,'settings:manage'))throw new CrmCommandError('FORBIDDEN','Settings permission required',403);
    const project=required(await tx.queryOne<Row>('select * from projects where workspace_id=$1 and id=$2 for update',[w,projectId]),'Project');
    const organizationId=salesUuid(p.developerOrganizationId,'developerOrganizationId');
    required(await tx.queryOne<Row>("select id from organizations where workspace_id=$1 and id=$2 and (project_id is null or project_id=$3) and type='Bauträger'",[w,organizationId,projectId]),'Developer organization');
    const contactId=salesUuid(p.contactId,'contactId');
    required(await tx.queryOne<Row>('select id from contacts where workspace_id=$1 and id=$2 and organization_id=$3 and (project_id is null or project_id=$4)',[w,contactId,organizationId,projectId]),'Developer contact');
    const user=await activeRecipient(tx,session,projectId,p.userId);
    if(project.developer_organization_id && project.developer_organization_id!==organizationId)conflict('Project already belongs to another developer');
    await tx.execute('update projects set developer_organization_id=$3 where workspace_id=$1 and id=$2',[w,projectId,organizationId]);
    const old=await tx.queryOne<Row>('select * from crm_project_sales_authorities where workspace_id=$1 and project_id=$2 and user_id=$3 for update',[w,projectId,user.id]);
    if(old)version(old,command.expectedVersion);
    const params=[w,projectId,user.id,organizationId,contactId,p.canConfirmPrice===true,p.canConfirmReservation===true,p.canConfirmSale===true,source(p.sourceReference),session.userId,p.enabled!==false];
    const row=await tx.queryOne<Row>(`insert into crm_project_sales_authorities(workspace_id,project_id,user_id,developer_organization_id,contact_id,can_confirm_price,can_confirm_reservation,can_confirm_sale,assignment_source,assigned_by,enabled)
     values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     on conflict(workspace_id,project_id,user_id) do update set contact_id=excluded.contact_id,can_confirm_price=excluded.can_confirm_price,can_confirm_reservation=excluded.can_confirm_reservation,can_confirm_sale=excluded.can_confirm_sale,enabled=excluded.enabled,assignment_source=excluded.assignment_source,assigned_by=excluded.assigned_by,version=crm_project_sales_authorities.version+1,updated_at=now() returning *`,params);
    return {entity:'authority',record:row};
   }
   if(command.action==='qualification.save'){
    const row=await lead(tx,w,projectId,p.leadId);version(row,command.expectedVersion);
    if(!['Käufer','Investor'].includes(String(row.type)))throw new PropertySalesValidationError('Buyer inquiry required');
    if(row.status==='Übergabe'||row.status==='Archiviert')conflict('Handed-over or archived qualification cannot be overwritten');
    const q=validateQualification(p), selectedUnit=await unit(tx,w,projectId,q.desiredUnitId);
    if(selectedUnit.status==='sold'||selectedUnit.status==='blocked')conflict('Desired unit is not available for qualification');
    const contact=required(await tx.queryOne<Row>('select * from contacts where workspace_id=$1 and id=$2 and project_id=$3',[w,row.contact_id,projectId]),'Project buyer contact');
    if(!contact.email&&!contact.phone)throw new PropertySalesValidationError('A buyer contact channel is required');
    const profile={...object(row.buyer_profile),budgetFrom:q.budgetFrom,budgetTo:q.budgetTo,financingStatus:q.financingStatus,purchaseTimeline:q.purchaseTimeline,useCase:q.useCase};
    const qualification={complete:true,priority:q.priority,desiredUnitId:q.desiredUnitId,sourceReference:q.sourceReference,qualifiedBy:session.userId,qualifiedAt:new Date().toISOString(),version:Number(row.version)+1};
    const saved=await tx.queryOne<Row>("update leads set buyer_profile=$4::jsonb,sales_qualification=$5::jsonb,status='Qualifiziert',version=version+1,updated_at=now() where workspace_id=$1 and project_id=$2 and id=$3 returning *",[w,projectId,row.id,JSON.stringify(profile),JSON.stringify(qualification)]);
    await syncBuyerSearchProfileInTransaction(tx,{session,profile:{...profile,financingStatus:q.financingStatus as 'offen',projectId,buyerLeadId:String(row.id),contactId:String(row.contact_id),title:String(row.intent||'Käufer-Suchprofil'),matchingStatus:'open',metadata:{source:'sales_qualification',qualificationVersion:qualification.version}}});
    return {entity:'qualification',record:saved};
   }
   if(command.action==='handover.create'){
    const row=await lead(tx,w,projectId,p.leadId);version(row,command.expectedVersion);
    const q=object(row.sales_qualification);
    if(q.complete!==true||row.status!=='Qualifiziert'||Number(q.version)!==Number(row.version))conflict('A current complete qualification is required');
    validateQualification({...object(row.buyer_profile),...q});
    const recipient=await activeRecipient(tx,session,projectId,p.recipientUserId);
    const existing=await tx.queryOne<Row>('select id from lead_sales_handovers where workspace_id=$1 and lead_id=$2 and qualification_version=$3',[w,row.id,row.version]);
    if(existing)conflict('Handover already exists');
    const handover=await tx.queryOne<Row>('insert into lead_sales_handovers(workspace_id,project_id,lead_id,qualification_version,recipient_user_id,actor_id,source_reference) values($1,$2,$3,$4,$5,$6,$7) returning *',[w,projectId,row.id,row.version,recipient.id,session.userId,source(p.sourceReference)]);
    await tx.execute("update leads set status='Übergabe',assigned_to_user_id=$3,version=version+1,updated_at=now() where workspace_id=$1 and id=$2",[w,row.id,recipient.id]);
    return {entity:'handover',record:handover};
   }
   if(command.action==='viewing.save'){
    const selected=await unit(tx,w,projectId,p.unitId);
    const buyer=await lead(tx,w,projectId,p.leadId);
    await handoverExists(tx,w,projectId,String(buyer.id));
    if(selected.status==='sold'||selected.status==='blocked')conflict('Unit cannot be viewed');
    const old=p.viewingId?required(await tx.queryOne<Row>('select * from property_viewing_slots where workspace_id=$1 and project_id=$2 and id=$3 for update',[w,projectId,salesUuid(p.viewingId,'viewingId')]),'Viewing'):null;
    if(old){version(old,command.expectedVersion);if(old.unit_id!==selected.id||old.lead_id!==buyer.id)conflict('Viewing references are immutable')}
    const values=validateViewing(p,old?String(old.status):undefined);
    const owner=await activeRecipient(tx,session,projectId,p.ownerUserId);
    const params=[w,projectId,selected.id,buyer.contact_id,buyer.id,owner.id,values.startsAt,values.endsAt,values.status,values.timeZone];
    const row=old?await tx.queryOne<Row>('update property_viewing_slots set owner_user_id=$6,starts_at=$7,ends_at=$8,status=$9,time_zone=$10,version=version+1,updated_at=now() where workspace_id=$1 and project_id=$2 and unit_id=$3 and contact_id=$4 and lead_id=$5 and id=$11 returning *',[...params,old.id])
     :await tx.queryOne<Row>('insert into property_viewing_slots(workspace_id,project_id,unit_id,contact_id,lead_id,owner_user_id,starts_at,ends_at,status,time_zone) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning *',params);
    return {entity:'viewing',record:row};
   }
   if(command.action==='unit.price.confirm'){
    const selected=await unit(tx,w,projectId,p.unitId);version(selected,command.expectedVersion);
    const auth=await authority(tx,session,projectId,'price');
    const price=p.priceCents;
    if(typeof price!=='number'||!Number.isSafeInteger(price)||price<0)throw new PropertySalesValidationError('Explicit nonnegative integer priceCents required');
    const evidence={sourceReference:source(p.sourceReference),authorityId:auth.id,confirmedBy:session.userId,confirmedAt:new Date().toISOString(),version:Number(selected.version)+1,priceCents:price};
    const row=await tx.queryOne<Row>('update property_units set price_cents=$3,metadata=metadata || jsonb_build_object(\'priceConfirmation\',$4::jsonb),version=version+1,updated_at=now() where workspace_id=$1 and id=$2 returning *',[w,selected.id,price,JSON.stringify(evidence)]);
    await tx.execute("update seller_listings set public_price_cents=$3,target_price_cents=$3,canonical_payload=jsonb_set(jsonb_set(canonical_payload,'{base,priceCents}',to_jsonb($3::bigint),true),'{fieldValues,costs.kaufpreis}',to_jsonb($3::numeric/100),true),updated_at=now() where workspace_id=$1 and project_id=$2 and unit_id=$4",[w,projectId,price,selected.id]);
    await auditUnit(tx,session,projectId,selected,String(selected.status),evidence.sourceReference,{priceCents:price});
    return {entity:'unit',record:row};
   }
   let reservation:Row|null=null;
   if(command.action!=='reservation.request'){
    reservation=required(await tx.queryOne<Row>('select * from property_reservations where workspace_id=$1 and project_id=$2 and id=$3 for update',[w,projectId,salesUuid(p.reservationId,'reservationId')]),'Reservation');
    version(reservation,command.expectedVersion);
   }
   const selected=await unit(tx,w,projectId,reservation?.unit_id??p.unitId);
   version(selected,command.action==='reservation.request'?command.expectedVersion:p.unitVersion);
   assertReservationTransition(command.action,String(reservation?.status??'new'),String(selected.status));
   if(command.action==='reservation.request'){
    const buyer=await lead(tx,w,projectId,p.leadId);
    await handoverExists(tx,w,projectId,String(buyer.id));
    if(object(buyer.sales_qualification).desiredUnitId!==selected.id)conflict('Reservation unit must match the buyer qualification');
    const duplicates=await tx.queryOne<Row>("select id from property_reservations where workspace_id=$1 and unit_id=$2 and status in ('requested','hold','reserved')",[w,selected.id]);
    if(duplicates)conflict('Unit already has an open reservation');
    const expiresAt=salesText(p.expiresAt,'expiresAt');
    if(!Number.isFinite(Date.parse(expiresAt))||Date.parse(expiresAt)<=Date.now())throw new PropertySalesValidationError('Future expiry required');
    const row=await tx.queryOne<Row>("insert into property_reservations(workspace_id,project_id,unit_id,contact_id,buyer_lead_id,status,expires_at,metadata) values($1,$2,$3,$4,$5,'requested',$6,jsonb_build_object('requestedBy',$7::text)) returning *",[w,projectId,selected.id,buyer.contact_id,buyer.id,expiresAt,session.userId]);
    return {entity:'reservation',record:row,unitVersion:Number(selected.version)};
   }
   if(!reservation)throw new CrmCommandError('NOT_FOUND','Reservation not found',404);
   if(command.action==='reservation.extend'){
    const auth=await authority(tx,session,projectId,'reservation');
    const expiresAt=salesText(p.expiresAt,'expiresAt');
    if(!Number.isFinite(Date.parse(expiresAt))||Date.parse(expiresAt)<=Date.now()||Date.parse(expiresAt)<=Date.parse(String(reservation.expires_at)))throw new PropertySalesValidationError('Extension must move the deadline forward');
    const evidence={sourceReference:source(p.sourceReference),authorityId:auth.id,confirmedBy:session.userId,confirmedAt:new Date().toISOString()};
    const row=await tx.queryOne<Row>("update property_reservations set expires_at=$3,metadata=metadata || jsonb_build_object('lastExtension',$4::jsonb),version=version+1,updated_at=now() where workspace_id=$1 and id=$2 returning *",[w,reservation.id,expiresAt,JSON.stringify(evidence)]);
    return {entity:'reservation',record:row,unitVersion:Number(selected.version)};
   }
   if(command.action==='reservation.expire'){
    if(Date.parse(String(reservation.expires_at))>Date.now())conflict('Reservation expiry has not been reached; early cancellation is not enabled');
    const row=await tx.queryOne<Row>("update property_reservations set status='expired',version=version+1,updated_at=now() where workspace_id=$1 and id=$2 returning *",[w,reservation.id]);
    if(reservation.status==='reserved')await tx.execute("update property_units set status='available',buyer_contact_id=null,deal_id=null,version=version+1,updated_at=now() where workspace_id=$1 and id=$2",[w,selected.id]);
    if(reservation.status==='reserved')await auditUnit(tx,session,projectId,selected,'available','Reservation ended');
    return {entity:'reservation',record:row};
   }
   if(Date.parse(String(reservation.expires_at))<=Date.now())conflict('Reservation has expired');
   const auth=await authority(tx,session,projectId,command.action==='sale.confirm'?'sale':'reservation');
   const evidence={authorityId:auth.id,sourceReference:source(p.sourceReference),confirmedBy:session.userId,confirmedAt:new Date().toISOString(),reservationVersion:Number(reservation.version)+1,unitVersion:Number(selected.version)+1};
   if(command.action==='reservation.confirm'){
    const row=await tx.queryOne<Row>("update property_reservations set status='reserved',confirmation=$3::jsonb,version=version+1,updated_at=now() where workspace_id=$1 and id=$2 returning *",[w,reservation.id,JSON.stringify(evidence)]);
    await tx.execute("update property_units set status='reserved',buyer_contact_id=$3,version=version+1,updated_at=now() where workspace_id=$1 and id=$2",[w,selected.id,reservation.contact_id]);
    await auditUnit(tx,session,projectId,selected,'reserved',evidence.sourceReference);
    return {entity:'reservation',record:row,unitVersion:Number(selected.version)+1};
   }
   if(!reservation.confirmation||!reservation.buyer_lead_id)conflict('Authorized reservation confirmation is required');
   const sale=await tx.queryOne<Row>('insert into property_sales(workspace_id,project_id,unit_id,reservation_id,buyer_lead_id,contact_id,authority_id,confirmed_by,source_reference,unit_version) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning *',[w,projectId,selected.id,reservation.id,reservation.buyer_lead_id,reservation.contact_id,auth.id,session.userId,evidence.sourceReference,evidence.unitVersion]);
   await tx.execute("update property_reservations set status='converted',version=version+1,updated_at=now() where workspace_id=$1 and id=$2",[w,reservation.id]);
   await tx.execute("update property_units set status='sold',buyer_contact_id=$3,version=version+1,updated_at=now() where workspace_id=$1 and id=$2",[w,selected.id,reservation.contact_id]);
   if(reservation.deal_id)await tx.execute("update deals set stage='Gewonnen',probability=100,closed_at=now(),updated_at=now() where workspace_id=$1 and project_id=$2 and id=$3",[w,projectId,reservation.deal_id]);
   await auditUnit(tx,session,projectId,selected,'sold',evidence.sourceReference,{saleId:sale?.id});
   return {entity:'sale',record:sale,unitVersion:evidence.unitVersion};
  },options);
 }catch(error){if(error instanceof PropertySalesValidationError)throw new CrmCommandError('VALIDATION_ERROR',error.message,400);throw error}
}
export async function loadPropertySalesWorkspace(session:AppSession,projectId:string,options?:TenantTransactionOptions){
 salesUuid(projectId,'projectId');
 return withCrmRead(session,async tx=>{
  await assertProjectGrant(tx,session,projectId,false);
  const w=session.workspaceId;
  const project=required(await tx.queryOne<Row>('select id,name,developer_organization_id from projects where workspace_id=$1 and id=$2',[w,projectId]),'Project');
  const units=await tx.query<Row>('select id,unit_number,status,price_cents,version from property_units where workspace_id=$1 and project_id=$2 order by unit_number',[w,projectId]);
  const leads=await tx.query<Row>('select l.id,l.status,l.contact_id,l.buyer_profile,l.sales_qualification,l.version,c.name from leads l join contacts c on c.id=l.contact_id and c.workspace_id=l.workspace_id where l.workspace_id=$1 and l.project_id=$2 order by l.created_at desc',[w,projectId]);
  const users=await tx.query<Row>("select id,name,role,product_role from workspace_users where workspace_id=$1 and status='active' order by name",[w]);
  const organizations=await tx.query<Row>("select id,name from organizations where workspace_id=$1 and type='Bauträger' and (project_id is null or project_id=$2) order by name",[w,projectId]);
  const contacts=await tx.query<Row>('select id,name,organization_id from contacts where workspace_id=$1 and (project_id=$2 or organization_id=$3) order by name',[w,projectId,project.developer_organization_id]);
  const authorities=await tx.query<Row>('select * from crm_project_sales_authorities where workspace_id=$1 and project_id=$2',[w,projectId]);
  const handovers=await tx.query<Row>('select * from lead_sales_handovers where workspace_id=$1 and project_id=$2 order by created_at desc',[w,projectId]);
  const viewings=await tx.query<Row>('select * from property_viewing_slots where workspace_id=$1 and project_id=$2 order by starts_at desc',[w,projectId]);
  const reservations=await tx.query<Row>('select * from property_reservations where workspace_id=$1 and project_id=$2 order by created_at desc',[w,projectId]);
  const sales=await tx.query<Row>('select * from property_sales where workspace_id=$1 and project_id=$2 order by confirmed_at desc',[w,projectId]);
  return {project,units,leads,users,organizations,contacts,authorities,handovers,viewings,reservations,sales};
 },options);
}
