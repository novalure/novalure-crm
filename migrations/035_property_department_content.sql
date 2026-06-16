alter table seller_listings
  add column if not exists object_number text,
  add column if not exists internal_reference text,
  add column if not exists external_portal_id text,
  add column if not exists openimmo_object_id text,
  add column if not exists unit_id uuid references property_units(id) on delete set null,
  add column if not exists mandate_id uuid references broker_mandates(id) on delete set null,
  add column if not exists owner_contact_id uuid references contacts(id) on delete set null,
  add column if not exists owner_user_id uuid references workspace_users(id) on delete set null,
  add column if not exists contact_user_id uuid references workspace_users(id) on delete set null,
  add column if not exists contact_name text,
  add column if not exists contact_phone text,
  add column if not exists contact_email text,
  add column if not exists marketing_type text not null default 'sale',
  add column if not exists usage_type text,
  add column if not exists sub_object_type_custom text,
  add column if not exists available_from_text text,
  add column if not exists availability_note text,
  add column if not exists price_visibility text not null default 'publish_price',
  add column if not exists channel_price_visibility jsonb not null default '{}',
  add column if not exists public_price_cents bigint,
  add column if not exists rent_price_cents bigint,
  add column if not exists rent_net_cents bigint,
  add column if not exists monthly_costs_gross_cents bigint,
  add column if not exists purchase_ancillary_costs_cents bigint,
  add column if not exists costs_summary jsonb not null default '{}',
  add column if not exists gdpr_status text not null default 'needs_review',
  add column if not exists portal_mapping_status text not null default 'needs_review',
  add column if not exists media_summary jsonb not null default '{}',
  add column if not exists document_summary jsonb not null default '{}',
  add column if not exists text_summary jsonb not null default '{}';

alter table property_media
  add column if not exists category text not null default 'gallery',
  add column if not exists visibility text not null default 'public',
  add column if not exists is_cover boolean not null default false,
  add column if not exists approved_by_user_id uuid references workspace_users(id) on delete set null,
  add column if not exists approved_at timestamptz;

alter table property_documents
  add column if not exists visibility text not null default 'private',
  add column if not exists document_date date,
  add column if not exists version_label text,
  add column if not exists required_for_publication boolean not null default false;

alter table property_channels
  add column if not exists price_visibility_override text,
  add column if not exists text_variant_key text,
  add column if not exists media_visibility_filter text not null default 'public',
  add column if not exists document_visibility_filter text not null default 'public',
  add column if not exists channel_payload jsonb not null default '{}';

create table if not exists property_text_blocks (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  project_id uuid references projects(id) on delete set null,
  property_id uuid references seller_listings(id) on delete cascade,
  unit_id uuid references property_units(id) on delete cascade,
  text_key text not null,
  channel text not null default 'all',
  title text not null default '',
  content text not null default '',
  seo_title text,
  seo_description text,
  visibility text not null default 'public',
  status text not null default 'draft',
  position integer not null default 0,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(workspace_id, property_id, unit_id, text_key, channel)
);

create table if not exists property_cost_items (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  project_id uuid references projects(id) on delete set null,
  property_id uuid references seller_listings(id) on delete cascade,
  unit_id uuid references property_units(id) on delete cascade,
  cost_key text not null,
  group_key text not null default 'monthly',
  label text not null,
  monthly_net_cents bigint not null default 0,
  monthly_vat_cents bigint not null default 0,
  monthly_gross_cents bigint not null default 0,
  one_time_net_cents bigint not null default 0,
  one_time_vat_cents bigint not null default 0,
  one_time_gross_cents bigint not null default 0,
  vat_percent numeric(6,3),
  optional boolean not null default false,
  commission_relevant boolean not null default false,
  expose_visible boolean not null default true,
  internal_note text,
  position integer not null default 0,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(workspace_id, property_id, unit_id, cost_key)
);

create index if not exists seller_listings_workspace_object_number_idx
  on seller_listings(workspace_id, object_number)
  where object_number is not null;
create index if not exists seller_listings_workspace_price_visibility_idx
  on seller_listings(workspace_id, price_visibility, updated_at desc);
create index if not exists property_text_blocks_workspace_property_idx
  on property_text_blocks(workspace_id, property_id, channel, text_key);
create index if not exists property_cost_items_workspace_property_idx
  on property_cost_items(workspace_id, property_id, group_key, position);
create index if not exists property_media_workspace_category_idx
  on property_media(workspace_id, property_id, category, position);
create index if not exists property_documents_workspace_category_idx
  on property_documents(workspace_id, property_id, category, status);
