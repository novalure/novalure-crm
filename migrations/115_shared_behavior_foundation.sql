-- Deliberately staged: not selected by the numbered migration runner.
-- Reserve a migration number and integrate with the current production predecessor
-- before rollout. This package neither publishes a release nor grants a publisher.
set local lock_timeout = '5s';
set local statement_timeout = '2min';

do $guard$
begin
 if to_regclass('public.workspace_users') is null or
    not exists(select 1 from pg_roles where rolname='novalure_tenant_app') then
   raise exception 'Shared behavior requires the existing tenant membership boundary';
 end if;
end $guard$;

create table public.behavior_learning_signals (
 workspace_id uuid not null references public.workspaces(id),
 actor_id uuid not null,
 event_id uuid not null,
 issue text not null check(issue in ('unclear_goal','misunderstood_correction','missed_topic_switch','language_mismatch','handoff_confusion','unclear_next_step')),
 outcome text not null check(outcome in ('pass','fail')),
 created_at timestamptz not null default now(),
 primary key(workspace_id,actor_id,event_id),
 foreign key(workspace_id,actor_id) references public.workspace_users(workspace_id,id)
);
create index behavior_learning_recent_idx on public.behavior_learning_signals(workspace_id,actor_id,created_at) where outcome='fail';

-- No customer identifiers, free text, JSON, URLs, summaries or provenance columns
-- may be added to the shared selection. Wording lives in the reviewed catalog.
create table public.behavior_releases (
 version integer primary key check(version>0),
 rule_ids text[] not null check(
   cardinality(rule_ids) between 1 and 6 and array_ndims(rule_ids)=1 and array_lower(rule_ids,1)=1
   and array_position(rule_ids,null) is null
   and rule_ids <@ array['clarify-goal','repair-understanding','follow-topic-switch','match-language','offer-human-handoff','confirm-next-step']::text[]),
 targets text[] not null check(
   cardinality(targets) between 1 and 5 and array_ndims(targets)=1 and array_lower(targets,1)=1
   and array_position(targets,null) is null
   and targets <@ array['ceo','department','webchat','agent','telephony']::text[])
);
create table public.behavior_release_head (
 singleton boolean primary key default true check(singleton),
 version integer not null references public.behavior_releases(version),
 revision integer not null default 1 check(revision>0)
);

create function public.behavior_release_immutable_guard() returns trigger
 language plpgsql security invoker set search_path=pg_catalog,public as $function$
begin
 if tg_op<>'INSERT' then raise exception using errcode='23514',message='Behavior releases are immutable; move the head for rollback'; end if;
 if cardinality(new.rule_ids)<>(select count(distinct item) from unnest(new.rule_ids) item)
   or cardinality(new.targets)<>(select count(distinct item) from unnest(new.targets) item) then
   raise exception using errcode='23514',message='Behavior selection IDs must be unique';
 end if;
 return new;
end
$function$;
revoke all on function public.behavior_release_immutable_guard() from public;
create trigger behavior_release_immutable before insert or update or delete on public.behavior_releases
 for each row execute function public.behavior_release_immutable_guard();

alter table public.behavior_learning_signals enable row level security;
alter table public.behavior_learning_signals force row level security;
create policy behavior_private_actor on public.behavior_learning_signals for all to novalure_tenant_app
 using(workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid
   and actor_id=nullif(current_setting('app.actor_id',true),'')::uuid
   and exists(select 1 from public.workspace_users u where u.workspace_id=behavior_learning_signals.workspace_id
     and u.id=behavior_learning_signals.actor_id and u.status='active'))
 with check(workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid
   and actor_id=nullif(current_setting('app.actor_id',true),'')::uuid
   and exists(select 1 from public.workspace_users u where u.workspace_id=behavior_learning_signals.workspace_id
     and u.id=behavior_learning_signals.actor_id and u.status='active' and u.role in ('owner','admin','agent')));

alter table public.behavior_release_head enable row level security;
alter table public.behavior_release_head force row level security;
alter table public.behavior_releases enable row level security;
alter table public.behavior_releases force row level security;
create policy behavior_head_read on public.behavior_release_head for select to novalure_tenant_app
 using(exists(select 1 from public.workspace_users u
   where u.workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid
     and u.id=nullif(current_setting('app.actor_id',true),'')::uuid and u.status='active'));
create policy behavior_release_read on public.behavior_releases for select to novalure_tenant_app
 using(exists(select 1 from public.behavior_release_head h where h.version=behavior_releases.version));

revoke all on public.behavior_learning_signals,public.behavior_releases,public.behavior_release_head from public;
revoke all on public.behavior_learning_signals,public.behavior_releases,public.behavior_release_head from novalure_app,novalure_tenant_app;
grant select,insert on public.behavior_learning_signals to novalure_tenant_app;
grant select on public.behavior_releases,public.behavior_release_head to novalure_tenant_app;
-- No runtime UPDATE/DELETE, shared INSERT, publisher role, SECURITY DEFINER
-- function or RLS bypass. A dedicated evaluated publisher is a later package.
