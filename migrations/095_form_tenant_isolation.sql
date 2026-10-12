-- Form tables were omitted from the forced-RLS cutover. The existing workspace
-- columns and validated composite FKs remain the tenant source of truth.
set local lock_timeout = '5s';
set local statement_timeout = '14min';

do $verify$
begin
  if not exists (select 1 from public.novalure_schema_migrations where version = '094_website_sales_ingestion') then
    raise exception 'Migration 094 must precede form tenant isolation';
  end if;
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.form_submissions'::regclass
      and conname = 'form_submissions_workspace_form_fk' and convalidated
  ) then
    raise exception 'Validated form submission tenant FK is required';
  end if;
end;
$verify$;

revoke all on public.forms, public.form_submissions from public, novalure_app, novalure_tenant_app;
do $acl$
declare
  relation_name text;
  column_name text;
begin
  foreach relation_name in array array['forms', 'form_submissions'] loop
    for column_name in
      select attname from pg_catalog.pg_attribute
      where attrelid = format('public.%I', relation_name)::regclass
        and attnum > 0 and not attisdropped
    loop
      execute format(
        'revoke select (%1$I), insert (%1$I), update (%1$I), references (%1$I) on table public.%2$I from public, novalure_app',
        column_name, relation_name
      );
    end loop;
  end loop;
end;
$acl$;

alter table public.forms enable row level security;
alter table public.forms force row level security;
alter table public.form_submissions enable row level security;
alter table public.form_submissions force row level security;

create policy forms_tenant_read on public.forms
  for select to novalure_tenant_app
  using (
    workspace_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    and exists (
      select 1 from public.workspace_users actor
      where actor.id = nullif(current_setting('app.actor_id', true), '')::uuid
        and actor.workspace_id = forms.workspace_id and actor.status = 'active'
    )
    and (public.crm_workspace_manager(workspace_id)
      or (project_id is not null and public.crm_project_access(workspace_id, project_id, false))
      or (project_id is null
        and owner_user_id = nullif(current_setting('app.actor_id', true), '')::uuid))
  );

create policy forms_tenant_write on public.forms
  for all to novalure_tenant_app
  using (
    workspace_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    and (public.crm_workspace_manager(workspace_id)
      or (project_id is not null and public.crm_project_access(workspace_id, project_id, true))
      or (project_id is null
        and owner_user_id = nullif(current_setting('app.actor_id', true), '')::uuid
        and exists (
          select 1 from public.workspace_users actor
          where actor.id = owner_user_id and actor.workspace_id = forms.workspace_id
            and actor.status = 'active'
        )))
  )
  with check (
    workspace_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    and (public.crm_workspace_manager(workspace_id)
      or (project_id is not null and public.crm_project_access(workspace_id, project_id, true))
      or (project_id is null
        and owner_user_id = nullif(current_setting('app.actor_id', true), '')::uuid
        and exists (
          select 1 from public.workspace_users actor
          where actor.id = owner_user_id and actor.workspace_id = forms.workspace_id
            and actor.status = 'active'
        )))
  );

create policy form_submissions_tenant_read on public.form_submissions
  for select to novalure_tenant_app
  using (
    workspace_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    and (public.crm_workspace_manager(workspace_id)
      or (project_id is not null and public.crm_project_access(workspace_id, project_id, false))
      or (project_id is null and exists (
        select 1 from public.forms f
        where f.id = form_id and f.workspace_id = form_submissions.workspace_id
          and f.project_id is null
          and f.owner_user_id = nullif(current_setting('app.actor_id', true), '')::uuid
      )))
  );

create policy form_submissions_tenant_insert on public.form_submissions
  for insert to novalure_tenant_app
  with check (
    workspace_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    and exists (
      select 1 from public.forms f
      where f.id = form_id and f.workspace_id = form_submissions.workspace_id
        and f.status in ('aktiv', 'eingebaut')
        and f.project_id is not distinct from form_submissions.project_id
    )
    and (public.crm_workspace_manager(workspace_id)
      or (project_id is not null and public.crm_project_access(workspace_id, project_id, true))
      or (project_id is null and exists (
        select 1 from public.forms f
        where f.id = form_id and f.workspace_id = form_submissions.workspace_id
          and f.project_id is null
          and f.owner_user_id = nullif(current_setting('app.actor_id', true), '')::uuid
      )))
  );

-- A form delete would cascade to submissions through the legacy FK. Keep
-- submissions immutable to the runtime even when it owns the parent form.
grant select, insert, update on public.forms to novalure_tenant_app;
grant select, insert on public.form_submissions to novalure_tenant_app;

-- The public lookup identity is separate from the tenant runtime. It has no
-- tenant-role membership or table grants and receives no password in SQL.
do $lookup_role$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'novalure_public_form_lookup') then
    create role novalure_public_form_lookup login noinherit nosuperuser nocreatedb
      nocreaterole noreplication nobypassrls password null;
  end if;
  if not exists (
    select 1 from pg_catalog.pg_roles r where r.rolname = 'novalure_public_form_lookup'
      and r.rolcanlogin and not r.rolsuper and not r.rolbypassrls
      and not r.rolcreatedb and not r.rolcreaterole and not r.rolreplication
      and not pg_catalog.pg_has_role(r.oid, 'novalure_tenant_app', 'MEMBER')
      and not pg_catalog.pg_has_role(r.oid, 'novalure_app', 'MEMBER')
  ) then
    raise exception 'Unsafe public form lookup role';
  end if;
end;
$lookup_role$;

-- This function accepts only an exact public identifier and returns one
-- published form. Its caller receives no base-table or submission privilege.
create function public.crm_public_form_lookup(
  p_form_id uuid, p_workspace_public_key text, p_slug text
) returns jsonb
language sql stable security definer set search_path = pg_catalog, public as $function$
  select jsonb_build_object(
    'id', f.id,
    'name', f.name, 'slug', f.slug, 'status', f.status, 'variant', f.variant,
    'template', f.template, 'fields', f.fields,
    'actions', jsonb_build_object('thankYouMessage', f.actions->>'thankYouMessage'),
    'settings', jsonb_build_object(
      'doubleOptIn', f.settings->'doubleOptIn',
      'progressMode', f.settings->'progressMode',
      'spamProtection', f.settings->'spamProtection',
      'steps', f.settings->'steps',
      'utmCapture', f.settings->'utmCapture'
    ),
    'workspaceName', w.name, 'workspacePublicKey', w.public_key
  )
  from public.forms f
  join public.workspaces w on w.id = f.workspace_id
  left join lateral (
    select u.id from public.workspace_users u
    where u.workspace_id = f.workspace_id and u.status = 'active'
      and u.role in ('owner', 'admin')
    order by (u.id = f.owner_user_id) desc, u.created_at, u.id
    limit 1
  ) public_actor on true
  where f.status in ('aktiv', 'eingebaut')
    and public_actor.id is not null
    and ((p_form_id is not null and f.id = p_form_id)
      or (p_form_id is null and p_workspace_public_key <> ''
        and w.public_key = p_workspace_public_key and f.slug = p_slug))
    and f.id <> '0f98b9fd-d300-4a34-a14c-54a1a61b2415'::uuid
  order by f.updated_at desc
  limit 1
$function$;

-- The server uses this only after validating the public submission proof.
-- Its result is never serialized into the public form response.
create function public.crm_public_form_scope(p_form_id uuid)
returns table(workspace_id uuid, actor_id uuid)
language sql stable security definer set search_path = pg_catalog, public as $function$
  select f.workspace_id, u.id
  from public.forms f
  join lateral (
    select actor.id from public.workspace_users actor
    where actor.workspace_id = f.workspace_id and actor.status = 'active'
      and actor.role in ('owner', 'admin')
    order by (actor.id = f.owner_user_id) desc, actor.created_at, actor.id
    limit 1
  ) u on true
  where f.id = p_form_id and f.status in ('aktiv', 'eingebaut')
    and f.id <> '0f98b9fd-d300-4a34-a14c-54a1a61b2415'::uuid
$function$;

create function public.crm_public_form_legacy_route(p_slug text)
returns table(form_id uuid, slug text, workspace_public_key text)
language sql stable security definer set search_path = pg_catalog, public as $function$
  select f.id, f.slug, w.public_key
  from public.forms f join public.workspaces w on w.id = f.workspace_id
  where f.status in ('aktiv', 'eingebaut')
    and f.id <> '0f98b9fd-d300-4a34-a14c-54a1a61b2415'::uuid
    and (f.slug = p_slug or f.settings->>'legacyId' = p_slug)
    and exists (select 1 from public.workspace_users u
      where u.workspace_id = f.workspace_id and u.status = 'active'
        and u.role in ('owner', 'admin'))
  order by f.updated_at desc
  limit 2
$function$;

revoke all on function public.crm_public_form_lookup(uuid,text,text),
  public.crm_public_form_scope(uuid),
  public.crm_public_form_legacy_route(text) from public, novalure_app, novalure_tenant_app;
grant usage on schema public to novalure_public_form_lookup;
grant execute on function public.crm_public_form_lookup(uuid,text,text),
  public.crm_public_form_scope(uuid),
  public.crm_public_form_legacy_route(text) to novalure_public_form_lookup;
