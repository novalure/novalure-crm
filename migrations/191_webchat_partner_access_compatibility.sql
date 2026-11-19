-- Compose the isolated Webchat member branch with the released partner fence.
-- 121 can be applied to an already upgraded database; 167 can also follow 121
-- on a fresh database. Neither order may restore broad external-partner access.
-- No account, role membership, table privilege, price, quota, provider binding
-- or activation is created. The media-owner predicate dependency is below.
set local lock_timeout='5s';
set local statement_timeout='2min';

do $guard$ begin
 if to_regprocedure('public.crm_webchat_customer_member(uuid)') is null
    or to_regprocedure('public.crm_partner_actor(uuid)') is null then
  raise exception 'Webchat/partner compatibility requires both unchanged predecessors';
 end if;
end $guard$;

create or replace function public.crm_project_access(p_workspace uuid,p_project uuid,p_write boolean default false)
returns boolean language sql stable security invoker set search_path=pg_catalog,public as $function$
 select p_workspace=nullif(current_setting('app.tenant_id',true),'')::uuid and exists(
  select 1 from public.workspace_users u where u.workspace_id=p_workspace
   and u.id=nullif(current_setting('app.actor_id',true),'')::uuid and u.status='active'
   and u.product_role<>'external_partner'
   and (not p_write or u.role in('owner','admin','agent'))
   and (public.crm_workspace_manager(p_workspace) or public.crm_webchat_customer_member(p_workspace) or exists(
    select 1 from public.project_pipeline_permissions g where g.workspace_id=p_workspace
     and g.project_id=p_project and g.user_id=u.id and g.can_read and (not p_write or g.can_edit_deals))))
$function$;

-- 189's SECURITY DEFINER calls the invoker project gate above. Its existing
-- table-owner principal needs only the restricted member predicate, even when
-- that principal deliberately has NOINHERIT. Do not grant a runtime role, table
-- access, role membership or GRANT OPTION, or adopt a different function owner.
do $media_dependency$
declare media_owner oid; table_owner oid; media_owner_name name;
begin
 if to_regprocedure('public.crm_property_media_access(text,text,uuid,boolean)') is null then return; end if;
 select proowner into media_owner from pg_proc
  where oid='public.crm_property_media_access(text,text,uuid,boolean)'::regprocedure and prosecdef;
 select relowner into table_owner from pg_class where oid='public.media_assets'::regclass;
 if media_owner is null or media_owner is distinct from table_owner then
  raise exception 'Property media project gate must retain its existing table-owner principal';
 end if;
 select rolname into media_owner_name from pg_roles where oid=media_owner;
 if media_owner_name in('novalure_app','novalure_tenant_app','novalure_webchat_product_writer','novalure_webchat_payment_executor') then
  raise exception 'Property media owner must remain separate from runtime and product executors';
 end if;
 execute format('grant execute on function public.crm_webchat_customer_member(uuid) to %I',media_owner_name);
end
$media_dependency$;
