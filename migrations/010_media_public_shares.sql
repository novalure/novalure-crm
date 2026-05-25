alter table media_assets
  add column if not exists is_public boolean not null default false;

alter table media_assets
  add column if not exists public_token text;

create unique index if not exists media_assets_public_token_uidx
  on media_assets(public_token)
  where public_token is not null;
