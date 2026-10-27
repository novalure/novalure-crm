import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import type { AppSession } from "../src/lib/auth/session";
import { getRolePermissions } from "../src/lib/auth/permissions";
import { getProductRoleCapabilities } from "../src/lib/product-model";
import { withCrmRead } from "../src/lib/crm-command";
import { closeLocalTestPool } from "../src/lib/db/local-test-transport";
import type { TenantTransactionOptions } from "../src/lib/db/tenant-client";
import { assignKnowledgeAreas, createKnowledgeArea, createKnowledgeSource, publishKnowledgeSource } from "../src/lib/knowledge-center/repository";
import { handleExternalAssistantKnowledgeRequest } from "../src/lib/knowledge-center/external-assistant-http";
import { handleEvelynRuntimeRequest } from "../src/lib/shared-behavior/runtime-http";
import { behaviorRuleIds } from "../src/lib/shared-behavior/catalog";
import { studioRuntimeIdentity as fixed, verifyStudioRuntimeToken } from "../src/lib/shared-behavior/studio-auth";
import { applySalesSchema, startLocalSalesDb } from "./lib/local-sales-db.mjs";

test("Studio native signatures and existing knowledge/signal handlers stay in one actual assistant scope", { timeout: 240_000 }, async t => {
  const db = await startLocalSalesDb();
  const keys = ["DATABASE_URL", "CRM_LOCAL_TEST_DATABASE", "NODE_ENV", "NOVALURE_ABUSE_SECRET", "NOVALURE_TRUSTED_CLIENT_IP_HEADER", "VERCEL", "VERCEL_ENV", "VERCEL_URL"] as const;
  const prior = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  try {
    await applySalesSchema(db, { maxMigrationNumber: 90 });
    await db.admin.query("alter table company_profiles enable row level security; alter table company_profiles force row level security; alter table company_profile_versions enable row level security; alter table company_profile_versions force row level security");
    await db.admin.query("insert into workspaces(id,name,operating_model,customer_type,setup_state) values($1,'SYNTHETIC Studio scope','novalure_internal','novalure_internal','{}') on conflict(id) do update set operating_model='novalure_internal',customer_type='novalure_internal'", [fixed.workspaceId]);
    await db.admin.query("do $$ declare r record; begin for r in select format('%I.%I',n.nspname,c.relname) as q from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','p') and c.relrowsecurity loop execute 'alter table '||r.q||' force row level security'; end loop; end $$");
    for (const file of ["092_crm_production_machine_identity.sql", "093_crm_machine_internal_context.sql", "101_knowledge_center.sql", "108_knowledge_connected_assistant_quota.sql", "094_website_sales_ingestion.sql", "095_form_tenant_isolation.sql", "096_public_integration_gateway.sql", "115_shared_behavior_foundation.sql", "116_shared_behavior_package2.sql", "117_shared_behavior_package3.sql", "118_shared_behavior_personal_runtime.sql"]) {
      const sql = await readFile(`migrations/${file}`, "utf8"); await db.admin.query(sql);
      await db.admin.query("insert into novalure_schema_migrations(version,name,checksum) values($1,$2,$3) on conflict(version) do nothing", [file.replace(/\.sql$/u, ""), file, createHash("sha256").update(sql).digest("hex")]);
    }
    const owner = randomUUID(), actor = randomUUID(), visitor = randomUUID(), capability = randomBytes(32).toString("base64url"), sessionToken = randomBytes(32).toString("base64url");
    await db.admin.query("insert into workspace_users(id,workspace_id,name,email,role,product_role,status) values($1,$3,'SYNTHETIC admin','admin@example.invalid','admin','novalureAdmin','active'),($2,$3,'SYNTHETIC signal actor','private@example.invalid','agent','novalure_operator','active')", [owner, actor, fixed.workspaceId]);
    await db.admin.query("update auth_identities set credential_state='disabled',disabled_at=now(),password_hash=null where id=(select auth_identity_id from workspace_users where id=$1)", [actor]);
    await db.admin.query("insert into projects(id,workspace_id,name,type,division) values($1,$2,'SYNTHETIC web project','synthetic','WEB_DESIGN')", [fixed.crmProjectId, fixed.workspaceId]);
    await db.admin.query("insert into bots(id,workspace_id,project_id,name,role,status) values($1,$2,$3,'SYNTHETIC assistant','advisor','inactive')", [fixed.botId, fixed.workspaceId, fixed.crmProjectId]);
    await db.admin.query("insert into knowledge_center_entitlements(workspace_id,enabled,max_sources,max_storage_bytes,max_queries_per_month,contract_reference,features,limits) values($1,true,100,20000000,1000,'SYNTHETIC-ONLY','{\"webchatAccess\":true}','{\"maxAreas\":100,\"maxUsers\":20,\"maxAssistants\":20}')", [fixed.workspaceId]);
    const session: AppSession = { authenticated: true, source: "database", userId: owner, workspaceId: fixed.workspaceId, workspaceName: "SYNTHETIC", name: "SYNTHETIC", email: "admin@example.invalid", role: "admin", productRole: "novalureAdmin", permissions: getRolePermissions("admin"), productPermissions: getProductRoleCapabilities("novalureAdmin") };
    const options: TenantTransactionOptions = { pool: db.pool as unknown as NonNullable<TenantTransactionOptions["pool"]> };
    const area = await createKnowledgeArea(session, { name: "SYNTHETIC published area", kind: "project", projectId: fixed.crmProjectId }, options);
    const source = await createKnowledgeSource(session, { areaId: area.id, type: "manual", name: "SYNTHETIC company source", content: "studioanchor Published service is web design." }, options);
    await publishKnowledgeSource(session, { sourceId: source.id, versionId: source.draftVersionId!, expectedVersion: source.revision }, options);
    await assignKnowledgeAreas(session, { botId: fixed.botId, channel: "webchat", areaIds: [area.id] }, options);
    await db.admin.query("insert into external_integrations(id,public_site_key,workspace_id,project_id,integration_type,status,mode,allowed_origins,capabilities,configuration,created_by) values($1,$2,$3,$4,'website_chat','active','real_customer',array[$5],array['chat.start','chat.context','chat.message'],$6::jsonb,$7)", [fixed.integrationId, fixed.publicSiteKey, fixed.workspaceId, fixed.crmProjectId, fixed.publicOrigin, JSON.stringify({ knowledgeAssistantId: fixed.botId }), owner]);
    await db.admin.query("insert into external_integration_widget_configs(integration_id,workspace_id,chat_enabled,enabled_capabilities) values($1,$2,true,array['chat.start','chat.context'])", [fixed.integrationId, fixed.workspaceId]);
    await db.admin.query("insert into external_chat_sessions(id,integration_id,workspace_id,project_id,session_token_hash,idempotency_hash,mode,language,synthetic) values($1,$2,$3,$4,$5,$6,'real_customer','en',true)", [visitor, fixed.integrationId, fixed.workspaceId, fixed.crmProjectId, createHash("sha256").update(sessionToken).digest("hex"), createHash("sha256").update(randomUUID()).digest("hex")]);
    await db.admin.query("insert into behavior_runtime_bindings(workspace_id,broker_actor_id,actor_id,bot_id,department,token_hash,enabled,expires_at) values($1,$2,$3,$4,'support',$5,true,now()+interval '1 hour')", [fixed.workspaceId, owner, actor, fixed.botId, createHash("sha256").update(capability).digest("hex")]);
    // Synthetic consumption fixture only, not a publisher admission.
    await db.admin.query("insert into behavior_releases values(1,$1,array['webchat']);", [behaviorRuleIds]);
    await db.admin.query("insert into behavior_release_head(singleton,version,revision) values(true,1,1)");
    for (const key of keys) delete process.env[key];
    Object.assign(process.env, { DATABASE_URL: `postgresql://${db.role}@127.0.0.1:${db.port}/postgres`, CRM_LOCAL_TEST_DATABASE: "1", NODE_ENV: "test", NOVALURE_ABUSE_SECRET: "synthetic-studio-abuse-secret-at-least-32", NOVALURE_TRUSTED_CLIENT_IP_HEADER: "x-test-client-ip" });
    const nativeEnv = { NODE_ENV: "test" as const, VERCEL_ENV: "production", NOVALURE_SHARED_STUDIO_RUNTIME_ENABLED: "1", NOVALURE_SHARED_NATIVE_METHODS_ENABLED: "1", NOVALURE_SHARED_NATIVE_SIGNALS_ENABLED: "1", NOVALURE_SHARED_NATIVE_SIGNAL_BINDINGS: JSON.stringify({ version: 1, bindings: [{ workspaceId: fixed.workspaceId, projectId: fixed.crmProjectId, integrationId: fixed.integrationId, botId: fixed.botId, brokerActorId: owner, actorId: actor, capability }] }) };
    const { publicKey, privateKey } = await generateKeyPair("RS256"), publicJwk = await exportJWK(publicKey);
    const resolver = createLocalJWKSet({ keys: [{ ...publicJwk, kid: "synthetic-studio", alg: "RS256", use: "sig" }] });
    const now = Math.floor(Date.now() / 1000), claims = { aud: fixed.audience, iss: fixed.issuer, sub: fixed.subject, project_id: fixed.projectId, project: fixed.project, owner_id: fixed.ownerId, owner: fixed.owner, environment: "production", jti: randomUUID(), iat: now - 1, nbf: now - 1, exp: now + 300 };
    const sign = (changes: Record<string, unknown> = {}) => new SignJWT({ ...claims, ...changes }).setProtectedHeader({ alg: "RS256", kid: "synthetic-studio", typ: "JWT" }).sign(privateKey);
    const token = await sign(), http = { ...options, nativeBehaviorEnv: nativeEnv, studioAuth: { env: nativeEnv, keyResolver: resolver } };
    const signal = (value: unknown, bearer = token, cap = capability, extra: Record<string, string> = {}) => new Request("https://crm.example.invalid/api/integrations/evelyn/runtime/signal", { method: "POST", headers: { authorization: `Bearer ${bearer}`, "x-evelyn-runtime-token": cap, "content-type": "application/json", ...extra }, body: JSON.stringify(value) });
    const signalCount = async () => Number((await db.admin.query("select count(*) from behavior_learning_signals")).rows[0].count);
    const knowledge = (value: unknown, check = false, headers: Record<string, string> = {}) => new Request("https://crm.example.invalid/api/public/integrations/chat/knowledge", { method: "POST", headers: { origin: fixed.publicOrigin, "x-novalure-site-key": fixed.publicSiteKey, "x-novalure-session-token": sessionToken, "x-test-client-ip": "203.0.113.51", "content-type": "application/json", ...(check ? { "x-novalure-knowledge-check": "v1" } : { "x-novalure-shared-behavior": "v1" }), ...headers }, body: JSON.stringify(value) });
    let fingerprint = "";
    await t.test("actual existing knowledge handler returns fixed methods and checks all source/version grants without a second quota charge", async () => {
      const result = await handleExternalAssistantKnowledgeRequest(knowledge({ sessionId: visitor, query: "studioanchor", maxResults: 5 }), { ...options, nativeBehaviorEnv: nativeEnv });
      assert.equal(result.status, 200); const context = await result.json(); fingerprint = context.behavior.fingerprint;
      assert.equal(context.behavior.version, 1); assert.match(context.behavior.instruction, /When the goal is ambiguous/); assert.equal(context.excerpts.length, 1);
      const before = (await db.admin.query("select sum(query_count)::int as queries from knowledge_query_usage")).rows[0].queries;
      const body = { sessionId: visitor, sourceVersions: [{ sourceId: source.id, versionId: source.draftVersionId }], behaviorFingerprint: fingerprint };
      const checked = await handleExternalAssistantKnowledgeRequest(knowledge(body, true), { ...options, nativeBehaviorEnv: nativeEnv });
      assert.deepEqual(await checked.json(), { contractVersion: "knowledge-check-v1", current: true });
      assert.equal((await db.admin.query("select sum(query_count)::int as queries from knowledge_query_usage")).rows[0].queries, before);
      const wrong = await handleExternalAssistantKnowledgeRequest(knowledge({ ...body, behaviorFingerprint: "0".repeat(64) }, true), { ...options, nativeBehaviorEnv: nativeEnv });
      assert.equal((await wrong.json()).current, false);
      const extra = await handleExternalAssistantKnowledgeRequest(knowledge({ ...body, transcript: "SYNTHETIC PRIVATE" }, true), { ...options, nativeBehaviorEnv: nativeEnv }); assert.equal(extra.status, 400);
      await db.admin.query("delete from knowledge_area_grants where bot_id=$1", [fixed.botId]);
      const revoked = await handleExternalAssistantKnowledgeRequest(knowledge(body, true), { ...options, nativeBehaviorEnv: nativeEnv }); assert.equal((await revoked.json()).current, false);
      await assignKnowledgeAreas(session, { botId: fixed.botId, channel: "webchat", areaIds: [area.id] }, options);
      // A JSON string is not the boolean entitlement accepted by retrieval.
      await db.admin.query("update knowledge_center_entitlements set features=jsonb_set(features,'{webchatAccess}',$2::jsonb) where workspace_id=$1", [fixed.workspaceId, JSON.stringify("true")]);
      const featureRevoked = await handleExternalAssistantKnowledgeRequest(knowledge(body, true), { ...options, nativeBehaviorEnv: nativeEnv }); assert.equal((await featureRevoked.json()).current, false);
      const normalDenied = await handleExternalAssistantKnowledgeRequest(knowledge({ sessionId: visitor, query: "studioanchor", maxResults: 5 }), { ...options, nativeBehaviorEnv: nativeEnv }); assert.equal((await normalDenied.json()).answerStatus, "insufficient_knowledge");
      assert.equal((await db.admin.query("select sum(query_count)::int as queries from knowledge_query_usage")).rows[0].queries, before);
      await db.admin.query("update knowledge_center_entitlements set features=jsonb_set(features,'{webchatAccess}','true'::jsonb) where workspace_id=$1", [fixed.workspaceId]);
      await db.admin.query("update behavior_release_head set version=null,revision=revision+1");
      const methodsRevoked = await handleExternalAssistantKnowledgeRequest(knowledge(body, true), { ...options, nativeBehaviorEnv: nativeEnv }); assert.equal((await methodsRevoked.json()).current, false);
      await db.admin.query("update behavior_release_head set version=1,revision=revision+1");
      await db.admin.query("update external_chat_sessions set status='closed' where id=$1", [visitor]);
      const sessionRevoked = await handleExternalAssistantKnowledgeRequest(knowledge(body, true), { ...options, nativeBehaviorEnv: nativeEnv }); assert.equal(sessionRevoked.status, 403); assert.deepEqual(await sessionRevoked.json(), { error: "session_denied" });
      await db.admin.query("update external_chat_sessions set status='active' where id=$1", [visitor]);
    });
    await t.test("real RS256 requires exact native project/owner/environment/audience and a UUIDv4 JTI", async () => {
      assert.equal((await verifyStudioRuntimeToken(token, http.studioAuth)).projectId, fixed.projectId);
      for (const change of [{ project_id: "prj_foreign" }, { project: "evelyn" }, { owner_id: "team_foreign" }, { environment: "preview" }, { aud: "urn:novalure:crm:production" }, { sub: "owner:novalure:project:evelyn:environment:production" }, { jti: undefined }, { jti: "invalid" }, { custom_environment_id: "env_foreign" }, { exp: now - 1 }, { exp: now + 13 * 3600 }]) await assert.rejects(verifyStudioRuntimeToken(await sign(change), http.studioAuth));
      await assert.rejects(verifyStudioRuntimeToken(token, { ...http.studioAuth, env: { ...nativeEnv, NOVALURE_SHARED_STUDIO_RUNTIME_ENABLED: "0" } }));
    });
    await t.test("actual reused signal handler writes only its private assistant actor, preserves event idempotency and cannot read context", async () => {
      const eventId = randomUUID(), value = { eventId, issue: "unclear_next_step", outcome: "pass" };
      const response = await handleEvelynRuntimeRequest(signal(value), "signal", http); assert.equal(response.status, 200); assert.deepEqual(await response.json(), { recorded: true, replayed: false });
      const replay = await handleEvelynRuntimeRequest(signal(value), "signal", http); assert.deepEqual(await replay.json(), { recorded: true, replayed: true }); assert.equal(await signalCount(), 1);
      const conflict = await handleEvelynRuntimeRequest(signal({ ...value, outcome: "fail" }), "signal", http); assert.equal(conflict.status, 409); assert.equal(await signalCount(), 1);
      assert.notEqual((await handleEvelynRuntimeRequest(signal({ query: "studioanchor" }), "context", http)).status, 200);
      for (const request of [signal({ ...value, transcript: "PRIVATE" }), signal({ ...value, issue: "unclear_goal" }), signal(value, token, randomBytes(32).toString("base64url")), signal(value, token, capability, { origin: fixed.publicOrigin }), signal(value, token, capability, { cookie: "owner=forged" })]) assert.notEqual((await handleEvelynRuntimeRequest(request, "signal", http)).status, 200);
      assert.equal((await withCrmRead(session, tx => tx.query("select * from behavior_learning_signals"), options)).length, 0);
      const privateSession: AppSession = { ...session, userId: actor, role: "agent", productRole: "novalure_operator" };
      const rows = await withCrmRead(privateSession, tx => tx.query("select actor_id,event_id,issue,outcome from behavior_learning_signals"), options); assert.equal(rows.length, 1); assert.equal(rows[0].event_id, eventId); assert.equal(rows[0].actor_id, actor);
      assert.equal((await withCrmRead(privateSession, tx => tx.query("select id from knowledge_sources"), options)).length, 0);
      await db.admin.query("update behavior_runtime_bindings set expires_at=now()-interval '1 second'");
      const expired = await handleEvelynRuntimeRequest(signal({ ...value, eventId: randomUUID() }), "signal", http); assert.equal(expired.status, 403); assert.equal(await signalCount(), 1);
      await db.admin.query("update behavior_runtime_bindings set expires_at=now()+interval '1 hour'");
      await db.admin.query("update external_integrations set status='disabled' where id=$1", [fixed.integrationId]);
      const revoked = await handleEvelynRuntimeRequest(signal({ ...value, eventId: randomUUID() }), "signal", http); assert.equal(revoked.status, 409); assert.equal((await revoked.json()).authorityCurrent, false); assert.equal(await signalCount(), 1);
    });
  } finally { await closeLocalTestPool(); await db.stop(); const writableEnv: Record<string, string | undefined> = process.env; for (const key of keys) { if (prior[key] === undefined) delete writableEnv[key]; else writableEnv[key] = prior[key]; } }
});
