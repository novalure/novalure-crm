import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import pg from "pg";
import type { AppSession } from "../src/lib/auth/session";
import { getRolePermissions } from "../src/lib/auth/permissions";
import { getProductRoleCapabilities } from "../src/lib/product-model";
import type { TenantTransactionOptions } from "../src/lib/db/tenant-client";
import { createBehaviorLifecycle, runScheduledBehaviorLearning } from "../src/lib/shared-behavior/lifecycle";
import { readPrivateLearningHistory, deleteOwnLearningSignal } from "../src/lib/shared-behavior/management";
import { recordPrivateLearningSignal } from "../src/lib/shared-behavior/repository";
import { applySalesSchema, startLocalSalesDb } from "./lib/local-sales-db.mjs";

test("Paket4: private management, explicit deletion and bounded learning on disposable PostgreSQL", { timeout: 240000 }, async t => {
  const db = await startLocalSalesDb();
  let publisher: pg.Pool | undefined;
  const workspace = randomUUID(), foreign = randomUUID(), actor = randomUUID(), colleague = randomUUID(), outsider = randomUUID();
  const options: TenantTransactionOptions = { pool: db.pool as unknown as NonNullable<TenantTransactionOptions["pool"]> };
  const session = (workspaceId = workspace, userId = actor): AppSession => ({ authenticated: true, source: "database", workspaceId, userId, workspaceName: "SYNTHETIC", name: "SYNTHETIC", email: "synthetic@example.invalid", role: "owner", productRole: "customer_owner", permissions: getRolePermissions("owner"), productPermissions: getProductRoleCapabilities("customer_owner") });
  try {
    await applySalesSchema(db, { maxMigrationNumber: 90 });
    for (const name of ["foundation", "package2", "package4"]) {
      const client = await db.admin.connect();
      try { await client.query("begin"); await client.query(await readFile(`migrations/staged/shared_behavior_${name}.sql`, "utf8")); await client.query("commit"); }
      catch (error) { await client.query("rollback"); throw error; } finally { client.release(); }
    }
    await db.admin.query("insert into workspaces(id,name,operating_model) values($1,'SYNTHETIC','managed_by_novalure'),($2,'SYNTHETIC','managed_by_novalure')", [workspace, foreign]);
    for (const [w, a] of [[workspace, actor], [workspace, colleague], [foreign, outsider]]) await db.admin.query("insert into workspace_users(id,workspace_id,name,email,role,product_role) values($1,$2,'SYNTHETIC',$3,'owner','customer_owner')", [a, w, `${a}@example.invalid`]);
    const own = randomUUID(), peer = randomUUID(), other = randomUUID();
    for (const [s, eventId] of [[session(), own], [session(workspace, colleague), peer], [session(foreign, outsider), other]] as const) await recordPrivateLearningSignal(s, { eventId, issue: "unclear_goal", outcome: "fail" }, options);
    await t.test("owner history cannot expose peer or foreign private signals", async () => {
      const history = await readPrivateLearningHistory(session(), options);
      assert.deepEqual(history.signals.map(row => row.eventId), [own]);
      assert.deepEqual(history.retention, { status: "OWNER_DEFERRED", automaticDeletion: false });
    });
    await t.test("explicit delete is scoped, audited and does not delete shared history", async () => {
      assert.deepEqual(await deleteOwnLearningSignal(session(), peer, options), { deleted: false });
      assert.deepEqual(await deleteOwnLearningSignal(session(), other, options), { deleted: false });
      assert.deepEqual(await deleteOwnLearningSignal(session(), own, options), { deleted: true });
      assert.deepEqual(await deleteOwnLearningSignal(session(), own, options), { deleted: false });
      const audit = await db.admin.query("select after from audit_logs where action='learning.signal.delete'");
      assert.deepEqual(audit.rows, [{ after: { deleted: 1 } }]);
      assert.equal((await db.admin.query("select count(*)::int as n from behavior_learning_signals")).rows[0].n, 2);
    });
    await t.test("fresh inactive membership and downgraded write role deny mutation", async () => {
      await db.admin.query("update workspace_users set status='suspended' where id=$1", [actor]);
      await assert.rejects(readPrivateLearningHistory(session(), options));
      await assert.rejects(deleteOwnLearningSignal(session(), own, options));
      await db.admin.query("update workspace_users set status='active',role='assistant' where id=$1", [actor]);
      await assert.rejects(deleteOwnLearningSignal(session(), own, options));
      await db.admin.query("update workspace_users set role='owner' where id=$1", [actor]);
    });
    const role = `behavior4_${randomUUID().replaceAll("-", "")}`;
    await db.admin.query(`create role ${role} login nosuperuser nobypassrls nocreatedb nocreaterole noreplication`);
    await db.admin.query(`grant novalure_behavior_publisher to ${role}`);
    publisher = new pg.Pool({ host: "127.0.0.1", port: db.port, user: role, database: "postgres", max: 4 });
    const config = { enabled: true, selection: { ruleIds: ["clarify-goal"], targets: ["ceo"] }, expectedRevision: 0 };
    await t.test("disabled schedule makes no database connection", async () => {
      assert.deepEqual(await runScheduledBehaviorLearning({ connect: async () => { throw new Error("MUST_NOT_CONNECT"); } }, { ...config, enabled: false }), { status: "disabled" });
    });
    await t.test("concurrent schedule claims yield exactly one bounded publication", async () => {
      const results = await Promise.all([runScheduledBehaviorLearning(publisher!, config), runScheduledBehaviorLearning(publisher!, config)]);
      assert.deepEqual(results.map(r => r.status).sort(), ["already_claimed", "published"]);
      const view = await createBehaviorLifecycle(publisher!).inspect();
      assert.equal(view.runs.length, 1); assert.equal(view.runs[0].status, "published");
      assert.equal(view.history.length, 1); assert.equal(view.head.revision, 1);
      await assert.rejects(publisher!.query("select * from behavior_learning_signals"));
      await assert.rejects(createBehaviorLifecycle(db.pool).inspect(), /UNSAFE_PUBLISHER_IDENTITY/);
      for (const operation of ["select * from behavior_learning_runs", "insert into behavior_learning_runs(run_id,slot,status) values(gen_random_uuid(),now(),'running')", "update behavior_learning_runs set status='failed',completed_at=now()", "delete from behavior_learning_runs"]) await assert.rejects(db.pool.query(operation));
      await assert.rejects(publisher!.query("delete from behavior_publication_events"));
      await assert.rejects(publisher!.query("update behavior_learning_runs set status='failed'"));
    });
    await t.test("failed and rejected scheduled runs remain explicit monitor records without retry", async () => {
      // Synthetic fixture clock movement only; production admission always uses the DB clock.
      await db.admin.query("alter table behavior_learning_runs disable trigger behavior_learning_run_transition; update behavior_learning_runs set slot=slot-interval '2 days'; alter table behavior_learning_runs enable trigger behavior_learning_run_transition");
      const failed = await runScheduledBehaviorLearning(publisher!, { ...config, expectedRevision: 999 });
      assert.equal(failed.status, "failed");
      assert.equal((await runScheduledBehaviorLearning(publisher!, config)).status, "already_claimed");
      await db.admin.query("alter table behavior_learning_runs disable trigger behavior_learning_run_transition; update behavior_learning_runs set slot=slot-interval '1 day' where status='failed'; alter table behavior_learning_runs enable trigger behavior_learning_run_transition");
      const rejected = await runScheduledBehaviorLearning(publisher!, { ...config, expectedRevision: 1 });
      assert.equal(rejected.status, "rejected");
      const view = await createBehaviorLifecycle(publisher!).inspect();
      assert.deepEqual(view.runs.map(row => row.status), ["rejected", "failed", "published"]);
      assert.equal(view.head.revision, 1);
    });
  } finally { await publisher?.end(); await db.stop(); }
});
