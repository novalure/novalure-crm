-- Disposable, local synthetic QA only: not a migration and not a live receiver.
-- The case/source rows below are test doubles, not Evelyn authority.
do $$ begin
  if current_database() <> 'property_task_synthetic_qa' or session_user <> 'qa_admin'
    or inet_server_addr() is distinct from '127.0.0.1'::inet then
    raise exception 'PROPERTY_TASK_QA_ISOLATION_REQUIRED';
  end if;
end $$;

create schema property_task_qa;
revoke all on schema property_task_qa from public;
create table property_task_qa.authority (
  workspace_id uuid not null, project_id uuid not null, unit_id uuid not null,
  actor_id uuid not null, login name not null, case_id uuid not null,
  case_version bigint not null check(case_version > 0), generation bigint not null check(generation > 0),
  source_active boolean not null default false, stopped boolean not null default true,
  can_write boolean not null default false,
  primary key(workspace_id, project_id, case_id)
);
create table property_task_qa.receipts (
  workspace_id uuid not null, operation_id uuid not null, principal name not null,
  request jsonb not null, task_id uuid not null references public.tasks(id),
  audit_id uuid not null references public.audit_logs(id),
  primary key(workspace_id, operation_id)
);

-- Same transaction holds CRM membership, project grant, project and unit rows,
-- plus the QA case/identity/source/stop row, through task+audit+receipt insertion.
-- All QA revocations update that row. This says nothing about external writers.
create function property_task_qa.create_task(
  w uuid, p uuid, u uuid, a uuid, c uuid, cv bigint, g bigint, uv bigint, op uuid
) returns uuid language plpgsql security definer set search_path=pg_catalog,public,property_task_qa as $$
declare auth property_task_qa.authority%rowtype; prior property_task_qa.receipts%rowtype;
  member record; req jsonb; task_id uuid; audit_id uuid; unit_version bigint;
begin
  if w is null or p is null or u is null or a is null or c is null or cv is null
     or g is null or uv is null or op is null or cv < 1 or g < 1 or uv < 1 then
    raise exception 'PROPERTY_TASK_QA_INVALID';
  end if;
  perform set_config('app.tenant_id',w::text,true), set_config('app.actor_id',a::text,true);
  select * into member from public.crm_lock_active_member(w,a);
  if not found or member.role <> 'agent' or member.operating_model <> 'managed_by_novalure'
     or not public.crm_lock_project_access(w,p,true) then raise exception 'PROPERTY_TASK_QA_DENIED'; end if;
  perform id from public.projects where workspace_id=w and id=p for share;
  if not found then raise exception 'PROPERTY_TASK_QA_DENIED'; end if;
  select version into unit_version from public.property_units
    where workspace_id=w and project_id=p and id=u and data_classification='CUSTOMER_TENANT'
      and data_purpose='crm_sales' for share;
  if not found or unit_version <> uv then raise exception 'PROPERTY_TASK_QA_UNIT_CHANGED'; end if;
  select * into auth from property_task_qa.authority where workspace_id=w and project_id=p and case_id=c for update;
  if not found or auth.login <> session_user or auth.actor_id <> a or auth.unit_id <> u
     or not auth.can_write or auth.stopped or not auth.source_active
     or auth.case_version <> cv or auth.generation <> g then raise exception 'PROPERTY_TASK_QA_AUTHORITY_CHANGED'; end if;
  req := jsonb_build_array(p,u,a,c,cv,g,uv);
  select * into prior from property_task_qa.receipts where workspace_id=w and operation_id=op;
  if found then
    if prior.principal <> session_user or prior.request <> req then raise exception 'PROPERTY_TASK_QA_REPLAY_CONFLICT'; end if;
    perform id from public.tasks where id=prior.task_id and workspace_id=w and project_id=p
      and owner_user_id=a and status='open' and version=1 for share;
    if not found then raise exception 'PROPERTY_TASK_QA_REPLAY_STALE'; end if;
    return prior.task_id;
  end if;
  insert into public.tasks(workspace_id,project_id,owner_user_id,title,status,data_classification,data_purpose)
    values(w,p,a,'SYNTHETIC: Property clarification','open','CUSTOMER_TENANT','crm_sales') returning id into task_id;
  insert into public.audit_logs(workspace_id,actor_user_id,action,entity_type,entity_id)
    values(w,a,'PROPERTY_TASK_QA_CREATE','task',task_id) returning id into audit_id;
  insert into property_task_qa.receipts values(w,op,session_user,req,task_id,audit_id);
  return task_id;
end $$;
revoke all on all tables in schema property_task_qa from public;
revoke all on function property_task_qa.create_task(uuid,uuid,uuid,uuid,uuid,bigint,bigint,bigint,uuid) from public;
