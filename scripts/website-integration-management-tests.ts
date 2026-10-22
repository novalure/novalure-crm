import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { AppSession } from "../src/lib/auth/session";
import { withCrmRead } from "../src/lib/crm-command";
import type { TenantTransactionOptions } from "../src/lib/db/tenant-client";
import { closeLocalTestPool } from "../src/lib/db/local-test-transport";
import { createManagedWebsiteIntegration, listManagedWebsiteIntegrations, updateManagedWebsiteIntegration } from "../src/lib/integrations/website-integration-management";
import { assignKnowledgeAreas, createKnowledgeArea, createKnowledgeSource, knowledgeInternals, publishKnowledgeSource } from "../src/lib/knowledge-center/repository";
import { applySalesSchema, startLocalSalesDb } from "./lib/local-sales-db.mjs";
import { createCsrfToken } from "../src/lib/security/csrf-core";

const errorCode = (code: string) => (error: unknown) => (error as { code?: string }).code === code;

test("Website self-service uses saved tenant/project authority, atomic edits and published knowledge", { timeout: 180_000 }, async t => {
  const db = await startLocalSalesDb();
  const options: TenantTransactionOptions = { pool: db.pool as unknown as NonNullable<TenantTransactionOptions["pool"]> };
  const ids = { workspace: randomUUID(), foreignWorkspace: randomUUID(), owner: randomUUID(), foreignOwner: randomUUID(),
    staleOwner: randomUUID(), project: randomUUID(), secondProject: randomUUID(), foreignProject: randomUUID(),
    bot: randomUUID(), secondProjectBot: randomUUID(), foreignBot: randomUUID(), unassignedBot: randomUUID(), form: randomUUID(), legacy: randomUUID() };
  const session = (foreign = false): AppSession => ({ authenticated: true, source: "database", role: "owner", productRole: "customer_owner",
    permissions: ["crm:read", "crm:write"], productPermissions: [], userId: foreign ? ids.foreignOwner : ids.owner,
    workspaceId: foreign ? ids.foreignWorkspace : ids.workspace, workspaceName: "SYNTHETIC Website tenant", name: "SYNTHETIC owner", email: "synthetic@example.invalid" });
  const owner = session(), foreign = session(true);
  try {
    await applySalesSchema(db);
    // Dedicated loopback gateway predecessor, matching external-integration-gateway-tests.
    // The production-pinned 094 service actor is deliberately not provisioned here.
    await db.admin.query("insert into novalure_schema_migrations(version,name,checksum) values('094_website_sales_ingestion','094_website_sales_ingestion.sql','synthetic-prerequisite')");
    await db.admin.query(await readFile("migrations/095_form_tenant_isolation.sql", "utf8"));
    await db.admin.query("insert into novalure_schema_migrations(version,name,checksum) values('095_form_tenant_isolation','095_form_tenant_isolation.sql','synthetic-prerequisite')");
    await db.admin.query(await readFile("migrations/096_public_integration_gateway.sql", "utf8"));
    await db.admin.query(`insert into workspaces(id,name,operating_model) values($1,'SYNTHETIC customer','self_service_customer'),($2,'SYNTHETIC foreign','self_service_customer')`, [ids.workspace, ids.foreignWorkspace]);
    await db.admin.query(`insert into workspace_users(id,workspace_id,name,email,role,product_role,status) values
      ($1,$2,'SYNTHETIC owner','owner@example.invalid','owner','customer_owner','active'),
      ($3,$4,'SYNTHETIC foreign','foreign@example.invalid','owner','customer_owner','active'),
      ($5,$2,'SYNTHETIC downgraded','stale@example.invalid','agent','project_sales_member','active')`, [ids.owner, ids.workspace, ids.foreignOwner, ids.foreignWorkspace, ids.staleOwner]);
    await db.admin.query(`insert into projects(id,workspace_id,name,type) values($1,$4,'SYNTHETIC project','Bauträger'),($2,$4,'SYNTHETIC second','Bauträger'),($3,$5,'SYNTHETIC foreign','Bauträger')`, [ids.project, ids.secondProject, ids.foreignProject, ids.workspace, ids.foreignWorkspace]);
    await db.admin.query(`insert into bots(id,workspace_id,project_id,name,role) values($1,$5,$6,'SYNTHETIC ready','Support'),($2,$5,$7,'SYNTHETIC other project','Support'),($3,$8,$9,'SYNTHETIC foreign','Support'),($4,$5,$6,'SYNTHETIC unassigned','Support')`, [ids.bot, ids.secondProjectBot, ids.foreignBot, ids.unassignedBot, ids.workspace, ids.project, ids.secondProject, ids.foreignWorkspace, ids.foreignProject]);
    for (const workspace of [ids.workspace, ids.foreignWorkspace]) await db.admin.query(`insert into knowledge_center_entitlements(workspace_id,enabled,max_sources,max_storage_bytes,max_queries_per_month,contract_reference,features,limits)
      values($1,true,20,2000000,100,'SYNTHETIC-NOT-A-COMMERCIAL-CONTRACT','{"webchatAccess":true}',
      '{"maxAreas":10,"maxWebsites":10,"maxScansPerMonth":1,"maxUsers":10,"maxAssistants":1}')`, [workspace]);
    const area = await createKnowledgeArea(owner, { name: "SYNTHETIC approved FAQ", kind: "company" }, options);
    const source = await createKnowledgeSource(owner, { areaId: area.id, name: "SYNTHETIC opening hours", type: "manual", content: "SYNTHETIC office opens at 09:00." }, options);
    await assignKnowledgeAreas(owner, { botId: ids.bot, channel: "webchat", areaIds: [area.id] }, options);
    const create = { projectId: ids.project, knowledgeAssistantId: ids.bot, allowedOrigins: ["https://customer.example"], mode: "training" };
    await t.test("unpublished and mismatched assistants never create a runnable connection", async () => {
      await assert.rejects(createManagedWebsiteIntegration(owner, create, options), errorCode("PUBLISHED_KNOWLEDGE_REQUIRED"));
      await assert.rejects(createManagedWebsiteIntegration(owner, { ...create, knowledgeAssistantId: ids.foreignBot }, options), errorCode("ASSISTANT_SCOPE_MISMATCH"));
      await assert.rejects(createManagedWebsiteIntegration(owner, { ...create, knowledgeAssistantId: ids.secondProjectBot }, options), errorCode("ASSISTANT_SCOPE_MISMATCH"));
      await assert.rejects(createManagedWebsiteIntegration(owner, { ...create, knowledgeAssistantId: ids.unassignedBot }, options), errorCode("PUBLISHED_KNOWLEDGE_REQUIRED"));
      assert.equal((await db.admin.query("select count(*)::int as count from external_integrations")).rows[0].count, 0);
    });
    await publishKnowledgeSource(owner, { sourceId: source.id, versionId: source.draftVersionId!, expectedVersion: source.revision }, options);
    let created = await createManagedWebsiteIntegration(owner, create, options);
    await t.test("a saved binding is immediately usable on its allowed origin without another deployment or assistant slot", async () => {
      assert.equal(created.status, "test"); assert.equal(created.knowledgeAssistantId, ids.bot);
      assert.equal(created.readiness.ready, true); assert.equal(created.readiness.publishedSources, 1);
      assert.equal("configuration" in created, false); assert.equal(created.widget.chatEnabled, true);
      const resolved = await db.pool.query("select workspace_id,project_id,configuration from crm_external_integration_resolve($1,$2,'chat.context',null)", [created.publicSiteKey, "https://customer.example"]);
      assert.equal(resolved.rows[0].workspace_id, ids.workspace); assert.equal(resolved.rows[0].configuration.knowledgeAssistantId, ids.bot);
      assert.equal((await db.pool.query("select * from crm_external_integration_resolve($1,$2,'chat.context',null)", [created.publicSiteKey, "https://attacker.example"])).rowCount, 0);
      const another = await createManagedWebsiteIntegration(owner, { ...create, allowedOrigins: ["https://second.example"] }, options);
      assert.notEqual(another.id, created.id);
      assert.equal((await db.admin.query("select count(distinct bot_id)::int as count from knowledge_area_grants where workspace_id=$1", [ids.workspace])).rows[0].count, 1);
    });
    await t.test("current membership, tenant ownership and strict inputs beat forged or stale client authority", async () => {
      await assert.rejects(listManagedWebsiteIntegrations({ ...owner, userId: ids.staleOwner }, options), errorCode("FORBIDDEN"));
      await assert.rejects(updateManagedWebsiteIntegration(foreign, { integrationId: created.id, expectedUpdatedAt: created.updatedAt, status: "disabled" }, options), errorCode("NOT_FOUND"));
      assert.equal((await listManagedWebsiteIntegrations(foreign, options)).integrations.length, 0);
      for (const patch of [{ workspaceId: ids.foreignWorkspace }, { configuration: { knowledgeAssistantId: ids.foreignBot } }, { capabilities: ["lead.create"] }]) {
        await assert.rejects(updateManagedWebsiteIntegration(owner, { integrationId: created.id, expectedUpdatedAt: created.updatedAt, ...patch }, options), errorCode("UNKNOWN_FIELD"));
      }
      for (const invalid of ["http://customer.example", "https://*.example", "https://customer.example/path", "https://name:password@customer.example"]) {
        await assert.rejects(createManagedWebsiteIntegration(owner, { ...create, allowedOrigins: [invalid] }, options), errorCode("VALIDATION_ERROR"));
      }
      await assert.rejects(createManagedWebsiteIntegration(owner, { ...create, widget: { chatEnabled: true } }, options), errorCode("UNKNOWN_FIELD"));
    });
    await t.test("concurrent edits accept one exact version and a domain change closes the old origin", async () => {
      const attempts = await Promise.allSettled([
        updateManagedWebsiteIntegration(owner, { integrationId: created.id, expectedUpdatedAt: created.updatedAt, allowedOrigins: ["https://new-a.example"] }, options),
        updateManagedWebsiteIntegration(owner, { integrationId: created.id, expectedUpdatedAt: created.updatedAt, allowedOrigins: ["https://new-b.example"] }, options),
      ]);
      assert.equal(attempts.filter(item => item.status === "fulfilled").length, 1);
      const rejected = attempts.find(item => item.status === "rejected") as PromiseRejectedResult;
      assert.equal(rejected.reason.code, "CONFLICT");
      created = (attempts.find(item => item.status === "fulfilled") as PromiseFulfilledResult<typeof created>).value;
      assert.equal((await db.pool.query("select * from crm_external_integration_resolve($1,$2,'chat.context',null)", [created.publicSiteKey, "https://customer.example"])).rowCount, 0);
      assert.equal((await db.pool.query("select * from crm_external_integration_resolve($1,$2,'chat.context',null)", [created.publicSiteKey, created.allowedOrigins[0]])).rowCount, 1);
    });
    await t.test("an edit waiting for a visitor integration lock cannot deadlock the visitor knowledge query", async () => {
      let shared!: () => void, continueReader!: () => void;
      const readerHasIntegration = new Promise<void>(resolve => { shared = resolve; });
      const readerMayReadKnowledge = new Promise<void>(resolve => { continueReader = resolve; });
      const reader = withCrmRead(owner, async (tx, fresh) => {
        await tx.query("select * from public.crm_external_integration_resolve($1,$2,'chat.context',null)", [created.publicSiteKey, created.allowedOrigins[0]]);
        shared(); await readerMayReadKnowledge;
        await knowledgeInternals.lock(tx, fresh);
        return true;
      }, { ...options, statementTimeoutMs: 2_000 });
      await readerHasIntegration;
      const updater = updateManagedWebsiteIntegration(owner, { integrationId: created.id, expectedUpdatedAt: created.updatedAt, widget: { welcomeMessage: "SYNTHETIC concurrent editor" } }, { ...options, statementTimeoutMs: 2_000 });
      const both = Promise.all([reader, updater]);
      let waiting = false;
      try {
        for (let attempt = 0; attempt < 100 && !waiting; attempt++) {
          // PostgreSQL truncates pg_stat_activity.query at 1024 bytes, before
          // this SELECT's FOR UPDATE suffix. The isolated runtime has only
          // this reader and updater, so its active lock wait identifies it.
          waiting = (await db.admin.query(`select exists(select 1 from pg_stat_activity where wait_event_type='Lock'
            and state='active' and usename=$1) as waiting`, [db.role])).rows[0].waiting;
          if (!waiting) await delay(10);
        }
      } finally { continueReader(); }
      const [readSucceeded, saved] = await both;
      assert.equal(readSucceeded, true); created = saved;
      assert.equal(waiting, true, "The updater must reach the locked integration before the reader continues");
      assert.equal(created.widget.welcomeMessage, "SYNTHETIC concurrent editor");
    });
    await t.test("editing the existing Studio form/lead binding preserves its key, form, capabilities and private configuration", async () => {
      await db.admin.query(`insert into forms(id,workspace_id,project_id,owner_user_id,name,slug,status,fields,actions)
        values($1,$2,$3,$4,'SYNTHETIC form','synthetic-studio','aktiv','[]','{}')`, [ids.form, ids.workspace, ids.project, ids.owner]);
      const legacyKey = `nov_pk_${randomUUID().replaceAll("-", "")}`;
      await db.admin.query(`insert into external_integrations(id,public_site_key,workspace_id,project_id,form_id,integration_type,status,mode,allowed_origins,capabilities,configuration)
        values($1,$2,$3,$4,$5,'novalure_studio','test','training',array['https://studio.example'],array['form.read','form.submit','lead.create'],'{"legacyCompatibility":false,"privateServerConfiguration":"SYNTHETIC-DO-NOT-RETURN"}')`, [ids.legacy, legacyKey, ids.workspace, ids.project, ids.form]);
      await db.admin.query(`insert into external_integration_widget_configs(integration_id,workspace_id,brand_name,lead_capture_enabled,enabled_capabilities)
        values($1,$2,'SYNTHETIC Studio',true,array['form.read','form.submit','lead.create'])`, [ids.legacy, ids.workspace]);
      const before = (await listManagedWebsiteIntegrations(owner, options)).integrations.find(item => item.id === ids.legacy)!;
      assert.equal(before.readiness.ready, false); assert.equal(JSON.stringify(before).includes("SYNTHETIC-DO-NOT-RETURN"), false);
      const bound = await updateManagedWebsiteIntegration(owner, { integrationId: ids.legacy, expectedUpdatedAt: before.updatedAt, knowledgeAssistantId: ids.bot }, options);
      assert.equal(bound.id, ids.legacy); assert.equal(bound.publicSiteKey, legacyKey); assert.equal(bound.formId, ids.form);
      assert.equal(bound.integrationType, "novalure_studio"); assert.equal(bound.widget.brandName, "SYNTHETIC Studio"); assert.equal(bound.widget.leadCaptureEnabled, true);
      assert.deepEqual(new Set(bound.capabilities), new Set(["form.read", "form.submit", "lead.create", "chat.start", "chat.context", "chat.message"]));
      assert.equal((await db.admin.query("select configuration from external_integrations where id=$1", [ids.legacy])).rows[0].configuration.privateServerConfiguration, "SYNTHETIC-DO-NOT-RETURN");
      const unbound = await updateManagedWebsiteIntegration(owner, { integrationId: ids.legacy, expectedUpdatedAt: bound.updatedAt, knowledgeAssistantId: null }, options);
      assert.equal(unbound.status, "test"); assert.equal(unbound.widget.chatEnabled, false); assert.equal(unbound.widget.leadCaptureEnabled, true);
      assert.deepEqual(unbound.capabilities, ["form.read", "form.submit", "lead.create"]);
      assert.equal((await db.pool.query("select * from crm_external_integration_resolve($1,$2,'form.read',null)", [legacyKey, "https://studio.example"])).rowCount, 1);
      assert.equal((await db.pool.query("select * from crm_external_integration_resolve($1,$2,'chat.context',null)", [legacyKey, "https://studio.example"])).rowCount, 0);
      const rebound = await updateManagedWebsiteIntegration(owner, { integrationId: ids.legacy, expectedUpdatedAt: unbound.updatedAt, knowledgeAssistantId: ids.bot }, options);
      await db.admin.query("update forms set status='entwurf' where id=$1", [ids.form]);
      await assert.rejects(updateManagedWebsiteIntegration(owner, { integrationId: ids.legacy, expectedUpdatedAt: rebound.updatedAt, status: "active" }, options), errorCode("PUBLISHED_FORM_REQUIRED"));
      const detachedDraft = await updateManagedWebsiteIntegration(owner, { integrationId: ids.legacy, expectedUpdatedAt: rebound.updatedAt,
        knowledgeAssistantId: null, mode: rebound.mode, status: rebound.status, allowedOrigins: rebound.allowedOrigins,
        widget: { brandName: rebound.widget.brandName, welcomeMessage: rebound.widget.welcomeMessage } }, options);
      assert.equal(detachedDraft.knowledgeAssistantId, null); assert.equal(detachedDraft.formId, ids.form);
      assert.equal(detachedDraft.widget.chatEnabled, false); assert.equal(detachedDraft.widget.leadCaptureEnabled, true);
      assert.deepEqual(detachedDraft.capabilities, ["form.read", "form.submit", "lead.create"]);
      await assert.rejects(updateManagedWebsiteIntegration(owner, { integrationId: ids.legacy, expectedUpdatedAt: detachedDraft.updatedAt, status: "active" }, options), errorCode("PUBLISHED_FORM_REQUIRED"));
    });
    await t.test("contract loss blocks further use but never blocks pause, detach or revoke", async () => {
      await db.admin.query("update knowledge_center_entitlements set enabled=false where workspace_id=$1", [ids.workspace]);
      assert.equal((await listManagedWebsiteIntegrations(owner, options)).integrations.find(item => item.id === created.id)!.readiness.code, "ENTITLEMENT_REQUIRED");
      await assert.rejects(updateManagedWebsiteIntegration(owner, { integrationId: created.id, expectedUpdatedAt: created.updatedAt, status: "active", mode: "real_customer" }, options), errorCode("ENTITLEMENT_REQUIRED"));
      created = await updateManagedWebsiteIntegration(owner, { integrationId: created.id, expectedUpdatedAt: created.updatedAt, status: "disabled" }, options);
      assert.equal(created.status, "disabled");
      assert.equal((await db.pool.query("select * from crm_external_integration_resolve($1,$2,'chat.context',null)", [created.publicSiteKey, created.allowedOrigins[0]])).rowCount, 0);
      created = await updateManagedWebsiteIntegration(owner, { integrationId: created.id, expectedUpdatedAt: created.updatedAt, knowledgeAssistantId: null }, options);
      assert.equal(created.knowledgeAssistantId, null); assert.deepEqual(created.capabilities, []); assert.equal(created.widget.chatEnabled, false);
      await assert.rejects(updateManagedWebsiteIntegration(owner, { integrationId: created.id, expectedUpdatedAt: created.updatedAt, status: "active" }, options), errorCode("ASSISTANT_REQUIRED"));
      created = await updateManagedWebsiteIntegration(owner, { integrationId: created.id, expectedUpdatedAt: created.updatedAt, status: "revoked" }, options);
      assert.equal(created.status, "revoked");
      await assert.rejects(updateManagedWebsiteIntegration(owner, { integrationId: created.id, expectedUpdatedAt: created.updatedAt, status: "active" }, options), errorCode("INTEGRATION_REVOKED"));
    });
    await t.test("successful changes are audited without exposing private configuration", async () => {
      const logs = await db.admin.query("select before,after from audit_logs where workspace_id=$1 and action like 'website.integration.%'", [ids.workspace]);
      assert.ok(logs.rows.length >= 8);
      assert.equal(JSON.stringify(logs.rows).includes("SYNTHETIC-DO-NOT-RETURN"), false);
      assert.ok(logs.rows.some(row => row.before?.knowledgeAssistantId === ids.bot && row.after?.knowledgeAssistantId === null));
      const flags = await db.admin.query("select relforcerowsecurity,relrowsecurity from pg_class where relname in ('external_integrations','external_integration_widget_configs')");
      assert.equal(flags.rows.length, 2); assert.ok(flags.rows.every(row => row.relforcerowsecurity && row.relrowsecurity));
    });
    await t.test("HTTP boundary requires a durable cookie, CSRF and authorized workspace selection", async () => {
      const keys = ["DATABASE_URL", "NODE_ENV", "CRM_LOCAL_TEST_DATABASE", "NOVALURE_SESSION_SECRET", "NOVALURE_APP_ORIGIN", "NOVALURE_AUTH_STRICT", "NOVALURE_AUTH_ENCRYPTION_KEY", "NOVALURE_AUTH_RATE_LIMIT_SECRET", "NOVALURE_DEMO_AUTH_ENABLED", "NOVALURE_TRUST_AUTH_HEADERS", "VERCEL", "VERCEL_ENV", "VERCEL_URL"];
      const original = Object.fromEntries(keys.map(key => [key, process.env[key]]));
      const secret = randomBytes(48).toString("base64url"), cookie = "v2." + randomBytes(32).toString("base64url"), sessionId = randomUUID();
      const appOrigin = "http://127.0.0.1:3000", pathname = "/api/integrations/websites";
      try {
        for (const key of keys) delete process.env[key];
        Object.assign(process.env, { DATABASE_URL: `postgresql://${db.role}@127.0.0.1:${db.port}/postgres`, NODE_ENV: "test", CRM_LOCAL_TEST_DATABASE: "1",
          NOVALURE_SESSION_SECRET: secret, NOVALURE_APP_ORIGIN: appOrigin, NOVALURE_AUTH_STRICT: "1",
          NOVALURE_AUTH_ENCRYPTION_KEY: randomBytes(40).toString("hex"), NOVALURE_AUTH_RATE_LIMIT_SECRET: randomBytes(40).toString("hex") });
        const identity = (await db.admin.query("select auth_identity_id from workspace_users where id=$1", [ids.owner])).rows[0].auth_identity_id;
        await db.admin.query("update auth_identities set credential_state='active' where id=$1", [identity]);
        await db.admin.query("insert into auth_sessions(id,token_hash,auth_identity_id,workspace_user_id,workspace_id,mfa_verified_at,expires_at) values($1,$2,$3,$4,$5,now(),now()+interval '1 hour')", [sessionId, createHash("sha256").update(cookie).digest("hex"), identity, ids.owner, ids.workspace]);
        await db.admin.query(`grant select on auth_identities to ${db.role}`);
        await db.admin.query(`grant update(last_seen_at) on auth_sessions to ${db.role}`);
        await db.admin.query(`grant select,insert,delete on csrf_token_consumptions to ${db.role}`);
        const handlers = await import("../src/app/api/integrations/websites/route");
        const request = (method = "GET", body?: unknown, query = "", overrides: Record<string, string> = {}) => new Request(appOrigin + pathname + query, {
          method, headers: { cookie: "novalure_session=" + cookie, ...(body === undefined ? {} : { "content-type": "application/json" }),
            ...(method === "GET" ? {} : { origin: appOrigin, "sec-fetch-site": "same-origin", "x-novalure-csrf-token": createCsrfToken({ method, pathname, secret, sessionCookie: cookie })!.token }), ...overrides },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        assert.equal((await handlers.GET(new Request(appOrigin + pathname))).status, 401);
        assert.equal((await handlers.GET(request("GET", undefined, "", { cookie: `novalure_session=${cookie}; novalure_session=${cookie}` }))).status, 401);
        const listing = await handlers.GET(request());
        assert.equal(listing.status, 200, await listing.clone().text());
        assert.equal(listing.headers.get("cache-control"), "private, no-store");
        assert.equal(JSON.stringify(await listing.json()).includes("SYNTHETIC-DO-NOT-RETURN"), false);
        assert.equal((await handlers.GET(request("GET", undefined, `?workspaceId=${ids.foreignWorkspace}`))).status, 403);
        assert.equal((await handlers.GET(request("GET", undefined, `?workspaceId=${ids.workspace}&workspaceId=${ids.workspace}`))).status, 400);
        const pause = { integrationId: created.id, expectedUpdatedAt: created.updatedAt, status: "revoked" };
        assert.equal((await handlers.PATCH(request("PATCH", pause, "", { "x-novalure-csrf-token": "" }))).status, 403);
        assert.equal((await handlers.PATCH(request("PATCH", { ...pause, configuration: {} }))).status, 400);
        const safePause = await handlers.PATCH(request("PATCH", pause));
        assert.equal(safePause.status, 200, await safePause.clone().text());
        await db.admin.query("update auth_sessions set revoked_at=now(),revoked_reason='SYNTHETIC HTTP test' where id=$1", [sessionId]);
        assert.equal((await handlers.GET(request())).status, 401);
      } finally {
        await closeLocalTestPool();
        for (const key of keys) { if (original[key] === undefined) delete process.env[key]; else process.env[key] = original[key]; }
      }
    });
  } finally { await db.stop(); }
});
