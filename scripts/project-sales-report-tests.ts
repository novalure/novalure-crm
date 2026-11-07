import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { applySalesSchema, startLocalSalesDb } from "./lib/local-sales-db.mjs";
import { withCrmRead, type TenantTransaction } from "../src/lib/crm-command";
import type { TenantPool } from "../src/lib/db/tenant-client";
import type { AppSession } from "../src/lib/auth/session";
import { getRolePermissions } from "../src/lib/auth/permissions";
import { getProductRoleCapabilities } from "../src/lib/product-model";
import { loadProjectSalesReport, saveProjectReportSettings } from "../src/lib/db/project-sales-report-repository";
import { buildProjectSalesReportCsv, buildProjectSalesReportPrintHtml, parseProjectReportSettings, projectReportMoney } from "../src/lib/project-sales-report";

test("report settings validate explicit targets and formats without a default commission or target", () => {
  assert.deepEqual(parseProjectReportSettings({ month: "2026-11", timeZone: "Europe/Dublin", unitSalesTarget: null, wonDealValueTargetCents: null }), { month: "2026-11", timeZone: "Europe/Dublin", unitSalesTarget: null, wonDealValueTargetCents: null });
  for (const patch of [{ month: "2026-13" }, { timeZone: "Europe/Unknown" }, { unitSalesTarget: -1 }, { wonDealValueTargetCents: "1.50" }, { wonDealValueTargetCents: "9007199254740992" }, { commissionRate: 3 }]) assert.throws(() => parseProjectReportSettings({ month: "2026-11", timeZone: "UTC", unitSalesTarget: null, wonDealValueTargetCents: null, ...patch }));
  assert.match(projectReportMoney("123456789012345678", "en-IE"), /1,234,567,890,123,456\.78/);
  assert.equal(projectReportMoney(null), "—");
});
test("project report uses scoped live counts, consistent units, dated sales and configurable monthly targets", { timeout: 180000 }, async (t) => {
  const db = await startLocalSalesDb();
  try {
    await applySalesSchema(db, { maxMigrationNumber: 106 }); await db.admin.query(await readFile("migrations/160_project_sales_report_settings.sql", "utf8"));
    const ws = randomUUID(), user = randomUUID(), viewerId = randomUUID(), project = randomUUID(), otherProject = randomUUID(), foreignWs = randomUUID(), foreignUser = randomUUID(), foreignProject = randomUUID(), contact = randomUUID(), organization = randomUUID(), lead = randomUUID();
    await db.admin.query("insert into workspaces(id,name,operating_model,customer_type) values($1,'SYNTHETIC report','self_service_customer','real_estate_broker'),($2,'SYNTHETIC foreign','self_service_customer','real_estate_broker')", [ws, foreignWs]);
    for (const [id, workspace, role, productRole] of [[user, ws, "owner", "customer_owner"], [viewerId, ws, "agent", "broker_agent"], [foreignUser, foreignWs, "owner", "customer_owner"]]) await db.admin.query("insert into workspace_users(id,workspace_id,name,email,role,product_role,status) values($1,$2,'Synthetic report member',$3,$4,$5,'active')", [id, workspace, `report-${id}@example.invalid`, role, productRole]);
    await db.admin.query("insert into projects(id,workspace_id,name,type) values($1,$2,'SYNTHETIC <report>','Service'),($3,$2,'SYNTHETIC other project','Service'),($4,$5,'SYNTHETIC foreign project','Service')", [project, ws, otherProject, foreignProject, foreignWs]);
    await db.admin.query("insert into project_pipeline_permissions(workspace_id,project_id,user_id,can_read,can_edit_deals) values($1,$2,$3,true,false)", [ws, project, viewerId]);
    await db.admin.query("insert into organizations(id,workspace_id,project_id,name,type) values($1,$2,$3,'Synthetic agency','Bauträger')", [organization, ws, project]);
    await db.admin.query("insert into contacts(id,workspace_id,project_id,organization_id,name,role,email) values($1,$2,$3,$4,'Synthetic buyer','Käufer','report-buyer@example.invalid')", [contact, ws, project, organization]);
    await db.admin.query("insert into leads(id,workspace_id,project_id,contact_id,source,type,status,received_at) values($1,$2,$3,$4,'Manual','Käufer','Neu','2026-11-02T12:00:00Z')", [lead, ws, project, contact]);
    const unitIds: string[] = [];
    for (const [i, status] of ["available", "available", "reserved", "sold", "sold", "blocked", "available"].entries()) { const id = randomUUID(); unitIds.push(id); await db.admin.query("insert into property_units(id,workspace_id,project_id,unit_number,price_cents,status) values($1,$2,$3,$4,$5,$6)", [id, ws, project, `SYNTHETIC-${i}`, (i + 1) * 10000, status]); }
    await db.admin.query("insert into property_units(workspace_id,project_id,unit_number,price_cents,status,metadata) values($1,$2,'SYNTHETIC-HELPER',99999999,'available','{\"defaultUnit\":true,\"hidden\":true}')", [ws, project]);
    await db.admin.query("insert into property_units(workspace_id,project_id,unit_number,price_cents,status) values($1,$2,'SYNTHETIC-OTHER',99999999,'available')", [ws, otherProject]);
    const reservationIds = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    for (const [index, unitIndex, status, expires] of [[0, 1, "hold", "+1 hour"], [1, 2, "reserved", "+1 hour"], [2, 3, "converted", "+1 hour"], [3, 6, "hold", "-1 hour"]] as const) await db.admin.query("insert into property_reservations(id,workspace_id,project_id,unit_id,contact_id,buyer_lead_id,status,expires_at) values($1,$2,$3,$4,$5,$6,$7,now()+$8::interval)", [reservationIds[index], ws, project, unitIds[unitIndex], contact, lead, status, expires]);
    const authority = randomUUID();
    await db.admin.query("insert into crm_project_sales_authorities(id,workspace_id,project_id,user_id,developer_organization_id,contact_id,can_confirm_sale,assignment_source,assigned_by) values($1,$2,$3,$4,$5,$6,true,'Synthetic fixture',$4)", [authority, ws, project, user, organization, contact]);
    await db.admin.query("insert into property_sales(workspace_id,project_id,unit_id,reservation_id,buyer_lead_id,contact_id,authority_id,confirmed_by,source_reference,confirmed_at,unit_version) values($1,$2,$3,$4,$5,$6,$7,$8,'Synthetic confirmed sale','2026-11-02T12:00:00Z',1)", [ws, project, unitIds[3], reservationIds[2], lead, contact, authority, user]);
    for (const [name, closed, value, metadata] of [["Dated", "2026-11-02T12:00:00Z", 12345678, {}], ["Undated", null, 99999999, {}], ["Synthetic excluded", "2026-11-02T12:00:00Z", 77777777, { websiteSales: { syntheticTest: true } }]]) await db.admin.query("insert into deals(workspace_id,project_id,contact_id,lead_id,name,stage,value_cents,closed_at,expected_close_date,metadata) values($1,$2,$3,$4,$5,'Gewonnen',$6,$7,'2026-11-02',$8::jsonb)", [ws, project, contact, lead, name, value, closed, JSON.stringify(metadata)]);
    await db.admin.query("insert into leads(workspace_id,project_id,contact_id,source,type,status,received_at) values($1,$2,$3,'Boundary','Käufer','Neu','2026-10-31T23:30:00Z'),($1,$2,$3,'=DANGEROUS-FORMULA','Käufer','Neu','2026-11-02T10:00:00Z')", [ws, project, contact]);
    await db.admin.query("insert into leads(workspace_id,project_id,contact_id,source,type,status,received_at,metadata) values($1,$2,$3,'Synthetic excluded','Käufer','Neu','2026-11-02T10:00:00Z','{\"websiteSales\":{\"syntheticTest\":true}}')", [ws, project, contact]);
    for (const status of ["DRAFT", "ACCEPTED"]) {
      const dealId = randomUUID();
      await db.admin.query("insert into deals(id,workspace_id,project_id,contact_id,lead_id,name,stage) values($1,$2,$3,$4,$5,'Synthetic offer deal','Neuer Lead')", [dealId, ws, project, contact, lead]);
      await db.admin.query("insert into crm_offers(workspace_id,project_id,deal_id,contact_id,lead_id,organization_id,status,follow_up_status,response_reference,response_actor_id,created_by) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10)", [ws, project, dealId, contact, lead, organization, status, status === "ACCEPTED" ? "STOPPED" : "NONE", status === "ACCEPTED" ? "Synthetic accepted offer" : null, user]);
    }
    const session = { authenticated: true, userId: user, workspaceId: ws, workspaceName: "Synthetic report", name: "Synthetic", email: `report-${user}@example.invalid`, role: "owner", productRole: "customer_owner", permissions: getRolePermissions("owner"), productPermissions: getProductRoleCapabilities("customer_owner"), source: "database" } as AppSession;
    const viewer = { ...session, userId: viewerId, role: "agent", productRole: "broker_agent" } as AppSession, foreign = { ...session, userId: foreignUser, workspaceId: foreignWs } as AppSession;
    const options = { pool: db.pool as unknown as TenantPool }, run = <T>(work: (tx: TenantTransaction, scoped: AppSession) => Promise<T>, actor = session) => withCrmRead(actor, work, options);
    await t.test("unit categories are mutually exclusive and do not multiply values through reservations", async () => {
      const report = await run((tx, scoped) => loadProjectSalesReport(tx, scoped, project, "2026-11"));
      assert.equal(report.inventory.total, 7); assert.equal(report.inventory.excludedDefaultUnits, 1);
      assert.deepEqual(Object.fromEntries(report.inventory.states.map((state) => [state.status, state.count])), { available: 2, hold: 1, reserved: 1, sold: 2, blocked: 1 });
      assert.equal(report.inventory.states.reduce((sum, state) => sum + BigInt(state.askingValueCents), BigInt(0)), BigInt(280000));
      assert.equal(report.inventory.expiredOpenReservations, 1); assert.equal(report.sales.confirmedThisMonth, 1); assert.equal(report.sales.soldWithoutConfirmation, 1);
      assert.equal(report.deals.wonThisMonth, 1); assert.equal(report.deals.wonValueThisMonthCents, "12345678"); assert.equal(report.deals.wonWithoutClosingDate, 1);
      assert.deepEqual(Object.fromEntries(report.offers.map((offer) => [offer.status, offer.count])), { ACCEPTED: 1, DRAFT: 1 });
      assert.equal(report.leadSources.some((source) => source.source === "Synthetic excluded" || source.source === "Boundary"), false);
      assert.equal(report.settings.unitSalesTarget, null); assert.equal(report.settings.wonDealValueTargetCents, null); assert.equal(report.timeZone, "UTC");
      const csv = buildProjectSalesReportCsv(report); assert.match(csv, /'=DANGEROUS-FORMULA/);
      const html = buildProjectSalesReportPrintHtml(report, "de"); assert.match(html, /SYNTHETIC &lt;report&gt;/); assert.doesNotMatch(html, /SYNTHETIC <report>/); assert.match(html, /default-src 'none'/);
    });
    await t.test("monthly targets persist independently with CAS and change month bounds using the saved timezone", async () => {
      const settings = { month: "2026-11", timeZone: "Europe/Vienna", unitSalesTarget: 3, wonDealValueTargetCents: "20000000" };
      const saved = await run((tx, scoped) => saveProjectReportSettings(tx, scoped, project, settings, 0)); assert.equal(saved.revision, 1);
      await assert.rejects(run((tx, scoped) => saveProjectReportSettings(tx, scoped, project, settings, 0)), /Monatsziele wurden geändert/);
      const report = await run((tx, scoped) => loadProjectSalesReport(tx, scoped, project, "2026-11")); assert.equal(report.settings.unitSalesTarget, 3); assert.equal(report.timeZone, "Europe/Vienna"); assert.equal(report.leadSources.find((source) => source.source === "Boundary")?.count, 1);
      const otherMonth = await run((tx, scoped) => loadProjectSalesReport(tx, scoped, project, "2026-12")); assert.equal(otherMonth.settings.unitSalesTarget, null); assert.equal(otherMonth.deals.wonThisMonth, 0);
      await run((tx, scoped) => saveProjectReportSettings(tx, scoped, project, { ...settings, unitSalesTarget: null, wonDealValueTargetCents: null }, 1));
      assert.equal((await run((tx, scoped) => loadProjectSalesReport(tx, scoped, project, "2026-11"))).settings.unitSalesTarget, null);
    });
    await t.test("project readers cannot change targets and foreign or revoked grants cannot read the report", async () => {
      const read = await run((tx, scoped) => loadProjectSalesReport(tx, scoped, project, "2026-11"), viewer); assert.equal(read.canConfigure, false); assert.equal(read.inventory.total, 7);
      await assert.rejects(run((tx, scoped) => saveProjectReportSettings(tx, scoped, project, { month: "2026-11", timeZone: "UTC", unitSalesTarget: 9, wonDealValueTargetCents: null }, 2), viewer));
      await assert.rejects(run((tx, scoped) => loadProjectSalesReport(tx, scoped, project, "2026-11"), foreign));
      await db.admin.query("update project_pipeline_permissions set can_read=false where workspace_id=$1 and user_id=$2", [ws, viewerId]);
      await assert.rejects(run((tx, scoped) => loadProjectSalesReport(tx, scoped, project, "2026-11"), viewer));
    });
  } finally { await db.stop(); }
});
