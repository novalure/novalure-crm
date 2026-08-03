alter table workspace_users
  add column if not exists session_version integer not null default 1;

create table if not exists auth_rate_limits (
  action text not null,
  key_hash text not null,
  bucket_started_at timestamptz not null default now(),
  attempt_count integer not null default 0,
  blocked_until timestamptz,
  updated_at timestamptz not null default now(),
  primary key (action, key_hash)
);

create index if not exists auth_rate_limits_cleanup_idx
  on auth_rate_limits(updated_at);

alter table media_assets
  add column if not exists blob_url text,
  add column if not exists legacy_blob_url text,
  add column if not exists sha256 text,
  add column if not exists scan_status text not null default 'pending',
  add column if not exists scan_error text,
  add column if not exists storage_access text not null default 'private',
  add column if not exists migrated_at timestamptz,
  add column if not exists updated_at timestamptz not null default now();

update media_assets
set blob_url = url,
    legacy_blob_url = url,
    storage_access = 'legacy_public'
where storage_provider = 'vercel-blob'
  and blob_url is null;

alter table media_assets drop constraint if exists media_assets_scan_status_check;
alter table media_assets
  add constraint media_assets_scan_status_check
  check (scan_status in ('pending', 'clean', 'infected', 'failed'));

alter table media_assets drop constraint if exists media_assets_storage_access_check;
alter table media_assets
  add constraint media_assets_storage_access_check
  check (storage_access in ('private', 'legacy_public'));

create table if not exists media_private_migration_manifest (
  id uuid primary key default gen_random_uuid(),
  asset_id uuid not null unique references media_assets(id) on delete cascade,
  legacy_locator_hash text not null,
  private_path text not null,
  size_bytes bigint not null,
  sha256 text not null,
  status text not null check (status in ('copied', 'cleanup_pending', 'completed', 'failed')),
  copied_at timestamptz not null default now(),
  switched_at timestamptz,
  legacy_deleted_at timestamptz,
  last_error text,
  updated_at timestamptz not null default now()
);

create index if not exists media_private_migration_manifest_status_idx
  on media_private_migration_manifest(status, updated_at);

alter table property_reservations
  add column if not exists idempotency_key text;

create unique index if not exists property_reservations_workspace_idempotency_uidx
  on property_reservations(workspace_id, idempotency_key)
  where idempotency_key is not null;

create table if not exists reservation_workflow_requests (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  idempotency_key text not null,
  action text not null check (action in ('create', 'extend', 'expire', 'convert')),
  reservation_id uuid references property_reservations(id) on delete set null,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (workspace_id, idempotency_key)
);

alter table teams_notification_jobs
  add column if not exists run_id uuid,
  add column if not exists lease_expires_at timestamptz,
  add column if not exists last_attempt_at timestamptz;

alter table google_notification_jobs
  add column if not exists run_id uuid,
  add column if not exists lease_expires_at timestamptz,
  add column if not exists last_attempt_at timestamptz;

alter table meeting_notification_jobs
  add column if not exists run_id uuid,
  add column if not exists lease_expires_at timestamptz,
  add column if not exists last_attempt_at timestamptz,
  add column if not exists retry_after timestamptz,
  add column if not exists max_attempts integer not null default 3;

alter table teams_notification_jobs drop constraint if exists teams_notification_jobs_status_check;
alter table teams_notification_jobs
  add constraint teams_notification_jobs_status_check
  check (status in ('queued', 'pending_config', 'sending', 'sent', 'failed', 'dead_letter', 'cancelled'));

alter table google_notification_jobs drop constraint if exists google_notification_jobs_status_check;
alter table google_notification_jobs
  add constraint google_notification_jobs_status_check
  check (status in ('queued', 'pending_config', 'sending', 'sent', 'failed', 'dead_letter', 'cancelled'));

alter table meeting_notification_jobs drop constraint if exists meeting_notification_jobs_status_check;
alter table meeting_notification_jobs
  add constraint meeting_notification_jobs_status_check
  check (status in ('queued', 'sending', 'sent', 'failed', 'dead_letter', 'cancelled'));

create index if not exists teams_notification_jobs_lease_idx
  on teams_notification_jobs(status, lease_expires_at, scheduled_for);

create index if not exists google_notification_jobs_lease_idx
  on google_notification_jobs(status, lease_expires_at, scheduled_for);

create index if not exists meeting_notification_jobs_lease_idx
  on meeting_notification_jobs(status, lease_expires_at, scheduled_for);
