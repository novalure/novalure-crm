alter table seller_listings
  add column if not exists country text,
  add column if not exists federal_state text,
  add column if not exists postal_code text,
  add column if not exists city text,
  add column if not exists street text,
  add column if not exists house_number text,
  add column if not exists staircase text,
  add column if not exists door_top text,
  add column if not exists orientation text,
  add column if not exists key_info text,
  add column if not exists land_area_sqm numeric(12,2),
  add column if not exists usable_area_sqm numeric(12,2),
  add column if not exists built_area_sqm numeric(12,2),
  add column if not exists office_area_sqm numeric(12,2),
  add column if not exists warehouse_area_sqm numeric(12,2),
  add column if not exists free_area_sqm numeric(12,2),
  add column if not exists temporary_area_sqm numeric(12,2),
  add column if not exists attic_area_sqm numeric(12,2),
  add column if not exists total_area_sqm numeric(12,2),
  add column if not exists half_rooms numeric(4,1),
  add column if not exists gardens_count integer,
  add column if not exists cellar_count integer,
  add column if not exists balconies_count integer,
  add column if not exists terraces_count integer,
  add column if not exists loggias_count integer,
  add column if not exists wc_count integer,
  add column if not exists bathrooms_count integer,
  add column if not exists garages_count integer,
  add column if not exists storage_rooms_count integer,
  add column if not exists ceiling_height_m numeric(5,2),
  add column if not exists object_category text,
  add column if not exists sub_object_type text,
  add column if not exists is_residential boolean not null default false,
  add column if not exists is_commercial boolean not null default false,
  add column if not exists is_investment boolean not null default false,
  add column if not exists is_accessible boolean not null default false,
  add column if not exists is_centrally_accessible boolean not null default false,
  add column if not exists is_building_plot boolean not null default false,
  add column if not exists is_holiday_property boolean not null default false,
  add column if not exists land_register_number text,
  add column if not exists cadastral_municipality text,
  add column if not exists plot_number text,
  add column if not exists construction_type text,
  add column if not exists available_from date,
  add column if not exists max_rental_term_months integer,
  add column if not exists termination_waiver_until date,
  add column if not exists floors_count integer,
  add column if not exists attic_floors_count integer,
  add column if not exists mezzanine text,
  add column if not exists unit_floor integer,
  add column if not exists furnishing text,
  add column if not exists noise_level text,
  add column if not exists condition_label text,
  add column if not exists development_status text,
  add column if not exists building_condition text,
  add column if not exists turnkey boolean not null default false,
  add column if not exists ready_for_flooring boolean not null default false,
  add column if not exists last_renovation_year integer,
  add column if not exists energy_certificate_valid_until date,
  add column if not exists hwb_value numeric(10,2),
  add column if not exists hwb_class text,
  add column if not exists fgee_value numeric(10,2),
  add column if not exists fgee_class text,
  add column if not exists energy_disclaimer_auto boolean not null default true,
  add column if not exists purchase_price_cents bigint,
  add column if not exists gross_rent_cents bigint,
  add column if not exists operating_costs_cents bigint,
  add column if not exists heating_costs_cents bigint,
  add column if not exists other_costs_cents bigint,
  add column if not exists deposit_cents bigint,
  add column if not exists rent_commission text,
  add column if not exists purchase_commission text,
  add column if not exists seller_commission text,
  add column if not exists real_estate_transfer_tax_cents bigint,
  add column if not exists land_register_fee_cents bigint,
  add column if not exists contract_setup_costs_cents bigint,
  add column if not exists stamp_duty_cents bigint,
  add column if not exists transfer_fee_cents bigint,
  add column if not exists development_costs_cents bigint,
  add column if not exists housing_subsidy_cents bigint,
  add column if not exists repair_reserve_cents bigint,
  add column if not exists net_income_month_cents bigint,
  add column if not exists net_income_year_cents bigint,
  add column if not exists yield_percent numeric(7,3),
  add column if not exists old_building_renovation text,
  add column if not exists seller_data jsonb not null default '{}',
  add column if not exists equipment jsonb not null default '{}',
  add column if not exists expose_content jsonb not null default '{}',
  add column if not exists document_status text not null default 'draft',
  add column if not exists property_status text not null default 'draft',
  add column if not exists internal_notes text,
  add column if not exists confirmation_audit jsonb not null default '{}',
  add column if not exists canonical_payload jsonb not null default '{}',
  add column if not exists channel_summary jsonb not null default '{}';

create table if not exists property_media (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  project_id uuid references projects(id) on delete set null,
  property_id uuid references seller_listings(id) on delete cascade,
  unit_id uuid references property_units(id) on delete cascade,
  media_asset_id uuid references media_assets(id) on delete set null,
  media_type text not null default 'image',
  title text not null default '',
  alt_text text not null default '',
  position integer not null default 0,
  status text not null default 'draft',
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists property_documents (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  project_id uuid references projects(id) on delete set null,
  property_id uuid references seller_listings(id) on delete cascade,
  unit_id uuid references property_units(id) on delete cascade,
  media_asset_id uuid references media_assets(id) on delete set null,
  title text not null,
  category text not null default 'document',
  status text not null default 'draft' check (status in ('draft', 'needs_review', 'approved', 'sent', 'archived')),
  content jsonb not null default '{}',
  approved_by_user_id uuid references workspace_users(id) on delete set null,
  approved_at timestamptz,
  sent_at timestamptz,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists property_channels (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  project_id uuid references projects(id) on delete set null,
  property_id uuid references seller_listings(id) on delete cascade,
  unit_id uuid references property_units(id) on delete cascade,
  channel_type text not null,
  channel_name text not null,
  status text not null default 'draft' check (status in ('draft', 'ready', 'published', 'paused', 'error', 'needs_review')),
  preflight_checks jsonb not null default '[]',
  field_mapping jsonb not null default '{}',
  last_export_job_id uuid,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists property_inquiries (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  project_id uuid references projects(id) on delete set null,
  property_id uuid references seller_listings(id) on delete set null,
  unit_id uuid references property_units(id) on delete set null,
  contact_id uuid references contacts(id) on delete set null,
  lead_id uuid references leads(id) on delete set null,
  source_channel text not null default 'Manual',
  campaign text,
  funnel_id uuid references funnels(id) on delete set null,
  form_id uuid references forms(id) on delete set null,
  owner_user_id uuid references workspace_users(id) on delete set null,
  routing_reason text not null default '',
  confidence_score numeric(5,2) not null default 0,
  duplicate_group_key text not null default '',
  status text not null default 'routed' check (status in ('new', 'routed', 'waitlist', 'follow_up', 'duplicate', 'archived')),
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists property_export_jobs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  property_channel_id uuid references property_channels(id) on delete set null,
  project_id uuid references projects(id) on delete set null,
  property_id uuid references seller_listings(id) on delete set null,
  unit_id uuid references property_units(id) on delete set null,
  portal text not null default '',
  export_format text not null default 'openimmo_1_2_7c',
  status text not null default 'queued' check (status in ('queued', 'running', 'completed', 'failed', 'cancelled')),
  preflight_status text not null default 'needs_review',
  payload_reference text,
  error text,
  started_by_user_id uuid references workspace_users(id) on delete set null,
  started_at timestamptz,
  finished_at timestamptz,
  export_history jsonb not null default '[]',
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists property_openimmo_mappings (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  property_channel_id uuid references property_channels(id) on delete cascade,
  portal_key text not null default '',
  source_field text not null,
  target_path text not null,
  required boolean not null default false,
  transform text,
  validation_rule text,
  status text not null default 'draft',
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists property_data_quality_issues (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  project_id uuid references projects(id) on delete set null,
  property_id uuid references seller_listings(id) on delete cascade,
  unit_id uuid references property_units(id) on delete cascade,
  severity text not null default 'warning',
  issue_type text not null,
  message text not null default '',
  status text not null default 'open',
  detected_at timestamptz not null default now(),
  resolved_at timestamptz,
  metadata jsonb not null default '{}'
);

create table if not exists property_activity_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  project_id uuid references projects(id) on delete set null,
  property_id uuid references seller_listings(id) on delete set null,
  unit_id uuid references property_units(id) on delete set null,
  contact_id uuid references contacts(id) on delete set null,
  lead_id uuid references leads(id) on delete set null,
  reservation_id uuid references property_reservations(id) on delete set null,
  actor_user_id uuid references workspace_users(id) on delete set null,
  event_type text not null,
  title text not null,
  detail text not null default '',
  occurred_at timestamptz not null default now(),
  metadata jsonb not null default '{}'
);

create index if not exists seller_listings_workspace_status_idx
  on seller_listings(workspace_id, property_status, updated_at desc);
create index if not exists property_media_workspace_property_idx
  on property_media(workspace_id, property_id, position);
create index if not exists property_documents_workspace_status_idx
  on property_documents(workspace_id, status, updated_at desc);
create index if not exists property_channels_workspace_status_idx
  on property_channels(workspace_id, status, updated_at desc);
create index if not exists property_inquiries_workspace_route_idx
  on property_inquiries(workspace_id, project_id, property_id, unit_id, created_at desc);
create index if not exists property_inquiries_duplicate_idx
  on property_inquiries(workspace_id, duplicate_group_key)
  where duplicate_group_key <> '';
create index if not exists property_export_jobs_workspace_status_idx
  on property_export_jobs(workspace_id, status, created_at desc);
create index if not exists property_openimmo_mappings_channel_idx
  on property_openimmo_mappings(workspace_id, property_channel_id, portal_key);
create index if not exists property_data_quality_workspace_status_idx
  on property_data_quality_issues(workspace_id, status, severity, detected_at desc);
create index if not exists property_activity_workspace_entity_idx
  on property_activity_events(workspace_id, property_id, unit_id, occurred_at desc);

insert into workspace_module_settings (workspace_id, module_key, enabled, reason, metadata)
select
  w.id,
  module_key,
  true,
  'property department is visible for every role and workspace type',
  '{"source":"034_property_department"}'::jsonb
from workspaces w
cross join unnest(array['properties', 'objectsMandates', 'units', 'reservations', 'projectOverview']) as modules(module_key)
on conflict (workspace_id, module_key) do update set
  enabled = true,
  reason = excluded.reason,
  metadata = workspace_module_settings.metadata || excluded.metadata,
  updated_at = now();

update workspaces
set setup_state = jsonb_set(
  coalesce(setup_state, '{}'::jsonb),
  '{enabledModules}',
  coalesce(setup_state->'enabledModules', '{}'::jsonb) ||
    jsonb_build_object(
      'properties', true,
      'objectsMandates', true,
      'units', true,
      'reservations', true,
      'projectOverview', true
    ),
  true
)
where coalesce(setup_state->'enabledModules', '{}'::jsonb) ?| array['objectsMandates', 'units', 'reservations', 'projectOverview']
   or not (coalesce(setup_state->'enabledModules', '{}'::jsonb) ? 'properties');
