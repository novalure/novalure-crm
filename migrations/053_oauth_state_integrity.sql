-- Durable, one-time OAuth authorization state. Only hashes of the browser
-- state and nonce are persisted; the PKCE verifier is encrypted by the app.
create table if not exists oauth_authorization_states (
  id uuid primary key default gen_random_uuid(),
  state_hash text not null unique,
  nonce_hash text not null unique,
  provider text not null check (provider in ('google', 'microsoft')),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  user_id uuid not null references workspace_users(id) on delete cascade,
  return_to text not null,
  code_verifier_encrypted text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  constraint oauth_authorization_states_expiry_check
    check (expires_at > created_at)
);

create index if not exists oauth_authorization_states_active_idx
  on oauth_authorization_states(expires_at, provider)
  where consumed_at is null;

create index if not exists oauth_authorization_states_workspace_user_idx
  on oauth_authorization_states(workspace_id, user_id, created_at desc);
