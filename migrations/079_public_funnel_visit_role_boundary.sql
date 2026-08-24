-- Remove direct tenant-role access to the public Funnel visit truth table.
-- Public visit writes are global ingress operations that validate a signed,
-- tenant-qualified proof before the repository supplies the workspace id.

set local lock_timeout = '5s';
set local statement_timeout = '14min';

do $migration$
begin
  if to_regclass('public.public_funnel_visit_events') is null then
    raise exception 'migration 075_public_funnel_visit_truth is required before 079';
  end if;
  if not exists (
    select 1
    from public.novalure_schema_migrations
    where version = '075_public_funnel_visit_truth'
  ) then
    raise exception 'checksummed migration 075_public_funnel_visit_truth is required before 079';
  end if;
  if not exists (
    select 1
    from pg_catalog.pg_roles
    where rolname = 'novalure_tenant_app'
  ) then
    raise exception 'novalure_tenant_app is required before 079';
  end if;
end;
$migration$;

revoke all on table public.public_funnel_visit_events
  from public, novalure_tenant_app;

do $migration$
begin
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'novalure_app') then
    grant select, insert, delete on table public.public_funnel_visit_events to novalure_app;
  end if;
end;
$migration$;

comment on table public.public_funnel_visit_events is
  'Opaque signed-proof identities for public Funnel visits, scoped by tenant, Funnel and publication revision; the unfiltered tenant role has no access; eligible for deletion after 90 days. LAUNCH-OFF until an independently scheduled and monitored deletion job is approved.';
