-- Central public integration boundary. Browser and customer systems receive no
-- database identity; the existing application runtime may execute only the
-- narrow functions granted at the end of this migration.
set local lock_timeout = '5s';
set local statement_timeout = '14min';

do $verify$
begin
  if not exists (
    select 1 from public.novalure_schema_migrations
    where version = '095_form_tenant_isolation'
  ) then
    raise exception 'Migration 095 must precede the external integration gateway';
  end if;
  if not exists (
    select 1 from pg_catalog.pg_roles
    where rolname = 'novalure_app' and not rolsuper and not rolbypassrls
  ) then
    raise exception 'The least-privilege novalure_app runtime is required';
  end if;
end;
$verify$;

create table public.external_integrations (
  id uuid primary key default gen_random_uuid(),
  public_site_key text not null unique,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid,
  form_id uuid,
  integration_type text not null,
  status text not null default 'test',
  mode text not null default 'training',
  allowed_origins text[] not null default '{}',
  capabilities text[] not null default '{}',
  configuration jsonb not null default '{}',
  metadata jsonb not null default '{}',
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  revoked_at timestamptz,
  constraint external_integrations_site_key_check
    check (public_site_key ~ '^nov_pk_[A-Za-z0-9_-]{24,80}$'),
  constraint external_integrations_type_check check (integration_type in (
    'novalure_studio','customer_website','developer_project','estate_agent',
    'landing_page','website_chat','public_form'
  )),
  constraint external_integrations_status_check
    check (status in ('test','active','disabled','revoked')),
  constraint external_integrations_mode_check
    check (mode in ('training','real_customer')),
  constraint external_integrations_capabilities_check check (
    capabilities <@ array[
      'form.read','form.submit','chat.start','chat.message','lead.create',
      'callback.request','appointment.request'
    ]::text[]
    and cardinality(capabilities) <= 7
  ),
  constraint external_integrations_configuration_object_check
    check (jsonb_typeof(configuration) = 'object'),
  constraint external_integrations_metadata_object_check
    check (jsonb_typeof(metadata) = 'object'),
  constraint external_integrations_revocation_check check (
    (status = 'revoked' and revoked_at is not null)
    or (status <> 'revoked' and revoked_at is null)
  ),
  foreign key (workspace_id, project_id)
    references public.projects(workspace_id, id),
  foreign key (workspace_id, form_id)
    references public.forms(workspace_id, id),
  foreign key (workspace_id, created_by)
    references public.workspace_users(workspace_id, id)
);

create index external_integrations_workspace_status_idx
  on public.external_integrations(workspace_id, status, updated_at desc);
create index external_integrations_project_idx
  on public.external_integrations(workspace_id, project_id)
  where project_id is not null;
create index external_integrations_active_form_idx
  on public.external_integrations(workspace_id, form_id)
  where form_id is not null and status in ('test','active');
create unique index external_integrations_workspace_id_id_uidx
  on public.external_integrations(workspace_id, id);

create table public.external_integration_widget_configs (
  integration_id uuid primary key references public.external_integrations(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  brand_name text not null default 'Novalure',
  assistant_name text not null default 'Evelyn',
  assistant_avatar_reference text,
  primary_color text not null default '#111827',
  widget_position text not null default 'bottom_right',
  language text not null default 'en',
  welcome_message text not null default 'How can I help?',
  enabled_capabilities text[] not null default '{}',
  lead_capture_enabled boolean not null default false,
  calendar_enabled boolean not null default false,
  property_search_enabled boolean not null default false,
  chat_enabled boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint external_widget_brand_check check (char_length(brand_name) between 1 and 120),
  constraint external_widget_assistant_check check (char_length(assistant_name) between 1 and 120),
  constraint external_widget_color_check check (primary_color ~ '^#[0-9A-Fa-f]{6}$'),
  constraint external_widget_position_check
    check (widget_position in ('bottom_left','bottom_right')),
  constraint external_widget_language_check check (language ~ '^[a-z]{2}(?:-[A-Z]{2})?$'),
  constraint external_widget_message_check check (char_length(welcome_message) between 1 and 500),
  constraint external_widget_capabilities_check check (
    enabled_capabilities <@ array[
      'form.read','form.submit','chat.start','chat.message','lead.create',
      'callback.request','appointment.request'
    ]::text[]
  ),
  foreign key (workspace_id, integration_id)
    references public.external_integrations(workspace_id, id)
);

create table public.external_chat_sessions (
  id uuid primary key default gen_random_uuid(),
  integration_id uuid not null,
  workspace_id uuid not null,
  project_id uuid,
  session_token_hash text not null,
  idempotency_hash text not null,
  mode text not null,
  language text not null,
  status text not null default 'active',
  synthetic boolean not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  closed_at timestamptz,
  constraint external_chat_token_hash_check check (session_token_hash ~ '^[0-9a-f]{64}$'),
  constraint external_chat_idempotency_hash_check check (idempotency_hash ~ '^[0-9a-f]{64}$'),
  constraint external_chat_mode_check check (mode in ('training','real_customer')),
  constraint external_chat_status_check check (status in ('active','closed','blocked')),
  constraint external_chat_language_check check (language ~ '^[a-z]{2}(?:-[A-Z]{2})?$'),
  unique (integration_id, idempotency_hash),
  unique (workspace_id, id),
  unique (workspace_id, id, integration_id),
  foreign key (workspace_id, integration_id)
    references public.external_integrations(workspace_id, id),
  foreign key (workspace_id, project_id)
    references public.projects(workspace_id, id)
);

create index external_chat_sessions_integration_updated_idx
  on public.external_chat_sessions(integration_id, updated_at desc);

create table public.external_chat_messages (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null,
  integration_id uuid not null,
  workspace_id uuid not null,
  role text not null,
  content text not null,
  idempotency_hash text not null,
  synthetic boolean not null,
  created_at timestamptz not null default now(),
  constraint external_chat_message_role_check check (role in ('visitor','assistant','system')),
  constraint external_chat_message_content_check check (char_length(content) between 1 and 8000),
  constraint external_chat_message_idempotency_hash_check check (idempotency_hash ~ '^[0-9a-f]{64}$'),
  unique (session_id, idempotency_hash),
  foreign key (workspace_id, session_id, integration_id)
    references public.external_chat_sessions(workspace_id, id, integration_id) on delete cascade
);

create index external_chat_messages_session_created_idx
  on public.external_chat_messages(session_id, created_at, id);

create table public.external_integration_events (
  id uuid primary key default gen_random_uuid(),
  integration_id uuid,
  workspace_id uuid,
  project_id uuid,
  event_type text not null,
  outcome text not null,
  capability text,
  correlation_id uuid,
  detail jsonb not null default '{}',
  created_at timestamptz not null default now(),
  constraint external_integration_event_type_check check (char_length(event_type) between 1 and 80),
  constraint external_integration_event_outcome_check check (outcome in ('accepted','denied','failed','duplicate')),
  constraint external_integration_event_detail_check check (jsonb_typeof(detail) = 'object'),
  foreign key (workspace_id, integration_id)
    references public.external_integrations(workspace_id, id),
  foreign key (workspace_id, project_id)
    references public.projects(workspace_id, id)
);

create index external_integration_events_scope_created_idx
  on public.external_integration_events(workspace_id, integration_id, created_at desc);
create index external_integration_events_type_created_idx
  on public.external_integration_events(event_type, created_at desc);

alter table public.external_integrations enable row level security;
alter table public.external_integrations force row level security;
alter table public.external_integration_widget_configs enable row level security;
alter table public.external_integration_widget_configs force row level security;
alter table public.external_chat_sessions enable row level security;
alter table public.external_chat_sessions force row level security;
alter table public.external_chat_messages enable row level security;
alter table public.external_chat_messages force row level security;
alter table public.external_integration_events enable row level security;
alter table public.external_integration_events force row level security;

create policy external_integrations_tenant_read on public.external_integrations
  for select to novalure_tenant_app
  using (
    workspace_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    and (public.crm_workspace_manager(workspace_id)
      or (project_id is not null and public.crm_project_access(workspace_id, project_id, false)))
  );
create policy external_integrations_tenant_write on public.external_integrations
  for all to novalure_tenant_app
  using (workspace_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    and public.crm_workspace_manager(workspace_id))
  with check (workspace_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    and public.crm_workspace_manager(workspace_id));

create policy external_widget_tenant on public.external_integration_widget_configs
  for all to novalure_tenant_app
  using (workspace_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    and public.crm_workspace_manager(workspace_id))
  with check (workspace_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    and public.crm_workspace_manager(workspace_id));

create policy external_chat_sessions_tenant on public.external_chat_sessions
  for all to novalure_tenant_app
  using (workspace_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    and (public.crm_workspace_manager(workspace_id)
      or (project_id is not null and public.crm_project_access(workspace_id, project_id, false))))
  with check (workspace_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    and (public.crm_workspace_manager(workspace_id)
      or (project_id is not null and public.crm_project_access(workspace_id, project_id, true))));

create policy external_chat_messages_tenant_read on public.external_chat_messages
  for select to novalure_tenant_app
  using (
    workspace_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    and exists (
      select 1 from public.external_chat_sessions s
      where s.workspace_id=external_chat_messages.workspace_id
        and s.id=external_chat_messages.session_id
        and s.integration_id=external_chat_messages.integration_id
        and (public.crm_workspace_manager(s.workspace_id)
          or (s.project_id is not null and public.crm_project_access(s.workspace_id,s.project_id,false)))
    )
  )
;
create policy external_chat_messages_tenant_insert on public.external_chat_messages
  for insert to novalure_tenant_app
  with check (
    workspace_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    and exists (
      select 1 from public.external_chat_sessions s
      where s.workspace_id=external_chat_messages.workspace_id
        and s.id=external_chat_messages.session_id
        and s.integration_id=external_chat_messages.integration_id
        and (public.crm_workspace_manager(s.workspace_id)
          or (s.project_id is not null and public.crm_project_access(s.workspace_id,s.project_id,true)))
    )
  );

create policy external_integration_events_tenant on public.external_integration_events
  for select to novalure_tenant_app
  using (workspace_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    and public.crm_workspace_manager(workspace_id));
create policy external_integration_events_append on public.external_integration_events
  for insert to novalure_tenant_app
  with check (workspace_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

revoke all on public.external_integrations,
  public.external_integration_widget_configs,
  public.external_chat_sessions,
  public.external_chat_messages,
  public.external_integration_events
  from public, novalure_app, novalure_tenant_app;
grant select, insert, update on public.external_integrations,
  public.external_integration_widget_configs,
  public.external_chat_sessions to novalure_tenant_app;
grant select, insert on public.external_chat_messages to novalure_tenant_app;
grant select, insert on public.external_integration_events to novalure_tenant_app;

-- Seed compatibility integrations for existing public forms. Site keys are
-- publishable identifiers, not credentials. Existing CRM-hosted forms retain
-- their three canonical HTTPS origins; every customer-controlled origin still
-- requires an authenticated onboarding action.
insert into public.external_integrations (
  public_site_key, workspace_id, project_id, form_id, integration_type,
  status, mode, allowed_origins, capabilities, configuration, metadata
)
select
  'nov_pk_' || replace(f.id::text, '-', ''),
  f.workspace_id,
  f.project_id,
  f.id,
  case when f.id = '0f98b9fd-d300-4a34-a14c-54a1a61b2415'::uuid
    then 'novalure_studio' else 'public_form' end,
  'active',
  'training',
  case when f.id = '0f98b9fd-d300-4a34-a14c-54a1a61b2415'::uuid
    then array['https://novalurestudio.ie']::text[]
    else array[
      'https://novalure-crm.app',
      'https://www.novalure-crm.app',
      'https://novalure-crm-novalure.vercel.app'
    ]::text[] end,
  case when f.id = '0f98b9fd-d300-4a34-a14c-54a1a61b2415'::uuid
    then array['lead.create']::text[] else array['form.read','form.submit']::text[] end,
  jsonb_build_object('legacyCompatibility', true),
  jsonb_build_object('seededByMigration', '096_public_integration_gateway')
from public.forms f
where f.status in ('aktiv','eingebaut')
on conflict do nothing;

insert into public.external_integration_widget_configs (
  integration_id, workspace_id, brand_name, assistant_name, language,
  enabled_capabilities, lead_capture_enabled, chat_enabled
)
select i.id, i.workspace_id, coalesce(w.name, 'Novalure'), 'Evelyn', 'en',
  i.capabilities, 'lead.create'=any(i.capabilities) or 'form.submit'=any(i.capabilities),
  'chat.start'=any(i.capabilities)
from public.external_integrations i
join public.workspaces w on w.id=i.workspace_id
on conflict do nothing;

-- Keep forms published through the authenticated CRM UI registered after the
-- one-time migration seed. Customer-controlled origins are never inferred:
-- this trigger adds only the canonical CRM-hosted origins. An explicit revoke
-- remains revoked across later form edits.
create function public.crm_sync_legacy_public_form_integration()
returns trigger
language plpgsql security definer set search_path = pg_catalog, public as $function$
declare
  v_integration_id uuid;
begin
  if new.id = '0f98b9fd-d300-4a34-a14c-54a1a61b2415'::uuid then
    return new;
  end if;

  if new.status in ('aktiv','eingebaut') then
    insert into public.external_integrations (
      public_site_key, workspace_id, project_id, form_id, integration_type,
      status, mode, allowed_origins, capabilities, configuration, metadata
    ) values (
      'nov_pk_' || replace(new.id::text, '-', ''),
      new.workspace_id,
      new.project_id,
      new.id,
      'public_form',
      'active',
      'training',
      array[
        'https://novalure-crm.app',
        'https://www.novalure-crm.app',
        'https://novalure-crm-novalure.vercel.app'
      ]::text[],
      array['form.read','form.submit']::text[],
      jsonb_build_object('legacyCompatibility', true),
      jsonb_build_object('registeredBy', 'crm_sync_legacy_public_form_integration')
    )
    on conflict (public_site_key) do update
      set project_id=excluded.project_id,
          form_id=excluded.form_id,
          status=case when public.external_integrations.status='revoked'
            then 'revoked' else 'active' end,
          revoked_at=case when public.external_integrations.status='revoked'
            then public.external_integrations.revoked_at else null end,
          capabilities=array['form.read','form.submit']::text[],
          configuration=public.external_integrations.configuration
            || jsonb_build_object('legacyCompatibility', true),
          updated_at=now()
      where public.external_integrations.workspace_id=excluded.workspace_id
        and public.external_integrations.form_id=excluded.form_id
        and public.external_integrations.configuration @> '{"legacyCompatibility":true}'::jsonb
    returning id into v_integration_id;

    if v_integration_id is null then
      raise exception 'Published form integration identity collision';
    end if;

    insert into public.external_integration_widget_configs (
      integration_id, workspace_id, brand_name, assistant_name, language,
      enabled_capabilities, lead_capture_enabled, chat_enabled
    )
    select v_integration_id, new.workspace_id, coalesce(w.name, 'Novalure'),
      'Evelyn', 'en', array['form.read','form.submit']::text[], true, false
    from public.workspaces w where w.id=new.workspace_id
    on conflict (integration_id) do nothing;
  else
    update public.external_integrations
      set status='disabled', revoked_at=null, updated_at=now()
      where workspace_id=new.workspace_id and form_id=new.id
        and status <> 'revoked'
        and configuration @> '{"legacyCompatibility":true}'::jsonb;
  end if;

  return new;
end;
$function$;

revoke all on function public.crm_sync_legacy_public_form_integration() from public;

create trigger forms_sync_legacy_public_integration
after insert or update of status, project_id on public.forms
for each row execute function public.crm_sync_legacy_public_form_integration();

create function public.crm_external_integration_resolve(
  p_public_site_key text,
  p_origin text,
  p_capability text,
  p_form_id uuid default null
) returns table(
  integration_id uuid,
  workspace_id uuid,
  project_id uuid,
  form_id uuid,
  public_actor_id uuid,
  integration_type text,
  integration_mode text,
  configuration jsonb,
  widget_configuration jsonb
)
language sql volatile security definer set search_path = pg_catalog, public as $function$
  select i.id, i.workspace_id, i.project_id, i.form_id, actor.id,
    i.integration_type, i.mode, i.configuration,
    jsonb_build_object(
      'brandName', wc.brand_name,
      'assistantName', wc.assistant_name,
      'assistantAvatarReference', wc.assistant_avatar_reference,
      'primaryColor', wc.primary_color,
      'widgetPosition', wc.widget_position,
      'language', wc.language,
      'welcomeMessage', wc.welcome_message,
      'enabledCapabilities', wc.enabled_capabilities,
      'leadCaptureEnabled', wc.lead_capture_enabled,
      'calendarEnabled', wc.calendar_enabled,
      'propertySearchEnabled', wc.property_search_enabled,
      'chatEnabled', wc.chat_enabled
    )
  from public.external_integrations i
  left join public.external_integration_widget_configs wc on wc.integration_id=i.id
  join lateral (
    select u.id from public.workspace_users u
    where u.workspace_id=i.workspace_id and u.status='active' and u.role in ('owner','admin')
    order by u.created_at, u.id limit 1
  ) actor on true
  where i.public_site_key=p_public_site_key
    and i.status in ('test','active')
    and p_capability=any(i.capabilities)
    and p_origin=any(i.allowed_origins)
    and (p_form_id is null or i.form_id=p_form_id)
    and (i.form_id is null or exists (
      select 1 from public.forms f
      where f.workspace_id=i.workspace_id and f.id=i.form_id
        and f.project_id is not distinct from i.project_id
        and f.status in ('aktiv','eingebaut')
    ))
  limit 1
  for share of i
$function$;

create function public.crm_external_legacy_form_lookup(
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
  join public.workspaces w on w.id=f.workspace_id
  where f.status in ('aktiv','eingebaut')
    and ((p_form_id is not null and f.id=p_form_id)
      or (p_form_id is null and p_workspace_public_key<>''
        and w.public_key=p_workspace_public_key and f.slug=p_slug))
    and f.id <> '0f98b9fd-d300-4a34-a14c-54a1a61b2415'::uuid
    and exists (select 1 from public.external_integrations i
      where i.workspace_id=f.workspace_id and i.form_id=f.id
        and i.status in ('test','active') and 'form.read'=any(i.capabilities))
    and exists (select 1 from public.workspace_users u
      where u.workspace_id=f.workspace_id and u.status='active' and u.role in ('owner','admin'))
  order by f.updated_at desc limit 1
$function$;

create function public.crm_external_legacy_form_route(p_slug text)
returns table(form_id uuid, slug text, workspace_public_key text)
language sql stable security definer set search_path = pg_catalog, public as $function$
  with candidates as materialized (
    select f.id, f.slug, w.public_key
    from public.forms f
    join public.workspaces w on w.id=f.workspace_id
    where f.status in ('aktiv','eingebaut')
      and f.id <> '0f98b9fd-d300-4a34-a14c-54a1a61b2415'::uuid
      and (f.slug=p_slug or f.settings->>'legacyId'=p_slug)
      and exists (select 1 from public.external_integrations i
        where i.workspace_id=f.workspace_id and i.form_id=f.id
          and i.status in ('test','active') and 'form.read'=any(i.capabilities))
      and exists (select 1 from public.workspace_users u
        where u.workspace_id=f.workspace_id and u.status='active' and u.role in ('owner','admin'))
  ), counted as (
    select candidates.*, count(*) over () as candidate_count from candidates
  )
  select id, slug, public_key from counted where candidate_count=1
$function$;

create function public.crm_external_form_submission_scope(
  p_form_id uuid, p_workspace_public_key text
) returns table(workspace_id uuid, actor_id uuid)
language sql stable security definer set search_path = pg_catalog, public as $function$
  select f.workspace_id, actor.id
  from public.forms f
  join public.workspaces w on w.id=f.workspace_id
  join lateral (
    select u.id from public.workspace_users u
    where u.workspace_id=f.workspace_id and u.status='active' and u.role in ('owner','admin')
    order by (u.id=f.owner_user_id) desc, u.created_at, u.id limit 1
  ) actor on true
  where f.id=p_form_id and w.public_key=p_workspace_public_key
    and f.status in ('aktiv','eingebaut')
    and f.id <> '0f98b9fd-d300-4a34-a14c-54a1a61b2415'::uuid
    and exists (select 1 from public.external_integrations i
      where i.workspace_id=f.workspace_id and i.form_id=f.id
        and i.status in ('test','active') and 'form.submit'=any(i.capabilities))
$function$;

-- Keep the established public-form function contract for the application
-- runtime while routing it through the registry-backed gateway. The dedicated
-- database login is disabled below and receives no execute privilege.
create or replace function public.crm_public_form_lookup(
  p_form_id uuid, p_workspace_public_key text, p_slug text
) returns jsonb
language sql stable security definer set search_path = pg_catalog, public as $function$
  select public.crm_external_legacy_form_lookup(p_form_id,p_workspace_public_key,p_slug)
$function$;
comment on function public.crm_public_form_lookup(uuid,text,text) is
  'Application-only legacy URL adapter. novalure_app executes it; the retired lookup role is NOLOGIN and has no grant.';

create or replace function public.crm_public_form_scope(
  p_form_id uuid, p_workspace_public_key text
) returns table(workspace_id uuid, actor_id uuid)
language sql stable security definer set search_path = pg_catalog, public as $function$
  select * from public.crm_external_form_submission_scope(p_form_id,p_workspace_public_key)
$function$;
comment on function public.crm_public_form_scope(uuid,text) is
  'Application-only legacy submission adapter. Tenant context is derived server-side; the retired lookup role has no grant.';

create or replace function public.crm_public_form_legacy_route(p_slug text)
returns table(form_id uuid, slug text, workspace_public_key text)
language sql stable security definer set search_path = pg_catalog, public as $function$
  select * from public.crm_external_legacy_form_route(p_slug)
$function$;
comment on function public.crm_public_form_legacy_route(text) is
  'Application-only legacy slug adapter. Ambiguous global slugs fail closed and the retired lookup role has no grant.';

-- The SQL-created lookup role is permanently removed from the runtime design.
do $disable_lookup$
begin
  if exists (select 1 from pg_catalog.pg_roles where rolname='novalure_public_form_lookup') then
    alter role novalure_public_form_lookup nologin password null;
  end if;
end;
$disable_lookup$;

revoke all on function public.crm_public_form_lookup(uuid,text,text),
  public.crm_public_form_scope(uuid,text),
  public.crm_public_form_legacy_route(text)
  from public, novalure_public_form_lookup, novalure_app, novalure_tenant_app;
revoke usage on schema public from novalure_public_form_lookup;

revoke all on function public.crm_external_integration_resolve(text,text,text,uuid),
  public.crm_external_legacy_form_lookup(uuid,text,text),
  public.crm_external_legacy_form_route(text),
  public.crm_external_form_submission_scope(uuid,text)
  from public, novalure_public_form_lookup, novalure_tenant_app;
grant execute on function public.crm_external_integration_resolve(text,text,text,uuid),
  public.crm_external_legacy_form_lookup(uuid,text,text),
  public.crm_external_legacy_form_route(text),
  public.crm_external_form_submission_scope(uuid,text)
  to novalure_app;
grant execute on function public.crm_public_form_lookup(uuid,text,text),
  public.crm_public_form_scope(uuid,text),
  public.crm_public_form_legacy_route(text)
  to novalure_app;
