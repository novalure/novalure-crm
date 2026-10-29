-- Explicit revocable operation for the existing runtime bindings only.
-- Existing rows remain bounded, with their original expiries and enable/revoke state.
-- Run atomically through the normal migration runner after unchanged 118.
set local lock_timeout='5s';
set local statement_timeout='2min';
alter table public.behavior_runtime_bindings
 add column operating_mode text not null default 'bounded',
 alter column expires_at drop not null,
 add constraint behavior_runtime_operating_mode_check check (
  (operating_mode='bounded' and expires_at is not null and isfinite(expires_at))
  or (operating_mode='revocable' and expires_at is null)
 );
alter table public.behavior_personal_workload_bindings
 add column operating_mode text not null default 'bounded',
 alter column expires_at drop not null,
 add constraint behavior_personal_operating_mode_check check (
  (operating_mode='bounded' and expires_at is not null and isfinite(expires_at))
  or (operating_mode='revocable' and expires_at is null)
 );
-- The existing personal expires_at > not_before check remains effective for bounded rows.
-- Only binding time fences change; principal expiry, ownership, ACL, RLS and SHARE locks remain.

create or replace function public.behavior_lock_runtime(p_broker uuid,p_hash text)
returns table(id uuid,workspace_id uuid,actor_id uuid,bot_id uuid,department text)
language sql security definer set search_path=pg_catalog,public as $$
 select b.id,b.workspace_id,b.actor_id,b.bot_id,b.department
 from public.behavior_runtime_bindings b
 join public.workspace_users broker on broker.workspace_id=b.workspace_id and broker.id=b.broker_actor_id
 join public.workspace_users actor on actor.workspace_id=b.workspace_id and actor.id=b.actor_id
 join public.bots bot on bot.workspace_id=b.workspace_id and bot.id=b.bot_id
 where b.broker_actor_id=p_broker and b.token_hash=p_hash and b.enabled and b.revoked_at is null and ((b.operating_mode='revocable' and b.expires_at is null) or (b.operating_mode='bounded' and b.expires_at>clock_timestamp()))
 and b.workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid
 and nullif(current_setting('app.actor_id',true),'')::uuid in (b.broker_actor_id,b.actor_id)
 and broker.status='active' and actor.status='active' and actor.role='agent'
 and actor.product_role in ('novalure_operator','project_sales_member')
 for share of b,broker,actor,bot
$$;

create or replace function public.behavior_runtime_area_allowed(p_workspace uuid,p_area uuid)
returns boolean language sql stable security definer set search_path=pg_catalog,public as $$
 select p_workspace=nullif(current_setting('app.tenant_id',true),'')::uuid and (
  not exists(select 1 from public.behavior_runtime_bindings r where r.workspace_id=p_workspace
    and r.actor_id=nullif(current_setting('app.actor_id',true),'')::uuid)
  or exists(select 1 from public.behavior_runtime_bindings r join public.knowledge_area_grants g
    on g.workspace_id=r.workspace_id and g.bot_id=r.bot_id and g.channel='internal' and g.area_id=p_area
    where r.workspace_id=p_workspace and r.actor_id=nullif(current_setting('app.actor_id',true),'')::uuid
    and r.enabled and r.revoked_at is null and ((r.operating_mode='revocable' and r.expires_at is null) or (r.operating_mode='bounded' and r.expires_at>now())))
 )
$$;

create or replace function public.behavior_lock_workload(p_principal uuid,p_broker uuid) returns boolean
language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 perform p.id from public.crm_service_principals p where p.id=p_principal and p.actor_user_id=p_broker
  and p.workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid
  and exists(select 1 from public.behavior_runtime_bindings b where b.workspace_id=p.workspace_id
    and b.broker_actor_id=p_broker and b.actor_id=nullif(current_setting('app.actor_id',true),'')::uuid
    and b.enabled and b.revoked_at is null and ((b.operating_mode='revocable' and b.expires_at is null) or (b.operating_mode='bounded' and b.expires_at>clock_timestamp())))
  and p.state='ACTIVE' and not p.kill_switch_active and p.revoked_at is null
  and p.not_before<=clock_timestamp() and p.expires_at>clock_timestamp() for share of p;
 return found;
end $$;

create or replace function public.behavior_authenticate_personal_workload()
returns table(id uuid,workspace_id uuid,actor_user_id uuid,identity_id text)
language sql stable security definer set search_path=pg_catalog,public as $function$
 select w.id,w.workspace_id,w.broker_actor_id,'EVELYN_FRANZ_PERSONAL_SHARED_RUNTIME'::text
 from public.behavior_personal_workload_bindings w
 join public.workspace_users broker on broker.id=w.broker_actor_id and broker.workspace_id=w.workspace_id
 join public.workspaces workspace on workspace.id=w.workspace_id
 where w.singleton and w.enabled and w.revoked_at is null
  and w.not_before<=clock_timestamp() and ((w.operating_mode='revocable' and w.expires_at is null) or (w.operating_mode='bounded' and w.expires_at>clock_timestamp()))
  and broker.status='active' and broker.role='agent' and broker.product_role='novalure_operator'
  and workspace.operating_model='novalure_internal' and workspace.customer_type='novalure_internal'
$function$;

create or replace function public.behavior_lock_personal_workload(p_workload uuid,p_broker uuid)
returns boolean language plpgsql security definer set search_path=pg_catalog,public as $function$
begin
 perform w.id from public.behavior_personal_workload_bindings w
 join public.workspace_users broker on broker.id=w.broker_actor_id and broker.workspace_id=w.workspace_id
 join public.workspaces workspace on workspace.id=w.workspace_id
 where w.id=p_workload and w.broker_actor_id=p_broker and w.singleton and w.enabled and w.revoked_at is null
  and w.workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid
  and w.not_before<=clock_timestamp() and ((w.operating_mode='revocable' and w.expires_at is null) or (w.operating_mode='bounded' and w.expires_at>clock_timestamp()))
  and broker.status='active' and broker.role='agent' and broker.product_role='novalure_operator'
  and workspace.operating_model='novalure_internal' and workspace.customer_type='novalure_internal'
  and exists(select 1 from public.behavior_runtime_bindings b where b.workspace_id=w.workspace_id
   and b.broker_actor_id=p_broker and b.actor_id=nullif(current_setting('app.actor_id',true),'')::uuid
   and b.department='executive' and b.enabled and b.revoked_at is null and ((b.operating_mode='revocable' and b.expires_at is null) or (b.operating_mode='bounded' and b.expires_at>clock_timestamp())))
 for share of w,broker;
 return found;
end $function$;
