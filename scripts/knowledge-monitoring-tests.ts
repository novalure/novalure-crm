import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { AppSession } from "../src/lib/auth/session";
import { getRolePermissions } from "../src/lib/auth/permissions";
import { getProductRoleCapabilities } from "../src/lib/product-model";
import { withTenantTransaction, type TenantTransactionOptions } from "../src/lib/db/tenant-client";
import { closeLocalTestPool } from "../src/lib/db/local-test-transport";
import { allowedKnowledgeMonitoringIntervals, getKnowledgeMonitoring, listDueKnowledgeMonitoringJobs, runKnowledgeWebsiteScan, saveKnowledgeMonitoring } from "../src/lib/knowledge-center/monitoring";
import { runKnowledgeMonitoringBatch } from "../src/lib/knowledge-center/scheduler";
import type { KnowledgeEntitlement } from "../src/lib/knowledge-center/types";
import type { WebsiteScanPorts } from "../src/lib/knowledge-center/website-scanner";
import { applySalesSchema, startLocalSalesDb } from "./lib/local-sales-db.mjs";

const code = (expected: string) => (error: unknown) => (error as { code?: string }).code === expected;
const entitlement: KnowledgeEntitlement = { enabled: true, contractReference: "SYNTHETIC", maxSources: 10, maxStorageBytes: 10000000, maxQueriesPerMonth: 100, features: { websiteImport: true, monitoring: true, advancedMaintenance: false }, limits: { maxAreas: 10, maxWebsites: 10, maxScansPerMonth: 10, maxUsers: 10, maxAssistants: 10 } };

test("monitoring intervals fail closed without an explicit periodic entitlement", () => {
  assert.deepEqual(allowedKnowledgeMonitoringIntervals(entitlement), ["manual"]);
  assert.deepEqual(allowedKnowledgeMonitoringIntervals({ ...entitlement, allowedMonitoringIntervals: ["daily", "weekly", "monthly"] }), ["manual", "daily", "weekly", "monthly"]);
  assert.deepEqual(allowedKnowledgeMonitoringIntervals({ ...entitlement, features: { ...entitlement.features, monitoring: false }, allowedMonitoringIntervals: ["daily"] }), ["manual"]);
  assert.deepEqual(allowedKnowledgeMonitoringIntervals({ ...entitlement, features: { ...entitlement.features, websiteImport: false }, allowedMonitoringIntervals: ["daily"] }), []);
});

test("persisted website scan retries, stale leases, changes of authority and atomic events", { timeout: 240000 }, async t => {
  const db = await startLocalSalesDb();
  const keys = ["DATABASE_URL", "CRM_LOCAL_TEST_DATABASE", "NODE_ENV"];
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  try {
    await applySalesSchema(db, { maxMigrationNumber: 105 });
    Object.assign(process.env, { DATABASE_URL: `postgresql://${db.role}@127.0.0.1:${db.port}/postgres`, CRM_LOCAL_TEST_DATABASE: "1", NODE_ENV: "test" });
    const workspaceId = randomUUID(), ownerId = randomUUID();
    await db.admin.query("insert into workspaces(id,name) values($1,'SYNTHETIC monitoring')", [workspaceId]);
    await db.admin.query("insert into workspace_users(id,workspace_id,name,email,role,product_role) values($1,$2,'SYNTHETIC Owner','owner@example.invalid','owner','customer_owner')", [ownerId, workspaceId]);
    await db.admin.query(`insert into knowledge_center_entitlements(workspace_id,enabled,max_sources,max_storage_bytes,max_queries_per_month,contract_reference,features,limits,monitoring_intervals) values($1,true,20,20000000,100,'SYNTHETIC-MONITORING','{"websiteImport":true,"monitoring":true,"advancedMaintenance":true}','{"maxAreas":10,"maxWebsites":10,"maxScansPerMonth":20,"maxUsers":20,"maxAssistants":20}',array['manual','daily','weekly','monthly'])`, [workspaceId]);
    const owner: AppSession = { authenticated: true, userId: ownerId, workspaceId, workspaceName: "SYNTHETIC", name: "Owner", email: "owner@example.invalid", role: "owner", permissions: getRolePermissions("owner"), productRole: "customer_owner", productPermissions: getProductRoleCapabilities("customer_owner"), source: "database" };
    const options: TenantTransactionOptions = { pool: db.pool as unknown as NonNullable<TenantTransactionOptions["pool"]> };
    const repository = await import("../src/lib/knowledge-center/repository");
    const area = await repository.createKnowledgeArea(owner, { name: "SYNTHETIC Websites", kind: "company" }, options);
    const makeSource = () => repository.createKnowledgeSource(owner, { areaId: area.id, type: "url", name: "SYNTHETIC Website", content: "Original approved delivery Monday", url: "https://example.com/help" }, options);
    let calls = 0;
    const ports = (content: string, before?: () => Promise<void>): WebsiteScanPorts => ({
      resolve: async () => [{ address: "93.184.216.34", family: 4 }],
      request: async () => { calls++; await before?.(); return { status: 200, headers: { "content-type": "text/plain" }, body: Buffer.from(content) }; },
    });
    const usage = async () => (await db.admin.query("select scan_count from knowledge_query_usage where workspace_id=$1", [workspaceId])).rows[0]?.scan_count ?? 0;
    const adjustRun = (runId: string, sql: string) => withTenantTransaction({ actorId: ownerId, workspaceId }, tx => tx.execute(`update knowledge_website_scan_runs set ${sql} where id=$1::uuid and workspace_id=$2::uuid`, [runId, workspaceId]), options);

    await t.test("one persisted retry budget reserves usage once and creates one final proposal", async () => {
      const source = await makeSource();
      const failedPorts: WebsiteScanPorts = { resolve: ports("").resolve, request: async () => { calls++; throw new Error("SYNTHETIC provider error must not leak"); } };
      const beforeUsage = await usage();
      await assert.rejects(runKnowledgeWebsiteScan(owner, { sourceId: source.id, expectedVersion: source.revision }, { ...options, scanPorts: failedPorts }), code("website_fetch_failed"));
      let snapshot = await getKnowledgeMonitoring(owner, { sourceId: source.id }, options);
      const runId = snapshot.history[0].id;
      assert.equal(snapshot.history[0].status, "retry_wait");
      assert.equal(snapshot.history[0].attempts, 1);
      const busy = await runKnowledgeWebsiteScan(owner, { sourceId: source.id, expectedVersion: source.revision }, { ...options, scanPorts: ports("Changed delivery Friday") });
      assert.equal(busy.busy, true);
      await adjustRun(runId, "next_attempt_at=clock_timestamp()-interval '1 second'");
      await assert.rejects(runKnowledgeWebsiteScan(owner, { sourceId: source.id, expectedVersion: source.revision }, { ...options, scanPorts: failedPorts }), code("website_fetch_failed"));
      await adjustRun(runId, "next_attempt_at=clock_timestamp()-interval '1 second'");
      const result = await runKnowledgeWebsiteScan(owner, { sourceId: source.id, expectedVersion: source.revision }, { ...options, scanPorts: ports("Changed delivery Friday") });
      assert.equal(result.run.id, runId);
      assert.equal(result.run.status, "changed");
      assert.equal(result.run.attempts, 3);
      assert.equal(await usage(), beforeUsage + 1);
      assert.equal((await repository.loadKnowledgeCenter(owner, options)).sources.find(row => row.id === source.id)?.revision, source.revision);
      assert.equal((await db.admin.query("select count(*)::int as count from knowledge_source_versions where source_id=$1", [source.id])).rows[0].count, 1);
      snapshot = await getKnowledgeMonitoring(owner, { sourceId: source.id }, options);
      assert.equal(snapshot.history.length, 1);
      const events = (await db.admin.query("select event_type,details from knowledge_workflow_events where source_id=$1", [source.id])).rows;
      assert.equal(events.filter(row => row.event_type === "knowledge.website.scan_failed").length, 2);
      assert.equal(events.filter(row => row.event_type === "knowledge.proposal.created").length, 1);
      assert.equal(JSON.stringify(events).includes("provider error"), false);
    });

    await t.test("three failed attempts terminate a scheduled run without extra reservations", async () => {
      const source = await makeSource();
      await saveKnowledgeMonitoring(owner, { sourceId: source.id, expectedVersion: source.revision, enabled: true, interval: "monthly" }, options);
      const jobs = (await listDueKnowledgeMonitoringJobs(owner, options)).filter(job => job.sourceId === source.id), beforeUsage = await usage();
      const failedPorts: WebsiteScanPorts = { resolve: ports("").resolve, request: async () => { calls++; throw new Error("SYNTHETIC unavailable"); } };
      for (let attempt = 1; attempt <= 3; attempt++) {
        const results = await runKnowledgeMonitoringBatch(jobs, { rehydrateActor: async () => owner }, { ...options, scanPorts: failedPorts });
        assert.equal(results[0].errorCode, "website_fetch_failed");
        const history = (await getKnowledgeMonitoring(owner, { sourceId: source.id }, options)).history;
        assert.equal(history.length, 1);
        assert.equal(history[0].attempts, attempt);
        assert.equal(history[0].status, attempt === 3 ? "failed" : "retry_wait");
        if (attempt < 3) await adjustRun(history[0].id, "next_attempt_at=clock_timestamp()-interval '1 second'");
      }
      assert.equal(await usage(), beforeUsage + 1);
      assert.equal((await listDueKnowledgeMonitoringJobs(owner, options)).some(job => job.sourceId === source.id), false);
      const beforeCalls = calls;
      const staleJob = await runKnowledgeMonitoringBatch(jobs, { rehydrateActor: async () => owner }, { ...options, scanPorts: ports("Unexpected") });
      assert.equal(staleJob[0].errorCode, "MONITORING_NOT_DUE");
      assert.equal(calls, beforeCalls);
    });

    await t.test("source revision changing during external fetch discards the response", async () => {
      const source = await makeSource();
      const result = await runKnowledgeWebsiteScan(owner, { sourceId: source.id, expectedVersion: source.revision }, { ...options, scanPorts: ports("Untrusted stale fetched content", async () => { await repository.updateKnowledgeSource(owner, { sourceId: source.id, expectedVersion: source.revision, content: "Current human draft" }, options); }) });
      assert.equal(result.run.status, "stale");
      assert.equal((await db.admin.query("select count(*)::int as count from knowledge_change_proposals where source_id=$1", [source.id])).rows[0].count, 0);
      assert.equal((await repository.loadKnowledgeCenter(owner, options)).sources.find(row => row.id === source.id)?.version?.content, "Current human draft");
    });

    await t.test("module revocation during fetch blocks commit and leaves no proposal", async () => {
      const source = await makeSource();
      await assert.rejects(runKnowledgeWebsiteScan(owner, { sourceId: source.id, expectedVersion: source.revision }, { ...options, scanPorts: ports("Revoked content", async () => { await db.admin.query("insert into workspace_module_settings(workspace_id,module_key,enabled) values($1,'knowledge',false) on conflict(workspace_id,module_key) do update set enabled=false", [workspaceId]); }) }), code("ENTITLEMENT_REQUIRED"));
      await db.admin.query("update workspace_module_settings set enabled=true where workspace_id=$1 and module_key='knowledge'", [workspaceId]);
      const snapshot = await getKnowledgeMonitoring(owner, { sourceId: source.id }, options);
      assert.equal(snapshot.history[0].status, "blocked");
      assert.equal(snapshot.history[0].errorCode, "ENTITLEMENT_REQUIRED");
      assert.equal((await db.admin.query("select count(*)::int as count from knowledge_change_proposals where source_id=$1", [source.id])).rows[0].count, 0);
    });

    await t.test("a configuration changed during scheduled fetch invalidates its lease result", async () => {
      const source = await makeSource();
      await saveKnowledgeMonitoring(owner, { sourceId: source.id, expectedVersion: source.revision, enabled: true, interval: "daily" }, options);
      const jobs = (await listDueKnowledgeMonitoringJobs(owner, options)).filter(job => job.sourceId === source.id);
      assert.equal(jobs.length, 1);
      const results = await runKnowledgeMonitoringBatch(jobs, { rehydrateActor: async () => owner }, { ...options, scanPorts: ports("Canceled scheduler content", async () => { await saveKnowledgeMonitoring(owner, { sourceId: source.id, expectedVersion: source.revision, enabled: false, interval: "manual" }, options); }) });
      assert.equal(results[0].outcome, "blocked");
      assert.equal(results[0].errorCode, "MONITORING_CONFIG_CHANGED");
      assert.equal((await getKnowledgeMonitoring(owner, { sourceId: source.id }, options)).history[0].status, "blocked");
      assert.equal((await db.admin.query("select count(*)::int as count from knowledge_change_proposals where source_id=$1", [source.id])).rows[0].count, 0);
    });

    await t.test("scheduler rejects substituted actor scope and performs no network request", async () => {
      const source = await makeSource();
      await saveKnowledgeMonitoring(owner, { sourceId: source.id, expectedVersion: source.revision, enabled: true, interval: "weekly" }, options);
      const jobs = (await listDueKnowledgeMonitoringJobs(owner, options)).filter(job => job.sourceId === source.id), beforeCalls = calls;
      const result = await runKnowledgeMonitoringBatch(jobs, { rehydrateActor: async () => ({ ...owner, userId: randomUUID() }) }, { ...options, scanPorts: ports("Unexpected") });
      assert.equal(result[0].errorCode, "MONITORING_ACTOR_UNAVAILABLE");
      assert.equal(calls, beforeCalls);
    });
  } finally {
    await closeLocalTestPool();
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await db.stop();
  }
});
