create table if not exists forms (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  project_id uuid references projects(id) on delete set null,
  owner_user_id uuid references workspace_users(id) on delete set null,
  funnel_id uuid references funnels(id) on delete set null,
  name text not null,
  slug text not null,
  status text not null default 'entwurf',
  variant text not null default 'embed',
  template text not null default 'contact',
  crm_target text not null default 'lead',
  pipeline_stage text not null default 'Lead Inbox',
  owner_mode text not null default 'roundRobin',
  campaign text not null default '',
  tags text[] not null default '{}',
  fields jsonb not null default '[]',
  actions jsonb not null default '{}',
  settings jsonb not null default '{}',
  visits_count integer not null default 0,
  submissions_count integer not null default 0,
  conversion_rate numeric(6,2) not null default 0,
  last_submission_at timestamptz,
  embed_status text not null default 'unchecked',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, slug)
);

create table if not exists form_submissions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  project_id uuid references projects(id) on delete set null,
  form_id uuid not null references forms(id) on delete cascade,
  funnel_id uuid references funnels(id) on delete set null,
  contact_id uuid references contacts(id) on delete set null,
  lead_id uuid references leads(id) on delete set null,
  deal_id uuid references deals(id) on delete set null,
  task_id uuid references tasks(id) on delete set null,
  mode text not null default 'live',
  status text not null default 'processed',
  score integer not null default 0 check (score between 0 and 100),
  answers jsonb not null default '{}',
  consent jsonb not null default '{}',
  tracking jsonb not null default '{}',
  raw_payload jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create index if not exists forms_workspace_status_idx on forms(workspace_id, status);
create index if not exists forms_slug_idx on forms(slug);
create index if not exists form_submissions_form_created_idx on form_submissions(form_id, created_at desc);
create index if not exists form_submissions_workspace_created_idx on form_submissions(workspace_id, created_at desc);
