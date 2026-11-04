import assert from 'node:assert/strict';
import {createHmac,randomBytes,randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {before,after,test} from 'node:test';
import {verifyResendSignature,verifyResendWebhook,localResendSignatureCheck,readResendWebhookBody,type VerifiedResendEvent,type ProviderDeliveryKind} from '../src/lib/resend-webhooks';
import {recordVerifiedResendEvent,readProviderDeliveryState} from '../src/lib/db/resend-webhook-repository';
import {POST} from '../src/app/api/public/provider-events/resend/route';
import {withCrmRead} from '../src/lib/crm-command';
import type {AppSession} from '../src/lib/auth/session';
import type {TenantPool} from '../src/lib/db/tenant-client';
import {startLocalSalesDb,applySalesSchema} from './lib/local-sales-db.mjs';

const secret='whsec_'+randomBytes(32).toString('base64'),now=Date.now();
function signed(raw:string,id='msg_'+randomUUID().replaceAll('-',''),timestamp=String(Math.floor(now/1000))){return new Headers({'svix-id':id,'svix-timestamp':timestamp,'svix-signature':'v1,'+createHmac('sha256',Buffer.from(secret.slice(6),'base64')).update(`${id}.${timestamp}.${raw}`).digest('base64'),'content-type':'application/json'});}
test('the published Svix vector verifies; changed bytes, stale/future attempts and invalid signatures fail closed',()=>{
 assert.equal(localResendSignatureCheck(),true);const raw='{"event_type":"synthetic"}',headers=signed(raw);assert.ok(verifyResendSignature(raw,headers,secret,now));
 for(const altered of [raw+' ',raw.replace('synthetic','changed')])assert.throws(()=>verifyResendSignature(altered,headers,secret,now));
 for(const timestamp of [String(Math.floor(now/1000)-301),String(Math.floor(now/1000)+301)])assert.throws(()=>verifyResendSignature(raw,signed(raw,undefined,timestamp),secret,now));
 const multiple=new Headers(headers);multiple.set('svix-signature','v1,'+Buffer.alloc(32).toString('base64')+' '+headers.get('svix-signature'));assert.ok(verifyResendSignature(raw,multiple,secret,now));multiple.set('svix-signature','v2,'+headers.get('svix-signature')!.slice(3));assert.throws(()=>verifyResendSignature(raw,multiple,secret,now));assert.throws(()=>verifyResendSignature(raw,headers,'api-key-is-not-a-signing-secret',now));
});
test('body reads are byte bounded and malformed JSON or multi-recipient delivery proofs are rejected',async()=>{
 await assert.rejects(readResendWebhookBody(new Request('https://example.invalid',{method:'POST',body:'x'.repeat(128001)})),/payload_too_large/);
 const raw='not JSON';assert.throws(()=>verifyResendWebhook(raw,signed(raw),{secret,nowMs:now}),/invalid_payload/);
 const multi=JSON.stringify({type:'email.delivered',created_at:new Date(now).toISOString(),data:{email_id:randomUUID(),from:'notify@example.invalid',to:['a@example.invalid','b@example.invalid']}});assert.throws(()=>verifyResendWebhook(multi,signed(multi),{secret,nowMs:now}),/invalid_payload/);
 const analytics=JSON.stringify({type:'email.opened',data:{email_id:randomUUID()}});assert.equal(verifyResendWebhook(analytics,signed(analytics),{secret,nowMs:now}),null);
});

let db:Awaited<ReturnType<typeof startLocalSalesDb>>;
const w=randomUUID(),foreignW=randomUUID(),owner=randomUUID(),foreignOwner=randomUUID(),project=randomUUID(),foreignProject=randomUUID();
const session:AppSession={authenticated:true,workspaceId:w,userId:owner,workspaceName:'SYNTHETIC Provider',name:'SYNTHETIC Owner',email:'owner@example.invalid',role:'owner',productRole:'customer_owner',permissions:[],productPermissions:[],source:'database'};
const options=()=>({pool:db.pool as unknown as TenantPool});
const publicQuery=async(sql:string,params:unknown[])=>(await db.pool.query<{result:unknown}>(sql,params)).rows[0]??null;
type Delivery={id:string;kind:ProviderDeliveryKind;workspace:string;project:string;emailId:string;to:string;from:string};
async function delivery(kind:ProviderDeliveryKind='newsletter',status='accepted',foreign=false):Promise<Delivery>{
 const workspace=foreign?foreignW:w,target=foreign?foreignProject:project,actor=foreign?foreignOwner:owner,id=randomUUID(),emailId=randomUUID(),customer=randomUUID(),campaign=randomUUID(),to=`synthetic-${id}@example.invalid`,from='notify@example.invalid',payload={to,from:`SYNTHETIC <${from}>`,subject:'SYNTHETIC Approved mail',html:'<p>SYNTHETIC</p>'};
 await db.admin.query("insert into contacts(id,workspace_id,project_id,owner_user_id,name,email,role) values($1,$2,$3,$4,'SYNTHETIC Recipient',$5,'Käufer')",[customer,workspace,target,actor,to]);
 if(kind==='automation'){
  const automation=randomUUID(),event=randomUUID(),lead=randomUUID(),run=randomUUID(),draft=randomUUID();const graph={schemaVersion:1,trigger:'new_lead',timezone:'Europe/Vienna',businessHours:false,stopOnPersonalContact:true,nodes:[{id:'start',type:'start',title:'Start'},{id:'mail',type:'email_draft',title:'SYNTHETIC',subject:payload.subject,body:'SYNTHETIC'},{id:'end',type:'stop',title:'End'}],edges:[{from:'start',to:'mail',port:'next'},{from:'mail',to:'end',port:'next'}]};
  await db.admin.query("insert into leads(id,workspace_id,project_id,contact_id,type) values($1,$2,$3,$4,'Käufer')",[lead,workspace,target,customer]);await db.admin.query("insert into crm_automations(id,workspace_id,project_id,name,draft,created_by,status,active_version) values($1,$2,$3,'SYNTHETIC',$4::jsonb,$5,'active',1)",[automation,workspace,target,JSON.stringify(graph),actor]);await db.admin.query('insert into crm_automation_versions(workspace_id,project_id,automation_id,version,graph,graph_digest,created_by) values($1,$2,$3,1,$4::jsonb,$5,$6)',[workspace,target,automation,JSON.stringify(graph),'a'.repeat(64),actor]);await db.admin.query("insert into crm_automation_events(id,workspace_id,project_id,lead_id,event_key,trigger_key) values($1,$2,$3,$4,$5,'new_lead')",[event,workspace,target,lead,randomUUID()]);await db.admin.query("insert into crm_automation_enrollments(id,workspace_id,project_id,automation_id,version,lead_id,event_id,node_id,status) values($1,$2,$3,$4,1,$5,$6,'mail','review')",[run,workspace,target,automation,lead,event]);await db.admin.query("insert into crm_automation_drafts(id,workspace_id,project_id,enrollment_id,node_id,contact_id,subject,body,consent_allowed,consent_reason) values($1,$2,$3,$4,'mail',$5,$6,'SYNTHETIC',true,'SYNTHETIC')",[draft,workspace,target,run,customer,payload.subject]);await db.admin.query('insert into crm_automation_mail_deliveries(id,workspace_id,project_id,draft_id,contact_id,actor_id,purpose,approval_digest,payload,status,provider_message_id) values($1,$2,$3,$4,$5,$6,\'salesFollowUp\',$7,$8::jsonb,$9,$10)',[id,workspace,target,draft,customer,actor,'a'.repeat(64),JSON.stringify(payload),status,status==='claimed'?null:emailId]);
 }else{
  await db.admin.query("insert into newsletter_campaigns(id,workspace_id,project_id,name,subject) values($1,$2,$3,'SYNTHETIC Provider','SYNTHETIC')",[campaign,workspace,target]);
  if(kind==='newsletter_test')await db.admin.query('insert into crm_newsletter_test_sends(id,workspace_id,project_id,campaign_id,revision,actor_id,to_email,input_digest,payload,status,provider_message_id) values($1,$2,$3,$4,1,$5,$6,$7,$8::jsonb,$9,$10)',[id,workspace,target,campaign,actor,to,'a'.repeat(64),JSON.stringify(payload),status,status==='claimed'?null:emailId]);
  else{await db.admin.query("insert into crm_newsletter_versions(workspace_id,project_id,campaign_id,revision,input,content_digest,approved_by) values($1,$2,$3,1,'{}',$4,$5)",[workspace,target,campaign,'a'.repeat(64),actor]);await db.admin.query('insert into crm_newsletter_deliveries(id,workspace_id,project_id,campaign_id,revision,contact_id,to_email,payload,unsubscribe_token_hash,status,provider_message_id) values($1,$2,$3,$4,1,$5,$6,$7::jsonb,$8,$9,$10)',[id,workspace,target,campaign,customer,to,JSON.stringify(payload),randomBytes(32).toString('hex'),status,status==='claimed'?null:emailId]);}
 }
 return{id,kind,workspace,project:target,emailId,to,from};
}
function event(d:Delivery,type='email.delivered',extra:Record<string,unknown>={}){const raw=JSON.stringify({type,created_at:new Date(now).toISOString(),data:{email_id:d.emailId,from:`SYNTHETIC <${d.from}>`,to:[d.to],tags:{novalure_kind:d.kind,novalure_delivery:d.id},...(type==='email.bounced'?{bounce:{type:'Permanent'}}:{}),...extra}});return{raw,headers:signed(raw)};}
function verified(d:Delivery,type='email.delivered',extra:Record<string,unknown>={}):VerifiedResendEvent{const packet=event(d,type,extra);return verifyResendWebhook(packet.raw,packet.headers,{secret,nowMs:now})!;}
before(async()=>{
 db=await startLocalSalesDb();await applySalesSchema(db,{maxMigrationNumber:106});for(const name of ['154_automation_graph.sql','157_newsletter_workspace.sql','165_automation_mail.sql','168_crm_integrations.sql'])await db.admin.query(await readFile('migrations/'+name,'utf8'));
 await db.admin.query("insert into workspaces(id,name,operating_model) values($1,'SYNTHETIC Provider','self_service_customer'),($2,'SYNTHETIC Foreign','self_service_customer')",[w,foreignW]);await db.admin.query("insert into workspace_users(id,workspace_id,name,email,role,product_role,status) values($1,$2,'SYNTHETIC Owner','owner@example.invalid','owner','customer_owner','active'),($3,$4,'SYNTHETIC Foreign','foreign@example.invalid','owner','customer_owner','active')",[owner,w,foreignOwner,foreignW]);await db.admin.query("insert into projects(id,workspace_id,name,type) values($1,$2,'SYNTHETIC Provider','Service'),($3,$4,'SYNTHETIC Foreign','Service')",[project,w,foreignProject,foreignW]);
});
after(async()=>{if(db)await db.stop();});
test('verified events attach only to the exact immutable recipient and sender; client workspace hints do not route them',async()=>{
 const d=await delivery(),foreign=await delivery('newsletter','accepted',true);const valid=verified(d,'email.delivered',{workspace_id:foreignW});assert.equal((await recordVerifiedResendEvent(valid,publicQuery))?.status,'recorded');const row=(await db.admin.query('select workspace_id,delivery_id,event_type from crm_provider_delivery_events where event_key=$1',[valid.eventId])).rows[0];assert.deepEqual(row,{workspace_id:w,delivery_id:d.id,event_type:'email.delivered'});
 for(const extra of [{to:[foreign.to]},{from:'other@example.invalid'},{tags:{novalure_kind:'newsletter',novalure_delivery:foreign.id}}])assert.equal((await recordVerifiedResendEvent(verified(d,'email.bounced',extra),publicQuery))?.status,'ignored');assert.equal((await db.admin.query('select count(*) from newsletter_suppressions')).rows[0].count,'0');
});
test('concurrent signed retries store one event; conflicting bytes under the same message ID cannot alter it',async()=>{
 const d=await delivery(),e=verified(d),results=await Promise.all([recordVerifiedResendEvent(e,publicQuery),recordVerifiedResendEvent(e,publicQuery)]);assert.deepEqual(new Set(results.map(row=>row?.status)),new Set(['recorded','duplicate']));assert.equal((await recordVerifiedResendEvent({...e,digest:'b'.repeat(64),type:'email.bounced'},publicQuery))?.status,'conflict');assert.equal((await db.admin.query('select count(*) from crm_provider_delivery_events where event_key=$1',[e.eventId])).rows[0].count,'1');
});
test('delivered, hard bounce and complaint evidence is ordered safely and suppresses only the matching workspace address',async()=>{
 const d=await delivery();for(const type of ['email.complained','email.sent','email.delivered','email.bounced'])assert.equal((await recordVerifiedResendEvent(verified(d,type),publicQuery))?.status,'recorded');assert.equal(await withCrmRead(session,tx=>readProviderDeliveryState(tx,w,d.id,'newsletter'),options()),'complained');const suppression=(await db.admin.query('select workspace_id,email,reason from newsletter_suppressions where email=$1',[d.to])).rows[0];assert.equal(suppression.workspace_id,w);assert.equal(suppression.reason,'complaint');assert.equal((await db.admin.query('select count(*) from newsletter_suppressions where workspace_id=$1',[foreignW])).rows[0].count,'0');assert.equal((await db.admin.query('select status from crm_newsletter_deliveries where id=$1',[d.id])).rows[0].status,'accepted','provider events do not rewrite the original acceptance evidence');
});
test('an early tagged provider event can confirm a claimed message without dispatching or automatically continuing a flow',async()=>{
 const d=await delivery('automation','claimed');assert.equal((await recordVerifiedResendEvent(verified(d),publicQuery))?.status,'recorded');assert.equal(await withCrmRead(session,tx=>readProviderDeliveryState(tx,w,d.id,'automation'),options()),'delivered');assert.equal((await db.admin.query('select status,provider_message_id from crm_automation_mail_deliveries where id=$1',[d.id])).rows[0].status,'claimed');
 const alternate={...d,emailId:randomUUID()};assert.equal((await recordVerifiedResendEvent(verified(alternate),publicQuery))?.status,'conflict');
});
test('test-mail events are visible as test evidence and cannot add customer suppression or consent',async()=>{
 const d=await delivery('newsletter_test'),before=(await db.admin.query('select count(*) from newsletter_suppressions')).rows[0].count;assert.equal((await recordVerifiedResendEvent(verified(d,'email.bounced'),publicQuery))?.status,'recorded');assert.equal((await db.admin.query('select count(*) from newsletter_suppressions')).rows[0].count,before);assert.equal(await withCrmRead(session,tx=>readProviderDeliveryState(tx,w,d.id,'newsletter_test'),options()),'bounced');
});
test('ambiguous legacy provider IDs are ignored while a valid exact reference remains narrowly attributable',async()=>{
 const d=await delivery(),other=await delivery('newsletter','accepted',true);await db.admin.query('update crm_newsletter_deliveries set provider_message_id=$1 where id=$2',[d.emailId,other.id]);assert.equal((await recordVerifiedResendEvent(verified(d,'email.delivered',{tags:{}}),publicQuery))?.status,'ignored');assert.equal((await recordVerifiedResendEvent(verified(d),publicQuery))?.status,'recorded');assert.equal((await db.admin.query('select count(*) from crm_provider_delivery_events where delivery_id=$1',[other.id])).rows[0].count,'0');
});
test('public signature-verification endpoint does not trust authenticated cookies or unsigned JSON',async()=>{
 const saved=process.env.RESEND_WEBHOOK_SECRET;process.env.RESEND_WEBHOOK_SECRET=secret;
 try{const d=await delivery(),packet=event(d);const bad=new Headers(packet.headers);bad.set('svix-signature','v1,'+Buffer.alloc(32).toString('base64'));bad.set('cookie','novalure_session=synthetic-invalid');assert.equal((await POST(new Request('https://example.invalid/api/public/provider-events/resend',{method:'POST',headers:bad,body:packet.raw}))).status,401);const response=await withCrmRead(session,()=>POST(new Request('https://example.invalid/api/public/provider-events/resend',{method:'POST',headers:packet.headers,body:packet.raw})),options());assert.equal(response.status,200);assert.equal((await response.json()).status,'recorded');}finally{if(saved===undefined)delete process.env.RESEND_WEBHOOK_SECRET;else process.env.RESEND_WEBHOOK_SECRET=saved;}
});
test('the public sink works for non-BYPASS owners under FORCE RLS and the runtime cannot forge table inserts',async()=>{
 const d=await delivery(),ownerRole='qa_provider_event_owner';await db.admin.query(`create role ${ownerRole} nologin nosuperuser nobypassrls nocreatedb nocreaterole noreplication;grant usage,create on schema public to ${ownerRole}`);
 for(const table of ['crm_newsletter_deliveries','crm_newsletter_test_sends','crm_newsletter_versions','crm_automation_mail_deliveries','crm_provider_delivery_events','newsletter_suppressions'])await db.admin.query(`alter table ${table} owner to ${ownerRole}`);
 await db.admin.query(`alter function crm_record_resend_delivery_event(jsonb) owner to ${ownerRole}`);
 assert.equal((await recordVerifiedResendEvent(verified(d,'email.bounced'),publicQuery))?.status,'recorded');assert.equal((await db.admin.query('select reason from newsletter_suppressions where email=$1',[d.to])).rows[0].reason,'bounce');
 await assert.rejects(db.pool.query("insert into crm_provider_delivery_events(workspace_id,provider,event_key,event_digest,delivery_kind,delivery_id,provider_email_id,event_type,occurred_at,data_classification) values($1,'resend','msg_forged_event',$2,'newsletter',$3,$4,'email.delivered',now(),'CUSTOMER_TENANT')",[w,'a'.repeat(64),d.id,d.emailId]),/permission denied/);
 await assert.rejects(db.admin.query("update crm_provider_delivery_events set event_type='email.delivered' where delivery_id=$1",[d.id]),/immutable|not allowed/i);
});
