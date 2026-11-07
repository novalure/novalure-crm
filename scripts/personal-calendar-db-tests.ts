import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import type { AppSession } from "../src/lib/auth/session";
import { getRolePermissions } from "../src/lib/auth/permissions";
import { getProductRoleCapabilities } from "../src/lib/product-model";
import { withTenantTransaction, type TenantPool } from "../src/lib/db/tenant-client";
import { closeLocalTestPool } from "../src/lib/db/local-test-transport";
import { upsertCalendarEventRecord } from "../src/lib/db/crm-write-repositories";
import { listPersonalCalendarEvents, mutatePersonalCalendar, type PersonalCalendarOptions } from "../src/lib/db/personal-calendar-repository";
import { BookingProviderError } from "../src/lib/booking/providers";
import { createBookingOAuthState, consumeBookingOAuthState } from "../src/lib/booking/connections";
import { internalBusy, withBookingTransaction } from "../src/lib/booking/repository";
import type { BookingProvider, BookingProviderName, ProviderEvent, ProviderWrite } from "../src/lib/booking/types";
import type { PersonalCalendarDraft, PersonalCalendarEvent } from "../src/lib/personal-calendar";
import { startDesignCIntegrationDatabase } from "./lib/design-c-integration-fixture.mjs";

function gate() {
  let enter!: () => void, release!: () => void;
  const ready = new Promise<void>(resolve => { enter = resolve; });
  const waiting = new Promise<void>(resolve => { release = resolve; });
  return { ready, release, async wait() { enter(); await waiting; } };
}
type Gate = ReturnType<typeof gate>;
const code = (expected: string) => (error: unknown) => (error as { code?: string }).code === expected;
const deniedSql = (error: unknown) => ["42501", "23503", "23514"].includes((error as { code: string }).code);

/** Simulated ports only: real PostgreSQL/tenant/RLS/journal execution, no provider I/O. */
class CalendarPort implements BookingProvider {
  events = new Map<string, ProviderEvent>();
  creates = 0; updates = 0; deletes = 0; lookups = 0;
  timeoutAfterCreate = false; missingLookup = false; rejectUpdate = false; rejectCreate = false;
  rejectNextLookup = false;
  resolveReadbackNames = false; extraReadbackAttendee: { email: string; name: string } | null = null;
  factoryGate: Gate | null = null; afterCreateGate: Gate | null = null;
  async listBusy() { return []; }
  event(input: ProviderWrite): ProviderEvent {
    return { eventId: `synthetic-${input.bookingId}`, etag: `"${input.operationId}"`, startsAt: input.startsAt, endsAt: input.endsAt,
      onlineMeetingUrl: null, videoStatus: "none", cancelled: false,
      content: { title: input.title, location: input.location, attendees: structuredClone(input.standaloneAttendees ?? []), timeZone: input.timeZone, operationId: input.operationId } };
  }
  async create(input: ProviderWrite) {
    this.creates++;
    if (this.rejectCreate) throw new BookingProviderError("synthetic_create_rejected", "rejected", 403);
    const event = this.event(input); this.events.set(input.bookingId, event);
    const hold = this.afterCreateGate; this.afterCreateGate = null; if (hold) await hold.wait();
    if (this.timeoutAfterCreate) { this.timeoutAfterCreate = false; throw new BookingProviderError("synthetic_timeout_after_commit", "unknown"); }
    return structuredClone(event);
  }
  async lookup(input: { bookingId: string }) {
    this.lookups++;
    if (this.rejectNextLookup) {
      this.rejectNextLookup = false;
      throw new BookingProviderError("provider_request_failed", "rejected", 503);
    }
    const event = this.missingLookup ? null : structuredClone(this.events.get(input.bookingId) ?? null);
    if (event?.content) {
      if (this.resolveReadbackNames) event.content.attendees = event.content.attendees.map(a => ({ ...a, name: "SYNTHETIC provider-resolved display name" }));
      if (this.extraReadbackAttendee) event.content.attendees.push(this.extraReadbackAttendee);
    }
    return event;
  }
  async update(input: ProviderWrite & { eventId: string; etag: string | null }) {
    this.updates++; const current = this.events.get(input.bookingId); assert.ok(current);
    if (this.rejectUpdate || current.etag !== input.etag) throw new BookingProviderError("provider_event_changed", "rejected", 412);
    assert.equal(input.eventId, current.eventId); const event = this.event(input); this.events.set(input.bookingId, event); return structuredClone(event);
  }
  async delete(input: Parameters<BookingProvider["delete"]>[0]) {
    this.deletes++; const current = this.events.get(input.bookingId); assert.ok(current); assert.equal(input.eventId, current.eventId);
    if (current.etag !== input.etag) throw new BookingProviderError("provider_event_changed", "rejected", 412);
    this.events.set(input.bookingId, { ...current, cancelled: true, etag: `"cancelled-${input.operationId}"` });
  }
}

test("personal calendar journal: real local PostgreSQL and tenant boundaries, simulated providers only", { timeout: 240_000 }, async t => {
  const saved = { ...process.env }, originalFetch = globalThis.fetch;
  let networkRequests = 0;
  globalThis.fetch = async () => { networkRequests++; throw new Error("NO_NETWORK_ALLOWED_IN_PERSONAL_CALENDAR_DB_TEST"); };
  const db = await startDesignCIntegrationDatabase({ bookingSetup: true });
  try {
    await db.admin.query(await readFile("migrations/193_personal_crm_calendar.sql", "utf8"));
    for (const key of ["VERCEL", "VERCEL_ENV", "VERCEL_URL", "BOOKING_PRODUCTION_ENABLED"]) delete process.env[key];
    Object.assign(process.env, { NODE_ENV: "test", CRM_LOCAL_TEST_DATABASE: "1", DATABASE_URL: `postgresql://${db.role}@127.0.0.1:${db.port}/neondb`, BOOKING_MESSAGES_ENABLED: "1" });
    const tenantA = randomUUID(), tenantB = randomUUID();
    for (const id of [tenantA, tenantB]) {
      await db.admin.query("insert into workspaces(id,name,operating_model,customer_type) values($1,'SYNTHETIC PERSONAL CALENDAR','self_service_customer','general_company')", [id]);
      await db.admin.query("insert into workspace_module_settings(workspace_id,module_key,enabled) values($1,'calendar',true)", [id]);
    }
    async function actor(workspaceId = tenantA, restricted = false) {
      const userId = randomUUID(), role = restricted ? "agent" : "owner", productRole = restricted ? "project_sales_member" : "customer_owner";
      await db.admin.query("insert into workspace_users(id,workspace_id,name,email,role,product_role,status) values($1,$2,'SYNTHETIC organizer',$3,$4,$5,'active')", [userId, workspaceId, `${userId}@example.invalid`, role, productRole]);
      const session = { authenticated: true, source: "database", workspaceId, userId, workspaceName: "SYNTHETIC PERSONAL CALENDAR", name: "Synthetic", email: `${userId}@example.invalid`, role, productRole,
        permissions: getRolePermissions(role), productPermissions: getProductRoleCapabilities(productRole), workspaceOperatingModel: "self_service_customer", workspaceCustomerType: "general_company" } as AppSession;
      const bindings = {} as Record<BookingProviderName, { connectionId: string; calendarId: string; accountId: string; revision: number }>;
      const ports = { microsoft: new CalendarPort(), google: new CalendarPort() };
      for (const provider of ["microsoft", "google"] as const) {
        bindings[provider] = { connectionId: randomUUID(), calendarId: `synthetic-calendar-${randomUUID()}`, accountId: `synthetic-account-${randomUUID()}`, revision: 1 };
        const b = bindings[provider];
        await db.admin.query("insert into booking_calendar_connections(id,workspace_id,user_id,provider,status,account_id,write_calendar_id) values($1,$2,$3,$4,'connected',$5,$6)", [b.connectionId, workspaceId, userId, provider, b.accountId, b.calendarId]);
      }
      let now = Date.parse("2026-11-05T12:00:00.000Z");
      const options: PersonalCalendarOptions = { pool: db.pool as unknown as TenantPool, now: () => now,
        providerFactory: async (scope, provider) => { assert.deepEqual(scope, { workspaceId, actorId: userId }); const p = ports[provider], hold = p.factoryGate; p.factoryGate = null; if (hold) await hold.wait(); return p; },
        connectionResolver: async (scope, provider) => { assert.deepEqual(scope, { workspaceId, actorId: userId }); return bindings[provider]; } };
      const sql = <T extends Record<string, unknown>>(query: string, params: unknown[] = []) => withTenantTransaction({ workspaceId, actorId: userId }, tx => tx.query<T>(query, params), { pool: db.pool as unknown as TenantPool });
      const draft = (patch: Partial<PersonalCalendarDraft> = {}): PersonalCalendarDraft => ({ title: "SYNTHETIC appointment", startsAt: "2027-03-28T00:30:00.000Z", endsAt: "2027-03-28T01:30:00.000Z", timeZone: "Europe/Vienna", location: "SYNTHETIC room", projectId: null, attendees: [], ...patch });
      const create = (provider: BookingProviderName = "google", patch: Partial<PersonalCalendarDraft> = {}, idempotencyKey = randomUUID()) => ({ action: "create", provider, event: draft(patch), idempotencyKey, invitationsConfirmed: true });
      const mutate = (input: Record<string, unknown>) => mutatePersonalCalendar(session, input, options);
      const refresh = (event: PersonalCalendarEvent, extra = {}) => mutate({ action: "refresh", eventId: event.id, expectedVersion: event.version, idempotencyKey: randomUUID(), ...extra });
      return { workspaceId, userId, session, bindings, ports, options, sql, draft, create, mutate, refresh, advance: (ms: number) => { now += ms; } };
    }

    await t.test("confirmed create/update/cancel requires readback and mirrors exactly one CRM row for each provider", async () => {
      for (const provider of ["google", "microsoft"] as const) {
        const a = await actor(), request = a.create(provider); const created = await a.mutate(request);
        assert.equal(created.state, "synced"); assert.ok(created.providerEventId); assert.ok(created.remoteSnapshot?.verifiedAt);
        const replay = await a.mutate(request); assert.equal(replay.id, created.id); assert.equal(replay.version, created.version); assert.equal(a.ports[provider].creates, 1);
        const changed = await a.mutate({ action: "update", idempotencyKey: randomUUID(), eventId: created.id, expectedVersion: created.version, event: a.draft({ title: "SYNTHETIC changed" }), invitationsConfirmed: true });
        assert.equal(changed.state, "synced"); assert.equal(changed.event.title, "SYNTHETIC changed");
        const cancelled = await a.mutate({ action: "cancel", idempotencyKey: randomUUID(), eventId: changed.id, expectedVersion: changed.version, invitationsConfirmed: true });
        assert.equal(cancelled.state, "cancelled");
        const rows = await db.admin.query("select status,title,metadata from calendar_events where id=$1", [created.id]);
        assert.equal(rows.rowCount, 1); assert.equal(rows.rows[0].status, "abgesagt"); assert.equal(rows.rows[0].title, "SYNTHETIC changed");
      }
    });
    await t.test("concurrent same-key create and an explicit replay never create twice", async () => {
      const a = await actor(), wait = gate(); a.ports.google.afterCreateGate = wait;
      const request = a.create(); const first = a.mutate(request); await wait.ready;
      await assert.rejects(withBookingTransaction(a.session, (tx, fresh) => internalBusy(tx, fresh), a.options), code("PERSONAL_CALENDAR_RECONCILIATION_REQUIRED"));
      const concurrent = await a.mutate(request); assert.equal(concurrent.state, "processing"); assert.equal(a.ports.google.creates, 1);
      wait.release(); const saved = await first; assert.equal(saved.state, "synced"); assert.equal((await a.mutate(request)).id, saved.id);
      await assert.doesNotReject(withBookingTransaction(a.session, (tx, fresh) => internalBusy(tx, fresh), a.options));
      await assert.rejects(a.mutate({ ...request, event: a.draft({ attendees: [{ email: "calendar-recipient@example.invalid", name: "Synthetic changed participant" }] }) }), code("personal_calendar_idempotency_conflict"));
      assert.equal(a.ports.google.creates, 1);
    });
    await t.test("pending duplicate losing its version race stays uncertain until the immutable receipt is replayed", async () => {
      const a = await actor(), afterCreate = gate(), request = a.create();
      a.ports.google.afterCreateGate = afterCreate;
      const first = a.mutate(request); await afterCreate.ready;
      let duplicateCommitted = false;
      const duplicatePool: TenantPool = {
        async connect() {
          const client = await db.pool.connect();
          return new Proxy(client, {
            get(target, property) {
              const value = Reflect.get(target, property, target);
              if (property === "query") return async (...args: unknown[]) => {
                const result = await Reflect.apply(value, target, args);
                if (!duplicateCommitted && typeof args[0] === "string" && args[0].trim().toLowerCase() === "commit") {
                  duplicateCommitted = true; afterCreate.release(); await first;
                }
                return result;
              };
              return typeof value === "function" ? value.bind(target) : value;
            },
          }) as unknown as Awaited<ReturnType<TenantPool["connect"]>>;
        },
      };
      await assert.rejects(mutatePersonalCalendar(a.session, request, { ...a.options, pool: duplicatePool }), error => {
        const failure = error as { code?: string; status?: number; notStarted?: boolean };
        return failure.code === "personal_calendar_replay_changed" && failure.status === 409 && failure.notStarted !== true;
      });
      assert.equal(duplicateCommitted, true);
      const completed = await first; assert.equal(completed.state, "synced");
      assert.deepEqual(await a.mutate(request), completed); assert.equal(a.ports.google.creates, 1);
    });
    await t.test("timeout after remote commit stays unknown until lookup, without another create", async () => {
      const a = await actor(); a.ports.google.timeoutAfterCreate = true;
      const request = a.create(), uncertain = await a.mutate(request); assert.equal(uncertain.state, "uncertain"); assert.equal(uncertain.canEdit, false);
      await assert.rejects(withBookingTransaction(a.session, (tx, fresh) => internalBusy(tx, fresh), a.options), code("PERSONAL_CALENDAR_RECONCILIATION_REQUIRED"));
      const recovered = await a.mutate(request); assert.equal(recovered.state, "synced"); assert.equal(recovered.id, uncertain.id); assert.equal(a.ports.google.creates, 1);
      await assert.doesNotReject(withBookingTransaction(a.session, (tx, fresh) => internalBusy(tx, fresh), a.options));
      const b = await actor(); b.ports.google.timeoutAfterCreate = true; b.ports.google.missingLookup = true;
      const missingRequest = b.create(), missing = await b.mutate(missingRequest); assert.equal(missing.state, "uncertain");
      assert.equal((await b.mutate(missingRequest)).state, "uncertain"); assert.equal(b.ports.google.creates, 1);
      await assert.rejects(b.mutate(b.create()), code("personal_calendar_unresolved_operation"));
    });
    await t.test("a failed verification read after an acknowledged write is recoverable without another mutation", async () => {
      for (const provider of ["google", "microsoft"] as const) {
        const a = await actor(), port = a.ports[provider], create = a.create(provider);
        port.rejectNextLookup = true;
        const pending = await a.mutate(create);
        assert.equal(pending.state, "uncertain");
        assert.equal(pending.canCancel, false);
        assert.equal(pending.providerEventId, port.events.get(pending.id)?.eventId);
        await assert.rejects(a.mutate(a.create(provider)), code("personal_calendar_unresolved_operation"));
        const cancel = (event: PersonalCalendarEvent) => ({
          action: "cancel", eventId: event.id, expectedVersion: event.version, idempotencyKey: randomUUID()
        });
        await assert.rejects(a.mutate(cancel(pending)), code("personal_calendar_reconcile_required"));
        const saved = await a.mutate(create);
        assert.equal(saved.state, "synced");
        const update = {action: "update", eventId: saved.id, expectedVersion: saved.version,
          idempotencyKey: randomUUID(), event: a.draft({title: "SYNTHETIC acknowledged edit"})};
        port.rejectNextLookup = true;
        assert.equal((await a.mutate(update)).state, "uncertain");
        const edited = await a.mutate(update);
        assert.equal(edited.state, "synced");
        assert.equal(edited.event.title, update.event.title);
        const remove = cancel(edited);
        port.rejectNextLookup = true;
        assert.equal((await a.mutate(remove)).state, "uncertain");
        assert.equal((await a.mutate(remove)).state, "cancelled");
        assert.deepEqual([port.creates, port.updates, port.deletes], [1, 1, 1]);
      }
    });
    await t.test("repeated reads of a conflict require explicit import before editing", async () => {
      const a = await actor(), port = a.ports.google, command = a.create(), hold = gate();
      port.afterCreateGate = hold;
      const writing = a.mutate(command);
      await hold.ready;
      const [id, remote] = [...port.events.entries()][0];
      remote.content!.title = "SYNTHETIC concurrent provider title";
      hold.release();
      const conflict = await writing;
      assert.equal(conflict.state, "conflict");
      const checked = await a.refresh(conflict);
      assert.equal(checked.state, "conflict");
      assert.equal(checked.canEdit, false);
      assert.notEqual(checked.event.title, checked.remoteSnapshot?.title);
      const update = { action: "update", eventId: id, idempotencyKey: randomUUID(),
        expectedVersion: checked.version, event: a.draft({ location: "SYNTHETIC second room" }) };
      await assert.rejects(a.mutate(update), code("personal_calendar_reconcile_required"));
      assert.equal(port.updates, 0);
      const imported = await a.mutate({action: "import_remote", eventId: id, expectedVersion: checked.version,
        remoteEtag: checked.remoteSnapshot!.etag, idempotencyKey: randomUUID()});
      assert.equal(imported.state, "synced");
      assert.equal(imported.event.title, remote.content!.title);
      const prior = await a.sql("select state,error_code from crm_personal_calendar_operations where id=$1",[command.idempotencyKey]);
      assert.deepEqual(prior, [{state:"rejected",error_code:"personal_calendar_conflict_resolved_by_import"}]);
      assert.equal((await a.mutate(command)).state, "conflict");
      const updated = await a.mutate({...update, expectedVersion: imported.version,
        event: {...imported.event, location: update.event.location}});
      assert.equal(updated.event.title, remote.content!.title);
      assert.equal(port.events.get(id)?.content?.title, remote.content!.title);
    });
    await t.test("expired/stolen lease cannot send or finalize an obsolete worker", async () => {
      const a = await actor(), wait = gate(); a.ports.google.factoryGate = wait;
      const first = a.mutate(a.create()); await wait.ready;
      const processing = (await listPersonalCalendarEvents(a.session, a.options))[0]; a.advance(60_001);
      const reconciled = await a.refresh(processing); assert.equal(reconciled.state, "uncertain");
      wait.release(); assert.equal((await first).state, "uncertain"); assert.equal(a.ports.google.creates, 0);
      const b = await actor(), after = gate(); b.ports.google.afterCreateGate = after;
      const original = b.mutate(b.create()); await after.ready; b.advance(60_001);
      const active = (await listPersonalCalendarEvents(b.session, b.options))[0], recovered = await b.refresh(active); assert.equal(recovered.state, "synced");
      after.release(); const stale = await original; assert.equal(stale.version, recovered.version); assert.equal(b.ports.google.creates, 1);
      const c = await actor(), expired = gate(); c.ports.google.factoryGate = expired;
      const noReplacement = c.mutate(c.create()); await expired.ready; c.advance(60_001); expired.release();
      assert.ok(["failed", "uncertain"].includes((await noReplacement).state)); assert.equal(c.ports.google.creates, 0, "an expired lease alone cannot authorize a late write");
    });
    await t.test("personal rows and journals are invisible to another manager and another tenant", async () => {
      const a = await actor(), other = await actor(), foreign = await actor(tenantB), created = await a.mutate(a.create());
      for (const outsider of [other, foreign]) {
        assert.equal((await listPersonalCalendarEvents(outsider.session, outsider.options)).length, 0);
        assert.equal((await outsider.sql("select id from calendar_events where id=$1", [created.id])).length, 0);
        assert.equal((await outsider.sql("select id from crm_personal_calendar_operations where event_id=$1", [created.id])).length, 0);
        assert.equal((await outsider.sql("select event_id from crm_personal_calendar_binding_locks where event_id=$1", [created.id])).length, 0);
        assert.equal((await outsider.sql("update calendar_events set title='MUST NOT CHANGE' where id=$1 returning id", [created.id])).length, 0);
        await assert.rejects(outsider.mutate({ action: "refresh", eventId: created.id, expectedVersion: created.version, idempotencyKey: randomUUID() }), code("personal_calendar_not_found"));
      }
    });
    await t.test("raw SQL cannot forge cross-workspace/other-owner mapping or strip personal privacy marker", async () => {
      const a = await actor(), other = await actor(), foreign = await actor(tenantB), created = await a.mutate(a.create());
      for (const target of [other, foreign]) {
        const id = randomUUID(); await db.admin.query("insert into calendar_events(id,workspace_id,owner_user_id,title,starts_at,ends_at) values($1,$2,$3,'SYNTHETIC ordinary event',now(),now()+interval '1 hour')", [id, target.workspaceId, target.userId]);
        await assert.rejects(a.sql("insert into crm_personal_calendar_events(id,workspace_id,actor_id,provider,connection_id,connection_revision,account_id,calendar_id,event,state) values($1,$2,$3,'google',$4,1,$5,$6,$7::jsonb,'failed') returning id", [id, a.workspaceId, a.userId, a.bindings.google.connectionId, a.bindings.google.accountId, a.bindings.google.calendarId, JSON.stringify(a.draft())]), deniedSql);
      }
      await assert.rejects(a.sql("update calendar_events set metadata=metadata-'source' where id=$1 returning id", [created.id]), deniedSql);
      await assert.rejects(a.sql("update calendar_events set owner_user_id=$2 where id=$1 returning id", [created.id, other.userId]), deniedSql);
      const movedProject = randomUUID(); await db.admin.query("insert into projects(id,workspace_id,name,type) values($1,$2,'SYNTHETIC different project','Service')", [movedProject, tenantA]);
      await assert.rejects(a.sql("update calendar_events set project_id=$2 where id=$1 returning id", [created.id, movedProject]), deniedSql);
      const roles = await db.pool.query("select rolsuper,rolbypassrls from pg_roles where rolname=current_user"); assert.equal(roles.rows[0].rolsuper, false); assert.equal(roles.rows[0].rolbypassrls, false);
      const rls = await db.admin.query("select relrowsecurity,relforcerowsecurity from pg_class where oid=any($1::regclass[])", [["calendar_events", "crm_personal_calendar_events", "crm_personal_calendar_operations"]]);
      assert.ok(rls.rows.every(row => row.relrowsecurity && row.relforcerowsecurity));
    });
    await t.test("project/member/connection revocation stops the current identity before provider mutation", async () => {
      const personal = await actor(tenantA, true); assert.equal((await personal.mutate(personal.create())).state, "synced", "a permitted member can own an unprojected personal appointment");
      const a = await actor(tenantA, true), projectId = randomUUID();
      await db.admin.query("insert into projects(id,workspace_id,name,type) values($1,$2,'SYNTHETIC restricted project','Service')", [projectId, tenantA]);
      await db.admin.query("insert into project_pipeline_permissions(workspace_id,project_id,user_id,can_read,can_edit_deals) values($1,$2,$3,true,true)", [tenantA, projectId, a.userId]);
      const created = await a.mutate(a.create("google", { projectId })); assert.equal(created.state, "synced");
      await db.admin.query("update project_pipeline_permissions set can_edit_deals=false where workspace_id=$1 and user_id=$2", [tenantA, a.userId]);
      assert.equal((await listPersonalCalendarEvents(a.session, a.options)).length, 0);
      const locks = await a.sql("select * from crm_personal_calendar_binding_locks where event_id=$1", [created.id]);
      assert.equal(locks.length, 1); assert.equal(locks[0].state, "synced"); assert.equal(locks[0].connection_id, a.bindings.google.connectionId);
      assert.deepEqual(Object.keys(locks[0]).sort(), ["workspace_id", "actor_id", "event_id", "connection_id", "state", "ends_at"].sort(), "the actor-only blocker contains no project, title, participant or provider content");
      assert.equal((await a.sql("select exists(select 1 from crm_personal_calendar_binding_locks where workspace_id=$1 and actor_id=$2 and connection_id=$3 and (state in ('processing','uncertain','conflict') or (state='synced' and ends_at>now()))) as blocked", [a.workspaceId, a.userId, a.bindings.google.connectionId]))[0].blocked, true);
      const otherActor = await actor(); assert.equal((await otherActor.sql("select event_id from crm_personal_calendar_binding_locks where event_id=$1", [created.id])).length, 0);
      await assert.rejects(a.refresh(created)); assert.equal(a.ports.google.updates, 0);
      const b = await actor(), wait = gate(); b.ports.google.factoryGate = wait; const inFlight = b.mutate(b.create()); await wait.ready;
      await db.admin.query("update workspace_users set status='suspended' where id=$1", [b.userId]); wait.release(); await assert.rejects(inFlight); assert.equal(b.ports.google.creates, 0);
      const committed = await actor(), afterCommit = gate(), committedRequest = committed.create(); committed.ports.google.afterCreateGate = afterCommit;
      const lostConfirmation = committed.mutate(committedRequest); await afterCommit.ready;
      assert.equal(committed.ports.google.creates, 1); assert.equal(committed.ports.google.events.size, 1, "the provider has already persisted before membership is revoked");
      await db.admin.query("update workspace_users set status='suspended' where id=$1", [committed.userId]);
      const forbidden = assert.rejects(lostConfirmation, error => (error as { code?: string }).code === "FORBIDDEN" && (error as { notStarted?: boolean }).notStarted !== true);
      afterCommit.release(); await forbidden;
      const unconfirmed = (await db.admin.query("select state from crm_personal_calendar_events where actor_id=$1", [committed.userId])).rows[0];
      assert.ok(["processing", "uncertain"].includes(unconfirmed.state), "a post-commit 403 is not proof that no provider write occurred");
      await db.admin.query("update workspace_users set status='active' where id=$1", [committed.userId]); committed.advance(61_000);
      const reconciled = await committed.mutate(committedRequest); assert.equal(reconciled.state, "synced"); assert.equal(committed.ports.google.creates, 1, "restored authority replays lookup, never a second create");
      const c = await actor(), saved = await c.mutate(c.create());
      await db.admin.query("update booking_calendar_connections set status='disconnected',revision=revision+1 where id=$1", [c.bindings.google.connectionId]);
      await assert.rejects(c.mutate({ action: "update", eventId: saved.id, expectedVersion: saved.version, idempotencyKey: randomUUID(), event: c.draft({ title: "MUST NOT SAVE" }), invitationsConfirmed: true }), code("personal_calendar_connection_changed"));
      assert.equal(c.ports.google.updates, 0);
      const d = await actor(), changedBinding = gate(); d.ports.google.factoryGate = changedBinding;
      const pending = d.mutate(d.create()); await changedBinding.ready;
      await db.admin.query("update booking_calendar_connections set write_calendar_id='synthetic-new-calendar',revision=revision+1 where id=$1", [d.bindings.google.connectionId]);
      changedBinding.release(); assert.notEqual((await pending).state, "synced"); assert.equal(d.ports.google.creates, 0);
      const fixed = (await db.admin.query("select calendar_id from crm_personal_calendar_events where actor_id=$1", [d.userId])).rows[0]; assert.equal(fixed.calendar_id, d.bindings.google.calendarId, "an old intent is never retargeted to the new calendar");
      const e = await actor(); await db.admin.query("update workspace_module_settings set enabled=false where workspace_id=$1 and module_key='calendar'", [tenantA]);
      try { await assert.rejects(e.mutate(e.create()), code("BOOKING_MODULE_REQUIRED")); assert.equal(e.ports.google.creates, 0); }
      finally { await db.admin.query("update workspace_module_settings set enabled=true where workspace_id=$1 and module_key='calendar'", [tenantA]); }
    });
    await t.test("stale versions and remote conflicts do not overwrite CRM; explicit import uses the verified snapshot", async () => {
      const a = await actor(), saved = await a.mutate(a.create());
      await assert.rejects(a.mutate({ action: "update", eventId: saved.id, expectedVersion: saved.version - 1, idempotencyKey: randomUUID(), event: a.draft(), invitationsConfirmed: true }), code("personal_calendar_version_conflict"));
      const remote = a.ports.google.events.get(saved.id)!; remote.etag = '"external-change"'; remote.content!.title = "SYNTHETIC external change";
      const conflict = await a.refresh(saved); assert.equal(conflict.state, "conflict"); assert.equal(conflict.event.title, saved.event.title); assert.equal(conflict.canImport, true);
      const input = { action: "import_remote", eventId: conflict.id, expectedVersion: conflict.version, remoteEtag: conflict.remoteSnapshot!.etag, idempotencyKey: randomUUID() };
      const imported = await a.mutate(input); assert.equal(imported.state, "synced"); assert.equal(imported.event.title, "SYNTHETIC external change");
      const replay = await a.mutate(input); assert.equal(replay.version, imported.version, "explicit import has a durable replay receipt");
      assert.equal((await db.admin.query("select title from calendar_events where id=$1", [saved.id])).rows[0].title, imported.event.title);
      assert.equal(a.ports.google.updates, 0);
    });
    await t.test("participants require explicit confirmation/allowlist and changing a committed request conflicts", async () => {
      const a = await actor(); process.env.PERSONAL_CALENDAR_INVITATION_BINDINGS_JSON = JSON.stringify(["google", "microsoft"].map(provider => {
        const b = a.bindings[provider as BookingProviderName];
        return { workspaceId: a.workspaceId, userId: a.userId, connectionId: b.connectionId, connectionRevision: b.revision, accountId: b.accountId, calendarId: b.calendarId, recipientEmails: ["calendar-recipient@example.invalid"] };
      }));
      a.ports.google.resolveReadbackNames = true;
      const request = a.create("google", { attendees: [{ email: "calendar-recipient@example.invalid", name: "SYNTHETIC controlled participant" }] });
      const saved = await a.mutate(request); assert.equal(saved.state, "synced"); assert.equal(a.ports.google.events.get(saved.id)!.content!.attendees.length, 1);
      assert.equal(saved.remoteSnapshot?.attendees[0].name, "SYNTHETIC provider-resolved display name", "provider display-name resolution does not change the recipient email set");
      await assert.rejects(a.mutate({ ...request, invitationsConfirmed: false }), code("personal_calendar_idempotency_conflict"));
      await assert.rejects(a.mutate({ ...request, event: { ...request.event, attendees: [{ email: "calendar-recipient@example.invalid", name: "SYNTHETIC changed command name" }] } }), code("personal_calendar_idempotency_conflict"));
      const removed = await a.mutate({ action: "update", eventId: saved.id, expectedVersion: saved.version, idempotencyKey: randomUUID(), event: a.draft(), invitationsConfirmed: true }); assert.equal(removed.state, "synced");
      const b = await actor(), denied = await b.mutate(b.create("google", { attendees: [{ email: "not-registered@example.invalid", name: "SYNTHETIC unregistered" }] }));
      assert.notEqual(denied.state, "synced"); assert.equal(b.ports.google.creates, 0);
      const c = await actor(); c.ports.google.extraReadbackAttendee = { email: "unexpected@example.invalid", name: "SYNTHETIC unexpected recipient" };
      const unexpected = await c.mutate(c.create()); assert.equal(unexpected.state, "conflict"); assert.equal(unexpected.event.attendees.length, 0, "an extra provider recipient cannot silently become the accepted local participant set");
    });
    await t.test("UTC instants across Vienna DST persist exactly and legacy mutation cannot bypass the journal", async () => {
      const a = await actor();
      for (const [startsAt, endsAt] of [["2027-03-28T00:30:00.000Z", "2027-03-28T01:30:00.000Z"], ["2027-10-31T00:30:00.000Z", "2027-10-31T01:30:00.000Z"]]) {
        const saved = await a.mutate(a.create("google", { startsAt, endsAt }));
        const row = (await db.admin.query("select to_char(starts_at at time zone 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') as start,to_char(ends_at at time zone 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') as finish from calendar_events where id=$1", [saved.id])).rows[0];
        assert.equal(row.start, startsAt); assert.equal(row.finish, endsAt);
        const legacy = await upsertCalendarEventRecord({ session: a.session, event: { id: saved.id, title: "MUST NOT OVERWRITE", startsAt, endsAt } }); assert.equal(legacy.persisted, false);
      }
      const forged = await upsertCalendarEventRecord({ session: a.session, event: { title: "SYNTHETIC forged marker", startsAt: a.draft().startsAt, endsAt: a.draft().endsAt, metadata: { source: "personal_standalone_calendar" } } }); assert.equal(forged.persisted, false);
    });
    await t.test("definitively rejected create can be discarded locally after disconnection without another provider write", async () => {
      const a = await actor(); a.ports.google.rejectCreate = true;
      const rejected = await a.mutate(a.create()); assert.equal(rejected.state, "failed"); assert.equal(rejected.providerEventId, null); assert.equal(a.ports.google.events.size, 0);
      await db.admin.query("update booking_calendar_connections set status='disconnected',revision=revision+1 where id=$1", [a.bindings.google.connectionId]);
      const input = { action: "cancel", eventId: rejected.id, expectedVersion: rejected.version, idempotencyKey: randomUUID(), invitationsConfirmed: false };
      const discarded = await a.mutate(input); assert.equal(discarded.state, "cancelled"); assert.equal((await a.mutate(input)).version, discarded.version);
      assert.equal(a.ports.google.creates, 1); assert.equal(a.ports.google.updates, 0); assert.equal(a.ports.google.deletes, 0);
      assert.equal((await db.admin.query("select status from calendar_events where id=$1", [rejected.id])).rows[0].status, "abgesagt");
    });
    await t.test("an external tombstone becomes a conflict until explicit nullable-etag import and durable replay", async () => {
      const a = await actor(), created = await a.mutate(a.create()), previous = a.ports.google.events.get(created.id)!;
      a.ports.google.events.set(created.id, { ...previous, cancelled: true, etag: null, content: undefined, startsAt: "1970-01-01T00:00:00.000Z", endsAt: "1970-01-01T00:00:00.000Z" });
      const conflict = await a.refresh(created); assert.equal(conflict.state, "conflict"); assert.equal(conflict.remoteSnapshot?.cancelled, true); assert.equal(conflict.canImport, true);
      assert.equal(conflict.remoteSnapshot?.startsAt, created.event.startsAt); assert.equal(conflict.remoteSnapshot?.endsAt, created.event.endsAt);
      const input = { action: "import_remote", eventId: conflict.id, expectedVersion: conflict.version, remoteEtag: null, idempotencyKey: randomUUID() };
      const imported = await a.mutate(input); assert.equal(imported.state, "cancelled"); assert.equal((await a.mutate(input)).version, imported.version);
      assert.equal(a.ports.google.deletes, 0); assert.equal((await db.admin.query("select status from calendar_events where id=$1", [created.id])).rows[0].status, "abgesagt");
    });
    await t.test("old create/update replays retain their original receipt after a later edit", async () => {
      const a = await actor(), createRequest = a.create(), created = await a.mutate(createRequest);
      const updateRequest = { action: "update", eventId: created.id, expectedVersion: created.version, idempotencyKey: randomUUID(), event: a.draft({ title: "SYNTHETIC receipt two" }), invitationsConfirmed: true };
      const updated = await a.mutate(updateRequest);
      const latest = await a.mutate({ ...updateRequest, expectedVersion: updated.version, idempotencyKey: randomUUID(), event: a.draft({ title: "SYNTHETIC receipt three" }) });
      assert.deepEqual(await a.mutate(createRequest), created); assert.deepEqual(await a.mutate(updateRequest), updated);
      assert.equal((await listPersonalCalendarEvents(a.session, a.options))[0].version, latest.version);
      assert.equal((await db.admin.query("select title from calendar_events where id=$1", [created.id])).rows[0].title, "SYNTHETIC receipt three");
      assert.equal(a.ports.google.creates, 1); assert.equal(a.ports.google.updates, 2);
    });
    await t.test("raw mapping insert/update cannot mismatch the exact provider connection identity", async () => {
      const a = await actor(), created = await a.mutate(a.create()), spareId = randomUUID();
      await db.admin.query("insert into calendar_events(id,workspace_id,owner_user_id,title,starts_at,ends_at,metadata) values($1,$2,$3,'SYNTHETIC spare',now(),now()+interval '1 hour','{\"source\":\"personal_standalone_calendar\"}')", [spareId, a.workspaceId, a.userId]);
      for (const patch of [{ provider: "microsoft" }, { accountId: "synthetic-wrong-account" }, { calendarId: "synthetic-wrong-calendar" }, { revision: 99 }]) {
        const b = { provider: "google", ...a.bindings.google, ...patch };
        await assert.rejects(a.sql("insert into crm_personal_calendar_events(id,workspace_id,actor_id,provider,connection_id,connection_revision,account_id,calendar_id,event,state) values($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,'failed') returning id", [spareId, a.workspaceId, a.userId, b.provider, b.connectionId, b.revision, b.accountId, b.calendarId, JSON.stringify(a.draft())]), deniedSql);
      }
      for (const [column, value] of [["provider", "microsoft"], ["connection_id", a.bindings.microsoft.connectionId], ["account_id", "synthetic-wrong-account"], ["calendar_id", "synthetic-wrong-calendar"], ["connection_revision", 99]] as const) {
        await assert.rejects(a.sql(`update crm_personal_calendar_events set ${column}=$2 where id=$1 returning id`, [created.id, value]), deniedSql);
      }
    });
    await t.test("personal OAuth states are stored and consumed once by the exact actor/workspace while legacy booking remains compatible", async () => {
      process.env.OAUTH_STATE_SECRET = randomBytes(48).toString("base64url");
      const a = await actor(), other = await actor(), foreign = await actor(tenantB);
      const own = { workspaceId: a.workspaceId, actorId: a.userId };
      for (const provider of ["google", "microsoft"] as const) {
        const state = await createBookingOAuthState(own, provider, true); assert.ok(state.codeChallenge);
        assert.equal(await consumeBookingOAuthState({ workspaceId: other.workspaceId, actorId: other.userId }, provider, state.state), null);
        assert.equal(await consumeBookingOAuthState({ workspaceId: foreign.workspaceId, actorId: foreign.userId }, provider, state.state), null);
        assert.equal(await consumeBookingOAuthState(own, provider === "google" ? "microsoft" : "google", state.state), null);
        const consumed = await consumeBookingOAuthState(own, provider, state.state); assert.equal(consumed?.returnTo, "/calendar-personal"); assert.ok(consumed?.codeVerifier);
        assert.equal(await consumeBookingOAuthState(own, provider, state.state), null);
        const legacy = await createBookingOAuthState(own, provider, false); assert.equal((await consumeBookingOAuthState(own, provider, legacy.state))?.returnTo, "/booking");
      }
    });
    assert.equal(networkRequests, 0, "no real provider or other HTTP request may occur");
  } finally {
    await closeLocalTestPool(); await db.stop(); globalThis.fetch = originalFetch;
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
});
