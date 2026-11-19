import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { test } from "node:test";
import { getRolePermissions } from "../src/lib/auth/permissions";
import { getProductRoleCapabilities } from "../src/lib/product-model";
import type { AppSession } from "../src/lib/auth/session";
import type { TenantPool } from "../src/lib/db/tenant-client";
import { runPropertySalesCommand, loadPropertySalesWorkspace, type PropertySalesCommand } from "../src/lib/db/property-sales-repositories";
import { withCrmRead } from "../src/lib/crm-command";
import { loadPropertyReservations } from "../src/lib/db/crm-loaders";
import { loadProjectSalesReport } from "../src/lib/db/project-sales-report-repository";
import { closeLocalTestPool } from "../src/lib/db/local-test-transport";
import { createCsrfToken } from "../src/lib/security/csrf-core";
import { summarizeInventory } from "../src/lib/crm-analysis";
import type { PropertyReservation } from "../src/lib/crm-types";
import { findOpenDealReservation } from "../src/lib/property-reservation-state";
import { POST } from "../src/app/api/crm/property-sales/route";
import { startLocalSalesDb, applySalesSchema } from "./lib/local-sales-db.mjs";

test("inventory deadline warnings include only open requests and reservations, excluding every terminal state", () => {
  const statuses: PropertyReservation["status"][] = ["requested", "hold", "reserved", "expired", "converted", "withdrawn"];
  const reservations = statuses.map(status => ({ id: randomUUID(), workspaceId: randomUUID(), projectId: randomUUID(), unitId: randomUUID(), contactId: randomUUID(), status, expiresAt: "2030-01-01T12:00:00Z", depositCents: 0, contractMilestone: "not_started" as const, nextAction: "" }));
  assert.deepEqual(summarizeInventory([], reservations, new Date("2030-01-01T10:00:00Z")).expiringReservations.map(row => row.status), ["requested", "hold", "reserved"]);
  const history = { ...reservations[5], projectId: "synthetic-project", contactId: "synthetic-buyer" };
  const active = { ...reservations[2], projectId: history.projectId, contactId: history.contactId };
  assert.equal(findOpenDealReservation([history, active], history.projectId, "synthetic-deal", history.contactId)?.id, active.id);
  assert.equal(findOpenDealReservation([history], history.projectId, "synthetic-deal", history.contactId), undefined);
  assert.equal(findOpenDealReservation([active], "different-project", "synthetic-deal", history.contactId), undefined);
});

test("reservation withdrawal is a distinct authorized atomic lifecycle with real PostgreSQL and cookie/CSRF route", { timeout: 240_000 }, async t => {
  const db = await startLocalSalesDb();
  const names = ["DATABASE_URL", "NODE_ENV", "CRM_LOCAL_TEST_DATABASE", "NOVALURE_SESSION_SECRET", "NOVALURE_APP_ORIGIN", "NOVALURE_AUTH_STRICT", "NOVALURE_AUTH_ENCRYPTION_KEY", "NOVALURE_AUTH_RATE_LIMIT_SECRET"];
  const original = Object.fromEntries(names.map(key => [key, process.env[key]]));
  const ids = { workspace: randomUUID(), owner: randomUUID(), project: randomUUID(), otherProject: randomUUID(), organization: randomUUID(), representative: randomUUID(), buyer: randomUUID(), lead: randomUUID(), agent: randomUUID(), foreignWorkspace: randomUUID(), foreignProject: randomUUID() };
  const owner: AppSession = { authenticated: true, userId: ids.owner, workspaceId: ids.workspace, workspaceName: "SYNTHETIC Withdrawal", name: "SYNTHETIC owner", email: "synthetic-withdrawal@example.invalid", role: "owner", productRole: "customer_owner", permissions: getRolePermissions("owner"), productPermissions: getProductRoleCapabilities("customer_owner"), source: "database" };
  const agent: AppSession = { ...owner, userId: ids.agent, role: "agent", productRole: "developer_sales", permissions: getRolePermissions("agent"), productPermissions: getProductRoleCapabilities("developer_sales") };
  const options = { pool: db.pool as unknown as TenantPool };
  const run = (command: PropertySalesCommand, session = owner) => runPropertySalesCommand(session, command, options);
  const command = (reservationId: string, unitVersion = 1, expectedVersion = 1): PropertySalesCommand => ({ action: "reservation.withdraw", projectId: ids.project, expectedVersion, idempotencyKey: randomUUID(), correlationId: randomUUID(), payload: { reservationId, unitVersion, sourceReference: "SYNTHETIC buyer withdrew; contractual and deposit consequences require manual review" } });
  const scalar = async (sql: string, params: unknown[] = []) => (await db.admin.query(sql, params)).rows[0];
  const counts = () => scalar("select (select count(*)::int from tasks) as tasks,(select count(*)::int from audit_logs) as audit,(select count(*)::int from crm_command_receipts) as receipts,(select count(*)::int from crm_domain_events) as events,(select count(*)::int from property_unit_audit_events) as unit_audit");
  const seed = async (status = "reserved", unitStatus = status === "requested" ? "available" : "reserved") => {
    const unit = randomUUID(), reservation = randomUUID();
    await db.admin.query("insert into property_units(id,workspace_id,project_id,unit_number,status,price_cents,buyer_contact_id,metadata) values($1,$2,$3,$4,$5,12345678,$6,'{\"syntheticWithdrawal\":true}')", [unit, ids.workspace, ids.project, "SYNTHETIC-" + unit.slice(0, 8), unitStatus, unitStatus === "reserved" ? ids.buyer : null]);
    await db.admin.query("insert into property_reservations(id,workspace_id,project_id,unit_id,contact_id,buyer_lead_id,status,expires_at,deposit_cents,contract_milestone,confirmation,metadata) values($1,$2,$3,$4,$5,$6,$7,'2035-01-01T12:00:00Z',75000,'contract_draft','{\"sourceReference\":\"SYNTHETIC original confirmation\"}','{\"syntheticWithdrawal\":true,\"originalMarker\":\"keep\"}')", [reservation, ids.workspace, ids.project, unit, ids.buyer, ids.lead, status]);
    return { unit, reservation };
  };
  try {
    await applySalesSchema(db);
    await db.admin.query("insert into workspaces(id,name,operating_model,customer_type) values($1,'SYNTHETIC Withdrawal','self_service_customer','property_developer'),($2,'SYNTHETIC Foreign','self_service_customer','property_developer')", [ids.workspace, ids.foreignWorkspace]);
    await db.admin.query("insert into workspace_users(id,workspace_id,name,email,role,product_role,status,onboarding_completed_at) values($1,$3,'SYNTHETIC owner','synthetic-withdrawal@example.invalid','owner','customer_owner','active',now()),($2,$3,'SYNTHETIC agent','synthetic-withdrawal-agent@example.invalid','agent','developer_sales','active',now())", [ids.owner, ids.agent, ids.workspace]);
    await db.admin.query("insert into projects(id,workspace_id,name,type) values($1,$2,'SYNTHETIC Withdrawal','Bauträger'),($3,$2,'SYNTHETIC unassigned','Bauträger'),($4,$5,'SYNTHETIC Foreign','Bauträger')", [ids.project, ids.workspace, ids.otherProject, ids.foreignProject, ids.foreignWorkspace]);
    await db.admin.query("insert into project_pipeline_permissions(workspace_id,project_id,user_id,can_read,can_edit_deals) values($1,$2,$3,true,true)", [ids.workspace, ids.project, ids.agent]);
    await db.admin.query("insert into organizations(id,workspace_id,project_id,name,type) values($1,$2,$3,'SYNTHETIC Developer','Bauträger')", [ids.organization, ids.workspace, ids.project]);
    await db.admin.query("insert into contacts(id,workspace_id,project_id,organization_id,name,email,role) values($1,$3,$4,$5,'SYNTHETIC representative','synthetic-representative@example.invalid','Bauträger'),($2,$3,$4,null,'SYNTHETIC buyer','synthetic-buyer@example.invalid','Käufer')", [ids.representative, ids.buyer, ids.workspace, ids.project, ids.organization]);
    await db.admin.query("insert into leads(id,workspace_id,project_id,contact_id,type,intent) values($1,$2,$3,$4,'Käufer','SYNTHETIC Withdrawal')", [ids.lead, ids.workspace, ids.project, ids.buyer]);
    await db.admin.query("update projects set developer_organization_id=$2 where id=$1", [ids.project, ids.organization]);
    for (const userId of [ids.owner, ids.agent]) await db.admin.query("insert into crm_project_sales_authorities(workspace_id,project_id,user_id,developer_organization_id,contact_id,can_confirm_reservation,assignment_source,assigned_by) values($1,$2,$3,$4,$5,true,'SYNTHETIC written authority',$6)", [ids.workspace, ids.project, userId, ids.organization, ids.representative, ids.owner]);

    await t.test("confirmed withdrawal before deadline releases only its unit, preserves price/deposit/confirmation and unrelated tasks; exact retry converges", async () => {
      const item = await seed(), beforeReservation = await scalar("select * from property_reservations where id=$1", [item.reservation]);
      const legacyTask = randomUUID();
      await db.admin.query("insert into tasks(id,workspace_id,project_id,contact_id,title,status) values($1,$2,$3,$4,'SYNTHETIC legacy reservation reminder','open')", [legacyTask, ids.workspace, ids.project, ids.buyer]);
      const legacyBefore = await scalar("select * from tasks where id=$1", [legacyTask]), before = await counts();
      const request = command(item.reservation), first = await run(request), replay = await run(request);
      assert.equal(replay.replayed, true); assert.equal(replay.commandId, first.commandId);
      const row = await scalar("select * from property_reservations where id=$1", [item.reservation]), unit = await scalar("select * from property_units where id=$1", [item.unit]);
      assert.equal(row.status, "withdrawn"); assert.equal(Number(row.version), 2); assert.equal(row.expires_at.toISOString(), beforeReservation.expires_at.toISOString());
      for (const key of ["deposit_cents", "contract_milestone", "confirmation"]) assert.deepEqual(row[key], beforeReservation[key]);
      assert.equal(row.metadata.originalMarker, "keep"); assert.equal(row.metadata.withdrawal.previousStatus, "reserved");
      assert.equal(unit.status, "available"); assert.equal(unit.buyer_contact_id, null); assert.equal(unit.deal_id, null); assert.equal(Number(unit.price_cents), 12345678); assert.equal(Number(unit.version), 2);
      assert.deepEqual(await scalar("select * from tasks where id=$1", [legacyTask]), legacyBefore);
      assert.ok("taskId" in first.data);
      const followup = await scalar("select * from tasks where id=$1", [first.data.taskId]);
      assert.equal(followup.metadata.reservationId, item.reservation); assert.equal(followup.metadata.manualReviewOnly, true); assert.equal(followup.status, "open"); assert.match(followup.title, /manuell prüfen/);
      const after = await counts(); assert.equal(after.tasks, before.tasks + 1); assert.equal(after.receipts, before.receipts + 1); assert.equal(after.unit_audit, before.unit_audit + 1); assert.equal(after.events, before.events + 1); assert.equal(after.audit, before.audit + 2);
      const audit = await scalar("select before,after from audit_logs where entity_id=$1 and action='reservation.withdrawn'", [item.reservation]);
      assert.equal(audit.before.reservation.status, "reserved"); assert.equal(audit.after.reservation.status, "withdrawn"); assert.equal(audit.after.taskId, followup.id);
      const loaded = await withCrmRead(owner, () => loadPropertyReservations(ids.workspace), options);
      assert.equal(loaded.find(row => row.id === item.reservation)?.status, "withdrawn");
      const snapshot = await loadPropertySalesWorkspace(owner, ids.project, options); assert.equal(snapshot.reservations.find(row => row.id === item.reservation)?.status, "withdrawn");
      const report = await withCrmRead(owner, tx => loadProjectSalesReport(tx, owner, ids.project, "2030-01"), options);
      assert.equal(report.inventory.states.find(row => row.status === "available")?.count, 1); assert.equal(report.inventory.states.find(row => row.status === "reserved")?.count, 0); assert.equal(report.inventory.pendingRequests, 0);
    });
    await t.test("requested and legacy hold withdrawals are terminal and do not invent a unit transition", async () => {
      for (const status of ["requested", "hold"]) {
        const item = await seed(status, "available"), before = await scalar("select * from property_units where id=$1", [item.unit]);
        await run(command(item.reservation));
        assert.deepEqual(await scalar("select * from property_units where id=$1", [item.unit]), before);
        assert.equal((await scalar("select status from property_reservations where id=$1", [item.reservation])).status, "withdrawn");
      }
    });
    await t.test("missing/stale versions, missing reason, terminal/sold/blocked state and competing reservation reject without partial evidence", async () => {
      const item = await seed(), before = await counts();
      for (const request of [{ ...command(item.reservation), expectedVersion: undefined }, command(item.reservation, 2), command(item.reservation, 1, 2), { ...command(item.reservation), payload: { reservationId: item.reservation, unitVersion: 1, sourceReference: "" } }]) await assert.rejects(run(request), /expectedVersion|Version changed|source/);
      const otherRequest = randomUUID();
      await db.admin.query("insert into property_reservations(id,workspace_id,project_id,unit_id,contact_id,status,expires_at) values($1,$2,$3,$4,$5,'requested','2035-01-01')", [otherRequest, ids.workspace, ids.project, item.unit, ids.buyer]);
      await assert.rejects(run(command(item.reservation)), /Another open reservation/);
      for (const [status, unitStatus] of [["converted", "sold"], ["expired", "available"], ["withdrawn", "available"], ["reserved", "blocked"]]) {
        const closed = await seed(status, unitStatus); await assert.rejects(run(command(closed.reservation)), /Invalid reservation/);
      }
      assert.deepEqual(await counts(), before); assert.equal((await scalar("select status from property_reservations where id=$1", [item.reservation])).status, "reserved");
    });
    await t.test("a different current unit buyer or deal denies withdrawal without clearing assignments or creating evidence", async () => {
      const otherDeal = randomUUID();
      await db.admin.query("insert into deals(id,workspace_id,project_id,contact_id,name,stage) values($1,$2,$3,$4,'SYNTHETIC different deal','Neu')", [otherDeal, ids.workspace, ids.project, ids.buyer]);
      for (const mismatch of ["buyer", "deal"]) {
        const item = await seed();
        if (mismatch === "buyer") await db.admin.query("update property_units set buyer_contact_id=$2 where id=$1", [item.unit, ids.representative]);
        else await db.admin.query("update property_units set deal_id=$2 where id=$1", [item.unit, otherDeal]);
        const before = await counts(), unitBefore = await scalar("select * from property_units where id=$1", [item.unit]), reservationBefore = await scalar("select * from property_reservations where id=$1", [item.reservation]);
        await assert.rejects(run(command(item.reservation)), /Unit assignment changed/);
        assert.deepEqual(await scalar("select * from property_units where id=$1", [item.unit]), unitBefore);
        assert.deepEqual(await scalar("select * from property_reservations where id=$1", [item.reservation]), reservationBefore);
        assert.deepEqual(await counts(), before);
      }
    });
    await t.test("current role, revoked project grant, foreign tenant/project and revoked explicit authority deny writes and receipt replay", async () => {
      const item = await seed(), request = command(item.reservation), before = await counts();
      await assert.rejects(run({ ...request, projectId: ids.foreignProject }), /Project access/);
      await assert.rejects(run({ ...request, projectId: ids.otherProject }, agent), /Project access/);
      await db.admin.query("update crm_project_sales_authorities set enabled=false where user_id=$1", [ids.agent]);
      await assert.rejects(run(request, agent), /Explicit project authority/);
      await db.admin.query("update crm_project_sales_authorities set enabled=true where user_id=$1", [ids.agent]);
      await db.admin.query("update project_pipeline_permissions set can_read=false where user_id=$1", [ids.agent]);
      await assert.rejects(run(request, agent), /Project access/);
      await db.admin.query("update project_pipeline_permissions set can_read=true where user_id=$1", [ids.agent]);
      await db.admin.query("update workspace_users set role='assistant',product_role='viewer' where id=$1", [ids.agent]);
      await assert.rejects(run(request, agent));
      await db.admin.query("update workspace_users set role='agent',product_role='developer_sales' where id=$1", [ids.agent]);
      assert.deepEqual(await counts(), before);
      const result = await run(request, agent); assert.equal(result.replayed, false);
      const after = await counts();
      await db.admin.query("update crm_project_sales_authorities set enabled=false where user_id=$1", [ids.agent]);
      await assert.rejects(run(request, agent), /Explicit project authority/);
      assert.deepEqual(await counts(), after);
    });
    await t.test("concurrent distinct withdrawals commit exactly once; concurrent same-key retries converge", async () => {
      const item = await seed(), before = await counts();
      const results = await Promise.allSettled([run(command(item.reservation)), run(command(item.reservation))]);
      assert.equal(results.filter(row => row.status === "fulfilled").length, 1);
      const failed = results.find(row => row.status === "rejected"); assert.ok(failed?.status === "rejected"); assert.match(String(failed.reason), /Version changed/);
      const after = await counts(); assert.equal(after.tasks, before.tasks + 1); assert.equal(after.receipts, before.receipts + 1);
      const another = await seed(), request = command(another.reservation);
      const replays = await Promise.all([run(request), run(request)]); assert.equal(replays[0].commandId, replays[1].commandId); assert.equal(replays.filter(row => row.replayed).length, 1);
    });
    await t.test("dedicated audit and final immutable receipt failures roll back reservation, unit and task together", async () => {
      for (const table of ["audit_logs", "crm_command_receipts"]) {
        const item = await seed(), before = await counts(), reservationBefore = await scalar("select * from property_reservations where id=$1", [item.reservation]), unitBefore = await scalar("select * from property_units where id=$1", [item.unit]);
        await db.admin.query("create function synthetic_reject_withdrawal() returns trigger language plpgsql as $$ begin raise exception 'SYNTHETIC withdrawal audit failure'; end $$");
        await db.admin.query(`create trigger synthetic_reject_withdrawal before insert on ${table} for each row execute function synthetic_reject_withdrawal()`);
        try {
          await assert.rejects(run(command(item.reservation)), /SYNTHETIC withdrawal audit failure/);
          assert.deepEqual(await scalar("select * from property_reservations where id=$1", [item.reservation]), reservationBefore);
          assert.deepEqual(await scalar("select * from property_units where id=$1", [item.unit]), unitBefore); assert.deepEqual(await counts(), before);
        } finally { await db.admin.query(`drop trigger synthetic_reject_withdrawal on ${table}`); await db.admin.query("drop function synthetic_reject_withdrawal()"); }
      }
    });
    await t.test("actual supported HTTP route requires cookie/CSRF and persists one withdrawal with fresh-token replay", async () => {
      const secret = randomBytes(48).toString("base64url"), origin = "http://127.0.0.1:3000", cookie = "v2." + randomBytes(32).toString("base64url");
      Object.assign(process.env, { DATABASE_URL: `postgresql://${db.role}@127.0.0.1:${db.port}/postgres`, NODE_ENV: "test", CRM_LOCAL_TEST_DATABASE: "1", NOVALURE_SESSION_SECRET: secret, NOVALURE_APP_ORIGIN: origin, NOVALURE_AUTH_STRICT: "1", NOVALURE_AUTH_ENCRYPTION_KEY: randomBytes(40).toString("hex"), NOVALURE_AUTH_RATE_LIMIT_SECRET: randomBytes(40).toString("hex") });
      const identity = (await scalar("select auth_identity_id from workspace_users where id=$1", [ids.owner])).auth_identity_id;
      await db.admin.query("update auth_identities set credential_state='active' where id=$1", [identity]);
      await db.admin.query("insert into auth_sessions(id,token_hash,auth_identity_id,workspace_user_id,workspace_id,mfa_verified_at,expires_at) values($1,$2,$3,$4,$5,now(),now()+interval '1 hour')", [randomUUID(), createHash("sha256").update(cookie).digest("hex"), identity, ids.owner, ids.workspace]);
      await db.admin.query(`grant select on auth_identities to ${db.role}`); await db.admin.query(`grant update(last_seen_at) on auth_sessions to ${db.role}`); await db.admin.query(`grant select,insert,delete on csrf_token_consumptions to ${db.role}`);
      const item = await seed(), body = command(item.reservation), path = "/api/crm/property-sales";
      const request = (csrf = true) => new Request(origin + path, { method: "POST", headers: { "Content-Type": "application/json", cookie: "novalure_session=" + cookie, origin, "sec-fetch-site": "same-origin", ...(csrf ? { "x-novalure-csrf-token": createCsrfToken({ method: "POST", pathname: path, secret, sessionCookie: cookie })!.token } : {}) }, body: JSON.stringify(body) });
      assert.equal((await POST(new Request(origin + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }))).status, 401);
      assert.equal((await POST(request(false))).status, 403);
      const first = await POST(request()); assert.equal(first.status, 200, await first.clone().text());
      const replay = await POST(request()); assert.equal(replay.status, 200, await replay.clone().text()); assert.equal((await replay.json()).replayed, true);
    });
  } finally {
    await closeLocalTestPool(); await db.stop();
    for (const key of names) { if (original[key] === undefined) delete process.env[key]; else process.env[key] = original[key]; }
  }
});
