import assert from 'node:assert/strict';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {after,before,test} from 'node:test';
import type {AppSession} from '../src/lib/auth/session';
import {executeCrmCommand,withCrmRead,type TenantTransaction,type TenantTransactionOptions} from '../src/lib/crm-command';
import {startLocalSalesDb,applySalesSchema} from './lib/local-sales-db.mjs';
import * as repository from '../src/lib/property-booking-repository';
import * as meetings from '../src/lib/db/meeting-repositories';
import * as automation from '../src/lib/automation/repository';
import {createAutomationGraph} from '../src/lib/automation/graph';
let db:Awaited<ReturnType<typeof startLocalSalesDb>>,options:TenantTransactionOptions;
const workspaceId=randomUUID(),projectId=randomUUID(),otherProject=randomUUID(),actorId=randomUUID(),unitId=randomUUID(),otherUnit=randomUUID(),propertyId=randomUUID(),pageId=randomUUID(),contactId=randomUUID(),leadId=randomUUID(),intendedLead=randomUUID(),versionId=randomUUID(),linkId=randomUUID(),token=randomBytes(32).toString('base64url'),tokenHash=createHash('sha256').update(token).digest('hex');
const session:AppSession={authenticated:true,source:'headers',workspaceId,userId:actorId,workspaceName:'Synthetic viewing',name:'Synthetic Owner',email:'viewing@qa.invalid',role:'owner',productRole:'customer_owner',permissions:['crm:read','crm:write'],productPermissions:['pipeline:write','reservations:write']};
const command=<T>(fn:(tx:TenantTransaction,fresh:AppSession)=>Promise<T>)=>executeCrmCommand(session,{operation:'property_booking.qa',projectId,capability:'reservations:write',payload:{},idempotencyKey:randomUUID(),correlationId:randomUUID()},(tx,context)=>fn(tx,context.session),options);
const query=async(sql:string,params:unknown[])=>{const result=await db.pool.query(sql,params);return result.rows[0]??null;};
let offerId:string,context:string,bookingId:string,publicToken:string;
const date=new Date(Date.now()+7*86400000).toISOString().slice(0,10);
const book=(slot:string,propertyContext=context)=>withCrmRead(session,()=>meetings.createMeetingBookingWithNotifications({calendarProvider:'none',meetingProvider:'manual-link',contactName:'Self-reported participant',contactEmail:'participant@qa.invalid',selectedDate:date,slot,slug:'unit-viewing',workspacePublicKey:'synthetic-viewings',requestUrl:'https://qa.invalid/api/meetings/bookings',propertyContext}),options);
before(async()=>{
 db=await startLocalSalesDb();await applySalesSchema(db,{maxMigrationNumber:106});for(const file of['154_automation_graph.sql','155_web_expose.sql','169_property_meeting_context.sql'])await db.admin.query(await readFile(`migrations/${file}`,'utf8'));options={pool:db.pool as unknown as NonNullable<TenantTransactionOptions['pool']>};
 await db.admin.query("insert into workspaces(id,name,public_key,operating_model) values($1,'Synthetic viewing','synthetic-viewings','managed_by_novalure')",[workspaceId]);
 await db.admin.query("insert into workspace_users(id,workspace_id,name,email,role,product_role,status) values($1,$2,'Owner','viewing@qa.invalid','owner','customer_owner','active')",[actorId,workspaceId]);
 await db.admin.query("insert into projects(id,workspace_id,name,type) values($1,$3,'Synthetic viewing project','Makler'),($2,$3,'Other project','Makler')",[projectId,otherProject,workspaceId]);
 await db.admin.query("insert into contacts(id,workspace_id,project_id,name,email,role) values($1,$2,$3,'Actual reviewed buyer','participant@qa.invalid','Käufer')",[contactId,workspaceId,projectId]);
 await db.admin.query("insert into leads(id,workspace_id,project_id,contact_id,assigned_to_user_id,type,intent,status) values($1,$3,$4,$5,$6,'Käufer','Actual qualified buyer','Übergabe'),($2,$3,$4,$5,$6,'Käufer','Intended recipient is not participant','Neu')",[leadId,intendedLead,workspaceId,projectId,contactId,actorId]);
 await db.admin.query("insert into lead_sales_handovers(workspace_id,project_id,lead_id,qualification_version,recipient_user_id,actor_id,source_reference) values($1,$2,$3,1,$4,$4,'Synthetic qualified handover fixture')",[workspaceId,projectId,leadId,actorId]);
 await db.admin.query("insert into property_units(id,workspace_id,project_id,unit_number,area_sqm,rooms,price_cents,status) values($1,$3,$4,'A1',50,2,30000000,'available'),($2,$3,$5,'B1',60,3,40000000,'available')",[unitId,otherUnit,workspaceId,projectId,otherProject]);
 await db.admin.query("insert into seller_listings(id,workspace_id,project_id,unit_id,title,address,region,area_sqm,object_type) values($1,$2,$3,$4,'Synthetic approved property','Synthetic address','Dublin',50,'Wohnung')",[propertyId,workspaceId,projectId,unitId]);
 const calendar={defaultProvider:'none',defaultMeetingProvider:'manual-link',availability:{timeZone:'Europe/Dublin',bufferMinutes:0,minNoticeMinutes:0,durationMinutes:30,intervalMinutes:30,weeklyHours:Array.from({length:7},(_,day)=>({day,start:'09:00',end:'17:00'}))}};
 await db.admin.query("insert into meeting_pages(id,workspace_id,project_id,owner_user_id,slug,title,calendar_integrations,automation) values($1,$2,$3,$4,'unit-viewing','Synthetic viewing',$5::jsonb,'{\"allowCancel\":true,\"allowReschedule\":true,\"confirmationEnabled\":false,\"reminderEnabled\":false,\"cancelDeadlineHours\":0,\"rescheduleDeadlineHours\":0}')",[pageId,workspaceId,projectId,actorId,JSON.stringify(calendar)]);
 await db.admin.query("insert into web_expose_versions(id,workspace_id,property_id,project_id,created_by,language,version,snapshot,source_fingerprint) values($1,$2,$3,$4,$5,'en',1,$6::jsonb,'synthetic-reviewed-snapshot')",[versionId,workspaceId,propertyId,projectId,actorId,JSON.stringify({schemaVersion:1,title:'Synthetic approved property',units:[{id:unitId,number:'A1',status:'available'}]})]);
 await db.admin.query("insert into web_expose_links(id,workspace_id,version_id,token_hash,label,intended_lead_id) values($1,$2,$3,$4,'Synthetic intended link',$5)",[linkId,workspaceId,versionId,tokenHash,intendedLead]);
});
after(async()=>{if(db)await db.stop();});
test('saved offers bind one real property/unit/meeting project; the public projection contains no CRM participant',async()=>{
 const saved=await command((tx,fresh)=>repository.savePropertyBookingOffer(tx,fresh,{propertyId,unitId,meetingPageId:pageId,enabled:true}));offerId=saved.data.id;context=`${token}.${offerId}`;
 const publicOffers=await repository.getPublicPropertyBookingOffers(token,query);assert.equal(publicOffers.length,1);assert.equal(publicOffers[0].unitNumber,'A1');assert.doesNotMatch(JSON.stringify(publicOffers),new RegExp(`${leadId}|${intendedLead}|participant@|Actual reviewed`));
 await assert.rejects(command((tx,fresh)=>repository.savePropertyBookingOffer(tx,fresh,{propertyId,unitId:otherUnit,meetingPageId:pageId,enabled:true})),/same real project|foreign key/);
});
test('real existing booking creation persists unverified context and never associates the intended recipient or sends',async()=>{
 const result=await book('09:00');assert.equal(result.persisted,true);assert.equal(result.autoConfirmed,false);assert.equal(result.confirmationStatus,'awaiting_property_review');assert.equal(result.jobsQueued,0);bookingId=result.bookingId!;publicToken=result.publicActionToken!;assert.ok(publicToken);
 const row=(await db.admin.query('select * from property_meeting_bookings where booking_id=$1',[bookingId])).rows[0];assert.equal(row.lead_id,null);assert.equal(row.viewing_id,null);assert.equal(row.status,'unverified');
 assert.equal((await db.admin.query('select contact_id,status,metadata from meeting_bookings where id=$1',[bookingId])).rows[0].contact_id,null);assert.equal((await db.admin.query('select id from property_viewing_slots')).rowCount,0);assert.equal((await db.admin.query("select id from crm_automation_events where trigger_key='appointment_booked'")).rowCount,0);assert.equal((await db.admin.query('select id from meeting_notification_jobs')).rowCount,0);
 const confirmed=await withCrmRead(session,()=>meetings.confirmMeetingBooking({bookingId,requestUrl:'https://qa.invalid',session}),options);assert.equal(confirmed.ok,false);assert.equal(confirmed.error,'property_review_required');assert.equal((await db.admin.query('select id from calendar_events')).rowCount,0);
});
test('review requires a deliberate participant choice and the existing qualified handover, then atomically confirms a real viewing',async()=>{
 const input={propertyId,bookingId,leadId,ownerUserId:actorId,expectedVersion:1,participantReviewed:true,reason:'Synthetic actual participant checked by personal contact'};
 await assert.rejects(command((tx,fresh)=>repository.confirmPropertyBooking(tx,fresh,{...input,participantReviewed:false})),/Teilnehmer/);
 await assert.rejects(command((tx,fresh)=>repository.confirmPropertyBooking(tx,fresh,{...input,leadId:intendedLead})),/handover/);
 const confirmed=await command((tx,fresh)=>repository.confirmPropertyBooking(tx,fresh,input));assert.equal(confirmed.data.confirmed,true);assert.equal(confirmed.data.providerSync,false);
 const row=(await db.admin.query('select * from property_viewing_slots where id=$1',[confirmed.data.viewingId])).rows[0];assert.equal(row.lead_id,leadId);assert.equal(row.status,'confirmed');assert.equal(row.time_zone,'Europe/Dublin');
 assert.ok(row.calendar_event_id);const calendar=(await db.admin.query('select lead_id,contact_id,status from calendar_events where id=$1',[row.calendar_event_id])).rows[0];assert.equal(calendar.lead_id,leadId);assert.equal(calendar.contact_id,contactId);assert.equal(calendar.status,'bestätigt');
 const event=(await db.admin.query("select context from crm_automation_events where trigger_key='appointment_booked'")).rows[0];assert.equal(event.context.viewingId,confirmed.data.viewingId);
 await assert.rejects(command((tx,fresh)=>repository.confirmPropertyBooking(tx,fresh,input)),/geändert/);
});
test('rescheduling through the actual public management action invalidates the canonical confirmation and requires new staff review',async()=>{
 const jobId=randomUUID(),lease='synthetic-property-notification';await db.admin.query("insert into meeting_notification_jobs(id,workspace_id,meeting_page_id,booking_id,kind,scheduled_for,recipient_email,subject,title,body,status,locked_by,idempotency_key,lease_expires_at) values($1,$2,$3,$4,'reminder',clock_timestamp(),'participant@qa.invalid','Synthetic reminder','Synthetic reminder','Synthetic only','sending',$5,$1::uuid::text,clock_timestamp()+interval '5 minutes')",[jobId,workspaceId,pageId,bookingId,lease]);assert.equal(await withCrmRead(session,()=>meetings.meetingNotificationStillCurrent(jobId,lease),options),true);
 const changed=await withCrmRead(session,()=>meetings.reschedulePublicMeetingBooking({bookingId,token:publicToken,selectedDate:date,slot:'10:00',requestUrl:'https://qa.invalid'}),options);assert.equal(changed.ok,true);
 let state=await repository.getPropertyBookingState(session,propertyId,options),request=state.requests.find(r=>r.bookingId===bookingId)!;assert.equal(request.status,'needs_review');const viewing=(await db.admin.query('select status,starts_at from property_viewing_slots where id=$1',[request.viewingId])).rows[0];assert.equal(viewing.status,'planned');assert.equal(new Date(viewing.starts_at).toISOString(),new Date(request.startsAt).toISOString());
 assert.equal((await db.admin.query('select c.status from calendar_events c join property_viewing_slots v on v.calendar_event_id=c.id where v.id=$1',[request.viewingId])).rows[0].status,'geplant');assert.equal(await withCrmRead(session,()=>meetings.meetingNotificationStillCurrent(jobId,lease),options),false);
 assert.equal(await command((tx)=>automation.automationViewingSignalAllowed(tx,workspaceId,leadId,{viewingId:request.viewingId!})).then(r=>r.data),false);
 await command((tx,fresh)=>repository.confirmPropertyBooking(tx,fresh,{propertyId,bookingId,leadId,ownerUserId:actorId,expectedVersion:request.version,participantReviewed:true,reason:'Synthetic changed appointment checked with actual participant'}));
 state=await repository.getPropertyBookingState(session,propertyId,options);request=state.requests.find(r=>r.bookingId===bookingId)!;assert.equal(request.status,'confirmed');assert.equal((await db.admin.query("select id from crm_automation_events where trigger_key='appointment_booked'")).rowCount,2);
 assert.equal((await db.admin.query('select id from calendar_events where lead_id=$1',[leadId])).rowCount,1);
 const original=(await db.admin.query("select context from crm_automation_events where trigger_key='appointment_booked' order by created_at limit 1")).rows[0].context;assert.equal(await command(tx=>automation.automationViewingSignalAllowed(tx,workspaceId,leadId,original)).then(result=>result.data),false);
});
test('public cancellation updates the same canonical viewing; a durable appointment flow stops before its delayed task',async()=>{
 const graph=createAutomationGraph();graph.trigger='appointment_booked';graph.businessHours=false;graph.nodes.splice(1,0,{id:'wait',type:'wait',title:'Wait',hours:1});graph.edges[0]={from:'start',to:'wait',port:'next'};graph.edges.push({from:'wait',to:'task',port:'next'});
 const saved=await command((tx,fresh)=>automation.saveAutomation(tx,fresh,{projectId,name:'Synthetic viewing follow-up',graph}));await command((tx,fresh)=>automation.setAutomationStatus(tx,fresh,{id:saved.data.id,expectedRevision:1,active:true}));
 const request=(await repository.getPropertyBookingState(session,propertyId,options)).requests.find(r=>r.bookingId===bookingId)!;
 await command(tx=>automation.recordAutomationEvent(tx,{workspaceId,projectId,leadId,eventId:randomUUID(),trigger:'appointment_booked',context:{unitId,viewingId:request.viewingId!}}));await command((tx,fresh)=>automation.runAutomationDue(tx,fresh,projectId,20,saved.data.id));
 const cancelled=await withCrmRead(session,()=>meetings.cancelPublicMeetingBooking({bookingId,token:publicToken,reason:'Synthetic participant cancellation',requestUrl:'https://qa.invalid'}),options);assert.equal(cancelled.ok,true);assert.equal((await repository.getPropertyBookingState(session,propertyId,options)).requests.find(r=>r.bookingId===bookingId)?.status,'cancelled');assert.equal((await db.admin.query('select status from property_viewing_slots where id=$1',[request.viewingId])).rows[0].status,'cancelled');
 const{listCalendarEventRecords}=await import('../src/lib/db/crm-write-repositories');const calendar=await withCrmRead(session,()=>listCalendarEventRecords({session,leadId}),options);assert.equal(calendar.persisted&&calendar.events[0].status,'abgesagt');
 await db.admin.query("update crm_automation_enrollments set due_at=clock_timestamp()-interval '1 minute' where automation_id=$1",[saved.data.id]);const tick=await command((tx,fresh)=>automation.runAutomationDue(tx,fresh,projectId,20,saved.data.id));assert.equal(tick.data.outcomes[0].reason,'viewing_changed');assert.equal((await db.admin.query("select id from tasks where metadata->>'automationId'=$1",[saved.data.id])).rowCount,0);
 await assert.rejects(command((tx,fresh)=>repository.confirmPropertyBooking(tx,fresh,{propertyId,bookingId,leadId,ownerUserId:actorId,expectedVersion:4,participantReviewed:true,reason:'Synthetic cancellation cannot be reversed'})),/abgesagt/);
});
test('the personal management projection resolves a real linked calendar receipt without trusting browser provider IDs',async()=>{
 const calendar=(await db.admin.query('select v.calendar_event_id from property_meeting_bookings a join property_viewing_slots v on v.id=a.viewing_id and v.workspace_id=a.workspace_id where a.booking_id=$1',[bookingId])).rows[0].calendar_event_id;
 await db.admin.query("insert into calendar_sync_events(workspace_id,calendar_event_id,provider,provider_event_id,operation,status,payload) values($1,$2,'google-workspace','synthetic-provider-record-no-network-call','create_event','synced','{}')",[workspaceId,calendar]);
 const projected=(await query('select crm_property_booking_action_lookup($1::uuid,$2) as result',[bookingId,publicToken]))?.result as{calendarProvider:string;metadata:{externalCalendarId:string}};assert.equal(projected.calendarProvider,'google');assert.equal(projected.metadata.externalCalendarId,'synthetic-provider-record-no-network-call');
 assert.equal((await query('select crm_property_booking_action_lookup($1::uuid,$2) as result',[bookingId,randomUUID()]))?.result,null);
});
test('anonymous capability access creates only its offered request and cannot call staff readers or forge slot hours',async()=>{
 await assert.rejects(db.pool.query('select crm_property_booking_staff_state($1,$2)',[workspaceId,propertyId]),error=>!!error&&typeof error==='object'&&'code'in error&&error.code==='42501');
 const create=(slot:string,duration=30,offer:string|null=offerId)=>{const start=new Date(`${date}T${slot}:00Z`);return db.pool.query('select crm_property_booking_create($1,$2::uuid,$3,$4,$5,$6::timestamptz,$7::timestamptz,$8::uuid) as result',[tokenHash,offer,'Anonymous self report','anonymous@qa.invalid','',start.toISOString(),new Date(start.valueOf()+duration*60000).toISOString(),randomUUID()]);};
 await assert.rejects(create('08:00'),/weekly hours/);await assert.rejects(create('12:00',60),/duration/);await assert.rejects(create('12:00',30,null),/unavailable/);
 const saved=(await create('12:00')).rows[0].result,association=(await db.admin.query('select lead_id,status from property_meeting_bookings where booking_id=$1',[saved.id])).rows[0];assert.equal(association.lead_id,null);assert.equal(association.status,'unverified');
 const settings=await db.pool.query("select current_setting('app.tenant_id',true) tenant,current_setting('app.actor_id',true) actor");for(const value of Object.values(settings.rows[0]))assert.ok(value===null||value==='');
});
test('concurrent anonymous requests for the same actual unit and page reserve one tentative slot',async()=>{
 const start=`${date}T13:00:00Z`,end=`${date}T13:30:00Z`;
 const create=()=>db.pool.query('select crm_property_booking_create($1,$2::uuid,$3,$4,$5,$6::timestamptz,$7::timestamptz,$8::uuid)',[tokenHash,offerId,'Concurrent synthetic','concurrent@qa.invalid','',start,end,randomUUID()]);
 const result=await Promise.allSettled([create(),create()]);assert.equal(result.filter(r=>r.status==='fulfilled').length,1);assert.equal((await db.admin.query('select id from meeting_bookings where workspace_id=$1 and starts_at=$2::timestamptz',[workspaceId,start])).rowCount,1);
});
test('a failed canonical automation event rolls staff confirmation and its new viewing back together',async()=>{
 const saved=await book('11:00');assert.ok(saved.persisted);const id=saved.bookingId!;
 await db.admin.query("create function qa_property_event_failure() returns trigger language plpgsql as $$ begin if new.trigger_key='appointment_booked' then raise exception 'synthetic source event failure';end if;return new;end $$;create trigger qa_property_event_failure before insert on crm_automation_events for each row execute function qa_property_event_failure()");
 await assert.rejects(command((tx,fresh)=>repository.confirmPropertyBooking(tx,fresh,{propertyId,bookingId:id,leadId,ownerUserId:actorId,expectedVersion:1,participantReviewed:true,reason:'Synthetic source transaction must stay atomic'})),/source event failure/);
 const association=(await db.admin.query('select status,viewing_id from property_meeting_bookings where booking_id=$1',[id])).rows[0];assert.equal(association.status,'unverified');assert.equal(association.viewing_id,null);assert.equal((await db.admin.query('select id from property_viewing_slots where starts_at=(select starts_at from meeting_bookings where id=$1)',[id])).rowCount,0);
 await db.admin.query('drop trigger qa_property_event_failure on crm_automation_events;drop function qa_property_event_failure()');
});
test('current source availability, published membership, revoked link and a changed offer close the booking capability',async()=>{
 const unpublished=randomUUID();await db.admin.query("insert into property_units(id,workspace_id,project_id,unit_number,area_sqm,price_cents,status,metadata) values($1,$2,$3,'Unpublished',40,20000000,'available',jsonb_build_object('sellerListingId',$4::text))",[unpublished,workspaceId,projectId,propertyId]);await command((tx,fresh)=>repository.savePropertyBookingOffer(tx,fresh,{propertyId,unitId:unpublished,meetingPageId:pageId,enabled:true}));assert.equal((await repository.getPublicPropertyBookingOffers(token,query)).length,1);
 await db.admin.query("update property_units set status='sold' where id=$1",[unitId]);assert.deepEqual(await repository.getPublicPropertyBookingOffers(token,query),[]);await db.admin.query("update property_units set status='available' where id=$1",[unitId]);
 await command(async tx=>{await tx.execute('update web_expose_links set revoked_at=clock_timestamp() where workspace_id=$1::uuid and id=$2::uuid',[workspaceId,linkId]);return{revoked:true};});assert.deepEqual(await repository.getPublicPropertyBookingOffers(token,query),[]);const refused=await book('11:00');assert.equal(refused.persisted,false);assert.equal(refused.reason,'property_context_unavailable');
});
test('all three public booking POST routes keep the trusted-origin boundary through reverse-proxy rewriting',async()=>{
 const original=process.env.NOVALURE_APP_ORIGIN;process.env.NOVALURE_APP_ORIGIN='http://127.0.0.1:58452';
 try{const routes=[await import('../src/app/api/meetings/bookings/route'),await import('../src/app/api/meetings/bookings/[bookingId]/cancel/route'),await import('../src/app/api/meetings/bookings/[bookingId]/reschedule/route')];
  for(const route of routes){const context={params:Promise.resolve({bookingId:randomUUID()})};
   for(const headers of[{}, {origin:'https://other.invalid'},{origin:'http://127.0.0.1:58452','sec-fetch-site':'cross-site'}] as Record<string,string>[]){const rejected=await route.POST(new Request('http://localhost:58452/api/meetings/bookings',{method:'POST',headers,body:'{}'}),context);assert.equal(rejected.status,403);}
   const accepted=await route.POST(new Request('http://localhost:58452/api/meetings/bookings',{method:'POST',headers:{origin:'http://127.0.0.1:58452','Content-Type':'application/json'},body:'{}'}),context);assert.notEqual(accepted.status,403);
  }
 }finally{if(original===undefined)delete process.env.NOVALURE_APP_ORIGIN;else process.env.NOVALURE_APP_ORIGIN=original;}
});
