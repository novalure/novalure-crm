import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { test } from "node:test";
import type { AppSession } from "../src/lib/auth/session";
import { getRolePermissions } from "../src/lib/auth/permissions";
import { getProductRoleCapabilities } from "../src/lib/product-model";
import { createCsrfToken } from "../src/lib/security/csrf-core";
import { closeLocalTestPool } from "../src/lib/db/local-test-transport";
import type { TenantTransactionOptions } from "../src/lib/db/tenant-client";
import { createKnowledgeArea, createKnowledgeSource } from "../src/lib/knowledge-center/repository";
import { saveKnowledgeMonitoring } from "../src/lib/knowledge-center/monitoring";
import { applySalesSchema, startLocalSalesDb } from "./lib/local-sales-db.mjs";
import { seedSalesBrowser } from "./lib/sales-browser-fixture.mjs";

test("authenticated manual monitoring batches retain persisted actor scope and bounded real scanner policy", { timeout: 240_000 }, async t => {
  const db = await startLocalSalesDb();
  const envKeys = ["DATABASE_URL", "NODE_ENV", "CRM_LOCAL_TEST_DATABASE", "NOVALURE_SESSION_SECRET", "NOVALURE_APP_ORIGIN", "NOVALURE_AUTH_STRICT", "NOVALURE_AUTH_ENCRYPTION_KEY", "NOVALURE_AUTH_RATE_LIMIT_SECRET", "NOVALURE_DEMO_AUTH_ENABLED", "NOVALURE_TRUST_AUTH_HEADERS", "VERCEL", "VERCEL_ENV", "VERCEL_URL"];
  const previous = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
  try {
    await applySalesSchema(db);
    const owner = await seedSalesBrowser(db), foreign = await seedSalesBrowser(db);
    const secret = randomBytes(48).toString("base64url"), origin = "http://127.0.0.1:3000";
    for (const key of envKeys) delete process.env[key];
    Object.assign(process.env, { DATABASE_URL: `postgresql://${db.role}@127.0.0.1:${db.port}/postgres`, NODE_ENV: "test", CRM_LOCAL_TEST_DATABASE: "1", NOVALURE_SESSION_SECRET: secret,
      NOVALURE_APP_ORIGIN: origin, NOVALURE_AUTH_STRICT: "1", NOVALURE_AUTH_ENCRYPTION_KEY: randomBytes(40).toString("hex"), NOVALURE_AUTH_RATE_LIMIT_SECRET: randomBytes(40).toString("hex") });
    const cookie = "v2." + randomBytes(32).toString("base64url"), sessionId = randomUUID();
    await db.admin.query("insert into auth_sessions(id,token_hash,auth_identity_id,workspace_user_id,workspace_id,mfa_verified_at,expires_at) values($1,$2,$3,$4,$5,now(),now()+interval '1 hour')",
      [sessionId, createHash("sha256").update(cookie).digest("hex"), owner.authIdentityId, owner.userId, owner.workspaceId]);
    const { POST } = await import("../src/app/api/knowledge-center/monitoring/batch/route");
    const pathname = "/api/knowledge-center/monitoring/batch";
    function request(body: unknown = {}, suffix = "", headers: Record<string, string> = {}) {
      return new Request(origin + pathname + suffix, { method: "POST", headers: {
        cookie: "novalure_session=" + cookie, origin, "sec-fetch-site": "same-origin", "content-type": "application/json",
        "x-novalure-csrf-token": createCsrfToken({ method: "POST", pathname, secret, sessionCookie: cookie })!.token, ...headers,
      }, body: JSON.stringify(body) });
    }
    async function execute(expected: number, body: unknown = {}, suffix = "", headers: Record<string, string> = {}) {
      const response = await POST(request(body, suffix, headers));
      const json = await response.json();
      assert.equal(response.status, expected, JSON.stringify(json));
      assert.equal(response.headers.get("cache-control"), "private, no-store");
      return json;
    }
    const count = async () => Number((await db.admin.query("select count(*) from knowledge_website_scan_runs")).rows[0].count);

    await t.test("anonymous, identity headers, duplicate cookies and absent CSRF never start a batch", async () => {
      const anonymous = await POST(new Request(origin + pathname, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }));
      assert.equal(anonymous.status, 401);
      process.env.NOVALURE_TRUST_AUTH_HEADERS = "1";
      const headerIdentity = await POST(new Request(origin + pathname, { method: "POST", headers: { "content-type": "application/json", "x-novalure-workspace-id": owner.workspaceId,
        "x-novalure-user-id": owner.userId, "x-novalure-role": "owner", "x-novalure-product-role": "novalureAdmin" }, body: "{}" }));
      assert.equal(headerIdentity.status, 401);
      delete process.env.NOVALURE_TRUST_AUTH_HEADERS;
      await execute(401, {}, "", { cookie: `novalure_session=${cookie}; novalure_session=${cookie}` });
      await execute(403, {}, "", { "x-novalure-csrf-token": "" });
      assert.equal(await count(), 0);
    });

    await t.test("caller-selected actors, jobs, sources, unknown query fields and foreign workspace are rejected", async () => {
      for (const body of [{ actorId: foreign.userId }, { workspaceId: foreign.workspaceId }, { jobs: [] }, { sourceId: randomUUID() }, []]) await execute(400, body);
      await execute(400, {}, "?sourceId=" + randomUUID());
      await execute(400, {}, `?workspaceId=${owner.workspaceId}&workspaceId=${foreign.workspaceId}`);
      await execute(403, {}, "?workspaceId=" + foreign.workspaceId);
      assert.equal(await count(), 0);
    });

    await t.test("disabled entitlement is denied; enabling it through trusted setup does not create a timer", async () => {
      await execute(403);
      for (const workspaceId of [owner.workspaceId, foreign.workspaceId]) {
        await db.admin.query(`insert into knowledge_center_entitlements(workspace_id,enabled,max_sources,max_storage_bytes,max_queries_per_month,contract_reference,features,limits,monitoring_intervals)
          values($1,true,20,20000000,100,'SYNTHETIC-MANUAL-BATCH','{"websiteImport":true,"monitoring":true,"advancedMaintenance":true}',
          '{"maxAreas":20,"maxWebsites":20,"maxScansPerMonth":20,"maxUsers":20,"maxAssistants":20}',array['manual','daily'])`, [workspaceId]);
      }
      const result = await execute(200);
      assert.deepEqual(result, { eligibleJobs: 0, attemptedJobs: 0, results: [] });
      assert.equal(await count(), 0);
    });

    const actor = (fixture: typeof owner): AppSession => ({ authenticated: true, source: "database", userId: fixture.userId, workspaceId: fixture.workspaceId,
      workspaceName: "SYNTHETIC", name: "SYNTHETIC", email: fixture.email, role: "owner", productRole: "novalureAdmin",
      permissions: getRolePermissions("owner"), productPermissions: getProductRoleCapabilities("novalureAdmin") });
    const otherId = randomUUID();
    await db.admin.query("insert into workspace_users(id,workspace_id,name,email,role,product_role,status,onboarding_completed_at) values($1,$2,'SYNTHETIC separate batch actor',$3,'owner','novalureAdmin','active',now())",
      [otherId, owner.workspaceId, `synthetic-batch-${otherId}@example.invalid`]);
    const other = { ...actor(owner), userId: otherId };
    const options: TenantTransactionOptions = { pool: db.pool as unknown as NonNullable<TenantTransactionOptions["pool"]> };
    async function due(session: AppSession, label: string) {
      const area = await createKnowledgeArea(session, { name: "SYNTHETIC " + label, kind: "company" }, options);
      // The real scanner must reject this private address before any network IO.
      // The route has no injectable scan ports or DNS relaxation.
      const source = await createKnowledgeSource(session, { areaId: area.id, name: "SYNTHETIC " + label, type: "url", url: "https://127.0.0.1/denied", content: "SYNTHETIC unchanged private knowledge" }, options);
      await saveKnowledgeMonitoring(session, { sourceId: source.id, expectedVersion: source.revision, enabled: true, interval: "daily" }, options);
      return source.id;
    }
    const owned: string[] = [];
    for (let i = 0; i < 4; i++) owned.push(await due(actor(owner), "owner " + i));
    const otherSource = await due(other, "same tenant other actor"), foreignSource = await due(actor(foreign), "foreign tenant");

    await t.test("only three due jobs belonging to the authenticated actor run; SSRF remains enforced", async () => {
      const result = await execute(200);
      assert.equal(result.eligibleJobs, 4); assert.equal(result.attemptedJobs, 3); assert.equal(result.results.length, 3);
      for (const row of result.results) {
        assert.equal(row.workspaceId, owner.workspaceId); assert(owned.includes(row.sourceId));
        assert.equal(row.outcome, "blocked"); assert.equal(row.errorCode, "website_address_denied");
      }
      const runs = (await db.admin.query("select workspace_id,actor_id,source_id,status from knowledge_website_scan_runs")).rows;
      assert.equal(runs.length, 3);
      for (const row of runs) { assert.equal(row.workspace_id, owner.workspaceId); assert.equal(row.actor_id, owner.userId); assert.equal(row.status, "failed"); }
      assert(!runs.some(row => [otherSource, foreignSource].includes(row.source_id)));
      const remaining = await execute(200);
      assert.equal(remaining.eligibleJobs, 1); assert.equal(remaining.attemptedJobs, 1);
      assert.equal(await count(), 4);
    });

    await t.test("CSRF replay, permission changes and session revocation are rechecked on each manual invocation", async () => {
      const once = request(), replay = once.clone();
      assert.equal((await POST(once)).status, 200); assert.equal((await POST(replay)).status, 403);
      await db.admin.query("update workspace_users set role='assistant',product_role='viewer' where id=$1", [owner.userId]);
      await execute(403);
      await db.admin.query("update workspace_users set role='owner',product_role='novalureAdmin' where id=$1", [owner.userId]);
      await db.admin.query("update auth_sessions set revoked_at=now(),revoked_reason='logout' where id=$1", [sessionId]);
      await execute(401);
      assert.equal(await count(), 4);
    });
  } finally {
    await closeLocalTestPool();
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await db.stop();
  }
});
