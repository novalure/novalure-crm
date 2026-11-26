-- Separate real-internal delegation. Manual activation requires the exact
-- reviewed source, registered public keys and all existing Production gates.
-- No registration, key, principal or real resource is seeded by this migration.
set local lock_timeout = '5s';
set local statement_timeout = '14min';

-- This real workload is deliberately independent of the synthetic canary
-- principal and its scopes/expiry. Registration is an explicit separate act.
create table public.crm_autonomous_workloads (
  id uuid primary key,
  identity_id text not null unique check(identity_id='EVELYN_CRM_AUTONOMOUS_INTERNAL_IDENTITY'),
  workspace_id uuid not null check(workspace_id='8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101'),
  actor_user_id uuid not null,
  issuer text not null check(issuer='https://oidc.vercel.com/novalure'),
  audience text not null check(audience='urn:novalure:crm:production'),
  project_id text not null check(project_id='prj_8bbjKnQ5XDr52YYPRYtvqtoSj71I'),
  owner_id text not null check(owner_id='team_sjD78IkSicXJK6TAOR1JC7Wv'),
  subject text not null check(subject='owner:novalure:project:evelyn:environment:production'),
  environment text not null check(environment='production'),
  not_before timestamptz not null default clock_timestamp(),
  expires_at timestamptz,
  revoked_at timestamptz,
  disabled boolean not null default false,
  kill_switch_active boolean not null default false,
  authority_reference text not null check(length(trim(authority_reference)) between 1 and 200),
  foreign key(workspace_id,actor_user_id) references public.workspace_users(workspace_id,id),
  check(expires_at is null or expires_at>not_before)
);

create table public.crm_autonomous_access_grants (
  id uuid primary key,
  workload_id uuid not null references public.crm_autonomous_workloads(id),
  workspace_id uuid not null check(workspace_id='8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101'),
  actor_user_id uuid not null,
  project_id uuid not null,
  source_id uuid not null,
  entity text not null check(entity in ('Task','Project')),
  department_id text not null check(department_id in (
    'EVELYN_CEO','BUSINESS_DEVELOPMENT','SALES','MARKETING_ADS','WEBSITE_STUDIO',
    'REAL_ESTATE_OPERATIONS','PROJECT_MANAGEMENT','IT_CRM','SECRETARIAT_ADMINISTRATION',
    'SUPPORT','FINANCE','LEGAL_COMPLIANCE','HR','PROCUREMENT','SOCIAL_MEDIA','VOICE_TELEPHONE')),
  agent_id text not null check(agent_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$'),
  task_id uuid not null,
  authority_class text not null check(authority_class='REAL_INTERNAL_OPERATIONS'),
  authority_reference text not null check(length(trim(authority_reference)) between 1 and 200),
  delegation_public_key text not null check(delegation_public_key ~ '^[A-Za-z0-9_-]{59}$'),
  scopes text[] not null check(cardinality(scopes)>0 and scopes <@ array['crm.tasks.read','crm.tasks.write','crm.projects.read']::text[]),
  not_before timestamptz not null,
  expires_at timestamptz check(expires_at is null or expires_at>not_before),
  revoked_at timestamptz,
  disabled boolean not null default false,
  created_at timestamptz not null default clock_timestamp(),
  foreign key(workspace_id,actor_user_id) references public.workspace_users(workspace_id,id),
  foreign key(workspace_id,project_id) references public.projects(workspace_id,id),
  check(entity<>'Project' or source_id=project_id),
  check((entity='Task' and scopes <@ array['crm.tasks.read','crm.tasks.write']::text[])
    or (entity='Project' and scopes=array['crm.projects.read']::text[])),
  unique(id,workspace_id,actor_user_id,department_id,agent_id,task_id,project_id,source_id)
);

create table public.crm_autonomous_access_events (
  grant_id uuid not null references public.crm_autonomous_access_grants(id),
  nonce uuid not null,
  workspace_id uuid not null,
  actor_user_id uuid not null,
  department_id text not null,
  agent_id text not null,
  task_id uuid not null,
  project_id uuid not null,
  source_id uuid not null,
  action text not null check(action in ('crm.tasks.read','crm.tasks.write','crm.projects.read')),
  request_hash text not null check(request_hash ~ '^[a-f0-9]{64}$'),
  oidc_jti_hash text not null check(oidc_jti_hash ~ '^[a-f0-9]{64}$'),
  audit_reference uuid not null,
  outcome text not null check(outcome='SUCCESS'),
  created_at timestamptz not null default clock_timestamp(),
  primary key(grant_id,nonce),
  foreign key(workspace_id,actor_user_id) references public.workspace_users(workspace_id,id),
  foreign key(grant_id,workspace_id,actor_user_id,department_id,agent_id,task_id,project_id,source_id)
    references public.crm_autonomous_access_grants(id,workspace_id,actor_user_id,department_id,agent_id,task_id,project_id,source_id)
);

create function public.crm_autonomous_registration_immutable()
returns trigger language plpgsql set search_path=pg_catalog,public as $function$
begin
  if (to_jsonb(new)-'revoked_at'-'disabled'-'expires_at'-'kill_switch_active')
    is distinct from (to_jsonb(old)-'revoked_at'-'disabled'-'expires_at'-'kill_switch_active') then
    raise exception using errcode='42501',message='Replace a revoked registration to change its authority';
  end if;
  return new;
end $function$;
create trigger autonomous_workload_identity_immutable before update on public.crm_autonomous_workloads
  for each row execute function public.crm_autonomous_registration_immutable();
create trigger autonomous_grant_identity_immutable before update on public.crm_autonomous_access_grants
  for each row execute function public.crm_autonomous_registration_immutable();

alter table public.crm_autonomous_access_grants enable row level security;
alter table public.crm_autonomous_access_grants force row level security;
alter table public.crm_autonomous_access_events enable row level security;
alter table public.crm_autonomous_access_events force row level security;
alter table public.crm_autonomous_workloads enable row level security;
alter table public.crm_autonomous_workloads force row level security;
revoke all on public.crm_autonomous_workloads,public.crm_autonomous_access_grants,public.crm_autonomous_access_events from public,novalure_app,novalure_tenant_app;

-- Only the deployment owner can provision/revoke assignments. The runtime gets
-- no INSERT/UPDATE rights on grants and cannot choose its own department/key.
do $owner_policy$ begin
  if current_user in ('public','novalure_app','novalure_tenant_app') then
    raise exception using errcode='42501',message='A protected non-runtime schema owner must install autonomous access';
  end if;
  execute format('create policy autonomous_workload_owner on public.crm_autonomous_workloads for all to %I using(true) with check(true)',current_user);
  execute format('create policy autonomous_grant_owner on public.crm_autonomous_access_grants for all to %I using(true) with check(true)',current_user);
  execute format('create policy autonomous_owner_internal_workspace on public.workspaces for select to %I using(id=''8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101''::uuid)',current_user);
  execute format('create policy autonomous_owner_internal_member on public.workspace_users for select to %I using(workspace_id=''8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101''::uuid)',current_user);
  execute format('create policy autonomous_owner_internal_project_grant on public.project_pipeline_permissions for select to %I using(workspace_id=''8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101''::uuid)',current_user);
  -- Row-lock clauses also evaluate UPDATE USING under FORCE RLS. WITH CHECK
  -- false permits the owner to lock these exact metadata rows, not change them.
  execute format('create policy autonomous_owner_workspace_lock on public.workspaces for update to %I using(id=''8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101''::uuid) with check(false)',current_user);
  execute format('create policy autonomous_owner_member_lock on public.workspace_users for update to %I using(workspace_id=''8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101''::uuid) with check(false)',current_user);
  execute format('create policy autonomous_owner_project_grant_lock on public.project_pipeline_permissions for update to %I using(workspace_id=''8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101''::uuid) with check(false)',current_user);
end $owner_policy$;
create policy autonomous_event_read on public.crm_autonomous_access_events for select to novalure_tenant_app
  using(workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid
    and actor_user_id=nullif(current_setting('app.actor_id',true),'')::uuid);
create policy autonomous_event_insert on public.crm_autonomous_access_events for insert to novalure_tenant_app
  with check(workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid
    and actor_user_id=nullif(current_setting('app.actor_id',true),'')::uuid);
grant select,insert on public.crm_autonomous_access_events to novalure_tenant_app;
create trigger autonomous_event_immutable before update or delete or truncate on public.crm_autonomous_access_events
  for each statement execute function public.crm_reject_immutable_mutation();

create function public.crm_authenticate_autonomous_workload(p_issuer text,p_audience text,p_project text,p_owner text,p_subject text,p_workspace uuid,p_environment text)
returns table(id uuid,workspace_id uuid,identity_id text)
language sql stable security definer set search_path=pg_catalog,public as $function$
  select a.id,a.workspace_id,a.identity_id from public.crm_autonomous_workloads a
  join public.workspace_users actor on actor.id=a.actor_user_id and actor.workspace_id=a.workspace_id
  join public.workspaces w on w.id=a.workspace_id
  where a.issuer=p_issuer and a.audience=p_audience and a.project_id=p_project and a.owner_id=p_owner
    and a.subject=p_subject and a.workspace_id=p_workspace and a.environment=p_environment
    and not a.disabled and not a.kill_switch_active and a.revoked_at is null
    and a.not_before<=clock_timestamp() and (a.expires_at is null or a.expires_at>clock_timestamp())
    and actor.status='active' and actor.role='agent' and actor.product_role='novalure_operator'
    and w.operating_model='novalure_internal'
$function$;
revoke all on function public.crm_authenticate_autonomous_workload(text,text,text,text,text,uuid,text) from public,novalure_app;
grant execute on function public.crm_authenticate_autonomous_workload(text,text,text,text,text,uuid,text) to novalure_tenant_app;

create function public.crm_lock_autonomous_access_grant(p_workload uuid,p_grant uuid)
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
    and p.identity_id='EVELYN_CRM_AUTONOMOUS_INTERNAL_IDENTITY' and p.environment='production'
    and not p.disabled and not p.kill_switch_active and p.revoked_at is null
    and p.not_before<=clock_timestamp() and (p.expires_at is null or p.expires_at>clock_timestamp())
    and source_actor.status='active' and source_actor.role='agent' and source_actor.product_role='novalure_operator'
    and actor.status='active' and actor.role='agent' and actor.product_role='novalure_operator'
    and w.operating_model='novalure_internal'
    and project_grant.can_read
    and (not ('crm.tasks.write'=any(g.scopes)) or project_grant.can_edit_deals)
  for share of g,p,source_actor,actor,w,project_grant
$function$;
revoke all on function public.crm_lock_autonomous_access_grant(uuid,uuid) from public,novalure_app;
grant execute on function public.crm_lock_autonomous_access_grant(uuid,uuid) to novalure_tenant_app;
