-- Versioned company presentation. Content/media authorization remains the property's responsibility.
create function crm_expose_template_access(w uuid,writing boolean default false) returns boolean language sql stable security invoker set search_path=pg_catalog,public as $$
 select w=nullif(current_setting('app.tenant_id',true),'')::uuid and exists(select 1 from workspace_users u where u.workspace_id=w and u.id=nullif(current_setting('app.actor_id',true),'')::uuid and u.status='active' and u.product_role<>'external_partner' and (not writing or (u.role in('owner','admin','agent') and u.product_role in('platform_admin','novalureAdmin','novalure_onboarding','novalure_customer_success','customer_owner','workspace_admin'))))
$$;
revoke all on function crm_expose_template_access(uuid,boolean) from public;
grant execute on function crm_expose_template_access(uuid,boolean) to novalure_tenant_app;
create function crm_expose_template_config_valid(c jsonb) returns boolean language sql immutable set search_path=pg_catalog,public as $$
 select coalesce((jsonb_typeof(c)='object' and (select count(*) from jsonb_object_keys(c))=5 and c->'schemaVersion'='1'::jsonb
 and jsonb_typeof(c->'name')='string' and length(trim(c->>'name')) between 1 and 120
 and jsonb_typeof(c->'companyName')='string' and length(trim(c->>'companyName')) between 1 and 100 and ((c->>'name')||(c->>'companyName')) !~ '[[:cntrl:]]'
 and jsonb_typeof(c->'accentColor')='string' and c->>'accentColor' ~ '^#[0-9a-fA-F]{6}$'
 and jsonb_typeof(c->'sectionOrder')='array' and jsonb_array_length(c->'sectionOrder')=11 and c->'sectionOrder'->>0='hero'
 and (select array_agg(s order by s)=array['contact','description','documents','facts','floorplans','gallery','hero','links','location','units','videos']::text[] from jsonb_array_elements_text(c->'sectionOrder') s)),false)
$$;
create table web_expose_templates (
 id uuid primary key default gen_random_uuid(),workspace_id uuid not null references workspaces(id),revision integer not null default 1 check(revision>0),latest_version integer not null default 1 check(latest_version>0),archived boolean not null default false,
 created_by uuid not null,created_at timestamptz not null default now(),updated_by uuid not null,updated_at timestamptz not null default now(),data_classification text not null default 'UNCLASSIFIED',data_purpose text not null default 'crm_sales',
 unique(workspace_id,id),foreign key(workspace_id,created_by) references workspace_users(workspace_id,id),foreign key(workspace_id,updated_by) references workspace_users(workspace_id,id)
);
create table web_expose_template_versions (
 id uuid primary key default gen_random_uuid(),workspace_id uuid not null,template_id uuid not null,version integer not null check(version>0),configuration jsonb not null check(crm_expose_template_config_valid(configuration)),created_by uuid not null,created_at timestamptz not null default now(),
 data_classification text not null default 'UNCLASSIFIED',data_purpose text not null default 'crm_sales',unique(workspace_id,id),unique(workspace_id,template_id,version),foreign key(workspace_id,template_id) references web_expose_templates(workspace_id,id),foreign key(workspace_id,created_by) references workspace_users(workspace_id,id)
);
alter table web_expose_templates add constraint expose_template_current_version foreign key(workspace_id,id,latest_version) references web_expose_template_versions(workspace_id,template_id,version) deferrable initially deferred;
create function crm_expose_template_guard() returns trigger language plpgsql set search_path=pg_catalog,public as $$
begin
 if tg_op='DELETE' then raise exception using errcode='23514',message='Company template versions are immutable'; end if;
 if not crm_expose_template_access(new.workspace_id,true) then raise exception using errcode='42501',message='Company template management denied'; end if;
 if tg_table_name='web_expose_template_versions' then
  if tg_op<>'INSERT' then raise exception using errcode='23514',message='Company template versions are immutable'; end if;
  if not exists(select 1 from web_expose_templates t where t.workspace_id=new.workspace_id and t.id=new.template_id and not t.archived and t.latest_version=new.version) then raise exception using errcode='23514',message='Template version does not match current head'; end if;
  new.created_by:=nullif(current_setting('app.actor_id',true),'')::uuid;new.created_at:=clock_timestamp();
 else
  if tg_op='INSERT' then
   if new.revision<>1 or new.latest_version<>1 or new.archived then raise exception using errcode='23514',message='Initial company template revision is invalid'; end if;
   new.created_by:=nullif(current_setting('app.actor_id',true),'')::uuid;new.created_at:=clock_timestamp();
  elsif old.archived or (to_jsonb(new)-array['revision','latest_version','archived','updated_by','updated_at']) is distinct from (to_jsonb(old)-array['revision','latest_version','archived','updated_by','updated_at']) or new.revision<>old.revision+1 or not ((new.archived and new.latest_version=old.latest_version) or (not new.archived and new.latest_version=old.latest_version+1)) then raise exception using errcode='23514',message='Template scope, archive or comparison revision invalid'; end if;
  new.updated_by:=nullif(current_setting('app.actor_id',true),'')::uuid;new.updated_at:=clock_timestamp();
 end if;return new;
end $$;
create trigger a_expose_template_classification before insert or update on web_expose_templates for each row execute function crm_set_sales_classification();
create trigger b_expose_template_guard before insert or update or delete on web_expose_templates for each row execute function crm_expose_template_guard();
create trigger a_expose_template_version_classification before insert or update on web_expose_template_versions for each row execute function crm_set_sales_classification();
create trigger b_expose_template_version_guard before insert or update or delete on web_expose_template_versions for each row execute function crm_expose_template_guard();
alter table web_expose_templates enable row level security;alter table web_expose_templates force row level security;
alter table web_expose_template_versions enable row level security;alter table web_expose_template_versions force row level security;
create policy expose_template_read on web_expose_templates for select to novalure_tenant_app using(crm_expose_template_access(workspace_id,false) and crm_classification_allowed(workspace_id,data_classification,data_purpose));
create policy expose_template_insert on web_expose_templates for insert to novalure_tenant_app with check(crm_expose_template_access(workspace_id,true) and crm_classification_allowed(workspace_id,data_classification,data_purpose));
-- Readers may hold SHARE on the mutable head while publishing. WITH CHECK + trigger still require management for an actual update.
create policy expose_template_update on web_expose_templates for update to novalure_tenant_app using(crm_expose_template_access(workspace_id,false) and crm_classification_allowed(workspace_id,data_classification,data_purpose)) with check(crm_expose_template_access(workspace_id,true) and crm_classification_allowed(workspace_id,data_classification,data_purpose));
create policy expose_template_versions_read on web_expose_template_versions for select to novalure_tenant_app using(crm_expose_template_access(workspace_id,false) and crm_classification_allowed(workspace_id,data_classification,data_purpose));
create policy expose_template_versions_insert on web_expose_template_versions for insert to novalure_tenant_app with check(crm_expose_template_access(workspace_id,true) and crm_classification_allowed(workspace_id,data_classification,data_purpose));
revoke all on web_expose_templates,web_expose_template_versions from public,novalure_tenant_app;
grant select,insert,update on web_expose_templates to novalure_tenant_app;grant select,insert on web_expose_template_versions to novalure_tenant_app;
revoke all on function crm_expose_template_guard() from public;
