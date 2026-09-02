-- QA/PREVIEW-ONLY rollback companion for 083_list_productivity_controls.sql.
--
-- This script refuses to run unless both session flags are explicitly set:
--   SET novalure.environment = 'preview';
--   SET novalure.allow_qa_schema_rollback = 'true';
-- It refuses to erase saved views, recents, item evidence or actor-bound bulk
-- executions. Clean the isolated QA tenant first.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '14min';
-- Never let an RLS-filtered scan look like an empty-table safety check.
set local row_security = off;

do $rollback_guard$
declare
  target_tables constant text[] := array[
    'crm_saved_views',
    'crm_recent_records',
    'crm_bulk_runtime_batch_items'
  ];
  target_oids oid[];
  table_name text;
  has_runtime_data boolean;
  dependent_object text;
begin
  if current_setting('novalure.environment', true) is distinct from 'preview'
    or current_setting('novalure.allow_qa_schema_rollback', true) is distinct from 'true' then
    raise exception using
      errcode = '42501',
      message = '083 rollback is restricted to an explicitly authorized Preview session';
  end if;

  if exists (
    select 1
    from pg_catalog.pg_class batch_table
    where batch_table.oid = 'public.crm_bulk_runtime_batches'::regclass
      and (
        batch_table.relforcerowsecurity
        or (
          batch_table.relrowsecurity
          and not exists (
            select 1
            from pg_catalog.pg_policies existing_policy
            where existing_policy.schemaname = 'public'
              and existing_policy.tablename = 'crm_bulk_runtime_batches'
              and existing_policy.policyname = 'crm_bulk_runtime_batches_runtime_policy'
          )
        )
      )
  ) or exists (
    select 1
    from pg_catalog.pg_policies
    where schemaname = 'public'
      and tablename = 'crm_bulk_runtime_batches'
      and policyname <> 'crm_bulk_runtime_batches_runtime_policy'
  ) then
    raise exception using
      errcode = '55000',
      message = '083 rollback refused because a later or pre-existing batch-ledger RLS cutover is present';
  end if;

  foreach table_name in array target_tables loop
    continue when to_regclass(format('public.%I', table_name)) is null;
    execute format(
      'select exists (select 1 from public.%I limit 1)',
      table_name
    ) into has_runtime_data;
    if has_runtime_data then
      raise exception using
        errcode = '55000',
        message = format('083 rollback refused: public.%I still contains list-productivity evidence', table_name);
    end if;
  end loop;

  if exists (
    select 1 from pg_catalog.pg_attribute
    where attrelid = 'public.crm_bulk_runtime_batches'::regclass
      and attname = 'actor_user_id' and not attisdropped
  ) then
    execute $runtime_data$
      select exists (
        select 1
        from public.crm_bulk_runtime_batches
        where actor_user_id is not null
          or idempotency_key is not null
          or request_sha256 is not null
          or status <> 'completed'
          or selection_ids <> '[]'::jsonb
          or payload <> '{}'::jsonb
          or completed_at is not null
          or error is not null
        limit 1
      )
    $runtime_data$ into has_runtime_data;
    if has_runtime_data then
      raise exception using
        errcode = '55000',
        message = '083 rollback refused: crm_bulk_runtime_batches contains actor-bound or non-legacy evidence';
    end if;
  end if;

  select coalesce(array_agg(to_regclass(format('public.%I', candidate.table_name))::oid), array[]::oid[])
    into target_oids
  from unnest(target_tables) as candidate(table_name)
  where to_regclass(format('public.%I', candidate.table_name)) is not null;

  select constraint_row.conrelid::regclass::text
    into dependent_object
  from pg_catalog.pg_constraint constraint_row
  where constraint_row.contype = 'f'
    and constraint_row.confrelid = any(target_oids)
    and not (constraint_row.conrelid = any(target_oids))
  limit 1;
  if dependent_object is not null then
    raise exception using
      errcode = '2BP01',
      message = format('083 rollback refused: external relation %s depends on list-productivity tables', dependent_object);
  end if;

  select format('%I.%I policy %I', policy_row.schemaname, policy_row.tablename, policy_row.policyname)
    into dependent_object
  from pg_catalog.pg_policies policy_row
  where policy_row.schemaname = 'public'
    and policy_row.tablename = any(target_tables)
    and not (
      (policy_row.tablename = 'crm_saved_views'
        and policy_row.policyname in (
          'crm_saved_views_select_policy',
          'crm_saved_views_insert_policy',
          'crm_saved_views_update_policy'
        ))
      or (policy_row.tablename = 'crm_recent_records'
        and policy_row.policyname = 'crm_recent_records_actor_policy')
      or (policy_row.tablename = 'crm_bulk_runtime_batch_items'
        and policy_row.policyname = 'crm_bulk_runtime_batch_items_tenant_policy')
    )
  limit 1;
  if dependent_object is not null then
    raise exception using
      errcode = '2BP01',
      message = format('083 rollback refused: unexpected later policy %s exists', dependent_object);
  end if;

  select format('%s trigger %I', trigger_row.tgrelid::regclass, trigger_row.tgname)
    into dependent_object
  from pg_catalog.pg_trigger trigger_row
  where trigger_row.tgrelid = any(target_oids)
    and not trigger_row.tgisinternal
  limit 1;
  if dependent_object is not null then
    raise exception using
      errcode = '2BP01',
      message = format('083 rollback refused: later trigger %s depends on list-productivity tables', dependent_object);
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
    and dependency.refobjid = any(target_oids)
    and not (dependent_class.oid = any(target_oids))
    and dependent_class.relkind in ('v', 'm')
  limit 1;
  if dependent_object is not null then
    raise exception using
      errcode = '2BP01',
      message = format('083 rollback refused: view %s depends on list-productivity tables', dependent_object);
  end if;

  -- The legacy batch ledger remains, so refuse implicit loss of any later
  -- object attached to the columns added by 083.
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
    and dependency.refobjid = 'public.crm_bulk_runtime_batches'::regclass
    and watched_column.attname in (
      'actor_user_id', 'idempotency_key', 'request_sha256', 'status',
      'selection_ids', 'payload', 'completed_at', 'error', 'updated_at'
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
                'crm_bulk_runtime_batches_workspace_actor_fk',
                'crm_bulk_runtime_batches_status_check',
                'crm_bulk_runtime_batches_request_sha256_check',
                'crm_bulk_runtime_batches_idempotency_shape_check'
              )
              or (
                constraint_row.contype = 'n'
                and watched_column.attname in ('status', 'selection_ids', 'payload', 'updated_at')
              )
            )
        )
      )
      or (
        dependency.classid = 'pg_catalog.pg_class'::regclass
        and exists (
          select 1 from pg_catalog.pg_class class_row
          where class_row.oid = dependency.objid
            and class_row.relname = 'crm_bulk_runtime_batches_idempotency_uidx'
        )
      )
      or (
        dependency.classid = 'pg_catalog.pg_policy'::regclass
        and exists (
          select 1 from pg_catalog.pg_policy policy_row
          where policy_row.oid = dependency.objid
            and policy_row.polname = 'crm_bulk_runtime_batches_runtime_policy'
        )
      )
    )
  limit 1;
  if dependent_object is not null then
    raise exception using
      errcode = '2BP01',
      message = format('083 rollback refused: later object %s depends on list-productivity batch columns', dependent_object);
  end if;
end;
$rollback_guard$;

drop table if exists public.crm_bulk_runtime_batch_items;

drop policy if exists crm_bulk_runtime_batches_runtime_policy on public.crm_bulk_runtime_batches;
alter table if exists public.crm_bulk_runtime_batches disable row level security;
drop index if exists public.crm_bulk_runtime_batches_idempotency_uidx;
drop index if exists public.crm_bulk_runtime_batches_workspace_id_uidx;
alter table if exists public.crm_bulk_runtime_batches
  drop constraint if exists crm_bulk_runtime_batches_workspace_actor_fk,
  drop constraint if exists crm_bulk_runtime_batches_status_check,
  drop constraint if exists crm_bulk_runtime_batches_request_sha256_check,
  drop constraint if exists crm_bulk_runtime_batches_idempotency_shape_check,
  drop column if exists actor_user_id,
  drop column if exists idempotency_key,
  drop column if exists request_sha256,
  drop column if exists status,
  drop column if exists selection_ids,
  drop column if exists payload,
  drop column if exists completed_at,
  drop column if exists error,
  drop column if exists updated_at;

drop table if exists public.crm_recent_records;
drop table if exists public.crm_saved_views;

-- seller_listings.metadata is retained deliberately. It may contain data from
-- other features and must never be removed by a list-productivity rollback.

-- Keep this ledger cleanup as the final database action so any earlier failure
-- rolls back both the schema changes and the migration receipt.
do $rollback_ledger$
begin
  if to_regclass('public.novalure_schema_migrations') is not null then
    execute 'delete from public.novalure_schema_migrations where version = $1'
      using '083_list_productivity_controls';
  end if;
end;
$rollback_ledger$;

commit;
