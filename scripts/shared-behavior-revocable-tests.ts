import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { test } from "node:test";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import type { AppSession } from "../src/lib/auth/session";
import { getRolePermissions } from "../src/lib/auth/permissions";
import { getProductRoleCapabilities } from "../src/lib/product-model";
import { withTenantTransaction, type TenantPool, type TenantTransactionOptions } from "../src/lib/db/tenant-client";
import { assignKnowledgeAreas, createKnowledgeArea, createKnowledgeSource, publishKnowledgeSource } from "../src/lib/knowledge-center/repository";
import { personalRuntimeIdentity as identity } from "../src/lib/shared-behavior/personal-auth";
import { handleEvelynRuntimeRequest } from "../src/lib/shared-behavior/runtime-http";
import { recordBoundAssistantFormatSignal } from "../src/lib/shared-behavior/bound-private-signal";
import { applySalesSchema, LocalSalesPool, startLocalSalesDb } from "./lib/local-sales-db.mjs";

const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const code = (value: string) => (error: unknown) => (error as { code?: string }).code === value;
const functions = ["behavior_lock_runtime", "behavior_runtime_area_allowed", "behavior_lock_workload", "behavior_authenticate_personal_workload", "behavior_lock_personal_workload"];

test("119 adds explicit revocable operation without replacing existing authority fences", { timeout: 240_000 }, async t => {
  const cluster = await startLocalSalesDb();
  let admin: InstanceType<typeof LocalSalesPool> | undefined, bootstrap: InstanceType<typeof LocalSalesPool> | undefined, runtime: InstanceType<typeof LocalSalesPool> | undefined;
  try {
    // Reuse the existing knowledge-production-predecessor fixture's identities
    // and unchanged 091+ DDL. Only loopback/synthetic data; no DATABASE_URL.
    await cluster.admin.query("create role neondb_owner login nosuperuser bypassrls createdb createrole");
    await cluster.admin.query("create role qa_schema_bootstrap login superuser");
    await cluster.admin.query("create database neondb owner neondb_owner");
    await cluster.admin.query("alter role novalure_app login inherit");
    admin = new LocalSalesPool({ host: "127.0.0.1", port: cluster.port, user: "neondb_owner", database: "neondb", max: 5 });
    bootstrap = new LocalSalesPool({ host: "127.0.0.1", port: cluster.port, user: "qa_schema_bootstrap", database: "neondb", max: 4 });
    runtime = new LocalSalesPool({ host: "127.0.0.1", port: cluster.port, user: "novalure_app", database: "neondb", max: 5 });
    await applySalesSchema({ ...cluster, admin: bootstrap, pool: runtime, role: "novalure_app" }, { maxMigrationNumber: 90 });
    await bootstrap.query("reassign owned by qa_schema_bootstrap to neondb_owner");
    await cluster.admin.query("alter role novalure_app noinherit");
    await cluster.admin.query("grant novalure_tenant_app to novalure_app with inherit true,set false,admin false");
    // 114's existing owner-mediated grant requires ADMIN on this NOLOGIN role.
    // Local bootstrap membership only; no additional app/runtime membership.
    await cluster.admin.query("grant novalure_tenant_app to neondb_owner with admin true");
    await cluster.admin.query("grant novalure_tenant_app to neondb_owner with inherit false");
    await cluster.admin.query("grant novalure_tenant_app to neondb_owner with set false");
    const apply = async (name: string) => {
      const sql = await readFile(`migrations/${name}`, "utf8"), c = await admin!.connect();
      try { await c.query("begin"); await c.query(sql); await c.query("insert into novalure_schema_migrations(version,name,checksum) values($1,$2,$3)", [name.slice(0, -4), name, digest(sql)]); await c.query("commit"); }
      catch (error) { await c.query("rollback"); throw new Error(`Local production predecessor ${name} failed`, { cause: error }); }
      finally { c.release(); }
    };
    for (const name of (await readdir("migrations")).filter(n => /^(09[1-6]|10\d|11[0-8])_.*\.sql$/u.test(n) && !n.includes("rollback")).sort()) await apply(name);
    const options: TenantTransactionOptions = { pool: runtime as unknown as TenantPool };
    const workspace = identity.workspaceId, ownerId = randomUUID(), broker = randomUUID(), actor = randomUUID(), bot = randomUUID(), binding = randomUUID(), workload = randomUUID();
    const customerActor = randomUUID(), customerBot = randomUUID(), customerBinding = randomUUID(), machineActor = randomUUID(), machineBot = randomUUID(), machineBinding = randomUUID(), foreignWorkspace = randomUUID();
    const capability = randomBytes(32).toString("base64url"), customerCapability = randomBytes(32).toString("base64url"), machineHash = digest(randomBytes(32).toString("base64url"));
    await admin.query("update workspaces set operating_model='novalure_internal',customer_type='novalure_internal' where id=$1", [workspace]);
    await admin.query("insert into workspaces(id,name,operating_model) values($1,'SYNTHETIC foreign','managed_by_novalure')", [foreignWorkspace]);
    for (const id of [ownerId, broker, actor, customerActor, machineActor]) {
      await admin.query("insert into workspace_users(id,workspace_id,name,email,role,product_role) values($1,$2,'SYNTHETIC revocable',$3,$4,$5)", [id, workspace, `${id}@example.invalid`, id === ownerId ? "admin" : "agent", id === ownerId ? "novalureAdmin" : id === customerActor ? "project_sales_member" : "novalure_operator"]);
      if (id !== ownerId) await admin.query("update auth_identities set credential_state='disabled',disabled_at=now(),password_hash=null where id=(select auth_identity_id from workspace_users where id=$1)", [id]);
    }
    for (const id of [bot, customerBot, machineBot]) await admin.query("insert into bots(id,workspace_id,name,role) values($1,$2,'SYNTHETIC revocable','advisor')", [id, workspace]);
    const principal = (await admin.query("select id,actor_user_id from crm_service_principals where identity_id='EVELYN_CRM_SERVICE_IDENTITY'")).rows[0];
    for (const [id, actorId, botId, brokerId, token, department] of [[binding, actor, bot, broker, digest(capability), "executive"], [customerBinding, customerActor, customerBot, ownerId, digest(customerCapability), "support"], [machineBinding, machineActor, machineBot, principal.actor_user_id, machineHash, "support"]]) {
      await admin.query("insert into behavior_runtime_bindings(id,workspace_id,broker_actor_id,actor_id,bot_id,department,token_hash,enabled,expires_at) values($1,$2,$3,$4,$5,$6,$7,true,now()+interval '1 day')", [id, workspace, brokerId, actorId, botId, department, token]);
    }
    await admin.query("insert into behavior_personal_workload_bindings(id,workspace_id,broker_actor_id,issuer,audience,subject,project_id,owner_id,environment,custom_environment_id,enabled,expires_at) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,true,now()+interval '1 day')", [workload, workspace, broker, identity.issuer, identity.audience, identity.subject, identity.projectId, identity.ownerId, identity.environment, identity.customEnvironmentId]);
    await admin.query("insert into knowledge_center_entitlements(workspace_id,enabled,max_sources,max_storage_bytes,max_queries_per_month,contract_reference,limits) values($1,true,20,20000000,1000,'SYNTHETIC-REVOCABLE','{\"maxAreas\":20,\"maxUsers\":20,\"maxAssistants\":20}')", [workspace]);
    const owner: AppSession = { authenticated: true, source: "database", workspaceId: workspace, userId: ownerId, workspaceName: "SYNTHETIC", name: "SYNTHETIC", email: "synthetic@example.invalid", role: "admin", productRole: "novalureAdmin", permissions: getRolePermissions("admin"), productPermissions: getProductRoleCapabilities("novalureAdmin") };
    const area = await createKnowledgeArea(owner, { name: "SYNTHETIC assigned", kind: "company" }, options);
    const source = await createKnowledgeSource(owner, { areaId: area.id, name: "SYNTHETIC source", type: "manual", content: "revocableanchor EXPLICITLY_ALLOWED" }, options);
    await publishKnowledgeSource(owner, { sourceId: source.id, versionId: source.draftVersionId!, expectedVersion: source.revision }, options);
    await assignKnowledgeAreas(owner, { botId: bot, channel: "internal", areaIds: [area.id] }, options);
    const rows = async () => ({ runtime: (await admin!.query("select to_jsonb(b) as data from behavior_runtime_bindings b order by id")).rows.map(r => r.data), personal: (await admin!.query("select to_jsonb(b) as data from behavior_personal_workload_bindings b")).rows.map(r => r.data) });
    const security = async () => (await admin!.query("select p.proname,p.proowner,p.proacl,p.prosecdef,p.proconfig from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname=any($1) order by p.proname", [functions])).rows;
    const oldRows = await rows(), oldSecurity = await security(), migration = await readFile("migrations/119_shared_behavior_revocable_operation.sql", "utf8");
    await t.test("atomic upgrade preserves old bounded rows and all function ownership/ACL/security", async () => {
      const c = await admin!.connect(); try { await c.query("begin"); await c.query(migration); await c.query("rollback"); } finally { c.release(); }
      assert.deepEqual(await rows(), oldRows);
      assert.equal((await admin!.query("select count(*)::int as n from information_schema.columns where table_name='behavior_runtime_bindings' and column_name='operating_mode'")).rows[0].n, 0);
      await apply("119_shared_behavior_revocable_operation.sql");
      const upgraded = await rows();
      for (const key of ["runtime", "personal"] as const) assert.deepEqual(upgraded[key].map(({ operating_mode, ...r }) => { assert.equal(operating_mode, "bounded"); return r; }), oldRows[key]);
      assert.deepEqual(await security(), oldSecurity);
      assert.equal((await admin!.query("select bool_and(relrowsecurity and relforcerowsecurity) as closed from pg_class where oid in ('behavior_runtime_bindings'::regclass,'behavior_personal_workload_bindings'::regclass)")).rows[0].closed, true);
      for (const table of ["behavior_runtime_bindings", "behavior_personal_workload_bindings"]) assert.equal((await admin!.query("select has_column_privilege('novalure_behavior_resolver',$1,'operating_mode','UPDATE') as allowed", [table])).rows[0].allowed, false);
    });
    await t.test("mode/expiry representation rejects NULL bounded, finite revocable, infinity and unknown modes", async () => {
      for (const table of ["behavior_runtime_bindings", "behavior_personal_workload_bindings"]) for (const set of ["expires_at=null", "operating_mode='revocable'", "expires_at='infinity'", "operating_mode='unknown'"]) await assert.rejects(admin!.query(`update ${table} set ${set}`), code("23514"));
    });
    const lock = async (workspaceId: string = workspace, actorId = actor, brokerId = broker, capHash = digest(capability)) => withTenantTransaction({ workspaceId, actorId }, tx => tx.query("select * from behavior_lock_runtime($1,$2)", [brokerId, capHash]), options);
    const workloadAuth = async () => (await runtime!.query("select * from behavior_authenticate_personal_workload()")).rows;
    await t.test("bounded expiries still deny both runtime and personal authentication", async () => {
      await admin!.query("update behavior_runtime_bindings set expires_at=now()-interval '1 second' where id=$1", [binding]); assert.equal((await lock()).length, 0);
      await admin!.query("update behavior_runtime_bindings set expires_at=now()+interval '1 day' where id=$1", [binding]);
      await admin!.query("update behavior_personal_workload_bindings set not_before=now()-interval '1 day',expires_at=now()-interval '1 second'"); assert.equal((await workloadAuth()).length, 0);
      await admin!.query("update behavior_personal_workload_bindings set expires_at=now()+interval '1 day'");
    });
    const signing = await generateKeyPair("RS256"), keyResolver = createLocalJWKSet({ keys: [{ ...await exportJWK(signing.publicKey), kid: "synthetic-revocable", alg: "RS256", use: "sig" }] });
    const now = Math.floor(Date.now() / 1000), token = await new SignJWT({ iss: identity.issuer, aud: identity.audience, sub: identity.subject, owner_id: identity.ownerId, owner: "novalure", project_id: identity.projectId, project: "evelyn", environment: identity.environment, custom_environment_id: identity.customEnvironmentId, jti: randomUUID(), iat: now - 1, nbf: now - 1, exp: now + 3600 }).setProtectedHeader({ typ: "JWT", alg: "RS256", kid: "synthetic-revocable" }).sign(signing.privateKey);
    const env = { NODE_ENV: "test" as const, VERCEL_ENV: "production", EVELYN_SHARED_RUNTIME_ENABLED: "1", EVELYN_SHARED_PERSONAL_RUNTIME_ENABLED: "1" };
    const request = (value: unknown) => new Request("https://crm.example.invalid/api/integrations/evelyn/runtime/context", { method: "POST", headers: { authorization: `Bearer ${token}`, "x-evelyn-runtime-token": capability, "content-type": "application/json" }, body: JSON.stringify(value) });
    const context = () => handleEvelynRuntimeRequest(request({ query: "revocableanchor" }), "context", { ...options, env, personalAuth: { env, keyResolver } });
    await t.test("revocable NULL works through the actual personal context and private customer signal paths", async () => {
      await admin!.query("update behavior_runtime_bindings set operating_mode='revocable',expires_at=null");
      await admin!.query("update behavior_personal_workload_bindings set operating_mode='revocable',expires_at=null");
      assert.equal((await lock()).length, 1); assert.equal((await workloadAuth()).length, 1);
      const response = await context(); assert.equal(response.status, 200, await response.clone().text()); assert.match(JSON.stringify(await response.json()), /EXPLICITLY_ALLOWED/);
      const receipt = await recordBoundAssistantFormatSignal({ workspaceId: workspace, projectId: null, botId: customerBot, integrationId: null, brokerActorId: ownerId, actorId: customerActor, capability: customerCapability }, { kind: "bot" }, { eventId: randomUUID(), issue: "unclear_next_step", outcome: "pass" }, options);
      assert.equal(receipt.recorded, true);
      assert.equal((await admin!.query("select count(*)::int as n from project_pipeline_permissions where user_id=$1", [customerActor])).rows[0].n, 0);
    });
    await t.test("foreign tenant, broker and capability are still denied", async () => {
      assert.equal((await lock(foreignWorkspace)).length, 0); assert.equal((await lock(workspace, actor, randomUUID())).length, 0); assert.equal((await lock(workspace, actor, broker, digest("foreign"))).length, 0);
    });
    await t.test("runtime and workload disabled/revoked states and broker suspension still deny", async () => {
      for (const set of ["enabled=false", "revoked_at=clock_timestamp()"]) {
        await admin!.query(`update behavior_runtime_bindings set ${set} where id=$1`, [binding]); assert.equal((await context()).status, 403);
        await admin!.query("update behavior_runtime_bindings set enabled=true,revoked_at=null where id=$1", [binding]);
        await admin!.query(`update behavior_personal_workload_bindings set ${set}`); assert.equal((await context()).status, 401);
        await admin!.query("update behavior_personal_workload_bindings set enabled=true,revoked_at=null");
      }
      await admin!.query("update workspace_users set status='suspended' where id=$1", [broker]); assert.equal((await context()).status, 401);
      await admin!.query("update workspace_users set status='active' where id=$1", [broker]);
    });
    await t.test("the unchanged machine principal expiry remains mandatory for a revocable runtime", async () => {
      const check = () => withTenantTransaction({ workspaceId: workspace, actorId: machineActor }, tx => tx.queryOne<{ allowed: boolean }>("select behavior_lock_workload($1,$2) as allowed", [principal.id, principal.actor_user_id]), options);
      await admin!.query("update crm_service_principals set expires_at=now()+interval '1 day' where id=$1", [principal.id]); assert.equal((await check())?.allowed, true);
      await admin!.query("update crm_service_principals set not_before=now()-interval '1 day',expires_at=now()-interval '1 second' where id=$1", [principal.id]); assert.equal((await check())?.allowed, false);
    });
    await t.test("revocable bindings do not restore a withdrawn knowledge grant", async () => {
      await admin!.query("delete from knowledge_area_grants where bot_id=$1 and channel='internal'", [bot]);
      const response = await context(); assert.equal(response.status, 200); assert.deepEqual((await response.json()).knowledge.excerpts, []);
    });
    await t.test("binding, workload, broker and actor SHARE fences persist until transaction commit", async () => {
      const competing = await admin!.connect();
      try {
        await withTenantTransaction({ workspaceId: workspace, actorId: actor }, async tx => {
          assert.equal((await tx.query("select * from behavior_lock_runtime($1,$2)", [broker, digest(capability)])).length, 1);
          assert.equal((await tx.queryOne<{ allowed: boolean }>("select behavior_lock_personal_workload($1,$2) as allowed", [workload, broker]))?.allowed, true);
          for (const [sql, id] of [["update behavior_runtime_bindings set enabled=false where id=$1", binding], ["update behavior_personal_workload_bindings set enabled=false where id=$1", workload], ["update workspace_users set status='suspended' where id=$1", broker], ["update workspace_users set status='suspended' where id=$1", actor], ["update bots set name=name where id=$1", bot]]) {
            await competing.query("begin"); await competing.query("set local lock_timeout='100ms'"); await assert.rejects(competing.query(sql, [id]), code("55P03")); await competing.query("rollback");
          }
        }, options);
        await competing.query("update behavior_runtime_bindings set enabled=false where id=$1", [binding]); assert.equal((await lock()).length, 0);
      } finally { await competing.query("rollback"); competing.release(); }
    });
  } finally { await Promise.allSettled([runtime?.end(), admin?.end(), bootstrap?.end()]); await cluster.stop(); }
});
