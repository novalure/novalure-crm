with default_unit_candidates as (
  select
    sl.id as listing_id,
    sl.workspace_id,
    sl.project_id,
    concat('DEFAULT-', upper(left(replace(sl.id::text, '-', ''), 12))) as unit_number,
    coalesce(sl.rooms, 0) as rooms,
    coalesce(sl.area_sqm, 0) as area_sqm,
    coalesce(
      nullif(sl.target_price_cents, 0),
      nullif(sl.market_value_cents, 0),
      sl.public_price_cents,
      sl.rent_price_cents,
      0
    ) as price_cents
  from seller_listings sl
  where sl.unit_id is null
    and sl.project_id is not null
    and not exists (
      select 1
      from property_units pu
      where pu.workspace_id = sl.workspace_id
        and pu.project_id = sl.project_id
        and not (pu.metadata @> '{"defaultUnit": true}'::jsonb)
    )
),
upserted_default_units as (
  insert into property_units (
    workspace_id,
    project_id,
    unit_number,
    floor,
    rooms,
    area_sqm,
    price_cents,
    status,
    metadata
  )
  select
    workspace_id,
    project_id,
    unit_number,
    0,
    rooms,
    area_sqm,
    price_cents,
    'available',
    jsonb_build_object(
      'defaultUnit',
      true,
      'hidden',
      true,
      'sellerListingId',
      listing_id::text,
      'source',
      '038_property_default_units'
    )
  from default_unit_candidates
  on conflict (project_id, unit_number)
  do update set
    rooms = excluded.rooms,
    area_sqm = excluded.area_sqm,
    price_cents = excluded.price_cents,
    metadata = property_units.metadata || excluded.metadata,
    updated_at = now()
  returning id, metadata
),
default_unit_listing_map as (
  select
    id as unit_id,
    (metadata->>'sellerListingId')::uuid as listing_id
  from upserted_default_units
  where metadata ? 'sellerListingId'
)
update seller_listings sl
set
  unit_id = m.unit_id,
  canonical_payload = sl.canonical_payload || jsonb_build_object(
    'defaultUnitId',
    m.unit_id::text,
    'defaultUnitSource',
    '038_property_default_units'
  ),
  updated_at = now()
from default_unit_listing_map m
where sl.id = m.listing_id
  and sl.unit_id is null;
