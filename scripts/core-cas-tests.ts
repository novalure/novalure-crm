import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { startLocalSalesDb, applySalesSchema } from "./lib/local-sales-db.mjs";
import { archiveContactRecord, createProjectRecord, updateProjectRecord, upsertContactRecord, upsertTaskRecord, type RepositoryWriteResult } from "../src/lib/db/crm-write-repositories";
import { loadContacts, loadProjects, loadTasks } from "../src/lib/db/crm-loaders";
import { withCrmRead } from "../src/lib/crm-command";
import type { AppSession } from "../src/lib/auth/session";
import type { TenantPool } from "../src/lib/db/tenant-client";
import { getRolePermissions } from "../src/lib/auth/permissions";
import { getProductRoleCapabilities } from "../src/lib/product-model";

function saved<T>(result: RepositoryWriteResult<T>): T {
  if (!result.persisted) assert.fail(result.reason);
  return result.data;
}
function denied<T>(result: RepositoryWriteResult<T>, pattern: RegExp) {
  assert.equal(result.persisted, false, JSON.stringify(result));
  if (!result.persisted) assert.match(result.reason, pattern);
}

test("G05 core CAS: real PostgreSQL rejects stale, concurrent and foreign writes", { timeout: 180000 }, async t => {
  const db = await startLocalSalesDb();
  const previous = process.env.DATABASE_URL;
  process.env.DATABASE_URL = `postgresql://${db.role}@127.0.0.1:${db.port}/postgres`;
  try {
    await applySalesSchema(db);
    const options = { pool: db.pool as unknown as TenantPool };
    const workspaceId = randomUUID(), userId = randomUUID(), projectId = randomUUID();
    await db.admin.query("insert into workspaces(id,name,operating_model,customer_type) values($1,'SYNTHETIC CAS','novalure_internal','novalure_internal')", [workspaceId]);
    await db.admin.query("insert into workspace_users(id,workspace_id,name,email,role,product_role) values($1,$2,'Synthetic owner','cas-owner@example.invalid','owner','novalureAdmin')", [userId, workspaceId]);
    await db.admin.query("insert into projects(id,workspace_id,name,type) values($1,$2,'SYNTHETIC project','Service')", [projectId, workspaceId]);
    const session = { authenticated: true, userId, workspaceId, workspaceName: "Synthetic CAS", name: "Synthetic owner", email: "cas-owner@example.invalid", role: "owner", productRole: "novalureAdmin", permissions: getRolePermissions("owner"), productPermissions: getProductRoleCapabilities("novalureAdmin"), source: "database" } as AppSession;
    const contact = saved(await upsertContactRecord({ session, contact: { name: "SYNTHETIC contact", email: "cas-contact@example.invalid", role: "Bauträger", source: "Manual", consent: "Nur CRM", projectId } }, options));
    const task = saved(await upsertTaskRecord({ session, task: { title: "SYNTHETIC task", projectId, contactId: contact.id } }, options));
    assert.equal(contact.version, 1); assert.equal(task.version, 1);

    await t.test("contact update requires the observed version and returns the new version", async () => {
      denied(await upsertContactRecord({ session, contact: { id: contact.id, name: "Missing version" } }, options), /expectedVersion/);
      const updated = saved(await upsertContactRecord({ session, expectedVersion: 1, contact: { id: contact.id, name: "Current contact" } }, options));
      assert.equal(updated.version, 2);
      denied(await upsertContactRecord({ session, expectedVersion: 1, contact: { id: contact.id, name: "Stale contact" } }, options), /VERSION_CONFLICT/);
      const row = (await db.admin.query("select name,version from contacts where id=$1", [contact.id])).rows[0];
      assert.equal(row.name, "Current contact"); assert.equal(Number(row.version), 2);
    });
    await t.test("task status CAS prevents stale reopen and returns a usable next version", async () => {
      denied(await upsertTaskRecord({ session, task: { id: task.id, status: "done" } }, options), /expectedVersion/);
      const closed = saved(await upsertTaskRecord({ session, expectedVersion: 1, task: { id: task.id, status: "done" } }, options));
      assert.equal(closed.version, 2); assert.equal(closed.status, "done");
      denied(await upsertTaskRecord({ session, expectedVersion: 1, task: { id: task.id, status: "open" } }, options), /VERSION_CONFLICT/);
      const reopened = saved(await upsertTaskRecord({ session, task: { ...closed, status: "open" } }, options));
      assert.equal(reopened.version, 3); assert.equal(reopened.status, "open");
    });
    await t.test("project PATCH requires version; create returns final version after default-pipeline setup", async () => {
      denied(await updateProjectRecord({ session, project: { id: projectId, name: "No version" } }, options), /expectedVersion/);
      const updated = saved(await updateProjectRecord({ session, expectedVersion: 1, project: { id: projectId, name: "Current project" } }, options));
      assert.equal(updated.version, 2);
      denied(await updateProjectRecord({ session, expectedVersion: 1, project: { id: projectId, name: "Stale project" } }, options), /VERSION_CONFLICT/);
      const created = saved(await createProjectRecord({ session, project: { name: "SYNTHETIC new project" } }, options));
      const row = (await db.admin.query("select version from projects where id=$1", [created.id])).rows[0];
      assert.equal(created.version, Number(row.version));
      const revised = saved(await updateProjectRecord({ session, project: { ...created, name: "Created then updated" } }, options));
      assert.equal(revised.version, created.version! + 1);
    });
    await t.test("parallel contact/task/project edits with the same version have exactly one winner", async () => {
      const results = [
        await Promise.all(["A", "B"].map(name => upsertContactRecord({ session, expectedVersion: 2, contact: { id: contact.id, name } }, options))),
        await Promise.all(["A", "B"].map(title => upsertTaskRecord({ session, expectedVersion: 3, task: { id: task.id, title } }, options))),
        await Promise.all(["A", "B"].map(name => updateProjectRecord({ session, expectedVersion: 2, project: { id: projectId, name } }, options))),
      ];
      for (const pair of results) {
        assert.equal(pair.filter(result => result.persisted).length, 1);
        const failure = pair.find(result => !result.persisted); assert.ok(failure); denied(failure, /VERSION_CONFLICT/);
      }
    });
    await t.test("internal writers invalidate an earlier interactive view without double-incrementing explicit versions", async () => {
      for (const [table, id, version] of [["contacts", contact.id, 3], ["tasks", task.id, 4], ["projects", projectId, 3]] as const) {
        await db.admin.query(`update ${table} set updated_at=now() where id=$1`, [id]);
        assert.equal(Number((await db.admin.query(`select version from ${table} where id=$1`, [id])).rows[0].version), version + 1);
        await db.admin.query(`update ${table} set version=version+1 where id=$1`, [id]);
        assert.equal(Number((await db.admin.query(`select version from ${table} where id=$1`, [id])).rows[0].version), version + 2);
        await assert.rejects(db.admin.query(`update ${table} set version=1 where id=$1`, [id]), /Invalid CRM version transition/);
      }
      denied(await upsertContactRecord({ session, expectedVersion: 3, contact: { id: contact.id, name: "Old view" } }, options), /VERSION_CONFLICT/);
      denied(await upsertTaskRecord({ session, expectedVersion: 4, task: { id: task.id, title: "Old view" } }, options), /VERSION_CONFLICT/);
      denied(await updateProjectRecord({ session, expectedVersion: 3, project: { id: projectId, name: "Old view" } }, options), /VERSION_CONFLICT/);
    });
    await t.test("foreign ids cannot update or silently become a newly created task", async () => {
      const foreignWorkspace = randomUUID(), foreignProject = randomUUID(), foreignContact = randomUUID(), foreignTask = randomUUID();
      await db.admin.query("insert into workspaces(id,name) values($1,'SYNTHETIC foreign')", [foreignWorkspace]);
      await db.admin.query("insert into projects(id,workspace_id,name,type) values($1,$2,'Foreign project','Service')", [foreignProject, foreignWorkspace]);
      await db.admin.query("insert into contacts(id,workspace_id,project_id,name,role,source) values($1,$2,$3,'Foreign contact','Käufer','Manual')", [foreignContact, foreignWorkspace, foreignProject]);
      await db.admin.query("insert into tasks(id,workspace_id,project_id,title) values($1,$2,$3,'Foreign task')", [foreignTask, foreignWorkspace, foreignProject]);
      const before = Number((await db.admin.query("select count(*) from tasks where workspace_id=$1", [workspaceId])).rows[0].count);
      denied(await upsertContactRecord({ session, expectedVersion: 1, contact: { id: foreignContact, name: "Unauthorized" } }, options), /not found/);
      denied(await upsertTaskRecord({ session, expectedVersion: 1, task: { id: foreignTask, title: "Unauthorized" } }, options), /not found/);
      denied(await updateProjectRecord({ session, expectedVersion: 1, project: { id: foreignProject, name: "Unauthorized" } }, options), /not found/);
      assert.equal(Number((await db.admin.query("select count(*) from tasks where workspace_id=$1", [workspaceId])).rows[0].count), before);
      for (const [table, id] of [["contacts", foreignContact], ["tasks", foreignTask], ["projects", foreignProject]]) assert.equal(Number((await db.admin.query(`select version from ${table} where id=$1`, [id])).rows[0].version), 1);
    });
    await t.test("loaders return current versions and stale contact archive is rejected", async () => {
      const loaded = await withCrmRead(session, async () => ({ contacts: await loadContacts(workspaceId), tasks: await loadTasks(workspaceId), projects: await loadProjects(workspaceId) }), options);
      assert.equal(loaded.contacts.find(item => item.id === contact.id)?.version, 5);
      assert.equal(loaded.tasks.find(item => item.id === task.id)?.version, 6);
      assert.equal(loaded.projects.find(item => item.id === projectId)?.version, 5);
      denied(await archiveContactRecord({ session, contactId: contact.id, expectedVersion: 1 }, options), /VERSION_CONFLICT/);
      assert.equal((await db.admin.query("select archived_at from contacts where id=$1", [contact.id])).rows[0].archived_at, null);
      saved(await archiveContactRecord({ session, contactId: contact.id, expectedVersion: 5 }, options));
    });
  } finally {
    if (previous === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previous;
    await db.stop();
  }
});
