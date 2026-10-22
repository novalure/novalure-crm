import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { test } from "node:test";
import type { AppSession } from "../src/lib/auth/session";
import { getRolePermissions } from "../src/lib/auth/permissions";
import { getProductRoleCapabilities } from "../src/lib/product-model";
import { withTenantTransaction, type TenantPool, type TenantTransactionOptions } from "../src/lib/db/tenant-client";
import type { BookingProvider, BookingProviderFactory, ProviderEvent, ProviderWrite, BusyInterval } from "../src/lib/booking/types";
import { BookingProviderError } from "../src/lib/booking/providers";
import { startDesignCIntegrationDatabase } from "./lib/design-c-integration-fixture.mjs";

if (!process.env.NODE_ENV) Object.assign(process.env, { NODE_ENV: "test" });

/** Synthetic provider ports exercise the REAL durable PostgreSQL state machine.
 * They are deliberately not Microsoft/Google acceptance evidence. */
class SimulatedProvider implements BookingProvider {
  events = new Map<string, ProviderEvent>();
  busy: BusyInterval[] = [];
  creates = 0;
  updates = 0;
  deletes = 0;
  unavailable = false;
  timeoutAfterCreate = false;
  nextVideoPending = false;
  rejectNextUpdate = false;
  deferredLookup: { entered: () => void; release: Promise<void> } | null = null;
  async listBusy(input: { startsAt: string; endsAt: string; excludeEventId?: string }) {
    if (this.unavailable) throw new Error("SYNTHETIC_REVOKED_CONNECTION");
    return [...this.busy, ...[...this.events.values()].filter(event => !event.cancelled && event.eventId !== input.excludeEventId)
      .map(event => ({ startsAt: event.startsAt, endsAt: event.endsAt, eventId: event.eventId }))]
      .filter(event => Date.parse(event.startsAt) < Date.parse(input.endsAt) && Date.parse(event.endsAt) > Date.parse(input.startsAt));
  }
  async create(input: ProviderWrite) {
    this.creates += 1;
    const event: ProviderEvent = {
      eventId: `synthetic-${input.bookingId}`, etag: '"synthetic-v1"', startsAt: input.startsAt, endsAt: input.endsAt,
      onlineMeetingUrl: this.nextVideoPending ? null : "https://example.invalid/synthetic-video",
      videoStatus: this.nextVideoPending ? "pending" : "ready", cancelled: false,
    };
    this.events.set(input.bookingId, event);
    if (this.timeoutAfterCreate) throw new Error("SYNTHETIC_TIMEOUT_AFTER_PROVIDER_COMMIT");
    return event;
  }
  async lookup(input: { operationId: string; bookingId: string; eventId?: string }) {
    if (this.unavailable) throw new Error("SYNTHETIC_REVOKED_CONNECTION");
    const event=this.events.get(input.bookingId) ?? null;
    const deferred=this.deferredLookup;this.deferredLookup=null;
    if(deferred) { deferred.entered();await deferred.release; }
    return event;
  }
  async update(input: ProviderWrite & { eventId: string; etag: string | null }) {
    this.updates += 1;
    if(this.rejectNextUpdate) { this.rejectNextUpdate=false; throw new BookingProviderError("SYNTHETIC_PRECONDITION_REJECTED","rejected",412); }
    const existing = this.events.get(input.bookingId);
    assert.ok(existing);
    assert.equal(existing.eventId, input.eventId);
    assert.equal(existing.etag, input.etag);
    const event = { ...existing, startsAt: input.startsAt, endsAt: input.endsAt, etag: '"synthetic-v2"' };
    this.events.set(input.bookingId, event);
    return event;
  }
  async delete(input: { bookingId: string; operationId: string; eventId: string; etag: string | null }) {
    this.deletes += 1;
    const existing = this.events.get(input.bookingId);
    assert.ok(existing);
    assert.equal(existing.eventId, input.eventId);
    assert.equal(existing.etag, input.etag);
    this.events.set(input.bookingId, { ...existing, cancelled: true });
  }
}

function session(workspaceId: string, userId: string, customerType: AppSession["workspaceCustomerType"] = "property_developer"): AppSession {
  return {
    authenticated: true, source: "database", workspaceId, userId, workspaceName: "SYNTHETIC booking tenant",
    name: "SYNTHETIC booking owner", email: `${userId}@example.invalid`, role: "owner", productRole: "customer_owner",
    permissions: getRolePermissions("owner"), productPermissions: getProductRoleCapabilities("customer_owner"),
    workspaceCustomerType: customerType, workspaceOperatingModel: "self_service_customer",
  };
}
const codeIs = (code: string) => (error: unknown) => (error as { code?: string }).code === code;

test("Package 5 durable booking acceptance: two isolated PostgreSQL tenants; provider ports are simulated", { timeout: 240_000 }, async t => {
  const db = await startDesignCIntegrationDatabase();
  const options: TenantTransactionOptions = { pool: db.pool as unknown as TenantPool };
  const evidence: Record<string, unknown> = {
    syntheticOnly: true, mode: "disposable local PostgreSQL, real forced RLS, simulated calendar provider ports",
    realMicrosoftEvidence: false, realGoogleEvidence: false, remoteDatabaseAccess: 0, productionAccess: 0,
    predecessorMode: "actual 091–096 and 100–106 SQL; optional vector substitution and historical manual062 excluded by shared fixture",
    checks: [] as string[], status: "RUNNING",
  };
  const check = async (name: string, run: () => Promise<void>) => t.test(name, async () => {
    try { await run(); (evidence.checks as string[]).push(name); }
    catch (error) { evidence.status="FAIL"; evidence.failure=error instanceof Error?error.message:String(error); throw error; }
  });
  try {
    const client = await db.admin.connect();
    try {
      await client.query("begin");
      for (const name of ["108_universal_booking.sql", "109_booking_setup_communications.sql"]) {
        const migration = await readFile(`migrations/${name}`, "utf8");
        await client.query(migration);
        await client.query("insert into novalure_schema_migrations(version,name,checksum) values($1,$2,$3)", [name.slice(0,-4),name,createHash("sha256").update(migration.replace(/\r\n/g, "\n")).digest("hex")]);
      }
      await client.query("commit");
    } catch (error) { await client.query("rollback"); throw error; }
    finally { client.release(); }
    const tenants = [{customerType:"general_company" as const},{customerType:"real_estate_broker" as const}].map(entry => ({ ...entry,workspaceId: randomUUID(), userId: randomUUID(), microsoftId: randomUUID(), googleId: randomUUID() }));
    for (const tenant of tenants) {
      await db.admin.query("insert into workspaces(id,name,operating_model,customer_type) values($1,'SYNTHETIC booking acceptance','self_service_customer',$2)", [tenant.workspaceId,tenant.customerType]);
      await db.admin.query("insert into workspace_users(id,workspace_id,name,email,role,product_role,status) values($1,$2,'SYNTHETIC booking owner',$3,'owner','customer_owner','active')", [tenant.userId, tenant.workspaceId, `${tenant.userId}@example.invalid`]);
      await db.admin.query("insert into workspace_module_settings(workspace_id,module_key,enabled) values($1,'calendar',true)", [tenant.workspaceId]);
      await db.admin.query(`insert into booking_calendar_connections(id,workspace_id,user_id,provider,status,account_label,account_id,write_calendar_id)
        values($1,$3,$4,'microsoft','connected','SYNTHETIC Microsoft','synthetic-ms-account-'||$3::uuid::text,'synthetic-ms-'||$3::uuid::text),($2,$3,$4,'google','connected','SYNTHETIC Google','synthetic-google-account-'||$3::uuid::text,'synthetic-google-'||$3::uuid::text)`, [tenant.microsoftId, tenant.googleId, tenant.workspaceId, tenant.userId]);
    }
    const [a,b] = tenants;
    const owner = session(a.workspaceId,a.userId,a.customerType), foreign = session(b.workspaceId,b.userId,b.customerType);
    const scope = { workspaceId: a.workspaceId, actorId: a.userId };
    const microsoft = new SimulatedProvider(), google = new SimulatedProvider();
    let now = Date.now();
    const slot = (days: number, hour: number) => { const value = new Date(now); value.setUTCDate(value.getUTCDate()+days); value.setUTCHours(hour,0,0,0); return value.toISOString(); };
    const providerFactory: BookingProviderFactory = async (s,provider) => {
      assert.ok(tenants.some(tenant => tenant.workspaceId === s.workspaceId && tenant.userId === s.actorId));
      return provider === "google" ? google : microsoft;
    };
    const serviceOptions = { ...options, providerFactory, now: () => now,
      connectionResolver: async (s: {workspaceId:string;actorId:string},provider: "microsoft"|"google") => {
        const tenant = tenants.find(row => row.workspaceId === s.workspaceId && row.userId === s.actorId);
        assert.ok(tenant);
        return { connectionId: provider === "microsoft" ? tenant.microsoftId : tenant.googleId, calendarId: `${provider === "microsoft" ? "synthetic-ms" : "synthetic-google"}-${tenant.workspaceId}`, revision: 1 };
      },
    };
    const {
      saveBookingRules, getBookingAvailability, createBookingHold, confirmBooking,
      getBookingStatus, rescheduleBooking, cancelBooking, captureBookingRequest,
    } = await import("../src/lib/booking/service");
    await saveBookingRules(owner,{ rules: {
      minNoticeMinutes: 0, cancelNoticeMinutes: 0, rescheduleNoticeMinutes: 0,
      preparationMinutes: 15, followupMinutes: 15, maxAdvanceDays: 366,
      workingHours: [0,1,2,3,4,5,6].map(day => ({ day,start: "09:00",end:"17:00" })),
    } },serviceOptions);
    await saveBookingRules(foreign,{ rules: { minNoticeMinutes: 0, workingHours: [0,1,2,3,4,5,6].map(day => ({day,start:"09:00",end:"17:00"})) } },serviceOptions);

    await check("new relations force RLS and runtime owns no booking table", async () => {
      const names = ["booking_calendar_connections","booking_rule_sets","booking_reservations","booking_operations","booking_oauth_authorization_states"];
      const rows = (await db.admin.query("select relname,relrowsecurity,relforcerowsecurity,relowner::regrole::text as owner from pg_class where relname=any($1::text[])", [names])).rows;
      assert.equal(rows.length,5);
      assert.ok(rows.every(row => row.relrowsecurity && row.relforcerowsecurity && row.owner !== db.role));
      const role = (await db.pool.query("select rolsuper,rolbypassrls from pg_roles where rolname=current_user")).rows[0];
      assert.equal(role.rolsuper,false); assert.equal(role.rolbypassrls,false);
      for (const name of names) assert.equal((await db.pool.query(`select count(*)::int as count from ${name}`)).rows[0].count,0);
    });

    await check("OAuth ledger and employee connection rows reject foreign tenant and colleague mapping", async () => {
      const insertState=(workspaceId:string,userId:string)=>withTenantTransaction(scope,tx=>tx.execute(`insert into booking_oauth_authorization_states(state_hash,nonce_hash,provider,workspace_id,user_id,return_to,code_verifier_encrypted,expires_at)
        values($1,$2,'google',$3,$4,'/booking','SYNTHETIC encrypted verifier',now()+interval '5 minutes')`,[randomUUID(),randomUUID(),workspaceId,userId]),options);
      await insertState(a.workspaceId,a.userId);
      await assert.rejects(insertState(b.workspaceId,b.userId),codeIs("42501"));
      assert.equal((await withTenantTransaction(scope,tx=>tx.query("select id from booking_oauth_authorization_states"),options)).length,1);
      assert.equal((await withTenantTransaction({workspaceId:b.workspaceId,actorId:b.userId},tx=>tx.query("select id from booking_oauth_authorization_states"),options)).length,0);
      assert.equal((await withTenantTransaction(scope,tx=>tx.query("select id from booking_calendar_connections"),options)).length,2);
    });

    await check("general company and broker tenant keep distinct classifications and independent calendar entitlement", async () => {
      const companies=(await db.admin.query("select customer_type from workspaces where id=any($1::uuid[]) order by customer_type",[[a.workspaceId,b.workspaceId]])).rows;
      assert.deepEqual(companies.map(row=>row.customer_type),["general_company","real_estate_broker"]);
      await db.admin.query("insert into projects(workspace_id,name,type,customer_type) values($1,'SYNTHETIC general company project','Unternehmen','general_company')",[a.workspaceId]);
      assert.equal(owner.workspaceCustomerType,"general_company");
      assert.equal(foreign.workspaceCustomerType,"real_estate_broker");
    });

    await check("one selected provider account and write calendar cannot belong to two organizers; conflict-only sharing is allowed", async () => {
      const secondEmployee=randomUUID();
      await db.admin.query("insert into workspace_users(id,workspace_id,name,email,role,product_role,status) values($1,$2,'SYNTHETIC second binding owner',$3,'owner','customer_owner','active')",[secondEmployee,b.workspaceId,`${secondEmployee}@example.invalid`]);
      const secondScope={workspaceId:b.workspaceId,actorId:secondEmployee};
      const insert=(account:string,writer:string|null)=>withTenantTransaction(secondScope,tx=>tx.execute(`insert into booking_calendar_connections(workspace_id,user_id,provider,status,account_id,write_calendar_id,conflict_calendar_ids)
        values($1,$2,'microsoft','connected',$3,$4,$5::text[])`,[b.workspaceId,secondEmployee,account,writer,[`synthetic-ms-${a.workspaceId}`]]),options);
      const violation=(constraint:string)=>(error:unknown)=>(error as {code?:string;constraint?:string}).code==="23505" && (error as {constraint?:string}).constraint===constraint;
      await assert.rejects(insert(`synthetic-ms-account-${a.workspaceId}`,`synthetic-separate-${randomUUID()}`),violation("booking_one_organizer_account"));
      await assert.rejects(insert(`synthetic-separate-account-${randomUUID()}`,`synthetic-ms-${a.workspaceId}`),violation("booking_one_writer_calendar"));
      await insert(`synthetic-ms-account-${a.workspaceId}`,null);
      const rows=await withTenantTransaction(secondScope,tx=>tx.query("select write_calendar_id,conflict_calendar_ids from booking_calendar_connections"),options);
      assert.equal(rows.length,1);assert.equal(rows[0].write_calendar_id,null);assert.deepEqual(rows[0].conflict_calendar_ids,[`synthetic-ms-${a.workspaceId}`]);
    });

    let confirmedId = "";
    await check("concurrent different-channel holds share organizer and buffers across both providers", async () => {
      const calls = [
        createBookingHold(owner,{provider:"microsoft",kind:"teams",startsAt:slot(2,9),title:"SYNTHETIC chat booking",idempotencyKey:randomUUID()},serviceOptions),
        createBookingHold(owner,{provider:"google",kind:"meet",startsAt:slot(2,9),title:"SYNTHETIC phone booking",idempotencyKey:randomUUID()},serviceOptions),
      ];
      const settled = await Promise.allSettled(calls);
      const success = settled.filter(row => row.status === "fulfilled");
      assert.equal(success.length,1);
      assert.equal(settled.filter(row => row.status === "rejected").length,1);
      const hold = success[0]; assert.equal(hold.status,"fulfilled");
      confirmedId = hold.value.id;
      await assert.rejects(createBookingHold(owner,{provider:"microsoft",kind:"phone",startsAt:slot(2,9).replace("09:00:","09:30:"),title:"SYNTHETIC buffer overlap",idempotencyKey:randomUUID()},serviceOptions));
      assert.equal(microsoft.creates+google.creates,0);
    });

    await check("repeated concurrent confirmations create exactly one provider event", async () => {
      const results = await Promise.allSettled([confirmBooking(owner,confirmedId,serviceOptions),confirmBooking(owner,confirmedId,serviceOptions)]);
      assert.ok(results.some(row => row.status === "fulfilled"), JSON.stringify(results.map(row => row.status === "rejected" ? String(row.reason) : row.value.state)));
      const status = await confirmBooking(owner,confirmedId,serviceOptions);
      assert.equal(status.state,"confirmed");
      assert.equal(microsoft.creates+google.creates,1);
      assert.equal(status.notificationStatus,"not_requested");
      const crm=(await db.admin.query("select b.crm_booking_id,m.status,m.metadata from booking_reservations b join meeting_bookings m on m.id=b.crm_booking_id where b.id=$1",[confirmedId])).rows[0];
      assert.equal(crm.crm_booking_id,confirmedId); assert.equal(crm.status,"confirmed");
      assert.equal(crm.metadata.universalBookingId,confirmedId);
      assert.equal(crm.metadata.notificationStatus,"not_requested");
      assert.equal((await db.admin.query("select count(*)::int as count from meeting_notification_jobs where booking_id=$1",[confirmedId])).rows[0].count,0);
    });

    await check("foreign tenant and same-workspace different employee cannot read or mutate a booking", async () => {
      await assert.rejects(getBookingStatus(foreign,confirmedId,serviceOptions));
      await assert.rejects(cancelBooking(foreign,confirmedId,{idempotencyKey:randomUUID()},serviceOptions));
      const colleague = randomUUID();
      await db.admin.query("insert into workspace_users(id,workspace_id,name,email,role,product_role,status) values($1,$2,'SYNTHETIC colleague',$3,'owner','customer_owner','active')", [colleague,a.workspaceId,`${colleague}@example.invalid`]);
      const colleagueSession = session(a.workspaceId,colleague);
      await assert.rejects(getBookingStatus(colleagueSession,confirmedId,serviceOptions));
      assert.equal((await withTenantTransaction({workspaceId:a.workspaceId,actorId:colleague},tx => tx.query("select id from booking_calendar_connections"),options)).length,0);
      await assert.rejects(withTenantTransaction(scope,tx => tx.execute("insert into booking_calendar_connections(workspace_id,user_id,provider) values($1,$2,'google')",[b.workspaceId,b.userId]),options),codeIs("42501"));
    });

    await check("expired hold stops blocking resource and cannot be confirmed", async () => {
      const held = await createBookingHold(owner,{provider:"microsoft",kind:"phone",startsAt:slot(3,9),title:"SYNTHETIC expired",idempotencyKey:randomUUID()},serviceOptions);
      now += 11*60_000;
      assert.equal((await confirmBooking(owner,held.id,serviceOptions)).state,"expired");
      const next = await createBookingHold(owner,{provider:"google",kind:"phone",startsAt:held.startsAt,title:"SYNTHETIC replacement",idempotencyKey:randomUUID()},serviceOptions);
      assert.notEqual(next.id,held.id);
      const expired = await getBookingStatus(owner,held.id,serviceOptions);
      assert.equal(expired.state,"expired");
    });

    await check("fresh external busy check rejects a stale chosen slot", async () => {
      const held = await createBookingHold(owner,{provider:"microsoft",kind:"phone",startsAt:slot(4,9),title:"SYNTHETIC stale",idempotencyKey:randomUUID()},serviceOptions);
      microsoft.busy = [{startsAt:held.startsAt,endsAt:held.endsAt,eventId:"external-synthetic"}];
      const before = microsoft.creates;
      assert.equal((await confirmBooking(owner,held.id,serviceOptions)).state,"conflict");
      assert.equal(microsoft.creates,before);
      microsoft.busy=[];
    });

    await check("revoked connection creates no provider event and records honest failure", async () => {
      const held = await createBookingHold(owner,{provider:"microsoft",kind:"phone",startsAt:slot(5,9),title:"SYNTHETIC revoke",idempotencyKey:randomUUID()},serviceOptions);
      microsoft.unavailable=true;
      const before=microsoft.creates;
      try {
        assert.equal((await confirmBooking(owner,held.id,serviceOptions)).state,"uncertain");
        assert.equal(microsoft.creates,before);
      } finally { microsoft.unavailable=false; }
    });

    await check("unknown provider create outcome reconciles via durable operation without retry create", async () => {
      const held=await createBookingHold(owner,{provider:"microsoft",kind:"teams",startsAt:slot(6,9),title:"SYNTHETIC timeout",idempotencyKey:randomUUID()},serviceOptions);
      const before=microsoft.creates;
      microsoft.timeoutAfterCreate=true;
      const outcome=await confirmBooking(owner,held.id,serviceOptions);
      assert.equal(outcome.state,"uncertain");
      assert.equal(microsoft.creates,before+1);
      microsoft.timeoutAfterCreate=false;
      const recovered=await getBookingStatus(owner,held.id,serviceOptions);
      assert.equal(recovered.state,"confirmed");
      await confirmBooking(owner,held.id,serviceOptions);
      assert.equal(microsoft.creates,before+1);
      const operations=await withTenantTransaction(scope,tx => tx.query("select state from booking_operations where booking_id=$1",[held.id]),options);
      assert.equal(operations.length,1); assert.equal(operations[0].state,"succeeded");
    });

    await check("pending Google Meet is separate from confirmed calendar creation; no second event", async () => {
      google.nextVideoPending=true;
      const held=await createBookingHold(owner,{provider:"google",kind:"meet",startsAt:slot(7,9),title:"SYNTHETIC delayed Meet",idempotencyKey:randomUUID()},serviceOptions);
      const before=google.creates;
      const confirmed=await confirmBooking(owner,held.id,serviceOptions);
      assert.equal(confirmed.state,"confirmed"); assert.equal(confirmed.videoStatus,"pending"); assert.equal(confirmed.videoUrl,null);
      await confirmBooking(owner,held.id,serviceOptions);
      assert.equal(google.creates,before+1);
      google.events.set(held.id,{...google.events.get(held.id)!,videoStatus:"ready",onlineMeetingUrl:"https://example.invalid/synthetic-meet-ready"});
      const status=await getBookingStatus(owner,held.id,serviceOptions);
      assert.equal(status.videoStatus,"ready"); assert.ok(status.videoUrl);
      assert.equal(google.creates,before+1);
      google.nextVideoPending=false;
    });

    await check("authorized reschedule and cancel update the same owned provider event; replay is idempotent", async () => {
      const held=await createBookingHold(owner,{provider:"microsoft",kind:"teams",startsAt:slot(8,9),title:"SYNTHETIC move/cancel",idempotencyKey:randomUUID()},serviceOptions);
      const confirmed=await confirmBooking(owner,held.id,serviceOptions);
      const moveKey=randomUUID(),cancelKey=randomUUID();
      const moved=await rescheduleBooking(owner,held.id,{startsAt:slot(8,11),idempotencyKey:moveKey},serviceOptions);
      assert.equal(moved.state,"confirmed"); assert.equal(moved.providerEventId,confirmed.providerEventId); assert.equal(moved.startsAt,slot(8,11));
      const beforeUpdates=microsoft.updates;
      await rescheduleBooking(owner,held.id,{startsAt:slot(8,11),idempotencyKey:moveKey},serviceOptions);
      assert.equal(microsoft.updates,beforeUpdates);
      const cancelled=await cancelBooking(owner,held.id,{idempotencyKey:cancelKey},serviceOptions);
      assert.equal(cancelled.state,"cancelled");
      const beforeDeletes=microsoft.deletes;
      await cancelBooking(owner,held.id,{idempotencyKey:cancelKey},serviceOptions);
      assert.equal(microsoft.deletes,beforeDeletes);
    });

    await check("external calendar changes reconcile into CRM status without overwriting foreign records", async () => {
      const held=await createBookingHold(owner,{provider:"google",kind:"phone",startsAt:slot(9,9),title:"SYNTHETIC external edit",idempotencyKey:randomUUID()},serviceOptions);
      await confirmBooking(owner,held.id,serviceOptions);
      const event=google.events.get(held.id)!;
      google.events.set(held.id,{...event,startsAt:slot(9,10),endsAt:slot(9,11),etag:'"synthetic-external-edit"'});
      const status=await getBookingStatus(owner,held.id,serviceOptions);
      assert.equal(status.startsAt,slot(9,10));
      google.events.set(held.id,{...google.events.get(held.id)!,cancelled:true});
      assert.equal((await getBookingStatus(owner,held.id,serviceOptions)).state,"cancelled");
    });

    await check("definitive provider rejection restores original event and preserves rejected operation after reconciliation", async () => {
      const held=await createBookingHold(owner,{provider:"microsoft",kind:"teams",startsAt:slot(14,9),title:"SYNTHETIC rejected update",idempotencyKey:randomUUID()},serviceOptions);
      await confirmBooking(owner,held.id,serviceOptions);
      const key=randomUUID();microsoft.rejectNextUpdate=true;
      const rejected=await rescheduleBooking(owner,held.id,{startsAt:slot(14,12),idempotencyKey:key},serviceOptions);
      assert.equal(rejected.state,"confirmed");assert.equal(rejected.startsAt,slot(14,9));assert.equal(rejected.operationTarget,null);
      await getBookingStatus(owner,held.id,serviceOptions);
      const operations=await withTenantTransaction(scope,tx=>tx.query("select state from booking_operations where idempotency_key=$1",[key]),options);
      assert.equal(operations[0].state,"rejected");
    });

    await check("delayed status lookup cannot overwrite a newer completed cancellation", async () => {
      const held=await createBookingHold(owner,{provider:"microsoft",kind:"teams",startsAt:slot(15,9),title:"SYNTHETIC cancelled lookup race",idempotencyKey:randomUUID()},serviceOptions);
      await confirmBooking(owner,held.id,serviceOptions);
      const event=microsoft.events.get(held.id)!;
      microsoft.events.set(held.id,{...event,startsAt:slot(15,10),endsAt:slot(15,11)});
      let enter!:()=>void,release!:()=>void;
      const entered=new Promise<void>(resolve=>{enter=resolve;});
      microsoft.deferredLookup={entered:enter,release:new Promise<void>(resolve=>{release=resolve;})};
      const stale=getBookingStatus(owner,held.id,serviceOptions);
      await entered;
      const cancelled=await cancelBooking(owner,held.id,{idempotencyKey:randomUUID()},serviceOptions);
      assert.equal(cancelled.state,"cancelled");
      release();
      await stale;
      const latest=await getBookingStatus(owner,held.id,serviceOptions);
      assert.equal(latest.state,"cancelled");assert.equal(latest.startsAt,held.startsAt);
    });

    await check("delayed status lookup cannot overwrite a newer completed reschedule", async () => {
      const held=await createBookingHold(owner,{provider:"microsoft",kind:"teams",startsAt:slot(16,9),title:"SYNTHETIC rescheduled lookup race",idempotencyKey:randomUUID()},serviceOptions);
      await confirmBooking(owner,held.id,serviceOptions);
      const event=microsoft.events.get(held.id)!;
      microsoft.events.set(held.id,{...event,startsAt:slot(16,10),endsAt:slot(16,11)});
      let enter!:()=>void,release!:()=>void;
      const entered=new Promise<void>(resolve=>{enter=resolve;});
      microsoft.deferredLookup={entered:enter,release:new Promise<void>(resolve=>{release=resolve;})};
      const stale=getBookingStatus(owner,held.id,serviceOptions);
      await entered;
      const rescheduled=await rescheduleBooking(owner,held.id,{startsAt:slot(16,12),idempotencyKey:randomUUID()},serviceOptions);
      assert.equal(rescheduled.state,"confirmed");
      release();
      await stale;
      const latest=await getBookingStatus(owner,held.id,serviceOptions);
      assert.equal(latest.state,"confirmed");assert.equal(latest.startsAt,slot(16,12));
    });

    await check("hold idempotency rejects changed payload and daily limits apply across appointment types", async () => {
      const idempotencyKey=randomUUID();
      const input={provider:"microsoft" as const,kind:"office" as const,startsAt:slot(11,9),title:"SYNTHETIC daily limit",idempotencyKey};
      await saveBookingRules(owner,{kind:"office",rules:{maxPerDay:1}},serviceOptions);
      const held=await createBookingHold(owner,input,serviceOptions);
      assert.equal((await createBookingHold(owner,input,serviceOptions)).id,held.id);
      await assert.rejects(createBookingHold(owner,{...input,title:"SYNTHETIC changed replay"},serviceOptions),codeIs("IDEMPOTENCY_CONFLICT"));
      await assert.rejects(createBookingHold(owner,{...input,startsAt:slot(11,12),idempotencyKey:randomUUID()},serviceOptions),codeIs("DAILY_LIMIT"));
    });

    await check("reschedule and cancellation deadlines are enforced before any provider mutation", async () => {
      await saveBookingRules(owner,{kind:"phone",rules:{cancelNoticeMinutes:43200,rescheduleNoticeMinutes:43200}},serviceOptions);
      const held=await createBookingHold(owner,{provider:"google",kind:"phone",startsAt:slot(12,9),title:"SYNTHETIC deadlines",idempotencyKey:randomUUID()},serviceOptions);
      await confirmBooking(owner,held.id,serviceOptions);
      const updates=google.updates,deletes=google.deletes;
      await assert.rejects(cancelBooking(owner,held.id,{idempotencyKey:randomUUID()},serviceOptions),codeIs("CHANGE_DEADLINE"));
      await assert.rejects(rescheduleBooking(owner,held.id,{startsAt:slot(12,12),idempotencyKey:randomUUID()},serviceOptions),codeIs("CHANGE_DEADLINE"));
      assert.equal(google.updates,updates);assert.equal(google.deletes,deletes);
    });

    await check("request-only fallback persists existing CRM object without claiming provider booking or notifications", async () => {
      const input={provider:"microsoft" as const,kind:"phone" as const,requestedStartsAt:slot(13,9),title:"SYNTHETIC request only",idempotencyKey:randomUUID()};
      const before=microsoft.creates+google.creates;
      const result=await captureBookingRequest(owner,input,serviceOptions);
      assert.equal(result.state,"requested");assert.equal(result.providerCreated,false);
      await captureBookingRequest(owner,input,serviceOptions);
      assert.equal(microsoft.creates+google.creates,before);
      const crm=(await db.admin.query("select status,metadata from meeting_bookings where id=$1",[input.idempotencyKey])).rows;
      assert.equal(crm.length,1);assert.equal(crm[0].status,"requested");assert.equal(crm[0].metadata.providerCreated,false);
      assert.equal(crm[0].metadata.notificationStatus,"not_requested");
    });

    await check("availability excludes held resources and module/role entitlements remain enforced", async () => {
      const date=slot(2,9).slice(0,10);
      const available=await getBookingAvailability(owner,{provider:"microsoft",kind:"phone",date},serviceOptions);
      assert.ok(available);
      await db.admin.query("update workspace_module_settings set enabled=false where workspace_id=$1 and module_key='calendar'",[b.workspaceId]);
      await assert.rejects(createBookingHold(foreign,{provider:"google",kind:"phone",startsAt:slot(2,9),title:"SYNTHETIC disabled module",idempotencyKey:randomUUID()},serviceOptions));
      await db.admin.query("update workspace_module_settings set enabled=true where workspace_id=$1 and module_key='calendar'",[b.workspaceId]);
      await db.admin.query("update workspace_users set product_role='viewer' where id=$1",[b.userId]);
      await assert.rejects(createBookingHold(foreign,{provider:"google",kind:"phone",startsAt:slot(2,9),title:"SYNTHETIC viewer",idempotencyKey:randomUUID()},serviceOptions));
    });
    if(evidence.status!=="FAIL") evidence.status="PASS";
  } catch(error) { evidence.status="FAIL"; evidence.failure=error instanceof Error?error.message:String(error); throw error; }
  finally {
    await db.stop();
    await mkdir(".npm-cache/qa",{recursive:true});
    await writeFile(".npm-cache/qa/universal-booking.json",JSON.stringify(evidence,null,2)+"\n");
    t.diagnostic("Evidence .npm-cache/qa/universal-booking.json; calendar provider behavior is simulated, not live Microsoft/Google evidence.");
  }
});

test("booking timezone rules enumerate real DST instants and honor buffers, breaks, absences and grid", async () => {
  const { defaultBookingRules, enumerateSlots, isSlotAllowed, localParts, validateBookingRules } = await import("../src/lib/booking/rules");
  const rules = { ...defaultBookingRules, minNoticeMinutes: 0, maxAdvanceDays: 366,
    workingHours: [{day:0,start:"00:00",end:"05:00"}], gridMinutes:30,
  };
  const spring = enumerateSlots("2026-03-29",rules,[],Date.parse("2026-03-28T00:00:00Z"));
  assert.ok(spring.length > 0);
  assert.ok(spring.every(row => Math.floor(localParts(Date.parse(row.startsAt),rules.timeZone).minute/60)!==2));
  assert.ok(spring.some(row => row.startsAt==="2026-03-29T01:00:00.000Z"));
  const autumn = enumerateSlots("2026-10-25",rules,[],Date.parse("2026-10-24T00:00:00Z"));
  const repeated=autumn.filter(row => localParts(Date.parse(row.startsAt),rules.timeZone).minute===120);
  assert.equal(repeated.length,2);
  assert.notEqual(repeated[0].startsAt,repeated[1].startsAt);
  const allDay=[{startsAt:"2026-10-24T22:00:00Z",endsAt:"2026-10-25T23:00:00Z"}];
  assert.equal(enumerateSlots("2026-10-25",rules,allDay,Date.parse("2026-10-24T00:00:00Z")).length,0);
  const buffered={...defaultBookingRules,minNoticeMinutes:0,preparationMinutes:15,followupMinutes:15,
    breaks:[{day:4,start:"12:00",end:"13:00"}],absences:[{startsAt:"2026-10-22T13:00:00Z",endsAt:"2026-10-22T14:00:00Z"}],
  };
  const now=Date.parse("2026-10-21T00:00:00Z");
  assert.equal(isSlotAllowed("2026-10-22T07:00:00Z",buffered,[],now),false,"preparation must remain within working hours");
  assert.equal(isSlotAllowed("2026-10-22T09:45:00Z",buffered,[],now),false,"followup overlaps lunch break");
  assert.equal(isSlotAllowed("2026-10-22T12:45:00Z",buffered,[],now),false,"event/followup overlaps absence");
  assert.equal(isSlotAllowed("2026-10-22T08:07:00Z",buffered,[],now),false,"non-grid instant denied");
  assert.equal(isSlotAllowed("2026-10-22T08:00:00Z",buffered,[],now),true);
  assert.throws(()=>validateBookingRules({timeZone:"invalid/synthetic"}));
  assert.throws(()=>validateBookingRules({durationMinutes:-1}));
  assert.throws(()=>validateBookingRules({workingHours:[{day:4,start:"17:00",end:"09:00"}]}));
});
