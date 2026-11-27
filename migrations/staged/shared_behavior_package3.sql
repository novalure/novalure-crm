-- After Knowledge Center101/108 and shared behavior foundations. No live binding seeded.
set local lock_timeout='5s';
set local statement_timeout='2min';
do $$ begin
 if not exists(select 1 from pg_roles where rolname='novalure_behavior_resolver') then
  create role novalure_behavior_resolver nologin nosuperuser nobypassrls nocreatedb nocreaterole noreplication;
 end if;
 if exists(select 1 from pg_roles where rolname='novalure_behavior_resolver' and (rolcanlogin or rolsuper or rolbypassrls or rolcreaterole or rolcreatedb or rolreplication))
 or pg_has_role('novalure_tenant_app','novalure_behavior_resolver','MEMBER')
 or pg_has_role('novalure_behavior_resolver','novalure_tenant_app','MEMBER') then raise exception 'Unsafe resolver identity'; end if;
 execute format('grant novalure_behavior_resolver to %I',current_user);
end $$;
grant usage,create on schema public to novalure_behavior_resolver;
create table public.behavior_runtime_bindings (
 id uuid primary key default gen_random_uuid(), workspace_id uuid not null references public.workspaces(id),
 broker_actor_id uuid not null, actor_id uuid not null, bot_id uuid not null,
 department text not null check(department in ('executive','sales','marketing','buyer','support','finance','engineering','security','legal','qc','procurement','hr','personal')),
 token_hash text not null unique check(token_hash ~ '^[0-9a-f]{64}$'),
 enabled boolean not null default false, expires_at timestamptz not null, revoked_at timestamptz,
 unique(workspace_id,actor_id), unique(workspace_id,bot_id),
 foreign key(workspace_id,actor_id) references public.workspace_users(workspace_id,id),
 foreign key(workspace_id,broker_actor_id) references public.workspace_users(workspace_id,id),
 foreign key(bot_id,workspace_id) references public.bots(id,workspace_id),
 check(actor_id<>broker_actor_id)
);
alter table public.behavior_runtime_bindings enable row level security;
alter table public.behavior_runtime_bindings force row level security;
revoke all on public.behavior_runtime_bindings from public,novalure_app,novalure_tenant_app,novalure_behavior_publisher;
grant select,update(enabled) on public.behavior_runtime_bindings to novalure_behavior_resolver;
grant select on public.knowledge_area_grants,public.workspace_users,public.bots to novalure_behavior_resolver;
grant update(name) on public.workspace_users,public.bots to novalure_behavior_resolver;
create policy behavior_resolve_binding on public.behavior_runtime_bindings for select to novalure_behavior_resolver
 using(workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
create policy behavior_resolve_binding_lock on public.behavior_runtime_bindings for update to novalure_behavior_resolver
 using(workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid) with check(false);
create policy behavior_resolve_grants on public.knowledge_area_grants for select to novalure_behavior_resolver
 using(workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
create policy behavior_resolve_member on public.workspace_users for select to novalure_behavior_resolver
 using(workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
create policy behavior_resolve_member_lock on public.workspace_users for update to novalure_behavior_resolver
 using(workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid) with check(false);
create policy behavior_resolve_bot on public.bots for select to novalure_behavior_resolver
 using(workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
create policy behavior_resolve_bot_lock on public.bots for update to novalure_behavior_resolver
 using(workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid) with check(false);

create function public.behavior_lock_runtime(p_broker uuid,p_hash text)
returns table(id uuid,workspace_id uuid,actor_id uuid,bot_id uuid,department text)
language sql security definer set search_path=pg_catalog,public as $$
 select b.id,b.workspace_id,b.actor_id,b.bot_id,b.department
 from public.behavior_runtime_bindings b
 join public.workspace_users broker on broker.workspace_id=b.workspace_id and broker.id=b.broker_actor_id
 join public.workspace_users actor on actor.workspace_id=b.workspace_id and actor.id=b.actor_id
 join public.bots bot on bot.workspace_id=b.workspace_id and bot.id=b.bot_id
 where b.broker_actor_id=p_broker and b.token_hash=p_hash and b.enabled and b.revoked_at is null and b.expires_at>clock_timestamp()
 and b.workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid
 and nullif(current_setting('app.actor_id',true),'')::uuid in (b.broker_actor_id,b.actor_id)
 and broker.status='active' and actor.status='active' and actor.role='agent'
 and actor.product_role in ('novalure_operator','project_sales_member')
 for share of b,broker,actor,bot
$$;
alter function public.behavior_lock_runtime(uuid,text) owner to novalure_behavior_resolver;
revoke all on function public.behavior_lock_runtime(uuid,text) from public,novalure_app;
grant execute on function public.behavior_lock_runtime(uuid,text) to novalure_tenant_app;

-- Runtime actors keep their compartment even if a generic reader omits botId.
-- Revoked bindings remain restrictive; do not delete them to revoke a runtime.
create function public.behavior_runtime_area_allowed(p_workspace uuid,p_area uuid)
returns boolean language sql stable security definer set search_path=pg_catalog,public as $$
 select p_workspace=nullif(current_setting('app.tenant_id',true),'')::uuid and (
  not exists(select 1 from public.behavior_runtime_bindings r where r.workspace_id=p_workspace
    and r.actor_id=nullif(current_setting('app.actor_id',true),'')::uuid)
  or exists(select 1 from public.behavior_runtime_bindings r join public.knowledge_area_grants g
    on g.workspace_id=r.workspace_id and g.bot_id=r.bot_id and g.channel='internal' and g.area_id=p_area
    where r.workspace_id=p_workspace and r.actor_id=nullif(current_setting('app.actor_id',true),'')::uuid
    and r.enabled and r.revoked_at is null and r.expires_at>now())
 )
$$;
alter function public.behavior_runtime_area_allowed(uuid,uuid) owner to novalure_behavior_resolver;
revoke all on function public.behavior_runtime_area_allowed(uuid,uuid) from public,novalure_app;
grant execute on function public.behavior_runtime_area_allowed(uuid,uuid) to novalure_tenant_app;
create policy behavior_department_areas on public.knowledge_areas as restrictive for all to novalure_tenant_app
 using(public.behavior_runtime_area_allowed(workspace_id,id)) with check(public.behavior_runtime_area_allowed(workspace_id,id));
create policy behavior_department_sources on public.knowledge_sources as restrictive for all to novalure_tenant_app
 using(public.behavior_runtime_area_allowed(workspace_id,knowledge_area_id)) with check(public.behavior_runtime_area_allowed(workspace_id,knowledge_area_id));
-- Existing version/chunk/project policies resolve through knowledge_sources.
revoke create on schema public from novalure_behavior_resolver;
-- Native workload revocation is fenced until the context/signal transaction commits.
grant select,update(id) on public.crm_service_principals to novalure_behavior_resolver;
create policy behavior_resolve_principal on public.crm_service_principals for select to novalure_behavior_resolver
 using(workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
create policy behavior_resolve_principal_lock on public.crm_service_principals for update to novalure_behavior_resolver
 using(workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid) with check(false);
grant create on schema public to novalure_behavior_resolver;
create function public.behavior_lock_workload(p_principal uuid,p_broker uuid) returns boolean
language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 perform p.id from public.crm_service_principals p where p.id=p_principal and p.actor_user_id=p_broker
  and p.workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid
  and exists(select 1 from public.behavior_runtime_bindings b where b.workspace_id=p.workspace_id
    and b.broker_actor_id=p_broker and b.actor_id=nullif(current_setting('app.actor_id',true),'')::uuid
    and b.enabled and b.revoked_at is null and b.expires_at>clock_timestamp())
  and p.state='ACTIVE' and not p.kill_switch_active and p.revoked_at is null
  and p.not_before<=clock_timestamp() and p.expires_at>clock_timestamp() for share of p;
 return found;
end $$;
alter function public.behavior_lock_workload(uuid,uuid) owner to novalure_behavior_resolver;
revoke all on function public.behavior_lock_workload(uuid,uuid) from public,novalure_app;
grant execute on function public.behavior_lock_workload(uuid,uuid) to novalure_tenant_app;
revoke create on schema public from novalure_behavior_resolver;
