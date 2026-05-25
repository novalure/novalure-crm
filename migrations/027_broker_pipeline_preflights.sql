create table if not exists broker_mandates (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  project_id uuid references projects(id) on delete set null,
  seller_lead_id uuid references leads(id) on delete set null,
  contact_id uuid references contacts(id) on delete set null,
  title text not null default 'Makler-Mandat',
  address text not null default '',
  location text not null default '',
  property_type text,
  condition text,
  area_sqm numeric,
  rooms numeric,
  year_built integer,
  asking_price_cents bigint,
  market_value_cents bigint,
  selling_timeline text,
  motivation text,
  selling_reason text,
  mandate_status text not null default 'open',
  mandate_type text,
  commission_rate numeric,
  documents_status text,
  marketing_status text,
  expiring_broker_contract_at date,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists broker_mandates_workspace_lead_idx
  on broker_mandates(workspace_id, seller_lead_id)
  where seller_lead_id is not null;

create index if not exists broker_mandates_workspace_project_idx
  on broker_mandates(workspace_id, project_id, updated_at desc);

create table if not exists buyer_search_profiles (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  project_id uuid references projects(id) on delete set null,
  buyer_lead_id uuid references leads(id) on delete set null,
  contact_id uuid references contacts(id) on delete set null,
  title text not null default 'Kaeufer-Suchprofil',
  budget_from_cents bigint,
  budget_to_cents bigint,
  financing_status text,
  desired_location text,
  property_type text,
  rooms numeric,
  area_sqm numeric,
  must_have_criteria text[] not null default '{}',
  nice_to_have_criteria text[] not null default '{}',
  purchase_timeline text,
  matching_status text not null default 'open',
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists buyer_search_profiles_workspace_lead_idx
  on buyer_search_profiles(workspace_id, buyer_lead_id)
  where buyer_lead_id is not null;

create index if not exists buyer_search_profiles_workspace_project_idx
  on buyer_search_profiles(workspace_id, project_id, updated_at desc);

create table if not exists crm_pipelines (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  project_id uuid references projects(id) on delete cascade,
  customer_type text,
  operating_model text,
  key text not null,
  name text not null,
  purpose text not null default 'sales',
  is_default boolean not null default false,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists crm_pipelines_workspace_key_idx
  on crm_pipelines(workspace_id, key)
  where project_id is null;

create unique index if not exists crm_pipelines_workspace_project_key_idx
  on crm_pipelines(workspace_id, project_id, key)
  where project_id is not null;

create index if not exists crm_pipelines_workspace_project_idx
  on crm_pipelines(workspace_id, project_id, is_default desc, created_at asc);

create table if not exists crm_pipeline_stages (
  id uuid primary key default gen_random_uuid(),
  pipeline_id uuid not null references crm_pipelines(id) on delete cascade,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  project_id uuid references projects(id) on delete cascade,
  key text not null,
  name text not null,
  position integer not null default 0,
  probability integer not null default 0,
  category text not null default 'work',
  sla_hours integer,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (pipeline_id, key),
  unique (pipeline_id, position)
);

create index if not exists crm_pipeline_stages_workspace_project_idx
  on crm_pipeline_stages(workspace_id, project_id, pipeline_id, position asc);

create table if not exists editor_preflight_runs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  project_id uuid references projects(id) on delete set null,
  editor_type text not null,
  entity_id text,
  status text not null default 'warning',
  checks jsonb not null default '[]',
  blockers text[] not null default '{}',
  warnings text[] not null default '{}',
  metadata jsonb not null default '{}',
  created_by_user_id uuid references workspace_users(id) on delete set null,
  created_at timestamptz not null default now()
);

alter table editor_preflight_runs drop constraint if exists editor_preflight_runs_editor_type_check;
alter table editor_preflight_runs
  add constraint editor_preflight_runs_editor_type_check
  check (editor_type in ('newsletter', 'bot', 'funnel', 'calendar'));

alter table editor_preflight_runs drop constraint if exists editor_preflight_runs_status_check;
alter table editor_preflight_runs
  add constraint editor_preflight_runs_status_check
  check (status in ('pass', 'warning', 'blocked'));

create index if not exists editor_preflight_runs_workspace_entity_idx
  on editor_preflight_runs(workspace_id, editor_type, entity_id, created_at desc);
