export const tenantCutoverMigrationVersion =
  "061_validate_and_activate_tenant_rls_pilot";
export const tenantCutoverMigrationPath =
  `migrations/${tenantCutoverMigrationVersion}.sql`;

const candidateCommitPattern = /^[a-f0-9]{40}$/u;

function requireCandidateCommit(candidateCommit) {
  if (!candidateCommitPattern.test(candidateCommit ?? "")) {
    throw new Error("Tenant cutover role provisioning requires an exact candidate commit.");
  }
  return candidateCommit;
}

/**
 * Build the role transition that must share one transaction with migration 061
 * and its schema-ledger insert. The candidate is interpolated only after the
 * strict hexadecimal object-id check above, so the resulting COMMENT is both
 * SQL-safe and byte-for-byte release-bound.
 */
export function tenantCutoverRoleProvisioningSql(candidateCommit) {
  requireCandidateCommit(candidateCommit);
  const cutoverComment = `novalure-tenant-cutover:${candidateCommit}`;
  return `
do $novalure_role_preflight$
declare
  app_role_oid oid;
  tenant_role_oid oid;
begin
  select oid into app_role_oid
  from pg_catalog.pg_roles
  where rolname = 'novalure_app'
    and rolcanlogin
    and rolinherit
    and not rolsuper
    and not rolcreatedb
    and not rolcreaterole
    and not rolreplication
    and not rolbypassrls;

  if app_role_oid is null then
    raise exception using
      errcode = '42501',
      message = 'novalure_app must already exist as a safe LOGIN INHERIT role';
  end if;

  select oid into tenant_role_oid
  from pg_catalog.pg_roles
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
      message = 'novalure_tenant_app must already exist as a safe NOLOGIN role from migration 060';
  end if;

  if exists (
    select 1
    from pg_catalog.pg_auth_members membership
    where membership.roleid = app_role_oid
      or membership.member = tenant_role_oid
      or (
        membership.member = app_role_oid
        and membership.roleid <> tenant_role_oid
      )
  ) then
    raise exception using
      errcode = '42501',
      message = 'novalure_app and novalure_tenant_app must have no unexpected membership edge';
  end if;

  if exists (
    select 1
    from pg_catalog.pg_database database_row
    where database_row.datname = pg_catalog.current_database()
      and database_row.datdba in (app_role_oid, tenant_role_oid)
  ) then
    raise exception using
      errcode = '42501',
      message = 'tenant cutover roles must not own the current database';
  end if;

  if exists (
    select 1
    from pg_catalog.pg_auth_members membership
    where membership.roleid = tenant_role_oid
      and membership.member <> app_role_oid
  ) then
    raise exception using
      errcode = '42501',
      message = 'novalure_tenant_app has an unexpected direct member';
  end if;
end;
$novalure_role_preflight$;

alter role novalure_tenant_app noinherit;
grant novalure_tenant_app to novalure_app with inherit true;
grant novalure_tenant_app to novalure_app with set false;
revoke admin option for novalure_tenant_app from novalure_app;
comment on role novalure_tenant_app is '${cutoverComment}';

do $novalure_role_postcondition$
declare
  app_role_oid oid;
  tenant_role_oid oid;
begin
  select oid into strict app_role_oid
  from pg_catalog.pg_roles
  where rolname = 'novalure_app'
    and rolcanlogin
    and rolinherit
    and not rolsuper
    and not rolcreatedb
    and not rolcreaterole
    and not rolreplication
    and not rolbypassrls;

  select oid into strict tenant_role_oid
  from pg_catalog.pg_roles
  where rolname = 'novalure_tenant_app'
    and not rolcanlogin
    and not rolinherit
    and not rolsuper
    and not rolcreatedb
    and not rolcreaterole
    and not rolreplication
    and not rolbypassrls;

  if (
    select count(*)
    from pg_catalog.pg_auth_members membership
    where membership.roleid = tenant_role_oid
  ) <> 1 or not exists (
    select 1
    from pg_catalog.pg_auth_members membership
    where membership.roleid = tenant_role_oid
      and membership.member = app_role_oid
      and membership.inherit_option
      and not membership.set_option
      and not membership.admin_option
  ) then
    raise exception using
      errcode = '42501',
      message = 'novalure_tenant_app must have exactly one non-admin direct INHERIT member: novalure_app';
  end if;

  if exists (
    select 1
    from pg_catalog.pg_auth_members membership
    where membership.roleid = app_role_oid
      or membership.member = tenant_role_oid
      or (
        membership.member = app_role_oid
        and membership.roleid <> tenant_role_oid
      )
  ) then
    raise exception using
      errcode = '42501',
      message = 'tenant cutover role graph contains an unexpected membership edge';
  end if;

  if exists (
    select 1
    from pg_catalog.pg_database database_row
    where database_row.datname = pg_catalog.current_database()
      and database_row.datdba in (app_role_oid, tenant_role_oid)
  ) then
    raise exception using
      errcode = '42501',
      message = 'tenant cutover roles must not own the current database';
  end if;

  if pg_catalog.shobj_description(tenant_role_oid, 'pg_authid') is distinct from '${cutoverComment}' then
    raise exception using
      errcode = '55000',
      message = 'novalure_tenant_app cutover comment is not bound to the candidate commit';
  end if;
end;
$novalure_role_postcondition$;
`;
}
