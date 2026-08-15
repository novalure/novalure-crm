-- One-time consumption ledger for short-lived, session-bound CSRF tokens.
-- Only SHA-256 hashes are persisted; the signed token and session cookie are
-- never stored. A unique token hash makes concurrent replay fail atomically.
create table if not exists csrf_token_consumptions (
  token_hash text primary key,
  session_hash text not null,
  request_method text not null,
  request_path text not null,
  expires_at timestamptz not null,
  consumed_at timestamptz not null default now(),
  constraint csrf_token_consumptions_token_hash_check
    check (token_hash ~ '^[a-f0-9]{64}$'),
  constraint csrf_token_consumptions_session_hash_check
    check (session_hash ~ '^[a-f0-9]{64}$'),
  constraint csrf_token_consumptions_method_check
    check (request_method in ('DELETE', 'PATCH', 'POST', 'PUT')),
  constraint csrf_token_consumptions_path_check
    check (request_path like '/api/%' and length(request_path) <= 2048),
  constraint csrf_token_consumptions_expiry_check
    check (expires_at > consumed_at - interval '30 seconds')
);

create index if not exists csrf_token_consumptions_expiry_idx
  on csrf_token_consumptions(expires_at);

revoke all on table csrf_token_consumptions from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'novalure_app') then
    grant select, insert, delete on table csrf_token_consumptions to novalure_app;
  end if;
end
$$;
