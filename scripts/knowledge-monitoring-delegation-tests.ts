import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { test } from "node:test";
import type { AppSession } from "../src/lib/auth/session";
import { getRequestSession } from "../src/lib/auth/session";
import { closeLocalTestPool } from "../src/lib/db/local-test-transport";
import type { TenantTransactionOptions } from "../src/lib/db/tenant-client";
import { createCsrfToken } from "../src/lib/security/csrf-core";
import { authorizeKnowledgeMonitoringCron, dispatchKnowledgeMonitoring, getKnowledgeMonitoringDispatcherReadiness,
  handleKnowledgeMonitoringCron, withKnowledgeMonitoringDelegation } from "../src/lib/knowledge-center/monitoring-delegation";
import { saveKnowledgeMonitoring } from "../src/lib/knowledge-center/monitoring";
import type { KnowledgeSource } from "../src/lib/knowledge-center/types";
import type { WebsiteScanPorts } from "../src/lib/knowledge-center/website-scanner";
import { applySalesSchema, startLocalSalesDb } from "./lib/local-sales-db.mjs";

const code = (expected: string) => (error: unknown) => (error as { code?: string }).code === expected;
const origin = "http://127.0.0.1:3000";
const cronSecret = "SYNTHETIC_LOCAL_CRON_SECRET_NO_REAL_ACCESS";
const cronRequest = (headers: Record<string, string> = {}, method = "GET", search = "") => new Request(origin + "/api/cron/knowledge-monitoring" + search,
  { method, headers: { authorization: "Bearer " + cronSecret, ...headers } });

test("daily monitoring host authority is server minted, explicit, bounded and paused fail closed", async () => {
  const env: NodeJS.ProcessEnv = { CRON_SECRET: cronSecret, NODE_ENV: "production" };
  for (const request of [cronRequest({ authorization: "Bearer wrong" }), cronRequest({}, "POST"), cronRequest({}, "GET", "?scope=other"),
    new Request(origin + "/api/cron/knowledge-monitoring", { headers: { cookie: "novalure_session=synthetic-not-host-authority" } })]) {
    assert.equal((await handleKnowledgeMonitoringCron(request, env)).status, 401);
  }
  assert.equal((await handleKnowledgeMonitoringCron(cronRequest(), { NODE_ENV: "test", NOVALURE_ALLOW_UNAUTHENTICATED_CRON_LOCAL: "1" })).status, 401);
  const unconfigured = await handleKnowledgeMonitoringCron(cronRequest(), env);
  assert.equal(unconfigured.status, 200);
  const absent = await unconfigured.json();
  assert.equal(absent.configured, 0);
  assert.equal(absent.attempted, 0);
  const scope = { workspaceId: randomUUID(), sourceId: randomUUID(), actorId: randomUUID() };
  assert.deepEqual(getKnowledgeMonitoringDispatcherReadiness(scope, env), { available: false, reason: "not_configured" });
  for (const scopes of ["not-json", JSON.stringify({ scope }), JSON.stringify([scope, scope]),
    JSON.stringify([{ ...scope, assistantId: randomUUID() }]), JSON.stringify(Array.from({ length: 4 }, () => ({ ...scope, sourceId: randomUUID() })))]) {
    const response = await handleKnowledgeMonitoringCron(cronRequest(), { ...env, NOVALURE_KNOWLEDGE_MONITORING_SCOPES: scopes });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).code, "MONITORING_SCOPE_INVALID");
  }
  const paused = await handleKnowledgeMonitoringCron(cronRequest(), { ...env, NOVALURE_WORKERS_PAUSED: "1", NOVALURE_KNOWLEDGE_MONITORING_SCOPES: JSON.stringify([scope]) });
  assert.deepEqual(await paused.json(), { ok: true, paused: true });
  const forged = { kind: "knowledge-monitoring-host" } as Parameters<typeof dispatchKnowledgeMonitoring>[0];
  await assert.rejects(dispatchKnowledgeMonitoring(forged), code("MONITORING_HOST_AUTHORITY_REQUIRED"));
  const mutableEnv = { ...env, NOVALURE_KNOWLEDGE_MONITORING_SCOPES: "[]", NOVALURE_WORKERS_PAUSED: "0" };
  const authorized = authorizeKnowledgeMonitoringCron(cronRequest(), mutableEnv)!;
  mutableEnv.NOVALURE_WORKERS_PAUSED = "1";
  await assert.rejects(dispatchKnowledgeMonitoring(authorized), code("MONITORING_PAUSED"));
});

test("persisted cookie-MFA grants constrain real PostgreSQL daily proposal dispatch and revocations", { timeout: 240_000 }, async t => {
  const db = await startLocalSalesDb();
  const keys = ["DATABASE_URL", "NODE_ENV", "CRM_LOCAL_TEST_DATABASE", "NOVALURE_SESSION_SECRET", "NOVALURE_APP_ORIGIN", "NOVALURE_AUTH_STRICT",
    "NOVALURE_AUTH_ENCRYPTION_KEY", "NOVALURE_AUTH_RATE_LIMIT_SECRET", "NOVALURE_DEMO_AUTH_ENABLED", "NOVALURE_TRUST_AUTH_HEADERS", "VERCEL", "VERCEL_ENV", "VERCEL_URL"];
  const original = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const sessionSecret = randomBytes(48).toString("base64url");
  let networkCalls = 0;
  try {
    await applySalesSchema(db, { maxMigrationNumber: 105 });
    for (const key of keys) delete process.env[key];
    Object.assign(process.env, { DATABASE_URL: `postgresql://${db.role}@127.0.0.1:${db.port}/postgres`, NODE_ENV: "test", CRM_LOCAL_TEST_DATABASE: "1",
      NOVALURE_SESSION_SECRET: sessionSecret, NOVALURE_APP_ORIGIN: origin, NOVALURE_AUTH_STRICT: "1",
      NOVALURE_AUTH_ENCRYPTION_KEY: randomBytes(40).toString("hex"), NOVALURE_AUTH_RATE_LIMIT_SECRET: randomBytes(40).toString("hex") });
    // Authentication bootstrap metadata only, matching the existing HTTP test
    // fixture. All monitoring writes use the real nonowner tenant runtime.
    await db.admin.query(`grant select on auth_identities to ${db.role}`);
    await db.admin.query(`grant update(last_seen_at) on auth_sessions to ${db.role}`);
    await db.admin.query(`grant select,insert,delete on csrf_token_consumptions to ${db.role}`);
    const options: TenantTransactionOptions = { pool: db.pool as unknown as NonNullable<TenantTransactionOptions["pool"]> };
    const repository = await import("../src/lib/knowledge-center/repository");
    const monitoringRoute = await import("../src/app/api/knowledge-center/monitoring/route");
    const selectedCase = process.env.KNOWLEDGE_MONITORING_DELEGATION_TEST_CASE;
    const subtest = (name: string, run: () => Promise<void>) => t.test(name, { skip: Boolean(selectedCase && !name.includes(selectedCase)) }, run);
    type Fixture = { workspaceId: string; actorId: string; identityId: string; sessionId: string; projectId: string; cookie: string; session: AppSession; source: KnowledgeSource };
    const request = (fixture: Pick<Fixture, "cookie">, pathname: string, method = "GET", body?: unknown) => new Request(origin + pathname, {
      method, headers: { cookie: "novalure_session=" + fixture.cookie, ...(body === undefined ? {} : { "content-type": "application/json", origin,
        "sec-fetch-site": "same-origin", "x-novalure-csrf-token": createCsrfToken({ method, pathname, secret: sessionSecret, sessionCookie: fixture.cookie })!.token }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const make = async (): Promise<Fixture> => {
      const workspaceId = randomUUID(), actorId = randomUUID(), projectId = randomUUID(), sessionId = randomUUID();
      const email = "synthetic-monitor-" + actorId + "@example.invalid";
      const cookie = "v2." + randomBytes(32).toString("base64url");
      await db.admin.query("insert into workspaces(id,name,operating_model) values($1,'SYNTHETIC monitoring delegation','self_service_customer')", [workspaceId]);
      const member = await db.admin.query("insert into workspace_users(id,workspace_id,name,email,role,product_role,status,onboarding_completed_at) values($1,$2,'SYNTHETIC scoped writer',$3,'agent','project_sales_member','active',now()) returning auth_identity_id", [actorId, workspaceId, email]);
      const identityId = member.rows[0].auth_identity_id as string;
      // Synthetic persisted MFA metadata proves database binding, not a live
      // login, TOTP exchange or possession of a real person's MFA secret.
      await db.admin.query("update auth_identities set credential_state='active',mfa_enabled_at=now(),mfa_secret_ciphertext='SYNTHETIC-FIXTURE-NOT-A-REAL-MFA-SECRET' where id=$1", [identityId]);
      await db.admin.query("insert into auth_sessions(id,token_hash,auth_identity_id,workspace_user_id,workspace_id,mfa_verified_at,expires_at) values($1,$2,$3,$4,$5,now(),now()+interval '1 hour')", [sessionId, createHash("sha256").update(cookie).digest("hex"), identityId, actorId, workspaceId]);
      await db.admin.query("insert into projects(id,workspace_id,name,type) values($1,$2,'SYNTHETIC monitoring project','Service')", [projectId, workspaceId]);
      await db.admin.query("insert into project_pipeline_permissions(workspace_id,project_id,user_id,can_read,can_edit_deals) values($1,$2,$3,true,true)", [workspaceId, projectId, actorId]);
      await db.admin.query(`insert into knowledge_center_entitlements(workspace_id,enabled,max_sources,max_storage_bytes,max_queries_per_month,contract_reference,features,limits,monitoring_intervals)
        values($1,true,20,20000000,100,'SYNTHETIC-DAILY-MONITORING','{"websiteImport":true,"monitoring":true,"advancedMaintenance":true}',
        '{"maxAreas":10,"maxWebsites":10,"maxScansPerMonth":20,"maxUsers":20,"maxAssistants":20}',array['manual','daily'])`, [workspaceId]);
      const session = await getRequestSession(request({ cookie }, "/api/knowledge-center"));
      assert.ok(session?.authenticated && session.source === "cookie");
      assert.equal(session.authIdentityId, identityId);
      assert.equal(session.authSessionId, sessionId);
      assert.ok(session.mfaVerifiedAt);
      const area = await repository.createKnowledgeArea(session, { name: "SYNTHETIC project website", kind: "project", projectId }, options);
      const source = await repository.createKnowledgeSource(session, { areaId: area.id, type: "url", name: "SYNTHETIC URL source",
        content: "Original synthetic delivery is Monday.", url: "https://example.com/help" }, options);
      return { workspaceId, actorId, identityId, sessionId, projectId, cookie, session, source };
    };
    const configure = async (fixture: Fixture, enabled = true) => {
      const response = await monitoringRoute.PUT(request(fixture, "/api/knowledge-center/monitoring", "PUT",
        { sourceId: fixture.source.id, expectedVersion: fixture.source.revision, interval: enabled ? "daily" : "manual", enabled }));
      assert.equal(response.status, 200, await response.clone().text());
      return (await response.json()).config as { revision: number };
    };
    const envFor = (fixture: Fixture): NodeJS.ProcessEnv => ({ CRON_SECRET: cronSecret, NODE_ENV: "production", NOVALURE_KNOWLEDGE_MONITORING_SCOPES: JSON.stringify([
      { workspaceId: fixture.workspaceId, sourceId: fixture.source.id, actorId: fixture.actorId }
    ]) });
    const ports = (before?: () => Promise<void>): WebsiteScanPorts => ({
      resolve: async () => [{ address: "93.184.216.34", family: 4 }],
      request: async () => { networkCalls++; await before?.(); return { status: 200, headers: { "content-type": "text/plain" },
        body: Buffer.from("Changed synthetic delivery is Friday. This external text is only an untrusted proposal.") }; }
    });
    const dispatch = async (fixture: Fixture, before?: () => Promise<void>) => {
      const response = await handleKnowledgeMonitoringCron(cronRequest(), envFor(fixture), { ...options, scanPorts: ports(before) });
      return { response, body: await response.json() as { ok: boolean; attempted: number; results: { outcome: string; errorCode?: string; sourceId: string }[] } };
    };
    const proposalCount = async (fixture: Fixture) => (await db.admin.query("select count(*)::int as count from knowledge_change_proposals where source_id=$1", [fixture.source.id])).rows[0].count;
    const assertSourceUntouched = async (fixture: Fixture) => {
      const source = (await db.admin.query("select kc_revision,draft_version_id,approved_version_id from knowledge_sources where id=$1", [fixture.source.id])).rows[0];
      assert.equal(source.kc_revision, fixture.source.revision);
      assert.equal(source.draft_version_id, fixture.source.draftVersionId);
      assert.equal(source.approved_version_id, null);
      assert.equal((await db.admin.query("select count(*)::int as count from knowledge_source_versions where source_id=$1", [fixture.source.id])).rows[0].count, 1);
      assert.equal((await db.admin.query("select count(*)::int as count from knowledge_publication_workflows where source_id=$1", [fixture.source.id])).rows[0].count, 0);
      assert.equal((await db.admin.query("select count(*)::int as count from knowledge_area_grants where area_id=$1", [fixture.source.areaId])).rows[0].count, 0);
    };

    await subtest("real HTTP cookie, CSRF and persisted MFA bind one durable daily grant; dispatch creates only one audited proposal and advances due time", async () => {
      const fixture = await make(), config = await configure(fixture);
      const audit = (await db.admin.query("select after from audit_logs where workspace_id=$1 and entity_id=$2 and action='knowledge.website.monitoring_configured' order by created_at desc limit 1", [fixture.workspaceId, fixture.source.id])).rows[0].after;
      assert.deepEqual(audit.monitoringDelegation, { version: 1, identityId: fixture.identityId, actorId: fixture.actorId, configRevision: config.revision, interval: "daily" });
      assert.doesNotMatch(JSON.stringify(audit), new RegExp(fixture.cookie));
      const result = await dispatch(fixture);
      assert.equal(result.response.status, 200, JSON.stringify(result.body));
      assert.equal(result.body.ok, true);
      assert.equal(result.body.results[0].outcome, "completed");
      assert.equal(await proposalCount(fixture), 1);
      await assertSourceUntouched(fixture);
      const state = (await db.admin.query("select next_due_at,clock_timestamp() as checked_at,last_run_status from knowledge_website_monitoring where source_id=$1", [fixture.source.id])).rows[0];
      const due = new Date(state.next_due_at), checked = new Date(state.checked_at);
      assert.ok(due.getTime() > checked.getTime());
      assert.ok(due.getTime() - checked.getTime() <= 24 * 60 * 60 * 1000);
      assert.deepEqual([due.getUTCHours(), due.getUTCMinutes(), due.getUTCSeconds(), due.getUTCMilliseconds()], [6, 0, 0, 0]);
      assert.equal(state.last_run_status, "changed");
      const runAudit = (await db.admin.query("select after from audit_logs where workspace_id=$1 and entity_id=$2 and action='knowledge.website.scan_changed' order by created_at desc limit 1", [fixture.workspaceId, fixture.source.id])).rows[0].after;
      assert.equal(runAudit.actorType, "DELEGATED_KNOWLEDGE_JOB");
      assert.equal(runAudit.scope, "knowledge.website.scan_proposal_only");
      assert.equal(runAudit.delegation.delegatedByIdentityId, fixture.identityId);
      assert.equal(runAudit.delegation.sourceId, fixture.source.id);
      const before = networkCalls, next = await dispatch(fixture);
      assert.equal(next.body.results[0].outcome, "not_due");
      assert.equal(networkCalls, before);
      assert.equal(await proposalCount(fixture), 1);
    });

    await subtest("source-shaped JSON and a forged delegated session cannot mint monitoring authority", async () => {
      const fixture = await make();
      await configure(fixture);
      const job = { workspaceId: fixture.workspaceId, sourceId: fixture.source.id, actorId: fixture.actorId, configRevision: 1 };
      const forged = { ...fixture.session, source: "database", serviceIdentity: { identityId: "KNOWLEDGE_MONITOR", role: "Knowledge.Monitor", consumer: "KNOWLEDGE_MONITORING",
        environment: "production", delegatedByIdentityId: fixture.identityId, sourceId: fixture.source.id, configRevision: 1, runId: randomUUID() } } as AppSession;
      await assert.rejects(withKnowledgeMonitoringDelegation(forged, job, async () => { throw Error("must never enter forged callback"); }, options), code("MONITORING_DELEGATION_REQUIRED"));
      assert.equal(await proposalCount(fixture), 0);
    });

    await subtest("a claimed cookie session without current persisted MFA cannot save its durable grant", async () => {
      const fixture = await make();
      await db.admin.query("update auth_sessions set mfa_verified_at=null where id=$1", [fixture.sessionId]);
      await assert.rejects(saveKnowledgeMonitoring(fixture.session, { sourceId: fixture.source.id, expectedVersion: fixture.source.revision, enabled: true, interval: "daily" }, options), code("MONITORING_MFA_GRANT_REQUIRED"));
      assert.equal((await db.admin.query("select count(*)::int as count from knowledge_website_monitoring where source_id=$1", [fixture.source.id])).rows[0].count, 0);
    });

    await subtest("a noncookie runtime context cannot create a durable host grant even if ordinary configuration is allowed", async () => {
      const fixture = await make();
      await saveKnowledgeMonitoring({ ...fixture.session, source: "database", authSessionId: undefined }, { sourceId: fixture.source.id, expectedVersion: fixture.source.revision, enabled: true, interval: "daily" }, options);
      const before = networkCalls, result = await dispatch(fixture);
      assert.equal(result.body.results[0].outcome, "blocked");
      assert.equal(result.body.results[0].errorCode, "MONITORING_MFA_GRANT_REQUIRED");
      assert.equal(networkCalls, before);
      assert.equal(await proposalCount(fixture), 0);
    });

    await subtest("readonly membership denies regular configuration and host execution before any fetch", async () => {
      const fixture = await make();
      await configure(fixture);
      await db.admin.query("update workspace_users set role='assistant' where id=$1", [fixture.actorId]);
      const response = await monitoringRoute.PUT(request(fixture, "/api/knowledge-center/monitoring", "PUT", { sourceId: fixture.source.id, expectedVersion: fixture.source.revision, interval: "daily", enabled: true }));
      assert.equal(response.status, 403);
      const before = networkCalls, result = await dispatch(fixture);
      assert.equal(result.body.results[0].errorCode, "MONITORING_ACTOR_REVOKED");
      assert.equal(networkCalls, before);
      assert.equal(await proposalCount(fixture), 0);
    });

    await subtest("monthly scan quota blocks reservation before external fetch", async () => {
      const fixture = await make();
      await configure(fixture);
      await db.admin.query(`update knowledge_center_entitlements set limits=limits||'{"maxScansPerMonth":0}'::jsonb where workspace_id=$1`, [fixture.workspaceId]);
      const before = networkCalls, result = await dispatch(fixture);
      assert.equal(result.response.status, 503);
      assert.equal(result.body.results[0].errorCode, "LIMIT_EXCEEDED");
      assert.equal(networkCalls, before);
      assert.equal(await proposalCount(fixture), 0);
      assert.equal((await db.admin.query("select count(*)::int as count from knowledge_website_scan_runs where source_id=$1", [fixture.source.id])).rows[0].count, 0);
    });

    const inflight = [
      { name: "identity disablement", revoke: (fixture: Fixture) => db.admin.query("update auth_identities set credential_state='disabled',disabled_at=now() where id=$1", [fixture.identityId]), codes: ["MONITORING_IDENTITY_REVOKED"] },
      { name: "configuration revocation", revoke: (fixture: Fixture) => configure(fixture, false), codes: ["MONITORING_CONFIG_CHANGED"] },
      { name: "project grant revocation", revoke: (fixture: Fixture) => db.admin.query("delete from project_pipeline_permissions where workspace_id=$1 and project_id=$2 and user_id=$3", [fixture.workspaceId, fixture.projectId, fixture.actorId]), codes: ["NOT_FOUND", "PROJECT_FORBIDDEN", "MONITORING_CONFIG_CHANGED"] },
      { name: "daily contract revocation", revoke: (fixture: Fixture) => db.admin.query("update knowledge_center_entitlements set monitoring_intervals=array['manual']::text[] where workspace_id=$1", [fixture.workspaceId]), codes: ["ENTITLEMENT_REQUIRED"] },
    ];
    for (const scenario of inflight) await subtest(scenario.name + " during external fetch prevents proposal or content commit", async () => {
      const fixture = await make();
      await configure(fixture);
      const before = networkCalls, result = await dispatch(fixture, async () => { await scenario.revoke(fixture); });
      assert.equal(networkCalls, before + 1);
      assert.equal(result.response.status, 503, JSON.stringify(result.body));
      assert.equal(result.body.results[0].outcome, "blocked");
      assert.ok(scenario.codes.includes(result.body.results[0].errorCode!), JSON.stringify(result.body));
      assert.equal(await proposalCount(fixture), 0);
      await assertSourceUntouched(fixture);
    });
  } finally {
    await closeLocalTestPool();
    for (const [key, value] of Object.entries(original)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await db.stop();
    await rm(db.directory, { recursive: true, force: true });
  }
});
