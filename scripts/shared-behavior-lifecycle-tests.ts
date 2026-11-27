import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import pg from "pg";
import { behaviorTargets } from "../src/lib/shared-behavior/catalog";
import { evaluateSelection } from "../src/lib/shared-behavior/evaluation";
import { createBehaviorLifecycle, runBehaviorLearningCycle } from "../src/lib/shared-behavior/lifecycle";
import { applySalesSchema, startLocalSalesDb } from "./lib/local-sales-db.mjs";
const first = { ruleIds: ["clarify-goal"], targets: [...behaviorTargets] } as const;
const second = { ruleIds: ["clarify-goal", "repair-understanding"], targets: [...behaviorTargets] } as const;
test("coverage scenarios detect additions, regressions, audience losses and no-ops", () => {
  assert.equal(evaluateSelection(first, null).checks, 30);
  assert.equal(evaluateSelection(first, null).improvements, 5);
  assert.equal(evaluateSelection(first, first).passed, false);
  assert.equal(evaluateSelection({ ruleIds: ["repair-understanding"], targets: [...behaviorTargets] }, first).regressions, 5);
  assert.equal(evaluateSelection({ ...second, targets: ["ceo"] }, first).passed, false);
  assert.throws(() => evaluateSelection({ ...first, transcript: "PRIVATE" }, null));
});
test("package2: durable bounded learning cycle on isolated PostgreSQL", { timeout: 240000 }, async t => {
  const db = await startLocalSalesDb();
  let publisher: pg.Pool | undefined;
  try {
    await applySalesSchema(db, { maxMigrationNumber: 90 });
    for (const name of ["shared_behavior_foundation.sql", "shared_behavior_package2.sql"]) {
      const c = await db.admin.connect();
      try { await c.query("begin"); await c.query(await readFile(`migrations/staged/${name}`, "utf8")); await c.query("commit"); }
      catch (e) { await c.query("rollback"); throw e; } finally { c.release(); }
    }
    const role = `behavior_test_${randomUUID().replaceAll("-", "")}`;
    await db.admin.query(`create role ${role} login nosuperuser nobypassrls nocreatedb nocreaterole noreplication`);
    await db.admin.query(`grant novalure_behavior_publisher to ${role}`);
    publisher = new pg.Pool({ host: "127.0.0.1", port: db.port, user: role, database: "postgres", max: 4 });
    const lifecycle = createBehaviorLifecycle(publisher);
    await t.test("tenant runtime and privileged administrator cannot become lifecycle publishers", async () => {
      await assert.rejects(createBehaviorLifecycle(db.pool).propose(first, 0), /UNSAFE_PUBLISHER_IDENTITY/);
      await assert.rejects(createBehaviorLifecycle(db.admin).propose(first, 0), /UNSAFE_PUBLISHER_IDENTITY/);
      await assert.rejects(publisher!.query("select * from behavior_learning_signals"));
      await assert.rejects(publisher!.query("select * from workspace_users"));
      for (const table of ["behavior_candidates", "behavior_evaluations", "behavior_publication_events"]) await assert.rejects(db.pool.query(`select * from ${table}`));
    });
    await t.test("unexamined candidates cannot publish; raw private fields cannot enter candidates", async () => {
      const p = await lifecycle.propose(first, 0);
      await assert.rejects(lifecycle.publish(p.candidateId, 0), /BEHAVIOR_EVALUATION_REQUIRED/);
      await assert.rejects(lifecycle.propose({ ...first, summary: "PRIVATE" }, 0));
      await assert.rejects(lifecycle.evaluate(randomUUID()), /CANDIDATE_NOT_FOUND/);
    });
    await t.test("automatic cycle persists candidate, checks, immutable release and event atomically", async () => {
      const cycle = await runBehaviorLearningCycle(publisher!, first, 0);
      assert.equal(cycle.status, "published");
      if (cycle.status !== "published") throw new Error("expected publication");
      assert.equal(cycle.version, 1); assert.equal(cycle.revision, 1);
      const checks = await publisher!.query("select * from behavior_evaluations where candidate_id=$1", [cycle.candidateId]);
      assert.equal(checks.rows[0].checks, 30);
      await assert.rejects(publisher!.query("update behavior_evaluations set passed=false"));
      await assert.rejects(publisher!.query("update behavior_candidates set baseline_revision=2"));
      await assert.rejects(publisher!.query("delete from behavior_publication_events"));
    });
    await t.test("regressions and no-ops persist as rejected candidates without changing head", async () => {
      assert.equal((await runBehaviorLearningCycle(publisher!, first, 1)).status, "rejected");
      assert.equal((await runBehaviorLearningCycle(publisher!, { ruleIds: ["repair-understanding"], targets: [...behaviorTargets] }, 1)).status, "rejected");
      assert.equal((await publisher!.query("select revision from behavior_release_head")).rows[0].revision, 1);
    });
    await t.test("two concurrently approved candidates yield one publication; stale proposals fail", async () => {
      const a = await lifecycle.propose(second, 1), b = await lifecycle.propose(second, 1);
      await lifecycle.evaluate(a.candidateId); await lifecycle.evaluate(b.candidateId);
      const results = await Promise.allSettled([lifecycle.publish(a.candidateId, 1), lifecycle.publish(b.candidateId, 1)]);
      assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
      assert.match(String((results.find(r => r.status === "rejected") as PromiseRejectedResult).reason), /STALE_BEHAVIOR_HEAD/);
      await assert.rejects(lifecycle.propose(second, 1), /STALE_BEHAVIOR_HEAD/);
      assert.equal((await publisher!.query("select count(*)::int as n from behavior_releases")).rows[0].n, 2);
    });
    await t.test("rollback preserves history, prevents ABA replay and can disable the first release", async () => {
      const pending = await lifecycle.propose({ ...second, ruleIds: [...second.ruleIds, "match-language"] }, 2);
      await lifecycle.evaluate(pending.candidateId);
      await assert.rejects(lifecycle.rollback(999, 2), /ROLLBACK_VERSION_NOT_PUBLISHED/);
      assert.deepEqual(await lifecycle.rollback(1, 2), { version: 1, revision: 3 });
      await assert.rejects(lifecycle.publish(pending.candidateId, 2), /STALE_BEHAVIOR_HEAD/);
      assert.deepEqual(await lifecycle.rollback(0, 3), { version: 0, revision: 4 });
      assert.equal((await publisher!.query("select version from behavior_release_head")).rows[0].version, null);
      assert.equal((await runBehaviorLearningCycle(publisher!, first, 4)).status, "published");
      assert.equal((await publisher!.query("select count(*)::int as n from behavior_publication_events")).rows[0].n, 5);
    });
    await t.test("forged evaluator bindings fail publication", async () => {
      const p = await lifecycle.propose(second, 5);
      await publisher!.query("insert into behavior_evaluations values($1,$2,$2,30,5,0,true)", [p.candidateId, "0".repeat(64)]);
      await assert.rejects(lifecycle.publish(p.candidateId, 5), /BEHAVIOR_EVALUATION_REQUIRED/);
    });
  } finally { await publisher?.end(); await db.stop(); }
});
