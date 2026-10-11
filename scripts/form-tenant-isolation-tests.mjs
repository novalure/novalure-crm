import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import path from "node:path";
import pg from "pg";
import { applySalesSchema, startLocalSalesDb } from "./lib/local-sales-db.mjs";

async function nativePgTool(name, args) {
  const executable = process.env.CRM_QA_PG_BIN
    ? path.join(path.resolve(process.env.CRM_QA_PG_BIN), name + (process.platform === "win32" ? ".exe" : ""))
    : name;
  // These tools connect only to the disposable cluster with explicit arguments.
  const env = { NODE_ENV: "test", ...Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(path|home|systemroot|windir|temp|tmp|tmpdir|userprofile|localappdata|appdata|comspec|pathext|lang|lc_all)$/i.test(key))) };
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error(name + " exceeded 60 second local QA limit")); }, 60_000);
    child.stdout.on("data", chunk => { output += chunk; });
    child.stderr.on("data", chunk => { output += chunk; });
    child.once("error", error => { clearTimeout(timer); reject(new Error(name + " required via CRM_QA_PG_BIN/PATH", { cause: error })); });
    child.once("exit", code => { clearTimeout(timer); if (code === 0) resolve(output); else reject(new Error(name + " failed (" + code + "): " + output.slice(-2000))); });
  });
}

test("095 enforces form tenant isolation and preserves narrow published lookup", { timeout: 300_000 }, async () => {
  const db = await startLocalSalesDb();
  try {
    await applySalesSchema(db, { includeD11Contract: false, maxMigrationNumber: 90 });
    const ownWorkspace = randomUUID();
    const foreignWorkspace = randomUUID();
    const ownActor = randomUUID();
    const foreignActor = randomUUID();
    const ownForm = randomUUID();
    const foreignForm = randomUUID();
    const unpublishedForm = randomUUID();
    const key = randomUUID().replaceAll("-", "");
    await db.admin.query(
      `insert into workspaces(id,name,operating_model,public_key)
       values($1,'SYNTHETIC own','self_service_customer',$3),
             ($2,'SYNTHETIC foreign','self_service_customer',$4)`,
      [ownWorkspace, foreignWorkspace, key, randomUUID().replaceAll("-", "")],
    );
    await db.admin.query(
      `insert into workspace_users(id,workspace_id,name,email,role,product_role,status)
       values($1,$2,'SYNTHETIC owner','owner@example.invalid','owner','customer_owner','active'),
             ($3,$4,'SYNTHETIC foreign owner','foreign@example.invalid','owner','customer_owner','active')`,
      [ownActor, ownWorkspace, foreignActor, foreignWorkspace],
    );
    await db.admin.query(
      `insert into forms(id,workspace_id,name,slug,status)
       values($1,$2,'SYNTHETIC published','published','aktiv'),
             ($3,$4,'SYNTHETIC foreign','foreign','aktiv'),
             ($5,$2,'SYNTHETIC draft','draft','entwurf')`,
      [ownForm, ownWorkspace, foreignForm, foreignWorkspace, unpublishedForm],
    );
    // The release order is 094, then 095; the Website Sales seed itself is
    // exercised in its dedicated fixture, so this local matrix records 094's
    // ledger prerequisite without claiming it executed against Production.
    await db.admin.query(
      `insert into novalure_schema_migrations(version,name,checksum)
       values('094_website_sales_ingestion','094_website_sales_ingestion.sql','synthetic-prerequisite')`,
    );
    const migration = await readFile(new URL("../migrations/095_form_tenant_isolation.sql", import.meta.url), "utf8");
    const adminClient = await db.admin.connect();
    try {
      await adminClient.query("begin");
      await adminClient.query(migration);
      await adminClient.query("commit");
    } catch (error) {
      await adminClient.query("rollback");
      throw error;
    } finally { adminClient.release(); }

    const flags = await db.admin.query(
      `select relname, relrowsecurity, relforcerowsecurity from pg_class
       where oid in ('public.forms'::regclass,'public.form_submissions'::regclass) order by relname`,
    );
    assert.equal(flags.rows.length, 2);
    assert.ok(flags.rows.every(row => row.relrowsecurity && row.relforcerowsecurity));
    const role = await db.admin.query(`select rolsuper,rolbypassrls,rolcreatedb,rolcreaterole from pg_roles where rolname=$1`, [db.role]);
    assert.deepEqual(role.rows[0], { rolsuper: false, rolbypassrls: false, rolcreatedb: false, rolcreaterole: false });
    assert.equal((await db.pool.query("select id from forms")).rowCount, 0);
    assert.equal((await db.pool.query("select id from form_submissions")).rowCount, 0);
    await assert.rejects(db.pool.query(
      "insert into forms(workspace_id,name,slug,status) values($1,'SYNTHETIC forged','forged','aktiv')",
      [ownWorkspace],
    ), /row-level security|permission denied/);
    await assert.rejects(db.pool.query("insert into form_submissions(workspace_id,form_id) values($1,$2)", [ownWorkspace, ownForm]), /row-level security|permission denied/);
    await assert.rejects(db.pool.query("update form_submissions set status='forged'"), /permission denied/);
    await assert.rejects(db.pool.query("delete from form_submissions"), /permission denied/);
    const ambient = await db.admin.query(`
      select count(*)::integer as count from pg_class c
      cross join lateral aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) acl
      where c.oid in ('public.forms'::regclass,'public.form_submissions'::regclass)
        and (acl.grantee=0 or acl.grantee='novalure_app'::regrole)
    `);
    assert.equal(ambient.rows[0].count, 0);
    const published = await db.pool.query("select crm_public_form_lookup(null,$1,'published') as form", [key]);
    assert.equal(published.rows[0].form.id, ownForm);
    assert.equal(published.rows[0].form.publicActorId, ownActor);
    for (const internal of ["projectId", "ownerUserId", "funnelId", "crmTarget", "pipelineStage", "ownerMode", "campaign", "tags", "visits", "submissions", "conversionRate", "lastSubmission"]) {
      assert.equal(Object.hasOwn(published.rows[0].form, internal), false, `${internal} is excluded from public SQL lookup`);
    }
    assert.equal((await db.pool.query("select crm_public_form_lookup(null,$1,'draft') as form", [key])).rows[0].form, null);
    assert.equal((await db.pool.query("select * from crm_public_form_legacy_route('draft')")).rowCount, 0);

    const client = await db.pool.connect();
    try {
      await client.query("begin");
      await client.query("select set_config('app.tenant_id',$1,true),set_config('app.actor_id',$2,true)", [ownWorkspace, ownActor]);
      assert.equal((await client.query("select id from forms where id=$1", [ownForm])).rowCount, 1);
      assert.equal((await client.query("update forms set name='SYNTHETIC changed' where id=$1 returning id", [ownForm])).rowCount, 1);
      assert.equal((await client.query("select id from forms where id=$1", [foreignForm])).rowCount, 0);
      assert.equal((await client.query("update forms set name='forged' where id=$1 returning id", [foreignForm])).rowCount, 0);
      assert.equal((await client.query("delete from forms where id=$1 returning id", [foreignForm])).rowCount, 0);
      assert.equal((await client.query("insert into form_submissions(workspace_id,form_id) values($1,$2) returning id", [ownWorkspace, ownForm])).rowCount, 1);
      assert.equal((await client.query("select id from form_submissions where workspace_id=$1", [ownWorkspace])).rowCount, 1);
      await client.query("commit");
      await client.query("begin");
      await client.query("select set_config('app.tenant_id',$1,true),set_config('app.actor_id',$2,true)", [ownWorkspace, ownActor]);
      await assert.rejects(client.query("insert into form_submissions(workspace_id,form_id) values($1,$2)", [foreignWorkspace, foreignForm]), /row-level security|permission denied/);
      await client.query("rollback");
      await client.query("begin");
      await client.query("select set_config('app.tenant_id',$1,true),set_config('app.actor_id',$2,true)", [foreignWorkspace, foreignActor]);
      assert.equal((await client.query("select id from forms where id=$1", [ownForm])).rowCount, 0);
      assert.equal((await client.query("select id from form_submissions where workspace_id=$1", [ownWorkspace])).rowCount, 0);
      await client.query("rollback");
    } finally { client.release(); }

    const archive = path.join(db.directory, "synthetic-form-isolation.dump");
    const connection = ["--host=127.0.0.1", "--port=" + db.port, "--username=qa_admin", "--no-password"];
    const toolVersions = { dump: (await nativePgTool("pg_dump", ["--version"])).trim(), restore: (await nativePgTool("pg_restore", ["--version"])).trim() };
    assert.match(toolVersions.dump, /PostgreSQL\) 18\./);
    assert.match(toolVersions.restore, /PostgreSQL\) 18\./);
    await nativePgTool("pg_dump", [...connection, "--dbname=postgres", "--format=custom", "--file=" + archive]);
    const restoredName = "form_restore_" + randomUUID().replaceAll("-", "");
    await db.admin.query(`create database ${restoredName} template template0`);
    await nativePgTool("pg_restore", [...connection, "--dbname=" + restoredName, "--exit-on-error", "--single-transaction", archive]);
    const restoredAdmin = new pg.Pool({ host: "127.0.0.1", port: db.port, user: "qa_admin", database: restoredName, max: 2 });
    const restoredRuntime = new pg.Pool({ host: "127.0.0.1", port: db.port, user: db.role, database: restoredName, max: 2 });
    try {
      const restoredFlags = await restoredAdmin.query(
        `select relname, relrowsecurity, relforcerowsecurity from pg_class
         where oid in ('public.forms'::regclass,'public.form_submissions'::regclass) order by relname`,
      );
      assert.deepEqual(restoredFlags.rows, flags.rows);
      assert.equal((await restoredAdmin.query("select id from forms where id=$1", [ownForm])).rowCount, 1);
      assert.equal((await restoredRuntime.query("select id from forms")).rowCount, 0);
      assert.equal((await restoredRuntime.query("select id from form_submissions")).rowCount, 0);
      assert.equal((await restoredRuntime.query("select crm_public_form_lookup(null,$1,'published') as form", [key])).rows[0].form.id, ownForm);
      await assert.rejects(restoredRuntime.query("insert into form_submissions(workspace_id,form_id) values($1,$2)", [ownWorkspace, ownForm]), /row-level security|permission denied/);
    } finally {
      await restoredRuntime.end();
      await restoredAdmin.end();
    }
  } finally { await db.stop(); }
});
