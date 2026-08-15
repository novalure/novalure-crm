-- Durable leasing, retry and dead-letter state for outbound job queues.
-- This migration is additive so the preceding application version can keep
-- reading the legacy columns during a rolling deployment.

alter table meeting_notification_jobs
  add column if not exists available_at timestamptz,
  add column if not exists lease_expires_at timestamptz,
  add column if not exists locked_by text,
  add column if not exists last_attempt_at timestamptz,
  add column if not exists attempt_count integer,
  add column if not exists max_attempts integer,
  add column if not exists last_error_category text,
  add column if not exists last_error_message text,
  add column if not exists dead_lettered_at timestamptz,
  add column if not exists idempotency_key text;

update meeting_notification_jobs
set
  available_at = coalesce(available_at, scheduled_for),
  attempt_count = coalesce(attempt_count, attempts, 0),
  max_attempts = coalesce(max_attempts, 5),
  idempotency_key = coalesce(nullif(idempotency_key, ''), 'meeting-notification:' || id::text),
  last_error_message = coalesce(last_error_message, left(error, 500))
where available_at is null
   or attempt_count is null
   or max_attempts is null
   or idempotency_key is null
   or (last_error_message is null and error is not null);

alter table meeting_notification_jobs
  alter column available_at set default now(),
  alter column available_at set not null,
  alter column attempt_count set default 0,
  alter column attempt_count set not null,
  alter column max_attempts set default 5,
  alter column max_attempts set not null,
  alter column idempotency_key set not null;

alter table meeting_notification_jobs
  drop constraint if exists meeting_notification_jobs_status_check;

alter table meeting_notification_jobs
  add constraint meeting_notification_jobs_status_check
  check (status in ('queued', 'retry', 'sending', 'sent', 'failed', 'dead_letter', 'cancelled'));

update meeting_notification_jobs
set status = 'retry', available_at = now(), locked_by = null, updated_at = now()
where status = 'sending' and lease_expires_at is null;

create unique index if not exists meeting_notification_jobs_idempotency_uidx
  on meeting_notification_jobs(workspace_id, idempotency_key);

create index if not exists meeting_notification_jobs_available_idx
  on meeting_notification_jobs(status, available_at, scheduled_for)
  where status in ('queued', 'retry');

create index if not exists meeting_notification_jobs_expired_lease_idx
  on meeting_notification_jobs(lease_expires_at)
  where status = 'sending';

alter table teams_notification_jobs
  add column if not exists available_at timestamptz,
  add column if not exists lease_expires_at timestamptz,
  add column if not exists locked_by text,
  add column if not exists last_attempt_at timestamptz,
  add column if not exists attempt_count integer,
  add column if not exists last_error_category text,
  add column if not exists last_error_message text,
  add column if not exists dead_lettered_at timestamptz;

update teams_notification_jobs
set
  available_at = coalesce(available_at, retry_after, scheduled_for),
  attempt_count = coalesce(attempt_count, attempts, 0),
  last_error_message = coalesce(last_error_message, left(error, 500))
where available_at is null
   or attempt_count is null
   or (last_error_message is null and error is not null);

alter table teams_notification_jobs
  alter column available_at set default now(),
  alter column available_at set not null,
  alter column attempt_count set default 0,
  alter column attempt_count set not null;

alter table teams_notification_jobs
  drop constraint if exists teams_notification_jobs_status_check;

alter table teams_notification_jobs
  add constraint teams_notification_jobs_status_check
  check (status in ('queued', 'retry', 'pending_config', 'sending', 'sent', 'failed', 'dead_letter', 'cancelled'));

update teams_notification_jobs
set status = 'retry', available_at = now(), retry_after = now(), locked_by = null, updated_at = now()
where status = 'sending' and lease_expires_at is null;

create index if not exists teams_notification_jobs_available_idx
  on teams_notification_jobs(status, available_at, scheduled_for)
  where status in ('queued', 'retry');

create index if not exists teams_notification_jobs_expired_lease_idx
  on teams_notification_jobs(lease_expires_at)
  where status = 'sending';

alter table google_notification_jobs
  add column if not exists available_at timestamptz,
  add column if not exists lease_expires_at timestamptz,
  add column if not exists locked_by text,
  add column if not exists last_attempt_at timestamptz,
  add column if not exists attempt_count integer,
  add column if not exists last_error_category text,
  add column if not exists last_error_message text,
  add column if not exists dead_lettered_at timestamptz;

update google_notification_jobs
set
  available_at = coalesce(available_at, retry_after, scheduled_for),
  attempt_count = coalesce(attempt_count, attempts, 0),
  last_error_message = coalesce(last_error_message, left(error, 500))
where available_at is null
   or attempt_count is null
   or (last_error_message is null and error is not null);

alter table google_notification_jobs
  alter column available_at set default now(),
  alter column available_at set not null,
  alter column attempt_count set default 0,
  alter column attempt_count set not null;

alter table google_notification_jobs
  drop constraint if exists google_notification_jobs_status_check;

alter table google_notification_jobs
  add constraint google_notification_jobs_status_check
  check (status in ('queued', 'retry', 'pending_config', 'sending', 'sent', 'failed', 'dead_letter', 'cancelled'));

update google_notification_jobs
set status = 'retry', available_at = now(), retry_after = now(), locked_by = null, updated_at = now()
where status = 'sending' and lease_expires_at is null;

create index if not exists google_notification_jobs_available_idx
  on google_notification_jobs(status, available_at, scheduled_for)
  where status in ('queued', 'retry');

create index if not exists google_notification_jobs_expired_lease_idx
  on google_notification_jobs(lease_expires_at)
  where status = 'sending';

alter table property_export_jobs
  add column if not exists available_at timestamptz,
  add column if not exists lease_expires_at timestamptz,
  add column if not exists locked_by text,
  add column if not exists last_attempt_at timestamptz,
  add column if not exists attempt_count integer,
  add column if not exists max_attempts integer,
  add column if not exists last_error_category text,
  add column if not exists last_error_message text,
  add column if not exists dead_lettered_at timestamptz,
  add column if not exists idempotency_key text;

update property_export_jobs
set
  available_at = coalesce(available_at, created_at),
  attempt_count = coalesce(attempt_count, 0),
  max_attempts = coalesce(max_attempts, 3),
  idempotency_key = coalesce(nullif(idempotency_key, ''), 'property-export:' || id::text),
  last_error_message = coalesce(last_error_message, left(error, 500))
where available_at is null
   or attempt_count is null
   or max_attempts is null
   or idempotency_key is null
   or (last_error_message is null and error is not null);

alter table property_export_jobs
  alter column available_at set default now(),
  alter column available_at set not null,
  alter column attempt_count set default 0,
  alter column attempt_count set not null,
  alter column max_attempts set default 3,
  alter column max_attempts set not null,
  alter column idempotency_key set not null;

alter table property_export_jobs
  drop constraint if exists property_export_jobs_status_check;

alter table property_export_jobs
  add constraint property_export_jobs_status_check
  check (status in ('queued', 'retry', 'running', 'completed', 'failed', 'dead_letter', 'cancelled'));

update property_export_jobs
set status = 'retry', available_at = now(), locked_by = null, updated_at = now()
where status = 'running' and lease_expires_at is null;

create unique index if not exists property_export_jobs_idempotency_uidx
  on property_export_jobs(workspace_id, idempotency_key);

create index if not exists property_export_jobs_available_idx
  on property_export_jobs(status, available_at, created_at)
  where status in ('queued', 'retry');

create index if not exists property_export_jobs_expired_lease_idx
  on property_export_jobs(lease_expires_at)
  where status = 'running';
