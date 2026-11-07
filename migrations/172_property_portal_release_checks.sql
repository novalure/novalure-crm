-- A prepared offline package is downloadable only while its current disclosures
-- and every saved marketing attachment remain approved. This is not a transport.
do $$ declare relation text; begin
 foreach relation in array array['seller_listings','property_media','property_documents','media_assets','workspace_users','project_pipeline_permissions'] loop
 execute format('create policy portal_release_owner_read on %I for select using(current_user=pg_get_userbyid((select relowner from pg_class where oid=%L::regclass)) and workspace_id::text=nullif(current_setting(''app.tenant_id'',true),''''))',relation,'public.'||relation);
 end loop;
end $$;
create policy portal_release_workspace_owner on workspaces for select using(current_user=pg_get_userbyid((select relowner from pg_class where oid='public.workspaces'::regclass)) and id::text=nullif(current_setting('app.tenant_id',true),''));
create function crm_property_portal_media_allowed(w uuid,p uuid,a uuid) returns boolean
language sql stable security definer set search_path=pg_catalog,public as $$
 select w=nullif(current_setting('app.tenant_id',true),'')::uuid and exists(
 select 1 from seller_listings property join property_media pm on pm.workspace_id=property.workspace_id and pm.property_id=property.id and pm.project_id is not distinct from property.project_id
 join media_assets m on m.id=pm.media_asset_id and m.workspace_id=pm.workspace_id::text
 where property.workspace_id=w and property.id=p and m.id=a and pm.unit_id is null and pm.status in('approved','published') and pm.visibility in('public','channel')
 and crm_project_access(w,property.project_id,false) and crm_classification_allowed(w,property.data_classification,property.data_purpose)
 and exists(select 1 from workspace_users actor where actor.workspace_id=w and actor.id=nullif(current_setting('app.actor_id',true),'')::uuid and actor.status='active' and actor.product_role<>'external_partner')
 and coalesce(property.canonical_payload->'onboardingExample'->>'synthetic','false')<>'true'
 and m.storage_access='private' and not m.is_public and m.public_token is null and m.mime_type in('image/jpeg','image/png','image/webp')
 and lower(m.folder) not like 'knowledge-private-%' and lower(m.folder) not like 'lead-proof-private-%'
 and(lower(m.folder) not like 'properties/%' or lower(m.folder)='properties/'||p::text)
 and not exists(select 1 from property_media blocked where blocked.workspace_id=w and blocked.media_asset_id=a and lower(blocked.category) in('proof','internal','contract','funding'))
 and not exists(select 1 from property_documents blocked where blocked.workspace_id=w and blocked.media_asset_id=a and blocked.category not in('expose','novalure_expose','floorplan','energy_certificate')))
$$;
revoke all on function crm_property_portal_media_allowed(uuid,uuid,uuid) from public;
grant execute on function crm_property_portal_media_allowed(uuid,uuid,uuid) to novalure_tenant_app;
