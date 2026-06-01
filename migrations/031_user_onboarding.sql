alter table workspace_users
  add column if not exists onboarding_completed_at timestamptz;

create index if not exists workspace_users_onboarding_completed_idx
  on workspace_users(workspace_id, onboarding_completed_at);
