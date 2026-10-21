import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { test } from "node:test";
import type { PoolClient } from "pg";
import { applySalesSchema, LocalSalesPool, startLocalSalesDb } from "./lib/local-sales-db.mjs";
import { augmentKnowledgeQa, buildKnowledgeQaBootstrapSql, knowledgeQaAudience, knowledgeQaIdentity, knowledgeQaTarget } from "./lib/package4-machine-qa-native.mjs";
import { queryAuthenticationRows, withTenantTransaction, type TenantPool } from "../src/lib/db/tenant-client";
import type { AppSession } from "../src/lib/auth/session";
import { getRolePermissions } from "../src/lib/auth/permissions";
import { getProductRoleCapabilities } from "../src/lib/product-model";
import { handleMachineKnowledgeRequest } from "../src/lib/knowledge-center/assistant-http";
import type { KnowledgeQaAuthOptions } from "../src/lib/knowledge-center/qa-machine-auth";
import { assignKnowledgeAreas, createKnowledgeArea, createKnowledgeSource, publishKnowledgeSource, updateKnowledgeSource } from "../src/lib/knowledge-center/repository";

const sourceRevision = "196f0daa71e0d9b1eaeb51584388b27d7673dd3e";
const hash = (sql: string) => createHash("sha256").update(sql.replace(/\r\n/g, "\n")).digest("hex");
const code = (expected: string) => (error: unknown) => (error as { code?: string }).code === expected;
const reader = "select * from public.crm_authenticate_knowledge_qa_machine($1,$2,$3,$4,$5,$6,$7::uuid,$8,$9)";
const ids = { workspaceId: randomUUID(), actorUserId: randomUUID(), principalId: randomUUID(), botId: randomUUID() };
const authParams = () => [knowledgeQaIdentity.identityId, knowledgeQaIdentity.subject, knowledgeQaIdentity.issuer,
  knowledgeQaAudience(ids.workspaceId), knowledgeQaIdentity.projectId, knowledgeQaIdentity.ownerId, ids.workspaceId, "preview", "Evelyn.QA"];

test("QA SQL construction refuses ambiguous IDs and the internal Production fixture", () => {
  assert.throws(() => buildKnowledgeQaBootstrapSql({ ...ids, workspaceId: "not-a-uuid" }));
  assert.throws(() => buildKnowledgeQaBootstrapSql({ ...ids, actorUserId: ids.workspaceId }));
  assert.throws(() => buildKnowledgeQaBootstrapSql({ ...ids, workspaceId: "8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101" }));
});

test("native QA auth preserves the real 60/13/94 predecessor under FORCE RLS", { timeout: 180_000 }, async t => {
  const cluster = await startLocalSalesDb();
  let ownerPool: InstanceType<typeof LocalSalesPool> | undefined;
  let bootstrap: InstanceType<typeof LocalSalesPool> | undefined;
  let runtime: InstanceType<typeof LocalSalesPool> | undefined;
  let owner: PoolClient | undefined;
  try {
    // Local-only bootstrap roles. Only migration setup can bypass RLS; both the
    // augmentation owner and the application run without bypass during tests.
    await cluster.admin.query("create role neondb_owner login nosuperuser bypassrls createdb createrole");
    await cluster.admin.query("create role qa_schema_bootstrap login superuser");
    await cluster.admin.query("create database neondb owner neondb_owner");
    await cluster.admin.query("alter role novalure_app login inherit");
    const connection = { host: "127.0.0.1", port: cluster.port, database: "neondb", max: 4 };
    ownerPool = new LocalSalesPool({ ...connection, user: "neondb_owner" });
    bootstrap = new LocalSalesPool({ ...connection, user: "qa_schema_bootstrap" });
    runtime = new LocalSalesPool({ ...connection, user: "novalure_app" });
    const fixture = { ...cluster, admin: bootstrap, pool: runtime, role: "novalure_app" };
    // Retain the existing local harness's explicit optional-vector substitution.
    // Apply unchanged062 before060, as the accepted fresh QA profile does, so
    // its cleanup precedes append-only enforcement and the ledger is complete.
    await applySalesSchema(fixture, { maxMigrationNumber: 59 });
    const apply = async (filename: string, pool = bootstrap!) => {
      const sql = await readFile(`migrations/${filename}`, "utf8");
      const client = await pool.connect();
      try {
        await client.query("begin"); await client.query(sql);
        await client.query("insert into novalure_schema_migrations(version,name,checksum) values($1,$2,$3)", [filename.slice(0, -4), filename, hash(sql)]);
        await client.query("commit");
      } catch (error) { await client.query("rollback"); throw new Error(`Local predecessor ${filename} failed`, { cause: error }); }
      finally { client.release(); }
    };
    await apply("062_private_media_contract_cutover.sql");
    for (const name of (await readdir("migrations")).filter(name => /^\d{3}_[a-z0-9_]+\.sql$/u.test(name) && !name.includes("_rollback")).sort()) {
      const number = Number(name.slice(0, 3));
      if (number < 60 || number > 90 || number === 62) continue;
      if (number === 61) {
        await bootstrap.query("grant novalure_tenant_app to novalure_app");
        await bootstrap.query("comment on role novalure_tenant_app is 'novalure-tenant-cutover:local-sales-synthetic-test'");
      }
      await apply(name);
    }
    await bootstrap.query(await readFile("migrations/staged/087_d11_crm_source_of_truth_backfill.sql", "utf8"));
    for (let n = 0; n < 100; n++) {
      const state = (await bootstrap.query("select public.crm_d11_backfill_batch(500) as result")).rows[0].result;
      if (Object.values(state.remaining).every(value => Number(value) === 0)) break;
      assert.notEqual(n, 99, "D11 backfill must finish");
    }
    await bootstrap.query(await readFile("migrations/staged/087_d11_crm_source_of_truth_contract.sql", "utf8"));
    await bootstrap.query("reassign owned by qa_schema_bootstrap to neondb_owner");
    await cluster.admin.query("alter role novalure_app noinherit");
    await cluster.admin.query("grant novalure_tenant_app to novalure_app with inherit true,set false,admin false");
    for (const filename of ["091_production_runtime_forced_rls_cutover.sql", "092_crm_production_machine_identity.sql", "093_crm_machine_internal_context.sql",
      "094_website_sales_ingestion.sql", "095_form_tenant_isolation.sql", "096_public_integration_gateway.sql", "100_studio_enquiry_production.sql",
      "101_knowledge_center.sql", "102_knowledge_document_processing.sql", "103_knowledge_assistant_service.sql", "104_knowledge_publication_workflow.sql",
      "105_knowledge_website_monitoring.sql", "106_crm_operational_readers.sql", "107_knowledge_connected_assistant_quota.sql"]) await apply(filename, ownerPool);
    const projectId = randomUUID(), foreignWorkspace = randomUUID(), foreignActor = randomUUID();
    await ownerPool.query(`insert into workspaces(id,name,operating_model,customer_type,setup_state)
      values($1,'SYNTHETIC PACKAGE4 CUSTOMER A','self_service_customer','property_developer','{"syntheticQa":true,"package4HostedSeed":"package4-hosted-20261020-v1"}'),
      ($2,'SYNTHETIC PACKAGE4 CUSTOMER B','self_service_customer','property_developer','{"syntheticQa":true,"package4HostedSeed":"package4-hosted-20261020-v1"}')`, [ids.workspaceId, foreignWorkspace]);
    await ownerPool.query("insert into projects(id,workspace_id,name,type,data_classification,data_purpose) values($1,$2,'SYNTHETIC PACKAGE4 customer project','Bauträger','CUSTOMER_TENANT','crm_sales')", [projectId, ids.workspaceId]);
    await ownerPool.query("insert into bots(id,workspace_id,project_id,name,role) values($1,$2,$3,'SYNTHETIC PACKAGE4 QA bot','advisor')", [ids.botId, ids.workspaceId, projectId]);
    await cluster.admin.query("alter role neondb_owner nobypassrls");
    owner = await ownerPool.connect();
    await owner.query("select set_config('neon.project_id',$1,false),set_config('neon.branch_id',$2,false)", [knowledgeQaTarget.projectId, knowledgeQaTarget.branchId]);
    const canonicalMigrationChecksums = (await owner.query("select version,name,checksum from novalure_schema_migrations order by version")).rows;
    assert.equal(canonicalMigrationChecksums.length, 60);
    const args = { owner, target: knowledgeQaTarget, ...ids, sourceRevision, canonicalMigrationChecksums };
    const options = { pool: runtime as unknown as TenantPool };
    const authenticate = (params = authParams()) => queryAuthenticationRows(reader, params, options);

    await t.test("fingerprints, supplied target and complete canonical checksum manifest fail closed before DDL", async () => {
      await assert.rejects(augmentKnowledgeQa({ ...args, target: { ...knowledgeQaTarget, projectId: "production" } }));
      await owner!.query("select set_config('neon.branch_id','wrong-branch',false)");
      await assert.rejects(augmentKnowledgeQa(args), /fingerprint/u);
      await owner!.query("select set_config('neon.branch_id',$1,false)", [knowledgeQaTarget.branchId]);
      await assert.rejects(augmentKnowledgeQa({ ...args, canonicalMigrationChecksums: canonicalMigrationChecksums.slice(1) }), /60-row/u);
      const wrong = canonicalMigrationChecksums.map((row, n) => n === 0 ? { ...row, checksum: "a".repeat(64) } : row);
      await assert.rejects(augmentKnowledgeQa({ ...args, canonicalMigrationChecksums: wrong }), /checksum/u);
      assert.equal((await owner!.query("select to_regprocedure('public.crm_authenticate_knowledge_qa_machine(text,text,text,text,text,text,uuid,text,text)') is null as absent")).rows[0].absent, true);
    });

    await t.test("unexpected old constraint broadening aborts without a partial reader or actor", async () => {
      const expression = (await owner!.query("select pg_get_expr(conbin,conrelid) as expression from pg_constraint where conrelid='crm_service_principals'::regclass and conname='crm_service_principals_environment_check'")).rows[0].expression;
      await owner!.query("alter table crm_service_principals drop constraint crm_service_principals_environment_check,add constraint crm_service_principals_environment_check check(environment in ('simulation','production','drift'))");
      try { await assert.rejects(augmentKnowledgeQa(args), /Unchanged092/u); }
      finally { await owner!.query(`alter table crm_service_principals drop constraint crm_service_principals_environment_check,add constraint crm_service_principals_environment_check check(${expression})`); }
      assert.equal((await owner!.query("select count(*)::int as n from workspace_users where id=$1", [ids.actorUserId])).rows[0].n, 0);
      assert.equal((await owner!.query("select to_regprocedure('public.crm_authenticate_knowledge_qa_machine(text,text,text,text,text,text,uuid,text,text)') is null as absent")).rows[0].absent, true);
    });

    const receipt = await augmentKnowledgeQa(args);
    await t.test("owner augmentation preserves 60 ledger rows, all 13 source checksums, 94 FORCE-RLS tables and old effective ACLs", () => {
      assert.equal(receipt.ledgerRows, 60); assert.equal(receipt.package4MigrationCount, 13);
      assert.deepEqual(receipt.rlsBefore, { enabled: 94, forced: 94 }); assert.deepEqual(receipt.rlsAfter, receipt.rlsBefore);
      assert.deepEqual(receipt.preservedFunctionsBefore, receipt.preservedFunctionsAfter);
      assert.equal(receipt.policyCatalogBeforeSha256, receipt.policyCatalogAfterSha256);
      assert.equal(receipt.existingGrantsRlsAndTriggersUnchanged, true);
      assert.equal(receipt.temporaryInsertPoliciesRemoved, true);
      assert.equal(receipt.bindings.length, 2); assert.equal(receipt.actor.role, "agent");
      assert.equal(receipt.actor.product_role, "project_sales_member"); assert.equal(receipt.actor.sessions, 0);
      assert.equal(receipt.reader.volatility, "v"); assert.equal(receipt.reader.securityDefiner, true);
      assert.equal(receipt.nativePrincipalLifetimeSeconds, 3600);
      assert.equal(new Date(receipt.principal.expires_at).valueOf() - new Date(receipt.principal.not_before).valueOf(), 3_600_000);
      assert.equal(receipt.allExistingPublicFunctionsBeforeSha256, receipt.allExistingPublicFunctionsAfterSha256);
    });
    await t.test("one-shot installer refuses a pre-existing installation instead of replacing its identity", async () => {
      await assert.rejects(augmentKnowledgeQa(args), /prior QA installation/u);
      assert.equal((await authenticate()).length, 1);
    });
    await t.test("real queryAuthenticationRows authenticates from cleared GUCs and returns no credential material", async () => {
      const rows = await authenticate(); assert.equal(rows.length, 1);
      assert.equal(rows[0].id, ids.principalId); assert.equal(rows[0].actor_user_id, ids.actorUserId);
      assert.equal(rows[0].data_context, "CUSTOMER_TENANT"); assert.deepEqual(rows[0].scopes, ["crm.projects.read"]);
      assert.equal(rows[0].auth_type, "VERCEL_OIDC_QA"); assert.equal("token_hash" in rows[0], false);
    });
    await t.test("each of nine pinned arguments, missing arguments and Production claims deny", async () => {
      for (let index = 0; index < 9; index++) {
        const params = authParams(); params[index] = index === 6 ? foreignWorkspace : "wrong";
        assert.equal((await authenticate(params)).length, 0, `parameter ${index + 1}`);
      }
      assert.equal((await authenticate(Array(9).fill(null))).length, 0);
      const production = authParams(); production[1] = "owner:novalure:project:evelyn:environment:production";
      production[3] = "urn:novalure:crm:production"; production[7] = "production"; production[8] = "Evelyn.Service";
      assert.equal((await authenticate(production)).length, 0);
      assert.equal((await queryAuthenticationRows(reader.replace("crm_authenticate_knowledge_qa_machine", "crm_authenticate_machine"), authParams(), options)).length, 0);
    });
    await t.test("bootstrap restores an unrelated starting context; both saved channels lock and reauthenticate", async () => {
      const client = await runtime!.connect();
      try {
        await client.query("begin"); await client.query("select set_config('app.tenant_id',$1,true),set_config('app.actor_id',$2,true)", [foreignWorkspace, foreignActor]);
        assert.equal((await client.query(reader, authParams())).rowCount, 1);
        assert.deepEqual((await client.query("select current_setting('app.tenant_id',true) as tenant,current_setting('app.actor_id',true) as actor")).rows[0], { tenant: foreignWorkspace, actor: foreignActor });
      } finally { await client.query("rollback"); client.release(); }
      await withTenantTransaction({ workspaceId: ids.workspaceId, actorId: ids.actorUserId }, async tx => {
        for (const channel of ["webchat", "voice"]) {
          const lock = await tx.query("select * from knowledge_lock_assistant_service_binding($1,$2)", [ids.principalId, channel]);
          assert.equal(lock[0]?.bot_id, ids.botId); assert.equal((await tx.query(reader, authParams())).length, 1);
        }
        assert.equal((await tx.query("select * from knowledge_lock_assistant_service_binding($1,'other')", [ids.principalId])).length, 0);
      }, options);
    });
    await t.test("a definer read failure leaves the caller's unrelated scope unchanged", async () => {
      await bootstrap!.query(`create function public.package4_qa_test_failure() returns boolean language plpgsql volatile as $$
        begin raise exception using errcode='P0001',message='SYNTHETIC QA forced read failure'; end $$;
        create policy package4_qa_test_failure on public.crm_service_principals as restrictive for select to neondb_owner using(public.package4_qa_test_failure())`);
      const client = await runtime!.connect();
      try {
        await client.query("begin");
        await client.query("select set_config('app.tenant_id',$1,true),set_config('app.actor_id',$2,true)", [foreignWorkspace, foreignActor]);
        await client.query("savepoint expected_failure");
        await assert.rejects(client.query(reader, authParams()), code("P0001"));
        await client.query("rollback to savepoint expected_failure");
        assert.deepEqual((await client.query("select current_setting('app.tenant_id',true) as tenant,current_setting('app.actor_id',true) as actor")).rows[0], { tenant: foreignWorkspace, actor: foreignActor });
      } finally {
        await client.query("rollback"); client.release();
        await bootstrap!.query("drop policy package4_qa_test_failure on public.crm_service_principals; drop function public.package4_qa_test_failure()");
      }
    });

    await t.test("real HTTP handler uses the QA reader, saved channel grants and published local fixture, with actor/kill denial", async () => {
      // This new synthetic content exists only in the disposable local cluster.
      // The installer itself never writes knowledge, publications or contracts.
      const adminId = randomUUID();
      await bootstrap!.query("insert into workspace_users(id,workspace_id,name,email,role,product_role,status) values($1,$2,'SYNTHETIC local QA fixture admin',$3,'owner','customer_owner','active')", [adminId, ids.workspaceId, `qa-fixture-${adminId}@example.invalid`]);
      await bootstrap!.query("insert into workspace_module_settings(workspace_id,module_key,enabled,reason) values($1,'bots',true,'SYNTHETIC local fixture'),($1,'knowledge',true,'SYNTHETIC local fixture')", [ids.workspaceId]);
      await bootstrap!.query(`insert into knowledge_center_entitlements(workspace_id,enabled,max_sources,max_storage_bytes,max_queries_per_month,contract_reference,features,limits)
        values($1,true,20,10000000,100,'SYNTHETIC-LOCAL-QA-ONLY','{"webchatAccess":true,"voiceAccess":true}',
        '{"maxAreas":20,"maxWebsites":20,"maxScansPerMonth":20,"maxUsers":20,"maxAssistants":20}')`, [ids.workspaceId]);
      const session: AppSession = { authenticated: true, source: "database", workspaceId: ids.workspaceId, userId: adminId,
        workspaceName: "SYNTHETIC local QA workspace", name: "SYNTHETIC local QA admin", email: `qa-fixture-${adminId}@example.invalid`,
        role: "owner", productRole: "customer_owner", permissions: getRolePermissions("owner"), productPermissions: getProductRoleCapabilities("customer_owner") };
      const area = await createKnowledgeArea(session, { name: "SYNTHETIC local QA published area", kind: "company" }, options);
      let source = await createKnowledgeSource(session, { areaId: area.id, name: "SYNTHETIC local QA source", type: "manual", content: "SYNTHETIC qahttpanchor: Office opens at 09:00." }, options);
      source = await publishKnowledgeSource(session, { sourceId: source.id, versionId: source.draftVersionId!, expectedVersion: source.revision }, options);
      await updateKnowledgeSource(session, { sourceId: source.id, expectedVersion: source.revision, content: "SYNTHETIC qahttpanchor: DRAFT_ONLY office opens at 11:00." }, options);
      for (const channel of ["webchat", "voice"] as const) await assignKnowledgeAreas(session, { botId: ids.botId, channel, areaIds: [area.id] }, options);
      const now = new Date(), seconds = Math.floor(now.valueOf() / 1000);
      type Verification = Awaited<ReturnType<NonNullable<KnowledgeQaAuthOptions["verifier"]>>>;
      const qaMachineAuth: KnowledgeQaAuthOptions = { now,
        env: { NODE_ENV: "production", CRM_KNOWLEDGE_QA_MACHINE_ENABLED: "1", CRM_KNOWLEDGE_QA_WORKSPACE_ID: ids.workspaceId,
          VERCEL: "1", VERCEL_ENV: "preview", VERCEL_TARGET_ENV: "preview", VERCEL_PROJECT_ID: "prj_R32Okl6AHijTohvuKmryuTLjWMsk",
          VERCEL_GIT_COMMIT_REF: "codex/evelyn-crm-package4-integration", VERCEL_URL: "qa-native-local.vercel.app" },
        // Injected signature verifier is LOCAL evidence only; every downstream
        // bootstrap/read/lock/retrieval/tenant check uses actual PostgreSQL.
        verifier: async () => ({ payload: { aud: knowledgeQaAudience(ids.workspaceId), iss: knowledgeQaIdentity.issuer,
          sub: knowledgeQaIdentity.subject, project_id: knowledgeQaIdentity.projectId, owner_id: knowledgeQaIdentity.ownerId,
          environment: "preview", iat: seconds, nbf: seconds, exp: seconds + 1800, jti: randomUUID() },
        protectedHeader: { alg: "RS256", typ: "JWT", kid: "synthetic-local-qa-key" } }) as Verification };
      const call = async (channel: "webchat" | "voice") => {
        const response = await handleMachineKnowledgeRequest(new Request(`https://qa-native-local.vercel.app/api/integrations/knowledge/${channel}`, {
          method: "POST", headers: { authorization: `Bearer eyJ${"a".repeat(20)}.${"b".repeat(24)}.${"c".repeat(24)}`, "content-type": "application/json" },
          body: JSON.stringify({ query: "qahttpanchor" }),
        }), channel, { ...options, qaMachineAuth });
        return { status: response.status, body: await response.json() as Record<string, unknown> };
      };
      for (const channel of ["webchat", "voice"] as const) {
        const response = await call(channel); assert.equal(response.status, 200, JSON.stringify(response.body));
        assert.match(JSON.stringify(response.body), /09:00/u); assert.doesNotMatch(JSON.stringify(response.body), /DRAFT_ONLY|11:00/u);
      }
      await bootstrap!.query("update knowledge_assistant_service_bindings set enabled=false where principal_id=$1 and channel='voice'", [ids.principalId]);
      try { assert.equal((await call("voice")).status, 403); assert.equal((await call("webchat")).status, 200); }
      finally { await bootstrap!.query("update knowledge_assistant_service_bindings set enabled=true where principal_id=$1 and channel='voice'", [ids.principalId]); }
      await bootstrap!.query("update workspace_users set status='suspended' where id=$1", [ids.actorUserId]);
      try { assert.ok([401, 403].includes((await call("voice")).status)); }
      finally { await bootstrap!.query("update workspace_users set status='active' where id=$1", [ids.actorUserId]); }
      await bootstrap!.query("update crm_service_principals set kill_switch_active=true,kill_switch_reason='SYNTHETIC local HTTP denial' where id=$1", [ids.principalId]);
      try { assert.ok([401, 403].includes((await call("voice")).status)); }
      finally { await bootstrap!.query("update crm_service_principals set kill_switch_active=false,kill_switch_reason=null where id=$1", [ids.principalId]); }
    });

    const denials = [
      ["revoked principal", "update crm_service_principals set revoked_at=now() where id=$1", "update crm_service_principals set revoked_at=null where id=$1", ids.principalId],
      ["expired principal", "update crm_service_principals set expires_at=now()-interval '1 second' where id=$1", "update crm_service_principals set expires_at=not_before+interval '1 hour' where id=$1", ids.principalId],
      ["future not-before", "update crm_service_principals set not_before=now()+interval '1 day' where id=$1", "update crm_service_principals set not_before=now() where id=$1", ids.principalId],
      ["disabled state", "update crm_service_principals set state='DISABLED' where id=$1", "update crm_service_principals set state='ACTIVE' where id=$1", ids.principalId],
      ["kill switch", "update crm_service_principals set kill_switch_active=true,kill_switch_reason='SYNTHETIC QA denial' where id=$1", "update crm_service_principals set kill_switch_active=false,kill_switch_reason=null where id=$1", ids.principalId],
      ["suspended member", "update workspace_users set status='suspended' where id=$1", "update workspace_users set status='active' where id=$1", ids.actorUserId],
      ["owner member", "update workspace_users set role='owner' where id=$1", "update workspace_users set role='agent' where id=$1", ids.actorUserId],
      ["operator member", "update workspace_users set product_role='novalure_operator' where id=$1", "update workspace_users set product_role='project_sales_member' where id=$1", ids.actorUserId],
      ["missing QA workspace marker", "update workspaces set setup_state='{}' where id=$1", "update workspaces set setup_state='{\"syntheticQa\":true,\"package4HostedSeed\":\"package4-hosted-20261020-v1\"}' where id=$1", ids.workspaceId],
      ["internal workspace", "update workspaces set operating_model='novalure_internal',customer_type='novalure_internal' where id=$1", "update workspaces set operating_model='self_service_customer',customer_type='property_developer' where id=$1", ids.workspaceId],
    ];
    for (const [label, change, restore, id] of denials) await t.test(`native auth denies ${label}`, async () => {
      await bootstrap!.query(change, [id]);
      try { assert.equal((await authenticate()).length, 0); }
      finally { await bootstrap!.query(restore, [id]); }
      assert.equal((await authenticate()).length, 1);
    });

    await t.test("QA constraint branch rejects extra scopes, static tokens, wrong identity and internal data classification", async () => {
      for (const update of ["scopes=array['crm.projects.read','crm.tasks.write']::text[]", "token_hash=repeat('a',64)",
        "identity_id='FORGED_QA_IDENTITY'", "data_context='NOVALURE_INTERNAL'", "environment='production'", "issuer=null"]) {
        await assert.rejects(bootstrap!.query(`update crm_service_principals set ${update} where id=$1`, [ids.principalId]), code("23514"));
      }
      assert.equal((await authenticate()).length, 1);
    });
    await t.test("original simulation and exact Production rows retain their old constraints and reader", async () => {
      const legacyId = randomUUID();
      await bootstrap!.query(`insert into crm_service_principals(id,workspace_id,actor_user_id,token_hash,tenant_alias,agent_id,scopes,data_context,data_classification,purpose,expires_at,identity_id,service_subject)
        values($1,$2,$3,repeat('b',64),'sim-package4-legacy','sales',array['crm.projects.read'],'CUSTOMER_TENANT','CONFIDENTIAL','OPERATIONS',now()+interval '1 day',$4,$4)`, [legacyId, ids.workspaceId, ids.actorUserId, `qa:${legacyId}`]);
      await owner!.query("begin");
      try {
        await owner!.query("select set_config('app.tenant_id','8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101',true),set_config('app.actor_id','6122a6da-e7f4-47fa-bc55-e296bb01af62',true)");
        const original = await owner!.query("select * from crm_authenticate_machine($1,$2,$3,$4,$5,$6,$7::uuid,$8,$9)", ["EVELYN_CRM_SERVICE_IDENTITY", "owner:novalure:project:evelyn:environment:production", knowledgeQaIdentity.issuer, "urn:novalure:crm:production", knowledgeQaIdentity.projectId, knowledgeQaIdentity.ownerId, "8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101", "production", "Evelyn.Service"]);
        assert.equal(original.rowCount, 1); assert.equal(original.rows[0].auth_type, "VERCEL_OIDC");
      } finally { await owner!.query("rollback"); }
    });
    await t.test("runtime cannot provision/change the principal, binding or constraints", async () => {
      for (const sql of ["insert into crm_service_principals default values", "delete from knowledge_assistant_service_bindings", "alter table crm_service_principals drop constraint crm_service_principals_environment_check"]) {
        await assert.rejects(runtime!.query(sql), code("42501"));
      }
      const permissions = (await runtime!.query("select has_table_privilege(current_user,'crm_service_principals','INSERT') as principals,has_table_privilege(current_user,'knowledge_assistant_service_bindings','INSERT') as bindings,rolsuper,rolbypassrls from pg_roles where rolname=current_user")).rows[0];
      assert.deepEqual(permissions, { principals: false, bindings: false, rolsuper: false, rolbypassrls: false });
    });
  } finally {
    owner?.release();
    await Promise.allSettled([runtime?.end(), ownerPool?.end(), bootstrap?.end()]);
    await cluster.stop();
  }
});
