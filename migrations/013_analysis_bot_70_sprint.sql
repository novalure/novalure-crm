create table if not exists dashboard_views (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  user_id uuid references workspace_users(id) on delete set null,
  project_id uuid references projects(id) on delete set null,
  name text not null,
  filters jsonb not null default '{}',
  layout jsonb not null default '[]',
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists deal_stage_history (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  project_id uuid references projects(id) on delete set null,
  deal_id uuid not null references deals(id) on delete cascade,
  from_stage text,
  to_stage text not null,
  changed_by_user_id uuid references workspace_users(id) on delete set null,
  reason text,
  changed_at timestamptz not null default now(),
  metadata jsonb not null default '{}'
);

create table if not exists property_buildings (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  name text not null,
  address text not null default '',
  completion_date date,
  floors integer not null default 0,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists property_units (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  building_id uuid references property_buildings(id) on delete set null,
  unit_number text not null,
  floor integer not null default 0,
  rooms numeric(4,1) not null default 0,
  area_sqm numeric(10,2) not null default 0,
  price_cents bigint not null default 0,
  status text not null default 'available' check (status in ('available', 'reserved', 'sold', 'blocked')),
  buyer_contact_id uuid references contacts(id) on delete set null,
  deal_id uuid references deals(id) on delete set null,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, unit_number)
);

create table if not exists property_reservations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  unit_id uuid not null references property_units(id) on delete cascade,
  contact_id uuid not null references contacts(id) on delete cascade,
  deal_id uuid references deals(id) on delete set null,
  status text not null default 'hold' check (status in ('hold', 'reserved', 'expired', 'converted')),
  expires_at timestamptz not null,
  deposit_cents bigint not null default 0,
  contract_milestone text not null default 'not_started',
  next_action text not null default '',
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists customer_workspace_access (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  organization_id uuid not null references organizations(id) on delete cascade,
  project_id uuid references projects(id) on delete set null,
  owner_user_id uuid references workspace_users(id) on delete set null,
  status text not null default 'lead' check (status in ('lead', 'demo', 'trial', 'onboarding', 'active', 'risk')),
  plan text not null default '',
  invited_users integer not null default 0,
  active_users integer not null default 0,
  activation_score integer not null default 0 check (activation_score between 0 and 100),
  health text not null default 'attention' check (health in ('healthy', 'attention', 'risk')),
  last_customer_activity_at timestamptz,
  next_onboarding_action text not null default '',
  risks jsonb not null default '[]',
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists speed_to_lead_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  project_id uuid references projects(id) on delete set null,
  lead_id uuid references leads(id) on delete cascade,
  contact_id uuid references contacts(id) on delete set null,
  owner_user_id uuid references workspace_users(id) on delete set null,
  state text not null check (state in ('covered', 'dueSoon', 'overdue')),
  due_at timestamptz,
  first_response_at timestamptz,
  minutes_until_due integer not null default 0,
  notification_channel text not null default 'teams',
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create table if not exists consent_policy_decisions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  project_id uuid references projects(id) on delete set null,
  contact_id uuid references contacts(id) on delete cascade,
  channel text not null,
  purpose text not null,
  allowed boolean not null default false,
  reason text not null,
  source_consent_id uuid references consent_records(id) on delete set null,
  decided_at timestamptz not null default now(),
  metadata jsonb not null default '{}'
);

create table if not exists data_quality_issues (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  project_id uuid references projects(id) on delete set null,
  entity_type text not null,
  entity_id uuid,
  issue_type text not null,
  severity text not null default 'warning' check (severity in ('warning', 'risk')),
  status text not null default 'open' check (status in ('open', 'resolved', 'ignored')),
  detail text not null default '',
  next_action text not null default '',
  detected_at timestamptz not null default now(),
  resolved_at timestamptz,
  metadata jsonb not null default '{}'
);

create table if not exists bot_evaluation_runs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  project_id uuid references projects(id) on delete set null,
  bot_id uuid references bots(id) on delete cascade,
  score integer not null default 0 check (score between 0 and 100),
  source_coverage numeric(5,2) not null default 0,
  hallucination_failures integer not null default 0,
  handoff_failures integer not null default 0,
  red_team_failures integer not null default 0,
  result jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create table if not exists analytics_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  project_id uuid references projects(id) on delete set null,
  contact_id uuid references contacts(id) on delete set null,
  lead_id uuid references leads(id) on delete set null,
  deal_id uuid references deals(id) on delete set null,
  funnel_id uuid references funnels(id) on delete set null,
  event_type text not null,
  source text,
  channel text,
  value_cents bigint not null default 0,
  occurred_at timestamptz not null default now(),
  metadata jsonb not null default '{}'
);

create index if not exists dashboard_views_workspace_user_idx
  on dashboard_views(workspace_id, user_id, updated_at desc);

create index if not exists deal_stage_history_deal_idx
  on deal_stage_history(deal_id, changed_at desc);

create index if not exists property_units_project_status_idx
  on property_units(project_id, status, unit_number);

create index if not exists property_reservations_expiring_idx
  on property_reservations(status, expires_at);

create index if not exists customer_workspace_access_health_idx
  on customer_workspace_access(workspace_id, health, activation_score);

create index if not exists speed_to_lead_events_state_idx
  on speed_to_lead_events(workspace_id, state, created_at desc);

create index if not exists consent_policy_decisions_contact_idx
  on consent_policy_decisions(contact_id, channel, purpose, decided_at desc);

create index if not exists data_quality_issues_open_idx
  on data_quality_issues(workspace_id, status, severity, detected_at desc);

create index if not exists bot_evaluation_runs_bot_idx
  on bot_evaluation_runs(bot_id, created_at desc);

create index if not exists analytics_events_workspace_type_idx
  on analytics_events(workspace_id, event_type, occurred_at desc);
