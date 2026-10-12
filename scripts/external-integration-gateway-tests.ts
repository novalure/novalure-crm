import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { applySalesSchema, startLocalSalesDb } from "./lib/local-sales-db.mjs";
import { closeLocalTestPool } from "../src/lib/db/local-test-transport";
import { GET as getPublicForm } from "../src/app/api/public/integrations/forms/route";
import { POST as submitPublicForm } from "../src/app/api/public/integrations/forms/submissions/route";
import {
  GET as getChatSession,
  POST as startChatSession,
} from "../src/app/api/public/integrations/chat/sessions/route";
import { POST as appendChatMessage } from "../src/app/api/public/integrations/chat/messages/route";
import {
  createWebsiteIntegration,
  listWebsiteIntegrations,
  updateWebsiteIntegrationStatus,
} from "../src/lib/db/external-integration-repositories";

const origin = "https://customer.example";
const workspaceId = randomUUID();
const foreignWorkspaceId = randomUUID();
const actorId = randomUUID();
const foreignActorId = randomUUID();
const projectId = randomUUID();
const foreignProjectId = randomUUID();
const formId = randomUUID();
const siteKey = `nov_pk_${formId.replaceAll("-", "")}`;
let db: Awaited<ReturnType<typeof startLocalSalesDb>>;
const savedEnv = {
  CRM_LOCAL_TEST_DATABASE: process.env.CRM_LOCAL_TEST_DATABASE,
  DATABASE_URL: process.env.DATABASE_URL,
  NOVALURE_ABUSE_SECRET: process.env.NOVALURE_ABUSE_SECRET,
  NOVALURE_TRUSTED_CLIENT_IP_HEADER: process.env.NOVALURE_TRUSTED_CLIENT_IP_HEADER,
  NODE_ENV: process.env.NODE_ENV,
};

before(async () => {
  db = await startLocalSalesDb();
  await applySalesSchema(db, { includeD11Contract: false, maxMigrationNumber: 90 });
  await db.admin.query(
    `insert into workspaces(id,name,operating_model,public_key) values
       ($1,'SYNTHETIC customer','self_service_customer','customer-public'),
       ($2,'SYNTHETIC foreign','self_service_customer','foreign-public')`,
    [workspaceId, foreignWorkspaceId],
  );
  await db.admin.query(
    `insert into workspace_users(id,workspace_id,name,email,role,product_role,status) values
       ($1,$2,'SYNTHETIC owner','owner@example.invalid','owner','customer_owner','active'),
       ($3,$4,'SYNTHETIC foreign owner','foreign@example.invalid','owner','customer_owner','active')`,
    [actorId, workspaceId, foreignActorId, foreignWorkspaceId],
  );
  await db.admin.query(
    `insert into projects(id,workspace_id,name,type) values
       ($1,$2,'SYNTHETIC customer project','Bauträger'),
       ($3,$4,'SYNTHETIC foreign project','Bauträger')`,
    [projectId, workspaceId, foreignProjectId, foreignWorkspaceId],
  );
  await db.admin.query(
    `insert into forms(id,workspace_id,project_id,owner_user_id,name,slug,status,fields,actions)
     values($1,$2,$3,$4,'SYNTHETIC gateway form','gateway-form','aktiv',
       '[{"id":"name","crmField":"name","label":"Name","type":"text","required":true},{"id":"email","crmField":"email","label":"Email","type":"email","required":true},{"id":"privacy","crmField":"privacy","label":"Privacy","type":"consent","required":true}]'::jsonb,
       '{"createTask":true,"thankYouMessage":"Thank you"}'::jsonb)`,
    [formId, workspaceId, projectId, actorId],
  );
  await db.admin.query(
    `insert into novalure_schema_migrations(version,name,checksum) values
      ('094_website_sales_ingestion','094_website_sales_ingestion.sql','synthetic-prerequisite')`,
  );
  await db.admin.query(await readFile(new URL("../migrations/095_form_tenant_isolation.sql", import.meta.url), "utf8"));
  await db.admin.query(
    `insert into novalure_schema_migrations(version,name,checksum) values
      ('095_form_tenant_isolation','095_form_tenant_isolation.sql','synthetic-prerequisite')`,
  );
  await db.admin.query(await readFile(new URL("../migrations/096_public_integration_gateway.sql", import.meta.url), "utf8"));
  await db.admin.query(
    `update external_integrations set allowed_origins=array[$2],
       capabilities=array['form.read','form.submit','lead.create','chat.start','chat.message'],
       mode='training' where public_site_key=$1`,
    [siteKey, origin],
  );
  await db.admin.query(
    `update external_integration_widget_configs set chat_enabled=true,
       enabled_capabilities=array['form.read','form.submit','lead.create','chat.start','chat.message']
     where integration_id=(select id from external_integrations where public_site_key=$1)`,
    [siteKey],
  );
  Object.assign(process.env, {
    CRM_LOCAL_TEST_DATABASE: "1",
    DATABASE_URL: `postgresql://${db.role}@127.0.0.1:${db.port}/postgres`,
    NODE_ENV: "test",
    NOVALURE_ABUSE_SECRET: "synthetic-external-integration-abuse-secret-0001",
    NOVALURE_TRUSTED_CLIENT_IP_HEADER: "x-test-client-ip",
  });
});

after(async () => {
  await closeLocalTestPool();
  if (db) await db.stop();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete (process.env as Record<string, string | undefined>)[key];
    else (process.env as Record<string, string | undefined>)[key] = value;
  }
});

test("096 forces RLS, disables the lookup login, and exposes only scoped runtime functions", async () => {
  const flags = await db.admin.query<{ relforcerowsecurity: boolean; relname: string; relrowsecurity: boolean }>(
    `select relname,relrowsecurity,relforcerowsecurity from pg_class
     where oid in (
       'public.forms'::regclass,'public.form_submissions'::regclass,
       'public.external_integrations'::regclass,
       'public.external_integration_widget_configs'::regclass,
       'public.external_chat_sessions'::regclass,
       'public.external_chat_messages'::regclass,
       'public.external_integration_events'::regclass
     ) order by relname`,
  );
  assert.equal(flags.rows.length, 7);
  assert.ok(flags.rows.every((row) => row.relrowsecurity && row.relforcerowsecurity));
  const legacy = await db.admin.query<{ rolcanlogin: boolean; rolpassword: string | null }>(
    "select rolcanlogin,rolpassword from pg_authid where rolname='novalure_public_form_lookup'",
  );
  assert.deepEqual(legacy.rows[0], { rolcanlogin: false, rolpassword: null });
  const compatibility = await db.pool.query<{ form: { id: string } | null }>(
    "select public.crm_public_form_lookup(null,'customer-public','gateway-form') as form",
  );
  assert.equal(compatibility.rows[0]?.form?.id, formId);
  const valid = await db.pool.query(
    "select * from public.crm_external_integration_resolve($1,$2,'form.read',$3)",
    [siteKey, origin, formId],
  );
  assert.equal(valid.rowCount, 1);
  assert.equal(valid.rows[0].workspace_id, workspaceId);
  assert.equal((await db.pool.query(
    "select * from public.crm_external_integration_resolve($1,$2,'form.read',$3)",
    [siteKey, "https://wrong.example", formId],
  )).rowCount, 0);
  assert.equal((await db.pool.query(
    "select * from public.crm_external_integration_resolve($1,$2,'appointment.request',$3)",
    [siteKey, origin, formId],
  )).rowCount, 0);
  assert.equal((await db.pool.query(
    "select * from public.crm_external_integration_resolve($1,$2,'form.read',$3)",
    [siteKey, origin, randomUUID()],
  )).rowCount, 0);
  assert.equal((await db.pool.query("select id from external_integrations")).rowCount, 0);
});

test("tenant and project context cannot be selected by the public caller", async () => {
  const client = await db.pool.connect();
  try {
    await client.query("begin");
    await client.query("select set_config('app.tenant_id',$1,true),set_config('app.actor_id',$2,true)", [workspaceId, actorId]);
    assert.equal((await client.query("select id from external_integrations where workspace_id=$1", [workspaceId])).rowCount, 1);
    assert.equal((await client.query("select id from external_integrations where workspace_id=$1", [foreignWorkspaceId])).rowCount, 0);
    const originalIntegration = (await client.query<{ id: string }>(
      "select id from external_integrations where public_site_key=$1",
      [siteKey],
    )).rows[0]!.id;
    const alternateIntegration = randomUUID();
    const sessionId = randomUUID();
    await client.query(
      `insert into external_integrations(id,public_site_key,workspace_id,project_id,integration_type,
         allowed_origins,capabilities,created_by)
       values($1,$2,$3,$4,'website_chat',array[$5],array['chat.start','chat.message'],$6)`,
      [alternateIntegration, `nov_pk_${randomUUID().replaceAll("-", "")}`, workspaceId, projectId, origin, actorId],
    );
    await client.query(
      `insert into external_chat_sessions(id,integration_id,workspace_id,project_id,session_token_hash,
         idempotency_hash,mode,language,synthetic)
       values($1,$2,$3,$4,$5,$6,'training','en',true)`,
      [sessionId, alternateIntegration, workspaceId, projectId, "a".repeat(64), "b".repeat(64)],
    );
    await client.query("savepoint mismatched_chat_integration");
    await assert.rejects(
      client.query(
        `insert into external_chat_messages(session_id,integration_id,workspace_id,role,content,idempotency_hash,synthetic)
         values($1,$2,$3,'visitor','SYNTHETIC mismatch',$4,true)`,
        [sessionId, originalIntegration, workspaceId, "c".repeat(64)],
      ),
      /foreign key|row-level security/,
    );
    await client.query("rollback to savepoint mismatched_chat_integration");
    await client.query("release savepoint mismatched_chat_integration");
    await assert.rejects(
      client.query(
        `insert into external_integrations(public_site_key,workspace_id,project_id,integration_type,allowed_origins,capabilities,created_by)
         values($1,$2,$3,'customer_website',array[$4],array['form.read'],$5)`,
        [`nov_pk_${randomUUID().replaceAll("-", "")}`, workspaceId, foreignProjectId, origin, actorId],
      ),
      /foreign key|row-level security/,
    );
    await client.query("rollback");
  } finally {
    client.release();
  }
});

test("a resolved integration is locked against concurrent revocation until the request ends", async () => {
  const runtime = await db.pool.connect();
  const owner = await db.admin.connect();
  try {
    await runtime.query("begin");
    assert.equal((await runtime.query(
      "select * from public.crm_external_integration_resolve($1,$2,'form.submit',$3)",
      [siteKey, origin, formId],
    )).rowCount, 1);
    await owner.query("begin");
    await owner.query("set local lock_timeout='100ms'");
    await assert.rejects(
      owner.query(
        "update external_integrations set status='revoked',revoked_at=now() where public_site_key=$1",
        [siteKey],
      ),
      /lock timeout/,
    );
    await owner.query("rollback");
    await runtime.query("commit");
  } finally {
    await Promise.allSettled([runtime.query("rollback"), owner.query("rollback")]);
    runtime.release();
    owner.release();
  }
});

test("authenticated onboarding creates a test integration and enforces tenant project scope", async () => {
  const session = { workspaceId, userId: actorId } as Parameters<typeof createWebsiteIntegration>[0];
  await assert.rejects(
    createWebsiteIntegration(session, {
      allowedOrigins: [origin],
      capabilities: ["chat.start", "chat.message"],
      integrationType: "website_chat",
      mode: "training",
      projectId: foreignProjectId,
    }),
    /Project not found/,
  );
  const created = await createWebsiteIntegration(session, {
    allowedOrigins: [origin],
    capabilities: ["chat.start", "chat.message"],
    integrationType: "website_chat",
    mode: "training",
    projectId,
    widget: { chatEnabled: true, enabledCapabilities: [] },
  });
  assert.match(created.publicSiteKey, /^nov_pk_[A-Za-z0-9_-]{32}$/u);
  const listed = await listWebsiteIntegrations(session);
  assert.ok(listed.some((integration) => integration.id === created.id && integration.status === "test"));
  assert.deepEqual(listed.find((integration) => integration.id === created.id)?.widget.enabledCapabilities, []);
  assert.deepEqual(
    await updateWebsiteIntegrationStatus(session, { integrationId: created.id, status: "revoked" }),
    { id: created.id, status: "revoked" },
  );
  assert.equal((await db.pool.query(
    "select * from public.crm_external_integration_resolve($1,$2,'chat.start',null)",
    [created.publicSiteKey, origin],
  )).rowCount, 0);
});

test("public form lookup and submission use site mapping, origin, rate and idempotency controls", async () => {
  const lookup = await getPublicForm(new Request(
    `https://crm.example/api/public/integrations/forms?site_key=${siteKey}`,
    { headers: { origin, "x-test-client-ip": "203.0.113.10" } },
  ));
  assert.equal(lookup.status, 200);
  const lookupBody = await lookup.json() as Record<string, unknown>;
  assert.equal((lookupBody.form as { id: string }).id, formId);
  assert.equal(JSON.stringify(lookupBody).includes(workspaceId), false);
  assert.equal(JSON.stringify(lookupBody).includes(projectId), false);

  const wrongOrigin = await getPublicForm(new Request(
    `https://crm.example/api/public/integrations/forms?site_key=${siteKey}`,
    { headers: { origin: "https://wrong.example", "x-test-client-ip": "203.0.113.10" } },
  ));
  assert.equal(wrongOrigin.status, 404);

  const idempotencyKey = "gateway_form_submission_idempotency_0001";
  const request = () => new Request("https://crm.example/api/public/integrations/forms/submissions", {
    body: JSON.stringify({
      fields: { email: "gateway@example.invalid", name: "SYNTHETIC Gateway", privacy: "true" },
      formId,
      actorId: foreignActorId,
      projectId: foreignProjectId,
      siteKey,
      workspaceId: foreignWorkspaceId,
    }),
    headers: {
      "content-type": "application/json",
      "idempotency-key": idempotencyKey,
      origin,
      "x-test-client-ip": "203.0.113.10",
    },
    method: "POST",
  });
  const first = await submitPublicForm(request());
  const replay = await submitPublicForm(request());
  assert.equal(first.status, 202);
  assert.equal(replay.status, 202);
  assert.deepEqual(await replay.json(), await first.json());
  assert.equal((await db.admin.query("select id from form_submissions where workspace_id=$1", [workspaceId])).rowCount, 1);
  assert.equal((await db.admin.query("select id from leads where workspace_id=$1", [workspaceId])).rowCount, 1);
  assert.equal((await db.admin.query("select id from form_submissions where workspace_id=$1", [foreignWorkspaceId])).rowCount, 0);
  const stored = await db.admin.query<{ project_id: string; workspace_id: string }>(
    "select workspace_id,project_id from form_submissions where form_id=$1",
    [formId],
  );
  assert.deepEqual(stored.rows, [{ project_id: projectId, workspace_id: workspaceId }]);
});

test("public gateway fails closed for malformed, oversized, revoked, and capability-disabled requests", async () => {
  const headers = { origin, "x-test-client-ip": "203.0.113.12" };
  const wrongSite = await getPublicForm(new Request(
    "https://crm.example/api/public/integrations/forms?site_key=nov_pk_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    { headers },
  ));
  assert.equal(wrongSite.status, 404);
  const wrongForm = await getPublicForm(new Request(
    `https://crm.example/api/public/integrations/forms?site_key=${siteKey}&form_id=${foreignProjectId}`,
    { headers },
  ));
  assert.equal(wrongForm.status, 404);
  const malformed = await submitPublicForm(new Request(
    "https://crm.example/api/public/integrations/forms/submissions",
    { body: "{", headers: { ...headers, "content-type": "application/json" }, method: "POST" },
  ));
  assert.equal(malformed.status, 400);
  const oversized = await submitPublicForm(new Request(
    "https://crm.example/api/public/integrations/forms/submissions",
    {
      body: "{}",
      headers: { ...headers, "content-length": "70000", "content-type": "application/json" },
      method: "POST",
    },
  ));
  assert.equal(oversized.status, 413);
  const missingTrustedClientIp = await submitPublicForm(new Request(
    "https://crm.example/api/public/integrations/forms/submissions",
    {
      body: JSON.stringify({
        fields: { email: "missing-ip@example.invalid", name: "SYNTHETIC missing IP", privacy: "true" },
        formId,
        siteKey,
      }),
      headers: {
        "content-type": "application/json",
        "idempotency-key": "gateway_missing_trusted_client_ip_0001",
        origin,
      },
      method: "POST",
    },
  ));
  assert.equal(missingTrustedClientIp.status, 503);
  assert.deepEqual(await missingTrustedClientIp.json(), { error: "trusted_client_ip_unavailable" });

  await db.admin.query("update external_integrations set status='revoked',revoked_at=now() where public_site_key=$1", [siteKey]);
  const revoked = await getPublicForm(new Request(
    `https://crm.example/api/public/integrations/forms?site_key=${siteKey}`,
    { headers },
  ));
  assert.equal(revoked.status, 404);
  await db.admin.query(
    "update external_integrations set status='active',revoked_at=null,capabilities=array_remove(capabilities,'form.read') where public_site_key=$1",
    [siteKey],
  );
  const disabled = await getPublicForm(new Request(
    `https://crm.example/api/public/integrations/forms?site_key=${siteKey}`,
    { headers },
  ));
  assert.equal(disabled.status, 404);
  await db.admin.query(
    "update external_integrations set capabilities=array_append(capabilities,'form.read') where public_site_key=$1",
    [siteKey],
  );
});

test("training chat foundation is scoped, replay-safe, and has no CRM or outbound effect", async () => {
  const startKey = "gateway_chat_session_idempotency_key_0001";
  const startRequest = () => new Request("https://crm.example/api/public/integrations/chat/sessions", {
    body: JSON.stringify({ idempotencyKey: startKey, language: "en", siteKey }),
    headers: { "content-type": "application/json", origin, "x-test-client-ip": "203.0.113.11" },
    method: "POST",
  });
  const first = await startChatSession(startRequest());
  const replay = await startChatSession(startRequest());
  assert.equal(first.status, 201);
  assert.equal(replay.status, 201);
  const session = await first.json() as { mode: string; sessionId: string; sessionToken: string };
  assert.deepEqual(await replay.json(), session);
  assert.equal(session.mode, "training");

  const message = await appendChatMessage(new Request("https://crm.example/api/public/integrations/chat/messages", {
    body: JSON.stringify({
      idempotencyKey: "gateway_chat_message_idempotency_0001",
      message: "Hello Evelyn",
      sessionId: session.sessionId,
      siteKey,
    }),
    headers: {
      "content-type": "application/json",
      origin,
      "x-test-client-ip": "203.0.113.11",
      "x-novalure-session-token": session.sessionToken,
    },
    method: "POST",
  }));
  assert.equal(message.status, 202);
  const replayedMessage = await appendChatMessage(new Request("https://crm.example/api/public/integrations/chat/messages", {
    body: JSON.stringify({
      idempotencyKey: "gateway_chat_message_idempotency_0001",
      message: "Hello Evelyn",
      sessionId: session.sessionId,
      siteKey,
    }),
    headers: {
      "content-type": "application/json",
      origin,
      "x-test-client-ip": "203.0.113.11",
      "x-novalure-session-token": session.sessionToken,
    },
    method: "POST",
  }));
  assert.equal(replayedMessage.status, 202);
  assert.deepEqual(await replayedMessage.json(), await message.clone().json());
  const wrongToken = await getChatSession(new Request(
    `https://crm.example/api/public/integrations/chat/sessions?site_key=${siteKey}&session_id=${session.sessionId}`,
    { headers: {
      origin,
      "x-novalure-session-token": "A".repeat(43),
      "x-test-client-ip": "203.0.113.11",
    } },
  ));
  assert.equal(wrongToken.status, 403);
  const context = await getChatSession(new Request(
    `https://crm.example/api/public/integrations/chat/sessions?site_key=${siteKey}&session_id=${session.sessionId}`,
    { headers: {
      origin,
      "x-novalure-session-token": session.sessionToken,
      "x-test-client-ip": "203.0.113.11",
    } },
  ));
  assert.equal(context.status, 200);
  const contextBody = await context.json() as { messages: unknown[]; mode: string };
  assert.equal(contextBody.mode, "training");
  assert.equal(contextBody.messages.length, 1);
  assert.equal((contextBody.messages[0] as { content: string }).content, "Hello Evelyn");
  assert.equal((await db.admin.query("select id from external_chat_sessions where workspace_id=$1", [workspaceId])).rowCount, 1);
  assert.equal((await db.admin.query("select id from external_chat_messages where workspace_id=$1 and synthetic", [workspaceId])).rowCount, 1);
  assert.equal((await db.admin.query("select id from leads where workspace_id=$1", [workspaceId])).rowCount, 1);
  assert.equal((await db.admin.query(
    "select id from external_integration_events where workspace_id=$1",
    [workspaceId],
  )).rowCount, 8);
});

test("chat session creation is durably rate limited", async () => {
  const request = (index: number) => new Request("https://crm.example/api/public/integrations/chat/sessions", {
    body: JSON.stringify({
      idempotencyKey: `gateway_chat_rate_limit_${String(index).padStart(4, "0")}_${"x".repeat(20)}`,
      language: "en",
      siteKey,
    }),
    headers: {
      "content-type": "application/json",
      origin,
      "x-test-client-ip": "203.0.113.13",
    },
    method: "POST",
  });
  for (let index = 0; index < 20; index += 1) {
    assert.equal((await startChatSession(request(index))).status, 201);
  }
  assert.equal((await startChatSession(request(20))).status, 429);
});
