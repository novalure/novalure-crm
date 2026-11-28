-- Separate additive LongFog-only V2 Preview metadata. No QA9 or Production stage is edited.
-- Installs no workload/grant/key/fixture. The protected operator registers them separately.
set local lock_timeout='5s';
set local statement_timeout='2min';
do $guard$ declare r pg_roles;begin
 select * into strict r from pg_roles where rolname=current_user;
 if r.rolcanlogin or r.rolsuper or r.rolbypassrls or r.rolcreatedb or r.rolcreaterole or r.rolreplication
  or pg_has_role('novalure_app',r.oid,'MEMBER') or pg_has_role('novalure_tenant_app',r.oid,'MEMBER')
  or current_database()<>'neondb' or current_setting('neon.project_id',true) is distinct from 'long-fog-84900593'
  or current_setting('neon.branch_id',true) is distinct from 'br-summer-mountain-bh7w67e3'
  or exists(select 1 from unnest(array['crm_autonomous_workloads','crm_autonomous_access_grants','crm_autonomous_recovery_authorities']) t
    left join pg_class c on c.oid=to_regclass('public.'||t) where c.oid is null or c.relowner<>r.oid)
  or to_regprocedure('public.crm_lock_autonomous_access_grant_v1(uuid,uuid)') is null
  or to_regprocedure('public.crm_lookup_autonomous_recovery(uuid,uuid,uuid,uuid)') is null
  or to_regprocedure('public.crm_autonomous_preview_long_fog()') is not null
 then raise exception 'AUTONOMOUS_PREVIEW_INSTALLER_BOUNDARY' using errcode='42501';end if;
end $guard$;

alter table public.crm_autonomous_workloads
 add column preview_identity_id text,add column receiver_deployment_id text,add column receiver_revision text,add column receiver_origin text,add column qa_run_id uuid;
-- Keep the original UNIQUE(identity_id), including ON CONFLICT(identity_id) inference.
-- QA instance keys are canonical distinct registrations; external OIDC identity is fixed separately.
alter table public.crm_autonomous_workloads drop constraint crm_autonomous_workloads_audience_check;
alter table public.crm_autonomous_workloads drop constraint crm_autonomous_workload_source_bundle;
alter table public.crm_autonomous_workloads add constraint crm_autonomous_workload_source_bundle check (
 (audience='urn:novalure:crm:production' and preview_identity_id is null and receiver_deployment_id is null and receiver_revision is null and receiver_origin is null and qa_run_id is null
  and ((identity_id='EVELYN_CRM_AUTONOMOUS_INTERNAL_IDENTITY' and subject='owner:novalure:project:evelyn:environment:production' and environment='production' and custom_environment_id is null)
   or (identity_id='EVELYN_CRM_PERSONAL_INTERNAL_IDENTITY' and subject='owner:novalure:project:evelyn:environment:franz-personal' and environment='franz-personal' and custom_environment_id='env_sue274zKgFxQJiKfw64x7BmEfEwE' and custom_environment_id is not null)))
 or (preview_identity_id='EVELYN_CRM_AUTONOMOUS_QA_IDENTITY' and preview_identity_id is not null
  and receiver_deployment_id is not null and receiver_deployment_id~'^dpl_[A-Za-z0-9]+$'
  and receiver_revision is not null and receiver_revision~'^[a-f0-9]{40}$' and receiver_origin is not null
  and receiver_origin~'^https://novalure-[a-z0-9-]+-novalure\.vercel\.app$' and receiver_origin not like '%-git-%'
  and receiver_origin<>'https://novalure-crm-novalure.vercel.app' and qa_run_id is not null
  and qa_run_id::text~'^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
  and identity_id='EVELYN_CRM_AUTONOMOUS_QA_IDENTITY:'||qa_run_id::text||':'||receiver_deployment_id
  and audience='urn:novalure:crm:autonomous-access-v2:preview:prj_R32Okl6AHijTohvuKmryuTLjWMsk'
  and subject='owner:novalure:project:evelyn:environment:preview' and environment='preview' and custom_environment_id is null
  and expires_at is not null and isfinite(expires_at))
);
create function public.crm_autonomous_preview_long_fog() returns boolean
language sql stable security definer set search_path=pg_catalog,public as $f$
 select coalesce(current_database()='neondb' and current_setting('neon.project_id',true)='long-fog-84900593'
  and current_setting('neon.branch_id',true)='br-summer-mountain-bh7w67e3',false)
$f$;
create function public.crm_autonomous_preview_workload_valid(p public.crm_autonomous_workloads) returns boolean
language sql stable security definer set search_path=pg_catalog,public as $f$
 select coalesce(public.crm_autonomous_preview_long_fog() and p.preview_identity_id='EVELYN_CRM_AUTONOMOUS_QA_IDENTITY'
  and p.environment='preview' and p.audience='urn:novalure:crm:autonomous-access-v2:preview:prj_R32Okl6AHijTohvuKmryuTLjWMsk'
  and p.subject='owner:novalure:project:evelyn:environment:preview' and p.custom_environment_id is null
  and p.receiver_deployment_id~'^dpl_[A-Za-z0-9]+$' and p.receiver_revision~'^[a-f0-9]{40}$' and p.receiver_origin is not null and p.qa_run_id is not null
  and p.identity_id='EVELYN_CRM_AUTONOMOUS_QA_IDENTITY:'||p.qa_run_id::text||':'||p.receiver_deployment_id
  and p.expires_at is not null and isfinite(p.expires_at) and p.expires_at>clock_timestamp() and p.not_before<=clock_timestamp()
  and not p.disabled and not p.kill_switch_active and p.revoked_at is null,false)
$f$;
create function public.crm_autonomous_preview_registration_scope() returns trigger
language plpgsql security definer set search_path=pg_catalog,public as $f$ declare p public.crm_autonomous_workloads;begin
 if tg_table_name='crm_autonomous_workloads' then
  if new.preview_identity_id is not null then
   if not public.crm_autonomous_preview_long_fog() then raise exception 'AUTONOMOUS_PREVIEW_TARGET_DENIED' using errcode='42501';end if;
   if tg_op='UPDATE' and ((old.revoked_at is not null and new.revoked_at is null) or (old.disabled and not new.disabled) or (old.kill_switch_active and not new.kill_switch_active)) then raise exception 'AUTONOMOUS_PREVIEW_CLOSED' using errcode='42501';end if;
  end if;
 else
  select * into p from public.crm_autonomous_workloads where id=new.workload_id;
  if p.preview_identity_id is not null and tg_op='UPDATE' then
   if (old.revoked_at is not null and new.revoked_at is null) or (old.disabled and not new.disabled) then raise exception 'AUTONOMOUS_PREVIEW_CLOSED' using errcode='42501';end if;
   -- Exact capability reductions remain available after workload expiry/revoke.
   if public.crm_autonomous_preview_long_fog() and
    (to_jsonb(new)-'revoked_at'-'disabled'-'expires_at')=(to_jsonb(old)-'revoked_at'-'disabled'-'expires_at')
    and new.expires_at is not null and new.expires_at<=old.expires_at
    and (new.revoked_at is not null or new.disabled or new.expires_at<old.expires_at) then return new;end if;
  end if;
  if p.preview_identity_id is not null and (not public.crm_autonomous_preview_workload_valid(p)
   or new.contract_version<>'crm-autonomous-access-v2' or new.entity<>'Task' or new.lifecycle_mode<>'EXISTING'
   or new.related_resources<>'{}'::jsonb or not new.scopes<@array['crm.tasks.read','crm.tasks.write']::text[]
   or not new.read_fields<@array['title']::text[] or not new.write_fields<@array['title']::text[]
   or new.expires_at is null or new.expires_at>p.expires_at)
   then raise exception 'AUTONOMOUS_PREVIEW_SCOPE_DENIED' using errcode='42501';end if;
 end if;return new;
end $f$;
create trigger autonomous_preview_workload_scope before insert or update on public.crm_autonomous_workloads for each row execute function public.crm_autonomous_preview_registration_scope();
create trigger autonomous_preview_grant_scope before insert or update on public.crm_autonomous_access_grants for each row execute function public.crm_autonomous_preview_registration_scope();

create function public.crm_authenticate_autonomous_preview_workload(p_issuer text,p_audience text,p_project text,p_owner text,p_subject text,p_workspace uuid,p_environment text,p_deployment text,p_revision text,p_origin text,p_grant uuid)
returns table(id uuid,workspace_id uuid,identity_id text,qa_run_id uuid)
language sql stable security definer set search_path=pg_catalog,public as $f$
 select p.id,p.workspace_id,p.preview_identity_id,p.qa_run_id from public.crm_autonomous_workloads p
 join public.crm_autonomous_access_grants g on g.workload_id=p.id and g.id=p_grant
 join public.workspace_users actor on actor.id=p.actor_user_id and actor.workspace_id=p.workspace_id
 join public.workspaces w on w.id=p.workspace_id
 where public.crm_autonomous_preview_workload_valid(p) and session_user='novalure_app'
  and exists(select 1 from pg_roles r where rolname=session_user and not r.rolsuper and not r.rolbypassrls and not r.rolcreatedb and not r.rolcreaterole and not r.rolreplication)
  and pg_has_role(session_user,'novalure_tenant_app','USAGE') and not pg_has_role(session_user,current_user,'MEMBER')
  and p.issuer=p_issuer and p.audience=p_audience and p.project_id=p_project and p.owner_id=p_owner and p.subject=p_subject
  and p.workspace_id=p_workspace and p.environment=p_environment and p.receiver_deployment_id=p_deployment and p.receiver_revision=p_revision and p.receiver_origin=p_origin
  and actor.status='active' and actor.role='agent' and actor.product_role='novalure_operator' and w.operating_model='novalure_internal'
$f$;

create function public.crm_lock_autonomous_preview_grant_base(p_workload uuid,p_grant uuid)
returns setof public.crm_autonomous_access_grants
language sql volatile security definer set search_path=pg_catalog,public as $function$
  select g.* from public.crm_autonomous_access_grants g
  join public.crm_autonomous_workloads p on p.id=g.workload_id and p.workspace_id=g.workspace_id
  join public.workspace_users source_actor on source_actor.id=p.actor_user_id and source_actor.workspace_id=p.workspace_id
  join public.workspace_users actor on actor.id=g.actor_user_id and actor.workspace_id=g.workspace_id
  join public.workspaces w on w.id=g.workspace_id
  join public.project_pipeline_permissions project_grant on project_grant.workspace_id=g.workspace_id
    and project_grant.project_id=g.project_id and project_grant.user_id=g.actor_user_id
  where g.id=p_grant and p.id=p_workload
    and g.authority_class='REAL_INTERNAL_OPERATIONS'
    and not g.disabled and g.revoked_at is null and g.not_before<=clock_timestamp() and (g.expires_at is null or g.expires_at>clock_timestamp())
    and public.crm_autonomous_preview_workload_valid(p)
    and g.contract_version='crm-autonomous-access-v2' and g.entity='Task' and g.lifecycle_mode='EXISTING'
    and g.related_resources='{}'::jsonb and g.read_fields<@array['title']::text[] and g.write_fields<@array['title']::text[]
    and g.scopes<@array['crm.tasks.read','crm.tasks.write']::text[] and g.expires_at is not null and g.expires_at<=p.expires_at
    and not p.disabled and not p.kill_switch_active and p.revoked_at is null
    and p.not_before<=clock_timestamp() and (p.expires_at is null or p.expires_at>clock_timestamp())
    and source_actor.status='active' and source_actor.role='agent' and source_actor.product_role='novalure_operator'
    and actor.status='active' and actor.role='agent' and actor.product_role='novalure_operator'
    and w.operating_model='novalure_internal'
    and project_grant.can_read
    and (not ('crm.tasks.write'=any(g.scopes)) or project_grant.can_edit_deals)
  for share of g,p,source_actor,actor,w,project_grant
$function$;
-- Existing parent-chain and business helpers keep their exact calls and ceilings.
alter function public.crm_lock_autonomous_access_grant_v1(uuid,uuid) rename to crm_lock_autonomous_access_grant_before_preview_qa;
create function public.crm_lock_autonomous_access_grant_v1(p_workload uuid,p_grant uuid)
returns setof public.crm_autonomous_access_grants language sql volatile security definer set search_path=pg_catalog,public as $f$
 select * from public.crm_lock_autonomous_access_grant_before_preview_qa(p_workload,p_grant)
 union all select * from public.crm_lock_autonomous_preview_grant_base(p_workload,p_grant)
$f$;

alter function public.crm_lookup_autonomous_recovery(uuid,uuid,uuid,uuid) rename to crm_lookup_autonomous_recovery_before_preview_qa;
create function public.crm_lookup_autonomous_recovery(p_workload uuid,p_authority uuid,p_grant uuid,p_control uuid)
returns table(authority_id uuid,workload_id uuid,recovery_key text,grant_id uuid,workspace_id uuid,actor_user_id uuid,project_id uuid,source_id uuid,entity text,department_id text,agent_id text,task_id uuid,control_project_id uuid)
language sql stable security definer set search_path=pg_catalog,public as $f$
 select * from public.crm_lookup_autonomous_recovery_before_preview_qa(p_workload,p_authority,p_grant,p_control)
 union all
 select a.id,w.id,a.recovery_public_key,g.id,g.workspace_id,g.actor_user_id,g.project_id,g.source_id,g.entity,g.department_id,g.agent_id,g.task_id,a.control_project_id
 from public.crm_autonomous_recovery_authorities a join public.crm_autonomous_workloads w on w.id=a.workload_id
 join public.crm_autonomous_access_grants g on g.workload_id=w.id and g.id=p_grant and g.id=any(a.grant_ids) and g.workspace_id=w.workspace_id
 join public.workspace_users actor on actor.id=w.actor_user_id and actor.workspace_id=w.workspace_id
 join public.workspaces workspace on workspace.id=w.workspace_id
 where w.id=p_workload and a.id=p_authority and a.control_project_id=p_control
  and public.crm_autonomous_preview_workload_valid(w) and g.contract_version='crm-autonomous-access-v2' and g.entity='Task' and g.lifecycle_mode='EXISTING'
  and not a.disabled and a.revoked_at is null and a.not_before<=clock_timestamp() and a.expires_at>clock_timestamp()
  and actor.status='active' and actor.role='agent' and actor.product_role='novalure_operator' and workspace.operating_model='novalure_internal'
$f$;
-- No business read is added to recovery. Its original independent authority,
-- key separation, receipt checks, nonce, lock order and tombstone remain intact.
revoke all on function public.crm_autonomous_preview_long_fog(),public.crm_autonomous_preview_workload_valid(public.crm_autonomous_workloads),
 public.crm_autonomous_preview_registration_scope(),public.crm_lock_autonomous_preview_grant_base(uuid,uuid),
 public.crm_lock_autonomous_access_grant_v1(uuid,uuid),public.crm_lock_autonomous_access_grant_before_preview_qa(uuid,uuid),
 public.crm_lookup_autonomous_recovery_before_preview_qa(uuid,uuid,uuid,uuid) from public,novalure_app,novalure_tenant_app;
revoke all on function public.crm_authenticate_autonomous_preview_workload(text,text,text,text,text,uuid,text,text,text,text,uuid) from public,novalure_app;
grant execute on function public.crm_authenticate_autonomous_preview_workload(text,text,text,text,text,uuid,text,text,text,text,uuid) to novalure_tenant_app;
-- Original recovery lookup EXECUTE remains the same narrow tenant capability.
revoke all on function public.crm_lookup_autonomous_recovery(uuid,uuid,uuid,uuid) from public,novalure_app;
grant execute on function public.crm_lookup_autonomous_recovery(uuid,uuid,uuid,uuid) to novalure_tenant_app;
