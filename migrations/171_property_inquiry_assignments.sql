-- Current staff-confirmed routing is separate from immutable original incoming enquiries (121).
create function crm_inquiry_assignment_access(w uuid,l uuid,writing boolean default false)
returns boolean language sql stable security invoker set search_path=pg_catalog,public as $$
 select w=nullif(current_setting('app.tenant_id',true),'')::uuid and exists(
 select 1 from leads lead join contacts c on c.id=lead.contact_id and c.workspace_id=lead.workspace_id
 where lead.workspace_id=w and lead.id=l and c.archived_at is null
 and crm_classification_allowed(lead.workspace_id,lead.data_classification,lead.data_purpose)
 and crm_classification_allowed(c.workspace_id,c.data_classification,c.data_purpose)
 and crm_project_access(w,lead.project_id,writing)
 and (c.project_id is null or c.project_id is not distinct from lead.project_id)
 and (crm_workspace_manager(w) or (lead.assigned_to_user_id=nullif(current_setting('app.actor_id',true),'')::uuid and c.owner_user_id=nullif(current_setting('app.actor_id',true),'')::uuid))
 and exists(select 1 from workspace_users u where u.workspace_id=w and u.id=nullif(current_setting('app.actor_id',true),'')::uuid and u.status='active'
 and (not writing or (u.role in('owner','admin','agent') and u.product_role in('platform_admin','novalureGrowth','novalureAdmin','novalure_sales','novalure_onboarding','novalure_customer_success','novalure_operator','customer_owner','workspace_admin','team_member','broker_agent','developer_sales','project_sales_member','assistant_backoffice')))))
$$;
revoke all on function crm_inquiry_assignment_access(uuid,uuid,boolean) from public;
grant execute on function crm_inquiry_assignment_access(uuid,uuid,boolean) to novalure_tenant_app;

create table property_inquiry_assignments (
 id uuid primary key default gen_random_uuid(),workspace_id uuid not null,project_id uuid,lead_id uuid not null,property_id uuid not null,unit_id uuid,
 version integer not null default 1 check(version>0),confirmed_by uuid not null,confirmed_at timestamptz not null default now(),
 data_classification text not null default 'UNCLASSIFIED',data_purpose text not null default 'crm_sales',
 unique(workspace_id,id),unique(workspace_id,lead_id),
 foreign key(workspace_id,project_id) references projects(workspace_id,id),foreign key(workspace_id,lead_id) references leads(workspace_id,id),
 foreign key(workspace_id,property_id) references seller_listings(workspace_id,id),foreign key(workspace_id,unit_id) references property_units(workspace_id,id),
 foreign key(workspace_id,confirmed_by) references workspace_users(workspace_id,id)
);
create table property_inquiry_assignment_history (
 workspace_id uuid not null,assignment_id uuid not null,project_id uuid,lead_id uuid not null,property_id uuid not null,unit_id uuid,
 version integer not null,confirmed_by uuid not null,confirmed_at timestamptz not null,
 data_classification text not null,data_purpose text not null,
 primary key(workspace_id,assignment_id,version),foreign key(workspace_id,assignment_id) references property_inquiry_assignments(workspace_id,id),
 foreign key(workspace_id,project_id) references projects(workspace_id,id),foreign key(workspace_id,lead_id) references leads(workspace_id,id),
 foreign key(workspace_id,property_id) references seller_listings(workspace_id,id),foreign key(workspace_id,unit_id) references property_units(workspace_id,id),
 foreign key(workspace_id,confirmed_by) references workspace_users(workspace_id,id)
);
create index inquiry_assignment_property on property_inquiry_assignments(workspace_id,property_id);

create function crm_inquiry_assignment_guard() returns trigger language plpgsql set search_path=pg_catalog,public as $$
declare lead_project uuid;property_record seller_listings;
begin
 if not crm_inquiry_assignment_access(new.workspace_id,new.lead_id,true) then raise exception using errcode='42501',message='Inquiry assignment denied'; end if;
 select project_id into lead_project from leads where workspace_id=new.workspace_id and id=new.lead_id for share;
 if new.project_id is distinct from lead_project then raise exception using errcode='23514',message='Inquiry project differs'; end if;
 perform id from contacts where workspace_id=new.workspace_id and id=(select contact_id from leads where workspace_id=new.workspace_id and id=new.lead_id) for share;
 select * into property_record from seller_listings where workspace_id=new.workspace_id and id=new.property_id and project_id is not distinct from new.project_id and crm_classification_allowed(workspace_id,data_classification,data_purpose) for share;
 if not found then raise exception using errcode='23514',message='Inquiry property differs'; end if;
 if new.unit_id is not null then
  perform id from property_units where workspace_id=new.workspace_id and id=new.unit_id and project_id is not distinct from new.project_id and (id=property_record.unit_id or metadata->>'sellerListingId'=new.property_id::text) and coalesce(metadata->>'hidden','false')<>'true' and crm_classification_allowed(workspace_id,data_classification,data_purpose) for share;
  if not found then raise exception using errcode='23514',message='Inquiry unit is not linked to property'; end if;
 end if;
 if tg_op='INSERT' and new.version<>1 then raise exception using errcode='23514',message='Initial inquiry assignment revision must be one'; end if;
 if tg_op='UPDATE' and ((to_jsonb(new)-array['property_id','unit_id','version','confirmed_by','confirmed_at']) is distinct from (to_jsonb(old)-array['property_id','unit_id','version','confirmed_by','confirmed_at']) or new.version<>old.version+1 or (new.property_id=old.property_id and new.unit_id is not distinct from old.unit_id)) then raise exception using errcode='23514',message='Inquiry assignment comparison revision or immutable scope changed'; end if;
 new.confirmed_by:=nullif(current_setting('app.actor_id',true),'')::uuid;new.confirmed_at:=clock_timestamp();return new;
end $$;
create trigger a_inquiry_assignment_classification before insert or update on property_inquiry_assignments for each row execute function crm_set_sales_classification();
create trigger b_inquiry_assignment_guard before insert or update on property_inquiry_assignments for each row execute function crm_inquiry_assignment_guard();
create function crm_inquiry_assignment_history_guard() returns trigger language plpgsql set search_path=pg_catalog,public as $$
begin
 if tg_op<>'INSERT' then raise exception using errcode='23514',message='Inquiry assignment history is immutable'; end if;
 if not exists(select 1 from property_inquiry_assignments a where a.workspace_id=new.workspace_id and a.id=new.assignment_id and a.version=new.version and (to_jsonb(a)-'id')=(to_jsonb(new)-'assignment_id') and a.confirmed_by=nullif(current_setting('app.actor_id',true),'')::uuid) then raise exception using errcode='23514',message='History must reflect the actual confirmed assignment'; end if;
 return new;
end $$;
create trigger inquiry_assignment_history_guard before insert or update or delete on property_inquiry_assignment_history for each row execute function crm_inquiry_assignment_history_guard();
create function crm_record_inquiry_assignment_history() returns trigger language plpgsql set search_path=pg_catalog,public as $$
begin
 insert into property_inquiry_assignment_history(workspace_id,assignment_id,project_id,lead_id,property_id,unit_id,version,confirmed_by,confirmed_at,data_classification,data_purpose)
 values(new.workspace_id,new.id,new.project_id,new.lead_id,new.property_id,new.unit_id,new.version,new.confirmed_by,new.confirmed_at,new.data_classification,new.data_purpose);return new;
end $$;
create trigger inquiry_assignment_history after insert or update on property_inquiry_assignments for each row execute function crm_record_inquiry_assignment_history();

alter table property_inquiry_assignments enable row level security;
alter table property_inquiry_assignments force row level security;
alter table property_inquiry_assignment_history enable row level security;
alter table property_inquiry_assignment_history force row level security;
create policy inquiry_assignment_read on property_inquiry_assignments for select to novalure_tenant_app using(crm_inquiry_assignment_access(workspace_id,lead_id,false) and crm_classification_allowed(workspace_id,data_classification,data_purpose));
create policy inquiry_assignment_insert on property_inquiry_assignments for insert to novalure_tenant_app with check(crm_inquiry_assignment_access(workspace_id,lead_id,true) and crm_classification_allowed(workspace_id,data_classification,data_purpose));
create policy inquiry_assignment_update on property_inquiry_assignments for update to novalure_tenant_app using(crm_inquiry_assignment_access(workspace_id,lead_id,true)) with check(crm_inquiry_assignment_access(workspace_id,lead_id,true) and crm_classification_allowed(workspace_id,data_classification,data_purpose));
create policy inquiry_assignment_history_read on property_inquiry_assignment_history for select to novalure_tenant_app using(crm_inquiry_assignment_access(workspace_id,lead_id,false) and crm_classification_allowed(workspace_id,data_classification,data_purpose));
create policy inquiry_assignment_history_insert on property_inquiry_assignment_history for insert to novalure_tenant_app with check(crm_inquiry_assignment_access(workspace_id,lead_id,true) and crm_classification_allowed(workspace_id,data_classification,data_purpose));
revoke all on property_inquiry_assignments,property_inquiry_assignment_history from public,novalure_tenant_app;
grant select,insert,update on property_inquiry_assignments to novalure_tenant_app;
grant select,insert on property_inquiry_assignment_history to novalure_tenant_app;
revoke all on function crm_inquiry_assignment_guard(),crm_inquiry_assignment_history_guard(),crm_record_inquiry_assignment_history() from public;
