-- Ordinary private media must inherit every property/project binding. The
-- definer sees attachment rows hidden by the caller's project RLS (184); a
-- hidden reference must never turn a project file into a workspace-wide file.
create index property_media_asset_project_access on property_media(media_asset_id) where media_asset_id is not null;
create index property_document_asset_project_access on property_documents(media_asset_id) where media_asset_id is not null;
-- As with 184's attachment metadata policy, only the schema owner can resolve
-- parent metadata inside the guarded definer. Tenant read policies are unchanged.
create policy property_media_parent_owner_read on seller_listings for select using(current_user=pg_get_userbyid((select relowner from pg_class where oid='public.seller_listings'::regclass)));
create policy property_media_parent_owner_read on property_units for select using(current_user=pg_get_userbyid((select relowner from pg_class where oid='public.property_units'::regclass)));
create function crm_property_media_access(w text, f text, a uuid, writing boolean default false)
returns boolean language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare workspace uuid; folder_property uuid; binding record; parent_project uuid;
begin
 if w is distinct from nullif(current_setting('app.tenant_id',true),'') or w !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then return false; end if;
 workspace:=w::uuid;
 if not exists(select 1 from workspace_users u where u.workspace_id=workspace and u.id=nullif(current_setting('app.actor_id',true),'')::uuid and u.status='active' and u.product_role<>'external_partner' and (not writing or u.role in('owner','admin','agent'))) then return false; end if;
 -- Dedicated Knowledge/Proof services keep their existing authorization and
 -- lifecycle guards. Generic media endpoints continue to exclude both prefixes.
 if lower(f) like 'knowledge-private-%' or lower(f) like 'lead-proof-private-%' then return true; end if;
 if lower(f) like 'properties/%' then
  if f !~* '^properties/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then return false; end if;
  folder_property:=substring(f from 12)::uuid;
  if not exists(select 1 from seller_listings p where p.id=folder_property and p.workspace_id=workspace and p.project_id is not null and crm_project_access(workspace,p.project_id,writing) and crm_classification_allowed(workspace,p.data_classification,p.data_purpose)) then return false; end if;
 end if;
 for binding in
  select workspace_id,project_id,property_id,unit_id,data_classification,data_purpose from property_media where media_asset_id=a
  union all
  select workspace_id,project_id,property_id,unit_id,data_classification,data_purpose from property_documents where media_asset_id=a
 loop
  if binding.workspace_id<>workspace or binding.project_id is null or not crm_project_access(workspace,binding.project_id,writing) or not crm_classification_allowed(workspace,binding.data_classification,binding.data_purpose) then return false; end if;
  if binding.property_id is not null then
   select p.project_id into parent_project from seller_listings p where p.workspace_id=workspace and p.id=binding.property_id and crm_classification_allowed(workspace,p.data_classification,p.data_purpose);
   if parent_project is null or parent_project<>binding.project_id or (folder_property is not null and folder_property<>binding.property_id) then return false; end if;
  end if;
  if binding.unit_id is not null then
   select u.project_id into parent_project from property_units u where u.workspace_id=workspace and u.id=binding.unit_id and crm_classification_allowed(workspace,u.data_classification,u.data_purpose);
   if parent_project is null or parent_project<>binding.project_id then return false; end if;
   -- Units use the existing metadata/default-unit links, not a property_id
   -- column. A project-only unit attachment is valid; an explicit object must
   -- agree with one of the canonical links used by the inventory readers.
   if (binding.property_id is not null or folder_property is not null) and not exists(
    select 1 from property_units u join seller_listings p on p.workspace_id=u.workspace_id and p.project_id=u.project_id and(p.id::text=u.metadata->>'sellerListingId' or p.unit_id=u.id)
    where u.id=binding.unit_id and u.workspace_id=workspace and p.id=coalesce(binding.property_id,folder_property) and crm_classification_allowed(workspace,p.data_classification,p.data_purpose)
   ) then return false; end if;
  end if;
 end loop;
 return true;
end $$;
revoke all on function crm_property_media_access(text,text,uuid,boolean) from public;
grant execute on function crm_property_media_access(text,text,uuid,boolean) to novalure_tenant_app;

create policy property_media_project_read on media_assets as restrictive for select to novalure_tenant_app using(crm_property_media_access(workspace_id,folder,id,false));
create policy property_media_project_insert on media_assets as restrictive for insert to novalure_tenant_app with check(crm_property_media_access(workspace_id,folder,id,true));
create policy property_media_project_update on media_assets as restrictive for update to novalure_tenant_app using(crm_property_media_access(workspace_id,folder,id,true)) with check(crm_property_media_access(workspace_id,folder,id,true));
create policy property_media_project_delete on media_assets as restrictive for delete to novalure_tenant_app using(crm_property_media_access(workspace_id,folder,id,true));

-- Sharing is also a project write. Protect direct SQL, not only API callers.
alter table media_asset_shares enable row level security;
alter table media_asset_shares force row level security;
create policy media_share_project_read on media_asset_shares for select to novalure_tenant_app using(exists(select 1 from media_assets m where m.id=asset_id and m.workspace_id=media_asset_shares.workspace_id and crm_property_media_access(m.workspace_id,m.folder,m.id,false)));
create policy media_share_project_insert on media_asset_shares for insert to novalure_tenant_app with check(exists(select 1 from media_assets m where m.id=asset_id and m.workspace_id=media_asset_shares.workspace_id and crm_property_media_access(m.workspace_id,m.folder,m.id,true)));
create policy media_share_project_update on media_asset_shares for update to novalure_tenant_app using(exists(select 1 from media_assets m where m.id=asset_id and m.workspace_id=media_asset_shares.workspace_id and crm_property_media_access(m.workspace_id,m.folder,m.id,true))) with check(exists(select 1 from media_assets m where m.id=asset_id and m.workspace_id=media_asset_shares.workspace_id and crm_property_media_access(m.workspace_id,m.folder,m.id,true)));

-- Shared storage limits count hidden files too. Disclose only the workspace's
-- aggregate bytes, never another project's file metadata or file/project count.
create function crm_workspace_media_usage(w text) returns bigint language sql stable security definer set search_path=pg_catalog,public as $$
 select case when u.product_role='external_partner' then 0::bigint
 else(select coalesce(sum(m.size_bytes),0)::bigint from media_assets m where m.workspace_id=w) end
 from workspace_users u where w=nullif(current_setting('app.tenant_id',true),'') and u.workspace_id::text=w and u.id=nullif(current_setting('app.actor_id',true),'')::uuid and u.status='active'
$$;
revoke all on function crm_workspace_media_usage(text) from public;
grant execute on function crm_workspace_media_usage(text) to novalure_tenant_app;

-- Public token lookup: the only anonymous capability is an active, unexpired
-- hash match. Owner SELECT policies from 184 preserve public delivery under RLS.
create function crm_public_media_lookup(h text) returns jsonb language sql stable security definer set search_path=pg_catalog,public as $$
 select jsonb_build_object('id',m.id,'workspaceId',m.workspace_id,'name',m.name,'originalName',m.original_name,'folder',m.folder,'mimeType',m.mime_type,'sizeBytes',m.size_bytes,'url',m.url,'relativePath',m.relative_path,'storageProvider',m.storage_provider,'storageAccess',m.storage_access,'alt',m.alt,'createdAt',m.created_at,'isPublic',m.is_public,'hasActivePublicShare',true)
 from media_asset_shares s join media_assets m on m.id=s.asset_id and m.workspace_id=s.workspace_id
 where h ~ '^[0-9a-f]{64}$' and s.token_hash=h and s.scope='public-download' and s.revoked_at is null and s.expires_at>now() and m.is_public
 and lower(m.folder) not like 'knowledge-private-%' and lower(m.folder) not like 'lead-proof-private-%' limit 1
$$;
revoke all on function crm_public_media_lookup(text) from public;
grant execute on function crm_public_media_lookup(text) to novalure_app,novalure_tenant_app;
