-- Package 2 additive Knowledge Center. No entitlement is enabled or priced here.
-- Runtime credentials cannot provision contracts or change commercial limits.
set local lock_timeout = '5s';
set local statement_timeout = '14min';

create unique index if not exists knowledge_sources_id_workspace_uidx on knowledge_sources(id,workspace_id);
create unique index if not exists projects_id_workspace_kc_uidx on projects(id,workspace_id);
create unique index if not exists bots_id_workspace_kc_uidx on bots(id,workspace_id);

create table knowledge_areas (
 id uuid primary key default gen_random_uuid(), workspace_id uuid not null references workspaces(id),
 name text not null check(length(btrim(name)) between 1 and 160), kind text not null check(kind in ('company','business','project')),
 project_id uuid, description text not null default '' check(length(description)<=2000), archived_at timestamptz,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 unique(id,workspace_id), foreign key(project_id,workspace_id) references projects(id,workspace_id),
 check((kind='project')=(project_id is not null))
);
alter table knowledge_sources add column knowledge_area_id uuid,
 add column kc_revision integer not null default 1 check(kc_revision>0),
 add column draft_version_id uuid, add column approved_version_id uuid, add column archived_at timestamptz,
 add constraint knowledge_source_area_tenant_fk foreign key(knowledge_area_id,workspace_id) references knowledge_areas(id,workspace_id);

create table knowledge_source_versions (
 id uuid primary key default gen_random_uuid(), workspace_id uuid not null references workspaces(id), source_id uuid not null,
 version integer not null check(version>0), name text not null check(length(btrim(name)) between 1 and 200),
 content text not null default '' check(octet_length(content)<=600000), structured_data jsonb not null default '{}' check(jsonb_typeof(structured_data)='object' and octet_length(structured_data::text)<=600000),
 source_url text, media_asset_id uuid references media_assets(id), document_size_bytes bigint not null default 0 check(document_size_bytes>=0),
 status text not null default 'draft' check(status in ('draft','approved')),
 created_by uuid not null references workspace_users(id), approved_by uuid references workspace_users(id),
 created_at timestamptz not null default now(), approved_at timestamptz,
 unique(id,source_id,workspace_id), unique(source_id,version), foreign key(source_id,workspace_id) references knowledge_sources(id,workspace_id),
 check((status='approved')=(approved_at is not null and approved_by is not null))
);
alter table knowledge_sources add constraint knowledge_source_draft_version_fk foreign key(draft_version_id,id,workspace_id) references knowledge_source_versions(id,source_id,workspace_id),
 add constraint knowledge_source_approved_version_fk foreign key(approved_version_id,id,workspace_id) references knowledge_source_versions(id,source_id,workspace_id);
alter table knowledge_chunks add column knowledge_version_id uuid references knowledge_source_versions(id);

create table knowledge_area_grants (
 workspace_id uuid not null references workspaces(id), bot_id uuid not null, area_id uuid not null,
 channel text not null check(channel in ('webchat','whatsapp','instagram','messenger','email','internal','voice','telephone')),
 created_by uuid not null references workspace_users(id), created_at timestamptz not null default now(),
 primary key(bot_id,channel,area_id), foreign key(bot_id,workspace_id) references bots(id,workspace_id),
 foreign key(area_id,workspace_id) references knowledge_areas(id,workspace_id)
);
create table knowledge_center_entitlements (
 workspace_id uuid primary key references workspaces(id), enabled boolean not null default false,
 max_sources integer not null default 0 check(max_sources>=0), max_storage_bytes bigint not null default 0 check(max_storage_bytes>=0),
 max_queries_per_month integer not null default 0 check(max_queries_per_month>=0),
 features jsonb not null default '{"websiteImport":false,"monitoring":false,"advancedMaintenance":false}' check(jsonb_typeof(features)='object'),
 limits jsonb not null default '{"maxAreas":0,"maxWebsites":0,"maxScansPerMonth":0,"maxUsers":0,"maxAssistants":0}' check(jsonb_typeof(limits)='object'),
 contract_reference text, updated_at timestamptz not null default now(),
 check(not enabled or (contract_reference is not null and length(btrim(contract_reference))>0 and max_sources>0 and max_storage_bytes>0 and max_queries_per_month>0))
);
create table knowledge_query_usage (
 workspace_id uuid not null references workspaces(id), month date not null, query_count integer not null default 0 check(query_count>=0), scan_count integer not null default 0 check(scan_count>=0),
 primary key(workspace_id,month), check(extract(day from month)=1)
);
create index knowledge_areas_workspace_idx on knowledge_areas(workspace_id,project_id) where archived_at is null;
create index knowledge_sources_area_idx on knowledge_sources(workspace_id,knowledge_area_id) where archived_at is null;
create index knowledge_versions_source_idx on knowledge_source_versions(workspace_id,source_id,version desc);
create index knowledge_chunks_version_idx on knowledge_chunks(knowledge_version_id);

-- New relations always bind both the existing active membership and tenant context.
do $migration$
declare relation text;
begin
 foreach relation in array array['knowledge_areas','knowledge_source_versions','knowledge_area_grants','knowledge_center_entitlements','knowledge_query_usage'] loop
  execute format('alter table %I enable row level security',relation);
  execute format('alter table %I force row level security',relation);
  execute format('create policy knowledge_tenant_scope on %I for all to novalure_tenant_app using (workspace_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid and exists(select 1 from workspace_users u where u.id=nullif(current_setting(''app.actor_id'',true),'''')::uuid and u.workspace_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid and u.status=''active'')) with check (workspace_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid and exists(select 1 from workspace_users u where u.id=nullif(current_setting(''app.actor_id'',true),'''')::uuid and u.workspace_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid and u.status=''active''))',relation);
 end loop;
end $migration$;
revoke all on knowledge_areas,knowledge_source_versions,knowledge_area_grants,knowledge_center_entitlements,knowledge_query_usage from public;
grant select,insert,update on knowledge_areas,knowledge_source_versions,knowledge_query_usage to novalure_tenant_app;
grant select,insert,delete on knowledge_area_grants to novalure_tenant_app;
grant select on knowledge_center_entitlements to novalure_tenant_app;
grant select,insert,update on knowledge_sources to novalure_tenant_app;
grant select,insert,delete on knowledge_chunks to novalure_tenant_app;
grant select on bots,media_assets,media_asset_shares,workspace_module_settings to novalure_tenant_app;

create or replace function knowledge_actor_can_write(p_admin boolean default false)
returns boolean language sql stable security invoker set search_path=pg_catalog,public as $$
 select exists(select 1 from workspace_users u where u.id=nullif(current_setting('app.actor_id',true),'')::uuid
  and u.workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid and u.status='active'
  and (u.role in ('owner','admin') or (not p_admin and u.role='agent')))
$$;
revoke all on function knowledge_actor_can_write(boolean) from public;
grant execute on function knowledge_actor_can_write(boolean) to novalure_tenant_app;

alter table knowledge_sources enable row level security;
alter table knowledge_sources force row level security;
create policy knowledge_source_read on knowledge_sources for select to novalure_tenant_app using (
 workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid and exists(select 1 from workspace_users u
 where u.id=nullif(current_setting('app.actor_id',true),'')::uuid and u.workspace_id=knowledge_sources.workspace_id and u.status='active')
 and (project_id is null or crm_project_access(workspace_id,project_id,false))
 and (knowledge_actor_can_write(false) or status='approved' or approved_version_id is not null)
);
create policy knowledge_source_write on knowledge_sources for all to novalure_tenant_app using (
 workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid and knowledge_actor_can_write(false)
 and (project_id is null or crm_project_access(workspace_id,project_id,true))
) with check (workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid and knowledge_actor_can_write(false)
 and (project_id is null or crm_project_access(workspace_id,project_id,true)));
alter table knowledge_chunks enable row level security;
alter table knowledge_chunks force row level security;
create policy knowledge_chunk_read on knowledge_chunks for select to novalure_tenant_app using (
 exists(select 1 from knowledge_sources s where s.id=source_id and s.workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid
  and s.archived_at is null
  and (knowledge_version_id is null and s.knowledge_area_id is null and s.status='approved' or knowledge_version_id=s.approved_version_id))
);
create policy knowledge_chunk_write on knowledge_chunks for all to novalure_tenant_app using (
 knowledge_actor_can_write(true) and exists(select 1 from knowledge_sources s where s.id=source_id)
) with check (knowledge_actor_can_write(true) and exists(select 1 from knowledge_sources s where s.id=source_id));

-- Narrow the generic new-relation policies with restrictive project and draft checks.
create policy knowledge_area_project on knowledge_areas as restrictive for all to novalure_tenant_app
 using(project_id is null or crm_project_access(workspace_id,project_id,false))
 with check(project_id is null or crm_project_access(workspace_id,project_id,true));
create policy knowledge_version_scope on knowledge_source_versions as restrictive for all to novalure_tenant_app
 using(exists(select 1 from knowledge_sources s where s.id=source_id and s.workspace_id=knowledge_source_versions.workspace_id)
  and (knowledge_actor_can_write(false) or (status='approved' and exists(select 1 from knowledge_sources current_source
    join knowledge_areas current_area on current_area.id=current_source.knowledge_area_id and current_area.workspace_id=current_source.workspace_id
    where current_source.id=source_id and current_source.approved_version_id=knowledge_source_versions.id
     and current_source.archived_at is null and current_area.archived_at is null))))
 with check(knowledge_actor_can_write(false) and exists(select 1 from knowledge_sources s where s.id=source_id and s.workspace_id=knowledge_source_versions.workspace_id));
create policy knowledge_grant_scope on knowledge_area_grants as restrictive for all to novalure_tenant_app
 using(exists(select 1 from knowledge_areas a join bots b on b.workspace_id=a.workspace_id where a.id=area_id and b.id=bot_id
  and a.workspace_id=knowledge_area_grants.workspace_id and (b.project_id is null or crm_project_access(b.workspace_id,b.project_id,false))))
 with check(knowledge_actor_can_write(true) and exists(select 1 from knowledge_areas a where a.id=area_id and a.workspace_id=knowledge_area_grants.workspace_id));
create policy knowledge_area_insert_role on knowledge_areas as restrictive for insert to novalure_tenant_app with check(knowledge_actor_can_write(false));
create policy knowledge_area_update_role on knowledge_areas as restrictive for update to novalure_tenant_app using(knowledge_actor_can_write(false)) with check(knowledge_actor_can_write(false));
create policy knowledge_grant_delete_role on knowledge_area_grants as restrictive for delete to novalure_tenant_app using(knowledge_actor_can_write(true));

create function knowledge_source_guard() returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
begin
 if new.knowledge_area_id is not null then
  if new.approved_version_id is not null and not exists(select 1 from knowledge_source_versions v where v.id=new.approved_version_id
    and v.source_id=new.id and v.workspace_id=new.workspace_id and v.status='approved') then
   raise exception using errcode='23514',message='Published knowledge pointer requires an approved version';
  end if;
  if new.draft_version_id is not null and not exists(select 1 from knowledge_source_versions v where v.id=new.draft_version_id
    and v.source_id=new.id and v.workspace_id=new.workspace_id and v.status='draft') then
   raise exception using errcode='23514',message='Draft knowledge pointer requires a draft version';
  end if;
  if TG_OP='UPDATE' and new.approved_version_id is distinct from old.approved_version_id and not knowledge_actor_can_write(true) then
   raise exception using errcode='42501',message='Publication pointer changes require an administrator';
  end if;
  if new.status='approved' and (new.approved_version_id is null or not knowledge_actor_can_write(true))
    and (TG_OP='INSERT' or old.status is distinct from new.status) then
   raise exception using errcode='42501',message='Knowledge publication requires an administrator and approved version';
  end if;
 end if;
 if new.knowledge_area_id is not null and not exists(select 1 from knowledge_areas a
   where a.id=new.knowledge_area_id and a.workspace_id=new.workspace_id and a.project_id is not distinct from new.project_id) then
  raise exception using errcode='23514',message='Knowledge source area and project must match';
 end if;
 if TG_OP='UPDATE' and (new.workspace_id is distinct from old.workspace_id or new.knowledge_area_id is distinct from old.knowledge_area_id
   or new.project_id is distinct from old.project_id or new.source_type is distinct from old.source_type) then
  raise exception using errcode='42501',message='Knowledge source tenant, area, project and type are immutable';
 end if;
 return new;
end $$;
create trigger knowledge_source_guard before insert or update on knowledge_sources for each row execute function knowledge_source_guard();
revoke all on function knowledge_source_guard() from public;

create function knowledge_grant_guard() returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
begin
 if not knowledge_actor_can_write(true) or new.created_by is distinct from nullif(current_setting('app.actor_id',true),'')::uuid
  or not exists(select 1 from bots b join knowledge_areas a on a.workspace_id=b.workspace_id
   where b.id=new.bot_id and a.id=new.area_id and b.workspace_id=new.workspace_id and a.archived_at is null
    and (a.project_id is null or a.project_id=b.project_id)
    and (b.project_id is null or crm_project_access(b.workspace_id,b.project_id,true))) then
  raise exception using errcode='42501',message='Knowledge grant requires an administrator and matching bot/project scope';
 end if;
 return new;
end $$;
create trigger knowledge_grant_guard before insert or update on knowledge_area_grants for each row execute function knowledge_grant_guard();
revoke all on function knowledge_grant_guard() from public;

create function knowledge_version_guard() returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 if new.workspace_id is distinct from nullif(current_setting('app.tenant_id',true),'')::uuid
   or not knowledge_actor_can_write(false) then
  raise exception using errcode='42501',message='Knowledge version context mismatch';
 end if;
 if TG_OP='UPDATE' then
  if (to_jsonb(new)-array['status','approved_at','approved_by']) is distinct from (to_jsonb(old)-array['status','approved_at','approved_by'])
    or old.status='approved' or new.status<>'approved' or not knowledge_actor_can_write(true) then
   raise exception using errcode='42501',message='Knowledge versions are immutable and publication requires an administrator';
  end if;
  if new.approved_by is distinct from nullif(current_setting('app.actor_id',true),'')::uuid then
   raise exception using errcode='42501',message='Knowledge approver must be the active actor';
  end if;
  new.approved_at := now();
 elsif new.status<>'draft' or new.created_by is distinct from nullif(current_setting('app.actor_id',true),'')::uuid then
  raise exception using errcode='42501',message='New knowledge versions must be drafts';
 end if;
 if new.media_asset_id is not null then
  perform m.id from media_assets m where m.id=new.media_asset_id
   and m.workspace_id=new.workspace_id::text and m.storage_access='private' and not m.is_public and m.public_token is null
   and m.size_bytes=new.document_size_bytes and m.size_bytes>0 and m.size_bytes<=10485760
   and m.mime_type in ('image/jpeg','image/png','image/webp','application/pdf','text/plain','text/csv','text/markdown','application/json','application/vnd.openxmlformats-officedocument.wordprocessingml.document')
   and (m.folder='knowledge-private-'||new.created_by::text or exists(select 1 from knowledge_source_versions prior
     where prior.workspace_id=new.workspace_id and prior.source_id=new.source_id and prior.media_asset_id=m.id and prior.id<>new.id))
   and not exists(select 1 from media_asset_shares sh where sh.asset_id=m.id and sh.workspace_id=m.workspace_id)
   for update of m;
  if not found then raise exception using errcode='23514',message='A private unshared same-tenant Knowledge document is required'; end if;
 end if;
 return new;
end $$;
create trigger knowledge_version_guard before insert or update on knowledge_source_versions for each row execute function knowledge_version_guard();
revoke all on function knowledge_version_guard() from public;

-- The definer can aggregate the complete current tenant despite project policies.
-- Its return value contains counters only, never source contents or identifiers.
do $owner_policies$
declare relation text;
begin
 foreach relation in array array['knowledge_sources','knowledge_source_versions','knowledge_areas','knowledge_query_usage','media_assets'] loop
  execute format('create policy knowledge_owner_usage on %I for select to %I using (workspace_id::text=nullif(current_setting(''app.tenant_id'',true),''''))',relation,current_user);
 end loop;
 execute format('create policy knowledge_owner_lock on media_assets for update to %I using (workspace_id=nullif(current_setting(''app.tenant_id'',true),'''')) with check (workspace_id=nullif(current_setting(''app.tenant_id'',true),''''))',current_user);
end $owner_policies$;
create function knowledge_center_usage(p_workspace uuid)
returns table(sources integer,storage_bytes bigint,queries_this_month integer,areas integer,websites integer,scans_this_month integer)
language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 if p_workspace is distinct from nullif(current_setting('app.tenant_id',true),'')::uuid
  or not exists(select 1 from workspace_users u where u.workspace_id=p_workspace and u.id=nullif(current_setting('app.actor_id',true),'')::uuid and u.status='active') then
  raise exception using errcode='42501',message='Knowledge usage context mismatch';
 end if;
 return query select
  (select count(*)::int from knowledge_sources s where s.workspace_id=p_workspace and s.knowledge_area_id is not null and s.archived_at is null),
  (select coalesce(sum(octet_length(v.content)+octet_length(v.structured_data::text)),0)::bigint from knowledge_source_versions v where v.workspace_id=p_workspace)
   +(select coalesce(sum(m.size_bytes),0)::bigint from media_assets m where m.workspace_id=p_workspace::text and m.folder like 'knowledge-private-%'),
  coalesce((select q.query_count from knowledge_query_usage q where q.workspace_id=p_workspace and q.month=date_trunc('month',now() at time zone 'UTC')::date),0),
  (select count(*)::int from knowledge_areas a where a.workspace_id=p_workspace and a.archived_at is null),
  (select count(*)::int from knowledge_sources s where s.workspace_id=p_workspace and s.knowledge_area_id is not null and s.source_type='url' and s.archived_at is null),
  coalesce((select q.scan_count from knowledge_query_usage q where q.workspace_id=p_workspace and q.month=date_trunc('month',now() at time zone 'UTC')::date),0);
end $$;
revoke all on function knowledge_center_usage(uuid) from public;
grant execute on function knowledge_center_usage(uuid) to novalure_tenant_app;

-- Keep historical Studio helper and its five-column return contract unchanged.
-- Consumers switch to this six-column helper only when 101 is installed.
create function crm_knowledge_media_reference_counts(p_asset uuid)
returns table(media_count integer,document_count integer,send_count integer,share_count integer,studio_count integer,knowledge_count integer)
language plpgsql stable security definer set search_path=pg_catalog,public as $$
begin
 return query select prior.media_count,prior.document_count,prior.send_count,prior.share_count,prior.studio_count,
  -- Every version attachment is protected by the permanent reserved-folder
  -- invariant. The explicit owner policy exposes all current-tenant versions.
  case when exists(select 1 from media_assets m where m.id=p_asset and m.workspace_id=nullif(current_setting('app.tenant_id',true),'')
    and m.folder like 'knowledge-private-%') then 1
   else (select count(*)::integer from knowledge_source_versions v where v.media_asset_id=p_asset) end
 from crm_studio_media_reference_counts(p_asset) prior;
end $$;
revoke all on function crm_knowledge_media_reference_counts(uuid) from public;
grant execute on function crm_knowledge_media_reference_counts(uuid) to novalure_tenant_app;

create function knowledge_media_privacy_guard() returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
begin
 if TG_OP='UPDATE' and old.folder like 'knowledge-private-%' then
  if (to_jsonb(new)-array['alt','name','original_name']) is distinct from (to_jsonb(old)-array['alt','name','original_name']) then
   raise exception using errcode='42501',message='Knowledge document storage and privacy are immutable';
  end if;
 end if;
 if new.folder like 'knowledge-private-%' and (new.storage_access<>'private' or new.is_public or new.public_token is not null
   or new.workspace_id is distinct from nullif(current_setting('app.tenant_id',true),'')
   or (TG_OP='INSERT' and (new.folder is distinct from 'knowledge-private-'||nullif(current_setting('app.actor_id',true),'') or not knowledge_actor_can_write(false)))) then
  raise exception using errcode='42501',message='Knowledge uploads require a private active actor context';
 end if;
 return new;
end $$;
create trigger knowledge_media_privacy_guard before insert or update on media_assets for each row execute function knowledge_media_privacy_guard();
revoke all on function knowledge_media_privacy_guard() from public;
create function knowledge_media_share_guard() returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
declare target_folder text;
begin
 select m.folder into target_folder from media_assets m where m.id=new.asset_id and m.workspace_id=new.workspace_id for update of m;
 if target_folder like 'knowledge-private-%' then
  raise exception using errcode='42501',message='Knowledge documents cannot have generic media shares';
 end if;
 return new;
end $$;
create trigger knowledge_media_share_guard before insert on media_asset_shares for each row execute function knowledge_media_share_guard();
revoke all on function knowledge_media_share_guard() from public;

-- Chat history is part of the same saved bot/project/channel context. Historical
-- ambiguous bindings are retained but cannot become readable through new calls.
create function knowledge_bot_context_allowed(p_workspace uuid,p_bot uuid,p_project uuid)
returns boolean language sql stable security invoker set search_path=pg_catalog,public as $$
 select p_workspace=nullif(current_setting('app.tenant_id',true),'')::uuid
  and exists(select 1 from workspace_users u where u.workspace_id=p_workspace
   and u.id=nullif(current_setting('app.actor_id',true),'')::uuid and u.status='active')
  and exists(select 1 from bots b where b.workspace_id=p_workspace and b.id=p_bot
   and b.project_id is not distinct from p_project and (b.project_id is null or crm_project_access(p_workspace,b.project_id,false)))
$$;
revoke all on function knowledge_bot_context_allowed(uuid,uuid,uuid) from public;
grant execute on function knowledge_bot_context_allowed(uuid,uuid,uuid) to novalure_tenant_app;
alter table bot_conversations enable row level security;
alter table bot_conversations force row level security;
create policy knowledge_bot_conversation_tenant on bot_conversations for all to novalure_tenant_app
 using(workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
 with check(workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
create policy knowledge_bot_conversation_scope on bot_conversations as restrictive for all to novalure_tenant_app
 using(knowledge_bot_context_allowed(workspace_id,bot_id,project_id)
  and metadata->>'channel' in ('webchat','whatsapp','instagram','messenger','email','internal','voice','telephone'))
 with check(knowledge_bot_context_allowed(workspace_id,bot_id,project_id)
  and metadata->>'channel' in ('webchat','whatsapp','instagram','messenger','email','internal','voice','telephone'));
alter table bot_messages enable row level security;
alter table bot_messages force row level security;
create policy knowledge_bot_message_tenant on bot_messages for all to novalure_tenant_app
 using(workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
 with check(workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
create policy knowledge_bot_message_scope on bot_messages as restrictive for all to novalure_tenant_app
 using(exists(select 1 from bot_conversations c where c.id=conversation_id and c.workspace_id=bot_messages.workspace_id))
 with check(exists(select 1 from bot_conversations c where c.id=conversation_id and c.workspace_id=bot_messages.workspace_id));
alter table bot_tool_calls enable row level security;
alter table bot_tool_calls force row level security;
create policy knowledge_bot_tool_tenant on bot_tool_calls for all to novalure_tenant_app
 using(workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
 with check(workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
create policy knowledge_bot_tool_scope on bot_tool_calls as restrictive for all to novalure_tenant_app
 using(exists(select 1 from bots b where b.id=bot_id and knowledge_bot_context_allowed(bot_tool_calls.workspace_id,b.id,b.project_id))
  and (conversation_id is null or exists(select 1 from bot_conversations c where c.id=conversation_id and c.workspace_id=bot_tool_calls.workspace_id and c.bot_id=bot_tool_calls.bot_id)))
 with check(exists(select 1 from bots b where b.id=bot_id and knowledge_bot_context_allowed(bot_tool_calls.workspace_id,b.id,b.project_id))
  and (conversation_id is null or exists(select 1 from bot_conversations c where c.id=conversation_id and c.workspace_id=bot_tool_calls.workspace_id and c.bot_id=bot_tool_calls.bot_id)));
grant select,insert,update on bot_conversations,bot_messages,bot_tool_calls to novalure_tenant_app;

create function knowledge_bot_history_guard() returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
begin
 if TG_OP='UPDATE' and (new.workspace_id is distinct from old.workspace_id) then
  raise exception using errcode='42501',message='Bot history tenant is immutable';
 end if;
 if TG_TABLE_NAME='bot_conversations' then
  if TG_OP='UPDATE' and (new.bot_id is distinct from old.bot_id or new.project_id is distinct from old.project_id
    or new.metadata->>'channel' is distinct from old.metadata->>'channel') then
   raise exception using errcode='42501',message='Bot conversation context is immutable';
  end if;
  if not knowledge_bot_context_allowed(new.workspace_id,new.bot_id,new.project_id)
    or coalesce(new.metadata->>'channel','') not in ('webchat','whatsapp','instagram','messenger','email','internal','voice','telephone') then
   raise exception using errcode='42501',message='A saved same-tenant bot/project/channel is required';
  end if;
  if new.contact_id is not null and not exists(select 1 from contacts c where c.id=new.contact_id and c.workspace_id=new.workspace_id
    and (c.project_id is null or c.project_id=new.project_id)) then
   raise exception using errcode='42501',message='Conversation contact must share its tenant and project';
  end if;
  if new.lead_id is not null and not exists(select 1 from leads l where l.id=new.lead_id and l.workspace_id=new.workspace_id
    and (l.project_id is null or l.project_id=new.project_id)) then
   raise exception using errcode='42501',message='Conversation lead must share its tenant and project';
  end if;
 else
  if TG_OP='UPDATE' and new.conversation_id is distinct from old.conversation_id then
   raise exception using errcode='42501',message='Bot history conversation is immutable';
  end if;
  if TG_TABLE_NAME='bot_tool_calls' then
   if TG_OP='UPDATE' and new.bot_id is distinct from old.bot_id then
    raise exception using errcode='42501',message='Bot tool context is immutable';
   end if;
  end if;
 end if;
 return new;
end $$;
create trigger knowledge_bot_conversation_guard before insert or update on bot_conversations for each row execute function knowledge_bot_history_guard();
create trigger knowledge_bot_message_guard before insert or update on bot_messages for each row execute function knowledge_bot_history_guard();
create trigger knowledge_bot_tool_guard before insert or update on bot_tool_calls for each row execute function knowledge_bot_history_guard();
revoke all on function knowledge_bot_history_guard() from public;
