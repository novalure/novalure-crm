-- Opt-in, tenant scoped monitoring. No cron, provider, contract or periodic
-- interval is enabled here. Configured actors are revalidated on every run.
set local lock_timeout = '5s';
set local statement_timeout = '14min';

alter table knowledge_center_entitlements add column monitoring_intervals text[] not null default array['manual']::text[]
 check(cardinality(monitoring_intervals) between 1 and 4 and monitoring_intervals <@ array['manual','daily','weekly','monthly']::text[]);

create table knowledge_website_monitoring (
 source_id uuid primary key, workspace_id uuid not null,
 configured_by uuid not null, project_id uuid,
 interval text not null default 'manual' check(interval in ('manual','daily','weekly','monthly')),
 enabled boolean not null default false, revision integer not null default 1 check(revision>0),
 next_due_at timestamptz, last_success_at timestamptz, last_scan_at timestamptz,
 last_error_code text check(length(last_error_code)<=80), last_run_status text,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 unique(workspace_id,source_id),
 foreign key(source_id,workspace_id) references knowledge_sources(id,workspace_id),
 foreign key(workspace_id,configured_by) references workspace_users(workspace_id,id),
 foreign key(project_id,workspace_id) references projects(id,workspace_id),
 check((enabled and interval<>'manual') or next_due_at is null)
);
create table knowledge_website_scan_runs (
 id uuid primary key default gen_random_uuid(), workspace_id uuid not null, source_id uuid not null,
 actor_id uuid not null, project_id uuid, trigger text not null check(trigger in ('manual','scheduled')),
 source_revision integer not null check(source_revision>0), config_revision integer,
 source_url text not null check(length(source_url)<=2048), previous_hash text check(previous_hash ~ '^[a-f0-9]{64}$'),
 status text not null check(status in ('running','retry_wait','changed','unchanged','failed','blocked','stale')),
 lease_token uuid, lease_until timestamptz, next_attempt_at timestamptz,
 attempts integer not null default 1 check(attempts between 1 and 3),
 started_at timestamptz not null default now(), completed_at timestamptz,
 error_code text check(length(error_code)<=80), content_hash text check(content_hash ~ '^[a-f0-9]{64}$'), proposal_id uuid,
 unique(id,workspace_id),
 foreign key(source_id,workspace_id) references knowledge_sources(id,workspace_id),
 foreign key(workspace_id,actor_id) references workspace_users(workspace_id,id),
 foreign key(project_id,workspace_id) references projects(id,workspace_id),
 check((status='running')=(lease_token is not null and lease_until is not null)),
 check((status='retry_wait')=(next_attempt_at is not null)),
 check((status in ('running','retry_wait'))=(completed_at is null))
);
create unique index knowledge_website_scan_active_source on knowledge_website_scan_runs(workspace_id,source_id) where status in ('running','retry_wait');
create index knowledge_website_scan_history on knowledge_website_scan_runs(workspace_id,source_id,started_at desc);
create index knowledge_website_monitoring_due on knowledge_website_monitoring(workspace_id,configured_by,next_due_at) where enabled and interval<>'manual';

do $monitoring_rls$
declare relation text;
begin
 foreach relation in array array['knowledge_website_monitoring','knowledge_website_scan_runs'] loop
  execute format('alter table %I enable row level security',relation);
  execute format('alter table %I force row level security',relation);
  execute format('create policy knowledge_monitoring_scope on %I for all to novalure_tenant_app using (
   workspace_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid and knowledge_actor_can_write(false)
   and (project_id is null or crm_project_access(workspace_id,project_id,true))
   and exists(select 1 from knowledge_sources s where s.id=source_id and s.workspace_id=%I.workspace_id and s.project_id is not distinct from %I.project_id))
   with check (workspace_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid and knowledge_actor_can_write(false)
   and (project_id is null or crm_project_access(workspace_id,project_id,true))
   and exists(select 1 from knowledge_sources s where s.id=source_id and s.workspace_id=%I.workspace_id and s.project_id is not distinct from %I.project_id))',relation,relation,relation,relation,relation);
 end loop;
end $monitoring_rls$;
revoke all on knowledge_website_monitoring,knowledge_website_scan_runs from public,novalure_app,novalure_tenant_app;
grant select,insert,update on knowledge_website_monitoring,knowledge_website_scan_runs to novalure_tenant_app;

-- Database callers cannot impersonate a configured actor or splice a project,
-- source or scan identity into a pre-existing monitoring record.
create function knowledge_website_monitoring_guard() returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
declare actor uuid:=nullif(current_setting('app.actor_id',true),'')::uuid;
begin
 if not knowledge_actor_can_write(false) or not exists(select 1 from knowledge_sources s join knowledge_areas a on a.id=s.knowledge_area_id and a.workspace_id=s.workspace_id
  where s.id=new.source_id and s.workspace_id=new.workspace_id and s.source_type='url' and s.project_id is not distinct from new.project_id and s.archived_at is null and a.archived_at is null) then
  raise exception using errcode='42501',message='Monitoring requires an active scoped website source';
 end if;
 if TG_OP='INSERT' then
  if new.configured_by is distinct from actor or new.revision<>1 then raise exception using errcode='42501',message='Monitoring actor context required'; end if;
 elsif new.source_id is distinct from old.source_id or new.workspace_id is distinct from old.workspace_id or new.project_id is distinct from old.project_id or new.created_at is distinct from old.created_at then
  raise exception using errcode='42501',message='Monitoring source scope is immutable';
 elsif new.configured_by is distinct from old.configured_by or new.interval is distinct from old.interval or new.enabled is distinct from old.enabled or new.revision is distinct from old.revision then
  if new.configured_by is distinct from actor or new.revision<>old.revision+1 then raise exception using errcode='42501',message='Monitoring reconfiguration requires the executing actor and next revision'; end if;
 end if;
 if (TG_OP='INSERT' or new.revision is distinct from old.revision) and new.enabled then
  if not exists(select 1 from knowledge_center_entitlements e left join workspace_module_settings m on m.workspace_id=e.workspace_id and m.module_key='knowledge'
   where e.workspace_id=new.workspace_id and e.enabled and coalesce(m.enabled,true) and length(btrim(e.contract_reference))>0 and e.features->'websiteImport'='true'::jsonb
   and (new.interval='manual' or (e.features->'monitoring'='true'::jsonb and new.interval=any(e.monitoring_intervals)))) then
   raise exception using errcode='42501',message='Monitoring interval requires an explicit active contract';
  end if;
 end if;
 new.updated_at:=clock_timestamp(); return new;
end $$;
create trigger knowledge_website_monitoring_guard before insert or update on knowledge_website_monitoring for each row execute function knowledge_website_monitoring_guard();

create function knowledge_website_scan_guard() returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
declare actor uuid:=nullif(current_setting('app.actor_id',true),'')::uuid; source knowledge_sources%rowtype; allowance integer; used integer;
begin
 if not knowledge_actor_can_write(false) then raise exception using errcode='42501',message='Website scan requires a current writer'; end if;
 select * into source from knowledge_sources s where s.id=new.source_id and s.workspace_id=new.workspace_id and s.source_type='url';
 if not found or source.project_id is distinct from new.project_id then raise exception using errcode='42501',message='Website scan source scope mismatch'; end if;
 if TG_OP='INSERT' then
  if new.actor_id is distinct from actor or new.status<>'running' or new.attempts<>1 or new.source_revision<>source.kc_revision or source.archived_at is not null
   or new.completed_at is not null or new.error_code is not null or new.content_hash is not null or new.proposal_id is not null or new.lease_until<=clock_timestamp() or new.lease_until>clock_timestamp()+interval '120 seconds'
   or not exists(select 1 from knowledge_source_versions v join knowledge_areas a on a.id=source.knowledge_area_id and a.workspace_id=source.workspace_id where v.id=coalesce(source.draft_version_id,source.approved_version_id) and v.source_url=new.source_url and a.archived_at is null) then
   raise exception using errcode='23514',message='Scan must begin with the current source and executing actor';
  end if;
  if new.trigger='scheduled' and not exists(select 1 from knowledge_website_monitoring c join knowledge_center_entitlements e on e.workspace_id=c.workspace_id
    where c.workspace_id=new.workspace_id and c.source_id=new.source_id and c.configured_by=actor and c.enabled and c.interval<>'manual' and c.revision=new.config_revision and c.next_due_at<=clock_timestamp() and e.features->'monitoring'='true'::jsonb and c.interval=any(e.monitoring_intervals)) then
   raise exception using errcode='42501',message='Scheduled scan requires an active actor configuration';
  elsif new.trigger='manual' and new.config_revision is not null then raise exception using errcode='23514',message='Manual scan cannot impersonate a scheduler'; end if;
  -- Reservation is inseparable from the persisted claim, including direct SQL.
  perform pg_advisory_xact_lock(hashtextextended('knowledge-center:'||new.workspace_id::text,0));
  select (e.limits->>'maxScansPerMonth')::integer into allowance from knowledge_center_entitlements e left join workspace_module_settings m on m.workspace_id=e.workspace_id and m.module_key='knowledge'
   where e.workspace_id=new.workspace_id and e.enabled and coalesce(m.enabled,true) and length(btrim(e.contract_reference))>0 and e.features->'websiteImport'='true'::jsonb;
  select scans_this_month into used from knowledge_center_usage(new.workspace_id);
  if allowance is null or coalesce(used,0)>=allowance then raise exception using errcode='42501',message='Active website scan allowance required'; end if;
  insert into knowledge_query_usage(workspace_id,month,scan_count) values(new.workspace_id,date_trunc('month',now() at time zone 'UTC')::date,1)
   on conflict(workspace_id,month) do update set scan_count=knowledge_query_usage.scan_count+1;
  new.started_at:=clock_timestamp();
 else
  if (to_jsonb(new)-array['status','lease_token','lease_until','next_attempt_at','attempts','completed_at','error_code','content_hash','proposal_id']) is distinct from
     (to_jsonb(old)-array['status','lease_token','lease_until','next_attempt_at','attempts','completed_at','error_code','content_hash','proposal_id']) or old.status not in ('running','retry_wait') then
   raise exception using errcode='42501',message='Website scan identity and completed history are immutable';
  end if;
  if new.status='running' then
   if old.actor_id is distinct from actor or new.attempts<>old.attempts+1 or new.lease_token is not distinct from old.lease_token or new.lease_until<=clock_timestamp() or new.lease_until>clock_timestamp()+interval '120 seconds'
    or (old.status='running' and old.lease_until>clock_timestamp()) or (old.status='retry_wait' and old.next_attempt_at>clock_timestamp()) then
    raise exception using errcode='23514',message='Scan retry requires an expired own lease and bounded next attempt';
   end if;
  elsif new.attempts<>old.attempts or (old.actor_id is distinct from actor and not (new.status in ('stale','failed') and (old.lease_until is null or old.lease_until<=clock_timestamp()))) then
   raise exception using errcode='42501',message='Scan finalization requires its actor and attempt';
  end if;
  if new.status='changed' and (new.content_hash is null or not exists(select 1 from knowledge_change_proposals p where p.id=new.proposal_id and p.workspace_id=new.workspace_id and p.source_id=new.source_id and p.kind='website_change' and p.evidence->>'contentHash'=new.content_hash)) then
   raise exception using errcode='23514',message='A changed scan requires its persisted scoped proposal';
  elsif new.status='unchanged' and new.content_hash is distinct from new.previous_hash then raise exception using errcode='23514',message='Unchanged scans require the same content hash'; end if;
 end if;
 return new;
end $$;
create trigger knowledge_website_scan_guard before insert or update on knowledge_website_scan_runs for each row execute function knowledge_website_scan_guard();
revoke all on function knowledge_website_monitoring_guard(),knowledge_website_scan_guard() from public;
