alter table projects add column if not exists developer_organization_id uuid references organizations(id);
-- Additive Flow B schema. Legacy rows receive no fabricated confirmation.
alter table leads add column if not exists version bigint not null default 1;
alter table leads add column if not exists sales_qualification jsonb not null default '{}';
alter table property_units add column if not exists version bigint not null default 1;
alter table property_reservations add column if not exists version bigint not null default 1;
alter table property_reservations add column if not exists buyer_lead_id uuid references leads(id);
alter table property_reservations add column if not exists confirmation jsonb;
alter table property_viewing_slots add column if not exists version bigint not null default 1;
alter table property_viewing_slots add column if not exists time_zone text;
alter table property_viewing_slots add column if not exists calendar_event_id uuid references calendar_events(id);
alter table property_reservations drop constraint if exists property_reservations_status_check;
alter table property_reservations add constraint property_reservations_status_check check(status in ('requested','hold','reserved','expired','converted'));
create unique index if not exists property_reservation_pending_request_idx on property_reservations(workspace_id,unit_id) where status='requested';
create unique index if not exists projects_workspace_id_unique on projects(workspace_id,id);
create unique index if not exists organizations_workspace_id_unique on organizations(workspace_id,id);
create unique index if not exists workspace_users_workspace_id_unique on workspace_users(workspace_id,id);
create unique index if not exists contacts_workspace_id_unique on contacts(workspace_id,id);
create unique index if not exists leads_workspace_project_id_unique on leads(workspace_id,project_id,id);
create unique index if not exists property_units_workspace_project_id_unique on property_units(workspace_id,project_id,id);
create unique index if not exists property_reservations_workspace_project_id_unique on property_reservations(workspace_id,project_id,id);
create table if not exists crm_project_sales_authorities (
 id uuid primary key default gen_random_uuid(),workspace_id uuid not null references workspaces(id),project_id uuid not null,user_id uuid not null,
 developer_organization_id uuid not null,contact_id uuid not null,
 can_confirm_price boolean not null default false,can_confirm_reservation boolean not null default false,can_confirm_sale boolean not null default false,
 enabled boolean not null default true,assignment_source text not null check(length(trim(assignment_source))>0),assigned_by uuid not null,
 version bigint not null default 1,created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 unique(workspace_id,project_id,user_id),
 foreign key(workspace_id,project_id) references projects(workspace_id,id),
 foreign key(workspace_id,user_id) references workspace_users(workspace_id,id),
 foreign key(workspace_id,assigned_by) references workspace_users(workspace_id,id),
 foreign key(workspace_id,developer_organization_id) references organizations(workspace_id,id),
 foreign key(workspace_id,contact_id) references contacts(workspace_id,id)
);
create table if not exists lead_sales_handovers (
 id uuid primary key default gen_random_uuid(),workspace_id uuid not null references workspaces(id),project_id uuid not null references projects(id),lead_id uuid not null,
 qualification_version bigint not null,recipient_user_id uuid not null,actor_id uuid not null,source_reference text not null check(length(trim(source_reference))>0),
 created_at timestamptz not null default now(),unique(workspace_id,lead_id,qualification_version),
 foreign key(workspace_id,project_id,lead_id) references leads(workspace_id,project_id,id),
 foreign key(workspace_id,recipient_user_id) references workspace_users(workspace_id,id),
 foreign key(workspace_id,actor_id) references workspace_users(workspace_id,id)
);
create table if not exists property_sales (
 id uuid primary key default gen_random_uuid(),workspace_id uuid not null references workspaces(id),project_id uuid not null references projects(id),unit_id uuid not null,
 reservation_id uuid not null,buyer_lead_id uuid not null,contact_id uuid not null,authority_id uuid not null references crm_project_sales_authorities(id),confirmed_by uuid not null,
 source_reference text not null check(length(trim(source_reference))>0),confirmed_at timestamptz not null default now(),unit_version bigint not null,
 unique(workspace_id,unit_id),unique(workspace_id,reservation_id),
 foreign key(workspace_id,project_id,unit_id) references property_units(workspace_id,project_id,id),
 foreign key(workspace_id,project_id,reservation_id) references property_reservations(workspace_id,project_id,id),
 foreign key(workspace_id,project_id,buyer_lead_id) references leads(workspace_id,project_id,id),
 foreign key(workspace_id,contact_id) references contacts(workspace_id,id),
 foreign key(workspace_id,confirmed_by) references workspace_users(workspace_id,id)
);
do $$ declare t text; begin
 foreach t in array array['crm_project_sales_authorities','lead_sales_handovers','property_sales'] loop
  execute format('alter table %I enable row level security',t);
  execute format('alter table %I force row level security',t);
  execute format('drop policy if exists crm_sales_project_scope on %I',t);
  execute format('create policy crm_sales_project_scope on %I using (crm_project_access(workspace_id,project_id,false)) with check (crm_project_access(workspace_id,project_id,true))',t);
 end loop;
end $$;

-- New confirmation links cannot cross workspace/project boundaries.
do $$ begin
 if not exists(select 1 from pg_constraint where conname='projects_developer_tenant_fk') then
  alter table projects add constraint projects_developer_tenant_fk foreign key(workspace_id,developer_organization_id) references organizations(workspace_id,id) not valid;
 end if;
 if not exists(select 1 from pg_constraint where conname='reservation_buyer_tenant_project_fk') then
  alter table property_reservations add constraint reservation_buyer_tenant_project_fk foreign key(workspace_id,project_id,buyer_lead_id) references leads(workspace_id,project_id,id) not valid;
 end if;
 if not exists(select 1 from pg_constraint where conname='viewing_end_after_start_check') then
  alter table property_viewing_slots add constraint viewing_end_after_start_check check(ends_at>starts_at) not valid;
 end if;
end $$;
grant select,insert,update on crm_project_sales_authorities,lead_sales_handovers,property_sales to novalure_tenant_app;

-- Match the common classification boundary and keep business evidence append-only.
do $$ declare t text; begin
 foreach t in array array['crm_project_sales_authorities','lead_sales_handovers','property_sales'] loop
  execute format('alter table %I add column if not exists data_classification text not null default ''UNCLASSIFIED'', add column if not exists data_purpose text not null default ''crm_sales''',t);
  execute format('drop trigger if exists crm_sales_classification_guard on %I',t);
  execute format('create trigger crm_sales_classification_guard before insert or update on %I for each row execute function crm_set_sales_classification()',t);
  execute format('drop policy if exists crm_sales_project_scope on %I',t);
  execute format('create policy crm_sales_project_read on %I for select to novalure_tenant_app using (crm_classification_allowed(workspace_id,data_classification,data_purpose) and crm_project_access(workspace_id,project_id,false))',t);
  if t='crm_project_sales_authorities' then
   execute format('create policy crm_sales_authority_write on %I for all to novalure_tenant_app using (crm_workspace_manager(workspace_id) and crm_classification_allowed(workspace_id,data_classification,data_purpose)) with check (crm_workspace_manager(workspace_id) and crm_classification_allowed(workspace_id,data_classification,data_purpose) and assigned_by=nullif(current_setting(''app.actor_id'',true),'''')::uuid)',t);
  else
   execute format('create policy crm_sales_evidence_insert on %I for insert to novalure_tenant_app with check (crm_classification_allowed(workspace_id,data_classification,data_purpose) and crm_project_access(workspace_id,project_id,true))',t);
   execute format('revoke update,delete on %I from novalure_tenant_app',t);
  end if;
 end loop;
end $$;

-- Existing unit history becomes append-only and project-scoped on the tenant runtime role.
alter table property_unit_audit_events enable row level security;
alter table property_unit_audit_events force row level security;
create policy crm_unit_audit_read on property_unit_audit_events for select to novalure_tenant_app
 using(crm_project_access(workspace_id,project_id,false));
create policy crm_unit_audit_insert on property_unit_audit_events for insert to novalure_tenant_app
 with check(crm_project_access(workspace_id,project_id,true) and actor_user_id=nullif(current_setting('app.actor_id',true),'')::uuid);
grant select,insert on property_unit_audit_events to novalure_tenant_app;
revoke update,delete on property_unit_audit_events from novalure_tenant_app;

-- Every developer listing publication path must use the same confirmed unit price.
-- Existing rows are not rewritten; a later publication/change is checked.
create or replace function crm_guard_developer_listing_price()
returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
declare is_developer boolean; confirmed_price bigint; confirmation jsonb; outgoing_price bigint;
begin
 select (p.developer_organization_id is not null or p.customer_type='property_developer'
  or lower(p.type) like '%bautr%' or w.customer_type='property_developer')
 into is_developer from public.projects p join public.workspaces w on w.id=p.workspace_id
 where p.workspace_id=new.workspace_id and p.id=new.project_id;
 if not coalesce(is_developer,false) then return new; end if;
 if new.price_visibility<>'publish_price' and not exists(select 1 from jsonb_each_text(coalesce(new.channel_price_visibility,'{}')) where value='publish_price') then return new; end if;
 outgoing_price:=coalesce(new.public_price_cents,new.target_price_cents,0);
 if outgoing_price<=0 then return new; end if;
 select u.price_cents,u.metadata->'priceConfirmation' into confirmed_price,confirmation
 from public.property_units u where u.workspace_id=new.workspace_id and u.project_id=new.project_id and u.id=new.unit_id;
 if confirmation is null or confirmed_price is distinct from outgoing_price
  or confirmation->>'sourceReference' is null
  or (confirmation->>'priceCents')::bigint is distinct from confirmed_price then
  raise exception using errcode='23514',message='Developer publication requires an authorized confirmed unit price';
 end if;
 return new;
end $$;
create trigger crm_developer_listing_price_guard before insert or update on seller_listings
 for each row execute function crm_guard_developer_listing_price();
