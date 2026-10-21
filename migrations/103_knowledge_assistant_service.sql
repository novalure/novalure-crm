-- Read-only assistant context through the existing CRM machine identity.
-- No credential, principal, provider, subscription or channel grant is seeded.
set local lock_timeout = '5s';
set local statement_timeout = '14min';

create table public.knowledge_assistant_service_bindings (
  principal_id uuid not null,
  workspace_id uuid not null,
  bot_id uuid not null,
  channel text not null check(channel in ('webchat','voice')),
  enabled boolean not null default true,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key(principal_id,channel),
  foreign key(workspace_id,principal_id) references public.crm_service_principals(workspace_id,id),
  foreign key(workspace_id,bot_id) references public.bots(workspace_id,id)
);
alter table public.knowledge_assistant_service_bindings enable row level security;
alter table public.knowledge_assistant_service_bindings force row level security;
revoke all on public.knowledge_assistant_service_bindings from public,novalure_app,novalure_tenant_app;

-- Only a narrow function reads this table. Provisioning/revocation belongs to
-- the trusted deployment/control plane, never public integration/model input.
-- FORCE RLS applies to a non-superuser migration owner too.
do $owner_policy$
begin
  execute format('create policy knowledge_service_owner_binding on public.knowledge_assistant_service_bindings for select to %I using(workspace_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',current_user);
  execute format('create policy knowledge_service_owner_binding_lock on public.knowledge_assistant_service_bindings for update to %I using(workspace_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid) with check(workspace_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',current_user);
  execute format('create policy knowledge_service_owner_principal on public.crm_service_principals for select to %I using(workspace_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid and actor_user_id=nullif(current_setting(''app.actor_id'',true),'''')::uuid)',current_user);
  execute format('create policy knowledge_service_owner_principal_lock on public.crm_service_principals for update to %I using(workspace_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid and actor_user_id=nullif(current_setting(''app.actor_id'',true),'''')::uuid) with check(workspace_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid and actor_user_id=nullif(current_setting(''app.actor_id'',true),'''')::uuid)',current_user);
end $owner_policy$;

create function public.knowledge_lock_assistant_service_binding(p_principal uuid,p_channel text)
returns table(bot_id uuid,workspace_id uuid)
language plpgsql security definer set search_path=pg_catalog,public as $function$
begin
  -- Bind the executing verified actor and tenant before exposing any mapping.
  -- Hold principal/binding locks until retrieval and its audit commit. The
  -- caller re-runs crm_authenticate_machine after these locks, including the
  -- existing identity/workload/state/kill-switch checks, without changing them.
  perform p.id from public.crm_service_principals p
    where p.id=p_principal
      and p.workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid
      and p.actor_user_id=nullif(current_setting('app.actor_id',true),'')::uuid
      and p.revoked_at is null and p.expires_at>clock_timestamp()
    for share of p;
  if not found then return; end if;
  return query select b.bot_id,b.workspace_id
    from public.knowledge_assistant_service_bindings b
    where b.principal_id=p_principal and b.channel=p_channel
      and b.workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid
      and b.enabled and b.revoked_at is null
    for share of b;
end $function$;
revoke all on function public.knowledge_lock_assistant_service_binding(uuid,text) from public,novalure_app;
grant execute on function public.knowledge_lock_assistant_service_binding(uuid,text) to novalure_tenant_app;
