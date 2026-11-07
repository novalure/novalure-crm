-- Staged only. Apply after shared_behavior_foundation.sql in an isolated target.
set local lock_timeout='5s';
set local statement_timeout='2min';
do $guard$
begin
 if to_regclass('public.behavior_release_head') is null then raise exception 'Behavior foundation required'; end if;
 if not exists(select 1 from pg_roles where rolname='novalure_behavior_publisher') then
  create role novalure_behavior_publisher nologin nosuperuser nobypassrls nocreatedb nocreaterole noreplication;
 end if;
 if exists(select 1 from pg_roles where rolname='novalure_behavior_publisher' and
   (rolcanlogin or rolsuper or rolbypassrls or rolcreatedb or rolcreaterole or rolreplication))
   or pg_has_role('novalure_tenant_app','novalure_behavior_publisher','MEMBER')
   or pg_has_role('novalure_app','novalure_behavior_publisher','MEMBER')
   or pg_has_role('novalure_behavior_publisher','novalure_tenant_app','MEMBER')
   or pg_has_role('novalure_behavior_publisher','novalure_app','MEMBER') then
  raise exception 'Unsafe behavior publisher role';
 end if;
end $guard$;
alter table public.behavior_release_head alter column version drop not null;
grant usage on schema public to novalure_behavior_publisher;
create table public.behavior_candidates (like public.behavior_releases including constraints);
alter table public.behavior_candidates drop column version;
alter table public.behavior_candidates add column id uuid primary key;
alter table public.behavior_candidates add column baseline_revision integer not null check(baseline_revision>=0);
create trigger behavior_candidate_immutable before insert or update or delete on public.behavior_candidates
 for each row execute function public.behavior_release_immutable_guard();
create table public.behavior_evaluations (
 candidate_id uuid primary key references public.behavior_candidates(id),
 evaluator_digest text not null check(evaluator_digest ~ '^[0-9a-f]{64}$'),
 selection_digest text not null check(selection_digest ~ '^[0-9a-f]{64}$'),
 checks integer not null check(checks=30), improvements integer not null check(improvements between 0 and 30),
 regressions integer not null check(regressions between 0 and 30),
 passed boolean not null check(passed=(regressions=0 and improvements>0))
);
create table public.behavior_publication_events (
 revision integer primary key check(revision>0), action text not null check(action in ('publish','rollback')),
 candidate_id uuid references public.behavior_candidates(id),
 version integer references public.behavior_releases(version),
 check((action='publish')=(candidate_id is not null))
);
create function public.behavior_history_immutable() returns trigger language plpgsql
 security invoker set search_path=pg_catalog,public as $$
begin raise exception using errcode='23514',message='Behavior history is append only'; end $$;
revoke all on function public.behavior_history_immutable() from public;
create trigger behavior_evaluation_immutable before update or delete on public.behavior_evaluations for each row execute function public.behavior_history_immutable();
create trigger behavior_event_immutable before update or delete on public.behavior_publication_events for each row execute function public.behavior_history_immutable();
do $policies$
declare relation text;
begin
 foreach relation in array array['behavior_candidates','behavior_evaluations','behavior_publication_events','behavior_releases','behavior_release_head'] loop
  execute format('alter table public.%I enable row level security',relation);
  execute format('alter table public.%I force row level security',relation);
  execute format('create policy behavior_publisher on public.%I for all to novalure_behavior_publisher using(true) with check(true)',relation);
  execute format('revoke all on public.%I from public',relation);
 end loop;
end $policies$;
revoke all on public.behavior_candidates,public.behavior_evaluations,public.behavior_publication_events from novalure_app,novalure_tenant_app;
grant select,insert on public.behavior_candidates,public.behavior_evaluations,public.behavior_publication_events,public.behavior_releases to novalure_behavior_publisher;
grant select,insert,update on public.behavior_release_head to novalure_behavior_publisher;
-- No login, tenant membership, knowledge access or runtime credential is granted.
