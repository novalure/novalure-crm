create table if not exists meeting_pages (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  project_id uuid references projects(id) on delete set null,
  owner_user_id uuid references workspace_users(id) on delete set null,
  slug text not null,
  title text not null,
  status text not null default 'active' check (status in ('active', 'draft', 'archived')),
  calendar_integrations jsonb not null default '{}',
  share_config jsonb not null default '{}',
  automation jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, slug)
);

create index if not exists meeting_pages_workspace_status_idx on meeting_pages(workspace_id, status);
create index if not exists meeting_pages_slug_idx on meeting_pages(slug);
