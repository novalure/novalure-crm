alter table contacts
  add column if not exists archived_at timestamptz,
  add column if not exists archived_by_user_id uuid references workspace_users(id) on delete set null;

create index if not exists contacts_workspace_active_updated_idx
  on contacts(workspace_id, updated_at desc)
  where archived_at is null;

create index if not exists contacts_workspace_archived_idx
  on contacts(workspace_id, archived_at desc)
  where archived_at is not null;
