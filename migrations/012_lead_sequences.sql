create table if not exists sequence_definitions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  project_id uuid references projects(id) on delete set null,
  name text not null,
  audience text not null default 'Alle',
  goal text not null default '',
  trigger_key text not null,
  status text not null default 'draft' check (status in ('active', 'paused', 'draft')),
  business_hours text not null default 'Mo-Fr 08:00-18:30',
  max_touchpoints_14_days integer not null default 4,
  min_hours_between_touches integer not null default 24,
  config jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists sequence_steps (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  project_id uuid references projects(id) on delete set null,
  sequence_id uuid not null references sequence_definitions(id) on delete cascade,
  position integer not null default 0,
  title text not null,
  delay_label text not null default 'Sofort',
  delay_hours integer not null default 0,
  channel text not null check (channel in ('email', 'whatsapp', 'task', 'call', 'teams', 'calendar')),
  action text not null default '',
  owner_mode text not null default 'contact_owner',
  conditions jsonb not null default '[]',
  stop_rules jsonb not null default '[]',
  template_subject text,
  template_body text,
  task_priority text,
  config jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists sequence_enrollments (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  project_id uuid references projects(id) on delete set null,
  sequence_id uuid references sequence_definitions(id) on delete set null,
  contact_id uuid references contacts(id) on delete cascade,
  lead_id uuid references leads(id) on delete set null,
  deal_id uuid references deals(id) on delete set null,
  status text not null default 'running' check (status in ('running', 'paused', 'completed', 'stopped', 'failed')),
  current_step_id uuid references sequence_steps(id) on delete set null,
  stop_reason text,
  next_action_at timestamptz,
  metadata jsonb not null default '{}',
  enrolled_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists sequence_step_runs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  project_id uuid references projects(id) on delete set null,
  enrollment_id uuid references sequence_enrollments(id) on delete cascade,
  sequence_id uuid references sequence_definitions(id) on delete set null,
  step_id uuid references sequence_steps(id) on delete set null,
  contact_id uuid references contacts(id) on delete set null,
  lead_id uuid references leads(id) on delete set null,
  status text not null default 'scheduled' check (status in ('scheduled', 'ready', 'sent', 'created', 'blocked', 'skipped', 'failed', 'cancelled')),
  channel text not null,
  scheduled_for timestamptz not null,
  executed_at timestamptz,
  provider text,
  provider_message_id text,
  reason text,
  payload jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists sequence_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  project_id uuid references projects(id) on delete set null,
  sequence_id uuid references sequence_definitions(id) on delete set null,
  step_id uuid references sequence_steps(id) on delete set null,
  enrollment_id uuid references sequence_enrollments(id) on delete set null,
  contact_id uuid references contacts(id) on delete set null,
  lead_id uuid references leads(id) on delete set null,
  event_type text not null,
  occurred_at timestamptz not null default now(),
  detail text not null default '',
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create index if not exists sequence_definitions_workspace_status_idx
  on sequence_definitions(workspace_id, status, updated_at desc);

create index if not exists sequence_steps_sequence_position_idx
  on sequence_steps(sequence_id, position);

create index if not exists sequence_enrollments_workspace_status_idx
  on sequence_enrollments(workspace_id, status, next_action_at);

create index if not exists sequence_enrollments_contact_idx
  on sequence_enrollments(contact_id, status);

create index if not exists sequence_step_runs_due_idx
  on sequence_step_runs(status, scheduled_for);

create index if not exists sequence_events_contact_created_idx
  on sequence_events(contact_id, occurred_at desc);
