-- Standalone ST1 Production handoff on the existing 096 gateway.
-- No calendar/booking schema and no invented 097/098/099 execution evidence.
set local lock_timeout = '5s';
set local statement_timeout = '14min';
do $verify$
begin
  if not exists(select 1 from public.novalure_schema_migrations where version='096_public_integration_gateway') then
    raise exception 'Migration 096 must precede standalone Studio public enquiry launch';
  end if;
  if exists(select 1 from public.novalure_schema_migrations where version in ('097_studio_sales_calendar_bridge','098_studio_enquiry_handoff','099_studio_enquiry_public_launch'))
     or to_regclass('public.studio_enquiry_transfers') is not null
     or to_regclass('public.studio_enquiry_assets') is not null then
    raise exception 'Standalone Production migration must not run over the existing Preview handoff path';
  end if;
end;
$verify$;
create unique index if not exists form_submissions_workspace_id_uidx
  on public.form_submissions(workspace_id,id);

create table public.studio_enquiry_transfers (
  operation_id uuid primary key,
  workspace_id uuid not null references public.workspaces(id)
    check(workspace_id='8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101'::uuid),
  revision integer not null check(revision>0),
  payload_hash text not null check(payload_hash ~ '^[a-f0-9]{64}$'),
  snapshot_text text not null check(octet_length(snapshot_text)<=256000),
  targets jsonb not null check(jsonb_typeof(targets)='array' and jsonb_array_length(targets)<=6),
  state text not null default 'reserved' check(state in ('reserved','accepted')),
  reference text not null unique check(reference ~ '^NL-[A-F0-9]{8}$'),
  lead_id uuid,
  submission_id uuid,
  created_at timestamptz not null default now(),
  accepted_at timestamptz,
  unique(operation_id,workspace_id),
  foreign key(workspace_id,lead_id) references public.leads(workspace_id,id),
  foreign key(workspace_id,submission_id) references public.form_submissions(workspace_id,id),
  check(encode(digest(snapshot_text,'sha256'),'hex')=payload_hash),
  check((snapshot_text::jsonb)->>'schemaVersion'='studio-enquiry-snapshot-v1'),
  constraint studio_enquiry_snapshot_synthetic_marker_boolean check (
    snapshot_text::jsonb ? 'syntheticTest' and jsonb_typeof(snapshot_text::jsonb->'syntheticTest')='boolean'
  ),
  check((state='reserved' and lead_id is null and submission_id is null and accepted_at is null)
    or (state='accepted' and lead_id is not null and submission_id is not null and accepted_at is not null))
);
-- The immutable row marker makes protection independent of SECURITY DEFINER
-- ownership and FORCE RLS reference visibility. Existing ordinary assets stay NULL.
alter table public.media_assets
  add column studio_enquiry_operation_id uuid,
  add constraint media_assets_studio_enquiry_operation_fk
    foreign key(studio_enquiry_operation_id) references public.studio_enquiry_transfers(operation_id),
  add constraint media_assets_studio_enquiry_private_check check (
    studio_enquiry_operation_id is null or (
      workspace_id='8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101'
      and storage_provider is not distinct from 'vercel-blob'
      and storage_access is not distinct from 'private'
      and is_public is false and public_token is null
    )
  ),
  add constraint media_assets_studio_enquiry_identity_key
    unique(id,workspace_id,studio_enquiry_operation_id);

create table public.studio_enquiry_assets (
  operation_id uuid not null,
  workspace_id text not null check(workspace_id='8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101'),
  workspace_uuid uuid generated always as (workspace_id::uuid) stored,
  source_id uuid not null,
  variant text not null check(variant in ('original','analysis')),
  media_asset_id uuid not null,
  sha256 text not null check(sha256 ~ '^[a-f0-9]{64}$'),
  original_sha256 text not null check(original_sha256 ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default now(),
  primary key(operation_id,source_id,variant),
  foreign key(operation_id,workspace_uuid) references public.studio_enquiry_transfers(operation_id,workspace_id),
  foreign key(media_asset_id,workspace_id,operation_id)
    references public.media_assets(id,workspace_id,studio_enquiry_operation_id)
);

create function public.studio_enquiry_immutable_confirmation() returns trigger
language plpgsql set search_path=pg_catalog,public as $fn$
begin
  if old.state='accepted' or new.operation_id<>old.operation_id or new.workspace_id<>old.workspace_id
    or new.revision<>old.revision or new.payload_hash<>old.payload_hash or new.snapshot_text<>old.snapshot_text
    or new.targets<>old.targets or new.reference<>old.reference or new.created_at<>old.created_at
    or new.state<>'accepted' then
    raise exception 'Studio confirmation is immutable';
  end if;
  return new;
end;
$fn$;
create trigger studio_enquiry_immutable before update on public.studio_enquiry_transfers
  for each row execute function public.studio_enquiry_immutable_confirmation();
revoke all on function public.studio_enquiry_immutable_confirmation() from public;

alter table public.studio_enquiry_transfers enable row level security;
alter table public.studio_enquiry_transfers force row level security;
alter table public.studio_enquiry_assets enable row level security;
alter table public.studio_enquiry_assets force row level security;
create policy studio_enquiry_transfer_actor on public.studio_enquiry_transfers
  for all to novalure_tenant_app
  using(workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid
    and workspace_id='8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101'::uuid
    and current_setting('app.actor_id',true)='6122a6da-e7f4-47fa-bc55-e296bb01af62'
    and exists(select 1 from public.workspace_users a where a.id='6122a6da-e7f4-47fa-bc55-e296bb01af62'::uuid
      and a.workspace_id=studio_enquiry_transfers.workspace_id and a.status='active' and a.role='agent' and a.product_role='novalure_operator'))
  with check(workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid
    and workspace_id='8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101'::uuid
    and current_setting('app.actor_id',true)='6122a6da-e7f4-47fa-bc55-e296bb01af62'
    and exists(select 1 from public.workspace_users a where a.id='6122a6da-e7f4-47fa-bc55-e296bb01af62'::uuid
      and a.workspace_id=studio_enquiry_transfers.workspace_id and a.status='active' and a.role='agent' and a.product_role='novalure_operator'));
create policy studio_enquiry_asset_actor on public.studio_enquiry_assets
  for all to novalure_tenant_app
  using(workspace_id=current_setting('app.tenant_id',true)
    and workspace_id='8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101'
    and current_setting('app.actor_id',true)='6122a6da-e7f4-47fa-bc55-e296bb01af62'
    and exists(select 1 from public.workspace_users a where a.id='6122a6da-e7f4-47fa-bc55-e296bb01af62'::uuid
      and a.workspace_id=studio_enquiry_assets.workspace_uuid and a.status='active' and a.role='agent' and a.product_role='novalure_operator'))
  with check(workspace_id=current_setting('app.tenant_id',true)
    and workspace_id='8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101'
    and current_setting('app.actor_id',true)='6122a6da-e7f4-47fa-bc55-e296bb01af62'
    and exists(select 1 from public.workspace_users a where a.id='6122a6da-e7f4-47fa-bc55-e296bb01af62'::uuid
      and a.workspace_id=studio_enquiry_assets.workspace_uuid and a.status='active' and a.role='agent' and a.product_role='novalure_operator'));
revoke all on public.studio_enquiry_transfers,public.studio_enquiry_assets from public,novalure_app,novalure_tenant_app;
grant select,insert,update on public.studio_enquiry_transfers to novalure_tenant_app;
grant select,insert on public.studio_enquiry_assets to novalure_tenant_app;

-- Ordinary media publication or path edits must not change a confirmed source.
-- The OLD-row marker does not query an RLS-filtered reference table. Markers
-- are insert-only; an ordinary media update cannot add, remove or redirect one.
create function public.studio_enquiry_protect_asset() returns trigger
language plpgsql security definer set search_path=pg_catalog,public as $fn$
begin
  if new.studio_enquiry_operation_id is distinct from old.studio_enquiry_operation_id then
    raise exception 'Studio handoff asset marker is immutable';
  end if;
  if old.studio_enquiry_operation_id is not null
    and (new.id is distinct from old.id or new.workspace_id is distinct from old.workspace_id
      or new.relative_path is distinct from old.relative_path
      or new.storage_provider is distinct from old.storage_provider or new.storage_access is distinct from old.storage_access
      or new.mime_type is distinct from old.mime_type or new.size_bytes is distinct from old.size_bytes
      or new.url is distinct from old.url or new.original_name is distinct from old.original_name
      or new.is_public is distinct from false or new.public_token is not null) then
    raise exception 'Studio handoff asset must remain private and immutable';
  end if;
  return new;
end;
$fn$;
create trigger studio_enquiry_protect_asset before update on public.media_assets
  for each row execute function public.studio_enquiry_protect_asset();
revoke all on function public.studio_enquiry_protect_asset() from public;

-- Preserve the existing four-column crm_media_reference_counts(uuid) unchanged.
-- This Studio-specific counter is additive and preserves fail-closed reference visibility. The new FK must block deletion of
-- a file used by an accepted enquiry, including when its owner cannot read that enquiry.
create function public.crm_studio_media_reference_counts(p_asset uuid)
returns table(media_count integer,document_count integer,send_count integer,share_count integer,studio_count integer)
language sql stable security definer set search_path=pg_catalog,public as $fn$
  select
    case when row_security_active('public.property_media'::regclass) then -1
      else (select count(*)::integer from public.property_media where media_asset_id=p_asset) end,
    case when row_security_active('public.property_documents'::regclass) then -1
      else (select count(*)::integer from public.property_documents where media_asset_id=p_asset) end,
    case when row_security_active('public.bot_document_sends'::regclass) then -1
      else (select count(*)::integer from public.bot_document_sends where media_asset_id=p_asset) end,
    case when row_security_active('public.media_asset_shares'::regclass) then -1
      else (select count(*)::integer from public.media_asset_shares where asset_id=p_asset) end,
    -- This is an in-use indicator, not a potentially RLS-filtered link count.
    case when asset.studio_enquiry_operation_id is not null then 1 else 0 end
  from public.media_assets asset
  where asset.id=p_asset and asset.workspace_id=nullif(current_setting('app.tenant_id',true),'')
    and exists(select 1 from public.workspace_users a where a.workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid
      and a.id=nullif(current_setting('app.actor_id',true),'')::uuid and a.status='active' and a.role in ('owner','admin','agent'))
    -- A marked row is already protected. An unmarked row needs complete
    -- visibility of every other supported reference before reporting zero.
    and (asset.studio_enquiry_operation_id is not null or (
      not row_security_active('public.property_media'::regclass)
      and not row_security_active('public.property_documents'::regclass)
      and not row_security_active('public.bot_document_sends'::regclass)
      and not row_security_active('public.media_asset_shares'::regclass)
    ))
$fn$;
revoke all on function public.crm_studio_media_reference_counts(uuid) from public;
grant execute on function public.crm_studio_media_reference_counts(uuid) to novalure_tenant_app;
