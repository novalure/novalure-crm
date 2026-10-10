#!/usr/bin/env node

import { createHash } from "node:crypto";
import { Pool } from "pg";
import { assertConnectedDatabaseTarget } from "./lib/infra-targets.mjs";

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required; QA role binding is fail-closed.`);
  return value;
}

function targetDigest() {
  return createHash("sha256")
    .update([
      required("NOVALURE_QA_PROJECT_ID"),
      required("NOVALURE_QA_BRANCH_ID"),
      required("NOVALURE_QA_DATABASE_NAME"),
      required("NOVALURE_QA_DATABASE_ROLE"),
      required("NOVALURE_QA_MIGRATION_DATABASE_ROLE"),
    ].join("\0"))
    .digest("hex")
    .slice(0, 16);
}

function assertDirectMigrationUrl(value) {
  const url = new URL(value);
  if (url.hostname.includes("-pooler.")) {
    throw new Error("QA role binding requires the direct migration connection, never the pooled runtime connection.");
  }
}

async function rolePosture(client) {
  const result = await client.query(`
    select
      runtime.rolcanlogin as "runtimeCanLogin",
      runtime.rolinherit as "runtimeInherit",
      not runtime.rolsuper as "runtimeNoSuperuser",
      not runtime.rolbypassrls as "runtimeNoBypassRls",
      not runtime.rolcreatedb as "runtimeNoCreateDb",
      not runtime.rolcreaterole as "runtimeNoCreateRole",
      not runtime.rolreplication as "runtimeNoReplication",
      not has_database_privilege('novalure_app', current_database(), 'CREATE') as "runtimeNoDatabaseDdl",
      not has_schema_privilege('novalure_app', 'public', 'CREATE') as "runtimeNoSchemaDdl",
      not exists (
        select 1 from pg_database database
        where database.datname = current_database() and database.datdba = runtime.oid
      ) as "runtimeNotDatabaseOwner",
      not exists (
        select 1 from pg_namespace schema where schema.nspname = 'public' and schema.nspowner = runtime.oid
      ) as "runtimeNotSchemaOwner",
      not exists (
        select 1
        from pg_class relation
        join pg_namespace schema on schema.oid = relation.relnamespace
        where schema.nspname = 'public'
          and relation.relkind in ('r', 'p', 'S', 'v', 'm', 'f')
          and relation.relowner = runtime.oid
      ) as "runtimeNotTableOwner",
      not (
        has_table_privilege('novalure_app', 'public.novalure_schema_migrations', 'SELECT')
        or has_table_privilege('novalure_app', 'public.novalure_schema_migrations', 'INSERT')
        or has_table_privilege('novalure_app', 'public.novalure_schema_migrations', 'UPDATE')
        or has_table_privilege('novalure_app', 'public.novalure_schema_migrations', 'DELETE')
        or has_table_privilege('novalure_app', 'public.novalure_schema_migrations', 'TRUNCATE')
      ) as "runtimeNoMigrationPrivilege",
      not tenant.rolcanlogin
        and not tenant.rolsuper
        and not tenant.rolbypassrls
        and not tenant.rolcreatedb
        and not tenant.rolcreaterole
        and not tenant.rolreplication as "tenantGroupSafe",
      exists (
        select 1 from pg_auth_members membership
        where membership.roleid = tenant.oid
          and membership.member = runtime.oid
          and membership.inherit_option
          and not membership.admin_option
          and not membership.set_option
          and pg_has_role(runtime.oid, tenant.oid, 'USAGE')
      ) as "runtimeMembershipSafe",
      not exists (
        select 1
        from pg_roles reachable
        where (pg_has_role(runtime.oid, reachable.oid, 'USAGE') or pg_has_role(runtime.oid, reachable.oid, 'SET'))
          and reachable.oid <> runtime.oid
          and (reachable.rolsuper or reachable.rolbypassrls or reachable.rolcreatedb or reachable.rolcreaterole or reachable.rolreplication)
      ) as "noPrivilegedRoleReachability"
    from pg_roles runtime
    cross join pg_roles tenant
    where runtime.rolname = 'novalure_app'
      and tenant.rolname = 'novalure_tenant_app'
  `);
  const row = result.rows[0];
  if (!row) throw new Error("QA runtime or tenant group role is missing.");
  return row;
}

function assertSafePosture(posture, { requireMembership }) {
  const requiredChecks = [
    "runtimeCanLogin",
    "runtimeInherit",
    "runtimeNoSuperuser",
    "runtimeNoBypassRls",
    "runtimeNoCreateDb",
    "runtimeNoCreateRole",
    "runtimeNoReplication",
    "runtimeNoDatabaseDdl",
    "runtimeNoSchemaDdl",
    "runtimeNotDatabaseOwner",
    "runtimeNotSchemaOwner",
    "runtimeNotTableOwner",
    "runtimeNoMigrationPrivilege",
    "tenantGroupSafe",
    "noPrivilegedRoleReachability",
  ];
  if (requireMembership) requiredChecks.push("runtimeMembershipSafe");
  const failures = requiredChecks.filter((key) => posture[key] !== true);
  if (failures.length) {
    throw new Error(`QA role posture is unsafe: ${failures.join(", ")}.`);
  }
}

const migrationUrl = required("MIGRATION_DATABASE_URL");
if (required("NOVALURE_QA_DATABASE_ROLE") !== "novalure_app") {
  throw new Error("NOVALURE_QA_DATABASE_ROLE must be exactly novalure_app for runtime binding.");
}
if (required("NOVALURE_QA_MIGRATION_DATABASE_ROLE") === "novalure_app") {
  throw new Error("Migration executor must remain distinct from novalure_app.");
}
assertDirectMigrationUrl(migrationUrl);

const pool = new Pool({ connectionString: migrationUrl, max: 1 });
const client = await pool.connect();
let begun = false;
try {
  await client.query("begin");
  begun = true;
  await assertConnectedDatabaseTarget({
    client,
    connectionMode: "direct",
    minimumServerVersionNum: 170000,
    purpose: "QA runtime-role binding",
    target: "qa",
  });
  const before = await rolePosture(client);
  assertSafePosture(before, { requireMembership: false });
  await client.query(
    "grant novalure_tenant_app to novalure_app with admin false, inherit true, set false",
  );
  const after = await rolePosture(client);
  assertSafePosture(after, { requireMembership: true });
  await client.query("commit");
  begun = false;
  console.log(`QA_RUNTIME_ROLE_BINDING=PASS target=sha256:${targetDigest()}`);
} catch (error) {
  if (begun) await client.query("rollback");
  throw error;
} finally {
  client.release();
  await pool.end();
}
