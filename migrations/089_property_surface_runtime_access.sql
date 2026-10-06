-- U1-C05: complete least-privilege runtime access for restored property
-- surfaces without granting broad access to company profile or activity data.
set local lock_timeout = '5s';
set local statement_timeout = '14min';

alter table property_activity_events enable row level security;
alter table property_activity_events force row level security;

drop policy if exists crm_property_activity_read on property_activity_events;
drop policy if exists crm_property_activity_append on property_activity_events;

create policy crm_property_activity_read on property_activity_events
  for select to novalure_tenant_app
  using (
    workspace_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    and crm_project_access(workspace_id, project_id, false)
  );

create policy crm_property_activity_append on property_activity_events
  for insert to novalure_tenant_app
  with check (
    workspace_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    and actor_user_id = nullif(current_setting('app.actor_id', true), '')::uuid
    and crm_project_access(workspace_id, project_id, true)
    and exists (
      select 1 from workspace_users actor
      where actor.workspace_id = property_activity_events.workspace_id
        and actor.id = nullif(current_setting('app.actor_id', true), '')::uuid
        and actor.status = 'active'
        and actor.role in ('owner', 'admin', 'agent')
    )
  );

revoke all on table property_activity_events from public;
grant select, insert on table property_activity_events to novalure_tenant_app;

create or replace function crm_property_expose_company_profile(p_workspace uuid)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public
as $function$
  select jsonb_build_object(
    'name', coalesce(nullif(profile.display_name, ''), profile.legal_name),
    'email', profile.public_email,
    'phone', profile.public_phone,
    'updatedAt', profile.updated_at
  )
  from company_profiles profile
  where p_workspace = nullif(current_setting('app.tenant_id', true), '')::uuid
    and profile.workspace_id = p_workspace
    and profile.profile_scope = 'workspace_owner'
    and profile.status in ('approved', 'locked')
    and profile.usage_settings->'exposes' = 'true'::jsonb
    and exists (
      select 1 from workspace_users actor
      where actor.workspace_id = p_workspace
        and actor.id = nullif(current_setting('app.actor_id', true), '')::uuid
        and actor.status = 'active'
    )
  order by profile.updated_at desc
  limit 1
$function$;

revoke all on function crm_property_expose_company_profile(uuid) from public;
grant execute on function crm_property_expose_company_profile(uuid) to novalure_tenant_app;
