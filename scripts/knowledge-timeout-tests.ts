import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { applySalesSchema, startLocalSalesDb } from "./lib/local-sales-db.mjs";
import { queryAuthenticationRows, withTenantTransaction, type TenantPool } from "../src/lib/db/tenant-client";

test("knowledge database budgets cancel slow work and clear on rollback/commit", { timeout: 90_000 }, async () => {
  const db = await startLocalSalesDb();
  try {
    await applySalesSchema(db, { maxMigrationNumber: 90 });
    const pool = db.pool as unknown as TenantPool;
    const scope = { workspaceId: randomUUID(), actorId: randomUUID() };
    const cancelled = (error: unknown) => (error as { code?: string }).code === "57014";
    await assert.rejects(withTenantTransaction(scope, tx => tx.query("select pg_sleep(1)"), { pool, statementTimeoutMs: 100 }), cancelled);
    await assert.rejects(queryAuthenticationRows("select pg_sleep(1)", [], { pool, statementTimeoutMs: 100 }), cancelled);
    await withTenantTransaction(scope, async tx => {
      const row = await tx.queryOne<{ budget: string; lock: string }>("select current_setting('statement_timeout') as budget,current_setting('lock_timeout') as lock");
      assert.deepEqual(row, { budget: "1500ms", lock: "1500ms" });
    }, { pool, statementTimeoutMs: 1500 });
    const settings = await db.pool.query("select current_setting('statement_timeout') as budget,current_setting('lock_timeout') as lock");
    assert.deepEqual(settings.rows[0], { budget: "0", lock: "0" });
    for (const statementTimeoutMs of [0, 99, 30001, Infinity, 100.5]) {
      await assert.rejects(withTenantTransaction(scope, async () => undefined, { pool, statementTimeoutMs }), /statement timeout/);
    }
  } finally { await db.stop(); }
});
