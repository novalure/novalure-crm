-- Additive MFA-only state. Existing ciphertext, recovery hashes, accounts,
-- memberships and RLS policies are preserved. Apply through the migration ledger.
alter table auth_identities
  add column if not exists mfa_last_totp_counter bigint
    constraint auth_identities_mfa_last_totp_counter_check
    check (mfa_last_totp_counter >= 0);

-- Preserve the exact credential version originally proved, including through
-- session rotation. A reset cannot revive an in-flight older authentication.
alter table auth_login_challenges add column if not exists password_version timestamptz;
alter table auth_sessions add column if not exists password_version timestamptz;

update auth_login_challenges challenge
set password_version = identity.password_changed_at
from auth_identities identity
where challenge.auth_identity_id = identity.id
  and challenge.password_version is null
  and challenge.created_at >= identity.password_changed_at;

update auth_sessions session
set password_version = identity.password_changed_at
from auth_identities identity
where session.auth_identity_id = identity.id
  and session.password_version is null
  and session.created_at >= identity.password_changed_at;

alter table auth_rate_limit_buckets
  drop constraint auth_rate_limit_buckets_scope_check;
alter table auth_rate_limit_buckets
  add constraint auth_rate_limit_buckets_scope_check
    check (scope in ('login_email', 'login_ip', 'reset_email', 'reset_ip', 'mfa_email', 'mfa_ip'));
-- Admit MFA attempts against the previous state while atomically scheduling
-- progressive backoff for the next attempt. Login/reset policies are unchanged.
create or replace function public.reserve_mfa_rate_limit_attempt(emailHash text, ipHash text)
returns table(scope text, "attemptCount" integer, "blockedUntil" timestamptz, blocked boolean)
language plpgsql
security invoker
set search_path = pg_catalog, public, pg_temp
as $function$
declare
  email_bucket public.auth_rate_limit_buckets%rowtype;
  ip_bucket public.auth_rate_limit_buckets%rowtype;
  checked_at timestamptz;
  email_expired boolean;
  ip_expired boolean;
  email_blocked boolean;
  ip_blocked boolean;
  next_email_count integer;
  next_ip_count integer;
begin
  -- Every caller takes these locks in email-then-IP order. Separate commands
  -- ensure a fresh READ COMMITTED snapshot after a concurrent insert wins.
  insert into public.auth_rate_limit_buckets(scope, subject_hash, attempt_count)
  values ('mfa_email', emailHash, 0)
  on conflict on constraint auth_rate_limit_buckets_pkey do nothing;
  select bucket.* into strict email_bucket
  from public.auth_rate_limit_buckets bucket
  where bucket.scope = 'mfa_email' and bucket.subject_hash = emailHash
  for update;

  insert into public.auth_rate_limit_buckets(scope, subject_hash, attempt_count)
  values ('mfa_ip', ipHash, 0)
  on conflict on constraint auth_rate_limit_buckets_pkey do nothing;
  select bucket.* into strict ip_bucket
  from public.auth_rate_limit_buckets bucket
  where bucket.scope = 'mfa_ip' and bucket.subject_hash = ipHash
  for update;

  checked_at := clock_timestamp();
  email_expired := email_bucket.window_started_at <= checked_at - interval '1 hour';
  ip_expired := ip_bucket.window_started_at <= checked_at - interval '1 hour';
  email_blocked := not email_expired and coalesce(email_bucket.blocked_until > checked_at, false);
  ip_blocked := not ip_expired and coalesce(ip_bucket.blocked_until > checked_at, false);

  if not email_blocked and not ip_blocked then
    next_email_count := case when email_expired then 1 else email_bucket.attempt_count + 1 end;
    next_ip_count := case when ip_expired then 1 else ip_bucket.attempt_count + 1 end;

    update public.auth_rate_limit_buckets bucket
    set attempt_count = next_email_count,
        window_started_at = case when email_expired then checked_at else bucket.window_started_at end,
        last_attempt_at = checked_at,
        blocked_until = case when next_email_count < 5 then null
          else checked_at + make_interval(secs => least(3600, power(2, least(20, next_email_count - 5))::integer)) end
    where bucket.scope = 'mfa_email' and bucket.subject_hash = emailHash
    returning bucket.* into email_bucket;

    update public.auth_rate_limit_buckets bucket
    set attempt_count = next_ip_count,
        window_started_at = case when ip_expired then checked_at else bucket.window_started_at end,
        last_attempt_at = checked_at,
        blocked_until = case when next_ip_count < 5 then null
          else checked_at + make_interval(secs => least(3600, power(2, least(20, next_ip_count - 5))::integer)) end
    where bucket.scope = 'mfa_ip' and bucket.subject_hash = ipHash
    returning bucket.* into ip_bucket;
  end if;

  -- Denied attempts preserve both deadlines and counts. The blocked flag
  -- describes admission of this attempt, not the backoff scheduled after it.
  scope := 'mfa_email';
  "attemptCount" := email_bucket.attempt_count;
  "blockedUntil" := email_bucket.blocked_until;
  blocked := email_blocked;
  return next;
  scope := 'mfa_ip';
  "attemptCount" := ip_bucket.attempt_count;
  "blockedUntil" := ip_bucket.blocked_until;
  blocked := ip_blocked;
  return next;
end;
$function$;

revoke all on function public.reserve_mfa_rate_limit_attempt(text, text) from public;
grant execute on function public.reserve_mfa_rate_limit_attempt(text, text) to novalure_app;
