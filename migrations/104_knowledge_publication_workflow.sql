-- Package 3: explicit review, immutable provenance, internal events and proposals.
-- Existing grants, channels and live pointers remain unchanged by installation.
set local lock_timeout = '5s';
set local statement_timeout = '14min';

alter table knowledge_source_versions
 add column change_reason text not null default 'Draft created' check(length(btrim(change_reason)) between 1 and 2000),
 add column provenance jsonb not null default '{"kind":"manual","trust":"untrusted_source_data"}' check(jsonb_typeof(provenance)='object' and octet_length(provenance::text)<=12000);

create table knowledge_publication_workflows (
 workspace_id uuid not null, source_id uuid not null, version_id uuid primary key,
 state text not null check(state in ('submitted','reviewed','approved','published','revoked')),
 submitted_by uuid not null references workspace_users(id), submitted_at timestamptz not null default now(),
 reviewed_by uuid references workspace_users(id), reviewed_at timestamptz,
 approved_by uuid references workspace_users(id), approved_at timestamptz,
 published_by uuid references workspace_users(id), published_at timestamptz,
 revoked_by uuid references workspace_users(id), revoked_at timestamptz,
 reason text not null check(length(btrim(reason)) between 1 and 2000),
 updated_at timestamptz not null default now(),
 foreign key(version_id,source_id,workspace_id) references knowledge_source_versions(id,source_id,workspace_id)
);
create table knowledge_change_proposals (
 id uuid primary key default gen_random_uuid(), workspace_id uuid not null, source_id uuid not null, version_id uuid not null,
 source_revision integer not null check(source_revision>0), area_id uuid not null, project_id uuid,
 dedupe_key text not null check(length(dedupe_key) between 1 and 240), kind text not null check(length(kind) between 1 and 80),
 status text not null default 'open' check(status in ('open','accepted','rejected','deferred')),
 revision integer not null default 1 check(revision>0), changes jsonb not null default '{}' check(jsonb_typeof(changes)='object' and octet_length(changes::text)<=700000),
 evidence jsonb not null default '{}' check(jsonb_typeof(evidence)='object' and octet_length(evidence::text)<=12000),
 references_json jsonb not null check(jsonb_typeof(references_json)='array' and jsonb_array_length(references_json) between 1 and 500),
 approval_level integer not null default 3 check(approval_level between 1 and 3),
 created_by uuid not null references workspace_users(id), updated_by uuid not null references workspace_users(id),
 reason text not null check(length(btrim(reason)) between 1 and 2000), accepted_version_id uuid,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 unique(workspace_id,dedupe_key),
 foreign key(version_id,source_id,workspace_id) references knowledge_source_versions(id,source_id,workspace_id),
 foreign key(accepted_version_id,source_id,workspace_id) references knowledge_source_versions(id,source_id,workspace_id),
 foreign key(area_id,workspace_id) references knowledge_areas(id,workspace_id),
 foreign key(project_id,workspace_id) references projects(id,workspace_id),
 check((status='accepted')=(accepted_version_id is not null))
);
create table knowledge_workflow_events (
 id uuid primary key default gen_random_uuid(),workspace_id uuid not null,source_id uuid,version_id uuid,project_id uuid,
 event_type text not null check(length(event_type) between 1 and 100),actor_id uuid not null references workspace_users(id),
 details jsonb not null default '{}' check(jsonb_typeof(details)='object' and octet_length(details::text)<=12000),
 visibility text not null default 'internal' check(visibility='internal'),
 delivery_state text not null default 'pending' check(delivery_state='pending'),created_at timestamptz not null default now(),
 foreign key(source_id,workspace_id) references knowledge_sources(id,workspace_id),
 foreign key(version_id,source_id,workspace_id) references knowledge_source_versions(id,source_id,workspace_id),
 foreign key(project_id,workspace_id) references projects(id,workspace_id),check(version_id is null or source_id is not null)
);
create table knowledge_maintenance_configurations (
 workspace_id uuid not null,area_id uuid primary key,fields jsonb not null check(jsonb_typeof(fields)='array' and jsonb_array_length(fields)<=50),
 stale_after_days integer not null default 90 check(stale_after_days between 1 and 36500),
 enabled boolean not null default false, next_analysis_at timestamptz, last_analyzed_at timestamptz,
 updated_by uuid not null references workspace_users(id),updated_at timestamptz not null default now(),
 foreign key(area_id,workspace_id) references knowledge_areas(id,workspace_id)
);
create index knowledge_proposal_queue on knowledge_change_proposals(workspace_id,status,updated_at desc);
create index knowledge_workflow_event_queue on knowledge_workflow_events(workspace_id,created_at desc);

do $policies$
declare relation text;
begin
 foreach relation in array array['knowledge_publication_workflows','knowledge_change_proposals','knowledge_workflow_events','knowledge_maintenance_configurations'] loop
  execute format('alter table %I enable row level security',relation);
  execute format('alter table %I force row level security',relation);
  execute format('revoke all on %I from public',relation);
  execute format('grant select,insert,update on %I to novalure_tenant_app',relation);
  execute format('create policy knowledge_workflow_tenant on %I for all to novalure_tenant_app using(workspace_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid and knowledge_actor_can_write(false)) with check(workspace_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid and knowledge_actor_can_write(false))',relation);
 end loop;
end $policies$;
revoke update on knowledge_workflow_events from novalure_tenant_app;
create policy knowledge_publication_scope on knowledge_publication_workflows as restrictive for all to novalure_tenant_app
 using(exists(select 1 from knowledge_sources s where s.id=source_id and s.workspace_id=knowledge_publication_workflows.workspace_id))
 with check(exists(select 1 from knowledge_sources s where s.id=source_id and s.workspace_id=knowledge_publication_workflows.workspace_id and (s.project_id is null or crm_project_access(s.workspace_id,s.project_id,true))));
create policy knowledge_proposal_scope on knowledge_change_proposals as restrictive for all to novalure_tenant_app
 using(exists(select 1 from knowledge_sources s where s.id=source_id and s.workspace_id=knowledge_change_proposals.workspace_id))
 with check(exists(select 1 from knowledge_sources s where s.id=source_id and s.workspace_id=knowledge_change_proposals.workspace_id and (s.project_id is null or crm_project_access(s.workspace_id,s.project_id,true))));
create policy knowledge_event_scope on knowledge_workflow_events as restrictive for all to novalure_tenant_app
 using((project_id is null or crm_project_access(workspace_id,project_id,false)) and (source_id is null or exists(select 1 from knowledge_sources s where s.id=source_id and s.workspace_id=knowledge_workflow_events.workspace_id)))
 with check((project_id is null or crm_project_access(workspace_id,project_id,true)) and (source_id is null or exists(select 1 from knowledge_sources s where s.id=source_id and s.workspace_id=knowledge_workflow_events.workspace_id)));
create policy knowledge_configuration_scope on knowledge_maintenance_configurations as restrictive for all to novalure_tenant_app
 using(exists(select 1 from knowledge_areas a where a.id=area_id and a.workspace_id=knowledge_maintenance_configurations.workspace_id))
 with check(knowledge_actor_can_write(true) and exists(select 1 from knowledge_areas a where a.id=area_id and a.workspace_id=knowledge_maintenance_configurations.workspace_id and (a.project_id is null or crm_project_access(a.workspace_id,a.project_id,true))));

create function knowledge_publication_workflow_guard() returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
declare actor uuid:=nullif(current_setting('app.actor_id',true),'')::uuid; live knowledge_sources%rowtype;
begin
 select * into live from knowledge_sources where id=new.source_id and workspace_id=new.workspace_id;
 if not found or live.archived_at is not null or not knowledge_actor_can_write(false) then raise exception using errcode='42501',message='Scoped active source required'; end if;
 if TG_OP='INSERT' then
  if new.state<>'submitted' or new.submitted_by is distinct from actor or new.reviewed_by is not null or new.approved_by is not null or new.published_by is not null or new.revoked_by is not null or live.draft_version_id is distinct from new.version_id then
   raise exception using errcode='23514',message='Workflow starts with the current submitted draft';
  end if;
  new.submitted_at:=now();
 else
  if new.workspace_id is distinct from old.workspace_id or new.source_id is distinct from old.source_id or new.version_id is distinct from old.version_id or new.submitted_by is distinct from old.submitted_by or new.submitted_at is distinct from old.submitted_at then raise exception using errcode='42501',message='Workflow identity is immutable'; end if;
  if new.state='reviewed' and old.state='submitted' and live.draft_version_id=new.version_id then
   if new.reviewed_by is distinct from actor then raise exception using errcode='42501',message='Reviewer context required'; end if; new.reviewed_at:=now();
  elsif new.state='approved' and old.state='reviewed' and live.draft_version_id=new.version_id and knowledge_actor_can_write(true) then
   if new.approved_by is distinct from actor then raise exception using errcode='42501',message='Approver context required'; end if; new.approved_at:=now();
  elsif new.state='published' and old.state='approved' and live.approved_version_id=new.version_id and knowledge_actor_can_write(true) then
   if new.published_by is distinct from actor then raise exception using errcode='42501',message='Publisher context required'; end if; new.published_at:=now();
  elsif new.state='revoked' and old.state='published' and live.approved_version_id=new.version_id and knowledge_actor_can_write(true) then
   if new.revoked_by is distinct from actor then raise exception using errcode='42501',message='Revoker context required'; end if; new.revoked_at:=now();
  else raise exception using errcode='23514',message='Invalid workflow transition or stale draft'; end if;
  if (new.reviewed_by is distinct from old.reviewed_by or new.reviewed_at is distinct from old.reviewed_at) and new.state<>'reviewed' or
   (new.approved_by is distinct from old.approved_by or new.approved_at is distinct from old.approved_at) and new.state<>'approved' or
   (new.published_by is distinct from old.published_by or new.published_at is distinct from old.published_at) and new.state<>'published' or
   (new.revoked_by is distinct from old.revoked_by or new.revoked_at is distinct from old.revoked_at) and new.state<>'revoked' then
   raise exception using errcode='42501',message='Historical workflow actors are immutable'; end if;
 end if;
 new.updated_at:=now(); return new;
end $$;
create trigger knowledge_publication_workflow_guard before insert or update on knowledge_publication_workflows for each row execute function knowledge_publication_workflow_guard();

create function knowledge_workflow_publication_guard() returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
begin
 if new.status='approved' and old.status='draft' and exists(select 1 from knowledge_publication_workflows w where w.version_id=new.id and w.workspace_id=new.workspace_id and w.state<>'approved') then
  raise exception using errcode='23514',message='Submitted drafts require completed review and approval before publication';
 end if;
 return new;
end $$;
create trigger knowledge_workflow_publication_guard before update on knowledge_source_versions for each row execute function knowledge_workflow_publication_guard();

create function knowledge_proposal_guard() returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
declare actor uuid:=nullif(current_setting('app.actor_id',true),'')::uuid; live knowledge_sources%rowtype; ref jsonb;
begin
 select * into live from knowledge_sources where id=new.source_id and workspace_id=new.workspace_id;
 if not found or live.archived_at is not null or live.knowledge_area_id is distinct from new.area_id or live.project_id is distinct from new.project_id or not knowledge_actor_can_write(false) then raise exception using errcode='42501',message='Proposal scope mismatch'; end if;
 if new.updated_by is distinct from actor then raise exception using errcode='42501',message='Proposal actor context required'; end if;
 if TG_OP='INSERT' then
  if not exists(select 1 from jsonb_array_elements(new.references_json) ref_entry(value) where ref_entry.value->>'sourceId'=new.source_id::text and ref_entry.value->>'versionId'=new.version_id::text) then raise exception using errcode='23514',message='Proposal target reference required'; end if;
  if new.created_by is distinct from actor or new.status<>'open' or new.revision<>1 or live.kc_revision<>new.source_revision or coalesce(live.draft_version_id,live.approved_version_id) is distinct from new.version_id then raise exception using errcode='23514',message='Proposal requires the current source version'; end if;
  for ref in select value from jsonb_array_elements(new.references_json) loop
   if not exists(select 1 from knowledge_sources s join knowledge_source_versions v on v.source_id=s.id and v.workspace_id=s.workspace_id
    where s.id=(ref->>'sourceId')::uuid and s.workspace_id=new.workspace_id and s.knowledge_area_id=(ref->>'areaId')::uuid
     and s.project_id is not distinct from new.project_id and s.project_id is not distinct from (ref->>'projectId')::uuid and s.kc_revision=(ref->>'sourceRevision')::integer
     and v.id=(ref->>'versionId')::uuid and v.id=coalesce(s.draft_version_id,s.approved_version_id) and v.version=(ref->>'contentVersion')::integer and s.archived_at is null) then raise exception using errcode='23514',message='Proposal reference mismatch'; end if;
  end loop;
 else
  if (to_jsonb(new)-array['status','revision','changes','reason','updated_by','updated_at','accepted_version_id']) is distinct from (to_jsonb(old)-array['status','revision','changes','reason','updated_by','updated_at','accepted_version_id']) or old.status not in ('open','deferred') or new.revision<>old.revision+1 then raise exception using errcode='42501',message='Proposal history is immutable'; end if;
  if new.status='accepted' and (live.kc_revision<>old.source_revision+1 or live.draft_version_id is distinct from new.accepted_version_id or not exists(select 1 from knowledge_source_versions v where v.id=new.accepted_version_id and v.source_id=new.source_id and v.workspace_id=new.workspace_id and v.status='draft' and v.provenance->>'proposalId'=new.id::text)) then raise exception using errcode='23514',message='Acceptance must create a new scoped draft'; end if;
  if new.status='accepted' then
   for ref in select value from jsonb_array_elements(old.references_json) loop
    if (ref->>'sourceId')::uuid<>old.source_id and not exists(select 1 from knowledge_sources s join knowledge_source_versions v on v.source_id=s.id and v.workspace_id=s.workspace_id
     where s.id=(ref->>'sourceId')::uuid and s.workspace_id=new.workspace_id and s.project_id is not distinct from new.project_id and s.kc_revision=(ref->>'sourceRevision')::integer
      and s.knowledge_area_id=(ref->>'areaId')::uuid and v.id=(ref->>'versionId')::uuid and v.version=(ref->>'contentVersion')::integer and v.id=coalesce(s.draft_version_id,s.approved_version_id) and s.archived_at is null) then
      raise exception using errcode='23514',message='Another proposal reference became stale';
    end if;
   end loop;
  end if;
 end if;
 if exists(select 1 from jsonb_object_keys(new.changes) k where k not in ('name','content','structuredData')) then raise exception using errcode='23514',message='Proposal changes cannot control policy or attachments'; end if;
 new.updated_at:=now(); return new;
end $$;
create trigger knowledge_proposal_guard before insert or update on knowledge_change_proposals for each row execute function knowledge_proposal_guard();

create function knowledge_workflow_event_guard() returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
begin
 if TG_OP<>'INSERT' then raise exception using errcode='42501',message='Knowledge events are append only'; end if;
 if new.actor_id is distinct from nullif(current_setting('app.actor_id',true),'')::uuid or not knowledge_actor_can_write(false) or
 (new.source_id is not null and not exists(select 1 from knowledge_sources s where s.id=new.source_id and s.workspace_id=new.workspace_id and s.project_id is not distinct from new.project_id)) then raise exception using errcode='42501',message='Event actor and source scope required'; end if;
 new.created_at:=now(); return new;
end $$;
create trigger knowledge_workflow_event_guard before insert or update or delete on knowledge_workflow_events for each row execute function knowledge_workflow_event_guard();
create function knowledge_maintenance_configuration_guard() returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
begin
 if not knowledge_actor_can_write(true) or new.updated_by is distinct from nullif(current_setting('app.actor_id',true),'')::uuid or (TG_OP='UPDATE' and (new.workspace_id is distinct from old.workspace_id or new.area_id is distinct from old.area_id)) then raise exception using errcode='42501',message='Maintenance configuration requires a scoped administrator'; end if;
 new.updated_at:=now(); return new;
end $$;
create trigger knowledge_maintenance_configuration_guard before insert or update on knowledge_maintenance_configurations for each row execute function knowledge_maintenance_configuration_guard();
revoke all on function knowledge_publication_workflow_guard(),knowledge_workflow_publication_guard(),knowledge_proposal_guard(),knowledge_workflow_event_guard(),knowledge_maintenance_configuration_guard() from public;

-- Existing administrator publication remains available for untouched legacy
-- drafts; a submitted draft must pass its review. Historical versions cannot
-- be reattached as live content: restoration must create another draft first.
create function knowledge_publication_pointer_guard() returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
begin
 if new.knowledge_area_id is not null and new.approved_version_id is distinct from old.approved_version_id and new.approved_version_id is not null then
  if old.draft_version_id is distinct from new.approved_version_id or exists(select 1 from knowledge_publication_workflows w where w.version_id=new.approved_version_id and w.workspace_id=new.workspace_id and w.state<>'approved') then raise exception using errcode='23514',message='Publish the current reviewed draft; restore history into a new draft'; end if;
 end if;
 return new;
end $$;
create trigger knowledge_publication_pointer_guard before update on knowledge_sources for each row execute function knowledge_publication_pointer_guard();
create function knowledge_restoration_guard() returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
begin
 if new.provenance->>'kind'='restoration' then
  if new.provenance->'confirmedCurrentness' is distinct from 'true'::jsonb or new.provenance->'confirmedLegal' is distinct from 'true'::jsonb or not exists(select 1 from knowledge_source_versions prior where prior.id=(new.provenance->>'restoredVersionId')::uuid and prior.source_id=new.source_id and prior.workspace_id=new.workspace_id
    and prior.processing_status=new.processing_status and prior.processing_message is not distinct from new.processing_message and prior.processing_format is not distinct from new.processing_format and prior.processing_error_code is not distinct from new.processing_error_code and prior.document_sha256 is not distinct from new.document_sha256 and prior.media_asset_id is not distinct from new.media_asset_id) then raise exception using errcode='23514',message='Restoration requires explicit legal/currentness confirmation and immutable parser evidence'; end if;
 end if;
 return new;
end $$;
create trigger knowledge_restoration_guard before insert on knowledge_source_versions for each row execute function knowledge_restoration_guard();
revoke all on function knowledge_publication_pointer_guard(),knowledge_restoration_guard() from public;

-- These constraints reject fabricated actor timestamps even on raw SQL paths.
alter table knowledge_publication_workflows
 add constraint knowledge_workflow_review_actor_time check((reviewed_by is null)=(reviewed_at is null)),
 add constraint knowledge_workflow_approval_actor_time check((approved_by is null)=(approved_at is null)),
 add constraint knowledge_workflow_publish_actor_time check((published_by is null)=(published_at is null)),
 add constraint knowledge_workflow_revoke_actor_time check((revoked_by is null)=(revoked_at is null));
