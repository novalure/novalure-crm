import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { test } from "node:test";
import { getRolePermissions } from "../src/lib/auth/permissions";
import type { AppSession } from "../src/lib/auth/session";
import { getProductRoleCapabilities } from "../src/lib/product-model";
import type { TenantPool } from "../src/lib/db/tenant-client";
import { runPropertySalesCommand, type PropertySalesCommand } from "../src/lib/db/property-sales-repositories";
import { loadPropertySalesHistory } from "../src/lib/db/property-sales-history-repository";
import { isPropertySalesHistoryPage, type PropertySalesHistoryPage } from "../src/lib/property-sales-history";
import { closeLocalTestPool } from "../src/lib/db/local-test-transport";
import { createCsrfToken } from "../src/lib/security/csrf-core";
import { POST as salesPost } from "../src/app/api/crm/property-sales/route";
import { GET as historyGet } from "../src/app/api/crm/property-sales/history/route";
import { GET as coreGet } from "../src/app/api/crm/core/route";
import { POST as reconcilePost } from "../src/app/api/crm/commands/reconcile/route";
import { startLocalSalesDb, applySalesSchema } from "./lib/local-sales-db.mjs";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Raw fixture SQL; public DTO validation is asserted independently.
type Row = Record<string, any>;
type Seed = { unit: string; lead: string; buyer: string; reservation?: string };
const envNames = ["DATABASE_URL", "NODE_ENV", "CRM_LOCAL_TEST_DATABASE", "NOVALURE_SESSION_SECRET", "NOVALURE_APP_ORIGIN", "NOVALURE_AUTH_STRICT", "NOVALURE_AUTH_ENCRYPTION_KEY", "NOVALURE_AUTH_RATE_LIMIT_SECRET"] as const;
const publicItemKeys = ["actor", "expiresAt", "id", "kind", "occurredAt", "reservationId", "reservationVersion", "source", "sourceReference", "status", "taskId", "unitId", "unitVersion"].sort();
const fullJsonValue = (value: unknown): unknown => {
  const encoded = JSON.stringify(value);
  assert.ok(typeof encoded === "string");
  return JSON.parse(encoded);
};

// One disposable synthetic PG fixture and direct real Request/Response route calls.
// No Next server, browser, provider, mail, cloud connection or production migration.
test("reservation history and manual follow-ups: focused real PostgreSQL and cookie/CSRF routes", { timeout: 240_000 }, async t => {
  const db = await startLocalSalesDb();
  const originalEnv = Object.fromEntries(envNames.map(key => [key, process.env[key]]));
  const ids = { workspace: randomUUID(), foreignWorkspace: randomUUID(), project: randomUUID(), otherProject: randomUUID(), foreignProject: randomUUID(), owner: randomUUID(), agent: randomUUID(), foreignOwner: randomUUID(), organization: randomUUID(), representative: randomUUID() };
  const owner: AppSession = { authenticated: true, userId: ids.owner, workspaceId: ids.workspace, workspaceName: "MUSTER Reservierung", name: "MUSTER Verantwortlich", email: "reservation-owner@example.invalid", role: "owner", productRole: "customer_owner", permissions: getRolePermissions("owner"), productPermissions: getProductRoleCapabilities("customer_owner"), source: "database" };
  const agent: AppSession = { ...owner, userId: ids.agent, role: "agent", productRole: "developer_sales", permissions: getRolePermissions("agent"), productPermissions: getProductRoleCapabilities("developer_sales") };
  const options = { pool: db.pool as unknown as TenantPool };
  const scalar = async (sql: string, params: unknown[] = []): Promise<Row> => (await db.admin.query(sql, params)).rows[0];
  const run = (command: PropertySalesCommand, session = owner) => runPropertySalesCommand(session, command, options);
  const command = (action: PropertySalesCommand["action"], payload: Record<string, unknown>, expectedVersion = 1): PropertySalesCommand => ({ action, projectId: ids.project, payload, expectedVersion, idempotencyKey: randomUUID(), correlationId: randomUUID() });
  const future = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();
  const counts = () => scalar("select (select count(*)::int from tasks) as tasks,(select count(*)::int from property_reservations) as reservations,(select count(*)::int from audit_logs) as audit,(select count(*)::int from crm_command_receipts) as receipts,(select count(*)::int from crm_domain_events) as events,(select count(*)::int from property_unit_audit_events) as unit_audit");
  let serial = 0;
  const seed = async (status?: "requested" | "reserved", expiresAt = future(2)): Promise<Seed> => {
    const item: Seed = { unit: randomUUID(), lead: randomUUID(), buyer: randomUUID() };
    const number = "MUSTER-W-" + String(++serial).padStart(3, "0");
    await db.admin.query("insert into property_units(id,workspace_id,project_id,unit_number,status,price_cents,metadata) values($1,$2,$3,$4,'available',87654321,'{\"privateMarker\":\"RAW-UNIT-SECRET\"}')", [item.unit, ids.workspace, ids.project, number]);
    await db.admin.query("insert into contacts(id,workspace_id,project_id,name,email,phone,role) values($1,$2,$3,'MUSTER Käufer','raw-buyer-secret@example.invalid','+430000987654','Käufer')", [item.buyer, ids.workspace, ids.project]);
    await db.admin.query("insert into leads(id,workspace_id,project_id,contact_id,type,intent,status,sales_qualification) values($1,$2,$3,$4,'Käufer','MUSTER Kauf','Übergabe',$5::jsonb)", [item.lead, ids.workspace, ids.project, item.buyer, JSON.stringify({ complete: true, desiredUnitId: item.unit, privateMarker: "RAW-LEAD-SECRET" })]);
    await db.admin.query("insert into lead_sales_handovers(workspace_id,project_id,lead_id,qualification_version,recipient_user_id,actor_id,source_reference) values($1,$2,$3,1,$4,$4,'MUSTER Übergabe')", [ids.workspace, ids.project, item.lead, ids.owner]);
    if (status) {
      item.reservation = randomUUID();
      await db.admin.query("insert into property_reservations(id,workspace_id,project_id,unit_id,contact_id,buyer_lead_id,status,expires_at,deposit_cents,confirmation,metadata) values($1,$2,$3,$4,$5,$6,$7,$8,543210,$9::jsonb,'{\"privateMarker\":\"RAW-RESERVATION-SECRET\"}')", [item.reservation, ids.workspace, ids.project, item.unit, item.buyer, item.lead, status, expiresAt, JSON.stringify({ sourceReference: "MUSTER frühere Freigabe", privateMarker: "RAW-CONFIRMATION-SECRET" })]);
      if (status === "reserved") await db.admin.query("update property_units set status='reserved',buyer_contact_id=$2 where id=$1", [item.unit, item.buyer]);
    }
    return item;
  };
  const history = (item: Seed, session = owner, cursor?: string) => loadPropertySalesHistory(session, { projectId: ids.project, unitId: item.unit, ...(item.reservation ? { reservationId: item.reservation } : {}), ...(cursor ? { cursor } : {}) }, options);
  const taskId = (result: Awaited<ReturnType<typeof run>>) => {
    assert.ok("taskId" in result.data && typeof result.data.taskId === "string");
    return result.data.taskId;
  };
  const publicPage = (page: PropertySalesHistoryPage) => {
    assert.equal(isPropertySalesHistoryPage(page), true);
    assert.equal(page.coverage, "RECORDED_EVENTS_ONLY");
    assert.deepEqual(Object.keys(page).sort(), ["coverage", "items", "nextCursor", "projectId", "reservationId", "unitId", "workspaceId"]);
    for (const row of page.items) {
      assert.deepEqual(Object.keys(row).sort(), publicItemKeys);
      assert.deepEqual(Object.keys(row.actor).sort(), ["id", "name"]);
      assert.deepEqual(Object.keys(row.status).sort(), ["after", "before"]);
      assert.deepEqual(Object.keys(row.expiresAt).sort(), ["after", "before"]);
    }
    assert.doesNotMatch(JSON.stringify(page), /RAW-(?:UNIT|LEAD|RESERVATION|CONFIRMATION|EVENT|AUDIT)-SECRET|raw-buyer-secret|987654|87654321|543210|price_cents|deposit_cents|request_hash|confirmation|buyer_profile/);
  };
  const reviewTask = async (result: Awaited<ReturnType<typeof run>>, item: Seed, action: string, actorId = ids.owner) => {
    assert.ok("taskId" in result.data && typeof result.data.taskId === "string");
    const task = await scalar("select * from tasks where id=$1", [result.data.taskId]);
    assert.equal(task.workspace_id, ids.workspace); assert.equal(task.project_id, ids.project);
    assert.equal(task.contact_id, item.buyer); assert.equal(task.lead_id, item.lead); assert.equal(task.owner_user_id, actorId);
    assert.equal(task.status, "open"); assert.equal(task.due_at, null); assert.match(task.title, /manuell/);
    assert.deepEqual(Object.keys(task.metadata).sort(), ["action", "commandId", "manualReviewOnly", "reservationExpiresAt", "reservationId", "source", "unitId"]);
    assert.equal(task.metadata.source, "reservation_manual_review"); assert.equal(task.metadata.action, action);
    assert.equal(task.metadata.manualReviewOnly, true); assert.equal(task.metadata.commandId, result.commandId);
    assert.equal(task.metadata.unitId, item.unit); assert.equal(task.metadata.reservationId, item.reservation);
    const reservation = await scalar("select expires_at from property_reservations where id=$1", [item.reservation]);
    assert.equal(new Date(task.metadata.reservationExpiresAt).toISOString(), reservation.expires_at.toISOString());
    const receipt = await scalar("select response from crm_command_receipts where id=$1", [result.commandId]);
    assert.equal(receipt.response.taskId, task.id);
    return task;
  };
  const legacyEvidence = async (item: Seed, overrides: { record?: Row; event?: Row; receipt?: Row; at?: string } = {}) => {
    assert.ok(item.reservation);
    const id = randomUUID(), audit = randomUUID(), eventId = randomUUID(), correlation = randomUUID();
    const reservation = await scalar("select * from property_reservations where id=$1", [item.reservation]);
    const response = { entity: "reservation", record: { ...reservation, ...overrides.record }, privateMarker: "RAW-EVENT-SECRET", unitVersion: 1 };
    const receipt: Row = { workspace: ids.workspace, project: ids.project, actor: ids.owner, operation: "property_sales.reservation.request", resource: null, audit, correlation, ...overrides.receipt };
    const event: Row = { workspace: receipt.workspace, project: receipt.project, actor: receipt.actor, operation: receipt.operation, resource: receipt.resource, audit: receipt.audit, correlation: receipt.correlation, ...overrides.event };
    // Append-only predecessor-shaped records: no immutable guard is disabled or row rewritten.
    await db.admin.query("insert into audit_logs(id,workspace_id,actor_user_id,project_id,action,entity_type,entity_id,after) values($1,$2,$3,$4,$5,'crm_command',$6,'{\"privateMarker\":\"RAW-AUDIT-SECRET\"}')", [audit, ids.workspace, ids.owner, ids.project, receipt.operation, receipt.resource]);
    await db.admin.query("insert into crm_command_receipts(id,workspace_id,project_id,actor_user_id,operation,resource_id,idempotency_key,request_hash,response,audit_reference,correlation_id,data_classification) values($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,'CUSTOMER_TENANT')", [id, receipt.workspace, receipt.project, receipt.actor, receipt.operation, receipt.resource, randomUUID(), "a".repeat(64), JSON.stringify(response), receipt.audit, receipt.correlation]);
    await db.admin.query("insert into crm_domain_events(id,workspace_id,project_id,actor_user_id,event_type,resource_id,command_id,audit_reference,correlation_id,payload,data_classification,created_at) values($1,$2,$3,$4,$5,$6,$7,$8,$9,'{\"privateMarker\":\"RAW-EVENT-SECRET\"}','CUSTOMER_TENANT',coalesce($10::timestamptz,clock_timestamp()))", [eventId, event.workspace, event.project, event.actor, event.operation, event.resource, id, event.audit, event.correlation, overrides.at ?? null]);
    return { id, eventId };
  };
  try {
    await applySalesSchema(db);
    await db.admin.query("insert into workspaces(id,name,operating_model,customer_type) values($1,'MUSTER Reservierung','self_service_customer','property_developer'),($2,'MUSTER Fremdmandant','self_service_customer','property_developer')", [ids.workspace, ids.foreignWorkspace]);
    await db.admin.query("insert into workspace_users(id,workspace_id,name,email,role,product_role,status,onboarding_completed_at) values($1,$4,'MUSTER Verantwortlich','reservation-owner@example.invalid','owner','customer_owner','active',now()),($2,$4,'MUSTER Vertrieb','reservation-agent@example.invalid','agent','developer_sales','active',now()),($3,$5,'MUSTER Fremdverantwortlich','reservation-foreign@example.invalid','owner','customer_owner','active',now())", [ids.owner, ids.agent, ids.foreignOwner, ids.workspace, ids.foreignWorkspace]);
    await db.admin.query("insert into projects(id,workspace_id,name,type) values($1,$2,'MUSTER Haus','Bauträger'),($3,$2,'MUSTER anderes Projekt','Bauträger'),($4,$5,'MUSTER Fremdprojekt','Bauträger')", [ids.project, ids.workspace, ids.otherProject, ids.foreignProject, ids.foreignWorkspace]);
    await db.admin.query("insert into project_pipeline_permissions(workspace_id,project_id,user_id,can_read,can_edit_deals) values($1,$2,$3,true,true)", [ids.workspace, ids.project, ids.agent]);
    await db.admin.query("insert into organizations(id,workspace_id,project_id,name,type) values($1,$2,$3,'MUSTER Bauträger','Bauträger')", [ids.organization, ids.workspace, ids.project]);
    await db.admin.query("insert into contacts(id,workspace_id,project_id,organization_id,name,role) values($1,$2,$3,$4,'MUSTER Vollmacht','Bauträger')", [ids.representative, ids.workspace, ids.project, ids.organization]);
    await db.admin.query("update projects set developer_organization_id=$2 where id=$1", [ids.project, ids.organization]);
    for (const userId of [ids.owner, ids.agent]) await db.admin.query("insert into crm_project_sales_authorities(workspace_id,project_id,user_id,developer_organization_id,contact_id,can_confirm_reservation,assignment_source,assigned_by) values($1,$2,$3,$4,$5,true,'MUSTER schriftliche Vollmacht',$6)", [ids.workspace, ids.project, userId, ids.organization, ids.representative, ids.owner]);

    await t.test("request, confirmation and extension each deliver one open actor-owned manual task and immutable receipt", async () => {
      const item = await seed(), before = await counts();
      const request = command("reservation.request", { unitId: item.unit, leadId: item.lead, expiresAt: future(2) });
      const requested = await run(request); item.reservation = String(requested.data.record?.id);
      const requestTask = await reviewTask(requested, item, request.action);
      const confirm = command("reservation.confirm", { reservationId: item.reservation, unitVersion: 1, sourceReference: "MUSTER bestätigte Freigabe" });
      const confirmed = await run(confirm, agent); await reviewTask(confirmed, item, confirm.action, ids.agent);
      const extended = await run(command("reservation.extend", { reservationId: item.reservation, unitVersion: 2, expiresAt: future(3), sourceReference: "MUSTER Fristverlängerung" }, 2));
      await reviewTask(extended, item, "reservation.extend");
      const replay = await run(request); assert.equal(replay.replayed, true); assert.equal(replay.commandId, requested.commandId); assert.deepEqual(fullJsonValue(replay.data), fullJsonValue(requested.data));
      assert.deepEqual(await scalar("select * from tasks where id=$1", [requestTask.id]), requestTask);
      const after = await counts(); assert.equal(after.tasks, before.tasks + 3); assert.equal(after.receipts, before.receipts + 3);
      const page = await history(item); publicPage(page);
      const rows = page.items.filter(row => row.source === "reservation_command");
      assert.deepEqual(rows.map(row => row.kind), ["reservation.extend", "reservation.confirm", "reservation.request"]);
      assert.deepEqual(rows.map(row => row.actor.id), [ids.owner, ids.agent, ids.owner]);
      assert.deepEqual(rows.map(row => row.reservationVersion), [3, 2, 1]);
      assert.deepEqual(rows.map(row => row.status.after), ["reserved", "reserved", "requested"]);
      for (const result of [requested, confirmed, extended]) assert.ok(rows.some(row => row.taskId === taskId(result)));
      await db.admin.query("update tasks set owner_user_id=$2 where id=$1", [requestTask.id, ids.agent]);
      const reassigned = await history(item);
      assert.ok(reassigned.items.some(row => row.taskId === requestTask.id && row.actor.id === ids.owner), "a legitimate later assignee change must preserve the historical task link and original command actor");
      const receipt = await scalar("select resource_id from crm_command_receipts where id=$1", [requested.commandId]);
      assert.equal(receipt.resource_id, null, "real request receipts without resource_id must remain readable via exact record scope");
    });

    await t.test("expiry adds one undated follow-up and withdrawal retains its separate existing DB-now task", async () => {
      const expired = await seed("reserved", new Date(Date.now() - 60_000).toISOString()), before = await counts();
      const result = await run(command("reservation.expire", { reservationId: expired.reservation, unitVersion: 1 }));
      await reviewTask(result, expired, "reservation.expire");
      const page = await history(expired); publicPage(page);
      assert.ok(page.items.some(row => row.kind === "reservation.expire" && row.status.after === "expired" && row.taskId === taskId(result)));
      const withdrawn = await seed("reserved"), dbBefore = (await scalar("select clock_timestamp() as now")).now;
      const withdrawal = command("reservation.withdraw", { reservationId: withdrawn.reservation, unitVersion: 1, sourceReference: "MUSTER Käufer nimmt zurück" });
      const first = await run(withdrawal), replay = await run(withdrawal);
      assert.equal(replay.commandId, first.commandId); assert.equal(replay.replayed, true);
      const task = await scalar("select * from tasks where id=$1", [taskId(first)]), dbAfter = (await scalar("select clock_timestamp() as now")).now;
      assert.equal(task.metadata.source, "reservation_withdrawal"); assert.equal(task.metadata.manualReviewOnly, true);
      assert.equal(task.status, "open"); assert.equal(task.owner_user_id, ids.owner);
      assert.ok(task.due_at.getTime() >= dbBefore.getTime() && task.due_at.getTime() <= dbAfter.getTime());
      const withdrawalPage = await history(withdrawn); publicPage(withdrawalPage);
      assert.ok(withdrawalPage.items.some(row => row.kind === "reservation.withdraw" && row.status.after === "withdrawn" && row.taskId === task.id));
      const after = await counts(); assert.equal(after.tasks, before.tasks + 2); assert.equal(after.receipts, before.receipts + 2);
    });

    await t.test("retiming and changed-body reuse conflict; concurrent distinct and identical commands never duplicate tasks", async () => {
      const item = await seed("reserved"), before = await counts();
      const firstCommand = command("reservation.extend", { reservationId: item.reservation, unitVersion: 1, expiresAt: future(3), sourceReference: "MUSTER Retime" });
      const first = await run(firstCommand);
      await assert.rejects(run({ ...firstCommand, payload: { ...firstCommand.payload, expiresAt: future(4) } }), { code: "IDEMPOTENCY_CONFLICT" });
      const candidates = [3, 4].map(days => command("reservation.extend", { reservationId: item.reservation, unitVersion: 1, expiresAt: future(days + 2), sourceReference: "MUSTER konkurrierende Frist" }, 2));
      const race = await Promise.allSettled(candidates.map(value => run(value)));
      assert.equal(race.filter(value => value.status === "fulfilled").length, 1);
      const failed = race.find(value => value.status === "rejected"); assert.ok(failed?.status === "rejected"); assert.match(String(failed.reason), /Version changed/);
      const replay = await run(firstCommand); assert.equal(taskId(replay), taskId(first)); assert.deepEqual(fullJsonValue(replay.data), fullJsonValue(first.data));
      const another = await seed(), request = command("reservation.request", { unitId: another.unit, leadId: another.lead, expiresAt: future(2) });
      const exact = await Promise.all([run(request), run(request)]);
      assert.equal(exact[0].commandId, exact[1].commandId); assert.equal(exact.filter(value => value.replayed).length, 1);
      const after = await counts(); assert.equal(after.tasks, before.tasks + 3); assert.equal(after.receipts, before.receipts + 3);
    });

    await t.test("different command bodies with one idempotency key wait before locking the unit and converge without deadlock", async () => {
      const item = await seed(), before = await counts();
      const input = command("reservation.request", { unitId: item.unit, leadId: item.lead, expiresAt: future(2) });
      const price: PropertySalesCommand = { ...input, action: "unit.price.confirm", payload: { unitId: item.unit, priceCents: 87654321, sourceReference: "MUSTER konkurrierende Preisfreigabe" } };
      const prior = await scalar("select can_confirm_price as allowed from crm_project_sales_authorities where workspace_id=$1 and project_id=$2 and user_id=$3", [ids.workspace, ids.project, ids.owner]);
      await db.admin.query("update crm_project_sales_authorities set can_confirm_price=true where workspace_id=$1 and project_id=$2 and user_id=$3", [ids.workspace, ids.project, ids.owner]);
      const holder = await db.admin.connect(), pids: number[] = [];
      const observedPool: TenantPool = { async connect() {
        const client = await db.pool.connect();
        pids.push(Number((await client.query("select pg_backend_pid() as pid")).rows[0].pid));
        return client as unknown as Awaited<ReturnType<TenantPool["connect"]>>;
      } };
      let settled: PromiseSettledResult<Awaited<ReturnType<typeof run>>>[] = [];
      let pending: Promise<typeof settled> | undefined;
      try {
        await holder.query("begin");
        await holder.query("select pg_advisory_xact_lock(hashtextextended($1,0))", ["crm-command:" + ids.workspace + ":" + input.idempotencyKey]);
        const holderPid = Number((await holder.query("select pg_backend_pid() as pid")).rows[0].pid);
        const lock = await scalar("select classid,objid,objsubid from pg_locks where pid=$1 and locktype='advisory' and granted", [holderPid]);
        pending = Promise.allSettled([input, price].map(value => runPropertySalesCommand(owner, value, { pool: observedPool, statementTimeoutMs: 5_000 })));
        let waiting = 0;
        const deadline = Date.now() + 4_000;
        while (Date.now() < deadline) {
          waiting = Number((await scalar("select count(distinct pid)::int as n from pg_locks where pid=any($1::int[]) and locktype='advisory' and not granted and classid=$2::oid and objid=$3::oid and objsubid=$4", [pids, lock.classid, lock.objid, lock.objsubid])).n);
          if (pids.length === 2 && waiting === 2) break;
          await new Promise<void>(resolve => setImmediate(resolve));
        }
        assert.equal(pids.length, 2, "two actual tenant connections must be observed");
        assert.equal(waiting, 2, "both different commands must wait on the exact held idempotency lock");
        // NOWAIT proves that neither waiter acquired the unit before its idempotency lock.
        // This is a DB-state assertion, not a timing sleep or service test hook.
        const available = await db.admin.query("select id from property_units where id=$1 for update nowait", [item.unit]);
        assert.equal(available.rows[0].id, item.unit);
      } finally {
        try { await holder.query("rollback"); } finally { holder.release(); }
        try { if (pending) settled = await pending; }
        finally { await db.admin.query("update crm_project_sales_authorities set can_confirm_price=$4 where workspace_id=$1 and project_id=$2 and user_id=$3", [ids.workspace, ids.project, ids.owner, prior.allowed]); }
      }
      assert.equal(settled.filter(value => value.status === "fulfilled").length, 1);
      const denied = settled.find(value => value.status === "rejected"); assert.ok(denied?.status === "rejected");
      assert.equal(denied.reason.code, "IDEMPOTENCY_CONFLICT"); assert.equal(denied.reason.status, 409);
      assert.notEqual(denied.reason.code, "40P01");
      const receipt = await scalar("select count(*)::int as n,min(operation) as operation from crm_command_receipts where workspace_id=$1 and idempotency_key=$2", [ids.workspace, input.idempotencyKey]);
      assert.equal(receipt.n, 1);
      const after = await counts(), requestWon = receipt.operation === "property_sales.reservation.request";
      assert.equal(after.receipts, before.receipts + 1); assert.equal(after.events, before.events + 1);
      assert.equal(after.tasks, before.tasks + Number(requestWon)); assert.equal(after.reservations, before.reservations + Number(requestWon));
    });

    await t.test("missing proof, task insert, audit and final receipt failures roll back every command effect", async () => {
      const invalid = await seed("requested"), beforeInvalid = await counts();
      await assert.rejects(run(command("reservation.confirm", { reservationId: invalid.reservation, unitVersion: 1, sourceReference: "" })), /source/i);
      assert.deepEqual(await counts(), beforeInvalid);
      assert.equal((await scalar("select status from property_reservations where id=$1", [invalid.reservation])).status, "requested");
      for (const table of ["tasks", "audit_logs", "crm_command_receipts"]) {
        const item = await seed("requested"), before = await counts();
        const reservationBefore = await scalar("select * from property_reservations where id=$1", [item.reservation]), unitBefore = await scalar("select * from property_units where id=$1", [item.unit]);
        await db.admin.query("create function synthetic_history_task_failure() returns trigger language plpgsql as $$ begin raise exception 'SYNTHETIC_ATOMIC_FAILURE'; end $$");
        await db.admin.query(`create trigger synthetic_history_task_failure before insert on ${table} for each row execute function synthetic_history_task_failure()`);
        try {
          await assert.rejects(run(command("reservation.confirm", { reservationId: item.reservation, unitVersion: 1, sourceReference: "MUSTER gültiger Nachweis" })), /SYNTHETIC_ATOMIC_FAILURE/);
          assert.deepEqual(await counts(), before);
          assert.deepEqual(await scalar("select * from property_reservations where id=$1", [item.reservation]), reservationBefore);
          assert.deepEqual(await scalar("select * from property_units where id=$1", [item.unit]), unitBefore);
        } finally {
          await db.admin.query(`drop trigger synthetic_history_task_failure on ${table}`);
          await db.admin.query("drop function synthetic_history_task_failure()");
        }
      }
    });

    await t.test("legacy NULL-resource receipts require every envelope and record scope to match; raw evidence stays private", async () => {
      const item = await seed("requested"), other = await seed("requested");
      const valid = await legacyEvidence(item), rejected: string[] = [];
      const mismatches: Parameters<typeof legacyEvidence>[1][] = [
        { record: { workspace_id: ids.foreignWorkspace } }, { record: { project_id: ids.otherProject } },
        { record: { unit_id: other.unit } }, { record: { id: other.reservation } }, { record: { status: "reserved" } },
        { event: { actor: ids.agent } }, { event: { operation: "property_sales.reservation.confirm" } },
        { event: { correlation: randomUUID() } }, { event: { resource: item.reservation } },
        { event: { project: ids.otherProject } }, { receipt: { project: ids.otherProject } },
      ];
      for (const mismatch of mismatches) rejected.push((await legacyEvidence(item, mismatch)).eventId);
      const anotherAudit = randomUUID();
      await db.admin.query("insert into audit_logs(id,workspace_id,actor_user_id,project_id,action,entity_type,after) values($1,$2,$3,$4,'synthetic.history','crm_command','{}')", [anotherAudit, ids.workspace, ids.owner, ids.project]);
      rejected.push((await legacyEvidence(item, { event: { audit: anotherAudit } })).eventId);
      // A complete foreign tenant envelope exists but cannot enter this tenant's timeline.
      rejected.push((await legacyEvidence(item, { receipt: { workspace: ids.foreignWorkspace, project: ids.foreignProject, actor: ids.foreignOwner } })).eventId);
      const page = await history(item); publicPage(page);
      assert.deepEqual(page.items.map(row => row.id), [valid.eventId]);
      assert.equal(page.items[0].actor.id, ids.owner); assert.equal(page.items[0].reservationId, item.reservation);
      assert.equal(page.items[0].status.before, null, "missing historic before-values must remain unknown");
      assert.equal(page.items[0].taskId, null, "no historic task is invented");
      for (const id of rejected) assert.ok(!page.items.some(row => row.id === id));
    });

    await t.test("unit audit is a separate sanitized source and reservation filtering needs an exact unit/reservation link", async () => {
      const item = await seed("requested"), other = await seed("requested"), included = randomUUID(), unlinked = randomUUID(), wrong = randomUUID();
      for (const [id, metadata] of [[included, { reservationId: item.reservation }], [unlinked, {}], [wrong, { reservationId: other.reservation }]] as const) {
        await db.admin.query("insert into property_unit_audit_events(id,workspace_id,project_id,unit_id,actor_user_id,event_type,before,after,reason,metadata) values($1,$2,$3,$4,$5,'authorized_sales_transition','{\"status\":\"available\",\"priceCents\":87654321,\"privateMarker\":\"RAW-UNIT-SECRET\"}','{\"status\":\"reserved\",\"version\":2,\"buyerEmail\":\"raw-buyer-secret@example.invalid\"}','RAW-AUDIT-SECRET',$6::jsonb)", [id, ids.workspace, ids.project, item.unit, ids.owner, JSON.stringify(metadata)]);
      }
      const scoped = await history(item); publicPage(scoped);
      assert.deepEqual(scoped.items.map(row => row.id), [included]);
      assert.equal(scoped.items[0].kind, "unit.audit"); assert.equal(scoped.items[0].sourceReference, null);
      const all = await loadPropertySalesHistory(owner, { projectId: ids.project, unitId: item.unit }, options); publicPage(all);
      assert.deepEqual(new Set(all.items.map(row => row.id)), new Set([included, unlinked, wrong]));
      assert.equal(all.items.find(row => row.id === wrong)?.reservationId, null);
      await assert.rejects(loadPropertySalesHistory(owner, { projectId: ids.project, unitId: item.unit, reservationId: other.reservation }, options), { code: "HISTORY_NOT_AVAILABLE" });
      await assert.rejects(loadPropertySalesHistory(owner, { projectId: ids.otherProject, unitId: item.unit }, options), { code: "HISTORY_NOT_AVAILABLE" });
      await assert.rejects(loadPropertySalesHistory(owner, { projectId: ids.foreignProject, unitId: item.unit }, options), { code: "PROJECT_FORBIDDEN" });
    });

    await t.test("pagination is stable across identical microsecond timestamps and cursor reuse is bound to W/P/U/R", async () => {
      const item = await seed("requested"), other = await seed("requested"), expected = new Set<string>();
      const at = "2025-06-15T10:11:12.123456Z";
      for (let index = 0; index < 45; index += 1) expected.add((await legacyEvidence(item, { at })).eventId);
      const first = await history(item); publicPage(first); assert.equal(first.items.length, 40); assert.ok(first.nextCursor);
      const second = await history(item, owner, first.nextCursor); publicPage(second); assert.equal(second.items.length, 5); assert.equal(second.nextCursor, null);
      const all = [...first.items, ...second.items]; assert.equal(new Set(all.map(row => row.id)).size, 45);
      assert.deepEqual(new Set(all.map(row => row.id)), expected); assert.ok(all.every(row => row.occurredAt === at));
      const repeat = await history(item, owner, first.nextCursor); assert.deepEqual(repeat, second);
      await assert.rejects(history(other, owner, first.nextCursor), { code: "INVALID_HISTORY_CURSOR" });
      await assert.rejects(loadPropertySalesHistory(owner, { projectId: ids.project, unitId: item.unit, cursor: first.nextCursor }, options), { code: "INVALID_HISTORY_CURSOR" });
      const cursor = JSON.parse(Buffer.from(first.nextCursor, "base64url").toString("utf8"));
      for (const change of [{ workspaceId: ids.foreignWorkspace }, { projectId: ids.otherProject }, { unitId: other.unit }, { reservationId: other.reservation }, { extra: "not-allowed" }, { at: "invalid" }, { rank: 2 }, { v: 2 }]) {
        await assert.rejects(history(item, owner, Buffer.from(JSON.stringify({ ...cursor, ...change })).toString("base64url")), { code: "INVALID_HISTORY_CURSOR" });
      }
      await assert.rejects(history(item, owner, "%%%"), { code: "INVALID_HISTORY_CURSOR" });
    });

    await t.test("fresh actor and project authorization applies to reads, receipt replay and task creation", async () => {
      const item = await seed("reserved"), input = command("reservation.extend", { reservationId: item.reservation, unitVersion: 1, expiresAt: future(3), sourceReference: "MUSTER berechtigte Frist" });
      const result = await run(input, agent); await reviewTask(result, item, input.action, ids.agent);
      assert.ok((await history(item, agent)).items.some(row => row.taskId === taskId(result)));
      const before = await counts();
      await db.admin.query("update project_pipeline_permissions set can_read=false,can_edit_deals=false where workspace_id=$1 and project_id=$2 and user_id=$3", [ids.workspace, ids.project, ids.agent]);
      try {
        await assert.rejects(history(item, agent), { code: "PROJECT_FORBIDDEN" });
        await assert.rejects(run(input, agent), { code: "PROJECT_FORBIDDEN" });
        await assert.rejects(run(command("reservation.extend", { ...input.payload, expiresAt: future(4) }, 2), agent), { code: "PROJECT_FORBIDDEN" });
      } finally { await db.admin.query("update project_pipeline_permissions set can_read=true,can_edit_deals=true where workspace_id=$1 and project_id=$2 and user_id=$3", [ids.workspace, ids.project, ids.agent]); }
      await db.admin.query("update workspace_users set status='suspended' where id=$1", [ids.agent]);
      try {
        await assert.rejects(history(item, agent), { code: "FORBIDDEN" });
        await assert.rejects(run(input, agent), { code: "FORBIDDEN" });
      } finally { await db.admin.query("update workspace_users set status='active' where id=$1", [ids.agent]); }
      assert.deepEqual(await counts(), before);
    });

    await t.test("confirmation and extension replay recheck the specific current developer mandate", async () => {
      for (const action of ["reservation.confirm", "reservation.extend"] as const) {
        const item = await seed(action === "reservation.confirm" ? "requested" : "reserved");
        const input = command(action, { reservationId: item.reservation, unitVersion: 1, sourceReference: "MUSTER gültige Vollmacht", ...(action === "reservation.extend" ? { expiresAt: future(3) } : {}) });
        const first = await run(input, agent); await reviewTask(first, item, action, ids.agent);
        const before = await counts();
        await db.admin.query("update crm_project_sales_authorities set can_confirm_reservation=false where workspace_id=$1 and project_id=$2 and user_id=$3", [ids.workspace, ids.project, ids.agent]);
        try {
          await assert.rejects(run(input, agent), { code: "FORBIDDEN" });
          assert.deepEqual(await counts(), before);
        } finally { await db.admin.query("update crm_project_sales_authorities set can_confirm_reservation=true where workspace_id=$1 and project_id=$2 and user_id=$3", [ids.workspace, ids.project, ids.agent]); }
        const replay = await run(input, agent); assert.equal(replay.replayed, true); assert.equal(replay.commandId, first.commandId);
        assert.deepEqual(await counts(), before);
      }
    });

    for (const action of ["unit.price.confirm", "sale.confirm"] as const) {
      await t.test(action + ": a real initial command cannot expose its receipt after only its specific mandate is revoked", async () => {
        const field = action === "unit.price.confirm" ? "can_confirm_price" : "can_confirm_sale";
        const prior = await scalar(`select ${field} as allowed from crm_project_sales_authorities where workspace_id=$1 and project_id=$2 and user_id=$3`, [ids.workspace, ids.project, ids.agent]);
        const item = await seed(action === "sale.confirm" ? "reserved" : undefined);
        const input = command(action, action === "unit.price.confirm"
          ? { unitId: item.unit, priceCents: 87654321, sourceReference: "MUSTER Preisfreigabe" }
          : { reservationId: item.reservation, unitVersion: 1, sourceReference: "MUSTER Verkaufsfreigabe" });
        await db.admin.query(`update crm_project_sales_authorities set ${field}=true where workspace_id=$1 and project_id=$2 and user_id=$3`, [ids.workspace, ids.project, ids.agent]);
        try {
          const first = await run(input, agent); assert.equal(first.replayed, false);
          const before = await counts(), unitBefore = await scalar("select * from property_units where id=$1", [item.unit]);
          const reservationBefore = item.reservation ? await scalar("select * from property_reservations where id=$1", [item.reservation]) : null;
          await db.admin.query(`update crm_project_sales_authorities set ${field}=false where workspace_id=$1 and project_id=$2 and user_id=$3`, [ids.workspace, ids.project, ids.agent]);
          await assert.rejects(run(input, agent), { code: "FORBIDDEN", status: 403 });
          assert.deepEqual(await counts(), before);
          assert.deepEqual(await scalar("select * from property_units where id=$1", [item.unit]), unitBefore);
          if (item.reservation) assert.deepEqual(await scalar("select * from property_reservations where id=$1", [item.reservation]), reservationBefore);
          assert.equal((await scalar("select count(*)::int as n from crm_command_receipts where id=$1", [first.commandId])).n, 1);
        } finally { await db.admin.query(`update crm_project_sales_authorities set ${field}=$4 where workspace_id=$1 and project_id=$2 and user_id=$3`, [ids.workspace, ids.project, ids.agent, prior.allowed]); }
      });
    }

    await t.test("persisted v2 cookie and genuine CSRF deliver a request task and customer history; anonymous and revoked reads are empty denials", async () => {
      const secret = randomBytes(48).toString("base64url"), origin = "http://127.0.0.1:3000", cookie = "v2." + randomBytes(32).toString("base64url");
      Object.assign(process.env, { DATABASE_URL: `postgresql://${db.role}@127.0.0.1:${db.port}/postgres`, NODE_ENV: "test", CRM_LOCAL_TEST_DATABASE: "1", NOVALURE_SESSION_SECRET: secret, NOVALURE_APP_ORIGIN: origin, NOVALURE_AUTH_STRICT: "1", NOVALURE_AUTH_ENCRYPTION_KEY: randomBytes(40).toString("hex"), NOVALURE_AUTH_RATE_LIMIT_SECRET: randomBytes(40).toString("hex") });
      const identity = (await scalar("select auth_identity_id from workspace_users where id=$1", [ids.owner])).auth_identity_id, sessionId = randomUUID();
      await db.admin.query("update auth_identities set credential_state='active' where id=$1", [identity]);
      await db.admin.query("insert into auth_sessions(id,token_hash,auth_identity_id,workspace_user_id,workspace_id,mfa_verified_at,expires_at) values($1,$2,$3,$4,$5,now(),now()+interval '1 hour')", [sessionId, createHash("sha256").update(cookie).digest("hex"), identity, ids.owner, ids.workspace]);
      // Existing isolated withdrawal route fixture mirrors the normal auth catalog grants.
      await db.admin.query(`grant select on auth_identities to ${db.role}`);
      await db.admin.query(`grant update(last_seen_at) on auth_sessions to ${db.role}`);
      await db.admin.query(`grant select,insert,delete on csrf_token_consumptions to ${db.role}`);
      const item = await seed(), input = command("reservation.request", { unitId: item.unit, leadId: item.lead, expiresAt: future(2) });
      const writePath = "/api/crm/property-sales", headers = { cookie: "novalure_session=" + cookie, origin, "sec-fetch-site": "same-origin" };
      const post = (csrf: boolean) => salesPost(new Request(origin + writePath, { method: "POST", headers: { ...headers, "Content-Type": "application/json", ...(csrf ? { "x-novalure-csrf-token": createCsrfToken({ method: "POST", pathname: writePath, secret, sessionCookie: cookie })!.token } : {}) }, body: JSON.stringify(input) }));
      const before = await counts(); assert.equal((await post(false)).status, 403); assert.deepEqual(await counts(), before);
      const response = await post(true); assert.equal(response.status, 200);
      const result = await response.json(); item.reservation = result.data.record.id;
      const task = await reviewTask(result, item, input.action);
      const replay = await post(true); assert.equal(replay.status, 200); assert.equal((await replay.json()).commandId, result.commandId);
      const reconcilePath = "/api/crm/commands/reconcile", beforeUnsupportedLookup = await counts();
      const unsupportedLookup = await reconcilePost(new Request(origin + reconcilePath, { method: "POST", headers: { ...headers, "Content-Type": "application/json", "idempotency-key": input.idempotencyKey, "x-correlation-id": input.correlationId, "x-novalure-csrf-token": createCsrfToken({ method: "POST", pathname: reconcilePath, secret, sessionCookie: cookie })!.token }, body: JSON.stringify({ target: writePath, method: "POST", body: input }) }));
      assert.equal(unsupportedLookup.status, 400); assert.equal((await unsupportedLookup.json()).code, "UNSUPPORTED_OPERATION");
      assert.deepEqual(await counts(), beforeUnsupportedLookup, "generic reconciliation stays unsupported even for a known sales receipt");
      const path = "/api/crm/property-sales/history?" + new URLSearchParams({ workspaceId: ids.workspace, projectId: ids.project, unitId: item.unit, reservationId: item.reservation! });
      const get = (suffix = "", authenticated = true) => historyGet(new Request(origin + path + suffix, { headers: authenticated ? headers : {} }));
      const loaded = await get(); assert.equal(loaded.status, 200); assert.equal(loaded.headers.get("cache-control"), "private, no-store");
      const page: PropertySalesHistoryPage = (await loaded.json()).data; publicPage(page);
      assert.ok(page.items.some(row => row.taskId === task.id && row.kind === "reservation.request"));
      const core = await coreGet(new Request(origin + "/api/crm/core?workspaceId=" + ids.workspace, { headers })); assert.equal(core.status, 200);
      const coreBody = await core.json(); assert.equal(coreBody.data.tasks.find((row: Row) => row.id === task.id)?.status, "open", "the delivered manual task must survive the real customer core loader");
      assert.equal((await get("&unitId=" + item.unit)).status, 400);
      const beforeReads = await counts();
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const anonymous = await get("", false); assert.equal(anonymous.status, 401);
        assert.equal(anonymous.headers.get("cache-control"), "private, no-store");
        assert.ok(!Object.hasOwn(await anonymous.json(), "data"));
      }
      await db.admin.query("update auth_sessions set revoked_at=now(),revoked_reason='SYNTHETIC HTTP test' where id=$1", [sessionId]);
      const denied = await get(); assert.equal(denied.status, 401); assert.ok(!Object.hasOwn(await denied.json(), "data"));
      assert.deepEqual(await counts(), beforeReads, "history GET and denied tokens cannot create tasks, commands or business audit events");
    });
  } finally {
    try { await closeLocalTestPool(); } finally { await db.stop(); }
    const mutableEnv: Record<string, string | undefined> = process.env;
    for (const key of envNames) { if (originalEnv[key] === undefined) delete mutableEnv[key]; else mutableEnv[key] = originalEnv[key]; }
  }
});
