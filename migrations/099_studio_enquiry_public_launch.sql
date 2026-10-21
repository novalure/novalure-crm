-- Existing confirmed-enquiry contract: allow real customer snapshots as well as
-- server-authorized synthetic acceptance records. No tenant/actor/asset policy changes.
set local lock_timeout = '5s';
set local statement_timeout = '14min';
do $verify$
declare marker record;
begin
  if not exists(select 1 from public.novalure_schema_migrations where version='098_studio_enquiry_handoff') then
    raise exception 'Migration 098 must precede Studio public enquiry launch';
  end if;
  select oid,conname,pg_get_expr(conbin,conrelid) as expression into strict marker
    from pg_constraint where conrelid='public.studio_enquiry_transfers'::regclass
      and contype='c' and pg_get_constraintdef(oid) like '%syntheticTest%';
  if regexp_replace(marker.expression,'\s','','g') <>
      '(((snapshot_text)::jsonb->''syntheticTest''::text)=''true''::jsonb)' then
    raise exception 'Unexpected existing Studio synthetic marker constraint';
  end if;
  execute format('alter table public.studio_enquiry_transfers drop constraint %I',marker.conname);
end;
$verify$;
alter table public.studio_enquiry_transfers
  add constraint studio_enquiry_snapshot_synthetic_marker_boolean check (
    snapshot_text::jsonb ? 'syntheticTest'
    and jsonb_typeof(snapshot_text::jsonb->'syntheticTest')='boolean'
  );
-- Exact actor, fixed tenant, immutable confirmation/digests, private assets,
-- reference FKs and FORCE RLS from 098 remain unchanged. No existing snapshot is updated.

-- The Preview path already has the guarded five-column counter from 098.
-- Give the public-launch runtime the same additive name as standalone Production.
create function public.crm_studio_media_reference_counts(p_asset uuid)
returns table(media_count integer,document_count integer,send_count integer,share_count integer,studio_count integer)
language sql stable set search_path=pg_catalog,public as $fn$
  select * from public.crm_media_reference_counts(p_asset)
$fn$;
revoke all on function public.crm_studio_media_reference_counts(uuid) from public;
grant execute on function public.crm_studio_media_reference_counts(uuid) to novalure_tenant_app;
