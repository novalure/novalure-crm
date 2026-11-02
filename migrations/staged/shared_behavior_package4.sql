-- Explicit manual cutover only, after verified119. Never selected by ordinary up.
-- No guessed retention period and no new schedule or credential.
set local lock_timeout='5s';
set local statement_timeout='2min';
-- Existing FORCE-RLS actor policy continues to restrict DELETE to the active actor.
grant delete on public.behavior_learning_signals to novalure_tenant_app;

create table public.behavior_learning_runs (
 run_id uuid primary key,
 slot timestamptz not null unique,
 status text not null check(status in ('running','published','rejected','failed')),
 started_at timestamptz not null default now(),
 completed_at timestamptz,
 check((status='running')=(completed_at is null))
);
alter table public.behavior_learning_runs enable row level security;
alter table public.behavior_learning_runs force row level security;
revoke all on public.behavior_learning_runs from public,novalure_app,novalure_tenant_app;
create policy behavior_publisher on public.behavior_learning_runs for all to novalure_behavior_publisher using(true) with check(true);
grant select,insert,update on public.behavior_learning_runs to novalure_behavior_publisher;
create function public.behavior_learning_run_guard() returns trigger language plpgsql
 security invoker set search_path=pg_catalog,public as $$
begin
 if old.status<>'running' or new.status='running'
   or new.run_id is distinct from old.run_id or new.slot is distinct from old.slot
   or new.started_at is distinct from old.started_at then
   raise exception using errcode='23514',message='Learning run identity and completed receipts are immutable';
 end if;
 return new;
end $$;
revoke all on function public.behavior_learning_run_guard() from public;
create trigger behavior_learning_run_transition before update on public.behavior_learning_runs
 for each row execute function public.behavior_learning_run_guard();
-- Publisher still cannot read private evidence. Immutable releases and publication history retain all guards.
