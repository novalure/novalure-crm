-- Keep the existing developer publication rule. An otherwise blocked update may
-- only append a proven same-project private PDF with no public-generation options.
create or replace function public.crm_guard_developer_listing_price()
returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
declare
 is_developer boolean; confirmed_price bigint; confirmation jsonb; outgoing_price bigint;
 old_registry jsonb; new_registry jsonb; old_versions jsonb; new_versions jsonb;
 appended jsonb; private_options jsonb; source_hashes jsonb; old_count integer;
 private_append boolean:=false;
begin
 new_registry:=new.canonical_payload->'expose';
 new_versions:=new_registry->'versions';
 if tg_op='INSERT' and new_versions @? '$[*] ? (exists(@.privateOptions))' then
  raise exception using errcode='23514',message='A private Exposé version requires a scoped append';
 end if;
 if tg_op='UPDATE' then
  old_registry:=coalesce(old.canonical_payload->'expose','{"schemaVersion":1,"activeDocumentId":null,"preferredSource":"generated","versions":[]}'::jsonb);
  old_versions:=old_registry->'versions';
  -- Preserve the history even when a later edit removes all publication price
  -- flags or legitimately restores price authority. Neither path permits a
  -- private-options entry to be rewritten as the public-options form.
  if new_versions is distinct from old_versions and
    (old_versions @? '$[*] ? (exists(@.privateOptions))' or new_versions @? '$[*] ? (exists(@.privateOptions))')
  then
   if not coalesce(jsonb_typeof(old_versions)='array' and jsonb_typeof(new_versions)='array',false) then
    raise exception using errcode='23514',message='Private Exposé version history cannot be rewritten';
   end if;
   old_count:=jsonb_array_length(old_versions);
   appended:=new_versions->old_count;
   if not coalesce(
     old_count<100 and jsonb_array_length(new_versions)=old_count+1 and new_versions-old_count=old_versions
     and to_jsonb(new)-'canonical_payload'=to_jsonb(old)-'canonical_payload'
     and new.canonical_payload-'expose'=coalesce(old.canonical_payload,'{}'::jsonb)-'expose'
     and not exists(select 1 from jsonb_array_elements(old_versions) v
       where v->'id'=appended->'id' or v->'assetId'=appended->'assetId'), false)
   then
    raise exception using errcode='23514',message='Private Exposé version history cannot be rewritten';
   end if;
   if appended ? 'privateOptions' then
    private_options:=appended->'privateOptions';
    source_hashes:=appended->'sourceMediaHashes';
    if not coalesce(
      new.project_id is not null and public.crm_project_access(new.workspace_id,new.project_id,true)
      and old_registry->'schemaVersion'='1'::jsonb and new_registry->'schemaVersion'='1'::jsonb
      and new_registry-ARRAY['schemaVersion','revision','activeDocumentId','preferredSource','versions']='{}'::jsonb
      and new_registry->>'revision' ~ '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
      and new_registry->'revision' is distinct from old_registry->'revision'
      and new_registry->'activeDocumentId'=old_registry->'activeDocumentId' and new_registry->>'preferredSource'='generated'
      and jsonb_typeof(appended)='object'
      and appended-ARRAY['id','assetId','source','fileName','createdAt','sizeBytes','pageCount','versionLabel','sourceFingerprint','sha256','privateOptions','sourceMediaHashes']='{}'::jsonb
      and appended->>'source'='generated'
      and appended->>'fileName' ~ '^Novalure_Expose_[a-f0-9]{8}_(de|en|es)_[0-9]{4}-[0-9]{2}-[0-9]{2}\.pdf$'
      and jsonb_typeof(appended->'createdAt')='string'
      and appended->>'createdAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
      and pg_input_is_valid(appended->>'createdAt','timestamp with time zone')
      and jsonb_typeof(appended->'pageCount')='number' and appended->>'pageCount' ~ '^([1-9][0-9]?|100)$'
      and appended->>'versionLabel'='v'||(old_count+1)::text
      and appended->>'sourceFingerprint' ~ '^[a-f0-9]{64}$'
      and appended->>'sha256' ~ '^[a-f0-9]{64}$'
      and appended->>'id' ~ '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
      and appended->>'assetId' ~ '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
      and jsonb_typeof(private_options)='object'
      and private_options-ARRAY['template','language','address','showPrice','showContact','imageIds','floorPlanIds','title','description']='{}'::jsonb
      and private_options->>'template' in ('compact','full') and private_options->>'language' in ('de','en','es')
      and private_options->>'address' in ('city','full','hidden') and jsonb_typeof(private_options->'showContact')='boolean'
      and (
        private_options->'showPrice'='false'::jsonb
        or (private_options->'showPrice'='true'::jsonb and (
          case when new.channel_price_visibility->>'Exposé' in ('publish_price','price_on_request','hide_price')
            then new.channel_price_visibility->>'Exposé' else new.price_visibility end
        ) in ('hide_price','price_on_request'))
      )
      and private_options->'floorPlanIds'='[]'::jsonb
      and (not private_options ? 'title' or (jsonb_typeof(private_options->'title')='string' and length(private_options->>'title')<=180))
      and (not private_options ? 'description' or (jsonb_typeof(private_options->'description')='string' and length(private_options->>'description')<=16000))
      and jsonb_typeof(private_options->'imageIds')='array' and jsonb_typeof(source_hashes)='object',false)
    then
     raise exception using errcode='23514',message='Invalid private Exposé version';
    end if;
    if not coalesce(
      jsonb_array_length(private_options->'imageIds')<=20
      and (select count(distinct id) from jsonb_array_elements_text(private_options->'imageIds') image(id))
        =jsonb_array_length(private_options->'imageIds')
      and not exists(select 1 from jsonb_array_elements_text(private_options->'imageIds') image(id)
        where id is null or id !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$' or source_hashes->>id is null)
      and (select count(*) from jsonb_object_keys(source_hashes))=jsonb_array_length(private_options->'imageIds')
      and not exists(select 1 from jsonb_each_text(source_hashes) img where img.value is null or img.value !~ '^[a-f0-9]{64}$')
      and exists(
        select 1 from public.property_documents d
        join public.media_assets m on m.id=d.media_asset_id and m.workspace_id=d.workspace_id::text
        where d.id=(appended->>'id')::uuid and d.workspace_id=new.workspace_id
          and d.property_id=new.id and d.project_id=new.project_id and d.unit_id is null
          and d.category='novalure_expose' and d.status='needs_review' and d.visibility='private' and d.sent_at is null
          and d.metadata->'expose'=appended and d.media_asset_id=(appended->>'assetId')::uuid
          and m.mime_type='application/pdf' and m.storage_access='private' and not m.is_public and m.public_token is null
          and lower(m.folder)='properties/'||new.id::text
          and m.size_bytes between 1 and 10485760 and appended->'sizeBytes'=to_jsonb(m.size_bytes)
          and not exists(select 1 from public.media_asset_shares s
            where s.workspace_id=m.workspace_id and s.asset_id=m.id and s.revoked_at is null and s.expires_at>now())
          and not exists(select 1 from public.property_documents other
            where other.workspace_id=d.workspace_id and other.media_asset_id=m.id and other.id<>d.id)
      ),false)
    then
     raise exception using errcode='23514',message='Unverified private Exposé file';
    end if;
    private_append:=true;
   end if;
  end if;
 end if;

 select (p.developer_organization_id is not null or p.customer_type='property_developer'
  or lower(p.type) like '%bautr%' or w.customer_type='property_developer')
 into is_developer from public.projects p join public.workspaces w on w.id=p.workspace_id
 where p.workspace_id=new.workspace_id and p.id=new.project_id;
 if not coalesce(is_developer,false) then return new; end if;
 if new.price_visibility<>'publish_price' and not exists(select 1 from jsonb_each_text(coalesce(new.channel_price_visibility,'{}')) where value='publish_price') then return new; end if;
 outgoing_price:=coalesce(new.public_price_cents,new.target_price_cents,0);
 if outgoing_price<=0 then return new; end if;
 select u.price_cents,u.metadata->'priceConfirmation' into confirmed_price,confirmation
 from public.property_units u where u.workspace_id=new.workspace_id and u.project_id=new.project_id and u.id=new.unit_id;
 if confirmation is null or confirmed_price is distinct from outgoing_price
  or confirmation->>'sourceReference' is null
  or (confirmation->>'priceCents')::bigint is distinct from confirmed_price then
  if private_append then return new; end if;
  raise exception using errcode='23514',message='Developer publication requires an authorized confirmed unit price';
 end if;
 return new;
end $$;
