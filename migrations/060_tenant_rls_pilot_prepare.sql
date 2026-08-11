-- P2-01/P2-13 tenant-isolation pilot, preparation phase.
--
-- This migration deliberately does NOT enable RLS. Before applying 061:
--   1. run scripts/tenant-hardening-inventory.mjs --qa --pilot-ready
--        --cutover-ref=<immutable-deployment-sha-or-id>,
--   2. deploy all pilot-table access through withTenantTransaction,
--   3. grant the real, non-owner LOGIN role membership in novalure_tenant_app.
--   4. attest the deployed immutable ref as the role comment, for example:
--      COMMENT ON ROLE novalure_tenant_app IS
--        'novalure-tenant-cutover:<deployment-sha-or-id>';
-- Existing data is checked by the separate VALIDATE statements in 061.

-- A fixed NOLOGIN group keeps table grants and policy targeting independent of
-- provider-specific LOGIN role names. Fail closed when the migration role is
-- not allowed to provision it; role creation must then be performed explicitly.
do $migration$
declare
  tenant_role record;
  migration_role record;
begin
  select * into tenant_role
  from pg_roles
  where rolname = 'novalure_tenant_app';

  if tenant_role.oid is null then
    select * into migration_role
    from pg_roles
    where rolname = current_user;

    if not coalesce(migration_role.rolcreaterole or migration_role.rolsuper, false) then
      raise exception using
        errcode = '42501',
        message = 'novalure_tenant_app must be provisioned as a safe NOLOGIN group role before migration 060';
    end if;

    execute 'create role novalure_tenant_app noinherit nologin nosuperuser nocreatedb nocreaterole noreplication nobypassrls';
  elsif tenant_role.rolcanlogin
     or tenant_role.rolsuper
     or tenant_role.rolcreatedb
     or tenant_role.rolcreaterole
     or tenant_role.rolreplication
     or tenant_role.rolbypassrls then
    raise exception using
      errcode = '42501',
      message = 'existing novalure_tenant_app role has unsafe attributes';
  end if;
end;
$migration$;

-- Tenant-qualified parent keys. UUID primary keys already guarantee that these
-- are data-compatible; the pair is needed as a composite FK target.
create unique index if not exists workspace_users_workspace_id_id_uidx
  on workspace_users(workspace_id, id);
create unique index if not exists projects_workspace_id_id_uidx
  on projects(workspace_id, id);
create unique index if not exists organizations_workspace_id_id_uidx
  on organizations(workspace_id, id);
create unique index if not exists contacts_workspace_id_id_uidx
  on contacts(workspace_id, id);
create unique index if not exists leads_workspace_id_id_uidx
  on leads(workspace_id, id);
create unique index if not exists deals_workspace_id_id_uidx
  on deals(workspace_id, id);

-- Workspace-leading lookup indexes for the tenant-qualified relationship
-- checks and the common tenant access paths.
create index if not exists contacts_workspace_organization_idx
  on contacts(workspace_id, organization_id);
create index if not exists contacts_workspace_owner_idx
  on contacts(workspace_id, owner_user_id);
create index if not exists contacts_workspace_archived_by_idx
  on contacts(workspace_id, archived_by_user_id);
create index if not exists leads_workspace_contact_idx
  on leads(workspace_id, contact_id);
create index if not exists leads_workspace_assignee_idx
  on leads(workspace_id, assigned_to_user_id);
create index if not exists deals_workspace_project_idx
  on deals(workspace_id, project_id);
create index if not exists deals_workspace_contact_idx
  on deals(workspace_id, contact_id);
create index if not exists deals_workspace_organization_idx
  on deals(workspace_id, organization_id);
create index if not exists deals_workspace_owner_idx
  on deals(workspace_id, owner_user_id);
create index if not exists deals_workspace_lead_idx
  on deals(workspace_id, lead_id);
create index if not exists audit_logs_workspace_actor_idx
  on audit_logs(workspace_id, actor_user_id);
create index if not exists audit_logs_workspace_deal_idx
  on audit_logs(workspace_id, deal_id);

-- NOT VALID avoids an unbounded legacy-row scan in this preparation release,
-- while PostgreSQL still enforces each relationship for new/changed rows.
-- DEFERRABLE preserves the legacy ON DELETE SET NULL behavior: the old FK can
-- clear its scalar key before this tenant-qualified check runs at commit.
do $migration$
declare
  tenant_fk record;
begin
  for tenant_fk in
    select *
    from (values
      ('contacts', 'contacts_workspace_project_fk',
        'foreign key (workspace_id, project_id) references projects(workspace_id, id) deferrable initially deferred not valid'),
      ('contacts', 'contacts_workspace_organization_fk',
        'foreign key (workspace_id, organization_id) references organizations(workspace_id, id) deferrable initially deferred not valid'),
      ('contacts', 'contacts_workspace_owner_fk',
        'foreign key (workspace_id, owner_user_id) references workspace_users(workspace_id, id) deferrable initially deferred not valid'),
      ('contacts', 'contacts_workspace_archived_by_fk',
        'foreign key (workspace_id, archived_by_user_id) references workspace_users(workspace_id, id) deferrable initially deferred not valid'),
      ('leads', 'leads_workspace_project_fk',
        'foreign key (workspace_id, project_id) references projects(workspace_id, id) deferrable initially deferred not valid'),
      ('leads', 'leads_workspace_contact_fk',
        'foreign key (workspace_id, contact_id) references contacts(workspace_id, id) deferrable initially deferred not valid'),
      ('leads', 'leads_workspace_assignee_fk',
        'foreign key (workspace_id, assigned_to_user_id) references workspace_users(workspace_id, id) deferrable initially deferred not valid'),
      ('deals', 'deals_workspace_project_fk',
        'foreign key (workspace_id, project_id) references projects(workspace_id, id) deferrable initially deferred not valid'),
      ('deals', 'deals_workspace_contact_fk',
        'foreign key (workspace_id, contact_id) references contacts(workspace_id, id) deferrable initially deferred not valid'),
      ('deals', 'deals_workspace_organization_fk',
        'foreign key (workspace_id, organization_id) references organizations(workspace_id, id) deferrable initially deferred not valid'),
      ('deals', 'deals_workspace_owner_fk',
        'foreign key (workspace_id, owner_user_id) references workspace_users(workspace_id, id) deferrable initially deferred not valid'),
      ('deals', 'deals_workspace_lead_fk',
        'foreign key (workspace_id, lead_id) references leads(workspace_id, id) deferrable initially deferred not valid'),
      ('audit_logs', 'audit_logs_workspace_actor_fk',
        'foreign key (workspace_id, actor_user_id) references workspace_users(workspace_id, id) deferrable initially deferred not valid'),
      ('audit_logs', 'audit_logs_workspace_project_fk',
        'foreign key (workspace_id, project_id) references projects(workspace_id, id) deferrable initially deferred not valid'),
      ('audit_logs', 'audit_logs_workspace_deal_fk',
        'foreign key (workspace_id, deal_id) references deals(workspace_id, id) deferrable initially deferred not valid')
    ) as definitions(table_name, constraint_name, definition)
  loop
    if not exists (
      select 1
      from pg_constraint
      where conname = tenant_fk.constraint_name
        and conrelid = tenant_fk.table_name::regclass
    ) then
      execute format(
        'alter table %I add constraint %I %s',
        tenant_fk.table_name,
        tenant_fk.constraint_name,
        tenant_fk.definition
      );
    end if;
  end loop;
end;
$migration$;

-- The four mutable pilot tables require both tenant and actor transaction
-- settings for every operation. Missing/empty/invalid settings deny or error;
-- there is no default workspace.
do $migration$
declare
  table_name text;
  policy_name text;
begin
  foreach table_name in array array['projects', 'contacts', 'leads', 'deals']
  loop
    policy_name := table_name || '_tenant_actor_policy';
    if not exists (
      select 1
      from pg_policies
      where schemaname = 'public'
        and tablename = table_name
        and policyname = policy_name
    ) then
      execute format(
        $policy$
          create policy %I on %I
          for all
          to novalure_tenant_app
          using (
            workspace_id = nullif(current_setting('app.tenant_id', true), '')::uuid
            and nullif(current_setting('app.actor_id', true), '')::uuid is not null
          )
          with check (
            workspace_id = nullif(current_setting('app.tenant_id', true), '')::uuid
            and nullif(current_setting('app.actor_id', true), '')::uuid is not null
          )
        $policy$,
        policy_name,
        table_name
      );
    end if;
  end loop;
end;
$migration$;

-- Audit reads are tenant-scoped; inserts must additionally bind the row actor
-- to the transaction actor. No UPDATE/DELETE policy is created.
do $migration$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'audit_logs'
      and policyname = 'audit_logs_tenant_select_policy'
  ) then
    execute $policy$
      create policy audit_logs_tenant_select_policy on audit_logs
      for select
      to novalure_tenant_app
      using (
        workspace_id = nullif(current_setting('app.tenant_id', true), '')::uuid
        and nullif(current_setting('app.actor_id', true), '')::uuid is not null
      )
    $policy$;
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'audit_logs'
      and policyname = 'audit_logs_tenant_insert_policy'
  ) then
    execute $policy$
      create policy audit_logs_tenant_insert_policy on audit_logs
      for insert
      to novalure_tenant_app
      with check (
        workspace_id = nullif(current_setting('app.tenant_id', true), '')::uuid
        and actor_user_id = nullif(current_setting('app.actor_id', true), '')::uuid
      )
    $policy$;
  end if;
end;
$migration$;

-- audit_logs is an append-only ledger for every role, including table owners.
-- The trigger is the invariant; grants below add defense in depth.
create or replace function reject_audit_logs_mutation()
returns trigger
language plpgsql
set search_path = pg_catalog, public, pg_temp
as $function$
begin
  raise exception using
    errcode = '55000',
    message = 'audit_logs is append-only';
end;
$function$;

do $migration$
begin
  if not exists (
    select 1
    from pg_trigger
    where tgrelid = 'audit_logs'::regclass
      and tgname = 'audit_logs_append_only_guard'
      and not tgisinternal
  ) then
    create trigger audit_logs_append_only_guard
      before update or delete or truncate on audit_logs
      for each statement
      execute function reject_audit_logs_mutation();
  end if;
end;
$migration$;

revoke all on function reject_audit_logs_mutation() from public;
revoke update, delete, truncate on audit_logs from public;

comment on table audit_logs is
  'Append-only tenant audit ledger; UPDATE/DELETE are rejected by audit_logs_append_only_guard.';
