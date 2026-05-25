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
  storage_provider text not null default 'local' check (storage_provider in ('local', 'vercel-blob')),
  alt text,
  created_at timestamptz not null default now()
);

create index if not exists media_assets_workspace_created_idx on media_assets(workspace_id, created_at desc);
