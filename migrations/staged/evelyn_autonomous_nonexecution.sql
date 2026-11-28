-- Manual successor of all four autonomous stages. Installs no authority/key.
-- The bounded NOLOGIN installer additionally owns crm_command_receipts so its
-- trigger fences old handlers; no runtime membership or business data grant.
set local lock_timeout='5s';
set local statement_timeout='14min';
do $guard$ declare r record; begin
 select * into r from pg_roles where rolname=current_user;
 if r.rolcanlogin or r.rolsuper or r.rolbypassrls or r.rolcreatedb or r.rolcreaterole or r.rolreplication
  or not exists(select 1 from pg_class where oid='public.crm_command_receipts'::regclass and relowner=r.oid)
  or not exists(select 1 from pg_class where oid='public.crm_autonomous_access_grants'::regclass and relowner=r.oid)
  or to_regclass('public.crm_autonomous_business_consumptions') is null then
  raise exception 'NONEXECUTION_INSTALLER_BOUNDARY' using errcode='42501'; end if;
end $guard$;

create function public.crm_recovery_key_bytes(p text) returns bytea
language sql immutable strict set search_path=pg_catalog as $f$ select decode(translate(p,'-_','+/')||'=','base64') $f$;
create function public.crm_recovery_key_canonical(p text) returns boolean
language sql immutable strict set search_path=pg_catalog,public as $f$
 select p ~ '^[A-Za-z0-9_-]{59}$' and octet_length(public.crm_recovery_key_bytes(p))=44
  and substring(public.crm_recovery_key_bytes(p) from 1 for 12)=decode('302a300506032b6570032100','hex')
  and translate(rtrim(encode(public.crm_recovery_key_bytes(p),'base64'),'='),'+/','-_')=p
$f$;

create table public.crm_autonomous_recovery_authorities(
 id uuid primary key,workload_id uuid not null references public.crm_autonomous_workloads,
 control_project_id uuid not null,grant_ids uuid[] not null check(cardinality(grant_ids) between 1 and 4096),
 recovery_public_key text not null check(public.crm_recovery_key_canonical(recovery_public_key)),
 authority_reference text not null check(length(trim(authority_reference)) between 1 and 200),
 not_before timestamptz not null default clock_timestamp(),expires_at timestamptz not null,
 revoked_at timestamptz,disabled boolean not null default false,
 check(expires_at>not_before)
);
create function public.crm_recovery_registration_scope() returns trigger
language plpgsql security definer set search_path=pg_catalog,public as $f$ declare signer text; begin
 if tg_table_name='crm_autonomous_recovery_authorities' then signer:=new.recovery_public_key;else signer:=new.delegation_public_key;end if;
 if not public.crm_recovery_key_canonical(signer) then raise exception 'RECOVERY_AUTHORITY_SCOPE_INVALID' using errcode='42501'; end if;
 perform pg_advisory_xact_lock(hashtextextended('crm-recovery-key:'||encode(sha256(public.crm_recovery_key_bytes(signer)),'hex'),0));
 if tg_table_name='crm_autonomous_recovery_authorities' then
  if exists(select 1 from unnest(new.grant_ids) as bound(grant_id) left join public.crm_autonomous_access_grants g on g.id=bound.grant_id
    where g.id is null or g.workload_id<>new.workload_id or g.contract_version<>'crm-autonomous-access-v2')
   or exists(select 1 from public.crm_autonomous_access_grants g where public.crm_recovery_key_bytes(g.delegation_public_key)=public.crm_recovery_key_bytes(new.recovery_public_key))
   then raise exception 'RECOVERY_AUTHORITY_SCOPE_INVALID' using errcode='42501'; end if;
 else
  if exists(select 1 from public.crm_autonomous_recovery_authorities a where public.crm_recovery_key_bytes(a.recovery_public_key)=public.crm_recovery_key_bytes(new.delegation_public_key))
   then raise exception 'DEPARTMENT_RECOVERY_KEY_COLLISION' using errcode='42501'; end if;
 end if;return new;
end $f$;
create trigger recovery_authority_scope before insert on public.crm_autonomous_recovery_authorities for each row execute function public.crm_recovery_registration_scope();
create trigger department_recovery_key_scope before insert on public.crm_autonomous_access_grants for each row execute function public.crm_recovery_registration_scope();
create trigger recovery_authority_immutable before update on public.crm_autonomous_recovery_authorities for each row execute function public.crm_autonomous_registration_immutable();

create table public.crm_autonomous_nonexecution_closures(
 id uuid primary key default gen_random_uuid(),workspace_id uuid not null,
 idempotency_key text not null check(idempotency_key ~* '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'),grant_id uuid not null references public.crm_autonomous_access_grants,
 operation text not null,correlation_id uuid not null,request_hash text not null check(request_hash ~ '^[a-f0-9]{64}$'),
 binding jsonb not null check(jsonb_typeof(binding)='object'),
 outcome text not null check(outcome in('NO_EFFECT','APPLIED')),
 audit_reference uuid not null,created_by uuid not null references public.crm_autonomous_recovery_authorities,
 created_at timestamptz not null default clock_timestamp(),unique(workspace_id,idempotency_key)
);
create table public.crm_autonomous_recovery_events(
 authority_id uuid not null references public.crm_autonomous_recovery_authorities,
 nonce uuid not null,closure_reference uuid not null references public.crm_autonomous_nonexecution_closures,
 oidc_jti_hash text not null check(oidc_jti_hash ~ '^[a-f0-9]{64}$'),
 created_at timestamptz not null default clock_timestamp(),primary key(authority_id,nonce)
);
do $policies$ declare t text; begin
 foreach t in array array['crm_autonomous_recovery_authorities','crm_autonomous_nonexecution_closures','crm_autonomous_recovery_events'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('alter table public.%I force row level security',t);
  execute format('create policy nonexecution_owner on public.%I to %I using(true) with check(true)',t,current_user);
  execute format('revoke all on public.%I from public,novalure_app,novalure_tenant_app',t);
 end loop;
 foreach t in array array['crm_autonomous_nonexecution_closures','crm_autonomous_recovery_events'] loop
  execute format('create trigger nonexecution_immutable before update or delete or truncate on public.%I for each statement execute function public.crm_reject_immutable_mutation()',t);
 end loop;
 -- Only the protected NOLOGIN definer may inspect original receipt metadata.
 execute format('create policy nonexecution_receipt_owner on public.crm_command_receipts for select to %I using(workspace_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',current_user);
 execute format('create policy nonexecution_event_owner on public.crm_autonomous_access_events for select to %I using(workspace_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',current_user);
end $policies$;

create function public.crm_lookup_autonomous_recovery(p_workload uuid,p_authority uuid,p_grant uuid,p_control uuid)
returns table(authority_id uuid,workload_id uuid,recovery_key text,grant_id uuid,workspace_id uuid,actor_user_id uuid,
 project_id uuid,source_id uuid,entity text,department_id text,agent_id text,task_id uuid,control_project_id uuid)
language sql stable security definer set search_path=pg_catalog,public as $f$
 select a.id,w.id,a.recovery_public_key,g.id,g.workspace_id,g.actor_user_id,g.project_id,g.source_id,g.entity,g.department_id,g.agent_id,g.task_id,a.control_project_id
 from public.crm_autonomous_recovery_authorities a join public.crm_autonomous_workloads w on w.id=a.workload_id
 join public.crm_autonomous_access_grants g on g.workload_id=w.id and g.id=p_grant and g.id=any(a.grant_ids) and g.workspace_id=w.workspace_id
 join public.workspace_users actor on actor.id=w.actor_user_id and actor.workspace_id=w.workspace_id
 join public.workspaces workspace on workspace.id=w.workspace_id
 where w.id=p_workload and a.id=p_authority and a.control_project_id=p_control
  and g.contract_version='crm-autonomous-access-v2'
  and w.environment='production' and w.identity_id='EVELYN_CRM_AUTONOMOUS_INTERNAL_IDENTITY'
  and not w.disabled and not w.kill_switch_active and w.revoked_at is null and w.not_before<=clock_timestamp() and (w.expires_at is null or w.expires_at>clock_timestamp())
  and not a.disabled and a.revoked_at is null and a.not_before<=clock_timestamp() and a.expires_at>clock_timestamp()
  and actor.status='active' and actor.role='agent' and actor.product_role='novalure_operator' and workspace.operating_model='novalure_internal'
$f$;
create function public.crm_lock_autonomous_recovery(p_workload uuid,p_authority uuid,p_grant uuid,p_control uuid)
returns boolean language plpgsql volatile security definer set search_path=pg_catalog,public as $f$ begin
 perform w.id from public.crm_autonomous_workloads w join public.workspace_users actor on actor.id=w.actor_user_id and actor.workspace_id=w.workspace_id
 join public.workspaces workspace on workspace.id=w.workspace_id where w.id=p_workload for share of w,actor,workspace;
 perform id from public.crm_autonomous_recovery_authorities where id=p_authority for share;
 return exists(select 1 from public.crm_lookup_autonomous_recovery(p_workload,p_authority,p_grant,p_control));
end $f$;

create function public.crm_assert_autonomous_command_open(p_workspace uuid,p_key text) returns void
language plpgsql volatile security definer set search_path=pg_catalog,public as $f$ begin
 if p_workspace is distinct from nullif(current_setting('app.tenant_id',true),'')::uuid then raise exception 'ACCESS_DENIED' using errcode='42501'; end if;
 perform pg_advisory_xact_lock(hashtextextended('crm-command:'||p_workspace::text||':'||p_key,0));
 if exists(select 1 from public.crm_autonomous_nonexecution_closures where workspace_id=p_workspace and idempotency_key=p_key and outcome='NO_EFFECT') then
  raise exception 'COMMAND_CLOSED_WITHOUT_EFFECT' using errcode='42501'; end if;
end $f$;
create function public.crm_receipt_nonexecution_guard() returns trigger
language plpgsql security definer set search_path=pg_catalog,public as $f$ begin
 perform public.crm_assert_autonomous_command_open(new.workspace_id,new.idempotency_key);return new;
end $f$;
create trigger crm_receipt_nonexecution_guard before insert on public.crm_command_receipts for each row execute function public.crm_receipt_nonexecution_guard();

create function public.crm_close_autonomous_nonexecution(p_workload uuid,p_authority uuid,b jsonb,body jsonb,p_hash text,p_nonce uuid,p_jti text)
returns jsonb language plpgsql volatile security definer set search_path=pg_catalog,public as $f$
declare g record; r record; c public.crm_autonomous_nonexecution_closures; replay boolean:=false; expected_action text; k text; op text;
begin
 if jsonb_typeof(b) is distinct from 'object' or jsonb_typeof(body) is distinct from 'object'
  or (select array_agg(key order by key) from jsonb_object_keys(b) key) is distinct from
   array['agentId','artifactDigest','attemptId','controlProjectId','crmProjectId','departmentId','effectId','entity','grantId','missionId','registryVersion','requestDigest','sourceId','targetDigest','taskId','workspaceId']::text[]
  or (select array_agg(key order by key) from jsonb_object_keys(body) key) is distinct from
   array['contractVersion','correlationId','expectedVersion','idempotencyKey','operation','patch']::text[]
  or exists(select 1 from unnest(array['grantId','workspaceId','sourceId','taskId','crmProjectId','controlProjectId','missionId','attemptId','effectId']) field where coalesce(b->>field,'') !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$')
  or coalesce(b->>'registryVersion','') !~ '^[1-9][0-9]{0,17}$'
  or coalesce(b->>'targetDigest','') !~ '^[a-f0-9]{64}$' or coalesce(b->>'artifactDigest','') !~ '^[a-f0-9]{64}$'
  or b->>'requestDigest' is distinct from p_hash or coalesce(p_hash,'') !~ '^[a-f0-9]{64}$' or coalesce(p_jti,'') !~ '^[a-f0-9]{64}$'
  or body->>'contractVersion' is distinct from 'crm-autonomous-access-v2'
  or jsonb_typeof(body->'patch') is distinct from 'object'
  or coalesce(body->>'correlationId','') !~* '^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
  or coalesce(body->>'idempotencyKey','') !~* '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
  or coalesce(body->>'operation','') not in('Create','Update','PrepareOffer','PrepareReservation','SendOffer','ConfirmReservation','ConfirmSale') then
  raise exception 'RECOVERY_BINDING_INVALID' using errcode='42501'; end if;
 -- Preserve the exact legacy text key, including accepted uppercase UUIDs.
 -- Normalizing only the fence would use a different lock/receipt identity.
 k:=body->>'idempotencyKey';op:=body->>'operation';
 -- Match ordinary execution: workload/authority locks precede the command
 -- lock. A queued revocation must not invert that order with a running writer.
 if not public.crm_lock_autonomous_recovery(p_workload,p_authority,(b->>'grantId')::uuid,(b->>'controlProjectId')::uuid) then
  raise exception 'RECOVERY_AUTHORITY_DENIED' using errcode='42501'; end if;
 perform pg_advisory_xact_lock(hashtextextended('crm-command:'||(b->>'workspaceId')||':'||k,0));
 select * into g from public.crm_lookup_autonomous_recovery(p_workload,p_authority,(b->>'grantId')::uuid,(b->>'controlProjectId')::uuid);
 if g.grant_id is null then raise exception 'RECOVERY_AUTHORITY_DENIED' using errcode='42501'; end if;
 if (g.workspace_id,g.actor_user_id) is distinct from(nullif(current_setting('app.tenant_id',true),'')::uuid,nullif(current_setting('app.actor_id',true),'')::uuid)
  or (b->>'workspaceId',b->>'crmProjectId',b->>'sourceId',b->>'taskId',b->>'entity',b->>'departmentId',b->>'agentId')
   is distinct from(g.workspace_id::text,g.project_id::text,g.source_id::text,g.task_id::text,g.entity,g.department_id,g.agent_id) then
  raise exception 'RECOVERY_BINDING_INVALID' using errcode='42501'; end if;
 if exists(select 1 from public.crm_autonomous_recovery_events where authority_id=p_authority and nonce=p_nonce) then raise exception 'NONCE_REPLAY' using errcode='23505'; end if;
 select * into c from public.crm_autonomous_nonexecution_closures where workspace_id=g.workspace_id and idempotency_key=k;
 if c.id is not null then
  if c.binding is distinct from b or c.operation<>op or c.correlation_id<>(body->>'correlationId')::uuid or c.request_hash<>p_hash then
   raise exception 'IDEMPOTENCY_CONFLICT' using errcode='23505'; end if;replay:=true;
 else
  -- Deliberately no SELECT of response/business projection and no mutable
  -- record/version/QC/approval requirement for historical metadata recovery.
  select id,workspace_id,project_id,actor_user_id,operation,resource_id,request_hash,audit_reference,correlation_id,data_classification,data_purpose into r
   from public.crm_command_receipts where workspace_id=g.workspace_id and idempotency_key=k;
  if r.id is not null then
   expected_action:='crm.'||case g.entity when 'Contact' then 'contacts' when 'Company' then 'companies' when 'Developer' then 'developers'
    when 'Project' then 'projects' when 'Unit' then 'units' when 'BuyerLead' then 'leads' when 'Qualification' then 'qualifications' when 'Offer' then 'offers'
    when 'Task' then 'tasks' when 'Appointment' then 'appointments' when 'Viewing' then 'viewings' when 'Reservation' then 'reservations' when 'Sale' then 'sales'
    when 'Communication' then 'communications' else 'approvals' end||'.'||case op when 'Create' then 'create' when 'Update' then 'write' when 'SendOffer' then 'send' when 'PrepareOffer' then 'prepare' when 'PrepareReservation' then 'prepare' else 'confirm' end;
   if (r.actor_user_id,r.project_id,r.resource_id,r.operation,r.correlation_id,r.data_classification,r.data_purpose)
     is distinct from(g.actor_user_id,g.project_id,g.source_id,'autonomous.module.'||lower(g.entity)||'.'||lower(op),(body->>'correlationId')::uuid,'NOVALURE_INTERNAL','crm_sales')
    or not exists(select 1 from public.crm_autonomous_access_events e where e.audit_reference=r.audit_reference and
      (e.grant_id,e.workspace_id,e.actor_user_id,e.department_id,e.agent_id,e.task_id,e.project_id,e.source_id,e.action,e.request_hash,e.outcome)=
      (g.grant_id,g.workspace_id,g.actor_user_id,g.department_id,g.agent_id,g.task_id,g.project_id,g.source_id,expected_action,p_hash,'SUCCESS'))
    or exists(select 1 from public.crm_autonomous_access_events e where e.audit_reference=r.audit_reference and
      (e.grant_id,e.workspace_id,e.actor_user_id,e.department_id,e.agent_id,e.task_id,e.project_id,e.source_id,e.action,e.request_hash,e.outcome) is distinct from
      (g.grant_id,g.workspace_id,g.actor_user_id,g.department_id,g.agent_id,g.task_id,g.project_id,g.source_id,expected_action,p_hash,'SUCCESS')) then
     raise exception 'IDEMPOTENCY_CONFLICT' using errcode='23505'; end if;
   c.outcome:='APPLIED';c.audit_reference:=r.audit_reference;replay:=true;
  else c.outcome:='NO_EFFECT';c.audit_reference:=gen_random_uuid();end if;
  insert into public.crm_autonomous_nonexecution_closures(workspace_id,idempotency_key,grant_id,operation,correlation_id,request_hash,binding,outcome,audit_reference,created_by)
   values(g.workspace_id,k,g.grant_id,op,(body->>'correlationId')::uuid,p_hash,b,c.outcome,c.audit_reference,p_authority) returning * into c;
 end if;
 insert into public.crm_autonomous_recovery_events(authority_id,nonce,closure_reference,oidc_jti_hash) values(p_authority,p_nonce,c.id,p_jti);
 return b||jsonb_build_object('contractVersion','crm-autonomous-access-v2','recoveryVersion','evelyn.crm-native-recovery.v1','recoveryAuthorityId',p_authority,'outcome',c.outcome,'auditReference',c.audit_reference,'closureReference',c.id,'replayed',replay);
end $f$;
revoke all on function public.crm_recovery_key_bytes(text),public.crm_recovery_key_canonical(text),public.crm_recovery_registration_scope(),public.crm_lookup_autonomous_recovery(uuid,uuid,uuid,uuid),public.crm_lock_autonomous_recovery(uuid,uuid,uuid,uuid),public.crm_assert_autonomous_command_open(uuid,text),public.crm_receipt_nonexecution_guard(),public.crm_close_autonomous_nonexecution(uuid,uuid,jsonb,jsonb,text,uuid,text) from public,novalure_app,novalure_tenant_app;
grant execute on function public.crm_lookup_autonomous_recovery(uuid,uuid,uuid,uuid),public.crm_lock_autonomous_recovery(uuid,uuid,uuid,uuid),public.crm_assert_autonomous_command_open(uuid,text),public.crm_close_autonomous_nonexecution(uuid,uuid,jsonb,jsonb,text,uuid,text) to novalure_tenant_app;
