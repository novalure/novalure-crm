-- Manual contract cutover only. Apply after migration 060, after the
-- private-media application code is live and after the rollback window for the
-- legacy public-token route is closed. The metadata cleanup and cleartext-token
-- removal are intentionally not part of the reversible expand migration 051.
--
-- The migration runner executes this entire file in one transaction. Migration
-- 060 makes audit_logs append-only and migration 061 may additionally FORCE
-- RLS. The narrowly scoped audit scrub below therefore verifies table ownership
-- and the exact enabled append-only guard, temporarily relaxes only those two
-- protections, performs only the legacy media-field removal, restores the
-- original FORCE-RLS state and re-enables the guard, then verifies both states.
-- Any error aborts the DO block and the outer migration transaction restores
-- all DDL and DML, including the protection state.
do $migration$
begin
  if exists (
    select 1
    from media_assets asset
    where asset.is_public = true
      and asset.public_token is not null
      and btrim(asset.public_token) <> ''
      and not exists (
        select 1
        from media_asset_shares share
        where share.asset_id = asset.id
          and share.workspace_id = asset.workspace_id
          and share.token_hash = encode(digest(asset.public_token, 'sha256'), 'hex')
      )
  ) then
    raise exception 'media contract cutover refused: a legacy public token has no durable share';
  end if;
end;
$migration$;

do $migration$
declare
  audit_force_rls_before boolean;
  audit_owner_name text;
begin
  select relation.relforcerowsecurity, pg_get_userbyid(relation.relowner)
    into audit_force_rls_before, audit_owner_name
  from pg_catalog.pg_class relation
  where relation.oid = 'public.audit_logs'::regclass;

  if audit_owner_name is distinct from current_user then
    raise exception using
      errcode = '42501',
      message = 'media contract cutover requires the audit_logs table owner';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_trigger trigger_row
    where trigger_row.tgrelid = 'public.audit_logs'::regclass
      and trigger_row.tgname = 'audit_logs_append_only_guard'
      and not trigger_row.tgisinternal
      and trigger_row.tgenabled = 'O'
      and trigger_row.tgtype = 58
      and trigger_row.tgfoid = 'public.reject_audit_logs_mutation()'::regprocedure
  ) or not exists (
    select 1
    from pg_catalog.pg_proc function_row
    join pg_catalog.pg_language function_language on function_language.oid = function_row.prolang
    where function_row.oid = 'public.reject_audit_logs_mutation()'::regprocedure
      and function_language.lanname = 'plpgsql'
      and function_row.prokind = 'f'
      and function_row.prorettype = 'pg_catalog.trigger'::regtype
      and function_row.pronargs = 0
      and not function_row.prosecdef
      and not function_row.proleakproof
      and function_row.provolatile = 'v'
      and function_row.proparallel = 'u'
      and function_row.proconfig = array['search_path=pg_catalog, public, pg_temp']::text[]
      and regexp_replace(lower(function_row.prosrc), '[[:space:]]', '', 'g')
        = regexp_replace(lower($function_body$
            begin
              raise exception using
                errcode = '55000',
                message = 'audit_logs is append-only';
            end;
          $function_body$), '[[:space:]]', '', 'g')
  ) then
    raise exception using
      errcode = '55000',
      message = 'media contract cutover requires the exact enabled audit append-only guard from migration 060';
  end if;

  if audit_force_rls_before then
    alter table public.audit_logs no force row level security;
  end if;

  alter table public.audit_logs disable trigger audit_logs_append_only_guard;

  update public.audit_logs
  set after = jsonb_set(
    after,
    '{mediaAsset}',
    (after->'mediaAsset')
      - 'publicToken'
      - 'publicUrl'
      - 'relativePath'
      - 'url'
      - 'workspaceId',
    false
  )
  where action = 'bot.document_send.attach_media_asset'
    and jsonb_typeof(after->'mediaAsset') = 'object';

  alter table public.audit_logs enable trigger audit_logs_append_only_guard;

  if audit_force_rls_before then
    alter table public.audit_logs force row level security;
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_trigger trigger_row
    where trigger_row.tgrelid = 'public.audit_logs'::regclass
      and trigger_row.tgname = 'audit_logs_append_only_guard'
      and not trigger_row.tgisinternal
      and trigger_row.tgenabled = 'O'
      and trigger_row.tgtype = 58
      and trigger_row.tgfoid = 'public.reject_audit_logs_mutation()'::regprocedure
  ) or not exists (
    select 1
    from pg_catalog.pg_proc function_row
    join pg_catalog.pg_language function_language on function_language.oid = function_row.prolang
    where function_row.oid = 'public.reject_audit_logs_mutation()'::regprocedure
      and function_language.lanname = 'plpgsql'
      and function_row.prokind = 'f'
      and function_row.prorettype = 'pg_catalog.trigger'::regtype
      and function_row.pronargs = 0
      and not function_row.prosecdef
      and not function_row.proleakproof
      and function_row.provolatile = 'v'
      and function_row.proparallel = 'u'
      and function_row.proconfig = array['search_path=pg_catalog, public, pg_temp']::text[]
      and regexp_replace(lower(function_row.prosrc), '[[:space:]]', '', 'g')
        = regexp_replace(lower($function_body$
            begin
              raise exception using
                errcode = '55000',
                message = 'audit_logs is append-only';
            end;
          $function_body$), '[[:space:]]', '', 'g')
  ) or (
    select relation.relforcerowsecurity
    from pg_catalog.pg_class relation
    where relation.oid = 'public.audit_logs'::regclass
  ) is distinct from audit_force_rls_before then
    raise exception using
      errcode = '55000',
      message = 'media contract cutover failed to restore audit_logs protection state';
  end if;
end;
$migration$;

update media_assets
set url = '/api/media/files/' || id::text
where url is distinct from '/api/media/files/' || id::text;

alter table media_assets
  drop constraint if exists media_assets_internal_url_check;

alter table media_assets
  add constraint media_assets_internal_url_check
  check (url = '/api/media/files/' || id::text) not valid;

alter table media_assets
  validate constraint media_assets_internal_url_check;

update media_assets
set public_token = null
where public_token is not null;

alter table media_assets
  drop constraint if exists media_assets_public_token_cleartext_check;

alter table media_assets
  add constraint media_assets_public_token_cleartext_check
  check (public_token is null) not valid;

alter table media_assets
  validate constraint media_assets_public_token_cleartext_check;

update bot_document_sends
set metadata = metadata
  - 'asset'
  - 'attachedMediaAssetPublicUrl'
  - 'attachedMediaAssetUrl'
  - 'documentUrl'
where metadata ?| array[
  'asset',
  'attachedMediaAssetPublicUrl',
  'attachedMediaAssetUrl',
  'documentUrl'
];
