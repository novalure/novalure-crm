-- Isolated customer-product preparation. No account, offer, price or quota is seeded.
-- Production provider binding and activation are deliberately absent.
set local lock_timeout='5s';
set local statement_timeout='2min';

do $guard$ begin
 if to_regclass('public.bots') is null or to_regclass('public.knowledge_center_entitlements') is null then
  raise exception 'Webchat customer product requires existing tenant/assistant/knowledge predecessors';
 end if;
 if not exists(select 1 from pg_roles where rolname='novalure_webchat_product_writer') then
  create role novalure_webchat_product_writer nologin inherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
 end if;
 if not exists(select 1 from pg_roles where rolname='novalure_webchat_payment_executor') then
  create role novalure_webchat_payment_executor nologin inherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
 end if;
 if exists(select 1 from pg_roles where rolname='novalure_webchat_payment_executor' and
   (rolcanlogin or rolsuper or rolbypassrls or rolcreatedb or rolcreaterole or rolreplication))
   or pg_has_role('novalure_tenant_app','novalure_webchat_payment_executor','MEMBER')
   or pg_has_role('novalure_app','novalure_webchat_payment_executor','MEMBER') then
  raise exception 'Unsafe webchat payment executor';
 end if;
 if exists(select 1 from pg_roles where rolname='novalure_webchat_product_writer' and
   (rolcanlogin or rolsuper or rolbypassrls or rolcreatedb or rolcreaterole or rolreplication))
   or pg_has_role('novalure_tenant_app','novalure_webchat_product_writer','MEMBER')
   or pg_has_role('novalure_app','novalure_webchat_product_writer','MEMBER') then
  raise exception 'Unsafe webchat product writer';
 end if;
 execute format('grant novalure_webchat_product_writer to %I',current_user);
end $guard$;

-- Conversation summaries stay in the existing tenant-scoped session record.
alter table public.external_chat_sessions add column if not exists metadata jsonb not null default '{}'::jsonb;

create table public.webchat_product_accounts(
 workspace_id uuid primary key references public.workspaces(id),
 enabled boolean not null default false,
 synthetic_only boolean not null default true check(synthetic_only),
 quota_units bigint not null check(quota_units between 0 and 9007199254740991),
 used_units bigint not null default 0 check(used_units>=0),
 reserved_units bigint not null default 0 check(reserved_units>=0),
 contract_reference text not null check(length(contract_reference) between 1 and 200),
 stripe_customer_id text,
 stripe_account_id text not null default '',
 check(used_units+reserved_units<=quota_units),
 unique(stripe_account_id,stripe_customer_id)
);
create table public.webchat_product_offers(
 workspace_id uuid not null references public.webchat_product_accounts(workspace_id),
 reference text not null check(length(reference) between 1 and 160),
 revision integer not null check(revision>0),
 units bigint not null check(units between 1 and 9007199254740991),
 amount_minor text not null check(amount_minor~'^(0|[1-9][0-9]{0,15})$'),
 currency text not null check(currency~'^[A-Z]{3}$'),
 contract_reference text not null check(length(contract_reference) between 1 and 200),
 active boolean not null default false,
 primary key(workspace_id,reference,revision)
);
create table public.webchat_product_orders(
 id uuid primary key default gen_random_uuid(),
 workspace_id uuid not null references public.webchat_product_accounts(workspace_id),
 request_id uuid not null,
 actor_id uuid not null,
 offer_reference text not null,
 offer_revision integer not null,
 units bigint not null check(units>0),
 amount_minor text not null,
 currency text not null,
 contract_reference text not null,
 status text not null default 'pending' check(status in('pending','paid','cancelled')),
 stripe_customer_id text,
 stripe_account_id text not null default '',
 stripe_payment_intent_id text,
 last_event_created_at bigint,
 created_at timestamptz not null default now(),
 paid_at timestamptz,
 unique(workspace_id,id),
 unique(workspace_id,request_id),
 unique(stripe_payment_intent_id),
 foreign key(workspace_id,actor_id) references public.workspace_users(workspace_id,id),
 foreign key(workspace_id,offer_reference,offer_revision) references public.webchat_product_offers(workspace_id,reference,revision)
);
create table public.webchat_product_usage(
 workspace_id uuid not null references public.webchat_product_accounts(workspace_id),
 request_id uuid not null,
 bot_id uuid not null,
 request_digest text not null check(request_digest~'^[a-f0-9]{64}$'),
 units bigint not null check(units>0),
 state text not null check(state in('reserved','consumed','released')),
 response text check(octet_length(response)<=32768),
 created_at timestamptz not null default now(),
 settled_at timestamptz,
 primary key(workspace_id,request_id),
 foreign key(workspace_id,bot_id) references public.bots(workspace_id,id)
);
create table public.webchat_product_payment_events(
 stripe_account_id text not null,
 event_id text not null,
 workspace_id uuid not null references public.webchat_product_accounts(workspace_id),
 order_id uuid not null,
 event_digest text not null check(event_digest~'^[a-f0-9]{64}$'),
 event_created_at bigint not null check(event_created_at>=0),
 outcome text not null check(outcome in('applied','duplicate','stale')),
 created_at timestamptz not null default now(),
 primary key(stripe_account_id,event_id),
 foreign key(workspace_id,order_id) references public.webchat_product_orders(workspace_id,id)
);
create table public.webchat_product_provisions(
 workspace_id uuid not null references public.webchat_product_accounts(workspace_id),
 order_id uuid not null,
 module_key text not null default 'webchat' check(module_key='webchat'),
 contract_reference text not null,
 units bigint not null check(units>0),
 created_at timestamptz not null default now(),
 primary key(workspace_id,order_id),
 foreign key(workspace_id,order_id) references public.webchat_product_orders(workspace_id,id)
);

create function public.webchat_product_scope(p_workspace uuid) returns boolean
 language sql stable security invoker set search_path=pg_catalog,public as $function$
 select p_workspace=nullif(current_setting('app.tenant_id',true),'')::uuid and exists(
  select 1 from public.workspace_users u where u.workspace_id=p_workspace
  and u.id=nullif(current_setting('app.actor_id',true),'')::uuid and u.status='active')
$function$;
grant usage,create on schema public to novalure_webchat_product_writer;
grant novalure_tenant_app to novalure_webchat_product_writer;
grant select on public.workspace_users,public.bots to novalure_webchat_product_writer;
grant select,insert on public.audit_logs to novalure_webchat_product_writer;
do $rls$ declare t text; begin
 foreach t in array array['webchat_product_accounts','webchat_product_offers','webchat_product_orders','webchat_product_usage','webchat_product_payment_events','webchat_product_provisions'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('alter table public.%I force row level security',t);
  execute format('create policy webchat_read on public.%I for select to novalure_tenant_app using(public.webchat_product_scope(workspace_id))',t);
  execute format('create policy webchat_writer on public.%I for all to novalure_webchat_product_writer using(public.webchat_product_scope(workspace_id)) with check(public.webchat_product_scope(workspace_id))',t);
  execute format('revoke all on public.%I from public,novalure_app,novalure_tenant_app',t);
  execute format('grant select on public.%I to novalure_tenant_app',t);
  execute format('grant select,insert,update on public.%I to novalure_webchat_product_writer',t);
 end loop;
end $rls$;

create function public.webchat_reserve_usage(p_workspace uuid,p_bot uuid,p_request uuid,p_digest text,p_units bigint)
 returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $function$
declare a public.webchat_product_accounts; u public.webchat_product_usage;
begin
 if not public.webchat_product_scope(p_workspace) then raise exception using errcode='42501',message='Webchat scope denied'; end if;
 select * into a from public.webchat_product_accounts where workspace_id=p_workspace for update;
 if not found then return null; end if;
 if not a.synthetic_only or not a.enabled then raise exception using errcode='P0001',message='WEBCHAT_PRODUCT_DISABLED'; end if;
 select * into u from public.webchat_product_usage where workspace_id=p_workspace and request_id=p_request;
 if found then
  if u.bot_id<>p_bot or u.request_digest<>p_digest or u.units<>p_units then raise exception using errcode='P0001',message='IDEMPOTENCY_CONFLICT'; end if;
  return jsonb_build_object('state',u.state,'replayed',true,'response',u.response);
 end if;
 if p_units is null or p_units<1 or p_units>9007199254740991 or p_digest!~'^[a-f0-9]{64}$'
  or not exists(select 1 from public.bots where workspace_id=p_workspace and id=p_bot) then
  raise exception using errcode='23514',message='Invalid webchat usage';
 end if;
 if a.quota_units-a.used_units-a.reserved_units<p_units then raise exception using errcode='P0001',message='LIMIT_EXCEEDED'; end if;
 insert into public.webchat_product_usage(workspace_id,request_id,bot_id,request_digest,units,state) values(p_workspace,p_request,p_bot,p_digest,p_units,'reserved');
 update public.webchat_product_accounts set reserved_units=reserved_units+p_units where workspace_id=p_workspace;
 return jsonb_build_object('state','reserved','replayed',false,'response',null);
end $function$;

create function public.webchat_settle_usage(p_workspace uuid,p_bot uuid,p_request uuid,p_outcome text,p_response text)
 returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $function$
declare u public.webchat_product_usage;
begin
 if not public.webchat_product_scope(p_workspace) then raise exception using errcode='42501',message='Webchat scope denied'; end if;
 perform 1 from public.webchat_product_accounts where workspace_id=p_workspace for update;
 select * into u from public.webchat_product_usage where workspace_id=p_workspace and request_id=p_request for update;
 if not found or u.bot_id<>p_bot then raise exception using errcode='42501',message='Webchat reservation inaccessible'; end if;
 if p_outcome not in('consumed','released') or octet_length(p_response)>32768 then raise exception using errcode='23514',message='Invalid webchat settlement'; end if;
 if u.state<>'reserved' then
  if u.state<>p_outcome then raise exception using errcode='P0001',message='IDEMPOTENCY_CONFLICT'; end if;
  return jsonb_build_object('state',u.state,'replayed',true,'response',u.response);
 end if;
 update public.webchat_product_accounts set reserved_units=reserved_units-u.units,
  used_units=used_units+case when p_outcome='consumed' then u.units else 0 end where workspace_id=p_workspace;
 update public.webchat_product_usage set state=p_outcome,response=p_response,settled_at=now()
  where workspace_id=p_workspace and request_id=p_request;
 return jsonb_build_object('state',p_outcome,'replayed',false,'response',p_response);
end $function$;

create function public.webchat_create_topup_order(p_workspace uuid,p_request uuid,p_offer text,p_revision integer)
 returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $function$
declare o public.webchat_product_orders; f public.webchat_product_offers; a public.webchat_product_accounts;
 actor uuid:=nullif(current_setting('app.actor_id',true),'')::uuid;
begin
 if not public.webchat_product_scope(p_workspace) or not exists(select 1 from public.workspace_users u
  where u.workspace_id=p_workspace and u.id=actor and u.status='active' and u.role in('owner','admin')
  and u.product_role in('customer_owner','workspace_admin','platform_admin','novalureAdmin','novalure_onboarding')) then
  raise exception using errcode='42501',message='Customer administrator required';
 end if;
 select * into a from public.webchat_product_accounts where workspace_id=p_workspace for update;
 if not found or not a.synthetic_only then raise exception using errcode='42501',message='Isolated webchat account required'; end if;
 select * into o from public.webchat_product_orders where workspace_id=p_workspace and request_id=p_request;
 if found then
  if o.actor_id<>actor or o.offer_reference<>p_offer or o.offer_revision<>p_revision then raise exception using errcode='P0001',message='IDEMPOTENCY_CONFLICT'; end if;
  return jsonb_build_object('orderId',o.id,'status',o.status,'units',o.units,'replayed',true);
 end if;
 select * into f from public.webchat_product_offers where workspace_id=p_workspace and reference=p_offer and revision=p_revision and active;
 if not found then raise exception using errcode='P0001',message='OFFER_UNAVAILABLE'; end if;
 insert into public.webchat_product_orders(workspace_id,request_id,actor_id,offer_reference,offer_revision,units,amount_minor,currency,contract_reference,stripe_customer_id,stripe_account_id)
  values(p_workspace,p_request,actor,p_offer,p_revision,f.units,f.amount_minor,f.currency,f.contract_reference,a.stripe_customer_id,a.stripe_account_id) returning * into o;
 insert into public.audit_logs(workspace_id,actor_user_id,action,entity_type,entity_id,after)
  values(p_workspace,actor,'webchat.topup.requested','webchat_order',o.id,jsonb_build_object('offerReference',p_offer,'offerRevision',p_revision,'units',f.units,'status','pending'));
 return jsonb_build_object('orderId',o.id,'status',o.status,'units',o.units,'replayed',false);
end $function$;

create function public.webchat_apply_test_payment(p_workspace uuid,p_account text,p_customer text,p_payment text,p_event text,p_digest text,p_created bigint,p_amount text,p_currency text)
 returns text language plpgsql security definer set search_path=pg_catalog,public as $function$
declare a public.webchat_product_accounts; o public.webchat_product_orders; e public.webchat_product_payment_events; result text;
begin
 if not public.webchat_product_scope(p_workspace) then raise exception using errcode='42501',message='Webchat scope denied'; end if;
 select * into a from public.webchat_product_accounts where workspace_id=p_workspace for update;
 if not found or not a.synthetic_only or a.stripe_customer_id is distinct from p_customer or a.stripe_account_id<>p_account then
  raise exception using errcode='42501',message='Payment customer mapping denied';
 end if;
 select * into e from public.webchat_product_payment_events where stripe_account_id=p_account and event_id=p_event;
 if found then
  if e.workspace_id<>p_workspace or e.event_digest<>p_digest then raise exception using errcode='P0001',message='PAYMENT_EVENT_CONFLICT'; end if;
  return 'duplicate';
 end if;
 select * into o from public.webchat_product_orders where workspace_id=p_workspace and stripe_payment_intent_id=p_payment for update;
 if not found or o.amount_minor<>p_amount or o.currency<>p_currency or o.stripe_customer_id is distinct from p_customer
  or o.stripe_account_id<>p_account then raise exception using errcode='P0001',message='PAYMENT_ORDER_MISMATCH'; end if;
 if o.status='cancelled' or (o.last_event_created_at is not null and p_created<o.last_event_created_at) then result:='stale';
 elsif o.status='paid' then result:='duplicate';
 else
  result:='applied';
  insert into public.webchat_product_provisions(workspace_id,order_id,contract_reference,units) values(p_workspace,o.id,o.contract_reference,o.units);
  -- A purchase replenishes quota; it never revokes an administrative suspension.
  update public.webchat_product_accounts set quota_units=quota_units+o.units where workspace_id=p_workspace;
  update public.webchat_product_orders set status='paid',paid_at=now(),last_event_created_at=p_created where workspace_id=p_workspace and id=o.id;
  insert into public.audit_logs(workspace_id,actor_user_id,action,entity_type,entity_id,after)
   values(p_workspace,nullif(current_setting('app.actor_id',true),'')::uuid,'webchat.test_payment.confirmed','webchat_order',o.id,
    jsonb_build_object('eventId',p_event,'module','webchat','contractReference',o.contract_reference,'units',o.units,'testOnly',true));
 end if;
 insert into public.webchat_product_payment_events(stripe_account_id,event_id,workspace_id,order_id,event_digest,event_created_at,outcome)
  values(p_account,p_event,p_workspace,o.id,p_digest,p_created,result);
 return result;
end $function$;

alter function public.webchat_reserve_usage(uuid,uuid,uuid,text,bigint) owner to novalure_webchat_product_writer;
alter function public.webchat_settle_usage(uuid,uuid,uuid,text,text) owner to novalure_webchat_product_writer;
alter function public.webchat_create_topup_order(uuid,uuid,text,integer) owner to novalure_webchat_product_writer;
alter function public.webchat_apply_test_payment(uuid,text,text,text,text,text,bigint,text,text) owner to novalure_webchat_product_writer;
revoke all on function public.webchat_product_scope(uuid),public.webchat_reserve_usage(uuid,uuid,uuid,text,bigint),public.webchat_settle_usage(uuid,uuid,uuid,text,text),public.webchat_create_topup_order(uuid,uuid,text,integer),public.webchat_apply_test_payment(uuid,text,text,text,text,text,bigint,text,text) from public;
grant execute on function public.webchat_product_scope(uuid) to novalure_tenant_app,novalure_webchat_product_writer;
grant execute on function public.webchat_reserve_usage(uuid,uuid,uuid,text,bigint),public.webchat_settle_usage(uuid,uuid,uuid,text,text),public.webchat_create_topup_order(uuid,uuid,text,integer) to novalure_tenant_app;
-- This role is never granted to the customer-facing runtime. The isolated
-- signature-verifying host must use its own restricted, separately bound pool.
grant execute on function public.webchat_apply_test_payment(uuid,text,text,text,text,text,bigint,text,text) to novalure_webchat_payment_executor;

-- Q11: existing team_member roles apply to every project of their own Webchat
-- customer account. Internal workspaces and every other role retain old grants.
create function public.crm_webchat_customer_member(p_workspace uuid)
returns boolean language sql stable security definer set search_path=pg_catalog,public as $function$
 select p_workspace=nullif(current_setting('app.tenant_id',true),'')::uuid and exists(
  select 1 from public.workspaces w join public.workspace_users u on u.workspace_id=w.id
  join public.webchat_product_accounts a on a.workspace_id=w.id
  where w.id=p_workspace and w.operating_model in('self_service_customer','managed_by_novalure','hybrid')
   and w.customer_type<>'novalure_internal' and a.synthetic_only
   and u.id=nullif(current_setting('app.actor_id',true),'')::uuid
   and u.status='active' and u.product_role='team_member')
$function$;
alter function public.crm_webchat_customer_member(uuid) owner to novalure_webchat_product_writer;
revoke all on function public.crm_webchat_customer_member(uuid) from public;
grant execute on function public.crm_webchat_customer_member(uuid) to novalure_tenant_app;

create or replace function public.crm_project_access(p_workspace uuid,p_project uuid,p_write boolean default false)
returns boolean language sql stable security invoker set search_path=pg_catalog,public as $function$
 select p_workspace=nullif(current_setting('app.tenant_id',true),'')::uuid and exists(
  select 1 from public.workspace_users u where u.workspace_id=p_workspace
   and u.id=nullif(current_setting('app.actor_id',true),'')::uuid and u.status='active' and u.product_role<>'external_partner'
   and (not p_write or u.role in('owner','admin','agent'))
   and (public.crm_workspace_manager(p_workspace) or public.crm_webchat_customer_member(p_workspace) or exists(
    select 1 from public.project_pipeline_permissions g where g.workspace_id=p_workspace
     and g.project_id=p_project and g.user_id=u.id and g.can_read and (not p_write or g.can_edit_deals))))
$function$;

create or replace function public.crm_lock_project_access(p_workspace uuid,p_project uuid,p_write boolean)
returns boolean language plpgsql security definer set search_path=pg_catalog,public as $function$
begin
 if not public.crm_project_access(p_workspace,p_project,p_write) then return false; end if;
 if public.crm_workspace_manager(p_workspace) then return true; end if;
 if public.crm_webchat_customer_member(p_workspace) then
  perform u.id from public.workspace_users u join public.workspaces w on w.id=u.workspace_id
   join public.webchat_product_accounts a on a.workspace_id=w.id
   where u.workspace_id=p_workspace and u.id=nullif(current_setting('app.actor_id',true),'')::uuid
    and u.status='active' and u.product_role='team_member'
    and w.operating_model in('self_service_customer','managed_by_novalure','hybrid')
    and w.customer_type<>'novalure_internal' and a.synthetic_only for share of u,w,a;
  return found;
 end if;
 perform g.id from public.project_pipeline_permissions g where g.workspace_id=p_workspace and g.project_id=p_project
  and g.user_id=nullif(current_setting('app.actor_id',true),'')::uuid and g.can_read and (not p_write or g.can_edit_deals) for share;
 return found;
end $function$;

-- Lock-only access fence; the normal runtime keeps SELECT-only entitlement
-- privileges. Column UPDATE here is required by PostgreSQL's FOR SHARE and is
-- held only by the unreachable NOLOGIN function owner, never a caller.
grant update(updated_at) on public.knowledge_center_entitlements to novalure_webchat_product_writer;
grant update(reason) on public.workspace_module_settings to novalure_webchat_product_writer;
create function public.webchat_lock_answer_access(p_workspace uuid)
returns boolean language plpgsql security definer set search_path=pg_catalog,public as $function$
declare a public.webchat_product_accounts; e public.knowledge_center_entitlements; blocked boolean:=false; m record;
begin
 if not public.webchat_product_scope(p_workspace) then return false; end if;
 select * into a from public.webchat_product_accounts where workspace_id=p_workspace for update;
 if not found or not a.enabled or not a.synthetic_only then return false; end if;
 select * into e from public.knowledge_center_entitlements where workspace_id=p_workspace for share;
 if not found or not e.enabled or length(btrim(coalesce(e.contract_reference,'')))=0
  or e.features->'webchatAccess' is distinct from 'true'::jsonb then return false; end if;
 for m in select enabled from public.workspace_module_settings where workspace_id=p_workspace and module_key in('knowledge','bots') for share loop
  if not m.enabled then blocked:=true; end if;
 end loop;
 return not blocked;
end $function$;
alter function public.webchat_lock_answer_access(uuid) owner to novalure_webchat_product_writer;
revoke all on function public.webchat_lock_answer_access(uuid) from public;
grant execute on function public.webchat_lock_answer_access(uuid) to novalure_tenant_app;
revoke create on schema public from novalure_webchat_product_writer;
