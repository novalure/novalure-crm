import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import type { AppSession } from "../src/lib/auth/session";
import { getRolePermissions } from "../src/lib/auth/permissions";
import { getProductRoleCapabilities } from "../src/lib/product-model";
import { withTenantTransaction, type TenantPool, type TenantTransactionOptions } from "../src/lib/db/tenant-client";
import { bookingResourceLock, readBooking } from "../src/lib/booking/repository";
import { defaultBookingRules } from "../src/lib/booking/rules";
import { defaultBookingCommunication } from "../src/lib/booking/templates";
import { saveBookingSetup } from "../src/lib/booking/configuration";
import { processDueBookingMessages, syncBookingMessages } from "../src/lib/booking/messages";
import { recordBookingMailProviderEvent } from "../src/lib/booking/message-webhooks";
import { createBookingActionLinks, readBookingAction } from "../src/lib/booking/message-actions";
import type { TransactionalEmailResult } from "../src/lib/integrations/resend";
import { startDesignCIntegrationDatabase } from "./lib/design-c-integration-fixture.mjs";

/** Actual isolated PostgreSQL/RLS and durable workers; mail transport is simulated.
 * These checks are not real sending, delivery, or hosted scheduler evidence. */
test("Auftrag 2 durable versioned messages and reminder race boundaries", { timeout: 240_000 }, async t => {
  const envNames = ["NODE_ENV", "VERCEL_ENV", "BOOKING_MESSAGES_ENABLED", "BOOKING_MAIL_TEST_BINDINGS_JSON", "NOVALURE_SESSION_SECRET", "NOVALURE_APP_ORIGIN"];
  const previousEnv = Object.fromEntries(envNames.map(name => [name, process.env[name]]));
  Object.assign(process.env, { NODE_ENV:"test", VERCEL_ENV:"preview", BOOKING_MESSAGES_ENABLED:"1", NOVALURE_SESSION_SECRET:randomBytes(40).toString("hex"), NOVALURE_APP_ORIGIN:"https://booking-qa.example.invalid" });
  const db = await startDesignCIntegrationDatabase();
  const options: TenantTransactionOptions = {pool:db.pool as unknown as TenantPool};
  const now = Math.floor(Date.now()/1000)*1000;
  const a = {workspaceId:randomUUID(),userId:randomUUID(),connectionId:randomUUID()};
  const b = {workspaceId:randomUUID(),userId:randomUUID(),connectionId:randomUUID()};
  const session = (identity:typeof a):AppSession => ({authenticated:true,source:"database",workspaceId:identity.workspaceId,userId:identity.userId,workspaceName:"SYNTHETIC message QA",name:"Synthetic organizer",email:`${identity.userId}@example.invalid`,role:"owner",productRole:"customer_owner",permissions:getRolePermissions("owner"),productPermissions:getProductRoleCapabilities("customer_owner"),workspaceCustomerType:"general_company",workspaceOperatingModel:"self_service_customer"});
  const owner=session(a), foreign=session(b), scope={workspaceId:a.workspaceId,actorId:a.userId};
  const withOwner=<T>(callback:Parameters<typeof withTenantTransaction<T>>[1])=>withTenantTransaction(scope,callback,options);
  const jobs=async(id:string)=>(await db.admin.query("select id,booking_version,kind,template_kind,language,scheduled_for,status,recipient_email,provider_message_id,attempt_count,event_ids,next_attempt_at from booking_message_jobs where booking_id=$1 order by booking_version,scheduled_for,id",[id])).rows;
  const config=async()=>saveBookingSetup(owner,{scope:"employee",kind:"*",section:"communication",value:{...structuredClone(defaultBookingCommunication),enabled:true,companyName:"SYNTHETIC company",replyTo:"synthetic-reply@example.invalid",reminders:[{id:"two-hours",minutesBefore:120,template:"reminder",enabled:true},{id:"one-hour",minutesBefore:60,template:"reminder",enabled:true}]}},options);
  const sendAccepted=async():Promise<TransactionalEmailResult>=>({outcome:"accepted",messageId:`synthetic-${randomUUID()}`});
  const seedBooking=async(input:{minutesUntilStart?:number;recipient?:string;language?:"de"|"en"}={})=>{
    const id=randomUUID(),start=new Date(now+(input.minutesUntilStart??180)*60_000).toISOString(),end=new Date(Date.parse(start)+30*60_000).toISOString();
    const rules={...structuredClone(defaultBookingRules),preparationMinutes:0,followupMinutes:0};
    await db.admin.query(`insert into booking_reservations(id,workspace_id,organizer_id,provider,kind,connection_id,connection_revision,calendar_id,title,starts_at,ends_at,blocked_starts_at,blocked_ends_at,state,expires_at,rules,request_hash,idempotency_key,recipient_email,recipient_name,communication_language)
      values($1,$2,$3,'google','phone',$4,1,$5,'SYNTHETIC reminder QA',$6,$7,$6,$7,'confirmed',$8,$9,'SYNTHETIC-HASH',$10,$11,'Synthetic recipient',$12)`,[id,a.workspaceId,a.userId,a.connectionId,`synthetic-${a.workspaceId}`,start,end,new Date(now+5*60_000).toISOString(),JSON.stringify(rules),randomUUID(),input.recipient??"hello@novalure.eu",input.language??"en"]);
    await withOwner(async tx=>{await bookingResourceLock(tx,owner);const row=await readBooking(tx,owner,id);await syncBookingMessages(tx,owner,row,row,now);});
    return id;
  };
  const changeBooking=async(id:string,state:"confirmed"|"cancelled",minutesUntilStart?:number)=>withOwner(async tx=>{
    await bookingResourceLock(tx,owner);
    const before=await readBooking(tx,owner,id);
    if(minutesUntilStart!==undefined){const start=new Date(now+minutesUntilStart*60_000).toISOString(),end=new Date(Date.parse(start)+30*60_000).toISOString();await tx.execute("update booking_reservations set starts_at=$2,ends_at=$3,blocked_starts_at=$2,blocked_ends_at=$3,state=$4,revision=revision+1 where id=$1",[id,start,end,state]);}
    else await tx.execute("update booking_reservations set state=$2,revision=revision+1 where id=$1",[id,state]);
    const after=await readBooking(tx,owner,id);await syncBookingMessages(tx,owner,before,after,now);return readBooking(tx,owner,id);
  });
  const check=async(name:string,action:()=>Promise<void>)=>t.test(name,async()=>{await db.admin.query("delete from booking_message_jobs");await config();await action();});
  try{
    const client=await db.admin.connect();
    try{await client.query("begin");for(const name of ["108_universal_booking.sql","109_booking_setup_communications.sql"]){const sql=await readFile(`migrations/${name}`,"utf8");await client.query(sql);await client.query("insert into novalure_schema_migrations(version,name,checksum) values($1,$2,$3)",[name.slice(0,-4),name,createHash("sha256").update(sql.replace(/\r\n/g,"\n")).digest("hex")]);}await client.query("commit");}catch(error){await client.query("rollback");throw error;}finally{client.release();}
    for(const identity of [a,b]){
      await db.admin.query("insert into workspaces(id,name,operating_model,customer_type) values($1,'SYNTHETIC message QA','self_service_customer','general_company')",[identity.workspaceId]);
      await db.admin.query("insert into workspace_users(id,workspace_id,name,email,role,product_role,status) values($1,$2,'Synthetic organizer',$3,'owner','customer_owner','active')",[identity.userId,identity.workspaceId,`${identity.userId}@example.invalid`]);
      await db.admin.query("insert into workspace_module_settings(workspace_id,module_key,enabled) values($1,'calendar',true)",[identity.workspaceId]);
      await db.admin.query("insert into booking_calendar_connections(id,workspace_id,user_id,provider,status,account_id,account_label,write_calendar_id) values($1,$2,$3,'google','connected',$4,'SYNTHETIC account',$5)",[identity.connectionId,identity.workspaceId,identity.userId,`synthetic-account-${identity.workspaceId}`,`synthetic-${identity.workspaceId}`]);
    }
    process.env.BOOKING_MAIL_TEST_BINDINGS_JSON=JSON.stringify([{workspaceId:a.workspaceId,userId:a.userId,recipientEmail:"hello@novalure.eu"}]);
    await check("queue is versioned, language-bound, persistent, and idempotent",async()=>{
      const id=await seedBooking();
      await withOwner(async tx=>{await bookingResourceLock(tx,owner);const row=await readBooking(tx,owner,id);await syncBookingMessages(tx,owner,row,row,now);});
      const rows=await jobs(id);assert.equal(rows.length,3);assert.deepEqual(rows.map(row=>row.kind),["confirmation","reminder","reminder"]);assert(rows.every(row=>row.booking_version===1&&row.language==="en"&&row.status==="planned"));
      assert.equal(Date.parse(rows[1].scheduled_for),now+60*60_000);assert.equal(Date.parse(rows[2].scheduled_for),now+120*60_000);
      assert.equal((await withOwner(tx=>readBooking(tx,owner,id))).messageVersion,1);
    });
    await check("reading a signed customer link has no booking or queue side effect and stale versions are denied",async()=>{
      const id=await seedBooking();const before=await withOwner(tx=>readBooking(tx,owner,id));
      const links=createBookingActionLinks(before,now);const token=new URL(links.cancelUrl).pathname.split("/").at(-1)!;
      const opened=await Promise.all([readBookingAction(token,options),readBookingAction(token,options)]);
      assert(opened.every(result=>result.row.state==="confirmed"&&result.payload.purpose==="cancel"));
      const after=await withOwner(tx=>readBooking(tx,owner,id));assert.equal(after.state,before.state);assert.equal(after.revision,before.revision);assert.equal(after.messageVersion,before.messageVersion);assert.equal((await jobs(id)).length,3);assert((await jobs(id)).every(row=>row.status==="planned"));
      await changeBooking(id,"confirmed",240);
      await assert.rejects(readBookingAction(token,options),(error:unknown)=>(error as {code?:string}).code==="BOOKING_ACTION_STALE");
    });
    await check("short-notice appointments do not enqueue already-missed reminders",async()=>{
      const id=await seedBooking({minutesUntilStart:30});assert.deepEqual((await jobs(id)).map(row=>row.kind),["confirmation"]);
    });
    await check("rescheduling invalidates all old reminders and creates one new version",async()=>{
      const id=await seedBooking();await changeBooking(id,"confirmed",240);const rows=await jobs(id);
      assert.equal(rows.filter(row=>row.booking_version===1&&row.status==="cancelled").length,3);
      assert.equal(rows.filter(row=>row.booking_version===2&&row.status==="planned").length,3);
      assert.equal(rows.filter(row=>row.booking_version===2&&row.kind==="reschedule").length,1);
      assert.equal(Date.parse(rows.find(row=>row.booking_version===2&&row.kind==="reminder").scheduled_for),now+120*60_000);
      let calls=0;await processDueBookingMessages({...options,now:()=>now+60*60_000,send:async()=>{calls++;return sendAccepted();}});assert.equal(calls,1);
    });
    await check("cancellation prevents all pending reminders without undoing the booking result",async()=>{
      const id=await seedBooking();await changeBooking(id,"cancelled");const rows=await jobs(id);assert.equal(rows.filter(row=>row.status==="cancelled").length,3);assert.equal(rows.filter(row=>row.kind==="cancellation"&&row.status==="planned").length,1);
      let calls=0;const send=async()=>{calls++;return sendAccepted();};await processDueBookingMessages({...options,now:()=>now,send});await processDueBookingMessages({...options,now:()=>now+121*60_000,send});assert.equal(calls,1);assert.equal((await withOwner(tx=>readBooking(tx,owner,id))).state,"cancelled");
    });
    await check("due-time boundaries and repeated workers cannot send a reminder twice",async()=>{
      const id=await seedBooking();const keys:string[]=[];const send=async(input:{idempotencyKey:string})=>{keys.push(input.idempotencyKey);return sendAccepted();};
      await processDueBookingMessages({...options,now:()=>now,send});assert.equal(keys.length,1);
      await processDueBookingMessages({...options,now:()=>now+59*60_000,send});assert.equal(keys.length,1);
      await processDueBookingMessages({...options,now:()=>now+60*60_000,send});await processDueBookingMessages({...options,now:()=>now+60*60_000,send});assert.equal(keys.length,2);
      await processDueBookingMessages({...options,now:()=>now+120*60_000,send});assert.equal(keys.length,3);assert.equal(new Set(keys).size,3);assert((await jobs(id)).every(row=>row.status==="accepted"));
    });
    await check("concurrent workers claim one due message only once",async()=>{
      const id=await seedBooking();let calls=0;const send=async()=>{calls++;await new Promise(resolve=>setTimeout(resolve,30));return sendAccepted();};
      await Promise.all([processDueBookingMessages({...options,now:()=>now,send}),processDueBookingMessages({...options,now:()=>now,send})]);assert.equal(calls,1);assert.equal((await jobs(id)).filter(row=>row.status==="accepted").length,1);
    });
    await check("explicit provider rate-limit backoff preserves one provider idempotency key",async()=>{
      const id=await seedBooking();const keys:string[]=[];const send=async(input:{idempotencyKey:string}):Promise<TransactionalEmailResult>=>{keys.push(input.idempotencyKey);return keys.length===1?{outcome:"retryable",error:"SYNTHETIC_RATE_LIMIT"}:sendAccepted();};
      await processDueBookingMessages({...options,now:()=>now,send});assert.equal(keys.length,1);assert.equal((await jobs(id))[0].status,"planned");
      await processDueBookingMessages({...options,now:()=>now+30_000,send});assert.equal(keys.length,1);
      await processDueBookingMessages({...options,now:()=>now+60_000,send});assert.equal(keys.length,2);assert.equal(keys[0],keys[1]);assert.equal((await jobs(id))[0].status,"accepted");
    });
    await check("unknown send remains uncertain until provider evidence; late events do not regress delivery",async()=>{
      const id=await seedBooking();let calls=0;const send=async():Promise<TransactionalEmailResult>=>{calls++;return{outcome:"uncertain",error:"SYNTHETIC_TIMEOUT"};};
      await processDueBookingMessages({...options,now:()=>now,send});await processDueBookingMessages({...options,now:()=>now+60_000,send});assert.equal(calls,1);const job=(await jobs(id))[0];assert.equal(job.status,"uncertain");assert.equal((await withOwner(tx=>readBooking(tx,owner,id))).notificationStatus,"pending");
      const event={eventId:"synthetic-event-one",messageId:`synthetic-${randomUUID()}`,jobId:job.id,type:"email.delivered" as const,occurredAt:new Date(now+2_000).toISOString()};
      await recordBookingMailProviderEvent(event,options);await recordBookingMailProviderEvent(event,options);
      await recordBookingMailProviderEvent({...event,eventId:"synthetic-event-late-sent",type:"email.sent",occurredAt:new Date(now+3_000).toISOString()},options);
      const final=(await jobs(id))[0];assert.equal(final.status,"delivered");assert.equal(final.provider_message_id,event.messageId);assert.equal(final.event_ids.length,2);
    });
    await check("an expired worker lease is reconciled as uncertain without automatic resend",async()=>{
      const id=await seedBooking();const job=(await jobs(id))[0];await db.admin.query("update booking_message_jobs set status='sending',first_attempt_at=$2,lease_until=$3,lease_owner='SYNTHETIC-LOST-WORKER',attempt_count=1 where id=$1",[job.id,new Date(now-60_000).toISOString(),new Date(now-1_000).toISOString()]);
      let calls=0;await processDueBookingMessages({...options,now:()=>now,send:async()=>{calls++;return sendAccepted();}});assert.equal(calls,0);assert.equal((await jobs(id))[0].status,"uncertain");
    });
    await check("send and cancellation use the same resource lock; no stale reminder escapes",async()=>{
      const id=await seedBooking();let entered!:()=>void,release!:()=>void;const sending=new Promise<void>(resolve=>{entered=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});let calls=0,cancelDone=false;
      const worker=processDueBookingMessages({...options,now:()=>now,send:async()=>{calls++;entered();await gate;return sendAccepted();}});await sending;
      const cancellation=changeBooking(id,"cancelled").then(()=>{cancelDone=true;});await new Promise(resolve=>setTimeout(resolve,30));assert.equal(cancelDone,false);release();await Promise.all([worker,cancellation]);
      assert.equal(calls,1);const rows=await jobs(id);assert.equal(rows.filter(row=>row.kind==="reminder"&&row.status==="cancelled").length,2);assert.equal((await withOwner(tx=>readBooking(tx,owner,id))).state,"cancelled");
    });
    await check("RLS, approved recipient, and current communication language are enforced before send",async()=>{
      const id=await seedBooking({recipient:"unapproved@example.invalid"});let calls=0;const send=async()=>{calls++;return sendAccepted();};await processDueBookingMessages({...options,now:()=>now,send});assert.equal(calls,0);assert.equal((await jobs(id))[0].status,"cancelled");
      assert.equal((await db.pool.query("select count(*)::int as count from booking_message_jobs")).rows[0].count,0);
      const foreignRows=await withTenantTransaction({workspaceId:b.workspaceId,actorId:b.userId},tx=>tx.query("select id from booking_message_jobs"),options);assert.equal(foreignRows.length,0);
      await assert.rejects(withTenantTransaction({workspaceId:b.workspaceId,actorId:b.userId},tx=>tx.execute("update booking_message_jobs set status='planned' where booking_id=$1",[id]).then(async()=>readBooking(tx,foreign,id)),options));
      const languageId=await seedBooking();await db.admin.query("update booking_reservations set communication_language='de' where id=$1",[languageId]);await processDueBookingMessages({...options,now:()=>now,send});assert.equal(calls,0);assert.equal((await jobs(languageId))[0].status,"cancelled");
    });
  }finally{await db.stop();for(const name of envNames){const old=previousEnv[name];if(old===undefined)delete process.env[name];else process.env[name]=old;}}
});
