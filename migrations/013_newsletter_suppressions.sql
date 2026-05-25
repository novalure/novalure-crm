create table if not exists newsletter_suppressions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  campaign_id uuid references newsletter_campaigns(id) on delete set null,
  email text not null,
  reason text not null default 'unsubscribe' check (reason in ('unsubscribe', 'bounce', 'complaint', 'manual')),
  source text not null default 'Newsletter-Abmeldelink',
  metadata jsonb not null default '{}',
  captured_at timestamptz not null default now()
);

create unique index if not exists newsletter_suppressions_workspace_email_idx
  on newsletter_suppressions(workspace_id, lower(email));

create index if not exists newsletter_suppressions_workspace_captured_idx
  on newsletter_suppressions(workspace_id, captured_at desc);
