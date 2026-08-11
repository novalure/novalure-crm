alter table media_assets
  add column if not exists storage_access text;

update media_assets
set storage_access = case
  when storage_provider = 'vercel-blob' and is_public = true then 'published-public'
  when storage_provider = 'vercel-blob' then 'legacy-public'
  else 'private'
end
where storage_access is null;

alter table media_assets
  alter column storage_access set default 'private';

alter table media_assets
  alter column storage_access set not null;

alter table media_assets
  drop constraint if exists media_assets_storage_access_check;

alter table media_assets
  add constraint media_assets_storage_access_check
  check (storage_access in ('private', 'legacy-public', 'published-public')) not valid;

alter table media_assets
  validate constraint media_assets_storage_access_check;

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

create unique index if not exists media_assets_id_workspace_uidx
  on media_assets(id, workspace_id);

create table if not exists media_asset_shares (
  id uuid primary key default gen_random_uuid(),
  asset_id uuid not null,
  workspace_id text not null,
  token_hash text not null,
  scope text not null default 'public-download',
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  constraint media_asset_shares_asset_workspace_fk
    foreign key (asset_id, workspace_id)
    references media_assets(id, workspace_id)
    on delete cascade,
  constraint media_asset_shares_token_hash_check
    check (token_hash ~ '^[0-9a-f]{64}$'),
  constraint media_asset_shares_scope_check
    check (scope = 'public-download'),
  constraint media_asset_shares_expiry_check
    check (expires_at > created_at)
);

create unique index if not exists media_asset_shares_token_hash_uidx
  on media_asset_shares(token_hash);

create index if not exists media_asset_shares_asset_active_idx
  on media_asset_shares(asset_id, workspace_id, expires_at desc)
  where revoked_at is null;

insert into media_asset_shares (
  asset_id,
  workspace_id,
  token_hash,
  scope,
  expires_at
)
select
  id,
  workspace_id,
  encode(digest(public_token, 'sha256'), 'hex'),
  'public-download',
  now() + interval '365 days'
from media_assets
where is_public = true
  and public_token is not null
  and btrim(public_token) <> ''
on conflict (token_hash) do nothing;

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

update audit_logs
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
