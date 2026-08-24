-- Public Funnel visit truth.
--
-- The public runtime persists only an opaque, keyed visit hash. A dedicated,
-- tenant-qualified identity table is the concurrency-safe idempotency anchor
-- for one browser visit within one exact publication revision. Creating this
-- empty table avoids a blocking index build over the existing analytics event
-- history during cutover.

set local lock_timeout = '5s';
set local statement_timeout = '14min';

do $migration$
begin
  if not exists (
    select 1
    from pg_catalog.pg_constraint
    where conrelid = 'public.funnel_steps'::regclass
      and conname = 'funnel_steps_workspace_funnel_fk'
      and convalidated
  ) then
    raise exception 'migration 074_validate_launch_tenant_relation_guards is required before 075';
  end if;
end;
$migration$;

create table if not exists public.public_funnel_visit_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  funnel_id uuid not null,
  publication_revision bigint not null,
  visit_id_hash text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '90 days'),
  constraint public_funnel_visit_events_scope_key
    unique (workspace_id, funnel_id, publication_revision, visit_id_hash),
  constraint public_funnel_visit_events_revision_check
    check (publication_revision >= 0),
  constraint public_funnel_visit_events_hash_check
    check (visit_id_hash ~ '^[a-f0-9]{64}$'),
  constraint public_funnel_visit_events_expiry_check
    check (expires_at > created_at),
  constraint public_funnel_visit_events_funnel_fk
    foreign key (workspace_id, funnel_id)
    references public.funnels(workspace_id, id)
    on delete cascade
);

create index if not exists public_funnel_visit_events_expiry_idx
  on public.public_funnel_visit_events (expires_at, id);

revoke all on table public.public_funnel_visit_events from public;

grant select, insert, delete on table public.public_funnel_visit_events
  to novalure_tenant_app;

do $migration$
begin
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'novalure_app') then
    grant select, insert, delete on table public.public_funnel_visit_events to novalure_app;
  end if;
end;
$migration$;

comment on table public.public_funnel_visit_events is
  'Opaque idempotency identities for public Funnel visits, scoped by tenant, Funnel and publication revision; eligible for deletion after 90 days. LAUNCH-OFF until an independently scheduled and monitored deletion job is approved.';
