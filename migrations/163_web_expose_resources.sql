-- Selected marketing resources remain private files, delivered only by a live exposé capability.
create table web_expose_resources (
 id uuid primary key default gen_random_uuid(),workspace_id uuid not null references workspaces(id),property_id uuid not null,
 kind text not null check(kind in ('image','floorplan','document','video','external_link')),
 asset_id uuid references media_assets(id),url text,title text not null check(length(trim(title)) between 1 and 300),
 position integer not null default 0 check(position between 0 and 1000),visibility text not null default 'private' check(visibility in('private','published')),
 status text not null default 'draft' check(status in('draft','approved')),revision integer not null default 1,content_hash text,
 archived boolean not null default false,approved_by uuid,approved_at timestamptz,created_by uuid not null,created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 foreign key(workspace_id,property_id) references seller_listings(workspace_id,id),foreign key(workspace_id,created_by) references workspace_users(workspace_id,id),foreign key(workspace_id,approved_by) references workspace_users(workspace_id,id),
 check((asset_id is not null and url is null and kind<>'external_link') or(asset_id is null and url like 'https://%' and kind in('video','external_link'))),
 check(visibility<>'published' or(status='approved' and approved_by is not null and approved_at is not null)),
 check(content_hash is null or content_hash~'^[a-f0-9]{64}$')
);
create index web_expose_resources_property on web_expose_resources(workspace_id,property_id,position) where not archived;
alter table web_expose_resources enable row level security;
alter table web_expose_resources force row level security;
create policy web_resource_read on web_expose_resources for select to novalure_tenant_app using(crm_web_expose_access(workspace_id,property_id,false));
create policy web_resource_write on web_expose_resources for all to novalure_tenant_app using(crm_web_expose_access(workspace_id,property_id,true)) with check(crm_web_expose_access(workspace_id,property_id,true) and(created_by=nullif(current_setting('app.actor_id',true),'')::uuid or revision>1) and(status<>'approved' or approved_by=nullif(current_setting('app.actor_id',true),'')::uuid));
-- Narrow definer readers need frozen public resources and authoritative same-tenant reference counts.
create policy web_resource_definer_read on web_expose_resources for select using(
 current_user=pg_get_userbyid((select relowner from pg_class where oid='public.web_expose_resources'::regclass))
 and((status='approved' and visibility='published' and not archived) or workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid));
grant select,insert,update on web_expose_resources to novalure_tenant_app;

create function crm_web_resource_guard() returns trigger language plpgsql set search_path=pg_catalog,public as $$
declare m media_assets; p seller_listings; begin
 select * into p from seller_listings where id=new.property_id and workspace_id=new.workspace_id;
 if not found then raise exception using errcode='23514',message='Marketing property required'; end if;
 if tg_op='INSERT' and(new.revision<>1 or new.created_by is distinct from nullif(current_setting('app.actor_id',true),'')::uuid) then raise exception using errcode='23514',message='New resource actor and revision must match'; end if;
 if tg_op='UPDATE' then
  if new.workspace_id<>old.workspace_id or new.property_id<>old.property_id or new.created_by<>old.created_by or new.created_at<>old.created_at or new.revision<>old.revision+1 then raise exception using errcode='23514',message='Resource identity is immutable and revision must advance'; end if;
 end if;
 if new.asset_id is not null then
  select * into m from media_assets where id=new.asset_id and workspace_id=new.workspace_id::text for key share;
  if not found or m.storage_access<>'private' or m.is_public or m.public_token is not null or lower(m.folder) like 'lead-proof-private-%' or lower(m.folder) like 'knowledge-private-%' then raise exception using errcode='23514',message='Private marketing file required; protected evidence cannot be shared'; end if;
  if lower(m.folder) like 'properties/%' and lower(m.folder)<>'properties/'||new.property_id::text then raise exception using errcode='23514',message='File belongs to another property'; end if;
  if exists(select 1 from property_documents d where d.workspace_id=new.workspace_id and d.media_asset_id=m.id and d.category not in('expose','novalure_expose','floorplan','energy_certificate')) then raise exception using errcode='23514',message='Internal documents and evidence cannot become marketing resources'; end if;
  if exists(select 1 from property_media pm where pm.workspace_id=new.workspace_id and pm.media_asset_id=m.id and lower(pm.category) in('proof','internal','contract','funding')) then raise exception using errcode='23514',message='Internal media and evidence cannot become marketing resources'; end if;
  if exists(select 1 from media_asset_shares s where s.asset_id=m.id and s.workspace_id=m.workspace_id and s.revoked_at is null and s.expires_at>clock_timestamp()) then raise exception using errcode='23514',message='Use a private marketing file without an active global share'; end if;
  if lower(m.folder)<>'properties/'||new.property_id::text and not exists(select 1 from property_media pm where pm.workspace_id=new.workspace_id and pm.property_id=new.property_id and pm.media_asset_id=m.id and pm.project_id is not distinct from p.project_id)
    and not exists(select 1 from property_documents d where d.workspace_id=new.workspace_id and d.property_id=new.property_id and d.media_asset_id=m.id and d.project_id is not distinct from p.project_id and d.category in('expose','novalure_expose','floorplan','energy_certificate')) then raise exception using errcode='23514',message='A property marketing attachment is required'; end if;
  if not((new.kind='image' and m.mime_type in('image/jpeg','image/png','image/webp','image/gif','image/avif')) or(new.kind='floorplan' and m.mime_type in('image/jpeg','image/png','image/webp','application/pdf')) or(new.kind='document' and m.mime_type='application/pdf') or(new.kind='video' and m.mime_type in('video/mp4','video/webm'))) then raise exception using errcode='23514',message='Resource kind and file type disagree'; end if;
 end if;
 return new;
end $$;
create trigger web_resource_guard before insert or update on web_expose_resources for each row execute function crm_web_resource_guard();

-- FORCE RLS also applies to a non-BYPASS function owner. These policies expose
-- only metadata needed to authoritatively reject protected public attachments.
-- They do not grant the tenant runtime another project's media library.
create policy web_resource_public_media_owner on property_media for select using(
 current_user=pg_get_userbyid((select relowner from pg_class where oid='public.property_media'::regclass))
 and((status in('approved','published') and visibility in('public','channel')) or exists(select 1 from web_expose_resources r where r.asset_id=property_media.media_asset_id and r.workspace_id=property_media.workspace_id and r.status='approved' and r.visibility='published' and not r.archived)));
create policy web_resource_public_document_owner on property_documents for select using(
 current_user=pg_get_userbyid((select relowner from pg_class where oid='public.property_documents'::regclass))
 and(exists(select 1 from web_expose_resources r where r.asset_id=property_documents.media_asset_id and r.workspace_id=property_documents.workspace_id and r.status='approved' and r.visibility='published' and not r.archived)
 or exists(select 1 from property_media pm where pm.media_asset_id=property_documents.media_asset_id and pm.workspace_id=property_documents.workspace_id and pm.status in('approved','published') and pm.visibility in('public','channel'))));
create policy web_resource_public_asset_owner on media_assets for select using(
 current_user=pg_get_userbyid((select relowner from pg_class where oid='public.media_assets'::regclass))
 and(exists(select 1 from web_expose_resources r where r.asset_id=media_assets.id and r.workspace_id::text=media_assets.workspace_id and r.status='approved' and r.visibility='published' and not r.archived)
 or exists(select 1 from property_media pm where pm.media_asset_id=media_assets.id and pm.workspace_id::text=media_assets.workspace_id and pm.status in('approved','published') and pm.visibility in('public','channel'))));

create function crm_web_expose_live_resources(p_hash text) returns jsonb language sql stable security definer set search_path=pg_catalog,public as $$
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
$$;
revoke all on function crm_web_expose_live_resources(text) from public;
grant execute on function crm_web_expose_live_resources(text) to novalure_app,novalure_tenant_app;

create or replace function crm_web_expose_asset(p_hash text,p_asset uuid) returns jsonb language sql stable security definer set search_path=pg_catalog,public as $$
 select jsonb_build_object('id',m.id,'workspaceId',v.workspace_id,'name',m.name,'originalName',m.original_name,'folder',m.folder,'mimeType',m.mime_type,'sizeBytes',m.size_bytes,'relativePath',m.relative_path,'storageProvider',m.storage_provider,'storageAccess',m.storage_access,'createdAt',m.created_at,'url','','isPublic',false,'hasActivePublicShare',false)
 from web_expose_links l join web_expose_versions v on v.id=l.version_id and v.workspace_id=l.workspace_id join media_assets m on m.id=p_asset and m.workspace_id=v.workspace_id::text
 where l.token_hash=p_hash and crm_web_expose_lookup(p_hash) is not null and m.storage_access='private' and not m.is_public and m.public_token is null
 and lower(m.folder) not like 'lead-proof-private-%' and lower(m.folder) not like 'knowledge-private-%'
 and m.mime_type in('image/jpeg','image/png','image/webp','image/gif','image/avif','application/pdf','video/mp4','video/webm')
 and not exists(select 1 from property_documents blocked where blocked.media_asset_id=m.id and blocked.workspace_id=v.workspace_id and blocked.category not in('expose','novalure_expose','floorplan','energy_certificate'))
 and not exists(select 1 from property_media blocked where blocked.media_asset_id=m.id and blocked.workspace_id=v.workspace_id and lower(blocked.category) in('proof','internal','contract','funding'))
 and((exists(select 1 from jsonb_array_elements(coalesce(v.snapshot->'media','[]'::jsonb)) item where item->>'assetId'=p_asset::text)
   and exists(select 1 from property_media pm where pm.media_asset_id=m.id and pm.workspace_id=v.workspace_id and pm.property_id=v.property_id and pm.project_id is not distinct from v.project_id and pm.status in('approved','published') and pm.visibility in('public','channel')))
  or exists(select 1 from jsonb_array_elements(crm_web_expose_live_resources(p_hash)) item where item->>'assetId'=p_asset::text))
$$;

create function crm_web_expose_media_reference_counts(p_asset uuid)
returns table(media_count integer,document_count integer,send_count integer,share_count integer,studio_count integer,knowledge_count integer,proof_count integer,resource_count integer)
language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare proofs integer:=0; begin
 if exists(select 1 from media_assets m where m.id=p_asset and m.workspace_id=nullif(current_setting('app.tenant_id',true),'') and lower(m.folder) like 'lead-proof-private-%') then proofs:=1;
 elsif to_regclass('public.lead_qualification_proofs') is not null then execute 'select count(*)::integer from public.lead_qualification_proofs where media_asset_id=$1' into proofs using p_asset; end if;
 return query select prior.*,proofs,(select count(*)::integer from web_expose_resources r where r.asset_id=p_asset and r.workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid) from crm_knowledge_media_reference_counts(p_asset) prior;
end $$;
revoke all on function crm_web_expose_media_reference_counts(uuid) from public;
grant execute on function crm_web_expose_media_reference_counts(uuid) to novalure_tenant_app;
