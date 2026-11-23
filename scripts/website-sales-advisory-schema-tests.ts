import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { Pool } from 'pg';
import { applySalesSchema, startLocalSalesDb } from './lib/local-sales-db.mjs';

test('advisory 210 is atomic and installable by the canonical non-superuser migration owner', { timeout: 180000 }, async t => {
 const db = await startLocalSalesDb(); let installer: Pool | undefined;
 try {
  await applySalesSchema(db, { maxMigrationNumber: 90 });
  for (const file of ['170_crm_personal_mailbox.sql', '202_website_sales_ireland.sql', '203_website_sales_machine.sql', '204_website_sales_studio.sql', '205_website_sales_lifecycle.sql', '206_website_sales_operations.sql', '207_website_sales_conversations.sql', '208_website_sales_enablement.sql', '209_website_sales_commerce.sql']) await db.admin.query(await readFile(`migrations/${file}`, 'utf8'));
  await db.admin.query('create role neondb_owner login inherit nosuperuser nobypassrls createdb createrole noreplication');
  await db.admin.query(`do $$declare item record;begin
   for item in select c.oid,c.relkind,format('%I.%I',n.nspname,c.relname) as qualified from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relowner=(select oid from pg_roles where rolname='qa_admin') and c.relkind in('r','p','v','m','S') order by case when c.relkind='S' then 1 else 0 end loop execute format('alter %s %s owner to neondb_owner',case item.relkind when 'v' then 'view' when 'm' then 'materialized view' when 'S' then 'sequence' else 'table' end,item.qualified);end loop;
   for item in select p.oid from pg_proc p where p.pronamespace='public'::regnamespace and p.proowner=(select oid from pg_roles where rolname='qa_admin') and p.prokind='f' and not exists(select 1 from pg_depend d where d.classid='pg_proc'::regclass and d.objid=p.oid and d.deptype='e') loop execute format('alter function %s owner to neondb_owner',item.oid::regprocedure);end loop;
  end $$;alter database postgres owner to neondb_owner;`);
  installer = new Pool({ host: '127.0.0.1', port: db.port, user: 'neondb_owner', database: 'postgres', max: 2 });
  assert.deepEqual((await installer.query('select current_user,rolsuper,rolbypassrls,rolcreatedb,rolcreaterole from pg_roles where rolname=current_user')).rows[0], { current_user: 'neondb_owner', rolsuper: false, rolbypassrls: false, rolcreatedb: true, rolcreaterole: true });
  const sql = await readFile('migrations/210_website_sales_advisory.sql', 'utf8');
  await t.test('a failure after every DDL statement leaves no advisory objects, roles or old scope changes', async () => {
   const client = await installer!.connect(); try {
    const old = (await client.query("select pg_get_functiondef('crm_lock_website_sales_machine_grant(uuid,uuid)'::regprocedure) as body")).rows[0].body;
    await assert.rejects(client.query(sql.replace(/commit;\s*$/i, "select 1/0;\ncommit;")), { code: '22012' });
    await client.query('rollback');
    assert.equal((await client.query("select count(*)::int n from pg_class where relname like 'crm_website_sales_advisory%'")).rows[0].n, 0);
    assert.equal((await client.query("select count(*)::int n from pg_roles where rolname like 'novalure_website_sales_advisory%'")).rows[0].n, 0);
    assert.equal((await client.query("select pg_get_functiondef('crm_lock_website_sales_machine_grant(uuid,uuid)'::regprocedure) as body")).rows[0].body, old);
   } finally { client.release(); }
  });
  await installer.query(sql);
  await t.test('all advisory tables force RLS and both private roles remain non-login and non-bypass', async () => {
   const relations = (await installer!.query("select relname,relrowsecurity,relforcerowsecurity from pg_class where relname in('crm_website_sales_advisory','crm_website_sales_advisory_records','crm_website_sales_advisory_assignments','crm_website_sales_advisory_buyer_grants','crm_website_sales_advisory_buyer_events','crm_website_sales_advisory_buyer_revocations','crm_website_sales_advisory_jobs','crm_website_sales_advisory_job_events','crm_website_sales_advisory_video_assets')")).rows;
   assert.equal(relations.length, 9); assert.ok(relations.every(r => r.relrowsecurity && r.relforcerowsecurity));
   const roles = (await installer!.query("select * from pg_roles where rolname in('novalure_website_sales_advisory_access_owner','novalure_website_sales_advisory_executor')")).rows;
   assert.equal(roles.length, 2); assert.ok(roles.every(r => !r.rolcanlogin && !r.rolsuper && !r.rolbypassrls && !r.rolcreatedb && !r.rolcreaterole));
   assert.equal((await installer!.query("select count(*)::int n from pg_auth_members m join pg_roles r on r.oid=m.roleid where r.rolname like 'novalure_website_sales_advisory%' and(m.set_option or m.inherit_option)")).rows[0].n, 0);
  });
  await t.test('ordinary application connections cannot call private currentness or insert video bytes', async () => {
   const client = await db.pool.connect(); try {
    await assert.rejects(client.query("select crm_website_sales_advisory_record_current('00000000-0000-4000-8000-000000000001',0)"), { code: '42501' });
    assert.equal((await client.query("select has_table_privilege(current_user,'crm_website_sales_advisory_video_assets','INSERT') as ok")).rows[0].ok, false);
   } finally { client.release(); }
  });
 } finally { await installer?.end(); await db.stop(); }
});
