-- Durable, tenant-qualified runtime state for Preview-only property exports.
--
-- This migration is intentionally additive. Existing export jobs remain
-- readable by the preceding application version; only jobs created by the new
-- runtime populate the new snapshot, provider and artifact columns.

set local lock_timeout = '5s';
set local statement_timeout = '14min';

alter table public.property_channels
  add column if not exists runtime_key text;

-- Widen the legacy channel status contract to the complete publication
-- lifecycle. Legacy `needs_review`/`error` values remain readable during the
-- expand phase; provider-backed success states still require a real receipt.
alter table public.property_channels
  drop constraint if exists property_channels_status_check;
alter table public.property_channels
  add constraint property_channels_status_check
  check (status in (
    'draft', 'preflight_failed', 'ready', 'queued', 'exporting', 'published',
    'partially_published', 'update_required', 'failed', 'paused', 'withdrawn',
    'needs_review', 'error'
  ));

alter table public.property_export_jobs
  add column if not exists operation text,
  add column if not exists provider_key text,
  add column if not exists payload_snapshot jsonb,
  add column if not exists payload_sha256 text,
  add column if not exists snapshot_captured_at timestamptz,
  add column if not exists artifact_payload text,
  add column if not exists artifact_sha256 text,
  add column if not exists artifact_content_type text,
  add column if not exists artifact_filename text,
  add column if not exists provider_request_id text,
  add column if not exists provider_acknowledged_at timestamptz,
  add column if not exists result_metadata jsonb not null default '{}';

do $migration$
begin
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.property_export_jobs'::regclass
      and conname = 'property_export_jobs_payload_sha256_check'
  ) then
    alter table public.property_export_jobs
      add constraint property_export_jobs_payload_sha256_check
      check (payload_sha256 is null or payload_sha256 ~ '^[0-9a-f]{64}$') not valid;
  end if;

  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.property_export_jobs'::regclass
      and conname = 'property_export_jobs_artifact_sha256_check'
  ) then
    alter table public.property_export_jobs
      add constraint property_export_jobs_artifact_sha256_check
      check (artifact_sha256 is null or artifact_sha256 ~ '^[0-9a-f]{64}$') not valid;
  end if;

  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.property_export_jobs'::regclass
      and conname = 'property_export_jobs_runtime_shape_check'
  ) then
    alter table public.property_export_jobs
      add constraint property_export_jobs_runtime_shape_check
      check (
        operation is distinct from 'qa_test_export'
        or (
          operation = 'qa_test_export'
          and provider_key = 'novalure_qa_sink'
          and payload_snapshot is not null
          and payload_sha256 is not null
          and snapshot_captured_at is not null
        )
      ) not valid;
  end if;
end;
$migration$;

create unique index if not exists property_channels_runtime_key_uidx
  on public.property_channels(workspace_id, runtime_key)
  where runtime_key is not null;

create unique index if not exists property_channels_workspace_id_id_uidx
  on public.property_channels(workspace_id, id);

create unique index if not exists property_export_jobs_workspace_id_id_uidx
  on public.property_export_jobs(workspace_id, id);

create unique index if not exists property_export_jobs_provider_request_uidx
  on public.property_export_jobs(workspace_id, provider_key, provider_request_id)
  where provider_key is not null and provider_request_id is not null;

create index if not exists property_export_jobs_property_history_idx
  on public.property_export_jobs(workspace_id, property_id, created_at desc, id desc)
  where property_id is not null;

create table if not exists public.property_export_job_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  job_id uuid not null,
  actor_user_id uuid,
  event_type text not null,
  from_status text,
  to_status text not null,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  request_key text,
  message text,
  metadata jsonb not null default '{}',
  occurred_at timestamptz not null default now()
);

create index if not exists property_export_job_events_history_idx
  on public.property_export_job_events(workspace_id, job_id, occurred_at desc, id desc);

create unique index if not exists property_export_job_events_request_uidx
  on public.property_export_job_events(workspace_id, job_id, request_key)
  where request_key is not null;

-- Parent tables predate this migration and also serve legacy queue paths. RLS
-- is enabled without FORCE so the existing owner-run Preview scanner remains
-- operational until the coordinated migration-061 application-role cutover.
-- New runtime rows are fail-closed for every non-owner database role.
do $migration$
begin
  if exists (
    select 1
    from pg_catalog.pg_policies
    where schemaname = 'public'
      and tablename in ('property_channels', 'property_export_jobs')
      and policyname not in ('property_channels_runtime_tenant_policy', 'property_export_jobs_runtime_tenant_policy')
  ) then
    raise exception using
      errcode = '55000',
      message = 'migration 080 requires the parent-table RLS cutover to remain separate';
  end if;
  if exists (
    select 1
    from pg_catalog.pg_class parent_table
    where parent_table.oid in ('public.property_channels'::regclass, 'public.property_export_jobs'::regclass)
      and parent_table.relrowsecurity
      and not exists (
        select 1
        from pg_catalog.pg_policies existing_policy
        where existing_policy.schemaname = 'public'
          and existing_policy.tablename = parent_table.relname
          and existing_policy.policyname in ('property_channels_runtime_tenant_policy', 'property_export_jobs_runtime_tenant_policy')
      )
  ) then
    raise exception using
      errcode = '55000',
      message = 'migration 080 refuses to replace pre-existing parent-table RLS state';
  end if;
end;
$migration$;

alter table public.property_channels enable row level security;
drop policy if exists property_channels_runtime_tenant_policy on public.property_channels;
create policy property_channels_runtime_tenant_policy on public.property_channels
  for all
  using (
    (
      runtime_key is null
      and (
        nullif(current_setting('app.tenant_id', true), '') is null
        or workspace_id = nullif(current_setting('app.tenant_id', true), '')::uuid
      )
    )
    or (
      runtime_key is not null
      and
      workspace_id = nullif(current_setting('app.tenant_id', true), '')::uuid
      and nullif(current_setting('app.actor_id', true), '')::uuid is not null
    )
  )
  with check (
    (
      runtime_key is null
      and (
        nullif(current_setting('app.tenant_id', true), '') is null
        or workspace_id = nullif(current_setting('app.tenant_id', true), '')::uuid
      )
    )
    or (
      runtime_key is not null
      and
      workspace_id = nullif(current_setting('app.tenant_id', true), '')::uuid
      and nullif(current_setting('app.actor_id', true), '')::uuid is not null
    )
  );

alter table public.property_export_jobs enable row level security;
drop policy if exists property_export_jobs_runtime_tenant_policy on public.property_export_jobs;
create policy property_export_jobs_runtime_tenant_policy on public.property_export_jobs
  for all
  using (
    (
      operation is distinct from 'qa_test_export'
      and (
        nullif(current_setting('app.tenant_id', true), '') is null
        or workspace_id = nullif(current_setting('app.tenant_id', true), '')::uuid
      )
    )
    or (
      operation = 'qa_test_export'
      and
      workspace_id = nullif(current_setting('app.tenant_id', true), '')::uuid
      and nullif(current_setting('app.actor_id', true), '')::uuid is not null
    )
  )
  with check (
    (
      operation is distinct from 'qa_test_export'
      and (
        nullif(current_setting('app.tenant_id', true), '') is null
        or workspace_id = nullif(current_setting('app.tenant_id', true), '')::uuid
      )
    )
    or (
      operation = 'qa_test_export'
      and
      workspace_id = nullif(current_setting('app.tenant_id', true), '')::uuid
      and nullif(current_setting('app.actor_id', true), '')::uuid is not null
    )
  );

alter table public.property_export_job_events enable row level security;
alter table public.property_export_job_events force row level security;

revoke all on table public.property_export_job_events from public;

do $migration$
declare
  app_role text;
begin
  foreach app_role in array array['novalure_app', 'novalure_tenant_app']
  loop
    if exists (select 1 from pg_catalog.pg_roles where rolname = app_role) then
      if not exists (
        select 1 from pg_catalog.pg_policies
        where schemaname = 'public'
          and tablename = 'property_export_job_events'
          and policyname = 'property_export_job_events_' || app_role || '_select'
      ) then
        execute format(
          $policy$
            create policy %I on public.property_export_job_events
            for select to %I
            using (
              workspace_id = nullif(current_setting('app.tenant_id', true), '')::uuid
              and nullif(current_setting('app.actor_id', true), '')::uuid is not null
            )
          $policy$,
          'property_export_job_events_' || app_role || '_select',
          app_role
        );
      end if;

      if not exists (
        select 1 from pg_catalog.pg_policies
        where schemaname = 'public'
          and tablename = 'property_export_job_events'
          and policyname = 'property_export_job_events_' || app_role || '_insert'
      ) then
        execute format(
          $policy$
            create policy %I on public.property_export_job_events
            for insert to %I
            with check (
              workspace_id = nullif(current_setting('app.tenant_id', true), '')::uuid
              and actor_user_id = nullif(current_setting('app.actor_id', true), '')::uuid
            )
          $policy$,
          'property_export_job_events_' || app_role || '_insert',
          app_role
        );
      end if;
    end if;
  end loop;
end;
$migration$;

-- The parent pairs already have UUID primary keys. These workspace-leading
-- indexes are data-compatible composite-FK targets and keep tenant checks
-- bounded.
create unique index if not exists projects_workspace_id_id_uidx
  on public.projects(workspace_id, id);
create unique index if not exists seller_listings_workspace_id_id_uidx
  on public.seller_listings(workspace_id, id);
create unique index if not exists property_units_workspace_id_id_uidx
  on public.property_units(workspace_id, id);
create unique index if not exists workspace_users_workspace_id_id_uidx
  on public.workspace_users(workspace_id, id);

-- NOT VALID preserves deployability with historical data while enforcing
-- tenant consistency for every new or changed runtime relation.
do $migration$
declare
  tenant_fk record;
begin
  for tenant_fk in
    select *
    from (values
      ('property_channels', 'property_channels_workspace_project_fk',
        'foreign key (workspace_id, project_id) references public.projects(workspace_id, id) deferrable initially deferred not valid'),
      ('property_channels', 'property_channels_workspace_property_fk',
        'foreign key (workspace_id, property_id) references public.seller_listings(workspace_id, id) deferrable initially deferred not valid'),
      ('property_channels', 'property_channels_workspace_unit_fk',
        'foreign key (workspace_id, unit_id) references public.property_units(workspace_id, id) deferrable initially deferred not valid'),
      ('property_export_jobs', 'property_export_jobs_workspace_channel_fk',
        'foreign key (workspace_id, property_channel_id) references public.property_channels(workspace_id, id) deferrable initially deferred not valid'),
      ('property_export_jobs', 'property_export_jobs_workspace_project_fk',
        'foreign key (workspace_id, project_id) references public.projects(workspace_id, id) deferrable initially deferred not valid'),
      ('property_export_jobs', 'property_export_jobs_workspace_property_fk',
        'foreign key (workspace_id, property_id) references public.seller_listings(workspace_id, id) deferrable initially deferred not valid'),
      ('property_export_jobs', 'property_export_jobs_workspace_unit_fk',
        'foreign key (workspace_id, unit_id) references public.property_units(workspace_id, id) deferrable initially deferred not valid'),
      ('property_export_jobs', 'property_export_jobs_workspace_starter_fk',
        'foreign key (workspace_id, started_by_user_id) references public.workspace_users(workspace_id, id) on delete set null (started_by_user_id) deferrable initially deferred not valid'),
      ('property_channels', 'property_channels_workspace_last_export_fk',
        'foreign key (workspace_id, last_export_job_id) references public.property_export_jobs(workspace_id, id) on delete set null (last_export_job_id) deferrable initially deferred not valid'),
      ('property_export_job_events', 'property_export_job_events_workspace_job_fk',
        'foreign key (workspace_id, job_id) references public.property_export_jobs(workspace_id, id) on delete cascade deferrable initially deferred not valid'),
      ('property_export_job_events', 'property_export_job_events_workspace_actor_fk',
        'foreign key (workspace_id, actor_user_id) references public.workspace_users(workspace_id, id) on delete set null (actor_user_id) deferrable initially deferred not valid')
    ) as definitions(table_name, constraint_name, definition)
  loop
    if not exists (
      select 1
      from pg_catalog.pg_constraint
      where conname = tenant_fk.constraint_name
        and conrelid = ('public.' || tenant_fk.table_name)::regclass
    ) then
      execute format(
        'alter table public.%I add constraint %I %s',
        tenant_fk.table_name,
        tenant_fk.constraint_name,
        tenant_fk.definition
      );
    end if;
  end loop;
end;
$migration$;

do $migration$
begin
  if exists (select 1 from pg_roles where rolname = 'novalure_app') then
    grant select, insert on table public.property_export_job_events to novalure_app;
  end if;

  if exists (select 1 from pg_roles where rolname = 'novalure_tenant_app') then
    grant select, insert on table public.property_export_job_events to novalure_tenant_app;
  end if;
end;
$migration$;

comment on table public.property_export_job_events is
  'RLS-protected append-only application lifecycle evidence for tenant-scoped property export jobs.';
comment on column public.property_export_jobs.artifact_payload is
  'Protected Preview QA artifact; never a public portal URL or publication acknowledgement.';
