-- Personal standalone events reuse the actor-bound booking connection/provider.
-- No legacy connection, existing booking, recipient or production activation is changed.
set local lock_timeout='5s';
alter table public.calendar_events add constraint calendar_personal_owner_key unique(workspace_id,owner_user_id,id);
create table public.crm_personal_calendar_events (
 id uuid primary key,workspace_id uuid not null references public.workspaces(id),
 actor_id uuid not null,project_id uuid,provider text not null check(provider in ('microsoft','google')),
 connection_id uuid not null,connection_revision bigint not null,account_id text not null,calendar_id text not null,
 event jsonb not null check(jsonb_typeof(event)='object'),version bigint not null default 1 check(version>0),
 state text not null check(state in ('processing','uncertain','synced','conflict','cancelled','failed')),
 provider_event_id text,provider_etag text,remote_snapshot jsonb,error_code text,operation_id uuid,
 created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 unique(workspace_id,id),foreign key(workspace_id,actor_id) references public.workspace_users(workspace_id,id),
 foreign key(workspace_id,actor_id,connection_id) references public.booking_calendar_connections(workspace_id,user_id,id),
 foreign key(workspace_id,actor_id,id) references public.calendar_events(workspace_id,owner_user_id,id)
);
create unique index personal_calendar_remote_mapping on public.crm_personal_calendar_events(provider,connection_id,calendar_id,provider_event_id) where provider_event_id is not null;
create table public.crm_personal_calendar_operations (
 id uuid primary key,workspace_id uuid not null,actor_id uuid not null,event_id uuid not null,
 action text not null check(action in ('create','update','cancel','import_remote')),request_hash text not null,
 payload jsonb not null,result jsonb,state text not null check(state in ('processing','uncertain','succeeded','rejected')),
 lease_owner uuid,lease_until timestamptz,error_code text,created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 unique(workspace_id,actor_id,id),foreign key(workspace_id,event_id) references public.crm_personal_calendar_events(workspace_id,id),
 foreign key(workspace_id,actor_id) references public.workspace_users(workspace_id,id)
);
alter table public.crm_personal_calendar_events enable row level security;
alter table public.crm_personal_calendar_events force row level security;
alter table public.crm_personal_calendar_operations enable row level security;
alter table public.crm_personal_calendar_operations force row level security;
create policy personal_calendar_actor on public.crm_personal_calendar_events for all to novalure_tenant_app
 using(public.booking_actor_allowed(workspace_id,actor_id) and (project_id is null or public.crm_project_access(workspace_id,project_id,true)))
 with check(public.booking_actor_allowed(workspace_id,actor_id) and (project_id is null or public.crm_project_access(workspace_id,project_id,true)));
create policy personal_calendar_operation_actor on public.crm_personal_calendar_operations for all to novalure_tenant_app
 using(public.booking_actor_allowed(workspace_id,actor_id) and exists(select 1 from public.crm_personal_calendar_events e where e.workspace_id=crm_personal_calendar_operations.workspace_id and e.id=event_id and e.actor_id=crm_personal_calendar_operations.actor_id))
 with check(public.booking_actor_allowed(workspace_id,actor_id) and exists(select 1 from public.crm_personal_calendar_events e where e.workspace_id=crm_personal_calendar_operations.workspace_id and e.id=event_id and e.actor_id=crm_personal_calendar_operations.actor_id));
revoke all on public.crm_personal_calendar_events,public.crm_personal_calendar_operations from public,novalure_app,novalure_tenant_app;
grant select,insert,update on public.crm_personal_calendar_events,public.crm_personal_calendar_operations to novalure_tenant_app;
-- Personal provider content must not become team-visible through generic CRM lists.
create policy personal_calendar_private on public.calendar_events as restrictive for all to novalure_tenant_app
 using(coalesce(metadata->>'source','')<>'personal_standalone_calendar' or owner_user_id=nullif(current_setting('app.actor_id',true),'')::uuid)
 with check(coalesce(metadata->>'source','')<>'personal_standalone_calendar' or owner_user_id=nullif(current_setting('app.actor_id',true),'')::uuid);
create policy personal_calendar_owner_write on public.calendar_events for all to novalure_tenant_app
 using(metadata->>'source'='personal_standalone_calendar' and public.booking_actor_allowed(workspace_id,owner_user_id)
   and public.crm_classification_allowed(workspace_id,data_classification,data_purpose)
   and (project_id is null or public.crm_project_access(workspace_id,project_id,true)))
 with check(metadata->>'source'='personal_standalone_calendar' and public.booking_actor_allowed(workspace_id,owner_user_id)
   and public.crm_classification_allowed(workspace_id,data_classification,data_purpose)
   and (project_id is null or public.crm_project_access(workspace_id,project_id,true)));
create function public.crm_personal_calendar_identity_guard() returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
begin
 if old.metadata->>'source'='personal_standalone_calendar' and (
  new.metadata->>'source' is distinct from 'personal_standalone_calendar' or new.workspace_id is distinct from old.workspace_id or new.owner_user_id is distinct from old.owner_user_id or new.project_id is distinct from old.project_id
 ) then raise exception using errcode='42501',message='Personal calendar identity is immutable'; end if;
 return new;
end $$;
create trigger personal_calendar_identity_guard before update on public.calendar_events for each row execute function public.crm_personal_calendar_identity_guard();
create function public.crm_personal_calendar_mapping_guard() returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
begin
 if tg_op='INSERT' and not exists(select 1 from public.booking_calendar_connections c where c.workspace_id=new.workspace_id and c.user_id=new.actor_id and c.id=new.connection_id and c.provider=new.provider and c.status='connected' and c.revision=new.connection_revision and c.account_id=new.account_id and c.write_calendar_id=new.calendar_id) then
  raise exception using errcode='42501',message='Personal calendar provider binding denied';
 end if;
 if not exists(select 1 from public.calendar_events c where c.id=new.id and c.workspace_id=new.workspace_id and c.owner_user_id=new.actor_id and c.project_id is not distinct from new.project_id and c.metadata->>'source'='personal_standalone_calendar') then
  raise exception using errcode='42501',message='Personal calendar CRM binding denied';
 end if;
 if tg_op='UPDATE' and (new.workspace_id is distinct from old.workspace_id or new.actor_id is distinct from old.actor_id or new.provider is distinct from old.provider or new.connection_id is distinct from old.connection_id or new.account_id is distinct from old.account_id or new.calendar_id is distinct from old.calendar_id or new.connection_revision is distinct from old.connection_revision or new.project_id is distinct from old.project_id) then
  raise exception using errcode='42501',message='Personal calendar provider binding is immutable';
 end if;
 return new;
end $$;
create trigger personal_calendar_mapping_guard before insert or update on public.crm_personal_calendar_events for each row execute function public.crm_personal_calendar_mapping_guard();
revoke all on function public.crm_personal_calendar_identity_guard(),public.crm_personal_calendar_mapping_guard() from public;
grant execute on function public.crm_personal_calendar_identity_guard(),public.crm_personal_calendar_mapping_guard() to novalure_tenant_app;
-- Binding safety must survive loss of project visibility. This ledger contains
-- no title, project, participants or provider content and is private to its actor.
create table public.crm_personal_calendar_binding_locks (
 workspace_id uuid not null,actor_id uuid not null,event_id uuid primary key,connection_id uuid not null,
 state text not null,ends_at timestamptz not null,
 foreign key(workspace_id,event_id) references public.crm_personal_calendar_events(workspace_id,id),
 foreign key(workspace_id,actor_id,connection_id) references public.booking_calendar_connections(workspace_id,user_id,id)
);
alter table public.crm_personal_calendar_binding_locks enable row level security;
alter table public.crm_personal_calendar_binding_locks force row level security;
create policy personal_calendar_binding_actor on public.crm_personal_calendar_binding_locks for all to novalure_tenant_app
 using(public.booking_actor_allowed(workspace_id,actor_id)) with check(public.booking_actor_allowed(workspace_id,actor_id));
revoke all on public.crm_personal_calendar_binding_locks from public,novalure_app,novalure_tenant_app;
grant select,insert,update on public.crm_personal_calendar_binding_locks to novalure_tenant_app;
create function public.crm_personal_calendar_binding_lock_sync() returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
begin
 insert into public.crm_personal_calendar_binding_locks(workspace_id,actor_id,event_id,connection_id,state,ends_at)
 values(new.workspace_id,new.actor_id,new.id,new.connection_id,new.state,(new.event->>'endsAt')::timestamptz)
 on conflict(event_id) do update set state=excluded.state,ends_at=excluded.ends_at;
 return new;
end $$;
create trigger personal_calendar_binding_lock_sync after insert or update on public.crm_personal_calendar_events for each row execute function public.crm_personal_calendar_binding_lock_sync();
revoke all on function public.crm_personal_calendar_binding_lock_sync() from public;
grant execute on function public.crm_personal_calendar_binding_lock_sync() to novalure_tenant_app;
