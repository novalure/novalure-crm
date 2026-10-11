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
      or owner_user_id = nullif(current_setting('app.actor_id', true), '')::uuid)
  );

create policy forms_tenant_write on public.forms
  for all to novalure_tenant_app
  using (
    workspace_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    and (public.crm_workspace_manager(workspace_id)
      or (project_id is not null and public.crm_project_access(workspace_id, project_id, true)))
  )
  with check (
    workspace_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    and (public.crm_workspace_manager(workspace_id)
      or (project_id is not null and public.crm_project_access(workspace_id, project_id, true)))
  );

create policy form_submissions_tenant_read on public.form_submissions
  for select to novalure_tenant_app
  using (
    workspace_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    and (public.crm_workspace_manager(workspace_id)
      or (project_id is not null and public.crm_project_access(workspace_id, project_id, false)))
  );

create policy form_submissions_tenant_insert on public.form_submissions
  for insert to novalure_tenant_app
  with check (
    workspace_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    and exists (
      select 1 from public.forms f
      where f.id = form_id and f.workspace_id = form_submissions.workspace_id
        and f.status in ('aktiv', 'eingebaut')
    )
    and (public.crm_workspace_manager(workspace_id)
      or (project_id is not null and public.crm_project_access(workspace_id, project_id, true)))
  );

grant select, insert, update, delete on public.forms to novalure_tenant_app;
grant select, insert on public.form_submissions to novalure_tenant_app;

-- This function accepts only an exact public identifier and returns one
-- published form. Its caller receives no base-table or submission privilege.
create function public.crm_public_form_lookup(
  p_form_id uuid, p_workspace_public_key text, p_slug text
) returns jsonb
language sql stable security definer set search_path = pg_catalog, public as $function$
  select jsonb_build_object(
    'id', f.id, 'workspaceId', f.workspace_id,
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
    'workspaceName', w.name, 'workspacePublicKey', w.public_key,
    'publicActorId', public_actor.id
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
  public.crm_public_form_legacy_route(text) from public, novalure_app;
grant execute on function public.crm_public_form_lookup(uuid,text,text),
  public.crm_public_form_legacy_route(text) to novalure_tenant_app;
