-- P2-01/P2-13 tenant-isolation pilot, activation phase.
-- Apply only after 060, application cutover to withTenantTransaction, and an
-- explicit safe LOGIN-role membership grant to novalure_tenant_app.

set local lock_timeout = '5s';
set local statement_timeout = '14min';

-- Fail closed on ambiguous/unsafe provider roles before changing grants or RLS.
do $migration$
declare
  application_role_oid oid;
  audit_insert_predicate text := regexp_replace(lower(
    $predicate$workspace_id = nullif(current_setting('app.tenant_id', true), '')::uuid
      and actor_user_id = nullif(current_setting('app.actor_id', true), '')::uuid$predicate$
  ), '(::text)|[()[:space:]]', '', 'g');
  cutover_attestation text;
  tenant_actor_predicate text := regexp_replace(lower(
    $predicate$workspace_id = nullif(current_setting('app.tenant_id', true), '')::uuid
      and nullif(current_setting('app.actor_id', true), '')::uuid is not null$predicate$
  ), '(::text)|[()[:space:]]', '', 'g');
  tenant_role_oid oid;
begin
  select oid into application_role_oid
  from pg_catalog.pg_roles
  where rolname = 'novalure_app'
    and rolcanlogin
    and rolinherit
    and not rolsuper
    and not rolcreatedb
    and not rolcreaterole
    and not rolreplication
    and not rolbypassrls;

  if application_role_oid is null then
    raise exception using
      errcode = '42501',
      message = 'safe novalure_app LOGIN role is missing';
  end if;

  select oid into tenant_role_oid
  from pg_roles
  where rolname = 'novalure_tenant_app'
    and not rolcanlogin
    and not rolinherit
    and not rolsuper
    and not rolcreatedb
    and not rolcreaterole
    and not rolreplication
    and not rolbypassrls;

  if tenant_role_oid is null then
    raise exception using
      errcode = '42501',
      message = 'safe novalure_tenant_app group role is missing';
  end if;

  select shobj_description(tenant_role_oid, 'pg_authid') into cutover_attestation;
  if cutover_attestation is null
     or cutover_attestation !~ '^novalure-tenant-cutover:[A-Za-z0-9._:@/-]{8,160}$' then
    raise exception using
      errcode = '55000',
      message = 'novalure_tenant_app role comment must attest the deployed immutable cutover reference';
  end if;

  -- The only direct member is the exact application LOGIN with fixed PG16+
  -- membership options. Bind the actual pg_auth_members edges around both
  -- roles so indirect reachability and ADMIN-only escalation cannot hide
  -- behind implicit superuser membership semantics.
  if (
    select count(*)
    from pg_catalog.pg_auth_members membership
    where membership.roleid = tenant_role_oid
  ) <> 1 or not exists (
    select 1
    from pg_catalog.pg_auth_members membership
    where membership.roleid = tenant_role_oid
      and membership.member = application_role_oid
      and membership.inherit_option
      and not membership.set_option
      and not membership.admin_option
  ) then
    raise exception using
      errcode = '42501',
      message = 'novalure_tenant_app must have exactly one fixed novalure_app membership';
  end if;

  if exists (
    select 1
    from pg_catalog.pg_auth_members membership
    where membership.roleid = application_role_oid
      or membership.member = tenant_role_oid
      or (
        membership.member = application_role_oid
        and membership.roleid <> tenant_role_oid
      )
  ) then
    raise exception using
      errcode = '42501',
      message = 'tenant cutover role graph contains an unexpected membership edge';
  end if;

  -- pg_database_owner has an implicit member which does not appear in
  -- pg_auth_members. Exclude both runtime roles as the current database owner.
  if exists (
    select 1
    from pg_catalog.pg_database database_row
    where database_row.datname = pg_catalog.current_database()
      and database_row.datdba in (application_role_oid, tenant_role_oid)
  ) then
    raise exception using
      errcode = '42501',
      message = 'tenant application roles must not own the current database';
  end if;

  -- With the exact role graph bound above, only these two principals are
  -- reachable from the application LOGIN.
  if exists (
    select 1
    from pg_class relation
    join pg_namespace namespace on namespace.oid = relation.relnamespace
    where namespace.nspname = 'public'
      and relation.relname in ('projects', 'contacts', 'leads', 'deals', 'audit_logs')
      and relation.relowner not in (
        select trusted_owner.oid
        from (
          select role_row.oid
          from pg_catalog.pg_roles role_row
          where role_row.rolname = 'pg_database_owner'
          union
          select database_row.datdba
          from pg_catalog.pg_database database_row
          where database_row.datname = pg_catalog.current_database()
        ) trusted_owner
      )
  ) then
    raise exception using
      errcode = '42501',
      message = 'pilot tables must retain a trusted database owner';
  end if;

  -- The activation is tied to the complete policy definitions, not merely to
  -- six matching names. No extra policy may exist on any pilot table.
  if (
    select count(*)
    from pg_policy policy
    where policy.polrelid = any(array[
      'public.projects'::regclass,
      'public.contacts'::regclass,
      'public.leads'::regclass,
      'public.deals'::regclass,
      'public.audit_logs'::regclass
    ]::oid[])
  ) <> 6 then
    raise exception using
      errcode = '55000',
      message = 'all six tenant pilot policies must exist before activation';
  end if;

  if exists (
    with expected(table_oid, policy_name, command, using_predicate, check_predicate) as (
      values
        ('public.projects'::regclass, 'projects_tenant_actor_policy', '*', tenant_actor_predicate, tenant_actor_predicate),
        ('public.contacts'::regclass, 'contacts_tenant_actor_policy', '*', tenant_actor_predicate, tenant_actor_predicate),
        ('public.leads'::regclass, 'leads_tenant_actor_policy', '*', tenant_actor_predicate, tenant_actor_predicate),
        ('public.deals'::regclass, 'deals_tenant_actor_policy', '*', tenant_actor_predicate, tenant_actor_predicate),
        ('public.audit_logs'::regclass, 'audit_logs_tenant_select_policy', 'r', tenant_actor_predicate, ''),
        ('public.audit_logs'::regclass, 'audit_logs_tenant_insert_policy', 'a', '', audit_insert_predicate)
    )
    select 1
    from expected
    left join pg_policy policy
      on policy.polrelid = expected.table_oid
     and policy.polname = expected.policy_name
    where policy.oid is null
       or policy.polcmd <> expected.command
       or not policy.polpermissive
       or policy.polroles <> array[tenant_role_oid]::oid[]
       or regexp_replace(
            lower(coalesce(pg_get_expr(policy.polqual, policy.polrelid, false), '')),
            '(::text)|[()[:space:]]',
            '',
            'g'
          ) <> expected.using_predicate
       or regexp_replace(
            lower(coalesce(pg_get_expr(policy.polwithcheck, policy.polrelid, false), '')),
            '(::text)|[()[:space:]]',
            '',
            'g'
          ) <> expected.check_predicate
  ) then
    raise exception using
      errcode = '55000',
      message = 'tenant pilot policy command, role, mode, or predicate does not match the reviewed contract';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_trigger trigger_row
    where trigger_row.tgrelid = 'public.audit_logs'::regclass
      and trigger_row.tgname = 'audit_logs_append_only_guard'
      and trigger_row.tgenabled = 'O'
      and trigger_row.tgtype = 58
      and trigger_row.tgfoid = 'public.reject_audit_logs_mutation()'::regprocedure
      and not trigger_row.tgisinternal
  ) or not exists (
    select 1
    from pg_catalog.pg_proc function_row
    join pg_catalog.pg_language function_language
      on function_language.oid = function_row.prolang
    where function_row.oid = 'public.reject_audit_logs_mutation()'::regprocedure
      and function_language.lanname = 'plpgsql'
      and function_row.prokind = 'f'
      and function_row.prorettype = 'pg_catalog.trigger'::regtype
      and function_row.pronargs = 0
      and not function_row.prosecdef
      and not function_row.proleakproof
      and function_row.provolatile = 'v'
      and function_row.proparallel = 'u'
      and function_row.proconfig = array['search_path=pg_catalog, public, pg_temp']::text[]
      and regexp_replace(lower(function_row.prosrc), '[[:space:]]', '', 'g')
        = regexp_replace(lower($function_body$
            begin
              raise exception using
                errcode = '55000',
                message = 'audit_logs is append-only';
            end;
          $function_body$), '[[:space:]]', '', 'g')
  ) then
    raise exception using
      errcode = '55000',
      message = 'the exact audit_logs append-only statement guard must be enabled before RLS activation';
  end if;
end;
$migration$;

-- Separate validation gives each environment an explicit data-quality gate.
-- Any nullable tenant reference mismatch blocks this transaction and leaves RLS
-- and grants unchanged. Project/deal IDs in audit_logs are immutable snapshots,
-- not live relationships: migration 068 deliberately removes those two FKs so
-- QA graph cleanup cannot mutate the append-only ledger. Do not validate a
-- relationship here that the final schema intentionally does not retain. This
-- also makes this activation safe both before and after migration 068.
alter table contacts validate constraint contacts_workspace_project_fk;
alter table contacts validate constraint contacts_workspace_organization_fk;
alter table contacts validate constraint contacts_workspace_owner_fk;
alter table contacts validate constraint contacts_workspace_archived_by_fk;

alter table leads validate constraint leads_workspace_project_fk;
alter table leads validate constraint leads_workspace_contact_fk;
alter table leads validate constraint leads_workspace_assignee_fk;

alter table deals validate constraint deals_workspace_project_fk;
alter table deals validate constraint deals_workspace_contact_fk;
alter table deals validate constraint deals_workspace_organization_fk;
alter table deals validate constraint deals_workspace_owner_fk;
alter table deals validate constraint deals_workspace_lead_fk;

alter table audit_logs validate constraint audit_logs_workspace_actor_fk;

-- Remove ambient access, then grant only the operations needed by the pilot.
revoke create on schema public from public;
revoke create on schema public from novalure_app;
revoke create on schema public from novalure_tenant_app;
revoke grant option for usage on schema public
  from public, novalure_app, novalure_tenant_app;
revoke all on table projects, contacts, leads, deals, audit_logs from public;
revoke all on table projects, contacts, leads, deals, audit_logs from novalure_app;
revoke all on table projects, contacts, leads, deals, audit_logs from novalure_tenant_app;
grant usage on schema public to novalure_tenant_app;
grant select, insert, update, delete on table projects, contacts, leads, deals
  to novalure_tenant_app;
grant select, insert on table audit_logs to novalure_tenant_app;

-- A legacy ACL reachable through INHERIT or SET ROLE would make the group-role
-- contract ambiguous. More importantly, TRUNCATE is outside PostgreSQL row
-- security. Inspect the catalog rather than only has_table_privilege so a
-- SET-only role and a column-level ACL cannot evade this postcondition.
do $pilot_acl_postcondition$
declare
  application_role_oid oid;
  tenant_role_oid oid;
begin
  select oid into strict application_role_oid
  from pg_catalog.pg_roles
  where rolname = 'novalure_app';

  select oid into strict tenant_role_oid
  from pg_catalog.pg_roles
  where rolname = 'novalure_tenant_app';

  if not exists (
    select 1
    from pg_catalog.pg_namespace namespace
    cross join lateral pg_catalog.aclexplode(
      coalesce(namespace.nspacl, pg_catalog.acldefault('n', namespace.nspowner))
    ) grant_entry
    where namespace.nspname = 'public'
      and grant_entry.grantee = tenant_role_oid
      and grant_entry.privilege_type = 'USAGE'
      and not grant_entry.is_grantable
  ) or exists (
    select 1
    from pg_catalog.pg_namespace namespace
    cross join lateral pg_catalog.aclexplode(
      coalesce(namespace.nspacl, pg_catalog.acldefault('n', namespace.nspowner))
    ) grant_entry
    where namespace.nspname = 'public'
      and grant_entry.grantee <> namespace.nspowner
      and (
        grant_entry.is_grantable
        or grant_entry.grantee not in (0, application_role_oid, tenant_role_oid)
        or grant_entry.privilege_type <> 'USAGE'
      )
  ) or exists (
    select 1
    from pg_catalog.pg_namespace namespace
    where namespace.nspname = 'public'
      and namespace.nspowner not in (
        select trusted_owner.oid
        from (
          select role_row.oid
          from pg_catalog.pg_roles role_row
          where role_row.rolname = 'pg_database_owner'
          union
          select database_row.datdba
          from pg_catalog.pg_database database_row
          where database_row.datname = pg_catalog.current_database()
        ) trusted_owner
      )
  ) then
    raise exception using
      errcode = '42501',
      message = 'public schema ACL or owner exceeds the tenant cutover boundary';
  end if;

  if exists (
    select 1
    from pg_catalog.pg_class relation
    join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
    cross join lateral pg_catalog.aclexplode(
      coalesce(relation.relacl, pg_catalog.acldefault('r', relation.relowner))
    ) grant_entry
    where namespace.nspname = 'public'
      and relation.relname in ('projects', 'contacts', 'leads', 'deals', 'audit_logs')
      and (
        grant_entry.is_grantable
        or (
          grant_entry.grantee <> relation.relowner
          and case
            when grant_entry.grantee = tenant_role_oid then
              (
              relation.relname = 'audit_logs'
              and grant_entry.privilege_type not in ('SELECT', 'INSERT')
              )
              or (
              relation.relname <> 'audit_logs'
              and grant_entry.privilege_type not in ('SELECT', 'INSERT', 'UPDATE', 'DELETE')
              )
            else true
          end
        )
      )
  ) then
    raise exception using
      errcode = '42501',
      message = 'novalure_app can reach an unexpected pilot table ACL';
  end if;

  if exists (
    with expected(table_name, privilege_type) as (
      values
        ('projects', 'SELECT'),
        ('projects', 'INSERT'),
        ('projects', 'UPDATE'),
        ('projects', 'DELETE'),
        ('contacts', 'SELECT'),
        ('contacts', 'INSERT'),
        ('contacts', 'UPDATE'),
        ('contacts', 'DELETE'),
        ('leads', 'SELECT'),
        ('leads', 'INSERT'),
        ('leads', 'UPDATE'),
        ('leads', 'DELETE'),
        ('deals', 'SELECT'),
        ('deals', 'INSERT'),
        ('deals', 'UPDATE'),
        ('deals', 'DELETE'),
        ('audit_logs', 'SELECT'),
        ('audit_logs', 'INSERT')
    )
    select 1
    from expected
    where not exists (
      select 1
      from pg_catalog.pg_class relation
      join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
      cross join lateral pg_catalog.aclexplode(
        coalesce(relation.relacl, pg_catalog.acldefault('r', relation.relowner))
      ) grant_entry
      where namespace.nspname = 'public'
        and relation.relname = expected.table_name
        and grant_entry.grantee = tenant_role_oid
        and grant_entry.privilege_type = expected.privilege_type
        and not grant_entry.is_grantable
    )
  ) then
    raise exception using
      errcode = '42501',
      message = 'novalure_tenant_app is missing a required pilot table privilege';
  end if;

  if exists (
    select 1
    from pg_catalog.pg_attribute attribute
    join pg_catalog.pg_class relation on relation.oid = attribute.attrelid
    join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
    cross join lateral pg_catalog.aclexplode(attribute.attacl) grant_entry
    where namespace.nspname = 'public'
      and relation.relname in ('projects', 'contacts', 'leads', 'deals', 'audit_logs')
      and attribute.attnum > 0
      and not attribute.attisdropped
  ) then
    raise exception using
      errcode = '42501',
      message = 'novalure_app can reach an unexpected pilot column ACL';
  end if;

  if exists (
    select 1
    from pg_catalog.pg_class relation
    join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
    where namespace.nspname = 'public'
      and relation.relname in ('projects', 'contacts', 'leads', 'deals', 'audit_logs')
      and relation.relowner not in (
        select trusted_owner.oid
        from (
          select role_row.oid
          from pg_catalog.pg_roles role_row
          where role_row.rolname = 'pg_database_owner'
          union
          select database_row.datdba
          from pg_catalog.pg_database database_row
          where database_row.datname = pg_catalog.current_database()
        ) trusted_owner
      )
  ) then
    raise exception using
      errcode = '42501',
      message = 'pilot table owner is outside the trusted database-owner boundary';
  end if;
end;
$pilot_acl_postcondition$;

-- Scope is intentionally limited to five core CRM tables. FORCE prevents table
-- owners from silently bypassing policies; BYPASSRLS roles remain forbidden for
-- application LOGIN membership by the preflight above.
alter table projects enable row level security;
alter table projects force row level security;
alter table contacts enable row level security;
alter table contacts force row level security;
alter table leads enable row level security;
alter table leads force row level security;
alter table deals enable row level security;
alter table deals force row level security;
alter table audit_logs enable row level security;
alter table audit_logs force row level security;
