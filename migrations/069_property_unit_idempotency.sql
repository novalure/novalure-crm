-- Persist every accepted Unit or Building mutation key independently from the
-- mutable inventory row. Each workspace/key unique constraint is the final
-- DB-side replay guard; the application also serializes equal keys with a
-- transaction advisory lock.

set local lock_timeout = '5s';
set local statement_timeout = '14min';

create table if not exists property_unit_idempotency (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  project_id uuid not null,
  idempotency_key text not null,
  request_hash text not null,
  unit_id uuid not null,
  response jsonb not null,
  created_at timestamptz not null default now(),
  constraint property_unit_idempotency_workspace_key_unique
    unique (workspace_id, idempotency_key),
  constraint property_unit_idempotency_project_fk
    foreign key (workspace_id, project_id)
    references projects(workspace_id, id)
    on delete cascade,
  constraint property_unit_idempotency_unit_fk
    foreign key (workspace_id, project_id, unit_id)
    references property_units(workspace_id, project_id, id)
    on delete cascade,
  constraint property_unit_idempotency_key_check
    check (
      idempotency_key ~* '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    ),
  constraint property_unit_idempotency_request_hash_check
    check (request_hash ~ '^[a-f0-9]{64}$'),
  constraint property_unit_idempotency_response_check
    check (jsonb_typeof(response) = 'object')
);

create index if not exists property_unit_idempotency_project_created_idx
  on property_unit_idempotency(workspace_id, project_id, created_at desc);

create table if not exists property_building_idempotency (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  project_id uuid not null,
  idempotency_key text not null,
  request_hash text not null,
  building_id uuid not null,
  response jsonb not null,
  created_at timestamptz not null default now(),
  constraint property_building_idempotency_workspace_key_unique
    unique (workspace_id, idempotency_key),
  constraint property_building_idempotency_project_fk
    foreign key (workspace_id, project_id)
    references projects(workspace_id, id)
    on delete cascade,
  constraint property_building_idempotency_building_fk
    foreign key (workspace_id, project_id, building_id)
    references property_buildings(workspace_id, project_id, id)
    on delete cascade,
  constraint property_building_idempotency_key_check
    check (
      idempotency_key ~* '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    ),
  constraint property_building_idempotency_request_hash_check
    check (request_hash ~ '^[a-f0-9]{64}$'),
  constraint property_building_idempotency_response_check
    check (jsonb_typeof(response) = 'object')
);

create index if not exists property_building_idempotency_project_created_idx
  on property_building_idempotency(workspace_id, project_id, created_at desc);

revoke all on table property_unit_idempotency from public;
revoke all on table property_building_idempotency from public;

do $migration$
begin
  if exists (select 1 from pg_roles where rolname = 'novalure_app') then
    grant select, insert on table property_unit_idempotency to novalure_app;
    grant select, insert on table property_building_idempotency to novalure_app;
  end if;
  -- Repository calls now use a tenant-scoped transaction, but this expand
  -- migration deliberately neither defines nor enables RLS on the new ledgers.
  -- Keep the tenant runtime role explicitly denied until a separately reviewed
  -- cutover adds policies, validates historical rows and grants access together.
  if exists (select 1 from pg_roles where rolname = 'novalure_tenant_app') then
    revoke all on table property_unit_idempotency from novalure_tenant_app;
    revoke all on table property_building_idempotency from novalure_tenant_app;
  end if;
end;
$migration$;

comment on table property_unit_idempotency is
  'Persistent Unit API replay ledger. One immutable semantic request and response per workspace-scoped idempotency key.';

comment on table property_building_idempotency is
  'Persistent Building API replay ledger. One immutable semantic request and response per workspace-scoped idempotency key.';
