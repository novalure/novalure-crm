import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import pg, { type Pool, type PoolClient } from "pg";
import { startLocalSalesDb, applySalesSchema } from "./lib/local-sales-db.mjs";

// Actual local PostgreSQL only. No provider, production connection or fake SQL.
// Scope is explicitly 080–083; future migration files must not enter this evidence.
const files = ["080_crm_command_safety.sql", "081_crm_offer_workflow.sql", "082_crm_property_sales_workflow.sql", "083_crm_core_cas.sql"] as const;
const ids = { workspace: randomUUID(), foreignWorkspace: randomUUID(), actor: randomUUID(), agent: randomUUID(), project: randomUUID(), hiddenProject: randomUUID(), foreignProject: randomUUID(), organization: randomUUID(), foreignOrganization: randomUUID(), contact: randomUUID(), looseContact: randomUUID(), foreignContact: randomUUID(), lead: randomUUID(), unit: randomUUID(), reservation: randomUUID(), viewing: randomUUID(), task: randomUUID(), dashboard: randomUUID() };
const sqlError = (code: string) => (error: unknown) => (error as { code?: string })?.code === code;
const digest = (value: string) => createHash("sha256").update(value.replace(/\r\n/g, "\n")).digest("hex");
async function nativePgTool(name: "pg_dump" | "pg_restore", args: string[]) {
  const executable = process.env.CRM_QA_PG_BIN
    ? path.join(path.resolve(process.env.CRM_QA_PG_BIN), name + (process.platform === "win32" ? ".exe" : ""))
    : name;
  const env: NodeJS.ProcessEnv = { NODE_ENV: "test", ...Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(path|home|systemroot|windir|temp|tmp|tmpdir|userprofile|localappdata|appdata|comspec|pathext|lang|lc_all)$/i.test(key))) };
  // Explicit connection arguments only; never inherit PGHOST/PGSERVICE/password/provider settings.
  return new Promise<string>((resolve, reject) => {
    const child = spawn(executable, args, { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error(name + " exceeded 60 second local QA limit")); }, 60000);
    child.stdout.on("data", chunk => { output += chunk; });
    child.stderr.on("data", chunk => { output += chunk; });
    child.once("error", error => { clearTimeout(timer); reject(new Error(name + " required via CRM_QA_PG_BIN/PATH; no skip is permitted", { cause: error })); });
    child.once("exit", code => { clearTimeout(timer); if (code === 0) resolve(output); else reject(new Error(name + " failed (" + code + "): " + output.slice(-2000))); });
  });
}
async function migration(pool: Pool, file: string, suffix = "") {
  const client = await pool.connect();
  const source = await readFile(path.join("migrations", file), "utf8");
  try {
    await client.query("begin");
    await client.query(source);
    if (suffix) await client.query(suffix);
    await client.query("insert into novalure_schema_migrations(version,name,checksum) values($1,$2,$3)", [file.replace(/\.sql$/, ""), file, digest(source)]);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally { client.release(); }
}
async function exists(pool: Pool, relation: string) {
  return (await pool.query("select to_regclass($1) is not null as present", [relation])).rows[0].present as boolean;
}
async function catalog(pool: Pool) {
  const rows = await pool.query(`
    select 'column' as kind,table_name as relation,column_name as name,
      concat(data_type,':',is_nullable,':',column_default) as definition
      from information_schema.columns where table_schema='public'
    union all select 'constraint',conrelid::regclass::text,conname,concat(convalidated,':',pg_get_constraintdef(oid)) from pg_constraint where connamespace='public'::regnamespace
    union all select 'index',indrelid::regclass::text,indexrelid::regclass::text,pg_get_indexdef(indexrelid) from pg_index where indrelid in(select oid from pg_class where relnamespace='public'::regnamespace)
    union all select 'trigger',tgrelid::regclass::text,tgname,pg_get_triggerdef(oid) from pg_trigger where not tgisinternal and tgrelid in(select oid from pg_class where relnamespace='public'::regnamespace)
    union all select 'policy',tablename,policyname,concat(cmd,':',qual,':',with_check) from pg_policies where schemaname='public'
    union all select 'function','public',proname||oidvectortypes(proargtypes),pg_get_functiondef(oid) from pg_proc where pronamespace='public'::regnamespace and prokind='f'
    order by 1,2,3,4
  `);
  return digest(JSON.stringify(rows.rows));
}
async function scoped<T>(pool: Pool, actor: string, fn: (client: PoolClient) => Promise<T>) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("select set_config('app.tenant_id',$1,true),set_config('app.actor_id',$2,true)", [ids.workspace, actor]);
    const result = await fn(client);
    await client.query("rollback");
    return result;
  } catch (error) { await client.query("rollback"); throw error; }
  finally { client.release(); }
}
async function seed(pool: Pool) {
  await pool.query("insert into workspaces(id,name,operating_model) values($1,'SYNTHETIC migration upgrade','managed_by_novalure'),($2,'SYNTHETIC other tenant','managed_by_novalure')", [ids.workspace, ids.foreignWorkspace]);
  await pool.query("insert into workspace_users(id,workspace_id,name,email,role,product_role) values($1,$3,'SYNTHETIC owner','upgrade-owner@example.invalid','owner','customer_owner'),($2,$3,'SYNTHETIC agent','upgrade-agent@example.invalid','agent','project_sales_member')", [ids.actor, ids.agent, ids.workspace]);
  await pool.query("insert into projects(id,workspace_id,name,type) values($1,$4,'SYNTHETIC granted project','Bauträger'),($2,$4,'SYNTHETIC ungranted project','Bauträger'),($3,$5,'SYNTHETIC foreign project','Bauträger')", [ids.project, ids.hiddenProject, ids.foreignProject, ids.workspace, ids.foreignWorkspace]);
  await pool.query("insert into project_pipeline_permissions(workspace_id,project_id,user_id,can_edit_deals) values($1,$2,$3,true)", [ids.workspace, ids.project, ids.agent]);
  await pool.query("insert into organizations(id,workspace_id,project_id,name,type) values($1,$3,$4,'SYNTHETIC developer','Bauträger'),($2,$5,$6,'SYNTHETIC foreign developer','Bauträger')", [ids.organization, ids.foreignOrganization, ids.workspace, ids.project, ids.foreignWorkspace, ids.foreignProject]);
  await pool.query("insert into contacts(id,workspace_id,project_id,organization_id,owner_user_id,name,role) values($1,$4,$5,$6,$7,'SYNTHETIC buyer','Käufer'),($2,$4,null,null,$7,'SYNTHETIC unscoped contact','Käufer'),($3,$8,$9,null,null,'SYNTHETIC foreign buyer','Käufer')", [ids.contact, ids.looseContact, ids.foreignContact, ids.workspace, ids.project, ids.organization, ids.actor, ids.foreignWorkspace, ids.foreignProject]);
  await pool.query("insert into leads(id,workspace_id,project_id,contact_id,type,buyer_profile) values($1,$2,$3,$4,'Käufer','{}')", [ids.lead, ids.workspace, ids.project, ids.contact]);
  await pool.query("insert into tasks(id,workspace_id,project_id,contact_id,title,due_at) values($1,$2,null,$3,'SYNTHETIC undated task',null)", [ids.task, ids.workspace, ids.contact]);
  await pool.query("insert into property_units(id,workspace_id,project_id,unit_number,status,price_cents) values($1,$2,$3,'SYNTHETIC-LEGACY','reserved',35000000)", [ids.unit, ids.workspace, ids.project]);
  await pool.query("insert into property_reservations(id,workspace_id,project_id,unit_id,contact_id,status,expires_at) values($1,$2,$3,$4,$5,'reserved','2030-01-01')", [ids.reservation, ids.workspace, ids.project, ids.unit, ids.contact]);
  // A historically accepted malformed interval exercises the later NOT VALID gate.
  await pool.query("insert into property_viewing_slots(id,workspace_id,project_id,unit_id,starts_at,ends_at) values($1,$2,$3,$4,'2029-01-01 11:00Z','2029-01-01 10:00Z')", [ids.viewing, ids.workspace, ids.project, ids.unit]);
  await pool.query("insert into dashboard_views(id,workspace_id,user_id,project_id,name) values($1,$2,$3,null,'SYNTHETIC global personal view')", [ids.dashboard, ids.workspace, ids.actor]);
}
async function businessSnapshot(pool: Pool) {
  const records: Record<string, unknown[]> = {};
  for (const table of ["projects", "organizations", "contacts", "leads", "tasks", "property_units", "property_reservations", "property_viewing_slots", "dashboard_views"]) {
    records[table] = (await pool.query(`select to_jsonb(t) - array['version','data_classification','data_purpose','developer_organization_id','sales_qualification','buyer_lead_id','confirmation','time_zone','calendar_event_id'] as data from ${table} t where workspace_id in ($1,$2) order by id`, [ids.workspace, ids.foreignWorkspace])).rows.map(row => row.data);
  }
  return records;
}

test("080–083 realistic local upgrade, legacy gates, re-run rollback and selected-data restore", { timeout: 240000 }, async t => {
  const db = await startLocalSalesDb();
  let restoredAdmin: Pool | undefined, restoredRuntime: Pool | undefined;
  const evidence: Record<string, unknown> = { syntheticOnly: true, productionAccess: 0, databaseFakes: 0, migrationFiles: files, migrationHashFormat: "SHA256 of UTF-8 SQL with CRLF normalized to LF (db-migrate.mjs)", limitations: ["Historical 001 vector substitution and 062 manual media-cutover exclusion from local-sales-db.mjs remain.", "No production schema, role, grants or data were inspected.", "Native restore uses a second database in the same isolated cluster; global roles already exist. No cross-cluster role/bootstrap, point-in-time recovery or production DR is claimed."] };
  try {
    const applied = await applySalesSchema(db, { includeSales: false });
    assert.ok(applied.every((name: string) => Number(name.slice(0, 3)) < 80));
    evidence.baselineFiles = applied.length;
    await seed(db.admin);
    const before = await businessSnapshot(db.admin);

    await t.test("081 refuses a pre-080 schema and leaves no partial offer objects", async () => {
      const signature = await catalog(db.admin);
      await assert.rejects(migration(db.admin, files[1]), sqlError("42883"));
      assert.equal(await exists(db.admin, "crm_offers"), false);
      assert.equal(await catalog(db.admin), signature);
    });
    await t.test("080 refuses a legacy cross-tenant dashboard FK atomically", async () => {
      const bad = randomUUID();
      await db.admin.query("insert into dashboard_views(id,workspace_id,project_id,name) values($1,$2,$3,'SYNTHETIC invalid legacy dashboard')", [bad, ids.workspace, ids.foreignProject]);
      const signature = await catalog(db.admin);
      await assert.rejects(migration(db.admin, files[0]), sqlError("23503"));
      assert.equal(await exists(db.admin, "crm_command_receipts"), false);
      assert.equal(await catalog(db.admin), signature);
      assert.equal((await db.admin.query("select count(*) from dashboard_views where id=$1", [bad])).rows[0].count, "1");
      // Explicit correction of this synthetic fixture only; migration never silently repairs it.
      await db.admin.query("delete from dashboard_views where id=$1", [bad]);
    });
    for (const file of files.slice(0, 3)) {
      await t.test(file + " rolls back injected failure, then upgrades unchanged SQL", async () => {
        const signature = await catalog(db.admin);
        await assert.rejects(migration(db.admin, file, "select 1/0"), sqlError("22012"));
        assert.equal(await catalog(db.admin), signature);
        await migration(db.admin, file);
      });
    }
    await t.test("083 rolls back an in-file duplicate trigger failure within the runner transaction", async () => {
      await db.admin.query("create function synthetic_collision() returns trigger language plpgsql as $$begin return new; end$$; create trigger projects_core_version before update on projects for each row execute function synthetic_collision()");
      const signature = await catalog(db.admin);
      await assert.rejects(migration(db.admin, files[3]), sqlError("42710"));
      assert.equal(await catalog(db.admin), signature);
      await db.admin.query("drop trigger projects_core_version on projects; drop function synthetic_collision()");
    });
    await t.test("083 schema and migration ledger roll back together when ledger insertion fails", async () => {
      await db.admin.query("create function synthetic_reject_083_ledger() returns trigger language plpgsql as $$begin if new.name='083_crm_core_cas.sql' then raise exception 'SYNTHETIC_LEDGER_FAILURE' using errcode='23514'; end if; return new; end$$; create trigger synthetic_reject_083_ledger before insert on novalure_schema_migrations for each row execute function synthetic_reject_083_ledger()");
      try {
        const signature = await catalog(db.admin);
        await assert.rejects(migration(db.admin, files[3]), sqlError("23514"));
        assert.equal(await catalog(db.admin), signature, "083 committed schema before the failed ledger insert");
        assert.equal((await db.admin.query("select count(*) from novalure_schema_migrations where name=$1", [files[3]])).rows[0].count, "0");
      } finally {
        await db.admin.query("drop trigger synthetic_reject_083_ledger on novalure_schema_migrations; drop function synthetic_reject_083_ledger(); drop trigger if exists contacts_core_version on contacts; drop trigger if exists tasks_core_version on tasks; drop trigger if exists projects_core_version on projects; drop function if exists crm_advance_core_version()");
      }
      await migration(db.admin, files[3]);
    });
    await t.test("business values and nullable legacy fields survive; no invented approvals or confirmations", async () => {
      assert.deepEqual(await businessSnapshot(db.admin), before);
      const reservation = (await db.admin.query("select status,confirmation,buyer_lead_id,version from property_reservations where id=$1", [ids.reservation])).rows[0];
      assert.equal(reservation.status, "reserved"); assert.equal(reservation.confirmation, null); assert.equal(reservation.buyer_lead_id, null); assert.equal(Number(reservation.version), 1);
      assert.equal((await db.admin.query("select count(*) from crm_offer_approvals")).rows[0].count, "0");
      assert.equal((await db.admin.query("select count(*) from property_sales")).rows[0].count, "0");
      assert.deepEqual((await db.admin.query("select sales_qualification from leads where id=$1", [ids.lead])).rows[0].sales_qualification, {});
      assert.equal((await db.admin.query("select time_zone from property_viewing_slots where id=$1", [ids.viewing])).rows[0].time_zone, null);
    });
    await t.test("all four direct re-runs fail explicitly and roll back without schema/data drift", async () => {
      const signature = await catalog(db.admin), snapshot = await businessSnapshot(db.admin);
      for (const file of files) {
        await assert.rejects(migration(db.admin, file), error => ["42P07", "42710", "42701"].includes((error as { code: string }).code));
        assert.equal(await catalog(db.admin), signature, file);
        assert.deepEqual(await businessSnapshot(db.admin), snapshot, file);
      }
      const ledger = (await db.admin.query("select name,checksum from novalure_schema_migrations where name=any($1::text[]) order by name", [[...files]])).rows;
      assert.equal(ledger.length, 4);
      for (const row of ledger) assert.equal(row.checksum, digest(await readFile(path.join("migrations", row.name), "utf8")));
      evidence.appliedLedger = ledger.map(row => ({ name: row.name, sha256: row.checksum }));
      const { createMigrationPlan } = await import("./db-migrate.mjs");
      const migrations = await Promise.all(files.map(async file => ({ file, version: file.replace(/\.sql$/, ""), number: Number(file.slice(0, 3)), checksum: digest(await readFile(path.join("migrations", file), "utf8")), rollback: false, manualCutover: false })));
      const ledgerRows = (await db.admin.query("select version,name,checksum from novalure_schema_migrations where name=any($1::text[])", [[...files]])).rows;
      assert.deepEqual(createMigrationPlan({ migrations, ledgerRows, allowManualCutover: false, only: "" }), [], "real runner must skip already checksummed migrations");
      assert.deepEqual(createMigrationPlan({ migrations, ledgerRows: ledgerRows.filter(row => row.name !== files[3]), allowManualCutover: false, only: "" }).map((item: { file: string }) => item.file), [files[3]]);
      assert.throws(() => createMigrationPlan({ migrations, ledgerRows: ledgerRows.map(row => row.name === files[3] ? { ...row, checksum: "0".repeat(64) } : row), allowManualCutover: false, only: "" }), /Checksum mismatch/);
      evidence.runnerLedgerReRun = { recordedFilesSkipped: true, unappliedFilePlanned: true, checksumMismatchRejected: true };
    });
    await t.test("NOT VALID legacy interval is preserved but blocks validation and any new invalid row", async () => {
      const pending = (await db.admin.query("select conname,convalidated from pg_constraint where conname=any($1::text[]) order by conname", [["projects_developer_tenant_fk", "reservation_buyer_tenant_project_fk", "viewing_end_after_start_check"]])).rows;
      assert.equal(pending.length, 3); assert.ok(pending.every(row => row.convalidated === false));
      await assert.rejects(db.admin.query("alter table property_viewing_slots validate constraint viewing_end_after_start_check"), sqlError("23514"));
      await assert.rejects(db.admin.query("insert into property_viewing_slots(workspace_id,project_id,unit_id,starts_at,ends_at) values($1,$2,$3,'2029-01-01 11:00Z','2029-01-01 10:00Z')", [ids.workspace, ids.project, ids.unit]), sqlError("23514"));
      await assert.rejects(db.admin.query("update projects set developer_organization_id=$1 where id=$2", [ids.foreignOrganization, ids.project]), sqlError("23503"));
      evidence.notValidConstraints = pending;
    });
    await t.test("indexes/FKs and RLS survive upgrade; actor grants exclude hidden projects and foreign tenants", async () => {
      const idx = (await db.admin.query("select i.indisvalid,i.indisunique,pg_get_expr(i.indpred,i.indrelid) as predicate from pg_index i where indexrelid='property_reservation_pending_request_idx'::regclass")).rows[0];
      assert.equal(idx.indisvalid, true); assert.equal(idx.indisunique, true); assert.match(idx.predicate, /requested/);
      const secured = ["crm_offers", "crm_offer_approvals", "crm_command_receipts", "crm_domain_events", "property_sales", "crm_project_sales_authorities", "contacts", "dashboard_views"];
      const rls = (await db.admin.query("select relname,relrowsecurity,relforcerowsecurity from pg_class where relname=any($1::text[]) and relnamespace='public'::regnamespace", [secured])).rows;
      assert.equal(rls.length, secured.length); assert.ok(rls.every(row => row.relrowsecurity && row.relforcerowsecurity));
      const role = (await db.pool.query("select rolsuper,rolbypassrls,rolcreatedb,rolcreaterole from pg_roles where rolname=current_user")).rows[0];
      assert.ok(Object.values(role).every(value => value === false));
      const projects = await scoped(db.pool, ids.agent, async c => (await c.query("select id from projects order by id")).rows.map(row => row.id));
      assert.deepEqual(projects, [ids.project]);
      const contacts = await scoped(db.pool, ids.agent, async c => (await c.query("select id from contacts order by id")).rows.map(row => row.id));
      assert.deepEqual(contacts, [ids.contact]);
      await assert.rejects(scoped(db.pool, ids.agent, c => c.query("insert into contacts(workspace_id,project_id,name,role) values($1,$2,'SYNTHETIC forbidden','Käufer')", [ids.foreignWorkspace, ids.foreignProject])), sqlError("42501"));
      evidence.runtimeRole = role;
    });
    await t.test("083 supplies monotone versions after internal updates and rejects regressions", async () => {
      for (const [table, id] of [["contacts", ids.contact], ["tasks", ids.task], ["projects", ids.project]]) {
        const first = Number((await db.admin.query(`select version from ${table} where id=$1`, [id])).rows[0].version);
        await db.admin.query(`update ${table} set updated_at=updated_at where id=$1`, [id]);
        assert.equal(Number((await db.admin.query(`select version from ${table} where id=$1`, [id])).rows[0].version), first + 1);
        await assert.rejects(db.admin.query(`update ${table} set version=1 where id=$1`, [id]), sqlError("23514"));
      }
    });
    await t.test("selected business-data restore into second isolated DB detects dirty legacy rows", async () => {
      const restoreName = "sales_restore_" + randomUUID().replaceAll("-", "");
      await db.admin.query(`create database ${restoreName} template template0`);
      restoredAdmin = new pg.Pool({ host: "127.0.0.1", port: db.port, user: "qa_admin", database: restoreName, max: 3 });
      restoredRuntime = new pg.Pool({ host: "127.0.0.1", port: db.port, user: db.role, database: restoreName, max: 3 });
      await applySalesSchema({ ...db, admin: restoredAdmin }, { includeSales: false });
      for (const file of files) await migration(restoredAdmin, file);
      for (const table of ["workspaces", "projects", "organizations", "contacts", "leads", "tasks", "property_units", "property_reservations"]) {
        // Columns/identifiers are fixed test-owned names. Parameters carry all row values.
        const rows = (await db.admin.query(`select to_jsonb(t) as data from ${table} t where ${table === "workspaces" ? "id" : "workspace_id"} in ($1,$2) order by id`, [ids.workspace, ids.foreignWorkspace])).rows;
        if (table === "projects") {
          // Only synthetic actor identities are reconstructed; sessions/credentials are never backed up.
          await restoredAdmin.query("insert into workspace_users(id,workspace_id,name,email,role,product_role) values($1,$3,'SYNTHETIC restored owner','upgrade-owner@example.invalid','owner','customer_owner'),($2,$3,'SYNTHETIC restored agent','upgrade-agent@example.invalid','agent','project_sales_member')", [ids.actor, ids.agent, ids.workspace]);
        }
        for (const row of rows) await restoredAdmin.query(`insert into ${table} select * from jsonb_populate_record(null::${table},$1::jsonb)`, [JSON.stringify(row.data)]);
      }
      const legacy = (await db.admin.query("select to_jsonb(t) as data from property_viewing_slots t where id=$1", [ids.viewing])).rows[0].data;
      await assert.rejects(restoredAdmin.query("insert into property_viewing_slots select * from jsonb_populate_record(null::property_viewing_slots,$1::jsonb)", [JSON.stringify(legacy)]), sqlError("23514"));
      assert.equal((await restoredAdmin.query("select count(*) from property_viewing_slots")).rows[0].count, "0");
      // Demonstrate a documented operator correction, never silently mutate the source.
      const corrected = { ...legacy, ends_at: "2029-01-01T12:00:00+00:00" };
      await restoredAdmin.query("insert into property_viewing_slots select * from jsonb_populate_record(null::property_viewing_slots,$1::jsonb)", [JSON.stringify(corrected)]);
      await restoredAdmin.query("alter table property_viewing_slots validate constraint viewing_end_after_start_check");
      await restoredAdmin.query("alter table projects validate constraint projects_developer_tenant_fk");
      await restoredAdmin.query("alter table property_reservations validate constraint reservation_buyer_tenant_project_fk");
      await restoredAdmin.query("insert into project_pipeline_permissions(workspace_id,project_id,user_id,can_read,can_edit_deals) values($1,$2,$3,true,true)", [ids.workspace, ids.project, ids.agent]);
      const visible = await scoped(restoredRuntime, ids.agent, async c => (await c.query("select id from property_units")).rows.map(row => row.id));
      assert.deepEqual(visible, [ids.unit]);
      assert.equal((await restoredAdmin.query("select confirmation from property_reservations where id=$1", [ids.reservation])).rows[0].confirmation, null);
      assert.equal((await db.admin.query("select ends_at<starts_at as dirty from property_viewing_slots where id=$1", [ids.viewing])).rows[0].dirty, true);
      evidence.restore = { separateDatabase: true, selectedBusinessDataOnly: true, rejectedDirtyLegacyInterval: true, correctedTargetIntervalOnly: true, sourceUnchanged: true, restoredRlsVerified: true };
    });
    await t.test("native pg_dump/pg_restore round trip preserves schema, ledger, data, RLS and NOT VALID state", async () => {
      const toolVersions = { dump: (await nativePgTool("pg_dump", ["--version"])).trim(), restore: (await nativePgTool("pg_restore", ["--version"])).trim() };
      assert.match(toolVersions.dump, /PostgreSQL\) 18\./); assert.match(toolVersions.restore, /PostgreSQL\) 18\./);
      const archive = path.join(db.directory, "synthetic-sales-full.dump");
      const args = ["--host=127.0.0.1", "--port=" + db.port, "--username=qa_admin", "--no-password"];
      const signature = await catalog(db.admin), data = await businessSnapshot(db.admin);
      const ledger = (await db.admin.query("select version,name,checksum from novalure_schema_migrations order by version")).rows;
      await nativePgTool("pg_dump", [...args, "--dbname=postgres", "--format=custom", "--file=" + archive]);
      const database = "native_restore_" + randomUUID().replaceAll("-", "");
      await db.admin.query(`create database ${database} template template0`);
      await nativePgTool("pg_restore", [...args, "--dbname=" + database, "--exit-on-error", "--single-transaction", archive]);
      const admin = new pg.Pool({ host: "127.0.0.1", port: db.port, user: "qa_admin", database, max: 2 });
      const runtime = new pg.Pool({ host: "127.0.0.1", port: db.port, user: db.role, database, max: 2 });
      try {
        assert.equal(await catalog(admin), signature);
        assert.deepEqual(await businessSnapshot(admin), data);
        assert.deepEqual((await admin.query("select version,name,checksum from novalure_schema_migrations order by version")).rows, ledger);
        assert.equal((await admin.query("select ends_at<starts_at as dirty from property_viewing_slots where id=$1", [ids.viewing])).rows[0].dirty, true);
        assert.equal((await admin.query("select convalidated from pg_constraint where conname='viewing_end_after_start_check'")).rows[0].convalidated, false);
        await assert.rejects(admin.query("alter table property_viewing_slots validate constraint viewing_end_after_start_check"), sqlError("23514"));
        const visible = await scoped(runtime, ids.agent, async c => (await c.query("select id from projects")).rows.map(row => row.id));
        assert.deepEqual(visible, [ids.project]);
        await assert.rejects(scoped(runtime, ids.agent, c => c.query("insert into contacts(workspace_id,project_id,name,role) values($1,$2,'SYNTHETIC forbidden restore','Käufer')", [ids.foreignWorkspace, ids.foreignProject])), sqlError("42501"));
        await assert.rejects(admin.query("truncate crm_command_receipts,crm_domain_events"), sqlError("55000"));
        const prior = Number((await admin.query("select version from contacts where id=$1", [ids.contact])).rows[0].version);
        await admin.query("update contacts set updated_at=updated_at where id=$1", [ids.contact]);
        assert.equal(Number((await admin.query("select version from contacts where id=$1", [ids.contact])).rows[0].version), prior + 1);
        assert.equal(Number((await db.admin.query("select version from contacts where id=$1", [ids.contact])).rows[0].version), prior);
        evidence.nativeRestore = { tools: toolVersions, completeDatabaseDump: true, separateDatabase: true, sameClusterRolesAlreadyPresent: true, schemaLedgerBusinessDataEqual: true, restoredRlsAndAuditImmutabilityAndCas: true, retainedNotValidLegacyState: true, noSourceMutation: true };
      } finally { await runtime.end(); await admin.end(); }
    });
    evidence.verdictSource = "node:test exit code and pass/fail summary; this artifact alone is not a PASS claim";
    await writeFile(path.join(db.directory, "sales-upgrade-evidence.json"), JSON.stringify(evidence, null, 2));
    t.diagnostic("Evidence: " + path.join(db.directory, "sales-upgrade-evidence.json"));
  } finally {
    await restoredRuntime?.end(); await restoredAdmin?.end();
    await db.stop();
  }
});
