import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { test } from 'node:test';
import { applySalesSchema, startLocalSalesDb } from './lib/local-sales-db.mjs';

// One owned loopback cluster, synthetic rows and exact checked-in SQL only.
// No application/provider credentials, network provider or production cutover.
test('isolated Webchat access and released partner/billing guards compose in both migration orders', { timeout: 240_000 }, async t => {
  const db = await startLocalSalesDb();
  async function apply(name) {
    const sql = await readFile(`migrations/${name}`, 'utf8');
    const client = await db.admin.connect();
    try {
      await client.query('begin');
      await client.query(sql);
      await client.query('insert into novalure_schema_migrations(version,name,checksum) values($1,$2,$3) on conflict(version) do nothing',
        [name.replace(/\.sql$/u, ''), name, createHash('sha256').update(sql).digest('hex')]);
      await client.query('commit');
    } catch (error) { await client.query('rollback'); throw error; }
    finally { client.release(); }
  }
  const ids = Object.fromEntries(['alpha','beta','alphaProject','betaProject','member','partner','betaMember'].map(key => [key,randomUUID()]));
  async function access(actor, workspace, project) {
    const client = await db.pool.connect();
    try {
      await client.query('begin');
      await client.query("select set_config('app.tenant_id',$1,true),set_config('app.actor_id',$2,true),set_config('app.operation_purpose','crm_sales',true)", [workspace,actor]);
      const row = (await client.query(`select crm_project_access($1::uuid,$2::uuid,false) as readable,
        crm_project_access($1::uuid,$2::uuid,true) as writable,
        crm_lock_project_access($1::uuid,$2::uuid,true) as locked`, [workspace,project])).rows[0];
      await client.query('rollback');
      return row;
    } finally { client.release(); }
  }
  const denied = {readable:false,writable:false,locked:false};
  const allowed = {readable:true,writable:true,locked:true};
  const defaults = async () => (await db.admin.query("select defaclobjtype,defaclacl::text from pg_default_acl where defaclrole=current_user::regrole and defaclnamespace='public'::regnamespace order by defaclobjtype")).rows;
  try {
    // Retain the historical 092 inventory boundary before creating 101+ tables.
    await applySalesSchema(db,{maxMigrationNumber:90});
    await db.admin.query("alter table company_profiles enable row level security;alter table company_profiles force row level security;alter table company_profile_versions enable row level security;alter table company_profile_versions force row level security");
    await db.admin.query("do $$ declare r record; begin for r in select format('%I.%I',n.nspname,c.relname) as q from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','p') and c.relrowsecurity loop execute 'alter table '||r.q||' force row level security'; end loop; end $$");
    for (const name of ['092_crm_production_machine_identity.sql','093_crm_machine_internal_context.sql','094_website_sales_ingestion.sql','095_form_tenant_isolation.sql','096_public_integration_gateway.sql']) await apply(name);
    for (const name of (await readdir('migrations')).filter(name => /^\d+.*\.sql$/u.test(name) && !name.includes('_rollback') && Number(name.slice(0,3))>=101 && Number(name.slice(0,3))<=110).sort()) await apply(name);
    for (const name of ['114_customer_workspace_provisioning.sql','146_ai_credit_billing.sql','152_ai_billing_admin.sql','153_ai_billing_runtime_acl.sql','167_crm_partner_cooperation.sql','188_crm_ai_assistant.sql']) await apply(name);
    const originalDefaults = await defaults();
    await apply('121_webchat_customer_product.sql');
    await db.admin.query("insert into workspaces(id,name,operating_model,customer_type) values($1,'SYNTHETIC alpha','self_service_customer','general_company'),($2,'SYNTHETIC beta','self_service_customer','general_company')",[ids.alpha,ids.beta]);
    for (const [id,workspace,role] of [[ids.member,ids.alpha,'team_member'],[ids.partner,ids.alpha,'external_partner'],[ids.betaMember,ids.beta,'team_member']]) {
      await db.admin.query("insert into workspace_users(id,workspace_id,name,email,role,product_role,status) values($1,$2,'SYNTHETIC compatibility',$3,'agent',$4,'active')",[id,workspace,`${id}@example.invalid`,role]);
    }
    await db.admin.query("insert into projects(id,workspace_id,name,type) values($1,$2,'SYNTHETIC alpha project','Service'),($3,$4,'SYNTHETIC beta project','Service')",[ids.alphaProject,ids.alpha,ids.betaProject,ids.beta]);
    await db.admin.query("insert into project_pipeline_permissions(workspace_id,project_id,user_id,can_read,can_edit_deals) values($1,$2,$3,true,true),($4,$5,$6,true,true)",[ids.alpha,ids.alphaProject,ids.partner,ids.beta,ids.betaProject,ids.betaMember]);
    await db.admin.query("insert into webchat_product_accounts(workspace_id,quota_units,contract_reference) values($1,10,'SYNTHETIC compatibility only')",[ids.alpha]);

    await t.test('late 121 preserves the released external-partner denial even with a legacy broad grant',async()=>{
      assert.deepEqual(await access(ids.partner,ids.alpha,ids.alphaProject),denied);
      assert.deepEqual(await access(ids.member,ids.alpha,ids.alphaProject),allowed);
      assert.deepEqual(await access(ids.member,ids.beta,ids.betaProject),denied);
      assert.deepEqual(await access(ids.betaMember,ids.beta,ids.betaProject),allowed);
    });
    await t.test('the exact later 167 function reproduces the old member incompatibility without opening partners',async()=>{
      const sql=await readFile('migrations/167_crm_partner_cooperation.sql','utf8');
      const start=sql.indexOf('create or replace function crm_project_access('),end=sql.indexOf('$$;',start)+3;
      assert.ok(start>=0 && end>start);
      await db.admin.query(sql.slice(start,end));
      assert.deepEqual(await access(ids.member,ids.alpha,ids.alphaProject),denied);
      assert.deepEqual(await access(ids.partner,ids.alpha,ids.alphaProject),denied);
    });
    await apply('191_webchat_partner_access_compatibility.sql');
    await t.test('191 retains both branches and current cross-tenant, membership and account revocation',async()=>{
      assert.deepEqual(await access(ids.member,ids.alpha,ids.alphaProject),allowed);
      assert.deepEqual(await access(ids.partner,ids.alpha,ids.alphaProject),denied);
      assert.deepEqual(await access(ids.betaMember,ids.beta,ids.betaProject),allowed);
      assert.deepEqual(await access(ids.member,ids.beta,ids.betaProject),denied);
      await db.admin.query("update workspace_users set status='suspended' where id=$1",[ids.member]);
      assert.deepEqual(await access(ids.member,ids.alpha,ids.alphaProject),denied);
      await db.admin.query("update workspace_users set status='active' where id=$1",[ids.member]);
      await db.admin.query('delete from webchat_product_accounts where workspace_id=$1',[ids.alpha]);
      assert.deepEqual(await access(ids.member,ids.alpha,ids.alphaProject),denied);
    });
    await t.test('test payments and released real AI billing keep separate restricted executors and unchanged defaults',async()=>{
      for(const signature of ['webchat_apply_test_payment(uuid,text,text,text,text,text,bigint,text,text)','crm_ai_fulfill_booking(uuid,text,text,timestamptz)']) {
        assert.equal((await db.admin.query('select has_function_privilege($1,$2,\'EXECUTE\') as allowed',[db.role,signature])).rows[0].allowed,false);
      }
      assert.equal((await db.admin.query("select has_function_privilege($1,'crm_ai_snapshot(uuid)','EXECUTE') as allowed",[db.role])).rows[0].allowed,true);
      assert.deepEqual(await defaults(),originalDefaults);
    });
  } finally { await db.stop(); }
});
