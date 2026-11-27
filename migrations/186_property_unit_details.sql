-- Additive structured unit details. No guessed backfill: unknown remains NULL.
-- Existing forced RLS, grants, price confirmation and source-change triggers stay in force.
alter table public.property_units
 add column balcony_area_sqm numeric(10,2),
 add column terrace_area_sqm numeric(10,2),
 add column garden_area_sqm numeric(10,2),
 add column loggia_area_sqm numeric(10,2),
 add column roof_terrace_area_sqm numeric(10,2),
 add column underground_parking_count integer,
 add column carport_count integer,
 add column outdoor_parking_count integer,
 add column investor_price_cents bigint,
 add column bedrooms integer,
 add column heating_year integer,
 add constraint property_unit_details_nonnegative check (
  balcony_area_sqm between 0 and 99999999.99 and terrace_area_sqm between 0 and 99999999.99 and garden_area_sqm between 0 and 99999999.99
  and loggia_area_sqm between 0 and 99999999.99 and roof_terrace_area_sqm between 0 and 99999999.99
  and underground_parking_count between 0 and 10000 and carport_count between 0 and 10000 and outdoor_parking_count between 0 and 10000
  and investor_price_cents between 0 and 9007199254740991 and bedrooms between 0 and 100 and heating_year between 1800 and 2200
 );
comment on column public.property_units.investor_price_cents is 'Optional second investor price in EUR cents; requires explicit project price authority and documented confirmation. Not a public-price override.';
comment on column public.property_units.heating_year is 'Heating installation year for this unit; NULL means unknown. No inferred building-year fallback.';
