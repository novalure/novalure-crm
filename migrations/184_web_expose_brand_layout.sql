-- Dedicated newly uploaded company artwork; never reuse evidence/property files as branding.
create table web_expose_brand_assets(
 asset_id uuid primary key references media_assets(id),workspace_id uuid not null references workspaces(id),purpose text not null check(purpose in('logo','letterhead')),title text not null check(length(trim(title)) between 1 and 150),content_hash text not null check(content_hash ~ '^[a-f0-9]{64}$'),approved boolean not null default false,revision integer not null default 1 check(revision>0),created_by uuid not null,created_at timestamptz not null default now(),updated_by uuid not null,updated_at timestamptz not null default now(),data_classification text not null default 'UNCLASSIFIED',data_purpose text not null default 'crm_sales',unique(workspace_id,asset_id),foreign key(workspace_id,created_by) references workspace_users(workspace_id,id),foreign key(workspace_id,updated_by) references workspace_users(workspace_id,id)
);
alter table web_expose_brand_assets enable row level security;alter table web_expose_brand_assets force row level security;
create policy brand_asset_read on web_expose_brand_assets for select to novalure_tenant_app using(crm_expose_template_access(workspace_id,false) and crm_classification_allowed(workspace_id,data_classification,data_purpose));
create policy brand_asset_insert on web_expose_brand_assets for insert to novalure_tenant_app with check(crm_expose_template_access(workspace_id,true) and crm_classification_allowed(workspace_id,data_classification,data_purpose));
create policy brand_asset_update on web_expose_brand_assets for update to novalure_tenant_app using(crm_expose_template_access(workspace_id,true) and crm_classification_allowed(workspace_id,data_classification,data_purpose)) with check(crm_expose_template_access(workspace_id,true) and crm_classification_allowed(workspace_id,data_classification,data_purpose));
grant select,insert,update on web_expose_brand_assets to novalure_tenant_app;
create policy brand_asset_owner_read on web_expose_brand_assets for select using(current_user=pg_get_userbyid((select relowner from pg_class where oid='public.web_expose_brand_assets'::regclass)));
do $$ declare t text;begin foreach t in array array['media_assets','media_asset_shares','property_media','property_documents','knowledge_source_versions'] loop execute format('create policy brand_validation_owner_read on %I for select using(current_user=pg_get_userbyid((select relowner from pg_class where oid=%L::regclass)))',t,'public.'||t);end loop;end $$;
create function crm_brand_asset_allowed(w uuid,a uuid,p text,h text default null) returns boolean language sql stable security definer set search_path=pg_catalog,public as $$
 select exists(select 1 from web_expose_brand_assets b join media_assets m on m.id=b.asset_id and m.workspace_id=b.workspace_id::text where b.workspace_id=w and b.asset_id=a and b.purpose=p and b.approved and (h is null or b.content_hash=h) and b.data_purpose='crm_sales' and b.data_classification in('CUSTOMER_TENANT','NOVALURE_INTERNAL')
 and m.folder='company-brand-assets' and m.storage_access='private' and not m.is_public and m.public_token is null and m.mime_type in('image/png','image/jpeg','image/webp') and m.size_bytes between 1 and 4194304
 and not exists(select 1 from media_asset_shares s where s.asset_id=a and s.revoked_at is null and s.expires_at>clock_timestamp())
 and not exists(select 1 from property_media r where r.media_asset_id=a) and not exists(select 1 from property_documents r where r.media_asset_id=a) and not exists(select 1 from knowledge_source_versions r where r.media_asset_id=a))
$$;
revoke all on function crm_brand_asset_allowed(uuid,uuid,text,text) from public;grant execute on function crm_brand_asset_allowed(uuid,uuid,text,text) to novalure_tenant_app;
-- A publisher may lock approved artwork for publication without acquiring
-- permission to UPDATE the registration through a SELECT FOR SHARE policy.
create function crm_lock_brand_asset(w uuid,a uuid,p text,h text) returns boolean language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 if not crm_expose_template_access(w,false) then return false;end if;
 perform b.asset_id from web_expose_brand_assets b join media_assets m on m.id=b.asset_id and m.workspace_id=b.workspace_id::text
 where b.workspace_id=w and b.asset_id=a and b.purpose=p and b.content_hash=h and crm_brand_asset_allowed(w,a,p,h) for share of b,m;
 return found;
end $$;
revoke all on function crm_lock_brand_asset(uuid,uuid,text,text) from public;
grant execute on function crm_lock_brand_asset(uuid,uuid,text,text) to novalure_tenant_app;
create function crm_brand_asset_guard() returns trigger language plpgsql set search_path=pg_catalog,public as $$
begin
 if not crm_expose_template_access(new.workspace_id,true) then raise exception using errcode='42501',message='Brand management denied';end if;
 if tg_op='UPDATE' and ((to_jsonb(new)-array['approved','revision','updated_by','updated_at']) is distinct from (to_jsonb(old)-array['approved','revision','updated_by','updated_at']) or new.revision<>old.revision+1 or new.approved or not old.approved) then raise exception using errcode='23514',message='Company artwork is immutable; only revoke its approval';end if;
 if tg_op='INSERT' then
  if new.revision<>1 or new.created_by is distinct from nullif(current_setting('app.actor_id',true),'')::uuid or not exists(select 1 from media_assets m where m.id=new.asset_id and m.workspace_id=new.workspace_id::text and m.folder='company-brand-assets' and m.storage_access='private' and not m.is_public and m.public_token is null and m.mime_type in('image/png','image/jpeg','image/webp') and m.size_bytes between 1 and 4194304) then raise exception using errcode='23514',message='A private dedicated artwork upload is required';end if;
 end if;new.updated_by:=nullif(current_setting('app.actor_id',true),'')::uuid;new.updated_at:=clock_timestamp();return new;
end $$;
create trigger brand_asset_classification before insert or update on web_expose_brand_assets for each row execute function crm_set_sales_classification();
create trigger brand_asset_guard before insert or update on web_expose_brand_assets for each row execute function crm_brand_asset_guard();
create or replace function crm_expose_template_config_valid(c jsonb) returns boolean language sql immutable set search_path=pg_catalog,public as $$
 select coalesce((jsonb_typeof(c)='object' and c-array['schemaVersion','name','companyName','accentColor','sectionOrder','layout','imageGrid','logoAssetId','letterheadAssetId']='{}'::jsonb and c->'schemaVersion'='1'::jsonb
 and jsonb_typeof(c->'name')='string' and length(trim(c->>'name')) between 1 and 120 and jsonb_typeof(c->'companyName')='string' and length(trim(c->>'companyName')) between 1 and 100 and ((c->>'name')||(c->>'companyName')) !~ '[[:cntrl:]]' and c->>'accentColor' ~ '^#[0-9a-fA-F]{6}$'
 and (not c?'layout' or c->>'layout' in('classic','editorial','compact')) and (not c?'imageGrid' or c->'imageGrid' in('1'::jsonb,'2'::jsonb,'3'::jsonb)) and (not c?'logoAssetId' or c->>'logoAssetId' ~ '^[0-9a-f-]{36}$') and (not c?'letterheadAssetId' or c->>'letterheadAssetId' ~ '^[0-9a-f-]{36}$')
 and jsonb_typeof(c->'sectionOrder')='array' and jsonb_array_length(c->'sectionOrder')=11 and c->'sectionOrder'->>0='hero' and (select array_agg(s order by s)=array['contact','description','documents','facts','floorplans','gallery','hero','links','location','units','videos']::text[] from jsonb_array_elements_text(c->'sectionOrder') s)),false)
$$;
create function crm_template_brand_guard() returns trigger language plpgsql set search_path=pg_catalog,public as $$
begin
 if (new.configuration?'logoAssetId' and not crm_brand_asset_allowed(new.workspace_id,(new.configuration->>'logoAssetId')::uuid,'logo')) or (new.configuration?'letterheadAssetId' and not crm_brand_asset_allowed(new.workspace_id,(new.configuration->>'letterheadAssetId')::uuid,'letterhead')) then raise exception using errcode='23514',message='Company artwork is no longer approved';end if;return new;
end $$;
create trigger c_template_brand_guard before insert on web_expose_template_versions for each row execute function crm_template_brand_guard();
alter function crm_web_expose_asset(text,uuid) rename to crm_web_expose_property_asset;
revoke all on function crm_web_expose_property_asset(text,uuid) from novalure_app;
create function crm_web_expose_asset(p_hash text,p_asset uuid) returns jsonb language sql stable security definer set search_path=pg_catalog,public as $$
 select coalesce(crm_web_expose_property_asset(p_hash,p_asset),(select jsonb_build_object('id',m.id,'workspaceId',v.workspace_id,'name',m.name,'originalName',m.original_name,'folder',m.folder,'mimeType',m.mime_type,'sizeBytes',m.size_bytes,'relativePath',m.relative_path,'storageProvider',m.storage_provider,'storageAccess',m.storage_access,'createdAt',m.created_at,'url','','isPublic',false,'hasActivePublicShare',false)
 from web_expose_links l join web_expose_versions v on v.id=l.version_id and v.workspace_id=l.workspace_id join media_assets m on m.id=p_asset and m.workspace_id=v.workspace_id::text
 where l.token_hash=p_hash and crm_web_expose_lookup(p_hash) is not null and exists(select 1 from jsonb_array_elements(coalesce(v.snapshot->'template'->'brandAssets','[]'::jsonb)) b where b->>'assetId'=p_asset::text and crm_brand_asset_allowed(v.workspace_id,p_asset,b->>'purpose',b->>'contentHash')) limit 1))
$$;
revoke all on function crm_web_expose_asset(text,uuid),crm_brand_asset_guard(),crm_template_brand_guard() from public;grant execute on function crm_web_expose_asset(text,uuid) to novalure_app;

-- Preserve the deletion protocol's complete incoming-reference check. Artwork
-- is retained while its immutable registration or a published version uses it.
create function crm_company_brand_media_reference_counts(p_asset uuid)
returns table(media_count integer,document_count integer,send_count integer,share_count integer,studio_count integer,knowledge_count integer,proof_count integer,resource_count integer,brand_count integer)
language sql stable security definer set search_path=pg_catalog,public as $$
 select prior.*,(select count(*)::integer from web_expose_brand_assets b where b.asset_id=p_asset and b.workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
 from crm_web_expose_media_reference_counts(p_asset) prior
$$;
revoke all on function crm_company_brand_media_reference_counts(uuid) from public;
grant execute on function crm_company_brand_media_reference_counts(uuid) to novalure_tenant_app;
