-- QA/PREVIEW-ONLY rollback companion for 080_property_export_runtime.sql.
--
-- This script refuses to run unless both session flags are explicitly set:
--   SET novalure.environment = 'preview';
--   SET novalure.allow_qa_schema_rollback = 'true';
-- It never drops the pre-existing property_channels/property_export_jobs
-- tables and refuses to erase any 080 runtime evidence.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '14min';
-- Never let an RLS-filtered scan look like an empty-table safety check.
set local row_security = off;

do $rollback_guard$
declare
  has_runtime_data boolean;
  dependent_object text;
  event_table_oid oid := to_regclass('public.property_export_job_events')::oid;
begin
  if current_setting('novalure.environment', true) is distinct from 'preview'
    or current_setting('novalure.allow_qa_schema_rollback', true) is distinct from 'true' then
    raise exception using
      errcode = '42501',
      message = '080 rollback is restricted to an explicitly authorized Preview session';
  end if;

  if exists (
    select 1
    from pg_catalog.pg_class parent_table
    where parent_table.oid in ('public.property_channels'::regclass, 'public.property_export_jobs'::regclass)
      and (
        parent_table.relforcerowsecurity
        or (
          parent_table.relrowsecurity
          and not exists (
            select 1
            from pg_catalog.pg_policies existing_policy
            where existing_policy.schemaname = 'public'
              and existing_policy.tablename = parent_table.relname
              and existing_policy.policyname = parent_table.relname || '_runtime_tenant_policy'
          )
        )
      )
  ) or exists (
    select 1
    from pg_catalog.pg_policies
    where schemaname = 'public'
      and tablename in ('property_channels', 'property_export_jobs')
      and policyname not in ('property_channels_runtime_tenant_policy', 'property_export_jobs_runtime_tenant_policy')
  ) then
    raise exception using
      errcode = '55000',
      message = '080 rollback refused because a later or pre-existing parent-table RLS cutover is present';
  end if;

  if event_table_oid is not null then
    execute 'select exists (select 1 from public.property_export_job_events limit 1)'
      into has_runtime_data;
    if has_runtime_data then
      raise exception using
        errcode = '55000',
        message = '080 rollback refused: property_export_job_events still contains lifecycle evidence';
    end if;
  end if;

  if exists (
    select 1 from pg_catalog.pg_attribute
    where attrelid = 'public.property_channels'::regclass
      and attname = 'runtime_key' and not attisdropped
  ) then
    execute 'select exists (select 1 from public.property_channels where runtime_key is not null limit 1)'
      into has_runtime_data;
    if has_runtime_data then
      raise exception using
        errcode = '55000',
      message = '080 rollback refused: property_channels contains 080 runtime keys';
    end if;
  end if;

  if exists (
    select 1
    from public.property_channels
    where status not in ('draft', 'ready', 'published', 'paused', 'error', 'needs_review')
    limit 1
  ) then
    raise exception using
      errcode = '55000',
      message = '080 rollback refused: property_channels contains expanded publication lifecycle states';
  end if;

  if exists (
    select 1 from pg_catalog.pg_attribute
    where attrelid = 'public.property_export_jobs'::regclass
      and attname = 'operation' and not attisdropped
  ) then
    execute $runtime_data$
      select exists (
        select 1
        from public.property_export_jobs
        where operation is not null
          or provider_key is not null
          or payload_snapshot is not null
          or payload_sha256 is not null
          or snapshot_captured_at is not null
          or artifact_payload is not null
          or artifact_sha256 is not null
          or artifact_content_type is not null
          or artifact_filename is not null
          or provider_request_id is not null
          or provider_acknowledged_at is not null
          or result_metadata <> '{}'::jsonb
        limit 1
      )
    $runtime_data$ into has_runtime_data;
    if has_runtime_data then
      raise exception using
        errcode = '55000',
        message = '080 rollback refused: property_export_jobs contains 080 runtime evidence';
    end if;
  end if;

  if event_table_oid is not null then
    select constraint_row.conrelid::regclass::text
      into dependent_object
    from pg_catalog.pg_constraint constraint_row
    where constraint_row.contype = 'f'
      and constraint_row.confrelid = event_table_oid
      and constraint_row.conrelid <> event_table_oid
    limit 1;
    if dependent_object is not null then
      raise exception using
        errcode = '2BP01',
        message = format('080 rollback refused: external relation %s depends on export events', dependent_object);
    end if;

    select format('public.property_export_job_events policy %I', policy_row.policyname)
      into dependent_object
    from pg_catalog.pg_policies policy_row
    where policy_row.schemaname = 'public'
      and policy_row.tablename = 'property_export_job_events'
      and policy_row.policyname !~ '^property_export_job_events_(novalure_app|novalure_tenant_app)_(select|insert)$'
    limit 1;
    if dependent_object is not null then
      raise exception using
        errcode = '2BP01',
        message = format('080 rollback refused: unexpected later policy %s exists', dependent_object);
    end if;

    select format('%s trigger %I', trigger_row.tgrelid::regclass, trigger_row.tgname)
      into dependent_object
    from pg_catalog.pg_trigger trigger_row
    where trigger_row.tgrelid = event_table_oid
      and not trigger_row.tgisinternal
    limit 1;
    if dependent_object is not null then
      raise exception using
        errcode = '2BP01',
        message = format('080 rollback refused: later trigger %s depends on export events', dependent_object);
    end if;

    select dependent_class.oid::regclass::text
      into dependent_object
    from pg_catalog.pg_depend dependency
    join pg_catalog.pg_rewrite rewrite_row
      on rewrite_row.oid = dependency.objid
     and dependency.classid = 'pg_catalog.pg_rewrite'::regclass
    join pg_catalog.pg_class dependent_class
      on dependent_class.oid = rewrite_row.ev_class
    where dependency.refclassid = 'pg_catalog.pg_class'::regclass
      and dependency.refobjid = event_table_oid
      and dependent_class.oid <> event_table_oid
      and dependent_class.relkind in ('v', 'm')
    limit 1;
    if dependent_object is not null then
      raise exception using
        errcode = '2BP01',
        message = format('080 rollback refused: view %s depends on export events', dependent_object);
    end if;
  end if;

  -- DROP COLUMN can remove column-owned objects implicitly. Refuse every
  -- dependency except the defaults, checks, indexes and policies owned by 080.
  select pg_catalog.pg_describe_object(
      dependency.classid,
      dependency.objid,
      dependency.objsubid
    )
    into dependent_object
  from pg_catalog.pg_depend dependency
  join pg_catalog.pg_attribute watched_column
    on watched_column.attrelid = dependency.refobjid
   and watched_column.attnum = dependency.refobjsubid
  where dependency.refclassid = 'pg_catalog.pg_class'::regclass
    and (
      (dependency.refobjid = 'public.property_channels'::regclass
        and watched_column.attname = 'runtime_key')
      or (dependency.refobjid = 'public.property_export_jobs'::regclass
        and watched_column.attname in (
          'operation', 'provider_key', 'payload_snapshot', 'payload_sha256',
          'snapshot_captured_at', 'artifact_payload', 'artifact_sha256',
          'artifact_content_type', 'artifact_filename', 'provider_request_id',
          'provider_acknowledged_at', 'result_metadata'
        ))
    )
    and not (
      dependency.classid = 'pg_catalog.pg_attrdef'::regclass
      or (
        dependency.classid = 'pg_catalog.pg_constraint'::regclass
        and exists (
          select 1 from pg_catalog.pg_constraint constraint_row
          where constraint_row.oid = dependency.objid
            and (
              constraint_row.conname in (
                'property_export_jobs_runtime_shape_check',
                'property_export_jobs_artifact_sha256_check',
                'property_export_jobs_payload_sha256_check'
              )
              or (
                constraint_row.contype = 'n'
                and watched_column.attname = 'result_metadata'
              )
            )
        )
      )
      or (
        dependency.classid = 'pg_catalog.pg_class'::regclass
        and exists (
          select 1 from pg_catalog.pg_class class_row
          where class_row.oid = dependency.objid
            and class_row.relname in (
              'property_channels_runtime_key_uidx',
              'property_export_jobs_provider_request_uidx'
            )
        )
      )
      or (
        dependency.classid = 'pg_catalog.pg_policy'::regclass
        and exists (
          select 1 from pg_catalog.pg_policy policy_row
          where policy_row.oid = dependency.objid
            and policy_row.polname in (
              'property_channels_runtime_tenant_policy',
              'property_export_jobs_runtime_tenant_policy'
            )
        )
      )
    )
  limit 1;
  if dependent_object is not null then
    raise exception using
      errcode = '2BP01',
      message = format('080 rollback refused: later object %s depends on runtime columns', dependent_object);
  end if;
end;
$rollback_guard$;

drop policy if exists property_channels_runtime_tenant_policy on public.property_channels;
drop policy if exists property_export_jobs_runtime_tenant_policy on public.property_export_jobs;
alter table if exists public.property_channels disable row level security;
alter table if exists public.property_export_jobs disable row level security;

alter table if exists public.property_channels
  drop constraint if exists property_channels_workspace_last_export_fk;
alter table if exists public.property_export_jobs
  drop constraint if exists property_export_jobs_workspace_starter_fk,
  drop constraint if exists property_export_jobs_workspace_unit_fk,
  drop constraint if exists property_export_jobs_workspace_property_fk,
  drop constraint if exists property_export_jobs_workspace_project_fk,
  drop constraint if exists property_export_jobs_workspace_channel_fk,
  drop constraint if exists property_export_jobs_runtime_shape_check,
  drop constraint if exists property_export_jobs_artifact_sha256_check,
  drop constraint if exists property_export_jobs_payload_sha256_check;
alter table if exists public.property_channels
  drop constraint if exists property_channels_workspace_unit_fk,
  drop constraint if exists property_channels_workspace_property_fk,
  drop constraint if exists property_channels_workspace_project_fk;

-- The session, evidence and dependency guards above must all pass before
-- Preview lifecycle evidence can be removed.
drop table if exists public.property_export_job_events;

drop index if exists public.property_export_jobs_property_history_idx;
drop index if exists public.property_export_jobs_provider_request_uidx;
drop index if exists public.property_export_jobs_workspace_id_id_uidx;
drop index if exists public.property_channels_workspace_id_id_uidx;
drop index if exists public.property_channels_runtime_key_uidx;

alter table if exists public.property_export_jobs
  drop column if exists result_metadata,
  drop column if exists provider_acknowledged_at,
  drop column if exists provider_request_id,
  drop column if exists artifact_filename,
  drop column if exists artifact_content_type,
  drop column if exists artifact_sha256,
  drop column if exists artifact_payload,
  drop column if exists snapshot_captured_at,
  drop column if exists payload_sha256,
  drop column if exists payload_snapshot,
  drop column if exists provider_key,
  drop column if exists operation;

alter table if exists public.property_channels
  drop column if exists runtime_key;

alter table if exists public.property_channels
  drop constraint if exists property_channels_status_check;
alter table if exists public.property_channels
  add constraint property_channels_status_check
  check (status in ('draft', 'ready', 'published', 'paused', 'error', 'needs_review'));

-- Keep this ledger cleanup as the final database action so any earlier failure
-- rolls back both the schema changes and the migration receipt.
do $rollback_ledger$
begin
  if to_regclass('public.novalure_schema_migrations') is not null then
    execute 'delete from public.novalure_schema_migrations where version = $1'
      using '080_property_export_runtime';
  end if;
end;
$rollback_ledger$;

commit;
