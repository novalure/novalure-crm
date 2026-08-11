-- Prevent temporary-schema shadow objects from weakening the provider-target
-- and qualifying-lead trigger checks introduced by migration 064. The
-- relations are schema-qualified as defense in depth, and pg_temp is placed
-- last in each function-local search path.

create or replace function public.novalure_enforce_google_notification_job_target()
returns trigger
language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
declare
  target public.google_notification_targets%rowtype;
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
  from public.google_notification_targets
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

create or replace function public.novalure_enforce_teams_notification_job_target()
returns trigger
language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
declare
  target public.teams_notification_targets%rowtype;
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
  from public.teams_notification_targets
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

create or replace function public.novalure_enforce_qualifying_lead_assignee()
returns trigger
language plpgsql
set search_path = pg_catalog, public, pg_temp
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
    from public.workspace_users
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
