-- Create-only internal project configuration. Private note content has its own
-- actor-only relation and never enters the shared Project/Core projection.
set local lock_timeout = '5s';

create function public.crm_project_wizard_responsible_allowed(p_workspace uuid,p_user uuid)
returns boolean language sql stable security invoker set search_path=pg_catalog,public as $$
 select p_workspace=nullif(current_setting('app.tenant_id',true),'')::uuid and exists(
  select 1 from public.workspace_users u join public.workspaces w on w.id=u.workspace_id
  where u.workspace_id=p_workspace and u.id=p_user and u.status='active' and u.role in ('owner','admin','agent')
   and u.product_role in ('platform_admin','novalureGrowth','novalureServiceOps','novalureAdmin','novalure_sales','novalure_onboarding',
    'novalure_customer_success','novalure_operator','customer_owner','workspace_admin','team_member','broker_agent','developer_sales','project_sales_member','assistant_backoffice')
   and (w.operating_model<>'novalure_internal' or u.product_role in
    ('platform_admin','novalureServiceOps','novalureAdmin','novalure_sales','novalure_onboarding','novalure_customer_success','novalure_operator'))
   and (u.role in ('owner','admin') or u.product_role in
    ('platform_admin','novalureGrowth','novalureAdmin','novalure_sales','novalure_onboarding',
     'novalure_customer_success','novalure_operator','customer_owner','workspace_admin')))
$$;
revoke all on function public.crm_project_wizard_responsible_allowed(uuid,uuid) from public;
grant execute on function public.crm_project_wizard_responsible_allowed(uuid,uuid) to novalure_tenant_app;

-- The runtime cannot lock arbitrary auth rows directly. This boolean-only
-- lock is bounded to the current tenant and an already authorized manager.
create function public.crm_project_wizard_lock_responsible(p_workspace uuid,p_user uuid)
returns boolean language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 if p_workspace is distinct from nullif(current_setting('app.tenant_id',true),'')::uuid
  or not public.crm_workspace_manager(p_workspace)
  or not exists(select 1 from public.workspaces w where w.id=p_workspace
   and public.crm_classification_allowed(w.id,case when w.operating_model='novalure_internal' then 'NOVALURE_INTERNAL' else 'CUSTOMER_TENANT' end,'crm_sales'))
  or not exists(select 1 from public.workspace_users actor where actor.workspace_id=p_workspace
   and actor.id=nullif(current_setting('app.actor_id',true),'')::uuid and actor.status='active' and actor.role in ('owner','admin','agent') and actor.product_role not in ('external_partner','viewer')) then
  raise exception using errcode='42501',message='Project responsible lock context denied';
 end if;
 perform u.id from public.workspace_users u join public.workspaces w on w.id=u.workspace_id
  where u.workspace_id=p_workspace and u.id=p_user
  for share of u,w;
 if not found then return false; end if;
 -- Separate statement after acquiring the lock sees a demotion/suspension
 -- that committed while this transaction was waiting for that exact row.
 return public.crm_project_wizard_responsible_allowed(p_workspace,p_user);
end $$;
revoke all on function public.crm_project_wizard_lock_responsible(uuid,uuid) from public;
grant execute on function public.crm_project_wizard_lock_responsible(uuid,uuid) to novalure_tenant_app;

create table public.project_wizard_settings (
 workspace_id uuid not null references public.workspaces(id),
 project_id uuid not null,
 schema_version integer not null check(schema_version=1),
 type_key text not null check(type_key in ('real_estate_project','buyer_pipeline','seller_pipeline','investment_mandate','b2b_workspace')),
 responsible_user_id uuid,
 funnel_reference_id uuid,
 pipeline_template_key text not null check(pipeline_template_key in
  ('managed_customer_pipeline','developer_project_pipeline','novalure_sales_pipeline','broker_seller_pipeline')),
 created_by uuid not null,
 created_at timestamptz not null default now(),
 primary key(workspace_id,project_id),
 foreign key(workspace_id,project_id) references public.projects(workspace_id,id) on delete cascade,
 foreign key(workspace_id,responsible_user_id) references public.workspace_users(workspace_id,id),
 foreign key(workspace_id,funnel_reference_id) references public.funnels(workspace_id,id),
 foreign key(workspace_id,created_by) references public.workspace_users(workspace_id,id)
);
create table public.project_wizard_private_notes (
 workspace_id uuid not null,
 project_id uuid not null,
 actor_id uuid not null,
 private_notes text not null check(char_length(private_notes)<=4000),
 created_at timestamptz not null default now(),
 primary key(workspace_id,project_id,actor_id),
 foreign key(workspace_id,project_id) references public.project_wizard_settings(workspace_id,project_id) on delete cascade,
 foreign key(workspace_id,actor_id) references public.workspace_users(workspace_id,id)
);
alter table public.project_wizard_settings enable row level security;
alter table public.project_wizard_settings force row level security;
alter table public.project_wizard_private_notes enable row level security;
alter table public.project_wizard_private_notes force row level security;
create policy project_wizard_settings_read on public.project_wizard_settings for select to novalure_tenant_app
 using(workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid
  and public.crm_project_access(workspace_id,project_id,false)
  and exists(select 1 from public.projects p where p.workspace_id=project_wizard_settings.workspace_id and p.id=project_id));
create policy project_wizard_settings_create on public.project_wizard_settings for insert to novalure_tenant_app
 with check(workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid
  and created_by=nullif(current_setting('app.actor_id',true),'')::uuid
  and public.crm_workspace_manager(workspace_id) and public.crm_project_access(workspace_id,project_id,true)
  and exists(select 1 from public.projects p where p.workspace_id=project_wizard_settings.workspace_id and p.id=project_id));
create policy project_wizard_notes_read on public.project_wizard_private_notes for select to novalure_tenant_app
 using(workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid
  and actor_id=nullif(current_setting('app.actor_id',true),'')::uuid
  and public.crm_project_access(workspace_id,project_id,false)
  and exists(select 1 from public.project_wizard_settings s where s.workspace_id=project_wizard_private_notes.workspace_id and s.project_id=project_wizard_private_notes.project_id));
create policy project_wizard_notes_create on public.project_wizard_private_notes for insert to novalure_tenant_app
 with check(workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid
  and actor_id=nullif(current_setting('app.actor_id',true),'')::uuid
  and public.crm_project_access(workspace_id,project_id,true)
  and exists(select 1 from public.project_wizard_settings s where s.workspace_id=project_wizard_private_notes.workspace_id and s.project_id=project_wizard_private_notes.project_id and s.created_by=actor_id));
revoke all on public.project_wizard_settings,public.project_wizard_private_notes from public,novalure_app,novalure_tenant_app;
grant select,insert on public.project_wizard_settings,public.project_wizard_private_notes to novalure_tenant_app;

-- A direct INSERT must satisfy the same durable references as the repository.
-- No role, grant, source funnel, publication or existing pipeline is changed.
create function public.crm_project_wizard_settings_guard() returns trigger
language plpgsql security invoker set search_path=pg_catalog,public as $$
begin
 if new.responsible_user_id is not null and not public.crm_project_wizard_lock_responsible(new.workspace_id,new.responsible_user_id) then
  raise exception using errcode='42501',message='Project responsible user is not available';
 end if;
 if new.funnel_reference_id is not null and not exists(
  select 1 from public.funnels f join public.projects p on p.workspace_id=f.workspace_id and p.id=f.project_id
  where f.workspace_id=new.workspace_id and f.id=new.funnel_reference_id
   and public.crm_project_access(f.workspace_id,f.project_id,false)) then
  raise exception using errcode='42501',message='Project funnel reference is not available';
 end if;
 if not exists(select 1 from public.projects p join public.crm_pipelines cp
  on cp.workspace_id=p.workspace_id and cp.project_id=p.id and cp.id=p.default_pipeline_id
  where p.workspace_id=new.workspace_id and p.id=new.project_id and p.type=new.type_key
   and cp.key=new.pipeline_template_key
   and cp.key=case when p.default_operating_model='managed_by_novalure' then 'managed_customer_pipeline'
    when p.customer_type='property_developer' then 'developer_project_pipeline'
    when p.customer_type='novalure_internal' or p.default_operating_model='novalure_internal' then 'novalure_sales_pipeline'
    else 'broker_seller_pipeline' end
   and exists(select 1 from public.crm_pipeline_stages s where s.workspace_id=cp.workspace_id and s.project_id=cp.project_id and s.pipeline_id=cp.id)) then
  raise exception using errcode='23514',message='Project wizard pipeline or type binding is invalid';
 end if;
 return new;
end $$;
create trigger project_wizard_settings_guard before insert on public.project_wizard_settings
 for each row execute function public.crm_project_wizard_settings_guard();
revoke all on function public.crm_project_wizard_settings_guard() from public;
grant execute on function public.crm_project_wizard_settings_guard() to novalure_tenant_app;
