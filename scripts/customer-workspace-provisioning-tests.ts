import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import type { AppSession } from "../src/lib/auth/session";
import { getRolePermissions } from "../src/lib/auth/permissions";
import { getProductRoleCapabilities, type ProductRole } from "../src/lib/product-model";
import { withTenantTransaction, type TenantTransactionOptions } from "../src/lib/db/tenant-client";
import { withCrmRead } from "../src/lib/crm-command";
import { parseCustomerWorkspaceInput, provisionCustomerWorkspace } from "../src/lib/customer-workspace-provisioning";
import { applySalesSchema, startLocalSalesDb } from "./lib/local-sales-db.mjs";

// This suite never reads an environment connection string or starts a provider.
// PostgreSQL is disposable, loopback-only, and all identities/content are synthetic.
const input = (changes: Record<string, unknown> = {}) => ({
  name: "SYNTHETIC separate customer",
  projectName: "SYNTHETIC investment apartments",
  botName: "SYNTHETIC customer assistant",
  websiteUrl: "https://synthetic-customer.example/standort/",
  customerType: "property_developer",
  requestId: randomUUID(),
  ...changes,
});
const errorCode = (...expected: string[]) => (error: unknown) => Boolean(
  error && typeof error === "object" && "code" in error && expected.includes(String(error.code)),
);

test("customer provisioning parser rejects caller-selected authority, tenant IDs and commercial limits", () => {
  const valid = input();
  const parsed = parseCustomerWorkspaceInput(valid);
  assert.equal(parsed.name, valid.name);
  assert.equal(parsed.customerType, "property_developer");
  assert.equal(parsed.requestId, valid.requestId);
  assert.equal(parsed.websiteUrl, valid.websiteUrl);
  for (const extra of [
    { role: "owner" }, { productRole: "platform_admin" },
    { workspaceId: randomUUID() }, { authIdentityId: randomUUID() },
    { maxAssistants: 999 }, { limits: { maxAssistants: 999 } },
    { entitlement: { enabled: true } }, { password: "SYNTHETIC-do-not-accept" },
  ]) assert.throws(() => parseCustomerWorkspaceInput({ ...valid, ...extra }));
  for (const invalid of [null, [], "customer", { ...valid, name: " " },
    { ...valid, requestId: "invalid" }, { ...valid, customerType: "novalure_internal" },
    { ...valid, websiteUrl: "javascript:alert(1)" },
    { ...valid, websiteUrl: "https://user:password@synthetic-customer.example/" },
  ]) assert.throws(() => parseCustomerWorkspaceInput(invalid));
});

test("customer provisioning creates an isolated tenant through the real authenticated command", { timeout: 240_000 }, async t => {
  const db = await startLocalSalesDb();
  const options: TenantTransactionOptions = {
    pool: db.pool as unknown as NonNullable<TenantTransactionOptions["pool"]>,
    statementTimeoutMs: 15_000,
  };
  const internalWorkspace = randomUUID(), customerWorkspace = randomUUID();
  type MemberOptions = {
    workspaceId?: string;
    role?: AppSession["role"];
    productRole?: ProductRole;
    verified?: boolean;
    revoked?: boolean;
  };
  async function member(label: string, config: MemberOptions = {}): Promise<AppSession> {
    const userId = randomUUID(), authSessionId = randomUUID();
    const workspaceId = config.workspaceId ?? internalWorkspace;
    const role = config.role ?? "admin";
    const productRole = config.productRole ?? "novalure_onboarding";
    const email = `synthetic-${label}-${userId}@example.invalid`;
    const identity = (await db.admin.query(`insert into workspace_users(id,workspace_id,name,email,role,product_role,status)
      values($1,$2,$3,$4,$5,$6,'active') returning auth_identity_id`,
    [userId, workspaceId, `SYNTHETIC ${label}`, email, role, productRole])).rows[0].auth_identity_id as string;
    await db.admin.query(`update auth_identities set credential_state='active',password_hash=$2,
      mfa_enabled_at=now(),mfa_secret_ciphertext='SYNTHETIC-LOCAL-NOT-A-REAL-MFA-SECRET' where id=$1`,
    [identity, `SYNTHETIC-UNCHANGED-PASSWORD-${userId}`]);
    await db.admin.query(`insert into auth_sessions(id,token_hash,auth_identity_id,workspace_user_id,workspace_id,
      mfa_verified_at,expires_at,revoked_at,revoked_reason)
      values($1,$2,$3,$4,$5,case when $6 then now() else null end,now()+interval '1 hour',
        case when $7 then now() else null end,case when $7 then 'SYNTHETIC revoked fixture' else null end)`,
    [authSessionId, createHash("sha256").update(authSessionId).digest("hex"), identity, userId, workspaceId,
      config.verified !== false, config.revoked === true]);
    return {
      authenticated: true, source: "database", userId, workspaceId,
      workspaceName: "SYNTHETIC provisioning source", name: `SYNTHETIC ${label}`, email,
      role, productRole, permissions: getRolePermissions(role), productPermissions: getProductRoleCapabilities(productRole),
      authIdentityId: identity, authSessionId,
      // Deliberately claim MFA in the DTO even for the unverified fixture: only
      // the persisted session may authorize the privileged SQL operation.
      mfaEnabledAt: new Date().toISOString(), mfaVerifiedAt: new Date().toISOString(),
      workspaceOperatingModel: workspaceId === internalWorkspace ? "novalure_internal" : "self_service_customer",
    };
  }
  const countWorkspaces = async () => Number((await db.admin.query("select count(*) from workspaces")).rows[0].count);
  const callSql = (actor: AppSession, payload = input(), sessionId = actor.authSessionId) => withTenantTransaction(
    { actorId: actor.userId, workspaceId: actor.workspaceId },
    tx => tx.queryOne<{ result: unknown }>("select public.crm_provision_customer_workspace($1::uuid,$2::uuid,$3::jsonb) as result",
      [sessionId, payload.requestId, JSON.stringify(payload)]), options,
  );
  try {
    // The shared harness explicitly omits the historical production-only
    // cutovers. 114 is applied unchanged after the required current schema;
    // unrelated public-channel releases 111–113 are not part of this fixture.
    await applySalesSchema(db, { maxMigrationNumber: 110 });
    const migration = await readFile("migrations/114_customer_workspace_provisioning.sql", "utf8");
    const migrationClient = await db.admin.connect();
    try {
      await migrationClient.query("begin");
      await migrationClient.query(migration);
      await migrationClient.query("commit");
    } catch (error) { await migrationClient.query("rollback"); throw error; }
    finally { migrationClient.release(); }
    await db.admin.query(`insert into workspaces(id,name,operating_model,customer_type)
      values($1,'SYNTHETIC internal provisioner','novalure_internal','novalure_internal'),
        ($2,'SYNTHETIC existing customer','self_service_customer','property_developer')`,
    [internalWorkspace, customerWorkspace]);
    const operator = await member("operator");
    const customer = await member("customer", { workspaceId: customerWorkspace, role: "owner", productRole: "customer_owner" });
    const scoped = await member("scoped", { role: "agent" });
    const unverified = await member("unverified", { verified: false });
    const revoked = await member("revoked", { revoked: true });
    const differentIdentity = await member("different-identity");
    const firstInput = parseCustomerWorkspaceInput(input());
    let created: Awaited<ReturnType<typeof provisionCustomerWorkspace>>;
    let targetMemberId = "";

    await t.test("successful command creates exactly its own rows, reuses identity and grants bounded knowledge", async () => {
      const before = await countWorkspaces();
      const credentialBefore = (await db.admin.query("select password_hash,credential_state,mfa_secret_ciphertext,mfa_enabled_at from auth_identities where id=$1", [operator.authIdentityId])).rows[0];
      const identitiesBefore = Number((await db.admin.query("select count(*) from auth_identities")).rows[0].count);
      created = await withCrmRead(operator, async tx => {
        const result = await provisionCustomerWorkspace(operator, firstInput, options);
        const scope = await tx.queryOne<{ tenant: string; actor: string }>("select current_setting('app.tenant_id') as tenant,current_setting('app.actor_id') as actor");
        assert.deepEqual(scope, { tenant: operator.workspaceId, actor: operator.userId }, "provisioner must restore source context before receipt/audit writes");
        return result;
      }, options);
      assert.equal(created.persisted, true);
      assert.equal(created.replayed, false);
      assert.equal(await countWorkspaces(), before + 1);
      assert.notEqual(created.workspace.id, internalWorkspace);
      assert.notEqual(created.workspace.id, customerWorkspace);
      const workspace = (await db.admin.query("select name,operating_model,customer_type,active_calendar_provider from workspaces where id=$1", [created.workspace.id])).rows[0];
      assert.equal(workspace.name, firstInput.name);
      assert.equal(workspace.customer_type, "property_developer");
      assert.ok(["managed_by_novalure", "self_service_customer"].includes(workspace.operating_model));
      assert.equal(workspace.active_calendar_provider, "none");
      const membership = (await db.admin.query("select id,auth_identity_id,role,product_role,status,password_hash,email from workspace_users where workspace_id=$1", [created.workspace.id])).rows;
      assert.equal(membership.length, 1);
      targetMemberId = membership[0].id;
      assert.equal(membership[0].auth_identity_id, operator.authIdentityId);
      assert.equal(membership[0].email.toLowerCase(), operator.email.toLowerCase());
      assert.equal(membership[0].role, "admin");
      assert.equal(membership[0].product_role, "workspace_admin");
      assert.equal(membership[0].status, "active");
      assert.equal(membership[0].password_hash, null);
      assert.equal(Number((await db.admin.query("select count(*) from auth_identities")).rows[0].count), identitiesBefore);
      assert.deepEqual((await db.admin.query("select password_hash,credential_state,mfa_secret_ciphertext,mfa_enabled_at from auth_identities where id=$1", [operator.authIdentityId])).rows[0], credentialBefore);
      const project = (await db.admin.query("select id,workspace_id,data_classification from projects where workspace_id=$1", [created.workspace.id])).rows;
      assert.deepEqual(project, [{ id: created.project.id, workspace_id: created.workspace.id, data_classification: "CUSTOMER_TENANT" }]);
      const bot = (await db.admin.query("select id,workspace_id,project_id,status,strict_knowledge from bots where workspace_id=$1", [created.workspace.id])).rows;
      assert.deepEqual(bot, [{ id: created.bot.id, workspace_id: created.workspace.id, project_id: created.project.id, status: "draft", strict_knowledge: true }]);
      const areas = (await db.admin.query("select id,workspace_id,project_id,kind from knowledge_areas where workspace_id=$1", [created.workspace.id])).rows;
      assert.deepEqual(areas, [{ id: created.knowledgeArea.id, workspace_id: created.workspace.id, project_id: created.project.id, kind: "project" }]);
      const entitlement = (await db.admin.query("select enabled,max_sources,max_storage_bytes::float8 as bytes,max_queries_per_month,contract_reference,features,limits from knowledge_center_entitlements where workspace_id=$1", [created.workspace.id])).rows[0];
      assert.equal(entitlement.enabled, true);
      assert.equal(entitlement.max_sources, 20);
      assert.equal(entitlement.bytes, 10_485_760);
      assert.equal(entitlement.max_queries_per_month, 100);
      assert.ok(entitlement.contract_reference?.trim());
      assert.equal(entitlement.features.websiteImport, true);
      assert.equal(entitlement.features.webchatAccess, true);
      assert.equal(entitlement.features.monitoring, false);
      assert.deepEqual(entitlement.limits, { maxAssistants: 1, maxAreas: 5, maxWebsites: 10, maxScansPerMonth: 10, maxUsers: 2 });
      for (const table of ["knowledge_sources", "knowledge_area_grants", "customer_workspace_access", "auth_sessions"]) {
        assert.equal(Number((await db.admin.query(`select count(*) from ${table} where workspace_id=$1`, [created.workspace.id])).rows[0].count), 0, `${table}: provisioning must not publish, invite or activate sessions`);
      }
      const modules = (await db.admin.query("select module_key,enabled from workspace_module_settings where workspace_id=$1 and module_key in ('bots','knowledge') order by module_key", [created.workspace.id])).rows;
      assert.deepEqual(modules, [{ module_key: "bots", enabled: true }, { module_key: "knowledge", enabled: true }]);
    });
    assert.ok(created!, "The isolated tenant must exist before its boundary checks");

    await t.test("retry and concurrent identical commands return one tenant, while changed payload conflicts", async () => {
      const before = await countWorkspaces();
      const replay = await provisionCustomerWorkspace(operator, firstInput, options);
      assert.equal(replay.replayed, true);
      assert.equal(replay.workspace.id, created.workspace.id);
      assert.equal(await countWorkspaces(), before);
      await assert.rejects(provisionCustomerWorkspace(operator, { ...firstInput, name: "SYNTHETIC changed request" }, options), errorCode("IDEMPOTENCY_CONFLICT"));
      const parallelInput = parseCustomerWorkspaceInput(input({ name: "SYNTHETIC concurrent customer" }));
      const results = await Promise.all([provisionCustomerWorkspace(operator, parallelInput, options), provisionCustomerWorkspace(operator, parallelInput, options)]);
      assert.equal(results[0].workspace.id, results[1].workspace.id);
      assert.equal(results.filter(result => result.replayed).length, 1);
      assert.equal(await countWorkspaces(), before + 1);
    });

    await t.test("persisted authority denies customers, scoped actors, false MFA and revoked sessions", async () => {
      const before = await countWorkspaces();
      for (const actor of [customer, scoped, unverified, revoked]) {
        await assert.rejects(provisionCustomerWorkspace(actor, parseCustomerWorkspaceInput(input()), options));
        await assert.rejects(callSql(actor), errorCode("42501"));
      }
      await assert.rejects(callSql(operator, input(), differentIdentity.authSessionId), errorCode("42501"));
      await assert.rejects(provisionCustomerWorkspace({ ...operator, authIdentityId: differentIdentity.authIdentityId }, parseCustomerWorkspaceInput(input()), options));
      assert.equal(await countWorkspaces(), before);
    });

    await t.test("an existing receipt does not bypass a revoked session or withdrawn MFA", async () => {
      try {
        await db.admin.query("update auth_sessions set mfa_verified_at=null where id=$1", [operator.authSessionId]);
        await assert.rejects(provisionCustomerWorkspace(operator, firstInput, options));
        await db.admin.query("update auth_sessions set mfa_verified_at=now(),revoked_at=now(),revoked_reason='SYNTHETIC replay revocation' where id=$1", [operator.authSessionId]);
        await assert.rejects(provisionCustomerWorkspace(operator, firstInput, options));
      } finally {
        await db.admin.query("update auth_sessions set mfa_verified_at=now(),revoked_at=null,revoked_reason=null where id=$1", [operator.authSessionId]);
      }
    });

    await t.test("RLS permits the new membership only in its own scope and denies foreign writes", async () => {
      const readIds = (workspaceId: string, actorId: string, table: "projects" | "bots" | "knowledge_areas") => withTenantTransaction(
        { workspaceId, actorId }, tx => tx.query<{ id: string }>(`select id from ${table} where workspace_id=$1`, [created.workspace.id]), options,
      );
      for (const [table, ownId] of [["projects", created.project.id], ["bots", created.bot.id], ["knowledge_areas", created.knowledgeArea.id]] as const) {
        assert.deepEqual(await readIds(created.workspace.id, targetMemberId, table), [{ id: ownId }]);
        assert.deepEqual(await readIds(customer.workspaceId, customer.userId, table), []);
        assert.deepEqual(await readIds(operator.workspaceId, operator.userId, table), []);
      }
      await assert.rejects(withTenantTransaction({ workspaceId: customer.workspaceId, actorId: customer.userId },
        tx => tx.execute("insert into knowledge_areas(workspace_id,name,kind,project_id) values($1,'SYNTHETIC forbidden','project',$2)", [created.workspace.id, created.project.id]), options), errorCode("42501"));
      await assert.rejects(withTenantTransaction({ workspaceId: created.workspace.id, actorId: targetMemberId },
        tx => tx.execute("update knowledge_center_entitlements set max_queries_per_month=999999 where workspace_id=$1", [created.workspace.id]), options), errorCode("42501"));
      const runtime = (await db.pool.query("select rolsuper,rolbypassrls from pg_roles where rolname=current_user")).rows[0];
      assert.deepEqual(runtime, { rolsuper: false, rolbypassrls: false });
      const provisionerRole = (await db.admin.query("select rolcanlogin,rolsuper,rolbypassrls from pg_roles where rolname='novalure_customer_provisioner'")).rows[0];
      assert.deepEqual(provisionerRole, { rolcanlogin: false, rolsuper: false, rolbypassrls: false });
      assert.equal((await db.pool.query("select pg_has_role(current_user,'novalure_customer_provisioner','MEMBER') as member")).rows[0].member, false);
      const leakedContext = (await db.pool.query("select nullif(current_setting('app.tenant_id',true),'') as tenant,nullif(current_setting('app.actor_id',true),'') as actor")).rows[0];
      assert.deepEqual(leakedContext, { tenant: null, actor: null });
    });
  } finally { await db.stop(); }
});
