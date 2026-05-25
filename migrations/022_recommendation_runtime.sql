create table if not exists crm_fallback_audits (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  project_id uuid references projects(id) on delete set null,
  module_key text not null,
  source text not null default 'fallback',
  severity text not null default 'warning',
  status text not null default 'open',
  detail text not null default '',
  next_action text not null default '',
  metadata jsonb not null default '{}',
  detected_at timestamptz not null default now(),
  resolved_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (workspace_id, project_id, module_key)
);

alter table crm_fallback_audits
  add column if not exists project_id uuid references projects(id) on delete set null,
  add column if not exists module_key text not null default 'unknown',
  add column if not exists source text not null default 'fallback',
  add column if not exists severity text not null default 'warning',
  add column if not exists status text not null default 'open',
  add column if not exists detail text not null default '',
  add column if not exists next_action text not null default '',
  add column if not exists metadata jsonb not null default '{}',
  add column if not exists detected_at timestamptz not null default now(),
  add column if not exists resolved_at timestamptz,
  add column if not exists updated_at timestamptz not null default now();

alter table crm_fallback_audits drop constraint if exists crm_fallback_audits_status_check;
alter table crm_fallback_audits
  add constraint crm_fallback_audits_status_check
  check (status in ('open', 'resolved', 'ignored'));

create table if not exists crm_follow_up_actions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  project_id uuid references projects(id) on delete set null,
  contact_id uuid references contacts(id) on delete set null,
  lead_id uuid references leads(id) on delete set null,
  task_id uuid references tasks(id) on delete set null,
  owner_user_id uuid references workspace_users(id) on delete set null,
  action_type text not null,
  channel text not null default 'E-Mail',
  outcome text not null default 'planned',
  consent_decision_id uuid references consent_policy_decisions(id) on delete set null,
  allowed boolean not null default false,
  follow_up_at timestamptz not null default now(),
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now()
);

alter table crm_follow_up_actions
  add column if not exists project_id uuid references projects(id) on delete set null,
  add column if not exists contact_id uuid references contacts(id) on delete set null,
  add column if not exists lead_id uuid references leads(id) on delete set null,
  add column if not exists task_id uuid references tasks(id) on delete set null,
  add column if not exists owner_user_id uuid references workspace_users(id) on delete set null,
  add column if not exists action_type text not null default 'manual_follow_up',
  add column if not exists channel text not null default 'E-Mail',
  add column if not exists outcome text not null default 'planned',
  add column if not exists consent_decision_id uuid references consent_policy_decisions(id) on delete set null,
  add column if not exists allowed boolean not null default false,
  add column if not exists follow_up_at timestamptz not null default now(),
  add column if not exists metadata jsonb not null default '{}',
  add column if not exists created_at timestamptz not null default now();

create table if not exists property_viewing_slots (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  unit_id uuid not null references property_units(id) on delete cascade,
  contact_id uuid references contacts(id) on delete set null,
  lead_id uuid references leads(id) on delete set null,
  deal_id uuid references deals(id) on delete set null,
  owner_user_id uuid references workspace_users(id) on delete set null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  status text not null default 'planned',
  note text not null default '',
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table property_viewing_slots
  add column if not exists lead_id uuid references leads(id) on delete set null,
  add column if not exists owner_user_id uuid references workspace_users(id) on delete set null,
  add column if not exists status text not null default 'planned',
  add column if not exists note text not null default '',
  add column if not exists metadata jsonb not null default '{}',
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

alter table property_viewing_slots drop constraint if exists property_viewing_slots_status_check;
alter table property_viewing_slots
  add constraint property_viewing_slots_status_check
  check (status in ('planned', 'confirmed', 'completed', 'cancelled', 'no_show'));

create table if not exists property_unit_audit_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  unit_id uuid not null references property_units(id) on delete cascade,
  actor_user_id uuid references workspace_users(id) on delete set null,
  event_type text not null,
  before jsonb,
  after jsonb,
  reason text not null default '',
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create table if not exists property_offer_milestones (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  unit_id uuid references property_units(id) on delete set null,
  reservation_id uuid references property_reservations(id) on delete set null,
  contact_id uuid references contacts(id) on delete set null,
  deal_id uuid references deals(id) on delete set null,
  milestone text not null,
  status text not null default 'open',
  due_at timestamptz,
  completed_at timestamptz,
  owner_user_id uuid references workspace_users(id) on delete set null,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table property_offer_milestones
  add column if not exists unit_id uuid references property_units(id) on delete set null,
  add column if not exists owner_user_id uuid references workspace_users(id) on delete set null,
  add column if not exists metadata jsonb not null default '{}',
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

alter table property_offer_milestones drop constraint if exists property_offer_milestones_milestone_check;
alter table property_offer_milestones
  add constraint property_offer_milestones_milestone_check
  check (milestone in ('offer_created', 'offer_sent', 'documents_complete', 'contract_prepared', 'contract_sent', 'contract_signed', 'lost'));

alter table property_offer_milestones drop constraint if exists property_offer_milestones_status_check;
alter table property_offer_milestones
  add constraint property_offer_milestones_status_check
  check (status in ('open', 'done', 'blocked', 'lost'));

create table if not exists bot_answer_quality_checks (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  project_id uuid references projects(id) on delete set null,
  bot_id uuid references bots(id) on delete cascade,
  conversation_id uuid references bot_conversations(id) on delete set null,
  evaluation_run_id uuid references bot_evaluation_runs(id) on delete set null,
  citation_coverage numeric(5,2) not null default 0,
  handoff_quality numeric(5,2) not null default 0,
  out_of_scope_rejections integer not null default 0,
  risky_answer_count integer not null default 0,
  result jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create table if not exists crm_conversion_snapshots (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  project_id uuid references projects(id) on delete set null,
  funnel_id uuid references funnels(id) on delete set null,
  source text not null default '',
  period_start timestamptz not null,
  period_end timestamptz not null,
  leads_count integer not null default 0,
  bookings_count integer not null default 0,
  reservations_count integer not null default 0,
  won_deals_count integer not null default 0,
  lost_deals_count integer not null default 0,
  closed_revenue_cents bigint not null default 0,
  unit_sales_velocity numeric(10,2) not null default 0,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create table if not exists customer_onboarding_risk_alerts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  customer_access_id uuid not null references customer_workspace_access(id) on delete cascade,
  project_id uuid references projects(id) on delete set null,
  owner_user_id uuid references workspace_users(id) on delete set null,
  risk_type text not null,
  severity text not null default 'warning',
  status text not null default 'open',
  task_id uuid references tasks(id) on delete set null,
  teams_job_id uuid references teams_notification_jobs(id) on delete set null,
  detail text not null default '',
  next_action text not null default '',
  metadata jsonb not null default '{}',
  detected_at timestamptz not null default now(),
  resolved_at timestamptz
);

alter table customer_onboarding_risk_alerts drop constraint if exists customer_onboarding_risk_alerts_status_check;
alter table customer_onboarding_risk_alerts
  add constraint customer_onboarding_risk_alerts_status_check
  check (status in ('open', 'resolved', 'ignored'));

create table if not exists data_quality_cleanup_actions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  issue_id uuid references data_quality_issues(id) on delete set null,
  contact_id uuid references contacts(id) on delete set null,
  duplicate_contact_id uuid references contacts(id) on delete set null,
  lead_id uuid references leads(id) on delete set null,
  owner_user_id uuid references workspace_users(id) on delete set null,
  action_type text not null,
  status text not null default 'planned',
  reason text not null default '',
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

alter table data_quality_cleanup_actions drop constraint if exists data_quality_cleanup_actions_status_check;
alter table data_quality_cleanup_actions
  add constraint data_quality_cleanup_actions_status_check
  check (status in ('planned', 'completed', 'ignored', 'blocked'));

create index if not exists crm_fallback_audits_workspace_status_idx
  on crm_fallback_audits(workspace_id, status, detected_at desc);

create index if not exists crm_follow_up_actions_workspace_created_idx
  on crm_follow_up_actions(workspace_id, project_id, created_at desc);

create index if not exists property_viewing_slots_project_start_idx
  on property_viewing_slots(workspace_id, project_id, starts_at);

create index if not exists property_offer_milestones_project_status_idx
  on property_offer_milestones(workspace_id, project_id, status, updated_at desc);

create index if not exists bot_answer_quality_checks_bot_created_idx
  on bot_answer_quality_checks(workspace_id, bot_id, created_at desc);

create index if not exists crm_conversion_snapshots_workspace_period_idx
  on crm_conversion_snapshots(workspace_id, period_end desc);

create index if not exists customer_onboarding_risk_alerts_open_idx
  on customer_onboarding_risk_alerts(workspace_id, status, severity, detected_at desc);

create index if not exists data_quality_cleanup_actions_workspace_created_idx
  on data_quality_cleanup_actions(workspace_id, created_at desc);
