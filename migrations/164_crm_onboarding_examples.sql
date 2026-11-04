create table crm_onboarding_examples (
 id uuid primary key,workspace_id uuid not null references workspaces(id),country_code text not null check(country_code in('AT','DE','ES','IE')),template_version integer not null default 1 check(template_version=1),
 project_id uuid not null,property_id uuid not null,contact_id uuid not null,lead_id uuid not null,task_id uuid not null,unit_ids jsonb not null check(jsonb_typeof(unit_ids)='array'),created_by uuid not null,created_at timestamptz not null default now(),
 unique(workspace_id,country_code,template_version),unique(workspace_id,project_id),
 foreign key(workspace_id,project_id) references projects(workspace_id,id),foreign key(workspace_id,property_id) references seller_listings(workspace_id,id),foreign key(workspace_id,contact_id) references contacts(workspace_id,id),foreign key(workspace_id,lead_id) references leads(workspace_id,id),foreign key(workspace_id,created_by) references workspace_users(workspace_id,id),foreign key(task_id) references tasks(id)
);
create table crm_onboarding_progress (
 workspace_id uuid not null references workspaces(id),user_id uuid not null,country_code text not null check(country_code in('AT','DE','ES','IE')),reviewed_steps jsonb not null default '[]' check(jsonb_typeof(reviewed_steps)='array'),revision integer not null default 1 check(revision>0),updated_at timestamptz not null default now(),
 last_request_id uuid not null,last_request_hash text not null,primary key(workspace_id,user_id),foreign key(workspace_id,user_id) references workspace_users(workspace_id,id)
);
alter table crm_onboarding_examples enable row level security;alter table crm_onboarding_examples force row level security;
alter table crm_onboarding_progress enable row level security;alter table crm_onboarding_progress force row level security;
create policy onboarding_example_read on crm_onboarding_examples for select to novalure_tenant_app using(crm_project_access(workspace_id,project_id,false));
create policy onboarding_example_write on crm_onboarding_examples for insert to novalure_tenant_app with check(crm_workspace_manager(workspace_id) and created_by=nullif(current_setting('app.actor_id',true),'')::uuid and crm_project_access(workspace_id,project_id,true));
create policy onboarding_progress_personal on crm_onboarding_progress for all to novalure_tenant_app using(workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid and user_id=nullif(current_setting('app.actor_id',true),'')::uuid) with check(workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid and user_id=nullif(current_setting('app.actor_id',true),'')::uuid);
grant select,insert on crm_onboarding_examples to novalure_tenant_app;grant select,insert,update on crm_onboarding_progress to novalure_tenant_app;

create function crm_onboarding_scenario_scope_guard() returns trigger language plpgsql set search_path=pg_catalog,public as $$
begin
 if not exists(select 1 from projects p join seller_listings property on property.workspace_id=p.workspace_id and property.project_id=p.id and property.id=new.property_id
  join contacts c on c.workspace_id=p.workspace_id and c.project_id=p.id and c.id=new.contact_id
  join leads l on l.workspace_id=p.workspace_id and l.project_id=p.id and l.id=new.lead_id and l.contact_id=c.id
  join tasks t on t.workspace_id=p.workspace_id and t.project_id=p.id and t.id=new.task_id and t.lead_id=l.id and t.contact_id=c.id
  where p.workspace_id=new.workspace_id and p.id=new.project_id and p.setup_defaults->'onboardingExample'->>'scenarioId'=new.id::text
   and p.setup_defaults->'onboardingExample'->>'countryCode'=new.country_code and p.setup_defaults->'onboardingExample'->>'synthetic'='true'
   and property.canonical_payload->'onboardingExample'->>'scenarioId'=new.id::text)
  or jsonb_array_length(new.unit_ids)<>2 or(select count(*) from property_units u where u.workspace_id=new.workspace_id and u.project_id=new.project_id and u.id::text in(select jsonb_array_elements_text(new.unit_ids)) and u.metadata->'onboardingExample'->>'scenarioId'=new.id::text)<>2
 then raise exception using errcode='23514',message='Example scenario references must stay in their own marked project'; end if;
 return new;
end $$;
create trigger crm_onboarding_scenario_scope before insert on crm_onboarding_examples for each row execute function crm_onboarding_scenario_scope_guard();
revoke all on function crm_onboarding_scenario_scope_guard() from public;

-- Example projects stay recognisable after ordinary CRM edits. Children created
-- later in the example project inherit the marker; they cannot become live rows
-- by being moved to another project or by dropping their JSON metadata.
create function crm_onboarding_example_guard() returns trigger language plpgsql set search_path=pg_catalog,public as $$
declare field_name text; label_field text; tag jsonb; prior_tag jsonb; doc jsonb; parent_tag jsonb; row_json jsonb:=to_jsonb(new); begin
 field_name:=case when tg_table_name='projects' then 'setup_defaults' when tg_table_name='seller_listings' then 'canonical_payload' else 'metadata' end;
 label_field:=case when tg_table_name in('projects','contacts') then 'name' when tg_table_name in('seller_listings','tasks') then 'title' when tg_table_name='property_units' then 'unit_number' else null end;
 doc:=case when jsonb_typeof(row_json->field_name)='object' then row_json->field_name else '{}'::jsonb end;tag:=doc->'onboardingExample';
 if tg_op='UPDATE' then prior_tag:=to_jsonb(old)->field_name->'onboardingExample'; end if;
 if prior_tag->>'synthetic'='true' then
  tag:=prior_tag;
  if tg_table_name<>'projects' and row_json->>'project_id' is distinct from to_jsonb(old)->>'project_id' then raise exception using errcode='23514',message='Example data must remain in its separate project'; end if;
 end if;
 if tg_table_name<>'projects' and row_json->>'project_id' is not null then
  select setup_defaults->'onboardingExample' into parent_tag from projects where id=(row_json->>'project_id')::uuid and workspace_id=new.workspace_id;
  if parent_tag->>'synthetic'='true' then tag:=parent_tag; end if;
 end if;
 if tag->>'synthetic'='true' then
  doc:=doc||jsonb_build_object('onboardingExample',tag);
  if tg_table_name='leads' then doc:=jsonb_set(doc,'{websiteSales}',case when jsonb_typeof(doc->'websiteSales')='object' then doc->'websiteSales' else '{}'::jsonb end||'{"syntheticTest":true}'::jsonb); end if;
  row_json:=jsonb_build_object(field_name,doc);
  if label_field is not null and coalesce(to_jsonb(new)->>label_field,'')!~*'BEISPIEL|EXAMPLE|EJEMPLO' then row_json:=row_json||jsonb_build_object(label_field,'BEISPIEL / EXAMPLE · '||coalesce(to_jsonb(new)->>label_field,'')); end if;
  new:=jsonb_populate_record(new,row_json);
 end if;
 return new;
end $$;
do $$ declare relation text; begin foreach relation in array array['projects','seller_listings','property_units','contacts','leads','tasks'] loop execute format('create trigger crm_onboarding_example_marker before insert or update on %I for each row execute function crm_onboarding_example_guard()',relation); end loop; end $$;
revoke all on function crm_onboarding_example_guard() from public;
