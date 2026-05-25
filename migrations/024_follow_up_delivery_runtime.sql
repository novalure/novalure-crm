create table if not exists crm_outreach_deliveries (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  project_id uuid references projects(id) on delete set null,
  contact_id uuid references contacts(id) on delete set null,
  lead_id uuid references leads(id) on delete set null,
  task_id uuid references tasks(id) on delete set null,
  follow_up_action_id uuid references crm_follow_up_actions(id) on delete set null,
  consent_decision_id uuid references consent_policy_decisions(id) on delete set null,
  channel text not null,
  purpose text not null default 'salesFollowUp',
  provider text not null default 'manual',
  recipient text not null default '',
  subject text not null default '',
  status text not null default 'queued',
  provider_message_id text,
  error text,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table crm_outreach_deliveries
  add column if not exists project_id uuid references projects(id) on delete set null,
  add column if not exists contact_id uuid references contacts(id) on delete set null,
  add column if not exists lead_id uuid references leads(id) on delete set null,
  add column if not exists task_id uuid references tasks(id) on delete set null,
  add column if not exists follow_up_action_id uuid references crm_follow_up_actions(id) on delete set null,
  add column if not exists consent_decision_id uuid references consent_policy_decisions(id) on delete set null,
  add column if not exists channel text not null default 'E-Mail',
  add column if not exists purpose text not null default 'salesFollowUp',
  add column if not exists provider text not null default 'manual',
  add column if not exists recipient text not null default '',
  add column if not exists subject text not null default '',
  add column if not exists status text not null default 'queued',
  add column if not exists provider_message_id text,
  add column if not exists error text,
  add column if not exists metadata jsonb not null default '{}',
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

alter table crm_outreach_deliveries drop constraint if exists crm_outreach_deliveries_status_check;
alter table crm_outreach_deliveries
  add constraint crm_outreach_deliveries_status_check
  check (status in ('queued', 'sent', 'delivered', 'blocked', 'failed', 'pending_config'));

create index if not exists crm_outreach_deliveries_workspace_status_idx
  on crm_outreach_deliveries(workspace_id, project_id, status, created_at desc);

create index if not exists crm_outreach_deliveries_follow_up_idx
  on crm_outreach_deliveries(follow_up_action_id, created_at desc);
