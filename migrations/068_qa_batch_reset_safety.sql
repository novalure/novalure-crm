-- DB-01: fail-closed QA tenant identity, append-only batch ledger and reset audit.
--
-- This migration does not create QA tenants, mark any existing tenant as QA,
-- register test objects, or execute a reset. Those remain explicit, approved
-- provisioning/runtime actions. Existing workspaces default to non-QA.

set local lock_timeout = '5s';
set local statement_timeout = '14min';

alter table workspaces
  add column if not exists is_qa boolean not null default false;

create index if not exists workspaces_qa_id_idx
  on workspaces(id)
  where is_qa = true;

comment on column workspaces.is_qa is
  'Explicit QA safety boundary. Existing and newly-created workspaces are non-QA unless deliberately provisioned otherwise.';

create table if not exists qa_batches (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete restrict,
  batch_marker text not null,
  created_by_user_id uuid not null,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  constraint qa_batches_marker_check
    check (batch_marker ~ '^QA-TEST-[0-9]{8}-[0-9]{4}-[A-Za-z0-9][A-Za-z0-9_-]{5,31}$'),
  constraint qa_batches_metadata_object_check
    check (jsonb_typeof(metadata) = 'object'),
  unique (workspace_id, batch_marker),
  unique (workspace_id, id)
);

create table if not exists qa_batch_objects (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  batch_id uuid not null,
  resource_scope text not null,
  resource_type text not null,
  resource_id text not null,
  created_by_user_id uuid not null,
  metadata jsonb not null default '{}',
  registered_at timestamptz not null default now(),
  constraint qa_batch_objects_batch_workspace_fk
    foreign key (workspace_id, batch_id)
    references qa_batches(workspace_id, id)
    on delete restrict,
  constraint qa_batch_objects_scope_check
    check (resource_scope in ('database', 'blob', 'provider')),
  constraint qa_batch_objects_type_check
    check (resource_type ~ '^[a-z][a-z0-9_.:-]{0,99}$'),
  constraint qa_batch_objects_id_check
    check (
      btrim(resource_id) <> ''
      and length(resource_id) <= 512
      and (
        resource_scope <> 'database'
        or resource_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      )
    ),
  constraint qa_batch_objects_metadata_object_check
    check (jsonb_typeof(metadata) = 'object'),
  unique (resource_scope, resource_type, resource_id)
);

create table if not exists qa_reset_audit_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  batch_id uuid not null,
  actor_user_id uuid not null,
  mode text not null,
  outcome text not null,
  plan_digest text not null,
  target_counts jsonb not null,
  target_manifest jsonb not null,
  blocker_codes text[] not null default '{}',
  deleted_counts jsonb not null default '{}',
  occurred_at timestamptz not null default now(),
  constraint qa_reset_audit_batch_workspace_fk
    foreign key (workspace_id, batch_id)
    references qa_batches(workspace_id, id)
    on delete restrict,
  constraint qa_reset_audit_mode_check check (mode in ('dry_run', 'execute')),
  constraint qa_reset_audit_outcome_check check (outcome in ('blocked', 'dry_run', 'executed')),
  constraint qa_reset_audit_digest_check check (plan_digest ~ '^[a-f0-9]{64}$'),
  constraint qa_reset_audit_target_counts_object_check check (jsonb_typeof(target_counts) = 'object'),
  constraint qa_reset_audit_target_manifest_object_check check (jsonb_typeof(target_manifest) = 'object'),
  constraint qa_reset_audit_deleted_counts_object_check check (jsonb_typeof(deleted_counts) = 'object'),
  constraint qa_reset_audit_execution_counts_check
    check (
      (outcome = 'executed' and mode = 'execute')
      or (outcome = 'dry_run' and mode = 'dry_run' and deleted_counts = '{}'::jsonb)
      or (outcome = 'blocked' and deleted_counts = '{}'::jsonb)
    )
);

create index if not exists qa_batches_workspace_created_idx
  on qa_batches(workspace_id, created_at desc);

create index if not exists qa_batch_objects_batch_scope_idx
  on qa_batch_objects(workspace_id, batch_id, resource_scope, resource_type, registered_at);

create index if not exists qa_reset_audit_workspace_time_idx
  on qa_reset_audit_events(workspace_id, occurred_at desc);

create index if not exists qa_reset_audit_batch_time_idx
  on qa_reset_audit_events(batch_id, occurred_at desc);

create or replace function public.require_qa_batch_workspace()
returns trigger
language plpgsql
set search_path = pg_catalog, public, pg_temp
as $function$
begin
  perform 1
  from public.workspaces
  where id = new.workspace_id
    and is_qa = true
  for key share;

  if not found then
    raise exception using
      errcode = '42501',
      message = 'qa_batches requires an explicitly marked QA workspace';
  end if;
  return new;
end;
$function$;

drop trigger if exists qa_batches_require_qa_workspace on qa_batches;
create trigger qa_batches_require_qa_workspace
before insert on qa_batches
for each row execute function public.require_qa_batch_workspace();

create or replace function public.reject_qa_ledger_mutation()
returns trigger
language plpgsql
set search_path = pg_catalog, public, pg_temp
as $function$
begin
  raise exception using
    errcode = '55000',
    message = 'QA batch, object and reset-audit ledgers are append-only';
end;
$function$;

drop trigger if exists qa_batches_append_only_guard on qa_batches;
create trigger qa_batches_append_only_guard
before update or delete or truncate on qa_batches
for each statement execute function public.reject_qa_ledger_mutation();

drop trigger if exists qa_batch_objects_append_only_guard on qa_batch_objects;
create trigger qa_batch_objects_append_only_guard
before update or delete or truncate on qa_batch_objects
for each statement execute function public.reject_qa_ledger_mutation();

drop trigger if exists qa_reset_audit_append_only_guard on qa_reset_audit_events;
create trigger qa_reset_audit_append_only_guard
before update or delete or truncate on qa_reset_audit_events
for each statement execute function public.reject_qa_ledger_mutation();

-- audit_logs is already append-only. Project/deal UUIDs therefore must remain
-- immutable snapshots, not live FKs whose ON DELETE action would mutate the
-- audit row or block a legitimate QA graph cleanup. Columns and indexes remain.
alter table audit_logs
  drop constraint if exists audit_logs_project_id_fkey,
  drop constraint if exists audit_logs_deal_id_fkey,
  drop constraint if exists audit_logs_workspace_project_fk,
  drop constraint if exists audit_logs_workspace_deal_fk;

comment on column audit_logs.project_id is
  'Immutable project UUID snapshot; intentionally not a live FK because audit_logs is append-only.';

comment on column audit_logs.deal_id is
  'Immutable deal UUID snapshot; intentionally not a live FK because audit_logs is append-only.';

do $migration$
begin
  if not exists (
    select 1
    from pg_roles
    where rolname = 'novalure_tenant_app'
      and not rolcanlogin
      and not rolsuper
      and not rolcreatedb
      and not rolcreaterole
      and not rolreplication
      and not rolbypassrls
  ) then
    raise exception using
      errcode = '42501',
      message = 'safe novalure_tenant_app role is required before QA reset migration';
  end if;
end;
$migration$;

revoke all on table qa_batches, qa_batch_objects, qa_reset_audit_events from public;
revoke all on function public.require_qa_batch_workspace() from public;
revoke all on function public.reject_qa_ledger_mutation() from public;

grant select, insert on table qa_batches, qa_batch_objects, qa_reset_audit_events
  to novalure_tenant_app;

do $migration$
begin
  if exists (select 1 from pg_roles where rolname = 'novalure_app') then
    grant select, insert on table qa_batches, qa_batch_objects, qa_reset_audit_events to novalure_app;
  end if;
end;
$migration$;

create policy qa_batches_tenant_select_policy on qa_batches
  for select
  to novalure_tenant_app
  using (
    workspace_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    and nullif(current_setting('app.actor_id', true), '')::uuid is not null
  );

create policy qa_batches_tenant_insert_policy on qa_batches
  for insert
  to novalure_tenant_app
  with check (
    workspace_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    and created_by_user_id = nullif(current_setting('app.actor_id', true), '')::uuid
  );

create policy qa_batch_objects_tenant_select_policy on qa_batch_objects
  for select
  to novalure_tenant_app
  using (
    workspace_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    and nullif(current_setting('app.actor_id', true), '')::uuid is not null
  );

create policy qa_batch_objects_tenant_insert_policy on qa_batch_objects
  for insert
  to novalure_tenant_app
  with check (
    workspace_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    and created_by_user_id = nullif(current_setting('app.actor_id', true), '')::uuid
  );

create policy qa_reset_audit_tenant_select_policy on qa_reset_audit_events
  for select
  to novalure_tenant_app
  using (
    workspace_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    and nullif(current_setting('app.actor_id', true), '')::uuid is not null
  );

create policy qa_reset_audit_tenant_insert_policy on qa_reset_audit_events
  for insert
  to novalure_tenant_app
  with check (
    workspace_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    and actor_user_id = nullif(current_setting('app.actor_id', true), '')::uuid
  );

alter table qa_batches enable row level security;
alter table qa_batches force row level security;
alter table qa_batch_objects enable row level security;
alter table qa_batch_objects force row level security;
alter table qa_reset_audit_events enable row level security;
alter table qa_reset_audit_events force row level security;

comment on table qa_batches is
  'Append-only registry for QA-TEST batches in explicitly marked QA workspaces.';

comment on table qa_batch_objects is
  'Append-only exact-id ledger. Runtime reset code accepts only fixed allowlisted database types and blocks external targets without cleanup adapters.';

comment on table qa_reset_audit_events is
  'Append-only dry-run, blocked and executed QA reset evidence including deterministic exact-target manifests.';
