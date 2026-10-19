-- Extraction results belong to immutable private document versions. No contract
-- or publication is enabled by this migration; existing reviewed content stays valid.
set local lock_timeout = '5s';
set local statement_timeout = '14min';

alter table knowledge_source_versions
 add column processing_status text not null default 'manual' check(processing_status in ('manual','ready','needs_ocr','failed')),
 add column processing_message text check(length(processing_message)<=1000),
 add column processing_format text check(processing_format in ('pdf','docx','text','image')),
 add column processing_error_code text check(length(processing_error_code)<=80),
 add column document_sha256 text check(document_sha256 ~ '^[a-f0-9]{64}$'),
 add column document_import_key text check(document_import_key ~ '^[a-f0-9]{64}$');
create unique index knowledge_document_import_idempotency on knowledge_source_versions(workspace_id,document_import_key)
 where document_import_key is not null;
create index knowledge_chunks_text_search_idx on knowledge_chunks using gin(to_tsvector('simple',content));

-- Existing version immutability also covers every added column. New generic
-- attachment creation must not bypass extraction by supplying copied text.
create function knowledge_document_processing_guard() returns trigger
 language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 if TG_OP='INSERT' and new.media_asset_id is not null and new.processing_status='manual'
   and not exists(select 1 from knowledge_source_versions previous
    where previous.source_id=new.source_id and previous.workspace_id=new.workspace_id
      and previous.media_asset_id=new.media_asset_id and previous.processing_status='manual') then
  new.processing_status := 'needs_ocr';
  new.processing_message := 'Dieses Dokument muss über den Dateiimport verarbeitet werden.';
 end if;
 if new.processing_status<>'manual' and new.media_asset_id is null then
  raise exception using errcode='23514',message='Document processing requires a private attachment';
 end if;
 if new.status='approved' and new.processing_status in ('needs_ocr','failed') then
  raise exception using errcode='23514',message='Document extraction must succeed before approval';
 end if;
 return new;
end $$;
create trigger knowledge_document_processing_guard before insert or update on knowledge_source_versions
 for each row execute function knowledge_document_processing_guard();
revoke all on function knowledge_document_processing_guard() from public;

-- The migration owner has the complete tenant media SELECT policy installed by
-- 101, including attachments hidden from generic media lists. Absence must be
-- confirmed on a fresh transaction before compensating nontransactional storage.
create function knowledge_document_upload_absent(p_asset uuid) returns boolean
 language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare tenant uuid := nullif(current_setting('app.tenant_id',true),'')::uuid;
begin
 if tenant is null or not knowledge_actor_can_write(false) then
  raise exception using errcode='42501',message='Authorized knowledge upload cleanup required';
 end if;
 return not exists(select 1 from media_assets where id=p_asset and workspace_id=tenant::text);
end $$;
revoke all on function knowledge_document_upload_absent(uuid) from public;
grant execute on function knowledge_document_upload_absent(uuid) to novalure_tenant_app;
