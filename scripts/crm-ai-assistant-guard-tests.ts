import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import type { AppSession } from "../src/lib/auth/session";
import { getRolePermissions } from "../src/lib/auth/permissions";
import { getProductRoleCapabilities, type ProductRole } from "../src/lib/product-model";
import { crmPayloadDigest, CrmCommandError, withCrmRead } from "../src/lib/crm-command";
import type { TenantPool } from "../src/lib/db/tenant-client";
import type { AssistantRequest } from "../src/lib/crm-ai-assistant/contracts";
import { loadAssistantContext } from "../src/lib/crm-ai-assistant/context";
import { AssistantError, readAssistantSnapshot, runCrmAssistant } from "../src/lib/crm-ai-assistant/service";
import { applySalesSchema, startLocalSalesDb } from "./lib/local-sales-db.mjs";

test("assistant guarded receipts, concurrency and late authority remain enforced under the runtime role", { timeout: 240_000 }, async t => {
  // Disposable loopback cluster, synthetic records and intercepted provider only.
  const db = await startLocalSalesDb();
  const names = ["AI_GATEWAY_API_KEY", "VERCEL_AI_GATEWAY_API_KEY", "NOVALURE_LLM_BASE_URL", "NOVALURE_LLM_API_KEY", "NOVALURE_LLM_MODEL"];
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  const originalFetch = globalThis.fetch;
  try {
    await applySalesSchema(db, { maxMigrationNumber: 106 });
    // Reproduce production defaults before applying the new feature's ACL guards.
    await db.admin.query("alter default privileges in schema public grant select,insert,update,delete on tables to novalure_app");
    await db.admin.query("alter default privileges in schema public grant execute on functions to novalure_app");
    for (const migration of ["146_ai_credit_billing", "152_ai_billing_admin", "153_ai_billing_runtime_acl", "188_crm_ai_assistant"]) await db.admin.query(await readFile(`migrations/${migration}.sql`, "utf8"));
    const workspaceId = randomUUID(), ownerId = randomUUID(), projectId = randomUUID();
    await db.admin.query("insert into workspaces(id,name,operating_model) values($1,'SYNTHETIC assistant security','self_service_customer')", [workspaceId]);
    await db.admin.query("insert into workspace_users(id,workspace_id,name,email,role,product_role,status) values($1,$2,'SYNTHETIC owner',$3,'owner','customer_owner','active')", [ownerId, workspaceId, `assistant-owner-${ownerId}@example.invalid`]);
    await db.admin.query("insert into projects(id,workspace_id,name,type) values($1,$2,'SYNTHETIC accessible project','Makler')", [projectId, workspaceId]);
    const options = { pool: db.pool as unknown as TenantPool };
    const makeSession = (userId: string, role: AppSession["role"] = "owner", productRole: ProductRole = "customer_owner"): AppSession => ({ authenticated: true, source: "database", workspaceId, userId, workspaceName: "SYNTHETIC", name: "Synthetic member", email: "synthetic@example.invalid", role, productRole, permissions: getRolePermissions(role), productPermissions: getProductRoleCapabilities(productRole) });
    const owner = makeSession(ownerId);
    const input = (extra: Partial<AssistantRequest> = {}): AssistantRequest => ({ mode: "daily_briefing", prompt: "", language: "de", timeZone: "Europe/Vienna", tone: "professional", projectId, ...extra });
    for (const name of names) delete process.env[name];
    Object.assign(process.env, { NOVALURE_LLM_BASE_URL: "https://synthetic-assistant.invalid/v1", NOVALURE_LLM_API_KEY: "SYNTHETIC_NON_SECRET" });
    let providerCalls = 0;
    let providerHook: (() => Promise<void>) | null = null;
    globalThis.fetch = async (url, init) => {
      assert.equal(String(url), "https://synthetic-assistant.invalid/v1/chat/completions");
      providerCalls++;
      const requestId = new Headers(init?.headers).get("x-client-request-id");
      const reservation = (await db.admin.query("select status from ai_credit_reservations where workspace_id=$1 and request_id=$2", [workspaceId, requestId])).rows[0];
      assert.equal(reservation?.status, "reserved", "a committed credit hold precedes every provider call");
      await providerHook?.();
      return Response.json({ choices: [{ message: { content: "SYNTHETIC Vorschlag: Prüfen Sie die offenen Aufgaben." } }], usage: { prompt_tokens: 100, completion_tokens: 25 } });
    };
    const isForbidden = (error: unknown) => error instanceof CrmCommandError && error.status === 403;
    async function startOnly(request: AssistantRequest, key = randomUUID()) {
      const hash = crmPayloadDigest(request);
      const authority = await withCrmRead(owner, async (tx, fresh) => {
        const context = await loadAssistantContext(tx, fresh, request);
        await tx.queryOne("select crm_assistant_start($1::uuid,$2::uuid,$3,$4,$5::jsonb,$6::jsonb)", [workspaceId, key, hash, context.authority, JSON.stringify(request), JSON.stringify(context.sources)]);
        return context.authority;
      }, options);
      return { key, hash, authority };
    }
    async function closeSyntheticPending(key: string) {
      await db.admin.query("update crm_ai_assistant_runs set status='failed',error_code='SYNTHETIC_TEST_CLEANUP',finished_at=now() where workspace_id=$1 and id=$2 and status='processing'", [workspaceId, key]);
    }

    await t.test("runtime cannot finalize a receipt with NULL, malformed or incorrect digests", async () => {
      const run = await startOnly(input());
      for (const [hash, authority] of [[null, run.authority], [run.hash, null], [null, null], ["bad", run.authority], [run.hash, "0".repeat(64)]]) {
        await assert.rejects(withCrmRead(owner, tx => tx.queryOne("select crm_assistant_finish($1::uuid,$2::uuid,$3,$4,null,'SYNTHETIC_REJECTION',0)", [workspaceId, run.key, hash, authority]), options), /AI_ASSISTANT_FORBIDDEN/);
      }
      assert.equal((await db.admin.query("select status from crm_ai_assistant_runs where workspace_id=$1 and id=$2", [workspaceId, run.key])).rows[0].status, "processing");
      await closeSyntheticPending(run.key);
      const rights = (await db.admin.query("select has_table_privilege($1,'crm_ai_assistant_runs','INSERT') as insert,has_table_privilege($1,'crm_ai_assistant_runs','UPDATE') as update,has_function_privilege($1,'crm_assistant_actor(uuid)','EXECUTE') as raw_actor", [db.role])).rows[0];
      assert.deepEqual(rights, { insert: false, update: false, raw_actor: false });
    });

    await t.test("concurrent requests with the same key make one provider call and the second receives processing", async () => {
      const key = randomUUID(), request = input(), before = providerCalls;
      let started!: () => void, release!: () => void;
      const entered = new Promise<void>(resolve => { started = resolve; });
      const held = new Promise<void>(resolve => { release = resolve; });
      providerHook = async () => { started(); await held; };
      const first = runCrmAssistant(owner, request, key, options);
      try {
        await Promise.race([entered, first.then(() => { throw new Error("The first request completed without reaching the synthetic provider"); })]);
        const snapshot = await readAssistantSnapshot(owner, request, options);
        assert.equal(snapshot.pendingRun?.id, key);
        assert.deepEqual(snapshot.pendingRun?.request, request);
        const concurrent = await runCrmAssistant(owner, request, key, options);
        assert.deepEqual(concurrent, { status: 202, code: "AI_REQUEST_PROCESSING" });
        assert.equal(providerCalls, before + 1);
      } finally { release(); providerHook = null; }
      assert.equal((await first).status, 201);
      assert.equal((await runCrmAssistant(owner, request, key, options)).status, 200);
      assert.equal(providerCalls, before + 1);
      assert.equal(Number((await db.admin.query("select count(*) from ai_credit_reservations where workspace_id=$1 and request_id=$2", [workspaceId, key])).rows[0].count), 1);
    });

    await t.test("a stale processing request becomes terminal unknown without a second provider call", async () => {
      const request = input(), run = await startOnly(request), before = providerCalls;
      await db.admin.query("update crm_ai_assistant_runs set created_at=now()-interval '3 minutes' where workspace_id=$1 and id=$2", [workspaceId, run.key]);
      for (let retry = 0; retry < 2; retry++) await assert.rejects(runCrmAssistant(owner, request, run.key, options), error => error instanceof AssistantError && error.code === "AI_PROVIDER_OUTCOME_UNKNOWN" && error.terminal);
      assert.equal(providerCalls, before);
      const saved = (await db.admin.query("select status,error_code,result from crm_ai_assistant_runs where workspace_id=$1 and id=$2", [workspaceId, run.key])).rows[0];
      assert.deepEqual(saved, { status: "failed", error_code: "AI_PROVIDER_OUTCOME_UNKNOWN", result: null });
    });

    await t.test("a fresh role revocation during the provider call prevents delivery and completed persistence", async () => {
      const key = randomUUID(), before = providerCalls;
      providerHook = async () => { await db.admin.query("update workspace_users set product_role='viewer' where workspace_id=$1 and id=$2", [workspaceId, ownerId]); };
      try {
        await assert.rejects(runCrmAssistant(owner, input(), key, options), isForbidden);
        assert.equal(providerCalls, before + 1);
        const saved = (await db.admin.query("select status,result from crm_ai_assistant_runs where workspace_id=$1 and id=$2", [workspaceId, key])).rows[0];
        assert.notEqual(saved.status, "completed"); assert.equal(saved.result, null);
        await assert.rejects(readAssistantSnapshot(owner, input(), options), isForbidden);
      } finally {
        providerHook = null;
        await db.admin.query("update workspace_users set product_role='customer_owner' where workspace_id=$1 and id=$2", [workspaceId, ownerId]);
        await closeSyntheticPending(key);
      }
    });

    await t.test("ordinary team and backoffice members with project grants can use the assistant without bot publication rights", async () => {
      for (const [role, productRole] of [["agent", "team_member"], ["assistant", "assistant_backoffice"]] as const) {
        const userId = randomUUID();
        await db.admin.query("insert into workspace_users(id,workspace_id,name,email,role,product_role,status) values($1,$2,'SYNTHETIC ordinary member',$3,$4,$5,'active')", [userId, workspaceId, `${productRole}-${userId}@example.invalid`, role, productRole]);
        await db.admin.query("insert into project_pipeline_permissions(workspace_id,project_id,user_id,can_read,can_edit_deals) values($1,$2,$3,true,false)", [workspaceId, projectId, userId]);
        const member = makeSession(userId, role, productRole);
        assert.ok(!member.productPermissions.includes("bots:publish"));
        assert.equal((await readAssistantSnapshot(member, input(), options)).workspaceId, workspaceId);
        const result = await runCrmAssistant(member, input(), randomUUID(), options);
        assert.equal(result.status, 201); assert.equal(result.result?.status, "completed");
      }
    });

    await t.test("completed replay rechecks fresh authority after its first transaction commits", async () => {
      const request = input(), key = randomUUID();
      assert.equal((await runCrmAssistant(owner, request, key, options)).status, 201);
      const before = providerCalls;
      let revoked = false;
      const pool = { connect: async () => {
        const client = await db.pool.connect(); let started = false;
        return new Proxy(client, { get(target, property) {
          if (property === "release") return target.release.bind(target);
          if (property !== "query") return Reflect.get(target, property);
          return async (query: string, params?: unknown[]) => {
            if (query.includes("select crm_assistant_start(")) started = true;
            const result = await target.query(query, params);
            if (started && /^\s*commit\s*;?\s*$/iu.test(query) && !revoked) {
              revoked = true;
              await db.admin.query("update workspace_users set product_role='viewer' where workspace_id=$1 and id=$2", [workspaceId, ownerId]);
            }
            return result;
          };
        } });
      } } as unknown as TenantPool;
      try {
        await assert.rejects(runCrmAssistant(owner, request, key, { pool }), isForbidden);
        assert.equal(revoked, true); assert.equal(providerCalls, before);
      } finally { await db.admin.query("update workspace_users set product_role='customer_owner' where workspace_id=$1 and id=$2", [workspaceId, ownerId]); }
    });

    await t.test("metrics count records beyond the detail limit and today follows the selected European time zone", async () => {
      await db.admin.query("insert into leads(id,workspace_id,project_id,type,status,intent) select gen_random_uuid(),$1,$2,'Käufer','Neu','SYNTHETIC detail limit '||i from generate_series(1,120) i", [workspaceId, projectId]);
      await db.admin.query(`insert into calendar_events(id,workspace_id,project_id,title,starts_at,ends_at,owner_user_id)
        select gen_random_uuid(),$1,$2,'SYNTHETIC zone boundary',chosen,chosen+interval '15 minutes',$3 from (
          select ((date_trunc('day',now() at time zone 'Europe/Vienna') at time zone 'Europe/Vienna')+
          case when (now() at time zone 'Europe/Vienna')::date=(now() at time zone 'Europe/Dublin')::date then interval '30 minutes' else interval '23 hours 30 minutes' end) as chosen
        ) boundary`, [workspaceId, projectId, ownerId]);
      const vienna = await readAssistantSnapshot(owner, input(), options), dublin = await readAssistantSnapshot(owner, input({ timeZone: "Europe/Dublin" }), options);
      assert.equal(vienna.options.leads.length, 100); assert.equal(vienna.metrics.openLeads, 120); assert.equal(vienna.contextLimited, true);
      assert.equal(vienna.metrics.todayMeetings, 1); assert.equal(dublin.metrics.todayMeetings, 0);
    });
  } finally {
    globalThis.fetch = originalFetch;
    for (const name of names) { if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name]; }
    await db.stop();
  }
});
