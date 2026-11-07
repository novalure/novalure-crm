import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { test } from "node:test";
import { MockLanguageModelV4 } from "ai/test";
import type { AppSession } from "../src/lib/auth/session";
import { getRolePermissions } from "../src/lib/auth/permissions";
import { getProductRoleCapabilities, type ProductRole } from "../src/lib/product-model";
import { provisionCustomerWorkspace } from "../src/lib/customer-workspace-provisioning";
import { withCrmRead } from "../src/lib/crm-command";
import { CRM_MACHINE_WORKSPACE_ID } from "../src/lib/crm-machine-auth";
import { closeLocalTestPool } from "../src/lib/db/local-test-transport";
import type { TenantTransactionOptions } from "../src/lib/db/tenant-client";
import { startExternalChatSession } from "../src/lib/db/external-integration-gateway";
import { createManagedWebsiteIntegration } from "../src/lib/integrations/website-integration-management";
import { assignKnowledgeAreas, createKnowledgeSource, publishKnowledgeSource } from "../src/lib/knowledge-center/repository";
import { answerWebsiteChat, handleWebsiteChatRequest } from "../src/lib/knowledge-center/website-chat";
import { applySalesSchema, LocalSalesPool, startLocalSalesDb } from "./lib/local-sales-db.mjs";

// This acceptance owns one disposable loopback database and uses synthetic models.
// Persisted synthetic MFA sessions exercise server authority; existing normal
// password/MFA and Package 3/4 restoration evidence retain their separate scope.
test("two synthetic Webchat customers complete setup, shared pause and one confirmed test-payment unlock", { timeout: 300_000 }, async t => {
  const db = await startLocalSalesDb();
  const options: TenantTransactionOptions = { pool: db.pool as unknown as NonNullable<TenantTransactionOptions["pool"]>, statementTimeoutMs: 15_000 };
  const names = ["DATABASE_URL", "CRM_LOCAL_TEST_DATABASE", "NODE_ENV", "VERCEL", "VERCEL_ENV", "VERCEL_URL",
    "NOVALURE_ABUSE_SECRET", "NOVALURE_TRUSTED_CLIENT_IP_HEADER", "NOVALURE_WEBCHAT_PRODUCT_ISOLATED_ENABLED",
    "NOVALURE_SHARED_NATIVE_METHODS_ENABLED", "NOVALURE_SHARED_NATIVE_SIGNALS_ENABLED", "NOVALURE_SHARED_NATIVE_SIGNAL_BINDINGS",
    "RESEND_API_KEY", "AI_GATEWAY_API_KEY", "VERCEL_AI_GATEWAY_API_KEY"] as const;
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  const originalFetch = globalThis.fetch;
  const internalWorkspace = randomUUID();
  const now = Math.floor(Date.now() / 1_000);
  const signatureSecret = "SYNTHETIC-WEBCHAT-WEBHOOK-SECRET-NOT-A-PROVIDER-CREDENTIAL";
  let paymentPool: InstanceType<typeof LocalSalesPool> | undefined;
  async function apply(name: string) {
    const sql = await readFile(`migrations/${name}`, "utf8");
    const client = await db.admin.connect();
    try {
      await client.query("begin");
      await client.query(sql);
      await client.query("insert into novalure_schema_migrations(version,name,checksum) values($1,$2,$3) on conflict(version) do nothing",
        [name.replace(/\.sql$/u, ""), name, createHash("sha256").update(sql).digest("hex")]);
      await client.query("commit");
    } catch (error) { await client.query("rollback"); throw error; }
    finally { client.release(); }
  }
  async function member(workspaceId: string, label: string, role: AppSession["role"], productRole: ProductRole): Promise<AppSession> {
    const id = randomUUID(), email = `synthetic-${label}-${id}@example.invalid`;
    await db.admin.query("insert into workspace_users(id,workspace_id,name,email,role,product_role,status) values($1,$2,$3,$4,$5,$6,'active')",
      [id, workspaceId, `SYNTHETIC ${label}`, email, role, productRole]);
    return session(workspaceId, id);
  }
  async function session(workspaceId: string, userId: string): Promise<AppSession> {
    const row = (await db.admin.query("select name,email,role,product_role,auth_identity_id from workspace_users where id=$1 and workspace_id=$2", [userId, workspaceId])).rows[0];
    const authSessionId = randomUUID();
    await db.admin.query("update auth_identities set credential_state='active',password_hash=$2,mfa_enabled_at=now(),mfa_secret_ciphertext='SYNTHETIC-LOCAL-ONLY' where id=$1",
      [row.auth_identity_id, `SYNTHETIC-NONLOGIN-PASSWORD-HASH-${userId}`]);
    await db.admin.query(`insert into auth_sessions(id,token_hash,auth_identity_id,workspace_user_id,workspace_id,mfa_verified_at,expires_at)
      values($1,$2,$3,$4,$5,now(),now()+interval '1 hour')`,
    [authSessionId, createHash("sha256").update(authSessionId).digest("hex"), row.auth_identity_id, userId, workspaceId]);
    return { authenticated: true, source: "database", userId, workspaceId, workspaceName: `SYNTHETIC ${workspaceId}`, name: row.name,
      email: row.email, role: row.role, productRole: row.product_role, permissions: getRolePermissions(row.role),
      productPermissions: getProductRoleCapabilities(row.product_role), authIdentityId: row.auth_identity_id, authSessionId,
      mfaEnabledAt: new Date().toISOString(), mfaVerifiedAt: new Date().toISOString() };
  }
  function model(label: string, during?: () => Promise<void>) {
    return new MockLanguageModelV4({ doGenerate: async () => {
      await during?.();
      return { content: [{ type: "text", text: JSON.stringify({ answerable: true, answer: `${label} office opens at 09:00.`, sourceIndices: [0] }) }],
        finishReason: { unified: "stop", raw: undefined }, usage: { inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 10, text: 10, reasoning: undefined } }, warnings: [] };
    } });
  }
  const code = (...values: string[]) => (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && values.includes(String(error.code)));
  function signed(event: Record<string, unknown>) {
    const rawBody = Buffer.from(JSON.stringify(event));
    return { rawBody, signature: `t=${now},v1=${createHmac("sha256", signatureSecret).update(`${now}.`).update(rawBody).digest("hex")}` };
  }
  try {
    for (const name of names) delete process.env[name];
    Object.assign(process.env, { DATABASE_URL: `postgresql://${db.role}@127.0.0.1:${db.port}/postgres`, CRM_LOCAL_TEST_DATABASE: "1", NODE_ENV: "test",
      NOVALURE_WEBCHAT_PRODUCT_ISOLATED_ENABLED: "1", NOVALURE_ABUSE_SECRET: "SYNTHETIC-LOCAL-WEBCHAT-ABUSE-SECRET-0001", NOVALURE_TRUSTED_CLIENT_IP_HEADER: "x-test-client-ip" });
    globalThis.fetch = async () => { throw new Error("Unexpected outbound network in isolated synthetic acceptance"); };
    // 092 verifies its actual historical 68-table RLS inventory. Apply that
    // original cutover before later Knowledge/booking tables, then advance.
    await applySalesSchema(db, { maxMigrationNumber: 90 });
    await db.admin.query("insert into workspaces(id,name,operating_model,customer_type) values($1,'SYNTHETIC internal predecessor','novalure_internal','novalure_internal'),($2,'SYNTHETIC provisioning','novalure_internal','novalure_internal') on conflict(id) do nothing",
      [CRM_MACHINE_WORKSPACE_ID, internalWorkspace]);
    await db.admin.query("alter table company_profiles enable row level security; alter table company_profiles force row level security; alter table company_profile_versions enable row level security; alter table company_profile_versions force row level security");
    await db.admin.query("do $$ declare r record; begin for r in select format('%I.%I',n.nspname,c.relname) as q from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','p') and c.relrowsecurity loop execute 'alter table '||r.q||' force row level security'; end loop; end $$");
    for (const name of ["092_crm_production_machine_identity.sql", "093_crm_machine_internal_context.sql", "094_website_sales_ingestion.sql",
      "095_form_tenant_isolation.sql", "096_public_integration_gateway.sql"]) await apply(name);
    for (const name of (await readdir("migrations")).filter(name => /^\d+.*\.sql$/u.test(name) && !name.includes("_rollback") && Number(name.slice(0, 3)) >= 101 && Number(name.slice(0, 3)) <= 110).sort()) await apply(name);
    for (const name of ["114_customer_workspace_provisioning.sql", "121_webchat_customer_product.sql"]) await apply(name);
    // The existing tenant login cannot call the payment application function.
    // Only this separate local fixture host receives that narrow capability.
    const paymentRole = `${db.role}_payment`;
    await db.admin.query(`create role ${paymentRole} login inherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls`);
    await db.admin.query(`grant novalure_tenant_app,novalure_webchat_payment_executor to ${paymentRole}`);
    paymentPool = new LocalSalesPool({ host: "127.0.0.1", port: db.port, user: paymentRole, database: "postgres", max: 4, connectionTimeoutMillis: 5_000 });
    const paymentOptions: TenantTransactionOptions = { ...options, pool: paymentPool as unknown as NonNullable<TenantTransactionOptions["pool"]> };
    type CustomerFixture = {
      label: string; admin: AppSession; employee: AppSession; leadId: string;
      source: Awaited<ReturnType<typeof publishKnowledgeSource>>;
      provisioned: Awaited<ReturnType<typeof provisionCustomerWorkspace>>;
      sites: { integration: Awaited<ReturnType<typeof createManagedWebsiteIntegration>>; botId: string; requestId: string;
        input: { origin: string; publicSiteKey: string; sessionId: string; sessionToken: string; message: string } }[];
    };
    const customers: CustomerFixture[] = [];
    for (const label of ["alpha", "beta"]) {
      const operator = await member(internalWorkspace, `operator-${label}`, "admin", "novalure_onboarding");
      const provisioned = await provisionCustomerWorkspace(operator, { name: `SYNTHETIC ${label} customer`, projectName: `SYNTHETIC ${label} website`,
        botName: `SYNTHETIC ${label} assistant`, websiteUrl: `https://${label}.example/`, customerType: "general_company", requestId: randomUUID() }, options);
      const adminId = (await db.admin.query("select id from workspace_users where workspace_id=$1 and auth_identity_id=$2", [provisioned.workspace.id, operator.authIdentityId])).rows[0].id;
      const admin = await session(provisioned.workspace.id, adminId);
      // These are explicit synthetic acceptance parameters, not product prices,
      // contracted allowances or production configuration.
      await db.admin.query("update knowledge_center_entitlements set limits=limits||'{\"maxAssistants\":2}'::jsonb where workspace_id=$1", [admin.workspaceId]);
      await db.admin.query(`insert into webchat_product_accounts(workspace_id,enabled,synthetic_only,quota_units,used_units,reserved_units,contract_reference)
        values($1,true,true,2,0,0,$2)`, [admin.workspaceId, `SYNTHETIC-${label}-CONTRACT`]);
      const employee = await member(admin.workspaceId, `employee-${label}`, "agent", "team_member");
      let source = await createKnowledgeSource(employee, { areaId: provisioned.knowledgeArea.id, name: `SYNTHETIC ${label} FAQ`, type: "manual", content: `${label}anchor ${label} office opens at 09:00.` }, options);
      await assert.rejects(publishKnowledgeSource(employee, { sourceId: source.id, versionId: source.draftVersionId!, expectedVersion: source.revision }, options), code("FORBIDDEN"));
      source = await publishKnowledgeSource(admin, { sourceId: source.id, versionId: source.draftVersionId!, expectedVersion: source.revision }, options);
      await assignKnowledgeAreas(admin, { botId: provisioned.bot.id, channel: "webchat", areaIds: [provisioned.knowledgeArea.id] }, options);
      const secondBotId = randomUUID();
      await db.admin.query("insert into bots(id,workspace_id,project_id,name,role) values($1,$2,$3,$4,'Support')", [secondBotId, admin.workspaceId, provisioned.project.id, `SYNTHETIC ${label} second bot`]);
      await assignKnowledgeAreas(admin, { botId: secondBotId, channel: "webchat", areaIds: [provisioned.knowledgeArea.id] }, options);
      const sites = [];
      for (const [index, botId] of [provisioned.bot.id, secondBotId].entries()) {
        const origin = `https://${label}-${index}.example`;
        const integration = await createManagedWebsiteIntegration(admin, { projectId: provisioned.project.id, knowledgeAssistantId: botId, allowedOrigins: [origin], mode: "training" }, options);
        assert.equal(integration.readiness.ready, true);
        assert.equal(integration.mode, "training");
        const visitor = await startExternalChatSession({ publicSiteKey: integration.publicSiteKey, origin, language: "en", correlationId: randomUUID(), idempotencyKey: randomBytes(32).toString("base64url") });
        sites.push({ integration, botId, requestId: randomUUID(), input: { origin, publicSiteKey: integration.publicSiteKey, sessionId: visitor.sessionId, sessionToken: visitor.sessionToken, message: `${label}anchor` } });
      }
      await db.admin.query("update webchat_product_accounts set stripe_customer_id=$2 where workspace_id=$1", [admin.workspaceId, `cus_${label}`]);
      await db.admin.query(`insert into webchat_product_offers(workspace_id,reference,revision,units,amount_minor,currency,contract_reference,active)
        values($1,'SYNTHETIC-TOPUP',1,2,'1000','EUR',$2,true)`, [admin.workspaceId, `SYNTHETIC-${label}-CONTRACT`]);
      // Existing lead handoff remains authoritative. Seed its ordinary result
      // solely to verify the new portal's projection and foreign-row exclusion.
      const leadId = randomUUID();
      await db.admin.query("insert into leads(id,workspace_id,project_id,source,type,intent) values($1,$2,$3,'Website Webchat','Anfrage',$4)",
        [leadId, admin.workspaceId, provisioned.project.id, `SYNTHETIC-${label}-LEAD`]);
      customers.push({ label, admin, employee, source, provisioned, sites, leadId });
    }
    const [alpha, beta] = customers;
    assert.notEqual(alpha.admin.workspaceId, beta.admin.workspaceId);
    const { readWebchatCustomerPortal, readWebchatConversationMessages } = await import("../src/lib/webchat-customer-portal");
    const { createWebchatTopupOrder, processWebchatTestPayment } = await import("../src/lib/webchat-product/billing");
    async function withdrawSource(sourceId: string) {
      const writer = await db.admin.connect();
      try {
        await writer.query("begin");
        await writer.query("select set_config('app.tenant_id',$1,true),set_config('app.actor_id',$2,true)", [alpha.admin.workspaceId, alpha.admin.userId]);
        await writer.query("update knowledge_sources set approved_version_id=null where id=$1", [sourceId]);
        await writer.query("commit");
      } catch (error) { await writer.query("rollback"); throw error; }
      finally { writer.release(); }
    }

    await t.test("controlled accounts cannot run on the production target", async () => {
      const provider = model(alpha.label);
      process.env.VERCEL_ENV = "production";
      try { await assert.rejects(answerWebsiteChat({ ...alpha.sites[0].input, requestId: randomUUID() }, { ...options, model: provider })); }
      finally { delete process.env.VERCEL_ENV; }
      assert.equal(provider.doGenerateCalls.length, 0);
    });

    await t.test("each account consumes one shared allowance across its own bots and records its own conversations", async () => {
      for (const customer of customers) {
        for (const site of customer.sites) {
          const provider = model(customer.label);
          const answer = await answerWebsiteChat({ ...site.input, requestId: site.requestId }, { ...options, model: provider });
          assert.equal(answer.answerStatus, "grounded");
          assert.equal(provider.doGenerateCalls.length, 1);
        }
        const account = (await db.admin.query("select quota_units,used_units,reserved_units from webchat_product_accounts where workspace_id=$1", [customer.admin.workspaceId])).rows[0];
        assert.equal(Number(account.quota_units), 2); assert.equal(Number(account.used_units), 2); assert.equal(Number(account.reserved_units), 0);
        const portal = await readWebchatCustomerPortal(customer.employee, options);
        assert.equal(portal.workspace.id, customer.admin.workspaceId);
        assert.deepEqual(portal.leads.map(lead => lead.id), [customer.leadId]);
        assert.equal(portal.permissions.canManage, false);
        assert.equal(portal.team.length, 0);
        assert.equal(portal.conversations.length, 2);
        assert.ok(portal.conversations.every(conversation => conversation.messages.some(message => message.role === "assistant" && message.content.includes(customer.label))));
        assert.ok(portal.conversations.every(conversation => conversation.summary));
        assert.ok(portal.conversations.every(conversation => conversation.summaryKind === "extractive"));
        for (const conversation of portal.conversations) assert.deepEqual(conversation.messages.map(message => message.role), ["visitor", "assistant"]);
        const foreignLabel = customer === alpha ? "beta" : "alpha";
        assert.equal(JSON.stringify(portal).includes(`${foreignLabel} office`), false);
        assert.equal(JSON.stringify(portal).includes(`SYNTHETIC-${foreignLabel}-LEAD`), false);
        assert.equal(JSON.stringify(portal).includes("session_token_hash"), false);
        assert.equal(JSON.stringify(portal).includes(signatureSecret), false);
        assert.equal(portal.usage?.paused, true);
        assert.equal(portal.usage?.bots.length, 2);
        assert.ok(portal.usage?.bots.every(bot => bot.usedUnits === 1));
        for (const site of customer.sites) {
          const provider = model(customer.label);
          const answer = await answerWebsiteChat({ ...site.input, requestId: randomUUID() }, { ...options, model: provider });
          assert.equal(answer.operationalReason, "budget_limit");
          assert.equal(provider.doGenerateCalls.length, 0);
        }
      }
    });

    await t.test("request replay cannot invoke another model, change the question or cross an integration scope", async () => {
      const site = alpha.sites[0], provider = model(alpha.label);
      const replay = await answerWebsiteChat({ ...site.input, requestId: site.requestId }, { ...options, model: provider });
      assert.equal(replay.answerStatus, "grounded");
      assert.equal(provider.doGenerateCalls.length, 0);
      const conflictModel = model(alpha.label);
      await assert.rejects(answerWebsiteChat({ ...site.input, requestId: site.requestId, message: "different alphaanchor question" }, { ...options, model: conflictModel }));
      assert.equal(conflictModel.doGenerateCalls.length, 0);
      const foreignModel = model(beta.label);
      await assert.rejects(answerWebsiteChat({ ...beta.sites[0].input, sessionId: site.input.sessionId, sessionToken: site.input.sessionToken, requestId: randomUUID() }, { ...options, model: foreignModel }));
      assert.equal(foreignModel.doGenerateCalls.length, 0);
      const leaked = await withCrmRead(alpha.employee, tx => tx.query("select id from external_chat_sessions where workspace_id=$1", [beta.admin.workspaceId]), options);
      assert.deepEqual(leaked, []);
    });

    for (const customer of customers) await t.test(`${customer.label}: deliberate order stays paused until confirmed test payment, then provisions once`, async () => {
      const requestId = randomUUID();
      const orderInput = { requestId, offerReference: "SYNTHETIC-TOPUP", expectedOfferRevision: 1 };
      await assert.rejects(createWebchatTopupOrder(customer.employee, orderInput, options), code("FORBIDDEN"));
      await assert.rejects(createWebchatTopupOrder(customer.admin, { ...orderInput, expectedOfferRevision: 99 }, options));
      const order = await createWebchatTopupOrder(customer.admin, orderInput, options);
      assert.equal(order.status, "pending");
      assert.equal((await createWebchatTopupOrder(customer.admin, orderInput, options)).orderId, order.orderId);
      const pending = await readWebchatCustomerPortal(customer.admin, options);
      assert.equal(pending.usage?.paused, true);
      assert.equal(pending.usage?.quotaUnits, 2);
      assert.equal(pending.usage?.orders.filter(item => item.id === order.orderId).length, 1);
      const paymentId = `pi_${customer.label}`;
      // Host-side fixture binding simulates the existing Stripe adapter's trusted
      // provider result; neither caller metadata nor a checkout redirect grants it.
      await db.admin.query("update webchat_product_orders set stripe_payment_intent_id=$2 where id=$1", [order.orderId, paymentId]);
      const scope = { workspaceId: customer.admin.workspaceId, actorId: customer.admin.userId };
      const event = { id: `evt_${customer.label}confirmed`, type: "payment_intent.succeeded", created: now, livemode: false,
        metadata: { workspaceId: customer === alpha ? beta.admin.workspaceId : alpha.admin.workspaceId, units: 99999 },
        data: { object: { id: paymentId, customer: `cus_${customer.label}`, status: "succeeded", amount_received: 1000, currency: "eur" } } };
      const consume = (value: Record<string, unknown>, changes: Record<string, unknown> = {}) => processWebchatTestPayment({ scope, ...signed(value), secret: signatureSecret, nowSeconds: now, ...paymentOptions, ...changes });
      await assert.rejects(consume(event, { signature: `t=${now},v1=${"0".repeat(64)}` }));
      await assert.rejects(consume({ ...event, livemode: true }));
      await assert.rejects(consume(event, { env: { NOVALURE_WEBCHAT_PRODUCT_ISOLATED_ENABLED: "1", VERCEL_ENV: "production" } }));
      await assert.rejects(consume({ ...event, id: `evt_${customer.label}wrongamount`, data: { object: { ...event.data.object, amount_received: 999 } } }));
      assert.equal((await readWebchatCustomerPortal(customer.admin, options)).usage?.quotaUnits, 2);
      const concurrent = await Promise.all([consume(event), consume(event)]);
      assert.equal(concurrent.filter(item => item.outcome === "applied").length, 1);
      assert.equal(concurrent.filter(item => item.outcome === "duplicate").length, 1);
      assert.equal((await consume(event)).outcome, "duplicate");
      assert.equal((await consume({ ...event, id: `evt_${customer.label}late`, created: now - 60 })).outcome, "stale");
      await assert.rejects(consume({ ...event, created: now + 1 }), code("PAYMENT_EVENT_CONFLICT"));
      assert.equal((await consume({ ...event, id: `evt_${customer.label}failure`, type: "payment_intent.payment_failed", created: now - 120 })).outcome, "ignored");
      const result = await readWebchatCustomerPortal(customer.admin, options);
      assert.equal(result.usage?.quotaUnits, 4);
      assert.equal(result.usage?.remainingUnits, 2);
      assert.equal(result.usage?.paused, false);
      assert.equal(result.usage?.orders.find(item => item.id === order.orderId)?.status, "paid");
      const provisions = (await db.admin.query("select module_key,units,contract_reference from webchat_product_provisions where workspace_id=$1 and order_id=$2", [customer.admin.workspaceId, order.orderId])).rows;
      assert.equal(provisions.length, 1);
      assert.equal(provisions[0].module_key, "webchat");
      assert.equal(Number(provisions[0].units), 2);
      assert.equal(provisions[0].contract_reference, `SYNTHETIC-${customer.label}-CONTRACT`);
      const provider = model(customer.label), site = customer.sites[0];
      const response = await handleWebsiteChatRequest(new Request(`https://crm.example.invalid/api/public/integrations/chat/answers?site_key=${site.input.publicSiteKey}`, {
        method: "POST", headers: { "content-type": "application/json", origin: site.input.origin, "x-novalure-session-token": site.input.sessionToken, "x-test-client-ip": "203.0.113.7" },
        body: JSON.stringify({ sessionId: site.input.sessionId, message: site.input.message, requestId: randomUUID() }),
      }), { ...options, model: provider });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).answerStatus, "grounded");
      assert.equal(provider.doGenerateCalls.length, 1);
      const models = [model(customer.label), model(customer.label)];
      const answers = await Promise.all(customer.sites.map((candidate, index) => answerWebsiteChat({ ...candidate.input, requestId: randomUUID() }, { ...options, model: models[index] })));
      assert.equal(answers.filter(answer => answer.answerStatus === "grounded").length, 1);
      assert.equal(answers.filter(answer => answer.operationalReason === "budget_limit").length, 1);
      assert.equal(models.reduce((sum, item) => sum + item.doGenerateCalls.length, 0), 1, "one remaining shared unit admits exactly one provider call");
      const exhaustedAgain = await readWebchatCustomerPortal(customer.admin, options);
      assert.equal(exhaustedAgain.usage?.usedUnits, 4);
      assert.equal(exhaustedAgain.usage?.reservedUnits, 0);
      assert.equal(exhaustedAgain.usage?.paused, true);
    });

    await t.test("a confirmed payment cannot undo a host suspension", async () => {
      const order = await createWebchatTopupOrder(alpha.admin, { requestId: randomUUID(), offerReference: "SYNTHETIC-TOPUP", expectedOfferRevision: 1 }, options);
      await db.admin.query("update webchat_product_orders set stripe_payment_intent_id='pi_suspended' where id=$1", [order.orderId]);
      await db.admin.query("update webchat_product_accounts set enabled=false where workspace_id=$1", [alpha.admin.workspaceId]);
      const event = { id: "evt_suspended", type: "payment_intent.succeeded", created: now, livemode: false,
        data: { object: { id: "pi_suspended", customer: "cus_alpha", status: "succeeded", amount_received: 1000, currency: "eur" } } };
      assert.equal((await processWebchatTestPayment({ scope: { workspaceId: alpha.admin.workspaceId, actorId: alpha.admin.userId }, ...signed(event), secret: signatureSecret, nowSeconds: now, ...paymentOptions })).outcome, "applied");
      assert.equal((await readWebchatCustomerPortal(alpha.admin, options)).usage?.enabled, false);
      const provider = model(alpha.label);
      await assert.rejects(answerWebsiteChat({ ...alpha.sites[0].input, requestId: randomUUID() }, { ...options, model: provider }));
      assert.equal(provider.doGenerateCalls.length, 0);
      await db.admin.query("update webchat_product_accounts set enabled=true where workspace_id=$1", [alpha.admin.workspaceId]);
    });

    await t.test("cached replay revalidates every exposed source, including an uncited source", async () => {
      let supplemental = await createKnowledgeSource(alpha.admin, { areaId: alpha.provisioned.knowledgeArea.id,
        name: "SYNTHETIC uncited supplemental", type: "manual", content: "alphaanchor Supplemental office information: alpha office opens at 09:00." }, options);
      supplemental = await publishKnowledgeSource(alpha.admin, { sourceId: supplemental.id, versionId: supplemental.draftVersionId!, expectedVersion: supplemental.revision }, options);
      const requestId = randomUUID(), provider = model(alpha.label), site = alpha.sites[0];
      const answer = await answerWebsiteChat({ ...site.input, requestId }, { ...options, model: provider });
      assert.equal(answer.answerStatus, "grounded");
      assert.equal(answer.citations.length, 1);
      const prompt = JSON.stringify(provider.doGenerateCalls[0].prompt);
      assert.ok(prompt.includes("SYNTHETIC uncited supplemental") && prompt.includes("SYNTHETIC alpha FAQ"), "both sources were exposed before the response was stored");
      const original = alpha.source;
      const cited = answer.citations[0].sourceId === original.id ? original : supplemental;
      const uncited = cited.id === original.id ? supplemental : original;
      await withdrawSource(uncited.id);
      const replayModel = model(alpha.label);
      const replay = await answerWebsiteChat({ ...site.input, requestId }, { ...options, model: replayModel });
      assert.equal(replay.operationalReason, "access_denied");
      assert.equal(replayModel.doGenerateCalls.length, 0);
      alpha.source = cited;
    });

    await t.test("source withdrawal at the completion transaction blocks answer persistence and leaves the uncertain reservation held", async () => {
      const site = alpha.sites[0];
      const before = Number((await db.admin.query("select count(*) from external_chat_messages where session_id=$1", [site.input.sessionId])).rows[0].count);
      let visitorLocks = 0, withdrew = false;
      const racePool = { async connect() {
        const client = await db.pool.connect();
        return new Proxy(client, { get(target, key) {
          if (key === "query") return async (...args: unknown[]) => {
            if (typeof args[0] === "string" && args[0].includes("select synthetic,mode from external_chat_sessions") && ++visitorLocks === 2) {
              await withdrawSource(alpha.source.id);
              withdrew = true;
            }
            return Reflect.apply(target.query, target, args);
          };
          const value = Reflect.get(target, key, target);
          return typeof value === "function" ? value.bind(target) : value;
        } });
      } } as unknown as NonNullable<TenantTransactionOptions["pool"]>;
      const requestId = randomUUID(), provider = model(alpha.label);
      let failure: unknown;
      await assert.rejects(answerWebsiteChat({ ...site.input, requestId }, { ...options, pool: racePool, model: provider }), error => { failure = error; return true; });
      assert.equal(withdrew, true, `withdrawal occurs specifically before the final visitor lock: ${JSON.stringify({ visitorLocks, calls: provider.doGenerateCalls.length, failure: failure instanceof Error ? failure.message : "unknown" })}`);
      assert.equal(provider.doGenerateCalls.length, 1);
      assert.equal(Number((await db.admin.query("select count(*) from external_chat_messages where session_id=$1", [site.input.sessionId])).rows[0].count), before);
      const usage = (await db.admin.query("select state from webchat_product_usage where workspace_id=$1 and request_id=$2", [alpha.admin.workspaceId, requestId])).rows[0];
      assert.equal(usage.state, "reserved");
      const replay = model(alpha.label);
      await assert.rejects(answerWebsiteChat({ ...site.input, requestId }, { ...options, model: replay }));
      assert.equal(replay.doGenerateCalls.length, 0, "unknown completion does not repeat the provider effect");
    });

    await t.test("portal history pages retain every visitor-visible message and exclude technical system messages", async () => {
      const site = beta.sites[0];
      await db.admin.query(`insert into external_chat_messages(session_id,integration_id,workspace_id,role,content,idempotency_hash,synthetic)
        values($1,$2,$3,'system','SYNTHETIC-PRIVATE-SYSTEM-MARKER',$4,true)`,
      [site.input.sessionId, site.integration.id, beta.admin.workspaceId, createHash("sha256").update("system-marker").digest("hex")]);
      for (let index = 0; index < 35; index++) await db.admin.query(`insert into external_chat_messages(session_id,integration_id,workspace_id,role,content,idempotency_hash,synthetic,created_at)
        values($1,$2,$3,$4,$5,$6,true,now()-($7::int*interval '1 second'))`,
      [site.input.sessionId, site.integration.id, beta.admin.workspaceId, index % 2 ? "assistant" : "visitor", `SYNTHETIC-ARCHIVE-${index}`, createHash("sha256").update(`archive-${index}`).digest("hex"), 100 - index]);
      const snapshot = await readWebchatCustomerPortal(beta.employee, options);
      assert.equal(JSON.stringify(snapshot).includes("SYNTHETIC-PRIVATE-SYSTEM-MARKER"), false);
      const ids = new Set<string>();
      let cursor: { createdAt: string; id: string } | undefined;
      for (let page = 0; page < 10; page++) {
        const result = await readWebchatConversationMessages(beta.employee, { conversationId: site.input.sessionId, cursor }, options);
        assert.equal(JSON.stringify(result).includes("SYNTHETIC-PRIVATE-SYSTEM-MARKER"), false);
        for (const message of result.messages) { assert.equal(ids.has(message.id), false); ids.add(message.id); }
        if (!result.hasOlder) break;
        assert.ok(result.nextCursor); cursor = result.nextCursor;
      }
      const visible = Number((await db.admin.query("select count(*) from external_chat_messages where session_id=$1 and role in ('visitor','assistant')", [site.input.sessionId])).rows[0].count);
      assert.equal(ids.size, visible);
      await assert.rejects(readWebchatConversationMessages(alpha.admin, { conversationId: site.input.sessionId }, options));
      for (let index = 0; index < 51; index++) await db.admin.query(`insert into external_chat_sessions(integration_id,workspace_id,project_id,session_token_hash,idempotency_hash,mode,language,synthetic)
        values($1,$2,$3,$4,$5,'training','en',true)`,
      [site.integration.id, beta.admin.workspaceId, beta.provisioned.project.id,
        createHash("sha256").update(`synthetic-archive-session-${index}`).digest("hex"), createHash("sha256").update(`synthetic-session-idempotency-${index}`).digest("hex")]);
      const sessionIds = new Set<string>();
      let conversationCursor: { updatedAt: string; id: string } | undefined;
      for (let page = 0; page < 10; page++) {
        const result = await readWebchatCustomerPortal(beta.employee, options, conversationCursor);
        for (const conversation of result.conversations) { assert.equal(sessionIds.has(conversation.id), false); sessionIds.add(conversation.id); }
        if (!result.conversationPage.hasOlder) break;
        assert.ok(result.conversationPage.nextCursor); conversationCursor = result.conversationPage.nextCursor;
      }
      assert.equal(sessionIds.size, 53, "history beyond the first 50 conversations remains accessible");
    });

    await t.test("fresh membership and database privileges preserve customer boundaries after the full flow", async () => {
      await db.admin.query("update workspace_users set status='suspended' where id=$1", [alpha.employee.userId]);
      await assert.rejects(readWebchatCustomerPortal(alpha.employee, options));
      const foreignPayments = await withCrmRead(beta.admin, tx => tx.query("select event_id from webchat_product_payment_events where workspace_id=$1", [alpha.admin.workspaceId]), options);
      assert.deepEqual(foreignPayments, []);
      const flags = (await db.pool.query("select rolsuper,rolbypassrls from pg_roles where rolname=current_user")).rows[0];
      assert.deepEqual(flags, { rolsuper: false, rolbypassrls: false });
      const privileges = (await db.pool.query("select pg_has_role(current_user,'novalure_webchat_product_writer','MEMBER') as writer,pg_has_role(current_user,'novalure_webchat_payment_executor','MEMBER') as payment")).rows[0];
      assert.deepEqual(privileges, { writer: false, payment: false });
      for (const query of [
        "update webchat_product_accounts set quota_units=99999 where workspace_id=$1",
        "update webchat_product_accounts set stripe_customer_id='cus_forged' where workspace_id=$1",
        "insert into webchat_product_offers(workspace_id,reference,revision,units,amount_minor,currency,contract_reference) values($1,'FORGED',1,99999,'0','EUR','FORGED')",
        "insert into webchat_product_provisions(workspace_id,order_id,contract_reference,units) values($1,gen_random_uuid(),'FORGED',99999)",
        "select webchat_apply_test_payment($1::uuid,'','cus_forged','pi_forged','evt_forged',repeat('0',64),0,'0','EUR')",
      ]) await assert.rejects(withCrmRead(beta.admin, tx => tx.query(query, [beta.admin.workspaceId]), options), code("42501"));
      const rls = (await db.admin.query("select count(*)::int as count from pg_class where relname like 'webchat_product_%' and relkind='r' and relrowsecurity and relforcerowsecurity")).rows[0].count;
      assert.equal(rls, 6);
      assert.equal(Number((await db.admin.query("select count(*) from webchat_product_provisions")).rows[0].count), 3);
    });
  } finally {
    globalThis.fetch = originalFetch;
    await paymentPool?.end();
    await closeLocalTestPool();
    for (const name of names) { const value = previous[name]; if (value === undefined) Reflect.deleteProperty(process.env, name); else Reflect.set(process.env, name, value); }
    await db.stop();
  }
});
