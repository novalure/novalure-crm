-- QA/PREVIEW-ONLY rollback companion for 082_content_library_privacy.sql.
--
-- This script refuses to run unless both session flags are explicitly set:
--   SET novalure.environment = 'preview';
--   SET novalure.allow_qa_schema_rollback = 'true';
-- It also refuses to erase content/privacy records or silently remove later
-- database dependencies. Clean the isolated QA tenant first.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '14min';
-- Never let an RLS-filtered scan look like an empty-table safety check.
set local row_security = off;

do $rollback_guard$
declare
  target_tables constant text[] := array[
    'crm_safe_mutation_requests',
    'crm_content_documents',
    'crm_content_document_versions',
    'crm_content_links',
    'crm_communication_templates',
    'crm_communication_template_versions',
    'privacy_retention_policies',
    'privacy_retention_reviews',
    'privacy_legal_holds',
    'privacy_data_subject_requests'
  ];
  target_oids oid[];
  table_name text;
  has_rows boolean;
  dependent_object text;
begin
  if current_setting('novalure.environment', true) is distinct from 'preview'
    or current_setting('novalure.allow_qa_schema_rollback', true) is distinct from 'true' then
    raise exception using
      errcode = '42501',
      message = '082 rollback is restricted to an explicitly authorized Preview session';
  end if;

  -- A rollback may only remove an empty feature slice. The dynamic lookup
  -- tolerates absent targets during preflight while still failing closed on
  -- permission/RLS errors.
  foreach table_name in array target_tables loop
    continue when to_regclass(format('public.%I', table_name)) is null;
    execute format(
      'select exists (select 1 from public.%I limit 1)',
      table_name
    ) into has_rows;
    if has_rows then
      raise exception using
        errcode = '55000',
        message = format('082 rollback refused: public.%I still contains tenant or release evidence', table_name);
    end if;
  end loop;

  select coalesce(array_agg(to_regclass(format('public.%I', candidate.table_name))::oid), array[]::oid[])
    into target_oids
  from unnest(target_tables) as candidate(table_name)
  where to_regclass(format('public.%I', candidate.table_name)) is not null;

  -- A foreign key from any table outside this slice is a later dependency.
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
      message = format('082 rollback refused: external relation %s depends on the content/privacy schema', dependent_object);
  end if;

  -- DROP TABLE would otherwise silently remove policies and triggers. Only
  -- the exact objects installed by 082 are accepted.
  select format('%I.%I policy %I', policy_row.schemaname, policy_row.tablename, policy_row.policyname)
    into dependent_object
  from pg_catalog.pg_policies policy_row
  where policy_row.schemaname = 'public'
    and policy_row.tablename = any(target_tables)
    and policy_row.policyname <> policy_row.tablename || '_tenant_policy'
  limit 1;
  if dependent_object is not null then
    raise exception using
      errcode = '2BP01',
      message = format('082 rollback refused: unexpected later policy %s exists', dependent_object);
  end if;

  select format('%s trigger %I', trigger_row.tgrelid::regclass, trigger_row.tgname)
    into dependent_object
  from pg_catalog.pg_trigger trigger_row
  where trigger_row.tgrelid = any(target_oids)
    and not trigger_row.tgisinternal
    and trigger_row.tgname not in (
      'crm_content_links_validate_target',
      'crm_content_document_versions_immutable_update',
      'crm_communication_template_versions_immutable_update',
      'privacy_retention_policies_guard_open_reviews',
      'privacy_retention_reviews_validate_state',
      'privacy_data_subject_requests_validate_state',
      'privacy_legal_holds_validate_window'
    )
  limit 1;
  if dependent_object is not null then
    raise exception using
      errcode = '2BP01',
      message = format('082 rollback refused: unexpected later trigger %s exists', dependent_object);
  end if;

  -- Views and materialized views are not acceptable implicit casualties.
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
      message = format('082 rollback refused: view %s depends on the content/privacy schema', dependent_object);
  end if;
end;
$rollback_guard$;

drop trigger if exists crm_content_links_validate_target on public.crm_content_links;
drop trigger if exists crm_content_document_versions_immutable_update on public.crm_content_document_versions;
drop trigger if exists crm_communication_template_versions_immutable_update on public.crm_communication_template_versions;
drop trigger if exists privacy_retention_policies_guard_open_reviews on public.privacy_retention_policies;
drop trigger if exists privacy_retention_reviews_validate_state on public.privacy_retention_reviews;
drop trigger if exists privacy_data_subject_requests_validate_state on public.privacy_data_subject_requests;
drop trigger if exists privacy_legal_holds_validate_window on public.privacy_legal_holds;

drop function if exists public.novalure_validate_content_link_target();
drop function if exists public.novalure_reject_immutable_content_version_update();
drop function if exists public.novalure_validate_privacy_policy_update();
drop function if exists public.novalure_validate_retention_review_state();
drop function if exists public.novalure_validate_dsar_state();
drop function if exists public.novalure_validate_legal_hold_window();

drop table if exists public.privacy_data_subject_requests;
drop table if exists public.privacy_legal_holds;
drop table if exists public.privacy_retention_reviews;
drop table if exists public.privacy_retention_policies;
drop table if exists public.crm_communication_template_versions;
drop table if exists public.crm_communication_templates;
drop table if exists public.crm_content_links;
drop table if exists public.crm_content_document_versions;
drop table if exists public.crm_content_documents;
drop table if exists public.crm_safe_mutation_requests;

-- Keep this ledger cleanup as the final database action so any earlier failure
-- rolls back both the schema changes and the migration receipt.
do $rollback_ledger$
begin
  if to_regclass('public.novalure_schema_migrations') is not null then
    execute 'delete from public.novalure_schema_migrations where version = $1'
      using '082_content_library_privacy';
  end if;
end;
$rollback_ledger$;

commit;
