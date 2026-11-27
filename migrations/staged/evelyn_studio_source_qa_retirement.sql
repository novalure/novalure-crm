-- Additive LongFog Preview support only. Creates no retirement, activation or grant.
set local lock_timeout = '5s';
set local statement_timeout = '2min';
do $guard$
declare r pg_roles;
begin
  select * into strict r from pg_roles where rolname=current_user;
  if r.rolcanlogin or r.rolsuper or r.rolbypassrls or r.rolcreatedb or r.rolcreaterole or r.rolreplication
    or pg_has_role('novalure_app',r.oid,'MEMBER') or pg_has_role('novalure_tenant_app',r.oid,'MEMBER')
    or current_database()<>'neondb' or current_setting('neon.project_id',true) is distinct from 'long-fog-84900593'
    or current_setting('neon.branch_id',true) is distinct from 'br-summer-mountain-bh7w67e3'
    or not exists(select 1 from pg_class where oid='public.studio_enquiry_transfers'::regclass and relowner=r.oid)
    or not exists(select 1 from pg_class where oid='public.crm_studio_source_grants'::regclass and relowner=r.oid)
    or to_regprocedure('public.crm_reject_immutable_mutation()') is null
    or not has_function_privilege(current_user,'public.crm_reject_immutable_mutation()','EXECUTE')
    or to_regclass('public.audit_logs') is null
    or not exists(select 1 from pg_trigger where tgrelid='public.audit_logs'::regclass and not tgisinternal
      and tgenabled in ('O','A') and tgtype=58 and tgfoid=to_regprocedure('public.reject_audit_logs_mutation()'))
    or to_regclass('public.crm_studio_source_qa_retirements') is not null
    or to_regprocedure('public.crm_studio_preview_source_transfer_matches_before_qa_retirement(uuid,text,text,uuid,uuid,uuid,integer,text,uuid,uuid)') is not null
    or not exists(select 1 from pg_proc where oid=to_regprocedure('public.crm_studio_preview_source_transfer_matches(uuid,text,text,uuid,uuid,uuid,integer,text,uuid,uuid)')
      and proowner=r.oid and prosecdef and prokind='f' and proconfig=array['search_path=pg_catalog, public']
      and encode(sha256(convert_to(replace(prosrc,E'\r\n',E'\n'),'UTF8')),'hex')='834ef626acc6ee78f4dfbad9b379649b802ccde2bac699e4eec9a8a86899a4c6')
  then raise exception 'STUDIO_QA_RETIREMENT_INSTALLER_BOUNDARY' using errcode='42501'; end if;
end
$guard$;

create table public.crm_studio_source_qa_retirements (
  operation_id uuid primary key,
  workspace_id uuid not null check(workspace_id='8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101'),
  crm_project_id uuid not null check(crm_project_id='f7d83c6b-d08d-4d73-b822-1f1c0b4733d2'),
  revision integer not null check(revision>0), payload_hash text not null check(payload_hash~'^[a-f0-9]{64}$'),
  lead_id uuid not null, submission_id uuid not null, source_seq bigint not null check(source_seq>0),
  accepted_at timestamptz not null, original_grant_id uuid not null references public.crm_studio_source_grants(id),
  plan jsonb not null, audit_reference uuid not null unique,
  retired_at timestamptz not null default clock_timestamp(),
  operator_session text not null default session_user,
  operator_role text not null default current_user
);
alter table public.crm_studio_source_qa_retirements enable row level security;
alter table public.crm_studio_source_qa_retirements force row level security;
do $policy$
begin
  execute format('create policy studio_source_qa_retirement_owner on public.crm_studio_source_qa_retirements to %I using (true) with check (true)',current_user);
end
$policy$;
revoke all on public.crm_studio_source_qa_retirements from public,novalure_app,novalure_tenant_app;
create trigger studio_source_qa_retirement_immutable before update or delete or truncate
  on public.crm_studio_source_qa_retirements for each statement execute function public.crm_reject_immutable_mutation();

create function public.crm_studio_source_qa_retirement_insert() returns trigger
language plpgsql set search_path=pg_catalog,public as $body$
declare p jsonb:=new.plan; t public.studio_enquiry_transfers; g public.crm_studio_source_grants; marker jsonb;
begin
  if session_user<>'neondb_owner' or current_user<>'neondb_owner'
    or new.operator_session<>session_user or new.operator_role<>current_user
    or current_database()<>'neondb' or current_setting('neon.project_id',true) is distinct from 'long-fog-84900593'
    or current_setting('neon.branch_id',true) is distinct from 'br-summer-mountain-bh7w67e3'
  then raise exception 'STUDIO_QA_RETIREMENT_OPERATOR_TARGET' using errcode='42501'; end if;
  -- Existing SOURCE-owner receipt RLS binds the tenant, not a human actor.
  perform set_config('app.tenant_id','8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101',true);
  if not pg_try_advisory_xact_lock(941041) then raise exception 'STUDIO_QA_RETIREMENT_SLOT_BUSY' using errcode='42501'; end if;
  perform pg_advisory_xact_lock(hashtextextended('studio-enquiry-media-quota:8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101',0));
  -- A row locking SELECT would require an UPDATE RLS policy. Keep receipt
  -- SELECT-only access and stop rather than wait on an existing intake writer.
  lock table public.studio_enquiry_transfers in share mode nowait;
  lock table public.crm_studio_source_grants in share row exclusive mode;
  if jsonb_typeof(p) is distinct from 'object' or
    (select array_agg(k order by k) from jsonb_object_keys(p) k) is distinct from
      array['authoritySha256','hostScopeDecision','hostScopeDecisionSha256','originalGrant','provenanceSha256','qaRunPrefix','receiver','tuple']::text[]
    or jsonb_typeof(p->'tuple') is distinct from 'object' or
      (select array_agg(k order by k) from jsonb_object_keys(p->'tuple') k) is distinct from
      array['acceptedAt','crmProjectId','leadId','operationId','payloadHash','revision','sourceSeq','submissionId','workspaceId']::text[]
    or jsonb_typeof(p->'originalGrant') is distinct from 'object' or
      (select array_agg(k order by k) from jsonb_object_keys(p->'originalGrant') k) is distinct from array['deploymentId','id','revision']::text[]
    or jsonb_typeof(p->'receiver') is distinct from 'object' or
      (select array_agg(k order by k) from jsonb_object_keys(p->'receiver') k) is distinct from array['deploymentId','revision']::text[]
    or not coalesce(p->>'qaRunPrefix'~'^GOLIVETEST_[A-Za-z0-9_-]{6,65}$',false)
    or not coalesce(p->>'provenanceSha256'~'^[a-f0-9]{64}$' and p->>'authoritySha256'~'^[a-f0-9]{64}$'
      and p->>'hostScopeDecisionSha256'~'^[a-f0-9]{64}$',false)
    or p->>'hostScopeDecision' is distinct from 'RETIRE_OWN_QA_NO_PENDING_PROMOTION'
    or jsonb_typeof(p->'tuple'->'sourceSeq') is distinct from 'string'
    or not coalesce(p->'tuple'->>'sourceSeq'~'^[1-9][0-9]{0,18}$',false)
    or not coalesce(p->'tuple'->>'acceptedAt'~'^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?Z$',false)
    or not coalesce(p->'receiver'->>'deploymentId'~'^dpl_[A-Za-z0-9]+$' and p->'receiver'->>'revision'~'^[a-f0-9]{40}$',false)
  then raise exception 'STUDIO_QA_RETIREMENT_EXACT_PLAN' using errcode='42501'; end if;
  if row(new.operation_id,new.workspace_id,new.crm_project_id,new.revision,new.payload_hash,new.lead_id,new.submission_id,new.source_seq,new.accepted_at,new.original_grant_id)
    is distinct from row((p->'tuple'->>'operationId')::uuid,(p->'tuple'->>'workspaceId')::uuid,(p->'tuple'->>'crmProjectId')::uuid,
      (p->'tuple'->>'revision')::integer,p->'tuple'->>'payloadHash',(p->'tuple'->>'leadId')::uuid,(p->'tuple'->>'submissionId')::uuid,
      (p->'tuple'->>'sourceSeq')::bigint,(p->'tuple'->>'acceptedAt')::timestamptz,(p->'originalGrant'->>'id')::uuid)
  then raise exception 'STUDIO_QA_RETIREMENT_PLAN_TUPLE' using errcode='42501'; end if;
  if not exists(select 1 from public.crm_studio_source_activation where profile='preview'
    and database_project='long-fog-84900593' and database_branch='br-summer-mountain-bh7w67e3' and new.source_seq>starts_after)
    or exists(select 1 from public.crm_studio_source_grants where revoked_at is null and expires_at>clock_timestamp())
  then raise exception 'STUDIO_QA_RETIREMENT_CONSUMER_NOT_QUIET' using errcode='42501'; end if;
  select * into t from public.studio_enquiry_transfers where operation_id=new.operation_id;
  select * into g from public.crm_studio_source_grants where id=new.original_grant_id for share;
  if t.state is distinct from 'accepted' or t.snapshot_text::jsonb->'syntheticTest' is distinct from 'false'::jsonb
    or row(t.workspace_id,t.revision,t.payload_hash,t.lead_id,t.submission_id,t.source_seq,t.accepted_at)
      is distinct from row(new.workspace_id,new.revision,new.payload_hash,new.lead_id,new.submission_id,new.source_seq,new.accepted_at)
    or g.profile is distinct from 'preview' or g.workload_id is not null or g.revoked_at is null
    or g.workspace_id is distinct from new.workspace_id or g.crm_project_id is distinct from new.crm_project_id
    or g.receiver_project is distinct from 'prj_R32Okl6AHijTohvuKmryuTLjWMsk'
    or g.deployment_id is distinct from p->'originalGrant'->>'deploymentId' or g.revision is distinct from p->'originalGrant'->>'revision'
    or g.authority_reference is distinct from (p->>'qaRunPrefix')||' own synthetic SOURCE read'
  then raise exception 'STUDIO_QA_RETIREMENT_ORIGINAL_CONFLICT' using errcode='42501'; end if;
  marker:=jsonb_build_object('qaRunPrefix',p->>'qaRunPrefix','isolatedProductionShapedFixture',true,'productionCustomerTransfer',false);
  if not exists(select 1 from public.leads l join public.form_submissions s on s.workspace_id=l.workspace_id and s.lead_id=l.id
    where l.id=new.lead_id and l.workspace_id=new.workspace_id and l.project_id=new.crm_project_id and l.metadata@>marker
      and s.id=new.submission_id and s.project_id=new.crm_project_id and s.form_id='0f98b9fd-d300-4a34-a14c-54a1a61b2415'
      and s.mode='live' and s.raw_payload@>marker)
  then raise exception 'STUDIO_QA_RETIREMENT_OWNERSHIP_UNPROVEN' using errcode='42501'; end if;
  if not exists(select 1 from public.audit_logs a where a.id=new.audit_reference and a.workspace_id=new.workspace_id
    and a.xmin::text=(mod(pg_current_xact_id()::text::numeric,4294967296))::text
    and a.project_id=new.crm_project_id and a.actor_user_id is null and a.action='studio.source.qa.retire'
    and a.entity_type='studio_source_qa_retirement' and a.entity_id=new.operation_id
    and a.after=jsonb_build_object('actor',jsonb_build_object('type','DATABASE_OPERATOR','sessionUser',session_user,'databaseRole',current_user),
      'decision','OWN_SOURCE_QA_RETIRED','plan',p))
  then raise exception 'STUDIO_QA_RETIREMENT_OPERATOR_AUDIT_REQUIRED' using errcode='42501'; end if;
  new.retired_at:=clock_timestamp();
  return new;
end
$body$;
create trigger studio_source_qa_retirement_insert before insert on public.crm_studio_source_qa_retirements
  for each row execute function public.crm_studio_source_qa_retirement_insert();

-- INVOKER is deliberate: the real technical operator owns its existing audit
-- authority. Neither a fake human session nor runtime definer write access exists.
create function public.crm_retire_studio_source_qa(p_plan jsonb) returns uuid
language plpgsql security invoker set search_path=pg_catalog,public as $body$
declare original public.crm_studio_source_qa_retirements; audit_id uuid:=gen_random_uuid(); operation uuid;
begin
  if session_user<>'neondb_owner' or current_user<>'neondb_owner'
    or current_database()<>'neondb' or current_setting('neon.project_id',true) is distinct from 'long-fog-84900593'
    or current_setting('neon.branch_id',true) is distinct from 'br-summer-mountain-bh7w67e3'
    or not has_table_privilege(current_user,'public.audit_logs','INSERT') or not has_table_privilege(current_user,'public.audit_logs','SELECT')
    or not has_table_privilege(current_user,'public.leads','SELECT') or not has_table_privilege(current_user,'public.form_submissions','SELECT')
  then raise exception 'STUDIO_QA_RETIREMENT_OPERATOR_TARGET' using errcode='42501'; end if;
  perform set_config('app.tenant_id','8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101',true);
  if not pg_try_advisory_xact_lock(941041) then raise exception 'STUDIO_QA_RETIREMENT_SLOT_BUSY' using errcode='42501'; end if;
  perform pg_advisory_xact_lock(hashtextextended('studio-enquiry-media-quota:8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101',0));
  lock table public.studio_enquiry_transfers in share mode nowait;
  lock table public.crm_studio_source_grants in share row exclusive mode;
  operation:=(p_plan->'tuple'->>'operationId')::uuid;
  select * into original from public.crm_studio_source_qa_retirements where operation_id=operation;
  if found then
    if original.plan is distinct from p_plan then raise exception 'STUDIO_QA_RETIREMENT_CONFLICT' using errcode='42501'; end if;
    return original.audit_reference;
  end if;
  insert into public.audit_logs(id,workspace_id,project_id,actor_user_id,action,entity_type,entity_id,after)
    values(audit_id,(p_plan->'tuple'->>'workspaceId')::uuid,(p_plan->'tuple'->>'crmProjectId')::uuid,null,
      'studio.source.qa.retire','studio_source_qa_retirement',operation,
      jsonb_build_object('actor',jsonb_build_object('type','DATABASE_OPERATOR','sessionUser',session_user,'databaseRole',current_user),
        'decision','OWN_SOURCE_QA_RETIRED','plan',p_plan));
  insert into public.crm_studio_source_qa_retirements(operation_id,workspace_id,crm_project_id,revision,payload_hash,lead_id,submission_id,
    source_seq,accepted_at,original_grant_id,plan,audit_reference)
    values(operation,(p_plan->'tuple'->>'workspaceId')::uuid,(p_plan->'tuple'->>'crmProjectId')::uuid,(p_plan->'tuple'->>'revision')::integer,
      p_plan->'tuple'->>'payloadHash',(p_plan->'tuple'->>'leadId')::uuid,(p_plan->'tuple'->>'submissionId')::uuid,
      (p_plan->'tuple'->>'sourceSeq')::bigint,(p_plan->'tuple'->>'acceptedAt')::timestamptz,(p_plan->'originalGrant'->>'id')::uuid,p_plan,audit_id);
  return audit_id;
end
$body$;

create function public.crm_studio_source_qa_retired(p_workspace uuid,p_operation uuid,p_revision integer,p_hash text,p_lead uuid,p_submission uuid)
returns boolean language plpgsql stable security definer set search_path=pg_catalog,public as $body$
begin
  if session_user<>'novalure_app' or current_database()<>'neondb'
    or current_setting('neon.project_id',true) is distinct from 'long-fog-84900593'
    or current_setting('neon.branch_id',true) is distinct from 'br-summer-mountain-bh7w67e3'
    or p_workspace is distinct from '8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101'::uuid
    or p_workspace is distinct from nullif(current_setting('app.tenant_id',true),'')::uuid
    or nullif(current_setting('app.actor_id',true),'') is null
  then raise exception 'STUDIO_QA_RETIREMENT_READ_SCOPE' using errcode='42501'; end if;
  return exists(select 1 from public.crm_studio_source_qa_retirements r where r.workspace_id=p_workspace
    and r.operation_id=p_operation and r.revision=p_revision and r.payload_hash=p_hash and r.lead_id=p_lead and r.submission_id=p_submission);
end
$body$;

-- Keep the original guarded matcher intact as an owner-only implementation.
alter function public.crm_studio_preview_source_transfer_matches(uuid,text,text,uuid,uuid,uuid,integer,text,uuid,uuid)
  rename to crm_studio_preview_source_transfer_matches_before_qa_retirement;
revoke all on function public.crm_studio_preview_source_transfer_matches_before_qa_retirement(uuid,text,text,uuid,uuid,uuid,integer,text,uuid,uuid)
  from public,novalure_app,novalure_tenant_app;
create function public.crm_studio_preview_source_transfer_matches(
  p_grant uuid,p_deployment text,p_revision text,p_workspace uuid,p_project uuid,
  p_operation uuid,p_revision_number integer,p_payload_hash text,p_lead uuid,p_submission uuid
) returns boolean language plpgsql volatile security definer set search_path=pg_catalog,public as $body$
begin
  if not public.crm_studio_preview_source_transfer_matches_before_qa_retirement(p_grant,p_deployment,p_revision,p_workspace,p_project,
    p_operation,p_revision_number,p_payload_hash,p_lead,p_submission) then return false; end if;
  return not public.crm_studio_source_qa_retired(p_workspace,p_operation,p_revision_number,p_payload_hash,p_lead,p_submission);
end
$body$;
revoke all on function public.crm_studio_source_qa_retirement_insert(),public.crm_retire_studio_source_qa(jsonb),
  public.crm_studio_source_qa_retired(uuid,uuid,integer,text,uuid,uuid),
  public.crm_studio_preview_source_transfer_matches(uuid,text,text,uuid,uuid,uuid,integer,text,uuid,uuid)
  from public,novalure_app,novalure_tenant_app;
grant execute on function public.crm_retire_studio_source_qa(jsonb) to neondb_owner;
grant execute on function public.crm_studio_source_qa_retired(uuid,uuid,integer,text,uuid,uuid),
  public.crm_studio_preview_source_transfer_matches(uuid,text,text,uuid,uuid,uuid,integer,text,uuid,uuid) to novalure_tenant_app;
