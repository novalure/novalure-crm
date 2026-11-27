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
import { defaultCrmNotificationPreferences, parseCrmNotificationPreferences } from "../src/lib/crm-notifications";
import { loadCrmNotifications, markCrmNotificationsRead, prepareCrmNotificationDigest, saveCrmNotificationPreferences } from "../src/lib/db/crm-notifications-repository";

test("notification preferences accept only actual in-app categories and a valid timezone", () => {
  const defaults = defaultCrmNotificationPreferences(); assert.equal(parseCrmNotificationPreferences(defaults).categories.expose_opened, false);
  assert.throws(() => parseCrmNotificationPreferences({ ...defaults, email: true }));
  assert.throws(() => parseCrmNotificationPreferences({ ...defaults, timeZone: "Europe/Invalid" }));
  assert.throws(() => parseCrmNotificationPreferences({ ...defaults, categories: { ...defaults.categories, ads: true } }));
});
test("personal notifications persist reads, deduplicate changes and keep empty/unchanged digests quiet", { timeout: 180000 }, async (t) => {
  const db = await startLocalSalesDb();
  try {
    await applySalesSchema(db, { maxMigrationNumber: 106 }); await db.admin.query(await readFile("migrations/161_crm_notification_preferences.sql", "utf8"));
    const ws = randomUUID(), owner = randomUUID(), agent = randomUUID(), project = randomUUID(), contact = randomUUID(), lead = randomUUID(), task = randomUUID(), unit = randomUUID(), reservation = randomUUID();
    await db.admin.query("insert into workspaces(id,name,operating_model,customer_type) values($1,'SYNTHETIC notifications','self_service_customer','real_estate_broker')", [ws]);
    for (const [id, role, productRole] of [[owner, "owner", "customer_owner"], [agent, "agent", "broker_agent"]]) await db.admin.query("insert into workspace_users(id,workspace_id,name,email,role,product_role,status) values($1,$2,'Synthetic member',$3,$4,$5,'active')", [id, ws, `notification-${id}@example.invalid`, role, productRole]);
    await db.admin.query("insert into projects(id,workspace_id,name,type) values($1,$2,'SYNTHETIC notification project','Service')", [project, ws]);
    await db.admin.query("insert into project_pipeline_permissions(workspace_id,project_id,user_id,can_read,can_edit_deals) values($1,$2,$3,true,false)", [ws, project, agent]);
    await db.admin.query("insert into contacts(id,workspace_id,project_id,name,role) values($1,$2,$3,'Synthetic buyer','Käufer')", [contact, ws, project]);
    await db.admin.query("insert into leads(id,workspace_id,project_id,contact_id,assigned_to_user_id,source,type,status) values($1,$2,$3,$4,$5,'Website','Käufer','Neu')", [lead, ws, project, contact, owner]);
    await db.admin.query("insert into leads(workspace_id,project_id,contact_id,assigned_to_user_id,source,type,status,received_at,metadata) values($1,$2,$3,$4,'Website','Käufer','Neu',now(),'{\"websiteSales\":{\"syntheticTest\":true}}'),($1,$2,$3,$4,'Website','Käufer','Neu',now()-interval '9 days','{}')", [ws, project, contact, owner]);
    await db.admin.query("insert into tasks(id,workspace_id,project_id,owner_user_id,title,due_at,status) values($1,$2,$3,$4,'Synthetic due task',now()-interval '1 hour','open')", [task, ws, project, owner]);
    await db.admin.query("insert into tasks(workspace_id,project_id,owner_user_id,title,due_at,status) values($1,$2,$3,'Synthetic completed task',now(),'done'),($1,$2,$3,'Synthetic future task',now()+interval '10 days','open')", [ws, project, owner]);
    await db.admin.query("insert into property_units(id,workspace_id,project_id,unit_number) values($1,$2,$3,'SYNTHETIC-UNIT')", [unit, ws, project]);
    await db.admin.query("insert into property_reservations(id,workspace_id,project_id,unit_id,contact_id,buyer_lead_id,status,expires_at) values($1,$2,$3,$4,$5,$6,'hold',now()+interval '1 hour')", [reservation, ws, project, unit, contact, lead]);
    const session = { authenticated: true, userId: owner, workspaceId: ws, workspaceName: "Synthetic notifications", name: "Synthetic", email: `notification-${owner}@example.invalid`, role: "owner", productRole: "customer_owner", permissions: getRolePermissions("owner"), productPermissions: getProductRoleCapabilities("customer_owner"), source: "database" } as AppSession;
    const other = { ...session, userId: agent, role: "agent", productRole: "broker_agent" } as AppSession;
    const options = { pool: db.pool as unknown as TenantPool }, run = <T>(work: (tx: TenantTransaction, scoped: AppSession) => Promise<T>, actor = session) => withCrmRead(actor, work, options);
    await t.test("inbox derives only due/active signals and advertises unavailable sources honestly", async () => {
      const state = await run((tx, scoped) => loadCrmNotifications(tx, scoped, project));
      assert.equal(state.unread, 3); assert.deepEqual(new Set(state.items.map((item) => item.category)), new Set(["new_lead", "task_due", "reservation_deadline"]));
      assert.equal(state.features.expose_opened, false); assert.equal(state.features.automation_issue, false); assert.equal(state.features.publication_issue, false); assert.equal(state.delivery.email, "not_connected");
      const repeated = await run((tx, scoped) => loadCrmNotifications(tx, scoped, project)); assert.deepEqual(repeated.items.map((item) => item.key), state.items.map((item) => item.key));
    });
    await t.test("unchanged data creates no repeated or empty digest and retries return the same record", async () => {
      const requestId = randomUUID(), first = await run((tx, scoped) => prepareCrmNotificationDigest(tx, scoped, project, requestId));
      assert.equal(first.created, true); assert.ok("count" in first && first.count === 3);
      const retry = await run((tx, scoped) => prepareCrmNotificationDigest(tx, scoped, project, requestId)); assert.equal("id" in retry && retry.id, "id" in first && first.id);
      const unchanged = await run((tx, scoped) => prepareCrmNotificationDigest(tx, scoped, project, randomUUID())); assert.equal(unchanged.created, false); assert.equal("reason" in unchanged && unchanged.reason, "no_changes");
      const rows = (await db.admin.query("select status,jsonb_array_length(notification_keys)::int as n from crm_notification_digests")).rows; assert.deepEqual(rows, [{ status: "prepared", n: 3 }]);
      const state = await run((tx, scoped) => loadCrmNotifications(tx, scoped, project)); assert.equal(state.digests.length, 1);
    });
    await t.test("read receipts remain suppressed, a changed deadline becomes a new event, and read is idempotent", async () => {
      const before = await run((tx, scoped) => loadCrmNotifications(tx, scoped, project)), key = before.items.find((item) => item.category === "task_due")!.key;
      await run((tx, scoped) => markCrmNotificationsRead(tx, scoped, [key], project)); await run((tx, scoped) => markCrmNotificationsRead(tx, scoped, [key], project));
      const after = await run((tx, scoped) => loadCrmNotifications(tx, scoped, project)); assert.equal(after.items.some((item) => item.key === key), false); assert.equal(after.unread, 2);
      await db.admin.query("update tasks set due_at=now()+interval '2 hours' where id=$1", [task]);
      const changed = await run((tx, scoped) => loadCrmNotifications(tx, scoped, project)); assert.equal(changed.unread, 3); assert.notEqual(changed.items.find((item) => item.category === "task_due")!.key, key);
      const digest = await run((tx, scoped) => prepareCrmNotificationDigest(tx, scoped, project, randomUUID())); assert.equal(digest.created, true); assert.ok("count" in digest && digest.count === 1);
    });
    await t.test("preferences use real persistence, version conflicts and idempotent request keys", async () => {
      const prefs = defaultCrmNotificationPreferences(); prefs.categories.new_lead = false; prefs.timeZone = "Europe/Dublin";
      const requestId = randomUUID(), saved = await run((tx, scoped) => saveCrmNotificationPreferences(tx, scoped, prefs, 0, requestId)); assert.equal(saved.revision, 1);
      const retried = await run((tx, scoped) => saveCrmNotificationPreferences(tx, scoped, prefs, 0, requestId)); assert.equal(retried.replayed, true); assert.equal(retried.revision, 1);
      await assert.rejects(run((tx, scoped) => saveCrmNotificationPreferences(tx, scoped, { ...prefs, timeZone: "UTC" }, 0, requestId)), /Vorgangskennung/);
      await assert.rejects(run((tx, scoped) => saveCrmNotificationPreferences(tx, scoped, prefs, 0, randomUUID())), /Einstellungen wurden geändert/);
      const state = await run((tx, scoped) => loadCrmNotifications(tx, scoped, project)); assert.equal(state.preferences.timeZone, "Europe/Dublin"); assert.equal(state.items.some((item) => item.category === "new_lead"), false);
    });
    await t.test("another user cannot read preferences, mark hidden signals or access a revoked project", async () => {
      const state = await run((tx, scoped) => loadCrmNotifications(tx, scoped, project), other); assert.equal(state.unread, 0); assert.equal(state.revision, 0); assert.equal(state.digests.length, 0);
      assert.equal((await run((tx) => tx.query("select * from crm_notification_preferences"), other)).length, 0);
      await assert.rejects(run((tx, scoped) => markCrmNotificationsRead(tx, scoped, [`new_lead:${lead}`], project), other));
      await db.admin.query("update project_pipeline_permissions set can_read=false where workspace_id=$1 and user_id=$2", [ws, agent]);
      await assert.rejects(run((tx, scoped) => loadCrmNotifications(tx, scoped, project), other));
      assert.equal((await db.pool.query("select count(*)::int as n from crm_notification_digests")).rows[0].n, 0);
    });
  } finally { await db.stop(); }
});
