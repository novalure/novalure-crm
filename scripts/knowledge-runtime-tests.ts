import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { seedSalesBrowser } from "./lib/sales-browser-fixture.mjs";
import { createCsrfToken } from "../src/lib/security/csrf-core";
import { closeLocalTestPool } from "../src/lib/db/local-test-transport";
import { after, before, test } from "node:test";
import { startLocalSalesDb, applySalesSchema } from "./lib/local-sales-db.mjs";
import { requiresLivePropertyFacts, runCrmBotTool } from "../src/lib/bots/agent-tools";
import { runBotChat } from "../src/lib/bots/chat-runtime";
import { runBotGovernanceEvaluation } from "../src/lib/bots/evaluation";
import { getOrCreateBotConversation, listBotConversations, listBotMessages, resolveBotConversationContext, searchPersistedKnowledge } from "../src/lib/db/runtime-repositories";
import { CrmCommandError, withCrmRead, type TenantTransactionOptions } from "../src/lib/crm-command";
import type { AppSession } from "../src/lib/auth/session";
import { KnowledgeCenterError } from "../src/lib/knowledge-center/policy";
import { assignKnowledgeAreas, createKnowledgeArea, createKnowledgeSource, publishKnowledgeSource } from "../src/lib/knowledge-center/repository";

let db: Awaited<ReturnType<typeof startLocalSalesDb>>;
let options: TenantTransactionOptions;
const workspaceId = randomUUID(), userId = randomUUID(), botId = randomUUID();
const projectA = randomUUID(), projectB = randomUUID(), limitedUserId = randomUUID();
const botA = randomUUID(), botA2 = randomUUID(), botB = randomUUID();
const conversationA = randomUUID(), conversationA2 = randomUUID(), conversationB = randomUUID(), conversationEmail = randomUUID();
let sourceId: string, versionId: string;
const session: AppSession = { authenticated: true, workspaceId, userId, workspaceName: "Synthetic knowledge runtime", email: "owner@qa.invalid", name: "Synthetic owner", role: "owner", productRole: "customer_owner", permissions: ["crm:read", "crm:write", "bots:run", "knowledge:write"], productPermissions: ["knowledge:write"], source: "headers" };
const limitedSession: AppSession = { ...session, userId: limitedUserId, role: "agent", productRole: "project_sales_member" };
const retrieve = (extra: Partial<Parameters<typeof searchPersistedKnowledge>[0]> = {}) => withCrmRead(session, () => searchPersistedKnowledge({ session, botId, channel: "webchat", query: "syntheticstone", ...extra }), options);

before(async () => {
  db = await startLocalSalesDb();
  await applySalesSchema(db);
  options = { pool: db.pool as unknown as NonNullable<TenantTransactionOptions["pool"]> };
  // The generic sales fixture omits pre-existing bot-runtime table privileges.
  // Grant only this disposable role the tables needed for the complete chat test.
  await db.admin.query(`grant select,insert,update on bot_conversations,bot_messages,bot_tool_calls,bot_evaluation_runs to ${db.role}`);
  await db.admin.query("insert into workspaces(id,name,operating_model) values($1,'Synthetic runtime','managed_by_novalure')", [workspaceId]);
  await db.admin.query("insert into workspace_users(id,workspace_id,name,email,role,product_role,status) values($1,$2,'Synthetic Owner','owner@qa.invalid','owner','customer_owner','active')", [userId, workspaceId]);
  await db.admin.query("insert into workspace_users(id,workspace_id,name,email,role,product_role,status) values($1,$2,'Synthetic Limited','limited@qa.invalid','agent','project_sales_member','active')", [limitedUserId, workspaceId]);
  await db.admin.query("insert into projects(id,workspace_id,name,type) values($1,$3,'Synthetic A','Bauträger'),($2,$3,'Synthetic B','Bauträger')", [projectA, projectB, workspaceId]);
  await db.admin.query("insert into project_pipeline_permissions(workspace_id,project_id,user_id,can_read,can_edit_deals) values($1,$2,$3,true,true)", [workspaceId, projectA, limitedUserId]);
  await db.admin.query("insert into bots(id,workspace_id,project_id,name,role) values($1,$4,$5,'Bot A','sales'),($2,$4,$5,'Bot A2','sales'),($3,$4,$6,'Bot B','sales')", [botA, botA2, botB, workspaceId, projectA, projectB]);
  for (const [id, savedBot, project, savedChannel, secret] of [
    [conversationA, botA, projectA, "webchat", "SYNTHETIC_A_HISTORY"],
    [conversationA2, botA2, projectA, "webchat", "SYNTHETIC_A2_ASSIGNED_KNOWLEDGE"],
    [conversationB, botB, projectB, "webchat", "SYNTHETIC_B_SECRET_APPROVED_KNOWLEDGE"],
    [conversationEmail, botA, projectA, "email", "SYNTHETIC_EMAIL_SECRET_KNOWLEDGE"],
  ]) {
    await withCrmRead(session, async (tx) => {
      await tx.execute("insert into bot_conversations(id,workspace_id,bot_id,project_id,metadata) values($1,$2,$3,$4,$5::jsonb)", [id, workspaceId, savedBot, project, JSON.stringify({ channel: savedChannel })]);
      await tx.execute("insert into bot_messages(workspace_id,conversation_id,role,content) values($1,$2,'assistant',$3)", [workspaceId, id, secret]);
    }, options);
  }
  await db.admin.query("insert into bots(id,workspace_id,name,role) values($1,$2,'Synthetic grounded bot','sales')", [botId, workspaceId]);
  await db.admin.query("insert into knowledge_center_entitlements(workspace_id,enabled,max_sources,max_storage_bytes,max_queries_per_month,contract_reference,features,limits) values($1,true,20,1000000,100,'synthetic-runtime-contract','{\"webchatAccess\":true,\"voiceAccess\":true}','{\"maxAreas\":10,\"maxWebsites\":10,\"maxScansPerMonth\":10,\"maxUsers\":10,\"maxAssistants\":10}')", [workspaceId]);
  const area = await createKnowledgeArea(session, { name: "Synthetic approved area", kind: "company" }, options);
  const source = await createKnowledgeSource(session, { areaId: area.id, type: "manual", name: "Synthetic approved source", content: "syntheticstone approved reference" }, options);
  sourceId = source.id;
  versionId = source.draftVersionId!;
  await publishKnowledgeSource(session, { sourceId, versionId, expectedVersion: source.revision }, options);
  await assignKnowledgeAreas(session, { botId, channel: "webchat", areaIds: [area.id] }, options);
  const stalePrice = await createKnowledgeSource(session, { areaId: area.id, type: "manual", name: "Synthetic old brochure", content: "oldbrochurestone Wohnung A01 Kaufpreis EUR 450000, available" }, options);
  await publishKnowledgeSource(session, { sourceId: stalePrice.id, versionId: stalePrice.draftVersionId!, expectedVersion: stalePrice.revision }, options);
});
after(async () => { if (db) await db.stop(); });

test("runtime delegates to exact approved version and bot/channel assignment", async () => {
  const result = await retrieve();
  assert.equal(result.length, 1);
  assert.equal(result[0].sourceId, sourceId);
  assert.equal(result[0].versionId, versionId);
  assert.equal(result[0].excerpt, "syntheticstone approved reference");
  assert.deepEqual(await retrieve({ channel: "email" }), []);
});

test("missing persisted bot, unknown channel and unauthenticated identity fail closed", async () => {
  for (const extra of [{ botId: null }, { botId: "bot_demo" }, { channel: null }, { channel: "api" }, { session: { ...session, authenticated: false } }, { session: { ...session, source: "demo" as const } }]) {
    assert.deepEqual(await retrieve(extra), []);
  }
});

test("legacy approved metadata never grants retrieval", async () => {
  const legacyId = randomUUID();
  await db.admin.query("insert into knowledge_sources(id,workspace_id,name,source_type,status,metadata) values($1,$2,'Legacy synthetic','manual','approved','{\"approval\":\"approved\"}')", [legacyId, workspaceId]);
  await db.admin.query("insert into knowledge_chunks(source_id,chunk_index,content,citation_title) values($1,0,'legacybypass synthetic secret','Legacy metadata')", [legacyId]);
  assert.deepEqual(await retrieve({ query: "legacybypass" }), []);
  assert.deepEqual(await retrieve({ query: "oldbrochurestone" }), []);
});

test("disabled module and quota exhaustion yield no sources; security errors propagate", async () => {
  await db.admin.query("update knowledge_center_entitlements set enabled=false where workspace_id=$1", [workspaceId]);
  assert.deepEqual(await retrieve(), []);
  await db.admin.query("update knowledge_center_entitlements set enabled=true,max_queries_per_month=1 where workspace_id=$1", [workspaceId]);
  assert.deepEqual(await retrieve(), []);
  await db.admin.query("update knowledge_center_entitlements set max_queries_per_month=100 where workspace_id=$1", [workspaceId]);
  await assert.rejects(retrieve({ botId: randomUUID() }), (error: unknown) => error instanceof KnowledgeCenterError && error.code === "NOT_FOUND");
});

test("price and availability requests require current CRM truth across languages", () => {
  for (const prompt of ["Was kostet die Wohnung?", "Wie hoch ist der aktuelle Kaufpreis?", "Wie teuer ist diese Wohnung?", "What is the rent?", "Ist Wohnung A01 verfügbar?", "What is the current price?", "Is this unit sold?", "¿Cuál es el precio?", "¿Está disponible?"]) {
    assert.equal(requiresLivePropertyFacts(prompt), true, prompt);
  }
  for (const prompt of ["Welche Grundrisse gibt es?", "Are appointment slots available?", "Ist ein Termin verfügbar?"]) {
    assert.equal(requiresLivePropertyFacts(prompt), false, prompt);
  }
  const result = runCrmBotTool("search_approved_knowledge", { query: "syntheticstone" });
  assert.equal(result.tool, "search_approved_knowledge");
  if (result.tool === "search_approved_knowledge") assert.deepEqual(result.sources, []);
});

test("only WEB_DESIGN service facts bypass the generic property-price guard", () => {
  for (const prompt of [
    "Website package prices start at EUR 499.",
    "Managed care is available. What does a website cost?",
    "Novalure provides real-estate marketing and CRM services separately. Those services are distinct from Studio website packages and must not be assumed included in a website price.",
    "Was kostet die Website?", "¿Cuál es el precio del sitio web?",
  ]) {
    assert.equal(requiresLivePropertyFacts(prompt, "WEB_DESIGN"), false, prompt);
    assert.equal(requiresLivePropertyFacts(prompt, "REAL_ESTATE_GROWTH"), true, prompt);
    assert.equal(requiresLivePropertyFacts(prompt), true, prompt);
  }
  for (const prompt of [
    "Apartment A01 is available for EUR 450000.", "What is the property price?",
    "Is this unit sold?", "Wie teuer ist diese Wohnung?", "Ist das Haus frei?",
    "What is the rent?", "Wie hoch ist der Kaufpreis?", "¿Está disponible el piso?",
    "How much is this house?", "Real estate is available for EUR 500000.",
  ]) assert.equal(requiresLivePropertyFacts(prompt, "WEB_DESIGN"), true, prompt);
});

test("current price requests hand off without model call even with strict knowledge disabled", async () => {
  const result = await withCrmRead(session, () => runBotChat({ language: "de", session, payload: { botId, channel: "webchat", prompt: "Was kostet die Wohnung aktuell?", strictKnowledge: false, customerFacing: false, testMode: true } }), options);
  assert.equal(result.externalModelCall, false);
  assert.equal(result.provider, "policy");
  assert.equal(result.autonomy.replyBlocked, true);
  assert.equal(result.runSummary.humanHandoffRequired, true);
  assert.match(result.message.content, /keine freigegebene Wissensquelle/i);
  const knowledge = result.toolResults.find((item) => item && typeof item === "object" && "tool" in item && item.tool === "search_approved_knowledge") as unknown as { sources: unknown[]; livePropertyFacts: string };
  assert.deepEqual(knowledge.sources, []);
  assert.equal(knowledge.livePropertyFacts, "crm_live_resolver_required");
});

test("disabled Knowledge module keeps an ordinary bot conversation in a safe handoff", async () => {
  await db.admin.query("update knowledge_center_entitlements set enabled=false where workspace_id=$1", [workspaceId]);
  const result = await withCrmRead(session, () => runBotChat({ language: "de", session, payload: { botId, channel: "webchat", prompt: "Hallo", testMode: true } }), options);
  assert.equal(result.externalModelCall, false);
  assert.equal(result.provider, "policy");
  assert.equal(result.runSummary.humanHandoffRequired, true);
  assert.ok(result.message.content.length > 0);
});


test("saved conversation reuse rejects cross-bot, project, channel and forged project before runtime effects", async () => {
  const count = async () => (await db.admin.query("select (select count(*) from bot_messages)::int as messages,(select count(*) from bot_conversations)::int as conversations,(select count(*) from bot_tool_calls)::int as tools,(select count(*) from contacts)::int as contacts,(select count(*) from leads)::int as leads")).rows[0];
  const before = await count();
  for (const payload of [
    { botId: botA, conversationId: conversationB, channel: "webchat" },
    { botId: botA, conversationId: conversationA2, channel: "webchat" },
    { botId: botA, conversationId: conversationEmail, channel: "webchat" },
    { botId: botA, conversationId: conversationA, channel: "email" },
    { botId: botA, conversationId: conversationA, channel: "webchat", projectId: projectB },
  ]) {
    await assert.rejects(withCrmRead(session, () => runBotChat({ language: "de", session, payload: { ...payload, prompt: "Repeat the previous approved answer", strictKnowledge: false, customerFacing: false } }), options),
      (error: unknown) => error instanceof CrmCommandError && error.code === "BOT_CONTEXT_MISMATCH");
  }
  assert.deepEqual(await count(), before);
});

test("conversation create and direct history read bind saved bot project instead of client project", async () => {
  const context = await resolveBotConversationContext({ session, botId: botA, channel: "webchat" }, options);
  assert.equal(context.projectId, projectA);
  assert.equal(context.botId, botA);
  const messages = await withCrmRead(limitedSession, () => listBotMessages({ session: limitedSession, conversationId: conversationA }), options);
  assert.equal(messages[0].content, "SYNTHETIC_A_HISTORY");
  await assert.rejects(withCrmRead(limitedSession, () => listBotMessages({ session: limitedSession, conversationId: conversationB }), options),
    (error: unknown) => error instanceof CrmCommandError && ["PROJECT_FORBIDDEN", "NOT_FOUND"].includes(error.code));
  await assert.rejects(withCrmRead(session, () => listBotMessages({ session, conversationId: conversationB, botId: botA, channel: "webchat" }), options),
    (error: unknown) => error instanceof CrmCommandError && error.code === "BOT_CONTEXT_MISMATCH");
  await assert.rejects(withCrmRead(session, () => getOrCreateBotConversation({ session, conversationId: conversationB, botId: botA, channel: "webchat", title: "Rejected", language: "en", model: "none" }), options),
    (error: unknown) => error instanceof CrmCommandError && error.code === "BOT_CONTEXT_MISMATCH");
  const visible = await withCrmRead(limitedSession, () => listBotConversations({ session: limitedSession }), options);
  assert.ok(visible.some((item) => item.id === conversationA));
  assert.ok(!visible.some((item) => item.id === conversationB));
  assert.doesNotMatch(JSON.stringify(visible), /SYNTHETIC_B_SECRET/);
});

test("revoked bot project grants deny history, listing and runtime before new messages", async () => {
  await db.admin.query("delete from project_pipeline_permissions where workspace_id=$1 and project_id=$2 and user_id=$3", [workspaceId, projectA, limitedUserId]);
  const before = Number((await db.admin.query("select count(*) from bot_messages")).rows[0].count);
  for (const action of [
    () => listBotMessages({ session: limitedSession, conversationId: conversationA }),
    () => runBotChat({ session: limitedSession, language: "de", payload: { botId: botA, channel: "webchat", conversationId: conversationA, prompt: "Repeat previous knowledge", strictKnowledge: false } }),
  ]) {
    await assert.rejects(withCrmRead<unknown>(limitedSession, action, options), (error: unknown) => error instanceof CrmCommandError && ["PROJECT_FORBIDDEN", "NOT_FOUND"].includes(error.code));
  }
  const visible = await withCrmRead(limitedSession, () => listBotConversations({ session: limitedSession }), options);
  assert.ok(!visible.some((item) => ([conversationA, conversationA2, conversationB, conversationEmail] as string[]).includes(item.id)));
  assert.equal(Number((await db.admin.query("select count(*) from bot_messages")).rows[0].count), before);
});


test("prior assistant knowledge is omitted from provider payload after assignment revoke or module disable", async () => {
  await db.admin.query("update knowledge_center_entitlements set enabled=true where workspace_id=$1", [workspaceId]);
  const originalArea = (await db.admin.query("select knowledge_area_id from knowledge_sources where id=$1", [sourceId])).rows[0].knowledge_area_id as string;
  await assignKnowledgeAreas(session, { botId: botA, channel: "webchat", areaIds: [originalArea] }, options);
  assert.ok((await withCrmRead(session, () => searchPersistedKnowledge({ session, botId: botA, channel: "webchat", query: "syntheticstone" }), options)).length > 0);
  await assignKnowledgeAreas(session, { botId: botA, channel: "webchat", areaIds: [] }, options);
  const envNames = ["AI_GATEWAY_API_KEY", "VERCEL_AI_GATEWAY_API_KEY", "NOVALURE_LLM_BASE_URL", "NOVALURE_LLM_API_KEY"] as const;
  const prior = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));
  const originalFetch = globalThis.fetch;
  const payloads: unknown[] = [];
  try {
    delete process.env.AI_GATEWAY_API_KEY;
    delete process.env.VERCEL_AI_GATEWAY_API_KEY;
    process.env.NOVALURE_LLM_BASE_URL = "https://synthetic-model.invalid/v1";
    process.env.NOVALURE_LLM_API_KEY = "synthetic-not-a-provider-key";
    globalThis.fetch = async (url, init) => {
      assert.equal(String(url), "https://synthetic-model.invalid/v1/chat/completions");
      payloads.push(JSON.parse(String(init?.body)));
      return Response.json({ choices: [{ message: { content: "Synthetic generic response" } }] });
    };
    for (const enabled of [true, false]) {
      await db.admin.query("update knowledge_center_entitlements set enabled=$2 where workspace_id=$1", [workspaceId, enabled]);
      await withCrmRead(session, () => runBotChat({ language: "de", session, payload: { botId: botA, conversationId: conversationA, channel: "webchat", prompt: "syntheticstone", strictKnowledge: false, customerFacing: false, testMode: true } }), options);
    }
    assert.equal(payloads.length, 2);
    for (const payload of payloads) {
      assert.doesNotMatch(JSON.stringify(payload), /SYNTHETIC_A_HISTORY|SYNTHETIC_B_SECRET|approved reference/);
      const messages = (payload as { messages: { role: string }[] }).messages;
      assert.ok(!messages.some((message) => message.role === "assistant"));
    }
    const archive = await withCrmRead(session, () => listBotMessages({ session, conversationId: conversationA }), options);
    assert.ok(archive.some((message) => message.content === "SYNTHETIC_A_HISTORY"));
  } finally {
    globalThis.fetch = originalFetch;
    for (const name of envNames) {
      if (prior[name] === undefined) delete process.env[name]; else process.env[name] = prior[name];
    }
  }
});

test("evaluation uses explicit webchat or saved active channel and persists its channel identity", async () => {
  await db.admin.query("update knowledge_center_entitlements set enabled=true where workspace_id=$1", [workspaceId]);
  await db.admin.query("update bots set config=$2::jsonb where id=$1", [botId, JSON.stringify({ channels: [{ channel: "Webchat", active: true }] })]);
  const area = await createKnowledgeArea(session, { name: "Evaluation fixture", kind: "company" }, options);
  const source = await createKnowledgeSource(session, { areaId: area.id, type: "manual", name: "Approved project details", content: "Welche freigegebenen Projektdetails darf ich einem Interessenten nennen? Synthetic approved description." }, options);
  await publishKnowledgeSource(session, { sourceId: source.id, versionId: source.draftVersionId!, expectedVersion: source.revision }, options);
  await assignKnowledgeAreas(session, { botId, channel: "webchat", areaIds: [area.id] }, options);
  for (const channel of ["webchat" as const, undefined]) {
    const evaluation = await withCrmRead(session, () => runBotGovernanceEvaluation({ session, botId, channel }), options);
    assert.equal(evaluation.persisted, true);
    if (!evaluation.persisted) throw new Error("Synthetic evaluation was not persisted");
    assert.equal(evaluation.run.evaluationChannel, "webchat");
    assert.equal(evaluation.run.sourceCoverage, 100);
    const row = (await db.admin.query("select result->>'evaluationChannel' as channel from bot_evaluation_runs where id=$1", [evaluation.run.id])).rows[0];
    assert.equal(row.channel, "webchat");
  }
  const internal = await withCrmRead(session, () => runBotGovernanceEvaluation({ session, botId, channel: "internal" }), options);
  assert.equal(internal.run.sourceCoverage, 0);
  const grants = (await db.admin.query("select count(*) from knowledge_area_grants where bot_id=$1 and channel='internal'", [botId])).rows[0];
  assert.equal(Number(grants.count), 0);
});


test("real cookie bot handlers bind transactions and reauthorize selected workspace membership and role", async () => {
  const owner = await seedSalesBrowser(db);
  const liveBot = randomUUID(), otherBot = randomUUID();
  await db.admin.query("insert into bots(id,workspace_id,project_id,name,role) values($1,$3,$4,'HTTP saved bot','sales'),($2,$3,$4,'HTTP other bot','sales')", [liveBot, otherBot, owner.workspaceId, owner.projectId]);
  const keys = ["DATABASE_URL", "NODE_ENV", "CRM_LOCAL_TEST_DATABASE", "NOVALURE_SESSION_SECRET", "NOVALURE_APP_ORIGIN", "NOVALURE_AUTH_STRICT", "NOVALURE_AUTH_ENCRYPTION_KEY", "NOVALURE_AUTH_RATE_LIMIT_SECRET", "NOVALURE_DEMO_AUTH_ENABLED", "NOVALURE_DEMO_USER_EMAIL", "NOVALURE_DEMO_USER_ROLE", "NOVALURE_TRUST_AUTH_HEADERS", "VERCEL", "VERCEL_ENV", "VERCEL_URL"];
  const prior = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const origin = "http://127.0.0.1:3000", secret = randomBytes(48).toString("base64url");
  const cookie = "v2." + randomBytes(32).toString("base64url"), sessionId = randomUUID();
  try {
    for (const key of keys) delete process.env[key];
    Object.assign(process.env, { DATABASE_URL: `postgresql://${db.role}@127.0.0.1:${db.port}/postgres`, NODE_ENV: "test", CRM_LOCAL_TEST_DATABASE: "1", NOVALURE_SESSION_SECRET: secret, NOVALURE_APP_ORIGIN: origin, NOVALURE_AUTH_STRICT: "1", NOVALURE_AUTH_ENCRYPTION_KEY: randomBytes(40).toString("hex"), NOVALURE_AUTH_RATE_LIMIT_SECRET: randomBytes(40).toString("hex") });
    await db.admin.query("insert into auth_sessions(id,token_hash,auth_identity_id,workspace_user_id,workspace_id,mfa_verified_at,expires_at) values($1,$2,$3,$4,$5,now(),now()+interval '1 hour')", [sessionId, createHash("sha256").update(cookie).digest("hex"), owner.authIdentityId, owner.userId, owner.workspaceId]);
    const chat = await import("../src/app/api/bots/chat/route");
    const request = (pathname: string, method = "GET", body?: unknown) => new Request(origin + pathname, { method, headers: { cookie: "novalure_session=" + cookie, ...(body === undefined ? {} : { "content-type": "application/json" }), ...(method === "GET" ? {} : { origin, "sec-fetch-site": "same-origin", "x-novalure-csrf-token": createCsrfToken({ method, pathname: pathname.split("?")[0], secret, sessionCookie: cookie })!.token }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const evaluationsForAuth = await import("../src/app/api/bots/evaluations/route");
    const agentForAuth = await import("../src/app/api/bots/agent/route");
    const botRoutes = [[chat, "/api/bots/chat"], [evaluationsForAuth, "/api/bots/evaluations"], [agentForAuth, "/api/bots/agent"]] as const;
    for (const mode of ["trusted_headers", "configured_demo"] as const) {
      if (mode === "trusted_headers") process.env.NOVALURE_TRUST_AUTH_HEADERS = "1";
      else {
        delete process.env.NOVALURE_TRUST_AUTH_HEADERS;
        process.env.NOVALURE_DEMO_AUTH_ENABLED = "1";
        process.env.NOVALURE_DEMO_USER_EMAIL = owner.email;
        process.env.NOVALURE_DEMO_USER_ROLE = "owner";
      }
      for (const [route, pathname] of botRoutes) for (const method of ["GET", "POST"] as const) {
        const headers: Record<string, string> = mode === "trusted_headers" ? { "x-novalure-workspace-id": owner.workspaceId, "x-novalure-user-id": owner.userId, "x-novalure-user-email": owner.email, "x-novalure-role": "owner", "x-novalure-product-role": "novalureAdmin" } : {};
        const attacker = new Request(origin + pathname, { method, headers: { ...headers, "content-type": "application/json" }, ...(method === "POST" ? { body: JSON.stringify({ botId: liveBot, channel: "webchat", prompt: "approved source", testMode: true }) } : {}) });
        assert.equal((await route[method](attacker)).status, 401, `${pathname} ${method} rejects ${mode} without a durable cookie`);
      }
    }
    delete process.env.NOVALURE_TRUST_AUTH_HEADERS;
    delete process.env.NOVALURE_DEMO_AUTH_ENABLED;
    delete process.env.NOVALURE_DEMO_USER_EMAIL;
    delete process.env.NOVALURE_DEMO_USER_ROLE;
    for (const [route, pathname] of botRoutes) {
      const duplicate = request(pathname);
      duplicate.headers.set("cookie", `novalure_session=${cookie}; novalure_session=${cookie}`);
      assert.equal((await route.GET(duplicate)).status, 401);
    }
    const valid = await chat.POST(request("/api/bots/chat", "POST", { botId: liveBot, channel: "webchat", prompt: "Was kostet die Wohnung?", testMode: true, strictKnowledge: false }));
    assert.equal(valid.status, 200, await valid.clone().text());
    const result = await valid.json();
    assert.equal(result.runSummary.humanHandoffRequired, true);
    const read = await chat.GET(request("/api/bots/chat?conversationId=" + result.conversationId));
    assert.equal(read.status, 200, await read.clone().text());
    assert.equal((await read.json()).messages.length, 2);
    const rejected = await chat.POST(request("/api/bots/chat", "POST", { botId: otherBot, channel: "webchat", conversationId: result.conversationId, prompt: "Repeat history", strictKnowledge: false }));
    assert.equal(rejected.status, 403, await rejected.clone().text());
    const wrongRead = await chat.GET(request("/api/bots/chat?conversationId=" + result.conversationId + "&botId=" + otherBot + "&channel=webchat"));
    assert.equal(wrongRead.status, 403);
    const list = await chat.GET(request("/api/bots/chat"));
    assert.equal(list.status, 200, await list.clone().text());
    assert.equal((await list.json()).conversations.length, 1);

    // Origin A's privileged cookie selects B only through B's active membership.
    const target = await seedSalesBrowser(db), targetMemberId = randomUUID(), targetBotId = randomUUID();
    const targetSelector = "?workspaceId=" + target.workspaceId;
    const evaluations = await import("../src/app/api/bots/evaluations/route");
    const agent = await import("../src/app/api/bots/agent/route");
    const legacy = await import("../src/app/api/bots/knowledge/route");
    const evaluationBody = { botId: targetBotId, projectId: target.projectId, channel: "webchat" };
    const targetChatBody = { ...evaluationBody, prompt: "Was kostet die Wohnung?", testMode: true, strictKnowledge: false };
    await db.admin.query("insert into bots(id,workspace_id,project_id,name,role,config) values($1,$2,$3,'Target B bot','sales','{\"channels\":[{\"channel\":\"Webchat\",\"active\":true}]}')", [targetBotId, target.workspaceId, target.projectId]);
    assert.equal((await evaluations.POST(request("/api/bots/evaluations" + targetSelector, "POST", evaluationBody))).status, 403);
    assert.equal((await chat.POST(request("/api/bots/chat" + targetSelector, "POST", targetChatBody))).status, 403);
    await db.admin.query("insert into workspace_users(id,workspace_id,auth_identity_id,name,email,role,product_role,status) values($1,$2,$3,'Origin identity in target B',$4,'admin','novalureAdmin','active')", [targetMemberId, target.workspaceId, owner.authIdentityId, owner.email]);
    await db.admin.query("insert into knowledge_center_entitlements(workspace_id,enabled,max_sources,max_storage_bytes,max_queries_per_month,contract_reference,features,limits) values($1,true,20,1000000,100,'SYNTHETIC-TARGET-B','{\"webchatAccess\":true,\"voiceAccess\":true}','{\"maxAreas\":5,\"maxWebsites\":5,\"maxScansPerMonth\":5,\"maxUsers\":5,\"maxAssistants\":5}')", [target.workspaceId]);
    const targetSession: AppSession = { ...session, workspaceId: target.workspaceId, userId: targetMemberId, role: "admin", productRole: "novalureAdmin", authIdentityId: owner.authIdentityId };
    const targetArea = await createKnowledgeArea(targetSession, { name: "Target B knowledge", kind: "company" }, options);
    const targetSource = await createKnowledgeSource(targetSession, { areaId: targetArea.id, type: "manual", name: "Target B approved source", content: "Welche freigegebenen Projektdetails darf ich einem Interessenten nennen? TARGET_B_KNOWLEDGE" }, options);
    await publishKnowledgeSource(targetSession, { sourceId: targetSource.id, versionId: targetSource.draftVersionId!, expectedVersion: targetSource.revision }, options);
    await assignKnowledgeAreas(targetSession, { botId: targetBotId, channel: "webchat", areaIds: [targetArea.id] }, options);
    const targetKnowledge = await legacy.GET(request("/api/bots/knowledge?limit=50&workspaceId=" + target.workspaceId));
    assert.equal(targetKnowledge.status, 200, await targetKnowledge.clone().text());
    assert.deepEqual((await targetKnowledge.json()).sources.map((source: { id: string }) => source.id), [targetSource.id]);
    const targetEvaluation = await evaluations.POST(request("/api/bots/evaluations" + targetSelector, "POST", evaluationBody));
    assert.equal(targetEvaluation.status, 201, await targetEvaluation.clone().text());
    const targetRun = (await targetEvaluation.json()).run;
    assert.equal(targetRun.workspaceId, target.workspaceId);
    assert.equal(targetRun.sourceCoverage, 100);
    const targetRuns = await evaluations.GET(request("/api/bots/evaluations" + targetSelector));
    assert.equal(targetRuns.status, 200, await targetRuns.clone().text());
    assert.equal((await targetRuns.json()).runs[0].workspaceId, target.workspaceId);
    const targetChat = await chat.POST(request("/api/bots/chat" + targetSelector, "POST", targetChatBody));
    assert.equal(targetChat.status, 200, await targetChat.clone().text());
    const targetConversationId = (await targetChat.json()).conversationId;
    const targetMessages = await chat.GET(request("/api/bots/chat" + targetSelector + "&conversationId=" + targetConversationId));
    assert.equal(targetMessages.status, 200, await targetMessages.clone().text());
    assert.equal((await targetMessages.json()).messages.length, 2);
    const targetAgent = await agent.POST(request("/api/bots/agent" + targetSelector, "POST", { prompt: "TARGET_B_KNOWLEDGE", tool: "search_approved_knowledge", input: { botId: targetBotId, channel: "webchat", query: "TARGET_B_KNOWLEDGE" } }));
    assert.equal(targetAgent.status, 200, await targetAgent.clone().text());
    assert.equal((await targetAgent.json()).result.sources[0].sourceId, targetSource.id);
    const visibleProjectId = randomUUID(), visibleBotId = randomUUID(), visibleRunId = randomUUID();
    await db.admin.query("insert into projects(id,workspace_id,name,type) values($1,$2,'Granted target project','Bauträger')", [visibleProjectId, target.workspaceId]);
    await db.admin.query("insert into bots(id,workspace_id,project_id,name,role) values($1,$2,$3,'Granted target bot','sales')", [visibleBotId, target.workspaceId, visibleProjectId]);
    await db.admin.query("insert into bot_evaluation_runs(id,workspace_id,project_id,bot_id,result) values($1,$2,$3,$4,'{\"evaluationChannel\":\"webchat\"}')", [visibleRunId, target.workspaceId, visibleProjectId, visibleBotId]);
    await db.admin.query("insert into project_pipeline_permissions(workspace_id,project_id,user_id,can_read,can_edit_deals) values($1,$2,$3,true,true)", [target.workspaceId, visibleProjectId, targetMemberId]);
    await db.admin.query("update workspace_users set role='agent',product_role='novalureServiceOps' where id=$1", [targetMemberId]);
    const restrictedRuns = await evaluations.GET(request("/api/bots/evaluations" + targetSelector));
    assert.equal(restrictedRuns.status, 200, await restrictedRuns.clone().text());
    const restrictedData = (await restrictedRuns.json()).runs;
    assert.deepEqual(restrictedData.map((run: { id: string }) => run.id), [visibleRunId]);
    assert.doesNotMatch(JSON.stringify(restrictedData), new RegExp(targetRun.id + "|" + targetBotId + "|" + target.projectId));
    assert.equal((await evaluations.POST(request("/api/bots/evaluations" + targetSelector, "POST", evaluationBody))).status, 403, "origin A approval privilege must not replace B's downgraded role");
    await db.admin.query("update workspace_users set status='invited' where id=$1", [targetMemberId]);
    for (const [handler, pathname, body] of [
      [chat.POST, "/api/bots/chat", targetChatBody],
      [evaluations.POST, "/api/bots/evaluations", evaluationBody],
      [agent.POST, "/api/bots/agent", { prompt: "TARGET_B_KNOWLEDGE", input: { botId: targetBotId, channel: "webchat" } }],
    ] as const) {
      assert.equal((await handler(request(pathname + targetSelector, "POST", body))).status, 403);
    }
    assert.equal((await chat.GET(request("/api/bots/chat" + targetSelector))).status, 403);
    assert.equal((await evaluations.GET(request("/api/bots/evaluations" + targetSelector))).status, 403);
    const stored = (await db.admin.query("select workspace_id,actor_user_id from audit_logs where workspace_id=$1 and action='workspace.cross_workspace_view'", [target.workspaceId])).rows;
    assert.ok(stored.length > 0);
    assert.ok(stored.every((row) => row.actor_user_id === targetMemberId));
  } finally {
    await closeLocalTestPool();
    for (const key of keys) { if (prior[key] === undefined) delete process.env[key]; else process.env[key] = prior[key]; }
  }
});
