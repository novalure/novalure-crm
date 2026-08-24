alter table public_submission_idempotency
  add column if not exists lease_version bigint not null default 1;

alter table public_submission_idempotency
  drop constraint if exists public_submission_idempotency_lease_version_check;

alter table public_submission_idempotency
  add constraint public_submission_idempotency_lease_version_check
  check (lease_version > 0);

alter table funnel_submissions
  add column if not exists idempotency_key text;

create unique index if not exists funnel_submissions_workspace_idempotency_key_uidx
  on funnel_submissions(workspace_id, idempotency_key)
  where idempotency_key is not null;

alter table funnel_submissions
  drop constraint if exists funnel_submissions_idempotency_key_check;

alter table funnel_submissions
  add constraint funnel_submissions_idempotency_key_check
  check (
    idempotency_key is null
    or idempotency_key ~ '^funnel:[a-f0-9]{64}$'
  );
