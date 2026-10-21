import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import type { AppSession } from "../src/lib/auth/session";
import { hashPassword } from "../src/lib/auth/passwords";
import { CrmCommandError, withCrmRead, type TenantTransactionOptions } from "../src/lib/crm-command";
import { runEditorPreflight } from "../src/lib/db/editor-preflight-repositories";
import { closeLocalTestPool } from "../src/lib/db/local-test-transport";
import { currentTenantTransaction } from "../src/lib/db/transaction-context";
import { createCsrfToken } from "../src/lib/security/csrf-core";
import { applySalesSchema, startLocalSalesDb } from "./lib/local-sales-db.mjs";
import { seedSalesBrowser } from "./lib/sales-browser-fixture.mjs";

test("editor preflight persists under the real tenant runtime without an outer transaction", { timeout: 180_000 }, async (t) => {
  // One disposable loopback cluster; never consume provider credentials or a recovery database.
  const db = await startLocalSalesDb();
  const keys = ["DATABASE_URL", "NODE_ENV", "CRM_LOCAL_TEST_DATABASE", "NOVALURE_SESSION_SECRET", "NOVALURE_APP_ORIGIN", "NOVALURE_AUTH_STRICT", "NOVALURE_AUTH_ENCRYPTION_KEY", "NOVALURE_AUTH_RATE_LIMIT_SECRET", "NOVALURE_DEMO_AUTH_ENABLED", "NOVALURE_TRUST_AUTH_HEADERS", "VERCEL", "VERCEL_ENV", "VERCEL_URL"];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    await applySalesSchema(db);
    // Reuse existing synthetic HTTP-auth bootstrap grants; no product policy or grants change.
    await seedSalesBrowser(db);
    for (const key of keys) delete process.env[key];
    const origin = "http://127.0.0.1:3000", secret = randomBytes(48).toString("base64url");
    Object.assign(process.env, { DATABASE_URL: `postgresql://${db.role}@127.0.0.1:${db.port}/postgres`, NODE_ENV: "test", CRM_LOCAL_TEST_DATABASE: "1", NOVALURE_SESSION_SECRET: secret, NOVALURE_APP_ORIGIN: origin, NOVALURE_AUTH_STRICT: "1", NOVALURE_AUTH_ENCRYPTION_KEY: randomBytes(40).toString("hex"), NOVALURE_AUTH_RATE_LIMIT_SECRET: randomBytes(40).toString("hex") });
    const workspaceId = randomUUID(), foreignWorkspace = randomUUID(), userId = randomUUID(), foreignUser = randomUUID(), restrictedUser = randomUUID(), projectId = randomUUID(), foreignProject = randomUUID();
    await db.admin.query("insert into workspaces(id,name,operating_model) values($1,'SYNTHETIC Preflight A','self_service_customer'),($2,'SYNTHETIC Preflight B','self_service_customer')", [workspaceId, foreignWorkspace]);
    const member = await db.admin.query("insert into workspace_users(id,workspace_id,name,email,role,product_role,status) values($1,$2,'Synthetic owner',$3,'owner','customer_owner','active') returning auth_identity_id", [userId, workspaceId, `preflight-${userId}@example.invalid`]);
    await db.admin.query("update auth_identities set credential_state='active',password_hash=$2 where id=$1", [member.rows[0].auth_identity_id, await hashPassword(randomBytes(32).toString("base64url"))]);
    await db.admin.query("insert into workspace_users(id,workspace_id,name,email,role,product_role,status) values($1,$2,'Other owner',$3,'owner','customer_owner','active'),($4,$5,'Read-only agent',$6,'agent','project_sales_member','active')", [foreignUser, foreignWorkspace, `preflight-${foreignUser}@example.invalid`, restrictedUser, workspaceId, `preflight-${restrictedUser}@example.invalid`]);
    await db.admin.query("insert into projects(id,workspace_id,name,type) values($1,$2,'Own project','Bauträger'),($3,$4,'Foreign project','Bauträger')", [projectId, workspaceId, foreignProject, foreignWorkspace]);
    await db.admin.query("insert into project_pipeline_permissions(workspace_id,project_id,user_id,can_read,can_edit_deals) values($1,$2,$3,true,false)", [workspaceId, projectId, restrictedUser]);
    const session: AppSession = { authenticated: true, workspaceId, userId, workspaceName: "Synthetic preflight", email: `preflight-${userId}@example.invalid`, name: "Synthetic owner", role: "owner", productRole: "customer_owner", permissions: ["crm:read", "crm:write"], productPermissions: ["bots:publish"], source: "cookie" };
    const options: TenantTransactionOptions = { pool: db.pool as unknown as NonNullable<TenantTransactionOptions["pool"]> };
    const counts = async () => (await db.admin.query("select (select count(*) from editor_preflight_runs where workspace_id=$1)::int as preflights,(select count(*) from audit_logs where workspace_id=$1 and action='editor.preflight_ran')::int as audits", [workspaceId])).rows[0];
    const policies = async () => (await db.admin.query("select c.relname,c.relrowsecurity,c.relforcerowsecurity,c.relacl::text,p.polname,pg_get_expr(p.polqual,p.polrelid) as using_sql,pg_get_expr(p.polwithcheck,p.polrelid) as check_sql from pg_class c left join pg_policy p on p.polrelid=c.oid where c.oid=any(array['editor_preflight_runs'::regclass,'audit_logs'::regclass]) order by c.relname,p.polname")).rows;
    const policiesBefore = await policies();

    await t.test("no-context INSERT still fails SQLSTATE42501 under non-owner FORCE RLS", async () => {
      const runtime = (await db.pool.query("select rolsuper,rolbypassrls,rolcreatedb,rolcreaterole from pg_roles where rolname=current_user")).rows[0];
      assert.deepEqual(runtime, { rolsuper: false, rolbypassrls: false, rolcreatedb: false, rolcreaterole: false });
      assert.ok(policiesBefore.every((row) => row.relrowsecurity && row.relforcerowsecurity));
      await assert.rejects(db.pool.query("insert into editor_preflight_runs(workspace_id,editor_type,created_by_user_id) values($1,'bot',$2)", [workspaceId, userId]), (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === "42501"));
      assert.deepEqual(await counts(), { preflights: 0, audits: 0 });
    });

    await t.test("the public repository entry creates a readable UUID plus its audit without caller wrapping", async () => {
      assert.equal(currentTenantTransaction(), undefined);
      const run = await runEditorPreflight({ session, editorType: "bot", payload: { name: "Synthetic draft", status: "draft", strictKnowledge: true } }, options);
      assert.match(run.id, /^[a-f0-9-]{36}$/);
      assert.equal(run.metadata?.source, "editor_preflight");
      assert.equal(run.workspaceId, workspaceId);
      const saved = await withCrmRead(session, (tx) => tx.queryOne("select id,workspace_id,created_by_user_id from editor_preflight_runs where id=$1", [run.id]), options);
      assert.deepEqual(saved, { id: run.id, workspace_id: workspaceId, created_by_user_id: userId });
      assert.deepEqual(await counts(), { preflights: 1, audits: 1 });
      assert.equal(currentTenantTransaction(), undefined);
      const scope = (await db.pool.query("select nullif(current_setting('app.tenant_id',true),'') as tenant,nullif(current_setting('app.actor_id',true),'') as actor")).rows[0];
      assert.deepEqual(scope, { tenant: null, actor: null });
    });

    await t.test("active-bot Knowledge checks read only the scoped workspace before persistence", async () => {
      await db.admin.query("insert into knowledge_sources(workspace_id,name,source_type,status) values($1,'Foreign approved','manual','approved')", [foreignWorkspace]);
      const input = { session, editorType: "bot" as const, payload: { status: "active", strictKnowledge: true, channels: [{ handoffRules: ["Synthetic handoff"] }], testPassed: true } };
      const denied = await runEditorPreflight(input, options);
      assert.ok(denied.blockers.includes("bot:approved_knowledge"));
      await db.admin.query("insert into knowledge_sources(workspace_id,name,source_type,status) values($1,'Own approved','manual','approved')", [workspaceId]);
      const allowed = await runEditorPreflight(input, options);
      assert.ok(!allowed.blockers.includes("bot:approved_knowledge"));
    });

    await t.test("fresh membership, foreign scope and read-only project remain denied without writes", async () => {
      const before = await counts();
      await db.admin.query("update workspace_users set status='invited' where id=$1", [userId]);
      try { await assert.rejects(runEditorPreflight({ session, editorType: "bot" }, options), (error: unknown) => error instanceof CrmCommandError && error.code === "FORBIDDEN"); }
      finally { await db.admin.query("update workspace_users set status='active' where id=$1", [userId]); }
      await assert.rejects(runEditorPreflight({ session: { ...session, workspaceId: foreignWorkspace }, editorType: "bot" }, options), (error: unknown) => error instanceof CrmCommandError && error.code === "FORBIDDEN");
      for (const input of [{ session, projectId: foreignProject }, { session: { ...session, userId: restrictedUser }, projectId }]) {
        await assert.rejects(runEditorPreflight({ ...input, editorType: "bot" }, options), (error: unknown) => error instanceof CrmCommandError && error.code === "PROJECT_FORBIDDEN");
      }
      assert.deepEqual(await counts(), before);
    });

    await t.test("same-scope nesting succeeds and cross-tenant nesting fails before effects", async () => {
      await withCrmRead(session, async () => {
        const run = await runEditorPreflight({ session, editorType: "calendar" }, options);
        assert.equal(run.workspaceId, workspaceId);
        await assert.rejects(runEditorPreflight({ session: { ...session, workspaceId: foreignWorkspace }, editorType: "calendar" }, options), (error: unknown) => error instanceof CrmCommandError && error.code === "TENANT_MISMATCH");
      }, options);
      assert.equal(currentTenantTransaction(), undefined);
    });

    await t.test("an audit failure rolls back the preflight INSERT in the same transaction", async () => {
      const before = await counts();
      await db.admin.query("create function synthetic_preflight_audit_failure() returns trigger language plpgsql as $$ begin if new.action='editor.preflight_ran' then raise exception 'Synthetic audit failure'; end if; return new; end $$; create trigger synthetic_preflight_audit_failure before insert on audit_logs for each row execute function synthetic_preflight_audit_failure()");
      try { await assert.rejects(runEditorPreflight({ session, editorType: "bot" }, options), /Synthetic audit failure/); }
      finally { await db.admin.query("drop trigger synthetic_preflight_audit_failure on audit_logs; drop function synthetic_preflight_audit_failure()"); }
      assert.deepEqual(await counts(), before);
    });

    await t.test("actual cookie+CSRF bot and dedicated preflight handlers use the fixed shared entry", async () => {
      // Synthetic persisted MFA session is limited to this loopback fixture; no live-auth claim.
      const cookie = "v2." + randomBytes(32).toString("base64url");
      await db.admin.query("insert into auth_sessions(id,token_hash,auth_identity_id,workspace_user_id,workspace_id,mfa_verified_at,expires_at) values($1,$2,$3,$4,$5,now(),now()+interval '1 hour')", [randomUUID(), createHash("sha256").update(cookie).digest("hex"), member.rows[0].auth_identity_id, userId, workspaceId]);
      const request = (pathname: string, body: unknown, validCsrf = true) => new Request(origin + pathname, { method: "POST", headers: { "content-type": "application/json", cookie: "novalure_session=" + cookie, origin, "sec-fetch-site": "same-origin", "x-novalure-csrf-token": validCsrf ? createCsrfToken({ method: "POST", pathname, secret, sessionCookie: cookie })!.token : "" }, body: JSON.stringify(body) });
      const botRoute = await import("../src/app/api/crm/bots/route");
      assert.equal((await botRoute.POST(request("/api/crm/bots", { bot: { name: "Denied synthetic draft" } }, false))).status, 403);
      const response = await botRoute.POST(request("/api/crm/bots", { bot: { name: "Synthetic scoped draft", status: "draft", strictKnowledge: true, channels: [] } }));
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.persisted, true);
      assert.match(body.bot.id, /^[a-f0-9-]{36}$/);
      assert.match(body.preflight.id, /^[a-f0-9-]{36}$/);
      assert.equal((await db.admin.query("select id from bots where id=$1 and workspace_id=$2", [body.bot.id, workspaceId])).rowCount, 1);
      const dedicated = await import("../src/app/api/crm/editor-preflight/route");
      const own = await dedicated.POST(request("/api/crm/editor-preflight", { editorType: "calendar", projectId }));
      assert.equal(own.status, 200);
      assert.match((await own.json()).preflight.id, /^[a-f0-9-]{36}$/);
    });
    assert.deepEqual(await policies(), policiesBefore);
  } finally {
    await closeLocalTestPool();
    try { await db.stop(); }
    finally {
      const fixtureRoot = path.join(process.cwd(), ".npm-cache", "qa", "sales-pg-");
      assert.ok(db.directory.startsWith(fixtureRoot));
      await rm(db.directory, { recursive: true, force: true });
      for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
    }
  }
});
