alter table workspace_users
  add column if not exists password_hash text;

create table if not exists auth_password_reset_tokens (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  user_id uuid not null references workspace_users(id) on delete cascade,
  token_hash text not null unique,
  requested_email text not null,
  request_ip text,
  user_agent text,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists auth_password_reset_tokens_user_created_idx
  on auth_password_reset_tokens(user_id, created_at desc);

create index if not exists auth_password_reset_tokens_active_idx
  on auth_password_reset_tokens(token_hash, expires_at)
  where used_at is null;
