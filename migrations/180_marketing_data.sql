-- Canonical contact attributes, tags, newsletter audiences, reusable content and
-- cross-channel initiatives. No copied contacts and no consent state here.
set local lock_timeout='5s';
alter table contacts add column country_code text check(country_code in('AT','DE','ES','IE')),
 add column preferred_language text check(preferred_language in('de','en','es')),
 add column contact_timezone text,
 add column marketing_profile_revision integer not null default 1 check(marketing_profile_revision>0);
alter table newsletter_segments add column selection_rules jsonb not null default '{"version":1,"countries":[],"languages":[],"tagIds":[],"tagMatch":"all"}' check(jsonb_typeof(selection_rules)='object'),
 add column selection_revision integer not null default 1 check(selection_revision>0);
create table crm_marketing_tags (
 id uuid primary key default gen_random_uuid(),workspace_id uuid not null,project_id uuid not null,
 name text not null check(length(name) between 1 and 80),revision integer not null default 1 check(revision>0),
 updated_by uuid not null,updated_at timestamptz not null default now(),
 data_classification text not null default 'UNCLASSIFIED',data_purpose text not null default 'crm_sales',
 unique(workspace_id,project_id,id),foreign key(workspace_id,project_id) references projects(workspace_id,id),
 foreign key(workspace_id,updated_by) references workspace_users(workspace_id,id)
);
create unique index crm_marketing_tag_name on crm_marketing_tags(workspace_id,project_id,lower(name));
create table crm_marketing_tag_assignments (
 id uuid primary key default gen_random_uuid(),workspace_id uuid not null,project_id uuid not null,tag_id uuid not null,
 contact_id uuid,lead_id uuid,active boolean not null default true,revision integer not null default 1 check(revision>0),
 source text not null check(length(source) between 1 and 300),updated_by uuid not null,updated_at timestamptz not null default now(),
 data_classification text not null default 'UNCLASSIFIED',data_purpose text not null default 'crm_sales',
 check(num_nonnulls(contact_id,lead_id)=1),
 foreign key(workspace_id,project_id,tag_id) references crm_marketing_tags(workspace_id,project_id,id),
 foreign key(workspace_id,contact_id) references contacts(workspace_id,id),foreign key(workspace_id,lead_id) references leads(workspace_id,id),
 foreign key(workspace_id,updated_by) references workspace_users(workspace_id,id)
);
create unique index crm_marketing_contact_tag on crm_marketing_tag_assignments(workspace_id,tag_id,contact_id) where contact_id is not null;
create unique index crm_marketing_lead_tag on crm_marketing_tag_assignments(workspace_id,tag_id,lead_id) where lead_id is not null;
create table crm_marketing_templates (
 id uuid primary key default gen_random_uuid(),workspace_id uuid not null,project_id uuid not null,
 name text not null check(length(name) between 1 and 180),revision integer not null default 1 check(revision>0),
 variants jsonb not null check(jsonb_typeof(variants)='object'),updated_by uuid not null,updated_at timestamptz not null default now(),
 data_classification text not null default 'UNCLASSIFIED',data_purpose text not null default 'crm_sales',
 unique(workspace_id,id),foreign key(workspace_id,project_id) references projects(workspace_id,id),foreign key(workspace_id,updated_by) references workspace_users(workspace_id,id)
);
create table crm_marketing_template_versions (
 workspace_id uuid not null,project_id uuid not null,template_id uuid not null,revision integer not null,
 name text not null,variants jsonb not null,created_by uuid not null,created_at timestamptz not null default now(),
 data_classification text not null default 'UNCLASSIFIED',data_purpose text not null default 'crm_sales',
 primary key(workspace_id,template_id,revision),foreign key(workspace_id,template_id) references crm_marketing_templates(workspace_id,id),
 foreign key(workspace_id,project_id) references projects(workspace_id,id),foreign key(workspace_id,created_by) references workspace_users(workspace_id,id)
);
alter table crm_newsletter_drafts add column source_template_id uuid,add column source_template_revision integer,add column source_template_language text check(source_template_language in('de','en','es')),
 add constraint newsletter_source_template foreign key(workspace_id,source_template_id,source_template_revision) references crm_marketing_template_versions(workspace_id,template_id,revision),
 add constraint newsletter_source_template_complete check(num_nonnulls(source_template_id,source_template_revision,source_template_language) in(0,3));
create table crm_marketing_initiatives (
 id uuid primary key default gen_random_uuid(),workspace_id uuid not null,project_id uuid not null,
 name text not null check(length(name) between 1 and 180),goal text not null default '' check(length(goal)<=2000),
 revision integer not null default 1 check(revision>0),updated_by uuid not null,updated_at timestamptz not null default now(),
 data_classification text not null default 'UNCLASSIFIED',data_purpose text not null default 'crm_sales',
 unique(workspace_id,project_id,id),foreign key(workspace_id,project_id) references projects(workspace_id,id),foreign key(workspace_id,updated_by) references workspace_users(workspace_id,id)
);
create table crm_marketing_source_links (
 id uuid primary key default gen_random_uuid(),workspace_id uuid not null,project_id uuid not null,initiative_id uuid not null,
 kind text not null check(kind in('newsletter','automation','funnel','expose','form')),source_id uuid not null,
 active boolean not null default true,revision integer not null default 1 check(revision>0),updated_by uuid not null,updated_at timestamptz not null default now(),
 data_classification text not null default 'UNCLASSIFIED',data_purpose text not null default 'crm_sales',
 unique(workspace_id,initiative_id,kind,source_id),
 foreign key(workspace_id,project_id,initiative_id) references crm_marketing_initiatives(workspace_id,project_id,id),
 foreign key(workspace_id,updated_by) references workspace_users(workspace_id,id)
);
create function crm_marketing_scope_guard() returns trigger language plpgsql set search_path=pg_catalog,public as $$
declare p uuid;w uuid;begin
 if tg_op='UPDATE' and (new.workspace_id is distinct from old.workspace_id or new.project_id is distinct from old.project_id) then raise exception using errcode='23514',message='Marketing scope is immutable';end if;
 if tg_table_name='crm_marketing_tag_assignments' then
  if tg_op='UPDATE' and (new.tag_id is distinct from old.tag_id or new.contact_id is distinct from old.contact_id or new.lead_id is distinct from old.lead_id) then raise exception using errcode='23514',message='Tag subject is immutable';end if;
  if new.contact_id is not null then select project_id,workspace_id into p,w from contacts where id=new.contact_id;
  else select project_id,workspace_id into p,w from leads where id=new.lead_id;end if;
  if p is distinct from new.project_id or w is distinct from new.workspace_id then raise exception using errcode='23514',message='Tag subject scope mismatch';end if;
 end if;
 if tg_table_name='crm_marketing_template_versions' then
  select project_id,workspace_id into p,w from crm_marketing_templates where id=new.template_id and revision=new.revision and variants=new.variants and name=new.name;
  if p is distinct from new.project_id or w is distinct from new.workspace_id then raise exception using errcode='23514',message='Template version scope mismatch';end if;
 end if;
 if tg_table_name='crm_marketing_source_links' then
  if tg_op='UPDATE' and (new.initiative_id is distinct from old.initiative_id or new.kind is distinct from old.kind or new.source_id is distinct from old.source_id) then raise exception using errcode='23514',message='Marketing source is immutable';end if;
  case new.kind
   when 'newsletter' then select project_id,workspace_id into p,w from newsletter_campaigns where id=new.source_id;
   when 'automation' then select project_id,workspace_id into p,w from crm_automations where id=new.source_id;
   when 'funnel' then select project_id,workspace_id into p,w from funnels where id=new.source_id;
   when 'expose' then select project_id,workspace_id into p,w from web_expose_versions where id=new.source_id;
   when 'form' then select project_id,workspace_id into p,w from forms where id=new.source_id;
  end case;
  if p is distinct from new.project_id or w is distinct from new.workspace_id then raise exception using errcode='23514',message='Marketing source scope mismatch';end if;
 end if;return new;end $$;
do $$ declare relation text;begin
 foreach relation in array array['crm_marketing_tags','crm_marketing_tag_assignments','crm_marketing_templates','crm_marketing_template_versions','crm_marketing_initiatives','crm_marketing_source_links'] loop
  execute format('alter table %I enable row level security',relation);execute format('alter table %I force row level security',relation);
  execute format('create trigger marketing_classification before insert or update on %I for each row execute function crm_set_sales_classification()',relation);
  execute format('create trigger marketing_scope before insert or update on %I for each row execute function crm_marketing_scope_guard()',relation);
  execute format('create policy marketing_read on %I for select to novalure_tenant_app using(crm_classification_allowed(workspace_id,data_classification,data_purpose) and crm_project_access(workspace_id,project_id,false))',relation);
  execute format('create policy marketing_write on %I for all to novalure_tenant_app using(crm_classification_allowed(workspace_id,data_classification,data_purpose) and crm_project_access(workspace_id,project_id,true)) with check(crm_classification_allowed(workspace_id,data_classification,data_purpose) and crm_project_access(workspace_id,project_id,true))',relation);
  execute format('revoke all on %I from public',relation);execute format('grant select,insert,update on %I to novalure_tenant_app',relation);
 end loop;end $$;
revoke update on crm_marketing_template_versions from novalure_tenant_app;
create trigger marketing_template_version_immutable before update or delete or truncate on crm_marketing_template_versions for each statement execute function crm_reject_immutable_mutation();
create function crm_marketing_revision_guard() returns trigger language plpgsql set search_path=pg_catalog,public as $$
begin
 if new.updated_by is distinct from nullif(current_setting('app.actor_id',true),'')::uuid then raise exception using errcode='23514',message='Marketing actor required';end if;
 if (tg_op='INSERT' and new.revision<>1) or (tg_op='UPDATE' and new.revision<>old.revision+1) then raise exception using errcode='23514',message='Marketing comparison revision must increment';end if;
 return new;
end $$;
do $$ declare relation text;begin
 foreach relation in array array['crm_marketing_tags','crm_marketing_tag_assignments','crm_marketing_templates','crm_marketing_initiatives','crm_marketing_source_links'] loop
  execute format('create trigger marketing_revision before insert or update on %I for each row execute function crm_marketing_revision_guard()',relation);
 end loop;end $$;
create function crm_marketing_subject_allowed(w uuid,p uuid,c uuid,l uuid) returns boolean language sql stable security definer set search_path=pg_catalog,public as $$
 select crm_project_access(w,p,false) and ((c is not null and l is null and crm_operational_contact_allowed(w,c,p)) or
  (c is null and l is not null and exists(select 1 from leads x where x.workspace_id=w and x.project_id=p and x.id=l
   and (crm_workspace_manager(w) or x.assigned_to_user_id=nullif(current_setting('app.actor_id',true),'')::uuid)
   and crm_classification_allowed(x.workspace_id,x.data_classification,x.data_purpose)
   and (x.contact_id is null or crm_operational_contact_allowed(w,x.contact_id,p)))))
$$;
revoke all on function crm_marketing_subject_allowed(uuid,uuid,uuid,uuid) from public;
grant execute on function crm_marketing_subject_allowed(uuid,uuid,uuid,uuid) to novalure_tenant_app;
create policy marketing_subject_scope on crm_marketing_tag_assignments as restrictive for all to novalure_tenant_app
 using(crm_marketing_subject_allowed(workspace_id,project_id,contact_id,lead_id))
 with check(crm_marketing_subject_allowed(workspace_id,project_id,contact_id,lead_id));
create function crm_marketing_contact_profile_guard() returns trigger language plpgsql set search_path=pg_catalog,public as $$
begin
 if new.contact_timezone is not null and not exists(select 1 from pg_timezone_names where name=new.contact_timezone) then raise exception using errcode='23514',message='Valid contact timezone required';end if;
 if tg_op='UPDATE' and (new.country_code is distinct from old.country_code or new.preferred_language is distinct from old.preferred_language or new.contact_timezone is distinct from old.contact_timezone) and new.marketing_profile_revision<>old.marketing_profile_revision+1 then raise exception using errcode='23514',message='Contact profile comparison revision must increment';end if;
 return new;end $$;
create trigger marketing_contact_profile before insert or update on contacts for each row execute function crm_marketing_contact_profile_guard();
