-- Additive list-productivity controls. This extends the existing bulk runtime
-- ledger instead of introducing a second batch source of truth.

set local lock_timeout = '5s';
set local statement_timeout = '14min';

alter table seller_listings
  add column if not exists metadata jsonb not null default '{}';

create table if not exists crm_saved_views (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  project_id uuid,
  owner_user_id uuid not null,
  entity_type text not null,
  name text not null,
  query_state jsonb not null default '{}',
  column_state jsonb not null default '[]',
  is_shared boolean not null default false,
  row_version integer not null default 1 check (row_version > 0),
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint crm_saved_views_workspace_project_fk
    foreign key (workspace_id, project_id)
    references projects(workspace_id, id)
    deferrable initially deferred,
  constraint crm_saved_views_workspace_owner_fk
    foreign key (workspace_id, owner_user_id)
    references workspace_users(workspace_id, id)
    deferrable initially deferred,
  constraint crm_saved_views_entity_type_check
    check (entity_type in ('contact', 'organization', 'lead', 'property', 'unit', 'project', 'deal', 'task', 'document', 'template', 'closing'))
);

create unique index if not exists crm_saved_views_owner_name_uidx
  on crm_saved_views(workspace_id, owner_user_id, entity_type, lower(name))
  where archived_at is null;
create index if not exists crm_saved_views_workspace_entity_idx
  on crm_saved_views(workspace_id, entity_type, updated_at desc)
  where archived_at is null;

create table if not exists crm_recent_records (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  user_id uuid not null,
  project_id uuid,
  entity_type text not null,
  entity_id uuid not null,
  label text not null,
  href text not null,
  opened_at timestamptz not null default now(),
  primary key (workspace_id, user_id, entity_type, entity_id),
  constraint crm_recent_records_workspace_user_fk
    foreign key (workspace_id, user_id)
    references workspace_users(workspace_id, id)
    deferrable initially deferred,
  constraint crm_recent_records_workspace_project_fk
    foreign key (workspace_id, project_id)
    references projects(workspace_id, id)
    deferrable initially deferred,
  constraint crm_recent_records_entity_type_check
    check (entity_type in ('contact', 'organization', 'lead', 'property', 'unit', 'project', 'deal', 'task', 'document', 'template', 'closing')),
  constraint crm_recent_records_href_check
    check (href ~ '^/[A-Za-z0-9_?&=#%:./-]{1,1000}$')
);

create index if not exists crm_recent_records_user_opened_idx
  on crm_recent_records(workspace_id, user_id, opened_at desc);

alter table crm_saved_views enable row level security;
alter table crm_saved_views force row level security;
drop policy if exists crm_saved_views_select_policy on crm_saved_views;
create policy crm_saved_views_select_policy on crm_saved_views
  for select
  using (
    workspace_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    and nullif(current_setting('app.actor_id', true), '')::uuid is not null
    and (
      owner_user_id = nullif(current_setting('app.actor_id', true), '')::uuid
      or is_shared = true
    )
  );
drop policy if exists crm_saved_views_insert_policy on crm_saved_views;
create policy crm_saved_views_insert_policy on crm_saved_views
  for insert
  with check (
    workspace_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    and owner_user_id = nullif(current_setting('app.actor_id', true), '')::uuid
  );
drop policy if exists crm_saved_views_update_policy on crm_saved_views;
create policy crm_saved_views_update_policy on crm_saved_views
  for update
  using (
    workspace_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    and owner_user_id = nullif(current_setting('app.actor_id', true), '')::uuid
  )
  with check (
    workspace_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    and owner_user_id = nullif(current_setting('app.actor_id', true), '')::uuid
  );

alter table crm_recent_records enable row level security;
alter table crm_recent_records force row level security;
drop policy if exists crm_recent_records_actor_policy on crm_recent_records;
create policy crm_recent_records_actor_policy on crm_recent_records
  for all
  using (
    workspace_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    and user_id = nullif(current_setting('app.actor_id', true), '')::uuid
  )
  with check (
    workspace_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    and user_id = nullif(current_setting('app.actor_id', true), '')::uuid
  );

alter table crm_bulk_runtime_batches
  add column if not exists actor_user_id uuid,
  add column if not exists idempotency_key text,
  add column if not exists request_sha256 text,
  add column if not exists status text not null default 'completed',
  add column if not exists selection_ids jsonb not null default '[]',
  add column if not exists payload jsonb not null default '{}',
  add column if not exists completed_at timestamptz,
  add column if not exists error text,
  add column if not exists updated_at timestamptz not null default now();

alter table crm_bulk_runtime_batches
  drop constraint if exists crm_bulk_runtime_batches_status_check;
alter table crm_bulk_runtime_batches
  add constraint crm_bulk_runtime_batches_status_check
  check (status in ('planned', 'running', 'completed', 'partially_completed', 'failed', 'cancelled'));

do $migration$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'crm_bulk_runtime_batches_request_sha256_check'
      and conrelid = 'crm_bulk_runtime_batches'::regclass
  ) then
    alter table crm_bulk_runtime_batches
      add constraint crm_bulk_runtime_batches_request_sha256_check
      check (request_sha256 is null or request_sha256 ~ '^[0-9a-f]{64}$') not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'crm_bulk_runtime_batches_idempotency_shape_check'
      and conrelid = 'crm_bulk_runtime_batches'::regclass
  ) then
    alter table crm_bulk_runtime_batches
      add constraint crm_bulk_runtime_batches_idempotency_shape_check
      check (
        (actor_user_id is null and idempotency_key is null and request_sha256 is null)
        or (actor_user_id is not null and idempotency_key is not null and request_sha256 is not null)
      ) not valid;
  end if;
end;
$migration$;

do $migration$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'crm_bulk_runtime_batches_workspace_actor_fk'
      and conrelid = 'crm_bulk_runtime_batches'::regclass
  ) then
    alter table crm_bulk_runtime_batches
      add constraint crm_bulk_runtime_batches_workspace_actor_fk
      foreign key (workspace_id, actor_user_id)
      references workspace_users(workspace_id, id)
      deferrable initially deferred not valid;
  end if;
end;
$migration$;

create unique index if not exists crm_bulk_runtime_batches_idempotency_uidx
  on crm_bulk_runtime_batches(workspace_id, actor_user_id, idempotency_key)
  where actor_user_id is not null and idempotency_key is not null;

create unique index if not exists crm_bulk_runtime_batches_workspace_id_uidx
  on crm_bulk_runtime_batches(workspace_id, id);

-- This legacy ledger also contains pre-083 rows with no actor. Those rows keep
-- their historical access behavior until migration 061 performs the coordinated
-- application-role cutover. Every actor-bound list-productivity row is already
-- tenant- and actor-bound here.
do $migration$
begin
  if exists (
    select 1
    from pg_catalog.pg_policies
    where schemaname = 'public'
      and tablename = 'crm_bulk_runtime_batches'
      and policyname <> 'crm_bulk_runtime_batches_runtime_policy'
  ) then
    raise exception using
      errcode = '55000',
      message = 'migration 083 requires the batch-ledger RLS cutover to remain separate';
  end if;
  if exists (
    select 1
    from pg_catalog.pg_class
    where oid = 'crm_bulk_runtime_batches'::regclass
      and relrowsecurity
      and not exists (
        select 1
        from pg_catalog.pg_policies
        where schemaname = 'public'
          and tablename = 'crm_bulk_runtime_batches'
          and policyname = 'crm_bulk_runtime_batches_runtime_policy'
      )
  ) then
    raise exception using
      errcode = '55000',
      message = 'migration 083 refuses to replace pre-existing batch-ledger RLS state';
  end if;
end;
$migration$;

alter table crm_bulk_runtime_batches enable row level security;
drop policy if exists crm_bulk_runtime_batches_runtime_policy on crm_bulk_runtime_batches;
create policy crm_bulk_runtime_batches_runtime_policy on crm_bulk_runtime_batches
  for all
  using (
    (
      actor_user_id is null
      and (
        nullif(current_setting('app.tenant_id', true), '') is null
        or workspace_id = nullif(current_setting('app.tenant_id', true), '')::uuid
      )
    )
    or (
      workspace_id = nullif(current_setting('app.tenant_id', true), '')::uuid
      and actor_user_id = nullif(current_setting('app.actor_id', true), '')::uuid
    )
  )
  with check (
    (
      actor_user_id is null
      and (
        nullif(current_setting('app.tenant_id', true), '') is null
        or workspace_id = nullif(current_setting('app.tenant_id', true), '')::uuid
      )
    )
    or (
      workspace_id = nullif(current_setting('app.tenant_id', true), '')::uuid
      and actor_user_id = nullif(current_setting('app.actor_id', true), '')::uuid
    )
  );

create table if not exists crm_bulk_runtime_batch_items (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  batch_id uuid not null,
  entity_id uuid not null,
  status text not null check (status in ('succeeded', 'blocked', 'failed')),
  error text,
  before jsonb,
  after jsonb,
  created_at timestamptz not null default now(),
  unique (workspace_id, batch_id, entity_id),
  constraint crm_bulk_runtime_batch_items_workspace_batch_fk
    foreign key (workspace_id, batch_id)
    references crm_bulk_runtime_batches(workspace_id, id)
    on delete cascade
    deferrable initially deferred
);

create index if not exists crm_bulk_runtime_batch_items_batch_idx
  on crm_bulk_runtime_batch_items(workspace_id, batch_id, status, created_at);

alter table crm_bulk_runtime_batch_items enable row level security;
alter table crm_bulk_runtime_batch_items force row level security;
drop policy if exists crm_bulk_runtime_batch_items_tenant_policy on crm_bulk_runtime_batch_items;
create policy crm_bulk_runtime_batch_items_tenant_policy on crm_bulk_runtime_batch_items
  for all
  using (
    workspace_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    and exists (
      select 1
      from crm_bulk_runtime_batches parent_batch
      where parent_batch.workspace_id = crm_bulk_runtime_batch_items.workspace_id
        and parent_batch.id = crm_bulk_runtime_batch_items.batch_id
        and parent_batch.actor_user_id = nullif(current_setting('app.actor_id', true), '')::uuid
    )
  )
  with check (
    workspace_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    and exists (
      select 1
      from crm_bulk_runtime_batches parent_batch
      where parent_batch.workspace_id = crm_bulk_runtime_batch_items.workspace_id
        and parent_batch.id = crm_bulk_runtime_batch_items.batch_id
        and parent_batch.actor_user_id = nullif(current_setting('app.actor_id', true), '')::uuid
    )
  );

revoke all on table crm_saved_views from public;
revoke all on table crm_recent_records from public;
revoke all on table crm_bulk_runtime_batches from public;
revoke all on table crm_bulk_runtime_batch_items from public;

-- Application-role grants are conditional because some isolated databases do
-- not provision the runtime role until the separate RLS cutover.
do $migration$
begin
  if exists (select 1 from pg_roles where rolname = 'novalure_app') then
    grant select, insert, update on table crm_saved_views to novalure_app;
    grant select, insert, update on table crm_recent_records to novalure_app;
    grant select, insert, update on table crm_bulk_runtime_batches to novalure_app;
    grant select, insert on table crm_bulk_runtime_batch_items to novalure_app;
  end if;
  if exists (select 1 from pg_roles where rolname = 'novalure_tenant_app') then
    grant select, insert, update on table crm_saved_views to novalure_tenant_app;
    grant select, insert, update on table crm_recent_records to novalure_tenant_app;
    grant select, insert, update on table crm_bulk_runtime_batches to novalure_tenant_app;
    grant select, insert on table crm_bulk_runtime_batch_items to novalure_tenant_app;
  end if;
end;
$migration$;
