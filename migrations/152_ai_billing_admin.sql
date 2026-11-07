-- Manual activation is an internal Novalure operation, never a customer capability.
create table ai_billing_admin_receipts (
 operator_workspace_id uuid not null references workspaces(id),actor_user_id uuid not null,
 idempotency_key uuid not null,request_hash text not null check(request_hash~'^[a-f0-9]{64}$'),
 target_workspace_id uuid not null references workspaces(id),action text not null check(action in('fulfill','close','reconcile')),
 payload jsonb not null,response jsonb not null,created_at timestamptz not null default now(),
 primary key(operator_workspace_id,actor_user_id,idempotency_key),
 foreign key(operator_workspace_id,actor_user_id) references workspace_users(workspace_id,id)
);
alter table ai_billing_admin_receipts enable row level security;
alter table ai_billing_admin_receipts force row level security;
do $$begin execute format('create policy ai_admin_receipt_owner on ai_billing_admin_receipts to %I using(true) with check(true)',current_user);end $$;
revoke all on ai_billing_admin_receipts from public,novalure_tenant_app;
create function crm_ai_admin_receipt_immutable() returns trigger language plpgsql as $$begin raise exception 'AI_ADMIN_AUDIT_IMMUTABLE';end $$;
create trigger ai_billing_admin_receipts_immutable before update or delete on ai_billing_admin_receipts for each row execute function crm_ai_admin_receipt_immutable();

create function crm_ai_admin_assert(w uuid) returns uuid language plpgsql security definer set search_path=pg_catalog,public as $$
declare a uuid:=nullif(current_setting('app.actor_id',true),'')::uuid;m record;begin
 if w is distinct from nullif(current_setting('app.tenant_id',true),'')::uuid or a is null then raise exception using errcode='42501',message='AI_ADMIN_FORBIDDEN';end if;
 select * into m from crm_lock_active_member(w,a);
 if not found or m.role is null or m.role not in('owner','admin') or m.product_role is null or m.product_role not in('platform_admin','novalureAdmin') or
  not exists(select 1 from workspaces where id=w and operating_model='novalure_internal') then
  raise exception using errcode='42501',message='AI_ADMIN_FORBIDDEN';end if;
 return a;
end $$;

create function crm_ai_admin_read(w uuid,p_target uuid default null,p_status text default 'pending') returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare requests jsonb;reservations jsonb;begin
 perform crm_ai_admin_assert(w);
 if p_status is null or p_status not in('pending','fulfilled','cancelled') then raise exception using errcode='23514',message='AI_ADMIN_INVALID';end if;
 select coalesce(jsonb_agg(to_jsonb(r) order by r."createdAt",r.id),'[]'::jsonb) into requests from(
  select b.id,b.request_id as "requestId",b.workspace_id as "workspaceId",ws.name as "workspaceName",b.kind,b.item_id as "itemId",b.status,
  b.amount_cents as "amountCents",b.catalog_version as "catalogVersion",b.notes,b.requested_services as "requestedServices",
  b.created_at as "createdAt",b.fulfilled_at as "fulfilledAt",u.name as "requesterName",u.email as "requesterEmail"
  from ai_billing_requests b join workspaces ws on ws.id=b.workspace_id join workspace_users u on u.workspace_id=b.workspace_id and u.id=b.actor_id
  where b.status=p_status and(p_target is null or b.workspace_id=p_target) order by b.created_at,b.id limit 100
 )r;
 select coalesce(jsonb_agg(to_jsonb(r) order by r."createdAt",r.id),'[]'::jsonb) into reservations from(
  select q.id,q.workspace_id as "workspaceId",ws.name as "workspaceName",q.request_id as "requestId",q.operation,q.reserved_credits as "reservedCredits",q.metadata,q.created_at as "createdAt"
  from ai_credit_reservations q join workspaces ws on ws.id=q.workspace_id where q.status='reserved' and(p_target is null or q.workspace_id=p_target)
  order by q.created_at,q.id limit 100
 )r;
 return jsonb_build_object('source','database','canAdmin',true,'requests',requests,'reservations',reservations);
end $$;

create function crm_ai_admin_action(w uuid,p_key uuid,p_hash text,p_input jsonb) returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare a uuid;prior ai_billing_admin_receipts;target uuid;result jsonb;action text:=p_input->>'action';request uuid;begin
 a:=crm_ai_admin_assert(w);
 if p_key is null or p_hash is null or p_hash!~'^[a-f0-9]{64}$' or p_input is null or jsonb_typeof(p_input)<>'object' or octet_length(p_input::text)>8192
  or action is null or action not in('fulfill','close','reconcile') or exists(select 1 from jsonb_object_keys(p_input)k where k not in('action','requestId','reservationId','reference','paidThrough','status','credits'))
 then raise exception using errcode='23514',message='AI_ADMIN_INVALID';end if;
 perform pg_advisory_xact_lock(hashtextextended('ai-admin:'||w::text||':'||a::text||':'||p_key::text,0));
 select * into prior from ai_billing_admin_receipts where operator_workspace_id=w and actor_user_id=a and idempotency_key=p_key;
 if found then if prior.request_hash<>p_hash then raise exception using errcode='23505',message='IDEMPOTENCY_CONFLICT';end if;return prior.response||jsonb_build_object('replayed',true);end if;
 if action='reconcile' then
  request:=coalesce(p_input->>'reservationId',p_input->>'requestId')::uuid;
  select workspace_id into target from ai_credit_reservations where id=request;
 else
  request:=(p_input->>'requestId')::uuid;select workspace_id into target from ai_billing_requests where id=request;
 end if;
 if target is null then raise exception using errcode='23514',message='AI_ADMIN_INVALID';end if;
 if action='fulfill' then
  if p_input?'status' or p_input?'credits' or p_input?'reservationId' then raise exception using errcode='23514',message='AI_ADMIN_INVALID';end if;
  result:=crm_ai_fulfill_booking(request,p_input->>'reference',p_hash,nullif(p_input->>'paidThrough','')::timestamptz);
 elsif action='close' then
  if p_input?'credits' or p_input?'paidThrough' or p_input?'reservationId' then raise exception using errcode='23514',message='AI_ADMIN_INVALID';end if;
  perform crm_ai_close_booking(request,p_input->>'status');result:=jsonb_build_object('status',p_input->>'status','replayed',false);
 else
  if p_input?'paidThrough' then raise exception using errcode='23514',message='AI_ADMIN_INVALID';end if;
  result:=crm_ai_reconcile_reservation(request,(p_input->>'credits')::integer,p_input->>'status',p_input->>'reference',p_hash);
 end if;
 insert into ai_billing_admin_receipts(operator_workspace_id,actor_user_id,idempotency_key,request_hash,target_workspace_id,action,payload,response)
 values(w,a,p_key,p_hash,target,action,p_input,result);
 return result;
end $$;
revoke all on function crm_ai_admin_assert(uuid),crm_ai_admin_read(uuid,uuid,text),crm_ai_admin_action(uuid,uuid,text,jsonb),crm_ai_admin_receipt_immutable() from public,novalure_tenant_app;
grant execute on function crm_ai_admin_read(uuid,uuid,text),crm_ai_admin_action(uuid,uuid,text,jsonb) to novalure_tenant_app;
