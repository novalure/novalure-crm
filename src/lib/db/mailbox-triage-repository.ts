import 'server-only';
import type {AppSession} from '@/lib/auth/session';
import {assertCrmUuid,assertProjectGrant,CrmCommandError,executeCrmCommand,withCrmRead,type TenantTransaction,type TenantTransactionOptions} from '@/lib/crm-command';
import {mailboxTriageStatuses,type MailboxTriageItem,type MailboxTriageState,type MailboxTriageStatus} from '@/lib/mailbox-triage';
function personal(session:AppSession){if(session.serviceIdentity||session.productRole==='external_partner')throw new CrmCommandError('FORBIDDEN','Persönliche Anmeldung für das eigene Postfach erforderlich',403);}
async function ready(tx:TenantTransaction){if(!(await tx.queryOne<{ready:boolean}>("select to_regclass('public.crm_mailbox_triage') is not null as ready"))?.ready)throw new CrmCommandError('TRIAGE_UNAVAILABLE','Die persönliche E-Mail-Arbeitsliste ist noch nicht eingerichtet.',503);}
export async function loadMailboxTriage(tx:TenantTransaction,session:AppSession,projectId:string|null,includeDone=false):Promise<MailboxTriageState>{
 personal(session);await ready(tx);const auto=(await tx.queryOne<{ready:boolean}>("select to_regclass('public.crm_mailbox_private_decisions') is not null as ready"))?.ready===true;if(projectId)await assertProjectGrant(tx,session,assertCrmUuid(projectId),false);
 const items=await tx.query<MailboxTriageItem&{total:number}>(`select m.id,m.subject,m.from_label as "fromLabel",m.received_at as "receivedAt",coalesce(t.status,'unreviewed') as status,coalesce(t.revision,0)::integer as revision,${auto?'coalesce(l.lead_id,d.lead_id)':'l.lead_id'} as "leadId",p.name as "projectName",count(*) over()::integer as total
 from crm_mailbox_messages m left join crm_mailbox_triage t on t.workspace_id=m.workspace_id and t.user_id=m.user_id and t.message_id=m.id
 left join crm_mailbox_links l on l.workspace_id=m.workspace_id and l.user_id=m.user_id and l.message_id=m.id
 ${auto?"left join crm_mailbox_private_decisions d on d.workspace_id=m.workspace_id and d.user_id=m.user_id and d.message_id=m.id and d.status='filed'":''}
 left join leads lead on lead.id=${auto?'coalesce(l.lead_id,d.lead_id)':'l.lead_id'} and lead.workspace_id=m.workspace_id and lead.project_id=${auto?'coalesce(l.project_id,d.project_id)':'l.project_id'}
 left join projects p on p.id=lead.project_id and p.workspace_id=lead.workspace_id
 where m.workspace_id=$1::uuid and m.user_id=$2::uuid and m.deleted_at is null and ($3::uuid is null or p.id=$3::uuid)
 and(${auto?'(l.id is null and d.id is null)':'l.id is null'} or lead.id is not null) and($4 or coalesce(t.status,'unreviewed')<>'done')
 order by case coalesce(t.status,'unreviewed') when 'needs_reply' then 0 when 'unreviewed' then 1 when 'waiting' then 2 else 3 end,m.received_at desc,m.id limit 50`,[session.workspaceId,session.userId,projectId,includeDone]);
 return {items:items.map(item=>({id:item.id,subject:item.subject,fromLabel:item.fromLabel,receivedAt:item.receivedAt,status:item.status,revision:item.revision,leadId:item.leadId,projectName:item.projectName})),total:items[0]?.total??0,canReview:session.permissions.includes('crm:write')};
}
export async function saveMailboxTriage(session:AppSession,input:{messageId:string;status:MailboxTriageStatus;expectedRevision:number},metadata:{idempotencyKey:string;correlationId:string},options:TenantTransactionOptions={}){
 const id=assertCrmUuid(input.messageId);if(!mailboxTriageStatuses.includes(input.status)||!Number.isSafeInteger(input.expectedRevision)||input.expectedRevision<0)throw new CrmCommandError('INVALID_INPUT','Gespeicherten Bearbeitungsstand prüfen');
 return withCrmRead(session,async(tx,fresh)=>{personal(fresh);await ready(tx);const auto=(await tx.queryOne<{ready:boolean}>("select to_regclass('public.crm_mailbox_private_decisions') is not null as ready"))?.ready===true;
  const current=await tx.queryOne<{id:string;projectId:string|null;leadId:string|null}>(`select m.id,${auto?'coalesce(l.project_id,d.project_id)':'l.project_id'} as "projectId",lead.id as "leadId" from crm_mailbox_messages m left join crm_mailbox_links l on l.workspace_id=m.workspace_id and l.user_id=m.user_id and l.message_id=m.id ${auto?"left join crm_mailbox_private_decisions d on d.workspace_id=m.workspace_id and d.user_id=m.user_id and d.message_id=m.id and d.status='filed'":''} left join leads lead on lead.workspace_id=m.workspace_id and lead.project_id=${auto?'coalesce(l.project_id,d.project_id)':'l.project_id'} and lead.id=${auto?'coalesce(l.lead_id,d.lead_id)':'l.lead_id'} where m.id=$1::uuid and m.workspace_id=$2::uuid and m.user_id=$3::uuid and m.deleted_at is null and(${auto?'(l.id is null and d.id is null)':'l.id is null'} or lead.id is not null) for update of m`,[id,fresh.workspaceId,fresh.userId]);
  if(!current)throw new CrmCommandError('NOT_FOUND','Eigene sichtbare Nachricht nicht verfügbar',404);
  return executeCrmCommand(fresh,{operation:'mailbox.personal_triage',resourceId:id,projectId:current.projectId??undefined,capability:'workspace:operate',payload:input,...metadata},async(commandTx,context)=>{
   const saved=input.expectedRevision===0?await commandTx.queryOne<{revision:number}>(`insert into crm_mailbox_triage(workspace_id,user_id,message_id,status) values($1::uuid,$2::uuid,$3::uuid,$4) on conflict do nothing returning revision`,[context.workspaceId,context.actorId,id,input.status]):await commandTx.queryOne<{revision:number}>(`update crm_mailbox_triage set status=$4,revision=revision+1,updated_at=now() where workspace_id=$1::uuid and user_id=$2::uuid and message_id=$3::uuid and revision=$5 returning revision`,[context.workspaceId,context.actorId,id,input.status,input.expectedRevision]);
   if(!saved)throw new CrmCommandError('VERSION_CONFLICT','Bearbeitungsstand wurde geändert. Bitte neu laden.',409);
   return {id,revision:saved.revision,status:input.status,sent:false};
  });
 },options);
}
