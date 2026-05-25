create table if not exists bot_conversations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  project_id uuid references projects(id) on delete set null,
  bot_id uuid references bots(id) on delete set null,
  contact_id uuid references contacts(id) on delete set null,
  lead_id uuid references leads(id) on delete set null,
  title text not null default 'Conversation',
  status text not null default 'open' check (status in ('open', 'handoff', 'resolved')),
  language text not null default 'en',
  model text not null default 'openai/gpt-5.4',
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists bot_messages (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  conversation_id uuid not null references bot_conversations(id) on delete cascade,
  role text not null check (role in ('system', 'user', 'assistant', 'tool')),
  content text not null,
  tool_name text,
  tool_call_id text,
  model text,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create table if not exists bot_tool_calls (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  conversation_id uuid references bot_conversations(id) on delete set null,
  bot_id uuid references bots(id) on delete set null,
  tool_name text not null,
  risk_level text not null default 'low',
  input jsonb not null default '{}',
  output jsonb,
  status text not null default 'completed' check (status in ('pending_approval', 'approved', 'denied', 'completed', 'failed')),
  requires_approval boolean not null default false,
  approved_by_user_id uuid references workspace_users(id) on delete set null,
  approved_at timestamptz,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists approval_requests (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  project_id uuid references projects(id) on delete set null,
  requested_by_user_id uuid references workspace_users(id) on delete set null,
  entity_type text not null,
  entity_id uuid,
  action text not null,
  summary text not null default '',
  payload jsonb not null default '{}',
  status text not null default 'pending' check (status in ('pending', 'approved', 'denied', 'expired')),
  decided_by_user_id uuid references workspace_users(id) on delete set null,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists lead_workflows (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  project_id uuid references projects(id) on delete set null,
  name text not null,
  trigger text not null default 'manual',
  steps jsonb not null default '[]',
  human_approval_required boolean not null default true,
  active boolean not null default true,
  config jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists lead_workflow_runs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  project_id uuid references projects(id) on delete set null,
  workflow_id uuid references lead_workflows(id) on delete set null,
  lead_id uuid references leads(id) on delete set null,
  status text not null default 'running' check (status in ('running', 'approval_required', 'completed', 'failed')),
  input jsonb not null default '{}',
  result jsonb not null default '{}',
  audit_events jsonb not null default '[]',
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists newsletter_sends (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  campaign_id uuid references newsletter_campaigns(id) on delete set null,
  contact_id uuid references contacts(id) on delete set null,
  provider text not null default 'resend',
  provider_message_id text,
  to_email text not null,
  subject text not null,
  status text not null default 'queued' check (status in ('queued', 'sent', 'delivered', 'bounced', 'complained', 'suppressed', 'failed')),
  error text,
  metadata jsonb not null default '{}',
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists provider_connections (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  provider text not null,
  status text not null default 'not_configured',
  account_label text,
  scopes text[] not null default '{}',
  config jsonb not null default '{}',
  last_sync_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, provider)
);

create table if not exists calendar_sync_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  calendar_event_id uuid references calendar_events(id) on delete set null,
  provider text not null default 'microsoft-365',
  provider_event_id text,
  operation text not null,
  status text not null default 'pending' check (status in ('pending', 'synced', 'failed')),
  payload jsonb not null default '{}',
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists call_insights (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  project_id uuid references projects(id) on delete set null,
  contact_id uuid references contacts(id) on delete set null,
  lead_id uuid references leads(id) on delete set null,
  source text not null default 'manual',
  transcript text not null,
  summary text not null default '',
  sentiment text not null default 'neutral',
  objections jsonb not null default '[]',
  action_items jsonb not null default '[]',
  deal_signals jsonb not null default '[]',
  crm_updates jsonb not null default '[]',
  knowledge_gaps jsonb not null default '[]',
  status text not null default 'ready_for_review' check (status in ('ready_for_review', 'approved', 'archived')),
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table knowledge_chunks
  add column if not exists token_count integer not null default 0,
  add column if not exists embedding_model text;

alter table bots
  add column if not exists description text not null default '',
  add column if not exists audience text not null default '',
  add column if not exists language text not null default 'auto',
  add column if not exists tone text not null default '',
  add column if not exists answer_length text not null default 'normal',
  add column if not exists brand_voice text not null default '';

create index if not exists bot_conversations_workspace_updated_idx on bot_conversations(workspace_id, updated_at desc);
create index if not exists bot_messages_conversation_created_idx on bot_messages(conversation_id, created_at asc);
create index if not exists bot_tool_calls_workspace_status_idx on bot_tool_calls(workspace_id, status, created_at desc);
create index if not exists approval_requests_workspace_status_idx on approval_requests(workspace_id, status, created_at desc);
create index if not exists lead_workflow_runs_workspace_status_idx on lead_workflow_runs(workspace_id, status, created_at desc);
create index if not exists newsletter_sends_campaign_status_idx on newsletter_sends(campaign_id, status, created_at desc);
create index if not exists calendar_sync_events_workspace_status_idx on calendar_sync_events(workspace_id, status, created_at desc);
create index if not exists call_insights_workspace_created_idx on call_insights(workspace_id, created_at desc);
