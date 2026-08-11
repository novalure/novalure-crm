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

create or replace function novalure_enforce_google_notification_job_target()
returns trigger
language plpgsql
as $$
declare
  target google_notification_targets%rowtype;
begin
  if (new.status = 'failed' and new.target_id is null) or new.status = 'pending_config' then
    new.status := 'pending_config';
    new.configuration_code := coalesce(new.configuration_code, 'target_missing');
    new.admin_action := coalesce(
      new.admin_action,
      'Create an authorized Google Chat webhook target and reconcile this job explicitly.'
    );
    new.last_error_category := 'configuration';
    new.last_error_message := coalesce(new.last_error_message, left(new.error, 500));
    new.retry_after := null;
    new.locked_by := null;
    new.lease_expires_at := null;
    return new;
  end if;

  if new.status not in ('queued', 'retry', 'sending') then
    return new;
  end if;

  if new.target_id is null then
    raise exception using
      errcode = '23514',
      message = 'google_notification_target_required';
  end if;

  select * into target
  from google_notification_targets
  where id = new.target_id;

  if not found
    or target.workspace_id <> new.workspace_id
    or target.enabled is not true
    or not coalesce(new.alert_type = any(target.alert_types), false)
    or target.destination_type <> 'google_chat_webhook'
    or nullif(btrim(target.webhook_url), '') is null
    or not (
      target.project_id is null
      or (new.project_id is not null and target.project_id = new.project_id)
    )
  then
    raise exception using
      errcode = '23514',
      message = 'google_notification_target_not_ready';
  end if;

  return new;
end
$$;

drop trigger if exists google_notification_job_target_guard on google_notification_jobs;
create trigger google_notification_job_target_guard
before insert or update of status, target_id, workspace_id, project_id, alert_type
on google_notification_jobs
for each row
execute function novalure_enforce_google_notification_job_target();

create or replace function novalure_enforce_teams_notification_job_target()
returns trigger
language plpgsql
as $$
declare
  target teams_notification_targets%rowtype;
begin
  if new.status = 'pending_config' then
    new.configuration_code := coalesce(new.configuration_code, 'target_missing');
    new.admin_action := coalesce(
      new.admin_action,
      'Create an authorized Teams incoming-webhook target and reconcile this job explicitly.'
    );
    new.last_error_category := 'configuration';
    new.last_error_message := coalesce(new.last_error_message, left(new.error, 500));
    new.retry_after := null;
    new.locked_by := null;
    new.lease_expires_at := null;
    return new;
  end if;

  if new.status not in ('queued', 'retry', 'sending') then
    return new;
  end if;

  if new.target_id is null then
    raise exception using
      errcode = '23514',
      message = 'teams_notification_target_required';
  end if;

  select * into target
  from teams_notification_targets
  where id = new.target_id;

  if not found
    or target.workspace_id <> new.workspace_id
    or target.enabled is not true
    or not coalesce(new.alert_type = any(target.alert_types), false)
    or target.destination_type <> 'incoming_webhook'
    or nullif(btrim(target.webhook_url), '') is null
    or not (
      target.project_id is null
      or (new.project_id is not null and target.project_id = new.project_id)
    )
  then
    raise exception using
      errcode = '23514',
      message = 'teams_notification_target_not_ready';
  end if;

  return new;
end
$$;

drop trigger if exists teams_notification_job_target_guard on teams_notification_jobs;
create trigger teams_notification_job_target_guard
before insert or update of status, target_id, workspace_id, project_id, alert_type
on teams_notification_jobs
for each row
execute function novalure_enforce_teams_notification_job_target();

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'leads_qualifying_requires_assignee_check'
      and conrelid = 'leads'::regclass
  ) then
    alter table leads
      add constraint leads_qualifying_requires_assignee_check
      check (status <> 'Qualifizieren' or assigned_to_user_id is not null)
      not valid;
  end if;
end
$$;

create or replace function novalure_enforce_qualifying_lead_assignee()
returns trigger
language plpgsql
as $$
begin
  if new.status <> 'Qualifizieren' then
    return new;
  end if;

  if new.assigned_to_user_id is null then
    raise exception using
      errcode = '23514',
      message = 'qualifying_lead_assignee_required';
  end if;

  if not exists (
    select 1
    from workspace_users
    where id = new.assigned_to_user_id
      and workspace_id = new.workspace_id
      and status = 'active'
  ) then
    raise exception using
      errcode = '23514',
      message = 'qualifying_lead_assignee_must_be_active_in_workspace';
  end if;

  return new;
end
$$;

drop trigger if exists leads_qualifying_assignee_guard on leads;
create trigger leads_qualifying_assignee_guard
before insert or update of status, assigned_to_user_id, workspace_id
on leads
for each row
execute function novalure_enforce_qualifying_lead_assignee();
