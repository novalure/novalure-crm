-- Central authentication identities, revocable opaque sessions, distributed
-- rate limits, one-time reset exchanges, MFA recovery codes and append-only
-- authentication audit events.

create table if not exists auth_identities (
  id uuid primary key default gen_random_uuid(),
  normalized_email text not null unique,
  display_email text not null,
  password_hash text,
  credential_state text not null default 'reset_required'
    check (credential_state in ('active', 'reset_required', 'disabled')),
  mfa_secret_ciphertext text,
  mfa_enabled_at timestamptz,
  password_changed_at timestamptz,
  disabled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint auth_identities_normalized_email_check
    check (
      normalized_email = lower(btrim(normalized_email))
      and normalized_email <> ''
      and normalized_email !~ '[[:space:]]'
    ),
  constraint auth_identities_display_email_check check (btrim(display_email) <> ''),
  constraint auth_identities_mfa_state_check
    check ((mfa_enabled_at is null) = (mfa_secret_ciphertext is null))
);

do $$
begin
  if exists (
    select 1
    from workspace_users
    where btrim(email) = ''
  ) then
    raise exception 'workspace_users contains an empty email; central auth identity backfill refused';
  end if;

  if exists (
    select 1
    from workspace_users
    group by workspace_id, lower(btrim(email))
    having count(*) > 1
  ) then
    raise exception 'workspace_users contains case-insensitive duplicate emails in one workspace; central auth identity backfill refused';
  end if;
end
$$;

insert into auth_identities (
  normalized_email,
  display_email,
  password_hash,
  credential_state,
  password_changed_at
)
select
  lower(btrim(wu.email)) as normalized_email,
  min(btrim(wu.email)) as display_email,
  case
    when count(distinct wu.password_hash) filter (where wu.password_hash is not null) = 1
      then min(wu.password_hash) filter (where wu.password_hash is not null)
    else null
  end as password_hash,
  case
    when bool_and(wu.status = 'suspended') then 'disabled'
    when count(distinct wu.password_hash) filter (where wu.password_hash is not null) = 1 then 'active'
    else 'reset_required'
  end as credential_state,
  case
    when count(distinct wu.password_hash) filter (where wu.password_hash is not null) = 1 then now()
    else null
  end as password_changed_at
from workspace_users wu
group by lower(btrim(wu.email))
on conflict (normalized_email) do nothing;

alter table workspace_users
  add column if not exists auth_identity_id uuid references auth_identities(id) on delete restrict;

update workspace_users wu
set auth_identity_id = identity.id
from auth_identities identity
where wu.auth_identity_id is null
  and identity.normalized_email = lower(btrim(wu.email));

alter table workspace_users
  alter column auth_identity_id set not null;

create unique index if not exists workspace_users_workspace_identity_unique
  on workspace_users(workspace_id, auth_identity_id);

create unique index if not exists workspace_users_id_identity_uidx
  on workspace_users(id, auth_identity_id);

create unique index if not exists workspace_users_id_identity_workspace_uidx
  on workspace_users(id, auth_identity_id, workspace_id);

create index if not exists workspace_users_auth_identity_idx
  on workspace_users(auth_identity_id, status, workspace_id);

create or replace function public.assign_workspace_user_auth_identity()
returns trigger
language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
declare
  identity_id uuid;
  normalized text;
begin
  normalized := lower(btrim(new.email));
  if normalized = '' or normalized ~ '[[:space:]]' then
    raise exception 'workspace user email is not valid for central authentication';
  end if;

  insert into public.auth_identities (
    normalized_email,
    display_email,
    password_hash,
    credential_state,
    password_changed_at
  )
  values (
    normalized,
    btrim(new.email),
    new.password_hash,
    case when new.password_hash is null then 'reset_required' else 'active' end,
    case when new.password_hash is null then null else now() end
  )
  on conflict (normalized_email) do update
    set display_email = excluded.display_email,
        updated_at = now()
  returning id into identity_id;

  new.auth_identity_id := identity_id;

  if new.password_hash is not null
     and (tg_op = 'INSERT' or old.password_hash is distinct from new.password_hash) then
    update public.auth_identities
    set password_hash = new.password_hash,
        credential_state = 'active',
        disabled_at = null,
        password_changed_at = now(),
        updated_at = now()
    where id = identity_id;
  end if;

  return new;
end
$$;

drop trigger if exists workspace_users_assign_auth_identity on workspace_users;
create trigger workspace_users_assign_auth_identity
before insert or update of email, password_hash on workspace_users
for each row execute function public.assign_workspace_user_auth_identity();

create table if not exists auth_sessions (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique,
  auth_identity_id uuid not null references auth_identities(id) on delete cascade,
  workspace_user_id uuid not null references workspace_users(id) on delete cascade,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  mfa_verified_at timestamptz,
  ip_hash text,
  user_agent_hash text,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  revoked_reason text,
  rotated_from_session_id uuid references auth_sessions(id) on delete set null,
  constraint auth_sessions_token_hash_check check (token_hash ~ '^[a-f0-9]{64}$'),
  constraint auth_sessions_ip_hash_check check (ip_hash is null or ip_hash ~ '^[a-f0-9]{64}$'),
  constraint auth_sessions_user_agent_hash_check
    check (user_agent_hash is null or user_agent_hash ~ '^[a-f0-9]{64}$'),
  constraint auth_sessions_expiry_check check (expires_at > created_at),
  constraint auth_sessions_revocation_reason_check
    check ((revoked_at is null and revoked_reason is null) or (revoked_at is not null and revoked_reason is not null)),
  constraint auth_sessions_membership_identity_workspace_fk
    foreign key (workspace_user_id, auth_identity_id, workspace_id)
    references workspace_users(id, auth_identity_id, workspace_id)
    on delete cascade
);

create index if not exists auth_sessions_active_token_idx
  on auth_sessions(token_hash, expires_at)
  where revoked_at is null;

create index if not exists auth_sessions_identity_active_idx
  on auth_sessions(auth_identity_id, expires_at desc)
  where revoked_at is null;

create index if not exists auth_sessions_membership_active_idx
  on auth_sessions(workspace_user_id, expires_at desc)
  where revoked_at is null;

create table if not exists auth_login_challenges (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique,
  kind text not null check (kind in ('workspace_selection', 'mfa_verification', 'mfa_enrollment')),
  auth_identity_id uuid not null references auth_identities(id) on delete cascade,
  workspace_user_id uuid references workspace_users(id) on delete cascade,
  payload_ciphertext text,
  attempts integer not null default 0 check (attempts >= 0),
  max_attempts integer not null default 5 check (max_attempts between 1 and 20),
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now(),
  constraint auth_login_challenges_token_hash_check check (token_hash ~ '^[a-f0-9]{64}$'),
  constraint auth_login_challenges_expiry_check check (expires_at > created_at),
  constraint auth_login_challenges_membership_check
    check ((kind = 'workspace_selection') = (workspace_user_id is null)),
  constraint auth_login_challenges_payload_check
    check (
      (kind = 'mfa_enrollment' and (payload_ciphertext is not null or used_at is not null))
      or (kind <> 'mfa_enrollment' and payload_ciphertext is null)
    ),
  constraint auth_login_challenges_membership_identity_fk
    foreign key (workspace_user_id, auth_identity_id)
    references workspace_users(id, auth_identity_id)
    on delete cascade
);

create index if not exists auth_login_challenges_active_idx
  on auth_login_challenges(token_hash, expires_at)
  where used_at is null;

create table if not exists auth_mfa_recovery_codes (
  id uuid primary key default gen_random_uuid(),
  auth_identity_id uuid not null references auth_identities(id) on delete cascade,
  code_hash text not null,
  created_at timestamptz not null default now(),
  used_at timestamptz,
  constraint auth_mfa_recovery_codes_hash_check check (code_hash ~ '^[a-f0-9]{64}$'),
  unique (auth_identity_id, code_hash)
);

create index if not exists auth_mfa_recovery_codes_available_idx
  on auth_mfa_recovery_codes(auth_identity_id, code_hash)
  where used_at is null;

create table if not exists auth_rate_limit_buckets (
  scope text not null,
  subject_hash text not null,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  window_started_at timestamptz not null default now(),
  last_attempt_at timestamptz not null default now(),
  blocked_until timestamptz,
  primary key (scope, subject_hash),
  constraint auth_rate_limit_buckets_scope_check check (scope in ('login_email', 'login_ip', 'reset_email', 'reset_ip')),
  constraint auth_rate_limit_buckets_subject_hash_check check (subject_hash ~ '^[a-f0-9]{64}$')
);

create index if not exists auth_rate_limit_buckets_cleanup_idx
  on auth_rate_limit_buckets(last_attempt_at);

alter table auth_password_reset_tokens
  add column if not exists auth_identity_id uuid references auth_identities(id) on delete cascade,
  add column if not exists exchanged_at timestamptz;

update auth_password_reset_tokens token
set auth_identity_id = wu.auth_identity_id
from workspace_users wu
where token.auth_identity_id is null
  and wu.id = token.user_id;

alter table auth_password_reset_tokens
  alter column auth_identity_id set not null,
  alter column workspace_id drop not null,
  alter column user_id drop not null;

alter table auth_password_reset_tokens
  add constraint auth_password_reset_tokens_membership_pair_check
    check ((user_id is null) = (workspace_id is null)),
  add constraint auth_password_reset_tokens_membership_identity_workspace_fk
    foreign key (user_id, auth_identity_id, workspace_id)
    references workspace_users(id, auth_identity_id, workspace_id)
    on delete cascade;

create unique index if not exists auth_password_reset_tokens_id_identity_uidx
  on auth_password_reset_tokens(id, auth_identity_id);

create or replace function public.assign_password_reset_auth_identity()
returns trigger
language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if new.auth_identity_id is null then
    select auth_identity_id into new.auth_identity_id
    from public.workspace_users
    where id = new.user_id
      and workspace_id = new.workspace_id;
  end if;

  if new.auth_identity_id is null then
    raise exception 'password reset token requires a central auth identity';
  end if;

  return new;
end
$$;

drop trigger if exists auth_password_reset_assign_identity on auth_password_reset_tokens;
create trigger auth_password_reset_assign_identity
before insert or update of user_id, workspace_id, auth_identity_id on auth_password_reset_tokens
for each row execute function public.assign_password_reset_auth_identity();

create index if not exists auth_password_reset_tokens_identity_created_idx
  on auth_password_reset_tokens(auth_identity_id, created_at desc);

create table if not exists auth_password_reset_exchanges (
  id uuid primary key default gen_random_uuid(),
  reset_token_id uuid not null unique references auth_password_reset_tokens(id) on delete cascade,
  auth_identity_id uuid not null references auth_identities(id) on delete cascade,
  workspace_user_id uuid references workspace_users(id) on delete cascade,
  exchange_hash text not null unique,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now(),
  constraint auth_password_reset_exchanges_hash_check check (exchange_hash ~ '^[a-f0-9]{64}$'),
  constraint auth_password_reset_exchanges_expiry_check check (expires_at > created_at),
  constraint auth_password_reset_exchanges_token_identity_fk
    foreign key (reset_token_id, auth_identity_id)
    references auth_password_reset_tokens(id, auth_identity_id)
    on delete cascade,
  constraint auth_password_reset_exchanges_membership_identity_fk
    foreign key (workspace_user_id, auth_identity_id)
    references workspace_users(id, auth_identity_id)
    on delete cascade
);

create index if not exists auth_password_reset_exchanges_active_idx
  on auth_password_reset_exchanges(exchange_hash, expires_at)
  where used_at is null;

create table if not exists auth_audit_events (
  id uuid primary key default gen_random_uuid(),
  event_type text not null,
  outcome text not null check (outcome in ('success', 'failure', 'blocked')),
  auth_identity_id uuid,
  workspace_user_id uuid,
  workspace_id uuid,
  session_id uuid,
  ip_hash text,
  user_agent_hash text,
  metadata jsonb not null default '{}',
  occurred_at timestamptz not null default now(),
  constraint auth_audit_events_type_check check (event_type ~ '^[a-z0-9_.-]{3,100}$'),
  constraint auth_audit_events_ip_hash_check check (ip_hash is null or ip_hash ~ '^[a-f0-9]{64}$'),
  constraint auth_audit_events_user_agent_hash_check
    check (user_agent_hash is null or user_agent_hash ~ '^[a-f0-9]{64}$'),
  constraint auth_audit_events_metadata_object_check check (jsonb_typeof(metadata) = 'object')
);

create index if not exists auth_audit_events_identity_time_idx
  on auth_audit_events(auth_identity_id, occurred_at desc);

create index if not exists auth_audit_events_workspace_time_idx
  on auth_audit_events(workspace_id, occurred_at desc);

create or replace function public.reject_auth_audit_event_mutation()
returns trigger
language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
begin
  raise exception 'auth_audit_events is append-only';
end
$$;

drop trigger if exists auth_audit_events_append_only on auth_audit_events;
create trigger auth_audit_events_append_only
before update or delete on auth_audit_events
for each row execute function public.reject_auth_audit_event_mutation();

revoke all on table auth_identities from public;
revoke all on table auth_sessions from public;
revoke all on table auth_login_challenges from public;
revoke all on table auth_mfa_recovery_codes from public;
revoke all on table auth_rate_limit_buckets from public;
revoke all on table auth_password_reset_exchanges from public;
revoke all on table auth_audit_events from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'novalure_app') then
    grant select, insert, update on table auth_identities to novalure_app;
    grant select, insert, update on table auth_sessions to novalure_app;
    grant select, insert, update on table auth_login_challenges to novalure_app;
    grant select, insert, update, delete on table auth_mfa_recovery_codes to novalure_app;
    grant select, insert, update, delete on table auth_rate_limit_buckets to novalure_app;
    grant select, insert, update on table auth_password_reset_exchanges to novalure_app;
    grant select, insert on table auth_audit_events to novalure_app;
  end if;
end
$$;
