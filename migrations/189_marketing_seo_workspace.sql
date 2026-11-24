-- Scoped SEO evidence and work tracking. No crawler, credentials or provider activation.
set local lock_timeout='5s';
create table crm_seo_sites (
 id uuid primary key default gen_random_uuid(),workspace_id uuid not null,project_id uuid not null,
 site_url text not null check(length(site_url)<=261 and site_url ~ '^https://[a-z0-9]([a-z0-9.-]*[a-z0-9])?$'),
 created_by uuid not null,created_at timestamptz not null default now(),audit_reference uuid not null,
 data_classification text not null default 'UNCLASSIFIED',data_purpose text not null default 'crm_sales',
 unique(workspace_id,project_id,id),unique(workspace_id,project_id,site_url),
 foreign key(workspace_id,project_id) references projects(workspace_id,id),foreign key(workspace_id,created_by) references workspace_users(workspace_id,id)
);
create table crm_seo_reports (
 id uuid primary key default gen_random_uuid(),workspace_id uuid not null,project_id uuid not null,site_id uuid not null,
 external_report_id text not null check(length(external_report_id) between 1 and 128),report jsonb not null check(jsonb_typeof(report)='object' and octet_length(report::text)<=2000000),
 report_hash text not null check(report_hash ~ '^[a-f0-9]{64}$'),generated_at timestamptz not null,
 imported_by uuid not null,imported_at timestamptz not null default now(),audit_reference uuid not null,
 data_classification text not null default 'UNCLASSIFIED',data_purpose text not null default 'crm_sales',
 unique(workspace_id,project_id,id),unique(workspace_id,site_id,external_report_id),
 foreign key(workspace_id,project_id,site_id) references crm_seo_sites(workspace_id,project_id,id),foreign key(workspace_id,imported_by) references workspace_users(workspace_id,id)
);
create index crm_seo_reports_recent on crm_seo_reports(workspace_id,project_id,generated_at desc);
create table crm_seo_actions (
 workspace_id uuid not null,project_id uuid not null,report_id uuid not null,action_id text not null check(length(action_id) between 1 and 128),
 status text not null default 'planned' check(status in('planned','in_progress','verified','dismissed')),
 note text not null default '' check(length(note)<=2000),revision integer not null default 1 check(revision>0),
 updated_by uuid not null,updated_at timestamptz not null default now(),audit_reference uuid not null,
 data_classification text not null default 'UNCLASSIFIED',data_purpose text not null default 'crm_sales',
 primary key(workspace_id,report_id,action_id),
 foreign key(workspace_id,project_id,report_id) references crm_seo_reports(workspace_id,project_id,id),foreign key(workspace_id,updated_by) references workspace_users(workspace_id,id),
 check(status not in('verified','dismissed') or length(trim(note))>=10)
);
create table crm_seo_action_events (
 workspace_id uuid not null,project_id uuid not null,report_id uuid not null,action_id text not null,
 revision integer not null,status text not null,note text not null,actor_id uuid not null,audit_reference uuid not null,created_at timestamptz not null default now(),
 data_classification text not null default 'UNCLASSIFIED',data_purpose text not null default 'crm_sales',
 primary key(workspace_id,report_id,action_id,revision),foreign key(workspace_id,report_id,action_id) references crm_seo_actions(workspace_id,report_id,action_id),
 foreign key(workspace_id,actor_id) references workspace_users(workspace_id,id),
 foreign key(audit_reference) references audit_logs(id) deferrable initially deferred
);
-- One action update is one command. Import commands may initialize multiple actions.
create unique index crm_seo_update_audit_once on crm_seo_action_events(workspace_id,audit_reference) where revision>1;
create function crm_seo_evidence_guard() returns trigger language plpgsql set search_path=pg_catalog,public as $$
declare origin text;body jsonb;begin
 if tg_table_name='crm_seo_sites' then
  if new.created_by is distinct from nullif(current_setting('app.actor_id',true),'')::uuid then raise exception using errcode='23514',message='SEO actor required';end if;
 elsif tg_table_name='crm_seo_reports' then
  select site_url into origin from crm_seo_sites where workspace_id=new.workspace_id and project_id=new.project_id and id=new.site_id;
  if new.imported_by is distinct from nullif(current_setting('app.actor_id',true),'')::uuid
    or new.report->>'version' is distinct from 'novalure.seo.v1' or new.report->>'tenantId' is distinct from new.workspace_id::text
    or new.report->>'projectId' is distinct from new.project_id::text or new.report->>'siteUrl' is distinct from origin
    or new.report->>'reportId' is distinct from new.external_report_id or (new.report->>'generatedAt')::timestamptz is distinct from new.generated_at then raise exception using errcode='23514',message='SEO report scope mismatch';end if;
  if jsonb_typeof(new.report->'pages') is distinct from 'array' or jsonb_typeof(new.report->'findings') is distinct from 'array'
   or jsonb_typeof(new.report->'actions') is distinct from 'array' or jsonb_typeof(new.report->'coverage') is distinct from 'object'
   or jsonb_typeof(new.report->'coverage'->'complete') is distinct from 'boolean' or jsonb_typeof(new.report->'searchData') is distinct from 'object'
   or jsonb_typeof(new.report->'searchData'->'rows') is distinct from 'array' then raise exception using errcode='23514',message='SEO report structure required';end if;
  if jsonb_array_length(new.report->'pages')>500 or jsonb_array_length(new.report->'findings')>2000 or jsonb_array_length(new.report->'actions')>2000 or jsonb_array_length(new.report->'searchData'->'rows')>5000
   or exists(select 1 from jsonb_array_elements(new.report->'actions') a where jsonb_typeof(a) is distinct from 'object' or a->>'status' is distinct from 'planned' or nullif(a->>'id','') is null)
   then raise exception using errcode='23514',message='SEO imported actions must start planned and report must be bounded';end if;
 elsif tg_table_name='crm_seo_actions' then
  if new.updated_by is distinct from nullif(current_setting('app.actor_id',true),'')::uuid then raise exception using errcode='23514',message='SEO actor required';end if;
  if tg_op='UPDATE' and (new.workspace_id is distinct from old.workspace_id or new.project_id is distinct from old.project_id or new.report_id is distinct from old.report_id or new.action_id is distinct from old.action_id or new.revision<>old.revision+1 or new.audit_reference=old.audit_reference) then raise exception using errcode='23514',message='SEO action scope/revision/audit mismatch';end if;
  if tg_op='INSERT' then
   select report into body from crm_seo_reports where workspace_id=new.workspace_id and project_id=new.project_id and id=new.report_id;
   if new.revision<>1 or new.status<>'planned' or not exists(select 1 from jsonb_array_elements(body->'actions') a where a->>'id'=new.action_id and a->>'status'='planned') then raise exception using errcode='23514',message='SEO action source mismatch';end if;
  end if;
  new.updated_at=clock_timestamp();
 elsif tg_table_name='crm_seo_action_events' then
  if new.actor_id is distinct from nullif(current_setting('app.actor_id',true),'')::uuid or not exists(
   select 1 from crm_seo_actions a where a.workspace_id=new.workspace_id and a.project_id=new.project_id and a.report_id=new.report_id and a.action_id=new.action_id
    and a.revision=new.revision and a.status=new.status and a.note=new.note and a.updated_by=new.actor_id and a.audit_reference=new.audit_reference
  ) then raise exception using errcode='23514',message='SEO action event must match current source state and actor';end if;
 end if;return new;end $$;
create function crm_seo_action_event() returns trigger language plpgsql set search_path=pg_catalog,public as $$
begin
 insert into crm_seo_action_events(workspace_id,project_id,report_id,action_id,revision,status,note,actor_id,audit_reference)
 values(new.workspace_id,new.project_id,new.report_id,new.action_id,new.revision,new.status,new.note,new.updated_by,new.audit_reference);
 return new;end $$;
-- executeCrmCommand inserts its audit/receipt after the domain callback. Validate
-- that exact command at commit, rather than trusting a globally existing audit ID.
create function crm_seo_record_audit_guard() returns trigger language plpgsql set search_path=pg_catalog,public as $$
declare expected_actor uuid;expected_entity uuid;expected_operation text;begin
 if tg_table_name='crm_seo_sites' then expected_actor=new.created_by;expected_entity=new.id;expected_operation='crm.marketing.seo.registerSite';
 elsif tg_table_name='crm_seo_reports' then expected_actor=new.imported_by;expected_entity=new.id;expected_operation='crm.marketing.seo.importReport';
 else expected_actor=new.actor_id;expected_entity=new.report_id;expected_operation=case when new.revision=1 then 'crm.marketing.seo.importReport' else 'crm.marketing.seo.updateAction' end;end if;
 if not exists(
  select 1 from audit_logs a join crm_command_receipts r on r.audit_reference=a.id
   and r.id::text=a.after->>'commandId' and r.request_hash=a.after->>'requestHash'
   and r.correlation_id::text=a.after->>'correlationId'
  where a.id=new.audit_reference and a.workspace_id=new.workspace_id and a.project_id=new.project_id
   and a.actor_user_id=expected_actor and a.entity_type='crm_command' and a.entity_id=expected_entity and a.action=expected_operation
   and r.workspace_id=new.workspace_id and r.project_id=new.project_id and r.actor_user_id=expected_actor
   and r.operation=a.action and r.resource_id=expected_entity
 ) then raise exception using errcode='23514',message='SEO action audit must match exact workspace, project, actor, report and command';end if;
 return null;end $$;
create function crm_seo_report_actions_guard() returns trigger language plpgsql set search_path=pg_catalog,public as $$
begin
 if (select count(*) from crm_seo_actions where workspace_id=new.workspace_id and project_id=new.project_id and report_id=new.id)<>jsonb_array_length(new.report->'actions')
  or exists(select 1 from jsonb_array_elements(new.report->'actions') a where not exists(select 1 from crm_seo_actions s where s.workspace_id=new.workspace_id and s.project_id=new.project_id and s.report_id=new.id and s.action_id=a->>'id'))
  then raise exception using errcode='23514',message='SEO report requires complete original action states';end if;
 return null;end $$;
do $$ declare relation text;begin
 foreach relation in array array['crm_seo_sites','crm_seo_reports','crm_seo_actions','crm_seo_action_events'] loop
  execute format('alter table %I enable row level security',relation);execute format('alter table %I force row level security',relation);
  execute format('create trigger seo_classification before insert or update on %I for each row execute function crm_set_sales_classification()',relation);
  execute format('create policy seo_read on %I for select to novalure_tenant_app using(crm_classification_allowed(workspace_id,data_classification,data_purpose) and crm_project_access(workspace_id,project_id,false))',relation);
  execute format('create policy seo_write on %I for insert to novalure_tenant_app with check(crm_classification_allowed(workspace_id,data_classification,data_purpose) and crm_project_access(workspace_id,project_id,true))',relation);
  execute format('revoke all on %I from public',relation);execute format('grant select,insert on %I to novalure_tenant_app',relation);
  if relation<>'crm_seo_actions' then execute format('create trigger seo_immutable before update or delete or truncate on %I for each statement execute function crm_reject_immutable_mutation()',relation);end if;
  execute format('create trigger seo_guard before insert or update on %I for each row execute function crm_seo_evidence_guard()',relation);
 end loop;end $$;
grant update(status,note,revision,updated_by,updated_at,audit_reference) on crm_seo_actions to novalure_tenant_app;
create policy seo_action_update on crm_seo_actions for update to novalure_tenant_app
 using(crm_classification_allowed(workspace_id,data_classification,data_purpose) and crm_project_access(workspace_id,project_id,true))
 with check(crm_classification_allowed(workspace_id,data_classification,data_purpose) and crm_project_access(workspace_id,project_id,true));
create trigger seo_action_history after insert or update on crm_seo_actions for each row execute function crm_seo_action_event();
create constraint trigger seo_action_audit_binding after insert on crm_seo_action_events
 deferrable initially deferred for each row execute function crm_seo_record_audit_guard();
create constraint trigger seo_site_audit_binding after insert on crm_seo_sites
 deferrable initially deferred for each row execute function crm_seo_record_audit_guard();
create constraint trigger seo_report_audit_binding after insert on crm_seo_reports
 deferrable initially deferred for each row execute function crm_seo_record_audit_guard();
create constraint trigger seo_report_actions_binding after insert on crm_seo_reports
 deferrable initially deferred for each row execute function crm_seo_report_actions_guard();
