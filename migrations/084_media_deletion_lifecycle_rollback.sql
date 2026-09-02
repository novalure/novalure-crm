-- QA/PREVIEW-ONLY rollback companion for 084_media_deletion_lifecycle.sql.
--
-- This script refuses to run unless both session flags are explicitly set:
--   SET novalure.environment = 'preview';
--   SET novalure.allow_qa_schema_rollback = 'true';
-- Pending external Blob work must be reconciled before the durable intent can
-- be removed.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '14min';
-- Never let an RLS-filtered scan look like an empty-table safety check.
set local row_security = off;

do $rollback_guard$
declare
  active_media_function oid := to_regprocedure('public.novalure_require_active_content_media()')::oid;
  deletion_actor_function oid := to_regprocedure('public.novalure_require_media_deletion_actor()')::oid;
  dependent_object text;
  has_pending_rows boolean;
  has_creator_evidence boolean;
begin
  if current_setting('novalure.environment', true) is distinct from 'preview'
    or current_setting('novalure.allow_qa_schema_rollback', true) is distinct from 'true' then
    raise exception using
      errcode = '42501',
      message = '084 rollback is restricted to an explicitly authorized Preview session';
  end if;

  if exists (
    select 1
    from pg_catalog.pg_attribute
    where attrelid = 'public.media_assets'::regclass
      and attname = 'created_by_user_id'
      and not attisdropped
  ) then
    execute $creator_rows$
      select exists (
        select 1
        from public.media_assets
        where created_by_user_id is not null
        limit 1
      )
    $creator_rows$ into has_creator_evidence;
    if has_creator_evidence then
      raise exception using
        errcode = '55000',
        message = '084 rollback refused: media creator attribution requires reconciliation';
    end if;
  end if;

  if exists (
    select 1
    from pg_catalog.pg_attribute
    where attrelid = 'public.media_assets'::regclass
      and attname = 'deletion_state'
      and not attisdropped
  ) then
    execute $pending_rows$
      select exists (
        select 1
        from public.media_assets
        where deletion_state = 'pending'
          or deletion_state is distinct from 'active'
          or deletion_requested_at is not null
          or deletion_requested_by_user_id is not null
        limit 1
      )
    $pending_rows$ into has_pending_rows;
    if has_pending_rows then
      raise exception using
        errcode = '55000',
        message = '084 rollback refused: pending or non-canonical media deletion evidence requires reconciliation';
    end if;
  end if;

  -- A trigger installed under an 084-owned name must still be the exact
  -- trigger/function pair that this rollback knows how to remove.
  select format('%s trigger %I', trigger_row.tgrelid::regclass, trigger_row.tgname)
    into dependent_object
  from (values
    ('crm_content_document_versions_active_media', to_regclass('public.crm_content_document_versions')),
    ('property_media_active_media', to_regclass('public.property_media')),
    ('property_documents_active_media', to_regclass('public.property_documents')),
    ('bot_document_sends_active_media', to_regclass('public.bot_document_sends'))
  ) as expected(trigger_name, relation_oid)
  join pg_catalog.pg_trigger trigger_row
    on trigger_row.tgrelid = expected.relation_oid
   and trigger_row.tgname = expected.trigger_name
  where trigger_row.tgfoid is distinct from active_media_function
  limit 1;
  if dependent_object is not null then
    raise exception using
      errcode = '2BP01',
      message = format('084 rollback refused: owned trigger %s was replaced by a later migration', dependent_object);
  end if;

  select format('%s trigger %I', trigger_row.tgrelid::regclass, trigger_row.tgname)
    into dependent_object
  from pg_catalog.pg_trigger trigger_row
  where trigger_row.tgrelid = to_regclass('public.media_assets')
    and trigger_row.tgname = 'media_assets_deletion_actor'
    and trigger_row.tgfoid is distinct from deletion_actor_function
  limit 1;
  if dependent_object is not null then
    raise exception using
      errcode = '2BP01',
      message = format('084 rollback refused: owned trigger %s was replaced by a later migration', dependent_object);
  end if;

  -- Do not silently orphan a later trigger that reused the 084 function.
  select format('%s trigger %I', trigger_row.tgrelid::regclass, trigger_row.tgname)
    into dependent_object
  from pg_catalog.pg_trigger trigger_row
  where active_media_function is not null
    and trigger_row.tgfoid = active_media_function
    and not trigger_row.tgisinternal
    and not (
      (trigger_row.tgname = 'crm_content_document_versions_active_media'
        and trigger_row.tgrelid = to_regclass('public.crm_content_document_versions'))
      or (trigger_row.tgname = 'property_media_active_media'
        and trigger_row.tgrelid = to_regclass('public.property_media'))
      or (trigger_row.tgname = 'property_documents_active_media'
        and trigger_row.tgrelid = to_regclass('public.property_documents'))
      or (trigger_row.tgname = 'bot_document_sends_active_media'
        and trigger_row.tgrelid = to_regclass('public.bot_document_sends'))
    )
  limit 1;
  if dependent_object is not null then
    raise exception using
      errcode = '2BP01',
      message = format('084 rollback refused: later trigger %s depends on the active-media function', dependent_object);
  end if;

  select format('%s trigger %I', trigger_row.tgrelid::regclass, trigger_row.tgname)
    into dependent_object
  from pg_catalog.pg_trigger trigger_row
  where deletion_actor_function is not null
    and trigger_row.tgfoid = deletion_actor_function
    and not trigger_row.tgisinternal
    and not (
      trigger_row.tgname = 'media_assets_deletion_actor'
      and trigger_row.tgrelid = to_regclass('public.media_assets')
    )
  limit 1;
  if dependent_object is not null then
    raise exception using
      errcode = '2BP01',
      message = format('084 rollback refused: later trigger %s depends on the deletion-actor function', dependent_object);
  end if;

  -- DROP COLUMN automatically removes column-owned indexes/constraints. Make
  -- that implicit behavior fail closed for every dependency not installed by
  -- 084 (column defaults are intrinsic and safe to remove).
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
    and dependency.refobjid = 'public.media_assets'::regclass
    and watched_column.attname in (
      'deletion_state',
      'deletion_requested_at',
      'deletion_requested_by_user_id',
      'created_by_user_id'
    )
    and not (
      dependency.classid = 'pg_catalog.pg_attrdef'::regclass
      or (
        dependency.classid = 'pg_catalog.pg_constraint'::regclass
        and exists (
          select 1
          from pg_catalog.pg_constraint constraint_row
          where constraint_row.oid = dependency.objid
            and (
              constraint_row.conname = 'media_assets_deletion_state_check'
              or (
                constraint_row.contype = 'n'
                and watched_column.attname = 'deletion_state'
              )
            )
        )
      )
      or (
        dependency.classid = 'pg_catalog.pg_class'::regclass
        and exists (
          select 1
          from pg_catalog.pg_class class_row
          where class_row.oid = dependency.objid
            and class_row.relname = 'media_assets_pending_deletion_idx'
        )
      )
    )
  limit 1;
  if dependent_object is not null then
    raise exception using
      errcode = '2BP01',
      message = format('084 rollback refused: later object %s depends on deletion lifecycle columns', dependent_object);
  end if;
end;
$rollback_guard$;

drop trigger if exists crm_content_document_versions_active_media on public.crm_content_document_versions;
drop trigger if exists property_media_active_media on public.property_media;
drop trigger if exists property_documents_active_media on public.property_documents;
drop trigger if exists bot_document_sends_active_media on public.bot_document_sends;
drop function if exists public.novalure_require_active_content_media();
drop trigger if exists media_assets_deletion_actor on public.media_assets;
drop function if exists public.novalure_require_media_deletion_actor();
drop index if exists public.media_assets_pending_deletion_idx;

alter table public.media_assets
  drop constraint if exists media_assets_deletion_state_check,
  drop column if exists deletion_requested_by_user_id,
  drop column if exists deletion_requested_at,
  drop column if exists deletion_state,
  drop column if exists created_by_user_id;

-- Keep this ledger cleanup as the final database action so any earlier failure
-- rolls back both the schema changes and the migration receipt.
do $rollback_ledger$
begin
  if to_regclass('public.novalure_schema_migrations') is not null then
    execute 'delete from public.novalure_schema_migrations where version = $1'
      using '084_media_deletion_lifecycle';
  end if;
end;
$rollback_ledger$;

commit;
