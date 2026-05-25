alter table deals
  add column if not exists lost_reason_category text,
  add column if not exists lost_reason_detail text not null default '',
  add column if not exists lost_at timestamptz,
  add column if not exists closed_at timestamptz;

alter table deal_stage_history
  add column if not exists reason_category text,
  add column if not exists reason_detail text not null default '';

alter table audit_logs
  add column if not exists project_id uuid references projects(id) on delete set null,
  add column if not exists deal_id uuid references deals(id) on delete set null;

create table if not exists project_pipeline_permissions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  user_id uuid not null references workspace_users(id) on delete cascade,
  can_edit_deals boolean not null default true,
  can_move_deals boolean not null default true,
  can_close_deals boolean not null default false,
  can_reopen_deals boolean not null default false,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, project_id, user_id)
);

create index if not exists deals_workspace_project_closed_idx
  on deals(workspace_id, project_id, closed_at desc);

create index if not exists deals_lost_reason_idx
  on deals(workspace_id, project_id, lost_reason_category)
  where lost_reason_category is not null;

create index if not exists deal_stage_history_reason_idx
  on deal_stage_history(workspace_id, project_id, reason_category, changed_at desc)
  where reason_category is not null;

create index if not exists audit_logs_project_deal_created_idx
  on audit_logs(workspace_id, project_id, deal_id, created_at desc);

create index if not exists project_pipeline_permissions_lookup_idx
  on project_pipeline_permissions(workspace_id, project_id, user_id);
