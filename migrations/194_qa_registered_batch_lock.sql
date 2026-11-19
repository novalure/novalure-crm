-- Registered QA retirement: read-and-lock only, not adoption or deletion.
-- Runtime roles retain no UPDATE/DELETE privilege on the append-only ledger.
set local lock_timeout = '5s';
set local statement_timeout = '30s';

do $migration$
begin
  if not exists (select 1 from pg_roles where rolname='novalure_qa_batch_locker') then
    create role novalure_qa_batch_locker nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
  end if;
  if not exists (select 1 from pg_roles where rolname='novalure_qa_batch_locker'
    and not rolcanlogin and not rolinherit and not rolsuper and not rolcreatedb
    and not rolcreaterole and not rolreplication and not rolbypassrls) then
    raise exception 'QA lock owner must remain a non-login, NOINHERIT, non-privileged role' using errcode='42501';
  end if;
  if exists (select 1 from pg_class where oid='public.qa_batches'::regclass and (not relrowsecurity or not relforcerowsecurity)) then
    raise exception 'Existing QA batch FORCE RLS is required' using errcode='42501';
  end if;
  if pg_has_role('novalure_tenant_app','novalure_qa_batch_locker','MEMBER')
    or exists (select 1 from pg_roles where rolname='novalure_app' and pg_has_role(oid,'novalure_qa_batch_locker','MEMBER')) then
    raise exception 'Runtime roles must not inherit or assume the QA lock owner' using errcode='42501';
  end if;
end;
$migration$;

-- PG17 CREATEROLE supplies ADMIN but not SET for a newly created role.
-- Preserve this deployer's own membership options/grantor exactly; do not
-- overwrite the bootstrap/other-grantor membership which supplied ADMIN.
create temporary table qa_cleanup_194_grant_restore(
  deployer name not null,needs_set boolean not null,needs_create boolean not null,
  own_membership boolean not null,old_admin boolean,old_inherit boolean,old_set boolean
) on commit drop;
insert into pg_temp.qa_cleanup_194_grant_restore
select current_user,not pg_has_role(current_user,'novalure_qa_batch_locker','SET'),
  not has_schema_privilege('novalure_qa_batch_locker','public','CREATE'),
  membership.roleid is not null,membership.admin_option,membership.inherit_option,membership.set_option
from pg_roles deployer cross join pg_roles owner_role
left join pg_auth_members membership on membership.roleid=owner_role.oid
  and membership.member=deployer.oid and membership.grantor=deployer.oid
where deployer.rolname=current_user and owner_role.rolname='novalure_qa_batch_locker';
do $migration$
declare prior record;
begin
  select * into strict prior from pg_temp.qa_cleanup_194_grant_restore;
  if prior.needs_set then
    execute format('grant novalure_qa_batch_locker to %I with admin %s, inherit %s, set true granted by %I',
      prior.deployer,case when coalesce(prior.old_admin,false) then 'true' else 'false' end,
      case when coalesce(prior.old_inherit,false) then 'true' else 'false' end,prior.deployer);
  end if;
  if prior.needs_create then
    grant create on schema public to novalure_qa_batch_locker;
  end if;
end;
$migration$;

grant usage on schema public to novalure_qa_batch_locker;
grant select(id,is_qa) on public.workspaces to novalure_qa_batch_locker;
grant select on public.qa_batches to novalure_qa_batch_locker;
-- PostgreSQL row locking requires UPDATE privilege. Only this NOLOGIN owner
-- receives one-column UPDATE; the unchanged append-only trigger still rejects
-- every actual UPDATE, including one issued by this owner. No table ownership,
-- role membership or DML grant is given to application/user roles.
grant update(id) on public.qa_batches to novalure_qa_batch_locker;
grant execute on function public.crm_lock_active_member(uuid,uuid) to novalure_qa_batch_locker;

create policy qa_batches_locker_select on public.qa_batches for select
  to novalure_qa_batch_locker using (
    workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid
    and nullif(current_setting('app.actor_id',true),'')::uuid is not null
  );
create policy qa_batches_locker_lock on public.qa_batches for update
  to novalure_qa_batch_locker using (
    workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid
    and nullif(current_setting('app.actor_id',true),'')::uuid is not null
  ) with check (
    workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid
    and nullif(current_setting('app.actor_id',true),'')::uuid is not null
  );

create function public.crm_qa_lock_registered_batch(p_workspace uuid,p_batch uuid)
returns table(id uuid,marker text,digest text)
language plpgsql security definer set search_path=pg_catalog,public as $function$
declare
  actor uuid := nullif(current_setting('app.actor_id',true),'')::uuid;
  actor_role text;
  actor_product_role text;
begin
  if actor is null or p_workspace is distinct from nullif(current_setting('app.tenant_id',true),'')::uuid then
    raise exception 'QA lock tenant context mismatch' using errcode='42501';
  end if;
  -- Existing 080 definer locks active membership and workspace without giving
  -- this new owner UPDATE on workspace_users, workspaces or auth_sessions.
  select member.role,member.product_role into actor_role,actor_product_role
    from public.crm_lock_active_member(p_workspace,actor) member;
  if actor_role is null or actor_role not in ('owner','admin')
    or actor_product_role not in ('platform_admin','novalureAdmin','novalure_onboarding',
      'novalure_customer_success','customer_owner','workspace_admin') then
    raise exception 'Current QA administration authority required' using errcode='42501';
  end if;
  if not exists(select 1 from public.workspaces w where w.id=p_workspace and w.is_qa=true) then
    raise exception 'Explicit QA workspace required' using errcode='42501';
  end if;
  return query select b.id,b.batch_marker,
    encode(sha256(convert_to(to_jsonb(b)::text,'UTF8')),'hex')
    from public.qa_batches b where b.workspace_id=p_workspace and b.id=p_batch for update;
end;
$function$;

revoke all on function public.crm_qa_lock_registered_batch(uuid,uuid) from public,novalure_tenant_app;
do $migration$
begin
  if exists(select 1 from pg_roles where rolname='novalure_app') then
    revoke all on function public.crm_qa_lock_registered_batch(uuid,uuid) from novalure_app;
  end if;
end;
$migration$;
grant execute on function public.crm_qa_lock_registered_batch(uuid,uuid) to novalure_tenant_app;

comment on function public.crm_qa_lock_registered_batch(uuid,uuid) is
  'Read-and-lock only: current active QA administrator, exact tenant and registered batch; no adoption, DML, audit deletion or runtime UPDATE grant.';

-- Finish ACL/comment while the deployer still owns the function; NOINHERIT
-- must not be bypassed merely to administer the newly transferred object.
alter function public.crm_qa_lock_registered_batch(uuid,uuid) owner to novalure_qa_batch_locker;

-- Restore only the temporary ownership-transfer facilities. All changes occur
-- in the runner's migration transaction; failure rolls the entire grant/DDL
-- sequence back. Owner role NOINHERIT and runtime memberships are never altered.
do $migration$
declare prior record;
begin
  select * into strict prior from pg_temp.qa_cleanup_194_grant_restore where deployer=current_user;
  if prior.needs_create then
    revoke create on schema public from novalure_qa_batch_locker;
  end if;
  if prior.needs_set then
    if prior.own_membership then
      execute format('grant novalure_qa_batch_locker to %I with admin %s, inherit %s, set %s granted by %I',
        prior.deployer,case when prior.old_admin then 'true' else 'false' end,
        case when prior.old_inherit then 'true' else 'false' end,
        case when prior.old_set then 'true' else 'false' end,prior.deployer);
    else
      execute format('revoke novalure_qa_batch_locker from %I granted by %I',prior.deployer,prior.deployer);
    end if;
  end if;
end;
$migration$;
