-- Dedicated Sales registration metadata, not business records. No active right/key is seeded.
-- Existing Task-only and synthetic canary registrations are deliberately untouched.
set local lock_timeout = '5s';
set local statement_timeout = '14min';

create table public.crm_website_sales_machine_workloads (
  id uuid primary key,
  identity_id text not null unique check(identity_id='EVELYN_WEBSITE_SALES_INTERNAL_IDENTITY'),
  workspace_id uuid not null check(workspace_id='8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101'),
  actor_user_id uuid not null,
  issuer text not null check(issuer='https://oidc.vercel.com/novalure'),
  audience text not null check(audience='urn:novalure:crm:production'),
  project_id text not null check(project_id='prj_8bbjKnQ5XDr52YYPRYtvqtoSj71I'),
  owner_id text not null check(owner_id='team_sjD78IkSicXJK6TAOR1JC7Wv'),
  subject text not null check(subject='owner:novalure:project:evelyn:environment:production'),
  environment text not null check(environment='production'),
  not_before timestamptz not null default clock_timestamp(), expires_at timestamptz,
  revoked_at timestamptz, disabled boolean not null default false, kill_switch_active boolean not null default false,
  authority_reference text not null check(length(trim(authority_reference)) between 1 and 200),
  foreign key(workspace_id,actor_user_id) references public.workspace_users(workspace_id,id),
  unique(id,workspace_id), check(expires_at is null or expires_at>not_before)
);
create table public.crm_website_sales_machine_grants (
  id uuid primary key, workload_id uuid not null, workspace_id uuid not null,
  actor_user_id uuid not null, project_id uuid not null check(project_id='f7d83c6b-d08d-4d73-b822-1f1c0b4733d2'::uuid),
  company_id uuid not null, location_id uuid not null,
  department_id text not null check(department_id='SALES'),
  agent_id text not null check(agent_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$'), task_id uuid not null,
  authority_reference text not null check(length(trim(authority_reference)) between 1 and 200),
  delegation_public_key text not null check(delegation_public_key ~ '^[A-Za-z0-9_-]{59}$'),
  scopes text[] not null check(cardinality(scopes)>0 and scopes <@ array[
    'crm.website-sales.read','crm.website-sales.qualify','crm.website-sales.reconcile']::text[]),
  check(not ('crm.website-sales.reconcile'=any(scopes)) or 'crm.website-sales.qualify'=any(scopes)),
  not_before timestamptz not null, expires_at timestamptz check(expires_at is null or expires_at>not_before),
  revoked_at timestamptz, disabled boolean not null default false, created_at timestamptz not null default clock_timestamp(),
  foreign key(workload_id,workspace_id) references public.crm_website_sales_machine_workloads(id,workspace_id),
  foreign key(workspace_id,actor_user_id) references public.workspace_users(workspace_id,id),
  foreign key(workspace_id,project_id,company_id) references public.organizations(workspace_id,project_id,id),
  foreign key(workspace_id,project_id,company_id,location_id) references public.crm_company_locations(workspace_id,project_id,company_id,id),
  unique(id,workspace_id,actor_user_id,project_id,company_id,department_id,agent_id,task_id)
);
create table public.crm_website_sales_machine_events (
  grant_id uuid not null, nonce uuid not null, workspace_id uuid not null, actor_user_id uuid not null,
  project_id uuid not null, company_id uuid not null, location_id uuid not null,
  department_id text not null, agent_id text not null, task_id uuid not null,
  action text not null check(action in ('crm.website-sales.read','crm.website-sales.qualify','crm.website-sales.reconcile')),
  request_hash text not null check(request_hash ~ '^[a-f0-9]{64}$'),
  oidc_jti_hash text not null check(oidc_jti_hash ~ '^[a-f0-9]{64}$'), audit_reference uuid not null,
  outcome text not null check(outcome in ('SUCCESS','NOT_FOUND')),
  created_at timestamptz not null default clock_timestamp(), primary key(grant_id,nonce),
  foreign key(grant_id,workspace_id,actor_user_id,project_id,company_id,department_id,agent_id,task_id)
    references public.crm_website_sales_machine_grants(id,workspace_id,actor_user_id,project_id,company_id,department_id,agent_id,task_id),
  foreign key(workspace_id,project_id,company_id,location_id) references public.crm_company_locations(workspace_id,project_id,company_id,id)
);
create function public.crm_website_sales_registration_immutable() returns trigger
language plpgsql set search_path=pg_catalog,public as $function$
begin
  if (to_jsonb(new)-'revoked_at'-'disabled'-'expires_at'-'kill_switch_active')
    is distinct from (to_jsonb(old)-'revoked_at'-'disabled'-'expires_at'-'kill_switch_active') then
    raise exception using errcode='42501',message='Replace a revoked Sales registration to change its authority';
  end if;
  return new;
end $function$;
create trigger website_sales_workload_immutable before update on public.crm_website_sales_machine_workloads
  for each row execute function public.crm_website_sales_registration_immutable();
create trigger website_sales_grant_immutable before update on public.crm_website_sales_machine_grants
  for each row execute function public.crm_website_sales_registration_immutable();

do $policies$
declare relation text;
begin
  if current_user in ('public','novalure_app','novalure_tenant_app') then
    raise exception using errcode='42501',message='Protected schema owner required';
  end if;
  foreach relation in array array['crm_website_sales_machine_workloads','crm_website_sales_machine_grants','crm_website_sales_machine_events'] loop
    execute format('alter table public.%I enable row level security',relation);
    execute format('alter table public.%I force row level security',relation);
    execute format('revoke all on public.%I from public,novalure_app,novalure_tenant_app',relation);
    execute format('create policy website_sales_registration_owner on public.%I for all to %I using(true) with check(true)',relation,current_user);
  end loop;
  -- The protected installer can inspect/lock only internal metadata and canonical Sales scope.
  -- It never acquires a tenant business-write policy. Runtime rights are unchanged.
  foreach relation in array array['workspaces','workspace_users','project_pipeline_permissions','projects','organizations','crm_company_locations'] loop
    execute format('create policy website_sales_owner_scope on public.%I for select to %I using(%s)',relation,current_user,
      case when relation='workspaces' then 'id=''8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101''::uuid'
        else 'workspace_id=''8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101''::uuid' end);
  end loop;
  foreach relation in array array['workspaces','workspace_users','project_pipeline_permissions'] loop
    execute format('create policy website_sales_owner_lock on public.%I for update to %I using(%s) with check(false)',relation,current_user,
      case when relation='workspaces' then 'id=''8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101''::uuid'
        else 'workspace_id=''8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101''::uuid' end);
  end loop;
end $policies$;
create policy website_sales_machine_event_read on public.crm_website_sales_machine_events for select to novalure_tenant_app
  using(workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid and actor_user_id=nullif(current_setting('app.actor_id',true),'')::uuid);
create policy website_sales_machine_event_insert on public.crm_website_sales_machine_events for insert to novalure_tenant_app
  with check(workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid and actor_user_id=nullif(current_setting('app.actor_id',true),'')::uuid);
grant select,insert on public.crm_website_sales_machine_events to novalure_tenant_app;
create function public.crm_website_sales_machine_event_binding() returns trigger
language plpgsql security definer set search_path=pg_catalog,public as $function$
begin
  if not exists(select 1 from public.crm_website_sales_machine_grants g where g.id=new.grant_id
    and g.location_id is not distinct from new.location_id and new.action=any(g.scopes)) then
    raise exception using errcode='42501',message='Sales event must match the saved resource and scope';
  end if;
  return new;
end $function$;
revoke all on function public.crm_website_sales_machine_event_binding() from public,novalure_app,novalure_tenant_app;
create trigger website_sales_machine_event_binding before insert on public.crm_website_sales_machine_events
  for each row execute function public.crm_website_sales_machine_event_binding();
create trigger website_sales_machine_event_immutable before update or delete or truncate on public.crm_website_sales_machine_events
  for each statement execute function public.crm_reject_immutable_mutation();

create function public.crm_authenticate_website_sales_workload(p_issuer text,p_audience text,p_project text,p_owner text,p_subject text,p_workspace uuid,p_environment text)
returns table(id uuid,workspace_id uuid,identity_id text)
language sql stable security definer set search_path=pg_catalog,public as $function$
  select a.id,a.workspace_id,a.identity_id from public.crm_website_sales_machine_workloads a
  join public.workspace_users actor on actor.id=a.actor_user_id and actor.workspace_id=a.workspace_id
  join public.workspaces w on w.id=a.workspace_id
  where a.issuer=p_issuer and a.audience=p_audience and a.project_id=p_project and a.owner_id=p_owner
    and a.subject=p_subject and a.workspace_id=p_workspace and a.environment=p_environment
    and not a.disabled and not a.kill_switch_active and a.revoked_at is null
    and a.not_before<=clock_timestamp() and (a.expires_at is null or a.expires_at>clock_timestamp())
    and actor.status='active' and actor.role='agent' and actor.product_role='novalure_operator'
    and w.operating_model='novalure_internal'
$function$;
create function public.crm_lock_website_sales_machine_grant(p_workload uuid,p_grant uuid)
returns setof public.crm_website_sales_machine_grants
language sql volatile security definer set search_path=pg_catalog,public as $function$
  select g.* from public.crm_website_sales_machine_grants g
  join public.crm_website_sales_machine_workloads p on p.id=g.workload_id and p.workspace_id=g.workspace_id
  join public.workspace_users source_actor on source_actor.id=p.actor_user_id and source_actor.workspace_id=p.workspace_id
  join public.workspace_users actor on actor.id=g.actor_user_id and actor.workspace_id=g.workspace_id
  join public.workspaces w on w.id=g.workspace_id
  join public.project_pipeline_permissions project_grant on project_grant.workspace_id=g.workspace_id
    and project_grant.project_id=g.project_id and project_grant.user_id=g.actor_user_id
  where g.id=p_grant and p.id=p_workload and not g.disabled and g.revoked_at is null
    and g.not_before<=clock_timestamp() and (g.expires_at is null or g.expires_at>clock_timestamp())
    and not p.disabled and not p.kill_switch_active and p.revoked_at is null
    and p.not_before<=clock_timestamp() and (p.expires_at is null or p.expires_at>clock_timestamp())
    and source_actor.status='active' and source_actor.role='agent' and source_actor.product_role='novalure_operator'
    and actor.status='active' and actor.role='agent' and actor.product_role in ('novalure_operator','novalure_sales')
    and w.operating_model='novalure_internal' and project_grant.can_read
    and (g.scopes <@ array['crm.website-sales.read']::text[] or project_grant.can_edit_deals)
    and exists(select 1 from public.projects project join public.organizations company on company.workspace_id=project.workspace_id and company.project_id=project.id
      where project.workspace_id=g.workspace_id and project.id=g.project_id and company.id=g.company_id
        and project.division=company.division and project.data_classification='NOVALURE_INTERNAL' and project.data_purpose='crm_sales'
        and company.data_classification='NOVALURE_INTERNAL' and company.data_purpose='crm_sales')
    and exists(select 1 from public.crm_company_locations location
      where location.workspace_id=g.workspace_id and location.project_id=g.project_id and location.company_id=g.company_id and location.id=g.location_id)
  for share of g,p,source_actor,actor,w,project_grant
$function$;
revoke all on function public.crm_authenticate_website_sales_workload(text,text,text,text,text,uuid,text) from public,novalure_app;
revoke all on function public.crm_lock_website_sales_machine_grant(uuid,uuid) from public,novalure_app;
grant execute on function public.crm_authenticate_website_sales_workload(text,text,text,text,text,uuid,text) to novalure_tenant_app;
grant execute on function public.crm_lock_website_sales_machine_grant(uuid,uuid) to novalure_tenant_app;
