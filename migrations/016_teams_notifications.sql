create table if not exists teams_notification_targets (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  project_id uuid references projects(id) on delete cascade,
  label text not null default 'Workspace Teams',
  destination_type text not null default 'incoming_webhook'
    check (destination_type in ('incoming_webhook', 'channel', 'chat')),
  webhook_url text,
  team_id text,
  channel_id text,
  chat_id text,
  channel_name text,
  enabled boolean not null default true,
  alert_types text[] not null default array[
    'lead_sla_overdue',
    'meeting_booked',
    'customer_access_risk',
    'deal_stage_changed'
  ],
  metadata jsonb not null default '{}',
  created_by_user_id uuid references workspace_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists teams_notification_targets_workspace_default_uidx
  on teams_notification_targets(workspace_id)
  where project_id is null and enabled;

create unique index if not exists teams_notification_targets_project_uidx
  on teams_notification_targets(workspace_id, project_id)
  where project_id is not null and enabled;

create index if not exists teams_notification_targets_lookup_idx
  on teams_notification_targets(workspace_id, project_id, enabled);

create table if not exists teams_notification_jobs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  project_id uuid references projects(id) on delete cascade,
  target_id uuid references teams_notification_targets(id) on delete set null,
  alert_type text not null check (
    alert_type in (
      'lead_sla_overdue',
      'meeting_booked',
      'customer_access_risk',
      'deal_stage_changed'
    )
  ),
  severity text not null default 'warning' check (severity in ('info', 'warning', 'critical')),
  status text not null default 'queued' check (status in ('queued', 'sending', 'sent', 'failed', 'cancelled')),
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

create index if not exists teams_notification_jobs_due_idx
  on teams_notification_jobs(status, scheduled_for);

create index if not exists teams_notification_jobs_workspace_status_idx
  on teams_notification_jobs(workspace_id, status, scheduled_for desc);

create index if not exists teams_notification_jobs_project_alert_idx
  on teams_notification_jobs(workspace_id, project_id, alert_type, created_at desc);

create index if not exists teams_notification_jobs_entity_idx
  on teams_notification_jobs(workspace_id, entity_type, entity_id);
