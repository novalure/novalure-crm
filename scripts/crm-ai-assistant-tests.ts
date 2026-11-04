import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { startLocalSalesDb, applySalesSchema } from "./lib/local-sales-db.mjs";
import { createCsrfToken } from "../src/lib/security/csrf-core";
import { closeLocalTestPool } from "../src/lib/db/local-test-transport";
import { parseAssistantRequest, readAssistantOutput } from "../src/lib/crm-ai-assistant/policy";

async function seedAssistantCustomer(db: Awaited<ReturnType<typeof startLocalSalesDb>>) {
  const workspaceId = randomUUID(), userId = randomUUID(), projectId = randomUUID(), developerContactId = randomUUID();
  const email = userId + "@example.invalid";
  await db.admin.query("insert into workspaces(id,name,operating_model,customer_type) values($1,'SYNTHETIC AI customer','self_service_customer','property_developer')", [workspaceId]);
  const user = await db.admin.query("insert into workspace_users(id,workspace_id,name,email,role,product_role,status) values($1,$2,'SYNTHETIC AI owner',$3,'owner','customer_owner','active') returning auth_identity_id", [userId, workspaceId, email]);
  const authIdentityId = user.rows[0].auth_identity_id;
  await db.admin.query("update auth_identities set credential_state='active' where id=$1", [authIdentityId]);
  await db.admin.query("insert into projects(id,workspace_id,name,type,customer_type,default_operating_model) values($1,$2,'SYNTHETIC Customer Project','Bauträger','property_developer','self_service_customer')", [projectId, workspaceId]);
  await db.admin.query("insert into contacts(id,workspace_id,project_id,owner_user_id,name,email,role) values($1,$2,$3,$4,'SYNTHETIC Customer Contact','synthetic-developer@example.invalid','Interessent')", [developerContactId, workspaceId, projectId, userId]);
  return { workspaceId, userId, projectId, developerContactId, authIdentityId, email };
}

test("assistant payloads and email outputs are bounded and explicit", () => {
  assert.throws(() => parseAssistantRequest({ mode: "crm_question", prompt: "", language: "de" }));
  assert.throws(() => parseAssistantRequest({ mode: "daily_briefing", prompt: "ok", language: "de", workspaceId: randomUUID() }));
  assert.throws(() => parseAssistantRequest({ mode: "property_text", prompt: "", language: "de" }));
  assert.throws(() => parseAssistantRequest({ mode: "crm_question", prompt: "ok", language: "de", timeZone: "invalid" }));
  assert.throws(() => readAssistantOutput('{"subject":"Hello\\r\\nBcc: x","body":"test"}', "email_draft"));
  assert.throws(() => readAssistantOutput("sent successfully", "email_draft"));
  assert.equal(readAssistantOutput('{"subject":"Besichtigung","body":"Bitte um Rückmeldung."}', "email_draft").email?.subject, "Besichtigung");
});

test("real assistant HTTP flow stays tenant scoped, metered and idempotent", { timeout: 240000 }, async t => {
  const db = await startLocalSalesDb();
  const keys = ["DATABASE_URL", "NODE_ENV", "CRM_LOCAL_TEST_DATABASE", "NOVALURE_SESSION_SECRET", "NOVALURE_APP_ORIGIN", "NOVALURE_AUTH_STRICT", "NOVALURE_AUTH_ENCRYPTION_KEY", "NOVALURE_AUTH_RATE_LIMIT_SECRET", "NOVALURE_DEMO_AUTH_ENABLED", "NOVALURE_TRUST_AUTH_HEADERS", "VERCEL", "VERCEL_ENV", "VERCEL_URL", "AI_GATEWAY_API_KEY", "VERCEL_AI_GATEWAY_API_KEY", "NOVALURE_LLM_MODEL", "NOVALURE_LLM_BASE_URL", "NOVALURE_LLM_API_KEY"];
  const original = Object.fromEntries(keys.map(k => [k, process.env[k]])), originalFetch = globalThis.fetch;
  try {
    await applySalesSchema(db, { maxMigrationNumber: 106 });
    await db.admin.query("alter default privileges in schema public grant select,insert,update,delete on tables to novalure_app");
    await db.admin.query("alter default privileges in schema public grant execute on functions to novalure_app");
    for (const migration of ["146_ai_credit_billing", "152_ai_billing_admin", "153_ai_billing_runtime_acl", "188_crm_ai_assistant"]) await db.admin.query(await readFile(`migrations/${migration}.sql`, "utf8"));
    const customer = await seedAssistantCustomer(db), foreign = await seedAssistantCustomer(db);
    for (const person of [customer, foreign]) {
      await db.admin.query("update workspaces set operating_model='self_service_customer' where id=$1", [person.workspaceId]);
      await db.admin.query("update workspace_users set product_role='customer_owner' where id=$1", [person.userId]);
    }
    const leadId = randomUUID(), foreignLead = randomUUID(), propertyId = randomUUID(), taskId = randomUUID();
    await db.admin.query("insert into leads(id,workspace_id,project_id,contact_id,type,status,intent,next_action) values($1,$2,$3,$4,'Käufer','Neu','SYNTHETIC CUSTOMER A: sucht Wohnung','Rückruf vereinbaren')", [leadId, customer.workspaceId, customer.projectId, customer.developerContactId]);
    await db.admin.query("insert into leads(id,workspace_id,project_id,contact_id,type,status,intent) values($1,$2,$3,$4,'Käufer','Neu','FOREIGN TENANT SECRET')", [foreignLead, foreign.workspaceId, foreign.projectId, foreign.developerContactId]);
    await db.admin.query("insert into seller_listings(id,workspace_id,project_id,title,address,region,object_type,area_sqm,rooms) values($1,$2,$3,'SYNTHETIC Wohnung','Teststraße 1','Tirol','Wohnung',80,3)", [propertyId, customer.workspaceId, customer.projectId]);
    await db.admin.query("insert into tasks(id,workspace_id,project_id,lead_id,owner_user_id,title,due_at) values($1,$2,$3,$4,$5,'SYNTHETIC Rückruf',now()-interval '1 day')", [taskId, customer.workspaceId, customer.projectId, leadId, customer.userId]);
    const secret = randomBytes(48).toString("base64url"), origin = "http://127.0.0.1:3000", path = "/api/crm/ai-assistant";
    for (const key of keys) delete process.env[key];
    Object.assign(process.env, { DATABASE_URL: `postgresql://${db.role}@127.0.0.1:${db.port}/postgres`, NODE_ENV: "test", CRM_LOCAL_TEST_DATABASE: "1", NOVALURE_SESSION_SECRET: secret, NOVALURE_APP_ORIGIN: origin, NOVALURE_AUTH_STRICT: "1", NOVALURE_AUTH_ENCRYPTION_KEY: randomBytes(40).toString("hex"), NOVALURE_AUTH_RATE_LIMIT_SECRET: randomBytes(40).toString("hex"), AI_GATEWAY_API_KEY: "synthetic-provider-key" });
    async function cookieFor(person: typeof customer) {
      const token = "v2." + randomBytes(32).toString("base64url");
      await db.admin.query("insert into auth_sessions(id,token_hash,auth_identity_id,workspace_user_id,workspace_id,mfa_verified_at,expires_at) values($1,$2,$3,$4,$5,now(),now()+interval '1 hour')", [randomUUID(), createHash("sha256").update(token).digest("hex"), person.authIdentityId, person.userId, person.workspaceId]);
      return token;
    }
    const cookie = await cookieFor(customer), foreignCookie = await cookieFor(foreign);
    const route = await import("../src/app/api/crm/ai-assistant/route");
    const query = `?projectId=${customer.projectId}&timeZone=Europe%2FVienna&language=de`;
    function request(method: "GET" | "POST", body?: unknown, options: { cookie?: string; query?: string; key?: string; headers?: Record<string, string> } = {}) {
      const token = options.cookie ?? cookie;
      return new Request(origin + path + (options.query ?? query), { method, headers: { cookie: "novalure_session=" + token, ...(method === "POST" ? { "content-type": "application/json", origin, "sec-fetch-site": "same-origin", "idempotency-key": options.key ?? randomUUID(), "x-novalure-csrf-token": createCsrfToken({ method, pathname: path, secret, sessionCookie: token })!.token } : {}), ...options.headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    }
    let providerCalls = 0, lastPrompt = "", responseKind: "success" | "reject" | "unknown" | "invalid" = "success";
    globalThis.fetch = async (url, init) => {
      assert.equal(String(url), "https://ai-gateway.vercel.sh/v1/chat/completions");
      providerCalls++; lastPrompt = String(init?.body);
      if (responseKind === "reject") return new Response("rejected", { status: 400 });
      if (responseKind === "unknown") throw new Error("SYNTHETIC network outcome unknown");
      const email = lastPrompt.includes("Return ONLY a JSON object");
      return Response.json({ choices: [{ message: { content: responseKind === "invalid" ? "not json" : email ? JSON.stringify({ subject: "Ihre Besichtigungsanfrage", body: "Guten Tag, bitte nennen Sie uns einen passenden Termin. Freundliche Grüße [bitte ergänzen]" }) : "SYNTHETIC Vorschlag: zuerst den überfälligen Rückruf erledigen." } }], usage: { prompt_tokens: 100, completion_tokens: 60 } });
    };
    const body = (mode = "daily_briefing", extra: Record<string, unknown> = {}) => ({ mode, prompt: "", language: "de", timeZone: "Europe/Vienna", projectId: customer.projectId, ...extra });
    async function get() { const r = await route.GET(request("GET")); assert.equal(r.status, 200, await r.clone().text()); return (await r.json()).data; }
    async function post(input = body(), expected = 201, options: Parameters<typeof request>[2] = {}) { const r = await route.POST(request("POST", input, options)); assert.equal(r.status, expected, await r.clone().text()); assert.equal(r.headers.get("cache-control"), "private, no-store"); return r.json(); }
    await t.test("only durable sessions with CSRF and explicit scope can generate", async () => {
      assert.equal((await route.GET(new Request(origin + path))).status, 401);
      await post(body(), 403, { headers: { "x-novalure-csrf-token": "" } });
      await post(body(), 403, { headers: { origin: "https://foreign.invalid" } });
      await post(body(), 400, { query: "" });
      await post(body("crm_question", { prompt: "hello", context: "FORGED DATA" }), 400);
      const initial = await get(); assert.equal(initial.credits.availableCredits, 1000); assert.equal(initial.metrics.overdueTasks, 1);
      assert.ok(initial.options.leads.some((l: { id: string }) => l.id === leadId)); assert.ok(!JSON.stringify(initial).includes("FOREIGN TENANT SECRET"));
      assert.equal(providerCalls, 0);
    });
    await t.test("a real metered call generates one durable response and retry is free", async () => {
      const key = randomUUID(), before = providerCalls, first = await post(body(), 201, { key });
      assert.equal(first.data.status, "completed"); assert.equal(first.data.chargedCredits, 1);
      assert.ok(first.data.sources.some((s: { id: string }) => s.id === taskId)); assert.ok(lastPrompt.includes("SYNTHETIC CUSTOMER A")); assert.ok(!lastPrompt.includes("FOREIGN TENANT SECRET"));
      const replay = await post(body(), 200, { key }); assert.deepEqual(replay.data, first.data); assert.equal(providerCalls, before + 1);
      await post(body("daily_briefing", { prompt: "different" }), 409, { key });
      const snapshot = await get(); assert.equal(snapshot.credits.availableCredits, 999); assert.equal(snapshot.credits.reservedCredits, 0); assert.equal(snapshot.recentRuns.length, 1);
    });
    await t.test("lead email and property tasks use the selected server records", async () => {
      const email = await post(body("email_draft", { leadId, sourceText: "SYNTHETIC: Ich interessiere mich für eine Besichtigung.", tone: "friendly" }));
      assert.equal(email.data.email.recipient, "synthetic-developer@example.invalid"); assert.equal(email.data.email.subject, "Ihre Besichtigungsanfrage"); assert.ok(!lastPrompt.includes("FOREIGN TENANT SECRET"));
      await post(body("lead_summary", { leadId })); await post(body("property_text", { propertyId }));
      assert.ok(lastPrompt.includes("askingPriceCents")); assert.ok(lastPrompt.includes("SYNTHETIC Wohnung"));
      const before = providerCalls; await post(body("lead_summary", { leadId: foreignLead }), 403); await post(body("property_text", { propertyId: randomUUID() }), 403); assert.equal(providerCalls, before);
    });
    await t.test("provider rejection is terminal, refunds reservation and never becomes a fake answer", async () => {
      const before = (await get()).credits.availableCredits, key = randomUUID(); responseKind = "reject";
      const failed = await post(body(), 502, { key }); assert.equal(failed.code, "AI_PROVIDER_REJECTED"); assert.equal(failed.terminal, true);
      const calls = providerCalls; await post(body(), 502, { key }); assert.equal(providerCalls, calls); assert.equal((await get()).credits.availableCredits, before); responseKind = "success";
    });
    await t.test("unknown provider outcome keeps its hold and does not retry remotely", async () => {
      responseKind = "unknown"; const key = randomUUID(); const failed = await post(body(), 502, { key }); assert.equal(failed.code, "AI_PROVIDER_OUTCOME_UNKNOWN"); assert.equal(failed.terminal, true);
      assert.ok((await get()).credits.reservedCredits > 0); const calls = providerCalls; await post(body(), 502, { key }); assert.equal(providerCalls, calls); responseKind = "success";
    });
    await t.test("malformed email is a charged terminal failure and is not shown as completed", async () => {
      responseKind = "invalid"; const before = (await get()).recentRuns.length; const failed = await post(body("email_draft", { leadId }), 502); assert.equal(failed.code, "AI_OUTPUT_INVALID"); assert.equal((await get()).recentRuns.length, before); responseKind = "success";
    });
    await t.test("a different company and forged headers cannot retrieve private work products", async () => {
      const r = await route.GET(request("GET", undefined, { cookie: foreignCookie, query: `?workspaceId=${customer.workspaceId}&projectId=${customer.projectId}` })); assert.equal(r.status, 403);
      const foreignSnapshot = await route.GET(request("GET", undefined, { cookie: foreignCookie, query: `?projectId=${foreign.projectId}` })); assert.equal(foreignSnapshot.status, 200); assert.equal((await foreignSnapshot.json()).data.recentRuns.length, 0);
      await post(body(), 401, { headers: { cookie: "", "x-novalure-workspace-id": customer.workspaceId, "x-novalure-user-id": customer.userId, "x-novalure-role": "owner" } });
    });
    await t.test("disabled modules and fresh role revocation stop generation and cached answers", async () => {
      await db.admin.query("insert into workspace_module_settings(workspace_id,module_key,enabled) values($1,'bots',false) on conflict(workspace_id,module_key) do update set enabled=false", [customer.workspaceId]);
      const calls = providerCalls; await post(body(), 403); assert.equal(providerCalls, calls);
      await db.admin.query("delete from workspace_module_settings where workspace_id=$1 and module_key='bots'", [customer.workspaceId]);
      await db.admin.query("update workspace_users set product_role='viewer' where id=$1", [customer.userId]);
      assert.equal((await route.GET(request("GET"))).status, 403); await post(body(), 403);
      await db.admin.query("update workspace_users set product_role='customer_owner' where id=$1", [customer.userId]);
    });
    await t.test("production default grants cannot write assistant receipts directly", async () => {
      const rights = (await db.admin.query("select has_table_privilege($1,'crm_ai_assistant_runs','INSERT') as insert,has_table_privilege($1,'crm_ai_assistant_runs','UPDATE') as update,has_function_privilege($1,'crm_assistant_actor(uuid)','EXECUTE') as raw_actor", [db.role])).rows[0];
      assert.deepEqual(rights, { insert: false, update: false, raw_actor: false });
    });
  } finally {
    globalThis.fetch = originalFetch;
    await closeLocalTestPool();
    for (const key of keys) { if (original[key] === undefined) delete process.env[key]; else process.env[key] = original[key]; }
    await db.stop();
  }
});
