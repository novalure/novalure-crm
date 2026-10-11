-- CRM-U1-C06: final Production runtime role and forced-RLS cutover.
-- This migration is manual and must run only after the exact candidate has
-- proved the scoped company-profile path on a Production-derived branch.
set local lock_timeout = '5s';
set local statement_timeout = '14min';

do $guard$
declare
  unsafe boolean;
begin
  if current_user <> 'neondb_owner' or current_database() <> 'neondb' then
    raise exception using errcode = '42501', message = '091 requires the pinned Neon database owner context';
  end if;
  if not exists (
    select 1 from public.novalure_schema_migrations
    where version = '090_property_media_delete_runtime'
  ) then
    raise exception using errcode = '55000', message = '091 requires migration 090';
  end if;
  select not (
    runtime.rolcanlogin
    and not runtime.rolsuper
    and not runtime.rolbypassrls
    and not runtime.rolcreatedb
    and not runtime.rolcreaterole
    and not runtime.rolreplication
    and tenant.rolcanlogin = false
    and not tenant.rolsuper
    and not tenant.rolbypassrls
    and not tenant.rolcreatedb
    and not tenant.rolcreaterole
    and not tenant.rolreplication
    and pg_has_role(runtime.oid, tenant.oid, 'USAGE')
  ) into unsafe
  from pg_roles runtime cross join pg_roles tenant
  where runtime.rolname = 'novalure_app' and tenant.rolname = 'novalure_tenant_app';
  if unsafe is distinct from false then
    raise exception using errcode = '42501', message = 'unsafe or missing runtime role contract';
  end if;
end
$guard$;

create or replace function public.crm_company_profile_write_allowed(p_scope text, p_workspace uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $function$
  select exists (
    select 1 from public.workspace_users actor
    where actor.workspace_id = nullif(current_setting('app.tenant_id', true), '')::uuid
      and actor.id = nullif(current_setting('app.actor_id', true), '')::uuid
      and actor.status = 'active'
      and (
        (p_scope = 'platform_operator' and p_workspace is null and actor.product_role in ('platform_admin', 'novalureAdmin'))
        or (p_scope = 'workspace_owner' and p_workspace = actor.workspace_id and (
          actor.role = 'owner' or actor.product_role in ('customer_owner', 'workspace_admin', 'platform_admin', 'novalureAdmin', 'novalure_onboarding', 'novalure_customer_success')
        ))
        or (p_scope = 'crm_account' and p_workspace = actor.workspace_id and (
          actor.role in ('owner', 'admin') or actor.product_role in ('customer_owner', 'workspace_admin', 'platform_admin', 'novalureAdmin', 'novalure_onboarding', 'novalure_customer_success')
        ))
      )
  )
$function$;

alter table public.company_profiles enable row level security;
alter table public.company_profiles force row level security;
alter table public.company_profile_versions enable row level security;
alter table public.company_profile_versions force row level security;

drop policy if exists crm_company_profile_read on public.company_profiles;
drop policy if exists crm_company_profile_write on public.company_profiles;
create policy crm_company_profile_read on public.company_profiles
  for select to novalure_tenant_app
  using (
    exists (
      select 1 from public.workspace_users actor
      where actor.workspace_id = nullif(current_setting('app.tenant_id', true), '')::uuid
        and actor.id = nullif(current_setting('app.actor_id', true), '')::uuid
        and actor.status = 'active'
    )
    and (
      workspace_id = nullif(current_setting('app.tenant_id', true), '')::uuid
      or (
        profile_scope = 'platform_operator'
        and exists (
          select 1 from public.workspace_users actor
          where actor.workspace_id = nullif(current_setting('app.tenant_id', true), '')::uuid
            and actor.id = nullif(current_setting('app.actor_id', true), '')::uuid
            and actor.status = 'active'
            and actor.product_role in ('platform_admin', 'novalureAdmin')
        )
      )
    )
  );
create policy crm_company_profile_write on public.company_profiles
  for all to novalure_tenant_app
  using (public.crm_company_profile_write_allowed(profile_scope, workspace_id))
  with check (public.crm_company_profile_write_allowed(profile_scope, workspace_id));

drop policy if exists crm_company_profile_version_read on public.company_profile_versions;
drop policy if exists crm_company_profile_version_append on public.company_profile_versions;
create policy crm_company_profile_version_read on public.company_profile_versions
  for select to novalure_tenant_app
  using (
    exists (
      select 1 from public.company_profiles profile
      where profile.id = company_profile_id
        and (
          profile.workspace_id = nullif(current_setting('app.tenant_id', true), '')::uuid
          or (
            profile.profile_scope = 'platform_operator'
            and exists (
              select 1 from public.workspace_users actor
              where actor.workspace_id = nullif(current_setting('app.tenant_id', true), '')::uuid
                and actor.id = nullif(current_setting('app.actor_id', true), '')::uuid
                and actor.status = 'active'
                and actor.product_role in ('platform_admin', 'novalureAdmin')
            )
          )
        )
    )
  );
create policy crm_company_profile_version_append on public.company_profile_versions
  for insert to novalure_tenant_app
  with check (
    actor_user_id = nullif(current_setting('app.actor_id', true), '')::uuid
    and exists (
      select 1 from public.company_profiles profile
      where profile.id = company_profile_id
        and public.crm_company_profile_write_allowed(profile.profile_scope, profile.workspace_id)
    )
  );

drop view if exists public.crm_company_profile_versions_scoped;
drop view if exists public.crm_company_profiles_write_scoped;
drop view if exists public.crm_company_profiles_scoped;

create view public.crm_company_profiles_scoped
with (security_barrier = true, security_invoker = false)
as
select profile.*
from public.company_profiles profile
where exists (
  select 1 from public.workspace_users actor
  where actor.workspace_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    and actor.id = nullif(current_setting('app.actor_id', true), '')::uuid
    and actor.status = 'active'
)
and (
  profile.workspace_id = nullif(current_setting('app.tenant_id', true), '')::uuid
  or (
    profile.profile_scope = 'platform_operator'
    and exists (
      select 1 from public.workspace_users actor
      where actor.workspace_id = nullif(current_setting('app.tenant_id', true), '')::uuid
        and actor.id = nullif(current_setting('app.actor_id', true), '')::uuid
        and actor.status = 'active'
        and actor.product_role in ('platform_admin', 'novalureAdmin')
    )
  )
);

create view public.crm_company_profiles_write_scoped
with (security_barrier = true, security_invoker = false)
as
select profile.*
from public.company_profiles profile
where public.crm_company_profile_write_allowed(profile.profile_scope, profile.workspace_id)
with cascaded check option;

create view public.crm_company_profile_versions_scoped
with (security_barrier = true, security_invoker = false)
as
select version.*
from public.company_profile_versions version
join public.crm_company_profiles_scoped profile on profile.id = version.company_profile_id;

create or replace function public.crm_company_profile_record_version(
  p_profile uuid,
  p_action text,
  p_before jsonb,
  p_after jsonb,
  p_changed_fields text[]
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  profile public.company_profiles%rowtype;
  recorded_id uuid;
begin
  if p_action not in ('company_profile.created', 'company_profile.updated')
     or p_after is null
     or p_changed_fields is null then
    raise exception using errcode = '22023', message = 'invalid company profile history payload';
  end if;
  select * into profile from public.company_profiles where id = p_profile;
  if profile.id is null or not public.crm_company_profile_write_allowed(profile.profile_scope, profile.workspace_id) then
    raise exception using errcode = '42501', message = 'company profile history scope denied';
  end if;
  insert into public.company_profile_versions (
    company_profile_id, workspace_id, actor_user_id, action, before, after, changed_fields
  ) values (
    profile.id,
    profile.workspace_id,
    nullif(current_setting('app.actor_id', true), '')::uuid,
    p_action,
    p_before,
    p_after,
    p_changed_fields
  ) returning id into recorded_id;
  return recorded_id;
end
$function$;

revoke all on table public.company_profiles, public.company_profile_versions from public, novalure_app, novalure_tenant_app;
revoke all on table public.crm_company_profiles_scoped, public.crm_company_profiles_write_scoped, public.crm_company_profile_versions_scoped from public, novalure_app;
grant select on table public.crm_company_profiles_scoped, public.crm_company_profile_versions_scoped to novalure_tenant_app;
grant select, insert, update on table public.crm_company_profiles_write_scoped to novalure_tenant_app;
revoke all on function public.crm_company_profile_write_allowed(text, uuid), public.crm_company_profile_record_version(uuid, text, jsonb, jsonb, text[]) from public, novalure_app;
grant execute on function public.crm_company_profile_write_allowed(text, uuid), public.crm_company_profile_record_version(uuid, text, jsonb, jsonb, text[]) to novalure_tenant_app;

-- Remove every remaining direct runtime grant on forced-RLS base tables. The
-- runtime reaches them only through its non-admin tenant-role membership.
do $least_privilege$
declare
  relation record;
  column_name text;
begin
  for relation in
    select n.nspname, c.relname
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p') and c.relforcerowsecurity
  loop
    execute format('revoke all privileges on table %I.%I from novalure_app', relation.nspname, relation.relname);
    for column_name in
      select a.attname from pg_attribute a
      where a.attrelid = format('%I.%I', relation.nspname, relation.relname)::regclass
        and a.attnum > 0 and not a.attisdropped
    loop
      execute format(
        'revoke select (%1$I), insert (%1$I), update (%1$I), references (%1$I) on table %2$I.%3$I from novalure_app',
        column_name, relation.nspname, relation.relname
      );
    end loop;
  end loop;
end
$least_privilege$;

do $verify$
declare
  missing text;
begin
  select string_agg(format('%I.%I', n.nspname, c.relname), ', ' order by c.relname)
  into missing
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind in ('r', 'p')
    and c.relrowsecurity and not c.relforcerowsecurity;
  if missing is not null then
    raise exception using errcode = '55000', message = 'RLS relations are not forced: ' || missing;
  end if;
  if has_table_privilege('novalure_app', 'public.company_profiles', 'SELECT')
     or has_table_privilege('novalure_app', 'public.company_profiles', 'INSERT')
     or has_table_privilege('novalure_app', 'public.company_profiles', 'UPDATE')
     or has_table_privilege('novalure_app', 'public.company_profiles', 'DELETE') then
    raise exception using errcode = '42501', message = 'novalure_app retains forbidden company_profiles access';
  end if;
end
$verify$;
