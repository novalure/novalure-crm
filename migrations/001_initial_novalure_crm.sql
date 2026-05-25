create extension if not exists pgcrypto;
create extension if not exists vector;

create table workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  plan text not null default 'Growth Workspace',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table workspace_users (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  name text not null,
  email text not null,
  role text not null check (role in ('owner', 'admin', 'agent', 'assistant')),
  status text not null default 'active' check (status in ('active', 'invited')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, email)
);

create table projects (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  name text not null,
  type text not null,
  status text not null default 'Aktiv',
  default_pipeline_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table organizations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  project_id uuid references projects(id) on delete set null,
  owner_user_id uuid references workspace_users(id) on delete set null,
  name text not null,
  type text not null,
  domain text,
  city text not null default '',
  lifecycle_stage text not null default 'Lead',
  last_activity_at timestamptz,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table contacts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  project_id uuid references projects(id) on delete set null,
  organization_id uuid references organizations(id) on delete set null,
  name text not null,
  role text not null,
  source text not null default 'Manual',
  intent text not null default '',
  consent_label text not null default 'Unbekannt',
  email text,
  phone text,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table contact_relationships (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  contact_id uuid not null references contacts(id) on delete cascade,
  organization_id uuid references organizations(id) on delete set null,
  project_id uuid references projects(id) on delete set null,
  role text not null,
  influence text not null default 'mittel',
  is_primary boolean not null default false,
  created_at timestamptz not null default now()
);

create table contact_timeline_items (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  contact_id uuid not null references contacts(id) on delete cascade,
  project_id uuid references projects(id) on delete set null,
  organization_id uuid references organizations(id) on delete set null,
  channel text not null,
  title text not null,
  detail text not null default '',
  outcome text not null default 'info',
  occurred_at timestamptz not null default now(),
  metadata jsonb not null default '{}'
);

create table leads (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  project_id uuid references projects(id) on delete set null,
  contact_id uuid references contacts(id) on delete set null,
  assigned_to_user_id uuid references workspace_users(id) on delete set null,
  source text not null default 'Manual',
  type text not null,
  status text not null default 'Neu',
  score integer not null default 0 check (score between 0 and 100),
  budget text,
  intent text not null default '',
  next_action text not null default '',
  received_at timestamptz not null default now(),
  sla_due_at timestamptz,
  last_contact_at timestamptz,
  next_contact_at timestamptz,
  region text,
  object_type text,
  rooms numeric(4,1),
  area_sqm numeric(10,2),
  hot_status boolean not null default false,
  buyer_profile jsonb not null default '{}',
  seller_profile jsonb not null default '{}',
  investor_profile jsonb not null default '{}',
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table seller_listings (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  project_id uuid references projects(id) on delete set null,
  seller_lead_id uuid references leads(id) on delete set null,
  title text not null,
  address text not null,
  region text not null,
  object_type text not null,
  area_sqm numeric(10,2) not null,
  rooms numeric(4,1),
  year_built integer,
  market_value_cents bigint not null default 0,
  target_price_cents bigint not null default 0,
  expected_gross_yield numeric(5,2),
  mandate_ends_at date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table deals (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  project_id uuid references projects(id) on delete set null,
  contact_id uuid references contacts(id) on delete set null,
  organization_id uuid references organizations(id) on delete set null,
  owner_user_id uuid references workspace_users(id) on delete set null,
  lead_id uuid references leads(id) on delete set null,
  name text not null,
  stage text not null default 'Neuer Lead',
  value_cents bigint not null default 0,
  probability integer not null default 0 check (probability between 0 and 100),
  expected_close_date date,
  risk_level text not null default 'mittel',
  source text not null default 'Manual',
  next_action text not null default '',
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table tasks (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  project_id uuid references projects(id) on delete set null,
  contact_id uuid references contacts(id) on delete set null,
  lead_id uuid references leads(id) on delete set null,
  owner_user_id uuid references workspace_users(id) on delete set null,
  title text not null,
  due_at timestamptz,
  priority text not null default 'Normal',
  status text not null default 'open',
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table calendar_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  project_id uuid references projects(id) on delete set null,
  contact_id uuid references contacts(id) on delete set null,
  lead_id uuid references leads(id) on delete set null,
  owner_user_id uuid references workspace_users(id) on delete set null,
  title text not null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  location text not null default 'Telefon',
  status text not null default 'geplant',
  preparation jsonb not null default '[]',
  outcome_goal text not null default '',
  teams_join_url text,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table funnels (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  project_id uuid references projects(id) on delete set null,
  owner_user_id uuid references workspace_users(id) on delete set null,
  name text not null,
  goal text not null,
  audience text not null,
  entry_channel text not null,
  status text not null default 'entwurf',
  visits integer not null default 0,
  leads_count integer not null default 0,
  conversion_rate numeric(6,2) not null default 0,
  blueprint jsonb not null default '{}',
  tracking jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table funnel_steps (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  project_id uuid references projects(id) on delete set null,
  funnel_id uuid not null references funnels(id) on delete cascade,
  name text not null,
  channel text not null,
  status text not null default 'entwurf',
  position integer not null default 0,
  visits integer not null default 0,
  leads_count integer not null default 0,
  conversion_rate numeric(6,2) not null default 0,
  drop_off_reason text not null default '',
  next_optimization text not null default '',
  bot_rule_id uuid,
  config jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table funnel_submissions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  project_id uuid references projects(id) on delete set null,
  funnel_id uuid not null references funnels(id) on delete cascade,
  contact_id uuid references contacts(id) on delete set null,
  lead_id uuid references leads(id) on delete set null,
  mode text not null default 'live',
  score integer not null default 0,
  answers jsonb not null default '{}',
  consent jsonb not null default '{}',
  tracking jsonb not null default '{}',
  raw_payload jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create table conversations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  project_id uuid references projects(id) on delete set null,
  contact_id uuid references contacts(id) on delete set null,
  lead_id uuid references leads(id) on delete set null,
  channel text not null,
  direction text not null,
  summary text not null default '',
  sentiment text not null default 'neutral',
  last_message_at timestamptz not null default now(),
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table knowledge_sources (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  project_id uuid references projects(id) on delete set null,
  name text not null,
  source_type text not null default 'manual',
  status text not null default 'needs-review',
  coverage text not null default '',
  item_count integer not null default 0,
  location text,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table knowledge_chunks (
  id uuid primary key default gen_random_uuid(),
  source_id uuid not null references knowledge_sources(id) on delete cascade,
  chunk_index integer not null,
  content text not null,
  citation_title text not null,
  citation_url text,
  embedding vector(1536),
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  unique (source_id, chunk_index)
);

create index knowledge_chunks_embedding_idx
on knowledge_chunks using ivfflat (embedding vector_cosine_ops)
with (lists = 100);

create table newsletter_segments (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  project_id uuid references projects(id) on delete set null,
  name text not null,
  audience text not null,
  language text not null default 'de',
  source text not null default 'CRM',
  contacts_count integer not null default 0,
  opt_ins integer not null default 0,
  health text not null default 'bereit',
  rules jsonb not null default '[]',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table newsletter_campaigns (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  project_id uuid references projects(id) on delete set null,
  segment_id uuid references newsletter_segments(id) on delete set null,
  name text not null,
  subject text not null,
  preview_text text not null default '',
  status text not null default 'entwurf',
  goal text not null default '',
  recipients integer not null default 0,
  send_at timestamptz,
  metrics jsonb not null default '{}',
  content_blocks jsonb not null default '[]',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table consent_records (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  contact_id uuid not null references contacts(id) on delete cascade,
  project_id uuid references projects(id) on delete set null,
  channel text not null,
  status text not null default 'Unbekannt',
  source text not null default 'Manual',
  captured_at timestamptz not null default now(),
  metadata jsonb not null default '{}'
);

create table automations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  project_id uuid references projects(id) on delete set null,
  name text not null,
  channel text not null,
  status text not null default 'Geplant',
  detail text not null default '',
  config jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table bot_language_rules (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  project_id uuid references projects(id) on delete set null,
  channel text not null,
  mode text not null default 'auto',
  fallback_language text not null default 'de',
  fixed_language text,
  detection_signals text[] not null default '{}',
  confidence integer not null default 0,
  prompt_rule text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table bots (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  project_id uuid references projects(id) on delete set null,
  name text not null,
  role text not null,
  status text not null default 'Entwurf',
  model text not null default 'openai/gpt-5.4',
  strict_knowledge boolean not null default true,
  config jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table audit_logs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  actor_user_id uuid references workspace_users(id) on delete set null,
  action text not null,
  entity_type text not null,
  entity_id uuid,
  before jsonb,
  after jsonb,
  created_at timestamptz not null default now()
);

create index projects_workspace_idx on projects(workspace_id);
create index contacts_workspace_project_idx on contacts(workspace_id, project_id);
create index organizations_workspace_project_idx on organizations(workspace_id, project_id);
create index leads_workspace_project_status_idx on leads(workspace_id, project_id, status);
create index leads_assigned_due_idx on leads(assigned_to_user_id, sla_due_at);
create index deals_workspace_stage_idx on deals(workspace_id, stage);
create index tasks_workspace_status_due_idx on tasks(workspace_id, status, due_at);
create index calendar_events_workspace_start_idx on calendar_events(workspace_id, starts_at);
create index funnel_submissions_funnel_created_idx on funnel_submissions(funnel_id, created_at desc);
create index conversations_contact_last_idx on conversations(contact_id, last_message_at desc);
create index audit_logs_workspace_created_idx on audit_logs(workspace_id, created_at desc);
