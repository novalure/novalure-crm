-- Match native Eigene Website and historical Website policies conservatively.
-- Only website alias resolution changes; migration190 and all capability,
-- frozen/current, knownness, unit and developer confirmation guards stay intact.
create or replace function public.crm_web_expose_inventory(p_hash text) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare page jsonb; snapshot jsonb; property_record record; rows jsonb; price bigint; price_known boolean; publish_prices boolean; effective_visibility text; frozen_visibility text; current_visibility text;
begin
 page:=crm_web_expose_lookup(p_hash);
 if page is null then return null; end if;
 snapshot:=page->'snapshot';
 select p.*, coalesce(pr.developer_organization_id is not null or pr.customer_type='property_developer' or lower(pr.type) like '%bautr%' or w.customer_type='property_developer',false) as developer
 into property_record from web_expose_versions v join seller_listings p on p.id=v.property_id and p.workspace_id=v.workspace_id
 join workspaces w on w.id=p.workspace_id left join projects pr on pr.id=p.project_id and pr.workspace_id=p.workspace_id
 where v.id=(page->>'versionId')::uuid;
 if not found then return null; end if;
 frozen_visibility:=coalesce(snapshot->>'priceVisibility',case when snapshot->>'price' is not null then 'publish_price' else 'price_on_request' end);
 current_visibility:=case
  when jsonb_typeof(property_record.channel_price_visibility)='object' and (property_record.channel_price_visibility ? 'Eigene Website' or property_record.channel_price_visibility ? 'Website') then
   case when exists(select 1 from jsonb_each(property_record.channel_price_visibility) as channel(key,value)
     where channel.key in('Eigene Website','Website') and (jsonb_typeof(channel.value)<>'string' or channel.value#>>'{}' not in('publish_price','price_on_request','hide_price'))) then 'hide_price'
    when property_record.channel_price_visibility->>'Eigene Website'='hide_price' or property_record.channel_price_visibility->>'Website'='hide_price' then 'hide_price'
    when property_record.channel_price_visibility->>'Eigene Website'='price_on_request' or property_record.channel_price_visibility->>'Website'='price_on_request' then 'price_on_request'
    else 'publish_price' end
  else case when property_record.price_visibility in('publish_price','price_on_request','hide_price') then property_record.price_visibility else 'hide_price' end
 end;
 effective_visibility:=case when frozen_visibility='hide_price' or current_visibility='hide_price' then 'hide_price'
  when frozen_visibility='price_on_request' or current_visibility='price_on_request' then 'price_on_request'
  when frozen_visibility='publish_price' and current_visibility='publish_price' then 'publish_price' else 'hide_price' end;
 publish_prices:=effective_visibility='publish_price';
 price:=case when property_record.marketing_type='rent' then property_record.rent_price_cents else coalesce(property_record.public_price_cents,property_record.target_price_cents) end;
 price_known:=case when property_record.marketing_type='rent' then case
   when property_record.canonical_payload->'coreNumericState'->'version'='1'::jsonb and property_record.canonical_payload->'coreNumericState' ? 'rentPrice' then property_record.canonical_payload->'coreNumericState'->>'rentPrice'='known'
   else property_record.rent_price_cents>0 end
  when property_record.public_price_cents is not null then case
   when property_record.canonical_payload->'coreNumericState'->'version'='1'::jsonb and property_record.canonical_payload->'coreNumericState' ? 'publicPrice' then property_record.canonical_payload->'coreNumericState'->>'publicPrice'='known'
   else property_record.public_price_cents>0 end
  when property_record.canonical_payload->'coreNumericState'->'version'='1'::jsonb then property_record.canonical_payload->'coreNumericState'->>'price'='known'
  else property_record.target_price_cents>0 end;
 if price<0 or not coalesce(price_known,false) or not publish_prices or (property_record.developer and not exists(select 1 from property_units u where u.workspace_id=property_record.workspace_id and u.project_id=property_record.project_id and u.id=property_record.unit_id and u.price_cents=price and u.metadata->'priceConfirmation'->>'sourceReference' is not null and u.metadata->'priceConfirmation'->>'priceCents'=u.price_cents::text)) then price:=null; end if;
 select coalesce(jsonb_agg(jsonb_build_object('id',u.id,'status',case when u.status='held' then 'reserved' else u.status end,'priceCents',case when publish_prices and (u.price_cents>0 or (u.price_cents=0 and u.metadata->'priceConfirmation'->>'sourceReference' is not null and u.metadata->'priceConfirmation'->>'priceCents'=u.price_cents::text)) and (snapshot->>'priceVisibility'='publish_price' or frozen.item->>'price' is not null) and (not property_record.developer or (u.metadata->'priceConfirmation'->>'sourceReference' is not null and u.metadata->'priceConfirmation'->>'priceCents'=u.price_cents::text)) then u.price_cents::text else null end) order by frozen.position),'[]')
 into rows from jsonb_array_elements(coalesce(snapshot->'units','[]')) with ordinality frozen(item,position)
 join property_units u on u.id::text=frozen.item->>'id' and u.workspace_id=property_record.workspace_id and u.project_id=property_record.project_id
 where (u.metadata->>'sellerListingId'=property_record.id::text or u.id=property_record.unit_id) and coalesce(u.metadata->>'hidden','false')<>'true';
 return jsonb_build_object('units',rows,'priceCents',price::text,'priceVisibility',effective_visibility,'asOf',clock_timestamp());
end $$;
revoke all on function crm_web_expose_inventory(text) from public;
grant execute on function crm_web_expose_inventory(text) to novalure_app,novalure_tenant_app;

-- Keep the existing capability and attachment checks. A stored system Exposé
-- may contain prices from an earlier revision, even when offered as a floor plan.
create or replace function public.crm_web_expose_live_resources(p_hash text) returns jsonb
language sql stable security definer set search_path=pg_catalog,public as $$
 with current_inventory as materialized (
  select public.crm_web_expose_inventory(p_hash) as data
 )
 select coalesce(jsonb_agg(item.value order by item.ordinality),'[]'::jsonb)
 from web_expose_links link join web_expose_versions v on v.id=link.version_id and v.workspace_id=link.workspace_id
 cross join lateral jsonb_array_elements(case when jsonb_typeof(v.snapshot->'resources')='array' then v.snapshot->'resources' else '[]'::jsonb end) with ordinality item(value,ordinality)
 join web_expose_resources r on r.id::text=item.value->>'id' and r.workspace_id=v.workspace_id and r.property_id=v.property_id
 left join media_assets m on m.id=r.asset_id and m.workspace_id=r.workspace_id::text
 where link.token_hash=p_hash and crm_web_expose_lookup(p_hash) is not null and r.status='approved' and r.visibility='published' and not r.archived
 and r.kind=item.value->>'kind' and r.asset_id::text is not distinct from item.value->>'assetId' and r.url is not distinct from item.value->>'url'
 and not exists(select 1 from property_documents blocked where blocked.media_asset_id=r.asset_id and blocked.workspace_id=r.workspace_id and blocked.category not in('expose','novalure_expose','floorplan','energy_certificate'))
 and not exists(select 1 from property_media blocked where blocked.media_asset_id=r.asset_id and blocked.workspace_id=r.workspace_id and lower(blocked.category) in('proof','internal','contract','funding'))
 and(r.asset_id is null or(m.storage_access='private' and not m.is_public and m.public_token is null and m.mime_type=item.value->>'mimeType' and lower(m.folder) not like 'lead-proof-private-%' and lower(m.folder) not like 'knowledge-private-%'))
 and (
  m.mime_type is distinct from 'application/pdf'
  or not exists(
   select 1 from property_documents system_document
   where system_document.workspace_id=v.workspace_id and system_document.media_asset_id=m.id
   and system_document.category='novalure_expose'
  )
  or coalesce((select data->>'priceVisibility'='publish_price' and data->>'priceCents' is not null from current_inventory),false)
  -- The generated option is authoritative only when the document, registry,
  -- and independently verified resource hash identify the same version.
  -- A selected floor plan may embed pages from a different priced PDF.
  or exists(
   select 1 from seller_listings p
   join property_documents d on d.workspace_id=p.workspace_id and d.property_id=p.id
    and d.project_id is not distinct from p.project_id and d.media_asset_id=m.id
   cross join lateral jsonb_array_elements(case
    when jsonb_typeof(p.canonical_payload->'expose'->'versions')='array' then p.canonical_payload->'expose'->'versions'
    else '[]'::jsonb end) as registered(version)
   where p.workspace_id=v.workspace_id and p.id=v.property_id and p.project_id is not distinct from v.project_id
   and d.category='novalure_expose' and d.unit_id is null and lower(m.folder)='properties/'||p.id::text
   and p.canonical_payload->'expose'->'schemaVersion'='1'::jsonb
   and d.metadata->'expose'=registered.version
   and registered.version->'id'=to_jsonb(d.id) and registered.version->'assetId'=to_jsonb(m.id)
   and registered.version->>'source'='generated' and registered.version->'options'->'showPrice'='false'::jsonb
   and registered.version->'options'->'floorPlanIds'='[]'::jsonb
   and registered.version->'sha256'=to_jsonb(r.content_hash)
   and registered.version->'sizeBytes'=to_jsonb(m.size_bytes)
  )
 )
$$;

-- The legacy frozen-media branch can also identify a system PDF. Apply the
-- same price gate there. The hash-bound exception uses the guarded resource list.
create or replace function public.crm_web_expose_property_asset(p_hash text,p_asset uuid) returns jsonb
language sql stable security definer set search_path=pg_catalog,public as $$
 with current_inventory as materialized (
  select public.crm_web_expose_inventory(p_hash) as data
 )
 select jsonb_build_object('id',m.id,'workspaceId',v.workspace_id,'name',m.name,'originalName',m.original_name,'folder',m.folder,'mimeType',m.mime_type,'sizeBytes',m.size_bytes,'relativePath',m.relative_path,'storageProvider',m.storage_provider,'storageAccess',m.storage_access,'createdAt',m.created_at,'url','','isPublic',false,'hasActivePublicShare',false)
 from web_expose_links l join web_expose_versions v on v.id=l.version_id and v.workspace_id=l.workspace_id join media_assets m on m.id=p_asset and m.workspace_id=v.workspace_id::text
 where l.token_hash=p_hash and crm_web_expose_lookup(p_hash) is not null and m.storage_access='private' and not m.is_public and m.public_token is null
 and lower(m.folder) not like 'lead-proof-private-%' and lower(m.folder) not like 'knowledge-private-%'
 and m.mime_type in('image/jpeg','image/png','image/webp','image/gif','image/avif','application/pdf','video/mp4','video/webm')
 and not exists(select 1 from property_documents blocked where blocked.media_asset_id=m.id and blocked.workspace_id=v.workspace_id and blocked.category not in('expose','novalure_expose','floorplan','energy_certificate'))
 and not exists(select 1 from property_media blocked where blocked.media_asset_id=m.id and blocked.workspace_id=v.workspace_id and lower(blocked.category) in('proof','internal','contract','funding'))
 and (
  (
   exists(select 1 from jsonb_array_elements(coalesce(v.snapshot->'media','[]'::jsonb)) item where item->>'assetId'=p_asset::text)
   and exists(select 1 from property_media pm where pm.media_asset_id=m.id and pm.workspace_id=v.workspace_id and pm.property_id=v.property_id and pm.project_id is not distinct from v.project_id and pm.status in('approved','published') and pm.visibility in('public','channel'))
   and (
    m.mime_type<>'application/pdf'
    or not exists(
     select 1 from property_documents system_document
     where system_document.workspace_id=v.workspace_id and system_document.media_asset_id=m.id
     and system_document.category='novalure_expose'
    )
    or coalesce((select data->>'priceVisibility'='publish_price' and data->>'priceCents' is not null from current_inventory),false)
   )
  )
  or exists(select 1 from jsonb_array_elements(crm_web_expose_live_resources(p_hash)) item where item->>'assetId'=p_asset::text)
 )
$$;
