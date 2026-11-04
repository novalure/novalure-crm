import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { LocalSalesPool, startLocalSalesDb } from "./lib/local-sales-db.mjs";

test("194 transfers ownership under a non-superuser NOINHERIT deployer and restores temporary ACLs", { timeout: 120_000 }, async t => {
  const db = await startLocalSalesDb();
  const source = await readFile("migrations/194_qa_registered_batch_lock.sql", "utf8");
  const original = await readFile("docs/testing/evidence/qa-cleanup-20261104/194-before-owner-transfer-fix.sql", "utf8");
  const ledger = await readFile("migrations/068_qa_batch_reset_safety.sql", "utf8");
  const locking = (await readFile("migrations/080_crm_command_safety.sql", "utf8")).match(/create or replace function crm_lock_active_member\([\s\S]*?end \$\$;/)?.[0];
  assert.ok(locking);
  const pools: InstanceType<typeof LocalSalesPool>[] = [];
  try {
    await db.admin.query("create role novalure_tenant_app nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls");
    for (const variant of ["creator_admin_without_set", "existing_own_grant_without_set", "existing_set_and_create_grant_option"] as const) {
      await t.test(variant, async () => {
        const suffix = randomUUID().replaceAll("-", "").slice(0, 12), deployer = `qa_deployer_${suffix}`, database = `qa_owner_${suffix}`;
        await db.admin.query(`create role ${deployer} login noinherit nosuperuser nocreatedb createrole noreplication nobypassrls`);
        await db.admin.query(`create database ${database} owner ${deployer}`);
        const pool = new LocalSalesPool({ host: "127.0.0.1", port: db.port, user: deployer, database, max: 1, connectionTimeoutMillis: 5_000 }); pools.push(pool);
        const client = await pool.connect();
        try {
          // Minimal exact predecessor contracts, owned by this deployment role
          // from creation; no later ownership reassignment and no claim of a
          // full production-upgrade rehearsal.
          await client.query("create table workspaces(id uuid primary key,operating_model text); create table workspace_users(id uuid primary key,workspace_id uuid,role text,product_role text,status text,auth_identity_id uuid); create table audit_logs(id uuid primary key,project_id uuid,deal_id uuid)");
          await client.query("begin"); await client.query(ledger); await client.query("commit");
          await client.query(locking); await client.query("grant execute on function crm_lock_active_member(uuid,uuid) to novalure_tenant_app");
          if (variant === "creator_admin_without_set") {
            await client.query("create role novalure_qa_batch_locker nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls");
          } else {
            await db.admin.query(`grant novalure_qa_batch_locker to ${deployer} with admin true, inherit false, set false`);
            if (variant === "existing_own_grant_without_set") await client.query(`grant novalure_qa_batch_locker to ${deployer} with admin false, inherit false, set false granted by ${deployer}`);
            else {
              await db.admin.query(`grant novalure_qa_batch_locker to ${deployer} with admin true, inherit false, set true`);
              await client.query("grant create on schema public to novalure_qa_batch_locker with grant option");
            }
          }
          const flags = (await client.query("select rolsuper as super,rolinherit as inherit,rolcreaterole as createrole,rolbypassrls as bypass from pg_roles where rolname=current_user")).rows[0]; assert.deepEqual(flags, { super: false, inherit: false, createrole: true, bypass: false });
          async function snapshot() {
            const memberships = (await client.query("select grantor::regrole::text as grantor,admin_option,inherit_option,set_option from pg_auth_members where roleid='novalure_qa_batch_locker'::regrole and member=current_user::regrole order by grantor")).rows;
            const schemaCreate = (await client.query("select grantor::regrole::text as grantor,is_grantable from pg_namespace n cross join lateral aclexplode(coalesce(n.nspacl,acldefault('n',n.nspowner))) acl where n.nspname='public' and acl.grantee='novalure_qa_batch_locker'::regrole and acl.privilege_type='CREATE' order by grantor")).rows;
            return { memberships, schemaCreate };
          }
          const before = await snapshot();
          if (variant === "creator_admin_without_set") {
            assert.equal((await client.query("select pg_has_role(current_user,'novalure_qa_batch_locker','SET') as allowed")).rows[0].allowed, false);
            await client.query("begin");
            try { await assert.rejects(client.query(original), error => (error as { code?: string }).code === "42501"); }
            finally { await client.query("rollback"); }
            assert.deepEqual(await snapshot(), before, "the original rejected migration must roll back its partial ACL/DDL");
          }
          await client.query("begin");
          try { await client.query(source); await client.query("commit"); }
          catch (error) { await client.query("rollback"); throw error; }
          assert.deepEqual(await snapshot(), before, "temporary SET/CREATE and original grantor/options must restore exactly");
          const installed = (await client.query("select owner_role.rolname as owner,p.prosecdef as definer,p.proconfig as config,owner_role.rolinherit as inherit,owner_role.rolcanlogin as login,owner_role.rolbypassrls as bypass from pg_proc p join pg_roles owner_role on owner_role.oid=p.proowner where p.oid='crm_qa_lock_registered_batch(uuid,uuid)'::regprocedure")).rows[0];
          assert.deepEqual(installed, { owner: "novalure_qa_batch_locker", definer: true, config: ["search_path=pg_catalog, public"], inherit: false, login: false, bypass: false });
          const rights = (await client.query("select has_column_privilege('novalure_tenant_app','qa_batches','id','UPDATE') as update,pg_has_role('novalure_tenant_app','novalure_qa_batch_locker','MEMBER') as member,(select count(*) from pg_proc p cross join lateral aclexplode(p.proacl) acl where p.oid='crm_qa_lock_registered_batch(uuid,uuid)'::regprocedure and acl.grantee=0 and acl.privilege_type='EXECUTE')::int as public_execute,to_regclass('pg_temp.qa_cleanup_194_grant_restore') as leftover")).rows[0];
          assert.deepEqual(rights, { update: false, member: false, public_execute: 0, leftover: null });
        } finally { client.release(); }
      });
    }
  } finally { await Promise.all(pools.map(pool => pool.end())); await db.stop(); }
});
