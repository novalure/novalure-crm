-- Opaque, database-wide abuse and replay guards for anonymous form submissions.
-- All keys are keyed SHA-256 hashes; raw IP addresses, identifiers and request
-- bodies are deliberately never persisted.

create table if not exists public_submission_rate_limits (
  key_hash text not null,
  bucket_started_at timestamptz not null,
  window_seconds integer not null,
  limit_count integer not null,
  request_count integer not null default 1,
  expires_at timestamptz not null,
  primary key (key_hash, bucket_started_at),
  constraint public_submission_rate_limits_key_hash_check
    check (key_hash ~ '^[a-f0-9]{64}$'),
  constraint public_submission_rate_limits_window_check
    check (window_seconds between 60 and 86400),
  constraint public_submission_rate_limits_limit_check
    check (limit_count between 1 and 10000),
  constraint public_submission_rate_limits_count_check
    check (request_count between 1 and 100000),
  constraint public_submission_rate_limits_expiry_check
    check (expires_at > bucket_started_at)
);

create index if not exists public_submission_rate_limits_expiry_idx
  on public_submission_rate_limits(expires_at);

create table if not exists public_submission_idempotency (
  idempotency_hash text primary key,
  action_hash text not null,
  scope_hash text not null,
  request_hash text not null,
  state text not null default 'processing',
  response_payload jsonb,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  expires_at timestamptz not null,
  constraint public_submission_idempotency_id_hash_check
    check (idempotency_hash ~ '^[a-f0-9]{64}$'),
  constraint public_submission_idempotency_action_hash_check
    check (action_hash ~ '^[a-f0-9]{64}$'),
  constraint public_submission_idempotency_scope_hash_check
    check (scope_hash ~ '^[a-f0-9]{64}$'),
  constraint public_submission_idempotency_request_hash_check
    check (request_hash ~ '^[a-f0-9]{64}$'),
  constraint public_submission_idempotency_state_check
    check (state in ('processing', 'completed')),
  constraint public_submission_idempotency_response_check
    check (
      (state = 'processing' and response_payload is null and completed_at is null)
      or
      (state = 'completed' and response_payload is not null and completed_at is not null)
    ),
  constraint public_submission_idempotency_expiry_check
    check (expires_at > created_at)
);

create index if not exists public_submission_idempotency_expiry_idx
  on public_submission_idempotency(expires_at);

revoke all on table public_submission_rate_limits from public;
revoke all on table public_submission_idempotency from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'novalure_app') then
    grant select, insert, update, delete on table public_submission_rate_limits to novalure_app;
    grant select, insert, update, delete on table public_submission_idempotency to novalure_app;
  end if;
end
$$;
