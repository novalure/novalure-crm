-- Broker Operations foundation.
--
-- Additive only: existing CRM rows and existing status columns are retained.
-- External offer/calendar providers and the reservation relationship sync are
-- deliberately not activated by this migration.

set local lock_timeout = '5s';
set local statement_timeout = '14min';

do $migration_guard$
begin
  if to_regclass('public.buyer_search_profiles') is null
    or to_regclass('public.property_viewing_slots') is null
    or to_regclass('public.property_units') is null
    or to_regclass('public.property_reservations') is null
    or to_regclass('public.seller_listings') is null
    or to_regclass('public.property_media') is null
    or to_regclass('public.property_documents') is null
    or to_regclass('public.contact_timeline_items') is null
    or to_regclass('public.calendar_events') is null
    or to_regclass('public.tasks') is null
    or not exists (
      select 1
      from information_schema.columns
      where table_schema = 'public' and table_name = 'seller_listings'
        and column_name = 'owner_contact_id'
    )
    or not exists (
      select 1
      from information_schema.columns
      where table_schema = 'public' and table_name = 'seller_listings'
        and column_name = 'rent_price_cents'
    ) then
    raise exception 'broker operations prerequisites are missing';
  end if;
end;
$migration_guard$;

-- UUID primary keys are globally unique. These additional unique indexes are
-- explicit tenant-qualified FK targets and keep every new relation auditable.
create unique index if not exists broker_ops_projects_workspace_id_uidx
  on public.projects(workspace_id, id);
create unique index if not exists broker_ops_workspace_users_workspace_id_uidx
  on public.workspace_users(workspace_id, id);
create unique index if not exists broker_ops_organizations_workspace_id_uidx
  on public.organizations(workspace_id, id);
create unique index if not exists broker_ops_contacts_workspace_id_uidx
  on public.contacts(workspace_id, id);
create unique index if not exists broker_ops_leads_workspace_id_uidx
  on public.leads(workspace_id, id);
create unique index if not exists broker_ops_deals_workspace_id_uidx
  on public.deals(workspace_id, id);
create unique index if not exists broker_ops_tasks_workspace_id_uidx
  on public.tasks(workspace_id, id);
create unique index if not exists broker_ops_timeline_workspace_id_uidx
  on public.contact_timeline_items(workspace_id, id);
create unique index if not exists broker_ops_calendar_events_workspace_id_uidx
  on public.calendar_events(workspace_id, id);
create unique index if not exists broker_ops_listings_workspace_id_uidx
  on public.seller_listings(workspace_id, id);
create unique index if not exists broker_ops_units_workspace_id_uidx
  on public.property_units(workspace_id, id);
create unique index if not exists broker_ops_reservations_workspace_id_uidx
  on public.property_reservations(workspace_id, id);
create unique index if not exists broker_ops_property_media_workspace_id_uidx
  on public.property_media(workspace_id, id);
create unique index if not exists broker_ops_property_documents_workspace_id_uidx
  on public.property_documents(workspace_id, id);
create unique index if not exists broker_ops_profiles_workspace_id_uidx
  on public.buyer_search_profiles(workspace_id, id);
create unique index if not exists broker_ops_viewings_workspace_id_uidx
  on public.property_viewing_slots(workspace_id, id);

alter table public.buyer_search_profiles
  add column if not exists organization_id uuid,
  add column if not exists owner_user_id uuid,
  add column if not exists expires_at date,
  add column if not exists intent_type text not null default 'purchase',
  add column if not exists sub_object_type text,
  add column if not exists area_from_sqm numeric(12,2),
  add column if not exists area_to_sqm numeric(12,2),
  add column if not exists rooms_from numeric(5,1),
  add column if not exists rooms_to numeric(5,1),
  add column if not exists region text,
  add column if not exists municipality text,
  add column if not exists postal_code text,
  add column if not exists radius_km numeric(8,2),
  add column if not exists year_built_from integer,
  add column if not exists year_built_to integer,
  add column if not exists equipment text[] not null default '{}',
  add column if not exists accessibility text not null default 'none',
  add column if not exists target_yield_basis_points integer,
  add column if not exists exclusion_criteria text[] not null default '{}',
  add column if not exists auto_match_enabled boolean not null default false,
  add column if not exists status text not null default 'draft',
  add column if not exists version bigint not null default 1,
  add column if not exists broker_operations_managed boolean not null default false;

-- Backfill only newly introduced range/status fields; legacy columns remain the
-- source from which this reversible compatibility projection is derived.
update public.buyer_search_profiles
set
  area_from_sqm = coalesce(area_from_sqm, area_sqm),
  area_to_sqm = coalesce(area_to_sqm, area_sqm),
  rooms_from = coalesce(rooms_from, rooms),
  rooms_to = coalesce(rooms_to, rooms),
  status = case lower(coalesce(matching_status, ''))
    when 'active' then 'active'
    when 'aktiv' then 'active'
    when 'open' then 'active'
    when 'paused' then 'paused'
    when 'expired' then 'expired'
    when 'archived' then 'archived'
    else status
  end
where
  area_from_sqm is null
  or area_to_sqm is null
  or rooms_from is null
  or rooms_to is null
  or status = 'draft';

do $profile_constraints$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.buyer_search_profiles'::regclass and conname = 'buyer_search_profiles_broker_status_check') then
    alter table public.buyer_search_profiles
      add constraint buyer_search_profiles_broker_status_check
      check (status in ('draft', 'active', 'paused', 'expired', 'archived')) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.buyer_search_profiles'::regclass and conname = 'buyer_search_profiles_intent_type_check') then
    alter table public.buyer_search_profiles
      add constraint buyer_search_profiles_intent_type_check
      check (intent_type in ('purchase', 'rent', 'investment')) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.buyer_search_profiles'::regclass and conname = 'buyer_search_profiles_accessibility_check') then
    alter table public.buyer_search_profiles
      add constraint buyer_search_profiles_accessibility_check
      check (accessibility in ('none', 'preferred', 'required')) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.buyer_search_profiles'::regclass and conname = 'buyer_search_profiles_ranges_check') then
    alter table public.buyer_search_profiles
      add constraint buyer_search_profiles_ranges_check
      check (
        (budget_from_cents is null or budget_from_cents >= 0)
        and (budget_to_cents is null or budget_to_cents >= 0)
        and (budget_from_cents is null or budget_to_cents is null or budget_from_cents <= budget_to_cents)
        and (area_from_sqm is null or area_from_sqm >= 0)
        and (area_to_sqm is null or area_to_sqm >= 0)
        and (area_from_sqm is null or area_to_sqm is null or area_from_sqm <= area_to_sqm)
        and (rooms_from is null or rooms_from >= 0)
        and (rooms_to is null or rooms_to >= 0)
        and (rooms_from is null or rooms_to is null or rooms_from <= rooms_to)
        and (year_built_from is null or year_built_from between 1000 and 3000)
        and (year_built_to is null or year_built_to between 1000 and 3000)
        and (year_built_from is null or year_built_to is null or year_built_from <= year_built_to)
        and (radius_km is null or radius_km between 0 and 10000)
        and (target_yield_basis_points is null or target_yield_basis_points between 0 and 100000)
        and version >= 1
      ) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.buyer_search_profiles'::regclass and conname = 'buyer_search_profiles_broker_project_fk') then
    alter table public.buyer_search_profiles
      add constraint buyer_search_profiles_broker_project_fk
      foreign key (workspace_id, project_id) references public.projects(workspace_id, id)
      deferrable initially deferred not valid;
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.buyer_search_profiles'::regclass and conname = 'buyer_search_profiles_broker_contact_fk') then
    alter table public.buyer_search_profiles
      add constraint buyer_search_profiles_broker_contact_fk
      foreign key (workspace_id, contact_id) references public.contacts(workspace_id, id)
      deferrable initially deferred not valid;
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.buyer_search_profiles'::regclass and conname = 'buyer_search_profiles_broker_organization_fk') then
    alter table public.buyer_search_profiles
      add constraint buyer_search_profiles_broker_organization_fk
      foreign key (workspace_id, organization_id) references public.organizations(workspace_id, id)
      deferrable initially deferred not valid;
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.buyer_search_profiles'::regclass and conname = 'buyer_search_profiles_broker_owner_fk') then
    alter table public.buyer_search_profiles
      add constraint buyer_search_profiles_broker_owner_fk
      foreign key (workspace_id, owner_user_id) references public.workspace_users(workspace_id, id)
      deferrable initially deferred not valid;
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.buyer_search_profiles'::regclass and conname = 'buyer_search_profiles_broker_lead_fk') then
    alter table public.buyer_search_profiles
      add constraint buyer_search_profiles_broker_lead_fk
      foreign key (workspace_id, buyer_lead_id) references public.leads(workspace_id, id)
      deferrable initially deferred not valid;
  end if;
end;
$profile_constraints$;

create index if not exists buyer_search_profiles_broker_scope_idx
  on public.buyer_search_profiles(workspace_id, project_id, status, updated_at desc, id);
create index if not exists buyer_search_profiles_broker_owner_idx
  on public.buyer_search_profiles(workspace_id, owner_user_id, status, updated_at desc)
  where owner_user_id is not null;

create table if not exists public.broker_operation_requests (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  actor_user_id uuid not null,
  idempotency_key text not null,
  operation_type text not null,
  request_hash text not null,
  entity_type text,
  entity_id uuid,
  response_status integer,
  response_payload jsonb,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  constraint broker_operation_requests_workspace_fk
    foreign key (workspace_id) references public.workspaces(id) on delete cascade,
  constraint broker_operation_requests_actor_fk
    foreign key (workspace_id, actor_user_id) references public.workspace_users(workspace_id, id) on delete cascade,
  constraint broker_operation_requests_key_check check (char_length(idempotency_key) between 16 and 160),
  constraint broker_operation_requests_hash_check check (request_hash ~ '^[0-9a-f]{64}$'),
  unique (workspace_id, actor_user_id, idempotency_key)
);

create index if not exists broker_operation_requests_created_idx
  on public.broker_operation_requests(workspace_id, actor_user_id, created_at desc);

create table if not exists public.buyer_match_evaluations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  project_id uuid not null,
  search_profile_id uuid not null,
  target_kind text not null,
  seller_listing_id uuid,
  unit_id uuid,
  algorithm_version text not null,
  criteria_hash text not null,
  object_hash text not null,
  score integer not null,
  eligible boolean not null,
  availability text not null,
  matched_criteria jsonb not null default '[]',
  violated_criteria jsonb not null default '[]',
  evaluated_at timestamptz not null default now(),
  constraint buyer_match_evaluations_workspace_fk foreign key (workspace_id) references public.workspaces(id) on delete cascade,
  constraint buyer_match_evaluations_project_fk foreign key (workspace_id, project_id) references public.projects(workspace_id, id),
  constraint buyer_match_evaluations_profile_fk foreign key (workspace_id, search_profile_id) references public.buyer_search_profiles(workspace_id, id) on delete cascade,
  constraint buyer_match_evaluations_listing_fk foreign key (workspace_id, seller_listing_id) references public.seller_listings(workspace_id, id) on delete cascade,
  constraint buyer_match_evaluations_unit_fk foreign key (workspace_id, unit_id) references public.property_units(workspace_id, id) on delete cascade,
  constraint buyer_match_evaluations_target_check check (
    (target_kind = 'listing' and seller_listing_id is not null and unit_id is null)
    or (target_kind = 'unit' and unit_id is not null and seller_listing_id is null)
  ),
  constraint buyer_match_evaluations_score_check check (score between 0 and 100),
  constraint buyer_match_evaluations_availability_check check (availability in ('available', 'reserved_same', 'reserved_other', 'blocked', 'sold')),
  constraint buyer_match_evaluations_hash_check check (criteria_hash ~ '^[0-9a-f]{64}$' and object_hash ~ '^[0-9a-f]{64}$')
);

create unique index if not exists buyer_match_evaluations_listing_revision_uidx
  on public.buyer_match_evaluations(workspace_id, search_profile_id, seller_listing_id, algorithm_version, criteria_hash, object_hash)
  where seller_listing_id is not null;
create unique index if not exists buyer_match_evaluations_unit_revision_uidx
  on public.buyer_match_evaluations(workspace_id, search_profile_id, unit_id, algorithm_version, criteria_hash, object_hash)
  where unit_id is not null;
create index if not exists buyer_match_evaluations_profile_latest_idx
  on public.buyer_match_evaluations(workspace_id, search_profile_id, evaluated_at desc, id);

create table if not exists public.buyer_match_decisions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  project_id uuid not null,
  search_profile_id uuid not null,
  target_kind text not null,
  seller_listing_id uuid,
  unit_id uuid,
  status text not null default 'new',
  reason text,
  version bigint not null default 1,
  created_by_user_id uuid,
  updated_by_user_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint buyer_match_decisions_workspace_fk foreign key (workspace_id) references public.workspaces(id) on delete cascade,
  constraint buyer_match_decisions_project_fk foreign key (workspace_id, project_id) references public.projects(workspace_id, id),
  constraint buyer_match_decisions_profile_fk foreign key (workspace_id, search_profile_id) references public.buyer_search_profiles(workspace_id, id) on delete cascade,
  constraint buyer_match_decisions_listing_fk foreign key (workspace_id, seller_listing_id) references public.seller_listings(workspace_id, id) on delete cascade,
  constraint buyer_match_decisions_unit_fk foreign key (workspace_id, unit_id) references public.property_units(workspace_id, id) on delete cascade,
  constraint buyer_match_decisions_created_by_fk foreign key (workspace_id, created_by_user_id) references public.workspace_users(workspace_id, id) on delete set null (created_by_user_id),
  constraint buyer_match_decisions_updated_by_fk foreign key (workspace_id, updated_by_user_id) references public.workspace_users(workspace_id, id) on delete set null (updated_by_user_id),
  constraint buyer_match_decisions_target_check check (
    (target_kind = 'listing' and seller_listing_id is not null and unit_id is null)
    or (target_kind = 'unit' and unit_id is not null and seller_listing_id is null)
  ),
  constraint buyer_match_decisions_status_check check (status in ('new', 'shortlisted', 'declined', 'archived')),
  constraint buyer_match_decisions_version_check check (version >= 1)
);

create unique index if not exists buyer_match_decisions_listing_uidx
  on public.buyer_match_decisions(workspace_id, search_profile_id, seller_listing_id)
  where seller_listing_id is not null;
create unique index if not exists buyer_match_decisions_unit_uidx
  on public.buyer_match_decisions(workspace_id, search_profile_id, unit_id)
  where unit_id is not null;

create table if not exists public.broker_offers (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  project_id uuid not null,
  contact_id uuid not null,
  lead_id uuid,
  deal_id uuid,
  owner_user_id uuid,
  template_key text,
  recipient_email text not null,
  subject text not null,
  body_text text not null,
  address_visibility text not null default 'reduced',
  price_released boolean not null default false,
  commission_notice text not null default '',
  copy_owner boolean not null default false,
  status text not null default 'draft',
  current_version integer not null default 1,
  version bigint not null default 1,
  created_by_user_id uuid,
  updated_by_user_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint broker_offers_workspace_fk foreign key (workspace_id) references public.workspaces(id) on delete cascade,
  constraint broker_offers_project_fk foreign key (workspace_id, project_id) references public.projects(workspace_id, id),
  constraint broker_offers_contact_fk foreign key (workspace_id, contact_id) references public.contacts(workspace_id, id),
  constraint broker_offers_lead_fk foreign key (workspace_id, lead_id) references public.leads(workspace_id, id) on delete set null (lead_id),
  constraint broker_offers_deal_fk foreign key (workspace_id, deal_id) references public.deals(workspace_id, id) on delete set null (deal_id),
  constraint broker_offers_owner_fk foreign key (workspace_id, owner_user_id) references public.workspace_users(workspace_id, id) on delete set null (owner_user_id),
  constraint broker_offers_created_by_fk foreign key (workspace_id, created_by_user_id) references public.workspace_users(workspace_id, id) on delete set null (created_by_user_id),
  constraint broker_offers_updated_by_fk foreign key (workspace_id, updated_by_user_id) references public.workspace_users(workspace_id, id) on delete set null (updated_by_user_id),
  constraint broker_offers_address_visibility_check check (address_visibility in ('full', 'reduced', 'hidden')),
  constraint broker_offers_status_check check (status in ('draft', 'ready', 'withdrawn')),
  constraint broker_offers_version_check check (version >= 1 and current_version >= 1)
);

create unique index if not exists broker_offers_workspace_id_uidx on public.broker_offers(workspace_id, id);
create index if not exists broker_offers_scope_idx on public.broker_offers(workspace_id, project_id, status, updated_at desc, id);

create table if not exists public.broker_offer_items (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  project_id uuid not null,
  offer_id uuid not null,
  position integer not null,
  target_kind text not null,
  seller_listing_id uuid,
  unit_id uuid,
  display_address text not null default '',
  price_minor bigint,
  price_released boolean not null default false,
  selected_media_ids uuid[] not null default '{}',
  selected_document_ids uuid[] not null default '{}',
  web_offer_url text,
  pdf_document_id uuid,
  created_at timestamptz not null default now(),
  constraint broker_offer_items_workspace_fk foreign key (workspace_id) references public.workspaces(id) on delete cascade,
  constraint broker_offer_items_project_fk foreign key (workspace_id, project_id) references public.projects(workspace_id, id),
  constraint broker_offer_items_offer_fk foreign key (workspace_id, offer_id) references public.broker_offers(workspace_id, id) on delete cascade,
  constraint broker_offer_items_listing_fk foreign key (workspace_id, seller_listing_id) references public.seller_listings(workspace_id, id),
  constraint broker_offer_items_unit_fk foreign key (workspace_id, unit_id) references public.property_units(workspace_id, id),
  constraint broker_offer_items_pdf_document_fk foreign key (workspace_id, pdf_document_id) references public.property_documents(workspace_id, id) on delete set null (pdf_document_id),
  constraint broker_offer_items_target_check check (
    (target_kind = 'listing' and seller_listing_id is not null and unit_id is null)
    or (target_kind = 'unit' and unit_id is not null and seller_listing_id is null)
  ),
  constraint broker_offer_items_price_check check (price_minor is null or price_minor >= 0),
  unique (offer_id, position)
);

create index if not exists broker_offer_items_scope_idx on public.broker_offer_items(workspace_id, offer_id, position);

create table if not exists public.broker_offer_versions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  project_id uuid not null,
  offer_id uuid not null,
  version_number integer not null,
  snapshot jsonb not null,
  created_by_user_id uuid,
  created_at timestamptz not null default now(),
  constraint broker_offer_versions_workspace_fk foreign key (workspace_id) references public.workspaces(id) on delete cascade,
  constraint broker_offer_versions_project_fk foreign key (workspace_id, project_id) references public.projects(workspace_id, id),
  constraint broker_offer_versions_offer_fk foreign key (workspace_id, offer_id) references public.broker_offers(workspace_id, id) on delete cascade,
  constraint broker_offer_versions_created_by_fk foreign key (workspace_id, created_by_user_id) references public.workspace_users(workspace_id, id) on delete set null (created_by_user_id),
  unique (offer_id, version_number)
);

create table if not exists public.broker_offer_deliveries (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  project_id uuid not null,
  offer_id uuid not null,
  offer_version integer not null,
  recipient_email text not null,
  qa_only boolean not null default true,
  status text not null,
  failure_code text,
  provider_name text,
  provider_receipt_id text,
  provider_message text,
  attempted_by_user_id uuid,
  attempted_at timestamptz not null default now(),
  accepted_at timestamptz,
  constraint broker_offer_deliveries_workspace_fk foreign key (workspace_id) references public.workspaces(id) on delete cascade,
  constraint broker_offer_deliveries_project_fk foreign key (workspace_id, project_id) references public.projects(workspace_id, id),
  constraint broker_offer_deliveries_offer_fk foreign key (workspace_id, offer_id) references public.broker_offers(workspace_id, id) on delete cascade,
  constraint broker_offer_deliveries_attempted_by_fk foreign key (workspace_id, attempted_by_user_id) references public.workspace_users(workspace_id, id) on delete set null (attempted_by_user_id),
  constraint broker_offer_deliveries_status_check check (status in ('blocked_not_allowed', 'blocked_provider_unavailable', 'accepted', 'failed')),
  constraint broker_offer_deliveries_qa_only_check check (qa_only),
  constraint broker_offer_deliveries_provider_truth_check check (
    (status = 'accepted' and provider_receipt_id is not null and accepted_at is not null)
    or status <> 'accepted'
  )
);

create index if not exists broker_offer_deliveries_offer_idx
  on public.broker_offer_deliveries(workspace_id, offer_id, attempted_at desc);

alter table public.property_viewing_slots
  alter column unit_id drop not null,
  add column if not exists target_kind text not null default 'unit',
  add column if not exists property_id uuid,
  add column if not exists timezone text not null default 'Europe/Vienna',
  add column if not exists address_mode text not null default 'property',
  add column if not exists address_text text not null default '',
  add column if not exists personal_note text not null default '',
  add column if not exists internal_note text not null default '',
  add column if not exists invitation_status text not null default 'not_requested',
  add column if not exists reminder_at timestamptz,
  add column if not exists cancellation_reason text,
  add column if not exists calendar_event_id uuid,
  add column if not exists version bigint not null default 1,
  add column if not exists broker_operations_managed boolean not null default false;

do $viewing_constraints$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.property_viewing_slots'::regclass and conname = 'property_viewing_slots_broker_address_mode_check') then
    alter table public.property_viewing_slots add constraint property_viewing_slots_broker_address_mode_check
      check (address_mode in ('property', 'company', 'alternative', 'online')) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.property_viewing_slots'::regclass and conname = 'property_viewing_slots_broker_target_check') then
    alter table public.property_viewing_slots add constraint property_viewing_slots_broker_target_check
      check (
        (target_kind = 'listing' and property_id is not null and unit_id is null)
        or (target_kind = 'unit' and unit_id is not null and property_id is null)
      ) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.property_viewing_slots'::regclass and conname = 'property_viewing_slots_broker_invitation_status_check') then
    alter table public.property_viewing_slots add constraint property_viewing_slots_broker_invitation_status_check
      check (invitation_status in ('not_requested', 'blocked_provider_unavailable', 'accepted', 'failed')) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.property_viewing_slots'::regclass and conname = 'property_viewing_slots_broker_version_check') then
    alter table public.property_viewing_slots add constraint property_viewing_slots_broker_version_check check (version >= 1) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.property_viewing_slots'::regclass and conname = 'property_viewing_slots_broker_calendar_fk') then
    alter table public.property_viewing_slots add constraint property_viewing_slots_broker_calendar_fk
      foreign key (workspace_id, calendar_event_id) references public.calendar_events(workspace_id, id)
      on delete set null (calendar_event_id) deferrable initially deferred not valid;
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.property_viewing_slots'::regclass and conname = 'property_viewing_slots_broker_project_fk') then
    alter table public.property_viewing_slots add constraint property_viewing_slots_broker_project_fk
      foreign key (workspace_id, project_id) references public.projects(workspace_id, id) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.property_viewing_slots'::regclass and conname = 'property_viewing_slots_broker_property_fk') then
    alter table public.property_viewing_slots add constraint property_viewing_slots_broker_property_fk
      foreign key (workspace_id, property_id) references public.seller_listings(workspace_id, id) on delete set null (property_id) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.property_viewing_slots'::regclass and conname = 'property_viewing_slots_broker_unit_fk') then
    alter table public.property_viewing_slots add constraint property_viewing_slots_broker_unit_fk
      foreign key (workspace_id, unit_id) references public.property_units(workspace_id, id) on delete set null (unit_id) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.property_viewing_slots'::regclass and conname = 'property_viewing_slots_broker_contact_fk') then
    alter table public.property_viewing_slots add constraint property_viewing_slots_broker_contact_fk
      foreign key (workspace_id, contact_id) references public.contacts(workspace_id, id) on delete set null (contact_id) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.property_viewing_slots'::regclass and conname = 'property_viewing_slots_broker_lead_fk') then
    alter table public.property_viewing_slots add constraint property_viewing_slots_broker_lead_fk
      foreign key (workspace_id, lead_id) references public.leads(workspace_id, id) on delete set null (lead_id) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.property_viewing_slots'::regclass and conname = 'property_viewing_slots_broker_deal_fk') then
    alter table public.property_viewing_slots add constraint property_viewing_slots_broker_deal_fk
      foreign key (workspace_id, deal_id) references public.deals(workspace_id, id) on delete set null (deal_id) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.property_viewing_slots'::regclass and conname = 'property_viewing_slots_broker_owner_fk') then
    alter table public.property_viewing_slots add constraint property_viewing_slots_broker_owner_fk
      foreign key (workspace_id, owner_user_id) references public.workspace_users(workspace_id, id) on delete set null (owner_user_id) not valid;
  end if;
end;
$viewing_constraints$;

create table if not exists public.broker_viewing_history (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  project_id uuid not null,
  viewing_id uuid not null,
  actor_user_id uuid,
  event_type text not null,
  from_status text,
  to_status text,
  before jsonb,
  after jsonb not null,
  created_at timestamptz not null default now(),
  constraint broker_viewing_history_workspace_fk foreign key (workspace_id) references public.workspaces(id) on delete cascade,
  constraint broker_viewing_history_project_fk foreign key (workspace_id, project_id) references public.projects(workspace_id, id),
  constraint broker_viewing_history_viewing_fk foreign key (workspace_id, viewing_id) references public.property_viewing_slots(workspace_id, id) on delete cascade,
  constraint broker_viewing_history_actor_fk foreign key (workspace_id, actor_user_id) references public.workspace_users(workspace_id, id) on delete set null (actor_user_id),
  constraint broker_viewing_history_event_check check (event_type in ('created', 'updated', 'rescheduled', 'status_changed', 'calendar_projected', 'invitation_blocked'))
);

create index if not exists broker_viewing_history_viewing_idx
  on public.broker_viewing_history(workspace_id, viewing_id, created_at desc, id);

create table if not exists public.broker_closings (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  project_id uuid not null,
  target_kind text not null,
  seller_listing_id uuid,
  unit_id uuid,
  deal_id uuid not null,
  buyer_contact_id uuid not null,
  seller_contact_id uuid not null,
  reservation_id uuid,
  owner_user_id uuid,
  contract_type text not null,
  contract_date date,
  closing_date date,
  base_amount_minor bigint not null,
  buyer_commission_minor bigint not null,
  seller_commission_minor bigint not null,
  net_commission_minor bigint not null,
  tax_minor bigint not null,
  gross_commission_minor bigint not null,
  currency char(3) not null default 'EUR',
  service_period_start date,
  service_period_end date,
  payment_due_at date,
  payment_status text not null default 'unpaid',
  status text not null default 'draft',
  reversal_reason text,
  internal_notes text not null default '',
  version bigint not null default 1,
  created_by_user_id uuid,
  updated_by_user_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint broker_closings_workspace_fk foreign key (workspace_id) references public.workspaces(id) on delete cascade,
  constraint broker_closings_project_fk foreign key (workspace_id, project_id) references public.projects(workspace_id, id),
  constraint broker_closings_listing_fk foreign key (workspace_id, seller_listing_id) references public.seller_listings(workspace_id, id),
  constraint broker_closings_unit_fk foreign key (workspace_id, unit_id) references public.property_units(workspace_id, id),
  constraint broker_closings_deal_fk foreign key (workspace_id, deal_id) references public.deals(workspace_id, id),
  constraint broker_closings_buyer_fk foreign key (workspace_id, buyer_contact_id) references public.contacts(workspace_id, id),
  constraint broker_closings_seller_fk foreign key (workspace_id, seller_contact_id) references public.contacts(workspace_id, id),
  constraint broker_closings_reservation_fk foreign key (workspace_id, reservation_id) references public.property_reservations(workspace_id, id),
  constraint broker_closings_owner_fk foreign key (workspace_id, owner_user_id) references public.workspace_users(workspace_id, id) on delete set null (owner_user_id),
  constraint broker_closings_created_by_fk foreign key (workspace_id, created_by_user_id) references public.workspace_users(workspace_id, id) on delete set null (created_by_user_id),
  constraint broker_closings_updated_by_fk foreign key (workspace_id, updated_by_user_id) references public.workspace_users(workspace_id, id) on delete set null (updated_by_user_id),
  constraint broker_closings_target_check check (
    (target_kind = 'listing' and seller_listing_id is not null and unit_id is null)
    or (target_kind = 'unit' and unit_id is not null and seller_listing_id is null)
  ),
  constraint broker_closings_status_check check (status in ('draft', 'reviewed', 'signed', 'invoiced', 'paid', 'cancelled', 'reversed')),
  constraint broker_closings_payment_check check (payment_status in ('unpaid', 'partially_paid', 'paid', 'overdue', 'refunded')),
  constraint broker_closings_money_check check (
    base_amount_minor >= 0
    and buyer_commission_minor >= 0
    and seller_commission_minor >= 0
    and net_commission_minor >= 0
    and tax_minor >= 0
    and gross_commission_minor >= 0
    and gross_commission_minor <= base_amount_minor
    and net_commission_minor + tax_minor = gross_commission_minor
    and buyer_commission_minor + seller_commission_minor = gross_commission_minor
  ),
  constraint broker_closings_version_check check (version >= 1),
  constraint broker_closings_reversal_check check (
    status not in ('cancelled', 'reversed') or nullif(btrim(reversal_reason), '') is not null
  )
);

create unique index if not exists broker_closings_workspace_id_uidx on public.broker_closings(workspace_id, id);
create index if not exists broker_closings_scope_idx on public.broker_closings(workspace_id, project_id, status, updated_at desc, id);

create table if not exists public.broker_closing_participants (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  project_id uuid not null,
  closing_id uuid not null,
  user_id uuid not null,
  participant_role text not null,
  created_at timestamptz not null default now(),
  constraint broker_closing_participants_workspace_fk foreign key (workspace_id) references public.workspaces(id) on delete cascade,
  constraint broker_closing_participants_project_fk foreign key (workspace_id, project_id) references public.projects(workspace_id, id),
  constraint broker_closing_participants_closing_fk foreign key (workspace_id, closing_id) references public.broker_closings(workspace_id, id) on delete cascade,
  constraint broker_closing_participants_user_fk foreign key (workspace_id, user_id) references public.workspace_users(workspace_id, id),
  unique (closing_id, user_id, participant_role)
);

create table if not exists public.broker_commission_splits (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  project_id uuid not null,
  closing_id uuid not null,
  user_id uuid,
  label text,
  side text not null,
  source_side text not null,
  allocation_type text not null,
  basis_points integer,
  amount_minor bigint,
  computed_amount_minor bigint not null,
  created_by_user_id uuid,
  created_at timestamptz not null default now(),
  constraint broker_commission_splits_workspace_fk foreign key (workspace_id) references public.workspaces(id) on delete cascade,
  constraint broker_commission_splits_project_fk foreign key (workspace_id, project_id) references public.projects(workspace_id, id),
  constraint broker_commission_splits_closing_fk foreign key (workspace_id, closing_id) references public.broker_closings(workspace_id, id) on delete cascade,
  constraint broker_commission_splits_user_fk foreign key (workspace_id, user_id) references public.workspace_users(workspace_id, id) on delete set null (user_id),
  constraint broker_commission_splits_created_by_fk foreign key (workspace_id, created_by_user_id) references public.workspace_users(workspace_id, id) on delete set null (created_by_user_id),
  constraint broker_commission_splits_side_check check (side in ('buyer', 'seller', 'referral')),
  constraint broker_commission_splits_source_side_check check (source_side in ('buyer', 'seller')),
  constraint broker_commission_splits_attribution_check check (
    side = 'referral' or side = source_side
  ),
  constraint broker_commission_splits_recipient_check check (
    user_id is not null or nullif(btrim(label), '') is not null
  ),
  constraint broker_commission_splits_allocation_check check (
    (allocation_type = 'percentage' and basis_points between 0 and 10000 and amount_minor is null)
    or (allocation_type = 'absolute' and basis_points is null and amount_minor >= 0)
  ),
  constraint broker_commission_splits_computed_check check (computed_amount_minor >= 0)
);

create index if not exists broker_commission_splits_closing_idx
  on public.broker_commission_splits(workspace_id, closing_id, created_at, id);

alter table public.contact_timeline_items
  add column if not exists activity_type text not null default 'note',
  add column if not exists lead_id uuid,
  add column if not exists property_id uuid,
  add column if not exists unit_id uuid,
  add column if not exists deal_id uuid,
  add column if not exists reservation_id uuid,
  add column if not exists offer_id uuid,
  add column if not exists viewing_id uuid,
  add column if not exists closing_id uuid,
  add column if not exists owner_user_id uuid,
  add column if not exists version bigint not null default 1,
  add column if not exists broker_operations_managed boolean not null default false;

alter table public.tasks
  add column if not exists broker_activity_id uuid,
  add column if not exists property_id uuid,
  add column if not exists unit_id uuid,
  add column if not exists deal_id uuid,
  add column if not exists reservation_id uuid,
  add column if not exists offer_id uuid,
  add column if not exists viewing_id uuid,
  add column if not exists closing_id uuid;

do $activity_constraints$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.contact_timeline_items'::regclass and conname = 'contact_timeline_items_broker_activity_type_check') then
    alter table public.contact_timeline_items add constraint contact_timeline_items_broker_activity_type_check
      check (activity_type in ('call', 'email', 'viewing', 'note', 'offer', 'question', 'negotiation', 'document_sent', 'closing', 'other')) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.contact_timeline_items'::regclass and conname = 'contact_timeline_items_broker_version_check') then
    alter table public.contact_timeline_items add constraint contact_timeline_items_broker_version_check check (version >= 1) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.contact_timeline_items'::regclass and conname = 'contact_timeline_items_broker_offer_fk') then
    alter table public.contact_timeline_items add constraint contact_timeline_items_broker_offer_fk
      foreign key (workspace_id, offer_id) references public.broker_offers(workspace_id, id) on delete set null (offer_id) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.contact_timeline_items'::regclass and conname = 'contact_timeline_items_broker_project_fk') then
    alter table public.contact_timeline_items add constraint contact_timeline_items_broker_project_fk
      foreign key (workspace_id, project_id) references public.projects(workspace_id, id) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.contact_timeline_items'::regclass and conname = 'contact_timeline_items_broker_contact_fk') then
    alter table public.contact_timeline_items add constraint contact_timeline_items_broker_contact_fk
      foreign key (workspace_id, contact_id) references public.contacts(workspace_id, id) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.contact_timeline_items'::regclass and conname = 'contact_timeline_items_broker_lead_fk') then
    alter table public.contact_timeline_items add constraint contact_timeline_items_broker_lead_fk
      foreign key (workspace_id, lead_id) references public.leads(workspace_id, id) on delete set null (lead_id) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.contact_timeline_items'::regclass and conname = 'contact_timeline_items_broker_property_fk') then
    alter table public.contact_timeline_items add constraint contact_timeline_items_broker_property_fk
      foreign key (workspace_id, property_id) references public.seller_listings(workspace_id, id) on delete set null (property_id) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.contact_timeline_items'::regclass and conname = 'contact_timeline_items_broker_unit_fk') then
    alter table public.contact_timeline_items add constraint contact_timeline_items_broker_unit_fk
      foreign key (workspace_id, unit_id) references public.property_units(workspace_id, id) on delete set null (unit_id) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.contact_timeline_items'::regclass and conname = 'contact_timeline_items_broker_deal_fk') then
    alter table public.contact_timeline_items add constraint contact_timeline_items_broker_deal_fk
      foreign key (workspace_id, deal_id) references public.deals(workspace_id, id) on delete set null (deal_id) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.contact_timeline_items'::regclass and conname = 'contact_timeline_items_broker_reservation_fk') then
    alter table public.contact_timeline_items add constraint contact_timeline_items_broker_reservation_fk
      foreign key (workspace_id, reservation_id) references public.property_reservations(workspace_id, id) on delete set null (reservation_id) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.contact_timeline_items'::regclass and conname = 'contact_timeline_items_broker_owner_fk') then
    alter table public.contact_timeline_items add constraint contact_timeline_items_broker_owner_fk
      foreign key (workspace_id, owner_user_id) references public.workspace_users(workspace_id, id) on delete set null (owner_user_id) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.contact_timeline_items'::regclass and conname = 'contact_timeline_items_broker_viewing_fk') then
    alter table public.contact_timeline_items add constraint contact_timeline_items_broker_viewing_fk
      foreign key (workspace_id, viewing_id) references public.property_viewing_slots(workspace_id, id) on delete set null (viewing_id) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.contact_timeline_items'::regclass and conname = 'contact_timeline_items_broker_closing_fk') then
    alter table public.contact_timeline_items add constraint contact_timeline_items_broker_closing_fk
      foreign key (workspace_id, closing_id) references public.broker_closings(workspace_id, id) on delete set null (closing_id) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.tasks'::regclass and conname = 'tasks_broker_activity_fk') then
    alter table public.tasks add constraint tasks_broker_activity_fk
      foreign key (workspace_id, broker_activity_id) references public.contact_timeline_items(workspace_id, id) on delete set null (broker_activity_id) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.tasks'::regclass and conname = 'tasks_broker_property_fk') then
    alter table public.tasks add constraint tasks_broker_property_fk
      foreign key (workspace_id, property_id) references public.seller_listings(workspace_id, id) on delete set null (property_id) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.tasks'::regclass and conname = 'tasks_broker_unit_fk') then
    alter table public.tasks add constraint tasks_broker_unit_fk
      foreign key (workspace_id, unit_id) references public.property_units(workspace_id, id) on delete set null (unit_id) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.tasks'::regclass and conname = 'tasks_broker_deal_fk') then
    alter table public.tasks add constraint tasks_broker_deal_fk
      foreign key (workspace_id, deal_id) references public.deals(workspace_id, id) on delete set null (deal_id) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.tasks'::regclass and conname = 'tasks_broker_reservation_fk') then
    alter table public.tasks add constraint tasks_broker_reservation_fk
      foreign key (workspace_id, reservation_id) references public.property_reservations(workspace_id, id) on delete set null (reservation_id) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.tasks'::regclass and conname = 'tasks_broker_offer_fk') then
    alter table public.tasks add constraint tasks_broker_offer_fk
      foreign key (workspace_id, offer_id) references public.broker_offers(workspace_id, id) on delete set null (offer_id) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.tasks'::regclass and conname = 'tasks_broker_viewing_fk') then
    alter table public.tasks add constraint tasks_broker_viewing_fk
      foreign key (workspace_id, viewing_id) references public.property_viewing_slots(workspace_id, id) on delete set null (viewing_id) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.tasks'::regclass and conname = 'tasks_broker_closing_fk') then
    alter table public.tasks add constraint tasks_broker_closing_fk
      foreign key (workspace_id, closing_id) references public.broker_closings(workspace_id, id) on delete set null (closing_id) not valid;
  end if;
end;
$activity_constraints$;

create index if not exists contact_timeline_items_broker_scope_idx
  on public.contact_timeline_items(workspace_id, project_id, activity_type, occurred_at desc, id);
create index if not exists tasks_broker_activity_idx
  on public.tasks(workspace_id, broker_activity_id)
  where broker_activity_id is not null;

-- Every newly introduced Broker Operations table is subject to the same
-- transaction-local tenant and actor context as the application repositories.
-- Existing parent tables retain their separately staged RLS cutover state.
do $broker_rls$
declare
  table_name text;
begin
  foreach table_name in array array[
    'broker_operation_requests',
    'buyer_match_evaluations',
    'buyer_match_decisions',
    'broker_offers',
    'broker_offer_items',
    'broker_offer_versions',
    'broker_offer_deliveries',
    'broker_viewing_history',
    'broker_closings',
    'broker_closing_participants',
    'broker_commission_splits'
  ] loop
    execute format('alter table public.%I enable row level security', table_name);
    execute format('alter table public.%I force row level security', table_name);
    execute format(
      'create policy %I on public.%I for all using (workspace_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid and nullif(current_setting(''app.actor_id'', true), '''')::uuid is not null) with check (workspace_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid and nullif(current_setting(''app.actor_id'', true), '''')::uuid is not null)',
      table_name || '_tenant_policy',
      table_name
    );
  end loop;
end;
$broker_rls$;

drop policy broker_operation_requests_tenant_policy on public.broker_operation_requests;
create policy broker_operation_requests_actor_policy on public.broker_operation_requests
for all
using (
  workspace_id = nullif(current_setting('app.tenant_id', true), '')::uuid
  and actor_user_id = nullif(current_setting('app.actor_id', true), '')::uuid
)
with check (
  workspace_id = nullif(current_setting('app.tenant_id', true), '')::uuid
  and actor_user_id = nullif(current_setting('app.actor_id', true), '')::uuid
);

do $broker_grants$
declare
  app_role text;
begin
  foreach app_role in array array['novalure_app', 'novalure_tenant_app'] loop
    if exists (select 1 from pg_catalog.pg_roles where rolname = app_role) then
      execute format(
        'grant select, insert, update on table public.broker_operation_requests, public.buyer_match_evaluations, public.buyer_match_decisions, public.broker_offers, public.broker_closings to %I',
        app_role
      );
      execute format(
        'grant select, insert on table public.broker_offer_versions, public.broker_offer_deliveries, public.broker_viewing_history to %I',
        app_role
      );
      execute format(
        'grant select, insert, delete on table public.broker_offer_items, public.broker_closing_participants, public.broker_commission_splits to %I',
        app_role
      );
    end if;
  end loop;
end;
$broker_grants$;

comment on table public.broker_offer_deliveries is
  'Provider-truth ledger. Migration 081 permits QA-only blocked/failed attempts; accepted requires a real provider receipt.';
comment on table public.broker_closings is
  'Commercial closing truth only. It does not mutate reservation, unit or deal state while propertyReservationRelationshipSync remains LAUNCH-OFF.';
comment on column public.property_viewing_slots.invitation_status is
  'External invitation truth. Internal calendar projection never sets this field to accepted.';
