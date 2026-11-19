import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {before,after,test} from 'node:test';
import type {AppSession} from '../src/lib/auth/session';
import type {TenantPool} from '../src/lib/db/tenant-client';
import {withCrmRead} from '../src/lib/crm-command';
import {previewAutomationMail,sendAutomationMail} from '../src/lib/automation/mail-repository';
import {reviewAutomationDraft,runAutomationDue,saveAutomation} from '../src/lib/automation/repository';
import {automationMailContentIssues,renderAutomationMail} from '../src/lib/automation/mail';
import type {AutomationGraph} from '../src/lib/automation/graph';
import type {NewsletterDispatch} from '../src/lib/newsletter-provider';
import {startLocalSalesDb,applySalesSchema} from './lib/local-sales-db.mjs';
import {prepareAutomationCustomerRequest,saveCustomerRequestSettings} from '../src/lib/lead-customer-request-repository';
import {saveLeadMatchingProfile,computeLeadPropertyMatches,getLeadQualification} from '../src/lib/lead-qualification-repository';
import {readLeadQualificationPlan,saveLeadQualificationPreferences} from '../src/lib/lead-qualification-plan-repository';
import {readMarketingContactPolicy,saveMarketingContactPolicy} from '../src/lib/db/marketing-contact-policy-repository';
process.env.NOVALURE_AUTH_ENCRYPTION_KEY||='synthetic-only-automation-mail-customer-request-encryption';

test('transactional message rendering escapes content and refuses control characters and unresolved tokens',()=>{
 assert.ok(automationMailContentIssues('Subject\r\nBcc: wrong@example.invalid','Text').length);
 assert.ok(automationMailContentIssues('Subject','{{secret.token}}').length);
 const rendered=renderAutomationMail('<script>wrong</script> https://example.invalid/path?q=one&two=2');
 assert.doesNotMatch(rendered,/<script>/);assert.match(rendered,/&lt;script&gt;/);assert.match(rendered,/href="https:\/\/example.invalid\/path\?q=one&amp;two=2"/);
});
let db:Awaited<ReturnType<typeof startLocalSalesDb>>;
const w=randomUUID(),foreignW=randomUUID(),owner=randomUUID(),agent=randomUUID(),foreignOwner=randomUUID(),project=randomUUID(),hiddenProject=randomUUID(),foreignProject=randomUUID();
const sent:NewsletterDispatch[]=[];
const provider=()=>({configured:true,external:true,provider:'resend' as const,from:'SYNTHETIC <staff@example.invalid>',reason:null});
const transport=async(message:NewsletterDispatch)=>{sent.push(message);return {status:'accepted' as const,messageId:'synthetic-'+sent.length};};
const options=()=>({pool:db.pool as unknown as TenantPool,provider,transport,origin:'https://public.example.invalid'});
const meta=()=>({idempotencyKey:randomUUID(),correlationId:randomUUID()});
function session(actor=owner):AppSession{return {authenticated:true,workspaceId:w,userId:actor,name:'SYNTHETIC Operator',email:'owner@example.invalid',workspaceName:'SYNTHETIC Mail',role:actor===owner?'owner':'agent',productRole:actor===owner?'customer_owner':'project_sales_member',permissions:[],productPermissions:[],source:'database'};}
type Fixture={draftId:string;contactId:string;leadId:string;enrollmentId:string;automationId:string;eventId:string};
async function fixture(input:{scope?:string;workspace?:string;actor?:string;contactOwner?:string;trigger?:string;context?:object|((fixture:Fixture)=>Promise<object>);request?:boolean;legacyVariable?:boolean}={}):Promise<Fixture>{
 const workspace=input.workspace??w,target=input.scope??project,actor=input.actor??owner,contactOwner=input.contactOwner??owner;
 const result={draftId:randomUUID(),contactId:randomUUID(),leadId:randomUUID(),enrollmentId:randomUUID(),automationId:randomUUID(),eventId:randomUUID()};
 const graph:AutomationGraph={schemaVersion:1,trigger:'new_lead',timezone:'Europe/Vienna',businessHours:false,stopOnPersonalContact:true,nodes:[{id:'start',type:'start',title:'Start'},{id:'mail',type:'email_draft',title:'SYNTHETIC reply',subject:'SYNTHETIC Hello {{contact.name}}',body:'<script>plain text</script> About {{project.name}}, from {{agent.name}}.'},{id:'end',type:'stop',title:'End'}],edges:[{from:'start',to:'mail',port:'next'},{from:'mail',to:'end',port:'next'}]};
 if(input.request)graph.nodes[1]={...graph.nodes[1],type:'request',request:'contact_details',language:'en',body:'SYNTHETIC Please review your contact details: {{request.url}}'};
 if(input.legacyVariable)graph.nodes[1]={...graph.nodes[1],body:'SYNTHETIC Historical text {{legacy.placeholder}}'};
 await db.admin.query("insert into contacts(id,workspace_id,project_id,owner_user_id,name,email,role,consent_label) values($1,$2,$3,$4,'SYNTHETIC Contact',$5,'Käufer','Opt-in')",[result.contactId,workspace,target,contactOwner,`recipient-${result.contactId}@example.invalid`]);
 await db.admin.query("insert into leads(id,workspace_id,project_id,contact_id,assigned_to_user_id,type,status,intent) values($1,$2,$3,$4,$5,'Käufer','Neu','SYNTHETIC Concrete inquiry')",[result.leadId,workspace,target,result.contactId,actor]);
 await db.admin.query("insert into crm_automations(id,workspace_id,project_id,name,draft,active_version,status,created_by) values($1,$2,$3,'SYNTHETIC Mail flow',$4::jsonb,1,'active',$5)",[result.automationId,workspace,target,JSON.stringify(graph),actor]);
 await db.admin.query("insert into crm_automation_versions(workspace_id,project_id,automation_id,version,graph,graph_digest,created_by) values($1,$2,$3,1,$4::jsonb,$5,$6)",[workspace,target,result.automationId,JSON.stringify(graph),'a'.repeat(64),actor]);
 const context=typeof input.context==='function'?await input.context(result):input.context??{};
 await db.admin.query("insert into crm_automation_events(id,workspace_id,project_id,lead_id,event_key,trigger_key,context) values($1,$2,$3,$4,$5,$6,$7::jsonb)",[result.eventId,workspace,target,result.leadId,randomUUID(),input.trigger??'new_lead',JSON.stringify(context)]);
 await db.admin.query("insert into crm_automation_enrollments(id,workspace_id,project_id,automation_id,version,lead_id,event_id,node_id,status) values($1,$2,$3,$4,1,$5,$6,'mail','review')",[result.enrollmentId,workspace,target,result.automationId,result.leadId,result.eventId]);
 await db.admin.query("insert into crm_automation_drafts(id,workspace_id,project_id,enrollment_id,node_id,contact_id,subject,body,consent_allowed,consent_reason,request_type) values($1,$2,$3,$4,'mail',$5,$6,$7,true,'SYNTHETIC old creation decision',$8)",[result.draftId,workspace,target,result.enrollmentId,result.contactId,graph.nodes[1].subject,graph.nodes[1].body,graph.nodes[1].request??null]);
 return result;
}
async function approved(f:Fixture,actor=owner){const preview=await previewAutomationMail(session(actor),{draftId:f.draftId,purpose:'salesFollowUp'},options());assert.deepEqual(preview.issues,[]);return {draftId:f.draftId,purpose:'salesFollowUp',approvalDigest:preview.approvalDigest,approved:true};}
async function analyticsFixture(){
 const sessionId=randomUUID(),linkId=randomUUID(),versionId=randomUUID(),propertyId=randomUUID(),f=await fixture({trigger:'expose_opened',context:{exposeSessionId:sessionId}});
 await db.admin.query("insert into seller_listings(id,workspace_id,project_id,title,address,region,object_type,area_sqm) values($1,$2,$3,'SYNTHETIC Property','SYNTHETIC Address','SYNTHETIC Region','Wohnung',80)",[propertyId,w,project]);
 await db.admin.query("insert into web_expose_versions(id,workspace_id,property_id,project_id,created_by,language,version,snapshot,source_fingerprint) values($1,$2,$3,$4,$5,'de',1,'{\"schemaVersion\":1}',$6)",[versionId,w,propertyId,project,owner,randomUUID()]);
 await db.admin.query("insert into web_expose_links(id,workspace_id,version_id,token_hash,label,intended_lead_id) values($1,$2,$3,$4,'SYNTHETIC Personal link',$5)",[linkId,w,versionId,randomUUID().replaceAll('-','')+'a'.repeat(32),f.leadId]);
 await db.admin.query("insert into web_expose_sessions(id,workspace_id,link_id,token_hash,visitor_hash) values($1,$2,$3,$4,$5)",[sessionId,w,linkId,randomUUID().replaceAll('-','')+'b'.repeat(32),'c'.repeat(64)]);
 return {...f,sessionId,linkId,versionId};
}
before(async()=>{
 db=await startLocalSalesDb();await applySalesSchema(db,{maxMigrationNumber:106});for(const name of ['154_automation_graph.sql','155_web_expose.sql','159_lead_qualification.sql','162_lead_customer_requests.sql','165_automation_mail.sql','169_property_meeting_context.sql','174_lead_qualification_plan.sql','183_marketing_contact_policy.sql'])await db.admin.query(await readFile('migrations/'+name,'utf8'));
 await db.admin.query("insert into workspaces(id,name,operating_model) values($1,'SYNTHETIC Mail','self_service_customer'),($2,'SYNTHETIC Foreign','self_service_customer')",[w,foreignW]);
 await db.admin.query("insert into workspace_users(id,workspace_id,name,email,role,product_role,status) values($1,$4,'SYNTHETIC Owner','owner@example.invalid','owner','customer_owner','active'),($2,$4,'SYNTHETIC Agent','agent@example.invalid','agent','project_sales_member','active'),($3,$5,'SYNTHETIC Foreign','foreign@example.invalid','owner','customer_owner','active')",[owner,agent,foreignOwner,w,foreignW]);
 await db.admin.query("insert into projects(id,workspace_id,name,type) values($1,$4,'SYNTHETIC Project','Test'),($2,$4,'SYNTHETIC Hidden','Test'),($3,$5,'SYNTHETIC Foreign','Test')",[project,hiddenProject,foreignProject,w,foreignW]);
 await db.admin.query("insert into project_pipeline_permissions(workspace_id,project_id,user_id,can_read,can_edit_deals) values($1,$2,$3,true,true)",[w,project,agent]);
 await withCrmRead(session(),(tx,fresh)=>saveCustomerRequestSettings(tx,fresh,{controller:'SYNTHETIC Company',privacyUrl:'https://example.invalid/privacy'}),options());
});
after(async()=>{if(db)await db.stop();});

test('exact current tenant, project, contact ownership and fresh permissions protect preview and send',async()=>{
 const own=await fixture({contactOwner:agent}),other=await fixture(),hidden=await fixture({scope:hiddenProject,contactOwner:agent}),foreign=await fixture({workspace:foreignW,scope:foreignProject,actor:foreignOwner,contactOwner:foreignOwner});
 const valid=await approved(own,agent);assert.ok(valid.approvalDigest);
 for(const f of [other,hidden,foreign])await assert.rejects(previewAutomationMail(session(agent),{draftId:f.draftId,purpose:'salesFollowUp'},options()));
 await db.admin.query('update project_pipeline_permissions set can_edit_deals=false where workspace_id=$1 and project_id=$2 and user_id=$3',[w,project,agent]);
 await assert.rejects(sendAutomationMail(session(agent),valid,meta(),options()));
 await db.admin.query('update project_pipeline_permissions set can_edit_deals=true where workspace_id=$1 and project_id=$2 and user_id=$3',[w,project,agent]);
 assert.equal(sent.length,0);
});
test('deliberate approval binds the current exact recipient, source draft and configured sender',async()=>{
 const f=await fixture(),input=await approved(f),before=sent.length;
 await assert.rejects(sendAutomationMail(session(),{...input,approved:false},meta(),options()),/ausdrücklich/);
 await db.admin.query("update contacts set email='changed@example.invalid' where id=$1",[f.contactId]);
 await assert.rejects(sendAutomationMail(session(),input,meta(),options()),/geändert/);
 const current=await approved(f);await assert.rejects(sendAutomationMail(session(),current,meta(),{...options(),provider:()=>({...provider(),from:'SYNTHETIC <changed@example.invalid>'})}),/geändert/);
 const metadata=meta();const results=await Promise.all([sendAutomationMail(session(),current,metadata,options()),sendAutomationMail(session(),current,metadata,options())]);
 assert.equal(results.filter(result=>result.replayed).length,1);assert.equal(sent.length-before,1);assert.equal(sent.at(-1)?.to,'changed@example.invalid');assert.equal(sent.at(-1)?.from,provider().from);assert.match(sent.at(-1)!.html,/&lt;script&gt;/);assert.equal(sent.at(-1)?.unsubscribeUrl,undefined);
 assert.equal((await db.admin.query('select status from crm_automation_enrollments where id=$1',[f.enrollmentId])).rows[0].status,'running');
 const timeline=(await db.admin.query('select metadata,detail from contact_timeline_items where contact_id=$1',[f.contactId])).rows[0];assert.equal(timeline.metadata.deliveryVerified,false);assert.match(timeline.detail,/nicht bestätigt/);
 await sendAutomationMail(session(),current,metadata,options());assert.equal(sent.length-before,1);
});
test('fresh opt-out, personal contact, paused flow, stopped run and reviewed drafts cannot cross provider boundary',async()=>{
 const before=sent.length;
 for(const change of ['optout','contact','paused','stopped','reviewed','example']){
  const f=await fixture(),input=await approved(f);
  if(change==='optout')await db.admin.query("insert into consent_records(workspace_id,project_id,contact_id,channel,status,source) values($1,$2,$3,'E-Mail','Abgemeldet','SYNTHETIC revocation')",[w,project,f.contactId]);
  if(change==='contact')await db.admin.query('update leads set last_contact_at=clock_timestamp() where id=$1',[f.leadId]);
  if(change==='paused')await db.admin.query("update crm_automations set status='paused' where id=$1",[f.automationId]);
  if(change==='stopped')await db.admin.query("update crm_automation_enrollments set status='stopped' where id=$1",[f.enrollmentId]);
  if(change==='reviewed')await db.admin.query("update crm_automation_drafts set status='reviewed' where id=$1",[f.draftId]);
  if(change==='example')await db.admin.query(`update leads set metadata=metadata||'{"onboardingExample":{"synthetic":true}}'::jsonb where id=$1`,[f.leadId]);
  await assert.rejects(sendAutomationMail(session(),input,meta(),options()));
 }assert.equal(sent.length,before);
});
test('missing analytics origin permission is fail closed, regardless of old consent_allowed',async()=>{
 const f=await fixture({trigger:'expose_opened',context:{exposeSessionId:randomUUID()}}),preview=await previewAutomationMail(session(),{draftId:f.draftId,purpose:'salesFollowUp'},options());
 assert.equal(preview.canSend,false);assert.ok(preview.issues.some(issue=>/Analytics/.test(issue)));
 await assert.rejects(sendAutomationMail(session(),{draftId:f.draftId,purpose:'salesFollowUp',approvalDigest:preview.approvalDigest,approved:true},meta(),options()),/Analytics/);
});
test('unknown provider results are durable, never automatically sent again and cannot be reviewed away',async()=>{
 const f=await fixture(),input=await approved(f),metadata=meta();let calls=0;
 const uncertain={...options(),transport:async()=>{calls++;return {status:'uncertain' as const,error:'SYNTHETIC response lost'};}};
 const result=await sendAutomationMail(session(),input,metadata,uncertain);assert.equal(result.delivery?.status,'uncertain');
 await sendAutomationMail(session(),input,metadata,uncertain);await assert.rejects(sendAutomationMail(session(),input,meta(),uncertain));assert.equal(calls,1);
 await assert.rejects(withCrmRead(session(),(tx,fresh)=>reviewAutomationDraft(tx,fresh,{id:f.draftId,dismiss:false}),options()));
 assert.equal((await db.admin.query('select status from crm_automation_enrollments where id=$1',[f.enrollmentId])).rows[0].status,'review');
 await assert.rejects(db.admin.query("update crm_automation_mail_deliveries set payload='{}' where draft_id=$1",[f.draftId]),/immutable/);
});
test('post-provider database failure leaves a committed claim; replay observes it instead of repeating',async()=>{
 const f=await fixture(),input=await approved(f),metadata=meta();let calls=0;
 await db.admin.query("create function qa_mail_fail() returns trigger language plpgsql as $$ begin if new.status='accepted' then raise exception 'SYNTHETIC persist failure';end if;return new;end $$;create trigger qa_mail_fail before update on crm_automation_mail_deliveries for each row execute function qa_mail_fail()");
 try{await assert.rejects(sendAutomationMail(session(),input,metadata,{...options(),transport:async()=>{calls++;return {status:'accepted' as const,messageId:'SYNTHETIC accepted'};}}),/persist failure/);}finally{await db.admin.query('drop trigger qa_mail_fail on crm_automation_mail_deliveries;drop function qa_mail_fail()');}
 assert.equal((await sendAutomationMail(session(),input,metadata,options())).delivery?.status,'claimed');assert.equal(calls,1);
 await assert.rejects(withCrmRead(session(),(tx,fresh)=>reviewAutomationDraft(tx,fresh,{id:f.draftId,dismiss:true}),options()));
});
test('the originating analytics session, link and active version are checked after the user preview',async()=>{
 const before=sent.length;
 for(const change of ['withdraw','revoke','expire','version','wronglead']){
  const f=await analyticsFixture(),input=await approved(f);
  if(change==='withdraw')await db.admin.query('update web_expose_sessions set withdrawn_at=clock_timestamp() where id=$1',[f.sessionId]);
  if(change==='revoke')await db.admin.query('update web_expose_links set revoked_at=clock_timestamp() where id=$1',[f.linkId]);
  if(change==='expire')await db.admin.query("update web_expose_links set expires_at=clock_timestamp()-interval '1 minute' where id=$1",[f.linkId]);
  if(change==='version')await db.admin.query('update web_expose_versions set active=false where id=$1',[f.versionId]);
  if(change==='wronglead')await db.admin.query('update web_expose_links set intended_lead_id=null where id=$1',[f.linkId]);
  await assert.rejects(sendAutomationMail(session(),input,meta(),options()),/Analytics/);
 }assert.equal(sent.length,before);
});
test('tracking erasure neutralizes the analytics source even when a legitimate mail outcome remains uncertain',async()=>{
 const f=await analyticsFixture(),input=await approved(f);
 await sendAutomationMail(session(),input,meta(),{...options(),transport:async()=>({status:'uncertain',error:'SYNTHETIC lost response'})});
 await assert.rejects(withCrmRead(session(agent),(tx)=>tx.queryOne('select crm_automation_erase_exposure($1::uuid,$2::uuid)',[w,f.sessionId]),options()),/workspace manager/);
 await withCrmRead(session(),(tx)=>tx.queryOne('select crm_automation_erase_exposure($1::uuid,$2::uuid)',[w,f.sessionId]),options());
 const draft=(await db.admin.query('select contact_id,subject,body,status from crm_automation_drafts where id=$1',[f.draftId])).rows[0];assert.deepEqual(draft,{contact_id:null,subject:'Gelöschter Automationsentwurf',body:'',status:'dismissed'});
 const run=(await db.admin.query('select lead_id,automation_id,version,status from crm_automation_enrollments where id=$1',[f.enrollmentId])).rows[0];assert.deepEqual(run,{lead_id:null,automation_id:null,version:null,status:'stopped'});
 assert.equal((await db.admin.query('select status from crm_automation_mail_deliveries where draft_id=$1',[f.draftId])).rows[0].status,'uncertain');
});
test('request messages bind the actual existing secure customer link and recheck revocation before sending',async()=>{
 const f=await fixture({request:true});
 assert.equal((await previewAutomationMail(session(),{draftId:f.draftId,purpose:'salesFollowUp'},options())).canSend,false);
 const prepared=await withCrmRead(session(),(tx,fresh)=>prepareAutomationCustomerRequest(tx,fresh,{draftId:f.draftId,leadId:f.leadId,purpose:'contact_details',language:'en'}),options());
 const preview=await previewAutomationMail(session(),{draftId:f.draftId,purpose:'salesFollowUp'},options());assert.equal(preview.canSend,true);assert.match(preview.body,/https:\/\/public.example.invalid\/request\/[a-zA-Z0-9_-]{43}/);assert.doesNotMatch(preview.body,/\{\{/);
 const input={draftId:f.draftId,purpose:'salesFollowUp',approved:true,approvalDigest:preview.approvalDigest},before=sent.length;
 await sendAutomationMail(session(),input,meta(),options());assert.equal(sent.length,before+1);assert.match(sent.at(-1)!.html,/href="https:\/\/public.example.invalid\/request\//);
 assert.equal((await db.admin.query('select draft_id from lead_customer_requests where id=$1',[prepared.id])).rows[0].draft_id,f.draftId);
 const revoked=await fixture({request:true});await withCrmRead(session(),(tx,fresh)=>prepareAutomationCustomerRequest(tx,fresh,{draftId:revoked.draftId,leadId:revoked.leadId,purpose:'contact_details',language:'en'}),options());const approvedInput=await approved(revoked);
 await withCrmRead(session(),tx=>tx.execute('update lead_customer_requests set revoked_at=clock_timestamp() where workspace_id=$1::uuid and draft_id=$2::uuid',[w,revoked.draftId]),options());
 await assert.rejects(sendAutomationMail(session(),approvedInput,meta(),options()),/widerrufen/);assert.equal(sent.length,before+1);
});
test('a source-bound confirmed viewing cancelled or rescheduled after preview cannot trigger its email',async()=>{
 const before=sent.length;
 for(const state of ['cancelled','planned']){
  const viewingId=randomUUID(),unitId=randomUUID(),f=await fixture({trigger:'appointment_booked',context:{viewingId}});
  await db.admin.query("insert into property_units(id,workspace_id,project_id,unit_number,rooms,area_sqm,price_cents,status) values($1,$2,$3,$4,3,80,100000,'available')",[unitId,w,project,'SYNTHETIC-'+unitId]);
  await db.admin.query("insert into property_viewing_slots(id,workspace_id,project_id,unit_id,contact_id,lead_id,owner_user_id,starts_at,ends_at,status) values($1,$2,$3,$4,$5,$6,$7,now()+interval '1 day',now()+interval '1 day 1 hour','confirmed')",[viewingId,w,project,unitId,f.contactId,f.leadId,owner]);
  const input=await approved(f);await db.admin.query('update property_viewing_slots set status=$2 where id=$1',[viewingId,state]);
  await assert.rejects(sendAutomationMail(session(),input,meta(),options()),/abgesagt oder verschoben/);
 }assert.equal(sent.length,before);
});

test('a source-bound genuine property match invalidated after approval cannot trigger its email',async()=>{
 const propertyId=randomUUID(),unitId=randomUUID();await db.admin.query("insert into property_units(id,workspace_id,project_id,unit_number,rooms,area_sqm,price_cents,status) values($1,$2,$3,$4,3,70,30000000,'available')",[unitId,w,project,'SYNTHETIC-MATCH-'+unitId]);await db.admin.query("insert into seller_listings(id,workspace_id,project_id,unit_id,title,address,region,city,object_type,area_sqm,rooms,target_price_cents,balconies_count,garages_count) values($1,$2,$3,$4,'SYNTHETIC Current match','SYNTHETIC address','Wien','Wien','Wohnung',70,3,30000000,1,0)",[propertyId,w,project,unitId]);
 const f=await fixture({trigger:'new_match',context:async current=>withCrmRead(session(),async(tx,fresh)=>{await saveLeadMatchingProfile(tx,fresh,current.leadId,{countryCode:'AT',location:'Wien',propertyType:'Wohnung',budgetFromCents:20000000,budgetToCents:40000000,areaSqm:50,rooms:2});const state=await readLeadQualificationPlan(fresh,current.leadId,options());await saveLeadQualificationPreferences(tx,fresh,{leadId:current.leadId,profileRevision:state.profileRevision,expectedVersion:state.preferencesVersion,purchaseWindow:{from:'2030-01-01',to:'2030-12-31'},featureRules:{balcony:'must',garage:'exclude'},requirementsReviewed:true});await computeLeadPropertyMatches(tx,fresh,current.leadId);const match=(await getLeadQualification(fresh,current.leadId,options())).matches.find(row=>row.propertyId===propertyId);assert.ok(match?.eligible);return {matchId:match.id};},options())});
 const input=await approved(f),before=sent.length;await db.admin.query('update seller_listings set balconies_count=0,updated_at=clock_timestamp() where id=$1',[propertyId]);await assert.rejects(sendAutomationMail(session(),input,meta(),options()),/Treffer|Kaufzeitfenster/);assert.equal(sent.length,before);
});

test('current contact windows and the interval across distinct flows block actual sending without changing consent',async()=>{
 const first=await fixture(),second=await fixture();
 await db.admin.query('update leads set contact_id=$1 where id=$2',[first.contactId,second.leadId]);
 await db.admin.query('update crm_automation_drafts set contact_id=$1 where id=$2',[first.contactId,second.draftId]);
 await sendAutomationMail(session(),await approved(first),meta(),options());
 const current=await readMarketingContactPolicy(session(),options());
 await saveMarketingContactPolicy(session(),{expectedRevision:current.policy!.revision,rules:{enabled:true,timezone:'Europe/Vienna',days:[0,1,2,3,4,5,6],startMinute:0,endMinute:1440,excludedDates:[],minHours:24}},meta(),options());
 const preview=await previewAutomationMail(session(),{draftId:second.draftId,purpose:'salesFollowUp'},options());
 assert.ok(preview.issues.some(issue=>issue.includes('Mindestabstand')));
 const before=sent.length;
 await assert.rejects(sendAutomationMail(session(),{draftId:second.draftId,purpose:'salesFollowUp',approvalDigest:preview.approvalDigest,approved:true},meta(),options()),/Mindestabstand/);
 assert.equal(sent.length,before);
 assert.equal((await db.admin.query('select consent_label from contacts where id=$1',[first.contactId])).rows[0].consent_label,'Opt-in');
 const after=await readMarketingContactPolicy(session(),options());
 await saveMarketingContactPolicy(session(),{expectedRevision:after.policy!.revision,rules:{...after.policy!.rules,enabled:false}},meta(),options());
});

test('missing current values of required variables block the actual reviewed message',async()=>{
 const f=await fixture();
 await db.admin.query("update contacts set name='' where id=$1",[f.contactId]);
 const preview=await previewAutomationMail(session(),{draftId:f.draftId,purpose:'salesFollowUp'},options());
 assert.ok(preview.issues.includes('Pflichtvariable fehlt: {{contact.name}}'));
 const before=sent.length;
 await assert.rejects(sendAutomationMail(session(),{draftId:f.draftId,purpose:'salesFollowUp',approvalDigest:preview.approvalDigest,approved:true},meta(),options()),/Pflichtvariable/);
 assert.equal(sent.length,before);
});

test('a window closing after claim defers before provider and requires a fresh explicit approval to resume once',async()=>{
 const current=await readMarketingContactPolicy(session(),options());
 await saveMarketingContactPolicy(session(),{expectedRevision:current.policy!.revision,rules:{enabled:true,timezone:'Europe/Vienna',days:[1,2,3,4,5],startMinute:480,endMinute:1140,excludedDates:[],minHours:0}},meta(),options());
 const f=await fixture(),inside=()=>new Date('2026-11-09T10:00:00Z');
 const p=await previewAutomationMail(session(),{draftId:f.draftId,purpose:'salesFollowUp'},{...options(),now:inside});
 assert.deepEqual(p.issues,[]);
 const input={draftId:f.draftId,purpose:'salesFollowUp',approvalDigest:p.approvalDigest,approved:true},firstKey=meta(),before=sent.length;let checks=0;
 const deferred=await sendAutomationMail(session(),input,firstKey,{...options(),now:()=>++checks===1?inside():new Date('2026-11-13T23:00:00Z')});
 assert.equal(deferred.delivery?.status,'deferred');assert.equal(sent.length,before);
 assert.match(deferred.delivery!.error!,/^CONTACT_POLICY_DEFERRED:/);
 const fresh=await previewAutomationMail(session(),{draftId:f.draftId,purpose:'salesFollowUp'},{...options(),now:inside});
 assert.equal(fresh.canSend,true);
 const resumed=await sendAutomationMail(session(),{...input,approvalDigest:fresh.approvalDigest},meta(),{...options(),now:inside});
 assert.equal(resumed.delivery?.id,deferred.delivery?.id);assert.equal(resumed.delivery?.status,'accepted');assert.equal(sent.length,before+1);
 await sendAutomationMail(session(),input,firstKey,{...options(),now:inside});assert.equal(sent.length,before+1);
 const after=await readMarketingContactPolicy(session(),options());await saveMarketingContactPolicy(session(),{expectedRevision:after.policy!.revision,rules:{...after.policy!.rules,enabled:false}},meta(),options());
});

test('queued policy edits and competing sender locks cannot invert policy and original-contact order',async()=>{
 const f=await fixture(),input=await approved(f),current=await readMarketingContactPolicy(session(),options());
 const blocker=await db.admin.connect(),key=`marketing-contact-policy:${w}`;
 let edit:Promise<unknown>|undefined,send:Promise<unknown>|undefined;
 const waitFor=async(count:number)=>{for(let i=0;i<200;i++){if(Number((await db.admin.query("select count(*)::integer as count from pg_locks where locktype='advisory' and not granted")).rows[0].count)>=count)return;await new Promise(resolve=>setTimeout(resolve,10));}throw new Error('Synthetic lock contention was not reached');};
 try{
  await blocker.query('begin');await blocker.query('select pg_advisory_xact_lock_shared(hashtextextended($1,0))',[key]);
  edit=saveMarketingContactPolicy(session(),{expectedRevision:current.policy!.revision,rules:current.policy!.rules},meta(),options());void edit.catch(()=>{});
  await waitFor(1);
  send=sendAutomationMail(session(),input,meta(),options());void send.catch(()=>{});
  await waitFor(2);
  await blocker.query("set local lock_timeout='700ms'");
  assert.equal((await blocker.query('select id from contacts where id=$1 for update',[f.contactId])).rowCount,1);
  await blocker.query('commit');
  await Promise.all([edit,send]);
 }finally{await blocker.query('rollback').catch(()=>{});blocker.release();await Promise.allSettled([edit,send].filter((value):value is Promise<unknown>=>Boolean(value)));}
});

test('historical unsupported variables do not abort other runtime work but cannot be saved anew or sent',async()=>{
 const f=await fixture({legacyVariable:true});
 const old=(await db.admin.query('select graph from crm_automation_versions where automation_id=$1',[f.automationId])).rows[0].graph;
 await assert.rejects(withCrmRead(session(),(tx,fresh)=>saveAutomation(tx,fresh,{projectId:project,name:'SYNTHETIC new invalid template',graph:old}),options()),/Unbekannte Pflichtvariable/);
 await db.admin.query("update crm_automation_enrollments set node_id='start',status='running' where id=$1",[f.enrollmentId]);
 await withCrmRead(session(),(tx,fresh)=>runAutomationDue(tx,fresh,project,25,f.automationId),options());
 assert.equal((await db.admin.query('select status from crm_automation_enrollments where id=$1',[f.enrollmentId])).rows[0].status,'review');
 const preview=await previewAutomationMail(session(),{draftId:f.draftId,purpose:'salesFollowUp'},options());
 assert.ok(preview.issues.some(issue=>issue.includes('legacy.placeholder')));
 const before=sent.length;
 await assert.rejects(sendAutomationMail(session(),{draftId:f.draftId,purpose:'salesFollowUp',approvalDigest:preview.approvalDigest,approved:true},meta(),options()),/Pflichtvariable|Platzhalter/);
 assert.equal(sent.length,before);
});
