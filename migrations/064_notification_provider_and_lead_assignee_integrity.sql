-- Provider configuration/reconciliation evidence and qualifying-lead assignee integrity.
-- Existing unresolved jobs are classified terminally; this migration never requeues or sends them.

alter table google_notification_jobs
  add column if not exists configuration_code text,
  add column if not exists admin_action text,
  add column if not exists reconciled_at timestamptz,
  add column if not exists reconciled_by_user_id uuid references workspace_users(id) on delete set null;

alter table teams_notification_jobs
  add column if not exists configuration_code text,
  add column if not exists admin_action text,
  add column if not exists reconciled_at timestamptz,
  add column if not exists reconciled_by_user_id uuid references workspace_users(id) on delete set null;

update google_notification_jobs
set
  status = 'pending_config',
  configuration_code = coalesce(configuration_code, 'target_missing'),
  admin_action = coalesce(
    admin_action,
    'Create an authorized Google Chat webhook target and reconcile this job explicitly.'
  ),
  last_error_category = coalesce(last_error_category, 'configuration'),
  retry_after = null,
  locked_by = null,
  lease_expires_at = null,
  updated_at = now()
where status = 'failed'
  and target_id is null;

update teams_notification_jobs
set
  configuration_code = coalesce(configuration_code, 'target_missing'),
  admin_action = coalesce(
    admin_action,
    'Create an authorized Teams incoming-webhook target and reconcile this job explicitly.'
  ),
  last_error_category = coalesce(last_error_category, 'configuration'),
  retry_after = null,
  locked_by = null,
  lease_expires_at = null,
  updated_at = now()
where status = 'pending_config'
  and target_id is null;

-- This expand phase intentionally installs no write-path trigger. The current
-- application may still create qualifying leads without an assignee. Migration
-- 065 installs the hardened functions and guards only after the compatible
-- application validation has been deployed.
