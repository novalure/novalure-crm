import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import type { AppSession } from "../src/lib/auth/session";
import { getRolePermissions } from "../src/lib/auth/permissions";
import { getProductRoleCapabilities } from "../src/lib/product-model";
import type { TenantTransactionOptions } from "../src/lib/db/tenant-client";
import { closeLocalTestPool } from "../src/lib/db/local-test-transport";
import {
  CRM_MACHINE_AUDIENCE, CRM_MACHINE_ENVIRONMENT, CRM_MACHINE_ISSUER,
  CRM_MACHINE_OWNER_ID, CRM_MACHINE_PROJECT_ID, CRM_MACHINE_SUBJECT,
  CRM_MACHINE_WORKSPACE_ID, type CrmMachineAuthOptions,
} from "../src/lib/crm-machine-auth";
import { retrieveAssistantKnowledge, type AssistantKnowledgeContext } from "../src/lib/knowledge-center/integrations";
import { handleMachineKnowledgeRequest } from "../src/lib/knowledge-center/assistant-http";
import {
  archiveKnowledgeArea, archiveKnowledgeSource, assignKnowledgeAreas,
  createKnowledgeArea, createKnowledgeSource, publishKnowledgeSource, updateKnowledgeSource,
} from "../src/lib/knowledge-center/repository";
import { applySalesSchema, startLocalSalesDb } from "./lib/local-sales-db.mjs";

let db: Awaited<ReturnType<typeof startLocalSalesDb>>;
let options: TenantTransactionOptions;
const ids = {
  workspace: randomUUID(), foreignWorkspace: randomUUID(), owner: randomUUID(), foreignOwner: randomUUID(),
  internalAdmin: randomUUID(), bot: randomUUID(), foreignBot: randomUUID(), machineBot: randomUUID(),
  principal: "8b3238e9-efea-459f-ac84-a08e2a6ec59b",
};
function session(actor: "owner" | "foreignOwner" | "internalAdmin" = "owner"): AppSession {
  const productRole = actor === "internalAdmin" ? "novalureAdmin" : "customer_owner";
  return {
    authenticated: true, userId: ids[actor],
    workspaceId: actor === "internalAdmin" ? CRM_MACHINE_WORKSPACE_ID : actor === "foreignOwner" ? ids.foreignWorkspace : ids.workspace,
    workspaceName: "SYNTHETIC assistant knowledge", email: `${actor}@example.invalid`, name: "SYNTHETIC owner",
    role: "owner", permissions: getRolePermissions("owner"), productRole,
    productPermissions: getProductRoleCapabilities(productRole), source: "database",
  };
}
const retrieve = (channel: "webchat" | "telephony", query = "serviceanchor", maxResults = 5) =>
  retrieveAssistantKnowledge(session(), { assistantId: ids.bot, channel, query, maxResults }, options);
function assertEmpty(context: AssistantKnowledgeContext) {
  assert.equal(context.answerStatus, "insufficient_knowledge");
  assert.deepEqual(context.excerpts, []);
  assert.equal(typeof context.fallback, "string");
  assert.ok(context.fallback!.length > 0);
}
async function published(actor: AppSession, areaId: string, name: string, content: string) {
  const source = await createKnowledgeSource(actor, { areaId, name, content, type: "manual" }, options);
  return publishKnowledgeSource(actor, { sourceId: source.id, versionId: source.draftVersionId!, expectedVersion: source.revision }, options);
}

let voiceArea: string, webArea: string, aliasArea: string;
let voiceSource: Awaited<ReturnType<typeof published>>;
const now = new Date(), nowSeconds = Math.floor(now.valueOf() / 1000);
const fakeToken = `eyJ${"a".repeat(20)}.${"b".repeat(24)}.${"c".repeat(24)}`;
type VerificationResult = Awaited<ReturnType<NonNullable<CrmMachineAuthOptions["verifier"]>>>;
function machineAuth(overrides: Record<string, unknown> = {}): CrmMachineAuthOptions {
  return {
    env: { CRM_MACHINE_AUTH_ENABLED: "1", NODE_ENV: "production", VERCEL_ENV: "production" }, now,
    verifier: async () => ({
      payload: {
        aud: CRM_MACHINE_AUDIENCE, environment: CRM_MACHINE_ENVIRONMENT,
        exp: nowSeconds + 3600, iat: nowSeconds - 5, iss: CRM_MACHINE_ISSUER,
        jti: randomUUID(), nbf: nowSeconds - 5, owner_id: CRM_MACHINE_OWNER_ID,
        project_id: CRM_MACHINE_PROJECT_ID, sub: CRM_MACHINE_SUBJECT, ...overrides,
      },
      protectedHeader: { alg: "RS256", kid: "synthetic-knowledge-key", typ: "JWT" },
    }) as VerificationResult,
  };
}
async function machineCall(body: unknown = { query: "machineanchor" }, extra: {
  channel?: "voice" | "webchat"; headers?: Record<string, string>; auth?: CrmMachineAuthOptions;
} = {}) {
  const response = await handleMachineKnowledgeRequest(new Request("https://crm.example.invalid/api/integrations/v1/knowledge/voice", {
    method: "POST", headers: { authorization: `Bearer ${fakeToken}`, "content-type": "application/json", ...extra.headers },
    body: JSON.stringify(body),
  }), extra.channel ?? "voice", { ...options, machineAuth: extra.auth ?? machineAuth() });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

before(async () => {
  db = await startLocalSalesDb();
  // The accepted machine predecessors assert exactly 68 forced-RLS relations.
  // Apply them unchanged before additive Knowledge Center relations are created.
  await applySalesSchema(db, { maxMigrationNumber: 90 });
  options = { pool: db.pool as unknown as NonNullable<TenantTransactionOptions["pool"]> };
  await db.admin.query("insert into workspaces(id,name,operating_model,customer_type,setup_state) values($1,'SYNTHETIC machine knowledge','novalure_internal','novalure_internal','{}') on conflict(id) do update set operating_model='novalure_internal',customer_type='novalure_internal'", [CRM_MACHINE_WORKSPACE_ID]);
  await db.admin.query("alter table company_profiles enable row level security; alter table company_profiles force row level security; alter table company_profile_versions enable row level security; alter table company_profile_versions force row level security");
  await db.admin.query("do $$ declare r record; begin for r in select format('%I.%I',n.nspname,c.relname) as q from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','p') and c.relrowsecurity loop execute 'alter table '||r.q||' force row level security'; end loop; end $$");
  for (const migration of ["092_crm_production_machine_identity.sql", "093_crm_machine_internal_context.sql", "101_knowledge_center.sql"]) {
    await db.admin.query(await readFile(new URL(`../migrations/${migration}`, import.meta.url), "utf8"));
  }
  // Exercise definer row locks under FORCE RLS without superuser/owner bypass.
  const migrationOwner = `knowledge_service_owner_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  await db.admin.query(`create role ${migrationOwner} nologin nosuperuser nobypassrls nocreatedb nocreaterole noreplication`);
  await db.admin.query(`grant usage,create on schema public to ${migrationOwner}`);
  await db.admin.query(`grant all on all tables in schema public to ${migrationOwner}`);
  // CREATE POLICY requires ownership, as it does for the deployment role.
  await db.admin.query(`alter table crm_service_principals owner to ${migrationOwner}`);
  const migrationClient = await db.admin.connect();
  try {
    await migrationClient.query("begin");
    await migrationClient.query(`set local role ${migrationOwner}`);
    await migrationClient.query(await readFile(new URL("../migrations/103_knowledge_assistant_service.sql", import.meta.url), "utf8"));
    await migrationClient.query("commit");
  } catch (error) {
    await migrationClient.query("rollback");
    throw error;
  } finally {
    migrationClient.release();
  }
  await db.admin.query("insert into workspaces(id,name,operating_model) values($1,'SYNTHETIC assistant tenant','managed_by_novalure'),($2,'SYNTHETIC foreign assistant tenant','managed_by_novalure')", [ids.workspace, ids.foreignWorkspace]);
  for (const actor of ["owner", "foreignOwner", "internalAdmin"] as const) {
    const member = session(actor);
    await db.admin.query("insert into workspace_users(id,workspace_id,name,email,role,product_role,status) values($1,$2,'SYNTHETIC owner',$3,'owner',$4,'active')", [member.userId, member.workspaceId, member.email, member.productRole]);
  }
  await db.admin.query("insert into bots(id,workspace_id,name,role) values($1,$2,'SYNTHETIC knowledge bot','advisor'),($3,$4,'SYNTHETIC foreign knowledge bot','advisor'),($5,$6,'SYNTHETIC machine knowledge bot','advisor')", [ids.bot, ids.workspace, ids.foreignBot, ids.foreignWorkspace, ids.machineBot, CRM_MACHINE_WORKSPACE_ID]);
  for (const workspace of [ids.workspace, ids.foreignWorkspace, CRM_MACHINE_WORKSPACE_ID]) {
    await db.admin.query(`insert into knowledge_center_entitlements(workspace_id,enabled,max_sources,max_storage_bytes,max_queries_per_month,contract_reference,limits)
      values($1,true,100,20000000,1000,'SYNTHETIC-ASSISTANT-NOT-COMMERCIAL','{"maxAreas":100,"maxWebsites":10,"maxScansPerMonth":10,"maxUsers":20,"maxAssistants":20}')`, [workspace]);
  }
  voiceArea = (await createKnowledgeArea(session(), { name: "SYNTHETIC voice", kind: "company" }, options)).id;
  webArea = (await createKnowledgeArea(session(), { name: "SYNTHETIC webchat", kind: "company" }, options)).id;
  aliasArea = (await createKnowledgeArea(session(), { name: "SYNTHETIC telephone alias", kind: "company" }, options)).id;
  voiceSource = await published(session(), voiceArea, "SYNTHETIC approved voice", "serviceanchor VOICE_ONLY approved reference.");
  await published(session(), webArea, "SYNTHETIC approved webchat", "serviceanchor WEBCHAT_ONLY approved reference.");
  await published(session(), aliasArea, "SYNTHETIC telephone alias", "serviceanchor TELEPHONE_ALIAS_SECRET.");
  await createKnowledgeSource(session(), { areaId: voiceArea, name: "SYNTHETIC never published", type: "manual", content: "draftanchor DRAFT_ONLY_SECRET" }, options);
  for (let index = 0; index < 6; index++) {
    await published(session(), voiceArea, `SYNTHETIC bounded source ${index}`, `boundanchor source ${index}. ${"Approved explanatory reference. ".repeat(50)}`);
  }
  await assignKnowledgeAreas(session(), { botId: ids.bot, channel: "voice", areaIds: [voiceArea] }, options);
  await assignKnowledgeAreas(session(), { botId: ids.bot, channel: "webchat", areaIds: [webArea] }, options);
  await assignKnowledgeAreas(session(), { botId: ids.bot, channel: "telephone", areaIds: [aliasArea] }, options);
  const foreignArea = await createKnowledgeArea(session("foreignOwner"), { name: "SYNTHETIC foreign", kind: "company" }, options);
  await published(session("foreignOwner"), foreignArea.id, "SYNTHETIC foreign secret", "serviceanchor FOREIGN_TENANT_SECRET");
  await assignKnowledgeAreas(session("foreignOwner"), { botId: ids.foreignBot, channel: "voice", areaIds: [foreignArea.id] }, options);
  const machineArea = await createKnowledgeArea(session("internalAdmin"), { name: "SYNTHETIC machine", kind: "company" }, options);
  await published(session("internalAdmin"), machineArea.id, "SYNTHETIC machine reference", "machineanchor MACHINE_ONLY approved internal reference");
  await assignKnowledgeAreas(session("internalAdmin"), { botId: ids.machineBot, channel: "voice", areaIds: [machineArea.id] }, options);
  await db.admin.query("insert into knowledge_assistant_service_bindings(workspace_id,principal_id,bot_id,channel) values($1,$2,$3,'voice')", [CRM_MACHINE_WORKSPACE_ID, ids.principal, ids.machineBot]);
});
after(async () => { await closeLocalTestPool(); if (db) await db.stop(); });

test("telephony retrieves exact voice assignment while webchat retains independent approved context", async () => {
  const voice = await retrieve("telephony");
  assert.equal(voice.answerStatus, "grounded");
  assert.equal(voice.fallback, null);
  assert.equal(voice.excerpts.length, 1);
  assert.equal(voice.excerpts[0].sourceId, voiceSource.id);
  assert.equal(voice.excerpts[0].versionId, voiceSource.approvedVersionId);
  assert.equal(voice.excerpts[0].trust, "retrieved_knowledge_data");
  assert.match(voice.excerpts[0].text, /VOICE_ONLY/);
  assert.ok(voice.excerpts[0].citation.length > 0);
  const web = await retrieve("webchat");
  assert.equal(web.answerStatus, "grounded");
  assert.match(web.excerpts[0].text, /WEBCHAT_ONLY/);
  assert.doesNotMatch(JSON.stringify(voice), /WEBCHAT_ONLY|TELEPHONE_ALIAS_SECRET|FOREIGN_TENANT_SECRET/);
  assert.doesNotMatch(JSON.stringify(web), /VOICE_ONLY|TELEPHONE_ALIAS_SECRET|FOREIGN_TENANT_SECRET/);
});

test("drafts and unmatched queries return an explicit safe fallback without source content", async () => {
  assertEmpty(await retrieve("telephony", "draftanchor"));
  assertEmpty(await retrieve("webchat", "draftanchor"));
  assertEmpty(await retrieve("telephony", "nothingmatchesanchor"));
  const draft = await updateKnowledgeSource(session(), { sourceId: voiceSource.id, expectedVersion: voiceSource.revision, content: "replacementdraftanchor DRAFT_REPLACEMENT_SECRET" }, options);
  assertEmpty(await retrieve("telephony", "replacementdraftanchor"));
  const previous = await retrieve("telephony");
  assert.equal(previous.excerpts[0].versionId, voiceSource.approvedVersionId);
  assert.doesNotMatch(JSON.stringify(previous), /DRAFT_REPLACEMENT_SECRET/);
  voiceSource = draft;
});

test("voice grant revocation cannot fall back to telephone or webchat grants", async () => {
  await assignKnowledgeAreas(session(), { botId: ids.bot, channel: "voice", areaIds: [] }, options);
  try {
    assertEmpty(await retrieve("telephony"));
    assert.equal((await retrieve("webchat")).answerStatus, "grounded");
  } finally {
    await assignKnowledgeAreas(session(), { botId: ids.bot, channel: "voice", areaIds: [voiceArea] }, options);
  }
});

test("archived sources and archived areas become unavailable immediately", async () => {
  const archived = await published(session(), voiceArea, "SYNTHETIC archived source", "archiveanchor ARCHIVED_SOURCE_SECRET");
  assert.equal((await retrieve("telephony", "archiveanchor")).answerStatus, "grounded");
  await archiveKnowledgeSource(session(), { sourceId: archived.id, expectedVersion: archived.revision }, options);
  assertEmpty(await retrieve("telephony", "archiveanchor"));
  const area = await createKnowledgeArea(session(), { name: "SYNTHETIC archived area", kind: "company" }, options);
  await published(session(), area.id, "SYNTHETIC area secret", "areaarchiveanchor ARCHIVED_AREA_SECRET");
  await assignKnowledgeAreas(session(), { botId: ids.bot, channel: "voice", areaIds: [voiceArea, area.id] }, options);
  assert.equal((await retrieve("telephony", "areaarchiveanchor")).answerStatus, "grounded");
  await archiveKnowledgeArea(session(), { areaId: area.id }, options);
  assertEmpty(await retrieve("telephony", "areaarchiveanchor"));
});

test("persisted tenant identity excludes foreign assistants and forged session workspace", async () => {
  await assert.rejects(retrieveAssistantKnowledge(session(), { assistantId: ids.foreignBot, channel: "telephony", query: "serviceanchor", maxResults: 3 }, options));
  await assert.rejects(retrieveAssistantKnowledge({ ...session(), workspaceId: ids.foreignWorkspace }, { assistantId: ids.foreignBot, channel: "telephony", query: "serviceanchor", maxResults: 3 }, options));
  await assert.rejects(retrieveAssistantKnowledge({ ...session(), authIdentityId: randomUUID() }, { assistantId: ids.bot, channel: "telephony", query: "serviceanchor", maxResults: 3 }, options));
  for (const forged of [{ ...session(), authenticated: false }, { ...session(), source: "demo" as const }]) {
    await assert.rejects(retrieveAssistantKnowledge(forged, { assistantId: ids.bot, channel: "telephony", query: "serviceanchor", maxResults: 3 }, options));
  }
});

test("commercial entitlement, workspace module and monthly limit each block assistant context", async () => {
  await db.admin.query("update knowledge_center_entitlements set enabled=false where workspace_id=$1", [ids.workspace]);
  try { assertEmpty(await retrieve("telephony")); } finally {
    await db.admin.query("update knowledge_center_entitlements set enabled=true where workspace_id=$1", [ids.workspace]);
  }
  await db.admin.query("insert into workspace_module_settings(workspace_id,module_key,enabled) values($1,'knowledge',false)", [ids.workspace]);
  try { assertEmpty(await retrieve("telephony")); } finally {
    await db.admin.query("update workspace_module_settings set enabled=true where workspace_id=$1 and module_key='knowledge'", [ids.workspace]);
  }
  await db.admin.query("update knowledge_center_entitlements set max_queries_per_month=1 where workspace_id=$1", [ids.workspace]);
  try { assertEmpty(await retrieve("telephony")); } finally {
    await db.admin.query("update knowledge_center_entitlements set max_queries_per_month=1000 where workspace_id=$1", [ids.workspace]);
  }
});

test("voice results and excerpts remain bounded and invalid result limits are rejected", async () => {
  const voice = await retrieve("telephony", "boundanchor", 5);
  assert.equal(voice.answerStatus, "grounded");
  assert.equal(voice.excerpts.length, 3);
  assert.ok(voice.excerpts.every(item => item.text.length > 0 && item.text.length <= 600));
  assert.ok(voice.excerpts.reduce((sum, item) => sum + item.text.length, 0) <= 1800);
  assert.equal((await retrieve("telephony", "boundanchor", 1)).excerpts.length, 1);
  for (const maxResults of [0, 6, -1, 1.5, Number.NaN]) {
    await assert.rejects(retrieve("telephony", "boundanchor", maxResults));
  }
  await assert.rejects(retrieveAssistantKnowledge(session(), { assistantId: ids.bot, channel: "telephone" as "telephony", query: "serviceanchor", maxResults: 3 }, options));
});

test("machine request derives assistant and tenant from exact persisted principal/channel binding", async () => {
  const result = await machineCall();
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.match(JSON.stringify(result.body), /MACHINE_ONLY/);
  assert.doesNotMatch(JSON.stringify(result.body), /VOICE_ONLY|WEBCHAT_ONLY|FOREIGN_TENANT_SECRET/);
  assert.equal((await machineCall({ query: "machineanchor" }, { channel: "webchat" })).status, 403);
  for (const extra of [{ tenantId: ids.workspace }, { workspaceId: ids.workspace }, { assistantId: ids.bot }, { botId: ids.bot }, { channel: "webchat" }]) {
    const denied = await machineCall({ query: "machineanchor", ...extra });
    assert.equal(denied.status, 400, JSON.stringify(denied.body));
    assert.doesNotMatch(JSON.stringify(denied.body), /MACHINE_ONLY|VOICE_ONLY|FOREIGN_TENANT_SECRET/);
  }
});

test("machine boundary rejects forged credentials, workload drift, cookies and unregistered binding", async () => {
  const invalidHeaders: Record<string, string>[] = [{ authorization: "" }, { authorization: "Bearer forged" }, { cookie: "session=forged" }];
  for (const headers of invalidHeaders) {
    const result = await machineCall(undefined, { headers });
    assert.ok([401, 403].includes(result.status), JSON.stringify(result));
    assert.doesNotMatch(JSON.stringify(result.body), /MACHINE_ONLY/);
  }
  for (const claims of [{ sub: "owner:other" }, { project_id: "prj_other" }, { owner_id: "team_other" }, { environment: "preview" }, { exp: nowSeconds - 60 }]) {
    assert.equal((await machineCall(undefined, { auth: machineAuth(claims) })).status, 401);
  }
  assert.equal((await machineCall(undefined, { auth: { ...machineAuth(), verifier: async () => { throw new Error("synthetic invalid signature"); } } })).status, 401);
  await db.admin.query("update knowledge_assistant_service_bindings set enabled=false where principal_id=$1 and channel='voice'", [ids.principal]);
  try { assert.equal((await machineCall()).status, 403); } finally {
    await db.admin.query("update knowledge_assistant_service_bindings set enabled=true where principal_id=$1 and channel='voice'", [ids.principal]);
  }
  await db.admin.query("update knowledge_assistant_service_bindings set revoked_at=now() where principal_id=$1 and channel='voice'", [ids.principal]);
  try { assert.equal((await machineCall()).status, 403); } finally {
    await db.admin.query("update knowledge_assistant_service_bindings set revoked_at=null where principal_id=$1 and channel='voice'", [ids.principal]);
  }
});

test("revoked machine principal, kill switch, expiration and inactive actor deny before retrieval", async () => {
  const usage = async () => Number((await db.admin.query("select coalesce(sum(query_count),0) as count from knowledge_query_usage where workspace_id=$1", [CRM_MACHINE_WORKSPACE_ID])).rows[0].count);
  const initial = await usage();
  for (const [deny, restore] of [
    ["state='REVOKED',revoked_at=now()", "state='ACTIVE',revoked_at=null"],
    ["kill_switch_active=true,kill_switch_reason='synthetic verification'", "kill_switch_active=false,kill_switch_reason=null"],
    ["expires_at=now()-interval '1 minute'", "expires_at=now()+interval '1 day'"],
  ]) {
    await db.admin.query(`update crm_service_principals set ${deny} where id=$1`, [ids.principal]);
    try { assert.equal((await machineCall()).status, 401); } finally {
      await db.admin.query(`update crm_service_principals set ${restore} where id=$1`, [ids.principal]);
    }
  }
  await db.admin.query("update workspace_users set status='suspended' where id=(select actor_user_id from crm_service_principals where id=$1)", [ids.principal]);
  try { assert.equal((await machineCall()).status, 401); } finally {
    await db.admin.query("update workspace_users set status='active' where id=(select actor_user_id from crm_service_principals where id=$1)", [ids.principal]);
  }
  assert.equal(await usage(), initial);
});

test("blocked machine binding obeys SQL deadline and returns no knowledge with a safe fallback", async () => {
  const locked = await db.admin.connect();
  try {
    await locked.query("begin");
    await locked.query("select * from knowledge_assistant_service_bindings where principal_id=$1 and channel='voice' for update", [ids.principal]);
    const started = Date.now();
    const result = await machineCall();
    const elapsed = Date.now() - started;
    assert.equal(result.status, 503, JSON.stringify(result.body));
    assertEmpty(result.body as unknown as AssistantKnowledgeContext);
    assert.doesNotMatch(JSON.stringify(result.body), /MACHINE_ONLY/);
    assert.ok(elapsed < 2500, `Knowledge deadline exceeded: ${elapsed}ms`);
  } finally {
    await locked.query("rollback");
    locked.release();
  }
});

test("service binding and Knowledge Center tables expose no rows without tenant context", async () => {
  const flags = await db.admin.query("select relrowsecurity,relforcerowsecurity from pg_class where oid='knowledge_assistant_service_bindings'::regclass");
  assert.deepEqual(flags.rows[0], { relrowsecurity: true, relforcerowsecurity: true });
  await assert.rejects(db.pool.query("select * from knowledge_assistant_service_bindings"), (error: unknown) => (error as { code?: string }).code === "42501");
  assert.equal((await db.pool.query("select * from knowledge_lock_assistant_service_binding($1,'voice')", [ids.principal])).rowCount, 0);
  for (const table of ["knowledge_areas", "knowledge_sources", "knowledge_source_versions", "knowledge_area_grants", "knowledge_chunks"]) {
    assert.equal((await db.pool.query(`select count(*)::int as count from ${table}`)).rows[0].count, 0, table);
  }
  await assert.rejects(db.pool.query("update knowledge_assistant_service_bindings set enabled=true"), (error: unknown) => (error as { code?: string }).code === "42501");
});

test("public gateway knowledge binds live integration, origin, session, tenant and independent webchat assignment", async t => {
  // Run the real predecessors. Ledger entries below record only SQL that has
  // actually executed in this disposable database; no preflight is fabricated.
  for (const migration of ["094_website_sales_ingestion.sql", "095_form_tenant_isolation.sql", "096_public_integration_gateway.sql"]) {
    const sql = await readFile(new URL(`../migrations/${migration}`, import.meta.url), "utf8");
    await db.admin.query(sql);
    await db.admin.query("insert into novalure_schema_migrations(version,name,checksum) values($1,$2,$3)", [migration.replace(/\.sql$/u, ""), migration, createHash("sha256").update(sql).digest("hex")]);
  }
  const integrationId = randomUUID(), foreignIntegrationId = randomUUID();
  const visitorSessionId = randomUUID(), foreignSessionId = randomUUID();
  const siteKey = `nov_pk_${randomBytes(24).toString("base64url")}`;
  const foreignSiteKey = `nov_pk_${randomBytes(24).toString("base64url")}`;
  const token = randomBytes(32).toString("base64url"), foreignToken = randomBytes(32).toString("base64url");
  const origin = "https://synthetic-customer.example";
  for (const row of [
    { id: integrationId, siteKey, workspace: ids.workspace, bot: ids.bot, actor: ids.owner, sessionId: visitorSessionId, token },
    { id: foreignIntegrationId, siteKey: foreignSiteKey, workspace: ids.foreignWorkspace, bot: ids.foreignBot, actor: ids.foreignOwner, sessionId: foreignSessionId, token: foreignToken },
  ]) {
    await db.admin.query(`insert into external_integrations(id,public_site_key,workspace_id,integration_type,status,mode,allowed_origins,capabilities,configuration,created_by)
      values($1,$2,$3,'website_chat','active','training',array[$4],array['chat.context'],$5::jsonb,$6)`, [row.id, row.siteKey, row.workspace, origin, JSON.stringify({ knowledgeAssistantId: row.bot }), row.actor]);
    await db.admin.query("insert into external_integration_widget_configs(integration_id,workspace_id,chat_enabled,enabled_capabilities) values($1,$2,true,array['chat.context'])", [row.id, row.workspace]);
    await db.admin.query(`insert into external_chat_sessions(id,integration_id,workspace_id,session_token_hash,idempotency_hash,mode,language,synthetic)
      values($1,$2,$3,$4,$5,'training','en',true)`, [row.sessionId, row.id, row.workspace, createHash("sha256").update(row.token).digest("hex"), createHash("sha256").update(randomUUID()).digest("hex")]);
  }
  const envKeys = ["DATABASE_URL", "CRM_LOCAL_TEST_DATABASE", "NODE_ENV", "NOVALURE_ABUSE_SECRET", "NOVALURE_TRUSTED_CLIENT_IP_HEADER", "VERCEL", "VERCEL_ENV", "VERCEL_URL"] as const;
  const prior = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
  try {
    for (const key of envKeys) delete process.env[key];
    Object.assign(process.env, {
      DATABASE_URL: `postgresql://${db.role}@127.0.0.1:${db.port}/postgres`, CRM_LOCAL_TEST_DATABASE: "1", NODE_ENV: "test",
      NOVALURE_ABUSE_SECRET: "synthetic-knowledge-gateway-abuse-secret-0001", NOVALURE_TRUSTED_CLIENT_IP_HEADER: "x-test-client-ip",
    });
    const { OPTIONS, POST } = await import("../src/app/api/public/integrations/chat/knowledge/route");
    const call = async (extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) => {
      const response = await POST(new Request("https://crm.example.invalid/api/public/integrations/chat/knowledge", {
        method: "POST", headers: {
          "content-type": "application/json", origin, "x-novalure-site-key": siteKey,
          "x-novalure-session-token": token, "x-test-client-ip": "203.0.113.27", ...headers,
        }, body: JSON.stringify({ sessionId: visitorSessionId, query: "serviceanchor", maxResults: 3, ...extra }),
      }));
      return { status: response.status, body: await response.json() as Record<string, unknown> };
    };
    await t.test("verified visitor receives only saved webchat knowledge", async () => {
      const result = await call();
      assert.equal(result.status, 200, JSON.stringify(result.body));
      assert.match(JSON.stringify(result.body), /WEBCHAT_ONLY/);
      assert.doesNotMatch(JSON.stringify(result.body), /VOICE_ONLY|TELEPHONE_ALIAS_SECRET|FOREIGN_TENANT_SECRET|MACHINE_ONLY/);
    });
    await t.test("browser preflight and JSON POST use the same public site-key URL", async () => {
      const pathname = "https://crm.example.invalid/api/public/integrations/chat/knowledge";
      const url = `${pathname}?site_key=${encodeURIComponent(siteKey)}`;
      const preflightHeaders = {
        origin, "access-control-request-method": "POST",
        "access-control-request-headers": "content-type,x-novalure-session-token",
      };
      const preflight = await OPTIONS(new Request(url, { method: "OPTIONS", headers: preflightHeaders }));
      assert.equal(preflight.status, 204);
      assert.equal(preflight.headers.get("access-control-allow-origin"), origin);
      assert.match(preflight.headers.get("access-control-allow-methods") ?? "", /POST/);
      assert.match(preflight.headers.get("access-control-allow-headers") ?? "", /x-novalure-session-token/i);
      const request = (siteHeader?: string) => new Request(url, {
        method: "POST", headers: {
          origin, "content-type": "application/json", "x-novalure-session-token": token,
          "x-test-client-ip": "203.0.113.27", ...(siteHeader ? { "x-novalure-site-key": siteHeader } : {}),
        }, body: JSON.stringify({ sessionId: visitorSessionId, query: "serviceanchor", maxResults: 3 }),
      });
      const response = await POST(request());
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("access-control-allow-origin"), origin);
      assert.match(JSON.stringify(await response.json()), /WEBCHAT_ONLY/);
      assert.equal((await OPTIONS(new Request(pathname, { method: "OPTIONS", headers: preflightHeaders }))).status, 404);
      assert.equal((await POST(request(foreignSiteKey))).status, 400);
    });
    await t.test("forged visitor credentials, foreign sessions and tenant selectors fail closed", async () => {
      for (const [body, headers, expected] of [
        [{}, { "x-novalure-session-token": randomBytes(32).toString("base64url") }, 403],
        [{ sessionId: foreignSessionId }, {}, 403],
        [{}, { "x-novalure-site-key": foreignSiteKey }, 403],
        [{}, { origin: "https://wrong.example" }, 404],
        [{ tenantId: ids.foreignWorkspace }, {}, 400],
        [{ assistantId: ids.foreignBot }, {}, 400],
        [{ channel: "voice" }, {}, 400],
      ] as [Record<string, unknown>, Record<string, string>, number][]) {
        const result = await call(body, headers);
        assert.equal(result.status, expected, JSON.stringify(result));
        assert.doesNotMatch(JSON.stringify(result.body), /WEBCHAT_ONLY|VOICE_ONLY|FOREIGN_TENANT_SECRET/);
      }
    });
    await t.test("assignment revocation removes public context without granting voice access", async () => {
      await assignKnowledgeAreas(session(), { botId: ids.bot, channel: "webchat", areaIds: [] }, options);
      try {
        const result = await call();
        assert.equal(result.status, 200, JSON.stringify(result.body));
        assertEmpty(result.body as unknown as AssistantKnowledgeContext);
        assert.equal((await retrieve("telephony")).answerStatus, "grounded");
      } finally {
        await assignKnowledgeAreas(session(), { botId: ids.bot, channel: "webchat", areaIds: [webArea] }, options);
      }
    });
    await t.test("closed visitor sessions, disabled widget and revoked integration invalidate current credentials", async () => {
      await db.admin.query("update external_chat_sessions set status='closed',closed_at=now() where id=$1", [visitorSessionId]);
      try { assert.equal((await call()).status, 403); } finally {
        await db.admin.query("update external_chat_sessions set status='active',closed_at=null where id=$1", [visitorSessionId]);
      }
      await db.admin.query("update external_integration_widget_configs set chat_enabled=false where integration_id=$1", [integrationId]);
      try { assert.equal((await call()).status, 404); } finally {
        await db.admin.query("update external_integration_widget_configs set chat_enabled=true where integration_id=$1", [integrationId]);
      }
      await db.admin.query("update external_integrations set status='revoked',revoked_at=now() where id=$1", [integrationId]);
      try { assert.equal((await call()).status, 404); } finally {
        await db.admin.query("update external_integrations set status='active',revoked_at=null where id=$1", [integrationId]);
      }
    });
    await t.test("saved foreign assistant configuration cannot cross the integration tenant", async () => {
      await db.admin.query("update external_integrations set configuration=$2::jsonb where id=$1", [integrationId, JSON.stringify({ knowledgeAssistantId: ids.foreignBot })]);
      try {
        const result = await call();
        assert.equal(result.status, 403, JSON.stringify(result.body));
        assert.doesNotMatch(JSON.stringify(result.body), /FOREIGN_TENANT_SECRET/);
      } finally {
        await db.admin.query("update external_integrations set configuration=$2::jsonb where id=$1", [integrationId, JSON.stringify({ knowledgeAssistantId: ids.bot })]);
      }
    });
  } finally {
    await closeLocalTestPool();
    for (const key of envKeys) {
      if (prior[key] === undefined) delete process.env[key];
      else Object.assign(process.env, { [key]: prior[key] });
    }
  }
});
