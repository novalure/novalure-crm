import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import type { AppSession } from "../src/lib/auth/session";
import { getRolePermissions } from "../src/lib/auth/permissions";
import { getProductRoleCapabilities } from "../src/lib/product-model";
import { crmPayloadDigest, withCrmRead } from "../src/lib/crm-command";
import type { TenantPool } from "../src/lib/db/tenant-client";
import { emptyPropertyCreationDraft } from "../src/lib/property-create-draft";
import { savePropertyCreationDraft } from "../src/lib/db/property-create-draft-repository";
import { provisionCustomerWorkspace } from "../src/lib/customer-workspace-provisioning";
import { parseQaLegacyInput, runQaLegacyProvenance, type QaLegacyPlan } from "../src/lib/qa-legacy-provenance";
import { createCsrfToken } from "../src/lib/security/csrf-core";
import { closeLocalTestPool } from "../src/lib/db/local-test-transport";
import { POST } from "../src/app/api/admin/qa-legacy-provenance/route";
import { applySalesSchema, startLocalSalesDb } from "./lib/local-sales-db.mjs";

const metadata = () => ({ idempotencyKey: randomUUID(), correlationId: randomUUID() });
const code = (...codes: string[]) => (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && codes.includes(String(error.code)));
test("legacy protocol admits provenance only and rejects supplied authority or classification", () => {
  const input = { mode: "plan", sourceReceiptId: randomUUID(), targetAuditId: randomUUID(), ownDraftId: randomUUID() };
  assert.equal(parseQaLegacyInput(input).mode, "plan");
  for (const extra of [{ workspaceId: randomUUID() }, { actorId: randomUUID() }, { role: "admin" }, { isQa: true }, { adopt: true }, { retireWorkspace: true }, { cleanup: true }]) assert.throws(() => parseQaLegacyInput({ ...input, ...extra }));
  assert.throws(() => parseQaLegacyInput({ ...input, mode: "execute" }));
});

test("legacy double-provenance evidence never classifies or retires a tenant", { timeout: 240_000 }, async t => {
  const db = await startLocalSalesDb();
  const options = { pool: db.pool as unknown as TenantPool };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("Provider egress is forbidden in this fixture"); };
  const envKeys = ["DATABASE_URL", "NODE_ENV", "CRM_LOCAL_TEST_DATABASE", "NOVALURE_SESSION_SECRET", "NOVALURE_APP_ORIGIN", "NOVALURE_AUTH_STRICT", "NOVALURE_AUTH_ENCRYPTION_KEY", "NOVALURE_AUTH_RATE_LIMIT_SECRET"];
  const envBefore = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
  const internalWorkspace = randomUUID();
  const cookie = "v2." + randomBytes(32).toString("base64url");
  async function operator(): Promise<AppSession> {
    const userId = randomUUID(), sessionId = randomUUID();
    const email = `synthetic-${userId}@example.invalid`;
    const identity = (await db.admin.query("insert into workspace_users(id,workspace_id,name,email,role,product_role,status) values($1,$2,'SYNTHETIC origin admin',$3,'admin','novalureAdmin','active') returning auth_identity_id", [userId, internalWorkspace, email])).rows[0].auth_identity_id;
    await db.admin.query("update auth_identities set credential_state='active',mfa_enabled_at=now(),mfa_secret_ciphertext='SYNTHETIC_NOT_REAL' where id=$1", [identity]);
    await db.admin.query("insert into auth_sessions(id,token_hash,auth_identity_id,workspace_user_id,workspace_id,mfa_verified_at,expires_at) values($1,$2,$3,$4,$5,now(),now()+interval '1 hour')", [sessionId, createHash("sha256").update(cookie + userId).digest("hex"), identity, userId, internalWorkspace]);
    return { authenticated: true, source: "database", workspaceId: internalWorkspace, userId, workspaceName: "SYNTHETIC origin", name: "SYNTHETIC admin", email, role: "admin", productRole: "novalureAdmin", permissions: getRolePermissions("admin"), productPermissions: getProductRoleCapabilities("novalureAdmin"), authSessionId: sessionId, authIdentityId: identity, mfaVerifiedAt: new Date().toISOString() };
  }
  try {
    // Actual 114/173/195 on the unchanged historical loopback bootstrap. This
    // intentionally is not the complete restored production migration chain.
    await applySalesSchema(db, { maxMigrationNumber: 110 });
    for (const file of ["114_customer_workspace_provisioning.sql", "173_property_creation_drafts.sql", "195_qa_legacy_provenance_snapshot.sql"]) {
      const client = await db.admin.connect();
      try { await client.query("begin"); await client.query(await readFile("migrations/" + file, "utf8")); await client.query("commit"); }
      catch (error) { await client.query("rollback"); throw error; }
      finally { client.release(); }
    }
    await db.admin.query("insert into workspaces(id,name,operating_model,customer_type) values($1,'SYNTHETIC origin','novalure_internal','novalure_internal')", [internalWorkspace]);
    const origin = await operator(), otherOrigin = await operator();
    async function target() {
      const requestId = randomUUID();
      const created = await provisionCustomerWorkspace(origin, { name: "SYNTHETIC original customer", projectName: "SYNTHETIC original project", botName: "SYNTHETIC original bot", websiteUrl: "https://synthetic-legacy.example/", customerType: "general_company", requestId }, options);
      const member = (await db.admin.query("select id from workspace_users where workspace_id=$1", [created.workspace.id])).rows[0].id;
      const session: AppSession = { ...origin, workspaceId: created.workspace.id, userId: member, role: "admin", productRole: "workspace_admin", permissions: getRolePermissions("admin"), productPermissions: getProductRoleCapabilities("workspace_admin") };
      const ownDraftId = randomUUID();
      await withCrmRead(session, (tx, fresh) => savePropertyCreationDraft(tx, fresh, { id: ownDraftId, draft: { ...emptyPropertyCreationDraft(), projectId: created.project.id, title: "PRIVATE_SYNTHETIC_DRAFT_MUST_NOT_LEAK" }, step: 0, expectedRevision: 0, requestId: randomUUID() }), options);
      const sourceReceiptId = (await db.admin.query("select id from crm_command_receipts where workspace_id=$1 and idempotency_key=$2", [origin.workspaceId, requestId])).rows[0].id;
      const targetAuditId = (await db.admin.query("select id from audit_logs where workspace_id=$1 and action='customer.workspace.provisioned'", [created.workspace.id])).rows[0].id;
      return { created, session, ownDraftId, selectors: { sourceReceiptId, targetAuditId, ownDraftId } };
    }
    const a = await target(), b = await target();
    type Response = { outcome: string; planId: string; plan: QaLegacyPlan };
    const plan = async (selectors = a.selectors, actor = origin) => (await runQaLegacyProvenance(actor, { mode: "plan", ...selectors }, metadata(), options)).data as unknown as Response;
    const input = (p: Response, selectors = a.selectors) => ({ mode: "register_provenance", ...selectors, planId: p.planId, expectedPlanDigest: p.plan.digest, expectedCounts: p.plan.counts, expectedTargets: p.plan.targets, confirmation: `REGISTER PROVENANCE ONLY ${p.plan.snapshot.targetIds.workspace} ${p.plan.digest}` });
    const business = async () => {
      const rows: Record<string, unknown> = {};
      for (const table of ["workspaces", "workspace_users", "auth_identities", "projects", "bots", "knowledge_areas", "crm_property_creation_drafts", "workspace_module_settings", "qa_batches", "qa_batch_objects", "qa_reset_audit_events"]) rows[table] = (await db.admin.query(`select encode(sha256(convert_to(coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),'[]'::jsonb)::text,'UTF8')),'hex') as digest from ${table} t`)).rows[0].digest;
      return rows;
    };
    await t.test("real receipt and both audits bind exact IDs; evidence is durable and all eight groups stay limited", async () => {
      const before = await business(), p = await plan();
      assert.equal(p.outcome, "provenance_plan");
      assert.equal(p.plan.snapshot.targetIds.workspace, a.created.workspace.id);
      assert.equal(p.plan.snapshot.targetIds.membership, a.session.userId);
      assert.equal(p.plan.snapshot.completeVisibility, false);
      assert.ok(p.plan.snapshot.unprovenRelations.some(row => row.relation === "public.crm_property_creation_drafts"));
      assert.equal(JSON.stringify(p).includes("PRIVATE_SYNTHETIC_DRAFT_MUST_NOT_LEAK"), false);
      const request = input(p), key = metadata();
      const result = await runQaLegacyProvenance(origin, request, key, options);
      assert.equal(result.data.outcome, "provenance_registered");
      for (const field of ["classificationAllowed", "qaFlagChanged", "qaBatchCreated", "cleanupAllowed", "businessMutations", "accountsAndRightsChanged", "calendarsChanged"]) assert.equal((result.data as unknown as Record<string, unknown>)[field], false);
      assert.equal(Object.keys(result.data.groups).length, 8);
      const file = path.join(db.directory, "synthetic-legacy-replay.json");
      await writeFile(file, JSON.stringify({ marker: "SYNTHETIC_QA_LEGACY_REPLAY", port: db.port, role: db.role, session: origin, request, metadata: key }));
      const env = Object.fromEntries(["PATH", "Path", "SystemRoot", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "USERPROFILE", "LOCALAPPDATA", "APPDATA"].flatMap(name => process.env[name] === undefined ? [] : [[name, process.env[name] as string]]));
      const replay = JSON.parse(execFileSync(process.execPath, ["--conditions=react-server", "--import", "tsx", "scripts/lib/qa-legacy-replay-worker.ts", file], { cwd: process.cwd(), env: { ...env, NODE_ENV: "test" }, windowsHide: true, timeout: 45_000, encoding: "utf8" }));
      assert.equal(replay.replayed, true); assert.equal(replay.commandId, result.commandId);
      assert.deepEqual(await business(), before);
      assert.equal((await db.admin.query("select count(*)::int as n from crm_command_receipts where workspace_id=$1 and operation='qa.legacy.provenance.register'", [origin.workspaceId])).rows[0].n, 1);
      const receiptWorkspace = (await db.admin.query("select workspace_id from crm_command_receipts where id=$1", [result.commandId])).rows[0].workspace_id;
      assert.equal(receiptWorkspace, origin.workspaceId);
    });
    await t.test("mixed tenant/audit/draft references, another origin admin and target-only session are denied", async () => {
      const before = await business();
      for (const selectors of [{ ...a.selectors, targetAuditId: b.selectors.targetAuditId }, { ...a.selectors, ownDraftId: b.ownDraftId }, { ...a.selectors, sourceReceiptId: b.selectors.sourceReceiptId }]) await assert.rejects(plan(selectors), code("42501"));
      await assert.rejects(plan(a.selectors, otherOrigin), code("42501"));
      await assert.rejects(plan(a.selectors, a.session), code("QA_LEGACY_FORBIDDEN"));
      assert.deepEqual(await business(), before);
    });
    await t.test("current persisted MFA, role and session authority are required even for successful replay", async () => {
      const p = await plan(), request = input(p), key = metadata();
      await runQaLegacyProvenance(origin, request, key, options);
      try {
        await db.admin.query("update auth_sessions set mfa_verified_at=now()-interval '16 minutes' where id=$1", [origin.authSessionId]);
        await assert.rejects(plan(), code("42501"));
        await assert.rejects(runQaLegacyProvenance(origin, request, key, options), code("42501"));
        await db.admin.query("update auth_sessions set mfa_verified_at=now(),revoked_at=now(),revoked_reason='SYNTHETIC replay revoke' where id=$1", [origin.authSessionId]);
        await assert.rejects(plan(), code("SESSION_REVOKED"));
        await db.admin.query("update auth_sessions set revoked_at=null,revoked_reason=null where id=$1", [origin.authSessionId]);
        await db.admin.query("update workspace_users set product_role='novalure_sales' where id=$1", [origin.userId]);
        await assert.rejects(plan(), code("QA_LEGACY_FORBIDDEN"));
      } finally {
        await db.admin.query("update workspace_users set product_role='novalureAdmin' where id=$1", [origin.userId]);
        await db.admin.query("update auth_sessions set mfa_verified_at=now(),revoked_at=null,revoked_reason=null where id=$1", [origin.authSessionId]);
      }
    });
    await t.test("withdrawn target membership and actual identity mismatch cannot be replaced by caller claims", async () => {
      try {
        await db.admin.query("update workspace_users set status='suspended' where id=$1", [a.session.userId]);
        await assert.rejects(plan(), code("42501"));
      } finally { await db.admin.query("update workspace_users set status='active' where id=$1", [a.session.userId]); }
      await assert.rejects(plan(a.selectors, { ...origin, authIdentityId: otherOrigin.authIdentityId }), code("IDENTITY_MISMATCH"));
    });
    await t.test("successful evidence replay still rejects a changed current settings fingerprint", async () => {
      const p = await plan(), request = input(p), key = metadata();
      await runQaLegacyProvenance(origin, request, key, options);
      const row = (await db.admin.query("select module_key,reason from workspace_module_settings where workspace_id=$1 order by module_key limit 1", [a.created.workspace.id])).rows[0];
      try {
        await db.admin.query("update workspace_module_settings set reason='SYNTHETIC later genuine setting' where workspace_id=$1 and module_key=$2", [a.created.workspace.id, row.module_key]);
        await assert.rejects(runQaLegacyProvenance(origin, request, key, options), code("QA_LEGACY_PLAN_STALE"));
      } finally { await db.admin.query("update workspace_module_settings set reason=$3 where workspace_id=$1 and module_key=$2", [a.created.workspace.id, row.module_key, row.reason]); }
    });
    await t.test("exact ID/count/hash/confirmation, expiry and fresh state/schema CAS are enforced", async () => {
      const p = await plan(), request = input(p);
      for (const change of [{ expectedPlanDigest: "f".repeat(64) }, { expectedCounts: { bots: 1 } }, { expectedTargets: p.plan.targets.map((target, index) => index ? target : { ...target, id: randomUUID() }) }, { confirmation: "MARK QA AND CLEAN" }]) await assert.rejects(runQaLegacyProvenance(origin, { ...request, ...change }, metadata(), options), code("QA_LEGACY_PLAN_MISMATCH"));
      await withCrmRead(a.session, (tx, fresh) => savePropertyCreationDraft(tx, fresh, { id: a.ownDraftId, draft: { ...emptyPropertyCreationDraft(), projectId: a.created.project.id }, step: 0, expectedRevision: 1, requestId: randomUUID() }), options);
      await assert.rejects(runQaLegacyProvenance(origin, request, metadata(), options), code("QA_LEGACY_PLAN_STALE"));
      const schemaPlan = await plan();
      await db.admin.query("create table synthetic_unknown_legacy_resources(id uuid primary key,workspace_id uuid not null)");
      await assert.rejects(runQaLegacyProvenance(origin, input(schemaPlan), metadata(), options), code("QA_LEGACY_PLAN_STALE"));
      for (const change of ["alter table synthetic_unknown_legacy_resources add column future_status text", "create policy synthetic_future_visibility on synthetic_unknown_legacy_resources to novalure_tenant_app using(workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid)"]) {
        const beforeSchemaChange = await plan();
        await db.admin.query(change);
        await assert.rejects(runQaLegacyProvenance(origin, input(beforeSchemaChange), metadata(), options), code("QA_LEGACY_PLAN_STALE"));
      }
      const expiredPlan = await plan(), oldId = randomUUID();
      await db.admin.query("insert into crm_command_receipts(id,workspace_id,actor_user_id,operation,resource_id,idempotency_key,request_hash,response,audit_reference,correlation_id,data_classification,created_at) select $1,workspace_id,actor_user_id,operation,resource_id,$2,request_hash,response,audit_reference,correlation_id,data_classification,now()-interval '16 minutes' from crm_command_receipts where id=$3", [oldId, randomUUID(), expiredPlan.planId]);
      await assert.rejects(runQaLegacyProvenance(origin, { ...input(expiredPlan), planId: oldId }, metadata(), options), code("QA_LEGACY_PLAN_EXPIRED"));
      // Append separately marked historical fixture rows, never UPDATE an
      // immutable receipt or disable its guard. A matching existing successful
      // receipt would bypass the callback; expiry must precede that lookup.
      const historicalRequest = { ...input(expiredPlan), planId: oldId }, historicalKey = metadata();
      const historicalHash = crmPayloadDigest({ digestVersion: 2, contractVersion: "1", correlationId: historicalKey.correlationId, actorId: origin.userId, workspaceId: origin.workspaceId, operation: "qa.legacy.provenance.register", resourceId: a.selectors.sourceReceiptId, capability: "settings:manage", payload: historicalRequest, dataClassification: "NOVALURE_INTERNAL", purpose: "crm_sales" });
      await db.admin.query("insert into crm_command_receipts(id,workspace_id,actor_user_id,operation,resource_id,idempotency_key,request_hash,response,audit_reference,correlation_id,data_classification,created_at) select $1,workspace_id,actor_user_id,operation,resource_id,$2,$3,response,audit_reference,$4,data_classification,now()-interval '16 minutes' from crm_command_receipts where workspace_id=$5 and operation='qa.legacy.provenance.register' order by created_at limit 1", [randomUUID(), historicalKey.idempotencyKey, historicalHash, historicalKey.correlationId, origin.workspaceId]);
      await assert.rejects(runQaLegacyProvenance(origin, historicalRequest, historicalKey, options), code("QA_LEGACY_PLAN_EXPIRED"));
    });
    await t.test("invoker contract restores origin context on success and failure; runtime ACLs stay unchanged", async () => {
      const functionAcl = (await db.admin.query("select prosecdef from pg_proc where oid='crm_qa_legacy_provenance_snapshot(uuid,uuid,uuid,uuid)'::regprocedure")).rows[0];
      assert.equal(functionAcl.prosecdef, false);
      await withCrmRead(origin, async tx => {
        await tx.queryOne("select crm_qa_legacy_provenance_snapshot($1,$2,$3,$4)", [origin.authSessionId, a.selectors.sourceReceiptId, a.selectors.targetAuditId, a.ownDraftId]);
        assert.deepEqual(await tx.queryOne("select current_setting('app.tenant_id') as tenant,current_setting('app.actor_id') as actor"), { tenant: origin.workspaceId, actor: origin.userId });
      }, options);
      const client = await db.pool.connect();
      try {
        await client.query("begin"); await client.query("select set_config('app.tenant_id',$1,true),set_config('app.actor_id',$2,true)", [origin.workspaceId, origin.userId]);
        await client.query("savepoint synthetic_failure");
        await assert.rejects(client.query("select crm_qa_legacy_provenance_snapshot($1,$2,$3,$4)", [origin.authSessionId, a.selectors.sourceReceiptId, b.selectors.targetAuditId, a.ownDraftId]), code("42501"));
        await client.query("rollback to savepoint synthetic_failure");
        assert.deepEqual((await client.query("select current_setting('app.tenant_id') as tenant,current_setting('app.actor_id') as actor")).rows[0], { tenant: origin.workspaceId, actor: origin.userId });
      } finally { await client.query("rollback"); client.release(); }
      const roles = (await db.admin.query("select rolname from pg_roles where rolname like 'novalure_qa_%'")).rows;
      assert.deepEqual(roles, []);
    });
    await t.test("real cookie/CSRF route stores only evidence and rejects missing CSRF and extra selectors", async () => {
      const secret = randomBytes(48).toString("base64url"), originUrl = "http://127.0.0.1:3000", pathname = "/api/admin/qa-legacy-provenance";
      Object.assign(process.env, { DATABASE_URL: `postgresql://${db.role}@127.0.0.1:${db.port}/postgres`, NODE_ENV: "test", CRM_LOCAL_TEST_DATABASE: "1", NOVALURE_SESSION_SECRET: secret, NOVALURE_APP_ORIGIN: originUrl, NOVALURE_AUTH_STRICT: "1", NOVALURE_AUTH_ENCRYPTION_KEY: randomBytes(40).toString("hex"), NOVALURE_AUTH_RATE_LIMIT_SECRET: randomBytes(40).toString("hex") });
      await db.admin.query("update auth_sessions set token_hash=$2 where id=$1", [origin.authSessionId, createHash("sha256").update(cookie).digest("hex")]);
      const request = (csrf = true, suffix = "") => new Request(originUrl + pathname + "?workspaceId=" + origin.workspaceId + suffix, { method: "POST", headers: { "content-type": "application/json", origin: originUrl, "sec-fetch-site": "same-origin", cookie: "novalure_session=" + cookie, "Idempotency-Key": randomUUID(), "X-Correlation-Id": randomUUID(), ...(csrf ? { "x-novalure-csrf-token": createCsrfToken({ method: "POST", pathname, secret, sessionCookie: cookie })!.token } : {}) }, body: JSON.stringify({ mode: "plan", ...a.selectors }) });
      assert.equal((await POST(request(false))).status, 403);
      assert.equal((await POST(request(true, "&actorId=" + origin.userId))).status, 400);
      const response = await POST(request());
      assert.equal(response.status, 200, await response.clone().text());
      const body = await response.json();
      assert.equal(body.classificationAllowed, false); assert.equal(body.qaFlagChanged, false);
      assert.equal(response.headers.get("cache-control"), "private, no-store");
      assert.equal((await db.admin.query("select is_qa from workspaces where id=$1", [a.created.workspace.id])).rows[0].is_qa, false);
      assert.equal((await db.admin.query("select count(*)::int as n from qa_batches")).rows[0].n, 0);
    });
  } finally {
    await closeLocalTestPool();
    for (const key of envKeys) if (envBefore[key] === undefined) delete process.env[key]; else process.env[key] = envBefore[key];
    globalThis.fetch = originalFetch;
    await db.stop();
  }
});
