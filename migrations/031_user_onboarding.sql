alter table workspace_users
  add column if not exists onboarding_completed_at timestamptz,
  add column if not exists onboarding_current_step text,
  add column if not exists onboarding_completed_steps text[] not null default '{}',
  add column if not exists onboarding_skipped_steps text[] not null default '{}',
  add column if not exists onboarding_dismissed_at timestamptz,
  add column if not exists onboarding_role_context text;

create index if not exists workspace_users_onboarding_completed_idx
  on workspace_users(workspace_id, onboarding_completed_at);

create index if not exists workspace_users_onboarding_progress_idx
  on workspace_users(workspace_id, onboarding_current_step, onboarding_dismissed_at);
