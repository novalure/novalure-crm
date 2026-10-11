-- CRM-U1-C07: align the exact Evelyn Production machine identity with the
-- authoritative Novalure-internal workspace classification. Migration 092 is
-- intentionally not replayed; this additive repair preserves its exact identity,
-- resource and workload bounds.
set local lock_timeout = '5s';
set local statement_timeout = '14min';

alter table public.crm_service_principals
  drop constraint if exists crm_service_principals_data_context_check;

alter table public.crm_service_principals
  add constraint crm_service_principals_data_context_check check(
    data_context = 'CUSTOMER_TENANT'
    or (
      data_context = 'NOVALURE_INTERNAL'
      and auth_type = 'VERCEL_OIDC'
      and identity_id = 'EVELYN_CRM_SERVICE_IDENTITY'
      and workspace_id = '8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101'
      and environment = 'production'
      and service_role = 'Evelyn.Service'
    )
  );

update public.crm_service_principals
set data_context = 'NOVALURE_INTERNAL'
where id = '8b3238e9-efea-459f-ac84-a08e2a6ec59b'
  and workspace_id = '8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101'
  and identity_id = 'EVELYN_CRM_SERVICE_IDENTITY'
  and auth_type = 'VERCEL_OIDC';

update public.workspace_users
set product_role = 'novalure_operator'
where id = '6122a6da-e7f4-47fa-bc55-e296bb01af62'
  and workspace_id = '8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101'
  and email = 'evelyn-crm-service@service.invalid';

alter table public.projects disable trigger crm_sales_classification_guard;
alter table public.tasks disable trigger crm_sales_classification_guard;

update public.projects
set data_classification = 'NOVALURE_INTERNAL'
where id = 'fbae49e1-2cce-48b7-95cd-4146da343d3a'
  and workspace_id = '8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101'
  and name = 'SYNTHETIC: Evelyn CRM machine proof';

update public.tasks
set data_classification = 'NOVALURE_INTERNAL'
where id = '2fdefb1e-8690-4a84-bf44-485d9858bab4'
  and workspace_id = '8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101'
  and title like 'SYNTHETIC:%';

alter table public.projects enable trigger crm_sales_classification_guard;
alter table public.tasks enable trigger crm_sales_classification_guard;

-- The binding is immutable during normal runtime. Temporarily disable only its
-- immutable-mutation trigger inside this migration transaction, update the one
-- exact synthetic binding, and restore the trigger before verification/commit.
alter table public.crm_service_resource_bindings
  disable trigger crm_resource_binding_immutable;

update public.crm_service_resource_bindings
set data_context = 'NOVALURE_INTERNAL'
where principal_id = '8b3238e9-efea-459f-ac84-a08e2a6ec59b'
  and workspace_id = '8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101'
  and resource_alias = 'EVELYN_INTERNAL_CANARY_SYNTHETIC'
  and source_id = '2fdefb1e-8690-4a84-bf44-485d9858bab4';

alter table public.crm_service_resource_bindings
  enable trigger crm_resource_binding_immutable;

create or replace function public.crm_authenticate_machine(p_identity_id text,p_subject text,p_issuer text,p_audience text,p_project_id text,p_owner_id text,p_workspace uuid,p_environment text,p_role text)
returns table(id uuid,workspace_id uuid,actor_user_id uuid,tenant_alias text,agent_id text,scopes text[],data_context text,data_classification text,purpose text,identity_id text,service_subject text,consumer text,service_role text,environment text,auth_type text,issuer text,audience text)
language sql stable security definer set search_path = pg_catalog, public as $function$
  select principal.id,principal.workspace_id,principal.actor_user_id,principal.tenant_alias,principal.agent_id,principal.scopes,principal.data_context,principal.data_classification,principal.purpose,principal.identity_id,principal.service_subject,principal.consumer,principal.service_role,principal.environment,principal.auth_type,principal.issuer,principal.audience
  from public.crm_service_principals principal
  join public.workspace_users member on member.id=principal.actor_user_id and member.workspace_id=principal.workspace_id
  join public.workspaces workspace on workspace.id=principal.workspace_id
  where principal.identity_id=p_identity_id and principal.service_subject=p_subject and principal.issuer=p_issuer and principal.audience=p_audience
    and principal.oidc_project_id=p_project_id and principal.oidc_owner_id=p_owner_id and principal.consumer='EVELYN'
    and principal.workspace_id=p_workspace and principal.tenant_alias=p_workspace::text and principal.environment=p_environment and principal.service_role=p_role
    and principal.agent_id='evelyn' and principal.auth_type='VERCEL_OIDC' and principal.synthetic and principal.state='ACTIVE'
    and not principal.kill_switch_active and principal.revoked_at is null and principal.not_before<=clock_timestamp() and principal.expires_at>clock_timestamp()
    and member.status='active' and member.role='agent'
    and (
      (
        principal.data_context='CUSTOMER_TENANT'
        and member.product_role='project_sales_member'
        and workspace.operating_model in ('self_service_customer','managed_by_novalure','hybrid')
      )
      or (
        principal.id='8b3238e9-efea-459f-ac84-a08e2a6ec59b'
        and principal.identity_id='EVELYN_CRM_SERVICE_IDENTITY'
        and principal.data_context='NOVALURE_INTERNAL'
        and principal.workspace_id='8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101'
        and member.id='6122a6da-e7f4-47fa-bc55-e296bb01af62'
        and member.product_role='novalure_operator'
        and workspace.operating_model='novalure_internal'
        and workspace.customer_type='novalure_internal'
      )
    )
$function$;

revoke all on function public.crm_authenticate_machine(text,text,text,text,text,text,uuid,text,text) from public,novalure_app;
grant execute on function public.crm_authenticate_machine(text,text,text,text,text,text,uuid,text,text) to novalure_tenant_app;

do $verify$
declare
  relation_count integer;
  forced_count integer;
  machine_count integer;
  internal_count integer;
  immutable_trigger_enabled boolean;
  project_classification_trigger_enabled boolean;
  task_classification_trigger_enabled boolean;
begin
  select count(*),count(*) filter(where c.relforcerowsecurity)
  into relation_count,forced_count
  from pg_class c
  join pg_namespace n on n.oid=c.relnamespace
  where n.nspname='public' and c.relkind in ('r','p') and c.relrowsecurity;

  if relation_count<>68 or forced_count<>68 then
    raise exception using errcode='55000',message=format('093 requires and preserves exact forced RLS inventory 68/68, observed %s/%s',forced_count,relation_count);
  end if;

  select count(*) into machine_count
  from public.crm_authenticate_machine(
    'EVELYN_CRM_SERVICE_IDENTITY',
    'owner:novalure:project:evelyn:environment:production',
    'https://oidc.vercel.com/novalure',
    'urn:novalure:crm:production',
    'prj_8bbjKnQ5XDr52YYPRYtvqtoSj71I',
    'team_sjD78IkSicXJK6TAOR1JC7Wv',
    '8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101',
    'production',
    'Evelyn.Service'
  );

  if machine_count<>1 then
    raise exception using errcode='55000',message='093 exact Evelyn machine principal must authenticate exactly once';
  end if;

  select count(*) into internal_count
  from public.crm_service_principals principal
  join public.crm_service_resource_bindings binding
    on binding.principal_id=principal.id and binding.workspace_id=principal.workspace_id
  join public.projects project
    on project.id=binding.project_id and project.workspace_id=binding.workspace_id
  join public.tasks task
    on task.id=binding.source_id and task.workspace_id=binding.workspace_id and task.project_id=project.id
  join public.workspace_users member
    on member.id=principal.actor_user_id and member.workspace_id=principal.workspace_id
  join public.workspaces workspace on workspace.id=principal.workspace_id
  where principal.id='8b3238e9-efea-459f-ac84-a08e2a6ec59b'
    and principal.data_context='NOVALURE_INTERNAL'
    and binding.resource_alias='EVELYN_INTERNAL_CANARY_SYNTHETIC'
    and binding.data_context='NOVALURE_INTERNAL'
    and project.data_classification='NOVALURE_INTERNAL'
    and task.data_classification='NOVALURE_INTERNAL'
    and member.product_role='novalure_operator'
    and workspace.operating_model='novalure_internal'
    and workspace.customer_type='novalure_internal';

  if internal_count<>1 then
    raise exception using errcode='55000',message='093 exact Evelyn machine internal-context verification failed';
  end if;

  select t.tgenabled='O' into immutable_trigger_enabled
  from pg_trigger t
  where t.tgrelid='public.crm_service_resource_bindings'::regclass
    and t.tgname='crm_resource_binding_immutable'
    and not t.tgisinternal;

  if immutable_trigger_enabled is not true then
    raise exception using errcode='55000',message='093 binding immutability trigger is not enabled';
  end if;

  select t.tgenabled='O' into project_classification_trigger_enabled
  from pg_trigger t
  where t.tgrelid='public.projects'::regclass
    and t.tgname='crm_sales_classification_guard'
    and not t.tgisinternal;

  select t.tgenabled='O' into task_classification_trigger_enabled
  from pg_trigger t
  where t.tgrelid='public.tasks'::regclass
    and t.tgname='crm_sales_classification_guard'
    and not t.tgisinternal;

  if project_classification_trigger_enabled is not true or task_classification_trigger_enabled is not true then
    raise exception using errcode='55000',message='093 sales classification guards are not enabled';
  end if;
end $verify$;
