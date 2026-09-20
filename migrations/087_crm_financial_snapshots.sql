-- G27: append-only historical money/tax facts and the exact Evelyn FinancialSnapshotV1 boundary.
-- This migration does not seed policy content. Legacy values remain NEEDS_REVIEW unless their
-- historical source proves every required dimension; current mutable amounts are never copied.
set local lock_timeout = '5s';
set local statement_timeout = '14min';

-- FinancialSnapshotV1 permits up to 78 decimal digits. Historical aggregate
-- storage must preserve that exact integer range instead of narrowing it to int64.
alter table crm_conversion_snapshots
  alter column closed_revenue_cents type numeric(78,0) using closed_revenue_cents::numeric;

create or replace function crm_financial_json_keys_exact(p_value jsonb,p_keys text[])
returns boolean language plpgsql immutable strict set search_path=pg_catalog,public as $$
declare actual text[];
begin
  if jsonb_typeof(p_value)<>'object' then return false; end if;
  select coalesce(array_agg(key order by key collate "C"),'{}'::text[]) into actual from jsonb_object_keys(p_value) key;
  return actual=(select coalesce(array_agg(key order by key collate "C"),'{}'::text[]) from unnest(p_keys) key);
end $$;

create or replace function crm_financial_canonical_json(p_value jsonb)
returns text language plpgsql immutable strict set search_path=pg_catalog,public as $$
declare result text;
begin
  case jsonb_typeof(p_value)
    when 'object' then
      select '{'||coalesce(string_agg(to_json(key)::text||':'||crm_financial_canonical_json(value),',' order by key collate "C"),'')||'}'
        into result from jsonb_each(p_value);
    when 'array' then
      select '['||coalesce(string_agg(crm_financial_canonical_json(value),',' order by ordinal),'')||']'
        into result from jsonb_array_elements(p_value) with ordinality item(value,ordinal);
    else result:=p_value::text;
  end case;
  return result;
end $$;

create or replace function crm_financial_sha256(p_value jsonb)
returns text language sql immutable strict set search_path=pg_catalog,public as $$
  select encode(digest(convert_to(crm_financial_canonical_json(p_value),'UTF8'),'sha256'),'hex')
$$;

create or replace function crm_financial_snapshot_hash(p_snapshot jsonb)
returns text language sql immutable strict set search_path=pg_catalog,public as $$
  select crm_financial_sha256(jsonb_build_object('hashContractVersion','financial-snapshot-hash-v1','snapshot',p_snapshot))
$$;

create or replace function crm_financial_policy_hash(p_policy jsonb)
returns text language sql immutable strict set search_path=pg_catalog,public as $$
  select crm_financial_sha256(jsonb_build_object('hashContractVersion','crm-financial-policy-content-hash-v1','policy',p_policy))
$$;

create or replace function crm_financial_deterministic_uuid(p_identity text)
returns uuid language sql immutable strict set search_path=pg_catalog,public as $$
  select (substring(value,1,8)||'-'||substring(value,9,4)||'-4'||substring(value,14,3)||'-8'||substring(value,18,3)||'-'||substring(value,21,12))::uuid
  from (select encode(digest(convert_to('novalure-crm:g27:'||p_identity,'UTF8'),'sha256'),'hex') value) hashed
$$;

create or replace function crm_financial_iso_instant_valid(p_value text)
returns boolean language plpgsql immutable strict set search_path=pg_catalog,public as $$
begin
  if p_value !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$' then return false; end if;
  return to_char(p_value::timestamptz at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')=p_value;
exception when others then return false;
end $$;

create or replace function crm_financial_money_v2_valid(p_value jsonb,p_currency text default null,p_exponent integer default null)
returns boolean language plpgsql immutable set search_path=pg_catalog,public as $$
begin
  if p_value is null or jsonb_typeof(p_value)<>'object'
     or not crm_financial_json_keys_exact(p_value,array['minorUnits','currency','minorUnitExponent'])
     or jsonb_typeof(p_value->'minorUnits')<>'string'
     or (p_value->>'minorUnits') !~ '^(?:0|-?[1-9][0-9]{0,77})$'
     or jsonb_typeof(p_value->'currency')<>'string' or (p_value->>'currency') !~ '^[A-Z]{3}$'
     or jsonb_typeof(p_value->'minorUnitExponent')<>'number'
     or (p_value->>'minorUnitExponent') !~ '^[0-9]$' then return false; end if;
  if p_currency is not null and p_value->>'currency'<>p_currency then return false; end if;
  if p_exponent is not null and (p_value->>'minorUnitExponent')::integer<>p_exponent then return false; end if;
  return true;
end $$;

create or replace function crm_financial_versioned_ref_valid(p_value jsonb)
returns boolean language sql immutable set search_path=pg_catalog,public as $$
  select coalesce(p_value is not null and jsonb_typeof(p_value)='object'
    and crm_financial_json_keys_exact(p_value,array['id','version','contentHash'])
    and jsonb_typeof(p_value->'id')='string' and length(p_value->>'id') between 1 and 200
      and p_value->>'id'=btrim(p_value->>'id') and (p_value->>'id') !~ '[[:cntrl:]]'
    and jsonb_typeof(p_value->'version')='string' and length(p_value->>'version') between 1 and 200
      and p_value->>'version'=btrim(p_value->>'version') and (p_value->>'version') !~ '[[:cntrl:]]'
    and jsonb_typeof(p_value->'contentHash')='string' and (p_value->>'contentHash') ~ '^[a-f0-9]{64}$',false)
$$;

create or replace function crm_financial_currency_definition_valid(p_value jsonb,p_currency text,p_exponent integer)
returns boolean language sql immutable set search_path=pg_catalog,public as $$
  select coalesce(p_value is not null and jsonb_typeof(p_value)='object'
    and crm_financial_json_keys_exact(p_value,array['standard','code','minorUnitExponent','registryReference','verifiedAt'])
    and p_value->>'standard'='ISO-4217' and p_value->>'code'=p_currency
    and jsonb_typeof(p_value->'minorUnitExponent')='number'
    and (p_value->>'minorUnitExponent') ~ '^[0-9]$' and (p_value->>'minorUnitExponent')::integer=p_exponent
    and crm_financial_versioned_ref_valid(p_value->'registryReference')
    and crm_financial_iso_instant_valid(p_value->>'verifiedAt'),false)
$$;

create or replace function crm_financial_provenance_valid(p_value jsonb)
returns boolean language sql immutable set search_path=pg_catalog,public as $$
  select coalesce(p_value is not null and jsonb_typeof(p_value)='object'
    and crm_financial_json_keys_exact(p_value,array['sourceSystem','sourceRecordId','sourceVersion','sourceHash','recordedAt','recordedBy'])
    and jsonb_typeof(p_value->'sourceSystem')='string' and length(p_value->>'sourceSystem') between 1 and 200 and p_value->>'sourceSystem'=btrim(p_value->>'sourceSystem') and (p_value->>'sourceSystem') !~ '[[:cntrl:]]'
    and jsonb_typeof(p_value->'sourceRecordId')='string' and length(p_value->>'sourceRecordId') between 1 and 200 and p_value->>'sourceRecordId'=btrim(p_value->>'sourceRecordId') and (p_value->>'sourceRecordId') !~ '[[:cntrl:]]'
    and jsonb_typeof(p_value->'sourceVersion')='string' and length(p_value->>'sourceVersion') between 1 and 200 and p_value->>'sourceVersion'=btrim(p_value->>'sourceVersion') and (p_value->>'sourceVersion') !~ '[[:cntrl:]]'
    and jsonb_typeof(p_value->'sourceHash')='string' and (p_value->>'sourceHash') ~ '^[a-f0-9]{64}$'
    and crm_financial_iso_instant_valid(p_value->>'recordedAt')
    and jsonb_typeof(p_value->'recordedBy')='string' and length(p_value->>'recordedBy') between 1 and 200 and p_value->>'recordedBy'=btrim(p_value->>'recordedBy') and (p_value->>'recordedBy') !~ '[[:cntrl:]]',false)
$$;

create or replace function crm_financial_policy_payload_valid(p_value jsonb)
returns boolean language plpgsql immutable set search_path=pg_catalog,public as $$
declare kind text; source jsonb; rate jsonb;
begin
  if p_value is null or jsonb_typeof(p_value)<>'object' then return false; end if;
  kind:=p_value->>'kind';
  if kind='CURRENCY' then
    return coalesce(crm_financial_json_keys_exact(p_value,array['policySchemaVersion','kind','standard','code','minorUnitExponent','verifiedAt'])
      and p_value->>'policySchemaVersion'='crm-currency-policy-v1' and p_value->>'standard'='ISO-4217'
      and (p_value->>'code') ~ '^[A-Z]{3}$' and jsonb_typeof(p_value->'minorUnitExponent')='number'
      and (p_value->>'minorUnitExponent') ~ '^[0-9]$' and crm_financial_iso_instant_valid(p_value->>'verifiedAt'),false);
  elsif kind='ROUNDING' then
    return coalesce(crm_financial_json_keys_exact(p_value,array['policySchemaVersion','kind','mode','currencyExponent','scope'])
      and p_value->>'policySchemaVersion'='crm-rounding-policy-v1'
      and p_value->>'mode' in('TRUNCATE','AWAY_FROM_ZERO','HALF_UP','HALF_EVEN')
      and jsonb_typeof(p_value->'currencyExponent')='number' and (p_value->>'currencyExponent') ~ '^[0-9]$'
      and p_value->>'scope'='TAX_COMPONENT',false);
  elsif kind='TAX' then
    if not coalesce(crm_financial_json_keys_exact(p_value,array['policySchemaVersion','kind','jurisdiction','treatment','category','rate','sourceProvenance'])
       and jsonb_typeof(p_value->'policySchemaVersion')='string' and p_value->>'policySchemaVersion'='crm-tax-policy-v1'
       and jsonb_typeof(p_value->'kind')='string' and p_value->>'kind'='TAX'
       and jsonb_typeof(p_value->'jurisdiction')='string' and (p_value->>'jurisdiction') ~ '^[A-Z0-9][A-Z0-9._:-]{0,79}$'
       and jsonb_typeof(p_value->'treatment')='string' and length(p_value->>'treatment') between 1 and 200 and p_value->>'treatment'=btrim(p_value->>'treatment') and (p_value->>'treatment') !~ '[[:cntrl:]]'
       and jsonb_typeof(p_value->'category')='string' and length(p_value->>'category') between 1 and 200 and p_value->>'category'=btrim(p_value->>'category') and (p_value->>'category') !~ '[[:cntrl:]]',false) then return false; end if;
    rate:=p_value->'rate'; source:=p_value->'sourceProvenance';
    return coalesce(crm_financial_json_keys_exact(rate,array['basis','numerator','denominator'])
      and jsonb_typeof(rate->'basis')='string' and rate->>'basis'='NET'
      and jsonb_typeof(rate->'numerator')='string' and (rate->>'numerator') ~ '^(?:0|[1-9][0-9]{0,77})$'
      and jsonb_typeof(rate->'denominator')='string' and (rate->>'denominator') ~ '^[1-9][0-9]{0,77}$'
      and crm_financial_json_keys_exact(source,array['authority','sourceReference','jurisdiction','effectiveFrom','effectiveTo','policyVersion','verifiedAt'])
      and jsonb_typeof(source->'jurisdiction')='string' and source->>'jurisdiction'=p_value->>'jurisdiction'
      and jsonb_typeof(source->'authority')='string' and length(source->>'authority') between 1 and 200 and source->>'authority'=btrim(source->>'authority') and (source->>'authority') !~ '[[:cntrl:]]'
      and jsonb_typeof(source->'sourceReference')='string' and length(source->>'sourceReference') between 1 and 200 and source->>'sourceReference'=btrim(source->>'sourceReference') and (source->>'sourceReference') !~ '[[:cntrl:]]'
      and jsonb_typeof(source->'policyVersion')='string' and length(source->>'policyVersion') between 1 and 200 and source->>'policyVersion'=btrim(source->>'policyVersion') and (source->>'policyVersion') !~ '[[:cntrl:]]'
      and jsonb_typeof(source->'effectiveFrom')='string' and crm_financial_iso_instant_valid(source->>'effectiveFrom')
      and jsonb_typeof(source->'verifiedAt')='string' and crm_financial_iso_instant_valid(source->>'verifiedAt')
      and (source->'effectiveTo'='null'::jsonb or jsonb_typeof(source->'effectiveTo')='string'
        and crm_financial_iso_instant_valid(source->>'effectiveTo') and source->>'effectiveFrom'<source->>'effectiveTo'),false);
  end if;
  return false;
exception when others then return false;
end $$;

create or replace function crm_financial_components_valid(p_components jsonb,p_currency text,p_exponent integer,p_jurisdiction text,p_totals jsonb,p_effective_at text)
returns boolean language plpgsql immutable set search_path=pg_catalog,public as $$
declare component jsonb; tax_component jsonb; policy jsonb; source jsonb;
  component_id text; tax_id text; previous_component text; previous_tax text;
  all_ids text[]:='{}'; net_sum numeric:=0; tax_sum numeric:=0; gross_sum numeric:=0; component_tax numeric;
begin
  if p_components is null or jsonb_typeof(p_components)<>'array' or jsonb_array_length(p_components) not between 1 and 100 then return false; end if;
  for component in select value from jsonb_array_elements(p_components) loop
    if not crm_financial_json_keys_exact(component,array['componentId','kind','net','tax','gross','taxComponents','pricingReference']) then return false; end if;
    component_id:=component->>'componentId';
    if component_id is null or component_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$' or component_id=any(all_ids) or (previous_component is not null and component_id collate "C" <= previous_component collate "C") then return false; end if;
    all_ids:=array_append(all_ids,component_id); previous_component:=component_id;
    if jsonb_typeof(component->'kind')<>'string' or component->>'kind' not in ('LINE','DISCOUNT','ADJUSTMENT')
       or not crm_financial_money_v2_valid(component->'net',p_currency,p_exponent)
       or not crm_financial_money_v2_valid(component->'tax',p_currency,p_exponent)
       or not crm_financial_money_v2_valid(component->'gross',p_currency,p_exponent)
       or not crm_financial_versioned_ref_valid(component->'pricingReference') then return false; end if;
    if component->>'kind'='LINE' and ((component#>>'{net,minorUnits}')::numeric<0 or (component#>>'{tax,minorUnits}')::numeric<0 or (component#>>'{gross,minorUnits}')::numeric<0) then return false; end if;
    if component->>'kind'='DISCOUNT' and ((component#>>'{net,minorUnits}')::numeric>0 or (component#>>'{tax,minorUnits}')::numeric>0 or (component#>>'{gross,minorUnits}')::numeric>0) then return false; end if;
    if (component#>>'{net,minorUnits}')::numeric+(component#>>'{tax,minorUnits}')::numeric<>(component#>>'{gross,minorUnits}')::numeric then return false; end if;
    if jsonb_typeof(component->'taxComponents')<>'array' or jsonb_array_length(component->'taxComponents') not between 1 and 100 then return false; end if;
    component_tax:=0; previous_tax:=null;
    for tax_component in select value from jsonb_array_elements(component->'taxComponents') loop
      if not crm_financial_json_keys_exact(tax_component,array['componentId','amount','policy']) then return false; end if;
      tax_id:=tax_component->>'componentId';
      if tax_id is null or tax_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$' or tax_id=any(all_ids) or (previous_tax is not null and tax_id collate "C" <= previous_tax collate "C") then return false; end if;
      all_ids:=array_append(all_ids,tax_id); previous_tax:=tax_id;
      if not crm_financial_money_v2_valid(tax_component->'amount',p_currency,p_exponent) then return false; end if;
      if component->>'kind'='LINE' and (tax_component#>>'{amount,minorUnits}')::numeric<0 then return false; end if;
      if component->>'kind'='DISCOUNT' and (tax_component#>>'{amount,minorUnits}')::numeric>0 then return false; end if;
      policy:=tax_component->'policy';
      if policy is null or not crm_financial_json_keys_exact(policy,array['reference','jurisdiction','sourceProvenance'])
         or jsonb_typeof(policy->'jurisdiction')<>'string'
         or (policy->>'jurisdiction') !~ '^[A-Z0-9][A-Z0-9._:-]{0,79}$' or not crm_financial_versioned_ref_valid(policy->'reference') then return false; end if;
      source:=policy->'sourceProvenance';
      if source is null or not crm_financial_json_keys_exact(source,array['authority','sourceReference','jurisdiction','effectiveFrom','effectiveTo','policyVersion','verifiedAt'])
         or jsonb_typeof(source->'authority')<>'string' or jsonb_typeof(source->'sourceReference')<>'string'
         or jsonb_typeof(source->'jurisdiction')<>'string' or jsonb_typeof(source->'effectiveFrom')<>'string'
         or jsonb_typeof(source->'policyVersion')<>'string' or jsonb_typeof(source->'verifiedAt')<>'string'
         or source->>'jurisdiction'<>policy->>'jurisdiction' or source->>'policyVersion'<>policy#>>'{reference,version}'
         or length(source->>'authority') not between 1 and 200 or source->>'authority'<>btrim(source->>'authority') or (source->>'authority') ~ '[[:cntrl:]]'
         or length(source->>'sourceReference') not between 1 and 200 or source->>'sourceReference'<>btrim(source->>'sourceReference') or (source->>'sourceReference') ~ '[[:cntrl:]]'
         or length(source->>'policyVersion') not between 1 and 200 or source->>'policyVersion'<>btrim(source->>'policyVersion') or (source->>'policyVersion') ~ '[[:cntrl:]]'
         or not crm_financial_iso_instant_valid(source->>'effectiveFrom') or not crm_financial_iso_instant_valid(source->>'verifiedAt') then return false; end if;
      if source->'effectiveTo'<>'null'::jsonb and (not crm_financial_iso_instant_valid(source->>'effectiveTo') or (source->>'effectiveTo')::timestamptz <= (source->>'effectiveFrom')::timestamptz) then return false; end if;
      if p_effective_at is not null and (p_effective_at<source->>'effectiveFrom' or (source->'effectiveTo'<>'null'::jsonb and p_effective_at>=source->>'effectiveTo')) then return false; end if;
      component_tax:=component_tax+(tax_component#>>'{amount,minorUnits}')::numeric;
    end loop;
    if component_tax<>(component#>>'{tax,minorUnits}')::numeric then return false; end if;
    net_sum:=net_sum+(component#>>'{net,minorUnits}')::numeric;
    tax_sum:=tax_sum+(component#>>'{tax,minorUnits}')::numeric;
    gross_sum:=gross_sum+(component#>>'{gross,minorUnits}')::numeric;
  end loop;
  return coalesce(net_sum=(p_totals#>>'{net,minorUnits}')::numeric
     and tax_sum=(p_totals#>>'{tax,minorUnits}')::numeric
     and gross_sum=(p_totals#>>'{gross,minorUnits}')::numeric
     and net_sum+tax_sum=gross_sum and net_sum>=0 and tax_sum>=0 and gross_sum>=0,false);
exception when others then return false;
end $$;

create or replace function crm_financial_legacy_components_valid(p_components jsonb,p_currency text,p_exponent integer,p_effective_at text)
returns boolean language plpgsql immutable set search_path=pg_catalog,public as $$
declare component jsonb; tax_component jsonb; policy jsonb; source jsonb;
  component_id text; tax_id text; previous_component text; previous_tax text; all_ids text[]:='{}'; value jsonb;
begin
  if p_components is null or jsonb_typeof(p_components)<>'array' or jsonb_array_length(p_components) not between 1 and 100 then return false; end if;
  for component in select item from jsonb_array_elements(p_components) item loop
    if not crm_financial_json_keys_exact(component,array['componentId','kind','net','tax','gross','taxComponents','pricingReference']) then return false; end if;
    component_id:=component->>'componentId';
    if component_id is null or component_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$' or component_id=any(all_ids)
       or (previous_component is not null and component_id collate "C"<=previous_component collate "C") then return false; end if;
    all_ids:=array_append(all_ids,component_id); previous_component:=component_id;
    if jsonb_typeof(component->'kind')<>'string' or component->>'kind' not in('LINE','DISCOUNT','ADJUSTMENT') then return false; end if;
    foreach value in array array[component->'net',component->'tax',component->'gross'] loop
      if value<>'null'::jsonb and not crm_financial_money_v2_valid(value,p_currency,p_exponent) then return false; end if;
      if value<>'null'::jsonb and component->>'kind'='LINE' and (value->>'minorUnits')::numeric<0 then return false; end if;
      if value<>'null'::jsonb and component->>'kind'='DISCOUNT' and (value->>'minorUnits')::numeric>0 then return false; end if;
    end loop;
    if component->'pricingReference'<>'null'::jsonb and not crm_financial_versioned_ref_valid(component->'pricingReference') then return false; end if;
    if component->'taxComponents'='null'::jsonb then continue; end if;
    if jsonb_typeof(component->'taxComponents')<>'array' or jsonb_array_length(component->'taxComponents') not between 1 and 100 then return false; end if;
    previous_tax:=null;
    for tax_component in select item from jsonb_array_elements(component->'taxComponents') item loop
      if not crm_financial_json_keys_exact(tax_component,array['componentId','amount','policy']) then return false; end if;
      tax_id:=tax_component->>'componentId';
      if tax_id is null or tax_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$' or tax_id=any(all_ids)
         or (previous_tax is not null and tax_id collate "C"<=previous_tax collate "C") then return false; end if;
      all_ids:=array_append(all_ids,tax_id); previous_tax:=tax_id;
      if not crm_financial_money_v2_valid(tax_component->'amount',p_currency,p_exponent) then return false; end if;
      if component->>'kind'='LINE' and (tax_component#>>'{amount,minorUnits}')::numeric<0 then return false; end if;
      if component->>'kind'='DISCOUNT' and (tax_component#>>'{amount,minorUnits}')::numeric>0 then return false; end if;
      policy:=tax_component->'policy'; source:=policy->'sourceProvenance';
      if not crm_financial_json_keys_exact(policy,array['reference','jurisdiction','sourceProvenance']) or not crm_financial_versioned_ref_valid(policy->'reference')
         or jsonb_typeof(policy->'jurisdiction')<>'string'
         or (policy->>'jurisdiction') !~ '^[A-Z0-9][A-Z0-9._:-]{0,79}$'
         or not crm_financial_json_keys_exact(source,array['authority','sourceReference','jurisdiction','effectiveFrom','effectiveTo','policyVersion','verifiedAt'])
         or jsonb_typeof(source->'authority')<>'string' or jsonb_typeof(source->'sourceReference')<>'string'
         or jsonb_typeof(source->'jurisdiction')<>'string' or jsonb_typeof(source->'effectiveFrom')<>'string'
         or jsonb_typeof(source->'policyVersion')<>'string' or jsonb_typeof(source->'verifiedAt')<>'string'
         or source->>'jurisdiction'<>policy->>'jurisdiction' or source->>'policyVersion'<>policy#>>'{reference,version}'
         or length(source->>'authority') not between 1 and 200 or source->>'authority'<>btrim(source->>'authority') or (source->>'authority') ~ '[[:cntrl:]]'
         or length(source->>'sourceReference') not between 1 and 200 or source->>'sourceReference'<>btrim(source->>'sourceReference') or (source->>'sourceReference') ~ '[[:cntrl:]]'
         or length(source->>'policyVersion') not between 1 and 200 or source->>'policyVersion'<>btrim(source->>'policyVersion') or (source->>'policyVersion') ~ '[[:cntrl:]]'
         or not crm_financial_iso_instant_valid(source->>'effectiveFrom') or not crm_financial_iso_instant_valid(source->>'verifiedAt')
         or (source->'effectiveTo'<>'null'::jsonb and (not crm_financial_iso_instant_valid(source->>'effectiveTo') or source->>'effectiveTo'<=source->>'effectiveFrom'))
         or (p_effective_at is not null and (p_effective_at<source->>'effectiveFrom' or (source->'effectiveTo'<>'null'::jsonb and p_effective_at>=source->>'effectiveTo'))) then return false; end if;
    end loop;
  end loop;
  return true;
exception when others then return false;
end $$;

create or replace function crm_financial_snapshot_v1_valid(p_snapshot jsonb)
returns boolean language plpgsql immutable set search_path=pg_catalog,public as $$
declare state text; currency text; exponent integer; jurisdiction text; missing text[]; item text; previous text;
  allowed constant text[]:=array['effectiveAt','currency','minorUnitExponent','currencyDefinition','jurisdiction','components','totals.net','totals.tax','totals.gross','taxPolicy','roundingPolicy','pricingReference','provenance'];
begin
  if p_snapshot is null or jsonb_typeof(p_snapshot)<>'object' then return false; end if;
  state:=p_snapshot->>'reviewState';
  if state='COMPLETE' then
    if not crm_financial_json_keys_exact(p_snapshot,array['snapshotSchemaVersion','snapshotId','businessVersion','tenantId','resourceId','reviewState','effectiveAt','currency','minorUnitExponent','currencyDefinition','jurisdiction','components','totals','roundingPolicy','pricingReference','provenance']) then return false; end if;
  elsif state='NEEDS_REVIEW' then
    if not crm_financial_json_keys_exact(p_snapshot,array['snapshotSchemaVersion','snapshotId','businessVersion','tenantId','resourceId','reviewState','effectiveAt','currency','minorUnitExponent','currencyDefinition','jurisdiction','components','totals','roundingPolicy','pricingReference','provenance','missingFields']) then return false; end if;
  else return false; end if;
  if p_snapshot->>'snapshotSchemaVersion' is distinct from 'financial-snapshot-v1'
     or jsonb_typeof(p_snapshot->'snapshotId')<>'string' or lower((p_snapshot->>'snapshotId')::uuid::text)<>p_snapshot->>'snapshotId'
     or jsonb_typeof(p_snapshot->'tenantId')<>'string' or lower((p_snapshot->>'tenantId')::uuid::text)<>p_snapshot->>'tenantId'
     or jsonb_typeof(p_snapshot->'resourceId')<>'string' or lower((p_snapshot->>'resourceId')::uuid::text)<>p_snapshot->>'resourceId'
     or jsonb_typeof(p_snapshot->'businessVersion')<>'number' or (p_snapshot->>'businessVersion') !~ '^[1-9][0-9]*$'
     or (p_snapshot->>'businessVersion')::numeric>9007199254740991 then return false; end if;
  if not crm_financial_json_keys_exact(p_snapshot->'totals',array['net','tax','gross']) then return false; end if;
  if p_snapshot->'currency'<>'null'::jsonb then currency:=p_snapshot->>'currency'; if currency !~ '^[A-Z]{3}$' then return false; end if; end if;
  if p_snapshot->'minorUnitExponent'<>'null'::jsonb then
    if jsonb_typeof(p_snapshot->'minorUnitExponent')<>'number' or (p_snapshot->>'minorUnitExponent') !~ '^[0-9]$' then return false; end if;
    exponent:=(p_snapshot->>'minorUnitExponent')::integer;
  end if;
  if p_snapshot->'effectiveAt'<>'null'::jsonb and not crm_financial_iso_instant_valid(p_snapshot->>'effectiveAt') then return false; end if;
  if p_snapshot->'jurisdiction'<>'null'::jsonb then jurisdiction:=p_snapshot->>'jurisdiction'; if jurisdiction !~ '^[A-Z0-9][A-Z0-9._:-]{0,79}$' then return false; end if; end if;
  if p_snapshot->'currencyDefinition'<>'null'::jsonb and (currency is null or exponent is null or not crm_financial_currency_definition_valid(p_snapshot->'currencyDefinition',currency,exponent)) then return false; end if;
  if p_snapshot->'roundingPolicy'<>'null'::jsonb and not crm_financial_versioned_ref_valid(p_snapshot->'roundingPolicy') then return false; end if;
  if p_snapshot->'pricingReference'<>'null'::jsonb and not crm_financial_versioned_ref_valid(p_snapshot->'pricingReference') then return false; end if;
  if p_snapshot->'provenance'<>'null'::jsonb and not crm_financial_provenance_valid(p_snapshot->'provenance') then return false; end if;
  foreach item in array array['net','tax','gross'] loop
    if p_snapshot#>array['totals',item]<>'null'::jsonb and (currency is null or exponent is null or not crm_financial_money_v2_valid(p_snapshot#>array['totals',item],currency,exponent)) then return false; end if;
  end loop;
  if state='COMPLETE' then
    if p_snapshot->'effectiveAt'='null'::jsonb or currency is null or exponent is null or p_snapshot->'currencyDefinition'='null'::jsonb
       or jurisdiction is null or p_snapshot->'components'='null'::jsonb or p_snapshot#>'{totals,net}'='null'::jsonb
       or p_snapshot#>'{totals,tax}'='null'::jsonb or p_snapshot#>'{totals,gross}'='null'::jsonb
       or p_snapshot->'roundingPolicy'='null'::jsonb or p_snapshot->'pricingReference'='null'::jsonb or p_snapshot->'provenance'='null'::jsonb
       or not crm_financial_components_valid(p_snapshot->'components',currency,exponent,jurisdiction,p_snapshot->'totals',p_snapshot->>'effectiveAt') then return false; end if;
    return true;
  end if;
  if jsonb_typeof(p_snapshot->'missingFields')<>'array' or jsonb_array_length(p_snapshot->'missingFields')<1 then return false; end if;
  missing:='{}'; previous:=null;
  for item in select value#>>'{}' from jsonb_array_elements(p_snapshot->'missingFields') loop
    if item is null or item<>all(allowed) or item=any(missing) or (previous is not null and item collate "C" <= previous collate "C") then return false; end if;
    missing:=array_append(missing,item); previous:=item;
  end loop;
  if (p_snapshot->'effectiveAt'='null'::jsonb and not 'effectiveAt'=any(missing))
     or (p_snapshot->'currency'='null'::jsonb and not 'currency'=any(missing))
     or (p_snapshot->'minorUnitExponent'='null'::jsonb and not 'minorUnitExponent'=any(missing))
     or (p_snapshot->'currencyDefinition'='null'::jsonb and not 'currencyDefinition'=any(missing))
     or (p_snapshot->'jurisdiction'='null'::jsonb and not 'jurisdiction'=any(missing))
     or (p_snapshot->'components'='null'::jsonb and not 'components'=any(missing))
     or (p_snapshot#>'{totals,net}'='null'::jsonb and not 'totals.net'=any(missing))
     or (p_snapshot#>'{totals,tax}'='null'::jsonb and not 'totals.tax'=any(missing))
     or (p_snapshot#>'{totals,gross}'='null'::jsonb and not 'totals.gross'=any(missing))
     or (p_snapshot->'roundingPolicy'='null'::jsonb and not 'roundingPolicy'=any(missing))
     or (p_snapshot->'pricingReference'='null'::jsonb and not 'pricingReference'=any(missing))
     or (p_snapshot->'provenance'='null'::jsonb and not 'provenance'=any(missing)) then return false; end if;
  if p_snapshot->'components'<>'null'::jsonb and not crm_financial_legacy_components_valid(p_snapshot->'components',currency,exponent,p_snapshot->>'effectiveAt') then return false; end if;
  return true;
exception when others then return false;
end $$;

create table crm_financial_policy_versions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id), project_id uuid not null,
  policy_kind text not null check(policy_kind in('CURRENCY','TAX','ROUNDING')),
  policy_id text not null check(length(trim(policy_id))>0), policy_version text not null check(length(trim(policy_version))>0),
  content_hash text not null check(content_hash ~ '^[a-f0-9]{64}$'), contract_payload jsonb not null check(jsonb_typeof(contract_payload)='object'),
  jurisdiction text, effective_from timestamptz, effective_to timestamptz,
  source_reference text not null check(length(trim(source_reference))>0), verified_at timestamptz not null,
  created_by uuid not null, correlation_id uuid not null,
  data_classification text not null default 'UNCLASSIFIED', data_purpose text not null default 'crm_sales', created_at timestamptz not null default now(),
  unique(workspace_id,id), unique(workspace_id,project_id,id), unique(workspace_id,project_id,policy_kind,policy_id,policy_version),
  foreign key(workspace_id,project_id) references projects(workspace_id,id),
  foreign key(workspace_id,created_by) references workspace_users(workspace_id,id),
  check(effective_to is null or effective_from is not null and effective_to>effective_from),
  check(crm_financial_policy_payload_valid(contract_payload)),
  check(policy_kind<>'TAX' or (jurisdiction=contract_payload->>'jurisdiction'
    and policy_version=contract_payload#>>'{sourceProvenance,policyVersion}'
    and source_reference=contract_payload#>>'{sourceProvenance,sourceReference}'
    and effective_from=(contract_payload#>>'{sourceProvenance,effectiveFrom}')::timestamptz
    and effective_to is not distinct from (contract_payload#>>'{sourceProvenance,effectiveTo}')::timestamptz
    and verified_at=(contract_payload#>>'{sourceProvenance,verifiedAt}')::timestamptz)),
  check(policy_kind<>'CURRENCY' or verified_at=(contract_payload->>'verifiedAt')::timestamptz),
  check(contract_payload->>'kind'=policy_kind),
  check(content_hash=crm_financial_policy_hash(contract_payload))
);

create table crm_financial_snapshots (
  id uuid primary key, workspace_id uuid not null references workspaces(id), project_id uuid,
  resource_type text not null check(resource_type in('OFFER','PROPERTY_SALE','DEAL','CONTRACT','PROPERTY_COST_MATRIX')),
  resource_id uuid not null, business_version bigint not null check(business_version between 1 and 9007199254740991),
  review_state text not null check(review_state in('NEEDS_REVIEW','VERIFIED')),
  canonical_snapshot jsonb not null, snapshot_hash text not null check(snapshot_hash ~ '^[a-f0-9]{64}$'),
  supersedes_snapshot_id uuid, legacy_classification text check(legacy_classification in('A','B','C')),
  legacy_evidence jsonb check(legacy_evidence is null or jsonb_typeof(legacy_evidence)='object'),
  created_by uuid, correlation_id uuid not null,
  data_classification text not null default 'UNCLASSIFIED', data_purpose text not null default 'crm_sales', created_at timestamptz not null default now(),
  unique(workspace_id,id), unique(workspace_id,project_id,id),
  unique(workspace_id,resource_type,resource_id,business_version), unique(workspace_id,supersedes_snapshot_id),
  foreign key(workspace_id,project_id) references projects(workspace_id,id),
  foreign key(workspace_id,created_by) references workspace_users(workspace_id,id),
  foreign key(workspace_id,supersedes_snapshot_id) references crm_financial_snapshots(workspace_id,id),
  check(crm_financial_snapshot_v1_valid(canonical_snapshot)),
  check(id=(canonical_snapshot->>'snapshotId')::uuid and workspace_id=(canonical_snapshot->>'tenantId')::uuid
    and resource_id=(canonical_snapshot->>'resourceId')::uuid and business_version=(canonical_snapshot->>'businessVersion')::bigint),
  check((review_state='VERIFIED' and canonical_snapshot->>'reviewState'='COMPLETE')
     or (review_state='NEEDS_REVIEW' and canonical_snapshot->>'reviewState'='NEEDS_REVIEW')),
  check(snapshot_hash=crm_financial_snapshot_hash(canonical_snapshot)),
  check(legacy_classification is not null or created_by is not null),
  check((legacy_classification is null and legacy_evidence is null) or (legacy_classification is not null and legacy_evidence is not null and review_state='NEEDS_REVIEW'))
);

create table crm_financial_events (
  sequence bigint generated always as identity primary key, id uuid not null unique default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id), project_id uuid, snapshot_id uuid not null,
  event_type text not null check(event_type in('SNAPSHOT_RECORDED','LEGACY_NEEDS_REVIEW','REVIEW_VERIFIED','POLICY_BOUND','SUPERSEDED','APPROVAL_REQUESTED','APPROVAL_VERIFIED')),
  policy_version_id uuid, related_snapshot_id uuid, approval_contract_version text check(approval_contract_version in('v1','v2')),
  action_hash text check(action_hash is null or action_hash ~ '^[a-f0-9]{64}$'),
  financial_snapshot_hash text not null check(financial_snapshot_hash ~ '^[a-f0-9]{64}$'),
  actor_id uuid, correlation_id uuid not null, details jsonb not null default '{}' check(jsonb_typeof(details)='object'),
  data_classification text not null default 'UNCLASSIFIED', data_purpose text not null default 'crm_sales', created_at timestamptz not null default now(),
  unique(workspace_id,id),
  foreign key(workspace_id,project_id,snapshot_id) references crm_financial_snapshots(workspace_id,project_id,id),
  foreign key(workspace_id,snapshot_id) references crm_financial_snapshots(workspace_id,id),
  foreign key(workspace_id,project_id,policy_version_id) references crm_financial_policy_versions(workspace_id,project_id,id),
  foreign key(workspace_id,related_snapshot_id) references crm_financial_snapshots(workspace_id,id),
  foreign key(workspace_id,actor_id) references workspace_users(workspace_id,id),
  check(event_type='LEGACY_NEEDS_REVIEW' or actor_id is not null),
  check(event_type<>'POLICY_BOUND' or policy_version_id is not null),
  check(event_type<>'SUPERSEDED' or related_snapshot_id is not null),
  check(event_type not in('APPROVAL_REQUESTED','APPROVAL_VERIFIED') or (approval_contract_version is not null and action_hash is not null))
);

create index crm_financial_snapshots_resource_history_idx on crm_financial_snapshots(workspace_id,resource_type,resource_id,business_version desc);
create index crm_financial_snapshots_review_queue_idx on crm_financial_snapshots(workspace_id,project_id,created_at,id) where review_state='NEEDS_REVIEW';
create index crm_financial_events_snapshot_sequence_idx on crm_financial_events(workspace_id,snapshot_id,sequence);
create index crm_financial_policy_lookup_idx on crm_financial_policy_versions(workspace_id,project_id,policy_kind,policy_id,policy_version);

-- Match the application MoneyV2 contract with exact integer arithmetic. PostgreSQL
-- numeric is intentionally unbounded here: every persisted operand/result is still
-- constrained to the canonical 78-digit MoneyV2 range by the snapshot validator.
create or replace function crm_financial_round_rational(
  p_minor_units numeric,p_numerator numeric,p_denominator numeric,p_mode text
)
returns numeric language plpgsql immutable strict set search_path=pg_catalog,public as $$
declare product numeric; quotient numeric; remainder numeric; direction numeric; comparison numeric;
begin
  if p_numerator<0 or p_denominator<=0 or p_mode not in('TRUNCATE','AWAY_FROM_ZERO','HALF_UP','HALF_EVEN') then
    raise exception using errcode='23514',message='Invalid exact financial rounding operands';
  end if;
  product:=p_minor_units*p_numerator;
  quotient:=trunc(product/p_denominator);
  remainder:=product-quotient*p_denominator;
  if remainder=0 or p_mode='TRUNCATE' then return quotient; end if;
  direction:=case when product<0 then -1 else 1 end;
  if p_mode='AWAY_FROM_ZERO' then return quotient+direction; end if;
  comparison:=abs(remainder)*2-p_denominator;
  if comparison<0 then return quotient; end if;
  if comparison>0 or p_mode='HALF_UP' then return quotient+direction; end if;
  return case when mod(abs(quotient),2)=0 then quotient else quotient+direction end;
end $$;

create or replace function crm_financial_evelyn_uuid(p_key text,p_suffix text)
returns uuid language sql immutable strict set search_path=pg_catalog,public as $$
  with raw as (
    select decode(encode(digest(convert_to('crm-evelyn:'||p_key||':'||p_suffix,'UTF8'),'sha256'),'hex'),'hex') value
  ), marked as (
    select set_byte(set_byte(value,6,(get_byte(value,6)&15)|64),8,(get_byte(value,8)&63)|128) value from raw
  ), encoded as (
    select encode(substring(value from 1 for 16),'hex') value from marked
  )
  select (substring(value,1,8)||'-'||substring(value,9,4)||'-'||substring(value,13,4)||'-'||substring(value,17,4)||'-'||substring(value,21,12))::uuid from encoded
$$;

-- Offer rows are legacy CRM records, but a COMPLETE contract may only use a
-- revision whose digest and total are reproducible from the server-owned offer
-- parties and content.  The application uses crmPayloadDigest({ action,
-- workspaceId, projectId, offerId, revision, contactId, leadId, organizationId,
-- content, totalNetCents }); crm_financial_sha256 has the same sorted-JSON
-- canonicalization for the JSON values persisted by the CRM.
create or replace function crm_financial_offer_revision_valid(
  p_workspace uuid,p_project uuid,p_offer uuid,p_revision integer,p_content jsonb,
  p_content_digest text,p_total_net_cents bigint
)
returns boolean language plpgsql stable set search_path=pg_catalog,public as $$
declare offer_record record; item jsonb; expected_total numeric:=0; item_count integer:=0;
begin
  if p_content is null or jsonb_typeof(p_content)<>'object'
     or not crm_financial_json_keys_exact(p_content,array['currency','items','recipientEmail','recipientName','subject','taxBasis','terms','validUntil'])
     or p_content->>'currency'<>'EUR' or p_content->>'taxBasis'<>'NET'
     or jsonb_typeof(p_content->'items')<>'array' or jsonb_array_length(p_content->'items')<1
     or p_content->>'validUntil' is null or not crm_financial_iso_instant_valid(p_content->>'validUntil')
     or p_content->>'recipientEmail' is null or p_content->>'recipientEmail'<>lower(p_content->>'recipientEmail')
     or length(trim(p_content->>'recipientEmail'))=0
     or length(trim(p_content->>'subject'))=0 or length(trim(p_content->>'recipientName'))=0
     or length(trim(p_content->>'terms'))=0 then return false; end if;
  select o.id,o.workspace_id,o.project_id,o.contact_id,o.lead_id,o.organization_id
    into offer_record from crm_offers o
    where o.workspace_id=p_workspace and o.project_id=p_project and o.id=p_offer;
  if not found then return false; end if;
  for item in select value from jsonb_array_elements(p_content->'items') loop
    item_count:=item_count+1;
    if jsonb_typeof(item)<>'object'
       or not crm_financial_json_keys_exact(item,array['description','quantity','unitNetCents'])
       or length(trim(item->>'description'))=0
       or jsonb_typeof(item->'quantity')<>'number'
       or jsonb_typeof(item->'unitNetCents')<>'number'
       or item->>'quantity' !~ '^[1-9][0-9]{0,6}$'
       or (item->>'quantity')::numeric>1000000
       or item->>'unitNetCents' !~ '^(?:0|[1-9][0-9]{0,15})$'
       or (item->>'unitNetCents')::numeric>9007199254740991 then return false; end if;
    expected_total:=expected_total+(item->>'quantity')::numeric*(item->>'unitNetCents')::numeric;
    if expected_total>9007199254740991 then return false; end if;
  end loop;
  if item_count<1 or expected_total<=0 or p_total_net_cents::numeric<>expected_total then return false; end if;
  return p_content_digest=crm_financial_sha256(jsonb_build_object(
    'action','offer.send','workspaceId',offer_record.workspace_id::text,
    'projectId',offer_record.project_id::text,'offerId',offer_record.id::text,
    'revision',p_revision,'contactId',offer_record.contact_id::text,
    'leadId',offer_record.lead_id::text,'organizationId',offer_record.organization_id::text,
    'content',p_content,'totalNetCents',p_total_net_cents));
exception when others then return false;
end $$;

-- A runtime approval must be created by the actor represented by the current
-- tenant transaction.  In particular, a project editor cannot insert an
-- approval that merely names the configured approver or borrows that user's
-- session.  The MFA session must have been active at the persisted approval
-- timestamp; later revocation does not rewrite a historical fact.
create or replace function crm_financial_offer_approval_guard()
returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
declare actor uuid:=nullif(current_setting('app.actor_id',true),'')::uuid;
  configured uuid; session_record record;
begin
  if coalesce((select r.rolsuper or r.rolbypassrls from pg_roles r where r.rolname=current_user),false)
     or not pg_has_role(current_user,'novalure_tenant_app','member') then return new; end if;
  if actor is null or new.workspace_id is distinct from nullif(current_setting('app.tenant_id',true),'')::uuid
     or new.actor_id is distinct from actor then
    raise exception using errcode='42501',message='Offer approval actor context is required';
  end if;
  select (w.setup_state->>'salesApprovalUserId')::uuid into configured
    from workspaces w where w.id=new.workspace_id;
  if configured is null or configured is distinct from new.actor_id then
    raise exception using errcode='42501',message='Configured offer approver is required';
  end if;
  select s.id,s.created_at,s.expires_at,s.revoked_at,s.mfa_verified_at,s.workspace_user_id,
      s.workspace_id,s.auth_identity_id,u.auth_identity_id as member_identity,u.status
    into session_record
    from auth_sessions s join workspace_users u on u.workspace_id=s.workspace_id and u.id=s.workspace_user_id
    where s.id=new.auth_session_reference and s.workspace_id=new.workspace_id
      and s.workspace_user_id=new.actor_id and u.status='active';
  if not found or session_record.auth_identity_id is distinct from session_record.member_identity
     or session_record.mfa_verified_at is null
     or session_record.created_at>new.created_at
     or session_record.mfa_verified_at>new.created_at
     or session_record.expires_at<=new.created_at
     or (session_record.revoked_at is not null and session_record.revoked_at<=new.created_at) then
    raise exception using errcode='42501',message='An active MFA approval session is required';
  end if;
  return new;
exception when invalid_text_representation then
  raise exception using errcode='42501',message='Configured offer approver is required';
end $$;
drop trigger if exists crm_financial_offer_approval_authority on crm_offer_approvals;
create trigger crm_financial_offer_approval_authority before insert on crm_offer_approvals
  for each row execute function crm_financial_offer_approval_guard();

create or replace function crm_financial_offer_revision_authority_guard()
returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
begin
  if coalesce((select r.rolsuper or r.rolbypassrls from pg_roles r where r.rolname=current_user),false)
     or not pg_has_role(current_user,'novalure_tenant_app','member') then return new; end if;
  if new.created_by is distinct from nullif(current_setting('app.actor_id',true),'')::uuid
     or not crm_financial_offer_revision_valid(new.workspace_id,new.project_id,new.offer_id,new.revision,new.content,new.content_digest,new.total_net_cents) then
    raise exception using errcode='42501',message='Offer revision is not server-reproducible';
  end if;
  return new;
end $$;
drop trigger if exists crm_financial_offer_revision_authority on crm_offer_revisions;
create trigger crm_financial_offer_revision_authority before insert on crm_offer_revisions
  for each row execute function crm_financial_offer_revision_authority_guard();

-- A COMPLETE snapshot is authoritative only when every policy reference resolves
-- to the exact tenant/project registry row and every tax amount is reproducible
-- from the registered rational rate and rounding policy.
create or replace function crm_financial_complete_policy_bindings_valid(
  p_workspace uuid,p_project uuid,p_snapshot jsonb
)
returns boolean language plpgsql stable set search_path=pg_catalog,public as $$
declare currency_record crm_financial_policy_versions%rowtype; rounding_record crm_financial_policy_versions%rowtype;
  tax_record crm_financial_policy_versions%rowtype; component jsonb; tax_component jsonb;
  effective_at timestamptz; expected_tax numeric;
begin
  if p_project is null or p_snapshot->>'reviewState'<>'COMPLETE' then return false; end if;
  effective_at:=(p_snapshot->>'effectiveAt')::timestamptz;
  select * into currency_record from crm_financial_policy_versions
    where workspace_id=p_workspace and project_id=p_project and policy_kind='CURRENCY'
      and policy_id=p_snapshot#>>'{currencyDefinition,registryReference,id}'
      and policy_version=p_snapshot#>>'{currencyDefinition,registryReference,version}'
      and content_hash=p_snapshot#>>'{currencyDefinition,registryReference,contentHash}';
  if not found
     or currency_record.contract_payload->>'standard'<>p_snapshot#>>'{currencyDefinition,standard}'
     or currency_record.contract_payload->>'code'<>p_snapshot->>'currency'
     or (currency_record.contract_payload->>'minorUnitExponent')::integer<>(p_snapshot->>'minorUnitExponent')::integer
     or currency_record.contract_payload->>'verifiedAt'<>p_snapshot#>>'{currencyDefinition,verifiedAt}'
     or (currency_record.effective_from is not null and effective_at<currency_record.effective_from)
     or (currency_record.effective_to is not null and effective_at>=currency_record.effective_to) then return false; end if;

  select * into rounding_record from crm_financial_policy_versions
    where workspace_id=p_workspace and project_id=p_project and policy_kind='ROUNDING'
      and policy_id=p_snapshot#>>'{roundingPolicy,id}' and policy_version=p_snapshot#>>'{roundingPolicy,version}'
      and content_hash=p_snapshot#>>'{roundingPolicy,contentHash}';
  if not found or (rounding_record.contract_payload->>'currencyExponent')::integer<>(p_snapshot->>'minorUnitExponent')::integer
     or rounding_record.contract_payload->>'scope'<>'TAX_COMPONENT'
     or (rounding_record.effective_from is not null and effective_at<rounding_record.effective_from)
     or (rounding_record.effective_to is not null and effective_at>=rounding_record.effective_to) then return false; end if;

  for component in select value from jsonb_array_elements(p_snapshot->'components') loop
    for tax_component in select value from jsonb_array_elements(component->'taxComponents') loop
      select * into tax_record from crm_financial_policy_versions
        where workspace_id=p_workspace and project_id=p_project and policy_kind='TAX'
          and policy_id=tax_component#>>'{policy,reference,id}'
          and policy_version=tax_component#>>'{policy,reference,version}'
          and content_hash=tax_component#>>'{policy,reference,contentHash}';
      if not found or tax_record.contract_payload->>'jurisdiction'<>p_snapshot->>'jurisdiction'
         or tax_component#>>'{policy,jurisdiction}'<>p_snapshot->>'jurisdiction'
         or tax_component#>'{policy,sourceProvenance}' is distinct from tax_record.contract_payload->'sourceProvenance'
         or effective_at<tax_record.effective_from
         or (tax_record.effective_to is not null and effective_at>=tax_record.effective_to) then return false; end if;
      expected_tax:=crm_financial_round_rational(
        (component#>>'{net,minorUnits}')::numeric,
        (tax_record.contract_payload#>>'{rate,numerator}')::numeric,
        (tax_record.contract_payload#>>'{rate,denominator}')::numeric,
        rounding_record.contract_payload->>'mode');
      if expected_tax<>(tax_component#>>'{amount,minorUnits}')::numeric then return false; end if;
    end loop;
  end loop;
  return true;
exception when others then return false;
end $$;

create or replace function crm_financial_review_lines_valid(p_prior crm_financial_snapshots,p_snapshot jsonb)
returns boolean language plpgsql stable set search_path=pg_catalog,public as $$
declare component jsonb; item jsonb; expected_count integer:=0; item_position integer:=0;
  monthly_value text; one_time_value text; expected_id text; pricing jsonb:=p_snapshot->'pricingReference';
begin
  for component in select value from jsonb_array_elements(p_snapshot->'components') loop
    if component->'pricingReference' is distinct from pricing then return false; end if;
  end loop;
  if p_prior.canonical_snapshot#>'{totals,net}'<>'null'::jsonb then
    return jsonb_array_length(p_snapshot->'components')=1
      and p_snapshot#>>'{components,0,componentId}'='evidence:net'
      and p_snapshot#>>'{components,0,net,minorUnits}'=p_prior.canonical_snapshot#>>'{totals,net,minorUnits}';
  elsif p_prior.resource_type='PROPERTY_SALE' then
    return jsonb_array_length(p_snapshot->'components')=1
      and p_snapshot#>>'{components,0,componentId}'='evidence:sale-price'
      and p_snapshot#>>'{components,0,net,minorUnits}'=p_prior.legacy_evidence->>'saleTimePriceMinorUnits';
  elsif p_prior.resource_type<>'PROPERTY_COST_MATRIX' or jsonb_typeof(p_prior.legacy_evidence->'items')<>'array' then
    return false;
  end if;
  for item in select value from jsonb_array_elements(p_prior.legacy_evidence->'items') loop
    item_position:=item_position+1;
    monthly_value:=case when item ? 'monthlyNetMinorUnits' then item->>'monthlyNetMinorUnits'
      when item#>>'{monthly,provided,net}'='true' or coalesce(item#>'{monthly,derived}','[]'::jsonb) ? 'net' then item#>>'{monthly,net}' else null end;
    one_time_value:=case when item ? 'oneTimeNetMinorUnits' then item->>'oneTimeNetMinorUnits'
      when item#>>'{oneTime,provided,net}'='true' or coalesce(item#>'{oneTime,derived}','[]'::jsonb) ? 'net' then item#>>'{oneTime,net}' else null end;
    if monthly_value is not null then
      expected_id:='evidence:cost:'||lpad(item_position::text,3,'0')||':monthly';
      if p_snapshot#>>array['components',expected_count::text,'componentId']<>expected_id
         or p_snapshot#>>array['components',expected_count::text,'net','minorUnits']<>monthly_value then return false; end if;
      expected_count:=expected_count+1;
    end if;
    if one_time_value is not null then
      expected_id:='evidence:cost:'||lpad(item_position::text,3,'0')||':one-time';
      if p_snapshot#>>array['components',expected_count::text,'componentId']<>expected_id
         or p_snapshot#>>array['components',expected_count::text,'net','minorUnits']<>one_time_value then return false; end if;
      expected_count:=expected_count+1;
    end if;
  end loop;
  return expected_count>0 and jsonb_array_length(p_snapshot->'components')=expected_count;
exception when others then return false;
end $$;

-- Bind COMPLETE data to a real accepted/approved offer or to one immutable legacy
-- predecessor. Mutable deal values and caller-supplied provenance are never authority.
create or replace function crm_financial_complete_source_valid(
  p_id uuid,p_workspace uuid,p_project uuid,p_resource_type text,p_resource_id uuid,p_business_version bigint,
  p_snapshot jsonb,p_supersedes uuid,p_created_by uuid,p_created_at timestamptz
)
returns boolean language plpgsql stable set search_path=pg_catalog,public as $$
declare prior crm_financial_snapshots%rowtype; prior_contract crm_financial_snapshots%rowtype;
  offer_record record; action_record record; component jsonb; content_item jsonb; component_count integer:=0; item_count integer:=0;
  expected_evidence_hash text; expected_effective text;
begin
  if not crm_financial_complete_policy_bindings_valid(p_workspace,p_project,p_snapshot) then return false; end if;
  if p_resource_type='CONTRACT' then
    select o.id,o.workspace_id,o.project_id,o.deal_id,o.contact_id,o.lead_id,o.organization_id,
        o.revision,o.version,o.approval_id,o.status,o.response_reference,o.response_actor_id,
        r.content_digest,r.content,r.total_net_cents,r.created_at revision_at,r.created_by revision_actor,
        approval.actor_id approval_actor,approval.auth_session_reference,approval.created_at approval_at,
        approval.expires_at approval_expires_at,h.changed_at acceptance_at,h.changed_by_user_id acceptance_actor,
        h.metadata acceptance_metadata,d.stage deal_stage,d.version deal_version,
        w.setup_state->>'salesApprovalUserId' configured_approver
      into offer_record
      from crm_offers o join crm_offer_revisions r on r.workspace_id=o.workspace_id and r.project_id=o.project_id
        and r.offer_id=o.id and r.revision=o.revision
      join crm_offer_approvals approval on approval.workspace_id=o.workspace_id and approval.project_id=o.project_id
        and approval.id=o.approval_id and approval.offer_id=o.id and approval.revision=o.revision
        and approval.content_digest=r.content_digest and approval.decision='APPROVED'
      join workspaces w on w.id=o.workspace_id
      join workspace_users approver on approver.workspace_id=o.workspace_id and approver.id=approval.actor_id
        and approver.status='active'
      join auth_sessions approval_session on approval_session.id=approval.auth_session_reference
        and approval_session.workspace_id=o.workspace_id and approval_session.workspace_user_id=approval.actor_id
        and approval_session.auth_identity_id=approver.auth_identity_id
        and approval_session.mfa_verified_at is not null
        and approval_session.created_at<=approval.created_at
        and approval_session.mfa_verified_at<=approval.created_at
        and approval_session.expires_at>approval.created_at
        and (approval_session.revoked_at is null or approval_session.revoked_at>approval.created_at)
      join deals d on d.workspace_id=o.workspace_id and d.project_id=o.project_id and d.id=o.deal_id
        and d.stage='Gewonnen'
      join lateral (
        select history.changed_at,history.changed_by_user_id,history.metadata from deal_stage_history history
        where history.workspace_id=o.workspace_id and history.project_id=o.project_id and history.deal_id=o.deal_id
          and history.to_stage='Gewonnen' and history.metadata->>'offerId'=o.id::text
          and history.metadata->>'revision'=o.revision::text and history.metadata->>'contentDigest'=r.content_digest
          and history.metadata->>'approvalReference'=o.approval_id::text
          and history.metadata->>'responseReference'=o.response_reference
          and history.changed_by_user_id=o.response_actor_id
        order by history.changed_at desc,history.id desc limit 1
      ) h on true
      where o.workspace_id=p_workspace and o.project_id=p_project
        and o.id=(p_snapshot#>>'{pricingReference,id}')::uuid and o.status='ACCEPTED'
        and o.response_reference is not null and o.response_actor_id is not null
        and approval.actor_id=(w.setup_state->>'salesApprovalUserId')::uuid
        and approval.created_at>=r.created_at
        and approval.expires_at>h.changed_at
        and h.changed_at>=approval.created_at
        and h.metadata->>'contractSent'='false';
    if not found or p_resource_id<>crm_financial_evelyn_uuid(offer_record.id::text,'contract')
       or p_id<>crm_financial_evelyn_uuid(p_resource_id::text,'financial:'||p_business_version::text)
       or offer_record.configured_approver is null
       or offer_record.acceptance_actor<>offer_record.response_actor_id
       or not crm_financial_json_keys_exact(offer_record.acceptance_metadata,
         array['approvalReference','auditReference','contentDigest','contractSent','correlationId','offerId','responseReference','revision'])
       or offer_record.acceptance_metadata->>'offerId'<>offer_record.id::text
       or offer_record.acceptance_metadata->>'responseReference'<>offer_record.response_reference
       or offer_record.acceptance_metadata->>'contractSent'<>'false'
       or offer_record.acceptance_metadata->>'auditReference' !~ '^[0-9a-fA-F-]{36}$'
       or offer_record.acceptance_metadata->>'correlationId' !~ '^[0-9a-fA-F-]{36}$'
       or not crm_financial_offer_revision_valid(offer_record.workspace_id,offer_record.project_id,offer_record.id,
         offer_record.revision,offer_record.content,offer_record.content_digest,offer_record.total_net_cents)
       or p_snapshot#>>'{pricingReference,version}'<>offer_record.revision::text
       or p_snapshot#>>'{pricingReference,contentHash}'<>offer_record.content_digest
       or p_snapshot#>>'{provenance,sourceSystem}'<>'novalure-crm'
       or p_snapshot#>>'{provenance,sourceRecordId}'<>offer_record.id::text
       or p_snapshot#>>'{provenance,sourceVersion}'<>offer_record.revision::text
       or p_snapshot#>>'{provenance,sourceHash}'<>offer_record.content_digest
       or p_snapshot#>>'{provenance,recordedAt}'<>to_char(offer_record.revision_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
       or p_snapshot#>>'{provenance,recordedBy}'<>offer_record.revision_actor::text
       or p_snapshot->>'effectiveAt'<>to_char(offer_record.acceptance_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
       or p_snapshot->>'currency'<>offer_record.content->>'currency'
       or offer_record.content->>'taxBasis'<>'NET'
       or p_snapshot#>>'{totals,net,minorUnits}'<>offer_record.total_net_cents::text then return false; end if;
    select * into action_record from crm_evelyn_contract_actions
      where workspace_id=p_workspace and project_id=p_project and id=p_resource_id;
    if found and (action_record.offer_id<>offer_record.id or action_record.offer_revision<>offer_record.revision
       or action_record.source_approval_id<>offer_record.approval_id or action_record.source_content_digest<>offer_record.content_digest
       or p_business_version<>action_record.version+1) then return false; end if;
    if not found and p_business_version<>1 then return false; end if;
    select * into prior_contract from crm_financial_snapshots where workspace_id=p_workspace and project_id=p_project
      and resource_type='CONTRACT' and resource_id=p_resource_id order by business_version desc limit 1;
    if found and (p_supersedes is distinct from prior_contract.id or p_business_version<>prior_contract.business_version+1) then return false; end if;
    if not found and p_supersedes is not null then return false; end if;
    item_count:=jsonb_array_length(offer_record.content->'items');
    if jsonb_array_length(p_snapshot->'components')<>item_count then return false; end if;
    for content_item in select value from jsonb_array_elements(offer_record.content->'items') with ordinality source(value,ordinality) order by ordinality loop
      component:=p_snapshot->'components'->component_count;
      component_count:=component_count+1;
      if component->>'componentId'<>'line:'||lpad(component_count::text,3,'0') or component->>'kind'<>'LINE'
         or component->'pricingReference' is distinct from p_snapshot->'pricingReference'
         or (component#>>'{net,minorUnits}')::numeric<>(content_item->>'quantity')::numeric*(content_item->>'unitNetCents')::numeric then return false; end if;
    end loop;
    return true;
  end if;

  if p_resource_type not in('DEAL','PROPERTY_SALE','PROPERTY_COST_MATRIX') or p_supersedes is null then return false; end if;
  select * into prior from crm_financial_snapshots where workspace_id=p_workspace and project_id=p_project and id=p_supersedes;
  if not found or prior.resource_type<>p_resource_type or prior.resource_id<>p_resource_id
     or prior.business_version+1<>p_business_version or prior.review_state<>'NEEDS_REVIEW'
     or prior.legacy_classification not in('A','B') or p_id<>crm_financial_deterministic_uuid(
       'review-resolution:'||p_workspace||':'||prior.id||':'||p_business_version) then return false; end if;
  expected_evidence_hash:=crm_financial_sha256(jsonb_build_object(
    'contractVersion','legacy-financial-review-evidence-v1','priorSnapshotHash',prior.snapshot_hash,'legacyEvidence',prior.legacy_evidence));
  expected_effective:=coalesce(prior.canonical_snapshot->>'effectiveAt',prior.canonical_snapshot#>>'{provenance,recordedAt}');
  if p_snapshot->>'effectiveAt'<>expected_effective
     or p_snapshot#>>'{pricingReference,id}'<>prior.id::text
     or p_snapshot#>>'{pricingReference,version}'<>prior.business_version::text
     or p_snapshot#>>'{pricingReference,contentHash}'<>expected_evidence_hash
     or p_snapshot#>>'{provenance,sourceSystem}'<>'novalure-crm-financial-review'
     or p_snapshot#>>'{provenance,sourceRecordId}'<>prior.id::text
     or p_snapshot#>>'{provenance,sourceVersion}'<>prior.business_version::text
     or p_snapshot#>>'{provenance,sourceHash}'<>expected_evidence_hash
     or p_snapshot#>>'{provenance,recordedBy}'<>p_created_by::text
     or p_snapshot#>>'{provenance,recordedAt}'<>to_char(p_created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
     or not crm_financial_review_lines_valid(prior,p_snapshot) then return false; end if;
  if p_resource_type='DEAL' and not exists(select 1 from deals d where d.workspace_id=p_workspace and d.project_id=p_project and d.id=p_resource_id)
     or p_resource_type='PROPERTY_SALE' and not exists(select 1 from property_sales s where s.workspace_id=p_workspace and s.project_id=p_project and s.id=p_resource_id)
     or p_resource_type='PROPERTY_COST_MATRIX' and not exists(select 1 from seller_listings l where l.workspace_id=p_workspace and l.project_id=p_project and l.id=p_resource_id) then return false; end if;
  return true;
exception when others then return false;
end $$;

-- Runtime callers may submit a NEEDS_REVIEW row only when it is byte-for-byte
-- the row produced by one of the deferred fixation triggers.  A deterministic
-- id alone is insufficient: the source row, fixation timestamp, correlation,
-- canonical snapshot and evidence all have to agree with the server source.
create or replace function crm_financial_pending_fixation_exact(
  p_id uuid,p_workspace uuid,p_project uuid,p_resource_type text,p_resource_id uuid,p_business_version bigint,
  p_snapshot jsonb,p_legacy_classification text,p_legacy_evidence jsonb,p_created_by uuid,p_created_at timestamptz,
  p_supersedes uuid,p_correlation_id uuid
)
returns boolean language plpgsql stable set search_path=pg_catalog,public as $$
declare deal_record record; offer_record record; sale_record record; audit_record record;
  expected_snapshot jsonb; expected_evidence jsonb; expected_hash text; expected_at timestamptz;
  expected_classification text; expected_recorded_at timestamptz; expected_recorded_by uuid;
begin
  if p_supersedes is not null then return false; end if;
  if p_resource_type='DEAL' then
    select d.id,d.workspace_id,d.project_id,d.stage,d.version,d.closed_at,
      accepted.id offer_id,accepted.revision,r.total_net_cents,r.content_digest,r.created_by revision_actor,r.created_at revision_at,
      h.changed_at acceptance_at,h.changed_by_user_id acceptance_actor
      into deal_record
      from deals d
      left join lateral (
        select o.id,o.revision,o.project_id,o.deal_id,o.status
        from crm_offers o where o.workspace_id=d.workspace_id and o.project_id is not distinct from d.project_id
          and o.deal_id=d.id and o.status='ACCEPTED'
        order by o.updated_at desc,o.id limit 1
      ) accepted on true
      left join crm_offer_revisions r on r.workspace_id=d.workspace_id and r.project_id=d.project_id
        and r.offer_id=accepted.id and r.revision=accepted.revision
      left join lateral (
        select h.changed_at,h.changed_by_user_id
        from deal_stage_history h
        where h.workspace_id=d.workspace_id and h.project_id is not distinct from d.project_id and h.deal_id=d.id
          and h.to_stage='Gewonnen' and accepted.id is not null
          and h.metadata->>'offerId'=accepted.id::text and h.metadata->>'revision'=accepted.revision::text
          and h.metadata->>'contentDigest'=r.content_digest
        order by h.changed_at,h.id limit 1
      ) h on true
      where d.workspace_id=p_workspace and d.id=p_resource_id and d.project_id is not distinct from p_project
        and d.stage='Gewonnen' and d.version=p_business_version;
    if not found then return false; end if;
    if deal_record.offer_id is not null and deal_record.acceptance_at is not null then
      expected_at:=deal_record.acceptance_at; expected_classification:='B';
      expected_snapshot:=jsonb_build_object(
        'snapshotSchemaVersion','financial-snapshot-v1','snapshotId',p_id::text,'businessVersion',p_business_version,
        'tenantId',p_workspace::text,'resourceId',p_resource_id::text,'reviewState','NEEDS_REVIEW',
        'effectiveAt',to_char(expected_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'currency','EUR','minorUnitExponent',2,
        'currencyDefinition',null,'jurisdiction',null,'components',null,
        'totals',jsonb_build_object('net',jsonb_build_object('minorUnits',deal_record.total_net_cents::text,'currency','EUR','minorUnitExponent',2),'tax',null,'gross',null),
        'roundingPolicy',null,'pricingReference',jsonb_build_object('id',deal_record.offer_id::text,'version',deal_record.revision::text,'contentHash',deal_record.content_digest),
        'provenance',jsonb_build_object('sourceSystem','novalure-crm','sourceRecordId',deal_record.offer_id::text,'sourceVersion',deal_record.revision::text,
          'sourceHash',deal_record.content_digest,'recordedAt',to_char(deal_record.revision_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'recordedBy',deal_record.revision_actor::text),
        'missingFields',jsonb_build_array('components','currencyDefinition','jurisdiction','roundingPolicy','taxPolicy','totals.gross','totals.tax'));
      expected_evidence:=jsonb_build_object('source','deal-won-transition-bound-accepted-offer','dealId',p_resource_id::text,
        'offerId',deal_record.offer_id::text,'mutableDealValueExcluded',true);
      return p_id=crm_financial_deterministic_uuid('deal:'||p_workspace||':'||p_resource_id||':'||p_business_version)
        and p_legacy_classification=expected_classification and p_legacy_evidence=expected_evidence
        and p_snapshot=expected_snapshot and p_created_at=expected_at
        and p_correlation_id=crm_financial_deterministic_uuid('correlation:deal:'||p_workspace||':'||p_resource_id||':'||p_business_version);
    end if;
    -- A C row is emitted only for a close carrying an immutable closed_at.  The
    -- repository always supplies closed_at for a terminal transition; rejecting
    -- a transaction-time fallback prevents a caller from choosing its own fact.
    if deal_record.closed_at is null then return false; end if;
    expected_at:=deal_record.closed_at; expected_classification:='C';
    expected_snapshot:=jsonb_build_object(
      'snapshotSchemaVersion','financial-snapshot-v1','snapshotId',p_id::text,'businessVersion',p_business_version,
      'tenantId',p_workspace::text,'resourceId',p_resource_id::text,'reviewState','NEEDS_REVIEW',
      'effectiveAt',to_char(expected_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'currency',null,'minorUnitExponent',null,
      'currencyDefinition',null,'jurisdiction',null,'components',null,'totals',jsonb_build_object('net',null,'tax',null,'gross',null),
      'roundingPolicy',null,'pricingReference',null,'provenance',null,
      'missingFields',jsonb_build_array('components','currency','currencyDefinition','jurisdiction','minorUnitExponent','pricingReference','provenance','roundingPolicy','taxPolicy','totals.gross','totals.net','totals.tax'));
    expected_evidence:=jsonb_build_object('source','deal-won-transition-without-bound-economic-evidence','dealId',p_resource_id::text,'mutableDealValueExcluded',true);
    if p_id=crm_financial_deterministic_uuid('deal:'||p_workspace||':'||p_resource_id||':'||p_business_version)
      and p_legacy_classification=expected_classification and p_legacy_evidence=expected_evidence
      and p_snapshot=expected_snapshot and p_created_at=expected_at
      and p_correlation_id=crm_financial_deterministic_uuid('correlation:deal:'||p_workspace||':'||p_resource_id||':'||p_business_version) then return true; end if;
    return false;
  elsif p_resource_type='OFFER' then
    select o.id,o.workspace_id,o.project_id,o.deal_id,o.revision,r.total_net_cents,r.content_digest,
      r.created_by revision_actor,r.created_at revision_at,h.changed_at acceptance_at
      into offer_record
      from crm_offers o join crm_offer_revisions r on r.workspace_id=o.workspace_id and r.project_id=o.project_id
        and r.offer_id=o.id and r.revision=o.revision
      join deals d on d.workspace_id=o.workspace_id and d.project_id=o.project_id and d.id=o.deal_id and d.stage='Gewonnen'
      join lateral (select h.changed_at from deal_stage_history h where h.workspace_id=o.workspace_id and h.project_id=o.project_id
        and h.deal_id=o.deal_id and h.to_stage='Gewonnen' and h.metadata->>'offerId'=o.id::text
        and h.metadata->>'revision'=o.revision::text and h.metadata->>'contentDigest'=r.content_digest
        order by h.changed_at,h.id limit 1) h on true
      where o.workspace_id=p_workspace and o.project_id is not distinct from p_project and o.id=p_resource_id
        and o.revision=p_business_version and o.status='ACCEPTED';
    if not found then return false; end if;
    expected_at:=offer_record.acceptance_at;
    expected_snapshot:=jsonb_build_object(
      'snapshotSchemaVersion','financial-snapshot-v1','snapshotId',p_id::text,'businessVersion',p_business_version,
      'tenantId',p_workspace::text,'resourceId',p_resource_id::text,'reviewState','NEEDS_REVIEW',
      'effectiveAt',to_char(expected_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'currency','EUR','minorUnitExponent',2,
      'currencyDefinition',null,'jurisdiction',null,'components',null,
      'totals',jsonb_build_object('net',jsonb_build_object('minorUnits',offer_record.total_net_cents::text,'currency','EUR','minorUnitExponent',2),'tax',null,'gross',null),
      'roundingPolicy',null,'pricingReference',jsonb_build_object('id',p_resource_id::text,'version',p_business_version::text,'contentHash',offer_record.content_digest),
      'provenance',jsonb_build_object('sourceSystem','novalure-crm','sourceRecordId',p_resource_id::text,'sourceVersion',p_business_version::text,
        'sourceHash',offer_record.content_digest,'recordedAt',to_char(offer_record.revision_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'recordedBy',offer_record.revision_actor::text),
      'missingFields',jsonb_build_array('components','currencyDefinition','jurisdiction','roundingPolicy','taxPolicy','totals.gross','totals.tax'));
    expected_evidence:=jsonb_build_object('source','accepted-offer-fixed-by-deal-win','offerRevision',p_business_version,
      'contentDigest',offer_record.content_digest,'historicalAcceptanceBound',true);
    return p_id=crm_financial_deterministic_uuid('offer:'||p_workspace||':'||p_resource_id||':'||p_business_version)
      and p_legacy_classification='B' and p_legacy_evidence=expected_evidence and p_snapshot=expected_snapshot
      and p_created_at=expected_at and p_correlation_id=crm_financial_deterministic_uuid('correlation:offer:'||p_workspace||':'||p_resource_id||':'||p_business_version);
  elsif p_resource_type='PROPERTY_SALE' then
    select s.id,s.workspace_id,s.project_id,s.unit_id,s.reservation_id,s.buyer_lead_id,s.contact_id,s.confirmed_by,s.source_reference,s.confirmed_at,s.unit_version,
      a.id audit_id,a.actor_user_id,a.created_at audit_at,a.before,a.after,a.before->>'priceCents' price_minor_units
      into sale_record
      from property_sales s left join lateral (select a.* from property_unit_audit_events a
        where a.workspace_id=s.workspace_id and a.project_id=s.project_id and a.unit_id=s.unit_id
          and a.event_type='authorized_sales_transition' and a.after->>'saleId'=s.id::text
          and a.before->>'priceCents' ~ '^(?:0|[1-9][0-9]{0,77})$'
        order by a.created_at,a.id limit 1) a on true
      where s.workspace_id=p_workspace and s.project_id is not distinct from p_project and s.id=p_resource_id;
    if not found then return false; end if;
    if sale_record.audit_id is not null then
      expected_classification:='B'; expected_at:=sale_record.confirmed_at; expected_recorded_at:=sale_record.audit_at; expected_recorded_by:=sale_record.actor_user_id;
      expected_hash:=crm_financial_sha256(jsonb_build_object('auditId',sale_record.audit_id::text,'before',sale_record.before,'after',sale_record.after,
        'createdAt',to_char(sale_record.audit_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')));
    else
      expected_classification:='C'; expected_at:=sale_record.confirmed_at; expected_recorded_at:=sale_record.confirmed_at; expected_recorded_by:=sale_record.confirmed_by;
      expected_hash:=crm_financial_sha256(jsonb_build_object('saleId',sale_record.id::text,'sourceReference',sale_record.source_reference,'unitVersion',sale_record.unit_version));
    end if;
    expected_snapshot:=jsonb_build_object(
      'snapshotSchemaVersion','financial-snapshot-v1','snapshotId',p_id::text,'businessVersion',1,
      'tenantId',p_workspace::text,'resourceId',p_resource_id::text,'reviewState','NEEDS_REVIEW',
      'effectiveAt',to_char(expected_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'currency',null,
      'minorUnitExponent',case when expected_classification='B' then 2 else null end,'currencyDefinition',null,'jurisdiction',null,'components',null,
      'totals',jsonb_build_object('net',null,'tax',null,'gross',null),'roundingPolicy',null,
      'pricingReference',case when expected_classification='B' then jsonb_build_object('id',sale_record.unit_id::text,'version',sale_record.unit_version::text,'contentHash',expected_hash) else null end,
      'provenance',jsonb_build_object('sourceSystem','novalure-crm','sourceRecordId',case when expected_classification='B' then sale_record.audit_id::text else sale_record.id::text end,
        'sourceVersion',sale_record.unit_version::text,'sourceHash',expected_hash,'recordedAt',to_char(expected_recorded_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'recordedBy',expected_recorded_by::text),
      'missingFields',case when expected_classification='B' then jsonb_build_array('components','currency','currencyDefinition','jurisdiction','roundingPolicy','taxPolicy','totals.gross','totals.net','totals.tax')
        else jsonb_build_array('components','currency','currencyDefinition','jurisdiction','minorUnitExponent','pricingReference','roundingPolicy','taxPolicy','totals.gross','totals.net','totals.tax') end);
    expected_evidence:=jsonb_build_object('source',case when expected_classification='B' then 'property-sale-bound-unit-audit' else 'property-sale-without-bound-price-event' end,
      'saleId',sale_record.id::text,'unitId',sale_record.unit_id::text,'unitVersion',sale_record.unit_version,
      'saleTimePriceMinorUnits',case when expected_classification='B' then sale_record.price_minor_units else null end,'evidenceHash',expected_hash);
    return p_id=crm_financial_deterministic_uuid('property-sale:'||p_workspace||':'||p_resource_id)
      and p_legacy_classification=expected_classification and p_legacy_evidence=expected_evidence and p_snapshot=expected_snapshot
      and p_created_at=expected_at and p_correlation_id=crm_financial_deterministic_uuid('correlation:property-sale:'||p_workspace||':'||p_resource_id);
  end if;
  return false;
exception when others then raise;
end $$;

create or replace function crm_financial_pending_runtime_allowed(
  p_id uuid,p_workspace uuid,p_project uuid,p_resource_type text,p_resource_id uuid,p_business_version bigint,
  p_snapshot jsonb,p_legacy_classification text,p_legacy_evidence jsonb,p_created_by uuid,p_created_at timestamptz,
  p_supersedes uuid,p_correlation_id uuid
)
returns boolean language plpgsql stable set search_path=pg_catalog,public as $$
declare expected_evidence jsonb; expected_hash text; previous crm_financial_snapshots%rowtype;
begin
  if p_snapshot->>'reviewState'<>'NEEDS_REVIEW' or p_legacy_classification is null or p_legacy_evidence is null
     or p_created_by is distinct from nullif(current_setting('app.actor_id',true),'')::uuid then
    return false;
  end if;
  if p_resource_type='PROPERTY_COST_MATRIX' then
    if p_legacy_classification<>'B'
       or not exists(select 1 from seller_listings l where l.workspace_id=p_workspace and l.project_id=p_project and l.id=p_resource_id)
       or p_snapshot->>'snapshotId'<>p_id::text
       or p_snapshot->>'tenantId'<>p_workspace::text
       or p_snapshot->>'resourceId'<>p_resource_id::text
       or (p_snapshot->>'businessVersion')::bigint<>p_business_version
       or p_snapshot#>>'{provenance,sourceSystem}'<>'novalure-crm'
       or p_snapshot#>>'{provenance,sourceRecordId}'<>p_resource_id::text
       or p_snapshot#>>'{provenance,sourceVersion}'<>p_business_version::text
       or p_snapshot#>>'{provenance,recordedBy}'<>p_created_by::text
       or p_snapshot#>>'{provenance,recordedAt}'<>p_snapshot->>'effectiveAt'
       or not crm_financial_iso_instant_valid(p_snapshot->>'effectiveAt')
       or p_snapshot#>>'{pricingReference,id}'<>p_resource_id::text
       or p_snapshot#>>'{pricingReference,version}'<>p_business_version::text then return false; end if;
    select * into previous from crm_financial_snapshots prior
      where prior.workspace_id=p_workspace and prior.resource_type='PROPERTY_COST_MATRIX'
        and prior.resource_id=p_resource_id and prior.business_version=p_business_version-1;
    if p_business_version=1 then
      if p_supersedes is not null or found then return false; end if;
    elsif not found or p_supersedes is distinct from previous.id or previous.review_state<>'NEEDS_REVIEW' then
      return false;
    end if;
    if exists(select 1 from property_cost_items c where c.workspace_id=p_workspace and c.project_id=p_project
      and c.property_id=p_resource_id and (c.metadata#>'{financialSemantics,monthly}' is null
        or c.metadata#>'{financialSemantics,oneTime}' is null)) then return false; end if;
    select jsonb_build_object(
      'source','property-cost-items-v1','exactMinorUnitStrings',true,'currencyUnknown',true,
      'taxPolicyUnknown',true,'roundingPolicyUnknown',true,
      'items',coalesce(jsonb_agg(jsonb_build_object(
        'costKey',c.cost_key,'label',c.label,'groupKey',c.group_key,'position',c.position,
        'monthly',c.metadata#>'{financialSemantics,monthly}',
        'oneTime',c.metadata#>'{financialSemantics,oneTime}'
      ) order by c.position,c.cost_key collate "C",c.id),'[]'::jsonb)
    ) into expected_evidence
    from property_cost_items c
    where c.workspace_id=p_workspace and c.project_id=p_project and c.property_id=p_resource_id;
    if expected_evidence is null or p_legacy_evidence is distinct from expected_evidence then return false; end if;
    expected_hash:=crm_financial_sha256(jsonb_build_object('contractVersion','property-cost-evidence-v1','evidence',expected_evidence));
    return p_legacy_evidence->>'source'='property-cost-items-v1'
      and p_legacy_evidence->>'exactMinorUnitStrings'='true'
      and p_snapshot#>>'{pricingReference,contentHash}'=expected_hash
      and p_snapshot#>>'{provenance,sourceHash}'=expected_hash;
  elsif p_resource_type in('DEAL','OFFER','PROPERTY_SALE') then
    return crm_financial_pending_fixation_exact(
      p_id,p_workspace,p_project,p_resource_type,p_resource_id,p_business_version,p_snapshot,
      p_legacy_classification,p_legacy_evidence,p_created_by,p_created_at,p_supersedes,p_correlation_id
    );
  end if;
  return false;
exception when others then return false;
end $$;

create or replace function crm_financial_snapshot_authority_guard()
returns trigger language plpgsql set search_path=pg_catalog,public as $$
begin
  if new.review_state='VERIFIED' and not crm_financial_complete_source_valid(
    new.id,new.workspace_id,new.project_id,new.resource_type,new.resource_id,new.business_version,
    new.canonical_snapshot,new.supersedes_snapshot_id,new.created_by,new.created_at) then
    raise exception using errcode='23514',message='Verified financial snapshot is not bound to registered policy and immutable source authority';
  end if;
  return new;
end $$;
create trigger crm_financial_snapshot_authority before insert on crm_financial_snapshots
  for each row execute function crm_financial_snapshot_authority_guard();

create or replace function crm_financial_snapshot_supersedes_guard()
returns trigger language plpgsql set search_path=pg_catalog,public as $$
declare prior crm_financial_snapshots%rowtype;
begin
  if new.supersedes_snapshot_id is null then return new; end if;
  select * into prior from crm_financial_snapshots where workspace_id=new.workspace_id and id=new.supersedes_snapshot_id;
  if not found or prior.project_id is distinct from new.project_id or prior.resource_type<>new.resource_type or prior.resource_id<>new.resource_id
     or new.business_version<>prior.business_version+1 then
    raise exception using errcode='23514',message='Financial snapshot supersedes link must continue one resource by one version';
  end if;
  return new;
end $$;
create trigger crm_financial_snapshot_supersedes before insert on crm_financial_snapshots for each row execute function crm_financial_snapshot_supersedes_guard();

create or replace function crm_financial_snapshot_contains_policy(p_snapshot jsonb,p_policy crm_financial_policy_versions)
returns boolean language sql immutable set search_path=pg_catalog,public as $$
  select coalesce(
    (p_policy.policy_kind='CURRENCY'
      and p_snapshot#>>'{currencyDefinition,registryReference,id}'=p_policy.policy_id
      and p_snapshot#>>'{currencyDefinition,registryReference,version}'=p_policy.policy_version
      and p_snapshot#>>'{currencyDefinition,registryReference,contentHash}'=p_policy.content_hash)
    or (p_policy.policy_kind='ROUNDING'
      and p_snapshot#>>'{roundingPolicy,id}'=p_policy.policy_id
      and p_snapshot#>>'{roundingPolicy,version}'=p_policy.policy_version
      and p_snapshot#>>'{roundingPolicy,contentHash}'=p_policy.content_hash)
    or (p_policy.policy_kind='TAX' and exists(
      select 1 from jsonb_array_elements(p_snapshot->'components') component,
        jsonb_array_elements(component->'taxComponents') tax_component
      where tax_component#>>'{policy,reference,id}'=p_policy.policy_id
        and tax_component#>>'{policy,reference,version}'=p_policy.policy_version
        and tax_component#>>'{policy,reference,contentHash}'=p_policy.content_hash
    )),false)
$$;

create or replace function crm_financial_event_guard()
returns trigger language plpgsql set search_path=pg_catalog,public as $$
declare stored crm_financial_snapshots%rowtype; policy_record crm_financial_policy_versions%rowtype;
begin
  select * into stored from crm_financial_snapshots where workspace_id=new.workspace_id and id=new.snapshot_id;
  if not found or stored.project_id is distinct from new.project_id or stored.snapshot_hash<>new.financial_snapshot_hash then
    raise exception using errcode='23514',message='Financial event must bind the stored snapshot and hash';
  end if;
  if new.event_type='LEGACY_NEEDS_REVIEW' and (stored.review_state<>'NEEDS_REVIEW' or stored.legacy_classification is null) then
    raise exception using errcode='23514',message='Legacy review event requires a legacy review snapshot';
  elsif new.event_type='SUPERSEDED' and stored.supersedes_snapshot_id is distinct from new.related_snapshot_id then
    raise exception using errcode='23514',message='Superseded event must bind the stored predecessor';
  elsif new.event_type='REVIEW_VERIFIED' then
    if stored.review_state<>'VERIFIED' or stored.canonical_snapshot->>'reviewState'<>'COMPLETE'
       or (stored.resource_type<>'CONTRACT' and stored.supersedes_snapshot_id is distinct from new.related_snapshot_id)
       or (stored.resource_type='CONTRACT' and (new.details->>'resolvedResourceType'<>'OFFER'
         or new.details->>'resolutionTargetType'<>'CONTRACT'
         or new.details->>'sourceOfferId'<>stored.canonical_snapshot#>>'{pricingReference,id}'))
       or not exists(select 1 from crm_financial_snapshots prior where prior.workspace_id=stored.workspace_id
         and prior.id=new.related_snapshot_id and prior.project_id is not distinct from stored.project_id
         and prior.review_state='NEEDS_REVIEW' and (
           (stored.resource_type='CONTRACT' and prior.resource_type='OFFER'
             and prior.resource_id=(stored.canonical_snapshot#>>'{pricingReference,id}')::uuid
             and prior.resource_id=(stored.canonical_snapshot#>>'{provenance,sourceRecordId}')::uuid
             and prior.business_version=(stored.canonical_snapshot#>>'{pricingReference,version}')::bigint
             and prior.canonical_snapshot#>>'{pricingReference,contentHash}'=stored.canonical_snapshot#>>'{pricingReference,contentHash}')
           or (stored.resource_type<>'CONTRACT' and prior.resource_type=stored.resource_type
             and prior.resource_id=stored.resource_id)
         )) then
      raise exception using errcode='23514',message='Review verification event must bind the reviewed predecessor';
    end if;
  elsif new.event_type='POLICY_BOUND' then
    select * into policy_record from crm_financial_policy_versions where workspace_id=new.workspace_id
      and project_id=new.project_id and id=new.policy_version_id;
    if not found or stored.review_state<>'VERIFIED' or not crm_financial_snapshot_contains_policy(stored.canonical_snapshot,policy_record) then
      raise exception using errcode='23514',message='Policy event must bind a policy referenced by the verified snapshot';
    end if;
  elsif new.event_type in('APPROVAL_REQUESTED','APPROVAL_VERIFIED') then
    if stored.resource_type<>'CONTRACT' or stored.review_state<>'VERIFIED' or stored.canonical_snapshot->>'reviewState'<>'COMPLETE'
       or new.approval_contract_version<>'v2' or not exists(
         select 1 from crm_evelyn_contract_revisions revision where revision.workspace_id=stored.workspace_id
           and revision.project_id=stored.project_id and revision.action_id=stored.resource_id
           and revision.financial_snapshot_id=stored.id and revision.financial_snapshot_hash=stored.snapshot_hash
           and revision.approval_contract_version='v2' and revision.action_hash=new.action_hash
       ) then raise exception using errcode='23514',message='Approval event must bind a verified V2 contract revision'; end if;
  end if;
  return new;
end $$;
create trigger crm_financial_event_binding before insert on crm_financial_events for each row execute function crm_financial_event_guard();

-- Financial facts normally inherit project access. Migration 080 also permits
-- an agent to own a projectless deal; preserve that existing scope for the
-- immutable snapshot written by the deferred won-transition trigger.
create or replace function crm_financial_snapshot_access(
  p_workspace uuid,p_project uuid,p_resource_type text,p_resource_id uuid,p_write boolean default false
)
returns boolean language sql stable security invoker set search_path=pg_catalog,public as $$
  select (p_project is not null and public.crm_project_access(p_workspace,p_project,p_write)) or (
    p_project is null and p_resource_type='DEAL'
    and p_workspace=nullif(current_setting('app.tenant_id',true),'')::uuid
    and exists(
      select 1 from public.deals d join public.workspace_users actor
        on actor.workspace_id=d.workspace_id and actor.id=d.owner_user_id
      where d.workspace_id=p_workspace and d.id=p_resource_id and d.project_id is null
        and actor.id=nullif(current_setting('app.actor_id',true),'')::uuid and actor.status='active'
        and (not p_write or actor.role in('owner','admin','agent'))
    )
  )
$$;

do $migration$
declare relation text;
begin
  foreach relation in array array['crm_financial_policy_versions','crm_financial_snapshots','crm_financial_events'] loop
    execute format('create trigger crm_sales_classification_guard before insert on %I for each row execute function crm_set_sales_classification()',relation);
    execute format('create trigger crm_financial_immutable before update or delete or truncate on %I for each statement execute function crm_reject_immutable_mutation()',relation);
    execute format('alter table %I enable row level security',relation);
    execute format('alter table %I force row level security',relation);
    execute format('revoke all on %I from public',relation);
    execute format('grant select,insert on %I to novalure_tenant_app',relation);
  end loop;
end $migration$;

create policy crm_financial_read on crm_financial_policy_versions for select to novalure_tenant_app using (
  crm_classification_allowed(workspace_id,data_classification,data_purpose)
  and crm_project_access(workspace_id,project_id,false)
);
create policy crm_financial_append on crm_financial_policy_versions for insert to novalure_tenant_app with check (
  crm_classification_allowed(workspace_id,data_classification,data_purpose)
  and crm_project_access(workspace_id,project_id,true)
  and crm_workspace_manager(workspace_id)
  and created_by=nullif(current_setting('app.actor_id',true),'')::uuid
);
create policy crm_financial_read on crm_financial_snapshots for select to novalure_tenant_app using (
  crm_classification_allowed(workspace_id,data_classification,data_purpose)
  and crm_financial_snapshot_access(workspace_id,project_id,resource_type,resource_id,false)
);
create policy crm_financial_append on crm_financial_snapshots for insert to novalure_tenant_app with check (
  crm_classification_allowed(workspace_id,data_classification,data_purpose)
  and crm_financial_snapshot_access(workspace_id,project_id,resource_type,resource_id,true)
  and created_by=nullif(current_setting('app.actor_id',true),'')::uuid
  and (
    (review_state='VERIFIED' and (resource_type='CONTRACT' or crm_workspace_manager(workspace_id))
      and crm_financial_complete_source_valid(
      id,workspace_id,project_id,resource_type,resource_id,business_version,canonical_snapshot,
      supersedes_snapshot_id,created_by,created_at))
    or (review_state='NEEDS_REVIEW' and crm_financial_pending_runtime_allowed(
      id,workspace_id,project_id,resource_type,resource_id,business_version,canonical_snapshot,
      legacy_classification,legacy_evidence,created_by,created_at,supersedes_snapshot_id,correlation_id))
  )
);
create policy crm_financial_read on crm_financial_events for select to novalure_tenant_app using (
  crm_classification_allowed(workspace_id,data_classification,data_purpose)
  and exists(
    select 1 from crm_financial_snapshots snapshot
    where snapshot.workspace_id=crm_financial_events.workspace_id and snapshot.id=crm_financial_events.snapshot_id
      and snapshot.project_id is not distinct from crm_financial_events.project_id
  )
);
create policy crm_financial_append on crm_financial_events for insert to novalure_tenant_app with check (
  crm_classification_allowed(workspace_id,data_classification,data_purpose)
  and exists(
    select 1 from crm_financial_snapshots snapshot
    where snapshot.workspace_id=crm_financial_events.workspace_id and snapshot.id=crm_financial_events.snapshot_id
      and snapshot.project_id is not distinct from crm_financial_events.project_id
      and crm_financial_snapshot_access(snapshot.workspace_id,snapshot.project_id,snapshot.resource_type,snapshot.resource_id,true)
  )
  and actor_id=nullif(current_setting('app.actor_id',true),'')::uuid
  and (
    exists(
      select 1 from crm_financial_snapshots snapshot
      where snapshot.workspace_id=crm_financial_events.workspace_id and snapshot.id=crm_financial_events.snapshot_id
        and snapshot.created_by=nullif(current_setting('app.actor_id',true),'')::uuid
        -- The immutable row already passed the source-authority insert guard.
        -- Re-running its next-version check here would treat it as its own
        -- predecessor and reject every subsequent event.
        and ((snapshot.review_state='VERIFIED'
            and (snapshot.resource_type='CONTRACT' or crm_workspace_manager(snapshot.workspace_id)))
          or (snapshot.review_state='NEEDS_REVIEW' and crm_financial_pending_runtime_allowed(
            snapshot.id,snapshot.workspace_id,snapshot.project_id,snapshot.resource_type,snapshot.resource_id,
            snapshot.business_version,snapshot.canonical_snapshot,snapshot.legacy_classification,
            snapshot.legacy_evidence,snapshot.created_by,snapshot.created_at,snapshot.supersedes_snapshot_id,snapshot.correlation_id)))
    )
  )
);
grant usage,select on sequence crm_financial_events_sequence_seq to novalure_tenant_app;

-- Replacing one cost matrix removes only rows visible through the forced
-- tenant/project policy installed by 080; no unscoped DELETE path is granted.
grant delete on property_cost_items to novalure_tenant_app;

alter table crm_evelyn_contract_revisions
  add column approval_contract_version text not null default 'v1',
  add column financial_snapshot_id uuid,
  add column financial_snapshot_hash text;
alter table crm_evelyn_contract_revisions
  add constraint crm_evelyn_contract_revision_version_check check(approval_contract_version in('v1','v2')),
  add constraint crm_evelyn_contract_revision_snapshot_hash_check check(financial_snapshot_hash is null or financial_snapshot_hash ~ '^[a-f0-9]{64}$'),
  add constraint crm_evelyn_contract_revision_v1_v2_check check(
    (approval_contract_version='v1' and financial_snapshot_id is null and financial_snapshot_hash is null and action->>'actionContractVersion' is null)
    or (approval_contract_version='v2' and financial_snapshot_id is not null and financial_snapshot_hash is not null
      and action->>'actionContractVersion'='approval-action-v2'
      and action#>>'{financialSnapshot,snapshotId}'=financial_snapshot_id::text
      and action->>'financialSnapshotHash'=financial_snapshot_hash)),
  add constraint crm_evelyn_contract_revision_financial_snapshot_fk foreign key(workspace_id,project_id,financial_snapshot_id)
    references crm_financial_snapshots(workspace_id,project_id,id);
create index crm_evelyn_contract_revision_snapshot_idx on crm_evelyn_contract_revisions(workspace_id,financial_snapshot_id) where financial_snapshot_id is not null;

create or replace function crm_evelyn_contract_revision_financial_guard()
returns trigger language plpgsql set search_path=pg_catalog,public as $$
declare stored crm_financial_snapshots%rowtype;
begin
  if new.approval_contract_version='v1' then
    if exists(
      select 1 from crm_evelyn_contract_revisions prior
      where prior.workspace_id=new.workspace_id and prior.project_id=new.project_id
        and prior.action_id=new.action_id and prior.version<new.version
        and prior.approval_contract_version='v2'
    ) then
      raise exception using errcode='23514',message='Evelyn approval contract cannot downgrade from V2 to V1';
    end if;
    return new;
  end if;
  select * into stored from crm_financial_snapshots where workspace_id=new.workspace_id and project_id=new.project_id and id=new.financial_snapshot_id;
  if not found or stored.resource_type<>'CONTRACT' or stored.review_state<>'VERIFIED'
     or stored.canonical_snapshot->>'reviewState'<>'COMPLETE'
     or stored.snapshot_hash<>new.financial_snapshot_hash or stored.canonical_snapshot<>new.action->'financialSnapshot'
     or stored.resource_id<>new.action_id or stored.business_version<>(new.action->>'resourceVersion')::bigint
     or (new.action->>'actionVersion')::integer<>new.version then
    raise exception using errcode='23514',message='Evelyn V2 revision must bind the immutable financial snapshot';
  end if;
  return new;
exception when invalid_text_representation or numeric_value_out_of_range then
  raise exception using errcode='23514',message='Evelyn V2 revision contains an invalid financial version';
end $$;
create trigger crm_evelyn_contract_revision_financial_binding before insert on crm_evelyn_contract_revisions
  for each row execute function crm_evelyn_contract_revision_financial_guard();

-- RLS grants row mutation, but stage transitions need the narrower pipeline flags.
-- Enforce the same close/move/reopen decision at the database boundary so a direct
-- SQL caller cannot bypass the repository command checks.
create or replace function crm_deal_stage_permission_guard()
returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
declare actor uuid:=nullif(current_setting('app.actor_id',true),'')::uuid;
  terminal_stages constant text[]:=array['Gewonnen','Verloren','Disqualifiziert','Pausiert / Verloren'];
  permission record; required_capability text;
begin
  if coalesce((select role_record.rolsuper or role_record.rolbypassrls from pg_roles role_record where role_record.rolname=current_user),false)
     or not pg_has_role(current_user,'novalure_tenant_app','member') then return new; end if;
  if actor is null or new.workspace_id is distinct from nullif(current_setting('app.tenant_id',true),'')::uuid then
    raise exception using errcode='42501',message='Deal stage actor context is required';
  end if;
  if TG_OP='UPDATE' and new.stage is not distinct from old.stage then return new; end if;
  if TG_OP='INSERT' and not (new.stage=any(terminal_stages)) then return new; end if;
  if crm_workspace_manager(new.workspace_id) then return new; end if;

  required_capability:=case
    when new.stage=any(terminal_stages) then 'close'
    when TG_OP='UPDATE' and old.stage=any(terminal_stages) then 'reopen'
    else 'move'
  end;
  if new.project_id is null then
    if required_capability='move' and new.owner_user_id=actor and exists(
      select 1 from workspace_users member where member.workspace_id=new.workspace_id and member.id=actor
        and member.status='active' and member.role in('owner','admin','agent')
    ) then return new; end if;
    raise exception using errcode='42501',message='Project pipeline permission is required';
  end if;
  select grants.can_edit_deals,grants.can_move_deals,grants.can_close_deals,grants.can_reopen_deals into permission
    from project_pipeline_permissions grants join workspace_users member
      on member.workspace_id=grants.workspace_id and member.id=grants.user_id
    where grants.workspace_id=new.workspace_id and grants.project_id=new.project_id and grants.user_id=actor
      and member.status='active';
  if not found or not permission.can_edit_deals
     or required_capability='move' and not permission.can_move_deals
     or required_capability='close' and not permission.can_close_deals
     or required_capability='reopen' and not permission.can_reopen_deals then
    raise exception using errcode='42501',message='Project pipeline stage permission denied';
  end if;
  return new;
end $$;
create trigger crm_deal_stage_permission_insert before insert on deals
  for each row execute function crm_deal_stage_permission_guard();
create trigger crm_deal_stage_permission_update before update of stage on deals
  for each row execute function crm_deal_stage_permission_guard();

-- Fix future deal wins in the same transaction as the first transition. The accepted offer
-- revision is the only monetary authority; an unbound mutable deals.value_cents is excluded.
create or replace function crm_record_deal_financial_fixation()
returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
declare actor uuid:=nullif(current_setting('app.actor_id',true),'')::uuid; fixed_at timestamptz:=coalesce(new.closed_at,transaction_timestamp());
  offer_record record; snapshot_id uuid; snapshot jsonb; snapshot_record crm_financial_snapshots%rowtype;
  expected_hash text; expected_evidence jsonb; expected_correlation uuid; existing_root crm_financial_snapshots%rowtype;
begin
  if TG_OP='INSERT' then
    if new.stage<>'Gewonnen' then return new; end if;
  elsif TG_OP='UPDATE' then
    if new.stage<>'Gewonnen' or old.stage='Gewonnen' then return new; end if;
  else
    return new;
  end if;

  perform pg_advisory_xact_lock(hashtextextended('financial-fixation:deal:'||new.workspace_id||':'||new.id,0));

  -- Reopen/reclose keeps the first immutable root, but only after validating a
  -- complete prior fixation marker. An arbitrary pre-seeded row is never accepted.
  select * into existing_root from crm_financial_snapshots existing
    where existing.workspace_id=new.workspace_id and existing.resource_type='DEAL' and existing.resource_id=new.id
    order by existing.business_version,existing.id limit 1;
  if found and existing_root.business_version<new.version
     and existing_root.id=crm_financial_deterministic_uuid(
       'deal:'||existing_root.workspace_id||':'||existing_root.resource_id||':'||existing_root.business_version)
     and existing_root.project_id is not distinct from new.project_id
     and existing_root.review_state='NEEDS_REVIEW' and existing_root.legacy_classification in('B','C')
     and existing_root.legacy_evidence->>'source' in(
       'deal-won-transition-bound-accepted-offer','deal-won-transition-without-bound-economic-evidence')
     and exists(select 1 from crm_financial_events marker where marker.workspace_id=existing_root.workspace_id
       and marker.snapshot_id=existing_root.id and marker.event_type='LEGACY_NEEDS_REVIEW'
       and marker.financial_snapshot_hash=existing_root.snapshot_hash
       and marker.correlation_id=existing_root.correlation_id
       and marker.details->>'fixation'='deal-won-transition'
       and marker.details->>'resourceType'='DEAL') then return new; end if;

  select o.id,o.revision,r.total_net_cents,r.content_digest,r.created_by revision_actor,r.created_at revision_at,
      h.changed_at acceptance_at,h.changed_by_user_id acceptance_actor
    into offer_record from crm_offers o join crm_offer_revisions r on r.workspace_id=o.workspace_id and r.offer_id=o.id and r.revision=o.revision
    join deal_stage_history h on h.workspace_id=o.workspace_id and h.deal_id=o.deal_id and h.to_stage='Gewonnen'
      and h.metadata->>'offerId'=o.id::text and h.metadata->>'revision'=o.revision::text and h.metadata->>'contentDigest'=r.content_digest
    where o.workspace_id=new.workspace_id and o.deal_id=new.id and o.status='ACCEPTED' order by h.changed_at,h.id limit 1;
  snapshot_id:=crm_financial_deterministic_uuid('deal:'||new.workspace_id||':'||new.id||':'||new.version);
  if found then
    fixed_at:=offer_record.acceptance_at;
    snapshot:=jsonb_build_object(
      'snapshotSchemaVersion','financial-snapshot-v1','snapshotId',snapshot_id::text,'businessVersion',new.version,
      'tenantId',new.workspace_id::text,'resourceId',new.id::text,'reviewState','NEEDS_REVIEW',
      'effectiveAt',to_char(fixed_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'currency','EUR','minorUnitExponent',2,
      'currencyDefinition',null,'jurisdiction',null,'components',null,
      'totals',jsonb_build_object('net',jsonb_build_object('minorUnits',offer_record.total_net_cents::text,'currency','EUR','minorUnitExponent',2),'tax',null,'gross',null),
      'roundingPolicy',null,'pricingReference',jsonb_build_object('id',offer_record.id::text,'version',offer_record.revision::text,'contentHash',offer_record.content_digest),
      'provenance',jsonb_build_object('sourceSystem','novalure-crm','sourceRecordId',offer_record.id::text,'sourceVersion',offer_record.revision::text,
        'sourceHash',offer_record.content_digest,'recordedAt',to_char(offer_record.revision_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'recordedBy',offer_record.revision_actor::text),
      'missingFields',jsonb_build_array('components','currencyDefinition','jurisdiction','roundingPolicy','taxPolicy','totals.gross','totals.tax'));
    expected_hash:=crm_financial_snapshot_hash(snapshot);
    expected_evidence:=jsonb_build_object('source','deal-won-transition-bound-accepted-offer','dealId',new.id::text,'offerId',offer_record.id::text,'mutableDealValueExcluded',true);
    expected_correlation:=crm_financial_deterministic_uuid('correlation:deal:'||new.workspace_id||':'||new.id||':'||new.version);
    insert into crm_financial_snapshots(id,workspace_id,project_id,resource_type,resource_id,business_version,review_state,canonical_snapshot,snapshot_hash,legacy_classification,legacy_evidence,created_by,correlation_id,created_at)
      values(snapshot_id,new.workspace_id,new.project_id,'DEAL',new.id,new.version,'NEEDS_REVIEW',snapshot,crm_financial_snapshot_hash(snapshot),'B',
        expected_evidence,actor,expected_correlation,fixed_at)
      on conflict(workspace_id,resource_type,resource_id,business_version) do nothing;
    select * into snapshot_record from crm_financial_snapshots where workspace_id=new.workspace_id
      and resource_type='DEAL' and resource_id=new.id and business_version=new.version;
    if not found or snapshot_record.id<>snapshot_id or snapshot_record.project_id is distinct from new.project_id
       or snapshot_record.review_state<>'NEEDS_REVIEW' or snapshot_record.canonical_snapshot<>snapshot
       or snapshot_record.snapshot_hash<>expected_hash or snapshot_record.legacy_classification<>'B'
       or snapshot_record.legacy_evidence<>expected_evidence or snapshot_record.created_by is distinct from actor
       or snapshot_record.correlation_id<>expected_correlation or snapshot_record.created_at<>fixed_at then
      raise exception using errcode='23514',message='Existing deal financial fixation does not match immutable evidence';
    end if;

    -- The same terminal transition also fixes the accepted offer revision. It remains
    -- NEEDS_REVIEW because legacy offer content has no tax/jurisdiction/rounding authority.
    snapshot_id:=crm_financial_deterministic_uuid('offer:'||new.workspace_id||':'||offer_record.id||':'||offer_record.revision);
    snapshot:=jsonb_build_object(
      'snapshotSchemaVersion','financial-snapshot-v1','snapshotId',snapshot_id::text,'businessVersion',offer_record.revision,
      'tenantId',new.workspace_id::text,'resourceId',offer_record.id::text,'reviewState','NEEDS_REVIEW',
      'effectiveAt',to_char(fixed_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'currency','EUR','minorUnitExponent',2,
      'currencyDefinition',null,'jurisdiction',null,'components',null,
      'totals',jsonb_build_object('net',jsonb_build_object('minorUnits',offer_record.total_net_cents::text,'currency','EUR','minorUnitExponent',2),'tax',null,'gross',null),
      'roundingPolicy',null,'pricingReference',jsonb_build_object('id',offer_record.id::text,'version',offer_record.revision::text,'contentHash',offer_record.content_digest),
      'provenance',jsonb_build_object('sourceSystem','novalure-crm','sourceRecordId',offer_record.id::text,'sourceVersion',offer_record.revision::text,
        'sourceHash',offer_record.content_digest,'recordedAt',to_char(offer_record.revision_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'recordedBy',offer_record.revision_actor::text),
      'missingFields',jsonb_build_array('components','currencyDefinition','jurisdiction','roundingPolicy','taxPolicy','totals.gross','totals.tax'));
    expected_hash:=crm_financial_snapshot_hash(snapshot);
    expected_evidence:=jsonb_build_object('source','accepted-offer-fixed-by-deal-win','offerRevision',offer_record.revision,'contentDigest',offer_record.content_digest,'historicalAcceptanceBound',true);
    expected_correlation:=crm_financial_deterministic_uuid('correlation:offer:'||new.workspace_id||':'||offer_record.id||':'||offer_record.revision);
    insert into crm_financial_snapshots(id,workspace_id,project_id,resource_type,resource_id,business_version,review_state,canonical_snapshot,snapshot_hash,legacy_classification,legacy_evidence,created_by,correlation_id,created_at)
      values(snapshot_id,new.workspace_id,new.project_id,'OFFER',offer_record.id,offer_record.revision,'NEEDS_REVIEW',snapshot,crm_financial_snapshot_hash(snapshot),'B',
        expected_evidence,actor,expected_correlation,fixed_at)
      on conflict(workspace_id,resource_type,resource_id,business_version) do nothing;
    select * into snapshot_record from crm_financial_snapshots where workspace_id=new.workspace_id
      and resource_type='OFFER' and resource_id=offer_record.id and business_version=offer_record.revision;
    if not found or snapshot_record.id<>snapshot_id or snapshot_record.project_id is distinct from new.project_id
       or snapshot_record.review_state<>'NEEDS_REVIEW' or snapshot_record.canonical_snapshot<>snapshot
       or snapshot_record.snapshot_hash<>expected_hash or snapshot_record.legacy_classification<>'B'
       or snapshot_record.legacy_evidence<>expected_evidence or snapshot_record.created_by is distinct from actor
       or snapshot_record.correlation_id<>expected_correlation or snapshot_record.created_at<>fixed_at then
      raise exception using errcode='23514',message='Existing offer financial fixation does not match immutable evidence';
    end if;
  else
    snapshot:=jsonb_build_object(
      'snapshotSchemaVersion','financial-snapshot-v1','snapshotId',snapshot_id::text,'businessVersion',new.version,
      'tenantId',new.workspace_id::text,'resourceId',new.id::text,'reviewState','NEEDS_REVIEW',
      'effectiveAt',to_char(fixed_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'currency',null,'minorUnitExponent',null,
      'currencyDefinition',null,'jurisdiction',null,'components',null,'totals',jsonb_build_object('net',null,'tax',null,'gross',null),
      'roundingPolicy',null,'pricingReference',null,'provenance',null,
      'missingFields',jsonb_build_array('components','currency','currencyDefinition','jurisdiction','minorUnitExponent','pricingReference','provenance','roundingPolicy','taxPolicy','totals.gross','totals.net','totals.tax'));
    expected_hash:=crm_financial_snapshot_hash(snapshot);
    expected_evidence:=jsonb_build_object('source','deal-won-transition-without-bound-economic-evidence','dealId',new.id::text,'mutableDealValueExcluded',true);
    expected_correlation:=crm_financial_deterministic_uuid('correlation:deal:'||new.workspace_id||':'||new.id||':'||new.version);
    insert into crm_financial_snapshots(id,workspace_id,project_id,resource_type,resource_id,business_version,review_state,canonical_snapshot,snapshot_hash,legacy_classification,legacy_evidence,created_by,correlation_id,created_at)
      values(snapshot_id,new.workspace_id,new.project_id,'DEAL',new.id,new.version,'NEEDS_REVIEW',snapshot,crm_financial_snapshot_hash(snapshot),'C',
        expected_evidence,actor,expected_correlation,fixed_at)
      on conflict(workspace_id,resource_type,resource_id,business_version) do nothing;
    select * into snapshot_record from crm_financial_snapshots where workspace_id=new.workspace_id
      and resource_type='DEAL' and resource_id=new.id and business_version=new.version;
    if not found or snapshot_record.id<>snapshot_id or snapshot_record.project_id is distinct from new.project_id
       or snapshot_record.review_state<>'NEEDS_REVIEW' or snapshot_record.canonical_snapshot<>snapshot
       or snapshot_record.snapshot_hash<>expected_hash or snapshot_record.legacy_classification<>'C'
       or snapshot_record.legacy_evidence<>expected_evidence or snapshot_record.created_by is distinct from actor
       or snapshot_record.correlation_id<>expected_correlation or snapshot_record.created_at<>fixed_at then
      raise exception using errcode='23514',message='Existing deal financial fixation does not match immutable evidence';
    end if;
  end if;
  for snapshot_record in select s.* from crm_financial_snapshots s where s.workspace_id=new.workspace_id
    and ((s.resource_type='DEAL' and s.resource_id=new.id and s.business_version=new.version)
      or (offer_record.id is not null and s.resource_type='OFFER' and s.resource_id=offer_record.id and s.business_version=offer_record.revision)) loop
    insert into crm_financial_events(id,workspace_id,project_id,snapshot_id,event_type,financial_snapshot_hash,actor_id,correlation_id,details,created_at)
      values(crm_financial_deterministic_uuid('legacy-event:'||snapshot_record.workspace_id||':'||snapshot_record.id),snapshot_record.workspace_id,snapshot_record.project_id,snapshot_record.id,
        'LEGACY_NEEDS_REVIEW',snapshot_record.snapshot_hash,actor,snapshot_record.correlation_id,
        jsonb_build_object('legacyClassification',snapshot_record.legacy_classification,'resourceType',snapshot_record.resource_type,'fixation','deal-won-transition'),fixed_at)
      on conflict(id) do nothing;
  end loop;
  return new;
end $$;
create constraint trigger crm_deal_financial_fixation after update on deals deferrable initially deferred for each row
  when(old.stage is distinct from 'Gewonnen' and new.stage='Gewonnen') execute function crm_record_deal_financial_fixation();
create constraint trigger crm_deal_financial_fixation_insert after insert on deals deferrable initially deferred for each row
  when(new.stage='Gewonnen') execute function crm_record_deal_financial_fixation();

-- The sale audit is written after property_sales in the existing repository transaction.
-- A deferred constraint trigger therefore observes the bound audit at commit and still
-- rolls the whole sale back if snapshot/event persistence fails.
create or replace function crm_record_property_sale_financial_fixation()
returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
declare audit_record record; snapshot_id uuid; snapshot jsonb; evidence_hash text; classification text;
  snapshot_record crm_financial_snapshots%rowtype; expected_hash text; expected_evidence jsonb; expected_correlation uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended('financial-fixation:property-sale:'||new.workspace_id||':'||new.id,0));
  select a.id,a.actor_user_id,a.created_at,a.before,a.after,a.before->>'priceCents' price_minor_units into audit_record
    from property_unit_audit_events a where a.workspace_id=new.workspace_id and a.project_id=new.project_id and a.unit_id=new.unit_id
      and a.event_type='authorized_sales_transition' and a.after->>'saleId'=new.id::text
      and a.before->>'priceCents' ~ '^(?:0|[1-9][0-9]{0,77})$' order by a.created_at,a.id limit 1;
  classification:=case when found then 'B' else 'C' end;
  evidence_hash:=case when classification='B' then crm_financial_sha256(jsonb_build_object('auditId',audit_record.id::text,'before',audit_record.before,'after',audit_record.after,
      'createdAt',to_char(audit_record.created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')))
    else crm_financial_sha256(jsonb_build_object('saleId',new.id::text,'sourceReference',new.source_reference,'unitVersion',new.unit_version)) end;
  snapshot_id:=crm_financial_deterministic_uuid('property-sale:'||new.workspace_id||':'||new.id);
  snapshot:=jsonb_build_object(
    'snapshotSchemaVersion','financial-snapshot-v1','snapshotId',snapshot_id::text,'businessVersion',1,
    'tenantId',new.workspace_id::text,'resourceId',new.id::text,'reviewState','NEEDS_REVIEW',
    'effectiveAt',to_char(new.confirmed_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'currency',null,'minorUnitExponent',case when classification='B' then 2 else null end,'currencyDefinition',null,'jurisdiction',null,'components',null,
    'totals',jsonb_build_object('net',null,'tax',null,'gross',null),'roundingPolicy',null,
    'pricingReference',case when classification='B' then jsonb_build_object('id',new.unit_id::text,'version',new.unit_version::text,'contentHash',evidence_hash) else null end,
    'provenance',jsonb_build_object('sourceSystem','novalure-crm','sourceRecordId',case when classification='B' then audit_record.id::text else new.id::text end,
      'sourceVersion',new.unit_version::text,'sourceHash',evidence_hash,'recordedAt',to_char(case when classification='B' then audit_record.created_at else new.confirmed_at end at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'recordedBy',case when classification='B' then audit_record.actor_user_id::text else new.confirmed_by::text end),
    'missingFields',case when classification='B' then jsonb_build_array('components','currency','currencyDefinition','jurisdiction','roundingPolicy','taxPolicy','totals.gross','totals.net','totals.tax')
      else jsonb_build_array('components','currency','currencyDefinition','jurisdiction','minorUnitExponent','pricingReference','roundingPolicy','taxPolicy','totals.gross','totals.net','totals.tax') end);
  expected_hash:=crm_financial_snapshot_hash(snapshot);
  expected_evidence:=jsonb_build_object('source',case when classification='B' then 'property-sale-bound-unit-audit' else 'property-sale-without-bound-price-event' end,
    'saleId',new.id::text,'unitId',new.unit_id::text,'unitVersion',new.unit_version,
    'saleTimePriceMinorUnits',case when classification='B' then audit_record.price_minor_units else null end,'evidenceHash',evidence_hash);
  expected_correlation:=crm_financial_deterministic_uuid('correlation:property-sale:'||new.workspace_id||':'||new.id);
  insert into crm_financial_snapshots(id,workspace_id,project_id,resource_type,resource_id,business_version,review_state,canonical_snapshot,snapshot_hash,legacy_classification,legacy_evidence,created_by,correlation_id,created_at)
    values(snapshot_id,new.workspace_id,new.project_id,'PROPERTY_SALE',new.id,1,'NEEDS_REVIEW',snapshot,crm_financial_snapshot_hash(snapshot),classification,
      expected_evidence,new.confirmed_by,expected_correlation,new.confirmed_at)
    on conflict(workspace_id,resource_type,resource_id,business_version) do nothing;
  select * into snapshot_record from crm_financial_snapshots where workspace_id=new.workspace_id and resource_type='PROPERTY_SALE' and resource_id=new.id and business_version=1;
  if not found or snapshot_record.id<>snapshot_id or snapshot_record.project_id is distinct from new.project_id
     or snapshot_record.review_state<>'NEEDS_REVIEW' or snapshot_record.canonical_snapshot<>snapshot
     or snapshot_record.snapshot_hash<>expected_hash or snapshot_record.legacy_classification<>classification
     or snapshot_record.legacy_evidence<>expected_evidence or snapshot_record.created_by is distinct from new.confirmed_by
     or snapshot_record.correlation_id<>expected_correlation or snapshot_record.created_at<>new.confirmed_at then
    raise exception using errcode='23514',message='Existing property sale financial fixation does not match immutable evidence';
  end if;
  insert into crm_financial_events(id,workspace_id,project_id,snapshot_id,event_type,financial_snapshot_hash,actor_id,correlation_id,details,created_at)
    values(crm_financial_deterministic_uuid('legacy-event:'||snapshot_record.workspace_id||':'||snapshot_record.id),snapshot_record.workspace_id,snapshot_record.project_id,snapshot_record.id,
      'LEGACY_NEEDS_REVIEW',snapshot_record.snapshot_hash,new.confirmed_by,snapshot_record.correlation_id,
      jsonb_build_object('legacyClassification',snapshot_record.legacy_classification,'resourceType','PROPERTY_SALE','fixation','property-sale-commit'),new.confirmed_at)
    on conflict(id) do nothing;
  return new;
end $$;
create constraint trigger crm_property_sale_financial_fixation after insert on property_sales deferrable initially deferred
  for each row execute function crm_record_property_sale_financial_fixation();

create or replace function crm_backfill_g27_financial_snapshots()
returns table(inserted_snapshots integer,inserted_events integer)
language plpgsql security invoker set search_path=pg_catalog,public as $$
declare snapshot_count integer:=0; event_count integer:=0;
begin
  -- B: an accepted immutable offer revision proves EUR, exponent 2 and net minor units.
  with source as (
    select o.workspace_id,o.project_id,o.id resource_id,o.revision business_version,r.total_net_cents,r.content_digest,r.created_by,r.created_at,
      h.changed_at effective_at,coalesce(h.changed_by_user_id,o.response_actor_id,r.created_by) actor_id,
      crm_financial_deterministic_uuid('offer:'||o.workspace_id||':'||o.id||':'||o.revision) snapshot_id
    from crm_offers o join crm_offer_revisions r on r.workspace_id=o.workspace_id and r.project_id=o.project_id and r.offer_id=o.id and r.revision=o.revision
    left join lateral (select changed_at,changed_by_user_id from deal_stage_history h where h.workspace_id=o.workspace_id and h.deal_id=o.deal_id
      and h.to_stage='Gewonnen' and h.metadata->>'offerId'=o.id::text and h.metadata->>'revision'=o.revision::text
      and h.metadata->>'contentDigest'=r.content_digest order by h.changed_at,h.id limit 1) h on true
    where o.status='ACCEPTED'
  ), built as (
    select source.*, jsonb_build_object(
      'snapshotSchemaVersion','financial-snapshot-v1','snapshotId',snapshot_id::text,'businessVersion',business_version,
      'tenantId',workspace_id::text,'resourceId',resource_id::text,'reviewState','NEEDS_REVIEW',
      'effectiveAt',case when effective_at is null then null else to_char(effective_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') end,
      'currency','EUR','minorUnitExponent',2,'currencyDefinition',null,'jurisdiction',null,'components',null,
      'totals',jsonb_build_object('net',jsonb_build_object('minorUnits',total_net_cents::text,'currency','EUR','minorUnitExponent',2),'tax',null,'gross',null),
      'roundingPolicy',null,'pricingReference',jsonb_build_object('id',resource_id::text,'version',business_version::text,'contentHash',content_digest),
      'provenance',jsonb_build_object('sourceSystem','novalure-crm','sourceRecordId',resource_id::text,'sourceVersion',business_version::text,
        'sourceHash',content_digest,'recordedAt',to_char(created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'recordedBy',created_by::text),
      'missingFields',case when effective_at is null then jsonb_build_array('components','currencyDefinition','effectiveAt','jurisdiction','roundingPolicy','taxPolicy','totals.gross','totals.tax')
        else jsonb_build_array('components','currencyDefinition','jurisdiction','roundingPolicy','taxPolicy','totals.gross','totals.tax') end) snapshot
    from source
  ), inserted as (
    insert into crm_financial_snapshots(id,workspace_id,project_id,resource_type,resource_id,business_version,review_state,canonical_snapshot,snapshot_hash,legacy_classification,legacy_evidence,created_by,correlation_id,created_at)
    select snapshot_id,workspace_id,project_id,'OFFER',resource_id,business_version,'NEEDS_REVIEW',snapshot,crm_financial_snapshot_hash(snapshot),'B',
      jsonb_build_object('source','accepted-offer-revision','offerRevision',business_version,'contentDigest',content_digest,'historicalAcceptanceBound',effective_at is not null),
      actor_id,crm_financial_deterministic_uuid('correlation:offer:'||workspace_id||':'||resource_id||':'||business_version),coalesce(effective_at,created_at)
    from built on conflict(workspace_id,resource_type,resource_id,business_version) do nothing returning 1
  ) select count(*) into snapshot_count from inserted;

  -- B/C: sale-time unit price is accepted only from the immutable transition whose after.saleId binds this sale.
  with source as (
    select s.*,a.id audit_id,a.actor_user_id,a.created_at audit_at,a.before->>'priceCents' price_minor_units,
      case when a.id is null then 'C' else 'B' end legacy_classification,
      case when a.id is null then crm_financial_sha256(jsonb_build_object('saleId',s.id::text,'sourceReference',s.source_reference,'unitVersion',s.unit_version))
        else crm_financial_sha256(jsonb_build_object('auditId',a.id::text,'before',a.before,'after',a.after,'createdAt',to_char(a.created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))) end evidence_hash,
      crm_financial_deterministic_uuid('property-sale:'||s.workspace_id||':'||s.id) snapshot_id
    from property_sales s left join lateral (select a.* from property_unit_audit_events a where a.workspace_id=s.workspace_id and a.project_id=s.project_id
      and a.unit_id=s.unit_id and a.event_type='authorized_sales_transition' and a.after->>'saleId'=s.id::text
      and a.before->>'priceCents' ~ '^(?:0|[1-9][0-9]{0,77})$' order by a.created_at,a.id limit 1) a on true
  ), built as (
    select source.*,jsonb_build_object(
      'snapshotSchemaVersion','financial-snapshot-v1','snapshotId',snapshot_id::text,'businessVersion',1,
      'tenantId',workspace_id::text,'resourceId',id::text,'reviewState','NEEDS_REVIEW',
      'effectiveAt',to_char(coalesce(audit_at,confirmed_at) at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'currency',null,'minorUnitExponent',case when audit_id is null then null else 2 end,'currencyDefinition',null,'jurisdiction',null,'components',null,
      'totals',jsonb_build_object('net',null,'tax',null,'gross',null),'roundingPolicy',null,
      'pricingReference',case when audit_id is null then null else jsonb_build_object('id',unit_id::text,'version',unit_version::text,'contentHash',evidence_hash) end,
      'provenance',jsonb_build_object('sourceSystem','novalure-crm','sourceRecordId',coalesce(audit_id,id)::text,'sourceVersion',unit_version::text,
        'sourceHash',evidence_hash,'recordedAt',to_char(coalesce(audit_at,confirmed_at) at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'recordedBy',coalesce(actor_user_id,confirmed_by)::text),
      'missingFields',case when audit_id is null then jsonb_build_array('components','currency','currencyDefinition','jurisdiction','minorUnitExponent','pricingReference','roundingPolicy','taxPolicy','totals.gross','totals.net','totals.tax')
        else jsonb_build_array('components','currency','currencyDefinition','jurisdiction','roundingPolicy','taxPolicy','totals.gross','totals.net','totals.tax') end) snapshot
    from source
  ), inserted as (
    insert into crm_financial_snapshots(id,workspace_id,project_id,resource_type,resource_id,business_version,review_state,canonical_snapshot,snapshot_hash,legacy_classification,legacy_evidence,created_by,correlation_id,created_at)
    select snapshot_id,workspace_id,project_id,'PROPERTY_SALE',id,1,'NEEDS_REVIEW',snapshot,crm_financial_snapshot_hash(snapshot),legacy_classification,
      jsonb_build_object('source',case when audit_id is null then 'property-sale-without-bound-price-event' else 'property-sale-bound-unit-audit' end,
        'saleId',id::text,'unitId',unit_id::text,'unitVersion',unit_version,'saleTimePriceMinorUnits',case when audit_id is null then null else price_minor_units end,'evidenceHash',evidence_hash),
      coalesce(actor_user_id,confirmed_by),crm_financial_deterministic_uuid('correlation:property-sale:'||workspace_id||':'||id),coalesce(audit_at,confirmed_at)
    from built on conflict(workspace_id,resource_type,resource_id,business_version) do nothing returning 1
  ) select snapshot_count+count(*) into snapshot_count from inserted;

  -- B: offer-managed wins inherit the accepted immutable offer revision. C: every other won deal records no mutable deal.value_cents.
  with source as (
    select d.workspace_id,d.project_id,d.id resource_id,d.version business_version,d.created_at source_created_at,o.id offer_id,o.revision,
      r.total_net_cents,r.content_digest,r.created_by revision_actor,r.created_at revision_at,h.changed_at,h.changed_by_user_id,
      case when o.id is not null then 'B' else 'C' end legacy_classification,
      crm_financial_deterministic_uuid('deal:'||d.workspace_id||':'||d.id||':'||d.version) snapshot_id
    from deals d
    left join crm_offers o on o.workspace_id=d.workspace_id and o.deal_id=d.id and o.status='ACCEPTED'
    left join crm_offer_revisions r on r.workspace_id=o.workspace_id and r.offer_id=o.id and r.revision=o.revision
    left join lateral (select changed_at,changed_by_user_id,metadata from deal_stage_history h where h.workspace_id=d.workspace_id and h.deal_id=d.id and h.to_stage='Gewonnen'
      and (o.id is null or h.metadata->>'offerId'=o.id::text and h.metadata->>'revision'=o.revision::text and h.metadata->>'contentDigest'=r.content_digest)
      order by h.changed_at,h.id limit 1) h on true
    where d.stage='Gewonnen'
  ), prepared as (
    select source.*,
      case when legacy_classification='B' then content_digest
        else crm_financial_sha256(jsonb_build_object('dealId',resource_id::text,'stage','Gewonnen','historyAt',case when changed_at is null then null else to_char(changed_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') end)) end evidence_hash
    from source
  ), built as (
    select prepared.*,jsonb_build_object(
      'snapshotSchemaVersion','financial-snapshot-v1','snapshotId',snapshot_id::text,'businessVersion',business_version,
      'tenantId',workspace_id::text,'resourceId',resource_id::text,'reviewState','NEEDS_REVIEW',
      'effectiveAt',case when changed_at is null then null else to_char(changed_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') end,
      'currency',case when legacy_classification='B' then 'EUR' else null end,'minorUnitExponent',case when legacy_classification='B' then 2 else null end,
      'currencyDefinition',null,'jurisdiction',null,'components',null,
      'totals',jsonb_build_object('net',case when legacy_classification='B' then jsonb_build_object('minorUnits',total_net_cents::text,'currency','EUR','minorUnitExponent',2) else null end,'tax',null,'gross',null),
      'roundingPolicy',null,'pricingReference',case when legacy_classification='B' then jsonb_build_object('id',offer_id::text,'version',revision::text,'contentHash',content_digest) else null end,
      'provenance',case when legacy_classification='B' then jsonb_build_object('sourceSystem','novalure-crm','sourceRecordId',offer_id::text,'sourceVersion',revision::text,
        'sourceHash',content_digest,'recordedAt',to_char(revision_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'recordedBy',revision_actor::text) else null end,
      'missingFields',case when legacy_classification='B' and changed_at is not null then jsonb_build_array('components','currencyDefinition','jurisdiction','roundingPolicy','taxPolicy','totals.gross','totals.tax')
        when legacy_classification='B' then jsonb_build_array('components','currencyDefinition','effectiveAt','jurisdiction','roundingPolicy','taxPolicy','totals.gross','totals.tax')
        when changed_at is not null then jsonb_build_array('components','currency','currencyDefinition','jurisdiction','minorUnitExponent','pricingReference','provenance','roundingPolicy','taxPolicy','totals.gross','totals.net','totals.tax')
        else jsonb_build_array('components','currency','currencyDefinition','effectiveAt','jurisdiction','minorUnitExponent','pricingReference','provenance','roundingPolicy','taxPolicy','totals.gross','totals.net','totals.tax') end) snapshot
    from prepared
  ), inserted as (
    insert into crm_financial_snapshots(id,workspace_id,project_id,resource_type,resource_id,business_version,review_state,canonical_snapshot,snapshot_hash,legacy_classification,legacy_evidence,created_by,correlation_id,created_at)
    select snapshot_id,workspace_id,project_id,'DEAL',resource_id,business_version,'NEEDS_REVIEW',snapshot,crm_financial_snapshot_hash(snapshot),legacy_classification,
      jsonb_build_object('source',case when legacy_classification='B' then 'won-deal-bound-accepted-offer' else 'won-deal-without-bound-economic-evidence' end,
        'dealId',resource_id::text,'offerId',offer_id::text,'evidenceHash',evidence_hash,'mutableDealValueExcluded',true),
      coalesce(changed_by_user_id,revision_actor),crm_financial_deterministic_uuid('correlation:deal:'||workspace_id||':'||resource_id||':'||business_version),coalesce(changed_at,revision_at,source_created_at)
    from built on conflict(workspace_id,resource_type,resource_id,business_version) do nothing returning 1
  ) select snapshot_count+count(*) into snapshot_count from inserted;

  -- B: legacy property-cost rows prove only the exact stored integer columns and their
  -- source identity. Currency, exponent, tax treatment, jurisdiction, rounding and the
  -- meaning of net/vat/gross were never bound, so none of those values is promoted into
  -- canonical MoneyV2 components or totals. Property matrices retain their property id so
  -- a later reviewed version can supersede this deterministic evidence snapshot.
  with prepared as (
    select c.*,
      case when c.property_id is not null then 'property:'||c.property_id::text
        when c.unit_id is not null then 'unit:'||c.unit_id::text
        else 'orphan:'||c.id::text end scope_identity,
      case when c.property_id is not null then c.property_id
        when c.unit_id is not null then crm_financial_deterministic_uuid('property-cost-unit:'||c.workspace_id||':'||c.unit_id)
        else crm_financial_deterministic_uuid('property-cost-orphan:'||c.workspace_id||':'||c.id) end resource_id,
      jsonb_build_object(
        'sourceRecordId',c.id::text,'projectId',c.project_id::text,'propertyId',c.property_id::text,'unitId',c.unit_id::text,
        'costKey',c.cost_key,'groupKey',c.group_key,'position',c.position,
        'monthlyNetMinorUnits',c.monthly_net_cents::text,'monthlyTaxMinorUnits',c.monthly_vat_cents::text,
        'monthlyGrossMinorUnits',c.monthly_gross_cents::text,'oneTimeNetMinorUnits',c.one_time_net_cents::text,
        'oneTimeTaxMinorUnits',c.one_time_vat_cents::text,'oneTimeGrossMinorUnits',c.one_time_gross_cents::text,
        'vatPercentEvidence',c.vat_percent::text,'optional',c.optional,
        'commissionRelevant',c.commission_relevant,'exposeVisible',c.expose_visible,
        'createdAt',to_char(c.created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'updatedAt',to_char(c.updated_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) item_evidence
    from property_cost_items c
  ), grouped as (
    select workspace_id,scope_identity,resource_id,
      case when count(project_id)=count(*) and count(distinct project_id)=1
        then min(project_id::text)::uuid else null end project_id,
      max(updated_at) recorded_at,
      jsonb_agg(item_evidence order by position,cost_key collate "C",id) items
    from prepared group by workspace_id,scope_identity,resource_id
  ), evidenced as (
    select grouped.*,jsonb_build_object(
      'source','legacy-property-cost-items','resourceScope',scope_identity,
      'exactStoredIntegerStrings',true,'currencyUnknown',true,'taxPolicyUnknown',true,
      'roundingPolicyUnknown',true,'items',items) evidence,
      crm_financial_deterministic_uuid('property-cost:'||workspace_id||':'||scope_identity||':1') snapshot_id
    from grouped
  ), hashed as (
    select evidenced.*,
      crm_financial_sha256(jsonb_build_object('contractVersion','property-cost-legacy-evidence-v1','evidence',evidence)) evidence_hash
    from evidenced
  ), built as (
    select hashed.*,jsonb_build_object(
      'snapshotSchemaVersion','financial-snapshot-v1','snapshotId',snapshot_id::text,'businessVersion',1,
      'tenantId',workspace_id::text,'resourceId',resource_id::text,'reviewState','NEEDS_REVIEW',
      'effectiveAt',null,'currency',null,'minorUnitExponent',null,'currencyDefinition',null,'jurisdiction',null,'components',null,
      'totals',jsonb_build_object('net',null,'tax',null,'gross',null),'roundingPolicy',null,
      'pricingReference',jsonb_build_object('id','legacy-property-cost:'||resource_id::text,'version','1','contentHash',evidence_hash),
      'provenance',jsonb_build_object('sourceSystem','novalure-crm','sourceRecordId',resource_id::text,'sourceVersion','legacy-backfill-v1',
        'sourceHash',evidence_hash,'recordedAt',to_char(recorded_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'recordedBy','migration-087'),
      'missingFields',jsonb_build_array('components','currency','currencyDefinition','effectiveAt','jurisdiction','minorUnitExponent','roundingPolicy','taxPolicy','totals.gross','totals.net','totals.tax')) snapshot
    from hashed
  ), inserted as (
    insert into crm_financial_snapshots(id,workspace_id,project_id,resource_type,resource_id,business_version,review_state,canonical_snapshot,snapshot_hash,legacy_classification,legacy_evidence,created_by,correlation_id,created_at)
    select snapshot_id,workspace_id,project_id,'PROPERTY_COST_MATRIX',resource_id,1,'NEEDS_REVIEW',snapshot,crm_financial_snapshot_hash(snapshot),'B',evidence,null,
      crm_financial_deterministic_uuid('correlation:property-cost:'||workspace_id||':'||scope_identity||':1'),recorded_at
    from built on conflict(workspace_id,resource_type,resource_id,business_version) do nothing returning 1
  ) select snapshot_count+count(*) into snapshot_count from inserted;

  with inserted as (
    insert into crm_financial_events(id,workspace_id,project_id,snapshot_id,event_type,financial_snapshot_hash,actor_id,correlation_id,details,created_at)
    select crm_financial_deterministic_uuid('legacy-event:'||workspace_id||':'||id),workspace_id,project_id,id,'LEGACY_NEEDS_REVIEW',snapshot_hash,created_by,correlation_id,
      jsonb_build_object('legacyClassification',legacy_classification,'resourceType',resource_type),created_at
    from crm_financial_snapshots where legacy_classification is not null
    on conflict(id) do nothing returning 1
  ) select count(*) into event_count from inserted;
  return query select snapshot_count,event_count;
end $$;

revoke all on function crm_backfill_g27_financial_snapshots() from public;
select * from crm_backfill_g27_financial_snapshots();

revoke all on function crm_financial_json_keys_exact(jsonb,text[]),crm_financial_canonical_json(jsonb),crm_financial_sha256(jsonb),
  crm_financial_snapshot_hash(jsonb),crm_financial_policy_hash(jsonb),crm_financial_deterministic_uuid(text),crm_financial_iso_instant_valid(text),
  crm_financial_money_v2_valid(jsonb,text,integer),crm_financial_versioned_ref_valid(jsonb),
  crm_financial_currency_definition_valid(jsonb,text,integer),crm_financial_provenance_valid(jsonb),crm_financial_policy_payload_valid(jsonb),
  crm_financial_components_valid(jsonb,text,integer,text,jsonb,text),crm_financial_legacy_components_valid(jsonb,text,integer,text),crm_financial_snapshot_v1_valid(jsonb),
  crm_financial_round_rational(numeric,numeric,numeric,text),crm_financial_evelyn_uuid(text,text),
  crm_financial_offer_revision_valid(uuid,uuid,uuid,integer,jsonb,text,bigint),crm_financial_offer_approval_guard(),crm_financial_offer_revision_authority_guard(),
  crm_financial_complete_policy_bindings_valid(uuid,uuid,jsonb),crm_financial_review_lines_valid(crm_financial_snapshots,jsonb),
  crm_financial_complete_source_valid(uuid,uuid,uuid,text,uuid,bigint,jsonb,uuid,uuid,timestamptz),
  crm_financial_pending_fixation_exact(uuid,uuid,uuid,text,uuid,bigint,jsonb,text,jsonb,uuid,timestamptz,uuid,uuid),
  crm_financial_pending_runtime_allowed(uuid,uuid,uuid,text,uuid,bigint,jsonb,text,jsonb,uuid,timestamptz,uuid,uuid),
  crm_financial_snapshot_authority_guard(),crm_financial_snapshot_supersedes_guard(),
  crm_financial_snapshot_contains_policy(jsonb,crm_financial_policy_versions),crm_financial_event_guard(),
  crm_financial_snapshot_access(uuid,uuid,text,uuid,boolean),crm_evelyn_contract_revision_financial_guard(),
  crm_deal_stage_permission_guard(),crm_record_deal_financial_fixation(),crm_record_property_sale_financial_fixation() from public;
grant execute on function crm_financial_json_keys_exact(jsonb,text[]),crm_financial_canonical_json(jsonb),crm_financial_sha256(jsonb),
  crm_financial_snapshot_hash(jsonb),crm_financial_policy_hash(jsonb),crm_financial_deterministic_uuid(text),crm_financial_iso_instant_valid(text),
  crm_financial_money_v2_valid(jsonb,text,integer),crm_financial_versioned_ref_valid(jsonb),
  crm_financial_currency_definition_valid(jsonb,text,integer),crm_financial_provenance_valid(jsonb),crm_financial_policy_payload_valid(jsonb),
  crm_financial_components_valid(jsonb,text,integer,text,jsonb,text),crm_financial_legacy_components_valid(jsonb,text,integer,text),crm_financial_snapshot_v1_valid(jsonb),
  crm_financial_round_rational(numeric,numeric,numeric,text),crm_financial_evelyn_uuid(text,text),
  crm_financial_offer_revision_valid(uuid,uuid,uuid,integer,jsonb,text,bigint),
  crm_financial_complete_policy_bindings_valid(uuid,uuid,jsonb),crm_financial_review_lines_valid(crm_financial_snapshots,jsonb),
  crm_financial_complete_source_valid(uuid,uuid,uuid,text,uuid,bigint,jsonb,uuid,uuid,timestamptz),
  crm_financial_pending_fixation_exact(uuid,uuid,uuid,text,uuid,bigint,jsonb,text,jsonb,uuid,timestamptz,uuid,uuid),
  crm_financial_pending_runtime_allowed(uuid,uuid,uuid,text,uuid,bigint,jsonb,text,jsonb,uuid,timestamptz,uuid,uuid),
  crm_financial_snapshot_contains_policy(jsonb,crm_financial_policy_versions),crm_financial_snapshot_access(uuid,uuid,text,uuid,boolean)
  to novalure_tenant_app;
