-- Apply after evelyn_autonomous_access.sql, as its exact protected schema owner,
-- in one transaction. No workload, grant, key, role or business row is seeded.
set local lock_timeout = '5s';
set local statement_timeout = '14min';
do $guard$
begin
  if current_user in ('public','novalure_app','novalure_tenant_app') or not exists (
    select 1 from pg_roles r where r.rolname=current_user and not r.rolsuper and not r.rolbypassrls
      and r.oid=(select relowner from pg_class where oid='public.crm_autonomous_workloads'::regclass)
      and r.oid=(select relowner from pg_class where oid='public.crm_autonomous_access_grants'::regclass)
  ) then raise exception using errcode='42501',message='AUTONOMOUS_BOOTSTRAP_OWNER_REQUIRED'; end if;
end $guard$;

alter table public.crm_autonomous_workloads add column custom_environment_id text;
alter table public.crm_autonomous_workloads drop constraint crm_autonomous_workloads_identity_id_check;
alter table public.crm_autonomous_workloads drop constraint crm_autonomous_workloads_subject_check;
alter table public.crm_autonomous_workloads drop constraint crm_autonomous_workloads_environment_check;
-- Existing fixed issuer/audience/project/owner/workspace checks remain. These
-- source-specific fields are inseparable; independent allowlists could crossmix.
alter table public.crm_autonomous_workloads add constraint crm_autonomous_workload_source_bundle check (
  (identity_id='EVELYN_CRM_AUTONOMOUS_INTERNAL_IDENTITY'
    and subject='owner:novalure:project:evelyn:environment:production'
    and environment='production' and custom_environment_id is null)
  or (identity_id='EVELYN_CRM_PERSONAL_INTERNAL_IDENTITY'
    and subject='owner:novalure:project:evelyn:environment:franz-personal'
    and environment='franz-personal' and custom_environment_id='env_sue274zKgFxQJiKfw64x7BmEfEwE'
    and custom_environment_id is not null)
);

-- The original signature never authenticates the native workload without its
-- custom-environment claim. Its EXECUTE grants and the production path persist.
create or replace function public.crm_authenticate_autonomous_workload(p_issuer text,p_audience text,p_project text,p_owner text,p_subject text,p_workspace uuid,p_environment text)
returns table(id uuid,workspace_id uuid,identity_id text)
language sql stable security definer set search_path=pg_catalog,public as $function$
  select a.id,a.workspace_id,a.identity_id from public.crm_autonomous_workloads a
  join public.workspace_users actor on actor.id=a.actor_user_id and actor.workspace_id=a.workspace_id
  join public.workspaces w on w.id=a.workspace_id
  where a.issuer=p_issuer and a.audience=p_audience and a.project_id=p_project and a.owner_id=p_owner
    and a.subject=p_subject and a.workspace_id=p_workspace and a.environment=p_environment
    and a.identity_id='EVELYN_CRM_AUTONOMOUS_INTERNAL_IDENTITY' and a.custom_environment_id is null
    and a.environment='production' and a.subject='owner:novalure:project:evelyn:environment:production'
    and not a.disabled and not a.kill_switch_active and a.revoked_at is null
    and a.not_before<=clock_timestamp() and (a.expires_at is null or a.expires_at>clock_timestamp())
    and actor.status='active' and actor.role='agent' and actor.product_role='novalure_operator'
    and w.operating_model='novalure_internal'
$function$;

create function public.crm_authenticate_personal_autonomous_workload(p_issuer text,p_audience text,p_project text,p_owner text,p_subject text,p_workspace uuid,p_environment text,p_custom_environment text)
returns table(id uuid,workspace_id uuid,identity_id text)
language sql stable security definer set search_path=pg_catalog,public as $function$
  select a.id,a.workspace_id,a.identity_id from public.crm_autonomous_workloads a
  join public.workspace_users actor on actor.id=a.actor_user_id and actor.workspace_id=a.workspace_id
  join public.workspaces w on w.id=a.workspace_id
  where a.issuer=p_issuer and a.audience=p_audience and a.project_id=p_project and a.owner_id=p_owner
    and a.subject=p_subject and a.workspace_id=p_workspace and a.environment=p_environment
    and a.custom_environment_id=p_custom_environment
    and a.identity_id='EVELYN_CRM_PERSONAL_INTERNAL_IDENTITY' and a.environment='franz-personal'
    and a.subject='owner:novalure:project:evelyn:environment:franz-personal'
    and a.custom_environment_id='env_sue274zKgFxQJiKfw64x7BmEfEwE'
    and not a.disabled and not a.kill_switch_active and a.revoked_at is null
    and a.not_before<=clock_timestamp() and (a.expires_at is null or a.expires_at>clock_timestamp())
    and actor.status='active' and actor.role='agent' and actor.product_role='novalure_operator'
    and w.operating_model='novalure_internal'
$function$;
revoke all on function public.crm_authenticate_personal_autonomous_workload(text,text,text,text,text,uuid,text,text) from public,novalure_app;
grant execute on function public.crm_authenticate_personal_autonomous_workload(text,text,text,text,text,uuid,text,text) to novalure_tenant_app;

create or replace function public.crm_lock_autonomous_access_grant(p_workload uuid,p_grant uuid)
returns setof public.crm_autonomous_access_grants
language sql volatile security definer set search_path=pg_catalog,public as $function$
  select g.* from public.crm_autonomous_access_grants g
  join public.crm_autonomous_workloads p on p.id=g.workload_id and p.workspace_id=g.workspace_id
  join public.workspace_users source_actor on source_actor.id=p.actor_user_id and source_actor.workspace_id=p.workspace_id
  join public.workspace_users actor on actor.id=g.actor_user_id and actor.workspace_id=g.workspace_id
  join public.workspaces w on w.id=g.workspace_id
  join public.project_pipeline_permissions project_grant on project_grant.workspace_id=g.workspace_id
    and project_grant.project_id=g.project_id and project_grant.user_id=g.actor_user_id
  where g.id=p_grant and p.id=p_workload
    and g.authority_class='REAL_INTERNAL_OPERATIONS'
    and not g.disabled and g.revoked_at is null and g.not_before<=clock_timestamp() and (g.expires_at is null or g.expires_at>clock_timestamp())
    and ((p.identity_id='EVELYN_CRM_AUTONOMOUS_INTERNAL_IDENTITY' and p.environment='production'
      and p.subject='owner:novalure:project:evelyn:environment:production' and p.custom_environment_id is null)
      or (p.identity_id='EVELYN_CRM_PERSONAL_INTERNAL_IDENTITY' and p.environment='franz-personal'
      and p.subject='owner:novalure:project:evelyn:environment:franz-personal'
      and p.custom_environment_id='env_sue274zKgFxQJiKfw64x7BmEfEwE'))
    and not p.disabled and not p.kill_switch_active and p.revoked_at is null
    and p.not_before<=clock_timestamp() and (p.expires_at is null or p.expires_at>clock_timestamp())
    and source_actor.status='active' and source_actor.role='agent' and source_actor.product_role='novalure_operator'
    and actor.status='active' and actor.role='agent' and actor.product_role='novalure_operator'
    and w.operating_model='novalure_internal'
    and project_grant.can_read
    and (not ('crm.tasks.write'=any(g.scopes)) or project_grant.can_edit_deals)
  for share of g,p,source_actor,actor,w,project_grant
$function$;
