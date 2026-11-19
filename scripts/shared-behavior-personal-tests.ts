import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import type { AppSession } from "../src/lib/auth/session";
import { getRolePermissions } from "../src/lib/auth/permissions";
import { getProductRoleCapabilities } from "../src/lib/product-model";
import { withTenantTransaction, type TenantTransactionOptions } from "../src/lib/db/tenant-client";
import { createKnowledgeArea, createKnowledgeSource, publishKnowledgeSource, assignKnowledgeAreas } from "../src/lib/knowledge-center/repository";
import { handleEvelynRuntimeRequest } from "../src/lib/shared-behavior/runtime-http";
import { personalRuntimeIdentity as identity, verifyPersonalRuntimeToken } from "../src/lib/shared-behavior/personal-auth";
import { applySalesSchema, startLocalSalesDb } from "./lib/local-sales-db.mjs";

const keyMaterial = generateKeyPair("RS256").then(async signing => ({ signing,
  keyResolver: createLocalJWKSet({ keys: [{ ...await exportJWK(signing.publicKey), kid: "synthetic-personal-key", alg: "RS256", use: "sig" }] }),
}));
const env = { NODE_ENV: "test" as const, VERCEL_ENV: "production", EVELYN_SHARED_PERSONAL_RUNTIME_ENABLED: "1" };
const now = new Date("2026-10-27T12:00:00Z");
const epoch = Math.floor(now.valueOf() / 1000);
async function signed(overrides: Record<string, unknown> = {}, key?: Parameters<SignJWT["sign"]>[0]) {
  const { signing } = await keyMaterial;
  return new SignJWT({ iss: identity.issuer, aud: identity.audience, sub: identity.subject,
    owner_id: identity.ownerId, owner: "novalure", project_id: identity.projectId, project: "evelyn",
    environment: identity.environment, custom_environment_id: identity.customEnvironmentId,
    iat: epoch - 5, nbf: epoch - 5, exp: epoch + 3600, jti: randomUUID(), ...overrides })
    .setProtectedHeader({ alg: "RS256", typ: "JWT", kid: "synthetic-personal-key" }).sign(key ?? signing.privateKey);
}
test("personal runtime authenticates real signatures and the exact native caller only", async () => {
  const { keyResolver } = await keyMaterial;
  assert.deepEqual(await verifyPersonalRuntimeToken(await signed(), { env, now, keyResolver }), identity);
  for (const overrides of [
    { sub: "owner:novalure:project:evelyn:environment:production" }, { environment: "production" },
    { custom_environment_id: "foreign" }, { project_id: "prj_5okehbkYEkLBHaIEzlet1t0FaZj4" },
    { project: "evelyn-resend-webhook" }, { owner_id: "foreign" }, { owner: "foreign" },
    { aud: "urn:novalure:crm:production" }, { iss: "https://foreign.invalid" },
    { nbf: undefined }, { nbf: epoch + 1 }, { exp: epoch }, { iat: epoch + 1 },
    { exp: epoch + 13 * 60 * 60 },
    { jti: undefined }, { jti: "invalid" },
  ]) await assert.rejects(verifyPersonalRuntimeToken(await signed(overrides), { env, now, keyResolver }));
  await assert.rejects(verifyPersonalRuntimeToken(await signed(), { env: { NODE_ENV: "test" }, now, keyResolver }));
  await assert.rejects(verifyPersonalRuntimeToken(await signed(), { env: { ...env, VERCEL_ENV: "preview" }, now, keyResolver }));
  const foreign = await generateKeyPair("RS256");
  await assert.rejects(verifyPersonalRuntimeToken(await signed({}, foreign.privateKey), { env, now, keyResolver }));
});

test("personal context/signal retain private grants, native revocation and old principal", { timeout: 240000 }, async t => {
  const { keyResolver } = await keyMaterial;
  const db = await startLocalSalesDb();
  const options: TenantTransactionOptions = { pool: db.pool as unknown as NonNullable<TenantTransactionOptions["pool"]> };
  const workspace = identity.workspaceId, ownerId = randomUUID(), brokerId = randomUUID(), actorId = randomUUID(), otherActor = randomUUID();
  const botId = randomUUID(), otherBot = randomUUID(), bindingId = randomUUID(), workloadId = randomUUID();
  const capability = randomBytes(32).toString("base64url"), otherCapability = randomBytes(32).toString("base64url");
  const session = (actor: string, role: "owner" | "agent" = "agent"): AppSession => ({
    authenticated: true, source: "database", workspaceId: workspace, userId: actor, workspaceName: "SYNTHETIC",
    name: "SYNTHETIC", email: "synthetic@example.invalid", role, productRole: role === "owner" ? "platform_admin" : "novalure_operator",
    permissions: getRolePermissions(role), productPermissions: getProductRoleCapabilities(role === "owner" ? "platform_admin" : "novalure_operator"),
  });
  const personalMigration = await readFile("migrations/staged/shared_behavior_personal_runtime.sql", "utf8");
  try {
    await applySalesSchema(db, { maxMigrationNumber: 90 });
    await db.admin.query("insert into workspaces(id,name,operating_model,customer_type,setup_state) values($1,'SYNTHETIC personal','novalure_internal','novalure_internal','{}') on conflict(id) do update set operating_model='novalure_internal',customer_type='novalure_internal'", [workspace]);
    await db.admin.query("do $$ declare r record; begin for r in select format('%I.%I',n.nspname,c.relname) q from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','p') and c.relrowsecurity loop execute 'alter table '||r.q||' force row level security'; end loop; end $$");
    await db.admin.query("alter table company_profiles enable row level security; alter table company_profiles force row level security; alter table company_profile_versions enable row level security; alter table company_profile_versions force row level security");
    for (const filename of ["092_crm_production_machine_identity.sql", "093_crm_machine_internal_context.sql", "101_knowledge_center.sql", "108_knowledge_connected_assistant_quota.sql",
      "staged/shared_behavior_foundation.sql", "staged/shared_behavior_package2.sql", "staged/shared_behavior_package3.sql"]) {
      const client = await db.admin.connect();
      try { await client.query("begin"); await client.query(await readFile("migrations/" + filename, "utf8")); await client.query("commit"); }
      catch (error) { await client.query("rollback"); throw error; } finally { client.release(); }
    }
    const oldPrincipal = (await db.admin.query("select to_jsonb(p) as data from crm_service_principals p where identity_id='EVELYN_CRM_SERVICE_IDENTITY'")).rows[0].data;
    await t.test("new DDL is atomic and does not seed any workload", async () => {
      const client = await db.admin.connect();
      try { await client.query("begin"); await client.query(personalMigration); await client.query("rollback"); }
      finally { client.release(); }
      assert.equal((await db.admin.query("select to_regclass('public.behavior_personal_workload_bindings') as relation")).rows[0].relation, null);
      await db.admin.query("begin");
      try { await db.admin.query(personalMigration); await db.admin.query("commit"); }
      catch (error) { await db.admin.query("rollback"); throw error; }
      assert.equal((await db.admin.query("select count(*)::int as n from behavior_personal_workload_bindings")).rows[0].n, 0);
    });
    for (const actor of [ownerId, brokerId, actorId, otherActor]) await db.admin.query(
      "insert into workspace_users(id,workspace_id,name,email,role,product_role) values($1,$2,'SYNTHETIC personal',$3,$4,$5)",
      [actor, workspace, actor + "@example.invalid", actor === ownerId ? "owner" : "agent", actor === ownerId ? "platform_admin" : "novalure_operator"]);
    for (const bot of [botId, otherBot]) await db.admin.query("insert into bots(id,workspace_id,name,role) values($1,$2,'SYNTHETIC personal','advisor')", [bot, workspace]);
    await db.admin.query("insert into knowledge_center_entitlements(workspace_id,enabled,max_sources,max_storage_bytes,max_queries_per_month,contract_reference,limits) values($1,true,20,20000000,1000,'SYNTHETIC-PERSONAL','{\"maxAreas\":20,\"maxAssistants\":20,\"maxUsers\":20}')", [workspace]);
    const owner = session(ownerId, "owner");
    const allowed = await createKnowledgeArea(owner, { name: "SYNTHETIC CEO", kind: "company" }, options);
    const denied = await createKnowledgeArea(owner, { name: "SYNTHETIC private department", kind: "company" }, options);
    for (const [area, content] of [[allowed.id, "personalanchor ALLOWED_CEO"], [denied.id, "personalanchor DENIED_DEPARTMENT"]]) {
      const source = await createKnowledgeSource(owner, { areaId: area, name: "SYNTHETIC source", content, type: "manual" }, options);
      await publishKnowledgeSource(owner, { sourceId: source.id, versionId: source.draftVersionId!, expectedVersion: source.revision }, options);
    }
    await assignKnowledgeAreas(owner, { botId, channel: "internal", areaIds: [allowed.id] }, options);
    await assignKnowledgeAreas(owner, { botId: otherBot, channel: "internal", areaIds: [denied.id] }, options);
    for (const [id, actor, bot, token, department] of [
      [bindingId, actorId, botId, capability, "executive"], [randomUUID(), otherActor, otherBot, otherCapability, "finance"],
    ]) await db.admin.query("insert into behavior_runtime_bindings(id,workspace_id,broker_actor_id,actor_id,bot_id,department,token_hash,enabled,expires_at) values($1,$2,$3,$4,$5,$6,$7,true,now()+interval '1 day')",
      [id, workspace, brokerId, actor, bot, department, createHash("sha256").update(token).digest("hex")]);
    await db.admin.query("insert into behavior_personal_workload_bindings(id,workspace_id,broker_actor_id,issuer,audience,subject,project_id,owner_id,environment,custom_environment_id,enabled,expires_at) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,true,now()+interval '1 day')",
      [workloadId, workspace, brokerId, identity.issuer, identity.audience, identity.subject, identity.projectId, identity.ownerId, identity.environment, identity.customEnvironmentId]);
    const httpOptions = { ...options, env: { ...env, EVELYN_SHARED_RUNTIME_ENABLED: "1" }, personalAuth: { env, now, keyResolver } };
    const token = await signed();
    const request = (body: unknown, auth = token, cap = capability, headers: Record<string, string> = {}) =>
      new Request("https://crm.example.invalid/api/integrations/evelyn/runtime/context", {
        method: "POST", headers: { authorization: "Bearer " + auth, "content-type": "application/json", "x-evelyn-runtime-token": cap, ...headers }, body: JSON.stringify(body),
      });
    const context = (body: unknown = { query: "personalanchor" }, auth = token, cap = capability) => handleEvelynRuntimeRequest(request(body, auth, cap), "context", httpOptions);
    await t.test("the native personal caller reaches only its capability-bound published context", async () => {
      const response = await context(); assert.equal(response.status, 200, await response.clone().text());
      const body = await response.json(); assert.equal(body.department, "executive"); assert.equal(body.behavior.version, 0);
      assert.deepEqual(body.toolsGranted, []); assert.match(JSON.stringify(body.knowledge), /ALLOWED_CEO/);
      assert.doesNotMatch(JSON.stringify(body), /DENIED_DEPARTMENT/);
      for (const key of ["workspaceId", "department", "actorId", "botId", "areaIds"]) assert.equal((await context({ query: "personalanchor", [key]: randomUUID() })).status, 400);
      assert.equal((await context(undefined, token, randomBytes(32).toString("base64url"))).status, 403);
      assert.equal((await context(undefined, token, otherCapability)).status, 403);
      assert.equal((await context(undefined, await signed({ custom_environment_id: "foreign" }))).status, 401);
      assert.equal((await handleEvelynRuntimeRequest(request({ query: "personalanchor" }, token, capability, { cookie: "session=foreign" }), "context", httpOptions)).status, 401);
      assert.equal((await handleEvelynRuntimeRequest(request({ query: "personalanchor" }), "context", { ...httpOptions, personalAuth: { ...httpOptions.personalAuth, env: { NODE_ENV: "test" } } })).status, 403);
    });
    await t.test("learning persists under the private executive actor and rejects free text", async () => {
      const signal = { eventId: randomUUID(), issue: "language_mismatch", outcome: "pass" };
      const write = () => handleEvelynRuntimeRequest(request(signal), "signal", httpOptions);
      assert.deepEqual(await (await write()).json(), { recorded: true, replayed: false });
      assert.deepEqual(await (await write()).json(), { recorded: true, replayed: true });
      for (const [actor, count] of [[actorId, 1], [otherActor, 0], [brokerId, 0]] as const) {
        const rows = await withTenantTransaction({ workspaceId: workspace, actorId: actor }, tx => tx.query("select event_id from behavior_learning_signals"), options);
        assert.equal(rows.length, count);
      }
      assert.notEqual((await handleEvelynRuntimeRequest(request({ ...signal, text: "PRIVATE" }), "signal", httpOptions)).status, 200);
      await assert.rejects(withTenantTransaction({ workspaceId: workspace, actorId }, tx => tx.query("select * from behavior_personal_workload_bindings"), options));
    });
    await t.test("grant removal, broker suspension, workload expiry and revocation fail closed", async () => {
      await db.admin.query("delete from knowledge_area_grants where bot_id=$1 and channel='internal'", [botId]);
      const response = await context(); assert.equal(response.status, 200); assert.deepEqual((await response.json()).knowledge.excerpts, []);
      await db.admin.query("update workspace_users set status='suspended' where id=$1", [brokerId]); assert.equal((await context()).status, 401);
      await db.admin.query("update workspace_users set status='active' where id=$1", [brokerId]);
      await db.admin.query("update behavior_personal_workload_bindings set not_before=now()-interval '1 day',expires_at=now()-interval '1 second' where id=$1", [workloadId]); assert.equal((await context()).status, 401);
      await db.admin.query("update behavior_personal_workload_bindings set expires_at=now()+interval '1 day',revoked_at=now() where id=$1", [workloadId]); assert.equal((await context()).status, 401);
      await db.admin.query("update behavior_personal_workload_bindings set revoked_at=null where id=$1", [workloadId]);
      await db.admin.query("update behavior_runtime_bindings set revoked_at=now() where id=$1", [bindingId]); assert.equal((await context()).status, 403);
      assert.deepEqual((await db.admin.query("select to_jsonb(p) as data from crm_service_principals p where identity_id='EVELYN_CRM_SERVICE_IDENTITY'")).rows[0].data, oldPrincipal);
    });
  } finally { await db.stop(); }
});
