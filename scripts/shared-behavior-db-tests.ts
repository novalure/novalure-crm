import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import type { AppSession } from "../src/lib/auth/session";
import { getRolePermissions } from "../src/lib/auth/permissions";
import { getProductRoleCapabilities } from "../src/lib/product-model";
import { withTenantTransaction, type TenantTransactionOptions } from "../src/lib/db/tenant-client";
import { loadSharedBehavior, recordPrivateLearningSignal, suggestPrivateBehaviorImprovements } from "../src/lib/shared-behavior/repository";
import { applySalesSchema, startLocalSalesDb } from "./lib/local-sales-db.mjs";

test("shared behavior: actual PostgreSQL privacy, persistence and publication boundaries", { timeout: 240_000 }, async t => {
  const db = await startLocalSalesDb();
  const options: TenantTransactionOptions = { pool: db.pool as unknown as NonNullable<TenantTransactionOptions["pool"]> };
  const a = randomUUID(), b = randomUUID();
  const userA = randomUUID(), userB = randomUUID(), department = randomUUID();
  function session(workspaceId = a, userId = userA): AppSession {
    return { authenticated: true, source: "database", workspaceId, userId, workspaceName: "SYNTHETIC", name: "SYNTHETIC", email: "synthetic@example.invalid", role: "owner", productRole: "customer_owner", permissions: getRolePermissions("owner"), productPermissions: getProductRoleCapabilities("customer_owner") };
  }
  const scoped = <T>(callback: Parameters<typeof withTenantTransaction<T>>[1]) => withTenantTransaction({ workspaceId: a, actorId: userA }, callback, options);
  try {
    // Reuse the existing historical <=090 fixture. Its documented optional vector
    // substitution and manual-cutover exclusions are not production evidence.
    await applySalesSchema(db, { maxMigrationNumber: 90 });
    const client = await db.admin.connect();
    try {
      await client.query("begin");
      await client.query(await readFile("migrations/staged/shared_behavior_foundation.sql", "utf8"));
      await client.query("commit");
    } catch (error) { await client.query("rollback"); throw error; } finally { client.release(); }
    await db.admin.query("insert into workspaces(id,name,operating_model) values($1,'SYNTHETIC A','managed_by_novalure'),($2,'SYNTHETIC B','managed_by_novalure')", [a, b]);
    for (const [workspace, user] of [[a, userA], [a, department], [b, userB]]) {
      await db.admin.query("insert into workspace_users(id,workspace_id,name,email,role,product_role) values($1,$2,'SYNTHETIC',$3,'owner','customer_owner')", [user, workspace, `${user}@example.invalid`]);
    }
    await t.test("signals persist, retries deduplicate and conflicting retries fail", async () => {
      const event = { eventId: randomUUID(), issue: "unclear_goal", outcome: "fail" };
      assert.deepEqual(await recordPrivateLearningSignal(session(), event, options), { recorded: true, replayed: false });
      assert.deepEqual(await recordPrivateLearningSignal(session(), event, options), { recorded: true, replayed: true });
      await assert.rejects(recordPrivateLearningSignal(session(), { ...event, outcome: "pass" }, options), /LEARNING_IDEMPOTENCY_CONFLICT/);
      assert.equal((await scoped(tx => tx.query("select * from behavior_learning_signals"))).length, 1);
    });
    await t.test("unknown fields and free-text signals are denied before storage", async () => {
      const event = { eventId: randomUUID(), issue: "unclear_goal", outcome: "fail" };
      await assert.rejects(recordPrivateLearningSignal(session(), { ...event, content: "SYNTHETIC PRIVATE CONTRACT" }, options));
      await assert.rejects(recordPrivateLearningSignal(session(), { ...event, issue: "SYNTHETIC PRIVATE CONTRACT" }, options));
    });
    await t.test("database RLS prevents reading foreign tenant and same-tenant department signals", async () => {
      await recordPrivateLearningSignal(session(b, userB), { eventId: randomUUID(), issue: "language_mismatch", outcome: "fail" }, options);
      await recordPrivateLearningSignal(session(a, department), { eventId: randomUUID(), issue: "handoff_confusion", outcome: "fail" }, options);
      const rows = await scoped(tx => tx.query<{ actor_id: string; workspace_id: string }>("select actor_id,workspace_id from behavior_learning_signals"));
      assert.ok(rows.length > 0 && rows.every(row => row.actor_id === userA && row.workspace_id === a));
      assert.deepEqual(await suggestPrivateBehaviorImprovements(session(b, userB), options), []);
    });
    await t.test("database rejects forged workspace or actor bindings", async () => {
      for (const [workspace, actor] of [[b, userB], [a, department]]) {
        await assert.rejects(scoped(tx => tx.execute("insert into behavior_learning_signals(workspace_id,actor_id,event_id,issue,outcome) values($1,$2,$3,'unclear_goal','fail')", [workspace, actor, randomUUID()])), (e: unknown) => (e as { code: string }).code === "42501");
      }
    });
    await t.test("private evidence suggests only a fixed ID; no automatic publication", async () => {
      for (let i = 0; i < 2; i++) await recordPrivateLearningSignal(session(), { eventId: randomUUID(), issue: "unclear_goal", outcome: "fail" }, options);
      assert.deepEqual(await suggestPrivateBehaviorImprovements(session(), options), ["clarify-goal"]);
      assert.equal((await loadSharedBehavior(session(), "ceo", options)).version, 0);
    });
    await t.test("tenant runtime cannot publish behavior or alter/delete private evidence", async () => {
      for (const query of ["insert into behavior_releases values(1,array['clarify-goal'],array['ceo'])", "insert into behavior_release_head values(true,1,1)", "delete from behavior_learning_signals", "update behavior_learning_signals set issue='language_mismatch'"]) {
        await assert.rejects(scoped(tx => tx.execute(query)), (e: unknown) => (e as { code: string }).code === "42501");
      }
    });
    await t.test("schema rejects free-text rules, unknown targets and null array elements", async () => {
      for (const [rules, targets] of [[["SYNTHETIC PRIVATE"], ["ceo"]], [["clarify-goal"], ["PRIVATE"]], [[null], ["ceo"]], [["clarify-goal"], [null]], [["clarify-goal", "clarify-goal"], ["ceo"]]]) {
        await assert.rejects(db.admin.query("insert into behavior_releases(version,rule_ids,targets) values(1,$1,$2)", [rules, targets]));
      }
    });
    await t.test("unpublished releases are invisible; authorized head makes fixed rules shared", async () => {
      await db.admin.query("insert into behavior_releases values(1,array['clarify-goal'],array['ceo','department','webchat','agent','telephony'])");
      assert.equal((await scoped(tx => tx.query("select * from behavior_releases"))).length, 0);
      await db.admin.query("insert into behavior_release_head values(true,1,1)");
      await assert.rejects(db.admin.query("update behavior_releases set rule_ids=array['repair-understanding'] where version=1"));
      await assert.rejects(db.admin.query("delete from behavior_releases where version=1"));
      for (const target of ["ceo", "department", "webchat", "agent", "telephony"]) {
        const result = await loadSharedBehavior(session(), target, options);
        assert.equal(result.version, 1);
        assert.match(result.instruction, /one focused question/);
        assert.doesNotMatch(result.instruction, new RegExp([a, b, userA, userB, department].join("|")));
        assert.equal(result.instruction, (await loadSharedBehavior(session(b, userB), target, options)).instruction);
      }
    });
    await t.test("rollback changes selection without changing private evidence", async () => {
      await db.admin.query("insert into behavior_releases values(2,array['repair-understanding'],array['ceo'])");
      await db.admin.query("update behavior_release_head set version=2,revision=revision+1");
      assert.match((await loadSharedBehavior(session(), "ceo", options)).instruction, /When corrected/);
      assert.doesNotMatch((await loadSharedBehavior(session(), "webchat", options)).instruction, /When corrected/);
      await db.admin.query("update behavior_release_head set version=1,revision=revision+1");
      assert.equal((await loadSharedBehavior(session(), "ceo", options)).version, 1);
      assert.deepEqual(await suggestPrivateBehaviorImprovements(session(), options), ["clarify-goal"]);
    });
    await t.test("membership revocation blocks private evidence and shared access", async () => {
      await db.admin.query("update workspace_users set status='invited' where id=$1", [userA]);
      await assert.rejects(loadSharedBehavior(session(), "ceo", options));
      await assert.rejects(suggestPrivateBehaviorImprovements(session(), options));
      assert.equal((await scoped(tx => tx.query("select * from behavior_learning_signals"))).length, 0);
      assert.equal((await scoped(tx => tx.query("select * from behavior_release_head"))).length, 0);
    });
  } finally { await db.stop(); }
});
