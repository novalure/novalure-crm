import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { readFile } from "node:fs/promises";
import { POST, PATCH, DELETE } from "../src/app/api/crm/calendar-events/route";
import { POST as reconcile } from "../src/app/api/crm/commands/reconcile/route";
import { createCsrfToken } from "../src/lib/security/csrf-core";
import { safeSalesFetch } from "../src/lib/security/crm-safe-client";
import { calendarDraftInstant, calendarLocalDateTime, internalCalendarWriteBody, isUpcomingCalendarEvent } from "../src/lib/internal-calendar";
import { INTERNAL_CALENDAR_REVISION_SQL } from "../src/lib/db/internal-calendar-row";
import { loadCalendarEvents } from "../src/lib/db/crm-loaders";
import { closeLocalTestPool } from "../src/lib/db/local-test-transport";
import { withCrmRead } from "../src/lib/crm-command";
import { withTenantTransaction } from "../src/lib/db/tenant-client";
import { getRolePermissions } from "../src/lib/auth/permissions";
import { getProductRoleCapabilities } from "../src/lib/product-model";
import type { AppSession } from "../src/lib/auth/session";
import type { CalendarEvent } from "../src/lib/crm-types";
import { startLocalSalesDb, applySalesSchema } from "./lib/local-sales-db.mjs";
import { seedSalesBrowser } from "./lib/sales-browser-fixture.mjs";

test("Upcoming includes only visible current/future events, excluding cancelled and archived history", () => {
  const events = [
    { id: "future", startsAt: "2030-01-02T10:00:00Z", status: "geplant" },
    { id: "cancelled", startsAt: "2030-01-02T10:00:00Z", status: "abgesagt" },
    { id: "past", startsAt: "2029-01-01T10:00:00Z", status: "bestätigt" },
    { id: "archived", startsAt: "2030-01-02T10:00:00Z", status: "geplant", archived: true },
  ] as CalendarEvent[];
  assert.deepEqual(events.filter(event => isUpcomingCalendarEvent(event, new Date("2030-01-01T00:00:00Z"))).map(event => event.id), ["future"]);
  for (const instant of ["2027-10-31T02:15:12.345+01:00", "2027-10-31T02:15:12.345+02:00"]) {
    assert.equal(calendarDraftInstant(calendarLocalDateTime(instant), instant), instant);
  }
});

test("201 cutover refuses old pre-existing reserved markers without creating guards or changing business rows", { timeout: 120_000 }, async () => {
  const db = await startLocalSalesDb();
  try {
    await applySalesSchema(db, { maxMigrationNumber: 199 });
    const workspace = randomUUID(), id = randomUUID();
    await db.admin.query("insert into workspaces(id,name,operating_model,customer_type) values($1,'SYNTHETIC old marker','self_service_customer','property_developer')", [workspace]);
    await db.admin.query("insert into calendar_events(id,workspace_id,title,starts_at,ends_at,metadata) values($1,$2,'SYNTHETIC pre-cutover marker',now(),now()+interval '1 hour','{\"internalCalendarArchive\":{\"forged\":true}}')", [id, workspace]);
    const before = (await db.admin.query("select to_jsonb(c) as row from calendar_events c where id=$1", [id])).rows;
    const client = await db.admin.connect(); try {
      await client.query("begin");
      await assert.rejects(client.query(await readFile("migrations/201_internal_calendar_archive.sql", "utf8")), { code: "55000" });
      await client.query("rollback");
    } finally { client.release(); }
    assert.deepEqual((await db.admin.query("select to_jsonb(c) as row from calendar_events c where id=$1", [id])).rows, before);
    assert.equal((await db.admin.query("select to_regprocedure('crm_internal_calendar_archive_unlinked(uuid,uuid,uuid,uuid,uuid)') as helper")).rows[0].helper, null);
  } finally { await db.stop(); }
});

test("internal calendar uses real cookie/CSRF, exact command receipts and current scoped authorization", { timeout: 180_000 }, async t => {
  const db = await startLocalSalesDb({ separateBootstrap: true });
  const names = ["DATABASE_URL", "NODE_ENV", "CRM_LOCAL_TEST_DATABASE", "NOVALURE_SESSION_SECRET", "NOVALURE_APP_ORIGIN", "NOVALURE_AUTH_STRICT", "NOVALURE_AUTH_ENCRYPTION_KEY", "NOVALURE_AUTH_RATE_LIMIT_SECRET"];
  const original = Object.fromEntries(names.map(key => [key, process.env[key]]));
  let control: Pool | undefined;
  try {
    await applySalesSchema(db); const fixture = await seedSalesBrowser(db);
    const secret = randomBytes(48).toString("base64url"), origin = "http://127.0.0.1:3000", cookie = "v2." + randomBytes(32).toString("base64url");
    Object.assign(process.env, { DATABASE_URL: `postgresql://${db.role}@127.0.0.1:${db.port}/postgres`, NODE_ENV: "test", CRM_LOCAL_TEST_DATABASE: "1", NOVALURE_SESSION_SECRET: secret, NOVALURE_APP_ORIGIN: origin, NOVALURE_AUTH_STRICT: "1", NOVALURE_AUTH_ENCRYPTION_KEY: randomBytes(40).toString("hex"), NOVALURE_AUTH_RATE_LIMIT_SECRET: randomBytes(40).toString("hex") });
    const sessionId = randomUUID();
    await db.admin.query("insert into auth_sessions(id,token_hash,auth_identity_id,workspace_user_id,workspace_id,mfa_verified_at,expires_at) values($1,$2,$3,$4,$5,now(),now()+interval '1 hour')", [sessionId, createHash("sha256").update(cookie).digest("hex"), fixture.authIdentityId, fixture.userId, fixture.workspaceId]);
    const controller = "calendar_control_" + randomUUID().replaceAll("-", "");
    await db.admin.query(`create role ${controller} login superuser`);
    control = new Pool({ host: "127.0.0.1", port: db.port, user: controller, database: "postgres", max: 2 });
    // Keep the original owners and original policies. Demotion forces every definer through actual RLS.
    await control.query("alter role qa_admin nosuperuser noinherit nocreatedb nocreaterole noreplication nobypassrls");
    const ownerFlags = (await control.query("select rolsuper,rolinherit,rolbypassrls from pg_roles where rolname='qa_admin'")).rows[0];
    assert.deepEqual(ownerFlags, { rolsuper: false, rolinherit: false, rolbypassrls: false });
    t.diagnostic("Original schema owner tested as NOSUPERUSER NOINHERIT NOBYPASSRLS; runtime stays a separate non-owner with unchanged table grants");
    const session: AppSession = { authenticated: true, userId: fixture.userId, workspaceId: fixture.workspaceId, workspaceName: "SYNTHETIC", name: "SYNTHETIC", email: fixture.email, role: "owner", productRole: "novalureAdmin", permissions: getRolePermissions("owner"), productPermissions: getProductRoleCapabilities("novalureAdmin"), source: "database", authIdentityId: fixture.authIdentityId, authSessionId: sessionId };
    const predicate = (eventId: string, workspaceId = fixture.workspaceId, actorId = fixture.userId, token = sessionId, identity = fixture.authIdentityId) => withTenantTransaction({ workspaceId: session.workspaceId, actorId: session.userId }, tx => tx.queryOne<{ allowed: boolean }>("select crm_internal_calendar_archive_unlinked($1,$2,$3,$4,$5) as allowed", [workspaceId, actorId, eventId, token, identity])).then(row => row?.allowed);
    const path = "/api/crm/calendar-events?workspaceId=" + fixture.workspaceId;
    const meta = (): { key: string; correlation: string } => ({ key: randomUUID(), correlation: randomUUID() });
    const body = (title = "SYNTHETIC internal event") => ({ event: { title, projectId: fixture.projectId, ownerUserId: fixture.userId, startsAt: "2030-01-02T10:00:00+01:00", endsAt: "2030-01-02T11:00:00+01:00", location: "Telefon", status: "geplant", meetingProvider: "manual-link" } });
    const request = (target: string, method: string, value: unknown, metadata = meta(), csrf = true) => new Request(origin + target, { method, headers: { "Content-Type": "application/json", cookie: "novalure_session=" + cookie, origin, "sec-fetch-site": "same-origin", "Idempotency-Key": metadata.key, "X-Correlation-Id": metadata.correlation, ...(csrf ? { "x-novalure-csrf-token": createCsrfToken({ method, pathname: target.split("?")[0], secret, sessionCookie: cookie })!.token } : {}) }, body: JSON.stringify(value) });
    const invoke = (method: string, value: unknown, metadata = meta()) => ({ POST, PATCH, DELETE }[method]!)(request(path, method, value, metadata));
    const create = async (title?: string) => { const response = await invoke("POST", body(title)); assert.equal(response.status, 200, await response.clone().text()); return (await response.json()).event as CalendarEvent; };
    const counts = async () => (await control!.query("select (select count(*)::int from calendar_events) as events,(select count(*)::int from audit_logs) as audit,(select count(*)::int from crm_command_receipts) as receipts,(select count(*)::int from crm_domain_events) as domain")).rows[0];
    const saved = async (id: string) => (await control!.query(`select *,${INTERNAL_CALENDAR_REVISION_SQL} as revision from calendar_events where id=$1`, [id])).rows[0];
    await t.test("anonymous and missing CSRF deny; identical key/body produces one event, one business audit and one receipt; changed body conflicts", async () => {
      assert.equal((await POST(new Request(origin + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body()) }))).status, 401);
      assert.equal((await POST(request(path, "POST", body(), meta(), false))).status, 403);
      const metadata = meta(), before = await counts(), first = await invoke("POST", body(), metadata); assert.equal(first.status, 200, await first.clone().text()); const created = await first.json();
      const retry = await invoke("POST", body(), metadata); assert.equal(retry.status, 200, await retry.clone().text()); const replayed = await retry.json();
      assert.equal(replayed.event.id, created.event.id); assert.equal(replayed.commandId, created.commandId); assert.equal(replayed.replayed, true);
      const after = await counts(); assert.equal(after.events, before.events + 1); assert.equal(after.audit, before.audit + 2); assert.equal(after.receipts, before.receipts + 1); assert.equal(after.domain, before.domain + 1);
      assert.equal((await control!.query("select count(*)::int as n from audit_logs where entity_id=$1 and action='calendar_event.created'", [created.event.id])).rows[0].n, 1);
      assert.equal((await invoke("POST", body("SYNTHETIC changed effect"), metadata)).status, 409); assert.deepEqual(await counts(), after);
      assert.match(created.event.revision, /^[0-9a-f]{64}$/); assert.equal(created.event.internalManual, true);
    });
    await t.test("flat create keeps contactId relational and query selectors cannot redefine the event target", async () => {
      const before = await counts();
      const response = await invoke("POST", { ...body("SYNTHETIC flat contact event").event, contactId: fixture.developerContactId });
      assert.equal(response.status, 200, await response.clone().text()); const event = (await response.json()).event;
      assert.notEqual(event.id, fixture.developerContactId); assert.equal(event.contactId, fixture.developerContactId);
      assert.equal((await saved(event.id)).contact_id, fixture.developerContactId);
      const after = await counts(); assert.equal(after.events, before.events + 1);
      for (const selector of ["id", "eventId"]) assert.equal((await POST(request(path + "&" + selector + "=" + event.id, "POST", body()))).status, 400);
      assert.deepEqual(await counts(), after);
    });
    await t.test("two-project DELETE aliases cannot diverge from receipt identity; exact target is reauthorized before replay", async () => {
      const projectB = randomUUID();
      await control!.query("insert into projects(id,workspace_id,name,type,customer_type,default_operating_model) values($1,$2,'SYNTHETIC second calendar project','Bauträger','property_developer','novalure_internal')", [projectB, fixture.workspaceId]);
      const eventA = await create("SYNTHETIC target A"), responseB = await invoke("POST", { event: { ...body("SYNTHETIC target B").event, projectId: projectB } });
      assert.equal(responseB.status, 200, await responseB.clone().text()); const eventB = (await responseB.json()).event as CalendarEvent;
      const before = await counts(), rowA = await saved(eventA.id), rowB = await saved(eventB.id), conflict = { id: eventA.id, eventId: eventB.id, expectedRevision: eventB.revision }, conflictingMetadata = meta();
      assert.equal((await invoke("DELETE", conflict, conflictingMetadata)).status, 400);
      assert.equal((await reconcile(request("/api/crm/commands/reconcile?workspaceId=" + fixture.workspaceId, "POST", { target: path, method: "DELETE", body: conflict }, conflictingMetadata))).status, 400);
      assert.deepEqual(await saved(eventA.id), rowA); assert.deepEqual(await saved(eventB.id), rowB); assert.deepEqual(await counts(), before);
      const metadata = meta(), value = { id: eventB.id.toUpperCase(), eventId: eventB.id, expectedRevision: eventB.revision };
      const removed = await invoke("DELETE", value, metadata); assert.equal(removed.status, 200, await removed.clone().text()); const result = await removed.json();
      assert.equal(result.eventId, eventB.id); assert.deepEqual(await saved(eventA.id), rowA);
      const receipt = (await control!.query("select resource_id,project_id from crm_command_receipts where id=$1", [result.commandId])).rows[0];
      assert.deepEqual(receipt, { resource_id: eventB.id, project_id: projectB });
      assert.deepEqual((await control!.query("select entity_id,project_id from audit_logs where id=$1", [result.auditReference])).rows[0], { entity_id: eventB.id, project_id: projectB });
      const after = await counts();
      // Archive roles are workspace managers: their real revocation boundary is current membership/capability, not an ignored project grant.
      await control!.query("update workspace_users set role='assistant',product_role='viewer' where id=$1", [fixture.userId]);
      try {
        assert.equal((await invoke("DELETE", value, metadata)).status, 403);
        assert.equal((await reconcile(request("/api/crm/commands/reconcile?workspaceId=" + fixture.workspaceId, "POST", { target: path, method: "DELETE", body: value }, metadata))).status, 403);
      } finally { await control!.query("update workspace_users set role='owner',product_role='novalureAdmin' where id=$1", [fixture.userId]); }
      assert.deepEqual(await counts(), after);
    });
    await t.test("actual editor body preserves independent preparation on title edits and explicitly clears notes", async () => {
      const response = await invoke("POST", { event: { ...body("SYNTHETIC editor preservation").event, preparation: ["A", "B"], notes: "SYNTHETIC old note" } });
      assert.equal(response.status, 200, await response.clone().text()); const event = (await response.json()).event as CalendarEvent;
      const draft = { title: "SYNTHETIC title-only edit", projectId: event.projectId, ownerUserId: event.ownerUserId ?? "", contactId: "", leadId: "", startsAt: calendarLocalDateTime(event.startsAt), endsAt: calendarLocalDateTime(event.endsAt), location: event.location, status: event.status, notes: event.notes ?? "", outcomeGoal: event.outcomeGoal, meetingProvider: event.meetingProvider ?? "manual-link" };
      const value = internalCalendarWriteBody(draft, event); assert.equal(Object.hasOwn(value.event, "preparation"), false);
      const edited = await invoke("PATCH", value); assert.equal(edited.status, 200, await edited.clone().text()); const updated = (await edited.json()).event as CalendarEvent;
      assert.deepEqual(updated.preparation, ["A", "B"]); assert.equal(updated.notes, "SYNTHETIC old note");
      const cleared = await invoke("PATCH", internalCalendarWriteBody({ ...draft, notes: "" }, updated)); assert.equal(cleared.status, 200, await cleared.clone().text()); const final = (await cleared.json()).event;
      assert.equal(final.notes, ""); assert.deepEqual(final.preparation, ["A", "B"]);
      assert.equal((await saved(event.id)).metadata.notes, ""); assert.deepEqual((await saved(event.id)).preparation, ["A", "B"]);
    });
    await t.test("parallel same-key requests and lost committed response converge via the existing read-only receipt path", async () => {
      const metadata = meta(), value = body("SYNTHETIC concurrent key"), before = await counts();
      const responses = await Promise.all([invoke("POST", value, metadata), invoke("POST", value, metadata)]);
      for (const response of responses) assert.equal(response.status, 200, await response.clone().text());
      const results = await Promise.all(responses.map(response => response.json())); assert.equal(results[0].event.id, results[1].event.id); assert.equal((await counts()).events, before.events + 1);
      let writes = 0, lookups = 0;
      const recovered = await safeSalesFetch(path, { method: "POST", body: JSON.stringify(body("SYNTHETIC lost success")) }, async (target, init) => {
        const headers = new Headers(init.headers), metadata = { key: headers.get("Idempotency-Key")!, correlation: headers.get("X-Correlation-Id")! };
        if (target === path) { writes++; const response = await POST(request(target, "POST", JSON.parse(String(init.body)), metadata)); assert.equal(response.status, 200, await response.clone().text()); throw Error("SYNTHETIC response lost after commit"); }
        lookups++; return reconcile(request(target, "POST", JSON.parse(String(init.body)), metadata));
      });
      assert.equal(recovered.status, 200); assert.equal(writes, 1); assert.equal(lookups, 1); assert.equal((await counts()).events, before.events + 2);
    });
    await t.test("current full-row revision fences stale and concurrent edits and is independent of database time zone", async () => {
      const event = await create("SYNTHETIC CAS event"), before = await counts();
      assert.equal((await invoke("PATCH", { event: { id: event.id, title: "SYNTHETIC missing revision" } })).status, 409);
      const patch = (title: string, revision = event.revision) => ({ event: { id: event.id, title }, expectedRevision: revision });
      const responses = await Promise.all([invoke("PATCH", patch("SYNTHETIC edit A")), invoke("PATCH", patch("SYNTHETIC edit B"))]);
      assert.deepEqual(responses.map(response => response.status).sort(), [200, 409]);
      const row = await saved(event.id); assert.ok(["SYNTHETIC edit A", "SYNTHETIC edit B"].includes(row.title)); assert.notEqual(row.revision, event.revision);
      assert.equal((await invoke("PATCH", patch("SYNTHETIC stale overwrite"))).status, 409); assert.equal((await counts()).audit, before.audit + 2);
      const client = await control!.connect(); try {
        for (const zone of ["UTC", "Europe/Vienna"]) { await client.query("select set_config('TimeZone',$1,false)", [zone]); assert.equal((await client.query(`select ${INTERNAL_CALENDAR_REVISION_SQL} as revision from calendar_events where id=$1`, [event.id])).rows[0].revision, row.revision); }
      } finally { await client.query("select set_config('TimeZone','UTC',false)"); client.release(); }
    });
    await t.test("current role and project changes deny writes and old committed receipt reconciliation", async () => {
      const metadata = meta(), value = body("SYNTHETIC permission sentinel"); assert.equal((await invoke("POST", value, metadata)).status, 200);
      const before = await counts(); await control!.query("update workspace_users set role='assistant',product_role='viewer' where id=$1", [fixture.userId]);
      assert.equal((await invoke("POST", value, metadata)).status, 403);
      assert.equal((await reconcile(request("/api/crm/commands/reconcile?workspaceId=" + fixture.workspaceId, "POST", { target: path, method: "POST", body: value }, metadata))).status, 403);
      await control!.query("update workspace_users set role='owner',product_role='novalureAdmin' where id=$1", [fixture.userId]);
      assert.equal((await invoke("POST", { event: { ...body().event, projectId: randomUUID() } })).status, 403); assert.deepEqual(await counts(), before);
    });
    await t.test("personal/provider and property-booking markers cannot be reclassified by generic calendar writes", async () => {
      for (const metadata of [{ source: "personal_standalone_calendar", calendarProvider: "google", externalCommunication: true }, { source: "crm_internal_calendar_event", calendarProvider: "manual", externalCommunication: false, bookingId: randomUUID() }]) {
        const event = await create("SYNTHETIC protected source");
        await control!.query("update calendar_events set metadata=$2::jsonb where id=$1", [event.id, JSON.stringify(metadata)]);
        const current = await saved(event.id), before = await counts();
        assert.equal((await invoke("PATCH", { event: { id: event.id, title: "MUST NOT CHANGE" }, expectedRevision: current.revision })).status, 403);
        assert.equal((await invoke("DELETE", { eventId: event.id, expectedRevision: current.revision })).status, 403); assert.deepEqual(await counts(), before);
      }
      assert.equal((await invoke("POST", { event: { ...body().event, metadata: { source: "crm_internal_calendar_event" } } })).status, 400);
    });
    await t.test("business audit and late command receipt failures roll back event and evidence atomically", async () => {
      for (const table of ["audit_logs", "crm_command_receipts"]) {
        const before = await counts(); await control!.query("create function synthetic_reject_calendar() returns trigger language plpgsql as $$ begin raise exception 'SYNTHETIC calendar audit failure'; end $$");
        await control!.query(`create trigger synthetic_reject_calendar before insert on ${table} for each row execute function synthetic_reject_calendar()`);
        try { assert.equal((await invoke("POST", body("SYNTHETIC rollback"))).status, 503); assert.deepEqual(await counts(), before); }
        finally { await control!.query(`drop trigger synthetic_reject_calendar on ${table}`); await control!.query("drop function synthetic_reject_calendar()"); }
      }
    });
    await t.test("supported removal archives only a current unlinked internal event and its exact retry converges", async () => {
      const event = await create("SYNTHETIC archive event"), metadata = meta(), value = { eventId: event.id, expectedRevision: event.revision };
      const first = await invoke("DELETE", value, metadata); assert.equal(first.status, 200, await first.clone().text());
      const retry = await invoke("DELETE", value, metadata); assert.equal(retry.status, 200, await retry.clone().text()); assert.equal((await retry.json()).replayed, true);
      const row = await saved(event.id); assert.equal(row.status, "abgesagt"); assert.equal(row.metadata.internalCalendarArchive.archivedByUserId, fixture.userId);
      assert.equal((await invoke("PATCH", { event: { id: event.id, title: "MUST NOT REOPEN" }, expectedRevision: row.revision })).status, 409);
      assert.equal((await withCrmRead(session, () => loadCalendarEvents(fixture.workspaceId))).some(event => event.id === row.id), false);
    });
    await t.test("bound boolean helper denies wrong tenant/actor/session/identity and private helper is not executable by runtime", async () => {
      const event = await create("SYNTHETIC helper boundaries");
      assert.equal(await predicate(event.id), true);
      assert.equal(await predicate(event.id, randomUUID()), false); assert.equal(await predicate(event.id, fixture.workspaceId, randomUUID()), false);
      assert.equal(await predicate(event.id, fixture.workspaceId, fixture.userId, randomUUID()), false);
      assert.equal(await predicate(event.id, fixture.workspaceId, fixture.userId, sessionId, randomUUID()), false);
      const foreignWorkspace = randomUUID(), foreignProject = randomUUID(), foreignEvent = randomUUID(), malformed = randomUUID();
      await control!.query("insert into workspaces(id,name,operating_model,customer_type) values($1,'SYNTHETIC foreign calendar','self_service_customer','property_developer')", [foreignWorkspace]);
      await control!.query("insert into projects(id,workspace_id,name,type) values($1,$2,'SYNTHETIC foreign calendar','Bauträger')", [foreignProject, foreignWorkspace]);
      const metadata = { source: "crm_internal_calendar_event", calendarProvider: "manual", externalCommunication: false };
      await control!.query("insert into calendar_events(id,workspace_id,project_id,title,starts_at,ends_at,metadata) values($1,$2,$3,'SYNTHETIC foreign event',now(),now()+interval '1 hour',$4::jsonb),($5,$6,$3,'SYNTHETIC malformed foreign project',now(),now()+interval '1 hour',$4::jsonb)", [foreignEvent, foreignWorkspace, foreignProject, JSON.stringify(metadata), malformed, fixture.workspaceId]);
      assert.equal(await predicate(foreignEvent), false); assert.equal(await predicate(malformed), false);
      assert.equal((await invoke("DELETE", { eventId: foreignEvent, expectedRevision: "0".repeat(64) })).status, 404);
      assert.equal((await invoke("DELETE", { eventId: malformed, expectedRevision: "0".repeat(64) })).status, 403);
      await assert.rejects(withCrmRead(session, tx => tx.query("select crm_internal_calendar_dependency_exists($1)", [event.id])), { code: "42501" });
      await control!.query("update workspace_users set role='assistant',product_role='viewer' where id=$1", [fixture.userId]);
      assert.equal(await predicate(event.id), false);
      await control!.query("update workspace_users set role='owner',product_role='novalureAdmin' where id=$1", [fixture.userId]);
      assert.equal((await control!.query("select has_table_privilege($1,'teams_notification_jobs','SELECT') as allowed", [db.role])).rows[0].allowed, false);
    });
    await t.test("real sync and both notification links deny archive without runtime queue reads and preserve every row", async () => {
      for (const table of ["calendar_sync_events", "teams_notification_jobs", "google_notification_jobs"]) {
        const event = await create("SYNTHETIC linked " + table);
        if (table === "calendar_sync_events") await control!.query("insert into calendar_sync_events(workspace_id,calendar_event_id,provider,operation,status) values($1,$2,'synthetic-no-network','create_event','pending')", [fixture.workspaceId, event.id]);
        else await control!.query(`insert into ${table}(workspace_id,project_id,calendar_event_id,alert_type,entity_type,entity_id,title,message,idempotency_key,status) values($1,$2,$3,'meeting_booked','calendar_event',$3,'SYNTHETIC linked no delivery','SYNTHETIC pending config',$4,'pending_config')`, [fixture.workspaceId, fixture.projectId, event.id, randomUUID()]);
        const before = await saved(event.id), evidence = await counts(), links = (await control!.query(`select to_jsonb(t) as row from ${table} t where calendar_event_id=$1`, [event.id])).rows;
        assert.equal(await predicate(event.id), false);
        assert.equal((await invoke("DELETE", { eventId: event.id, expectedRevision: before.revision })).status, 403);
        assert.deepEqual(await saved(event.id), before); assert.deepEqual(await counts(), evidence);
        assert.deepEqual((await control!.query(`select to_jsonb(t) as row from ${table} t where calendar_event_id=$1`, [event.id])).rows, links);
      }
    });
    await t.test("forged reserved marker inserts, updates, resets and mixed writes are denied at the database boundary", async () => {
      const event = await create("SYNTHETIC marker guard"), proof = { archivedAt: "2030-01-01T00:00:00Z", archivedByUserId: fixture.userId, authSessionId: sessionId, authIdentityId: fixture.authIdentityId };
      const before = await saved(event.id), evidence = await counts();
      await assert.rejects(withCrmRead(session, tx => tx.query("insert into calendar_events(workspace_id,project_id,owner_user_id,title,starts_at,ends_at,metadata) values($1,$2,$3,'SYNTHETIC forged insert',now(),now()+interval '1 hour',$4::jsonb)", [fixture.workspaceId, fixture.projectId, fixture.userId, JSON.stringify({ internalCalendarArchive: proof })])), { code: "23514" });
      for (const patch of [{}, { ...proof, authSessionId: randomUUID() }]) await assert.rejects(withCrmRead(session, tx => tx.query("update calendar_events set status='abgesagt',metadata=metadata||jsonb_build_object('internalCalendarArchive',$2::jsonb) where id=$1", [event.id, JSON.stringify(patch)])), { code: "23514" });
      await assert.rejects(withCrmRead(session, tx => tx.query("update calendar_events set status='abgesagt',title='MUST NOT CHANGE',metadata=metadata||jsonb_build_object('internalCalendarArchive',$2::jsonb) where id=$1", [event.id, JSON.stringify(proof)])), { code: "23514" });
      assert.deepEqual(await saved(event.id), before); assert.deepEqual(await counts(), evidence);
      assert.equal((await invoke("DELETE", { eventId: event.id, expectedRevision: before.revision })).status, 200);
      const archived = await saved(event.id);
      await assert.rejects(withCrmRead(session, tx => tx.query("update calendar_events set status='geplant',metadata=metadata-'internalCalendarArchive' where id=$1", [event.id])), { code: "23514" });
      await assert.rejects(control!.query("insert into calendar_sync_events(workspace_id,calendar_event_id,provider,operation,status) values($1,$2,'synthetic-no-network','create_event','pending')", [fixture.workspaceId, event.id]), { code: "23514" });
      assert.deepEqual(await saved(event.id), archived);
    });
    await t.test("a new provider reference racing after archive waits and rejects without leaving a dangling operation", async () => {
      const event = await create("SYNTHETIC archive link race");
      await control!.query("create function synthetic_hold_calendar_receipt() returns trigger language plpgsql as $$ begin if new.operation='legacy_http.calendar-events.delete' then perform pg_sleep(0.25); end if; return new; end $$");
      await control!.query("create trigger synthetic_hold_calendar_receipt before insert on crm_command_receipts for each row execute function synthetic_hold_calendar_receipt()");
      try {
        const removing = invoke("DELETE", { eventId: event.id, expectedRevision: event.revision });
        let sleeping = false;
        for (let attempt = 0; attempt < 50; attempt++) {
          sleeping = (await control!.query("select exists(select 1 from pg_stat_activity where wait_event='PgSleep' and query like 'insert into crm_command_receipts%') as sleeping")).rows[0].sleeping;
          if (sleeping) break;
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        assert.equal(sleeping, true, "Archive reached its locked commit boundary");
        const lateReference = control!.query("insert into calendar_sync_events(workspace_id,calendar_event_id,provider,operation,status) values($1,$2,'synthetic-no-network','create_event','pending')", [fixture.workspaceId, event.id]).then(() => "COMMITTED", error => error.code);
        const response = await removing; assert.equal(response.status, 200, await response.clone().text()); assert.equal(await lateReference, "23514");
        assert.equal((await control!.query("select count(*)::int n from calendar_sync_events where calendar_event_id=$1", [event.id])).rows[0].n, 0);
      } finally { await control!.query("drop trigger synthetic_hold_calendar_receipt on crm_command_receipts; drop function synthetic_hold_calendar_receipt()"); }
    });
    await t.test("hidden viewing rows and temporary catalog shadows cannot become a false no-link proof", async () => {
      const event = await create("SYNTHETIC hidden viewing"), unit = randomUUID();
      await control!.query("insert into property_units(id,workspace_id,project_id,unit_number,status) values($1,$2,$3,'SYNTHETIC viewing unit','available')", [unit, fixture.workspaceId, fixture.projectId]);
      await control!.query("insert into property_viewing_slots(workspace_id,project_id,unit_id,contact_id,owner_user_id,starts_at,ends_at,status,calendar_event_id) values($1,$2,$3,$4,$5,now(),now()+interval '1 hour','planned',$6)", [fixture.workspaceId, fixture.projectId, unit, fixture.developerContactId, fixture.userId, event.id]);
      assert.equal(await predicate(event.id), false, "Unconditional owner read sees the real positive viewing link");
      await control!.query("create policy synthetic_hide_viewing on property_viewing_slots as restrictive for select to public using(false)");
      try {
        assert.equal((await db.admin.query("select count(*)::int n from property_viewing_slots where calendar_event_id=$1", [event.id])).rows[0].n, 0);
        assert.equal(await predicate(event.id), false);
        await withTenantTransaction({ workspaceId: fixture.workspaceId, actorId: fixture.userId }, async tx => {
          await tx.execute("create temporary table pg_class on commit drop as select * from pg_catalog.pg_class where oid='public.property_viewing_slots'::regclass");
          await tx.execute("update pg_temp.pg_class set relrowsecurity=false"); await tx.execute("grant select on pg_temp.pg_class to public");
          const result = await tx.queryOne<{ allowed: boolean }>("select crm_internal_calendar_archive_unlinked($1,$2,$3,$4,$5) as allowed", [fixture.workspaceId, fixture.userId, event.id, sessionId, fixture.authIdentityId]);
          assert.equal(result?.allowed, false);
        });
      } finally { await control!.query("drop policy synthetic_hide_viewing on property_viewing_slots"); }
    });
    await t.test("FORCE RLS hidden queue rows and queue read errors deny, never prove no dependencies", async () => {
      const event = await create("SYNTHETIC RLS visibility gate");
      await control!.query("alter table teams_notification_jobs enable row level security; alter table teams_notification_jobs force row level security");
      await control!.query("create policy synthetic_deny_reader on teams_notification_jobs for select to public using(false)");
      assert.equal(await predicate(event.id), false, "even an empty RLS-filtered queue is not a no-link proof");
      await control!.query("insert into teams_notification_jobs(workspace_id,project_id,calendar_event_id,alert_type,entity_type,entity_id,title,message,idempotency_key,status) values($1,$2,$3,'meeting_booked','calendar_event',$3,'SYNTHETIC hidden no delivery','SYNTHETIC pending config',$4,'pending_config')", [fixture.workspaceId, fixture.projectId, event.id, randomUUID()]);
      assert.equal((await db.admin.query("select count(*)::int n from teams_notification_jobs where calendar_event_id=$1", [event.id])).rows[0].n, 0, "schema-owner SELECT is really filtered under FORCE RLS");
      assert.equal(await predicate(event.id), false); assert.equal((await invoke("DELETE", { eventId: event.id, expectedRevision: event.revision })).status, 403);
      await control!.query("create or replace function crm_internal_calendar_dependency_exists(p_event uuid) returns boolean language plpgsql security definer set search_path=pg_catalog,public set row_security=off as $$ begin raise exception 'SYNTHETIC queue unavailable'; end $$");
      assert.equal(await predicate(event.id), false); assert.equal((await invoke("DELETE", { eventId: event.id, expectedRevision: event.revision })).status, 403);
    });
  } finally {
    await closeLocalTestPool(); await control?.end(); await db.stop();
    for (const key of names) { if (original[key] === undefined) delete process.env[key]; else process.env[key] = original[key]; }
  }
});
