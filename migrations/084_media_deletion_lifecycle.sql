-- Durable, retry-safe deletion state for the shared media source of truth.
-- The database records intent before an external Blob is removed. A failed
-- metadata finalization therefore remains visible/retryable instead of
-- presenting a broken active asset as successfully deleted.

alter table public.media_assets
  add column if not exists deletion_state text not null default 'active',
  add column if not exists deletion_requested_at timestamptz,
  add column if not exists deletion_requested_by_user_id uuid,
  add column if not exists created_by_user_id uuid;

do $$
begin
  if not exists (
    select 1
    from pg_catalog.pg_constraint
    where conrelid = 'public.media_assets'::regclass
      and conname = 'media_assets_deletion_state_check'
  ) then
    alter table public.media_assets
      add constraint media_assets_deletion_state_check
      check (
        (deletion_state = 'active' and deletion_requested_at is null and deletion_requested_by_user_id is null)
        or
        (deletion_state = 'pending' and deletion_requested_at is not null and deletion_requested_by_user_id is not null)
      );
  end if;

end $$;

-- Existing deployments may contain the table-local constraint as NOT VALID.
-- Make its enforcement state explicit and ledger-bound before any lifecycle
-- trigger or application path can rely on it.
alter table public.media_assets
  validate constraint media_assets_deletion_state_check;

create index if not exists media_assets_pending_deletion_idx
  on public.media_assets(workspace_id, deletion_requested_at, id)
  where deletion_state = 'pending';

create or replace function public.novalure_require_media_deletion_actor()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'UPDATE' then
    if old.created_by_user_id is not null
      and new.created_by_user_id is distinct from old.created_by_user_id then
      raise exception 'Media asset creator attribution is immutable once established'
        using errcode = '23514';
    end if;
  end if;

  if new.created_by_user_id is not null and not exists (
    select 1
    from public.workspace_users creator
    where creator.id = new.created_by_user_id
      and creator.workspace_id::text = new.workspace_id
  ) then
    raise exception 'Media creator must be a tenant-qualified workspace actor'
      using errcode = '23514';
  end if;

  if new.deletion_state = 'pending' and not exists (
    select 1
    from public.workspace_users actor
    where actor.id = new.deletion_requested_by_user_id
      and actor.workspace_id::text = new.workspace_id
  ) then
    raise exception 'Pending media deletion requires a tenant-qualified workspace actor'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

drop trigger if exists media_assets_deletion_actor on public.media_assets;
create trigger media_assets_deletion_actor
before insert or update of created_by_user_id, deletion_state, deletion_requested_by_user_id, workspace_id
on public.media_assets
for each row execute function public.novalure_require_media_deletion_actor();

create or replace function public.novalure_require_active_content_media()
returns trigger
language plpgsql
as $$
begin
  if new.media_asset_id is null then
    return new;
  end if;

  -- Serialize a new reference against active -> pending deletion. The row lock
  -- is held until the referencing statement commits, so the deleter either
  -- observes this reference or the insert rechecks the now-pending asset.
  perform 1
    from public.media_assets asset
   where asset.id = new.media_asset_id
     and asset.workspace_id = new.workspace_id::text
     and asset.deletion_state = 'active'
   for share;
  if not found then
    raise exception 'Content versions require an active tenant-qualified media asset'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists crm_content_document_versions_active_media on public.crm_content_document_versions;
create trigger crm_content_document_versions_active_media
before insert or update of media_asset_id, workspace_id
on public.crm_content_document_versions
for each row execute function public.novalure_require_active_content_media();

drop trigger if exists property_media_active_media on public.property_media;
create trigger property_media_active_media
before insert or update of media_asset_id, workspace_id
on public.property_media
for each row execute function public.novalure_require_active_content_media();

drop trigger if exists property_documents_active_media on public.property_documents;
create trigger property_documents_active_media
before insert or update of media_asset_id, workspace_id
on public.property_documents
for each row execute function public.novalure_require_active_content_media();

drop trigger if exists bot_document_sends_active_media on public.bot_document_sends;
create trigger bot_document_sends_active_media
before insert or update of media_asset_id, workspace_id
on public.bot_document_sends
for each row execute function public.novalure_require_active_content_media();

comment on column public.media_assets.deletion_state is
  'active or pending. pending is durable deletion intent and is excluded from every read/publication path.';

comment on column public.media_assets.created_by_user_id is
  'Immutable tenant-qualified creator. Legacy NULL rows remain manager-only until deliberately reconciled.';
