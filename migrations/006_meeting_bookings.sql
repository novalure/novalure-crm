create table if not exists meeting_bookings (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  meeting_page_id uuid references meeting_pages(id) on delete set null,
  contact_id uuid references contacts(id) on delete set null,
  slug text not null,
  title text not null,
  contact_name text not null,
  contact_email text not null,
  contact_note text not null default '',
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  calendar_provider text not null default 'microsoft',
  meeting_provider text not null default 'microsoft-teams',
  status text not null default 'requested' check (status in ('requested', 'confirmed', 'rescheduled', 'cancelled')),
  source text not null default 'booking_page',
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists meeting_notification_jobs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  meeting_page_id uuid references meeting_pages(id) on delete cascade,
  booking_id uuid references meeting_bookings(id) on delete cascade,
  kind text not null check (kind in ('confirmation', 'reminder', 'follow_up')),
  channel text not null default 'email',
  scheduled_for timestamptz not null,
  recipient_email text not null,
  subject text not null,
  title text not null,
  body text not null,
  tokens jsonb not null default '{}',
  status text not null default 'queued' check (status in ('queued', 'sending', 'sent', 'failed', 'cancelled')),
  provider text,
  provider_message_id text,
  attempts integer not null default 0,
  error text,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists meeting_bookings_workspace_created_idx on meeting_bookings(workspace_id, created_at desc);
create index if not exists meeting_bookings_page_starts_idx on meeting_bookings(meeting_page_id, starts_at);
create index if not exists meeting_notification_jobs_due_idx on meeting_notification_jobs(status, scheduled_for);
create index if not exists meeting_notification_jobs_workspace_status_idx on meeting_notification_jobs(workspace_id, status, scheduled_for);
