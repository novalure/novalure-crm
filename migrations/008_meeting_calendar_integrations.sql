alter table meeting_pages
  add column if not exists meeting_type text not null default 'personal'
  check (meeting_type in ('personal', 'group', 'round_robin'));

create index if not exists meeting_pages_workspace_type_idx
  on meeting_pages(workspace_id, meeting_type, status);

create unique index if not exists meeting_bookings_active_slot_idx
  on meeting_bookings(meeting_page_id, starts_at)
  where status in ('requested', 'confirmed', 'rescheduled');

alter table provider_connections
  add column if not exists expires_at timestamptz,
  add column if not exists refreshed_at timestamptz,
  add column if not exists error text;

create index if not exists provider_connections_workspace_provider_idx
  on provider_connections(workspace_id, provider, status);

create index if not exists meeting_bookings_public_action_idx
  on meeting_bookings((metadata->>'publicToken'))
  where metadata ? 'publicToken';
