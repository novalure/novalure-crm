create table if not exists crm_operational_recommendation_runs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  project_id uuid references projects(id) on delete set null,
  recommendation_key text not null,
  module_key text not null,
  status text not null default 'completed',
  score_before numeric(5,2),
  score_after numeric(5,2),
  summary text not null default '',
  next_action text not null default '',
  metrics jsonb not null default '{}',
  created_by_user_id uuid references workspace_users(id) on delete set null,
  created_at timestamptz not null default now()
);

alter table crm_operational_recommendation_runs
  add column if not exists project_id uuid references projects(id) on delete set null,
  add column if not exists recommendation_key text not null default 'analysis_bot',
  add column if not exists module_key text not null default 'analysis_bot',
  add column if not exists status text not null default 'completed',
  add column if not exists score_before numeric(5,2),
  add column if not exists score_after numeric(5,2),
  add column if not exists summary text not null default '',
  add column if not exists next_action text not null default '',
  add column if not exists metrics jsonb not null default '{}',
  add column if not exists created_by_user_id uuid references workspace_users(id) on delete set null,
  add column if not exists created_at timestamptz not null default now();

alter table crm_operational_recommendation_runs drop constraint if exists crm_operational_recommendation_runs_status_check;
alter table crm_operational_recommendation_runs
  add constraint crm_operational_recommendation_runs_status_check
  check (status in ('completed', 'partial', 'blocked', 'needs_data'));

create table if not exists pipeline_forecast_snapshots (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  project_id uuid references projects(id) on delete set null,
  period_start timestamptz not null,
  period_end timestamptz not null,
  open_deals_count integer not null default 0,
  weighted_value_cents bigint not null default 0,
  pipeline_value_cents bigint not null default 0,
  stale_deals_count integer not null default 0,
  lost_reasons jsonb not null default '{}',
  owner_breakdown jsonb not null default '[]',
  stage_breakdown jsonb not null default '[]',
  metadata jsonb not null default '{}',
  created_by_user_id uuid references workspace_users(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists pipeline_bulk_actions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  project_id uuid references projects(id) on delete set null,
  action_type text not null,
  requested_count integer not null default 0,
  succeeded_count integer not null default 0,
  blocked_count integer not null default 0,
  failed_count integer not null default 0,
  deal_ids jsonb not null default '[]',
  metadata jsonb not null default '{}',
  created_by_user_id uuid references workspace_users(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists funnel_conversion_reports (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  project_id uuid references projects(id) on delete set null,
  funnel_id uuid references funnels(id) on delete set null,
  period_start timestamptz not null,
  period_end timestamptz not null,
  visits_count integer not null default 0,
  submissions_count integer not null default 0,
  test_submissions_count integer not null default 0,
  lead_handover_count integer not null default 0,
  conversion_rate numeric(8,4) not null default 0,
  source_breakdown jsonb not null default '[]',
  step_breakdown jsonb not null default '[]',
  utm_breakdown jsonb not null default '[]',
  metadata jsonb not null default '{}',
  created_by_user_id uuid references workspace_users(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists microsoft_booking_health_checks (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  project_id uuid references projects(id) on delete set null,
  status text not null default 'partial',
  oauth_configured boolean not null default false,
  availability_configured boolean not null default false,
  teams_links_count integer not null default 0,
  queued_notifications_count integer not null default 0,
  failed_notifications_count integer not null default 0,
  checked_pages_count integer not null default 0,
  next_action text not null default '',
  metadata jsonb not null default '{}',
  created_by_user_id uuid references workspace_users(id) on delete set null,
  checked_at timestamptz not null default now()
);

alter table microsoft_booking_health_checks drop constraint if exists microsoft_booking_health_checks_status_check;
alter table microsoft_booking_health_checks
  add constraint microsoft_booking_health_checks_status_check
  check (status in ('ready', 'partial', 'blocked'));

create table if not exists sequence_runtime_reviews (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  project_id uuid references projects(id) on delete set null,
  sequence_id uuid references sequence_definitions(id) on delete set null,
  enrollments_count integer not null default 0,
  scheduled_step_runs_count integer not null default 0,
  blocked_step_runs_count integer not null default 0,
  stop_rules_count integer not null default 0,
  reminder_tasks_count integer not null default 0,
  status text not null default 'completed',
  summary text not null default '',
  metadata jsonb not null default '{}',
  created_by_user_id uuid references workspace_users(id) on delete set null,
  created_at timestamptz not null default now()
);

alter table sequence_runtime_reviews drop constraint if exists sequence_runtime_reviews_status_check;
alter table sequence_runtime_reviews
  add constraint sequence_runtime_reviews_status_check
  check (status in ('completed', 'partial', 'blocked', 'needs_data'));

create index if not exists crm_operational_recommendation_runs_workspace_idx
  on crm_operational_recommendation_runs(workspace_id, project_id, module_key, created_at desc);

create index if not exists pipeline_forecast_snapshots_workspace_idx
  on pipeline_forecast_snapshots(workspace_id, project_id, period_end desc);

create index if not exists pipeline_bulk_actions_workspace_idx
  on pipeline_bulk_actions(workspace_id, project_id, action_type, created_at desc);

create index if not exists funnel_conversion_reports_workspace_idx
  on funnel_conversion_reports(workspace_id, project_id, funnel_id, period_end desc);

create index if not exists microsoft_booking_health_checks_workspace_idx
  on microsoft_booking_health_checks(workspace_id, project_id, checked_at desc);

create index if not exists sequence_runtime_reviews_workspace_idx
  on sequence_runtime_reviews(workspace_id, project_id, sequence_id, created_at desc);
