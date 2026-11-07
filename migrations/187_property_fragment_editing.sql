-- Replacement editing is limited by existing forced RLS, current active actor,
-- project write grants and classification policies on these mutable fragments.
-- Unit fragments remain outside the property-only replacement path.
grant delete on property_text_blocks,property_cost_items to novalure_tenant_app;

-- Separate language versions of the same text/channel can coexist.
drop index property_text_blocks_property_only_uidx;
create unique index property_text_blocks_property_only_uidx
 on property_text_blocks(workspace_id,property_id,text_key,channel,(coalesce(metadata->>'language','')))
 where property_id is not null and unit_id is null;
drop index property_text_blocks_unit_only_uidx;
create unique index property_text_blocks_unit_only_uidx
 on property_text_blocks(workspace_id,unit_id,text_key,channel,(coalesce(metadata->>'language','')))
 where unit_id is not null and property_id is null;
