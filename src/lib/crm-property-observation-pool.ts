import "server-only";
import type { PoolClient } from "@neondatabase/serverless";
import type { TenantPool } from "./db/tenant-client";

/**
 * Live pool deliberately unavailable until actual database, branch, TLS target,
 * and dedicated-login binding can be checked by the host. Never fall back to
 * the shared CRM DATABASE_URL or grant the shared login the property role.
 */
export async function propertyObservationPool(): Promise<TenantPool> {
  throw new Error("CRM_PROPERTY_DB_TARGET_BINDING_REQUIRED");
}

/** All statements are fixed by the trusted server caller, not the request. */
export async function withPropertyObservationTransaction<T>(pool: TenantPool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect(); let active = false; let released = false;
  try {
    const checked = await client.query<{ safe: boolean }>(`
      select (
        session_user=current_user and runtime_role.rolcanlogin
        and not runtime_role.rolsuper and not runtime_role.rolbypassrls and not runtime_role.rolcreatedb
        and not runtime_role.rolcreaterole and not runtime_role.rolreplication
        and pg_has_role(session_user,'novalure_property_reader','USAGE')
        and not pg_has_role(session_user,'novalure_tenant_app','MEMBER')
        and not exists (select 1 from pg_namespace n where n.nspname<>'information_schema' and n.nspname !~ '^pg_'
          and (has_schema_privilege(session_user,n.oid,'CREATE') or pg_has_role(session_user,n.nspowner,'MEMBER')))
        and to_regprocedure('public.crm_property_observation_actor(uuid,uuid,uuid,text,text,text,text,text,text,text[])') is not null
        and to_regprocedure('public.crm_property_observe_unit(uuid,uuid,uuid,uuid,text,text,text,text,text,text,text[],text,timestamp with time zone)') is not null
        and not exists (select 1 from pg_roles r where pg_has_role(session_user,r.oid,'MEMBER')
          and (r.rolsuper or r.rolbypassrls or r.rolcreatedb or r.rolcreaterole or r.rolreplication))
        and not exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
          where n.nspname<>'information_schema' and n.nspname !~ '^pg_' and p.prosecdef and (
            pg_has_role(session_user,p.proowner,'MEMBER') or (has_function_privilege(session_user,p.oid,'EXECUTE') and p.oid not in (
              to_regprocedure('public.crm_property_observation_actor(uuid,uuid,uuid,text,text,text,text,text,text,text[])'),
              to_regprocedure('public.crm_property_observe_unit(uuid,uuid,uuid,uuid,text,text,text,text,text,text,text[],text,timestamp with time zone)')))))
        and not exists (select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
          where n.nspname<>'information_schema' and n.nspname !~ '^pg_' and c.relkind in ('r','p','v','m','f') and (
            pg_has_role(session_user,c.relowner,'MEMBER') or has_table_privilege(session_user,c.oid,'SELECT')
            or has_table_privilege(session_user,c.oid,'INSERT')
            or has_table_privilege(session_user,c.oid,'UPDATE') or has_table_privilege(session_user,c.oid,'DELETE')
            or has_table_privilege(session_user,c.oid,'TRUNCATE') or has_table_privilege(session_user,c.oid,'TRIGGER')
            or has_table_privilege(session_user,c.oid,'REFERENCES')
            or exists (select 1 from pg_attribute a where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped and (
              has_column_privilege(session_user,c.oid,a.attnum,'SELECT') or has_column_privilege(session_user,c.oid,a.attnum,'INSERT')
              or has_column_privilege(session_user,c.oid,a.attnum,'UPDATE') or has_column_privilege(session_user,c.oid,a.attnum,'REFERENCES')))))
      ) as safe from pg_roles runtime_role where runtime_role.rolname=session_user
    `);
    if (checked.rows[0]?.safe !== true) throw new Error("CRM_PROPERTY_DB_ROLE_UNSAFE");
    await client.query("begin"); active = true;
    await client.query("select set_config('statement_timeout','5000',true),set_config('lock_timeout','5000',true)");
    const result = await work(client);
    const committed = await client.query("commit"); active = false;
    if (committed.command && committed.command !== "COMMIT") throw new Error("CRM_PROPERTY_DB_COMMIT_FAILED");
    return result;
  } catch (error) {
    if (active) { try { await client.query("rollback"); } catch { client.release(true); released = true; } }
    throw error;
  } finally { if (!released) client.release(); }
}
