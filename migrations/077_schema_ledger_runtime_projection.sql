-- Least-privilege runtime projection for migration checksum evidence.
--
-- The application role must never read or mutate the migration ledger itself.
-- This owner-rights view freezes the exposed contract to version + checksum,
-- while DISTINCT keeps the projection structurally non-updatable.

set local lock_timeout = '5s';
set local statement_timeout = '14min';

do $migration$
begin
  if to_regclass('public.novalure_schema_migrations') is null then
    raise exception 'migration ledger is required before 077';
  end if;
  if not exists (
    select 1
    from public.novalure_schema_migrations
    where version = '076_bot_webhook_durable_processing'
  ) then
    raise exception 'migration 076_bot_webhook_durable_processing is required before 077';
  end if;
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'novalure_app') then
    raise exception using
      errcode = '42501',
      message = 'novalure_app role is required before schema-ledger runtime projection';
  end if;
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'novalure_tenant_app') then
    raise exception using
      errcode = '42501',
      message = 'novalure_tenant_app role is required before schema-ledger runtime projection';
  end if;
  if (
    select relation.relowner
    from pg_catalog.pg_class relation
    where relation.oid = to_regclass('public.novalure_schema_migrations')
  ) is distinct from (
    select role_state.oid
    from pg_catalog.pg_roles role_state
    where role_state.rolname = current_user
  ) then
    raise exception using
      errcode = '42501',
      message = 'migration 077 must be executed by the exact migration-ledger owner';
  end if;
end;
$migration$;

create or replace view public.novalure_schema_migration_checksums
with (security_barrier = true, security_invoker = false)
as
select distinct
  version,
  checksum
from public.novalure_schema_migrations;

revoke all on table public.novalure_schema_migrations
  from public, novalure_tenant_app, novalure_app;
revoke
  select (version, name, checksum, applied_at),
  insert (version, name, checksum, applied_at),
  update (version, name, checksum, applied_at),
  references (version, name, checksum, applied_at)
on table public.novalure_schema_migrations
  from public, novalure_tenant_app, novalure_app;

revoke all on table public.novalure_schema_migration_checksums
  from public, novalure_tenant_app, novalure_app;
revoke
  select (version, checksum),
  insert (version, checksum),
  update (version, checksum),
  references (version, checksum)
on table public.novalure_schema_migration_checksums
  from public, novalure_tenant_app, novalure_app;
grant select on table public.novalure_schema_migration_checksums
  to novalure_app;

comment on view public.novalure_schema_migration_checksums is
  'Read-only owner-backed runtime projection of migration versions and checksums; the base ledger remains inaccessible to application roles.';

do $migration$
declare
  app_role_oid oid;
  projection_oid oid := to_regclass('public.novalure_schema_migration_checksums');
  projection_options text[];
  ledger_owner oid;
  projection_owner oid;
  projection_columns text[];
begin
  select oid into app_role_oid
  from pg_catalog.pg_roles
  where rolname = 'novalure_app';

  select relation.relowner into ledger_owner
  from pg_catalog.pg_class relation
  where relation.oid = to_regclass('public.novalure_schema_migrations');

  select
    relation.reloptions,
    relation.relowner,
    array(
      select attribute.attname::text
      from pg_catalog.pg_attribute attribute
      where attribute.attrelid = relation.oid
        and attribute.attnum > 0
        and not attribute.attisdropped
      order by attribute.attnum
    )
  into projection_options, projection_owner, projection_columns
  from pg_catalog.pg_class relation
  where relation.oid = projection_oid
    and relation.relkind = 'v';

  if projection_oid is null
     or projection_columns is distinct from array['version', 'checksum']::text[]
     or not ('security_barrier=true' = any(coalesce(projection_options, '{}'::text[])))
     or not ('security_invoker=false' = any(coalesce(projection_options, '{}'::text[])))
     or projection_owner is distinct from ledger_owner
     or projection_owner = app_role_oid
     or pg_catalog.pg_has_role('novalure_app', projection_owner, 'MEMBER')
     or pg_catalog.pg_has_role('novalure_app', projection_owner, 'USAGE') then
    raise exception 'schema-ledger runtime projection is not owner-scoped to the exact read-only contract';
  end if;

  if pg_catalog.has_table_privilege('novalure_app', 'public.novalure_schema_migrations', 'SELECT')
     or pg_catalog.has_table_privilege('novalure_app', 'public.novalure_schema_migrations', 'INSERT')
     or pg_catalog.has_table_privilege('novalure_app', 'public.novalure_schema_migrations', 'UPDATE')
     or pg_catalog.has_table_privilege('novalure_app', 'public.novalure_schema_migrations', 'DELETE')
     or pg_catalog.has_table_privilege('novalure_app', 'public.novalure_schema_migrations', 'TRUNCATE')
     or pg_catalog.has_table_privilege('novalure_app', 'public.novalure_schema_migrations', 'REFERENCES')
     or pg_catalog.has_table_privilege('novalure_app', 'public.novalure_schema_migrations', 'TRIGGER')
     or pg_catalog.has_table_privilege('novalure_app', 'public.novalure_schema_migrations', 'MAINTAIN')
     or pg_catalog.has_any_column_privilege('novalure_app', 'public.novalure_schema_migrations', 'SELECT')
     or pg_catalog.has_any_column_privilege('novalure_app', 'public.novalure_schema_migrations', 'INSERT')
     or pg_catalog.has_any_column_privilege('novalure_app', 'public.novalure_schema_migrations', 'UPDATE')
     or pg_catalog.has_any_column_privilege('novalure_app', 'public.novalure_schema_migrations', 'REFERENCES') then
    raise exception 'novalure_app must retain zero table privileges on the migration ledger';
  end if;

  if not pg_catalog.has_table_privilege('novalure_app', projection_oid, 'SELECT')
     or pg_catalog.has_table_privilege('novalure_app', projection_oid, 'SELECT WITH GRANT OPTION')
     or pg_catalog.has_table_privilege('novalure_app', projection_oid, 'INSERT')
     or pg_catalog.has_table_privilege('novalure_app', projection_oid, 'UPDATE')
     or pg_catalog.has_table_privilege('novalure_app', projection_oid, 'DELETE')
     or pg_catalog.has_table_privilege('novalure_app', projection_oid, 'TRUNCATE')
     or pg_catalog.has_table_privilege('novalure_app', projection_oid, 'REFERENCES')
     or pg_catalog.has_table_privilege('novalure_app', projection_oid, 'TRIGGER')
     or pg_catalog.has_table_privilege('novalure_app', projection_oid, 'MAINTAIN')
     or pg_catalog.has_any_column_privilege('novalure_app', projection_oid, 'INSERT')
     or pg_catalog.has_any_column_privilege('novalure_app', projection_oid, 'UPDATE')
     or pg_catalog.has_any_column_privilege('novalure_app', projection_oid, 'REFERENCES')
     or pg_catalog.has_any_column_privilege('novalure_app', projection_oid, 'SELECT WITH GRANT OPTION') then
    raise exception 'novalure_app must have SELECT-only access to the schema-ledger runtime projection';
  end if;

  if exists (
    select 1
    from pg_catalog.pg_class relation
    cross join lateral pg_catalog.aclexplode(
      coalesce(relation.relacl, pg_catalog.acldefault('r', relation.relowner))
    ) acl
    where relation.oid = projection_oid
      and acl.grantee = 0
  ) or exists (
    select 1
    from pg_catalog.pg_attribute attribute
    cross join lateral pg_catalog.aclexplode(attribute.attacl) acl
    where attribute.attrelid = projection_oid
      and attribute.attnum > 0
      and not attribute.attisdropped
      and acl.grantee = 0
  ) then
    raise exception 'PUBLIC must have zero privileges on the schema-ledger runtime projection';
  end if;
end;
$migration$;
