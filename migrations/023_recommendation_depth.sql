create table if not exists crm_bulk_runtime_batches (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  project_id uuid references projects(id) on delete set null,
  action_type text not null,
  entity_type text not null default 'lead',
  requested_count integer not null default 0,
  succeeded_count integer not null default 0,
  blocked_count integer not null default 0,
  failed_count integer not null default 0,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now()
);

alter table crm_bulk_runtime_batches
  add column if not exists project_id uuid references projects(id) on delete set null,
  add column if not exists action_type text not null default 'bulk_follow_up',
  add column if not exists entity_type text not null default 'lead',
  add column if not exists requested_count integer not null default 0,
  add column if not exists succeeded_count integer not null default 0,
  add column if not exists blocked_count integer not null default 0,
  add column if not exists failed_count integer not null default 0,
  add column if not exists metadata jsonb not null default '{}',
  add column if not exists created_at timestamptz not null default now();

create table if not exists crm_permission_audit_runs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  project_id uuid references projects(id) on delete set null,
  module_key text not null,
  checked_route text not null,
  required_permission text not null,
  role_scope text not null default '',
  status text not null default 'ok',
  detail text not null default '',
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now()
);

alter table crm_permission_audit_runs
  add column if not exists project_id uuid references projects(id) on delete set null,
  add column if not exists module_key text not null default 'unknown',
  add column if not exists checked_route text not null default '',
  add column if not exists required_permission text not null default '',
  add column if not exists role_scope text not null default '',
  add column if not exists status text not null default 'ok',
  add column if not exists detail text not null default '',
  add column if not exists metadata jsonb not null default '{}',
  add column if not exists created_at timestamptz not null default now();

alter table crm_permission_audit_runs drop constraint if exists crm_permission_audit_runs_status_check;
alter table crm_permission_audit_runs
  add constraint crm_permission_audit_runs_status_check
  check (status in ('ok', 'warning', 'blocked', 'missing_guard'));

create index if not exists crm_bulk_runtime_batches_workspace_created_idx
  on crm_bulk_runtime_batches(workspace_id, project_id, created_at desc);

create index if not exists crm_permission_audit_runs_workspace_status_idx
  on crm_permission_audit_runs(workspace_id, project_id, status, created_at desc);
