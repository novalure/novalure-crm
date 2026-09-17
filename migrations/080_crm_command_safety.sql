-- Sales command cutover. Additive business fields, scoped execution and immutable receipts.
-- Apply only to an explicitly approved target after deploying the command entry wrappers.
set local lock_timeout = '5s';
set local statement_timeout = '14min';

alter table project_pipeline_permissions add column if not exists can_read boolean not null default true;

-- These narrow read-and-lock functions avoid granting UPDATE on authentication tables.
-- Input must match the transaction context; no caller-controlled SQL or search path.
create or replace function crm_lock_active_member(p_workspace uuid,p_actor uuid)
returns table(role text,product_role text,operating_model text,auth_identity_id uuid)
language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  if p_workspace is distinct from nullif(current_setting('app.tenant_id',true),'')::uuid
     or p_actor is distinct from nullif(current_setting('app.actor_id',true),'')::uuid then
    raise exception using errcode='42501',message='Membership lock context mismatch';
  end if;
  return query select u.role::text,u.product_role::text,w.operating_model::text,u.auth_identity_id
    from public.workspace_users u join public.workspaces w on w.id=u.workspace_id
    where u.id=p_actor and u.workspace_id=p_workspace and u.status='active'
    for share of u,w;
end $$;
create or replace function crm_lock_active_session(p_session uuid,p_identity uuid)
returns boolean language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  perform s.id from public.auth_sessions s where s.id=p_session and s.auth_identity_id=p_identity
    and s.revoked_at is null and s.expires_at>now()
    and exists(select 1 from public.workspace_users u where u.id=nullif(current_setting('app.actor_id',true),'')::uuid
      and u.workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid and u.auth_identity_id=p_identity and u.status='active')
    for share of s;
  return found;
end $$;
revoke all on function crm_lock_active_member(uuid,uuid),crm_lock_active_session(uuid,uuid) from public;
grant execute on function crm_lock_active_member(uuid,uuid),crm_lock_active_session(uuid,uuid) to novalure_tenant_app;

create or replace function crm_workspace_manager(p_workspace uuid)
returns boolean language sql stable security invoker set search_path=pg_catalog,public as $$
  select p_workspace = nullif(current_setting('app.tenant_id',true),'')::uuid and exists(
    select 1 from public.workspace_users u where u.workspace_id=p_workspace
      and u.id=nullif(current_setting('app.actor_id',true),'')::uuid and u.status='active'
      and (u.role in ('owner','admin') or u.product_role in
        ('platform_admin','novalureGrowth','novalureAdmin','novalure_sales','novalure_onboarding',
         'novalure_customer_success','novalure_operator','customer_owner','workspace_admin'))
  )
$$;

create or replace function crm_project_access(p_workspace uuid,p_project uuid,p_write boolean default false)
returns boolean language sql stable security invoker set search_path=pg_catalog,public as $$
  select p_workspace = nullif(current_setting('app.tenant_id',true),'')::uuid and exists(
    select 1 from public.workspace_users u where u.workspace_id=p_workspace
      and u.id=nullif(current_setting('app.actor_id',true),'')::uuid and u.status='active'
      and (not p_write or u.role in ('owner','admin','agent'))
      and (public.crm_workspace_manager(p_workspace) or exists(
        select 1 from public.project_pipeline_permissions g where g.workspace_id=p_workspace
          and g.project_id=p_project and g.user_id=u.id and g.can_read
          and (not p_write or g.can_edit_deals)))
  )
$$;

create or replace function crm_classification_allowed(p_workspace uuid,p_class text,p_purpose text)
returns boolean language sql stable security invoker set search_path=pg_catalog,public as $$
  select p_workspace = nullif(current_setting('app.tenant_id',true),'')::uuid
    and p_purpose='crm_sales' and exists (
      select 1 from public.workspaces w join public.workspace_users u on u.workspace_id=w.id
      where w.id=p_workspace and u.id=nullif(current_setting('app.actor_id',true),'')::uuid and u.status='active'
        and ((p_class='CUSTOMER_TENANT' and w.operating_model in ('self_service_customer','managed_by_novalure','hybrid'))
          or (p_class='NOVALURE_INTERNAL' and w.operating_model='novalure_internal'
            and u.product_role in ('platform_admin','novalureGrowth','novalureServiceOps','novalureAdmin','novalure_sales',
              'novalure_onboarding','novalure_customer_success','novalure_operator'))))
$$;

create or replace function crm_lock_project_access(p_workspace uuid,p_project uuid,p_write boolean)
returns boolean language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  if not public.crm_project_access(p_workspace,p_project,p_write) then return false; end if;
  if public.crm_workspace_manager(p_workspace) then return true; end if;
  perform g.id from public.project_pipeline_permissions g
    where g.workspace_id=p_workspace and g.project_id=p_project
      and g.user_id=nullif(current_setting('app.actor_id',true),'')::uuid
      and g.can_read and (not p_write or g.can_edit_deals) for share;
  return found;
end $$;
revoke all on function crm_lock_project_access(uuid,uuid,boolean) from public;
grant execute on function crm_lock_project_access(uuid,uuid,boolean) to novalure_tenant_app;

-- Metadata classification is derived only from an explicit persisted workspace model.
-- PRIVATE_FRANZ / UNCLASSIFIED are never made readable by the sales policies.
create or replace function crm_set_sales_classification()
returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
declare model text;
begin
  if TG_OP='UPDATE' then
    if new.workspace_id is distinct from old.workspace_id
       or new.data_classification is distinct from old.data_classification
       or new.data_purpose is distinct from old.data_purpose then
      raise exception using errcode='42501',message='Sales commands cannot change tenant or data classification';
    end if;
  elsif new.data_classification='UNCLASSIFIED' then
    select operating_model into model from public.workspaces where id=new.workspace_id;
    new.data_classification := case when model='novalure_internal' then 'NOVALURE_INTERNAL'
      when model in ('self_service_customer','managed_by_novalure','hybrid') then 'CUSTOMER_TENANT' else 'UNCLASSIFIED' end;
  end if;
  return new;
end $$;

do $migration$
declare target_table text; project_expression text; read_scope text; write_scope text;
begin
  foreach target_table in array array['projects','organizations','contacts','leads','deals','tasks','property_units','property_buildings'] loop
    execute format('alter table %I add column if not exists version bigint not null default 1 check(version>=1)',target_table);
  end loop;
  foreach target_table in array array['projects','organizations','contacts','leads','deals','tasks','property_units','property_buildings',
    'property_reservations','property_viewing_slots','property_offer_milestones','buyer_search_profiles','broker_mandates','seller_listings',
    'calendar_events','property_cost_items','property_documents','property_media','property_text_blocks','crm_pipelines','crm_pipeline_stages',
    'funnels','funnel_steps','newsletter_campaigns','newsletter_segments','crm_bots','bots','editor_preflight_runs',
    'consent_records','consent_policy_decisions','newsletter_suppressions','contact_timeline_items','crm_outreach_deliveries',
    'analytics_events','speed_to_lead_events','dashboard_views'] loop
    if to_regclass('public.'||target_table) is null then continue; end if;
    execute format('alter table %I add column if not exists data_classification text not null default ''UNCLASSIFIED'', add column if not exists data_purpose text not null default ''crm_sales''',target_table);
    execute format('update %I t set data_classification=case when w.operating_model=''novalure_internal'' then ''NOVALURE_INTERNAL'' when w.operating_model in (''self_service_customer'',''managed_by_novalure'',''hybrid'') then ''CUSTOMER_TENANT'' else ''UNCLASSIFIED'' end from workspaces w where w.id=t.workspace_id and t.data_classification=''UNCLASSIFIED''',target_table);
    execute format('drop trigger if exists crm_sales_classification_guard on %I',target_table);
    execute format('create trigger crm_sales_classification_guard before insert or update on %I for each row execute function crm_set_sales_classification()',target_table);
    if target_table='projects' then project_expression:='id';
    elsif exists(select 1 from information_schema.columns where table_schema='public' and information_schema.columns.table_name=target_table and column_name='project_id') then project_expression:='project_id';
    else project_expression:='null::uuid'; end if;
    read_scope:=format('crm_project_access(workspace_id,%s,false)',project_expression);
    write_scope:=format('crm_project_access(workspace_id,%s,true)',project_expression);
    if target_table in ('contacts','deals','tasks') then
      read_scope:=format('(%s or (project_id is null and owner_user_id=nullif(current_setting(''app.actor_id'',true),'''')::uuid))',read_scope);
      write_scope:=format('(%s or (project_id is null and owner_user_id=nullif(current_setting(''app.actor_id'',true),'''')::uuid))',write_scope);
    elsif target_table='leads' then
      read_scope:=format('(%s or (project_id is null and assigned_to_user_id=nullif(current_setting(''app.actor_id'',true),'''')::uuid))',read_scope);
      write_scope:=format('(%s or (project_id is null and assigned_to_user_id=nullif(current_setting(''app.actor_id'',true),'''')::uuid))',write_scope);
    end if;
    write_scope:=format('(%s and exists(select 1 from workspace_users actor where actor.id=nullif(current_setting(''app.actor_id'',true),'''')::uuid and actor.workspace_id=workspace_id and actor.status=''active'' and actor.role in (''owner'',''admin'',''agent'')))',write_scope);
    -- Replace the permissive pilot policy; policies combine with OR otherwise.
    execute format('drop policy if exists %I on %I',target_table||'_tenant_actor_policy',target_table);
    execute format('drop policy if exists crm_sales_read on %I',target_table);
    execute format('drop policy if exists crm_sales_write on %I',target_table);
    execute format('create policy crm_sales_read on %I for select to novalure_tenant_app using (crm_classification_allowed(workspace_id,data_classification,data_purpose) and %s)',target_table,read_scope);
    execute format('create policy crm_sales_write on %I for all to novalure_tenant_app using (crm_classification_allowed(workspace_id,data_classification,data_purpose) and %s) with check (crm_classification_allowed(workspace_id,data_classification,data_purpose) and %s)',target_table,write_scope,write_scope);
    execute format('alter table %I enable row level security',target_table);
    execute format('alter table %I force row level security',target_table);
    execute format('grant select,insert,update on %I to novalure_tenant_app',target_table);
  end loop;
end $migration$;

create table crm_command_receipts (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id),
  project_id uuid,
  actor_user_id uuid not null,
  operation text not null,
  resource_id uuid,
  idempotency_key text not null check(idempotency_key ~* '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  request_hash text not null check(request_hash ~ '^[a-f0-9]{64}$'),
  response jsonb not null,
  audit_reference uuid not null references audit_logs(id),
  correlation_id uuid not null,
  data_classification text not null,
  data_purpose text not null default 'crm_sales',
  created_at timestamptz not null default now(),
  unique(workspace_id,idempotency_key),unique(workspace_id,id),
  foreign key(workspace_id,project_id) references projects(workspace_id,id),
  foreign key(workspace_id,actor_user_id) references workspace_users(workspace_id,id)
);
create table crm_domain_events (
  sequence bigint generated always as identity primary key,
  id uuid not null unique default gen_random_uuid(),
  contract_version text not null default '1' check(contract_version='1'),
  workspace_id uuid not null references workspaces(id),
  project_id uuid,
  actor_user_id uuid not null,
  event_type text not null,
  resource_id uuid,
  command_id uuid not null,
  audit_reference uuid not null references audit_logs(id),
  correlation_id uuid not null,
  payload jsonb not null check(jsonb_typeof(payload)='object'),
  data_classification text not null,
  data_purpose text not null default 'crm_sales',
  created_at timestamptz not null default now(),
  unique(workspace_id,command_id),
  foreign key(workspace_id,command_id) references crm_command_receipts(workspace_id,id),
  foreign key(workspace_id,project_id) references projects(workspace_id,id),
  foreign key(workspace_id,actor_user_id) references workspace_users(workspace_id,id)
);
create index crm_domain_events_workspace_sequence on crm_domain_events(workspace_id,sequence);

create or replace function crm_reject_immutable_mutation()
returns trigger language plpgsql set search_path=pg_catalog,public as $$
begin raise exception using errcode='55000',message='CRM command receipts and domain events are immutable'; end $$;

do $migration$
declare t text;
begin
  foreach t in array array['crm_command_receipts','crm_domain_events'] loop
    execute format('alter table %I enable row level security',t);
    execute format('alter table %I force row level security',t);
    execute format('create policy crm_receipt_scope on %I to novalure_tenant_app using (crm_classification_allowed(workspace_id,data_classification,data_purpose) and (actor_user_id=nullif(current_setting(''app.actor_id'',true),'''')::uuid or crm_project_access(workspace_id,project_id,false))) with check (crm_classification_allowed(workspace_id,data_classification,data_purpose) and actor_user_id=nullif(current_setting(''app.actor_id'',true),'''')::uuid)',t);
    execute format('create trigger crm_immutable_guard before update or delete or truncate on %I for each statement execute function crm_reject_immutable_mutation()',t);
    execute format('revoke all on %I from public',t);
    execute format('grant select,insert on %I to novalure_tenant_app',t);
  end loop;
  foreach t in array array['property_unit_idempotency','property_building_idempotency'] loop
    execute format('alter table %I enable row level security',t);
    execute format('alter table %I force row level security',t);
    execute format('create policy crm_inventory_receipt_scope on %I to novalure_tenant_app using (crm_project_access(workspace_id,project_id,false)) with check (crm_project_access(workspace_id,project_id,true))',t);
    execute format('create trigger crm_immutable_guard before update or delete or truncate on %I for each statement execute function crm_reject_immutable_mutation()',t);
    execute format('grant select,insert on %I to novalure_tenant_app',t);
  end loop;
end $migration$;
grant usage,select on sequence crm_domain_events_sequence_seq to novalure_tenant_app;
grant select on workspaces,workspace_users,auth_sessions,project_pipeline_permissions to novalure_tenant_app;
grant select,insert on audit_logs to novalure_tenant_app;
alter table deal_stage_history enable row level security;
alter table deal_stage_history force row level security;
create policy crm_stage_history_read on deal_stage_history for select to novalure_tenant_app using(crm_project_access(workspace_id,project_id,false));
create policy crm_stage_history_append on deal_stage_history for insert to novalure_tenant_app with check(crm_project_access(workspace_id,project_id,true) and changed_by_user_id=nullif(current_setting('app.actor_id',true),'')::uuid);
create trigger crm_stage_history_immutable before update or delete or truncate on deal_stage_history for each statement execute function crm_reject_immutable_mutation();
revoke all on deal_stage_history from public;
grant select,insert on deal_stage_history to novalure_tenant_app;
revoke update,delete,truncate on analytics_events,speed_to_lead_events from novalure_tenant_app;
-- Core needs only display metadata for already-visible project media/documents.
-- Do not grant private storage paths, URLs, share tokens or media mutation rights.
alter table media_assets enable row level security;
alter table media_assets force row level security;
create policy crm_media_metadata_read on media_assets for select to novalure_tenant_app using (
  workspace_id=nullif(current_setting('app.tenant_id',true),'') and (
    exists(select 1 from property_media pm where pm.media_asset_id=media_assets.id and pm.workspace_id::text=media_assets.workspace_id)
    or exists(select 1 from property_documents pd where pd.media_asset_id=media_assets.id and pd.workspace_id::text=media_assets.workspace_id)
  )
);
grant select(id,workspace_id,name,mime_type) on media_assets to novalure_tenant_app;

-- Dashboard layouts are personal configuration, with explicitly shared views.
-- A workspace manager must not gain read access to another user's personal view.
drop policy crm_sales_read on dashboard_views;
drop policy crm_sales_write on dashboard_views;
create policy crm_dashboard_read on dashboard_views for select to novalure_tenant_app using (
  crm_classification_allowed(workspace_id,data_classification,data_purpose)
  and (user_id is null or user_id=nullif(current_setting('app.actor_id',true),'')::uuid)
  and (project_id is null or crm_project_access(workspace_id,project_id,false))
);
create policy crm_dashboard_write on dashboard_views for all to novalure_tenant_app using (
  crm_classification_allowed(workspace_id,data_classification,data_purpose)
  and (user_id=nullif(current_setting('app.actor_id',true),'')::uuid or (user_id is null and crm_workspace_manager(workspace_id)))
  and (project_id is null or crm_project_access(workspace_id,project_id,true))
  and exists(select 1 from workspace_users actor where actor.id=nullif(current_setting('app.actor_id',true),'')::uuid and actor.role in ('owner','admin','agent'))
) with check (
  crm_classification_allowed(workspace_id,data_classification,data_purpose)
  and (user_id=nullif(current_setting('app.actor_id',true),'')::uuid or (user_id is null and crm_workspace_manager(workspace_id)))
  and (project_id is null or crm_project_access(workspace_id,project_id,true))
  and exists(select 1 from workspace_users actor where actor.id=nullif(current_setting('app.actor_id',true),'')::uuid and actor.role in ('owner','admin','agent'))
);
alter table dashboard_views add constraint dashboard_views_sales_project_fk foreign key(workspace_id,project_id) references projects(workspace_id,id) not valid;
alter table dashboard_views validate constraint dashboard_views_sales_project_fk;
alter table dashboard_views add constraint dashboard_views_sales_user_fk foreign key(workspace_id,user_id) references workspace_users(workspace_id,id) not valid;
alter table dashboard_views validate constraint dashboard_views_sales_user_fk;
revoke all on function crm_reject_immutable_mutation() from public;
comment on table crm_domain_events is 'Atomic CRM domain event ledger; no external publisher or Evelyn connection enabled.';
