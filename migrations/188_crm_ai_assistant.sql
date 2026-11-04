-- Private, durable work products for the CRM assistant. No outbound delivery or CRM writes.
create table crm_ai_assistant_runs (
 workspace_id uuid not null references workspaces(id),id uuid not null,actor_id uuid not null,
 project_id uuid,request_hash text not null check(request_hash~'^[a-f0-9]{64}$'),
 authority_hash text not null check(authority_hash~'^[a-f0-9]{64}$'),
 request jsonb not null check(jsonb_typeof(request)='object' and octet_length(request::text)<=16384),
 context_refs jsonb not null check(jsonb_typeof(context_refs)='array' and octet_length(context_refs::text)<=32768),
 status text not null default 'processing' check(status in('processing','completed','failed')),
 result jsonb,error_code text,charged_credits integer not null default 0 check(charged_credits>=0),
 created_at timestamptz not null default now(),finished_at timestamptz,
 primary key(workspace_id,id),foreign key(workspace_id,actor_id) references workspace_users(workspace_id,id),
 foreign key(workspace_id,project_id) references projects(workspace_id,id),
 check((status='processing' and result is null and finished_at is null) or
 (status='completed' and jsonb_typeof(result)='object' and finished_at is not null and error_code is null) or
 (status='failed' and result is null and error_code is not null and finished_at is not null))
);
create index crm_ai_assistant_actor_recent on crm_ai_assistant_runs(workspace_id,actor_id,created_at desc);
alter table crm_ai_assistant_runs enable row level security;
alter table crm_ai_assistant_runs force row level security;
do $$begin execute format('create policy assistant_migration_owner on crm_ai_assistant_runs to %I using(true) with check(true)',current_user);end $$;
create policy assistant_private_read on crm_ai_assistant_runs for select to novalure_tenant_app
 using(workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid and actor_id=nullif(current_setting('app.actor_id',true),'')::uuid);

create function crm_assistant_actor(w uuid) returns uuid language plpgsql security definer set search_path=pg_catalog,public as $$
declare a uuid:=nullif(current_setting('app.actor_id',true),'')::uuid;m record;begin
 if w is distinct from nullif(current_setting('app.tenant_id',true),'')::uuid or a is null then raise exception using errcode='42501',message='AI_ASSISTANT_FORBIDDEN';end if;
 select * into m from crm_lock_active_member(w,a);
 if not found or m.role is null or m.role not in('owner','admin','agent','assistant') or m.product_role is null or m.product_role in('viewer','external_partner')
  or not crm_classification_allowed(w,case when m.operating_model='novalure_internal' then 'NOVALURE_INTERNAL' else 'CUSTOMER_TENANT' end,'crm_sales')
 then raise exception using errcode='42501',message='AI_ASSISTANT_FORBIDDEN';end if;
 if exists(select 1 from workspace_module_settings where workspace_id=w and module_key='bots' and not enabled) then raise exception using errcode='42501',message='AI_MODULE_DISABLED';end if;
 return a;
end $$;

create function crm_assistant_start(w uuid,k uuid,h text,authority text,input jsonb,refs jsonb) returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare a uuid;prior crm_ai_assistant_runs;p uuid;begin
 a:=crm_assistant_actor(w);
 if k is null or h is null or h!~'^[a-f0-9]{64}$' or authority is null or authority!~'^[a-f0-9]{64}$' or input is null or jsonb_typeof(input)<>'object' or octet_length(input::text)>16384 or refs is null or jsonb_typeof(refs)<>'array' or octet_length(refs::text)>32768 then raise exception using errcode='23514',message='AI_ASSISTANT_INVALID';end if;
 p:=nullif(input->>'projectId','')::uuid;
 if p is not null and not crm_lock_project_access(w,p,false) then raise exception using errcode='42501',message='PROJECT_FORBIDDEN';end if;
 perform pg_advisory_xact_lock(hashtextextended('crm-assistant:'||w::text,0));
 select * into prior from crm_ai_assistant_runs where workspace_id=w and id=k;
 if found then
  if prior.actor_id<>a or prior.authority_hash<>authority then raise exception using errcode='42501',message='AI_ASSISTANT_FORBIDDEN';end if;
  if prior.request_hash<>h then raise exception using errcode='23505',message='IDEMPOTENCY_CONFLICT';end if;
  return to_jsonb(prior)||jsonb_build_object('replayed',true);
 end if;
 if exists(select 1 from crm_ai_assistant_runs where workspace_id=w and actor_id=a and status='processing' and created_at>clock_timestamp()-interval '2 minutes') or
  (select count(*) from crm_ai_assistant_runs where workspace_id=w and status='processing' and created_at>clock_timestamp()-interval '2 minutes')>=3
 then raise exception using errcode='55000',message='AI_ASSISTANT_BUSY';end if;
 insert into crm_ai_assistant_runs(workspace_id,id,actor_id,project_id,request_hash,authority_hash,request,context_refs)
 values(w,k,a,p,h,authority,input,refs) returning * into prior;
 return to_jsonb(prior)||jsonb_build_object('replayed',false);
end $$;

create function crm_assistant_finish(w uuid,k uuid,h text,authority text,output jsonb,failure text,credits integer) returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare a uuid;r crm_ai_assistant_runs;begin
 a:=crm_assistant_actor(w);
 select * into r from crm_ai_assistant_runs where workspace_id=w and id=k and actor_id=a for update;
 if not found or h is null or authority is null or h!~'^[a-f0-9]{64}$' or authority!~'^[a-f0-9]{64}$' or r.authority_hash is distinct from authority or r.request_hash is distinct from h then raise exception using errcode='42501',message='AI_ASSISTANT_FORBIDDEN';end if;
 if r.project_id is not null and not crm_lock_project_access(w,r.project_id,false) then raise exception using errcode='42501',message='PROJECT_FORBIDDEN';end if;
 if r.status<>'processing' then return to_jsonb(r);end if;
 if credits is null or credits<0 or credits>100000 or (failure is null and(output is null or jsonb_typeof(output)<>'object' or octet_length(output::text)>65536)) or (failure is not null and(length(failure)>100 or output is not null)) then raise exception using errcode='23514',message='AI_ASSISTANT_INVALID';end if;
 update crm_ai_assistant_runs set status=case when failure is null then 'completed' else 'failed' end,result=output,error_code=failure,charged_credits=credits,finished_at=clock_timestamp() where workspace_id=w and id=k returning * into r;
 return to_jsonb(r);
end $$;

revoke all on crm_ai_assistant_runs from public,novalure_tenant_app;
grant select on crm_ai_assistant_runs to novalure_tenant_app;
revoke all on function crm_assistant_actor(uuid),crm_assistant_start(uuid,uuid,text,text,jsonb,jsonb),crm_assistant_finish(uuid,uuid,text,text,jsonb,text,integer) from public,novalure_tenant_app;
grant execute on function crm_assistant_start(uuid,uuid,text,text,jsonb,jsonb),crm_assistant_finish(uuid,uuid,text,text,jsonb,text,integer) to novalure_tenant_app;
-- Real production owner defaults include direct runtime GRANTs; remove them explicitly.
do $$begin if exists(select 1 from pg_roles where rolname='novalure_app') then
 revoke all on crm_ai_assistant_runs from novalure_app;
 revoke all on function crm_assistant_actor(uuid),crm_assistant_start(uuid,uuid,text,text,jsonb,jsonb),crm_assistant_finish(uuid,uuid,text,text,jsonb,text,integer) from novalure_app;
end if;end $$;
