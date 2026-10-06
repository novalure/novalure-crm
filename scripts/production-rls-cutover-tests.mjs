import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import pg from "pg";
import { startLocalSalesDb } from "./lib/local-sales-db.mjs";

const migration = await readFile(
  new URL("../migrations/091_production_runtime_forced_rls_cutover.sql", import.meta.url),
  "utf8",
);

test("091 proves direct denial and scoped own/foreign/unset company-profile access", { timeout: 240_000 }, async () => {
  const db = await startLocalSalesDb();
  let owner;
  let runtime;
  try {
    await db.admin.query(`
      alter role novalure_app login noinherit;
      create role neondb_owner login bypassrls createrole createdb;
      create role novalure_tenant_app nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
      grant novalure_tenant_app to novalure_app with admin false, inherit true, set false;
    `);
    await db.admin.query("create database neondb owner neondb_owner");
    owner = new pg.Client({ host: "127.0.0.1", port: db.port, user: "neondb_owner", database: "neondb" });
    runtime = new pg.Client({ host: "127.0.0.1", port: db.port, user: "novalure_app", database: "neondb" });
    await owner.connect();
    await runtime.connect();
    await owner.query(`
      create table novalure_schema_migrations(version text primary key, name text not null, checksum text not null);
      insert into novalure_schema_migrations values ('090_property_media_delete_runtime','090.sql','synthetic');
      create table workspace_users(
        id uuid primary key,
        workspace_id uuid not null,
        status text not null,
        role text not null,
        product_role text not null
      );
      create table company_profiles(
        id uuid primary key default gen_random_uuid(),
        profile_scope text not null,
        workspace_id uuid,
        organization_id uuid,
        legal_name text not null default '',
        updated_at timestamptz not null default now()
      );
      create table company_profile_versions(
        id uuid primary key default gen_random_uuid(),
        company_profile_id uuid not null references company_profiles(id),
        workspace_id uuid,
        actor_user_id uuid,
        action text not null,
        before jsonb,
        after jsonb not null,
        changed_fields text[] not null,
        created_at timestamptz not null default now()
      );
      grant select, insert, update, delete on company_profiles, company_profile_versions to novalure_app;
    `);
    await owner.query("begin");
    await owner.query(migration);
    await owner.query("commit");

    const ownWorkspace = randomUUID();
    const foreignWorkspace = randomUUID();
    const actor = randomUUID();
    const foreignActor = randomUUID();
    await owner.query(
      `insert into workspace_users(id,workspace_id,status,role,product_role)
       values($1,$2,'active','owner','customer_owner'),($3,$4,'active','owner','customer_owner')`,
      [actor, ownWorkspace, foreignActor, foreignWorkspace],
    );
    await owner.query(
      `insert into company_profiles(profile_scope,workspace_id,legal_name)
       values('workspace_owner',$1,'Own'),('workspace_owner',$2,'Foreign')`,
      [ownWorkspace, foreignWorkspace],
    );

    await assert.rejects(runtime.query("select * from company_profiles"), /permission denied/);
    assert.equal((await runtime.query("select * from crm_company_profiles_scoped")).rowCount, 0);

    await runtime.query("begin");
    await runtime.query("select set_config('app.tenant_id',$1,true),set_config('app.actor_id',$2,true)", [ownWorkspace, actor]);
    const own = await runtime.query("select legal_name from crm_company_profiles_scoped order by legal_name");
    assert.deepEqual(own.rows, [{ legal_name: "Own" }]);
    const inserted = await runtime.query(
      "insert into crm_company_profiles_write_scoped(profile_scope,workspace_id,organization_id,legal_name) values('crm_account',$1,$2,'Account') returning id",
      [ownWorkspace, randomUUID()],
    );
    await runtime.query(
      "select crm_company_profile_record_version($1,'company_profile.created',null,$2::jsonb,$3::text[])",
      [inserted.rows[0].id, JSON.stringify({ legalName: "Account" }), ["legalName"]],
    );
    assert.equal((await runtime.query("select * from crm_company_profile_versions_scoped")).rowCount, 1);
    await runtime.query("rollback");

    await runtime.query("begin");
    await runtime.query("select set_config('app.tenant_id',$1,true),set_config('app.actor_id',$2,true)", [foreignWorkspace, foreignActor]);
    assert.equal((await runtime.query("select * from crm_company_profiles_scoped where workspace_id=$1", [ownWorkspace])).rowCount, 0);
    await assert.rejects(
      runtime.query("insert into crm_company_profiles_write_scoped(profile_scope,workspace_id,legal_name) values('workspace_owner',$1,'Denied')", [ownWorkspace]),
      /violates check option|permission denied/,
    );
    await runtime.query("rollback");

    const directAcl = await owner.query(`
      select count(*)::integer as count
      from aclexplode(coalesce((select relacl from pg_class where oid='public.company_profiles'::regclass), acldefault('r',(select relowner from pg_class where oid='public.company_profiles'::regclass)))) acl
      where acl.grantee='novalure_app'::regrole
    `);
    assert.equal(directAcl.rows[0].count, 0);
    const flags = await owner.query("select relrowsecurity,relforcerowsecurity from pg_class where oid='public.company_profiles'::regclass");
    assert.deepEqual(flags.rows[0], { relrowsecurity: true, relforcerowsecurity: true });
  } finally {
    await Promise.allSettled([runtime?.end(), owner?.end()]);
    await db.stop();
  }
});
