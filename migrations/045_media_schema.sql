create table if not exists media_assets (
  id uuid primary key default gen_random_uuid(),
  workspace_id text not null,
  name text not null,
  original_name text not null,
  folder text not null default 'media-uploads',
  mime_type text not null,
  size_bytes bigint not null default 0,
  url text not null,
  relative_path text not null,
  storage_provider text not null default 'local',
  alt text,
  created_at timestamptz not null default now(),
  is_public boolean not null default false,
  public_token text
);

alter table media_assets
  alter column id set default gen_random_uuid();

alter table media_assets
  add column if not exists is_public boolean not null default false;

alter table media_assets
  add column if not exists public_token text;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'media_assets_storage_provider_check'
      and conrelid = 'media_assets'::regclass
  ) then
    alter table media_assets
      add constraint media_assets_storage_provider_check
      check (storage_provider in ('local', 'vercel-blob'));
  end if;
end $$;

create index if not exists media_assets_workspace_created_idx
  on media_assets(workspace_id, created_at desc);

create unique index if not exists media_assets_public_token_uidx
  on media_assets(public_token)
  where public_token is not null;
