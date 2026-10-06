-- U1-C05: let the tenant runtime execute the existing fail-closed property
-- attachment deletion protocol without broad cross-tenant reference reads.
set local lock_timeout = '5s';
set local statement_timeout = '14min';

create or replace function crm_media_reference_counts(p_asset uuid)
returns table(media_count integer, document_count integer, send_count integer, share_count integer)
language sql
stable
security definer
set search_path = pg_catalog, public
as $function$
  select
    (select count(*)::integer from property_media where media_asset_id = p_asset),
    (select count(*)::integer from property_documents where media_asset_id = p_asset),
    (select count(*)::integer from bot_document_sends where media_asset_id = p_asset),
    (select count(*)::integer from media_asset_shares where asset_id = p_asset)
  where exists (
    select 1 from media_assets asset
    where asset.id = p_asset
      and asset.workspace_id = nullif(current_setting('app.tenant_id', true), '')
  )
    and exists (
      select 1 from workspace_users actor
      where actor.workspace_id = nullif(current_setting('app.tenant_id', true), '')::uuid
        and actor.id = nullif(current_setting('app.actor_id', true), '')::uuid
        and actor.status = 'active'
        and actor.role in ('owner', 'admin', 'agent')
    )
$function$;

revoke all on function crm_media_reference_counts(uuid) from public;
grant execute on function crm_media_reference_counts(uuid) to novalure_tenant_app;
grant delete on table property_media, property_documents to novalure_tenant_app;
