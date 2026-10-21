import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import type { PoolClient } from "pg";
import { applySalesSchema, LocalSalesPool, startLocalSalesDb } from "./lib/local-sales-db.mjs";

// The source PR heads are intentionally pinned: a merged candidate must keep
// already reviewed migration bytes, including Package 3's 104/105, unchanged.
const designSource = "ee26bbd";
const knowledgeSource = "b019a16811bd1d0d7c180ff013b76cea34c6e5bf";
const files = [
  "091_production_runtime_forced_rls_cutover.sql", "092_crm_production_machine_identity.sql",
  "093_crm_machine_internal_context.sql", "094_website_sales_ingestion.sql",
  "095_form_tenant_isolation.sql", "096_public_integration_gateway.sql",
  "100_studio_enquiry_production.sql", "101_knowledge_center.sql",
  "102_knowledge_document_processing.sql", "103_knowledge_assistant_service.sql",
  "104_knowledge_publication_workflow.sql", "105_knowledge_website_monitoring.sql",
  "106_crm_operational_readers.sql",
];
const manual = new Set([91, 92, 93, 95, 96, 100]);
const digest = (sql: string) => createHash("sha256").update(sql.replace(/\r\n/g, "\n")).digest("hex");
const code = (...codes: string[]) => (error: unknown) => codes.includes(String((error as { code?: string }).code));
const evidencePath = path.resolve(".npm-cache/qa/package4-migrations.json");

async function catalog(pool: InstanceType<typeof LocalSalesPool>) {
  const parts = [];
  for (const sql of [
    "select c.relname,c.relkind,c.relrowsecurity,c.relforcerowsecurity,c.relowner::regrole::text,c.relacl::text from pg_class c where c.relnamespace='public'::regnamespace order by c.relname",
    "select c.relname,a.attname,a.atttypid::regtype::text,a.attnotnull,pg_get_expr(d.adbin,d.adrelid) as default_value from pg_attribute a join pg_class c on c.oid=a.attrelid left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum where c.relnamespace='public'::regnamespace and a.attnum>0 and not a.attisdropped order by c.relname,a.attnum",
    "select c.relname,k.conname,pg_get_constraintdef(k.oid),k.convalidated from pg_constraint k join pg_class c on c.oid=k.conrelid where c.relnamespace='public'::regnamespace order by c.relname,k.conname",
    "select p.oid::regprocedure::text as signature,pg_get_functiondef(p.oid),p.proacl::text,p.proowner::regrole::text from pg_proc p where p.pronamespace='public'::regnamespace and p.prokind='f' order by signature",
    "select tablename,policyname,permissive,roles,cmd,qual,with_check from pg_policies where schemaname='public' order by tablename,policyname",
    "select c.relname,t.tgname,pg_get_triggerdef(t.oid) from pg_trigger t join pg_class c on c.oid=t.tgrelid where c.relnamespace='public'::regnamespace and not t.tgisinternal order by c.relname,t.tgname",
  ]) parts.push((await pool.query(sql)).rows);
  return digest(JSON.stringify(parts));
}

test("Package 4 unchanged 091–096 → 100–106 combined migration acceptance", { timeout: 240_000 }, async t => {
  const cluster = await startLocalSalesDb();
  let owner: InstanceType<typeof LocalSalesPool> | undefined;
  let bootstrap: InstanceType<typeof LocalSalesPool> | undefined;
  let runtime: InstanceType<typeof LocalSalesPool> | undefined;
  const evidence: Record<string, unknown> = {
    status: "RUNNING", syntheticOnly: true, remoteDatabaseAccess: 0, productionAccess: 0,
    mode: "disposable loopback PostgreSQL; not a Neon clone or deployment proof",
    limitations: ["Historical 001 vector column/index substitution; manual 062 omitted by the existing shared fixture.",
      "Local identity names satisfy actual 091 guards; no Neon branch, cloud grants, customer data, Preview or Production was inspected.",
      "Rollback checks below are uncommitted transactional failure drills. No post-commit down-migration or production restore is claimed."],
  };
  const check = (name: string, run: () => Promise<void>) => t.test(name, async () => {
    try { await run(); }
    catch (error) {
      evidence.status = "FAIL";
      evidence.failure = error instanceof Error ? error.message : String(error);
      throw error;
    }
  });
  try {
    await cluster.admin.query("create role neondb_owner login nosuperuser bypassrls createdb createrole");
    await cluster.admin.query("create role qa_schema_bootstrap login superuser");
    await cluster.admin.query("create database neondb owner neondb_owner");
    await cluster.admin.query("alter role novalure_app login inherit");
    const connection = { host: "127.0.0.1", port: cluster.port, database: "neondb", max: 4 };
    owner = new LocalSalesPool({ ...connection, user: "neondb_owner" });
    bootstrap = new LocalSalesPool({ ...connection, user: "qa_schema_bootstrap" });
    runtime = new LocalSalesPool({ ...connection, user: "novalure_app" });
    const baseline = await applySalesSchema({ ...cluster, admin: bootstrap, pool: runtime, role: "novalure_app" }, { maxMigrationNumber: 90 });
    assert.ok(baseline.every((file: string) => Number(path.basename(file).slice(0, 3)) <= 90));
    await bootstrap.query("reassign owned by qa_schema_bootstrap to neondb_owner");
    await cluster.admin.query("alter role novalure_app noinherit");
    await cluster.admin.query("grant novalure_tenant_app to novalure_app with inherit true,set false,admin false");
    evidence.baseline = { maxMigrationNumber: 90, appliedFiles: baseline.length, preview097Through099Excluded: true };
    evidence.serverVersion = (await owner.query("show server_version")).rows[0].server_version;

    const sourceMigrations = await Promise.all(files.map(async file => {
      const sourceRef = file.startsWith("104_") || file.startsWith("105_") ? knowledgeSource : designSource;
      const sourceCommit = execFileSync("git", ["rev-parse", sourceRef], { encoding: "utf8" }).trim();
      const sql = await readFile(path.join("migrations", file), "utf8");
      const sourceSql = execFileSync("git", ["show", `${sourceCommit}:migrations/${file}`], { encoding: "utf8" });
      assert.equal(sql, sourceSql, `${file} differs from reviewed source commit`);
      return { file, version: file.slice(0, -4), number: Number(file.slice(0, 3)), sql, checksum: digest(sql),
        rollback: false, manualCutover: manual.has(Number(file.slice(0, 3))), sourceCommit };
    }));
    const ledger = async () => (await owner!.query("select version,name,checksum from novalure_schema_migrations order by version")).rows;
    const apply = async (migrations: typeof sourceMigrations, injectFailure = false) => {
      const client = await owner!.connect();
      try {
        await client.query("begin");
        for (const migration of migrations) {
          await client.query(migration.sql);
          await client.query("insert into novalure_schema_migrations(version,name,checksum) values($1,$2,$3)", [migration.version, migration.file, migration.checksum]);
        }
        if (injectFailure) await client.query("select 1/0");
        await client.query("commit");
      } catch (error) { await client.query("rollback"); throw error; }
      finally { client.release(); }
    };
    const failedTransactions: string[] = [];
    for (const migration of sourceMigrations) {
      if (migration.number === 104) {
        await check("104/105/106 coexist and roll back their schema and ledger as one failed unit", async () => {
          const before = await catalog(owner!), beforeLedger = await ledger();
          await assert.rejects(apply(sourceMigrations.slice(-3), true), code("22012"));
          assert.equal(await catalog(owner!), before);
          assert.deepEqual(await ledger(), beforeLedger);
          evidence.combined104105106Rollback = true;
        });
      }
      await check(`${migration.file}: injected failure leaves no schema/ledger drift; unchanged SQL commits`, async () => {
        const before = await catalog(owner!), beforeLedger = await ledger();
        await assert.rejects(apply([migration], true), code("22012"));
        assert.equal(await catalog(owner!), before);
        assert.deepEqual(await ledger(), beforeLedger);
        failedTransactions.push(migration.file);
        await apply([migration]);
      });
    }
    evidence.transactionalFailureRollback = failedTransactions;
    evidence.applied = sourceMigrations.map(({ file, sourceCommit, checksum }) => ({ file, sourceCommit, normalizedSha256: checksum }));

    await check("runner validates checksums, manual order, predecessor ledger and safe replay", async () => {
      const { createMigrationPlan } = await import("./db-migrate.mjs");
      const state = await ledger();
      for (const migration of sourceMigrations) assert.equal(state.find(row => row.version === migration.version)?.checksum, migration.checksum);
      const file = "090_property_media_delete_runtime.sql";
      const migrations = [{ file, version: file.slice(0, -4), number: 90, checksum: digest(await readFile(`migrations/${file}`, "utf8")), rollback: false, manualCutover: false }, ...sourceMigrations];
      const plan = (rows = state, only = "", allowManualCutover = false) => createMigrationPlan({ migrations, ledgerRows: rows, only, allowManualCutover });
      assert.deepEqual(plan(), []);
      assert.deepEqual(plan(state.filter(row => !row.version.startsWith("105_"))).map((m: { file: string }) => m.file), [files[11]]);
      assert.throws(() => plan(state.map(row => row.version.startsWith("104_") ? { ...row, checksum: "0".repeat(64) } : row)), /Checksum mismatch/);
      assert.throws(() => plan(state.filter(row => !row.version.startsWith("090_"))), /required predecessor/);
      const pre100 = state.filter(row => Number(row.version.slice(0, 3)) < 96);
      assert.throws(() => plan(pre100, files[6].slice(0, -4), true), /required predecessor/);
      assert.throws(() => plan(state, files[0].slice(0, -4)), /manual cutover/);
      const allForward = (await readdir("migrations")).filter(name => /^\d{3}_.*\.sql$/.test(name) && !name.includes("_rollback"));
      const numbers = allForward.filter(name => Number(name.slice(0, 3)) >= 91).map(name => name.slice(0, 3));
      assert.equal(new Set(numbers).size, numbers.length, "duplicate forward migration numbers in the combined upgrade");
      // This pre-existing historical collision is covered by baseline041 and
      // canonical full version names; renumbering published SQL would be unsafe.
      const historicalCollisions = allForward.filter(name => allForward.some(other => other !== name && other.slice(0, 3) === name.slice(0, 3))).sort();
      assert.deepEqual(historicalCollisions, ["013_analysis_bot_70_sprint.sql", "013_newsletter_suppressions.sql"]);
      for (const file of historicalCollisions) assert.equal(await readFile(`migrations/${file}`, "utf8"), execFileSync("git", ["show", `${designSource}:migrations/${file}`], { encoding: "utf8" }));
      evidence.runner = { checksummedReplaySkipsAll: true, missing105Planned: true, tampered104Rejected: true,
        missing090Rejected: true, manual100Before096Rejected: true, explicitManualCutoverRequired: true,
        uniqueForwardMigrationNumbersFrom091: true, unchangedHistoricalNumber013Collision: historicalCollisions };
    });

    await check("direct 104/105/106 replays fail atomically and preserve all committed state", async () => {
      const before = await catalog(owner!), beforeLedger = await ledger();
      for (const migration of sourceMigrations.slice(-3)) {
        await assert.rejects(apply([migration]), code("42P07", "42701", "42710", "42723", "23505"));
        assert.equal(await catalog(owner!), before);
        assert.deepEqual(await ledger(), beforeLedger);
      }
      evidence.directReplay = { explicitFailure: true, catalogAndLedgerUnchanged: true };
    });

    await check("runtime is a non-owner NOBYPASSRLS role and the combined protected tables keep FORCE RLS", async () => {
      const roles = (await owner!.query("select rolname,rolsuper,rolbypassrls,rolcreatedb,rolcreaterole,rolreplication from pg_roles where rolname in ('neondb_owner','novalure_app','novalure_tenant_app') order by rolname")).rows;
      const runtimeRole = roles.find(row => row.rolname === "novalure_app");
      for (const key of ["rolsuper", "rolbypassrls", "rolcreatedb", "rolcreaterole", "rolreplication"]) assert.equal(runtimeRole[key], false);
      assert.equal((await runtime!.query("select count(*)::int as count from pg_class c where c.relnamespace='public'::regnamespace and (c.relowner=(select oid from pg_roles where rolname=current_user) or pg_has_role(current_user,c.relowner,'MEMBER'))")).rows[0].count, 0);
      const tables = ["company_profiles", "company_profile_versions", "knowledge_sources", "knowledge_chunks", "knowledge_areas", "knowledge_source_versions", "knowledge_area_grants", "knowledge_center_entitlements", "knowledge_query_usage", "knowledge_assistant_service_bindings", "knowledge_publication_workflows", "knowledge_change_proposals", "knowledge_workflow_events", "knowledge_maintenance_configurations", "knowledge_website_monitoring", "knowledge_website_scan_runs"];
      const protections = (await owner!.query("select relname,relrowsecurity,relforcerowsecurity,relowner::regrole::text as owner from pg_class where relnamespace='public'::regnamespace and relname=any($1::text[]) order by relname", [tables])).rows;
      assert.equal(protections.length, tables.length);
      assert.ok(protections.every(row => row.relrowsecurity && row.relforcerowsecurity && row.owner === "neondb_owner"));
      assert.equal((await runtime!.query("select count(*)::int as count from knowledge_sources")).rows[0].count, 0);
      await assert.rejects(runtime!.query("select * from provider_connections"), code("42501"));
      await assert.rejects(runtime!.query("select * from crm_service_principals"), code("42501"));
      await assert.rejects(runtime!.query("insert into knowledge_center_entitlements(workspace_id) values($1)", [randomUUID()]), code("42501"));
      await assert.rejects(runtime!.query("select crm_operational_assert_scope($1,null,null,'bots:run')", [randomUUID()]), code("42501"));
      await assert.rejects(runtime!.query("select crm_read_bot_channels($1)", [randomUUID()]), code("42501"));
      evidence.roles = roles;
      evidence.forcedRls = protections;
      evidence.permissions = { runtimeOwnsNoPublicRelation: true, missingContextSeesNoKnowledge: true,
        providerCredentialsAndServicePrincipalsPrivate: true, runtimeCannotProvisionEntitlement: true,
        operationalPrivateHelpersDenied: true, operationalReadRequiresValidContext: true };
    });

    await check("combined install activates no contracts, monitoring, assistant bindings or external delivery", async () => {
      for (const [table, where] of [["knowledge_center_entitlements", "enabled"], ["knowledge_website_monitoring", "enabled"], ["knowledge_assistant_service_bindings", "true"], ["knowledge_workflow_events", "true"]]) {
        assert.equal((await owner!.query(`select count(*)::int as count from ${table} where ${where}`)).rows[0].count, 0);
      }
      evidence.defaultActivation = { enabledEntitlements: 0, enabledMonitoring: 0, assistantBindings: 0, workflowEvents: 0 };
    });
    await check("saved Package 3 records and Design C readers keep tenant boundaries on the same combined schema", async () => {
      const tenants = [0, 1].map(() => ({ workspace: randomUUID(), actor: randomUUID(), area: randomUUID(), source: randomUUID(), event: randomUUID() }));
      const scoped = async <Result>(tenant: typeof tenants[number], run: (client: PoolClient) => Promise<Result>) => {
        const client = await runtime!.connect();
        try {
          await client.query("begin");
          await client.query("select set_config('app.tenant_id',$1,true),set_config('app.actor_id',$2,true)", [tenant.workspace, tenant.actor]);
          const result = await run(client);
          await client.query("commit");
          return result;
        } catch (error) { await client.query("rollback"); throw error; }
        finally { client.release(); }
      };
      for (const tenant of tenants) {
        await owner!.query("insert into workspaces(id,name,operating_model) values($1,'SYNTHETIC combined acceptance','managed_by_novalure')", [tenant.workspace]);
        await owner!.query("insert into workspace_users(id,workspace_id,name,email,role,product_role,status) values($1,$2,'SYNTHETIC combined owner',$3,'owner','customer_owner','active')", [tenant.actor, tenant.workspace, `${tenant.actor}@example.invalid`]);
        await scoped(tenant, async client => {
          await client.query("insert into knowledge_areas(id,workspace_id,name,kind) values($1,$2,'SYNTHETIC combined area','company')", [tenant.area, tenant.workspace]);
          await client.query("insert into knowledge_sources(id,workspace_id,knowledge_area_id,name,source_type) values($1,$2,$3,'SYNTHETIC combined website','url')", [tenant.source, tenant.workspace, tenant.area]);
          await client.query("insert into knowledge_website_monitoring(source_id,workspace_id,configured_by) values($1,$2,$3)", [tenant.source, tenant.workspace, tenant.actor]);
          await client.query("insert into knowledge_workflow_events(id,workspace_id,source_id,event_type,actor_id) values($1,$2,$3,'synthetic.local-acceptance',$4)", [tenant.event, tenant.workspace, tenant.source, tenant.actor]);
        });
      }
      for (const tenant of tenants) {
        await scoped(tenant, async client => {
          assert.deepEqual((await client.query("select source_id from knowledge_website_monitoring")).rows, [{ source_id: tenant.source }]);
          assert.deepEqual((await client.query("select id from knowledge_workflow_events")).rows, [{ id: tenant.event }]);
          const channels = (await client.query("select crm_read_bot_channels($1) as dto", [tenant.workspace])).rows[0].dto;
          assert.deepEqual(channels, { channelAccounts: [], recentWebhookEvents: [], source: "database" });
          assert.equal((await client.query("select crm_read_calendar_connections($1) as dto", [tenant.workspace])).rows[0].dto.source, "database");
        });
      }
      const [tenant, foreign] = tenants;
      await assert.rejects(scoped(tenant, client => client.query("select crm_read_bot_channels($1)", [foreign.workspace])), code("42501"));
      await assert.rejects(scoped(tenant, client => client.query("insert into knowledge_workflow_events(workspace_id,source_id,event_type,actor_id) values($1,$2,'synthetic.forbidden',$3)", [foreign.workspace, foreign.source, tenant.actor])), code("42501"));
      await assert.rejects(scoped(tenant, client => client.query("update knowledge_workflow_events set event_type='synthetic.modified' where id=$1", [tenant.event])), code("42501"));
      await assert.rejects(scoped(tenant, client => client.query("update knowledge_website_monitoring set enabled=true,interval='daily',revision=revision+1 where source_id=$1", [tenant.source])), code("42501"));
      assert.equal((await runtime!.query("select count(*)::int as count from knowledge_workflow_events")).rows[0].count, 0);
      evidence.savedCombinedRecords = { separateCommittedTransactions: true, tenantCount: 2, monitoringAndInternalEventsIsolated: true,
        operationalReadersAvailableOnSameSchema: true, foreignOperationalCallDenied: true, foreignEventWriteDenied: true,
        eventsAppendOnly: true, monitoringActivationWithoutContractDenied: true, contextClearedAfterCommit: true };
    });
    if (evidence.status !== "FAIL") evidence.status = "PASS";
  } catch (error) {
    evidence.status = "FAIL";
    evidence.failure = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    await Promise.allSettled([runtime?.end(), owner?.end(), bootstrap?.end()]);
    await cluster.stop();
    await mkdir(path.dirname(evidencePath), { recursive: true });
    await writeFile(evidencePath, JSON.stringify(evidence, null, 2) + "\n");
    t.diagnostic(`Evidence: ${evidencePath}; authoritative verdict: node:test exit code and summary`);
  }
});
