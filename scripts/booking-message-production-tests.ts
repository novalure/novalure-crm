import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { AppSession } from "../src/lib/auth/session";
import { getRolePermissions } from "../src/lib/auth/permissions";
import { getProductRoleCapabilities } from "../src/lib/product-model";
import { withTenantTransaction, type TenantPool } from "../src/lib/db/tenant-client";
import { defaultBookingRules } from "../src/lib/booking/rules";
import { defaultBookingCommunication } from "../src/lib/booking/templates";
import { bookingResourceLock, readBooking } from "../src/lib/booking/repository";
import { processDueBookingMessages, queueBookingTestMessage, syncBookingMessages } from "../src/lib/booking/messages";
import { canRunBookingReminderWhilePaused, isBookingMessageRuntime, isBookingReminderRuntime } from "../src/lib/booking/message-runtime";
import { recordBookingMailProviderEvent } from "../src/lib/booking/message-webhooks";
import { createBookingActionLinks, readBookingAction } from "../src/lib/booking/message-actions";
import { canReadLegacyMeetingReminderQueue, claimMeetingReminderAdmission, completeMeetingReminderAdmission, meetingReminderBucket } from "../src/lib/meetings/reminder-admission";
import { startDesignCIntegrationDatabase } from "./lib/design-c-integration-fixture.mjs";

/** Disposable local PostgreSQL only. Provider transport is simulated; these are
 * activation/race proofs, never live delivery or scheduler evidence. */
test("production message activation and durable legacy scheduler admission", { timeout: 240_000 }, async t => {
  const names = ["NODE_ENV","VERCEL_ENV","BOOKING_ENGINE_ENABLED","BOOKING_PRODUCTION_ENABLED","BOOKING_PRODUCTION_ACTIVATION_ID","BOOKING_PRODUCTION_ACTIVATED_AT","BOOKING_TEST_BINDINGS_JSON","BOOKING_MAIL_TEST_BINDINGS_JSON","BOOKING_MESSAGES_ENABLED","BOOKING_REMINDERS_ENABLED","NOVALURE_SESSION_SECRET","NOVALURE_APP_ORIGIN","GOOGLE_CLIENT_ID","GOOGLE_CLIENT_SECRET","BOOKING_GOOGLE_OAUTH_STATUS"];
  const saved = Object.fromEntries(names.map(name => [name, process.env[name]]));
  const db = await startDesignCIntegrationDatabase();
  const options = { pool: db.pool as unknown as TenantPool };
  const a = { workspaceId: randomUUID(), userId: randomUUID(), connectionId: randomUUID(), activationId: randomUUID() };
  const scope = { workspaceId: a.workspaceId, actorId: a.userId };
  const session: AppSession = { authenticated:true,source:"database",workspaceId:a.workspaceId,userId:a.userId,workspaceName:"Local rehearsal company",name:"Local organizer",email:`local-${a.userId}@novalure.eu`,role:"owner",productRole:"customer_owner",permissions:getRolePermissions("owner"),productPermissions:getProductRoleCapabilities("customer_owner"),workspaceCustomerType:"general_company",workspaceOperatingModel:"self_service_customer" };
  const now = Math.floor(Date.now()/1000)*1000, activatedAt = new Date(now-60_000).toISOString();
  const accountId=`local-account-${a.workspaceId}`, calendarId=`local-calendar-${a.workspaceId}`;
  const inScope = <T>(fn: Parameters<typeof withTenantTransaction<T>>[1]) => withTenantTransaction(scope,fn,options);
  const rows = async(id:string) => (await db.admin.query("select id,status,kind,provider_message_id,event_ids from booking_message_jobs where booking_id=$1 order by scheduled_for,id",[id])).rows;
  const send = async() => ({ outcome:"accepted" as const,messageId:`local-${randomUUID()}` });
  const seed = async(input:{createdAt?:string;scheduledAgo?:number;recipient?:string}={}) => {
    const id=randomUUID(), start=new Date(now+3*3_600_000).toISOString(),end=new Date(now+3*3_600_000+30*60_000).toISOString();
    await db.admin.query(`insert into booking_reservations(id,workspace_id,organizer_id,provider,kind,connection_id,connection_revision,calendar_id,title,starts_at,ends_at,blocked_starts_at,blocked_ends_at,state,expires_at,rules,request_hash,idempotency_key,recipient_email,recipient_name,communication_language,created_at)
      values($1,$2,$3,'google','phone',$4,1,$5,'Local rehearsal booking',$6,$7,$6,$7,'confirmed',$8,$9,'LOCAL-HASH',$10,$12,'Local recipient','en',$11)`,[id,a.workspaceId,a.userId,a.connectionId,calendarId,start,end,new Date(now+60_000).toISOString(),JSON.stringify(defaultBookingRules),randomUUID(),input.createdAt??new Date(now).toISOString(),input.recipient??"recipient@novalure.eu"]);
    await inScope(async tx=>{await bookingResourceLock(tx,session);const row=await readBooking(tx,session,id);await syncBookingMessages(tx,session,row,row,now-(input.scheduledAgo??0));});
    return id;
  };
  const reset = async() => {await db.admin.query("delete from booking_message_jobs");await db.admin.query("update booking_calendar_connections set status='connected',revision=1 where id=$1",[a.connectionId]);await db.admin.query("update booking_production_activations set status='active',capabilities=array['booking','messages'] where activation_id=$1",[a.activationId]);};
  try {
    const client=await db.admin.connect();
    try {await client.query("begin");for(const name of ["108_universal_booking.sql","109_booking_setup_communications.sql","112_booking_production_activation.sql","113_meeting_reminder_admission.sql"]){const sql=await readFile(`migrations/${name}`,"utf8");await client.query(sql);await client.query("insert into novalure_schema_migrations(version,name,checksum) values($1,$2,$3)",[name.slice(0,-4),name,createHash("sha256").update(sql.replace(/\r\n/g,"\n")).digest("hex")]);}await client.query("commit");}catch(error){await client.query("rollback");throw error;}finally{client.release();}
    Object.assign(process.env,{NODE_ENV:"test",VERCEL_ENV:"production",BOOKING_ENGINE_ENABLED:"1",BOOKING_PRODUCTION_ENABLED:"1",BOOKING_PRODUCTION_ACTIVATION_ID:a.activationId,BOOKING_PRODUCTION_ACTIVATED_AT:activatedAt,BOOKING_MESSAGES_ENABLED:"1",BOOKING_REMINDERS_ENABLED:"1",NOVALURE_SESSION_SECRET:"local-only-signing-material-".repeat(3),NOVALURE_APP_ORIGIN:"https://booking.novalure.eu",GOOGLE_CLIENT_ID:"local-client",GOOGLE_CLIENT_SECRET:"local-not-a-provider-secret",BOOKING_GOOGLE_OAUTH_STATUS:"testing"});
    delete process.env.BOOKING_TEST_BINDINGS_JSON;delete process.env.BOOKING_MAIL_TEST_BINDINGS_JSON;
    await db.admin.query("insert into workspaces(id,name,operating_model,customer_type,is_qa) values($1,'Local rehearsal company','self_service_customer','general_company',false)",[a.workspaceId]);
    const identity=await db.admin.query("insert into workspace_users(id,workspace_id,name,email,role,product_role,status) values($1,$2,'Local organizer',$3,'owner','customer_owner','active') returning auth_identity_id",[a.userId,a.workspaceId,session.email]);
    await db.admin.query("update auth_identities set credential_state='active' where id=$1",[identity.rows[0].auth_identity_id]);
    await db.admin.query("insert into workspace_module_settings(workspace_id,module_key,enabled) values($1,'calendar',true)",[a.workspaceId]);
    await db.admin.query(`insert into booking_calendar_connections(id,workspace_id,user_id,provider,status,account_id,account_label,encrypted_tokens,scopes,calendars,write_calendar_id)
      values($1,$2,$3,'google','connected',$4,'Local account','b1.local-nonfunctional-token',array['https://www.googleapis.com/auth/calendar.events'],$5,$6)`,[a.connectionId,a.workspaceId,a.userId,accountId,JSON.stringify([{id:calendarId,name:"Local calendar",canRead:true,canWrite:true,protectedReadOnly:false}]),calendarId]);
    await db.admin.query("select booking_admin_activate_production($1,$2,$3,'google',$4,$5,$6,$7,array['booking','messages'],$8,'internal','Local isolated rehearsal')",[a.activationId,a.workspaceId,a.userId,a.connectionId,accountId,calendarId,process.env.NOVALURE_APP_ORIGIN,activatedAt]);
    await db.admin.query("insert into booking_setup_sets(workspace_id,user_id,kind,communication) values($1,$2,'*',$3)",[a.workspaceId,a.userId,JSON.stringify({...structuredClone(defaultBookingCommunication),enabled:true,companyName:"Local company",reminders:[]})]);
    await t.test("production explicitly rejects any QA binding and requires its own worker switch",async()=>{
      assert.equal(isBookingMessageRuntime(),true);assert.equal(isBookingReminderRuntime(),true);assert.equal(canRunBookingReminderWhilePaused(),true);
      process.env.BOOKING_MAIL_TEST_BINDINGS_JSON="[]";assert.equal(isBookingMessageRuntime(),false);delete process.env.BOOKING_MAIL_TEST_BINDINGS_JSON;
      process.env.BOOKING_REMINDERS_ENABLED="0";assert.equal(isBookingReminderRuntime(),false);assert.equal(canRunBookingReminderWhilePaused(),false);assert.equal(isBookingMessageRuntime(),true);process.env.BOOKING_REMINDERS_ENABLED="1";
    });
    await t.test("only a new activated booking can send; replay is once and signed GET is read-only",async()=>{
      await reset();const id=await seed();let calls=0;const delivery=async()=>{calls++;return send();};
      const before=await inScope(tx=>readBooking(tx,session,id));const token=new URL(createBookingActionLinks(before,now).cancelUrl).pathname.split("/").at(-1)!;
      assert.equal((await readBookingAction(token,options)).row.state,"confirmed");assert.equal((await rows(id)).length,1);
      const result=await processDueBookingMessages({...options,now:()=>now,send:delivery});assert.equal(result.accepted,1);await processDueBookingMessages({...options,now:()=>now+60_000,send:delivery});assert.equal(calls,1);
      const job=(await rows(id))[0];const event={eventId:"local-delivered",messageId:job.provider_message_id,jobId:job.id,type:"email.delivered" as const,occurredAt:new Date(now+2000).toISOString()};
      await recordBookingMailProviderEvent(event,options);await recordBookingMailProviderEvent(event,options);await recordBookingMailProviderEvent({...event,eventId:"local-late-sent",type:"email.sent",occurredAt:new Date(now+3000).toISOString()},options);
      assert.equal((await rows(id))[0].status,"delivered");assert.equal((await rows(id))[0].event_ids.length,2);
    });
    await t.test("activation does not adopt older bookings, old jobs, or overdue initial sends",async()=>{
      await reset();const old=await seed({createdAt:new Date(now-120_000).toISOString()});assert.equal((await rows(old)).length,0);
      const oldJob=await seed();await db.admin.query("update booking_message_jobs set created_at=$2 where booking_id=$1",[oldJob,new Date(now-120_000).toISOString()]);
      const late=await seed({scheduledAgo:6*60_000});let calls=0;await processDueBookingMessages({...options,now:()=>now,send:async()=>{calls++;return send();}});assert.equal(calls,0);assert.equal((await rows(oldJob))[0].status,"cancelled");assert.equal((await rows(late))[0].status,"skipped");
    });
    await t.test("production template tests use only the organizer's own booking recipient and deduplicate",async()=>{
      await reset();const id=await seed({recipient:session.email});
      const first=await queueBookingTestMessage(session,{bookingId:id,kind:"confirmation",language:"en"},options);
      const replay=await queueBookingTestMessage(session,{bookingId:id,kind:"confirmation",language:"en"},options);assert.equal(first.jobId,replay.jobId);
      let calls=0;await processDueBookingMessages({...options,now:()=>now+10_000,send:async()=>{calls++;return send();}});assert.equal(calls,2);assert.equal((await rows(id)).filter(row=>row.kind==="test"&&row.status==="accepted").length,1);
      const other=await seed();await assert.rejects(queueBookingTestMessage(session,{bookingId:other,kind:"confirmation"},options),(error:unknown)=>(error as {code?:string}).code==="MAIL_TEST_RECIPIENT_NOT_ALLOWED");
    });
    await t.test("current connection revision and communication snapshots are checked at dispatch",async()=>{
      await reset();const id=await seed();await db.admin.query("update booking_calendar_connections set revision=2 where id=$1",[a.connectionId]);let calls=0;
      await processDueBookingMessages({...options,now:()=>now,send:async()=>{calls++;return send();}});assert.equal(calls,0);assert.equal((await rows(id))[0].status,"cancelled");
      await reset();const changed=await seed();await db.admin.query("update booking_reservations set recipient_email='changed@novalure.eu',communication_language='de' where id=$1",[changed]);await processDueBookingMessages({...options,now:()=>now,send:async()=>{calls++;return send();}});assert.equal(calls,0);assert.equal((await rows(changed))[0].status,"cancelled");
    });
    await t.test("normal token refresh preserves a future reminder; account and calendar changes block dispatch",async()=>{
      await reset();
      await db.admin.query("update booking_setup_sets set communication=jsonb_set(communication,'{reminders}',$1::jsonb)",[JSON.stringify([{id:"one-hour",minutesBefore:60,template:"reminder",enabled:true}])]);
      const id=await seed();await processDueBookingMessages({...options,now:()=>now,send});
      // Exactly the field set used by usableToken's successful refresh: binding
      // revision is unchanged because neither account nor writer changed.
      await db.admin.query("update booking_calendar_connections set encrypted_tokens='b1.local-rotated-nonfunctional-token',expires_at=$2,scopes=array['https://www.googleapis.com/auth/calendar.events'],error_code=null,updated_at=now() where id=$1",[a.connectionId,new Date(now+4*3_600_000).toISOString()]);
      const refreshed=await processDueBookingMessages({...options,now:()=>now+2*3_600_000,send});assert.equal(refreshed.accepted,1);assert.equal((await rows(id)).find(row=>row.kind==="reminder")?.status,"accepted");
      await reset();const changed=await seed();await db.admin.query("update booking_calendar_connections set account_id=account_id||'-changed' where id=$1",[a.connectionId]);let calls=0;
      await processDueBookingMessages({...options,now:()=>now,send:async()=>{calls++;return send();}});assert.equal(calls,0);assert.equal((await rows(changed))[0].status,"planned");
      await db.admin.query("update booking_calendar_connections set account_id=$2,write_calendar_id=$3 where id=$1",[a.connectionId,accountId,calendarId+"-changed"]);
      await processDueBookingMessages({...options,now:()=>now,send:async()=>{calls++;return send();}});assert.equal(calls,0);
      await db.admin.query("update booking_calendar_connections set write_calendar_id=$2 where id=$1",[a.connectionId,calendarId]);
      await db.admin.query("update booking_setup_sets set communication=jsonb_set(communication,'{reminders}','[]'::jsonb)");
    });
    await t.test("revocation and disconnect stop the worker without reading foreign queues",async()=>{
      await reset();const id=await seed();await db.admin.query("update booking_production_activations set status='revoked' where activation_id=$1",[a.activationId]);let calls=0;
      const result=await processDueBookingMessages({...options,now:()=>now,send:async()=>{calls++;return send();}});assert.equal(result.checked,0);assert.equal(calls,0);assert.equal((await rows(id))[0].status,"planned");
      await reset();await seed();await db.admin.query("update booking_calendar_connections set status='disconnected' where id=$1",[a.connectionId]);assert.equal((await processDueBookingMessages({...options,now:()=>now,send})).checked,0);
    });
    await t.test("legacy hourly admission accepts a delayed tick and retries exactly the same bounded IDs",async()=>{
      assert.equal(meetingReminderBucket(Date.parse("2026-10-22T10:03:00Z")),Date.parse("2026-10-22T10:02:00Z"));
      assert.equal(meetingReminderBucket(Date.parse("2026-10-22T10:01:00Z")),Date.parse("2026-10-22T09:02:00Z"));
      // Production legacy queues can intentionally remain globally paused; this
      // local admission test injects only a disposable SQL transport.
      const runtimeQuery=async <T extends Record<string,unknown>>(sql:string,params:unknown[]=[]) => (await db.pool.query(sql,params)).rows as T[];
      assert.equal(await canReadLegacyMeetingReminderQueue({query:runtimeQuery}),false);
      assert.equal(await claimMeetingReminderAdmission({now,query:runtimeQuery}),null);
      // A pre-existing separately authorized legacy worker can use its existing
      // SQL transport. No broader grant is added to the application role.
      const query=async <T extends Record<string,unknown>>(sql:string,params:unknown[]=[]) => (await db.admin.query(sql,params)).rows as T[];
      for(let index=0;index<30;index++) await db.admin.query("insert into meeting_notification_jobs(workspace_id,kind,scheduled_for,available_at,recipient_email,subject,title,body,idempotency_key) values($1,'reminder','2026-10-22T08:00:00Z','2026-10-22T08:00:00Z','local@novalure.eu','Local','Local','Local',$2)",[a.workspaceId,randomUUID()]);
      const tick=Date.parse("2026-10-22T10:03:00Z");
      const attempts=await Promise.all([claimMeetingReminderAdmission({now:tick,query}),claimMeetingReminderAdmission({now:tick,query})]);
      const admission=attempts.find(Boolean)!;assert(admission);assert.equal(attempts.filter(Boolean).length,1);assert.equal(admission.jobIds.length,25);
      await db.admin.query("insert into meeting_notification_jobs(workspace_id,kind,scheduled_for,available_at,recipient_email,subject,title,body,idempotency_key) values($1,'reminder','2026-10-22T07:00:00Z','2026-10-22T07:00:00Z','local@novalure.eu','Later inserted','Local','Local',$2)",[a.workspaceId,randomUUID()]);
      assert.equal(await claimMeetingReminderAdmission({now:tick+60_000,query}),null);
      const retry=await claimMeetingReminderAdmission({now:tick+91_000,query});assert(retry);assert.deepEqual(retry.jobIds,admission.jobIds);
      await completeMeetingReminderAdmission(admission,{now:tick+92_000,query});assert.equal(await claimMeetingReminderAdmission({now:tick+93_000,query}),null);
      await completeMeetingReminderAdmission(retry,{now:tick+94_000,query});assert.equal(await claimMeetingReminderAdmission({now:tick+200_000,query}),null);
      assert(await claimMeetingReminderAdmission({now:tick+3_600_000,query}));
      await assert.rejects(db.pool.query("insert into meeting_reminder_admission(worker_key,bucket_at,job_ids) values('arbitrary-worker',now(),'{}')"));
      await assert.rejects(db.pool.query("delete from meeting_reminder_admission"));
    });
  } finally {await db.stop();for(const name of names){if(saved[name]===undefined)delete process.env[name];else process.env[name]=saved[name];}}
});
