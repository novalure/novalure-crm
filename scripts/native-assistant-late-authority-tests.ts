import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { MockLanguageModelV4 } from "ai/test";
import type { AppSession } from "../src/lib/auth/session";
import { getRolePermissions } from "../src/lib/auth/permissions";
import { getProductRoleCapabilities } from "../src/lib/product-model";
import { CRM_MACHINE_WORKSPACE_ID } from "../src/lib/crm-machine-auth";
import { closeLocalTestPool } from "../src/lib/db/local-test-transport";
import type { TenantTransactionOptions } from "../src/lib/db/tenant-client";
import { assignKnowledgeAreas, createKnowledgeArea, createKnowledgeSource, publishKnowledgeSource } from "../src/lib/knowledge-center/repository";
import { handleWebsiteChatRequest } from "../src/lib/knowledge-center/website-chat";
import { runBotChat } from "../src/lib/bots/chat-runtime";
import { behaviorRuleIds } from "../src/lib/shared-behavior/catalog";
import { recordBoundAssistantFormatSignal } from "../src/lib/shared-behavior/bound-private-signal";
import type { NativeRuntimeStatus } from "../src/lib/shared-behavior/native-assistant";
import { applySalesSchema, startLocalSalesDb } from "./lib/local-sales-db.mjs";

test("native final authority gates actual handler delivery while optional signal failures preserve replies", { timeout: 240_000 }, async t => {
  // The existing helper always creates a disposable loopback-only cluster and
  // ignores external connection strings. Model ports below are deterministic.
  const db = await startLocalSalesDb();
  const keys = ["DATABASE_URL", "CRM_LOCAL_TEST_DATABASE", "NODE_ENV", "NOVALURE_ABUSE_SECRET", "NOVALURE_TRUSTED_CLIENT_IP_HEADER", "VERCEL", "VERCEL_ENV", "VERCEL_URL", "NOVALURE_SHARED_NATIVE_METHODS_ENABLED", "NOVALURE_SHARED_NATIVE_SIGNALS_ENABLED", "NOVALURE_SHARED_NATIVE_SIGNAL_BINDINGS"] as const;
  const prior = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  try {
    await applySalesSchema(db, { maxMigrationNumber: 90 });
    await db.admin.query("insert into workspaces(id,name,operating_model,customer_type,setup_state) values($1,'SYNTHETIC machine predecessor','novalure_internal','novalure_internal','{}') on conflict(id) do update set operating_model='novalure_internal',customer_type='novalure_internal'", [CRM_MACHINE_WORKSPACE_ID]);
    await db.admin.query("alter table company_profiles enable row level security; alter table company_profiles force row level security; alter table company_profile_versions enable row level security; alter table company_profile_versions force row level security");
    await db.admin.query("do $$ declare r record; begin for r in select format('%I.%I',n.nspname,c.relname) as q from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','p') and c.relrowsecurity loop execute 'alter table '||r.q||' force row level security'; end loop; end $$");
    for (const name of ["092_crm_production_machine_identity.sql", "093_crm_machine_internal_context.sql", "101_knowledge_center.sql", "108_knowledge_connected_assistant_quota.sql", "094_website_sales_ingestion.sql", "095_form_tenant_isolation.sql", "096_public_integration_gateway.sql"]) {
      const sql = await readFile(`migrations/${name}`, "utf8");
      await db.admin.query(sql);
      await db.admin.query("insert into novalure_schema_migrations(version,name,checksum) values($1,$2,$3) on conflict(version) do nothing", [name.replace(/\.sql$/u, ""), name, createHash("sha256").update(sql).digest("hex")]);
    }
    for (const name of ["115_shared_behavior_foundation.sql", "116_shared_behavior_package2.sql", "117_shared_behavior_package3.sql", "118_shared_behavior_personal_runtime.sql"])
      await db.admin.query(await readFile(`migrations/${name}`, "utf8"));
    const workspace = randomUUID(), owner = randomUUID(), project = randomUUID(), bot = randomUUID(), actor = randomUUID(), integration = randomUUID(), visitor = randomUUID();
    await db.admin.query("insert into workspaces(id,name,operating_model) values($1,'SYNTHETIC final authority','managed_by_novalure')", [workspace]);
    await db.admin.query("insert into workspace_users(id,workspace_id,name,email,role,product_role,status) values($1,$3,'SYNTHETIC owner','owner@example.invalid','owner','customer_owner','active'),($2,$3,'SYNTHETIC signal actor','actor@example.invalid','agent','project_sales_member','active')", [owner, actor, workspace]);
    await db.admin.query("insert into projects(id,workspace_id,name,type,division) values($1,$2,'SYNTHETIC studio','synthetic','WEB_DESIGN')", [project, workspace]);
    await db.admin.query("insert into bots(id,workspace_id,project_id,name,role) values($1,$2,$3,'SYNTHETIC assistant','advisor')", [bot, workspace, project]);
    await db.admin.query("update auth_identities set credential_state='disabled',disabled_at=now(),password_hash=null where id=(select auth_identity_id from workspace_users where id=$1)", [actor]);
    await db.admin.query(`insert into knowledge_center_entitlements(workspace_id,enabled,max_sources,max_storage_bytes,max_queries_per_month,contract_reference,features,limits)
      values($1,true,100,20000000,1000,'SYNTHETIC-ONLY','{"webchatAccess":true}','{"maxAreas":100,"maxWebsites":10,"maxScansPerMonth":10,"maxUsers":20,"maxAssistants":20}')`, [workspace]);
    const session: AppSession = { authenticated: true, source: "database", userId: owner, workspaceId: workspace, workspaceName: "SYNTHETIC", name: "SYNTHETIC", email: "owner@example.invalid", role: "owner", productRole: "customer_owner", permissions: getRolePermissions("owner"), productPermissions: getProductRoleCapabilities("customer_owner") };
    const options: TenantTransactionOptions = { pool: db.pool as unknown as NonNullable<TenantTransactionOptions["pool"]> };
    const area = await createKnowledgeArea(session, { name: "SYNTHETIC granted area", kind: "project", projectId: project }, options);
    let source = await createKnowledgeSource(session, { areaId: area.id, type: "manual", name: "SYNTHETIC protected price", content: "studioanchor Website package price is EUR 499." }, options);
    source = await publishKnowledgeSource(session, { sourceId: source.id, versionId: source.draftVersionId!, expectedVersion: source.revision }, options);
    await assignKnowledgeAreas(session, { botId: bot, channel: "webchat", areaIds: [area.id] }, options);
    const publicSiteKey = `nov_pk_${randomBytes(24).toString("base64url")}`, token = randomBytes(32).toString("base64url"), capability = randomBytes(32).toString("base64url"), origin = "https://synthetic-authority.example";
    await db.admin.query(`insert into external_integrations(id,public_site_key,workspace_id,project_id,integration_type,status,mode,allowed_origins,capabilities,configuration,created_by)
      values($1,$2,$3,$4,'website_chat','active','training',array[$5],array['chat.start','chat.context'],$6::jsonb,$7)`, [integration, publicSiteKey, workspace, project, origin, JSON.stringify({ knowledgeAssistantId: bot }), owner]);
    await db.admin.query("insert into external_integration_widget_configs(integration_id,workspace_id,chat_enabled,enabled_capabilities) values($1,$2,true,array['chat.start','chat.context'])", [integration, workspace]);
    await db.admin.query("insert into external_chat_sessions(id,integration_id,workspace_id,project_id,session_token_hash,idempotency_hash,mode,language,synthetic) values($1,$2,$3,$4,$5,$6,'training','en',true)", [visitor, integration, workspace, project, createHash("sha256").update(token).digest("hex"), createHash("sha256").update(randomUUID()).digest("hex")]);
    await db.admin.query("insert into behavior_releases values(1,$1,array['ceo']),(2,$1,array['ceo','webchat','agent'])", [behaviorRuleIds]);
    await db.admin.query("insert into behavior_release_head(singleton,version,revision) values(true,2,1)");
    await db.admin.query("insert into behavior_runtime_bindings(workspace_id,broker_actor_id,actor_id,bot_id,department,token_hash,enabled,expires_at) values($1,$2,$3,$4,'support',$5,true,now()+interval '1 hour')", [workspace, owner, actor, bot, createHash("sha256").update(capability).digest("hex")]);
    for (const key of keys) delete process.env[key];
    Object.assign(process.env, { DATABASE_URL: `postgresql://${db.role}@127.0.0.1:${db.port}/postgres`, CRM_LOCAL_TEST_DATABASE: "1", NODE_ENV: "test", NOVALURE_ABUSE_SECRET: "synthetic-final-authority-abuse-secret-0001", NOVALURE_TRUSTED_CLIENT_IP_HEADER: "x-test-client-ip" });
    const statuses: NativeRuntimeStatus[] = [];
    const configured = (internal: boolean) => ({ ...options, nativeBehaviorEnv: { VERCEL_ENV: "production", NOVALURE_SHARED_NATIVE_METHODS_ENABLED: "1", NOVALURE_SHARED_NATIVE_SIGNALS_ENABLED: "1", NOVALURE_SHARED_NATIVE_SIGNAL_BINDINGS: JSON.stringify({ version: 1, bindings: [{ workspaceId: workspace, projectId: project, botId: bot, integrationId: internal ? null : integration, brokerActorId: owner, actorId: actor, capability }] }) }, observeNativeBehavior: (state: NativeRuntimeStatus) => { statuses.push(state); } });
    const counts = async () => Number((await db.admin.query("select count(*) from behavior_learning_signals")).rows[0].count);
    const syntheticModel = () => new MockLanguageModelV4({ doGenerate: async () => ({ content: [{ type: "text", text: JSON.stringify({ answerable: true, answer: "Website package price is EUR 499.", sourceIndices: [0] }) }], finishReason: { unified: "stop", raw: undefined }, usage: { inputTokens: { total: 20, noCache: 20, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 20, text: 20, reasoning: undefined } }, warnings: [] }) });
    const request = () => new Request(`https://crm.example.invalid/api/public/integrations/chat/answers?site_key=${publicSiteKey}`, { method: "POST", headers: { "content-type": "application/json", origin, "x-novalure-session-token": token, "x-test-client-ip": "203.0.113.91" }, body: JSON.stringify({ sessionId: visitor, message: "studioanchor" }) });
    const chatInput = { session, language: "en" as const, payload: { botId: bot, channel: "webchat", prompt: "studioanchor", testMode: true } };
    const generated = async () => ({ text: "Website package price is EUR 499. Next step: Contact the team.", model: "SYNTHETIC", provider: "SYNTHETIC", external: false });
    function phasePool(change?: () => Promise<void>, failRead = false, loseCommit = false, revokeIntegrationFence = false, stringFeatureOnCheck = 0) {
      let referenceChecks = 0, changed = false, replyLost = false, inserts = 0, fenceRevoked = false, fenceReads = 0, entitlementChecks = 0, featureReplaced = false;
      const pool = { connect: async () => {
        const client = await db.pool.connect(); let inserted = false, checkedReferences = false;
        return new Proxy(client, { get(target, property) {
          if (property === "release") return target.release.bind(target);
          if (property !== "query") return Reflect.get(target, property);
          return async (query: string, parameters?: unknown[]) => {
            if (/select e\.enabled and length\(trim\(coalesce\(e\.contract_reference/u.test(query)) {
              entitlementChecks++;
              if (entitlementChecks === stringFeatureOnCheck) {
                featureReplaced = true;
                await db.admin.query("update knowledge_center_entitlements set features=jsonb_set(features,'{webchatAccess}',to_jsonb('true'::text)) where workspace_id=$1", [workspace]);
              }
            }
            if (/select s\.id(?: as "sourceId")? from jsonb_to_recordset/u.test(query)) {
              referenceChecks++; checkedReferences = true;
              if (referenceChecks === 2) { changed = true; await change?.(); if (failRead) throw new Error("SYNTHETIC_OPTIONAL_SIGNAL_READ_UNAVAILABLE"); }
            }
            if (fenceRevoked && /from public\.crm_external_integration_resolve/u.test(query)) fenceReads++;
            if (/insert into behavior_learning_signals/u.test(query)) { inserted = true; inserts++; }
            const result = await target.query(query, parameters);
            // The completed-turn callback has already read valid references and
            // methods and actually committed. Only the later workload fence sees
            // the now-disabled integration; no callback-false shortcut is used.
            if (query === "commit" && checkedReferences && referenceChecks === 2 && revokeIntegrationFence && !fenceRevoked) {
              fenceRevoked = true;
              await db.admin.query("update external_integration_widget_configs set chat_enabled=false where integration_id=$1", [integration]);
            }
            if (query === "commit" && inserted && loseCommit && !replyLost) { replyLost = true; throw new Error("SYNTHETIC_COMMIT_REPLY_LOST"); }
            return result;
          };
        } });
      } };
      return { pool: pool as unknown as NonNullable<TenantTransactionOptions["pool"]>, state: () => ({ referenceChecks, changed, replyLost, inserts, fenceRevoked, fenceReads, entitlementChecks, featureReplaced }) };
    }
    for (const target of ["website", "bot"] as const) for (const kind of ["grant", "method"] as const) {
      await t.test(`${target}: known ${kind} withdrawal only at final signal recheck removes knowledge and citations`, async () => {
        const count = await counts();
        const phase = phasePool(async () => {
          if (kind === "grant") await db.admin.query("delete from knowledge_area_grants where bot_id=$1", [bot]);
          else await db.admin.query("update behavior_release_head set version=1,revision=revision+1");
        });
        try {
          const result = target === "website"
            ? await (await handleWebsiteChatRequest(request(), { ...configured(false), pool: phase.pool, model: syntheticModel() })).json()
            : await runBotChat(chatInput, { ...configured(true), pool: phase.pool, generateReply: generated });
          assert.equal(phase.state().referenceChecks, 2, "the first post-model authorization passed before the injected final check");
          assert.equal(phase.state().changed, true);
          assert.equal(statuses.at(-1)?.signal.status, "authority_changed"); assert.equal(statuses.at(-1)?.methodsCurrent, false);
          assert.doesNotMatch(JSON.stringify(result), /EUR 499|SYNTHETIC protected price/);
          assert.doesNotMatch(JSON.stringify(result), new RegExp(`${source.id}|${source.approvedVersionId}`));
          if (target === "website") { assert.equal(result.answerStatus, kind === "grant" ? "temporarily_unavailable" : "insufficient_knowledge"); assert.equal(result.operationalReason, kind === "grant" ? "access_denied" : undefined); assert.deepEqual(result.citations, []); }
          else { assert.equal(result.autonomy.replyBlocked, true); assert.equal(result.runSummary.humanHandoffRequired, true); }
          assert.equal(await counts(), count, "known denial never records a success or private format event");
        } finally {
          await assignKnowledgeAreas(session, { botId: bot, channel: "webchat", areaIds: [area.id] }, options);
          await db.admin.query("update behavior_release_head set version=2,revision=revision+1");
        }
      });
    }
    for (const target of ["website", "bot"] as const) await t.test(`${target}: strict webchat boolean changed to a JSON string only at final signal recheck removes knowledge and citations`, async () => {
      const initial = (await db.admin.query("select features->'webchatAccess' as feature from knowledge_center_entitlements where workspace_id=$1", [workspace])).rows[0];
      assert.equal(initial.feature, true, "normal repository retrieval starts with an actual JSON boolean");
      // Website additionally checks authority before retrieval. Both paths keep
      // boolean true through retrieval and the first post-model reference check.
      const finalCheck = target === "website" ? 3 : 2;
      const phase = phasePool(undefined, false, false, false, finalCheck), count = await counts();
      try {
        const result = target === "website"
          ? await (await handleWebsiteChatRequest(request(), { ...configured(false), pool: phase.pool, model: syntheticModel() })).json()
          : await runBotChat(chatInput, { ...configured(true), pool: phase.pool, generateReply: generated });
        assert.equal(phase.state().referenceChecks, 2, "initial retrieval and the first post-model guard passed before the final entitlement change");
        assert.equal(phase.state().entitlementChecks, finalCheck); assert.equal(phase.state().featureReplaced, true);
        const changed = (await db.admin.query("select features->'webchatAccess' as feature,jsonb_typeof(features->'webchatAccess') as type from knowledge_center_entitlements where workspace_id=$1", [workspace])).rows[0];
        assert.equal(changed.feature, "true"); assert.equal(changed.type, "string");
        assert.equal(statuses.at(-1)?.signal.status, "authority_changed"); assert.equal(statuses.at(-1)?.methodsCurrent, false);
        assert.doesNotMatch(JSON.stringify(result), /EUR 499|SYNTHETIC protected price/);
        assert.doesNotMatch(JSON.stringify(result), new RegExp(`${source.id}|${source.approvedVersionId}`));
        if (target === "website") { assert.equal(result.answerStatus, "temporarily_unavailable"); assert.equal(result.operationalReason, "access_denied"); assert.deepEqual(result.citations, []); }
        else { assert.equal(result.autonomy.replyBlocked, true); assert.equal(result.runSummary.humanHandoffRequired, true); }
        assert.equal(phase.state().inserts, 0); assert.equal(await counts(), count, "a string-valued entitlement never records a private signal");
      } finally {
        await db.admin.query("update knowledge_center_entitlements set features=jsonb_set(features,'{webchatAccess}','true'::jsonb) where workspace_id=$1", [workspace]);
      }
    });
    await t.test("website integration fence invalidated after a valid completed-turn callback removes grounded disclosure", async () => {
      const phase = phasePool(undefined, false, false, true), count = await counts();
      try {
        const response = await handleWebsiteChatRequest(request(), { ...configured(false), pool: phase.pool, model: syntheticModel() });
        const answer = await response.json();
        assert.equal(response.status, 200);
        assert.equal(phase.state().referenceChecks, 2); assert.equal(phase.state().fenceRevoked, true);
        assert.equal(phase.state().fenceReads, 1, "the private workload integration fence observed invalid authority after the valid callback");
        assert.equal(phase.state().inserts, 0); assert.equal(await counts(), count);
        assert.equal(answer.answerStatus, "temporarily_unavailable"); assert.equal(answer.operationalReason, "access_denied"); assert.deepEqual(answer.citations, []);
        assert.doesNotMatch(JSON.stringify(answer), /EUR 499|SYNTHETIC protected price/);
        assert.equal(statuses.at(-1)?.signal.status, "authority_changed"); assert.equal(statuses.at(-1)?.methodsCurrent, false);
      } finally {
        await db.admin.query("update external_integration_widget_configs set chat_enabled=true where integration_id=$1", [integration]);
      }
    });
    await t.test("bot optional late signal read failure preserves the already authorized reply", async () => {
      const phase = phasePool(undefined, true), count = await counts();
      const result = await runBotChat(chatInput, { ...configured(true), pool: phase.pool, generateReply: generated });
      assert.equal(phase.state().referenceChecks, 2); assert.equal(result.autonomy.replyBlocked, false);
      assert.match(result.message.content, /EUR 499/); assert.equal(statuses.at(-1)?.signal.status, "unconfirmed");
      assert.equal(await counts(), count);
    });
    for (const target of ["website", "bot"] as const) await t.test(`${target}: real private-signal COMMIT with lost reply preserves business response without retry`, async () => {
      const phase = phasePool(undefined, false, true), count = await counts();
      const result = target === "website"
        ? await (await handleWebsiteChatRequest(request(), { ...configured(false), pool: phase.pool, model: syntheticModel() })).json()
        : await runBotChat(chatInput, { ...configured(true), pool: phase.pool, generateReply: generated });
      assert.equal(phase.state().replyLost, true); assert.equal(phase.state().inserts, 1);
      assert.match(JSON.stringify(result), /EUR 499/); assert.equal(statuses.at(-1)?.signal.status, "unconfirmed");
      if (target === "website") assert.equal(result.answerStatus, "grounded"); else assert.equal(result.autonomy.replyBlocked, false);
      assert.equal(await counts(), count + 1, "actual committed receipt survives, and is not retried or claimed absent");
    });
    await t.test("a nonmanager broker's exact read grant remains locked through the private signal COMMIT", async () => {
      const limitedBroker = randomUUID();
      await db.admin.query("insert into workspace_users(id,workspace_id,name,email,role,product_role,status) values($1,$2,'SYNTHETIC limited broker','limited-broker@example.invalid','agent','project_sales_member','active')", [limitedBroker, workspace]);
      await db.admin.query("insert into project_pipeline_permissions(workspace_id,project_id,user_id,can_read,can_edit_deals) values($1,$2,$3,true,false)", [workspace, project, limitedBroker]);
      await db.admin.query("update behavior_runtime_bindings set broker_actor_id=$1 where actor_id=$2", [limitedBroker, actor]);
      let lockProven = false;
      const pool = { connect: async () => {
        const client = await db.pool.connect(); let privateInsert = false;
        return new Proxy(client, { get(target, property) {
          if (property === "release") return target.release.bind(target);
          if (property !== "query") return Reflect.get(target, property);
          return async (query: string, parameters?: unknown[]) => {
            if (/insert into behavior_learning_signals/u.test(query)) privateInsert = true;
            const result = await target.query(query, parameters);
            if (query === "commit" && privateInsert) {
              const competitor = await db.admin.connect();
              try {
                await competitor.query("begin"); await competitor.query("set local lock_timeout='100ms'");
                await assert.rejects(competitor.query("update project_pipeline_permissions set can_read=false where workspace_id=$1 and project_id=$2 and user_id=$3", [workspace, project, limitedBroker]), { code: "55P03" });
                lockProven = true;
              } finally { await competitor.query("rollback"); competitor.release(); }
            }
            return result;
          };
        } });
      } };
      try {
        const before = await counts();
        const receipt = await recordBoundAssistantFormatSignal({ workspaceId: workspace, projectId: project, botId: bot,
          brokerActorId: limitedBroker, actorId: actor, capability, integrationId: null }, { kind: "bot" },
          { eventId: randomUUID(), issue: "unclear_next_step", outcome: "pass" }, { pool: pool as unknown as NonNullable<TenantTransactionOptions["pool"]> });
        assert.equal(receipt.recorded, true); assert.equal(lockProven, true); assert.equal(await counts(), before + 1);
        await db.admin.query("update project_pipeline_permissions set can_read=false where user_id=$1", [limitedBroker]);
        await assert.rejects(recordBoundAssistantFormatSignal({ workspaceId: workspace, projectId: project, botId: bot,
          brokerActorId: limitedBroker, actorId: actor, capability, integrationId: null }, { kind: "bot" },
          { eventId: randomUUID(), issue: "unclear_next_step", outcome: "pass" }, options));
        assert.equal(await counts(), before + 1);
      } finally { await db.admin.query("update behavior_runtime_bindings set broker_actor_id=$1 where actor_id=$2", [owner, actor]); }
    });
  } finally {
    await closeLocalTestPool(); await db.stop();
    for (const key of keys) { if (prior[key] === undefined) delete process.env[key]; else Object.assign(process.env, { [key]: prior[key] }); }
  }
});
