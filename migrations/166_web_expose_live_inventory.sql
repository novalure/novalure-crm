-- Public capabilities expose only units already reviewed in this language version.
-- Live availability and explicitly released prices can change without rebuilding a website.
create function public.crm_web_expose_inventory(p_hash text) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare page jsonb; snapshot jsonb; property_record record; rows jsonb; price bigint; publish_prices boolean; effective_visibility text; frozen_visibility text; current_visibility text;
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
 current_visibility:=coalesce(nullif(property_record.channel_price_visibility->>'Website',''),property_record.price_visibility);
 effective_visibility:=case when frozen_visibility='hide_price' or current_visibility='hide_price' then 'hide_price'
  when frozen_visibility='price_on_request' or current_visibility='price_on_request' then 'price_on_request'
  when frozen_visibility='publish_price' and current_visibility='publish_price' then 'publish_price' else 'hide_price' end;
 publish_prices:=effective_visibility='publish_price';
 price:=case when property_record.marketing_type='rent' then property_record.rent_price_cents else coalesce(property_record.public_price_cents,property_record.target_price_cents) end;
 if price<=0 or not publish_prices or (property_record.developer and not exists(select 1 from property_units u where u.workspace_id=property_record.workspace_id and u.project_id=property_record.project_id and u.id=property_record.unit_id and u.price_cents=price and u.metadata->'priceConfirmation'->>'sourceReference' is not null and u.metadata->'priceConfirmation'->>'priceCents'=u.price_cents::text)) then price:=null; end if;
 select coalesce(jsonb_agg(jsonb_build_object('id',u.id,'status',case when u.status='held' then 'reserved' else u.status end,'priceCents',case when publish_prices and u.price_cents>0 and (snapshot->>'priceVisibility'='publish_price' or frozen.item->>'price' is not null) and (not property_record.developer or (u.metadata->'priceConfirmation'->>'sourceReference' is not null and u.metadata->'priceConfirmation'->>'priceCents'=u.price_cents::text)) then u.price_cents::text else null end) order by frozen.position),'[]')
 into rows from jsonb_array_elements(coalesce(snapshot->'units','[]')) with ordinality frozen(item,position)
 join property_units u on u.id::text=frozen.item->>'id' and u.workspace_id=property_record.workspace_id and u.project_id=property_record.project_id
 where (u.metadata->>'sellerListingId'=property_record.id::text or u.id=property_record.unit_id) and coalesce(u.metadata->>'hidden','false')<>'true';
 return jsonb_build_object('units',rows,'priceCents',price::text,'priceVisibility',effective_visibility,'asOf',clock_timestamp());
end $$;
revoke all on function crm_web_expose_inventory(text) from public;
grant execute on function crm_web_expose_inventory(text) to novalure_app;
