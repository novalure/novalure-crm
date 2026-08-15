-- P2-01/P2-13 tenant-isolation pilot, activation phase.
-- Apply only after 060, application cutover to withTenantTransaction, and an
-- explicit safe LOGIN-role membership grant to novalure_tenant_app.

set local lock_timeout = '5s';
set local statement_timeout = '14min';

-- Fail closed on ambiguous/unsafe provider roles before changing grants or RLS.
do $migration$
declare
  cutover_attestation text;
  tenant_role_oid oid;
  safe_login_members integer;
begin
  select oid into tenant_role_oid
  from pg_roles
  where rolname = 'novalure_tenant_app'
    and not rolcanlogin
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

  if exists (
    select 1
    from pg_auth_members membership
    join pg_roles member_role on member_role.oid = membership.member
    where membership.roleid = tenant_role_oid
      and (
        not member_role.rolcanlogin
        or not pg_has_role(member_role.oid, tenant_role_oid, 'USAGE')
        or member_role.rolsuper
        or member_role.rolcreatedb
        or member_role.rolcreaterole
        or member_role.rolreplication
        or member_role.rolbypassrls
      )
  ) then
    raise exception using
      errcode = '42501',
      message = 'novalure_tenant_app has an unsafe or non-LOGIN direct member';
  end if;

  select count(*) into safe_login_members
  from pg_auth_members membership
  join pg_roles member_role on member_role.oid = membership.member
  where membership.roleid = tenant_role_oid
    and member_role.rolcanlogin
    and pg_has_role(member_role.oid, tenant_role_oid, 'USAGE')
    and not member_role.rolsuper
    and not member_role.rolcreatedb
    and not member_role.rolcreaterole
    and not member_role.rolreplication
    and not member_role.rolbypassrls;

  if safe_login_members = 0 then
    raise exception using
      errcode = '42501',
      message = 'grant one safe, inheriting LOGIN role directly to novalure_tenant_app before migration 061';
  end if;

  if exists (
    select 1
    from pg_class relation
    join pg_namespace namespace on namespace.oid = relation.relnamespace
    join pg_auth_members membership on membership.member = relation.relowner
    where namespace.nspname = 'public'
      and relation.relname in ('projects', 'contacts', 'leads', 'deals', 'audit_logs')
      and membership.roleid = tenant_role_oid
  ) then
    raise exception using
      errcode = '42501',
      message = 'tenant application LOGIN roles must not own pilot tables';
  end if;

  if (
    select count(*)
    from pg_policies
    where schemaname = 'public'
      and (
        (tablename in ('projects', 'contacts', 'leads', 'deals')
          and policyname = tablename || '_tenant_actor_policy')
        or (tablename = 'audit_logs'
          and policyname in ('audit_logs_tenant_select_policy', 'audit_logs_tenant_insert_policy'))
      )
  ) <> 6 then
    raise exception using
      errcode = '55000',
      message = 'all six tenant pilot policies must exist before activation';
  end if;

  if not exists (
    select 1
    from pg_trigger
    where tgrelid = 'audit_logs'::regclass
      and tgname = 'audit_logs_append_only_guard'
      and tgenabled <> 'D'
      and not tgisinternal
  ) then
    raise exception using
      errcode = '55000',
      message = 'audit_logs append-only guard must be enabled before RLS activation';
  end if;
end;
$migration$;

-- Separate validation gives each environment an explicit data-quality gate.
-- Any nullable tenant reference mismatch blocks this transaction and leaves RLS
-- and grants unchanged.
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
alter table audit_logs validate constraint audit_logs_workspace_project_fk;
alter table audit_logs validate constraint audit_logs_workspace_deal_fk;

-- Remove ambient access, then grant only the operations needed by the pilot.
revoke all on table projects, contacts, leads, deals, audit_logs from public;
revoke all on table projects, contacts, leads, deals, audit_logs from novalure_tenant_app;
grant usage on schema public to novalure_tenant_app;
grant select, insert, update, delete on table projects, contacts, leads, deals
  to novalure_tenant_app;
grant select, insert on table audit_logs to novalure_tenant_app;

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
