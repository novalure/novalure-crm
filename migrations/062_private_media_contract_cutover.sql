-- Manual contract cutover only. Apply after the private-media application code
-- is live and the rollback window for the legacy public-token route is closed.
-- The metadata cleanup and cleartext-token removal are intentionally not part
-- of the reversible expand migration 051.
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
