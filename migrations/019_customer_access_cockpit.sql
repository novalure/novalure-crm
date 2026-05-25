create table if not exists customer_project_access (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  customer_access_id uuid not null references customer_workspace_access(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  user_id uuid not null references workspace_users(id) on delete cascade,
  project_role text not null default 'assistant' check (project_role in ('owner', 'admin', 'agent', 'assistant')),
  access_level text not null default 'viewer' check (access_level in ('viewer', 'editor', 'admin')),
  can_view_project boolean not null default true,
  can_edit_project boolean not null default false,
  can_view_contacts boolean not null default false,
  can_export_data boolean not null default false,
  status text not null default 'active' check (status in ('active', 'invited', 'suspended')),
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, customer_access_id, project_id, user_id)
);

create index if not exists customer_project_access_customer_idx
  on customer_project_access(workspace_id, customer_access_id, project_id);

create index if not exists customer_project_access_user_idx
  on customer_project_access(workspace_id, user_id, status);

create index if not exists customer_workspace_access_project_health_idx
  on customer_workspace_access(workspace_id, project_id, health, status);
