-- Exact legacy provenance only. No QA classification, registration in 068,
-- workspace retirement, account mutation, new read grants or table/role owner.
set local lock_timeout = '5s';
set local statement_timeout = '30s';

do $guard$
begin
  if to_regprocedure('public.crm_customer_provisioning_authorized(uuid)') is null
    or to_regclass('public.crm_property_creation_drafts') is null then
    raise exception 'Actual 114 and 173 provenance predecessors are required' using errcode='55000';
  end if;
end;
$guard$;

create function public.crm_qa_legacy_provenance_snapshot(
  p_auth_session uuid,p_source_receipt uuid,p_target_audit uuid,p_own_draft uuid
) returns jsonb
language plpgsql security invoker set search_path=pg_catalog,public as $function$
declare
  origin_workspace text:=current_setting('app.tenant_id',true);
  origin_actor text:=current_setting('app.actor_id',true);
  origin_identity uuid;
  source_row public.crm_command_receipts%rowtype;
  source_audit public.audit_logs%rowtype;
  target_audit public.audit_logs%rowtype;
  target_workspace uuid; target_project uuid; target_bot uuid; target_area uuid;
  target_actor uuid; target_identity uuid; target_role text; target_product text;
  workspace_hash text; member_hash text; project_hash text; bot_hash text;
  area_hash text; draft_hash text; settings_hash text;
  relations jsonb; result jsonb;
begin
  if origin_workspace is null or origin_actor is null
    or not public.crm_customer_provisioning_authorized(p_auth_session) then
    raise exception 'Current origin internal administration and MFA required' using errcode='42501';
  end if;
  -- The established helper holds the persisted session/member/identity locks.
  -- This additional contract requires actual DB MFA within fifteen minutes;
  -- DTO dates, email equality alone and a target-workspace UUID are not proof.
  select s.auth_identity_id into origin_identity from public.auth_sessions s
    where s.id=p_auth_session and s.workspace_id=origin_workspace::uuid
      and s.workspace_user_id=origin_actor::uuid
      and s.mfa_verified_at between clock_timestamp()-interval '15 minutes' and clock_timestamp();
  if origin_identity is null then
    raise exception 'Fresh origin MFA required' using errcode='42501';
  end if;
  select * into source_row from public.crm_command_receipts r
    where r.id=p_source_receipt and r.workspace_id=origin_workspace::uuid
      and r.actor_user_id=origin_actor::uuid and r.operation='customer.workspace.provision'
      and r.idempotency_key=r.correlation_id::text;
  if not found then raise exception 'Own original provisioning receipt required' using errcode='42501'; end if;
  select * into source_audit from public.audit_logs a
    where a.id=source_row.audit_reference and a.workspace_id=source_row.workspace_id
      and a.actor_user_id=source_row.actor_user_id and a.action='customer.workspace.provision'
      and a.entity_type='crm_command' and a.after->>'commandId'=source_row.id::text
      and a.after->>'correlationId'=source_row.correlation_id::text
      and a.after->>'requestHash'=source_row.request_hash;
  if not found then raise exception 'Original source audit binding required' using errcode='42501'; end if;
  target_workspace:=(source_row.response#>>'{workspace,id}')::uuid;
  target_project:=(source_row.response#>>'{project,id}')::uuid;
  target_bot:=(source_row.response#>>'{bot,id}')::uuid;
  target_area:=(source_row.response#>>'{knowledgeArea,id}')::uuid;
  if target_workspace is null or target_project is null or target_bot is null or target_area is null
    or target_workspace=origin_workspace::uuid
    or source_row.response#>>'{project,workspaceId}' is distinct from target_workspace::text
    or source_row.response#>>'{bot,workspaceId}' is distinct from target_workspace::text
    or source_row.response#>>'{bot,projectId}' is distinct from target_project::text
    or source_row.response#>>'{knowledgeArea,workspaceId}' is distinct from target_workspace::text
    or source_row.response#>>'{knowledgeArea,projectId}' is distinct from target_project::text then
    raise exception 'Complete original target binding required' using errcode='42501';
  end if;
  -- Authentication bootstrap already exposes memberships to the existing app.
  -- Resolve exactly one current membership of the SAME stored identity before
  -- deriving its target context; never accept a caller-selected target actor.
  select u.id into target_actor from public.workspace_users u
    where u.workspace_id=target_workspace and u.auth_identity_id=origin_identity
      and u.status='active' and u.role='admin' and u.product_role='workspace_admin';
  if target_actor is null or (select count(*) from public.workspace_users u
      where u.workspace_id=target_workspace and u.auth_identity_id=origin_identity and u.status='active')<>1 then
    raise exception 'Unique active original target identity required' using errcode='42501';
  end if;
  perform set_config('app.tenant_id',target_workspace::text,true),set_config('app.actor_id',target_actor::text,true);
  select m.auth_identity_id,m.role,m.product_role into target_identity,target_role,target_product
    from public.crm_lock_active_member(target_workspace,target_actor) m;
  if target_identity is distinct from origin_identity or target_role is distinct from 'admin'
    or target_product is distinct from 'workspace_admin'
    or not public.crm_lock_active_session(p_auth_session,origin_identity) then
    raise exception 'Current target ownership required' using errcode='42501';
  end if;
  select * into target_audit from public.audit_logs a
    where a.id=p_target_audit and a.workspace_id=target_workspace
      and a.actor_user_id=target_actor and a.project_id=target_project
      and a.action='customer.workspace.provisioned' and a.entity_type='workspace'
      and a.entity_id=target_workspace and a.after->>'requestId'=source_row.idempotency_key
      and a.after->>'projectId'=target_project::text and a.after->>'botId'=target_bot::text
      and a.after->>'knowledgeAreaId'=target_area::text
      and a.after->>'membershipRole'='workspace_admin';
  if not found then raise exception 'Matching immutable target provisioning audit required' using errcode='42501'; end if;
  if not public.crm_project_access(target_workspace,target_project,true) then
    raise exception 'Current target project authority required' using errcode='42501';
  end if;
  -- Hash only; never return personal draft, bot configuration, account secrets,
  -- settings values or content. Ordinary forced RLS remains in force.
  select encode(sha256(convert_to(to_jsonb(w)::text,'UTF8')),'hex') into workspace_hash
    from public.workspaces w where w.id=target_workspace and not w.is_qa;
  select encode(sha256(convert_to(jsonb_build_object('id',u.id,'workspaceId',u.workspace_id,
    'identityId',u.auth_identity_id,'role',u.role,'productRole',u.product_role,'status',u.status)::text,'UTF8')),'hex')
    into member_hash from public.workspace_users u where u.id=target_actor and u.workspace_id=target_workspace;
  select encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') into project_hash
    from public.projects p where p.id=target_project and p.workspace_id=target_workspace for share;
  select encode(sha256(convert_to(to_jsonb(b)::text,'UTF8')),'hex') into bot_hash
    from public.bots b where b.id=target_bot and b.workspace_id=target_workspace and b.project_id=target_project for share;
  select encode(sha256(convert_to(to_jsonb(a)::text,'UTF8')),'hex') into area_hash
    from public.knowledge_areas a where a.id=target_area and a.workspace_id=target_workspace and a.project_id=target_project for share;
  select encode(sha256(convert_to(to_jsonb(d)::text,'UTF8')),'hex') into draft_hash
    from public.crm_property_creation_drafts d where d.id=p_own_draft and d.workspace_id=target_workspace
      and d.user_id=target_actor and d.project_id=target_project and d.status='active' for share;
  if workspace_hash is null or member_hash is null or project_hash is null or bot_hash is null
    or area_hash is null or draft_hash is null then
    raise exception 'Exact current original objects and own active draft required' using errcode='42501';
  end if;
  select encode(sha256(convert_to(coalesce(jsonb_agg(to_jsonb(s) order by s.module_key),'[]'::jsonb)::text,'UTF8')),'hex')
    into settings_hash from public.workspace_module_settings s where s.workspace_id=target_workspace;
  -- Metadata is an explicit list of UNPROVEN scopes, not row counts or a new
  -- privileged inventory. Even the hashed known rows do not prove absence of
  -- additional same-tenant, project-restricted or private resources.
  select coalesce(jsonb_agg(jsonb_build_object('relation',n.nspname||'.'||c.relname,
    'rls',c.relrowsecurity,'forced',c.relforcerowsecurity,
    'schemaDigest',encode(sha256(convert_to(jsonb_build_object(
      'columns',(select jsonb_agg(jsonb_build_object('name',a.attname,'type',a.atttypid,'typmod',a.atttypmod,'notNull',a.attnotnull) order by a.attnum) from pg_attribute a where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped),
      'constraints',(select jsonb_agg(pg_get_constraintdef(k.oid) order by k.conname) from pg_constraint k where k.conrelid=c.oid),
      'policies',(select jsonb_agg(jsonb_build_object('name',p.polname,'roles',p.polroles,'command',p.polcmd,'permissive',p.polpermissive,'using',pg_get_expr(p.polqual,p.polrelid),'check',pg_get_expr(p.polwithcheck,p.polrelid)) order by p.polname) from pg_policy p where p.polrelid=c.oid),
      'acl',c.relacl::text)::text,'UTF8')),'hex')) order by n.nspname,c.relname),'[]'::jsonb)
    into relations from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relkind in ('r','p') and exists(
      select 1 from pg_attribute a where a.attrelid=c.oid and a.attname='workspace_id' and not a.attisdropped);
  result:=jsonb_build_object('version','qa-legacy-provenance-v1','originWorkspaceId',origin_workspace,
    'originActorId',origin_actor,'sourceReceiptId',p_source_receipt,'sourceAuditId',source_audit.id,
    'targetAuditId',p_target_audit,'provisionRequestId',source_row.idempotency_key,
    'targetIds',jsonb_build_object('workspace',target_workspace,'project',target_project,'bot',target_bot,
      'knowledgeArea',target_area,'membership',target_actor,'ownDraft',p_own_draft),
    'stateDigests',jsonb_build_object('sourceReceipt',encode(sha256(convert_to(to_jsonb(source_row)::text,'UTF8')),'hex'),
      'sourceAudit',encode(sha256(convert_to(to_jsonb(source_audit)::text,'UTF8')),'hex'),
      'targetAudit',encode(sha256(convert_to(to_jsonb(target_audit)::text,'UTF8')),'hex'),
      'workspace',workspace_hash,'membership',member_hash,'project',project_hash,'bot',bot_hash,
      'knowledgeArea',area_hash,'ownDraft',draft_hash,'moduleSettings',settings_hash),
    'unprovenRelations',relations,'completeVisibility',false,'classificationAllowed',false,
    'externalResourceVisibility','NOT_PROVEN','settingsRestoreBaseline','NOT_PROVEN');
  perform set_config('app.tenant_id',origin_workspace,true),set_config('app.actor_id',origin_actor,true);
  return result;
exception when others then
  perform set_config('app.tenant_id',coalesce(origin_workspace,''),true),set_config('app.actor_id',coalesce(origin_actor,''),true);
  raise;
end;
$function$;

revoke all on function public.crm_qa_legacy_provenance_snapshot(uuid,uuid,uuid,uuid) from public;
do $acl$
begin
  if exists(select 1 from pg_roles where rolname='novalure_app') then
    revoke all on function public.crm_qa_legacy_provenance_snapshot(uuid,uuid,uuid,uuid) from novalure_app;
  end if;
end;
$acl$;
grant execute on function public.crm_qa_legacy_provenance_snapshot(uuid,uuid,uuid,uuid) to novalure_tenant_app;
comment on function public.crm_qa_legacy_provenance_snapshot(uuid,uuid,uuid,uuid) is
  'SECURITY INVOKER exact double-provenance snapshot under existing runtime RLS. Never changes QA flags, creates batches, retires workspaces or changes accounts. Incomplete visibility always leaves classification closed.';
