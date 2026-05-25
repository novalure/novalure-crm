alter table workspace_users
  add column if not exists password_hash text;

alter table deals
  add column if not exists lost_reason_category text,
  add column if not exists lost_reason_detail text not null default '',
  add column if not exists lost_at timestamptz,
  add column if not exists closed_at timestamptz;

alter table audit_logs
  add column if not exists project_id uuid references projects(id) on delete set null,
  add column if not exists deal_id uuid references deals(id) on delete set null;

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
  reason_category text,
  reason_detail text not null default '',
  changed_at timestamptz not null default now(),
  metadata jsonb not null default '{}'
);

alter table deal_stage_history
  add column if not exists reason_category text,
  add column if not exists reason_detail text not null default '';

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

alter table property_buildings
  add column if not exists address text not null default '',
  add column if not exists completion_date date,
  add column if not exists floors integer not null default 0,
  add column if not exists metadata jsonb not null default '{}',
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

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
  status text not null default 'available',
  buyer_contact_id uuid references contacts(id) on delete set null,
  deal_id uuid references deals(id) on delete set null,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, unit_number)
);

alter table property_units
  add column if not exists building_id uuid references property_buildings(id) on delete set null,
  add column if not exists unit_number text,
  add column if not exists floor integer not null default 0,
  add column if not exists rooms numeric(4,1) not null default 0,
  add column if not exists area_sqm numeric(10,2) not null default 0,
  add column if not exists price_cents bigint not null default 0,
  add column if not exists status text not null default 'available',
  add column if not exists buyer_contact_id uuid references contacts(id) on delete set null,
  add column if not exists deal_id uuid references deals(id) on delete set null,
  add column if not exists metadata jsonb not null default '{}',
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

alter table property_units drop constraint if exists property_units_status_check;
alter table property_units
  add constraint property_units_status_check
  check (status in ('available', 'reserved', 'sold', 'blocked'));

create table if not exists property_reservations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  unit_id uuid not null references property_units(id) on delete cascade,
  contact_id uuid not null references contacts(id) on delete cascade,
  deal_id uuid references deals(id) on delete set null,
  status text not null default 'hold',
  expires_at timestamptz not null,
  deposit_cents bigint not null default 0,
  contract_milestone text not null default 'not_started',
  next_action text not null default '',
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table property_reservations
  add column if not exists deal_id uuid references deals(id) on delete set null,
  add column if not exists status text not null default 'hold',
  add column if not exists expires_at timestamptz,
  add column if not exists deposit_cents bigint not null default 0,
  add column if not exists contract_milestone text not null default 'not_started',
  add column if not exists next_action text not null default '',
  add column if not exists metadata jsonb not null default '{}',
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

alter table property_reservations drop constraint if exists property_reservations_status_check;
alter table property_reservations
  add constraint property_reservations_status_check
  check (status in ('hold', 'reserved', 'expired', 'converted'));

create table if not exists customer_workspace_access (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  organization_id uuid not null references organizations(id) on delete cascade,
  project_id uuid references projects(id) on delete set null,
  owner_user_id uuid references workspace_users(id) on delete set null,
  status text not null default 'lead',
  plan text not null default '',
  invited_users integer not null default 0,
  active_users integer not null default 0,
  activation_score integer not null default 0,
  health text not null default 'attention',
  last_customer_activity_at timestamptz,
  next_onboarding_action text not null default '',
  risks jsonb not null default '[]',
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table customer_workspace_access
  add column if not exists owner_user_id uuid references workspace_users(id) on delete set null,
  add column if not exists status text not null default 'lead',
  add column if not exists plan text not null default '',
  add column if not exists invited_users integer not null default 0,
  add column if not exists active_users integer not null default 0,
  add column if not exists activation_score integer not null default 0,
  add column if not exists health text not null default 'attention',
  add column if not exists last_customer_activity_at timestamptz,
  add column if not exists next_onboarding_action text not null default '',
  add column if not exists risks jsonb not null default '[]',
  add column if not exists metadata jsonb not null default '{}',
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

alter table customer_workspace_access drop constraint if exists customer_workspace_access_status_check;
alter table customer_workspace_access
  add constraint customer_workspace_access_status_check
  check (status in ('lead', 'demo', 'trial', 'onboarding', 'active', 'risk'));

alter table customer_workspace_access drop constraint if exists customer_workspace_access_health_check;
alter table customer_workspace_access
  add constraint customer_workspace_access_health_check
  check (health in ('healthy', 'attention', 'risk'));

alter table customer_workspace_access drop constraint if exists customer_workspace_access_activation_score_check;
alter table customer_workspace_access
  add constraint customer_workspace_access_activation_score_check
  check (activation_score between 0 and 100);

create table if not exists customer_project_access (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  customer_access_id uuid not null references customer_workspace_access(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  user_id uuid not null references workspace_users(id) on delete cascade,
  project_role text not null default 'assistant',
  access_level text not null default 'viewer',
  can_view_project boolean not null default true,
  can_edit_project boolean not null default false,
  can_view_contacts boolean not null default false,
  can_export_data boolean not null default false,
  status text not null default 'active',
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, customer_access_id, project_id, user_id)
);

alter table customer_project_access
  add column if not exists project_role text not null default 'assistant',
  add column if not exists access_level text not null default 'viewer',
  add column if not exists can_view_project boolean not null default true,
  add column if not exists can_edit_project boolean not null default false,
  add column if not exists can_view_contacts boolean not null default false,
  add column if not exists can_export_data boolean not null default false,
  add column if not exists status text not null default 'active',
  add column if not exists metadata jsonb not null default '{}',
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

alter table customer_project_access drop constraint if exists customer_project_access_project_role_check;
alter table customer_project_access
  add constraint customer_project_access_project_role_check
  check (project_role in ('owner', 'admin', 'agent', 'assistant'));

alter table customer_project_access drop constraint if exists customer_project_access_access_level_check;
alter table customer_project_access
  add constraint customer_project_access_access_level_check
  check (access_level in ('viewer', 'editor', 'admin'));

alter table customer_project_access drop constraint if exists customer_project_access_status_check;
alter table customer_project_access
  add constraint customer_project_access_status_check
  check (status in ('active', 'invited', 'suspended'));

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

alter table project_pipeline_permissions
  add column if not exists can_edit_deals boolean not null default true,
  add column if not exists can_move_deals boolean not null default true,
  add column if not exists can_close_deals boolean not null default false,
  add column if not exists can_reopen_deals boolean not null default false,
  add column if not exists metadata jsonb not null default '{}',
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

create table if not exists speed_to_lead_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  project_id uuid references projects(id) on delete set null,
  lead_id uuid references leads(id) on delete cascade,
  contact_id uuid references contacts(id) on delete set null,
  owner_user_id uuid references workspace_users(id) on delete set null,
  state text not null,
  due_at timestamptz,
  first_response_at timestamptz,
  minutes_until_due integer not null default 0,
  notification_channel text not null default 'teams',
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now()
);

alter table speed_to_lead_events
  add column if not exists owner_user_id uuid references workspace_users(id) on delete set null,
  add column if not exists state text not null default 'covered',
  add column if not exists due_at timestamptz,
  add column if not exists first_response_at timestamptz,
  add column if not exists minutes_until_due integer not null default 0,
  add column if not exists notification_channel text not null default 'teams',
  add column if not exists metadata jsonb not null default '{}',
  add column if not exists created_at timestamptz not null default now();

alter table speed_to_lead_events drop constraint if exists speed_to_lead_events_state_check;
alter table speed_to_lead_events
  add constraint speed_to_lead_events_state_check
  check (state in ('covered', 'dueSoon', 'overdue'));

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

alter table consent_policy_decisions
  add column if not exists project_id uuid references projects(id) on delete set null,
  add column if not exists channel text not null default 'E-Mail',
  add column if not exists purpose text not null default 'salesFollowUp',
  add column if not exists allowed boolean not null default false,
  add column if not exists reason text not null default 'unknown',
  add column if not exists source_consent_id uuid references consent_records(id) on delete set null,
  add column if not exists decided_at timestamptz not null default now(),
  add column if not exists metadata jsonb not null default '{}';

create table if not exists newsletter_suppressions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  campaign_id uuid references newsletter_campaigns(id) on delete set null,
  email text not null,
  reason text not null default 'unsubscribe',
  source text not null default 'Newsletter-Abmeldelink',
  metadata jsonb not null default '{}',
  captured_at timestamptz not null default now()
);

alter table newsletter_suppressions
  add column if not exists campaign_id uuid references newsletter_campaigns(id) on delete set null,
  add column if not exists email text,
  add column if not exists reason text not null default 'unsubscribe',
  add column if not exists source text not null default 'Newsletter-Abmeldelink',
  add column if not exists metadata jsonb not null default '{}',
  add column if not exists captured_at timestamptz not null default now();

alter table newsletter_suppressions drop constraint if exists newsletter_suppressions_reason_check;
alter table newsletter_suppressions
  add constraint newsletter_suppressions_reason_check
  check (reason in ('unsubscribe', 'bounce', 'complaint', 'manual'));

create table if not exists data_quality_issues (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  project_id uuid references projects(id) on delete set null,
  entity_type text not null,
  entity_id uuid,
  issue_type text not null,
  severity text not null default 'warning',
  status text not null default 'open',
  detail text not null default '',
  next_action text not null default '',
  detected_at timestamptz not null default now(),
  resolved_at timestamptz,
  metadata jsonb not null default '{}'
);

alter table data_quality_issues
  add column if not exists project_id uuid references projects(id) on delete set null,
  add column if not exists entity_type text not null default 'contact',
  add column if not exists entity_id uuid,
  add column if not exists issue_type text not null default 'missing_next_action',
  add column if not exists severity text not null default 'warning',
  add column if not exists status text not null default 'open',
  add column if not exists detail text not null default '',
  add column if not exists next_action text not null default '',
  add column if not exists detected_at timestamptz not null default now(),
  add column if not exists resolved_at timestamptz,
  add column if not exists metadata jsonb not null default '{}';

alter table data_quality_issues drop constraint if exists data_quality_issues_severity_check;
alter table data_quality_issues
  add constraint data_quality_issues_severity_check
  check (severity in ('warning', 'risk'));

alter table data_quality_issues drop constraint if exists data_quality_issues_status_check;
alter table data_quality_issues
  add constraint data_quality_issues_status_check
  check (status in ('open', 'resolved', 'ignored'));

create table if not exists bot_evaluation_runs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  project_id uuid references projects(id) on delete set null,
  bot_id uuid references bots(id) on delete cascade,
  score integer not null default 0,
  source_coverage numeric(5,2) not null default 0,
  hallucination_failures integer not null default 0,
  handoff_failures integer not null default 0,
  red_team_failures integer not null default 0,
  result jsonb not null default '{}',
  created_at timestamptz not null default now()
);

alter table bot_evaluation_runs
  add column if not exists project_id uuid references projects(id) on delete set null,
  add column if not exists bot_id uuid references bots(id) on delete cascade,
  add column if not exists score integer not null default 0,
  add column if not exists source_coverage numeric(5,2) not null default 0,
  add column if not exists hallucination_failures integer not null default 0,
  add column if not exists handoff_failures integer not null default 0,
  add column if not exists red_team_failures integer not null default 0,
  add column if not exists result jsonb not null default '{}',
  add column if not exists created_at timestamptz not null default now();

alter table bot_evaluation_runs drop constraint if exists bot_evaluation_runs_score_check;
alter table bot_evaluation_runs
  add constraint bot_evaluation_runs_score_check
  check (score between 0 and 100);

create table if not exists analytics_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  project_id uuid references projects(id) on delete set null,
  contact_id uuid references contacts(id) on delete set null,
  lead_id uuid references leads(id) on delete set null,
  deal_id uuid references deals(id) on delete set null,
  funnel_id uuid references funnels(id) on delete set null,
  entity_id uuid,
  entity_type text,
  event_type text not null,
  module text,
  source text,
  channel text,
  user_id uuid references workspace_users(id) on delete set null,
  value_cents bigint not null default 0,
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  metadata jsonb not null default '{}'
);

alter table analytics_events
  add column if not exists contact_id uuid references contacts(id) on delete set null,
  add column if not exists lead_id uuid references leads(id) on delete set null,
  add column if not exists deal_id uuid references deals(id) on delete set null,
  add column if not exists funnel_id uuid references funnels(id) on delete set null,
  add column if not exists entity_id uuid,
  add column if not exists entity_type text,
  add column if not exists module text,
  add column if not exists source text,
  add column if not exists channel text,
  add column if not exists user_id uuid references workspace_users(id) on delete set null,
  add column if not exists value_cents bigint not null default 0,
  add column if not exists occurred_at timestamptz not null default now(),
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists metadata jsonb not null default '{}';

create table if not exists auth_password_reset_tokens (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  user_id uuid not null references workspace_users(id) on delete cascade,
  token_hash text not null unique,
  requested_email text not null,
  request_ip text,
  user_agent text,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

alter table auth_password_reset_tokens
  add column if not exists workspace_id uuid references workspaces(id) on delete cascade,
  add column if not exists user_id uuid references workspace_users(id) on delete cascade,
  add column if not exists token_hash text,
  add column if not exists requested_email text not null default '',
  add column if not exists request_ip text,
  add column if not exists user_agent text,
  add column if not exists expires_at timestamptz,
  add column if not exists used_at timestamptz,
  add column if not exists created_at timestamptz not null default now();

create unique index if not exists auth_password_reset_tokens_token_hash_uidx
  on auth_password_reset_tokens(token_hash);

create table if not exists teams_notification_targets (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  project_id uuid references projects(id) on delete cascade,
  label text not null default 'Workspace Teams',
  destination_type text not null default 'incoming_webhook',
  webhook_url text,
  team_id text,
  channel_id text,
  chat_id text,
  channel_name text,
  enabled boolean not null default true,
  alert_types text[] not null default array[
    'lead_sla_overdue',
    'lead_sla_due_soon',
    'meeting_booked',
    'customer_access_risk',
    'deal_stage_changed'
  ],
  metadata jsonb not null default '{}',
  created_by_user_id uuid references workspace_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table teams_notification_targets
  add column if not exists project_id uuid references projects(id) on delete cascade,
  add column if not exists label text not null default 'Workspace Teams',
  add column if not exists destination_type text not null default 'incoming_webhook',
  add column if not exists webhook_url text,
  add column if not exists team_id text,
  add column if not exists channel_id text,
  add column if not exists chat_id text,
  add column if not exists channel_name text,
  add column if not exists enabled boolean not null default true,
  add column if not exists alert_types text[] not null default array[
    'lead_sla_overdue',
    'lead_sla_due_soon',
    'meeting_booked',
    'customer_access_risk',
    'deal_stage_changed'
  ],
  add column if not exists metadata jsonb not null default '{}',
  add column if not exists created_by_user_id uuid references workspace_users(id) on delete set null,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

alter table teams_notification_targets
  alter column alert_types set default array[
    'lead_sla_overdue',
    'lead_sla_due_soon',
    'meeting_booked',
    'customer_access_risk',
    'deal_stage_changed'
  ];

update teams_notification_targets
set alert_types = array_append(alert_types, 'lead_sla_due_soon')
where not 'lead_sla_due_soon' = any(alert_types);

alter table teams_notification_targets drop constraint if exists teams_notification_targets_destination_type_check;
alter table teams_notification_targets
  add constraint teams_notification_targets_destination_type_check
  check (destination_type in ('incoming_webhook', 'channel', 'chat'));

create table if not exists teams_notification_jobs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  project_id uuid references projects(id) on delete cascade,
  target_id uuid references teams_notification_targets(id) on delete set null,
  alert_type text not null,
  severity text not null default 'warning',
  status text not null default 'queued',
  entity_type text not null,
  entity_id uuid,
  lead_id uuid references leads(id) on delete set null,
  contact_id uuid references contacts(id) on delete set null,
  deal_id uuid references deals(id) on delete set null,
  calendar_event_id uuid references calendar_events(id) on delete set null,
  customer_access_id uuid references customer_workspace_access(id) on delete set null,
  owner_user_id uuid references workspace_users(id) on delete set null,
  scheduled_for timestamptz not null default now(),
  attempts integer not null default 0,
  max_attempts integer not null default 3,
  provider text not null default 'teams',
  provider_message_id text,
  error text,
  retry_after timestamptz,
  sent_at timestamptz,
  title text not null,
  summary text not null default '',
  message text not null,
  facts jsonb not null default '[]',
  payload jsonb not null default '{}',
  idempotency_key text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, idempotency_key)
);

alter table teams_notification_jobs
  add column if not exists target_id uuid references teams_notification_targets(id) on delete set null,
  add column if not exists alert_type text not null default 'lead_sla_overdue',
  add column if not exists severity text not null default 'warning',
  add column if not exists status text not null default 'queued',
  add column if not exists entity_type text not null default 'lead',
  add column if not exists entity_id uuid,
  add column if not exists lead_id uuid references leads(id) on delete set null,
  add column if not exists contact_id uuid references contacts(id) on delete set null,
  add column if not exists deal_id uuid references deals(id) on delete set null,
  add column if not exists calendar_event_id uuid references calendar_events(id) on delete set null,
  add column if not exists customer_access_id uuid references customer_workspace_access(id) on delete set null,
  add column if not exists owner_user_id uuid references workspace_users(id) on delete set null,
  add column if not exists scheduled_for timestamptz not null default now(),
  add column if not exists attempts integer not null default 0,
  add column if not exists max_attempts integer not null default 3,
  add column if not exists provider text not null default 'teams',
  add column if not exists provider_message_id text,
  add column if not exists error text,
  add column if not exists retry_after timestamptz,
  add column if not exists sent_at timestamptz,
  add column if not exists title text not null default 'Teams Alert',
  add column if not exists summary text not null default '',
  add column if not exists message text not null default '',
  add column if not exists facts jsonb not null default '[]',
  add column if not exists payload jsonb not null default '{}',
  add column if not exists idempotency_key text not null default gen_random_uuid()::text,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

alter table teams_notification_jobs drop constraint if exists teams_notification_jobs_alert_type_check;
alter table teams_notification_jobs
  add constraint teams_notification_jobs_alert_type_check
  check (alert_type in (
    'lead_sla_overdue',
    'lead_sla_due_soon',
    'meeting_booked',
    'customer_access_risk',
    'deal_stage_changed'
  ));

alter table teams_notification_jobs drop constraint if exists teams_notification_jobs_status_check;
alter table teams_notification_jobs
  add constraint teams_notification_jobs_status_check
  check (status in ('queued', 'pending_config', 'sending', 'sent', 'failed', 'cancelled'));

alter table teams_notification_jobs drop constraint if exists teams_notification_jobs_severity_check;
alter table teams_notification_jobs
  add constraint teams_notification_jobs_severity_check
  check (severity in ('info', 'warning', 'critical'));

create unique index if not exists property_units_project_unit_uidx
  on property_units(project_id, unit_number);

create index if not exists dashboard_views_workspace_user_idx
  on dashboard_views(workspace_id, user_id, updated_at desc);

create index if not exists deal_stage_history_deal_idx
  on deal_stage_history(deal_id, changed_at desc);

create index if not exists deal_stage_history_reason_idx
  on deal_stage_history(workspace_id, project_id, reason_category, changed_at desc)
  where reason_category is not null;

create index if not exists property_units_project_status_idx
  on property_units(project_id, status, unit_number);

create index if not exists property_reservations_expiring_idx
  on property_reservations(status, expires_at);

create index if not exists customer_workspace_access_health_idx
  on customer_workspace_access(workspace_id, health, activation_score);

create index if not exists customer_workspace_access_project_health_idx
  on customer_workspace_access(workspace_id, project_id, health, status);

create index if not exists customer_project_access_customer_idx
  on customer_project_access(workspace_id, customer_access_id, project_id);

create index if not exists customer_project_access_user_idx
  on customer_project_access(workspace_id, user_id, status);

create index if not exists project_pipeline_permissions_lookup_idx
  on project_pipeline_permissions(workspace_id, project_id, user_id);

create index if not exists speed_to_lead_events_state_idx
  on speed_to_lead_events(workspace_id, state, created_at desc);

create index if not exists consent_policy_decisions_contact_idx
  on consent_policy_decisions(contact_id, channel, purpose, decided_at desc);

create unique index if not exists newsletter_suppressions_workspace_email_idx
  on newsletter_suppressions(workspace_id, lower(email));

create index if not exists newsletter_suppressions_workspace_captured_idx
  on newsletter_suppressions(workspace_id, captured_at desc);

create index if not exists data_quality_issues_open_idx
  on data_quality_issues(workspace_id, status, severity, detected_at desc);

create index if not exists bot_evaluation_runs_bot_idx
  on bot_evaluation_runs(bot_id, created_at desc);

create index if not exists analytics_events_workspace_type_idx
  on analytics_events(workspace_id, event_type, occurred_at desc);

create index if not exists analytics_events_entity_idx
  on analytics_events(workspace_id, entity_type, entity_id, occurred_at desc)
  where entity_id is not null;

create index if not exists analytics_events_module_idx
  on analytics_events(workspace_id, module, occurred_at desc)
  where module is not null;

create index if not exists auth_password_reset_tokens_user_created_idx
  on auth_password_reset_tokens(user_id, created_at desc);

create index if not exists auth_password_reset_tokens_active_idx
  on auth_password_reset_tokens(token_hash, expires_at)
  where used_at is null;

create unique index if not exists teams_notification_targets_workspace_default_uidx
  on teams_notification_targets(workspace_id)
  where project_id is null and enabled;

create unique index if not exists teams_notification_targets_project_uidx
  on teams_notification_targets(workspace_id, project_id)
  where project_id is not null and enabled;

create index if not exists teams_notification_targets_lookup_idx
  on teams_notification_targets(workspace_id, project_id, enabled);

create index if not exists teams_notification_jobs_due_idx
  on teams_notification_jobs(status, scheduled_for);

create index if not exists teams_notification_jobs_workspace_status_idx
  on teams_notification_jobs(workspace_id, status, scheduled_for desc);

create index if not exists teams_notification_jobs_project_alert_idx
  on teams_notification_jobs(workspace_id, project_id, alert_type, created_at desc);

create index if not exists teams_notification_jobs_entity_idx
  on teams_notification_jobs(workspace_id, entity_type, entity_id);
