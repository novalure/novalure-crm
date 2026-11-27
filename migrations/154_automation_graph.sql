-- Versioned automation graphs; actor-scoped runtime. No providers or flows are enabled.
set local lock_timeout='5s';

create table public.crm_automations (
 id uuid primary key default gen_random_uuid(), workspace_id uuid not null references workspaces(id),
 project_id uuid, name text not null check(length(name) between 1 and 200),
 draft jsonb not null check(jsonb_typeof(draft)='object'), revision integer not null default 1 check(revision>0),
 active_version integer, status text not null default 'draft' check(status in('draft','active','paused')),
 created_by uuid not null, schedule_actor_id uuid, schedule_identity_id uuid references auth_identities(id), schedule_version integer,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 data_classification text not null default 'UNCLASSIFIED', data_purpose text not null default 'crm_sales',
 unique(workspace_id,id), foreign key(workspace_id,project_id) references projects(workspace_id,id),
 foreign key(workspace_id,created_by) references workspace_users(workspace_id,id),
 foreign key(workspace_id,schedule_actor_id) references workspace_users(workspace_id,id)
);
create table public.crm_automation_versions (
 workspace_id uuid not null, project_id uuid, automation_id uuid not null, version integer not null check(version>0),
 graph jsonb not null check(jsonb_typeof(graph)='object'), graph_digest text not null check(graph_digest ~ '^[a-f0-9]{64}$'),
 created_by uuid not null, created_at timestamptz not null default now(),
 data_classification text not null default 'UNCLASSIFIED', data_purpose text not null default 'crm_sales',
 primary key(workspace_id,automation_id,version), foreign key(workspace_id,automation_id) references crm_automations(workspace_id,id),
 foreign key(workspace_id,created_by) references workspace_users(workspace_id,id)
);
create table public.crm_automation_events (
 id uuid primary key default gen_random_uuid(), workspace_id uuid not null, project_id uuid, lead_id uuid,
 event_key text not null check(length(event_key) between 1 and 180), trigger_key text not null,
 context jsonb not null default '{}' check(jsonb_typeof(context)='object'), occurred_at timestamptz not null default now(),
 created_at timestamptz not null default now(),
 data_classification text not null default 'UNCLASSIFIED', data_purpose text not null default 'crm_sales',
 unique(workspace_id,id), unique(workspace_id,event_key),
 foreign key(workspace_id,lead_id) references leads(workspace_id,id),
 foreign key(workspace_id,project_id) references projects(workspace_id,id),
 check((trigger_key='tracking_erased')=(lead_id is null))
);
create table public.crm_automation_enrollments (
 id uuid primary key default gen_random_uuid(), workspace_id uuid not null, project_id uuid, automation_id uuid, version integer,
 lead_id uuid, event_id uuid not null, node_id text not null,
 status text not null default 'running' check(status in('running','waiting','waiting_signal','review','completed','stopped','blocked','failed')),
 due_at timestamptz not null default now(), stop_reason text,
 enrolled_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 data_classification text not null default 'UNCLASSIFIED', data_purpose text not null default 'crm_sales',
 unique(workspace_id,id), unique(workspace_id,automation_id,version,lead_id,event_id),
 foreign key(workspace_id,automation_id,version) references crm_automation_versions(workspace_id,automation_id,version),
 foreign key(workspace_id,lead_id) references leads(workspace_id,id),
 foreign key(workspace_id,event_id) references crm_automation_events(workspace_id,id),
 check((lead_id is not null and automation_id is not null and version is not null) or (lead_id is null and automation_id is null and version is null and status='stopped' and stop_reason='tracking_erased'))
);
-- A repeated open/event cannot enroll a lead twice in the same active version.
create unique index crm_automation_one_live_enrollment on crm_automation_enrollments(workspace_id,automation_id,version,lead_id)
 where status in('running','waiting','waiting_signal','review','blocked');
create index crm_automation_due on crm_automation_enrollments(workspace_id,due_at) where status in('running','waiting','waiting_signal');
create table public.crm_automation_admissions (
 workspace_id uuid not null, project_id uuid, automation_id uuid not null, version integer not null, event_id uuid not null,
 created_at timestamptz not null default now(), data_classification text not null default 'UNCLASSIFIED', data_purpose text not null default 'crm_sales',
 primary key(workspace_id,automation_id,version,event_id),
 foreign key(workspace_id,automation_id,version) references crm_automation_versions(workspace_id,automation_id,version),
 foreign key(workspace_id,event_id) references crm_automation_events(workspace_id,id)
);
create table public.crm_automation_steps (
 id uuid primary key default gen_random_uuid(), workspace_id uuid not null, project_id uuid, enrollment_id uuid not null,
 node_id text not null, node_type text not null, status text not null check(status in('completed','waiting','review','blocked','stopped')),
 result jsonb not null default '{}', created_at timestamptz not null default now(),
 data_classification text not null default 'UNCLASSIFIED', data_purpose text not null default 'crm_sales',
 unique(workspace_id,enrollment_id,node_id),
 foreign key(workspace_id,enrollment_id) references crm_automation_enrollments(workspace_id,id)
);
create table public.crm_automation_drafts (
 id uuid primary key default gen_random_uuid(), workspace_id uuid not null, project_id uuid, enrollment_id uuid not null,
 node_id text not null, contact_id uuid, subject text not null, body text not null, request_type text,
 status text not null default 'pending' check(status in('pending','reviewed','dismissed')),
 consent_allowed boolean not null, consent_reason text not null, reviewed_by uuid, reviewed_at timestamptz,
 created_at timestamptz not null default now(),
 data_classification text not null default 'UNCLASSIFIED', data_purpose text not null default 'crm_sales',
 unique(workspace_id,id), unique(workspace_id,enrollment_id,node_id),
 foreign key(workspace_id,enrollment_id) references crm_automation_enrollments(workspace_id,id),
 foreign key(workspace_id,contact_id) references contacts(workspace_id,id),
 foreign key(workspace_id,reviewed_by) references workspace_users(workspace_id,id)
);

create function public.crm_automation_scope_guard() returns trigger language plpgsql set search_path=pg_catalog,public as $$
declare p uuid; l uuid; parent_workspace uuid;
begin
 if tg_op='UPDATE' and tg_table_name='crm_automation_events' then
  if old.trigger_key='expose_opened' and new.trigger_key='tracking_erased' and new.lead_id is null and crm_automation_erasure_owner() then return new; end if;
 end if;
 if tg_op='UPDATE' and tg_table_name='crm_automation_enrollments' then
  if new.lead_id is null and new.automation_id is null and new.version is null and new.status='stopped' and new.stop_reason='tracking_erased' and crm_automation_erasure_owner()
   and (to_jsonb(new)-array['lead_id','automation_id','version','node_id','status','due_at','stop_reason','enrolled_at','updated_at'])=(to_jsonb(old)-array['lead_id','automation_id','version','node_id','status','due_at','stop_reason','enrolled_at','updated_at'])
   and exists(select 1 from crm_automation_events e where e.workspace_id=old.workspace_id and e.id=old.event_id and e.trigger_key='expose_opened') then return new; end if;
 end if;
 if tg_op='UPDATE' and (new.workspace_id is distinct from old.workspace_id or new.project_id is distinct from old.project_id) then raise exception using errcode='23514',message='Automation scope is immutable'; end if;
 if tg_table_name in('crm_automation_versions','crm_automation_enrollments','crm_automation_admissions') then
   select a.project_id,a.workspace_id into p,parent_workspace from public.crm_automations a where a.id=new.automation_id and a.workspace_id=new.workspace_id;
   if parent_workspace is null or (tg_table_name='crm_automation_versions' and p is distinct from new.project_id) or (p is not null and p is distinct from new.project_id) then raise exception using errcode='23514',message='Automation project mismatch'; end if;
 end if;
 if tg_table_name in('crm_automation_steps','crm_automation_drafts') then
   select e.project_id,e.workspace_id into p,parent_workspace from public.crm_automation_enrollments e where e.id=new.enrollment_id and e.workspace_id=new.workspace_id;
   if parent_workspace is null or p is distinct from new.project_id then raise exception using errcode='23514',message='Enrollment project mismatch'; end if;
 end if;
 if tg_table_name in('crm_automation_events','crm_automation_enrollments') then
   select lead.project_id,lead.workspace_id into l,parent_workspace from public.leads lead where lead.id=new.lead_id and lead.workspace_id=new.workspace_id;
   if parent_workspace is null or l is distinct from new.project_id then raise exception using errcode='23514',message='Automation lead mismatch'; end if;
 end if;
 return new;
end $$;
do $$ declare relation text; begin
 foreach relation in array array['crm_automations','crm_automation_versions','crm_automation_events','crm_automation_enrollments','crm_automation_admissions','crm_automation_steps','crm_automation_drafts'] loop
   execute format('create trigger crm_sales_classification_guard before insert or update on %I for each row execute function crm_set_sales_classification()',relation);
   execute format('create trigger automation_scope_guard before insert or update on %I for each row execute function crm_automation_scope_guard()',relation);
   execute format('alter table %I enable row level security',relation);
   execute format('alter table %I force row level security',relation);
   execute format('create policy automation_scope on %I to novalure_tenant_app using(workspace_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid and crm_classification_allowed(workspace_id,data_classification,data_purpose) and (case when project_id is null then crm_workspace_manager(workspace_id) else crm_project_access(workspace_id,project_id,false) end)) with check(workspace_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid and crm_classification_allowed(workspace_id,data_classification,data_purpose) and (case when project_id is null then crm_workspace_manager(workspace_id) else crm_project_access(workspace_id,project_id,true) end))',relation);
   execute format('revoke all on %I from public,novalure_app',relation);
   execute format('grant select,insert on %I to novalure_tenant_app',relation);
 end loop;
end $$;
grant update on crm_automations,crm_automation_enrollments,crm_automation_drafts to novalure_tenant_app;
create trigger automation_versions_immutable before update or delete or truncate on crm_automation_versions for each statement execute function crm_reject_immutable_mutation();
-- These two ledgers receive narrowly checked tracking tombstones below. DELETE/TRUNCATE stay forbidden.
create trigger automation_events_no_delete before delete or truncate on crm_automation_events for each statement execute function crm_reject_immutable_mutation();
create trigger automation_steps_no_delete before delete or truncate on crm_automation_steps for each statement execute function crm_reject_immutable_mutation();
revoke all on function public.crm_automation_scope_guard() from public;

/** No GUC or caller-shaped token grants erasure. Only the narrowly authorized definer owns this role. */
create function crm_automation_erasure_owner() returns boolean language sql stable security invoker set search_path=pg_catalog,public as $$
 select current_user=pg_get_userbyid(p.proowner) from pg_proc p where p.oid=to_regprocedure('public.crm_automation_erase_exposure(uuid,uuid)')
$$;
revoke all on function crm_automation_erasure_owner() from public;
grant execute on function crm_automation_erasure_owner() to novalure_tenant_app;
create function crm_automation_tracking_immutable_guard() returns trigger language plpgsql set search_path=pg_catalog,public as $$
begin
 if not coalesce(crm_automation_erasure_owner(),false) or not crm_workspace_manager(old.workspace_id) then raise exception using errcode='55000',message='Automation ledger is immutable'; end if;
 if tg_table_name='crm_automation_events' then
  if old.trigger_key='expose_opened' and new.trigger_key='tracking_erased' and new.lead_id is null and new.context='{}'::jsonb and new.occurred_at=date_trunc('day',old.created_at) and new.created_at=date_trunc('day',old.created_at)
   and (to_jsonb(new)-array['lead_id','trigger_key','context','occurred_at','created_at'])=(to_jsonb(old)-array['lead_id','trigger_key','context','occurred_at','created_at']) then return new; end if;
 else
  if new.node_type='erased' and new.status='stopped' and new.result='{}'::jsonb and new.created_at=date_trunc('day',old.created_at)
   and (to_jsonb(new)-array['node_type','status','result','created_at'])=(to_jsonb(old)-array['node_type','status','result','created_at'])
   and exists(select 1 from crm_automation_enrollments e join crm_automation_events ev on ev.id=e.event_id and ev.workspace_id=e.workspace_id where e.workspace_id=old.workspace_id and e.id=old.enrollment_id and ev.trigger_key='expose_opened') then return new; end if;
 end if;
 raise exception using errcode='55000',message='Only exact tracking erasure is allowed';
end $$;
create trigger automation_events_immutable before update on crm_automation_events for each row execute function crm_automation_tracking_immutable_guard();
create trigger automation_steps_immutable before update on crm_automation_steps for each row execute function crm_automation_tracking_immutable_guard();

create function crm_automation_redact_task_audit(v jsonb) returns jsonb language sql immutable set search_path=pg_catalog,public as $$
 select case when jsonb_typeof(v)='object' and v ? 'title' then jsonb_set(v,'{title}','"Nachfassaufgabe"'::jsonb) else v end
$$;
create function crm_automation_task_audit_immutable_guard() returns trigger language plpgsql set search_path=pg_catalog,public as $$
begin
 if crm_automation_erasure_owner() and crm_workspace_manager(old.workspace_id) and old.entity_type='task'
  and (to_jsonb(new)-array['before','after'])=(to_jsonb(old)-array['before','after'])
  and new.before is not distinct from crm_automation_redact_task_audit(old.before)
  and new.after is not distinct from crm_automation_redact_task_audit(old.after)
  and exists(select 1 from tasks t where t.id=old.entity_id and t.workspace_id=old.workspace_id and t.metadata->>'automationTrackingErased'='true') then return new; end if;
 raise exception using errcode='55000',message='audit_logs is append-only';
end $$;
drop trigger audit_logs_append_only_guard on audit_logs;
create trigger audit_logs_append_only_guard before delete or truncate on audit_logs for each statement execute function reject_audit_logs_mutation();
create trigger audit_logs_tracking_redaction_guard before update on audit_logs for each row execute function crm_automation_task_audit_immutable_guard();

create function public.crm_automation_erase_exposure(p_workspace uuid,p_session uuid) returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare event_ids uuid[];run_ids uuid[];task_ids uuid[];event_value uuid;events_count integer;begin
 if p_workspace is distinct from nullif(current_setting('app.tenant_id',true),'')::uuid or not crm_workspace_manager(p_workspace) then raise exception using errcode='42501',message='Tracking erasure requires a workspace manager'; end if;
 perform pg_advisory_xact_lock(hashtextextended('web-expose-automation-workspace:'||p_workspace::text,0));
 perform pg_advisory_xact_lock(hashtextextended('web-expose-analytics-session:'||p_session::text,0));
 select coalesce(array_agg(id order by id),'{}'::uuid[]) into event_ids from crm_automation_events where workspace_id=p_workspace and trigger_key='expose_opened' and context->>'exposeSessionId'=p_session::text;
 foreach event_value in array event_ids loop perform pg_advisory_xact_lock(hashtextextended('automation-event:'||p_workspace::text||':'||event_value::text,0)); end loop;
 perform id from crm_automation_enrollments where workspace_id=p_workspace and event_id=any(event_ids) order by id for update;
 select coalesce(array_agg(id),'{}'::uuid[]) into run_ids from crm_automation_enrollments where workspace_id=p_workspace and event_id=any(event_ids);
 select coalesce(array_agg(id),'{}'::uuid[]) into task_ids from tasks where workspace_id=p_workspace and metadata->>'enrollmentId'=any(array(select x::text from unnest(run_ids) x));
 update tasks set title='Nachfassaufgabe',metadata=(metadata-array['automationId','enrollmentId','nodeId'])||'{"automationTrackingErased":true}'::jsonb,updated_at=clock_timestamp() where workspace_id=p_workspace and id=any(task_ids);
 update audit_logs set before=crm_automation_redact_task_audit(before),after=crm_automation_redact_task_audit(after) where workspace_id=p_workspace and entity_type='task' and entity_id=any(task_ids);
 update crm_automation_steps set node_type='erased',status='stopped',result='{}',created_at=date_trunc('day',created_at) where workspace_id=p_workspace and enrollment_id=any(run_ids);
 update crm_automation_drafts set contact_id=null,subject='Gelöschter Automationsentwurf',body='',status='dismissed' where workspace_id=p_workspace and enrollment_id=any(run_ids);
 update crm_automation_enrollments set lead_id=null,automation_id=null,version=null,node_id='erased',status='stopped',stop_reason='tracking_erased',due_at=date_trunc('day',enrolled_at),enrolled_at=date_trunc('day',enrolled_at),updated_at=date_trunc('day',enrolled_at) where workspace_id=p_workspace and id=any(run_ids);
 delete from crm_automation_admissions where workspace_id=p_workspace and event_id=any(event_ids);
 update crm_automation_events set lead_id=null,trigger_key='tracking_erased',context='{}',occurred_at=date_trunc('day',created_at),created_at=date_trunc('day',created_at) where workspace_id=p_workspace and id=any(event_ids);get diagnostics events_count=row_count;
 if events_count>0 then insert into audit_logs(workspace_id,actor_user_id,action,entity_type,after) values(p_workspace,nullif(current_setting('app.actor_id',true),'')::uuid,'automation.tracking_erased','privacy_maintenance',jsonb_build_object('events',events_count,'runs',cardinality(run_ids),'operationalTasks',cardinality(task_ids),'purpose','tracking_erasure')); end if;
 return jsonb_build_object('events',events_count,'runs',cardinality(run_ids),'operationalTasks',cardinality(task_ids));
end $$;
revoke all on function crm_automation_erase_exposure(uuid,uuid),crm_automation_tracking_immutable_guard(),crm_automation_task_audit_immutable_guard(),crm_automation_redact_task_audit(jsonb) from public;
grant execute on function crm_automation_erase_exposure(uuid,uuid) to novalure_tenant_app;
do $$ declare t text; begin
 foreach t in array array['crm_automation_events','crm_automation_enrollments','crm_automation_steps','crm_automation_drafts','crm_automation_admissions','tasks','audit_logs'] loop
  execute format('create policy automation_erasure_owner on %I to %I using(workspace_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid and crm_workspace_manager(workspace_id)) with check(workspace_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid and crm_workspace_manager(workspace_id))',t,current_user);
 end loop;
end $$;
