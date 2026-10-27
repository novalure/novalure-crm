-- After the unchanged shared_behavior_foundation/package2/package3 migrations.
-- Dedicated native franz-personal caller for context/signal only. No rows seeded,
-- no existing Production principal changed, no publisher or schedule activated.
set local lock_timeout='5s';
set local statement_timeout='2min';
do $guard$ begin
 if to_regclass('public.behavior_runtime_bindings') is null
   or not exists(select 1 from pg_roles where rolname='novalure_behavior_resolver') then
  raise exception 'Shared behavior package3 is required';
 end if;
 if exists(select 1 from pg_roles where rolname='novalure_behavior_resolver'
   and (rolcanlogin or rolsuper or rolbypassrls or rolcreaterole or rolcreatedb or rolreplication)) then
  raise exception 'Unsafe resolver identity';
 end if;
end $guard$;
create table public.behavior_personal_workload_bindings (
 id uuid primary key default gen_random_uuid(),
 singleton boolean not null unique default true check(singleton),
 workspace_id uuid not null references public.workspaces(id)
  check(workspace_id='8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101'::uuid),
 broker_actor_id uuid not null unique check(broker_actor_id<>'6122a6da-e7f4-47fa-bc55-e296bb01af62'::uuid),
 issuer text not null check(issuer='https://oidc.vercel.com/novalure'),
 audience text not null check(audience='urn:novalure:crm:shared-runtime:franz-personal'),
 subject text not null check(subject='owner:novalure:project:evelyn:environment:franz-personal'),
 project_id text not null check(project_id='prj_8bbjKnQ5XDr52YYPRYtvqtoSj71I'),
 owner_id text not null check(owner_id='team_sjD78IkSicXJK6TAOR1JC7Wv'),
 environment text not null check(environment='franz-personal'),
 custom_environment_id text not null check(custom_environment_id='env_sue274zKgFxQJiKfw64x7BmEfEwE'),
 enabled boolean not null default false, not_before timestamptz not null default now(),
 expires_at timestamptz not null, revoked_at timestamptz,
 foreign key(workspace_id,broker_actor_id) references public.workspace_users(workspace_id,id),
 check(expires_at>not_before)
);
alter table public.behavior_personal_workload_bindings enable row level security;
alter table public.behavior_personal_workload_bindings force row level security;
revoke all on public.behavior_personal_workload_bindings from public,novalure_app,novalure_tenant_app,novalure_behavior_publisher;
grant select,update(enabled) on public.behavior_personal_workload_bindings to novalure_behavior_resolver;
-- Authentication has no tenant context yet. This NOLOGIN resolver sees exactly
-- the one fixed internal workload, its broker membership and workspace posture.
create policy behavior_personal_auth on public.behavior_personal_workload_bindings
 for select to novalure_behavior_resolver
 using(singleton and workspace_id='8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101'::uuid);
create policy behavior_personal_lock on public.behavior_personal_workload_bindings
 for update to novalure_behavior_resolver
 using(workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid) with check(false);
create policy behavior_personal_broker_auth on public.workspace_users for select to novalure_behavior_resolver
 using(workspace_id='8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101'::uuid
  and exists(select 1 from public.behavior_personal_workload_bindings w
   where w.workspace_id=workspace_users.workspace_id and w.broker_actor_id=workspace_users.id));
grant select on public.workspaces to novalure_behavior_resolver;
create policy behavior_personal_workspace_auth on public.workspaces for select to novalure_behavior_resolver
 using(id='8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101'::uuid);
grant create on schema public to novalure_behavior_resolver;
create function public.behavior_authenticate_personal_workload()
returns table(id uuid,workspace_id uuid,actor_user_id uuid,identity_id text)
language sql stable security definer set search_path=pg_catalog,public as $function$
 select w.id,w.workspace_id,w.broker_actor_id,'EVELYN_FRANZ_PERSONAL_SHARED_RUNTIME'::text
 from public.behavior_personal_workload_bindings w
 join public.workspace_users broker on broker.id=w.broker_actor_id and broker.workspace_id=w.workspace_id
 join public.workspaces workspace on workspace.id=w.workspace_id
 where w.singleton and w.enabled and w.revoked_at is null
  and w.not_before<=clock_timestamp() and w.expires_at>clock_timestamp()
  and broker.status='active' and broker.role='agent' and broker.product_role='novalure_operator'
  and workspace.operating_model='novalure_internal' and workspace.customer_type='novalure_internal'
$function$;
alter function public.behavior_authenticate_personal_workload() owner to novalure_behavior_resolver;
revoke all on function public.behavior_authenticate_personal_workload() from public,novalure_app;
grant execute on function public.behavior_authenticate_personal_workload() to novalure_tenant_app;
create function public.behavior_lock_personal_workload(p_workload uuid,p_broker uuid)
returns boolean language plpgsql security definer set search_path=pg_catalog,public as $function$
begin
 perform w.id from public.behavior_personal_workload_bindings w
 join public.workspace_users broker on broker.id=w.broker_actor_id and broker.workspace_id=w.workspace_id
 join public.workspaces workspace on workspace.id=w.workspace_id
 where w.id=p_workload and w.broker_actor_id=p_broker and w.singleton and w.enabled and w.revoked_at is null
  and w.workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid
  and w.not_before<=clock_timestamp() and w.expires_at>clock_timestamp()
  and broker.status='active' and broker.role='agent' and broker.product_role='novalure_operator'
  and workspace.operating_model='novalure_internal' and workspace.customer_type='novalure_internal'
  and exists(select 1 from public.behavior_runtime_bindings b where b.workspace_id=w.workspace_id
   and b.broker_actor_id=p_broker and b.actor_id=nullif(current_setting('app.actor_id',true),'')::uuid
   and b.department='executive' and b.enabled and b.revoked_at is null and b.expires_at>clock_timestamp())
 for share of w,broker;
 return found;
end $function$;
alter function public.behavior_lock_personal_workload(uuid,uuid) owner to novalure_behavior_resolver;
revoke all on function public.behavior_lock_personal_workload(uuid,uuid) from public,novalure_app;
grant execute on function public.behavior_lock_personal_workload(uuid,uuid) to novalure_tenant_app;
revoke create on schema public from novalure_behavior_resolver;
