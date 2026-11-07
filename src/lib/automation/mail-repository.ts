import type { AppSession } from '@/lib/auth/session';
import { assertCrmUuid, assertProjectGrant, CrmCommandError, crmPayloadDigest, executeCrmCommand, withCrmRead, type TenantTransaction, type TenantTransactionOptions } from '@/lib/crm-command';
import { getContactVisibilityScope, canWriteContacts } from '@/lib/contact-access';
import { hasProductCapability } from '@/lib/product-model';
import { getNewsletterProviderStatus, type NewsletterProviderStatus } from '@/lib/integrations/resend';
import { dispatchApprovedNewsletter, type NewsletterDispatch, type NewsletterTransport } from '@/lib/newsletter-provider';
import { evaluateOutboundConsent } from '@/lib/db/consent-policy';
import {getTrustedAppOrigin} from '@/lib/auth/app-origin';
import {checkMarketingContactPolicy} from '@/lib/db/marketing-contact-policy-repository';
import {automationMessageVariableIssues} from './message-variables';
import {readProviderDeliveryState} from '@/lib/db/resend-webhook-repository';
import { automationStopReason, nextAutomationNode, validateAutomationGraph, type AutomationGraph } from './graph';
import { automationExposeSignalAllowed,automationViewingSignalAllowed,automationMatchSignalAllowed,readRuntimeFacts,type AutomationEventInput,type RuntimeRow } from './repository';
import { automationMailContentIssues, automationMailPurposes, automationMailText, renderAutomationMail, type AutomationMailDelivery, type AutomationMailPreview, type AutomationMailPurpose } from './mail';

type Options=TenantTransactionOptions&{provider?:()=>NewsletterProviderStatus;transport?:NewsletterTransport;origin?:string;now?:()=>Date};
type Metadata={idempotencyKey:string;correlationId:string};
type DraftRow=RuntimeRow&{draftId:string;contactId:string|null;subject:string;body:string;status:string;runStatus:string;requestType:string|null;originTrigger:string;originContext:AutomationEventInput['context']};
const deliverySelect=`select id,status,error,accepted_at::text as "acceptedAt",created_at::text as "createdAt" from crm_automation_mail_deliveries where workspace_id=$1::uuid and draft_id=$2::uuid`;
function maySend(session:AppSession){return !session.serviceIdentity&&session.permissions.includes('crm:write')&&session.permissions.includes('workflows:run')&&hasProductCapability(session.productRole,'pipeline:write')&&canWriteContacts(session);}
function requireSend(session:AppSession){if(!maySend(session))throw new CrmCommandError('FORBIDDEN','Die persönliche Berechtigung für diesen Kommunikationsvorgang fehlt.',403);}
function purpose(value:string):AutomationMailPurpose {if(!(automationMailPurposes as readonly string[]).includes(value))throw new CrmCommandError('INVALID_PURPOSE','Ein konkreter anfragebezogener Versandzweck ist erforderlich.');return value as AutomationMailPurpose;}

/** Called by manual review as well; delivery uncertainty cannot be dismissed into continuation. */
export async function assertDraftNotInFlight(tx:TenantTransaction,workspaceId:string,draftId:string){
 if(await tx.queryOne("select id from crm_automation_mail_deliveries where workspace_id=$1::uuid and draft_id=$2::uuid and status in('claimed','uncertain','accepted')",[workspaceId,draftId]))throw new CrmCommandError('MAIL_RESULT_UNRESOLVED','Ein Versandbeleg besteht bereits. Ein ungeklärter Versand muss zuerst beim Versanddienst abgeglichen werden.',409);
}
async function load(tx:TenantTransaction,session:AppSession,draftId:string,write:boolean){
 // All send paths acquire policy -> contact locks. A queued policy edit must not invert that order.
 if(write)await tx.query('select pg_advisory_xact_lock_shared(hashtextextended($1,0))',[`marketing-contact-policy:${session.workspaceId}`]);
 await tx.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[`web-expose-automation-workspace:${session.workspaceId}`]);
 const query=`select e.id,e.workspace_id as "workspaceId",e.project_id as "projectId",e.automation_id as "automationId",e.version,e.lead_id as "leadId",e.node_id as "nodeId",e.enrolled_at as "enrolledAt",v.graph,a.status as "automationStatus",d.id as "draftId",d.contact_id as "contactId",d.subject,d.body,d.status,e.status as "runStatus",d.request_type as "requestType",ev.trigger_key as "originTrigger",ev.context as "originContext" from crm_automation_drafts d join crm_automation_enrollments e on e.workspace_id=d.workspace_id and e.id=d.enrollment_id join crm_automation_versions v on v.workspace_id=e.workspace_id and v.automation_id=e.automation_id and v.version=e.version join crm_automations a on a.workspace_id=e.workspace_id and a.id=e.automation_id join crm_automation_events ev on ev.workspace_id=e.workspace_id and ev.id=e.event_id where d.workspace_id=$1::uuid and d.id=$2::uuid`;
 let row=await tx.queryOne<DraftRow>(query,[session.workspaceId,assertCrmUuid(draftId)]);
 if(!row)throw new CrmCommandError('NOT_FOUND','Der Nachrichtenentwurf ist nicht verfügbar.',404);
 // Privacy withdrawal owns session→link→enrollment locks. Acquire these before draft/enrollment rows too.
 if(row.originTrigger==='expose_opened')await automationExposeSignalAllowed(tx,session.workspaceId,row.leadId,row.originContext);
 if(write){row=await tx.queryOne<DraftRow>(query+' for update of d,e,a',[session.workspaceId,draftId]);if(!row)throw new CrmCommandError('NOT_FOUND','Der Nachrichtenentwurf ist nicht mehr verfügbar.',404);}
 if(row.projectId)await assertProjectGrant(tx,session,row.projectId,write);
 else if(!(await tx.queryOne<{allowed:boolean}>('select crm_workspace_manager($1::uuid) as allowed',[session.workspaceId]))?.allowed)throw new CrmCommandError('FORBIDDEN','Projektberechtigung fehlt.',403);
 const visibility=getContactVisibilityScope(session);
 const contact=await tx.queryOne<{name:string;email:string|null;ownerUserId:string|null;projectId:string|null}>(`select name,email,owner_user_id as "ownerUserId",project_id as "projectId" from contacts where workspace_id=$1::uuid and id=$2::uuid and archived_at is null ${write?'for update':''}`,[session.workspaceId,row.contactId]);
 if(!contact||visibility.kind==='none'||(visibility.kind==='own'&&contact.ownerUserId!==visibility.userId)||(contact.projectId&&contact.projectId!==row.projectId))throw new CrmCommandError('CONTACT_UNAVAILABLE','Der aktuelle Kontakt ist für diesen Entwurf nicht berechtigt verfügbar.',404);
 return {row,contact};
}
async function inspect(tx:TenantTransaction,session:AppSession,draftId:string,mailPurpose:AutomationMailPurpose,options:Options,write=false,excludeDeliveryId?:string){
 const {row,contact}=await load(tx,session,draftId,write),issues:string[]=[];
 const graph=validateAutomationGraph(row.graph, { allowLegacyVariables: true }),node=graph.nodes.find(n=>n.id===row.nodeId);
 if(row.status!=='pending'||row.runStatus!=='review')issues.push('Der Entwurf wartet nicht mehr auf eine Versandentscheidung.');
 if(row.automationStatus!=='active')issues.push('Der Flow ist pausiert.');
 if(!node||!['email_draft','request'].includes(node.type)||node.subject!==row.subject||node.body!==row.body)issues.push('Der Entwurf passt nicht zur gespeicherten Flowversion.');
 if((node?.type==='request'?node.request:null)!==row.requestType)issues.push('Der Anforderungszweck passt nicht zur gespeicherten Flowversion.');
 const {lead,facts}=await readRuntimeFacts(tx,row);
 if(lead.syntheticExample)issues.push('Aus gekennzeichneten Beispieldaten werden keine echten Nachrichten versandt.');
 if(lead.contactId!==row.contactId)issues.push('Der Lead ist inzwischen mit einem anderen Kontakt verbunden.');
 if(automationStopReason(graph,facts))issues.push('Abmeldung, Antwort oder persönlicher Kontakt stoppt diesen Lauf.');
 // An analytics-derived origin always requires the originating session, even if malformed legacy context omits it.
 if(row.originTrigger==='expose_opened'&&!await automationExposeSignalAllowed(tx,session.workspaceId,row.leadId,row.originContext))issues.push('Die Analyticsfreigabe oder der ursprüngliche Exposé-Link ist nicht mehr gültig.');
 if(row.originTrigger==='appointment_booked'&&row.originContext?.viewingId&&!await automationViewingSignalAllowed(tx,session.workspaceId,row.leadId,row.originContext))issues.push('Die bestätigte Besichtigung wurde abgesagt oder verschoben und muss erneut geprüft werden.');
 if(row.originTrigger==='new_match'&&row.originContext?.matchId&&!await automationMatchSignalAllowed(tx,session.workspaceId,row.leadId,row.originContext))issues.push('Der ursprüngliche Treffer, seine Quelldaten oder das Kaufzeitfenster sind nicht mehr aktuell. Bitte erneut prüfen.');
 const to=contact.email?.trim().toLowerCase()??'';
 if(!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(to)||/[\r\n]/.test(to))issues.push('Die aktuelle E-Mail-Adresse ist ungültig.');
 const consent=await evaluateOutboundConsent({session,channel:'E-Mail',purpose:mailPurpose,contactId:row.contactId,email:to,projectId:row.projectId,metadata:{automationDraftId:row.draftId,automationId:row.automationId,manualApproval:true}});
 if(!consent.allowed)issues.push(`Aktuelle E-Mail-Freigabe fehlt (${consent.reason}).`);
 const provider=(options.provider??getNewsletterProviderStatus)();
 if(!provider.configured||!provider.external)issues.push('Der Versanddienst ist nicht eingerichtet.');
 if(/[\r\n]/.test(provider.from)||!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test((provider.from.match(/<([^<>]+)>/)?.[1]??provider.from).trim()))issues.push('Der konfigurierte Absender ist ungültig.');
 const project=row.projectId?await tx.queryOne<{name:string}>('select name from projects where workspace_id=$1::uuid and id=$2::uuid',[session.workspaceId,row.projectId]):null;
 let requestUrl:string|undefined;
 if(row.requestType){
  const installed=await tx.queryOne<{ready:boolean}>("select to_regclass('public.lead_customer_requests') is not null as ready");
  if(installed?.ready){const {getAutomationCustomerRequestLink}=await import('@/lib/lead-customer-request-repository');const link=await getAutomationCustomerRequestLink(tx,session,row.draftId,options.origin??getTrustedAppOrigin());if(link?.purpose===row.requestType)requestUrl=link.url;}
  if(!requestUrl)issues.push('Der sichere Kundenlink fehlt, wurde widerrufen, ist abgelaufen oder bereits eingereicht.');
 }
 const substitutions={contactName:contact.name,projectName:project?.name??'',agentName:session.name,requestUrl};
 issues.push(...automationMessageVariableIssues(row.subject,row.body,substitutions));
 const contactPolicy=await checkMarketingContactPolicy(tx,session,{contactId:row.contactId!,email:to,lock:write,...(excludeDeliveryId?{excludeDelivery:{kind:'automation' as const,id:excludeDeliveryId}}:{})},options.now?.()??new Date());
 issues.push(...contactPolicy.issues);
 const subject=automationMailText(row.subject,substitutions);let body=automationMailText(row.body,substitutions);
 if(requestUrl&&!row.body.includes('{{request.url}}'))body+=`\n\n${node?.language==='es'?'Formulario seguro':node?.language==='en'?'Secure form':'Sicheres Formular'}:\n${requestUrl}`;
 issues.push(...automationMailContentIssues(subject,body));
 const payload:Omit<NewsletterDispatch,'idempotencyKey'>={to,from:provider.from,subject,html:renderAutomationMail(body)};
 const approvalDigest=crmPayloadDigest({draftId:row.draftId,enrollmentId:row.id,version:row.version,contactId:row.contactId,purpose:mailPurpose,payload});
 const delivery=await tx.queryOne<AutomationMailDelivery>(deliverySelect,[session.workspaceId,row.draftId]);
 if(delivery)delivery.providerStatus=await readProviderDeliveryState(tx,session.workspaceId,delivery.id,'automation');
 if(delivery&&delivery.status!=='deferred')issues.push('Für diesen Entwurf besteht bereits ein Versandbeleg. Er wird nicht erneut versandt.');
 if(delivery?.status==='deferred'){
  const actor=await tx.queryOne<{actorId:string}>('select actor_id as "actorId" from crm_automation_mail_deliveries where workspace_id=$1::uuid and id=$2::uuid',[session.workspaceId,delivery.id]);
  if(actor?.actorId!==session.userId)issues.push('Die nachweislich ungesendete Nachricht benötigt eine erneute Freigabe durch den ursprünglichen Absender.');
 }
 if(!maySend(session))issues.push('Die persönliche Versandberechtigung fehlt.');
 const preview:AutomationMailPreview={draftId:row.draftId,workspaceId:session.workspaceId,projectId:row.projectId,to,contactName:contact.name,from:provider.from,subject,body,purpose:mailPurpose,approvalDigest,issues,canSend:issues.length===0,delivery};
 return {row,payload,preview,contactPolicy};
}
export async function previewAutomationMail(session:AppSession,input:{draftId:string;purpose:string},options:Options={}){
 return withCrmRead(session,async(tx,fresh)=>{if(fresh.serviceIdentity)throw new CrmCommandError('FORBIDDEN','Eine persönliche Anmeldung ist erforderlich.',403);return (await inspect(tx,fresh,input.draftId,purpose(input.purpose),options)).preview;},options);
}
export async function sendAutomationMail(session:AppSession,input:{draftId:string;purpose:string;approvalDigest:string;approved:boolean},metadata:Metadata,options:Options={}){
 const mailPurpose=purpose(input.purpose);
 if(input.approved!==true||!/^[a-f0-9]{64}$/.test(input.approvalDigest))throw new CrmCommandError('APPROVAL_REQUIRED','Empfänger, Nachricht und konkreter Versandzweck müssen ausdrücklich freigegeben werden.');
 const receipt=await executeCrmCommand(session,{operation:'automation.mail.send',resourceId:assertCrmUuid(input.draftId),capability:'pipeline:write',payload:input,...metadata},async(tx,context)=>{
  requireSend(context.session);
  const prepared=await inspect(tx,context.session,input.draftId,mailPurpose,options,true);
  if(prepared.preview.issues.length)throw new CrmCommandError('MAIL_NOT_READY',prepared.preview.issues.join(' '),409);
  if(prepared.preview.approvalDigest!==input.approvalDigest)throw new CrmCommandError('APPROVAL_STALE','Empfänger, Absender oder Nachricht haben sich geändert. Bitte die aktuelle Vorschau erneut freigeben.',409);
  if(prepared.preview.delivery?.status==='deferred'){
   const resumed=await tx.queryOne<{id:string}>(`update crm_automation_mail_deliveries set status='claimed',error=null,updated_at=now() where workspace_id=$1::uuid and id=$2::uuid and actor_id=$3::uuid and approval_digest=$4 and status='deferred' returning id`,[context.workspaceId,prepared.preview.delivery.id,context.actorId,input.approvalDigest]);
   if(!resumed)throw new CrmCommandError('APPROVAL_STALE','Der zurückgestellte Vorgang hat sich geändert. Bitte den aktuellen Stand prüfen.',409);
   return {persisted:true,id:resumed.id};
  }
  await tx.execute(`insert into crm_automation_mail_deliveries(id,workspace_id,project_id,draft_id,contact_id,actor_id,purpose,approval_digest,payload) values($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6::uuid,$7,$8,$9::jsonb)`,[context.commandId,context.workspaceId,prepared.row.projectId,input.draftId,prepared.row.contactId,context.actorId,mailPurpose,input.approvalDigest,JSON.stringify(prepared.payload)]);
  return {persisted:true,id:context.commandId};
 },options);
 if(!receipt.replayed){
  // The durable claim is committed. Locks below serialize fresh permission/consent checks with withdrawal until the bounded provider call finishes.
  await withCrmRead(session,async(tx,fresh)=>{
   requireSend(fresh);
   const delivery=await tx.queryOne<{id:string;digest:string;payload:Omit<NewsletterDispatch,'idempotencyKey'>;actorId:string}>(`select id,approval_digest as digest,payload,actor_id as "actorId" from crm_automation_mail_deliveries where workspace_id=$1::uuid and id=$2::uuid and status='claimed'`,[fresh.workspaceId,receipt.data.id]);
   if(!delivery||delivery.actorId!==fresh.userId)return;
   const prepared=await inspect(tx,fresh,input.draftId,mailPurpose,options,true,delivery.id);
   const issues=prepared.preview.issues.filter(issue=>issue!=='Für diesen Entwurf besteht bereits ein Versandbeleg. Er wird nicht erneut versandt.');
   if(issues.length||prepared.preview.approvalDigest!==delivery.digest){
    const deferred=prepared.preview.approvalDigest===delivery.digest&&!prepared.contactPolicy.allowed&&issues.every(issue=>prepared.contactPolicy.issues.includes(issue));
    await tx.execute(`update crm_automation_mail_deliveries set status=$4,error=$3,updated_at=now() where workspace_id=$1::uuid and id=$2::uuid and status='claimed'`,[fresh.workspaceId,delivery.id,deferred?`CONTACT_POLICY_DEFERRED:${prepared.contactPolicy.nextAllowedAt??'Prüfung erforderlich'}`:issues.join(' ')||'Der freigegebene Empfänger oder Inhalt wurde geändert.',deferred?'deferred':'suppressed']);return;
   }
   const received=await(options.transport??dispatchApprovedNewsletter)({...delivery.payload,idempotencyKey:`automation-mail/${delivery.id}`,reference:{kind:'automation',id:delivery.id}}).catch(()=>({status:'uncertain' as const,error:'Versandergebnis ungeklärt.'}));
   const result=received.status==='accepted'&&!received.messageId?{status:'uncertain' as const,error:'Die Annahme-ID fehlt.'}:received;
   await tx.execute(`update crm_automation_mail_deliveries set status=$3,provider_message_id=$4,error=$5,accepted_at=case when $3='accepted' then now() end,updated_at=now() where workspace_id=$1::uuid and id=$2::uuid and status='claimed'`,[fresh.workspaceId,delivery.id,result.status,result.status==='accepted'?result.messageId??null:null,result.error?.slice(0,1000)??null]);
   if(result.status==='accepted'){
    const graph:AutomationGraph=validateAutomationGraph(prepared.row.graph, { allowLegacyVariables: true }),next=nextAutomationNode(graph,prepared.row.nodeId);
    await tx.execute(`update crm_automation_drafts set status='reviewed',reviewed_by=$3::uuid,reviewed_at=now() where workspace_id=$1::uuid and id=$2::uuid`,[fresh.workspaceId,input.draftId,fresh.userId]);
    await tx.execute(`update crm_automation_enrollments set status=$3,node_id=$4,due_at=now(),stop_reason=null,updated_at=now() where workspace_id=$1::uuid and id=$2::uuid and status='review'`,[fresh.workspaceId,prepared.row.id,next?'running':'completed',next??prepared.row.nodeId]);
    await tx.execute(`insert into contact_timeline_items(workspace_id,contact_id,project_id,channel,title,detail,outcome,metadata) values($1::uuid,$2::uuid,$3::uuid,'E-Mail',$4,'Vom Versanddienst angenommen. Zustellung ist noch nicht bestätigt.','angenommen',$5::jsonb)`,[fresh.workspaceId,prepared.row.contactId,prepared.row.projectId,prepared.preview.subject,JSON.stringify({source:'automation_mail',leadId:prepared.row.leadId,automationDraftId:input.draftId,deliveryId:delivery.id,actorUserId:fresh.userId,providerAccepted:true,deliveryVerified:false})]);
   }
  },{...options,statementTimeoutMs:25000});
 }
 return withCrmRead(session,async(tx,fresh)=>{requireSend(fresh);await load(tx,fresh,input.draftId,false);return {persisted:true,replayed:receipt.replayed,draftId:input.draftId,delivery:await tx.queryOne<AutomationMailDelivery>(deliverySelect,[fresh.workspaceId,input.draftId])};},options);
}
