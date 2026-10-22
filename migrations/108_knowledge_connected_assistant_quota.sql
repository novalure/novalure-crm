-- Counts licensed Knowledge connections, not all CRM bot drafts. All saved
-- grants count, including archived areas and paused channels. Only removing
-- the final explicit grant releases the assistant's place.
set local lock_timeout = '5s';
set local statement_timeout = '5min';

-- The definer needs the whole current tenant despite project-level policies.
-- The runtime receives no extra row access; the function exposes counts only.
do $owner_policy$
begin
  execute format('create policy knowledge_owner_assistant_usage on public.knowledge_area_grants for select to %I using(workspace_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',current_user);
  execute format('create policy knowledge_owner_assistant_usage_scope on public.bots for select to %I using(workspace_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid and crm_classification_allowed(workspace_id,data_classification,data_purpose) and (project_id is null or crm_project_access(workspace_id,project_id,false)))',current_user);
end $owner_policy$;

create function public.knowledge_connected_assistant_count(p_workspace uuid,p_bot uuid default null)
returns integer
language plpgsql stable security definer set search_path=pg_catalog,public as $function$
begin
  if p_workspace is distinct from nullif(current_setting('app.tenant_id',true),'')::uuid
    or not exists(select 1 from public.workspace_users u
      where u.workspace_id=p_workspace
        and u.id=nullif(current_setting('app.actor_id',true),'')::uuid
        and u.status='active') then
    raise exception using errcode='42501',message='Knowledge assistant usage context mismatch';
  end if;
  -- A complete tenant aggregate is safe to expose. A targeted 0/1 answer must
  -- not become a presence oracle for a bot in a project the actor cannot read.
  if p_bot is not null and not exists(select 1 from public.bots b
    where b.id=p_bot and b.workspace_id=p_workspace
      and (b.project_id is null or public.crm_project_access(b.workspace_id,b.project_id,false))) then
    raise exception using errcode='42501',message='Knowledge assistant usage target is unavailable';
  end if;
  return (select count(distinct g.bot_id)::integer
    from public.knowledge_area_grants g
    where g.workspace_id=p_workspace and (p_bot is null or g.bot_id=p_bot));
end
$function$;
revoke all on function public.knowledge_connected_assistant_count(uuid,uuid) from public;
grant execute on function public.knowledge_connected_assistant_count(uuid,uuid) to novalure_tenant_app;
